import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { StageClient, StageError, type StageClientOptions } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let n = 0; n < 48; n++) await Promise.resolve(); };
function stream() {
  const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; } });
  return { track, value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
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
      if (message.type === 'join') this.deliver({ type: 'room:state', ...state(false) });
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
  Socket.instances = []; Peer.instances = []; Context.instances = []; Context.attempts = 0; Context.failAt = undefined;
  const sources: ReturnType<typeof stream>[] = [];
  const captureRequests: ReturnType<typeof deferred<MediaStream>>[] = [];
  const captureConstraints: MediaStreamConstraints[] = [];
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
      const source = stream(); sources.push(source); return source.value;
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
  const clientOptions: StageClientOptions = { url: 'ws://localhost/ws', audioElement: audio, requestTimeoutMs: 1000, ...options.clientOptions };
  const client = new StageClient(clientOptions);
  const errors: string[] = [], micErrors: unknown[] = [];
  let micReady = 0;
  client.on('error', event => errors.push(event.detail.code));
  client.on('micerror', event => micErrors.push(event.detail));
  client.on('micready', () => { micReady++; });
  t.after(async () => {
    await client.disconnect();
    for (const peer of Peer.instances) for (const gate of peer.gates) gate.resolve();
    await flush();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
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
  return { client, clientOptions, audioEffects, sampleBuffers, noRoomGraph, sources, captureRequests, captureConstraints, errors, micErrors, micReady: () => micReady, tick, until, complete, join, promote };
}

const enabledCases: { name: string; options: Partial<StageClientOptions> }[] = [
  { name: 'omitted', options: {} },
  { name: 'undefined', options: { enableMicMeter: undefined } },
  { name: 'true', options: { enableMicMeter: true } },
];

for (const { name, options } of enabledCases) it(`keeps the ${name} room meter eager with one reusable sample buffer`, async t => {
  const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
  assert.equal(Context.attempts, 0, 'audience join does not allocate a microphone graph');
  await h.promote(socket, peer);
  assert.equal(Context.attempts, 1, 'the graph is eager before the first level read');
  assert.equal(Context.instances[0]!.sources, 1); assert.equal(Context.instances[0]!.analysers, 1);
  assert.equal(Context.instances[0]!.connects, 1); assert.equal(h.sampleBuffers.length, 1);
  assert.equal(h.sampleBuffers[0]!.length, 2048);
  assert.equal(h.client.micLevel, 0.25); assert.equal(h.client.micLevel, 0.25);
  assert.deepEqual(Context.instances[0]!.reads, [h.sampleBuffers[0], h.sampleBuffers[0]]);
  await h.complete(h.client.mute(), 'mute'); assert.equal(h.client.micLevel, 0);
  assert.equal(Context.instances[0]!.reads.length, 2, 'muted reads skip sample work');
  assert.equal(h.sources[0]!.track.stops, 0); assert.equal(Context.instances[0]!.closes, 0);
  await h.complete(h.client.unmute(), 'unmute'); assert.equal(h.client.micLevel, 0.25);
  await h.client.disconnect(); await h.client.disconnect();
  assert.equal(h.sources[0]!.track.stops, 1); assert.equal(Context.instances[0]!.closes, 1);
  assert.equal(Context.instances[0]!.disconnects, 2); assert.equal(h.client.micLevel, 0);
});

for (const { name, options } of enabledCases.filter(entry => entry.name !== 'undefined')) {
  for (const failure of ['constructor', 'analyser'] as const) {
    it(`preserves ${name} initial ${failure} failure and explicit retry`, async t => {
      const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
      Context.failAt = failure;
      socket.deliver({ type: 'room:state', ...state(true) });
      await h.until(() => h.micErrors.length === 1, 'meter failure');
      await h.until(() => !h.client['negotiating'] && peer.signalingState === 'stable', 'receive-only fallback');
      assert.equal(Context.attempts, 1); assert.equal(h.sources[0]!.track.stops, 1);
      assert.equal(h.client['mic'], null); assert.equal(h.client['micFailed'], true);
      assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.transceiver.direction, 'recvonly');
      assert.equal(h.micReady(), 0); assert.equal(h.client.micLevel, 0); assert.deepEqual(h.errors, []);
      assert.deepEqual(h.micErrors, [{ name: 'NotSupportedError', message: '無法啟用麥克風，請確認 HTTPS、裝置及瀏覽器權限後重新上台。' }]);
      assert.deepEqual(Context.instances.map(context => context.closes), failure === 'constructor' ? [] : [1]);
      assert.equal(h.sampleBuffers.length, 0);
      Context.failAt = undefined;
      assert.equal(h.client.retryMicrophone(), true); assert.equal(h.client.retryMicrophone(), false);
      await h.until(() => peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'retry installation');
      assert.equal(h.sources.length, 2); assert.equal(peer.transceiver.sender.track, h.sources[1]!.track);
      assert.equal(Context.attempts, 2); assert.equal(h.client.micLevel, 0.25); assert.equal(h.micReady(), 1);
    });

    it(`preserves ${name} replacement ${failure} failure without retiring current capture`, async t => {
      const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
      await h.promote(socket, peer);
      const original = h.sources[0]!, offers = peer.offers.length;
      Context.failAt = failure;
      await h.complete(assert.rejects(h.client.setInputDevice('failed-device'), error => error === Context.failure), 'failed replacement');
      assert.equal(h.sources[1]!.track.stops, 1); assert.equal(original.track.stops, 0);
      assert.equal(peer.transceiver.sender.track, original.track); assert.equal(h.client['mic'], original.value);
      assert.equal(h.client['inputDeviceId'], ''); assert.equal(h.client['micFailed'], false);
      assert.equal(h.client.micLevel, 0.25); assert.equal(h.micReady(), 1);
      assert.equal(peer.offers.length, offers); assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
      assert.deepEqual(Context.instances.map(context => context.closes), failure === 'constructor' ? [0] : [0, 1]);
    });
  }
}

for (const mode of [undefined, true, false]) it(`fires initial micready before sender installation (enableMicMeter=${String(mode)})`, async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: mode } }), { socket, peer } = await h.join();
  const gate = peer.holdNextReplacement();
  const observed: { track: MediaStreamTrack | null; direction: string; entered: boolean; graphs: number }[] = [];
  h.client.on('micready', () => observed.push({ track: peer.transceiver.sender.track,
    direction: peer.transceiver.direction, entered: gate.entered, graphs: Context.attempts }));
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => gate.entered, 'initial sender replacement');
  assert.deepEqual(observed, [{ track: null, direction: 'recvonly', entered: false, graphs: mode === false ? 0 : 1 }]);
  assert.equal(h.client['mic'], h.sources[0]!.value, 'capture ownership already belongs to the room');
  gate.resolve();
  await h.until(() => peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'initial publishing');
  assert.equal(peer.transceiver.sender.track, h.sources[0]!.track); assert.equal(h.micReady(), 1);
});

