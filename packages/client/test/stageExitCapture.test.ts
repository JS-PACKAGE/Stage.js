import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { StageClient } from '../src/index.ts';
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
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', resumeToken: 'test-resume-token',
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
    queueMicrotask(() => this.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } }));
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
  closes = 0;
  constructor() { Context.instances.push(this); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
  async resume() {}
  async close() { this.closes++; }
}

/** Real SDK/public operations, fake socket and browser media; no native capture or network. */
function setup(t: TestContext, options: { holdCapture?: boolean } = {}) {
  Socket.instances = []; Peer.instances = []; Context.instances = [];
  const sources: ReturnType<typeof stream>[] = [];
  const captureRequests: ReturnType<typeof deferred<MediaStream>>[] = [];
  const captureConstraints: MediaStreamConstraints[] = [];
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'AudioContext', 'navigator']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: new EventTarget(), WebSocket: Socket,
    RTCPeerConnection: Peer, AudioContext: Context,
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
  const client = new StageClient({ url: 'ws://localhost/ws', audioElement: audio, requestTimeoutMs: 1000 });
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
  return { client, sources, captureRequests, captureConstraints, errors, micErrors, micReady: () => micReady, tick, until, complete, join, promote };
}

for (const muted of [false, true]) it(`stops installed and pending replacement capture immediately on stage exit (muted=${muted})`, async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer, muted);
  const original = h.sources[0]!;
  assert.equal(original.track.enabled, !muted);
  const gate = peer.holdNextReplacement();
  let changed = false;
  const change = h.client.setInputDevice('candidate').then(() => { changed = true; });
  void change.catch(() => {});
  await h.until(() => gate.entered, 'device replacement entered');
  const candidate = h.sources[1]!;
  assert.equal(candidate.track.enabled, !muted);
  await h.complete(h.client.leaveStage(), 'public leaveStage acknowledgement');
  assert.equal(h.client.me!.onStage, false);
  assert.equal(changed, false, 'the browser replacement itself is still pending');
  assert.equal(original.track.readyState, 'ended', 'installed capture must not wait for browser replacement');
  assert.equal(candidate.track.readyState, 'ended', 'pending candidate capture must stop on stage exit too');
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1]);
  assert.equal(Peer.instances.length, 1, 'stage exit retains the receiving peer');
  assert.notEqual(peer.connectionState, 'closed');
  gate.resolve(); await h.complete(change, 'retired device replacement');
  await h.until(() => peer.transceiver.direction === 'recvonly' && !h.client['negotiating'], 'receive-only cleanup');
  assert.equal(peer.transceiver.sender.track, null);
  assert.equal(h.micReady(), 1, 'the retired candidate is never installed');
  assert.equal(original.track.stops, 1); assert.equal(candidate.track.stops, 1);
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1], 'stale finally must not close either meter twice');
  assert.deepEqual(h.errors, []);
});

it('does not negotiate stale sendrecv when a promotion replacement settles after stage exit', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  const gate = peer.holdNextReplacement();
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => gate.entered, 'promotion replacement entered');
  await h.complete(h.client.leaveStage(), 'public leaveStage acknowledgement');
  gate.resolve();
  await h.until(() => peer.replacements.at(-1) === null && peer.transceiver.direction === 'recvonly', 'queued stage exit');
  await h.tick(5);
  assert.deepEqual(peer.offers.filter(offer => !offer.onStage && offer.direction === 'sendrecv'), [],
    'a stale replacement must not create an offstage publishing offer');
  assert.deepEqual(h.errors, [], 'the server must not need to reject a stale publishing offer');
  await h.until(() => peer.signalingState === 'stable' && !h.client['negotiating'], 'receive-only negotiation settles');
  assert.equal(h.sources[0]!.track.readyState, 'ended');
  assert.match(peer.localDescription!.sdp!, /a=recvonly/);
});

it('acquires fresh capture after stage exit and reentry while an older device replacement is held', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const original = h.sources[0]!, gate = peer.holdNextReplacement();
  const change = h.client.setInputDevice('retired-device'); void change.catch(() => {});
  await h.until(() => gate.entered, 'device replacement entered');
  const candidate = h.sources[1]!;
  await h.complete(h.client.leaveStage(), 'public leaveStage acknowledgement');
  socket.deliver({ type: 'room:state', ...state(true) }); await flush();
  assert.equal(h.sources.length, 2, 'same-peer replacement work remains serialized');
  gate.resolve(); await h.complete(change, 'retired replacement completion');
  await h.tick(5);
  assert.equal(h.sources.length, 3, 'reentry must acquire a fresh stream instead of reusing retired capture');
  const current = h.sources[2]!;
  await h.until(() => peer.transceiver.sender.track === (current.track as unknown as MediaStreamTrack)
    && !h.client['negotiating'], 'fresh capture installation');
  assert.equal(original.track.readyState, 'ended');
  assert.equal(candidate.track.readyState, 'ended');
  assert.equal(current.track.readyState, 'live');
  assert.equal(current.track.enabled, true);
  assert.equal(Peer.instances.length, 1);
  assert.equal(h.micReady(), 2);
  assert.notEqual(h.client['inputDeviceId'], 'retired-device');
  assert.deepEqual(h.errors, []);
});

