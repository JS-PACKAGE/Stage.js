import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { MAX_GAIN_DB } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

interface GainRequest { targetId: string; gainDb: number; work: Deferred<void>; errorGate?: Deferred<void> }

function setup(delayGainErrors = false) {
  const h = sampleApp(), gains: GainRequest[] = [];
  const disconnect = h.sdk.disconnect.bind(h.sdk);
  let disconnects = 0;
  Object.assign(h.sdk, {
    setGain(targetId: string, gainDb: number): Promise<void> {
      const work = new Deferred<void>();
      const errorGate = delayGainErrors ? new Deferred<void>() : undefined;
      gains.push({ targetId, gainDb, work, errorGate });
      if (!errorGate) return work.promise;
      // Only the public continuation is delayed: disconnect still rejects the request
      // before emitting status, as the SDK does. This is an ordering double, not real SDK coverage.
      return work.promise.catch(async error => { await errorGate.promise; throw error; });
    },
    disconnect(): Promise<void> {
      disconnects++;
      for (const { work } of gains) if (work.status === 'pending') work.reject(new Error('連線已中斷。'));
      return disconnect();
    },
  });
  return {
    ...h, gains, disconnects: () => disconnects,
    async cleanup(): Promise<void> {
      for (const { errorGate } of gains) if (errorGate?.status === 'pending') errorGate.resolve(undefined);
      await h.cleanup();
      assert.ok(gains.every(({ work, errorGate }) => work.status !== 'pending' && errorGate?.status !== 'pending'));
    },
  };
}
type App = ReturnType<typeof setup>;

function managementState(): RoomStatePayload {
  const state = roomState({ participantId: 'controller', name: '測試主控', role: 'controller' });
  state.status = 'live'; state.audienceCount = 0; state.audience = [];
  state.speakers = ['speaker-a', 'speaker-b'].map(participantId => ({
    ...state.me, participantId, name: participantId, role: 'speaker', onStage: true,
  }));
  return state;
}
function slider(h: App, targetId = 'speaker-a'): SampleNode {
  const row = h.find(node => node.classList.contains('person') && node.dataset.participantId === targetId);
  const sliders = row.descendants().filter(node => node.tagName === 'input' && node.type === 'range');
  assert.equal(sliders.length, 1); return sliders[0]!;
}
function release(node: SampleNode, gainDb: number): void {
  assert.equal(node.disabled, false); assert.ok(node.onchange);
  node.value = String(gainDb); node.onchange();
}
const errorBox = (h: App) => h.find(node => node.attributes.role === 'alert');
const notices = (h: App) => h.find(node => node.classList.contains('notices'));
function assertLanding(h: App): void {
  assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected');
  assert.equal(h.app.descendants().filter(node => node.tagName === 'form').length, 2);
  assert.equal(h.clock.jobs.size, 0);
}
async function join(h: App, state = managementState()): Promise<void> {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [name, value] of Object.entries({ roomId: state.roomId, name: state.me.name, code: '' })) {
    const input = form.descendants().find(node => node.tagName === 'input' && node.name === name);
    assert.ok(input); input.value = value;
  }
  form.submit();
  assert.deepEqual({ ...h.sdk.joins.at(-1)!.options }, { roomId: state.roomId, name: state.me.name, code: undefined });
  h.sdk.acceptJoin(state); await flushSample();
  assert.equal(form.isConnected, false);
}

it('whole sample Leave click retires a pending gain before its ordered cancellation can show an error on landing', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const control = slider(h); release(control, 4);
  assert.equal(h.gains.length, 1); assert.equal(h.gains[0]!.work.status, 'pending');
  h.button('離開房間').click();
  assert.equal(h.disconnects(), 1); assert.equal(h.gains[0]!.work.status, 'rejected');
  assert.equal(h.sdk.events.at(-1), 'status'); assert.equal(control.isConnected, false); assertLanding(h);
  await flushSample();
  assertLanding(h); assert.equal(notices(h).textContent, '');
  assert.equal(errorBox(h).hidden, true, 'the retired gain cancellation must not be shown after Leave');
});

