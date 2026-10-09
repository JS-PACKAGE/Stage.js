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

test('decoder rebuilds a lost packet from the next packet\'s in-band FEC, better than plain concealment', () => {
  // libopus spends FEC bits only on SILK/hybrid frames it judges to be speech: feed a noisy,
  // pitch-gliding, amplitude-modulated signal (deterministic PRNG) at a speech bitrate.
  const audio = testConfig(c => { c.audio.opus.minBitrate = 6000; c.audio.opus.bitrate = 24000; c.audio.opus.dtx = false; }).audio;
  const enc = new OpusEncoder(audio);
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const voice = (f: number) => Float32Array.from({ length: enc.frameSize }, (_, i) => {
    const t = (f * enc.frameSize + i) / audio.sampleRate;
    return (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)) * (0.2 * Math.sin(2 * Math.PI * (140 + 30 * Math.sin(2 * Math.PI * 2 * t)) * t) + 0.05 * noise());
  });
  const packets = Array.from({ length: 60 }, (_, f) => enc.encode(voice(f)));
  const reference = new OpusDecoder(audio.sampleRate);
  const lossless = packets.map(p => reference.decode(p));
  const snrDb = (out: Float32Array, ref: Float32Array) => {
    let noise = 0, signal = 0;
    for (let i = 0; i < ref.length; i++) { noise += (out[i]! - ref[i]!) ** 2; signal += ref[i]! ** 2; }
    return 10 * Math.log10(signal / noise);
  };
  const recover = (useFec: boolean) => {
    const dec = new OpusDecoder(audio.sampleRate);
    assert.equal(dec.conceal(null).length, 0, 'nothing to conceal before the first packet');
    const snr: number[] = [];
    for (let f = 0; f < packets.length; f++) {
      if (f % 10 === 5) {
        const out = dec.conceal(useFec ? packets[f + 1]! : null);
        assert.equal(out.length, enc.frameSize, 'a lost packet is replaced by one frame of audio');
        snr.push(snrDb(out, lossless[f]!));
      } else dec.decode(packets[f]!);
    }
    return snr;
  };
  const fec = recover(true), plc = recover(false);
  fec.forEach((db, i) => assert.ok(db > plc[i]! + 5, `loss ${i}: FEC ${db.toFixed(1)} dB vs PLC ${plc[i]!.toFixed(1)} dB`));
});
