import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp, SampleClock, SampleSdk } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type Action = 'create' | 'join';
interface CreatedRoom { roomId: string; code?: string }
interface LandingForm { form: SampleNode; submit: SampleNode }
type Forms = Record<Action, LandingForm>;
type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'find' | 'id'>;

function forms(h: View): Forms {
  const find = (heading: string): LandingForm => {
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === heading));
    const submit = form.descendants().find(node => node.tagName === 'button' && node.type === 'submit');
    assert.ok(submit); return { form, submit };
  };
  return { create: find('建立房間'), join: find('加入房間') };
}
function fill(landing: Forms): void {
  for (const [action, values] of [
    ['create', { name: ' 測試主控 ', roomName: ' 測試舞台 ', token: 'create-token' }],
    ['join', { roomId: ' same-room ', code: ' TEST42 ', name: ' 測試聽眾 ' }],
  ] as const) {
    for (const [name, value] of Object.entries(values)) {
      const input = landing[action].form.descendants().find(node => node.tagName === 'input' && node.name === name);
      assert.ok(input); input.value = value;
    }
  }
}
function assertLocked(landing: Forms, locked: boolean): void {
  assert.deepEqual([landing.create.submit, landing.join.submit].map(node => node.disabled), [locked, locked]);
  assert.deepEqual([landing.create.submit, landing.join.submit].map(node => node.attributes['aria-busy']), [String(locked), String(locked)]);
}
function assertCancel(h: View, available: boolean): SampleNode {
  const node = h.id('landing-cancel');
  assert.equal(node.tagName, 'button'); assert.equal(node.type, 'button'); assert.equal(node.textContent, '取消連線');
  assert.equal(node.hidden, !available); assert.equal(node.disabled, !available);
  return node;
}
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
const notices = (h: View) => h.find(node => node.classList.contains('notices'));

function setup(t: TestContext, sdk?: SampleSdk) {
  const h = sdk ? sampleApp({ sdk }) : sampleApp();
  const creates: Deferred<CreatedRoom>[] = [];
  let disconnectCalls = 0;
  const disconnect = h.sdk.disconnect.bind(h.sdk);
  const countedDisconnect = (): Promise<void> => { disconnectCalls++; return disconnect(); };
  Object.assign(h.sdk, {
    createRoom(): Promise<CreatedRoom> { const work = new Deferred<CreatedRoom>(); creates.push(work); return work.promise; },
    disconnect: countedDisconnect,
  });
  t.after(async () => {
    Object.assign(h.sdk, { disconnect: countedDisconnect });
    for (const work of creates) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
    await h.cleanup();
    assert.ok(creates.every(work => work.status !== 'pending'));
  });
  return {
    ...h, creates, disconnectCalls: () => disconnectCalls,
    requestCount: () => creates.length + h.sdk.joins.length,
    pending: (action: Action) => action === 'create' ? creates.at(-1)! : h.sdk.joins.at(-1)!.work,
    acknowledge(action: Action, code = 'TEST42'): void {
      if (action === 'create') creates.at(-1)!.resolve({ roomId: 'same-room', code });
      else h.sdk.joins.at(-1)!.work.resolve(undefined);
    },
  };
}

it('whole sample keeps manual landing cancellation hidden and inert until an entry begins', async t => {
  const h = setup(t); await flushSample();
  const landing = forms(h); assertLocked(landing, false);
  const cancel = assertCancel(h, false);
  assert.ok(cancel.onclick); cancel.onclick(); await flushSample();
  assert.equal(h.requestCount(), 0); assert.equal(h.disconnectCalls(), 0);
  assert.equal(errorBox(h).hidden, true); assert.equal(h.clock.jobs.size, 0);
});

