import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp, SamplePreview } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import type { RoomStatePayload } from '../shared/protocol.ts';

type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'find' | 'id' | 'clock'>;
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
function cancel(h: View, available: boolean): SampleNode {
  const node = h.id('mic-test-cancel');
  assert.equal(node.tagName, 'button'); assert.equal(node.type, 'button');
  assert.equal(node.textContent, '取消麥克風測試');
  assert.equal(node.hidden, !available); assert.equal(node.disabled, !available);
  return node;
}
function locked(h: View, value: boolean): void {
  assert.equal(h.id('mic-test').disabled, value);
  assert.equal(h.id('microphone-device').disabled, value);
}
function change(h: View, id: string): void {
  const node = h.id('microphone-device'); assert.ok(node.onchange); node.value = id; node.onchange();
}
function fakeSetup(t: TestContext) {
  const h = sampleApp(); t.after(() => h.cleanup()); return h;
}

it('whole sample preview cancellation is hidden and inert when idle, after success, and after stop', async t => {
  const h = fakeSetup(t); await flushSample();
  const idle = cancel(h, false); assert.ok(idle.onclick); idle.onclick();
  assert.equal(h.sdk.previews.length, 0); assert.equal(h.clock.jobs.size, 0);
  h.id('mic-test').click(); cancel(h, true); locked(h, true);
  const preview = new SamplePreview(0.25); h.sdk.grantPreview(h.sdk.previews[0]!, preview); await flushSample();
  cancel(h, false); locked(h, false); assert.equal(h.id('mic-test').textContent, '停止測試');
  idle.onclick(); assert.equal(preview.stops, 0);
  h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25);
  h.id('mic-test').click(); await flushSample();
  assert.equal(preview.stops, 1); cancel(h, false); assert.equal(h.clock.jobs.size, 0);
});

it('whole sample revokes pending preview cancellation before synchronous abort listeners can reenter', async t => {
  const h = fakeSetup(t); await flushSample();
  h.id('mic-test').click(); const button = cancel(h, true); assert.ok(button.onclick);
  const callback = button.onclick, signal = h.sdk.previewSignals[0]; assert.ok(signal);
  let aborts = 0;
  signal.addEventListener('abort', () => {
    aborts++; cancel(h, false); locked(h, true); callback();
    assert.ok(h.id('mic-test').onclick); h.id('mic-test').onclick!(); change(h, 'ignored');
    h.sdk.emit('error', { message: '另一項操作失敗。' });
  }, { once: true });
  button.click(); assert.equal(signal.aborted, true); assert.equal(aborts, 1);
  assert.equal(h.sdk.previews[0]!.status, 'rejected'); cancel(h, false);
  assert.equal(h.sdk.previews.length, 1); assert.deepEqual(h.sdk.inputDevices, []);
  await flushSample(); locked(h, false); cancel(h, false);
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '另一項操作失敗。');
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  h.id('mic-test').click(); cancel(h, true); assert.equal(h.sdk.previews.length, 2);
  h.sdk.previews[1]!.reject(new Error('重試遭拒絕。')); await flushSample();
  cancel(h, false); locked(h, false); assert.equal(errorBox(h).textContent, '重試遭拒絕。');
});

for (const name of ['NotAllowedError', 'NotFoundError', 'AbortError']) {
  it(`whole sample retains an ordinary ${name} preview failure when the user did not cancel`, async t => {
    const h = fakeSetup(t); h.id('mic-test').click(); cancel(h, true);
    h.sdk.previews[0]!.reject(Object.assign(new Error(`正常失敗：${name}`), { name })); await flushSample();
    cancel(h, false); locked(h, false);
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, `正常失敗：${name}`);
    assert.equal(h.sdk.previewSignals[0]!.aborted, false); assert.equal(h.clock.jobs.size, 0);
  });
}

