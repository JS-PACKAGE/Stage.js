import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config.ts';

/**
 * libopus compiled to WASM, as shipped by `@evan/opus` — instantiated here rather than through the
 * package's wrapper, which hard-codes `decode_fec = 0` and cannot decode a missing packet, i.e.
 * exposes neither in-band FEC recovery nor libopus PLC. Each thread that imports this module gets
 * its own instance and linear memory, so codecs on different threads never share scratch buffers.
 */
interface OpusApi {
  memory: { readonly buffer: ArrayBuffer };
  malloc(size: number): number;
  free(ptr: number): void;
  opus_strerror(code: number): number;
  opus_decoder_get_size(channels: number): number;
  opus_decoder_init(state: number, sampleRate: number, channels: number): number;
  opus_decode(state: number, data: number, length: number, pcm: number, frameSize: number, decodeFec: number): number;
  opus_decoder_ctl_get(state: number, request: number): number;
  opus_encoder_get_size(channels: number): number;
  opus_encoder_init(state: number, sampleRate: number, channels: number, application: number): number;
  opus_encode(state: number, pcm: number, frameSize: number, data: number, maxBytes: number): number;
  opus_encoder_ctl_set(state: number, request: number, value: number): number;
}

/** `lib: es2024` ships no WebAssembly typings; declare just what this module uses. */
declare const WebAssembly: {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: Record<string, Record<string, () => number>>) => { readonly exports: OpusApi };
};

/** opus_defines.h request codes. */
const CTL: Record<string, number> = {
  setBitrate: 4002, setVbr: 4006, setComplexity: 4010, setInbandFec: 4012, setPacketLossPerc: 4014, setDtx: 4016,
  getLastPacketDuration: 4039,
};
const APPLICATION_VOIP = 2048;
/** 120 ms at 48 kHz: the longest frame an Opus packet can carry. */
const MAX_FRAME = 5760;
/** libopus' recommended packet buffer size; larger uplink payloads are rejected, not truncated. */
const MAX_PACKET = 4000;

const wasmPath = fileURLToPath(import.meta.resolve('@evan/opus/wasm/simd.wasm'));

class OpusRuntime {
  readonly api: OpusApi;
  /** Scratch buffers in WASM memory shared by every codec of this thread (calls are synchronous). */
  readonly pcm: number;
  readonly packet: number;
  private u8: Uint8Array;
  private i16: Int16Array;
  constructor() {
    const noop = () => 0;
    const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasmPath)), {
      wasi_snapshot_preview1: { fd_seek: noop, fd_write: noop, fd_close: noop, proc_exit: noop },
      env: { emscripten_notify_memory_growth: noop },
    });
    this.api = instance.exports;
    this.pcm = this.api.malloc(MAX_FRAME * 2);
    this.packet = this.api.malloc(MAX_PACKET);
    this.u8 = new Uint8Array(this.api.memory.buffer);
    this.i16 = new Int16Array(this.api.memory.buffer);
  }
  /** Views over WASM memory, re-created after `malloc` grew (and thereby detached) the buffer. */
  get bytes(): Uint8Array { this.refresh(); return this.u8; }
  get samples(): Int16Array { this.refresh(); return this.i16; }
  private refresh(): void {
    if (this.u8.buffer === this.api.memory.buffer) return;
    this.u8 = new Uint8Array(this.api.memory.buffer);
    this.i16 = new Int16Array(this.api.memory.buffer);
  }
  check(code: number): number {
    if (code >= 0) return code;
    const bytes = this.bytes;
    let end = this.api.opus_strerror(code);
    const start = end;
    while (bytes[end] !== 0) end++;
    throw new Error(`opus: ${new TextDecoder().decode(bytes.subarray(start, end))}`);
  }
  /** Copies an Opus packet into the scratch buffer. */
  load(packet: Uint8Array): number {
    if (packet.length > MAX_PACKET) throw new RangeError('Opus packet too large');
    this.bytes.set(packet, this.packet);
    return packet.length;
  }
  /** Converts `count` decoded samples from the scratch buffer into a fresh Float32Array. */
  takePcm(count: number): Float32Array<ArrayBuffer> {
    const pcm = this.samples;
    const base = this.pcm >> 1;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = pcm[base + i]! / 32768;
    return out;
  }
}

let shared: OpusRuntime | undefined;
const runtime = (): OpusRuntime => (shared ??= new OpusRuntime());

