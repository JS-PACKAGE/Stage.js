import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { parse } from 'yaml';
import { parseConfig } from '../src/config.ts';
import type { AppConfig } from '../src/config.ts';
import { ERROR_MESSAGES } from '../src/model/errors.ts';
import { parseClientMessage, ValidationError } from '../src/ws/validate.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import { FakeSession, harness, testConfig } from './helpers.ts';
import type { Harness } from './helpers.ts';

type Action = 'create' | 'join';
type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'find' | 'id' | 'button'>;
interface Form { form: SampleNode; submit: SampleNode; input(name: string): SampleNode }
type Forms = Record<Action, Form>;
const privateValues = { name: 'private-person', roomName: 'r'.repeat(33), token: 'private-create-token', roomId: 'private-room', code: 'SECRET42' };
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
function forms(h: View): Forms {
  const find = (heading: string): Form => {
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === heading));
    const input = (name: string): SampleNode => {
      const node = form.descendants().find(node => node.tagName === 'input' && node.name === name);
      assert.ok(node); return node;
    };
    const submit = form.descendants().find(node => node.tagName === 'button' && node.type === 'submit');
    assert.ok(submit); return { form, submit, input };
  };
  const landing = { create: find('建立房間'), join: find('加入房間') };
  for (const [action, keys] of [['create', ['name', 'roomName', 'token']], ['join', ['roomId', 'code', 'name']]] as const) {
    for (const key of keys) landing[action].input(key).value = privateValues[key];
  }
  return landing;
}
function assertPending(landing: Forms, pending: boolean): void {
  assert.deepEqual(Object.values(landing).map(({ submit }) => submit.disabled), [pending, pending]);
  assert.deepEqual(Object.values(landing).map(({ submit }) => submit.attributes['aria-busy']), [String(pending), String(pending)]);
}
function assertGuidance(h: View, action: Action, message = ERROR_MESSAGES.bad_request): void {
  const box = errorBox(h), text = box.textContent;
  assert.equal(box.hidden, false); assert.ok(text.startsWith(message));
  const guidance = text.slice(message.length);
  assert.match(guidance, /bad_request/); assert.match(guidance, /請檢查/); assert.match(guidance, /伺服器規則/);
  assert.match(guidance, action === 'create' ? /房間名稱/ : /房間 ID.*代碼/);
  assert.doesNotMatch(guidance, /\d|最多|至少|上限|超過|必須|只能|欄位錯誤/);
  assert.equal(box.children.length, 0, 'feedback is text, never submitted or server-provided HTML');
  for (const value of Object.values(privateValues)) assert.ok(!text.includes(value), 'feedback must not echo submitted data or credentials');
}
function setup(t: TestContext) {
  const h = sampleApp();
  const requests: { action: Action; work: Deferred<unknown> }[] = [];
  const request = (action: Action) => { const work = new Deferred<unknown>(); requests.push({ action, work }); return work.promise; };
  Object.assign(h.sdk, { createRoom: () => request('create'), join: () => request('join') });
  t.after(async () => {
    for (const { work } of requests) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
    await h.cleanup();
  });
  return { ...h, requests, reject(value: unknown): void { requests.at(-1)!.work.reject(value as Error); } };
}
type EntryCode = 'bad_request' | 'unauthorized';
const admissionGuidance = (message = ERROR_MESSAGES.unauthorized) => `${message}（unauthorized）\n請確認房間 ID 與代碼，或向主控索取最新邀請連結。`;
function assertEntryGuidance(h: View, action: Action, code: EntryCode): void {
  if (code === 'bad_request') { assertGuidance(h, action); return; }
  const box = errorBox(h);
  assert.equal(box.hidden, false);
  assert.equal(box.textContent, action === 'join' ? admissionGuidance() : ERROR_MESSAGES.unauthorized);
  assert.equal(box.children.length, 0);
  for (const value of Object.values(privateValues)) assert.ok(!box.textContent.includes(value));
}
const badRequest = (message = ERROR_MESSAGES.bad_request) => Object.assign(new Error(message), { code: 'bad_request' });

