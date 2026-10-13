import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

interface CopyRequest { text: string; work: Deferred<void> }
interface InputCalls { focus: number; select: number }
type Outcome = 'success' | 'failure';
const copiedNotice = '已複製邀請連結，請只分享給受邀者。';
const fallbackNotice = '請長按或使用複製快捷鍵複製已選取的連結。';
const rotatedNotice = '已更換房間代碼，請重新分享邀請連結。';

function setup(clipboardMode: 'deferred' | 'missing' | 'throw' = 'deferred') {
  const copies: CopyRequest[] = [], rotations: Deferred<void>[] = [], confirmations: string[] = [];
  const h = sampleApp({
    clipboard: clipboardMode === 'missing' ? undefined : { writeText(text: string): Promise<void> {
      if (clipboardMode === 'throw') throw new Error('clipboard unavailable');
      const work = new Deferred<void>(); copies.push({ text, work }); return work.promise;
    } },
    confirm(message) { confirmations.push(message); return true; },
  });
  Object.assign(h.sdk, { rotateCode(): Promise<void> {
    const work = new Deferred<void>(); rotations.push(work); return work.promise;
  } });
  const inputCalls = new Map<SampleNode, InputCalls>();
  return {
    ...h, copies, rotations, confirmations, inputCalls,
    watchInput(node: SampleNode): InputCalls {
      assert.equal(node.tagName, 'input'); assert.equal(inputCalls.has(node), false);
      const calls: InputCalls = { focus: 0, select: 0 }; inputCalls.set(node, calls);
      // Record only method calls: this fixture does not model native focus or selection.
      Object.assign(node, { focus() { calls.focus++; }, select() { calls.select++; } });
      return calls;
    },
    async cleanup(): Promise<void> {
      await h.sdk.disconnect();
      for (const { work } of copies) if (work.status === 'pending') work.resolve(undefined);
      for (const work of rotations) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
      await flushSample(); await h.cleanup();
      assert.ok(copies.every(({ work }) => work.status !== 'pending'));
      assert.ok(rotations.every(work => work.status !== 'pending'));
    },
  };
}
type App = ReturnType<typeof setup>;

function controllerState(code = 'OLD23456'): RoomStatePayload {
  const state = roomState({ participantId: 'controller', name: '測試主控', role: 'controller' });
  state.controllerId = state.me.participantId; state.audienceCount = 0; state.audience = [];
  state.codeRequired = true; state.code = code;
  return state;
}
const notices = (h: App) => h.find(node => node.classList.contains('notices'));
const errorBox = (h: App) => h.find(node => node.attributes.role === 'alert');
const inviteLink = (h: App) => h.find(node => node.tagName === 'input' && node.classList.contains('invite-link'));
function assertNoSelection(h: App): void {
  assert.ok([...h.inputCalls.values()].every(calls => calls.focus === 0 && calls.select === 0), 'no current or retired input should be focused or selected');
}
function assertLanding(h: App): void {
  assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected');
  assert.equal(h.app.descendants().filter(node => node.tagName === 'form').length, 2);
  assert.equal(h.app.descendants().filter(node => node.classList.contains('invite-link')).length, 0);
  assert.equal(h.clock.jobs.size, 0);
}
async function join(h: App, state = controllerState()): Promise<void> {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [name, value] of Object.entries({ roomId: state.roomId, name: state.me.name, code: state.code ?? '' })) {
    const input = form.descendants().find(node => node.tagName === 'input' && node.name === name);
    assert.ok(input); input.value = value;
  }
  form.submit(); h.sdk.acceptJoin(state); await flushSample();
  assert.equal(form.isConnected, false); assert.equal(inviteLink(h).isConnected, true);
}
function copy(h: App): CopyRequest {
  const before = h.copies.length, button = h.button('複製邀請連結');
  button.click(); assert.equal(button.disabled, true); assert.equal(h.copies.length, before + 1);
  const request = h.copies.at(-1)!;
  assert.equal(request.text, inviteLink(h).value); assert.equal(request.work.status, 'pending');
  return request;
}
async function settle(request: CopyRequest, outcome: Outcome): Promise<void> {
  if (outcome === 'success') request.work.resolve(undefined);
  else request.work.reject(new Error('clipboard denied'));
  await flushSample();
}