it('preserves muted current replacement and keeps its installed source alive until success', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer, true);
  const original = h.sources[0]!, gate = peer.holdNextReplacement(), offers = peer.offers.length;
  const change = h.client.setInputDevice('current-device');
  await h.until(() => gate.entered, 'device replacement entered');
  const candidate = h.sources[1]!;
  assert.equal(original.track.readyState, 'live');
  assert.equal(candidate.track.readyState, 'live');
  assert.equal(original.track.enabled, false); assert.equal(candidate.track.enabled, false);
  gate.resolve(); await h.complete(change, 'current replacement completion');
  assert.equal(original.track.readyState, 'ended');
  assert.equal(candidate.track.readyState, 'live'); assert.equal(candidate.track.enabled, false);
  assert.equal(peer.transceiver.sender.track, candidate.track);
  assert.equal(h.client['inputDeviceId'], 'current-device');
  assert.equal(peer.offers.length, offers, 'ordinary device replacement does not renegotiate');
  assert.equal(h.micReady(), 2);
  assert.deepEqual(h.errors, []);
});

it('rejects a current device replacement failure and retains the installed source and preference', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const original = h.sources[0]!, gate = peer.holdNextReplacement(), offers = peer.offers.length;
  const error = new Error('controlled replacement failure');
  const change = h.client.setInputDevice('failed-device');
  const rejected = assert.rejects(change, reason => reason === error);
  await h.until(() => gate.entered, 'device replacement entered');
  const candidate = h.sources[1]!;
  gate.reject(error); await h.complete(rejected, 'current replacement rejection');
  assert.equal(original.track.readyState, 'live'); assert.equal(candidate.track.readyState, 'ended');
  assert.equal(peer.transceiver.sender.track, original.track);
  assert.notEqual(h.client['inputDeviceId'], 'failed-device');
  assert.equal(peer.offers.length, offers); assert.equal(h.micReady(), 1);
  assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
  await h.complete(h.client.setInputDevice('recovered-device'), 'replacement after ordinary failure');
  assert.equal(h.client['inputDeviceId'], 'recovered-device');
  assert.equal(h.sources[2]!.track.readyState, 'live');
  assert.equal(original.track.readyState, 'ended');
});

it('reports a current promotion replacement failure without misclassifying capture as denied', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  const gate = peer.holdNextReplacement();
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => gate.entered, 'promotion replacement entered');
  gate.reject(new Error('controlled current promotion failure'));
  await h.until(() => h.errors.length > 0, 'current replacement error');
  assert.deepEqual(h.errors, ['media_error']); assert.deepEqual(h.micErrors, []);
  assert.equal(h.sources[0]!.track.readyState, 'live');
  assert.equal(h.client.me!.onStage, true);
  await h.promote(socket, peer);
  assert.equal(h.sources.length, 1, 'a later current snapshot can retry installation of its owned stream');
  assert.equal(peer.transceiver.sender.track, h.sources[0]!.track);
});

it('keeps a new peer microphone isolated from a disconnected peer replacement continuation', async t => {
  const h = setup(t), old = await h.join();
  await h.promote(old.socket, old.peer);
  const original = h.sources[0]!, gate = old.peer.holdNextReplacement();
  const change = h.client.setInputDevice('retired-device'); void change.catch(() => {});
  await h.until(() => gate.entered, 'old replacement entered');
  const candidate = h.sources[1]!;
  await h.client.disconnect();
  assert.equal(original.track.readyState, 'ended');
  assert.equal(candidate.track.readyState, 'ended', 'disconnect immediately retires in-flight candidate capture');
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1]);
  const currentPeer = await h.join(); await h.promote(currentPeer.socket, currentPeer.peer);
  const current = h.sources[2]!;
  assert.equal(current.track.readyState, 'live');
  assert.equal(old.peer.connectionState, 'closed');
  gate.resolve(); await h.complete(change, 'disconnected replacement completion');
  assert.equal(candidate.track.readyState, 'ended');
  assert.equal(current.track.readyState, 'live');
  assert.equal(currentPeer.peer.transceiver.sender.track, current.track);
  assert.notEqual(h.client['inputDeviceId'], 'retired-device');
  assert.equal(original.track.stops, 1); assert.equal(candidate.track.stops, 1); assert.equal(current.track.stops, 0);
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1, 0]);
  assert.deepEqual(h.errors, []);
});

for (const callback of ['state', 'status'] as const) it(`retires installed and candidate capture before the offstage ${callback} callback`, async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const original = h.sources[0]!, gate = peer.holdNextReplacement();
  const change = h.client.setInputDevice('retired-device'); void change.catch(() => {});
  await h.until(() => gate.entered, 'device replacement entered');
  const candidate = h.sources[1]!;
  const seen: { installed: string; candidate: string }[] = [];
  const observe = () => { seen.push({ installed: original.track.readyState, candidate: candidate.track.readyState }); };
  h.client.on('state', event => { if (callback === 'state' && !event.detail.me.onStage) observe(); });
  h.client.on('status', event => { if (callback === 'status' && event.detail === 'waiting') observe(); });
  socket.deliver({ type: 'room:state', ...state(false), status: 'waiting' });
  assert.deepEqual(seen, [{ installed: 'ended', candidate: 'ended' }], 'application callbacks must observe already-retired capture');
  gate.resolve(); await h.complete(change, 'retired replacement completion');
  await h.until(() => peer.transceiver.direction === 'recvonly' && !h.client['negotiating'], 'receive-only cleanup');
  assert.equal(peer.transceiver.sender.track, null);
  assert.deepEqual(h.errors, []);
});

