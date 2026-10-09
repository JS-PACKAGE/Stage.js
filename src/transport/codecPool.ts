import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../log.ts';

export interface EncodeItem { key: string; pcm: Float32Array }
export type CodecRequest =
  | { op: 'encode'; job: number; room: string; frames: EncodeItem[] }
  | { op: 'decode'; job: number; room: string; key: string; packet: Uint8Array | null }
  | { op: 'release'; room: string; kind: 'encoder' | 'decoder'; key: string }
  | { op: 'closeRoom'; room: string };
export type CodecReply =
  | { op: 'done'; job: number; payloads?: Uint8Array[]; pcm?: Float32Array }
  | { op: 'failed'; job: number; message: string };

interface Slot { worker: Worker; rooms: Set<string>; pending: Map<number, PromiseWithResolvers<CodecReply>> }

// The worker shares this module's extension: `.ts` under type stripping, `.js` from `dist/`.
const workerUrl = new URL(`./codecWorker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

/**
 * Runs Opus encode/decode on `audio.codecWorkers` threads. Each room is pinned to one
 * worker so its stateful codecs see packets in order; rooms spread across workers.
 */
export class CodecPool {
  private readonly audio: AppConfig['audio'];
  private readonly log: Logger;
  private readonly slots: Slot[] = [];
  private readonly assigned = new Map<string, Slot>();
  private nextJob = 0;
  private closed = false;
  constructor(audio: AppConfig['audio'], log: Logger) {
    this.audio = audio; this.log = log;
    for (let i = 0; i < audio.codecWorkers; i++) {
      const slot: Slot = { worker: this.spawn(), rooms: new Set(), pending: new Map() };
      this.attach(slot);
      this.slots.push(slot);
    }
  }
  private spawn(): Worker {
    const worker = new Worker(workerUrl, { workerData: this.audio });
    worker.unref();
    return worker;
  }
  private attach(slot: Slot): void {
    const { worker } = slot;
    worker.on('message', (reply: CodecReply) => {
      const pending = slot.pending.get(reply.job);
      slot.pending.delete(reply.job);
      pending?.resolve(reply);
    });
    worker.on('error', err => this.log.error('Codec worker crashed', { error: err.message }));
    worker.on('exit', code => {
      if (slot.worker !== worker) return;
      for (const pending of slot.pending.values()) pending.reject(new Error('Codec worker exited'));
      slot.pending.clear();
      if (this.closed) return;
      // Codec state is rebuilt lazily on the next request, so a respawn only costs a glitch.
      this.log.warn('Respawning codec worker', { code });
      slot.worker = this.spawn();
      this.attach(slot);
    });
  }
  private slot(room: string): Slot {
    let slot = this.assigned.get(room);
    if (!slot) {
      slot = this.slots.reduce((best, s) => s.rooms.size < best.rooms.size ? s : best);
      slot.rooms.add(room);
      this.assigned.set(room, slot);
    }
    return slot;
  }
  private request(room: string, msg: CodecRequest & { job: number }, transfer: ArrayBuffer[]): Promise<CodecReply> {
    const slot = this.slot(room);
    const pending = Promise.withResolvers<CodecReply>();
    slot.pending.set(msg.job, pending);
    slot.worker.postMessage(msg, transfer);
    return pending.promise;
  }
  /** In-flight requests of the room's worker; lets callers shed load when it falls behind. */
  backlog(room: string): number { return this.slot(room).pending.size; }
  /** Payloads come back in `frames` order. PCM is cloned, so callers keep their buffers. */
  async encode(room: string, frames: EncodeItem[]): Promise<Uint8Array[]> {
    const reply = await this.request(room, { op: 'encode', job: this.nextJob++, room, frames }, []);
    if (reply.op === 'failed' || !reply.payloads) throw new Error(reply.op === 'failed' ? reply.message : 'Missing encode result');
    return reply.payloads;
  }
  /** `packet` is copied before transfer, so the caller's buffer stays intact; `null` conceals a lost packet. */
  async decode(room: string, key: string, packet: Uint8Array | null): Promise<Float32Array> {
    const copy = packet && Uint8Array.from(packet);
    const reply = await this.request(room, { op: 'decode', job: this.nextJob++, room, key, packet: copy }, copy ? [copy.buffer] : []);
    if (reply.op === 'failed' || !reply.pcm) throw new Error(reply.op === 'failed' ? reply.message : 'Missing decode result');
    return reply.pcm;
  }
  release(room: string, kind: 'encoder' | 'decoder', key: string): void {
    this.assigned.get(room)?.worker.postMessage({ op: 'release', room, kind, key } satisfies CodecRequest);
  }
  closeRoom(room: string): void {
    const slot = this.assigned.get(room);
    if (!slot) return;
    slot.worker.postMessage({ op: 'closeRoom', room } satisfies CodecRequest);
    slot.rooms.delete(room); this.assigned.delete(room);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map(s => s.worker.terminate()));
  }
}
