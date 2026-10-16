import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ClientMessage, ParticipantView, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { Deferred, embedApp, flush, type EmbedNode, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket, StagePeer } from './fixtures/embedSdkApp.ts';
import { harness, testConfig, FakeSession } from './helpers.ts';

// Entire embed module, with controlled DOM/SDK boundaries first and actual SDK/Hub below.
// These checks do not claim native details, focus, keyboard, AT, device or audible-media validation.
type View = { node(id: string): EmbedNode };
const panel = (h: View) => h.node('hand-queue');
const list = (h: View) => h.node('hand-queue-list');
const summary = (h: View) => h.node('hand-queue-summary').textContent;
function row(h: View, index = 0) {
  const node = list(h).children[index]; assert.ok(node, `hand row ${index}`);
  const name = node.children[0], actions = node.children[1]; assert.ok(name); assert.ok(actions);
  const approve = actions.children[0], reject = actions.children[1]; assert.ok(approve); assert.ok(reject);
  return { node, name, actions, approve, reject };
}
const person = (id: string, patch: Partial<ParticipantView> = {}): ParticipantView => ({
  participantId: id, name: id, role: 'audience', onStage: false, handRaised: true, muted: false,
  forceMuted: false, connected: true, gainDb: 0, joinedAt: 0, ...patch,
});
function snapshot(sdk: EmbedSdk, hands: ParticipantView[] = [person('first'), person('second')],
  patch: { roomId?: string; me?: Partial<ParticipantView> } = {}, emit = true): void {
  assert.ok(sdk.state); assert.ok(sdk.me);
  sdk.state = { ...sdk.state, ...patch, hands, me: { ...sdk.me, ...patch.me } }; sdk.me = sdk.state.me;
  if (emit) sdk.emit('state', sdk.state);
}
function retired(h: View): void {
  assert.equal(panel(h).hidden, true); assert.equal(panel(h).open, false);
  assert.equal(list(h).children.length, 0); assert.equal(summary(h), '');
  assert.equal(h.node('hand-queue-notice').textContent, '');
}
function locked(buttons: ReturnType<typeof row>, pending = true, disabled = pending): void {
  for (const button of [buttons.approve, buttons.reject]) {
    assert.equal(button.disabled, disabled); assert.equal(button.attributes['aria-busy'], String(pending));
  }
}
function force(button: EmbedNode): void { button.disabled = false; button.invoke(); }
function notice(h: View, text: string): void {
  assert.equal(h.node('error-notice').hidden, false); assert.equal(h.node('last-error').textContent, `最近錯誤：${text}`);
}
async function app(t: TestContext, onStage = false) {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage });
  snapshot(sdk); return { h, sdk };
}

it('authored embed hand panel is native, initially hidden, labeled and outside the join form', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
  const details = html.match(/<details\b[^>]*id="hand-queue"[^>]*>[\s\S]*?<\/details>/)?.[0]; assert.ok(details);
  assert.match(details, /^<details\b[^>]*\bhidden(?:\s|>)/); assert.doesNotMatch(details, /\bopen(?:\s|>)/);
  assert.match(details, /<summary id="hand-queue-summary">舉手申請（0）<\/summary>/);
  assert.match(details, /<ul id="hand-queue-list" class="people" aria-label="舉手申請"><\/ul>/);
  assert.ok(html.indexOf(details) > html.indexOf('</form>'));
  for (const id of ['hand-queue', 'hand-queue-summary', 'hand-queue-notice', 'hand-queue-list']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1);
  }
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});

it('whole embed keeps hand management absent before entry, during loading, and before first snapshot', async t => {
  const gate = new Deferred(), h = embedApp({ libraryLoad: gate.promise });
  t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  retired(h); h.form.submit(); await flush(); retired(h); gate.resolve(); await flush(); retired(h);
  h.clients[0]!.snapshot({ role: 'controller' }); assert.equal(panel(h).hidden, false);
  assert.equal(summary(h), '舉手申請（0）'); assert.equal(h.node('hand-queue-notice').textContent, '目前沒有舉手申請。');
});

