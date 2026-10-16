import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { StageClient, MAX_GAIN_DB } from '../packages/client/src/index.ts';
import type { ClientMessage, ServerMessage, ParticipantView } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { Deferred, embedApp, flush, type EmbedNode, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, StageSocket, StagePeer } from './fixtures/embedSdkApp.ts';
import { harness, testConfig, FakeSession } from './helpers.ts';

type View = { node(id: string): EmbedNode };
function controls(h: View, index = 0) {
  const node = h.node('stage-management-list').children[index]; assert.ok(node, `stage row ${index}`);
  const name = node.children[0], actions = node.children[1]; assert.ok(name); assert.ok(actions);
  const mute = actions.children[0], remove = actions.children[1], transfer = actions.children[2];
  assert.ok(mute); assert.ok(remove); assert.ok(transfer, 'confirmed handoff action is present');
  return { node, name, actions, mute, remove, transfer };
}

// Whole modules with controlled DOM/media. Native layout, keyboard/focus, assistive
// technology and hardware/codec audio are separate, unverified validation layers.
function tree(node: EmbedNode): EmbedNode[] { return [node, ...node.children.flatMap(tree)]; }
function row(h: View, index = 0) {
  const r = controls(h, index), nodes = tree(r.node);
  const draft = nodes.find(node => node.tagName === 'INPUT'), label = nodes.find(node => node.tagName === 'LABEL');
  const apply = nodes.find(node => node.textContent === '套用混音增益');
  const accepted = nodes.find(node => node.textContent.startsWith('目前混音增益：'));
  assert.ok(draft); assert.ok(label); assert.ok(apply); assert.ok(accepted);
  assert.ok(label.contains(draft), 'native wrapping label identifies draft');
  return { ...r, draft, label, apply, accepted };
}
const person = (id: string, patch: Partial<ParticipantView> = {}): ParticipantView => ({
  participantId: id, name: id, role: 'speaker', onStage: true, handRaised: false, muted: false,
  forceMuted: false, connected: true, gainDb: 0, joinedAt: 0, ...patch,
});
function snapshot(sdk: EmbedSdk, speakers = [person('first'), person('second')],
  patch: { roomId?: string; me?: Partial<ParticipantView> } = {}, emit = true): void {
  assert.ok(sdk.state); assert.ok(sdk.me);
  sdk.state = { ...sdk.state, ...patch, speakers, me: { ...sdk.me, ...patch.me } }; sdk.me = sdk.state.me;
  if (emit) sdk.emit('state', sdk.state);
}
function edit(r: ReturnType<typeof row>, value: string): void { r.draft.value = value; assert.ok(r.draft.oninput); r.draft.oninput(); }
function force(button: EmbedNode): void { button.disabled = false; button.invoke(); }
function notice(h: View, message: string): void {
  assert.equal(h.node('error-notice').hidden, false); assert.equal(h.node('last-error').textContent, `最近錯誤：${message}`);
}
function locked(r: ReturnType<typeof row>, pending = true, disabled = pending): void {
  for (const control of [r.draft, r.apply, r.mute, r.remove]) {
    assert.equal(control.disabled, disabled); assert.equal(control.getAttribute('aria-busy'), String(pending));
  }
}
async function app(t: TestContext, options: Parameters<typeof embedApp>[0] = {}, onStage = false) {
  const h = embedApp({ confirm: () => true, ...options }); t.after(() => h.cleanup());
  const sdk = await h.join({ role: 'controller', onStage }); snapshot(sdk); return { h, sdk };
}

for (const onStage of [false, true]) for (const status of ['waiting', 'live'] as const)
  it(`gain exposes labeled bounded explicit draft to controller onStage=${onStage} ${status}, including offline muted speaker`, async t => {
    const { h, sdk } = await app(t, {}, onStage); sdk.setStatus(status); snapshot(sdk, []);
    snapshot(sdk, [person('first', { name: '<img src=x>', gainDb: 3.3, connected: false, forceMuted: true, muted: true })]);
    const r = row(h); assert.equal(r.draft.type, 'number'); assert.equal(r.draft.step, '0.1');
    assert.equal(r.draft.min, String(-MAX_GAIN_DB)); assert.equal(r.draft.max, String(MAX_GAIN_DB));
    assert.equal(r.draft.value, '3.3'); assert.equal(r.accepted.textContent, '目前混音增益：+3.3 dB');
    assert.match(r.label.children[0]!.textContent, /<img src=x> 的混音增益草稿（dB）.*步進 0.1/);
    assert.equal(r.label.children[0]!.children.length, 0); assert.equal(r.apply.type, 'button');
    assert.equal(r.apply.getAttribute('aria-label'), '套用 <img src=x> 的混音增益');
    assert.match(tree(r.node).map(n => n.textContent).join(' '), /房間混音.*0 表示.*後續音訊或返回舞台.*不會解除麥克風靜音/);
    assert.match(r.name.textContent, /暫時離線/); locked(r, false);
    assert.ok(tree(r.node).every(n => !n.getAttribute('aria-live') && !n.getAttribute('autofocus')));
    edit(r, '-6.04'); assert.equal(sdk.gains.length, 0); r.apply.click(); locked(r);
    assert.deepEqual(sdk.gains.map(({ id, gainDb }) => [id, gainDb]), [['first', -6.04]]);
    assert.equal(sdk.state!.speakers[0]!.gainDb, 3.3); assert.equal(sdk.retryCalls, 0); assert.equal(sdk.actions.length, 0);
  });
