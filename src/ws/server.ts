import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { basename, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerMessage } from '../../shared/protocol.ts';
import type { AppConfig } from '../config.ts';
import { createStaticHandler } from '../http/static.ts';
import type { Logger } from '../log.ts';
import { ERROR_MESSAGES } from '../model/errors.ts';
import type { Session, StageHub } from './hub.ts';
import { ConnectionRateLimiter } from './rateLimit.ts';
import { ValidationError, parseClientMessage } from './validate.ts';

export interface StageServer {
  listen(): Promise<AddressInfo>;
  /** `keepRooms`: rooms will be restored after a restart, so clients are not told they closed (see `StageHub.shutdown`). */
  close(keepRooms?: boolean): Promise<void>;
}

export interface StageServerDeps {
  config: AppConfig;
  hub: StageHub;
  log: Logger;
  /** Directory static mounts are resolved against. */
  baseDir: string;
  now?: () => number;
  /** Prometheus text for `GET /metrics` (served only when `server.metrics.enabled`). */
  metrics?: () => Promise<string>;
}

/** Policy-violation close code (RFC 6455) used for rate-limit disconnects. */
const CLOSE_POLICY = 1008;
/** Normal-closure code (RFC 6455): from a client it means "I am leaving", so no seat is held. */
const CLOSE_NORMAL = 1000;
/** Going-away close code (RFC 6455) sent on shutdown, so clients can tell it from a dropped link. */
const CLOSE_GOING_AWAY = 1001;
/** How long shutdown waits for clients to finish the close handshake before cutting them off. */
const SHUTDOWN_DRAIN_MS = 1000;
/** Cert and key are usually rewritten one after the other; wait for both before reloading. */
const TLS_RELOAD_DEBOUNCE_MS = 2000;

class WsSession implements Session {
  readonly id = randomBytes(6).toString('base64url');
  readonly ws: WebSocket;
  alive = true;
  /** Per-connection ordering: a message is handled only after the previous one settled. */
  chain: Promise<void> = Promise.resolve();
  constructor(ws: WebSocket) {
    this.ws = ws;
  }
  send(msg: ServerMessage, encoded?: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encoded ?? JSON.stringify(msg));
  }
  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}

