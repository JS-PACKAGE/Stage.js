import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
const clone = <T>(value: T): T => structuredClone(value);
const actions = (h: App): SampleNode[] => h.app.descendants().filter(node => node.dataset.roomAction !== undefined);
const action = (h: App, key: string): SampleNode => h.find(node => node.dataset.roomAction === key);
const errorBox = (h: App): SampleNode => h.find(node => node.attributes.role === 'alert');

function controllerState(audienceCount = 3, speakerCount = 1, handCount = 1): RoomStatePayload {
  const me = roomState({ participantId: 'controller', role: 'controller', onStage: true }).me;
  const speakers: ParticipantView[] = [me, ...Array.from({ length: speakerCount }, (_, index) => ({
    ...me, participantId: `speaker-${index}`, role: 'speaker' as const,
  }))];
  const audience: ParticipantView[] = Array.from({ length: audienceCount }, (_, index) => ({
    ...me, participantId: `audience-${index}`, name: `Audience ${index}`, role: 'audience',
    onStage: false, handRaised: index < handCount,
  }));
  return { ...roomState(me), controllerId: me.participantId, speakers, hands: audience.slice(0, handCount), audience,
    audienceCount, status: 'live' };
}

/** Count bounded fixture operations only; this does not model browser CPU, layout, paint or memory. */
async function setup(t: TestContext) {
  const h = sampleApp({ source, confirm: () => true }); t.after(() => h.cleanup()); await flushSample();
  const main = h.find(node => node.tagName === 'main');
  const counts = { actionQueries: 0, returnQueries: 0, replacements: 0 };
  const query = main.querySelectorAll.bind(main), replace = main.replaceChildren.bind(main);
  main.querySelectorAll = selector => {
    if (selector === '[data-room-action]') counts.actionQueries++;
    if (selector === '[data-return-stage]') counts.returnQueries++;
    return query(selector);
  };
  main.replaceChildren = (...nodes) => { replace(...nodes); counts.replacements++; };
  const reset = () => { counts.actionQueries = counts.returnQueries = counts.replacements = 0; };
  return { ...h, main, counts, reset };
}

function sameNodes(actual: SampleNode[], expected: SampleNode[]): void {
  assert.equal(actual.length, expected.length);
  for (const [index, node] of actual.entries()) assert.equal(node, expected[index], `control ${index}`);
}
function watchWrites(nodes: SampleNode[]) {
  const counts = { disabled: 0, busy: 0 };
  for (const node of nodes) {
    let disabled = node.disabled;
    Object.defineProperty(node, 'disabled', { configurable: true, get: () => disabled,
      set(value: boolean) { counts.disabled++; disabled = value; } });
    const set = node.setAttribute.bind(node);
    node.setAttribute = (name, value) => { if (name === 'aria-busy') counts.busy++; set(name, value); };
  }
  return counts;
}
function watchAccess(nodes: SampleNode[]) {
  const counts = { reads: 0, writes: 0 };
  for (const node of nodes) {
    const data = node.dataset;
    Object.defineProperty(node, 'dataset', { configurable: true, get() { counts.reads++; return data; } });
    for (const name of ['disabled', 'value'] as const) {
      let value = node[name];
      Object.defineProperty(node, name, { configurable: true, get() { counts.reads++; return value; },
        set(next: typeof value) { counts.writes++; value = next; } });
    }
    for (const name of ['textContent', 'isConnected'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node) as object, name)!;
      Object.defineProperty(node, name, { configurable: true,
        get() { counts.reads++; return descriptor.get!.call(node) as unknown; },
        ...(descriptor.set ? { set(value: string) { counts.writes++; descriptor.set!.call(node, value); } } : {}),
      });
    }
    const set = node.setAttribute.bind(node);
    node.setAttribute = (name, value) => { counts.writes++; set(name, value); };
  }
  return counts;
}
function setFilter(h: App, value: string): void {
  const input = h.find(node => node.tagName === 'input' && node.type === 'search' && node.id === 'audience-search');
  input.value = value; assert.ok(input.oninput); input.oninput();
}
function audienceRows(h: App): SampleNode[] {
  const heading = h.find(node => node.tagName === 'h2' && node.textContent.startsWith('觀眾 ·'));
  return heading.parentNode!.descendants().filter(node => node.classList.contains('person'));
}
function settle(work: Deferred<void>, outcome: 'resolve' | 'reject', message = 'current failure'): void {
  if (outcome === 'resolve') work.resolve(undefined); else work.reject(new Error(message));
}

