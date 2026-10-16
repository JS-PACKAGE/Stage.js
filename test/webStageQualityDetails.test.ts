import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { decodeName } from '../packages/client/src/index.ts';
import { sanitizeName } from '../src/ws/validate.ts';
import type { ConnectionQuality, ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { actualApp, actualState, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import { harness, SENDRECV_OFFER, testConfig } from './helpers.ts';

type App = ReturnType<typeof sampleApp>;
type View = Pick<App, 'app' | 'find' | 'id'>;
const WAITING = '尚未收到目前發言者的品質回報。';
const RECONNECTING = `重新連線中；${WAITING}`;
const RECEIVED = '最近收到的伺服器回報；RTT 不是端到端音訊延遲。';
const clone = <T>(value: T): T => structuredClone(value);
function stageState(me: Partial<ParticipantView> = {}): RoomStatePayload {
  const own = roomState({ participantId: 'controller', name: '主持人', role: 'controller', onStage: false, ...me });
  const speakers: ParticipantView[] = ['甲', '乙'].map((name, index) => ({
    ...own.me, participantId: `speaker-${index}`, name, role: 'speaker', onStage: true,
  }));
  if (own.me.onStage) speakers.unshift(own.me);
  const audience = [{ ...own.me, participantId: 'audience', name: '觀眾姓名', role: 'audience' as const, onStage: false, handRaised: true }];
  return { ...own, speakers, audience, hands: audience, audienceCount: audience.length, status: 'live' };
}
async function setup(t: TestContext, state: RoomStatePayload | null = stageState()) {
  const h = sampleApp({ decodeName }); t.after(() => h.cleanup()); await flushSample();
  if (state) h.sdk.snapshot(state);
  return h;
}
const details = (h: View) => h.id('stage-quality');
const summary = (h: View) => details(h).children.find(node => node.tagName === 'summary')!;
const status = (h: View) => h.find(node => node.classList.contains('stage-quality-status'));
const list = (h: View) => h.find(node => node.classList.contains('stage-quality-list'));
const rows = (h: View) => list(h).children;
const ids = (h: View) => rows(h).map(row => row.dataset.participantId);
const emit = (h: App, participants: ConnectionQuality[]) => h.sdk.emit('quality', { participants });
const report = (participantId = 'speaker-0'): ConnectionQuality => ({ participantId, uplinkLossPercent: 0.1, downlinkLossPercent: 0.2, rttMs: 28 });
function assertEmpty(h: View, reconnecting = false): void {
  assert.deepEqual(ids(h), []); assert.equal(status(h).textContent, reconnecting ? RECONNECTING : WAITING);
}
function assertReset(h: View): void {
  assert.equal(details(h).hidden, true); assert.equal(details(h).attributes.open, undefined);
  assert.deepEqual(ids(h), []); assert.equal(status(h).textContent, '');
}
function sameNodes(actual: SampleNode[], expected: SampleNode[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((node, index) => assert.equal(node, expected[index], `retained node ${index}`));
}

it('whole sample uses native details/summary semantics, starts closed, and exposes the panel only to eligible viewers', async t => {
  const h = await setup(t, null), panel = details(h), label = summary(h), items = list(h);
  assert.equal(panel.tagName, 'details'); assert.equal(panel.children[0], label);
  assert.equal(label.textContent, '舞台連線品質'); assert.equal(items.tagName, 'ul');
  assert.equal(label.onclick, null); assert.equal(panel.onclick, null);
  assert.equal(label.attributes.role, undefined); assert.equal(label.attributes.tabindex, undefined);
  assertReset(h);
  emit(h, [report()]); h.sdk.snapshot(stageState({ role: 'audience', onStage: false })); assertReset(h);
  emit(h, [report()]); h.sdk.snapshot(stageState()); assert.equal(panel.hidden, false); assertEmpty(h);
  assert.equal(details(h), panel); assert.equal(summary(h), label); assert.equal(list(h), items);
  h.sdk.snapshot(stageState({ role: 'speaker', onStage: true })); assert.equal(panel.hidden, false);
  h.sdk.snapshot(stageState({ role: 'speaker', onStage: false })); assertReset(h);
  // These assertions cover DOM structure/attributes, not browser keyboard or focus behavior.
});

it('whole sample displays healthy and poor reports, zeroes, bounds and missing metrics without a live or timestamp claim', async t => {
  const h = await setup(t), panel = details(h); panel.setAttribute('open', '');
  const cases: { metrics: Omit<ConnectionQuality, 'participantId'>; expected: string }[] = [
    { metrics: { uplinkLossPercent: 0.1, downlinkLossPercent: 0.2, rttMs: 28 }, expected: '甲：上行掉包 0.1% · 下行掉包 0.2% · RTT 28 ms' },
    { metrics: { uplinkLossPercent: 8.24, downlinkLossPercent: 5, rttMs: 28.6 }, expected: '甲：上行掉包 8.2% · 下行掉包 5.0% · RTT 29 ms' },
    { metrics: { uplinkLossPercent: 0, downlinkLossPercent: 100, rttMs: 0 }, expected: '甲：上行掉包 0.0% · 下行掉包 100.0% · RTT 0 ms' },
    { metrics: {}, expected: '甲：上行掉包 — · 下行掉包 — · RTT —' },
    { metrics: { downlinkLossPercent: 4.99 }, expected: '甲：上行掉包 — · 下行掉包 5.0% · RTT —' },
  ];
  let first: SampleNode | undefined;
  for (const step of cases) {
    emit(h, [{ participantId: 'speaker-0', ...step.metrics }]);
    assert.deepEqual(ids(h), ['speaker-0']); assert.equal(rows(h)[0]!.textContent, step.expected);
    first ??= rows(h)[0]; assert.equal(rows(h)[0], first); assert.equal(panel.attributes.open, '');
    assert.equal(status(h).textContent, RECEIVED); assert.doesNotMatch(panel.textContent, /即時|更新於|時間戳|健康|品質良好/);
  }
});

it('whole sample renders invalid individual metric values as unavailable rather than misleading numbers', async t => {
  const h = await setup(t);
  const invalid = [NaN, Infinity, -Infinity, -1, '5', null, {}, []];
  for (const value of invalid) {
    emit(h, [{ participantId: 'speaker-0', uplinkLossPercent: value, downlinkLossPercent: value, rttMs: value }] as ConnectionQuality[]);
    assert.equal(rows(h)[0]!.textContent, '甲：上行掉包 — · 下行掉包 — · RTT —');
  }
  emit(h, [{ participantId: 'speaker-0', uplinkLossPercent: 100.01, downlinkLossPercent: 101, rttMs: 1234.6 }]);
  assert.equal(rows(h)[0]!.textContent, '甲：上行掉包 — · 下行掉包 — · RTT 1235 ms');
});

it('whole sample uses sanitized current names as text and never names unknown or offstage report IDs', async t => {
  const state = stageState();
  const rawName = '<img src=x> & "\'喵'; const escaped = sanitizeName(rawName, 32); assert.ok(escaped);
  state.speakers[0]!.name = escaped;
  const h = await setup(t, state);
  emit(h, [report('unknown'), report('audience'), report('controller'), report()]);
  assert.deepEqual(ids(h), ['speaker-0']);
  assert.equal(rows(h)[0]!.textContent, `${rawName}：上行掉包 0.1% · 下行掉包 0.2% · RTT 28 ms`);
  assert.equal(rows(h)[0]!.children.length, 0); assert.equal(rows(h)[0]!.title, '');
  assert.equal(details(h).descendants().some(node => node.tagName === 'img' || node.tagName === 'script'), false);
  assert.doesNotMatch(details(h).textContent, /觀眾姓名|unknown|controller|&lt;|&amp;/);
  const later = clone(state); later.speakers.push({ ...state.audience![0]!, onStage: true, role: 'speaker' });
  h.sdk.snapshot(later); assert.deepEqual(ids(h), ['speaker-0'], 'previous offstage report was discarded');
  emit(h, [report('audience')]); assert.deepEqual(ids(h), ['audience']);
});

it('whole sample replaces rather than merges reports and removes omitted or empty rows including duplicate report IDs', async t => {
  const h = await setup(t); emit(h, [report(), report('speaker-1')]); const retired = rows(h)[1]!;
  emit(h, [{ participantId: 'speaker-0', uplinkLossPercent: 90 }, { participantId: 'speaker-0', rttMs: 10 }]);
  assert.deepEqual(ids(h), ['speaker-0']); assert.equal(rows(h)[0]!.textContent, '甲：上行掉包 — · 下行掉包 — · RTT 10 ms');
  assert.equal(retired.isConnected, false);
  emit(h, []); assertEmpty(h); emit(h, [report('unknown')]); assertEmpty(h);
  emit(h, [{ participantId: 'speaker-1' }]);
  assert.deepEqual(ids(h), ['speaker-1']); assert.equal(rows(h)[0]!.textContent, '乙：上行掉包 — · 下行掉包 — · RTT —');
});

it('whole sample follows current speaker order and names, prunes departed reports and retains expansion across room redraws and cache hits', async t => {
  const state = stageState(), h = await setup(t, state), panel = details(h), label = summary(h), items = list(h);
  panel.setAttribute('open', ''); emit(h, [report('speaker-1'), report()]);
  assert.deepEqual(ids(h), ['speaker-0', 'speaker-1']); const originals = [...rows(h)];
  for (let index = 0; index < 5; index++) { h.sdk.snapshot(clone(state)); sameNodes(rows(h), originals); }
  const reordered = clone(state); reordered.name = '新舞台名'; reordered.speakers.reverse(); reordered.speakers[0]!.name = '新名字';
  h.sdk.snapshot(reordered); sameNodes(rows(h), [...originals].reverse()); assert.match(rows(h)[0]!.textContent, /^新名字：/);
  const departed = clone(reordered); departed.speakers.pop(); h.sdk.snapshot(departed);
  assert.deepEqual(ids(h), ['speaker-1']); assert.equal(originals[0]!.isConnected, false);
  h.sdk.snapshot(reordered); assert.deepEqual(ids(h), ['speaker-1'], 'returning speaker needs a new report');
  for (const snapshot of [reordered, { ...reordered, audienceCount: 12 }, { ...reordered, status: 'waiting' as const }]) h.sdk.snapshot(clone(snapshot));
  assert.equal(details(h), panel); assert.equal(summary(h), label); assert.equal(list(h), items); assert.equal(panel.attributes.open, '');
  panel.removeAttribute('open'); emit(h, [report()]); h.sdk.snapshot(reordered); assert.equal(panel.attributes.open, undefined);
});

it('whole sample owns copied report values despite caller mutation and accepts changed objects only on the next quality event', async t => {
  const state = stageState(), h = await setup(t, state), value = report(), reportEvent = { participants: [value] };
  h.sdk.emit('quality', reportEvent); const row = rows(h)[0]!, original = row.textContent;
  value.uplinkLossPercent = 70; value.rttMs = 900; delete value.downlinkLossPercent;
  reportEvent.participants.push(report('speaker-1'));
  h.sdk.snapshot(clone(state)); assert.deepEqual(ids(h), ['speaker-0']); assert.equal(row.textContent, original);
  h.sdk.setStatus('waiting'); assert.equal(row.textContent, original);
  h.sdk.emit('quality', reportEvent); assert.deepEqual(ids(h), ['speaker-0', 'speaker-1']);
  assert.equal(rows(h)[0], row); assert.equal(row.textContent, '甲：上行掉包 70.0% · 下行掉包 — · RTT 900 ms');
  h.sdk.on('quality', ({ detail }) => { detail.participants[0]!.rttMs = 999; });
  emit(h, [report()]); h.sdk.snapshot(clone(state)); assert.match(rows(h)[0]!.textContent, /RTT 28 ms$/);
});

for (const transition of ['room', 'participant'] as const) {
  it(`whole sample resets expansion and report ownership on ${transition} replacement, including return to the old identity`, async t => {
    const state = stageState(), h = await setup(t, state), panel = details(h); panel.setAttribute('open', ''); emit(h, [report()]);
    const replacement = clone(state);
    if (transition === 'room') replacement.roomId = 'another-room'; else replacement.me.participantId = replacement.controllerId = 'another-controller';
    h.sdk.snapshot(replacement); assert.equal(panel.hidden, false); assert.equal(panel.attributes.open, undefined); assertEmpty(h);
    emit(h, [report('speaker-1')]); panel.setAttribute('open', ''); h.sdk.snapshot(state);
    assert.equal(panel.attributes.open, undefined); assertEmpty(h);
  });
}

for (const eligible of ['controller', 'speaker'] as const) {
  it(`whole sample clears ${eligible} reports and expansion on eligibility loss and ignores reports until eligibility returns`, async t => {
    const state = stageState({ role: eligible, onStage: eligible === 'speaker' }), h = await setup(t, state);
    const panel = details(h); panel.setAttribute('open', ''); emit(h, [report()]);
    const lost = clone(state); lost.me.role = 'audience'; lost.me.onStage = false; lost.controllerId = 'another-controller';
    lost.speakers = lost.speakers.filter(person => person.participantId !== lost.me.participantId);
    h.sdk.snapshot(lost); assertReset(h); emit(h, [report('speaker-1')]); assertReset(h);
    h.sdk.snapshot(state); assert.equal(panel.hidden, false); assertEmpty(h); assert.equal(panel.attributes.open, undefined);
    emit(h, [report()]); assert.deepEqual(ids(h), ['speaker-0']);
  });
}

it('whole sample preserves eligible ownership through controller-to-onstage-speaker transfer and clearing when that speaker leaves', async t => {
  const state = stageState({ onStage: true }), h = await setup(t, state), panel = details(h);
  panel.setAttribute('open', ''); emit(h, [report()]); const row = rows(h)[0]!;
  const transferred = clone(state); transferred.controllerId = 'another-controller'; transferred.me.role = 'speaker';
  transferred.speakers[0]!.role = 'speaker'; h.sdk.snapshot(transferred);
  assert.equal(panel.hidden, false); assert.equal(panel.attributes.open, ''); assert.equal(rows(h)[0], row);
  transferred.me.onStage = false; transferred.me.role = 'audience'; transferred.speakers.shift();
  h.sdk.snapshot(transferred); assertReset(h);
});

for (const terminal of ['leave', 'disconnected', 'closed', 'shutdown', 'kicked'] as const) {
  it(`whole sample ${terminal} clears panel data and ignores landing events before same-identity rejoin`, async t => {
    const state = stageState(), h = await setup(t, state), panel = details(h); panel.setAttribute('open', ''); emit(h, [report()]);
    if (terminal === 'leave') { h.button('離開房間').click(); await flushSample(); }
    else if (terminal === 'disconnected') await h.sdk.disconnect();
    else await h.sdk.terminal(terminal === 'kicked' ? 'kicked' : 'closed', terminal === 'shutdown' ? 'shutdown' : undefined);
    assertReset(h); emit(h, [report('speaker-1')]); assertReset(h);
    h.sdk.snapshot(state); assert.equal(details(h), panel); assert.equal(panel.hidden, false); assertEmpty(h);
    assert.equal(panel.attributes.open, undefined); emit(h, [report()]); assert.deepEqual(ids(h), ['speaker-0']);
  });
}

it('whole sample retires panel reports on reconnect, ignores reconnect events and waits for a new eligible report after resume', async t => {
  const state = stageState(), h = await setup(t, state), panel = details(h), label = summary(h);
  panel.setAttribute('open', ''); emit(h, [{ participantId: 'speaker-0', uplinkLossPercent: 8, rttMs: 50 }]);
  const retired = rows(h)[0]!; h.sdk.setStatus('reconnecting');
  assertEmpty(h, true); assert.equal(retired.isConnected, false); assert.equal(panel.attributes.open, '');
  emit(h, [report('speaker-1')]); assertEmpty(h, true);
  h.sdk.emit('state', clone(state)); assertEmpty(h, true);
  h.sdk.snapshot(clone(state)); assertEmpty(h); assert.equal(panel.attributes.open, ''); assert.equal(summary(h), label);
  emit(h, [report()]); assert.deepEqual(ids(h), ['speaker-0']); assert.equal(status(h).textContent, RECEIVED);
  h.sdk.setStatus('reconnecting'); h.sdk.setStatus('live'); assertEmpty(h);
});

it('whole sample quality panel adds no timers, stats polls, media capture or requests while reports and snapshots update', async t => {
  const state = stageState(), h = await setup(t, state), panel = details(h);
  const jobs = [...h.clock.jobs.values()].map(job => ({ id: job.id, kind: job.kind, delay: job.delay, due: job.due }));
  assert.deepEqual(jobs.map(job => [job.kind, job.delay]), [['interval', 2000]], 'existing own-connection poll only');
  const main = h.find(node => node.tagName === 'main'), people = main.descendants();
  for (let index = 0; index < 100; index++) {
    panel.setAttribute('open', ''); emit(h, [{ ...report(), rttMs: index }]); h.sdk.snapshot(clone(state));
    panel.removeAttribute('open');
  }
  assert.deepEqual([...h.clock.jobs.values()].map(job => ({ id: job.id, kind: job.kind, delay: job.delay, due: job.due })), jobs);
  assert.equal(h.sdk.polls.length, 0); assert.equal(h.sdk.previews.length, 0); assert.equal(h.sdk.joins.length, 0);
  assert.equal(h.sdk.raises.length, 0); assert.equal(h.sdk.micLevelReads, 0); sameNodes(main.descendants(), people);
  h.clock.advance(6000); assert.equal(h.sdk.polls.length, 3, 'only the existing 2-second own-connection poll runs');
  for (const poll of h.sdk.polls) poll.resolve({ inbound: null, outbound: null }); await flushSample();
});

it('real Hub delivers publisher reports to offstage controllers and onstage speakers, while ordinary audiences get no panel data', async t => {
  const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; }), hub = harness(config);
  const host = await hub.create('主持人'), speaker = await hub.join(host.roomId, host.code, '台上甲'), audience = await hub.join(host.roomId, host.code, '觀眾姓名');
  t.after(async () => { if (hub.hub.isJoined(audience.s)) await hub.req(audience.s, { type: 'room:close' }); if (hub.hub.isJoined(host.s)) await hub.req(host.s, { type: 'room:close' }); });
  assert.equal(await hub.req(speaker.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await hub.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
  assert.equal(await hub.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  assert.equal(await hub.req(host.s, { type: 'stage:leave' }), 'ok');
  const h = await setup(t, host.s.last('room:state')!); assert.equal(h.sdk.me?.onStage, false); assert.equal(details(h).hidden, false);
  hub.transport.getStats = async () => ({ inbound: { packetsReceived: 9990, packetsLost: 10 }, outbound: { fractionLost: 0.002 }, rttMs: 28 });
  const fire = async () => {
    const timers = hub.timers.filter(timer => !timer.cleared && timer.ms === config.rooms.qualityIntervalMs);
    assert.equal(timers.length, 1); timers[0]!.cleared = true; timers[0]!.fn(); await nextTurn();
  };
  host.s.clear(); speaker.s.clear(); audience.s.clear(); await fire();
  assert.equal(host.s.all('quality').length, 1); assert.equal(speaker.s.all('quality').length, 1); assert.equal(audience.s.all('quality').length, 0);
  const message = host.s.last('quality')!; assert.deepEqual(message.participants.map(person => person.participantId), [speaker.id]);
  emit(h, message.participants); assert.deepEqual(ids(h), [speaker.id]);
  assert.equal(rows(h)[0]!.textContent, '台上甲：上行掉包 0.1% · 下行掉包 0.2% · RTT 28 ms');
  assert.equal(await hub.req(host.s, { type: 'control:transfer', targetId: audience.id }), 'ok');
  const newControllerState = audience.s.last('room:state')!;
  assert.equal(newControllerState.me.participantId, audience.id); assert.equal(newControllerState.me.role, 'controller');
  h.sdk.snapshot(host.s.last('room:state')!); assertReset(h);
  host.s.clear(); speaker.s.clear(); audience.s.clear(); await fire();
  assert.equal(host.s.all('quality').length, 0); assert.equal(speaker.s.all('quality').length, 1); assert.equal(audience.s.all('quality').length, 1);
  h.sdk.snapshot(newControllerState);
  assertEmpty(h); emit(h, audience.s.last('quality')!.participants);
  assert.deepEqual(ids(h), [speaker.id]); assert.equal(status(h).textContent, RECEIVED);
  const latest = rows(h)[0]!.textContent;
  hub.transport.getStats = async () => { throw new Error('controlled stats failure'); };
  speaker.s.clear(); audience.s.clear(); await fire();
  assert.equal(speaker.s.all('quality').length, 0); assert.equal(audience.s.all('quality').length, 0);
  h.sdk.snapshot(clone(newControllerState));
  assert.equal(rows(h)[0]!.textContent, latest); assert.equal(status(h).textContent, RECEIVED);
  assert.doesNotMatch(details(h).textContent, /即時|品質良好|已停用|無人發言/);
  assert.equal(await hub.req(audience.s, { type: 'room:close' }), 'ok');
});

it('whole sample and real SDK receive quality without signaling requests, new peers or microphone capture', async t => {
  let cleanup = async (): Promise<void> => {}; t.after(() => cleanup());
  const boundary = await actualApp(t, { deferCapture: true });
  boundary.form.submit(); await flushSample(); const sdk = boundary.clients[0]!;
  const h = sampleApp({ sdk, decodeName }); cleanup = () => h.cleanup();
  const socket = StageSocket.instances[0]!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await boundary.until(() => socket.sent.some(message => message.type === 'join'), 'public SDK join request');
  const request = socket.sent.find(message => message.type === 'join')!;
  const state = actualState(); state.speakers = [{ ...state.me, participantId: 'speaker-0', name: '台上甲', role: 'speaker', onStage: true }];
  socket.deliver({ type: 'room:state', ...state }); socket.deliver({ type: 'ok', requestId: request.requestId });
  const peer = StagePeer.instances[0]!;
  await boundary.until(() => peer.localDescription !== null && peer.signalingState === 'stable', 'initial listening negotiation');
  const requests = [...socket.sent], offers = [...peer.offers], peers = [...StagePeer.instances];
  details(h).setAttribute('open', ''); socket.deliver({ type: 'quality', participants: [report()] }); await flushSample();
  assert.deepEqual(ids(h), ['speaker-0']); assert.equal(rows(h)[0]!.textContent, '台上甲：上行掉包 0.1% · 下行掉包 0.2% · RTT 28 ms');
  assert.deepEqual(socket.sent, requests); assert.deepEqual(peer.offers, offers); assert.deepEqual(StagePeer.instances, peers);
  assert.equal(boundary.captures.length, 0); assert.equal(peer.transceiver.direction, 'recvonly');
  socket.deliver({ type: 'quality', participants: [] }); assertEmpty(h);
  socket.deliver({ type: 'room:closed', roomId: state.roomId }); await flushSample(); assertReset(h);
});
