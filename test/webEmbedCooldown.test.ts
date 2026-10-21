import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Deferred, embedApp, flush } from './fixtures/embedApp.ts';
import type { EmbedSdk } from './fixtures/embedApp.ts';

type App = ReturnType<typeof embedApp>;
function timer(h: App) {
  assert.equal(h.clock.timers.length, 1, 'a visible countdown owns exactly one timer');
  const active = h.clock.timers[0]!; assert.equal(active.kind, 'timeout'); return active;
}
function label(h: App, seconds: number, pending = false): void {
  assert.equal(h.hand.textContent, seconds ? `舉手發言（${seconds} 秒）` : '舉手發言');
  assert.equal(h.hand.attributes['aria-busy'], String(pending));
  assert.equal(h.hand.disabled, seconds > 0 || pending);
}
function cooldown(sdk: EmbedSdk, ms: number): void { sdk.handCooldownMs = ms; sdk.snapshot(); }
function noWrites(h: App): void {
  assert.deepEqual(h.hand.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
}

it('whole embed idle listener avoids all 40 baseline callbacks and 120 unchanged writes over 10 seconds', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); await h.join();
  h.clock.resetMetrics(); h.hand.resetWrites(); h.tick(10000);
  assert.equal(h.clock.metrics.callbacks, 0); assert.equal(h.clock.metrics.timeoutScheduled, 0);
  assert.equal(h.clock.timers.length, 0); noWrites(h); label(h, 0);
});

it('whole embed countdown wakes at visible second boundaries and stops permanently on expiry', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  cooldown(sdk, 2500); label(h, 3); assert.equal(timer(h).ms, 500);
  h.tick(499); label(h, 3); assert.equal(sdk.handCooldownMs, 2001);
  h.tick(1); label(h, 2); assert.equal(timer(h).ms, 1000);
  h.tick(999); label(h, 2); h.tick(1); label(h, 1); assert.equal(timer(h).ms, 1000);
  h.tick(999); label(h, 1); h.tick(1); label(h, 0); assert.equal(h.clock.timers.length, 0);
  assert.equal(h.clock.metrics.callbacks, 3);
  h.clock.resetMetrics(); h.hand.resetWrites(); h.tick(10000);
  assert.equal(h.clock.metrics.callbacks, 0); noWrites(h);
});

for (const ms of [0.25, 1000.25, 2500.25]) {
  it(`whole embed fractional ${ms} ms cooldown rounds its wake upward without early enable or a zero-delay loop`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
    cooldown(sdk, ms); const firstDelay = Math.ceil(ms % 1000);
    assert.equal(timer(h).ms, firstDelay); label(h, Math.ceil(ms / 1000));
    h.tick(firstDelay - 0.5); assert.equal(h.clock.metrics.callbacks, 0);
    assert.equal(sdk.handCooldownMs, Math.max(0, ms - firstDelay + 0.5));
    h.tick(0.5); label(h, Math.ceil(Math.max(0, ms - firstDelay) / 1000));
    h.tick(2500); label(h, 0); assert.equal(h.clock.timers.length, 0);
    assert.equal(h.clock.metrics.callbacks, Math.ceil(ms / 1000));
  });
}

it('whole embed delayed wake reads elapsed SDK cooldown instead of replaying missed seconds', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  cooldown(sdk, 5500.75); assert.equal(timer(h).ms, 501);
  h.clock.elapse(3750.5); assert.equal(sdk.handCooldownMs, 1750.25);
  h.clock.runDue(); label(h, 2); assert.equal(h.clock.metrics.callbacks, 1);
  assert.equal(timer(h).ms, 751); assert.equal(timer(h).due, 4501.5);
  h.clock.elapse(2500); assert.equal(sdk.handCooldownMs, 0);
  h.clock.runDue(); label(h, 0); assert.equal(h.clock.metrics.callbacks, 2);
  assert.equal(h.clock.timers.length, 0);
});

