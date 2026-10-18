import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { StageClient, decodeName } from '../packages/client/src/index.ts';
import { FakeSession, harness, SENDRECV_OFFER, testConfig } from './helpers.ts';
import { sampleApp, flushSample, roomState, SampleNode } from './fixtures/sampleApp.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import type { ClientMessage, ConnectionQuality, ParticipantView, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';

// Complete production sample, public SDK, validator and Hub execute unchanged. Only DOM,
// timers, frame delivery and native RTC are controlled; native rendering/audio is unverified.
const source = readFileSync(process.env.B209_SOURCE ?? new URL('../web/src/main.ts', import.meta.url), 'utf8');
class Socket {
  static OPEN = 1; static instances: Socket[] = [];
  readyState = 1; sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(data)); }
  deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
class Peer {
  static instances: Peer[] = [];
  connectionState = 'connected'; signalingState = 'stable'; localDescription = null;
  rejectOffer?: (reason: Error) => void;
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return { direction: 'recvonly', sender: { track: null, async replaceTrack() {} } }; }
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  getStats() { return Promise.resolve(new Map()); }
  close() { this.connectionState = 'closed'; this.rejectOffer?.(new Error('controlled cleanup')); }
}
let requestSequence = 0;
async function actualSetup(t: TestContext, mode: 'speaker' | 'offstage-controller' | 'onstage-controller' = 'speaker') {
  const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; c.limits.controlPerSecond = 2000; c.rooms.participantGraceMs = 1000; });
  const wire = harness(config), host = await wire.create('Publishing Host', { codeRequired: false });
  const successor = await wire.join(host.roomId, undefined, 'Successor');
  Socket.instances = []; Peer.instances = [];
  const globals = { window: new EventTarget(), WebSocket: Socket, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { async enumerateDevices() { return []; }, async getUserMedia() { throw new DOMException('Controlled capture refusal', 'NotAllowedError'); } } } };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const sdk = new StageClient({ url: 'wss://sample.test/ws', audioElement: { srcObject: null, volume: 1, muted: false, pause() {}, async play() {} } as unknown as HTMLAudioElement,
    enableMicMeter: false, reconnect: { initialDelayMs: 25, maxDelayMs: 25 } });
  const h = sampleApp({ sdk, source, decodeName });
  const sessions = new Map<Socket, FakeSession>(), cursors = new Map<Socket, number>();
  const tick = async (ms = 1) => { now += ms; t.mock.timers.tick(ms); await flushSample(); };
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await tick(); assert.ok(predicate(), 'expected SDK progress'); };
  const attach = (socket: Socket) => { const session = new FakeSession(); sessions.set(socket, session); cursors.set(socket, 0); wire.hub.attach(session); drain(socket); return session; };
  function drain(socket: Socket, stopBeforeState = false): ServerMessage[] {
    const session = sessions.get(socket)!; const delivered: ServerMessage[] = [];
    let cursor = cursors.get(socket)!;
    while (cursor < session.inbox.length) {
      const message = session.inbox[cursor]!;
      if (stopBeforeState && message.type === 'room:state') break;
      cursor++; cursors.set(socket, cursor); delivered.push(message); socket.deliver(message);
    }
    return delivered;
  }
  async function command(session: FakeSession, data: Record<string, unknown>) {
    const message = parseClientMessage(JSON.stringify({ ...data, requestId: data.requestId ?? `discovery-${requestSequence++}` }), config.limits);
    await wire.hub.handle(session, message);
    assert.ok('requestId' in message, 'test commands use acknowledged protocol messages');
    const result = session.inbox.find(item => (item.type === 'ok' || item.type === 'error') && item.requestId === message.requestId);
    assert.equal(result?.type, 'ok', JSON.stringify(result));
  }
  async function publicRequest(work: Promise<void>, socket: Socket, type: string, hold = false) {
    void work.catch(() => {});
    await until(() => socket.sent.some(message => message.type === type && !handled.has(message)));
    const request = socket.sent.find(message => message.type === type && !handled.has(message))!; handled.add(request);
    await command(sessions.get(socket)!, request as unknown as Record<string, unknown>);
    const messages = drain(socket, hold); if (!hold) { await work; await flushSample(); }
    return { work, messages };
  }
  const handled = new Set<ClientMessage>();
  const join = sdk.join({ roomId: host.roomId, name: 'Viewer' }); await flushSample();
  const socket = Socket.instances.at(-1)!, session = attach(socket);
  await publicRequest(join, socket, 'join');
  const id = sdk.me!.participantId;
  if (mode !== 'offstage-controller') {
    await publicRequest(sdk.raiseHand(), socket, 'hand:raise');
    await command(host.s, { type: 'stage:approve', targetId: id }); drain(socket); await flushSample();
  }
  if (mode !== 'speaker') { await command(host.s, { type: 'control:transfer', targetId: id }); drain(socket); await flushSample(); }
  await command(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }); drain(socket); await flushSample();
  let received = 92, lost = 8;
  wire.transport.getStats = async () => ({ inbound: { packetsReceived: received, packetsLost: lost }, outbound: { fractionLost: 0.02 }, rttMs: 37 });
  const fireQuality = async (deliver = true) => {
    const timer = wire.timers.find(item => !item.cleared && item.ms === config.rooms.qualityIntervalMs); assert.ok(timer);
    timer.cleared = true; timer.fn(); await nextTurn(); if (deliver) drain(socket); await flushSample(); received += 92; lost += 8;
  };
  const panel = h.id('stage-quality');
  const list = h.find(node => node.classList.contains('stage-quality-list'));
  const view = () => ({ hidden: panel.hidden, open: panel.attributes.open === '', rows: list.children.map(row => row.textContent), role: sdk.me?.role, onStage: sdk.me?.onStage });
  await fireQuality(); panel.setAttribute('open', '');
  assert.equal(panel.hidden, false); assert.equal(list.children.length, 1); assert.match(list.textContent, /8\.0%.*2\.0%.*37 ms/);
  t.after(async () => {
    try { await h.cleanup(); await wire.hub.shutdown(); await wire.transport.close(); await flushSample(); }
    finally { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
  });
  return { ...h, wire, config, host, successor, socket, session, sdk, id, panel, list, view, command, publicRequest, drain, fireQuality, tick, until, attach, sessions, cursors };
}
function actualReset(h: Awaited<ReturnType<typeof actualSetup>>) {
  assert.equal(h.panel.hidden, true); assert.equal(h.panel.attributes.open, undefined); assert.equal(h.list.children.length, 0);
}
it('actual SDK/validator/Hub removal clears the panel at own role before the delayed state', async t => {
  const h = await actualSetup(t);
  await h.command(h.host.s, { type: 'stage:remove', targetId: h.id });
  const roleObservations: unknown[] = [];
  h.sdk.on('role', event => { if (event.detail.participantId === h.id) roleObservations.push(h.view()); });
  const messages = h.drain(h.socket, true); await h.tick(250);
  assert.equal(roleObservations.length, 1);
  assert.deepEqual(roleObservations[0], { hidden: true, open: false, rows: [], role: 'speaker', onStage: true });
  assert.deepEqual(messages.map(m => m.type), ['role:update', 'stage:left']);
  assert.match(h.app.textContent, /主控已將你移出舞台/);
  assert.equal(h.sdk.me!.role, 'speaker'); assert.equal(h.sdk.me!.onStage, true);
  actualReset(h);
  h.drain(h.socket); await flushSample(); actualReset(h);
  const qualityBefore = h.session.all('quality').length; await h.fireQuality();
  assert.equal(h.session.all('quality').length, qualityBefore, 'Hub excludes now-audience recipient'); actualReset(h);
});

