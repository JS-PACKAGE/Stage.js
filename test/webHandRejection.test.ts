import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import { StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { harness, testConfig } from './helpers.ts';

// Whole-module assertions with controlled DOM/socket/media boundaries; no native-browser or audio claim.
const MESSAGE = '主控已婉拒這次舉手申請。';
type View = { find(predicate: (node: SampleNode) => boolean): SampleNode };
const notice = (h: View) => h.find(node => node.classList.contains('hand-rejected'));
const error = (h: View) => h.find(node => node.attributes.role === 'alert');
const hand = (h: View) => h.find(node => node.dataset.roomAction === 'hand');
function shown(h: View): void { assert.equal(notice(h).hidden, false); assert.equal(notice(h).textContent, MESSAGE); }
function hidden(h: View): void { assert.equal(notice(h).hidden, true); assert.equal(notice(h).textContent, ''); }
async function setup(t: TestContext, me: Partial<ParticipantView> = {}) {
  const writes: string[] = [];
  const h = sampleApp({ localStorage: { getItem: () => null, setItem(key) { writes.push(key); } } });
  t.after(() => h.cleanup()); await flushSample(); h.sdk.snapshot(roomState(me));
  return { ...h, writes, reject() { h.sdk.emit('handrejected', { roomId: h.sdk.state!.roomId, participantId: h.sdk.me!.participantId }); } };
}

it('full sample uses a separate safe personal status line without replacing errors, notices or controls', async t => {
  const h = await setup(t), line = notice(h); hidden(h);
  Object.defineProperty(line, 'innerHTML', { set() { assert.fail('rejection must remain plain text'); } });
  const text = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(line), 'textContent')!; let writes = 0;
  Object.defineProperty(line, 'textContent', { get() { return text.get!.call(this) as string; }, set(value: string) { writes++; text.set!.call(this, value); } });
  h.sdk.emit('error', { message: '保留真正錯誤。' }); h.sdk.emit('audioblocked', undefined);
  const ordinary = h.find(node => node.classList.contains('notices')).textContent;
  const action = hand(h), timers = [...h.clock.jobs.keys()]; h.reject(); shown(h);
  assert.equal(line.tagName, 'p'); assert.equal(line.attributes.role, 'status'); assert.equal(line.children.length, 0);
  assert.equal(line.onclick, null); assert.equal(line.parentNode, action.parentNode?.parentNode);
  assert.equal(error(h).hidden, false); assert.equal(error(h).textContent, '保留真正錯誤。');
  assert.equal(h.find(node => node.classList.contains('notices')).textContent, ordinary);
  assert.equal(hand(h), action); assert.equal(action.textContent, '舉手發言'); assert.equal(action.disabled, false);
  for (let i = 0; i < 5; i++) h.sdk.snapshot(structuredClone(h.sdk.state!)); shown(h);
  assert.equal(writes, 1, 'identical status text is not rewritten');
  assert.deepEqual([...h.clock.jobs.keys()], timers); assert.equal(h.sdk.raises.length, 0); assert.equal(h.sdk.previews.length, 0);
  assert.deepEqual(h.writes, []);
});

it('full sample generic withdrawal and unraised snapshots never infer rejection', async t => {
  const h = await setup(t, { handRaised: true });
  h.sdk.emit('hand', { participantId: h.sdk.me!.participantId, raised: false }); hidden(h);
  h.sdk.snapshot(roomState()); hidden(h); h.sdk.snapshot(roomState()); hidden(h);
  h.sdk.emit('hand', { participantId: 'other', raised: false }); hidden(h);
  assert.equal(h.sdk.raises.length, 0);
});

for (const overrides of [{ handRaised: true }, { onStage: true }, { role: 'controller' as const }, { role: 'speaker' as const }]) {
  it(`full sample rejects synthetic hand feedback for ineligible ${JSON.stringify(overrides)}`, async t => {
    const h = await setup(t, overrides); h.reject(); hidden(h);
    h.sdk.snapshot(roomState()); hidden(h); h.reject(); shown(h);
    h.sdk.snapshot(roomState(overrides)); hidden(h); h.sdk.snapshot(roomState()); hidden(h);
  });
}
for (const mismatch of ['room', 'participant'] as const) {
  it(`full sample matches exact ${mismatch} and does not retain mutable event payloads`, async t => {
    const h = await setup(t), payload = { roomId: 'same-room', participantId: 'same-person' };
    h.sdk.emit('handrejected', { ...payload, [mismatch === 'room' ? 'roomId' : 'participantId']: 'other' }); hidden(h);
    h.sdk.emit('handrejected', payload); shown(h); payload.roomId = payload.participantId = 'mutated';
    h.sdk.snapshot(roomState()); shown(h);
    const next = roomState(); if (mismatch === 'room') next.roomId = 'next'; else next.me.participantId = 'next';
    h.sdk.snapshot(next); hidden(h); h.sdk.snapshot(roomState()); hidden(h);
  });
}
for (const status of ['reconnecting', 'disconnected'] as const) {
  it(`full sample retires feedback on ${status}, including retained snapshots and same-seat recovery`, async t => {
    const h = await setup(t); h.reject(); shown(h); h.sdk.setStatus(status); hidden(h);
    assert.ok(h.sdk.state); h.reject(); hidden(h); h.sdk.setStatus('waiting'); hidden(h);
    h.sdk.snapshot(roomState()); hidden(h); h.reject(); shown(h);
  });
}

