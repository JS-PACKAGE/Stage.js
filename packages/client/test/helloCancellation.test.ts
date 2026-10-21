import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it, type TestContext } from 'node:test';
import { StageClient, StageError } from '../src/index.ts';

type CloseMode = 'stalled' | 'throwing' | 'normal';
type Operation = 'connect' | 'join' | 'createRoom';
type Outcome = { status: 'pending' } | { status: 'resolved' } | { status: 'rejected'; error: unknown };
interface Request { type: string; requestId: string; roomId?: string }

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  closeMode: CloseMode = 'stalled';
  closeCalls = 0;
  sent: Request[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data) as Request); }
  deliver(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello(): void {
    this.readyState = Socket.OPEN;
    this.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  }
  close(): void {
    this.closeCalls++;
    if (this.closeMode === 'throwing') throw new Error('close failed');
    this.readyState = this.closeMode === 'normal' ? 3 : 2;
    if (this.closeMode === 'normal') this.onclose?.();
  }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function observe(promise: Promise<unknown>): { outcome: Outcome } {
  const observation: { outcome: Outcome } = { outcome: { status: 'pending' } };
  void promise.then(() => { observation.outcome = { status: 'resolved' }; }, error => {
    observation.outcome = { status: 'rejected', error };
  });
  return observation;
}
function assertRejected(observation: { outcome: Outcome }, code: StageError['code']): void {
  assert.equal(observation.outcome.status, 'rejected', 'the caller must settle without the transport close or hello deadline');
  assert.ok(observation.outcome.status === 'rejected');
  assert.ok(observation.outcome.error instanceof StageError);
  assert.equal(observation.outcome.error.code, code);
}
function setup(t: TestContext) {
  Socket.instances = [];
  const target = new EventTarget();
  const originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(performance, 'now', () => 1000);
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    audioElement: { pause() {} } as unknown as HTMLAudioElement });
  t.after(async () => {
    for (const socket of Socket.instances) socket.closeMode = 'normal';
    await client.disconnect();
    for (const socket of Socket.instances) socket.onclose?.();
    await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { client, scheduled, cleared, listeners: () => getEventListeners(target, 'pagehide').length };
}
function start(client: StageClient, operation: Operation): Promise<unknown> {
  if (operation === 'join') return client.join({ roomId: 'room', name: 'Guest' });
  if (operation === 'createRoom') return client.createRoom({ name: 'Host' });
  return client.connect();
}

for (const operation of ['connect', 'join', 'createRoom'] as const) {
  for (const mode of ['stalled', 'throwing'] as const) {
    it(`cancels ${operation} before hello when socket close is ${mode}`, async t => {
      const { client, scheduled, cleared, listeners } = setup(t);
      const result = observe(start(client, operation));
      const socket = Socket.instances[0]!;
      socket.closeMode = mode;
      // The WebSocket upgrade completed, but the application hello has not arrived.
      socket.readyState = Socket.OPEN;
      assert.equal(scheduled.mock.calls.length, 1);
      const deadline = scheduled.mock.calls[0]!.result;
      await client.disconnect(); await flush();
      assertRejected(result, 'disconnected');
      assert.ok(cleared.mock.calls.some(call => call.arguments[0] === deadline), 'disconnect clears the retired hello deadline');
      assert.equal(socket.closeCalls, 1);
      assert.equal(listeners(), 0);
      assert.equal(client['pending'].size, 0);
      assert.equal(client['session'], null);
      assert.equal(client['connecting'], null);
      t.mock.timers.tick(1000); await flush();
      assertRejected(result, 'disconnected');
      assert.equal(socket.closeCalls, 1, 'the retired deadline must not close the transport again');
      assert.equal(socket.sent.length, 0);
    });
  }
}

it('cancels all callers sharing one pending hello, including duplicate connect calls', async t => {
  const { client, scheduled, cleared } = setup(t);
  const first = client.connect(), second = client.connect();
  assert.equal(first, second);
  const results = [first, second, client.join({ roomId: 'room', name: 'Guest' }), client.createRoom({ name: 'Host' })].map(observe);
  assert.equal(Socket.instances.length, 1);
  assert.equal(scheduled.mock.calls.length, 1);
  const deadline = scheduled.mock.calls[0]!.result;
  await client.disconnect(); await flush();
  for (const result of results) assertRejected(result, 'disconnected');
  assert.ok(cleared.mock.calls.some(call => call.arguments[0] === deadline));
  assert.equal(Socket.instances[0]!.sent.length, 0);
  assert.equal(client['pendingControlRequests'], 0);
});

for (const replacementPhase of ['awaiting hello', 'hello complete'] as const) {
  it(`isolates retired hello/error/close callbacks while the replacement is ${replacementPhase}`, async t => {
    const { client, listeners } = setup(t);
    const errors: StageError[] = [];
    client.on('error', event => errors.push(event.detail));
    const previous = observe(client.join({ roomId: 'old-room', name: 'Guest' }));
    const old = Socket.instances[0]!;
    await client.disconnect();
    const fresh = observe(client.join({ roomId: 'new-room', name: 'Guest' }));
    const replacement = Socket.instances[1]!;
    await flush(); assertRejected(previous, 'disconnected');
    if (replacementPhase === 'hello complete') { replacement.hello(); await flush(); t.mock.timers.tick(0); }
    // Saved transport callbacks can arrive after explicit cancellation and immediate reuse.
    old.hello(); old.onerror?.(); old.onclose?.(); await flush();
    assert.equal(client['socket'], replacement);
    assert.equal(listeners(), 1);
    assert.equal(fresh.outcome.status, 'pending');
    assert.equal(replacement.closeCalls, 0);
    assert.equal(old.sent.length, 0);
    if (replacementPhase === 'awaiting hello') {
      assert.equal(replacement.sent.length, 0, 'a retired hello cannot release replacement callers');
      replacement.hello(); await flush(); t.mock.timers.tick(0);
    }
    assert.equal(replacement.sent.length, 1);
    const request = replacement.sent[0]!;
    assert.equal(request.type, 'join'); assert.equal(request.roomId, 'new-room');
    replacement.deliver({ type: 'ok', requestId: request.requestId }); await flush();
    assert.equal(fresh.outcome.status, 'resolved');
    assert.equal(client['session']!.roomId, 'new-room');
    t.mock.timers.tick(1000); await flush();
    assert.equal(client['socket'], replacement);
    assert.equal(replacement.closeCalls, 0);
    assert.equal(listeners(), 1);
    assert.deepEqual(errors, []);
  });
}

it('can still cancel the replacement hello after every retired transport callback arrives', async t => {
  const { client, scheduled, cleared, listeners } = setup(t);
  const previous = observe(client.connect()), old = Socket.instances[0]!;
  await client.disconnect();
  const fresh = observe(client.connect()), replacement = Socket.instances[1]!;
  const deadline = scheduled.mock.calls.at(-1)!.result;
  old.hello(); old.onerror?.(); old.onclose?.(); await flush();
  assertRejected(previous, 'disconnected');
  assert.equal(fresh.outcome.status, 'pending');
  assert.equal(client['socket'], replacement);
  await client.disconnect(); await flush();
  assertRejected(fresh, 'disconnected');
  assert.ok(cleared.mock.calls.some(call => call.arguments[0] === deadline), 'old callbacks must not discard the new cancellation owner');
  assert.equal(listeners(), 0);
  t.mock.timers.tick(1000); await flush();
  assert.equal(replacement.closeCalls, 1);
});

for (const callback of ['close', 'status'] as const) {
  it(`clears the hello deadline before a synchronous ${callback} callback starts a replacement`, async t => {
    const { client, scheduled, cleared, listeners } = setup(t);
    const joined = observe(client.join({ roomId: 'room', name: 'Guest' }));
    const initial = Socket.instances[0]!;
    initial.hello(); await flush(); t.mock.timers.tick(0);
    initial.deliver({ type: 'ok', requestId: initial.sent[0]!.requestId }); await flush();
    assert.equal(joined.outcome.status, 'resolved');
    initial.closeMode = 'normal'; initial.close();
    assert.equal(client.status, 'reconnecting');
    t.mock.timers.tick(500);
    const pending = observe(client.connect()), cancelled = Socket.instances[1]!;
    const deadline = scheduled.mock.calls.at(-1)!.result;
    let replacementResult: ReturnType<typeof observe> | undefined;
    let callbackRan = false;
    let deadlineClearedBeforeCallback = false;
    let socketDetachedBeforeCallback = false;
    const replace = (): void => {
      callbackRan = true;
      deadlineClearedBeforeCallback = cleared.mock.calls.some(call => call.arguments[0] === deadline);
      socketDetachedBeforeCallback = client['socket'] === null;
      replacementResult = observe(client.connect());
    };
    if (callback === 'close') {
      const close = cancelled.close.bind(cancelled);
      cancelled.close = () => { replace(); close(); };
    } else client.on('status', event => { if (event.detail === 'disconnected') replace(); });
    await client.disconnect(); await flush();
    assert.equal(callbackRan, true);
    assert.equal(deadlineClearedBeforeCallback, true, 'the cancelled hello cannot retain a deadline during reentrancy');
    assert.equal(socketDetachedBeforeCallback, true);
    assertRejected(pending, 'disconnected');
    assert.ok(replacementResult);
    const replacement = Socket.instances[2]!;
    assert.equal(client['socket'], replacement);
    assert.equal(listeners(), 1);
    cancelled.hello(); cancelled.onerror?.(); cancelled.onclose?.(); await flush();
    replacement.hello(); await flush();
    assert.equal(replacementResult.outcome.status, 'resolved');
    t.mock.timers.tick(1000); await flush();
    assert.equal(replacement.closeCalls, 0);
    assert.equal(client['socket'], replacement);
    assert.equal(listeners(), 1);
  });
}

it('keeps normal hello success and clears its deadline', async t => {
  const { client, scheduled, cleared } = setup(t);
  const result = observe(client.connect()), socket = Socket.instances[0]!;
  const deadline = scheduled.mock.calls[0]!.result;
  socket.hello(); await flush();
  assert.equal(result.outcome.status, 'resolved');
  assert.ok(cleared.mock.calls.some(call => call.arguments[0] === deadline));
  t.mock.timers.tick(1000); await flush();
  assert.equal(socket.closeCalls, 0);
  await client.disconnect(); await flush();
  assert.equal(result.outcome.status, 'resolved', 'disconnect does not change an already successful connect');
});

it('keeps timeout for an uncancelled hello wait and detaches a stalled socket', async t => {
  const { client, listeners } = setup(t);
  const result = observe(client.connect()), socket = Socket.instances[0]!;
  socket.readyState = Socket.OPEN;
  t.mock.timers.tick(999); await flush(); assert.equal(result.outcome.status, 'pending');
  t.mock.timers.tick(1); await flush(); assertRejected(result, 'timeout');
  assert.equal(socket.closeCalls, 1);
  assert.equal(client['socket'], null);
  assert.equal(client['connecting'], null);
  assert.equal(listeners(), 0);
});

it('keeps disconnected for a current pre-hello socket error or close', async t => {
  const { client } = setup(t);
  const failed = observe(client.connect()), first = Socket.instances[0]!;
  first.onerror?.(); await flush(); assertRejected(failed, 'disconnected');
  first.closeMode = 'normal'; first.close(); await flush();
  const closed = observe(client.connect()), second = Socket.instances[1]!;
  second.closeMode = 'normal'; second.close(); await flush();
  assertRejected(closed, 'disconnected');
});