const invalidOptions: unknown[] = [null, 0, 1, -1, NaN, Infinity, 'true', 'false', '', {}, [], new Boolean(false), 1n, Symbol('meter')];
for (const ownedAudio of [false, true]) it(`rejects non-boolean meter options before ${ownedAudio ? 'owned audio creation' : 'supplied audio mutation'}`, async t => {
  const h = setup(t);
  for (const value of invalidOptions) {
    const audio = { autoplay: false } as HTMLAudioElement;
    const options = { url: 'ws://localhost/ws', enableMicMeter: value,
      ...(ownedAudio ? {} : { audioElement: audio }) } as unknown as StageClientOptions;
    assert.throws(() => new StageClient(options), TypeError);
    assert.equal(audio.autoplay, false);
    assert.deepEqual(h.audioEffects, { created: 0, appended: 0 });
  }
  h.noRoomGraph(); assert.equal(h.captureConstraints.length, 0); assert.equal(Socket.instances.length, 0);
});

for (const initial of [undefined, true, false]) it(`captures enableMicMeter=${String(initial)} before caller option mutation`, async t => {
  const h = setup(t, { clientOptions: initial === undefined ? {} : { enableMicMeter: initial } });
  h.clientOptions.enableMicMeter = initial === false;
  const { socket, peer } = await h.join(); await h.promote(socket, peer);
  assert.equal(Context.attempts, initial === false ? 0 : 1);
  h.clientOptions.enableMicMeter = 'invalid after construction' as unknown as boolean;
  await h.complete(h.client.setInputDevice('next-device'), 'replacement after option mutation');
  assert.equal(Context.attempts, initial === false ? 0 : 2);
  assert.equal(h.client.micLevel, initial === false ? 0 : 0.25);
  await h.client.disconnect();
  const next = await h.join(); await h.promote(next.socket, next.peer);
  assert.equal(Context.attempts, initial === false ? 0 : 3);
  assert.equal(h.sources[2]!.track.stops, 0); assert.equal(h.micReady(), 3);
});

