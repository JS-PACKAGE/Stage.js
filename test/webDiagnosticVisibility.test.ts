import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp, SampleNode, SamplePreview } from './fixtures/sampleApp.ts';

// The clock counts application work, not native browser throttling, CPU use, or real audio.
type App = ReturnType<typeof sampleApp>;
const stage = (muted = false, forceMuted = false) => roomState({ role: 'speaker', onStage: true, muted, forceMuted });
const connection = (h: Pick<App, 'find'>) => h.find(node => node.classList.contains('connection'));
const result = (rtt = 0.03, lossPercent = 2) => ({ inbound: { rtt, lossPercent, bufferMs: 20 }, outbound: null });
async function setup(t: TestContext, initialHidden = false): Promise<App> {
  const h = sampleApp({ initialHidden }); t.after(() => h.cleanup()); await flushSample(); return h;
}
async function grant(h: App, value = 0.4): Promise<SamplePreview> {
  h.id('mic-test').click(); const preview = new SamplePreview(value);
  h.sdk.grantPreview(h.sdk.previews.at(-1)!, preview); await flushSample(); return preview;
}
async function settle(h: App): Promise<void> {
  for (const poll of h.sdk.polls) if (poll.status === 'pending') poll.resolve(result());
  await flushSample();
}
function callbacks(h: App, delay: number): (() => void)[] {
  return h.clock.intervals(delay).map(id => h.clock.jobs.get(id)!.callback);
}
function meterWrites(h: App): () => number {
  const meter = h.id('mic-level'); let value = meter.value, writes = 0;
  Object.defineProperty(meter, 'value', { configurable: true, get: () => value, set(next) { writes++; value = next; } });
  return () => writes;
}
function lineWrites(h: App): () => number {
  const line = connection(h), descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!;
  let writes = 0;
  Object.defineProperty(line, 'textContent', { configurable: true, get() { return descriptor.get!.call(line); },
    set(value) { writes++; descriptor.set!.call(line, value); } });
  return () => writes;
}
function timers(h: App, meter: number, stats: number): void {
  assert.equal(h.clock.intervals(50).length, meter); assert.equal(h.clock.intervals(2000).length, stats);
}

for (const mode of ['stage', 'room-preview', 'landing-preview', 'muted', 'offstage'] as const) {
  for (const hidden of [false, true]) {
    it(`whole sample ${mode} ${hidden ? 'hidden' : 'visible'} has bounded 10-second diagnostic operation counts`, async t => {
      const h = await setup(t, hidden);
      if (mode !== 'landing-preview') h.sdk.snapshot(mode === 'stage' ? stage() : mode === 'muted' ? stage(true) : roomState());
      const preview = mode.endsWith('preview') ? await grant(h) : null;
      h.sdk.micLevelValue = 0.6;
      const writes = meterWrites(h), connections = mode === 'landing-preview' ? () => 0 : lineWrites(h);
      for (let i = 0; i < 5; i++) { h.clock.advance(2000); await settle(h); }
      const meterCount = !hidden && (mode === 'stage' || preview !== null) ? 200 : 0;
      const statsCount = !hidden && mode !== 'landing-preview' ? 5 : 0;
      assert.equal(h.sdk.micLevelReads, !hidden && mode === 'stage' ? 200 : 0);
      assert.equal(preview?.reads ?? 0, !hidden && preview ? 200 : 0);
      assert.equal(writes(), meterCount); assert.equal(h.sdk.polls.length, statsCount); assert.equal(connections(), statsCount);
      assert.equal(h.clock.fired.length, meterCount + statsCount);
      timers(h, meterCount ? 1 : 0, statsCount ? 1 : 0);
      assert.equal(preview?.stops ?? 0, 0); assert.equal(h.visibilityListeners.size, 1);
    });
  }
}

