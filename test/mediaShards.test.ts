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

test('a stalled RPC replaces its worker, clears all calls and ignores late messages', async (t) => {
  const config = testConfig();
  const closed: string[] = [];
  const candidates: unknown[] = [];
  const shard = new MediaShard(config, {
    localCandidate: (...args) => candidates.push(args), uplink() {}, downlinkLoss() {},
    peerClosed: (roomId, id) => closed.push(`${roomId}/${id}`),
  }, silentLogger);
  try {
    await shard.counters();
    const old = shard['worker'];
    const requests: { job: number }[] = [];
    old.postMessage = (msg) => { requests.push(msg); };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const negotiation = assert.rejects(shard.negotiate('r', 'p', { type: 'offer', sdp: 'v=0' }, false), /timed out/);
    const stats = assert.rejects(shard.getStats('r', 'p'), /timed out/);
    assert.equal(shard['pending'].size, 2);
    t.mock.timers.tick(config.rtc.mediaWorkerTimeoutMs);
    await Promise.all([negotiation, stats]);
    t.mock.timers.reset();
    assert.equal(shard['pending'].size, 0);
    assert.equal(shard.peerCount, 0);
    assert.deepEqual(closed, ['r/p']);
    assert.notEqual(shard['worker'], old);
    old.emit('message', { op: 'done', job: requests[0]!.job, result: { type: 'answer', sdp: 'late' } });
    old.emit('message', { op: 'candidate', roomId: 'r', id: 'p', candidate: null });
    old.emit('message', { op: 'closed', roomId: 'r', id: 'p' });
    assert.deepEqual(candidates, []);
    assert.deepEqual(closed, ['r/p'], 'retired worker callbacks cannot close a replacement peer');
    assert.deepEqual(await shard.counters(), { downlinkPackets: 0, downlinkDtxFrames: 0 });
    assert.equal(shard['pending'].size, 0);
  } finally { t.mock.timers.reset(); await shard.close(); }
});

test('postMessage failure releases its pending entry and deadline', async (t) => {
  const shard = new MediaShard(testConfig(), { localCandidate() {}, uplink() {}, downlinkLoss() {}, peerClosed() {} }, silentLogger);
  try {
    await shard.counters();
    const worker = shard['worker'];
    const post = worker.postMessage.bind(worker);
    worker.postMessage = () => { throw new Error('cannot post'); };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await assert.rejects(shard.counters(), /cannot post/);
    await assert.rejects(shard.negotiate('r', 'p', { type: 'offer', sdp: 'v=0' }, false), /cannot post/);
    assert.equal(shard.peerCount, 0, 'unsent negotiation must not reserve a phantom peer');
    assert.equal(shard['pending'].size, 0);
    t.mock.timers.tick(300000);
    assert.equal(shard['worker'], worker, 'cleared deadline must not later replace a healthy worker');
    t.mock.timers.reset();
    worker.postMessage = post;
    await shard.counters();
  } finally { t.mock.timers.reset(); await shard.close(); }
});

test('shutdown rejects outstanding calls and a hung close is bounded without respawning', async (t) => {
  const config = testConfig();
  const shard = new MediaShard(config, { localCandidate() {}, uplink() {}, downlinkLoss() {}, peerClosed() {} }, silentLogger);
  await shard.counters();
  const worker = shard['worker'];
  worker.postMessage = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = assert.rejects(shard.counters(), /closed/);
    const closing = shard.close();
    assert.equal(shard.close(), closing, 'shutdown is idempotent');
    await pending;
    assert.equal(shard['pending'].size, 1, 'only close is still pending');
    t.mock.timers.tick(config.rtc.mediaWorkerTimeoutMs);
    await closing;
    assert.equal(shard['worker'], worker);
    assert.equal(shard['pending'].size, 0);
    await assert.rejects(shard.counters(), /closed/);
    await assert.rejects(shard.negotiate('r', 'p', { type: 'offer', sdp: 'v=0' }, false), /closed/);
    assert.equal(shard.peerCount, 0);
  } finally { t.mock.timers.reset(); await shard.close(); }
});


test('successful and failed replies cancel their deadlines', async (t) => {
  const config = testConfig();
  const shard = new MediaShard(config, { localCandidate() {}, uplink() {}, downlinkLoss() {}, peerClosed() {} }, silentLogger);
  try {
    await shard.counters();
    const worker = shard['worker'];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await shard.counters();
    await assert.rejects(shard.negotiate('r', 'p', { type: 'offer', sdp: 'v=0' }, false));
    assert.equal(shard['pending'].size, 0);
    t.mock.timers.tick(config.rtc.mediaWorkerTimeoutMs);
    assert.equal(shard['worker'], worker, 'settled calls cannot trigger a delayed restart');
  } finally { t.mock.timers.reset(); await shard.close(); }
});
