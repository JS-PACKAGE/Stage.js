import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage } from '../shared/protocol.ts';
import { Deferred, EmbedNode, EmbedSdk, embedApp, flush } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket } from './fixtures/embedSdkApp.ts';

type Fields = Record<'host' | 'ws-path' | 'room' | 'code' | 'name', string>;
type Payload = { roomId: string; code?: string; name: string };
type Boundary = 'previous disconnect' | 'library import' | 'connect';
type Form = { node(id: string): EmbedNode };
const submitted: Fields = {
  host: 'https://original.example.test/prefix', 'ws-path': '/original/signal',
  room: '  original-room  ', code: '  SYNTH42  ', name: '  原始 聽眾  ',
};
const edited: Fields = {
  host: 'https://edited.example.test/other', 'ws-path': '/edited/signal',
  room: '  edited-room  ', code: '  SYNTH84  ', name: '  下次 聽眾  ',
};
const firstPayload: Payload = { roomId: 'original-room', code: 'SYNTH42', name: '原始 聽眾' };
const nextPayload: Payload = { roomId: 'edited-room', code: 'SYNTH84', name: '下次 聽眾' };
function fill(h: Form, fields: Fields): void {
  for (const [id, value] of Object.entries(fields)) h.node(id).value = value;
}
function visible(h: Form, fields: Fields): void {
  for (const [id, value] of Object.entries(fields)) {
    assert.equal(h.node(id).value, value, `${id} keeps the visitor's next-attempt edit`);
    assert.equal(h.node(id).disabled, false, `${id} remains editable`);
  }
}
function joined(client: EmbedSdk, payload: Payload): void {
  assert.deepEqual(client.joins.map(value => ({ ...value })), [payload]);
}
function entry(h: Form & { form: EmbedNode }, pending: boolean, cancellable = pending): void {
  const submit = h.form.submitButton!, cancel = h.node('cancel-join');
  assert.equal(submit.disabled, pending); assert.equal(submit.attributes['aria-busy'], String(pending));
  assert.equal(cancel.hidden, !cancellable); assert.equal(cancel.disabled, !cancellable);
}
async function boundaryApp(t: TestContext, phase: Boundary) {
  const gate = new Deferred();
  const h = embedApp({ libraryLoad: async (_url, attempt) => {
    if (phase === 'library import' && attempt === 1) await gate.promise;
  } });
  t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  if (phase === 'connect') {
    const connect = EmbedSdk.prototype.connect; let calls = 0;
    t.mock.method(EmbedSdk.prototype, 'connect', function (this: EmbedSdk): Promise<void> {
      if (++calls !== 1) return connect.call(this);
      this.setStatus('waiting'); return gate.promise;
    });
  }
  const previous = phase === 'previous disconnect' ? await h.join() : undefined;
  if (previous) {
    const disconnect = previous.disconnect.bind(previous);
    // The retired SDK may settle much later; the next explicit attempt can disconnect normally.
    previous.disconnect = () => { previous.disconnect = disconnect; return gate.promise; };
  }
  return { ...h, gate, previous };
}

for (const phase of ['previous disconnect', 'library import', 'connect'] as const) {
  it(`whole embed snapshots all submitted fields across deferred ${phase} and captures edits only on the next submission`, async t => {
    const h = await boundaryApp(t, phase); fill(h, submitted); h.form.submit(); await flush();
    entry(h, true); visible(h, submitted);
    assert.equal(h.clients.length, phase === 'library import' ? 0 : 1);
    assert.equal(h.moduleUrls.length, 1);
    if (phase === 'connect') assert.equal(h.clients[0]!.joins.length, 0);
    fill(h, edited); visible(h, edited); h.gate.resolve(); await flush();
    const current = h.clients.at(-1)!;
    assert.equal(current.options.url, 'wss://original.example.test/original/signal');
    assert.equal(h.moduleUrls.at(-1), 'https://original.example.test/lib/stage-client.js');
    joined(current, firstPayload); visible(h, edited); entry(h, false);
    const count = h.clients.length; h.tick(5000); await flush();
    assert.equal(h.clients.length, count, 'editing does not trigger an implicit attempt');
    joined(current, firstPayload);
    h.form.submit(); entry(h, true); await flush();
    const next = h.clients.at(-1)!; assert.notEqual(next, current);
    assert.equal(h.clients.length, count + 1);
    assert.equal(next.options.url, 'wss://edited.example.test/edited/signal');
    assert.equal(h.moduleUrls.at(-1), 'https://edited.example.test/lib/stage-client.js');
    joined(next, nextPayload); joined(current, firstPayload); visible(h, edited); entry(h, false);
  });
}

