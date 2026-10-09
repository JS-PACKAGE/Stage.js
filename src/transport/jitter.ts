/** Sequence jumps beyond this many packets are treated as a stream restart, not as loss. */
const RESYNC_GAP = 100;

/**
 * Restores RTP sequence order before the stateful Opus decoder sees packets.
 * Out-of-order packets are held until the gap fills; once more than `depth`
 * packets wait behind a gap, the missing packet is declared lost (`null`) so the
 * decoder can conceal it. Late and duplicate packets are dropped.
 */
export class RtpReorderBuffer {
  private readonly depth: number;
  private readonly held = new Map<number, Uint8Array>();
  /** Next expected sequence number; -1 until the first packet. */
  private next = -1;
  constructor(depth: number) { this.depth = depth; }
  /** Returns the payloads now releasable in sequence order; `null` marks a lost packet. */
  push(seq: number, payload: Uint8Array): (Uint8Array | null)[] {
    const out: (Uint8Array | null)[] = [];
    if (this.next < 0) this.next = seq;
    const ahead = (seq - this.next) & 0xffff;
    const behind = ahead >= 0x8000;
    if ((behind ? 0x10000 - ahead : ahead) > RESYNC_GAP) { this.held.clear(); this.next = seq; }
    else if (behind || this.held.has(seq)) return out;
    this.held.set(seq, payload);
    this.drain(out);
    while (this.held.size > this.depth) {
      out.push(null);
      this.next = (this.next + 1) & 0xffff;
      this.drain(out);
    }
    return out;
  }
  private drain(out: (Uint8Array | null)[]): void {
    let payload: Uint8Array | undefined;
    while ((payload = this.held.get(this.next)) !== undefined) {
      this.held.delete(this.next);
      out.push(payload);
      this.next = (this.next + 1) & 0xffff;
    }
  }
}
