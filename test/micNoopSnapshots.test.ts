import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { Room } from '../src/model/room.ts';
import { parseClientMessage, ValidationError } from '../src/ws/validate.ts';
import { FakeSession, harness, SENDRECV_OFFER, testConfig, type Harness } from './helpers.ts';

type Request = Parameters<Harness['req']>[1];
const liveTimers = (h: Harness) => h.timers.filter(timer => !timer.cleared);

function setup(t: TestContext): Harness {
  const h = harness(testConfig(config => {
    config.rooms.presenceBroadcastMs = 250;
    config.rooms.qualityIntervalMs = 0;
  }));
  t.after(async () => {
    await h.hub.shutdown();
    await h.transport.close();
    assert.equal(liveTimers(h).length, 0, 'shutdown clears every controlled timer');
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

function clear(sessions: FakeSession[]): void {
  for (const session of sessions) session.clear();
}

function onlyRequester(requester: FakeSession, others: FakeSession[]): RoomStatePayload {
  assert.deepEqual(requester.inbox.map(message => message.type), ['room:state', 'ok'], 'fresh state precedes exactly one ACK');
  for (const other of others) assert.deepEqual(other.inbox, [], 'unchanged state is not fanned out');
  return requester.last('room:state')!;
}

async function stageFixture(t: TestContext) {
  const h = setup(t), host = await h.create(), speaker = await h.join(host.roomId, host.code, 'Speaker');
  const audience = await h.join(host.roomId, host.code, 'Audience');
  assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
  flushState(h);
  return { h, host, speaker, audience, sessions: [host.s, speaker.s, audience.s] };
}

const duplicateCases = [
  { type: 'mic:mute', method: 'mute' },
  { type: 'mic:unmute', method: 'unmute' },
  { type: 'mic:force-mute', method: 'forceMute' },
  { type: 'mic:force-unmute', method: 'forceUnmute' },
  { type: 'mic:gain', method: 'setGain' },
] as const;

for (const entry of duplicateCases) {
  test(`${entry.type} duplicates validate through Room and send only personalized requester state before ACK`, async t => {
    const { h, host, speaker, audience, sessions } = await stageFixture(t);
    const self = entry.type === 'mic:mute' || entry.type === 'mic:unmute';
    const requester = self ? speaker.s : host.s;
    const request: Request = entry.type === 'mic:gain'
      ? { type: entry.type, targetId: speaker.id, gainDb: -3.5 }
      : self ? { type: entry.type as 'mic:mute' | 'mic:unmute' }
        : { type: entry.type as 'mic:force-mute' | 'mic:force-unmute', targetId: speaker.id };
    assert.equal(await h.req(requester, request), 'ok');
    const before = structuredClone(requester.last('room:state')!);
    const hostToken = host.s.last('room:state')!.resumeToken;
    const audienceToken = audience.s.last('room:state')!.resumeToken;
    const model = t.mock.method(Room.prototype, entry.method);
    const invariants = t.mock.method(Room.prototype, 'assertInvariants');
    clear(sessions);
    assert.equal(await h.req(requester, request), 'ok');
    const state = onlyRequester(requester, sessions.filter(session => session !== requester));
    assert.deepEqual(state, before);
    assert.equal(model.mock.callCount(), 1, 'the existing model method still executes');
    if (entry.type !== 'mic:gain') assert.equal(invariants.mock.callCount(), 1, 'mute invariant validation is retained');
    assert.equal(state.me.participantId, self ? speaker.id : host.id);
    if (self) {
      assert.equal('code' in state, false);
      assert.equal('audience' in state, false);
      assert.notEqual(state.resumeToken, hostToken);
    } else {
      assert.equal(state.code, host.code);
      assert.deepEqual(state.audience?.map(person => person.participantId), [audience.id]);
    }
    assert.equal(state.resumeToken, before.resumeToken);
    assert.notEqual(state.resumeToken, audienceToken);
    for (const person of [...state.speakers, ...state.hands, ...(state.audience ?? [])]) assert.equal('resumeToken' in person, false);
    assert.equal(liveTimers(h).length, 0);
  });
}

test('hidden self-mute and force-lock changes retain full snapshots even without effective mute events', async t => {
  const { h, host, speaker, sessions } = await stageFixture(t);
  assert.equal(await h.req(host.s, { type: 'mic:force-mute', targetId: speaker.id }), 'ok');
  const forced = structuredClone(speaker.s.last('room:state')!);
  clear(sessions);
  assert.equal(await h.req(speaker.s, { type: 'mic:mute' }), 'ok');
  assert.deepEqual(speaker.s.last('room:state'), forced, 'the underlying self-mute change is deliberately hidden by the force lock');
  for (const session of sessions) {
    assert.equal(session.all('room:state').length, 1);
    assert.equal(session.all('mic:muted').length + session.all('mic:unmuted').length, 0);
  }
  for (const type of ['mic:force-unmute', 'mic:force-mute'] as const) {
    clear(sessions);
    assert.equal(await h.req(host.s, { type, targetId: speaker.id }), 'ok');
    for (const session of sessions) {
      assert.equal(session.all('room:state').length, 1, 'force lock changes remain visible to everyone');
      assert.equal(session.all('mic:muted').length + session.all('mic:unmuted').length, 0);
      const view = session.last('room:state')!.speakers.find(person => person.participantId === speaker.id)!;
      assert.equal(view.muted, true, 'self-mute survived lifting the lock');
      assert.equal(view.forceMuted, type === 'mic:force-mute');
    }
  }
});

test('changed mute/gain commands retain event, media-setter and immediate fanout behavior', async t => {
  const { h, host, speaker, sessions } = await stageFixture(t);
  assert.equal(await h.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  const mixer = h.mixers.get(host.roomId)!;
  const mute = t.mock.method(h.transport, 'setPublisherMuted');
  const gain = t.mock.method(mixer, 'setGain');
  for (const type of ['mic:mute', 'mic:unmute'] as const) {
    clear(sessions);
    assert.equal(await h.req(speaker.s, { type }), 'ok');
    for (const session of sessions) {
      const expected = [type === 'mic:mute' ? 'mic:muted' : 'mic:unmuted', 'room:state'];
      if (session === speaker.s) expected.push('ok');
      assert.deepEqual(session.inbox.map(message => message.type), expected);
    }
  }
  assert.equal(mute.mock.callCount(), 2);
  clear(sessions);
  assert.equal(await h.req(host.s, { type: 'mic:gain', targetId: speaker.id, gainDb: -6 }), 'ok');
  for (const session of sessions) {
    assert.equal(session.all('room:state').length, 1);
    assert.equal(session.last('room:state')!.speakers.find(person => person.participantId === speaker.id)!.gainDb, -6);
  }
  clear(sessions);
  assert.equal(await h.req(host.s, { type: 'mic:gain', targetId: speaker.id, gainDb: -6 }), 'ok');
  onlyRequester(host.s, sessions.filter(session => session !== host.s));
  assert.equal(gain.mock.callCount(), 2, 'unchanged gain still invokes the established media setter');
  assert.deepEqual(gain.mock.calls.map(call => call.arguments), [[speaker.id, -6], [speaker.id, -6]]);
});

test('no-op predicates do not bypass permission, target, on-stage or forced-unmute errors', async t => {
  const { h, host, speaker, audience, sessions } = await stageFixture(t);
  const cases: { session: FakeSession; request: Request; code: string }[] = [
    { session: audience.s, request: { type: 'mic:force-mute', targetId: 'missing' }, code: 'forbidden' },
    { session: audience.s, request: { type: 'mic:force-unmute', targetId: 'missing' }, code: 'forbidden' },
    { session: audience.s, request: { type: 'mic:gain', targetId: 'missing', gainDb: 0 }, code: 'forbidden' },
    { session: audience.s, request: { type: 'mic:gain', targetId: speaker.id, gainDb: 0 }, code: 'forbidden' },
    { session: host.s, request: { type: 'mic:force-mute', targetId: 'missing' }, code: 'not_found' },
    { session: host.s, request: { type: 'mic:force-unmute', targetId: 'missing' }, code: 'not_found' },
    { session: host.s, request: { type: 'mic:gain', targetId: 'missing', gainDb: 0 }, code: 'not_found' },
    { session: host.s, request: { type: 'mic:force-unmute', targetId: audience.id }, code: 'conflict' },
    { session: host.s, request: { type: 'mic:force-mute', targetId: audience.id }, code: 'conflict' },
    { session: audience.s, request: { type: 'mic:mute' }, code: 'conflict' },
    { session: audience.s, request: { type: 'mic:unmute' }, code: 'conflict' },
  ];
  assert.equal(await h.req(host.s, { type: 'mic:force-mute', targetId: speaker.id }), 'ok');
  cases.push({ session: speaker.s, request: { type: 'mic:unmute' }, code: 'forbidden' });
  for (const item of cases) {
    clear(sessions);
    assert.equal(await h.req(item.session, item.request), item.code);
    assert.deepEqual(item.session.inbox.map(message => message.type), ['error']);
    for (const other of sessions.filter(session => session !== item.session)) assert.deepEqual(other.inbox, []);
    assert.equal(h.hub.roomCount, 1);
  }
});

test('gain no-ops preserve parsed rounding, signed zero, range checks and setter arguments', async t => {
  const { h, host, speaker, sessions } = await stageFixture(t);
  assert.equal(await h.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  const gain = t.mock.method(h.mixers.get(host.roomId)!, 'setGain');
  const limits = testConfig().limits;
  const parseGain = (value: string): ClientMessage => parseClientMessage(`{"type":"mic:gain","requestId":"parsed","targetId":"${speaker.id}","gainDb":${value}}`, limits);
  for (const value of ['-0', '0', '-0.04', '0.04']) {
    const message = parseGain(value);
    assert.equal(message.type, 'mic:gain');
    assert.ok(message.type === 'mic:gain');
    assert.equal(Math.abs(message.gainDb), 0);
    clear(sessions);
    await h.hub.handle(host.s, message);
    onlyRequester(host.s, [speaker.s, sessions[2]!]);
    const argument = gain.mock.calls.at(-1)!.arguments[1];
    assert.ok(Object.is(argument, message.gainDb), 'the original normalized signed-zero value reaches the mixer');
  }
  assert.equal(gain.mock.callCount(), 4);
  for (const value of ['NaN', 'Infinity', '-Infinity', '1e309', '-1e309', '20.01', '-20.01', 'null', '"0"']) {
    const before = gain.mock.callCount();
    clear(sessions);
    assert.throws(() => parseGain(value), error => error instanceof ValidationError && error.code === 'bad_request');
    assert.equal(gain.mock.callCount(), before);
    for (const session of sessions) assert.deepEqual(session.inbox, []);
  }
  for (const value of ['20', '-20', '6.04']) {
    const message = parseGain(value);
    clear(sessions);
    await h.hub.handle(host.s, message);
    for (const session of sessions) assert.equal(session.all('room:state').length, 1);
  }
  clear(sessions);
  await h.hub.handle(host.s, parseGain('6.01'));
  onlyRequester(host.s, [speaker.s, sessions[2]!]);
});

test('unchanged gain for an off-stage audience target remains allowed without a publisher setter', async t => {
  const { h, host, speaker, audience, sessions } = await stageFixture(t);
  const setter = t.mock.method(h.mixers.get(host.roomId)!, 'setGain');
  clear(sessions);
  assert.equal(await h.req(host.s, { type: 'mic:gain', targetId: audience.id, gainDb: 0 }), 'ok');
  const state = onlyRequester(host.s, [speaker.s, audience.s]);
  assert.equal(state.audience!.find(person => person.participantId === audience.id)!.gainDb, 0);
  assert.equal(setter.mock.callCount(), 0);
});

for (const kind of ['presence', 'hand'] as const) {
  test(`no-op preserves the pending ${kind} timer and its final current-recipient fanout`, async t => {
    const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
    if (kind === 'hand') assert.equal(await h.req(audience.s, { type: 'hand:raise' }), 'ok');
    const pending = liveTimers(h)[0]!;
    assert.ok(pending);
    assert.equal(pending.ms, kind === 'hand' ? 0 : 250);
    clear([host.s, audience.s]);
    assert.equal(await h.req(host.s, { type: 'mic:unmute' }), 'ok');
    onlyRequester(host.s, [audience.s]);
    assert.deepEqual(liveTimers(h), [pending]);
    assert.equal(liveTimers(h)[0], pending, 'the existing timer is neither cleared nor replaced');
    assert.equal(host.s.last('room:state')!.audienceCount, 1);
    assert.equal(host.s.last('room:state')!.hands.length, kind === 'hand' ? 1 : 0);
    clear([host.s, audience.s]);
    flushState(h);
    for (const session of [host.s, audience.s]) assert.deepEqual(session.inbox.map(message => message.type), ['room:state']);
    assert.equal(liveTimers(h).length, 0);
  });
}

test('held and resumed seats preserve mic state, private tokens and pending flush ownership', async t => {
  const { h, host, speaker, audience, sessions } = await stageFixture(t);
  assert.equal(await h.req(speaker.s, { type: 'mic:mute' }), 'ok');
  const original = structuredClone(speaker.s.last('room:state')!);
  await h.hub.detach(speaker.s);
  const resumed = new FakeSession(); h.hub.attach(resumed);
  assert.equal(await h.req(resumed, {
    type: 'join', roomId: host.roomId, code: host.code, name: 'Replacement', resumeToken: original.resumeToken,
  }), 'ok');
  assert.equal(resumed.last('room:state')!.me.participantId, speaker.id);
  assert.equal(resumed.last('room:state')!.me.muted, true);
  assert.equal(resumed.last('room:state')!.resumeToken, original.resumeToken);
  const pending = liveTimers(h)[0]!;
  assert.equal(pending.ms, 250);
  clear([...sessions, resumed]);
  assert.equal(await h.req(speaker.s, { type: 'mic:mute' }), 'not_joined');
  assert.deepEqual(speaker.s.inbox.map(message => message.type), ['error']);
  speaker.s.clear();
  assert.equal(await h.req(resumed, { type: 'mic:mute' }), 'ok');
  const state = onlyRequester(resumed, sessions);
  assert.equal(state.resumeToken, original.resumeToken);
  assert.equal('audience' in state, false);
  assert.equal('code' in state, false);
  assert.equal(liveTimers(h)[0], pending);
  clear([...sessions, resumed]);
  flushState(h);
  assert.deepEqual(speaker.s.inbox, [], 'retired session never regains snapshot ownership');
  for (const session of [host.s, audience.s, resumed]) assert.equal(session.all('room:state').length, 1);
});

test('301 seats and 20 hands use one unchanged-mic snapshot with exact bounded byte accounting', async t => {
  const h = setup(t), host = await h.create('Host', { codeRequired: false });
  const crowd = [];
  for (let index = 0; index < 300; index++) crowd.push(await h.join(host.roomId, undefined, `Audience ${index}`));
  for (const person of crowd.slice(0, 20)) assert.equal(await h.req(person.s, { type: 'hand:raise' }), 'ok');
  flushState(h);
  const sessions = [host.s, ...crowd.map(person => person.s)];
  assert.equal(await h.req(host.s, { type: 'mic:mute' }), 'ok');
  const saved: RoomStatePayload[] = sessions.map(session => structuredClone(session.last('room:state')!));
  assert.equal(saved[0]!.audienceCount, 300);
  assert.equal(saved[0]!.hands.length, 20);
  const checksum = (states: RoomStatePayload[]) => createHash('sha256').update(JSON.stringify(states)).digest('hex');
  const beforeHash = checksum(saved);
  const bytes = (message: ServerMessage) => Buffer.byteLength(JSON.stringify(message));
  // These are the unchanged personalized states produced by the preceding actual changed command.
  const fullSnapshotBytes = saved.reduce((sum, state) => sum + bytes({ type: 'room:state', ...state }), 0);
  const requesterBytes = bytes({ type: 'room:state', ...saved[0]! });
  clear(sessions);
  assert.equal(await h.req(host.s, { type: 'mic:mute' }), 'ok');
  const sent = sessions.flatMap(session => session.all('room:state'));
  t.diagnostic(JSON.stringify({ participants: 301, hands: 20, unchangedSnapshots: sent.length,
    unchangedSnapshotBytes: sent.reduce((sum, message) => sum + bytes(message), 0), requesterSnapshotBytes: requesterBytes,
    fullFanoutSnapshots: saved.length, fullFanoutSnapshotBytes: fullSnapshotBytes,
    scope: 'actual Hub and MockMediaTransport; serialized JSON bytes, no audio, CPU or latency claim' }));
  onlyRequester(host.s, crowd.map(person => person.s));
  assert.equal(sent.length, 1);
  assert.equal(sent.reduce((sum, message) => sum + bytes(message), 0), requesterBytes);
  assert.deepEqual(sent[0], saved[0]);
  assert.equal(checksum(saved), beforeHash, 'previous snapshot values remain immutable');
  assert.equal(fullSnapshotBytes - requesterBytes, crowd.reduce((sum, _, index) => sum + bytes({ type: 'room:state', ...saved[index + 1]! }), 0));
  assert.ok(fullSnapshotBytes > requesterBytes * 20, 'the bounded workload has meaningful eliminated fanout');
});
