import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Deferred, flushSample, roomState, sampleApp, SampleNode } from './fixtures/sampleApp.ts';
import { FakeSession, harness, testConfig } from './helpers.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import type { RoomStatePayload } from '../shared/protocol.ts';

// Complete production sample and actual SDK/validator/Hub execute unchanged. DOM, RTC, sockets
// and clocks are controlled boundaries; no native-browser, permission, or physical-audio claim.
const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
interface Request { type: string; requestId: string; roomId?: string; resumeToken?: string }
class Socket {
  static OPEN = 1; static instances: Socket[] = [];
  readyState = 1; sent: Request[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(data)); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
type Report = Map<string, Record<string, unknown>>;
class Peer {
  static instances: Peer[] = [];
  connectionState = 'connected'; signalingState = 'stable'; localDescription = null;
  closes = 0; polls: Deferred<Report>[] = []; rejectOffer?: (error: Error) => void;
  onconnectionstatechange?: () => void;
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return { direction: 'recvonly', sender: { track: null, async replaceTrack() {} } }; }
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  getStats() { const work = new Deferred<Report>(); this.polls.push(work); return work.promise; }
  close() { this.closes++; this.connectionState = 'closed'; this.rejectOffer?.(new Error('fixture teardown')); }
}
function report(time: number, rtt = 0.18, lost = time / 20): Report {
  return new Map([
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp: time, bytesReceived: time * 8,
      packetsReceived: time / 5, packetsLost: lost, jitterBufferDelay: time / 1000, jitterBufferEmittedCount: time / 10 }],
    ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: rtt }],
  ]);
}
interface Sdk { readonly state: RoomStatePayload | null; readonly status: string;
  disconnect(): Promise<void>; getStats(): Promise<{ inbound: { lossPercent?: number; rtt?: number; bufferMs?: number } | null; outbound: unknown }>; }
async function actualSetup(t: TestContext) {
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.participantGraceMs = 1000; c.limits.controlPerSecond = 2000; });
  const wire = harness(config), host = await wire.create('Host', { codeRequired: false });
  const globals = { window: new EventTarget(), WebSocket: Socket, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { enumerateDevices: async () => [] } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Socket.instances = []; Peer.instances = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0; t.mock.method(performance, 'now', () => now);
  const audio = { volume: 0.37, muted: true, pauses: 0, srcObject: {} as unknown, pause() { this.pauses++; } };
  const sdk: Sdk = new StageClient({ url: 'ws://localhost/ws', audioElement: audio, enableMicMeter: false,
    reconnect: { initialDelayMs: 25, maxDelayMs: 25 } });
  const h = sampleApp({ sdk, source });
  const sessions = new Map<Socket, FakeSession>();
  const tick = async (ms = 1) => { now += ms; t.mock.timers.tick(ms); await flushSample(); };
  const until = async (predicate: () => boolean) => {
    for (let n = 0; n < 100 && !predicate(); n++) await tick();
    assert.ok(predicate(), 'SDK must make expected socket progress');
  };
  const attach = (socket: Socket) => { const s = new FakeSession(); sessions.set(socket, s); wire.hub.attach(s); socket.deliver(s.last('hello')!); return s; };
  const accept = async (socket: Socket, request: Request) => {
    const s = sessions.get(socket)!; const before = s.inbox.length;
    await wire.hub.handle(s, parseClientMessage(JSON.stringify(request), config.limits));
    const replies = s.inbox.slice(before);
    assert.ok(replies.some(m => m.type === 'ok' && m.requestId === request.requestId));
    for (const reply of replies) socket.deliver(reply);
    await flushSample(); return s.last('room:state')!;
  };
  t.after(async () => {
    try {
      await h.cleanup();
      for (const p of Peer.instances) for (const poll of p.polls) if (poll.status === 'pending') poll.reject(new Error('fixture cleanup'));
      await flushSample(); await wire.hub.shutdown(); await wire.transport.close();
      assert.ok(Peer.instances.every(p => p.closes === 1));
      assert.ok(Peer.instances.every(p => p.polls.every(poll => poll.status !== 'pending')));
    } finally { for (const [key, old] of originals) { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); } }
  });
  await flushSample();
  const form = h.find(n => n.tagName === 'form' && n.children.some(c => c.tagName === 'h2' && c.textContent === '加入房間'));
  for (const input of form.descendants()) { if (input.name === 'name') input.value = 'Reader'; if (input.name === 'roomId') input.value = host.roomId; }
  form.submit(); await flushSample(); const socket = Socket.instances.at(-1)!; attach(socket);
  await until(() => socket.sent.some(m => m.type === 'join'));
  await accept(socket, socket.sent.find(m => m.type === 'join')!);
  assert.equal(sdk.status, sdk.state!.status); assert.equal(Peer.instances.length, 1);
  const line = () => h.find(n => n.classList.contains('connection'));
  const seed = async () => {
    const peer = Peer.instances.at(-1)!;
    h.clock.advance(2000); peer.polls.at(-1)!.resolve(report(2000)); await flushSample();
    h.clock.advance(2000); peer.polls.at(-1)!.resolve(report(4000)); await flushSample();
    assert.match(line().textContent, /接收掉包 20\.0%.*接收 RTT 180 ms.*接收緩衝 10 ms/);
    assert.equal(line().classList.contains('error'), true);
    return peer;
  };
  const drop = async () => { socket.close(); await wire.hub.detach(sessions.get(socket)!); await flushSample(); assert.equal(sdk.status, 'reconnecting'); };
  const resume = async () => {
    await tick(25); const resumed = Socket.instances.at(-1)!; assert.notEqual(resumed, socket); attach(resumed);
    await until(() => resumed.sent.some(m => m.type === 'join'));
    const request = resumed.sent.find(m => m.type === 'join')!; assert.ok(request.resumeToken);
    const state = await accept(resumed, request); return { resumed, state };
  };
  return { ...h, audio, wire, config, host, sessions, socket, seed, line, drop, resume, tick, accept, attach };
}


