import type { MixedPcmSource, MixFrame, MixFrameListener } from '../transport/MediaTransport.ts';
import { limitInPlace } from './limiter.ts';

export interface RoomMixerOptions { sampleRate: number; frameMs: number; maxBufferedFrames: number; limiterThreshold: number }
interface Source { muted: boolean; frames: Float32Array[] }

export class RoomMixer implements MixedPcmSource {
  private readonly sources = new Map<string, Source>();
  private readonly listeners = new Set<MixFrameListener>();
  private readonly opts: RoomMixerOptions;
  private readonly frameSize: number;
  private seq = 0;
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(opts: RoomMixerOptions) {
    if (!(opts.sampleRate > 0 && opts.frameMs > 0 && Number.isInteger(opts.maxBufferedFrames) && opts.maxBufferedFrames > 0 && opts.limiterThreshold > 0 && opts.limiterThreshold < 1)) throw new RangeError('Invalid mixer options');
    this.opts = opts;
    this.frameSize = Math.round(opts.sampleRate * opts.frameMs / 1000);
  }
  get sourceCount(): number { return this.sources.size; }
  addSource(id: string): void { if (!this.sources.has(id)) this.sources.set(id, { muted: false, frames: [] }); }
  removeSource(id: string): void { this.sources.delete(id); }
  setMuted(id: string, muted: boolean): void { const source = this.sources.get(id); if (source) source.muted = muted; }
  /** Exact frames only; copy on ingress so callers may reuse their input buffers. */
  push(id: string, samples: Float32Array): void {
    const source = this.sources.get(id);
    if (!source) return;
    if (samples.length !== this.frameSize) throw new RangeError('PCM frame has incorrect length');
    if (source.frames.length === this.opts.maxBufferedFrames) source.frames.shift();
    source.frames.push(samples.slice());
  }
  tick(): MixFrame | null {
    if (!this.sources.size) return null;
    const raw = new Float32Array(this.frameSize);
    const own = new Map<string, Float32Array | undefined>();
    for (const [id, source] of this.sources) {
      const samples = source.frames.shift();
      const contribution = source.muted ? undefined : samples;
      own.set(id, contribution);
      if (contribution) for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! + contribution[i]!;
    }
    const cache = new Map<string, Float32Array>();
    const threshold = this.opts.limiterThreshold;
    const frame: MixFrame = {
      seq: this.seq++, full: limitInPlace(raw.slice(), threshold),
      minus(id) {
        if (!own.has(id)) return undefined;
        let result = cache.get(id);
        if (!result) {
          result = raw.slice();
          const samples = own.get(id);
          if (samples) for (let i = 0; i < result.length; i++) result[i] = result[i]! - samples[i]!;
          limitInPlace(result, threshold);
          cache.set(id, result);
        }
        return result;
      },
    };
    for (const listener of this.listeners) listener(frame);
    return frame;
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    let deadline = performance.now() + this.opts.frameMs;
    const run = () => {
      if (!this.running) return;
      this.tick();
      deadline += this.opts.frameMs;
      // Skip missed wall-clock slots instead of bursting old audio after a stall.
      const now = performance.now();
      if (deadline < now) deadline += Math.ceil((now - deadline) / this.opts.frameMs) * this.opts.frameMs;
      this.timer = setTimeout(run, Math.max(0, deadline - now));
    };
    this.timer = setTimeout(run, this.opts.frameMs);
  }
  stop(): void { this.running = false; clearTimeout(this.timer); this.timer = undefined; }
  onFrame(listener: MixFrameListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
