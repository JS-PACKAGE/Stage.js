import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { StageClient } from '../packages/client/src/index.ts';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

// Complete production sample plus public SDK; only external boundaries are controlled.
// Retained/prepaint invocations below are synchronous programmatic calls, not physical clicks.
// Every room identifier, code and resume value in this file is fictional.
const copied = '已複製邀請連結，請只分享給受邀者。';
const fallback = '請長按或使用複製快捷鍵複製已選取的連結。';
const currentError = '保留目前操作錯誤。';
function state(): RoomStatePayload {
  const s = roomState({ participantId: 'fictional-host', role: 'controller' });
  return { ...s, roomId: 'fictional-room', controllerId: s.me.participantId, audience: [], audienceCount: 0,
    codeRequired: true, recording: false, recordingAvailable: false, code: 'FICTIONAL_OLD', resumeToken: 'fictional-resume' };
}

type StateChange = 'room' | 'participant' | 'code' | 'role' | 'code-required' | 'room-name' | 'own-name';
function changedState(change: string): RoomStatePayload {
  const s = state();
  if (change === 'room') s.roomId = 'fictional-other-room';
  if (change === 'participant') { s.me.participantId = 'fictional-other-host'; s.controllerId = s.me.participantId; }
  if (change === 'code') s.code = 'FICTIONAL_NEW';
  if (change === 'role') { s.me.role = 'audience'; s.controllerId = 'fictional-other-host'; delete s.code; }
  if (change === 'code-required') s.codeRequired = false;
  if (change === 'room-name') s.name = 'fictional changed room';
  if (change === 'own-name') s.me.name = 'fictional changed host';
  return s;
}