for (const action of ['create', 'join'] as const) {
  const opposite: Action = action === 'create' ? 'join' : 'create';

  for (const outcome of ['reject', 'fulfill'] as const) {
    it(`whole sample cancels ${action}, keeps both forms locked until late ${outcome}, then permits retry`, async t => {
      const h = setup(t), landing = forms(h); fill(landing);
      landing[action].form.submit(); assertLocked(landing, true);
      const cancel = assertCancel(h, true); assert.ok(cancel.onclick); const callback = cancel.onclick;
      cancel.click();
      assert.equal(h.disconnectCalls(), 1); assert.equal(h.sdk.status, 'disconnected');
      assert.equal(h.sdk.events.includes('status'), false, 'initial cancellation cannot depend on a status change');
      assertCancel(h, false); assertLocked(landing, true);
      callback(); landing.create.form.submit(); landing.join.form.submit(); await flushSample();
      assert.equal(h.disconnectCalls(), 1); assert.equal(h.requestCount(), 1);
      assert.equal(h.pending(action).status, 'pending'); assertLocked(landing, true);
      // An unrelated notification arriving after cancellation must survive the old form's catch.
      h.sdk.emit('error', { message: '另一項操作失敗。' });
      if (outcome === 'reject') h.pending(action).reject(new Error('連線已中斷。'));
      else h.acknowledge(action, 'RETIRED');
      await flushSample(); assertLocked(landing, false); assertCancel(h, false);
      assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '另一項操作失敗。');
      assert.equal(h.sdk.state, null); assert.equal(h.clock.jobs.size, 0);

      landing[opposite].form.submit(); assert.equal(h.requestCount(), 2); assertLocked(landing, true); assertCancel(h, true);
      assert.equal(errorBox(h).hidden, true);
      h.pending(opposite).reject(new Error('重試仍失敗。')); await flushSample();
      assert.equal(errorBox(h).textContent, '重試仍失敗。'); assert.equal(errorBox(h).hidden, false);
      assertLocked(landing, false); assertCancel(h, false);
    });
  }

  it(`whole sample preserves ordinary ${action} failures, including disconnected errors without manual cancellation`, async t => {
    const h = setup(t), landing = forms(h); fill(landing);
    for (const [code, message] of [
      ['disconnected', '連線已中斷。'], ['timeout', '伺服器回應逾時。'], ['unauthorized', '無法加入此房間。'],
    ]) {
      landing[action].form.submit(); assertCancel(h, true);
      h.pending(action).reject(Object.assign(new Error(message), { code })); await flushSample();
      assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, message);
      assertLocked(landing, false); assertCancel(h, false);
    }
    assert.equal(h.disconnectCalls(), 0);
  });

  it(`whole sample ${action} keeps a disconnect failure visible when the canceled entry later rejects`, async t => {
    const h = setup(t), landing = forms(h); fill(landing);
    const disconnect = t.mock.method(h.sdk, 'disconnect', async () => { throw new Error('取消連線失敗。'); });
    landing[action].form.submit(); assertCancel(h, true).click(); await flushSample();
    assert.equal(disconnect.mock.callCount(), 1); assertLocked(landing, true); assertCancel(h, false);
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '取消連線失敗。');
    h.pending(action).reject(new Error('連線已中斷。')); await flushSample();
    assertLocked(landing, false); assertCancel(h, false);
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '取消連線失敗。');
  });

  it(`whole sample ${action} state before ACK retires cancellation and protects the room and next entry from its callback`, async t => {
    const h = setup(t), retired = forms(h); fill(retired);
    retired[action].form.submit(); const cancel = assertCancel(h, true); assert.ok(cancel.onclick); const callback = cancel.onclick;
    h.sdk.snapshot(roomState());
    assert.equal(cancel.isConnected, false);
    assert.equal(h.app.descendants().some(node => node.id === 'landing-cancel'), false);
    const state = h.sdk.state; callback(); await flushSample();
    assert.equal(h.disconnectCalls(), 0); assert.equal(h.sdk.state, state); assert.equal(h.pending(action).status, 'pending');
    h.acknowledge(action); await flushSample(); callback();
    assert.equal(h.disconnectCalls(), 0); assert.equal(h.sdk.state, state);

    await h.sdk.disconnect(); await flushSample(); const replacement = forms(h); fill(replacement);
    replacement[opposite].form.submit(); assertCancel(h, true); assertLocked(replacement, true);
    callback(); await flushSample();
    assert.equal(h.disconnectCalls(), 1); assert.equal(h.requestCount(), 2); assertCancel(h, true);
    h.pending(opposite).reject(new Error('新嘗試失敗。')); await flushSample();
    assertLocked(replacement, false); assertCancel(h, false); assert.equal(errorBox(h).textContent, '新嘗試失敗。');
  });

  for (const terminal of ['closed', 'shutdown', 'kicked'] as const) {
    it(`whole sample ${action} keeps the ${terminal} notice and retires cancellation while its ACK is pending`, async t => {
      const h = setup(t), landing = forms(h); fill(landing);
      landing[action].form.submit(); const cancel = assertCancel(h, true); assert.ok(cancel.onclick); const callback = cancel.onclick;
      h.sdk.snapshot(roomState()); await h.sdk.terminal(terminal === 'kicked' ? 'kicked' : 'closed', terminal === 'shutdown' ? 'shutdown' : undefined);
      const replacement = forms(h); const notice = notices(h).textContent;
      assert.match(notice, terminal === 'kicked' ? /你已被主控移出房間/ : terminal === 'shutdown' ? /伺服器維護或重新啟動/ : /房間已關閉/);
      assertLocked(replacement, true); assertCancel(h, false); callback();
      assert.equal(h.disconnectCalls(), 1);
      replacement.create.form.submit(); replacement.join.form.submit(); assert.equal(h.requestCount(), 1);
      h.pending(action).reject(new Error('連線已中斷。')); await flushSample();
      assertLocked(replacement, false); assertCancel(h, false); assert.equal(notices(h).textContent, notice);
      assert.equal(errorBox(h).hidden, false, 'terminal cleanup is not an explicit manual cancellation');
      assert.equal(errorBox(h).textContent, '連線已中斷。'); assert.equal(h.clock.jobs.size, 0);
    });
  }

  it(`whole sample ${action} cancellation resists synchronous disconnect reentrancy and late cleanup during a new attempt`, async t => {
    const h = setup(t), landing = forms(h); fill(landing);
    landing[action].form.submit(); const retired = assertCancel(h, true); assert.ok(retired.onclick); const callback = retired.onclick;
    h.sdk.setStatus('reconnecting');
    const finishing = new Deferred<void>();
    const disconnect = h.sdk.disconnect.bind(h.sdk);
    let callbacks = 0;
    Object.assign(h.sdk, { disconnect(): Promise<void> {
      callbacks++; assertCancel(h, false); callback();
      landing.create.form.submit(); landing.join.form.submit();
      void disconnect();
      const replacement = forms(h); assert.notEqual(replacement.create.form, landing.create.form);
      assertLocked(replacement, true); assertCancel(h, false); callback();
      replacement.create.form.submit(); replacement.join.form.submit();
      return finishing.promise;
    } });
    t.after(() => { Object.assign(h.sdk, { disconnect }); if (finishing.status === 'pending') finishing.resolve(undefined); });
    retired.click(); assert.equal(callbacks, 1); assert.equal(h.disconnectCalls(), 1); assert.equal(h.requestCount(), 1);
    h.pending(action).reject(new Error('連線已中斷。')); await flushSample();
    assert.equal(errorBox(h).hidden, true); const replacement = forms(h); fill(replacement); assertLocked(replacement, false);
    replacement[opposite].form.submit(); assertCancel(h, true); assertLocked(replacement, true);
    callback(); assert.equal(callbacks, 1); assert.equal(h.requestCount(), 2);
    finishing.resolve(undefined); await flushSample();
    assertLocked(replacement, true); assertCancel(h, true); assert.equal(errorBox(h).hidden, true);
    h.pending(opposite).reject(new Error('目前的請求失敗。')); await flushSample();
    assert.equal(errorBox(h).textContent, '目前的請求失敗。'); assertLocked(replacement, false); assertCancel(h, false);
  });
}

