import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp, SampleNode } from './fixtures/sampleApp.ts';

// Complete sample and actual public SDK; only DOM, clock, capture and RTC reports are controlled.
// Operation counts do not measure native layout, accessibility, real media, or end-to-end latency.
interface AudioStats { bitrateKbps?: number; lossPercent?: number; rtt?: number; bufferMs?: number }
interface Stats { inbound: AudioStats | null; outbound: AudioStats | null }
interface ActualClient {
  readonly state: RoomStatePayload | null;
  disconnect(): Promise<void>;
  getStats(): Promise<Stats>;
  dispatchEvent(event: Event): boolean;
}
type Entry = Record<string, unknown>;
type Report = Map<string, Entry>;
const report = (...entries: Entry[]): Report => new Map(entries.map(entry => [String(entry.id), entry]));
const inbound = (timestamp = 1000, received = 100, lost = 0, delay = 2, emitted = 100, extra: Entry = {}): Entry =>
  ({ id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp, bytesReceived: timestamp * 8,
    packetsReceived: received, packetsLost: lost, jitterBufferDelay: delay, jitterBufferEmittedCount: emitted, ...extra });
const outbound = (timestamp = 1000, extra: Entry = {}): Entry =>
  ({ id: 'out', type: 'outbound-rtp', kind: 'audio', timestamp, bytesSent: timestamp, remoteId: 'remote', ...extra });
const pair = (rtt = 0.043): Entry => ({ id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: rtt });
const remote = (rtt = 0.1, fraction = 0.125): Entry => ({ id: 'remote', type: 'remote-inbound-rtp', roundTripTime: rtt, fractionLost: fraction });
const text = (receive: string, send: string): string =>
  `你的連線（上次完成讀取；SDK 取樣區間）：${receive}；${send}。RTT 不是端到端音訊延遲；不保證資料即時或目前可聽。`;
