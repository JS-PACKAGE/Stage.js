import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { decodeName } from '../packages/client/src/index.ts';
import type { TransportStats } from '../src/transport/MediaTransport.ts';
import { actualApp, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { flushSample, sampleApp } from './fixtures/sampleApp.ts';
import { FakeSession, harness, RECVONLY_OFFER, SENDRECV_OFFER, testConfig } from './helpers.ts';

// Real Hub/Room scheduling and SDK/UI code; stats, timers, sockets, DOM and browser media are controlled.
// These tests do not establish real WebRTC/browser behavior or an upper bound on a pending stats call.
const EMPTY = { type: 'quality' as const, participants: [] };
type Person = { s: FakeSession; id: string };
type Stop = 'recvonly' | 'onPeerClosed';

async function setup(t: TestContext, disabled = false) {
  const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; if (disabled) c.rooms.qualityIntervalMs = 0; });
  const h = harness(config);
  t.after(() => h.hub.shutdown());
  const host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  const calls: { roomId: string; participantId: string }[] = [];
  let collect: typeof h.transport.getStats = async () => ({
    inbound: { packetsReceived: 92, packetsLost: 8 }, outbound: { fractionLost: 0.02 }, rttMs: 37,
  });
  h.transport.getStats = (roomId, participantId) => { calls.push({ roomId, participantId }); return collect(roomId, participantId); };
  const setStats = (fn: typeof collect) => { collect = fn; };
  const pendingStats = () => {
    const pending = Promise.withResolvers<TransportStats | null>();
    t.after(() => pending.resolve(null));
    return pending;
  };
  const timers = () => h.timers.filter(timer => !timer.cleared && timer.ms === config.rooms.qualityIntervalMs);
  const fire = () => {
    const jobs = timers(); assert.equal(jobs.length, 1, 'exactly one scheduled quality cycle');
    jobs[0]!.cleared = true; jobs[0]!.fn();
    assert.equal(timers().length, 0, 'collection does not overlap another scheduled cycle');
  };
  const offer = async (person: Person, payload = SENDRECV_OFFER) => {
    assert.equal(await h.req(person.s, { type: 'rtc:offer', payload }), 'ok');
  };
  const stop = async (person: Person, action: Stop) => {
    if (action === 'recvonly') await offer(person, RECVONLY_OFFER);
    else { h.hub.onPeerClosed(host.roomId, person.id); await nextTurn(); }
    assert.equal(h.transport.rooms.get(host.roomId)!.publishers.has(person.id), false);
  };
  const speaker = async (publish = true) => {
    const person = await h.join(host.roomId, host.code, 'Speaker');
    assert.equal(await h.req(person.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: person.id }), 'ok');
    if (publish) await offer(person);
    return person;
  };
  const seed = async () => {
    await offer(host); fire(); await nextTurn();
    assert.equal(host.s.last('quality')!.participants[0]!.uplinkLossPercent, 8);
  };
  return { h, host, audience, calls, setStats, pendingStats, timers, fire, offer, stop, speaker, seed };
}

it('does not invent a quality cycle for a room that has never published', async t => {
  const f = await setup(t); await f.offer(f.host, RECVONLY_OFFER);
  assert.equal(f.timers().length, 0); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.host.s.all('quality'), []); assert.deepEqual(f.audience.s.all('quality'), []);
});