it('whole embed snapshots credentials before previous disconnect can synchronously edit the form', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const previous = await h.join();
  const disconnect = previous.disconnect.bind(previous);
  previous.disconnect = () => { fill(h, edited); return disconnect(); };
  fill(h, submitted); h.form.submit(); visible(h, edited); await flush();
  assert.equal(h.clients.length, 2); joined(h.clients[1]!, firstPayload);
  assert.equal(h.clients[1]!.options.url, 'wss://original.example.test/original/signal');
  assert.equal(h.moduleUrls[1], 'https://original.example.test/lib/stage-client.js'); visible(h, edited);
});

for (const [label, code, expected] of [
  ['absent', undefined, undefined], ['blank', ' \t\n ', undefined],
  ['encoded query', ' \tSYNTH+42%2F\n ', 'SYNTH+42%2F'],
] as const) {
  it(`whole embed snapshots trimmed query-prefilled room and ${label} code without rewriting the fields`, async t => {
    const gate = new Deferred(), params = new URLSearchParams({
      host: submitted.host, wsPath: submitted['ws-path'], room: ' \troom+one%2F\n ',
    });
    if (code !== undefined) params.set('code', code);
    const h = embedApp({ search: `?${params}`, libraryLoad: gate.promise });
    t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
    h.node('name').value = ' \t前後 空白\n ';
    assert.equal(h.node('room').value, ' \troom+one%2F\n ');
    assert.equal(h.node('code').value, code ?? '');
    h.form.submit(); await flush(); fill(h, edited); gate.resolve(); await flush();
    joined(h.clients[0]!, { roomId: 'room+one%2F', code: expected, name: '前後 空白' });
    assert.equal(h.clients[0]!.options.url, 'wss://original.example.test/original/signal'); visible(h, edited);
  });
}

for (const phase of ['previous disconnect', 'library import', 'connect'] as const) {
  for (const settlement of ['resolve', 'reject'] as const) {
    it(`whole embed cancels a submitted snapshot during ${phase} and isolates its late ${settlement} from a fresh edited attempt`, async t => {
      const h = await boundaryApp(t, phase); fill(h, submitted); h.form.submit(); await flush();
      const retired = phase === 'connect' ? h.clients[0] : undefined;
      fill(h, edited); h.node('cancel-join').click(); entry(h, false);
      assert.equal(h.status.textContent, '已取消連線。'); visible(h, edited);
      h.form.submit(); entry(h, true); await flush();
      const current = h.clients.at(-1)!; assert.notEqual(current, retired); assert.notEqual(current, h.previous);
      joined(current, nextPayload); assert.equal(current.options.url, 'wss://edited.example.test/edited/signal');
      assert.equal(h.moduleUrls.at(-1), 'https://edited.example.test/lib/stage-client.js');
      current.snapshot(); const notice = h.status.textContent, count = h.clients.length, loads = h.moduleUrls.length;
      fill(h, submitted);
      if (settlement === 'resolve') h.gate.resolve(); else h.gate.reject('retired synthetic attempt failure');
      await flush(); h.tick(5000); await flush();
      assert.equal(h.clients.length, count); assert.equal(h.moduleUrls.length, loads);
      assert.equal(h.status.textContent, notice); joined(current, nextPayload);
      assert.equal(retired?.joins.length ?? 0, 0, 'a late old connect must not join with either snapshot');
      visible(h, submitted); entry(h, false);
    });
  }
}

class DestinationSocket extends StageSocket {
  readonly url: string;
  constructor(url: string) { super(); this.url = url; }
}
async function sdkApp(t: TestContext) {
  const h = await actualApp(t);
  // Reuse the fixture's protocol/media behavior while recording the real SDK's chosen destination.
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: DestinationSocket });
  return h;
}
async function hello(h: Awaited<ReturnType<typeof actualApp>>, socket: StageSocket) {
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
    limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'submitted join frame');
  const request = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join');
  assert.ok(request); return request;
}
function wirePayload(request: Extract<ClientMessage, { type: 'join' }>): Record<string, unknown> {
  const { type, requestId, ...payload } = request;
  assert.equal(type, 'join'); assert.equal(typeof requestId, 'string'); return payload;
}

