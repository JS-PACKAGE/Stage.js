import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, type StageError } from '../src/index.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as ClientMessage); }
  deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
interface Operation { name: string; complete: () => void; reject: (error: unknown) => void }
/** FIFO completion prevents a new offer from overtaking a held SDP or ICE operation.
 * These are fake media/socket operations, not native WebRTC or audio validation. */
class Peer {
  static instances: Peer[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState = 'stable';
  connectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  readonly operations: Operation[] = [];
  readonly trace: string[] = [];
  readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown, async replaceTrack(track: unknown) { this.track = track; } } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  private enqueue<T>(name: string, apply: () => T): Promise<T> {
    const result = deferred<T>();
    this.operations.push({ name, complete: () => result.resolve(apply()), reject: result.reject });
    this.trace.push(`queued ${name}`);
    return result.promise;
  }
  complete(name: string, error?: Error) {
    const operation = this.operations.shift();
    assert.ok(operation, `expected ${name}; trace: ${this.trace.join(', ')}`);
    assert.equal(operation.name, name, 'SDP and ICE operations must complete FIFO');
    this.trace.push(`${error ? 'rejected' : 'completed'} ${name}`);
    if (error) operation.reject(error); else operation.complete();
  }
  createOffer() { return this.enqueue('createOffer', () => ({ type: 'offer' as const, sdp: 'v=0\r\n' })); }
  setLocalDescription(description: RTCSessionDescriptionInit) {
    return this.enqueue('setLocalDescription', () => { this.localDescription = description; this.signalingState = 'have-local-offer'; });
  }
  setRemoteDescription(description: RTCSessionDescriptionInit) {
    return this.enqueue('setRemoteDescription', () => {
      assert.equal(this.signalingState, 'have-local-offer');
      this.remoteDescription = description; this.signalingState = 'stable';
    });
  }
  addIceCandidate(candidate?: RTCIceCandidateInit) { return this.enqueue(`ice:${candidate?.candidate}`, () => {}); }
  restartIce() { this.trace.push('restartIce'); }
  close() { this.connectionState = 'closed'; }
}
function state(id: string): RoomStatePayload {
  return { roomId: 'room', name: 'room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
    me: { participantId: id, name: id, role: 'audience', onStage: false,
      handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
async function fixture(t: TestContext) {
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Socket.instances = []; Peer.instances = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await settle(); };
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 50,
    audioElement: { pause() {} } as unknown as HTMLAudioElement });
  const errors: StageError[] = [];
  client.on('error', event => errors.push(event.detail));
  t.after(async () => {
    await client.disconnect();
    for (const peer of Peer.instances) for (const operation of peer.operations.splice(0)) operation.reject(new Error('test cleanup'));
    await settle();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const connected = client.connect();
  const socket = Socket.instances[0]!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
  await connected;
  let acknowledgedOffers = 0;
  async function acknowledgeOffer() {
    await tick(0);
    // A replacement created immediately can still be waiting for control pacing.
    if (socket.sent.filter(message => message.type === 'rtc:offer').length === acknowledgedOffers) await tick(100);
    const offers = socket.sent.filter(message => message.type === 'rtc:offer');
    assert.equal(offers.length, ++acknowledgedOffers);
    const offer = offers.at(-1);
    assert.equal(offer?.type, 'rtc:offer');
    assert.ok(offer && 'requestId' in offer);
    socket.deliver({ type: 'ok', requestId: offer.requestId });
    await settle();
    assert.ok(client['answerWait']);
    assert.equal(client['negotiating'], true);
  }
  async function enter(id: string) {
    socket.deliver({ type: 'room:state', ...state(id) });
    await settle();
    const peer = Peer.instances.at(-1)!;
    peer.complete('createOffer'); await settle();
    peer.complete('setLocalDescription'); await settle();
    await acknowledgeOffer();
    return peer;
  }
  function bufferIce(count: number) {
    for (let n = 1; n <= count; n++) socket.deliver({ type: 'rtc:ice', fromId: 'server', payload: { candidate: String(n), sdpMid: '0', sdpMLineIndex: 0 } });
  }
  async function answer() {
    socket.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
    await settle();
  }
  const peer = await enter('first');
  return { client, socket, peer, errors, tick, acknowledgeOffer, enter, bufferIce, answer };
}

for (const fails of [false, true]) {
  it(`keeps the restarted same-peer waiter pending after expired answer ICE ${fails ? 'rejection' : 'completion'}`, async t => {
    const { client, socket, peer, errors, tick, acknowledgeOffer, bufferIce, answer } = await fixture(t);
    bufferIce(3); await answer();
    peer.complete('setRemoteDescription'); await settle();
    assert.deepEqual(peer.operations.map(operation => operation.name), ['ice:1']);
    const expired = client['answerWait'];
    await tick(50);
    assert.deepEqual(errors.map(error => error.code), ['timeout']);
    assert.equal(client['negotiating'], false);
    peer.connectionState = 'disconnected'; peer.onconnectionstatechange!();
    await tick(3000);
    assert.deepEqual(peer.operations.map(operation => operation.name), ['ice:1', 'createOffer']);
    peer.complete('ice:1'); await settle();
    peer.complete('createOffer'); await settle();
    peer.complete('ice:2'); await settle();
    peer.complete('setLocalDescription'); await settle();
    await acknowledgeOffer();
    assert.equal(socket.sent.filter(message => message.type === 'rtc:offer').length, 2);
    const current = client['answerWait'];
    assert.ok(current); assert.notEqual(current, expired);
    peer.complete('ice:3', fails ? new Error('expired candidate failed') : undefined); await settle();
    assert.equal(client['answerWait'], current, 'an expired answer continuation must not settle the restart waiter');
    assert.equal(client['negotiating'], true);
    assert.deepEqual(errors.map(error => error.code), ['timeout']);
    assert.deepEqual(client['remoteIce'], [], 'the expired answer owns its drained ICE batch');
    await answer(); peer.complete('setRemoteDescription'); await settle();
    assert.equal(client['answerWait'], null);
    assert.equal(client['negotiating'], false);
    assert.deepEqual(errors.map(error => error.code), ['timeout']);
  });
}

it('preserves buffered ICE draining when setRemoteDescription finishes after its answer deadline', async t => {
  const { client, peer, errors, tick, bufferIce, answer } = await fixture(t);
  bufferIce(2); await answer(); await tick(50);
  peer.complete('setRemoteDescription'); await settle();
  assert.deepEqual(peer.operations.map(operation => operation.name), ['ice:1']);
  assert.deepEqual(client['remoteIce'], []);
  peer.complete('ice:1'); await settle();
  peer.complete('ice:2'); await settle();
  assert.deepEqual(peer.operations.map(operation => operation.name), []);
  assert.equal(client['answerWait'], null);
  assert.equal(client['negotiating'], false);
  assert.deepEqual(errors.map(error => error.code), ['timeout']);
});

it('does not carry a failed candidate from expired SDP into the restart answer', async t => {
  const { client, peer, errors, tick, acknowledgeOffer, bufferIce, answer } = await fixture(t);
  bufferIce(2); await answer(); await tick(50);
  assert.deepEqual(errors.map(error => error.code), ['timeout']);
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange!();
  await tick(3000);
  assert.deepEqual(peer.operations.map(operation => operation.name), ['setRemoteDescription', 'createOffer']);
  peer.complete('setRemoteDescription'); await settle();
  assert.deepEqual(client['remoteIce'], [], 'expired SDP must take its buffered candidates out of the shared queue');
  assert.deepEqual(peer.operations.map(operation => operation.name), ['createOffer', 'ice:1']);
  peer.complete('createOffer'); await settle();
  peer.complete('ice:1'); await settle();
  peer.complete('setLocalDescription'); await settle();
  await acknowledgeOffer();
  const current = client['answerWait']; assert.ok(current);
  peer.complete('ice:2', new Error('candidate from expired SDP failed')); await settle();
  assert.equal(client['answerWait'], current);
  assert.equal(client['negotiating'], true);
  assert.deepEqual(errors.map(error => error.code), ['timeout']);
  await answer(); peer.complete('setRemoteDescription'); await settle();
  assert.deepEqual(peer.operations.map(operation => operation.name), [], 'the current answer must not retry the expired candidate');
  assert.deepEqual(client['remoteIce'], []);
  assert.equal(client['answerWait'], null);
  assert.equal(client['negotiating'], false);
  assert.deepEqual(errors.map(error => error.code), ['timeout']);
});

for (const fails of [false, true]) {
  it(`isolates a replacement peer from the retired peer's pending ICE ${fails ? 'rejection' : 'completion'}`, async t => {
    const { client, peer, errors, enter, bufferIce, answer } = await fixture(t);
    bufferIce(1); await answer(); peer.complete('setRemoteDescription'); await settle();
    const currentPeer = await enter('replacement');
    assert.notEqual(currentPeer, peer); assert.equal(peer.connectionState, 'closed');
    const current = client['answerWait']; assert.ok(current);
    peer.complete('ice:1', fails ? new Error('retired candidate failed') : undefined); await settle();
    assert.equal(client['answerWait'], current);
    assert.equal(client['negotiating'], true);
    assert.deepEqual(errors, []);
    await answer(); currentPeer.complete('setRemoteDescription'); await settle();
    assert.equal(client['answerWait'], null);
    assert.equal(client['negotiating'], false);
    assert.deepEqual(errors, []);
  });
}

it('stops draining retired ICE after disconnect', async t => {
  const { client, peer, errors, bufferIce, answer } = await fixture(t);
  bufferIce(2); await answer(); peer.complete('setRemoteDescription'); await settle();
  await client.disconnect(); peer.complete('ice:1'); await settle();
  assert.deepEqual(peer.operations.map(operation => operation.name), []);
  assert.equal(client['pc'], null);
  assert.equal(client['answerWait'], null);
  assert.deepEqual(errors, []);
});

it('resolves the current answer only after every buffered candidate succeeds', async t => {
  const { client, peer, errors, bufferIce, answer } = await fixture(t);
  bufferIce(2); await answer();
  const current = client['answerWait']; assert.ok(current);
  peer.complete('setRemoteDescription'); await settle();
  assert.equal(client['answerWait'], current);
  peer.complete('ice:1'); await settle();
  assert.equal(client['answerWait'], current);
  peer.complete('ice:2'); await settle();
  assert.equal(client['answerWait'], null);
  assert.equal(client['negotiating'], false);
  assert.deepEqual(errors, []);
});

for (const operation of ['setRemoteDescription', 'ice:1']) {
  it(`rejects the current answer when ${operation} fails`, async t => {
    const { client, peer, errors, bufferIce, answer } = await fixture(t);
    bufferIce(2); await answer();
    if (operation === 'ice:1') { peer.complete('setRemoteDescription'); await settle(); }
    peer.complete(operation, new Error('current answer failed')); await settle();
    assert.equal(client['answerWait'], null);
    assert.equal(client['negotiating'], false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message, 'current answer failed');
    assert.deepEqual(peer.operations.map(operation => operation.name), []);
  });
}
