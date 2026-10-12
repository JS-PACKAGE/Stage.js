import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import { StageClient, StageError, type StageClientOptions } from '../src/index.ts';
import type { RoomStatePayload } from '../../../shared/protocol.ts';

interface RequestMessage { type: string; requestId: string; roomId?: string }
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: RequestMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as RequestMessage); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

class Peer {
  static instances: Peer[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  constructor() { Peer.instances.push(this); }
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null, async replaceTrack(track: MediaStreamTrack | null) { this.track = track; } } };
  }
  async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\n' }; }
  async setLocalDescription(offer: RTCSessionDescriptionInit) { this.localDescription = offer; }
  async setRemoteDescription(_answer: RTCSessionDescriptionInit) {}
  close() { this.connectionState = 'closed'; }
}

const state: RoomStatePayload = {
  roomId: 'room', name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
  codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
  me: { participantId: 'guest', name: 'Guest', role: 'audience', onStage: false, handRaised: false,
    muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 },
};

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const settle = (request: Promise<unknown>): Promise<unknown> => request.then(() => undefined, (error: unknown) => error);
const hello = (socket: Socket) => socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
function assertError(error: unknown, code: StageError['code']): void {
  assert.ok(error instanceof StageError);
  assert.equal(error.code, code);
}

