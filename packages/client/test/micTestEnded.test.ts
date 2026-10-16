import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it, type TestContext } from 'node:test';
import { StageClient, StageError, type MicTest, type StageClientOptions } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { for (let n = 0; n < 48; n++) await Promise.resolve(); };
class Track extends EventTarget {
  enabled = true;
  readyState: MediaStreamTrackState = 'live';
  stops = 0;
  onStop: (() => void) | undefined;
  stop() { this.stops++; this.readyState = 'ended'; this.onStop?.(); }
  end() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}
function stream() {
  const track = new Track();
  return { track, value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
const endedListeners = (source: ReturnType<typeof stream>) => getEventListeners(source.track, 'ended');
function replayEnded(source: ReturnType<typeof stream>, callbacks: ReturnType<typeof endedListeners>) {
  for (const callback of callbacks) Reflect.apply(callback, source.track, [new Event('ended')]);
}
type Phase = 'constructor' | 'source' | 'analyser' | 'resume';
class Context {
  static instances: Context[] = [];
  static onPhase: ((phase: Phase) => void) | undefined;
  static onDispose: (() => void) | undefined;
  closes = 0;
  sourceDisconnects = 0;
  analyserDisconnects = 0;
  reads = 0;
  constructor() { Context.instances.push(this); Context.onPhase?.('constructor'); }
  createMediaStreamSource() {
    Context.onPhase?.('source');
    return { connect() {}, disconnect: () => { this.sourceDisconnects++; Context.onDispose?.(); } };
  }
  createAnalyser() {
    Context.onPhase?.('analyser');
    return { fftSize: 0, disconnect: () => { this.analyserDisconnects++; Context.onDispose?.(); },
      getFloatTimeDomainData: (samples: Float32Array) => { this.reads++; samples.fill(0.25); } };
  }
  async resume() { Context.onPhase?.('resume'); }
  async close() { this.closes++; Context.onDispose?.(); }
}
function state(onStage: boolean): RoomStatePayload {
  return { roomId: 'room', name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', resumeToken: 'test-resume-token',
    me: { participantId: 'guest', name: 'Guest', role: onStage ? 'speaker' : 'audience', onStage,
      handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
  onStage = false;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    Socket.instances.push(this);
    queueMicrotask(() => this.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } }));
  }
  deliver(message: ServerMessage) {
    if (message.type === 'room:state') this.onStage = message.me.onStage;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(data: string) {
    assert.equal(this.readyState, Socket.OPEN);
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.type === 'join') this.deliver({ type: 'room:state', ...state(false) });
      if (message.type === 'rtc:offer') {
        if (!this.onStage && message.payload.sdp.includes('a=sendrecv')) {
          this.deliver({ type: 'error', requestId: message.requestId, code: 'forbidden', message: '禁止此操作。' });
          return;
        }
        this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
      }
      if ('requestId' in message) this.deliver({ type: 'ok', requestId: message.requestId });
    });
  }
  close() { this.readyState = 3; this.onclose?.(); }
}
class Peer {
  static instances: Peer[] = [];
  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly replacements: (MediaStreamTrack | null)[] = [];
  offers = 0;
  readonly transceiver = { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
    replaceTrack: async (track: MediaStreamTrack | null) => {
      this.replacements.push(track); this.transceiver.sender.track = track;
    } } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offers++;
    return { type: 'offer', sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description; this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description; this.signalingState = 'stable';
  }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}

