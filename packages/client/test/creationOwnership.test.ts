import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import { StageClient, StageError, type StageClientOptions } from '../src/index.ts';
import type { RoomStatePayload } from '../../../shared/protocol.ts';

interface RequestMessage { type: string; requestId: string; name?: string }
interface Creation { roomId: string; code?: string }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
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
  localDescription = null;
  constructor() { Peer.instances.push(this); }
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null, async replaceTrack(track: MediaStreamTrack | null) { this.track = track; } } };
  }
  close() { this.connectionState = 'closed'; }
}

const created: Creation = { roomId: 'room', code: 'test-code' };
const state: RoomStatePayload = {
  roomId: 'room', name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 0,
  codeRequired: true, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
  me: { participantId: 'host', name: 'Host', role: 'controller', onStage: false, handRaised: false,
    muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 },
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const observe = <T>(promise: Promise<T>): Promise<Outcome<T>> => promise.then(
  value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }),
);
const hello = (socket: Socket) => socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
const acknowledge = (socket: Socket, request: RequestMessage) => socket.deliver({ type: 'ok', requestId: request.requestId });
const rejectJoined = (socket: Socket, request: RequestMessage) => socket.deliver({ type: 'error', requestId: request.requestId, code: 'already_joined', message: 'Already joined.' });
function assertError(outcome: Outcome<unknown>, code: StageError['code']): void {
  assert.ok(!outcome.ok);
  assert.ok(outcome.error instanceof StageError);
  assert.equal(outcome.error.code, code);
}

