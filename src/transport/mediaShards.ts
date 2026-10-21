import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../log.ts';
import type { IceCandidatePayload, SessionDescriptionPayload } from '../../shared/protocol.ts';
import type { TransportStats } from './MediaTransport.ts';
import type { DownlinkFrame, HostCounters, PeerHost, PeerHostEvents } from './peerHost.ts';

export type ShardRequest =
  | { op: 'negotiate'; job: number; roomId: string; id: string; offer: SessionDescriptionPayload; allowUplink: boolean }
  | { op: 'candidate'; job: number; roomId: string; id: string; candidate: IceCandidatePayload | null }
  | { op: 'stats'; job: number; roomId: string; id: string }
  | { op: 'counters'; job: number }
  | { op: 'setUplink'; roomId: string; id: string; enabled: boolean }
  | { op: 'send'; frame: DownlinkFrame }
  | { op: 'closePeer'; roomId: string; id: string }
  | { op: 'close'; job: number };
export type ShardMessage =
  | { op: 'done'; job: number; result?: SessionDescriptionPayload | TransportStats | HostCounters | null }
  | { op: 'failed'; job: number; message: string }
  | { op: 'candidate'; roomId: string; id: string; candidate: IceCandidatePayload | null }
  | { op: 'closed'; roomId: string; id: string }
  | { op: 'uplink'; roomId: string; id: string; seq: number; payload: Uint8Array }
  | { op: 'loss'; roomId: string; id: string; fraction: number };

// The worker shares this module's extension: `.ts` under type stripping, `.js` from `dist/`.
const workerUrl = new URL(`./mediaWorker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
interface PendingCall extends PromiseWithResolvers<ShardMessage> { timer: NodeJS.Timeout }

const peerKey = (roomId: string, id: string) => `${roomId}\u0000${id}`;

/**
 * A PeerHost living on its own worker thread, so ICE/DTLS/SRTP work for its share of the peers
 * runs in parallel with the main thread (ws control plane, mixer clock) and other shards.
 */
export class MediaShard implements PeerHost {
  private readonly config: AppConfig;
  private readonly events: PeerHostEvents;
  private readonly log: Logger;
  private readonly pending = new Map<number, PendingCall>();
  /** Peers placed on this shard, keyed like the worker's host; drives least-loaded placement. */
  private readonly peers = new Map<string, { roomId: string; id: string }>();
  private worker: Worker;
  private nextJob = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(config: AppConfig, events: PeerHostEvents, log: Logger) {
    this.config = config; this.events = events; this.log = log;
    this.worker = this.spawn();
  }
  get peerCount(): number { return this.peers.size; }
  private spawn(): Worker {
    const worker = new Worker(workerUrl, { workerData: this.config });
    worker.unref();
    worker.on('message', (msg: ShardMessage) => {
      // Timed-out negotiations must never deliver callbacks into a replacement peer's lifetime.
      if (this.worker !== worker) return;
      switch (msg.op) {
        case 'done': case 'failed': {
          const p = this.pending.get(msg.job);
          if (p) { clearTimeout(p.timer); this.pending.delete(msg.job); p.resolve(msg); }
          return;
        }
        case 'candidate': this.events.localCandidate(msg.roomId, msg.id, msg.candidate); return;
        case 'closed': this.events.peerClosed(msg.roomId, msg.id); return;
        case 'uplink': this.events.uplink(msg.roomId, msg.id, msg.seq, msg.payload); return;
        case 'loss': this.events.downlinkLoss(msg.roomId, msg.id, msg.fraction); return;
      }
    });
    worker.on('error', err => this.log.error('Media worker crashed', { error: err.message }));
    worker.on('exit', code => this.recover(worker, new Error('Media worker exited'), { code }));

    return worker;
  }
  private rejectPending(error: unknown): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  private recover(worker: Worker, error: Error, detail: Record<string, unknown>): void {
    if (this.worker !== worker) return;
    this.rejectPending(error);
    const lost = [...this.peers.values()];
    this.peers.clear();
    if (this.closed) return;
    this.log.warn('Respawning media worker', { ...detail, lostPeers: lost.length });
    this.worker = this.spawn();
    for (const { roomId, id } of lost) this.events.peerClosed(roomId, id);
  }
  private async call(msg: ShardRequest & { job: number }): Promise<ShardMessage & { op: 'done' }> {
    if (this.closed && msg.op !== 'close') throw new Error('Media shard is closed');
    const worker = this.worker;
    const result = Promise.withResolvers<ShardMessage>();
    const timer = setTimeout(() => {
      // Rejecting the promise alone is unsafe: the abandoned SDP operation could still mutate a peer.
      void worker.terminate().catch(err => this.log.error('Media worker termination failed', { error: String(err) }));
      this.recover(worker, new Error('Media worker request timed out'), { op: msg.op, timeoutMs: this.config.rtc.mediaWorkerTimeoutMs });
    }, this.config.rtc.mediaWorkerTimeoutMs);
    this.pending.set(msg.job, { ...result, timer });
    try {
      worker.postMessage(msg);
      if (msg.op === 'negotiate') this.peers.set(peerKey(msg.roomId, msg.id), { roomId: msg.roomId, id: msg.id });
    }
    catch (error) { clearTimeout(timer); this.pending.delete(msg.job); result.reject(error); }
    const reply = await result.promise;
    if (reply.op !== 'done') throw new Error(reply.op === 'failed' ? reply.message : 'Unexpected media worker reply');
    return reply;
  }
  private post(msg: ShardRequest): void { if (!this.closed) this.worker.postMessage(msg); }
  async negotiate(roomId: string, id: string, offer: SessionDescriptionPayload, allowUplink: boolean): Promise<SessionDescriptionPayload> {
    if (this.closed) throw new Error('Media shard is closed');
    const { result } = await this.call({ op: 'negotiate', job: this.nextJob++, roomId, id, offer, allowUplink });
    if (!result || !('sdp' in result)) throw new Error('Missing answer');
    return result;
  }
  async addRemoteCandidate(roomId: string, id: string, candidate: IceCandidatePayload | null): Promise<void> {
    await this.call({ op: 'candidate', job: this.nextJob++, roomId, id, candidate });
  }
  setUplink(roomId: string, id: string, enabled: boolean): void { this.post({ op: 'setUplink', roomId, id, enabled }); }
  send(frame: DownlinkFrame): void { this.post({ op: 'send', frame }); }
  async getStats(roomId: string, id: string): Promise<TransportStats | null> {
    const { result } = await this.call({ op: 'stats', job: this.nextJob++, roomId, id });
    return result && !('sdp' in result) && !('downlinkPackets' in result) ? result : null;
  }
  closePeer(roomId: string, id: string): void {
    if (this.peers.delete(peerKey(roomId, id))) this.post({ op: 'closePeer', roomId, id });
  }
  async counters(): Promise<HostCounters> {
    const { result } = await this.call({ op: 'counters', job: this.nextJob++ });
    return result && 'downlinkPackets' in result ? result : { downlinkPackets: 0, downlinkDtxFrames: 0 };
  }
  close(): Promise<void> { return this.closing ??= this.closeOnce(); }
  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.peers.clear();
    this.rejectPending(new Error('Media shard is closed'));
    // Let the host close its PeerConnections (DTLS close_notify), bounded by the same RPC deadline.
    await this.call({ op: 'close', job: this.nextJob++ }).catch(() => undefined);
    await this.worker.terminate();
  }
}
