import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp, SampleNode, SamplePreview } from './fixtures/sampleApp.ts';

// These are deterministic application-operation counts, not browser timing or native media measurements.
type App = ReturnType<typeof sampleApp>;
const result = (rtt = 0.08, lossPercent = 8) => ({ inbound: { rtt, lossPercent, bufferMs: 30 }, outbound: null });
const empty = () => ({ inbound: null, outbound: null });
const connection = (h: Pick<App, 'find'>) => h.find(node => node.classList.contains('connection'));
function writes(line: SampleNode): () => number {
  const descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!;
  let count = 0;
  Object.defineProperty(line, 'textContent', { configurable: true, get() { return descriptor.get!.call(line); },
    set(value) { count++; descriptor.set!.call(line, value); } });
  return () => count;
}
async function setup(t: TestContext): Promise<App> {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample(); h.sdk.snapshot(roomState()); return h;
}
function shown(h: Pick<App, 'find'>, rttMs: number, poor: boolean): void {
  assert.match(connection(h).textContent, new RegExp(`接收 RTT ${rttMs} ms`));
  assert.equal(connection(h).classList.contains('error'), poor);
}
function cleared(h: Pick<App, 'find'>): void {
  assert.equal(connection(h).textContent, ''); assert.equal(connection(h).classList.contains('error'), false);
}
async function seed(h: App): Promise<void> {
  h.clock.advance(2000); h.sdk.polls[0]!.resolve(result()); await flushSample(); shown(h, 80, true);
}

it('whole sample shows an older fulfilled result while newer polls remain pending, without replacing the interval', async t => {
  const h = await setup(t), timer = h.clock.intervals(2000)[0]!, count = writes(connection(h));
  h.clock.advance(6000); assert.equal(h.sdk.polls.length, 3);
  h.sdk.polls[0]!.resolve(result()); await flushSample(); shown(h, 80, true); assert.equal(count(), 1);
  assert.equal(h.sdk.polls[1]!.status, 'pending'); assert.equal(h.sdk.polls[2]!.status, 'pending');
  h.sdk.snapshot(roomState()); assert.deepEqual(h.clock.intervals(2000), [timer]);
  h.sdk.polls[1]!.resolve(result(0.02, 0)); await flushSample(); shown(h, 20, false); assert.equal(count(), 2);
  h.clock.advance(2000); assert.equal(h.sdk.polls.length, 4); assert.equal(h.clock.jobs.get(timer)!.due, 10_000);
});

for (const newest of ['success', 'empty'] as const) {
  for (const older of ['success', 'empty'] as const) {
    it(`whole sample newer fulfilled ${newest} excludes an older ${older} even with another poll pending`, async t => {
      const h = await setup(t); await seed(h); const count = writes(connection(h));
      h.clock.advance(6000); assert.equal(h.sdk.polls.length, 4);
      h.sdk.polls[2]!.resolve(newest === 'empty' ? empty() : result(0.02, 0)); await flushSample();
      if (newest === 'empty') cleared(h); else shown(h, 20, false);
      assert.equal(count(), 1); assert.equal(h.sdk.polls[3]!.status, 'pending');
      h.sdk.polls[1]!.resolve(older === 'empty' ? empty() : result(0.9, 90)); await flushSample();
      if (newest === 'empty') cleared(h); else shown(h, 20, false);
      assert.equal(count(), 1, 'an obsolete completion must not write the connection line');
    });
  }
}

for (const older of ['success', 'empty'] as const) {
  it(`whole sample a newer rejection leaves an older fulfilled ${older} eligible`, async t => {
    const h = await setup(t); await seed(h); const count = writes(connection(h));
    h.clock.advance(4000); h.sdk.polls[2]!.reject(new Error('newer stats unavailable')); await flushSample();
    shown(h, 80, true); assert.equal(count(), 0);
    h.sdk.polls[1]!.resolve(older === 'empty' ? empty() : result(0.03, 0)); await flushSample();
    if (older === 'empty') cleared(h); else shown(h, 30, false);
    assert.equal(count(), 1);
    h.clock.advance(2000); h.sdk.polls[3]!.resolve(result(0.01, 0)); await flushSample(); shown(h, 10, false);
  });
}

it('whole sample current empty clears a poor display while a newer request is pending', async t => {
  const h = await setup(t); await seed(h);
  h.clock.advance(4000); h.sdk.polls[1]!.resolve(empty()); await flushSample(); cleared(h);
  assert.equal(h.sdk.polls[2]!.status, 'pending');
  h.sdk.polls[2]!.resolve(result(0.02, 0)); await flushSample(); shown(h, 20, false);
});

