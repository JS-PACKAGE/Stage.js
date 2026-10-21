import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { embedApp, flush, type EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';

// Both fixtures execute the complete production embed. actualApp uses the real SDK
// with fake DOM, socket and browser media; embedApp additionally controls SDK promises
// and timer delivery. invoke() is adversarial direct onclick, not native browser input.
type ActualApp = Awaited<ReturnType<typeof actualApp>>;
type ActualSdk = ActualApp['clients'][number] & {
  readonly state: RoomStatePayload | null;
  readonly handCooldownMs: number;
  raiseHand(): Promise<void>;
  withdrawHand(): Promise<void>;
  setName(name: string): Promise<void>;
  mute(): Promise<void>;
  unmute(): Promise<void>;
  leaveStage(): Promise<void>;
  returnToStage(): Promise<void>;
};
type View = { node(id: string): EmbedNode; status: EmbedNode };
const clientAt = (h: ActualApp): ActualSdk => h.clients.at(-1)! as ActualSdk;
const handFrames = (socket: StageSocket) => socket.sent.filter(message => message.type === 'hand:raise' || message.type === 'hand:withdraw');
function hand(button: EmbedNode, disabled: boolean, busy = false, text = '舉手發言'): void {
  assert.equal(button.disabled, disabled); assert.equal(button.attributes['aria-busy'], String(busy)); assert.equal(button.textContent, text);
}
function feedback(h: View) {
  return { status: h.status.textContent, error: h.node('last-error').textContent, hidden: h.node('error-notice').hidden };
}
function directHand(button: EmbedNode): void {
  button.disabled = false; button.invoke();
}
function state(handRaised: boolean, overrides: Partial<ParticipantView> = {}): RoomStatePayload {
  const snapshot = actualState({ role: 'audience', onStage: false, handRaised, ...overrides });
  snapshot.speakers = snapshot.me.onStage ? [snapshot.me] : [];
  snapshot.hands = snapshot.me.handRaised ? [snapshot.me] : [];
  return snapshot;
}
async function hello(h: ActualApp, socket: StageSocket) {
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'real SDK join frame');
  const request = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join');
  assert.ok(request); return request;
}
async function beforeJoinAck(t: TestContext, snapshot: RoomStatePayload) {
  const h = await actualApp(t), button = h.node('hand');
  hand(button, true); directHand(button); assert.equal(h.clients.length, 0);
  h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
  hand(button, true); directHand(button); assert.equal(handFrames(socket).length, 0);
  const joining = await hello(h, socket), client = clientAt(h);
  hand(button, true); directHand(button); assert.equal(handFrames(socket).length, 0);
  socket.deliver({ type: 'room:state', ...snapshot }); await flush();
  await h.until(() => StagePeer.instances.at(-1)?.signalingState === 'stable'
    && StagePeer.instances.at(-1)?.localDescription !== null, 'fake media negotiation before join ACK');
  assert.equal(h.form.submitButton!.disabled, true, 'the initial join ACK is deliberately still pending');
  assert.equal(h.node('cancel-join').hidden, true); assert.ok(client.state); assert.ok(client.me);
  return { ...h, socket, client, joining, button };
}
async function command(h: ActualApp, socket: StageSocket, type: 'hand:raise' | 'hand:withdraw') {
  const before = handFrames(socket).length; h.node('hand').click();
  await h.until(() => handFrames(socket).length === before + 1, type);
  const request = handFrames(socket).at(-1)!; assert.equal(request.type, type); return request;
}
function handSpies(t: TestContext, client: ActualSdk) {
  const raise = t.mock.method(client, 'raiseHand'), withdraw = t.mock.method(client, 'withdrawHand');
  return () => ({ raise: raise.mock.callCount(), withdraw: withdraw.mock.callCount() });
}