it('actual public SDK leaveStage clears at the loss prefix, before state and request ACK', async t => {
  const h = await actualSetup(t);
  const result = await h.publicRequest(h.sdk.leaveStage(), h.socket, 'stage:leave', true);
  await h.tick(250); assert.deepEqual(result.messages.map(m => m.type), ['role:update', 'stage:left']);
  actualReset(h);
  const tail = h.drain(h.socket); await result.work; actualReset(h);
  assert.equal(tail[0]!.type, 'room:state'); assert.ok(tail.some(m => m.type === 'ok'));
});

it('actual public SDK offstage transfer clears at transferred before own role and delayed state', async t => {
  const h = await actualSetup(t, 'offstage-controller');
  const observations: unknown[] = [];
  h.sdk.on('transferred', () => observations.push({ event: 'transferred', ...h.view() }));
  h.sdk.on('role', event => { if (event.detail.participantId === h.id) observations.push({ event: 'own-role', ...h.view() }); });
  const result = await h.publicRequest(h.sdk.transferControl(h.successor.id), h.socket, 'control:transfer', true);
  await h.tick(250);
  assert.deepEqual(observations, ['transferred', 'own-role'].map(event => ({ event, hidden: true, open: false, rows: [], role: 'controller', onStage: false }))); assert.deepEqual(result.messages.map(m => m.type), ['control:transferred', 'role:update', 'role:update']);
  actualReset(h);
  h.drain(h.socket); await result.work; actualReset(h);
  const count = h.session.all('quality').length; await h.fireQuality(); assert.equal(h.session.all('quality').length, count); actualReset(h);
});

