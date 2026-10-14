import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, StageError } from '../src/index.ts';
import { harness, testConfig, RECVONLY_OFFER } from '../../../test/helpers.ts';
import { parseClientMessage } from '../../../src/ws/validate.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function observed(promise: Promise<void>) {
  const result: { status: 'pending' | 'resolved' | 'rejected'; error?: unknown } = { status: 'pending' };
  void promise.then(() => { result.status = 'resolved'; }, error => { result.status = 'rejected'; result.error = error; });
  return result;
}
const code = (expected: StageError['code']) => (error: unknown) => error instanceof StageError && error.code === expected;
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  failSend = false;
  constructor() { Socket.instances.push(this); }
  send(data: string) {
    if (this.failSend) throw new Error('synthetic send failure');
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    if (message.type === 'ping') this.deliver({ type: 'pong' });
  }
  deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
interface Operation { name: string; resolve: () => void; reject: (error: unknown) => void }
/** Controlled media operations expose ordering and ownership, not native ICE or audible recovery. */
class Peer {
  static instances: Peer[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly operations: Operation[] = [];
  readonly calls: string[] = [];
  readonly synchronousFailures = new Map<string, Error>();
  readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
  readonly replacements: (MediaStreamTrack | null)[] = [];
  readonly transceiver = { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
    replaceTrack: async (track: MediaStreamTrack | null) => { this.replacements.push(track); this.transceiver.sender.track = track; } } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  private enqueue<T>(name: string, apply: () => T): Promise<T> {
    this.calls.push(name);
    const failure = this.synchronousFailures.get(name);
    if (failure) { this.synchronousFailures.delete(name); throw failure; }
    const operation = deferred<T>();
    this.operations.push({ name, resolve: () => operation.resolve(apply()), reject: operation.reject });
    return operation.promise;
  }
  complete(name: string, failure?: unknown) {
    const operation = this.operations.shift();
    assert.ok(operation, `missing ${name}; calls: ${this.calls.join(', ')}`);
    assert.equal(operation.name, name, 'native operations complete in queued order');
    if (failure !== undefined) operation.reject(failure); else operation.resolve();
  }
  createOffer(options?: RTCOfferOptions) {
    this.offerOptions.push(options);
    return this.enqueue('createOffer', () => ({ ...RECVONLY_OFFER }));
  }
  setLocalDescription(description: RTCSessionDescriptionInit) {
    return this.enqueue('setLocalDescription', () => { this.localDescription = description; this.signalingState = 'have-local-offer'; });
  }
  setRemoteDescription(description: RTCSessionDescriptionInit) {
    return this.enqueue('setRemoteDescription', () => { this.remoteDescription = description; this.signalingState = 'stable'; });
  }
  addIceCandidate(candidate?: RTCIceCandidateInit) { return this.enqueue(`ice:${candidate?.candidate}`, () => {}); }
  restartIce() { this.calls.push('restartIce'); }
  close() { this.connectionState = 'closed'; this.signalingState = 'closed'; }
}
function state(id = 'listener', status: 'waiting' | 'live' = 'live', onStage = false): RoomStatePayload {
  return { roomId: 'room', name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status,
    me: { participantId: id, name: id, role: onStage ? 'speaker' : 'audience', onStage,
      handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
const hello = (socket: Socket) => socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
  limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
async function fixture(t: TestContext, options: { beforeJoinAck?: boolean; status?: 'waiting' | 'live'; speaker?: boolean; noState?: boolean } = {}) {
  Socket.instances = []; Peer.instances = [];
  let captures = 0, plays = 0;
  const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: new EventTarget(), WebSocket: Socket, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { getUserMedia: async () => { captures++; return stream; } } } })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms = 100) => { now += ms; t.mock.timers.tick(ms); await settle(); };
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000, enableMicMeter: false,
    reconnect: { initialDelayMs: 200, maxDelayMs: 200 },
    audioElement: { pause() {}, async play() { plays++; } } as unknown as HTMLAudioElement });
  const errors: StageError[] = [];
  client.on('error', ({ detail }) => errors.push(detail));
  t.after(async () => {
    await client.disconnect();
    for (const peer of Peer.instances) for (const operation of peer.operations.splice(0)) operation.reject(new Error('test cleanup'));
    await settle();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
  const connecting = client.connect(), socket = Socket.instances[0]!;
  hello(socket); await connecting;
  const joining = client.join({ roomId: 'room', name: 'Listener' });
  void joining.catch(() => {});
  await settle(); await tick(0);
  const join = socket.sent.find(message => message.type === 'join'); assert.ok(join && join.type === 'join');
  const acknowledgeJoin = () => socket.deliver({ type: 'ok', requestId: join.requestId });
  if (!options.beforeJoinAck) { acknowledgeJoin(); await joining; }
  function enter(id = 'listener', current = socket) {
    current.deliver({ type: 'room:state', ...state(id, options.status, options.speaker) });
  }
  if (!options.noState) { enter(); await settle(); }
  const peer = Peer.instances.at(-1)!;
  const offers = (current = socket) => current.sent.filter(message => message.type === 'rtc:offer');
  async function sentOffer(current = socket, currentPeer = peer) {
    currentPeer.complete('createOffer'); await settle();
    currentPeer.complete('setLocalDescription'); await settle(); await tick();
    const offer = offers(current).at(-1); assert.ok(offer);
    return offer;
  }
  const acknowledge = (offer: Extract<ClientMessage, { type: 'rtc:offer' }>, current = socket) => current.deliver({ type: 'ok', requestId: offer.requestId });
  function answer(current = socket) { current.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } }); }
  function bufferIce(count = 2, current = socket) {
    for (let n = 1; n <= count; n++) current.deliver({ type: 'rtc:ice', fromId: 'server', payload: { candidate: String(n), sdpMid: '0', sdpMLineIndex: 0 } });
  }
  async function finish(current = socket, currentPeer = peer) {
    const offer = await sentOffer(current, currentPeer); acknowledge(offer, current); answer(current); await settle();
    currentPeer.complete('setRemoteDescription'); await settle();
  }
  async function failInitial() {
    const offer = await sentOffer();
    socket.deliver({ type: 'error', requestId: offer.requestId, code: 'internal', message: 'transient offer failure' });
    await settle();
    assert.equal(client['negotiating'], false);
  }
  async function resume(id = 'listener') {
    await tick(200);
    const resumed = Socket.instances.at(-1)!; assert.notEqual(resumed, socket);
    hello(resumed); await settle(); await tick(0);
    const request = resumed.sent.find(message => message.type === 'join'); assert.ok(request && request.type === 'join');
    resumed.deliver({ type: 'ok', requestId: request.requestId }); enter(id, resumed); await settle();
    return resumed;
  }
  return { client, socket, peer, errors, tick, joining, acknowledgeJoin, enter, offers, sentOffer, acknowledge, answer,
    bufferIce, finish, failInitial, resume, track, stream, mediaCounts: () => ({ captures, plays }) };
}