for (const handRaised of [false, true]) {
  it(`whole embed actual SDK pre-ACK socket loss retires retained ${handRaised ? 'withdrawal' : 'raise'} and preserves dismissed feedback`, async t => {
    const h = await beforeJoinAck(t, state(handRaised)), calls = handSpies(t, h.client);
    const retained = h.client.state; hand(h.button, false, false, handRaised ? '收回舉手（佇列第 1 位）' : '舉手發言');
    h.socket.close(); await flush();
    assert.equal(h.client.status, 'disconnected'); assert.equal(h.client.state, retained); assert.equal(h.client.me, retained!.me);
    assert.equal(h.client.me!.handRaised, handRaised, 'retirement must not depend on clearing the authoritative snapshot');
    hand(h.button, true); assert.equal(h.leave.disabled, true); assert.equal(h.form.submitButton!.disabled, false);
    const before = feedback(h), frames = h.socket.sent.length, cooldown = h.client.handCooldownMs;
    assert.equal(before.error, '最近錯誤：連線已中斷。'); assert.equal(before.hidden, false);
    h.button.click(); directHand(h.button); await flush();
    hand(h.button, true); assert.deepEqual(calls(), { raise: 0, withdraw: 0 });
    assert.equal(h.socket.sent.length, frames); assert.equal(h.client.handCooldownMs, cooldown); assert.deepEqual(feedback(h), before);
    h.node('error-dismiss').click(); const dismissed = feedback(h);
    assert.equal(dismissed.hidden, true); assert.equal(dismissed.error, '');
    directHand(h.button); await flush(); hand(h.button, true); assert.deepEqual(feedback(h), dismissed);
    h.button.resetWrites(); await h.tick(30000);
    assert.deepEqual(h.button.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
    assert.deepEqual(feedback(h), dismissed); assert.deepEqual(calls(), { raise: 0, withdraw: 0 });
    assert.equal(h.socket.sent.length, frames); assert.equal(StageSocket.instances.length, 1, 'an unacknowledged join cannot start session resume');
    assert.equal(h.captures.length, 0); assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'));
  });
}

for (const status of ['waiting', 'live'] as const) {
  it(`whole embed actual SDK keeps ${status} state-before-join-ACK hand actions available and pending toggles authoritative`, async t => {
    const initial = state(false); initial.status = status;
    const h = await beforeJoinAck(t, initial), calls = handSpies(t, h.client);
    assert.equal(h.client.status, status); hand(h.button, false);
    const raise = await command(h, h.socket, 'hand:raise'); hand(h.button, true, true, '舉手發言（10 秒）');
    const raised = state(true); raised.status = status; h.socket.deliver({ type: 'room:state', ...raised });
    directHand(h.button); hand(h.button, true, true, '收回舉手（佇列第 1 位）');
    assert.deepEqual(calls(), { raise: 1, withdraw: 0 });
    h.socket.deliver({ type: 'ok', requestId: raise.requestId }); await flush();
    hand(h.button, false, false, '收回舉手（佇列第 1 位）');
    const withdraw = await command(h, h.socket, 'hand:withdraw');
    h.socket.deliver({ type: 'room:state', ...initial }); directHand(h.button);
    hand(h.button, true, true, '舉手發言（10 秒）'); assert.deepEqual(calls(), { raise: 1, withdraw: 1 });
    h.socket.deliver({ type: 'ok', requestId: withdraw.requestId }); await flush(); hand(h.button, true, false, '舉手發言（10 秒）');
    assert.equal(h.form.submitButton!.disabled, true, 'hand ACKs do not finish the independent initial join');
    h.socket.deliver({ type: 'ok', requestId: h.joining.requestId }); await flush();
    assert.equal(h.form.submitButton!.disabled, false); await h.tick(10000); hand(h.button, false);
    assert.deepEqual(handFrames(h.socket).map(message => message.type), ['hand:raise', 'hand:withdraw']); assert.equal(h.captures.length, 0);
  });
}

for (const handRaised of [false, true]) {
  it(`whole embed actual SDK pre-ACK loss releases pending ${handRaised ? 'withdrawal' : 'raise'} without repainting a retained cooldown`, async t => {
    const h = await beforeJoinAck(t, state(handRaised)), calls = handSpies(t, h.client);
    const pending = await command(h, h.socket, handRaised ? 'hand:withdraw' : 'hand:raise');
    assert.equal(h.button.attributes['aria-busy'], 'true');
    const retained = h.client.state, cooldown = h.client.handCooldownMs;
    h.socket.close();
    hand(h.button, true, false); assert.equal(h.client.state, retained);
    await flush(); const notice = feedback(h), frames = h.socket.sent.length;
    hand(h.button, true); assert.equal(h.client.status, 'disconnected'); assert.equal(h.client.handCooldownMs, cooldown);
    directHand(h.button); h.socket.deliver({ type: 'ok', requestId: pending.requestId }); await flush();
    assert.deepEqual(calls(), { raise: handRaised ? 0 : 1, withdraw: handRaised ? 1 : 0 });
    assert.deepEqual(feedback(h), notice); assert.equal(h.socket.sent.length, frames);
    h.button.resetWrites(); await h.tick(10000); hand(h.button, true);
    assert.deepEqual(h.button.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
    assert.equal(h.client.handCooldownMs, 0); assert.equal(h.client.state, retained); assert.deepEqual(feedback(h), notice);
  });
}

for (const handRaised of [false, true]) {
  it(`whole embed actual SDK same-seat resume retains ${handRaised ? 'raised-hand queue' : 'raise cooldown'} ownership instead of terminal retirement`, async t => {
    const h = await actualApp(t), { socket, peer } = await h.join({ role: 'audience', onStage: false }), client = clientAt(h);
    const button = h.node('hand'), calls = handSpies(t, client);
    const raise = await command(h, socket, 'hand:raise');
    if (handRaised) socket.deliver({ type: 'room:state', ...state(true) });
    socket.deliver({ type: 'ok', requestId: raise.requestId }); await flush();
    const retained = client.state; socket.close(); await flush();
    assert.equal(client.status, 'reconnecting'); assert.equal(client.state, retained); assert.equal(peer.connectionState, 'connected');
    hand(button, true, false, handRaised ? '收回舉手（上次佇列第 1 位）' : '舉手發言（10 秒）');
    directHand(button); assert.deepEqual(calls(), { raise: 1, withdraw: 0 });
    await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
    const request = await hello(h, resumed); assert.equal(request.resumeToken, 'test-resume');
    resumed.deliver({ type: 'ok', requestId: request.requestId }); await flush(); assert.equal(client.status, 'reconnecting');
    resumed.deliver({ type: 'room:state', ...state(handRaised) }); await flush();
    assert.equal(h.clients.length, 1); assert.equal(h.clients[0], client); assert.equal(StagePeer.instances.length, 1);
    if (handRaised) hand(button, false, false, '收回舉手（佇列第 1 位）');
    else { hand(button, true, false, '舉手發言（10 秒）'); await h.tick(10000); hand(button, false); }
    const active = await command(h, resumed, handRaised ? 'hand:withdraw' : 'hand:raise');
    resumed.deliver({ type: 'ok', requestId: active.requestId }); await flush();
    assert.deepEqual(calls(), { raise: handRaised ? 1 : 2, withdraw: handRaised ? 1 : 0 }); assert.equal(h.captures.length, 0);
  });
}

for (const [role, onStage] of [['speaker', true], ['controller', true], ['controller', false]] as const) {
  it(`whole embed actual SDK retained ${role} onStage=${onStage} keeps existing mic, stage and rename retirement gates`, async t => {
    const h = await beforeJoinAck(t, state(false, { role, onStage }));
    const methods = ['raiseHand', 'withdrawHand', 'mute', 'unmute', 'leaveStage', 'returnToStage', 'setName'] as const;
    const spies = methods.map(name => t.mock.method(h.client, name));
    h.socket.close(); await flush(); const before = feedback(h), frames = h.socket.sent.length;
    assert.ok(h.client.me); assert.equal(h.client.status, 'disconnected');
    for (const id of ['hand', 'mic', 'stage', 'rename', 'mic-retry']) {
      const button = h.node(id); assert.equal(button.disabled, true); button.disabled = button.hidden = false; button.invoke();
      assert.equal(button.disabled, true); assert.equal(button.attributes['aria-busy'], 'false');
      if (id !== 'hand') assert.equal(button.hidden, true);
    }
    await flush(); assert.ok(spies.every(spy => spy.mock.callCount() === 0)); assert.equal(h.calls(), 0);
    assert.deepEqual(feedback(h), before); assert.equal(h.socket.sent.length, frames);
  });
}

for (const handRaised of [false, true]) for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed retained snapshot retirement clears pending ${handRaised ? 'withdrawal' : 'raise'}, timer and late ${settlement}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised });
    if (handRaised) sdk.handCooldownMs = 2500;
    h.hand.click(); const pending = sdk.actions[0]!.work;
    if (handRaised) sdk.snapshot({ handRaised: false });
    assert.equal(h.hand.attributes['aria-busy'], 'true'); assert.equal(h.clock.timers.length, 1);
    const timer = h.clock.timers[0]!, retained = sdk.state, cooldown = sdk.handCooldownMs;
    sdk.emit('error', new Error('保留目前錯誤。')); sdk.setStatus('disconnected');
    assert.equal(sdk.state, retained); assert.ok(sdk.me); assert.equal(sdk.handCooldownMs, cooldown);
    hand(h.hand, true); assert.equal(h.clock.timers.length, 0);
    const notice = feedback(h); directHand(h.hand); await flush(); assert.deepEqual(feedback(h), notice);
    assert.equal(sdk.actions.length, 1); h.hand.resetWrites(); h.clock.resetMetrics(); h.tick(10000);
    assert.equal(h.clock.metrics.callbacks, 0); h.clock.fireRetired(timer.id);
    assert.deepEqual(h.hand.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
    h.node('error-dismiss').click(); const dismissed = feedback(h);
    if (settlement === 'resolve') pending.resolve(); else pending.reject('已退役操作不得重建錯誤。');
    await flush(); directHand(h.hand); await flush();
    hand(h.hand, true); assert.equal(h.clock.timers.length, 0); assert.equal(sdk.actions.length, 1); assert.deepEqual(feedback(h), dismissed);
  });
}

