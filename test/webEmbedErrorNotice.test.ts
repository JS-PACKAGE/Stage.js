import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { ClientMessage } from '../shared/protocol.ts';
import { Deferred, EmbedSdk, embedApp, flush } from './fixtures/embedApp.ts';
import type { EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { FakeSession, harness } from './helpers.ts';

// Execute the whole production embed and public SDK with controlled DOM, socket and
// RTCPeerConnection doubles. Hub cases manually relay control frames; media answers are
// fixture-generated. These tests do not establish native-browser SDP or audible playback.
interface NoticeView { node(id: string): EmbedNode }
function notice(h: NoticeView, message?: string): void {
  assert.equal(h.node('error-notice').hidden, message === undefined);
  assert.equal(h.node('last-error').textContent, message === undefined ? '' : `最近錯誤：${message}`);
}
function controls(h: NoticeView) {
  return ['join', 'hand', 'mic', 'rename', 'stage', 'mic-retry', 'cancel-join', 'leave', 'unlock'].map(id => {
    const node = h.node(id);
    return { id, hidden: node.hidden, disabled: node.disabled, text: node.textContent, attributes: { ...node.attributes } };
  });
}
function request(socket: StageSocket): Extract<ClientMessage, { type: 'join' }> {
  const join = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join');
  assert.ok(join); return join;
}
const hello = (socket: StageSocket): void => socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
  limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });

it('whole embed declares a separate initially hidden last-error alert and native dismiss button', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const section = html.match(/<(?:div|section)\b[^>]*\bid="error-notice"[^>]*>[\s\S]*?<\/(?:div|section)>/)?.[0];
  assert.ok(section); assert.match(section, /^<[^>]*\bhidden(?:\s|>)/);
  assert.match(section, /<p\b[^>]*\bid="last-error"[^>]*\brole="alert"[^>]*><\/p>/);
  const dismiss = section.match(/<button\b[^>]*\bid="error-dismiss"[^>]*>[^<]+<\/button>/)?.[0];
  assert.ok(dismiss); assert.match(dismiss, /\btype="button"/); assert.doesNotMatch(dismiss, /\bdisabled\b|tabindex=/);
  assert.ok(html.indexOf(section) > html.indexOf('</form>'), 'dismissing an error cannot submit the join form');
  assert.match(html, /<p\b[^>]*\bid="status"[^>]*\baria-live="polite"/);
});

it('whole embed renders the latest generic error as safe text without replacing the existing status contract', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); notice(h);
  const sdk = await h.join(), message = '<img src=x onerror="alert(1)"> & <script>unexpected()</script>';
  for (const id of ['status', 'last-error']) Object.defineProperty(h.node(id), 'innerHTML', {
    set() { assert.fail(`${id} must never render an error as HTML`); },
  });
  sdk.emit('error', new Error(message));
  assert.equal(h.status.textContent, message); notice(h, message);
  sdk.emit('error', { message: 'untrusted non-Error object' });
  assert.equal(h.status.textContent, '操作失敗。'); notice(h, '操作失敗。');
  sdk.emit('error', new Error('下一個操作失敗。')); notice(h, '下一個操作失敗。');
});

it('whole embed retains the last error through normal snapshots, statuses, audio prompts and successful actions', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  sdk.emit('error', new Error('先前操作失敗。')); notice(h, '先前操作失敗。');
  sdk.snapshot(); assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中'); notice(h, '先前操作失敗。');
  h.hand.click(); sdk.actions[0]!.work.resolve(); await flush(); notice(h, '先前操作失敗。');
  sdk.emit('audioblocked', undefined); assert.equal(h.status.textContent, '請點擊啟用音訊。'); notice(h, '先前操作失敗。');
  h.node('unlock').click(); await flush(); notice(h, '先前操作失敗。');
  for (const state of ['reconnecting', 'live', 'waiting', 'disconnected'] as const) {
    sdk.setStatus(state); notice(h, '先前操作失敗。');
  }
  assert.equal(h.status.textContent, '未連線');
});

