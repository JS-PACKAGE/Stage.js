import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, StageError, type StageClientOptions } from '../src/index.ts';

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
type Entry = 'join' | 'create';
type Join = Extract<ClientMessage, { type: 'join' }>;
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string) {
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    if (message.type === 'rtc:offer') {
      this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
      acknowledge(this, message);
    }
  }
  deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello() {
    this.readyState = Socket.OPEN;
    this.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

/** Complete fake signaling distinguishes metadata updates from real peer/track replacement. */
class Peer {
  static instances: Peer[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  offers = 0;
  readonly transceiver = { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
    replacements: [] as (MediaStreamTrack | null)[],
    async replaceTrack(track: MediaStreamTrack | null) { this.replacements.push(track); this.track = track; } } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  async createOffer() { this.offers++; return { type: 'offer' as const, sdp: 'v=0\r\n' }; }
  async setLocalDescription(offer: RTCSessionDescriptionInit) { this.localDescription = offer; }
  async setRemoteDescription(answer: RTCSessionDescriptionInit) { this.remoteDescription = answer; this.connectionState = 'connected'; }
  close() { this.connectionState = 'closed'; }
}
function capture() {
  const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; } });
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function snapshot(name = 'Original room', options: { roomId?: string; participantId?: string;
  role?: RoomStatePayload['me']['role']; status?: RoomStatePayload['status']; onStage?: boolean } = {}): RoomStatePayload {
  const { roomId = 'room', participantId = 'self', role = 'controller', status = 'live', onStage = false } = options;
  const me = { participantId, name: 'Self &amp; Accepted', role, onStage, handRaised: false,
    muted: false, forceMuted: false, gainDb: 3, connected: true, joinedAt: 123 };
  return { roomId, name, controllerId: role === 'controller' ? participantId : 'host',
    speakers: onStage ? [me] : [], hands: [], audienceCount: role === 'audience' ? 1 : 0,
    codeRequired: true, recording: false, recordingAvailable: false, status, resumeToken: `seat-${participantId}`, limits: { maxSpeakers: 8, maxAudience: 300 },
    ...(role === 'controller' ? { code: 'room-code', audience: [] } : {}), me };
}
const deliverState = (socket: Socket, state: RoomStatePayload) => socket.deliver({ type: 'room:state', ...state });
function latest<K extends ClientMessage['type']>(socket: Socket, type: K): Extract<ClientMessage, { type: K }> {
  const request = socket.sent.filter(message => message.type === type).at(-1);
  assert.ok(request, `expected ${type} on the wire`);
  return request as Extract<ClientMessage, { type: K }>;
}
function acknowledge(socket: Socket, request: ClientMessage) {
  assert.ok('requestId' in request);
  socket.deliver({ type: 'ok', requestId: request.requestId });
}
function assertError(outcome: Outcome, code: StageError['code']): StageError {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('expected a rejected request');
  assert.ok(outcome.error instanceof StageError);
  assert.equal(outcome.error.code, code);
  return outcome.error;
}
function fixture(t: TestContext, settings: Partial<StageClientOptions> = {}) {
  Socket.instances = []; Peer.instances = [];
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  const captures: ReturnType<typeof capture>[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
    const stream = capture(); captures.push(stream); return stream.stream;
  } } } });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    reconnect: { initialDelayMs: 25, maxDelayMs: 25 }, enableMicMeter: false,
    audioElement: { pause() {} } as unknown as HTMLAudioElement, ...settings });
  const observed: Promise<Outcome>[] = [], errors: StageError[] = [], expectedErrors: StageError['code'][] = [];
  const watch = (promise: Promise<unknown>): Promise<Outcome> => {
    const result = promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    observed.push(result); return result;
  };
  client.on('error', event => errors.push(event.detail));
  t.after(async () => {
    try {
      await client.disconnect(); await flush(); await Promise.all(observed);
      assert.deepEqual(errors.map(error => error.code), expectedErrors, 'only explicitly delivered server errors are emitted');
      assert.ok(Peer.instances.every(peer => peer.connectionState === 'closed'));
      assert.ok(captures.every(stream => stream.track.readyState === 'ended'));
      const count = Socket.instances.length;
      await tick(5000);
      assert.equal(Socket.instances.length, count, 'cleanup cancels reconnect work');
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  async function ready() {
    const socket = Socket.instances.at(-1)!; assert.ok(socket);
    socket.hello(); await flush(); await tick(0);
    return socket;
  }
  const entry = (operation: Entry, roomId = 'room') => watch(operation === 'join'
    ? client.join({ roomId, name: 'Self', code: 'room-code' })
    : client.createRoom({ name: 'Self', roomName: 'Submitted creation title', codeRequired: true }));
  async function completeEntry(socket: Socket, pending: Promise<Outcome>, operation: Entry, roomId = 'room') {
    if (operation === 'create') socket.deliver({ type: 'room:created', roomId, code: 'room-code' });
    acknowledge(socket, latest(socket, operation === 'join' ? 'join' : 'room:create'));
    assert.equal((await pending).ok, true);
  }
  async function join(state: RoomStatePayload | null = snapshot()) {
    const pending = entry('join'), socket = await ready();
    await completeEntry(socket, pending, 'join');
    if (state) { deliverState(socket, state); await flush(); await tick(100); }
    return socket;
  }
  async function resume(lost: Socket): Promise<{ socket: Socket; message: Join }> {
    if (lost.readyState === Socket.OPEN) { await flush(); await tick(200); lost.close(); }
    await tick(25);
    const socket = await ready(); assert.notEqual(socket, lost);
    const message = latest(socket, 'join');
    acknowledge(socket, message); await flush();
    assert.deepEqual(socket.sent.map(request => request.type), ['join'], 'resume never replays a title command or creates a room');
    assert.deepEqual(Object.keys(message).sort(), ['code', 'name', 'requestId', 'resumeToken', 'roomId', 'type']);
    return { socket, message };
  }
  const reject = (socket: Socket, request: ClientMessage, code: Extract<ServerMessage, { type: 'error' }>['code']) => {
    assert.ok('requestId' in request);
    expectedErrors.push(code);
    socket.deliver({ type: 'error', requestId: request.requestId, code, message: 'Test rejection' });
  };
  return { client, captures, errors, watch, ready, entry, completeEntry, join, resume, reject, tick };
}

it('sends the raw room name and publishes authoritative state before ACK without replacing healthy media', async t => {
  const f = fixture(t), initial = snapshot('Original room', { onStage: true }), socket = await f.join(initial);
  const peer = Peer.instances[0]!, track = f.captures[0]!.track;
  assert.equal(peer.connectionState, 'connected'); assert.equal(peer.offers, 1);
  const trace: string[] = [];
  f.client.on('state', () => trace.push('state'));
  const submitted = '  <Cafe\u0301 & "friends">\u0000\u200b  ';
  const pending = f.watch(f.client.setRoomName(submitted).then(() => { trace.push('ack'); }));
  const before = f.client.state;
  assert.equal(before?.name, 'Original room');
  await f.tick(100);
  const request = latest(socket, 'room:rename');
  assert.deepEqual(request, { type: 'room:rename', name: submitted, requestId: request.requestId });
  assert.equal(f.client.state, before, 'sending does not optimistically replace state');
  assert.deepEqual(trace, []);
  const accepted = '&lt;Café &amp; &quot;friends&quot;&gt;';
  deliverState(socket, { ...initial, name: accepted });
  assert.deepEqual(trace, ['state']);
  assert.deepEqual(f.client.state, { ...initial, name: accepted });
  acknowledge(socket, request); assert.equal((await pending).ok, true);
  assert.deepEqual(trace, ['state', 'ack']);
  await flush();
  assert.deepEqual(Peer.instances, [peer]); assert.equal(peer.connectionState, 'connected');
  assert.equal(peer.offers, 1); assert.equal(socket.sent.filter(message => message.type === 'rtc:offer').length, 1);
  assert.equal(f.captures.length, 1); assert.equal(peer.transceiver.sender.track, track);
  for (const replacement of peer.transceiver.sender.replacements) assert.equal(replacement, track, 'same-track reconciliation is allowed');
  assert.equal(track.stops, 0); assert.equal(track.enabled, true);
  const resumed = await f.resume(socket);
  assert.deepEqual({ roomId: resumed.message.roomId, name: resumed.message.name, code: resumed.message.code, resumeToken: resumed.message.resumeToken },
    { roomId: 'room', name: 'Self & Accepted', code: 'room-code', resumeToken: 'seat-self' });
  deliverState(resumed.socket, { ...initial, name: accepted }); await flush();
  assert.deepEqual(Peer.instances, [peer]); assert.equal(peer.offers, 1);
  assert.equal(f.captures.length, 1); assert.equal(track.stops, 0); assert.equal(peer.transceiver.sender.track, track);
});

for (const [label, submitted] of [['blank', ' \t '], ['beyond a hard-coded client limit', '😀'.repeat(96)]] as const) {
  it(`leaves ${label} room-name validation to the server`, async t => {
    const f = fixture(t), socket = await f.join(), before = f.client.state;
    const pending = f.watch(f.client.setRoomName(submitted)); await f.tick(100);
    const request = latest(socket, 'room:rename'); assert.equal(request.name, submitted);
    f.reject(socket, request, 'bad_request'); assertError(await pending, 'bad_request');
    assert.equal(f.client.state, before);
  });
}

for (const withState of [false, true]) {
  it(`does not invent a room title after ACK-only success ${withState ? 'with' : 'without'} a snapshot`, async t => {
    const f = fixture(t), socket = await f.join(withState ? snapshot() : null), before = f.client.state;
    let states = 0; f.client.on('state', () => states++);
    const pending = f.watch(f.client.setRoomName('Unconfirmed title')); await f.tick(100);
    acknowledge(socket, latest(socket, 'room:rename'));
    assert.deepEqual(await pending, { ok: true, value: undefined });
    assert.equal(f.client.state, before); assert.equal(states, 0);
    assert.equal(Socket.instances.length, 1);
    assert.equal(socket.sent.filter(message => message.type === 'join').length, 1);
    assert.equal(socket.sent.filter(message => message.type === 'room:create').length, 0);
  });
}

for (const code of ['forbidden', 'unknown_type', 'not_joined'] as const) {
  it(`propagates ${code} with the same error object and preserves the authoritative room title`, async t => {
    const f = fixture(t), socket = await f.join(snapshot('Accepted title', { role: 'audience' }));
    const before = f.client.state, pending = f.watch(f.client.setRoomName('Rejected title'));
    await f.tick(100);
    const request = latest(socket, 'room:rename'); f.reject(socket, request, code);
    const error = assertError(await pending, code);
    assert.equal(error, f.errors[0]); assert.equal(error.message, 'Test rejection');
    assert.equal(f.client.state, before);
    await f.tick(100);
    assert.equal(socket.sent.filter(message => message.type === 'room:rename').length, 1);
    assert.equal(socket.sent.filter(message => message.type === 'join').length, 1, 'errors do not leave and rejoin');
    assert.equal(socket.sent.filter(message => message.type === 'room:create').length, 0, 'old servers get no recreate fallback');
  });
}

it('uses existing capacity and pacing without reserving send slots for rejected room renames', async t => {
  const f = fixture(t, { maxPendingControlRequests: 1 }), socket = await f.join(), before = f.client.state;
  const first = f.watch(f.client.setRoomName('First'));
  assertError(await f.watch(f.client.setRoomName('Queue rejected')), 'queue_full');
  assertError(await f.watch(f.client.rotateCode()), 'queue_full');
  await f.tick(99); assert.equal(socket.sent.filter(message => message.type === 'room:rename').length, 0);
  await f.tick(1); acknowledge(socket, latest(socket, 'room:rename')); assert.equal((await first).ok, true);
  const next = f.watch(f.client.setRoomName('Next'));
  await f.tick(99); assert.equal(socket.sent.filter(message => message.type === 'room:rename').length, 1);
  await f.tick(1); assert.equal(socket.sent.filter(message => message.type === 'room:rename').length, 2);
  acknowledge(socket, latest(socket, 'room:rename')); assert.equal((await next).ok, true);
  assert.equal(f.client.state, before);
});

it('rejects a disconnected room rename without opening a socket', async t => {
  const f = fixture(t);
  assertError(await f.watch(f.client.setRoomName('Unavailable')), 'disconnected');
  assert.equal(Socket.instances.length, 0); assert.equal(f.client.state, null);
});

it('releases capacity after timeout and ignores late ACKs without changing the title', async t => {
  const f = fixture(t, { maxPendingControlRequests: 1 }), socket = await f.join(), before = f.client.state;
  const first = f.watch(f.client.setRoomName('Timed out')); await f.tick(100);
  const expired = latest(socket, 'room:rename'); await f.tick(1000);
  assertError(await first, 'timeout'); assert.equal(f.client.state, before);
  let settled = false;
  const next = f.watch(f.client.setRoomName('Next').then(() => { settled = true; })); await f.tick(0);
  const current = latest(socket, 'room:rename'); assert.notEqual(current.requestId, expired.requestId);
  acknowledge(socket, expired); await flush(); assert.equal(settled, false);
  assertError(await f.watch(f.client.setRoomName('Still full')), 'queue_full');
  acknowledge(socket, current); assert.equal((await next).ok, true);
  assert.equal(f.client.state, before);
});

it('keeps the newest snapshot when two room-rename ACKs arrive in reverse order', async t => {
  const f = fixture(t), socket = await f.join();
  const first = f.watch(f.client.setRoomName('First')), second = f.watch(f.client.setRoomName('Second'));
  await f.tick(200);
  const requests = socket.sent.filter(message => message.type === 'room:rename');
  assert.equal(requests.length, 2); assert.notEqual(requests[0]!.requestId, requests[1]!.requestId);
  deliverState(socket, snapshot('First accepted')); deliverState(socket, snapshot('Second accepted'));
  const newest = f.client.state;
  acknowledge(socket, requests[1]!); assert.equal((await second).ok, true);
  acknowledge(socket, requests[0]!); assert.equal((await first).ok, true);
  assert.equal(f.client.state, newest); assert.equal(f.client.state?.name, 'Second accepted');
  await f.resume(socket); assert.equal(f.client.state, newest);
});

for (const loss of ['timeout', 'socket close'] as const) {
  it(`retains the accepted room title when its ACK is lost to ${loss} and does not replay it on resume`, async t => {
    const f = fixture(t), socket = await f.join();
    const pending = f.watch(f.client.setRoomName('Submitted')); await f.tick(100);
    const request = latest(socket, 'room:rename');
    deliverState(socket, snapshot('Accepted &amp; Sanitized')); const accepted = f.client.state;
    if (loss === 'timeout') await f.tick(1000); else socket.close();
    assertError(await pending, loss === 'timeout' ? 'timeout' : 'disconnected');
    assert.equal(f.client.state, accepted);
    const resumed = await f.resume(socket);
    deliverState(resumed.socket, snapshot('Newer title while disconnected'));
    acknowledge(socket, request); deliverState(socket, snapshot('Retired title'));
    assert.equal(f.client.state?.name, 'Newer title while disconnected');
    assert.equal(resumed.message.name, 'Self & Accepted', 'room title never becomes the participant resume name');
  });
}

for (const operation of ['join', 'create'] as const) {
  it(`preserves a room-title update received before the initial ${operation} ACK`, async t => {
    const f = fixture(t), pending = f.entry(operation), socket = await f.ready();
    deliverState(socket, snapshot('Initial title'));
    const rename = f.watch(f.client.setRoomName('Submitted edit')); await f.tick(200);
    deliverState(socket, snapshot('Latest &amp; Accepted'));
    acknowledge(socket, latest(socket, 'room:rename')); assert.equal((await rename).ok, true);
    const accepted = f.client.state;
    await f.completeEntry(socket, pending, operation);
    assert.equal(f.client.state, accepted); assert.equal(f.client.state?.name, 'Latest &amp; Accepted');
    const resumed = await f.resume(socket);
    assert.equal(resumed.message.name, 'Self & Accepted');
    assert.equal(f.client.state, accepted, 'entry and resume ACKs cannot restore the creation title');
  });
}

for (const terminal of ['disconnect', 'kicked', 'room:closed'] as const) {
  for (const sent of [false, true]) {
    it(`cancels a ${sent ? 'sent' : 'paced'} room rename on ${terminal} and rejects retired socket ownership`, async t => {
      const f = fixture(t), old = await f.join(), rename = f.watch(f.client.setRoomName('Retired request'));
      if (sent) await f.tick(100);
      if (terminal === 'disconnect') await f.client.disconnect();
      else { old.deliver({ type: terminal, roomId: 'room' }); await flush(); }
      assertError(await rename, 'disconnected');
      await f.tick(200); assert.equal(Socket.instances.length, 1, 'terminal events do not auto-resume');
      assert.equal(old.sent.filter(message => message.type === 'room:rename').length, sent ? 1 : 0);
      const entering = f.entry('join'), socket = await f.ready();
      deliverState(old, snapshot('Retired before initial ACK'));
      const beforeReplacement = f.client.state;
      assert.equal(beforeReplacement, null);
      await f.completeEntry(socket, entering, 'join');
      deliverState(socket, snapshot('Fresh title', { participantId: 'new-self' })); await flush(); await f.tick(100);
      let settled = false;
      const current = f.watch(f.client.setRoomName('Fresh request').then(() => { settled = true; })); await f.tick(100);
      const request = latest(socket, 'room:rename');
      // Even a matching request ID cannot give the retired socket ownership of the new Promise.
      acknowledge(old, request);
      old.deliver({ type: 'error', requestId: request.requestId, code: 'forbidden', message: 'Retired error' });
      deliverState(old, snapshot('Retired after replacement')); await flush();
      assert.equal(settled, false); assert.equal(f.client.state?.name, 'Fresh title');
      assert.equal(f.client.me?.participantId, 'new-self');
      deliverState(socket, snapshot('Fresh accepted title', { participantId: 'new-self' }));
      acknowledge(socket, request); assert.equal((await current).ok, true);
      const resumed = await f.resume(socket); assert.equal(resumed.message.resumeToken, 'seat-new-self');
      assert.equal(f.client.state?.name, 'Fresh accepted title');
    });
  }
}

for (const role of ['controller', 'speaker', 'audience'] as const) {
  it(`publishes authoritative room-title snapshots for the ${role} role without changing it`, async t => {
    const f = fixture(t), initial = snapshot('Original room', { role, onStage: role === 'speaker' });
    const socket = await f.join(initial), peer = Peer.instances[0]!;
    deliverState(socket, { ...initial, name: 'Shared room title' }); await flush();
    assert.deepEqual(f.client.state, { ...initial, name: 'Shared room title' });
    assert.deepEqual(Peer.instances, [peer]); assert.equal(peer.connectionState, 'connected'); assert.equal(peer.offers, 1);
    assert.equal(f.captures.length, role === 'speaker' ? 1 : 0);
    assert.equal(socket.sent.filter(message => message.type === 'room:rename').length, 0);
  });
}

for (const event of ['status', 'state'] as const) {
  it(`keeps the newer room title when a ${event} callback synchronously publishes another snapshot`, async t => {
    const f = fixture(t), socket = await f.join();
    const off = f.client.on(event, () => { off(); deliverState(socket, snapshot('Nested newest title')); });
    deliverState(socket, snapshot('Outer older title', { status: 'waiting' }));
    assert.equal(f.client.state?.name, 'Nested newest title');
  });
}