it('gain filters self, offstage, invalid and duplicate targets in current authoritative order', async t => {
  const { h, sdk } = await app(t);
  snapshot(sdk, [person(''), person(sdk.me!.participantId), person('off', { onStage: false }), person('aud', { role: 'audience' }),
    person('a', { role: 'audience' }), person('a', { gainDb: -2 }), person('a', { gainDb: 8 }), person('b')]);
  assert.equal(h.node('stage-management-list').children.length, 2);
  assert.equal(row(h).draft.value, '-2'); row(h).apply.click(); row(h, 1).apply.click();
  assert.deepEqual(sdk.gains.map(g => g.id), ['a', 'b']);
});
for (const role of ['audience', 'speaker'] as const) it(`${role} cannot expose or invoke obsolete gain controls`, async t => {
  const { h, sdk } = await app(t), old = row(h); snapshot(sdk, undefined, { me: { role } });
  assert.equal(h.node('stage-management').hidden, true); force(old.apply); assert.equal(sdk.gains.length, 0);
});
it('gain is absent before entry/load/snapshot and cancel cannot restore an old owner', async t => {
  const gate = new Deferred(), h = embedApp({ libraryLoad: gate.promise });
  t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  assert.equal(h.node('stage-management-list').children.length, 0); h.form.submit(); await flush();
  assert.equal(h.node('stage-management-list').children.length, 0); h.node('cancel-join').click(); gate.resolve(); await flush();
  assert.equal(h.clients.length, 0); assert.equal(h.node('stage-management').hidden, true);
});
for (const value of ['', ' ', '\t', 'NaN', 'Infinity', '-Infinity', '1e309', '0x10', '1x', '-', '-20.001', '20.001'])
  it(`gain rejects invalid draft ${JSON.stringify(value)} even through a forced apply`, async t => {
    const { h, sdk } = await app(t), r = row(h); edit(r, value);
    assert.equal(r.apply.disabled, true); assert.equal(r.draft.disabled, false); force(r.apply);
    assert.equal(sdk.gains.length, 0); assert.equal(r.accepted.textContent, '目前混音增益：0 dB'); assert.equal(r.draft.value, value);
    edit(r, '0'); assert.equal(r.apply.disabled, false); r.apply.click(); assert.equal(sdk.gains[0]!.gainDb, 0);
  });
it('many input and change events only edit a local draft and never enqueue work or timers', async t => {
  const { h, sdk } = await app(t), r = row(h); h.clock.resetMetrics();
  for (let i = 0; i < 40; i++) { edit(r, String(i / 10)); r.draft.invokeChange(); }
  assert.equal(sdk.gains.length, 0); assert.equal(r.accepted.textContent, '目前混音增益：0 dB');
  assert.equal(h.clock.timers.length, 0); assert.equal(h.clock.metrics.timeoutScheduled, 0); assert.equal(h.clock.metrics.intervalScheduled, 0);
});
it('draft survives reorder, rename, state before ACK, controller stage changes and ACK without optimistic gain', async t => {
  const { h, sdk } = await app(t), first = row(h), second = row(h, 1); h.node('stage-management').open = true;
  edit(first, '3.26'); first.apply.click();
  snapshot(sdk, [person('second'), person('first', { name: '<new>', gainDb: 3.3 })], { me: { onStage: true } });
  assert.equal(row(h).node, second.node); assert.equal(row(h, 1).node, first.node); assert.equal(first.draft.value, '3.26');
  assert.equal(first.accepted.textContent, '目前混音增益：+3.3 dB'); assert.match(first.label.children[0]!.textContent, /<new>/); locked(first);
  assert.equal(h.node('stage-management').open, true); sdk.gains[0]!.work.resolve(); await flush(); locked(first, false);
  assert.equal(first.draft.value, '3.26'); assert.equal(first.accepted.textContent, '目前混音增益：+3.3 dB');
  edit(first, '-4'); first.apply.click(); sdk.gains[1]!.work.resolve(); await flush();
  assert.equal(first.accepted.textContent, '目前混音增益：+3.3 dB'); assert.equal(first.draft.value, '-4');
});
for (const bound of [undefined, null, '20', NaN, Infinity, 0, -1])
  it(`invalid exported gain bound ${String(bound)} disables only gain`, async t => {
    const { h, sdk } = await app(t, { maxGainDb: bound }), r = row(h);
    assert.equal(r.draft.disabled, true); assert.equal(r.apply.disabled, true);
    assert.match(tree(r.node).map(n => n.textContent).join(''), /SDK 不支援混音增益調整/);
    force(r.apply); assert.equal(sdk.gains.length, 0); assert.equal(r.mute.disabled, false); assert.equal(r.remove.disabled, false);
    r.mute.click(); assert.equal(sdk.stageModerations.length, 1); assert.equal(sdk.joins.length, 1);
  });
