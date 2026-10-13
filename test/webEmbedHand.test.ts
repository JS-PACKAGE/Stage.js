import assert from 'node:assert/strict';
import { it } from 'node:test';
import { embedApp, flush } from './fixtures/embedApp.ts';
import type { Deferred, EmbedNode, EmbedSdk } from './fixtures/embedApp.ts';

const latest = (sdk: EmbedSdk): Deferred => { const action = sdk.actions.at(-1); assert.ok(action); return action.work; };
function assertPending(hand: EmbedNode, pending: boolean): void {
  assert.equal(hand.attributes['aria-busy'], String(pending));
  if (pending) assert.equal(hand.disabled, true);
}

it('whole embed joins through the injected host library and ignores hand clicks before a snapshot', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); h.hand.invoke(); h.tick();
  assert.equal(h.hand.disabled, true); assert.equal(h.clients.length, 0);
  h.form.submit(); await flush(); const sdk = h.clients[0]!; h.hand.invoke(); h.tick();
  assert.deepEqual(h.moduleUrls, ['https://stage.example.test/lib/stage-client.js']);
  assert.equal(sdk.options.url, 'wss://stage.example.test/ws'); assert.equal(sdk.options.audioElement, h.node('audio'));
  assert.deepEqual({ ...sdk.joins[0] }, { roomId: 'same-room', code: 'TEST42', name: '測試聽眾' });
  assert.equal(sdk.actions.length, 0); assert.equal(h.hand.disabled, true);
  sdk.snapshot(); assert.equal(h.hand.disabled, false); assert.equal(h.leave.disabled, false);
});

for (const repaint of ['timer', 'state', 'handler'] as const) {
  it(`whole embed pending withdrawal survives ${repaint} reentry without a duplicate request`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
    h.hand.click(); assert.equal(sdk.actions.length, 1); assert.equal(sdk.actions[0]!.type, 'withdraw');
    if (repaint === 'timer') { h.tick(); assert.equal(h.hand.disabled, true, 'timer repaint must preserve pending'); h.hand.click(); }
    else if (repaint === 'state') { sdk.snapshot({ handRaised: true }); assert.equal(h.hand.disabled, true, 'state repaint must preserve pending'); h.hand.click(); }
    else h.hand.invoke();
    assert.equal(sdk.actions.length, 1, `${repaint} must not admit another pending withdrawal`);
    assertPending(h.hand, true); assert.equal(h.hand.textContent, '收回舉手');
    sdk.snapshot({ handRaised: false }); h.tick(); h.hand.invoke();
    assert.equal(sdk.actions.length, 1, 'state-before-ACK must not admit the opposite hand action');
    latest(sdk).resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, false);
    h.hand.click(); assert.equal(sdk.actions.length, 2); assert.equal(sdk.actions[1]!.type, 'raise');
  });
}

it('whole embed shares the pending toggle across state-before-ACK and keeps the current cooldown on settlement', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  h.hand.click(); sdk.snapshot({ handRaised: true }); h.tick(); h.hand.invoke();
  assert.equal(sdk.actions.length, 1); assertPending(h.hand, true); assert.equal(h.hand.textContent, '收回舉手');
  latest(sdk).resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, false);
  assert.ok(sdk.handCooldownMs > 0, 'cooldown must not block withdrawal of a raised hand');
  h.hand.click(); sdk.snapshot({ handRaised: false }); h.tick(); h.hand.invoke();
  assert.equal(sdk.actions.length, 2); assert.equal(sdk.actions[1]!.type, 'withdraw'); assertPending(h.hand, true);
  latest(sdk).resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, true);
  assert.equal(h.hand.textContent, '舉手發言（1 秒）');
  h.tick(1000); assert.equal(h.hand.disabled, false); assert.equal(h.hand.textContent, '舉手發言');
  h.hand.click(); assert.equal(sdk.actions.length, 3); assert.equal(sdk.actions[2]!.type, 'raise');
});