for (const inRoom of [false, true]) {
  it(`whole sample retains capture granted while hidden in ${inRoom ? 'a room' : 'landing'} and resumes its existing preview`, async t => {
    const h = await setup(t); if (inRoom) h.sdk.snapshot(roomState());
    h.id('mic-test').click(); const pending = h.sdk.previews[0]!, signal = h.sdk.previewSignals[0]!;
    h.setHidden(true); assert.equal(pending.status, 'pending'); assert.equal(signal.aborted, false);
    const preview = new SamplePreview(0.42); h.sdk.grantPreview(pending, preview); await flushSample();
    assert.equal(h.id('mic-test').textContent, '停止測試'); assert.equal(h.id('mic-test').disabled, false);
    assert.equal(h.id('mic-test-cancel').hidden, true); assert.equal(preview.stops, 0); assert.equal(h.sdk.activePreviews.size, 1);
    timers(h, 0, 0); h.clock.advance(10_000); assert.equal(preview.reads, 0);
    h.setHidden(false); timers(h, 1, inRoom ? 1 : 0); assert.equal(h.sdk.polls.length, inRoom ? 1 : 0);
    h.clock.advance(49); assert.equal(preview.reads, 0);
    h.clock.advance(1); assert.equal(h.id('mic-level').value, 0.42); assert.equal(preview.reads, 1);
    assert.equal(h.sdk.previews.length, 1); assert.equal(preview.stops, 0); assert.equal(signal.aborted, false);
  });
}

it('whole sample rejects already queued callbacks both before hidden notification and after replacement timers resume', async t => {
  const h = await setup(t); h.sdk.snapshot(stage()); h.sdk.micLevelValue = 0.8;
  const old = [...callbacks(h, 50), ...callbacks(h, 2000)]; assert.equal(old.length, 2);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 1);
  h.setHidden(true, false); for (const callback of old) callback();
  assert.equal(h.sdk.micLevelReads, 1); assert.equal(h.sdk.polls.length, 0);
  h.setHidden(true); timers(h, 0, 0); assert.equal(h.id('mic-level').value, 0);
  for (const callback of old) callback(); assert.equal(h.sdk.micLevelReads, 1); assert.equal(h.sdk.polls.length, 0);
  h.setHidden(false); timers(h, 1, 1); assert.equal(h.sdk.polls.length, 1, 'return requests stats before the next 2-second tick');
  for (const callback of old) callback(); assert.equal(h.sdk.micLevelReads, 1); assert.equal(h.sdk.polls.length, 1);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 2); await settle(h);
});

it('whole sample reconciles rapid and repeated visibility events without duplicating timers or changing media, playback, or session', async t => {
  const h = await setup(t); h.sdk.snapshot(roomState()); const preview = await grant(h), state = h.sdk.state;
  h.id('playback-mute').click(); await flushSample();
  h.id('playback-volume').value = '37'; h.id('playback-volume').oninput!();
  const retired: (() => void)[] = [];
  for (let i = 0; i < 25; i++) {
    retired.push(...callbacks(h, 50), ...callbacks(h, 2000));
    h.setHidden(true); h.setHidden(true); h.sdk.snapshot(state!); timers(h, 0, 0);
    h.setHidden(false); timers(h, 1, 1); const active = [...h.clock.jobs.keys()];
    h.setHidden(false); assert.deepEqual([...h.clock.jobs.keys()], active);
  }
  assert.equal(h.sdk.polls.length, 50, 'each visible notification requests fresh stats without adding intervals');
  for (const callback of retired) callback(); assert.equal(h.sdk.polls.length, 50); assert.equal(preview.reads, 0);
  assert.equal(h.sdk.state, state); assert.equal(h.sdk.status, 'waiting');
  assert.equal(h.sdk.playbackMuted, true); assert.equal(h.sdk.playbackVolume, 0.37);
  assert.equal(h.sdk.previews.length, 1); assert.equal(preview.stops, 0); assert.equal(h.sdk.activePreviews.size, 1);
  assert.deepEqual(h.sdk.inputDevices, []); assert.deepEqual(h.sdk.outputDevices, []); assert.deepEqual(h.sdk.joins, []);
  assert.equal(h.visibilityListeners.size, 1); await settle(h);
});

it('whole sample reconciles a visible notification after hidden state cleanup even if the hidden notification was missed', async t => {
  const h = await setup(t); h.sdk.snapshot(stage());
  const retired = [...callbacks(h, 50), ...callbacks(h, 2000)];
  h.setHidden(true, false); h.sdk.snapshot(stage()); timers(h, 0, 0);
  h.setHidden(false); timers(h, 1, 1); assert.equal(h.sdk.polls.length, 1);
  for (const callback of retired) callback();
  assert.equal(h.sdk.polls.length, 1); assert.equal(h.sdk.micLevelReads, 0);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 1);
});