it('publishes, replaces devices and rejoins with the room meter disabled and AudioContext absent', async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false } });
  Reflect.deleteProperty(globalThis, 'AudioContext');
  const { socket, peer } = await h.join(); await h.promote(socket, peer);
  h.noRoomGraph(); assert.equal(peer.transceiver.sender.track, h.sources[0]!.track);
  assert.match(peer.localDescription!.sdp!, /a=sendrecv/);
  const offers = peer.offers.length;
  await h.complete(h.client.setInputDevice('next-device'), 'meter-free replacement');
  assert.equal(peer.transceiver.sender.track, h.sources[1]!.track); assert.equal(h.sources[0]!.track.stops, 1);
  assert.equal(h.sources[1]!.track.stops, 0); assert.equal(h.client['inputDeviceId'], 'next-device');
  assert.deepEqual((h.captureConstraints[1]!.audio as MediaTrackConstraints).deviceId, { exact: 'next-device' });
  assert.equal(peer.offers.length, offers); h.noRoomGraph();
  await h.client.disconnect(); assert.equal(h.sources[1]!.track.stops, 1);
  const next = await h.join(); await h.promote(next.socket, next.peer);
  assert.equal(next.peer.transceiver.sender.track, h.sources[2]!.track); assert.equal(h.sources[2]!.track.stops, 0);
  assert.equal(h.micReady(), 3); assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []); h.noRoomGraph();
});

it('retries denied room capture without constructing a disabled meter or changing seat ownership', async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false }, holdCapture: true }), { socket, peer } = await h.join();
  Context.failAt = 'constructor';
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => h.captureRequests.length === 1, 'initial capture');
  h.captureRequests[0]!.reject(new DOMException('controlled permission denial', 'NotAllowedError'));
  await h.until(() => h.micErrors.length === 1, 'permission error');
  assert.equal(h.client['micFailed'], true); assert.equal(h.micReady(), 0); h.noRoomGraph();
  await h.complete(h.client.setInputDevice('recovered-device'), 'retry preference');
  assert.equal(h.client.retryMicrophone(), true); assert.equal(h.client.retryMicrophone(), false);
  await h.until(() => h.captureRequests.length === 2, 'explicit retry');
  const source = stream(); h.captureRequests[1]!.resolve(source.value);
  await h.until(() => peer.transceiver.sender.track === (source.track as unknown as MediaStreamTrack)
    && peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'retry publication');
  assert.equal(h.client.me!.participantId, 'guest'); assert.equal(h.client['micFailed'], false);
  assert.equal(Peer.instances.length, 1); assert.equal(Socket.instances.length, 1);
  assert.equal(h.client.retryMicrophone(), false); assert.equal(source.track.stops, 0);
  assert.deepEqual((h.captureConstraints[1]!.audio as MediaTrackConstraints).deviceId, { exact: 'recovered-device' });
  assert.equal(h.micReady(), 1); assert.equal(h.micErrors.length, 1); assert.deepEqual(h.errors, []); h.noRoomGraph();
  await h.client.disconnect(); assert.equal(source.track.stops, 1);
});

for (const action of ['mute', 'unmute', 'force-mute'] as const) it(`keeps disabled-meter pending replacement ownership through ${action}`, async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false } }), { socket, peer } = await h.join();
  const initiallyMuted = action === 'unmute'; await h.promote(socket, peer, initiallyMuted);
  const original = h.sources[0]!, gate = peer.holdNextReplacement(true), offers = peer.offers.length;
  const replacement = h.client.setInputDevice('candidate');
  await h.until(() => gate.entered, 'pending replacement');
  const candidate = h.sources[1]!;
  assert.equal(peer.transceiver.sender.track, candidate.track); assert.equal(original.track.stops, 0);
  if (action === 'force-mute') {
    const latest = state(true, true); latest.me.forceMuted = true;
    socket.deliver({ type: 'mic:muted', participantId: 'guest' }); socket.deliver({ type: 'room:state', ...latest });
  } else await h.complete(h.client[action](), action);
  assert.equal(original.track.enabled, initiallyMuted); assert.equal(candidate.track.enabled, initiallyMuted);
  assert.equal(original.track.stops, 0); assert.equal(candidate.track.stops, 0); h.noRoomGraph();
  gate.resolve(); await h.complete(replacement, 'replacement installation');
  assert.equal(original.track.stops, 1); assert.equal(candidate.track.stops, 0);
  assert.equal(candidate.track.enabled, initiallyMuted); assert.equal(peer.offers.length, offers);
  assert.equal(h.client['inputDeviceId'], 'candidate'); assert.equal(h.micReady(), 2); h.noRoomGraph();
  assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
});

