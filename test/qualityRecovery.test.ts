import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { it } from 'node:test';
import type { TransportStats } from '../src/transport/MediaTransport.ts';
import { harness, SENDRECV_OFFER, testConfig } from './helpers.ts';

async function room(disabled = false) {
  const config = testConfig(c => { if (disabled) c.rooms.qualityIntervalMs = 0; });
  const h = harness(config), host = await h.create();
  assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  const timers = () => h.timers.filter(timer => !timer.cleared && timer.ms === config.rooms.qualityIntervalMs);
  const fire = () => { const pending = timers(); assert.equal(pending.length, 1); pending[0]!.cleared = true; pending[0]!.fn(); };
  const speaker = async () => {
    const person = await h.join(host.roomId, host.code, 'Speaker');
    await h.req(person.s, { type: 'hand:raise' }); await h.req(host.s, { type: 'stage:approve', targetId: person.id });
    assert.equal(await h.req(person.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    return person;
  };
  return { h, host, timers, fire, speaker };
}

it('reports healthy publishers during a partial failure and recovers the failed publisher next cycle', async () => {
  const { h, host, timers, fire, speaker } = await room(); const second = await speaker();
  const audience = await h.join(host.roomId, host.code, 'Audience');
  const original = h.transport.getStats.bind(h.transport); let fail = true;
  h.transport.getStats = async (roomId, id) => { if (id === second.id && fail) { fail = false; throw new Error('transient stats failure'); } return original(roomId, id); };
  fire(); await nextTurn();
  assert.deepEqual(host.s.last('quality')!.participants.map(p => p.participantId), [host.id]);
  assert.deepEqual(second.s.last('quality'), host.s.last('quality')); assert.equal(audience.s.last('quality'), undefined);
  assert.equal(timers().length, 1);
  fire(); await nextTurn();
  assert.deepEqual(host.s.last('quality')!.participants.map(p => p.participantId).sort(), [host.id, second.id].sort());
  assert.equal(timers().length, 1);
});

for (const synchronous of [false, true]) it(`recovers after every stats call fails ${synchronous ? 'synchronously' : 'asynchronously'}`, async () => {
  const { h, host, timers, fire } = await room(); const original = h.transport.getStats.bind(h.transport);
  h.transport.getStats = synchronous ? () => { throw new Error('sync failure'); } : async () => { throw new Error('async failure'); };
  fire(); await nextTurn(); assert.equal(host.s.last('quality'), undefined); assert.equal(timers().length, 1);
  h.transport.getStats = original; fire(); await nextTurn();
  assert.equal(host.s.last('quality')!.participants[0]!.participantId, host.id); assert.equal(timers().length, 1);
});

for (const action of ['close', 'leave'] as const) it(`does not reschedule or report after ${action} while collection is pending`, async () => {
  const { h, host, timers, fire } = await room(); const pending = Promise.withResolvers<TransportStats | null>();
  h.transport.getStats = () => pending.promise;
  fire(); await nextTurn();
  await h.req(host.s, { type: action === 'close' ? 'room:close' : 'stage:leave' });
  pending.resolve({ inbound: { packetsReceived: 10, packetsLost: 1 } }); await nextTurn();
  assert.equal(host.s.last('quality'), undefined); assert.equal(timers().length, 0);
});

it('keeps one in-flight collection when another publisher arrives', async () => {
  const { h, host, timers, fire, speaker } = await room(); const pending = Promise.withResolvers<TransportStats | null>();
  const original = h.transport.getStats.bind(h.transport); let calls = 0;
  h.transport.getStats = () => { calls++; return pending.promise; };
  fire(); await nextTurn(); const second = await speaker();
  assert.equal(calls, 1); assert.equal(timers().length, 0, 'no next cycle until the current collection settles');
  pending.resolve({ inbound: { packetsReceived: 10, packetsLost: 0 } }); await nextTurn();
  assert.deepEqual(host.s.last('quality')!.participants.map(p => p.participantId), [host.id]);
  assert.equal(timers().length, 1); h.transport.getStats = original; fire(); await nextTurn();
  assert.deepEqual(host.s.last('quality')!.participants.map(p => p.participantId).sort(), [host.id, second.id].sort());
});

it('ignores a retired publishing generation after the same participant republishes', async () => {
  const { h, host, timers, fire } = await room(); const pending = Promise.withResolvers<TransportStats | null>();
  const original = h.transport.getStats.bind(h.transport); h.transport.getStats = () => pending.promise;
  fire(); await nextTurn(); await h.req(host.s, { type: 'stage:leave' });
  await h.req(host.s, { type: 'stage:approve', targetId: host.id });
  await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
  assert.equal(timers().length, 0);
  pending.resolve({ inbound: { packetsReceived: 1000, packetsLost: 500 } }); await nextTurn();
  assert.equal(host.s.last('quality'), undefined, 'old counters must not seed the new publisher');
  assert.equal(timers().length, 1); h.transport.getStats = original; fire(); await nextTurn();
  assert.deepEqual(host.s.last('quality')!.participants, [{ participantId: host.id }]);
});

it('never starts polling when quality reports are disabled', async () => {
  const { timers, speaker } = await room(true); await speaker(); assert.equal(timers().length, 0);
});

it('keeps the last successful counter baseline across a failed collection', async () => {
  const { h, host, timers, fire } = await room(); let calls = 0;
  h.transport.getStats = async () => {
    if (++calls === 2) throw new Error('missed collection');
    return { inbound: { packetsReceived: calls === 1 ? 90 : 180, packetsLost: 10 } };
  };
  fire(); await nextTurn(); assert.equal(host.s.last('quality')!.participants[0]!.uplinkLossPercent, 10);
  host.s.clear(); fire(); await nextTurn(); assert.equal(host.s.last('quality'), undefined); assert.equal(timers().length, 1);
  fire(); await nextTurn();
  assert.equal(host.s.last('quality')!.participants[0]!.uplinkLossPercent, 0, 'no new losses since the previous successful report');
  assert.equal(timers().length, 1);
});