it('gain uses SDK exported bound rather than a hardcoded alternate policy', async t => {
  const { h, sdk } = await app(t, { maxGainDb: 3 }), r = row(h);
  assert.equal(r.draft.min, '-3'); assert.equal(r.draft.max, '3'); edit(r, '3.01'); force(r.apply); assert.equal(sdk.gains.length, 0);
  edit(r, '3'); r.apply.click(); assert.equal(sdk.gains[0]!.gainDb, 3);
});
it('missing or removed setGain disables only gain without rejoin and can recover on same row', async t => {
  const { h, sdk } = await app(t), r = row(h), original = sdk.setGain.bind(sdk); Reflect.set(sdk, 'setGain', undefined);
  snapshot(sdk); assert.equal(r.draft.disabled, true); force(r.apply); assert.equal(sdk.gains.length, 0);
  assert.equal(r.transfer.disabled, false); assert.equal(r.mute.disabled, false);
  sdk.setGain = original; snapshot(sdk); edit(r, '1.2'); r.apply.click(); assert.equal(sdk.gains.length, 1);
  sdk.gains[0]!.work.resolve(); await flush(); Reflect.set(sdk, 'setGain', undefined); force(r.apply); assert.equal(sdk.gains.length, 1);
});
it('gain reserves shared target before SDK synchronous state/reentry, while other-target and personal lanes stay independent', async t => {
  const { h, sdk } = await app(t, {}, true), a = row(h), b = row(h, 1), original = sdk.setGain.bind(sdk);
  sdk.setGain = (id, value) => { force(a.apply); force(a.mute); force(a.remove); sdk.emit('state', sdk.state); force(a.apply); return original(id, value); };
  a.apply.click(); assert.equal(sdk.gains.length, 1); assert.equal(sdk.stageModerations.length, 0); locked(a); locked(b, false);
  b.mute.click(); sdk.state!.hands = [person('hand', { role: 'audience', onStage: false, handRaised: true })]; sdk.emit('state', sdk.state);
  h.node('hand-queue-list').children[0]!.children[1]!.children[0]!.click(); h.mic.click(); h.stage.click();
  assert.equal(sdk.stageModerations.length, 1); assert.equal(sdk.moderations.length, 1);
  assert.deepEqual(sdk.actions.map(a => a.type), ['mute', 'leaveStage']); assert.equal(sdk.deviceLists.length, 0); assert.equal(sdk.retryCalls, 0);
});
for (const kind of ['mute', 'remove'] as const) it(`${kind} pending blocks gain and gain pending blocks ${kind}`, async t => {
  const { h, sdk } = await app(t), r = row(h); r[kind].click(); force(r.apply); assert.equal(sdk.gains.length, 0);
  sdk.stageModerations[0]!.work.resolve(); await flush(); r.apply.click(); force(r[kind]);
  assert.equal(sdk.stageModerations.length, 1); assert.equal(sdk.gains.length, 1);
});
for (const outcome of ['resolve', 'reject'] as const) it(`same-ID replacement retains pending until ${outcome} without inherited draft or old-row feedback`, async t => {
  const { h, sdk } = await app(t), old = row(h); edit(old, '-7'); old.apply.click(); const work = sdk.gains[0]!.work;
  snapshot(sdk, [person('second')]); assert.equal(old.node.parentElement, null); assert.equal(old.draft.disabled, true);
  force(row(h).transfer); assert.equal(h.confirmations.length, 0, 'disappeared row token still blocks transfer');
  snapshot(sdk, [person('first', { gainDb: 5 }), person('second')]); const next = row(h); assert.notEqual(next.node, old.node);
  assert.equal(next.draft.value, '5'); locked(next); force(next.apply); force(old.apply); assert.equal(sdk.gains.length, 1);
  sdk.emit('error', new Error('new independent error')); if (outcome === 'resolve') work.resolve(); else work.reject('retired row error'); await flush();
  locked(next, false); notice(h, 'new independent error'); assert.equal(next.draft.value, '5'); next.apply.click(); locked(next);
  force(old.apply); assert.equal(sdk.gains.length, 2);
});
it('transfer confirmation and in-flight work block all gain actions, while gain blocks any transfer confirmation', async t => {
  let during: (() => void) | undefined;
  const { h, sdk } = await app(t, { confirm: () => { during?.(); return true; } }); const a = row(h), b = row(h, 1);
  during = () => { force(a.apply); force(b.apply); assert.equal(sdk.gains.length, 0); };
  a.transfer.click(); assert.equal(h.confirmations.length, 1); force(a.apply); force(b.apply); assert.equal(sdk.gains.length, 0);
  sdk.transfers[0]!.work.resolve(); await flush(); a.apply.click(); force(b.transfer); assert.equal(h.confirmations.length, 1);
  sdk.gains[0]!.work.resolve(); await flush(); assert.equal(b.transfer.disabled, false);
});
for (const accepted of [false, true]) it(`transfer ${accepted ? 'ACK' : 'cancel'} preserves unrelated gain draft and feedback`, async t => {
  const { h, sdk } = await app(t, { confirm: () => accepted }), r = row(h); edit(r, '2.9'); sdk.emit('error', new Error('keep'));
  r.transfer.click(); if (accepted) sdk.transfers[0]!.work.resolve(); await flush();
  assert.equal(r.draft.value, '2.9'); assert.equal(r.apply.disabled, false); notice(h, 'keep');
});
for (const outcome of ['throw', 'bad_request', 'forbidden', 'not_found', 'timeout'] as const)
  it(`gain ${outcome} releases only its token and preserves draft for explicit retry`, async t => {
    const { h, sdk } = await app(t), r = row(h), other = row(h, 1), original = sdk.setGain.bind(sdk); edit(r, '1.234');
    other.mute.click(); if (outcome === 'throw') sdk.setGain = () => { throw new Error(outcome); };
    r.apply.click(); if (outcome !== 'throw') sdk.gains[0]!.work.reject(outcome); await flush();
    notice(h, outcome); locked(r, false); locked(other); assert.equal(r.draft.value, '1.234');
    sdk.setGain = original; r.apply.click(); locked(r); sdk.gains.at(-1)!.work.resolve(); await flush(); notice(h, outcome);
  });