it('retains disabled-meter capture after replaceTrack rejection and disposes only the candidate', async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false } }), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const gate = peer.holdNextReplacement(), reason = new Error('controlled sender failure');
  const rejected = assert.rejects(h.client.setInputDevice('failed-device'), error => error === reason);
  await h.until(() => gate.entered, 'replacement entry'); gate.reject(reason);
  await h.complete(rejected, 'replacement rejection');
  assert.equal(h.sources[0]!.track.stops, 0); assert.equal(h.sources[1]!.track.stops, 1);
  assert.equal(peer.transceiver.sender.track, h.sources[0]!.track); assert.equal(h.client['inputDeviceId'], '');
  assert.equal(h.micReady(), 1); h.noRoomGraph();
  await h.complete(h.client.setInputDevice('working-device'), 'recovered replacement');
  assert.equal(h.sources[0]!.track.stops, 1); assert.equal(peer.transceiver.sender.track, h.sources[2]!.track);
  assert.equal(h.micReady(), 2); assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []); h.noRoomGraph();
});

for (const terminal of ['stage:leave', 'kicked', 'room:closed', 'disconnect'] as const) {
  it(`stops disabled-meter installed and pending capture exactly once on ${terminal}`, async t => {
    const h = setup(t, { clientOptions: { enableMicMeter: false } }), { socket, peer } = await h.join();
    await h.promote(socket, peer);
    const gate = peer.holdNextReplacement(true), replacement = h.client.setInputDevice('retired-device');
    await h.until(() => gate.entered, 'pending replacement');
    const original = h.sources[0]!, candidate = h.sources[1]!;
    if (terminal === 'stage:leave') await h.complete(h.client.leaveStage(), 'stage exit');
    else if (terminal === 'disconnect') await h.client.disconnect();
    else socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'room' }
      : { type: 'room:closed', roomId: 'room', reason: 'shutdown' });
    assert.equal(original.track.stops, 1); assert.equal(candidate.track.stops, 1);
    assert.equal(original.track.enabled, false); assert.equal(candidate.track.enabled, false);
    assert.equal(h.client['mic'], null); assert.equal(h.micReady(), 1); h.noRoomGraph();
    gate.resolve(); await h.complete(replacement, 'retired replacement completion');
    if (terminal === 'stage:leave') {
      await h.until(() => peer.transceiver.direction === 'recvonly' && !h.client['negotiating'], 'receiving peer cleanup');
      assert.notEqual(peer.connectionState, 'closed'); assert.equal(peer.transceiver.sender.track, null);
    } else assert.equal(peer.connectionState, 'closed');
    assert.equal(original.track.stops, 1); assert.equal(candidate.track.stops, 1);
    assert.notEqual(h.client['inputDeviceId'], 'retired-device'); assert.deepEqual(h.errors, []); h.noRoomGraph();
  });
}

it('leaves independent preview eager and active when disabled-meter room capture leaves the stage', async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false } }), { socket, peer } = await h.join();
  await h.promote(socket, peer); h.noRoomGraph();
  const preview = await h.client.startMicTest(), previewSource = h.sources[1]!;
  assert.equal(Context.attempts, 1); assert.equal(h.sampleBuffers.length, 1);
  assert.equal(Context.instances[0]!.sources, 1); assert.equal(Context.instances[0]!.analysers, 1);
  assert.equal(Context.instances[0]!.reads.length, 0, 'preview graph is allocated before its first level read');
  assert.equal(preview.level(), 0.25); assert.equal(h.client.micLevel, 0); assert.equal(h.micReady(), 2);
  await h.complete(h.client.leaveStage(), 'room stage exit');
  assert.equal(h.sources[0]!.track.stops, 1); assert.equal(previewSource.track.stops, 0);
  assert.equal(preview.level(), 0.25); assert.equal(Context.instances[0]!.closes, 0);
  await h.promote(socket, peer);
  assert.equal(h.sources[2]!.track.stops, 0); assert.equal(Context.attempts, 1); assert.equal(h.sampleBuffers.length, 1);
  preview.stop(); preview.stop();
  assert.equal(previewSource.track.stops, 1); assert.equal(Context.instances[0]!.closes, 1); assert.equal(preview.level(), 0);
  assert.equal(h.sources[2]!.track.stops, 0); assert.equal(h.client.micLevel, 0);
  const nextPreview = await h.client.startMicTest(); assert.equal(Context.attempts, 2);
  await h.client.disconnect(); nextPreview.stop();
  assert.equal(h.sources[2]!.track.stops, 1); assert.equal(h.sources[3]!.track.stops, 1);
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1]); assert.equal(nextPreview.level(), 0);
});