for (const outcome of ['fulfill', 'reject'] as const) {
  it(`whole sample does not offer preview cancellation during setInputDevice ${outcome}`, async t => {
    const h = fakeSetup(t), selected = new Deferred<void>();
    t.after(() => { if (selected.status === 'pending') selected.resolve(undefined); });
    t.mock.method(h.sdk, 'setInputDevice', (id: string) => { h.sdk.inputDevices.push(id); return selected.promise; });
    h.id('mic-test').click(); const preview = new SamplePreview(0.4);
    h.sdk.grantPreview(h.sdk.previews[0]!, preview); await flushSample();
    change(h, 'mic-next'); cancel(h, false); locked(h, true);
    const callback = cancel(h, false).onclick; assert.ok(callback); callback();
    assert.equal(selected.status, 'pending'); assert.equal(preview.stops, 0); assert.equal(h.sdk.previews.length, 1);
    h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.4);
    if (outcome === 'reject') {
      selected.reject(new Error('切換裝置失敗。')); await flushSample();
      cancel(h, false); locked(h, false); assert.equal(preview.stops, 0);
      assert.equal(errorBox(h).textContent, '切換裝置失敗。'); assert.equal(h.id('microphone-device').value, '');
    } else {
      selected.resolve(undefined); await flushSample();
      assert.equal(preview.stops, 1); assert.equal(h.sdk.previews.length, 2); locked(h, true);
      cancel(h, true).click(); await flushSample();
      cancel(h, false); locked(h, false); assert.equal(h.id('microphone-device').value, 'mic-next');
      assert.equal(h.id('mic-test').textContent, '測試麥克風'); assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
      assert.equal(h.id('mic-level').value, 0); assert.equal(h.clock.jobs.size, 0); assert.equal(errorBox(h).hidden, true);
      h.id('mic-test').click(); const retry = new SamplePreview(0.3);
      h.sdk.grantPreview(h.sdk.previews[2]!, retry); await flushSample();
      assert.equal(h.id('mic-test').textContent, '停止測試'); cancel(h, false);
    }
    assert.deepEqual(h.sdk.inputDevices, ['mic-next']);
  });
}

it('whole sample device selection without an active preview never exposes cancellation or requests a capture', async t => {
  const h = fakeSetup(t), selected = new Deferred<void>();
  t.after(() => { if (selected.status === 'pending') selected.resolve(undefined); });
  t.mock.method(h.sdk, 'setInputDevice', () => selected.promise);
  change(h, 'mic-next'); cancel(h, false); locked(h, true);
  selected.resolve(undefined); await flushSample(); cancel(h, false); locked(h, false);
  assert.equal(h.sdk.previews.length, 0); assert.equal(h.id('microphone-device').value, 'mic-next');
});

