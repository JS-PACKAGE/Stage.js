import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import { harness, testConfig } from './helpers.ts';

type App = ReturnType<typeof sampleApp>;
interface TimerCounts { timeouts: number; intervals: number }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');

/** Whole-module fake DOM assertions cover text, attributes and ownership, not native accessibility or paint. */
async function setup(t: TestContext) {
  const anchor = "const app = document.querySelector<HTMLDivElement>('#app')!;";
  assert.equal(source.split(anchor).length, 2);
  const h = sampleApp({ source: source.replace(anchor, `${anchor}
const handPositionTimerCounts = { timeouts: 0, intervals: 0 };
(app as any).__handPositionTimerCounts = handPositionTimerCounts;
const originalTimeout = setTimeout, originalInterval = setInterval;
setTimeout = ((callback: () => void, delay: number) => {
  handPositionTimerCounts.timeouts++; return originalTimeout(callback, delay);
}) as typeof setTimeout;
setInterval = ((callback: () => void, delay: number) => {
  handPositionTimerCounts.intervals++; return originalInterval(callback, delay);
}) as typeof setInterval;`) });
  const calls: { method: string; args: unknown[] }[] = [], withdrawals: Deferred<void>[] = [];
  Object.assign(h.sdk, { withdrawHand() {
    calls.push({ method: 'withdrawHand', args: [] }); const work = new Deferred<void>();
    withdrawals.push(work); return work.promise;
  } });
  for (const method of ['approve', 'reject', 'forceMute', 'forceUnmute', 'removeFromStage', 'transferControl',
    'kick', 'setGain', 'mute', 'unmute', 'returnToStage', 'leaveStage', 'rotateCode', 'closeRoom', 'unlockAudio']) {
    Object.assign(h.sdk, { async [method](...args: unknown[]) { calls.push({ method, args }); } });
  }
  t.after(async () => {
    for (const work of withdrawals) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
    await h.cleanup();
    assert.equal(withdrawals.some(work => work.status === 'pending'), false);
  });
  await flushSample();
  return { ...h, calls, withdrawals,
    timerCounts: (h.app as SampleNode & { __handPositionTimerCounts: TimerCounts }).__handPositionTimerCounts };
}
function state(ids: string[] = ['earlier', 'same-person', 'later'], overrides: Partial<ParticipantView> = {}): RoomStatePayload {
  const snapshot = roomState({ name: '自己', handRaised: true, ...overrides });
  snapshot.status = 'live';
  snapshot.hands = ids.map((participantId, index) => ({ ...snapshot.me, participantId,
    name: '同名的其他人', joinedAt: 100 - index, role: 'audience', onStage: false, handRaised: true }));
  return snapshot;
}
const position = (h: App) => h.find(node => node.classList.contains('own-hand-position'));
const hand = (h: App) => h.find(node => node.dataset.roomAction === 'hand');
const notices = (h: App) => h.find(node => node.classList.contains('notices'));
const errorBox = (h: App) => h.find(node => node.classList.contains('banner') && node.classList.contains('error'));
const statusBadge = (h: App) => h.find(node => node.parentNode?.tagName === 'header' && node.classList.contains('badge'));
function label(h: App, number: number, stale = false): SampleNode {
  const node = position(h);
  assert.equal(node.hidden, false);
  assert.equal(node.textContent, number > 0 ? `${stale ? '上次' : '你的'}舉手位置：佇列第 ${number} 位。`
    : stale ? '上次狀態：已舉手，等待主控邀請。' : '你已舉手，等待主控邀請。');
  assert.equal(node.tagName, 'p'); assert.equal(node.attributes.role, 'status');
  assert.equal(node.onclick, null); assert.equal(node.children.length, 0);
  return node;
}
function hidden(h: App): void { assert.equal(position(h).hidden, true); assert.equal(position(h).textContent, ''); }
function sameNodes(actual: SampleNode[], expected: SampleNode[]): void {
  assert.equal(actual.length, expected.length);
  for (const [index, node] of actual.entries()) assert.equal(node, expected[index], `retained node ${index}`);
}

