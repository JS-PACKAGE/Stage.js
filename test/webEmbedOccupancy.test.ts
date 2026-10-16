import assert from 'node:assert/strict';
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

function person(id: string, role: ParticipantView['role'] = 'audience', onStage = role !== 'audience'): ParticipantView {
  return { participantId: id, name: `Private ${id}`, role, onStage, handRaised: false, muted: false,
    forceMuted: false, connected: true, gainDb: 0, joinedAt: 1 };
}
function snapshot(options: { audience?: number; stage?: number; controllerOnStage?: boolean; viewer?: ParticipantView['role']; maxAudience?: number; maxSpeakers?: number; roomId?: string; participantId?: string } = {}): RoomStatePayload {
  const controllerOnStage = options.controllerOnStage ?? true, viewer = options.viewer ?? 'audience';
  return { roomId: options.roomId ?? 'same-room', name: '測試舞台', controllerId: 'controller',
    speakers: [...(controllerOnStage ? [person('controller', 'controller')] : []),
      ...Array.from({ length: options.stage ?? 1 }, (_, i) => person(`speaker-${i}`, 'speaker'))],
    hands: [], audienceCount: options.audience ?? 2, limits: { maxAudience: options.maxAudience ?? 300, maxSpeakers: options.maxSpeakers ?? 8 },
    status: 'live', codeRequired: true, code: 'PRIVATE-CODE', resumeToken: 'PRIVATE-TOKEN',
    me: person(options.participantId ?? (viewer === 'controller' ? 'controller' : viewer === 'speaker' ? 'speaker-0' : 'listener'), viewer,
      viewer === 'controller' ? controllerOnStage : viewer === 'speaker') };
}
function publish(sdk: EmbedSdk, state = snapshot()): void { sdk.state = state; sdk.me = state.me; sdk.emit('state', state); }
function summary(room: number, stage: number, audience: number, onStage = true, maxAudience = 300, maxSpeakers = 8, freshness = '最近快照'): string {
  return `房間席位（${freshness}）：主控以外 ${room} / ${maxAudience} 人，其中台上 ${stage} / ${maxSpeakers} 人、觀眾 ${audience} 人；主控另計 1 人（${onStage ? '台上' : '台下'}）。含斷線保留席位。`;
}
function shown(node: EmbedNode, expected: string): void { assert.equal(node.hidden, false); assert.equal(node.textContent, expected); }
function empty(node: EmbedNode): void { assert.equal(node.hidden, true); assert.equal(node.textContent, ''); }
function instrument(node: EmbedNode, hook?: (property: 'textContent' | 'hidden') => void) {
  const writes = { textContent: 0, hidden: 0 };
  for (const property of ['textContent', 'hidden'] as const) {
    let value = node[property];
    Object.defineProperty(node, property, { configurable: true, get: () => value, set(next: typeof value) {
      assert.notEqual(next, value, `equal ${property} must not be written`);
      value = next; writes[property]++; hook?.(property);
    } });
  }
  return writes;
}
async function double(t: TestContext, options: Parameters<typeof embedApp>[0] = {}) {
  const app = embedApp(options); t.after(() => app.cleanup()); const sdk = await app.join();
  return { app, sdk, node: app.node('room-occupancy') };
}

it('embed occupancy authors exactly one empty ordinary paragraph beside status and executes the complete module', async t => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  assert.equal(html.match(/id="room-occupancy"/g)?.length, 1);
  assert.match(html, /<p id="status"[^>]*>[^<]*<\/p><p id="room-occupancy" hidden><\/p>/);
  assert.match(readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8'), /overflow-wrap/);
  const app = embedApp(); t.after(() => app.cleanup()); const node = app.node('room-occupancy');
  empty(node); assert.deepEqual(node.attributes, {}); await app.join(); empty(node);
  publish(app.clients[0]!); shown(node, summary(3, 1, 2)); assert.equal(app.node('room-occupancy'), node);
  assert.deepEqual(node.attributes, {}); assert.equal(node.children.length, 0);
});
for (const viewer of ['audience', 'speaker', 'controller'] as const)
  for (const status of ['waiting', 'live'] as const)
    for (const controllerOnStage of [false, true])
      for (const caps of [[300, 8], [3, 1]] as const) {
        it(`embed occupancy ${viewer}/${status}/controller-${controllerOnStage}/caps-${caps} counts all noncontroller seats`, async t => {
          const { sdk, node } = await double(t); sdk.setStatus(status);
          const state = snapshot({ viewer, controllerOnStage, maxAudience: caps[0], maxSpeakers: caps[1] });
          state.hands = [person('raised-1'), person('raised-2')];
          for (const p of [...state.speakers, ...state.hands]) { p.connected = false; p.muted = p.forceMuted = true; }
          publish(sdk, state); shown(node, summary(3, 1, 2, controllerOnStage, ...caps));
        });
      }
