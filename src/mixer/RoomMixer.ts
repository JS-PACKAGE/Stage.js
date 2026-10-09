import type { MixedPcmSource, MixFrame, MixFrameListener } from '../transport/MediaTransport.ts';
import { MixerCounters } from '../metrics.ts';
import { limitInPlace } from './limiter.ts';

/**
 * `playoutFrames`: frames a source must buffer before it plays (and again after every underrun).
 * `speakingThreshold`: frame RMS (0..1) at which a source counts as speaking; it stays speaking for
 * `speakingHoldMs` after dropping below, so pauses between words do not flap the indicator.
 */
export interface RoomMixerOptions { sampleRate: number; frameMs: number; maxBufferedFrames: number; playoutFrames: number; limiterThreshold: number; speakingThreshold: number; speakingHoldMs: number }
export type SpeakingListener = (participantIds: string[]) => void;
interface Source { muted: boolean; primed: boolean; frames: Float32Array[]; /** Ticks left in the speaking state. */ hold: number }

export class RoomMixer implements MixedPcmSource {
  private readonly sources = new Map<string, Source>();
  private readonly listeners = new Set<MixFrameListener>();
  private readonly speakingListeners = new Set<SpeakingListener>();
  private readonly holdFrames: number;
  private readonly opts: RoomMixerOptions;
  private readonly frameSize: number;
  private seq = 0;
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly counters: MixerCounters;
  /** `counters` may be shared by every room's mixer to keep process-wide totals. */
  constructor(opts: RoomMixerOptions, counters = new MixerCounters()) {
    if (!(opts.sampleRate > 0 && opts.frameMs > 0 && Number.isInteger(opts.maxBufferedFrames) && opts.maxBufferedFrames > 0 && Number.isInteger(opts.playoutFrames) && opts.playoutFrames > 0 && opts.playoutFrames <= opts.maxBufferedFrames && opts.limiterThreshold > 0 && opts.limiterThreshold < 1 && opts.speakingThreshold > 0 && opts.speakingThreshold < 1 && opts.speakingHoldMs >= 0)) throw new RangeError('Invalid mixer options');
    this.opts = opts;
    this.counters = counters;
    this.frameSize = Math.round(opts.sampleRate * opts.frameMs / 1000);
    this.holdFrames = Math.max(1, Math.ceil(opts.speakingHoldMs / opts.frameMs));
  }
  get sourceCount(): number { return this.sources.size; }
  addSource(id: string): void { if (!this.sources.has(id)) this.sources.set(id, { muted: false, primed: false, frames: [], hold: 0 }); }
  removeSource(id: string): void {
    const source = this.sources.get(id);
    this.sources.delete(id);
    if (source && source.hold > 0) this.emitSpeaking();
  }
  setMuted(id: string, muted: boolean): void {
    const source = this.sources.get(id);
    if (!source) return;
    source.muted = muted;
    if (muted && source.hold > 0) { source.hold = 0; this.emitSpeaking(); }
  }
  /** Exact frames only; copy on ingress so callers may reuse their input buffers. */
  push(id: string, samples: Float32Array): void {
    const source = this.sources.get(id);
    if (!source) return;
    if (samples.length !== this.frameSize) throw new RangeError('PCM frame has incorrect length');
    if (source.frames.length === this.opts.maxBufferedFrames) { source.frames.shift(); this.counters.droppedFrames++; }
    source.frames.push(samples.slice());
  }
  tick(): MixFrame | null {
    if (!this.sources.size) return null;
    this.counters.ticks++;
    const raw = new Float32Array(this.frameSize);
    // Per source: own contribution (null when silent/muted), replaced by its limited mix-minus once computed.
    const minus = new Map<string, Float32Array | null>();
    const own = new Set<string>();
    const playout = this.opts.playoutFrames;
    const energyThreshold = this.opts.speakingThreshold ** 2 * this.frameSize;
    let speakingChanged = false;
    for (const [id, source] of this.sources) {
      // Jitter buffer: start (or restart after an underrun) only once `playout` frames are queued,
      // and drain one extra frame when sender clock drift has doubled the queue.
      if (!source.primed && source.frames.length >= playout) source.primed = true;
      const samples = source.primed ? source.frames.shift() : undefined;
      if (!samples) { if (source.primed) this.counters.underruns++; source.primed = false; }
      else if (source.frames.length > 2 * playout) { source.frames.shift(); this.counters.droppedFrames++; }
      const contribution = source.muted ? undefined : samples;
      minus.set(id, contribution ?? null);
      let energy = 0;
      if (contribution) {
        own.add(id);
        for (let i = 0; i < raw.length; i++) { const s = contribution[i]!; raw[i] = raw[i]! + s; energy += s * s; }
      }
      const wasSpeaking = source.hold > 0;
      if (energy >= energyThreshold) source.hold = this.holdFrames;
      else if (source.hold > 0) source.hold--;
      if (wasSpeaking !== source.hold > 0) speakingChanged = true;
    }
    if (speakingChanged) this.emitSpeaking();
    const threshold = this.opts.limiterThreshold;
    const full = limitInPlace(raw.slice(), threshold);
    const frame: MixFrame = {
      seq: this.seq++, full,
      minus(id) {
        const entry = minus.get(id);
        if (entry === undefined) return undefined;
        // A silent source's mix-minus equals the full mix.
        if (entry === null) return full;
        if (!own.has(id)) return entry;
        const result = new Float32Array(raw.length);
        for (let i = 0; i < result.length; i++) result[i] = raw[i]! - entry[i]!;
        limitInPlace(result, threshold);
        minus.set(id, result); own.delete(id);
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
      const lag = performance.now() - deadline;
      if (lag > this.counters.maxTickLagMs) this.counters.maxTickLagMs = lag;
      if (lag > this.opts.frameMs) this.counters.lateTicks++;
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
  /** Called with the full speaking set whenever it changes. */
  onSpeaking(listener: SpeakingListener): () => void { this.speakingListeners.add(listener); return () => { this.speakingListeners.delete(listener); }; }
  private emitSpeaking(): void {
    const ids: string[] = [];
    for (const [id, source] of this.sources) if (source.hold > 0) ids.push(id);
    for (const listener of this.speakingListeners) listener(ids);
  }
}
