import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { CLIENT_MESSAGE_TYPES, PROTOCOL_VERSION, type ParticipantView, type RoomStatePayload, type ServerMessage } from '../shared/protocol.ts';
import { createLogger, silentLogger } from '../src/log.ts';
import { ERROR_MESSAGES, InvariantViolation, StageError } from '../src/model/errors.ts';
import { Room } from '../src/model/room.ts';
import { createStageServer } from '../src/ws/server.ts';
import { parseClientMessage, ValidationError } from '../src/ws/validate.ts';
import { FakeSession, harness, RECVONLY_OFFER, SENDRECV_OFFER, sine, testConfig, type Harness } from './helpers.ts';

const limits = testConfig().limits;
const parseRename = (name: unknown, extra: Record<string, unknown> = {}, maxLength = limits.nameMaxLength) =>
  parseClientMessage(JSON.stringify({ type: 'participant:rename', requestId: 'rename', name, ...extra }), { ...limits, nameMaxLength: maxLength });
const liveTimers = (h: Harness) => h.timers.filter(timer => !timer.cleared);
const clear = (sessions: FakeSession[]) => { for (const session of sessions) session.clear(); };

function setup(t: TestContext, logLines?: string[]): Harness {
  const h = harness(testConfig(config => {
    config.rooms.presenceBroadcastMs = 250;
    config.rooms.qualityIntervalMs = 0;
  }), logLines ? createLogger('debug', line => logLines.push(line)) : undefined);
  t.after(async () => {
    await h.hub.shutdown();
    await h.transport.close();
    assert.equal(liveTimers(h).length, 0);
    assert.equal(h.transport.rooms.size, 0);
  });
  return h;
}

function flushState(h: Harness): void {
  for (const timer of liveTimers(h).filter(timer => timer.ms === 0 || timer.ms === 250)) {
    timer.cleared = true;
    timer.fn();
  }
}

function omitNames(state: RoomStatePayload): unknown {
  const view = ({ name: _name, ...person }: ParticipantView) => person;
  return { ...state, me: view(state.me), speakers: state.speakers.map(view), hands: state.hands.map(view),
    ...(state.audience ? { audience: state.audience.map(view) } : {}) };
}

function assertPrivate(state: RoomStatePayload, id: string, token: string | undefined, controllerId: string, code: string): void {
  assert.equal(state.me.participantId, id);
  assert.equal(state.resumeToken, token);
  assert.equal('code' in state, id === controllerId);
  assert.equal('audience' in state, id === controllerId);
  if (id === controllerId) assert.equal(state.code, code);
  for (const person of [state.me, ...state.speakers, ...state.hands, ...(state.audience ?? [])]) {
    assert.equal('resumeToken' in person, false);
    assert.equal('code' in person, false);
  }
}

test('rename is an additive protocol 1 request with no target or new server event', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(CLIENT_MESSAGE_TYPES.filter(type => type === 'participant:rename').length, 1);
  assert.deepEqual(parseRename('Self', { targetId: { malicious: true }, role: 'controller', resumeToken: 'other', extra: true }), {
    type: 'participant:rename', requestId: 'rename', name: 'Self',
  });
  assert.throws(() => parseClientMessage('{"type":"participant:rename-unsupported","requestId":"old-server"}', limits),
    error => error instanceof ValidationError && error.code === 'unknown_type' && error.requestId === 'old-server');
});

test('rename reuses NFC, Unicode code-point, control stripping and HTML-escaping validation', () => {
  const cases: [string, string, number][] = [
    ['  名字 🐱  ', '名字 🐱', 4],
    ['e\u0301', 'é', 1],
    ['🐱'.repeat(32), '🐱'.repeat(32), 32],
    ['\u0000A\u001f\u007f\u0085\u200b\u202e\u2066\u2028\u2029B\n', 'AB', 2],
    ['<&>"\'', '&lt;&amp;&gt;&quot;&#39;', 5],
    ['&lt;', '&amp;lt;', 4],
    ['字'.repeat(40), '字'.repeat(40), 40],
  ];
  for (const [raw, expected, maxLength] of cases) {
    assert.deepEqual(parseRename(raw, {}, maxLength), { type: 'participant:rename', requestId: 'rename', name: expected });
  }
});