it('whole sample places a separate status paragraph by personal controls without changing withdrawal text', async t => {
  const h = await setup(t);
  assert.equal(h.app.descendants().some(node => node.classList.contains('own-hand-position')), false);
  h.sdk.snapshot(state()); const line = label(h, 2), action = hand(h);
  assert.equal(action.textContent, '收回舉手'); assert.equal(action.disabled, false);
  assert.equal(action.attributes['aria-busy'], 'false');
  assert.equal(line.parentNode, action.parentNode?.parentNode);
  assert.ok(line.parentNode?.children.some(node => node.classList.contains('connection')));
  assert.doesNotMatch(line.textContent, /自己|同名的其他人|秒|分鐘|保證|即將|預計/);
  assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 0); assert.equal(h.sdk.previews.length, 0);
});

it('whole sample follows authoritative hand order through removal, reordering and same-count identity changes', async t => {
  const h = await setup(t); h.sdk.snapshot(state()); const line = label(h, 2);
  for (const [ids, number] of [
    [['same-person', 'earlier', 'later'], 1], [['later', 'earlier', 'same-person'], 3],
    [['later', 'same-person'], 2], [['same-person'], 1],
    [['different-person'], 0], [['same-person'], 1],
  ] as const) {
    h.sdk.snapshot(state([...ids])); assert.equal(label(h, number), line);
    assert.equal(hand(h).textContent, '收回舉手');
  }
  assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 0);
});

it('whole sample matches exact IDs rather than duplicate names or joinedAt and takes the first duplicate ID', async t => {
  const h = await setup(t);
  for (const [ids, number] of [
    [['SAME-PERSON', 'different-person'], 0], [['earlier', 'same-person', 'same-person'], 2],
    [['same-person', 'earlier', 'same-person'], 1], [['earlier', 'later'], 0], [[], 0],
  ] as const) {
    const snapshot = state([...ids]); snapshot.hands.forEach(person => { person.name = snapshot.me.name; });
    h.sdk.snapshot(snapshot); label(h, number);
  }
  h.sdk.setStatus('reconnecting'); label(h, 0, true);
  assert.equal(hand(h).textContent, '收回舉手'); assert.equal(hand(h).disabled, true);
  assert.equal(h.calls.length, 0);
});

it('whole sample hides position for unraised, onstage and controller seats despite contradictory queue entries', async t => {
  const h = await setup(t); h.sdk.snapshot(state()); const line = label(h, 2);
  for (const overrides of [
    { handRaised: false }, { onStage: true }, { role: 'speaker' as const, onStage: true },
    { role: 'controller' as const, onStage: false },
    { role: 'controller' as const, onStage: true },
  ]) {
    h.sdk.snapshot(state(['earlier', 'same-person'], overrides)); hidden(h); assert.equal(position(h), line);
    h.sdk.setStatus('reconnecting'); hidden(h); h.sdk.setStatus('live'); hidden(h);
  }
  h.sdk.snapshot(state(['same-person'])); assert.equal(label(h, 1), line);
  assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 0);
});

it('whole sample defensively preserves existing withdrawal behavior for an offstage speaker with a raised hand', async t => {
  const h = await setup(t); h.sdk.snapshot(state(['earlier', 'same-person'], { role: 'speaker', onStage: false }));
  label(h, 2); assert.equal(hand(h).textContent, '收回舉手'); assert.equal(hand(h).disabled, false);
  h.sdk.setStatus('reconnecting'); label(h, 2, true); assert.equal(hand(h).disabled, true);
  assert.equal(h.calls.length, 0);
});