for (const controllerOnStage of [false, true]) it(`embed occupancy controller-only room, onstage=${controllerOnStage}`, async t => {
  const { sdk, node } = await double(t); publish(sdk, snapshot({ viewer: 'controller', audience: 0, stage: 0, controllerOnStage }));
  shown(node, summary(0, 0, 0, controllerOnStage));
});

it('embed occupancy has no ACK/status-only data and stays stale until a new actual state identity', async t => {
  const { sdk, node } = await double(t); empty(node);
  sdk.setStatus('reconnecting'); sdk.setStatus('live'); empty(node);
  const first = snapshot(); sdk.state = first; sdk.me = first.me; sdk.setStatus('waiting'); empty(node);
  sdk.emit('state', snapshot({ audience: 9 })); empty(node);
  publish(sdk, first); shown(node, summary(3, 1, 2));
  sdk.setStatus('reconnecting'); shown(node, summary(3, 1, 2, true, 300, 8, '重新連線中，上次快照'));
  first.audienceCount = 99; sdk.setStatus('live'); shown(node, summary(3, 1, 2, true, 300, 8, '上次快照'));
  publish(sdk, first); shown(node, summary(3, 1, 2, true, 300, 8, '上次快照'));
  publish(sdk, snapshot({ audience: 4 })); shown(node, summary(5, 1, 4));
  publish(sdk, first); shown(node, summary(5, 1, 4));
});

it('embed occupancy retains immutable primitive counts, reads no private payload fields and adds no side effects', async t => {
  const { app, sdk, node } = await double(t), state = snapshot();
  for (const key of ['code', 'resumeToken', 'audience', 'connectionId', 'sdp', 'quality', 'error'])
    Object.defineProperty(state, key, { get() { throw new Error(`private ${key} read`); } });
  Object.freeze(state.me); for (const p of state.speakers) Object.freeze(p);
  Object.freeze(state.speakers); Object.freeze(state.hands); Object.freeze(state.limits); Object.freeze(state);
  publish(sdk, state); shown(node, summary(3, 1, 2));
  const writes = instrument(node), timers = app.clock.metrics;
  app.node('name').value = 'unsent draft'; app.node('room-name-draft').value = 'another draft';
  const commands = () => [sdk.actions.length, sdk.moderations.length, sdk.stageModerations.length, sdk.transfers.length,
    sdk.closes.length, sdk.deviceLists.length, sdk.inputSelections.length, sdk.retryCalls, app.clients.length];
  const before = commands();
  for (const type of ['hand', 'stagejoined', 'stageleft', 'role', 'transferred', 'name', 'roomname', 'quality', 'speaking', 'micready', 'ack', 'error'])
    sdk.emit(type, { participantId: 'unrelated', fromId: 'unrelated', toId: 'unrelated', role: 'speaker', raised: false, message: 'safe error', code: 'test' });
  shown(node, summary(3, 1, 2)); assert.deepEqual(writes, { textContent: 0, hidden: 0 });
  assert.deepEqual(commands(), before); assert.deepEqual(app.clock.metrics, timers);
  assert.equal(app.node('name').value, 'unsent draft'); assert.equal(app.node('room-name-draft').value, 'another draft');
  assert.doesNotMatch(node.textContent, /Private|PRIVATE|listener|controller|speaker-/);
  assert.deepEqual(node.attributes, {});
});