for (const [role, onStage] of [['audience', false], ['speaker', true]] as const) {
  it(`whole embed ${role} cannot see or operate controller hands`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role, onStage }); snapshot(sdk);
    retired(h); assert.equal(sdk.moderations.length, 0); assert.equal(h.node('rename').hidden, false);
  });
}
for (const onStage of [false, true]) for (const status of ['waiting', 'live'] as const) {
  it(`whole embed controller onStage=${onStage} status=${status} sees ordered safe names and explicit controls`, async t => {
    const { h, sdk } = await app(t, onStage); sdk.setStatus(status);
    snapshot(sdk, [person('a', { name: '<img src=x onerror=bad>' }), person('b', { name: '<img src=x onerror=bad>', connected: false })]);
    assert.equal(panel(h).hidden, false); assert.equal(summary(h), '舉手申請（2）');
    assert.equal(row(h).name.textContent, '<img src=x onerror=bad>'); assert.equal(row(h, 1).name.textContent, '<img src=x onerror=bad>（暫時離線）');
    for (const i of [0, 1]) {
      const r = row(h, i); assert.equal(r.node.tagName, 'LI'); assert.equal(r.name.tagName, 'SPAN');
      assert.equal(r.approve.type, 'button'); assert.equal(r.reject.type, 'button');
      assert.equal(r.approve.textContent, '核准上台'); assert.equal(r.reject.textContent, '婉拒');
      assert.equal(r.approve.attributes['aria-label'], '核准 <img src=x onerror=bad> 上台');
      assert.equal(r.reject.attributes['aria-label'], '婉拒 <img src=x onerror=bad> 的舉手申請'); locked(r, false);
    }
    row(h).approve.click(); row(h, 1).reject.click();
    assert.deepEqual(sdk.moderations.map(({ kind, id }) => [kind, id]), [['approve', 'a'], ['reject', 'b']]);
  });
}

it('whole embed deduplicates IDs, filters invalid hands, and preserves offline queue order', async t => {
  const { h, sdk } = await app(t);
  snapshot(sdk, [person('a'), person('a', { name: 'duplicate' }), person('stage', { onStage: true }),
    person('speaker', { role: 'speaker' }), person('down', { handRaised: false }), person('b', { connected: false })]);
  assert.equal(summary(h), '舉手申請（2）'); assert.deepEqual(list(h).children.map(node => node.children[0]!.textContent), ['a', 'b（暫時離線）']);
  row(h, 1).approve.click(); assert.equal(sdk.moderations[0]!.id, 'b', 'offline approval remains server-authoritative');
});

it('whole embed keeps keyed nodes and open state through names, order, personal stage and unrelated snapshots', async t => {
  const { h, sdk } = await app(t); const a = row(h), b = row(h, 1); panel(h).open = true;
  for (let i = 0; i < 4; i++) snapshot(sdk, [person('first'), person('second')], { me: { onStage: i % 2 === 0 } });
  assert.equal(row(h).node, a.node); assert.equal(row(h, 1).node, b.node); assert.equal(panel(h).open, true);
  snapshot(sdk, [person('second', { name: 'renamed' }), person('first')]);
  assert.equal(row(h).node, b.node); assert.equal(row(h, 1).node, a.node); assert.equal(row(h).name.textContent, 'renamed');
  assert.equal(row(h).approve.attributes['aria-label'], '核准 renamed 上台'); assert.equal(panel(h).open, true);
});

it('whole embed shares a per-ID approve/reject lock while different targets remain independent', async t => {
  const { h, sdk } = await app(t); const a = row(h), b = row(h, 1);
  sdk.emit('error', new Error('unrelated failure')); a.approve.click(); locked(a); locked(b, false); notice(h, 'unrelated failure');
  a.approve.click(); a.reject.click(); force(a.approve); force(a.reject); assert.equal(sdk.moderations.length, 1);
  b.reject.click(); assert.equal(sdk.moderations.length, 2); locked(b);
  snapshot(sdk); locked(a); locked(b); sdk.moderations[0]!.work.resolve(); await flush(); locked(a, false); locked(b);
  assert.equal(list(h).children.length, 2, 'ACK never optimistically removes an authoritative hand'); notice(h, 'unrelated failure');
});

it('whole embed reserves target ownership before a synchronous SDK callback can reenter either action', async t => {
  const { h, sdk } = await app(t), a = row(h), original = sdk.approve.bind(sdk);
  sdk.approve = id => { force(a.approve); force(a.reject); snapshot(sdk); force(a.reject); return original(id); };
  a.approve.click(); assert.equal(sdk.moderations.length, 1); locked(a);
});

