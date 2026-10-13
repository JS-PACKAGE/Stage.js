import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { it, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ClientMessage, ParticipantView, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { Deferred, EmbedNode, flush } from './fixtures/embedApp.ts';

interface EntryClient extends EventTarget {
  readonly status: string;
  readonly state: RoomStatePayload | null;
  readonly me: ParticipantView | null;
  disconnect(): Promise<void>;
}
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data) as ClientMessage); }
  deliver(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  close(): void { this.readyState = 3; this.onclose?.(); }
}
class Peer {
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = null;
  private rejectOffer: ((error: Error) => void) | undefined;
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as unknown, async replaceTrack(track: unknown) { this.track = track; } } };
  }
  // Keep the unrelated media negotiation pending until normal SDK cleanup closes its peer.
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  close(): void { this.connectionState = 'closed'; this.rejectOffer?.(new Error('test peer closed')); }
}
const state = (name = '測試舞台'): RoomStatePayload => ({
  roomId: 'same-room', name, controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
  codeRequired: true, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
  me: { participantId: 'guest', name: '測試聽眾', role: 'audience', onStage: false, handRaised: false,
    muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 },
});
const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
function assertSubmission(submit: EmbedNode, pending: boolean): void {
  assert.equal(submit.disabled, pending);
  assert.equal(submit.attributes['aria-busy'], String(pending));
}

