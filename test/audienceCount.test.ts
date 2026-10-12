import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ErrorCode } from '../shared/protocol.ts';
import { StageError } from '../src/model/errors.ts';
import { Room } from '../src/model/room.ts';
import { FakeSession, harness, testConfig } from './helpers.ts';

const person = (id: string) => ({ participantId: id, name: id, resumeToken: `${id}-token` });

function room(): Room {
  return new Room({
    roomId: 'room', name: 'Room', code: '', codeRequired: false, now: 0,
    limits: { maxSpeakers: 8, maxAudience: 300 }, controller: person('host'),
  });
}

function roleCount(r: Room): number {
  return [...r.participants.values()].filter(p => p.role === 'audience').length;
}

function check(r: Room, expected: number): void {
  r.assertInvariants();
  assert.equal(roleCount(r), expected, 'independent role scan matches the scenario');
  assert.equal(r.audienceCount, expected, 'getter matches the role scan');
  assert.ok(Number.isInteger(r.audienceCount) && r.audienceCount >= 0);
  assert.equal(r.sharedSnapshot().audienceCount, expected);
}

function approve(r: Room, id: string): void {
  r.raiseHand(id);
  r.approve(r.controllerId, id, 1);
}

function reject(r: Room, code: ErrorCode, action: () => unknown): void {
  const before = r.snapshot(r.controllerId), expected = roleCount(r);
  assert.throws(action, error => error instanceof StageError && error.code === code);
  assert.deepEqual(r.snapshot(r.controllerId), before, 'rejection preserves the snapshot');
  check(r, expected);
}

test('audience count excludes the controller even when the room has no one on stage', () => {
  const r = room();
  check(r, 0);
  r.leaveStage('host');
  check(r, 0);
  assert.equal(r.status, 'waiting');
  reject(r, 'conflict', () => r.leaveStage('host'));
  r.approve('host', 'host', 1);
  check(r, 0);
});

test('audience count matches roles at the 300-guest boundary through approvals and departures', () => {
  const r = room();
  for (let i = 0; i < 300; i++) {
    r.join(person(`p${i}`), i);
    check(r, i + 1);
  }
  reject(r, 'room_full', () => r.join(person('overflow'), 301));
  for (let i = 0; i < 8; i++) {
    approve(r, `p${i}`);
    check(r, 299 - i);
  }
  r.raiseHand('p8');
  check(r, 292);
  reject(r, 'stage_full', () => r.approve('host', 'p8', 2));
  reject(r, 'stage_full', () => r.transfer('host', 'p8'));
  reject(r, 'forbidden', () => r.removeFromStage('p9', 'p0'));
  reject(r, 'not_found', () => r.remove('missing'));
  r.leaveStage('host');
  check(r, 292);
  r.approve('host', 'host', 2);
  check(r, 292);
  r.removeFromStage('host', 'p0');
  check(r, 293);
  r.leaveStage('p1');
  check(r, 294);
  r.remove('p2');
  check(r, 294);
  r.kick('host', 'p3');
  check(r, 294);
  r.remove('p8');
  check(r, 293);
  assert.deepEqual(r.handQueue, []);
  r.kick('host', 'p9');
  check(r, 292);
});

for (const hostOnStage of [false, true]) {
  for (const targetOnStage of [false, true]) {
    test(`audience count through transfer: controller on stage=${hostOnStage}, target on stage=${targetOnStage}`, () => {
      const r = room();
      r.join(person('target'), 1);
      r.join(person('observer'), 2);
      if (targetOnStage) approve(r, 'target');
      else r.raiseHand('target');
      if (!hostOnStage) r.leaveStage('host');
      const before = targetOnStage ? 1 : 2;
      check(r, before);
      r.transfer('host', 'target');
      check(r, hostOnStage ? 1 : 2);
      assert.equal(r.get('target')!.handRaised, false);
      r.transfer('target', 'host');
      check(r, before);
    });
  }
}