for (const status of ['waiting', 'live'] as const) {
  it(`manually retries a failed initial offer in ${status} without capture, playback, rejoin or peer replacement`, async t => {
    const f = await fixture(t, { status }); await f.failInitial();
    const before = f.mediaCounts(), replacements = f.peer.replacements.length;
    const retry = f.client.retryAudioConnection(); await f.finish(); await retry;
    assert.equal(f.client.status, status);
    assert.equal(f.client.me?.participantId, 'listener');
    assert.equal(Peer.instances.length, 1);
    assert.equal(f.peer.transceiver.sender.track, null);
    assert.equal(f.peer.replacements.length, replacements);
    assert.deepEqual(f.mediaCounts(), before);
    assert.equal(f.socket.sent.filter(message => message.type === 'join').length, 1);
    assert.equal(f.offers().length, 2);
    assert.equal(f.peer.calls.includes('restartIce'), false);
    assert.deepEqual(f.peer.offerOptions, [undefined, undefined]);
  });
}

it('retains a publishing microphone and sender track during manual negotiation', async t => {
  const f = await fixture(t, { speaker: true }); await f.failInitial();
  assert.equal(f.peer.transceiver.sender.track, f.track);
  assert.equal(f.peer.transceiver.direction, 'sendrecv');
  const replacements = f.peer.replacements.length;
  const retry = f.client.retryAudioConnection(); await f.finish(); await retry;
  assert.equal(f.client['mic'], f.stream);
  assert.equal(f.peer.transceiver.sender.track, f.track);
  assert.equal(f.peer.replacements.length, replacements);
  assert.deepEqual(f.mediaCounts(), { captures: 1, plays: 0 });
  assert.equal(f.track.stops, 0);
});

