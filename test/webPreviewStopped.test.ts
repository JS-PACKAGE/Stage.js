import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { actualApp, actualState, StageContext, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { Deferred, flushSample, sampleApp } from './fixtures/sampleApp.ts';

interface Preview { readonly stopped?: boolean; level(): number; stop(): void }
interface ActualClient {
  readonly state: RoomStatePayload | null;
  readonly me: ParticipantView | null;
  readonly status: string;
  readonly playbackVolume: number;
  readonly playbackMuted: boolean;
  disconnect(): Promise<void>;
  retryMicrophone(): boolean;
  startMicTest(options?: { signal?: AbortSignal }): Promise<Preview>;
  setInputDevice(id: string): Promise<void>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'id' | 'find' | 'clock'>;
type Track = ReturnType<Awaited<ReturnType<typeof actualApp>>['captures'][number]['resolve']>;
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
function idle(h: View): void {
  assert.equal(h.id('mic-test').textContent, '測試麥克風');
  assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
  assert.equal(h.id('mic-test').disabled, false); assert.equal(h.id('microphone-device').disabled, false);
  assert.equal(h.id('mic-test-cancel').hidden, true); assert.equal(h.id('mic-test-cancel').disabled, true);
  assert.equal(h.id('mic-level').value, 0); assert.equal(h.clock.intervals(50).length, 0);
}
function active(h: View): void {
  assert.equal(h.id('mic-test').textContent, '停止測試');
  assert.equal(h.id('mic-test').attributes['aria-pressed'], 'true');
  assert.equal(h.id('mic-test').disabled, false); assert.equal(h.id('microphone-device').disabled, false);
  assert.equal(h.id('mic-test-cancel').hidden, true); assert.equal(h.clock.intervals(50).length, 1);
}
function pending(h: View): void {
  assert.equal(h.id('mic-test').disabled, true); assert.equal(h.id('microphone-device').disabled, true);
  assert.equal(h.id('mic-test-cancel').hidden, false); assert.equal(h.id('mic-test-cancel').disabled, false);
  assert.equal(h.clock.intervals(50).length, 0);
}
function meterCallback(h: View): () => void {
  const timers = h.clock.intervals(50); assert.equal(timers.length, 1); return h.clock.jobs.get(timers[0]!)!.callback;
}
function meterWrites(h: View): () => number {
  const meter = h.id('mic-level'); let value = meter.value, writes = 0;
  Object.defineProperty(meter, 'value', { configurable: true, get: () => value, set(next) { writes++; value = next; } });
  return () => writes;
}
function change(h: View, id: string): void {
  const select = h.id('microphone-device'); assert.ok(select.onchange); select.value = id; select.onchange();
}
function end(track: Track): void {
  track.readyState = 'ended'; (track as unknown as EventTarget).dispatchEvent(new Event('ended'));
}
interface Meter { reads: number; sources: number; analysers: number }
async function setup(t: TestContext) {
  // Reuse the socket/media boundary and run both the full sample and public SDK unchanged.
  // All timings below count application callbacks and DOM writes, not native audio or CPU.
  let cleanup = async (): Promise<void> => {};
  t.after(() => cleanup());
  const boundary = await actualApp(t, { deferCapture: true });
  const meters = new Map<StageContext, Meter>();
  t.mock.method(StageContext.prototype, 'createMediaStreamSource', function (this: StageContext) {
    const meter = { reads: 0, sources: 0, analysers: 0 }; meters.set(this, meter);
    return { connect() {}, disconnect() { meter.sources++; } };
  });
  t.mock.method(StageContext.prototype, 'createAnalyser', function (this: StageContext) {
    const meter = meters.get(this); assert.ok(meter);
    return { fftSize: 2048, getFloatTimeDomainData(samples: Float32Array) { meter.reads++; samples.fill(0.25); },
      disconnect() { meter.analysers++; } };
  });
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const sdk: ActualClient = new StageClient({ url: 'ws://localhost/ws', audioElement: boundary.audio });
  boundary.clients.push(sdk);
  const previews: { handle: Preview; reads: number }[] = [];
  const start = sdk.startMicTest.bind(sdk);
  t.mock.method(sdk, 'startMicTest', async (options?: { signal?: AbortSignal }) => {
    const handle = await start(options), entry = { handle, reads: 0 }, read = handle.level.bind(handle);
    t.mock.method(handle, 'level', () => { entry.reads++; return read(); }); previews.push(entry); return handle;
  });
  let ready = 0, micErrors = 0, stats = 0;
  sdk.on('micready', () => { ready++; }); sdk.on('micerror', () => { micErrors++; });
  const h = sampleApp({ sdk }); cleanup = () => h.cleanup();
  await flushSample();
  return { ...h, boundary, previews, meters, ready: () => ready, micErrors: () => micErrors, stats: () => stats,
    async join() {
      const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
      for (const [name, value] of Object.entries({ roomId: 'same-room', name: '測試聽眾' })) {
        const input = form.descendants().find(node => node.name === name); assert.ok(input); input.value = value;
      }
      form.submit(); await flushSample(); const socket = StageSocket.instances.at(-1)!;
      socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
      await boundary.until(() => socket.sent.some(message => message.type === 'join'), 'public SDK join request');
      const request = socket.sent.find(message => message.type === 'join')!;
      const state = { ...actualState({ role: 'audience' }), controllerId: 'host', audienceCount: 1 };
      socket.deliver({ type: 'room:state', ...state }); socket.deliver({ type: 'ok', requestId: request.requestId });
      const peer = StagePeer.instances.at(-1)!;
      Object.assign(peer, { async getStats() { stats++; return new Map(); } });
      await boundary.until(() => peer.localDescription !== null && peer.signalingState === 'stable', 'public SDK listening negotiation');
      const listening = { getTracks: () => [], getAudioTracks: () => [] };
      assert.ok(peer.ontrack); peer.ontrack({ streams: [listening] }); await flushSample();
      return { socket, peer, listening, state: sdk.state, pauses: boundary.audio.pauses };
    },
  };
}
type App = Awaited<ReturnType<typeof setup>>;
async function grant(h: App): Promise<Track> {
  const capture = h.boundary.captures.at(-1); assert.ok(capture); assert.equal(capture.settled, false);
  const track = capture.resolve(); await flushSample(); return track;
}
async function preview(h: App): Promise<Track> { h.id('mic-test').click(); pending(h); return grant(h); }
function disposed(h: App, track: Track, index: number, stops = 1): void {
  const context = StageContext.instances[index]; assert.ok(context);
  const meter = h.meters.get(context); assert.ok(meter);
  assert.equal(track.stops, stops); assert.equal(context.closes, 1);
  assert.equal(meter.sources, 1); assert.equal(meter.analysers, 1);
  assert.equal(getEventListeners(track as unknown as EventTarget, 'ended').length, 0);
  assert.equal(h.previews[index]!.handle.stopped, true);
}

for (const inRoom of [false, true]) {
  it(`whole sample and public SDK retire naturally ended ${inRoom ? 'room' : 'landing'} preview on one tick and do no later 10-second meter work`, async t => {
    const h = await setup(t), room = inRoom ? await h.join() : null;
    const track = await preview(h), callback = meterCallback(h), statsTimers = h.clock.intervals(2000);
    active(h); h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25);
    assert.equal(h.previews[0]!.reads, 1); const meter = h.meters.get(StageContext.instances[0]!)!;
    assert.equal(meter.reads, 1); end(track); disposed(h, track, 0);
    assert.equal(h.id('mic-test').textContent, '停止測試', 'no new SDK event or extra reconciliation timer is required');
    h.clock.advance(49); assert.equal(h.previews[0]!.reads, 1);
    const transitionWrites = meterWrites(h); h.clock.advance(1); idle(h);
    assert.equal(transitionWrites(), 1, 'the retiring tick only zeros the meter');
    const writes = meterWrites(h), fired = h.clock.fired.length, polls = h.stats();
    h.clock.advance(10_000); await flushSample(); callback();
    assert.equal(writes(), 0); assert.equal(h.previews[0]!.reads, 1); assert.equal(meter.reads, 1);
    assert.equal(h.clock.fired.length - fired, inRoom ? 5 : 0); assert.equal(h.stats() - polls, inRoom ? 5 : 0);
    assert.deepEqual(h.clock.intervals(2000), statsTimers); assert.equal(h.boundary.captures.length, 1);
    assert.equal(h.ready(), 1); assert.equal(h.micErrors(), 0); assert.equal(errorBox(h).hidden, true);
    if (room) {
      assert.equal(h.sdk.state, room.state); assert.equal(room.peer.connectionState, 'connected');
      assert.equal(room.peer.transceiver.sender.track, null); assert.equal(room.socket.readyState, StageSocket.OPEN);
      assert.equal(h.boundary.audio.srcObject, room.listening); assert.equal(h.boundary.audio.pauses, room.pauses);
    }
    assert.equal(h.sdk.playbackVolume, 0.37); assert.equal(h.sdk.playbackMuted, true);
    h.id('mic-test').click(); pending(h); assert.equal(h.boundary.captures.length, 2);
    const current = await grant(h); active(h); callback(); assert.equal(h.previews[1]!.reads, 0);
    h.clock.advance(50); assert.equal(h.previews[1]!.reads, 1); assert.equal(h.id('mic-level').value, 0.25);
    h.id('mic-test').click(); await flushSample(); idle(h); disposed(h, current, 1); disposed(h, track, 0);
  });

  it(`whole sample starts a fresh ${inRoom ? 'room' : 'landing'} preview with one click before the old ended preview's next tick`, async t => {
    const h = await setup(t); if (inRoom) await h.join();
    const track = await preview(h), old = meterCallback(h); h.clock.advance(50); end(track);
    const time = h.clock.now; h.id('mic-test').click(); pending(h);
    assert.equal(h.clock.now, time); assert.equal(h.boundary.captures.length, 2); disposed(h, track, 0);
    const writes = meterWrites(h); old(); assert.equal(writes(), 0);
    const current = await grant(h); active(h); old(); assert.equal(h.previews[1]!.reads, 0);
    assert.equal(current.stops, 0); h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25);
  });

  it(`whole sample reconciles a hidden ended ${inRoom ? 'room' : 'landing'} preview on return without restarting capture or polling`, async t => {
    const h = await setup(t); if (inRoom) await h.join();
    const track = await preview(h), beforeHide = meterCallback(h); h.clock.advance(50);
    h.setHidden(true); assert.equal(track.stops, 0); assert.equal(h.clock.jobs.size, 0);
    end(track); disposed(h, track, 0); const writes = meterWrites(h); beforeHide(); h.clock.advance(10_000);
    assert.equal(writes(), 0); assert.equal(h.boundary.captures.length, 1); assert.equal(h.stats(), 0);
    h.setHidden(false); idle(h); assert.equal(h.clock.intervals(2000).length, inRoom ? 1 : 0);
    assert.equal(h.stats(), inRoom ? 1 : 0); assert.equal(h.boundary.captures.length, 1);
    for (let i = 0; i < 3; i++) h.setHidden(false);
    assert.equal(h.clock.intervals(50).length, 0); assert.equal(h.previews[0]!.reads, 1);
    const current = await preview(h); active(h); const resumed = meterCallback(h);
    beforeHide(); assert.equal(h.previews[1]!.reads, 0); resumed(); assert.equal(h.previews[1]!.reads, 1);
    assert.equal(current.stops, 0); assert.equal(h.boundary.captures.length, 2);
  });
}