for (const outcome of ['throw', 'reject'] as const) {
  it(`whole embed current ${outcome} reports and unlocks for an explicit rejection`, async t => {
    const { h, sdk } = await app(t), a = row(h);
    if (outcome === 'throw') sdk.approve = () => { throw new Error('current failure'); };
    a.approve.click(); if (outcome === 'reject') sdk.moderations[0]!.work.reject('current failure'); await flush();
    notice(h, 'current failure'); locked(a, false); a.reject.click(); assert.equal(sdk.moderations.at(-1)!.kind, 'reject'); locked(a);
    sdk.moderations.at(-1)!.work.resolve(); await flush(); notice(h, 'current failure'); locked(a, false);
  });
}

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed disappeared/reappeared ID keeps pending until ${outcome}; old row feedback and clicks stay retired`, async t => {
    const { h, sdk } = await app(t), old = row(h); old.approve.click(); const pending = sdk.moderations[0]!.work;
    snapshot(sdk, [person('second')]); assert.equal(old.node.parentElement, null); force(old.reject); assert.equal(sdk.moderations.length, 1);
    snapshot(sdk); const replacement = row(h); assert.notEqual(replacement.node, old.node); locked(replacement);
    force(replacement.approve); force(old.approve); assert.equal(sdk.moderations.length, 1);
    sdk.emit('error', new Error('new independent failure'));
    if (outcome === 'resolve') pending.resolve(); else pending.reject('obsolete row failure'); await flush();
    locked(replacement, false); notice(h, 'new independent failure'); assert.equal(sdk.moderations.length, 1);
    replacement.reject.click(); locked(replacement); force(old.reject); assert.equal(sdk.moderations.length, 2);
  });
}

for (const detach of ['row', 'button'] as const) {
  it(`whole embed detached ${detach} cannot use a retained callback or forged disabled value`, async t => {
    const { h, sdk } = await app(t), a = row(h); (detach === 'row' ? a.node : a.approve).remove();
    force(a.approve); assert.equal(sdk.moderations.length, 0);
  });
}
for (const kind of ['approve', 'reject'] as const) {
  it(`whole embed safely handles initially absent and later removed SDK ${kind}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup());
    const sdk = await h.join({ role: 'controller' }); Reflect.set(sdk, kind, undefined); snapshot(sdk);
    const a = row(h); assert.equal(a[kind].disabled, true); force(a[kind]); assert.equal(sdk.moderations.length, 0);
    const other = kind === 'approve' ? 'reject' : 'approve'; a[other].click(); assert.equal(sdk.moderations.length, 1);
    sdk.moderations[0]!.work.resolve(); await flush();
    Reflect.set(sdk, kind, (id: string) => Promise.resolve().then(() => { assert.equal(id, 'first'); })); snapshot(sdk); assert.equal(a[kind].disabled, false);
    Reflect.set(sdk, kind, undefined); force(a[kind]); assert.equal(sdk.moderations.length, 1);
  });
}

it('whole embed same-seat reconnect retains list, open choice and pending until promise settlement', async t => {
  const { h, sdk } = await app(t), a = row(h); panel(h).open = true; a.approve.click();
  sdk.setStatus('reconnecting'); assert.equal(row(h).node, a.node); assert.equal(panel(h).open, true);
  assert.equal(summary(h), '舉手申請（2） · 上次收到'); locked(a); locked(row(h, 1), false, true);
  force(a.reject); force(row(h, 1).reject); assert.equal(sdk.moderations.length, 1);
  sdk.setStatus('live'); snapshot(sdk); locked(a); locked(row(h, 1), false); assert.equal(panel(h).open, true);
  sdk.moderations[0]!.work.resolve(); await flush(); locked(a, false);
});

it('whole embed pending failure during reconnect releases only its token and suppresses promise feedback', async t => {
  const { h, sdk } = await app(t); row(h).approve.click(); sdk.setStatus('reconnecting');
  sdk.emit('error', new Error('global SDK error stays visible')); sdk.moderations[0]!.work.reject('offline promise error'); await flush();
  locked(row(h), false, true); notice(h, 'global SDK error stays visible'); sdk.setStatus('live'); locked(row(h), false);
});

for (const identity of ['role', 'room', 'participant'] as const) {
  it(`whole embed reconnect cannot establish a new ${identity} owner`, async t => {
    const { h, sdk } = await app(t); sdk.setStatus('reconnecting');
    if (identity === 'role') { snapshot(sdk, [], { me: { role: 'audience' } }); snapshot(sdk, [person('first')], { me: { role: 'controller' } }); }
    else snapshot(sdk, [person('first')], identity === 'room' ? { roomId: 'new-room' } : { me: { participantId: 'new-controller' } });
    retired(h); sdk.setStatus('live'); assert.equal(panel(h).hidden, false); locked(row(h), false);
  });
}