for (const action of ['recvonly', 'onPeerClosed'] as const) {
  for (const seeded of [false, true]) {
    it(`sends one empty full set at the existing cycle after ${action}${seeded ? ' following a prior report' : ' before the first sample'}`, async t => {
      const f = await setup(t);
      if (seeded) await f.seed(); else await f.offer(f.host);
      const onstage = await f.speaker(false);
      const before = f.host.s.all('quality').length, timerCount = f.h.timers.length, statsCount = f.calls.length;
      await f.stop(f.host, action);
      assert.equal(f.host.s.last('room:state')!.me.onStage, true, 'publisher loss need not remove the stage seat');
      assert.equal(f.host.s.all('quality').length, before, 'unpublish is not a synchronous quality event boundary');
      assert.equal(f.timers().length, 1, 'the existing timer remains scheduled');
      f.fire(); await nextTurn();
      assert.deepEqual(f.host.s.all('quality').slice(before), [EMPTY]);
      assert.deepEqual(onstage.s.all('quality'), [EMPTY]);
      assert.deepEqual(f.audience.s.all('quality'), []);
      assert.equal(f.calls.length, statsCount, 'zero-publisher cycle reads no stats');
      assert.equal(f.h.timers.length, timerCount, 'terminal cycle allocates no timer');
      assert.equal(f.timers().length, 0);
      await f.stop(f.host, action); await nextTurn();
      assert.deepEqual(f.host.s.all('quality').slice(before), [EMPTY], 'repeated unpublish sends no extra empty report');
      assert.equal(f.timers().length, 0);
    });
  }

  for (const outcome of ['success', 'null', 'rejection'] as const) {
    it(`sends one empty full set after in-flight ${outcome} settles following ${action}`, async t => {
      const f = await setup(t); await f.seed();
      const before = f.host.s.all('quality').length, pending = f.pendingStats();
      f.setStats(() => pending.promise); f.fire(); await nextTurn();
      const statsCount = f.calls.length, timerCount = f.h.timers.length;
      await f.stop(f.host, action);
      assert.equal(f.timers().length, 0); assert.equal(f.host.s.all('quality').length, before);
      // Advancing time alone must not claim a reset while the original stats call remains pending.
      f.h.clock.now += 60_000; await nextTurn();
      assert.equal(f.host.s.all('quality').length, before); assert.equal(f.timers().length, 0);
      if (outcome === 'rejection') pending.reject(new Error('retired stats'));
      else pending.resolve(outcome === 'null' ? null : { inbound: { packetsReceived: 1000, packetsLost: 500 } });
      await nextTurn();
      assert.deepEqual(f.host.s.all('quality').slice(before), [EMPTY]);
      assert.deepEqual(f.audience.s.all('quality'), []);
      assert.equal(f.calls.length, statsCount); assert.equal(f.h.timers.length, timerCount);
      assert.equal(f.timers().length, 0);
    });
  }
}

it('waits for every sampled publisher to settle before forming the empty full set', async t => {
  const f = await setup(t); await f.seed(); const second = await f.speaker();
  const firstStats = f.pendingStats(), secondStats = f.pendingStats();
  f.setStats((_room, id) => id === f.host.id ? firstStats.promise : secondStats.promise);
  f.host.s.clear(); f.fire(); await nextTurn();
  await f.stop(f.host, 'recvonly'); await f.stop(second, 'onPeerClosed');
  firstStats.resolve({ rttMs: 500 }); await nextTurn();
  assert.deepEqual(f.host.s.all('quality'), []); assert.equal(f.timers().length, 0);
  secondStats.reject(new Error('last retired sample')); await nextTurn();
  assert.deepEqual(f.host.s.all('quality'), [EMPTY]); assert.deepEqual(second.s.all('quality'), [EMPTY]);
  assert.equal(f.timers().length, 0);
});

for (const replacement of ['same participant', 'different participant'] as const) {
  it(`does not clear or report retired counters when a ${replacement} publishes during await`, async t => {
    const f = await setup(t); await f.seed();
    const before = f.host.s.all('quality').length, pending = f.pendingStats();
    f.setStats(() => pending.promise); f.fire(); await nextTurn(); await f.stop(f.host, 'recvonly');
    const current = replacement === 'same participant' ? f.host : await f.speaker(false);
    await f.offer(current);
    assert.equal(f.timers().length, 0, 'new generation shares the in-flight cycle guard');
    pending.resolve({ inbound: { packetsReceived: 1000, packetsLost: 500 } }); await nextTurn();
    assert.equal(f.host.s.all('quality').length, before, 'neither retired data nor an empty clear belongs to this generation');
    assert.equal(f.timers().length, 1);
    f.setStats(async () => ({ inbound: { packetsReceived: 99, packetsLost: 1 }, rttMs: 12 }));
    f.fire(); await nextTurn();
    assert.deepEqual(f.host.s.last('quality')!.participants, [{ participantId: current.id, uplinkLossPercent: 1, rttMs: 12 }]);
    assert.equal(f.timers().length, 1);
  });
}