it('full sample pending or failed raise preserves feedback until a new raised event or authoritative hand', async t => {
  const h = await setup(t); h.reject(); hand(h).click(); shown(h);
  assert.equal(h.sdk.raises.length, 1); h.sdk.raises[0]!.reject(new Error('Raise failed')); await flushSample(); shown(h);
  assert.equal(error(h).textContent, 'Raise failed'); h.sdk.emit('hand', { participantId: 'other', raised: true }); shown(h);
  h.sdk.emit('hand', { participantId: 'same-person', raised: false }); shown(h);
  h.sdk.emit('hand', { participantId: 'same-person', raised: true }); hidden(h);
  h.sdk.snapshot(roomState()); hidden(h); h.reject(); shown(h); h.sdk.snapshot(roomState({ handRaised: true })); hidden(h);
  h.sdk.snapshot(roomState()); hidden(h);
});

for (const event of ['stagejoined', 'role', 'transferred'] as const) {
  it(`full sample own ${event} retires feedback before its following snapshot`, async t => {
    const h = await setup(t); h.reject();
    if (event === 'transferred') h.sdk.emit(event, { fromId: 'host', toId: 'same-person' });
    else h.sdk.emit(event, { participantId: 'same-person', role: 'speaker' });
    hidden(h); h.sdk.snapshot(roomState()); hidden(h);
  });
}

for (const terminal of ['leave', 'disconnect', 'closed', 'shutdown', 'kicked'] as const) {
  it(`full sample ${terminal} clears detached feedback and allows only fresh same-ID feedback`, async t => {
    const h = await setup(t); h.reject(); const line = notice(h);
    if (terminal === 'leave') h.button('離開房間').click();
    else if (terminal === 'disconnect') await h.sdk.disconnect();
    else await h.sdk.terminal(terminal === 'kicked' ? 'kicked' : 'closed', terminal === 'shutdown' ? 'shutdown' : undefined);
    await flushSample(); assert.equal(line.hidden, true); assert.equal(line.textContent, ''); assert.equal(line.isConnected, false);
    h.sdk.emit('handrejected', { roomId: 'same-room', participantId: 'same-person' }); assert.equal(line.textContent, '');
    h.sdk.snapshot(roomState()); hidden(h); h.reject(); shown(h); assert.equal(notice(h), line);
  });
}

it('full sample retires before asynchronous leave and ignores late pending work', async t => {
  const h = await setup(t), gate = new Deferred<void>(); h.reject(); hand(h).click();
  const old = h.sdk.raises[0]!, disconnect = h.sdk.disconnect.bind(h.sdk);
  t.mock.method(h.sdk, 'disconnect', async () => { await gate.promise; await disconnect(); });
  t.after(() => { if (gate.status === 'pending') gate.resolve(undefined); });
  h.button('離開房間').click(); hidden(h); h.reject(); hidden(h); h.sdk.snapshot(roomState()); hidden(h);
  old.resolve(undefined); await flushSample(); hidden(h); gate.resolve(undefined); await flushSample();
  h.sdk.snapshot(roomState()); hidden(h); h.reject(); shown(h);
});

for (const transition of ['raised and withdrawn', 'room and back', 'reconnect and recover', 'leave and reentry'] as const) {
  it(`full sample nested ${transition} callbacks retire feedback without later restoration`, async t => {
    const h = await setup(t);
    const off = h.sdk.on('handrejected', () => {
      if (transition === 'raised and withdrawn') { h.sdk.snapshot(roomState({ handRaised: true })); h.sdk.snapshot(roomState()); }
      else if (transition === 'room and back') { h.sdk.snapshot({ ...roomState(), roomId: 'other' }); h.sdk.snapshot(roomState()); }
      else if (transition === 'reconnect and recover') { h.sdk.setStatus('reconnecting'); h.sdk.setStatus('waiting'); }
      else { void h.sdk.disconnect(); h.sdk.snapshot(roomState()); }
    });
    h.reject(); hidden(h); off(); h.reject(); shown(h);
  });
}

