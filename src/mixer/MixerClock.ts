import type { MixerCounters } from '../metrics.ts';

export interface Tickable { tick(): unknown }

/**
 * One wall-clock ticker for every room mixer. N rooms cost one timer instead of N drifting ones,
 * and all rooms emit their frames in the same turn, so codec work bound for one worker thread can
 * leave as a single message (see CodecPool).
 */
export class MixerClock {
  private readonly frameMs: number;
  private readonly counters: MixerCounters;
  private readonly members = new Set<Tickable>();
  private timer: NodeJS.Timeout | undefined;
  private deadline = 0;
  constructor(frameMs: number, counters: MixerCounters) { this.frameMs = frameMs; this.counters = counters; }
  /** Ticks `member` once per frame until the returned function is called; the timer runs only while members exist. */
  add(member: Tickable): () => void {
    this.members.add(member);
    if (!this.timer) {
      this.deadline = performance.now() + this.frameMs;
      this.timer = setTimeout(this.run, this.frameMs);
    }
    return () => {
      this.members.delete(member);
      if (!this.members.size) { clearTimeout(this.timer); this.timer = undefined; }
    };
  }
  private readonly run = (): void => {
    this.timer = undefined;
    const lag = performance.now() - this.deadline;
    if (lag > this.counters.maxTickLagMs) this.counters.maxTickLagMs = lag;
    if (lag > this.frameMs) this.counters.lateTicks++;
    for (const member of this.members) member.tick();
    // A member added during the ticks already restarted the clock (`add` saw no timer).
    if (this.timer || !this.members.size) return;
    this.deadline += this.frameMs;
    // Skip missed wall-clock slots instead of bursting old audio after a stall.
    const now = performance.now();
    if (this.deadline < now) this.deadline += Math.ceil((now - this.deadline) / this.frameMs) * this.frameMs;
    this.timer = setTimeout(this.run, Math.max(0, this.deadline - now));
  };
}