for (const transition of ['new attempt', 'leave and rejoin'] as const) for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed ${transition} owns its new pending hand and countdown after retired ${settlement}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join();
    h.hand.click(); const pending = old.actions[0]!.work, timer = h.clock.timers[0]!;
    old.setStatus('disconnected'); hand(h.hand, true); assert.ok(old.me); assert.equal(h.clock.timers.length, 0);
    if (transition === 'leave and rejoin') { h.leave.invoke(); await flush(); assert.equal(h.status.textContent, '已離開。'); }
    const current = await h.join(); assert.notEqual(current, old); h.hand.click();
    const active = current.actions[0]!.work, activeTimer = h.clock.timers[0]!;
    current.emit('error', new Error('新連線的操作回饋。')); const notice = feedback(h);
    if (settlement === 'resolve') pending.resolve(); else pending.reject('舊連線的遲來錯誤。');
    await flush(); h.hand.resetWrites(); h.clock.fireRetired(timer.id);
    assert.deepEqual(h.hand.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
    assert.deepEqual(h.clock.timers, [activeTimer]); assert.deepEqual(feedback(h), notice);
    hand(h.hand, true, true, '舉手發言（2 秒）'); directHand(h.hand);
    assert.equal(current.actions.length, 1); assert.equal(old.actions.length, 1); assert.equal(active.settled, false);
    current.snapshot({ handRaised: true }); active.resolve(); await flush(); hand(h.hand, false, false, '收回舉手');
    assert.equal(h.clock.timers.length, 0); assert.equal(h.clients.length, 2); assert.deepEqual(feedback(h).error, notice.error);
  });
}
