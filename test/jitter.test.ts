import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtpReorderBuffer } from '../src/transport/jitter.ts';
import { OpusDecoder, OpusEncoder } from '../src/transport/opus.ts';
import { testConfig } from './helpers.ts';

const pkt = (n: number) => new Uint8Array([n]);
const ids = (out: (Uint8Array | null)[]) => out.map(p => (p === null ? null : p[0]));

test('reorder buffer restores order, drops late/duplicate packets and wraps at 65535', () => {
  const buf = new RtpReorderBuffer(2);
  assert.deepEqual(ids(buf.push(65534, pkt(1))), [1]);
  assert.deepEqual(ids(buf.push(0, pkt(3))), [], 'held behind the gap at 65535');
  assert.deepEqual(ids(buf.push(65535, pkt(2))), [2, 3]);
  assert.deepEqual(ids(buf.push(0, pkt(3))), [], 'duplicate of a released packet');
  assert.deepEqual(ids(buf.push(65535, pkt(2))), [], 'late');
});

test('reorder buffer declares a gap lost once more than `depth` packets wait behind it', () => {
  const buf = new RtpReorderBuffer(2);
  buf.push(10, pkt(10));
  assert.deepEqual(ids(buf.push(12, pkt(12))), []);
  assert.deepEqual(ids(buf.push(13, pkt(13))), []);
  assert.deepEqual(ids(buf.push(14, pkt(14))), [null, 12, 13, 14]);
  assert.deepEqual(ids(buf.push(11, pkt(11))), [], 'too late once concealed');
});

test('reorder buffer resyncs on a large sequence jump instead of concealing it', () => {
  const buf = new RtpReorderBuffer(2);
  buf.push(100, pkt(1));
  assert.deepEqual(ids(buf.push(5000, pkt(2))), [2]);
  assert.deepEqual(ids(buf.push(5001, pkt(3))), [3]);
});

test('decoder conceals lost packets by fading the last frame to silence', () => {
  const audio = testConfig().audio;
  const enc = new OpusEncoder(audio);
  const dec = new OpusDecoder(audio.sampleRate);
  assert.equal(dec.decode(null).length, 0, 'nothing to conceal before the first packet');
  const tone = new Float32Array(enc.frameSize).map((_, i) => 0.5 * Math.sin(i / 8));
  const good = dec.decode(enc.encode(tone));
  const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const first = dec.decode(null);
  assert.equal(first.length, good.length);
  assert.ok(Math.abs(peak(first) - peak(good) / 2) < 1e-6);
  for (let i = 0; i < 3; i++) dec.decode(null);
  assert.equal(peak(dec.decode(null)), 0, 'silent after the fade-out');
  assert.ok(peak(dec.decode(enc.encode(tone))) > 0, 'recovers on the next real packet');
});