for (const mode of ['missing', 'throw'] as const) {
  it(`whole sample invitation copy uses the current input fallback when clipboard is ${mode}`, async t => {
    const h = setup(mode); t.after(() => h.cleanup()); await join(h);
    const input = inviteLink(h), calls = h.watchInput(input), button = h.button('複製邀請連結');
    assert.equal(input.readOnly, true); assert.equal(input.attributes['aria-label'], '邀請連結');
    button.click(); await flushSample();
    assert.equal(notices(h).textContent, fallbackNotice); assert.equal(errorBox(h).hidden, true);
    assert.deepEqual(calls, { focus: 1, select: 1 }); assert.equal(input.isConnected, true);
    assert.equal(button.disabled, false); assert.equal(h.copies.length, 0);
  });
}

for (const redraw of [false, true]) {
  for (const outcome of ['success', 'failure'] as const) {
    it(`whole sample current invitation copy ${outcome} survives ${redraw ? 'a harmless same-identity redraw' : 'an unchanged view'}`, async t => {
      const h = setup(); t.after(() => h.cleanup()); await join(h);
      const first = inviteLink(h), firstCalls = h.watchInput(first), firstButton = h.button('複製邀請連結');
      assert.equal(first.value, 'https://sample.test/?room=same-room&code=OLD23456');
      const request = copy(h);
      if (redraw) h.sdk.snapshot(controllerState());
      const current = inviteLink(h), currentCalls = redraw ? h.watchInput(current) : firstCalls;
      if (redraw) {
        assert.notEqual(current, first); assert.equal(first.isConnected, false);
        assert.equal(current.value, first.value); assert.deepEqual(h.sdk.events.slice(-1), ['state']);
      }
      await settle(request, outcome);
      assert.equal(notices(h).textContent, outcome === 'success' ? copiedNotice : fallbackNotice);
      assert.equal(errorBox(h).hidden, true); assert.equal(current.isConnected, true);
      assert.deepEqual(currentCalls, outcome === 'success' ? { focus: 0, select: 0 } : { focus: 1, select: 1 });
      if (redraw) {
        assert.deepEqual(firstCalls, { focus: 0, select: 0 }, 'failure must not select a retired render node');
        assert.equal(firstButton.disabled, true, 'the retired button is not changed by finally');
      }
      assert.equal(h.button('複製邀請連結').disabled, false);
    });
  }
}