it('whole sample never reuses a canceled late create result as the next room invitation code', async t => {
  const h = setup(t), landing = forms(h); fill(landing);
  landing.create.form.submit(); assertCancel(h, true).click(); h.acknowledge('create', 'RETIRED'); await flushSample();
  assert.equal(errorBox(h).hidden, true);
  landing.create.form.submit();
  const state = roomState({ role: 'controller', onStage: false }); state.controllerId = state.me.participantId; state.codeRequired = true;
  h.sdk.snapshot(state);
  assert.match(h.app.textContent, /房間代碼：未提供/); assert.doesNotMatch(h.app.textContent, /RETIRED/);
  h.acknowledge('create', 'FRESH42'); await flushSample();
  assert.match(h.app.textContent, /房間代碼：FRESH42/); assert.doesNotMatch(h.app.textContent, /RETIRED/);
});

it('whole sample state visible during an earlier SDK status listener prevents cancellation before the landing view retires', async t => {
  const sdk = new SampleSdk(new SampleClock());
  let cancel: SampleNode | undefined;
  let ran = false;
  sdk.on('status', ({ detail }) => {
    if (detail !== 'waiting') return;
    ran = true; assert.ok(sdk.state); assert.ok(cancel?.isConnected); assert.ok(cancel.onclick);
    cancel.onclick();
  });
  const h = setup(t, sdk), landing = forms(h); fill(landing);
  landing.join.form.submit(); cancel = assertCancel(h, true);
  sdk.snapshot(roomState());
  assert.equal(ran, true); assert.equal(h.disconnectCalls(), 0); assert.equal(cancel.isConnected, false);
  h.acknowledge('join'); await flushSample(); assert.ok(sdk.state); assert.equal(errorBox(h).hidden, true);
});

it('whole sample pre-state terminal notices disable cancellation and survive the pending request settling', async t => {
  const h = setup(t), landing = forms(h); fill(landing);
  landing.join.form.submit(); const retired = assertCancel(h, true); assert.ok(retired.onclick);
  h.sdk.emit('closed', { roomId: 'same-room', reason: 'shutdown' });
  assertCancel(h, false); assertLocked(forms(h), true); retired.onclick(); assert.equal(h.disconnectCalls(), 0);
  h.pending('join').reject(new Error('連線已中斷。')); await flushSample();
  assertCancel(h, false); assertLocked(forms(h), false); assert.match(notices(h).textContent, /伺服器維護或重新啟動/);
});