async function setup(t: TestContext, location = new URL('https://sample.test/')) {
  StageSocket.instances = []; StagePeer.instances = [];
  let captures = 0;
  const globals = { window: new EventTarget(), WebSocket: StageSocket, RTCPeerConnection: StagePeer,
    navigator: { mediaDevices: { async enumerateDevices() { return []; }, async getUserMedia() { captures++; throw new Error('Unexpected capture'); } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const audio = { autoplay: false, hidden: false, isConnected: true, volume: 1, muted: false, srcObject: null, pause() {}, async play() {}, remove() {} };
  const sdk = new StageClient({ url: 'wss://sample.test/ws', audioElement: audio as unknown as HTMLAudioElement });
  let earlierStateListener: (() => void) | undefined;
  let earlierStateError: unknown;
  sdk.on('state', () => {
    // EventTarget otherwise reports listener assertions after the test has ended.
    try { earlierStateListener?.(); } catch (error) { earlierStateError = error; }
  });
  const copies: { text: string; work: Deferred<void> }[] = [];
  const signalingPath = new URLSearchParams(location.search).get('wsPath') ?? '/ws';
  const h = sampleApp({ sdk, location, expectedSdkUrl: `wss://sample.test${signalingPath}`, clipboard: { writeText(text) { const work = new Deferred<void>(); copies.push({ text, work }); return work.promise; } } });
  const selections = new Map<SampleNode, { focus: number; select: number }>();
  const link = () => h.find(node => node.classList.contains('invite-link'));
  const watch = () => {
    const node = link(); if (!selections.has(node)) { const count = { focus: 0, select: 0 }; selections.set(node, count);
      Object.assign(node, { focus() { count.focus++; }, select() { count.select++; } }); }
    return node;
  };
  const error = () => h.find(node => node.attributes.role === 'alert');
  const notice = () => h.find(node => node.classList.contains('notices')).textContent;
  async function until(check: () => boolean) { for (let i = 0; i < 80 && !check(); i++) { now += 10; t.mock.timers.tick(10); await flushSample(); } assert.ok(check()); }
  async function join(s = state()) {
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
    for (const [name, value] of Object.entries({ roomId: s.roomId, code: s.code!, name: s.me.name })) {
      const input = form.descendants().filter(node => node.type !== 'histogram').find(node => node.name === name); assert.ok(input); input.value = value;
    }
    form.submit(); await flushSample();
    const socket = StageSocket.instances.at(-1)!;
    socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
    await until(() => socket.sent.some(message => message.type === 'join'));
    const request = socket.sent.find(message => message.type === 'join')!;
    socket.deliver({ type: 'room:state', ...s }); socket.deliver({ type: 'ok', requestId: request.requestId });
    const peer = StagePeer.instances.at(-1)!;
    await until(() => peer.localDescription !== null && peer.signalingState === 'stable'); watch();
    return socket;
  }
  const copy = () => {
    const before = copies.length; h.button('複製邀請連結').click();
    assert.equal(copies.length, before + 1); return copies.at(-1)!;
  };
  const settle = async (request: typeof copies[number], success: boolean) => {
    if (success) request.work.resolve(undefined); else request.work.reject(new Error('fictional clipboard rejection'));
    await flushSample();
  };
  const showError = (socket: StageSocket) => socket.deliver({ type: 'error', code: 'bad_request', message: currentError });
  t.after(async () => {
    try {
      await sdk.disconnect(); for (const request of copies) if (request.work.status === 'pending') request.work.resolve(undefined);
      await flushSample(); await h.cleanup(); assert.equal(captures, 0);
      assert.ok(StageSocket.instances.every(socket => socket.readyState === 3));
      assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'));
      if (earlierStateError) throw earlierStateError;
    } finally {
      for (const [key, value] of originals) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { ...h, copies, selections, link, watch, error, notice, join, copy, settle, showError,
    setEarlierStateListener(listener: () => void) { earlierStateListener = listener; } };
}

for (const change of ['unchanged', 'identical', 'room-name', 'own-name'] as const) for (const success of [true, false]) {
  it(`actual SDK invitation admission control: pending ${success ? 'success' : 'failure'} survives same-resource ${change}`, async t => {
    const h = await setup(t), socket = await h.join(), old = h.link(), request = h.copy();
    const s = state(); if (change === 'room-name') s.name = 'fictional updated room';
    if (change === 'own-name') s.me.name = 'fictional updated host';
    if (change !== 'unchanged') socket.deliver({ type: 'room:state', ...s });
    const current = h.watch(); h.showError(socket); await h.settle(request, success);
    assert.equal(h.notice(), success ? copied : fallback); assert.equal(h.error().hidden, false);
    assert.deepEqual(h.selections.get(current), success ? { focus: 0, select: 0 } : { focus: 1, select: 1 });
    if (old !== current) assert.deepEqual(h.selections.get(old), { focus: 0, select: 0 });
  });
}
for (const change of ['room', 'participant', 'code', 'role', 'leave', 'closed', 'kicked'] as const) for (const success of [true, false]) {
  it(`actual SDK invitation admission control: late ${success ? 'success' : 'failure'} cannot paint after ${change}`, async t => {
    const h = await setup(t), socket = await h.join(), request = h.copy(), old = h.link();
    const s = changedState(change);
    if (change === 'leave') h.button('離開房間').click();
    else if (change === 'closed' || change === 'kicked') socket.deliver(change === 'closed'
      ? { type: 'room:closed', roomId: s.roomId, reason: 'shutdown' } : { type: 'kicked', roomId: s.roomId });
    else socket.deliver({ type: 'room:state', ...s });
    await flushSample();
    if (h.sdk.state) {
      if (change !== 'role') h.watch();
      socket.deliver({ type: 'stage:invite', participantId: h.sdk.state.me.participantId, byId: s.controllerId });
      h.showError(socket);
    }
    const before = h.notice(), errorBefore = h.error().hidden;
    await h.settle(request, success);
    assert.equal(h.notice(), before); assert.equal(h.error().hidden, errorBefore); assert.equal(old.isConnected, false);
    assert.ok([...h.selections.values()].every(count => count.focus === 0 && count.select === 0));
  });
}
it('actual SDK invitation admission control: native-like repeat click is ignored while the mounted button is disabled', async t => {
  const h = await setup(t), socket = await h.join(), button = h.button('複製邀請連結'), request = h.copy();
  h.showError(socket); button.click(); assert.equal(h.copies.length, 1); assert.equal(h.error().hidden, false);
  await h.settle(request, true); assert.equal(h.notice(), copied);
});
it('actual SDK invitation admission control: overlapping same-resource redraw retains documented newest-result semantics', async t => {
  const h = await setup(t), socket = await h.join(), older = h.copy();
  socket.deliver({ type: 'room:state', ...state(), name: 'fictional changed room name' }); h.watch();
  const newer = h.copy(); assert.equal(h.copies.length, 2); assert.equal(newer.text, older.text);
  await h.settle(newer, true); await h.settle(older, false); assert.equal(h.notice(), copied);
});
for (const change of ['room', 'participant', 'code', 'role', 'code-required', 'room-name', 'own-name', 'leave', 'closed', 'kicked'] as const) {
  it(`actual SDK retained idle copy is a no-op after ${change}`, async t => {
    const h = await setup(t), socket = await h.join(), retained = h.button('複製邀請連結'), oldLink = h.link();
    const s = changedState(change);
    if (change === 'leave') h.button('離開房間').click();
    else if (change === 'closed' || change === 'kicked') socket.deliver(change === 'closed'
      ? { type: 'room:closed', roomId: s.roomId, reason: 'shutdown' } : { type: 'kicked', roomId: s.roomId });
    else socket.deliver({ type: 'room:state', ...s });
    await flushSample(); assert.equal(retained.isConnected, false); assert.equal(retained.disabled, false);
    if (!h.sdk.state) { const replacementSocket = await h.join(); h.showError(replacementSocket); }
    else h.showError(socket);
    const notice = h.notice(); retained.click(); await flushSample();
    assert.equal(h.copies.length, 0); assert.equal(h.error().hidden, false);
    assert.equal(h.error().textContent, currentError); assert.equal(h.notice(), notice);
    assert.equal(retained.disabled, false); assert.deepEqual(h.selections.get(oldLink), { focus: 0, select: 0 });
  });
}

for (const change of ['room', 'participant', 'code', 'role', 'code-required'] satisfies StateChange[]) {
  it(`actual SDK earlier listener rejects still-mounted obsolete copy before ${change} repaint`, async t => {
    const h = await setup(t), socket = await h.join(), retained = h.button('複製邀請連結'), oldLink = String(h.link().value);
    const s = changedState(change); h.showError(socket); let observed = 0;
    h.setEarlierStateListener(() => {
      observed++; assert.equal(retained.isConnected, true); assert.equal(retained.disabled, false);
      assert.equal(h.sdk.state?.roomId, s.roomId); assert.equal(h.sdk.me?.participantId, s.me.participantId);
      assert.equal(h.sdk.state?.code, s.code); assert.equal(h.sdk.me?.role, s.me.role);
      assert.equal(h.link().value, oldLink, 'sample state listener has not repainted yet');
      retained.click();
      assert.equal(h.copies.length, 0); assert.equal(h.error().hidden, false); assert.equal(retained.disabled, false);
    });
    socket.deliver({ type: 'room:state', ...s }); assert.equal(observed, 1);
    assert.equal(retained.isConnected, false); assert.equal(h.error().textContent, currentError);
  });
}

for (const success of [true, false]) {
  it(`actual SDK stale old-code handler cannot steal pending current-copy ${success ? 'success' : 'failure'}`, async t => {
    const h = await setup(t), socket = await h.join(), retained = h.button('複製邀請連結');
    socket.deliver({ type: 'room:state', ...changedState('code') });
    const current = h.watch(), currentCopy = h.copy(); h.showError(socket);
    retained.click(); assert.equal(h.copies.length, 1); assert.equal(h.error().hidden, false);
    await h.settle(currentCopy, success);
    assert.equal(h.notice(), success ? copied : fallback); assert.equal(h.error().hidden, false);
    assert.deepEqual(h.selections.get(current), success ? { focus: 0, select: 0 } : { focus: 1, select: 1 });
  });
  it(`actual SDK direct disabled handler preserves pending ${success ? 'success' : 'failure'} ownership`, async t => {
    const h = await setup(t), socket = await h.join(), button = h.button('複製邀請連結'), request = h.copy();
    h.showError(socket); assert.equal(button.disabled, true); button.onclick!();
    assert.equal(h.copies.length, 1); assert.equal(h.error().hidden, false);
    await h.settle(request, success); assert.equal(h.notice(), success ? copied : fallback);
  });
  it(`actual SDK current invitation copy remains allowed while reconnecting (${success ? 'success' : 'failure'})`, async t => {
    const h = await setup(t), socket = await h.join(); socket.close();
    assert.equal(h.sdk.status, 'reconnecting'); assert.ok(h.sdk.state);
    const current = h.watch(), request = h.copy(); await h.settle(request, success);
    assert.equal(h.notice(), success ? copied : fallback);
    assert.deepEqual(h.selections.get(current), success ? { focus: 0, select: 0 } : { focus: 1, select: 1 });
  });
}

for (const change of ['input-value', 'input-detached', 'copy-detached', 'pair-moved', 'old-pair-reconnected'] as const) {
  it(`actual SDK current rendered resource is required after ${change}`, async t => {
    const h = await setup(t), socket = await h.join(), button = h.button('複製邀請連結'), input = h.link();
    if (change === 'input-value') input.value = 'https://sample.test/?room=fictional-tampered';
    if (change === 'input-detached') input.remove();
    if (change === 'copy-detached') button.remove();
    if (change === 'pair-moved') h.app.append(input, button);
    if (change === 'old-pair-reconnected') {
      socket.deliver({ type: 'room:state', ...changedState('room-name') });
      h.app.append(input, button);
    }
    h.showError(socket); button.onclick!(); await flushSample();
    assert.equal(h.copies.length, 0); assert.equal(h.error().hidden, false); assert.equal(button.disabled, false);
    assert.deepEqual(h.selections.get(input), { focus: 0, select: 0 });
  });
}

it('actual SDK effective created-room fallback changes reject the still-mounted old invitation', async t => {
  const h = await setup(t), socket = await h.join();
  socket.deliver({ type: 'room:created', roomId: 'fictional-room', code: 'FICTIONAL_FALLBACK' });
  const s = state(); delete s.code; socket.deliver({ type: 'room:state', ...s });
  const old = h.button('複製邀請連結');
  assert.equal(h.link().value, 'https://sample.test/?room=fictional-room&code=FICTIONAL_FALLBACK');
  const request = h.copy(); await h.settle(request, true);
  socket.deliver({ type: 'room:created', roomId: 'fictional-room', code: 'FICTIONAL_REPLACED' });
  h.showError(socket); old.click();
  assert.equal(old.isConnected, true); assert.equal(h.copies.length, 1); assert.equal(h.error().hidden, false);
});

it('actual SDK explicit current code keeps precedence over an unrelated created-room fallback', async t => {
  const h = await setup(t), socket = await h.join();
  socket.deliver({ type: 'room:created', roomId: 'fictional-other-room', code: 'FICTIONAL_OTHER' });
  const request = h.copy(); assert.equal(request.text, 'https://sample.test/?room=fictional-room&code=FICTIONAL_OLD');
  await h.settle(request, true); assert.equal(h.notice(), copied);
});

it('actual SDK current invitation retains custom signaling path and page pathname', async t => {
  const h = await setup(t, new URL('https://sample.test/demo/?wsPath=%2Fstage%2Fws')); await h.join();
  const request = h.copy();
  assert.equal(request.text, 'https://sample.test/demo/?room=fictional-room&wsPath=%2Fstage%2Fws&code=FICTIONAL_OLD');
  await h.settle(request, true); assert.equal(h.notice(), copied);
});

it('actual SDK irrelevant code changes in an unprotected room preserve current-copy admission', async t => {
  const h = await setup(t), socket = await h.join(), s = state(); s.codeRequired = false;
  socket.deliver({ type: 'room:state', ...s });
  const retained = h.button('複製邀請連結'); let observed = false;
  h.setEarlierStateListener(() => {
    observed = true; retained.click(); assert.equal(h.copies.length, 1);
    assert.equal(h.copies[0]!.text, 'https://sample.test/?room=fictional-room');
  });
  socket.deliver({ type: 'room:state', ...s, code: 'FICTIONAL_IRRELEVANT' });
  assert.equal(observed, true); await h.settle(h.copies[0]!, true); assert.equal(h.notice(), copied);
});

for (const property of ['state', 'value', 'disabled'] as const) {
  it(`actual SDK admission ignores a throwing ${property} getter without hiding the current error`, async t => {
    const h = await setup(t), socket = await h.join(), input = h.link(), button = h.button('複製邀請連結');
    h.showError(socket);
    const target = property === 'state' ? h.sdk : property === 'value' ? input : button;
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    try {
      Object.defineProperty(target, property, { configurable: true, get() { throw new Error('fictional unavailable resource'); } });
      assert.doesNotThrow(() => button.onclick!());
      assert.equal(h.copies.length, 0); assert.equal(h.error().hidden, false);
    } finally {
      if (descriptor) Object.defineProperty(target, property, descriptor); else Reflect.deleteProperty(target, property);
    }
    assert.equal(button.disabled, false);
  });
}

it('actual SDK admission rechecks snapshot after a resource getter installs a replacement', async t => {
  const h = await setup(t), socket = await h.join(), input = h.link(), button = h.button('複製邀請連結');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'value')!, value = input.value;
  h.showError(socket); let entered = false;
  Object.defineProperty(input, 'value', { configurable: true, get() {
    if (!entered) { entered = true; socket.deliver({ type: 'room:state', ...changedState('code') }); }
    return value;
  } });
  try {
    button.onclick!(); assert.equal(entered, true); assert.equal(h.copies.length, 0); assert.equal(h.error().hidden, false);
  } finally { Object.defineProperty(input, 'value', descriptor); }
});

for (const property of ['disabled', 'hidden'] as const) {
  it(`actual SDK copy revalidates after bounded host reentry during run's ${property} write`, async t => {
    const h = await setup(t), socket = await h.join(), button = h.button('複製邀請連結');
    const target = property === 'disabled' ? button : h.error();
    const descriptor = Object.getOwnPropertyDescriptor(target, property)!;
    let value = Boolean(Reflect.get(target, property)), entered = false;
    Object.defineProperty(target, property, { configurable: true, get() { return value; }, set(next: boolean) {
      value = next;
      if (!entered) { entered = true; socket.deliver({ type: 'room:state', ...changedState('code') }); }
    } });
    try {
      button.onclick!(); await flushSample(); assert.equal(entered, true); assert.equal(h.copies.length, 0);
      assert.equal(button.isConnected, false); assert.equal(h.notice(), '');
    } finally { Object.defineProperty(target, property, descriptor); }
  });
}

for (const success of [true, false]) {
  it(`actual SDK reentrant same-owner admission preserves the single nested ${success ? 'success' : 'failure'}`, async t => {
    const h = await setup(t), socket = await h.join(), input = h.link(), button = h.button('複製邀請連結');
    const descriptor = Object.getOwnPropertyDescriptor(input, 'value')!, value = input.value;
    let entered = false;
    Object.defineProperty(input, 'value', { configurable: true, get() {
      if (!entered) { entered = true; button.onclick!(); h.showError(socket); }
      return value;
    } });
    try {
      button.onclick!(); assert.equal(entered, true); assert.equal(h.copies.length, 1);
      assert.equal(button.disabled, true); assert.equal(h.error().hidden, false);
    } finally { Object.defineProperty(input, 'value', descriptor); }
    await h.settle(h.copies[0]!, success);
    assert.equal(h.notice(), success ? copied : fallback); assert.equal(h.error().hidden, false);
    assert.deepEqual(h.selections.get(input), success ? { focus: 0, select: 0 } : { focus: 1, select: 1 });
  });
}
