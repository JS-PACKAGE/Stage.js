import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { silentLogger } from '../src/log.ts';
import { ERROR_MESSAGES } from '../src/model/errors.ts';
import type { Room } from '../src/model/room.ts';
import type { Session } from '../src/ws/hub.ts';
import { createStageServer } from '../src/ws/server.ts';
import { FakeSession, harness, testConfig, type Harness } from './helpers.ts';

type State = Extract<ServerMessage, { type: 'room:state' }>;
type Timer = Harness['timers'][number];
type Request = Parameters<Harness['req']>[1];
type Runtime = {
  room: Room;
  sessions: Map<string, Session>;
  stateTimer: Timer | undefined;
  stateTimerDelay: number | undefined;
  graceTimer: Timer | undefined;
  lastStatus: 'waiting' | 'live';
};

// Retain one complete client snapshot during setup, rather than every 301-seat broadcast.
class RetainedSession extends FakeSession {
  state!: State;
  capture = false;
  readonly wires: string[] = [];
  override send(message: ServerMessage, encoded?: string): void {
    const wire = encoded ?? JSON.stringify(message);
    const parsed = JSON.parse(wire) as ServerMessage;
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(message)));
    if (parsed.type === 'room:state') this.state = parsed;
    if (this.capture) {
      this.wires.push(wire);
      super.send(parsed);
    } else if (parsed.type === 'ok' || parsed.type === 'error') {
      super.clear();
      super.send(parsed);
    }
  }
  override clear(): void {
    super.clear();
    this.wires.length = 0;
    this.capture = true;
  }
  get participantId(): string { return this.state.me.participantId; }
}

const liveTimers = (h: Pick<Harness, 'timers'>) => h.timers.filter(timer => !timer.cleared);
const types = (session: FakeSession) => session.inbox.map(message => message.type);
const runtime = (h: Pick<Harness, 'hub'>): Runtime => {
  const rooms = (h.hub as unknown as { rooms: Map<string, Runtime> }).rooms;
  assert.equal(rooms.size, 1);
  return [...rooms.values()][0]!;
};
const canonical = (room: Room, id: string) => JSON.stringify({ type: 'room:state', ...room.snapshot(id) });

function flushState(h: Pick<Harness, 'timers'>): void {
  for (const timer of liveTimers(h).filter(timer => timer.ms === 0 || timer.ms === 250)) {
    timer.cleared = true;
    timer.fn();
  }
}

function setup(t: TestContext) {
  const h = harness(testConfig(config => {
    config.rooms.presenceBroadcastMs = 250;
    config.rooms.qualityIntervalMs = 0;
  }));
  const sessions: RetainedSession[] = [];
  const connect = () => {
    const session = new RetainedSession();
    sessions.push(session);
    h.hub.attach(session);
    return session;
  };
  const request = (session: RetainedSession, message: Request) => h.req(session, message);
  t.after(async () => {
    await h.hub.shutdown();
    await h.transport.close();
    assert.equal(h.hub.roomCount, 0);
    assert.equal(h.transport.rooms.size, 0);
    assert.deepEqual(liveTimers(h), [], 'shutdown releases presence, hand and grace timers');
  });
  return {
    ...h, sessions, connect, request,
    clear: () => { for (const session of sessions) session.clear(); },
    async create() {
      const session = connect();
      assert.equal(await request(session, { type: 'room:create', name: 'Host', roomName: 'Room' }), 'ok');
      return session;
    },
    async join(host: RetainedSession, name: string, resumeToken?: string) {
      const session = connect();
      assert.equal(await request(session, { type: 'join', roomId: host.state.roomId, code: host.state.code, name,
        ...(resumeToken ? { resumeToken } : {}) }), 'ok');
      return session;
    },
  };
}

type Fixture = ReturnType<typeof setup>;
const rename = (h: Fixture, session: RetainedSession, name = 'Renamed') =>
  h.request(session, { type: 'participant:rename', name });

function assertPrivate(state: RoomStatePayload, room: Room, id: string): void {
  assert.equal(state.me.participantId, id);
  assert.equal(state.resumeToken, room.get(id)!.resumeToken);
  assert.equal('code' in state, id === room.controllerId);
  assert.equal('audience' in state, id === room.controllerId);
  if (id === room.controllerId) assert.equal(state.code, room.code);
  for (const person of [state.me, ...state.speakers, ...state.hands, ...(state.audience ?? [])]) {
    assert.equal('resumeToken' in person, false);
    assert.equal('code' in person, false);
  }
}

