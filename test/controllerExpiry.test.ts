import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { harness, RECVONLY_OFFER, SENDRECV_OFFER, testConfig, type Harness } from './helpers.ts';

type Timer = Harness['timers'][number];
const liveTimers = (h: Harness) => h.timers.filter(timer => !timer.cleared);

async function fire(timer: Timer): Promise<void> {
  assert.equal(timer.cleared, false, 'only fire pending timers');
  timer.cleared = true;
  timer.fn();
  // Expiry is queued asynchronously; only the native event-loop turn advances.
  await nextTurn();
}

async function setup(t: TestContext, count = 8) {
  const config = testConfig(c => {
    c.limits.maxSpeakersPerRoom = 8;
    c.rooms.controllerGraceMs = 60_000;
    c.rooms.participantGraceMs = 15_000;
    c.rooms.qualityIntervalMs = 0;
  });
  const h = harness(config);
  t.after(async () => {
    await h.hub.shutdown();
    assert.equal(h.hub.roomCount, 0);
    assert.equal(h.transport.rooms.size, 0);
    assert.equal(liveTimers(h).length, 0, 'shutdown clears pending harness timers');
  });
  const host = await h.create();
  assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  h.clock.now++;
  const audience = await h.join(host.roomId, host.code, 'Earlier audience');
  assert.equal(await h.req(audience.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
  const speakers: Awaited<ReturnType<Harness['join']>>[] = [];
  for (let index = 0; index < count; index++) {
    h.clock.now++;
    const person = await h.join(host.roomId, host.code, `Speaker ${index}`);
    assert.equal(await h.req(person.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: person.id }), 'ok');
    assert.equal(await h.req(person.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    speakers.push(person);
  }
  return { h, config, host, audience, speakers };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function holdForExpiry(f: Fixture, held = f.speakers) {
  const { h, config, host } = f;
  await h.hub.detach(host.s);
  const controller = liveTimers(h).find(timer => timer.ms === config.rooms.controllerGraceMs)!;
  assert.ok(controller);
  // Speaker drops occur near the controller deadline, so their own grace is still valid.
  h.clock.now += config.rooms.controllerGraceMs - config.rooms.participantGraceMs / 2;
  for (const person of held) await h.hub.detach(person.s);
  const participants = liveTimers(h).filter(timer => timer.ms === config.rooms.participantGraceMs);
  assert.equal(participants.length, held.length);
  h.clock.now += config.rooms.participantGraceMs / 2;
  return { controller, participants };
}

function assertOnlyController(state: RoomStatePayload, id: string): void {
  const people = new Map([state.me, ...state.speakers, ...(state.audience ?? [])].map(person => [person.participantId, person]));
  assert.equal(state.controllerId, id);
  assert.deepEqual([...people.values()].filter(person => person.role === 'controller').map(person => person.participantId), [id]);
}

function transferEvents(fromId: string, toId: string): ServerMessage[] {
  return [
    { type: 'control:transferred', fromId, toId },
    { type: 'role:update', participantId: fromId, role: 'speaker', reason: 'auto' },
    { type: 'role:update', participantId: toId, role: 'controller', reason: 'auto' },
    { type: 'stage:left', participantId: fromId, role: 'audience', reason: 'leave' },
  ];
}

describe('controller expiry at the speaker cap', { timeout: 5_000 }, () => {
  it('hands control to audience atomically while preserving all eight disconnected speaker seats and peers', async t => {
    const f = await setup(t);
    const { h, config, host, audience, speakers } = f;
    h.clock.now++;
    const observer = await h.join(host.roomId, host.code, 'Observer');
    const resumeToken = audience.s.last('room:state')!.resumeToken;
    const media = h.transport.rooms.get(host.roomId)!;
    const peers = new Map(media.peers);
    const timers = await holdForExpiry(f);
    assert.equal(await h.req(audience.s, { type: 'hand:raise' }), 'ok');
    const handFlush = liveTimers(h).find(timer => timer.ms === 0)!;
    assert.ok(handFlush);
    assert.equal(audience.s.last('room:state')!.controllerId, host.id, 'controller retains its seat until expiry');
    assert.equal(audience.s.last('room:state')!.speakers.length, 9);
    const retiredInboxes = [host, ...speakers].map(person => person.s.inbox.length);
    audience.s.clear(); observer.s.clear();

    await fire(timers.controller);

    assert.equal(h.hub.roomCount, 1, 'full retained stage must not close the room');
    assert.equal(h.hub.isJoined(audience.s), true);
    assert.equal(audience.s.last('room:closed'), undefined);
    assert.equal(observer.s.last('room:closed'), undefined);
    const state = audience.s.last('room:state')!;
    assertOnlyController(state, audience.id);
    assert.equal(state.me.onStage, false, 'audience successor does not automatically acquire a microphone');
    assert.equal(state.me.handRaised, false);
    assert.equal(state.me.connected, true);
    assert.deepEqual(state.hands, []);
    assert.equal(state.code, host.code, 'successor receives controller-private fields');
    assert.deepEqual(state.audience?.map(person => person.participantId), [observer.id]);
    assert.equal(state.resumeToken, resumeToken);
    assert.equal(observer.s.last('room:state')!.code, undefined);
    assert.equal(observer.s.last('room:state')!.audience, undefined);
    assert.notEqual(observer.s.last('room:state')!.resumeToken, resumeToken);
    assert.equal(state.limits.maxSpeakers, 8);
    assert.deepEqual(state.speakers.map(person => person.participantId), speakers.map(person => person.id));
    assert.ok(state.speakers.every(person => person.role === 'speaker' && person.onStage && !person.connected));
    assert.equal(state.audienceCount, 1);
    assert.equal(state.status, 'live');
    assert.equal([...state.speakers, ...state.audience!, state.me].some(person => person.participantId === host.id), false);

    const events: ServerMessage[] = [
      { type: 'stage:left', participantId: host.id, role: 'controller', reason: 'leave' },
      { type: 'hand:withdraw', participantId: audience.id },
      { type: 'control:transferred', fromId: host.id, toId: audience.id },
      { type: 'role:update', participantId: host.id, role: 'audience', reason: 'auto' },
      { type: 'role:update', participantId: audience.id, role: 'controller', reason: 'auto' },
    ];
    for (const session of [audience.s, observer.s]) {
      assert.equal(session.all('room:state').length, 1, 'only the final snapshot is observable');
      assert.deepEqual(session.inbox, [...events, session.last('room:state')!]);
    }
    assert.equal(handFlush.cleared, true, 'final state supersedes the pending hand snapshot');
    assert.deepEqual([host, ...speakers].map(person => person.s.inbox.length), retiredInboxes);
    assert.equal(h.transport.rooms.get(host.roomId), media, 'room media is retained');
    assert.equal(media.peers.has(host.id), false);
    assert.equal(media.publishers.has(host.id), false);
    assert.equal(media.subscribers.has(host.id), false);
    assert.deepEqual([...media.publishers.keys()], speakers.map(person => person.id));
    assert.equal(h.mixers.get(host.roomId)!.sourceCount, 8);
    for (const person of [audience, ...speakers]) assert.equal(media.peers.get(person.id), peers.get(person.id), 'surviving MockPeer identity is unchanged');
    assert.equal(media.peers.get(audience.id)!.allowUplink, false);
    assert.equal(media.publishers.has(audience.id), false);
    const retainedTimers = liveTimers(h).filter(timer => timer.ms === config.rooms.participantGraceMs);
    assert.equal(retainedTimers.length, 8);
    for (const [index, timer] of timers.participants.entries()) assert.equal(retainedTimers[index], timer, 'speaker grace timer is neither cancelled nor restarted');

    assert.equal(await h.req(observer.s, { type: 'stage:approve', targetId: observer.id }), 'forbidden');
    assert.equal(await h.req(audience.s, { type: 'stage:approve', targetId: audience.id }), 'ok', 'new controller can explicitly use its separate stage seat');
    assert.equal(audience.s.last('room:state')!.speakers.length, 9);
    assertOnlyController(audience.s.last('room:state')!, audience.id);
    assert.equal(media.peers.get(audience.id)!.allowUplink, false, 'stage approval does not silently renegotiate media');
  });

  it('still rejects a manual audience transfer at the full stage without changing state or media', async t => {
    const { h, host, audience, speakers } = await setup(t);
    assert.equal(await h.req(audience.s, { type: 'hand:raise' }), 'ok');
    const pending = liveTimers(h).find(timer => timer.ms === 0)!;
    await fire(pending);
    const before = host.s.last('room:state')!;
    const media = h.transport.rooms.get(host.roomId)!;
    const peers = new Map(media.peers);
    host.s.clear(); audience.s.clear();

    assert.equal(await h.req(host.s, { type: 'control:transfer', targetId: audience.id }), 'stage_full');

    assert.equal(h.hub.roomCount, 1);
    assert.deepEqual(host.s.inbox.map(message => message.type), ['error']);
    assert.deepEqual(audience.s.inbox, []);
    assert.equal(await h.req(host.s, { type: 'mic:gain', targetId: host.id, gainDb: 0 }), 'ok');
    assert.deepEqual(host.s.last('room:state'), before, 'rejected transfer is mutation-free');
    assert.equal(audience.s.last('room:state')!.me.handRaised, true);
    assert.equal(audience.s.last('room:state')!.code, undefined);
    assert.deepEqual([...media.publishers.keys()], [host.id, ...speakers.map(person => person.id)]);
    for (const [id, peer] of peers) assert.equal(media.peers.get(id), peer);
  });

  it('keeps the normal transfer-before-departure event order with only seven retained speakers', async t => {
    const f = await setup(t, 7);
    const { h, host, audience, speakers } = f;
    const timers = await holdForExpiry(f);
    assert.equal(await h.req(audience.s, { type: 'hand:raise' }), 'ok');
    audience.s.clear();

    await fire(timers.controller);

    assert.equal(h.hub.roomCount, 1);
    const state = audience.s.last('room:state')!;
    assertOnlyController(state, audience.id);
    assert.equal(state.me.onStage, false);
    assert.equal(state.me.handRaised, false);
    assert.deepEqual(state.speakers.map(person => person.participantId), speakers.map(person => person.id));
    assert.deepEqual(audience.s.inbox, [
      { type: 'hand:withdraw', participantId: audience.id },
      ...transferEvents(host.id, audience.id), state,
    ]);
    assert.ok(timers.participants.every(timer => !timer.cleared));
    assert.equal(h.mixers.get(host.roomId)!.sourceCount, 7);
  });

  it('prefers the earliest connected speaker over earlier audience at the full stage', async t => {
    const f = await setup(t);
    const { h, host, audience, speakers } = f;
    const first = speakers[0]!, second = speakers[1]!;
    const timers = await holdForExpiry(f, speakers.slice(2));
    audience.s.clear(); first.s.clear(); second.s.clear();

    await fire(timers.controller);

    assert.equal(h.hub.roomCount, 1);
    const state = first.s.last('room:state')!;
    assertOnlyController(state, first.id);
    assert.equal(state.me.onStage, true);
    assert.equal(state.speakers.filter(person => person.role !== 'controller').length, 7);
    assert.equal(state.speakers.length, 8);
    assert.deepEqual(state.speakers.map(person => person.participantId), speakers.map(person => person.id));
    assert.equal(audience.s.last('room:state')!.me.role, 'audience');
    assert.equal(first.s.last('room:state')!.code, host.code);
    for (const session of [audience.s, first.s, second.s]) assert.deepEqual(session.inbox, [...transferEvents(host.id, first.id), session.last('room:state')!]);
    assert.ok(timers.participants.every(timer => !timer.cleared));
    assert.equal(h.mixers.get(host.roomId)!.sourceCount, 8);
  });

  it('closes the room when no connected successor exists and cancels all held seats', async t => {
    const f = await setup(t);
    const { h, config, host, audience } = f;
    const timers = await holdForExpiry(f);
    await h.hub.detach(audience.s);
    const pending = liveTimers(h).filter(timer => timer !== timers.controller);
    assert.equal(pending.filter(timer => timer.ms === config.rooms.participantGraceMs).length, 9);

    await fire(timers.controller);

    assert.equal(h.hub.roomCount, 0);
    assert.equal(h.transport.rooms.has(host.roomId), false);
    assert.ok(pending.every(timer => timer.cleared));
    assert.equal(liveTimers(h).length, 0);
    assert.equal(audience.s.last('control:transferred'), undefined);
    assert.equal(await h.req(audience.s, { type: 'join', roomId: host.roomId, code: host.code, name: 'Returning audience' }), 'unauthorized');
  });
});