it('admits the authoritative snapshot before the join acknowledgement installs the session', async t => {
  const f = await fixture(t, { beforeJoinAck: true }); await f.failInitial();
  assert.equal(f.client['session'], null);
  const retry = f.client.retryAudioConnection(); await f.finish(); await retry;
  assert.equal(f.client['session'], null);
  f.acknowledgeJoin(); await f.joining;
  assert.equal(f.client['session'] !== null, true);
});

it('rejects a second pending retry without adding a dirty offer round', async t => {
  const f = await fixture(t); await f.failInitial();
  const retry = f.client.retryAudioConnection();
  assert.equal(f.client['negotiationDirty'], false);
  await assert.rejects(f.client.retryAudioConnection(), code('conflict'));
  assert.equal(f.client['negotiationDirty'], false);
  await f.finish(); await retry;
  assert.equal(f.offers().length, 2);
  assert.deepEqual(f.peer.operations, []);
});

for (const order of ['ack-first', 'answer-first'] as const) {
  it(`waits for both offer acknowledgement and installed answer with ${order}`, async t => {
    const f = await fixture(t); await f.failInitial();
    const retry = f.client.retryAudioConnection(), result = observed(retry);
    const offer = await f.sentOffer();
    if (order === 'ack-first') {
      f.acknowledge(offer); await settle(); assert.equal(result.status, 'pending');
      f.answer(); await settle(); assert.equal(result.status, 'pending');
      f.peer.complete('setRemoteDescription');
    } else {
      f.answer(); await settle(); f.peer.complete('setRemoteDescription'); await settle();
      assert.equal(result.status, 'pending'); f.acknowledge(offer);
    }
    await retry; assert.equal(result.status, 'resolved');
  });
}

it('waits for every buffered ICE operation after applying the answer', async t => {
  const f = await fixture(t); await f.failInitial();
  const retry = f.client.retryAudioConnection(), result = observed(retry), offer = await f.sentOffer();
  f.acknowledge(offer); f.bufferIce(); f.answer(); await settle();
  f.peer.complete('setRemoteDescription'); await settle(); assert.equal(result.status, 'pending');
  f.peer.complete('ice:1'); await settle(); assert.equal(result.status, 'pending');
  f.peer.complete('ice:2'); await retry;
  assert.deepEqual(f.client['remoteIce'], []);
});

it('does not resolve before the automatic dirty second round has completed', async t => {
  const f = await fixture(t); await f.failInitial();
  const retry = f.client.retryAudioConnection(), result = observed(retry), offer = await f.sentOffer();
  f.enter(); await settle(); assert.equal(f.client['negotiationDirty'], true);
  f.acknowledge(offer); f.answer(); await settle(); f.peer.complete('setRemoteDescription'); await settle();
  assert.equal(result.status, 'pending'); assert.deepEqual(f.peer.operations.map(operation => operation.name), ['createOffer']);
  await f.finish(); await retry; assert.equal(f.offers().length, 3);
});

for (const operation of ['createOffer', 'setLocalDescription', 'setRemoteDescription', 'ice:1']) {
  for (const synchronous of [false, true]) {
    it(`rejects manual retry after ${synchronous ? 'synchronous' : 'asynchronous'} ${operation} failure and allows a later attempt`, async t => {
      const f = await fixture(t); await f.failInitial();
      const failure = new Error(`${operation} failed`);
      if (synchronous) f.peer.synchronousFailures.set(operation, failure);
      const retry = f.client.retryAudioConnection(), rejected = assert.rejects(retry, error => error === failure);
      if (operation !== 'createOffer') {
        f.peer.complete('createOffer'); await settle();
        if (operation !== 'setLocalDescription') {
          f.peer.complete('setLocalDescription'); await settle(); await f.tick();
          f.acknowledge(f.offers().at(-1)!); f.bufferIce(1); f.answer(); await settle();
          if (operation === 'ice:1') { f.peer.complete('setRemoteDescription'); await settle(); }
        }
      }
      if (!synchronous) f.peer.complete(operation, failure);
      await rejected; await settle();
      assert.equal(f.client['negotiating'], false);
      assert.equal(f.errors.at(-1)?.code, 'media_error');
      assert.equal(f.errors.at(-1)?.message, failure.message);
      const next = f.client.retryAudioConnection();
      // The failed answer may leave a buffered candidate for the next installed answer.
      await f.finish();
      while (f.peer.operations[0]?.name.startsWith('ice:')) { f.peer.complete(f.peer.operations[0].name); await settle(); }
      await next;
    });
  }
}

