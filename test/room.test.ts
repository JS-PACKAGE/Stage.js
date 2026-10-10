import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvariantViolation } from '../src/model/errors.ts';
import { Room } from '../src/model/room.ts';

function room(): Room {
  const r = new Room({
    roomId: 'room', name: 'Room', code: '', codeRequired: false, now: 0,
    limits: { maxSpeakers: 8, maxAudience: 300 },
    controller: { participantId: 'host', name: 'Host', resumeToken: 'host-token' },
  });
  r.join({ participantId: 'guest', name: 'Guest', resumeToken: 'guest-token' }, 1);
  return r;
}

test('invariants reject a second controller and an audience member on stage', () => {
  const doubleController = room();
  doubleController.get('guest')!.role = 'controller';
  assert.throws(() => doubleController.assertInvariants(), InvariantViolation);

  const audiencePublisher = room();
  audiencePublisher.get('guest')!.onStage = true;
  audiencePublisher.speakers.add('guest');
  assert.throws(() => audiencePublisher.assertInvariants(), InvariantViolation);
});

test('invariants reject unknown, duplicate and mismatched hand-queue membership', () => {
  const unknown = room();
  unknown.handQueue.push('missing');
  assert.throws(() => unknown.assertInvariants(), InvariantViolation);

  const duplicate = room();
  duplicate.raiseHand('guest');
  duplicate.handQueue.push('guest');
  assert.throws(() => duplicate.assertInvariants(), InvariantViolation);

  const missingFlag = room();
  missingFlag.handQueue.push('guest');
  assert.throws(() => missingFlag.assertInvariants(), InvariantViolation);

  const missingEntry = room();
  missingEntry.get('guest')!.handRaised = true;
  assert.throws(() => missingEntry.assertInvariants(), InvariantViolation);
});