for (const boundary of ['role', 'missing state', 'room', 'participant', 'leave', 'disconnected', 'closed', 'kicked', 'new entry'] as const)
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`whole embed ${boundary} retires old ownership; late ${outcome} cannot clear new pending or feedback`, async t => {
      const { h, sdk } = await app(t), old = row(h); panel(h).open = true; old.approve.click(); const work = sdk.moderations[0]!.work;
      let next = sdk;
      if (boundary === 'role') snapshot(sdk, [], { me: { role: 'audience' } });
      else if (boundary === 'missing state') { sdk.state = null; sdk.emit('status', sdk.status); }
      else if (boundary === 'room') snapshot(sdk, [], { roomId: 'other-room' });
      else if (boundary === 'participant') snapshot(sdk, [], { me: { participantId: 'other-controller' } });
      else if (boundary === 'leave') h.leave.click();
      else if (boundary === 'disconnected') sdk.setStatus('disconnected');
      else if (boundary === 'closed') sdk.emit('closed', { reason: 'closed' });
      else if (boundary === 'kicked') sdk.emit('kicked', {});
      else h.form.submit();
      assert.equal(old.approve.disabled, true); assert.equal(old.reject.disabled, true); assert.equal(panel(h).open, false);
      if (boundary === 'room' || boundary === 'participant') { assert.equal(panel(h).hidden, false); assert.equal(list(h).children.length, 0); }
      else retired(h);
      if (['leave', 'disconnected', 'closed', 'kicked', 'new entry'].includes(boundary)) {
        if (boundary === 'new entry') { await flush(); next = h.clients.at(-1)!; next.snapshot({ role: 'controller' }); }
        else next = await h.join({ role: 'controller' });
      } else if (boundary === 'missing state') sdk.snapshot({ role: 'controller' });
      else snapshot(sdk, [], { me: { role: 'controller' } });
      snapshot(next); const current = row(h); current.reject.click(); locked(current); panel(h).open = true;
      next.emit('error', new Error('new-owner failure')); const status = h.status.textContent;
      if (outcome === 'resolve') work.resolve(); else work.reject('retired failure'); await flush();
      assert.equal(row(h).node, current.node); locked(current); assert.equal(panel(h).open, true); notice(h, 'new-owner failure'); assert.equal(h.status.textContent, status);
      const count = next.moderations.length; force(old.approve); force(old.reject); assert.equal(next.moderations.length, count);
    });
  }

for (const boundary of ['role', 'room', 'participant', 'missing state', 'disconnected'] as const) {
  it(`whole embed click rechecks silent ${boundary} changes before admission`, async t => {
    const { h, sdk } = await app(t), old = row(h);
    if (boundary === 'missing state') sdk.state = null;
    else if (boundary === 'disconnected') sdk.status = 'disconnected';
    else snapshot(sdk, [person('first')], boundary === 'role' ? { me: { role: 'audience' } }
      : boundary === 'room' ? { roomId: 'changed' } : { me: { participantId: 'changed' } }, false);
    force(old.approve); assert.equal(sdk.moderations.length, 0);
  });
}

for (const boundary of ['role', 'leave', 'new entry'] as const) {
  it(`whole embed SDK synchronous ${boundary} callback cannot restore retired controls from its rejection`, async t => {
    const { h, sdk } = await app(t), old = row(h);
    sdk.approve = () => {
      if (boundary === 'role') snapshot(sdk, [], { me: { role: 'audience' } });
      else if (boundary === 'leave') h.leave.click(); else h.form.submit();
      return Promise.reject(new Error('retired callback failure'));
    };
    old.approve.click(); await flush(); retired(h); assert.equal(h.node('error-notice').hidden, true);
  });
}

it('whole embed cancelled replacement entry cannot revive retired hand callbacks or late promise feedback', async t => {
  const gate = new Deferred(), h = embedApp({ libraryLoad: async (_url, count) => { if (count === 2) await gate.promise; } });
  t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  const sdk = await h.join({ role: 'controller' }); snapshot(sdk); const old = row(h); old.reject.click();
  h.form.submit(); await flush(); h.node('cancel-join').click(); retired(h); const text = h.status.textContent;
  sdk.moderations[0]!.work.reject('old entry failure'); gate.resolve(); await flush();
  force(old.approve); retired(h); assert.equal(h.status.textContent, text); assert.equal(h.clients.length, 1);
});

it('whole embed event-only hand, role and transfer notifications never replace the authoritative queue', async t => {
  const { h, sdk } = await app(t), a = row(h); a.approve.click();
  sdk.emit('hand', { participantId: 'first', raised: false }); sdk.emit('role', { participantId: sdk.me!.participantId, role: 'audience' });
  sdk.emit('transferred', { fromId: sdk.me!.participantId, toId: 'elsewhere' });
  assert.equal(row(h).node, a.node); assert.equal(summary(h), '舉手申請（2）'); locked(a);
  row(h, 1).reject.click(); assert.equal(sdk.moderations.length, 2, 'unseen server state remains server-authoritative');
  assert.equal(h.clock.timers.length, 0); assert.equal(sdk.deviceLists.length, 0); assert.equal(sdk.inputSelections.length, 0);
  assert.equal(sdk.retryCalls, 0); assert.equal(sdk.actions.length, 0); assert.equal(sdk.renames.length, 0); assert.equal(sdk.roomRenames.length, 0);
});

