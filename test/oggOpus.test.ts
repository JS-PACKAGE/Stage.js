import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OggOpusWriter, oggCrc } from '../src/recording/oggOpus.ts';

interface Page { flags: number; granule: bigint; seq: number; serial: number; packets: Uint8Array[] }

/** Splits a stream into pages, checking capture pattern and CRC, and rebuilds packets from lacing. */
function parse(bytes: Uint8Array): Page[] {
  const pages: Page[] = [];
  let at = 0;
  while (at < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    assert.equal(String.fromCharCode(...bytes.subarray(at, at + 4)), 'OggS');
    const segments = bytes[at + 26]!;
    const lacing = bytes.subarray(at + 27, at + 27 + segments);
    const length = 27 + segments + lacing.reduce((n, l) => n + l, 0);
    const page = bytes.slice(at, at + length);
    const crc = view.getUint32(22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    assert.equal(oggCrc(page), crc, 'page CRC');
    const packets: Uint8Array[] = [];
    let body = at + 27 + segments, size = 0;
    for (const l of lacing) {
      size += l;
      if (l < 255) { packets.push(bytes.slice(body, body + size)); body += size; size = 0; }
    }
    pages.push({ flags: bytes[at + 5]!, granule: view.getBigUint64(6, true), seq: view.getUint32(18, true), serial: view.getUint32(14, true), packets });
    at += length;
  }
  return pages;
}

function record(feed: (w: OggOpusWriter) => void): Page[] {
  const chunks: Uint8Array[] = [];
  const w = new OggOpusWriter((c) => chunks.push(c), { frameSamples: 960, serial: 7, vendor: 'test' });
  feed(w);
  w.close();
  // A plain copy: Buffer#slice would alias the pool and break the CRC check.
  return parse(new Uint8Array(Buffer.concat(chunks)));
}

describe('Ogg Opus writer', () => {
  it('writes OpusHead and OpusTags pages, then audio with granule = samples so far and EOS last', () => {
    const pages = record((w) => { for (let i = 0; i < 120; i++) w.packet(Uint8Array.of(0xf8, i)); });
    assert.equal(pages[0]!.flags, 0x02);
    assert.equal(String.fromCharCode(...pages[0]!.packets[0]!.subarray(0, 8)), 'OpusHead');
    assert.equal(pages[0]!.packets[0]![9], 1, 'mono');
    assert.equal(String.fromCharCode(...pages[1]!.packets[0]!.subarray(0, 8)), 'OpusTags');
    const audio = pages.slice(2);
    assert.deepEqual(audio.flatMap((p) => p.packets).map((p) => p[1]), Array.from({ length: 120 }, (_, i) => i));
    let total = 0n;
    for (const p of audio) { total += BigInt(p.packets.length) * 960n; assert.equal(p.granule, total); }
    assert.equal(audio.at(-1)!.flags, 0x04);
    assert.deepEqual(pages.map((p) => p.seq), pages.map((_, i) => i));
    assert.ok(pages.every((p) => p.serial === 7));
  });

  it('conceals missing frames with TOC-only packets after the first real one and drops them before', () => {
    const pages = record((w) => { w.packet(null); w.packet(Uint8Array.of(0xf9, 1, 2)); w.packet(null); w.packet(new Uint8Array(0)); });
    assert.deepEqual(pages.slice(2).flatMap((p) => p.packets).map((p) => [...p]), [[0xf9, 1, 2], [0xf8], [0xf8]]);
    assert.equal(pages.at(-1)!.granule, 3n * 960n);
  });

  it('keeps pages within 255 lacing segments for large packets', () => {
    const big = new Uint8Array(1275).fill(1);
    big[0] = 0xf8;
    const pages = record((w) => { for (let i = 0; i < 60; i++) w.packet(big); });
    assert.equal(pages.slice(2).reduce((n, p) => n + p.packets.length, 0), 60);
    assert.ok(pages.slice(2).every((p) => p.packets.every((x) => x.length === 1275)));
  });

  it('writes no audio pages for a recording that never got a packet', () => {
    assert.equal(record(() => {}).length, 2);
  });
});