const invalid: [string, (state: RoomStatePayload) => void][] = [
  ...[-1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined].map(value => [`audience ${String(value)}`, (s: RoomStatePayload) => { Reflect.set(s, 'audienceCount', value); }] as [string, (s: RoomStatePayload) => void]),
  ...['maxAudience', 'maxSpeakers'].flatMap(key => [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '3', undefined].map(value => [`${key} ${String(value)}`, (s: RoomStatePayload) => { Reflect.set(s.limits, key, value); }] as [string, (s: RoomStatePayload) => void])),
  ['missing limits', s => { Reflect.deleteProperty(s, 'limits'); }], ['array limits', s => { Reflect.set(s, 'limits', []); }],
  ['room cap exceeded', s => { s.limits.maxAudience = 2; }], ['stage cap exceeded', s => { s.speakers.push(person('speaker-1', 'speaker')); s.limits.maxSpeakers = 1; }],
  ['invalid speakers', s => { Reflect.set(s, 'speakers', {}); }], ['missing speakers', s => { Reflect.deleteProperty(s, 'speakers'); }],
  ['null speaker', s => { Reflect.set(s.speakers, '0', null); }], ['duplicate id', s => { s.speakers.push({ ...s.speakers[1]! }); }],
  ['empty speaker id', s => { s.speakers[0]!.participantId = ''; }], ['whitespace speaker id', s => { s.speakers[0]!.participantId = ' '; }],
  ['audience onstage', s => { s.speakers[0]!.role = 'audience'; }], ['offstage speaker', s => { s.speakers[1]!.onStage = false; }],
  ['wrong controller id', s => { s.controllerId = 'someone-else'; }], ['second controller', s => { s.speakers[1]!.role = 'controller'; }],
  ['controller marked speaker', s => { s.speakers[0]!.role = 'speaker'; }],
  ...['roomId', 'controllerId'].flatMap(key => ['', ' ', undefined, 7].map(value => [`${key} ${String(value)}`, (s: RoomStatePayload) => { Reflect.set(s, key, value); }] as [string, (s: RoomStatePayload) => void])),
  ...['', ' ', undefined, 7].map(value => [`participantId ${String(value)}`, (s: RoomStatePayload) => { Reflect.set(s.me, 'participantId', value); }] as [string, (s: RoomStatePayload) => void]),
];
for (const [name, mutate] of invalid) it(`embed occupancy invalid ${name} clears only the local paragraph and cannot replay into validity`, async t => {
  const { app, sdk, node } = await double(t); publish(sdk); const bad = snapshot(); mutate(bad);
  publish(sdk, bad); empty(node); assert.equal(app.leave.disabled, false); assert.equal(app.hand.disabled, false);
  Object.assign(bad, snapshot()); publish(sdk, bad); empty(node);
  publish(sdk); shown(node, summary(3, 1, 2));
});

for (const terminal of ['leave', 'disconnected', 'closed', 'shutdown', 'kicked', 'new-entry'] as const)
  it(`embed occupancy retires ${terminal}, ignores old callbacks and permits a distinct new entry`, async t => {
    const { app, sdk, node } = await double(t); const old = snapshot(); publish(sdk, old);
    if (terminal === 'leave') app.leave.click();
    else if (terminal === 'disconnected') sdk.setStatus('disconnected');
    else if (terminal === 'new-entry') app.form.submit();
    else sdk.emit(terminal === 'shutdown' ? 'closed' : terminal, { reason: terminal === 'shutdown' ? 'shutdown' : undefined });
    empty(node); const status = app.status.textContent;
    sdk.setStatus('live'); publish(sdk, old); sdk.emit('closed', {}); sdk.emit('kicked', {}); empty(node);
    if (terminal !== 'new-entry' && terminal !== 'disconnected') assert.equal(app.status.textContent, status);
    if (terminal === 'new-entry') { await flush(); publish(app.clients.at(-1)!); }
    else { const next = await app.join(); publish(next); }
    shown(node, summary(3, 1, 2));
    publish(sdk); sdk.setStatus('disconnected'); sdk.emit('closed', {}); shown(node, summary(3, 1, 2));
  });
