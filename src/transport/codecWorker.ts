import { parentPort, workerData } from 'node:worker_threads';
import type { AppConfig } from '../config.ts';
import type { CodecBatch, CodecBatchReply, CodecJob, CodecResult } from './codecPool.ts';
import { OpusDecoder, OpusEncoder } from './opus.ts';

/** Owns the stateful Opus codecs of the rooms assigned to this thread; requests are served in FIFO order. */
const audio: AppConfig['audio'] = workerData;
const port = parentPort!;
const encoders = new Map<string, Map<string, OpusEncoder>>();
const decoders = new Map<string, Map<string, OpusDecoder>>();

function codecs<T>(all: Map<string, Map<string, T>>, room: string): Map<string, T> {
  let map = all.get(room);
  if (!map) { map = new Map(); all.set(room, map); }
  return map;
}

/** Decodes one in-order run of an uplink; a lost packet is rebuilt from the FEC of the packet after it. */
function decodeRun(decoder: OpusDecoder, packets: (Uint8Array | null)[]): Float32Array<ArrayBuffer> {
  const parts = packets.map((packet, i) => packet ? decoder.decode(packet) : decoder.conceal(packets[i + 1] ?? null));
  if (parts.length === 1) return parts[0]!;
  const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { pcm.set(part, offset); offset += part.length; }
  return pcm;
}

/** Runs one job; jobs that answer push their result (and the buffers it transfers). */
function run(job: CodecJob, results: CodecResult[], transfer: ArrayBuffer[]): void {
  switch (job.op) {
    case 'encode': case 'decode': {
      try {
        if (job.op === 'encode') {
          const room = codecs(encoders, job.room);
          const payloads = job.frames.map(({ key, pcm }) => {
            let encoder = room.get(key);
            if (!encoder) { encoder = new OpusEncoder(audio); room.set(key, encoder); }
            return encoder.encode(pcm);
          });
          results.push({ op: 'done', job: job.job, payloads });
          for (const p of payloads) transfer.push(p.buffer);
        } else {
          const room = codecs(decoders, job.room);
          let decoder = room.get(job.key);
          if (!decoder) { decoder = new OpusDecoder(audio.sampleRate); room.set(job.key, decoder); }
          const pcm = decodeRun(decoder, job.packets);
          results.push({ op: 'done', job: job.job, pcm });
          transfer.push(pcm.buffer);
        }
      } catch (err) { results.push({ op: 'failed', job: job.job, message: err instanceof Error ? err.message : String(err) }); }
      return;
    }
    case 'release': {
      const room = (job.kind === 'encoder' ? encoders : decoders).get(job.room);
      room?.get(job.key)?.free();
      room?.delete(job.key);
      return;
    }
    case 'closeRoom': {
      for (const all of [encoders, decoders]) {
        for (const codec of all.get(job.room)?.values() ?? []) codec.free();
        all.delete(job.room);
      }
      return;
    }
  }
}

port.on('message', ({ jobs }: CodecBatch) => {
  const results: CodecResult[] = [];
  const transfer: ArrayBuffer[] = [];
  for (const job of jobs) run(job, results, transfer);
  if (results.length) port.postMessage({ results } satisfies CodecBatchReply, transfer);
});
