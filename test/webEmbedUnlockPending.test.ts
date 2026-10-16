import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { Deferred, embedApp, flush } from './fixtures/embedApp.ts';
import type { EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageContext, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';

// Execute the complete embed and public SDK with controlled DOM, socket and media promises.
// These cases establish application ordering, not native browser gestures, audible output or AT behavior.
interface View { node(id: string): EmbedNode }
type ActualApp = Awaited<ReturnType<typeof actualApp>>;
function busy(button: EmbedNode, value: boolean): void {
  assert.equal(button.disabled, value); assert.equal(button.attributes['aria-busy'], String(value));
}
function notice(h: View, message?: string): void {
  assert.equal(h.node('error-notice').hidden, message === undefined);
  assert.equal(h.node('last-error').textContent, message === undefined ? '' : `最近錯誤：${message}`);
}
function heldWork(t: TestContext): Deferred[] {
  const work: Deferred[] = [];
  t.after(async () => {
    for (const pending of work) if (!pending.settled) pending.resolve();
    await flush(); assert.ok(work.every(pending => pending.settled));
  });
  return work;
}
function controlledAudio(t: TestContext, h: ActualApp, interruptOnPause = false) {
  const plays = heldWork(t), observed: { disabled: boolean; busy: string | undefined }[] = [];
  const button = h.node('unlock');
  const callbacks = { onPlay: (_index: number): void => {} };
  t.mock.method(h.audio, 'play', () => {
    const work = new Deferred(); plays.push(work);
    observed.push({ disabled: button.disabled, busy: button.attributes['aria-busy'] });
    callbacks.onPlay(plays.length - 1); return work.promise;
  });
  if (interruptOnPause) {
    const pause = h.audio.pause.bind(h.audio);
    t.mock.method(h.audio, 'pause', () => {
      pause(); for (const work of plays) if (!work.settled) work.reject('controlled cleanup interruption');
    });
  }
  return { plays, observed, callbacks };
}
function controls(h: View) {
  return ['join', 'hand', 'mic', 'rename', 'stage', 'mic-retry', 'cancel-join', 'leave'].map(id => {
    const node = h.node(id);
    return { id, disabled: node.disabled, hidden: node.hidden, text: node.textContent, attributes: { ...node.attributes } };
  });
}
function hello(socket: StageSocket): void {
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
}

for (const phase of ['pre-entry', 'live', 'reconnecting'] as const) {
  it(`whole embed actual SDK admits one synchronous unlock during ${phase} and retries after each settlement`, async t => {
    const h = await actualApp(t); let socket: StageSocket | undefined;
    if (phase !== 'pre-entry') ({ socket } = await h.join({ role: 'audience' }));
    if (phase === 'reconnecting') { socket!.close(); await flush(); assert.equal(h.clients[0]!.status, 'reconnecting'); }
    const { plays, observed } = controlledAudio(t, h), button = h.node('unlock'); busy(button, false);
    const before = controls(h), wire = socket?.sent.slice(), status = h.status.textContent;
    button.click(); assert.equal(plays.length, 1, 'play runs before the click handler returns'); busy(button, true);
    assert.deepEqual(observed, [{ disabled: true, busy: 'true' }], 'reservation is visible before calling play');
    button.click(); button.invoke(); button.invoke(); assert.equal(plays.length, 1, 'direct handler calls cannot bypass admission');
    assert.deepEqual(controls(h), before); assert.deepEqual(socket?.sent, wire); assert.equal(h.status.textContent, status); notice(h);
    plays[0]!.resolve(); await flush(); busy(button, false); assert.equal(h.status.textContent, status); notice(h);
    button.click(); assert.equal(plays.length, 2); busy(button, true);
    plays[1]!.reject('目前播放失敗。'); await flush(); busy(button, false); notice(h, '目前播放失敗。');
    assert.equal(h.status.textContent, '目前播放失敗。');
    button.click(); assert.equal(plays.length, 3); busy(button, true);
    plays[2]!.resolve(); await flush(); busy(button, false); notice(h, '目前播放失敗。');
    assert.equal(h.status.textContent, '目前播放失敗。', 'success retains existing feedback');
    assert.equal(h.captures.length, 0); assert.equal(StageContext.instances.length, 0);
    if (phase !== 'pre-entry') { assert.equal(StagePeer.instances.length, 1); assert.equal(StagePeer.instances[0]!.connectionState, 'connected'); }
  });
}

it('whole embed actual SDK retains one pending unlock through socket loss, state redraw and same-client resume', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join({ role: 'audience' });
  const { plays } = controlledAudio(t, h), button = h.node('unlock'), offers = peer.offers.slice();
  button.click(); socket.close(); await flush(); busy(button, true); button.invoke(); assert.equal(plays.length, 1);
  await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket); hello(resumed);
  await h.until(() => resumed.sent.some(message => message.type === 'join'), 'same-client resume request');
  const request = resumed.sent.find(message => message.type === 'join')!;
  assert.equal(request.resumeToken, 'test-resume');
  resumed.deliver({ type: 'room:state', ...actualState({ role: 'audience', name: '重新連線的聽眾' }) });
  resumed.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  assert.equal(h.clients.length, 1); assert.equal(h.clients[0]!.status, 'live');
  busy(button, true); button.click(); button.invoke(); assert.equal(plays.length, 1);
  assert.equal(StagePeer.instances.length, 1); assert.equal(peer.connectionState, 'connected'); assert.deepEqual(peer.offers, offers);
  assert.equal(h.node('hand').disabled, false); assert.equal(h.leave.disabled, false);
  plays[0]!.reject('重新連線後的播放失敗。'); await flush(); busy(button, false); notice(h, '重新連線後的播放失敗。');
  button.click(); assert.equal(plays.length, 2); plays[1]!.resolve(); await flush(); busy(button, false);
});