for (const identity of ['empty', 'self'] as const) {
  it(`whole embed excludes ${identity} target IDs even from mutated authoritative hand arrays`, async t => {
    const { h, sdk } = await app(t); snapshot(sdk, [person(identity === 'empty' ? '' : sdk.me!.participantId), person('valid')]);
    assert.equal(summary(h), '舉手申請（1）'); assert.equal(row(h).name.textContent, 'valid');
    row(h).approve.click(); assert.equal(sdk.moderations[0]!.id, 'valid'); assert.equal(sdk.actions.length, 0);
  });
}

interface ControllerClient {
  readonly me: ParticipantView | null;
  readonly state: RoomStatePayload | null;
  transferControl(id: string): Promise<void>;
}
async function bridge(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; });
  const server = harness(config), host = await server.create('Synthetic host');
  const h = await actualApp(t);
  let serverWork = Promise.resolve(), requestNo = 0;
  const validated: ClientMessage[] = [], incoming: ServerMessage[] = [];
  const sessions = new Map<StageSocket, Session>();
  let holdStageAck = false, holdState = false;
  const heldStates: ServerMessage[] = [];
  const heldAcks: ServerMessage[] = [];
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this);
    assert.ok(session); this.sent.push(message); validated.push(message);
    serverWork = serverWork.then(() => server.hub.handle(session, message));
  });
  t.after(async () => { await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close(); });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic embed host';
  h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  const session: Session = {
    id: 'baseline-embed',
    send(message) {
      incoming.push(message);
      if (holdState && message.type === 'room:state') { heldStates.push(message); return; }
      if (holdStageAck && message.type === 'ok' && validated.some(request =>
        (request.type === 'stage:approve' || request.type === 'stage:reject') && request.requestId === message.requestId)) {
        heldAcks.push(message); return;
      }
      if (socket.readyState === StageSocket.OPEN) socket.deliver(message);
    },
    close() { socket.close(); },
  };
  sessions.set(socket, session); server.hub.attach(session);
  await h.until(() => h.clients[0]?.me !== null && h.clients[0]?.me !== undefined, 'actual SDK joined');
  await h.tick(200); await serverWork; await flush();
  const client = h.clients[0] as unknown as ControllerClient;
  assert.equal(client.me?.role, 'audience'); assert.equal(client.me?.onStage, false);
  assert.equal(StageSocket.instances.length, 1); assert.equal(StagePeer.instances.length, 1);
  assert.equal(server.hub.isJoined(session), true);
  const pid = client.me!.participantId;
  const req = async (actor: FakeSession, message: Omit<ClientMessage, 'requestId'> & Record<string, unknown>) => {
    const requestId = `baseline-setup-${++requestNo}`;
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
  const command = async (kind: 'approve' | 'reject', id: string) => {
    const index = client.state!.hands.findIndex(person => person.participantId === id); assert.ok(index >= 0);
    const before = validated.length; row(h, index)[kind].click();
    await h.tick(200); await serverWork; await flush();
    const request = validated.slice(before).find(message => message.type === `stage:${kind}`);
    assert.ok(request && (request.type === 'stage:approve' || request.type === 'stage:reject'));
    const reply = incoming.find(message => (message.type === 'ok' || message.type === 'error') && message.requestId === request.requestId);
    assert.ok(reply && (reply.type === 'ok' || reply.type === 'error'));
    return reply.type === 'ok' ? { ok: true as const } : { ok: false as const, code: reply.code };
  };
  const transfer = async () => {
    assert.equal(await req(host.s, { type: 'control:transfer', targetId: pid }), 'ok'); await flush();
    assert.equal(client.me?.role, 'controller'); assert.equal(client.me?.onStage, false);
    assert.equal(h.node('room-name-panel').hidden, false);
    assert.equal(h.node('hand').disabled, true);
    assert.equal(h.stage.textContent, '返回舞台'); assert.equal(panel(h).hidden, false);
  };
  const applicant = async (name: string) => {
    const s = new FakeSession(); server.hub.attach(s);
    assert.equal(await req(s, { type: 'join', roomId: host.roomId, code: host.code, name }), 'ok');
    const person = { s, id: s.last('room:state')!.me.participantId };
    assert.equal(await req(person.s, { type: 'hand:raise' }), 'ok'); await flushStates(); return person;
  };
  return { config, server, host, h, client, pid, socket, session, validated, incoming, req, flushStates, command, transfer, applicant,
    drain: async () => { await serverWork; await flush(); }, holdAck: () => { holdStageAck = true; }, heldAcks,
    holdStates: () => { holdState = true; },
    releaseStates: () => { holdState = false; for (const message of heldStates.splice(0)) socket.deliver(message); } };
}
it('manual audience-to-controller transfer exposes authoritative hands; actual generated buttons approve and reject', async t => {
  const f = await bridge(t);
  const first = await f.applicant('A <img src=x> & name'), second = await f.applicant('A <img src=x> & name');
  await f.transfer();
  assert.deepEqual(f.client.state!.hands.map(person => person.participantId), [first.id, second.id]);
  assert.equal(f.client.state!.hands[0]!.name, 'A &lt;img src=x&gt; &amp; name');
  const captures = f.h.captures.length, peers = StagePeer.instances.length, plays = f.h.audio.plays;
  assert.deepEqual(await f.command('approve', first.id), { ok: true });
  assert.equal(first.s.last('room:state')!.me.onStage, true);
  assert.equal(first.s.last('room:state')!.me.role, 'speaker');
  assert.deepEqual(f.client.state!.hands.map(person => person.participantId), [second.id]);
  assert.deepEqual(await f.command('reject', second.id), { ok: true });
  assert.equal(second.s.last('room:state')!.me.handRaised, false);
  assert.equal(second.s.last('hand:rejected')!.participantId, second.id);
  assert.deepEqual(f.client.state!.hands, []);
  assert.equal(f.client.me!.onStage, false); assert.equal(f.client.me!.role, 'controller');
  assert.equal(f.h.captures.length, captures); assert.equal(StagePeer.instances.length, peers); assert.equal(f.h.audio.plays, plays);
  assert.equal(f.validated.filter(message => message.type === 'stage:approve').length, 1);
  assert.equal(f.validated.filter(message => message.type === 'stage:reject').length, 1);
});

