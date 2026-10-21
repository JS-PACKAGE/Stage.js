import assert from 'node:assert/strict';
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { StageClient } from '../packages/client/src/index.ts';
import type { ClientMessage, ServerMessage, RoomStatePayload, ParticipantView } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { embedApp, EmbedNode, EmbedSdk, flush, Deferred } from './fixtures/embedApp.ts';
import { actualApp, StageSocket, StagePeer, StageContext } from './fixtures/embedSdkApp.ts';
import { harness, testConfig, FakeSession } from './helpers.ts';

async function pipeline(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.controllerGraceMs = 60_000; c.rooms.participantGraceMs = 15000; c.rooms.presenceBroadcastMs = 0; c.limits.maxAudiencePerRoom = 300; c.limits.maxSpeakersPerRoom = 8; c.limits.controlPerSecond = 2000; c.limits.handRaiseIntervalMs = 0; });
  const server = harness(config), host = await server.create('Synthetic original controller');
  const h = await actualApp(t, { confirm: () => true });
  let serverWork = Promise.resolve(), sequence = 0, holdCloseAck = false;
  let beforeClose: (() => Promise<void>) | undefined;
  const validated: ClientMessage[] = [], incoming: ServerMessage[] = [], held: ServerMessage[] = [];
  const sessions = new Map<StageSocket, Session>();
  const closes: { socket: StageSocket; code: number | undefined }[] = [];
  const originalClose = StageSocket.prototype.close;
  t.mock.method(StageSocket.prototype, 'close', function (this: StageSocket, code?: number) {
    closes.push({ socket: this, code }); originalClose.call(this);
    const session = sessions.get(this);
    if (session) serverWork = serverWork.then(() => server.hub.detach(session, code === 1000));
  });
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this);
    assert.ok(session); this.sent.push(message); validated.push(message);
    serverWork = serverWork.then(async () => {
      if (message.type === 'room:close') await beforeClose?.();
      await server.hub.handle(session, message);
    });
  });
  const bind = (socket: StageSocket) => {
    const session: Session = { id: `embed-public-roster-${++sequence}`,
      send(message) {
        incoming.push(message);
        if (holdCloseAck && message.type === 'ok' && validated.some(request => request.type === 'room:close' && request.requestId === message.requestId)) {
          held.push(message); return;
        }
        if (socket.readyState === StageSocket.OPEN) socket.deliver(message);
      },
      close() { socket.close(); },
    };
    sessions.set(socket, session); server.hub.attach(session); return session;
  };
  t.after(async () => { await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close(); });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic embed participant';
  h.form.submit(); await flush(); const socket = StageSocket.instances[0]!, session = bind(socket);
  await h.until(() => h.clients[0]?.me != null, 'whole embed entered through actual SDK');
  await h.tick(200); await serverWork; await flush();
  const client = h.clients[0] as StageClient, pid = client.me!.participantId;
  const req = async (actor: FakeSession, message: Omit<ClientMessage, 'requestId'> & Record<string, unknown>) => {
    const requestId = `setup-${++sequence}`;
    await server.hub.handle(actor, parseClientMessage(JSON.stringify({ ...message, requestId }), config.limits));
    const reply = actor.inbox.find(m => (m.type === 'ok' || m.type === 'error') && m.requestId === requestId);
    assert.ok(reply); return reply.type === 'error' ? reply.code : 'ok';
  };
  const drain = async () => { await h.tick(200); await serverWork; await flush(); };
  const flushStates = async () => {
    for (const timer of server.timers) if (!timer.cleared && (timer.ms === 0 || timer.ms === config.rooms.presenceBroadcastMs)) {
      timer.cleared = true; timer.fn();
    }
    await nextTurn(); await flush();
  };
  const controller = async (onStage = false) => {
    assert.equal(await req(host.s, { type: 'control:transfer', targetId: pid }), 'ok'); await flush();
    assert.equal(client.me!.role, 'controller'); assert.equal(client.me!.onStage, false);
    if (onStage) { const work = client.returnToStage(); await drain(); await work; assert.equal(client.me!.onStage, true); }
  };
  const sdkGuest = async () => {
    const audio = { autoplay: true, srcObject: null, volume: 1, muted: false, pause() {}, async play() {} };
    const guest = new StageClient({ url: 'wss://stage.example.test/ws', audioElement: audio as unknown as HTMLAudioElement });
    h.clients.push(guest); const work = guest.join({ roomId: host.roomId, code: host.code, name: 'Synthetic SDK guest' });
    const socket = StageSocket.instances.at(-1)!, session = bind(socket);
    await h.until(() => guest.me !== null, 'actual guest SDK joined'); await drain(); await work;
    return { client: guest, socket, session, peer: StagePeer.instances.at(-1)! };
  };
  return { config, server, host, h, client, socket, session, pid, validated, incoming, held, closes,
    controller, sdkGuest, req, drain, flushStates, bind,
    holdAck: () => { holdCloseAck = true; }, beforeClose: (work: () => Promise<void>) => { beforeClose = work; } };
}