it('transfers device replacement ownership before a micready callback disconnects and rejoins', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  let disconnecting: Promise<void> | undefined, rejoining: Promise<void> | undefined;
  const off = h.client.on('micready', () => {
    off(); disconnecting = h.client.disconnect(); rejoining = h.client.join({ roomId: 'room', name: 'Guest' });
    void rejoining.catch(() => {});
  });
  await h.complete(h.client.setInputDevice('selected-device'), 'replacement with micready disconnect');
  assert.ok(disconnecting); await disconnecting;
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[0]!.track.stops, 1);
  assert.equal(h.sources[1]!.track.stops, 1, 'callback teardown owns the installed replacement exactly once');
  assert.equal(peer.connectionState, 'closed');
  assert.ok(rejoining); await h.complete(rejoining, 'micready callback rejoin');
  const nextSocket = Socket.instances.at(-1)!, nextPeer = Peer.instances.at(-1)!;
  await h.until(() => nextPeer.remoteDescription !== null && !h.client['negotiating'], 'rejoined audience negotiation');
  await h.promote(nextSocket, nextPeer);
  assert.equal(h.sources[2]!.track.stops, 0);
  assert.equal(nextPeer.transceiver.sender.track, h.sources[2]!.track);
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1, 0]);
  assert.deepEqual(h.errors, []);
});

for (const callback of ['state', 'status'] as const) it(`starts fresh capture after an offstage ${callback} callback immediately reenters during permission wait`, async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => h.captureRequests.length === 1, 'first permission request');
  let reentered = false;
  const reenter = () => {
    if (reentered) return;
    reentered = true;
    socket.deliver({ type: 'room:state', ...state(true) });
  };
  h.client.on('state', event => { if (callback === 'state' && !event.detail.me.onStage) reenter(); });
  h.client.on('status', event => { if (callback === 'status' && event.detail === 'waiting') reenter(); });
  socket.deliver({ type: 'room:state', ...state(false), status: 'waiting' });
  assert.equal(reentered, true);
  assert.equal(h.client.me!.onStage, true);
  await h.until(() => h.captureRequests.length === 2, 'fresh permission request before retired permission settles');
  const retired = stream(); h.captureRequests[0]!.resolve(retired.value); await flush();
  assert.equal(retired.track.stops, 1, 'the late old grant is disposed rather than installed');
  assert.equal(h.micReady(), 0);
  const current = stream(); h.captureRequests[1]!.resolve(current.value);
  await h.until(() => peer.transceiver.sender.track === (current.track as unknown as MediaStreamTrack)
    && peer.signalingState === 'stable' && !h.client['negotiating'], 'fresh capture installation');
  assert.equal(current.track.readyState, 'live');
  assert.equal(Peer.instances.length, 1);
  assert.equal(h.micReady(), 1);
  assert.deepEqual(h.micErrors, []); assert.deepEqual(h.errors, []);
});

for (const terminal of ['kicked', 'room:closed'] as const) it(`immediately retires installed and pending replacement capture on ${terminal}`, async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const original = h.sources[0]!, gate = peer.holdNextReplacement();
  const change = h.client.setInputDevice('retired-device'); void change.catch(() => {});
  await h.until(() => gate.entered, 'device replacement entered');
  const candidate = h.sources[1]!;
  socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'room' }
    : { type: 'room:closed', roomId: 'room', reason: 'shutdown' });
  assert.equal(h.client.state, null);
  assert.equal(original.track.readyState, 'ended'); assert.equal(candidate.track.readyState, 'ended');
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1]);
  assert.equal(peer.connectionState, 'closed');
  gate.resolve(); await h.complete(change, 'terminal replacement continuation');
  assert.equal(original.track.stops, 1); assert.equal(candidate.track.stops, 1);
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1]);
  assert.equal(h.micReady(), 1); assert.deepEqual(h.errors, []);
});

it('uses the latest mute snapshot when a still-current replacement completes', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const original = h.sources[0]!, gate = peer.holdNextReplacement();
  const change = h.client.setInputDevice('current-device');
  await h.until(() => gate.entered, 'device replacement entered');
  const candidate = h.sources[1]!;
  assert.equal(candidate.track.enabled, true);
  socket.deliver({ type: 'room:state', ...state(true, true) });
  assert.equal(original.track.enabled, false);
  gate.resolve(); await h.complete(change, 'current replacement completion');
  await h.until(() => !h.client['negotiating'] && peer.signalingState === 'stable', 'latest snapshot synchronization');
  assert.equal(candidate.track.enabled, false); assert.equal(candidate.track.readyState, 'live');
  assert.equal(original.track.stops, 1); assert.equal(candidate.track.stops, 0);
  assert.equal(peer.transceiver.sender.track, candidate.track);
  assert.equal(h.client['inputDeviceId'], 'current-device');
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 0]);
  assert.deepEqual(h.errors, []);
});

for (const attachBeforeSettle of [false, true]) for (const action of ['mute', 'unmute', 'force-mute'] as const) {
  it(`synchronizes pending candidate on ${action} (attached=${attachBeforeSettle})`, async t => {
    const h = setup(t), { socket, peer } = await h.join();
    const initiallyMuted = action === 'unmute';
    await h.promote(socket, peer, initiallyMuted);
    const original = h.sources[0]!, gate = peer.holdNextReplacement(attachBeforeSettle), offers = peer.offers.length;
    let settled = false;
    const change = h.client.setInputDevice('candidate').finally(() => { settled = true; });
    await h.until(() => gate.entered, 'candidate replacement entered');
    const candidate = h.sources[1]!;
    const observed: boolean[][] = [];
    const off = h.client.on('state', () => { observed.push([original.track.enabled, candidate.track.enabled]); });
    if (action === 'force-mute') {
      const latest = state(true, true); latest.me.forceMuted = true;
      socket.deliver({ type: 'mic:muted', participantId: 'guest' });
      socket.deliver({ type: 'room:state', ...latest });
    } else {
      await h.complete(h.client[action](), `public ${action} acknowledgement`);
      assert.equal(socket.sent.at(-1)!.type, `mic:${action}`);
    }
    off();
    assert.deepEqual(observed, [[!initiallyMuted, !initiallyMuted]], 'track policy retains its existing post-state-callback ordering');
    assert.equal(settled, false, 'mute control must not wait for replaceTrack');
    assert.equal(h.client.me!.muted, !initiallyMuted);
    assert.equal(h.client.me!.forceMuted, action === 'force-mute');
    assert.equal(original.track.enabled, initiallyMuted);
    assert.equal(candidate.track.enabled, initiallyMuted, 'owned candidate follows the accepted snapshot before replacement settles');
    assert.equal(peer.transceiver.sender.track === (candidate.track as unknown as MediaStreamTrack), attachBeforeSettle);
    assert.equal(original.track.readyState, 'live'); assert.equal(candidate.track.readyState, 'live');
    assert.deepEqual(Context.instances.map(context => context.closes), [0, 0], 'mute does not dispose room capture or meters');
    gate.resolve(); await h.complete(change, 'candidate installation');
    assert.equal(candidate.track.enabled, initiallyMuted); assert.equal(candidate.track.stops, 0);
    assert.equal(original.track.stops, 1); assert.equal(peer.transceiver.sender.track, candidate.track);
    assert.equal(peer.offers.length, offers, 'device/mute synchronization does not renegotiate');
    assert.deepEqual(h.errors, []);
  });
}

