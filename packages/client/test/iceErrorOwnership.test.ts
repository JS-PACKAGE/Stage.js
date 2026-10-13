import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, type StageError } from '../src/index.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let n = 0; n < 24; n++) await Promise.resolve(); };
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string) {
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    if (message.type === 'join' || message.type === 'rtc:offer') queueMicrotask(() => {
      this.deliver({ type: 'ok', requestId: message.requestId });
      if (message.type === 'rtc:offer') this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
    });
  }
  deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
interface IceOperation {
  candidate: RTCIceCandidateInit | undefined;
  resolve: (value: void) => void;
  reject: (error: unknown) => void;
}
/** Deferred browser ICE operations exercise SDK ownership without native WebRTC or network I/O. */
class Peer {
  static instances: Peer[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  readonly ice: IceOperation[] = [];
  readonly transceiver = { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null, async replaceTrack(track: MediaStreamTrack | null) { this.track = track; } } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'v=0\r\n' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; this.signalingState = 'have-local-offer'; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    assert.equal(this.signalingState, 'have-local-offer');
    this.remoteDescription = description; this.signalingState = 'stable';
  }
  addIceCandidate(candidate?: RTCIceCandidateInit) {
    const operation = deferred<void>();
    this.ice.push({ candidate, resolve: operation.resolve, reject: operation.reject });
    return operation.promise;
  }
  close() { this.connectionState = 'closed'; }
}
function state(id: string): RoomStatePayload {
  return { roomId: 'room', name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
    me: { participantId: id, name: id, role: 'audience', onStage: false, handRaised: false,
      muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
const hello = (socket: Socket) => socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
  limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
const candidate = { candidate: 'candidate:0', sdpMid: '0', sdpMLineIndex: 0 };
function localIce(peer: Peer) {
  assert.ok(peer.onicecandidate);
  peer.onicecandidate({ candidate: { toJSON: () => candidate } });
}
function incomingIce(socket: Socket, peer: Peer): IceOperation {
  const count = peer.ice.length;
  socket.deliver({ type: 'rtc:ice', fromId: 'server', payload: candidate });
  assert.equal(peer.ice.length, count + 1, 'the answered peer applies this candidate immediately');
  const operation = peer.ice.at(-1)!;
  assert.deepEqual(operation.candidate, candidate);
  return operation;
}
async function fixture(t: TestContext) {
  Socket.instances = []; Peer.instances = [];
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await settle(); };
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 5000,
    reconnect: { initialDelayMs: 500, maxDelayMs: 2000 },
    audioElement: { pause() {} } as unknown as HTMLAudioElement });
  const errors: { code: StageError['code']; message: string; id: string | null; status: StageClient['status'] }[] = [];
  client.on('error', ({ detail }) => errors.push({ code: detail.code, message: detail.message,
    id: client.me?.participantId ?? null, status: client.status }));
  t.after(async () => {
    await client.disconnect();
    for (const peer of Peer.instances) for (const operation of peer.ice) operation.reject(new Error('test cleanup'));
    await settle();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const connected = client.connect();
  const socket = Socket.instances[0]!;
  hello(socket); await connected;
  const joined = client.join({ roomId: 'room', name: 'Guest' });
  await settle(); await tick(0); await joined;
  async function enter(id: string, current = socket) {
    current.deliver({ type: 'room:state', ...state(id) });
    await settle(); await tick(100);
    const peer = Peer.instances.at(-1)!;
    assert.ok(peer.remoteDescription);
    assert.equal(peer.signalingState, 'stable');
    assert.equal(client.me?.participantId, id);
    assert.equal(client.status, 'live');
    return peer;
  }
  const peer = await enter('first');
  assert.deepEqual(errors, []);
  return { client, socket, peer, errors, tick, enter };
}

for (const sent of [false, true]) {
  it(`does not report a ${sent ? 'sent' : 'queued'} local ICE request cancellation after disconnect`, async t => {
    const { client, socket, peer, errors, tick } = await fixture(t);
    localIce(peer);
    if (sent) await tick(0);
    assert.equal(socket.sent.filter(message => message.type === 'rtc:ice').length, Number(sent));
    await client.disconnect(); await settle(); await tick(5000);
    assert.equal(peer.connectionState, 'closed');
    assert.equal(client.status, 'disconnected');
    assert.deepEqual(errors, []);
    assert.equal(socket.sent.filter(message => message.type === 'rtc:ice').length, Number(sent));
  });
}

for (const retirement of ['disconnect', 'replacement'] as const) {
  it(`does not report an inbound ICE rejection after peer ${retirement}`, async t => {
    const { client, socket, peer, errors, enter } = await fixture(t);
    const operation = incomingIce(socket, peer);
    if (retirement === 'disconnect') await client.disconnect();
    else assert.notEqual(await enter('replacement'), peer);
    assert.equal(peer.connectionState, 'closed');
    operation.reject(new Error('retired candidate failed')); await settle();
    assert.deepEqual(errors, []);
    assert.equal(client.me?.participantId ?? null, retirement === 'disconnect' ? null : 'replacement');
  });
}

it('reports a current inbound ICE failure exactly once', async t => {
  const { socket, peer, errors } = await fixture(t);
  incomingIce(socket, peer).reject(new Error('current candidate failed')); await settle();
  assert.deepEqual(errors, [{ code: 'media_error', message: 'current candidate failed', id: 'first', status: 'live' }]);
});

it('reports a current inbound ICE failure before a queued identity replacement', async t => {
  const { client, socket, peer, errors, tick } = await fixture(t);
  incomingIce(socket, peer).reject(new Error('current candidate failed'));
  // A second async reporting hop would let this replacement steal the first peer's error.
  queueMicrotask(() => socket.deliver({ type: 'room:state', ...state('replacement') }));
  await settle(); await tick(100);
  assert.equal(client.me?.participantId, 'replacement');
  assert.equal(peer.connectionState, 'closed');
  assert.deepEqual(errors, [{ code: 'media_error', message: 'current candidate failed', id: 'first', status: 'live' }]);
});

it('allows an inbound error listener to disconnect without another error', async t => {
  const { client, socket, peer, errors } = await fixture(t);
  client.on('error', () => { void client.disconnect(); });
  incomingIce(socket, peer).reject(new Error('current candidate failed')); await settle();
  assert.equal(client.status, 'disconnected');
  assert.equal(peer.connectionState, 'closed');
  assert.deepEqual(errors, [{ code: 'media_error', message: 'current candidate failed', id: 'first', status: 'live' }]);
});

it('still reports pending inbound ICE failure after socket resume preserves its peer', async t => {
  const { client, socket, peer, errors, tick, enter } = await fixture(t);
  const operation = incomingIce(socket, peer);
  socket.close(); await tick(500);
  const resumed = Socket.instances.at(-1)!;
  assert.notEqual(resumed, socket);
  hello(resumed); await settle(); await tick(0);
  assert.equal(resumed.sent.filter(message => message.type === 'join').length, 1);
  assert.equal(await enter('first', resumed), peer);
  assert.equal(Peer.instances.length, 1);
  operation.reject(new Error('resumed candidate failed')); await settle();
  assert.equal(client.status, 'live');
  assert.deepEqual(errors, [{ code: 'media_error', message: 'resumed candidate failed', id: 'first', status: 'live' }]);
});

it('still reports a sent local ICE cancellation when socket loss preserves its peer', async t => {
  const { socket, peer, errors, tick } = await fixture(t);
  localIce(peer); await tick(0);
  assert.equal(socket.sent.filter(message => message.type === 'rtc:ice').length, 1);
  socket.close(); await settle();
  assert.notEqual(peer.connectionState, 'closed');
  assert.deepEqual(errors.map(({ code, id, status }) => ({ code, id, status })),
    [{ code: 'disconnected', id: 'first', status: 'reconnecting' }]);
});

for (const listener of ['none', 'disconnect', 'replacement'] as const) {
  it(`preserves server ICE error delivery with ${listener === 'none' ? 'no retiring' : `a ${listener}`} listener`, async t => {
    const { client, socket, peer, errors, tick } = await fixture(t);
    localIce(peer); await tick(0);
    const request = socket.sent.find(message => message.type === 'rtc:ice');
    assert.ok(request && request.type === 'rtc:ice');
    client.on('error', () => {
      if (errors.length !== 1) return;
      if (listener === 'disconnect') void client.disconnect();
      else if (listener === 'replacement') socket.deliver({ type: 'room:state', ...state('replacement') });
    });
    socket.deliver({ type: 'error', requestId: request.requestId, code: 'bad_request', message: 'server candidate error' });
    assert.equal(errors.length, 1, 'the server error event remains synchronous');
    await settle(); await tick(100);
    const expected = { code: 'bad_request', message: 'server candidate error', id: 'first', status: 'live' };
    assert.deepEqual(errors, listener === 'none' ? [expected, expected] : [expected]);
    assert.equal(client.me?.participantId ?? null, listener === 'disconnect' ? null : listener === 'replacement' ? 'replacement' : 'first');
  });
}
