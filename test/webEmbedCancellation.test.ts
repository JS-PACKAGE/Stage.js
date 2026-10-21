import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import type { ClientMessage } from '../shared/protocol.ts';
import { Deferred, EmbedNode, EmbedSdk, embedApp, flush } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket } from './fixtures/embedSdkApp.ts';

const cancelledNotice = '已取消連線。';
function cancelControl(node: EmbedNode, available: boolean): void {
  assert.equal(node.hidden, !available); assert.equal(node.disabled, !available);
  assert.equal(node.textContent, '取消連線');
}
function submission(node: EmbedNode, pending: boolean): void {
  assert.equal(node.disabled, pending); assert.equal(node.attributes['aria-busy'], String(pending));
}
async function start(t: TestContext) {
  const h = await actualApp(t), cancel = h.node('cancel-join'), submit = h.form.submitButton!;
  h.form.submit(); submission(submit, true); cancelControl(cancel, true); await flush();
  const socket = StageSocket.instances.at(-1)!; assert.ok(socket);
  return { ...h, cancel, submit, socket };
}
async function hello(h: Awaited<ReturnType<typeof start>>, socket = h.socket) {
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'join request');
  const request = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join');
  assert.ok(request); return request;
}
function dispatch(client: unknown, type: string, detail: unknown): void {
  (client as EventTarget).dispatchEvent(new CustomEvent(type, { detail }));
}
async function syntheticPending(t: TestContext) {
  const connecting = new Deferred(), connect = EmbedSdk.prototype.connect;
  let calls = 0;
  t.mock.method(EmbedSdk.prototype, 'connect', function (this: EmbedSdk): Promise<void> {
    if (++calls !== 1) return connect.call(this);
    this.setStatus('waiting'); return connecting.promise;
  });
  const h = embedApp();
  t.after(async () => { if (!connecting.settled) connecting.resolve(); await h.cleanup(); });
  h.form.submit(); await flush(); const retired = h.clients[0]!; assert.ok(retired);
  return { ...h, connecting, retired, cancel: h.node('cancel-join') };
}

it('whole embed declares an initially hidden native initial-entry cancellation button', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const button = html.match(/<button\b[^>]*\bid="cancel-join"[^>]*>[^<]*<\/button>/)?.[0];
  assert.ok(button, 'a disabled Join and pre-state Leave need a separate cancellation action');
  for (const attribute of ['type="button"', 'hidden', 'disabled']) assert.ok(button.includes(attribute), attribute);
  assert.match(button, />取消連線<\/button>$/); assert.doesNotMatch(button, /aria-(?:pressed|label)=|tabindex=/);
});