it('full sample actual retained-peer reconnect preserves rendered history, scheduler and shared delta baseline', async t => {
  const h = await actualSetup(t), peer = await h.seed(), id = h.sdk.state!.me.participantId;
  const timer = h.clock.intervals(2000)[0], beforePauses = h.audio.pauses, oldText = h.line().textContent;
  const count = writes(h.line());
  h.clock.advance(2000); const beforeDrop = peer.polls.at(-1)!;
  await h.drop(); assert.equal(peer.closes, 0); assert.equal(h.line().textContent, oldText);
  assert.equal(count.text, 0); assert.equal(count.error, 0); assert.equal(h.clock.intervals(2000)[0], timer);
  beforeDrop.resolve(report(6000, 0.04)); await flushSample(); assert.match(h.line().textContent, /接收掉包 20\.0%.*接收 RTT 40 ms.*接收緩衝 10 ms/);
  h.clock.advance(2000); peer.polls.at(-1)!.resolve(report(8000, 0.03)); await flushSample();
  assert.match(h.line().textContent, /接收 RTT 30 ms/);
  const { state } = await h.resume(); assert.equal(state.me.participantId, id); assert.equal(Peer.instances.at(-1), peer);
  assert.equal(h.audio.pauses, beforePauses); assert.equal(h.clock.intervals(2000)[0], timer);
  assert.equal(count.text, 2); assert.equal(count.error, 2); assert.equal(peer.polls.length, 4);
});

for (const settlement of ['resolve', 'reject'] as const) {
  it(`full sample actual grace expiry retires prior-seat history before old ${settlement} and a failed first new poll`, async t => {
    const h = await actualSetup(t), old = await h.seed(), oldId = h.sdk.state!.me.participantId;
    const timer = h.clock.intervals(2000)[0], count = writes(h.line());
    h.clock.advance(2000); const pendingOld = old.polls.at(-1)!;
    await h.drop(); const expiry = h.wire.timers.find(timer => !timer.cleared && timer.ms === h.config.rooms.participantGraceMs)!;
    assert.ok(expiry); expiry.cleared = true; expiry.fn(); await nextTurn();
    const { state } = await h.resume(); assert.notEqual(state.me.participantId, oldId);
    const fresh = Peer.instances.at(-1)!; assert.notEqual(fresh, old); assert.equal(old.closes, 1);
    cleared(h); assert.equal(count.text, 1); assert.equal(count.error, 1);
    assert.equal(h.clock.intervals(2000)[0], timer); assert.equal(h.clock.jobs.get(timer!)!.due, 8000);
    assert.equal(old.polls.length, 3); assert.equal(fresh.polls.length, 0, 'seat replacement adds no immediate stats poll');
    if (settlement === 'resolve') pendingOld.resolve(report(6000, 0.9));
    else pendingOld.reject(new Error('retired peer unavailable'));
    await flushSample(); cleared(h); assert.equal(count.text, 1); assert.equal(count.error, 1);
    h.clock.advance(2000); fresh.polls.at(-1)!.reject(new Error('new peer stats unavailable')); await flushSample();
    cleared(h); assert.equal(count.text, 1); assert.equal(count.error, 1);
    h.clock.advance(2000); fresh.polls.at(-1)!.resolve(report(10000, 0.02)); await flushSample();
    assert.equal(h.line().textContent, '你的連線（上次完成讀取；SDK 取樣區間）：接收掉包 —% · 接收 RTT 20 ms · 接收緩衝 — ms；傳送：暫無統計。RTT 不是端到端音訊延遲；不保證資料即時或目前可聽。'); assert.equal(h.line().classList.contains('error'), false);
    h.clock.advance(2000); fresh.polls.at(-1)!.resolve(report(12000, 0.03)); await flushSample();
    assert.match(h.line().textContent, /接收掉包 20\.0%.*接收 RTT 30 ms.*接收緩衝 10 ms/);
    assert.equal(count.text, 3); assert.equal(count.error, 3); assert.equal(fresh.polls.length, 3);
    assert.equal(h.audio.volume, 0.37); assert.equal(h.audio.muted, true);
  });
}