for (const failure of ['wire', 'send', 'ack-timeout', 'answer-timeout'] as const) {
  it(`rejects a manual ${failure} failure without silently retrying`, async t => {
    const f = await fixture(t); await f.failInitial();
    if (failure === 'send') f.socket.failSend = true;
    const retry = f.client.retryAudioConnection(), result = observed(retry);
    f.peer.complete('createOffer'); await settle(); f.peer.complete('setLocalDescription'); await settle(); await f.tick();
    const offer = f.offers().at(-1)!;
    if (failure === 'wire') f.socket.deliver({ type: 'error', requestId: offer.requestId, code: 'internal', message: 'retry rejected' });
    if (failure === 'ack-timeout') { f.answer(); await settle(); f.peer.complete('setRemoteDescription'); await settle(); }
    if (failure === 'answer-timeout') f.acknowledge(offer);
    if (failure.endsWith('timeout')) await f.tick(1000);
    await assert.rejects(retry, code(failure === 'wire' ? 'internal' : failure === 'send' ? 'disconnected' : 'timeout'));
    await settle(); assert.equal(result.status, 'rejected'); assert.equal(f.client['negotiating'], false);
    assert.deepEqual(f.peer.operations, []);
    assert.equal(f.offers().length, failure === 'send' ? 1 : 2);
  });
}

for (const operation of ['createOffer', 'setLocalDescription'] as const) {
  it(`does not impose a new pre-transmission deadline on pending native ${operation}`, async t => {
    const f = await fixture(t); await f.failInitial();
    const retry = f.client.retryAudioConnection(), result = observed(retry);
    if (operation === 'setLocalDescription') { f.peer.complete('createOffer'); await settle(); }
    await f.tick(1001); assert.equal(result.status, 'pending'); assert.equal(f.client['negotiating'], true);
    await f.client.disconnect(); await assert.rejects(retry, code('disconnected'));
    f.peer.complete(operation); await settle();
  });
}

it('returns the original rejected promise when a synchronous error callback disconnects', async t => {
  const f = await fixture(t); await f.failInitial();
  const failure = new Error('synchronous createOffer failure'); f.peer.synchronousFailures.set('createOffer', failure);
  f.client.on('error', () => { void f.client.disconnect(); });
  const retry = f.client.retryAudioConnection(); assert.ok(retry instanceof Promise);
  await assert.rejects(retry, error => error === failure);
  assert.equal(f.client.status, 'disconnected');
});

it('returns the old local promise when synchronous error reentry installs a new peer and run', async t => {
  const f = await fixture(t); await f.failInitial();
  const failure = new Error('synchronous createOffer failure'); f.peer.synchronousFailures.set('createOffer', failure);
  let replacement: Promise<void> | undefined;
  const off = f.client.on('error', () => {
    off(); f.enter('replacement'); replacement = f.client.retryAudioConnection();
  });
  const retry = f.client.retryAudioConnection(); assert.ok(retry instanceof Promise); assert.ok(replacement);
  await assert.rejects(retry, error => error === failure);
  assert.notEqual(retry, replacement);
  const current = Peer.instances.at(-1)!; assert.notEqual(current, f.peer);
  await settle();
  // syncMedia's normal first snapshot adds a dirty round to this manually-started new run.
  await f.finish(f.socket, current);
  if (current.operations.length) await f.finish(f.socket, current);
  await replacement;
});