it('whole sample status-only reconnect and recovery refresh the retained line through an identical cache hit', async t => {
  const h = await setup(t), snapshot = state(); h.sdk.snapshot(snapshot);
  const line = label(h, 2), action = hand(h), main = h.find(node => node.tagName === 'main');
  const nodes = main.descendants(), timers = { ...h.timerCounts }, jobs = [...h.clock.jobs.keys()];
  h.sdk.setStatus('reconnecting'); assert.equal(h.sdk.state, snapshot); assert.equal(label(h, 2, true), line);
  assert.equal(hand(h), action); assert.equal(action.disabled, true); assert.equal(statusBadge(h).textContent, '重新連線中');
  action.onclick!(); assert.equal(h.calls.length, 0);
  h.sdk.setStatus('live'); assert.equal(label(h, 2), line); assert.equal(action.disabled, false);
  assert.equal(statusBadge(h).textContent, '直播中');
  for (let index = 0; index < 25; index++) { h.sdk.snapshot(clone(snapshot)); sameNodes(main.descendants(), nodes); }
  assert.equal(hand(h), action); assert.equal(position(h), line);
  assert.deepEqual({ ...h.timerCounts }, timers); assert.deepEqual([...h.clock.jobs.keys()], jobs);
  assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 0);
});

it('whole sample clears retained feedback when state disappears before a status-only reconnect', async t => {
  const h = await setup(t); h.sdk.snapshot(state()); const line = label(h, 2);
  h.sdk.state = null; h.sdk.setStatus('reconnecting'); hidden(h); assert.equal(line.isConnected, true);
  h.sdk.setStatus('disconnected');
  assert.equal(line.isConnected, false); assert.equal(line.hidden, true); assert.equal(line.textContent, '');
  assert.equal(h.clock.jobs.size, 0); assert.equal(h.calls.length, 0);
});

it('whole sample preserves pending raise and withdrawal ownership when authoritative queue state precedes ACK', async t => {
  const h = await setup(t); h.sdk.snapshot(state([], { handRaised: false })); hidden(h);
  hand(h).click(); assert.equal(h.sdk.raises.length, 1); hidden(h);
  assert.equal(hand(h).textContent, '舉手發言（2 秒）'); assert.equal(hand(h).attributes['aria-busy'], 'true');
  h.sdk.snapshot(state()); label(h, 2);
  assert.equal(hand(h).textContent, '收回舉手'); assert.equal(hand(h).disabled, true);
  assert.equal(hand(h).attributes['aria-busy'], 'true'); assert.equal(h.clock.timeouts().length, 0);
  hand(h).onclick!(); hand(h).click(); assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 1);
  h.sdk.raises[0]!.resolve(undefined); await flushSample();
  assert.equal(hand(h).disabled, false); assert.equal(hand(h).attributes['aria-busy'], 'false');
  hand(h).click(); assert.equal(h.withdrawals.length, 1); label(h, 2);
  h.sdk.snapshot(state(['same-person', 'earlier'])); label(h, 1);
  assert.equal(hand(h).disabled, true); assert.equal(hand(h).attributes['aria-busy'], 'true');
  hand(h).onclick!(); assert.equal(h.withdrawals.length, 1);
  h.sdk.snapshot(state(['earlier'], { handRaised: false })); hidden(h);
  assert.equal(hand(h).textContent, '舉手發言（2 秒）'); assert.equal(hand(h).attributes['aria-busy'], 'true');
  h.clock.advance(1500); hidden(h); assert.equal(hand(h).textContent, '舉手發言'); assert.equal(hand(h).disabled, true);
  hand(h).onclick!(); assert.equal(h.sdk.raises.length, 1);
  h.withdrawals[0]!.resolve(undefined); await flushSample();
  assert.equal(hand(h).disabled, false); assert.equal(hand(h).attributes['aria-busy'], 'false');
  assert.deepEqual(h.calls, [{ method: 'withdrawHand', args: [] }]);
});

