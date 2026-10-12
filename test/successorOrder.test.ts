import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Room } from '../src/model/room.ts';
import { FakeSession, harness, testConfig, type Harness } from './helpers.ts';

function room(): Room {
  return new Room({
    roomId: 'room', name: 'Room', code: '', codeRequired: false, now: 1_000,
    limits: { maxSpeakers: 8, maxAudience: 300 },
    controller: { participantId: 'host', name: 'Host', resumeToken: 'host-token' },
  });
}

function join(r: Room, id: string, now: number) {
  return r.join({ participantId: id, name: id, resumeToken: `${id}-token` }, now);
}

function approve(r: Room, id: string, now: number): void {
  r.raiseHand(id);
  r.approve(r.controllerId, id, now);
}

describe('automatic controller succession follows collection entry order', () => {
  for (const laterTime of [100, 4_000]) {
    it(`uses stage-entry order when the later approval time is ${laterTime}`, () => {
      const r = room();
      join(r, 'audience', 1_100);
      const later = join(r, 'later', 2_000);
      const first = join(r, 'first', 3_000);
      approve(r, first.participantId, 4_000);
      approve(r, later.participantId, laterTime);

      assert.deepEqual([...r.speakers], ['host', 'first', 'later']);
      assert.equal(first.stageSince, 4_000);
      assert.equal(later.stageSince, laterTime, 'stage timestamps retain the supplied wall time');
      assert.deepEqual(r.snapshot('host').speakers.map(p => [p.participantId, p.joinedAt]), [
        ['host', 1_000], ['first', 3_000], ['later', 2_000],
      ]);
      assert.equal(r.pickSuccessor(), first, 'first on stage wins over earlier room joins and earlier wall timestamps');
      r.assertInvariants();
    });
  }

  for (const laterTime of [100, 2_000]) {
    it(`uses audience join order when the later join time is ${laterTime}`, () => {
      const r = room();
      const first = join(r, 'first', 2_000);
      join(r, 'later', laterTime);

      assert.deepEqual(r.snapshot('host').audience?.map(p => [p.participantId, p.joinedAt]), [
        ['first', 2_000], ['later', laterTime],
      ], 'public timestamps are neither clamped nor replaced with ordering counters');
      assert.equal(r.pickSuccessor(), first);
      r.assertInvariants();
    });
  }

  for (const onStage of [true, false]) {
    it(`skips disconnected ${onStage ? 'speakers' : 'audience'} without losing their priority when reconnected`, () => {
      const r = room();
      const first = join(r, 'first', 2_000);
      const later = join(r, 'later', 100);
      if (onStage) {
        approve(r, first.participantId, 3_000);
        approve(r, later.participantId, 200);
      }
      const participantOrder = [...r.participants.keys()];
      const stageOrder = [...r.speakers];
      first.connected = false;
      assert.equal(r.pickSuccessor(), later);
      later.connected = false;
      assert.equal(r.pickSuccessor(), undefined, 'the current controller is never its own successor');
      const audience = join(r, 'fallback', 50);
      assert.equal(r.pickSuccessor(), audience, 'held seats do not prevent a connected audience successor');
      first.connected = true;

      assert.deepEqual([...r.participants.keys()], [...participantOrder, 'fallback']);
      assert.deepEqual([...r.speakers], stageOrder);
      assert.equal(first.joinedAt, 2_000);
      assert.equal(first.stageSince, onStage ? 3_000 : 0);
      assert.equal(r.pickSuccessor(), first, 'reconnection keeps the original entry position');
      r.assertInvariants();
    });
  }

  it('puts a speaker who leaves and is reapproved behind uninterrupted speakers despite a rollback', () => {
    const r = room();
    const returning = join(r, 'returning', 2_000);
    const uninterrupted = join(r, 'uninterrupted', 3_000);
    approve(r, returning.participantId, 4_000);
    approve(r, uninterrupted.participantId, 5_000);
    r.leaveStage(returning.participantId);
    approve(r, returning.participantId, 100);

    assert.deepEqual([...r.speakers], ['host', 'uninterrupted', 'returning']);
    assert.deepEqual([...r.participants.keys()], ['host', 'returning', 'uninterrupted']);
    assert.equal(returning.stageSince, 100);
    assert.equal(r.view(returning).joinedAt, 2_000, 'stepping down does not restart room membership');
    assert.equal(r.pickSuccessor(), uninterrupted);
    r.assertInvariants();
  });

  it('puts removed and rejoined audience behind uninterrupted room members despite a rollback', () => {
    const r = room();
    join(r, 'returning', 2_000);
    const uninterrupted = join(r, 'uninterrupted', 3_000);
    r.remove('returning');
    const returning = join(r, 'returning', 100);

    assert.deepEqual([...r.participants.keys()], ['host', 'uninterrupted', 'returning']);
    assert.equal(r.view(returning).joinedAt, 100, 'a new membership keeps its actual wall timestamp');
    assert.equal(r.pickSuccessor(), uninterrupted);
    r.assertInvariants();
  });

  for (const onStage of [true, false]) {
    it(`retains ${onStage ? 'stage' : 'audience'} entry order through manual control transfers`, () => {
      const r = room();
      const first = join(r, 'first', 2_000);
      const later = join(r, 'later', 100);
      if (onStage) {
        approve(r, first.participantId, 3_000);
        approve(r, later.participantId, 200);
      } else {
        r.leaveStage('host');
      }
      const participantOrder = [...r.participants.keys()];
      const stageOrder = [...r.speakers];
      const timestamps = [...r.participants.values()].map(p => [p.joinedAt, p.stageSince]);
      r.transfer('host', later.participantId);
      r.transfer(later.participantId, first.participantId);

      assert.deepEqual([...r.participants.keys()], participantOrder);
      assert.deepEqual([...r.speakers], stageOrder);
      assert.deepEqual([...r.participants.values()].map(p => [p.joinedAt, p.stageSince]), timestamps);
      assert.equal(r.pickSuccessor(), r.get('host'), 'a former controller retains its existing position');
      r.assertInvariants();
    });
  }
});

