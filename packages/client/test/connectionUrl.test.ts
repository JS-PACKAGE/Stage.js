import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it, type TestContext } from 'node:test';
import type { RoomStatePayload } from '../../../shared/protocol.ts';
import { StageClient, type StageClientOptions, type StageError } from '../src/index.ts';

interface Request { type: string; requestId: string; [field: string]: unknown }
const A = 'wss://stage-a.invalid/control';
const B = 'wss://stage-b.invalid/control';
const C = 'wss://stage-c.invalid/control';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  static attempts: string[] = [];
  static failures = new Map<string, Error>();
  readonly url: string;
  readyState = 0;
  sent: Request[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    Socket.attempts.push(url);
    const failure = Socket.failures.get(url);
    if (failure) throw failure;
    this.url = url;
    Socket.instances.push(this);
  }
  send(data: string) { this.sent.push(JSON.parse(data) as Request); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello() {
    this.readyState = Socket.OPEN;
    this.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

/** Hold media offers locally so control-plane recovery never needs a network or microphone. */
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
const entry = (suffix: string) => ({ roomId: `synthetic-room-${suffix}`, code: `synthetic-code-${suffix}`, name: `Synthetic guest ${suffix}` });
const resumePayload = (suffix: string) => ({ type: 'join', ...entry(suffix), resumeToken: `synthetic-seat-${suffix}` });
function fields(request: Request): Omit<Request, 'requestId'> {
  const { requestId: _, ...payload } = request;
  return payload;
}
function latestJoin(socket: Socket): Request {
  const request = socket.sent.filter(message => message.type === 'join').at(-1);
  assert.ok(request, 'expected a join frame on the wire');
  return request;
}
function snapshot(suffix: string): RoomStatePayload {
  return { roomId: entry(suffix).roomId, name: `Synthetic room ${suffix}`, codeRequired: true, recording: false, recordingAvailable: false,
    status: 'live', controllerId: 'synthetic-controller', audienceCount: 1, speakers: [], hands: [],
    resumeToken: `synthetic-seat-${suffix}`, limits: { maxSpeakers: 8, maxAudience: 300 },
    me: { participantId: `synthetic-self-${suffix}`, name: entry(suffix).name, role: 'audience',
      onStage: false, handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
function fixture(t: TestContext) {
  Socket.instances = []; Socket.attempts = []; Socket.failures.clear();
  assert.equal(Peer.offers.size, 0);
  const target = new EventTarget();
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia() { throw new Error('unexpected microphone request'); } },
  } });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const clients: StageClient[] = [], observed: Promise<unknown>[] = [], errors: StageError[] = [];
  const watch = <T>(promise: Promise<T>): Promise<T> => {
    void promise.catch(() => {});
    observed.push(promise);
    return promise;
  };
  const options = (url = A): StageClientOptions => ({ url, requestTimeoutMs: 1000,
    reconnect: { initialDelayMs: 25, maxDelayMs: 25 },
    audioElement: { pause() {}, autoplay: false } as unknown as HTMLAudioElement });
  const make = (bag: StageClientOptions) => {
    const client = new StageClient(bag); clients.push(client);
    client.on('error', event => errors.push(event.detail));
    return client;
  };
  const ready = async (socket: Socket) => { socket.hello(); await flush(); await tick(0); };
  const ack = (socket: Socket, request: Request) => socket.deliver({ type: 'ok', requestId: request.requestId });
  const connect = async (client: StageClient) => {
    const pending = watch(client.connect()), socket = Socket.instances.at(-1)!;
    await ready(socket); await pending;
    return socket;
  };
  const join = async (client: StageClient, suffix = 'A') => {
    const pending = watch(client.join(entry(suffix))), socket = Socket.instances.at(-1)!;
    await ready(socket);
    assert.deepEqual(fields(latestJoin(socket)), { type: 'join', ...entry(suffix) });
    socket.deliver({ type: 'room:state', ...snapshot(suffix) });
    ack(socket, latestJoin(socket)); await pending; await flush();
    assert.equal(client.state?.resumeToken, `synthetic-seat-${suffix}`);
    return socket;
  };
  const finishResume = async (socket: Socket, suffix = 'A') => {
    await ready(socket);
    assert.deepEqual(fields(latestJoin(socket)), resumePayload(suffix));
    socket.deliver({ type: 'room:state', ...snapshot(suffix) });
    ack(socket, latestJoin(socket)); await flush();
  };
  t.after(async () => {
    try {
      for (const client of clients) await client.disconnect();
      await flush(); await Promise.allSettled(observed);
      assert.equal(Peer.offers.size, 0, 'cleanup settles every held media offer');
      assert.equal(getEventListeners(target, 'pagehide').length, 0);
      assert.deepEqual(errors, [], 'no unexpected SDK errors');
      const attempts = Socket.attempts.length;
      await tick(5000);
      assert.equal(Socket.attempts.length, attempts, 'cleanup leaves no reconnect work');
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return { options, make, watch, ready, connect, join, finishResume, tick, target };
}

it('captures the URL before the caller mutates options ahead of the first connect', async t => {
  const f = fixture(t), options = f.options(), client = f.make(options);
  options.url = B;
  const socket = await f.connect(client);
  assert.equal(socket.url, A);
  assert.deepEqual(socket.sent, []);
});

it('isolates destinations and resume credentials when two clients share a reused options bag', async t => {
  const f = fixture(t), options = f.options(), clientA = f.make(options);
  const oldA = await f.join(clientA);
  options.url = B;
  const clientB = f.make(options), oldB = await f.join(clientB, 'B');
  assert.equal(oldA.url, A); assert.equal(oldB.url, B);
  options.url = C;
  for (const [client, old, url, suffix] of [[clientA, oldA, A, 'A'], [clientB, oldB, B, 'B']] as const) {
    old.close(); await f.tick(25);
    const replacement = Socket.instances.at(-1)!;
    assert.notEqual(replacement, old);
    assert.equal(replacement.url, url);
    await f.finishResume(replacement, suffix);
    assert.equal(client.status, 'live');
  }
  for (const socket of Socket.instances) {
    const suffix = socket.url === A ? 'A' : 'B';
    for (const request of socket.sent.filter(message => message.type === 'join')) {
      assert.equal(request.roomId, entry(suffix).roomId);
      assert.equal(request.code, entry(suffix).code);
      assert.equal(request.name, entry(suffix).name);
      if ('resumeToken' in request) assert.equal(request.resumeToken, `synthetic-seat-${suffix}`);
    }
  }
  assert.ok(Socket.instances.every(socket => socket.url === A || socket.url === B));
});

it('keeps the original destination through mutations during backoff and replacement hello', async t => {
  const f = fixture(t), options = f.options(), client = f.make(options);
  const old = await f.join(client);
  old.close();
  assert.equal(client.status, 'reconnecting');
  options.url = B;
  await f.tick(25);
  const replacement = Socket.instances.at(-1)!;
  assert.equal(replacement.url, A);
  assert.deepEqual(replacement.sent, []);
  options.url = C;
  await f.finishResume(replacement);
  replacement.close(); await f.tick(25);
  const next = Socket.instances.at(-1)!;
  assert.notEqual(next, replacement);
  assert.equal(next.url, A);
  await f.finishResume(next);
  assert.equal(client.status, 'live');
  assert.deepEqual(Socket.attempts, [A, A, A]);
});

it('keeps the captured URL after repeated disconnects and gives fresh options to a new client', async t => {
  const f = fixture(t), options = f.options(), client = f.make(options);
  await f.join(client);
  for (const changedUrl of [B, C]) {
    await client.disconnect();
    options.url = changedUrl;
    const socket = await f.connect(client);
    assert.equal(socket.url, A);
    assert.deepEqual(socket.sent, [], 'explicit disconnect discards the old room credentials');
    assert.equal(client.state, null);
  }
  const fresh = f.make(f.options(B)), socket = await f.join(fresh, 'B');
  assert.equal(socket.url, B);
  assert.deepEqual(fields(latestJoin(socket)), { type: 'join', ...entry('B') });
});

it('passes the captured string to WebSocket without URL normalization or resolution', async t => {
  const f = fixture(t);
  for (const url of ['WSS://STAGE-A.INVALID:443/control?opaque=%2f', '/control?opaque=%2f']) {
    const socket = await f.connect(f.make(f.options(url)));
    assert.equal(socket.url, url);
  }
});

it('defers URL rejection to WebSocket at connect and preserves its original error', async t => {
  const f = fixture(t), invalidUrl = 'wss://[';
  const failure = new DOMException('synthetic WebSocket URL rejection', 'SyntaxError');
  Socket.failures.set(invalidUrl, failure);
  const options = f.options(invalidUrl), client = f.make(options);
  assert.deepEqual(Socket.attempts, [], 'constructing a client does not create or validate a socket');
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = f.watch(client.connect());
    await assert.rejects(pending, error => error === failure);
    await flush();
    assert.equal(getEventListeners(f.target, 'pagehide').length, 0);
  }
  assert.deepEqual(Socket.attempts, [invalidUrl, invalidUrl]);
  assert.equal(Socket.instances.length, 0);
  assert.equal((await f.connect(f.make(f.options()))).url, A);
});

it('preserves timer validation priority before reading the URL or mutating supplied audio', t => {
  const f = fixture(t);
  for (const invalid of [{ requestTimeoutMs: 0 }, { reconnect: { initialDelayMs: -1, maxDelayMs: 25 } }]) {
    const options = { ...f.options(), ...invalid };
    let urlReads = 0;
    Object.defineProperty(options, 'url', { get() { urlReads++; throw new Error('URL read too early'); } });
    assert.throws(() => new StageClient(options), RangeError);
    assert.equal(urlReads, 0);
    assert.equal(options.audioElement!.autoplay, false);
  }
  assert.deepEqual(Socket.attempts, []);
});

it('retains caller-live microphone constraints while capturing only the connection URL', async t => {
  const f = fixture(t), captures: MediaStreamConstraints[] = [], denied = new Error('synthetic capture rejection');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia(constraints: MediaStreamConstraints) {
      captures.push(structuredClone(constraints)); return Promise.reject(denied);
    } },
  } });
  const constraints = { echoCancellation: true, deviceId: { exact: 'synthetic-device-A' } };
  const options = f.options(); options.micConstraints = constraints;
  const client = f.make(options);
  await assert.rejects(client.startMicTest(), error => error === denied);
  constraints.echoCancellation = false; constraints.deviceId.exact = 'synthetic-device-B';
  await assert.rejects(client.startMicTest(), error => error === denied);
  options.micConstraints = { noiseSuppression: false, deviceId: { exact: 'synthetic-device-C' } };
  await assert.rejects(client.startMicTest(), error => error === denied);
  const defaults = { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  assert.deepEqual(captures, [
    { audio: { ...defaults, deviceId: { exact: 'synthetic-device-A' } } },
    { audio: { ...defaults, echoCancellation: false, deviceId: { exact: 'synthetic-device-B' } } },
    { audio: { ...defaults, noiseSuppression: false, deviceId: { exact: 'synthetic-device-C' } } },
  ]);
});