type AwaitStage = 'createOffer' | 'setLocalDescription' | 'offer' | 'setRemoteDescription' | 'ice:1';
async function pauseAt(f: Awaited<ReturnType<typeof fixture>>, stage: AwaitStage, iceCount = 2) {
  const retry = f.client.retryAudioConnection(), result = observed(retry);
  if (stage === 'createOffer') return { retry, result };
  f.peer.complete('createOffer'); await settle();
  if (stage === 'setLocalDescription') return { retry, result };
  f.peer.complete('setLocalDescription'); await settle(); await f.tick();
  if (stage === 'offer') return { retry, result };
  f.acknowledge(f.offers().at(-1)!); f.bufferIce(iceCount); f.answer(); await settle();
  if (stage === 'ice:1') { f.peer.complete('setRemoteDescription'); await settle(); }
  return { retry, result };
}
for (const stage of ['createOffer', 'setLocalDescription', 'offer', 'setRemoteDescription', 'ice:1'] as const) {
  for (const retirement of ['disconnect', 'kicked', 'room:closed'] as const) {
    it(`rejects immediately on ${retirement} during ${stage} and ignores late native results`, async t => {
      const f = await fixture(t); await f.failInitial();
      const { retry, result } = await pauseAt(f, stage), errors = f.errors.length;
      if (retirement === 'disconnect') await f.client.disconnect();
      else f.socket.deliver(retirement === 'kicked' ? { type: 'kicked', roomId: 'room' } : { type: 'room:closed', roomId: 'room' });
      await settle(); assert.equal(result.status, 'rejected'); await assert.rejects(retry, code('disconnected'));
      assert.equal(f.client['negotiating'], false); assert.equal(f.client['pc'], null);
      if (stage !== 'offer') f.peer.complete(stage);
      await settle(); assert.equal(f.errors.length, errors); assert.deepEqual(f.peer.operations, []);
    });
  }
}
for (const stage of ['createOffer', 'setLocalDescription', 'offer'] as const) {
  it(`rejects on socket loss during ${stage}, retaining serialization across outgoing native SDP waits`, async t => {
    const f = await fixture(t); await f.failInitial();
    const { retry, result } = await pauseAt(f, stage);
    f.socket.close(); await settle(); assert.equal(result.status, 'rejected'); await assert.rejects(retry, code('disconnected'));
    assert.equal(f.client['pc'], f.peer); assert.equal(f.client.status, 'reconnecting');
    await assert.rejects(f.client.retryAudioConnection(), code('disconnected'));
    if (stage !== 'offer') assert.equal(f.client['negotiating'], true, 'an outstanding native operation still owns the same-peer lock');
    const resumed = await f.resume();
    if (stage !== 'offer') {
      await assert.rejects(f.client.retryAudioConnection(), code('conflict'));
      assert.deepEqual(f.peer.operations.map(operation => operation.name), [stage], 'resume must not overlap the held native operation');
      f.peer.complete(stage); await settle(); await f.tick();
    }
    while (f.peer.operations[0]?.name.startsWith('ice:')) { f.peer.complete(f.peer.operations[0].name); await settle(); }
    if (f.peer.operations[0]?.name === 'setLocalDescription') { f.peer.complete('setLocalDescription'); await settle(); await f.tick(); }
    if (f.peer.operations[0]?.name === 'createOffer') await f.finish(resumed);
    else if (f.client['answerWait']) {
      const offer = f.offers(resumed).at(-1)!; assert.ok(offer); f.acknowledge(offer, resumed); f.answer(resumed); await settle();
      f.peer.complete('setRemoteDescription'); await settle();
    }
    if (f.peer.operations[0]?.name === 'createOffer') await f.finish(resumed);
    assert.equal(f.client['negotiating'], false); assert.equal(Peer.instances.length, 1);
    assert.equal(result.status, 'rejected', 'resuming cannot turn the cancelled public promise into success');
  });
}

for (const stage of ['setRemoteDescription', 'ice:1'] as const) {
  for (const fails of [false, true]) {
    it(`keeps resumed retry ownership after cancelled answer ${stage} and late ICE ${fails ? 'failure' : 'success'}`, async t => {
      const f = await fixture(t); await f.failInitial();
      const { retry } = await pauseAt(f, stage, stage === 'ice:1' ? 3 : 2);
      f.socket.close(); await settle(); await assert.rejects(retry, code('disconnected'));
      assert.equal(f.client['negotiating'], false, 'answer cancellation preserves the existing receive-operation FIFO semantics');
      const resumed = await f.resume();
      // A pending remote answer still needs an automatic offer; an installed answer allows an explicit retry.
      const current = stage === 'ice:1' ? f.client.retryAudioConnection() : f.client['negotiationRun']!.promise;
      const result = observed(current);
      if (stage === 'setRemoteDescription') { f.peer.complete(stage); await settle(); }
      else { f.peer.complete('ice:1'); await settle(); }
      f.peer.complete('createOffer'); await settle();
      f.peer.complete(stage === 'setRemoteDescription' ? 'ice:1' : 'ice:2'); await settle();
      f.peer.complete('setLocalDescription'); await settle(); await f.tick();
      const wait = f.client['answerWait']; assert.ok(wait);
      f.acknowledge(f.offers(resumed).at(-1)!, resumed);
      f.peer.complete(stage === 'setRemoteDescription' ? 'ice:2' : 'ice:3', fails ? new Error('cancelled answer ICE failure') : undefined);
      await settle(); assert.equal(f.client['answerWait'], wait); assert.equal(result.status, 'pending');
      f.answer(resumed); await settle(); f.peer.complete('setRemoteDescription'); await current;
      assert.equal(f.client['negotiating'], false); assert.equal(Peer.instances.length, 1);
    });
  }
}