it('whole embed dismiss only clears the alert, preserving status, input, controls and pending work', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  sdk.emit('error', new Error('保留原本狀態。')); h.hand.click();
  const before = controls(h), timers = h.clock.timers, status = h.status.textContent;
  const submission = { disabled: h.submit.disabled, attributes: { ...h.submit.attributes } };
  const inputs = ['host', 'ws-path', 'room', 'code', 'name'].map(id => h.node(id).value);
  h.node('error-dismiss').click(); notice(h);
  assert.equal(h.status.textContent, status); assert.deepEqual(controls(h), before);
  assert.deepEqual({ disabled: h.submit.disabled, attributes: { ...h.submit.attributes } }, submission);
  assert.deepEqual(h.clock.timers, timers); assert.equal(sdk.actions.length, 1); assert.equal(sdk.actions[0]!.work.settled, false);
  assert.equal(h.clients.length, 1); assert.equal(h.moduleUrls.length, 1); assert.equal(sdk.retryCalls, 0);
  assert.deepEqual(['host', 'ws-path', 'room', 'code', 'name'].map(id => h.node(id).value), inputs);
  h.node('error-dismiss').invoke(); notice(h); assert.equal(h.status.textContent, status);
  sdk.actions[0]!.work.reject('關閉提示後的新錯誤。'); await flush(); notice(h, '關閉提示後的新錯誤。');
});

for (const action of ['hand', 'mic', 'stage', 'rename', 'unlock'] as const) {
  it(`whole embed records ${action} promise failures without silently clearing them on later success`, async t => {
    const h = embedApp(); t.after(() => h.cleanup());
    const sdk = await h.join(action === 'hand' ? {} : { role: 'speaker', onStage: true }); sdk.setStatus('live');
    const audio = new Deferred(); sdk.unlockAudio = () => audio.promise;
    h.node(action).click();
    const work = action === 'unlock' ? audio : action === 'rename' ? sdk.renames.at(-1)!.work : sdk.actions.at(-1)!.work;
    work.reject(`${action} 操作失敗。`); await flush();
    assert.equal(h.status.textContent, `${action} 操作失敗。`); notice(h, `${action} 操作失敗。`);
    sdk.snapshot(); notice(h, `${action} 操作失敗。`);
    if (action === 'hand') { h.tick(1500); }
    if (action === 'unlock') sdk.unlockAudio = async () => {};
    h.node(action).click();
    if (action !== 'unlock') (action === 'rename' ? sdk.renames.at(-1)!.work : sdk.actions.at(-1)!.work).resolve();
    await flush(); notice(h, `${action} 操作失敗。`);
  });
}

it('whole embed reports pre-client playback failure and clears it synchronously at a fresh submission', async t => {
  const loading = new Deferred(), h = embedApp({ libraryLoad: loading.promise });
  t.after(async () => { if (!loading.settled) loading.resolve(); await h.cleanup(); });
  h.node('audio').play = () => Promise.reject(new Error('尚未加入的音訊失敗。'));
  h.node('unlock').click(); await flush(); notice(h, '尚未加入的音訊失敗。');
  h.form.submit(); notice(h); await flush();
  assert.equal(h.status.textContent, '載入舞台元件中…'); notice(h);
  loading.reject('目前載入舞台元件失敗。'); await flush();
  assert.equal(h.status.textContent, '目前載入舞台元件失敗。'); notice(h, '目前載入舞台元件失敗。');
});

