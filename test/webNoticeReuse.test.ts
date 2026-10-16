import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

const failure = { name: 'NotAllowedError', message: '麥克風權限遭拒。' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function setup(t: TestContext, onStage = true) {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
  const state = roomState(onStage ? { role: 'speaker', onStage: true } : {});
  const plays: Deferred<void>[] = [];
  let retries = 0, admission: () => boolean = () => true;
  Object.assign(h.sdk, {
    unlockAudio() { const work = new Deferred<void>(); plays.push(work); return work.promise; },
    retryMicrophone() { retries++; return admission(); },
  });
  h.sdk.snapshot(clone(state));
  const notices = h.find(node => node.classList.contains('notices'));
  let replacements = 0;
  const replace = notices.replaceChildren.bind(notices);
  notices.replaceChildren = (...nodes) => { replacements++; replace(...nodes); };
  return { ...h, state, notices, plays, retries: () => retries,
    setAdmission(action: () => boolean) { admission = action; },
    replacements: () => replacements,
    reset() { replacements = 0; },
    snapshot() { h.sdk.snapshot(clone(state)); },
    error: () => h.find(node => node.attributes.role === 'alert'),
  };
}
function identities(actual: SampleNode[], expected: SampleNode[]) {
  assert.equal(actual.length, expected.length);
  for (const [i, node] of actual.entries()) assert.equal(node, expected[i]);
}

it('whole sample notice reuse: fresh identical and unrelated changed snapshots retain notices and live handlers', async t => {
  const h = await setup(t); h.sdk.emit('audioblocked', undefined); h.sdk.emit('micerror', failure);
  const old = [...h.notices.children], unlock = h.button('點擊啟用音訊'), retry = h.id('mic-retry');
  h.sdk.emit('error', { message: 'Do not clear' }); const timers = [...h.clock.jobs.keys()]; h.reset();
  for (let i = 0; i < 100; i++) {
    const state = clone(h.state); state.name = `room-${i}`; state.me.name = `person-${i}`;
    // Same stage eligibility through speaker/controller transitions does not retire notice actions.
    state.me.role = i % 2 ? 'controller' : 'speaker'; state.me.muted = Boolean(i % 2);
    state.me.forceMuted = Boolean(i % 2); state.audienceCount = i;
    h.sdk.snapshot(state); identities(h.notices.children, old);
  }
  assert.equal(h.replacements(), 0); assert.equal(h.error().textContent, 'Do not clear'); assert.equal(h.error().hidden, false);
  // Meter timer legitimately follows muted, so only the room-stats timer must persist.
  assert.ok([...h.clock.jobs.keys()].some(id => timers.includes(id) && h.clock.jobs.get(id)!.delay === 2000));
  retry.onclick!(); assert.equal(h.retries(), 1); assert.equal(retry.isConnected, false);
  unlock.onclick!(); assert.equal(h.plays.length, 0, 'direct retry redraw retired previous unlock handler');
  h.button('點擊啟用音訊').onclick!(); assert.equal(h.plays.length, 1);
  h.plays[0]!.resolve(undefined); await flushSample(); assert.doesNotMatch(h.notices.textContent, /自動播放/);
});

for (const event of ['audioblocked', 'micerror', 'invite', 'stageleft', 'micready'] as const) {
  it(`whole sample notice reuse: repeated direct ${event} rebuilds despite equivalent presentation`, async t => {
    const h = await setup(t); h.sdk.emit('audioblocked', undefined);
    const fire = () => {
      if (event === 'audioblocked' || event === 'micready') h.sdk.emit(event, undefined);
      else if (event === 'micerror') h.sdk.emit(event, failure);
      else if (event === 'invite') h.sdk.emit(event, { participantId: h.state.me.participantId });
      else h.sdk.emit(event, { participantId: h.state.me.participantId, reason: 'removed' });
    };
    fire(); h.reset(); const previous = h.button('點擊啟用音訊'); fire();
    assert.equal(h.replacements(), 1); assert.equal(previous.isConnected, false);
    previous.onclick!(); assert.equal(h.plays.length, 0);
    const current = h.button('點擊啟用音訊'); h.snapshot(); assert.equal(h.button('點擊啟用音訊'), current);
  });
}

for (const failureAt of ['clear-before', 'clear-after', 'append-before', 'append-after-first', 'append-after-second'] as const) {
  it(`whole sample notice reuse: failed forced redraw at ${failureAt} cannot leave a falsely committed matching key`, async t => {
    const h = await setup(t); h.sdk.emit('audioblocked', undefined); h.sdk.emit('micerror', failure);
    h.sdk.emit('invite', { participantId: h.state.me.participantId });
    const expected = h.notices.textContent;
    const old = [...h.notices.children];
    const clear = h.notices.replaceChildren.bind(h.notices), append = h.notices.append.bind(h.notices);
    let appended = 0;
    if (failureAt.startsWith('clear')) h.notices.replaceChildren = (...nodes) => {
      if (failureAt === 'clear-after') clear(...nodes);
      throw new Error('controlled notice failure');
    };
    else h.notices.append = (...nodes) => {
      appended++;
      if (failureAt === 'append-before') throw new Error('controlled notice failure');
      append(...nodes);
      if (appended === (failureAt === 'append-after-first' ? 1 : 2)) throw new Error('controlled notice failure');
    };
    assert.throws(() => h.sdk.emit('audioblocked', undefined), /controlled notice failure/);
    h.notices.replaceChildren = clear; h.notices.append = append;
    h.reset(); h.snapshot();
    assert.equal(h.replacements(), 1, 'snapshot retries failed DOM work even with equal semantic data');
    assert.equal(h.notices.textContent, expected); assert.equal(h.notices.children.length, 3);
    assert.equal(old.every(node => !node.isConnected), true);
    const recovered = [...h.notices.children]; h.snapshot(); identities(h.notices.children, recovered);
    assert.equal(h.replacements(), 1);
  });
}

it('whole sample notice reuse: SDK status controls notice eligibility even if payload status is unchanged', async t => {
  const h = await setup(t); h.sdk.emit('micerror', failure); const eligible = h.id('mic-retry');
  h.sdk.setStatus('reconnecting'); assert.equal(eligible.disabled, true);
  eligible.onclick!(); assert.equal(h.retries(), 0); h.reset();
  h.sdk.emit('state', clone(h.state)); assert.equal(h.replacements(), 1);
  const reconnecting = h.id('mic-retry'); assert.equal(reconnecting.disabled, true);
  h.sdk.emit('state', clone(h.state)); assert.equal(h.id('mic-retry'), reconnecting);
  h.sdk.setStatus('live'); assert.equal(reconnecting.disabled, false);
  h.sdk.emit('state', clone(h.state)); const live = h.id('mic-retry'); assert.notEqual(live, reconnecting);
  reconnecting.onclick!(); eligible.onclick!(); assert.equal(h.retries(), 0);
  live.onclick!(); assert.equal(h.retries(), 1);
});

it('whole sample notice reuse: pending audio first snapshot rebuilds once and later snapshots retain the locked node', async t => {
  const h = await setup(t, false); h.sdk.emit('audioblocked', undefined);
  const idle = h.button('點擊啟用音訊'); idle.click(); h.reset();
  for (let i = 0; i < 100; i++) h.snapshot();
  assert.equal(h.replacements(), 1); assert.equal(idle.isConnected, false);
  const pending = h.button('點擊啟用音訊'); assert.equal(pending.disabled, true); assert.equal(pending.attributes['aria-busy'], 'true');
  idle.onclick!(); pending.onclick!(); pending.click(); assert.equal(h.plays.length, 1);
  h.sdk.emit('error', { message: 'pending error' }); pending.onclick!(); assert.equal(h.error().hidden, false);
  h.plays[0]!.reject(new Error('current failure')); await flushSample();
  assert.equal(pending.isConnected, false); assert.equal(h.error().textContent, 'current failure');
  const current = h.button('點擊啟用音訊'); assert.equal(current.disabled, false); h.reset(); h.snapshot();
  assert.equal(h.button('點擊啟用音訊'), current); assert.equal(h.replacements(), 0);
});

for (const outcome of ['ready', 'error', 'false', 'throw'] as const) {
  it(`whole sample notice reuse: retained retry handler preserves synchronous ${outcome} SDK response`, async t => {
    const h = await setup(t); h.sdk.emit('micerror', failure); const retained = h.id('mic-retry');
    for (let i = 0; i < 20; i++) h.snapshot(); assert.equal(h.id('mic-retry'), retained);
    h.setAdmission(() => {
      if (outcome === 'ready') h.sdk.emit('micready', undefined);
      else if (outcome === 'error') h.sdk.emit('micerror', { name: 'NotReadableError', message: 'new failure' });
      else if (outcome === 'throw') throw new Error('boundary throw');
      return outcome !== 'false';
    });
    retained.onclick!(); assert.equal(h.retries(), 1); assert.equal(retained.isConnected, false);
    const text = h.notices.textContent, nodes = [...h.notices.children]; h.reset(); h.snapshot();
    identities(h.notices.children, nodes); assert.equal(h.replacements(), 0); assert.equal(h.notices.textContent, text);
    if (outcome === 'ready') assert.equal(text, '');
    else { assert.equal(h.id('mic-retry').disabled, false); assert.doesNotMatch(text, /等待擷取結果/); }
    if (outcome === 'error') assert.match(text, /new failure/);
    if (outcome === 'throw') assert.equal(h.error().textContent, 'boundary throw');
  });
}

for (const ownerChange of ['room', 'participant', 'same-identity-rejoin'] as const) {
  it(`whole sample notice reuse: ${ownerChange} replaces matching audio notice and isolates old pending completion`, async t => {
    const h = await setup(t, false); h.sdk.emit('audioblocked', undefined);
    const old = h.button('點擊啟用音訊'); old.click(); h.snapshot(); const oldPending = h.button('點擊啟用音訊');
    if (ownerChange === 'same-identity-rejoin') { await h.sdk.disconnect(); h.snapshot(); h.sdk.emit('audioblocked', undefined); }
    else {
      if (ownerChange === 'room') h.state.roomId = 'new-room'; else h.state.me.participantId = 'new-person';
      h.snapshot();
    }
    const current = h.button('點擊啟用音訊'); assert.equal(current.disabled, false);
    assert.equal(old.isConnected, false); assert.equal(oldPending.isConnected, false);
    old.onclick!(); oldPending.onclick!(); assert.equal(h.plays.length, 1);
    current.onclick!(); assert.equal(h.plays.length, 2); h.snapshot(); const currentPending = h.button('點擊啟用音訊');
    h.sdk.emit('error', { message: 'new owner error' });
    h.plays[0]!.reject(new Error('old owner failure')); await flushSample();
    assert.equal(h.button('點擊啟用音訊'), currentPending); assert.equal(currentPending.disabled, true);
    assert.equal(h.error().textContent, 'new owner error'); assert.equal(h.error().hidden, false);
    h.plays[1]!.resolve(undefined); await flushSample(); assert.equal(h.notices.textContent, '');
  });
}

it('whole sample notice reuse: stage removal clears pending microphone state and retained handler cannot revive it', async t => {
  const h = await setup(t); h.sdk.emit('micerror', failure); const first = h.id('mic-retry'); first.click();
  const pending = h.id('mic-retry'); h.reset(); for (let i = 0; i < 20; i++) h.snapshot();
  assert.equal(h.replacements(), 0); assert.equal(h.id('mic-retry'), pending);
  const offstage = roomState(); offstage.status = 'live'; h.sdk.snapshot(offstage);
  assert.equal(h.notices.textContent, ''); pending.onclick!(); first.onclick!(); assert.equal(h.retries(), 1);
  h.snapshot(); assert.equal(h.notices.textContent, ''); assert.equal(h.app.descendants().some(n => n.id === 'mic-retry'), false);
});

it('whole sample notice reuse: matching snapshots still synchronize the retained microphone button', async t => {
  const h = await setup(t); h.sdk.emit('micerror', failure);
  const retry = h.id('mic-retry'); h.reset();
  retry.disabled = true; retry.setAttribute('aria-busy', 'true');
  h.snapshot(); assert.equal(h.id('mic-retry'), retry); assert.equal(h.replacements(), 0);
  assert.equal(retry.disabled, false); assert.equal(retry.attributes['aria-busy'], 'false');
  retry.onclick!(); assert.equal(h.retries(), 1);
});