for (const stage of ['createOffer', 'setLocalDescription', 'setRemoteDescription', 'ice:1'] as const) {
  for (const rejects of [false, true]) {
    it(`does not let old ${stage} ${rejects ? 'failure' : 'success'} settle a replacement peer retry`, async t => {
      const f = await fixture(t); await f.failInitial();
      const { retry } = await pauseAt(f, stage);
      f.enter('replacement'); await settle(); await assert.rejects(retry, code('disconnected'));
      const current = Peer.instances.at(-1)!; assert.notEqual(current, f.peer);
      current.complete('createOffer', new Error('replacement initial failure')); await settle();
      const newer = f.client.retryAudioConnection(), result = observed(newer), errors = f.errors.length;
      f.peer.complete(stage, rejects ? new Error('retired native failure') : undefined); await settle();
      assert.equal(result.status, 'pending'); assert.equal(f.client['negotiating'], true); assert.equal(f.errors.length, errors);
      assert.deepEqual(current.operations.map(operation => operation.name), ['createOffer']);
      await f.finish(f.socket, current); await newer;
    });
  }
}

it('rejects absent snapshots without creating media or signaling work', async t => {
  const f = await fixture(t, { noState: true });
  await assert.rejects(f.client.retryAudioConnection(), code('not_joined'));
  assert.equal(Peer.instances.length, 0); assert.equal(f.offers().length, 0);
});
for (const invalid of ['missing', 'identity', 'failed', 'closed', 'signaling-closed'] as const) {
  it(`rejects the ${invalid} peer with media_error without replacing it`, async t => {
    const f = await fixture(t); await f.failInitial();
    if (invalid === 'missing') f.client['pc'] = null;
    if (invalid === 'identity') f.client['pcParticipantId'] = 'different';
    if (invalid === 'failed' || invalid === 'closed') f.peer.connectionState = invalid;
    if (invalid === 'signaling-closed') f.peer.signalingState = 'closed';
    await assert.rejects(f.client.retryAudioConnection(), code('media_error'));
    assert.equal(Peer.instances.length, 1); assert.equal(f.offers().length, 1); assert.deepEqual(f.peer.operations, []);
  });
}
for (const unavailable of ['socket-not-open', 'reconnecting', 'disconnected'] as const) {
  it(`rejects ${unavailable} signaling before starting negotiation`, async t => {
    const f = await fixture(t); await f.failInitial();
    if (unavailable === 'socket-not-open') f.socket.readyState = 0;
    else f.client['currentStatus'] = unavailable;
    await assert.rejects(f.client.retryAudioConnection(), code('disconnected'));
    assert.equal(f.offers().length, 1); assert.deepEqual(f.peer.operations, []);
  });
}

it('rejects the same public retry when its automatic dirty second round fails', async t => {
  const f = await fixture(t); await f.failInitial();
  const retry = f.client.retryAudioConnection(), result = observed(retry), offer = await f.sentOffer();
  f.enter(); await settle(); f.acknowledge(offer); f.answer(); await settle();
  f.peer.complete('setRemoteDescription'); await settle(); assert.equal(result.status, 'pending');
  const failure = new Error('second round failed');
  f.peer.complete('createOffer', failure);
  await assert.rejects(retry, error => error === failure);
  assert.equal(f.client['negotiating'], false);
});