export class OpusEncoder {
  private readonly rt = runtime();
  private state: number;
  readonly frameSize: number;
  /** `bitrate` overrides `audio.opus.bitrate` (still clamped to min/max), e.g. for a low-bandwidth tier. */
  constructor(audio: AppConfig['audio'], bitrate = audio.opus.bitrate) {
    const { api } = this.rt;
    this.frameSize = Math.round(audio.sampleRate * audio.frameMs / 1000);
    this.state = api.malloc(api.opus_encoder_get_size(1));
    this.rt.check(api.opus_encoder_init(this.state, audio.sampleRate, 1, APPLICATION_VOIP));
    const set = (request: string, value: number) => this.rt.check(api.opus_encoder_ctl_set(this.state, CTL[request]!, value));
    set('setBitrate', Math.min(audio.opus.maxBitrate, Math.max(audio.opus.minBitrate, bitrate)));
    set('setVbr', Number(audio.opus.vbr));
    set('setComplexity', audio.opus.complexity);
    // In-band FEC lets receivers rebuild a lost packet from the next one; libopus only spends
    // bits on it when told to expect loss. DTX collapses silence into ≤2-byte packets the
    // transport does not send.
    set('setInbandFec', Number(audio.opus.fec));
    set('setPacketLossPerc', audio.opus.packetLossPercent);
    set('setDtx', Number(audio.opus.dtx));
  }
  /** Returns a freshly allocated packet the caller owns (sole owner of its ArrayBuffer, so it is transferable). */
  encode(samples: Float32Array): Buffer<ArrayBuffer> {
    if (samples.length !== this.frameSize) throw new RangeError('Incorrect Opus frame size');
    const { rt } = this;
    const pcm = rt.samples;
    const base = rt.pcm >> 1;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.min(1, Math.max(-1, samples[i]!));
      pcm[base + i] = Math.round(s * (s < 0 ? 32768 : 32767));
    }
    const length = rt.check(rt.api.opus_encode(this.state, rt.pcm, this.frameSize, rt.packet, MAX_PACKET));
    return Buffer.from(rt.bytes.slice(rt.packet, rt.packet + length).buffer);
  }
  /** Releases the codec state; the encoder is unusable afterwards. */
  free(): void { this.rt.api.free(this.state); this.state = 0; }
}

export class OpusDecoder {
  private readonly rt = runtime();
  private state: number;
  constructor(sampleRate: number) {
    const { api } = this.rt;
    this.state = api.malloc(api.opus_decoder_get_size(1));
    this.rt.check(api.opus_decoder_init(this.state, sampleRate, 1));
  }
  decode(packet: Uint8Array): Float32Array<ArrayBuffer> {
    const { rt } = this;
    const length = rt.load(packet);
    return rt.takePcm(rt.check(rt.api.opus_decode(this.state, rt.packet, length, rt.pcm, MAX_FRAME, 0)));
  }
  /**
   * Audio for one lost packet, as long as the last one decoded. `next` is the packet that followed
   * the gap: its in-band FEC (when the sender spent bits on it) rebuilds the lost audio, otherwise
   * libopus falls back to packet-loss concealment, which also fades out over consecutive losses.
   * Feed `next` to `decode` afterwards as usual.
   */
  conceal(next: Uint8Array | null): Float32Array<ArrayBuffer> {
    const { rt } = this;
    // Zero until a packet was decoded: nothing to extend yet.
    const frameSize = rt.api.opus_decoder_ctl_get(this.state, CTL.getLastPacketDuration!);
    if (frameSize <= 0) return new Float32Array(0);
    const decoded = next
      ? rt.api.opus_decode(this.state, rt.packet, rt.load(next), rt.pcm, frameSize, 1)
      : rt.api.opus_decode(this.state, 0, 0, rt.pcm, frameSize, 0);
    return rt.takePcm(rt.check(decoded));
  }
  /** Releases the codec state; the decoder is unusable afterwards. */
  free(): void { this.rt.api.free(this.state); this.state = 0; }
}

/** Re-chunks variable-duration decoded Opus packets into the mixer quantum. The emitted frame is reused once `emit` returns. */
export class PcmChunker {
  private readonly pending: Float32Array;
  private filled = 0;
  private readonly size: number;
  constructor(size: number) { this.size = size; this.pending = new Float32Array(size); }
  push(samples: Float32Array, emit: (frame: Float32Array) => void): void {
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(this.size - this.filled, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.size) { emit(this.pending); this.filled = 0; }
    }
  }
}
