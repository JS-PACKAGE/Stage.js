import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ClientMessage, ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { embedApp, flush, type EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket } from './fixtures/embedSdkApp.ts';
import { harness, testConfig } from './helpers.ts';

type App = Awaited<ReturnType<typeof actualApp>>;
const raised = { role: 'audience' as const, handRaised: true, name: '自己' };
function state(ids: string[], overrides: Partial<ParticipantView> = {}): RoomStatePayload {
  const snapshot = actualState({ ...raised, ...overrides });
  snapshot.hands = ids.map((participantId, index) => ({ ...snapshot.me, participantId,
    name: '其他人的秘密名字', joinedAt: ids.length - index }));
  return snapshot;
}
function label(hand: EmbedNode, position: number, options: { stale?: boolean; busy?: boolean; disabled?: boolean } = {}): void {
  assert.equal(hand.textContent, position > 0
    ? `收回舉手（${options.stale ? '上次' : ''}佇列第 ${position} 位）` : '收回舉手');
  assert.equal(hand.disabled, Boolean(options.disabled ?? options.busy ?? options.stale));
  assert.equal(hand.attributes['aria-busy'], String(Boolean(options.busy)));
  assert.deepEqual(Object.keys(hand.attributes), ['aria-busy'], 'the native action keeps its accessible text without another control or toggle');
}
const controls = (socket: StageSocket) => socket.sent.filter(message => !['join', 'rtc:offer', 'rtc:ice', 'ping'].includes(message.type));
async function command(h: App, socket: StageSocket, type: 'hand:raise' | 'hand:withdraw') {
  const before = controls(socket).length; h.node('hand').click();
  await h.until(() => controls(socket).length === before + 1, type);
  const request = controls(socket).at(-1)!; assert.equal(request.type, type); return request;
}
async function joinRequest(h: App, socket: StageSocket) {
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'resume request');
  const request = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join');
  assert.ok(request); return request;
}

it('whole embed actual SDK uses Hub queue order through removal, withdrawal and reentry', async t => {
  const hub = harness(testConfig(config => { config.rooms.qualityIntervalMs = 0; }));
  t.after(async () => {
    await hub.hub.shutdown(); assert.equal(hub.hub.roomCount, 0); assert.equal(hub.transport.rooms.size, 0);
    assert.equal(hub.timers.filter(timer => !timer.cleared).length, 0);
  });
  const host = await hub.create(), me = await hub.join(host.roomId, host.code, '自己');
  hub.clock.now++; const first = await hub.join(host.roomId, host.code, '先舉手的人');
  hub.clock.now++; const last = await hub.join(host.roomId, host.code, '後舉手的人');
  for (const person of [first, me, last]) assert.equal(await hub.req(person.s, { type: 'hand:raise' }), 'ok');
  const broadcast = () => {
    // Other participants receive the Hub's coalesced snapshot on its next turn.
    for (const timer of hub.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); }
  };
  broadcast();
  const h = await actualApp(t), { socket } = await h.join(me.s.last('room:state')!.me), hand = h.node('hand');
  const deliver = (ids: string[], position: number) => {
    broadcast();
    const snapshot = me.s.last('room:state')!;
    assert.deepEqual(snapshot.hands.map(person => person.participantId), ids);
    assert.equal(snapshot.code, undefined, 'audience snapshots do not expose the private room code');
    socket.deliver(snapshot); label(hand, position);
    assert.doesNotMatch(hand.textContent + h.status.textContent, /先舉手的人|後舉手的人/);
    assert.equal(controls(socket).length, 0, 'painting queue positions sends no control requests');
  };
  deliver([first.id, me.id, last.id], 2);
  assert.equal(await hub.req(first.s, { type: 'hand:withdraw' }), 'ok'); deliver([me.id, last.id], 1);
  assert.equal(await hub.req(me.s, { type: 'hand:withdraw' }), 'ok');
  socket.deliver(me.s.last('room:state')!); assert.equal(hand.textContent, '舉手發言');
  assert.equal(await hub.req(me.s, { type: 'hand:raise' }), 'ok'); deliver([last.id, me.id], 2);
  assert.equal(await hub.req(host.s, { type: 'stage:reject', targetId: last.id }), 'ok'); deliver([me.id], 1);
  assert.equal(h.captures.length, 0);
});

