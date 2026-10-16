import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ClientMessage, ParticipantView, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { harness, RECVONLY_OFFER, testConfig } from './helpers.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';

const pendingText = '正在重新協商音訊連線…';
const completeText = '音訊連線協商已完成。';
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const retry = (h: ReturnType<typeof sampleApp>) => h.id('audio-retry');
const notice = (h: ReturnType<typeof sampleApp>) => h.id('audio-retry-status');
const errorBox = (h: ReturnType<typeof sampleApp>) => h.find(node => node.attributes.role === 'alert');

it('whole sample owns audio retry across same-seat redraws, repeated callbacks and recoverable failures', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
  assert.equal(h.app.descendants().some(node => node.id === 'audio-retry'), false);
  const state = roomState(); h.sdk.snapshot(state);
  const first = retry(h); assert.equal(first.type, 'button'); assert.equal(first.disabled, false);
  assert.equal(notice(h).attributes.role, 'status'); assert.equal(notice(h).hidden, true);
  first.click(); assert.equal(h.sdk.audioRetries.length, 1); assert.equal(first.disabled, true);
  assert.equal(first.attributes['aria-busy'], 'true'); assert.equal(notice(h).textContent, pendingText);
  h.sdk.snapshot({ ...state, name: '新的房間標題' }); const next = retry(h);
  assert.notEqual(next, first); assert.equal(first.isConnected, false); assert.equal(next.disabled, true);
  h.sdk.emit('error', { message: '較新的操作錯誤。' });
  first.onclick!(); next.click(); next.onclick!(); assert.equal(h.sdk.audioRetries.length, 1);
  assert.equal(errorBox(h).textContent, '較新的操作錯誤。'); assert.equal(errorBox(h).hidden, false);
  h.sdk.audioRetries[0]!.reject(new Error('音訊協商失敗。')); await flushSample();
  assert.equal(next.disabled, false); assert.equal(next.attributes['aria-busy'], 'false'); assert.equal(notice(h).hidden, true);
  assert.equal(errorBox(h).textContent, '音訊協商失敗。');
  first.disabled = false; first.onclick!(); assert.equal(h.sdk.audioRetries.length, 1, 'detached same-seat callbacks cannot retry');
  next.click(); assert.equal(h.sdk.audioRetries.length, 2); h.sdk.emit('error', { message: '保留較新的錯誤。' });
  h.sdk.audioRetries[1]!.resolve(undefined); await flushSample();
  assert.equal(next.disabled, false); assert.equal(notice(h).hidden, false); assert.equal(notice(h).textContent, completeText);
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '保留較新的錯誤。');
  assert.equal(h.sdk.previews.length, 0); assert.equal(h.sdk.joins.length, 0);
});

for (const status of ['reconnecting', 'disconnected'] as const) {
  it(`whole sample clears audio feedback and blocks retry while ${status}, including same-turn completion`, async t => {
    const h = sampleApp(); t.after(() => h.cleanup()); h.sdk.snapshot(roomState());
    retry(h).click(); h.sdk.audioRetries[0]!.resolve(undefined); h.sdk.setStatus(status);
    assert.equal(notice(h).hidden, true); assert.equal(notice(h).textContent, '');
    assert.equal(retry(h).disabled, true); assert.equal(retry(h).attributes['aria-busy'], 'true');
    await flushSample(); assert.equal(retry(h).attributes['aria-busy'], 'false');
    assert.equal(retry(h).disabled, true); assert.equal(notice(h).textContent, ''); assert.equal(notice(h).hidden, true);
    retry(h).onclick!(); assert.equal(h.sdk.audioRetries.length, 1);
    h.sdk.setStatus('live'); assert.equal(retry(h).disabled, false);
    retry(h).click(); h.sdk.audioRetries[1]!.resolve(undefined); await flushSample(); assert.equal(notice(h).textContent, completeText);
    h.sdk.setStatus(status); assert.equal(notice(h).textContent, ''); assert.equal(notice(h).hidden, true);
  });
}

