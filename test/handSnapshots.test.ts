import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { FakeSession, harness } from './helpers.ts';

const liveTimers = (h: ReturnType<typeof harness>) => h.timers.filter(timer => !timer.cleared);
function flush(h: ReturnType<typeof harness>): void {
  const timers = liveTimers(h).filter(timer => timer.ms === 0);
  for (const timer of timers) { timer.cleared = true; timer.fn(); }
}

describe('coalesced hand snapshots', () => {
  it('preserves every ordered event and requester state before ACK, with one final shared snapshot', async () => {
    const h = harness(), host = await h.create();
    const a = await h.join(host.roomId, host.code, 'A'), b = await h.join(host.roomId, host.code, 'B');
    host.s.clear(); a.s.clear(); b.s.clear();
    await h.req(a.s, { type: 'hand:raise' });
    const originalTimer = liveTimers(h)[0];
    const stateIndex = a.s.inbox.findIndex(message => message.type === 'room:state');
    const ackIndex = a.s.inbox.findIndex(message => message.type === 'ok');
    assert.ok(stateIndex >= 0 && stateIndex < ackIndex);
    assert.equal(a.s.last('room:state')?.me.handRaised, true);
    await h.req(b.s, { type: 'hand:raise' });
    await h.req(a.s, { type: 'hand:withdraw' });
    assert.equal(a.s.last('room:state')?.me.handRaised, false);
    assert.deepEqual(host.s.inbox.map(message => message.type), ['hand:raise', 'hand:raise', 'hand:withdraw']);
    assert.deepEqual(liveTimers(h).map(timer => timer.ms), [0], 'hand flush replaces presence timer and is not rescheduled');
    assert.equal(liveTimers(h)[0], originalTimer, 'later hand changes do not postpone the flush');
    flush(h);
    assert.equal(host.s.all('room:state').length, 1);
    for (const session of [host.s, a.s, b.s]) assert.deepEqual(session.last('room:state')?.hands.map(person => person.participantId), [b.id]);
    assert.equal(liveTimers(h).length, 0);
  });

  it('stage approval supersedes a pending hand flush with immediate authoritative state', async () => {
    const h = harness(), host = await h.create(), a = await h.join(host.roomId, host.code, 'A');
    await h.req(a.s, { type: 'hand:raise' });
    const pending = liveTimers(h)[0]!;
    assert.equal(pending.ms, 0);
    await h.req(host.s, { type: 'stage:approve', targetId: a.id });
    assert.equal(pending.cleared, true);
    assert.equal(a.s.last('room:state')?.me.onStage, true);
    assert.deepEqual(host.s.last('room:state')?.hands, []);
    const snapshots = host.s.all('room:state').length;
    flush(h);
    assert.equal(host.s.all('room:state').length, snapshots);
  });

  it('flushes current connected identities after disconnect/resume and clears scheduled work on room close', async () => {
    const h = harness(), host = await h.create(), a = await h.join(host.roomId, host.code, 'A');
    await h.req(a.s, { type: 'hand:raise' });
    const token = a.s.last('room:state')!.resumeToken!;
    await h.hub.detach(a.s);
    const back = new FakeSession(); h.hub.attach(back);
    await h.req(back, { type: 'join', roomId: host.roomId, code: host.code, name: 'A', resumeToken: token });
    const retiredStates = a.s.all('room:state').length;
    flush(h);
    assert.equal(a.s.all('room:state').length, retiredStates);
    assert.equal(back.last('room:state')?.me.participantId, a.id);
    assert.equal(back.last('room:state')?.me.connected, true);
    assert.deepEqual(host.s.last('room:state')?.hands.map(person => person.participantId), [a.id]);
    await h.req(back, { type: 'hand:withdraw' });
    const pending = liveTimers(h).find(timer => timer.ms === 0)!;
    await h.req(host.s, { type: 'room:close' });
    assert.equal(pending.cleared, true);
    const afterClose = back.inbox.length;
    flush(h);
    assert.equal(back.inbox.length, afterClose);
    assert.equal(back.last('room:closed')?.roomId, host.roomId);
    assert.equal(liveTimers(h).length, 0);
  });

  it('keeps a single scheduled flush per room during independent hand bursts', async () => {
    const h = harness(), first = await h.create('One'), second = await h.create('Two');
    const crowd = [];
    for (let index = 0; index < 30; index++) {
      const room = index % 2 ? first : second;
      crowd.push(await h.join(room.roomId, room.code, `A${index}`));
    }
    first.s.clear(); second.s.clear();
    await Promise.all(crowd.map(person => h.req(person.s, { type: 'hand:raise' })));
    assert.deepEqual(liveTimers(h).map(timer => timer.ms), [0, 0]);
    assert.equal(first.s.all('room:state').length, 0);
    assert.equal(second.s.all('room:state').length, 0);
    flush(h);
    assert.equal(first.s.all('room:state').length, 1);
    assert.equal(second.s.all('room:state').length, 1);
    assert.equal(first.s.last('room:state')?.hands.length, 15);
    assert.equal(second.s.last('room:state')?.hands.length, 15);
  });

  it('coalesces raised-hand audience departures and grace expiry', async () => {
    for (const left of [true, false]) {
      const h = harness(), host = await h.create();
      const crowd = [];
      for (let index = 0; index < 20; index++) crowd.push(await h.join(host.roomId, host.code, `A${index}`));
      for (const person of crowd) await h.req(person.s, { type: 'hand:raise' });
      flush(h); host.s.clear();
      await Promise.all(crowd.map(person => h.hub.detach(person.s, left)));
      if (!left) {
        const grace = liveTimers(h).filter(timer => timer.ms === 15000);
        assert.equal(grace.length, 20);
        for (const timer of grace) { timer.cleared = true; timer.fn(); }
        // Let the queued synchronous expiry commands settle; hub timers remain controlled.
        await nextTurn();
      }
      assert.equal(host.s.all('hand:withdraw').length, 20);
      assert.equal(host.s.all('room:state').length, 0);
      assert.deepEqual(liveTimers(h).map(timer => timer.ms), [0]);
      flush(h);
      assert.equal(host.s.all('room:state').length, 1);
      assert.deepEqual(host.s.last('room:state')?.hands, []);
      assert.equal(host.s.last('room:state')?.audienceCount, 0);
    }
  });

});