it('controller grace expiry can give the same joined embed audience control and generated controls work', async t => {
  const f = await bridge(t), target = await f.applicant('Waiting participant');
  assert.equal(await f.req(f.host.s, { type: 'stage:leave' }), 'ok');
  await f.server.hub.detach(f.host.s);
  const expiry = f.server.timers.find(timer => !timer.cleared && timer.ms === f.config.rooms.controllerGraceMs);
  assert.ok(expiry); f.server.clock.now += f.config.rooms.controllerGraceMs; expiry.cleared = true; expiry.fn();
  await nextTurn(); await flush();
  assert.equal(f.client.me!.role, 'controller'); assert.equal(f.client.me!.onStage, false);
  assert.equal(f.client.me!.participantId, f.pid); assert.equal(f.client.state!.controllerId, f.pid);
  assert.deepEqual(f.client.state!.hands.map(person => person.participantId), [target.id]);
  assert.equal(f.h.node('room-name-panel').hidden, false);
  assert.deepEqual(await f.command('approve', target.id), { ok: true });
  assert.equal(target.s.last('room:state')!.me.onStage, true);
  assert.equal(f.h.captures.length, 0); assert.equal(StageSocket.instances.length, 1);
});

it('full-stage approval remains a server rejection while rejection remains available', async t => {
  const f = await bridge(t); await f.transfer();
  // Former on-stage controller now consumes one of the eight capped speaker seats.
  for (let i = 0; i < 7; i++) {
    const person = await f.applicant(`Speaker ${i}`); assert.deepEqual(await f.command('approve', person.id), { ok: true });
  }
  const waiting = await f.applicant('Waiting full stage');
  assert.equal(f.client.state!.speakers.filter(person => person.role !== 'controller').length, 8);
  assert.deepEqual(await f.command('approve', waiting.id), { ok: false, code: 'stage_full' });
  assert.equal(waiting.s.last('room:state')!.me.handRaised, true);
  assert.deepEqual(await f.command('reject', waiting.id), { ok: true });
  assert.equal(waiting.s.last('room:state')!.me.handRaised, false);
});

it('offline retained hand remains in queue; approval conflicts but rejection safely withdraws it', async t => {
  const f = await bridge(t), target = await f.applicant('Offline applicant'); await f.transfer();
  await f.server.hub.detach(target.s); await f.flushStates();
  assert.equal(f.client.state!.hands.find(person => person.participantId === target.id)!.connected, false);
  assert.deepEqual(await f.command('approve', target.id), { ok: false, code: 'conflict' });
  assert.deepEqual(await f.command('reject', target.id), { ok: true });
  assert.deepEqual(f.client.state!.hands, []);
  assert.equal(target.s.all('hand:rejected').length, 0, 'no delivery to detached session and no notification history');
});


