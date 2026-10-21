import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';

type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'find' | 'id' | 'clock'>;
const notices = (h: View) => h.find(node => node.classList.contains('notices'));
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
const stageState = () => roomState({ role: 'speaker', onStage: true });
const failure = { name: 'NotAllowedError', message: '麥克風權限遭拒。' };
const originalNotice = `${failure.message}（${failure.name}）`;
const pendingNotice = '已要求重試麥克風，等待擷取結果。';
function noRetry(h: View): void { assert.equal(h.app.descendants().filter(node => node.id === 'mic-retry').length, 0); }
function retry(h: View, pending = false, disabled = pending): SampleNode {
  const node = h.id('mic-retry');
  assert.equal(node.tagName, 'button'); assert.equal(node.type, 'button');
  assert.equal(node.textContent, '重試麥克風'); assert.equal(node.hidden, false);
  assert.equal(node.disabled, disabled); assert.equal(node.attributes['aria-busy'], String(pending));
  if (pending) assert.ok(notices(h).textContent.includes(pendingNotice));
  return node;
}
function invoke(node: SampleNode): void { assert.ok(node.onclick); node.onclick(); }
function changeInput(h: View, value: string): void {
  const node = h.id('microphone-device'); assert.ok(node.onchange); node.value = value; node.onchange();
}
function fakeSetup(t: TestContext) {
  const h = sampleApp(); let calls = 0, behavior = () => true;
  Object.assign(h.sdk, { retryMicrophone() { calls++; return behavior(); } });
  t.after(() => h.cleanup());
  return { ...h, calls: () => calls, admission(action: () => boolean) { behavior = action; } };
}

it('whole sample offers retry only after an onstage microphone failure and never retries from ordinary events', async t => {
  const h = fakeSetup(t); await flushSample(); noRetry(h);
  h.sdk.emit('micerror', failure); noRetry(h);
  h.sdk.snapshot(roomState()); h.sdk.emit('micerror', failure); noRetry(h);
  h.sdk.emit('micready', undefined); noRetry(h);
  h.sdk.snapshot(stageState()); noRetry(h);
  h.sdk.emit('micerror', failure); retry(h);
  assert.equal(notices(h).textContent, originalNotice + '重試麥克風');
  for (let n = 0; n < 3; n++) h.sdk.snapshot(stageState());
  h.dispatchDeviceChange(); changeInput(h, 'mic-a');
  h.sdk.emit('invite', { participantId: 'same-person' });
  h.sdk.emit('audioblocked', undefined); h.sdk.emit('quality', { participants: [] });
  h.clock.advance(5000); await flushSample();
  assert.equal(h.calls(), 0); assert.equal(h.sdk.previews.length, 0); retry(h);
  h.sdk.emit('micready', undefined); noRetry(h);
  assert.ok(!notices(h).textContent.includes(originalNotice)); assert.equal(h.calls(), 0);
});

it('whole sample reserves one retry synchronously and preserves pending state across redraws and reconnect', async t => {
  const h = fakeSetup(t); h.sdk.snapshot(stageState()); h.sdk.emit('micerror', failure);
  h.sdk.emit('error', { message: '保留其他操作的錯誤。' });
  const old = retry(h); old.click(); assert.equal(h.calls(), 1); retry(h, true);
  invoke(old); invoke(retry(h, true)); assert.equal(h.calls(), 1);
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '保留其他操作的錯誤。');
  h.sdk.snapshot(stageState()); h.sdk.emit('audioblocked', undefined);
  h.sdk.emit('invite', { participantId: 'same-person' });
  const pending = retry(h, true); assert.equal(old.isConnected, false);
  h.sdk.setStatus('reconnecting'); retry(h, true); invoke(pending);
  h.sdk.snapshot(stageState()); retry(h, true);
  h.dispatchDeviceChange(); h.clock.advance(5000); await flushSample();
  retry(h, true); assert.equal(h.calls(), 1);
  const volume = h.id('playback-volume'); assert.equal(volume.disabled, false); assert.ok(volume.oninput);
  volume.value = '37'; volume.oninput(); h.id('playback-mute').click(); await flushSample();
  assert.equal(h.sdk.playbackVolume, 0.37); assert.equal(h.sdk.playbackMuted, true); retry(h, true);
  h.sdk.emit('micerror', { name: 'NotFoundError', message: '找不到麥克風。' });
  retry(h); assert.equal(notices(h).textContent.includes(pendingNotice), false);
  assert.ok(notices(h).textContent.includes('找不到麥克風。（NotFoundError）'));
  retry(h).click(); assert.equal(h.calls(), 2); retry(h, true);
  h.sdk.emit('micready', undefined); noRetry(h);
  assert.equal(notices(h).textContent.includes(pendingNotice), false);
  assert.equal(h.sdk.playbackVolume, 0.37); assert.equal(h.sdk.playbackMuted, true);
});