it('applies latest mute to each device replacement only when its queued capture starts', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const firstGate = peer.holdNextReplacement(), secondGate = peer.holdNextReplacement(true);
  const first = h.client.setInputDevice('first');
  await h.until(() => firstGate.entered, 'first replacement entered');
  const firstCandidate = h.sources[1]!;
  const second = h.client.setInputDevice('second');
  await h.complete(h.client.mute(), 'mute while second device is queued');
  assert.equal(h.sources.length, 2, 'a queued device call does not own a captured stream yet');
  assert.equal(secondGate.entered, false); assert.equal(firstCandidate.track.enabled, false);
  firstGate.resolve(); await h.complete(first, 'first installation');
  await h.until(() => secondGate.entered, 'second replacement entered');
  const secondCandidate = h.sources[2]!;
  assert.equal(secondCandidate.track.enabled, false, 'new capture starts with the latest accepted mute');
  await h.complete(h.client.unmute(), 'unmute during second replacement');
  assert.equal(firstCandidate.track.enabled, true); assert.equal(secondCandidate.track.enabled, true);
  assert.equal(secondCandidate.track.readyState, 'live'); assert.equal(h.sources[0]!.track.stops, 1);
  secondGate.resolve(); await h.complete(second, 'second installation');
  assert.equal(firstCandidate.track.stops, 1); assert.equal(secondCandidate.track.stops, 0);
  assert.equal(peer.transceiver.sender.track, secondCandidate.track);
  assert.equal(h.client['inputDeviceId'], 'second'); assert.deepEqual(h.errors, []);
});

for (const terminal of ['stage:leave', 'kicked', 'room:closed'] as const) {
  it(`does not re-enable disposed muted candidates after ${terminal} and reentry`, async t => {
    const h = setup(t), { socket, peer } = await h.join();
    await h.promote(socket, peer);
    const original = h.sources[0]!, gate = peer.holdNextReplacement(true);
    const change = h.client.setInputDevice('retired');
    await h.until(() => gate.entered, 'candidate replacement entered');
    const candidate = h.sources[1]!;
    await h.complete(h.client.mute(), 'mute before retirement');
    assert.equal(candidate.track.enabled, false);
    let next = { socket, peer };
    if (terminal === 'stage:leave') {
      const off = h.client.on('state', event => {
        if (event.detail.me.onStage) return;
        off();
        assert.equal(original.track.readyState, 'ended'); assert.equal(candidate.track.readyState, 'ended');
        assert.equal(original.track.enabled, false); assert.equal(candidate.track.enabled, false);
        // A synchronous injected newer snapshot stresses callback ownership, not native socket scheduling.
        socket.deliver({ type: 'room:state', ...state(true) });
      });
      await h.complete(h.client.leaveStage(), 'leave acknowledgement with callback reentry');
    } else {
      socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'room' } : { type: 'room:closed', roomId: 'room' });
      assert.equal(h.client.state, null);
      next = await h.join(); await h.promote(next.socket, next.peer);
    }
    assert.equal(original.track.enabled, false); assert.equal(candidate.track.enabled, false);
    assert.equal(original.track.stops, 1); assert.equal(candidate.track.stops, 1);
    gate.resolve(); await h.complete(change, 'retired replacement settlement');
    await h.until(() => h.sources.length === 3 && next.peer.transceiver.sender.track === (h.sources[2]!.track as unknown as MediaStreamTrack)
      && !h.client['negotiating'], 'fresh microphone after reentry');
    assert.equal(candidate.track.enabled, false, 'later unmuted snapshots cannot revive a disposed candidate');
    assert.equal(candidate.track.stops, 1); assert.equal(h.sources[2]!.track.enabled, true);
    assert.equal(h.sources[2]!.track.stops, 0); assert.notEqual(h.client['inputDeviceId'], 'retired');
    assert.deepEqual(h.errors, []);
  });
}

it('keeps microphone preview independent of pending replacement mute and stage exit', async t => {
  const h = setup(t), { socket, peer } = await h.join();
  await h.promote(socket, peer);
  const preview = await h.client.startMicTest(), previewSource = h.sources[1]!;
  const gate = peer.holdNextReplacement(true), change = h.client.setInputDevice('candidate');
  await h.until(() => gate.entered, 'candidate replacement entered');
  const candidate = h.sources[2]!;
  for (const muted of [true, false, true]) {
    await h.complete(muted ? h.client.mute() : h.client.unmute(), 'room microphone mute change');
    assert.equal(candidate.track.enabled, !muted);
    assert.equal(previewSource.track.enabled, true); assert.equal(previewSource.track.readyState, 'live');
    assert.equal(Context.instances[1]!.closes, 0);
  }
  await h.complete(h.client.leaveStage(), 'leave with preview running');
  assert.equal(candidate.track.readyState, 'ended'); assert.equal(candidate.track.enabled, false);
  assert.equal(previewSource.track.readyState, 'live'); assert.equal(previewSource.track.enabled, true);
  gate.resolve(); await h.complete(change, 'retired candidate settlement');
  preview.stop(); assert.equal(previewSource.track.stops, 1);
  assert.deepEqual(Context.instances.map(context => context.closes), [1, 1, 1]);
  assert.deepEqual(h.errors, []);
});