for (const method of ['ended-event', 'track-stop'] as const) {
  it(`whole sample never activates a preview retired by a micready listener using ${method}`, async t => {
    const h = await setup(t); let track: Track | undefined;
    const off = h.sdk.on('micready', () => { assert.ok(track); if (method === 'ended-event') end(track); else track.stop(); });
    h.id('mic-test').click(); pending(h); track = h.boundary.captures[0]!.resolve(); await flushSample(); off();
    idle(h); disposed(h, track, 0, method === 'track-stop' ? 2 : 1);
    assert.equal(h.ready(), 1); assert.equal(h.micErrors(), 0); assert.equal(errorBox(h).hidden, true);
    const writes = meterWrites(h); h.clock.advance(10_000);
    assert.equal(writes(), 0); assert.equal(h.previews[0]!.reads, 0); assert.equal(h.boundary.captures.length, 1);
    const current = await preview(h); active(h); assert.equal(current.stops, 0); assert.equal(h.ready(), 2);
  });
}

for (const notification of ['state', 'reconnecting-status'] as const) {
  it(`whole sample retires an ended preview on ${notification} before its tick and preserves an unrelated error`, async t => {
    const h = await setup(t), room = await h.join(), track = await preview(h), old = meterCallback(h);
    h.clock.advance(50);
    room.socket.deliver({ type: 'error', code: 'bad_request', message: '保留另一項操作的錯誤。' });
    end(track);
    if (notification === 'state') room.socket.deliver({ type: 'room:state', ...room.state! });
    else room.socket.close();
    idle(h); disposed(h, track, 0); const writes = meterWrites(h); old(); h.clock.advance(10_000);
    assert.equal(writes(), 0); assert.equal(h.previews[0]!.reads, 1); assert.equal(h.boundary.captures.length, 1);
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '保留另一項操作的錯誤。');
    assert.equal(h.boundary.audio.srcObject, room.listening); assert.equal(h.boundary.audio.pauses, room.pauses);
    assert.equal(room.peer.connectionState, 'connected'); assert.equal(h.sdk.me?.onStage, false);
    await flushSample();
  });
}