for (const timing of ['hidden', 'returned', 'newer-result'] as const) {
  for (const outcome of ['poor', 'empty', 'reject'] as const) {
    it(`whole sample discards pre-hide stats ${outcome} settling ${timing}`, async t => {
      const h = await setup(t); h.sdk.snapshot(stage()); h.clock.advance(2000); const old = h.sdk.polls[0]!;
      h.setHidden(true); assert.equal(connection(h).textContent, '');
      if (timing !== 'hidden') h.setHidden(false);
      if (timing === 'newer-result') { h.sdk.polls[1]!.resolve(result(0.02, 0)); await flushSample(); }
      if (outcome === 'reject') old.reject(new Error('retired stats failed'));
      else old.resolve(outcome === 'empty' ? { inbound: null, outbound: null } : result(0.9, 80));
      await flushSample();
      if (timing === 'newer-result') assert.match(connection(h).textContent, /20 ms/);
      else assert.equal(connection(h).textContent, '');
      assert.equal(connection(h).classList.contains('error'), false);
      if (timing === 'hidden') h.setHidden(false);
      h.clock.advance(2000); h.sdk.polls.at(-1)!.resolve(result(0.04, 8)); await flushSample();
      assert.match(connection(h).textContent, /40 ms/); assert.equal(connection(h).classList.contains('error'), true);
      timers(h, 1, 1);
    });
  }
}

it('whole sample recovers on the next visible interval after the immediate resumed poll rejects', async t => {
  const h = await setup(t); h.sdk.snapshot(roomState()); h.setHidden(true); h.setHidden(false);
  h.sdk.polls[0]!.reject(new Error('current peer stats unavailable')); await flushSample(); timers(h, 0, 1);
  h.clock.advance(2000); h.sdk.polls[1]!.resolve(result(0.015, 0)); await flushSample();
  assert.match(connection(h).textContent, /15 ms/); assert.equal(connection(h).classList.contains('error'), false);
});

for (const forceMuted of [false, true]) {
  it(`whole sample still disposes a preview on hidden ${forceMuted ? 'force-muted' : 'muted'} stage entry`, async t => {
    const h = await setup(t); h.sdk.snapshot(roomState()); const preview = await grant(h);
    h.setHidden(true); h.sdk.snapshot(stage(true, forceMuted));
    assert.equal(preview.stops, 1); assert.equal(h.sdk.activePreviews.size, 0);
    assert.equal(h.id('mic-test').disabled, true); assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
    h.setHidden(false); timers(h, 0, 1); assert.equal(preview.reads, 0);
    h.setHidden(true); h.sdk.snapshot(stage()); timers(h, 0, 0); h.setHidden(false); timers(h, 1, 1);
    h.sdk.micLevelValue = 0.5; h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 1); assert.equal(preview.reads, 0);
    h.setHidden(true); h.sdk.snapshot(roomState()); h.setHidden(false); timers(h, 0, 1);
    assert.equal(h.id('mic-level').value, 0); assert.equal(h.id('mic-test').disabled, false);
  });
}

for (const action of ['stage-entry', 'cancel'] as const) {
  it(`whole sample still cancels pending preview on ${action} while hidden`, async t => {
    const h = await setup(t); h.sdk.snapshot(roomState()); h.id('mic-test').click();
    const pending = h.sdk.previews[0]!, signal = h.sdk.previewSignals[0]!;
    h.setHidden(true);
    if (action === 'stage-entry') h.sdk.snapshot(stage()); else h.id('mic-test-cancel').click();
    await flushSample(); assert.equal(signal.aborted, true); assert.equal(pending.status, 'rejected');
    assert.equal(h.id('mic-test-cancel').hidden, true); timers(h, 0, 0);
    h.setHidden(false); timers(h, action === 'stage-entry' ? 1 : 0, 1);
    assert.equal(h.sdk.previews.length, 1); assert.equal(h.id('mic-test').disabled, action === 'stage-entry');
  });
}

for (const terminal of ['closed', 'kicked'] as const) {
  it(`whole sample retires callbacks and preview during hidden ${terminal} and keeps its page listener`, async t => {
    const h = await setup(t); h.sdk.snapshot(roomState()); const preview = await grant(h);
    const retired = [...callbacks(h, 50), ...callbacks(h, 2000)];
    h.clock.advance(2000); const pending = h.sdk.polls[0]!; h.setHidden(true);
    await h.sdk.terminal(terminal, terminal === 'closed' ? 'shutdown' : undefined); await flushSample();
    assert.equal(preview.stops, 1); assert.equal(h.sdk.state, null); assert.equal(h.id('mic-level').value, 0); timers(h, 0, 0);
    h.setHidden(false); for (const callback of retired) callback();
    pending.resolve(result(0.8, 70)); await flushSample(); timers(h, 0, 0); assert.equal(h.sdk.polls.length, 1);
    assert.equal(h.visibilityListeners.size, 1);
    assert.match(h.find(node => node.classList.contains('notices')).textContent, terminal === 'closed' ? /伺服器維護/ : /移出/);
    const replacement = await grant(h, 0.2); timers(h, 1, 0); h.clock.advance(50);
    assert.equal(replacement.reads, 1); assert.equal(h.id('mic-level').value, 0.2);
    h.setHidden(true); timers(h, 0, 0); assert.equal(replacement.stops, 0);
  });
}