it('whole sample reuses current control references for identical 301-seat snapshots without skipping control writes', async t => {
  const h = await setup(t), state = controllerState(292, 8, 20);
  assert.equal(state.speakers.length + state.audience!.length, 301);
  h.sdk.snapshot(clone(state)); const initial = { ...h.counts };
  const nodes = actions(h), writes = watchWrites(nodes); assert.equal(nodes.length, 710); h.reset();
  for (let index = 0; index < 10; index++) h.sdk.snapshot(clone(state));
  sameNodes(actions(h), nodes);
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
  assert.deepEqual(initial, { actionQueries: 1, returnQueries: 1, replacements: 1 });
  assert.deepEqual(writes, { disabled: 7100, busy: 7100 });
  assert.ok(nodes.every(node => !node.disabled && node.attributes['aria-busy'] === 'false'));
  const work = new Deferred<void>(); let calls = 0;
  Object.assign(h.sdk, { transferControl: () => { calls++; return work.promise; } });
  const transfers = nodes.filter(node => node.dataset.roomAction === 'transfer'); assert.equal(transfers.length, 320);
  writes.disabled = writes.busy = 0; transfers[0]!.click();
  for (let index = 0; index < 5; index++) h.sdk.snapshot(clone(state));
  assert.ok(transfers.every(node => node.disabled && node.attributes['aria-busy'] === 'true'));
  transfers.at(-1)!.click(); assert.equal(calls, 1);
  assert.ok(nodes.filter(node => node.dataset.roomAction !== 'transfer').every(node => !node.disabled));
  work.resolve(undefined); await flushSample();
  assert.ok(nodes.every(node => !node.disabled && node.attributes['aria-busy'] === 'false'));
  assert.deepEqual(writes, { disabled: 5680, busy: 5680 }, 'entry, synchronous action, five snapshots and settlement still synchronize every control');
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
  t.diagnostic('Bounded synthetic sample: 301 seats, 20 raised hands, 710 controls; 10 identical snapshots perform 0 targeted selector queries and 7,100 disabled plus 7,100 aria-busy writes.');
});

it('whole sample synchronizes shared and filter-hidden controls and repairs current dataset policy and DOM state', async t => {
  const h = await setup(t), state = controllerState(); h.sdk.snapshot(clone(state));
  setFilter(h, 'Audience 1');
  const hidden = audienceRows(h).find(row => row.dataset.participantId === 'audience-0')!; assert.equal(hidden.hidden, true);
  const hiddenTransfer = hidden.descendants().find(node => node.dataset.roomAction === 'transfer')!;
  const nodes = actions(h), work = new Deferred<void>(); let calls = 0;
  Object.assign(h.sdk, { transferControl: () => { calls++; return work.promise; } });
  const visibleTransfer = audienceRows(h).find(row => !row.hidden)!.descendants().find(node => node.dataset.roomAction === 'transfer')!;
  h.reset(); visibleTransfer.click();
  assert.ok(nodes.filter(node => node.dataset.roomAction === 'transfer').every(node => node.disabled && node.attributes['aria-busy'] === 'true'));
  hiddenTransfer.disabled = false; hiddenTransfer.onclick!(); assert.equal(calls, 1);
  h.sdk.snapshot(clone(state)); assert.equal(hiddenTransfer.disabled, true);
  work.resolve(undefined); await flushSample(); assert.equal(hiddenTransfer.disabled, false);
  hiddenTransfer.dataset.policyDisabled = 'true'; hiddenTransfer.disabled = false; hiddenTransfer.setAttribute('aria-busy', 'incorrect');
  h.sdk.snapshot(clone(state));
  assert.equal(hiddenTransfer.disabled, true); assert.equal(hiddenTransfer.attributes['aria-busy'], 'false');
  hiddenTransfer.dataset.policyDisabled = 'false'; hiddenTransfer.disabled = true; h.sdk.snapshot(clone(state));
  assert.equal(hiddenTransfer.disabled, false); assert.equal(hidden.hidden, true);
  h.sdk.setStatus('reconnecting'); assert.ok(nodes.every(node => node.disabled));
  h.sdk.setStatus('live'); assert.ok(nodes.every(node => !node.disabled));
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 }); sameNodes(actions(h), nodes);
});

