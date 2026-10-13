import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import type { AppConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import type { WsSession } from '../src/ws/session.ts';
import { harness, RECVONLY_OFFER, SENDRECV_OFFER, testConfig } from './helpers.ts';

const IO_MS = 2500;
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
const DRAINING = 'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 1\r\n\r\n';
const MALFORMED_TARGETS = ['//[', 'http://[', '//%', '//host:bad/custom/stage'];

async function bounded<T>(promise: Promise<T>, label: string, ms = IO_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url, { origin: 'https://unrelated-embed.example', handshakeTimeout: IO_MS });
    this.ws.on('message', data => this.inbox.push(JSON.parse(data.toString()) as ServerMessage));
    // Failed admission/cleanup must not create an unhandled client-side error.
    this.ws.on('error', () => {});
  }

  async open(): Promise<void> {
    await once(this.ws, 'open', { signal: AbortSignal.timeout(IO_MS) });
    await this.message(message => message.type === 'hello');
  }

  message(predicate: (message: ServerMessage) => boolean, since = 0): Promise<ServerMessage> {
    const found = this.inbox.slice(since).find(predicate);
    if (found) return Promise.resolve(found);
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.reject(new Error('WebSocket closed before expected message'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.ws.off('message', changed);
        this.ws.off('close', closed);
        this.ws.off('error', failed);
      };
      const changed = () => {
        const message = this.inbox.slice(since).find(predicate);
        if (message) { cleanup(); resolve(message); }
      };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => failed(new Error('WebSocket closed before expected message'));
      const timer = setTimeout(() => failed(new Error('WebSocket message timed out')), IO_MS);
      this.ws.on('message', changed);
      this.ws.once('close', closed);
      this.ws.once('error', failed);
    });
  }

  async request(message: Exclude<ClientMessage, { type: 'ping' }>): Promise<void> {
    this.ws.send(JSON.stringify(message));
    const reply = await this.message(value => (value.type === 'ok' || value.type === 'error') && value.requestId === message.requestId);
    assert.equal(reply.type, 'ok', JSON.stringify(reply));
  }

  async ping(): Promise<void> {
    const since = this.inbox.length;
    this.ws.send(JSON.stringify({ type: 'ping' }));
    await this.message(message => message.type === 'pong', since);
    const pong = once(this.ws, 'pong', { signal: AbortSignal.timeout(IO_MS) });
    this.ws.ping('still-alive');
    assert.equal((await pong)[0].toString(), 'still-alive');
  }
}

async function setup(patch?: (config: AppConfig) => void) {
  const config = testConfig(value => {
    value.server.host = '127.0.0.1';
    value.server.port = 0;
    value.server.wsPath = '/custom/stage';
    value.server.static = [];
    value.server.httpShutdownDrainMs = 100;
    value.limits.maxConnections = 4;
    value.limits.maxConnectionsPerIp = 4;
    value.limits.joinTimeoutMs = 0;
    value.limits.controlPerSecond = 200;
    value.rooms.heartbeatIntervalMs = 60000;
    patch?.(value);
  });
  const { hub, transport } = harness(config);
  const sessions: WsSession[] = [];
  const attach = hub.attach.bind(hub);
  hub.attach = session => { sessions.push(session as WsSession); attach(session); };
  const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir() });
  const clients: Client[] = [];
  const sockets = new Set<Socket>();
  const { port } = await bounded(server.listen(), 'listen');

  function rawUpgrade(target: string, key = 'dGhlIHNhbXBsZSBub25jZQ==', reset = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      sockets.add(socket);
      let response = '';
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error('Raw upgrade did not close before deadline');
        socket.destroy();
        reject(failure);
      }, IO_MS);
      socket.on('data', chunk => {
        response += chunk.toString('latin1');
        if (response.length > 32768) { failure = new Error('Oversized upgrade response'); socket.destroy(); }
      });
      socket.on('error', error => { if (!reset) failure = error; });
      socket.once('close', () => {
        clearTimeout(timer);
        sockets.delete(socket);
        if (failure) reject(failure); else resolve(response);
      });
      socket.once('connect', () => {
        socket.write([
          `GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
          'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`, 'Origin: https://unrelated-embed.example', '', '',
        ].join('\r\n'), () => { if (reset && !socket.destroyed) socket.resetAndDestroy(); });
      });
    });
  }

  async function http(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = get({ host: '127.0.0.1', port, path, agent: false }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      const timer = setTimeout(() => request.destroy(new Error('HTTP request timed out')), IO_MS);
      request.once('error', reject);
      request.once('close', () => clearTimeout(timer));
    });
  }

  async function client(query = ''): Promise<Client> {
    const value = new Client(`ws://127.0.0.1:${port}${config.server.wsPath}${query}`);
    clients.push(value);
    await value.open();
    return value;
  }

  async function close(): Promise<void> {
    try {
      for (const socket of sockets) socket.destroy();
      const closed = clients.filter(value => value.ws.readyState !== WebSocket.CLOSED).map(value =>
        once(value.ws, 'close', { signal: AbortSignal.timeout(3500) }));
      await bounded(Promise.all([server.close(), ...closed]), 'shutdown', 4000);
      assert.equal(hub.roomCount, 0);
      assert.equal(transport.rooms.size, 0);
      assert.equal(sockets.size, 0);
      for (const value of clients) assert.equal(value.ws.readyState, WebSocket.CLOSED);
    } finally {
      for (const value of clients) value.ws.terminate();
      for (const socket of sockets) socket.destroy();
    }
  }

  return { config, hub, transport, sessions, server, rawUpgrade, http, client, close };
}