/** Public SDK lifecycle with fake browser APIs; resource counts are not native audio or GC measurements. */
function setup(t: TestContext, options: { holdCapture?: boolean; clientOptions?: Partial<StageClientOptions> } = {}) {
  Socket.instances = []; Peer.instances = []; Context.instances = []; Context.onPhase = undefined; Context.onDispose = undefined;
  const sources: ReturnType<typeof stream>[] = [], supplied: ReturnType<typeof stream>[] = [];
  const requests: ReturnType<typeof deferred<MediaStream>>[] = [];
  const constraints: MediaStreamConstraints[] = [];
  const sampleLengths: number[] = [], NativeSamples = Float32Array;
  class Samples extends NativeSamples { constructor(length: number) { super(length); sampleLengths.push(length); } }
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'AudioContext', 'navigator', 'Float32Array']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: new EventTarget(), WebSocket: Socket,
    RTCPeerConnection: Peer, AudioContext: Context, Float32Array: Samples,
    navigator: { mediaDevices: { getUserMedia: (requestConstraints: MediaStreamConstraints) => {
      constraints.push(requestConstraints);
      if (options.holdCapture) { const request = deferred<MediaStream>(); requests.push(request); return request.promise; }
      const source = supplied.shift() ?? stream(); sources.push(source); return Promise.resolve(source.value);
    } } } })) Object.defineProperty(globalThis, name, { configurable: true, value });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms = 1) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  async function until(predicate: () => boolean, label: string) {
    for (let n = 0; n < 40; n++) { if (predicate()) return; await tick(); }
    assert.ok(predicate(), `bounded fake-time wait: ${label}`);
  }
  async function complete<T>(promise: Promise<T>, label: string): Promise<T> {
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    await until(() => settled, label); return promise;
  }
  const client = new StageClient({ url: 'ws://localhost/ws', audioElement: { volume: 1, muted: false, pause() {}, srcObject: null } as unknown as HTMLAudioElement,
    requestTimeoutMs: 1000, ...options.clientOptions });
  const errors: unknown[] = [], micErrors: unknown[] = [];
  let ready = 0;
  client.on('error', event => errors.push(event.detail));
  client.on('micerror', event => micErrors.push(event.detail));
  client.on('micready', () => { ready++; });
  t.after(async () => {
    Context.onDispose = undefined;
    await client.disconnect(); await flush();
    const cleanListeners = sources.every(source => endedListeners(source).length === 0);
    const cleanMeters = Context.instances.every(context => context.closes === 1);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    assert.ok(cleanListeners, 'disconnect removes all SDK ended listeners');
    assert.ok(cleanMeters, 'every created meter closes exactly once');
  });
  async function joinSpeaker() {
    await complete(client.join({ roomId: 'room', name: 'Guest' }), 'public join');
    const socket = Socket.instances.at(-1)!, peer = Peer.instances.at(-1)!;
    await until(() => peer.remoteDescription !== null && !client['negotiating'], 'audience negotiation');
    socket.deliver({ type: 'room:state', ...state(true) });
    await until(() => peer.transceiver.direction === 'sendrecv' && peer.signalingState === 'stable'
      && peer.transceiver.sender.track !== null && !client['negotiating'], 'speaker capture');
    return { socket, peer };
  }
  return { client, sources, supplied, requests, constraints, sampleLengths, errors, micErrors, ready: () => ready, tick, joinSpeaker };
}
const isEnded = (error: unknown) => error instanceof DOMException && error.name === 'NotReadableError';
const isDisconnected = (error: unknown) => error instanceof StageError && error.code === 'disconnected';
function assertDisposed(source: ReturnType<typeof stream>, context: Context, signal?: AbortSignal) {
  assert.equal(source.track.stops, 1);
  assert.equal(context.closes, 1);
  assert.equal(context.sourceDisconnects, 1);
  assert.equal(context.analyserDisconnects, 1);
  assert.equal(endedListeners(source).length, 0);
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
}
function assertQuiet(h: ReturnType<typeof setup>, captures = 1) {
  assert.deepEqual(h.errors, []); assert.deepEqual(h.micErrors, []);
  assert.equal(h.constraints.length, captures, 'preview ending does not acquire a replacement');
  assert.equal(h.client['micTestRequests'].size, 0);
}

it('keeps stopped optional and readonly for older structural MicTest implementations', () => {
  const legacy: MicTest = { level: () => 0.125, stop() {} };
  const stopped: boolean | undefined = legacy.stopped;
  assert.equal(stopped, undefined); assert.equal(legacy.level(), 0.125); legacy.stop();
  if (false) {
    // @ts-expect-error The optional status is observation-only, including on older structural implementations.
    legacy.stopped = true;
  }
});