it('whole sample shutdown preserves its maintenance notice without a retired gain cancellation error', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h); release(slider(h), -3);
  const closing = h.sdk.terminal('closed', 'shutdown');
  assert.equal(h.gains[0]!.work.status, 'rejected'); assertLanding(h);
  assert.equal(notices(h).textContent, '', 'the disconnected status precedes the shutdown event');
  await closing; await flushSample();
  assert.deepEqual(h.sdk.events.slice(-2), ['status', 'closed']); assertLanding(h);
  assert.match(notices(h).textContent, /伺服器維護或重新啟動/);
  assert.equal(errorBox(h).hidden, true, 'the shutdown notice must not be accompanied by a stale gain error');
});

for (const currentMessage of ['notice', 'error'] as const) {
  it(`whole sample same-room same-identity rejoin keeps its new ${currentMessage} after a delayed old gain rejection`, async t => {
    const h = setup(true); t.after(() => h.cleanup()); await join(h);
    const original = h.sdk.state; assert.ok(original);
    release(slider(h), 5); const old = h.gains[0]!;
    h.button('離開房間').click(); await flushSample();
    assert.equal(old.work.status, 'rejected'); assert.equal(old.errorGate!.status, 'pending'); assertLanding(h);
    await join(h);
    assert.equal(h.sdk.state?.roomId, original.roomId); assert.equal(h.sdk.me?.participantId, original.me.participantId);
    const current = slider(h); release(current, 2);
    const replacement = h.gains[1]!; assert.equal(replacement.work.status, 'pending');
    if (currentMessage === 'notice') h.sdk.emit('invite', { participantId: original.me.participantId });
    else h.sdk.emit('error', { message: '目前房間的新錯誤。' });
    const notice = notices(h).textContent, error = errorBox(h).textContent, hidden = errorBox(h).hidden;
    if (currentMessage === 'notice') assert.match(notice, /主控已邀請你上台/);
    else assert.equal(error, '目前房間的新錯誤。');

    old.errorGate!.resolve(undefined); await flushSample();
    assert.equal(notices(h).textContent, notice); assert.equal(errorBox(h).hidden, hidden);
    assert.equal(errorBox(h).textContent, error, 'old gain settlement must not overwrite the new room message');
    assert.equal(slider(h), current); assert.equal(current.disabled, false);
    assert.equal(replacement.work.status, 'pending', 'an old completion does not settle a new gain request');
    replacement.work.resolve(undefined); replacement.errorGate!.resolve(undefined); await flushSample();
  });
}

for (const changed of ['room', 'participant'] as const) {
  it(`whole sample ignores a gain rejection after its ${changed} identity changes without an intermediate landing`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h); release(slider(h), 3);
    const next = managementState();
    if (changed === 'room') next.roomId = 'replacement-room';
    else { next.me.participantId = 'replacement-controller'; next.controllerId = next.me.participantId; }
    h.sdk.snapshot(next); h.sdk.emit('error', { message: '替換房間的錯誤。' });
    h.gains[0]!.work.reject(new Error('舊房間的音量錯誤。')); await flushSample();
    assert.equal(h.sdk.state, next); assert.equal(errorBox(h).hidden, false);
    assert.equal(errorBox(h).textContent, '替換房間的錯誤。');
  });
}

it('whole sample still displays current-generation gain rejection after same-identity redraw and allows retry', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const retired = slider(h); release(retired, 8); h.sdk.snapshot(managementState());
  const current = slider(h); assert.notEqual(current, retired); assert.equal(retired.isConnected, false);
  h.gains[0]!.work.reject(new Error('目前音量調整失敗。')); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '目前音量調整失敗。');
  assert.equal(current.disabled, false); release(current, -2);
  assert.equal(h.gains.length, 2); assert.equal(errorBox(h).hidden, true);
  h.gains[1]!.work.resolve(undefined); await flushSample(); assert.equal(errorBox(h).hidden, true);
});

