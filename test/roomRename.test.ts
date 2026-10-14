import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { CLIENT_MESSAGE_TYPES, PROTOCOL_VERSION, type RoomStatePayload, type ServerMessage } from '../shared/protocol.ts';
import { createLogger, silentLogger } from '../src/log.ts';
import { ERROR_MESSAGES, InvariantViolation, StageError } from '../src/model/errors.ts';
import { Room } from '../src/model/room.ts';
import { createStageServer } from '../src/ws/server.ts';
import { parseClientMessage, ValidationError } from '../src/ws/validate.ts';
import { FakeSession, harness, RECVONLY_OFFER, SENDRECV_OFFER, sine, testConfig, type Harness } from './helpers.ts';

const limits = testConfig().limits;
const parseRename = (name: unknown, extra: Record<string, unknown> = {}, maxLength = limits.nameMaxLength) =>
  parseClientMessage(JSON.stringify({ type: 'room:rename', requestId: 'rename', name, ...extra }), { ...limits, nameMaxLength: maxLength });
const liveTimers = (h: Harness) => h.timers.filter(timer => !timer.cleared);
const clear = (sessions: FakeSession[]) => { for (const session of sessions) session.clear(); };

function setup(t: TestContext, logLines?: string[]): Harness {
  const h = harness(testConfig(config => {
    config.rooms.presenceBroadcastMs = 250;
    config.rooms.qualityIntervalMs = 0;
  }), logLines ? createLogger('debug', line => logLines.push(line)) : undefined);
  t.after(async () => {
    await bounded(h.hub.shutdown(), 'hub shutdown');
    await bounded(h.transport.close(), 'transport close');
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

function withoutTitle({ name: _name, ...state }: RoomStatePayload): unknown { return state; }

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

test('room rename is additive to protocol 1 and whitelists only requestId and name', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(CLIENT_MESSAGE_TYPES.filter(type => type === 'room:rename').length, 1);
  assert.deepEqual(parseRename('Title', {
    targetId: { malicious: true }, roomId: 'other', roomName: 'Ignored', role: 'controller', code: 'NEW', resumeToken: 'other', extra: true,
  }), { type: 'room:rename', requestId: 'rename', name: 'Title' });
  assert.throws(() => parseClientMessage('{"type":"room:rename-unsupported","requestId":"old-server"}', limits),
    error => error instanceof ValidationError && error.code === 'unknown_type' && error.requestId === 'old-server');
});

test('room rename reuses configured Unicode, NFC, control stripping and HTML escaping validation', () => {
  const cases: [string, string, number][] = [
    ['  房間 🐱  ', '房間 🐱', 4],
    ['e\u0301', 'é', 1],
    ['🐱'.repeat(32), '🐱'.repeat(32), 32],
    ['\u0000A\u001f\u007f\u0085\u200b\u202e\u2066\u2028\u2029B\n', 'AB', 2],
    ['<&>"\'', '&lt;&amp;&gt;&quot;&#39;', 5],
    ['&lt;', '&amp;lt;', 4],
    ['字'.repeat(40), '字'.repeat(40), 40],
  ];
  for (const [raw, expected, maxLength] of cases) {
    assert.deepEqual(parseRename(raw, {}, maxLength), { type: 'room:rename', requestId: 'rename', name: expected });
  }
});

test('room rename requires a request id and nonempty name within the configured cleaned limit', () => {
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

test('Room.renameRoom changes only the title and preserves identity, order, credentials and media policy', () => {
  const room = modelRoom();
  const people = [...room.participants.values()];
  for (const onStage of [true, false]) {
    if (!onStage) room.leaveStage('host');
    const before = structuredClone(room);
    const title = onStage ? 'New Room' : 'Off-stage controller title';
    assert.equal(room.renameRoom('host', title), true);
    assert.deepEqual(structuredClone(room), { ...before, name: title });
    assert.equal(room.renameRoom('host', title), false);
    assert.deepEqual(structuredClone(room), { ...before, name: title });
    for (const person of people) assert.equal(room.get(person.participantId), person);
    assert.equal(room.pickSuccessor()!.participantId, 'speaker1');
    assert.equal(room.get('host')!.onStage, onStage);
    assert.equal(room.get('host')!.name, 'Host');
    room.assertInvariants();
  }
});

test('Room.renameRoom checks current controller before changed or unchanged title', () => {
  const room = modelRoom();
  for (const byId of ['speaker1', 'hand1', 'audience', 'missing']) {
    for (const name of ['Changed', room.name]) {
      const before = structuredClone(room);
      assert.throws(() => room.renameRoom(byId, name), error => error instanceof StageError && error.code === 'forbidden');
      assert.deepEqual(structuredClone(room), before);
    }
  }
  room.transfer('host', 'speaker1');
  assert.throws(() => room.renameRoom('host', room.name), error => error instanceof StageError && error.code === 'forbidden');
  assert.equal(room.renameRoom('speaker1', 'Current owner'), true);
});

for (const changed of [false, true]) {
  test(`Room.renameRoom checks invariants for ${changed ? 'changed' : 'unchanged'} titles`, () => {
    const room = modelRoom();
    room.handQueue.push('missing');
    assert.throws(() => room.renameRoom('host', changed ? 'Different' : 'Room'), InvariantViolation);
  });
}

for (const codeRequired of [true, false]) {
  test(`controller title change reaches every personalized recipient before ACK (${codeRequired ? 'protected' : 'open'} room)`, async t => {
    const lines: string[] = [], h = setup(t, lines), host = await h.create('Host', { codeRequired });
    const speaker = await h.join(host.roomId, host.code || undefined, 'Speaker');
    const hand = await h.join(host.roomId, host.code || undefined, 'Hand');
    const audience = await h.join(host.roomId, host.code || undefined, 'Audience');
    const people = [host, speaker, hand, audience], sessions = people.map(person => person.s);
    await h.req(speaker.s, { type: 'hand:raise' });
    await h.req(host.s, { type: 'stage:approve', targetId: speaker.id });
    await h.req(speaker.s, { type: 'mic:mute' });
    await h.req(host.s, { type: 'mic:force-mute', targetId: speaker.id });
    await h.req(host.s, { type: 'mic:gain', targetId: speaker.id, gainDb: 3.5 });
    await h.req(hand.s, { type: 'hand:raise' });
    flushState(h);
    for (const onStage of [true, false]) {
      if (!onStage) await h.req(host.s, { type: 'stage:leave' });
      const before = sessions.map(session => structuredClone(session.last('room:state')!));
      const logCount = lines.length;
      clear(sessions);
      const raw = onStage ? '  e\u0301<&>🐱\u200b  ' : 'Off-stage title';
      const name = onStage ? 'é&lt;&amp;&gt;🐱' : raw;
      await h.hub.handle(host.s, parseRename(raw, { roomId: 'other', targetId: audience.id, role: 'audience', code: 'NEW' }));
      for (const [index, recipient] of people.entries()) {
        assert.deepEqual(recipient.s.inbox.map(message => message.type), recipient === host ? ['room:state', 'ok'] : ['room:state']);
        const state = recipient.s.last('room:state')!;
        assert.equal(state.name, name);
        assert.deepEqual(withoutTitle(state), withoutTitle(before[index]!));
        if (codeRequired) assertPrivate(state, recipient.id, before[index]!.resumeToken, host.id, host.code);
        else {
          assert.equal(state.me.participantId, recipient.id);
          assert.equal(state.resumeToken, before[index]!.resumeToken);
          assert.equal('code' in state, false);
          assert.equal('audience' in state, recipient === host);
        }
      }
      assert.equal(lines.length, logCount, 'title changes produce no title-bearing events or log entries');
    }
  });
}

test('speakers, raised hands, audience and unjoined sessions cannot rename even to the current title', async t => {
  const h = setup(t), host = await h.create();
  const speaker = await h.join(host.roomId, host.code, 'Speaker');
  const hand = await h.join(host.roomId, host.code, 'Hand');
  const audience = await h.join(host.roomId, host.code, 'Audience');
  const outsider = new FakeSession(); h.hub.attach(outsider);
  await h.req(speaker.s, { type: 'hand:raise' });
  await h.req(host.s, { type: 'stage:approve', targetId: speaker.id });
  await h.req(hand.s, { type: 'hand:raise' });
  flushState(h);
  const sessions = [host.s, speaker.s, hand.s, audience.s, outsider];
  for (const session of sessions.slice(1)) {
    for (const name of ['Changed', 'Room']) {
      clear(sessions);
      const code = session === outsider ? 'not_joined' : 'forbidden';
      assert.equal(await h.req(session, { type: 'room:rename', name }), code);
      assert.deepEqual(session.inbox.map(message => message.type), ['error']);
      assert.equal(session.last('error')!.message, ERROR_MESSAGES[code]);
      for (const other of sessions.filter(other => other !== session)) assert.deepEqual(other.inbox, []);
    }
  }
  assert.equal(await h.req(host.s, { type: 'room:rename', name: 'Room' }), 'ok');
  assert.equal(host.s.last('room:state')!.name, 'Room');
});

test('canonical no-op title calls model and invariants and refreshes only the requester before ACK', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  await h.hub.handle(host.s, parseRename('é<&>'));
  const before = structuredClone(host.s.last('room:state')!);
  const rename = t.mock.method(Room.prototype, 'renameRoom');
  const invariants = t.mock.method(Room.prototype, 'assertInvariants');
  clear([host.s, audience.s]);
  await h.hub.handle(host.s, parseRename(' \u200be\u0301<&>\n '));
  assert.deepEqual(host.s.inbox.map(message => message.type), ['room:state', 'ok']);
  assert.deepEqual(host.s.last('room:state'), before);
  assert.deepEqual(audience.s.inbox, []);
  assert.equal(rename.mock.callCount(), 1);
  assert.equal(invariants.mock.callCount(), 1);
  assert.equal(rename.mock.calls[0]!.result, false);
});

for (const kind of ['presence', 'hand'] as const) {
  for (const changed of [false, true]) {
    test(`${changed ? 'changed' : 'no-op'} room rename ${changed ? 'flushes' : 'preserves'} a pending ${kind} snapshot`, async t => {
      const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
      if (kind === 'hand') await h.req(audience.s, { type: 'hand:raise' });
      const pending = liveTimers(h)[0]!;
      assert.equal(pending.ms, kind === 'hand' ? 0 : 250);
      clear([host.s, audience.s]);
      assert.equal(await h.req(host.s, { type: 'room:rename', name: changed ? 'New Room' : 'Room' }), 'ok');
      assert.deepEqual(host.s.inbox.map(message => message.type), ['room:state', 'ok']);
      assert.equal(host.s.last('room:state')!.audienceCount, 1);
      assert.equal(host.s.last('room:state')!.hands.length, kind === 'hand' ? 1 : 0);
      if (changed) {
        assert.equal(pending.cleared, true);
        assert.deepEqual(liveTimers(h), []);
        assert.deepEqual(audience.s.inbox.map(message => message.type), ['room:state']);
        assert.equal(audience.s.last('room:state')!.name, 'New Room');
        clear([host.s, audience.s]); flushState(h);
        assert.deepEqual(host.s.inbox, []); assert.deepEqual(audience.s.inbox, []);
      } else {
        assert.deepEqual(liveTimers(h), [pending]);
        assert.equal(liveTimers(h)[0], pending);
        assert.deepEqual(audience.s.inbox, []);
        clear([host.s, audience.s]); flushState(h);
        for (const session of [host.s, audience.s]) {
          assert.deepEqual(session.inbox.map(message => message.type), ['room:state']);
          assert.equal(session.last('room:state')!.name, 'Room');
        }
      }
    });
  }
}

test('queued transfer applies title changes with current ownership and never grants former-controller no-ops', async t => {
  const h = setup(t), host = await h.create(), next = await h.join(host.roomId, host.code, 'Next');
  flushState(h); clear([host.s, next.s]);
  const results = await Promise.all([
    h.req(host.s, { type: 'room:rename', name: 'Before transfer' }),
    h.req(host.s, { type: 'control:transfer', targetId: next.id }),
    h.req(host.s, { type: 'room:rename', name: 'Before transfer' }),
    h.req(next.s, { type: 'room:rename', name: 'After transfer' }),
    h.req(host.s, { type: 'room:rename', name: 'Unauthorized' }),
  ]);
  assert.deepEqual(results, ['ok', 'ok', 'forbidden', 'ok', 'forbidden']);
  assert.deepEqual(next.s.all('room:state').map(state => [state.name, state.controllerId]), [
    ['Before transfer', host.id], ['Before transfer', next.id], ['After transfer', next.id],
  ]);
  assert.equal(host.s.last('room:state')!.code, undefined);
  assert.equal(next.s.last('room:state')!.code, host.code);
  assert.equal(next.s.last('room:state')!.me.name, 'Next');
});

test('queued close rejects later room rename and does not send a success after room closure', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  flushState(h); clear([host.s, audience.s]);
  assert.deepEqual(await Promise.all([
    h.req(host.s, { type: 'room:rename', name: 'Before close' }),
    h.req(host.s, { type: 'room:close' }),
    h.req(host.s, { type: 'room:rename', name: 'After close' }),
  ]), ['ok', 'ok', 'not_joined']);
  assert.deepEqual(host.s.inbox.map(message => message.type), ['room:state', 'ok', 'ok', 'room:closed', 'error']);
  assert.deepEqual(audience.s.inbox.map(message => message.type), ['room:state', 'room:closed']);
  assert.equal(audience.s.last('room:state')!.name, 'Before close');
  assert.equal(h.hub.roomCount, 0);
});

test('queued kicked sessions cannot rename or receive a title snapshot', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  flushState(h); clear([host.s, audience.s]);
  assert.deepEqual(await Promise.all([
    h.req(host.s, { type: 'participant:kick', targetId: audience.id }),
    h.req(audience.s, { type: 'room:rename', name: 'Room' }),
  ]), ['ok', 'not_joined']);
  assert.deepEqual(audience.s.inbox.map(message => message.type), ['kicked', 'error']);
  assert.equal(audience.s.closed!.code, 4001);
  assert.equal(host.s.last('room:state')!.name, 'Room');
});

test('controller grace and resume retain the title and retire the old session without sharing credentials', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  assert.equal(await h.req(host.s, { type: 'room:rename', name: 'Remember this room' }), 'ok');
  const before = structuredClone(host.s.last('room:state')!);
  await h.hub.detach(host.s);
  const grace = liveTimers(h).find(timer => timer.ms === testConfig().rooms.controllerGraceMs)!;
  assert.ok(grace);
  assert.equal(await h.req(audience.s, { type: 'room:rename', name: before.name }), 'forbidden');
  const replacement = new FakeSession(); h.hub.attach(replacement);
  assert.equal(await h.req(replacement, { type: 'join', roomId: host.roomId, code: host.code, name: 'Ignored name', resumeToken: before.resumeToken }), 'ok');
  assert.equal(grace.cleared, true);
  assert.equal(replacement.last('room:state')!.name, before.name);
  assert.deepEqual(replacement.last('room:state')!.me, before.me);
  assert.equal(replacement.last('room:state')!.resumeToken, before.resumeToken);
  clear([host.s, audience.s, replacement]);
  assert.equal(await h.req(host.s, { type: 'room:rename', name: 'Stale title' }), 'not_joined');
  assert.equal(await h.req(replacement, { type: 'room:rename', name: 'Resumed title' }), 'ok');
  assert.deepEqual(host.s.inbox.map(message => message.type), ['error']);
  assert.deepEqual(replacement.inbox.map(message => message.type), ['room:state', 'ok']);
  assert.equal(audience.s.last('room:state')!.name, 'Resumed title');
  assertPrivate(replacement.last('room:state')!, host.id, before.resumeToken, host.id, host.code);
  assert.equal('code' in audience.s.last('room:state')!, false);
});