it('actual SDK control: onstage controller transfer preserves eligibility, historical rows and expansion', async t => {
  const h = await actualSetup(t, 'onstage-controller'), row = h.list.children[0];
  const result = await h.publicRequest(h.sdk.transferControl(h.successor.id), h.socket, 'control:transfer', true);
  assert.equal(h.panel.hidden, false); assert.equal(h.list.children[0], row); assert.equal(h.panel.attributes.open, '');
  h.drain(h.socket); await result.work; assert.equal(h.sdk.me!.role, 'speaker'); assert.equal(h.sdk.me!.onStage, true);
  assert.equal(h.panel.hidden, false); assert.equal(h.list.children[0], row); assert.equal(h.panel.attributes.open, '');
});

it('actual SDK control: controller stepping down remains eligible and retains another publisher history', async t => {
  const h = await actualSetup(t, 'onstage-controller'), row = h.list.children[0];
  const result = await h.publicRequest(h.sdk.leaveStage(), h.socket, 'stage:leave', true);
  assert.deepEqual(result.messages.map(m => m.type), ['stage:left']);
  assert.equal(h.panel.hidden, false); assert.equal(h.list.children[0], row);
  h.drain(h.socket); await result.work; assert.equal(h.sdk.me!.role, 'controller'); assert.equal(h.sdk.me!.onStage, false);
  assert.equal(h.panel.hidden, false); assert.equal(h.list.children[0], row); assert.equal(h.panel.attributes.open, '');
});

it('actual SDK control: unrelated departure, same-seat mic and rename changes do not revoke eligible viewer history', async t => {
  const h = await actualSetup(t, 'offstage-controller'), row = h.list.children[0], text = row!.textContent;
  await h.publicRequest(h.sdk.setName('Renamed Viewer'), h.socket, 'participant:rename');
  assert.equal(h.list.children[0], row); assert.equal(row!.textContent, text);
  await h.command(h.session, { type: 'stage:approve', targetId: h.id }); h.drain(h.socket); await flushSample();
  await h.publicRequest(h.sdk.mute(), h.socket, 'mic:mute'); assert.equal(h.list.children[0], row);
  assert.equal(h.list.children[0], row, 'microphone rejection from onstage promotion preserves historical transport report');
  await h.command(h.host.s, { type: 'stage:leave' }); const messages = h.drain(h.socket, true);
  assert.deepEqual(messages.map(m => m.type), ['role:update', 'stage:left']);
  assert.equal(h.panel.hidden, false); assert.equal(h.list.children[0], row, 'another participant departure does not retire own viewer');
  h.drain(h.socket); assert.equal(h.panel.hidden, false); assert.equal(h.list.children.length, 0, 'current roster prunes departed publisher');
});