it('whole embed repeated state snapshots preserve the owned timer and its original due time', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  cooldown(sdk, 2500); const first = timer(h); h.tick(250);
  for (let i = 0; i < 20; i++) sdk.snapshot();
  assert.deepEqual(timer(h), first); assert.equal(h.clock.metrics.timeoutScheduled, 1);
  assert.equal(h.clock.metrics.timeoutCleared, 0);
  h.tick(249); label(h, 3); h.tick(1); label(h, 2);
  assert.notEqual(timer(h).id, first.id); assert.equal(h.clock.metrics.callbacks, 1);
});

it('whole embed an earlier retimed cooldown replaces its timer and ignores that replaced callback', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  cooldown(sdk, 2000); const previous = timer(h); assert.equal(previous.due, 1000);
  h.tick(100); cooldown(sdk, 1100); const replacement = timer(h);
  assert.notEqual(replacement.id, previous.id); assert.equal(replacement.due, 200);
  assert.equal(h.clock.metrics.timeoutCleared, 1); h.hand.resetWrites();
  h.clock.fireRetired(previous.id); assert.deepEqual(timer(h), replacement); noWrites(h);
  h.tick(99); label(h, 2); h.tick(1); label(h, 1);
  h.tick(999); label(h, 1); h.tick(1); label(h, 0);
  assert.equal(h.clock.timers.length, 0);
});

it('whole embed a later retimed cooldown keeps one earlier wake and follows the extended expiry', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  cooldown(sdk, 1100); const previous = timer(h); assert.equal(previous.due, 100);
  h.tick(50); cooldown(sdk, 1950); assert.deepEqual(timer(h), previous);
  assert.equal(h.clock.metrics.timeoutCleared, 0);
  h.tick(50); label(h, 2); assert.equal(timer(h).due, 1000);
  h.tick(900); label(h, 1); assert.equal(timer(h).due, 2000);
  h.tick(100); label(h, 1); assert.equal(sdk.handCooldownMs, 900);
  h.tick(900); label(h, 0); assert.equal(h.clock.timers.length, 0);
  assert.equal(h.clock.metrics.callbacks, 3, 'extension permits only the already-owned earlier wake');
});

it('whole embed arms a raise cooldown before ACK and expiry never releases its pending action lock', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  h.hand.click(); assert.equal(sdk.actions.length, 1); label(h, 2, true);
  assert.equal(timer(h).ms, 500); h.tick(500); label(h, 1, true);
  h.hand.invoke(); assert.equal(sdk.actions.length, 1);
  h.tick(1000); label(h, 0, true); assert.equal(h.clock.timers.length, 0);
  h.hand.invoke(); assert.equal(sdk.actions.length, 1);
  sdk.actions[0]!.work.resolve(); await flush(); label(h, 0);
});

it('whole embed state-before-withdrawal-ACK shows cooldown but expiry keeps the withdrawal locked', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
  sdk.handCooldownMs = 2500; h.hand.click();
  assert.equal(sdk.actions[0]!.type, 'withdraw'); assert.equal(h.clock.timers.length, 0);
  sdk.snapshot({ handRaised: false }); label(h, 3, true); assert.equal(timer(h).ms, 500);
  h.tick(2500); label(h, 0, true); assert.equal(h.clock.timers.length, 0);
  h.hand.invoke(); assert.equal(sdk.actions.length, 1);
  sdk.actions[0]!.work.resolve(); await flush(); label(h, 0);
});

for (const policy of ['onStage', 'handRaised'] as const) {
  it(`whole embed ${policy} cancels a hidden countdown and resumes only when it becomes visible`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
    cooldown(sdk, 3500); const old = timer(h).id;
    sdk.snapshot({ [policy]: true }); assert.equal(h.clock.timers.length, 0);
    assert.equal(h.hand.disabled, policy === 'onStage');
    assert.equal(h.hand.textContent, policy === 'handRaised' ? '收回舉手' : '舉手發言');
    h.hand.resetWrites(); h.tick(1000); h.clock.fireRetired(old); noWrites(h);
    sdk.snapshot({ [policy]: false }); label(h, 3); assert.equal(timer(h).ms, 500);
    h.tick(2500); label(h, 0); assert.equal(h.clock.timers.length, 0);
  });
}

