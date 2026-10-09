/**
 * Full-stack load test: starts the server (or targets --url), opens one room with K speakers and
 * N werift audience peers spread over P child processes, and reports downlink loss, mouth-to-ear
 * latency of periodic beeps and the server's /metrics.
 *
 *   node scripts/load-test.ts [--speakers 3] [--audience 298] [--seconds 20] [--procs 4] [--media-workers N] [--url ws://…/ws]
 */
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from 'werift';
import { stringify, parse } from 'yaml';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { loadConfig, samplesPerFrame } from '../src/config.ts';
import { OpusDecoder, OpusEncoder } from '../src/transport/opus.ts';
import { opusCodec } from '../src/transport/peerHost.ts';

const { values: args } = parseArgs({
  options: {
    speakers: { type: 'string', default: '3' }, audience: { type: 'string' }, seconds: { type: 'string', default: '20' },
    procs: { type: 'string', default: '4' }, url: { type: 'string' }, child: { type: 'boolean', default: false },
    'media-workers': { type: 'string' },
  },
});
const config = loadConfig('config.example.yaml');
const FRAME_MS = config.audio.frameMs;
const FRAME = samplesPerFrame(config.audio);
/** Audience peers that decode audio to time beep arrivals. They get a process of their own so the
 * bulk audience's decryption load cannot delay their timestamps. */
const PROBES = 10;
const wallMs = () => performance.timeOrigin + performance.now();
const cpuSeconds = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1e6; };

type ChildInit = { url: string; roomId: string; code: string; count: number; index: number; probes: boolean };
type ChildReport = { peers: number; connected: number; packets: number; lost: number; onsets: number[]; cpuSeconds: number };

/** Minimal Stage.js signaling client over ws (Node stands in for the browser client library). */
class Participant {
  readonly ws: WebSocket;
  readonly pc = new RTCPeerConnection({ codecs: { audio: [opusCodec()], video: [] }, iceServers: [] });
  id = '';
  state: Extract<ServerMessage, { type: 'room:state' }> | undefined;
  private next = 0;
  private readonly waiters = new Map<string, PromiseWithResolvers<void>>();
  private answer = Promise.withResolvers<string>();
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type === 'ok') this.waiters.get(msg.requestId)?.resolve();
      else if (msg.type === 'error' && msg.requestId) this.waiters.get(msg.requestId)?.reject(new Error(msg.code));
      else if (msg.type === 'room:state') { this.state = msg; this.id = msg.me.participantId; }
      else if (msg.type === 'rtc:answer') this.answer.resolve(msg.payload.sdp);
      else if (msg.type === 'rtc:ice' && msg.payload) void this.pc.addIceCandidate({ candidate: msg.payload.candidate, sdpMid: msg.payload.sdpMid ?? undefined, sdpMLineIndex: msg.payload.sdpMLineIndex ?? undefined });
    });
  }
  async open(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.ws.once('open', () => resolve()); this.ws.once('error', reject);
    await promise;
  }
  async request(msg: Record<string, unknown> & { type: ClientMessage['type'] }): Promise<void> {
    const requestId = `r${this.next++}`;
    const waiter = Promise.withResolvers<void>();
    this.waiters.set(requestId, waiter);
    this.ws.send(JSON.stringify({ ...msg, requestId }));
    await waiter.promise;
  }
  /** Offer/answer like the browser client: one PeerConnection, client offers, server answers. */
  async negotiate(): Promise<void> {
    this.answer = Promise.withResolvers<string>();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    // Browsers put no SSRC in a recvonly offer; mirror that (see werift-loopback).
    const sdp = this.pc.localDescription!.sdp.split('\r\n').filter((l) => !/^a=(ssrc|ssrc-group|msid):/.test(l) || this.pc.getTransceivers()[0]!.direction !== 'recvonly').join('\r\n');
    await this.request({ type: 'rtc:offer', payload: { type: 'offer', sdp } });
    await this.pc.setRemoteDescription({ type: 'answer', sdp: await this.answer.promise });
  }
  async connected(timeoutMs: number): Promise<boolean> {
    const end = performance.now() + timeoutMs;
    while (this.pc.connectionState !== 'connected') { if (performance.now() > end) return false; await sleep(50); }
    return true;
  }
  close(): void { this.ws.close(); void this.pc.close(); }
}