it('whole sample captures replacement controls after a dirty slider rebuild while retaining pending shared keys and filtering', async t => {
  const h = await setup(t), state = controllerState(); h.sdk.snapshot(clone(state)); setFilter(h, 'Audience 1');
  const work = new Deferred<void>(); Object.assign(h.sdk, { transferControl: () => work.promise });
  const nodes = actions(h); nodes.find(node => node.dataset.roomAction === 'transfer')!.click();
  const gain = action(h, 'gain:speaker-0'); gain.value = '7'; const retired = watchAccess(nodes); h.reset();
  h.sdk.snapshot(clone(state));
  assert.deepEqual({ ...h.counts }, { actionQueries: 1, returnQueries: 1, replacements: 1 });
  assert.notEqual(action(h, 'gain:speaker-0'), gain); assert.equal(action(h, 'gain:speaker-0').value, '0');
  assert.equal(audienceRows(h).filter(row => !row.hidden).length, 1);
  const current = actions(h); assert.ok(current.every(node => !nodes.includes(node)));
  assert.ok(current.filter(node => node.dataset.roomAction === 'transfer').every(node => node.disabled));
  const afterRebuild = { ...retired }; h.reset(); h.sdk.snapshot(clone(state));
  work.reject(new Error('transfer failed')); await flushSample();
  assert.deepEqual(retired, afterRebuild, 'snapshot and rejection must not consult retired controls');
  assert.ok(current.every(node => !node.disabled)); assert.match(errorBox(h).textContent, /transfer failed/);
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
});

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole sample ${outcome} after return-stage rebuild touches only current controls and preserves forced-mute/reconnect policy`, async t => {
    const h = await setup(t), state = controllerState(); state.me.onStage = false; state.speakers.shift();
    h.sdk.snapshot(clone(state)); const work = new Deferred<void>(); let calls = 0;
    Object.assign(h.sdk, { returnToStage: () => { calls++; return work.promise; } });
    h.button('返回舞台').click(); const nodes = actions(h), retired = watchAccess(nodes);
    const next = clone(state); next.me.onStage = true; next.me.forceMuted = true; next.speakers.unshift(next.me);
    h.reset(); h.sdk.snapshot(clone(next));
    assert.deepEqual({ ...h.counts }, { actionQueries: 1, returnQueries: 1, replacements: 1 });
    const current = actions(h), stage = h.button('離開舞台');
    assert.equal(stage.disabled, true); stage.click(); assert.equal(calls, 1); assert.equal(action(h, 'mute').disabled, true);
    const afterRebuild = { ...retired }; h.reset(); h.sdk.setStatus('reconnecting');
    settle(work, outcome); await flushSample();
    assert.ok(current.every(node => node.disabled)); assert.equal(stage.attributes['aria-busy'], 'false');
    h.sdk.setStatus('live'); h.sdk.snapshot(clone(next));
    assert.equal(stage.disabled, false); assert.equal(action(h, 'mute').disabled, true);
    assert.deepEqual(retired, afterRebuild); sameNodes(actions(h), current);
    assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
    assert.equal(errorBox(h).hidden, outcome === 'resolve');
  });
}

it('whole sample keeps shared target stage keys through promotion and rebinds every current management control', async t => {
  const h = await setup(t), state = controllerState(); h.sdk.snapshot(clone(state));
  const work = new Deferred<void>(); Object.assign(h.sdk, { approve: () => work.promise });
  const paired = actions(h).filter(node => node.dataset.roomAction === 'stage:audience-0'); assert.equal(paired.length, 2);
  paired[0]!.click(); assert.ok(paired.every(node => node.disabled && node.attributes['aria-busy'] === 'true'));
  const retired = watchAccess(actions(h));
  const next = clone(state), target = next.audience!.shift()!; next.hands = []; next.audienceCount--;
  next.speakers.push({ ...target, role: 'speaker', onStage: true, handRaised: false });
  h.reset(); h.sdk.snapshot(clone(next)); const replacement = action(h, 'stage:audience-0');
  assert.equal(replacement.textContent, '移出舞台'); assert.equal(replacement.disabled, true);
  assert.deepEqual({ ...h.counts }, { actionQueries: 1, returnQueries: 1, replacements: 1 });
  const afterRebuild = { ...retired }; h.reset(); work.resolve(undefined); await flushSample(); h.sdk.snapshot(clone(next));
  assert.equal(replacement.disabled, false); assert.deepEqual(retired, afterRebuild);
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
});

for (const transition of ['role', 'participant', 'room'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`whole sample ${transition} replacement handles old ${outcome} with no retired control access`, async t => {
      const h = await setup(t), state = controllerState(); state.me.onStage = false; state.speakers.shift();
      h.sdk.snapshot(clone(state)); const old = new Deferred<void>(), nextWork = new Deferred<void>(); let calls = 0;
      Object.assign(h.sdk, { returnToStage: () => ++calls === 1 ? old.promise : nextWork.promise,
        withdrawHand: () => nextWork.promise });
      h.button('返回舞台').click(); const retired = watchAccess(actions(h));
      const next = clone(state);
      if (transition === 'role') { next.me.role = 'audience'; next.me.handRaised = true; next.hands.push(next.me); }
      else if (transition === 'participant') next.me.participantId = 'replacement-controller';
      else next.roomId = 'replacement-room';
      h.reset(); h.sdk.snapshot(clone(next));
      assert.deepEqual({ ...h.counts }, { actionQueries: 1, returnQueries: 1, replacements: 1 });
      const current = action(h, transition === 'role' ? 'hand' : 'stage'); assert.equal(current.disabled, false); current.click();
      assert.equal(current.disabled, true); const replacementAccess = watchAccess(actions(h)), beforeReplacement = { ...replacementAccess };
      const afterRebuild = { ...retired }; h.reset(); settle(old, outcome, 'obsolete failure'); await flushSample();
      assert.deepEqual(retired, afterRebuild);
      if (transition !== 'role') {
        assert.deepEqual(replacementAccess, beforeReplacement, 'identity changes discard settlements before accessing replacement controls');
        assert.equal(errorBox(h).hidden, true);
      } else assert.equal(errorBox(h).hidden, outcome === 'resolve', 'a same-identity role change retains action error reporting');
      assert.equal(current.disabled, true); assert.equal(current.attributes['aria-busy'], 'true');
      nextWork.resolve(undefined); await flushSample(); assert.equal(current.disabled, false);
      assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
    });
  }
}

for (const terminal of ['disconnect', 'closed', 'kicked'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`whole sample ${terminal} clears current references before late ${outcome} and same-identity rejoin`, async t => {
      const h = await setup(t), state = controllerState(); state.me.onStage = false; state.speakers.shift();
      h.sdk.snapshot(clone(state)); const old = new Deferred<void>(); Object.assign(h.sdk, { returnToStage: () => old.promise });
      h.button('返回舞台').click(); const nodes = actions(h), retired = watchAccess(nodes);
      if (terminal === 'disconnect') await h.sdk.disconnect(); else await h.sdk.terminal(terminal);
      assert.ok(nodes.every(node => !node.isConnected)); const afterLeave = { ...retired }; h.reset();
      h.sdk.setStatus('waiting'); h.sdk.setStatus('disconnected');
      assert.deepEqual(retired, afterLeave, 'landing status updates cannot retain room controls');
      assert.equal(h.counts.actionQueries, 0); assert.equal(h.counts.returnQueries, 0);
      h.sdk.snapshot(clone(state)); const current = actions(h); assert.equal(h.button('返回舞台').disabled, false);
      const replacementAccess = watchAccess(current), beforeSettlement = { ...replacementAccess }; h.reset();
      settle(old, outcome, 'obsolete terminal failure'); await flushSample();
      assert.deepEqual(replacementAccess, beforeSettlement); assert.deepEqual(retired, afterLeave);
      assert.equal(errorBox(h).hidden, true);
      assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
    });
  }
}

it('whole sample hand countdown and pending withdrawal synchronize retained controls without selector polling', async t => {
  const h = await setup(t), state = roomState(); h.sdk.snapshot(clone(state));
  const original = action(h, 'hand'); h.reset(); original.click(); assert.equal(h.sdk.raises.length, 1);
  assert.equal(original.disabled, true); assert.equal(original.attributes['aria-busy'], 'true');
  h.clock.advance(500); assert.equal(original.textContent, '舉手發言（1 秒）');
  h.clock.advance(1000); assert.equal(original.textContent, '舉手發言'); assert.equal(original.disabled, true);
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
  const next = clone(state); next.me.handRaised = true; next.hands = [next.me]; h.sdk.snapshot(clone(next));
  const withdrawal = action(h, 'hand'); assert.notEqual(withdrawal, original); assert.equal(withdrawal.disabled, true);
  const retired = watchAccess([original]); h.reset(); h.sdk.raises[0]!.resolve(undefined); await flushSample();
  h.sdk.snapshot(clone(next)); assert.equal(withdrawal.disabled, false); assert.equal(withdrawal.attributes['aria-busy'], 'false');
  assert.deepEqual(retired, { reads: 0, writes: 0 });
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
});

it('whole sample publishes replacement references only after content replacement succeeds', async t => {
  const h = await setup(t), state = controllerState(); state.me.onStage = false; state.speakers.shift();
  h.sdk.snapshot(clone(state)); const work = new Deferred<void>(); Object.assign(h.sdk, { returnToStage: () => work.promise });
  h.button('返回舞台').click(); const nodes = actions(h), original = action(h, 'stage');
  const replace = h.main.replaceChildren.bind(h.main); let fail = true;
  h.main.replaceChildren = (...children) => {
    if (fail) { fail = false; throw new Error('controlled replacement failure'); }
    replace(...children);
  };
  const next = clone(state); next.name = 'Replacement room title'; h.reset();
  assert.throws(() => h.sdk.snapshot(clone(next)), /controlled replacement failure/);
  sameNodes(actions(h), nodes); assert.equal(original.disabled, true);
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
  work.resolve(undefined); await flushSample();
  assert.equal(original.disabled, false); assert.equal(original.attributes['aria-busy'], 'false');
  h.sdk.snapshot(clone(next)); assert.notEqual(action(h, 'stage'), original);
  assert.deepEqual({ ...h.counts }, { actionQueries: 1, returnQueries: 1, replacements: 1 });
  const retired = watchAccess(nodes); h.reset(); h.sdk.snapshot(clone(next)); h.sdk.setStatus('reconnecting'); h.sdk.setStatus('live');
  assert.deepEqual(retired, { reads: 0, writes: 0 });
  assert.deepEqual({ ...h.counts }, { actionQueries: 0, returnQueries: 0, replacements: 0 });
});