function person(id: string, patch: Partial<ParticipantView> = {}): ParticipantView {
  return { participantId: id, name: `Name-${id}`, role: 'speaker', onStage: true, handRaised: false,
    muted: false, forceMuted: false, connected: true, gainDb: 0, joinedAt: 1, ...patch };
}
function state(patch: Partial<RoomStatePayload> = {}): RoomStatePayload {
  return { roomId: 'same-room', name: 'Public room', controllerId: 'host',
    me: person('reader', { name: 'Private reader', role: 'audience', onStage: false }),
    speakers: [person('host', { role: 'controller' }), person('target')], hands: [], audienceCount: 1,
    limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', codeRequired: true, recording: false, recordingAvailable: false,
    code: 'PRIVATE-CODE', resumeToken: 'PRIVATE-TOKEN', ...patch };
}
function publish(sdk: EmbedSdk, snapshot = state()): void { sdk.state = snapshot; sdk.me = snapshot.me; sdk.emit('state', snapshot); }
function roster(app: { node(id: string): EmbedNode }) {
  const panel = app.node('public-roster'), summary = app.node('public-roster-summary');
  const notice = app.node('public-roster-notice'), list = app.node('public-roster-list');
  return { panel, summary, notice, list, text: () => [summary.textContent, notice.textContent, ...list.children.map(row => row.textContent)].join('\n') };
}
function clear(app: { node(id: string): EmbedNode }): void {
  const r = roster(app); assert.equal(r.panel.hidden, true); assert.equal(r.panel.open, false);
  assert.equal(r.list.children.length, 0); assert.equal(r.notice.textContent, '');
}
async function setup(t: TestContext, snapshot = state(), options: Parameters<typeof embedApp>[0] = {}) {
  const app = embedApp(options); t.after(() => app.cleanup()); const sdk = await app.join();
  publish(sdk, snapshot); return { app, sdk, ...roster(app) };
}
function countWrites(t: TestContext, app: { node(id: string): EmbedNode }) {
  const r = roster(app); let writes = 0;
  for (const node of [r.panel, r.summary, r.notice, r.list, ...r.list.children]) {
    for (const key of ['textContent', 'hidden', 'open'] as const) {
      let value = node[key]; Object.defineProperty(node, key, { configurable: true, get: () => value, set(next: typeof value) { writes++; value = next; } });
    }
    const replace = node.replaceChildren.bind(node), append = node.append.bind(node);
    t.mock.method(node, 'replaceChildren', (...children: EmbedNode[]) => { writes++; replace(...children); });
    t.mock.method(node, 'append', (...children: EmbedNode[]) => { writes++; append(...children); });
  }
  return () => writes;
}
function moderation(app: ReturnType<typeof embedApp>): EmbedNode {
  const row = app.node('stage-management-list').children[0]; assert.ok(row); const transfer = row.children[1]?.children[2]; assert.ok(transfer); return transfer;
}

it('embed public roster authors one native collapsed disclosure and a non-live passive list', async t => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const markup = html.match(/<details id="public-roster"[\s\S]*?<\/details>/)?.[0]; assert.ok(markup);
  assert.match(markup, /^<details id="public-roster" class="panel" hidden>/);
  assert.match(markup, /<summary id="public-roster-summary">台上成員快照<\/summary>/);
  assert.match(markup, /<ul id="public-roster-list" aria-label="台上成員快照"><\/ul>/);
  assert.doesNotMatch(markup, /\bopen(?:\s|=|>)|<button|<input|<select|role=|aria-live|tabindex/);
  for (const id of ['public-roster', 'public-roster-summary', 'public-roster-notice', 'public-roster-list']) assert.equal(html.split(`id="${id}"`).length, 2);
  const app = embedApp(); t.after(() => app.cleanup()); clear(app);
  assert.equal(roster(app).panel.onclick, null, 'native disclosure needs no custom click handler');
});
for (const role of ['audience', 'speaker', 'controller'] as const) for (const onStage of [false, true])
  it(`embed public roster admits joined ${role}/${onStage} independently of reader media eligibility`, async t => {
    const snapshot = state(); snapshot.me.role = role; snapshot.me.onStage = onStage;
    if (role === 'controller') { snapshot.controllerId = snapshot.me.participantId; snapshot.speakers[0]!.role = 'speaker'; }
    const { panel, list, text } = await setup(t, snapshot); assert.equal(panel.hidden, false); assert.equal(panel.open, false);
    assert.equal(list.children.length, 2); assert.match(text(), /Name-target/);
  });
