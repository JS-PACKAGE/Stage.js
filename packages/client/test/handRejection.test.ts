import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, type StageClientOptions, type StageEventMap } from '../src/index.ts';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string) {
    assert.equal(this.readyState, Socket.OPEN);
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

/** Media is fully controlled; the real SDK parses every frame and completes its own signaling. */
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
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}
function capture() {
  const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; } });
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function snapshot(options: Partial<Pick<RoomStatePayload, 'roomId' | 'status'>> & { me?: Partial<RoomStatePayload['me']> } = {}): RoomStatePayload {
  const me: RoomStatePayload['me'] = { participantId: 'self', name: 'Self', role: 'audience', onStage: false,
    handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0, ...options.me };
  return { roomId: options.roomId ?? 'room', name: 'Room', controllerId: 'host', speakers: [],
    hands: me.handRaised ? [me] : [], audienceCount: 1, codeRequired: false, recording: false, recordingAvailable: false, status: options.status ?? 'live',
    resumeToken: `seat-${me.participantId}`, limits: { maxSpeakers: 8, maxAudience: 300 }, me };
}
const deliverState = (socket: Socket, state: RoomStatePayload) => socket.deliver({ type: 'room:state', ...state });
const reject = (socket: Socket, roomId = 'room', participantId = 'self') =>
  socket.deliver({ type: 'hand:rejected', roomId, participantId });
