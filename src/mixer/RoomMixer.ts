import type { MixedPcmSource, MixFrame, MixFrameListener } from '../transport/MediaTransport.ts';
import { MixerCounters } from '../metrics.ts';
import { limitInPlace } from './limiter.ts';
import type { MixerClock } from './MixerClock.ts';
import { LoudnessNormalizer, type LoudnessOptions } from './loudness.ts';
import { NoiseFilter, type NoiseFilterOptions } from './noiseFilter.ts';

/**
 * `playoutFrames`: frames a source must buffer before it plays (and again after every underrun).
 * `speakingThreshold`: frame RMS (0..1) at which a source counts as speaking; it stays speaking for
 * `speakingHoldMs` after dropping below, so pauses between words do not flap the indicator.
 * `noiseFilter`: when set, every source is high-passed and noise-gated on ingress (see NoiseFilter).
 * `loudness`: when set, every source is then level-normalized on ingress (see LoudnessNormalizer).
 */
export interface RoomMixerOptions { sampleRate: number; frameMs: number; maxBufferedFrames: number; playoutFrames: number; limiterThreshold: number; speakingThreshold: number; speakingHoldMs: number; noiseFilter?: NoiseFilterOptions; loudness?: LoudnessOptions }
export type SpeakingListener = (participantIds: string[]) => void;
interface Source {
  muted: boolean; primed: boolean; frames: FrameQueue;
  /** Fewest frames queued at any tick of the current convergence window. */
  low: number;
  /** Ticks left in the speaking state. */ hold: number;
  filter: NoiseFilter | undefined; loudness: LoudnessNormalizer | undefined;
  /** Manual trim (linear): `gain` is what the last frame ended on, `targetGain` what was asked for. */
  gain: number; targetGain: number;
  /** This tick's audible frame (a queue slot), null when silent, muted or starved. */
  contribution: Float32Array | null;
  /** This tick's limited mix-minus; meaningful only while `contribution` is set. */
  readonly minus: Float32Array;
}

/** Fixed-capacity FIFO over preallocated frames, so steady-state mixing allocates nothing. */
class FrameQueue {
  private readonly slots: Float32Array[];
  private head = 0;
  length = 0;
  constructor(capacity: number, frameSize: number) { this.slots = Array.from({ length: capacity }, () => new Float32Array(frameSize)); }
  get full(): boolean { return this.length === this.slots.length; }
  /** Copies `samples` into the next slot, dropping the oldest frame when full; returns the slot. */
  push(samples: Float32Array): Float32Array {
    if (this.full) this.shift();
    const slot = this.slots[(this.head + this.length++) % this.slots.length]!;
    slot.set(samples);
    return slot;
  }
  /** The returned slot stays intact until the queue wraps onto it, i.e. at least until the next push. */
  shift(): Float32Array | undefined {
    if (!this.length) return undefined;
    const slot = this.slots[this.head]!;
    this.head = (this.head + 1) % this.slots.length;
    this.length--;
    return slot;
  }
  clear(): void { this.head = 0; this.length = 0; }
}
/**
 * Once primed, a queue only grows (packet bursts, a source that started mid-burst), and nothing
 * else pulls it back until it doubles. A window in which the queue never dipped to the playout
 * target means every frame waited at least one tick longer than configured: drop one.
 */
const CONVERGE_WINDOW_MS = 1000;