for (const outcome of ['throw', 'reject', 'null', 'mixed rejection and null'] as const) {
  it(`preserves no-event retry semantics for ${outcome} while publishers still exist`, async t => {
    const f = await setup(t); await f.seed(); const second = await f.speaker();
    const before = f.host.s.all('quality').length;
    f.setStats((_room, id) => {
      if (outcome === 'throw') throw new Error('sync stats failure');
      if (outcome === 'reject' || (outcome === 'mixed rejection and null' && id === f.host.id)) return Promise.reject(new Error('async stats failure'));
      return Promise.resolve(null);
    });
    f.fire(); await nextTurn();
    assert.equal(f.host.s.all('quality').length, before); assert.deepEqual(second.s.all('quality'), []);
    assert.deepEqual(f.audience.s.all('quality'), []); assert.equal(f.timers().length, 1);
    assert.equal(f.h.transport.rooms.get(f.host.roomId)!.publishers.size, 2);
  });
}

it('uses current controller and stage eligibility after await, excluding the old controller and ordinary audience', async t => {
  const f = await setup(t), second = await f.speaker();
  assert.equal(await f.h.req(f.host.s, { type: 'stage:leave' }), 'ok');
  const bystander = await f.h.join(f.host.roomId, f.host.code, 'Bystander');
  f.fire(); await nextTurn(); const pending = f.pendingStats();
  f.setStats(() => pending.promise); f.fire(); await nextTurn();
  await f.stop(second, 'recvonly');
  assert.equal(await f.h.req(f.host.s, { type: 'control:transfer', targetId: f.audience.id }), 'ok');
  for (const person of [f.host, second, f.audience, bystander]) person.s.clear();
  pending.resolve({ rttMs: 500 }); await nextTurn();
  assert.deepEqual(f.host.s.all('quality'), []); assert.deepEqual(bystander.s.all('quality'), []);
  assert.deepEqual(second.s.all('quality'), [EMPTY]); assert.deepEqual(f.audience.s.all('quality'), [EMPTY]);
  assert.equal(f.timers().length, 0);
});