const rx = (loss = '—', rtt = '—', buffer = '—'): string => `接收掉包 ${loss}% · 接收 RTT ${rtt} ms · 接收緩衝 ${buffer} ms`;
const tx = (loss = '—', rtt = '—'): string => `傳送掉包 ${loss}% · 傳送 RTT ${rtt} ms`;
const noReceive = '接收：暫無統計', noSend = '傳送：暫無統計';
function writes(line: SampleNode): () => number {
  const descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!;
  let count = 0;
  Object.defineProperty(line, 'textContent', { configurable: true, get() { return descriptor.get!.call(line); },
    set(value: string) { count++; descriptor.set!.call(line, value); } });
  return () => count;
}
async function setup(t: TestContext) {
  // Dynamic import keeps browser-only SDK types outside the server-test TypeScript graph.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const originals = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let enumerations = 0, captures = 0, requests = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    async enumerateDevices() { enumerations++; return []; },
    async getUserMedia() { captures++; throw new Error('unexpected capture'); },
  } } });
  const listening = {}, audio = { volume: 0.37, muted: true, srcObject: listening as unknown, pauses: 0, pause() { this.pauses++; } };
  const sdk: ActualClient = new StageClient({ url: 'ws://localhost/ws', audioElement: audio, enableMicMeter: false });
  const h = sampleApp({ sdk }), pending: { at: number; work: Deferred<Report> }[] = [], completed: Stats[] = [];
  const collect = sdk.getStats.bind(sdk);
  sdk.getStats = async () => { const value = await collect(); completed.push(value); return value; };
  const pc = { closes: 0, close() { this.closes++; }, getStats() {
    const work = new Deferred<Report>(); pending.push({ at: h.clock.now, work }); return work.promise;
  } };
  const track = { enabled: true, stops: 0, stop() { this.stops++; } };
  const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
  const state = roomState();
  Object.assign(sdk, { pc, mic, snapshot: state, currentStatus: state.status,
    request() { requests++; return Promise.reject(new Error('unexpected control request')); } });
  const snapshot = (next: RoomStatePayload) => {
    Object.assign(sdk, { snapshot: next, currentStatus: next.status });
    sdk.dispatchEvent(new CustomEvent('state', { detail: next }));
  };
  snapshot(state); await flushSample();
  const line = () => h.find(node => node.classList.contains('connection'));
  const timer = h.clock.intervals(2000)[0]!;
  assert.deepEqual([...h.clock.jobs.keys()], [timer]);
  const resolve = async (value: Report) => { pending.at(-1)!.work.resolve(value); await flushSample(); return completed.at(-1)!; };
  const poll = async (value: Report) => { h.clock.advance(2000); return resolve(value); };
  const unchanged = () => {
    assert.equal(audio.srcObject, listening); assert.equal(audio.pauses, 0); assert.equal(audio.volume, 0.37); assert.equal(audio.muted, true);
    assert.equal(pc.closes, 0); assert.equal(track.stops, 0); assert.equal(track.enabled, true);
    assert.equal(captures, 0); assert.equal(requests, 0); assert.equal(enumerations, 1);
    const internals = sdk as ActualClient & { pc: unknown; mic: unknown };
    assert.equal(internals.pc, pc); assert.equal(internals.mic, mic);
  };
  t.after(async () => {
    try {
      unchanged(); await h.cleanup();
      for (const { work } of pending) if (work.status === 'pending') work.reject(new Error('controlled cleanup'));
      await flushSample(); assert.equal(pc.closes, 1); assert.equal(track.stops, 1);
      assert.ok(pending.every(({ work }) => work.status !== 'pending'));
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return { ...h, pending, completed, line, timer, snapshot, poll, resolve, unchanged };
}

it('whole sample actual SDK displays distinct directional RTT and first-sample gaps, then exact delta units', async t => {
  const h = await setup(t), line = h.line(), nodes = h.app.descendants(), count = writes(line);
  const first = await h.poll(report(inbound(), outbound(), pair(), remote()));
  assert.equal(first.inbound?.rtt, 0.043); assert.equal(first.outbound?.rtt, 0.1);
  assert.equal(first.inbound?.lossPercent, undefined); assert.equal(first.inbound?.bufferMs, undefined);
  assert.equal(first.outbound?.lossPercent, 12.5);
  assert.equal(line.textContent, text(rx('—', '43'), tx('12.5', '100')));
  assert.equal(line.classList.contains('error'), true);
  const second = await h.poll(report(inbound(2000, 148, 2, 3, 150), outbound(2000), pair(), remote()));
  assert.equal(second.inbound?.lossPercent, 4); assert.equal(second.inbound?.bufferMs, 20);
  assert.equal(second.inbound?.bitrateKbps, 64); assert.equal(second.outbound?.bitrateKbps, 8);
  assert.equal(line.textContent, text(rx('4.0', '43', '20'), tx('12.5', '100')));
  assert.equal(count(), 2); assert.equal(h.line(), line); assert.deepEqual(h.app.descendants(), nodes);
  assert.equal(line.tagName, 'p'); assert.equal(line.children.length, 0);
  assert.deepEqual(h.pending.map(value => value.at), [2000, 4000]); assert.deepEqual([...h.clock.jobs.keys()], [h.timer]);
  h.unchanged();
});

it('whole sample actual SDK labels each sole direction and never borrows the other direction RTT', async t => {
  const h = await setup(t);
  let value = await h.poll(report(inbound(), pair()));
  assert.equal(value.outbound, null); assert.equal(h.line().textContent, text(rx('—', '43'), noSend));
  value = await h.poll(report(outbound(2000), pair(), remote(0.1, 0.02)));
  assert.equal(value.inbound, null); assert.equal(h.line().textContent, text(noReceive, tx('2.0', '100')));
  value = await h.poll(report(outbound(3000, { remoteId: undefined }), pair(0.05)));
  assert.equal(value.outbound?.lossPercent, undefined); assert.equal(h.line().textContent, text(noReceive, tx('—', '50')));
  value = await h.poll(report(inbound(4000), outbound(4000), remote()));
  assert.equal(value.inbound?.rtt, undefined); assert.equal(value.outbound?.rtt, 0.1);
  assert.equal(h.line().textContent, text(rx(), tx('12.5', '100')));
  assert.equal(h.pending.length, 4); assert.deepEqual(h.clock.intervals(2000), [h.timer]);
});

it('whole sample actual SDK distinguishes present metricless directions from no directions', async t => {
  const h = await setup(t);
  let value = await h.poll(report(inbound()));
  assert.ok(value.inbound); assert.equal(value.outbound, null); assert.equal(h.line().textContent, text(rx(), noSend));
  value = await h.poll(report({ id: 'out', type: 'outbound-rtp', kind: 'audio', timestamp: 2000 }));
  assert.ok(value.outbound); assert.equal(value.inbound, null); assert.equal(h.line().textContent, text(noReceive, tx()));
  value = await h.poll(report(inbound(3000), outbound(3000)));
  assert.ok(value.inbound); assert.ok(value.outbound); assert.equal(h.line().textContent, text(rx(), tx()));
  await h.poll(report(outbound(4000), remote())); assert.equal(h.line().classList.contains('error'), true);
  value = await h.poll(report(pair()));
  assert.deepEqual(value, { inbound: null, outbound: null });
  assert.equal(h.line().textContent, ''); assert.equal(h.line().classList.contains('error'), false);
});

it('whole sample actual SDK preserves zero and its candidate-pair fallback without collapsing directional labels', async t => {
  const h = await setup(t);
  let value = await h.poll(report(inbound(), outbound(), pair(), remote(0, 0)));
  assert.equal(value.outbound?.rtt, 0); assert.equal(value.inbound?.rtt, 0.043);
  assert.equal(h.line().textContent, text(rx('—', '43'), tx('0.0', '0')));
  value = await h.poll(report(inbound(2000, 150, 0, 2, 150), outbound(2000), pair(0), remote(0, 0)));
  assert.equal(value.inbound?.lossPercent, 0); assert.equal(value.inbound?.bufferMs, 0);
  assert.equal(h.line().textContent, text(rx('0.0', '0', '0'), tx('0.0', '0')));
  assert.equal(h.line().classList.contains('error'), false);
  value = await h.poll(report(inbound(3000, 200, 0, 3, 200), outbound(3000, { remoteId: undefined }), pair(0.09)));
  assert.equal(value.inbound?.rtt, 0.09); assert.equal(value.outbound?.rtt, 0.09);
  assert.equal(h.line().textContent, text(rx('0.0', '90', '20'), tx('—', '90')));
});

it('whole sample actual SDK rounds each RTT from seconds and the receive buffer already in milliseconds', async t => {
  const h = await setup(t); await h.poll(report(inbound(), outbound(), pair(), remote()));
  const value = await h.poll(report(inbound(2000, 150, 0, 3.0245, 150), outbound(2000), pair(0.04349), remote(0.1005, 0)));
  assert.ok(Math.abs(value.inbound!.bufferMs! - 20.49) < 1e-10);
  assert.equal(value.inbound?.rtt, 0.04349); assert.equal(value.outbound?.rtt, 0.1005);
  assert.equal(h.line().textContent, text(rx('0.0', '43', '20'), tx('0.0', '101')));
});

for (const direction of ['receive', 'send'] as const) {
  it(`whole sample actual SDK ${direction} warning uses unrounded loss at 0, 4.99, 5 and 5.01 percent`, async t => {
    const h = await setup(t);
    let timestamp = 1000, received = 100, lost = 0;
    if (direction === 'receive') await h.poll(report(inbound(timestamp, received, lost, 2, 100), outbound(timestamp), pair(10), remote(10, 0)));
    for (const [loss, poor] of [[0, false], [4.99, false], [5, true], [5.01, true], [0, false]] as const) {
      timestamp += 1000; received += 10000 - loss * 100; lost += loss * 100;
      const value = await h.poll(direction === 'receive'
        ? report(inbound(timestamp, received, lost, 2, 100), outbound(timestamp), pair(10), remote(10, 0))
        : report(outbound(timestamp), pair(10), remote(10, loss / 100)));
      const measured = direction === 'receive' ? value.inbound!.lossPercent! : value.outbound!.lossPercent!;
      assert.ok(Math.abs(measured - loss) < 1e-12); assert.equal(h.line().classList.contains('error'), poor);
      assert.equal(h.line().textContent, direction === 'receive'
        ? text(rx(loss.toFixed(1), '10000'), tx('0.0', '10000')) : text(noReceive, tx(loss.toFixed(1), '10000')));
    }
    assert.equal(h.clock.timeouts().length, 0); assert.deepEqual(h.clock.intervals(2000), [h.timer]);
  });
}

it('whole sample actual SDK keeps last matching RTP semantics instead of inventing an all-stream aggregate', async t => {
  const h = await setup(t);
  const value = await h.poll(report(inbound(), { ...inbound(), id: 'in-last', remoteId: 'receive-remote' },
    outbound(), { ...outbound(), id: 'out-last', remoteId: 'send-remote' }, pair(), remote(),
    { ...remote(0.2, 0), id: 'receive-remote' }, { ...remote(0.3, 0.02), id: 'send-remote' }));
  assert.equal(value.inbound?.rtt, 0.2); assert.equal(value.outbound?.rtt, 0.3); assert.equal(value.outbound?.lossPercent, 2);
  assert.equal(h.line().textContent, text(rx('—', '200'), tx('2.0', '300')));
  assert.equal(h.line().classList.contains('error'), false);
});

it('whole sample actual SDK uses its shared completed baseline rather than promising a two-second delta', async t => {
  const h = await setup(t); await h.poll(report(inbound(), pair()));
  await h.poll(report(inbound(2000, 148, 2, 3, 150), pair()));
  const historical = h.line().textContent;
  assert.equal(historical, text(rx('4.0', '43', '20'), noSend));
  h.clock.advance(1000); const external = h.sdk.getStats();
  await h.resolve(report(inbound(3000, 198, 2, 4, 200), pair())); await external;
  assert.equal(h.line().textContent, historical, 'an external SDK read only advances the shared delta baseline');
  h.clock.advance(1000); const value = await h.resolve(report(inbound(4000, 243, 7, 6, 250), pair()));
  assert.equal(value.inbound?.lossPercent, 10); assert.equal(value.inbound?.bufferMs, 40);
  assert.equal(h.line().textContent, text(rx('10.0', '43', '40'), noSend));
  assert.deepEqual(h.pending.map(value => value.at), [2000, 4000, 5000, 6000]);
  assert.deepEqual(h.clock.intervals(2000), [h.timer]); assert.equal(h.clock.timeouts().length, 0);
});

it('whole sample actual SDK retains exact historical text on ordinary snapshots, same-seat reconnect and failed reads', async t => {
  const h = await setup(t); await h.poll(report(inbound(), outbound(), pair(), remote()));
  const line = h.line(), historical = line.textContent, count = writes(line), jobs = [...h.clock.jobs.keys()];
  for (let i = 0; i < 3; i++) h.snapshot(roomState());
  Object.assign(h.sdk, { currentStatus: 'reconnecting' });
  h.sdk.dispatchEvent(new CustomEvent('status', { detail: 'reconnecting' }));
  assert.equal(line.textContent, historical); assert.equal(count(), 0); assert.equal(line.classList.contains('error'), true);
  assert.deepEqual([...h.clock.jobs.keys()], jobs); assert.equal(h.pending.length, 1);
  h.clock.advance(2000); h.pending.at(-1)!.work.reject(new Error('controlled failure')); await flushSample();
  assert.equal(line.textContent, historical); assert.equal(count(), 0); assert.equal(line.classList.contains('error'), true);
  const next = await h.poll(report(inbound(3000, 148, 2, 3, 150), outbound(3000), pair(0.02), remote(0.03, 0)));
  assert.equal(next.inbound?.lossPercent, 4); assert.equal(next.inbound?.bufferMs, 20);
  assert.equal(line.textContent, text(rx('4.0', '20', '20'), tx('0.0', '30'))); assert.equal(count(), 1);
  assert.equal(line.classList.contains('error'), false); assert.deepEqual([...h.clock.jobs.keys()], jobs);
});

it('whole sample actual SDK hidden resume keeps the shared delta interval and fences a retired completion', async t => {
  const h = await setup(t); await h.poll(report(inbound(), pair()));
  h.clock.advance(2000); const old = h.pending.at(-1)!.work;
  const retired = h.clock.jobs.get(h.timer)!.callback;
  h.setHidden(true); assert.equal(h.line().textContent, ''); assert.equal(h.line().classList.contains('error'), false);
  assert.equal(h.clock.jobs.size, 0); h.clock.advance(10000); assert.equal(h.pending.length, 2);
  h.setHidden(false); assert.equal(h.pending.length, 3); const timer = h.clock.intervals(2000)[0]!;
  retired(); assert.equal(h.pending.length, 3);
  const value = await h.resolve(report(inbound(14000, 243, 7, 6, 250), pair()));
  assert.equal(value.inbound?.lossPercent, 100 * 7 / 150); assert.equal(value.inbound?.bufferMs, 1000 * 4 / 150);
  assert.equal(h.line().textContent, text(rx('4.7', '43', '27'), noSend));
  old.resolve(report(inbound(3000), pair(0.9))); await flushSample();
  assert.deepEqual(h.completed.at(-1), { inbound: null, outbound: null });
  assert.equal(h.line().textContent, text(rx('4.7', '43', '27'), noSend));
  assert.deepEqual([...h.clock.jobs.keys()], [timer]); assert.equal(h.visibilityListeners.size, 1);
});

for (const identity of ['room', 'participant'] as const) {
  it(`whole sample actual SDK ${identity} replacement retires both directional histories without an extra read`, async t => {
    const h = await setup(t); await h.poll(report(inbound(), outbound(), pair(), remote()));
    const line = h.line(), count = writes(line); h.clock.advance(2000); const old = h.pending.at(-1)!.work;
    h.snapshot(identity === 'room' ? { ...roomState(), roomId: 'new-room' } : roomState({ participantId: 'new-person' }));
    assert.equal(line.textContent, ''); assert.equal(line.classList.contains('error'), false); assert.equal(count(), 1);
    assert.equal(h.pending.length, 2); assert.deepEqual(h.clock.intervals(2000), [h.timer]);
    old.resolve(report(inbound(2000), outbound(2000), pair(0.9), remote(0.8, 0.9))); await flushSample();
    assert.equal(line.textContent, ''); assert.equal(line.classList.contains('error'), false); assert.equal(count(), 1);
    h.clock.advance(2000); h.pending.at(-1)!.work.reject(new Error('new identity has no result')); await flushSample();
    assert.equal(line.textContent, ''); assert.equal(count(), 1);
    await h.poll(report(inbound(4000, 148, 2, 3, 150), outbound(4000), pair(0.02), remote(0.03, 0)));
    assert.equal(line.textContent, text(rx('4.0', '20', '20'), tx('0.0', '30')));
    assert.equal(line.classList.contains('error'), false); assert.equal(count(), 2); assert.equal(h.pending.length, 4);
  });
}

it('whole sample successful no-direction result clears warning and advances the UI completion watermark', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample(); h.sdk.snapshot(roomState());
  const line = h.find(node => node.classList.contains('connection'));
  h.clock.advance(2000); h.sdk.polls[0]!.resolve({ inbound: { rtt: 0.9, lossPercent: 90, bufferMs: 30 }, outbound: null });
  await flushSample(); assert.equal(line.textContent, text(rx('90.0', '900', '30'), noSend)); assert.equal(line.classList.contains('error'), true);
  const count = writes(line), timer = h.clock.intervals(2000)[0]!;
  h.clock.advance(6000); h.sdk.polls[2]!.resolve({ inbound: null, outbound: null }); await flushSample();
  assert.equal(line.textContent, ''); assert.equal(line.classList.contains('error'), false); assert.equal(count(), 1);
  h.sdk.polls[1]!.resolve({ inbound: { rtt: 0.8, lossPercent: 80 }, outbound: null }); await flushSample();
  assert.equal(line.textContent, ''); assert.equal(line.classList.contains('error'), false); assert.equal(count(), 1);
  assert.equal(h.sdk.polls[3]!.status, 'pending'); assert.deepEqual(h.clock.intervals(2000), [timer]);
  h.sdk.polls[3]!.resolve({ inbound: { rtt: 0, lossPercent: 0, bufferMs: 0 }, outbound: null }); await flushSample();
  assert.equal(line.textContent, text(rx('0.0', '0', '0'), noSend)); assert.equal(count(), 2);
  assert.deepEqual(h.sdk.joins, []); assert.deepEqual(h.sdk.raises, []); assert.deepEqual(h.sdk.previews, []);
  assert.deepEqual(h.sdk.inputDevices, []); assert.deepEqual(h.sdk.outputDevices, []);
});

it('whole sample actual SDK omissions and finite RTT conversion overflow display unavailable metrics', async t => {
  const h = await setup(t);
  let value = await h.poll(report(inbound(1000, 100, 0, 2, 100, { jitter: Infinity }), outbound(), pair(-1), remote(NaN, 1.1)));
  assert.equal(value.inbound?.rtt, undefined); assert.equal(value.outbound?.rtt, undefined); assert.equal(value.outbound?.lossPercent, undefined);
  assert.equal(h.line().textContent, text(rx(), tx())); assert.equal(h.line().classList.contains('error'), false);
  value = await h.poll(report(outbound(2000), remote(Number.MAX_VALUE, 0)));
  assert.equal(value.outbound?.rtt, Number.MAX_VALUE); assert.equal(Number.isFinite(value.outbound?.rtt), true);
  assert.equal(h.line().textContent, text(noReceive, tx('0.0'))); assert.equal(h.line().classList.contains('error'), false);
  value = await h.poll(report(inbound(3000), pair(Number.MAX_VALUE)));
  assert.equal(value.inbound?.rtt, Number.MAX_VALUE); assert.equal(h.line().textContent, text(rx(), noSend));
  assert.doesNotMatch(h.line().textContent, /NaN|Infinity/);
});