it('still reports preview meter failure when room metering is disabled', async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false } }), { socket, peer } = await h.join();
  await h.promote(socket, peer); h.noRoomGraph(); Context.failAt = 'constructor';
  await assert.rejects(h.client.startMicTest(), error => error === Context.failure);
  assert.equal(Context.attempts, 1); assert.equal(h.sources[1]!.track.stops, 1);
  assert.equal(h.sources[0]!.track.stops, 0); assert.equal(peer.transceiver.sender.track, h.sources[0]!.track);
  assert.equal(h.micReady(), 1); assert.equal(h.client.micLevel, 0); assert.deepEqual(h.micErrors, []);
});

it('respects a disabled-meter micready callback disconnect before publishing its captured track', async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false } }), { socket, peer } = await h.join();
  h.client.on('micready', () => { void h.client.disconnect(); });
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => h.client.status === 'disconnected', 'ready callback disconnect');
  assert.equal(h.sources[0]!.track.stops, 1); assert.equal(h.sources[0]!.track.enabled, false);
  assert.equal(peer.transceiver.sender.track, null); assert.equal(h.client['mic'], null);
  assert.equal(h.micReady(), 1); assert.deepEqual(h.errors, []); h.noRoomGraph();
});

for (const hasOtherTrack of [false, true]) {
  it(`rejects disabled-meter initial capture with ${hasOtherTrack ? 'only a non-audio track' : 'no tracks'} and permits explicit retry`, async t => {
    const h = setup(t, { clientOptions: { enableMicMeter: false }, holdCapture: true }), { socket, peer } = await h.join();
    socket.deliver({ type: 'room:state', ...state(true) });
    await h.until(() => h.captureRequests.length === 1, 'initial capture');
    const other = { kind: 'video', stops: 0, stop() { this.stops++; } };
    const invalid = { getTracks: () => hasOtherTrack ? [other] : [], getAudioTracks: () => [] } as unknown as MediaStream;
    h.captureRequests[0]!.resolve(invalid);
    await h.until(() => h.micErrors.length === 1, 'no-audio capture failure');
    assert.equal(other.stops, hasOtherTrack ? 1 : 0);
    assert.equal(h.client['mic'], null); assert.equal(h.client['micFailed'], true); assert.equal(h.micReady(), 0);
    assert.equal(peer.transceiver.direction, 'recvonly'); assert.equal(peer.transceiver.sender.track, null); h.noRoomGraph();
    assert.deepEqual(h.micErrors, [{ name: 'StageError', message: '無法啟用麥克風，請確認 HTTPS、裝置及瀏覽器權限後重新上台。' }]);
    assert.equal(h.client.retryMicrophone(), true); assert.equal(h.client.retryMicrophone(), false);
    await h.until(() => h.captureRequests.length === 2, 'explicit retry');
    const recovered = stream(); h.captureRequests[1]!.resolve(recovered.value);
    await h.until(() => peer.transceiver.sender.track === (recovered.track as unknown as MediaStreamTrack)
      && peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'valid retry capture');
    assert.equal(h.client['micFailed'], false); assert.equal(h.micReady(), 1); assert.equal(recovered.track.stops, 0);
    assert.equal(other.stops, hasOtherTrack ? 1 : 0); assert.deepEqual(h.errors, []); h.noRoomGraph();
    await h.client.disconnect(); assert.equal(recovered.track.stops, 1); assert.equal(other.stops, hasOtherTrack ? 1 : 0);
  });

  it(`rejects disabled-meter device replacement with ${hasOtherTrack ? 'only a non-audio track' : 'no tracks'} without retiring installed capture`, async t => {
    const h = setup(t, { clientOptions: { enableMicMeter: false }, holdCapture: true }), { socket, peer } = await h.join();
    socket.deliver({ type: 'room:state', ...state(true) });
    await h.until(() => h.captureRequests.length === 1, 'initial capture');
    const original = stream(); h.captureRequests[0]!.resolve(original.value);
    await h.until(() => peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'initial capture installation');
    const replacements = peer.replacements.length;
    const rejected = assert.rejects(h.client.setInputDevice('invalid-device'), error => error instanceof StageError && error.code === 'media_error');
    await h.until(() => h.captureRequests.length === 2, 'invalid device capture');
    const other = { kind: 'video', enabled: true, stops: 0, stop() { this.stops++; } };
    const invalid = { getTracks: () => hasOtherTrack ? [other] : [], getAudioTracks: () => [] } as unknown as MediaStream;
    h.captureRequests[1]!.resolve(invalid); await h.complete(rejected, 'no-audio replacement rejection');
    assert.equal(other.stops, hasOtherTrack ? 1 : 0); if (hasOtherTrack) assert.equal(other.enabled, false);
    assert.equal(original.track.stops, 0); assert.equal(peer.transceiver.sender.track, original.track);
    assert.equal(h.client['mic'], original.value); assert.equal(h.client['inputDeviceId'], '');
    assert.equal(peer.replacements.length, replacements); assert.equal(h.micReady(), 1);
    assert.deepEqual(h.micErrors, []); assert.deepEqual(h.errors, []); h.noRoomGraph();
    await h.client.disconnect(); assert.equal(original.track.stops, 1); assert.equal(other.stops, hasOtherTrack ? 1 : 0);
  });
}