it('manually restores the same subscriber through SDK, validator and Hub after a transient initial transport rejection', async t => {
  const config = testConfig(value => { value.rooms.qualityIntervalMs = 0; });
  const h = harness(config), host = await h.create();
  const failedOffer = deferred<never>(), originalNegotiate = h.transport.negotiate.bind(h.transport);
  let negotiations = 0, captures = 0, plays = 0;
  h.transport.negotiate = (...args) => ++negotiations === 1 ? failedOffer.promise : originalNegotiate(...args);
  let serverWork = Promise.resolve();
  class HubSocket {
    static OPEN = 1;
    static instances: HubSocket[] = [];
    readyState = 1;
    readonly sent: ClientMessage[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    readonly session = { id: 'audio-retry-listener', send: (message: ServerMessage) => this.onmessage?.({ data: JSON.stringify(message) }),
      close: () => this.close() };
    constructor() { HubSocket.instances.push(this); queueMicrotask(() => h.hub.attach(this.session)); }
    send(data: string) {
      const message = parseClientMessage(data, config.limits); this.sent.push(message);
      serverWork = serverWork.then(() => h.hub.handle(this.session, message));
    }
    close() { this.readyState = 3; this.onclose?.(); void h.hub.detach(this.session, true); }
  }
  class HubPeer {
    static instances: HubPeer[] = [];
    connectionState = 'new';
    signalingState = 'stable';
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
    readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown,
      async replaceTrack(track: unknown) { this.track = track; } } };
    constructor() { HubPeer.instances.push(this); }
    addTransceiver() { return this.transceiver; }
    async createOffer(options?: RTCOfferOptions) { this.offerOptions.push(options); return { ...RECVONLY_OFFER }; }
    async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; this.signalingState = 'have-local-offer'; }
    async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; this.signalingState = 'stable'; }
    async addIceCandidate() {}
    restartIce() { assert.fail('manual recovery must not restart ICE'); }
    close() { this.connectionState = 'closed'; }
  }
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: new EventTarget(), WebSocket: HubSocket, RTCPeerConnection: HubPeer,
    navigator: { mediaDevices: { getUserMedia: async () => { captures++; throw new Error('audience must not capture'); } } } })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0; t.mock.method(performance, 'now', () => now);
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await settle(); };
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 5000,
    audioElement: { pause() {}, async play() { plays++; } } as unknown as HTMLAudioElement });
  const errors: StageError[] = []; client.on('error', ({ detail }) => errors.push(detail));
  t.after(async () => {
    failedOffer.reject(new Error('test cleanup'));
    await client.disconnect(); await serverWork; await h.hub.shutdown(); await h.transport.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
  const joining = client.join({ roomId: host.roomId, code: host.code, name: 'Listener' });
  await settle(); await tick(0); await joining; await tick(100);
  assert.equal(negotiations, 1);
  for (const timer of h.timers) if (!timer.cleared && timer.ms === config.rooms.presenceBroadcastMs) { timer.cleared = true; timer.fn(); }
  await settle(); failedOffer.reject(new Error('synthetic transient media worker failure')); await settle(); await serverWork;
  const id = client.me!.participantId, socket = HubSocket.instances[0]!, peer = HubPeer.instances[0]!;
  assert.equal(client.status, 'live'); assert.equal(h.hub.isJoined(socket.session), true);
  assert.equal(h.transport.rooms.get(host.roomId)!.subscribers.has(id), false);
  assert.equal(peer.remoteDescription, null); assert.equal(client['negotiating'], false);
  for (let n = 0; n < 8; n++) await tick(15000);
  assert.equal(negotiations, 1, 'healthy control keepalive is not an automatic media retry');
  const errorsBefore = errors.length;
  const retry = client.retryAudioConnection(); await settle(); await tick(100); await retry; await serverWork;
  assert.equal(negotiations, 2);
  assert.equal(h.transport.rooms.get(host.roomId)!.subscribers.has(id), true);
  assert.ok(peer.remoteDescription);
  assert.equal(client.me!.participantId, id); assert.equal(HubPeer.instances.length, 1);
  assert.equal(socket.sent.filter(message => message.type === 'join').length, 1);
  assert.equal(socket.sent.filter(message => message.type === 'rtc:offer').length, 2);
  assert.deepEqual(peer.offerOptions, [undefined, undefined]);
  assert.equal(errors.length, errorsBefore); assert.equal(captures, 0); assert.equal(plays, 0);
  assert.equal(peer.connectionState, 'new', 'negotiation completion does not assert ICE connectivity or audible playback');
});