function assertCurrent(h: Fixture): void {
  const rt = runtime(h);
  for (const [id, recipient] of rt.sessions) {
    const session = recipient as RetainedSession;
    assert.equal(JSON.stringify(session.state), canonical(rt.room, id), 'retained full state equals the authoritative personalized model');
    assertPrivate(session.state, rt.room, id);
  }
}

function assertFanout(h: Fixture, requester: RetainedSession, recipients: RetainedSession[]): void {
  const room = runtime(h).room;
  for (const session of h.sessions) {
    const expected = session === requester ? ['room:state', 'ok'] : recipients.includes(session) ? ['room:state'] : [];
    assert.deepEqual(types(session), expected);
    const states = session.all('room:state');
    for (const state of states) assert.equal(JSON.stringify(state), canonical(room, session.participantId));
  }
  assertCurrent(h);
}

for (const speakers of [0, 8]) {
  test(`private audience rename preserves 299 complete snapshots at 301 seats, ${speakers + 1} stage seat${speakers ? 's' : ''} and 20 hands`, async t => {
    const h = setup(t), host = await h.create(), crowd: RetainedSession[] = [];
    for (let index = 0; index < 300; index++) crowd.push(await h.join(host, `A${String(index).padStart(3, '0')}`));
    for (const session of crowd.slice(0, speakers)) {
      assert.equal(await h.request(session, { type: 'hand:raise' }), 'ok');
      assert.equal(await h.request(host, { type: 'stage:approve', targetId: session.participantId }), 'ok');
    }
    for (const session of crowd.slice(speakers, speakers + 20)) assert.equal(await h.request(session, { type: 'hand:raise' }), 'ok');
    flushState(h);
    const rt = runtime(h), room = rt.room, requester = crowd.at(-1)!;
    assert.equal(room.participants.size, 301);
    assert.equal(room.speakers.size, speakers + 1);
    assert.equal(room.handQueue.length, 20);
    assertCurrent(h);
    const before = new Map(h.sessions.map(session => [session, canonical(room, session.participantId)]));
    const participants = [...room.participants], saved = structuredClone(participants);
    const shared = JSON.stringify(room.sharedSnapshot()), hands = [...room.handQueue], stage = [...room.speakers];
    const model = t.mock.method(room, 'rename'), invariants = t.mock.method(room, 'assertInvariants');
    const sharedCalls = t.mock.method(room, 'sharedSnapshot'), personalCalls = t.mock.method(room, 'personalSnapshot');
    const viewCalls = t.mock.method(room, 'view');
    const timers = [...h.timers], lastStatus = rt.lastStatus;
    h.clear();
    assert.equal(await rename(h, requester), 'ok');
    assert.equal(model.mock.callCount(), 1);
    assert.equal(model.mock.calls[0]!.result, true);
    assert.equal(invariants.mock.callCount(), 1, 'the private branch still validates the model transition');
    assert.equal(sharedCalls.mock.callCount(), 2);
    assert.equal(personalCalls.mock.callCount(), 2);
    assert.equal(viewCalls.mock.callCount(), 344 + speakers);
    sharedCalls.mock.restore(); personalCalls.mock.restore(); viewCalls.mock.restore();
    assertFanout(h, requester, [host]);
    let baselineBytes = 0, unchanged = 0;
    for (const session of h.sessions) {
      const current = canonical(room, session.participantId);
      baselineBytes += Buffer.byteLength(current);
      if (session === requester || session === host) assert.notEqual(current, before.get(session));
      else { assert.equal(current, before.get(session), 'every serialized field of an omitted observer remains identical'); unchanged++; }
      for (const wire of session.wires.filter(wire => JSON.parse(wire).type === 'room:state')) {
        assert.equal(wire, current, 'the full emitted state JSON is canonical, including private recipient fields');
      }
    }
    assert.equal(unchanged, 299);
    const stateWires = h.sessions.flatMap(session => session.wires.filter(wire => JSON.parse(wire).type === 'room:state'));
    const bytes = stateWires.reduce((total, wire) => total + Buffer.byteLength(wire), 0);
    assert.equal(stateWires.length, 2);
    assert.equal(h.sessions.reduce((total, session) => total + session.inbox.length, 0), 3);
    assert.ok(bytes / baselineBytes < 0.05, 'over 95% less state JSON than broadcasting the same full model to every seat');
    t.diagnostic(JSON.stringify({ seats: 301, stageSeats: speakers + 1, hands: 20, stateFrames: 2, fullFanoutStateFrames: 301,
      stateJsonBytes: bytes, fullFanoutStateJsonBytes: baselineBytes, reductionPercent: 100 * (1 - bytes / baselineBytes) }));
    assert.equal(JSON.stringify(room.sharedSnapshot()), shared);
    assert.deepEqual(room.handQueue, hands);
    assert.deepEqual([...room.speakers], stage);
    assert.equal(rt.lastStatus, lastStatus);
    assert.equal(rt.stateTimer, undefined);
    assert.deepEqual(h.timers, timers, 'private rename allocates no timer');
    for (const [id, participant] of participants) assert.equal(room.get(id), participant, 'identity-backed ownership remains intact');
    for (const [id, participant] of saved) assert.deepEqual(room.get(id), { ...participant, ...(id === requester.participantId ? { name: 'Renamed' } : {}) });
  });
}