it('keeps a disabled-meter stale replacement continuation isolated from a new peer', async t => {
  const h = setup(t, { clientOptions: { enableMicMeter: false } }), old = await h.join();
  await h.promote(old.socket, old.peer);
  const gate = old.peer.holdNextReplacement(true), replacement = h.client.setInputDevice('retired-device');
  await h.until(() => gate.entered, 'old replacement');
  await h.client.disconnect();
  const next = await h.join(); await h.promote(next.socket, next.peer);
  const current = h.sources[2]!;
  gate.resolve(); await h.complete(replacement, 'old continuation');
  assert.equal(h.sources[0]!.track.stops, 1); assert.equal(h.sources[1]!.track.stops, 1);
  assert.equal(current.track.stops, 0); assert.equal(current.track.enabled, true);
  assert.equal(next.peer.transceiver.sender.track, current.track); assert.equal(h.client['mic'], current.value);
  assert.notEqual(h.client['inputDeviceId'], 'retired-device'); assert.equal(h.micReady(), 2); assert.deepEqual(h.errors, []); h.noRoomGraph();
});

const levelCases: { name: string; options: Partial<StageClientOptions>; metered: boolean }[] = [
  { name: 'default', options: {}, metered: true },
  { name: 'enabled', options: { enableMicMeter: true }, metered: true },
  { name: 'disabled', options: { enableMicMeter: false }, metered: false },
];