it('embed public roster empty stage stays visible and does not synthesize offstage controller', async t => {
  const { panel, list, notice, text } = await setup(t, state({ speakers: [] }));
  assert.equal(panel.hidden, false); assert.equal(list.children.length, 0); assert.match(notice.textContent, /目前沒有台上成員/);
  assert.doesNotMatch(text(), /Name-host|Private reader/);
});
it('embed public roster renders copied safe text, exact order and disconnected reserved seats without IDs or private values', async t => {
  const snapshot = state({ speakers: [person('grace', { name: '&lt;img src=x onerror=1&gt;', muted: true, forceMuted: true, connected: false }),
    person('host', { role: 'controller', name: '&amp;lt;b&amp;gt;' }), person('duplicate-name', { name: '&lt;img src=x onerror=1&gt;' })] });
  const { sdk, panel, list, text } = await setup(t, snapshot);
  assert.match(list.children[0]!.textContent, /^&lt;img src=x onerror=1&gt; · 發言者 · 已靜音 · 靜音已鎖定 · 控制連線中斷（保留席位）$/);
  assert.match(list.children[1]!.textContent, /^&amp;lt;b&amp;gt; · 主控/); assert.equal(list.children[0]!.tagName, 'LI');
  assert.ok(list.children.every(row => row.children.length === 0 && Object.keys(row.attributes).length === 0));
  assert.doesNotMatch(text(), /PRIVATE|Private reader|duplicate-name|grace/); panel.open = true; const before = text();
  snapshot.speakers.reverse(); snapshot.speakers[0]!.name = 'UNRECEIVED'; sdk.emit('state', snapshot); sdk.setStatus('live');
  assert.equal(text(), before); assert.equal(panel.open, true);
});
it('embed public roster does not read private or irrelevant snapshot fields', async t => {
  const snapshot = state(); let reads = 0;
  for (const key of ['audience', 'code', 'resumeToken']) Object.defineProperty(snapshot, key, { get() { reads++; throw new Error('private'); } });
  for (const p of snapshot.speakers) for (const key of ['gainDb', 'joinedAt', 'handRaised']) Object.defineProperty(p, key, { get() { reads++; throw new Error('unrelated'); } });
  const { sdk, text } = await setup(t, snapshot); assert.match(text(), /Name-target/);
  sdk.emit('quality', { participants: [] }); sdk.emit('speaking', { participantIds: [] }); sdk.setStatus('waiting'); assert.equal(reads, 0);
});
for (const limit of [1, 12, Number.MAX_SAFE_INTEGER]) it(`embed public roster respects configured maxSpeakers=${limit} with controller separate`, async t => {
  const count = Math.min(limit, 12), snapshot = state(); snapshot.limits.maxSpeakers = limit;
  snapshot.speakers = [person('host', { role: 'controller' }), ...Array.from({ length: count }, (_, i) => person(`s${i}`))];
  const { list } = await setup(t, snapshot); assert.equal(list.children.length, count + 1);
});
const malformed: [string, (snapshot: RoomStatePayload) => void][] = [
  ['duplicate ID', s => s.speakers.push({ ...s.speakers[1]! })], ['empty ID', s => { s.speakers[1]!.participantId = ''; }],
  ['blank ID', s => { s.speakers[1]!.participantId = ' '; }], ['invalid name', s => { Reflect.set(s.speakers[1]!, 'name', 9); }],
  ['offstage', s => { s.speakers[1]!.onStage = false; }], ['audience role', s => { s.speakers[1]!.role = 'audience'; }],
  ['unknown role', s => { Reflect.set(s.speakers[1]!, 'role', 'owner'); }], ['null entry', s => { Reflect.set(s.speakers, 1, null); }],
  ['sparse array', s => { delete s.speakers[1]; }], ['controller mismatch', s => { s.controllerId = 'other'; }],
  ['two controllers', s => { s.speakers[1]!.role = 'controller'; }], ['blank controller', s => { s.controllerId = ' '; }],
  ['mute flag', s => { Reflect.set(s.speakers[1]!, 'muted', 0); }], ['force flag', s => { Reflect.set(s.speakers[1]!, 'forceMuted', null); }],
  ['connection flag', s => { Reflect.set(s.speakers[1]!, 'connected', 'true'); }], ['force-unmuted contradiction', s => { s.speakers[1]!.forceMuted = true; }],
  ['overflow', s => { s.limits.maxSpeakers = 1; s.speakers.push(person('extra')); }],
  ...[0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(limit => [`limit ${limit}`, (s: RoomStatePayload) => { s.limits.maxSpeakers = limit; }] as [string, (snapshot: RoomStatePayload) => void]),
];
for (const [label, mutate] of malformed) it(`embed public roster rejects ${label}, clears and collapses without partial rows`, async t => {
  const { app, sdk, panel } = await setup(t); panel.open = true; const snapshot = state(); mutate(snapshot); publish(sdk, snapshot); clear(app);
  publish(sdk); assert.equal(panel.hidden, false); assert.equal(panel.open, false);
});
it('embed public roster unchanged snapshots and unrelated quality/speaking have zero list or surface writes', async t => {
  const { app, sdk, panel, list } = await setup(t); panel.open = true; const rows = [...list.children], writes = countWrites(t, app);
  const timers = app.clock.metrics;
  for (let n = 0; n < 20; n++) { publish(sdk); sdk.emit('quality', { participants: [] }); sdk.emit('speaking', { participantIds: [] }); sdk.setStatus('live'); }
  assert.equal(writes(), 0); assert.deepEqual(list.children, rows); assert.equal(panel.open, true); assert.deepEqual(app.clock.metrics, timers);
  assert.deepEqual([sdk.actions, sdk.moderations, sdk.stageModerations, sdk.transfers, sdk.closes, sdk.gains, sdk.renames, sdk.roomRenames, sdk.deviceLists, sdk.inputSelections], Array.from({ length: 10 }, () => []));
});
it('embed public roster keyed rows survive rename and reorder, but a removed seat gets a fresh row on return', async t => {
  const { sdk, panel, list } = await setup(t); panel.open = true; const rows = [...list.children];
  publish(sdk, state({ speakers: [person('target', { name: 'RENAMED' }), person('host', { role: 'controller' })] }));
  assert.deepEqual(list.children, rows.reverse()); assert.match(list.children[0]!.textContent, /RENAMED/); assert.equal(panel.open, true);
  publish(sdk, state({ speakers: [person('host', { role: 'controller' })] })); publish(sdk);
  assert.equal(list.children[0], rows[1]); assert.notEqual(list.children[1], rows[0]);
});
it('embed public roster records rejected receipts before admission and never refreshes from replay or status', async t => {
  const { sdk, notice, text } = await setup(t), rejected = state(); rejected.speakers[1]!.name = 'REJECTED';
  sdk.emit('state', rejected); sdk.state = rejected; sdk.me = rejected.me; sdk.emit('state', rejected); assert.doesNotMatch(text(), /REJECTED/);
  publish(sdk); const old = sdk.state!; sdk.setStatus('reconnecting'); assert.match(notice.textContent, /重新連線中，上次快照/);
  old.speakers[1]!.name = 'MUTATED'; sdk.setStatus('live'); sdk.emit('state', old); assert.doesNotMatch(text(), /MUTATED/); assert.match(notice.textContent, /上次快照/);
  const reconnect = state(); sdk.setStatus('reconnecting'); publish(sdk, reconnect); sdk.setStatus('live'); publish(sdk, reconnect);
  assert.match(notice.textContent, /上次快照/); publish(sdk); assert.match(notice.textContent, /最近收到/);
});
for (const type of ['role', 'stagejoined', 'stageleft', 'transferred', 'mic']) it(`embed public roster ${type} preserves historical rows with sticky waiting label`, async t => {
  const { sdk, panel, list, notice } = await setup(t); panel.open = true; const rows = [...list.children];
  sdk.emit(type, { participantId: 'target', role: 'audience', fromId: 'host', toId: 'target', muted: true });
  assert.deepEqual(list.children, rows); assert.match(notice.textContent, /上次快照.*等待伺服器快照/);
  sdk.setStatus('reconnecting'); sdk.setStatus('live'); assert.match(notice.textContent, /等待伺服器快照/);
  publish(sdk); assert.doesNotMatch(notice.textContent, /上次快照|等待伺服器快照/); assert.equal(panel.open, true);
});
for (const boundary of ['closed', 'kicked', 'disconnected', 'leave', 'new-entry']) it(`embed public roster ${boundary} retires rows and ignores late old receipts`, async t => {
  const { app, sdk, panel } = await setup(t); panel.open = true;
  if (boundary === 'leave') app.leave.invoke(); else if (boundary === 'new-entry') app.form.submit();
  else if (boundary === 'disconnected') sdk.setStatus('disconnected'); else sdk.emit(boundary, { roomId: 'same-room' });
  clear(app); sdk.status = 'live'; publish(sdk); clear(app); await flush();
});
for (const identity of ['room', 'participant']) it(`embed public roster a single authoritative new ${identity} receipt resets and re-establishes ownership`, async t => {
  const { sdk, panel, list, text } = await setup(t); panel.open = true; const previous = list.children[1], next = state();
  if (identity === 'room') next.roomId = 'new-room'; else next.me.participantId = 'new-reader';
  next.speakers[1]!.name = 'NEW-SEAT'; publish(sdk, next);
  assert.equal(panel.hidden, false); assert.equal(panel.open, false); assert.match(text(), /NEW-SEAT/); assert.notEqual(list.children[1], previous);
});
for (const part of ['summary', 'notice', 'list'] as const) it(`embed public roster observed detached ${part} clears and cannot revive on reattachment alone`, async t => {
  const { app, sdk, panel, summary, notice, list } = await setup(t); panel.open = true;
  ({ summary, notice, list })[part].remove(); sdk.emit('quality', { participants: [] }); clear(app);
  panel.append(summary, notice, list); sdk.setStatus('live'); clear(app); publish(sdk); assert.equal(panel.hidden, false);
});
it('embed public roster rejects exact selector replacement while preserving fail-closed DOM identity', async t => {
  const { app, sdk, panel } = await setup(t); panel.open = true; const original = app.pageDocument.querySelector;
  t.mock.method(app.pageDocument, 'querySelector', (selector: string) => selector === '#public-roster' ? new EmbedNode() : original.call(app.pageDocument, selector));
  sdk.emit('quality', { participants: [] }); clear(app); publish(sdk); clear(app);
});
for (const action of ['newer', 'leave', 'new-entry', 'retire-restore']) for (const throwing of [false, true])
  it(`embed public roster projection getter ${action} throwing=${throwing} cannot resume stale admission`, async t => {
    const { app, sdk, text } = await setup(t), outer = state(), winner = state({ speakers: [person('winner', { name: 'WINNER' })] });
    let armed = true;
    Object.defineProperty(outer.speakers[1]!, 'muted', { get() {
      if (armed) { armed = false;
        if (action === 'newer') publish(sdk, winner); else if (action === 'leave') app.leave.invoke(); else if (action === 'new-entry') app.form.submit();
        else { sdk.state = null; sdk.me = null; sdk.emit('quality', { participants: [] }); sdk.state = outer; sdk.me = outer.me; }
        if (throwing) throw new Error('synthetic retired projection');
      }
      return false;
    } });
    outer.speakers[1]!.name = 'STALE-OUTER'; publish(sdk, outer);
    if (action === 'newer') { assert.match(text(), /WINNER/); assert.doesNotMatch(text(), /STALE-OUTER/); } else clear(app);
    await flush();
  });
for (const target of ['row', 'summary', 'notice', 'list', 'hidden']) it(`embed public roster late ${target} setter completion repairs a newer finite callback winner`, async t => {
  const { app, sdk, summary, notice, list, panel, text } = await setup(t), outer = state(), winner = state();
  outer.speakers[1]!.name = 'STALE-OUTER'; winner.speakers[1]!.name = 'WINNER';
  if (target === 'summary') outer.speakers.push(person('extra'));
  if (target === 'notice') sdk.setStatus('reconnecting');
  sdk.status = 'live'; let armed = true;
  const interrupt = () => { if (armed) { armed = false; publish(sdk, winner); } };
  if (target === 'list') { const original = list.replaceChildren.bind(list); t.mock.method(list, 'replaceChildren', (...nodes: EmbedNode[]) => { interrupt(); original(...nodes); }); outer.speakers.reverse(); }
  else {
    const node = target === 'row' ? list.children[1]! : target === 'summary' ? summary : target === 'notice' ? notice : panel;
    const key = target === 'hidden' ? 'hidden' : 'textContent'; if (target === 'hidden') panel.hidden = true;
    let value = node[key]; Object.defineProperty(node, key, { configurable: true, get: () => value, set(next: typeof value) { interrupt(); value = next; } });
  }
  publish(sdk, outer); assert.equal(armed, false); assert.match(text(), /WINNER/); assert.doesNotMatch(text(), /STALE-OUTER|Name-extra/); assert.equal(panel.hidden, false);
});
for (const command of ['close', 'transfer']) it(`embed public roster notification DOM cannot restore invalidated ${command} consent`, async t => {
  let inside = () => {}; const snapshot = state(); snapshot.me = snapshot.speakers[0]!;
  const { app, sdk, notice } = await setup(t, snapshot, { confirm: () => { inside(); return true; } });
  let value = notice.textContent, armed = true;
  Object.defineProperty(notice, 'textContent', { configurable: true, get: () => value, set(next: string) {
    value = next; if (armed) { armed = false; publish(sdk, snapshot); }
  } });
  inside = () => sdk.emit('role', { participantId: command === 'close' ? 'host' : 'target', role: 'audience' });
  (command === 'close' ? app.node('close-room') : moderation(app)).click(); await flush();
  assert.equal(armed, false); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
});
it('embed public roster unrelated speaker departure does not revoke valid Close consent', async t => {
  let inside = () => {}; const snapshot = state(); snapshot.me = snapshot.speakers[0]!;
  const { app, sdk } = await setup(t, snapshot, { confirm: () => { inside(); return true; } });
  inside = () => sdk.emit('role', { participantId: 'target', role: 'audience' }); app.node('close-room').click(); await flush();
  assert.equal(sdk.closes.length, 1); assert.equal(sdk.transfers.length, 0);
});

const silentName = '安靜講者 & <b>文字</b>';
async function silentSpeaker(f: Awaited<ReturnType<typeof pipeline>>) {
  const s = new FakeSession(); f.server.hub.attach(s);
  assert.equal(await f.req(s, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: silentName }), 'ok');
  const id = s.last('room:state')!.me.participantId;
  assert.equal(await f.req(s, { type: 'hand:raise' }), 'ok');
  assert.equal(await f.req(f.host.s, { type: 'stage:approve', targetId: id }), 'ok');
  await f.drain(); await f.flushStates(); return { s, id };
}
function effects(f: Awaited<ReturnType<typeof pipeline>>) {
  return { frames: [...f.validated], sockets: StageSocket.instances.length, peers: StagePeer.instances.length, contexts: StageContext.instances.length,
    captures: f.h.captures.length, devices: f.h.enumerations.length, sinks: f.h.sinks.length, retries: f.h.calls(),
    plays: f.h.audio.plays, pauses: f.h.audio.pauses, offers: StagePeer.instances.map(peer => peer.offers.length),
    replacements: StagePeer.instances.map(peer => peer.replacements.length), timers: [...f.server.timers] };
}
for (const viewer of ['audience', 'speaker'] as const) for (const controllerOnStage of [true, false]) for (const connected of [true, false])
  it(`embed public roster actual SDK/validator/Hub shows silent target to ${viewer}, hostOnStage=${controllerOnStage}, connected=${connected}`, async t => {
    const f = await pipeline(t), target = await silentSpeaker(f), r = roster(f.h);
    if (viewer === 'speaker') {
      const raising = f.client.raiseHand(); await f.drain(); await raising;
      assert.equal(await f.req(f.host.s, { type: 'stage:approve', targetId: f.pid }), 'ok'); await f.drain();
      assert.equal(f.client.me!.role, 'speaker');
    }
    if (!controllerOnStage) { assert.equal(await f.req(f.host.s, { type: 'stage:leave' }), 'ok'); await f.drain(); }
    if (!connected) { await f.server.hub.detach(target.s); await f.flushStates(); }
    const snapshot = f.client.state!, publicTarget = snapshot.speakers.find(person => person.participantId === target.id);
    assert.ok(publicTarget); assert.equal(publicTarget.connected, connected); assert.equal(publicTarget.onStage, true);
    assert.equal(Object.hasOwn(snapshot, 'audience'), false); assert.equal(Object.hasOwn(snapshot, 'code'), false);
    assert.equal(f.h.node('stage-management').hidden, true); assert.equal(f.h.node('hand-queue').hidden, true);
    assert.match(f.h.node('speaking-summary').textContent, /未偵測到發言|等待伺服器回報/);
    assert.equal(r.panel.hidden, false); assert.equal(r.panel.open, false); assert.ok(r.text().includes(silentName));
    assert.equal(r.list.children.length, snapshot.speakers.length);
    assert.equal(r.text().includes('Synthetic original controller'), controllerOnStage);
    assert.equal(r.text().includes('控制連線中斷（保留席位）'), !connected);
    assert.ok(r.list.children.every(row => row.tagName === 'LI' && row.children.length === 0 && Object.keys(row.attributes).length === 0));
    const refs = [...r.list.children];
    f.socket.deliver({ type: 'room:state', ...snapshot }); await flush();
    const before = effects(f); r.panel.open = true;
    f.client.dispatchEvent(new CustomEvent('state', { detail: f.client.state }));
    f.socket.deliver({ type: 'speaking', participantIds: [] });
    f.socket.deliver({ type: 'quality', participants: [] }); await flush();
    assert.ok(r.text().includes(silentName)); assert.deepEqual(r.list.children, refs); assert.equal(r.panel.open, true);
    assert.deepEqual(effects(f), before, 'passive receipt/toggle does not send commands, poll, or start media/device work');
    assert.doesNotMatch(r.text(), /PRIVATE|resumeToken|participantId/);
  });