for (const change of ['room', 'participant', 'same-identity-reentry'] as const) {
  it(`whole sample ${change} rejects old work before a fresh completion even when still newer work is pending`, async t => {
    const h = await setup(t); h.clock.advance(4000); const old = h.sdk.polls.slice(), oldLine = connection(h);
    if (change === 'same-identity-reentry') {
      h.button('離開房間').click(); await flushSample(); assert.equal(h.sdk.state, null);
      for (const poll of old) poll.resolve(result(0.9, 90)); await flushSample();
      assert.equal(oldLine.textContent, ''); assert.equal(oldLine.isConnected, false);
      h.sdk.snapshot(roomState());
    } else {
      h.sdk.snapshot(change === 'room' ? { ...roomState(), roomId: 'replacement-room' } : roomState({ participantId: 'replacement-person' }));
    }
    h.clock.advance(4000); assert.equal(h.sdk.polls.length, 4);
    if (change !== 'same-identity-reentry') {
      old[1]!.resolve(result(0.9, 90)); old[0]!.resolve(empty()); await flushSample();
    }
    cleared(h); h.sdk.polls[2]!.resolve(result(0.02, 0)); await flushSample(); shown(h, 20, false);
    assert.equal(h.sdk.polls[3]!.status, 'pending');
  });
}

it('whole sample same-identity reentry rejects a pre-leave completion after rejoining', async t => {
  const h = await setup(t); h.clock.advance(2000); const old = h.sdk.polls[0]!;
  h.button('離開房間').click(); await flushSample(); h.sdk.snapshot(roomState());
  h.clock.advance(4000); old.resolve(result(0.9, 90)); await flushSample(); cleared(h);
  h.sdk.polls[1]!.resolve(result(0.02, 0)); await flushSample(); shown(h, 20, false);
  assert.equal(h.sdk.polls[2]!.status, 'pending');
});

for (const oldResult of ['success', 'empty', 'rejection'] as const) {
  it(`whole sample hide and duplicate visible notifications fence retired ${oldResult} without starving current completions`, async t => {
    const h = await setup(t); await seed(h); h.clock.advance(2000); const beforeHide = h.sdk.polls[1]!;
    const retired = h.clock.jobs.get(h.clock.intervals(2000)[0]!)!.callback;
    h.setHidden(true); h.setHidden(true); cleared(h); assert.equal(h.clock.intervals(2000).length, 0);
    h.clock.advance(6000); assert.equal(h.sdk.polls.length, 2);
    h.setHidden(false); const resumedTimer = h.clock.intervals(2000)[0]!;
    h.setHidden(false); assert.deepEqual(h.clock.intervals(2000), [resumedTimer]);
    assert.equal(h.sdk.polls.length, 4, 'each visible notification still issues one fresh poll');
    if (oldResult === 'rejection') beforeHide.reject(new Error('retired poll failed'));
    else beforeHide.resolve(oldResult === 'empty' ? empty() : result(0.9, 90));
    h.sdk.polls[2]!.resolve(result(0.7, 70)); retired(); await flushSample(); cleared(h);
    assert.equal(h.sdk.polls.length, 4, 'the retired interval cannot collect');
    h.clock.advance(2000); assert.equal(h.sdk.polls.length, 5);
    h.sdk.polls[3]!.resolve(result(0.02, 0)); await flushSample(); shown(h, 20, false);
    assert.equal(h.sdk.polls[4]!.status, 'pending');
    assert.deepEqual(h.clock.intervals(2000), [resumedTimer]); assert.equal(h.visibilityListeners.size, 1);
  });
}

it('whole sample hidden property alone rejects a completion before its visibility event arrives', async t => {
  const h = await setup(t); h.clock.advance(2000); h.setHidden(true, false);
  h.sdk.polls[0]!.resolve(result(0.9, 90)); await flushSample(); cleared(h);
  h.setHidden(true); h.setHidden(false); h.clock.advance(2000);
  h.sdk.polls[1]!.resolve(result(0.02, 0)); await flushSample(); shown(h, 20, false);
});

