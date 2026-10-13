import assert from 'node:assert/strict';
import { it } from 'node:test';
import { flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
async function join(h: App): Promise<void> {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [name, value] of [['roomId', 'same-room'], ['name', '測試聽眾']]) {
    const input = form.descendants().find(node => node.name === name); assert.ok(input); input.value = value!;
  }
  form.submit(); h.sdk.acceptJoin(roomState()); await flushSample();
}
const hand = (h: App) => h.find(node => node.dataset.roomAction === 'hand');
function timer(h: App) {
  assert.equal(h.clock.timeouts().length, 1, 'the visible countdown owns exactly one timeout');
  return h.clock.jobs.get(h.clock.timeouts()[0]!)!;
}
function cooldown(h: App, remaining: number): void { h.sdk.handCooldownMs = remaining; h.sdk.snapshot(roomState()); }
function label(h: App, seconds: number, pending = false, reconnecting = false): void {
  assert.equal(hand(h).textContent, seconds ? `舉手發言（${seconds} 秒）` : '舉手發言');
  assert.equal(hand(h).attributes['aria-busy'], String(pending));
  assert.equal(hand(h).disabled, seconds > 0 || pending || reconnecting);
}

it('whole sample unchanged snapshots preserve the countdown handle and absolute due time', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  cooldown(h, 2500); const owned = timer(h); h.clock.advance(250);
  for (let i = 0; i < 20; i++) h.sdk.snapshot(roomState());
  assert.equal(timer(h), owned); assert.equal(owned.due, 500);
  h.clock.advance(249); label(h, 3); h.clock.advance(1); label(h, 2);
  assert.notEqual(timer(h).id, owned.id); assert.equal(timer(h).due, 1500);
});

it('whole sample earlier same-label retiming replaces the timer and rejects its stale callback', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  cooldown(h, 2000); const old = timer(h); assert.equal(old.due, 1000);
  h.clock.advance(100); cooldown(h, 1100); const replacement = timer(h);
  assert.notEqual(replacement.id, old.id); assert.equal(replacement.due, 200); label(h, 2);
  const button = hand(h); old.callback();
  assert.equal(timer(h), replacement); assert.equal(hand(h), button); label(h, 2);
  h.clock.advance(99); label(h, 2); h.clock.advance(1); label(h, 1);
  h.clock.advance(999); label(h, 1); h.clock.advance(1); label(h, 0);
  assert.equal(h.clock.timeouts().length, 0);
});

it('whole sample later retiming preserves one early wake and honors the extended expiry', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  cooldown(h, 1100); const old = timer(h); assert.equal(old.due, 100);
  h.clock.advance(50); cooldown(h, 1950); assert.equal(timer(h), old); label(h, 2);
  h.clock.advance(50); label(h, 2); const middle = timer(h); assert.equal(middle.due, 1000);
  h.clock.advance(900); label(h, 1); const last = timer(h); assert.equal(last.due, 2000);
  h.clock.advance(100); label(h, 1); h.clock.advance(900); label(h, 0);
  assert.equal(h.clock.timeouts().length, 0);
  assert.deepEqual(h.clock.fired.filter(id => [old.id, middle.id, last.id].includes(id)), [old.id, middle.id, last.id]);
});

for (const remaining of [0.25, 1000.25, 2500.25]) {
  it(`whole sample earlier retimed ${remaining} ms boundary rounds upward and expires without extra wakes`, async t => {
    const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
    cooldown(h, 4000); const old = timer(h); h.clock.advance(100);
    cooldown(h, remaining); const replacement = timer(h); const delay = Math.ceil(remaining % 1000);
    assert.notEqual(replacement.id, old.id); assert.equal(replacement.delay, delay);
    h.clock.advance(delay - 0.5); label(h, Math.ceil(remaining / 1000));
    assert.equal(h.clock.fired.includes(replacement.id), false);
    h.clock.advance(0.5); label(h, Math.ceil(Math.max(0, remaining - delay) / 1000));
    h.clock.advance(2500); label(h, 0); assert.equal(h.clock.timeouts().length, 0);
    assert.equal(h.clock.fired.filter(id => id !== h.clock.intervals(2000)[0]).length, Math.ceil(remaining / 1000));
  });
}

it('whole sample immediate expiry retires its timer and leaves an idle countdown unarmed', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  cooldown(h, 2500); const old = timer(h); h.clock.advance(100); cooldown(h, 0);
  label(h, 0); assert.equal(h.clock.timeouts().length, 0);
  old.callback(); label(h, 0); assert.equal(h.clock.timeouts().length, 0);
  cooldown(h, 1200); const fresh = timer(h); assert.equal(fresh.due, 300);
  old.callback(); assert.equal(timer(h), fresh);
  h.clock.advance(200); label(h, 1); h.clock.advance(1000); label(h, 0);
});

it('whole sample an already-fired callback cannot retire its next boundary timer', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  cooldown(h, 2500); const first = timer(h); h.clock.advance(500); const next = timer(h);
  first.callback(); assert.equal(timer(h), next); label(h, 2);
  h.clock.advance(1000); label(h, 1); assert.equal(timer(h).due, 2500);
});

it('whole sample retimed expiry cannot unlock a pending raise request', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  hand(h).click(); assert.equal(h.sdk.raises.length, 1); label(h, 2, true);
  const old = timer(h); h.clock.advance(100); cooldown(h, 50);
  assert.notEqual(timer(h).id, old.id); label(h, 1, true);
  h.clock.advance(49); label(h, 1, true); h.clock.advance(1); label(h, 0, true);
  assert.equal(h.clock.timeouts().length, 0); hand(h).onclick!(); assert.equal(h.sdk.raises.length, 1);
  h.sdk.raises[0]!.resolve(undefined); await flushSample(); label(h, 0);
});

it('whole sample retimed expiry preserves reconnect admission until recovery', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  cooldown(h, 2000); h.clock.advance(100); h.sdk.handCooldownMs = 50; h.sdk.setStatus('reconnecting');
  assert.equal(timer(h).due, 150); label(h, 1, false, true);
  h.clock.advance(50); label(h, 0, false, true); assert.equal(h.clock.timeouts().length, 0);
  hand(h).onclick!(); assert.equal(h.sdk.raises.length, 0);
  h.sdk.setStatus('waiting'); label(h, 0);
});

for (const terminal of ['disconnect', 'closed', 'kicked'] as const) {
  it(`whole sample ${terminal} rejects a retired callback both before and after same-seat rejoin`, async t => {
    const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
    cooldown(h, 2500); const old = timer(h);
    if (terminal === 'disconnect') await h.sdk.disconnect(); else await h.sdk.terminal(terminal);
    await flushSample(); assert.equal(h.clock.jobs.size, 0);
    const landing = [...h.app.children]; old.callback(); assert.deepEqual(h.app.children, landing);
    assert.equal(h.clock.jobs.size, 0);
    await join(h); cooldown(h, 4500); const replacement = timer(h); const button = hand(h);
    old.callback(); assert.equal(timer(h), replacement); assert.equal(hand(h), button); label(h, 5);
    h.clock.advance(500); label(h, 4);
  });
}