for (const { name, options, metered } of levelCases) {
  for (const forced of [false, true]) {
    it(`room micLevel is zero in ${name} initial ${forced ? 'forced' : 'self'}-muted micready`, async t => {
      const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
      const observed: { level: number; muted: boolean; forced: boolean; enabled: boolean; attached: boolean }[] = [];
      h.client.on('micready', () => observed.push({ level: h.client.micLevel,
        muted: h.client.me!.muted, forced: h.client.me!.forceMuted,
        enabled: h.sources[0]!.track.enabled, attached: peer.transceiver.sender.track !== null }));
      const snapshot = state(true, true); snapshot.me.forceMuted = forced;
      socket.deliver({ type: 'room:state', ...snapshot });
      await h.until(() => peer.transceiver.sender.track !== null && !h.client['negotiating'], 'muted capture installation');
      assert.deepEqual(observed, [{ level: 0, muted: true, forced, enabled: true, attached: false }],
        'the snapshot governs the getter before existing capture and sender synchronization');
      assert.equal(h.client.micLevel, 0); assert.equal(h.sources[0]!.track.enabled, false);
      assert.equal(Context.attempts, metered ? 1 : 0);
      assert.equal(Context.instances[0]?.reads.length ?? 0, 0, 'muted callback reads do not sample');
      assert.equal(h.sources[0]!.track.stops, 0); assert.equal(Context.instances[0]?.closes ?? 0, 0);
      socket.deliver({ type: 'room:state', ...state(true) });
      assert.equal(h.client.micLevel, metered ? 0.25 : 0); assert.equal(h.client.micLevel, metered ? 0.25 : 0);
      assert.deepEqual(Context.instances[0]?.reads ?? [], metered ? [h.sampleBuffers[0], h.sampleBuffers[0]] : []);
      assert.equal(h.micReady(), 1); assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
    });

    it(`room micLevel is zero in ${name} publishing ${forced ? 'forced' : 'self'}-mute state callback`, async t => {
      const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
      await h.promote(socket, peer);
      assert.equal(h.client.micLevel, metered ? 0.25 : 0);
      const observed: { level: number; muted: boolean; forced: boolean; enabled: boolean }[] = [];
      h.client.on('state', () => observed.push({ level: h.client.micLevel,
        muted: h.client.me!.muted, forced: h.client.me!.forceMuted, enabled: h.sources[0]!.track.enabled }));
      const snapshot = state(true, true); snapshot.me.forceMuted = forced;
      socket.deliver({ type: 'room:state', ...snapshot });
      assert.deepEqual(observed, [{ level: 0, muted: true, forced, enabled: true }],
        'state callbacks still precede track synchronization');
      assert.equal(h.client.micLevel, 0); assert.equal(h.sources[0]!.track.enabled, false);
      assert.equal(Context.instances[0]?.reads.length ?? 0, metered ? 1 : 0);
      assert.equal(peer.transceiver.sender.track, h.sources[0]!.track);
      assert.equal(h.sources[0]!.track.stops, 0); assert.equal(Context.instances[0]?.closes ?? 0, 0);
      assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
    });
  }

  for (const action of ['newer-mute', 'newer-unmute', 'disconnect'] as const) {
    it(`room micLevel follows ${name} micready callback ${action}`, async t => {
      const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
      const observed: { before: number; after: number; muted: boolean | null }[] = [];
      const nested: number[] = [];
      h.client.on('state', () => { if (h.micReady()) nested.push(h.client.micLevel); });
      h.client.on('micready', () => {
        const before = h.client.micLevel;
        if (action === 'disconnect') void h.client.disconnect();
        else socket.deliver({ type: 'room:state', ...state(true, action === 'newer-mute') });
        observed.push({ before, after: h.client.micLevel, muted: h.client.me?.muted ?? null });
      });
      socket.deliver({ type: 'room:state', ...state(true, action === 'newer-unmute') });
      await h.until(() => observed.length === 1, 'reentrant micready callback'); await h.tick(5);
      const expected = action === 'newer-unmute' && metered ? 0.25 : 0;
      assert.deepEqual(observed, [{ before: action === 'newer-unmute' || !metered ? 0 : 0.25,
        after: expected, muted: action === 'disconnect' ? null : action === 'newer-mute' }]);
      assert.deepEqual(nested, action === 'disconnect' ? [] : [action === 'newer-mute' || !metered ? 0 : 0.25]);
      assert.equal(h.client.micLevel, expected);
      assert.equal(h.sources[0]!.track.stops, action === 'disconnect' ? 1 : 0);
      assert.equal(Context.instances[0]?.closes ?? 0, action === 'disconnect' && metered ? 1 : 0);
      assert.equal(h.micReady(), 1); assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
      if (action === 'disconnect') {
        assert.equal(peer.connectionState, 'closed'); assert.equal(peer.transceiver.sender.track, null);
        assert.equal(h.client['mic'], null); assert.equal(h.client['micMeter'], null);
      } else {
        assert.equal(peer.transceiver.sender.track, h.sources[0]!.track);
        assert.equal(h.sources[0]!.track.enabled, action === 'newer-unmute');
      }
    });
  }

  for (const action of ['newer-unmute', 'disconnect'] as const) {
    it(`room micLevel follows ${name} muted state callback ${action}`, async t => {
      const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
      await h.promote(socket, peer);
      const observed: { before: number; after: number }[] = [];
      h.client.on('state', event => {
        if (!event.detail.me.muted) return;
        const before = h.client.micLevel;
        if (action === 'disconnect') void h.client.disconnect();
        else socket.deliver({ type: 'room:state', ...state(true) });
        observed.push({ before, after: h.client.micLevel });
      });
      socket.deliver({ type: 'room:state', ...state(true, true) });
      await h.tick(5);
      const expected = action === 'newer-unmute' && metered ? 0.25 : 0;
      assert.deepEqual(observed, [{ before: 0, after: expected }]); assert.equal(h.client.micLevel, expected);
      assert.equal(h.sources[0]!.track.stops, action === 'disconnect' ? 1 : 0);
      assert.equal(h.sources[0]!.track.enabled, action === 'newer-unmute');
      assert.equal(Context.instances[0]?.closes ?? 0, action === 'disconnect' && metered ? 1 : 0);
      assert.equal(Context.instances[0]?.reads.length ?? 0, action === 'newer-unmute' && metered ? 2 : 0);
      assert.equal(h.micReady(), 1); assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
    });
  }

  it(`room micLevel stays zero through ${name} offstage callback and muted reentry`, async t => {
    const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
    await h.promote(socket, peer);
    const original = h.sources[0]!, observed: { level: number; onStage: boolean; stops: number; closes: number }[] = [];
    const ready: number[] = [];
    h.client.on('micready', () => ready.push(h.client.micLevel));
    h.client.on('state', event => {
      if (event.detail.me.onStage) return;
      observed.push({ level: h.client.micLevel, onStage: h.client.me!.onStage,
        stops: original.track.stops, closes: Context.instances[0]?.closes ?? 0 });
      socket.deliver({ type: 'room:state', ...state(true, true) });
    });
    socket.deliver({ type: 'room:state', ...state(false) });
    await h.until(() => h.sources.length === 2 && peer.transceiver.sender.track === (h.sources[1]!.track as unknown as MediaStreamTrack)
      && !h.client['negotiating'], 'fresh muted reentry');
    assert.deepEqual(observed, [{ level: 0, onStage: false, stops: 1, closes: metered ? 1 : 0 }]);
    assert.deepEqual(ready, [0]); assert.equal(h.client.micLevel, 0);
    assert.equal(original.track.stops, 1); assert.equal(h.sources[1]!.track.stops, 0);
    assert.equal(h.sources[1]!.track.enabled, false); assert.equal(Peer.instances.length, 1);
    assert.deepEqual(Context.instances.map(context => context.closes), metered ? [1, 0] : []);
    assert.deepEqual(Context.instances.map(context => context.reads.length), metered ? [0, 0] : []);
    assert.deepEqual(peer.offers.filter(offer => !offer.onStage && offer.direction === 'sendrecv'), []);
    assert.equal(h.micReady(), 2); assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
  });

  it(`room micLevel respects ${name} disabled physical track with an unmuted snapshot`, async t => {
    const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
    await h.promote(socket, peer);
    const track = h.sources[0]!.track; track.enabled = false;
    assert.equal(h.client.me!.onStage, true); assert.equal(h.client.me!.muted, false);
    assert.equal(h.client.micLevel, 0); assert.equal(Context.instances[0]?.reads.length ?? 0, 0);
    track.enabled = true;
    assert.equal(h.client.micLevel, metered ? 0.25 : 0); assert.equal(Context.instances[0]?.reads.length ?? 0, metered ? 1 : 0);
    assert.equal(track.stops, 0); assert.equal(Context.instances[0]?.closes ?? 0, 0);
  });

  it(`room micLevel retains ${name} physical-track gate during an unmute state callback`, async t => {
    const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
    await h.promote(socket, peer, true);
    const observed: { level: number; muted: boolean; enabled: boolean }[] = [];
    h.client.on('state', () => observed.push({ level: h.client.micLevel,
      muted: h.client.me!.muted, enabled: h.sources[0]!.track.enabled }));
    socket.deliver({ type: 'room:state', ...state(true) });
    assert.deepEqual(observed, [{ level: 0, muted: false, enabled: false }]);
    assert.equal(Context.instances[0]?.reads.length ?? 0, 0);
    assert.equal(h.sources[0]!.track.enabled, true); assert.equal(h.client.micLevel, metered ? 0.25 : 0);
    assert.equal(Context.instances[0]?.reads.length ?? 0, metered ? 1 : 0);
    assert.equal(h.sources[0]!.track.stops, 0); assert.equal(Context.instances[0]?.closes ?? 0, 0);
  });

  it(`room micLevel retains ${name} same-seat capture during signaling reconnect`, async t => {
    const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
    await h.promote(socket, peer);
    const snapshot = h.client.state, source = h.sources[0]!;
    socket.close();
    assert.equal(h.client.status, 'reconnecting'); assert.equal(h.client.state, snapshot);
    assert.equal(h.client.me!.onStage, true); assert.equal(h.client.me!.muted, false);
    assert.equal(source.track.enabled, true); assert.equal(source.track.stops, 0);
    assert.equal(peer.transceiver.sender.track, source.track); assert.equal(peer.connectionState, 'connected');
    assert.equal(h.client.micLevel, metered ? 0.25 : 0);
    assert.equal(Context.instances[0]?.reads.length ?? 0, metered ? 1 : 0);
    assert.equal(Context.instances[0]?.closes ?? 0, 0); assert.equal(h.micReady(), 1);
    assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
  });

  it(`room micLevel leaves ${name} preview sampling independent of room mute and stage exit`, async t => {
    const h = setup(t, { clientOptions: options }), { socket, peer } = await h.join();
    await h.promote(socket, peer, true);
    const preview = await h.client.startMicTest(), source = h.sources[1]!;
    const previewContext = Context.instances[metered ? 1 : 0]!;
    assert.equal(Context.attempts, metered ? 2 : 1); assert.equal(preview.level(), 0.25);
    assert.equal(h.client.micLevel, 0); assert.equal(previewContext.reads.length, 1);
    if (metered) assert.equal(Context.instances[0]!.reads.length, 0);
    socket.deliver({ type: 'room:state', ...state(false) });
    assert.equal(h.client.me!.onStage, false); assert.equal(h.client.micLevel, 0);
    assert.equal(h.sources[0]!.track.stops, 1); assert.equal(source.track.stops, 0);
    assert.equal(preview.level(), 0.25); assert.equal(previewContext.reads.length, 2); assert.equal(previewContext.closes, 0);
    await h.client.disconnect(); preview.stop();
    assert.equal(source.track.stops, 1); assert.equal(previewContext.closes, 1); assert.equal(preview.level(), 0);
    assert.equal(h.client.micLevel, 0); assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
  });
}