it('whole sample stats completions preserve pending control ACK, preview, playback, and session', async t => {
  const h = await setup(t); h.id('mic-test').click(); const preview = new SamplePreview(0.42);
  h.sdk.grantPreview(h.sdk.previews[0]!, preview); await flushSample();
  h.id('playback-mute').click(); await flushSample();
  h.id('playback-volume').value = '37'; h.id('playback-volume').oninput!();
  const hand = h.find(node => node.dataset.roomAction === 'hand'), state = h.sdk.state;
  hand.click(); const ack = h.sdk.raises[0]!; h.clock.advance(4000);
  h.sdk.polls[0]!.resolve(result()); await flushSample(); shown(h, 80, true);
  h.clock.advance(2000); h.sdk.polls[1]!.resolve(empty()); await flushSample(); cleared(h);
  assert.equal(ack.status, 'pending'); assert.equal(hand.disabled, true); assert.equal(hand.attributes['aria-busy'], 'true');
  assert.equal(h.sdk.handCooldownMs, 0); assert.equal(h.clock.timeouts().length, 0);
  hand.onclick!(); assert.equal(h.sdk.raises.length, 1);
  assert.equal(h.sdk.state, state); assert.equal(h.sdk.status, 'waiting');
  assert.equal(h.sdk.activePreviews.size, 1); assert.equal(preview.stops, 0); assert.equal(preview.reads, 120);
  assert.equal(h.sdk.previewSignals[0]!.aborted, false); assert.equal(h.id('mic-level').value, 0.42);
  assert.equal(h.sdk.playbackMuted, true); assert.equal(h.sdk.playbackVolume, 0.37);
  assert.deepEqual(h.sdk.inputDevices, []); assert.deepEqual(h.sdk.outputDevices, []); assert.deepEqual(h.sdk.joins, []);
  ack.resolve(undefined); await flushSample(); assert.equal(hand.disabled, false); assert.equal(hand.attributes['aria-busy'], 'false');
});