for (const blankCode of [false, true]) {
  it(`whole embed actual SDK sends the submitted destination and ${blankCode ? 'omitted blank' : 'trimmed'} code after delayed hello despite visible edits`, async t => {
    const h = await sdkApp(t), fields = { ...submitted, host: 'https://stage.example.test/original',
      code: blankCode ? ' \t ' : submitted.code };
    fill(h, fields); h.form.submit(); await flush();
    const socket = StageSocket.instances[0]; assert.ok(socket instanceof DestinationSocket);
    assert.equal(socket.url, 'wss://stage.example.test/original/signal');
    assert.equal(socket.sent.length, 0); entry(h, true); fill(h, edited); visible(h, edited);
    await h.tick(1200); assert.equal(socket.sent.length, 0);
    const request = await hello(h, socket);
    assert.deepEqual(wirePayload(request), blankCode
      ? { roomId: firstPayload.roomId, name: firstPayload.name } : firstPayload);
    assert.equal(Object.hasOwn(request, 'code'), !blankCode);
    assert.equal(socket.sent.filter(message => message.type === 'join').length, 1);
    socket.deliver({ type: 'room:state', ...actualState({ role: 'audience', name: firstPayload.name }), roomId: firstPayload.roomId });
    await flush(); entry(h, true, false); assert.equal(h.leave.disabled, false);
    h.node('cancel-join').invoke(); assert.equal(socket.readyState, StageSocket.OPEN);
    assert.equal(h.status.textContent, '測試舞台 · 原始 聽眾 · 收聽中'); visible(h, edited);
    h.leave.click(); await flush(); entry(h, false);
    assert.equal(h.status.textContent, '已離開。'); assert.equal(h.leave.disabled, true); assert.equal(socket.readyState, 3);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
    assert.equal(h.status.textContent, '已離開。'); assert.equal(StageSocket.instances.length, 1);
    assert.equal(socket.sent.filter(message => message.type === 'join').length, 1); visible(h, edited);
    // The fixture's import is pinned to its synthetic host; a fresh path/payload still proves a new snapshot.
    const nextFields = { ...edited, host: 'https://stage.example.test/edited' }; fill(h, nextFields);
    h.form.submit(); await flush(); const next = StageSocket.instances[1]; assert.ok(next instanceof DestinationSocket);
    assert.equal(next.url, 'wss://stage.example.test/edited/signal');
    const nextRequest = await hello(h, next); assert.deepEqual(wirePayload(nextRequest), nextPayload);
    next.deliver({ type: 'ok', requestId: nextRequest.requestId }); await flush(); entry(h, false); visible(h, nextFields);
  });
}

for (const terminal of ['closed', 'shutdown', 'kicked'] as const) {
  it(`whole embed actual SDK preserves ${terminal} before the submitted join ACK without joining visible edits`, async t => {
    const h = await sdkApp(t); fill(h, { ...submitted, host: 'https://stage.example.test' });
    h.form.submit(); await flush(); const socket = StageSocket.instances[0]; assert.ok(socket instanceof DestinationSocket);
    fill(h, edited); const request = await hello(h, socket); assert.deepEqual(wirePayload(request), firstPayload);
    socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }), roomId: firstPayload.roomId });
    await flush(); entry(h, true, false); assert.equal(h.leave.disabled, false);
    socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: firstPayload.roomId }
      : { type: 'room:closed', roomId: firstPayload.roomId, ...(terminal === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
    await flush(); const expected = terminal === 'kicked' ? '你已被主控移出房間。' : terminal === 'shutdown' ? '伺服器維護或重新啟動，房間已關閉。' : '房間已關閉。';
    assert.equal(h.status.textContent, expected); entry(h, false); assert.equal(h.leave.disabled, true);
    h.node('cancel-join').invoke(); socket.deliver({ type: 'ok', requestId: request.requestId }); await flush(); await h.tick(20000);
    assert.equal(h.status.textContent, expected); assert.equal(StageSocket.instances.length, 1);
    assert.equal(socket.sent.filter(message => message.type === 'join').length, 1); visible(h, edited); entry(h, false);
  });
}
