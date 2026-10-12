import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StageClient } from '../src/index.ts';

type Entry = Record<string, unknown>;
const report = (...entries: Entry[]): RTCStatsReport => new Map(entries.map(entry => [String(entry.id), entry])) as unknown as RTCStatsReport;
const inbound = (timestamp: number, extra: Entry = {}): Entry => ({ id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp, bytesReceived: 1000, packetsReceived: 100, packetsLost: 2, jitterBufferDelay: 2, jitterBufferEmittedCount: 100, ...extra });

function clientWithStats(getStats: () => Promise<RTCStatsReport>) {
  const audio = { autoplay: false, srcObject: null, pause() {} } as unknown as HTMLAudioElement;
  const client = new StageClient({ url: 'ws://localhost/ws', audioElement: audio });
  const pc = { getStats, close() {} } as unknown as RTCPeerConnection;
  client['pc'] = pc;
  return { client, pc };
}

describe('connection-quality statistics', () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  });
  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('reports codec, RTT and interval deltas with documented units', async () => {
    let entries = report(inbound(1000, { codecId: 'opus' }), { id: 'opus', type: 'codec', mimeType: 'audio/opus', clockRate: 48000, channels: 1 }, { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.04 });
    const { client } = clientWithStats(async () => entries);
    const first = await client.getStats();
    assert.equal(first.inbound?.mimeType, 'audio/opus');
    assert.equal(first.inbound?.rtt, 0.04);
    assert.equal(first.inbound?.bitrateKbps, undefined);
    assert.equal(first.inbound?.lossPercent, undefined);
    assert.equal(first.inbound?.bufferMs, undefined);
    entries = report(inbound(2000, { bytesReceived: 9000, packetsReceived: 148, packetsLost: 4, jitterBufferDelay: 3, jitterBufferEmittedCount: 150 }));
    const second = await client.getStats();
    assert.equal(second.inbound?.bitrateKbps, 64);
    assert.equal(second.inbound?.lossPercent, 4);
    assert.equal(second.inbound?.bufferMs, 20);
  });

  it('omits absent/non-finite counters instead of manufacturing NaN or false deltas', async () => {
    let entries = report(inbound(1000, { bytesReceived: undefined, packetsReceived: undefined, packetsLost: undefined, jitterBufferDelay: undefined, jitterBufferEmittedCount: undefined }));
    const { client } = clientWithStats(async () => entries);
    await client.getStats();
    entries = report(inbound(2000));
    const next = await client.getStats();
    for (const key of ['bitrateKbps', 'lossPercent', 'bufferMs'] as const) assert.equal(next.inbound?.[key], undefined);
    entries = report(inbound(3000, { bytesReceived: NaN, packetsLost: Infinity, jitter: NaN, jitterBufferDelay: Infinity }));
    const invalid = await client.getStats();
    assert.ok(Object.values(invalid.inbound!).every(value => typeof value !== 'number' || Number.isFinite(value)));
    assert.equal(invalid.inbound?.bitrateKbps, undefined);
    assert.equal(invalid.inbound?.bufferMs, undefined);
  });

  it('re-baselines reset counters and allows later valid deltas', async () => {
    let entries = report(inbound(1000));
    const { client } = clientWithStats(async () => entries);
    await client.getStats();
    entries = report(inbound(2000, { bytesReceived: 100, packetsReceived: 10, packetsLost: 0, jitterBufferDelay: 0.1, jitterBufferEmittedCount: 110 }));
    const reset = await client.getStats();
    assert.equal(reset.inbound?.bitrateKbps, undefined);
    assert.equal(reset.inbound?.lossPercent, undefined);
    assert.equal(reset.inbound?.bufferMs, undefined, 'a counter reset cannot produce negative buffer latency');
    entries = report(inbound(3000, { bytesReceived: 1100, packetsReceived: 20, packetsLost: 0, jitterBufferDelay: 0.2, jitterBufferEmittedCount: 120 }));
    const next = await client.getStats();
    assert.equal(next.inbound?.bitrateKbps, 8);
    assert.equal(next.inbound?.bufferMs, 10);
  });

  it('ignores late completions from retired peers and does not repopulate cleared history', async () => {
    let resolve!: (stats: RTCStatsReport) => void;
    const { client } = clientWithStats(() => new Promise(done => { resolve = done; }));
    const pending = client.getStats();
    await client.disconnect();
    resolve(report(inbound(1000)));
    assert.deepEqual(await pending, { inbound: null, outbound: null });
    assert.equal(client['previousStats'].size, 0);
  });

  it('suppresses obsolete overlapping polls and keeps the newest baseline', async () => {
    let resolveOld!: (stats: RTCStatsReport) => void;
    let current = report(inbound(2000, { bytesReceived: 2000 }));
    let calls = 0;
    const { client } = clientWithStats(() => ++calls === 1 ? new Promise(done => { resolveOld = done; }) : Promise.resolve(current));
    const old = client.getStats();
    await client.getStats();
    resolveOld(report(inbound(1000, { bytesReceived: 0 })));
    assert.deepEqual(await old, { inbound: null, outbound: null });
    current = report(inbound(3000, { bytesReceived: 3000 }));
    assert.equal((await client.getStats()).inbound?.bitrateKbps, 8);
  });

  it('does not let duplicate or older timestamps roll the baseline backward', async () => {
    let current = report(inbound(2000, { bytesReceived: 2000 }));
    const { client } = clientWithStats(async () => current);
    await client.getStats();
    for (const timestamp of [2000, 1000]) {
      current = report(inbound(timestamp, { bytesReceived: 0 }));
      assert.equal((await client.getStats()).inbound?.bitrateKbps, undefined);
    }
    current = report(inbound(3000, { bytesReceived: 3000 }));
    assert.equal((await client.getStats()).inbound?.bitrateKbps, 8);
  });

  it('evicts disappeared RTP IDs and ignores video reports', async () => {
    let current = report();
    const { client } = clientWithStats(async () => current);
    for (let i = 0; i < 100; i++) {
      current = report(inbound(i + 1, { id: `ssrc-${i}` }), { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: i + 1 });
      await client.getStats();
      assert.equal(client['previousStats'].size, 1);
    }
    current = report();
    assert.deepEqual(await client.getStats(), { inbound: null, outbound: null });
    assert.equal(client['previousStats'].size, 0);
  });

  it('preserves remote outbound metrics while rejecting invalid loss fractions', async () => {
    let fraction = 0.125;
    const { client } = clientWithStats(async () => report(
      { id: 'out', type: 'outbound-rtp', mediaType: 'audio', timestamp: 1000, bytesSent: 1000, remoteId: 'remote' },
      { id: 'remote', type: 'remote-inbound-rtp', fractionLost: fraction, roundTripTime: 0.1, jitter: 0.02, packetsLost: 10 },
    ));
    const stats = await client.getStats();
    assert.equal(stats.outbound?.lossPercent, 12.5);
    assert.equal(stats.outbound?.rtt, 0.1);
    assert.equal(stats.outbound?.packetsLost, 10);
    for (fraction of [-0.1, 1.1, NaN]) assert.equal((await client.getStats()).outbound?.lossPercent, undefined);
  });

  it('keeps replacement-peer history when the retired peer resolves with the same RTP ID', async () => {
    let resolve!: (stats: RTCStatsReport) => void;
    const { client } = clientWithStats(() => new Promise(done => { resolve = done; }));
    const old = client.getStats();
    await client.disconnect();
    let current = report(inbound(2000, { bytesReceived: 2000 }));
    client['pc'] = { getStats: async () => current } as unknown as RTCPeerConnection;
    await client.getStats();
    resolve(report(inbound(1000, { bytesReceived: 0 })));
    assert.deepEqual(await old, { inbound: null, outbound: null });
    current = report(inbound(3000, { bytesReceived: 3000 }));
    assert.equal((await client.getStats()).inbound?.bitrateKbps, 8);
  });

  it('ignores obsolete overlapping failures and accepts negative repaired loss counters', async () => {
    let reject!: (error: Error) => void;
    let calls = 0;
    let current = report(inbound(1000, { packetsLost: -1 }));
    const { client } = clientWithStats(() => ++calls === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve(current));
    const old = client.getStats();
    await client.getStats();
    reject(new Error('obsolete failure'));
    assert.deepEqual(await old, { inbound: null, outbound: null });
    current = report(inbound(2000, { packetsReceived: 110, packetsLost: -2 }));
    const next = await client.getStats();
    assert.equal(next.inbound?.packetsLost, -2);
    assert.equal(next.inbound?.lossPercent, 0);
  });

  it('returns empty for a retired-peer failure but propagates a current-peer failure', async () => {
    let reject!: (error: Error) => void;
    const { client } = clientWithStats(() => new Promise((_resolve, fail) => { reject = fail; }));
    const old = client.getStats();
    await client.disconnect();
    reject(new Error('peer was closed'));
    assert.deepEqual(await old, { inbound: null, outbound: null });
    const current = clientWithStats(async () => { throw new Error('current failure'); }).client;
    await assert.rejects(current.getStats(), /current failure/);
  });
});
