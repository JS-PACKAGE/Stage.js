import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage } from '../shared/protocol.ts';
import { Deferred, EmbedSdk, embedApp, flush } from './fixtures/embedApp.ts';
import type { EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { FakeSession, harness } from './helpers.ts';

// Run the production embed and public SDK with controlled DOM, sockets and browser media.
// Hub cases relay actual control frames; the fixture supplies media answers. These tests
// establish ordering and copy, not native-browser gestures, audible output or AT behavior.
const shutdownNotice = '伺服器維護或重新啟動，房間已關閉。';
const closedNotice = '房間已關閉。';
interface View { node(id: string): EmbedNode }
type ActualApp = Awaited<ReturnType<typeof actualApp>>;
function notice(h: View, message?: string): void {
  assert.equal(h.node('error-notice').hidden, message === undefined);
  assert.equal(h.node('last-error').textContent, message === undefined ? '' : `最近錯誤：${message}`);
}
function busy(button: EmbedNode, pending: boolean): void {
  assert.equal(button.disabled, pending); assert.equal(button.attributes['aria-busy'], String(pending));
}
function retired(h: ActualApp): void {
  busy(h.form.submitButton!, false); busy(h.node('unlock'), false);
  assert.equal(h.node('cancel-join').hidden, true); assert.equal(h.node('cancel-join').disabled, true);
  assert.equal(h.leave.disabled, true); assert.equal(h.node('hand').disabled, true);
  assert.equal(h.node('hand').attributes['aria-busy'], 'false'); assert.equal(h.node('hand').textContent, '舉手發言');
  for (const id of ['rename', 'mic', 'stage', 'mic-retry']) {
    assert.equal(h.node(id).hidden, true, id); assert.equal(h.node(id).disabled, true, id);
    assert.equal(h.node(id).attributes['aria-busy'], 'false', id);
  }
  notice(h); assert.equal(h.audio.volume, 0.37); assert.equal(h.audio.muted, true);
}
function pendingPlayback(t: TestContext, h: ActualApp): Deferred {
  const work = new Deferred(); t.mock.method(h.audio, 'play', () => work.promise);
  t.after(() => { if (!work.settled) work.resolve(); });
  h.node('unlock').click(); busy(h.node('unlock'), true); return work;
}
function hello(socket: StageSocket): void {
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
}
function joinRequest(socket: StageSocket): Extract<ClientMessage, { type: 'join' }> {
  const request = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join');
  assert.ok(request); return request;
}
async function pendingJoin(t: TestContext) {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
  assert.ok(socket); hello(socket); await h.until(() => socket.sent.some(message => message.type === 'join'), 'join request');
  return { ...h, socket, request: joinRequest(socket) };
}

for (const terminal of ['shutdown', 'close', 'kick'] as const) {
  it(`whole embed actual Hub and public SDK distinguish ${terminal} while retaining terminal cleanup`, async t => {
    const server = harness(); t.after(async () => { await server.hub.shutdown(); await server.transport.close(); });
    const host = await server.create('Synthetic host'), guest = new FakeSession(); server.hub.attach(guest);
    const h = await actualApp(t);
    h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic listener';
    const inputs = ['host', 'ws-path', 'room', 'code', 'name'].map(id => h.node(id).value);
    h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
    for (const message of guest.inbox.splice(0)) socket.deliver(message);
    await h.until(() => socket.sent.some(message => message.type === 'join'), 'Hub join request');
    await server.hub.handle(guest, joinRequest(socket));
    for (const message of guest.inbox.splice(0)) socket.deliver(message);
    // The Hub's advertised pacing delays the fixture-answered offer behind the join.
    await flush(); await h.tick(100);
    await h.until(() => StagePeer.instances.at(-1)?.localDescription !== null
      && StagePeer.instances.at(-1)?.signalingState === 'stable', 'initial fixture negotiation');
    const client = h.clients[0]!, participantId = client.me!.participantId, peer = StagePeer.instances.at(-1)!;
    const events: unknown[] = [], cleanup: { status: string; me: unknown; notice: string }[] = [];
    client.on('status', ({ detail }) => { if (detail === 'disconnected') events.push('disconnected'); });
    for (const type of ['closed', 'kicked']) client.on(type, ({ detail }) => {
      events.push({ type, detail }); cleanup.push({ status: client.status, me: client.me, notice: h.status.textContent });
    });
    const playback = pendingPlayback(t, h);
    h.node('hand').click(); busy(h.node('hand'), true);
    h.node('name').value = 'Pending rename'; h.node('rename').click(); busy(h.node('rename'), true);
    await h.tick(200);
    const pending = socket.sent.filter(message => message.type === 'hand:raise' || message.type === 'participant:rename');
    assert.equal(pending.length, 2, 'control ACKs remain withheld at terminal delivery');
    socket.deliver({ type: 'error', code: 'internal', message: '終止前的操作錯誤。' }); notice(h, '終止前的操作錯誤。');
    if (terminal === 'shutdown') await server.hub.shutdown();
    else assert.equal(await server.req(host.s, terminal === 'close'
      ? { type: 'room:close' } : { type: 'participant:kick', targetId: participantId }), 'ok');
    const frame = guest.inbox.find(message => message.type === (terminal === 'kick' ? 'kicked' : 'room:closed'));
    assert.deepEqual(frame, terminal === 'kick' ? { type: 'kicked', roomId: host.roomId }
      : { type: 'room:closed', roomId: host.roomId, ...(terminal === 'shutdown' ? { reason: 'shutdown' } : {}) });
    for (const message of guest.inbox.splice(0)) socket.deliver(message); await flush();
    const expected = terminal === 'shutdown' ? shutdownNotice : terminal === 'close' ? closedNotice : '你已被主控移出房間。';
    assert.deepEqual(events, ['disconnected', { type: terminal === 'kick' ? 'kicked' : 'closed',
      detail: { roomId: host.roomId, ...(terminal === 'shutdown' ? { reason: 'shutdown' } : {}) } }]);
    assert.deepEqual(cleanup, [{ status: 'disconnected', me: null, notice: expected }]);
    assert.equal(h.status.textContent, expected); retired(h);
    assert.equal(socket.readyState, 3); assert.equal(peer.connectionState, 'closed');
    playback.reject('終止後的舊播放錯誤。');
    for (const request of pending) socket.deliver({ type: 'ok', requestId: request.requestId });
    socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
    socket.deliver({ type: 'error', code: 'internal', message: '終止後的舊 wire 錯誤。' });
    const wire = socket.sent.slice(); await flush(); await h.tick(30000);
    assert.equal(h.status.textContent, expected); retired(h); assert.deepEqual(socket.sent, wire);
    assert.equal(StageSocket.instances.length, 1); assert.equal(StagePeer.instances.length, 1);
    assert.equal(h.captures.length, 0); assert.equal(h.calls(), 0);
    assert.deepEqual(['host', 'ws-path', 'room', 'code'].map(id => h.node(id).value), inputs.slice(0, 4));
    assert.equal(h.node('name').value, 'Pending rename');
  });
}

for (const withState of [false, true]) {
  it(`whole embed defensive actual SDK shutdown before ACK ${withState ? 'after' : 'before'} first state keeps the explicit notice`, async t => {
    const h = await pendingJoin(t);
    // The normal Hub sends its join ACK before subsequent terminal frames; this ordering is defensive.
    if (withState) { h.socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); await flush(); }
    busy(h.form.submitButton!, true); assert.equal(h.node('cancel-join').hidden, withState);
    const playback = pendingPlayback(t, h);
    h.socket.deliver({ type: 'error', code: 'internal', message: '加入期間的錯誤。' }); notice(h, '加入期間的錯誤。');
    h.socket.deliver({ type: 'room:closed', roomId: 'same-room', reason: 'shutdown' }); await flush();
    assert.equal(h.status.textContent, shutdownNotice); retired(h);
    assert.equal(h.clients[0]!.status, 'disconnected'); assert.equal(h.clients[0]!.me, null);
    assert.equal(h.socket.readyState, 3); assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'));
    playback.reject('過期的加入播放錯誤。');
    h.socket.deliver({ type: 'ok', requestId: h.request.requestId });
    h.socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
    h.node('cancel-join').invoke(); await flush(); await h.tick(30000);
    assert.equal(h.status.textContent, shutdownNotice); retired(h);
    assert.equal(StageSocket.instances.length, 1); assert.equal(h.socket.sent.filter(message => message.type === 'join').length, 1);
    assert.equal(h.captures.length, 0); assert.equal(h.calls(), 0);
  });
}