test('rename requires a valid request id and a nonempty name within the configured cleaned limit', () => {
  for (const name of [undefined, null, false, 42, {}, [], '', ' \t\n ', '\u200b\u202e\u2028', '🐱'.repeat(33)]) {
    assert.throws(() => parseRename(name), error => error instanceof ValidationError && error.code === 'bad_request' && error.requestId === 'rename');
  }
  assert.throws(() => parseRename('🐱🐱', {}, 1), ValidationError);
  for (const requestId of [undefined, null, '', 'invalid id', 'x'.repeat(65)]) {
    assert.throws(() => parseRename('Valid', { requestId }), error => error instanceof ValidationError && error.code === 'bad_request' && error.requestId === undefined);
  }
});

function modelRoom(): Room {
  const room = new Room({ roomId: 'room', name: 'Room', code: 'CODE', codeRequired: true, now: 10,
    limits: { maxSpeakers: 8, maxAudience: 300 }, controller: { participantId: 'host', name: 'Host', resumeToken: 'host-token' } });
  for (const [index, id] of ['speaker1', 'speaker2', 'hand1', 'hand2', 'audience'].entries()) {
    room.join({ participantId: id, name: id, resumeToken: `${id}-token` }, 20 + index);
  }
  room.raiseHand('speaker1'); room.approve('host', 'speaker1', 100);
  room.raiseHand('speaker2'); room.approve('host', 'speaker2', 90);
  room.raiseHand('hand1'); room.raiseHand('hand2');
  room.mute('speaker1'); room.forceMute('host', 'speaker1'); room.setGain('host', 'speaker1', -4.5);
  room.get('audience')!.connected = false;
  return room;
}

test('Room.rename changes only the existing participant name and preserves every ordering and membership field', () => {
  const room = modelRoom();
  for (const id of ['host', 'speaker1', 'hand1', 'audience']) {
    const person = room.get(id)!;
    const before = structuredClone([...room.participants]);
    const speakers = [...room.speakers], hands = [...room.handQueue];
    const counts = [room.audienceCount, room.speakerCount, room.participants.size, room.status];
    assert.equal(room.rename(id, `${id} renamed`), true);
    assert.equal(room.get(id), person, 'identity-backed negotiation ownership stays on the same object');
    for (const [pid, saved] of before) assert.deepEqual(room.get(pid), { ...saved, ...(pid === id ? { name: `${id} renamed` } : {}) });
    assert.deepEqual([...room.speakers], speakers);
    assert.deepEqual(room.handQueue, hands);
    assert.deepEqual([room.audienceCount, room.speakerCount, room.participants.size, room.status], counts);
    assert.equal(room.pickSuccessor()!.participantId, 'speaker1');
    assert.equal(room.name, 'Room');
    assert.equal(room.rename(id, `${id} renamed`), false);
  }
  room.leaveStage('host');
  assert.equal(room.rename('host', 'Off-stage host'), true);
  assert.equal(room.get('host')!.role, 'controller');
  assert.equal(room.get('host')!.onStage, false);
  assert.throws(() => room.rename('missing', 'Name'), error => error instanceof StageError && error.code === 'not_found');
});

for (const changed of [false, true]) {
  test(`Room.rename checks invariants for ${changed ? 'changed' : 'unchanged'} names`, () => {
    const room = modelRoom();
    room.handQueue.push('missing');
    assert.throws(() => room.rename('host', changed ? 'Different' : 'Host'), InvariantViolation);
  });
}