for (const outcome of ['success', 'failure'] as const) {
  it(`whole sample old invitation copy ${outcome} preserves the new-code notice after state-before-ACK rotation`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h);
    const retired = inviteLink(h); h.watchInput(retired); const request = copy(h);
    h.button('更換房間代碼').click();
    assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0]!, /舊代碼與舊邀請連結立即失效/);
    assert.equal(h.rotations.length, 1); assert.equal(h.rotations[0]!.status, 'pending');
    h.sdk.snapshot(controllerState('NEW23456'));
    const current = inviteLink(h); h.watchInput(current);
    assert.equal(retired.isConnected, false); assert.equal(current.value, 'https://sample.test/?room=same-room&code=NEW23456');
    assert.equal(h.button('更換房間代碼').disabled, true);
    h.rotations[0]!.resolve(undefined); await flushSample();
    assert.equal(notices(h).textContent, rotatedNotice); assert.equal(h.button('更換房間代碼').disabled, false);

    await settle(request, outcome);
    assert.equal(notices(h).textContent, rotatedNotice, 'copying a retired code must not replace the successful rotation notice');
    assert.equal(inviteLink(h), current); assert.equal(errorBox(h).hidden, true); assertNoSelection(h);
    const fresh = copy(h); await settle(fresh, 'success');
    assert.equal(notices(h).textContent, copiedNotice); assert.equal(fresh.text, current.value);
  });

  it(`whole sample old invitation copy ${outcome} is ignored after controller role loss removes the link`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h);
    const retired = inviteLink(h); h.watchInput(retired); const request = copy(h);
    const next = roomState({ participantId: 'controller', name: '測試主控', role: 'audience' });
    next.controllerId = 'new-controller'; next.codeRequired = true;
    h.sdk.snapshot(next); h.sdk.emit('invite', { participantId: next.me.participantId });
    assert.equal(retired.isConnected, false);
    assert.equal(h.app.descendants().filter(node => node.classList.contains('invite-link')).length, 0);
    const notice = notices(h).textContent; assert.match(notice, /主控已邀請你上台/);
    await settle(request, outcome);
    assert.equal(notices(h).textContent, notice); assert.equal(errorBox(h).hidden, true); assertNoSelection(h);
  });

  it(`whole sample old invitation copy ${outcome} cannot affect Leave or a same-room same-identity rejoin`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h);
    const original = h.sdk.state!;
    const retired = inviteLink(h); h.watchInput(retired); const request = copy(h);
    h.button('離開房間').click();
    assert.equal(h.sdk.events.at(-1), 'status'); assertLanding(h); assert.equal(retired.isConnected, false);
    await flushSample(); assertLanding(h); assert.equal(notices(h).textContent, '');
    await join(h);
    assert.equal(h.sdk.state?.roomId, original.roomId); assert.equal(h.sdk.me?.participantId, original.me.participantId);
    const current = inviteLink(h); h.watchInput(current);
    assert.equal(current.value, request.text, 'the generation guard must distinguish an identical link after rejoin');
    h.sdk.emit('invite', { participantId: original.me.participantId });
    const notice = notices(h).textContent; assert.match(notice, /主控已邀請你上台/);
    await settle(request, outcome);
    assert.equal(notices(h).textContent, notice); assert.equal(errorBox(h).hidden, true); assertNoSelection(h);
    assert.equal(inviteLink(h), current); assert.equal(h.button('複製邀請連結').disabled, false);
  });

  it(`whole sample old invitation copy ${outcome} preserves the SDK-ordered shutdown notice`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h);
    const retired = inviteLink(h); h.watchInput(retired); const request = copy(h);
    const closing = h.sdk.terminal('closed', 'shutdown');
    assertLanding(h); assert.equal(notices(h).textContent, '', 'disconnected status renders landing before the terminal notification');
    await closing; await flushSample();
    assert.deepEqual(h.sdk.events.slice(-2), ['status', 'closed']); assert.equal(retired.isConnected, false);
    const notice = notices(h).textContent; assert.match(notice, /伺服器維護或重新啟動/);
    await settle(request, outcome);
    assertLanding(h); assert.equal(notices(h).textContent, notice); assert.equal(errorBox(h).hidden, true); assertNoSelection(h);
  });
}

for (const firstToSettle of ['older', 'newer'] as const) {
  for (const newerOutcome of ['success', 'failure'] as const) {
    it(`whole sample overlapping copy keeps the newer ${newerOutcome} when ${firstToSettle} settles first`, async t => {
      const h = setup(); t.after(() => h.cleanup()); await join(h);
      const retired = inviteLink(h), retiredCalls = h.watchInput(retired), retiredButton = h.button('複製邀請連結');
      const older = copy(h); h.sdk.snapshot(controllerState());
      const current = inviteLink(h), currentCalls = h.watchInput(current), currentButton = h.button('複製邀請連結');
      assert.equal(retired.isConnected, false); assert.notEqual(current, retired);
      const newer = copy(h); assert.equal(newer.text, older.text);
      const olderOutcome = newerOutcome === 'success' ? 'failure' : 'success';
      const expectedNotice = newerOutcome === 'success' ? copiedNotice : fallbackNotice;
      const expectedCalls = newerOutcome === 'success' ? { focus: 0, select: 0 } : { focus: 1, select: 1 };
      if (firstToSettle === 'older') {
        await settle(older, olderOutcome);
        assert.equal(notices(h).textContent, '', 'an older completion must not publish while a newer copy is pending');
        assert.equal(newer.work.status, 'pending'); assert.equal(currentButton.disabled, true);
        assert.deepEqual(currentCalls, { focus: 0, select: 0 }); assert.deepEqual(retiredCalls, { focus: 0, select: 0 });
        await settle(newer, newerOutcome);
      } else {
        await settle(newer, newerOutcome);
        assert.equal(notices(h).textContent, expectedNotice); assert.deepEqual(currentCalls, expectedCalls);
        assert.equal(older.work.status, 'pending'); assert.equal(currentButton.disabled, false);
        await settle(older, olderOutcome);
      }
      assert.equal(notices(h).textContent, expectedNotice); assert.deepEqual(currentCalls, expectedCalls);
      assert.deepEqual(retiredCalls, { focus: 0, select: 0 }); assert.equal(errorBox(h).hidden, true);
      assert.equal(retiredButton.disabled, true); assert.equal(currentButton.disabled, false); assert.equal(inviteLink(h), current);
    });
  }
}