interface AudioStats { bitrateKbps?: number; lossPercent?: number; bufferMs?: number; rtt?: number }
interface Stats { inbound: AudioStats | null; outbound: AudioStats | null }
interface ActualClient {
  disconnect(): Promise<void>;
  getStats(): Promise<Stats>;
  dispatchEvent(event: Event): boolean;
}
type Report = Map<string, Record<string, unknown>>;
function report(timestamp: number, rtt = 0.04, counters = {
  bytes: timestamp * 8, received: timestamp * 19, lost: timestamp, delay: timestamp * 0.03, emitted: timestamp,
}): Report {
  return new Map([
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp, bytesReceived: counters.bytes,
      packetsReceived: counters.received, packetsLost: counters.lost, jitterBufferDelay: counters.delay, jitterBufferEmittedCount: counters.emitted }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: rtt }],
  ]);
}
function deltas(stats: Stats): void {
  assert.equal(stats.inbound?.bitrateKbps, 64); assert.equal(stats.inbound?.lossPercent, 5);
  assert.equal(stats.inbound?.bufferMs, 30);
}
async function actualSetup(t: TestContext, delay?: number) {
  // Dynamic import avoids DOM types in the server-test graph. Session/peer/capture are synthetic;
  // public getStats/disconnect run unchanged, without a wire join or media negotiation.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const originals = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async enumerateDevices() { return []; } } } });
  const listening = {}, audio = { volume: 0.37, muted: true, srcObject: listening as unknown, pauses: 0, pause() { this.pauses++; } };
  const sdk: ActualClient = new StageClient({ url: 'ws://localhost/ws', audioElement: audio });
  const h = sampleApp({ sdk }), pending: { at: number; work: Deferred<Report> }[] = [], completed: Stats[] = [];
  const collect = sdk.getStats.bind(sdk);
  sdk.getStats = async () => { const stats = await collect(); completed.push(stats); return stats; };
  const pc = { closes: 0, close() { this.closes++; }, getStats() {
    const work = new Deferred<Report>(); pending.push({ at: h.clock.now, work });
    if (delay !== undefined) h.clock.setTimeout(() => work.resolve(report(h.clock.now)), delay);
    return work.promise;
  } };
  const track = { enabled: true, stops: 0, stop() { this.stops++; } };
  const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
  const meter = { reads: 0, stops: 0, level() { this.reads++; return 0.4; }, stop() { this.stops++; } };
  const state = roomState(); Object.assign(sdk, { pc, mic, micMeter: meter, snapshot: state, currentStatus: state.status });
  sdk.dispatchEvent(new CustomEvent('state', { detail: state }));
  t.after(async () => {
    try {
      await h.cleanup();
      for (const { work } of pending) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
      await flushSample(); assert.equal(pending.filter(({ work }) => work.status === 'pending').length, 0);
      assert.equal(pc.closes, 1); assert.equal(track.stops, 1); assert.equal(meter.stops, 1);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  await flushSample();
  return { ...h, pending, completed, pc, track, mic, meter, audio, listening, state,
    async advance(ms: number) { for (let elapsed = 0; elapsed < ms; elapsed += 100) { h.clock.advance(Math.min(100, ms - elapsed)); await flushSample(); } },
    unchangedMedia() {
      assert.equal(audio.srcObject, listening); assert.equal(audio.pauses, 0); assert.equal(audio.volume, 0.37); assert.equal(audio.muted, true);
      assert.equal(pc.closes, 0); assert.equal(track.stops, 0); assert.equal(track.enabled, true); assert.equal(meter.stops, 0);
      const internals = sdk as ActualClient & { pc: unknown; mic: unknown; snapshot: unknown };
      assert.equal(internals.pc, pc); assert.equal(internals.mic, mic); assert.equal(internals.snapshot, state);
    },
  };
}

for (const delay of [1000, 5000]) {
  it(`whole sample actual SDK ${delay} ms completions keep every 2-second poll and render each completed sample`, async t => {
    const h = await actualSetup(t, delay), count = writes(connection(h)), timer = h.clock.intervals(2000)[0]!;
    for (const end of [10_000, 30_000, 60_000]) {
      await h.advance(end - h.clock.now);
      const expected = Math.floor((end - delay) / 2000);
      assert.equal(h.pending.length, end / 2000); assert.equal(h.completed.length, expected); assert.equal(count(), expected);
      assert.equal(h.pending.filter(({ work }) => work.status === 'pending').length, end / 2000 - expected);
      shown(h, 40, true); deltas(h.completed.at(-1)!);
      assert.deepEqual(h.clock.intervals(2000), [timer]); assert.equal(h.clock.fired.filter(id => id === timer).length, end / 2000);
    }
    assert.deepEqual(h.pending.map(poll => poll.at), Array.from({ length: 30 }, (_, index) => (index + 1) * 2000));
    assert.equal(h.completed[0]!.inbound?.bitrateKbps, undefined); assert.equal(h.completed[0]!.inbound?.lossPercent, undefined);
    h.unchangedMedia();
  });
}

it('whole sample actual SDK retains hung calls while later polls can independently complete', async t => {
  const h = await actualSetup(t), count = writes(connection(h)); await h.advance(10_000);
  assert.deepEqual(h.pending.map(poll => poll.at), [2000, 4000, 6000, 8000, 10_000]);
  assert.equal(h.pending.filter(({ work }) => work.status === 'pending').length, 5); assert.equal(count(), 0);
  assert.equal(h.completed.length, 0); assert.equal(h.clock.timeouts().length, 0);
  h.pending[3]!.work.resolve(report(8000, 0.02)); await flushSample(); shown(h, 20, false);
  assert.equal(h.pending[0]!.work.status, 'pending'); assert.equal(h.pending[4]!.work.status, 'pending');
  await h.advance(2000); h.pending[5]!.work.resolve(report(12000, 0.03)); await flushSample(); shown(h, 30, true);
  deltas(h.completed[1]!); assert.equal(count(), 2); h.unchangedMedia();
});

it('whole sample actual SDK out-of-order completion preserves its newest delta baseline and visible result', async t => {
  const h = await actualSetup(t), count = writes(connection(h)); h.clock.advance(6000);
  h.pending[1]!.work.resolve(report(4000, 0.02, { bytes: 1000, received: 100, lost: 0, delay: 2, emitted: 100 }));
  await flushSample(); shown(h, 20, false);
  h.pending[0]!.work.resolve(report(2000, 0.9)); await flushSample(); shown(h, 20, false);
  assert.deepEqual(h.completed[1], empty()); assert.equal(count(), 1);
  h.pending[2]!.work.resolve(report(6000, 0.03, { bytes: 17000, received: 290, lost: 10, delay: 8, emitted: 300 }));
  await flushSample(); deltas(h.completed[2]!); shown(h, 30, true);
  assert.equal(count(), 2); h.unchangedMedia();
});

it('whole sample actual SDK newer rejection allows an older completion to seed the next delta', async t => {
  const h = await actualSetup(t); h.clock.advance(4000);
  h.pending[1]!.work.reject(new Error('newer peer stats failed')); await flushSample(); cleared(h);
  h.pending[0]!.work.resolve(report(2000, 0.08)); await flushSample(); shown(h, 80, false);
  h.clock.advance(2000); h.pending[2]!.work.resolve(report(6000, 0.03)); await flushSample();
  deltas(h.completed[1]!); shown(h, 30, true); h.unchangedMedia();
});

it('whole sample actual SDK fulfilled empty retires older work and resets report baselines as before', async t => {
  const h = await actualSetup(t); h.clock.advance(2000); h.pending[0]!.work.resolve(report(2000)); await flushSample();
  h.clock.advance(6000); h.pending[2]!.work.resolve(new Map()); await flushSample(); cleared(h);
  h.pending[1]!.work.resolve(report(4000, 0.9)); await flushSample(); cleared(h);
  assert.deepEqual(h.completed[2], empty());
  h.pending[3]!.work.resolve(report(8000, 0.02)); await flushSample(); shown(h, 20, false);
  assert.equal(h.completed[3]!.inbound?.bitrateKbps, undefined); assert.equal(h.completed[3]!.inbound?.lossPercent, undefined);
  assert.equal(h.completed[3]!.inbound?.bufferMs, undefined);
  h.clock.advance(2000); h.pending[4]!.work.resolve(report(10_000)); await flushSample(); deltas(h.completed[4]!);
  h.unchangedMedia();
});