it('actual SDK control: an in-flight old stats round settling after demotion is not sent to demoted viewer', async t => {
  const h = await actualSetup(t); const pending = Promise.withResolvers<Awaited<ReturnType<typeof h.wire.transport.getStats>>>();
  h.wire.transport.getStats = () => pending.promise;
  const timer = h.wire.timers.find(item => !item.cleared && item.ms === h.config.rooms.qualityIntervalMs)!;
  const before = h.session.all('quality').length; timer.cleared = true; timer.fn(); await flushSample();
  await h.command(h.host.s, { type: 'stage:remove', targetId: h.id });
  pending.resolve({ inbound: { packetsReceived: 184, packetsLost: 16 }, rttMs: 99 }); await nextTurn();
  assert.equal(h.session.all('quality').length, before);
  const messages = h.drain(h.socket); assert.equal(messages.filter(m => m.type === 'quality').length, 0); actualReset(h);
});

it('actual SDK control: reconnect clears reports and old socket frames cannot repopulate; resume waits for next report', async t => {
  const h = await actualSetup(t); const oldQuality = h.session.last('quality')!;
  h.socket.close(); await h.wire.hub.detach(h.session); await flushSample();
  assert.equal(h.sdk.status, 'reconnecting'); assert.equal(h.panel.hidden, false); assert.equal(h.list.children.length, 0); assert.equal(h.panel.attributes.open, '');
  h.socket.deliver(oldQuality); assert.equal(h.list.children.length, 0, 'SDK rejects frames from retired socket');
  await h.tick(25); const resumed = Socket.instances.at(-1)!; assert.notEqual(resumed, h.socket); const session = h.attach(resumed);
  await h.until(() => resumed.sent.some(m => m.type === 'join'));
  const request = resumed.sent.find(m => m.type === 'join')!;
  await h.command(session, request as unknown as Record<string, unknown>);
  h.drain(resumed); await flushSample(); assert.equal(h.sdk.me!.participantId, h.id);
  assert.equal(h.list.children.length, 0); assert.equal(h.panel.attributes.open, '');
  await h.fireQuality(false); h.drain(resumed); assert.equal(h.list.children.length, 1);
});

it('actual SDK control: public room replacement clears reports and expansion; retired socket report cannot revive', async t => {
  const h = await actualSetup(t), oldQuality = h.session.last('quality')!;
  const another = await h.wire.create('Second Host', { codeRequired: false });
  h.socket.close(); await h.wire.hub.detach(h.session); await flushSample();
  const join = h.sdk.join({ roomId: another.roomId, name: 'Second Viewer' }); await flushSample();
  const socket = Socket.instances.at(-1)!; h.attach(socket); await h.publicRequest(join, socket, 'join');
  actualReset(h); h.socket.deliver(oldQuality); actualReset(h);
  const id = h.sdk.me!.participantId; await h.command(another.s, { type: 'control:transfer', targetId: id }); h.drain(socket); await flushSample();
  assert.equal(h.panel.hidden, false); assert.equal(h.list.children.length, 0); assert.equal(h.panel.attributes.open, undefined);
});


it('actual SDK control: role loss then transport loss stays hidden against the retained old snapshot until resume state', async t => {
  const h = await actualSetup(t);
  await h.command(h.host.s, { type: 'stage:remove', targetId: h.id }); h.drain(h.socket, true);
  h.socket.close(); await h.wire.hub.detach(h.session); await flushSample();
  assert.equal(h.sdk.status, 'reconnecting'); assert.equal(h.sdk.me!.onStage, true);
  actualReset(h);
  await h.tick(25); const resumed = Socket.instances.at(-1)!; const session = h.attach(resumed);
  await h.until(() => resumed.sent.some(m => m.type === 'join'));
  await h.command(session, resumed.sent.find(m => m.type === 'join')! as unknown as Record<string, unknown>);
  h.drain(resumed); await flushSample(); assert.equal(h.sdk.me!.onStage, false); actualReset(h);
});