it('whole sample disables an eligible retry during reconnect and restores it on live without calling the SDK', t => {
  const h = fakeSetup(t); h.sdk.snapshot(stageState()); h.sdk.emit('micerror', failure);
  const old = retry(h); h.sdk.setStatus('reconnecting'); retry(h, false, true); invoke(old);
  h.sdk.emit('audioblocked', undefined); invoke(retry(h, false, true));
  assert.equal(h.calls(), 0); h.sdk.snapshot(stageState()); retry(h); assert.equal(h.calls(), 0);
  retry(h).click(); assert.equal(h.calls(), 1); retry(h, true);
});

it('whole sample false retry admission preserves its original microphone notice and remains retryable', t => {
  const h = fakeSetup(t); h.sdk.snapshot(stageState()); h.sdk.emit('micerror', failure);
  h.admission(() => false);
  retry(h).click(); retry(h); assert.equal(h.calls(), 1);
  assert.equal(notices(h).textContent, originalNotice + '重試麥克風'); assert.equal(errorBox(h).hidden, true);
  retry(h).click(); retry(h); assert.equal(h.calls(), 2);
  h.admission(() => true); retry(h).click(); retry(h, true); assert.equal(h.calls(), 3);
});

for (const event of ['micready', 'micerror'] as const) {
  it(`whole sample keeps a synchronous ${event} outcome when retry admission returns true`, t => {
    const h = fakeSetup(t); h.sdk.snapshot(stageState()); h.sdk.emit('micerror', failure);
    h.admission(() => {
      retry(h, true);
      if (event === 'micready') h.sdk.emit('micready', undefined);
      else h.sdk.emit('micerror', { name: 'NotReadableError', message: '麥克風仍無法使用。' });
      return true;
    });
    retry(h).click(); assert.equal(h.calls(), 1);
    assert.equal(notices(h).textContent.includes(pendingNotice), false);
    if (event === 'micready') { noRetry(h); assert.equal(notices(h).textContent, ''); }
    else { retry(h); assert.equal(notices(h).textContent, '麥克風仍無法使用。（NotReadableError）重試麥克風'); }
  });
}

for (const pending of [false, true]) {
  it(`whole sample stage exit clears ${pending ? 'pending' : 'eligible'} retry and does not revive it on the next promotion`, t => {
    const h = fakeSetup(t); h.sdk.snapshot(stageState()); h.sdk.emit('micerror', failure);
    if (pending) retry(h).click();
    const old = retry(h, pending), calls = h.calls();
    const offstage = roomState(); offstage.status = 'live'; h.sdk.snapshot(offstage); noRetry(h);
    assert.ok(!notices(h).textContent.includes(pendingNotice)); invoke(old);
    h.sdk.snapshot(stageState()); noRetry(h); invoke(old); assert.equal(h.calls(), calls);
    h.sdk.emit('micerror', failure); retry(h);
  });
}

for (const transition of ['disconnect', 'closed', 'kicked', 'room', 'participant'] as const) {
  it(`whole sample ${transition} retires pending retry and old handlers through same-identity rejoin`, async t => {
    const h = fakeSetup(t); h.sdk.snapshot(stageState()); h.sdk.emit('micerror', failure);
    const eligible = retry(h); eligible.click(); const pending = retry(h, true);
    if (transition === 'disconnect') await h.sdk.disconnect();
    else if (transition === 'closed' || transition === 'kicked') await h.sdk.terminal(transition);
    else {
      const next = stageState();
      if (transition === 'room') next.roomId = 'different-room'; else next.me.participantId = 'different-person';
      h.sdk.snapshot(next);
    }
    noRetry(h); assert.ok(!notices(h).textContent.includes(pendingNotice));
    if (transition === 'closed') assert.match(notices(h).textContent, /房間已關閉/);
    if (transition === 'kicked') assert.match(notices(h).textContent, /你已被主控移出房間/);
    h.sdk.snapshot(stageState()); noRetry(h); h.sdk.emit('micerror', failure); retry(h);
    invoke(eligible); invoke(pending); assert.equal(h.calls(), 1);
    retry(h).click(); assert.equal(h.calls(), 2); retry(h, true);
    await flushSample(); retry(h, true);
  });
}

