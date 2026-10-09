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
        const pcm = decoder.decode(msg.packet);
        port.postMessage({ op: 'done', job: msg.job, pcm } satisfies CodecReply, [pcm.buffer]);
      } catch (err) { port.postMessage({ op: 'failed', job: msg.job, message: err instanceof Error ? err.message : String(err) } satisfies CodecReply); }
      return;
    }
    case 'release': {
      // Native codec state is freed by the binding's GC finalizer once unreferenced.
      (msg.kind === 'encoder' ? encoders : decoders).get(msg.room)?.delete(msg.key);
      return;
    }
    case 'closeRoom': {
      encoders.delete(msg.room); decoders.delete(msg.room);
      return;
    }
  }
});
