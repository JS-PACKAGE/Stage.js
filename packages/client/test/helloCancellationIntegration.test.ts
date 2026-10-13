import assert from 'node:assert/strict';
import { once } from 'node:events';
import { it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { StageClient, StageError } from '../src/index.ts';

async function within<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), Math.max(1, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}
async function until(predicate: () => boolean, deadline: number, label: string): Promise<void> {
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${label}`);
    await sleep(5);
  }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('cancels a real pre-hello connection before its paused WebSocket close handshake completes', { timeout: 10000 }, async () => {
  const deadline = performance.now() + 5000;
  const originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const clientSockets: Socket[] = [], serverSockets: WebSocket[] = [];
  const socketErrors: Error[] = [], errors: StageError[] = [];
  class Socket extends WebSocket {
    closed = false;
    constructor(url: string) {
      super(url); clientSockets.push(this);
      this.on('close', () => { this.closed = true; });
      this.on('error', error => socketErrors.push(error));
    }
  }
  const hello = { type: 'hello', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let client: StageClient | undefined;
  server.on('connection', socket => {
    const attempt = serverSockets.push(socket);
    socket.on('error', error => socketErrors.push(error));
    socket.on('message', data => {
      const message = JSON.parse(String(data)) as { requestId?: string };
      if (message.requestId) socket.send(JSON.stringify({ type: 'ok', requestId: message.requestId }));
    });
    if (attempt === 1) { socket.pause(); return; }
    socket.send(JSON.stringify(hello));
  });
  try {
    await within(once(server, 'listening'), deadline, 'local server');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    const sdk = client = new StageClient({ url: `ws://127.0.0.1:${address.port}`, requestTimeoutMs: 1000,
      audioElement: { pause() {} } as unknown as HTMLAudioElement });
    sdk.on('error', event => errors.push(event.detail));
    const results: unknown[] = [];
    const first = sdk.connect(), duplicate = sdk.connect(); assert.equal(first, duplicate);
    const callers = [first, duplicate, sdk.join({ roomId: 'old-room', name: 'Guest' }), sdk.createRoom({ name: 'Host' })];
    for (const caller of callers) void caller.then(() => results.push('resolved'), error => results.push(error));
    const retired = clientSockets[0]!;
    await within(once(retired, 'open'), deadline, 'first WebSocket upgrade');
    assert.equal(serverSockets[0]!.isPaused, true);
    await sdk.disconnect(); await flush();
    assert.equal(retired.readyState, WebSocket.CLOSING);
    assert.equal(retired.closed, false);
    assert.equal(results.length, callers.length, 'all callers cancel before any close event or hello deadline');
    assert.ok(results.every(error => error instanceof StageError && error.code === 'disconnected'));

    await within(sdk.join({ roomId: 'new-room', name: 'Guest' }), deadline, 'replacement join');
    const replacement = clientSockets[1]!;
    assert.equal(replacement.readyState, WebSocket.OPEN);
    assert.equal(retired.readyState, WebSocket.CLOSING);
    assert.equal(retired.closed, false);
    assert.equal(sdk['session']!.roomId, 'new-room');
    assert.equal(sdk['socket'], replacement);
    serverSockets[0]!.resume();
    await until(() => retired.closed, deadline, 'retired close handshake');
    await within(sdk.raiseHand(), deadline, 'replacement command after old close');
    assert.equal(sdk['socket'], replacement);
    assert.equal(sdk['session']!.roomId, 'new-room');
    assert.equal(clientSockets.length, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(socketErrors, []);
  } finally {
    try { await client?.disconnect(); }
    finally {
      for (const socket of [...clientSockets, ...serverSockets]) { socket.resume(); socket.terminate(); }
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await within(new Promise<void>((resolve, reject) => server.close(error => {
        if (error) reject(error); else resolve();
      })), performance.now() + 1000, 'local server cleanup');
      await until(() => [...clientSockets, ...serverSockets].every(socket => socket.readyState === WebSocket.CLOSED),
        performance.now() + 1000, 'all test WebSockets close');
      assert.equal(server.clients.size, 0);
      if (client) {
        assert.equal(client['connecting'], null);
        assert.equal(client['pending'].size, 0);
        assert.equal(client['reconnectTimer'], undefined);
        assert.equal(client['keepaliveTimer'], undefined);
      }
    }
  }
});
