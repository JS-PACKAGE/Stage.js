import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, StageError, type StageClientOptions } from '../src/index.ts';

class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  failSend = false;
  constructor() { Socket.instances.push(this); }
  send(data: string) {
    if (this.failSend) throw new Error('controlled send failure');
    assert.equal(this.readyState, Socket.OPEN);
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    if (message.type === 'rtc:offer') queueMicrotask(() => {
      this.deliver({ type: 'ok', requestId: message.requestId });
      this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
    });
  }
  deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = Socket.CLOSED; this.onclose?.(); }
}

class Peer {
  static instances: Peer[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  constructor() { Peer.instances.push(this); }
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
      async replaceTrack(track: MediaStreamTrack | null) { this.track = track; } } };
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'v=0\r\n' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description; this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description; this.signalingState = 'stable';
  }
  close() { this.connectionState = 'closed'; }
}

const state: RoomStatePayload = {
  roomId: 'room', name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
  codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', resumeToken: 'test-resume-token',
  me: { participantId: 'guest', name: 'Guest', role: 'audience', onStage: false, handRaised: false,
    muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 },
};
const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve(); };
const settle = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
function assertError(error: unknown, code: StageError['code'], message?: string): void {
  assert.ok(error instanceof StageError);
  assert.equal(error.code, code);
  if (message !== undefined) assert.equal(error.message, message);
}
function hello(socket: Socket, handRaiseIntervalMs = 10000): void {
  socket.readyState = Socket.OPEN;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs } });
}
function accounting(client: StageClient) {
  return { pacing: [client['nextControlAt'], client['nextIceAt'], client['lastSendAt']],
    pending: [...client['pending']], controls: client['pendingControlRequests'] };
}
function observeAdmission(t: TestContext, client: StageClient) {
  const before = accounting(client);
  const timers = t.mock.method(globalThis, 'setTimeout');
  const ids = t.mock.method(crypto, 'randomUUID');
  const sends = Socket.instances.map(socket => socket.sent.length);
  return () => {
    assert.deepEqual(accounting(client), before, 'a rejected hand must not reserve pacing or pending capacity');
    assert.equal(timers.mock.calls.length, 0, 'a rejected hand must not allocate timers');
    assert.equal(ids.mock.calls.length, 0, 'a rejected hand must not allocate a request ID');
    assert.deepEqual(Socket.instances.map(socket => socket.sent.length), sends);
  };
}
function setup(t: TestContext, options: Partial<StageClientOptions> = {}) {
  Socket.instances = []; Peer.instances = [];
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const client = new StageClient({ url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement,
    reconnect: { initialDelayMs: 500, maxDelayMs: 500 }, ...options });
  t.after(async () => {
    await client.disconnect(); await flush();
    assert.equal(client['pending'].size, 0);
    assert.equal(client['pendingControlRequests'], 0);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  async function connect() {
    const ready = client.connect(), socket = Socket.instances.at(-1)!;
    hello(socket); await ready; return socket;
  }
  async function join(handRaiseIntervalMs = 10000) {
    const joining = settle(client.join({ roomId: state.roomId, name: state.me.name }));
    const socket = Socket.instances.at(-1)!;
    hello(socket, handRaiseIntervalMs); await flush(); await tick(0);
    const request = socket.sent.at(-1)!; assert.equal(request.type, 'join');
    socket.deliver({ type: 'room:state', ...state });
    socket.deliver({ type: 'ok', requestId: request.requestId });
    assert.equal(await joining, undefined);
    await flush(); await tick(100);
    assert.ok(Peer.instances[0]!.remoteDescription);
    assert.equal(client.status, 'live');
    assert.equal(client['pending'].size, 0);
    return socket;
  }
  async function resume(socket: Socket, handRaiseIntervalMs = 10000) {
    hello(socket, handRaiseIntervalMs); await flush(); await tick(0);
    const request = socket.sent.at(-1)!;
    assert.equal(request.type, 'join');
    if (request.type !== 'join') throw new Error('expected resume join');
    assert.equal(request.roomId, state.roomId);
    assert.equal(request.resumeToken, state.resumeToken);
    socket.deliver({ type: 'room:state', ...state });
    socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
    assert.equal(client.status, 'live');
    assert.equal(client.me?.participantId, state.me.participantId);
    assert.equal(Peer.instances.length, 1, 'same-seat resume retains the existing peer');
  }
  return { client, connect, join, resume, tick };
}

for (const phase of ['no socket', 'CONNECTING', 'CLOSING', 'CLOSED'] as const) {
  it(`does not consume hand admission resources with ${phase}`, async t => {
    const { client, connect } = setup(t);
    if (phase === 'CONNECTING') void settle(client.connect());
    else if (phase !== 'no socket') {
      const socket = await connect();
      // The transport can expose its non-OPEN state before dispatching its close event.
      socket.readyState = phase === 'CLOSING' ? Socket.CLOSING : Socket.CLOSED;
    }
    const unchanged = observeAdmission(t, client);
    assertError(await settle(client.raiseHand()), 'disconnected', '尚未連線至舞台。');
    unchanged();
    assert.equal(client.handCooldownMs, 0, 'a hand rejected before socket admission must not start cooldown');
    assertError(await settle(client.raiseHand()), 'disconnected', '尚未連線至舞台。');
    unchanged();
    assert.equal(client.handCooldownMs, 0);
  });
}

for (const phase of ['backoff', 'CONNECTING'] as const) {
  it(`can immediately raise after same-seat resume following a rejected ${phase} hand`, async t => {
    const { client, join, resume, tick } = setup(t);
    const old = await join(); old.close();
    assert.equal(client.status, 'reconnecting');
    if (phase === 'CONNECTING') await tick(500);
    const unchanged = observeAdmission(t, client);
    assertError(await settle(client.raiseHand()), 'disconnected', '尚未連線至舞台。');
    unchanged();
    if (phase === 'backoff') await tick(500);
    const replacement = Socket.instances.at(-1)!;
    assert.notEqual(replacement, old);
    await resume(replacement);
    const raised = settle(client.raiseHand()); await tick(100);
    const request = replacement.sent.find(message => message.type === 'hand:raise');
    if (request && 'requestId' in request) replacement.deliver({ type: 'ok', requestId: request.requestId });
    assert.equal(await raised, undefined, 'the offline attempt must not rate-limit the resumed participant');
    assert.equal(request?.type, 'hand:raise');
    assert.equal(client.handCooldownMs, 9900);
  });
}

it('retimes an admitted hand cooldown to the new hello limit after automatic same-seat resume', async t => {
  const { client, join, resume, tick } = setup(t, { reconnect: { initialDelayMs: 100, maxDelayMs: 100 } });
  const old = await join(2000);
  const peer = Peer.instances[0]!;
  const participantId = client.me?.participantId;
  // Let the initial media offer release control pacing before admitting the hand.
  await tick(100);
  const raised = settle(client.raiseHand()); await tick(0);
  const request = old.sent.at(-1)!; assert.equal(request.type, 'hand:raise');
  old.deliver({ type: 'ok', requestId: request.requestId });
  assert.equal(await raised, undefined);
  assert.equal(client.handCooldownMs, 2000);

  old.close();
  assert.equal(client.status, 'reconnecting');
  await tick(100);
  const replacement = Socket.instances.at(-1)!;
  assert.notEqual(replacement, old);
  await resume(replacement, 1200);
  assert.equal(client.me?.participantId, participantId);
  assert.equal(Peer.instances[0], peer);
  assert.notEqual(peer.connectionState, 'closed');
  assert.equal(client.rateLimits.handRaiseIntervalMs, 1200);
  assert.equal(client.handCooldownMs, 1100, 'the new interval retains the original hand admission time');
  assertError(await settle(client.raiseHand()), 'rate_limited');
  await tick(100);
  assert.equal(client.handCooldownMs, 1000);
  assert.equal(replacement.sent.filter(message => message.type === 'hand:raise').length, 0);
});

it('preserves cooldown priority over both a full control queue and a non-OPEN socket', async t => {
  const { client, connect } = setup(t, { maxPendingControlRequests: 1 });
  const socket = await connect(); void settle(client.raiseHand());
  assert.equal(client['pendingControlRequests'], 1);
  socket.readyState = Socket.CLOSING;
  const unchanged = observeAdmission(t, client);
  assertError(await settle(client.raiseHand()), 'rate_limited', '每次舉手需間隔 10 秒。');
  unchanged(); assert.equal(client.handCooldownMs, 10000);
});

it('preserves capacity priority over a non-OPEN socket without consuming hand cooldown', async t => {
  const { client, connect } = setup(t, { maxPendingControlRequests: 1 });
  const socket = await connect(); void settle(client.withdrawHand());
  assert.equal(client['pendingControlRequests'], 1);
  socket.readyState = Socket.CLOSING;
  const unchanged = observeAdmission(t, client);
  assertError(await settle(client.raiseHand()), 'queue_full', '待回覆控制請求已滿，請等待完成後再試。');
  unchanged(); assert.equal(client.handCooldownMs, 0);
});

it('still admits an OPEN reconnecting socket before hello and retains cooldown after server rejection', async t => {
  const { client, join, tick } = setup(t);
  const old = await join(); old.close(); await tick(500);
  const replacement = Socket.instances.at(-1)!;
  replacement.readyState = Socket.OPEN;
  assert.equal(client.status, 'reconnecting');
  const raised = settle(client.raiseHand());
  assert.equal(client.handCooldownMs, 10000);
  assert.equal(client['pendingControlRequests'], 1);
  await tick(0);
  const request = replacement.sent[0]!; assert.equal(request.type, 'hand:raise');
  replacement.deliver({ type: 'error', requestId: request.requestId, code: 'not_joined', message: '尚未加入房間。' });
  assertError(await raised, 'not_joined');
  assert.equal(client.handCooldownMs, 10000);
  hello(replacement); await flush(); await tick(100);
  const resume = replacement.sent[1]!; assert.equal(resume.type, 'join');
  replacement.deliver({ type: 'room:state', ...state });
  replacement.deliver({ type: 'ok', requestId: resume.requestId }); await flush();
  assert.equal(client.status, 'live');
  assert.equal(client.me?.participantId, state.me.participantId);
  assert.equal(client.handCooldownMs, 9900);
  assertError(await settle(client.raiseHand()), 'rate_limited');
});

for (const failure of ['send throws', 'closes before send', 'socket loss', 'timeout', 'server rejection'] as const) {
  it(`retains cooldown when an OPEN-admitted hand later ${failure}`, async t => {
    const { client, connect, tick } = setup(t, { requestTimeoutMs: 50 });
    const socket = await connect();
    const raised = settle(client.raiseHand());
    assert.equal(client.handCooldownMs, 10000);
    assert.equal(client['pendingControlRequests'], 1);
    if (failure === 'send throws') socket.failSend = true;
    if (failure === 'closes before send') socket.readyState = Socket.CLOSING;
    if (failure === 'socket loss') socket.close();
    await tick(0);
    if (failure === 'timeout') {
      await tick(49); assert.equal(client['pendingControlRequests'], 1); await tick(1);
    } else if (failure === 'server rejection') {
      const request = socket.sent[0]!; assert.equal(request.type, 'hand:raise');
      socket.deliver({ type: 'error', requestId: request.requestId, code: 'forbidden', message: '此操作未獲允許。' });
    }
    assertError(await raised, failure === 'timeout' ? 'timeout' : failure === 'server rejection' ? 'forbidden' : 'disconnected');
    assert.equal(client['pending'].size, 0);
    assert.equal(client['pendingControlRequests'], 0);
    assert.equal(client.handCooldownMs, failure === 'timeout' ? 9950 : 10000);
    assertError(await settle(client.raiseHand()), 'rate_limited');
  });
}