describe('client request capacity', () => {
  const clients: StageClient[] = [];
  let originals: Map<string, PropertyDescriptor | undefined>;
  let now: number;
  beforeEach(t => {
    assert.ok('mock' in t);
    Socket.instances = []; Peer.instances = []; now = 1000;
    originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    t.mock.method(performance, 'now', () => now);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.disconnect();
    await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  function make(options: Partial<StageClientOptions> = {}): StageClient {
    const client = new StageClient({ url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement, ...options });
    clients.push(client); return client;
  }
  async function connect(client: StageClient): Promise<Socket> {
    const ready = client.connect();
    const socket = Socket.instances.at(-1)!;
    hello(socket); await ready; return socket;
  }
  function tick(t: TestContext, milliseconds: number): void {
    now += milliseconds;
    t.mock.timers.tick(milliseconds);
  }

  it('requires a positive safe integer before mutating supplied audio', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
      const audio = { autoplay: false } as HTMLAudioElement;
      assert.throws(() => new StageClient({ url: 'ws://localhost/ws', audioElement: audio, maxPendingControlRequests: value as number }), RangeError);
      assert.equal(audio.autoplay, false);
    }
    make({ maxPendingControlRequests: 1 });
    make({ maxPendingControlRequests: Number.MAX_SAFE_INTEGER });
  });

  it('preserves unlimited pending requests when the option is omitted', async t => {
    const client = make(), socket = await connect(client);
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const requests = Array.from({ length: 1000 }, () => settle(client.rotateCode()));
    assert.equal(client['pending'].size, 1000);
    assert.equal(scheduled.mock.calls.length, 2000);
    await client.disconnect();
    for (const error of await Promise.all(requests)) assertError(error, 'disconnected');
    tick(t, 200000);
    assert.equal(socket.sent.length, 0);
    assert.equal(client['pending'].size, 0);
  });

  it('admits only the cap during a 1000-request burst, counting unsent and unacknowledged controls', async t => {
    const cap = 3, client = make({ maxPendingControlRequests: cap }), socket = await connect(client);
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const uuid = t.mock.method(crypto, 'randomUUID');
    const requests = Array.from({ length: 1000 }, () => {
      const request = settle(client.rotateCode());
      assert.ok(client['pendingControlRequests'] <= cap);
      return request;
    });
    assert.equal(client['pending'].size, cap);
    assert.equal(client['pendingControlRequests'], cap);
    assert.equal(uuid.mock.calls.length, cap);
    assert.equal(scheduled.mock.calls.length, cap * 2);
    for (const error of await Promise.all(requests.slice(cap))) assertError(error, 'queue_full');
    tick(t, 0);
    assert.equal(socket.sent.length, 1);
    assert.equal(client['pendingControlRequests'], cap, 'sending does not release acknowledgement capacity');
    assertError(await settle(client.rotateCode()), 'queue_full');
    assert.equal(uuid.mock.calls.length, cap);
    assert.equal(scheduled.mock.calls.length, cap * 2);
    await client.disconnect();
    for (const error of await Promise.all(requests.slice(0, cap))) assertError(error, 'disconnected');
    tick(t, 200000);
    assert.equal(socket.sent.length, 1);
    assert.equal(client['pendingControlRequests'], 0);
  });

  it('rejects all public control families without changing their pacing or allocating work', async t => {
    const client = make({ maxPendingControlRequests: 1 }), socket = await connect(client);
    client['snapshot'] = { ...state, me: { ...state.me, role: 'controller' } };
    const occupied = settle(client.rotateCode());
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const uuid = t.mock.method(crypto, 'randomUUID');
    const pacing = [client['nextControlAt'], client['nextIceAt'], client['lastSendAt']];
    const controls: (() => Promise<unknown>)[] = [
      () => client.createRoom({ name: 'Host' }), () => client.join({ roomId: 'other', name: 'Guest' }),
      () => client.raiseHand(), () => client.withdrawHand(), () => client.approve('guest'),
      () => client.reject('guest'), () => client.leaveStage(), () => client.returnToStage(),
      () => client.transferControl('guest'), () => client.mute(), () => client.unmute(),
      () => client.forceMute('guest'), () => client.forceUnmute('guest'), () => client.removeFromStage('guest'),
      () => client.kick('guest'), () => client.setGain('guest', 1), () => client.rotateCode(), () => client.closeRoom(),
    ];
    for (const control of controls) assertError(await settle(control()), 'queue_full');
    assert.deepEqual([client['nextControlAt'], client['nextIceAt'], client['lastSendAt']], pacing);
    assert.equal(uuid.mock.calls.length, 0);
    assert.equal(scheduled.mock.calls.length, 0);
    assert.equal(client['pendingControlRequests'], 1);
    tick(t, 0);
    socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId }); await occupied;
    const next = settle(client.rotateCode());
    tick(t, 99); assert.equal(socket.sent.length, 1);
    tick(t, 1); assert.equal(socket.sent.length, 2, 'rejected controls must not reserve future send slots');
    socket.deliver({ type: 'ok', requestId: socket.sent[1]!.requestId });
    assert.equal(await next, undefined);
  });

  for (const reply of ['ok', 'error'] as const) it(`restores capacity after a server ${reply} without double-releasing duplicate acknowledgements`, async t => {
    const client = make({ maxPendingControlRequests: 1 }), socket = await connect(client);
    const first = settle(client.rotateCode()); tick(t, 0);
    const oldId = socket.sent[0]!.requestId;
    if (reply === 'ok') socket.deliver({ type: 'ok', requestId: oldId });
    else socket.deliver({ type: 'error', requestId: oldId, code: 'forbidden', message: 'rejected' });
    if (reply === 'ok') assert.equal(await first, undefined);
    else assertError(await first, 'forbidden');
    assert.equal(client['pendingControlRequests'], 0);
    const next = settle(client.rotateCode());
    socket.deliver({ type: 'ok', requestId: oldId });
    socket.deliver({ type: 'ok', requestId: 'unknown' });
    assert.equal(client['pendingControlRequests'], 1);
    assertError(await settle(client.rotateCode()), 'queue_full');
    tick(t, 100);
    socket.deliver({ type: 'ok', requestId: socket.sent[1]!.requestId });
    assert.equal(await next, undefined);
    assert.equal(client['pendingControlRequests'], 0);
  });

  it('restores capacity after the acknowledgement timeout', async t => {
    const client = make({ maxPendingControlRequests: 1, requestTimeoutMs: 50 }), socket = await connect(client);
    const first = settle(client.rotateCode());
    tick(t, 0); tick(t, 49);
    assert.equal(client['pendingControlRequests'], 1);
    assertError(await settle(client.rotateCode()), 'queue_full');
    tick(t, 1); assertError(await first, 'timeout');
    assert.equal(client['pendingControlRequests'], 0);
    const next = settle(client.rotateCode());
    assert.equal(client['pendingControlRequests'], 1);
    tick(t, 50);
    socket.deliver({ type: 'ok', requestId: socket.sent[1]!.requestId });
    assert.equal(await next, undefined);
  });

  for (const failure of ['send', 'serialization'] as const) it(`restores capacity after a synchronous ${failure} failure`, async t => {
    const client = make({ maxPendingControlRequests: 1 }), socket = await connect(client);
    if (failure === 'send') socket.send = () => { throw new Error('send failed'); };
    const failed = settle(failure === 'send' ? client.rotateCode() : client.setGain('guest', 1n as unknown as number));
    assert.doesNotThrow(() => tick(t, 0));
    assertError(await failed, 'disconnected');
    assert.equal(client['pending'].size, 0);
    assert.equal(client['pendingControlRequests'], 0);
    socket.send = Socket.prototype.send;
    const next = settle(client.rotateCode()); tick(t, 100);
    socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId });
    assert.equal(await next, undefined);
  });

  for (const remote of [false, true]) it(`restores capacity after ${remote ? 'socket loss' : 'disconnect'} and permits immediate reuse`, async t => {
    const client = make({ maxPendingControlRequests: 2 }), socket = await connect(client);
    const pending = [settle(client.rotateCode()), settle(client.rotateCode())];
    tick(t, 0);
    const oldId = socket.sent[0]!.requestId;
    if (remote) socket.close(); else await client.disconnect();
    for (const error of await Promise.all(pending)) assertError(error, 'disconnected');
    assert.equal(client['pendingControlRequests'], 0);
    const replacement = await connect(client), fresh = settle(client.rotateCode());
    replacement.deliver({ type: 'ok', requestId: oldId });
    assert.equal(client['pendingControlRequests'], 1);
    tick(t, 0);
    assert.equal(replacement.sent.length, 1, 'old pacing does not delay the reused client');
    replacement.deliver({ type: 'ok', requestId: replacement.sent[0]!.requestId });
    assert.equal(await fresh, undefined);
    tick(t, 1000);
    assert.equal(socket.sent.length, 1, 'cancelled queued controls never reach the retired socket');
    assert.equal(client['pendingControlRequests'], 0);
  });

  it('does not consume the hand cooldown when admission fails', async t => {
    const client = make({ maxPendingControlRequests: 1 }), socket = await connect(client);
    const occupied = settle(client.rotateCode());
    assert.equal(client.handCooldownMs, 0);
    assertError(await settle(client.raiseHand()), 'queue_full');
    assert.equal(client.handCooldownMs, 0);
    tick(t, 0); socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId }); await occupied;
    const raised = settle(client.raiseHand());
    assert.equal(client.handCooldownMs, 10000);
    tick(t, 100);
    assert.equal(socket.sent[1]!.type, 'hand:raise');
    socket.deliver({ type: 'ok', requestId: socket.sent[1]!.requestId });
    assert.equal(await raised, undefined);
    assertError(await settle(client.raiseHand()), 'rate_limited');
    assert.equal(client['pendingControlRequests'], 0);
  });

  it('preserves an in-flight create result when a second create is rejected', async t => {
    const client = make({ maxPendingControlRequests: 1 });
    const first = client.createRoom({ name: 'Host' });
    const result = settle(first), socket = Socket.instances.at(-1)!;
    hello(socket); await flush(); tick(t, 0);
    socket.deliver({ type: 'room:created', roomId: 'room', code: 'test-code' });
    const created = client['created']; assert.ok(created);
    assertError(await settle(client.createRoom({ name: 'Other' })), 'queue_full');
    assert.equal(client['created'], created);
    socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId });
    assert.equal(await result, undefined);
    assert.deepEqual(await first, { roomId: 'room', code: 'test-code' });
    assert.equal(client['pendingControlRequests'], 0);
  });

  it('keeps the prior session, socket and connection intent when a public join is rejected', async t => {
    const client = make({ maxPendingControlRequests: 1 });
    const joining = settle(client.join({ roomId: 'room', name: 'Guest' })), socket = Socket.instances.at(-1)!;
    hello(socket); await flush(); tick(t, 0);
    socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId }); await joining;
    const occupied = settle(client.rotateCode());
    const session = client['session'], intentional = client['intentional'];
    const connects = t.mock.method(client, 'connect');
    assertError(await settle(client.join({ roomId: 'other', name: 'Other' })), 'queue_full');
    assert.equal(client['session'], session);
    assert.equal(client['socket'], socket);
    assert.equal(client['intentional'], intentional);
    assert.equal(socket.readyState, Socket.OPEN);
    assert.equal(connects.mock.calls.length, 0);
    assert.equal(Socket.instances.length, 1);
    tick(t, 100);
    socket.deliver({ type: 'ok', requestId: socket.sent[1]!.requestId });
    assert.equal(await occupied, undefined);
  });

  it('rechecks capacity after simultaneous public joins finish the same hello', async t => {
    const client = make({ maxPendingControlRequests: 1 });
    const first = settle(client.join({ roomId: 'room', name: 'Guest' }));
    const second = settle(client.join({ roomId: 'other', name: 'Other' }));
    assert.equal(Socket.instances.length, 1);
    const socket = Socket.instances[0]!;
    hello(socket); await flush();
    assertError(await second, 'queue_full');
    assert.equal(client['pendingControlRequests'], 1);
    tick(t, 0);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0]!.roomId, 'room');
    socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId });
    assert.equal(await first, undefined);
    assert.equal(client['session']!.roomId, 'room');
  });

  it('rejects the second simultaneous create after hello before clearing the admitted result', async t => {
    const client = make({ maxPendingControlRequests: 1 });
    let created = client['created'];
    const writes: unknown[] = [];
    Object.defineProperty(client, 'created', {
      configurable: true,
      get: () => created,
      set(value: typeof created) { writes.push(value); created = value; },
    });
    const creating = client.createRoom({ name: 'Host' }), first = settle(creating);
    const second = settle(client.createRoom({ name: 'Other' }));
    assert.equal(Socket.instances.length, 1);
    const socket = Socket.instances[0]!;
    hello(socket); await flush();
    assertError(await second, 'queue_full');
    assert.deepEqual(writes, [null], 'only the admitted caller may reset its room-creation result');
    assert.equal(client['pendingControlRequests'], 1);
    assert.equal(client['session'], null);
    tick(t, 0);
    assert.equal(socket.sent.length, 1);
    socket.deliver({ type: 'room:created', roomId: 'room', code: 'test-code' });
    socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId });
    assert.equal(await first, undefined);
    assert.deepEqual(await creating, { roomId: 'room', code: 'test-code' });
    assert.equal(client['session']!.roomId, 'room');
    assert.equal(client['session']!.name, 'Host');
    assert.equal(client['pendingControlRequests'], 0);
  });

  it('counts public joins while initial hello, state-triggered SDP and ICE remain exempt', async t => {
    const client = make({ maxPendingControlRequests: 1 });
    const errors: StageError[] = []; client.on('error', event => errors.push(event.detail));
    const joining = settle(client.join({ roomId: 'room', name: 'Guest' })), socket = Socket.instances.at(-1)!;
    assert.equal(client['pendingControlRequests'], 0, 'initial hello has its own deadline');
    assert.equal(client['pending'].size, 0);
    hello(socket); await flush(); tick(t, 0);
    assert.equal(socket.sent[0]!.type, 'join');
    assert.equal(client['pendingControlRequests'], 1);
    assertError(await settle(client.join({ roomId: 'other', name: 'Guest' })), 'queue_full');
    socket.deliver({ type: 'room:state', ...state }); await flush();
    assert.equal(client['pending'].size, 2, 'the unacknowledged join does not reject the first SDP offer');
    assert.equal(client['pendingControlRequests'], 1);
    Peer.instances[0]!.onicecandidate?.({ candidate: null });
    assert.equal(client['pending'].size, 3);
    tick(t, 100); await flush();
    assert.deepEqual(socket.sent.map(message => message.type), ['join', 'rtc:offer', 'rtc:ice']);
    for (const message of socket.sent.slice(1)) socket.deliver({ type: 'ok', requestId: message.requestId });
    socket.deliver({ type: 'rtc:answer', payload: { type: 'answer', sdp: 'v=0\r\n' } }); await flush();
    assert.equal(client['pendingControlRequests'], 1, 'internal acknowledgements never release a caller slot');
    assertError(await settle(client.rotateCode()), 'queue_full');
    assert.equal(client['answerWait'], null);
    assert.equal(client['answerTimer'], undefined);
    assert.equal(client['negotiating'], false);
    socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId });
    assert.equal(await joining, undefined);
    assert.equal(client['pending'].size, 0);
    assert.equal(client['pendingControlRequests'], 0);
    assert.deepEqual(errors, []);
  });

  it('admits automatic resume even when callers fill the control capacity before hello', async t => {
    const client = make({ maxPendingControlRequests: 1, reconnect: { initialDelayMs: 500, maxDelayMs: 500 } });
    const errors: StageError[] = []; client.on('error', event => errors.push(event.detail));
    const joining = settle(client.join({ roomId: 'room', name: 'Guest' })), socket = Socket.instances.at(-1)!;
    hello(socket); await flush(); tick(t, 0);
    socket.deliver({ type: 'ok', requestId: socket.sent[0]!.requestId }); await joining;
    socket.close(); tick(t, 500);
    const replacement = Socket.instances.at(-1)!;
    assert.notEqual(replacement, socket);
    const occupied = settle(client.rotateCode());
    assert.equal(client['pendingControlRequests'], 1);
    hello(replacement); await flush();
    assert.equal(client['pending'].size, 2);
    assert.equal(client['pendingControlRequests'], 1);
    tick(t, 0); tick(t, 100);
    assert.deepEqual(replacement.sent.map(message => message.type), ['room:rotate-code', 'join']);
    assert.equal(replacement.sent[1]!.roomId, 'room');
    replacement.deliver({ type: 'ok', requestId: replacement.sent[1]!.requestId }); await flush();
    assert.equal(client['pendingControlRequests'], 1);
    assertError(await settle(client.rotateCode()), 'queue_full');
    replacement.deliver({ type: 'ok', requestId: replacement.sent[0]!.requestId });
    assert.equal(await occupied, undefined);
    assert.equal(client['pendingControlRequests'], 0);
    assert.equal(client['pending'].size, 0);
    assert.equal(client['reconnectTimer'], undefined);
    assert.deepEqual(errors, []);
  });
});