it('whole sample queue updates preserve notices, current errors and the connection status after rejected withdrawal', async t => {
  const h = await setup(t); h.sdk.snapshot(state());
  hand(h).click(); h.withdrawals[0]!.reject(new Error('目前不能收回。')); await flushSample();
  assert.equal(errorBox(h).textContent, '目前不能收回。'); assert.equal(hand(h).disabled, false);
  h.sdk.emit('audioblocked', undefined); h.sdk.emit('invite', { participantId: 'same-person' });
  h.sdk.emit('error', { message: '保留真正的錯誤。' });
  const message = notices(h).textContent, noticeNodes = notices(h).descendants();
  assert.match(message, /自動播放遭阻擋/); assert.match(message, /主控已邀請/);
  h.sdk.setStatus('reconnecting'); label(h, 2, true);
  sameNodes(notices(h).descendants(), noticeNodes); assert.equal(statusBadge(h).textContent, '重新連線中');
  h.sdk.setStatus('live'); h.sdk.snapshot(state(['same-person', 'earlier'])); label(h, 1);
  h.sdk.snapshot(clone(h.sdk.state!)); label(h, 1);
  assert.equal(errorBox(h).textContent, '保留真正的錯誤。'); assert.equal(errorBox(h).hidden, false);
  assert.equal(notices(h).textContent, message); assert.equal(statusBadge(h).textContent, '直播中');
  assert.equal(h.calls.length, 1); assert.equal(h.sdk.raises.length, 0);
});

it('whole sample computes from the snapshot independently of hidden rows and never exposes private audience membership', async t => {
  const h = await setup(t), snapshot = state();
  snapshot.audience = [{ ...snapshot.me, participantId: 'private-member', name: '未公開觀眾姓名', handRaised: false }];
  snapshot.audienceCount = 42; snapshot.code = 'PRIVATE42';
  h.sdk.snapshot(snapshot); const line = label(h, 2);
  for (const row of h.app.descendants().filter(node => node.classList.contains('person'))) row.hidden = true;
  h.sdk.setStatus('reconnecting'); assert.equal(label(h, 2, true), line);
  assert.doesNotMatch(h.app.textContent, /未公開觀眾姓名|PRIVATE42/);
  assert.doesNotMatch(line.textContent, /同名的其他人|private-member|earlier|same-person|later|42/);
  const controller = state(['earlier', 'same-person'], { role: 'controller', onStage: true });
  controller.audience = snapshot.audience; h.sdk.snapshot(controller); hidden(h);
  const input = h.id('audience-search'); input.value = '沒有此人'; assert.ok(input.oninput); input.oninput();
  const privateRow = h.find(node => node.dataset.participantId === 'private-member'); assert.equal(privateRow.hidden, true);
  hidden(h); h.sdk.snapshot(snapshot); label(h, 2); assert.equal(input.value, '');
  assert.equal(privateRow.isConnected, false); assert.doesNotMatch(h.app.textContent, /未公開觀眾姓名|PRIVATE42/);
  assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 0);
});

it('whole sample idle queue feedback creates no timer or action while existing connection polling continues', async t => {
  const h = await setup(t), snapshot = state(); h.sdk.snapshot(snapshot);
  assert.deepEqual({ ...h.timerCounts }, { timeouts: 0, intervals: 1 });
  const ids = [...h.clock.jobs.keys()], line = label(h, 2);
  for (let index = 0; index < 5; index++) {
    h.sdk.setStatus('reconnecting'); label(h, 2, true); h.sdk.setStatus('live');
    h.sdk.snapshot(clone(snapshot)); assert.equal(label(h, 2), line);
    h.clock.advance(2000); h.sdk.polls.at(-1)!.resolve({ inbound: null, outbound: null }); await flushSample();
  }
  assert.deepEqual({ ...h.timerCounts }, { timeouts: 0, intervals: 1 });
  assert.deepEqual([...h.clock.jobs.keys()], ids); assert.equal(h.clock.fired.length, 5);
  assert.equal(h.sdk.polls.length, 5); assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 0);
  assert.equal(h.sdk.previews.length, 0); assert.equal(h.sdk.inputDevices.length, 0); assert.equal(h.sdk.outputDevices.length, 0);
});

