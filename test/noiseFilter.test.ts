import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoiseFilter } from '../src/mixer/noiseFilter.ts';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';

const opts = { highPassHz: 80, gateThreshold: 0.008, gateHoldMs: 40, gateFloor: 0.1 };
const N = 960;
let phase = 0;
/** Consecutive 20 ms frames of a sine, continuous across calls. */
const tone = (hz: number, amp: number) => {
  const f = new Float32Array(N);
  for (let i = 0; i < N; i++) f[i] = amp * Math.sin(2 * Math.PI * hz * (phase + i) / 48000);
  phase += N;
  return f;
};
const rms = (f: Float32Array) => Math.sqrt(f.reduce((s, x) => s + x * x, 0) / f.length);

test('high-pass removes DC and low rumble but keeps voice band', () => {
  const filter = new NoiseFilter({ ...opts, gateThreshold: 0 }, 48000, 20);
  let last = new Float32Array(N);
  for (let k = 0; k < 10; k++) { last = new Float32Array(N).fill(0.5); filter.process(last); }
  assert.ok(rms(last) < 1e-3, `DC leaks: ${rms(last)}`);
  for (let k = 0; k < 10; k++) { last = tone(20, 0.5); filter.process(last); }
  assert.ok(rms(last) < (0.5 / Math.SQRT2) * 0.08, `20 Hz rumble leaks: ${rms(last)}`);
  for (let k = 0; k < 10; k++) { last = tone(1000, 0.5); filter.process(last); }
  assert.ok(Math.abs(rms(last) / (0.5 / Math.SQRT2) - 1) < 0.01, 'voice band attenuated');
});

test('gate attenuates background noise after the hold, opens on speech without clicks', () => {
  const filter = new NoiseFilter(opts, 48000, 20);
  // Same high-pass with the gate always open, so ratios isolate the gate gain.
  const reference = new NoiseFilter({ ...opts, gateThreshold: 0 }, 48000, 20);
  const run = (frame: Float32Array) => { const ref = frame.slice(); reference.process(ref); filter.process(frame); return ref; };
  const gain = (amp: number) => { const f = tone(500, amp); const ref = run(f); return rms(f) / rms(ref); };
  assert.ok(Math.abs(gain(0.3) - 1) < 1e-6);
  // Hold: at least 2 quiet frames stay at unity (the high-pass ringing after the drop may count as
  // loud for a frame), then one frame ramps down and the gate sits at the floor.
  let open = 0, g = 1;
  while ((g = gain(0.004)) > 1 - 1e-6) open++;
  assert.ok(open >= 2 && open <= 3, `held ${open}`);
  assert.ok(g < 0.9 && g > 0.1);
  assert.ok(Math.abs(gain(0.004) - 0.1) < 1e-6);
  // Speech reopens within one frame, ramping up from the floor so the onset is not a step.
  const onset = tone(500, 0.3); const ref = run(onset);
  assert.ok(Math.abs(onset[100]! / ref[100]! - (0.1 + 0.9 * 101 / N)) < 1e-6);
  assert.ok(Math.abs(onset[N - 1]! / ref[N - 1]! - 1) < 1e-6);
  assert.ok(Math.abs(gain(0.3) - 1) < 1e-6);
});

test('mixer applies the filter per source only when configured', () => {
  const base = { sampleRate: 48000, frameMs: 20, maxBufferedFrames: 2, playoutFrames: 1, limiterThreshold: 0.9, speakingThreshold: 0.02, speakingHoldMs: 40 };
  const filtered = new RoomMixer({ ...base, noiseFilter: opts });
  const plain = new RoomMixer(base);
  for (const m of [filtered, plain]) m.addSource('a');
  let a = 0, b = 0;
  for (let k = 0; k < 10; k++) {
    const hum = new Float32Array(N).fill(0.3);
    filtered.push('a', hum); plain.push('a', hum);
    a = rms(filtered.tick()!.full); b = rms(plain.tick()!.full);
  }
  assert.ok(a < 1e-3);
  assert.ok(b > 0.25);
});