for (const changed of [false, true]) {
  test(`settled private audience ${changed ? 'changed' : 'no-op'} rename still fails closed on invalid model state`, async t => {
    const h = setup(t), host = await h.create(), requester = await h.join(host, 'Requester');
    await h.join(host, 'Observer'); flushState(h);
    const room = runtime(h).room;
    const model = t.mock.method(room, 'rename'), invariants = t.mock.method(room, 'assertInvariants');
    room.handQueue.push('missing-participant');
    h.clear();
    assert.equal(await rename(h, requester, changed ? 'Changed' : 'Requester'), 'internal');
    assert.equal(model.mock.callCount(), 1); assert.equal(invariants.mock.callCount(), 1);
    assert.deepEqual(types(requester), ['room:closed', 'error']);
    assert.equal(requester.last('error')!.message, ERROR_MESSAGES.internal);
    for (const session of h.sessions.filter(session => session !== requester)) assert.deepEqual(types(session), ['room:closed']);
    assert.equal(h.hub.roomCount, 0); assert.equal(h.transport.rooms.size, 0); assert.deepEqual(liveTimers(h), []);
  });
}

for (const kind of ['presence', 'hand'] as const) {
  test(`private audience rename retains an exact pending ${kind} timer on no-op and flushes it on change`, async t => {
    const h = setup(t), host = await h.create(), requester = await h.join(host, 'Requester'), observer = await h.join(host, 'Observer');
    if (kind === 'hand') { flushState(h); assert.equal(await h.request(observer, { type: 'hand:raise' }), 'ok'); }
    const rt = runtime(h), pending = rt.stateTimer!, delay = rt.stateTimerDelay;
    assert.ok(pending);
    assert.equal(delay, kind === 'presence' ? 250 : 0);
    h.clear();
    assert.equal(await rename(h, requester, 'Requester'), 'ok');
    assert.deepEqual(types(requester), ['room:state', 'ok']);
    assert.deepEqual(types(host), []); assert.deepEqual(types(observer), []);
    assert.equal(JSON.stringify(requester.state), canonical(rt.room, requester.participantId));
    assert.equal(rt.stateTimer, pending); assert.equal(rt.stateTimerDelay, delay);
    assert.deepEqual(liveTimers(h), [pending]); assert.equal(pending.cleared, false);
    h.clear();
    assert.equal(await rename(h, requester), 'ok');
    assertFanout(h, requester, [host, observer]);
    assert.equal(pending.cleared, true);
    assert.equal(rt.stateTimer, undefined); assert.equal(rt.stateTimerDelay, undefined);
    h.clear(); flushState(h);
    for (const session of h.sessions) assert.deepEqual(session.inbox, [], 'the superseded flush never runs again');
  });
}