test('every role can rename only itself with personalized state before ACK and no name-bearing event or log', async t => {
  const lines: string[] = [], h = setup(t, lines), host = await h.create();
  const speaker = await h.join(host.roomId, host.code, 'Speaker');
  const hand = await h.join(host.roomId, host.code, 'Hand');
  const audience = await h.join(host.roomId, host.code, 'Audience');
  const witness = await h.join(host.roomId, host.code, 'Witness');
  const people = [host, speaker, hand, audience, witness], sessions = people.map(person => person.s);
  await h.req(speaker.s, { type: 'hand:raise' });
  await h.req(host.s, { type: 'stage:approve', targetId: speaker.id });
  await h.req(speaker.s, { type: 'mic:mute' });
  await h.req(host.s, { type: 'mic:force-mute', targetId: speaker.id });
  await h.req(host.s, { type: 'mic:gain', targetId: speaker.id, gainDb: 3.5 });
  await h.req(hand.s, { type: 'hand:raise' });
  flushState(h);
  let savedStates = sessions.map(session => structuredClone(session.last('room:state')!));
  for (const person of people.slice(0, 4)) {
    const before = savedStates;
    const logCount = lines.length;
    clear(sessions);
    await h.hub.handle(person.s, parseRename(`  新<&>${person.id}  `, { targetId: witness.id }));
    const name = `新&lt;&amp;&gt;${person.id}`;
    const retainedStates = people.map((recipient, index) => {
      const omitted = person === audience && recipient !== person && recipient !== host;
      assert.deepEqual(recipient.s.inbox.map(message => message.type),
        recipient === person ? ['room:state', 'ok'] : omitted ? [] : ['room:state']);
      return structuredClone(recipient.s.last('room:state') ?? before[index]!);
    });
    for (const [index, recipient] of people.entries()) {
      const state = retainedStates[index]!;
      assert.deepEqual(omitNames(state), omitNames(before[index]!));
      assertPrivate(state, recipient.id, before[index]!.resumeToken, host.id, host.code);
      assert.equal(state.me.name, recipient === person ? name : before[index]!.me.name);
      const visible = [state.me, ...state.speakers, ...state.hands, ...(state.audience ?? [])].filter(view => view.participantId === person.id);
      for (const view of visible) assert.equal(view.name, name);
      if (person === audience && recipient !== person && recipient !== host) {
        assert.deepEqual(visible, [], 'an ordinary audience name remains private to itself and the controller');
        assert.equal(JSON.stringify(state).includes(name), false);
      }
    }
    assert.equal(lines.length, logCount, 'rename does not log either old or new display names');
    assert.equal(retainedStates[4]!.me.name, 'Witness', 'extraneous targetId is never a rename target');
    savedStates = retainedStates;
    const ownState = structuredClone(person.s.last('room:state')!);
    clear(sessions);
    await h.hub.handle(person.s, parseRename(`  新<&>${person.id}  `, { targetId: witness.id }));
    assert.deepEqual(person.s.inbox.map(message => message.type), ['room:state', 'ok']);
    assert.deepEqual(person.s.last('room:state'), ownState);
    for (const session of sessions.filter(session => session !== person.s)) assert.deepEqual(session.inbox, []);
  }
  await h.req(host.s, { type: 'stage:leave' });
  clear(sessions);
  assert.equal(await h.req(host.s, { type: 'participant:rename', name: 'Off-stage controller' }), 'ok');
  const state = host.s.last('room:state')!;
  assert.equal(state.me.name, 'Off-stage controller');
  assert.equal(state.me.role, 'controller');
  assert.equal(state.me.onStage, false);
  assert.deepEqual(host.s.inbox.map(message => message.type), ['room:state', 'ok']);
  for (const session of sessions.slice(1)) assert.deepEqual(session.inbox.map(message => message.type), ['room:state']);
});

test('canonical no-op names call Room and invariant checks, refreshing only the requester', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  await h.hub.handle(audience.s, parseRename('é<&>'));
  const before = structuredClone(audience.s.last('room:state')!);
  const rename = t.mock.method(Room.prototype, 'rename');
  const invariants = t.mock.method(Room.prototype, 'assertInvariants');
  clear([host.s, audience.s]);
  await h.hub.handle(audience.s, parseRename(' \u200be\u0301<&>\n '));
  assert.deepEqual(audience.s.inbox.map(message => message.type), ['room:state', 'ok']);
  assert.deepEqual(audience.s.last('room:state'), before);
  assert.deepEqual(host.s.inbox, []);
  assert.equal(rename.mock.callCount(), 1);
  assert.equal(invariants.mock.callCount(), 1);
  assert.equal(rename.mock.calls[0]!.result, false);
});