for (const reason of ['Shutdown', '', '<img src=x onerror="alert(1)">shutdown'] as const) {
  it(`whole embed defensive unknown wire reason ${JSON.stringify(reason)} stays generic without rendering server text`, async t => {
    const h = await actualApp(t), { socket } = await h.join({ role: 'audience' }), details: unknown[] = [];
    const htmlWrites: unknown[] = [];
    for (const id of ['status', 'last-error']) Object.defineProperty(h.node(id), 'innerHTML', {
      set(value: unknown) { htmlWrites.push(value); },
    });
    h.clients[0]!.on('closed', ({ detail }) => details.push(detail));
    // Unknown future wire data is outside the current TypeScript union, not a new server reason.
    socket.onmessage?.({ data: JSON.stringify({ type: 'room:closed', roomId: 'same-room', reason }) });
    await flush();
    assert.deepEqual(details, [{ roomId: 'same-room', ...(reason ? { reason } : {}) }]); assert.deepEqual(htmlWrites, []);
    assert.equal(h.status.textContent, closedNotice); retired(h); assert.equal(StageSocket.instances.length, 1);
  });
}

it('whole embed does not infer shutdown from a generic error or an unexpected socket close', async t => {
  const h = await actualApp(t), { socket } = await h.join({ role: 'audience' });
  socket.deliver({ type: 'error', code: 'internal', message: 'shutdown' });
  assert.equal(h.status.textContent, 'shutdown'); notice(h, 'shutdown');
  socket.close(); await flush();
  assert.equal(h.status.textContent, '重新連線中'); notice(h, 'shutdown');
  assert.equal(h.clients[0]!.status, 'reconnecting'); assert.equal(StageSocket.instances.length, 1);
});