for (const outcome of ['fulfill', 'reject'] as const) {
  for (const tick of [false, true]) {
    it(`whole sample does not recapture a preview ended during device ${outcome}, ${tick ? 'after' : 'before'} a meter tick`, async t => {
      const h = await setup(t); await h.join(); const track = await preview(h), selected = new Deferred<void>();
      t.after(() => { if (selected.status === 'pending') selected.resolve(undefined); });
      const setInputDevice = h.sdk.setInputDevice.bind(h.sdk), devices: string[] = [];
      t.mock.method(h.sdk, 'setInputDevice', async (id: string) => { devices.push(id); await selected.promise; await setInputDevice(id); });
      change(h, 'mic-next'); assert.equal(h.id('mic-test').disabled, true);
      assert.equal(h.id('microphone-device').disabled, true); assert.equal(h.id('mic-test-cancel').hidden, true);
      end(track); if (tick) h.clock.advance(50);
      assert.equal(h.id('mic-test').disabled, true); assert.equal(h.id('microphone-device').disabled, true);
      assert.equal(h.boundary.captures.length, 1); disposed(h, track, 0);
      if (outcome === 'fulfill') selected.resolve(undefined); else selected.reject(new Error('切換裝置失敗。'));
      await flushSample(); idle(h); assert.deepEqual(devices, ['mic-next']); assert.equal(h.boundary.captures.length, 1);
      assert.equal(h.id('microphone-device').value, outcome === 'fulfill' ? 'mic-next' : '');
      assert.equal(errorBox(h).hidden, outcome === 'fulfill');
      if (outcome === 'reject') assert.equal(errorBox(h).textContent, '切換裝置失敗。');
      const writes = meterWrites(h); h.clock.advance(10_000); await flushSample(); assert.equal(writes(), 0);
      assert.equal(h.boundary.captures.length, 1); assert.equal(h.previews[0]!.reads, 0);
      h.id('mic-test').click(); pending(h); assert.equal(h.boundary.captures.length, 2);
      assert.deepEqual(h.boundary.captures[1]!.constraints, { audio: { channelCount: 1, sampleRate: 48000,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(outcome === 'fulfill' ? { deviceId: { exact: 'mic-next' } } : {}) } });
      await grant(h); active(h);
    });
  }
}