for (const kind of ['presence', 'hand'] as const) {
  for (const changed of [false, true]) {
    test(`${changed ? 'changed' : 'no-op'} rename ${changed ? 'flushes' : 'preserves'} a pending ${kind} snapshot`, async t => {
      const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
      if (kind === 'hand') await h.req(audience.s, { type: 'hand:raise' });
      const pending = liveTimers(h)[0]!;
      assert.equal(pending.ms, kind === 'hand' ? 0 : 250);
      clear([host.s, audience.s]);
      assert.equal(await h.req(host.s, { type: 'participant:rename', name: changed ? 'New Host' : 'Host' }), 'ok');
      assert.deepEqual(host.s.inbox.map(message => message.type), ['room:state', 'ok']);
      assert.equal(host.s.last('room:state')!.audienceCount, 1);
      assert.equal(host.s.last('room:state')!.hands.length, kind === 'hand' ? 1 : 0);
      if (changed) {
        assert.equal(pending.cleared, true);
        assert.deepEqual(liveTimers(h), []);
        assert.deepEqual(audience.s.inbox.map(message => message.type), ['room:state']);
        clear([host.s, audience.s]); flushState(h);
        assert.deepEqual(host.s.inbox, []); assert.deepEqual(audience.s.inbox, []);
      } else {
        assert.deepEqual(liveTimers(h), [pending]);
        assert.equal(liveTimers(h)[0], pending);
        assert.deepEqual(audience.s.inbox, []);
        clear([host.s, audience.s]); flushState(h);
        for (const session of [host.s, audience.s]) assert.deepEqual(session.inbox.map(message => message.type), ['room:state']);
      }
    });
  }
}

test('unjoined and queued kicked sessions cannot rename or receive success', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  const outsider = new FakeSession(); h.hub.attach(outsider); outsider.clear();
  assert.equal(await h.req(outsider, { type: 'participant:rename', name: 'Outsider' }), 'not_joined');
  assert.deepEqual(outsider.inbox.map(message => message.type), ['error']);
  assert.equal(outsider.last('error')!.message, ERROR_MESSAGES.not_joined);
  clear([host.s, audience.s]);
  const kick = h.req(host.s, { type: 'participant:kick', targetId: audience.id });
  const stale = h.req(audience.s, { type: 'participant:rename', name: 'Stale' });
  assert.deepEqual(await Promise.all([kick, stale]), ['ok', 'not_joined']);
  assert.deepEqual(audience.s.inbox.map(message => message.type), ['kicked', 'error']);
  assert.equal(audience.s.closed!.code, 4001);
  assert.equal(host.s.last('room:state')!.audienceCount, 0);
  assert.equal(h.hub.roomCount, 1);
});

test('resume preserves the renamed seat, and only the replacement session owns later renames', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  await h.req(audience.s, { type: 'hand:raise' });
  await h.req(audience.s, { type: 'participant:rename', name: 'Remember me' });
  const before = structuredClone(audience.s.last('room:state')!);
  await h.hub.detach(audience.s);
  const replacement = new FakeSession(); h.hub.attach(replacement);
  assert.equal(await h.req(replacement, { type: 'join', roomId: host.roomId, code: host.code, name: 'Ignored join name', resumeToken: before.resumeToken }), 'ok');
  assert.deepEqual(replacement.last('room:state')!.me, before.me);
  assert.equal(replacement.last('room:state')!.resumeToken, before.resumeToken);
  clear([host.s, audience.s, replacement]);
  assert.equal(await h.req(audience.s, { type: 'participant:rename', name: 'Stale name' }), 'not_joined');
  assert.deepEqual(audience.s.inbox.map(message => message.type), ['error']);
  assert.equal(await h.req(replacement, { type: 'participant:rename', name: 'Current name' }), 'ok');
  assert.equal(replacement.last('room:state')!.me.name, 'Current name');
  assert.equal(replacement.last('room:state')!.resumeToken, before.resumeToken);
  assert.equal(host.s.last('room:state')!.hands[0]!.name, 'Current name');
  assert.deepEqual(audience.s.inbox.map(message => message.type), ['error'], 'retired socket receives no snapshot');
});