for (const transition of ['landing', 'room', 'participant'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`whole sample retires audio retry callbacks and late ${outcome} after ${transition} replacement`, async t => {
      const h = sampleApp(); t.after(() => h.cleanup()); const state = roomState(); h.sdk.snapshot(state);
      const old = new Deferred<void>(), current = new Deferred<void>(); let calls = 0;
      Object.assign(h.sdk, { retryAudioConnection: () => ++calls === 1 ? old.promise : current.promise });
      const stale = retry(h); stale.click();
      if (transition === 'landing') { h.button('離開房間').click(); await flushSample(); }
      const next = structuredClone(state);
      if (transition === 'room') next.roomId = 'new-room';
      if (transition === 'participant') next.me.participantId = 'new-person';
      h.sdk.snapshot(next); assert.equal(notice(h).hidden, true); assert.equal(retry(h).disabled, false);
      retry(h).click(); h.sdk.emit('error', { message: '新房間的錯誤。' });
      stale.disabled = false; stale.onclick!(); assert.equal(calls, 2);
      if (outcome === 'resolve') old.resolve(undefined); else old.reject(new Error('舊房間的錯誤。'));
      await flushSample(); assert.equal(retry(h).disabled, true); assert.equal(retry(h).attributes['aria-busy'], 'true');
      assert.equal(notice(h).textContent, pendingText); assert.equal(errorBox(h).textContent, '新房間的錯誤。');
      current.resolve(undefined); await flushSample(); assert.equal(notice(h).textContent, completeText);
      assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '新房間的錯誤。');
    });
  }
}

interface ActualClient {
  readonly state: RoomStatePayload | null; readonly me: ParticipantView | null; readonly status: string;
  readonly playbackVolume: number; readonly playbackMuted: boolean;
  disconnect(): Promise<void>; retryAudioConnection(): Promise<void>; retryMicrophone(): boolean;
  on(type: string, listener: (event: { detail: { code: string; message: string } }) => void): () => void;
}
type HeldKind = 'join-ack' | 'offer-ack' | 'answer';

