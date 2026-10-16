import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ServerMessage } from '../shared/protocol.ts';
import type { Room } from '../src/model/room.ts';
import { FakeSession, harness, testConfig, type Harness } from './helpers.ts';

const types = (session: FakeSession) => session.inbox.map(message => message.type);
const notifications = (session: FakeSession) => session.all('hand:rejected');
const liveTimers = (h: Harness) => h.timers.filter(timer => !timer.cleared);
function flush(h: Harness): void {
  for (const timer of liveTimers(h).filter(timer => timer.ms === 0 || timer.ms === 250)) {
    timer.cleared = true;
    timer.fn();
  }
}
function setup(t: TestContext): Harness {
  const h = harness(testConfig(config => {
    config.rooms.presenceBroadcastMs = 250;
    config.rooms.qualityIntervalMs = 0;
  }));
  t.after(async () => {
    await h.hub.shutdown();
    await h.transport.close();
    assert.equal(h.hub.roomCount, 0);
    assert.equal(h.transport.rooms.size, 0);
    assert.deepEqual(liveTimers(h), []);
  });
  return h;
}
function room(h: Harness, roomId: string): Room {
  const rooms = (h.hub as unknown as { rooms: Map<string, { room: Room }> }).rooms;
  return rooms.get(roomId)!.room;
}

it('adds exactly one target-only frame after authoritative state and before the controller ACK', async t => {
  const h = setup(t), host = await h.create(), target = await h.join(host.roomId, host.code, 'Target');
  const observer = await h.join(host.roomId, host.code, 'Observer'), elsewhere = await h.create('Elsewhere');
  assert.equal(await h.req(target.s, { type: 'hand:raise' }), 'ok');
  const pending = liveTimers(h).find(timer => timer.ms === 0)!;
  assert.ok(pending);
  const trace: { session: FakeSession; message: ServerMessage; wire: string }[] = [];
  for (const session of [host.s, target.s, observer.s, elsewhere.s]) {
    session.clear();
    const send = session.send.bind(session);
    t.mock.method(session, 'send', (message: ServerMessage, encoded?: string) => {
      const wire = encoded ?? JSON.stringify(message);
      assert.deepEqual(JSON.parse(wire), JSON.parse(JSON.stringify(message)));
      trace.push({ session, message, wire });
      send(message, encoded);
    });
  }
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'ok');
  assert.deepEqual(types(target.s), ['hand:withdraw', 'room:state', 'hand:rejected']);
  assert.deepEqual(types(host.s), ['hand:withdraw', 'room:state', 'ok']);
  assert.deepEqual(types(observer.s), ['hand:withdraw', 'room:state']);
  assert.deepEqual(types(elsewhere.s), []);
  const notice = notifications(target.s)[0]!;
  assert.deepEqual(notice, { type: 'hand:rejected', roomId: host.roomId, participantId: target.id });
  assert.equal(trace.filter(item => item.message.type === 'hand:rejected').length, 1);
  const noticeIndex = trace.findIndex(item => item.message.type === 'hand:rejected');
  const ackIndex = trace.findIndex(item => item.session === host.s && item.message.type === 'ok');
  assert.ok(noticeIndex > 0 && noticeIndex < ackIndex);
  for (const [session, id] of [[host.s, host.id], [target.s, target.id], [observer.s, observer.id]] as const) {
    const stateIndex = trace.findIndex(item => item.session === session && item.message.type === 'room:state');
    assert.ok(stateIndex >= 0 && stateIndex < noticeIndex, 'all existing authoritative snapshots precede the private notice');
    const expected = { type: 'room:state', ...room(h, host.roomId).snapshot(id) };
    assert.deepEqual(session.last('room:state'), expected, 'existing recipient state is unchanged by the new notification');
    assert.deepEqual(session.all('hand:withdraw'), [{ type: 'hand:withdraw', participantId: target.id }]);
  }
  assert.equal(target.s.last('room:state')!.me.handRaised, false);
  assert.equal(target.s.last('room:state')!.me.onStage, false);
  assert.deepEqual(target.s.last('room:state')!.hands, []);
  assert.equal(pending.cleared, true, 'reject still supersedes the coalesced hand snapshot');
  const count = trace.length;
  flush(h);
  assert.equal(trace.length, count, 'a scheduled hand flush never repeats the notice');
});