it('full sample actual public join to another room retires prior-room rendered diagnostics', async t => {
  const h = await actualSetup(t), old = await h.seed();
  const another = await h.wire.create('Another', { codeRequired: false });
  const timer = h.clock.intervals(2000)[0], count = writes(h.line());
  await h.drop();
  const sdk = h.sdk as Sdk & { join(options: { roomId: string; name: string }): Promise<void> };
  const join = sdk.join({ roomId: another.roomId, name: 'Reader' }); await flushSample();
  const socket = Socket.instances.at(-1)!; h.attach(socket);
  for (let n = 0; n < 50 && !socket.sent.some(m => m.type === 'join'); n++) await h.tick();
  await h.accept(socket, socket.sent.find(m => m.type === 'join')!); await join;
  assert.equal(h.sdk.state!.roomId, another.roomId); assert.equal(old.closes, 1); cleared(h);
  assert.equal(count.text, 1); assert.equal(count.error, 1); assert.equal(h.clock.intervals(2000)[0], timer);
  const fresh = Peer.instances.at(-1)!; assert.equal(fresh.polls.length, 0);
  h.clock.advance(2000); fresh.polls.at(-1)!.reject(new Error('no current stats')); await flushSample(); cleared(h);
  h.clock.advance(2000); fresh.polls.at(-1)!.resolve(report(8000, 0.025)); await flushSample();
  assert.equal(h.line().textContent, '你的連線（上次完成讀取；SDK 取樣區間）：接收掉包 —% · 接收 RTT 25 ms · 接收緩衝 — ms；傳送：暫無統計。RTT 不是端到端音訊延遲；不保證資料即時或目前可聽。'); assert.equal(h.line().classList.contains('error'), false);
});

it('full sample actual hidden/resume and external stats retain SDK delta baselines and completion fencing', async t => {
  const h = await actualSetup(t), peer = await h.seed();
  h.clock.advance(2000); const hiddenPending = peer.polls.at(-1)!;
  const retired = h.clock.jobs.get(h.clock.intervals(2000)[0]!)!.callback;
  h.setHidden(true); cleared(h); assert.equal(h.clock.intervals(2000).length, 0);
  h.clock.advance(10000); assert.equal(peer.polls.length, 3); h.setHidden(false); assert.equal(peer.polls.length, 4);
  const timer = h.clock.intervals(2000)[0]; retired(); assert.equal(peer.polls.length, 4);
  peer.polls[3]!.resolve(report(16000, 0.05)); await flushSample();
  assert.match(h.line().textContent, /接收掉包 20\.0%.*接收 RTT 50 ms.*接收緩衝 10 ms/);
  hiddenPending.resolve(report(6000, 0.9)); await flushSample(); assert.match(h.line().textContent, /接收 RTT 50 ms/);
  const external = h.sdk.getStats(); peer.polls[4]!.resolve(report(17000, 0.06, 850)); await external;
  h.clock.advance(2000); peer.polls[5]!.resolve(report(18000, 0.07, 850)); await flushSample();
  assert.match(h.line().textContent, /接收掉包 0\.0%.*接收 RTT 70 ms/); assert.equal(h.line().classList.contains('error'), false);
  assert.equal(h.clock.intervals(2000)[0], timer); assert.equal(peer.closes, 0);
});