test('grace expiry preserves the title and grants rename only after actual controller succession', async t => {
  const h = setup(t), host = await h.create(), speaker = await h.join(host.roomId, host.code, 'Speaker');
  const audience = await h.join(host.roomId, host.code, 'Audience');
  await h.req(speaker.s, { type: 'hand:raise' });
  await h.req(host.s, { type: 'stage:approve', targetId: speaker.id });
  await h.req(host.s, { type: 'room:rename', name: 'Persistent title' });
  await h.hub.detach(host.s);
  assert.equal(await h.req(speaker.s, { type: 'room:rename', name: 'Persistent title' }), 'forbidden');
  const grace = liveTimers(h).find(timer => timer.ms === testConfig().rooms.controllerGraceMs)!;
  clear([host.s, speaker.s, audience.s]);
  grace.cleared = true; grace.fn();
  assert.equal(await h.req(speaker.s, { type: 'room:rename', name: 'Successor title' }), 'ok');
  assert.deepEqual(speaker.s.all('room:state').map(state => [state.name, state.controllerId]), [
    ['Persistent title', speaker.id], ['Successor title', speaker.id],
  ]);
  assert.equal(await h.req(host.s, { type: 'room:rename', name: 'Successor title' }), 'not_joined');
  assert.equal(await h.req(audience.s, { type: 'room:rename', name: 'Successor title' }), 'forbidden');
  assert.equal(speaker.s.last('room:state')!.code, host.code);
  assert.equal(speaker.s.last('room:state')!.speakers.some(person => person.participantId === host.id), false);
  assert.equal(h.hub.roomCount, 1);
});

