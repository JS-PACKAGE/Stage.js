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

/** Complete fake signaling lets name-only snapshots prove they preserve a healthy media peer. */
class Peer {
  static instances: Peer[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  offers = 0;
  readonly transceiver = { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
    async replaceTrack(track: MediaStreamTrack | null) { this.track = track; } } };
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
function snapshot(name = 'Self', options: { roomId?: string; participantId?: string; status?: 'live' | 'waiting'; onStage?: boolean } = {}): RoomStatePayload {
  const { roomId = 'room', participantId = 'self', status = 'live', onStage = false } = options;
  return { roomId, name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: onStage ? 0 : 1,
    codeRequired: false, recording: false, recordingAvailable: false, status, resumeToken: `seat-${participantId}`, limits: { maxSpeakers: 8, maxAudience: 300 },
    me: { participantId, name, role: onStage ? 'speaker' : 'audience', onStage, handRaised: false,
      muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
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
function assertError(outcome: Outcome, code: StageError['code']) {
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.error instanceof StageError);
  assert.equal(outcome.error.code, code);
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
  const observed: Promise<Outcome>[] = [], errors: StageError['code'][] = [], expectedErrors: StageError['code'][] = [];
  const watch = (promise: Promise<unknown>): Promise<Outcome> => {
    const result = promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    observed.push(result); return result;
  };
  client.on('error', event => errors.push(event.detail.code));
  t.after(async () => {
    try {
      await client.disconnect(); await flush(); await Promise.all(observed);
      assert.deepEqual(errors, expectedErrors, 'only explicitly delivered server errors are emitted');
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
  const entry = (operation: Entry, name = 'Self', roomId = 'room') => watch(operation === 'join'
    ? client.join({ roomId, name }) : client.createRoom({ name, codeRequired: false }));
  async function completeEntry(socket: Socket, pending: Promise<Outcome>, operation: Entry, roomId = 'room') {
    if (operation === 'create') socket.deliver({ type: 'room:created', roomId });
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
    if (lost.readyState === Socket.OPEN) {
      // Finish scheduled fake signaling before this control-plane reconnect probe.
      await flush(); await tick(200); lost.close();
    }
    await tick(25);
    const socket = await ready(); assert.notEqual(socket, lost);
    const message = latest(socket, 'join');
    acknowledge(socket, message); await flush();
    assert.equal(socket.sent.filter(message => message.type === 'join').length, 1);
    return { socket, message };
  }
  const reject = (socket: Socket, request: ClientMessage, code: Extract<ServerMessage, { type: 'error' }>['code']) => {
    assert.ok('requestId' in request);
    expectedErrors.push(code);
    socket.deliver({ type: 'error', requestId: request.requestId, code, message: 'Test rejection' });
  };
  return { client, captures, watch, ready, entry, completeEntry, join, resume, reject, tick };
}

it('sends an own-name-only control and publishes authoritative state before resolving its ACK', async t => {
  const f = fixture(t), socket = await f.join(snapshot('Self', { onStage: true }));
  const peer = Peer.instances[0]!, track = f.captures[0]!.track;
  assert.equal(peer.connectionState, 'connected'); assert.equal(peer.offers, 1);
  const trace: string[] = [];
  f.client.on('state', () => trace.push('state'));
  const submitted = '  <Cafe\u0301 & "friends">  ';
  const pending = f.watch(f.client.setName(submitted).then(() => { trace.push('ack'); }));
  assert.equal(f.client.me?.name, 'Self');
  await f.tick(100);
  const request = latest(socket, 'participant:rename');
  assert.deepEqual(request, { type: 'participant:rename', name: submitted, requestId: request.requestId });
  assert.equal(f.client.me?.name, 'Self', 'sending is not optimistic');
  deliverState(socket, snapshot('&lt;Café &amp; &quot;friends&quot;&gt;', { onStage: true }));
  assert.deepEqual(trace, ['state']);
  assert.equal(f.client.me?.name, '&lt;Café &amp; &quot;friends&quot;&gt;');
  acknowledge(socket, request); assert.equal((await pending).ok, true);
  assert.deepEqual(trace, ['state', 'ack']);
  await flush();
  assert.deepEqual(Peer.instances, [peer]); assert.equal(peer.connectionState, 'connected');
  assert.equal(peer.offers, 1); assert.equal(socket.sent.filter(message => message.type === 'rtc:offer').length, 1);
  assert.equal(f.captures.length, 1); assert.equal(peer.transceiver.sender.track, track); assert.equal(track.stops, 0);
  assert.equal(track.enabled, true);
  assert.equal((await f.resume(socket)).message.name, '<Café & "friends">', 'resume uses decoded server sanitation and NFC');
  assert.deepEqual(Peer.instances, [peer]); assert.equal(f.captures.length, 1); assert.equal(track.stops, 0);
});

for (const [wire, decoded] of [
  ['&amp;lt;tag&amp;gt;', '&lt;tag&gt;'],
  ['&amp;amp; &lt; &gt; &quot; &#39;', '&amp; < > " \''],
  ['Café', 'Café'],
] as const) {
  it(`decodes the accepted name exactly once on each resume: ${wire}`, async t => {
    const f = fixture(t), socket = await f.join();
    const pending = f.watch(f.client.setName('caller value')); await f.tick(100);
    deliverState(socket, snapshot(wire)); acknowledge(socket, latest(socket, 'participant:rename'));
    assert.equal((await pending).ok, true);
    const first = await f.resume(socket); assert.equal(first.message.name, decoded);
    deliverState(first.socket, snapshot(wire)); await flush();
    assert.equal((await f.resume(first.socket)).message.name, decoded);
  });
}

for (const outcome of ['forbidden', 'unknown_type', 'timeout', 'ack-only'] as const) {
  it(`preserves state and resume name when a rename receives ${outcome} without a snapshot`, async t => {
    const f = fixture(t), socket = await f.join(snapshot('Accepted'));
    const before = f.client.state, pending = f.watch(f.client.setName('Unaccepted'));
    await f.tick(100);
    const request = latest(socket, 'participant:rename');
    if (outcome === 'ack-only') acknowledge(socket, request);
    else if (outcome === 'timeout') await f.tick(1000);
    else f.reject(socket, request, outcome);
    if (outcome === 'ack-only') assert.equal((await pending).ok, true);
    else assertError(await pending, outcome);
    assert.equal(f.client.state, before); assert.equal(f.client.me?.name, 'Accepted');
    assert.equal(socket.sent.filter(message => message.type === 'participant:rename').length, 1, 'no legacy fallback or retry');
    assert.equal((await f.resume(socket)).message.name, 'Accepted');
  });
}

it('applies request capacity and pacing to renames without optimistic names or reserved slots on rejection', async t => {
  const f = fixture(t, { maxPendingControlRequests: 1 }), socket = await f.join(snapshot('Accepted'));
  const first = f.watch(f.client.setName('First'));
  assertError(await f.watch(f.client.setName('Rejected')), 'queue_full');
  assert.equal(f.client.me?.name, 'Accepted');
  await f.tick(99); assert.equal(socket.sent.filter(message => message.type === 'participant:rename').length, 0);
  await f.tick(1); acknowledge(socket, latest(socket, 'participant:rename')); assert.equal((await first).ok, true);
  const next = f.watch(f.client.setName('Next'));
  await f.tick(99); assert.equal(socket.sent.filter(message => message.type === 'participant:rename').length, 1);
  await f.tick(1); assert.equal(socket.sent.filter(message => message.type === 'participant:rename').length, 2);
  acknowledge(socket, latest(socket, 'participant:rename')); assert.equal((await next).ok, true);
  assert.equal((await f.resume(socket)).message.name, 'Accepted');
});

it('rejects disconnected renames without opening a socket', async t => {
  const f = fixture(t);
  assertError(await f.watch(f.client.setName('Unavailable')), 'disconnected');
  assert.equal(Socket.instances.length, 0); assert.equal(f.client.state, null);
});

for (const loss of ['timeout', 'socket close'] as const) {
  it(`retains an accepted name when the rename ACK is lost to ${loss}`, async t => {
    const f = fixture(t), socket = await f.join();
    const pending = f.watch(f.client.setName('Submitted')); await f.tick(100);
    deliverState(socket, snapshot('Accepted &amp; Sanitized'));
    if (loss === 'timeout') await f.tick(1000); else socket.close();
    assertError(await pending, loss === 'timeout' ? 'timeout' : 'disconnected');
    assert.equal((await f.resume(socket)).message.name, 'Accepted & Sanitized');
  });
}

for (const operation of ['join', 'create'] as const) {
  it(`installs the latest accepted name when initial ${operation} is acknowledged after a rename`, async t => {
    const f = fixture(t), pending = f.entry(operation, 'Original'), socket = await f.ready();
    deliverState(socket, snapshot('Original'));
    const rename = f.watch(f.client.setName('Renamed')); await f.tick(200);
    deliverState(socket, snapshot('Renamed &amp; Accepted'));
    acknowledge(socket, latest(socket, 'participant:rename')); assert.equal((await rename).ok, true);
    await f.completeEntry(socket, pending, operation);
    assert.equal((await f.resume(socket)).message.name, 'Renamed & Accepted');
  });

  for (const event of ['status', 'state'] as const) {
    it(`captures an immutable accepted name before a ${event} callback poisons initial ${operation} state`, async t => {
      const f = fixture(t), pending = f.entry(operation, 'Original'), socket = await f.ready();
      const off = f.client.on(event, () => { off(); f.client.state!.me.name = 'Poisoned &amp; Callback'; });
      deliverState(socket, snapshot('Server &amp; Accepted'));
      assert.equal(f.client.me?.name, 'Poisoned &amp; Callback', 'the public object really was mutated');
      await f.completeEntry(socket, pending, operation);
      assert.equal((await f.resume(socket)).message.name, 'Server & Accepted');
    });
  }

  it(`does not borrow an older accepted name for an ACK-only ${operation} in the same room`, async t => {
    const f = fixture(t), socket = await f.join(snapshot('Previous seat'));
    const pending = f.entry(operation, 'New caller'); await flush(); await f.tick(100);
    await f.completeEntry(socket, pending, operation);
    assert.equal((await f.resume(socket)).message.name, 'New caller');
  });

  it(`does not install a wrong-room pre-ACK snapshot name after ${operation}`, async t => {
    const f = fixture(t), pending = f.entry(operation, 'Correct caller'), socket = await f.ready();
    deliverState(socket, snapshot('Wrong-room name', { roomId: 'other-room' }));
    await f.completeEntry(socket, pending, operation);
    assert.equal((await f.resume(socket)).message.name, 'Correct caller');
  });
}

it('uses the latest of two ordered rename snapshots even if their ACKs arrive in reverse order', async t => {
  const f = fixture(t), socket = await f.join();
  const first = f.watch(f.client.setName('First')), second = f.watch(f.client.setName('Second'));
  await f.tick(200);
  const requests = socket.sent.filter(message => message.type === 'participant:rename');
  assert.equal(requests.length, 2); assert.notEqual(requests[0]!.requestId, requests[1]!.requestId);
  deliverState(socket, snapshot('First accepted')); deliverState(socket, snapshot('Second accepted'));
  acknowledge(socket, requests[1]!); assert.equal((await second).ok, true);
  acknowledge(socket, requests[0]!); assert.equal((await first).ok, true);
  assert.equal(f.client.me?.name, 'Second accepted');
  assert.equal((await f.resume(socket)).message.name, 'Second accepted');
});

it('does not refresh an installed session name from a wrong-room snapshot', async t => {
  const f = fixture(t), socket = await f.join(snapshot('Correct room'));
  deliverState(socket, snapshot('Other room', { roomId: 'other-room' }));
  assert.equal((await f.resume(socket)).message.name, 'Correct room');
});

for (const event of ['status', 'state'] as const) {
  it(`refreshes the accepted name before a ${event} callback drops the socket`, async t => {
    const f = fixture(t), socket = await f.join();
    const off = f.client.on(event, () => { off(); socket.close(); });
    deliverState(socket, snapshot('Callback &amp; Accepted', { status: 'waiting' }));
    assert.equal((await f.resume(socket)).message.name, 'Callback & Accepted');
  });

  it(`keeps the nested name when a ${event} callback synchronously delivers newer state`, async t => {
    const f = fixture(t), socket = await f.join();
    const off = f.client.on(event, () => { off(); deliverState(socket, snapshot('Nested accepted')); });
    deliverState(socket, snapshot('Outer accepted', { status: 'waiting' }));
    assert.equal(f.client.me?.name, 'Nested accepted');
    assert.equal((await f.resume(socket)).message.name, 'Nested accepted');
  });

  it(`clears accepted names when a ${event} callback disconnects and joins a new same-room identity`, async t => {
    const f = fixture(t), old = await f.join(snapshot('Old identity'));
    let pending: Promise<Outcome> | undefined;
    const off = f.client.on(event, () => { off(); void f.client.disconnect(); pending = f.entry('join', 'New identity'); });
    deliverState(old, snapshot('Abandoned name', { status: 'waiting' }));
    assert.ok(pending);
    const socket = await f.ready(); assert.notEqual(socket, old);
    old.deliver({ type: 'room:state', ...snapshot('Retired before ACK', { participantId: 'replacement' }) });
    await f.completeEntry(socket, pending, 'join');
    old.deliver({ type: 'room:state', ...snapshot('Retired after ACK', { participantId: 'replacement' }) });
    assert.equal(f.client.state, null, 'retired frames cannot publish the new identity');
    assert.equal((await f.resume(socket)).message.name, 'New identity');
  });
}

for (const terminal of ['disconnect', 'kicked', 'room:closed'] as const) {
  it(`clears accepted rename ownership on ${terminal} before a same-room replacement entry`, async t => {
    const f = fixture(t), old = await f.join(snapshot('Old accepted name'));
    const rename = f.watch(f.client.setName('Pending old request')); await f.tick(100);
    const request = latest(old, 'participant:rename');
    if (terminal === 'disconnect') await f.client.disconnect();
    else { old.deliver({ type: terminal, roomId: 'room' }); await flush(); }
    assertError(await rename, 'disconnected');
    await f.tick(100); assert.equal(Socket.instances.length, 1, 'terminal events do not auto-resume');
    const pending = f.entry('join', 'Fresh name'), socket = await f.ready();
    deliverState(old, snapshot('Retired old name')); acknowledge(old, request);
    deliverState(socket, snapshot('Fresh &amp; Accepted', { participantId: 'new-self' }));
    await f.completeEntry(socket, pending, 'join');
    assert.equal(f.client.me?.participantId, 'new-self');
    assert.equal((await f.resume(socket)).message.name, 'Fresh & Accepted');
  });
}

it('does not install a cancelled initial entry name after a state callback replaces it', async t => {
  const f = fixture(t), first = f.entry('join', 'Old caller'), old = await f.ready();
  const oldRequest = latest(old, 'join');
  let replacement: Promise<Outcome> | undefined;
  const off = f.client.on('state', () => {
    off(); void f.client.disconnect(); replacement = f.entry('join', 'New caller');
  });
  deliverState(old, snapshot('Abandoned initial name')); acknowledge(old, oldRequest);
  assertError(await first, 'disconnected'); assert.ok(replacement);
  const socket = await f.ready();
  deliverState(socket, snapshot('New accepted name', { participantId: 'new-self' }));
  await f.completeEntry(socket, replacement, 'join');
  assert.equal((await f.resume(socket)).message.name, 'New accepted name');
});