async function fixture(t: TestContext, options: { deferLibrary?: boolean } = {}) {
  // Keep browser-only SDK types out of the server test compilation while executing the real SDK.
  const { StageClient, decodeName } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  Socket.instances = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const nodes = new Map(['host', 'room', 'code', 'name', 'status', 'join', 'hand', 'mic', 'leave', 'audio', 'unlock'].map(id => [id, new EmbedNode()]));
  const node = (id: string): EmbedNode => { const found = nodes.get(id); assert.ok(found); return found; };
  const form = node('join'), submit = new EmbedNode(), status = node('status'), leave = node('leave'), hand = node('hand');
  form.submitButton = submit; node('name').value = ' 測試聽眾 ';
  status.textContent = '尚未加入'; hand.disabled = leave.disabled = true;
  Object.assign(node('audio'), { pause() {} });
  const clients: EntryClient[] = [], loads: Deferred[] = [];
  const library = {
    StageClient: function (options: unknown): EntryClient { const client: EntryClient = new StageClient(options); clients.push(client); return client; },
    decodeName,
  };
  const dynamicImport = 'import(/* @vite-ignore */ moduleUrl)';
  assert.equal(source.split(dynamicImport).length, 2);
  assert.equal(source.split("import './styles.css';").length, 2);
  const executable = stripTypeScriptTypes(source.replace("import './styles.css';", '').replace(dynamicImport, 'loadLibrary(moduleUrl)'));
  assert.doesNotMatch(executable, /\bimport\s*(?:\(|['"])/);
  runInNewContext(executable, {
    document: { querySelector(selector: string) { assert.match(selector, /^#[a-z]+$/); return node(selector.slice(1)); } },
    location: { search: '?room=same-room&code=TEST42', origin: 'https://stage.example.test' },
    URL, URLSearchParams, Error, Promise, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    loadLibrary: async (url: string) => {
      assert.equal(url, 'https://stage.example.test/lib/stage-client.js');
      if (options.deferLibrary) { const work = new Deferred(); loads.push(work); await work.promise; }
      return library;
    },
  }, { filename: 'web/src/embed.ts', timeout: 1000 });
  const tick = async (ms = 0) => { now += ms; t.mock.timers.tick(ms); await flush(); };
  t.after(async () => {
    try {
      for (const load of loads) if (!load.settled) load.reject('test cleanup');
      await flush();
      for (const client of clients) await client.disconnect();
      await flush();
      assert.ok(clients.every(client => client.status === 'disconnected' && client.state === null));
      assert.ok(Socket.instances.every(socket => socket.readyState === 3));
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return {
    node, form, submit, status, hand, leave, clients, loads, tick,
    async start(): Promise<Socket> { form.submit(); assertSubmission(submit, true); await flush(); const socket = Socket.instances.at(-1); assert.ok(socket); return socket; },
    async hello(socket: Socket): Promise<Extract<ClientMessage, { type: 'join' }>> {
      socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
      await flush(); await tick();
      const request = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join');
      assert.ok(request); return request;
    },
  };
}

it('whole embed reports deferred library, hello and join progress without delaying state-before-ACK controls', async t => {
  const h = await fixture(t, { deferLibrary: true });
  h.form.submit(); assertSubmission(h.submit, true); await flush();
  assert.equal(h.status.textContent, '載入舞台元件中…'); assert.equal(h.clients.length, 0);
  await h.tick(1200);
  assert.equal(h.status.textContent, '載入舞台元件中…'); assertSubmission(h.submit, true);
  assert.equal(h.hand.disabled, true); assert.equal(h.leave.disabled, true);
  h.loads[0]!.resolve(); await flush();
  const socket = Socket.instances[0]!;
  assert.equal(h.status.textContent, '連線中…'); assert.deepEqual(socket.sent, []);
  await h.tick(1200);
  assert.equal(h.status.textContent, '連線中…'); assertSubmission(h.submit, true);
  const request = await h.hello(socket);
  assert.equal(h.status.textContent, '加入房間中…'); assertSubmission(h.submit, true);
  await h.tick(1200);
  assert.equal(h.status.textContent, '加入房間中…'); assert.equal(h.leave.disabled, true);
  socket.deliver({ type: 'room:state', ...state() }); await flush();
  assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中'); assertSubmission(h.submit, true);
  assert.equal(h.hand.disabled, false); assert.equal(h.leave.disabled, false);
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中'); assertSubmission(h.submit, false);
});

it('whole embed finishes an acknowledged join without a snapshot and accepts a later state', async t => {
  const h = await fixture(t), socket = await h.start(), request = await h.hello(socket);
  // Normal hub ordering sends state first; a separately hosted SDK/server can deliver ACK first.
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  assert.equal(h.status.textContent, '加入請求已完成，尚未收到房間狀態。'); assertSubmission(h.submit, false);
  assert.equal(h.leave.disabled, true); assert.equal(h.hand.disabled, true);
  socket.deliver({ type: 'room:state', ...state() }); await flush();
  assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中'); assertSubmission(h.submit, false);
  assert.equal(h.leave.disabled, false); assert.equal(h.hand.disabled, false);
});

for (const phase of ['library', 'hello'] as const) {
  it(`whole embed preserves current unlock failure during ${phase} over later join progress and completion`, async t => {
    const h = await fixture(t, { deferLibrary: phase === 'library' });
    t.mock.method(h.node('audio'), 'play', () => Promise.reject(new Error('目前播放失敗。')));
    h.form.submit(); await flush(); assertSubmission(h.submit, true);
    h.node('unlock').click(); await flush();
    assert.equal(h.status.textContent, '目前播放失敗。');
    if (phase === 'library') { h.loads[0]!.resolve(); await flush(); }
    assert.equal(h.status.textContent, '目前播放失敗。'); assertSubmission(h.submit, true);
    const socket = Socket.instances[0]!, request = await h.hello(socket);
    assert.equal(h.status.textContent, '目前播放失敗。'); assertSubmission(h.submit, true);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
    assert.equal(h.status.textContent, '目前播放失敗。'); assertSubmission(h.submit, false);
  });
}

it('whole embed starts fresh progress after current unlock feedback without retired cleanup clearing busy', async t => {
  const h = await fixture(t, { deferLibrary: true });
  t.mock.method(h.node('audio'), 'play', () => Promise.reject(new Error('目前播放失敗。')));
  h.form.submit(); await flush(); h.loads[0]!.resolve(); await flush();
  const retired = Socket.instances[0]!;
  h.node('unlock').click(); await flush();
  assert.equal(h.status.textContent, '目前播放失敗。'); assertSubmission(h.submit, true);
  h.form.submit(); await flush();
  assert.equal(retired.readyState, 3);
  assert.equal(h.status.textContent, '載入舞台元件中…'); assertSubmission(h.submit, true);
  h.loads[1]!.resolve(); await flush();
  const current = Socket.instances[1]!;
  assert.equal(h.status.textContent, '連線中…'); assertSubmission(h.submit, true);
  const request = await h.hello(current);
  assert.equal(h.status.textContent, '加入房間中…'); assertSubmission(h.submit, true);
  current.deliver({ type: 'room:state', ...state('新房間') });
  current.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  assert.equal(h.status.textContent, '新房間 · 測試聽眾 · 收聽中'); assertSubmission(h.submit, false);
});

for (const notice of ['state', 'error', 'micerror', 'audioblocked'] as const) {
  it(`whole embed preserves ${notice} received before the connect continuation over later progress and ACK`, async t => {
    const h = await fixture(t), socket = await h.start();
    // Deliver public feedback before the resolved hello continuation can publish its next phase.
    // The early snapshot is defensive event ordering, not the normal hub's join/state sequence.
    const joining = h.hello(socket);
    if (notice === 'state') socket.deliver({ type: 'room:state', ...state() });
    else if (notice === 'error') socket.deliver({ type: 'error', code: 'internal', message: '目前的連線通知。' });
    else h.clients[0]!.dispatchEvent(new CustomEvent(notice, { detail: notice === 'micerror'
      ? { name: 'NotAllowedError', message: '麥克風尚未授權。' } : { message: 'blocked' } }));
    const expected = { state: '測試舞台 · 測試聽眾 · 收聽中', error: '目前的連線通知。',
      micerror: '麥克風尚未授權。（NotAllowedError）', audioblocked: '請點擊啟用音訊。' }[notice];
    assert.equal(h.status.textContent, expected);
    const request = await joining;
    assert.equal(h.status.textContent, expected); assertSubmission(h.submit, true);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
    assert.equal(h.status.textContent, expected); assertSubmission(h.submit, false);
  });
}

for (const phase of ['hello', 'join'] as const) {
  it(`whole embed releases busy state and preserves its current ${phase} deadline error`, async t => {
    const h = await fixture(t), socket = await h.start();
    if (phase === 'join') await h.hello(socket);
    await h.tick(14999);
    assert.equal(h.status.textContent, phase === 'hello' ? '連線中…' : '加入房間中…');
    assertSubmission(h.submit, true);
    await h.tick(1);
    assert.equal(h.status.textContent, phase === 'hello' ? '連線逾時，請稍後再試。' : '請求逾時，請重試。');
    assertSubmission(h.submit, false);
  });
}

it('whole embed with actual SDK preserves Leave after a state-before-ACK join cancellation', async t => {
  const h = await fixture(t), socket = await h.start(); await h.hello(socket);
  // Hub sends the snapshot before the join ACK; Leave becomes a real enabled control in between.
  socket.deliver({ type: 'room:state', ...state() }); await flush();
  assert.equal(h.leave.disabled, false); assertSubmission(h.submit, true);
  h.leave.click(); await flush();
  assert.equal(h.status.textContent, '已離開。'); assertSubmission(h.submit, false);
  assert.equal(h.hand.disabled, true); assert.equal(h.leave.disabled, true); assert.equal(h.clients[0]!.state, null);
});

for (const terminal of ['closed', 'shutdown', 'kicked'] as const) {
  for (const acknowledged of [false, true]) {
    it(`whole embed actual SDK keeps ${terminal} feedback ${acknowledged ? 'after ACK' : 'under defensive pre-ACK event delivery'}`, async t => {
      const h = await fixture(t), socket = await h.start(), request = await h.hello(socket);
      socket.deliver({ type: 'room:state', ...state() }); await flush();
      if (acknowledged) { socket.deliver({ type: 'ok', requestId: request.requestId }); await flush(); }
      // Current hub queues ok before later server terminal frames. Pre-ACK terminal delivery
      // is defensive public-protocol coverage, not a claimed normal server ordering.
      socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
        : { type: 'room:closed', roomId: 'same-room', ...(terminal === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
      await flush();
      assert.equal(h.status.textContent, terminal === 'kicked' ? '你已被主控移出房間。' : '房間已關閉。');
      assertSubmission(h.submit, false); assert.equal(h.hand.disabled, true); assert.equal(h.leave.disabled, true);
    });
  }
}

for (const failure of ['host', 'library', 'connect', 'join'] as const) {
  it(`whole embed retains a current pre-state ${failure} failure and releases submission for retry`, async t => {
    const h = await fixture(t, { deferLibrary: failure === 'library' });
    if (failure === 'host') h.node('host').value = 'ftp://stage.example.test';
    h.form.submit(); await flush();
    if (failure === 'library') { h.loads[0]!.reject('載入舞台程式失敗。'); await flush(); }
    if (failure === 'connect') { Socket.instances[0]!.onerror?.(); await flush(); }
    if (failure === 'join') {
      const socket = Socket.instances[0]!, request = await h.hello(socket);
      socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' }); await flush();
    }
    assert.equal(h.status.textContent, { host: '請輸入 HTTP 或 HTTPS 主機網址。', library: '載入舞台程式失敗。', connect: '無法連線至舞台。', join: '房間不存在或代碼錯誤。' }[failure]);
    assertSubmission(h.submit, false);
  });
}

it('whole embed retains current SDK errors and join rejection after receiving state', async t => {
  const h = await fixture(t), socket = await h.start(), request = await h.hello(socket);
  socket.deliver({ type: 'room:state', ...state() }); await flush();
  socket.deliver({ type: 'error', code: 'internal', message: '目前的音訊連線失敗。' }); await flush();
  assert.equal(h.status.textContent, '目前的音訊連線失敗。'); assertSubmission(h.submit, true);
  socket.deliver({ type: 'error', requestId: request.requestId, code: 'internal', message: '目前的加入請求失敗。' }); await flush();
  assert.equal(h.status.textContent, '目前的加入請求失敗。'); assertSubmission(h.submit, false);
});

for (const phase of ['hello', 'join'] as const) {
  it(`whole embed replacement during ${phase} isolates the retired catch/finally and socket callbacks`, async t => {
    const h = await fixture(t), retired = await h.start();
    if (phase === 'join') await h.hello(retired);
    const current = await h.start(); assert.notEqual(current, retired);
    assertSubmission(h.submit, true);
    const notice = h.status.textContent;
    retired.deliver({ type: 'room:state', ...state('過期房間') }); retired.onerror?.(); retired.onclose?.(); await flush();
    assert.equal(h.status.textContent, notice); assertSubmission(h.submit, true);
    const request = await h.hello(current); current.deliver({ type: 'room:state', ...state('新房間') });
    current.deliver({ type: 'ok', requestId: request.requestId }); await flush();
    assert.equal(h.status.textContent, '新房間 · 測試聽眾 · 收聽中'); assertSubmission(h.submit, false);
  });
}

it('whole embed immediate reentry after Leave prevents retired leave feedback and finally from changing the new entry', async t => {
  const h = await fixture(t), retired = await h.start(); await h.hello(retired);
  retired.deliver({ type: 'room:state', ...state() }); await flush();
  h.leave.click(); h.form.submit(); await flush();
  assertSubmission(h.submit, true); assert.notEqual(h.status.textContent, '已離開。');
  const current = Socket.instances.at(-1)!; assert.notEqual(current, retired);
  const request = await h.hello(current); current.deliver({ type: 'room:state', ...state('新房間') });
  current.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  assert.equal(h.status.textContent, '新房間 · 測試聽眾 · 收聽中'); assertSubmission(h.submit, false);
});

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed isolates a retired library ${outcome} while a replacement connection remains pending`, async t => {
    const h = await fixture(t, { deferLibrary: true });
    h.form.submit(); await flush(); h.form.submit(); await flush(); assert.equal(h.loads.length, 2);
    h.loads[1]!.resolve(); await flush(); assert.equal(h.clients.length, 1);
    const notice = h.status.textContent;
    if (outcome === 'resolve') h.loads[0]!.resolve(); else h.loads[0]!.reject('過期載入失敗。');
    await flush(); assert.equal(h.clients.length, 1); assertSubmission(h.submit, true); assert.equal(h.status.textContent, notice);
    const current = Socket.instances[0]!, request = await h.hello(current);
    current.deliver({ type: 'room:state', ...state() }); current.deliver({ type: 'ok', requestId: request.requestId }); await flush();
    assertSubmission(h.submit, false); assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中');
  });
}

it('whole embed checks ownership after disconnect and hello awaits before constructing or joining', async t => {
  const h = await fixture(t);
  h.form.submit(); h.form.submit(); await flush();
  assert.equal(h.clients.length, 1, 'only the newest synchronous form event reaches library construction');
  const retired = Socket.instances[0]!;
  retired.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
  h.form.submit(); await flush(); await h.tick();
  assert.equal(h.clients.length, 2); assert.deepEqual(retired.sent, []);
  assertSubmission(h.submit, true);
});
