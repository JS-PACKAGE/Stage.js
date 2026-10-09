import { Decoder, Encoder } from '@evan/opus';
import type { AppConfig } from '../config.ts';

type OpusRate = 8000 | 12000 | 16000 | 24000 | 48000;

/** Native libopus binding (prebuilt N-API for darwin/linux arm64+x64, win32 x64; WASM fallback elsewhere). */
export class OpusEncoder {
  private readonly codec: Encoder;
  private readonly pcm: Int16Array;
  readonly frameSize: number;
  constructor(audio: AppConfig['audio']) {
    this.frameSize = Math.round(audio.sampleRate * audio.frameMs / 1000);
    this.pcm = new Int16Array(this.frameSize);
    this.codec = new Encoder({ channels: 1, sample_rate: audio.sampleRate as OpusRate, application: 'voip' });
    this.codec.bitrate = Math.min(audio.opus.maxBitrate, Math.max(audio.opus.minBitrate, audio.opus.bitrate));
    this.codec.vbr = audio.opus.vbr;
    this.codec.complexity = audio.opus.complexity as Encoder['complexity'];
  }
  /** Returns a freshly allocated packet the caller owns (sole owner of its ArrayBuffer, so it is transferable). */
  encode(samples: Float32Array): Buffer<ArrayBuffer> {
    if (samples.length !== this.frameSize) throw new RangeError('Incorrect Opus frame size');
    const pcm = this.pcm;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.min(1, Math.max(-1, samples[i]!));
      pcm[i] = Math.round(s * (s < 0 ? 32768 : 32767));
    }
    const packet = this.codec.encode(pcm);
    return Buffer.from(packet.buffer as ArrayBuffer, packet.byteOffset, packet.byteLength);
  }
}
export class OpusDecoder {
  private readonly codec: Decoder;
  constructor(sampleRate: number) { this.codec = new Decoder({ channels: 1, sample_rate: sampleRate as OpusRate }); }
  decode(packet: Uint8Array): Float32Array<ArrayBuffer> {
    // The binding returns a fresh copy at offset 0, so the Int16 view is aligned.
    const bytes = this.codec.decode(packet);
    const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const samples = new Float32Array(pcm16.length);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm16[i]! / 32768;
    return samples;
  }
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