it('actual SDK control: same-seat reapproval needs a new quality event and does not restore predeparture history', async t => {
  const h = await actualSetup(t);
  await h.command(h.host.s, { type: 'stage:remove', targetId: h.id }); h.drain(h.socket); actualReset(h);
  await h.command(h.session, { type: 'hand:raise' }); h.drain(h.socket);
  await h.command(h.host.s, { type: 'stage:approve', targetId: h.id }); h.drain(h.socket); await flushSample();
  assert.equal(h.panel.hidden, false); assert.equal(h.panel.attributes.open, undefined); assert.equal(h.list.children.length, 0);
  await h.fireQuality(); assert.equal(h.list.children.length, 1);
});
// The following are synthetic host-callback probes, not claims about wire ordering or replay.
type App = ReturnType<typeof sampleApp>;
type View = Pick<App, 'app' | 'find' | 'id'>;
const clone = <T>(value: T): T => structuredClone(value);
function eligibleState(me: Partial<ParticipantView> = {}): RoomStatePayload {
  const state = roomState({ participantId: 'viewer', name: 'Viewer', role: 'speaker', onStage: true, ...me });
  state.speakers = [{ ...state.me, participantId: 'publisher', name: 'Publisher', role: 'speaker', onStage: true }];
  if (state.me.onStage) state.speakers.unshift(state.me);
  state.status = 'live'; return state;
}
const report = (rttMs = 37): ConnectionQuality => ({ participantId: 'publisher', uplinkLossPercent: 8, downlinkLossPercent: 2, rttMs });
const panel = (h: View) => h.id('stage-quality');
const list = (h: View) => h.find(node => node.classList.contains('stage-quality-list'));
const statusLine = (h: View) => h.find(node => node.classList.contains('stage-quality-status'));
function syntheticReset(h: View): void {
  assert.equal(panel(h).hidden, true); assert.equal(panel(h).attributes.open, undefined);
  assert.equal(list(h).children.length, 0); assert.equal(statusLine(h).textContent, '');
}
async function syntheticSetup(t: TestContext, state = eligibleState()) {
  const h = sampleApp({ source, decodeName }); t.after(() => h.cleanup()); await flushSample();
  h.sdk.snapshot(state); h.sdk.emit('quality', { participants: [report()] }); panel(h).setAttribute('open', '');
  assert.equal(list(h).children.length, 1); return h;
}
type Loss = 'role' | 'stageleft' | 'transferred';
function lose(h: App, kind: Loss, participantId = h.sdk.me!.participantId): void {
  if (kind === 'role') h.sdk.emit('role', { participantId, role: 'audience' });
  else if (kind === 'stageleft') {
    const detail = { participantId, role: 'audience' as const, reason: 'removed' }; h.sdk.emit('stageleft', detail);
  } else h.sdk.emit('transferred', { fromId: participantId, toId: 'successor' });
}
function lossState(kind: Loss): RoomStatePayload {
  return eligibleState(kind === 'transferred' ? { role: 'controller', onStage: false } : {});
}

