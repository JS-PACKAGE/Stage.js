import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ClientMessage, ParticipantView, RoomStatePayload, ServerMessage } from '../../shared/protocol.ts';
import { Deferred, EmbedNode, flush } from './embedApp.ts';

interface ActualClient {
  readonly me: ParticipantView | null;
  readonly status: string;
  readonly playbackVolume: number;
  readonly playbackMuted: boolean;
  disconnect(): Promise<void>;
  retryMicrophone(): boolean;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
interface StageTrack { enabled: boolean; stopped: boolean; readyState: string; stops: number; stop(): void }
interface StageStream { getTracks(): StageTrack[]; getAudioTracks(): StageTrack[] }
export function actualState(overrides: Partial<ParticipantView> = {}): RoomStatePayload {
  return { roomId: 'same-room', name: '測試舞台', controllerId: 'guest', speakers: [], hands: [], audienceCount: 0,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', resumeToken: 'test-resume',
    me: { participantId: 'guest', name: '測試主控', role: 'controller', onStage: false, handRaised: false, muted: false,
      forceMuted: false, gainDb: 0, connected: true, joinedAt: 0, ...overrides } };
}
export class StageSocket {
  static OPEN = 1;
  static instances: StageSocket[] = [];
  readyState = StageSocket.OPEN;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { StageSocket.instances.push(this); }
  deliver(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(data: string): void {
    assert.equal(this.readyState, StageSocket.OPEN); const message = JSON.parse(data) as ClientMessage; this.sent.push(message);
    if (message.type === 'rtc:offer') queueMicrotask(() => {
      this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
      this.deliver({ type: 'ok', requestId: message.requestId });
    });
  }
  close(): void { this.readyState = 3; this.onclose?.(); }
}
export class StagePeer {
  static instances: StagePeer[] = [];
  connectionState = 'connected';
  signalingState = 'stable';
  localDescription: { type: 'offer'; sdp: string } | null = null;
  readonly offers: string[] = [];
  readonly replacements: (StageTrack | null)[] = [];
  gate: Deferred | undefined;
  gateEntered = false;
  ontrack: ((event: { streams: StageStream[] }) => void) | null = null;
  readonly transceiver = { direction: 'recvonly', sender: { track: null as StageTrack | null,
    replaceTrack: async (track: StageTrack | null) => {
      this.replacements.push(track);
      if (this.gate) { this.gateEntered = true; await this.gate.promise; }
      this.transceiver.sender.track = track;
    } } };
  constructor() { StagePeer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  async createOffer() {
    this.offers.push(this.transceiver.direction);
    return { type: 'offer' as const, sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` };
  }
  async setLocalDescription(description: { type: 'offer'; sdp: string }): Promise<void> { this.localDescription = description; this.signalingState = 'have-local-offer'; }
  async setRemoteDescription(): Promise<void> { this.signalingState = 'stable'; }
  async addIceCandidate(): Promise<void> {}
  close(): void { this.connectionState = 'closed'; }
}
export class StageContext {
  static instances: StageContext[] = [];
  closes = 0;
  constructor() { StageContext.instances.push(this); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData() {}, disconnect() {} }; }
  async resume(): Promise<void> {}
  async close(): Promise<void> { this.closes++; }
}
/** Complete production module and real SDK. Only external-host import, socket, DOM and browser media are replaced. */
export async function actualApp(t: TestContext, options: { deferCapture?: boolean; search?: string; output?: boolean } = {}) {
  const { StageClient, decodeName } = await import(new URL('../../packages/client/src/index.ts', import.meta.url).href);
  StageSocket.instances = []; StagePeer.instances = []; StageContext.instances = [];
  const tracks: StageTrack[] = [];
  const makeStream = (): { track: StageTrack; stream: StageStream } => {
    const track = Object.assign(new EventTarget(), { enabled: true, stopped: false, readyState: 'live', stops: 0,
      stop() { this.stopped = true; this.readyState = 'ended'; this.stops++; } });
    tracks.push(track); return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } };
  };
  const enumerations: ReturnType<typeof Promise.withResolvers<{ kind: string; deviceId: string; label: string }[]>>[] = [];
  const sinks: { id: string; work: Deferred }[] = [];
  const captures: { constraints: unknown; settled: boolean; resolve(): StageTrack; reject(error: unknown): void }[] = [];
  const globals = { window: new EventTarget(), WebSocket: StageSocket, RTCPeerConnection: StagePeer, AudioContext: StageContext,
    navigator: { mediaDevices: {
      enumerateDevices() { const work = Promise.withResolvers<{ kind: string; deviceId: string; label: string }[]>(); enumerations.push(work); return work.promise; },
      getUserMedia(constraints: unknown) {
      const work = Promise.withResolvers<StageStream>();
      const capture = { constraints, settled: false,
        resolve(): StageTrack {
          assert.equal(this.settled, false); this.settled = true;
          const { track, stream } = makeStream(); work.resolve(stream); return track;
        },
        reject(error: unknown): void { assert.equal(this.settled, false); this.settled = true; work.reject(error); },
      };
      captures.push(capture); if (!options.deferCapture) capture.resolve(); return work.promise;
    } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 1000; t.mock.method(performance, 'now', () => now);
  const nodes = new Map(['host', 'ws-path', 'room', 'code', 'name', 'status', 'hand-rejected', 'error-notice', 'last-error', 'error-dismiss', 'join', 'hand', 'mic', 'rename', 'room-name-panel', 'room-name-current', 'room-name-draft', 'room-name-update', 'hand-queue', 'hand-queue-summary', 'hand-queue-notice', 'hand-queue-list', 'stage', 'mic-retry', 'audio-retry', 'audio-retry-status', 'microphone-panel', 'microphone-device', 'microphone-refresh', 'microphone-apply', 'microphone-draft-notice', 'output-panel', 'output-device', 'output-refresh', 'output-apply', 'output-draft-notice', 'output-support', 'cancel-join', 'leave', 'audio', 'unlock'].map(id => [id, new EmbedNode()]));
  const node = (id: string): EmbedNode => { const found = nodes.get(id); assert.ok(found, id); return found; };
  node('error-notice').hidden = true; node('hand-rejected').hidden = true;
  const cancel = node('cancel-join'); cancel.hidden = cancel.disabled = true; cancel.textContent = '取消連線';
  const form = node('join'), stage = node('stage'), status = node('status'), mic = node('mic'), micRetry = node('mic-retry'), leave = node('leave');
  form.submitButton = new EmbedNode(); node('name').value = '測試主控';
  micRetry.hidden = micRetry.disabled = true; micRetry.textContent = '重試麥克風'; micRetry.setAttribute('aria-busy', 'false');
  const audio = Object.assign(node('audio'), { volume: 0.37, muted: true, srcObject: null as unknown, pauses: 0, plays: 0,
    pause() { this.pauses++; }, async play() { this.plays++; } });
  if (options.output) Reflect.set(audio, 'setSinkId', (id: string) => {
    const work = new Deferred(); sinks.push({ id, work });
    return work.promise.then(() => { Reflect.set(audio, 'sinkId', id); });
  });
  const clients: ActualClient[] = [];
  let calls = 0, ready = 0;
  const library = { StageClient: function (options: unknown): ActualClient {
    const client: ActualClient = new StageClient(options); clients.push(client);
    const retry = client.retryMicrophone.bind(client);
    t.mock.method(client, 'retryMicrophone', () => { calls++; return retry(); });
    client.on('micready', () => { ready++; }); return client;
  }, decodeName };
  const source = readFileSync(new URL('../../web/src/embed.ts', import.meta.url), 'utf8'), dynamicImport = 'import(/* @vite-ignore */ moduleUrl)';
  assert.equal(source.split(dynamicImport).length, 2); assert.equal(source.split("import './styles.css';").length, 2);
  const executable = stripTypeScriptTypes(source.replace("import './styles.css';", '').replace(dynamicImport, 'loadLibrary(moduleUrl)'));
  assert.doesNotMatch(executable, /\bimport\s*(?:\(|['"])/, 'no real external host import');
  runInNewContext(executable, {
    document: { createElement(tag: string) { assert.ok(['option', 'li', 'span', 'div', 'button'].includes(tag), `unmodeled element: ${tag}`); return new EmbedNode(tag); }, querySelector(selector: string) { assert.match(selector, /^#[a-z-]+$/); return node(selector.slice(1)); } },
    location: { search: options.search ?? '?room=same-room', origin: 'https://stage.example.test' },
    URL, URLSearchParams, Error, Promise, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    loadLibrary: async (url: string) => { assert.equal(url, 'https://stage.example.test/lib/stage-client.js'); return library; },
  }, { filename: 'web/src/embed.ts', timeout: 1000 });
  const tick = async (ms = 1): Promise<void> => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const until = async (predicate: () => boolean, label: string): Promise<void> => {
    for (let count = 0; count < 80 && !predicate(); count++) await tick(); assert.ok(predicate(), label);
  };
  t.after(async () => {
    try {
      for (const client of clients) await client.disconnect(); await flush();
      for (const sink of sinks) if (!sink.work.settled) sink.work.resolve();
      for (const enumeration of enumerations) enumeration.resolve([]);
      for (const peer of StagePeer.instances) if (peer.gate && !peer.gate.settled) peer.gate.resolve();
      for (const capture of captures) if (!capture.settled) capture.reject(new Error('fixture cleanup'));
      await flush();
      assert.ok(clients.every(client => client.status === 'disconnected' && client.me === null));
      assert.ok(StageSocket.instances.every(socket => socket.readyState === 3)); assert.ok(tracks.every(track => track.stopped));
      assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed')); assert.ok(StageContext.instances.every(context => context.closes === 1));
    } finally { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
  });
  return { stage, status, mic, micRetry, leave, form, node, audio, clients, tracks, captures, enumerations, sinks, tick, until,
    calls: () => calls, ready: () => ready,
    async join(overrides: Partial<ParticipantView> = {}) {
      form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
      socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
      await until(() => socket.sent.some(message => message.type === 'join'), 'join request');
      const request = socket.sent.find(message => message.type === 'join')!;
      socket.deliver({ type: 'room:state', ...actualState(overrides) }); socket.deliver({ type: 'ok', requestId: request.requestId });
      const peer = StagePeer.instances.at(-1)!; await until(() => peer.localDescription !== null && peer.signalingState === 'stable', 'initial negotiation');
      return { socket, peer };
    },
    async command(socket: StageSocket, type: 'stage:leave' | 'stage:approve') {
      const before = socket.sent.filter(message => message.type === type).length; stage.click();
      await until(() => socket.sent.filter(message => message.type === type).length === before + 1, type);
      const request = socket.sent.filter(message => message.type === type).at(-1)!; assert.ok(request.type === 'stage:leave' || request.type === 'stage:approve'); return request;
    },
  };
}

