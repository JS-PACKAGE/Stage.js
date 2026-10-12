/** Local-only control-plane smoke: node scripts/bench-control-plane.ts.
 * Real WebSockets, MockMediaTransport, no media packets. Client/server share one process;
 * latency, CPU and RSS include the load generator and are not production capacity estimates.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { ServerMessage, RoomStatePayload } from '../shared/protocol.ts';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { renderPrometheus } from '../src/metrics.ts';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import { MockMediaTransport } from '../src/transport/MockMediaTransport.ts';
import { StageHub } from '../src/ws/hub.ts';
import { createStageServer } from '../src/ws/server.ts';

class Client {
  readonly ws: WebSocket;
  state?: RoomStatePayload;
  created?: string;
  answers = 0;
  shutdowns = 0;
  closeCode?: number;
  bytes = 0;
  snapshots = 0;
  private next = 0;
  private readonly pending = new Map<string, PromiseWithResolvers<void>>();
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', () => {});
    this.ws.on('close', code => {
      this.closeCode = code;
      for (const waiter of this.pending.values()) waiter.reject(new Error(`socket closed: ${code}`));
      this.pending.clear();
    });
    this.ws.on('message', data => {
      const text = data.toString();
      this.bytes += Buffer.byteLength(text);
      const message = JSON.parse(text) as ServerMessage;
      if (message.type === 'room:state') { this.state = message; this.snapshots++; }
      if (message.type === 'room:created') this.created = message.roomId;
      if (message.type === 'rtc:answer') this.answers++;
      if (message.type === 'room:closed' && message.reason === 'shutdown') this.shutdowns++;
      if (message.type === 'ok' || (message.type === 'error' && message.requestId)) {
        const id = message.requestId!;
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        if (message.type === 'ok') waiter?.resolve(); else waiter?.reject(new Error(message.code));
      }
    });
  }
  async open(): Promise<void> { await once(this.ws, 'open'); }
  async request(message: Record<string, unknown>): Promise<number> {
    const id = String(this.next++), waiter = Promise.withResolvers<void>(), start = performance.now();
    this.pending.set(id, waiter);
    const timer = setTimeout(() => { this.pending.delete(id); waiter.reject(new Error('request deadline')); }, 5000);
    try { this.ws.send(JSON.stringify({ ...message, requestId: id })); await waiter.promise; return performance.now() - start; }
    finally { clearTimeout(timer); this.pending.delete(id); }
  }
}
const config = loadConfig('config.example.yaml');
config.server.port = 0; config.server.host = '127.0.0.1'; config.server.static = [];
config.server.metrics.token = '';
const count = config.limits.maxAudiencePerRoom;
let hub: StageHub;
const transport = new MockMediaTransport({ onLocalCandidate: (room, peer, candidate) => hub.onLocalCandidate(room, peer, candidate) });
hub = new StageHub({ config, transport, log: silentLogger, serverVersion: 'control-smoke', createMixer: () => new RoomMixer({
  sampleRate: config.audio.sampleRate, frameMs: config.audio.frameMs, maxBufferedFrames: 10,
  playoutFrames: 1, limiterThreshold: 0.9, speakingThreshold: 0.02, speakingHoldMs: 40,
}) });
const server = createStageServer({ config, hub, log: silentLogger, baseDir: process.cwd(), metrics: async () => renderPrometheus(hub.metrics()) });
const clients: Client[] = [];
const delay = monitorEventLoopDelay({ resolution: 10 });
const start = performance.now(), cpu = process.cpuUsage(), initialRss = process.memoryUsage().rss;
let peakRss = initialRss;
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
const deadline = setTimeout(() => { console.error('control-plane smoke exceeded 30s'); process.exit(1); }, 30000);
delay.enable();
try {
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}${config.server.wsPath}`;
  const connect = async () => { const client = new Client(url); clients.push(client); await client.open(); return client; };
  const host = await connect();
  await host.request({ type: 'room:create', name: 'Host', roomName: 'Control smoke', codeRequired: false });
  const roomId = host.created!;
  const joinMs: number[] = [], offerMs: number[] = [];
  const offer = { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' };
  const audience: Client[] = [];
  for (let offset = 0; offset < count; offset += 50) {
    await Promise.all(Array.from({ length: Math.min(50, count - offset) }, async (_, index) => {
      const client = await connect(); audience.push(client);
      joinMs.push(await client.request({ type: 'join', roomId, name: `Audience ${offset + index}` }));
      offerMs.push(await client.request({ type: 'rtc:offer', payload: offer }));
    }));
  }
  await sleep(config.rooms.presenceBroadcastMs + 50);
  assert.equal(host.state?.audienceCount, count);
  assert.equal(host.state?.audience?.length, count);
  for (const client of audience) { assert.equal(client.state?.audienceCount, count); assert.equal(client.answers, 1); assert.equal(client.closeCode, undefined); }
  assert.equal(transport.rooms.get(roomId)?.peers.size, count);
  const excess = await connect();
  await assert.rejects(excess.request({ type: 'join', roomId, name: 'Over capacity' }), /room_full/);
  excess.ws.close(1000); await once(excess.ws, 'close');
  const resumed: Client[] = [];
  const resumeMs: number[] = [];
  for (const old of audience.slice(0, 10)) {
    const state = old.state!;
    const peer = transport.rooms.get(roomId)?.peers.get(state.me.participantId);
    assert.ok(peer);
    old.ws.terminate(); await once(old.ws, 'close');
    const client = await connect();
    resumeMs.push(await client.request({ type: 'join', roomId, name: state.me.name, resumeToken: state.resumeToken }));
    assert.equal(client.state?.me.participantId, state.me.participantId);
    assert.equal(transport.rooms.get(roomId)?.peers.get(state.me.participantId), peer);
    resumed.push(client);
  }
  assert.equal(transport.rooms.get(roomId)?.peers.size, count);
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /^stage_rooms 1$/m);
  const overflowCounters: Record<string, number | null> = {};
  for (const name of ['stage_ws_backpressure_disconnects_total', 'stage_ws_inbound_queue_disconnects_total']) {
    const match = metrics.match(new RegExp(`^${name} (\\d+)$`, 'm'));
    overflowCounters[name] = match ? Number(match[1]) : null; // Older revisions may not expose these metrics.
    if (match) assert.equal(Number(match[1]), 0);
  }
  const live = [host, ...audience.slice(10), ...resumed];
  const closed = Promise.all(live.map(client => once(client.ws, 'close')));
  const shutdownStart = performance.now();
  await server.close(); await closed;
  const shutdownMs = performance.now() - shutdownStart;
  for (const client of live) { assert.equal(client.shutdowns, 1); assert.equal(client.closeCode, 1001); }
  assert.equal(transport.rooms.size, 0);
  const summary = (values: number[]) => { const sorted = values.toSorted((a, b) => a - b); return { p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) }; };
  const used = process.cpuUsage(cpu);
  console.log(JSON.stringify({ audience: count, resumed: resumed.length, shutdownNotified: live.length,
    joinAckMs: summary(joinMs), offerAckMs: summary(offerMs), resumeAckMs: summary(resumeMs), shutdownMs,
    elapsedMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000,
    overflowCounters, initialRss, sampledPeakRss: peakRss, eventLoopP95Ms: delay.percentile(95) / 1e6,
    receivedBytes: clients.reduce((sum, client) => sum + client.bytes, 0), snapshots: clients.reduce((sum, client) => sum + client.snapshots, 0),
    scope: 'same-process local WebSocket control plane; mock media; no audio or production capacity claim',
  }, null, 2));
} finally {
  clearInterval(sample); delay.disable();
  try {
    for (const client of clients) client.ws.terminate();
    await server.close(); await transport.close();
  } finally { clearTimeout(deadline); }
}
