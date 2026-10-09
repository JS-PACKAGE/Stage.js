import { parentPort, workerData } from 'node:worker_threads';
import type { AppConfig } from '../config.ts';
import type { ShardMessage, ShardRequest } from './mediaShards.ts';
import { WeriftPeerHost } from './peerHost.ts';

/** One media shard: a WeriftPeerHost driven over the worker port by `MediaShard`. */
const config: AppConfig = workerData;
const port = parentPort!;
const emit = (msg: ShardMessage, transfer: ArrayBuffer[] = []) => port.postMessage(msg, transfer);
const host = new WeriftPeerHost(config, {
  localCandidate: (roomId, id, candidate) => emit({ op: 'candidate', roomId, id, candidate }),
  peerClosed: (roomId, id) => emit({ op: 'closed', roomId, id }),
  uplink: (roomId, id, seq, payload) => {
    // The payload may view werift's datagram buffer: copy before transferring so werift's stays intact.
    const copy = Uint8Array.from(payload);
    emit({ op: 'uplink', roomId, id, seq, payload: copy }, [copy.buffer]);
  },
  downlinkLoss: (roomId, id, fraction) => emit({ op: 'loss', roomId, id, fraction }),
});

async function reply(job: number, work: () => Promise<Extract<ShardMessage, { op: 'done' }>['result']>): Promise<void> {
  try { emit({ op: 'done', job, result: await work() }); }
  catch (err) { emit({ op: 'failed', job, message: err instanceof Error ? err.message : String(err) }); }
}

port.on('message', (msg: ShardRequest) => {
  switch (msg.op) {
    case 'negotiate': void reply(msg.job, () => host.negotiate(msg.roomId, msg.id, msg.offer, msg.allowUplink)); return;
    case 'candidate': void reply(msg.job, async () => { await host.addRemoteCandidate(msg.roomId, msg.id, msg.candidate); return null; }); return;
    case 'stats': void reply(msg.job, () => host.getStats(msg.roomId, msg.id)); return;
    case 'counters': void reply(msg.job, () => host.counters()); return;
    case 'close': void reply(msg.job, async () => { await host.close(); return null; }); return;
    case 'setUplink': host.setUplink(msg.roomId, msg.id, msg.enabled); return;
    case 'send': host.send(msg.frame); return;
    case 'closePeer': host.closePeer(msg.roomId, msg.id); return;
  }
});