for (const cancelNew of [false, true]) {
  it(`whole embed actual SDK stale shutdown cannot retire reentrant ${cancelNew ? 'cancelled' : 'pending'} manual entry`, async t => {
    const h = await actualApp(t), { socket } = await h.join({ role: 'audience' }), old = h.clients[0]!;
    let reentered = false;
    old.on('status', ({ detail }) => {
      if (detail !== 'disconnected' || reentered) return;
      reentered = true; h.form.submit(); if (cancelNew) h.node('cancel-join').click();
    });
    socket.deliver({ type: 'room:closed', roomId: 'same-room', reason: 'shutdown' }); await flush();
    assert.equal(reentered, true); assert.equal(h.status.textContent, cancelNew ? '已取消連線。' : '連線中…');
    busy(h.form.submitButton!, !cancelNew); assert.equal(h.node('cancel-join').hidden, cancelNew); notice(h);
    assert.equal(StageSocket.instances.length, cancelNew ? 1 : 2);
    if (cancelNew) { h.form.submit(); await flush(); }
    const current = StageSocket.instances.at(-1)!; assert.notEqual(current, socket); hello(current);
    await h.until(() => current.sent.some(message => message.type === 'join'), 'fresh manual join');
    socket.deliver({ type: 'room:closed', roomId: 'same-room', reason: 'shutdown' });
    current.deliver({ type: 'room:state', ...actualState({ role: 'audience', name: '目前聽眾' }) });
    current.deliver({ type: 'ok', requestId: joinRequest(current).requestId }); await flush();
    assert.equal(h.status.textContent, '測試舞台 · 目前聽眾 · 收聽中'); busy(h.form.submitButton!, false);
    assert.equal(h.leave.disabled, false); assert.equal(current.sent.filter(message => message.type === 'join').length, 1);
    assert.equal(h.captures.length, 0); assert.equal(h.calls(), 0);
  });
}

it('whole embed defensive synthetic old entry rejection and shutdown cannot replace a fresh entry or its error', async t => {
  const connecting = new Deferred(), stopping = new Deferred(), connect = EmbedSdk.prototype.connect;
  let calls = 0;
  t.mock.method(EmbedSdk.prototype, 'connect', function (this: EmbedSdk): Promise<void> {
    if (++calls !== 1) return connect.call(this); this.setStatus('waiting'); return connecting.promise;
  });
  const h = embedApp();
  t.after(async () => {
    if (!connecting.settled) connecting.resolve(); if (!stopping.settled) stopping.resolve(); await h.cleanup();
  });
  h.form.submit(); await flush(); const old = h.clients[0]!;
  old.emit('closed', { roomId: 'same-room', reason: 'shutdown' });
  assert.equal(h.status.textContent, shutdownNotice); busy(h.submit, false); notice(h);
  connecting.reject('已終止的舊 connect 錯誤。'); await flush();
  assert.equal(h.status.textContent, shutdownNotice); notice(h);
  const disconnect = old.disconnect.bind(old);
  old.disconnect = async () => { await stopping.promise; await disconnect(); };
  h.form.submit(); const pendingNotice = h.status.textContent; busy(h.submit, true);
  old.emit('closed', { roomId: 'same-room', reason: 'shutdown' });
  old.emit('error', new Error('等待舊 disconnect 時的錯誤。'));
  assert.equal(h.clients.length, 1); assert.equal(h.status.textContent, pendingNotice);
  busy(h.submit, true); assert.equal(h.node('cancel-join').hidden, false); notice(h);
  stopping.resolve(); await flush(); const current = h.clients[1]!; current.snapshot();
  current.emit('error', new Error('目前連線的錯誤。'));
  old.emit('closed', { roomId: 'same-room', reason: 'shutdown' }); old.emit('error', new Error('被替換的舊錯誤。'));
  assert.equal(h.status.textContent, '目前連線的錯誤。'); notice(h, '目前連線的錯誤。');
  busy(h.submit, false); assert.equal(h.leave.disabled, false); assert.equal(current.joins.length, 1);
  assert.equal(h.clients.length, 2); assert.equal(h.moduleUrls.length, 2);
});