describe('room creation result ownership', () => {
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
  function tick(t: TestContext, milliseconds: number): void {
    now += milliseconds;
    t.mock.timers.tick(milliseconds);
  }
  async function start(client: StageClient, t: TestContext): Promise<Socket> {
    const socket = Socket.instances.at(-1)!;
    hello(socket); await flush(); tick(t, 0);
    assert.equal(client['pendingControlRequests'], 1);
    assert.equal(socket.sent[0]!.type, 'room:create');
    return socket;
  }
  function assertSession(client: StageClient, room: Creation = created, name = 'Host'): void {
    assert.deepEqual(client['session'], { ...room, name });
    assert.equal(client['pendingControlRequests'], 0);
    assert.equal(client['pending'].size, 0);
  }

  for (const event of ['created', 'state'] as const) it(`preserves the first result when a ${event} listener reenters createRoom before its acknowledgement`, async t => {
    const client = make();
    // This test exercises state callbacks without starting real media or an unrelated SDP request.
    client['negotiate'] = () => {};
    let second: Promise<Outcome<Creation>> | undefined;
    client.on(event, () => { second ??= observe(client.createRoom({ name: 'Other' })); });
    const first = observe(client.createRoom({ name: 'Host' }));
    const socket = await start(client, t);
    socket.deliver({ type: 'room:created', ...created });
    if (event === 'state') socket.deliver({ type: 'room:state', ...state });
    await flush(); tick(t, 100);
    assert.ok(second);
    assert.deepEqual(socket.sent.map(message => [message.type, message.name]), [['room:create', 'Host'], ['room:create', 'Other']]);
    assert.equal(client['pendingControlRequests'], 2, 'unlimited callers remain concurrent');
    assert.equal(Peer.instances.length, event === 'state' ? 1 : 0);
    acknowledge(socket, socket.sent[0]!);
    rejectJoined(socket, socket.sent[1]!);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, { ok: true, value: created });
    assertError(secondResult, 'already_joined');
    assertSession(client);
  });

  it('keeps simultaneous creates concurrent while they await the same initial hello', async t => {
    const client = make();
    const first = observe(client.createRoom({ name: 'Host' }));
    const second = observe(client.createRoom({ name: 'Other' }));
    assert.equal(Socket.instances.length, 1);
    const socket = Socket.instances[0]!;
    hello(socket); await flush(); tick(t, 0); tick(t, 100);
    assert.deepEqual(socket.sent.map(message => message.name), ['Host', 'Other']);
    assert.equal(client['pendingControlRequests'], 2);
    socket.deliver({ type: 'room:created', ...created });
    acknowledge(socket, socket.sent[0]!);
    rejectJoined(socket, socket.sent[1]!);
    assert.deepEqual(await first, { ok: true, value: created });
    assertError(await second, 'already_joined');
    assertSession(client);
  });

  it('keeps a pending result when the later create error arrives before the original acknowledgement', async t => {
    const client = make();
    const first = observe(client.createRoom({ name: 'Host' }));
    const socket = await start(client, t);
    socket.deliver({ type: 'room:created', ...created });
    const second = observe(client.createRoom({ name: 'Other' }));
    await flush(); tick(t, 100);
    rejectJoined(socket, socket.sent[1]!);
    assertError(await second, 'already_joined');
    assert.equal(client['pendingControlRequests'], 1);
    assert.equal(client['session'], null);
    acknowledge(socket, socket.sent[0]!);
    assert.deepEqual(await first, { ok: true, value: created });
    assertSession(client);
  });

  it('does not satisfy a later acknowledgement with an earlier successful creation event', async t => {
    const client = make();
    const first = observe(client.createRoom({ name: 'Host' }));
    const socket = await start(client, t);
    socket.deliver({ type: 'room:created', ...created });
    acknowledge(socket, socket.sent[0]!);
    assert.deepEqual(await first, { ok: true, value: created });
    const session = client['session'];
    const second = observe(client.createRoom({ name: 'Other' }));
    await flush(); tick(t, 100);
    acknowledge(socket, socket.sent[1]!);
    assertError(await second, 'internal');
    assert.equal(client['session'], session);
    assertSession(client);
  });

  it('does not reuse a pre-disconnect creation event when a new connection only receives an acknowledgement', async t => {
    const client = make();
    const first = observe(client.createRoom({ name: 'Host' }));
    const socket = await start(client, t);
    socket.deliver({ type: 'room:created', ...created });
    acknowledge(socket, socket.sent[0]!);
    assert.deepEqual(await first, { ok: true, value: created });
    await client.disconnect();
    const second = observe(client.createRoom({ name: 'Other' }));
    const replacement = await start(client, t);
    assert.notEqual(replacement, socket);
    acknowledge(replacement, replacement.sent[0]!);
    assertError(await second, 'internal');
    assert.equal(client['session'], null);
    assert.equal(client['pending'].size, 0);
  });

  it('isolates an acknowledged old create continuation from disconnect and immediate reuse', async t => {
    const client = make();
    const first = observe(client.createRoom({ name: 'Host' }));
    const socket = await start(client, t);
    socket.deliver({ type: 'room:created', ...created });
    acknowledge(socket, socket.sent[0]!);
    const disconnecting = client.disconnect();
    const next = observe(client.createRoom({ name: 'Replacement' }));
    const replacement = Socket.instances.at(-1)!;
    assert.notEqual(replacement, socket);
    await disconnecting;
    assertError(await first, 'disconnected');
    assert.equal(client['session'], null);
    hello(replacement); await flush(); tick(t, 0);
    socket.deliver({ type: 'room:created', roomId: 'retired-room', code: 'retired-code' });
    acknowledge(replacement, socket.sent[0]!);
    assert.equal(client['pendingControlRequests'], 1, 'an old request ID cannot acknowledge the replacement');
    const fresh = { roomId: 'new-room', code: 'new-code' };
    replacement.deliver({ type: 'room:created', ...fresh });
    acknowledge(replacement, replacement.sent[0]!);
    assert.deepEqual(await next, { ok: true, value: fresh });
    assertSession(client, fresh, 'Replacement');
  });

  it('preserves capacity-one rejection and the admitted creation result during listener reentrancy', async t => {
    const client = make({ maxPendingControlRequests: 1 });
    let second: Promise<Outcome<Creation>> | undefined;
    client.on('created', () => { second = observe(client.createRoom({ name: 'Other' })); });
    const first = observe(client.createRoom({ name: 'Host' }));
    const socket = await start(client, t);
    socket.deliver({ type: 'room:created', ...created });
    assert.ok(second);
    assertError(await second, 'queue_full');
    assert.equal(client['pendingControlRequests'], 1);
    acknowledge(socket, socket.sent[0]!);
    assert.deepEqual(await first, { ok: true, value: created });
    assertSession(client);
    tick(t, 1000);
    assert.equal(socket.sent.length, 1, 'a rejected caller does not send a request later');
  });
});