for (const callback of ['state', 'status'] as const) for (const action of ['newer-mute', 'disconnect-rejoin'] as const) {
  it(`keeps pending mute ownership after ${callback} callback ${action}`, async t => {
    const h = setup(t), { socket, peer } = await h.join();
    await h.promote(socket, peer);
    const original = h.sources[0]!, gate = peer.holdNextReplacement(true);
    const change = h.client.setInputDevice('candidate');
    await h.until(() => gate.entered, 'candidate replacement entered');
    const candidate = h.sources[1]!;
    let handled = false, joining: Promise<void> | undefined;
    const seen: boolean[][] = [];
    const reenter = () => {
      if (handled) return;
      handled = true; seen.push([original.track.enabled, candidate.track.enabled]);
      if (action === 'newer-mute') {
        const latest = state(true, true); latest.me.forceMuted = true;
        // Nested delivery is a controlled reentrancy stressor; real WebSocket messages run in separate tasks.
        socket.deliver({ type: 'room:state', ...latest });
      } else {
        void h.client.disconnect();
        joining = h.client.join({ roomId: 'room', name: 'Guest' }); void joining.catch(() => {});
      }
    };
    const offState = h.client.on('state', event => { if (callback === 'state' && event.detail.status === 'waiting') reenter(); });
    const offStatus = h.client.on('status', event => { if (callback === 'status' && event.detail === 'waiting') reenter(); });
    socket.deliver({ type: 'room:state', ...state(true, action === 'disconnect-rejoin'), status: 'waiting' });
    offState(); offStatus();
    assert.deepEqual(seen, [[true, true]], 'callbacks keep the existing track-update ordering');
    assert.equal(candidate.track.enabled, false); assert.equal(original.track.enabled, false);
    if (action === 'newer-mute') {
      assert.equal(h.client.me!.forceMuted, true); assert.equal(candidate.track.readyState, 'live');
      gate.resolve(); await h.complete(change, 'current candidate settlement');
      assert.equal(candidate.track.enabled, false); assert.equal(candidate.track.stops, 0);
    } else {
      assert.equal(candidate.track.stops, 1); assert.equal(original.track.stops, 1);
      assert.ok(joining); await h.complete(joining, 'callback rejoin');
      const nextSocket = Socket.instances.at(-1)!, nextPeer = Peer.instances.at(-1)!;
      await h.until(() => nextPeer.remoteDescription !== null && !h.client['negotiating'], 'rejoined audience');
      await h.promote(nextSocket, nextPeer);
      gate.resolve(); await h.complete(change, 'retired candidate settlement');
      assert.equal(candidate.track.enabled, false); assert.equal(candidate.track.stops, 1);
      assert.equal(h.sources[2]!.track.enabled, true); assert.equal(h.sources[2]!.track.stops, 0);
      assert.equal(nextPeer.transceiver.sender.track, h.sources[2]!.track);
    }
    assert.deepEqual(h.errors, []);
  });
}

async function failInitialMicrophone(h: ReturnType<typeof setup>, socket: Socket, name = 'NotAllowedError') {
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => h.captureRequests.length === 1, 'initial capture request');
  h.captureRequests[0]!.reject(new DOMException('controlled capture failure', name));
  await h.until(() => h.micErrors.length === 1, 'initial capture failure');
  assert.equal(h.client['micFailed'], true);
  assert.equal(h.client['mic'], null);
}

for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
  it(`manual microphone retry recovers ${name} on the same seat and peer using the selected device`, async t => {
    const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
    await failInitialMicrophone(h, socket, name);
    await h.complete(h.client.setInputDevice('working-device'), 'device preference after failed capture');
    assert.equal(h.captureRequests.length, 1, 'saving a choice does not implicitly retry');
    await h.complete(h.client.mute(), 'mute after failed capture');
    await h.complete(h.client.unmute(), 'unmute after failed capture');
    socket.deliver({ type: 'room:state', ...state(true) }); await h.tick();
    assert.equal(h.captureRequests.length, 1, 'snapshots and mute controls do not retry a latched failure');
    const controls = socket.sent.filter(message => !message.type.startsWith('rtc:')).length;
    const admission = h.client.retryMicrophone();
    assert.equal(admission, true, 'the immediate boolean acknowledges admission, not recovery');
    assert.equal(h.client.retryMicrophone(), false, 'synchronous duplicate calls are not admitted');
    assert.equal(h.captureRequests.length, 1, 'capture is queued rather than completed at admission');
    assert.equal(h.client['mic'], null);
    await h.until(() => h.captureRequests.length === 2, 'manual capture');
    assert.equal(h.client.retryMicrophone(), false, 'an admitted permission wait cannot be retried');
    assert.deepEqual((h.captureConstraints[1]!.audio as MediaTrackConstraints).deviceId, { exact: 'working-device' });
    const recovered = stream(); h.captureRequests[1]!.resolve(recovered.value);
    await h.until(() => peer.transceiver.sender.track === (recovered.track as unknown as MediaStreamTrack)
      && peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'manual capture installation');
    assert.equal(h.client.me!.participantId, 'guest'); assert.equal(h.client.me!.onStage, true);
    assert.equal(Peer.instances.length, 1); assert.equal(Socket.instances.length, 1);
    assert.equal(socket.sent.filter(message => !message.type.startsWith('rtc:')).length, controls);
    assert.equal(h.client.retryMicrophone(), false, 'a healthy capture is not restarted');
    assert.equal(recovered.track.enabled, true); assert.equal(recovered.track.stops, 0);
    assert.equal(h.micReady(), 1); assert.equal(h.micErrors.length, 1); assert.deepEqual(h.errors, []);
  });
}