async function createRoom(client: Client, requestId = 'create') {
  await client.request({ type: 'room:create', requestId, name: 'Host', roomName: 'Surviving room' });
  const state = await client.message(message => message.type === 'room:state');
  assert.ok(state.type === 'room:state');
  return state;
}

const scenarios: Record<string, () => Promise<void>> = {
  async continuity() {
    const fixture = await setup();
    try {
      const host = await fixture.client('?source=embed&next=//[');
      const room = await createRoom(host);
      await host.request({ type: 'rtc:offer', requestId: 'host-offer', payload: SENDRECV_OFFER });
      const guest = await fixture.client('?source=guest');
      await guest.request({ type: 'join', requestId: 'guest-join', roomId: room.roomId, code: room.code, name: 'Guest' });
      const guestState = await guest.message(message => message.type === 'room:state');
      assert.ok(guestState.type === 'room:state');
      await guest.request({ type: 'rtc:offer', requestId: 'guest-offer', payload: RECVONLY_OFFER });
      const mediaRoom = fixture.transport.rooms.get(room.roomId)!;
      const hostPeer = mediaRoom.peers.get(room.me.participantId);
      const guestPeer = mediaRoom.peers.get(guestState.me.participantId);
      assert.ok(hostPeer);
      assert.ok(guestPeer);
      const before = fixture.hub.metrics();

      for (const target of MALFORMED_TARGETS) {
        assert.throws(() => new URL(target, 'http://x'), { code: 'ERR_INVALID_URL' });
        assert.equal(await fixture.rawUpgrade(target), BAD_REQUEST, target);
        assert.equal(fixture.sessions.length, 2, 'rejection must not attach a session');
        await host.ping();
      }
      assert.deepEqual(fixture.hub.metrics(), before);
      assert.equal(fixture.transport.rooms.get(room.roomId), mediaRoom);
      assert.equal(mediaRoom.peers.get(room.me.participantId), hostPeer);
      assert.equal(mediaRoom.peers.get(guestState.me.participantId), guestPeer);
      for (const session of fixture.sessions) assert.equal(fixture.hub.isJoined(session), true);
      await host.request({ type: 'mic:mute', requestId: 'mute-after-rejections' });
      assert.equal(mediaRoom.muted.has(room.me.participantId), true);
      await host.request({ type: 'mic:unmute', requestId: 'unmute-after-rejections' });
      assert.equal(mediaRoom.muted.has(room.me.participantId), false);
      await guest.ping();
      assert.deepEqual(await fixture.http('/healthz'), { status: 200, body: 'ok' });
      assert.deepEqual(await fixture.http('/readyz'), { status: 200, body: 'ready' });

      const laterHost = await fixture.client('?next=http://[');
      const laterRoom = await createRoom(laterHost, 'later-create');
      const laterGuest = await fixture.client();
      await laterGuest.request({ type: 'join', requestId: 'later-join', roomId: laterRoom.roomId, code: laterRoom.code, name: 'Later guest' });
      assert.equal(fixture.sessions.length, 4);
      assert.equal(fixture.hub.roomCount, 2);
      await laterGuest.ping();
    } finally { await fixture.close(); }
  },

  async globalCapacity() { await capacity(false); },
  async perIpCapacity() { await capacity(true); },

  async draining() {
    const fixture = await setup();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const shutdown = fixture.hub.shutdown.bind(fixture.hub);
    fixture.hub.shutdown = async () => { started.resolve(); await gate.promise; await shutdown(); };
    try {
      const host = await fixture.client();
      await createRoom(host);
      const closed = once(host.ws, 'close', { signal: AbortSignal.timeout(5000) });
      const closing = fixture.server.close();
      assert.equal(fixture.server.close(), closing);
      await bounded(started.promise, 'shutdown entry');
      for (const target of [...MALFORMED_TARGETS, fixture.config.server.wsPath]) {
        assert.equal(await fixture.rawUpgrade(target), DRAINING, 'shutdown must take precedence over target parsing');
      }
      assert.equal(fixture.sessions.length, 1);
      assert.deepEqual(await fixture.http('/readyz'), { status: 503, body: 'draining' });
      assert.deepEqual(await fixture.http('/healthz'), { status: 200, body: 'ok' });
      gate.resolve();
      await bounded(closing, 'draining shutdown', 4000);
      assert.equal((await closed)[0], 1001);
      assert.ok(host.inbox.some(message => message.type === 'room:closed' && message.reason === 'shutdown'));
    } finally { gate.resolve(); await fixture.close(); }
  },

  async reset() {
    const fixture = await setup(config => { config.limits.maxConnections = 1; config.limits.maxConnectionsPerIp = 1; });
    try {
      // Race the rejection write with a native TCP reset; no server-side exception handler masks failures.
      for (let attempt = 0; attempt < 8; attempt++) await fixture.rawUpgrade('//[', undefined, true);
      assert.deepEqual(await fixture.http('/healthz'), { status: 200, body: 'ok' });
      assert.equal(fixture.sessions.length, 0);
      const host = await fixture.client();
      await createRoom(host);
      await host.ping();
      assert.equal(fixture.sessions.length, 1);
    } finally { await fixture.close(); }
  },
};