test('rename stays ordered with stage approval, force mute and control transfer without gaining permissions', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  await h.req(audience.s, { type: 'hand:raise' }); flushState(h);
  clear([host.s, audience.s]);
  const results = await Promise.all([
    h.req(audience.s, { type: 'participant:rename', name: 'First' }),
    h.req(host.s, { type: 'stage:approve', targetId: audience.id }),
    h.req(host.s, { type: 'mic:force-mute', targetId: audience.id }),
    h.req(audience.s, { type: 'participant:rename', name: 'Second' }),
    h.req(host.s, { type: 'control:transfer', targetId: audience.id }),
    h.req(audience.s, { type: 'participant:rename', name: 'Third' }),
  ]);
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  const states = audience.s.all('room:state');
  assert.deepEqual(states.map(state => [state.me.name, state.me.role, state.me.forceMuted]), [
    ['First', 'audience', false], ['First', 'speaker', false], ['First', 'speaker', true],
    ['Second', 'speaker', true], ['Second', 'controller', true], ['Third', 'controller', true],
  ]);
  assert.equal(await h.req(host.s, { type: 'mic:force-unmute', targetId: audience.id }), 'forbidden');
  assert.equal(await h.req(audience.s, { type: 'mic:unmute' }), 'forbidden');
  assert.equal(await h.req(host.s, { type: 'participant:rename', name: 'Former host' }), 'ok');
  assert.equal(host.s.last('room:state')!.me.role, 'speaker');
});

test('rename leaves actual mock peer, publisher, subscriber and mix-minus-self audio continuously live', async t => {
  const h = setup(t), host = await h.create(), speaker = await h.join(host.roomId, host.code, 'Speaker');
  const audience = await h.join(host.roomId, host.code, 'Audience');
  await h.req(speaker.s, { type: 'hand:raise' });
  await h.req(host.s, { type: 'stage:approve', targetId: speaker.id });
  await h.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
  await h.req(audience.s, { type: 'rtc:offer', payload: RECVONLY_OFFER });
  await h.req(host.s, { type: 'mic:gain', targetId: speaker.id, gainDb: -3 });
  const room = h.transport.rooms.get(host.roomId)!, mixer = h.mixers.get(host.roomId)!;
  const peer = room.peers.get(speaker.id)!, audiencePeer = room.peers.get(audience.id)!;
  const publisher = room.publishers.get(speaker.id), subscribers = [...room.subscribers];
  const metrics = h.hub.metrics();
  const transportActions = [
    t.mock.method(h.transport, 'negotiate'), t.mock.method(h.transport, 'addRemoteCandidate'),
    t.mock.method(h.transport, 'addPublisher'), t.mock.method(h.transport, 'removePublisher'),
    t.mock.method(h.transport, 'setPublisherMuted'), t.mock.method(h.transport, 'setMixedStream'),
    t.mock.method(h.transport, 'subscribe'), t.mock.method(h.transport, 'unsubscribe'),
    t.mock.method(h.transport, 'closePeer'), t.mock.method(h.transport, 'closeRoom'),
  ];
  const mixerActions = [t.mock.method(mixer, 'addSource'), t.mock.method(mixer, 'removeSource'),
    t.mock.method(mixer, 'setMuted'), t.mock.method(mixer, 'setGain'), t.mock.method(mixer, 'stop')];
  const assertAudio = () => {
    assert.equal(h.transport.emitUplink(host.roomId, speaker.id, sine(960, 0.2)), true);
    assert.equal(h.transport.emitUplink(host.roomId, audience.id, sine(960, 0.2)), false);
    mixer.tick();
    assert.ok(audiencePeer.received.at(-1)!.some(sample => Math.abs(sample) > 0.01));
    assert.ok(peer.received.at(-1)!.every(sample => sample === 0), 'publisher never hears its own audio');
  };
  assertAudio();
  for (const name of ['Changed speaker', 'Changed speaker']) {
    clear([host.s, speaker.s, audience.s]);
    assert.equal(await h.req(speaker.s, { type: 'participant:rename', name }), 'ok');
    assert.equal(room.peers.get(speaker.id), peer);
    assert.equal(room.peers.get(audience.id), audiencePeer);
    assert.equal(room.publishers.get(speaker.id), publisher);
    assert.deepEqual([...room.subscribers], subscribers);
    assert.equal(mixer.sourceCount, 1);
    assert.deepEqual(h.hub.metrics(), metrics);
    for (const action of [...transportActions, ...mixerActions]) assert.equal(action.mock.callCount(), 0);
    assert.equal(speaker.s.last('room:state')!.me.gainDb, -3);
    assert.equal(speaker.s.all('rtc:answer').length, 0);
    assert.equal(speaker.s.all('stage:joined').length, 0);
    assertAudio();
  }
});