for (const invalid of ['host', 'ws-path'] as const) {
  it(`whole embed replaces the old alert with the current ${invalid} validation failure`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join();
    old.emit('error', new Error('舊操作失敗。'));
    h.node(invalid).value = invalid === 'host' ? 'ftp://stage.example.test' : '//other.example.test/ws';
    h.form.submit(); notice(h); await flush();
    const expected = invalid === 'host' ? '請輸入 HTTP 或 HTTPS 主機網址。' : '請輸入有效的同主機 WebSocket 路徑（例如 /ws）。';
    assert.equal(h.status.textContent, expected); notice(h, expected);
    old.emit('error', new Error('舊 SDK 不得覆寫驗證錯誤。')); old.emit('closed', {}); old.emit('kicked', {});
    notice(h, expected); assert.equal(h.status.textContent, expected);
    assert.equal(h.clients.length, 1); assert.equal(h.moduleUrls.length, 1); assert.equal(h.submit.disabled, false);
  });
}

it('whole embed cancellation clears the alert and retires old error events and pending entry rejection', async t => {
  const connecting = new Deferred(); t.mock.method(EmbedSdk.prototype, 'connect', function (this: EmbedSdk) {
    this.setStatus('waiting'); return connecting.promise;
  });
  const h = embedApp(); t.after(async () => { if (!connecting.settled) connecting.resolve(); await h.cleanup(); });
  h.form.submit(); await flush(); const old = h.clients[0]!;
  old.emit('error', new Error('仍在加入的錯誤。')); notice(h, '仍在加入的錯誤。');
  h.node('cancel-join').click(); notice(h); assert.equal(h.status.textContent, '已取消連線。');
  old.emit('error', new Error('已取消的 SDK 錯誤。')); connecting.reject('已取消的 connect 錯誤。'); await flush();
  notice(h); assert.equal(h.status.textContent, '已取消連線。');
  old.unlockAudio = () => Promise.reject(new Error('取消後手動音訊錯誤。'));
  h.node('unlock').click(); await flush(); notice(h, '取消後手動音訊錯誤。');
  old.emit('closed', {}); old.emit('kicked', {}); notice(h, '取消後手動音訊錯誤。');
});

for (const terminal of ['leave', 'closed', 'kicked'] as const) {
  it(`whole embed ${terminal} clears the alert and prevents retired callbacks from repopulating or clearing it`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join();
    h.hand.click(); const pending = old.actions[0]!.work;
    old.emit('error', new Error('終止前的錯誤。')); notice(h, '終止前的錯誤。');
    if (terminal === 'leave') h.leave.click(); else old.emit(terminal, {});
    notice(h); await flush();
    const status = terminal === 'leave' ? '已離開。' : terminal === 'closed' ? '房間已關閉。' : '你已被主控移出房間。';
    assert.equal(h.status.textContent, status);
    old.emit('error', new Error('終止後的舊錯誤。')); pending.reject('終止後的舊操作。'); await flush();
    notice(h); assert.equal(h.status.textContent, status);
    old.unlockAudio = () => Promise.reject(new Error('終止後手動音訊錯誤。'));
    h.node('unlock').click(); await flush(); notice(h, '終止後手動音訊錯誤。');
    old.emit('closed', {}); old.emit('kicked', {}); notice(h, '終止後手動音訊錯誤。');
  });
}

it('whole embed isolates old client events, action rejection and playback rejection from a replacement alert', async t => {
  const h = embedApp(), playback = new Deferred();
  t.after(async () => { if (!playback.settled) playback.resolve(); await h.cleanup(); });
  const old = await h.join(); h.hand.click(); const pending = old.actions[0]!.work;
  old.unlockAudio = () => playback.promise; h.node('unlock').click();
  old.emit('error', new Error('舊錯誤。')); const current = await h.join(); notice(h);
  current.emit('error', new Error('新連線的錯誤。'));
  for (const [event, detail] of [
    ['error', new Error('舊 SDK 錯誤。')], ['closed', {}], ['kicked', {}],
    ['micerror', { name: 'NotAllowedError', message: '舊麥克風錯誤。' }], ['micready', undefined],
  ] as const) old.emit(event, detail);
  old.snapshot(); old.setStatus('disconnected'); pending.reject('舊舉手錯誤。'); playback.reject('舊音訊錯誤。');
  await flush(); notice(h, '新連線的錯誤。'); assert.equal(h.status.textContent, '新連線的錯誤。');
  assert.equal(h.clients.length, 2); assert.equal(current.actions.length, 0);
});