it('whole embed reconnect keeps its visible countdown disabled and status-only recovery restores availability', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  cooldown(sdk, 1500); const first = timer(h);
  sdk.setStatus('reconnecting'); assert.deepEqual(timer(h), first);
  h.tick(1500); assert.equal(h.hand.textContent, '舉手發言'); assert.equal(h.hand.disabled, true);
  assert.equal(h.clock.timers.length, 0); h.hand.invoke(); assert.equal(sdk.actions.length, 0);
  sdk.setStatus('waiting'); label(h, 0); assert.equal(h.clock.timers.length, 0);
});

for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const) {
  it(`whole embed ${terminal} cancels countdown work and rejects a retired timer callback`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
    cooldown(sdk, 2500); const old = timer(h).id;
    if (terminal === 'leave') h.leave.click();
    else {
      // Terminal SDK notifications are delivered after its room and media state are cleared.
      sdk.me = null; sdk.handCooldownMs = 0;
      if (terminal === 'disconnected') sdk.setStatus('disconnected');
      else sdk.emit(terminal, { roomId: 'same-room' });
    }
    await flush(); assert.equal(h.clock.timers.length, 0); assert.equal(h.hand.disabled, true);
    const notice = h.status.textContent; h.hand.resetWrites(); h.clock.resetMetrics();
    h.tick(10000); assert.equal(h.clock.metrics.callbacks, 0);
    h.clock.fireRetired(old); noWrites(h); assert.equal(h.status.textContent, notice);
    assert.equal(h.clock.timers.length, 0);
  });
}

for (const transition of ['join', 'leave'] as const) {
  it(`whole embed ${transition} retires its timer before asynchronous disconnect settles`, async t => {
    const h = embedApp(), disconnected = new Deferred();
    t.after(async () => { if (!disconnected.settled) disconnected.resolve(); await h.cleanup(); });
    const sdk = await h.join(); cooldown(sdk, 2500); const old = timer(h).id;
    const disconnect = sdk.disconnect.bind(sdk);
    sdk.disconnect = async () => { await disconnected.promise; await disconnect(); };
    if (transition === 'join') h.form.submit(); else h.leave.click();
    assert.equal(h.clock.timers.length, 0); h.hand.resetWrites(); h.clock.fireRetired(old); noWrites(h);
    disconnected.resolve(); await flush(); assert.equal(h.clock.timers.length, 0);
    assert.equal(h.clients.length, transition === 'join' ? 2 : 1);
  });
}

it('whole embed retired callbacks cannot clear or duplicate a replacement client countdown', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join();
  cooldown(old, 2500); const retired = timer(h).id;
  h.leave.click(); await flush(); const current = await h.join();
  cooldown(current, 4500); const active = timer(h); h.hand.resetWrites();
  const before = h.clock.metrics; h.clock.fireRetired(retired);
  assert.deepEqual(timer(h), active); noWrites(h);
  assert.equal(h.clock.metrics.timeoutScheduled, before.timeoutScheduled);
  assert.equal(h.clock.metrics.timeoutCleared, before.timeoutCleared);
  old.snapshot({ handRaised: true }); old.setStatus('disconnected');
  old.emit('closed', { roomId: 'same-room' }); old.emit('kicked', { roomId: 'same-room' });
  assert.deepEqual(timer(h), active); noWrites(h);
  h.tick(500); label(h, 4); assert.equal(h.clock.timers.length, 1);
});

it('whole embed an already-fired callback cannot clear the next boundary timer', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  cooldown(sdk, 2500); const first = timer(h).id;
  h.tick(500); const next = timer(h); h.hand.resetWrites();
  h.clock.fireRetired(first); assert.deepEqual(timer(h), next); noWrites(h);
  h.tick(1000); label(h, 1); assert.equal(h.clock.timers.length, 1);
});