for (const boundary of ['room', 'participant', 'missing-state'] as const) it(`embed occupancy retires ${boundary} identity before status and rejects earlier receipt revival`, async t => {
  const { sdk, node } = await double(t); const old = snapshot(); publish(sdk, old);
  const next = snapshot({ roomId: boundary === 'room' ? 'replacement-room' : 'same-room', participantId: boundary === 'participant' ? 'replacement-seat' : 'listener' });
  sdk.state = boundary === 'missing-state' ? null : next; sdk.setStatus('reconnecting'); empty(node);
  sdk.state = old; sdk.me = old.me; sdk.setStatus('live'); publish(sdk, old); empty(node);
  publish(sdk, next); shown(node, summary(3, 1, 2));
});
it('embed occupancy no-state cancellation and import failure never invent a count report', async t => {
  const load = new Deferred(), app = embedApp({ libraryLoad: load.promise }); t.after(() => app.cleanup());
  app.form.submit(); empty(app.node('room-occupancy')); app.node('cancel-join').click(); load.resolve(); await flush();
  empty(app.node('room-occupancy')); assert.equal(app.clients.length, 0);
  const failed = embedApp({ libraryLoad: Promise.reject(new Error('load failed')) }); t.after(() => failed.cleanup());
  failed.form.submit(); await flush(); empty(failed.node('room-occupancy')); assert.equal(failed.submit.disabled, false);
});

for (const property of ['textContent', 'hidden'] as const)
  for (const action of ['state', 'reconnect', 'disconnected', 'closed', 'kicked', 'leave', 'submit'] as const)
    it(`embed occupancy ${property} setter reentry into ${action} cannot restore outer report or entry controls`, async t => {
      const { app, sdk, node } = await double(t); let entered = false;
      instrument(node, key => {
        if (entered || key !== property) return; entered = true;
        if (action === 'state') publish(sdk, snapshot({ audience: 4 }));
        else if (action === 'reconnect') sdk.setStatus('reconnecting');
        else if (action === 'disconnected') sdk.setStatus('disconnected');
        else if (action === 'closed' || action === 'kicked') sdk.emit(action, {});
        else if (action === 'leave') app.leave.invoke();
        else app.form.submit();
      });
      publish(sdk); assert.equal(entered, true);
      if (action === 'state') shown(node, summary(5, 1, 4));
      else if (action === 'reconnect') shown(node, summary(3, 1, 2, true, 300, 8, '重新連線中，上次快照'));
      else empty(node);
      if (action === 'submit') {
        assert.equal(app.submit.disabled, true); assert.equal(app.node('cancel-join').hidden, false);
        await flush(); assert.equal(app.clients.length, 2); assert.notEqual(app.clients[1], sdk);
        publish(app.clients[1]!, snapshot({ audience: 4 })); shown(node, summary(5, 1, 4)); assert.equal(app.leave.disabled, false);
      }
    });
for (const property of ['textContent', 'hidden'] as const)
  for (const retirement of ['leave', 'closed', 'kicked', 'disconnected', 'submit'] as const)
    it(`embed occupancy ${property} clearing during ${retirement} preserves a synchronously newer form entry`, async t => {
      const { app, sdk, node } = await double(t); publish(sdk); let entered = false;
      instrument(node, key => { if (entered || key !== property) return; entered = true; app.form.submit(); });
      if (retirement === 'leave') app.leave.click();
      else if (retirement === 'submit') app.form.submit();
      else if (retirement === 'disconnected') sdk.setStatus('disconnected');
      else sdk.emit(retirement, {});
      assert.equal(entered, true); assert.equal(app.submit.disabled, true); assert.equal(app.node('cancel-join').hidden, false);
      await flush(); assert.equal(app.clients.length, 2); publish(app.clients[1]!, snapshot({ audience: 4 }));
      shown(node, summary(5, 1, 4)); assert.equal(app.leave.disabled, false); assert.equal(app.submit.disabled, false);
    });

it('embed occupancy equal fresh snapshots have zero additional paragraph writes', async t => {
  const { sdk, node } = await double(t); publish(sdk); const writes = instrument(node);
  for (let i = 0; i < 20; i++) publish(sdk);
  assert.deepEqual(writes, { textContent: 0, hidden: 0 });
});