for (const connected of [false, true]) {
  it(`whole embed ${connected ? 'actual SDK' : 'pre-entry fallback'} catches synchronous play throws and releases admission`, async t => {
    const h = await actualApp(t); if (connected) await h.join({ role: 'audience' });
    const button = h.node('unlock'), observed: { disabled: boolean; busy: string | undefined }[] = [];
    t.mock.method(h.audio, 'play', () => {
      observed.push({ disabled: button.disabled, busy: button.attributes['aria-busy'] });
      throw new Error('同步播放失敗。');
    });
    button.click(); await flush();
    assert.deepEqual(observed, [{ disabled: true, busy: 'true' }]); busy(button, false); notice(h, '同步播放失敗。');
    const { plays } = controlledAudio(t, h); button.click(); busy(button, true); assert.equal(plays.length, 1);
    plays[0]!.resolve(); await flush(); busy(button, false); notice(h, '同步播放失敗。');
  });
}

for (const dismissed of [false, true]) {
  it(`whole embed successful pending unlock ${dismissed ? 'does not resurrect a dismissed' : 'preserves an unrelated'} last error`, async t => {
    const h = await actualApp(t), { socket } = await h.join({ role: 'audience' });
    socket.deliver({ type: 'error', code: 'internal', message: '先前控制操作失敗。' }); notice(h, '先前控制操作失敗。');
    const { plays } = controlledAudio(t, h), button = h.node('unlock'); button.click(); busy(button, true);
    if (dismissed) h.node('error-dismiss').click();
    notice(h, dismissed ? undefined : '先前控制操作失敗。'); busy(button, true);
    socket.deliver({ type: 'room:state', ...actualState({ role: 'audience', name: '更新的聽眾' }) });
    const status = h.status.textContent; button.invoke(); assert.equal(plays.length, 1); busy(button, true);
    plays[0]!.resolve(); await flush(); busy(button, false);
    notice(h, dismissed ? undefined : '先前控制操作失敗。'); assert.equal(h.status.textContent, status);
    button.click(); plays[1]!.reject('新的播放失敗。'); await flush(); notice(h, '新的播放失敗。'); busy(button, false);
  });
}

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed actual client construction retires a fallback begun after submission before its late ${outcome}`, async t => {
    const h = await actualApp(t), { plays } = controlledAudio(t, h), button = h.node('unlock');
    h.form.submit(); button.click(); assert.equal(h.clients.length, 0); assert.equal(plays.length, 1); busy(button, true);
    await flush(); assert.equal(h.clients.length, 1); busy(button, false);
    button.click(); assert.equal(plays.length, 2); busy(button, true);
    if (outcome === 'resolve') plays[0]!.resolve(); else plays[0]!.reject('舊的載入中播放失敗。');
    await flush(); busy(button, true); notice(h); button.invoke(); assert.equal(plays.length, 2);
    plays[1]!.reject('目前連線中的播放失敗。'); await flush(); busy(button, false); notice(h, '目前連線中的播放失敗。');
    assert.equal(StageSocket.instances.length, 1); assert.equal(StageSocket.instances[0]!.sent.length, 0);
  });
}

it('whole embed new entry retires pre-entry playback immediately and a second fallback at delayed import completion', async t => {
  const library = new Deferred(), h = embedApp({ libraryLoad: library.promise }), plays = heldWork(t), button = h.node('unlock');
  t.after(async () => { if (!library.settled) library.resolve(); await flush(); await h.cleanup(); });
  t.mock.method(h.node('audio'), 'play', () => { const work = new Deferred(); plays.push(work); return work.promise; });
  button.click(); busy(button, true); h.form.submit(); busy(button, false); await flush();
  assert.equal(h.clients.length, 0); button.click(); assert.equal(plays.length, 2); busy(button, true);
  plays[0]!.reject('加入前的舊播放失敗。'); await flush(); busy(button, true); notice(h);
  library.resolve(); await flush(); assert.equal(h.clients.length, 1); busy(button, false);
  const current = h.clients[0]!, active = new Deferred(); plays.push(active); current.unlockAudio = () => active.promise;
  button.click(); busy(button, true); plays[1]!.reject('元件載入中的舊播放失敗。'); await flush(); busy(button, true); notice(h);
  active.resolve(); await flush(); busy(button, false); notice(h);
});

for (const transition of ['leave', 'disconnected', 'closed', 'kicked', 'cancel'] as const) {
  for (const outcome of ['cleanup-rejection', 'already-fulfilled'] as const) {
    it(`whole embed actual SDK ${transition} releases ${outcome} admission before a fresh manual attempt`, async t => {
      const h = await actualApp(t); let socket: StageSocket;
      if (transition === 'cancel') { h.form.submit(); await flush(); socket = StageSocket.instances.at(-1)!; }
      else ({ socket } = await h.join({ role: 'audience' }));
      const { plays } = controlledAudio(t, h, true), button = h.node('unlock'); button.click(); busy(button, true);
      if (outcome === 'already-fulfilled') plays[0]!.resolve();
      if (transition === 'leave') h.leave.click();
      else if (transition === 'disconnected') void h.clients[0]!.disconnect();
      else if (transition === 'cancel') h.node('cancel-join').click();
      else socket.deliver(transition === 'closed' ? { type: 'room:closed', roomId: 'same-room' } : { type: 'kicked', roomId: 'same-room' });
      busy(button, false); assert.equal(plays[0]!.settled, true);
      // Terminal notifications follow SDK cleanup asynchronously; wait for that retirement too.
      if (transition === 'closed' || transition === 'kicked') await flush();
      button.click(); busy(button, true); assert.equal(plays.length, 2); button.invoke(); assert.equal(plays.length, 2);
      await flush(); busy(button, true); notice(h);
      const status = { leave: '已離開。', disconnected: '未連線', closed: '房間已關閉。', kicked: '你已被主控移出房間。', cancel: '已取消連線。' }[transition];
      assert.equal(h.status.textContent, status);
      assert.equal(h.leave.disabled, true); assert.equal(h.form.submitButton!.disabled, false);
      plays[1]!.reject('離線手動播放失敗。'); await flush(); busy(button, false); notice(h, '離線手動播放失敗。');
      assert.equal(StageSocket.instances.length, 1, 'manual playback must not reconnect');
      assert.equal(socket.readyState, 3); assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'));
    });
  }
}

for (const transition of ['leave', 'disconnected', 'closed', 'kicked', 'cancel'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`whole embed ${transition} ignores held old ${outcome} after new manual playback starts`, async t => {
      const h = await actualApp(t); let socket: StageSocket;
      if (transition === 'cancel') { h.form.submit(); await flush(); socket = StageSocket.instances.at(-1)!; }
      else ({ socket } = await h.join({ role: 'audience' }));
      // Defensive settlement coverage: this controlled promise intentionally survives media cleanup.
      const { plays } = controlledAudio(t, h), button = h.node('unlock'); button.click();
      if (transition === 'leave') h.leave.click();
      else if (transition === 'disconnected') void h.clients[0]!.disconnect();
      else if (transition === 'cancel') h.node('cancel-join').click();
      else socket.deliver(transition === 'closed' ? { type: 'room:closed', roomId: 'same-room' } : { type: 'kicked', roomId: 'same-room' });
      await flush(); busy(button, false); assert.equal(plays[0]!.settled, false);
      const status = h.status.textContent; button.click(); busy(button, true); assert.equal(plays.length, 2);
      if (outcome === 'resolve') plays[0]!.resolve(); else plays[0]!.reject('終止前的舊播放失敗。');
      await flush(); busy(button, true); notice(h); assert.equal(h.status.textContent, status);
      button.invoke(); assert.equal(plays.length, 2);
      plays[1]!.reject('終止後的目前播放失敗。'); await flush(); busy(button, false); notice(h, '終止後的目前播放失敗。');
    });
  }
}

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed cancelled import keeps new fallback admission through old ${outcome} and late library completion`, async t => {
    const library = new Deferred(), h = embedApp({ libraryLoad: library.promise }), plays = heldWork(t), button = h.node('unlock');
    t.after(async () => { if (!library.settled) library.resolve(); await flush(); await h.cleanup(); });
    t.mock.method(h.node('audio'), 'play', () => { const work = new Deferred(); plays.push(work); return work.promise; });
    h.form.submit(); await flush(); button.click(); busy(button, true); assert.equal(h.clients.length, 0);
    h.node('cancel-join').click(); busy(button, false); assert.equal(h.status.textContent, '已取消連線。');
    button.click(); busy(button, true); assert.equal(plays.length, 2);
    if (outcome === 'resolve') plays[0]!.resolve(); else plays[0]!.reject('取消載入前的舊播放失敗。');
    library.resolve(); await flush(); busy(button, true); assert.equal(h.clients.length, 0); notice(h);
    assert.equal(h.status.textContent, '已取消連線。'); button.invoke(); assert.equal(plays.length, 2);
    plays[1]!.reject('取消載入後的目前播放失敗。'); await flush(); busy(button, false); notice(h, '取消載入後的目前播放失敗。');
  });
}

