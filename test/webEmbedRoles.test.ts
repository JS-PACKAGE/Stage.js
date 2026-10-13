import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { embedApp, flush } from './fixtures/embedApp.ts';
import type { EmbedSdk } from './fixtures/embedApp.ts';
import { harness, RECVONLY_OFFER, SENDRECV_OFFER, testConfig, type Harness } from './helpers.ts';

type App = ReturnType<typeof embedApp>;
const liveTimers = (h: Harness) => h.timers.filter(timer => !timer.cleared);
function timer(h: App) {
  assert.equal(h.clock.timers.length, 1, 'a visible countdown owns exactly one timer');
  return h.clock.timers[0]!;
}
function noWrites(h: App): void {
  assert.deepEqual(h.hand.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
}
function blocked(h: App, sdk: EmbedSdk, actions = 0): void {
  assert.equal(h.hand.disabled, true);
  h.hand.click();
  h.hand.invoke();
  h.hand.disabled = false; h.hand.click();
  h.hand.disabled = false; h.hand.invoke();
  assert.equal(h.hand.disabled, true, 'the handler must recompute eligibility after DOM tampering');
  assert.equal(sdk.actions.length, actions, 'neither raiseHand nor withdrawHand may be called');
}
function applyState(sdk: EmbedSdk, state: RoomStatePayload): void {
  sdk.me = state.me; sdk.emit('state', state);
}

async function succession(t: TestContext) {
  const config = testConfig(c => {
    c.limits.maxSpeakersPerRoom = 8;
    c.rooms.controllerGraceMs = 60_000; c.rooms.participantGraceMs = 15_000;
    c.rooms.qualityIntervalMs = 0;
  });
  const h = harness(config);
  t.after(async () => {
    await h.hub.shutdown();
    assert.equal(h.hub.roomCount, 0); assert.equal(h.transport.rooms.size, 0);
    assert.equal(liveTimers(h).length, 0);
  });
  const host = await h.create();
  assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  h.clock.now++;
  const audience = await h.join(host.roomId, host.code, 'Earlier audience');
  assert.equal(await h.req(audience.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
  const speakers: Awaited<ReturnType<Harness['join']>>[] = [];
  for (let index = 0; index < 8; index++) {
    h.clock.now++;
    const person = await h.join(host.roomId, host.code, `Speaker ${index}`);
    assert.equal(await h.req(person.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: person.id }), 'ok');
    assert.equal(await h.req(person.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    speakers.push(person);
  }
  await h.hub.detach(host.s);
  const expiry = liveTimers(h).find(timer => timer.ms === config.rooms.controllerGraceMs);
  assert.ok(expiry);
  h.clock.now += config.rooms.controllerGraceMs - config.rooms.participantGraceMs / 2;
  for (const person of speakers) await h.hub.detach(person.s);
  h.clock.now += config.rooms.participantGraceMs / 2;
  const before = audience.s.last('room:state')!;
  return {
    h, audience, speakers, before,
    async promote(): Promise<RoomStatePayload> {
      expiry.cleared = true; expiry.fn(); await nextTurn();
      const state = audience.s.last('room:state'); assert.ok(state);
      assert.equal(state.controllerId, audience.id);
      assert.equal(state.me.role, 'controller'); assert.equal(state.me.onStage, false);
      assert.equal(state.me.handRaised, false); assert.equal(state.me.connected, true);
      assert.equal(state.speakers.length, 8);
      assert.deepEqual(state.speakers.map(person => person.participantId), speakers.map(person => person.id));
      assert.ok(state.speakers.every(person => person.role === 'speaker' && person.onStage && !person.connected));
      return state;
    },
  };
}

// The module is real; DOM, clock, and imported library are fakes. Only the succession
// snapshots below come from StageHub, with MockMediaTransport and no network or audio.
it('whole embed rejects hand actions for the real offstage controller successor with eight retained speakers', async t => {
  const f = await succession(t), h = embedApp(); t.after(() => h.cleanup());
  const sdk = await h.join(f.before.me); applyState(sdk, f.before);
  assert.equal(sdk.me?.role, 'audience'); assert.equal(h.hand.disabled, false);
  const state = await f.promote(); applyState(sdk, state);
  blocked(h, sdk); assert.equal(h.hand.textContent, '舉手發言');
  assert.equal(h.clock.timers.length, 0); assert.equal(h.hand.attributes['aria-busy'], 'false');
  h.clock.resetMetrics(); h.hand.resetWrites(); h.tick(10000);
  assert.equal(h.clock.metrics.callbacks, 0); noWrites(h);
  assert.equal(await f.h.req(f.audience.s, { type: 'hand:raise' }), 'conflict', 'the unchanged Hub forbids controller raises');
});

for (const onStage of [false, true]) for (const handRaised of [false, true]) {
  it(`whole embed gates controller hand actions with onStage=${onStage} and handRaised=${handRaised}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup());
    // A raised controller hand is deliberately inconsistent input for the withdrawal guard.
    const sdk = await h.join({ role: 'controller', onStage, handRaised });
    sdk.handCooldownMs = 3500; sdk.snapshot();
    blocked(h, sdk); assert.equal(h.clock.timers.length, 0);
    assert.equal(h.hand.textContent, handRaised ? '收回舉手' : '舉手發言');
    h.tick(3500); blocked(h, sdk); assert.equal(h.clock.metrics.callbacks, 0);
  });
}

it('whole embed actual controller promotion cancels its cooldown and retired callbacks cannot disturb audience recovery', async t => {
  const f = await succession(t), h = embedApp(); t.after(() => h.cleanup());
  const sdk = await h.join(f.before.me); sdk.handCooldownMs = 3500; applyState(sdk, f.before);
  const retired = timer(h); assert.equal(h.hand.textContent, '舉手發言（4 秒）');
  applyState(sdk, await f.promote());
  assert.equal(h.clock.timers.length, 0); assert.equal(h.clock.metrics.timeoutCleared, 1);
  blocked(h, sdk); assert.equal(h.hand.textContent, '舉手發言');
  h.clock.resetMetrics(); h.hand.resetWrites(); h.tick(1000);
  assert.equal(h.clock.metrics.callbacks, 0); noWrites(h);
  h.clock.fireRetired(retired.id); noWrites(h); assert.equal(h.clock.timers.length, 0);

  // Audience recovery is injected to exercise the existing UI gates independently of Hub transfer rules.
  sdk.snapshot({ role: 'audience' });
  assert.equal(h.hand.textContent, '舉手發言（3 秒）'); blocked(h, sdk);
  const active = timer(h), metrics = h.clock.metrics;
  assert.notEqual(active.id, retired.id); assert.equal(active.ms, 500);
  h.hand.resetWrites(); h.clock.fireRetired(retired.id);
  assert.deepEqual(timer(h), active); noWrites(h);
  assert.equal(h.clock.metrics.timeoutScheduled, metrics.timeoutScheduled);
  assert.equal(h.clock.metrics.timeoutCleared, metrics.timeoutCleared);
  h.tick(2500); assert.equal(h.clock.timers.length, 0); assert.equal(h.hand.disabled, false);
  h.hand.click(); assert.equal(sdk.actions.length, 1); assert.equal(sdk.actions[0]!.type, 'raise');
});

it('whole embed controller demotion preserves reconnect gating through cooldown expiry and status-only recovery', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  sdk.handCooldownMs = 1500; sdk.snapshot();
  sdk.snapshot({ role: 'controller' }); assert.equal(h.clock.timers.length, 0);
  sdk.setStatus('reconnecting'); sdk.snapshot({ role: 'audience' });
  assert.equal(h.hand.textContent, '舉手發言（2 秒）'); blocked(h, sdk);
  h.tick(1500); assert.equal(h.hand.textContent, '舉手發言');
  assert.equal(h.clock.timers.length, 0); blocked(h, sdk);
  sdk.setStatus('waiting'); assert.equal(h.hand.disabled, false);
  h.hand.click(); assert.equal(sdk.actions.length, 1); assert.equal(sdk.actions[0]!.type, 'raise');
});

for (const settlement of ['controller', 'audience'] as const) {
  it(`whole embed promotion preserves its pending action until ACK settles as ${settlement}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
    h.hand.click(); const pending = sdk.actions[0]!; assert.equal(pending.type, 'raise');
    sdk.snapshot({ role: 'controller' }); assert.equal(h.clock.timers.length, 0);
    blocked(h, sdk, 1); assert.equal(h.hand.attributes['aria-busy'], 'true');
    sdk.snapshot({ role: 'audience' }); h.tick(1500);
    assert.equal(h.clock.timers.length, 0); blocked(h, sdk, 1);
    assert.equal(h.hand.attributes['aria-busy'], 'true');
    if (settlement === 'controller') sdk.snapshot({ role: 'controller' });
    pending.work.resolve(); await flush(); assert.equal(h.hand.attributes['aria-busy'], 'false');
    if (settlement === 'controller') { blocked(h, sdk, 1); sdk.snapshot({ role: 'audience' }); }
    assert.equal(h.hand.disabled, false); h.hand.click(); assert.equal(sdk.actions.length, 2);
  });
}

it('whole embed audience withdrawal stays available and timer-free during cooldown after controller demotion', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
  sdk.handCooldownMs = 3500;
  sdk.snapshot({ role: 'audience', handRaised: true });
  assert.equal(h.hand.disabled, false); assert.equal(h.hand.textContent, '收回舉手');
  assert.equal(h.clock.timers.length, 0);
  h.hand.click(); assert.equal(sdk.actions.length, 1); assert.equal(sdk.actions[0]!.type, 'withdraw');
  assert.equal(h.hand.attributes['aria-busy'], 'true'); assert.equal(h.clock.timers.length, 0);
  h.tick(1000); blocked(h, sdk, 1); assert.equal(h.clock.metrics.callbacks, 0);
  sdk.actions[0]!.work.resolve(); await flush();
  assert.equal(h.hand.disabled, false); assert.equal(h.hand.textContent, '收回舉手');
  assert.equal(h.clock.timers.length, 0); assert.ok(sdk.handCooldownMs > 0);
  sdk.snapshot({ handRaised: false });
  assert.equal(h.hand.textContent, '舉手發言（3 秒）'); assert.equal(timer(h).ms, 500); blocked(h, sdk, 1);
});