export function createStageServer(deps: StageServerDeps): StageServer {
  const { config, hub, log } = deps;
  const now = deps.now ?? Date.now;
  const serveStatic = createStaticHandler(config.server.static, deps.baseDir);

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (req.url === '/metrics' && config.server.metrics.enabled && deps.metrics) {
      const { token } = config.server.metrics;
      const given = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (token !== '' && !(given.length === expected.length && timingSafeEqual(given, expected))) {
        res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' }).end('unauthorized');
        return;
      }
      deps.metrics().then(
        (text) => res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' }).end(text),
        (err) => { log.error('metrics error', { error: String(err) }); res.writeHead(500).end(); },
      );
      return;
    }
    serveStatic(req, res).then(
      (served) => {
        if (!served) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      },
      (err) => {
        log.error('static error', { error: String(err) });
        if (!res.headersSent) res.writeHead(500).end();
      },
    );
  };

  const { certFile, keyFile } = config.server.tls;
  const secure = certFile !== '' && keyFile !== '';
  const server: Server = secure
    ? createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, onRequest)
    : createHttpServer(onRequest);
  // Certificates get renewed in place (ACME); pick the new pair up without a restart. Watching the
  // directory survives tools that write a new file and rename or re-point a symlink (a file watch
  // would follow the old inode). Cert and key land separately, so reload a moment after the last
  // change, and keep the old context when the pair does not load (half-written or mismatched).
  const watchers: FSWatcher[] = [];
  let reloadTimer: NodeJS.Timeout | undefined;
  if (secure) {
    const reload = () => {
      reloadTimer = undefined;
      try {
        (server as HttpsServer).setSecureContext({ cert: readFileSync(certFile), key: readFileSync(keyFile) });
        log.info('TLS certificate reloaded');
      } catch (err) {
        log.error('TLS certificate reload failed, keeping the previous one', { error: String(err) });
      }
    };
    const names: Record<string, string[]> = {};
    for (const file of [certFile, keyFile]) (names[dirname(file)] ??= []).push(basename(file));
    for (const [dir, files] of Object.entries(names)) {
      try {
        const w = watch(dir, (_event, name) => {
          if (name !== null && !files.includes(String(name))) return;
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(reload, TLS_RELOAD_DEBOUNCE_MS);
        });
        w.unref();
        w.on('error', (err) => log.warn('TLS certificate watch failed', { dir, error: String(err) }));
        watchers.push(w);
      } catch (err) {
        log.warn('TLS certificate watch failed', { dir, error: String(err) });
      }
    }
  }

  // Client is embedded on third-party sites, so no Origin allow-list (AGENTS.md §S10);
  // protection is room code + rate limits + caps.
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxFrameBytes });
  const sessions = new Set<WsSession>();
  /** Open connections per client address, for `limits.maxConnectionsPerIp`. */
  const perIp = new Map<string, number>();

  const clientAddress = (req: IncomingMessage): string => {
    if (config.server.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? '';
  };

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const ip = clientAddress(req);
    const perIpCap = config.limits.maxConnectionsPerIp;
    if (path !== config.server.wsPath || sessions.size >= config.limits.maxConnections || (perIpCap > 0 && (perIp.get(ip) ?? 0) >= perIpCap)) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const session = new WsSession(ws);
    const limiter = new ConnectionRateLimiter(config.limits, now());
    const ip = clientAddress(req);
    sessions.add(session);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    log.debug('connection opened', { session: session.id });
    hub.attach(session);

    // A connection that never enters a room only holds a `maxConnections` slot; drop it.
    const joinDeadline = config.limits.joinTimeoutMs > 0
      ? setTimeout(() => { if (!hub.isJoined(session)) violate(session, 'join timeout'); }, config.limits.joinTimeoutMs)
      : undefined;

    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      let msg;
      try {
        if (isBinary) throw new ValidationError('bad_request', 'binary frame', undefined);
        msg = parseClientMessage(data.toString('utf8'), config.limits);
      } catch (err) {
        if (!limiter.allow('ping', now())) return violate(session, 'invalid');
        const e = err instanceof ValidationError ? err : new ValidationError('bad_request', 'parse', undefined);
        session.send({ type: 'error', ...(e.requestId ? { requestId: e.requestId } : {}), code: e.code, message: ERROR_MESSAGES[e.code] });
        return;
      }
      if (!limiter.allow(msg.type, now())) return violate(session, msg.type);
      const m = msg;
      session.chain = session.chain.then(() => hub.handle(session, m));
    });
    ws.on('close', (code) => {
      clearTimeout(joinDeadline);
      sessions.delete(session);
      const remaining = (perIp.get(ip) ?? 1) - 1;
      if (remaining > 0) perIp.set(ip, remaining); else perIp.delete(ip);
      log.debug('connection closed', { session: session.id, code });
      // 1000 from the client = it chose to leave; anything else (1001 page hide, 1006 drop…) holds the seat.
      session.chain = session.chain.then(() => hub.detach(session, code === CLOSE_NORMAL));
    });
    ws.on('error', (err) => log.debug('ws error', { session: session.id, error: String(err) }));
  });

  function violate(session: WsSession, type: string): void {
    log.warn('rate limit exceeded, disconnecting', { session: session.id, type });
    session.close(CLOSE_POLICY, 'rate limit');
  }

  const heartbeat = setInterval(() => {
    for (const s of sessions) {
      if (!s.alive) {
        s.ws.terminate();
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }, config.rooms.heartbeatIntervalMs);
  heartbeat.unref();

  return {
    listen: () => {
      const { promise, resolve: done, reject } = Promise.withResolvers<AddressInfo>();
      server.once('error', reject);
      server.listen(config.server.port, config.server.host, () => {
        server.off('error', reject);
        done(server.address() as AddressInfo);
      });
      return promise;
    },
    close: async (keepRooms = false) => {
      clearInterval(heartbeat);
      clearTimeout(reloadTimer);
      for (const w of watchers) w.close();
      await hub.shutdown(keepRooms);
      // A graceful close flushes the `room:closed` frames queued above; terminate() could drop them.
      const drained = Promise.all([...sessions].map((s) => once(s.ws, 'close')));
      for (const s of sessions) s.close(CLOSE_GOING_AWAY, 'server shutdown');
      const deadline = setTimeout(() => { for (const s of sessions) s.ws.terminate(); }, SHUTDOWN_DRAIN_MS);
      await drained;
      clearTimeout(deadline);
      const wssClosed = Promise.withResolvers<void>();
      wss.close(() => wssClosed.resolve());
      await wssClosed.promise;
      const serverClosed = Promise.withResolvers<void>();
      server.close(() => serverClosed.resolve());
      await serverClosed.promise;
    },
  };
}