interface Request { type: string; requestId: string; roomName?: string }
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
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
  close(): void { this.readyState = 2; }
}
class Peer {
  static instances: Peer[] = [];
  connectionState = 'new'; signalingState = 'stable'; localDescription = null;
  onicecandidate: ((event: { candidate: null }) => void) | null = null;
  private rejectOffer: ((error: Error) => void) | undefined;
  constructor() { Peer.instances.push(this); }
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as unknown,
      async replaceTrack(track: unknown): Promise<void> { this.track = track; } } };
  }
  // Hold unrelated negotiation; disconnect rejects it through the SDK's normal cleanup path.
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  async getStats(): Promise<Map<string, unknown>> { return new Map(); }
  close(): void { this.connectionState = 'closed'; this.rejectOffer?.(new Error('fixture peer closed')); }
}
interface IntegratedClient {
  readonly state: unknown;
  readonly status: string;
  createRoom(options: unknown): Promise<unknown>;
  join(options: unknown): Promise<unknown>;
  disconnect(): Promise<void>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
async function integrated(t: TestContext, wire?: { h: Harness; config: AppConfig }) {
  const wireSockets: HubSocket[] = [];
  class HubSocket extends Socket {
    readonly session = new FakeSession();
    work = Promise.resolve();
    constructor(url: string) {
      super(url); wireSockets.push(this);
      const record = this.session.send.bind(this.session);
      this.session.send = (message, encoded) => {
        record(message, encoded);
        if (this.readyState === Socket.OPEN) this.deliver(message);
      };
    }
    override hello(): void { this.readyState = Socket.OPEN; wire!.h.hub.attach(this.session); }
    override send(data: string): void {
      super.send(data);
      const request = parseClientMessage(data, wire!.config.limits);
      this.work = this.work.then(() => wire!.h.hub.handle(this.session, request));
    }
    override close(): void {
      if (this.readyState !== Socket.OPEN) return;
      super.close(); this.work = this.work.then(() => wire!.h.hub.detach(this.session, true));
    }
  }
  // A dynamic import executes the real SDK without adding browser types to the server-test graph.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const target = new EventTarget();
  const globals = { window: target, WebSocket: wire ? HubSocket : Socket, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { enumerateDevices: async () => [] } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Socket.instances = []; Peer.instances = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sdk: IntegratedClient = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    audioElement: { volume: 1, muted: false, pause() {} } });
  const rejected: unknown[] = [];
  for (const method of ['createRoom', 'join'] as const) {
    const original = sdk[method].bind(sdk);
    sdk[method] = async options => {
      try { return await original(options); }
      catch (error) { rejected.push(error); throw error; }
    };
  }
  const h = sampleApp({ sdk });
  t.after(async () => {
    try {
      await h.cleanup();
      await Promise.all(wireSockets.map(socket => socket.work));
      if (wire) {
        await wire.h.hub.shutdown(); await wire.h.transport.close();
        assert.equal(wire.h.hub.roomCount, 0); assert.equal(wire.h.transport.rooms.size, 0);
        assert.equal(wire.h.timers.filter(timer => !timer.cleared).length, 0);
      }
      assert.equal(getEventListeners(target, 'pagehide').length, 0);
    }
    finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const events: unknown[] = []; sdk.on('error', ({ detail }) => events.push(detail));
  return { ...h, events, rejected, wireSockets,
    async flushWire() { await Promise.all(wireSockets.map(socket => socket.work)); await flushSample(); },
    async start(action: Action, configure?: (landing: Forms) => void) {
      const landing = forms(h); configure?.(landing); landing[action].form.submit(); assertPending(landing, true);
      const socket = Socket.instances.at(-1)!; socket.hello(); await flushSample(); t.mock.timers.tick(0);
      assert.equal(socket.sent.length, 1); const request = socket.sent[0]!;
      assert.equal(request.type, action === 'create' ? 'room:create' : 'join');
      return { landing, socket, request };
    } };
}
const limits = parseConfig(parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'))).limits;
function validatorReply(socket: Socket, request: Request, nameMaxLength = limits.nameMaxLength): void {
  try { parseClientMessage(JSON.stringify(request), { ...limits, nameMaxLength }); }
  catch (error) {
    assert.ok(error instanceof ValidationError); assert.equal(error.code, 'bad_request');
    assert.equal(error.requestId, request.requestId);
    socket.deliver({ type: 'error', requestId: error.requestId, code: error.code, message: ERROR_MESSAGES[error.code] }); return;
  }
  assert.fail('expected an actual server validation rejection');
}

it('whole sample actual SDK decorates default-validator rejection of a 33-character room name after its untouched error event', async t => {
  assert.equal(limits.nameMaxLength, 32);
  const h = await integrated(t), { landing, socket, request } = await h.start('create');
  assert.equal(landing.create.input('roomName').maxLength, 64, 'do not impose the default server limit in the UI');
  assert.equal(request.roomName, privateValues.roomName);
  validatorReply(socket, request);
  assert.equal(errorBox(h).textContent, 'Bad request', 'the generic event runs before the entry promise continuation');
  assert.equal(h.events.length, 1); assert.deepEqual(h.rejected, []);
  const raw = h.events[0]; assert.ok(raw instanceof Error); const original = Object.getOwnPropertyDescriptors(raw);
  await flushSample(); assertGuidance(h, 'create'); assertPending(landing, false);
  assert.equal(h.rejected[0], raw, 'the SDK event and rejected entry retain the original error identity');
  assert.deepEqual(Object.getOwnPropertyDescriptors(raw), original, 'formatting must never mutate SDK errors');
  assert.equal(raw.message, 'Bad request'); assert.equal((raw as Error & { code: string }).code, 'bad_request');
});

it('whole sample actual SDK accepts the same 33-character room name when server nameMaxLength is 64', async t => {
  const h = await integrated(t), { landing, socket, request } = await h.start('create');
  const parsed = parseClientMessage(JSON.stringify(request), { ...limits, nameMaxLength: 64 });
  assert.equal(parsed.type, 'room:create');
  if (parsed.type === 'room:create') assert.equal(parsed.roomName, privateValues.roomName);
  socket.deliver({ type: 'room:created', roomId: 'created-room', code: 'FRESH42' });
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flushSample();
  assertPending(landing, false); assert.equal(errorBox(h).hidden, true);
  assert.deepEqual(h.events, []); assert.deepEqual(h.rejected, []);
});

it('whole sample actual SDK gives contextual join guidance for invalid data without identifying a failed field', async t => {
  const h = await integrated(t), landing = forms(h);
  landing.join.input('roomId').value = 'invalid room id'; landing.join.form.submit();
  const socket = Socket.instances[0]!; socket.hello(); await flushSample(); t.mock.timers.tick(0);
  validatorReply(socket, socket.sent[0]!); assert.equal(errorBox(h).textContent, 'Bad request');
  await flushSample(); assertGuidance(h, 'join'); assertPending(landing, false);
  assert.ok(!errorBox(h).textContent.includes('invalid room id'));
  assert.equal(h.events[0], h.rejected[0]);
});

for (const action of ['create', 'join'] as const) {
  it(`whole sample ${action} preserves other error codes, uncoded messages and non-Error rejections`, async t => {
    const h = setup(t), landing = forms(h);
    const errors: unknown[] = [
      ...[...(action === 'create' ? ['unauthorized'] : []), 'timeout', 'disconnected', 'forbidden', 'internal', 'BAD_REQUEST', 'UNAUTHORIZED']
        .map(code => Object.assign(new Error('Bad request'), { code })),
      new Error('Bad request'), new Error('伺服器提供的其他訊息。'),
      { code: 'bad_request', message: 'Bad request' }, { code: 'unauthorized', message: 'Cannot join room' },
      'bad_request', 'unauthorized', null,
    ];
    for (const error of errors) {
      landing[action].form.submit(); h.reject(error); await flushSample();
      assert.equal(errorBox(h).textContent, error instanceof Error ? error.message : '操作失敗，請稍後再試。');
      assert.equal(errorBox(h).hidden, false); assertPending(landing, false);
    }
  });

  it(`whole sample ${action} preserves custom bad_request messages as safe text without changing the error`, async t => {
    const h = setup(t), landing = forms(h), message = '<img src=x onerror=alert(1)> 請重試。';
    const error = badRequest(message), original = Object.getOwnPropertyDescriptors(error);
    landing[action].form.submit(); h.reject(error); await flushSample();
    assertGuidance(h, action, message); assert.deepEqual(Object.getOwnPropertyDescriptors(error), original);
  });

  for (const retirement of ['cancel', 'Leave'] as const) {
    it(`whole sample ${action} ${retirement} suppresses late contextual feedback and preserves the next entry lock`, async t => {
      const h = setup(t), retired = forms(h); retired[action].form.submit();
      const cancel = h.id('landing-cancel'); assert.ok(cancel.onclick); const oldCancel = cancel.onclick;
      if (retirement === 'cancel') { h.sdk.setStatus('reconnecting'); cancel.click(); }
      else { h.sdk.snapshot(roomState()); h.button('離開房間').click(); }
      await flushSample(); const landing = forms(h); assertPending(landing, true);
      h.sdk.emit('error', { message: '目前另一項操作的通知。' });
      h.reject(badRequest()); await flushSample();
      assert.equal(errorBox(h).textContent, '目前另一項操作的通知。'); assertPending(landing, false);
      const opposite = action === 'create' ? 'join' : 'create';
      landing[opposite].form.submit(); assertPending(landing, true); oldCancel(); await flushSample();
      assert.equal(h.requests.length, 2); assertPending(landing, true); assert.equal(errorBox(h).hidden, true);
      h.reject(badRequest()); await flushSample(); assertGuidance(h, opposite); assertPending(landing, false);
    });
  }
}

for (const code of ['bad_request', 'unauthorized'] as const) {
  it(`whole sample actual RTC ${code} remains generic while an entry ACK is pending`, async t => {
    const h = await integrated(t), { socket, request } = await h.start('join');
    socket.deliver({ type: 'room:state', ...roomState() }); await flushSample();
    const peer = Peer.instances[0]!; assert.ok(peer.onicecandidate); peer.onicecandidate({ candidate: null });
    t.mock.timers.tick(100); await flushSample();
    const rtc = socket.sent.find(message => message.type === 'rtc:ice'); assert.ok(rtc);
    socket.deliver({ type: 'error', requestId: rtc.requestId, code, message: ERROR_MESSAGES[code] });
    await flushSample();
    assert.equal(errorBox(h).textContent, ERROR_MESSAGES[code]); assert.equal(errorBox(h).hidden, false);
    assert.deepEqual(h.rejected, [], 'RTC failure must not reject the pending entry');
    assert.ok(h.events.length >= 1);
    for (const event of h.events) { assert.ok(event instanceof Error); assert.equal(event.message, ERROR_MESSAGES[code]); }
    socket.deliver({ type: 'ok', requestId: request.requestId }); await flushSample();
    assert.equal(errorBox(h).textContent, ERROR_MESSAGES[code]); assert.ok(h.sdk.state);
  });
}

for (const action of ['create', 'join'] as const) {
  it(`whole sample actual SDK ${action} preserves another code with the same generic message`, async t => {
    const h = await integrated(t), { landing, socket, request } = await h.start(action);
    socket.deliver({ type: 'error', requestId: request.requestId, code: 'forbidden', message: 'Bad request' });
    await flushSample(); assert.equal(errorBox(h).textContent, 'Bad request'); assertPending(landing, false);
    assert.equal(h.events[0], h.rejected[0]);
    const raw = h.rejected[0]; assert.ok(raw instanceof Error);
    assert.equal((raw as Error & { code: string }).code, 'forbidden');
  });
}

for (const [action, code] of [['create', 'bad_request'], ['join', 'bad_request'], ['join', 'unauthorized']] as const) {
  for (const retirement of ['cancel', 'Leave'] as const) {
    it(`whole sample actual SDK ${action} ${retirement} ignores stale ${code} frames during a fresh pending entry`, async t => {
      const h = await integrated(t), old = await h.start(action);
      const oldMessage = old.socket.onmessage; assert.ok(oldMessage);
      if (retirement === 'cancel') h.id('landing-cancel').click();
      else {
        old.socket.deliver({ type: 'room:state', ...roomState() }); await flushSample();
        h.button('離開房間').click();
      }
      await flushSample(); assert.equal(errorBox(h).hidden, true);
      const opposite = action === 'create' ? 'join' : 'create', fresh = await h.start(opposite);
      oldMessage({ data: JSON.stringify({ type: 'error', requestId: old.request.requestId,
        code, message: 'Retired entry error' }) });
      await flushSample(); assertPending(fresh.landing, true); assert.equal(errorBox(h).hidden, true);
      assert.deepEqual(h.events, []); assert.equal(fresh.socket.readyState, Socket.OPEN);
      fresh.socket.deliver({ type: 'error', requestId: fresh.request.requestId, code, message: ERROR_MESSAGES[code] });
      await flushSample(); assertEntryGuidance(h, opposite, code); assertPending(fresh.landing, false);
    });
  }

  it(`whole sample actual SDK ${action}/${code} respects synchronous Leave from its error listener before the rejection continuation`, async t => {
    const h = await integrated(t), { socket, request } = await h.start(action);
    socket.deliver({ type: 'room:state', ...roomState() }); await flushSample();
    let left = false;
    const off = h.sdk.on('error', () => {
      assert.equal(errorBox(h).textContent, ERROR_MESSAGES[code]); assert.deepEqual(h.rejected, []);
      h.button('離開房間').click(); left = true;
    });
    socket.deliver({ type: 'error', requestId: request.requestId, code, message: ERROR_MESSAGES[code] });
    assert.equal(left, true); assertPending(forms(h), true); off();
    await flushSample(); assertPending(forms(h), false); assert.equal(errorBox(h).hidden, true);
    assert.equal(h.events[0], h.rejected[0]);
    const fresh = await h.start(action); assertPending(fresh.landing, true);
    fresh.socket.deliver({ type: 'error', requestId: fresh.request.requestId, code, message: ERROR_MESSAGES[code] });
    await flushSample(); assertEntryGuidance(h, action, code); assertPending(fresh.landing, false);
  });
}

for (const [action, code] of [['create', 'bad_request'], ['join', 'bad_request'], ['join', 'unauthorized']] as const) {
  for (const retirement of ['state', 'closed', 'kicked', 'disconnect'] as const) {
    it(`whole sample actual SDK ${action}/${code} keeps raw feedback when ${retirement} retires its context before the rejection continuation`, async t => {
      const h = await integrated(t), { landing, socket, request } = await h.start(action);
      if (retirement === 'disconnect') {
        // A pre-state status change lets disconnect rebuild landing without marking entry.entered.
        socket.deliver({ type: 'status', state: 'reconnecting' }); assert.equal(h.sdk.state, null);
      }
      const off = h.sdk.on('error', () => {
        assert.equal(errorBox(h).textContent, ERROR_MESSAGES[code]); assert.deepEqual(h.rejected, []);
        if (retirement === 'state') socket.deliver({ type: 'room:state', ...roomState() });
        else if (retirement === 'closed') socket.deliver({ type: 'room:closed', roomId: 'same-room', reason: 'shutdown' });
        else if (retirement === 'kicked') socket.deliver({ type: 'kicked', roomId: 'same-room' });
        else void h.sdk.disconnect();
      });
      socket.deliver({ type: 'error', requestId: request.requestId, code, message: ERROR_MESSAGES[code] }); off();
      await flushSample();
      assert.equal(h.events[0], h.rejected[0]); assert.equal(errorBox(h).hidden, false);
      assert.equal(errorBox(h).textContent, ERROR_MESSAGES[code], 'retirement suppresses only contextual guidance, never ordinary errors');
      assert.equal(landing[action].form.isConnected, false);
      assertPending(landing, true);
      if (retirement === 'state') { assert.ok(h.sdk.state); return; }
      assert.equal(h.sdk.state, null); const replacement = forms(h); assertPending(replacement, false);
      const notices = h.find(node => node.classList.contains('notices')).textContent;
      if (retirement === 'closed') assert.match(notices, /伺服器維護或重新啟動/);
      else if (retirement === 'kicked') assert.match(notices, /你已被主控移出房間/);
      else assert.equal(notices, '');
      const fresh = await h.start(action); assert.equal(errorBox(h).hidden, true); assertPending(fresh.landing, true);
      fresh.socket.deliver({ type: 'error', requestId: fresh.request.requestId, code, message: ERROR_MESSAGES[code] });
      await flushSample(); assertEntryGuidance(h, action, code); assertPending(fresh.landing, false);
    });
  }
}

for (const cause of ['missing-code', 'wrong-code', 'nonexistent-room'] as const) {
  it(`whole sample actual Hub and validator give identical join guidance for ${cause} without disclosing existence`, async t => {
    const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 0; });
    const hub = harness(config), host = await hub.create('Synthetic host');
    const h = await integrated(t, { h: hub, config });
    let original: PropertyDescriptorMap | undefined;
    h.sdk.on('error', ({ detail }) => {
      assert.ok(detail instanceof Error); original = Object.getOwnPropertyDescriptors(detail);
      assert.equal(errorBox(h).textContent, ERROR_MESSAGES.unauthorized);
      assert.deepEqual(h.rejected, [], 'the generic error event precedes the entry catch');
    });
    const roomId = cause === 'nonexistent-room' ? 'synthetic-absent-room' : host.roomId;
    const code = cause === 'missing-code' ? '' : cause === 'wrong-code' ? 'SYNTHETICWRONG' : host.code;
    const { landing } = await h.start('join', forms => {
      forms.join.input('roomId').value = roomId; forms.join.input('code').value = code;
    });
    await h.flushWire();
    const socket = h.wireSockets[0]!;
    assert.deepEqual(socket.session.last('error'), { type: 'error', requestId: socket.sent[0]!.requestId,
      code: 'unauthorized', message: ERROR_MESSAGES.unauthorized });
    assertEntryGuidance(h, 'join', 'unauthorized'); assertPending(landing, false);
    assert.equal(h.events.length, 1); assert.equal(h.rejected.length, 1);
    assert.equal(h.events[0], h.rejected[0]);
    assert.deepEqual(Object.getOwnPropertyDescriptors(h.events[0]), original);
    assert.equal(h.sdk.state, null); assert.equal(hub.hub.isJoined(socket.session), false);
    assert.equal(socket.session.all('room:state').length, 0); assert.equal(socket.sent.length, 1);
    assert.equal(Peer.instances.length, 0); assert.equal(hub.hub.roomCount, 1);
    assert.equal(landing.join.input('roomId').value, roomId); assert.equal(landing.join.input('code').value, code);
    for (const value of [roomId, code, host.code].filter(Boolean)) assert.ok(!errorBox(h).textContent.includes(value));
    assert.doesNotMatch(errorBox(h).textContent, /不存在|房間已關閉|代碼錯誤|代碼未填|unknown room|bad code/);
    await flushSample(); assert.equal(socket.sent.length, 1, 'denied admission must not automatically retry');
    assert.equal(landing.join.submit.disabled, false, 'manual retry remains available');
  });
}

it('whole sample actual Hub create-token unauthorized remains generic and cannot create a room', async t => {
  const config = testConfig(c => { c.rooms.createToken = 'synthetic-create-token'; });
  const hub = harness(config), h = await integrated(t, { h: hub, config });
  const { landing } = await h.start('create', forms => {
    forms.create.input('roomName').value = 'Synthetic room'; forms.create.input('token').value = '';
  });
  await h.flushWire();
  const socket = h.wireSockets[0]!;
  assert.equal(socket.sent[0]!.type, 'room:create');
  assert.equal(socket.session.last('error')?.code, 'unauthorized');
  assertEntryGuidance(h, 'create', 'unauthorized'); assertPending(landing, false);
  assert.equal(h.events[0], h.rejected[0]); assert.equal(hub.hub.roomCount, 0);
  assert.equal(h.sdk.state, null); assert.equal(Peer.instances.length, 0);
});

for (const message of ['Bad request', '<img src=x onerror=alert(1)> 請重試。']) {
  it(`whole sample actual SDK join unauthorized keeps its original message as safe text: ${message}`, async t => {
    const h = await integrated(t), { landing, socket, request } = await h.start('join');
    socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message });
    assert.equal(errorBox(h).textContent, message); assert.deepEqual(h.rejected, []);
    const raw = h.events[0]; assert.ok(raw instanceof Error);
    const original = Object.getOwnPropertyDescriptors(raw);
    await flushSample();
    assert.equal(errorBox(h).textContent, admissionGuidance(message)); assert.equal(errorBox(h).children.length, 0);
    assert.equal(h.rejected[0], raw); assert.deepEqual(Object.getOwnPropertyDescriptors(raw), original);
    assertPending(landing, false);
  });
}