it('manual microphone retry requires another explicit admission after each new capture failure', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  await failInitialMicrophone(h, socket);
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.equal(h.client.retryMicrophone(), true);
    await h.until(() => h.captureRequests.length === attempt + 1, 'next explicit capture');
    h.captureRequests[attempt]!.reject(new DOMException('still unavailable', 'NotFoundError'));
    await h.until(() => h.micErrors.length === attempt + 1, 'repeated failure notification');
    socket.deliver({ type: 'room:state', ...state(true) }); await h.tick(100);
    assert.equal(h.captureRequests.length, attempt + 1, 'a failed admitted attempt does not loop');
    assert.equal(h.client['micFailed'], true); assert.equal(peer.transceiver.sender.track, null);
  }
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.captureRequests.length === 4, 'final explicit capture');
  const source = stream(); h.captureRequests[3]!.resolve(source.value);
  await h.until(() => peer.transceiver.sender.track === (source.track as unknown as MediaStreamTrack), 'final recovery');
  assert.equal(h.client['micFailed'], false); assert.equal(h.micReady(), 1);
  assert.deepEqual(h.errors, []);
});

it('manual microphone retry rejects disconnected, audience and pending initial capture admission', async t => {
  const h = setup(t, { holdCapture: true });
  assert.equal(h.client.retryMicrophone(), false);
  const { socket, peer } = await h.join();
  assert.equal(h.client.retryMicrophone(), false);
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => h.captureRequests.length === 1, 'pending initial permission');
  assert.equal(h.client.retryMicrophone(), false); await h.tick();
  assert.equal(h.captureRequests.length, 1);
  const source = stream(); h.captureRequests[0]!.resolve(source.value);
  await h.until(() => peer.transceiver.sender.track === (source.track as unknown as MediaStreamTrack), 'initial installation');
  assert.equal(h.client.retryMicrophone(), false);
  await h.client.disconnect(); assert.equal(h.client.retryMicrophone(), false);
  assert.equal(source.track.stops, 1);
});

it('manual microphone retry rejects waiting and reconnecting status without consuming failed-capture eligibility', async t => {
  const h = setup(t, { holdCapture: true }), { socket } = await h.join();
  await failInitialMicrophone(h, socket);
  socket.deliver({ type: 'status', state: 'waiting' });
  assert.equal(h.client.retryMicrophone(), false); assert.equal(h.client['micFailed'], true);
  socket.deliver({ type: 'status', state: 'live' });
  socket.close();
  assert.equal(h.client.status, 'reconnecting'); assert.equal(h.client.me!.onStage, true);
  assert.equal(h.client.retryMicrophone(), false); assert.equal(h.client['micFailed'], true);
  await h.tick(); assert.equal(h.captureRequests.length, 1);
});

it('manual microphone retry defensively rejects non-open signaling and missing or closed peer resources', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  await failInitialMicrophone(h, socket);
  await h.until(() => !h.client['negotiating'], 'failed capture receive-only synchronization');
  // These controlled resource gaps check admission guards, not native WebSocket/browser timing.
  socket.readyState = 0; assert.equal(h.client.retryMicrophone(), false); socket.readyState = Socket.OPEN;
  const pc = h.client['pc']; h.client['pc'] = null;
  assert.equal(h.client.retryMicrophone(), false); h.client['pc'] = pc;
  const transceiver = h.client['transceiver']; h.client['transceiver'] = null;
  assert.equal(h.client.retryMicrophone(), false); h.client['transceiver'] = transceiver;
  peer.connectionState = 'closed'; assert.equal(h.client.retryMicrophone(), false); peer.connectionState = 'connected';
  assert.equal(h.client['micFailed'], true); assert.equal(h.captureRequests.length, 1);
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.captureRequests.length === 2, 'eligible retry after restored resources');
});

for (const mute of ['self', 'forced'] as const) {
  it(`manual microphone retry preserves latest ${mute} mute through capture and held sender installation`, async t => {
    const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
    await failInitialMicrophone(h, socket);
    await h.until(() => !h.client['negotiating'], 'failed receive-only synchronization');
    assert.equal(h.client.retryMicrophone(), true);
    await h.until(() => h.captureRequests.length === 2, 'retry permission wait');
    if (mute === 'self') await h.complete(h.client.mute(), 'self mute while waiting');
    else {
      const latest = state(true, true); latest.me.forceMuted = true;
      socket.deliver({ type: 'room:state', ...latest });
    }
    const gate = peer.holdNextReplacement(true), source = stream();
    h.captureRequests[1]!.resolve(source.value);
    await h.until(() => gate.entered, 'retry sender installation entered');
    assert.equal(source.track.enabled, false); assert.equal(h.client.me!.muted, true);
    assert.equal(h.client.me!.forceMuted, mute === 'forced');
    assert.equal(h.client.retryMicrophone(), false); assert.equal(h.micReady(), 1);
    if (mute === 'self') await h.complete(h.client.unmute(), 'self unmute while installation held');
    else socket.deliver({ type: 'room:state', ...state(true) });
    assert.equal(source.track.enabled, true, 'accepted mute policy changes apply before replaceTrack settles');
    const latest = state(true, true); latest.me.forceMuted = true;
    socket.deliver({ type: 'room:state', ...latest }); assert.equal(source.track.enabled, false);
    gate.resolve();
    await h.until(() => peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'muted retry synchronized');
    assert.equal(source.track.enabled, false); assert.equal(source.track.stops, 0);
    assert.equal(h.client.me!.forceMuted, true); assert.equal(h.client.me!.onStage, true);
    assert.deepEqual(h.errors, []);
  });
}