async function audienceChild(init: ChildInit): Promise<ChildReport> {
  const report: ChildReport = { peers: init.count, connected: 0, packets: 0, lost: 0, onsets: [], cpuSeconds: 0 };
  const people: Participant[] = [];
  for (let i = 0; i < init.count; i++) {
    const p = new Participant(init.url);
    people.push(p);
    await p.open();
    await p.request({ type: 'join', roomId: init.roomId, code: init.code, name: `A${init.index}-${i}` });
    p.pc.addTransceiver('audio', { direction: 'recvonly' });
    const probe = init.probes ? new OpusDecoder(config.audio.sampleRate) : undefined;
    let lastSeq = -1, quietSince = wallMs();
    p.pc.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => {
      const now = wallMs();
      report.packets++;
      const seq = packet.header.sequenceNumber;
      if (lastSeq >= 0) report.lost += Math.max(0, ((seq - lastSeq) & 0xffff) - 1);
      lastSeq = seq;
      if (!probe) return;
      const pcm = probe.decode(packet.payload);
      let e = 0; for (const s of pcm) e += s * s;
      if (e / pcm.length > 0.02) { if (now - quietSince > 300) report.onsets.push(now); quietSince = Infinity; }
      else if (quietSince === Infinity) quietSince = now;
    }));
    await p.negotiate();
  }
  for (const p of people) if (await p.connected(20000)) report.connected++;
  process.send!({ ready: true });
  const { promise, resolve } = Promise.withResolvers<void>();
  process.once('message', () => resolve());
  await promise;
  for (const p of people) p.close();
  report.cpuSeconds = cpuSeconds();
  return report;
}

async function startServer(): Promise<{ url: string; metricsUrl: string; child: ChildProcess }> {
  const raw = parse(readFileSync('config.example.yaml', 'utf8'));
  raw.server.port = 0; raw.server.static = []; raw.rtc.serverIceServers = []; raw.rtc.iceServers = []; raw.log.level = 'info';
  if (args['media-workers'] !== undefined) raw.rtc.mediaWorkers = Number(args['media-workers']);
  const dir = mkdtempSync(join(tmpdir(), 'stage-load-'));
  writeFileSync(join(dir, 'config.yaml'), stringify(raw));
  const child = spawn(process.execPath, ['src/index.ts'], { env: { ...process.env, STAGE_CONFIG: join(dir, 'config.yaml') }, stdio: ['ignore', 'ignore', 'pipe'] });
  const { promise, resolve, reject } = Promise.withResolvers<{ url: string; metricsUrl: string; child: ChildProcess }>();
  let buffered = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const line = buffered.split('\n').find((l) => l.includes('Stage.js listening'));
    if (line) { const { ws, url } = JSON.parse(line) as { ws: string; url: string }; resolve({ url: ws, metricsUrl: `${url}/metrics`, child }); }
  });
  child.once('exit', (code) => reject(new Error(`server exited (${code}): ${buffered}`)));
  return promise;
}