type Surface = 'hidden' | 'open' | 'status' | 'list';
function onReset(h: View, surface: Surface, callback: () => void): () => boolean {
  let fired = false;
  const invoke = () => { if (!fired) { fired = true; callback(); } };
  if (surface === 'hidden') {
    const node = panel(h); let hidden = node.hidden;
    Object.defineProperty(node, 'hidden', { configurable: true, get: () => hidden,
      set(value: boolean) { hidden = value; if (value) invoke(); } });
  } else if (surface === 'open') {
    const node = panel(h), remove = node.removeAttribute.bind(node);
    node.removeAttribute = name => { remove(name); if (name === 'open') invoke(); };
  } else if (surface === 'status') {
    const node = statusLine(h), descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!;
    Object.defineProperty(node, 'textContent', { configurable: true, get() { return descriptor.get!.call(node); },
      set(value: string) { descriptor.set!.call(node, value); if (value === '') invoke(); } });
  } else {
    const node = list(h), replace = node.replaceChildren.bind(node);
    node.replaceChildren = (...nodes) => { replace(...nodes); if (!nodes.length) invoke(); };
  }
  return () => fired;
}

for (const kind of ['role', 'stageleft', 'transferred'] as const) {
  it(`synthetic ${kind} loss blocks old-snapshot status/report/ordinary render and releases only at new current state`, async t => {
    const state = lossState(kind), h = await syntheticSetup(t, state), jobs = [...h.clock.jobs.keys()];
    lose(h, kind); syntheticReset(h); assert.equal(h.sdk.state, state);
    for (const status of ['waiting', 'live', 'reconnecting', 'live'] as const) { h.sdk.setStatus(status); syntheticReset(h); }
    h.sdk.emit('quality', { participants: [report(90)] }); syntheticReset(h);
    h.sdk.emit('state', state); syntheticReset(h);
    h.sdk.emit('state', clone(state)); syntheticReset(h);
    h.sdk.emit('micerror', { name: 'NotAllowedError', message: 'permission denied' }); syntheticReset(h);
    assert.deepEqual([...h.clock.jobs.keys()], jobs);
    assert.equal(h.sdk.polls.length, 0); assert.equal(h.sdk.raises.length, 0); assert.equal(h.sdk.previews.length, 0);
    const ineligible = eligibleState({ role: 'audience', onStage: false });
    h.sdk.snapshot(ineligible); syntheticReset(h); h.sdk.emit('quality', { participants: [report(80)] }); syntheticReset(h);
    h.sdk.snapshot(clone(state)); assert.equal(panel(h).hidden, false); assert.equal(panel(h).attributes.open, undefined);
    assert.equal(list(h).children.length, 0); h.sdk.emit('quality', { participants: [report(15)] });
    assert.match(list(h).textContent, /RTT 15 ms/); assert.doesNotMatch(list(h).textContent, /37 ms|80 ms|90 ms/);
  });

  for (const surface of ['hidden', 'open', 'status', 'list'] as const) {
    it(`synthetic ${kind} reserves suppression before ${surface} reset callback reenters old status/report`, async t => {
      const state = lossState(kind), h = await syntheticSetup(t, state);
      const fired = onReset(h, surface, () => {
        h.sdk.setStatus('waiting'); h.sdk.emit('quality', { participants: [report(90)] }); h.sdk.emit('state', state);
      });
      lose(h, kind); assert.equal(fired(), true); syntheticReset(h);
      h.sdk.snapshot(clone(state)); assert.equal(panel(h).hidden, false); assert.equal(list(h).children.length, 0);
    });

    it(`synthetic ${kind} ${surface} reset cannot erase a nested new eligible state and its new report`, async t => {
      const h = await syntheticSetup(t, lossState(kind)); let retained: SampleNode | undefined;
      const fired = onReset(h, surface, () => {
        h.sdk.snapshot(eligibleState({ participantId: 'new-viewer', role: 'controller', onStage: false }));
        h.sdk.emit('quality', { participants: [report(12)] }); panel(h).setAttribute('open', '');
        retained = list(h).children[0];
      });
      lose(h, kind); assert.equal(fired(), true); assert.equal(h.sdk.me!.participantId, 'new-viewer');
      assert.equal(panel(h).hidden, false); assert.equal(panel(h).attributes.open, '');
      assert.equal(list(h).children[0], retained); assert.match(list(h).textContent, /RTT 12 ms/);
      assert.equal(statusLine(h).textContent, '最近收到的伺服器回報；RTT 不是端到端音訊延遲。');
      h.sdk.emit('status', 'live'); assert.equal(list(h).children[0], retained);
    });
  }
}

