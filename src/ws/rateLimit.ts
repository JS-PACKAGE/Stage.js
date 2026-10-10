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

/** At most one event per `intervalMs`. */
class Interval {
  private readonly intervalMs: number;
  private last = Number.NEGATIVE_INFINITY;
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }
  take(now: number): boolean {
    if (now - this.last < this.intervalMs) return false;
    this.last = now;
    return true;
  }
}

/**
 * Per-connection limits (AGENTS.md §S4): control ≤ N/s, `rtc:ice` ≤ M/s,
 * `hand:raise`, `chat:send` and `reaction` at most once per their interval. Any violation → caller disconnects.
 */
export class ConnectionRateLimiter {
  private readonly control: TokenBucket;
  private readonly ice: TokenBucket;
  private readonly spaced: Partial<Record<ClientMessageType, Interval>>;

  constructor(limits: AppConfig['limits'], now: number) {
    this.control = new TokenBucket(limits.controlPerSecond, now);
    this.ice = new TokenBucket(limits.icePerSecond, now);
    this.spaced = {
      'hand:raise': new Interval(limits.handRaiseIntervalMs),
      'chat:send': new Interval(limits.chatIntervalMs),
      reaction: new Interval(limits.reactionIntervalMs),
    };
  }

  /** Returns false if the message exceeds a limit. */
  allow(type: ClientMessageType, now: number): boolean {
    if (type === 'rtc:ice') return this.ice.take(now);
    if (!this.control.take(now)) return false;
    return this.spaced[type]?.take(now) ?? true;
  }
}