it('whole embed actual SDK and Hub retain the same-ID target lock across state-before-ACK removal/reappearance', async t => {
  const f = await bridge(t), target = await f.applicant('Pending applicant'); await f.transfer(); f.holdAck();
  panel(f.h).open = true; const old = row(f.h); old.reject.click();
  await f.h.tick(200); await f.drain(); assert.equal(f.client.state!.hands.length, 0);
  assert.equal(list(f.h).children.length, 0); assert.equal(target.s.all('hand:rejected').length, 1); assert.equal(f.heldAcks.length, 1);
  assert.equal(await f.req(target.s, { type: 'hand:raise' }), 'ok'); await f.flushStates();
  const replacement = row(f.h); assert.notEqual(replacement.node, old.node); locked(replacement); assert.equal(panel(f.h).open, true);
  force(old.approve); force(replacement.approve); await f.h.tick(200); await f.drain();
  assert.equal(f.validated.filter(message => message.type === 'stage:approve' || message.type === 'stage:reject').length, 1);
  f.socket.deliver(f.heldAcks[0]!); await flush(); locked(replacement, false);
  assert.deepEqual(await f.command('approve', target.id), { ok: true }); assert.equal(target.s.last('room:state')!.me.role, 'speaker');
  f.socket.deliver(f.heldAcks[1]!); await flush(); assert.equal(list(f.h).children.length, 0);
});

it('whole embed actual SDK/Hub withdrawal before command is an explicit server conflict, then current state removes the row', async t => {
  const f = await bridge(t), target = await f.applicant('Withdraw before UI delivery'); await f.transfer();
  f.holdStates(); assert.equal(await f.req(target.s, { type: 'hand:withdraw' }), 'ok'); await f.flushStates();
  assert.equal(list(f.h).children.length, 1);
  assert.deepEqual(await f.command('approve', target.id), { ok: false, code: 'conflict' }); locked(row(f.h), false);
  const error = f.incoming.findLast(message => message.type === 'error'); assert.ok(error?.type === 'error'); notice(f.h, error.message);
  assert.deepEqual(await f.command('reject', target.id), { ok: false, code: 'conflict' }); f.releaseStates(); await flush();
  assert.equal(list(f.h).children.length, 0);
});

it('whole embed actual SDK/Hub expired target returns not_found before stale row state arrives', async t => {
  const f = await bridge(t), target = await f.applicant('Expired applicant'); await f.transfer();
  f.holdStates(); await f.server.hub.detach(target.s); await f.flushStates();
  const expiry = f.server.timers.find(timer => !timer.cleared && timer.ms === f.config.rooms.participantGraceMs); assert.ok(expiry);
  f.server.clock.now += f.config.rooms.participantGraceMs; expiry.cleared = true; expiry.fn(); await nextTurn(); await f.flushStates();
  assert.deepEqual(await f.command('approve', target.id), { ok: false, code: 'not_found' }); locked(row(f.h), false);
  f.releaseStates(); await flush(); assert.equal(list(f.h).children.length, 0);
});

it('whole embed actual SDK/Hub loss-of-control notification does not invent a state fence; Hub rejects the pre-state race', async t => {
  const f = await bridge(t), target = await f.applicant('Authority race'); await f.transfer(); f.holdStates();
  const transfer = f.client.transferControl(f.host.id); await f.h.tick(200); await f.drain(); await transfer;
  assert.equal(f.client.me!.role, 'controller', 'role and transferred notifications do not replace the SDK snapshot');
  assert.deepEqual(await f.command('reject', target.id), { ok: false, code: 'forbidden' }); locked(row(f.h), false);
  const error = f.incoming.findLast(message => message.type === 'error'); assert.ok(error?.type === 'error'); notice(f.h, error.message);
  const old = row(f.h); f.releaseStates(); await flush(); retired(f.h); force(old.reject); await f.h.tick(200); await f.drain();
  assert.equal(f.validated.filter(message => message.type === 'stage:reject').length, 1);
});

it('whole embed actual SDK decodes escaped hand names exactly once without parsing participant HTML', async t => {
  const h = await actualApp(t), { socket } = await h.join();
  socket.deliver({ type: 'room:state', ...actualState(), hands: [person('a', { name: '&lt;img src=x&gt; &amp;amp; &quot;x&quot; &#39;y&#39;' })] });
  const a = row(h); assert.equal(a.name.textContent, '<img src=x> &amp; "x" \'y\'');
  assert.equal(a.approve.attributes['aria-label'], '核准 <img src=x> &amp; "x" \'y\' 上台');
  assert.equal(a.name.children.length, 0);
});

