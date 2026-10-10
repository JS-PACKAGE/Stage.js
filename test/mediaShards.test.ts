import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { silentLogger } from '../src/log.ts';
import { MediaShard } from '../src/transport/mediaShards.ts';
import { testConfig } from './helpers.ts';

test('a crashed media worker reports its peers closed and a fresh worker takes over', async () => {
  const closed: string[] = [];
  const shard = new MediaShard(testConfig(), {
    localCandidate() {}, uplink() {}, downlinkLoss() {},
    peerClosed: (roomId, id) => closed.push(`${roomId}/${id}`),
  }, silentLogger);
  try {
    // The shard books a peer as soon as it is asked to negotiate; the bad SDP only fails the answer.
    await shard.negotiate('r', 'p', { type: 'offer', sdp: 'v=0' }, false).catch(() => {});
    assert.equal(shard.peerCount, 1);
    const dead = shard['worker'];
    await dead.terminate();
    await nextTurn();
    assert.deepEqual(closed, ['r/p'], 'the hub learns the peer is gone, so it can tear the media down');
    assert.equal(shard.peerCount, 0);
    assert.notEqual(shard['worker'], dead, 'respawned');
    assert.deepEqual(await shard.counters(), { downlinkPackets: 0, downlinkDtxFrames: 0 }, 'the new worker answers');
  } finally { await shard.close(); }
});