interface Request { type: string; requestId: string; roomId?: string }
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
  send(data: string): void { this.sent.push(JSON.parse(data) as Request); }
  deliver(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello(): void {
    this.readyState = Socket.OPEN;
    this.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
  }
  close(): void { this.closeCalls++; this.readyState = 2; }
}
interface IntegratedClient {
  readonly state: unknown;
  readonly status: string;
  disconnect(): Promise<void>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}

for (const action of ['create', 'join'] as const) {
  for (const phase of ['hello', 'ACK'] as const) {
    it(`whole sample with actual StageClient cancels ${action} before ${phase} despite a stalled close and isolates replacement callbacks`, async t => {
      // Dynamic URL import keeps this server-test project's non-DOM type graph bounded. The actual
      // SDK executes unchanged; only its transport, audio element and browser globals are doubles.
      const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
      const target = new EventTarget();
      const originals = new Map(['window', 'WebSocket', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { enumerateDevices: async () => [] } } });
      Socket.instances = [];
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      const sdk: IntegratedClient = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
        audioElement: { volume: 1, muted: false, pause() {} } });
      const h = sampleApp({ sdk });
      t.after(async () => {
        await h.cleanup();
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
        }
        assert.equal(getEventListeners(target, 'pagehide').length, 0);
      });
      const errors: unknown[] = []; sdk.on('error', event => errors.push(event.detail));
      const landing = forms(h); fill(landing); landing[action].form.submit();
      const old = Socket.instances[0]!;
      if (phase === 'ACK') { old.hello(); await flushSample(); t.mock.timers.tick(0); assert.equal(old.sent.length, 1); }
      const oldMessage = old.onmessage, oldError = old.onerror, oldClose = old.onclose;
      assertCancel(h, true).click();
      assertLocked(landing, true); assertCancel(h, false); assert.equal(old.closeCalls, 1); assert.equal(old.readyState, 2);
      landing.create.form.submit(); landing.join.form.submit(); assert.equal(Socket.instances.length, 1);
      await flushSample();
      assertLocked(landing, false); assertCancel(h, false); assert.equal(errorBox(h).hidden, true);
      assert.equal(sdk.state, null); assert.equal(sdk.status, 'disconnected');
      assert.equal(getEventListeners(target, 'pagehide').length, 0);

      const replacementAction = action === 'create' ? 'join' : 'create';
      landing[replacementAction].form.submit(); assertLocked(landing, true); assertCancel(h, true);
      assert.equal(Socket.instances.length, 2); const current = Socket.instances[1]!;
      oldMessage?.({ data: JSON.stringify({ type: 'hello', protocol: 1, serverVersion: 'retired',
        limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } }) });
      if (old.sent[0]) oldMessage?.({ data: JSON.stringify({ type: 'ok', requestId: old.sent[0].requestId }) });
      oldMessage?.({ data: JSON.stringify({ type: 'room:created', roomId: 'retired-room', code: 'RETIRED' }) });
      for (const message of [
        { type: 'room:state', ...roomState(), roomId: 'retired-room' },
        { type: 'room:closed', roomId: 'retired-room', reason: 'shutdown' },
        { type: 'kicked', roomId: 'retired-room' },
        { type: 'error', code: 'internal', message: '已淘汰連線的錯誤。' },
      ]) oldMessage?.({ data: JSON.stringify(message) });
      oldError?.(); oldClose?.(); await flushSample();
      assert.equal(current.closeCalls, 0); assert.equal(current.sent.length, 0); assert.equal(sdk.state, null);
      assert.equal(notices(h).textContent, ''); assert.doesNotMatch(h.app.textContent, /RETIRED|retired-room|已淘汰連線/);
      assertLocked(landing, true); assertCancel(h, true); assert.equal(errorBox(h).hidden, true);
      current.hello(); await flushSample(); t.mock.timers.tick(0);
      assert.equal(current.sent.length, 1); const request = current.sent[0]!;
      assert.equal(request.type, replacementAction === 'create' ? 'room:create' : 'join');
      if (replacementAction === 'create') current.deliver({ type: 'room:created', roomId: 'same-room', code: 'FRESH42' });
      current.deliver({ type: 'ok', requestId: request.requestId }); await flushSample();
      assertLocked(landing, false); assertCancel(h, false); assert.equal(errorBox(h).hidden, true);
      assert.equal(getEventListeners(target, 'pagehide').length, 1);
      t.mock.timers.tick(1000); await flushSample();
      assert.equal(current.closeCalls, 0); assert.equal(old.closeCalls, 1); assert.deepEqual(errors, []);
      assert.equal(h.clock.jobs.size, 0);
    });
  }
}