for (const property of ['textContent', 'hidden'] as const)
  for (const change of ['room', 'participant', 'disconnected', 'reconnecting'] as const)
    it(`embed occupancy reconciles silent ${change} inside ${property} immediately`, async t => {
      const { sdk, node } = await double(t); let entered = false;
      if (property === 'textContent') publish(sdk, snapshot({ audience: 1 }));
      instrument(node, key => {
        if (entered || key !== property) return; entered = true;
        if (change === 'room') sdk.state = { ...sdk.state!, roomId: 'replacement-room' };
        else if (change === 'participant') { sdk.state = { ...sdk.state!, me: { ...sdk.me!, participantId: 'replacement-seat' } }; sdk.me = sdk.state.me; }
        else sdk.status = change;
      });
      publish(sdk); assert.equal(entered, true);
      if (change === 'reconnecting') shown(node, summary(3, 1, 2, true, 300, 8, '重新連線中，上次快照'));
      else empty(node);
      if (change === 'disconnected') { sdk.setStatus('live'); publish(sdk); empty(node); }
    });
for (const rejection of ['reconnecting', 'wrong-detail'] as const) it(`embed occupancy never promotes a previously ${rejection} receipt into fresh data`, async t => {
  const { sdk, node } = await double(t), rejected = snapshot({ audience: 4 }); publish(sdk);
  if (rejection === 'reconnecting') { sdk.setStatus('reconnecting'); publish(sdk, rejected); }
  else sdk.emit('state', rejected);
  sdk.state = rejected; sdk.me = rejected.me; sdk.setStatus('live'); sdk.emit('state', rejected);
  shown(node, summary(3, 1, 2, true, 300, 8, rejection === 'reconnecting' ? '上次快照' : '最近快照'));
  publish(sdk, snapshot({ audience: 4 })); shown(node, summary(5, 1, 4));
});