it('delivers the in-flight empty report only to the current resumed session, not its detached predecessor', async t => {
  const f = await setup(t); await f.seed();
  const resumeToken = f.host.s.last('room:state')!.resumeToken!, pending = f.pendingStats();
  f.setStats(() => pending.promise); f.fire(); await nextTurn();
  await f.stop(f.host, 'onPeerClosed'); await f.h.hub.detach(f.host.s);
  const current = new FakeSession(); f.h.hub.attach(current);
  assert.equal(await f.h.req(current, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Resumed', resumeToken }), 'ok');
  assert.equal(current.last('room:state')!.me.participantId, f.host.id);
  f.host.s.clear(); current.clear();
  pending.resolve({ rttMs: 900 }); await nextTurn();
  assert.deepEqual(f.host.s.all('quality'), []); assert.deepEqual(current.all('quality'), [EMPTY]);
  assert.deepEqual(f.audience.s.all('quality'), []); assert.equal(f.timers().length, 0);
});

for (const closeOldRoom of [false, true]) {
  it(`does not clear a new room when the same session is reused and the old room ${closeOldRoom ? 'has closed' : 'remains open'}`, async t => {
    const f = await setup(t); await f.seed(); const observer = await f.speaker(false);
    const pending = f.pendingStats(); f.setStats(() => pending.promise); f.fire(); await nextTurn();
    await f.stop(f.host, 'recvonly');
    if (closeOldRoom) assert.equal(await f.h.req(f.host.s, { type: 'room:close' }), 'ok');
    else await f.h.hub.detach(f.host.s);
    assert.equal(await f.h.req(f.host.s, { type: 'room:create', name: 'Reused', codeRequired: false }), 'ok');
    const newRoom = f.host.s.last('room:created')!.roomId, newId = f.host.s.last('room:state')!.me.participantId;
    assert.notEqual(newRoom, f.host.roomId); await f.offer(f.host);
    f.setStats(async () => ({ rttMs: 15 })); f.host.s.clear(); observer.s.clear(); f.fire(); await nextTurn();
    const fresh = { type: 'quality', participants: [{ participantId: newId, rttMs: 15 }] };
    assert.deepEqual(f.host.s.all('quality'), [fresh]);
    pending.resolve({ rttMs: 900 }); await nextTurn();
    assert.deepEqual(f.host.s.all('quality'), [fresh], 'old completion cannot address the reused session in its new room');
    assert.deepEqual(observer.s.all('quality'), closeOldRoom ? [] : [EMPTY]);
    assert.equal(f.h.hub.roomCount, closeOldRoom ? 1 : 2); assert.equal(f.timers().length, 1);
  });
}

for (const close of ['room:close', 'shutdown'] as const) {
  for (const inFlight of [false, true]) {
    it(`suppresses terminal quality on ${close} with a ${inFlight ? 'pending collection' : 'queued cycle'}`, async t => {
      const f = await setup(t); await f.seed(); const pending = f.pendingStats();
      if (inFlight) { f.setStats(() => pending.promise); f.fire(); await nextTurn(); }
      await f.stop(f.host, 'recvonly'); f.host.s.clear();
      if (close === 'room:close') assert.equal(await f.h.req(f.host.s, { type: close }), 'ok');
      else await f.h.hub.shutdown();
      assert.equal(f.timers().length, 0);
      pending.resolve({ rttMs: 999 }); await nextTurn();
      assert.deepEqual(f.host.s.all('quality'), []); assert.deepEqual(f.audience.s.all('quality'), []);
      assert.equal(f.timers().length, 0); assert.equal(f.h.hub.roomCount, 0);
    });
  }
}

it('restarts exactly one cycle with a fresh counter baseline after the terminal empty set', async t => {
  const f = await setup(t); await f.seed(); await f.stop(f.host, 'recvonly'); f.fire(); await nextTurn();
  assert.deepEqual(f.host.s.last('quality'), EMPTY); assert.equal(f.timers().length, 0);
  await f.offer(f.host); await f.offer(f.host); assert.equal(f.timers().length, 1);
  f.setStats(async () => ({ inbound: { packetsReceived: 49, packetsLost: 1 } }));
  f.fire(); await nextTurn();
  assert.deepEqual(f.host.s.last('quality')!.participants, [{ participantId: f.host.id, uplinkLossPercent: 2 }]);
  assert.equal(f.timers().length, 1);
});

it('quality interval zero never schedules stats or empty reports across publish and stop', async t => {
  const f = await setup(t, true); await f.offer(f.host); await f.stop(f.host, 'recvonly');
  await f.offer(f.host); await f.stop(f.host, 'onPeerClosed'); await nextTurn();
  assert.equal(f.timers().length, 0); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.host.s.all('quality'), []); assert.deepEqual(f.audience.s.all('quality'), []);
});

it('preserves stage leave event/state/status/ACK order before the existing terminal cycle', async t => {
  const f = await setup(t); await f.seed(); f.host.s.clear();
  assert.equal(await f.h.req(f.host.s, { type: 'stage:leave' }), 'ok');
  const prefix = ['stage:left', 'room:state', 'status', 'ok'];
  assert.deepEqual(f.host.s.inbox.map(message => message.type), prefix);
  f.fire(); await nextTurn();
  assert.deepEqual(f.host.s.inbox.map(message => message.type), [...prefix, 'quality']);
  assert.deepEqual(f.host.s.last('quality'), EMPTY); assert.equal(f.timers().length, 0);
});

it('real SDK and existing full sample consume the Hub empty frame and clear stale rows/warnings under controlled DOM and media', async t => {
  const f = await setup(t), second = await f.speaker();
  assert.equal(await f.h.req(f.host.s, { type: 'stage:leave' }), 'ok');
  f.fire(); await nextTurn();
  let cleanup = async (): Promise<void> => {}; t.after(() => cleanup());
  const boundary = await actualApp(t, { deferCapture: true, search: `?room=${f.host.roomId}` });
  boundary.form.submit(); await flushSample(); const sdk = boundary.clients[0]!;
  const app = sampleApp({ sdk, decodeName }); cleanup = () => app.cleanup();
  const socket = StageSocket.instances[0]!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await boundary.until(() => socket.sent.some(message => message.type === 'join'), 'public SDK join request');
  const request = socket.sent.find(message => message.type === 'join')!;
  socket.deliver(f.host.s.last('room:state')!); socket.deliver({ type: 'ok', requestId: request.requestId });
  const peer = StagePeer.instances[0]!;
  await boundary.until(() => peer.localDescription !== null && peer.signalingState === 'stable', 'initial listening negotiation');
  const list = app.find(node => node.classList.contains('stage-quality-list'));
  const status = app.find(node => node.classList.contains('stage-quality-status'));
  const warnings = () => app.app.descendants().filter(node => node.classList.contains('badge') && node.classList.contains('quality'));
  const requests = [...socket.sent], offers = [...peer.offers], peers = [...StagePeer.instances];
  const statsPoll = t.mock.method(sdk as typeof sdk & { getStats(): Promise<unknown> }, 'getStats');
  const jobs = [...app.clock.jobs.values()].map(job => ({ ...job }));
  const callbacks: unknown[] = []; sdk.on('quality', ({ detail }) => callbacks.push(detail));
  app.id('stage-quality').setAttribute('open', ''); socket.deliver(f.host.s.last('quality')!);
  assert.deepEqual(list.children.map(row => row.dataset.participantId), [second.id]);
  assert.equal(warnings().length, 1); const retired = list.children[0]!;
  await f.stop(second, 'recvonly');
  assert.equal(list.children.length, 1, 'unchanged stage seat still has its historical row until the next report');
  const statsCount = f.calls.length; f.fire(); await nextTurn();
  const empty = f.host.s.last('quality')!; assert.deepEqual(empty, EMPTY); socket.deliver(empty); await flushSample();
  assert.deepEqual(callbacks, [{ participants: [{ participantId: second.id, uplinkLossPercent: 8, downlinkLossPercent: 2, rttMs: 37 }] }, { participants: [] }]);
  assert.equal(list.children.length, 0); assert.equal(retired.isConnected, false); assert.equal(warnings().length, 0);
  assert.equal(status.textContent, '尚未收到目前發言者的品質回報。');
  assert.equal(app.id('stage-quality').hidden, false); assert.equal(app.id('stage-quality').attributes.open, '');
  assert.deepEqual(socket.sent, requests); assert.deepEqual(peer.offers, offers); assert.deepEqual(StagePeer.instances, peers);
  assert.deepEqual([...app.clock.jobs.values()], jobs, 'empty handling adds no UI timer');
  assert.equal(boundary.captures.length, 0); assert.equal(peer.transceiver.direction, 'recvonly');
  assert.equal(statsPoll.mock.callCount(), 0, 'quality frames do not start SDK stats reads');
  assert.equal(f.calls.length, statsCount); assert.equal(f.timers().length, 0);
});