it('whole sample isolates hidden leave and same-identity rejoin from all old diagnostic work', async t => {
  const h = await setup(t); h.sdk.snapshot(stage()); h.clock.advance(2000);
  const old = h.sdk.polls[0]!, oldLine = connection(h), retired = [...callbacks(h, 50), ...callbacks(h, 2000)];
  h.setHidden(true); h.button('離開房間').click(); await flushSample();
  assert.equal(h.sdk.state, null); timers(h, 0, 0); assert.equal(oldLine.isConnected, false);
  h.sdk.snapshot(stage()); timers(h, 0, 0); h.setHidden(false); timers(h, 1, 1);
  h.sdk.polls[1]!.resolve(result(0.01, 0)); await flushSample();
  old.resolve(result(0.9, 80)); for (const callback of retired) callback(); await flushSample();
  assert.match(connection(h).textContent, /10 ms/); assert.equal(h.sdk.polls.length, 2);
  assert.equal(h.sdk.micLevelReads, 40); assert.equal(h.visibilityListeners.size, 1);
});

it('whole sample retires old room results when identity changes while hidden before visible polling resumes', async t => {
  const h = await setup(t); h.sdk.snapshot(roomState()); h.clock.advance(2000);
  const old = h.sdk.polls[0]!, retired = callbacks(h, 2000); h.setHidden(true);
  h.sdk.snapshot({ ...roomState({ participantId: 'replacement-person' }), roomId: 'replacement-room' });
  h.setHidden(false); old.resolve(result(0.9, 80)); for (const callback of retired) callback(); await flushSample();
  assert.equal(connection(h).textContent, ''); assert.equal(h.sdk.polls.length, 2);
  h.sdk.polls[1]!.resolve(result(0.025, 0)); await flushSample(); assert.match(connection(h).textContent, /25 ms/);
});

it('whole sample preserves hidden reconnect, pending control ACK, and independent cooldown scheduling', async t => {
  const h = await setup(t); h.sdk.snapshot(roomState());
  const hand = () => h.find(node => node.dataset.roomAction === 'hand');
  hand().click(); assert.equal(h.sdk.raises.length, 1); const state = h.sdk.state;
  h.setHidden(true); h.sdk.setStatus('reconnecting'); timers(h, 0, 0);
  assert.equal(h.clock.timeouts().length, 1); assert.equal(hand().disabled, true);
  h.clock.advance(1500); assert.equal(h.sdk.handCooldownMs, 0); assert.equal(hand().disabled, true);
  h.sdk.raises[0]!.resolve(undefined); await flushSample(); assert.equal(hand().disabled, true);
  assert.equal(h.sdk.state, state); assert.equal(h.sdk.status, 'reconnecting');
  h.setHidden(false); timers(h, 0, 1); assert.equal(h.sdk.polls.length, 1);
  h.sdk.setStatus('waiting'); assert.equal(hand().disabled, false); timers(h, 0, 1);
  assert.equal(h.sdk.raises.length, 1); assert.equal(h.clock.timeouts().length, 0);
});

