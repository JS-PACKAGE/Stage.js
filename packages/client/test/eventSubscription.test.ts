import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, type StageClientEventOptions, type StageEventMap } from '../src/index.ts';

type HandEvent = CustomEvent<StageEventMap['hand']>;
class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = Socket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.latest = this; }
  send() { throw new Error('Event subscription tests must not send requests'); }
  deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
async function fixture(t: TestContext) {
  const originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  const client = new StageClient({ url: 'ws://localhost/events', audioElement: { pause() {} } as unknown as HTMLAudioElement });
  t.after(async () => {
    try { await client.disconnect(); }
    finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const connected = client.connect(), socket = Socket.latest;
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'event-test',
    limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await connected;
  const hand = (participantId = 'participant', raised = true) => socket.deliver({ type: raised ? 'hand:raise' : 'hand:withdraw', participantId });
  return { client, hand };
}

it('keeps two-argument typed subscriptions, actual SDK event identity, receiver and idempotent unsubscribe', async t => {
  const { client, hand } = await fixture(t);
  const native: Event[] = [], received: HandEvent[] = [];
  const off = client.on('hand', function (this: StageClient, event) {
    assert.ok(event instanceof CustomEvent);
    assert.equal(this, client);
    assert.equal(event.target, client);
    assert.equal(event.currentTarget, client);
    received.push(event);
  });
  client.addEventListener('hand', event => native.push(event));
  hand('first'); hand('second', false); off(); off(); hand('third');
  assert.deepEqual(received.map(event => event.detail), [
    { participantId: 'first', raised: true }, { participantId: 'second', raised: false },
  ]);
  assert.equal(received[0], native[0]); assert.equal(received[1], native[1]);
  assert.equal(native.length, 3);
});

it('removes once subscriptions before reentrant SDK delivery', async t => {
  const { client, hand } = await fixture(t);
  const seen: string[] = [];
  const off = client.on('hand', event => {
    seen.push(event.detail.participantId);
    if (seen.length === 1) hand('nested');
  }, { once: true });
  hand('outer'); hand('later'); off(); off();
  assert.deepEqual(seen, ['outer']);
});

for (const options of [undefined, {}, { once: false }] satisfies (StageClientEventOptions | undefined)[]) {
  it(`retains ordinary repeated delivery with ${JSON.stringify(options) ?? 'omitted options'}`, async t => {
    const { client, hand } = await fixture(t);
    let calls = 0;
    const off = client.on('hand', () => { calls++; }, options);
    hand(); hand(); off(); hand();
    assert.equal(calls, 2);
  });
}

it('honors active abort and isolates other callbacks', async t => {
  const { client, hand } = await fixture(t);
  const controller = new AbortController();
  let scoped = 0, independent = 0;
  const off = client.on('hand', () => { scoped++; }, { signal: controller.signal });
  client.on('hand', () => { independent++; });
  hand(); controller.abort(); hand(); off(); off(); controller.abort(); hand();
  assert.deepEqual([scoped, independent], [1, 3]);
});

it('never registers a callback for an already aborted signal', async t => {
  const { client, hand } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const off = client.on('hand', () => { calls++; }, { once: true, signal: controller.signal });
  hand(); off(); off(); hand();
  assert.equal(calls, 0);
});

it('aborts all distinct listeners sharing a signal', async t => {
  const { client, hand } = await fixture(t);
  const controller = new AbortController();
  const seen: string[] = [];
  client.on('hand', () => seen.push('first'), { signal: controller.signal });
  client.on('hand', () => seen.push('second'), { signal: controller.signal });
  hand(); controller.abort(); hand();
  assert.deepEqual(seen, ['first', 'second']);
});

it('suppresses a later listener when its signal is aborted during dispatch', async t => {
  const { client, hand } = await fixture(t);
  const controller = new AbortController();
  const seen: string[] = [];
  client.on('hand', () => { seen.push('first'); controller.abort(); });
  client.on('hand', () => seen.push('aborted'), { signal: controller.signal });
  client.on('hand', () => seen.push('last'));
  hand(); hand();
  assert.deepEqual(seen, ['first', 'last', 'first', 'last']);
});

it('allows self-abort during a callback and prevents nested delivery to that callback', async t => {
  const { client, hand } = await fixture(t);
  const controller = new AbortController();
  let calls = 0;
  client.on('hand', () => {
    calls++;
    controller.abort();
    if (calls === 1) hand('nested');
  }, { signal: controller.signal });
  hand(); hand();
  assert.equal(calls, 1);
});

it('supports unsubscribe before delivery with both once and signal', async t => {
  const { client, hand } = await fixture(t);
  const controller = new AbortController();
  let calls = 0;
  const off = client.on('hand', () => { calls++; }, { once: true, signal: controller.signal });
  off(); off(); hand(); controller.abort(); hand();
  assert.equal(calls, 0);
});

it('allows once and signal together and harmless cleanup after one-shot delivery', async t => {
  const { client, hand } = await fixture(t);
  const controller = new AbortController();
  let calls = 0;
  const off = client.on('hand', () => { calls++; }, { once: true, signal: controller.signal });
  hand(); hand(); off(); controller.abort(); off(); hand();
  assert.equal(calls, 1);
});

it('preserves native deduplication and either unsubscribe removes the shared callback', async t => {
  const { client, hand } = await fixture(t);
  let calls = 0;
  const listener = (_event: HandEvent) => { calls++; };
  const firstOff = client.on('hand', listener);
  const secondOff = client.on('hand', listener, { once: false });
  hand(); assert.equal(calls, 1);
  secondOff(); hand(); assert.equal(calls, 1);
  firstOff(); hand(); assert.equal(calls, 1);
});

for (const firstOnce of [false, true]) {
  it(`does not change native once behavior on duplicate registration when first once is ${firstOnce}`, async t => {
    const { client, hand } = await fixture(t);
    let calls = 0;
    const listener = (_event: HandEvent) => { calls++; };
    client.on('hand', listener, { once: firstOnce });
    client.on('hand', listener, { once: !firstOnce });
    hand(); hand();
    assert.equal(calls, firstOnce ? 1 : 2);
  });
}

for (const abortSecond of [false, true]) {
  it(`matches native duplicate-signal semantics when aborting the ${abortSecond ? 'second' : 'first'} signal`, async t => {
    const { client, hand } = await fixture(t);
    const native = new EventTarget();
    const first = new AbortController(), second = new AbortController();
    const actual: string[] = [], expected: string[] = [];
    const listener = (event: HandEvent) => actual.push(event.detail.participantId);
    const nativeListener = (event: Event) => expected.push((event as HandEvent).detail.participantId);
    client.on('hand', listener, { signal: first.signal });
    client.on('hand', listener, { once: true, signal: second.signal });
    native.addEventListener('hand', nativeListener, { signal: first.signal });
    native.addEventListener('hand', nativeListener, { once: true, signal: second.signal });
    const emit = (participantId: string) => {
      hand(participantId);
      native.dispatchEvent(new CustomEvent('hand', { detail: { participantId, raised: true } }));
      assert.deepEqual(actual, expected);
    };
    emit('before'); (abortSecond ? second : first).abort(); emit('after');
    first.abort(); second.abort(); emit('both');
  });
}

it('keeps native and typed registrations interoperable in both detach directions', async t => {
  const { client, hand } = await fixture(t);
  let calls = 0;
  const listener = (_event: HandEvent) => { calls++; };
  client.addEventListener('hand', listener as EventListener);
  const off = client.on('hand', listener, { once: true });
  hand(); hand(); assert.equal(calls, 2);
  off(); hand(); assert.equal(calls, 2);
  client.on('hand', listener, { signal: new AbortController().signal });
  client.removeEventListener('hand', listener as EventListener);
  hand(); assert.equal(calls, 2);
});

it('passes the original callback and only projected once/signal values to native registration', async t => {
  const { client, hand } = await fixture(t);
  const add = t.mock.method(client, 'addEventListener');
  const remove = t.mock.method(client, 'removeEventListener');
  const controller = new AbortController();
  const wider = { once: false, signal: controller.signal, capture: true, passive: true };
  let calls = 0;
  const listener = (_event: HandEvent) => { calls++; };
  const off = client.on('hand', listener, wider);
  const registration = add.mock.calls[0]!;
  assert.equal(registration.arguments[0], 'hand');
  assert.equal(registration.arguments[1], listener);
  assert.notEqual(registration.arguments[2], wider);
  assert.deepEqual(registration.arguments[2], { once: false, signal: controller.signal });
  hand(); off(); hand();
  assert.equal(calls, 1);
  assert.deepEqual(remove.mock.calls[0]!.arguments, ['hand', listener]);
});

it('does not read unsupported wider option getters or mutate the options object', async t => {
  const { client, hand } = await fixture(t);
  const options = Object.freeze({ once: true,
    get capture(): boolean { throw new Error('capture must not be read'); },
    get passive(): boolean { throw new Error('passive must not be read'); },
  });
  let calls = 0;
  const off = client.on('hand', () => { calls++; }, options);
  hand(); hand(); off(); assert.equal(calls, 1);
});

it('keeps true-capture native registration separate while ignoring wider capture on the helper', async t => {
  const { client, hand } = await fixture(t);
  let calls = 0;
  const listener = (_event: HandEvent) => { calls++; };
  client.addEventListener('hand', listener as EventListener, { capture: true });
  const wider = { once: false, capture: true };
  const off = client.on('hand', listener, wider);
  hand(); assert.equal(calls, 2);
  off(); hand(); assert.equal(calls, 3);
  client.removeEventListener('hand', listener as EventListener, { capture: true });
  hand(); assert.equal(calls, 3);
});

it('retains callback and event-type isolation and supports unsubscribe during dispatch', async t => {
  const { client, hand } = await fixture(t);
  const seen: string[] = [];
  let offLater: () => void;
  const shared = () => seen.push('shared');
  client.on('status', shared);
  const offFirst = client.on('hand', () => { seen.push('first'); offLater(); });
  offLater = client.on('hand', shared, { once: true });
  hand(); offFirst(); hand();
  client.dispatchEvent(new CustomEvent('status', { detail: 'waiting' }));
  assert.deepEqual(seen, ['first', 'shared']);
});

it('retains native identity when an old unsubscribe removes a later registration', async t => {
  const { client, hand } = await fixture(t);
  let calls = 0;
  const listener = (_event: HandEvent) => { calls++; };
  const oldOff = client.on('hand', listener, { once: true });
  hand();
  client.on('hand', listener, { signal: new AbortController().signal });
  oldOff(); oldOff(); hand();
  assert.equal(calls, 1);
});