for (const failure of ['rejection', 'synchronous throw'] as const) {
  it(`whole embed releases a current ${failure} for retry without leaving a busy lock`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
    const withdraw = sdk.withdrawHand.bind(sdk); let attempts = 0;
    if (failure === 'synchronous throw') sdk.withdrawHand = () => { if (++attempts === 1) throw new Error('請重試。'); return withdraw(); };
    h.hand.click();
    if (failure === 'rejection') { assertPending(h.hand, true); latest(sdk).reject('請重試。'); }
    await flush(); assert.equal(h.status.textContent, '請重試。'); assertPending(h.hand, false); assert.equal(h.hand.disabled, false);
    const before = sdk.actions.length; h.hand.click(); assert.equal(sdk.actions.length, before + 1); assertPending(h.hand, true);
    latest(sdk).resolve(); await flush(); assertPending(h.hand, false);
  });
}

for (const policy of ['onStage', 'reconnecting', 'cooldown'] as const) {
  it(`whole embed retains ${policy} restrictions when a hand request settles and checks the handler gate`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
    h.hand.click(); sdk.snapshot({ handRaised: false });
    if (policy === 'onStage') sdk.snapshot({ onStage: true });
    else if (policy === 'reconnecting') sdk.setStatus('reconnecting');
    else sdk.handCooldownMs = 1000;
    latest(sdk).resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, true);
    h.hand.disabled = false; h.hand.invoke(); h.tick();
    assert.equal(sdk.actions.length, 1, 'direct handler invocation must recheck current policy'); assert.equal(h.hand.disabled, true);
    if (policy === 'onStage') sdk.snapshot({ onStage: false });
    else if (policy === 'reconnecting') { sdk.setStatus('waiting'); sdk.snapshot(); }
    else h.tick(750);
    assert.equal(h.hand.disabled, false); h.hand.click(); assert.equal(sdk.actions.length, 2);
  });
}

for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const) {
  it(`whole embed ${terminal} revokes pending ownership and late failure cannot replace terminal status`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
    h.hand.click(); const work = latest(sdk);
    if (terminal === 'leave') h.leave.click();
    else { await sdk.disconnect(); if (terminal !== 'disconnected') sdk.emit(terminal, { roomId: 'same-room' }); }
    await flush(); const status = h.status.textContent; h.tick(); h.hand.invoke();
    assert.equal(h.hand.disabled, true); assertPending(h.hand, false); assert.equal(sdk.actions.length, 1);
    work.reject('retired request failure'); await flush();
    assert.equal(h.status.textContent, status); assert.equal(h.hand.disabled, true); assertPending(h.hand, false);
  });
}

for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed old-client ${settlement} cannot unlock, relabel, or report into a replacement pending action`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join({ handRaised: true });
    h.hand.click(); const retired = latest(old);
    const current = await h.join({ handRaised: true }); assert.notEqual(current, old);
    h.hand.click(); const active = latest(current), status = h.status.textContent;
    if (settlement === 'resolve') retired.resolve(); else retired.reject('old failure');
    await flush(); assertPending(h.hand, true); assert.equal(h.status.textContent, status);
    assert.equal(h.hand.textContent, '收回舉手');
    old.snapshot({ onStage: true }); old.setStatus('disconnected'); old.emit('closed', { roomId: 'same-room' }); old.emit('kicked', { roomId: 'same-room' });
    h.tick(); h.hand.invoke();
    assertPending(h.hand, true); assert.equal(h.status.textContent, status); assert.equal(h.hand.textContent, '收回舉手');
    assert.equal(old.actions.length, 1); assert.equal(current.actions.length, 1);
    current.snapshot({ handRaised: false }); active.resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, false);
    h.hand.click(); assert.equal(current.actions.length, 2); assert.equal(current.actions[1]!.type, 'raise');
  });
}