it('does not notify on forbidden, unknown-target, absent-hand or repeat rejections', async t => {
  const h = setup(t), host = await h.create(), target = await h.join(host.roomId, host.code, 'Target');
  const observer = await h.join(host.roomId, host.code, 'Observer'), other = await h.create('Other');
  await h.req(target.s, { type: 'hand:raise' }); flush(h);
  for (const session of [host.s, target.s, observer.s, other.s]) session.clear();
  assert.equal(await h.req(observer.s, { type: 'stage:reject', targetId: target.id }), 'forbidden');
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: other.id }), 'not_found');
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: observer.id }), 'conflict');
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: host.id }), 'conflict');
  assert.equal(room(h, host.roomId).get(target.id)!.handRaised, true);
  assert.deepEqual(types(target.s), []);
  assert.deepEqual(types(observer.s), ['error']);
  assert.deepEqual(types(host.s), ['error', 'error', 'error']);
  assert.deepEqual(types(other.s), []);
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'ok');
  const accepted = notifications(target.s).length;
  assert.equal(accepted, 1);
  const count = target.s.inbox.length;
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'conflict');
  assert.equal(target.s.inbox.length, count);
  for (const session of [host.s, observer.s, other.s]) assert.deepEqual(notifications(session), []);
});

for (const action of ['withdraw', 'approve', 'kick', 'leave', 'close'] as const) {
  it(`does not confuse ${action} with a controller rejection`, async t => {
    const h = setup(t), host = await h.create(), target = await h.join(host.roomId, host.code, 'Target');
    await h.req(target.s, { type: 'hand:raise' }); flush(h);
    host.s.clear(); target.s.clear();
    if (action === 'withdraw') await h.req(target.s, { type: 'hand:withdraw' });
    else if (action === 'approve') await h.req(host.s, { type: 'stage:approve', targetId: target.id });
    else if (action === 'kick') await h.req(host.s, { type: 'participant:kick', targetId: target.id });
    else if (action === 'leave') await h.hub.detach(target.s, true);
    else await h.req(host.s, { type: 'room:close' });
    flush(h);
    assert.deepEqual(notifications(host.s), []);
    assert.deepEqual(notifications(target.s), []);
  });
}

it('successfully rejects a retained offline hand without delivery or replay on resume', async t => {
  const h = setup(t), host = await h.create(), target = await h.join(host.roomId, host.code, 'Target');
  await h.req(target.s, { type: 'hand:raise' });
  const token = target.s.last('room:state')!.resumeToken!;
  await h.hub.detach(target.s); flush(h);
  assert.equal(room(h, host.roomId).get(target.id)!.handRaised, true);
  assert.equal(room(h, host.roomId).get(target.id)!.connected, false);
  host.s.clear(); target.s.clear();
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'ok');
  assert.deepEqual(types(host.s), ['hand:withdraw', 'room:state', 'ok']);
  assert.deepEqual(types(target.s), []);
  const replacement = new FakeSession(); h.hub.attach(replacement);
  assert.equal(await h.req(replacement, { type: 'join', roomId: host.roomId, code: host.code, name: 'Target', resumeToken: token }), 'ok');
  assert.equal(replacement.last('room:state')!.me.participantId, target.id);
  assert.equal(replacement.last('room:state')!.me.handRaised, false);
  assert.deepEqual(replacement.last('room:state')!.hands, []);
  flush(h);
  assert.deepEqual(notifications(replacement), []);
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'conflict');
  assert.deepEqual(notifications(replacement), []);
});

