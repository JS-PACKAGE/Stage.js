import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { StageClient } from '../packages/client/src/index.ts';
import type { ClientMessage, ServerMessage, ParticipantView } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { Deferred, embedApp, flush, type EmbedNode, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, StageSocket, StagePeer } from './fixtures/embedSdkApp.ts';
import { harness, testConfig, FakeSession } from './helpers.ts';

// Entire production module; controlled dialogs, DOM, sockets and media do not prove
// native confirmation, keyboard/focus, accessibility-tree or physical audio behavior.
type View = { node(id: string): EmbedNode };
function controls(h: View, index = 0) {
  const node = h.node('stage-management-list').children[index]; assert.ok(node, `stage row ${index}`);
  const name = node.children[0], actions = node.children[1]; assert.ok(name); assert.ok(actions);
  const mute = actions.children[0], remove = actions.children[1], transfer = actions.children[2];
  assert.ok(mute); assert.ok(remove); assert.ok(transfer, 'confirmed handoff action is present');
  return { node, name, actions, mute, remove, transfer };
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
function force(button: EmbedNode): void { button.disabled = false; button.invoke(); }
function notice(h: View, text: string): void {
  assert.equal(h.node('error-notice').hidden, false); assert.equal(h.node('last-error').textContent, `最近錯誤：${text}`);
}
function stageLocked(h: View): void {
  for (const node of h.node('stage-management-list').children)
    for (const button of node.children[1]!.children) assert.equal(button.disabled, true);
}
async function app(t: TestContext, options: Parameters<typeof embedApp>[0] = {}, onStage = false) {
  const h = embedApp({ confirm: () => true, ...options }); t.after(() => h.cleanup());
  const sdk = await h.join({ role: 'controller', onStage }); snapshot(sdk); return { h, sdk };
}

it('whole embed exposes third identifying confirmed handoff action from existing stage row', async t => {
  const { h, sdk } = await app(t); snapshot(sdk, [person('first', { name: '<img src=x> &amp;' }), person('second', { name: '<img src=x> &amp;' })]);
  const r = controls(h); assert.equal(r.transfer.type, 'button'); assert.equal(r.transfer.textContent, '移交控制權');
  assert.equal(r.transfer.attributes['aria-label'], '將控制權移交給 <img src=x> &amp;'); assert.equal(r.transfer.hidden, false);
  assert.equal(r.transfer.disabled, false); assert.equal(r.transfer.children.length, 0);
  sdk.emit('error', new Error('keep feedback')); r.transfer.click(); stageLocked(h);
  assert.deepEqual(h.confirmations, ['確定將控制權移交給 <img src=x> &amp;？你將失去主控權限，但保留目前台位並留在房間。']);
  assert.deepEqual(sdk.transfers.map(({ id }) => id), ['first']); notice(h, 'keep feedback');
  assert.equal(sdk.me!.role, 'controller'); sdk.transfers[0]!.work.resolve(); await flush();
  assert.equal(sdk.me!.role, 'controller'); assert.equal(controls(h).transfer.disabled, false); notice(h, 'keep feedback');
  assert.equal(h.clock.timers.length, 0); assert.equal(sdk.deviceLists.length, 0); assert.equal(sdk.inputSelections.length, 0);
  assert.equal(sdk.retryCalls, 0); assert.equal(sdk.joins.length, 1);
});
for (const onStage of [false, true]) for (const status of ['waiting', 'live'] as const)
  for (const muted of [false, true]) it(`connected controller onStage=${onStage} ${status} may hand off to muted=${muted} connected stage speaker`, async t => {
    const { h, sdk } = await app(t, {}, onStage); sdk.setStatus(status);
    snapshot(sdk, [person('first', { muted, forceMuted: muted })]); controls(h).transfer.click();
    assert.deepEqual(sdk.transfers.map(({ id }) => id), ['first']); assert.equal(sdk.me!.onStage, onStage);
    assert.equal(sdk.state!.speakers[0]!.muted, muted); assert.equal(sdk.state!.speakers[0]!.forceMuted, muted);
  });
it('before entry, loading and absent snapshot offer no handoff; audience and ordinary speaker cannot acquire it', async t => {
  const gate = new Deferred(), h = embedApp({ libraryLoad: gate.promise, confirm: () => true });
  t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  assert.equal(h.node('stage-management-list').children.length, 0); h.form.submit(); await flush();
  assert.equal(h.node('stage-management-list').children.length, 0); gate.resolve(); await flush();
  assert.equal(h.node('stage-management-list').children.length, 0); const sdk = h.clients[0]!;
  for (const role of ['audience', 'speaker'] as const) {
    sdk.snapshot({ role, onStage: role === 'speaker' }); snapshot(sdk);
    assert.equal(h.node('stage-management').hidden, true); assert.equal(sdk.transfers.length, 0);
  }
});
it('handoff preserves roster filtering, distinct IDs and offline moderation eligibility', async t => {
  const { h, sdk } = await app(t); snapshot(sdk, [person(''), person(sdk.me!.participantId), person('first'), person('first'),
    person('audience', { role: 'audience' }), person('offstage', { onStage: false }), person('second', { connected: false })]);
  assert.equal(h.node('stage-management-list').children.length, 2); const offline = controls(h, 1);
  assert.equal(offline.transfer.disabled, true); force(offline.transfer); assert.equal(h.confirmations.length, 0);
  assert.equal(offline.mute.disabled, false); assert.equal(offline.remove.disabled, false); offline.mute.click();
  assert.equal(sdk.stageModerations[0]!.id, 'second'); assert.equal(sdk.transfers.length, 0);
});
for (const unavailable of ['method', 'confirm', 'local disconnected'] as const)
  it(`${unavailable} blocks forced handoff without fallback and leaves moderation intact`, async t => {
    const { h, sdk } = await app(t, unavailable === 'confirm' ? { confirm: null } : {});
    if (unavailable === 'method') Reflect.set(sdk, 'transferControl', undefined);
    snapshot(sdk, undefined, { me: { connected: unavailable !== 'local disconnected' } }); const r = controls(h);
    assert.equal(r.transfer.disabled, true); assert.equal(r.transfer.hidden, unavailable === 'method');
    force(r.transfer); assert.equal(h.confirmations.length, 0); assert.equal(sdk.transfers.length, 0);
    r.remove.click(); assert.equal(sdk.stageModerations.length, 1);
  });
it('cancel preserves recent error and releases reservation only after the dialog returns', async t => {
  let inspect = () => {};
  const { h, sdk } = await app(t, { confirm: () => { inspect(); return false; } });
  inspect = () => { stageLocked(h); force(controls(h, 1).transfer); force(controls(h).mute); force(controls(h, 1).remove); };
  sdk.emit('error', new Error('keep cancelled feedback')); controls(h).transfer.click(); await flush();
  assert.equal(h.confirmations.length, 1); assert.equal(sdk.transfers.length, 0); assert.equal(sdk.stageModerations.length, 0);
  assert.equal(controls(h).transfer.disabled, false); notice(h, 'keep cancelled feedback');
});
for (const failure of ['confirm throw', 'SDK throw', 'SDK reject'] as const)
  it(`current ${failure} reports without leaking reservation and permits a fresh explicit action`, async t => {
    let throwing = true;
    const { h, sdk } = await app(t, { confirm: () => { if (throwing && failure === 'confirm throw') throw new Error('current failure'); return true; } });
    const original = sdk.transferControl.bind(sdk);
    if (failure === 'SDK throw') sdk.transferControl = () => { throw new Error('current failure'); };
    controls(h).transfer.click(); if (failure === 'SDK reject') sdk.transfers[0]!.work.reject('current failure'); await flush();
    notice(h, 'current failure'); assert.equal(controls(h).transfer.disabled, false);
    throwing = false; sdk.transferControl = original; controls(h).transfer.click(); stageLocked(h);
    sdk.transfers.at(-1)!.work.resolve(); await flush(); notice(h, 'current failure');
  });
it('confirmation and SDK synchronous reentry cannot overlap dialogs or any stage action even after disabled tampering', async t => {
  let inspect = () => {};
  const { h, sdk } = await app(t, { confirm: () => { inspect(); return true; } });
  inspect = () => { for (const index of [0, 1]) { const r = controls(h, index); force(r.transfer); force(r.mute); force(r.remove); } };
  const original = sdk.transferControl.bind(sdk); sdk.transferControl = id => { inspect(); return original(id); };
  controls(h).transfer.click(); inspect(); snapshot(sdk); stageLocked(h);
  assert.equal(h.confirmations.length, 1); assert.equal(sdk.transfers.length, 1); assert.equal(sdk.stageModerations.length, 0);
});
for (const disappear of [false, true]) it(`pending stage moderation${disappear ? ' with vanished row' : ''} blocks all transfers while other moderation remains independent`, async t => {
  const { h, sdk } = await app(t); controls(h).mute.click(); const work = sdk.stageModerations[0]!.work;
  if (disappear) snapshot(sdk, [person('second')]);
  const r = controls(h, disappear ? 0 : 1); force(r.transfer); assert.equal(h.confirmations.length, 0);
  r.remove.click(); assert.equal(sdk.stageModerations.length, 2); work.resolve(); await flush();
  force(r.transfer); assert.equal(h.confirmations.length, 0); sdk.stageModerations[1]!.work.resolve(); await flush();
  r.transfer.click(); assert.equal(sdk.transfers[0]!.id, 'second');
});
it('handoff reservation leaves hand requests, room naming and personal stage/mic lanes independent', async t => {
  const { h, sdk } = await app(t, {}, true);
  sdk.state!.hands = [person('hand', { role: 'audience', onStage: false, handRaised: true })]; sdk.emit('state', sdk.state);
  controls(h).transfer.click(); h.node('hand-queue-list').children[0]!.children[1]!.children[0]!.click();
  h.node('room-name-draft').value = 'Independent title'; h.node('room-name-update').click(); h.mic.click(); h.stage.click();
  assert.equal(sdk.moderations.length, 1); assert.equal(sdk.roomRenames.length, 1);
  assert.deepEqual(sdk.actions.map(({ type }) => type), ['mute', 'leaveStage']); stageLocked(h);
});
it('safe rename, reorder, own-stage change and unrelated events preserve the current confirmation and target ID', async t => {
  let change = () => {};
  const { h, sdk } = await app(t, { confirm: () => { change(); return true; } }); const a = controls(h), b = controls(h, 1);
  h.node('stage-management').open = true;
  change = () => {
    snapshot(sdk, [person('second'), person('first', { name: 'renamed' })], { me: { onStage: true } });
    sdk.emit('role', { participantId: 'unrelated', role: 'audience' }); sdk.emit('stageleft', { participantId: 'unrelated' });
    sdk.emit('transferred', { fromId: 'unrelated', toId: 'another' });
  };
  a.transfer.click(); assert.equal(controls(h).node, b.node); assert.equal(controls(h, 1).node, a.node);
  assert.equal(a.transfer.attributes['aria-label'], '將控制權移交給 renamed'); assert.equal(h.node('stage-management').open, true);
  assert.deepEqual(sdk.transfers.map(({ id }) => id), ['first']);
});
for (const change of ['offline', 'offstage', 'role', 'removed', 'reconnecting', 'local disconnected', 'method', 'detached row', 'detached button'] as const)
  it(`observed transient ${change} during confirmation cannot revive its token after eligible restoration`, async t => {
    let mutate = () => {}, once = true;
    const { h, sdk } = await app(t, { confirm: () => { if (once) { once = false; mutate(); } return true; } });
    const old = controls(h), method = sdk.transferControl.bind(sdk); sdk.emit('error', new Error('retain transient feedback'));
    mutate = () => {
      if (change === 'reconnecting') sdk.setStatus('reconnecting');
      else if (change === 'local disconnected') snapshot(sdk, undefined, { me: { connected: false } });
      else if (change === 'method') { Reflect.set(sdk, 'transferControl', undefined); sdk.emit('state', sdk.state); }
      else if (change === 'detached row') { old.node.remove(); sdk.emit('state', sdk.state); h.node('stage-management-list').append(old.node); }
      else if (change === 'detached button') { old.transfer.remove(); sdk.emit('state', sdk.state); old.actions.append(old.transfer); }
      else snapshot(sdk, change === 'removed' ? [person('second')] : [person('first', {
        connected: change !== 'offline', onStage: change !== 'offstage', role: change === 'role' ? 'audience' : 'speaker',
      }), person('second')]);
      sdk.transferControl = method; sdk.setStatus('live'); snapshot(sdk, undefined, { me: { connected: true } });
      force(controls(h, 1).transfer); force(controls(h, 1).mute);
      assert.equal(sdk.stageModerations.length, 0, 'invalidated dialog still owns reservation until return');
    };
    old.transfer.click(); await flush(); assert.equal(sdk.transfers.length, 0); assert.equal(h.confirmations.length, 1);
    notice(h, 'retain transient feedback'); controls(h).transfer.click(); assert.equal(sdk.transfers.length, 1);
  });
const notifications = [
  ['own role', 'role', { participantId: 'listener', role: 'audience' }],
  ['target role', 'role', { participantId: 'first', role: 'audience' }],
  ['transfer away', 'transferred', { fromId: 'listener', toId: 'first' }],
  ['target stage left', 'stageleft', { participantId: 'first', role: 'audience' }],
] as const;
for (const [label, event, detail] of notifications) {
  it(`${label} notification fences new transfers until state but preserves old moderation window`, async t => {
    const { h, sdk } = await app(t); sdk.emit(event, detail); const r = controls(h);
    assert.equal(r.transfer.disabled, true); force(r.transfer); assert.equal(h.confirmations.length, 0);
    assert.equal(r.mute.disabled, false); r.mute.click(); assert.equal(sdk.stageModerations.length, 1);
    sdk.stageModerations[0]!.work.resolve(); await flush(); force(r.transfer); assert.equal(h.confirmations.length, 0);
    snapshot(sdk); r.transfer.click(); assert.equal(sdk.transfers.length, 1);
  });
  it(`${label} notification followed by eligible state cannot revive open confirmation`, async t => {
    let mutate = () => {}, once = true;
    const { h, sdk } = await app(t, { confirm: () => { if (once) { once = false; mutate(); } return true; } });
    mutate = () => { sdk.emit(event, detail); snapshot(sdk); force(controls(h, 1).transfer); };
    controls(h).transfer.click(); await flush(); assert.equal(sdk.transfers.length, 0); assert.equal(h.confirmations.length, 1);
    controls(h).transfer.click(); assert.equal(sdk.transfers.length, 1);
  });
}
for (const outcome of ['resolve', 'reject'] as const) it(`sent transfer keeps whole-list lock through disappearance, replacement and reconnect until ${outcome}`, async t => {
  const { h, sdk } = await app(t), old = controls(h); h.node('stage-management').open = true;
  old.transfer.click(); const work = sdk.transfers[0]!.work; snapshot(sdk, [person('second')]);
  stageLocked(h); force(controls(h).transfer); force(controls(h).remove); snapshot(sdk); const fresh = controls(h);
  assert.notEqual(fresh.node, old.node); force(old.transfer); force(fresh.transfer); stageLocked(h);
  sdk.setStatus('reconnecting'); sdk.setStatus('live'); stageLocked(h); assert.equal(h.node('stage-management').open, true);
  sdk.emit('error', new Error('new independent error')); if (outcome === 'resolve') work.resolve(); else work.reject('obsolete error'); await flush();
  notice(h, 'new independent error'); assert.equal(fresh.transfer.disabled, false); fresh.transfer.click(); assert.equal(sdk.transfers.length, 2);
});
for (const boundary of ['role', 'room', 'participant', 'missing state', 'disconnected', 'closed', 'kicked', 'leave', 'new entry'] as const)
  for (const outcome of ['resolve', 'reject'] as const) it(`${boundary} retires exact transfer owner; late ${outcome} cannot release or overwrite new tenure`, async t => {
    const { h, sdk } = await app(t), old = controls(h); h.node('stage-management').open = true; old.transfer.click(); const work = sdk.transfers[0]!.work;
    if (boundary === 'role') snapshot(sdk, [], { me: { role: 'audience' } });
    else if (boundary === 'room') snapshot(sdk, [], { roomId: 'other-room' });
    else if (boundary === 'participant') snapshot(sdk, [], { me: { participantId: 'other-controller' } });
    else if (boundary === 'missing state') { sdk.state = null; sdk.emit('status', sdk.status); }
    else if (boundary === 'disconnected') sdk.setStatus('disconnected');
    else if (boundary === 'closed') sdk.emit('closed', { reason: 'closed' });
    else if (boundary === 'kicked') sdk.emit('kicked', {});
    else if (boundary === 'leave') h.leave.click(); else h.form.submit();
    assert.equal(old.transfer.disabled, true); assert.equal(h.node('stage-management').open, false);
    let next = sdk;
    if (['disconnected', 'closed', 'kicked', 'leave', 'new entry'].includes(boundary)) {
      if (boundary === 'new entry') { await flush(); next = h.clients.at(-1)!; next.snapshot({ role: 'controller' }); }
      else next = await h.join({ role: 'controller' });
    } else { sdk.snapshot({ role: 'controller', connected: true }); }
    snapshot(next); const fresh = controls(h); fresh.transfer.click(); stageLocked(h);
    next.emit('error', new Error('new tenure error')); force(old.transfer);
    for (const [, event, detail] of notifications) if (next !== sdk) sdk.emit(event, detail);
    if (outcome === 'resolve') work.resolve(); else work.reject('old tenure error'); await flush(); stageLocked(h);
    notice(h, 'new tenure error'); assert.equal(next.transfers.at(-1)!.work.settled, false);
    next.transfers.at(-1)!.work.resolve(); await flush(); assert.equal(fresh.transfer.disabled, false);
  });
for (const boundary of ['role', 'room', 'participant', 'leave', 'closed'] as const)
  it(`${boundary} retirement inside confirmation cannot dispatch from old captured row`, async t => {
    let mutate = () => {};
    const { h, sdk } = await app(t, { confirm: () => { mutate(); return true; } });
    mutate = () => {
      if (boundary === 'leave') h.leave.click(); else if (boundary === 'closed') sdk.emit('closed', { reason: 'closed' });
      else { snapshot(sdk, [], boundary === 'role' ? { me: { role: 'audience' } } : boundary === 'room' ? { roomId: 'other' } : { me: { participantId: 'other' } });
        sdk.snapshot({ role: 'controller' }); snapshot(sdk); }
    };
    controls(h).transfer.click(); await flush(); assert.equal(sdk.transfers.length, 0);
  });

it('hidden connected duplicate cannot lend transfer eligibility to visible offline same-ID row', async t => {
  const { h, sdk } = await app(t); snapshot(sdk, [person('first', { connected: false }), person('first', { connected: true })]);
  const r = controls(h); assert.equal(r.transfer.disabled, true); force(r.transfer);
  assert.equal(h.confirmations.length, 0); assert.equal(sdk.transfers.length, 0); r.mute.click(); assert.equal(sdk.stageModerations.length, 1);
});
it('confirmation name uses same first valid speaker as rendered row after excluded same-ID entry', async t => {
  const { h, sdk } = await app(t); snapshot(sdk, [person('first', { role: 'audience', name: 'excluded name' }), person('first', { name: 'visible name' })]);
  controls(h).transfer.click(); assert.match(h.confirmations[0]!, /visible name/); assert.doesNotMatch(h.confirmations[0]!, /excluded name/);
  assert.equal(sdk.transfers[0]!.id, 'first');
});

async function setup(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; });
  const server = harness(config), host = await server.create('Synthetic host');
  const h = await actualApp(t, { confirm: () => true });
  let serverWork = Promise.resolve(), requestNo = 0;
  const validated: ClientMessage[] = [], incoming: ServerMessage[] = [];
  const sessions = new Map<StageSocket, Session>();
  let holdStageAck = false;
  let beforeTransfer: (() => Promise<void>) | undefined;
  const closes: { code: number | undefined }[] = [];
  const originalClose = StageSocket.prototype.close;
  t.mock.method(StageSocket.prototype, 'close', function (this: StageSocket, code?: number) {
    closes.push({ code }); originalClose.call(this);
    const session = sessions.get(this);
    if (session) serverWork = serverWork.then(() => server.hub.detach(session, code === 1000));
  });
  const heldAcks: ServerMessage[] = [];
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this);
    assert.ok(session); this.sent.push(message); validated.push(message);
    serverWork = serverWork.then(async () => {
      if (message.type === 'control:transfer') await beforeTransfer?.();
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
      if (holdStageAck && message.type === 'ok' && validated.some(request =>
        request.type === 'control:transfer' && request.requestId === message.requestId)) {
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
  return { config, server, host, h, client, pid, socket, session, validated, incoming, req, flushStates, command, approveUI, transfer, applicant, sdkApplicant, transferUI,
    drain: async () => { await serverWork; await flush(); }, holdAck: () => { holdStageAck = true; }, heldAcks, closes, beforeTransfer: (work: () => Promise<void>) => { beforeTransfer = work; } };
}

const counts = (f: Awaited<ReturnType<typeof setup>>) => ({ captures: f.h.captures.length, peers: StagePeer.instances.length,
  offers: StagePeer.instances.map(peer => peer.offers.length), plays: f.h.audio.plays, clients: f.h.clients.length, sockets: StageSocket.instances.length });
const hubRow = (f: Awaited<ReturnType<typeof setup>>, id: string) => {
  const i = f.client.state!.speakers.filter(p => p.participantId !== f.pid && p.role === 'speaker' && p.onStage).findIndex(p => p.participantId === id);
  assert.ok(i >= 0); const node = f.h.node('stage-management-list').children[i]!; assert.ok(node); return node;
};

for (const onStage of [false, true]) it(`generated confirmed UI hands off from onStage=${onStage} embed controller, preserving both actual SDK participants and media without reconnect`, async t => {
  const f = await setup(t); await f.transfer(); const target = await f.sdkApplicant('Connected selected speaker'); await f.approveUI(target.id);
  await f.h.until(() => target.peer.transceiver.sender.track !== null, 'target microphone'); await f.h.tick(200); await f.drain();
  if (onStage) {
    f.h.stage.click(); await f.h.tick(200); await f.drain();
    await f.h.until(() => StagePeer.instances[0]!.transceiver.sender.track !== null, 'outgoing controller microphone');
    await f.h.tick(200); await f.drain();
  }
  const state = f.client.state!, targetState = target.client.state!, before = counts(f), targetPlays = target.audio.plays;
  const outgoingPeer = StagePeer.instances[0]!, outgoingTrack = outgoingPeer.transceiver.sender.track, targetTrack = target.peer.transceiver.sender.track;
  const room = f.server.transport.rooms.get(f.host.roomId)!, targetServerPeer = room.peers.get(target.id), outgoingServerPeer = room.peers.get(f.pid);
  assert.ok(state.audience); assert.equal(state.code, f.host.code); assert.equal(f.client.me!.onStage, onStage);
  await f.transferUI(target.id); assert.equal(f.h.confirmations.length, 1);
  assert.equal(f.client.me!.participantId, f.pid); assert.equal(f.client.state!.roomId, state.roomId); assert.equal(f.client.state!.resumeToken, state.resumeToken);
  assert.equal(f.client.me!.role, onStage ? 'speaker' : 'audience'); assert.equal(f.client.me!.onStage, onStage); assert.equal(f.client.state!.audience, undefined); assert.equal(f.client.state!.code, undefined);
  assert.equal(target.client.me!.participantId, target.id); assert.equal(target.client.me!.role, 'controller'); assert.equal(target.client.me!.onStage, true);
  assert.equal(target.client.state!.resumeToken, targetState.resumeToken); assert.ok(target.client.state!.audience); assert.equal(target.client.state!.code, f.host.code);
  assert.equal(f.h.node('stage-management').hidden, true); assert.equal(f.h.node('hand-queue').hidden, true); assert.equal(f.h.node('room-name-panel').hidden, true);
  assert.equal(f.client.status, 'live'); assert.equal(target.client.status, 'live'); assert.equal(f.socket.readyState, StageSocket.OPEN); assert.equal(target.socket.readyState, StageSocket.OPEN);
  assert.equal(StagePeer.instances[0], outgoingPeer); assert.equal(outgoingPeer.transceiver.sender.track, outgoingTrack); assert.equal(target.peer.transceiver.sender.track, targetTrack);
  assert.equal(room.peers.get(target.id), targetServerPeer); assert.equal(room.peers.get(f.pid), outgoingServerPeer);
  assert.equal(room.publishers.has(target.id), true); assert.equal(room.publishers.has(f.pid), onStage);
  assert.deepEqual(counts(f), before); assert.equal(target.audio.plays, targetPlays); assert.equal(targetTrack!.stopped, false);
  assert.equal(f.validated.filter(m => m.type === 'control:transfer').length, 1);
  assert.deepEqual(await f.command('forceMute', target.id), { ok: false, code: 'forbidden' });
  assert.equal(await f.req(target.s, { type: 'mic:force-mute', targetId: f.host.id }), 'ok');
});


it('generated transfer notification fences stale controller eligibility before state; held ACK never restores retired panel', async t => {
  const f = await setup(t), target = await f.applicant('Next controller'); await f.transfer(); await f.approveUI(target.id); f.holdAck();
  const observations: { event: string; role: string | undefined; panel: boolean }[] = [];
  const old = controls(f.h, f.client.state!.speakers.findIndex(p => p.participantId === target.id));
  f.client.on('transferred', () => {
    observations.push({ event: 'transferred', role: f.client.me?.role, panel: !f.h.node('stage-management').hidden });
    stageLocked(f.h); force(old.transfer); force(old.mute);
  });
  f.client.on('state', () => observations.push({ event: 'state', role: f.client.me?.role, panel: !f.h.node('stage-management').hidden }));
  let settled = false; const transfer = f.client.transferControl.bind(f.client);
  t.mock.method(f.client, 'transferControl', async (id: string) => { await transfer(id); settled = true; });
  await f.transferUI(target.id);
  assert.deepEqual(observations.slice(0, 2), [{ event: 'transferred', role: 'controller', panel: true }, { event: 'state', role: 'audience', panel: false }]);
  assert.equal(f.client.me!.role, 'audience'); assert.equal(settled, false); assert.equal(f.heldAcks.length, 1);
  assert.equal(f.validated.filter(m => m.type === 'control:transfer').length, 1); assert.equal(f.h.confirmations.length, 1);
  f.socket.deliver(f.heldAcks[0]!); await flush(); assert.equal(settled, true); assert.equal(f.h.node('stage-management').hidden, true);
  assert.equal(old.transfer.disabled, true);
});
it('actual target offline disables generated handoff while moderator may still manage retained seat; direct host SDK calls retain server arbitration', async t => {
  const f = await setup(t), target = await f.applicant('Retained offline speaker'); await f.transfer(); await f.approveUI(target.id);
  await f.server.hub.detach(target.s); await f.flushStates();
  const buttons = hubRow(f, target.id).children[1]!.children;
  assert.equal(buttons[2]!.disabled, true); force(buttons[2]!); assert.equal(f.h.confirmations.length, 0);
  assert.equal(buttons[0]!.disabled, false); assert.equal(buttons[1]!.disabled, false);
  buttons[0]!.click(); await f.h.tick(200); await f.drain();
  assert.equal(f.client.state!.speakers.find(p => p.participantId === target.id)!.forceMuted, true);
  const before = counts(f); assert.deepEqual(await f.command('transferControl', target.id), { ok: false, code: 'conflict' });
  assert.deepEqual(await f.command('transferControl', f.pid), { ok: false, code: 'conflict' });
  assert.deepEqual(await f.command('transferControl', 'nonexistent-participant'), { ok: false, code: 'not_found' });
  assert.equal(f.client.me!.role, 'controller'); assert.equal(f.client.state!.controllerId, f.pid); assert.deepEqual(counts(f), before);
});
it('generated transfer submitted to a speaker can reach now-audience target when stage departure occurs before Hub processing', async t => {
  const f = await setup(t), target = await f.applicant('Changing target'); await f.transfer(); await f.approveUI(target.id);
  f.beforeTransfer(async () => {
    assert.equal(f.validated.filter(m => m.type === 'control:transfer').length, 1);
    assert.equal(f.client.state!.speakers.some(p => p.participantId === target.id), true);
    assert.equal(await f.req(target.s, { type: 'stage:leave' }), 'ok');
    assert.equal(f.client.state!.speakers.some(p => p.participantId === target.id), false);
  });
  await f.transferUI(target.id); assert.equal(f.h.confirmations.length, 1);
  assert.equal(target.s.last('room:state')!.me.role, 'controller'); assert.equal(target.s.last('room:state')!.me.onStage, false);
  assert.equal(f.client.me!.role, 'audience');
});
it('sender authority loss after generated transfer submission follows existing forbidden error path with no retry', async t => {
  const f = await setup(t), target = await f.applicant('Selected target'); await f.transfer(); await f.approveUI(target.id);
  f.beforeTransfer(async () => {
    await f.server.hub.handle(f.session, { type: 'control:transfer', targetId: f.host.id, requestId: 'external-authority-change' });
    assert.equal(f.client.me!.role, 'audience');
  });
  await f.transferUI(target.id);
  const transfer = f.validated.find(m => m.type === 'control:transfer')!;
  assert.ok(f.incoming.some(m => m.type === 'error' && m.requestId === transfer.requestId && m.code === 'forbidden'));
  assert.equal(f.client.state!.controllerId, f.host.id); assert.equal(target.s.last('room:state')!.me.role, 'speaker');
  assert.equal(f.validated.filter(m => m.type === 'control:transfer').length, 1); assert.equal(f.h.node('stage-management').hidden, true);
  assert.equal(f.h.node('error-notice').hidden, false, 'existing SDK global error forwarding remains visible');
});
for (const selfMuted of [false, true]) for (const forceMuted of [false, true])
  it(`generated handoff preserves actual target SDK selfMute=${selfMuted} forceMute=${forceMuted} and track`, async t => {
    const f = await setup(t); await f.transfer(); const target = await f.sdkApplicant('Muted next host'); await f.approveUI(target.id);
    await f.h.until(() => target.peer.transceiver.sender.track !== null, 'target microphone'); await f.h.tick(200); await f.drain();
    if (selfMuted) { const mute = target.client.mute(); await f.h.tick(200); await f.drain(); await mute; }
    if (forceMuted) assert.deepEqual(await f.command('forceMute', target.id), { ok: true });
    const track = target.peer.transceiver.sender.track!, before = counts(f), enabled = track.enabled;
    await f.transferUI(target.id); assert.equal(f.h.confirmations.length, 1);
    assert.equal(target.client.me!.role, 'controller'); assert.equal(target.client.me!.forceMuted, forceMuted);
    assert.equal(target.client.me!.muted, selfMuted || forceMuted); assert.equal(target.peer.transceiver.sender.track, track);
    assert.equal(track.enabled, enabled); assert.equal(track.stopped, false); assert.deepEqual(counts(f), before);
  });
it('explicit Leave remains separate after UI handoff and does not subject new controller to old-controller grace', async t => {
  const f = await setup(t), target = await f.applicant('Chosen successor'); await f.transfer(); await f.approveUI(target.id);
  await f.transferUI(target.id); assert.equal(f.socket.readyState, StageSocket.OPEN); assert.equal(f.closes.length, 0);
  f.h.leave.click(); await f.drain(); await f.flushStates();
  assert.equal(f.closes.at(-1)?.code, 1000); assert.equal(f.client.status, 'disconnected');
  assert.equal(target.s.last('room:state')!.controllerId, target.id); assert.equal(target.s.last('room:state')!.me.role, 'controller');
  assert.equal(await f.req(target.s, { type: 'mic:force-mute', targetId: f.host.id }), 'ok');
});

// Synthetic synchronous DOM write hooks exercise dispatch guards; native DOM writes
// themselves are not claimed to invoke these callbacks.
for (const change of ['role', 'room', 'participant', 'reconnecting', 'target', 'method', 'row', 'button'] as const)
  it(`reserve-time ${change} mutation blocks obsolete transfer before confirmation opens`, async t => {
    const { h, sdk } = await app(t), r = controls(h); let fired = false;
    const setAttribute = r.transfer.setAttribute.bind(r.transfer);
    r.transfer.setAttribute = (key, value) => {
      setAttribute(key, value); if (fired || key !== 'aria-busy' || value !== 'true') return; fired = true;
      if (change === 'role') snapshot(sdk, undefined, { me: { role: 'audience' } }, false);
      else if (change === 'room') snapshot(sdk, undefined, { roomId: 'replacement-room' }, false);
      else if (change === 'participant') snapshot(sdk, undefined, { me: { participantId: 'replacement-controller' } }, false);
      else if (change === 'reconnecting') sdk.status = 'reconnecting';
      else if (change === 'target') snapshot(sdk, [], {}, false);
      else if (change === 'method') Reflect.set(sdk, 'transferControl', undefined);
      else if (change === 'row') r.node.remove(); else r.transfer.remove();
    };
    sdk.emit('error', new Error('reserve error retained')); r.transfer.click(); await flush();
    assert.equal(fired, true); assert.equal(h.confirmations.length, 0); assert.equal(sdk.transfers.length, 0); notice(h, 'reserve error retained');
  });
it('stage moderation reserves its token before a synchronous SDK callback can request any transfer', async t => {
  const { h, sdk } = await app(t); const mute = sdk.forceMute.bind(sdk);
  sdk.forceMute = id => { force(controls(h).transfer); force(controls(h, 1).transfer); return mute(id); };
  controls(h).mute.click(); assert.equal(sdk.stageModerations.length, 1); assert.equal(sdk.transfers.length, 0); assert.equal(h.confirmations.length, 0);
});
for (const outcome of ['resolve', 'reject'] as const) it(`transfer ${outcome} with no original row releases global reservation for later fresh rows`, async t => {
  const { h, sdk } = await app(t); controls(h).transfer.click(); const work = sdk.transfers[0]!.work;
  snapshot(sdk, []); sdk.emit('error', new Error('latest error')); if (outcome === 'resolve') work.resolve(); else work.reject('obsolete missing-row error'); await flush();
  snapshot(sdk); notice(h, 'latest error'); controls(h).transfer.click(); assert.equal(sdk.transfers.length, 2);
});
it('actual SDK confirmation safely decodes server name once and sends the ID of the rendered target', async t => {
  const f = await setup(t), target = await f.applicant('<img src=x> &lt;literal&gt;'); await f.transfer(); await f.approveUI(target.id);
  await f.transferUI(target.id);
  assert.equal(f.h.confirmations[0], '確定將控制權移交給 <img src=x> &lt;literal&gt;？你將失去主控權限，但保留目前台位並留在房間。');
  const request = f.validated.find(m => m.type === 'control:transfer'); assert.ok(request?.type === 'control:transfer'); assert.equal(request.targetId, target.id);
});
