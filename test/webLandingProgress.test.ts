import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type Action = 'create' | 'join';
type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'find' | 'id' | 'button'>;
interface Form { form: SampleNode; submit: SampleNode }
type Forms = Record<Action, Form>;
const label = (action: Action) => action === 'create' ? '正在建立房間…' : '正在加入房間…';
const opposite = (action: Action): Action => action === 'create' ? 'join' : 'create';
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
const notices = (h: View) => h.find(node => node.classList.contains('notices'));
function forms(h: View): Forms {
  const find = (heading: string, values: Record<string, string>): Form => {
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === heading));
    const submit = form.descendants().find(node => node.tagName === 'button' && node.type === 'submit');
    assert.ok(submit);
    for (const [name, value] of Object.entries(values)) {
      const input = form.descendants().find(node => node.tagName === 'input' && node.name === name);
      assert.ok(input); input.value = value;
    }
    return { form, submit };
  };
  return { create: find('建立房間', { name: '測試主控', roomName: '測試舞台', token: 'private-token' }),
    join: find('加入房間', { roomId: 'same-room', code: 'PRIVATE42', name: '測試聽眾' }) };
}
function assertLocked(landing: Forms, pending: boolean): void {
  assert.deepEqual(Object.values(landing).map(({ submit }) => submit.disabled), [pending, pending]);
  assert.deepEqual(Object.values(landing).map(({ submit }) => submit.attributes['aria-busy']), [String(pending), String(pending)]);
  assert.deepEqual(Object.values(landing).map(({ submit }) => submit.textContent), ['建立並進入', '加入收聽']);
}
function assertProgress(h: View, action?: Action): SampleNode {
  const node = h.id('landing-progress');
  assert.equal(node.tagName, 'p'); assert.equal(node.dataset.landingProgress, 'true');
  assert.equal(node.attributes.role, 'status'); assert.equal(node.attributes['aria-live'], 'polite');
  assert.equal(h.app.descendants().filter(item => item.dataset.landingProgress !== undefined).length, 1);
  assert.equal(node.hidden, action === undefined); assert.equal(node.textContent, action ? label(action) : '');
  assert.equal(node.children.length, 0, 'progress is safe text, not HTML or user input');
  assert.notEqual(node, errorBox(h)); assert.notEqual(node, notices(h));
  const cancel = h.id('landing-cancel'), siblings = node.parentNode!.children;
  assert.equal(cancel.parentNode, node.parentNode); assert.equal(siblings.indexOf(node) + 1, siblings.indexOf(cancel));
  return node;
}
function assertCancel(h: View, available: boolean): SampleNode {
  const cancel = h.id('landing-cancel');
  assert.equal(cancel.textContent, '取消連線'); assert.equal(cancel.type, 'button');
  assert.equal(cancel.hidden, !available); assert.equal(cancel.disabled, !available); return cancel;
}
interface Request { type: string; requestId: string }
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  closeCalls = 0;
  readonly sent: Request[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string): void { assert.equal(this.readyState, Socket.OPEN); this.sent.push(JSON.parse(data) as Request); }
  deliver(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello(): void {
    this.readyState = Socket.OPEN;
    this.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  }
  // Deliberately stall the close handshake to exercise SDK local cancellation.
  close(): void { this.closeCalls++; this.readyState = 2; }
}
class Peer {
  static instances: Peer[] = [];
  connectionState = 'new'; signalingState = 'stable'; localDescription = null;
  private rejectOffer: ((error: Error) => void) | undefined;
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return { direction: 'recvonly', sender: { track: null as unknown,
    async replaceTrack(track: unknown): Promise<void> { this.track = track; } } }; }
  // Browser media is a double; the production SDK closes this unrelated pending negotiation.
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  async getStats(): Promise<Map<string, unknown>> { return new Map(); }
  close(): void { this.connectionState = 'closed'; this.rejectOffer?.(new Error('fixture peer closed')); }
}
interface ActualClient {
  readonly state: unknown;
  readonly status: string;
  disconnect(): Promise<void>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
async function actual(t: TestContext, location?: URL) {
  // Execute the public SDK unchanged without importing DOM types into this server-test project.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const target = new EventTarget();
  const globals = { window: target, WebSocket: Socket, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { enumerateDevices: async () => [],
      getUserMedia: async () => { throw new Error('fixture has no microphone hardware'); } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Socket.instances = []; Peer.instances = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
  // Request pacing and timeout deadlines must use the same deterministic advancing clock.
  t.mock.method(performance, 'now', () => Date.now());
  const sdk: ActualClient = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    audioElement: { volume: 1, muted: false, pause() {} } });
  const h = sampleApp({ sdk, ...(location ? { location } : {}) });
  const errors: unknown[] = []; sdk.on('error', ({ detail }) => errors.push(detail));
  t.after(async () => {
    try {
      await h.cleanup();
      assert.equal(sdk.state, null); assert.equal(sdk.status, 'disconnected');
      assert.equal(getEventListeners(target, 'pagehide').length, 0);
      assert.ok(Socket.instances.every(socket => socket.closeCalls === 1));
      assert.ok(Peer.instances.every(peer => peer.connectionState === 'closed'));
      assert.equal(h.clock.jobs.size, 0);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return { ...h, errors,
    start(action: Action) {
      const landing = forms(h); landing[action].form.submit();
      assertLocked(landing, true); assertProgress(h, action); assertCancel(h, true);
      const socket = Socket.instances.at(-1)!; assert.ok(socket); return { landing, socket };
    },
    async hello(socket: Socket, action: Action): Promise<Request> {
      socket.hello(); await flushSample(); t.mock.timers.tick(0);
      assert.equal(socket.sent.length, 1); const request = socket.sent[0]!;
      assert.equal(request.type, action === 'create' ? 'room:create' : 'join'); return request;
    },
  };
}
function acknowledge(socket: Socket, action: Action, request: Request): void {
  if (action === 'create') socket.deliver({ type: 'room:created', roomId: 'same-room', code: 'FRESH42' });
  socket.deliver({ type: 'ok', requestId: request.requestId });
}
function snapshot(socket: Socket, action: Action): void {
  const state = roomState(action === 'create' ? { role: 'controller', onStage: false } : {});
  if (action === 'create') { state.controllerId = state.me.participantId; state.codeRequired = true; }
  socket.deliver({ type: 'room:state', ...state });
}

it('whole sample actual SDK never shows landing progress or opens a socket for invalid wsPath submissions', async t => {
  const h = await actual(t, new URL('https://sample.test/?wsPath=https%3A%2F%2Fother.invalid%2Fws'));
  const landing = forms(h); assertProgress(h); assertCancel(h, false); assertLocked(landing, false);
  for (const action of ['create', 'join'] as const) {
    landing[action].form.submit(); assertProgress(h); assertCancel(h, false); assertLocked(landing, false);
    await flushSample(); assertProgress(h); assert.equal(Socket.instances.length, 0);
  }
  assert.equal(errorBox(h).hidden, false); assert.match(errorBox(h).textContent, /wsPath/);
  assert.equal(h.clock.jobs.size, 0);
});

for (const action of ['create', 'join'] as const) {
  it(`whole sample actual SDK ${action} progress spans hello and ACK waits without duplicate-submit relabeling`, async t => {
    const h = await actual(t); assertProgress(h); assertCancel(h, false); assertLocked(forms(h), false);
    const { landing, socket } = h.start(action), progress = assertProgress(h, action);
    landing[action].form.submit(); landing[opposite(action)].form.submit();
    assert.equal(Socket.instances.length, 1); assert.equal(socket.sent.length, 0);
    assert.equal(assertProgress(h, action), progress); assertLocked(landing, true);
    const request = await h.hello(socket, action); assertProgress(h, action);
    landing[action].form.submit(); landing[opposite(action)].form.submit(); await flushSample();
    assert.equal(socket.sent.length, 1); assert.equal(assertProgress(h, action), progress);
    assert.equal(errorBox(h).hidden, true); assert.equal(notices(h).textContent, '');
    acknowledge(socket, action, request); await flushSample();
    assert.equal(h.sdk.state, null, 'ACK settlement need not have received a room snapshot');
    assertProgress(h); assertLocked(landing, false); assertCancel(h, false);
    assert.equal(errorBox(h).hidden, true); assert.deepEqual(h.errors, []); assert.equal(h.clock.jobs.size, 0);
  });

  for (const phase of ['hello', 'ACK'] as const) {
    it(`whole sample actual SDK ${action} cancellation clears progress synchronously before ${phase} and ignores stale wire callbacks`, async t => {
      const h = await actual(t), { landing, socket } = h.start(action);
      const request = phase === 'ACK' ? await h.hello(socket, action) : undefined;
      const oldMessage = socket.onmessage, oldError = socket.onerror, oldClose = socket.onclose;
      const cancel = assertCancel(h, true); assert.ok(cancel.onclick); const oldCancel = cancel.onclick;
      cancel.click();
      assertProgress(h); assertCancel(h, false); assertLocked(landing, true);
      assert.equal(socket.closeCalls, 1); assert.equal(h.sdk.status, 'disconnected');
      oldCancel(); landing.create.form.submit(); landing.join.form.submit(); assert.equal(Socket.instances.length, 1);
      await flushSample(); assertProgress(h); assertLocked(forms(h), false); assert.equal(errorBox(h).hidden, true);
      const fresh = h.start(opposite(action)); assert.equal(Socket.instances.length, 2);
      for (const message of [
        { type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'retired', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } },
        ...(request ? [{ type: 'ok', requestId: request.requestId }] : []),
        { type: 'room:created', roomId: 'retired-room', code: 'RETIRED' },
        { type: 'room:state', ...roomState(), roomId: 'retired-room' },
        { type: 'room:closed', roomId: 'retired-room', reason: 'shutdown' },
        { type: 'kicked', roomId: 'retired-room' },
        { type: 'error', code: 'bad_request', message: 'retired-error' },
      ]) oldMessage?.({ data: JSON.stringify(message) });
      oldError?.(); oldClose?.(); await flushSample();
      assertProgress(h, opposite(action)); assertLocked(fresh.landing, true); assertCancel(h, true);
      assert.equal(fresh.socket.closeCalls, 0); assert.equal(fresh.socket.sent.length, 0); assert.equal(h.sdk.state, null);
      assert.equal(errorBox(h).hidden, true); assert.equal(notices(h).textContent, ''); assert.deepEqual(h.errors, []);
      const freshRequest = await h.hello(fresh.socket, opposite(action));
      acknowledge(fresh.socket, opposite(action), freshRequest); await flushSample();
      assertProgress(h); assertCancel(h, false); assertLocked(fresh.landing, false);
      t.mock.timers.tick(1000); await flushSample(); assertProgress(h); assert.equal(errorBox(h).hidden, true);
    });
  }

  it(`whole sample actual SDK ${action} removes progress immediately for state before ACK and keeps it absent after settlement`, async t => {
    const h = await actual(t), { landing, socket } = h.start(action), progress = assertProgress(h, action);
    const request = await h.hello(socket, action);
    snapshot(socket, action);
    assert.equal(progress.isConnected, false); assert.ok(h.sdk.state);
    assert.equal(h.app.descendants().some(node => node.dataset.landingProgress !== undefined), false);
    assert.equal(landing[action].form.isConnected, false); assertLocked(landing, true);
    acknowledge(socket, action, request); await flushSample();
    assert.equal(h.app.descendants().some(node => node.dataset.landingProgress !== undefined), false);
    assert.equal(errorBox(h).hidden, true);
    h.button('離開房間').click(); assertProgress(h); await flushSample(); assertProgress(h); assertLocked(forms(h), false);
  });

  for (const failure of ['request-error', 'hello-timeout', 'ACK-timeout'] as const) {
    it(`whole sample actual SDK ${action} clears progress on ${failure} settlement with existing error feedback`, async t => {
      const h = await actual(t), { landing, socket } = h.start(action);
      const request = failure !== 'hello-timeout' ? await h.hello(socket, action) : undefined;
      if (failure === 'request-error') {
        socket.deliver({ type: 'error', requestId: request!.requestId, code: 'unauthorized', message: '無法加入此房間。' });
        // The SDK error event is synchronous; the entry catch/finally follows in microtasks.
        assertProgress(h, action); assertLocked(landing, true); assert.equal(h.errors.length, 1);
        assert.equal(errorBox(h).textContent, '無法加入此房間。');
      } else t.mock.timers.tick(1000);
      await flushSample(); assertProgress(h); assertCancel(h, false); assertLocked(forms(h), false);
      assert.equal(errorBox(h).hidden, false);
      assert.equal(errorBox(h).textContent, failure === 'hello-timeout' ? '連線逾時，請稍後再試。'
        : failure === 'ACK-timeout' ? '請求逾時，請重試。'
        : action === 'join' ? '無法加入此房間。（unauthorized）\n請確認房間 ID 與代碼，或向主控索取最新邀請連結。' : '無法加入此房間。');
      const retry = forms(h); retry[opposite(action)].form.submit();
      assertProgress(h, opposite(action)); assertLocked(retry, true); assert.equal(errorBox(h).hidden, true);
      assertCancel(h, true).click(); assertProgress(h); await flushSample(); assertProgress(h);
    });
  }

  for (const retirement of ['disconnect', 'closed', 'shutdown', 'kicked'] as const) {
    it(`whole sample actual SDK ${action} hides retired progress through pre-state ${retirement} and pending ACK cleanup`, async t => {
      const h = await actual(t), { landing, socket } = h.start(action);
      await h.hello(socket, action); const oldProgress = assertProgress(h, action);
      socket.deliver({ type: 'status', state: 'reconnecting' }); assert.equal(h.sdk.state, null);
      if (retirement === 'disconnect') void h.sdk.disconnect();
      else socket.deliver(retirement === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
        : { type: 'room:closed', roomId: 'same-room', ...(retirement === 'shutdown' ? { reason: 'shutdown' } : {}) });
      assert.equal(oldProgress.isConnected, false); assertProgress(h);
      const replacement = forms(h); assertLocked(replacement, true); assertLocked(landing, true);
      // Preserve existing cancellation eligibility; progress alone belongs to its landing revision.
      assertCancel(h, true);
      replacement.create.form.submit(); replacement.join.form.submit(); assert.equal(Socket.instances.length, 1);
      await flushSample(); assertProgress(h); assertLocked(forms(h), false); assertCancel(h, false);
      assert.equal(errorBox(h).textContent, '連線已中斷。'); assert.equal(errorBox(h).hidden, false);
      const notice = notices(h).textContent;
      if (retirement === 'disconnect') assert.equal(notice, '');
      else assert.match(notice, retirement === 'kicked' ? /你已被主控移出房間/ : retirement === 'shutdown' ? /伺服器維護或重新啟動/ : /房間已關閉/);
      h.start(opposite(action)); assertProgress(h, opposite(action)); assert.equal(errorBox(h).hidden, true);
      assertCancel(h, true).click(); await flushSample(); assertProgress(h);
    });
  }

  it(`whole sample actual SDK ${action} revision change from its synchronous error listener hides progress before rejection continuation`, async t => {
    const h = await actual(t), { landing, socket } = h.start(action), request = await h.hello(socket, action);
    socket.deliver({ type: 'status', state: 'reconnecting' });
    let before: { text: string; hidden: boolean; error: string; locked: boolean[] } | undefined;
    const off = h.sdk.on('error', () => {
      const progress = h.id('landing-progress');
      before = { text: progress.textContent, hidden: progress.hidden, error: errorBox(h).textContent,
        locked: Object.values(landing).map(({ submit }) => submit.disabled) };
      void h.sdk.disconnect();
      forms(h)[opposite(action)].form.submit();
    });
    socket.deliver({ type: 'error', requestId: request.requestId, code: 'bad_request', message: 'Bad request' }); off();
    assert.deepEqual(before, { text: label(action), hidden: false, error: 'Bad request', locked: [true, true] });
    assertProgress(h); assertLocked(forms(h), true); assertCancel(h, true); assert.equal(Socket.instances.length, 1);
    await flushSample(); assertProgress(h); assertLocked(forms(h), false); assertCancel(h, false);
    assert.equal(errorBox(h).textContent, 'Bad request', 'retirement preserves generic error without contextual guidance');
    h.start(opposite(action)); assertProgress(h, opposite(action)); assert.equal(errorBox(h).hidden, true);
    assertCancel(h, true).click(); await flushSample(); assertProgress(h);
  });
}

it('whole sample actual SDK clears create progress when an ACK omits the required room:created result', async t => {
  const h = await actual(t), { landing, socket } = h.start('create'), request = await h.hello(socket, 'create');
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flushSample();
  assertProgress(h); assertLocked(landing, false); assertCancel(h, false);
  assert.equal(errorBox(h).textContent, '伺服器未回傳房間資訊。'); assert.equal(errorBox(h).hidden, false);
});

for (const action of ['create', 'join'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`whole sample synthetic deferred ${action} ${outcome} and old disconnect continuation cannot replace fresh progress`, async t => {
      // Synthetic lifecycle control: unlike the actual SDK above, these entry promises deliberately
      // remain pending after disconnect, and disconnect's outer promise can finish after a retry.
      const h = sampleApp(), requests: { action: Action; work: Deferred<unknown> }[] = [];
      const request = (action: Action) => { const work = new Deferred<unknown>(); requests.push({ action, work }); return work.promise; };
      const finishing = new Deferred<void>(), disconnect = h.sdk.disconnect.bind(h.sdk);
      let disconnectCalls = 0;
      Object.assign(h.sdk, { createRoom: () => request('create'), join: () => request('join'),
        disconnect() { disconnectCalls++; void disconnect(); return finishing.promise; } });
      t.after(async () => {
        Object.assign(h.sdk, { disconnect });
        if (finishing.status === 'pending') finishing.resolve(undefined);
        for (const { work } of requests) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
        await h.cleanup(); assert.ok(requests.every(({ work }) => work.status !== 'pending'));
      });
      const retired = forms(h); retired[action].form.submit(); assertProgress(h, action);
      h.sdk.setStatus('reconnecting'); const cancel = assertCancel(h, true); assert.ok(cancel.onclick); const oldCancel = cancel.onclick;
      cancel.click(); assertProgress(h); assertLocked(forms(h), true); assertCancel(h, false);
      assert.equal(disconnectCalls, 1); const landing = forms(h);
      oldCancel(); retired[action].form.submit(); landing[opposite(action)].form.submit(); assert.equal(requests.length, 1);
      h.sdk.emit('error', { message: '另一項操作的通知。' });
      if (outcome === 'resolve') requests[0]!.work.resolve(action === 'create' ? { roomId: 'retired-room', code: 'RETIRED' } : undefined);
      else requests[0]!.work.reject(new Error('連線已中斷。'));
      await flushSample(); assertProgress(h); assertLocked(landing, false); assertCancel(h, false);
      assert.equal(errorBox(h).textContent, '另一項操作的通知。'); assert.equal(finishing.status, 'pending');
      landing[opposite(action)].form.submit(); assertProgress(h, opposite(action)); assertLocked(landing, true);
      finishing.resolve(undefined); oldCancel(); await flushSample();
      assertProgress(h, opposite(action)); assertCancel(h, true); assertLocked(landing, true);
      assert.equal(requests.length, 2); assert.equal(disconnectCalls, 1); assert.equal(errorBox(h).hidden, true);
      assert.doesNotMatch(h.app.textContent, /RETIRED|retired-room/);
      requests[1]!.work.reject(new Error('新的請求失敗。')); await flushSample();
      assertProgress(h); assertCancel(h, false); assertLocked(landing, false); assert.equal(errorBox(h).textContent, '新的請求失敗。');
    });
  }
}