it('whole embed ignores hidden cancellation before entry and after an immediate pre-import cancellation', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const cancel = h.node('cancel-join');
  cancelControl(cancel, false); cancel.invoke(); assert.equal(h.status.textContent, '尚未加入');
  h.form.submit(); cancelControl(cancel, true); submission(h.submit, true);
  cancel.click(); cancelControl(cancel, false); submission(h.submit, false);
  assert.equal(h.status.textContent, cancelledNotice);
  cancel.invoke(); await flush();
  assert.equal(h.clients.length, 0); assert.equal(h.moduleUrls.length, 0);
  assert.equal(h.status.textContent, cancelledNotice); submission(h.submit, false);
});

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed cancels a pending host import and ignores its later ${outcome}`, async t => {
    const load = new Deferred(), h = embedApp({ libraryLoad: load.promise }), cancel = h.node('cancel-join');
    t.after(async () => { if (!load.settled) load.resolve(); await h.cleanup(); });
    h.form.submit(); await flush();
    assert.equal(h.status.textContent, '載入舞台元件中…'); assert.equal(h.clients.length, 0);
    assert.equal(h.leave.disabled, true); submission(h.submit, true); cancelControl(cancel, true);
    const inputs = ['host', 'room', 'code', 'name'].map(id => h.node(id).value);
    cancel.click(); cancelControl(cancel, false); submission(h.submit, false);
    assert.equal(h.status.textContent, cancelledNotice);
    if (outcome === 'resolve') load.resolve(); else load.reject('retired import failure');
    await flush(); h.tick(5000);
    assert.equal(h.clients.length, 0); assert.equal(h.status.textContent, cancelledNotice);
    assert.deepEqual(['host', 'room', 'code', 'name'].map(id => h.node(id).value), inputs);
    assert.equal(h.clock.timers.length, 0); cancelControl(cancel, false); submission(h.submit, false);
  });
}

it('whole embed allows explicit fresh submission while a cancelled import remains unresolved', async t => {
  const load = new Deferred(), h = embedApp({ libraryLoad: load.promise }), cancel = h.node('cancel-join');
  t.after(async () => { if (!load.settled) load.resolve(); await h.cleanup(); });
  h.form.submit(); await flush(); cancel.click(); h.form.submit();
  submission(h.submit, true); cancelControl(cancel, true); await flush();
  assert.equal(h.moduleUrls.length, 2); assert.equal(h.clients.length, 0);
  load.resolve(); await flush();
  assert.equal(h.clients.length, 1, 'cancelled import must not construct an SDK after the new attempt starts');
  assert.equal(h.clients[0]!.joins.length, 1); submission(h.submit, false); cancelControl(cancel, false);
  h.clients[0]!.snapshot(); assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中');
});

for (const phase of ['hello', 'join'] as const) {
  it(`whole embed actual SDK cancels pending ${phase} without waiting for a socket close callback`, async t => {
    const h = await start(t); if (phase === 'join') await hello(h);
    assert.equal(h.status.textContent, phase === 'hello' ? '連線中…' : '加入房間中…');
    assert.equal(h.leave.disabled, true); submission(h.submit, true); cancelControl(h.cancel, true);
    let closes = 0;
    // The real SDK must reject hello/ACK itself; no socket close event is delivered.
    t.mock.method(h.socket, 'close', () => { closes++; h.socket.readyState = 3; });
    h.cancel.click(); submission(h.submit, false); cancelControl(h.cancel, false);
    assert.equal(h.status.textContent, cancelledNotice); assert.equal(closes, 1);
    assert.equal(h.clients[0]!.status, 'disconnected'); assert.equal(h.clients[0]!.me, null);
    h.cancel.invoke(); await flush(); await h.tick(20000);
    assert.equal(closes, 1); assert.equal(StageSocket.instances.length, 1);
    assert.equal(h.socket.sent.filter(message => message.type === 'join').length, phase === 'join' ? 1 : 0);
    assert.equal(h.status.textContent, cancelledNotice); submission(h.submit, false);
    assert.equal(h.audio.volume, 0.37); assert.equal(h.audio.muted, true);
  });

  it(`whole embed actual SDK isolates cancelled ${phase} callbacks and permits immediate manual resubmission`, async t => {
    const h = await start(t), old = h.clients[0]!, retired = h.socket;
    const request = phase === 'join' ? await hello(h) : undefined;
    h.cancel.click(); h.form.submit(); submission(h.submit, true); cancelControl(h.cancel, true); await flush();
    const current = StageSocket.instances.at(-1)!; assert.notEqual(current, retired);
    const notice = h.status.textContent;
    retired.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
    if (request) retired.deliver({ type: 'ok', requestId: request.requestId });
    retired.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
    for (const [event, detail] of [
      ['error', new Error('retired SDK error')], ['audioblocked', undefined],
      ['state', actualState({ role: 'audience' })], ['status', 'disconnected'],
      ['closed', { roomId: 'same-room' }], ['kicked', { roomId: 'same-room' }],
      ['micerror', { name: 'NotAllowedError', message: 'retired microphone error' }], ['micready', undefined],
    ] as const) dispatch(old, event, detail);
    await flush(); assert.equal(h.status.textContent, notice); submission(h.submit, true); cancelControl(h.cancel, true);
    const next = await hello(h, current);
    current.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
    current.deliver({ type: 'ok', requestId: next.requestId }); await flush();
    assert.equal(h.status.textContent, '測試舞台 · 測試主控 · 收聽中'); submission(h.submit, false); cancelControl(h.cancel, false);
    current.deliver({ type: 'error', code: 'internal', message: '目前的音訊錯誤。' });
    assert.equal(h.status.textContent, '目前的音訊錯誤。', 'current genuine SDK errors must still be visible');
  });
}

it('whole embed actual SDK hides initial cancellation at state-before-ACK while retaining Leave', async t => {
  const h = await start(t), request = await hello(h);
  h.socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); await flush();
  submission(h.submit, true); cancelControl(h.cancel, false); assert.equal(h.leave.disabled, false);
  const notice = h.status.textContent; h.cancel.invoke();
  assert.equal(h.socket.readyState, 1); assert.equal(h.status.textContent, notice);
  h.socket.deliver({ type: 'error', code: 'internal', message: '目前狀態後的錯誤。' });
  assert.equal(h.status.textContent, '目前狀態後的錯誤。');
  h.socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  assert.equal(h.status.textContent, '目前狀態後的錯誤。'); cancelControl(h.cancel, false); submission(h.submit, false);
  h.leave.click(); await flush(); assert.equal(h.status.textContent, '已離開。');
});

it('whole embed latches an actual SDK snapshot during status before a reentrant disconnect hides the snapshot', async t => {
  const h = await start(t); await hello(h); const current = h.clients[0]!;
  current.on('status', ({ detail }) => {
    if (detail !== 'live') return;
    cancelControl(h.cancel, false);
    void current.disconnect();
    h.cancel.invoke();
  });
  h.socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); await flush();
  assert.equal(current.me, null); cancelControl(h.cancel, false);
  assert.notEqual(h.status.textContent, cancelledNotice);
  h.cancel.invoke(); assert.notEqual(h.status.textContent, cancelledNotice);
});

it('whole embed never revives initial cancellation when an established SDK reconnects or loses its snapshot', async t => {
  const h = await start(t), request = await hello(h), current = h.clients[0]!;
  h.socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
  h.socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  cancelControl(h.cancel, false); submission(h.submit, false);
  h.socket.close(); assert.equal(current.status, 'reconnecting');
  cancelControl(h.cancel, false); h.cancel.invoke(); assert.equal(current.status, 'reconnecting');
  assert.equal(h.status.textContent, '重新連線中');
  await current.disconnect(); assert.equal(current.me, null); cancelControl(h.cancel, false);
  h.cancel.invoke(); assert.equal(h.status.textContent, '未連線');
});

it('whole embed finishes ACK-without-state with manual submission available and no persistent cancellation action', async t => {
  const h = await start(t), request = await hello(h);
  h.socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  assert.equal(h.status.textContent, '加入請求已完成，尚未收到房間狀態。');
  submission(h.submit, false); cancelControl(h.cancel, false); assert.equal(h.leave.disabled, true);
  h.cancel.invoke(); assert.equal(h.socket.readyState, 1);
  h.socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); await flush();
  assert.equal(h.leave.disabled, false); cancelControl(h.cancel, false);
});

for (const terminal of ['closed', 'shutdown', 'kicked'] as const) {
  it(`whole embed actual SDK preserves pre-state ${terminal} and never offers cancellation afterward`, async t => {
    const h = await start(t); await hello(h);
    // Defensive protocol ordering, not the normal hub's terminal-after-ACK sequence.
    h.socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
      : { type: 'room:closed', roomId: 'same-room', ...(terminal === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
    await flush();
    const expected = terminal === 'kicked' ? '你已被主控移出房間。' : terminal === 'shutdown' ? '伺服器維護或重新啟動，房間已關閉。' : '房間已關閉。';
    assert.equal(h.status.textContent, expected); cancelControl(h.cancel, false); submission(h.submit, false);
    h.cancel.invoke(); assert.equal(h.status.textContent, expected); assert.equal(h.leave.disabled, true);
  });
}

for (const terminal of ['closed', 'kicked'] as const) for (const cancelNew of [false, true]) {
  it(`whole embed actual SDK old ${terminal} cannot retire a reentrant ${cancelNew ? 'cancelled' : 'pending'} fresh entry`, async t => {
    const h = await start(t), request = await hello(h), old = h.clients[0]!;
    h.socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
    h.socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
    let reentered = false;
    old.on('status', ({ detail }) => {
      if (detail !== 'disconnected' || reentered) return;
      reentered = true; h.form.submit(); submission(h.submit, true); cancelControl(h.cancel, true);
      if (cancelNew) { h.cancel.click(); submission(h.submit, false); assert.equal(h.status.textContent, cancelledNotice); }
    });
    // The SDK emits the terminal event only after awaiting disconnect, whose status listener
    // above can synchronously begin and even cancel a different attempt.
    h.socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
      : { type: 'room:closed', roomId: 'same-room' });
    await flush(); assert.equal(reentered, true);
    if (cancelNew) {
      assert.equal(h.status.textContent, cancelledNotice); submission(h.submit, false); cancelControl(h.cancel, false);
      assert.equal(StageSocket.instances.length, 1, 'cancelled entry must not construct another socket');
      h.form.submit(); await flush();
    } else {
      assert.equal(h.status.textContent, '連線中…'); submission(h.submit, true); cancelControl(h.cancel, true);
    }
    const current = StageSocket.instances.at(-1)!; assert.notEqual(current, h.socket);
    const next = await hello(h, current);
    current.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
    current.deliver({ type: 'ok', requestId: next.requestId }); await flush();
    assert.equal(h.status.textContent, '測試舞台 · 測試主控 · 收聽中'); submission(h.submit, false); cancelControl(h.cancel, false);
  });
}

for (const failure of ['host', 'library', 'hello', 'join'] as const) {
  it(`whole embed preserves genuine ${failure} failure while removing initial cancellation`, async t => {
    if (failure === 'host' || failure === 'library') {
      const load = new Deferred(), h = embedApp({ libraryLoad: load.promise });
      t.after(async () => { if (!load.settled) load.resolve(); await h.cleanup(); });
      if (failure === 'host') h.node('host').value = 'ftp://stage.example.test';
      h.form.submit(); await flush(); if (failure === 'library') load.reject('目前載入失敗。'); await flush();
      assert.equal(h.status.textContent, failure === 'host' ? '請輸入 HTTP 或 HTTPS 主機網址。' : '目前載入失敗。');
      cancelControl(h.node('cancel-join'), false); submission(h.submit, false); return;
    }
    const h = await start(t);
    if (failure === 'hello') await h.tick(15000);
    else {
      const request = await hello(h);
      h.socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' });
      await flush();
    }
    assert.equal(h.status.textContent, failure === 'hello' ? '連線逾時，請稍後再試。' : '房間不存在或代碼錯誤。');
    cancelControl(h.cancel, false); submission(h.submit, false);
  });
}

it('whole embed keeps pre-cancel audio rejection retired while a new manual audio failure stays visible', async t => {
  const load = new Deferred(), play = new Deferred(), h = embedApp({ libraryLoad: load.promise });
  t.after(async () => { if (!load.settled) load.resolve(); if (!play.settled) play.resolve(); await h.cleanup(); });
  h.node('audio').play = () => play.promise;
  h.form.submit(); await flush(); h.node('unlock').click(); h.node('cancel-join').click();
  play.reject('retired playback failure'); await flush(); assert.equal(h.status.textContent, cancelledNotice);
  h.node('audio').play = () => Promise.reject(new Error('目前播放失敗。'));
  h.node('unlock').click(); await flush(); assert.equal(h.status.textContent, '目前播放失敗。');
});

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed cancels a new entry while synthetic previous-client teardown remains pending until ${outcome}`, async t => {
    const h = embedApp(), stopping = new Deferred();
    t.after(async () => { if (!stopping.settled) stopping.resolve(); await h.cleanup(); });
    const previous = await h.join(), disconnect = previous.disconnect.bind(previous);
    previous.disconnect = () => { previous.disconnect = disconnect; return stopping.promise; };
    h.form.submit(); submission(h.submit, true); cancelControl(h.node('cancel-join'), true);
    h.node('cancel-join').click(); submission(h.submit, false); cancelControl(h.node('cancel-join'), false);
    assert.equal(h.status.textContent, cancelledNotice);
    if (outcome === 'resolve') stopping.resolve(); else stopping.reject('retired previous-client teardown failure');
    await flush();
    assert.equal(h.status.textContent, cancelledNotice); assert.equal(h.clients.length, 1); assert.equal(h.moduleUrls.length, 1);
    submission(h.submit, false); cancelControl(h.node('cancel-join'), false);
    const current = await h.join(); assert.notEqual(current, previous);
    assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中');
  });

  it(`whole embed defensively isolates synthetic late ${outcome} after cancellation with immediate reentry`, async t => {
    const h = await syntheticPending(t), stopping = new Deferred(), disconnect = h.retired.disconnect.bind(h.retired);
    t.after(() => { if (!stopping.settled) stopping.resolve(); });
    // This SDK double intentionally permits deferred settlement after disconnect; the real SDK
    // rejects pending hello/requests synchronously and is verified separately above.
    h.retired.disconnect = () => { h.retired.disconnect = disconnect; return stopping.promise; };
    h.cancel.click(); submission(h.submit, false); cancelControl(h.cancel, false);
    assert.equal(h.status.textContent, cancelledNotice);
    h.form.submit(); submission(h.submit, true); await flush();
    assert.equal(h.clients.length, 2); h.clients[1]!.snapshot();
    const notice = h.status.textContent;
    if (outcome === 'resolve') { stopping.resolve(); h.connecting.resolve(); }
    else { stopping.reject('retired synthetic cleanup failure'); h.connecting.reject('retired synthetic hello failure'); }
    await flush();
    assert.equal(h.status.textContent, notice); assert.equal(h.retired.joins.length, 0);
    assert.equal(h.clients[1]!.joins.length, 1); submission(h.submit, false); cancelControl(h.cancel, false);
  });
}