it('whole sample still replaces a healthy preview after successful device selection and keeps the replacement independently owned', async t => {
  const h = await setup(t), room = await h.join(), track = await preview(h), selected = new Deferred<void>();
  t.after(() => { if (selected.status === 'pending') selected.resolve(undefined); });
  const setInputDevice = h.sdk.setInputDevice.bind(h.sdk), old = meterCallback(h);
  t.mock.method(h.sdk, 'setInputDevice', async (id: string) => { await selected.promise; await setInputDevice(id); });
  change(h, 'mic-next'); h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25); assert.equal(track.stops, 0);
  selected.resolve(undefined); await flushSample(); pending(h); disposed(h, track, 0);
  assert.equal(h.boundary.captures.length, 2); assert.equal(h.boundary.audio.srcObject, room.listening);
  const replacement = await grant(h); active(h); old(); assert.equal(h.previews[1]!.reads, 0);
  assert.equal(replacement.stops, 0); assert.equal(h.id('microphone-device').value, 'mic-next');
  assert.deepEqual(h.boundary.captures[1]!.constraints, { audio: { channelCount: 1, sampleRate: 48000,
    echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'mic-next' } } });
  h.clock.advance(50); assert.equal(h.previews[1]!.reads, 1); assert.equal(h.boundary.audio.pauses, room.pauses);
});

