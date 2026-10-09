/**
 * Per-source uplink cleanup applied before mixing:
 * - `highPassHz`: 2nd-order Butterworth high-pass removing rumble, handling noise and DC.
 * - `gateThreshold`: frame RMS (0..1, after the high-pass) below which the source is treated as
 *   background noise; after `gateHoldMs` of such frames the gain ramps down to `gateFloor`
 *   (a floor > 0 keeps the room tone natural instead of hard-cutting it).
 * Gain changes ramp linearly across one frame so the gate never clicks.
 */
export interface NoiseFilterOptions { highPassHz: number; gateThreshold: number; gateHoldMs: number; gateFloor: number }

export class NoiseFilter {
  private readonly b0: number; private readonly b1: number; private readonly b2: number;
  private readonly a1: number; private readonly a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private readonly holdFrames: number;
  private hold = 0;
  private gain = 1;
  private readonly opts: NoiseFilterOptions;

  constructor(opts: NoiseFilterOptions, sampleRate: number, frameMs: number) {
    if (!(opts.highPassHz > 0 && opts.highPassHz < sampleRate / 2 && opts.gateThreshold >= 0 && opts.gateThreshold < 1 && opts.gateHoldMs >= 0 && opts.gateFloor >= 0 && opts.gateFloor <= 1)) throw new RangeError('Invalid noise filter options');
    this.opts = opts;
    this.holdFrames = Math.ceil(opts.gateHoldMs / frameMs);
    // RBJ cookbook high-pass, Q = 1/√2.
    const w = 2 * Math.PI * opts.highPassHz / sampleRate;
    const alpha = Math.sin(w) / Math.SQRT2;
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0; this.b1 = -(1 + cos) / a0; this.b2 = this.b0;
    this.a1 = -2 * cos / a0; this.a2 = (1 - alpha) / a0;
  }

  /** Filters `samples` in place; frames must arrive in playout order. */
  process(samples: Float32Array): void {
    let { x1, x2, y1, y2 } = this;
    let energy = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      const y = this.b0 * x + this.b1 * x1 + this.b2 * x2 - this.a1 * y1 - this.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      samples[i] = y;
      energy += y * y;
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
    if (energy >= this.opts.gateThreshold ** 2 * samples.length) this.hold = this.holdFrames + 1;
    const target = this.hold > 0 ? 1 : this.opts.gateFloor;
    if (this.hold > 0) this.hold--;
    const start = this.gain;
    if (start === 1 && target === 1) return;
    const step = (target - start) / samples.length;
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * (start + step * (i + 1));
    this.gain = target;
  }
}
