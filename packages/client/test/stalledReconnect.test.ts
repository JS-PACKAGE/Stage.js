import assert from 'node:assert/strict';
import { once } from 'node:events';
import { it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { StageClient, type StageError } from '../src/index.ts';

interface Request {
  type: string;
  requestId: string;
  roomId?: string;
  code?: string;
  name?: string;
}

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

for (const stall of ['hello', 'resume ACK'] as const) {
  it(`retries a missing ${stall} before a real WebSocket close handshake finishes`, { timeout: 10000 }, async () => {
    const deadline = performance.now() + 5000;
    const originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const clientSockets: Socket[] = [];
    const serverSockets: WebSocket[] = [];
    const requests: { socket: WebSocket; message: Request }[] = [];
    const errors: StageError[] = [];
    const socketErrors: Error[] = [];
    class Socket extends WebSocket {
      opened = false;
      closed = false;
      constructor(url: string) {
        super(url);
        clientSockets.push(this);
        this.on('open', () => { this.opened = true; });
        this.on('close', () => { this.closed = true; });
        this.on('error', error => socketErrors.push(error));
      }
    }
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let client: StageClient | undefined;
    server.on('connection', socket => {
      const attempt = serverSockets.push(socket);
      socket.on('error', error => socketErrors.push(error));
      socket.on('message', data => {
        const message = JSON.parse(String(data)) as Request;
        requests.push({ socket, message });
        if (attempt === 2 && stall === 'resume ACK' && message.type === 'join') {
          // Stop reading the close frame too, so native ws stays CLOSING until explicitly resumed.
          socket.pause();
          return;
        }
        socket.send(JSON.stringify({ type: 'ok', requestId: message.requestId }));
        if (message.type === 'join') socket.send(JSON.stringify({ type: 'status', state: 'live' }));
      });
      if (attempt === 2 && stall === 'hello') { socket.pause(); return; }
      socket.send(JSON.stringify({
        type: 'hello', protocol: 1, serverVersion: 'test',
        limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 },
      }));
    });
    try {
      await within(once(server, 'listening'), deadline, 'local WebSocket server');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
      const audio = { volume: 1, muted: false, pause() {}, srcObject: null } as unknown as HTMLAudioElement;
      const sdk = client = new StageClient({
        url: `ws://127.0.0.1:${address.port}`, audioElement: audio,
        requestTimeoutMs: 250, reconnect: { initialDelayMs: 5, maxDelayMs: 10 },
      });
      sdk.on('error', event => errors.push(event.detail));
      const join = { roomId: 'held-room', code: 'held-code', name: 'Guest' };
      // ACK-only joins exercise the real SDK session without creating any browser media objects.
      await within(sdk.join(join), deadline, 'initial join');
      await until(() => sdk.status === 'live', deadline, 'initial live status');
      const session = sdk['session'];
      assert.deepEqual(session, join);
      assert.equal(sdk.state, null);
      assert.equal(sdk['pc'], null);
      serverSockets[0]!.terminate();

      await until(() => clientSockets[0]!.closed && !!serverSockets[1]?.isPaused, deadline, 'paused reconnect transport');
      const stalled = clientSockets[1]!;
      await until(() => stalled.readyState === WebSocket.CLOSING, deadline, 'timed-out transport enters CLOSING');
      assert.equal(stalled.opened, true, 'the stalled connection completed its WebSocket upgrade');
      assert.equal(stalled.closed, false);
      assert.equal(sdk['session'], session);
      const stalledJoins = requests.filter(request => request.socket === serverSockets[1] && request.message.type === 'join');
      assert.equal(stalledJoins.length, stall === 'hello' ? 0 : 1);

      await until(() => clientSockets.length >= 3 && sdk['socket'] === (clientSockets[2] as unknown) &&
        sdk.status === 'live' && sdk['pending'].size === 0, deadline, 'automatic next resume without the old close');
      const recovered = clientSockets[2]!;
      assert.equal(stalled.readyState, WebSocket.CLOSING, 'retry does not depend on the old transport closing');
      assert.equal(stalled.closed, false);
      assert.equal(serverSockets[1]!.isPaused, true);
      assert.equal(recovered.readyState, WebSocket.OPEN);
      assert.equal(sdk['session'], session, 'the same session survives the transient timeout');
      const resumed = requests.filter(request => request.socket === serverSockets[2] && request.message.type === 'join');
      assert.equal(resumed.length, 1);
      const { type, requestId, ...payload } = resumed[0]!.message;
      assert.equal(type, 'join');
      assert.ok(requestId);
      assert.deepEqual(payload, join);
      assert.deepEqual(errors.map(error => error.code), ['timeout']);

      serverSockets[1]!.resume();
      await until(() => stalled.closed, deadline, 'late close from the retired transport');
      await within(sdk.raiseHand(), deadline, 'command after the retired transport closes');
      assert.equal(requests.at(-1)!.socket, serverSockets[2]);
      assert.equal(requests.at(-1)!.message.type, 'hand:raise');
      assert.equal(sdk['socket'], recovered);
      assert.equal(sdk['session'], session);
      assert.equal(sdk.status, 'live');
      assert.equal(sdk['reconnectTimer'], undefined);
      assert.equal(sdk['pending'].size, 0);
      assert.equal(clientSockets.length, 3, 'a late close must not start another reconnect');
      assert.deepEqual(errors.map(error => error.code), ['timeout']);
      assert.deepEqual(socketErrors, []);
    } finally {
      try { await client?.disconnect(); }
      finally {
        for (const socket of [...clientSockets, ...serverSockets]) { socket.resume(); socket.terminate(); }
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
        await within(new Promise<void>((resolve, reject) => {
          server.close(error => { if (error) reject(error); else resolve(); });
        }), performance.now() + 1000, 'local WebSocket server cleanup');
        await until(() => [...clientSockets, ...serverSockets].every(socket => socket.readyState === WebSocket.CLOSED),
          performance.now() + 1000, 'all local WebSocket transports close');
        assert.equal(server.clients.size, 0);
        if (client) {
          assert.equal(client['reconnectTimer'], undefined);
          assert.equal(client['keepaliveTimer'], undefined);
          assert.equal(client['pending'].size, 0);
        }
      }
    }
  });
}
