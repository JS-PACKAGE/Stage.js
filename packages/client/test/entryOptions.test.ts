import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { RoomStatePayload } from '../../../shared/protocol.ts';
import { StageClient, StageError, type StageClientOptions } from '../src/index.ts';

type Operation = 'createRoom' | 'join';
type CreateOptions = Parameters<StageClient['createRoom']>[0];
type JoinOptions = Parameters<StageClient['join']>[0];
type EntryOptions = CreateOptions & Partial<Pick<JoinOptions, 'roomId' | 'code'>>;
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
interface Request { type: string; requestId: string; [field: string]: unknown }

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Request[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as Request); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello() {
    this.readyState = Socket.OPEN;
    this.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

/** The control-plane tests hold offers without network or microphone access; close settles them. */
class Peer {
  static offers = new Set<() => void>();
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = null;
  private cancelOffer?: () => void;
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
      async replaceTrack(track: MediaStreamTrack | null) { this.track = track; } } };
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return new Promise((_resolve, reject) => {
      this.cancelOffer = () => { Peer.offers.delete(this.cancelOffer!); reject(new Error('fake peer closed')); };
      Peer.offers.add(this.cancelOffer);
    });
  }
  close() { this.connectionState = 'closed'; this.cancelOffer?.(); }
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const entryType = (operation: Operation) => operation === 'join' ? 'join' : 'room:create';
function inputs(operation: Operation, suffix = 'A', optional = true): EntryOptions {
  return operation === 'join'
    ? { roomId: `room-${suffix}`, name: `Name ${suffix}`, ...(optional ? { code: `code-${suffix}` } : {}) }
    : { name: `Name ${suffix}`, ...(optional ? { roomName: `Room ${suffix}`, codeRequired: true, recording: false, recordingAvailable: false, token: `token-${suffix}` } : {}) };
}
function fields(request: Request): Omit<Request, 'requestId'> {
  const { requestId: _, ...payload } = request;
  return payload;
}
function latest(socket: Socket, type: string): Request {
  const request = socket.sent.filter(message => message.type === type).at(-1);
  assert.ok(request, `expected ${type} on the wire`);
  return request;
}
const acknowledge = (socket: Socket, request: Request) => socket.deliver({ type: 'ok', requestId: request.requestId });
function assertError(outcome: Outcome, code: StageError['code']) {
  assert.ok(!outcome.ok, `expected ${code}`);
  assert.ok(outcome.error instanceof StageError);
  assert.equal(outcome.error.code, code);
}
function snapshot(role: RoomStatePayload['me']['role'], code?: string): RoomStatePayload {
  return { roomId: 'room-A', name: 'Room A', codeRequired: true, recording: false, recordingAvailable: false, code, status: 'live',
    controllerId: 'self', audienceCount: 1, speakers: [], hands: [], resumeToken: 'seat-A',
    limits: { maxSpeakers: 8, maxAudience: 300 },
    me: { participantId: 'self', name: 'Name A', role, onStage: false, handRaised: false,
      muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
function fixture(t: TestContext, settings: Partial<StageClientOptions> = {}) {
  Socket.instances = [];
  assert.equal(Peer.offers.size, 0);
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    reconnect: { initialDelayMs: 25, maxDelayMs: 25 },
    audioElement: { pause() {} } as unknown as HTMLAudioElement, ...settings });
  const observed: Promise<Outcome>[] = [], errors: StageError['code'][] = [], expectedErrors: StageError['code'][] = [];
  const watch = (promise: Promise<unknown>): Promise<Outcome> => {
    const result = promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    observed.push(result); return result;
  };
  client.on('error', event => errors.push(event.detail.code));
  t.after(async () => {
    try {
      await client.disconnect(); await flush();
      await Promise.all(observed);
      assert.equal(Peer.offers.size, 0, 'cleanup settles every held media offer');
      assert.deepEqual(errors, expectedErrors, 'only explicitly delivered server errors are emitted');
      const count = Socket.instances.length;
      await tick(5000);
      assert.equal(Socket.instances.length, count, 'cleanup leaves no reconnect work');
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const call = (operation: Operation, options: EntryOptions) => watch(operation === 'join'
    ? client.join(options as JoinOptions) : client.createRoom(options));
  const reject = (socket: Socket, request: Request, code: StageError['code'] = 'unauthorized') => {
    expectedErrors.push(code);
    socket.deliver({ type: 'error', requestId: request.requestId, code, message: 'Test rejection' });
  };
  async function ready() {
    const socket = Socket.instances.at(-1)!;
    assert.ok(socket);
    socket.hello(); await flush(); await tick(0);
    return socket;
  }
  async function succeed(operation: Operation, result: Promise<Outcome>, socket: Socket, request: Request, suffix = 'A') {
    if (operation === 'createRoom') socket.deliver({ type: 'room:created', roomId: `room-${suffix}`, code: `code-${suffix}` });
    acknowledge(socket, request);
    assert.deepEqual(await result, { ok: true, value: operation === 'join' ? undefined : { roomId: `room-${suffix}`, code: `code-${suffix}` } });
  }
  async function resume(socket: Socket) {
    socket.close(); await tick(25);
    const replacement = await ready();
    assert.notEqual(replacement, socket);
    const message = latest(replacement, 'join');
    assert.equal(replacement.sent.length, 1);
    acknowledge(replacement, message); await flush();
    return message;
  }
  return { client, watch, call, reject, ready, succeed, resume, tick };
}

for (const operation of ['createRoom', 'join'] as const) {
  for (const phase of ['hello wait', 'connected microtask', 'deferred pacing'] as const) {
    it(`${operation} snapshots all supplied fields before its ${phase}`, async t => {
      const f = fixture(t), options = inputs(operation), submitted = { ...options };
      if (phase !== 'hello wait') {
        const connecting = f.watch(f.client.connect()); await f.ready();
        assert.equal((await connecting).ok, true);
      }
      if (phase === 'deferred pacing') {
        const prior = f.call('join', inputs('join', 'missing'));
        await flush(); await f.tick(0);
        f.reject(Socket.instances[0]!, latest(Socket.instances[0]!, 'join'));
        assertError(await prior, 'unauthorized');
      }
      const pending = f.call(operation, options), socket = Socket.instances[0]!;
      if (phase === 'deferred pacing') {
        await flush(); await f.tick(99);
        assert.equal(socket.sent.length, 1, 'the new entry still waits for its pacing slot');
      } else assert.equal(socket.sent.length, 0);
      Object.assign(options, inputs(operation, 'B'));
      if (operation === 'createRoom') options.codeRequired = false;
      if (phase === 'hello wait') await f.ready();
      else { await flush(); await f.tick(phase === 'deferred pacing' ? 1 : 0); }
      const request = latest(socket, entryType(operation));
      assert.deepEqual(fields(request), { type: entryType(operation), ...submitted });
      await f.succeed(operation, pending, socket, request);
      assert.deepEqual(fields(await f.resume(socket)), { type: 'join', roomId: 'room-A', name: 'Name A', code: 'code-A' });
    });
  }

  it(`${operation} keeps submitted identity and code with the original seat token after post-wire edits`, async t => {
    const f = fixture(t), options = inputs(operation), pending = f.call(operation, options);
    const socket = await f.ready(), request = latest(socket, entryType(operation));
    assert.deepEqual(fields(request), { type: entryType(operation), ...inputs(operation) });
    Object.assign(options, inputs(operation, 'B'));
    if (operation === 'createRoom') options.codeRequired = false;
    // No controller code overrides the submitted code in this scenario.
    socket.deliver({ type: 'room:state', ...snapshot(operation === 'join' ? 'audience' : 'controller') });
    await f.succeed(operation, pending, socket, request);
    assert.equal(f.client.state?.roomId, 'room-A');
    assert.equal(f.client.me?.name, 'Name A');
    assert.deepEqual(fields(await f.resume(socket)),
      { type: 'join', roomId: 'room-A', name: 'Name A', code: 'code-A', resumeToken: 'seat-A' });
  });

  it(`${operation} lets the latest authoritative controller code override the captured code`, async t => {
    const f = fixture(t), options = inputs(operation), pending = f.call(operation, options);
    const socket = await f.ready(), request = latest(socket, entryType(operation));
    Object.assign(options, inputs(operation, 'B'));
    // Synthetic pre-ACK ordering tests session installation, not server rotation within a request.
    socket.deliver({ type: 'room:state', ...snapshot('controller', 'rotation-one') });
    socket.deliver({ type: 'room:state', ...snapshot('controller', 'rotation-two') });
    await f.succeed(operation, pending, socket, request);
    assert.deepEqual(fields(await f.resume(socket)),
      { type: 'join', roomId: 'room-A', name: 'Name A', code: 'rotation-two', resumeToken: 'seat-A' });
  });

  for (const edit of ['delete', 'add'] as const) {
    it(`${operation} ignores optional fields ${edit === 'delete' ? 'deleted' : 'added'} while waiting for hello`, async t => {
      const f = fixture(t), options = inputs(operation, 'A', edit === 'delete'), submitted = { ...options };
      const pending = f.call(operation, options);
      const optionalFields = operation === 'join' ? ['code'] as const : ['roomName', 'codeRequired', 'token'] as const;
      if (edit === 'delete') for (const key of optionalFields) delete options[key];
      else Object.assign(options, inputs(operation));
      const socket = await f.ready(), request = latest(socket, entryType(operation));
      assert.deepEqual(fields(request), { type: entryType(operation), ...submitted });
      await f.succeed(operation, pending, socket, request);
      const resumed = fields(await f.resume(socket));
      assert.equal(resumed.name, 'Name A');
      if (operation === 'join' && edit === 'add') assert.equal(Object.hasOwn(resumed, 'code'), false);
      else assert.equal(resumed.code, 'code-A');
    });
  }

  it(`${operation} accepts a frozen caller bag without modifying its properties`, async t => {
    const f = fixture(t), options = Object.freeze(inputs(operation)), descriptors = Object.getOwnPropertyDescriptors(options);
    const pending = f.call(operation, options), socket = await f.ready();
    const request = latest(socket, entryType(operation));
    assert.deepEqual(fields(request), { type: entryType(operation), ...options });
    socket.deliver({ type: 'room:state', ...snapshot('controller', 'server-code') });
    await f.succeed(operation, pending, socket, request);
    assert.equal((await f.resume(socket)).code, 'server-code');
    assert.deepEqual(Object.getOwnPropertyDescriptors(options), descriptors);
    assert.equal(Object.isFrozen(options), true);
  });

  it(`${operation} captures fresh fields on a later call reusing the same caller bag`, async t => {
    const f = fixture(t), options = inputs(operation), first = f.call(operation, options);
    Object.assign(options, inputs(operation, 'B'));
    const old = await f.ready();
    assert.deepEqual(fields(latest(old, entryType(operation))), { type: entryType(operation), ...inputs(operation) });
    await f.succeed(operation, first, old, latest(old, entryType(operation)));
    await f.client.disconnect();
    const second = f.call(operation, options);
    Object.assign(options, inputs(operation, 'C'));
    const socket = await f.ready();
    assert.deepEqual(fields(latest(socket, entryType(operation))), { type: entryType(operation), ...inputs(operation, 'B') });
    await f.succeed(operation, second, socket, latest(socket, entryType(operation)), 'B');
    assert.deepEqual(fields(await f.resume(socket)), { type: 'join', roomId: 'room-B', name: 'Name B', code: 'code-B' });
  });

  for (const phase of ['hello wait', 'acknowledged continuation'] as const) {
    it(`${operation} cannot install cancelled options after disconnect during its ${phase}`, async t => {
      const f = fixture(t), options = inputs(operation), first = f.call(operation, options);
      const old = Socket.instances[0]!;
      if (phase === 'acknowledged continuation') {
        await f.ready();
        if (operation === 'createRoom') old.deliver({ type: 'room:created', roomId: 'room-A', code: 'code-A' });
        acknowledge(old, latest(old, entryType(operation)));
      }
      const disconnecting = f.client.disconnect();
      Object.assign(options, inputs(operation, 'B'));
      const fresh = f.call(operation, options);
      Object.assign(options, inputs(operation, 'C'));
      await disconnecting;
      assertError(await first, 'disconnected');
      const socket = await f.ready();
      old.hello();
      old.deliver({ type: 'room:created', roomId: 'retired-room', code: 'retired-code' });
      old.deliver({ type: 'room:state', ...snapshot('controller', 'retired-code') });
      assert.equal(f.client.state, null);
      assert.deepEqual(fields(latest(socket, entryType(operation))), { type: entryType(operation), ...inputs(operation, 'B') });
      await f.succeed(operation, fresh, socket, latest(socket, entryType(operation)), 'B');
      assert.deepEqual(fields(await f.resume(socket)), { type: 'join', roomId: 'room-B', name: 'Name B', code: 'code-B' });
    });
  }

  for (const trigger of ['overlapping call', 'reentrant event'] as const) {
    it(`${operation} gives each ${trigger} its own options without stealing the admitted session`, async t => {
      const f = fixture(t), options = inputs(operation), first = f.call(operation, options);
      let second: Promise<Outcome> | undefined;
      const enterAgain = () => {
        Object.assign(options, inputs(operation, 'B'));
        second = f.call(operation, options);
        Object.assign(options, inputs(operation, 'C'));
      };
      if (trigger === 'overlapping call') enterAgain();
      else {
        const off = f.client.on(operation === 'createRoom' ? 'created' : 'state', () => { off(); enterAgain(); });
      }
      const socket = await f.ready(), request = latest(socket, entryType(operation));
      assert.deepEqual(fields(request), { type: entryType(operation), ...inputs(operation) });
      if (operation === 'createRoom') socket.deliver({ type: 'room:created', roomId: 'room-A', code: 'code-A' });
      else if (trigger === 'reentrant event') socket.deliver({ type: 'room:state', ...snapshot('audience') });
      await flush(); await f.tick(100);
      assert.ok(second);
      assert.deepEqual(fields(latest(socket, entryType(operation))), { type: entryType(operation), ...inputs(operation, 'B') });
      f.reject(socket, latest(socket, entryType(operation)), 'already_joined');
      assertError(await second, 'already_joined');
      acknowledge(socket, request); assert.equal((await first).ok, true);
      const resumed = await f.resume(socket);
      assert.equal(resumed.roomId, 'room-A'); assert.equal(resumed.code, 'code-A'); assert.equal(resumed.name, 'Name A');
    });
  }

  for (const failure of ['hello timeout', 'request timeout', 'server rejection', 'send failure'] as const) {
    it(`${operation} preserves ${failure} after capturing options`, async t => {
      const f = fixture(t), options = inputs(operation), pending = f.call(operation, options);
      Object.assign(options, inputs(operation, 'B'));
      if (failure === 'hello timeout') { await f.tick(1000); assertError(await pending, 'timeout'); return; }
      const socket = Socket.instances[0]!;
      if (failure === 'send failure') socket.send = () => { throw new Error('send failed'); };
      await f.ready();
      if (failure === 'send failure') assertError(await pending, 'disconnected');
      else {
        const request = latest(socket, entryType(operation));
        assert.deepEqual(fields(request), { type: entryType(operation), ...inputs(operation) });
        if (failure === 'server rejection') { f.reject(socket, request); assertError(await pending, 'unauthorized'); }
        else { await f.tick(1000); assertError(await pending, 'timeout'); }
      }
      socket.close(); await f.tick(25);
      assert.equal(Socket.instances.length, 1, 'failed entry cannot install a resumable session');
    });
  }
}

it('full entry admission wins before reading caller fields or invoking connect', async t => {
  const f = fixture(t, { maxPendingControlRequests: 1 });
  const connecting = f.watch(f.client.connect()), socket = await f.ready();
  assert.equal((await connecting).ok, true);
  const occupied = f.watch(f.client.rotateCode());
  const connect = t.mock.method(f.client, 'connect');
  let reads = 0;
  const options = { get name(): string { reads++; throw new Error('options must not be read'); }, roomId: 'room-A' };
  for (const operation of ['createRoom', 'join'] as const) assertError(await f.call(operation, options), 'queue_full');
  assert.equal(reads, 0);
  assert.equal(connect.mock.calls.length, 0);
  assert.equal(Socket.instances.length, 1);
  await f.tick(0); acknowledge(socket, latest(socket, 'room:rotate-code'));
  assert.equal((await occupied).ok, true);
  await f.tick(1000);
  assert.equal(socket.sent.length, 1, 'rejected entries never reserve or send a later request');
});