for (const terminal of ['leave', 'disconnect', 'closed', 'shutdown', 'kicked'] as const) {
  it(`whole sample ${terminal} clears and detaches personal queue feedback before same-identity reentry`, async t => {
    const h = await setup(t); h.sdk.snapshot(state()); const line = label(h, 2), oldAction = hand(h);
    if (terminal === 'leave') h.button('離開房間').click();
    else if (terminal === 'disconnect') await h.sdk.disconnect();
    else await h.sdk.terminal(terminal === 'kicked' ? 'kicked' : 'closed', terminal === 'shutdown' ? 'shutdown' : undefined);
    await flushSample();
    assert.equal(line.isConnected, false); assert.equal(line.hidden, true); assert.equal(line.textContent, '');
    assert.equal(h.app.descendants().some(node => node.classList.contains('own-hand-position')), false);
    assert.equal(h.clock.jobs.size, 0);
    const landing = [...h.app.children], message = notices(h).textContent;
    oldAction.onclick!(); h.clock.advance(10000); sameNodes(h.app.children, landing);
    assert.equal(notices(h).textContent, message); assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 0);
    h.sdk.snapshot(state(['same-person'])); assert.equal(label(h, 1), line); assert.notEqual(hand(h), oldAction);
    const current = hand(h); h.sdk.snapshot(clone(h.sdk.state!)); assert.equal(hand(h), current);
    oldAction.onclick!(); assert.equal(h.calls.length, 0);
  });
}

it('whole sample renders Hub-produced queue order across withdrawal, reentry, rejection and stage approval', async t => {
  const room = harness(testConfig(config => { config.rooms.qualityIntervalMs = 0; }));
  t.after(async () => {
    await room.hub.shutdown(); assert.equal(room.hub.roomCount, 0); assert.equal(room.transport.rooms.size, 0);
    assert.equal(room.timers.filter(timer => !timer.cleared).length, 0);
  });
  const host = await room.create(), me = await room.join(host.roomId, host.code, '自己');
  room.clock.now++; const earlier = await room.join(host.roomId, host.code, '較早舉手者');
  room.clock.now++; const later = await room.join(host.roomId, host.code, '較晚舉手者');
  const h = await setup(t);
  const deliver = (ids: string[], number: number | null) => {
    for (const timer of room.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); }
    const snapshot = me.s.last('room:state')!;
    assert.deepEqual(snapshot.hands.map(person => person.participantId), ids);
    assert.equal(snapshot.audience, undefined); assert.equal(snapshot.code, undefined);
    h.sdk.snapshot(snapshot); if (number === null) hidden(h); else label(h, number);
    assert.equal(h.calls.length, 0); assert.equal(h.sdk.raises.length, 0);
  };
  for (const person of [earlier, me, later]) assert.equal(await room.req(person.s, { type: 'hand:raise' }), 'ok');
  deliver([earlier.id, me.id, later.id], 2);
  assert.equal(await room.req(earlier.s, { type: 'hand:withdraw' }), 'ok'); deliver([me.id, later.id], 1);
  assert.equal(await room.req(me.s, { type: 'hand:withdraw' }), 'ok'); deliver([later.id], null);
  assert.equal(await room.req(me.s, { type: 'hand:raise' }), 'ok'); deliver([later.id, me.id], 2);
  assert.equal(await room.req(host.s, { type: 'stage:reject', targetId: later.id }), 'ok'); deliver([me.id], 1);
  assert.equal(await room.req(host.s, { type: 'stage:approve', targetId: me.id }), 'ok'); deliver([], null);
  assert.equal(h.sdk.me?.onStage, true); assert.equal(h.sdk.previews.length, 0);
});
