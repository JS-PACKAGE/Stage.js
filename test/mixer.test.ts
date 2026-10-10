import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import { MixerCounters } from '../src/metrics.ts';
import { limitInPlace } from '../src/mixer/limiter.ts';
import { MixerClock } from '../src/mixer/MixerClock.ts';
import { setTimeout as sleep } from 'node:timers/promises';
const options = { sampleRate: 48000, frameMs: 20, maxBufferedFrames: 2, playoutFrames: 1, limiterThreshold: 0.9, speakingThreshold: 0.02, speakingHoldMs: 40 };
const samples = (value: number) => new Float32Array(960).fill(value);
test('sum, minus-self, missing frames and muted membership', () => {
  const mixer = new RoomMixer(options);
  assert.equal(mixer.tick(), null);
  mixer.push('unknown', samples(1));
  mixer.addSource('a'); mixer.addSource('a'); mixer.addSource('b');
  assert.equal(mixer.sourceCount, 2);
  mixer.push('a', samples(0.2)); mixer.push('b', samples(0.3));
  const frame = mixer.tick()!;
  assert.ok(Math.abs(frame.full[0]! - 0.5) < 1e-6);
  assert.ok(Math.abs(frame.minus('a')![0]! - 0.3) < 1e-6);
  assert.equal(frame.minus('unknown'), undefined);
  mixer.setMuted('a', true); mixer.push('a', samples(0.8)); mixer.push('b', samples(0.3));
  const muted = mixer.tick()!;
  assert.deepEqual(muted.full, muted.minus('a'));
  assert.equal(mixer.tick()!.full[0], 0);
  mixer.removeSource('a'); mixer.removeSource('b'); assert.equal(mixer.tick(), null);
});
test('FIFO drops oldest and rejects malformed frames', () => {
  const mixer = new RoomMixer(options); mixer.addSource('a');
  mixer.push('a', samples(0.1)); mixer.push('a', samples(0.2)); mixer.push('a', samples(0.3));
  assert.ok(Math.abs(mixer.tick()!.full[0]! - 0.2) < 1e-6);
  assert.ok(Math.abs(mixer.tick()!.full[0]! - 0.3) < 1e-6);
  assert.throws(() => mixer.push('a', new Float32Array(1)), RangeError);
});
test('limiter bounded and transparent, minus computed before limiting', () => {
  const input = new Float32Array([-100, -0.8, 0, 0.8, 100]);
  limitInPlace(input, 0.9);
  assert.ok(input.every(x => x >= -1 && x <= 1)); assert.equal(input[1], Math.fround(-0.8)); assert.equal(input[3], Math.fround(0.8));
  const mixer = new RoomMixer(options); mixer.addSource('a'); mixer.addSource('b');
  mixer.push('a', samples(0.8)); mixer.push('b', samples(0.8));
  const frame = mixer.tick()!;
  assert.ok(frame.full[0]! <= 1); assert.ok(Math.abs(frame.minus('a')![0]! - 0.8) < 1e-6);
});
test('jitter buffer primes, re-primes after underrun and drains drift', () => {
  const counters = new MixerCounters();
  const mixer = new RoomMixer({ ...options, maxBufferedFrames: 10, playoutFrames: 2 }, counters); mixer.addSource('a');
  mixer.push('a', samples(0.1));
  assert.equal(mixer.tick()!.full[0], 0, 'one frame is below the playout target');
  mixer.push('a', samples(0.2));
  assert.ok(Math.abs(mixer.tick()!.full[0]! - 0.1) < 1e-6);
  assert.ok(Math.abs(mixer.tick()!.full[0]! - 0.2) < 1e-6);
  assert.equal(mixer.tick()!.full[0], 0, 'underrun');
  mixer.push('a', samples(0.3));
  assert.equal(mixer.tick()!.full[0], 0, 'underrun re-primes instead of playing a lone frame');
  for (const v of [0.4, 0.5, 0.6, 0.7, 0.8]) mixer.push('a', samples(v));
  // Queue 0.3..0.8 (6 > 2×2): play 0.3 and drop 0.4 to pull latency back.
  assert.ok(Math.abs(mixer.tick()!.full[0]! - 0.3) < 1e-6);
  assert.ok(Math.abs(mixer.tick()!.full[0]! - 0.5) < 1e-6);
  assert.deepEqual([counters.ticks, counters.underruns, counters.droppedFrames], [7, 1, 1], 'one underrun after 0.2, one drift drop');
});
test('jitter buffer sheds standing latency one frame per window until it sits at the playout target', () => {
  const counters = new MixerCounters();
  const mixer = new RoomMixer({ ...options, maxBufferedFrames: 10, playoutFrames: 2 }, counters); mixer.addSource('a');
  // A burst at start leaves 4 frames queued at each tick (3 waiting behind the one played; below
  // the 2×playout drift drain); afterwards frames arrive exactly once per tick.
  let pushed = 0;
  for (; pushed < 3; pushed++) mixer.push('a', samples(pushed / 1000));
  const lag: number[] = [];
  for (let tick = 0; tick < 200; tick++) {
    mixer.push('a', samples(pushed++ / 1000));
    const played = Math.round(mixer.tick()!.full[0]! * 1000);
    lag.push(pushed - 1 - played);
  }
  // Window = 1000 ms / 20 ms = 50 ticks: trimmed at the 50th and 100th tick, then the queue sits at
  // the target (2 at tick time: the frame played plus one waiting).
  assert.deepEqual([lag[0], lag[48], lag[49], lag[98], lag[99], lag[199]], [3, 3, 2, 2, 1, 1]);
  assert.equal(counters.droppedFrames, 2);
  assert.equal(counters.underruns, 0);
});
test('muting discards queued audio and does not count as an underrun', () => {
  const counters = new MixerCounters();
  const mixer = new RoomMixer({ ...options, maxBufferedFrames: 10, playoutFrames: 1 }, counters); mixer.addSource('a');
  mixer.push('a', samples(0.1)); mixer.push('a', samples(0.2));
  assert.ok(Math.abs(mixer.tick()!.full[0]! - 0.1) < 1e-6);
  mixer.setMuted('a', true);
  mixer.push('a', samples(0.3));
  for (let i = 0; i < 5; i++) assert.equal(mixer.tick()!.full[0], 0);
  mixer.setMuted('a', false);
  mixer.push('a', samples(0.4));
  assert.ok(Math.abs(mixer.tick()!.full[0]! - 0.4) < 1e-6, 'neither 0.2 (queued before mute) nor 0.3 (pushed while muted) plays');
  assert.equal(counters.underruns, 0);
});
test('speaking set follows voice activity with a release hold, mute and removal', () => {
  const mixer = new RoomMixer(options); mixer.addSource('a'); mixer.addSource('b');
  const events: string[][] = [];
  mixer.onSpeaking(ids => events.push(ids));
  mixer.push('a', samples(0.5)); mixer.push('b', samples(0.001)); mixer.tick();
  assert.deepEqual(events, [['a']], 'quiet source b stays below the threshold');
  mixer.tick();
  assert.equal(events.length, 1, 'held through a one-frame pause (hold = 40 ms = 2 frames)');
  mixer.tick();
  assert.deepEqual(events.at(-1), [], 'released after the hold');
  mixer.push('a', samples(0.5)); mixer.tick();
  mixer.setMuted('a', true);
  assert.deepEqual(events.slice(-2), [['a'], []], 'muting clears immediately');
  mixer.setMuted('a', false); mixer.push('a', samples(0.5)); mixer.push('b', samples(0.5)); mixer.tick();
  assert.deepEqual(events.at(-1), ['a', 'b']);
  mixer.removeSource('a');
  assert.deepEqual(events.at(-1), ['b'], 'removal of a speaking source is reported');
});
// Real clock on purpose: MixerClock schedules by performance.now(), which node:test's mock timers
// do not control, and the behaviour under test is how it reacts to the event loop being blocked.
test('the shared clock skips the slots it missed after a stall instead of bursting them', async () => {
  const counters = new MixerCounters();
  const clock = new MixerClock(20, counters);
  const ticks: number[] = [];
  const detach = clock.add({ tick() { ticks.push(performance.now()); } });
  let stalledAt = 0;
  // Something else blocks the thread for ~5 frames (GC pause, a burst of DTLS handshakes).
  setTimeout(() => { stalledAt = performance.now(); const end = stalledAt + 100; while (performance.now() < end); }, 70);
  try {
    await sleep(400);
  } finally { detach(); }
  const afterStall = ticks.filter((t) => t > stalledAt);
  // Catching up would fire ~5 ticks back to back; skipping keeps the gaps near one frame.
  const tightGaps = afterStall.slice(1).filter((t, i) => t - afterStall[i]! < 5).length;
  assert.ok(tightGaps <= 1, `burst of ${tightGaps} near-zero gaps after the stall`);
  assert.ok(counters.lateTicks >= 1 && counters.maxTickLagMs >= 60, `stall reported (late ${counters.lateTicks}, max lag ${counters.maxTickLagMs})`);
  assert.ok(ticks.length <= 20, `${ticks.length} ticks in 400 ms: missed slots were not replayed`);
});
