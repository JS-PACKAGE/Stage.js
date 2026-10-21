import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it, type TestContext } from 'node:test';
import { StageClient, type StageClientOptions } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let n = 0; n < 48; n++) await Promise.resolve(); };
class Track extends EventTarget {
  enabled = true;
  readyState: MediaStreamTrackState = 'live';
  stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
  end() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}
function stream() {
  const track = new Track();
  return { track, captureGate: undefined as ReturnType<typeof deferred<void>> | undefined,
    value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
const asTrack = (source: ReturnType<typeof stream>) => source.track as unknown as MediaStreamTrack;
const listeners = (source: ReturnType<typeof stream>) => getEventListeners(source.track, 'ended');
function replayListeners(source: ReturnType<typeof stream>, callbacks: ReturnType<typeof listeners>) {
  for (const callback of callbacks) Reflect.apply(callback, source.track, [new Event('ended')]);
}
function state(onStage: boolean, muted = false): RoomStatePayload {
  return { roomId: 'room', name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, recording: false, recordingAvailable: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', resumeToken: 'test-resume-token',
    me: { participantId: 'guest', name: 'Guest', role: onStage ? 'speaker' : 'audience', onStage,
      handRaised: false, muted, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  static joinState = () => state(false);
  readyState = Socket.OPEN;
  onStage = false;
  private snapshot: RoomStatePayload | null = null;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    Socket.instances.push(this);
    queueMicrotask(() => this.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } }));
  }
  deliver(message: ServerMessage) {
    if (message.type === 'room:state') { this.onStage = message.me.onStage; this.snapshot = message; }
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(data: string) {
    assert.equal(this.readyState, Socket.OPEN);
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.type === 'join') this.deliver({ type: 'room:state', ...Socket.joinState() });
      if (message.type === 'mic:mute' || message.type === 'mic:unmute') {
        assert.ok(this.snapshot?.me.onStage);
        if (message.type === 'mic:unmute' && this.snapshot.me.forceMuted) {
          this.deliver({ type: 'error', requestId: message.requestId, code: 'forbidden', message: '禁止此操作。' });
          return;
        }
        const muted = message.type === 'mic:mute';
        this.deliver({ type: muted ? 'mic:muted' : 'mic:unmuted', participantId: 'guest' });
        this.deliver({ type: 'room:state', ...this.snapshot, me: { ...this.snapshot.me, muted } });
      }
      if (message.type === 'stage:leave') {
        this.deliver({ type: 'stage:left', participantId: 'guest', role: 'audience', reason: 'leave' });
        // The real room model clears self/forced mute when a participant leaves the stage.
        this.deliver({ type: 'room:state', ...state(false) });
      }
      if (message.type === 'rtc:offer') {
        // Match the hub's fail-closed policy instead of accepting a stale publishing offer.
        if (!this.onStage && message.payload.sdp.includes('a=sendrecv')) {
          this.deliver({ type: 'error', requestId: message.requestId, code: 'forbidden', message: '禁止此操作。' });
          return;
        }
        this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
      }
      if ('requestId' in message) this.deliver({ type: 'ok', requestId: message.requestId });
    });
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

