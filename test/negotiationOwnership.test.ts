import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { it, type TestContext } from 'node:test';
import type { SessionDescriptionPayload } from '../shared/protocol.ts';
import { ERROR_MESSAGES } from '../src/model/errors.ts';
import { FakeSession, harness, RECVONLY_OFFER, SENDRECV_OFFER, sine } from './helpers.ts';

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('negotiation test did not settle')), 3000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function setup(t: TestContext) {
  const h = harness();
  const gates: { participantId: string; entered: () => void; outcome: Promise<boolean> }[] = [];
  const releases: ((fail: boolean) => void)[] = [];
  const requests: Promise<string>[] = [];
  const original = h.transport.negotiate.bind(h.transport);
  const closePeer = h.transport.closePeer.bind(h.transport);
  const closeRoom = h.transport.closeRoom.bind(h.transport);
  const peerCloses: string[] = [];
  const roomCloses: string[] = [];
  let negotiations = 0;
  h.transport.closePeer = (roomId, id) => { peerCloses.push(id); closePeer(roomId, id); };
  h.transport.closeRoom = roomId => { roomCloses.push(roomId); closeRoom(roomId); };
  h.transport.negotiate = async (...args) => {
    negotiations++;
    const index = gates.findIndex(gate => gate.participantId === args[1]);
    const gate = index < 0 ? undefined : gates.splice(index, 1)[0];
    // Apply the mock transport once, then hold only the selected completion. Other offers stay runnable.
    const answer = await original(...args);
    if (gate) {
      gate.entered();
      if (await gate.outcome) throw new Error('delayed private negotiation failure');
    }
    return answer;
  };
  t.after(async () => {
    for (const release of releases) release(true);
    await bounded(Promise.allSettled(requests));
    await bounded(h.hub.shutdown());
  });
  const host = await h.create();
  const speaker = await h.join(host.roomId, host.code, 'Speaker');
  const listener = await h.join(host.roomId, host.code, 'Listener');
  assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
  assert.equal(await h.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  assert.equal(await h.req(listener.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
  const resumeToken = speaker.s.last('room:state')!.resumeToken!;
  const room = h.transport.rooms.get(host.roomId)!;
  const mixer = h.mixers.get(host.roomId)!;
  const firstPeer = room.peers.get(speaker.id)!;
  const listenerPeer = room.peers.get(listener.id)!;
  const offer = (session: FakeSession, payload = SENDRECV_OFFER) => h.req(session, { type: 'rtc:offer', payload });
  const hold = async (session: FakeSession, payload: SessionDescriptionPayload = SENDRECV_OFFER) => {
    const entered = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<boolean>();
    gates.push({ participantId: speaker.id, entered: entered.resolve, outcome: outcome.promise });
    releases.push(outcome.resolve);
    const pending = h.req(session, { type: 'rtc:offer', payload });
    requests.push(pending);
    await bounded(entered.promise);
    return { pending, fail: () => outcome.resolve(true), succeed: () => outcome.resolve(false) };
  };
  const resume = async () => {
    const session = new FakeSession();
    h.hub.attach(session);
    assert.equal(await h.req(session, { type: 'join', roomId: host.roomId, code: host.code, name: 'Speaker', resumeToken }), 'ok');
    assert.equal(session.last('room:state')!.me.participantId, speaker.id);
    return session;
  };
  const media = (id = speaker.id) => ({ peer: room.peers.get(id), publisher: room.publishers.get(id) });
  const assertLive = (expected: ReturnType<typeof media>, id = speaker.id) => {
    assert.ok(expected.peer);
    assert.ok(expected.publisher);
    assert.equal(room.peers.get(id), expected.peer, 'the current peer must survive');
    assert.equal(room.publishers.get(id), expected.publisher, 'the publisher registration must survive');
    assert.equal(room.subscribers.has(id), true, 'the current subscriber must survive');
    assert.equal(room.peers.get(listener.id), listenerPeer, 'unrelated peers must survive');
    assert.equal(mixer.sourceCount, 1, 'the current mixer source must survive');
    assert.equal(h.hub.metrics().find(sample => sample.name === 'stage_publishers')!.value, 1);
    assert.equal(h.hub.roomCount, 1);
  };
  const assertAudio = (id = speaker.id) => {
    assert.equal(h.transport.emitUplink(host.roomId, id, sine(960, 0.2)), true);
    mixer.tick();
    assert.ok(listenerPeer.received.at(-1)!.some(sample => Math.abs(sample) > 0.01), 'the listener still hears the current publisher');
  };
  const assertClean = () => {
    assert.equal(room.peers.has(speaker.id), false);
    assert.equal(room.publishers.has(speaker.id), false);
    assert.equal(room.subscribers.has(speaker.id), false);
    assert.equal(mixer.sourceCount, 0);
    assert.equal(h.hub.metrics().find(sample => sample.name === 'stage_publishers')!.value, 0);
    assert.equal(h.transport.emitUplink(host.roomId, speaker.id, sine(960, 0.2)), false);
    assert.equal(room.peers.get(listener.id), listenerPeer);
    assert.equal(h.hub.roomCount, 1);
  };
  const failOld = async (held: Awaited<ReturnType<typeof hold>>) => {
    held.fail();
    assert.equal(await bounded(held.pending), 'bad_request');
    assert.equal(speaker.s.last('error')!.message, ERROR_MESSAGES.bad_request);
  };
  return { h, host, speaker, listener, room, mixer, resumeToken, firstPeer, peerCloses, roomCloses, negotiations: () => negotiations, offer, hold, resume, media, assertLive, assertAudio, assertClean, failOld };
}

for (const recreate of [false, true]) {
  it(`keeps a ${recreate ? 'recreated' : 'retained'} peer after a resumed session succeeds and the old offer fails`, { timeout: 10000 }, async t => {
    const f = await setup(t);
    const old = await f.hold(f.speaker.s);
    await f.h.hub.detach(f.speaker.s);
    if (recreate) { f.h.hub.onPeerClosed(f.host.roomId, f.speaker.id); await nextTurn(); }
    const current = await f.resume();
    assert.equal(await f.offer(current), 'ok');
    const expected = f.media();
    if (recreate) assert.notEqual(expected.peer, f.firstPeer); else assert.equal(expected.peer, f.firstPeer);
    const inbox = [...current.inbox], hostInbox = [...f.host.s.inbox], closes = [...f.peerCloses];
    await f.failOld(old);
    f.assertLive(expected);
    assert.deepEqual(f.peerCloses, closes, 'a stale failure must not close any peer');
    assert.deepEqual(current.inbox, inbox, 'a stale failure must not reply or broadcast to the replacement');
    assert.deepEqual(f.host.s.inbox, hostInbox);
    assert.equal(f.h.hub.isJoined(current), true);
    assert.equal(current.closed, undefined);
    assert.equal(await f.h.req(current, { type: 'mic:mute' }), 'ok');
    assert.equal(f.room.muted.has(f.speaker.id), true);
    assert.equal(await f.h.req(current, { type: 'mic:unmute' }), 'ok');
    f.assertAudio();
  });
}

it('protects a newer accepted offer even while it is pending and its replacement session has detached', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const old = await f.hold(f.speaker.s);
  await f.h.hub.detach(f.speaker.s);
  const current = await f.resume();
  const newer = await f.hold(current);
  await f.h.hub.detach(current);
  const expected = f.media(), closes = [...f.peerCloses];
  const inbox = [...current.inbox], hostInbox = [...f.host.s.inbox];
  await f.failOld(old);
  f.assertLive(expected);
  assert.deepEqual(f.peerCloses, closes);
  assert.deepEqual(current.inbox, inbox);
  assert.deepEqual(f.host.s.inbox, hostInbox);
  f.assertAudio();
  newer.fail();
  assert.equal(await bounded(newer.pending), 'bad_request', 'the latest offer still owns failure cleanup after detachment');
  f.assertClean();
});

it('cleans up a newer failed offer once and ignores an older failure arriving afterward', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const old = await f.hold(f.speaker.s);
  await f.h.hub.detach(f.speaker.s);
  const current = await f.resume();
  const newer = await f.hold(current);
  newer.fail();
  assert.equal(await bounded(newer.pending), 'bad_request');
  f.assertClean();
  const closes = [...f.peerCloses], inbox = [...current.inbox];
  await f.failOld(old);
  assert.deepEqual(f.peerCloses, closes, 'a superseded failure must not repeat cleanup');
  assert.deepEqual(current.inbox, inbox);
  assert.equal(f.h.hub.isJoined(current), true);
  assert.equal(await f.offer(current), 'ok', 'a failed latest offer leaves the seat usable');
  assert.notEqual(f.media().peer, f.firstPeer);
  f.assertLive(f.media());
  f.assertAudio();
});

for (const resumed of [false, true]) {
  it(`still cleans up the last accepted offer after ${resumed ? 'resuming without a new offer' : 'detaching without a replacement'}`, { timeout: 10000 }, async t => {
    const f = await setup(t);
    const old = await f.hold(f.speaker.s);
    await f.h.hub.detach(f.speaker.s);
    const current = resumed ? await f.resume() : undefined;
    const inbox = current && [...current.inbox];
    await f.failOld(old);
    f.assertClean();
    assert.deepEqual(f.peerCloses, [f.speaker.id]);
    if (current) {
      assert.deepEqual(current.inbox, inbox);
      assert.equal(f.h.hub.isJoined(current), true);
      assert.equal(await f.offer(current), 'ok');
      f.assertLive(f.media());
    }
  });
}

for (const invalid of ['no audio', 'off-stage uplink'] as const) {
  it(`does not transfer cleanup ownership to a newer ${invalid} offer`, { timeout: 10000 }, async t => {
    const f = await setup(t);
    const old = await f.hold(f.speaker.s);
    await f.h.hub.detach(f.speaker.s);
    const current = await f.resume();
    if (invalid === 'off-stage uplink') assert.equal(await f.h.req(f.host.s, { type: 'stage:remove', targetId: f.speaker.id }), 'ok');
    const calls = f.negotiations();
    assert.equal(await f.h.req(current, { type: 'rtc:offer', payload: invalid === 'no audio' ? { type: 'offer', sdp: 'v=0\r\n' } : SENDRECV_OFFER }), invalid === 'no audio' ? 'bad_request' : 'forbidden');
    assert.equal(f.negotiations(), calls, 'invalid offers never reach the transport');
    assert.equal(f.room.peers.get(f.speaker.id), f.firstPeer);
    assert.equal(f.room.subscribers.has(f.speaker.id), true);
    const inbox = [...current.inbox];
    await f.failOld(old);
    f.assertClean();
    assert.deepEqual(f.peerCloses, [f.speaker.id], 'the last policy-accepted offer still owns its peer');
    assert.deepEqual(current.inbox, inbox);
    assert.equal(f.h.hub.isJoined(current), true);
  });
}

it('ignores a failed offer after its seat is removed and the resume token joins a new participant', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const old = await f.hold(f.speaker.s);
  await f.h.hub.detach(f.speaker.s, true);
  const current = new FakeSession();
  f.h.hub.attach(current);
  assert.equal(await f.h.req(current, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Speaker', resumeToken: f.resumeToken }), 'ok');
  const id = current.last('room:state')!.me.participantId;
  assert.notEqual(id, f.speaker.id);
  assert.equal(await f.h.req(current, { type: 'hand:raise' }), 'ok');
  assert.equal(await f.h.req(f.host.s, { type: 'stage:approve', targetId: id }), 'ok');
  assert.equal(await f.offer(current), 'ok');
  const expected = f.media(id), closes = [...f.peerCloses], inbox = [...current.inbox];
  await f.failOld(old);
  f.assertLive(expected, id);
  assert.deepEqual(f.peerCloses, closes, 'an already removed seat has no remaining cleanup');
  assert.deepEqual(current.inbox, inbox);
  assert.equal(f.room.peers.has(f.speaker.id), false);
  assert.equal(f.h.hub.isJoined(current), true);
  f.assertAudio(id);
});

it('ignores failed offer cleanup after the room is closed', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const old = await f.hold(f.speaker.s);
  assert.equal(await f.h.req(f.host.s, { type: 'room:close' }), 'ok');
  const peers = [...f.peerCloses], rooms = [...f.roomCloses], inbox = [...f.host.s.inbox];
  await f.failOld(old);
  assert.deepEqual(f.peerCloses, peers);
  assert.deepEqual(f.roomCloses, rooms, 'late failures do not repeat room teardown');
  assert.deepEqual(f.host.s.inbox, inbox);
  assert.equal(f.h.transport.rooms.has(f.host.roomId), false);
  assert.equal(f.h.hub.roomCount, 0);
  assert.equal(f.h.hub.isJoined(f.speaker.s), false);
});

it('does not apply an old successful receive-only offer to the resumed publisher', { timeout: 10000 }, async t => {
  const f = await setup(t);
  f.speaker.s.clear();
  const old = await f.hold(f.speaker.s, RECVONLY_OFFER);
  await f.h.hub.detach(f.speaker.s);
  const current = await f.resume();
  assert.equal(await f.offer(current), 'ok');
  const expected = f.media(), inbox = [...current.inbox], hostInbox = [...f.host.s.inbox];
  old.succeed();
  assert.equal(await bounded(old.pending), 'no-reply', 'the old answer has no active reader');
  f.assertLive(expected);
  assert.equal(f.speaker.s.last('rtc:answer'), undefined);
  assert.equal(f.speaker.s.last('ok'), undefined);
  assert.equal(f.speaker.s.last('error'), undefined);
  assert.deepEqual(current.inbox, inbox);
  assert.deepEqual(f.host.s.inbox, hostInbox);
  assert.deepEqual(f.peerCloses, []);
  f.assertAudio();
});