it('manual microphone retry queued behind replaceTrack is superseded by same-peer stage exit and reentry', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  const gate = peer.holdNextReplacement();
  await failInitialMicrophone(h, socket);
  await h.until(() => gate.entered, 'failed capture null-track installation held');
  assert.equal(h.client.retryMicrophone(), true);
  await h.complete(h.client.leaveStage(), 'leave before queued retry runs');
  socket.deliver({ type: 'room:state', ...state(true, true) });
  assert.equal(h.captureRequests.length, 1, 'same-peer work still waits for the browser replacement');
  gate.resolve();
  await h.until(() => h.captureRequests.length === 2, 'fresh reentry capture');
  const source = stream(); h.captureRequests[1]!.resolve(source.value);
  await h.until(() => peer.transceiver.sender.track === (source.track as unknown as MediaStreamTrack)
    && peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'current muted reentry installed');
  assert.equal(h.captureRequests.length, 2, 'superseded retry did not create an extra capture');
  assert.equal(Peer.instances.length, 1); assert.equal(source.track.enabled, false);
  assert.equal(h.micReady(), 1); assert.equal(h.micErrors.length, 1); assert.deepEqual(h.errors, []);
});

it('manual microphone retry uses a queued device choice when an ordinary snapshot supersedes its queued synchronization', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  const gate = peer.holdNextReplacement();
  await failInitialMicrophone(h, socket);
  await h.until(() => gate.entered, 'receive-only replacement held');
  const selected = h.client.setInputDevice('queued-device');
  assert.equal(h.client.retryMicrophone(), true);
  socket.deliver({ type: 'room:state', ...state(true, true) });
  assert.equal(h.client.retryMicrophone(), false); assert.equal(h.captureRequests.length, 1);
  gate.resolve(); await h.complete(selected, 'queued choice applied');
  await h.until(() => h.captureRequests.length === 2, 'latest snapshot performs admitted capture');
  assert.deepEqual((h.captureConstraints[1]!.audio as MediaTrackConstraints).deviceId, { exact: 'queued-device' });
  const source = stream(); h.captureRequests[1]!.resolve(source.value);
  await h.until(() => peer.transceiver.sender.track === (source.track as unknown as MediaStreamTrack)
    && peer.transceiver.direction === 'sendrecv' && !h.client['negotiating'], 'latest snapshot synchronized');
  assert.equal(h.captureRequests.length, 2, 'superseded synchronization does not acquire twice');
  assert.equal(source.track.enabled, false); assert.equal(h.micReady(), 1);
  assert.equal(h.client['inputDeviceId'], 'queued-device'); assert.deepEqual(h.errors, []);
});

it('manual microphone retry already admitted survives a signaling-only loss while new admissions are rejected', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  await failInitialMicrophone(h, socket);
  await h.complete(h.client.mute(), 'mute before admission');
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.captureRequests.length === 2, 'admitted permission wait');
  socket.close();
  assert.equal(h.client.status, 'reconnecting'); assert.equal(h.client.retryMicrophone(), false);
  const source = stream(); h.captureRequests[1]!.resolve(source.value);
  await h.until(() => peer.transceiver.sender.track === (source.track as unknown as MediaStreamTrack)
    && !h.client['negotiating'], 'surviving peer installs its admitted capture');
  assert.equal(Peer.instances.length, 1); assert.equal(source.track.stops, 0);
  assert.equal(source.track.enabled, false); assert.equal(h.client.me!.muted, true);
  assert.equal(h.micReady(), 1); assert.equal(h.micErrors.length, 1);
  assert.deepEqual(h.errors, ['disconnected'], 'sending negotiation without signaling retains its existing error event');
  await h.client.disconnect(); assert.equal(source.track.stops, 1);
  assert.equal(h.client['mic'], null); assert.equal(h.client.retryMicrophone(), false);
});

for (const transition of ['stage-exit', 'disconnect', 'kicked', 'room:closed'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`manual microphone retry disposes late ${outcome} after ${transition} without touching reentry`, async t => {
      const h = setup(t, { holdCapture: true }); let { socket, peer } = await h.join();
      await failInitialMicrophone(h, socket);
      assert.equal(h.client.retryMicrophone(), true);
      await h.until(() => h.captureRequests.length === 2, 'retired retry pending');
      if (transition === 'stage-exit') await h.complete(h.client.leaveStage(), 'leave during manual permission wait');
      else {
        if (transition === 'disconnect') await h.client.disconnect();
        else {
          socket.deliver(transition === 'kicked' ? { type: 'kicked', roomId: 'room' } : { type: 'room:closed', roomId: 'room' });
          await h.until(() => h.client.status === 'disconnected', 'terminal cleanup');
        }
        ({ socket, peer } = await h.join());
      }
      assert.equal(h.client.retryMicrophone(), false);
      socket.deliver({ type: 'room:state', ...state(true) });
      await h.until(() => h.captureRequests.length === 3, 'new capture does not wait for retired permission');
      const current = stream(); h.captureRequests[2]!.resolve(current.value);
      await h.until(() => peer.transceiver.sender.track === (current.track as unknown as MediaStreamTrack)
        && !h.client['negotiating'], 'current capture installed');
      const retired = stream();
      if (outcome === 'resolve') h.captureRequests[1]!.resolve(retired.value);
      else h.captureRequests[1]!.reject(new DOMException('retired denial', 'NotAllowedError'));
      await h.tick();
      assert.equal(retired.track.stops, outcome === 'resolve' ? 1 : 0);
      assert.equal(current.track.stops, 0); assert.equal(peer.transceiver.sender.track, current.track);
      assert.equal(h.client['micFailed'], false); assert.equal(h.micErrors.length, 1);
      assert.equal(h.micReady(), 1); assert.deepEqual(h.errors, []);
    });
  }
}