test('raised audience, speaker and on/off-stage controller changed names keep full fanout', async t => {
  const h = setup(t), host = await h.create(), speaker = await h.join(host, 'Speaker');
  await h.join(host, 'Observer');
  assert.equal(await h.request(speaker, { type: 'hand:raise' }), 'ok'); flushState(h);
  for (const [session, name] of [[speaker, 'Raised'], [host, 'On-stage controller']] as const) {
    h.clear(); assert.equal(await rename(h, session, name), 'ok'); assertFanout(h, session, h.sessions);
  }
  assert.equal(await h.request(host, { type: 'stage:approve', targetId: speaker.participantId }), 'ok');
  h.clear(); assert.equal(await rename(h, speaker, 'On-stage speaker'), 'ok'); assertFanout(h, speaker, h.sessions);
  assert.equal(await h.request(host, { type: 'stage:leave' }), 'ok');
  h.clear(); assert.equal(await rename(h, host, 'Off-stage controller'), 'ok'); assertFanout(h, host, h.sessions);
});

test('waiting-room private rename preserves status and status mismatch falls back to full reconciliation', async t => {
  const h = setup(t), host = await h.create(), requester = await h.join(host, 'Requester');
  await h.join(host, 'Observer');
  assert.equal(await h.request(host, { type: 'stage:leave' }), 'ok');
  const rt = runtime(h);
  assert.equal(rt.room.status, 'waiting');
  h.clear(); assert.equal(await rename(h, requester), 'ok'); assertFanout(h, requester, [host]);
  // Defensive fault injection exercises the guard, not a claim that status normally lags.
  rt.lastStatus = 'live';
  h.clear(); assert.equal(await rename(h, requester, 'Again'), 'ok');
  for (const session of h.sessions) {
    assert.deepEqual(types(session), session === requester ? ['room:state', 'status', 'ok'] : ['room:state', 'status']);
    assert.equal(session.last('status')!.state, 'waiting');
  }
  assertCurrent(h);
  assert.equal(rt.lastStatus, 'waiting');
  h.clear(); assert.equal(await rename(h, requester, 'Settled again'), 'ok'); assertFanout(h, requester, [host]);
});

for (const controllerOnStage of [true, false]) {
  test(`disconnected ${controllerOnStage ? 'on-stage' : 'off-stage'} controller is omitted and its resumed socket gets current private names`, async t => {
    const h = setup(t), host = await h.create(), requester = await h.join(host, 'Requester'), observer = await h.join(host, 'Observer');
    flushState(h);
    if (!controllerOnStage) assert.equal(await h.request(host, { type: 'stage:leave' }), 'ok');
    const token = host.state.resumeToken!;
    await h.hub.detach(host);
    const pending = runtime(h).stateTimer;
    assert.equal(Boolean(pending), !controllerOnStage);
    h.clear(); assert.equal(await rename(h, requester), 'ok');
    assertFanout(h, requester, controllerOnStage ? [] : [observer]);
    if (pending) assert.equal(pending.cleared, true);
    h.clear(); assert.equal(await rename(h, requester, 'Still private'), 'ok'); assertFanout(h, requester, []);
    const replacement = await h.join(host, 'Ignored host name', token);
    assert.equal(replacement.participantId, host.participantId);
    assert.equal(replacement.state.audience!.find(person => person.participantId === requester.participantId)!.name, 'Still private');
    flushState(h);
    h.clear(); assert.equal(await rename(h, requester, 'Resumed controller'), 'ok'); assertFanout(h, requester, [replacement]);
    const ownToken = requester.state.resumeToken!;
    await h.hub.detach(requester);
    const ownReplacement = await h.join(replacement, 'Ignored requester name', ownToken);
    assert.equal(ownReplacement.participantId, requester.participantId);
    assert.equal(ownReplacement.state.me.name, 'Resumed controller');
    flushState(h); h.clear();
    assert.equal(await rename(h, requester, 'Stale'), 'not_joined');
    assert.deepEqual(types(requester), ['error']);
    for (const session of h.sessions.filter(session => session !== requester)) assert.deepEqual(types(session), []);
    h.clear(); assert.equal(await rename(h, ownReplacement, 'Current requester'), 'ok'); assertFanout(h, ownReplacement, [replacement]);
  });
}