it('synthetic stageleft trusts its resulting controller role rather than the retained snapshot role', async t => {
  const h = await syntheticSetup(t, eligibleState({ role: 'controller' }));
  lose(h, 'stageleft'); syntheticReset(h);
  h.sdk.snapshot(eligibleState({ role: 'speaker' })); h.sdk.emit('quality', { participants: [report()] }); panel(h).setAttribute('open', '');
  const row = list(h).children[0], detail = { participantId: 'viewer', role: 'controller' as const };
  h.sdk.emit('stageleft', detail); assert.equal(panel(h).hidden, false); assert.equal(list(h).children[0], row);
  assert.equal(panel(h).attributes.open, '');
});

it('synthetic other-participant losses, incoming transfer and onstage transfer preserve the reader history', async t => {
  const h = await syntheticSetup(t, eligibleState({ role: 'controller' })), row = list(h).children[0];
  for (const kind of ['role', 'stageleft', 'transferred'] as const) lose(h, kind, 'someone-else');
  h.sdk.emit('transferred', { fromId: 'someone-else', toId: 'viewer' }); lose(h, 'transferred');
  h.sdk.emit('role', { participantId: 'viewer', role: 'speaker' });
  assert.equal(panel(h).hidden, false); assert.equal(panel(h).attributes.open, ''); assert.equal(list(h).children[0], row);
});

for (const terminal of ['closed', 'kicked', 'leave'] as const) {
  it(`synthetic ${terminal} after loss permits same-seat rejoin but never restores the old report`, async t => {
    const initial = eligibleState(), h = await syntheticSetup(t, initial); lose(h, 'role');
    if (terminal === 'leave') await h.sdk.disconnect(); else await h.sdk.terminal(terminal);
    syntheticReset(h); h.sdk.emit('quality', { participants: [report(99)] }); syntheticReset(h);
    h.sdk.snapshot(clone(initial)); assert.equal(panel(h).hidden, false); assert.equal(panel(h).attributes.open, undefined);
    assert.equal(list(h).children.length, 0); h.sdk.emit('quality', { participants: [report(11)] }); assert.match(list(h).textContent, /RTT 11 ms/);
  });
}

it('synthetic early loss preserves ordinary row quality warnings, own statistics, hidden-page policy and timers', async t => {
  const h = await syntheticSetup(t); h.clock.advance(2000);
  h.sdk.polls[0]!.resolve({ inbound: { lossPercent: 8, rtt: .05, bufferMs: 3 }, outbound: null }); await flushSample();
  const connection = h.find(node => node.classList.contains('connection')), text = connection.textContent;
  const badge = h.find(node => node.classList.contains('badge') && node.classList.contains('quality')), warning = badge.textContent;
  const jobs = [...h.clock.jobs.keys()]; lose(h, 'role'); syntheticReset(h);
  assert.equal(connection.textContent, text); assert.equal(connection.classList.contains('error'), true);
  assert.equal(badge.textContent, warning); assert.equal(badge.isConnected, true); assert.deepEqual([...h.clock.jobs.keys()], jobs);
  h.setHidden(true); syntheticReset(h); assert.equal(connection.textContent, '');
  h.setHidden(false); syntheticReset(h); assert.equal(h.sdk.polls.length, 2);
  h.sdk.polls[1]!.resolve({ inbound: null, outbound: null }); await flushSample();
});