for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
  it(`whole sample retains ordinary ${name} after retirement and still permits the next explicit retry`, async t => {
    const h = await setup(t), track = await preview(h); end(track); h.clock.advance(50); idle(h);
    h.id('mic-test').click(); pending(h);
    h.boundary.captures[1]!.reject(new DOMException(`正常重試失敗：${name}`, name)); await flushSample(); idle(h);
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, `正常重試失敗：${name}`);
    h.setHidden(true); h.setHidden(false); h.clock.advance(10_000);
    assert.equal(errorBox(h).hidden, false); assert.equal(h.boundary.captures.length, 2); assert.equal(h.ready(), 1);
    const current = await preview(h); active(h); assert.equal(current.stops, 0); assert.equal(h.ready(), 2);
  });
}

for (const late of ['grant', 'denial'] as const) {
  it(`whole sample keeps canceled retry ${late} separate from a newer preview after natural retirement`, async t => {
    const h = await setup(t), track = await preview(h), old = meterCallback(h); end(track); h.clock.advance(50); idle(h);
    h.id('mic-test').click(); pending(h); const canceled = h.boundary.captures[1]!;
    h.id('mic-test-cancel').click(); await flushSample(); idle(h);
    h.id('mic-test').click(); pending(h); const ready = h.ready(), contexts = StageContext.instances.length;
    if (late === 'grant') { const retired = canceled.resolve(); await flushSample(); assert.equal(retired.stops, 1); }
    else { canceled.reject(new DOMException('已取消的權限要求失敗。', 'NotAllowedError')); await flushSample(); }
    old(); pending(h); assert.equal(StageContext.instances.length, contexts); assert.equal(h.ready(), ready);
    assert.equal(errorBox(h).hidden, true); assert.equal(h.boundary.captures.length, 3);
    const current = await grant(h); active(h); old(); assert.equal(h.previews[1]!.reads, 0); assert.equal(current.stops, 0);
    h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25); disposed(h, track, 0);
  });
}

for (const settleOldFirst of [false, true]) {
  it(`whole sample isolates leave/rejoin generations after retirement when the ${settleOldFirst ? 'old' : 'new'} retry fulfills first`, async t => {
    const h = await setup(t); await h.join(); const track = await preview(h), old = meterCallback(h);
    end(track); h.id('mic-test').click(); pending(h); const abandoned = h.boundary.captures[1]!;
    h.button('離開房間').click(); await flushSample(); idle(h); assert.equal(h.sdk.state, null);
    await h.join(); h.id('mic-test').click(); pending(h); const latest = h.boundary.captures[2]!;
    let retired: Track, current: Track;
    if (settleOldFirst) {
      retired = abandoned.resolve(); await flushSample(); pending(h); old(); pending(h);
      current = latest.resolve(); await flushSample();
    } else {
      current = latest.resolve(); await flushSample(); active(h);
      retired = abandoned.resolve(); await flushSample(); old(); active(h);
    }
    assert.equal(retired.stops, 1); assert.equal(current.stops, 0); assert.equal(h.boundary.captures.length, 3);
    assert.equal(StageContext.instances.length, 2); assert.equal(h.previews.length, 2); assert.equal(h.ready(), 2);
    assert.equal(errorBox(h).hidden, true); h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25);
    disposed(h, track, 0);
  });
}

it('whole sample preserves legacy structural previews with no stopped property', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); let reads = 0, stops = 0;
  const legacy = { level() { reads++; return 0.3; }, stop() { stops++; } };
  t.mock.method(h.sdk, 'startMicTest', async () => legacy);
  assert.equal('stopped' in legacy, false); h.id('mic-test').click(); await flushSample(); active(h);
  const writes = meterWrites(h); h.clock.advance(10_000);
  assert.equal(reads, 200); assert.equal(writes(), 200); assert.equal(stops, 0);
  h.setHidden(true); h.setHidden(false); active(h); assert.equal(stops, 0);
  h.id('mic-test').click(); await flushSample(); idle(h); assert.equal(stops, 1);
});