test('queued transfer, promotion and withdrawal choose the current controller and visibility without losing updates', async t => {
  const h = setup(t), host = await h.create(), requester = await h.join(host, 'Requester');
  const nextHost = await h.join(host, 'Next host'), witness = await h.join(host, 'Witness');
  flushState(h); h.clear();
  assert.deepEqual(await Promise.all([
    h.request(host, { type: 'control:transfer', targetId: nextHost.participantId }), rename(h, requester, 'After transfer'),
  ]), ['ok', 'ok']);
  assert.equal(runtime(h).room.controllerId, nextHost.participantId);
  assert.equal(nextHost.all('room:state').length, 2);
  assert.equal(requester.all('room:state').length, 2);
  assert.equal(host.all('room:state').length, 1);
  assert.equal(witness.all('room:state').length, 1);
  assert.equal(nextHost.state.audience!.find(person => person.participantId === requester.participantId)!.name, 'After transfer');
  assertCurrent(h);
  h.clear(); assert.equal(await rename(h, requester, 'Current controller only'), 'ok'); assertFanout(h, requester, [nextHost]);
  assert.equal(await h.request(requester, { type: 'hand:raise' }), 'ok'); flushState(h); h.clear();
  assert.deepEqual(await Promise.all([
    h.request(nextHost, { type: 'stage:approve', targetId: requester.participantId }), rename(h, requester, 'Speaker name'),
  ]), ['ok', 'ok']);
  for (const session of h.sessions) {
    assert.equal(session.all('room:state').length, 2);
    assert.equal(session.state.speakers.find(person => person.participantId === requester.participantId)!.name, 'Speaker name');
  }
  assertCurrent(h);
  assert.equal(await h.request(requester, { type: 'stage:leave' }), 'ok');
  assert.equal(await h.request(requester, { type: 'hand:raise' }), 'ok'); flushState(h); h.clear();
  assert.deepEqual(await Promise.all([
    h.request(requester, { type: 'hand:withdraw' }), rename(h, requester, 'Withdrawn name'),
  ]), ['ok', 'ok']);
  assert.deepEqual(types(requester), ['hand:withdraw', 'room:state', 'ok', 'room:state', 'ok']);
  for (const session of h.sessions.filter(session => session !== requester)) {
    assert.deepEqual(types(session), ['hand:withdraw', 'room:state']);
    assert.deepEqual(session.state.hands, []);
  }
  assert.equal(runtime(h).stateTimer, undefined); assertCurrent(h);
  h.clear(); assert.equal(await rename(h, requester, 'Private again'), 'ok'); assertFanout(h, requester, [nextHost]);
});

test('controller grace expiry queued before private rename targets the actual successor', async t => {
  const h = setup(t), host = await h.create(), successor = await h.join(host, 'Successor');
  const requester = await h.join(host, 'Requester'), witness = await h.join(host, 'Witness');
  flushState(h); await h.hub.detach(host);
  const grace = runtime(h).graceTimer!;
  assert.ok(grace); h.clear(); grace.cleared = true; grace.fn();
  assert.equal(await rename(h, requester, 'After expiry'), 'ok');
  assert.equal(runtime(h).room.controllerId, successor.participantId);
  assert.equal(successor.all('room:state').length, 2);
  assert.equal(witness.all('room:state').length, 1, 'transfer is broadcast, the later private name is not');
  assert.deepEqual(types(host), []);
  assert.equal(successor.state.audience!.find(person => person.participantId === requester.participantId)!.name, 'After expiry');
  assertCurrent(h);
});

test('queued kick and closure reject private rename with no successful state or live room resources', async t => {
  const h = setup(t), host = await h.create(), kicked = await h.join(host, 'Kicked'), remaining = await h.join(host, 'Remaining');
  flushState(h); h.clear();
  assert.deepEqual(await Promise.all([
    h.request(host, { type: 'participant:kick', targetId: kicked.participantId }), rename(h, kicked),
  ]), ['ok', 'not_joined']);
  assert.deepEqual(types(kicked), ['kicked', 'error']); assert.equal(kicked.closed!.code, 4001);
  assertCurrent(h); h.clear();
  assert.deepEqual(await Promise.all([h.request(host, { type: 'room:close' }), rename(h, remaining)]), ['ok', 'not_joined']);
  assert.deepEqual(types(remaining), ['room:closed', 'error']);
  assert.equal(h.hub.roomCount, 0); assert.equal(h.transport.rooms.size, 0); assert.deepEqual(liveTimers(h), []);
});

async function bounded<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