type Timer = Harness['timers'][number];
const liveTimers = (h: Harness) => h.timers.filter(timer => !timer.cleared);

function expiryHarness(t: TestContext): Harness {
  const h = harness(testConfig(config => {
    config.rooms.controllerGraceMs = 60_000;
    config.rooms.participantGraceMs = 15_000;
    config.rooms.presenceBroadcastMs = 0;
    config.rooms.qualityIntervalMs = 0;
  }));
  t.after(async () => {
    await h.hub.shutdown();
    assert.equal(h.hub.roomCount, 0);
    assert.equal(h.transport.rooms.size, 0);
    assert.equal(liveTimers(h).length, 0, 'shutdown clears all pending harness timers');
  });
  return h;
}

async function fire(timer: Timer): Promise<void> {
  assert.equal(timer.cleared, false, 'only fire a pending timer');
  timer.cleared = true;
  timer.fn();
  // The injected timer drives grace expiry; only its queued work needs an event-loop turn.
  await nextTurn();
}

describe('StageHub controller grace expiry after wall-clock rollback', { timeout: 5_000 }, () => {
  for (const onStage of [true, false]) {
    it(`transfers to the earliest connected ${onStage ? 'speaker' : 'audience member'} after same-seat resume`, async t => {
      const h = expiryHarness(t);
      h.clock.now = 4_000_000;
      const host = await h.create();
      if (onStage) {
        h.clock.now = 4_050_000;
        await h.join(host.roomId, host.code, 'Earlier audience');
      }
      h.clock.now = 4_100_000;
      const first = await h.join(host.roomId, host.code, 'First');
      if (onStage) {
        assert.equal(await h.req(first.s, { type: 'hand:raise' }), 'ok');
        h.clock.now = 4_200_000;
        assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: first.id }), 'ok');
      }
      h.clock.now = 1_000_000;
      const later = await h.join(host.roomId, host.code, 'Later');
      if (onStage) {
        assert.equal(await h.req(later.s, { type: 'hand:raise' }), 'ok');
        h.clock.now = 1_100_000;
        assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: later.id }), 'ok');
      }

      const token = first.s.last('room:state')!.resumeToken;
      await h.hub.detach(first.s);
      const participantTimers = liveTimers(h).filter(timer => timer.ms === 15_000);
      assert.equal(participantTimers.length, 1);
      h.clock.now = 900_000;
      const resumed = new FakeSession();
      h.hub.attach(resumed);
      assert.equal(await h.req(resumed, {
        type: 'join', roomId: host.roomId, code: host.code, name: 'First', resumeToken: token,
      }), 'ok');
      assert.equal(participantTimers[0]!.cleared, true);
      assert.equal(resumed.last('room:state')!.me.participantId, first.id);
      assert.equal(resumed.last('room:state')!.me.joinedAt, 4_100_000);
      assert.equal(resumed.last('room:state')!.resumeToken, token);

      await h.hub.detach(host.s);
      const controllerTimers = liveTimers(h).filter(timer => timer.ms === 60_000);
      assert.equal(controllerTimers.length, 1);
      assert.equal(resumed.last('room:state')!.controllerId, host.id, 'control is retained throughout grace');
      assert.equal(resumed.last('control:transferred'), undefined);
      resumed.clear(); later.s.clear();
      h.clock.now = 800_000;

      await fire(controllerTimers[0]!);

      assert.equal(h.hub.roomCount, 1);
      const state = resumed.last('room:state')!;
      assert.equal(state.controllerId, first.id);
      assert.equal(state.me.role, 'controller');
      assert.equal(state.me.onStage, onStage);
      assert.equal(state.me.connected, true);
      assert.equal(state.me.joinedAt, 4_100_000);
      assert.equal(later.s.last('room:state')!.me.joinedAt, 1_000_000, 'wire timestamps preserve the rollback');
      assert.equal(state.code, host.code);
      assert.equal(state.resumeToken, token);
      assert.equal(later.s.last('room:state')!.code, undefined);
      assert.equal(state.speakers.some(p => p.participantId === host.id), false);
      assert.equal(state.audience?.some(p => p.participantId === host.id), false);
      for (const session of [resumed, later.s]) {
        assert.deepEqual(session.all('control:transferred'), [{ type: 'control:transferred', fromId: host.id, toId: first.id }]);
        assert.equal(session.all('room:state').length, 1, 'only the completed transfer snapshot is observable');
        assert.equal(session.last('room:closed'), undefined);
      }
      assert.equal(liveTimers(h).length, 0);
    });
  }
});
