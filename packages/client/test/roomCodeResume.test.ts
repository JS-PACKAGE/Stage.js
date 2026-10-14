import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, StageError } from '../src/index.ts';

type Join = Extract<ClientMessage, { type: 'join' }>;
type JoinOptions = { roomId: string; name: string; code?: string };
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as ClientMessage); }
  deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

/** Hold the fake offer so control-plane tests need no SDP, microphone, browser, or network. */
class Peer {
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = null;
  private cancelOffer: (() => void) | undefined;
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
      async replaceTrack(track: MediaStreamTrack | null) { this.track = track; } } };
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return new Promise((_resolve, reject) => { this.cancelOffer = () => reject(new Error('fake peer closed')); });
  }
  close() { this.connectionState = 'closed'; this.cancelOffer?.(); }
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const hello = (socket: Socket) => socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
  limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
function state(options: { roomId?: string; code?: string; role?: RoomStatePayload['me']['role'];
  codeRequired?: boolean; status?: RoomStatePayload['status']; resumeToken?: string } = {}): RoomStatePayload {
  const { roomId = 'room', code, role = 'controller', codeRequired = true, status = 'live', resumeToken = 'seat-token' } = options;
  return { roomId, name: roomId, controllerId: role === 'controller' ? 'self' : 'other', speakers: [], hands: [],
    audienceCount: role === 'audience' ? 1 : 0, codeRequired, status, code, resumeToken,
    limits: { maxSpeakers: 8, maxAudience: 300 },
    me: { participantId: 'self', name: 'Self', role, onStage: false, handRaised: false,
      muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
const deliverState = (socket: Socket, snapshot: RoomStatePayload) => socket.deliver({ type: 'room:state', ...snapshot });
function request<K extends ClientMessage['type']>(socket: Socket, type: K): Extract<ClientMessage, { type: K }> {
  const message = socket.sent.filter(message => message.type === type).at(-1);
  assert.ok(message, `expected ${type}`);
  return message as Extract<ClientMessage, { type: K }>;
}
function acknowledge(socket: Socket, message: ClientMessage) {
  assert.ok('requestId' in message);
  socket.deliver({ type: 'ok', requestId: message.requestId });
}
function fixture(t: TestContext) {
  Socket.instances = [];
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 5000,
    reconnect: { initialDelayMs: 25, maxDelayMs: 25 }, audioElement: { pause() {} } as unknown as HTMLAudioElement });
  const errors: StageError[] = [];
  client.on('error', event => errors.push(event.detail));
  t.after(async () => {
    await client.disconnect(); await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    assert.deepEqual(errors, [], 'fake control scenarios must not produce media or request errors');
  });
  async function ready() {
    const socket = Socket.instances.at(-1)!;
    hello(socket); await flush(); await tick(0);
    return socket;
  }
  async function join(options: JoinOptions = { roomId: 'room', name: 'Self', code: 'entry-code' }) {
    const pending = client.join(options); pending.catch(() => {});
    const socket = await ready();
    acknowledge(socket, request(socket, 'join')); await pending;
    return socket;
  }
  async function resume(lost: Socket): Promise<{ socket: Socket; message: Join }> {
    if (lost.readyState === Socket.OPEN) lost.close();
    await tick(25);
    const socket = await ready(); assert.notEqual(socket, lost);
    const message = request(socket, 'join');
    acknowledge(socket, message); await flush();
    assert.equal(socket.sent.filter(message => message.type === 'join').length, 1);
    return { socket, message };
  }
  async function rotate(socket: Socket, snapshot: RoomStatePayload) {
    const pending = client.rotateCode(); pending.catch(() => {});
    await tick(100);
    const message = request(socket, 'room:rotate-code');
    deliverState(socket, snapshot); acknowledge(socket, message); await pending;
  }
  return { client, ready, join, resume, rotate, tick };
}

it('resumes a joined controller with the latest rotated code and seat token', async t => {
  const f = fixture(t), socket = await f.join();
  deliverState(socket, state({ code: 'entry-code' }));
  await f.rotate(socket, state({ code: 'rotation-one' }));
  await f.rotate(socket, state({ code: 'rotation-two', resumeToken: 'latest-seat-token' }));
  assert.equal(f.client.state?.code, 'rotation-two');
  const { message } = await f.resume(socket);
  assert.deepEqual({ roomId: message.roomId, code: message.code, name: message.name, resumeToken: message.resumeToken },
    { roomId: 'room', code: 'rotation-two', name: 'Self', resumeToken: 'latest-seat-token' });
});

it('resumes a created controller with the code delivered by rotateCode', async t => {
  const f = fixture(t), pending = f.client.createRoom({ name: 'Self', codeRequired: true });
  const socket = await f.ready();
  socket.deliver({ type: 'room:created', roomId: 'room', code: 'created-code' });
  acknowledge(socket, request(socket, 'room:create'));
  assert.deepEqual(await pending, { roomId: 'room', code: 'created-code' });
  await f.rotate(socket, state({ code: 'rotated-code' }));
  assert.equal((await f.resume(socket)).message.code, 'rotated-code');
});

for (const operation of ['join', 'create'] as const) {
  it(`installs the latest controller snapshot code when ${operation} is acknowledged afterwards`, async t => {
    const f = fixture(t);
    const pending = operation === 'join' ? f.client.join({ roomId: 'room', name: 'Self', code: 'caller-code' })
      : f.client.createRoom({ name: 'Self', codeRequired: true });
    const socket = await f.ready();
    if (operation === 'create') socket.deliver({ type: 'room:created', roomId: 'room', code: 'caller-code' });
    // Synthetic ordering: distinct code-bearing states precede the initial ACK. This tests SDK
    // installation ownership, not a claim that the real server rotates a code inside one request.
    deliverState(socket, state({ code: 'early-code' }));
    deliverState(socket, state({ code: 'latest-before-ack' }));
    acknowledge(socket, request(socket, operation === 'join' ? 'join' : 'room:create'));
    await pending;
    assert.equal((await f.resume(socket)).message.code, 'latest-before-ack');
  });
}

const nonAuthoritative: { label: string; options: Parameters<typeof state>[0] }[] = [
  { label: 'a controller snapshot without a code', options: {} },
  { label: 'a synthetic controller snapshot with an empty code', options: { code: '' } },
  { label: 'a redacted audience snapshot', options: { role: 'audience' } },
  { label: 'a synthetic audience snapshot carrying a code', options: { role: 'audience', code: 'ignore-audience' } },
  { label: 'an open-room snapshot', options: { codeRequired: false } },
  { label: 'a synthetic open-room snapshot carrying a code', options: { codeRequired: false, code: 'ignore-open-room' } },
  { label: 'a snapshot belonging to another room', options: { roomId: 'other-room', code: 'ignore-other-room' } },
];
for (const { label, options } of nonAuthoritative) {
  it(`preserves the last learned controller code after ${label}`, async t => {
    const f = fixture(t), socket = await f.join();
    await f.rotate(socket, state({ code: 'last-known-code' }));
    // Out-of-policy code fields and wrong-room frames are synthetic ownership controls.
    deliverState(socket, state(options));
    assert.equal((await f.resume(socket)).message.code, 'last-known-code');
  });
  it(`keeps the supplied join code when the latest pre-ACK state is ${label}`, async t => {
    const f = fixture(t), pending = f.client.join({ roomId: 'room', name: 'Self', code: 'caller-code' });
    const socket = await f.ready();
    deliverState(socket, state({ code: 'superseded-before-ack' }));
    deliverState(socket, state(options));
    acknowledge(socket, request(socket, 'join')); await pending;
    assert.equal((await f.resume(socket)).message.code, 'caller-code');
  });
}

it('does not invent a resume code for an open room joined without a code', async t => {
  const f = fixture(t), socket = await f.join({ roomId: 'room', name: 'Self' });
  deliverState(socket, state({ codeRequired: false }));
  assert.equal(Object.hasOwn((await f.resume(socket)).message, 'code'), false);
});

it('learns the current code on controller promotion and retains it after demotion', async t => {
  const f = fixture(t), socket = await f.join();
  deliverState(socket, state({ role: 'audience' }));
  socket.deliver({ type: 'control:transferred', fromId: 'other', toId: 'self' });
  deliverState(socket, state({ code: 'promotion-code' }));
  const first = await f.resume(socket);
  assert.equal(first.message.code, 'promotion-code');
  const transferring = f.client.transferControl('other'); await f.tick(100);
  first.socket.deliver({ type: 'control:transferred', fromId: 'self', toId: 'other' });
  deliverState(first.socket, state({ role: 'audience' }));
  acknowledge(first.socket, request(first.socket, 'control:transfer')); await transferring;
  assert.equal((await f.resume(first.socket)).message.code, 'promotion-code');
});

it('ignores retired-socket code snapshots before and after replacement session installation', async t => {
  const f = fixture(t), old = await f.join();
  await f.rotate(old, state({ code: 'old-code' }));
  await f.client.disconnect();
  const pending = f.client.join({ roomId: 'replacement', name: 'Replacement', code: 'replacement-code' });
  const socket = await f.ready();
  old.deliver({ type: 'room:state', ...state({ roomId: 'replacement', code: 'retired-before-ack' }) });
  acknowledge(socket, request(socket, 'join')); await pending;
  old.deliver({ type: 'room:state', ...state({ roomId: 'replacement', code: 'retired-after-ack' }) });
  assert.equal(f.client.state, null, 'retired frames cannot publish a replacement snapshot');
  const { message } = await f.resume(socket);
  assert.equal(message.roomId, 'replacement'); assert.equal(message.code, 'replacement-code');
});

for (const event of ['status', 'state'] as const) {
  it(`refreshes the code before a ${event} callback drops the current socket`, async t => {
    const f = fixture(t), socket = await f.join();
    deliverState(socket, state({ code: 'entry-code' }));
    const off = f.client.on(event, () => { off(); socket.close(); });
    deliverState(socket, state({ code: 'callback-code', status: 'waiting' }));
    assert.equal((await f.resume(socket)).message.code, 'callback-code');
  });

  it(`keeps the newer code when a ${event} callback synchronously delivers another snapshot`, async t => {
    const f = fixture(t), socket = await f.join();
    deliverState(socket, state({ code: 'entry-code' }));
    const off = f.client.on(event, () => { off(); deliverState(socket, state({ code: 'nested-code' })); });
    deliverState(socket, state({ code: 'outer-code', status: 'waiting' }));
    assert.equal(f.client.state?.code, 'nested-code');
    assert.equal((await f.resume(socket)).message.code, 'nested-code');
  });

  for (const roomId of ['room', 'replacement']) {
    it(`keeps the ${roomId === 'room' ? 'same-room' : 'different-room'} replacement code when a ${event} callback disconnects and rejoins`, async t => {
      const f = fixture(t), old = await f.join();
      deliverState(old, state({ code: 'entry-code' }));
      let pending: Promise<void> | undefined;
      const off = f.client.on(event, () => {
        off(); void f.client.disconnect();
        pending = f.client.join({ roomId, name: 'Replacement', code: 'replacement-code' }); pending.catch(() => {});
      });
      deliverState(old, state({ code: 'abandoned-code', status: 'waiting' }));
      assert.ok(pending);
      const socket = await f.ready(); assert.notEqual(socket, old);
      acknowledge(socket, request(socket, 'join')); await pending;
      old.deliver({ type: 'room:state', ...state({ roomId, code: 'late-retired-code' }) });
      const { message } = await f.resume(socket);
      assert.equal(message.roomId, roomId); assert.equal(message.code, 'replacement-code');
      assert.equal(message.name, 'Replacement');
    });
  }
}

it('does not install the code from an initial join whose state callback replaces its session', async t => {
  const f = fixture(t), first = f.client.join({ roomId: 'room', name: 'Old', code: 'old-input' });
  const rejected = assert.rejects(first, error => error instanceof StageError && error.code === 'disconnected');
  const old = await f.ready(), oldRequest = request(old, 'join');
  let next: Promise<void> | undefined;
  const off = f.client.on('state', () => {
    off(); void f.client.disconnect();
    next = f.client.join({ roomId: 'room', name: 'New', code: 'new-input' }); next.catch(() => {});
  });
  deliverState(old, state({ code: 'abandoned-pre-ack' }));
  acknowledge(old, oldRequest); await rejected;
  const socket = await f.ready(); assert.ok(next);
  const replacement = state({ code: 'new-before-ack' });
  replacement.me.name = 'New';
  deliverState(socket, replacement);
  acknowledge(socket, request(socket, 'join')); await next;
  const { message } = await f.resume(socket);
  assert.equal(message.code, 'new-before-ack'); assert.equal(message.name, 'New');
});