async function bounded<T>(promise: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

test('localhost WebSocket rename crosses validator and hub with personalized state before ACK', { timeout: 10000 }, async t => {
  const config = testConfig(c => {
    c.server.host = '127.0.0.1'; c.server.port = 0; c.server.static = [];
    c.rooms.qualityIntervalMs = 0; c.rooms.presenceBroadcastMs = 250;
  });
  const h = harness(config), sockets: WebSocket[] = [];
  const server = createStageServer({ config, hub: h.hub, log: silentLogger, baseDir: process.cwd() });
  t.after(async () => {
    try { await bounded(server.close(), 'server close'); }
    finally {
      for (const socket of sockets) socket.terminate();
      await bounded(h.hub.shutdown(), 'hub shutdown');
      await h.transport.close();
    }
    assert.equal(h.hub.roomCount, 0);
    assert.equal(h.transport.rooms.size, 0);
    assert.equal(liveTimers(h).length, 0);
  });
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
    const reply = (requestId: string) => waitFor(message => (message.type === 'ok' || message.type === 'error') && message.requestId === requestId);
    const hello = await waitFor(message => message.type === 'hello');
    assert.ok(hello.type === 'hello'); assert.equal(hello.protocol, 1);
    return { ws, inbox, reply, waitFor, send: (message: unknown) => ws.send(JSON.stringify(message)) };
  };
  const host = await connect(), guest = await connect();
  host.send({ type: 'room:create', requestId: 'create', name: 'Host' });
  assert.equal((await host.reply('create')).type, 'ok');
  const hostBefore = host.inbox.find(message => message.type === 'room:state')!;
  assert.ok(hostBefore.type === 'room:state');
  guest.send({ type: 'join', requestId: 'join', roomId: hostBefore.roomId, code: hostBefore.code, name: 'Guest' });
  assert.equal((await guest.reply('join')).type, 'ok');
  const guestBefore = guest.inbox.find(message => message.type === 'room:state')!;
  assert.ok(guestBefore.type === 'room:state');
  host.inbox.length = 0; guest.inbox.length = 0;
  guest.send({ type: 'participant:rename', requestId: 'wire-rename', name: '  e\u0301<&>🐱\u200b  ', targetId: hostBefore.me.participantId, role: 'controller' });
  assert.equal((await guest.reply('wire-rename')).type, 'ok');
  const hostAfter = await host.waitFor(message => message.type === 'room:state');
  const guestAfter = guest.inbox[0]!;
  assert.ok(hostAfter.type === 'room:state' && guestAfter.type === 'room:state');
  assert.deepEqual(guest.inbox.map(message => message.type), ['room:state', 'ok']);
  assert.equal(guestAfter.me.name, 'é&lt;&amp;&gt;🐱');
  assert.deepEqual(omitNames(guestAfter), omitNames(guestBefore));
  assert.equal(hostAfter.me.name, 'Host');
  assert.equal(hostAfter.audience![0]!.name, guestAfter.me.name);
  assertPrivate(hostAfter, hostBefore.me.participantId, hostBefore.resumeToken, hostBefore.me.participantId, hostBefore.code!);
  assertPrivate(guestAfter, guestBefore.me.participantId, guestBefore.resumeToken, hostBefore.me.participantId, hostBefore.code!);
  guest.inbox.length = 0;
  guest.send({ type: 'participant:rename', requestId: 'invalid-name', name: '\u200b\n' });
  const error = await guest.reply('invalid-name');
  assert.deepEqual(error, { type: 'error', requestId: 'invalid-name', code: 'bad_request', message: ERROR_MESSAGES.bad_request });
  assert.deepEqual(guest.inbox.map(message => message.type), ['error']);
});