interface AudioStats { bitrateKbps?: number; lossPercent?: number; bufferMs?: number; rtt?: number }
interface Stats { inbound: AudioStats | null; outbound: AudioStats | null }
interface ActualClient {
  disconnect(): Promise<void>;
  getStats(): Promise<Stats>;
  dispatchEvent(event: Event): boolean;
}
type Report = Map<string, Record<string, unknown>>;
function report(timestamp: number, bytes: number, received: number, lost: number, delay: number, emitted: number): Report {
  return new Map([
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp, bytesReceived: bytes, packetsReceived: received,
      packetsLost: lost, jitterBufferDelay: delay, jitterBufferEmittedCount: emitted }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.04 }],
  ]);
}
async function actualSetup(t: TestContext) {
  // Keep DOM types out of the server-test graph; the complete SDK and sample execute unchanged.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const originals = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async enumerateDevices() { return []; } } } });
  const listening = {}, audio = { volume: 0.37, muted: true, srcObject: listening as unknown, pauses: 0, pause() { this.pauses++; } };
  const sdk: ActualClient = new StageClient({ url: 'ws://localhost/ws', audioElement: audio });
  const h = sampleApp({ sdk }), pending: Deferred<Report>[] = [], results: Stats[] = [];
  const collect = sdk.getStats.bind(sdk);
  sdk.getStats = async () => { const stats = await collect(); results.push(stats); return stats; };
  const pc = { closes: 0, close() { this.closes++; }, getStats() { const work = new Deferred<Report>(); pending.push(work); return work.promise; } };
  const track = { enabled: true, stops: 0, stop() { this.stops++; } };
  const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
  const meter = { reads: 0, stops: 0, level() { this.reads++; return 0.4; }, stop() { this.stops++; } };
  const state: RoomStatePayload = stage();
  Object.assign(sdk, { pc, mic, micMeter: meter, snapshot: state, currentStatus: state.status });
  sdk.dispatchEvent(new CustomEvent('state', { detail: state }));
  t.after(async () => {
    try {
      await h.cleanup();
      for (const work of pending) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
      await flushSample();
      assert.equal(pc.closes, 1); assert.equal(track.stops, 1); assert.equal(meter.stops, 1);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  await flushSample();
  return { ...h, pending, results, pc, track, mic, meter, audio, listening, state };
}

it('whole sample with actual SDK preserves the stats baseline over a hidden gap and leaves fake media identities untouched', async t => {
  const h = await actualSetup(t); h.clock.advance(2000);
  h.pending[0]!.resolve(report(2000, 1000, 100, 0, 2, 100)); await flushSample();
  assert.equal(h.results[0]!.inbound?.lossPercent, undefined);
  h.setHidden(true); const reads = h.meter.reads; h.clock.advance(10_000);
  assert.equal(h.pending.length, 1); assert.equal(h.meter.reads, reads); assert.equal(connection(h).textContent, '');
  h.setHidden(false); assert.equal(h.pending.length, 2, 'the resumed request starts immediately');
  h.pending[1]!.resolve(report(12000, 81000, 575, 25, 17, 600)); await flushSample();
  assert.equal(h.results[1]!.inbound?.bitrateKbps, 64);
  assert.equal(h.results[1]!.inbound?.lossPercent, 5); assert.equal(h.results[1]!.inbound?.bufferMs, 30);
  assert.match(connection(h).textContent, /5\.0%/); assert.match(connection(h).textContent, /30 ms/);
  h.clock.advance(2000); h.pending[2]!.resolve(report(14000, 89000, 675, 25, 19, 700)); await flushSample();
  assert.equal(h.results[2]!.inbound?.bitrateKbps, 32); assert.equal(h.results[2]!.inbound?.lossPercent, 0);
  assert.equal(h.results[2]!.inbound?.bufferMs, 20);
  assert.equal(h.audio.srcObject, h.listening); assert.equal(h.audio.pauses, 0);
  assert.equal(h.audio.volume, 0.37); assert.equal(h.audio.muted, true);
  assert.equal(h.pc.closes, 0); assert.equal(h.track.stops, 0); assert.equal(h.track.enabled, true); assert.equal(h.meter.stops, 0);
  const internals = h.sdk as ActualClient & { pc: unknown; mic: unknown; snapshot: unknown };
  assert.equal(internals.pc, h.pc); assert.equal(internals.mic, h.mic); assert.equal(internals.snapshot, h.state);
});

it('whole sample drops a hidden in-flight UI result while actual SDK retains its completed delta baseline', async t => {
  const h = await actualSetup(t); h.clock.advance(2000); h.setHidden(true);
  h.pending[0]!.resolve(report(2000, 1000, 100, 0, 2, 100)); await flushSample();
  assert.equal(h.results.length, 1); assert.equal(connection(h).textContent, '');
  h.clock.advance(10_000); h.setHidden(false); assert.equal(h.pending.length, 2);
  h.pending[1]!.resolve(report(12000, 81000, 575, 25, 17, 600)); await flushSample();
  assert.equal(h.results[1]!.inbound?.bitrateKbps, 64); assert.equal(h.results[1]!.inbound?.lossPercent, 5);
  assert.equal(h.results[1]!.inbound?.bufferMs, 30); assert.match(connection(h).textContent, /5\.0%/);
  assert.equal(h.pc.closes, 0); assert.equal(h.audio.pauses, 0); assert.equal(h.track.stops, 0);
});