for (const outcome of ['resolve', 'reject'] as const) {
  for (const settlement of ['before replacement playback', 'during replacement playback'] as const) {
    it(`whole embed actual SDK new entry isolates old ${outcome} ${settlement}`, async t => {
      const h = await actualApp(t), { socket: oldSocket, peer: oldPeer } = await h.join({ role: 'audience' });
      // Held play deliberately survives cleanup to exercise ownership, not a native pause reproduction.
      const { plays } = controlledAudio(t, h), button = h.node('unlock'); button.click(); busy(button, true);
      const { socket, peer } = await h.join({ role: 'audience' }); busy(button, false);
      assert.notEqual(socket, oldSocket); assert.notEqual(peer, oldPeer); assert.equal(oldPeer.connectionState, 'closed');
      if (settlement === 'during replacement playback') { button.click(); busy(button, true); }
      if (outcome === 'resolve') plays[0]!.resolve(); else plays[0]!.reject('被替換連線的舊播放失敗。');
      await flush(); busy(button, settlement === 'during replacement playback'); notice(h);
      if (settlement === 'before replacement playback') button.click();
      busy(button, true); assert.equal(plays.length, 2); button.invoke(); assert.equal(plays.length, 2);
      plays[1]!.reject('替換連線的目前播放失敗。'); await flush(); busy(button, false); notice(h, '替換連線的目前播放失敗。');
      assert.equal(h.clients.length, 2); assert.equal(StagePeer.instances.length, 2); assert.equal(peer.connectionState, 'connected');
      assert.equal(h.captures.length, 0);
    });
  }
}