test('room rename leaves existing mock peers, publishers, subscribers and PCM continuously unchanged', async t => {
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
  for (const name of ['Changed room', 'Changed room']) {
    clear([host.s, speaker.s, audience.s]);
    assert.equal(await h.req(host.s, { type: 'room:rename', name }), 'ok');
    assert.equal(room.peers.get(speaker.id), peer);
    assert.equal(room.peers.get(audience.id), audiencePeer);
    assert.equal(room.publishers.get(speaker.id), publisher);
    assert.deepEqual([...room.subscribers], subscribers);
    assert.equal(mixer.sourceCount, 1);
    assert.deepEqual(h.hub.metrics(), metrics);
    for (const action of [...transportActions, ...mixerActions]) assert.equal(action.mock.callCount(), 0);
    assert.equal(host.s.last('room:state')!.name, name);
    assert.equal(host.s.last('room:state')!.speakers.find(person => person.participantId === speaker.id)!.gainDb, -3);
    for (const session of [host.s, speaker.s, audience.s]) {
      assert.equal(session.all('rtc:answer').length, 0);
      assert.equal(session.all('stage:joined').length, 0);
    }
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

async function wireSetup(t: TestContext, controlPerSecond = 20) {
  const config = testConfig(c => {
    c.server.host = '127.0.0.1'; c.server.port = 0; c.server.static = [];
    c.rooms.qualityIntervalMs = 0; c.rooms.presenceBroadcastMs = 250;
    c.limits.controlPerSecond = controlPerSecond;
  });
  const h = harness(config), sockets: WebSocket[] = [];
  const server = createStageServer({ config, hub: h.hub, log: silentLogger, baseDir: process.cwd(), now: () => h.clock.now });
  t.after(async () => {
    try { await bounded(server.close(), 'server close'); }
    finally {
      for (const socket of sockets) socket.terminate();
      await bounded(h.hub.shutdown(), 'hub shutdown');
      await bounded(h.transport.close(), 'transport close');
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
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
    await bounded(once(ws, 'open'), 'socket open');
    const waitFor = (predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); ws.off('message', inspect); ws.off('close', ended); ws.off('error', failed); };
      const inspect = () => { const found = inbox.find(predicate); if (found) { cleanup(); resolve(found); } };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const ended = () => failed(new Error('socket closed before expected message'));
      const timer = setTimeout(() => failed(new Error('WebSocket response timed out')), 3000);
      ws.on('message', inspect); ws.once('close', ended); ws.once('error', failed); inspect();
      if (ws.readyState === WebSocket.CLOSED) ended();
    });
    const reply = (requestId: string) => waitFor(message => (message.type === 'ok' || message.type === 'error') && message.requestId === requestId);
    const hello = await waitFor(message => message.type === 'hello');
    assert.ok(hello.type === 'hello'); assert.equal(hello.protocol, 1);
    return { ws, inbox, closed, reply, waitFor, send: (message: unknown) => ws.send(JSON.stringify(message)) };
  };
  return { h, connect };
}

test('localhost room rename crosses validator and hub with personalized state before ACK and generic errors', { timeout: 10000 }, async t => {
  const { connect } = await wireSetup(t);
  const host = await connect(), guest = await connect();
  host.send({ type: 'room:create', requestId: 'create', name: 'Host', roomName: 'Original' });
  assert.equal((await host.reply('create')).type, 'ok');
  const hostBefore = host.inbox.find(message => message.type === 'room:state')!;
  assert.ok(hostBefore.type === 'room:state');
  guest.send({ type: 'join', requestId: 'join', roomId: hostBefore.roomId, code: hostBefore.code, name: 'Guest' });
  assert.equal((await guest.reply('join')).type, 'ok');
  const guestBefore = guest.inbox.find(message => message.type === 'room:state')!;
  assert.ok(guestBefore.type === 'room:state');
  host.inbox.length = 0; guest.inbox.length = 0;
  host.send({ type: 'room:rename', requestId: 'wire-rename', name: '  e\u0301<&>🐱\u200b  ', targetId: guestBefore.me.participantId, role: 'audience' });
  assert.equal((await host.reply('wire-rename')).type, 'ok');
  const guestAfter = await guest.waitFor(message => message.type === 'room:state');
  const hostAfter = host.inbox[0]!;
  assert.ok(hostAfter.type === 'room:state' && guestAfter.type === 'room:state');
  assert.deepEqual(host.inbox.map(message => message.type), ['room:state', 'ok']);
  assert.equal(hostAfter.name, 'é&lt;&amp;&gt;🐱');
  assert.equal(guestAfter.name, hostAfter.name);
  assert.deepEqual(withoutTitle(guestAfter), withoutTitle(guestBefore));
  assert.equal(hostAfter.me.name, 'Host');
  assertPrivate(hostAfter, hostBefore.me.participantId, hostBefore.resumeToken, hostBefore.me.participantId, hostBefore.code!);
  assertPrivate(guestAfter, guestBefore.me.participantId, guestBefore.resumeToken, hostBefore.me.participantId, hostBefore.code!);
  guest.inbox.length = 0;
  guest.send({ type: 'room:rename', requestId: 'forbidden-noop', name: 'é<&>🐱' });
  assert.deepEqual(await guest.reply('forbidden-noop'), {
    type: 'error', requestId: 'forbidden-noop', code: 'forbidden', message: ERROR_MESSAGES.forbidden,
  });
  assert.deepEqual(guest.inbox.map(message => message.type), ['error']);
  host.inbox.length = 0;
  host.send({ type: 'room:rename', requestId: 'invalid-name', name: '\u200b\n' });
  assert.deepEqual(await host.reply('invalid-name'), {
    type: 'error', requestId: 'invalid-name', code: 'bad_request', message: ERROR_MESSAGES.bad_request,
  });
  assert.deepEqual(host.inbox.map(message => message.type), ['error']);
});

test('localhost room rename consumes ordinary control allowance including authorized no-ops', { timeout: 10000 }, async t => {
  const { connect } = await wireSetup(t, 3);
  const host = await connect();
  host.send({ type: 'room:create', requestId: 'create', name: 'Host', roomName: 'Room' });
  assert.equal((await host.reply('create')).type, 'ok');
  host.send({ type: 'room:rename', requestId: 'changed', name: 'New title' });
  assert.equal((await host.reply('changed')).type, 'ok');
  host.send({ type: 'room:rename', requestId: 'unchanged', name: 'New title' });
  assert.equal((await host.reply('unchanged')).type, 'ok');
  host.inbox.length = 0;
  host.send({ type: 'room:rename', requestId: 'limited', name: 'Blocked title' });
  assert.equal(await bounded(host.closed, 'rate-limit close'), 1008);
  assert.equal(host.inbox.some(message => message.type === 'ok' && message.requestId === 'limited'), false);
  assert.equal(host.inbox.some(message => message.type === 'room:state' && message.name === 'Blocked title'), false);
});