interface Stream { getTracks(): Track[]; getAudioTracks(): Track[] }
interface Track { enabled: boolean; stops: number; stop(): void }
function stream(): { value: Stream; track: Track } {
  const track = { enabled: true, stops: 0, stop() { this.stops++; } };
  return { track, value: { getTracks: () => [track], getAudioTracks: () => [track] } };
}
class Context {
  static instances: Context[] = [];
  closes = 0; sourceDisconnects = 0; analyserDisconnects = 0;
  constructor() { Context.instances.push(this); }
  createMediaStreamSource() { return { connect() {}, disconnect: () => { this.sourceDisconnects++; } }; }
  createAnalyser() { return { fftSize: 0, getFloatTimeDomainData(samples: Float32Array) { samples.fill(0.25); },
    disconnect: () => { this.analyserDisconnects++; } }; }
  async resume(): Promise<void> {}
  async close(): Promise<void> { this.closes++; }
}
interface IntegratedClient {
  readonly state: RoomStatePayload | null;
  readonly status: string;
  readonly playbackVolume: number;
  readonly playbackMuted: boolean;
  disconnect(): Promise<void>;
  dispatchEvent(event: Event): boolean;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
async function integratedSetup(t: TestContext) {
  // Execute the actual SDK without importing DOM types into the server-test type graph.
  // State transitions are seeded; capture ownership, stream disposal and meters execute unchanged.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const originals = new Map(['window', 'navigator', 'AudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests: { work: Deferred<Stream>; constraints: unknown }[] = [];
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia(constraints: unknown) { const work = new Deferred<Stream>(); requests.push({ work, constraints }); return work.promise; },
    async enumerateDevices() { return [{ kind: 'audioinput', deviceId: 'mic-next', label: '下一支麥克風' }]; },
  } } });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context }); Context.instances = [];
  const listening = {}, audio = { volume: 0.37, muted: true, srcObject: listening as unknown, pauses: 0, pause() { this.pauses++; } };
  const sdk: IntegratedClient = new StageClient({ url: 'ws://localhost/ws', audioElement: audio });
  const h = sampleApp({ sdk }); let ready = 0;
  sdk.on('micready', () => { ready++; });
  t.after(async () => {
    try {
      await h.cleanup();
      for (const { work } of requests) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
      await flushSample();
      assert.ok(Context.instances.every(context => context.closes === 1));
      assert.equal(getEventListeners(target, 'pagehide').length, 0);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return {
    ...h, requests, audio, listening, ready: () => ready,
    snapshot(state: RoomStatePayload): void {
      Object.assign(sdk, { snapshot: state, currentStatus: state.status });
      sdk.dispatchEvent(new CustomEvent('state', { detail: state }));
    },
  };
}

for (const path of ['direct', 'device-restart'] as const) {
  for (const outcome of ['late-grant', 'late-denial', 'grant-before-cancel'] as const) {
    it(`whole sample and actual StageClient cancel ${path} capture with ${outcome}, preserve listening, and permit retry`, async t => {
      const h = await integratedSetup(t); await flushSample();
      const roomMic = stream(); Object.assign(h.sdk, { mic: roomMic.value });
      h.id('mic-test').click(); let pending = h.requests[0]!;
      if (path === 'device-restart') {
        const first = stream(); pending.work.resolve(first.value); await flushSample();
        assert.equal(h.ready(), 1); cancel(h, false); change(h, 'mic-next'); await flushSample();
        assert.equal(first.track.stops, 1); pending = h.requests[1]!;
        assert.deepEqual(pending.constraints, { audio: { channelCount: 1, sampleRate: 48000,
          echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'mic-next' } } });
      }
      const retired = stream(), contexts = Context.instances.length, ready = h.ready();
      if (outcome === 'grant-before-cancel') pending.work.resolve(retired.value);
      cancel(h, true).click(); cancel(h, false); await flushSample(); locked(h, false);
      assert.equal(errorBox(h).hidden, true); assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
      assert.equal(roomMic.track.stops, 0); assert.equal(roomMic.track.enabled, true);
      assert.equal(h.audio.srcObject, h.listening); assert.equal(h.audio.pauses, 0);
      assert.equal(h.sdk.playbackVolume, 0.37); assert.equal(h.sdk.playbackMuted, true);
      h.id('mic-test').click(); const replacement = h.requests.at(-1)!; cancel(h, true); locked(h, true);
      if (outcome === 'late-grant') pending.work.resolve(retired.value);
      if (outcome === 'late-denial') pending.work.reject(new Error('已取消的權限遭拒。'));
      await flushSample(); cancel(h, true); locked(h, true);
      assert.equal(retired.track.stops, outcome === 'late-denial' ? 0 : 1);
      assert.equal(Context.instances.length, contexts); assert.equal(h.ready(), ready); assert.equal(errorBox(h).hidden, true);
      const current = stream(); replacement.work.resolve(current.value); await flushSample();
      cancel(h, false); locked(h, false); assert.equal(current.track.stops, 0);
      h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25);
      h.id('mic-test').click(); await flushSample(); assert.equal(current.track.stops, 1);
      const meter = Context.instances.at(-1)!;
      assert.equal(meter.closes, 1); assert.equal(meter.sourceDisconnects, 1); assert.equal(meter.analyserDisconnects, 1);
      assert.equal(h.clock.jobs.size, 0); assert.equal(roomMic.track.stops, 0); assert.equal(h.audio.pauses, 0);
    });
  }
}