it('whole sample actual SDK join unauthorized stays generic after state arrives before the ACK', async t => {
  const h = await integrated(t), { socket, request } = await h.start('join');
  socket.deliver({ type: 'room:state', ...roomState() }); await flushSample();
  assert.ok(h.sdk.state);
  socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: ERROR_MESSAGES.unauthorized });
  await flushSample();
  assert.equal(errorBox(h).textContent, ERROR_MESSAGES.unauthorized);
  assert.equal(h.events[0], h.rejected[0]); assert.ok(h.sdk.state);
});

it('whole sample actual SDK synchronous error-listener cancellation preserves the entry lock and fresh join feedback', async t => {
  const h = await integrated(t), old = await h.start('join');
  const off = h.sdk.on('error', () => {
    assert.equal(errorBox(h).textContent, ERROR_MESSAGES.unauthorized); assert.deepEqual(h.rejected, []);
    h.id('landing-cancel').click();
    const landing = forms(h); assertPending(landing, true);
    landing.join.form.submit(); assert.equal(Socket.instances.length, 1, 'synchronous reentry cannot bypass the retiring request lock');
  });
  old.socket.deliver({ type: 'error', requestId: old.request.requestId, code: 'unauthorized', message: ERROR_MESSAGES.unauthorized });
  off(); await flushSample();
  assert.equal(errorBox(h).hidden, true); assertPending(forms(h), false);
  assert.equal(h.events[0], h.rejected[0]);
  const fresh = await h.start('join');
  fresh.socket.deliver({ type: 'error', requestId: fresh.request.requestId, code: 'unauthorized', message: ERROR_MESSAGES.unauthorized });
  await flushSample(); assertEntryGuidance(h, 'join', 'unauthorized'); assertPending(fresh.landing, false);
});