for (const outcome of ['throw', 'reject'] as const) {
  it(`whole embed reports current synthetic cancellation cleanup ${outcome} without keeping submission busy`, async t => {
    const h = await syntheticPending(t), disconnect = h.retired.disconnect.bind(h.retired);
    h.retired.disconnect = () => {
      h.retired.disconnect = disconnect;
      if (outcome === 'throw') throw new Error('目前中止連線失敗。');
      return Promise.reject(new Error('目前中止連線失敗。'));
    };
    h.cancel.click(); submission(h.submit, false); cancelControl(h.cancel, false); await flush();
    assert.equal(h.status.textContent, '目前中止連線失敗。');
    h.connecting.reject('retired synthetic hello failure'); await flush();
    assert.equal(h.status.textContent, '目前中止連線失敗。');
    h.form.submit(); await flush(); assert.equal(h.clients.length, 2); h.clients[1]!.snapshot();
    assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中');
  });

  it(`whole embed retires its cancellation hook before synthetic disconnect reenters and ${outcome}s`, async t => {
    const h = await syntheticPending(t), disconnect = h.retired.disconnect.bind(h.retired);
    let stops = 0;
    h.retired.disconnect = () => {
      stops++; cancelControl(h.cancel, false); submission(h.submit, false);
      h.cancel.invoke(); assert.equal(stops, 1, 'double invocation cannot start another cancellation');
      h.retired.disconnect = disconnect;
      h.form.submit(); submission(h.submit, true); cancelControl(h.cancel, true);
      if (outcome === 'throw') throw new Error('retired reentrant cleanup failure');
      return Promise.reject(new Error('retired reentrant cleanup failure'));
    };
    h.cancel.click(); submission(h.submit, true); cancelControl(h.cancel, true); await flush();
    assert.equal(h.clients.length, 2); h.clients[1]!.snapshot();
    h.connecting.reject('retired synthetic hello failure'); await flush();
    assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中');
    assert.equal(h.retired.joins.length, 0); assert.equal(stops, 1); submission(h.submit, false); cancelControl(h.cancel, false);
  });
}
