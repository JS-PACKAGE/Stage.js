import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StageClient, StageError } from '../src/index.ts';

class Context {
  static instances: Context[] = [];
  static onCreate: (() => void) | undefined;
  closed = 0;
  constructor() { Context.instances.push(this); Context.onCreate?.(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, getFloatTimeDomainData(samples: Float32Array) { samples.fill(0.25); }, disconnect() {} }; }
  async resume() {}
  async close() { this.closed++; }
}
function stream() {
  const track = { enabled: true, stops: 0, stop() { this.stops++; } };
  return { track, value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('abortable microphone preview', () => {
  let client: StageClient;
  let requests: ReturnType<typeof deferred<MediaStream>>[];
  let originals: Map<string, PropertyDescriptor | undefined>;
  beforeEach(() => {
    requests = []; Context.instances = []; Context.onCreate = undefined;
    originals = new Map(['window', 'navigator', 'AudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() { const request = deferred<MediaStream>(); requests.push(request); return request.promise; } } } });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
    client = new StageClient({ url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement });
  });
  afterEach(async () => {
    await client.disconnect();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it('rejects an already-aborted signal without requesting microphone permission', async () => {
    const controller = new AbortController(), reason = new Error('cancel preview');
    controller.abort(reason);
    await assert.rejects(client.startMicTest({ signal: controller.signal }), error => error === reason);
    assert.equal(requests.length, 0);
    assert.equal(Context.instances.length, 0);
  });

  for (const resolveFirst of [false, true]) it(`stops a late stream when abort ${resolveFirst ? 'follows resolution' : 'precedes resolution'}`, async () => {
    const controller = new AbortController(), source = stream();
    let ready = 0; client.on('micready', () => { ready++; });
    const pending = client.startMicTest({ signal: controller.signal });
    const rejected = assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
    if (resolveFirst) requests[0]!.resolve(source.value);
    controller.abort(); await rejected;
    if (!resolveFirst) requests[0]!.resolve(source.value);
    await flush();
    assert.equal(source.track.stops, 1);
    assert.equal(Context.instances.length, 0);
    assert.equal(client['micTests'].size, 0);
    assert.equal(ready, 0);
  });

  it('handles a late permission rejection after cancellation without an unhandled rejection', async () => {
    const controller = new AbortController();
    const pending = client.startMicTest({ signal: controller.signal });
    const rejected = assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
    controller.abort(); await rejected;
    requests[0]!.reject(new Error('late permission rejection')); await flush();
    assert.equal(client['micTests'].size, 0);
  });

  it('stops an active preview on abort without touching the room microphone', async () => {
    const controller = new AbortController(), preview = stream(), room = stream();
    client['mic'] = room.value;
    const pending = client.startMicTest({ signal: controller.signal });
    requests[0]!.resolve(preview.value);
    const test = await pending;
    assert.equal(test.level(), 0.25);
    controller.abort(); test.stop();
    assert.equal(preview.track.stops, 1);
    assert.equal(Context.instances[0]!.closed, 1);
    assert.equal(room.track.stops, 0);
    assert.equal(test.level(), 0);
    assert.equal(client['micTests'].size, 0);
  });

  it('removes its abort listener on manual stop and keeps stop idempotent', async t => {
    const controller = new AbortController(), source = stream();
    const added = t.mock.method(controller.signal, 'addEventListener');
    const removed = t.mock.method(controller.signal, 'removeEventListener');
    const pending = client.startMicTest({ signal: controller.signal });
    requests[0]!.resolve(source.value);
    const test = await pending;
    const activeListener = added.mock.calls.at(-1)!.arguments[1];
    test.stop(); test.stop();
    assert.ok(removed.mock.calls.some(call => call.arguments[0] === 'abort' && call.arguments[1] === activeListener));
    controller.abort();
    assert.equal(source.track.stops, 1);
    assert.equal(Context.instances[0]!.closed, 1);
  });

  it('removes acquisition listeners after a normal permission failure', async t => {
    const controller = new AbortController(), reason = new DOMException('denied', 'NotAllowedError');
    const added = t.mock.method(controller.signal, 'addEventListener');
    const removed = t.mock.method(controller.signal, 'removeEventListener');
    const pending = client.startMicTest({ signal: controller.signal });
    requests[0]!.reject(reason);
    await assert.rejects(pending, error => error === reason);
    const listener = added.mock.calls[0]!.arguments[1];
    assert.ok(removed.mock.calls.some(call => call.arguments[1] === listener));
    controller.abort();
    assert.equal(Context.instances.length, 0);
  });

  it('retains successful no-option usage', async () => {
    const source = stream();
    const pending = client.startMicTest();
    requests[0]!.resolve(source.value);
    const test = await pending;
    assert.equal(test.level(), 0.25);
    test.stop(); test.stop();
    assert.equal(source.track.stops, 1);
    assert.equal(client['micTests'].size, 0);
  });

  it('rejects if a ready-event listener aborts before the preview promise settles', async () => {
    const controller = new AbortController(), source = stream();
    client.on('micready', () => controller.abort());
    const pending = client.startMicTest({ signal: controller.signal });
    requests[0]!.resolve(source.value);
    await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(source.track.stops, 1);
    assert.equal(Context.instances[0]!.closed, 1);
    assert.equal(client['micTests'].size, 0);
  });

  it('preserves no-option behavior and disconnect cancellation', async () => {
    const source = stream();
    const pending = client.startMicTest();
    await client.disconnect();
    requests[0]!.resolve(source.value);
    await assert.rejects(pending, error => error instanceof StageError && error.code === 'disconnected');
    assert.equal(source.track.stops, 1);
    assert.equal(Context.instances.length, 0);
  });

  it('cancels one of two previews independently', async () => {
    const first = new AbortController(), second = new AbortController();
    const a = stream(), b = stream();
    const one = client.startMicTest({ signal: first.signal }), two = client.startMicTest({ signal: second.signal });
    requests[0]!.resolve(a.value); requests[1]!.resolve(b.value);
    await one; const remaining = await two;
    first.abort();
    assert.equal(a.track.stops, 1); assert.equal(b.track.stops, 0);
    assert.equal(client['micTests'].size, 1);
    remaining.stop(); assert.equal(b.track.stops, 1);
  });

  it('cleans up if abort happens while the audio meter is being created', async () => {
    const controller = new AbortController(), source = stream();
    Context.onCreate = () => controller.abort();
    const pending = client.startMicTest({ signal: controller.signal });
    requests[0]!.resolve(source.value);
    await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(source.track.stops, 1);
    assert.equal(Context.instances[0]!.closed, 1);
    assert.equal(client['micTests'].size, 0);
  });
});