async function capacity(perIp: boolean): Promise<void> {
  const fixture = await setup(config => {
    config.limits.maxConnections = perIp ? 8 : 2;
    config.limits.maxConnectionsPerIp = perIp ? 2 : 0;
  });
  try {
    for (const target of MALFORMED_TARGETS) assert.equal(await fixture.rawUpgrade(target), BAD_REQUEST);
    assert.equal(fixture.sessions.length, 0);
    assert.match(await fixture.rawUpgrade('/wrong-path'), /^HTTP\/1\.1 503 Service Unavailable\r\n/);
    assert.match(await fixture.rawUpgrade(fixture.config.server.wsPath, 'invalid-key'), /^HTTP\/1\.1 400 Bad Request\r\n/);
    assert.equal(fixture.sessions.length, 0, 'ws handshake rejection must not attach a session');
    const host = await fixture.client();
    const room = await createRoom(host);
    const guest = await fixture.client('?query=retained');
    await guest.request({ type: 'join', requestId: 'join', roomId: room.roomId, code: room.code, name: 'Guest' });
    assert.equal(fixture.sessions.length, 2);
    assert.match(await fixture.rawUpgrade(fixture.config.server.wsPath), /^HTTP\/1\.1 503 Service Unavailable\r\n/);
    assert.equal(await fixture.rawUpgrade('//['), BAD_REQUEST, 'malformed targets are rejected even at capacity');
    assert.equal(fixture.sessions.length, 2);
    await host.ping();

    const clientClosed = once(guest.ws, 'close', { signal: AbortSignal.timeout(IO_MS) });
    const serverClosed = once(fixture.sessions[1]!.ws, 'close', { signal: AbortSignal.timeout(IO_MS) });
    guest.ws.close(1000);
    await Promise.all([clientClosed, serverClosed]);
    assert.equal(await fixture.rawUpgrade('//%'), BAD_REQUEST);
    const replacement = await fixture.client();
    await replacement.request({ type: 'join', requestId: 'replacement-join', roomId: room.roomId, code: room.code, name: 'Replacement' });
    assert.equal(fixture.sessions.length, 3, 'rejected upgrades must not consume a released slot');
    await replacement.ping();
  } finally { await fixture.close(); }
}

const childScenario = process.argv[2];
if (childScenario !== undefined && Object.hasOwn(scenarios, childScenario)) {
  await scenarios[childScenario]!();
  process.stdout.write('upgrade target scenario passed\n');
} else {
  describe('raw WebSocket upgrade target boundary', () => {
    const cases = [
      ['continuity', 'rejects malformed targets without disturbing existing peers or later create/join'],
      ['globalCapacity', 'preserves handshake/path controls and does not consume global connection capacity'],
      ['perIpCapacity', 'preserves handshake/path controls and does not consume per-address capacity'],
      ['draining', 'keeps shutdown 503 priority over malformed-target 400 and closes cleanly'],
      ['reset', 'survives clients resetting malformed upgrade sockets during rejection'],
    ] as const;
    for (const [scenario, name] of cases) {
      it(name, { timeout: 15000 }, () => {
        // An uncaught upgrade exception must terminate a normal process, not be swallowed by
        // the test runner's own exception listener. A hard deadline also bounds leaked handles.
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', fileURLToPath(import.meta.url), scenario], {
          env, encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 65536,
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'upgrade target scenario passed\n');
      });
    }
  });
}