it('whole embed actual SDK reconnect retains rows/open, rejects old request naturally, and never automatically replays moderation', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join();
  const state = { ...actualState(), hands: [person('a'), person('b')] };
  socket.deliver({ type: 'room:state', ...state }); const a = row(h); panel(h).open = true; a.approve.click();
  await h.until(() => socket.sent.some(message => message.type === 'stage:approve'), 'moderation request');
  const oldRequest = socket.sent.find(message => message.type === 'stage:approve')!;
  socket.close(); assert.equal(summary(h), '舉手申請（2） · 上次收到'); assert.equal(row(h).node, a.node); locked(a);
  await flush(); locked(a, false, true); assert.equal(h.node('error-notice').hidden, true); assert.equal(panel(h).open, true);
  force(a.reject); await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  resumed.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => resumed.sent.some(message => message.type === 'join'), 'resume join');
  const joined = resumed.sent.find(message => message.type === 'join'); assert.ok(joined?.type === 'join'); assert.equal(joined.resumeToken, 'test-resume');
  resumed.deliver({ type: 'ok', requestId: joined.requestId }); await flush(); locked(a, false, true);
  resumed.deliver({ type: 'room:state', ...state }); await flush(); locked(a, false); assert.equal(row(h).node, a.node); assert.equal(panel(h).open, true);
  assert.equal(resumed.sent.filter(message => message.type === 'stage:approve' || message.type === 'stage:reject').length, 0);
  a.reject.click(); await h.until(() => resumed.sent.some(message => message.type === 'stage:reject'), 'new explicit reject'); locked(a);
  socket.deliver({ type: 'error', requestId: oldRequest.requestId, code: 'conflict', message: 'obsolete socket failure' }); await flush(); locked(a); assert.equal(h.node('error-notice').hidden, true);
  const request = resumed.sent.find(message => message.type === 'stage:reject')!; resumed.deliver({ type: 'ok', requestId: request.requestId }); await flush(); locked(a, false);
  assert.equal(h.clients.length, 1); assert.equal(StagePeer.instances.length, 1); assert.equal(StagePeer.instances[0], peer); assert.equal(h.captures.length, 0);
});

for (const boundary of ['role', 'room', 'participant', 'missing state', 'disconnected'] as const) {
  it(`whole embed pending settlement rechecks silent ${boundary} changes before feedback or unlock`, async t => {
    const { h, sdk } = await app(t), old = row(h); old.approve.click();
    sdk.emit('error', new Error('preserve current error'));
    if (boundary === 'missing state') sdk.state = null;
    else if (boundary === 'disconnected') sdk.status = 'disconnected';
    else snapshot(sdk, [person('first')], boundary === 'role' ? { me: { role: 'audience' } }
      : boundary === 'room' ? { roomId: 'changed' } : { me: { participantId: 'changed' } }, false);
    sdk.moderations[0]!.work.reject('obsolete settlement'); await flush(); notice(h, 'preserve current error');
    assert.equal(old.approve.disabled, true); assert.equal(old.node.parentElement, null);
    if (boundary === 'room' || boundary === 'participant') { assert.notEqual(row(h).node, old.node); locked(row(h), false); }
    else retired(h);
  });
}

it('whole embed real SDK current-socket global error survives retired promise isolation and cannot unlock a new tenure', async t => {
  const h = await actualApp(t), { socket } = await h.join();
  const state = { ...actualState(), hands: [person('a')] };
  socket.deliver({ type: 'room:state', ...state }); const old = row(h); old.approve.click();
  await h.until(() => socket.sent.some(message => message.type === 'stage:approve'), 'old approve');
  const oldRequest = socket.sent.find(message => message.type === 'stage:approve')!;
  socket.deliver({ type: 'room:state', ...state, me: { ...state.me, role: 'audience' } }); retired(h);
  socket.deliver({ type: 'room:state', ...state }); row(h).reject.click();
  await h.until(() => socket.sent.some(message => message.type === 'stage:reject'), 'new tenure reject'); locked(row(h));
  socket.deliver({ type: 'error', requestId: oldRequest.requestId, code: 'forbidden', message: 'global old-command error' }); await flush();
  notice(h, 'global old-command error'); locked(row(h));
  const current = socket.sent.find(message => message.type === 'stage:reject')!; socket.deliver({ type: 'ok', requestId: current.requestId }); await flush();
  locked(row(h), false); notice(h, 'global old-command error'); force(old.reject);
  assert.equal(socket.sent.filter(message => message.type === 'stage:reject').length, 1);
});

it('whole embed actual on-stage controller moderates without extra controller capture, peer or playback operations', async t => {
  const f = await bridge(t), target = await f.applicant('Onstage controller applicant'); await f.transfer();
  f.h.stage.click(); await f.h.tick(200); await f.drain();
  await f.h.until(() => f.client.me?.onStage === true && StagePeer.instances[0]!.transceiver.sender.track !== null, 'controller return to stage');
  await f.h.tick(200); await f.drain();
  const before = { captures: f.h.captures.length, peers: StagePeer.instances.length, plays: f.h.audio.plays, clients: f.h.clients.length };
  assert.deepEqual(await f.command('approve', target.id), { ok: true });
  assert.equal(f.client.me!.role, 'controller'); assert.equal(f.client.me!.onStage, true); assert.equal(target.s.last('room:state')!.me.role, 'speaker');
  assert.deepEqual({ captures: f.h.captures.length, peers: StagePeer.instances.length, plays: f.h.audio.plays, clients: f.h.clients.length }, before);
});