type App = ReturnType<typeof sampleApp>;
type View = Pick<App, 'find'>;
const connection = (h: View) => h.find(node => node.classList.contains('connection'));
const result = (rtt = 0.18, lossPercent = 20) => ({ inbound: { rtt, lossPercent, bufferMs: 10 }, outbound: null });
function cleared(h: View): void {
  assert.equal(connection(h).textContent, '', 'retired seat history must not appear under the replacement owner');
  assert.equal(connection(h).classList.contains('error'), false, 'retired seat warning must also disappear');
}
function writes(line: SampleNode) {
  const count = { text: 0, error: 0 }, descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!;
  Object.defineProperty(line, 'textContent', { configurable: true, get() { return descriptor.get!.call(line); },
    set(value: string) { count.text++; descriptor.set!.call(line, value); } });
  const toggle = line.classList.toggle;
  line.classList.toggle = (name, force) => { if (name === 'error') count.error++; return toggle(name, force); };
  return count;
}
async function setup(t: TestContext) {
  const h = sampleApp({ source }); t.after(() => h.cleanup()); await flushSample(); h.sdk.snapshot(roomState());
  h.clock.advance(2000); h.sdk.polls[0]!.resolve(result()); await flushSample();
  assert.match(connection(h).textContent, /接收掉包 20\.0%.*接收 RTT 180 ms.*接收緩衝 10 ms/);
  assert.equal(connection(h).classList.contains('error'), true);
  return h;
}

for (const identity of ['room', 'participant'] as const) {
  for (const settlement of ['resolve', 'reject'] as const) {
    it(`full sample direct ${identity} replacement clears both history fields before old ${settlement}, new failure and ordered recovery`, async t => {
      const h = await setup(t), line = connection(h), count = writes(line), timer = h.clock.intervals(2000)[0]!;
      h.clock.advance(2000); const old = h.sdk.polls.at(-1)!;
      const replacement = identity === 'room' ? { ...roomState(), roomId: 'next-room' } : roomState({ participantId: 'next-person' });
      h.sdk.snapshot(replacement); cleared(h); assert.equal(connection(h), line);
      assert.equal(count.text, 1); assert.equal(count.error, 1); assert.equal(h.sdk.polls.length, 2);
      assert.deepEqual(h.clock.intervals(2000), [timer]); assert.equal(h.clock.jobs.get(timer)!.due, 6000);
      if (settlement === 'resolve') old.resolve(result(0.9, 90)); else old.reject(new Error('old failure'));
      await flushSample(); cleared(h); assert.equal(count.text, 1); assert.equal(count.error, 1);
      h.clock.advance(2000); h.sdk.polls.at(-1)!.reject(new Error('first new failure')); await flushSample(); cleared(h);
      h.clock.advance(4000); const [earlier, later] = h.sdk.polls.slice(-2);
      later!.resolve(result(0.02, 0)); await flushSample(); assert.match(line.textContent, /接收 RTT 20 ms/);
      assert.equal(line.classList.contains('error'), false);
      earlier!.resolve(result(0.7, 70)); await flushSample(); assert.match(line.textContent, /接收 RTT 20 ms/);
      assert.equal(count.text, 2); assert.equal(count.error, 2); assert.equal(h.sdk.polls.length, 5);
      assert.equal(h.sdk.joins.length, 0); assert.equal(h.sdk.raises.length, 0); assert.equal(h.sdk.previews.length, 0);
      assert.deepEqual(h.sdk.inputDevices, []); assert.deepEqual(h.sdk.outputDevices, []);
    });
  }
}

it('full sample ordinary snapshots and same-seat reconnect add no history writes, timers or operations', async t => {
  const h = await setup(t), line = connection(h), count = writes(line), text = line.textContent;
  const jobs = [...h.clock.jobs.keys()];
  for (let i = 0; i < 5; i++) h.sdk.snapshot(roomState());
  h.sdk.snapshot({ ...roomState(), audienceCount: 3 }); h.sdk.setStatus('reconnecting');
  h.sdk.snapshot({ ...roomState(), name: 'Same seat renamed room' });
  assert.equal(line.textContent, text); assert.equal(line.classList.contains('error'), true);
  assert.equal(count.text, 0); assert.equal(count.error, 0); assert.deepEqual([...h.clock.jobs.keys()], jobs);
  assert.equal(h.sdk.polls.length, 1); h.clock.advance(2000); h.sdk.polls[1]!.resolve(result(0.03, 0)); await flushSample();
  assert.equal(count.text, 1); assert.equal(count.error, 1); assert.match(line.textContent, /接收 RTT 30 ms/);
  assert.equal(h.sdk.joins.length, 0); assert.equal(h.sdk.raises.length, 0); assert.equal(h.sdk.previews.length, 0);
});