interface ActualClient { state: RoomStatePayload | null; status: string; disconnect(): Promise<void>; dispatchEvent(event: Event): boolean }
async function actualSample(t: TestContext, state: RoomStatePayload) {
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  StageSocket.instances = []; StagePeer.instances = [];
  let captures = 0;
  const globals = { window: new EventTarget(), WebSocket: StageSocket, RTCPeerConnection: StagePeer,
    navigator: { mediaDevices: { async enumerateDevices() { return []; }, async getUserMedia() { captures++; throw new Error('Unexpected capture'); } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 1000; t.mock.method(performance, 'now', () => now);
  const audio = { volume: 0.37, muted: true, autoplay: true, hidden: true, srcObject: null, plays: 0, pauses: 0,
    async play() { this.plays++; }, pause() { this.pauses++; } };
  const sdk: ActualClient = new StageClient({ url: 'wss://sample.test/ws', audioElement: audio, enableMicMeter: false });
  const h = sampleApp({ sdk });
  t.after(async () => {
    try { await h.cleanup(); assert.equal(sdk.state, null); assert.equal(captures, 0); }
    finally { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
  });
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 80 && !predicate(); i++) { now += 10; t.mock.timers.tick(10); await flushSample(); }
    assert.ok(predicate());
  }
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [key, value] of Object.entries({ roomId: state.roomId, name: state.me.name })) {
    const field = form.descendants().find(node => node.name === key)!; field.value = value;
  }
  form.submit(); await flushSample(); const socket = StageSocket.instances.at(-1)!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await until(() => socket.sent.some(message => message.type === 'join'));
  const request = socket.sent.find(message => message.type === 'join')!;
  socket.deliver({ type: 'room:state', ...state }); socket.deliver({ type: 'ok', requestId: request.requestId });
  const peer = StagePeer.instances.at(-1)!; await until(() => peer.localDescription !== null && peer.signalingState === 'stable');
  return { ...h, socket, peer, audio, captures: () => captures };
}

it('full sample real SDK consumes Hub rejection after authoritative state with no replay or media change', async t => {
  const server = harness(testConfig(config => { config.rooms.presenceBroadcastMs = 0; config.rooms.qualityIntervalMs = 0; }));
  t.after(async () => { await server.hub.shutdown(); assert.equal(server.transport.rooms.size, 0); });
  const host = await server.create(), self = await server.join(host.roomId, host.code, 'Self');
  await server.req(self.s, { type: 'hand:raise' });
  const h = await actualSample(t, self.s.last('room:state')!); hidden(h);
  const before = { sent: h.socket.sent.length, offers: [...h.peer.offers], audio: { ...h.audio } };
  const index = self.s.inbox.length; await server.req(host.s, { type: 'stage:reject', targetId: self.id });
  const replies = self.s.inbox.slice(index);
  assert.ok(replies.findIndex(message => message.type === 'room:state') < replies.findIndex(message => message.type === 'hand:rejected'));
  for (const reply of replies) { h.socket.deliver(reply); if (reply.type === 'hand:withdraw' || reply.type === 'room:state') hidden(h); }
  shown(h); await flushSample(); assert.equal(h.sdk.state?.me.handRaised, false);
  h.socket.deliver({ type: 'error', code: 'conflict', message: 'Real unrelated error' }); shown(h); assert.equal(error(h).textContent, 'Real unrelated error');
  h.socket.deliver(self.s.last('room:state')!); shown(h);
  h.socket.deliver({ type: 'hand:raise', participantId: self.id }); hidden(h);
  h.socket.deliver({ type: 'hand:withdraw', participantId: self.id }); hidden(h);
  h.sdk.dispatchEvent(new CustomEvent('handrejected', { detail: { roomId: host.roomId, participantId: self.id } })); shown(h);
  h.socket.close(); hidden(h); assert.ok(h.sdk.state, 'reconnect retains the old state');
  h.sdk.dispatchEvent(new CustomEvent('handrejected', { detail: { roomId: host.roomId, participantId: self.id } })); hidden(h);
  assert.equal(h.socket.sent.length, before.sent); assert.deepEqual(h.peer.offers, before.offers);
  assert.equal(h.captures(), 0); assert.equal(h.audio.volume, before.audio.volume); assert.equal(h.audio.muted, before.audio.muted);
  assert.equal(h.audio.plays, before.audio.plays); assert.equal(h.audio.pauses, before.audio.pauses);
});