for (const surface of ['hidden', 'open', 'status', 'list'] as const) {
  it(`synthetic replacement ${surface} quality reset retires old actions before admitting a newer entry`, async t => {
    const h = await syntheticSetup(t, eligibleState({ role: 'controller' }));
    const oldAction = h.button('離開舞台'); let forwarded = 0, latest: SampleNode | undefined;
    Object.assign(h.sdk, { async leaveStage() { forwarded++; } });
    const fired = onReset(h, surface, () => {
      oldAction.click();
      const next = eligibleState({ participantId: 'latest', role: 'controller', onStage: false }); next.roomId = 'latest-room';
      h.sdk.snapshot(next); h.sdk.emit('quality', { participants: [report(13)] }); panel(h).setAttribute('open', '');
      latest = h.button('返回舞台');
    });
    const replacement = eligibleState({ role: 'controller' }); replacement.roomId = 'superseded-room';
    h.sdk.snapshot(replacement); await flushSample(); assert.equal(fired(), true); assert.equal(forwarded, 0);
    assert.equal(h.sdk.state!.roomId, 'latest-room'); assert.equal(h.button('返回舞台'), latest);
    assert.equal(panel(h).hidden, false); assert.equal(panel(h).attributes.open, ''); assert.match(list(h).textContent, /RTT 13 ms/);
    assert.match(h.app.textContent, /latest-room/); assert.doesNotMatch(h.app.textContent, /superseded-room/);
  });
}

for (const surface of ['row', 'list', 'status'] as const) {
  it(`synthetic ${surface} report paint cannot continue over nested loss or a new eligible report`, async t => {
    const h = await syntheticSetup(t); let fired = false, retained: SampleNode | undefined;
    const enter = () => {
      if (fired) return; fired = true; lose(h, 'role');
      h.sdk.snapshot(eligibleState({ participantId: 'new-viewer' })); h.sdk.emit('quality', { participants: [report(14)] });
      retained = list(h).children[0]; panel(h).setAttribute('open', '');
    };
    if (surface === 'list') {
      const node = list(h), replace = node.replaceChildren.bind(node);
      node.replaceChildren = (...nodes) => { replace(...nodes); enter(); };
      h.sdk.emit('quality', { participants: [] });
    } else {
      const node = surface === 'row' ? list(h).children[0]! : statusLine(h);
      const descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!;
      Object.defineProperty(node, 'textContent', { configurable: true, get() { return descriptor.get!.call(node); },
        set(value: string) { descriptor.set!.call(node, value); enter(); } });
      h.sdk.emit('quality', { participants: [report(90)] });
    }
    assert.equal(fired, true); assert.equal(panel(h).hidden, false); assert.equal(panel(h).attributes.open, '');
    assert.equal(list(h).children[0], retained); assert.match(list(h).textContent, /RTT 14 ms/);
    assert.equal(statusLine(h).textContent, '最近收到的伺服器回報；RTT 不是端到端音訊延遲。');
  });
}

it('synthetic replacement quality reset cannot let an old action rejection unlock a newer pending action', async t => {
  const h = await syntheticSetup(t, eligibleState({ role: 'controller' }));
  h.id('audio-retry').click(); const old = h.sdk.audioRetries[0]!; let latest: SampleNode | undefined;
  const fired = onReset(h, 'hidden', () => {
    const next = eligibleState({ participantId: 'latest-owner', role: 'controller', onStage: false }); next.roomId = 'latest-room';
    h.sdk.snapshot(next); h.sdk.emit('quality', { participants: [report(16)] });
    latest = h.id('audio-retry'); latest.click(); old.reject(new Error('old action rejection'));
  });
  const next = eligibleState({ role: 'controller' }); next.roomId = 'superseded-room'; h.sdk.snapshot(next);
  assert.equal(fired(), true); await flushSample(); assert.equal(h.id('audio-retry'), latest);
  assert.equal(latest!.disabled, true); assert.equal(latest!.attributes['aria-busy'], 'true');
  assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true); assert.match(list(h).textContent, /RTT 16 ms/);
  latest!.onclick!(); assert.equal(h.sdk.audioRetries.length, 2);
  h.sdk.audioRetries[1]!.resolve(undefined); await flushSample(); assert.equal(latest!.disabled, false);
});
