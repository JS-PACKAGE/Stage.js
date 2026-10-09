import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../log.ts';

export interface EncodeItem { key: string; pcm: Float32Array }
export type CodecJob =
  | { op: 'encode'; job: number; room: string; frames: EncodeItem[] }
  | { op: 'decode'; job: number; room: string; key: string; packets: (Uint8Array | null)[] }
  | { op: 'release'; room: string; kind: 'encoder' | 'decoder'; key: string }
  | { op: 'closeRoom'; room: string };
export type CodecResult =
  | { op: 'done'; job: number; payloads?: Uint8Array[]; pcm?: Float32Array }
  | { op: 'failed'; job: number; message: string };
/** Jobs run in order; results come back in one message, in job order. */
export interface CodecBatch { jobs: CodecJob[] }
export interface CodecBatchReply { results: CodecResult[] }

interface Slot {
  worker: Worker;
  rooms: Set<string>;
  pending: Map<number, PromiseWithResolvers<CodecResult>>;
  /** Jobs queued for the next message, with the buffers it transfers. */
  outbox: CodecJob[];
  transfer: ArrayBuffer[];
  flush: 'none' | 'immediate' | 'microtask';
}

// The worker shares this module's extension: `.ts` under type stripping, `.js` from `dist/`.
const workerUrl = new URL(`./codecWorker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

/**
 * Runs Opus encode/decode on `audio.codecWorkers` threads. Each room is pinned to one
 * worker so its stateful codecs see packets in order; rooms spread across workers.
 *
 * Jobs are batched per worker: encodes leave at the end of the current task (the shared mixer
 * clock ticks every room in one task, so one message carries all of a worker's rooms), decodes
 * after the current I/O phase (uplink packets that arrived together travel together).
 */
export class CodecPool {
  private readonly audio: AppConfig['audio'];
  private readonly log: Logger;
  private readonly slots: Slot[] = [];
  private readonly assigned = new Map<string, Slot>();
  /** In-flight encodes per room: one per mixer tick, so this counts frames of lag. */
  private readonly encoding = new Map<string, number>();
  private nextJob = 0;
  private closed = false;
  constructor(audio: AppConfig['audio'], log: Logger) {
    this.audio = audio; this.log = log;
    for (let i = 0; i < audio.codecWorkers; i++) {
      const slot: Slot = { worker: this.spawn(), rooms: new Set(), pending: new Map(), outbox: [], transfer: [], flush: 'none' };
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
    worker.on('message', ({ results }: CodecBatchReply) => {
      for (const result of results) {
        const pending = slot.pending.get(result.job);
        slot.pending.delete(result.job);
        pending?.resolve(result);
      }
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
  /** Queues `job`; `urgent` sends it before the current task ends instead of after the I/O phase. */
  private enqueue(slot: Slot, job: CodecJob, transfer: ArrayBuffer[], urgent: boolean): void {
    slot.outbox.push(job);
    slot.transfer.push(...transfer);
    if (urgent && slot.flush !== 'microtask') { slot.flush = 'microtask'; queueMicrotask(() => this.flush(slot)); }
    else if (slot.flush === 'none') { slot.flush = 'immediate'; setImmediate(() => this.flush(slot)); }
  }
  private flush(slot: Slot): void {
    slot.flush = 'none';
    if (!slot.outbox.length) return;
    slot.worker.postMessage({ jobs: slot.outbox } satisfies CodecBatch, slot.transfer);
    slot.outbox = []; slot.transfer = [];
  }
  private request(room: string, job: CodecJob & { job: number }, transfer: ArrayBuffer[], urgent: boolean): Promise<CodecResult> {
    const slot = this.slot(room);
    const pending = Promise.withResolvers<CodecResult>();
    slot.pending.set(job.job, pending);
    this.enqueue(slot, job, transfer, urgent);
    return pending.promise;
  }
  /** Mixed frames of the room still being encoded; lets callers shed load when its worker falls behind. */
  backlog(room: string): number { return this.encoding.get(room) ?? 0; }
  /** Payloads come back in `frames` order. PCM is cloned when the batch is posted, before the current task ends. */
  async encode(room: string, frames: EncodeItem[]): Promise<Uint8Array[]> {
    this.encoding.set(room, this.backlog(room) + 1);
    try {
      const reply = await this.request(room, { op: 'encode', job: this.nextJob++, room, frames }, [], true);
      if (reply.op === 'failed' || !reply.payloads) throw new Error(reply.op === 'failed' ? reply.message : 'Missing encode result');
      return reply.payloads;
    } finally {
      const left = this.backlog(room) - 1;
      if (left > 0) this.encoding.set(room, left); else this.encoding.delete(room);
    }
  }
  /**
   * Decodes an in-order run of one uplink (`null` = lost packet, rebuilt from the next packet's FEC
   * or concealed) into one PCM block. Packets are copied before transfer, so callers keep theirs.
   */
  async decode(room: string, key: string, packets: (Uint8Array | null)[]): Promise<Float32Array> {
    const copies = packets.map(p => p && Uint8Array.from(p));
    const reply = await this.request(room, { op: 'decode', job: this.nextJob++, room, key, packets: copies }, copies.flatMap(p => p ? [p.buffer] : []), false);
    if (reply.op === 'failed' || !reply.pcm) throw new Error(reply.op === 'failed' ? reply.message : 'Missing decode result');
    return reply.pcm;
  }
  /** Queued behind the room's earlier jobs, so a codec is never dropped before work already sent for it. */
  release(room: string, kind: 'encoder' | 'decoder', key: string): void {
    const slot = this.assigned.get(room);
    if (slot) this.enqueue(slot, { op: 'release', room, kind, key }, [], false);
  }
  closeRoom(room: string): void {
    const slot = this.assigned.get(room);
    if (!slot) return;
    this.enqueue(slot, { op: 'closeRoom', room }, [], false);
    slot.rooms.delete(room); this.assigned.delete(room); this.encoding.delete(room);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map(s => s.worker.terminate()));
  }
}