it('full sample identity replacement while hidden keeps retired results fenced across resumed polling', async t => {
  const h = await setup(t); h.clock.advance(2000); const old = h.sdk.polls[1]!;
  h.setHidden(true); cleared(h); h.sdk.snapshot(roomState({ participantId: 'hidden-replacement' })); cleared(h);
  assert.equal(h.clock.intervals(2000).length, 0); h.clock.advance(6000); assert.equal(h.sdk.polls.length, 2);
  h.setHidden(false); assert.equal(h.sdk.polls.length, 3);
  old.resolve(result(0.9, 90)); await flushSample(); cleared(h);
  h.sdk.polls[2]!.reject(new Error('resumed sample failed')); await flushSample(); cleared(h);
  h.clock.advance(2000); h.sdk.polls[3]!.resolve(result(0.02, 0)); await flushSample();
  assert.match(connection(h).textContent, /接收 RTT 20 ms/); assert.equal(connection(h).classList.contains('error'), false);
});

for (const property of ['text', 'error'] as const) {
  it(`full sample ${property} clear reentry retires old actions before the setter and preserves a legitimate new owner`, async t => {
    const h = await setup(t), line = connection(h);
    const oldAction = h.find(node => node.dataset.roomAction === 'hand');
    oldAction.click(); const oldPending = h.sdk.raises[0]!;
    const descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!, toggle = line.classList.toggle;
    let nested = false, callbackPoll = 0, newAction: SampleNode | undefined;
    const enter = () => {
      if (nested) return;
      nested = true;
      // Test observable host reentry; completions still use native promises, like actual SDK getStats.
      oldAction.disabled = false; oldAction.onclick!(); assert.equal(h.sdk.raises.length, 1, 'old action already lost generation ownership');
      h.sdk.snapshot(roomState({ participantId: 'nested-owner' }));
      newAction = h.find(node => node.dataset.roomAction === 'hand'); newAction.click();
      assert.equal(h.sdk.raises.length, 2); h.clock.advance(2000); callbackPoll = h.sdk.polls.length - 1;
      h.sdk.polls[callbackPoll]!.resolve(result(0.025, 0));
      oldPending.reject(new Error('retired action error'));
    };
    if (property === 'text') Object.defineProperty(line, 'textContent', {
      configurable: true, get() { return descriptor.get!.call(line); },
      set(value: string) { descriptor.set!.call(line, value); if (value === '') enter(); },
    });
    else line.classList.toggle = (name, force) => { const value = toggle(name, force); if (name === 'error' && !force) enter(); return value; };
    h.sdk.snapshot(roomState({ participantId: 'superseded-owner' })); assert.equal(nested, true);
    assert.equal(h.sdk.me!.participantId, 'nested-owner');
    assert.equal(h.find(node => node.dataset.roomAction === 'hand'), newAction, 'outer render cannot reinstall a superseded view');
    assert.equal(newAction!.disabled, true); assert.equal(newAction!.attributes['aria-busy'], 'true');
    await flushSample(); assert.match(line.textContent, /接收 RTT 25 ms/); assert.equal(line.classList.contains('error'), false);
    assert.equal(h.sdk.polls[callbackPoll]!.status, 'fulfilled');
    assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);
    newAction!.onclick!(); assert.equal(h.sdk.raises.length, 2, 'old completion cannot unlock the new pending action');
    h.sdk.raises[1]!.resolve(undefined); await flushSample(); assert.equal(newAction!.disabled, false);
    h.sdk.snapshot(roomState({ participantId: 'nested-owner' })); assert.match(line.textContent, /接收 RTT 25 ms/);
  });
}

it('full sample clear callback round-trip to the same IDs cannot reinstall an older generation', async t => {
  const h = await setup(t), line = connection(h), descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!;
  let nested = false, latest: SampleNode | undefined;
  Object.defineProperty(line, 'textContent', { configurable: true, get() { return descriptor.get!.call(line); }, set(value: string) {
    descriptor.set!.call(line, value);
    if (value !== '' || nested) return;
    nested = true; h.sdk.snapshot(roomState({ participantId: 'between' }));
    h.sdk.snapshot(roomState({ participantId: 'target' })); latest = h.find(node => node.dataset.roomAction === 'hand');
    latest.click();
  } });
  h.sdk.snapshot(roomState({ participantId: 'target' }));
  assert.equal(h.find(node => node.dataset.roomAction === 'hand'), latest); assert.equal(h.sdk.raises.length, 1);
  assert.equal(latest!.attributes['aria-busy'], 'true'); cleared(h);
  h.sdk.raises[0]!.resolve(undefined); await flushSample();
});