it('same-seat reconnect preserves draft/open choice and labels accepted value last-received; pending settlement does not replay', async t => {
  const { h, sdk } = await app(t), a = row(h), b = row(h, 1); edit(a, '2.7'); h.node('stage-management').open = true; a.apply.click();
  sdk.setStatus('reconnecting'); assert.equal(row(h).node, a.node); assert.equal(a.draft.value, '2.7');
  assert.equal(a.accepted.textContent, '目前混音增益：0 dB（上次收到）'); locked(a); locked(b, false, true);
  force(a.apply); force(b.apply); assert.equal(sdk.gains.length, 1); sdk.emit('error', new Error('global reconnect error'));
  sdk.gains[0]!.work.reject('old offline promise error'); await flush(); notice(h, 'global reconnect error');
  sdk.setStatus('live'); locked(a, false); assert.equal(a.draft.value, '2.7'); assert.equal(h.node('stage-management').open, true);
  assert.equal(sdk.gains.length, 1);
});
for (const identity of ['role', 'room', 'participant'] as const) it(`reconnecting cannot establish fresh gain ${identity} owner`, async t => {
  const { h, sdk } = await app(t); sdk.setStatus('reconnecting');
  if (identity === 'role') { snapshot(sdk, [], { me: { role: 'audience' } }); snapshot(sdk, undefined, { me: { role: 'controller' } }); }
  else snapshot(sdk, undefined, identity === 'room' ? { roomId: 'new-room' } : { me: { participantId: 'new-controller' } });
  assert.equal(h.node('stage-management').hidden, true); sdk.setStatus('live'); assert.equal(row(h).apply.disabled, false);
});
for (const boundary of ['role', 'missing state', 'room', 'participant', 'leave', 'disconnected', 'closed', 'kicked', 'new entry'] as const)
  for (const outcome of ['resolve', 'reject'] as const) it(`${boundary} retires gain tenure; late ${outcome} cannot affect new pending or error`, async t => {
    const { h, sdk } = await app(t), old = row(h); edit(old, '-5'); old.apply.click(); const work = sdk.gains[0]!.work;
    let next = sdk;
    if (boundary === 'role') snapshot(sdk, [], { me: { role: 'audience' } });
    else if (boundary === 'missing state') { sdk.state = null; sdk.emit('status', sdk.status); }
    else if (boundary === 'room') snapshot(sdk, [], { roomId: 'other' });
    else if (boundary === 'participant') snapshot(sdk, [], { me: { participantId: 'other' } });
    else if (boundary === 'leave') { h.leave.click(); await flush(); }
    else if (boundary === 'disconnected') { await sdk.disconnect(); }
    else if (boundary === 'closed') sdk.emit('closed', { reason: 'shutdown' });
    else if (boundary === 'kicked') sdk.emit('kicked', {});
    else { next = await h.join({ role: 'controller' }); }
    assert.equal(old.node.parentElement, null); force(old.apply); assert.equal(sdk.gains.length, 1);
    if (['leave', 'disconnected', 'closed', 'kicked'].includes(boundary)) next = await h.join({ role: 'controller' });
    else if (boundary !== 'new entry') next.snapshot({ role: 'controller', connected: true });
    snapshot(next, [person('first', { gainDb: 4 }), person('second')]); const fresh = row(h); assert.equal(fresh.draft.value, '4');
    fresh.apply.click(); locked(fresh); next.emit('error', new Error('new owner error'));
    if (outcome === 'resolve') work.resolve(); else work.reject('old owner error'); await flush();
    locked(fresh); notice(h, 'new owner error'); assert.equal(fresh.draft.value, '4'); force(old.apply);
  });
for (const change of ['role', 'room', 'participant', 'reconnecting', 'disconnected seat', 'row', 'input', 'button', 'method', 'target'] as const)
  it(`gain final admission rejects reserve-time ${change} mutation`, async t => {
    const { h, sdk } = await app(t), r = row(h); let fired = false; const original = r.draft.setAttribute.bind(r.draft);
    r.draft.setAttribute = (key, value) => {
      original(key, value); if (fired || key !== 'aria-busy' || value !== 'true') return; fired = true;
      if (change === 'role') snapshot(sdk, undefined, { me: { role: 'audience' } }, false);
      else if (change === 'room') snapshot(sdk, undefined, { roomId: 'other' }, false);
      else if (change === 'participant') snapshot(sdk, undefined, { me: { participantId: 'other' } }, false);
      else if (change === 'reconnecting') sdk.status = 'reconnecting';
      else if (change === 'disconnected seat') snapshot(sdk, undefined, { me: { connected: false } }, false);
      else if (change === 'row') r.node.remove();
      else if (change === 'input') r.draft.remove();
      else if (change === 'button') r.apply.remove();
      else if (change === 'method') Reflect.set(sdk, 'setGain', undefined);
      else snapshot(sdk, [], {}, false);
    };
    sdk.emit('error', new Error('keep')); r.apply.click(); await flush(); assert.equal(fired, true); assert.equal(sdk.gains.length, 0); notice(h, 'keep');
  });
