import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { basename, dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppConfig } from '../config.ts';
import { createStaticHandler } from '../http/static.ts';
import type { Logger } from '../log.ts';
import { renderPrometheus } from '../metrics.ts';
import { WsSession } from './session.ts';
import { MessageQueue } from './messageQueue.ts';
import type { ClientMessage } from '../../shared/protocol.ts';
import { ERROR_MESSAGES } from '../model/errors.ts';
import type { StageHub } from './hub.ts';
import { ConnectionRateLimiter } from './rateLimit.ts';
import { ValidationError, parseClientMessage } from './validate.ts';

export interface StageServer {
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
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


export function createStageServer(deps: StageServerDeps): StageServer {
  const { config, hub, log } = deps;
  // Rate limits measure intervals; wall-clock corrections must not refill or drain buckets.
  const now = deps.now ?? (() => performance.now());
  let stopping = false;
  let closing: Promise<void> | undefined;
  let backpressureDisconnects = 0;
  let inboundQueueDisconnects = 0;
  let metricsInFlight: Promise<string> | undefined;
  const serveStatic = createStaticHandler(config.server.static, deps.baseDir);

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/readyz') {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      } else res.writeHead(stopping ? 503 : 200).end(req.method === 'HEAD' ? undefined : stopping ? 'draining' : 'ready');
      return;
    }
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
      // Overlapping scrapes share worker RPCs, but completed samples are never cached.
      const collect = deps.metrics;
      metricsInFlight ??= Promise.resolve().then(() => collect.call(deps)).finally(() => { metricsInFlight = undefined; });
      metricsInFlight.then(
        (text) => res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' }).end(text + renderPrometheus([
          { name: 'stage_ws_backpressure_disconnects_total', help: 'WebSocket connections terminated for exceeding the outbound buffer limit.', type: 'counter', value: backpressureDisconnects },
          { name: 'stage_ws_inbound_queue_disconnects_total', help: 'WebSocket connections terminated for exceeding the waiting input backlog.', type: 'counter', value: inboundQueueDisconnects },
        ])),
        (err) => { log.error('metrics error', { error: err }); res.writeHead(500).end(); },
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
    const names: Record<string, string[]> = Object.create(null);
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
    if (stopping) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 1\r\n\r\n', () => socket.destroy());
      return;
    }
    let path: string;
    try { path = new URL(req.url ?? '/', 'http://x').pathname; }
    catch {
      socket.once('error', () => socket.destroy());
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
      return;
    }
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
    let stopInput = () => {};
    const session = new WsSession(ws, config.limits.maxSendBufferBytes, (bufferedBytes, messageBytes) => {
      backpressureDisconnects++;
      log.warn('ws outbound buffer exceeded, disconnecting', { session: session.id, bufferedBytes, messageBytes, limitBytes: config.limits.maxSendBufferBytes });
    }, () => stopInput());
    const incoming = new MessageQueue<ClientMessage>(config.limits.maxPendingMessages, config.limits.maxPendingBytes, (message) => {
      if (stopping || ws.readyState !== ws.OPEN) { stopInput(); return Promise.resolve(); }
      return hub.handle(session, message);
    }, (error) => {
      log.error('ws message handler failed', { session: session.id, error });
      session.terminate();
    });
    stopInput = () => { void incoming.stop(); };
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
      if (stopping || ws.readyState !== ws.OPEN) return;
      let msg;
      let messageBytes = 0;
      try {
        if (isBinary) throw new ValidationError('bad_request', 'binary frame', undefined);
        const text = data.toString('utf8');
        messageBytes = Buffer.byteLength(text);
        msg = parseClientMessage(text, config.limits);
      } catch (err) {
        if (!limiter.allow('ping', now())) return violate(session, 'invalid');
        const e = err instanceof ValidationError ? err : new ValidationError('bad_request', 'parse', undefined);
        session.send({ type: 'error', ...(e.requestId ? { requestId: e.requestId } : {}), code: e.code, message: ERROR_MESSAGES[e.code] });
        return;
      }
      if (!limiter.allow(msg.type, now())) return violate(session, msg.type);
      if (!incoming.enqueue(msg, messageBytes)) {
        inboundQueueDisconnects++;
        log.warn('ws inbound backlog exceeded, disconnecting', { session: session.id, pendingMessages: incoming.pendingMessages, pendingBytes: incoming.pendingBytes, messageBytes });
        void incoming.stop();
        session.terminate();
      }
    });
    ws.on('close', (code) => {
      clearTimeout(joinDeadline);
      sessions.delete(session);
      const remaining = (perIp.get(ip) ?? 1) - 1;
      if (remaining > 0) perIp.set(ip, remaining); else perIp.delete(ip);
      log.debug('connection closed', { session: session.id, code });
      // 1000 from the client = it chose to leave; anything else (1001 page hide, 1006 drop…) holds the seat.
      const drained = incoming.stop();
      const detach = async (): Promise<void> => {
        try { await hub.detach(session, code === CLOSE_NORMAL); }
        catch (error) { log.error('ws detach failed', { session: session.id, error }); }
      };
      // Release the existing binding now so a stalled offer cannot prevent same-seat resume.
      void detach();
      // An already accepted join can bind after close; clean it up once active work settles.
      void drained.finally(detach).catch(error => {
        log.error('ws active work cleanup failed', { session: session.id, error });
      });
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
        s.terminate();
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }, config.rooms.heartbeatIntervalMs);
  heartbeat.unref();

  return {
    listen: () => {
      if (stopping) return Promise.reject(new Error('server is closing'));
      const { promise, resolve: done, reject } = Promise.withResolvers<AddressInfo>();
      server.once('error', reject);
      server.listen(config.server.port, config.server.host, () => {
        server.off('error', reject);
        done(server.address() as AddressInfo);
      });
      return promise;
    },
    close: () => {
      if (closing) return closing;
      stopping = true;
      for (const session of sessions) session.stopInput();
      closing = Promise.resolve().then(async () => {
        clearInterval(heartbeat);
        clearTimeout(reloadTimer);
        for (const w of watchers) w.close();
        try { await hub.shutdown(); }
        finally {
          // A graceful close flushes the `room:closed` frames queued above; terminate() could drop them.
          const drained = Promise.all([...sessions].map((s) => new Promise<void>(resolve => s.ws.once('close', () => resolve()))));
          for (const s of sessions) s.close(CLOSE_GOING_AWAY, 'server shutdown');
          const deadline = setTimeout(() => { for (const s of sessions) s.terminate(); }, SHUTDOWN_DRAIN_MS);
          await drained;
          clearTimeout(deadline);
          const wssClosed = Promise.withResolvers<void>();
          wss.close(() => wssClosed.resolve());
          await wssClosed.promise;
          const serverClosed = Promise.withResolvers<void>();
          server.close(() => serverClosed.resolve());
          // A paused download or unresolved metrics response must not retain the HTTP listener forever.
          const httpDeadline = setTimeout(() => server.closeAllConnections(), config.server.httpShutdownDrainMs);
          try { await serverClosed.promise; }
          finally { clearTimeout(httpDeadline); }
        }
      });
      return closing;
    },
  };
}