it('uses only the current resumed session and never a retired target session', async t => {
  const h = setup(t), host = await h.create(), target = await h.join(host.roomId, host.code, 'Target');
  await h.req(target.s, { type: 'hand:raise' });
  const token = target.s.last('room:state')!.resumeToken!;
  await h.hub.detach(target.s);
  const replacement = new FakeSession(); h.hub.attach(replacement);
  assert.equal(await h.req(replacement, { type: 'join', roomId: host.roomId, code: host.code, name: 'Target', resumeToken: token }), 'ok');
  flush(h); target.s.clear(); replacement.clear();
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'ok');
  assert.deepEqual(types(target.s), []);
  assert.deepEqual(types(replacement), ['hand:withdraw', 'room:state', 'hand:rejected']);
  assert.deepEqual(notifications(replacement), [{ type: 'hand:rejected', roomId: host.roomId, participantId: target.id }]);
});

for (const replacementRoom of [false, true]) {
  it(`rechecks the target binding when its state callback ${replacementRoom ? 'creates a new room' : 'detaches'}`, async t => {
    const h = setup(t), host = await h.create(), target = await h.join(host.roomId, host.code, 'Target');
    await h.req(target.s, { type: 'hand:raise' }); flush(h);
    target.s.clear();
    const send = target.s.send.bind(target.s);
    let detached: Promise<void> | undefined, created: Promise<string> | undefined;
    t.mock.method(target.s, 'send', (message: ServerMessage, encoded?: string) => {
      send(message, encoded);
      if (message.type === 'room:state' && message.roomId === host.roomId && !detached) {
        detached = h.hub.detach(target.s);
        if (replacementRoom) created = h.req(target.s, { type: 'room:create', name: 'Replacement', roomName: 'New room' });
      }
    });
    assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'ok');
    assert.ok(detached); await detached;
    if (replacementRoom) {
      assert.equal(await created, 'ok');
      assert.notEqual(target.s.last('room:state')!.roomId, host.roomId);
    }
    assert.deepEqual(notifications(target.s), [], 'old-room delivery cannot escape through a no-longer-current session');
    assert.equal(room(h, host.roomId).get(target.id)!.handRaised, false);
  });
}

it('does not notify after failed invariant validation or after the room has closed', async t => {
  const h = setup(t), host = await h.create(), target = await h.join(host.roomId, host.code, 'Target');
  await h.req(target.s, { type: 'hand:raise' }); flush(h);
  room(h, host.roomId).handQueue.push('missing-participant');
  host.s.clear(); target.s.clear();
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'internal');
  assert.deepEqual(types(target.s), ['room:closed']);
  assert.deepEqual(types(host.s), ['room:closed', 'error']);
  assert.equal(h.hub.roomCount, 0);
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'not_joined');
  assert.deepEqual(notifications(target.s), []);
});

it('keeps the existing fail-closed send-error policy instead of acknowledging a failed notification', async t => {
  const h = setup(t), host = await h.create(), target = await h.join(host.roomId, host.code, 'Target');
  const observer = await h.join(host.roomId, host.code, 'Observer');
  await h.req(target.s, { type: 'hand:raise' }); flush(h);
  for (const session of [host.s, target.s, observer.s]) session.clear();
  const send = target.s.send.bind(target.s);
  let attempts = 0;
  t.mock.method(target.s, 'send', (message: ServerMessage, encoded?: string) => {
    if (message.type === 'hand:rejected') { attempts++; throw new Error('controlled notification send failure'); }
    send(message, encoded);
  });
  assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: target.id }), 'internal');
  assert.equal(attempts, 1, 'notification is not retried');
  assert.deepEqual(types(host.s), ['hand:withdraw', 'room:state', 'room:closed', 'error']);
  assert.deepEqual(types(target.s), ['hand:withdraw', 'room:state', 'room:closed']);
  assert.deepEqual(types(observer.s), ['hand:withdraw', 'room:state', 'room:closed']);
  assert.equal(target.s.last('room:state')!.me.handRaised, false, 'the accepted transition preceded the send failure');
  assert.equal(h.hub.roomCount, 0);
  assert.equal(h.transport.rooms.size, 0);
  assert.deepEqual(liveTimers(h), []);
});