it('notification deltas alone leave gain to authoritative snapshot/server adjudication rather than transfer fences', async t => {
  const { h, sdk } = await app(t), r = row(h);
  sdk.emit('role', { participantId: sdk.me!.participantId, role: 'audience' }); sdk.emit('stageleft', { participantId: 'first' });
  assert.equal(r.transfer.disabled, true); assert.equal(r.apply.disabled, false); r.apply.click(); assert.equal(sdk.gains.length, 1);
});
async function setup(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; });
  const server = harness(config), host = await server.create('Synthetic host');
  const h = await actualApp(t, { confirm: () => true });
  let serverWork = Promise.resolve(), requestNo = 0;
  const rawRequests: ClientMessage[] = [], validated: ClientMessage[] = [], incoming: ServerMessage[] = [];
  const sessions = new Map<StageSocket, Session>();
  let holdStageAck = false, holdStates = false;
  const heldStates: ServerMessage[] = [];
  let beforeTransfer: (() => Promise<void>) | undefined;
  let beforeGain: (() => Promise<void>) | undefined;
  const closes: { code: number | undefined }[] = [];
  const originalClose = StageSocket.prototype.close;
  t.mock.method(StageSocket.prototype, 'close', function (this: StageSocket, code?: number) {
    closes.push({ code }); originalClose.call(this);
    const session = sessions.get(this);
    if (session) serverWork = serverWork.then(() => server.hub.detach(session, code === 1000));
  });
  const heldAcks: ServerMessage[] = [];
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    rawRequests.push(JSON.parse(data) as ClientMessage);
    const message = parseClientMessage(data, config.limits), session = sessions.get(this);
    assert.ok(session); this.sent.push(message); validated.push(message);
    serverWork = serverWork.then(async () => {
      if (message.type === 'control:transfer') await beforeTransfer?.();
      if (message.type === 'mic:gain') await beforeGain?.();
      await server.hub.handle(session, message);
    });
  });
  t.after(async () => { await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close(); });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic embed host';
  h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  const session: Session = {
    id: 'candidate-embed',
    send(message) {
      incoming.push(message);
      if (holdStates && message.type === 'room:state') { heldStates.push(message); return; }
      if (holdStageAck && message.type === 'ok' && validated.some(request =>
        request.type === 'mic:gain' && request.requestId === message.requestId)) {
        heldAcks.push(message); return;
      }
      if (socket.readyState === StageSocket.OPEN) socket.deliver(message);
    },
    close() { socket.close(); },
  };
  sessions.set(socket, session); server.hub.attach(session);
  await h.until(() => h.clients[0]?.me !== null && h.clients[0]?.me !== undefined, 'actual SDK joined');
  await h.tick(200); await serverWork; await flush();
  const client = h.clients[0] as StageClient;
  assert.equal(client.me?.role, 'audience'); assert.equal(client.me?.onStage, false);
  assert.equal(StageSocket.instances.length, 1); assert.equal(StagePeer.instances.length, 1);
  assert.equal(server.hub.isJoined(session), true);
  const pid = client.me!.participantId;
  const req = async (actor: FakeSession, message: Omit<ClientMessage, 'requestId'> & Record<string, unknown>) => {
    const requestId = `handoff-setup-${++requestNo}`;
    await server.hub.handle(actor, parseClientMessage(JSON.stringify({ ...message, requestId }), config.limits));
    const reply = actor.inbox.find(message => (message.type === 'ok' || message.type === 'error') && message.requestId === requestId);
    assert.ok(reply); return reply.type === 'error' ? reply.code : 'ok';
  };
  const flushStates = async () => {
    for (const timer of server.timers) if (!timer.cleared && (timer.ms === 0 || timer.ms === config.rooms.presenceBroadcastMs)) {
      timer.cleared = true; timer.fn();
    }
    await nextTurn(); await flush();
  };
  const command = async (kind: 'approve' | 'reject' | 'forceMute' | 'forceUnmute' | 'removeFromStage' | 'transferControl', id: string) => {
    const promise = client[kind](id).then(() => ({ ok: true as const }), error => ({ ok: false as const, code: error.code }));
    await h.tick(200); await serverWork; await flush(); return promise;
  };
  const approveUI = async (id: string) => {
    const index = client.state!.hands.findIndex(person => person.participantId === id); assert.ok(index >= 0);
    const row = h.node('hand-queue-list').children[index]!;
    row.children[1]!.children[0]!.click(); await h.tick(200); await serverWork; await flush();
    assert.equal(client.state!.speakers.some(person => person.participantId === id), true);
    assert.equal(client.state!.hands.some(person => person.participantId === id), false);
  };
  const transfer = async () => {
    assert.equal(await req(host.s, { type: 'control:transfer', targetId: pid }), 'ok'); await flush();
    assert.equal(client.me?.role, 'controller'); assert.equal(client.me?.onStage, false);
    assert.equal(h.node('room-name-panel').hidden, false);
    assert.equal(h.node('hand').disabled, true);
    assert.equal(h.stage.textContent, '返回舞台');
  };
  const applicant = async (name: string) => {
    const s = new FakeSession(); server.hub.attach(s);
    assert.equal(await req(s, { type: 'join', roomId: host.roomId, code: host.code, name }), 'ok');
    const person = { s, id: s.last('room:state')!.me.participantId };
    assert.equal(await req(person.s, { type: 'hand:raise' }), 'ok'); await flushStates(); return person;
  };
  const sdkApplicant = async (name: string) => {
    const audio = { autoplay: true, srcObject: null, volume: 1, muted: false, pauses: 0, plays: 0,
      pause() { this.pauses++; }, async play() { this.plays++; } };
    const target = new StageClient({ url: 'wss://stage.example.test/ws', audioElement: audio as unknown as HTMLAudioElement });
    h.clients.push(target);
    const joining = target.join({ roomId: host.roomId, code: host.code, name });
    const targetSocket = StageSocket.instances.at(-1)!;
    const s = new FakeSession();
    const send = s.send.bind(s);
    s.send = message => { send(message); if (targetSocket.readyState === StageSocket.OPEN) targetSocket.deliver(message); };
    s.close = () => { targetSocket.close(); };
    sessions.set(targetSocket, s); server.hub.attach(s);
    await h.until(() => target.me !== null, 'actual target SDK joined'); await h.tick(200); await serverWork; await flush(); await joining;
    const raising = target.raiseHand(); await h.tick(200); await serverWork; await flushStates(); await raising;
    return { client: target, id: target.me!.participantId, socket: targetSocket, s, audio, peer: StagePeer.instances.at(-1)! };
  };
  const transferUI = async (id: string) => {
    const people = client.state!.speakers.filter(p => p.participantId !== pid && p.role === 'speaker' && p.onStage);
    const index = people.findIndex(p => p.participantId === id); assert.ok(index >= 0);
    controls(h, index).transfer.click(); await h.tick(200); await serverWork; await flush();
  };
  return { config, server, host, h, client, pid, socket, session, rawRequests, validated, incoming, req, flushStates, command, approveUI, transfer, applicant, sdkApplicant, transferUI,
    holdStates: () => { holdStates = true; }, heldStates, releaseStates: () => { holdStates = false; for (const message of heldStates.splice(0)) socket.deliver(message); },
    drain: async () => { await serverWork; await flush(); }, holdAck: () => { holdStageAck = true; }, heldAcks, closes, beforeTransfer: (work: () => Promise<void>) => { beforeTransfer = work; }, beforeGain: (work: () => Promise<void>) => { beforeGain = work; } };
}
const counts = (f: Awaited<ReturnType<typeof setup>>) => ({ captures: f.h.captures.length, peers: StagePeer.instances.length,
  offers: StagePeer.instances.map(peer => peer.offers.length), plays: f.h.audio.plays, clients: f.h.clients.length, sockets: StageSocket.instances.length });