it('manual microphone retry queued on a retired peer cannot block or capture for a new peer', async t => {
  const h = setup(t, { holdCapture: true }), initial = await h.join();
  const gate = initial.peer.holdNextReplacement();
  await failInitialMicrophone(h, initial.socket);
  await h.until(() => gate.entered, 'old receive-only replacement held');
  assert.equal(h.client.retryMicrophone(), true);
  await h.client.disconnect();
  const { socket, peer } = await h.join(); socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => h.captureRequests.length === 2, 'replacement peer acquires without old queue');
  const source = stream(); h.captureRequests[1]!.resolve(source.value);
  await h.until(() => peer.transceiver.sender.track === (source.track as unknown as MediaStreamTrack), 'new peer capture');
  gate.resolve(); await h.tick();
  assert.equal(h.captureRequests.length, 2); assert.equal(source.track.stops, 0);
  assert.equal(peer.transceiver.sender.track, source.track); assert.equal(h.micErrors.length, 1);
  assert.equal(h.micReady(), 1); assert.deepEqual(h.errors, []);
});

it('manual microphone retry leaves independent preview and shared micready semantics unchanged', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  await failInitialMicrophone(h, socket);
  const previewPromise = h.client.startMicTest();
  await h.until(() => h.captureRequests.length === 2, 'independent preview');
  const previewSource = stream(); h.captureRequests[1]!.resolve(previewSource.value);
  const preview = await h.complete(previewPromise, 'preview ready');
  assert.equal(h.micReady(), 1); assert.equal(h.client['mic'], null);
  assert.equal(h.client['micFailed'], true); assert.equal(peer.transceiver.sender.track, null);
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.captureRequests.length === 3, 'room retry separate from preview');
  const gate = peer.holdNextReplacement(), roomSource = stream();
  h.captureRequests[2]!.resolve(roomSource.value);
  await h.until(() => gate.entered, 'room sender installation held');
  assert.equal(h.micReady(), 2, 'room micready still precedes replaceTrack completion');
  assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.transceiver.direction, 'recvonly');
  preview.stop(); assert.equal(previewSource.track.stops, 1); assert.equal(roomSource.track.stops, 0);
  gate.resolve();
  await h.until(() => peer.transceiver.sender.track === (roomSource.track as unknown as MediaStreamTrack)
    && !h.client['negotiating'], 'room retry installed');
  assert.equal(roomSource.track.stops, 0); assert.deepEqual(h.errors, []);
});

it('manual microphone retry admission does not promise sender installation success', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  await failInitialMicrophone(h, socket);
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.captureRequests.length === 2, 'admitted capture');
  const gate = peer.holdNextReplacement(), source = stream(); h.captureRequests[1]!.resolve(source.value);
  await h.until(() => gate.entered, 'sender installation');
  gate.reject(new Error('controlled retry replaceTrack failure'));
  await h.until(() => h.errors.length === 1, 'sender failure remains an error event');
  assert.deepEqual(h.errors, ['media_error']); assert.equal(h.micErrors.length, 1);
  assert.equal(h.micReady(), 1); assert.equal(peer.transceiver.sender.track, null);
  assert.equal(h.client.retryMicrophone(), false, 'installation failure is outside failed-capture retry eligibility');
  assert.equal(source.track.stops, 0, 'the existing syncMedia capture ownership is unchanged');
});

it('manual microphone retry can be admitted by a synchronous micerror listener without duplicate capture', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  const admissions: boolean[] = [];
  const off = h.client.on('micerror', () => { admissions.push(h.client.retryMicrophone(), h.client.retryMicrophone()); });
  socket.deliver({ type: 'room:state', ...state(true) });
  await h.until(() => h.captureRequests.length === 1, 'initial permission');
  h.captureRequests[0]!.reject(new DOMException('controlled denial', 'NotAllowedError'));
  await h.until(() => h.captureRequests.length === 2, 'listener-admitted capture'); off();
  assert.deepEqual(admissions, [true, false]);
  const source = stream(); h.captureRequests[1]!.resolve(source.value);
  await h.until(() => peer.transceiver.sender.track === (source.track as unknown as MediaStreamTrack), 'listener retry installed');
  assert.equal(h.captureRequests.length, 2); assert.equal(h.micReady(), 1); assert.deepEqual(h.errors, []);
});

it('manual microphone retry respects synchronous micready disconnect before sender installation', async t => {
  const h = setup(t, { holdCapture: true }), { socket, peer } = await h.join();
  await failInitialMicrophone(h, socket);
  h.client.on('micready', () => { void h.client.disconnect(); });
  assert.equal(h.client.retryMicrophone(), true);
  await h.until(() => h.captureRequests.length === 2, 'manual capture');
  const source = stream(); h.captureRequests[1]!.resolve(source.value);
  await h.until(() => h.client.status === 'disconnected', 'callback disconnect'); await h.tick();
  assert.equal(source.track.stops, 1); assert.equal(source.track.enabled, false);
  assert.equal(peer.transceiver.sender.track, null); assert.equal(h.client['mic'], null);
  assert.equal(h.client.retryMicrophone(), false); assert.equal(h.micErrors.length, 1);
  assert.deepEqual(h.errors, []);
});
