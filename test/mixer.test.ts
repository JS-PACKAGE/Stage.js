import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import { limitInPlace } from '../src/mixer/limiter.ts';
const options = { sampleRate: 48000, frameMs: 20, maxBufferedFrames: 2, limiterThreshold: 0.9 };
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
