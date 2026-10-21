import { randomInt } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log.ts';
import type { MixPacketSink } from '../transport/MediaTransport.ts';
import { OggOpusWriter } from './oggOpus.ts';

export interface Recording {
  readonly sink: MixPacketSink;
  /** File name inside the recording directory. */
  readonly file: string;
  /** Ends the stream and resolves once the file is flushed and closed. */
  stop(): Promise<void>;
}

/** Opens `<dir>/<roomId>-<UTC timestamp>.opus` for one room's full mix. */
export function startRecording(opts: { dir: string; roomId: string; frameSamples: number; vendor: string; now: number; log: Logger }): Recording {
  mkdirSync(opts.dir, { recursive: true });
  const file = `${opts.roomId}-${new Date(opts.now).toISOString().replace(/[:.]/g, '-')}.opus`;
  const stream = createWriteStream(join(opts.dir, file), { flags: 'wx' });
  let failed = false;
  stream.on('error', (err) => {
    // Disk full or unwritable: stop writing, keep the room running.
    if (!failed) opts.log.error('recording write failed', { roomId: opts.roomId, file, error: err.message });
    failed = true;
  });
  const writer = new OggOpusWriter((chunk) => { if (!failed) stream.write(chunk); }, { frameSamples: opts.frameSamples, serial: randomInt(2 ** 32), vendor: opts.vendor });
  return {
    sink: (packet) => writer.packet(packet),
    file,
    stop: () => {
      writer.close();
      // 'close' also follows a write error (the stream destroys itself), unlike end()'s callback.
      const { promise, resolve } = Promise.withResolvers<void>();
      if (stream.closed) resolve();
      else stream.once('close', () => resolve());
      stream.end();
      return promise;
    },
  };
}