test('three localhost WebSocket clients receive only canonical self/controller rename states through a pong barrier', { timeout: 12000 }, async () => {
  const config = testConfig(c => {
    c.server.host = '127.0.0.1'; c.server.port = 0; c.server.static = [];
    c.rooms.qualityIntervalMs = 0; c.rooms.presenceBroadcastMs = 250;
  });
  const h = harness(config), sockets: WebSocket[] = [];
  const server = createStageServer({ config, hub: h.hub, log: silentLogger, baseDir: process.cwd() });
  try {
    const { port } = await bounded(server.listen(), 'server listen');
    const connect = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${config.server.wsPath}`), inbox: ServerMessage[] = [];
      sockets.push(ws);
      ws.on('message', data => inbox.push(JSON.parse(data.toString()) as ServerMessage));
      await bounded(once(ws, 'open'), 'socket open');
      const waitFor = (predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); ws.off('message', inspect); ws.off('close', closed); ws.off('error', failed); };
        const inspect = () => { const found = inbox.find(predicate); if (found) { cleanup(); resolve(found); } };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const closed = () => failed(new Error('socket closed before expected message'));
        const timer = setTimeout(() => failed(new Error('WebSocket response timed out')), 3000);
        ws.on('message', inspect); ws.once('close', closed); ws.once('error', failed); inspect();
      });
      const send = (message: unknown) => ws.send(JSON.stringify(message));
      const request = async (message: Request, requestId: string) => {
        send({ ...message, requestId });
        const reply = await waitFor(message => (message.type === 'ok' || message.type === 'error') && message.requestId === requestId);
        assert.equal(reply.type, 'ok');
      };
      const barrier = async () => {
        const index = inbox.length;
        send({ type: 'ping' });
        await waitFor(message => message.type === 'pong' && inbox.indexOf(message) >= index);
      };
      await waitFor(message => message.type === 'hello');
      return { inbox, request, barrier };
    };
    const host = await connect(), requester = await connect(), observer = await connect();
    const clients = [host, requester, observer];
    await host.request({ type: 'room:create', name: 'Host' }, 'create');
    const initial = host.inbox.find(message => message.type === 'room:state')!;
    assert.ok(initial.type === 'room:state');
    for (const [index, client] of [requester, observer].entries()) {
      await client.request({ type: 'join', roomId: initial.roomId, code: initial.code, name: `Audience ${index}` }, `join-${index}`);
    }
    flushState(h);
    await Promise.all(clients.map(client => client.barrier()));
    const before = clients.map(client => client.inbox.filter(message => message.type === 'room:state').at(-1)!);
    assert.ok(before.every(state => state.type === 'room:state'));
    for (const client of clients) client.inbox.length = 0;
    await requester.request({ type: 'participant:rename', name: '  e\u0301<&>🐱\u200b  ' }, 'private-rename');
    // After the requester ACK, pongs on each socket delimit all earlier queued server frames.
    await Promise.all(clients.map(client => client.barrier()));
    assert.deepEqual(requester.inbox.map(message => message.type), ['room:state', 'ok', 'pong']);
    assert.deepEqual(host.inbox.map(message => message.type), ['room:state', 'pong']);
    assert.deepEqual(observer.inbox.map(message => message.type), ['pong'], 'an ordering barrier proves absence without a timing sleep');
    const room = runtime(h).room;
    for (const [index, client] of clients.entries()) {
      const retained = client.inbox.find(message => message.type === 'room:state') ?? before[index]!;
      assert.ok(retained.type === 'room:state');
      assert.equal(JSON.stringify(retained), canonical(room, retained.me.participantId));
      assertPrivate(retained, room, retained.me.participantId);
      if (client === observer) assert.deepEqual(retained, before[index]);
    }
    const renamed = requester.inbox[0]!;
    assert.ok(renamed.type === 'room:state');
    assert.equal(renamed.me.name, 'é&lt;&amp;&gt;🐱');
    assert.equal(runtime(h).stateTimer, undefined);
  } finally {
    try { await bounded(server.close(), 'server close'); }
    finally {
      for (const socket of sockets) socket.terminate();
      await bounded(h.hub.shutdown(), 'hub shutdown');
      await bounded(h.transport.close(), 'transport close');
      assert.equal(h.hub.roomCount, 0);
      assert.equal(h.transport.rooms.size, 0);
      assert.deepEqual(liveTimers(h), []);
    }
  }
});