for (const transition of ['leave-rejoin', 'onstage'] as const) {
  it(`whole sample and actual StageClient retire held permission on ${transition} without reviving it in the next preview`, async t => {
    const h = await integratedSetup(t); h.snapshot(roomState()); await flushSample();
    h.id('mic-test').click(); cancel(h, true); const pending = h.requests[0]!;
    if (transition === 'leave-rejoin') {
      h.app.descendants().find(node => node.tagName === 'button' && node.textContent === '離開房間')!.click();
      assert.equal(h.sdk.state, null); cancel(h, false); h.snapshot(roomState());
    } else {
      const roomMic = stream(); Object.assign(h.sdk, { mic: roomMic.value });
      h.snapshot(roomState({ role: 'speaker', onStage: true })); cancel(h, false);
      await flushSample(); assert.equal(h.id('mic-test').disabled, true);
      assert.equal(h.id('microphone-device').disabled, false); assert.equal(roomMic.track.stops, 0);
      assert.equal(h.audio.pauses, 0); assert.equal(h.audio.srcObject, h.listening);
      h.snapshot(roomState());
    }
    await flushSample(); locked(h, false); assert.equal(errorBox(h).hidden, true);
    h.id('mic-test').click(); cancel(h, true); locked(h, true);
    const old = stream(); pending.work.resolve(old.value); await flushSample();
    assert.equal(old.track.stops, 1); assert.equal(Context.instances.length, 0); assert.equal(h.ready(), 0);
    cancel(h, true); locked(h, true); assert.equal(errorBox(h).hidden, true);
    const current = stream(); h.requests[1]!.work.resolve(current.value); await flushSample();
    cancel(h, false); locked(h, false); assert.equal(current.track.stops, 0);
    h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25);
  });
}

it('whole sample disposes a canceled fulfillment even when a preview provider ignores its abort signal', async t => {
  const h = fakeSetup(t), work = new Deferred<SamplePreview>();
  t.after(() => { if (work.status === 'pending') work.reject(new Error('fixture cleanup')); });
  let signal: AbortSignal | undefined;
  t.mock.method(h.sdk, 'startMicTest', (options: { signal?: AbortSignal } = {}) => { signal = options.signal; return work.promise; });
  h.id('mic-test').click(); cancel(h, true).click(); assert.equal(signal?.aborted, true);
  await flushSample(); cancel(h, false); locked(h, true);
  h.sdk.emit('error', { message: '保留另一項操作的錯誤。' });
  const ignored = new SamplePreview(0.7); work.resolve(ignored); await flushSample();
  assert.equal(ignored.stops, 1); cancel(h, false); locked(h, false);
  assert.equal(h.id('mic-test').textContent, '測試麥克風'); assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
  assert.equal(h.id('mic-level').value, 0); assert.equal(h.clock.jobs.size, 0);
  assert.equal(errorBox(h).textContent, '保留另一項操作的錯誤。'); assert.equal(errorBox(h).hidden, false);
});

for (const action of ['cancel', 'onstage'] as const) {
  it(`whole sample and actual StageClient dispose a preview when micready reenters ${action}`, async t => {
    const h = await integratedSetup(t); let called = false;
    h.sdk.on('micready', () => {
      if (called) return;
      called = true; cancel(h, true);
      if (action === 'cancel') cancel(h, true).click();
      else h.snapshot(roomState({ role: 'speaker', onStage: true }));
      cancel(h, false);
    });
    h.id('mic-test').click(); cancel(h, true);
    const retired = stream(); h.requests[0]!.work.resolve(retired.value); await flushSample();
    assert.equal(called, true); assert.equal(retired.track.stops, 1); assert.equal(Context.instances.length, 1);
    assert.equal(Context.instances[0]!.closes, 1); assert.equal(errorBox(h).hidden, true);
    assert.equal(h.id('mic-test').textContent, '測試麥克風'); assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
    if (action === 'onstage') { assert.equal(h.id('mic-test').disabled, true); h.snapshot(roomState()); }
    locked(h, false); h.id('mic-test').click(); cancel(h, true);
    const current = stream(); h.requests[1]!.work.resolve(current.value); await flushSample();
    const inactive = cancel(h, false); assert.ok(inactive.onclick); inactive.onclick(); await flushSample();
    assert.equal(current.track.stops, 0); assert.equal(Context.instances[1]!.closes, 0);
    h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25);
    assert.equal(h.audio.pauses, 0); assert.equal(h.audio.srcObject, h.listening);
  });
}