it('whole embed retires old generic and terminal events while a new entry awaits that same client disconnect', async t => {
  const h = embedApp(), stopping = new Deferred();
  t.after(async () => { if (!stopping.settled) stopping.resolve(); await h.cleanup(); });
  const old = await h.join(), disconnect = old.disconnect.bind(old);
  old.disconnect = async () => { await stopping.promise; await disconnect(); };
  old.emit('error', new Error('先前錯誤。')); h.form.submit(); notice(h);
  assert.equal(h.clients.length, 1); assert.equal(h.submit.disabled, true);
  old.emit('error', new Error('舊 SDK 在 await disconnect 期間的錯誤。'));
  old.emit('closed', {}); old.emit('kicked', {}); notice(h);
  assert.equal(h.submit.disabled, true, 'an old terminal must not retire the new entry');
  stopping.resolve(); await flush(); assert.equal(h.clients.length, 2); notice(h);
  h.clients[1]!.emit('error', new Error('目前 SDK 錯誤。')); notice(h, '目前 SDK 錯誤。');
  old.emit('error', new Error('已替換 SDK 錯誤。')); notice(h, '目前 SDK 錯誤。');
});

for (const [code, message] of [['unauthorized', 'Cannot join room'], ['not_found', 'Not found'], ['room_full', 'Room is full']] as const) {
  it(`whole embed actual SDK retains ${code} automatic-resume failure after status becomes disconnected`, async t => {
    const h = await actualApp(t), { socket, peer } = await h.join({ role: 'audience', onStage: false }), client = h.clients[0]!;
    notice(h); const feedback: { event: string; text: string }[] = [];
    client.on('error', ({ detail }) => feedback.push({ event: `error:${(detail as { code: string }).code}`, text: h.status.textContent }));
    client.on('status', ({ detail }) => feedback.push({ event: `status:${detail}`, text: h.status.textContent }));
    socket.close(); await flush(); assert.equal(client.status, 'reconnecting'); assert.equal(h.status.textContent, '重新連線中');
    assert.equal(peer.connectionState, 'connected'); await h.tick(500);
    const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket); hello(resumed);
    await h.until(() => resumed.sent.some(message => message.type === 'join'), 'automatic resume request');
    const join = request(resumed); assert.equal(join.resumeToken, 'test-resume');
    resumed.deliver({ type: 'error', requestId: join.requestId, code, message }); await flush();
    assert.equal(client.status, 'disconnected'); assert.equal(client.me, null); assert.equal(h.status.textContent, '未連線'); notice(h, message);
    assert.ok(feedback.some(item => item.event === `error:${code}` && item.text === message));
    assert.deepEqual(feedback.at(-1), { event: 'status:disconnected', text: '未連線' });
    assert.equal(h.leave.disabled, true); assert.equal(h.form.submitButton!.disabled, false);
    assert.equal(h.node('cancel-join').hidden, true); assert.equal(StagePeer.instances.length, 1); assert.equal(peer.connectionState, 'closed');
    await h.tick(30000); notice(h, message);
    assert.equal(StageSocket.instances.length, 2, 'recording a terminal error must not restart automatic reconnect');
    assert.equal(h.captures.length, 0, 'a listener error must not request microphone access');
    h.node('error-dismiss').click(); notice(h); assert.equal(h.status.textContent, '未連線');
  });
}

