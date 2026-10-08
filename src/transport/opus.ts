import OpusScript from 'opusscript';
import type { AppConfig } from '../config.ts';

/** libopus include/opus_defines.h: https://opus-codec.org/docs/html_api-1.1.0/opus__defines_8h.html */
export const OPUS_SET_VBR_REQUEST = 4006;
export const OPUS_SET_COMPLEXITY_REQUEST = 4010;
export class OpusEncoder {
  private readonly codec: OpusScript;
  private readonly pcm: Buffer;
  readonly frameSize: number;
  constructor(audio: AppConfig['audio']) {
    this.frameSize = Math.round(audio.sampleRate * audio.frameMs / 1000);
    this.pcm = Buffer.alloc(this.frameSize * 2);
    this.codec = new OpusScript(audio.sampleRate as 8000 | 12000 | 16000 | 24000 | 48000, 1, OpusScript.Application.VOIP);
    this.codec.setBitrate(Math.min(audio.opus.maxBitrate, Math.max(audio.opus.minBitrate, audio.opus.bitrate)));
    this.codec.encoderCTL(OPUS_SET_VBR_REQUEST, audio.opus.vbr ? 1 : 0);
    this.codec.encoderCTL(OPUS_SET_COMPLEXITY_REQUEST, audio.opus.complexity);
  }
  encode(samples: Float32Array): Buffer {
    if (samples.length !== this.frameSize) throw new RangeError('Incorrect Opus frame size');
    for (let i = 0; i < samples.length; i++) this.pcm.writeInt16LE(Math.round(Math.min(1, Math.max(-1, samples[i]!)) * (samples[i]! < 0 ? 32768 : 32767)), i * 2);
    return this.codec.encode(this.pcm, this.frameSize);
  }
  delete(): void { this.codec.delete(); }
}
export class OpusDecoder {
  private readonly codec: OpusScript;
  constructor(sampleRate: number) {
    this.codec = new OpusScript(sampleRate as 8000 | 12000 | 16000 | 24000 | 48000, 1, OpusScript.Application.VOIP);
  }
  decode(packet: Buffer): Float32Array {
    const pcm = this.codec.decode(packet);
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    return samples;
  }
  delete(): void { this.codec.delete(); }
}

/** Re-chunks variable-duration decoded Opus packets into the mixer quantum. */
export class PcmChunker {
  private pending: Float32Array;
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
      if (this.filled === this.size) { emit(this.pending); this.pending = new Float32Array(this.size); this.filled = 0; }
    }
  }
}
