/**
 * Per-source automatic gain applied before mixing, so a quiet microphone and a loud one land at a
 * similar level in the mix (the limiter only catches peaks of the sum).
 * - Only frames with RMS ≥ `speechRms` update the level estimate, so pauses and background noise
 *   never pump the gain up.
 * - The estimate follows speech with time constant `adaptMs`; gain = `targetRms` / estimate,
 *   clamped to ±`maxGainDb`.
 * Gain changes ramp linearly across one frame, like the noise gate, so they never click.
 */
export interface LoudnessOptions { targetRms: number; maxGainDb: number; speechRms: number; adaptMs: number }

export class LoudnessNormalizer {
  private readonly opts: LoudnessOptions;
  private readonly maxGain: number;
  /** Fraction of the distance to the newest speech frame's RMS the estimate moves per frame. */
  private readonly rate: number;
  /** Smoothed speech RMS; 0 until the source first speaks. */
  private level = 0;
  private gain = 1;
  constructor(opts: LoudnessOptions, frameMs: number) {
    if (!(opts.targetRms > 0 && opts.targetRms < 1 && opts.maxGainDb >= 0 && opts.speechRms > 0 && opts.speechRms < 1 && opts.adaptMs >= frameMs)) throw new RangeError('Invalid loudness options');
    this.opts = opts;
    this.maxGain = 10 ** (opts.maxGainDb / 20);
    this.rate = frameMs / opts.adaptMs;
  }
  /** Scales `samples` in place; frames must arrive in playout order. */
  process(samples: Float32Array): void {
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += samples[i]! * samples[i]!;
    const rms = Math.sqrt(energy / samples.length);
    if (rms >= this.opts.speechRms) this.level = this.level === 0 ? rms : this.level + this.rate * (rms - this.level);
    const target = this.level === 0 ? 1 : Math.min(this.maxGain, Math.max(1 / this.maxGain, this.opts.targetRms / this.level));
    const start = this.gain;
    if (start === 1 && target === 1) return;
    const step = (target - start) / samples.length;
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * (start + step * (i + 1));
    this.gain = target;
  }
}
