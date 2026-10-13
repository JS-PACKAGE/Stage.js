import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createLogger } from '../src/log.ts';
import type { TransportStats } from '../src/transport/MediaTransport.ts';
import { harness, RECVONLY_OFFER, SENDRECV_OFFER, sine, testConfig } from './helpers.ts';

const SECRET = 'synthetic-quality-secret-must-not-appear';
type DiagnosticKind = 'Error' | 'string' | 'null-prototype' | 'hostile toString' | 'hooks' | 'revoked proxy';

function diagnostic(kind: DiagnosticKind) {
  let calls = 0;
  // If coercion runs, even the outer report catch cannot safely stringify this thrown value.
  const hook = () => { calls++; throw Object.create(null); };
  let value: unknown, expected: unknown;
  if (kind === 'Error') {
    value = new TypeError('synthetic stats failure', { cause: { token: SECRET, retryable: true } });
  } else if (kind === 'string') {
    value = expected = 'synthetic stats failure';
  } else if (kind === 'null-prototype') {
    value = Object.assign(Object.create(null) as Record<string, unknown>, { reason: 'synthetic stats failure', nested: { resumeToken: SECRET } });
    expected = { reason: 'synthetic stats failure', nested: { resumeToken: '[redacted]' } };
  } else if (kind === 'hostile toString') {
    value = { toString: hook, valueOf: hook, token: SECRET };
    expected = { toString: '[Function]', valueOf: '[Function]', token: '[redacted]' };
  } else if (kind === 'hooks') {
    value = { [Symbol.toPrimitive]: hook, toJSON: hook, get unsafe() { return hook(); }, get secret() { return hook(); } };
    expected = { toJSON: '[Function]', unsafe: '[Accessor]', secret: '[redacted]' };
  } else {
    const revoked = Proxy.revocable({}, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook });
    revoked.revoke(); value = revoked.proxy; expected = '[Proxy]';
  }
  return {
    value,
    untouched() { assert.equal(calls, 0, 'diagnostic coercion, getters, serialization and proxy traps must not run'); },
    check(error: unknown) {
      this.untouched();
      if (kind === 'Error') {
        assert.ok(error !== null && typeof error === 'object');
        const fields = error as Record<string, unknown>;
        assert.equal(fields.name, 'TypeError');
        assert.equal(fields.message, 'synthetic stats failure');
        assert.deepEqual(fields.cause, { token: '[redacted]', retryable: true });
      } else assert.deepEqual(error, expected);
    },
  };
}