for (const reason of ['code rotated', 'room removed'] as const) {
  it(`whole embed actual Hub and SDK preserve generic resume privacy after ${reason}`, async t => {
    const server = harness(); t.after(() => server.hub.shutdown());
    const host = await server.create('Synthetic host'), guest = new FakeSession(); server.hub.attach(guest);
    const h = await actualApp(t);
    h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic listener';
    h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
    for (const message of guest.inbox.splice(0)) socket.deliver(message);
    await h.until(() => socket.sent.some(message => message.type === 'join'), 'initial SDK join');
    await server.hub.handle(guest, request(socket));
    for (const message of guest.inbox.splice(0)) socket.deliver(message);
    // The Hub advertises 20 controls/s, so the SDK paces its first offer 100 ms after join.
    await flush(); await h.tick(100);
    await h.until(() => StagePeer.instances.at(-1)?.localDescription !== null && StagePeer.instances.at(-1)?.signalingState === 'stable', 'initial media');
    const client = h.clients[0]!; assert.ok(client.me); assert.equal(client.me.role, 'audience'); notice(h);
    await server.hub.detach(guest);
    assert.equal(await server.req(host.s, { type: reason === 'code rotated' ? 'room:rotate-code' : 'room:close' }), 'ok');
    socket.close(); await flush(); await h.tick(500);
    const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
    const back = new FakeSession(); server.hub.attach(back);
    for (const message of back.inbox.splice(0)) resumed.deliver(message);
    await h.until(() => resumed.sent.some(message => message.type === 'join'), 'automatic SDK resume');
    const resume = request(resumed); assert.equal(resume.roomId, host.roomId); assert.equal(resume.code, host.code); assert.ok(resume.resumeToken);
    await server.hub.handle(back, resume); const error = back.last('error'); assert.ok(error);
    assert.equal(error.code, 'unauthorized'); assert.equal(error.message, 'Cannot join room');
    for (const message of back.inbox.splice(0)) resumed.deliver(message);
    assert.equal(h.status.textContent, 'Cannot join room'); notice(h, 'Cannot join room');
    await flush(); assert.equal(client.status, 'disconnected'); assert.equal(client.me, null);
    assert.equal(h.status.textContent, '未連線'); notice(h, 'Cannot join room');
    assert.equal(h.node('code').value, host.code, 'the last error does not infer a new room code');
    assert.equal(h.form.submitButton!.disabled, false); assert.equal(h.leave.disabled, true);
    await h.tick(30000); notice(h, 'Cannot join room');
    assert.equal(StageSocket.instances.length, 2); assert.equal(StagePeer.instances.length, 1); assert.equal(h.captures.length, 0);
    assert.equal(resumed.sent.filter(message => message.type === 'join').length, 1, 'only the SDK-owned resume is attempted');
  });
}

for (const previousGeneric of [false, true]) {
  it(`whole embed actual microphone failure and recovery ${previousGeneric ? 'retain the existing generic alert' : 'never create a generic alert'}`, async t => {
    const h = await actualApp(t, { deferCapture: true }), { socket, peer } = await h.join({ role: 'audience' });
    if (previousGeneric) socket.deliver({ type: 'error', code: 'internal', message: '先前音訊安裝錯誤。' });
    notice(h, previousGeneric ? '先前音訊安裝錯誤。' : undefined);
    socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) });
    await h.until(() => h.captures.length === 1, 'initial microphone capture');
    h.captures[0]!.reject(new DOMException('controlled microphone denial', 'NotAllowedError'));
    await h.until(() => !h.micRetry.hidden, 'microphone retry control');
    assert.match(h.status.textContent, /NotAllowedError/); notice(h, previousGeneric ? '先前音訊安裝錯誤。' : undefined);
    await h.tick(5000); assert.equal(h.captures.length, 1, 'displaying an error must not retry the microphone');
    h.micRetry.click(); await h.until(() => h.captures.length === 2, 'explicit retry');
    const track = h.captures[1]!.resolve();
    await h.until(() => peer.transceiver.sender.track === track, 'recovered microphone installation');
    assert.equal(h.status.textContent, '已取得麥克風。'); notice(h, previousGeneric ? '先前音訊安裝錯誤。' : undefined);
    assert.equal(h.ready(), 1); assert.equal(h.calls(), 1); assert.equal(StageSocket.instances.length, 1); assert.equal(StagePeer.instances.length, 1);
  });
}