for (const onStage of [false, true]) it(`embed public roster actual controller onStage=${onStage} remains public and separate from moderation`, async t => {
  const f = await pipeline(t); await silentSpeaker(f); await f.controller(onStage); const r = roster(f.h);
  assert.equal(f.client.me!.role, 'controller'); assert.equal(r.panel.hidden, false); assert.ok(r.text().includes(silentName));
  assert.equal(r.list.children.length, f.client.state!.speakers.length); assert.equal(r.text().includes('Synthetic embed participant'), onStage);
  assert.equal(f.h.node('stage-management').hidden, false); assert.ok(r.list.children.every(row => row.children.length === 0));
  const privateAudience = await f.server.join(f.host.roomId, f.host.code, 'PRIVATE-AUDIENCE'); await f.flushStates();
  assert.ok(f.client.state!.audience?.some(person => person.participantId === privateAudience.id)); assert.doesNotMatch(r.text(), /PRIVATE-AUDIENCE/);
  assert.ok(f.client.state!.code); assert.equal(r.text().includes(f.host.code), false);
});
it('embed public roster actual empty stage is useful after offstage controller and removed speaker', async t => {
  const f = await pipeline(t), target = await silentSpeaker(f), r = roster(f.h);
  assert.equal(await f.req(f.host.s, { type: 'stage:remove', targetId: target.id }), 'ok');
  assert.equal(await f.req(f.host.s, { type: 'stage:leave' }), 'ok'); await f.drain();
  assert.equal(f.client.state!.speakers.length, 0); assert.equal(r.panel.hidden, false); assert.equal(r.list.children.length, 0);
  assert.match(r.notice.textContent, /目前沒有台上成員/); assert.doesNotMatch(r.text(), /安靜講者|Synthetic original controller/);
});
it('embed public roster actual SDK role and stage-left precede authoritative state, retaining waiting history through the gap', async t => {
  const f = await pipeline(t), target = await silentSpeaker(f), r = roster(f.h); let role = false, left = false;
  const rows = [...r.list.children]; r.panel.open = true;
  f.client.on('role', ({ detail }) => {
    if (detail.participantId !== target.id) return; role = true;
    assert.equal(detail.role, 'audience'); assert.ok(f.client.state!.speakers.some(person => person.participantId === target.id));
    assert.deepEqual(r.list.children, rows); assert.match(r.notice.textContent, /上次快照.*等待/);
  });
  f.client.on('stageleft', ({ detail }) => { if (detail.participantId !== target.id) return; left = true;
    assert.deepEqual(r.list.children, rows); assert.ok(r.text().includes(silentName)); assert.match(r.notice.textContent, /等待/); });
  assert.equal(await f.req(f.host.s, { type: 'stage:remove', targetId: target.id }), 'ok'); await f.drain();
  assert.equal(role, true); assert.equal(left, true); assert.equal(r.text().includes(silentName), false);
  assert.doesNotMatch(r.notice.textContent, /等待/); assert.equal(r.panel.open, true);
});
it('embed public roster actual reconnect keeps copied history and resumes on new state before ACK with stable row keys', async t => {
  const f = await pipeline(t); await silentSpeaker(f); const r = roster(f.h), rows = [...r.list.children], old = f.client.state!;
  r.panel.open = true; f.socket.close(); await flush(); assert.equal(f.client.status, 'reconnecting');
  assert.equal(f.client.state, old); assert.match(r.notice.textContent, /重新連線中，上次快照/); assert.deepEqual(r.list.children, rows);
  const token = old.resumeToken; await f.h.tick(500); const replacement = StageSocket.instances.at(-1)!; assert.notEqual(replacement, f.socket);
  f.bind(replacement); await f.h.until(() => f.client.status === 'live', 'actual SDK resumed'); await f.drain();
  const request = replacement.sent.find(message => message.type === 'join'); assert.ok(request && request.type === 'join');
  assert.equal(request.resumeToken, token); assert.notEqual(f.client.state, old); assert.equal(f.client.me!.participantId, f.pid);
  assert.equal(r.panel.open, true); assert.deepEqual(r.list.children, rows); assert.match(r.notice.textContent, /最近收到/);
  const reads = r.text(); f.client.dispatchEvent(new CustomEvent('state', { detail: old })); assert.equal(r.text(), reads);
});
it('embed public roster actual mute state and safe rename update only authoritative fields', async t => {
  const f = await pipeline(t), target = await silentSpeaker(f), r = roster(f.h), original = [...r.list.children];
  assert.equal(await f.req(f.host.s, { type: 'mic:force-mute', targetId: target.id }), 'ok'); await f.drain();
  assert.match(r.list.children.at(-1)!.textContent, /已靜音.*靜音已鎖定/);
  assert.equal(await f.req(target.s, { type: 'participant:rename', name: '<img src=x> & new' }), 'ok'); await f.drain(); await f.flushStates();
  assert.match(r.list.children.at(-1)!.textContent, /^<img src=x> & new/); assert.equal(r.list.children.at(-1)!.children.length, 0);
  assert.deepEqual(r.list.children, original);
});
it('embed public roster actual close retires and stale SDK callbacks cannot restore list', async t => {
  const f = await pipeline(t); await silentSpeaker(f); const r = roster(f.h), old = f.client.state!; r.panel.open = true;
  assert.equal(await f.req(f.host.s, { type: 'room:close' }), 'ok'); await f.drain(); clear(f.h);
  assert.equal(f.client.status, 'disconnected'); f.client.dispatchEvent(new CustomEvent('state', { detail: old }));
  f.client.dispatchEvent(new CustomEvent('role', { detail: { participantId: f.pid, role: 'controller' } })); clear(f.h);
});
for (const boundary of ['room', 'participant', 'status']) it(`embed public roster retirement observed by an earlier speaking getter rejects restored outer receipt (${boundary})`, async t => {
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
  const { app, sdk } = await setup(t, state(), { source: `${source}\nObject.assign(document, { observeRoster: renderPublicRoster });` });
  const outer = state(); let armed = true;
  Object.defineProperty(outer.speakers[1]!, 'name', { get() {
    if (armed) { armed = false; const lost = state(); if (boundary === 'room') lost.roomId = 'lost'; else lost.me.participantId = 'lost';
      sdk.state = lost; sdk.me = lost.me; if (boundary === 'status') sdk.status = 'disconnected';
      const observe = Reflect.get(app.pageDocument, 'observeRoster'); assert.equal(typeof observe, 'function'); Reflect.apply(observe, undefined, []);
      sdk.state = outer; sdk.me = outer.me; sdk.status = 'live';
    }
    return 'STALE-RESTORED';
  } });
  publish(sdk, outer); assert.equal(armed, false); clear(app);
});
it('embed public roster actual SDK decodes public names exactly once into text-only rows', async t => {
  const f = await pipeline(t), snapshot = f.client.state!;
  f.socket.deliver({ type: 'room:state', ...snapshot, speakers: [person(f.host.id, { role: 'controller', name: '&amp;lt;b&amp;gt;' }),
    person('safe-text', { name: '&lt;img src=x&gt;&quot;&#39;&amp;' })] }); await flush();
  const r = roster(f.h); assert.match(r.list.children[0]!.textContent, /^&lt;b&gt; · 主控/);
  assert.match(r.list.children[1]!.textContent, /^<img src=x>"'& · 發言者/);
  assert.ok(r.list.children.every(row => row.children.length === 0 && Object.keys(row.attributes).length === 0));
});
it('embed public roster rejects array-shaped limits even with a positive maxSpeakers property', async t => {
  const { app, sdk } = await setup(t), snapshot = state(); Reflect.set(snapshot, 'limits', Object.assign([], { maxSpeakers: 8, maxAudience: 300 }));
  publish(sdk, snapshot); clear(app);
});