async function room(t: TestContext) {
  const config = testConfig();
  const lines: string[] = [];
  const h = harness(config, createLogger('warn', line => { lines.push(line); }));
  const host = await h.create();
  t.after(async () => { if (h.hub.isJoined(host.s)) await h.req(host.s, { type: 'room:close' }); });
  assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  const speaker = async () => {
    const person = await h.join(host.roomId, host.code, 'Speaker');
    assert.equal(await h.req(person.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: person.id }), 'ok');
    assert.equal(await h.req(person.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    return person;
  };
  const second = await speaker();
  const audience = await h.join(host.roomId, host.code, 'Audience');
  assert.equal(await h.req(audience.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
  const peers = h.transport.rooms.get(host.roomId)!.peers;
  const counters = (id: string, received: number, lost: number) => { peers.get(id)!.uplink = { packetsReceived: received, packetsLost: lost }; };
  const timers = () => h.timers.filter(timer => !timer.cleared && timer.ms === config.rooms.qualityIntervalMs);
  const fire = () => {
    const pending = timers(); assert.equal(pending.length, 1, 'exactly one quality timer');
    pending[0]!.cleared = true; pending[0]!.fn();
    assert.equal(timers().length, 0, 'no timer while the collection is in flight');
  };
  const clear = () => { host.s.clear(); second.s.clear(); audience.s.clear(); };
  const quality = (participants: { participantId: string; uplinkLossPercent?: number }[]) => {
    const expected = [{ type: 'quality', participants }];
    assert.deepEqual(host.s.all('quality'), expected, 'controller gets this cycle exactly once');
    assert.deepEqual(second.s.all('quality'), expected, 'stage gets the same cycle exactly once');
    assert.deepEqual(audience.s.all('quality'), [], 'audience never receives publisher stats');
  };
  const checkLog = (sample: ReturnType<typeof diagnostic>, id: string) => {
    const logs = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(logs.length, 1, 'only the failed publisher warning, no whole-report failure');
    assert.equal(logs[0]!.level, 'warn');
    assert.equal(logs[0]!.msg, 'publisher quality stats failed');
    assert.equal(logs[0]!.roomId, host.roomId);
    assert.equal(logs[0]!.participantId, id);
    sample.check(logs[0]!.error);
    assert.doesNotMatch(lines.join('\n'), new RegExp(SECRET));
  };
  const mediaSurvives = () => {
    assert.equal(h.hub.roomCount, 1);
    assert.equal(h.transport.rooms.get(host.roomId)!.peers, peers);
    const frame = sine(config.audio.sampleRate * config.audio.frameMs / 1000, 0.2);
    assert.equal(h.transport.emitUplink(host.roomId, host.id, frame), true);
    assert.equal(h.transport.emitUplink(host.roomId, second.id, frame), true);
    assert.equal(h.transport.emitUplink(host.roomId, audience.id, frame), false);
    h.mixers.get(host.roomId)!.tick();
    for (const person of [host, second, audience]) {
      assert.ok(h.hub.isJoined(person.s));
      assert.equal(person.s.closed, undefined);
      assert.deepEqual(person.s.all('room:closed'), []);
      assert.ok(peers.get(person.id)!.received.at(-1)!.some(sample => Math.abs(sample) > 0.001), 'publisher and audience PCM continues');
    }
  };
  return { h, host, second, audience, speaker, peers, counters, timers, fire, clear, quality, checkLog, mediaSurvives, lines };
}

const cases: { kind: DiagnosticKind; synchronous: boolean; failedFirst: boolean }[] = [
  { kind: 'Error', synchronous: true, failedFirst: true },
  { kind: 'string', synchronous: false, failedFirst: false },
  ...(['null-prototype', 'hostile toString', 'hooks', 'revoked proxy'] as const).flatMap(kind => [
    { kind, synchronous: true, failedFirst: true },
    { kind, synchronous: false, failedFirst: false },
  ]),
];

for (const { kind, synchronous, failedFirst } of cases) {
  it(`isolates ${kind} stats ${synchronous ? 'throws' : 'rejections'} with the failed publisher ${failedFirst ? 'first' : 'last'}`, async t => {
    const f = await room(t), sample = diagnostic(kind);
    const failed = failedFirst ? f.host : f.second, healthy = failedFirst ? f.second : f.host;
    const original = f.h.transport.getStats.bind(f.h.transport);
    const peerObjects = new Map(f.peers);
    let reject = false; const calls: string[] = [];
    f.h.transport.getStats = (roomId, id) => {
      calls.push(id);
      if (reject && id === failed.id) {
        if (synchronous) throw sample.value;
        return Promise.reject(sample.value);
      }
      return original(roomId, id);
    };

    f.counters(healthy.id, 90, 10); f.counters(failed.id, 80, 20);
    f.clear(); f.fire(); await nextTurn();
    f.quality([f.host, f.second].map(person => ({ participantId: person.id, uplinkLossPercent: person.id === healthy.id ? 10 : 20 })));
    assert.equal(f.timers().length, 1);

    reject = true;
    f.counters(healthy.id, 170, 30); f.counters(failed.id, 140, 60);
    f.clear(); f.fire(); await nextTurn();
    f.quality([{ participantId: healthy.id, uplinkLossPercent: 20 }]);
    assert.equal(f.timers().length, 1, 'failed publisher does not stop rescheduling');
    f.checkLog(sample, failed.id);
    f.mediaSurvives();
    for (const [id, peer] of peerObjects) assert.equal(f.peers.get(id), peer, 'stats failure must not recreate peers');

    reject = false;
    f.counters(healthy.id, 260, 40); f.counters(failed.id, 230, 70);
    f.clear(); f.fire(); await nextTurn();
    f.quality([f.host, f.second].map(person => ({ participantId: person.id, uplinkLossPercent: person.id === healthy.id ? 10 : 25 })));
    assert.deepEqual(calls, Array.from({ length: 3 }, () => [f.host.id, f.second.id]).flat());
    assert.equal(f.timers().length, 1);
    f.checkLog(sample, failed.id);
  });
}

it('settles one in-flight failed collection before polling a newly arrived publisher', async t => {
  const f = await room(t), sample = diagnostic('hostile toString');
  const pending = Promise.withResolvers<TransportStats | null>();
  void pending.promise.catch(() => {});
  t.after(() => { pending.reject(sample.value); });
  const original = f.h.transport.getStats.bind(f.h.transport);
  const calls: string[] = [];
  f.h.transport.getStats = (roomId, id) => { calls.push(id); return id === f.second.id ? pending.promise : original(roomId, id); };
  f.counters(f.host.id, 90, 10);
  f.clear(); f.fire(); await nextTurn();
  const third = await f.speaker();
  assert.deepEqual(calls, [f.host.id, f.second.id]);
  assert.equal(f.timers().length, 0);
  assert.deepEqual(f.host.s.all('quality'), [], 'the current collection has not settled');
  pending.reject(sample.value); await nextTurn();
  f.quality([{ participantId: f.host.id, uplinkLossPercent: 10 }]);
  assert.deepEqual(third.s.all('quality'), f.host.s.all('quality'));
  f.checkLog(sample, f.second.id); assert.equal(f.timers().length, 1);
  f.h.transport.getStats = original;
  f.clear(); third.s.clear(); f.fire(); await nextTurn();
  f.quality([f.host, f.second, third].map(person => ({ participantId: person.id })));
  assert.deepEqual(third.s.all('quality'), f.host.s.all('quality'));
  assert.equal(f.timers().length, 1);
});

for (const action of ['republish', 'close'] as const) {
  it(`ignores a pending hostile rejection after publisher ${action}`, async t => {
    const f = await room(t), sample = diagnostic('hooks');
    const pending = Promise.withResolvers<TransportStats | null>();
    void pending.promise.catch(() => {});
    t.after(() => { pending.reject(sample.value); });
    const original = f.h.transport.getStats.bind(f.h.transport);
    f.counters(f.host.id, 90, 10); f.counters(f.second.id, 1000, 500);
    f.fire(); await nextTurn();
    f.h.transport.getStats = (roomId, id) => id === f.second.id ? pending.promise : original(roomId, id);
    f.clear(); f.fire(); await nextTurn();
    if (action === 'close') {
      assert.equal(await f.h.req(f.host.s, { type: 'room:close' }), 'ok');
    } else {
      assert.equal(await f.h.req(f.second.s, { type: 'stage:leave' }), 'ok');
      assert.equal(await f.h.req(f.second.s, { type: 'hand:raise' }), 'ok');
      assert.equal(await f.h.req(f.host.s, { type: 'stage:approve', targetId: f.second.id }), 'ok');
      assert.equal(await f.h.req(f.second.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
      f.counters(f.second.id, 90, 10);
    }
    assert.equal(f.timers().length, 0);
    pending.reject(sample.value); await nextTurn();
    sample.untouched(); assert.deepEqual(f.lines, [], 'retired generation and closed room diagnostics are ignored');
    if (action === 'close') {
      assert.deepEqual(f.host.s.all('quality'), []);
      assert.deepEqual(f.second.s.all('quality'), []);
      assert.deepEqual(f.audience.s.all('quality'), []);
      assert.equal(f.timers().length, 0);
      assert.equal(f.h.hub.roomCount, 0);
      assert.equal(f.h.transport.rooms.has(f.host.roomId), false);
    } else {
      f.quality([{ participantId: f.host.id }]);
      assert.equal(f.timers().length, 1);
      f.h.transport.getStats = original;
      f.clear(); f.fire(); await nextTurn();
      f.quality([{ participantId: f.host.id }, { participantId: f.second.id, uplinkLossPercent: 10 }]);
      assert.equal(f.timers().length, 1);
      f.mediaSurvives();
    }
  });
}