it('whole embed actual SDK preserves pending raise and withdrawal ownership across queue state before ACK', async t => {
  const h = await actualApp(t), { socket } = await h.join({ ...raised, handRaised: false }), hand = h.node('hand');
  const raising = await command(h, socket, 'hand:raise');
  assert.equal(hand.textContent, '舉手發言（10 秒）');
  socket.deliver({ type: 'room:state', ...state(['earlier', 'guest']) }); label(hand, 2, { busy: true });
  hand.invoke(); hand.click(); await flush(); assert.equal(controls(socket).length, 1);
  socket.deliver({ type: 'ok', requestId: raising.requestId }); await flush(); label(hand, 2);
  const withdrawing = await command(h, socket, 'hand:withdraw'); label(hand, 2, { busy: true });
  socket.deliver({ type: 'room:state', ...state(['earlier'], { handRaised: false }) });
  assert.equal(hand.textContent, '舉手發言（10 秒）'); assert.equal(hand.disabled, true);
  assert.equal(hand.attributes['aria-busy'], 'true'); hand.invoke(); await flush(); assert.equal(controls(socket).length, 2);
  socket.deliver({ type: 'ok', requestId: withdrawing.requestId }); await flush();
  assert.equal(hand.attributes['aria-busy'], 'false'); assert.equal(hand.disabled, true);
  await h.tick(10000); assert.equal(hand.textContent, '舉手發言'); assert.equal(hand.disabled, false);
  assert.deepEqual(controls(socket).map(message => message.type), ['hand:raise', 'hand:withdraw']);
});

it('whole embed queue repaint after rejected withdrawal and ACK preserves genuine error feedback', async t => {
  const h = await actualApp(t), { socket } = await h.join(raised), hand = h.node('hand');
  socket.deliver({ type: 'room:state', ...state(['earlier', 'guest']) });
  const rejected = await command(h, socket, 'hand:withdraw');
  socket.deliver({ type: 'error', requestId: rejected.requestId, code: 'forbidden', message: '目前不能收回。' });
  await flush(); label(hand, 2); assert.equal(h.status.textContent, '目前不能收回。');
  const accepted = await command(h, socket, 'hand:withdraw');
  socket.deliver({ type: 'error', code: 'internal', message: '目前音訊發生錯誤。' });
  socket.deliver({ type: 'ok', requestId: accepted.requestId }); await flush(); await h.tick(1000);
  label(hand, 2); assert.equal(h.status.textContent, '目前音訊發生錯誤。');
  assert.equal(controls(socket).length, 2);
});

it('whole embed actual SDK marks retained queue position stale until a resumed snapshot supplies new order', async t => {
  const h = await actualApp(t), { socket } = await h.join(raised), hand = h.node('hand');
  socket.deliver({ type: 'room:state', ...state(['earlier', 'guest']) }); label(hand, 2);
  socket.close(); label(hand, 2, { stale: true }); assert.equal(h.status.textContent, '重新連線中');
  hand.invoke(); hand.click(); assert.equal(controls(socket).length, 0);
  socket.deliver({ type: 'room:state', ...state(['guest']) }); label(hand, 2, { stale: true });
  await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  const request = await joinRequest(h, resumed); label(hand, 2, { stale: true });
  assert.equal(request.resumeToken, 'test-resume');
  resumed.deliver({ type: 'ok', requestId: request.requestId }); await flush(); label(hand, 2, { stale: true });
  resumed.deliver({ type: 'hand:withdraw', participantId: 'guest' }); label(hand, 2, { stale: true });
  resumed.deliver({ type: 'room:state', ...state(['guest', 'later']) }); label(hand, 1);
  assert.equal(h.status.textContent, '測試舞台 · 自己 · 收聽中');
  resumed.deliver({ type: 'room:state', ...state(['later'], { handRaised: false }) });
  assert.equal(hand.textContent, '舉手發言'); assert.equal(hand.disabled, false);
  assert.equal(controls(resumed).length, 0);
});