it('whole sample sends every same- and different-target gain release concurrently and keeps snapshot-authoritative redraw', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const first = slider(h), second = slider(h, 'speaker-b');
  assert.equal(first.min, String(-MAX_GAIN_DB)); assert.equal(first.max, String(MAX_GAIN_DB)); assert.equal(first.step, '1');
  assert.equal(first.oninput, null, 'dragging alone does not send gain requests');
  first.value = '2'; assert.equal(h.gains.length, 0);
  release(first, 4); release(first, 5); release(first, 5); release(second, -6);
  assert.deepEqual(h.gains.map(({ targetId, gainDb }) => ({ targetId, gainDb })), [
    { targetId: 'speaker-a', gainDb: 4 }, { targetId: 'speaker-a', gainDb: 5 },
    { targetId: 'speaker-a', gainDb: 5 }, { targetId: 'speaker-b', gainDb: -6 },
  ]);
  assert.ok(h.gains.every(({ work }) => work.status === 'pending'));
  assert.equal(first.disabled, false); assert.equal(second.disabled, false);
  assert.deepEqual(h.sdk.state!.speakers.map(person => person.gainDb), [0, 0]);
  assert.equal(first.title, '0 dB'); assert.equal(second.title, '0 dB');

  h.gains[0]!.work.resolve(undefined); await flushSample();
  assert.equal(slider(h), first, 'an ACK alone must not replace the slider or invent a snapshot');
  assert.deepEqual(h.sdk.state!.speakers.map(person => person.gainDb), [0, 0]);
  const authoritative = managementState(); authoritative.speakers[0]!.gainDb = 2; authoritative.speakers[1]!.gainDb = -3;
  h.sdk.snapshot(authoritative);
  const redrawn = slider(h), redrawnSecond = slider(h, 'speaker-b');
  assert.equal(first.isConnected, false); assert.equal(second.isConnected, false);
  assert.equal(redrawn.value, '2'); assert.equal(redrawn.title, '2 dB');
  assert.equal(redrawnSecond.value, '-3'); assert.equal(redrawnSecond.title, '-3 dB');
  assert.match(redrawn.parentNode!.parentNode!.parentNode!.textContent, /音量 \+2 dB/);
  for (const index of [3, 2, 1]) h.gains[index]!.work.resolve(undefined);
  await flushSample();
  assert.equal(h.sdk.state, authoritative); assert.equal(slider(h), redrawn); assert.equal(slider(h, 'speaker-b'), redrawnSecond);
  assert.equal(redrawn.value, '2'); assert.equal(redrawnSecond.value, '-3'); assert.equal(errorBox(h).hidden, true);
});

it('whole sample checks gain error ownership at the UI write when rejection and replacement interleave in microtasks', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h); release(slider(h), 1); await flushSample();
  h.gains[0]!.work.reject(new Error('較早的音量錯誤。'));
  // The cross-realm fixture promise first settles the VM await. A wrapper that checks
  // ownership and then rethrows adds another continuation after the replacement below.
  await Promise.resolve(); await Promise.resolve();
  const replacement = managementState(); replacement.roomId = 'replacement-room'; h.sdk.snapshot(replacement);
  h.sdk.emit('error', { message: '目前房間的錯誤。' }); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '目前房間的錯誤。');
});

it('whole sample unrelated generic output-device action still reports its failure after Leave', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const output = new Deferred<void>();
  Object.assign(h.sdk, { setOutputDevice: (id: string) => { h.sdk.outputDevices.push(id); return output.promise; } });
  t.after(async () => { if (output.status === 'pending') output.resolve(undefined); await flushSample(); });
  const select = h.id('speaker-device'); select.value = 'speaker-a'; assert.ok(select.onchange); select.onchange();
  assert.deepEqual(h.sdk.outputDevices, ['speaker-a']); assert.equal(select.disabled, true);
  h.button('離開房間').click(); await flushSample(); assertLanding(h);
  assert.equal(output.status, 'pending'); output.reject(new Error('揚聲器選擇失敗。')); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '揚聲器選擇失敗。');
  assert.equal(select.disabled, false); assert.equal(select.value, '');
});