export class RoomMixer implements MixedPcmSource {
  private readonly sources = new Map<string, Source>();
  private readonly listeners = new Set<MixFrameListener>();
  private readonly speakingListeners = new Set<SpeakingListener>();
  private readonly holdFrames: number;
  private readonly convergeTicks: number;
  private windowTick = 0;
  private readonly opts: RoomMixerOptions;
  private readonly frameSize: number;
  /** Unlimited sum and limited full mix, rewritten every tick. */
  private readonly raw: Float32Array;
  private readonly full: Float32Array;
  private seq = 0;
  private detachClock: (() => void) | undefined;
  private readonly counters: MixerCounters;
  /** `counters` may be shared by every room's mixer to keep process-wide totals. */
  constructor(opts: RoomMixerOptions, counters = new MixerCounters()) {
    if (!(opts.sampleRate > 0 && opts.frameMs > 0 && Number.isInteger(opts.maxBufferedFrames) && opts.maxBufferedFrames > 0 && Number.isInteger(opts.playoutFrames) && opts.playoutFrames > 0 && opts.playoutFrames <= opts.maxBufferedFrames && opts.limiterThreshold > 0 && opts.limiterThreshold < 1 && opts.speakingThreshold > 0 && opts.speakingThreshold < 1 && opts.speakingHoldMs >= 0)) throw new RangeError('Invalid mixer options');
    this.opts = opts;
    this.counters = counters;
    this.frameSize = Math.round(opts.sampleRate * opts.frameMs / 1000);
    this.raw = new Float32Array(this.frameSize);
    this.full = new Float32Array(this.frameSize);
    this.holdFrames = Math.max(1, Math.ceil(opts.speakingHoldMs / opts.frameMs));
    this.convergeTicks = Math.ceil(CONVERGE_WINDOW_MS / opts.frameMs);
  }
  get sourceCount(): number { return this.sources.size; }
  addSource(id: string): void {
    if (this.sources.has(id)) return;
    const { noiseFilter: nf, loudness: ln, sampleRate, frameMs } = this.opts;
    this.sources.set(id, {
      muted: false, primed: false, frames: new FrameQueue(this.opts.maxBufferedFrames, this.frameSize), low: Infinity, hold: 0,
      filter: nf && new NoiseFilter(nf, sampleRate, frameMs), loudness: ln && new LoudnessNormalizer(ln, frameMs),
      contribution: null, minus: new Float32Array(this.frameSize), gain: 1, targetGain: 1,
    });
  }
  removeSource(id: string): void {
    const source = this.sources.get(id);
    this.sources.delete(id);
    if (source && source.hold > 0) this.emitSpeaking();
  }
  /** A muted source takes no frames, so it neither plays stale audio on unmute nor counts as underrun. */
  setMuted(id: string, muted: boolean): void {
    const source = this.sources.get(id);
    if (!source || source.muted === muted) return;
    source.muted = muted;
    if (!muted) return;
    source.frames.clear(); source.primed = false; source.low = Infinity;
    if (source.hold > 0) { source.hold = 0; this.emitSpeaking(); }
  }
  /** Manual level trim on top of loudness normalization; the change ramps over one frame. */
  setGain(id: string, gainDb: number): void {
    const source = this.sources.get(id);
    if (source) source.targetGain = 10 ** (gainDb / 20);
  }
  /** Exact frames only; copied on ingress so callers may reuse their input buffers. */
  push(id: string, samples: Float32Array): void {
    const source = this.sources.get(id);
    if (!source || source.muted) return;
    if (samples.length !== this.frameSize) throw new RangeError('PCM frame has incorrect length');
    if (source.frames.full) this.counters.droppedFrames++;
    const slot = source.frames.push(samples);
    source.filter?.process(slot);
    source.loudness?.process(slot);
    const { gain, targetGain } = source;
    if (gain === targetGain) {
      if (gain !== 1) for (let i = 0; i < slot.length; i++) slot[i] = slot[i]! * gain;
      return;
    }
    // A step change would click; glide linearly across this frame instead.
    const step = (targetGain - gain) / slot.length;
    for (let i = 0; i < slot.length; i++) slot[i] = slot[i]! * (gain + step * (i + 1));
    source.gain = targetGain;
  }
  tick(): MixFrame | null {
    if (!this.sources.size) return null;
    this.counters.ticks++;
    const { raw, full, sources } = this;
    raw.fill(0);
    const playout = this.opts.playoutFrames;
    const energyThreshold = this.opts.speakingThreshold ** 2 * this.frameSize;
    let speakingChanged = false;
    let silent = true;
    const converge = ++this.windowTick >= this.convergeTicks;
    if (converge) this.windowTick = 0;
    for (const source of sources.values()) {
      const { frames } = source;
      // Jitter buffer: start (or restart after an underrun) only once `playout` frames are queued,
      // and drain one extra frame when sender clock drift has doubled the queue.
      if (!source.primed && frames.length >= playout) source.primed = true;
      if (source.primed) {
        if (frames.length < source.low) source.low = frames.length;
        if (converge) {
          if (source.low > playout) { frames.shift(); this.counters.droppedFrames++; }
          source.low = Infinity;
        }
      }
      const samples = source.primed ? frames.shift() : undefined;
      if (!samples) { if (source.primed) this.counters.underruns++; source.primed = false; }
      else if (frames.length > 2 * playout) { frames.shift(); this.counters.droppedFrames++; }
      const contribution = source.muted ? null : samples ?? null;
      source.contribution = contribution;
      let energy = 0;
      if (contribution) {
        silent = false;
        for (let i = 0; i < raw.length; i++) { const s = contribution[i]!; raw[i] = raw[i]! + s; energy += s * s; }
      }
      const wasSpeaking = source.hold > 0;
      if (energy >= energyThreshold) source.hold = this.holdFrames;
      else if (source.hold > 0) source.hold--;
      if (wasSpeaking !== source.hold > 0) speakingChanged = true;
    }
    if (speakingChanged) this.emitSpeaking();
    const threshold = this.opts.limiterThreshold;
    full.set(raw);
    limitInPlace(full, threshold);
    // Every audible source gets its mix-minus: each one is a subscriber that will ask for it.
    for (const source of sources.values()) {
      const { contribution, minus } = source;
      if (!contribution) continue;
      for (let i = 0; i < minus.length; i++) minus[i] = raw[i]! - contribution[i]!;
      limitInPlace(minus, threshold);
    }
    const frame: MixFrame = {
      seq: this.seq++, full, silent,
      minus(id) {
        const source = sources.get(id);
        // A silent source's mix-minus equals the full mix.
        return source && (source.contribution ? source.minus : full);
      },
    };
    for (const listener of this.listeners) listener(frame);
    return frame;
  }
  /** Ticks on `clock` until `stop`. */
  start(clock: MixerClock): void {
    this.detachClock ??= clock.add(this);
  }
  stop(): void { this.detachClock?.(); this.detachClock = undefined; }
  onFrame(listener: MixFrameListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Called with the full speaking set whenever it changes. */
  onSpeaking(listener: SpeakingListener): () => void { this.speakingListeners.add(listener); return () => { this.speakingListeners.delete(listener); }; }
  private emitSpeaking(): void {
    const ids: string[] = [];
    for (const [id, source] of this.sources) if (source.hold > 0) ids.push(id);
    for (const listener of this.speakingListeners) listener(ids);
  }
}