const hubRow = (f: Awaited<ReturnType<typeof setup>>, id: string) => {
  const i = f.client.state!.speakers.filter(p => p.participantId !== f.pid && p.role === 'speaker' && p.onStage).findIndex(p => p.participantId === id);
  assert.ok(i >= 0); const node = f.h.node('stage-management-list').children[i]!; assert.ok(node); return node;
};
function hubControls(f: Awaited<ReturnType<typeof setup>>, id: string) {
  const index = f.h.node('stage-management-list').children.indexOf(hubRow(f, id)); return row(f.h, index);
}
async function gainUI(f: Awaited<ReturnType<typeof setup>>, id: string, value: string) {
  const r = hubControls(f, id), before = f.validated.filter(m => m.type === 'mic:gain').length;
  edit(r, value); assert.equal(r.apply.disabled, false); r.apply.click();
  await f.h.tick(200); await f.drain();
  assert.equal(f.validated.filter(m => m.type === 'mic:gain').length, before + 1);
  const message = f.rawRequests.filter(m => m.type === 'mic:gain').at(-1)!;
  assert.equal(message.targetId, id); assert.equal(message.gainDb, Number(value)); return r;
}
for (const onStage of [false, true]) it(`generated embed UI → public SDK → validator → Hub normalizes gain with onStage=${onStage} controller`, async t => {
  const f = await setup(t); await f.transfer(); const target = await f.sdkApplicant('& <img src=x>'); await f.approveUI(target.id);
  await f.h.until(() => target.peer.transceiver.sender.track !== null, 'speaker microphone'); await f.h.tick(200); await f.drain();
  if (onStage) {
    f.h.stage.click(); await f.h.tick(200); await f.drain();
    await f.h.until(() => f.client.me?.onStage === true && StagePeer.instances[0]!.transceiver.sender.track !== null, 'controller microphone attached');
    await f.h.tick(200); await f.drain();
  }
  const before = counts(f), track = target.peer.transceiver.sender.track, peer = f.server.transport.rooms.get(f.host.roomId)!.peers.get(target.id);
  const r = await gainUI(f, target.id, '3.26');
  assert.match(r.label.children[0]!.textContent, /& <img src=x>/); assert.equal(r.label.children[0]!.children.length, 0);
  assert.equal(r.accepted.textContent, '目前混音增益：+3.3 dB'); assert.equal(r.draft.value, '3.26');
  assert.equal(f.client.state!.speakers.find(p => p.participantId === target.id)!.gainDb, 3.3); assert.equal(target.client.me!.gainDb, 3.3);
  assert.deepEqual(counts(f), before); assert.equal(target.peer.transceiver.sender.track, track); assert.equal(track!.stopped, false);
  assert.equal(f.server.transport.rooms.get(f.host.roomId)!.peers.get(target.id), peer); locked(r, false);
});
it('actual generated gain UI accepts both bounds/fractional precision and rejects invalid drafts without wire traffic', async t => {
  const f = await setup(t); await f.transfer();
  for (const [draft, accepted] of [['-20', -20], ['20', 20], ['1.234', 1.2], ['-2.46', -2.5], ['0', 0]] as const) {
    const r = await gainUI(f, f.host.id, draft); assert.equal(f.client.state!.speakers.find(p => p.participantId === f.host.id)!.gainDb, accepted);
    assert.equal(r.draft.value, draft); assert.equal(r.accepted.textContent, `目前混音增益：${accepted > 0 ? '+' : ''}${accepted} dB`);
  }
  const r = hubControls(f, f.host.id), before = f.validated.length;
  for (const invalid of ['', ' ', '-20.001', '20.001', 'NaN', 'Infinity']) { edit(r, invalid); force(r.apply); }
  await f.h.tick(200); await f.drain(); assert.equal(f.validated.length, before);
});
it('actual state-before-ACK updates accepted value without overwriting draft or unlocking, and gain never mutates media routes', async t => {
  const f = await setup(t); await f.transfer(); const target = await f.sdkApplicant('ACK target'); await f.approveUI(target.id);
  await f.h.until(() => target.peer.transceiver.sender.track !== null, 'speaker microphone'); await f.h.tick(200); await f.drain();
  const mixerSpy = t.mock.method(f.server.mixers.get(f.host.roomId)!, 'setGain');
  const routes = (['negotiate', 'addPublisher', 'removePublisher', 'setPublisherMuted', 'subscribe', 'unsubscribe', 'closePeer'] as const)
    .map(name => t.mock.method(f.server.transport, name));
  const before = counts(f), targetPlays = target.audio.plays; f.holdAck(); const r = await gainUI(f, target.id, '-6.04');
  assert.equal(r.accepted.textContent, '目前混音增益：-6 dB'); assert.equal(r.draft.value, '-6.04'); locked(r);
  force(r.apply); force(r.mute); force(r.remove); assert.equal(f.validated.filter(m => m.type === 'mic:gain').length, 1);
  assert.equal(f.heldAcks.length, 1); assert.equal(mixerSpy.mock.calls.length, 1); assert.deepEqual(mixerSpy.mock.calls[0]!.arguments, [target.id, -6]);
  assert.ok(routes.every(spy => spy.mock.calls.length === 0)); assert.deepEqual(counts(f), before); assert.equal(target.audio.plays, targetPlays);
  f.socket.deliver(f.heldAcks[0]!); await flush(); locked(r, false); assert.equal(r.draft.value, '-6.04');
  await gainUI(f, target.id, '2'); locked(r); f.socket.deliver(f.heldAcks[0]!); await flush(); locked(r, true);
  f.socket.deliver(f.heldAcks[1]!); await flush(); locked(r, false);
});
it('actual ACK alone cannot invent accepted gain and same normalized gain still gets authoritative requester state', async t => {
  const f = await setup(t); await f.transfer(); const target = await f.sdkApplicant('unchanged'); await f.approveUI(target.id);
  await f.h.until(() => target.peer.transceiver.sender.track !== null, 'speaker microphone'); await f.h.tick(200); await f.drain();
  f.holdStates(); const r = await gainUI(f, target.id, '-2.3');
  assert.equal(r.accepted.textContent, '目前混音增益：0 dB'); assert.equal(r.draft.value, '-2.3'); locked(r, false);
  f.releaseStates(); await flush(); assert.equal(r.accepted.textContent, '目前混音增益：-2.3 dB');
  const targetBefore = target.s.all('room:state').length, hostBefore = f.host.s.all('room:state').length, incomingBefore = f.incoming.length;
  await gainUI(f, target.id, '-2.31'); assert.equal(r.draft.value, '-2.31'); assert.equal(r.accepted.textContent, '目前混音增益：-2.3 dB');
  assert.deepEqual(f.incoming.slice(incomingBefore).map(m => m.type), ['room:state', 'ok']);
  assert.equal(target.s.all('room:state').length, targetBefore); assert.equal(f.host.s.all('room:state').length, hostBefore);
});
it('actual gain UI accepts retained offline self/force-muted speaker and preserves disabled track, peer and publisher', async t => {
  const f = await setup(t); await f.transfer(); const target = await f.sdkApplicant('offline muted'); await f.approveUI(target.id);
  await f.h.until(() => target.peer.transceiver.sender.track !== null, 'speaker microphone'); await f.h.tick(200); await f.drain();
  const muting = target.client.mute(); await f.h.tick(200); await f.drain(); await muting;
  hubControls(f, target.id).mute.click(); await f.h.tick(200); await f.drain();
  const room = f.server.transport.rooms.get(f.host.roomId)!, peer = room.peers.get(target.id), publisher = room.publishers.get(target.id);
  const track = target.peer.transceiver.sender.track!, before = counts(f), targetPlays = target.audio.plays;
  await f.server.hub.detach(target.s, false); await f.flushStates();
  const r = await gainUI(f, target.id, '-9.1'); assert.match(r.name.textContent, /暫時離線/);
  const state = f.client.state!.speakers.find(p => p.participantId === target.id)!;
  assert.equal(state.connected, false); assert.equal(state.gainDb, -9.1); assert.equal(state.muted, true); assert.equal(state.forceMuted, true);
  assert.equal(track.enabled, false); assert.equal(track.stopped, false); assert.equal(room.peers.get(target.id), peer); assert.equal(room.publishers.get(target.id), publisher);
  assert.deepEqual(counts(f), before); assert.equal(target.audio.plays, targetPlays);
  assert.equal(f.server.transport.emitUplink(f.host.roomId, target.id, new Float32Array(960).fill(0.1)), false);
});
it('actual gain UI changes room PCM contribution and minus-self only, preserving gain across offstage and next publisher', async t => {
  const f = await setup(t); await f.transfer(); const target = await f.sdkApplicant('PCM'); await f.approveUI(target.id);
  await f.h.until(() => target.peer.transceiver.sender.track !== null, 'speaker microphone'); await f.h.tick(200); await f.drain();
  const mixer = f.server.mixers.get(f.host.roomId)!, room = f.server.transport.rooms.get(f.host.roomId)!;
  const feed = () => {
    assert.equal(f.server.transport.emitUplink(f.host.roomId, target.id, new Float32Array(960).fill(0.1)), true);
    mixer.tick(); return room.peers.get(f.pid)!.received.at(-1)!.at(-1)!;
  };
  const unity = feed(), volume = f.client.playbackVolume, muted = f.client.playbackMuted;
  const old = await gainUI(f, target.id, '-6'); feed(); const scaled = feed(); assert.ok(Math.abs(scaled / unity - 10 ** (-6 / 20)) < 1e-6);
  assert.ok(room.peers.get(target.id)!.received.at(-1)!.every(value => Math.abs(value) < 1e-8));
  assert.equal(f.client.playbackVolume, volume); assert.equal(f.client.playbackMuted, muted);
  old.remove.click(); await f.h.tick(200); await f.drain(); assert.equal(old.node.parentElement, null);
  assert.equal(target.client.me!.gainDb, -6); assert.equal(target.client.me!.onStage, false); assert.equal(room.publishers.has(target.id), false);
  await f.h.tick(10001); f.server.clock.now += 10001;
  const raising = target.client.raiseHand(); await f.h.tick(200); await f.drain(); await raising; await f.flushStates();
  const spy = t.mock.method(mixer, 'setGain'); await f.approveUI(target.id);
  await f.h.until(() => target.peer.transceiver.sender.track !== null, 'returned speaker microphone'); await f.h.tick(200); await f.drain();
  const fresh = hubControls(f, target.id); assert.notEqual(fresh.node, old.node); assert.equal(fresh.draft.value, '-6');
  assert.equal(spy.mock.calls.length, 1); assert.deepEqual(spy.mock.calls[0]!.arguments, [target.id, -6]);
  feed(); assert.ok(Math.abs(feed() / unity - 10 ** (-6 / 20)) < 1e-6);
});
it('actual gain sent while onstage can execute after target leaves; retired UI cannot cancel or replay it', async t => {
  const f = await setup(t); await f.transfer(); const old = hubControls(f, f.host.id);
  f.beforeGain(async () => { assert.equal(await f.req(f.host.s, { type: 'stage:leave' }), 'ok'); });
  await gainUI(f, f.host.id, '-7.3'); assert.equal(old.node.parentElement, null);
  assert.equal(f.client.state!.audience!.find(p => p.participantId === f.host.id)!.gainDb, -7.3);
  const request = f.validated.filter(m => m.type === 'mic:gain').at(-1)!;
  assert.ok(f.incoming.some(m => m.type === 'ok' && m.requestId === request.requestId));
  force(old.apply); await f.h.tick(200); await f.drain(); assert.equal(f.validated.filter(m => m.type === 'mic:gain').length, 1);
});
for (const code of ['forbidden', 'not_found'] as const) it(`actual UI preserves notification-before-snapshot ${code} arbitration and generic error`, async t => {
  const f = await setup(t); await f.transfer(); const target = await f.applicant(code); await f.approveUI(target.id); const r = hubControls(f, target.id);
  f.holdStates();
  if (code === 'forbidden') { await f.transferUI(f.host.id); }
  else { const work = f.client.kick(target.id); await f.h.tick(200); await f.drain(); await work; }
  assert.equal(f.client.me!.role, 'controller'); assert.equal(r.apply.disabled, false);
  await gainUI(f, target.id, '1.23');
  const error = f.incoming.findLast(m => m.type === 'error'); assert.ok(error?.type === 'error'); assert.equal(error.code, code);
  notice(f.h, error.message); assert.equal(r.draft.value, '1.23'); locked(r, false);
  f.releaseStates(); await flush(); assert.equal(r.node.parentElement, null); const count = f.validated.length;
  force(r.apply); await f.h.tick(200); await f.drain(); assert.equal(f.validated.length, count);
});
it('actual timeout releases gain token for explicit retry; duplicate late ACK cannot settle its replacement', async t => {
  const f = await setup(t); await f.transfer(); f.holdAck(); const r = await gainUI(f, f.host.id, '2.46');
  await f.h.tick(15001); await f.drain(); locked(r, false); assert.equal(r.draft.value, '2.46');
  assert.match(f.h.node('last-error').textContent, /請求逾時/); await gainUI(f, f.host.id, '3'); locked(r);
  f.socket.deliver(f.heldAcks[0]!); await flush(); locked(r); f.socket.deliver(f.heldAcks[1]!); await flush(); locked(r, false);
});