function latest<K extends ClientMessage['type']>(socket: Socket, type: K): Extract<ClientMessage, { type: K }> {
  const message = socket.sent.filter(message => message.type === type).at(-1);
  assert.ok(message, `expected ${type} on the wire`);
  return message as Extract<ClientMessage, { type: K }>;
}
function acknowledge(socket: Socket, message: ClientMessage) {
  assert.ok('requestId' in message);
  socket.deliver({ type: 'ok', requestId: message.requestId });
}
function resources(client: StageClient) {
  return { state: structuredClone(client.state), status: client.status,
    pending: [...client['pending']], pendingControls: client['pendingControlRequests'],
    pacing: [client['nextControlAt'], client['nextIceAt'], client['lastSendAt']], cooldown: client.handCooldownMs,
    peer: client['pc'], peerId: client['pcParticipantId'], session: structuredClone(client['session']),
    wires: Socket.instances.map(socket => [...socket.sent]) };
}
function setup(t: TestContext, options: Partial<StageClientOptions> = {}) {
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
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000, enableMicMeter: false,
    reconnect: { initialDelayMs: 25, maxDelayMs: 25 }, audioElement: { pause() {} } as unknown as HTMLAudioElement, ...options });
  const errors: string[] = [], expectedErrors: string[] = [], notices: StageEventMap['handrejected'][] = [];
  client.on('error', event => errors.push(event.detail.code));
  client.on('handrejected', event => notices.push(event.detail));
  t.after(async () => {
    try {
      await client.disconnect(); await flush();
      assert.equal(client['pending'].size, 0);
      assert.equal(client['pendingControlRequests'], 0);
      assert.deepEqual(errors, expectedErrors);
      assert.ok(Peer.instances.every(peer => peer.connectionState === 'closed'));
      assert.ok(captures.every(stream => stream.track.readyState === 'ended'));
      const count = Socket.instances.length;
      await tick(2000);
      assert.equal(Socket.instances.length, count, 'cleanup cancels automatic reconnection');
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  async function ready() {
    const socket = Socket.instances.at(-1)!; assert.ok(socket);
    socket.hello(); await flush(); await tick(0); return socket;
  }
  async function join(state = snapshot()) {
    const pending = client.join({ roomId: state.roomId, name: state.me.name });
    const socket = await ready();
    deliverState(socket, state); acknowledge(socket, latest(socket, 'join'));
    await pending; await flush(); await tick(200);
    assert.equal(client.status, state.status);
    assert.equal(Peer.instances.at(-1)!.connectionState, 'connected');
    assert.equal(client['pending'].size, 0);
    return socket;
  }
  return { client, captures, tick, ready, join, notices, expectedErrors };
}

for (const status of ['live', 'waiting'] as const) {
  it(`preserves the legacy withdrawal/state order and emits a payload-only ${status} rejection without side effects`, async t => {
    const f = setup(t), socket = await f.join(snapshot({ status }));
    const raised = f.client.raiseHand(); await f.tick(100);
    deliverState(socket, snapshot({ status, me: { handRaised: true } }));
    acknowledge(socket, latest(socket, 'hand:raise')); await raised;
    const peer = Peer.instances[0]!, offers = peer.offers, sends = socket.sent.length;
    const trace: string[] = [];
    f.client.on('hand', event => {
      assert.deepEqual(event.detail, { participantId: 'self', raised: false }); trace.push('hand:false');
    });
    f.client.on('state', () => trace.push('state'));
    f.client.on('handrejected', event => {
      assert.equal(f.client.me!.handRaised, false);
      assert.equal(f.client.me!.onStage, false);
      assert.deepEqual(event.detail, { roomId: 'room', participantId: 'self' });
      assert.deepEqual(Object.keys(event.detail).sort(), ['participantId', 'roomId']);
      trace.push('handrejected');
    });
    socket.deliver({ type: 'hand:withdraw', participantId: 'self' });
    assert.equal(f.client.me!.handRaised, true, 'the legacy event does not invent optimistic snapshot changes');
    assert.deepEqual(f.notices, []);
    deliverState(socket, snapshot({ status }));
    await flush(); await f.tick(100);
    const before = resources(f.client), state = f.client.state;
    reject(socket);
    assert.deepEqual(trace, ['hand:false', 'state', 'handrejected']);
    assert.deepEqual(resources(f.client), before);
    assert.equal(f.client.state, state, 'the notification neither mutates nor replaces authoritative state');
    assert.deepEqual(f.notices, [{ roomId: 'room', participantId: 'self' }]);
    await flush(); await f.tick(300);
    assert.deepEqual(Peer.instances, [peer]); assert.equal(peer.offers, offers);
    assert.equal(peer.connectionState, 'connected'); assert.equal(f.captures.length, 0);
    assert.equal(socket.sent.length, sends, 'notification does not send an ACK, raise, withdraw or automatic retry');
    assert.equal(socket.sent.filter(message => message.type === 'hand:raise').length, 1);
    assert.ok(f.client.handCooldownMs > 0, 'the original hand admission cooldown remains in force');
  });
}

it('does not synthesize rejection from ordinary withdrawal, state clearing, invitation, error or unknown frames', async t => {
  const f = setup(t), socket = await f.join(snapshot({ me: { handRaised: true } }));
  const hands: StageEventMap['hand'][] = [], invites: StageEventMap['invite'][] = [];
  f.client.on('hand', event => hands.push(event.detail));
  f.client.on('invite', event => invites.push(event.detail));
  socket.deliver({ type: 'hand:withdraw', participantId: 'someone-else' });
  socket.deliver({ type: 'hand:withdraw', participantId: 'self' });
  deliverState(socket, snapshot());
  socket.deliver({ type: 'stage:invite', participantId: 'self', byId: 'host' });
  f.expectedErrors.push('conflict');
  socket.deliver({ type: 'error', code: 'conflict', message: 'Test rejection' });
  const before = resources(f.client);
  socket.onmessage?.({ data: JSON.stringify({ type: 'future:unrecognized', roomId: 'room', participantId: 'self' }) });
  assert.deepEqual(resources(f.client), before, 'unrecognized additive server messages remain harmless');
  assert.deepEqual(hands, [{ participantId: 'someone-else', raised: false }, { participantId: 'self', raised: false }]);
  assert.deepEqual(invites, [{ participantId: 'self', byId: 'host' }]);
  assert.deepEqual(f.notices, []);
});

for (const [label, options, wireRoom, wireId] of [
  ['wrong room', {}, 'other-room', 'self'],
  ['wrong identity', {}, 'room', 'another-seat'],
  ['still-raised hand', { me: { handRaised: true } }, 'room', 'self'],
  ['speaker role', { me: { role: 'speaker' as const } }, 'room', 'self'],
  ['controller role', { me: { role: 'controller' as const } }, 'room', 'self'],
  ['already on stage', { me: { onStage: true } }, 'room', 'self'],
] as const) {
  it(`ignores a targeted frame for ${label}`, async t => {
    const f = setup(t), socket = await f.join(snapshot(options));
    const before = resources(f.client), state = f.client.state;
    reject(socket, wireRoom, wireId);
    assert.deepEqual(f.notices, []);
    assert.equal(f.client.state, state);
    assert.deepEqual(resources(f.client), before);
  });
}

it('ignores rejection before any personalized snapshot or while reconnecting', async t => {
  const f = setup(t), connecting = f.client.connect();
  const socket = Socket.instances[0]!;
  reject(socket);
  socket.hello(); await connecting;
  reject(socket);
  assert.equal(f.client.state, null); assert.deepEqual(f.notices, []);
  const joined = f.client.join({ roomId: 'room', name: 'Self' }); await flush(); await f.tick(0);
  deliverState(socket, snapshot()); acknowledge(socket, latest(socket, 'join')); await joined;
  await flush(); await f.tick(200);
  socket.close();
  assert.equal(f.client.status, 'reconnecting');
  reject(socket);
  await f.tick(25);
  const replacement = await f.ready();
  assert.notEqual(replacement, socket);
  reject(replacement);
  assert.deepEqual(f.notices, [], 'a retained audience snapshot alone cannot admit a reconnecting notification');
  acknowledge(replacement, latest(replacement, 'join'));
  deliverState(replacement, snapshot()); await flush();
  assert.equal(f.client.status, 'live');
  assert.deepEqual(f.notices, [], 'resumed hand-false state does not replay an old decision');
  reject(socket); assert.deepEqual(f.notices, [], 'the retired wire is ignored even for the same room and identity');
  reject(replacement);
  assert.deepEqual(f.notices, [{ roomId: 'room', participantId: 'self' }]);
});

for (const replacement of ['new room', 'new identity'] as const) {
  it(`rejects old-room and retired-wire messages after joining a ${replacement}`, async t => {
    const f = setup(t), old = await f.join();
    await f.client.disconnect();
    const roomId = replacement === 'new room' ? 'replacement-room' : 'room';
    const id = replacement === 'new room' ? 'self' : 'replacement-seat';
    const socket = await f.join(snapshot({ roomId, me: { participantId: id } }));
    const before = resources(f.client);
    reject(old); reject(old, roomId, id); reject(socket);
    assert.deepEqual(f.notices, []);
    assert.deepEqual(resources(f.client), before);
    reject(socket, roomId, id);
    assert.deepEqual(f.notices, [{ roomId, participantId: id }]);
  });
}

for (const event of ['status', 'state'] as const) {
  for (const change of ['disconnect', 'socket loss', 'raise again', 'replace identity', 'replace room'] as const) {
    it(`checks current ownership after a reentrant ${event} callback performs ${change}`, async t => {
      const f = setup(t), socket = await f.join(snapshot({ me: { handRaised: true } }));
      const off = f.client.on(event, () => {
        off();
        if (change === 'disconnect') void f.client.disconnect();
        else if (change === 'socket loss') socket.close();
        else if (change === 'raise again') deliverState(socket, snapshot({ me: { handRaised: true } }));
        else if (change === 'replace identity') deliverState(socket, snapshot({ me: { participantId: 'replacement' } }));
        else deliverState(socket, snapshot({ roomId: 'replacement-room' }));
      });
      deliverState(socket, snapshot({ status: 'waiting' }));
      const before = resources(f.client), state = f.client.state;
      reject(socket);
      assert.deepEqual(f.notices, []);
      assert.equal(f.client.state, state);
      assert.deepEqual(resources(f.client), before, 'the old rejection cannot overwrite state installed by a listener');
    });
  }
}

for (const terminal of ['disconnect', 'kicked', 'room:closed'] as const) {
  it(`ignores late targeted notifications after ${terminal}`, async t => {
    const f = setup(t), socket = await f.join();
    if (terminal === 'disconnect') await f.client.disconnect();
    else { socket.deliver({ type: terminal, roomId: 'room' }); await flush(); }
    assert.equal(f.client.status, 'disconnected');
    const before = resources(f.client);
    reject(socket); await flush();
    assert.deepEqual(f.notices, []); assert.deepEqual(resources(f.client), before);
    await f.tick(500);
    assert.equal(Socket.instances.length, 1, 'late notices cannot reconnect a departed participant');
  });
}

it('does not complete an unrelated pending request or introduce a notification request method', async t => {
  const f = setup(t), socket = await f.join();
  let settled = false;
  const renamed = f.client.setName('Pending').then(() => { settled = true; });
  await f.tick(100);
  const pending = latest(socket, 'participant:rename'), before = resources(f.client);
  reject(socket); await flush();
  assert.equal(settled, false);
  assert.deepEqual(resources(f.client), before);
  assert.equal('handrejected' in f.client, false);
  assert.equal('handRejected' in f.client, false);
  acknowledge(socket, pending); await renamed;
  assert.equal(settled, true);
  assert.deepEqual(socket.sent.map(message => message.type), ['join', 'rtc:offer', 'participant:rename']);
});
