import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
  metrics?: () => string;
}

/** Policy-violation close code (RFC 6455) used for rate-limit disconnects. */
const CLOSE_POLICY = 1008;

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
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' }).end(deps.metrics());
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
  const server: Server =
    certFile && keyFile
      ? createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, onRequest)
      : createHttpServer(onRequest);

  // Client is embedded on third-party sites, so no Origin allow-list (AGENTS.md §S10);
  // protection is room code + rate limits + caps.
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxFrameBytes });
  const sessions = new Set<WsSession>();

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== config.server.wsPath || sessions.size >= config.limits.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const session = new WsSession(ws);
    const limiter = new ConnectionRateLimiter(config.limits, now());
    sessions.add(session);
    log.debug('connection opened', { session: session.id });
    hub.attach(session);

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
    ws.on('close', () => {
      sessions.delete(session);
      log.debug('connection closed', { session: session.id });
      session.chain = session.chain.then(() => hub.detach(session));
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
    close: async () => {
      clearInterval(heartbeat);
      await hub.shutdown();
      for (const s of sessions) s.ws.terminate();
      const wssClosed = Promise.withResolvers<void>();
      wss.close(() => wssClosed.resolve());
      await wssClosed.promise;
      const serverClosed = Promise.withResolvers<void>();
      server.close(() => serverClosed.resolve());
      await serverClosed.promise;
    },
  };
}
