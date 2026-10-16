import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it, type TestContext } from 'node:test';
import { StageClient, StageError, type StageClientOptions } from '../src/index.ts';
import type { RoomStatePayload } from '../../../shared/protocol.ts';

interface Request { type: string; requestId: string; roomId?: string; name?: string }
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  static failConstruction = false;
  readyState = 0;
  sent: Request[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    if (Socket.failConstruction) throw new Error('constructor failed');
    Socket.instances.push(this);
  }
  send(data: string) { this.sent.push(JSON.parse(data) as Request); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello(controlPerSecond = 20) {
    this.readyState = Socket.OPEN;
    this.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
  }
  // Native close() does not dispatch close until the handshake completes.
  close() { this.readyState = 2; }
  closed(deliver = true) { this.readyState = 3; if (deliver) this.onclose?.(); }
}
class Audio {
  isConnected = false;
  autoplay = false;
  hidden = false;
  volume = 1;
  muted = false;
  srcObject: unknown = null;
  pauses = 0;
  pause() { this.pauses++; }
  remove() { this.isConnected = false; }
}
class Peer {
  static instances: Peer[] = [];
  connectionState = 'connected';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  readonly transceiver = { direction: 'recvonly', sender: { track: null, replaceTrack: async () => {} } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\n' }; }
  async setLocalDescription(offer: RTCSessionDescriptionInit) { this.localDescription = offer; this.signalingState = 'have-local-offer'; }
  async setRemoteDescription(answer: RTCSessionDescriptionInit) { this.remoteDescription = answer; this.signalingState = 'stable'; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; this.signalingState = 'closed'; }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const observed = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const code = (expected: StageError['code']) => (error: unknown) => error instanceof StageError && error.code === expected;
function assertCode(error: unknown, expected: StageError['code']) { assert.ok(code(expected)(error), `${String(error)} should be ${expected}`); }
function snapshot(roomId = 'old-room', id = 'guest'): RoomStatePayload {
  return { roomId, name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', resumeToken: 'resume',
    me: { participantId: id, name: 'Guest', role: 'audience', onStage: false, handRaised: false,
      muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
function setup(t: TestContext, options: Partial<StageClientOptions> = {}, owned = true) {
  Socket.instances = []; Socket.failConstruction = false; Peer.instances = [];
  const target = new EventTarget(), audio = new Audio();
  audio.isConnected = !owned;
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: target, WebSocket: Socket, RTCPeerConnection: Peer,
    document: { createElement: () => audio, body: { append(element: Audio) { element.isConnected = true; } } } })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    reconnect: { initialDelayMs: 500, maxDelayMs: 1000 }, ...options,
    ...(owned ? {} : { audioElement: audio as unknown as HTMLAudioElement }) });
  const statuses: string[] = [], errors: StageError[] = [];
  client.on('status', event => statuses.push(event.detail));
  client.on('error', event => errors.push(event.detail));
  t.after(async () => {
    await client.disconnect(); await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  const tick = async (ms = 0) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const listeners = () => getEventListeners(target, 'pagehide').length;
  const ack = (socket: Socket, request: Request) => socket.deliver({ type: 'ok', requestId: request.requestId });
  async function entry(operation: 'join' | 'create' = 'join', roomId = 'old-room', supplied?: Promise<unknown>) {
    const promise = supplied ?? (operation === 'join' ? client.join({ roomId, name: 'Guest' }) : client.createRoom({ name: 'Host' }));
    const socket = Socket.instances.at(-1)!;
    if (socket.readyState !== Socket.OPEN) socket.hello();
    await flush(); await tick(0);
    const request = socket.sent.at(-1)!;
    assert.equal(request.type, operation === 'join' ? 'join' : 'room:create');
    if (operation === 'create') socket.deliver({ type: 'room:created', roomId, code: 'code' });
    ack(socket, request); await promise;
    socket.deliver({ type: 'status', state: 'live' });
    return socket;
  }
  async function media(socket: Socket, roomId = 'old-room', id = 'guest') {
    socket.deliver({ type: 'room:state', ...snapshot(roomId, id) }); await flush();
    if (client['negotiating']) {
      await tick(100);
      const offer = socket.sent.at(-1)!; assert.equal(offer.type, 'rtc:offer');
      ack(socket, offer); socket.deliver({ type: 'rtc:answer', payload: { type: 'answer', sdp: 'v=0\r\n' } }); await flush();
    }
  }
  function hide(socket: Socket) { target.dispatchEvent(new Event('pagehide')); assert.equal(socket.readyState, 2); }
  return { client, target, audio, tick, listeners, ack, entry, media, hide, statuses, errors };
}

for (const readyState of [2, 3]) it(`retires sent and paced requests before replacing an owned readyState=${readyState} socket`, async t => {
  const f = setup(t, { maxPendingControlRequests: 2 }), { client } = f;
  const old = await f.entry(); await f.tick(100);
  const sent = observed(client.setName('Already sent')); await f.tick();
  const queued = observed(client.setName('Never sent'));
  await assert.rejects(client.setName('Overflow'), code('queue_full'));
  const retired = [...client['pending'].values()];
  assert.equal(retired[0]!.sendTimer, undefined); assert.ok(retired[1]!.sendTimer);
  const clear = t.mock.method(globalThis, 'clearTimeout');
  f.hide(old); if (readyState === 3) old.closed(false);
  const connecting = client.connect(), replacement = Socket.instances[1]!;
  assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
  assert.deepEqual([client['nextControlAt'], client['nextIceAt'], client['lastSendAt']], [0, 0, 0]);
  for (const pending of retired) {
    assert.ok(clear.mock.calls.some(call => call.arguments[0] === pending.timer));
    if (pending.sendTimer) assert.ok(clear.mock.calls.some(call => call.arguments[0] === pending.sendTimer));
  }
  assert.equal(client['keepaliveTimer'], undefined); assert.equal(client.status, 'reconnecting');
  assert.equal(f.audio.isConnected, true); assert.equal(f.listeners(), 1);
  replacement.hello(); await connecting;
  assertCode(await sent, 'disconnected'); assertCode(await queued, 'disconnected');
  assert.equal(replacement.sent.length, 0, 'hello is not room entry');
  assert.equal(client.status, 'reconnecting');
  const timer = client['reconnectTimer']; assert.ok(timer);
  old.closed(); old.closed(); assert.equal(client['reconnectTimer'], timer);
  await f.tick(499); assert.equal(replacement.sent.length, 0);
  await f.tick(1); await f.tick();
  const resume = replacement.sent[0]!; assert.equal(resume.type, 'join'); f.ack(replacement, resume); await flush();
  assert.equal(client.status, 'reconnecting', 'resume ACK alone must not synthesize live');
  await f.media(replacement);
  const fresh = client.setName('Fresh'); await f.tick(100); f.ack(replacement, replacement.sent.at(-1)!); await fresh;
  await f.tick(1000);
  assert.equal(old.sent.filter(request => request.type === 'participant:rename').length, 1);
  assert.equal(replacement.sent.filter(request => request.type === 'join').length, 1);
  assert.equal(replacement.sent.some(request => request.name === 'Never sent'), false);
  assert.equal(client.status, 'live'); assert.equal(Socket.instances.length, 2);
});

for (const owned of [false, true]) it(`honors disconnect-only reentry without reattaching ${owned ? 'owned' : 'custom'} audio`, async t => {
  const f = setup(t, {}, owned), old = await f.entry();
  const off = f.client.on('status', event => { if (event.detail === 'reconnecting') { off(); void f.client.disconnect(); } });
  f.hide(old); await assert.rejects(f.client.connect(), code('disconnected'));
  assert.equal(f.client['intentional'], true); assert.equal(f.client['session'], null);
  assert.equal(f.client['socket'], null); assert.equal(f.client['connecting'], null);
  assert.equal(f.client['reconnectTimer'], undefined); assert.equal(f.listeners(), 0);
  assert.equal(f.audio.isConnected, !owned); await f.tick(5000);
  assert.equal(Socket.instances.length, 1); assert.deepEqual(f.statuses, ['live', 'reconnecting', 'disconnected']);
});

for (const operation of ['connect', 'join', 'create'] as const) {
  for (const owned of [false, true]) it(`preserves ${operation} started after callback cancellation with ${owned ? 'owned' : 'custom'} audio`, async t => {
    const f = setup(t, {}, owned), old = await f.entry();
    let fresh: Promise<unknown> | undefined;
    const off = f.client.on('status', event => {
      if (event.detail !== 'reconnecting') return;
      off(); void f.client.disconnect();
      fresh = operation === 'connect' ? f.client.connect() : operation === 'join'
        ? f.client.join({ roomId: 'new-room', name: 'Guest' }) : f.client.createRoom({ name: 'Host' });
    });
    f.hide(old); await assert.rejects(f.client.connect(), code('disconnected')); assert.ok(fresh);
    const replacement = Socket.instances[1]!; assert.equal(f.client['socket'], replacement);
    if (operation === 'connect') { replacement.hello(); await fresh; assert.equal(f.client['session'], null); }
    else { await f.entry(operation, 'new-room', fresh); assert.equal(f.client['session']!.roomId, 'new-room'); }
    old.closed(); old.deliver({ type: 'status', state: 'reconnecting' }); await f.tick(1000);
    assert.equal(Socket.instances.length, 2); assert.equal(f.client['socket'], replacement);
    assert.equal(f.client['reconnectTimer'], undefined); assert.equal(f.listeners(), 1); assert.equal(f.audio.isConnected, true);
    assert.equal(replacement.sent.filter(request => request.type === 'join').length, operation === 'join' ? 1 : 0);
  });
}

it('reuses the exact same-session callback handshake and schedules one automatic resume', async t => {
  const f = setup(t), old = await f.entry(); await f.media(old);
  const peer = f.client['pc'], session = f.client['session']; let nested: Promise<void> | undefined;
  const off = f.client.on('status', event => { if (event.detail === 'reconnecting') { off(); nested = f.client.connect(); } });
  f.hide(old); const outer = f.client.connect(); assert.equal(outer, nested);
  assert.equal(Socket.instances.length, 2); assert.equal(f.client['pc'], peer); assert.equal(f.listeners(), 1);
  const replacement = Socket.instances[1]!; replacement.hello(); await outer;
  assert.equal(f.client['session'], session); assert.equal(f.client.status, 'reconnecting');
  await f.tick(500); await f.tick(); f.ack(replacement, replacement.sent[0]!); await f.media(replacement);
  assert.equal(f.client['pc'], peer); assert.equal(Peer.instances.length, 1);
  assert.equal(replacement.sent.filter(request => request.type === 'join').length, 1);
  assert.equal(f.client['reconnectTimer'], undefined); assert.equal(f.audio.isConnected, true);
});

for (const operation of ['join', 'create'] as const) it(`lets explicit ${operation} cancel the predecessor resume before its timer`, async t => {
  const f = setup(t), old = await f.entry(); f.hide(old);
  const connected = f.client.connect(), replacement = Socket.instances[1]!; replacement.hello(); await connected;
  await f.entry(operation, 'new-room'); assert.equal(f.client['reconnectTimer'], undefined);
  await f.tick(500); old.closed();
  assert.equal(replacement.sent.some(request => request.type === 'join' && request.roomId === 'old-room'), false);
  replacement.closed(); await f.tick(1000);
  const resumed = Socket.instances[2]!; resumed.hello(); await flush(); await f.tick();
  const request = resumed.sent[0]!; assert.equal(request.type, 'join'); assert.equal(request.roomId, 'new-room');
  f.ack(resumed, request); await flush(); assert.equal(f.client['reconnectTimer'], undefined);
});

it('settles public audio retry and answer waits while retaining the healthy peer for authoritative resume', async t => {
  const f = setup(t), old = await f.entry(); await f.media(old); await f.tick(100);
  const peer = f.client['pc'], retry = observed(f.client.retryAudioConnection());
  await flush(); await f.tick(); const offer = old.sent.at(-1)!; assert.equal(offer.type, 'rtc:offer');
  f.ack(old, offer); await flush(); assert.ok(f.client['answerWait']); assert.ok(f.client['answerTimer']);
  f.hide(old); const connecting = f.client.connect(), replacement = Socket.instances[1]!;
  assertCode(await retry, 'disconnected'); await flush();
  assert.equal(f.client['answerWait'], null); assert.equal(f.client['answerTimer'], undefined);
  assert.equal(f.client['negotiating'], false); assert.equal(f.client['pc'], peer);
  replacement.hello(); await connecting; await f.tick(500); await f.tick();
  f.ack(replacement, replacement.sent[0]!); await f.media(replacement);
  assert.equal(f.client['pc'], peer); assert.equal(f.client['negotiating'], false); assert.equal(f.client.status, 'live');
  assert.equal(f.errors.filter(error => error.code === 'disconnected').length, 1);
});

it('clears RTC pending work and ICE pacing without charging it against caller capacity', async t => {
  const f = setup(t, { maxPendingControlRequests: 1 }), old = await f.entry(); await f.media(old); await f.tick(100);
  const control = observed(f.client.setName('Old control'));
  const peer = Peer.instances[0]!; peer.onicecandidate?.({ candidate: null }); peer.onicecandidate?.({ candidate: null });
  assert.equal(f.client['pending'].size, 3); assert.equal(f.client['pendingControlRequests'], 1);
  assert.ok(f.client['nextIceAt'] > performance.now()); await f.tick();
  f.hide(old); const connected = f.client.connect(), replacement = Socket.instances[1]!;
  assert.deepEqual([f.client['nextControlAt'], f.client['nextIceAt'], f.client['lastSendAt']], [0, 0, 0]);
  assert.equal(f.client['pending'].size, 0); assert.equal(f.client['pendingControlRequests'], 0);
  assertCode(await control, 'disconnected'); replacement.hello(); await connected;
  await f.tick(500); await f.tick(); f.ack(replacement, replacement.sent[0]!); await f.media(replacement);
  await f.tick(1000);
  assert.equal(old.sent.filter(request => request.type === 'rtc:ice').length, 1, 'the paced old candidate never sends');
  assert.equal(replacement.sent.some(request => request.type === 'rtc:ice'), false);
  assert.equal(f.client['pc'], peer); assert.equal(f.client.status, 'live');
});

it('ignores late retired hello, state, errors and close while replacement work is pending', async t => {
  const f = setup(t), old = await f.entry(); await f.media(old); f.hide(old);
  const connected = f.client.connect(), replacement = Socket.instances[1]!; replacement.hello(10); await connected;
  await f.tick(500); await f.tick(); f.ack(replacement, replacement.sent[0]!); await f.media(replacement);
  const state = f.client.state, session = f.client['session'], peer = f.client['pc'];
  const keepalive = f.client['keepaliveTimer']; const pending = f.client.setName('Current');
  const ids = [...f.client['pending'].keys()];
  old.hello(1); old.deliver({ type: 'room:state', ...snapshot('wrong-room', 'wrong-guest') });
  old.deliver({ type: 'error', code: 'unauthorized', message: 'old error', requestId: ids[0] });
  old.onerror?.(); old.closed(); await flush();
  assert.equal(f.client.state, state); assert.equal(f.client['session'], session); assert.equal(f.client['pc'], peer);
  assert.equal(f.client['keepaliveTimer'], keepalive); assert.equal(f.client.rateLimits.controlPerSecond, 10);
  assert.deepEqual([...f.client['pending'].keys()], ids); assert.equal(f.client.status, 'live');
  assert.equal(f.listeners(), 1); assert.equal(f.audio.isConnected, true); assert.deepEqual(f.errors, []);
  await f.tick(200); f.ack(replacement, replacement.sent.at(-1)!); await pending;
  assert.equal(replacement.sent.filter(request => request.type === 'join').length, 1);
});

it('retains session recovery when replacement construction throws', async t => {
  const f = setup(t), old = await f.entry(); f.hide(old); Socket.failConstruction = true;
  await assert.rejects(f.client.connect(), /constructor failed/); await flush();
  assert.equal(f.client['socket'], null); assert.equal(f.client['connecting'], null);
  assert.ok(f.client['reconnectTimer']); assert.equal(f.client.status, 'reconnecting');
  assert.equal(f.listeners(), 0); assert.equal(f.audio.isConnected, true);
  Socket.failConstruction = false; await f.tick(500);
  const replacement = Socket.instances[1]!; replacement.hello(); await flush(); await f.tick();
  f.ack(replacement, replacement.sent[0]!); await flush();
  assert.equal(f.client['reconnectTimer'], undefined); assert.equal(f.listeners(), 1);
});

for (const failure of ['hello timeout', 'hello error', 'transient resume', 'terminal resume'] as const) {
  it(`keeps the established retry policy after replacement ${failure}`, async t => {
    const f = setup(t), old = await f.entry(); f.hide(old);
    const connection = observed(f.client.connect()), replacement = Socket.instances[1]!;
    if (failure === 'hello timeout' || failure === 'hello error') {
      await f.tick(500);
      if (failure === 'hello timeout') await f.tick(500);
      else { replacement.onerror?.(); await flush(); }
      assertCode(await connection, failure === 'hello timeout' ? 'timeout' : 'disconnected');
    } else {
      replacement.hello(); await connection; await f.tick(500); await f.tick();
      const request = replacement.sent[0]!; assert.equal(request.type, 'join');
      replacement.deliver({ type: 'error', requestId: request.requestId,
        code: failure === 'terminal resume' ? 'unauthorized' : 'internal', message: 'resume failed' }); await flush();
    }
    if (failure === 'terminal resume') {
      assert.equal(f.client['session'], null); assert.equal(f.client.status, 'disconnected');
      assert.equal(f.client['reconnectTimer'], undefined); await f.tick(3000); assert.equal(Socket.instances.length, 2);
    } else {
      assert.ok(f.client['session']); assert.ok(f.client['reconnectTimer']); assert.equal(f.client['connecting'], null);
      await f.tick(999); assert.equal(Socket.instances.length, 2); await f.tick(1);
      const recovered = Socket.instances[2]!; recovered.hello(); await flush(); await f.tick();
      const request = recovered.sent[0]!; assert.equal(request.type, 'join'); f.ack(recovered, request); await flush();
      replacement.closed(); old.closed();
      assert.equal(f.client['socket'], recovered); assert.equal(f.client['reconnectTimer'], undefined);
      assert.equal(recovered.sent.filter(message => message.type === 'join').length, 1);
    }
  });
}

it('does not invent resume intent from an initial snapshot before its join ACK', async t => {
  const f = setup(t), joining = observed(f.client.join({ roomId: 'old-room', name: 'Guest' }));
  const old = Socket.instances[0]!; old.hello(); await flush(); await f.tick();
  const request = old.sent[0]!; old.deliver({ type: 'room:state', ...snapshot() }); await flush();
  assert.equal(f.client['session'], null); assert.equal(f.client.status, 'live'); assert.ok(f.client['pc']);
  f.hide(old); const connected = f.client.connect(), replacement = Socket.instances[1]!;
  replacement.hello(); await connected; assertCode(await joining, 'disconnected');
  old.deliver({ type: 'ok', requestId: request.requestId }); old.closed(); await flush();
  assert.equal(f.client['session'], null); assert.equal(f.client['pc'], null); assert.equal(f.client.status, 'disconnected');
  assert.equal(f.client['reconnectTimer'], undefined); assert.ok(f.client.state, 'retained snapshot remains historical');
  await f.tick(1000); assert.equal(replacement.sent.length, 0);
  await f.entry('join', 'new-room'); assert.equal(f.client['session']!.roomId, 'new-room');
});

it('preserves initial CONNECTING, OPEN and explicit-disconnect hello-only contracts', async t => {
  const f = setup(t), initial = f.client.connect(), old = Socket.instances[0]!;
  assert.equal(old.readyState, 0); assert.equal(f.client.connect(), initial); assert.equal(Socket.instances.length, 1);
  old.hello(); await initial; await f.client.connect(); await f.client.connect();
  assert.equal(Socket.instances.length, 1); assert.equal(f.client['session'], null); assert.equal(old.sent.length, 0);
  assert.deepEqual(f.statuses, []); assert.equal(f.listeners(), 1);
  await f.entry(); const keepalive = f.client['keepaliveTimer'];
  await f.client.connect(); assert.equal(f.client['keepaliveTimer'], keepalive); assert.deepEqual(f.statuses, ['live']);
  await f.client.disconnect(); assert.equal(f.client['reconnectTimer'], undefined); assert.equal(f.listeners(), 0);
  const next = f.client.connect(), replacement = Socket.instances[1]!; replacement.hello(); await next;
  old.closed(); await f.tick(1000);
  assert.equal(replacement.sent.length, 0); assert.equal(f.client['session'], null); assert.equal(f.client.status, 'disconnected');
});

it('keeps an unjoined closing replacement transport-only and retires its old control', async t => {
  const f = setup(t), first = f.client.connect(), old = Socket.instances[0]!; old.hello(); await first;
  const retired = observed(f.client.setName('Unjoined control')); await f.tick();
  f.hide(old); const next = f.client.connect(), replacement = Socket.instances[1]!;
  assertCode(await retired, 'disconnected'); replacement.hello(); await next; old.closed(); await f.tick(1000);
  assert.equal(f.client['session'], null); assert.equal(f.client['reconnectTimer'], undefined);
  assert.equal(f.client['pending'].size, 0); assert.equal(f.client['pendingControlRequests'], 0);
  assert.equal(replacement.sent.length, 0); assert.equal(f.client.status, 'disconnected');
  assert.equal(f.listeners(), 1); assert.equal(f.audio.isConnected, true); assert.deepEqual(f.statuses, []);
  await f.entry('join', 'new-room'); assert.equal(f.client['session']!.roomId, 'new-room');
});

it('continues sharing an active hello promise even if its initial transport starts closing', async t => {
  const f = setup(t), connecting = f.client.connect(), outcome = observed(connecting), old = Socket.instances[0]!;
  f.hide(old); assert.equal(f.client.connect(), connecting); assert.equal(Socket.instances.length, 1);
  old.closed(); assertCode(await outcome, 'disconnected'); await flush();
  assert.equal(f.client['connecting'], null); assert.equal(f.client['reconnectTimer'], undefined);
  assert.equal(f.listeners(), 0); assert.equal(f.audio.isConnected, false);
});
