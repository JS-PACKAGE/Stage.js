/**
 * Minimal Ogg Opus muxer (RFC 7845) for one mono stream of fixed-duration packets: the room's
 * already-encoded full mix, so recording costs no extra encode.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04c11db7, unreflected, zero initial value and no final xor. */
export function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
/** Flush at least once a second of 20 ms packets, so a crash loses little and pages stay small. */
const PACKETS_PER_PAGE = 50;

export interface OggOpusOptions {
  /** Samples (at 48 kHz) each packet covers. */
  frameSamples: number;
  serial: number;
  /** OpusTags vendor string. */
  vendor: string;
}

export class OggOpusWriter {
  private readonly write: (chunk: Uint8Array) => void;
  private readonly frameSamples: number;
  private readonly serial: number;
  private pageSeq = 0;
  private granule = 0n;
  private pending: Uint8Array[] = [];
  private pendingSegments = 0;
  /** TOC byte of the last real packet: concealment packets reuse its mode and frame size. */
  private lastToc: number | undefined;
  private closed = false;

  constructor(write: (chunk: Uint8Array) => void, options: OggOpusOptions) {
    this.write = write;
    this.frameSamples = options.frameSamples;
    this.serial = options.serial >>> 0;
    const head = new Uint8Array(19);
    const view = new DataView(head.buffer);
    head.set(new TextEncoder().encode('OpusHead'));
    head[8] = 1; // version
    head[9] = 1; // channels
    view.setUint16(10, 0, true); // pre-skip: the shared encoder has been running, so nothing to trim
    view.setUint32(12, 48000, true); // original input rate
    view.setInt16(16, 0, true); // output gain
    head[18] = 0; // mapping family 0 (mono/stereo)
    this.page([head], FLAG_BOS, 0n);
    const vendor = new TextEncoder().encode(options.vendor);
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set(new TextEncoder().encode('OpusTags'));
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    new DataView(tags.buffer).setUint32(12 + vendor.length, 0, true);
    this.page([tags], 0, 0n);
  }

  /**
   * Append one frame. `null` (or empty: DTX) marks a frame with no packet; it becomes a TOC-only
   * packet with a zero-length frame, which decoders conceal, so the timeline never shifts.
   * Frames before the first real packet are dropped: there is no TOC to copy yet.
   */
  packet(packet: Uint8Array | null): void {
    if (this.closed) return;
    if (packet && packet.length > 0) this.lastToc = packet[0]!;
    else if (this.lastToc === undefined) return;
    else packet = Uint8Array.of(this.lastToc & 0xfc);
    this.push(packet);
  }

  /** Write the final page (end of stream). Further packets are ignored. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Pages are flushed only when the next packet would not fit, so once a real packet arrived there
    // is always one pending here: the EOS flag lands on a page with data and adds no extra frame.
    if (this.pending.length) this.flush(FLAG_EOS);
  }

  private push(packet: Uint8Array): void {
    const segments = Math.floor(packet.length / 255) + 1;
    if (this.pending.length >= PACKETS_PER_PAGE || this.pendingSegments + segments > 255) this.flush(0);
    this.pending.push(packet);
    this.pendingSegments += segments;
    this.granule += BigInt(this.frameSamples);
  }

  /** A page's granule position is the end of its last packet, i.e. everything pushed so far. */
  private flush(flags: number): void {
    const packets = this.pending;
    this.pending = [];
    this.pendingSegments = 0;
    this.page(packets, flags, this.granule);
  }

  /** One page holding whole packets; callers keep the lacing table within 255 segments. */
  private page(packets: Uint8Array[], flags: number, granule: bigint): void {
    const lacing: number[] = [];
    for (const p of packets) {
      let left = p.length;
      while (left >= 255) { lacing.push(255); left -= 255; }
      lacing.push(left);
    }
    if (lacing.length > 255) throw new RangeError('Ogg page exceeds 255 segments');
    const bodyLength = packets.reduce((n, p) => n + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLength);
    const view = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
    page[4] = 0;
    page[5] = flags;
    view.setBigUint64(6, granule, true);
    view.setUint32(14, this.serial, true);
    view.setUint32(18, this.pageSeq++, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let at = 27 + lacing.length;
    for (const p of packets) { page.set(p, at); at += p.length; }
    view.setUint32(22, oggCrc(page), true);
    this.write(page);
  }
}
