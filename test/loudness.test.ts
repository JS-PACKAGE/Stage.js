import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoudnessNormalizer } from '../src/mixer/loudness.ts';

const opts = { targetRms: 0.1, maxGainDb: 12, speechRms: 0.01, adaptMs: 1000 };
const N = 960;
const rms = (f: Float32Array) => Math.sqrt(f.reduce((s, x) => s + x * x, 0) / f.length);
const tone = (amp: number) => Float32Array.from({ length: N }, (_, i) => amp * Math.SQRT2 * Math.sin(2 * Math.PI * 500 * i / 48000));
/** Feeds `frames` frames of `amp` RMS and returns the last processed frame's RMS. */
const settle = (n: LoudnessNormalizer, amp: number, frames: number) => {
  let out = 0;
  for (let k = 0; k < frames; k++) { const f = tone(amp); n.process(f); out = rms(f); }
  return out;
};

test('quiet and loud speakers converge to the target level', () => {
  const quiet = new LoudnessNormalizer(opts, 20), loud = new LoudnessNormalizer(opts, 20);
  assert.ok(Math.abs(settle(quiet, 0.04, 400) - 0.1) < 0.005);
  assert.ok(Math.abs(settle(loud, 0.3, 400) - 0.1) < 0.005);
});

test('gain is capped at ±maxGainDb', () => {
  const whisper = new LoudnessNormalizer(opts, 20), shout = new LoudnessNormalizer(opts, 20);
  assert.ok(Math.abs(settle(whisper, 0.012, 400) - 0.012 * 10 ** (12 / 20)) < 1e-3, 'boost stops at +12 dB');
  assert.ok(Math.abs(settle(shout, 0.9, 400) - 0.9 / 10 ** (12 / 20)) < 1e-3, 'cut stops at −12 dB');
});

test('pauses do not pump the gain: frames below speechRms keep the speech-based gain', () => {
  const n = new LoudnessNormalizer(opts, 20);
  settle(n, 0.04, 400);
  // 2.5 → gain for a 0.004-RMS background frame is the speech gain, not the +12 dB cap.
  assert.ok(Math.abs(settle(n, 0.004, 200) / 0.004 - 2.5) < 0.05);
  assert.equal(settle(new LoudnessNormalizer(opts, 20), 0.004, 50), rms(tone(0.004)), 'unity until the source first speaks');
});

test('a gain change ramps across the frame instead of stepping', () => {
  const n = new LoudnessNormalizer(opts, 20);
  const first = tone(0.04);
  const input = first.slice();
  n.process(first);
  // Gain ramps from 1 to 2.5 (0.1 / 0.04) over the first frame.
  const g = (i: number) => first[i]! / input[i]!;
  assert.ok(Math.abs(g(12) - (1 + 1.5 * 13 / N)) < 1e-4);
  assert.ok(Math.abs(g(N - 13) - (1 + 1.5 * (N - 12) / N)) < 1e-4);
});