async function main(): Promise<void> {
  const speakers = Number(args.speakers), seconds = Number(args.seconds), procs = Number(args.procs);
  const audience = Number(args.audience ?? config.limits.maxAudiencePerRoom - (speakers - 1));
  const server = args.url ? undefined : await startServer();
  const url = args.url ?? server!.url;
  const metricsUrl = server?.metricsUrl ?? url.replace(/^ws/, 'http').replace(/\/ws$/, '/metrics');
  try {
    // Speakers: the controller (on stage from the start) plus approved hand-raisers.
    const host = new Participant(url);
    await host.open();
    await host.request({ type: 'room:create', name: 'Host' });
    const { roomId, code } = host.state!;
    const stage = [host];
    for (let i = 1; i < speakers; i++) {
      const s = new Participant(url);
      await s.open();
      await s.request({ type: 'join', roomId, code, name: `S${i}` });
      await s.request({ type: 'hand:raise' });
      await host.request({ type: 'stage:approve', targetId: s.id });
      stage.push(s);
    }
    const encoderConfig = { ...config.audio, opus: { ...config.audio.opus, dtx: false } };
    const tracks = stage.map((s) => { const track = new MediaStreamTrack({ kind: 'audio' }); s.pc.addTransceiver(track, { direction: 'sendrecv' }); return track; });
    for (const s of stage) await s.negotiate();
    for (const s of stage) assert.ok(await s.connected(20000), 'speaker ICE');

    const started = performance.now();
    const bulk = audience - PROBES;
    const shares = [PROBES, ...Array.from({ length: procs }, (_, index) => Math.floor(bulk / procs) + (index < bulk % procs ? 1 : 0))];
    const children = shares.map((count, index) => {
      const child = fork(new URL(import.meta.url), ['--child'], { stdio: 'inherit' });
      child.send({ url, roomId, code: code ?? '', count, index, probes: index === 0 } satisfies ChildInit);
      return child;
    });
    await Promise.all(children.map((c) => new Promise((r) => c.once('message', r))));
    console.log(`joined ${audience} audience in ${((performance.now() - started) / 1000).toFixed(1)}s`);

    // Speaker 0 beeps 120 ms every second over a quiet bed from the others; beep send times anchor latency.
    const encoders = stage.map(() => new OpusEncoder(encoderConfig));
    const beeps: number[] = [];
    let seq = 0, ts = 0, frame = 0;
    const t0 = Math.ceil(wallMs() / 1000) * 1000 + 1000;
    const end = t0 + seconds * 1000;
    let next = performance.now();
    while (wallMs() < end) {
      const now = wallMs();
      const phase = now < t0 ? -1 : (now - t0) % 1000;
      const beeping = phase >= 0 && phase < 120;
      if (beeping && (beeps.length === 0 || now - beeps.at(-1)! > 500)) beeps.push(now);
      stage.forEach((s, i) => {
        const amp = i === 0 ? (beeping ? 0.5 : 0) : 0.03;
        const pcm = Float32Array.from({ length: FRAME }, (_, n) => amp * Math.sin(2 * Math.PI * (440 + i * 110) * (frame * FRAME + n) / config.audio.sampleRate));
        const sender = s.pc.getTransceivers()[0]!.sender;
        tracks[i]!.writeRtp(new RtpPacket(new RtpHeader({ payloadType: sender.codec!.payloadType, sequenceNumber: seq & 0xffff, timestamp: ts >>> 0, ssrc: sender.ssrc }), encoders[i]!.encode(pcm)));
      });
      seq++; ts += FRAME; frame++;
      next += FRAME_MS;
      await sleep(Math.max(0, next - performance.now()));
    }

    const reports = await Promise.all(children.map((c) => new Promise<ChildReport>((r) => { c.once('message', (m) => r(m as ChildReport)); c.send('stop'); })));
    const metrics = await (await fetch(metricsUrl)).text();
    for (const s of stage) s.close();
    const total = reports.reduce((a, r) => ({ peers: a.peers + r.peers, connected: a.connected + r.connected, packets: a.packets + r.packets, lost: a.lost + r.lost }), { peers: 0, connected: 0, packets: 0, lost: 0 });
    const latencies = reports.flatMap((r) => r.onsets).map((at) => at - beeps.filter((b) => b <= at).at(-1)!).filter((l) => l >= 0 && l < 1000).sort((a, b) => a - b);
    const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]?.toFixed(0) ?? 'n/a';
    const pick = (name: string) => metrics.match(new RegExp(`^${name} (\\S+)$`, 'm'))?.[1] ?? 'n/a';
    console.table({
      audience: `${total.connected}/${total.peers} connected`,
      downlinkLoss: `${(100 * total.lost / Math.max(1, total.packets + total.lost)).toFixed(3)}% (${total.lost}/${total.packets + total.lost})`,
      beepLatencyMs: `p50 ${pct(0.5)} · p95 ${pct(0.95)} · max ${latencies.length ? latencies.at(-1)!.toFixed(0) : 'n/a'} (n=${latencies.length})`,
      serverEventLoopMs: `p99 ${pick('stage_event_loop_delay_p99_ms')} · max ${pick('stage_event_loop_delay_max_ms')}`,
      mixer: `late ticks ${pick('stage_mixer_late_ticks_total')} · max lag ${pick('stage_mixer_max_tick_lag_ms')}ms · underruns ${pick('stage_mixer_underruns_total')}`,
      shedFrames: pick('stage_mix_frames_shed_total'),
      serverCpuSeconds: pick('stage_process_cpu_seconds_total'),
      // The harness shares the machine: when it needs most cores, server numbers are pessimistic.
      harnessCpuSeconds: (reports.reduce((n, r) => n + r.cpuSeconds, 0) + cpuSeconds()).toFixed(1),
    });
    if (total.connected < total.peers || latencies.length === 0 || Number(pct(0.95)) > config.audio.mixer.latencyTargetMs) process.exitCode = 1;
  } finally {
    server?.child.kill('SIGTERM');
  }
}

if (args.child) {
  process.once('message', (init: ChildInit) => { void audienceChild(init).then((report) => { process.send!(report); process.disconnect(); }); });
} else await main();