/** Whole sample -> actual SDK -> validator -> Hub. Only DOM, clocks, sockets and native media are controlled. */
async function actualSample(t: TestContext, holdJoinAck = false) {
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; });
  const server = harness(config), host = await server.create();
  const gates: Deferred<void>[] = [];
  const gate = () => { const work = new Deferred<void>(); gates.push(work); return work; };
  const failedOffer = gate(), transportGates = [failedOffer];
  const negotiate = server.transport.negotiate.bind(server.transport);
  let offers = 0, serverWork = Promise.resolve();
  server.transport.negotiate = async (...args) => {
    offers++; const work = transportGates.shift(); if (work) await work.promise;
    return negotiate(...args);
  };
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 1;
    readonly id = `sample-audio-${Socket.instances.length}`;
    readonly sent: ClientMessage[] = [];
    readonly held: { kind: HeldKind; message: ServerMessage }[] = [];
    readonly hold = new Set<HeldKind>(holdJoinAck ? ['join-ack'] : []);
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    readonly session = { id: this.id, send: (message: ServerMessage) => {
      let kind: HeldKind | undefined;
      if (message.type === 'rtc:answer') kind = 'answer';
      else if (message.type === 'ok') {
        const request = this.sent.find(item => 'requestId' in item && item.requestId === message.requestId);
        if (request?.type === 'rtc:offer') kind = 'offer-ack';
        if (request?.type === 'join') kind = 'join-ack';
      }
      if (kind && this.hold.has(kind)) this.held.push({ kind, message }); else this.deliver(message);
    }, close: () => this.close() };
    constructor() { Socket.instances.push(this); queueMicrotask(() => server.hub.attach(this.session)); }
    deliver(message: ServerMessage): void { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) }); }
    release(kind: HeldKind): void {
      const messages = this.held.filter(item => item.kind === kind);
      this.held.splice(0, this.held.length, ...this.held.filter(item => item.kind !== kind));
      for (const { message } of messages) this.deliver(message);
    }
    send(data: string): void {
      assert.equal(this.readyState, 1); const message = parseClientMessage(data, config.limits); this.sent.push(message);
      serverWork = serverWork.then(() => server.hub.handle(this.session, message));
    }
    close(code?: number): void {
      if (this.readyState === 3) return;
      this.readyState = 3; this.onclose?.();
      serverWork = serverWork.then(() => server.hub.detach(this.session, code === 1000));
    }
  }
  class Peer {
    static instances: Peer[] = [];
    connectionState = 'new'; signalingState = 'stable';
    localDescription: unknown = null; remoteDescription: unknown = null;
    createGate: Deferred<void> | undefined; answerGate: Deferred<void> | undefined; iceGate: Deferred<void> | undefined;
    createCalls = 0; answerCalls = 0; iceCalls = 0; restarts = 0;
    ontrack: ((event: { streams: unknown[] }) => void) | null = null;
    readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown,
      async replaceTrack(track: unknown) { this.track = track; } } };
    constructor() { Peer.instances.push(this); }
    addTransceiver() { return this.transceiver; }
    async createOffer() {
      this.createCalls++; const work = this.createGate; this.createGate = undefined; if (work) await work.promise;
      return { ...RECVONLY_OFFER };
    }
    async setLocalDescription(description: unknown) { this.localDescription = description; this.signalingState = 'have-local-offer'; }
    async setRemoteDescription(description: unknown) {
      this.answerCalls++; const work = this.answerGate; this.answerGate = undefined; if (work) await work.promise;
      this.remoteDescription = description; this.signalingState = 'stable';
    }
    async addIceCandidate() {
      this.iceCalls++; const work = this.iceGate; this.iceGate = undefined; if (work) await work.promise;
    }
    async getStats() { return new Map(); }
    restartIce() { this.restarts++; }
    close() { this.connectionState = 'closed'; }
  }
  let captures = 0, retryCalls = 0, micRetryCalls = 0;
  const audio = { srcObject: null as unknown, volume: 0.37, muted: true, plays: 0, pauses: 0, blocked: false,
    pause() { this.pauses++; }, async play() { this.plays++; if (this.blocked) throw new DOMException('需要使用者操作。', 'NotAllowedError'); } };
  const globals = { window: new EventTarget(), WebSocket: Socket, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { async enumerateDevices() { return []; },
      async getUserMedia(): Promise<never> { captures++; throw new DOMException('受控麥克風拒絕。', 'NotAllowedError'); } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 0;
  t.mock.method(performance, 'now', () => now);
  const sdk: ActualClient = new StageClient({ url: 'wss://sample.test/ws', requestTimeoutMs: 5000, audioElement: audio });
  const retryAudio = sdk.retryAudioConnection.bind(sdk), retryMic = sdk.retryMicrophone.bind(sdk);
  t.mock.method(sdk, 'retryAudioConnection', () => { retryCalls++; return retryAudio(); });
  t.mock.method(sdk, 'retryMicrophone', () => { micRetryCalls++; return retryMic(); });
  const errors: string[] = []; sdk.on('error', event => errors.push(event.detail.code));
  const app = sampleApp({ sdk });
  const tick = async (ms = 25) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const until = async (predicate: () => boolean, label: string) => {
    for (let i = 0; i < 100 && !predicate(); i++) await tick(); assert.ok(predicate(), label);
  };
  const error = () => app.find(node => node.attributes.role === 'alert');
  const feedback = () => app.id('audio-retry-status');
  const button = () => app.id('audio-retry');
  const presence = async () => {
    for (const timer of server.timers) if (!timer.cleared && timer.ms === config.rooms.presenceBroadcastMs) { timer.cleared = true; timer.fn(); }
    await flush();
  };
  const join = async (room = host) => {
    const form = app.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
    for (const [name, value] of Object.entries({ roomId: room.roomId, code: room.code, name: 'Listener' })) {
      const input = form.descendants().find(node => node.name === name); assert.ok(input); input.value = value;
    }
    form.submit(); await until(() => sdk.state !== null && Peer.instances.at(-1)!.createCalls > 0, 'room snapshot and initial offer');
    return { socket: Socket.instances.at(-1)!, peer: Peer.instances.at(-1)!, id: sdk.me!.participantId };
  };
  const failedJoin = async () => {
    const joined = await join(); await until(() => offers === 1, 'first transport offer'); await presence();
    failedOffer.reject(new Error('controlled initial media failure')); await flush(); await serverWork; assert.deepEqual(errors, ['bad_request', 'bad_request'], 'existing wire and negotiation error notifications remain unchanged');
    await flush(); assert.equal(sdk.status, 'live'); assert.equal(server.hub.isJoined(joined.socket.session), true);
    assert.equal(server.transport.rooms.get(host.roomId)!.subscribers.has(joined.id), false);
    assert.equal(joined.peer.remoteDescription, null); return joined;
  };
  t.after(async () => {
    try {
      await app.cleanup();
      for (const work of gates) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
      await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close();
      assert.ok(Socket.instances.every(socket => socket.readyState === 3));
      assert.ok(Peer.instances.every(peer => peer.connectionState === 'closed')); assert.equal(app.clock.jobs.size, 0);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return { ...app, server, host, sdk, audio, gate, transportGates, errors, join, failedJoin, presence, tick, until,
    button, feedback, error, sockets: Socket.instances, peers: Peer.instances, offers: () => offers,
    captures: () => captures, retries: () => retryCalls, micRetries: () => micRetryCalls };
}

it('actual sample manual retry recovers the rejected-offer Hub subscription on the same seat and peer without capture or playback', async t => {
  const h = await actualSample(t), { peer, socket, id } = await h.failedJoin();
  for (let i = 0; i < 8; i++) await h.tick(15000);
  assert.equal(h.offers(), 1, 'healthy control ping/pong does not introduce an automatic retry');
  assert.equal(h.sdk.status, 'live'); assert.equal(h.retries(), 0); assert.equal(h.feedback().hidden, true);
  h.button().click(); assert.equal(h.button().attributes['aria-busy'], 'true');
  await h.until(() => h.feedback().textContent === completeText, 'manual negotiation completes');
  assert.equal(h.server.transport.rooms.get(h.host.roomId)!.subscribers.has(id), true);
  assert.equal(h.sdk.me!.participantId, id); assert.equal(h.peers.length, 1); assert.equal(h.sockets.length, 1);
  assert.equal(h.offers(), 2); assert.equal(h.retries(), 1); assert.equal(peer.restarts, 0);
  assert.equal(peer.connectionState, 'new', 'completion does not certify native ICE or audio health');
  assert.equal(h.captures(), 0); assert.equal(h.audio.plays, 0); assert.equal(peer.transceiver.sender.track, null);
  assert.equal(h.sdk.playbackVolume, 0.37); assert.equal(h.sdk.playbackMuted, true);
  assert.equal(socket.sent.filter(message => message.type === 'join').length, 1);
});

it('actual sample permits failure retry and waits for ACK, installed answer and buffered ICE drain without erasing a newer error', async t => {
  const h = await actualSample(t), { peer, socket } = await h.failedJoin();
  const failure = h.gate(); h.transportGates.push(failure); h.button().click();
  await h.until(() => h.offers() === 2, 'explicit failed attempt'); failure.reject(new Error('controlled second failure'));
  await h.until(() => !h.button().disabled, 'failed retry unlocks button');
  assert.equal(h.feedback().hidden, true); assert.equal(h.error().hidden, false);
  const answer = h.gate(), ice = h.gate(); peer.answerGate = answer; peer.iceGate = ice; socket.hold.add('offer-ack');
  h.button().click(); await h.until(() => peer.answerCalls === 1 && socket.held.length === 1, 'answer installation and ACK held');
  const stale = h.button(); socket.deliver({ type: 'room:state', ...h.sdk.state!, name: '重繪中的房間' }); await flush();
  assert.equal(stale.isConnected, false); assert.equal(h.button().disabled, true); h.button().onclick!(); stale.onclick!();
  assert.equal(h.retries(), 2); assert.equal(h.feedback().textContent, pendingText);
  // The redraw dirties negotiation while the first answer is pending, so the same promise owns both iterations.
  socket.release('offer-ack'); await flush(); assert.equal(h.feedback().textContent, pendingText);
  answer.resolve(undefined); await h.until(() => peer.iceCalls === 1, 'first buffered ICE application');
  assert.equal(h.button().disabled, true); assert.equal(h.feedback().textContent, pendingText);
  ice.resolve(undefined); await h.until(() => h.offers() === 4 && socket.held.length === 1, 'dirty second offer awaits ACK');
  assert.equal(h.feedback().textContent, pendingText); assert.equal(h.button().disabled, true);
  socket.deliver({ type: 'error', code: 'bad_request', message: '請保留後來的操作錯誤。' });
  socket.release('offer-ack'); await h.until(() => !h.button().disabled, 'whole dirty loop completes');
  assert.equal(h.feedback().textContent, completeText); assert.equal(h.error().hidden, false);
  assert.equal(h.error().textContent, '請保留後來的操作錯誤。'); assert.equal(h.peers.length, 1);
  assert.equal(h.captures(), 0); assert.equal(h.audio.plays, 0); assert.equal(peer.restarts, 0);
});

it('actual sample exposes manual recovery from the authoritative snapshot before the join ACK', async t => {
  const h = await actualSample(t, true), { socket, id } = await h.failedJoin();
  assert.equal(socket.held.filter(item => item.kind === 'join-ack').length, 1);
  h.button().click(); await h.until(() => h.feedback().textContent === completeText, 'pre-ACK manual recovery');
  assert.equal(h.server.transport.rooms.get(h.host.roomId)!.subscribers.has(id), true);
  assert.equal(socket.held.filter(item => item.kind === 'join-ack').length, 1);
  socket.release('join-ack'); await flush(); assert.equal(h.retries(), 1); assert.equal(h.offers(), 2);
});

it('actual sample cancels pending feedback on socket loss while preserving the native serialization lock through resume', async t => {
  const h = await actualSample(t), { peer, socket, id } = await h.failedJoin();
  const native = h.gate(); peer.createGate = native; h.button().click();
  assert.equal(peer.createCalls, 2); socket.close();
  assert.equal(h.sdk.status, 'reconnecting'); assert.equal(h.feedback().hidden, true); assert.equal(h.button().disabled, true);
  await flush(); assert.equal(h.button().attributes['aria-busy'], 'false'); assert.equal(h.button().disabled, true);
  assert.equal(native.status, 'pending', 'public cancellation does not cancel native createOffer');
  await h.until(() => h.sockets.length === 2 && h.sdk.status === 'live', 'same-seat resume');
  assert.equal(h.sdk.me!.participantId, id); assert.equal(h.peers.length, 1);
  h.button().click(); await flush(); assert.equal(h.retries(), 2); assert.equal(peer.createCalls, 2);
  assert.match(h.error().textContent, /音訊協商進行中/); assert.equal(h.feedback().hidden, true);
  native.resolve(undefined); await h.until(() => peer.signalingState === 'stable' && h.offers() >= 2, 'retained native run settles');
  await flush(); assert.equal(h.feedback().hidden, true, 'cancelled request cannot later report success');
  h.button().click(); await h.until(() => h.feedback().textContent === completeText, 'fresh explicit retry after native settlement');
  assert.equal(h.peers.length, 1); assert.equal(peer.restarts, 0); assert.equal(h.captures(), 0); assert.equal(h.audio.plays, 0);
});

it('actual sample retires an old native operation and detached callback across leave and a new room retry', async t => {
  const h = await actualSample(t), first = await h.failedJoin();
  const oldNative = h.gate(); first.peer.createGate = oldNative; const stale = h.button(); stale.click();
  h.app.descendants().find(node => node.tagName === 'button' && node.textContent === '離開房間')!.click();
  await flush(); assert.equal(h.sdk.state, null);
  const other = await h.server.create('Other host'), current = await h.join(other);
  await h.until(() => current.peer.remoteDescription !== null && current.peer.signalingState === 'stable', 'new room initial negotiation');
  const currentNative = h.gate(); current.peer.createGate = currentNative; h.button().click();
  stale.disabled = false; stale.onclick!(); const sent = first.socket.sent.length;
  oldNative.resolve(undefined); await flush();
  assert.equal(first.socket.sent.length, sent); assert.equal(h.feedback().textContent, pendingText);
  assert.equal(h.button().disabled, true); assert.equal(h.button().attributes['aria-busy'], 'true'); assert.equal(h.retries(), 2);
  currentNative.resolve(undefined); await h.until(() => h.feedback().textContent === completeText, 'new room retry succeeds');
  assert.equal(h.sdk.state!.roomId, other.roomId); assert.equal(h.peers.length, 2); assert.equal(h.captures(), 0); assert.equal(h.audio.plays, 0);
});

it('actual sample keeps microphone retry and playback unlock independent from audio negotiation retry', async t => {
  const h = await actualSample(t), { peer, id } = await h.failedJoin();
  h.app.descendants().find(node => node.tagName === 'button' && node.textContent === '舉手發言')!.click();
  await h.until(() => h.sdk.me!.handRaised, 'audience raises hand before approval');
  assert.equal(await h.server.req(h.host.s, { type: 'stage:approve', targetId: id }), 'ok');
  await h.until(() => h.captures() === 1 && h.app.descendants().some(node => node.id === 'mic-retry'), 'microphone failure notice');
  await h.until(() => peer.signalingState === 'stable', 'automatic stage snapshot negotiation');
  h.audio.blocked = true; assert.ok(peer.ontrack); const listening = { getTracks: () => [], getAudioTracks: () => [] };
  peer.ontrack({ streams: [listening] }); await flush();
  const notices = () => h.find(node => node.classList.contains('notices')).textContent;
  assert.match(notices(), /NotAllowedError/); assert.match(notices(), /點擊啟用音訊/);
  const plays = h.audio.plays, pauses = h.audio.pauses;
  h.button().click(); await h.until(() => h.feedback().textContent === completeText, 'negotiation while other audio actions remain available');
  assert.equal(h.captures(), 1); assert.equal(h.micRetries(), 0); assert.equal(h.audio.plays, plays); assert.equal(h.audio.pauses, pauses);
  assert.equal(h.audio.srcObject, listening); assert.match(notices(), /NotAllowedError/); assert.match(notices(), /點擊啟用音訊/);
  h.id('mic-retry').click(); await h.until(() => h.captures() === 2, 'separate explicit microphone retry');
  assert.equal(h.micRetries(), 1); assert.equal(h.retries(), 1);
  h.audio.blocked = false; h.app.descendants().find(node => node.tagName === 'button' && node.textContent === '點擊啟用音訊')!.click();
  await flush(); assert.equal(h.audio.plays, plays + 1); assert.equal(h.retries(), 1); assert.equal(peer.restarts, 0);
});
