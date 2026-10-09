import { parentPort, workerData } from 'node:worker_threads';
import type { AppConfig } from '../config.ts';
import type { CodecReply, CodecRequest } from './codecPool.ts';
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

port.on('message', (msg: CodecRequest) => {
  switch (msg.op) {
    case 'encode': {
      const room = codecs(encoders, msg.room);
      const payloads = msg.frames.map(({ key, pcm }) => {
        let encoder = room.get(key);
        if (!encoder) { encoder = new OpusEncoder(audio); room.set(key, encoder); }
        return encoder.encode(pcm);
      });
      port.postMessage({ op: 'done', job: msg.job, payloads } satisfies CodecReply, payloads.map(p => p.buffer));
      return;
    }
    case 'decode': {
      const room = codecs(decoders, msg.room);
      let decoder = room.get(msg.key);
      if (!decoder) { decoder = new OpusDecoder(audio.sampleRate); room.set(msg.key, decoder); }
      try {
        const pcm = decodeRun(decoder, msg.packets);
        port.postMessage({ op: 'done', job: msg.job, pcm } satisfies CodecReply, [pcm.buffer]);
      } catch (err) { port.postMessage({ op: 'failed', job: msg.job, message: err instanceof Error ? err.message : String(err) } satisfies CodecReply); }
      return;
    }
    case 'release': {
      const room = (msg.kind === 'encoder' ? encoders : decoders).get(msg.room);
      room?.get(msg.key)?.free();
      room?.delete(msg.key);
      return;
    }
    case 'closeRoom': {
      for (const all of [encoders, decoders]) {
        for (const codec of all.get(msg.room)?.values() ?? []) codec.free();
        all.delete(msg.room);
      }
      return;
    }
  }
});
