import type { AppConfig } from '../config.ts';
import type { ClientMessageType } from '../../shared/protocol.ts';

/** Token bucket: `perSecond` sustained, bursts up to `perSecond`. */
class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly perSecond: number;
  constructor(perSecond: number, now: number) {
    this.perSecond = perSecond;
    this.tokens = perSecond;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Per-connection limits (AGENTS.md §S4): control ≤ N/s, `rtc:ice` ≤ M/s,
 * `hand:raise` at most once per interval. Any violation → caller disconnects.
 */
export class ConnectionRateLimiter {
  private readonly control: TokenBucket;
  private readonly ice: TokenBucket;
  private readonly handIntervalMs: number;
  private lastHandRaise = Number.NEGATIVE_INFINITY;

  constructor(limits: AppConfig['limits'], now: number) {
    this.control = new TokenBucket(limits.controlPerSecond, now);
    this.ice = new TokenBucket(limits.icePerSecond, now);
    this.handIntervalMs = limits.handRaiseIntervalMs;
  }

  /** Returns false if the message exceeds a limit. */
  allow(type: ClientMessageType, now: number): boolean {
    if (type === 'rtc:ice') return this.ice.take(now);
    if (!this.control.take(now)) return false;
    if (type === 'hand:raise') {
      if (now - this.lastHandRaise < this.handIntervalMs) return false;
      this.lastHandRaise = now;
    }
    return true;
  }
}