type ReplacementGate = ReturnType<typeof deferred<void>> & { entered: boolean; attachBeforeSettle: boolean };
class Peer {
  static instances: Peer[] = [];
  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly replacements: (MediaStreamTrack | null)[] = [];
  readonly offers: { direction: string; onStage: boolean }[] = [];
  readonly gates: ReplacementGate[] = [];
  private readonly pendingGates: ReplacementGate[] = [];
  readonly transceiver = { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
    replaceTrack: async (track: MediaStreamTrack | null) => {
      this.replacements.push(track);
      const gate = this.pendingGates.shift();
      if (gate) {
        // replaceTrack may switch its sender before its promise resolves; this models ordering, not browser timing.
        if (gate.attachBeforeSettle) this.transceiver.sender.track = track;
        gate.entered = true; await gate.promise;
      }
      this.transceiver.sender.track = track;
    } } };
  constructor() { Peer.instances.push(this); }
  holdNextReplacement(attachBeforeSettle = false): ReplacementGate {
    const gate = { ...deferred<void>(), entered: false, attachBeforeSettle };
    this.gates.push(gate); this.pendingGates.push(gate); return gate;
  }
  addTransceiver() { return this.transceiver; }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const direction = this.transceiver.direction;
    this.offers.push({ direction, onStage: Socket.instances.at(-1)!.onStage });
    return { type: 'offer', sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${direction}\r\n` };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description; this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description; this.signalingState = 'stable';
  }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}
class Context {
  static instances: Context[] = [];
  static attempts = 0;
  static failAt: 'constructor' | 'analyser' | undefined;
  static readonly failure = new DOMException('controlled meter failure', 'NotSupportedError');
  closes = 0;
  sources = 0;
  analysers = 0;
  connects = 0;
  disconnects = 0;
  reads: Float32Array[] = [];
  constructor() {
    Context.attempts++;
    if (Context.failAt === 'constructor') throw Context.failure;
    Context.instances.push(this);
  }
  createMediaStreamSource() {
    this.sources++;
    return { connect: () => { this.connects++; }, disconnect: () => { this.disconnects++; } };
  }
  createAnalyser() {
    this.analysers++;
    if (Context.failAt === 'analyser') throw Context.failure;
    return { fftSize: 0, disconnect: () => { this.disconnects++; },
      getFloatTimeDomainData: (samples: Float32Array) => { this.reads.push(samples); samples.fill(0.25); } };
  }
  async resume() {}
  async close() { this.closes++; }
}

/** Real SDK/public operations, fake socket and browser media; no native capture or network. */
function setup(t: TestContext, options: { holdCapture?: boolean; clientOptions?: Partial<StageClientOptions> } = {}) {
  Socket.instances = []; Socket.joinState = () => state(false); Peer.instances = []; Context.instances = []; Context.attempts = 0; Context.failAt = undefined;
  const sources: ReturnType<typeof stream>[] = [];
  const captureRequests: ReturnType<typeof deferred<MediaStream>>[] = [];
  const captureConstraints: MediaStreamConstraints[] = [];
  const supplied: (ReturnType<typeof stream> | Error)[] = [];
  const sampleBuffers: Float32Array[] = [];
  const NativeSamples = Float32Array;
  class Samples extends NativeSamples { constructor(length: number) { super(length); sampleBuffers.push(this); } }
  const audioEffects = { created: 0, appended: 0 };
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'AudioContext', 'navigator', 'document', 'Float32Array']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: new EventTarget(), WebSocket: Socket,
    RTCPeerConnection: Peer, AudioContext: Context, Float32Array: Samples,
    document: { createElement() { audioEffects.created++; return { autoplay: false, hidden: false, pause() {}, remove() {} }; },
      body: { append() { audioEffects.appended++; } } },
    navigator: { mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
      captureConstraints.push(constraints);
      if (options.holdCapture) { const request = deferred<MediaStream>(); captureRequests.push(request); return request.promise; }
      const next = supplied.shift();
      if (next instanceof Error) throw next;
      const source = next ?? stream(); sources.push(source);
      await source.captureGate?.promise; return source.value;
    } } } })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms = 1) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  async function until(predicate: () => boolean, label: string) {
    for (let n = 0; n < 40; n++) { if (predicate()) return; await tick(); }
    assert.ok(predicate(), `bounded fake-time wait: ${label}`);
  }
  async function complete<T>(promise: Promise<T>, label: string): Promise<T> {
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    await until(() => settled, label); return promise;
  }
  const audio = { volume: 1, muted: false, pause() {}, srcObject: null } as unknown as HTMLAudioElement;
  const clientOptions: StageClientOptions = { url: 'ws://localhost/ws', audioElement: audio, requestTimeoutMs: 1000, reconnect: { initialDelayMs: 20, maxDelayMs: 20 }, ...options.clientOptions };
  const client = new StageClient(clientOptions);
  const errors: string[] = [], micErrors: { name: string; message: string }[] = [];
  let micReady = 0;
  client.on('error', event => errors.push(event.detail.code));
  client.on('micerror', event => micErrors.push(event.detail));
  client.on('micready', () => { micReady++; });
  t.after(async () => {
    await client.disconnect();
    for (const source of sources) source.captureGate?.resolve();
    for (const peer of Peer.instances) for (const gate of peer.gates) gate.resolve();
    await flush();
    const cleanListeners = sources.every(source => listeners(source).length === 0);
    const cleanMeters = Context.instances.every(context => context.closes === 1);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    assert.ok(cleanListeners, 'disconnect removes all room ended listeners');
    assert.ok(cleanMeters, 'every created meter is closed exactly once');
  });
  async function join() {
    await complete(client.join({ roomId: 'room', name: 'Guest' }), 'public join');
    const socket = Socket.instances.at(-1)!, peer = Peer.instances.at(-1)!;
    await until(() => peer.remoteDescription !== null && !client['negotiating'], 'initial audience negotiation');
    return { socket, peer };
  }
  async function promote(socket: Socket, peer: Peer, muted = false) {
    socket.deliver({ type: 'room:state', ...state(true, muted) });
    await until(() => peer.transceiver.direction === 'sendrecv' && peer.signalingState === 'stable'
      && peer.transceiver.sender.track !== null && !client['negotiating'], 'speaker capture and negotiation');
  }
  function noRoomGraph() {
    assert.equal(Context.attempts, 0, 'room capture must not construct AudioContext');
    assert.equal(Context.instances.length, 0);
    assert.equal(sampleBuffers.length, 0, 'room capture must not allocate meter sample buffers');
    assert.equal(client.micLevel, 0);
  }
  return { client, clientOptions, audioEffects, sampleBuffers, noRoomGraph, sources, supplied, captureRequests, captureConstraints, errors, micErrors, micReady: () => micReady, tick, until, complete, join, promote };
}

type Harness = ReturnType<typeof setup>;
async function receiving(h: Harness, peer: Peer) {
  await h.until(() => peer.transceiver.sender.track === null && peer.transceiver.direction === 'recvonly'
    && !h.client['negotiating'], 'receive-only ended-track reconciliation');
  assert.match(peer.localDescription!.sdp!, /a=recvonly/);
}
async function publishing(h: Harness, peer: Peer, source: ReturnType<typeof stream>) {
  await h.until(() => peer.transceiver.sender.track === asTrack(source) && peer.transceiver.direction === 'sendrecv'
    && !h.client['negotiating'], 'fresh microphone publication');
}

for (const enableMicMeter of [undefined, false]) it(`clears naturally ended capture and admits only explicit retry (meter=${enableMicMeter ?? 'default'})`, async t => {
  const h = setup(t, { clientOptions: { enableMicMeter } }), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const original = h.sources[0]!, retired = listeners(original);
  assert.equal(retired.length, 1);
  assert.equal(h.client.micLevel, enableMicMeter === false ? 0 : 0.25);
  const snapshots: unknown[] = [];
  h.client.on('micerror', () => snapshots.push([h.client['mic'], h.client.micLevel, Context.instances.map(c => c.closes)]));
  original.track.end();
  assert.deepEqual(snapshots, [[null, 0, enableMicMeter === false ? [] : [1]]]);
  assert.deepEqual(h.micErrors.map(error => error.name), ['NotReadableError']);
  assert.equal(listeners(original).length, 0);
  await receiving(h, peer);
  socket.deliver({ type: 'room:state', ...state(true) }); await h.tick(100);
  assert.equal(h.sources.length, 1, 'state updates and elapsed time cannot request another microphone');
  assert.equal(h.micReady(), 1);
  replayListeners(original, retired);
  assert.equal(h.micErrors.length, 1, 'duplicate or queued retired callbacks are inert');
  assert.equal(h.client.retryMicrophone(), true);
  assert.equal(h.client.retryMicrophone(), false, 'one permission wait per explicit retry');
  await h.until(() => h.sources.length === 2, 'explicit fresh capture');
  await publishing(h, peer, h.sources[1]!);
  assert.equal(h.micReady(), 2);
  assert.equal(h.client.retryMicrophone(), false);
  replayListeners(original, retired); await h.tick();
  assert.equal(h.client['mic'], h.sources[1]!.value);
  assert.equal(h.micErrors.length, 1);
  if (enableMicMeter === false) h.noRoomGraph();
  assert.deepEqual(h.errors, []);
});

for (const enableMicMeter of [undefined, false]) it(`rejects an initially ended capture before micready (meter=${enableMicMeter ?? 'default'})`, async t => {
  const h = setup(t, { clientOptions: { enableMicMeter } }), { socket, peer } = await h.join();
  const ended = stream(); ended.track.end(); h.supplied.push(ended);
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => h.micErrors.length === 1, 'initial ended capture error');
  await receiving(h, peer);
  assert.equal(h.micReady(), 0);
  assert.equal(h.client['mic'], null);
  assert.equal(listeners(ended).length, 0);
  assert.equal(h.micErrors[0]!.name, 'StageError');
  assert.ok(!peer.replacements.includes(asTrack(ended)), 'ended capture must never reach the sender');
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.sources.length === 2, 'retry capture');
  await publishing(h, peer, h.sources[1]!);
});

it('transfers the ended listener on device replacement and retires old callbacks', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const original = h.sources[0]!, retired = listeners(original);
  await h.complete(h.client.setInputDevice('new-device'), 'device replacement');
  const current = h.sources[1]!;
  assert.equal(listeners(original).length, 0); assert.equal(listeners(current).length, 1);
  assert.equal(original.track.stops, 1, 'explicit stop has no native ended event');
  assert.equal(h.micErrors.length, 0);
  replayListeners(original, retired);
  assert.equal(h.client['mic'], current.value); assert.equal(h.micErrors.length, 0);
  current.track.end(); await receiving(h, peer);
  assert.equal(h.micErrors[0]!.name, 'NotReadableError');
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.sources.length === 3, 'replacement-ended retry');
  await publishing(h, peer, h.sources[2]!);
  assert.deepEqual((h.captureConstraints[2]!.audio as MediaTrackConstraints).deviceId, { exact: 'new-device' });
});

for (const phase of ['initial', 'replacement'] as const) it(`handles natural end synchronously inside ${phase} micready`, async t => {
  const h = setup(t), { socket, peer } = await h.join();
  if (phase === 'replacement') await h.promote(socket, peer);
  h.client.on('micready', () => h.sources.at(-1)!.track.end());
  if (phase === 'initial') socket.deliver({ type: 'room:state', ...state(true) });
  else await h.complete(h.client.setInputDevice('ends-in-ready'), 'replacement callback');
  await h.until(() => h.micErrors.length === 1, 'micready end error'); await receiving(h, peer);
  assert.equal(h.client['mic'], null); assert.equal(h.client.micLevel, 0);
  assert.equal(h.micReady(), phase === 'initial' ? 1 : 2);
  assert.equal(h.sources.length, phase === 'initial' ? 1 : 2);
  assert.equal(h.micErrors[0]!.name, 'NotReadableError'); assert.deepEqual(h.errors, []);
});

it('allows one synchronous micerror retry without a later ended cleanup undoing recovery', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const admissions: boolean[] = [];
  h.client.on('micerror', () => admissions.push(h.client.retryMicrophone(), h.client.retryMicrophone()));
  h.sources[0]!.track.end();
  assert.deepEqual(admissions, [true, false]);
  await h.until(() => h.sources.length === 2, 'reentrant retry capture'); await publishing(h, peer, h.sources[1]!);
  assert.equal(h.client['mic'], h.sources[1]!.value); assert.equal(h.micErrors.length, 1);
  assert.equal(h.client.retryMicrophone(), false); assert.deepEqual(h.errors, []);
});

it('does not touch a new session created synchronously by micerror', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const original = h.sources[0]!, retired = listeners(original);
  let joined: Promise<void> | undefined;
  h.client.on('micerror', () => {
    void h.client.disconnect();
    joined = h.client.join({ roomId: 'new-room', name: 'Guest' }); void joined.catch(() => {});
  });
  original.track.end(); assert.ok(joined); await h.complete(joined, 'micerror-triggered rejoin');
  const currentSocket = Socket.instances.at(-1)!, currentPeer = Peer.instances.at(-1)!;
  await h.promote(currentSocket, currentPeer); const current = h.sources[1]!;
  replayListeners(original, retired); await h.tick(100);
  assert.equal(peer.connectionState, 'closed'); assert.equal(currentPeer.connectionState, 'connected');
  assert.equal(h.client['mic'], current.value); assert.equal(current.track.readyState, 'live');
  assert.equal(h.client['session']!.roomId, 'new-room'); assert.equal(h.micErrors.length, 1); assert.deepEqual(h.errors, []);
});

for (const action of ['disconnect', 'leave-stage'] as const) it(`honors synchronous micerror ${action}`, async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  h.client.on('micerror', () => {
    if (action === 'disconnect') void h.client.disconnect();
    else socket.deliver({ type: 'room:state', ...state(false) });
  });
  h.sources[0]!.track.end(); await h.tick(100);
  assert.equal(h.client['mic'], null); assert.equal(h.client.retryMicrophone(), false);
  assert.equal(h.sources.length, 1); assert.equal(h.micErrors.length, 1);
  if (action === 'disconnect') assert.equal(peer.connectionState, 'closed');
  else await receiving(h, peer);
  assert.deepEqual(h.errors, []);
});

it('keeps ordinary self/forced mute and native mute events distinct from ended capture', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const current = h.sources[0]!;
  await h.complete(h.client.mute(), 'public mute');
  assert.equal(current.track.enabled, false); assert.equal(h.client.micLevel, 0);
  await h.complete(h.client.unmute(), 'public unmute');
  current.track.dispatchEvent(new Event('mute')); current.track.dispatchEvent(new Event('unmute'));
  const forced = state(true, true); forced.me.forceMuted = true;
  socket.deliver({ type: 'room:state', ...forced }); await h.tick();
  assert.equal(h.client['mic'], current.value); assert.equal(current.track.readyState, 'live');
  assert.equal(listeners(current).length, 1); assert.equal(h.micErrors.length, 0); assert.equal(h.client.retryMicrophone(), false);
  current.track.end(); await receiving(h, peer);
  assert.equal(h.client.retryMicrophone(), true); await h.until(() => h.sources.length === 2, 'muted retry');
  await publishing(h, peer, h.sources[1]!);
  assert.equal(h.sources[1]!.track.enabled, false); assert.equal(h.client.micLevel, 0);
});

it('retains explicit-only retry through WebSocket reconnect and room status return', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  Socket.joinState = () => state(true);
  socket.close(); assert.equal(h.client.status, 'reconnecting');
  h.sources[0]!.track.end(); assert.equal(h.client.retryMicrophone(), false);
  await h.until(() => Socket.instances.length === 2 && h.client.status === 'live', 'same-seat reconnect');
  const resumed = Socket.instances.at(-1)!;
  await receiving(h, peer);
  assert.equal(Peer.instances.length, 1); assert.equal(h.sources.length, 1);
  resumed.deliver({ type: 'status', state: 'waiting' }); assert.equal(h.client.retryMicrophone(), false);
  resumed.deliver({ type: 'status', state: 'live' }); await h.tick(100);
  assert.equal(h.sources.length, 1, 'returning live cannot reopen capture');
  assert.equal(h.client.retryMicrophone(), true); await h.until(() => h.sources.length === 2, 'post-reconnect retry');
  await publishing(h, peer, h.sources[1]!);
  assert.deepEqual(h.errors, ['disconnected'], 'same-peer media survives the existing disconnected negotiation error');
});

for (const phase of ['permission', 'replacement'] as const) it(`preserves a healthy explicit replacement when the old track ends during ${phase}`, async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const original = h.sources[0]!, candidate = stream(); h.supplied.push(candidate);
  if (phase === 'permission') candidate.captureGate = deferred<void>();
  const gate = phase === 'replacement' ? peer.holdNextReplacement(true) : undefined;
  const change = h.client.setInputDevice('healthy-pending'); void change.catch(() => {});
  await h.until(() => phase === 'permission' ? h.sources.length === 2 : !!gate?.entered, 'explicit replacement pending');
  original.track.end(); await h.tick();
  assert.equal(candidate.track.readyState, 'live', 'losing the old source must not cancel the explicit candidate');
  assert.equal(h.micErrors.length, 1); assert.equal(h.micReady(), 1);
  candidate.captureGate?.resolve(); gate?.resolve();
  await h.complete(change, 'healthy pending replacement completion'); await publishing(h, peer, candidate);
  assert.equal(h.client['mic'], candidate.value); assert.equal(listeners(candidate).length, 1);
  assert.equal(h.client.retryMicrophone(), false); assert.equal(h.sources.length, 2); assert.equal(h.micReady(), 2);
  candidate.track.end(); await receiving(h, peer);
  assert.equal(h.micErrors.length, 2); assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.sources.length === 3, 'replacement ended retry'); await publishing(h, peer, h.sources[2]!);
  assert.deepEqual(h.errors, []);
});

it('rejects an already-ended device candidate without disturbing a live microphone', async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false } }), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const original = h.sources[0]!, candidate = stream(); candidate.track.end(); h.supplied.push(candidate);
  await assert.rejects(h.complete(h.client.setInputDevice('ended-candidate'), 'ended candidate rejection'), { code: 'media_error' });
  assert.equal(h.client['mic'], original.value); assert.equal(peer.transceiver.sender.track, asTrack(original));
  assert.equal(original.track.readyState, 'live'); assert.equal(listeners(original).length, 1);
  assert.ok(!peer.replacements.includes(asTrack(candidate))); assert.equal(listeners(candidate).length, 0);
  assert.equal(h.client['inputDeviceId'], ''); assert.equal(h.micReady(), 1); assert.equal(h.micErrors.length, 0);
  h.noRoomGraph(); assert.equal(h.client.retryMicrophone(), false);
});

const endedTransactions: { early: boolean; rejects: boolean; oldEnds: boolean; meter?: boolean }[] = [
  { early: false, rejects: false, oldEnds: false },
  { early: true, rejects: false, oldEnds: false },
  { early: false, rejects: true, oldEnds: false },
  { early: true, rejects: true, oldEnds: false },
  { early: false, rejects: false, oldEnds: true },
  { early: true, rejects: false, oldEnds: true },
  { early: true, rejects: true, oldEnds: true },
  { early: true, rejects: true, oldEnds: false, meter: false },
];
for (const { early, rejects, oldEnds, meter } of endedTransactions) it(`reconciles a candidate ending during replaceTrack (early=${early}, rejects=${rejects}, oldEnds=${oldEnds}, meter=${meter ?? 'default'})`, async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: meter } }), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const original = h.sources[0]!, gate = peer.holdNextReplacement(early);
  const change = h.client.setInputDevice('ends-during-replace'); void change.catch(() => {});
  await h.until(() => gate.entered, 'candidate replacement held'); const candidate = h.sources[1]!;
  candidate.track.end(); if (oldEnds) original.track.end(); await h.tick();
  assert.equal(h.micReady(), 1, 'pending candidate is not ready');
  if (rejects) gate.reject(new DOMException('controlled replaceTrack failure', 'InvalidModificationError'));
  else gate.resolve();
  await assert.rejects(h.complete(change, 'ended candidate transaction rejects'),
    rejects ? { name: 'InvalidModificationError' } : { code: 'media_error' });
  if (oldEnds) await receiving(h, peer); else await publishing(h, peer, original);
  assert.equal(h.client['mic'], oldEnds ? null : original.value);
  assert.equal(listeners(candidate).length, 0); assert.equal(candidate.track.readyState, 'ended');
  assert.equal(listeners(original).length, oldEnds ? 0 : 1);
  assert.equal(h.micReady(), 1); assert.equal(h.micErrors.length, oldEnds ? 1 : 0);
  assert.equal(h.client['inputDeviceId'], '');
  assert.deepEqual(Context.instances.map(context => context.closes), meter === false ? [] : oldEnds ? [1, 1] : [0, 1]);
  socket.deliver({ type: 'room:state', ...state(true) }); await h.tick(100);
  assert.equal(h.sources.length, 2, 'rollback must not trigger another permission request');
  if (oldEnds) {
    assert.equal(h.client.retryMicrophone(), true); await h.until(() => h.sources.length === 3, 'retry after both sources ended');
    await publishing(h, peer, h.sources[2]!);
  } else {
    assert.equal(h.client.retryMicrophone(), false);
    await h.complete(h.client.setInputDevice('working-candidate'), 'explicit replacement after rollback');
    await publishing(h, peer, h.sources[2]!);
  }
  assert.deepEqual(h.errors, []);
});

it('keeps retry available after the old track ends and pending device permission rejects', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const candidate = stream(); candidate.captureGate = deferred<void>(); h.supplied.push(candidate);
  const change = h.client.setInputDevice('unavailable'); void change.catch(() => {});
  await h.until(() => h.sources.length === 2, 'candidate permission pending');
  h.sources[0]!.track.end(); candidate.captureGate.reject(new DOMException('controlled permission rejection', 'NotAllowedError'));
  await assert.rejects(h.complete(change, 'permission rejection'), { name: 'NotAllowedError' });
  // A rejected getUserMedia promise never delivered this fake source to the SDK.
  candidate.track.stop();
  await receiving(h, peer); assert.equal(h.micErrors.length, 1); assert.equal(h.micReady(), 1);
  assert.equal(h.client.retryMicrophone(), true); await h.until(() => h.sources.length === 3, 'retry after permission rejection');
  await publishing(h, peer, h.sources[2]!); assert.deepEqual(h.errors, []);
});

it('keeps a failed explicit retry receive-only until another explicit attempt succeeds', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  h.sources[0]!.track.end(); await receiving(h, peer);
  h.supplied.push(new DOMException('controlled retry denial', 'NotAllowedError'));
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.micErrors.length === 2, 'retry failure'); await receiving(h, peer);
  assert.deepEqual(h.micErrors.map(error => error.name), ['NotReadableError', 'NotAllowedError']);
  assert.equal(h.micReady(), 1); assert.equal(h.captureConstraints.length, 2);
  socket.deliver({ type: 'room:state', ...state(true) }); await h.tick(100);
  assert.equal(h.captureConstraints.length, 2);
  assert.equal(h.client.retryMicrophone(), true); await h.until(() => h.sources.length === 2, 'second explicit retry');
  await publishing(h, peer, h.sources[1]!); assert.equal(h.micReady(), 2); assert.deepEqual(h.errors, []);
});

for (const action of ['offstage', 'disconnect', 'kicked', 'closed'] as const) it(`removes ended listeners on ${action} and ignores delayed events after reentry`, async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const original = h.sources[0]!, retired = listeners(original);
  if (action === 'offstage') await h.complete(h.client.leaveStage(), 'stage exit');
  else if (action === 'disconnect') await h.client.disconnect();
  else if (action === 'kicked') socket.deliver({ type: 'kicked', roomId: 'room' });
  else socket.deliver({ type: 'room:closed', roomId: 'room' });
  await h.tick(); assert.equal(listeners(original).length, 0); assert.equal(original.track.readyState, 'ended');
  assert.equal(h.client.retryMicrophone(), false); replayListeners(original, retired);
  let currentSocket = socket, currentPeer = peer;
  if (action !== 'offstage') ({ socket: currentSocket, peer: currentPeer } = await h.join());
  await h.promote(currentSocket, currentPeer); const current = h.sources[1]!;
  replayListeners(original, retired); original.track.dispatchEvent(new Event('ended')); await h.tick(100);
  assert.equal(h.client['mic'], current.value); assert.equal(current.track.readyState, 'live');
  assert.equal(listeners(current).length, 1); assert.equal(h.micErrors.length, 0); assert.equal(h.sources.length, 2);
  assert.deepEqual(h.errors, []);
});

it('keeps independent preview capture alive across room ended recovery', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const preview = await h.client.startMicTest(), previewSource = h.sources[1]!;
  assert.equal(listeners(previewSource).length, 1);
  h.sources[0]!.track.end(); await receiving(h, peer);
  assert.equal(previewSource.track.readyState, 'live'); assert.equal(preview.level(), 0.25);
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 0]);
  assert.equal(h.client.retryMicrophone(), true); await h.until(() => h.sources.length === 3, 'room retry alongside preview');
  await publishing(h, peer, h.sources[2]!); assert.equal(previewSource.track.readyState, 'live');
  const errors = h.micErrors.length;
  previewSource.track.end(); await h.tick();
  assert.equal(h.micErrors.length, errors, 'preview track events never enter room recovery');
  assert.equal(listeners(previewSource).length, 0); assert.equal(preview.level(), 0);
  assert.equal(Context.instances[1]!.closes, 1); assert.equal(previewSource.track.stops, 1);
  assert.equal(h.client['micTests'].size, 0);
  preview.stop(); assert.equal(Context.instances[1]!.closes, 1); assert.equal(previewSource.track.stops, 1);
  assert.equal(h.client['mic'], h.sources[2]!.value); assert.equal(h.client.retryMicrophone(), false);
  assert.deepEqual(h.errors, []);
});

for (const phase of ['initial', 'replacement'] as const) it(`rejects capture that ends while constructing the ${phase} meter`, async t => {
  const h = setup(t), { socket, peer } = await h.join();
  if (phase === 'replacement') await h.promote(socket, peer);
  const ended = stream(); h.supplied.push(ended);
  const createAnalyser = Context.prototype.createAnalyser;
  t.mock.method(Context.prototype, 'createAnalyser', function (this: Context) {
    ended.track.end(); return createAnalyser.call(this);
  });
  if (phase === 'initial') {
    socket.deliver({ type: 'room:state', ...state(true) });
    await h.until(() => h.micErrors.length === 1, 'initial meter-construction end'); await receiving(h, peer);
    assert.equal(h.micReady(), 0); assert.equal(h.client['mic'], null);
    assert.equal(h.micErrors[0]!.name, 'NotReadableError');
  } else {
    await assert.rejects(h.complete(h.client.setInputDevice('ended-in-meter'), 'meter-construction rejection'), { code: 'media_error' });
    await publishing(h, peer, h.sources[0]!);
    assert.equal(h.micReady(), 1); assert.equal(h.micErrors.length, 0);
    assert.equal(h.sources[0]!.track.readyState, 'live');
  }
  assert.ok(!peer.replacements.includes(asTrack(ended)), 'meter-setup loss must not publish the ended candidate');
  assert.equal(listeners(ended).length, 0); assert.equal(Context.instances.at(-1)!.closes, 1);
  assert.deepEqual(h.errors, []);
});

it('does not create an extra capture when micerror retries during a healthy pending replacement', async t => {
  const h = setup(t), { socket, peer } = await h.join(); await h.promote(socket, peer);
  const gate = peer.holdNextReplacement(), admissions: boolean[] = [];
  const change = h.client.setInputDevice('already-requested'); void change.catch(() => {});
  await h.until(() => gate.entered, 'healthy replacement pending');
  h.client.on('micerror', () => admissions.push(h.client.retryMicrophone()));
  h.sources[0]!.track.end(); assert.deepEqual(admissions, [true]);
  gate.resolve(); await h.complete(change, 'healthy replacement after synchronous retry');
  await publishing(h, peer, h.sources[1]!); await h.tick(100);
  assert.equal(h.sources.length, 2); assert.equal(h.micReady(), 2); assert.equal(h.micErrors.length, 1);
  assert.equal(h.client.retryMicrophone(), false); assert.deepEqual(h.errors, []);
});

for (const early of [false, true]) it(`reconciles natural end while initial sender publication is pending (early=${early})`, async t => {
  const h = setup(t), { socket, peer } = await h.join(), gate = peer.holdNextReplacement(early);
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => gate.entered, 'initial sender publication held');
  const original = h.sources[0]!;
  assert.equal(h.micReady(), 1); assert.equal(listeners(original).length, 1);
  original.track.end(); assert.equal(h.micErrors.length, 1);
  gate.resolve(); await receiving(h, peer);
  assert.equal(h.client['mic'], null); assert.equal(h.sources.length, 1);
  assert.ok(peer.offers.every(offer => offer.direction === 'recvonly'), 'a stale initial continuation cannot publish sendrecv');
  assert.equal(h.client.retryMicrophone(), true); await h.until(() => h.sources.length === 2, 'retry after initial sender race');
  await publishing(h, peer, h.sources[1]!); assert.deepEqual(h.errors, []);
});