it('exposes stopped as a getter without a setter or observation-triggered audio work', async t => {
  const h = setup(t), controller = new AbortController();
  const preview = await h.client.startMicTest({ signal: controller.signal }), source = h.sources[0]!, context = Context.instances[0]!;
  const descriptor = Object.getOwnPropertyDescriptor(preview, 'stopped');
  assert.equal(typeof descriptor?.get, 'function'); assert.equal(descriptor?.set, undefined);
  assert.equal(Reflect.set(preview, 'stopped', true), false, 'a caller cannot overwrite the live flag');
  for (let n = 0; n < 100; n++) assert.equal(preview.stopped, false);
  assert.equal(context.reads, 0); assert.equal(context.closes, 0);
  assert.equal(context.sourceDisconnects, 0); assert.equal(context.analyserDisconnects, 0); assert.equal(source.track.stops, 0);
  assert.equal(endedListeners(source).length, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  assert.equal(h.ready(), 1); assert.equal(h.client['micTests'].size, 1); assert.deepEqual(h.sampleLengths, [2048]);
  preview.stop();
  assert.equal(Reflect.set(preview, 'stopped', false), false, 'a caller cannot revive the terminal flag');
  for (let n = 0; n < 100; n++) assert.equal(preview.stopped, true);
  assert.equal(context.reads, 0); assert.deepEqual(h.sampleLengths, [2048]); assert.equal(h.ready(), 1);
  assertDisposed(source, context, controller.signal); assertQuiet(h);
});

it('reports stopped while asynchronous meter close is still pending', async t => {
  const h = setup(t), controller = new AbortController();
  const preview = await h.client.startMicTest({ signal: controller.signal }), source = h.sources[0]!, context = Context.instances[0]!;
  const finishClose = deferred<void>(), originalClose = context.close.bind(context);
  let closeCompleted = false;
  t.mock.method(context, 'close', async () => {
    await originalClose(); await finishClose.promise; closeCompleted = true;
  });
  try {
    assert.equal(preview.stopped, false);
    preview.stop();
    assert.equal(preview.stopped, true); assert.equal(closeCompleted, false);
    assertDisposed(source, context, controller.signal);
    await flush();
    assert.equal(preview.stopped, true); assert.equal(closeCompleted, false, 'stopped does not wait for AudioContext.close');
    preview.stop(); controller.abort(); await h.client.disconnect();
    assert.equal(preview.stopped, true); assert.equal(closeCompleted, false);
    assert.equal(preview.level(), 0); assert.equal(context.reads, 0);
    assertDisposed(source, context, controller.signal); assertQuiet(h);
  } finally {
    finishClose.resolve(undefined); await flush();
  }
  assert.equal(closeCompleted, true); assert.equal(preview.stopped, true);
  assertDisposed(source, context, controller.signal);
});

it('rejects an already-ended grant before allocating a preview meter or emitting micready', async t => {
  const h = setup(t), source = stream(), controller = new AbortController();
  source.track.end(); h.supplied.push(source);
  await assert.rejects(h.client.startMicTest({ signal: controller.signal }), isEnded);
  assert.equal(Context.instances.length, 0); assert.deepEqual(h.sampleLengths, []);
  assert.equal(h.ready(), 0); assert.equal(h.client['micTests'].size, 0);
  assert.equal(source.track.stops, 1); assert.equal(endedListeners(source).length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(); await h.client.disconnect(); assert.equal(source.track.stops, 1);
  assertQuiet(h);
});

for (const phase of ['constructor', 'source', 'analyser', 'resume'] as const) {
  it(`rejects a preview ending during meter ${phase} and disposes the constructed graph`, async t => {
    const h = setup(t), source = stream(), controller = new AbortController(); h.supplied.push(source);
    Context.onPhase = current => { if (current === phase) source.track.end(); };
    await assert.rejects(h.client.startMicTest({ signal: controller.signal }), isEnded);
    assert.equal(h.ready(), 0); assert.equal(h.client['micTests'].size, 0);
    assertDisposed(source, Context.instances[0]!, controller.signal);
    assert.equal(Context.instances[0]!.reads, 0);
    source.track.dispatchEvent(new Event('ended')); controller.abort(); await h.client.disconnect();
    assertDisposed(source, Context.instances[0]!, controller.signal); assertQuiet(h);
  });
}

for (const cancellation of ['abort', 'disconnect'] as const) {
  it(`preserves ${cancellation} ahead of a late already-ended grant`, async t => {
    const h = setup(t, { holdCapture: true }), source = stream(), controller = new AbortController(), reason = new Error('caller cancellation');
    source.track.end();
    const pending = h.client.startMicTest({ signal: controller.signal });
    const rejection = assert.rejects(pending, cancellation === 'abort' ? error => error === reason : isDisconnected);
    if (cancellation === 'abort') controller.abort(reason); else await h.client.disconnect();
    await rejection; h.requests[0]!.resolve(source.value); await flush();
    assert.equal(source.track.stops, 1); assert.equal(Context.instances.length, 0);
    assert.equal(h.ready(), 0); assert.equal(h.client['micTests'].size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assertQuiet(h);
  });
  for (const phase of ['constructor', 'source', 'analyser', 'resume'] as const) {
    for (const endFirst of [false, true]) it(`preserves ${cancellation} during ${phase}, end ${endFirst ? 'first' : 'last'}`, async t => {
      const h = setup(t), source = stream(), controller = new AbortController(), reason = new Error('caller cancellation'); h.supplied.push(source);
      Context.onPhase = current => {
        if (current !== phase) return;
        if (endFirst) source.track.end();
        if (cancellation === 'abort') controller.abort(reason); else void h.client.disconnect();
        if (!endFirst) source.track.end();
      };
      await assert.rejects(h.client.startMicTest({ signal: controller.signal }), cancellation === 'abort' ? error => error === reason : isDisconnected);
      assert.equal(h.ready(), 0); assert.equal(h.client['micTests'].size, 0);
      assertDisposed(source, Context.instances[0]!, controller.signal); assertQuiet(h);
    });
  }
}

it('binds the ended listener before micready and returns a stopped handle when the callback ends capture', async t => {
  const h = setup(t), source = stream(), controller = new AbortController(); h.supplied.push(source);
  let atReady: number[] = [];
  h.client.on('micready', () => {
    atReady = [endedListeners(source).length, getEventListeners(controller.signal, 'abort').length, h.client['micTests'].size];
    source.track.end();
  });
  const preview = await h.client.startMicTest({ signal: controller.signal });
  assert.deepEqual(atReady, [1, 1, 1]); assert.equal(h.ready(), 1);
  assert.equal(preview.stopped, true);
  assertDisposed(source, Context.instances[0]!, controller.signal);
  assert.equal(h.client['micTests'].size, 0); assert.equal(preview.level(), 0); assert.equal(Context.instances[0]!.reads, 0);
  preview.stop(); controller.abort(); await h.client.disconnect();
  assert.equal(preview.stopped, true);
  assertDisposed(source, Context.instances[0]!, controller.signal); assertQuiet(h);
});

it('returns a stopped handle when micready calls track.stop without an ended event', async t => {
  const h = setup(t), source = stream(), controller = new AbortController(); h.supplied.push(source);
  let endedEvents = 0;
  const observeEnd = () => { endedEvents++; };
  source.track.addEventListener('ended', observeEnd);
  h.client.on('micready', () => source.track.stop());
  const preview = await h.client.startMicTest({ signal: controller.signal }), context = Context.instances[0]!;
  assert.equal(h.ready(), 1); assert.equal(endedEvents, 0);
  assert.equal(preview.stopped, true);
  assert.deepEqual(endedListeners(source), [observeEnd]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(source.track.stops, 2, 'one application stop plus one SDK teardown stop');
  assert.equal(context.closes, 1); assert.equal(context.sourceDisconnects, 1); assert.equal(context.analyserDisconnects, 1);
  assert.equal(preview.level(), 0); assert.equal(context.reads, 0); assert.equal(h.client['micTests'].size, 0);
  preview.stop(); controller.abort(); await h.client.disconnect();
  assert.equal(preview.stopped, true);
  assert.equal(source.track.stops, 2); assert.equal(context.closes, 1); assertQuiet(h);
  source.track.removeEventListener('ended', observeEnd);
});

for (const cancellation of ['abort', 'disconnect'] as const) for (const endFirst of [false, true]) {
  it(`preserves ${cancellation} in micready when natural end is ${endFirst ? 'first' : 'last'}`, async t => {
    const h = setup(t), source = stream(), controller = new AbortController(), reason = new Error('callback cancellation'); h.supplied.push(source);
    h.client.on('micready', () => {
      if (endFirst) source.track.end();
      if (cancellation === 'abort') controller.abort(reason); else void h.client.disconnect();
      if (!endFirst) source.track.end();
    });
    await assert.rejects(h.client.startMicTest({ signal: controller.signal }), cancellation === 'abort' ? error => error === reason : isDisconnected);
    assert.equal(h.ready(), 1); assert.equal(h.client['micTests'].size, 0);
    assertDisposed(source, Context.instances[0]!, controller.signal); assertQuiet(h);
  });
}

for (const during of ['constructor', 'micready'] as const) for (const abortFirst of [false, true]) {
  it(`keeps the caller abort reason ahead of disconnect and end in ${during}, abort ${abortFirst ? 'first' : 'last'}`, async t => {
    const h = setup(t), source = stream(), controller = new AbortController(), reason = new Error('original caller reason'); h.supplied.push(source);
    const cancel = () => {
      source.track.end();
      if (abortFirst) controller.abort(reason);
      void h.client.disconnect();
      if (!abortFirst) controller.abort(reason);
    };
    if (during === 'constructor') Context.onPhase = phase => { if (phase === 'constructor') cancel(); };
    else h.client.on('micready', cancel);
    await assert.rejects(h.client.startMicTest({ signal: controller.signal }), error => error === reason);
    assert.equal(h.ready(), during === 'micready' ? 1 : 0); assert.equal(h.client['micTests'].size, 0);
    assertDisposed(source, Context.instances[0]!, controller.signal); assertQuiet(h);
  });
}

for (const ending of ['natural', 'manual', 'abort', 'disconnect'] as const) {
  it(`${ending} removes owned listeners before graph/track teardown and makes stale callbacks inert`, async t => {
    const h = setup(t), controller = new AbortController();
    const preview = await h.client.startMicTest({ signal: controller.signal }), source = h.sources[0]!, context = Context.instances[0]!;
    assert.equal(preview.stopped, false);
    const staleEnded = endedListeners(source), staleAbort = getEventListeners(controller.signal, 'abort');
    assert.equal(staleEnded.length, 1); assert.equal(staleAbort.length, 1);
    assert.equal(preview.level(), 0.25); assert.deepEqual(h.sampleLengths, [2048]);
    const disposalListeners: number[][] = [], disposalStopped: (boolean | undefined)[] = [];
    const observe = () => {
      disposalListeners.push([endedListeners(source).length, getEventListeners(controller.signal, 'abort').length]);
      disposalStopped.push(preview.stopped);
    };
    Context.onDispose = observe; source.track.onStop = observe;
    if (ending === 'natural') source.track.end();
    else if (ending === 'manual') preview.stop();
    else if (ending === 'abort') controller.abort();
    else await h.client.disconnect();
    assert.deepEqual(disposalListeners, [[0, 0], [0, 0], [0, 0], [0, 0]]);
    assert.deepEqual(disposalStopped, [true, true, true, true], 'the terminal flag is visible before every teardown callback');
    assert.equal(preview.stopped, true);
    assertDisposed(source, context, controller.signal); assert.equal(h.client['micTests'].size, 0);
    for (let n = 0; n < 100; n++) { assert.equal(preview.stopped, true); assert.equal(preview.level(), 0); }
    assert.equal(context.reads, 1, 'stopped handle performs no further analyser reads');
    source.track.dispatchEvent(new Event('ended')); replayEnded(source, staleEnded);
    for (const callback of staleAbort) Reflect.apply(callback, controller.signal, [new Event('abort')]);
    preview.stop(); preview.stop(); controller.abort(); await h.client.disconnect();
    assert.equal(preview.stopped, true); assert.equal(context.reads, 1);
    assertDisposed(source, context, controller.signal); assert.equal(disposalListeners.length, 4); assertQuiet(h);
  });
}

it('naturally stops no-option previews and preserves unrelated application track listeners', async t => {
  const h = setup(t), source = stream(); h.supplied.push(source);
  let applicationEnds = 0;
  const applicationListener = () => { applicationEnds++; };
  source.track.addEventListener('ended', applicationListener);
  const preview = await h.client.startMicTest();
  assert.equal(preview.stopped, false);
  assert.equal(endedListeners(source).length, 2);
  source.track.end();
  assert.equal(preview.stopped, true);
  assert.deepEqual(endedListeners(source), [applicationListener]); assert.equal(applicationEnds, 1);
  assert.equal(preview.level(), 0); assert.equal(h.client['micTests'].size, 0);
  source.track.dispatchEvent(new Event('ended')); assert.equal(applicationEnds, 2);
  source.track.removeEventListener('ended', applicationListener);
  assertDisposed(source, Context.instances[0]!); assertQuiet(h);
});

for (const meter of ['default', 'disabled'] as const) {
  it(`isolates natural-ended previews, stale callbacks and restarted previews from a public room with ${meter} metering`, async t => {
    const h = setup(t, { clientOptions: meter === 'disabled' ? { enableMicMeter: false } : {} });
    const { peer } = await h.joinSpeaker(), room = h.sources[0]!;
    const roomContext = meter === 'default' ? Context.instances[0]! : undefined;
    const first = new AbortController(), second = new AbortController();
    const pendingA = h.client.startMicTest({ signal: first.signal }), pendingB = h.client.startMicTest({ signal: second.signal });
    const [a, b] = await Promise.all([pendingA, pendingB]);
    assert.equal(a.stopped, false); assert.equal(b.stopped, false);
    const aSource = h.sources[1]!, bSource = h.sources[2]!;
    const aContext = Context.instances.at(-2)!, bContext = Context.instances.at(-1)!;
    const staleEnded = endedListeners(aSource);
    const before = { replacements: peer.replacements.length, offers: peer.offers, calls: h.constraints.length };
    const roomLevel = meter === 'default' ? 0.25 : 0;
    assert.equal(Context.instances.length, meter === 'default' ? 3 : 2);
    assert.equal(h.client.micLevel, roomLevel); assert.equal(endedListeners(room).length, 1);
    const roomReads = roomContext?.reads;
    aSource.track.end(); await h.tick(50);
    assert.equal(a.stopped, true); assert.equal(b.stopped, false);
    assertDisposed(aSource, aContext, first.signal); assert.equal(a.level(), 0);
    assert.equal(b.level(), 0.25); assert.equal(bSource.track.stops, 0); assert.equal(bContext.closes, 0);
    assert.equal(endedListeners(bSource).length, 1); assert.equal(getEventListeners(second.signal, 'abort').length, 1);
    assert.equal(h.client['micTests'].size, 1); assert.equal(h.client.retryMicrophone(), false);
    assert.equal(room.track.stops, 0); assert.equal(roomContext?.closes ?? 0, 0); assert.equal(roomContext?.reads, roomReads);
    assert.equal(peer.transceiver.sender.track, room.track); assert.equal(endedListeners(room).length, 1);
    assert.deepEqual({ replacements: peer.replacements.length, offers: peer.offers, calls: h.constraints.length }, before);
    const replacement: MicTest = await h.client.startMicTest(), replacementSource = h.sources[3]!, replacementContext = Context.instances.at(-1)!;
    assert.equal(replacement.stopped, false);
    replayEnded(aSource, staleEnded); a.stop(); first.abort();
    assert.equal(a.stopped, true); assert.equal(b.stopped, false); assert.equal(replacement.stopped, false);
    assert.equal(h.client['micTests'].size, 2); assert.equal(b.level(), 0.25); assert.equal(replacement.level(), 0.25);
    assert.equal(bSource.track.stops, 0); assert.equal(replacementSource.track.stops, 0);
    second.abort(); b.stop(); assertDisposed(bSource, bContext, second.signal);
    assert.equal(a.stopped, true); assert.equal(b.stopped, true); assert.equal(replacement.stopped, false);
    assert.equal(h.client['micTests'].size, 1); assert.equal(replacement.level(), 0.25);
    replacementSource.track.end(); replacement.stop(); assertDisposed(replacementSource, replacementContext);
    assert.equal(a.stopped, true); assert.equal(b.stopped, true); assert.equal(replacement.stopped, true);
    assert.equal(h.client['micTests'].size, 0); assert.equal(h.client.micLevel, roomLevel);
    assert.equal(room.track.stops, 0); assert.equal(roomContext?.closes ?? 0, 0);
    assert.equal(peer.replacements.length, before.replacements); assert.equal(peer.offers, before.offers);
    assertQuiet(h, before.calls + 1);
    await h.client.disconnect(); await h.client.disconnect();
    assert.equal(a.stopped, true); assert.equal(b.stopped, true); assert.equal(replacement.stopped, true);
    assert.equal(room.track.stops, 1); assert.equal(endedListeners(room).length, 0);
    if (roomContext) assert.equal(roomContext.closes, 1);
    assertDisposed(aSource, aContext, first.signal); assertDisposed(bSource, bContext, second.signal);
    assertDisposed(replacementSource, replacementContext);
  });
}