for (const terminal of ['leave', 'disconnected', 'closed', 'shutdown', 'kicked'] as const) {
  it(`whole embed actual SDK clears queue position after ${terminal} and ignores retired snapshots`, async t => {
    const h = await actualApp(t), { socket } = await h.join(raised), hand = h.node('hand');
    socket.deliver({ type: 'room:state', ...state(['earlier', 'guest']) }); label(hand, 2);
    if (terminal === 'leave') h.leave.click();
    else if (terminal === 'disconnected') await h.clients[0]!.disconnect();
    else socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
      : { type: 'room:closed', roomId: 'same-room', ...(terminal === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
    await flush();
    const notice = terminal === 'leave' ? '已離開。' : terminal === 'disconnected' ? '未連線'
      : terminal === 'kicked' ? '你已被主控移出房間。' : '房間已關閉。';
    assert.equal(h.status.textContent, notice); assert.equal(hand.textContent, '舉手發言');
    assert.equal(hand.disabled, true); assert.equal(hand.attributes['aria-busy'], 'false');
    socket.deliver({ type: 'room:state', ...state(['guest']) }); hand.invoke(); await h.tick(20000);
    assert.equal(hand.textContent, '舉手發言'); assert.equal(h.status.textContent, notice);
    assert.equal(controls(socket).length, 0); assert.equal(StageSocket.instances.length, 1);
    const { socket: fresh } = await h.join({ ...raised, participantId: 'replacement' }); label(hand, 0);
    fresh.deliver({ type: 'room:state', ...state(['guest', 'replacement'], { participantId: 'replacement' }) }); label(hand, 2);
  });
}

it('whole embed queue position requires a raised offstage noncontroller hand even with contradictory queue records', async t => {
  const h = await actualApp(t), { socket } = await h.join(raised), hand = h.node('hand');
  for (const overrides of [
    { role: 'controller' as const, onStage: false }, { role: 'controller' as const, onStage: true },
    { role: 'speaker' as const, onStage: true }, { role: 'audience' as const, onStage: true },
  ]) {
    socket.deliver({ type: 'room:state', ...state(['earlier', 'guest'], overrides) });
    label(hand, 0, { disabled: true }); hand.invoke(); assert.equal(controls(socket).length, 0);
  }
  socket.deliver({ type: 'room:state', ...state(['earlier', 'guest'], { role: 'speaker', onStage: false }) }); label(hand, 2);
  socket.deliver({ type: 'room:state', ...state(['guest'], { handRaised: false }) });
  assert.equal(hand.textContent, '舉手發言'); assert.equal(hand.disabled, false);
  assert.equal(controls(socket).length, 0);
});

it('whole embed actual SDK uses exact identity and the first queue match, with no inferred missing-self position', async t => {
  const h = await actualApp(t), { socket } = await h.join(raised), hand = h.node('hand');
  for (const ids of [[], ['GUEST'], ['other', 'somebody']]) {
    const snapshot = state(ids); snapshot.hands.forEach(person => { person.name = snapshot.me.name; });
    socket.deliver({ type: 'room:state', ...snapshot }); label(hand, 0);
  }
  socket.deliver({ type: 'room:state', ...state(['other', 'guest', 'guest']) }); label(hand, 2);
  socket.deliver({ type: 'room:state', ...state(['guest', 'other', 'guest']) }); label(hand, 1);
  socket.deliver({ type: 'room:state', ...state(['other']) }); socket.close(); label(hand, 0, { disabled: true });
  assert.equal(h.status.textContent, '重新連線中'); assert.equal(controls(socket).length, 0);
});

it('whole embed queue label adds no timer, control request or private-name/code output, and tolerates no snapshot', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(raised); label(h.hand, 0);
  const snapshot = state(['earlier', 'listener']); snapshot.me.participantId = 'listener'; snapshot.code = 'PRIVATE42';
  Object.assign(sdk, { state: snapshot, me: snapshot.me }); sdk.emit('state', snapshot); label(h.hand, 2);
  assert.doesNotMatch(h.hand.textContent + h.status.textContent, /其他人的秘密名字|PRIVATE42/);
  h.clock.resetMetrics(); h.hand.resetWrites(); h.tick(10000);
  assert.equal(h.clock.timers.length, 0);
  assert.deepEqual(h.clock.metrics, { timeoutScheduled: 0, intervalScheduled: 0, timeoutCleared: 0, intervalCleared: 0, callbacks: 0 });
  assert.deepEqual(h.hand.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
  sdk.setStatus('reconnecting'); label(h.hand, 2, { stale: true }); h.hand.invoke();
  h.clock.resetMetrics(); h.hand.resetWrites(); h.tick(10000);
  assert.equal(h.clock.metrics.callbacks, 0); assert.equal(h.clock.timers.length, 0);
  assert.deepEqual(h.hand.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
  assert.equal(sdk.actions.length, 0);
});