it('whole sample does not restore an old false-admission notice after synchronous disconnect and same-identity rejoin', t => {
  const h = fakeSetup(t); h.sdk.snapshot(stageState()); h.sdk.emit('micerror', failure);
  h.admission(() => {
    void h.sdk.disconnect(); h.sdk.snapshot(stageState());
    h.sdk.emit('micerror', { name: 'NotFoundError', message: '新連線找不到麥克風。' });
    return false;
  });
  retry(h).click(); retry(h); assert.equal(h.calls(), 1);
  assert.equal(notices(h).textContent, '新連線找不到麥克風。（NotFoundError）重試麥克風');
});

interface Track { enabled: boolean; readyState: string; stops: number; stop(): void }
interface Stream { getTracks(): Track[]; getAudioTracks(): Track[] }
function stream(): { value: Stream; track: Track } {
  const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; } });
  return { track, value: { getTracks: () => [track], getAudioTracks: () => [track] } };
}
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    Socket.instances.push(this);
    queueMicrotask(() => this.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } }));
  }
  deliver(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(data: string): void {
    assert.equal(this.readyState, Socket.OPEN);
    const message = JSON.parse(data) as ClientMessage; this.sent.push(message);
    queueMicrotask(() => {
      if (message.type === 'join') this.deliver({ type: 'room:state', ...roomState() });
      if (message.type === 'rtc:offer') this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
      if ('requestId' in message) this.deliver({ type: 'ok', requestId: message.requestId });
    });
  }
  close(): void { this.readyState = 3; this.onclose?.(); }
}
interface Description { type: string; sdp?: string }
class Peer {
  static instances: Peer[] = [];
  connectionState = 'connected'; signalingState = 'stable';
  localDescription: Description | null = null; remoteDescription: Description | null = null;
  readonly replacements: (Track | null)[] = [];
  readonly offers: string[] = [];
  gate: Deferred<void> | undefined;
  gateEntered = false;
  ontrack: ((event: { streams: Stream[] }) => void) | null = null;
  readonly transceiver = { direction: 'recvonly', sender: { track: null as Track | null,
    replaceTrack: async (track: Track | null) => {
      this.replacements.push(track);
      if (this.gate) { this.gateEntered = true; await this.gate.promise; }
      this.transceiver.sender.track = track;
    } } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  async createOffer(): Promise<Description> {
    this.offers.push(this.transceiver.direction);
    return { type: 'offer', sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` };
  }
  async setLocalDescription(description: Description): Promise<void> { this.localDescription = description; this.signalingState = 'have-local-offer'; }
  async setRemoteDescription(description: Description): Promise<void> { this.remoteDescription = description; this.signalingState = 'stable'; }
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<Map<string, unknown>> { return new Map(); }
  close(): void { this.connectionState = 'closed'; }
}
class Context {
  static instances: Context[] = [];
  closes = 0;
  constructor() { Context.instances.push(this); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, disconnect() {}, getFloatTimeDomainData(samples: Float32Array) { samples.fill(0.25); } }; }
  async resume(): Promise<void> {}
  async close(): Promise<void> { this.closes++; }
}
interface IntegratedClient {
  readonly state: RoomStatePayload | null;
  readonly status: string;
  readonly playbackVolume: number;
  readonly playbackMuted: boolean;
  disconnect(): Promise<void>;
  retryMicrophone(): boolean;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
async function integratedSetup(t: TestContext) {
  // Dynamic import keeps DOM types outside the server test graph. Browser/media/socket boundaries
  // are fakes; public join, capture failure, retry admission and sender installation run unchanged.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  Socket.instances = []; Peer.instances = []; Context.instances = [];
  const originals = new Map(['window', 'navigator', 'WebSocket', 'RTCPeerConnection', 'AudioContext']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests: { work: Deferred<Stream>; constraints: unknown }[] = [], target = new EventTarget();
  for (const [key, value] of Object.entries({ window: target, WebSocket: Socket, RTCPeerConnection: Peer, AudioContext: Context,
    navigator: { mediaDevices: {
      getUserMedia(constraints: unknown) { const work = new Deferred<Stream>(); requests.push({ work, constraints }); return work.promise; },
      async enumerateDevices() { return [{ kind: 'audioinput', deviceId: 'mic-next', label: '下一支麥克風' }]; },
    } },
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const tick = async (ms = 1) => { now += ms; t.mock.timers.tick(ms); await flushSample(); };
  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let n = 0; n < 80; n++) { if (predicate()) return; await tick(); }
    assert.ok(predicate(), `bounded fake-time wait: ${label}`);
  }
  const audio = { volume: 0.37, muted: true, srcObject: null as unknown, pauses: 0, plays: 0,
    pause() { this.pauses++; }, async play() { this.plays++; } };
  const sdk: IntegratedClient = new StageClient({ url: 'ws://localhost/ws', audioElement: audio, requestTimeoutMs: 1000 });
  let calls = 0, ready = 0;
  const actualRetry = sdk.retryMicrophone.bind(sdk);
  t.mock.method(sdk, 'retryMicrophone', () => { calls++; return actualRetry(); });
  sdk.on('micready', () => { ready++; });
  const h = sampleApp({ sdk });
  t.after(async () => {
    try {
      await h.cleanup();
      for (const peer of Peer.instances) if (peer.gate?.status === 'pending') peer.gate.resolve(undefined);
      for (const { work } of requests) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
      await flushSample();
      assert.ok(Context.instances.every(context => context.closes === 1));
      assert.equal(getEventListeners(target, 'pagehide').length, 0);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  async function join() {
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
    for (const [name, value] of Object.entries({ roomId: 'same-room', name: '測試聽眾' })) {
      const input = form.descendants().filter(node => node.type !== 'histogram').find(node => node.name === name); assert.ok(input); input.value = value;
    }
    form.submit(); await until(() => sdk.state !== null && Peer.instances.at(-1)?.remoteDescription !== null, 'join form and audience negotiation');
    const socket = Socket.instances.at(-1)!, peer = Peer.instances.at(-1)!;
    const listening = stream(); assert.ok(peer.ontrack); peer.ontrack({ streams: [listening.value] }); await flushSample();
    assert.equal(audio.srcObject, listening.value);
    return { socket, peer, listening: listening.value, pauses: audio.pauses };
  }
  return { ...h, requests, audio, tick, until, join, calls: () => calls, ready: () => ready };
}

for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
  it(`whole sample and actual SDK retry ${name} on the same seat, preserve listening and end pending before sender installation`, async t => {
    const h = await integratedSetup(t), { socket, peer, listening, pauses } = await h.join();
    noRetry(h); assert.equal(h.requests.length, 0);
    socket.deliver({ type: 'room:state', ...stageState() });
    await h.until(() => h.requests.length === 1, 'first stage microphone request'); noRetry(h);
    h.requests[0]!.work.reject(new DOMException('controlled initial failure', name));
    await h.until(() => notices(h).textContent.includes(`（${name}）`), 'first microphone failure');
    retry(h); assert.equal(h.calls(), 0); assert.equal(peer.transceiver.sender.track, null);
    assert.equal(peer.transceiver.direction, 'recvonly'); assert.equal(h.audio.srcObject, listening);
    assert.equal(h.audio.pauses, pauses); assert.equal(h.sdk.playbackVolume, 0.37); assert.equal(h.sdk.playbackMuted, true);
    socket.deliver({ type: 'room:state', ...stageState() }); h.dispatchDeviceChange(); changeInput(h, 'mic-next');
    await h.tick(100); h.clock.advance(5000); await flushSample();
    assert.equal(h.requests.length, 1, 'state, device choice, devicechange and elapsed time cannot retry capture');
    const old = retry(h); old.click(); retry(h, true); invoke(old); invoke(retry(h, true));
    assert.equal(h.calls(), 1); await h.until(() => h.requests.length === 2, 'explicit second capture');
    assert.deepEqual(h.requests[1]!.constraints, { audio: { channelCount: 1, sampleRate: 48000,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'mic-next' } } });
    socket.deliver({ type: 'room:state', ...stageState() }); retry(h, true);
    await h.tick(100); assert.equal(h.requests.length, 2); retry(h, true);
    h.requests[1]!.work.reject(new DOMException('controlled second failure', 'NotReadableError'));
    await h.until(() => h.id('mic-retry').attributes['aria-busy'] === 'false', 'second failure restores action');
    retry(h); assert.match(notices(h).textContent, /NotReadableError/);
    await h.tick(); peer.gate = new Deferred<void>();
    const offers = peer.offers.length;
    retry(h).click(); retry(h, true); await h.until(() => h.requests.length === 3, 'third explicit capture');
    const current = stream(); h.requests[2]!.work.resolve(current.value);
    await h.until(() => peer.gateEntered, 'capture ready before sender installation settles');
    assert.equal(h.ready(), 1); noRetry(h); assert.equal(notices(h).textContent, '');
    assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.transceiver.direction, 'recvonly');
    assert.equal(peer.offers.length, offers, 'micready is not negotiation completion');
    assert.equal(h.audio.srcObject, listening); assert.equal(h.audio.pauses, pauses);
    h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.25);
    peer.gate.resolve(undefined);
    await h.until(() => peer.transceiver.sender.track === current.track && peer.transceiver.direction === 'sendrecv'
      && peer.offers.length > offers && peer.signalingState === 'stable', 'successful retry installation and negotiation');
    assert.equal(h.sdk.state?.roomId, 'same-room'); assert.equal(h.sdk.state?.me.participantId, 'same-person');
    assert.equal(h.sdk.state?.me.onStage, true); assert.equal(Peer.instances.length, 1); assert.equal(Socket.instances.length, 1);
    assert.equal(current.track.stops, 0); assert.equal(h.calls(), 2); assert.equal(h.requests.length, 3);
    assert.equal(h.audio.srcObject, listening); assert.equal(h.audio.pauses, pauses);
    assert.equal(h.sdk.playbackVolume, 0.37); assert.equal(h.sdk.playbackMuted, true);
    assert.equal(errorBox(h).hidden, true); noRetry(h);
  });
}

it('whole sample and actual SDK discard a late retry grant after disconnect and keep a same-identity rejoin clean', async t => {
  const h = await integratedSetup(t), first = await h.join();
  first.socket.deliver({ type: 'room:state', ...stageState() });
  await h.until(() => h.requests.length === 1, 'initial room capture');
  h.requests[0]!.work.reject(new DOMException('controlled failure', 'NotAllowedError'));
  await h.until(() => notices(h).textContent.includes('NotAllowedError'), 'retry eligibility');
  const old = retry(h); old.click(); await h.until(() => h.requests.length === 2, 'retry capture');
  const pending = retry(h, true);
  h.find(node => node.tagName === 'button' && node.textContent === '離開房間').click();
  assert.equal(h.sdk.state, null); noRetry(h); await flushSample();
  const current = await h.join(); noRetry(h); invoke(old); invoke(pending);
  const retired = stream(); h.requests[1]!.work.resolve(retired.value); await flushSample();
  assert.equal(retired.track.stops, 1); assert.equal(h.ready(), 0); assert.equal(Context.instances.length, 0);
  assert.equal(h.calls(), 1); assert.equal(h.requests.length, 2); noRetry(h);
  assert.equal(h.audio.srcObject, current.listening); assert.equal(h.audio.pauses, current.pauses);
  assert.equal(current.peer.transceiver.sender.track, null); assert.equal(current.peer.transceiver.direction, 'recvonly');
  assert.equal(notices(h).textContent, ''); assert.equal(errorBox(h).hidden, true);
});

it('whole sample and actual SDK surface sender installation failure after micready without restoring capture retry or claiming success', async t => {
  const h = await integratedSetup(t), { socket, peer, listening, pauses } = await h.join();
  socket.deliver({ type: 'room:state', ...stageState() });
  await h.until(() => h.requests.length === 1, 'initial capture');
  h.requests[0]!.work.reject(new DOMException('controlled failure', 'NotAllowedError'));
  await h.until(() => notices(h).textContent.includes('NotAllowedError'), 'initial failure notice');
  await h.tick(); peer.gate = new Deferred<void>();
  const offers = peer.offers.length;
  retry(h).click(); retry(h, true); await h.until(() => h.requests.length === 2, 'explicit retry capture');
  const captured = stream(); h.requests[1]!.work.resolve(captured.value);
  await h.until(() => peer.gateEntered, 'micready before held installation');
  assert.equal(h.ready(), 1); noRetry(h); assert.equal(notices(h).textContent, '');
  assert.equal(errorBox(h).hidden, true); assert.equal(peer.transceiver.sender.track, null);
  peer.gate.reject(new Error('受控的音軌安裝失敗。'));
  await h.until(() => !errorBox(h).hidden, 'installation error reaches sample error box');
  assert.equal(errorBox(h).textContent, '受控的音軌安裝失敗。');
  noRetry(h); assert.equal(notices(h).textContent, '');
  assert.equal(peer.offers.length, offers); assert.equal(peer.transceiver.sender.track, null);
  assert.equal(peer.transceiver.direction, 'recvonly'); assert.equal(h.calls(), 1); assert.equal(h.requests.length, 2);
  assert.equal(h.audio.srcObject, listening); assert.equal(h.audio.pauses, pauses);
  assert.equal(h.sdk.playbackVolume, 0.37); assert.equal(h.sdk.playbackMuted, true);
});