for (const heldSpeakers of [7, 8]) {
  test(`audience count stays valid between each controller-expiry step with ${heldSpeakers} held speakers`, () => {
    const r = room();
    const successor = r.join(person('successor'), 1);
    for (let i = 0; i < heldSpeakers; i++) {
      r.join(person(`p${i}`), i + 2);
      approve(r, `p${i}`);
      r.get(`p${i}`)!.connected = false;
      check(r, 1);
    }
    r.get('host')!.connected = false;
    r.raiseHand('successor');
    check(r, 1);
    assert.equal(r.pickSuccessor(), successor);
    // At capacity the hub steps the expired controller down before transferring.
    if (heldSpeakers === 8) {
      reject(r, 'stage_full', () => r.transfer('host', 'successor', 'auto'));
      r.leaveStage('host');
      check(r, 1);
    }
    r.transfer('host', 'successor', 'auto');
    check(r, heldSpeakers === 8 ? 1 : 0);
    r.remove('host');
    check(r, 0);
    r.get('p0')!.connected = true;
    check(r, 0);
    r.leaveStage('p0');
    check(r, 1);
    r.get('p0')!.connected = false;
    r.raiseHand('p0');
    reject(r, 'conflict', () => r.approve('successor', 'p0', 3));
    reject(r, 'conflict', () => r.transfer('successor', 'p0'));
    r.remove('p0');
    check(r, 0);
  });
}

test('audience count follows held seats, same-seat resume, grace removal and room closure', async t => {
  let captured: Room | undefined;
  const sharedSnapshot = Room.prototype.sharedSnapshot;
  t.mock.method(Room.prototype, 'sharedSnapshot', function (this: Room) {
    captured = this;
    const state = sharedSnapshot.call(this);
    assert.equal(state.audienceCount, roleCount(this));
    assert.ok(state.audienceCount >= 0);
    return state;
  });
  const h = harness(testConfig(config => {
    config.rooms.participantGraceMs = 15_000;
    config.rooms.presenceBroadcastMs = 0;
    config.rooms.qualityIntervalMs = 0;
  }));
  t.after(async () => {
    await h.hub.shutdown();
    assert.equal(h.timers.filter(timer => !timer.cleared).length, 0);
  });
  const host = await h.create();
  assert.ok(captured);
  const r = captured;
  const guest = await h.join(host.roomId, host.code, 'Guest');
  const token = guest.s.last('room:state')!.resumeToken;
  check(r, 1);
  await h.hub.detach(guest.s);
  check(r, 1);
  assert.equal(r.get(guest.id)!.connected, false);
  const held = h.timers.find(timer => !timer.cleared && timer.ms === 15_000)!;
  assert.ok(held);
  const resumed = new FakeSession();
  h.hub.attach(resumed);
  assert.equal(await h.req(resumed, {
    type: 'join', roomId: host.roomId, code: host.code, name: 'Guest', resumeToken: token,
  }), 'ok');
  assert.equal(held.cleared, true);
  assert.equal(resumed.last('room:state')!.me.participantId, guest.id);
  check(r, 1);
  assert.equal(await h.req(resumed, { type: 'hand:raise' }), 'ok');
  assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: guest.id }), 'ok');
  check(r, 0);
  await h.hub.detach(resumed);
  check(r, 0);
  const expiry = h.timers.find(timer => !timer.cleared && timer.ms === 15_000)!;
  assert.ok(expiry);
  expiry.cleared = true;
  expiry.fn();
  await nextTurn();
  assert.equal(r.get(guest.id), undefined);
  check(r, 0);
  const audience = await h.join(host.roomId, host.code, 'Audience');
  check(r, 1);
  assert.equal(await h.req(host.s, { type: 'room:close' }), 'ok');
  assert.equal(h.hub.roomCount, 0);
  assert.equal(audience.s.last('room:closed')!.roomId, host.roomId);
  // Closing disposes the runtime, but a retained Room still has its valid membership.
  check(r, 1);
});

test('repeated audience-count reads do not enumerate participants at any room size', t => {
  let enumerations = 0;
  for (const guestCount of [0, 1, 300]) {
    for (const controllerOnStage of [false, true]) {
      const r = room();
      for (let i = 0; i < guestCount; i++) r.join(person(`p${i}`), i);
      for (let i = 0; i < Math.min(guestCount, 8); i++) approve(r, `p${i}`);
      if (!controllerOnStage) r.leaveStage('host');
      const expected = roleCount(r);
      const spies = [
        t.mock.method(r.participants, 'values'),
        t.mock.method(r.participants, 'keys'),
        t.mock.method(r.participants, 'entries'),
        t.mock.method(r.participants, 'forEach'),
        t.mock.method(r.participants, Symbol.iterator),
      ];
      for (let read = 0; read < 100; read++) assert.equal(r.audienceCount, expected);
      for (const spy of spies) enumerations += spy.mock.callCount();
    }
  }
  assert.equal(enumerations, 0, 'getter must use maintained membership counts without scanning');
});