async function pipeline(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.controllerGraceMs = 60_000; c.rooms.participantGraceMs = 15000; c.rooms.presenceBroadcastMs = 0; c.limits.maxAudiencePerRoom = 3; c.limits.maxSpeakersPerRoom = 1; c.limits.controlPerSecond = 2000; c.limits.handRaiseIntervalMs = 0; });
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
    const session: Session = { id: `embed-occupancy-${++sequence}`,
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


it('embed occupancy real SDK → validator → Hub/Room matches independent membership ledger through all capacity and moderation transitions', async t => {
  const f = await pipeline(t), node = f.h.node('room-occupancy');
  const ledger = new Map<string, { role: ParticipantView['role']; onStage: boolean }>([
    [f.host.id, { role: 'controller', onStage: true }], [f.pid, { role: 'audience', onStage: false }],
  ]);
  const check = (): void => {
    const members = [...ledger.values()];
    shown(node, summary(members.filter(p => p.role !== 'controller').length,
      members.filter(p => p.role !== 'controller' && p.onStage).length, members.filter(p => p.role === 'audience').length,
      members.some(p => p.role === 'controller' && p.onStage), 3, 1));
  };
  check(); const guest = new FakeSession(), queued = new FakeSession(), overflow = new FakeSession();
  for (const s of [guest, queued, overflow]) f.server.hub.attach(s);
  for (const s of [guest, queued]) {
    assert.equal(await f.req(s, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Private guest' }), 'ok');
    ledger.set(s.last('room:state')!.me.participantId, { role: 'audience', onStage: false });
  }
  await f.flushStates(); check();
  const gid = guest.last('room:state')!.me.participantId, qid = queued.last('room:state')!.me.participantId;
  assert.equal(await f.req(overflow, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Overflow' }), 'room_full'); check();
  const raise = f.client.raiseHand(); await f.drain(); await raise; check();
  const withdraw = f.client.withdrawHand(); await f.drain(); await withdraw; check();
  assert.equal(await f.req(guest, { type: 'hand:raise' }), 'ok'); await f.drain(); check();
  assert.equal(await f.req(f.host.s, { type: 'stage:reject', targetId: gid }), 'ok'); await f.drain(); check();
  assert.equal(await f.req(f.host.s, { type: 'stage:leave' }), 'ok'); ledger.get(f.host.id)!.onStage = false; await f.drain(); check();
  await f.controller(); ledger.set(f.host.id, { role: 'audience', onStage: false }); ledger.set(f.pid, { role: 'controller', onStage: false }); check();
  const returnToStage = f.client.returnToStage(); await f.drain(); await returnToStage; ledger.get(f.pid)!.onStage = true; check();
  assert.equal(await f.req(guest, { type: 'hand:raise' }), 'ok'); await f.drain();
  const approve = f.client.approve(gid); await f.drain(); await approve; ledger.set(gid, { role: 'speaker', onStage: true }); check();
  assert.equal(await f.req(queued, { type: 'hand:raise' }), 'ok'); await f.drain(); check();
  const full = f.client.approve(qid).then(() => 'ok', error => error.code); await f.drain(); assert.equal(await full, 'stage_full'); check();
  const reject = f.client.reject(qid); await f.drain(); await reject; check();
  const leaveStage = f.client.leaveStage(); await f.drain(); await leaveStage; ledger.get(f.pid)!.onStage = false; check();
  const remove = f.client.removeFromStage(gid); await f.drain(); await remove; ledger.set(gid, { role: 'audience', onStage: false }); check();
  const raiseAgain = f.client.raiseHand().then(() => 'ok', error => error.code); await f.drain(); assert.equal(await raiseAgain, 'conflict'); check();
  await f.server.hub.detach(guest, true); ledger.delete(gid); await f.flushStates(); check();
  for (const type of ['join', 'hand:raise', 'hand:withdraw', 'stage:approve', 'stage:reject', 'stage:leave', 'stage:remove'])
    assert.ok(f.validated.some(message => message.type === type), `actual SDK frame ${type} passed validator into Hub`);
});

for (const held of ['audience', 'hand', 'speaker'] as const) it(`embed occupancy actual ${held} held seat, token resume and expiry obey model membership`, async t => {
  const f = await pipeline(t), guest = new FakeSession(); f.server.hub.attach(guest);
  assert.equal(await f.req(guest, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Held private member' }), 'ok');
  await f.flushStates(); const initial = guest.last('room:state')!, id = initial.me.participantId, node = f.h.node('room-occupancy');
  if (held !== 'audience') { assert.equal(await f.req(guest, { type: 'hand:raise' }), 'ok'); await f.drain(); }
  if (held === 'speaker') { assert.equal(await f.req(f.host.s, { type: 'stage:approve', targetId: id }), 'ok'); await f.drain(); }
  const seats = held === 'speaker' ? summary(2, 1, 1, true, 3, 1) : summary(2, 0, 2, true, 3, 1);
  shown(node, seats); await f.server.hub.detach(guest); await f.flushStates(); shown(node, seats);
  if (held === 'hand') assert.equal(f.client.state!.hands.find(p => p.participantId === id)!.connected, false);
  if (held === 'speaker') assert.equal(f.client.state!.speakers.find(p => p.participantId === id)!.connected, false);
  const resumed = new FakeSession(); f.server.hub.attach(resumed);
  assert.equal(await f.req(resumed, { type: 'join', roomId: f.host.roomId, code: f.host.code, resumeToken: initial.resumeToken, name: 'Resumed private member' }), 'ok');
  assert.equal(resumed.last('room:state')!.me.participantId, id); await f.flushStates(); shown(node, seats);
  await f.server.hub.detach(resumed); await f.flushStates(); shown(node, seats);
  const expiry = f.server.timers.find(timer => !timer.cleared && timer.ms === f.config.rooms.participantGraceMs)!;
  assert.ok(expiry); expiry.cleared = true; expiry.fn(); await nextTurn(); await f.flushStates();
  shown(node, summary(1, 0, 1, true, 3, 1));
});
for (const onStage of [false, true]) it(`embed occupancy actual offline controller onstage=${onStage} retained until controller expiry`, async t => {
  const f = await pipeline(t), node = f.h.node('room-occupancy');
  if (!onStage) { assert.equal(await f.req(f.host.s, { type: 'stage:leave' }), 'ok'); await f.drain(); }
  shown(node, summary(1, 0, 1, onStage, 3, 1));
  const token = f.host.s.last('room:state')!.resumeToken;
  await f.server.hub.detach(f.host.s); await f.flushStates(); shown(node, summary(1, 0, 1, onStage, 3, 1));
  const resumed = new FakeSession(); f.server.hub.attach(resumed);
  assert.equal(await f.req(resumed, { type: 'join', roomId: f.host.roomId, code: f.host.code, resumeToken: token, name: 'Resumed controller' }), 'ok');
  await f.flushStates(); assert.equal(resumed.last('room:state')!.me.participantId, f.host.id);
  shown(node, summary(1, 0, 1, onStage, 3, 1));
  await f.server.hub.detach(resumed); await f.flushStates();
  const expiry = f.server.timers.find(timer => !timer.cleared && timer.ms === f.config.rooms.controllerGraceMs)!;
  assert.ok(expiry); expiry.cleared = true; expiry.fn(); await nextTurn(); await f.flushStates();
  assert.equal(f.client.me!.role, 'controller'); shown(node, summary(0, 0, 0, false, 3, 1));
});

it('embed occupancy actual SDK status-before-state and reconnect retain primitives without new media/control work', async t => {
  const f = await pipeline(t), node = f.h.node('room-occupancy');
  shown(node, summary(1, 0, 1, true, 3, 1));
  const metrics = () => [f.validated.length, StageSocket.instances.length, StagePeer.instances.length, StageContext.instances.length,
    f.h.captures.length, f.h.enumerations.length, f.h.sinks.length, f.h.audio.plays, f.h.calls()];
  const before = metrics(), writes = instrument(node), events: string[] = [];
  f.client.on('status', () => events.push('status')); f.client.on('state', () => events.push('state'));
  // A no-op server snapshot is still a new SDK receipt, with no additional media/command work.
  const current = f.client.state!; f.socket.deliver({ type: 'room:state', ...current }); await flush();
  assert.deepEqual(metrics(), before); assert.deepEqual(writes, { textContent: 0, hidden: 0 });
  assert.equal(await f.req(f.host.s, { type: 'stage:leave' }), 'ok'); await f.drain();
  assert.deepEqual(events.slice(-2), ['status', 'state']); shown(node, summary(1, 0, 1, false, 3, 1));
  f.socket.close(); await f.drain(); shown(node, summary(1, 0, 1, false, 3, 1, '重新連線中，上次快照'));
});

for (const terminal of ['closed', 'shutdown', 'kicked'] as const) it(`embed occupancy actual disconnected → replacement entry → old ${terminal} cannot overwrite replacement`, async t => {
  const f = await pipeline(t), node = f.h.node('room-occupancy'); let entered = false;
  f.client.on('status', ({ detail }) => { if (detail === 'disconnected' && !entered) { entered = true; f.h.form.submit(); } });
  f.socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: f.host.roomId }
    : { type: 'room:closed', roomId: f.host.roomId, ...(terminal === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
  await flush(); assert.equal(entered, true); empty(node); assert.equal(f.h.clients.length, 2);
  assert.equal(f.h.status.textContent, '連線中…'); assert.equal(f.h.form.submitButton!.disabled, true); assert.equal(f.h.node('cancel-join').hidden, false);
  const replacement = StageSocket.instances.at(-1)!; f.bind(replacement);
  await f.h.until(() => f.h.clients[1]?.me != null, 'replacement receives authoritative state'); await f.drain();
  assert.equal(node.hidden, false); const text = node.textContent, status = f.h.status.textContent;
  f.socket.deliver({ type: 'room:closed', roomId: f.host.roomId }); await flush();
  shown(node, text); assert.equal(f.h.status.textContent, status); assert.equal(f.h.leave.disabled, false);
});
function transferButton(app: ReturnType<typeof embedApp>): EmbedNode {
  const button = app.node('stage-management-list').children[0]?.children[1]?.children[2]; assert.ok(button); return button;
}
for (const property of ['textContent', 'hidden'] as const)
  for (const retirement of ['leave', 'closed', 'kicked', 'disconnected', 'submit'] as const)
    it(`embed occupancy ${retirement} disarms Close and Transfer before ${property} clearing`, async t => {
      const { app, sdk, node } = await double(t, { confirm: () => true }); publish(sdk, snapshot({ viewer: 'controller' }));
      const close = app.node('close-room'), transfer = transferButton(app); let entered = false;
      instrument(node, key => { if (entered || key !== property) return; entered = true; close.invoke(); transfer.invoke(); });
      if (retirement === 'leave') app.leave.click();
      else if (retirement === 'submit') app.form.submit();
      else if (retirement === 'disconnected') sdk.setStatus('disconnected');
      else sdk.emit(retirement, {});
      assert.equal(entered, true); empty(node); assert.equal(app.confirmations.length, 0);
      assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
    });
for (const event of ['role', 'transferred'] as const) it(`embed occupancy ${event} notification adds no new paint and retains both action fences`, async t => {
  const { app, sdk, node } = await double(t, { confirm: () => true }); publish(sdk, snapshot({ viewer: 'controller' }));
  const close = app.node('close-room'), transfer = transferButton(app), writes = instrument(node);
  sdk.emit(event, event === 'role' ? { participantId: 'controller', role: 'audience' } : { fromId: 'controller', toId: 'speaker-0' });
  close.invoke(); transfer.invoke();
  assert.deepEqual(writes, { textContent: 0, hidden: 0 }); assert.equal(app.confirmations.length, 0);
  assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
});
for (const command of ['close', 'transfer'] as const)
  for (const property of ['textContent', 'hidden'] as const)
    for (const invalidation of ['connectivity', 'role', 'identity', 'capability', 'reconnect', 'target-removal'] as const)
      it(`embed occupancy ${command} pending ${invalidation} consent is invalid before ${property} transient restoration`, async t => {
        let invalidate = (): void => {};
        const { app, sdk, node } = await double(t, { confirm: () => { invalidate(); return true; } });
        publish(sdk, snapshot({ viewer: 'controller' })); const close = app.node('close-room'), transfer = transferButton(app);
        const method = command === 'close' ? 'closeRoom' : 'transferControl', original = sdk[method];
        const restored = snapshot({ viewer: 'controller' }), bad = snapshot({ viewer: 'controller', audience: 1 });
        if (invalidation === 'connectivity') {
          if (command === 'close') bad.me.connected = false; else bad.speakers[1]!.connected = false;
        } else if (invalidation === 'role') {
          if (command === 'close') bad.me.role = 'audience'; else bad.speakers[1]!.role = 'audience';
        } else if (invalidation === 'identity') bad.roomId = 'replacement-room';
        else if (invalidation === 'target-removal') {
          if (command === 'close') bad.me.role = 'audience'; else bad.speakers.splice(1);
        }
        if (property === 'hidden') bad.audienceCount = -1;
        let entered = false;
        instrument(node, key => {
          if (entered || key !== property) return; entered = true;
          Reflect.set(sdk, method, original); sdk.status = 'live'; publish(sdk, restored);
        });
        invalidate = () => {
          if (invalidation === 'capability') Reflect.set(sdk, method, undefined);
          if (invalidation === 'reconnect') {
            if (property === 'hidden') { sdk.state = { ...bad, roomId: 'replacement-room' }; sdk.me = bad.me; }
            sdk.setStatus('reconnecting');
          } else publish(sdk, bad);
        };
        (command === 'close' ? close : transfer).click(); await flush();
        assert.equal(entered, true); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
        assert.equal(app.confirmations.length, 1, 'no nested consent dialog');
      });
it('embed occupancy actual SDK explicit disconnect removes its seat without a grace-period phantom', async t => {
  const f = await pipeline(t), guest = await f.sdkGuest(), node = f.h.node('room-occupancy'); await f.flushStates();
  shown(node, summary(2, 0, 2, true, 3, 1)); await guest.client.disconnect(); await f.drain(); await f.flushStates();
  shown(node, summary(1, 0, 1, true, 3, 1));
  assert.ok(f.closes.some(close => close.socket === guest.socket && close.code === 1000));
});