for (const connected of [false, true]) {
  it(`whole embed ${connected ? 'actual SDK' : 'fallback'} reservation rejects reentrant direct handler calls`, async t => {
    const h = await actualApp(t); if (connected) await h.join({ role: 'audience' });
    const { plays, observed, callbacks } = controlledAudio(t, h), button = h.node('unlock');
    callbacks.onPlay = index => { if (index === 0) button.invoke(); };
    button.click(); assert.equal(plays.length, 1); busy(button, true);
    assert.deepEqual(observed, [{ disabled: true, busy: 'true' }]);
    plays[0]!.resolve(); await flush(); busy(button, false); notice(h);
  });
}

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed reentrant leave and new playback retain the new gate after the original ${outcome}`, async t => {
    const h = await actualApp(t); await h.join({ role: 'audience' });
    const { plays, observed, callbacks } = controlledAudio(t, h), button = h.node('unlock');
    callbacks.onPlay = index => { if (index === 0) { h.leave.click(); button.invoke(); } };
    button.click(); assert.equal(plays.length, 2); busy(button, true);
    assert.deepEqual(observed, [{ disabled: true, busy: 'true' }, { disabled: true, busy: 'true' }]);
    if (outcome === 'resolve') plays[0]!.resolve(); else plays[0]!.reject('重入前的舊播放失敗。');
    await flush(); busy(button, true); notice(h); assert.equal(h.status.textContent, '已離開。');
    button.invoke(); assert.equal(plays.length, 2);
    plays[1]!.reject('重入後的目前播放失敗。'); await flush(); busy(button, false); notice(h, '重入後的目前播放失敗。');
  });
}

it('whole embed pending unlock has no timeout and can be retired by an explicit new entry', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(), plays = heldWork(t), button = h.node('unlock');
  sdk.unlockAudio = () => { const work = new Deferred(); plays.push(work); return work.promise; };
  const timers = h.clock.timers, metrics = h.clock.metrics; button.click(); busy(button, true);
  h.tick(10000); await flush(); busy(button, true); button.invoke(); assert.equal(plays.length, 1);
  assert.deepEqual(h.clock.timers, timers); assert.deepEqual(h.clock.metrics, metrics, 'unlock must not schedule polling or a timeout');
  h.form.submit(); busy(button, false); await flush(); assert.equal(h.clients.length, 2);
  plays[0]!.reject('沒有逾時的舊播放失敗。'); await flush(); busy(button, false); notice(h);
});

for (const onStage of [false, true]) {
  it(`whole embed actual SDK unlock leaves ${onStage ? 'speaker' : 'audience'} controls, wire and media unchanged`, async t => {
    const h = await actualApp(t), { socket, peer } = await h.join({ role: onStage ? 'speaker' : 'audience', onStage });
    await flush(); const { plays } = controlledAudio(t, h), button = h.node('unlock');
    const before = controls(h), frames = socket.sent.slice(), offers = peer.offers.slice(), replacements = peer.replacements.slice();
    const track = peer.transceiver.sender.track, captures = h.captures.length, media = {
      volume: h.audio.volume, muted: h.audio.muted, source: h.audio.srcObject, pauses: h.audio.pauses,
      contexts: StageContext.instances.length, direction: peer.transceiver.direction, enabled: track?.enabled,
    };
    button.click(); busy(button, true); button.invoke(); plays[0]!.resolve(); await flush(); busy(button, false);
    assert.deepEqual(controls(h), before); assert.deepEqual(socket.sent, frames); assert.deepEqual(peer.offers, offers);
    assert.deepEqual(peer.replacements, replacements); assert.equal(peer.transceiver.sender.track, track);
    assert.deepEqual({ volume: h.audio.volume, muted: h.audio.muted, source: h.audio.srcObject, pauses: h.audio.pauses,
      contexts: StageContext.instances.length, direction: peer.transceiver.direction, enabled: track?.enabled }, media);
    assert.equal(h.captures.length, captures); assert.equal(h.calls(), 0);
    assert.equal(StageSocket.instances.length, 1); assert.equal(StagePeer.instances.length, 1); assert.equal(peer.connectionState, 'connected');
  });
}
