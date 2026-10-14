import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { harness, RECVONLY_OFFER, SENDRECV_OFFER, testConfig, type Harness } from '../../../test/helpers.ts';
import { after, afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { StageClient } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { parseClientMessage, ValidationError } from '../../../src/ws/validate.ts';

/** Minimal DOM surface for widget state tests; this does not simulate a browser layout or input system. */
class Node extends EventTarget {
  readonly children: Node[] = [];
  readonly part = new Set<string>();
  readonly attributes = new Map<string, string>();
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  type = '';
  id = '';
  value = '';
  min = '';
  max = '';
  step = '';
  tagName = '';
  isConnected = true;
  onclick?: () => void;
  oninput?: (event: Event) => void;
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  remove(): void { this.isConnected = false; }
  attachShadow(): Node { const root = new Node(); this.children.push(root); return root; }
  setAttribute(name: string, value: string): void { const previous = this.getAttribute(name); this.attributes.set(name, value); this.changed(name, previous, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { const previous = this.getAttribute(name); this.attributes.delete(name); this.changed(name, previous, null); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  toggleAttribute(name: string, force: boolean): boolean { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); return force; }
  private changed(name: string, previous: string | null, next: string | null): void {
    const element = this as unknown as { attributeChangedCallback?: (name: string, previous: string | null, next: string | null) => void };
    const type = this.constructor as unknown as { observedAttributes?: string[] };
    if (previous !== next && type.observedAttributes?.includes(name)) element.attributeChangedCallback?.(name, previous, next);
  }
}
class Audio extends Node {
  volume = 1;
  muted = false;
  pause(): void {}
  play(): Promise<void> { return Promise.resolve(); }
}
const originals = new Map(['HTMLElement', 'document', 'customElements', 'window'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: Node });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => Object.assign(tag === 'audio' ? new Audio() : new Node(), { tagName: tag.toUpperCase() }), body: { append() {} } } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
const { StageElement, defineStageElement } = await import('../src/element.ts');
after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const widgets: InstanceType<typeof StageElement>[] = [];
afterEach(async () => { for (const element of widgets.splice(0)) { element.disconnectedCallback(); await settle(); } });
function widget(onStage = false) {
  const element = new StageElement();
  widgets.push(element);
  const pending = deferred();
  let calls = 0;
  const action = () => { calls++; return pending.promise; };
  const client = {
    me: { participantId: 'me', name: 'Listener', connected: true, onStage, muted: false, forceMuted: false, handRaised: false, role: 'audience' },
    state: { roomId: 'one', name: 'Room', hands: [] }, status: 'live', handCooldownMs: 0,
    raiseHand: action, withdrawHand: action, mute: action, unmute: action, leaveStage: action, returnToStage: action,
    disconnect: async () => {}, playbackMuted: false, setPlaybackMuted(muted: boolean) { this.playbackMuted = muted; },
    playbackVolume: 1, setPlaybackVolume(volume: number) { this.playbackVolume = volume; },
  };
  element['current'] = client as unknown as StageClient;
  element['render']();
  return { element, pending, client, calls: () => calls };
}
function click(button: HTMLButtonElement): void { button.onclick?.call(button, {} as PointerEvent); }

function roomState(onStage = false, roomId = 'one'): RoomStatePayload {
  return {
    roomId, name: 'Room &amp; Hall', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
    me: { participantId: 'me', name: 'Listener', role: onStage ? 'speaker' : 'audience', onStage,
      handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 },
  };
}

const subscribedVolumes = new WeakMap<TestContext, number[]>();
async function subscribedWidget(t: TestContext, onStage = false) {
  let initialVolumes = subscribedVolumes.get(t);
  if (!initialVolumes) {
    initialVolumes = [];
    subscribedVolumes.set(t, initialVolumes);
    // Looping over fixtures in one test must not stack prototype mocks and restore an older mock.
    const volumes = initialVolumes;
    t.mock.method(StageClient.prototype, 'connect', async function (this: StageClient) { volumes.push(this.playbackVolume); });
    t.mock.method(StageClient.prototype, 'join', async () => {});
    t.mock.method(StageClient.prototype as unknown as { createMedia(): void }, 'createMedia', () => {});
  }
  const element = new StageElement(); widgets.push(element);
  Object.assign(element, { isConnected: false });
  element.setAttribute('room', 'one'); element.setAttribute('name', 'Listener');
  Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
  const client = element.client;
  assert.ok(client);
  await client['receive']({ type: 'room:state', ...roomState(onStage) });
  return { element, client, initialVolumes };
}

function assertRoomControlsHidden(element: InstanceType<typeof StageElement>): void {
  for (const key of ['hand', 'mic', 'leaveStage', 'listen'] as const) assert.equal(element[key].hidden, true, key);
}

const terminalCases = [
  { title: 'ordinary close', message: { type: 'room:closed', roomId: 'one' }, event: 'closed', text: '房間已關閉。' },
  { title: 'kick', message: { type: 'kicked', roomId: 'one' }, event: 'kicked', text: '你已被主控移出房間。' },
  { title: 'shutdown', message: { type: 'room:closed', roomId: 'one', reason: 'shutdown' }, event: 'closed', text: '伺服器維護或重新啟動，房間已關閉。' },
] as const satisfies readonly { title: string; message: ServerMessage; event: 'closed' | 'kicked'; text: string }[];

function mountJoiningWidget(attributes: Record<string, string> = {}) {
  const element = new StageElement(); widgets.push(element);
  Object.assign(element, { isConnected: false });
  element.setAttribute('room', 'one'); element.setAttribute('name', 'Listener');
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  Object.assign(element, { isConnected: true }); element.connectedCallback();
  return element;
}

function deferredJoiningWidget(t: TestContext) {
  const connections: { client: StageClient; pending: ReturnType<typeof deferred> }[] = [];
  const joins: { client: StageClient; pending: ReturnType<typeof deferred> }[] = [];
  t.mock.method(StageClient.prototype, 'connect', function (this: StageClient) {
    const pending = deferred(); connections.push({ client: this, pending }); return pending.promise;
  });
  t.mock.method(StageClient.prototype, 'join', function (this: StageClient) {
    const pending = deferred(); joins.push({ client: this, pending }); return pending.promise;
  });
  t.mock.method(StageClient.prototype as unknown as { createMedia(): void }, 'createMedia', () => {});
  const element = mountJoiningWidget();
  t.after(async () => {
    element.disconnectedCallback();
    for (const { pending } of [...connections, ...joins]) pending.resolve();
    await settle();
  });
  return { element, connections, joins };
}

/** Runs real SDK deadlines and requests with fake sockets; media is disabled unless explicitly faked. */
function socketJoiningWidget(t: TestContext, attributes: Record<string, string> = {}, fakeMedia = false) {
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    readonly sent: ClientMessage[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() { sockets.push(this); }
    send(data: string): void { this.sent.push(JSON.parse(data) as ClientMessage); }
    deliver(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
    hello(): void {
      this.readyState = Socket.OPEN;
      this.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
        limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
    }
    close(): void { this.readyState = 3; this.onclose?.(); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  if (!fakeMedia) t.mock.method(StageClient.prototype as unknown as { createMedia(): void }, 'createMedia', () => {});
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const element = mountJoiningWidget(attributes);
  t.after(async () => {
    element.disconnectedCallback(); await settle();
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  });
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await settle(); await settle(); };
  const joinRequest = (socket: Socket) => {
    const request = socket.sent.find(message => message.type === 'join');
    assert.ok(request && request.type === 'join', 'the real SDK sent its join request');
    return request;
  };
  const hello = async (socket: Socket) => { socket.hello(); await settle(); await tick(0); return joinRequest(socket); };
  return { element, sockets, tick, hello, joinRequest };
}

async function socketJoinedWidget(t: TestContext, state = roomState(), fakeMedia = false) {
  const fixture = socketJoiningWidget(t, { room: state.roomId }, fakeMedia);
  await settle();
  const socket = fixture.sockets[0]!;
  const request = await fixture.hello(socket);
  socket.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' });
  socket.deliver({ type: 'ok', requestId: request.requestId });
  await settle(); await settle();
  const client = fixture.element.client;
  assert.ok(client);
  assert.equal(client.status, state.status);
  assert.equal(client['pending'].size, 0);
  return { ...fixture, socket, client };
}

describe('widget hand queue position', () => {
  function queuedState(ids: string[], ownId = 'me'): RoomStatePayload {
    const state = roomState();
    state.me.participantId = ownId;
    state.me.handRaised = ids.includes(ownId);
    state.hands = ids.map((participantId, index) => ({ ...state.me, participantId,
      name: 'Private listener', handRaised: true, joinedAt: 100 - index }));
    return state;
  }

  it('uses the first, middle and last snapshot positions without sorting or exposing the queue', async t => {
    const { element, client } = await subscribedWidget(t);
    const status = element['status'];
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    for (const ids of [['me', 'a', 'b'], ['a', 'me', 'b'], ['a', 'b', 'me']]) {
      const state = queuedState(ids);
      state.code = 'PRIVATE-CODE';
      for (const hand of state.hands) Object.freeze(hand);
      Object.freeze(state.hands);
      Object.freeze(state.me);
      await client['receive']({ type: 'room:state', ...state });
      assert.equal(status.textContent, `Room & Hall · 直播中 · 已舉手（佇列第 ${ids.indexOf('me') + 1} 位）`);
      assert.equal(element['status'], status, 'the existing live region is reused');
      assert.equal(element['hand'].textContent, '收回舉手');
      assert.equal(element['hand'].hidden, false);
      assert.equal(element['hand'].disabled, false);
      assert.deepEqual(client.state?.hands.map(hand => hand.participantId), ids);
      assert.equal(client.state?.hands, state.hands);
      assert.doesNotMatch(status.textContent ?? '', /Private listener|PRIVATE-CODE/);
    }
  });

  it('updates only from authoritative snapshots, without adding requests or queue timers', async t => {
    const { element, client } = await subscribedWidget(t);
    await client['receive']({ type: 'room:state', ...queuedState(['a', 'b', 'me']) });
    const before = client.state;
    const timers = t.mock.method(globalThis, 'setTimeout');
    const raise = t.mock.method(client, 'raiseHand');
    const withdraw = t.mock.method(client, 'withdrawHand');
    const forwarded: unknown[] = [];
    element.addEventListener('stage-hand', event => { forwarded.push((event as CustomEvent).detail); });
    await client['receive']({ type: 'hand:withdraw', participantId: 'a' });
    assert.equal(client.state, before);
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 3 位）');
    await client['receive']({ type: 'room:state', ...queuedState(['b', 'me']) });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 2 位）');
    await client['receive']({ type: 'room:state', ...queuedState(['me']) });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 1 位）');
    assert.deepEqual(forwarded, [{ participantId: 'a', raised: false }]);
    assert.equal(raise.mock.callCount(), 0);
    assert.equal(withdraw.mock.callCount(), 0);
    assert.equal(timers.mock.callCount(), 0);
    assert.equal(element['cooldownTimer'], undefined);
    assert.equal(element['pendingActions'].size, 0);
  });

  it('clears the position after withdrawal and uses the new tail position after reentry', async t => {
    const { element, client } = await subscribedWidget(t);
    await client['receive']({ type: 'room:state', ...queuedState(['me', 'a']) });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 1 位）');
    await client['receive']({ type: 'room:state', ...queuedState(['a']) });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
    assert.equal(element['hand'].textContent, '舉手發言');
    await client['receive']({ type: 'room:state', ...queuedState(['a', 'b', 'me']) });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 3 位）');
    assert.equal(element['hand'].textContent, '收回舉手');
  });

  it('retains disconnected hands in their snapshot positions', async t => {
    const { element, client } = await subscribedWidget(t);
    const state = queuedState(['offline', 'me']);
    state.hands[0]!.connected = false;
    await client['receive']({ type: 'room:state', ...state });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 2 位）');
    state.hands[0]!.connected = true;
    await client['receive']({ type: 'room:state', ...state });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 2 位）');
    await client['receive']({ type: 'room:state', ...queuedState(['me']) });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 1 位）');
  });

  it('falls back to the raised-hand label when self is absent and uses the first duplicate defensively', async t => {
    const { element, client } = await subscribedWidget(t);
    for (const ids of [[], ['other']]) {
      const state = queuedState(ids);
      // The server forbids this mismatch, but consumers can mutate the exposed SDK snapshot.
      state.me.handRaised = true;
      await client['receive']({ type: 'room:state', ...state });
      assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手');
      assert.equal(element['hand'].textContent, '收回舉手');
    }
    await client['receive']({ type: 'room:state', ...queuedState(['other', 'me', 'me']) });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 2 位）');
  });

  it('never adds a position to unraised, on-stage or controller state', async t => {
    const { element, client } = await subscribedWidget(t);
    await client['receive']({ type: 'room:state', ...queuedState(['me']) });
    for (const muted of [false, true]) {
      const promoted = roomState(true);
      promoted.me.muted = muted;
      await client['receive']({ type: 'room:state', ...promoted });
      assert.equal(element['status'].textContent, `Room & Hall · 直播中 · ${muted ? '台上（已靜音）' : '台上'}`);
      assert.equal(element['hand'].hidden, true);
    }
    const unraised = queuedState(['me']);
    unraised.me.handRaised = false;
    await client['receive']({ type: 'room:state', ...unraised });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
    for (const onStage of [false, true]) {
      const controller = queuedState(['me']);
      controller.me.role = 'controller'; controller.me.onStage = onStage;
      // Invalid retained hand data must not turn a controller into a queued listener.
      await client['receive']({ type: 'room:state', ...controller });
      assert.doesNotMatch(element['status'].textContent ?? '', /佇列/);
      assert.equal(element['hand'].hidden, true);
    }
  });

  it('labels the retained reconnect position as previous and restores fresh rank before the resume ACK', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, queuedState(['a', 'me']));
    const retained = client.state;
    socket.close(); await settle();
    assert.equal(client.state, retained);
    assert.equal(element['status'].textContent, 'Room & Hall · 重新連線中 · 已舉手（上次佇列第 2 位）');
    assert.equal(element['hand'].disabled, true);
    assert.equal(element['hand'].textContent, '收回舉手');
    click(element['hand']);
    await tick(500);
    const replacement = sockets[1]!;
    const resume = await hello(replacement);
    assert.equal(element['status'].textContent, 'Room & Hall · 重新連線中 · 已舉手（上次佇列第 2 位）');
    assert.equal(replacement.sent.some(message => message.type === 'hand:withdraw'), false);
    replacement.deliver({ type: 'room:state', ...queuedState(['me']), resumeToken: 'resume-me' });
    await settle();
    assert.equal(client['pending'].has(resume.requestId), true);
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 1 位）');
    assert.equal(element['hand'].disabled, false);
    replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 1 位）');
  });

  it('uses a replacement participant identity rather than a remembered own position', async t => {
    const { element, client } = await subscribedWidget(t);
    await client['receive']({ type: 'room:state', ...queuedState(['me', 'other']) });
    await client['receive']({ type: 'room:state', ...queuedState(['me', 'other', 'new-me'], 'new-me') });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 已舉手（佇列第 3 位）');
    const fresh = roomState(); fresh.me.participantId = 'fresh';
    await client['receive']({ type: 'room:state', ...fresh });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
  });

  for (const transition of ['room change', 'remount'] as const) {
    it(`clears the old position on ${transition} and ignores the retired client's queue`, async t => {
      const { element, client } = await subscribedWidget(t);
      await client['receive']({ type: 'room:state', ...queuedState(['a', 'me']) });
      if (transition === 'room change') element.setAttribute('room', 'two');
      else {
        Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
        Object.assign(element, { isConnected: true }); element.connectedCallback();
      }
      assert.doesNotMatch(element['status'].textContent ?? '', /佇列/);
      await settle();
      const replacement = element.client;
      assert.ok(replacement); assert.notEqual(replacement, client);
      await replacement['receive']({ type: 'room:state', ...queuedState(['me']), roomId: 'two', name: 'New room' });
      const forwarded: unknown[] = [];
      element.addEventListener('stage-state', event => { forwarded.push((event as CustomEvent).detail); });
      await client['receive']({ type: 'room:state', ...queuedState(['a', 'b', 'me']), name: 'Old room' });
      await client['receive']({ type: 'status', state: 'reconnecting' });
      assert.deepEqual(forwarded, []);
      assert.equal(element['status'].textContent, 'New room · 直播中 · 已舉手（佇列第 1 位）');
    });
  }

  it('clears position on exposed-client disconnect and terminal room events', async t => {
    const { element, client } = await subscribedWidget(t);
    for (const terminal of [null, ...terminalCases]) {
      await client['receive']({ type: 'room:state', ...queuedState(['me']) });
      if (terminal) await client['receive'](terminal.message);
      else await client.disconnect();
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
      assertRoomControlsHidden(element);
      element.playbackMuted = true;
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
    }
  });
});

describe('widget force-mute feedback', () => {
  function assertFeedback(element: InstanceType<typeof StageElement>, muted: boolean, locked: boolean,
    { pending = false, reconnecting = false, name = 'Room' } = {}): void {
    const where = locked ? '台上（主控已鎖定靜音）' : muted ? '台上（已靜音）' : '台上';
    assert.equal(element['status'].textContent, `${name} · ${reconnecting ? '重新連線中' : '直播中'} · ${where}`);
    assert.equal(element['mic'].textContent, locked ? '麥克風已被主控靜音' : muted ? '取消靜音' : '靜音');
    assert.equal(element['mic'].hidden, false);
    assert.equal(element['mic'].disabled, locked || pending || reconnecting);
    assert.equal(element['mic'].getAttribute('aria-pressed'), String(muted));
    assert.equal(element['mic'].getAttribute('aria-busy'), pending ? 'true' : null);
    assert.equal(element['mic'].getAttribute('aria-label'), null);
  }

  async function hubWidget(t: TestContext, selfMuted: boolean) {
    const h = harness(); t.after(async () => { await h.hub.shutdown(); });
    const host = await h.create();
    const speaker = await h.join(host.roomId, host.code, 'Speaker');
    assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
    if (selfMuted) assert.equal(await h.req(speaker.s, { type: 'mic:mute' }), 'ok');
    const snapshot = () => { const state = speaker.s.last('room:state'); assert.ok(state); return state; };
    const fixture = await socketJoinedWidget(t, snapshot());
    const deliver = async () => { fixture.socket.deliver(snapshot()); await settle(); };
    const lock = async (locked: boolean) => {
      assert.equal(await h.req(host.s, { type: locked ? 'mic:force-mute' : 'mic:force-unmute', targetId: speaker.id }), 'ok');
      await deliver();
    };
    return { ...fixture, h, host, speaker, snapshot, deliver, lock };
  }

  for (const selfMuted of [false, true]) {
    it(`distinguishes actual Hub lock/unlock with selfMuted=${selfMuted} and clears it offstage`, async t => {
      const { element, client, socket, tick, h, speaker, deliver, lock } = await hubWidget(t, selfMuted);
      const status = element['status'], mic = element['mic'];
      assert.equal(status.getAttribute('role'), 'status');
      assert.equal(status.getAttribute('aria-live'), 'polite');
      assertFeedback(element, selfMuted, false);
      await lock(true);
      assert.equal(client.me?.forceMuted, true); assert.equal(client.me?.muted, true);
      assertFeedback(element, true, true);
      assert.equal(element['status'], status); assert.equal(element['mic'], mic);
      assert.equal(element['leaveStage'].disabled, false); assert.equal(element['leaveStage'].textContent, '離開舞台');
      assert.equal(element['listen'].disabled, false); assert.equal(element['listen'].textContent, '靜音收聽');
      const mute = t.mock.method(client, 'mute'), unmute = t.mock.method(client, 'unmute');
      const frames = [...socket.sent];
      click(mic); click(mic); await tick(100);
      assert.equal(mute.mock.callCount(), 0); assert.equal(unmute.mock.callCount(), 0);
      assert.deepEqual(socket.sent, frames); assert.equal(client['pending'].size, 0);
      assert.equal(element['pendingActions'].size, 0); assert.equal(element['error'].hidden, true);
      assert.equal(await h.req(speaker.s, { type: 'mic:unmute' }), 'forbidden');
      await lock(false);
      assert.equal(client.me?.forceMuted, false); assert.equal(client.me?.muted, selfMuted);
      assertFeedback(element, selfMuted, false);
      await lock(true);
      assert.equal(await h.req(speaker.s, { type: 'stage:leave' }), 'ok'); await deliver();
      assert.equal(client.me?.onStage, false); assert.equal(client.me?.forceMuted, false);
      assert.equal(element['status'].textContent, 'Room · 直播中 · 收聽中');
      assert.equal(mic.hidden, true); assert.equal(mic.disabled, true);
      assert.equal(mic.textContent, '靜音'); assert.equal(mic.getAttribute('aria-pressed'), 'false');
      assert.equal(element['hand'].hidden, false); assert.equal(element['hand'].textContent, '舉手發言');
    });
  }

  for (const selfMuted of [false, true]) {
    for (const unlockBeforeAck of [false, true]) {
      it(`updates a pending ${selfMuted ? 'unmute' : 'mute'} before ACK with unlockBeforeAck=${unlockBeforeAck}`, async t => {
        const { element, client, socket, tick, h, speaker, lock } = await hubWidget(t, selfMuted);
        click(element['mic']); await tick(100);
        const command = socket.sent.find(message => message.type === (selfMuted ? 'mic:unmute' : 'mic:mute'));
        assert.ok(command && 'requestId' in command);
        const start = speaker.s.inbox.length;
        await h.hub.handle(speaker.s, command);
        const replies = speaker.s.inbox.slice(start);
        const ack = replies.find(message => message.type === 'ok' && message.requestId === command.requestId);
        assert.ok(ack);
        for (const message of replies.filter(message => message.type !== 'ok' && message.type !== 'error')) socket.deliver(message);
        await settle();
        assert.equal(client['pending'].has(command.requestId), true);
        assertFeedback(element, !selfMuted, false, { pending: true });
        await lock(true);
        assertFeedback(element, true, true, { pending: true });
        const frames = [...socket.sent]; click(element['mic']); await tick(100);
        assert.deepEqual(socket.sent, frames);
        if (unlockBeforeAck) {
          await lock(false);
          assertFeedback(element, !selfMuted, false, { pending: true });
        }
        assert.equal(client['pending'].has(command.requestId), true);
        socket.deliver(ack); await settle();
        assert.equal(client['pending'].size, 0); assert.equal(element['pendingActions'].size, 0);
        assertFeedback(element, unlockBeforeAck ? !selfMuted : true, !unlockBeforeAck);
        if (!unlockBeforeAck) await lock(false);
        assertFeedback(element, !selfMuted, false);
        assert.equal(element['error'].hidden, true);
      });
    }
  }

  for (const selfMuted of [false, true]) {
    it(`retains lock wording while reconnecting and accepts fresh state before resume ACK with selfMuted=${selfMuted}`, async t => {
      const { element, client, socket, sockets, tick, hello, h, host, speaker, snapshot } = await hubWidget(t, selfMuted);
      assert.equal(await h.req(host.s, { type: 'mic:force-mute', targetId: speaker.id }), 'ok');
      socket.deliver(snapshot()); await settle();
      const retained = client.state;
      socket.close(); await settle();
      assert.equal(client.state, retained);
      assertFeedback(element, true, true, { reconnecting: true });
      click(element['mic']); await tick(500);
      const replacement = sockets[1]!;
      const resume = await hello(replacement);
      assertFeedback(element, true, true, { reconnecting: true });
      if (!selfMuted) assert.equal(await h.req(host.s, { type: 'mic:force-unmute', targetId: speaker.id }), 'ok');
      replacement.deliver(snapshot()); await settle();
      assert.equal(client['pending'].has(resume.requestId), true);
      assertFeedback(element, selfMuted, selfMuted);
      assert.equal(replacement.sent.some(message => message.type === 'mic:mute' || message.type === 'mic:unmute'), false);
      replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
      assertFeedback(element, selfMuted, selfMuted);
      if (selfMuted) {
        assert.equal(await h.req(host.s, { type: 'mic:force-unmute', targetId: speaker.id }), 'ok');
        replacement.deliver(snapshot()); await settle();
        assertFeedback(element, true, false);
      }
    });
  }

  it('uses the same feedback for an onstage controller without changing ordinary microphone labels', async t => {
    const { element, client } = await subscribedWidget(t, true);
    const state = roomState(true); state.me.role = 'controller'; state.controllerId = state.me.participantId;
    for (const [muted, forceMuted] of [[false, false], [true, false], [true, true], [true, false], [false, false]] as const) {
      Object.assign(state.me, { muted, forceMuted });
      await client['receive']({ type: 'room:state', ...state });
      assertFeedback(element, muted, forceMuted, { name: 'Room & Hall' });
      assert.equal(element['hand'].hidden, true);
    }
  });

  for (const terminal of [null, ...terminalCases]) {
    it(`clears force-mute wording after ${terminal?.title ?? 'exposed-client disconnect'}`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const state = roomState(true); Object.assign(state.me, { muted: true, forceMuted: true });
      await client['receive']({ type: 'room:state', ...state });
      assertFeedback(element, true, true, { name: 'Room & Hall' });
      if (terminal) await client['receive'](terminal.message); else await client.disconnect();
      assertRoomControlsHidden(element);
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
      assert.equal(element['mic'].textContent, '靜音'); assert.equal(element['mic'].disabled, true);
      assert.equal(element['mic'].getAttribute('aria-pressed'), 'false');
      element.playbackMuted = true;
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
      assert.doesNotMatch(element['mic'].textContent ?? '', /主控|鎖定/);
    });
  }
});

const reconnectActions = [
  { title: 'raise hand', key: 'hand', method: 'raiseHand', type: 'hand:raise', onStage: false, raised: false, muted: false },
  { title: 'withdraw hand', key: 'hand', method: 'withdrawHand', type: 'hand:withdraw', onStage: false, raised: true, muted: false },
  { title: 'mute microphone', key: 'mic', method: 'mute', type: 'mic:mute', onStage: true, raised: false, muted: false },
  { title: 'unmute microphone', key: 'mic', method: 'unmute', type: 'mic:unmute', onStage: true, raised: false, muted: true },
  { title: 'leave stage', key: 'leaveStage', method: 'leaveStage', type: 'stage:leave', onStage: true, raised: false, muted: false },
] as const;

describe('widget reconnect control admission', () => {
  for (const action of reconnectActions) {
    for (const phase of ['backoff', 'CONNECTING', 'OPEN before hello', 'awaiting resume state'] as const) {
      it(`suppresses ${action.title} during ${phase} and admits it on resume state before ACK`, async t => {
        const state = roomState(action.onStage);
        Object.assign(state.me, { handRaised: action.raised, muted: action.muted });
        const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, state);
        const call = t.mock.method(client, action.method);
        const statuses: unknown[] = [];
        const events: string[] = [];
        element.addEventListener('stage-status', event => { statuses.push((event as CustomEvent).detail); });
        for (const type of ['state', 'hand', 'mic', 'stageleft', 'error']) {
          element.addEventListener(`stage-${type}`, () => { events.push(type); });
        }
        const retained = client.state;
        socket.close(); await settle();
        assert.equal(client.status, 'reconnecting');
        assert.equal(client.state, retained, 'the socket loss preserves the last room snapshot');
        if (phase !== 'backoff') await tick(500);
        if (phase === 'OPEN before hello') sockets[1]!.readyState = 1;
        let resume = phase === 'awaiting resume state' ? await hello(sockets[1]!) : undefined;
        assert.equal(sockets.length, phase === 'backoff' ? 1 : 2);
        assert.equal(sockets[1]?.readyState, phase === 'backoff' ? undefined : phase === 'CONNECTING' ? 0 : 1);
        const before = {
          frames: sockets.map(current => [...current.sent]), pending: client['pending'].size,
          control: client['pendingControlRequests'], cooldown: client.handCooldownMs,
          error: element['error'].textContent, hiddenError: element['error'].hidden,
        };
        click(element[action.key]); click(element[action.key]);
        await tick(0);
        assert.equal(call.mock.callCount(), 0, 'disabled clicks never enter the SDK action');
        assert.deepEqual({
          frames: sockets.map(current => current.sent), pending: client['pending'].size,
          control: client['pendingControlRequests'], cooldown: client.handCooldownMs,
          error: element['error'].textContent, hiddenError: element['error'].hidden,
        }, before, 'suppressed clicks create no request, cooldown or error');
        assert.equal(element['pendingActions'].size, 0);
        for (const key of ['hand', 'mic', 'leaveStage'] as const) {
          assert.equal(element[key].disabled, true, key);
          assert.equal(element[key].getAttribute('aria-busy'), null, key);
        }
        assert.deepEqual(statuses, ['reconnecting']);
        assert.deepEqual(events, []);

        if (phase === 'backoff') await tick(500);
        const replacement = sockets[1]!;
        resume ??= await hello(replacement);
        assert.equal(resume.resumeToken, 'resume-me');
        assert.equal(element[action.key].disabled, true, 'hello alone does not restore room controls');
        replacement.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' });
        await settle();
        assert.equal(client['pending'].has(resume.requestId), true, 'the resume ACK has not arrived');
        assert.equal(client.status, 'live');
        assert.equal(element[action.key].hidden, false);
        assert.equal(element[action.key].disabled, false, 'the authoritative snapshot restores an allowed action');
        assert.equal(element['hand'].hidden, action.onStage);
        assert.equal(element['mic'].hidden, !action.onStage);
        assert.equal(element['leaveStage'].hidden, !action.onStage);
        assert.equal(element['hand'].textContent, action.raised ? '收回舉手' : '舉手發言');
        assert.equal(element['mic'].textContent, action.muted ? '取消靜音' : '靜音');
        assert.deepEqual(statuses, ['reconnecting', 'live']);
        assert.deepEqual(events, ['state'], 'the widget does not fabricate action or status events');
        click(element[action.key]);
        assert.equal(call.mock.callCount(), 1);
        assert.equal(element[action.key].getAttribute('aria-busy'), 'true');
        await tick(100);
        const commands = replacement.sent.filter(message => message.type === action.type);
        assert.equal(commands.length, 1);
        const command = commands[0]!;
        assert.ok('requestId' in command);
        replacement.deliver({ type: 'ok', requestId: command.requestId });
        replacement.deliver({ type: 'ok', requestId: resume.requestId });
        await settle();
        assert.equal(element['pendingActions'].size, 0);
        assert.equal(element[action.key].getAttribute('aria-busy'), null);
        assert.equal(client['pending'].size, 0);
        assert.equal(element['error'].hidden, true);
        assert.deepEqual(statuses, ['reconnecting', 'live']);
        assert.deepEqual(events, ['state']);
      });
    }
  }

  for (const action of reconnectActions.filter(action => action.method !== 'raiseHand' && action.method !== 'unmute')) {
    for (const outcome of ['rejected by socket loss', 'acknowledged just before socket loss'] as const) {
      it(`keeps ${action.title} disabled after its old request is ${outcome}`, async t => {
        const state = roomState(action.onStage);
        state.me.handRaised = action.raised;
        const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, state);
        const call = t.mock.method(client, action.method);
        click(element[action.key]); await tick(100);
        const command = socket.sent.find(message => message.type === action.type);
        assert.ok(command && 'requestId' in command);
        assert.equal(element[action.key].getAttribute('aria-busy'), 'true');
        if (outcome === 'acknowledged just before socket loss') socket.deliver({ type: 'ok', requestId: command.requestId });
        socket.close();
        assert.equal(client.status, 'reconnecting');
        assert.equal(element[action.key].disabled, true);
        assert.equal(element[action.key].getAttribute('aria-busy'), 'true');
        await settle();
        assert.equal(element['pendingActions'].size, 0);
        assert.equal(element[action.key].getAttribute('aria-busy'), null);
        assert.equal(element[action.key].disabled, true, 'the old action finally block cannot unlock reconnecting controls');
        assert.equal(element['error'].hidden, outcome !== 'rejected by socket loss');
        const error = element['error'].textContent;
        const hiddenError = element['error'].hidden;
        click(element[action.key]); await settle();
        assert.equal(call.mock.callCount(), 1);
        assert.equal(element['error'].textContent, error, 'a suppressed click preserves the settled request error');
        assert.equal(element['error'].hidden, hiddenError);
        assert.equal(client['pending'].size, 0);
        await tick(500);
        const replacement = sockets[1]!;
        const resume = await hello(replacement);
        replacement.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' });
        await settle();
        assert.equal(element[action.key].disabled, false);
        replacement.deliver({ type: 'ok', requestId: resume.requestId });
        await settle();
      });
    }
  }

  it('keeps an expired real hand cooldown disabled until the resume snapshot arrives', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t);
    click(element['hand']); await tick(100);
    const raise = socket.sent.find(message => message.type === 'hand:raise');
    assert.ok(raise && raise.type === 'hand:raise');
    const raised = roomState(); raised.me.handRaised = true;
    socket.deliver({ type: 'room:state', ...raised, resumeToken: 'resume-me' });
    socket.deliver({ type: 'ok', requestId: raise.requestId }); await settle();
    click(element['hand']); await tick(100);
    const withdraw = socket.sent.find(message => message.type === 'hand:withdraw');
    assert.ok(withdraw && withdraw.type === 'hand:withdraw');
    socket.deliver({ type: 'room:state', ...roomState(), resumeToken: 'resume-me' });
    socket.deliver({ type: 'ok', requestId: withdraw.requestId }); await settle();
    assert.equal(client.handCooldownMs, 9800);
    assert.ok(element['cooldownTimer']);
    socket.close(); await tick(500);
    const replacement = sockets[1]!;
    assert.equal(replacement.readyState, 0);
    await tick(9300);
    assert.equal(client.handCooldownMs, 0);
    assert.equal(element['cooldownTimer'], undefined);
    assert.equal(element['hand'].textContent, '舉手發言');
    assert.equal(element['hand'].disabled, true, 'the countdown wake must preserve reconnect admission');
    click(element['hand']); await settle();
    assert.equal(client.handCooldownMs, 0);
    assert.equal(element['pendingActions'].size, 0);
    assert.equal(element['error'].hidden, true);
    const resume = await hello(replacement);
    assert.equal(element['hand'].disabled, true);
    replacement.deliver({ type: 'room:state', ...roomState(), resumeToken: 'resume-me' }); await settle();
    assert.equal(element['hand'].disabled, false);
    assert.equal(client['pending'].has(resume.requestId), true);
    replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
  });

  for (const role of ['audience', 'offstage controller', 'force-muted speaker', 'waiting speaker'] as const) {
    it(`restores ${role} constraints from the resume snapshot`, async t => {
      const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, roomState(true));
      socket.close(); await tick(500);
      const replacement = sockets[1]!;
      const resume = await hello(replacement);
      const state = roomState(role === 'force-muted speaker' || role === 'waiting speaker');
      if (role === 'offstage controller') state.me.role = 'controller';
      if (role === 'force-muted speaker') Object.assign(state.me, { muted: true, forceMuted: true });
      if (role === 'waiting speaker') state.status = 'waiting';
      replacement.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' }); await settle();
      assert.equal(client.status, state.status);
      assert.equal(client['pending'].has(resume.requestId), true);
      assert.equal(element['hand'].hidden, role !== 'audience');
      if (role === 'audience') assert.equal(element['hand'].disabled, false);
      assert.equal(element['mic'].hidden, !state.me.onStage);
      assert.equal(element['leaveStage'].hidden, role === 'audience');
      assert.equal(element['leaveStage'].textContent, state.me.onStage ? '離開舞台' : '返回舞台');
      assert.equal(element['mic'].disabled, !state.me.onStage || role === 'force-muted speaker');
      assert.equal(element['leaveStage'].disabled, role === 'audience');
      assert.equal(element['listen'].disabled, false);
      if (role === 'force-muted speaker') {
        const mute = t.mock.method(client, 'unmute');
        click(element['mic']); await settle();
        assert.equal(mute.mock.callCount(), 0);
        assert.equal(element['mic'].getAttribute('aria-busy'), null);
      }
      replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    });
  }

  it('keeps local listening, volume and an already-visible audio unlock usable across reconnect phases', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, roomState(true));
    const plays: ReturnType<typeof deferred>[] = [];
    t.after(async () => { for (const pending of plays) pending.resolve(); await settle(); });
    const play = t.mock.method(client['audio'], 'play', () => { const pending = deferred(); plays.push(pending); return pending.promise; });
    const events: string[] = [];
    for (const type of ['status', 'state', 'hand', 'mic', 'stageleft', 'error', 'audioblocked']) {
      element.addEventListener(`stage-${type}`, () => { events.push(type); });
    }
    const state = client.state;
    const generation = element['generation'];
    socket.close(); await settle();
    for (let phase = 0; phase < 4; phase++) {
      if (phase === 1) await tick(500);
      if (phase === 2) sockets[1]!.readyState = 1;
      if (phase === 3) await hello(sockets[1]!);
      const frames = sockets.map(current => [...current.sent]);
      const pending = client['pending'].size;
      assert.equal(element['listen'].hidden, false);
      assert.equal(element['listen'].disabled, false);
      click(element['listen']); await settle();
      assert.equal(client.playbackMuted, phase % 2 === 0);
      assert.equal(element['listen'].getAttribute('aria-pressed'), String(client.playbackMuted));
      element.playbackVolume = (phase + 1) / 4;
      assert.equal(client.playbackVolume, (phase + 1) / 4);
      // Model a previously shown unlock button; its real SDK action only calls the fake audio element.
      element['unlock'].hidden = false;
      assert.equal(element['unlock'].disabled, false);
      click(element['unlock']);
      assert.equal(play.mock.callCount(), phase + 1);
      assert.equal(element['unlock'].disabled, true);
      assert.equal(element['unlock'].getAttribute('aria-busy'), 'true');
      assert.equal(element['mic'].disabled, true);
      plays.at(-1)!.resolve(); await settle();
      assert.equal(element['unlock'].hidden, true);
      assert.equal(element['unlock'].disabled, false);
      assert.equal(element['unlock'].getAttribute('aria-busy'), null);
      assert.equal(element['pendingActions'].size, 0);
      assert.deepEqual(sockets.map(current => current.sent), frames);
      assert.equal(client['pending'].size, pending);
      assert.equal(client.state, state);
      assert.equal(client.status, 'reconnecting');
      assert.equal(element.client, client);
      assert.equal(element['generation'], generation);
      assert.equal(element['error'].hidden, true);
      assert.deepEqual(events, ['status'], 'local playback creates no SDK status, state or action events');
    }
    const replacement = sockets[1]!;
    const resume = replacement.sent.find(message => message.type === 'join');
    assert.ok(resume && resume.type === 'join');
    replacement.deliver({ type: 'room:state', ...roomState(true), resumeToken: 'resume-me' });
    replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assert.equal(element['mic'].disabled, false);
    assert.deepEqual(events, ['status', 'status', 'state']);
  });
});

describe('widget hand and microphone current-state admission', () => {
  const actions = reconnectActions.filter(action => action.key !== 'leaveStage');

  function assertIdle(element: InstanceType<typeof StageElement>, client: StageClient, button: HTMLButtonElement): void {
    assert.equal(element['pendingActions'].size, 0);
    assert.equal(button.getAttribute('aria-busy'), null);
    assert.equal(client['pending'].size, 0);
    assert.equal(client['pendingControlRequests'], 0);
    assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, 'Existing control error');
  }

  for (const transition of ['hand promoted', 'hand becomes controller', 'mic leaves stage', 'muted mic leaves stage', 'mic force muted'] as const) {
    it(`rejects the still-enabled control during forwarded ${transition} without requests, cooldown or error mutation`, async t => {
      const key = transition.startsWith('hand') ? 'hand' : 'mic';
      const initial = roomState(key === 'mic');
      if (transition === 'hand promoted') { initial.me.handRaised = true; initial.hands = [initial.me]; }
      if (transition === 'muted mic leaves stage') initial.me.muted = true;
      const { element, client, socket, tick } = await socketJoinedWidget(t, initial);
      const button = element[key], oldLabel = button.textContent;
      socket.deliver({ type: 'error', code: 'conflict', message: 'Existing control error' });
      const frames = [...socket.sent];
      const next = roomState(transition === 'hand promoted' || transition === 'mic force muted');
      if (transition === 'hand becomes controller') { next.me.role = 'controller'; next.controllerId = next.me.participantId; }
      if (transition === 'mic force muted') Object.assign(next.me, { muted: true, forceMuted: true });
      let callbacks = 0;
      element.addEventListener('stage-state', () => {
        callbacks++;
        assert.equal(client.me, client.state?.me);
        assert.equal(button.hidden, false);
        assert.equal(button.disabled, false, 'the old native control is callable before the post-forward render');
        assert.equal(button.textContent, oldLabel);
        click(button); click(button);
        assertIdle(element, client, button);
        assert.equal(client.handCooldownMs, 0);
      }, { once: true });
      socket.deliver({ type: 'room:state', ...next }); await tick(100);
      assert.equal(callbacks, 1);
      assert.deepEqual(socket.sent, frames);
      assertIdle(element, client, button);
      assert.equal(client.handCooldownMs, 0);
      assert.equal(button.hidden, transition !== 'mic force muted');
      assert.equal(button.disabled, true);
      click(button); await settle(); assertIdle(element, client, button);

      socket.deliver({ type: 'room:state', ...roomState(key === 'mic') });
      assert.equal(button.hidden, false); assert.equal(button.disabled, false);
      click(button); await tick(100);
      const request = socket.sent.slice(frames.length).find(message => message.type === (key === 'hand' ? 'hand:raise' : 'mic:mute'));
      assert.ok(request && 'requestId' in request, 'restored eligibility sends the first genuine action');
      assert.equal(client.handCooldownMs, key === 'hand' ? 9900 : 0);
      socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      assert.equal(element['pendingActions'].size, 0); assert.equal(element['error'].hidden, true);
    });
  }

  for (const action of actions) {
    it(`rejects ${action.title} inside the actual socket-loss status callback before the old control is repainted`, async t => {
      const state = roomState(action.onStage);
      Object.assign(state.me, { handRaised: action.raised, muted: action.muted });
      const { element, client, socket } = await socketJoinedWidget(t, state);
      const button = element[action.key];
      socket.deliver({ type: 'error', code: 'conflict', message: 'Existing control error' });
      const frames = [...socket.sent];
      let callbacks = 0;
      element.addEventListener('stage-status', event => {
        callbacks++; assert.equal((event as CustomEvent).detail, 'reconnecting');
        assert.equal(button.hidden, false); assert.equal(button.disabled, false);
        click(button);
        assertIdle(element, client, button); assert.equal(client.handCooldownMs, 0);
      }, { once: true });
      socket.close(); await settle();
      assert.equal(callbacks, 1); assert.deepEqual(socket.sent, frames);
      assertIdle(element, client, button); assert.equal(client.handCooldownMs, 0);
      assert.equal(button.disabled, true);
    });
  }

  for (const key of ['hand', 'mic'] as const) {
    for (const transition of ['detached', 'current cleared', 'participant disconnected'] as const) {
      it(`rejects a callable ${key} after ${transition} without changing pending or the existing alert`, async t => {
        const state = roomState(key === 'mic');
        const { element, client, socket } = await socketJoinedWidget(t, state);
        const button = element[key];
        socket.deliver({ type: 'error', code: 'conflict', message: 'Existing control error' });
        const frames = [...socket.sent];
        let callbacks = 0;
        element.addEventListener(transition === 'participant disconnected' ? 'stage-status' : 'stage-state', () => {
          callbacks++;
          assert.equal(button.disabled, false); assert.equal(button.hidden, false);
          if (transition === 'detached') Object.assign(element, { isConnected: false });
          if (transition === 'current cleared') element['current'] = null;
          if (transition === 'participant disconnected') assert.equal(client.me, null);
          click(button); assertIdle(element, client, button);
        }, { once: true });
        if (transition === 'participant disconnected') await client.disconnect();
        else socket.deliver({ type: 'room:state', ...state });
        await settle();
        assert.equal(callbacks, 1); assert.deepEqual(socket.sent, frames);
        assertIdle(element, client, button); assert.equal(client.handCooldownMs, 0);
        assert.equal(button.disabled, true);
        if (transition === 'current cleared') await client.disconnect();
      });
    }
  }

  it('rechecks an externally consumed real hand cooldown before admission and still allows withdrawal during that cooldown', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t);
    socket.deliver({ type: 'error', code: 'conflict', message: 'Existing control error' });
    const external = client.raiseHand();
    assert.equal(client.handCooldownMs, 10000);
    assert.equal(element['hand'].disabled, false, 'a direct SDK request has not repainted the widget');
    click(element['hand']);
    assert.equal(element['pendingActions'].size, 0); assert.equal(element['hand'].getAttribute('aria-busy'), null);
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Existing control error');
    assert.equal(client['pendingControlRequests'], 1);
    await tick(100);
    const raises = socket.sent.filter(message => message.type === 'hand:raise'); assert.equal(raises.length, 1);
    const raised = roomState(); raised.me.handRaised = true; raised.hands = [raised.me];
    socket.deliver({ type: 'room:state', ...raised });
    socket.deliver({ type: 'ok', requestId: raises[0]!.requestId }); await external;
    assert.equal(element['hand'].disabled, false); assert.equal(element['hand'].textContent, '收回舉手');
    click(element['hand']); await tick(100);
    const withdraw = socket.sent.find(message => message.type === 'hand:withdraw'); assert.ok(withdraw);
    socket.deliver({ type: 'room:state', ...roomState() });
    assert.equal(element['hand'].getAttribute('aria-busy'), 'true'); assert.equal(element['hand'].disabled, true);
    socket.deliver({ type: 'ok', requestId: withdraw.requestId }); await settle();
    assert.equal(element['hand'].getAttribute('aria-busy'), null); assert.equal(element['hand'].disabled, true);
    assert.equal(client.handCooldownMs, 9800); assert.equal(element['error'].hidden, true);
  });

  for (const action of actions) {
    it(`chooses the current ${action.title} branch during forwarded state and retains pending across the next state before ACK`, async t => {
      const initial = roomState(action.onStage);
      Object.assign(initial.me, { handRaised: !action.raised, muted: !action.muted });
      const { element, client, socket, tick } = await socketJoinedWidget(t, initial);
      const button = element[action.key], oldLabel = button.textContent;
      const selected = t.mock.method(client, action.method);
      const current = roomState(action.onStage);
      Object.assign(current.me, { handRaised: action.raised, muted: action.muted });
      let callbacks = 0;
      element.addEventListener('stage-state', () => {
        callbacks++; assert.equal(button.textContent, oldLabel); assert.equal(button.disabled, false);
        click(button); click(button);
        assert.equal(selected.mock.callCount(), 1); assert.equal(button.getAttribute('aria-busy'), 'true');
        assert.equal(client.me?.handRaised, action.raised); assert.equal(client.me?.muted, action.muted);
      }, { once: true });
      socket.deliver({ type: 'room:state', ...current }); await tick(100);
      assert.equal(callbacks, 1); assert.equal(element[action.key], button);
      const commands = socket.sent.filter(message => message.type === action.type); assert.equal(commands.length, 1);
      const command = commands[0]!; assert.ok('requestId' in command);
      assert.equal(button.disabled, true);
      assert.equal(button.textContent, action.key === 'hand' ? action.raised ? '收回舉手' : '舉手發言（10 秒）' : action.muted ? '取消靜音' : '靜音');
      const applied = roomState(action.onStage);
      Object.assign(applied.me, { handRaised: action.key === 'hand' ? !action.raised : action.raised,
        muted: action.key === 'mic' ? !action.muted : action.muted });
      socket.deliver({ type: 'room:state', ...applied }); await settle();
      assert.equal(button.textContent, action.key === 'hand' ? applied.me.handRaised ? '收回舉手' : '舉手發言' : applied.me.muted ? '取消靜音' : '靜音');
      assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-busy'), 'true');
      click(button); await tick(100); assert.equal(selected.mock.callCount(), 1);
      assert.equal(client['pending'].has(command.requestId), true);
      socket.deliver({ type: 'ok', requestId: command.requestId }); await settle();
      assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-busy'), null);
      assert.equal(element['pendingActions'].size, 0); assert.equal(client['pending'].size, 0);
    });

    it(`preserves a server rejection of the currently admitted ${action.title}`, async t => {
      const state = roomState(action.onStage);
      Object.assign(state.me, { handRaised: action.raised, muted: action.muted });
      const { element, client, socket, tick } = await socketJoinedWidget(t, state);
      const button = element[action.key], before = client.state;
      click(button); await tick(100);
      const command = socket.sent.find(message => message.type === action.type); assert.ok(command && 'requestId' in command);
      socket.deliver({ type: 'error', requestId: command.requestId, code: 'forbidden', message: 'Current action rejected' }); await settle();
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Current action rejected');
      assert.equal(button.getAttribute('aria-busy'), null); assert.equal(element['pendingActions'].size, 0);
      assert.equal(client['pendingControlRequests'], 0); assert.equal(client.state, before);
      assert.equal(button.disabled, action.method === 'raiseHand');
    });
  }

  for (const key of ['hand', 'mic'] as const) {
    it(`shows a real queue_full rejection for an eligible ${key} without consuming an extra SDK slot or cooldown`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t, roomState(key === 'mic'));
      Object.defineProperty(client, 'maxPendingControlRequests', { value: 1 });
      const occupied = client.mute(); void occupied.catch(() => {}); await tick(100);
      const held = socket.sent.find(message => message.type === 'mic:mute'); assert.ok(held);
      const frames = [...socket.sent];
      click(element[key]); await settle();
      assert.equal(element['error'].hidden, false);
      assert.equal(element['error'].textContent, '待回覆控制請求已滿，請等待完成後再試。');
      assert.equal(element[key].disabled, false); assert.equal(element[key].getAttribute('aria-busy'), null);
      assert.equal(element['pendingActions'].size, 0); assert.equal(client['pendingControlRequests'], 1);
      assert.equal(client.handCooldownMs, 0); assert.deepEqual(socket.sent, frames);
      socket.deliver({ type: 'ok', requestId: held.requestId }); await occupied;
      click(element[key]); await tick(100);
      const request = socket.sent.slice(frames.length).find(message => message.type === (key === 'hand' ? 'hand:raise' : 'mic:mute'));
      assert.ok(request && 'requestId' in request);
      socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      assert.equal(element['error'].hidden, true); assert.equal(element['pendingActions'].size, 0);
    });

    for (const transition of ['room attribute', 'code attribute', 'manual rejoin'] as const) {
      it(`isolates the retired ${key} ${key === 'hand' ? 'resolution' : 'rejection'} after ${transition} from current pending and error state`, async t => {
        const { element, client } = await subscribedWidget(t, key === 'mic');
        const retired = deferred(), active = deferred();
        t.after(async () => { retired.resolve(); active.resolve(); await settle(); });
        t.mock.method(client, key === 'hand' ? 'raiseHand' : 'mute', () => retired.promise);
        const button = element[key]; click(button); assert.equal(button.getAttribute('aria-busy'), 'true');
        if (transition === 'manual rejoin') {
          click(element['roomAction']); await settle(); await settle();
          assert.equal(element.client, null); click(element['roomAction']);
        } else element.setAttribute(transition === 'room attribute' ? 'room' : 'code', 'replacement');
        await settle(); await settle();
        const replacement = element.client; assert.ok(replacement); assert.notEqual(replacement, client);
        await replacement['receive']({ type: 'room:state', ...roomState(key === 'mic', transition === 'room attribute' ? 'replacement' : 'one') });
        t.mock.method(replacement, key === 'hand' ? 'raiseHand' : 'mute', () => active.promise);
        click(button);
        await replacement['receive']({ type: 'error', code: 'forbidden', message: 'Current room failure' });
        if (key === 'hand') retired.resolve(); else retired.reject(new Error('Retired microphone failure'));
        await settle();
        assert.equal(element.client, replacement); assert.equal(element[key], button);
        assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-busy'), 'true');
        assert.equal(element['pendingActions'].size, 1);
        assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Current room failure');
        active.resolve(); await settle();
        assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-busy'), null);
        assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Current room failure');
      });
    }
  }

  it('keeps invalid stage, role and forced-unmute commands rejected by the public server controls', async t => {
    const h = harness(); t.after(async () => { await h.hub.shutdown(); });
    const host = await h.create(), listener = await h.join(host.roomId, host.code, 'Listener');
    assert.equal(await h.req(listener.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: listener.id }), 'ok');
    assert.equal(await h.req(listener.s, { type: 'hand:raise' }), 'conflict');
    assert.equal(await h.req(listener.s, { type: 'hand:withdraw' }), 'conflict');
    assert.equal(await h.req(host.s, { type: 'mic:force-mute', targetId: listener.id }), 'ok');
    assert.equal(await h.req(listener.s, { type: 'mic:unmute' }), 'forbidden');
    assert.equal(await h.req(host.s, { type: 'stage:remove', targetId: listener.id }), 'ok');
    assert.equal(await h.req(listener.s, { type: 'mic:mute' }), 'conflict');
    assert.equal(await h.req(listener.s, { type: 'mic:unmute' }), 'conflict');
    assert.equal(await h.req(host.s, { type: 'control:transfer', targetId: listener.id }), 'ok');
    assert.equal(await h.req(listener.s, { type: 'hand:raise' }), 'conflict');
  });
});

describe('widget disconnected snapshot control admission', () => {
  const actions = [
    ...reconnectActions.map(action => ({ ...action, controller: false })),
    { title: 'controller leave stage', key: 'leaveStage', method: 'leaveStage', type: 'stage:leave', onStage: true, raised: false, muted: false, controller: true },
    { title: 'controller return to stage', key: 'leaveStage', method: 'returnToStage', type: 'stage:approve', onStage: false, raised: false, muted: false, controller: true },
  ] as const;

  function actionState(action: typeof actions[number], status: 'waiting' | 'live' = 'live'): RoomStatePayload {
    const state = roomState(action.onStage);
    state.status = status;
    Object.assign(state.me, { handRaised: action.raised, muted: action.muted });
    if (action.controller) { state.me.role = 'controller'; state.controllerId = state.me.participantId; }
    return state;
  }

  async function beforeJoinAck(t: TestContext, state: RoomStatePayload) {
    const fixture = socketJoiningWidget(t);
    await settle();
    const socket = fixture.sockets[0]!;
    const join = await fixture.hello(socket);
    socket.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' }); await settle();
    const client = fixture.element.client; assert.ok(client);
    assert.equal(client.status, state.status);
    assert.equal(client['session'], null, 'an initial snapshot does not install the session before its join ACK');
    assert.equal(client['pending'].has(join.requestId), true);
    return { ...fixture, socket, client, join };
  }

  function assertUnadmitted(element: InstanceType<typeof StageElement>, client: StageClient, button: HTMLButtonElement, error: string | null): void {
    assert.equal(element['pendingActions'].size, 0);
    assert.equal(button.getAttribute('aria-busy'), null);
    assert.equal(client['pending'].size, 0);
    assert.equal(client['pendingControlRequests'], 0);
    assert.equal(client.handCooldownMs, 0);
    assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, error);
  }

  for (const action of actions) {
    it(`disables ${action.title} after real initial socket loss retains the pre-ACK snapshot`, async t => {
      const { element, client, socket, sockets, tick } = await beforeJoinAck(t, actionState(action));
      const button = element[action.key], retained = client.state;
      const selected = t.mock.method(client, action.method);
      assert.equal(button.hidden, false); assert.equal(button.disabled, false);
      socket.close(); await settle(); await settle();
      assert.equal(client.status, 'disconnected'); assert.equal(client.state, retained);
      assert.equal(client.me?.connected, true, 'the accepted snapshot still describes a connected participant');
      assert.equal(client['session'], null); assert.equal(client['reconnectTimer'], undefined);
      assert.equal(button.hidden, false); assert.equal(button.disabled, true);
      assert.equal(element['error'].hidden, false, 'the real initial join rejection remains visible');
      const error = element['error'].textContent, frames = [...socket.sent], mediaRevision = client['mediaRevision'];
      click(button); click(button);
      assert.equal(selected.mock.callCount(), 0); assertUnadmitted(element, client, button, error);
      await tick(100);
      assert.equal(selected.mock.callCount(), 0); assertUnadmitted(element, client, button, error);
      assert.equal(button.disabled, true); assert.equal(element.client, client); assert.equal(client.state, retained);
      assert.equal(client['mediaRevision'], mediaRevision); assert.equal(client['pc'], null);
      assert.deepEqual(socket.sent, frames); assert.equal(sockets.length, 1);
    });

    it(`rejects ${action.title} synchronously in the forwarded disconnected callback before the old DOM is repainted`, async t => {
      const { element, client, socket, sockets, join } = await beforeJoinAck(t, actionState(action));
      const button = element[action.key], retained = client.state;
      const selected = t.mock.method(client, action.method);
      socket.deliver({ type: 'error', code: 'conflict', message: 'Existing control error' });
      const frames = [...socket.sent];
      let callbacks = 0;
      element.addEventListener('stage-status', event => {
        callbacks++; assert.equal((event as CustomEvent).detail, 'disconnected');
        assert.equal(client.status, 'disconnected'); assert.equal(client.state, retained);
        assert.equal(button.hidden, false); assert.equal(button.disabled, false, 'the old enabled DOM is still callable');
        const mediaRevision = client['mediaRevision'];
        // This invokes onclick directly through the minimal DOM; it is not a native browser click.
        click(button); click(button);
        assert.equal(selected.mock.callCount(), 0); assertUnadmitted(element, client, button, 'Existing control error');
        assert.equal(button.disabled, false, 'rejected admission does not mutate the stale button');
        assert.equal(client['mediaRevision'], mediaRevision); assert.deepEqual(socket.sent, frames);
      }, { once: true });
      socket.close();
      assert.equal(callbacks, 1); assert.equal(button.disabled, true, 'post-forward rendering disables the control');
      assertUnadmitted(element, client, button, 'Existing control error');
      await settle(); await settle();
      assert.equal(selected.mock.callCount(), 0); assert.equal(client['pending'].has(join.requestId), false);
      assertUnadmitted(element, client, button, '連線已中斷。');
      assert.equal(client.state, retained); assert.equal(client['session'], null);
      assert.deepEqual(socket.sent, frames); assert.equal(sockets.length, 1);
    });

    for (const status of ['waiting', 'live'] as const) {
      it(`keeps valid ${status} ${action.title} admission, wire shape and request ownership`, async t => {
        const { element, client, socket, tick } = await socketJoinedWidget(t, actionState(action, status));
        const button = element[action.key], retained = client.state, frames = socket.sent.length;
        const selected = t.mock.method(client, action.method);
        socket.deliver({ type: 'error', code: 'conflict', message: 'Earlier control error' });
        assert.equal(button.hidden, false); assert.equal(button.disabled, false);
        click(button); click(button);
        assert.equal(selected.mock.callCount(), 1);
        assert.equal(element['pendingActions'].has(button), true); assert.equal(button.getAttribute('aria-busy'), 'true');
        assert.equal(button.disabled, true); assert.equal(element['error'].hidden, true);
        assert.equal(client['pendingControlRequests'], 1); assert.equal(client['pending'].size, 1);
        await tick(100);
        const commands = socket.sent.slice(frames); assert.equal(commands.length, 1);
        const command = commands[0]!; assert.ok('requestId' in command);
        assert.deepEqual(command, action.method === 'returnToStage'
          ? { type: action.type, requestId: command.requestId, targetId: retained!.me.participantId }
          : { type: action.type, requestId: command.requestId });
        assert.equal(client.state, retained, 'the control does not optimistically change authoritative membership');
        assert.equal(client.status, status); assert.equal(client['pc'], null, 'the media seam stays stubbed');
        assert.equal(client.handCooldownMs, action.method === 'raiseHand' ? 9900 : 0);
        socket.deliver({ type: 'ok', requestId: command.requestId }); await settle();
        assert.equal(element['pendingActions'].size, 0); assert.equal(button.getAttribute('aria-busy'), null);
        assert.equal(client['pendingControlRequests'], 0); assert.equal(client['pending'].size, 0);
        assert.equal(button.disabled, action.method === 'raiseHand'); assert.equal(element['error'].hidden, true);
      });
    }

    it(`rejects stale-DOM and rendered ${action.title} during reconnect, then restores it on resume state`, async t => {
      const state = actionState(action);
      const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, state);
      const button = element[action.key], retained = client.state;
      const selected = t.mock.method(client, action.method);
      socket.deliver({ type: 'error', code: 'conflict', message: 'Existing control error' });
      const frames = [...socket.sent], mediaRevision = client['mediaRevision'];
      let callbacks = 0;
      element.addEventListener('stage-status', event => {
        callbacks++; assert.equal((event as CustomEvent).detail, 'reconnecting');
        assert.equal(client.status, 'reconnecting'); assert.equal(button.disabled, false);
        click(button); click(button);
        assert.equal(selected.mock.callCount(), 0); assertUnadmitted(element, client, button, 'Existing control error');
        assert.equal(button.disabled, false);
      }, { once: true });
      socket.close(); await settle();
      assert.equal(callbacks, 1); assert.equal(client.state, retained);
      assert.equal(button.hidden, false); assert.equal(button.disabled, true);
      click(button); await settle();
      assert.equal(selected.mock.callCount(), 0); assertUnadmitted(element, client, button, 'Existing control error');
      assert.deepEqual(socket.sent, frames); assert.equal(client['mediaRevision'], mediaRevision);
      await tick(500);
      const replacement = sockets[1]!;
      const resume = await hello(replacement);
      assert.equal(resume.resumeToken, 'resume-me'); assert.equal(button.disabled, true);
      replacement.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' }); await settle();
      assert.equal(client['pending'].has(resume.requestId), true, 'resume state restores admission before its ACK');
      assert.equal(client.status, 'live'); assert.equal(element[action.key], button); assert.equal(button.disabled, false);
      click(button); click(button); await tick(100);
      assert.equal(selected.mock.callCount(), 1); assert.equal(button.getAttribute('aria-busy'), 'true');
      const commands = replacement.sent.filter(message => message.type === action.type); assert.equal(commands.length, 1);
      const command = commands[0]!; assert.ok('requestId' in command);
      if (command.type === 'stage:approve') assert.equal(command.targetId, state.me.participantId);
      replacement.deliver({ type: 'ok', requestId: command.requestId });
      replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
      assert.equal(element['pendingActions'].size, 0); assert.equal(button.getAttribute('aria-busy'), null);
      assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
      assert.equal(element['error'].hidden, true);
    });
  }

  for (const phase of ['live', 'reconnecting', 'pre-ACK disconnected'] as const) {
    it(`keeps explicit room leave cleanup available with a ${phase} snapshot`, async t => {
      const fixture = phase === 'pre-ACK disconnected' ? await beforeJoinAck(t, roomState()) : await socketJoinedWidget(t);
      const { element, client, socket, sockets, tick } = fixture;
      if (phase !== 'live') { socket.close(); await settle(); await settle(); }
      assert.equal(client.status, phase === 'pre-ACK disconnected' ? 'disconnected' : phase);
      assert.ok(client.state); assert.equal(element['roomAction'].hidden, false); assert.equal(element['roomAction'].disabled, false);
      const frames = [...socket.sent], disconnect = t.mock.method(client, 'disconnect');
      click(element['roomAction']); await settle(); await settle();
      assert.equal(disconnect.mock.callCount(), 1); assert.equal(element.client, null);
      assert.equal(client.status, 'disconnected'); assert.equal(client.state, null); assert.equal(client['session'], null);
      assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
      assert.equal(client['reconnectTimer'], undefined); assert.equal(element['pendingActions'].size, 0);
      assertRoomControlsHidden(element); assert.equal(element['leftRoom'], true);
      assert.equal(element['roomAction'].textContent, '重新加入'); assert.equal(element['roomAction'].disabled, false);
      await tick(1000);
      assert.equal(sockets.length, 1, 'room leave cancels any reconnect instead of autojoining');
      assert.deepEqual(socket.sent, frames, 'room cleanup never substitutes a personal stage command');
    });
  }
});

describe('widget initial connection feedback', () => {
  it('shows connect and join progress without changing SDK statuses, events or accessibility state', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t);
    const statuses: unknown[] = [];
    element.addEventListener('stage-status', event => { statuses.push((event as CustomEvent).detail); });
    await settle();
    const client = element.client;
    assert.ok(client);
    assert.equal(element['status'].textContent, '連線中…');
    assert.equal(client.status, 'disconnected');
    assertRoomControlsHidden(element);
    assert.equal(element['status'].getAttribute('role'), 'status');
    assert.equal(element['status'].getAttribute('aria-live'), 'polite');
    assert.equal(element['status'].getAttribute('aria-busy'), null);
    assert.equal(element.getAttribute('aria-busy'), null);
    element.playbackMuted = true;
    assert.equal(element['status'].textContent, '連線中…', 'preference renders retain progress');
    const socket = sockets[0]!;
    const request = await hello(socket);
    assert.equal(element['status'].textContent, '正在加入房間…');
    assert.equal(client.status, 'disconnected');
    assert.deepEqual(statuses, [], 'widget-only progress does not fabricate SDK events');
    assertRoomControlsHidden(element);
    for (const key of ['hand', 'mic', 'leaveStage', 'listen', 'unlock'] as const) assert.equal(element[key].getAttribute('aria-busy'), null);
    socket.deliver({ type: 'room:state', ...roomState() }); await settle();
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中', 'state wins before the join ACK');
    assert.equal(element['hand'].hidden, false);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
    assert.deepEqual(statuses, ['live']);
  });

  it('shows the actual hello timeout and recovers on a replacement connection', async t => {
    const { element, sockets, tick, hello } = socketJoiningWidget(t);
    await settle();
    await tick(14999);
    assert.equal(element['error'].hidden, true);
    await tick(1);
    assert.equal(element['status'].textContent, '未連線');
    assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, '連線逾時，請稍後再試。');
    assert.equal(sockets[0]!.readyState, 3);
    assertRoomControlsHidden(element);
    const retired = element.client;
    element.setAttribute('code', 'RETRY'); await settle();
    assert.notEqual(element.client, retired);
    assert.equal(element['error'].hidden, true);
    assert.equal(element['status'].textContent, '連線中…');
    const socket = sockets[1]!;
    const request = await hello(socket);
    assert.equal(request.code, 'RETRY');
    assert.equal(element['status'].textContent, '正在加入房間…');
    socket.deliver({ type: 'room:state', ...roomState() });
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
    assert.equal(element['error'].hidden, true);
  });

  it('clears join progress after the actual ACK timeout before any snapshot and accepts later state', async t => {
    const { element, sockets, tick, hello } = socketJoiningWidget(t);
    await settle();
    const socket = sockets[0]!;
    await hello(socket);
    await tick(14999);
    assert.equal(element['error'].hidden, true);
    await tick(1);
    assert.equal(element['status'].textContent, '未連線');
    assert.equal(element['error'].textContent, '請求逾時，請重試。');
    assert.equal(element['error'].hidden, false);
    assertRoomControlsHidden(element);
    socket.deliver({ type: 'room:state', ...roomState() }); await settle();
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
    assert.equal(element['hand'].hidden, false);
  });

  it('keeps the current live snapshot and controls when its join ACK times out', async t => {
    const { element, sockets, tick, hello } = socketJoiningWidget(t);
    await settle();
    const socket = sockets[0]!;
    await hello(socket);
    socket.deliver({ type: 'room:state', ...roomState(true) }); await settle();
    await tick(15000);
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 台上');
    assert.equal(element['mic'].hidden, false);
    assert.equal(element['listen'].hidden, false);
    assert.equal(element['error'].textContent, '請求逾時，請重試。');
    assert.equal(element['error'].hidden, false);
    element.playbackMuted = true;
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 台上');
  });

  it('clears join progress if an ACK arrives without a room snapshot', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t);
    await settle();
    const socket = sockets[0]!;
    const request = await hello(socket);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assert.equal(element['status'].textContent, '未連線');
    assert.equal(element.client?.state, null);
    assert.equal(element['error'].hidden, true);
    assertRoomControlsHidden(element);
  });

  it('shows the current server join rejection without leaving a pending label', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t);
    await settle();
    const socket = sockets[0]!;
    const request = await hello(socket);
    const forwarded: unknown[] = [];
    element.addEventListener('stage-error', event => { forwarded.push((event as CustomEvent).detail); });
    socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' }); await settle();
    assert.equal(element['status'].textContent, '未連線');
    assert.equal(element['error'].textContent, '房間不存在或代碼錯誤。');
    assert.equal(element['error'].hidden, false);
    assert.equal(forwarded.length, 1);
    assertRoomControlsHidden(element);
  });

  for (const phase of ['connect', 'join'] as const) {
    it(`shows a synchronous ${phase} failure before any room state`, async t => {
      t.mock.method(StageClient.prototype, 'connect', () => {
        if (phase === 'connect') throw new Error('connect failed');
        return Promise.resolve();
      });
      t.mock.method(StageClient.prototype, 'join', () => { throw new Error('join failed'); });
      const element = mountJoiningWidget(); await settle();
      assert.equal(element['status'].textContent, '未連線');
      assert.equal(element['error'].textContent, `${phase} failed`);
      assertRetry(element, true);
      assert.equal(element['error'].hidden, false);
      assertRoomControlsHidden(element);
    });

    for (const outcome of ['resolve', 'reject'] as const) {
      it(`ignores retired ${phase} ${outcome} after rapid room changes and remount`, async t => {
        const { element, connections, joins } = deferredJoiningWidget(t);
        const startPhase = async () => {
          await settle();
          if (phase === 'join') { connections.at(-1)!.pending.resolve(); await settle(); }
          return (phase === 'connect' ? connections : joins).at(-1)!;
        };
        const first = await startPhase();
        element.setAttribute('room', 'two');
        element.setAttribute('room', 'three');
        const second = await startPhase();
        Object.assign(element, { isConnected: false }); element.disconnectedCallback();
        Object.assign(element, { isConnected: true }); element.connectedCallback();
        const current = await startPhase();
        assert.notEqual(current.client, first.client);
        assert.notEqual(current.client, second.client);
        for (const retired of [first, second]) {
          if (outcome === 'resolve') retired.pending.resolve();
          else retired.pending.reject(new Error('retired failure'));
          await retired.client['receive']({ type: 'room:state', ...roomState(true), name: 'Retired room' });
          await retired.client['receive']({ type: 'room:closed', roomId: 'one', reason: 'shutdown' });
          await settle();
          assert.equal(element.client, current.client);
          assertRetry(element, false);
          assert.equal(element['status'].textContent, phase === 'connect' ? '連線中…' : '正在加入房間…');
          assert.equal(element['error'].hidden, true);
          assertRoomControlsHidden(element);
        }
        if (phase === 'connect') {
          assert.equal(joins.length, 0, 'retired connect completions cannot join');
          current.pending.resolve(); await settle();
        }
        await current.client['receive']({ type: 'room:state', ...roomState(false, 'three'), name: 'Current room' });
        joins.at(-1)!.pending.resolve(); await settle();
        assert.equal(element['status'].textContent, 'Current room · 直播中 · 收聽中');
      });
    }

    it(`clears ${phase} progress on removal and ignores its late rejection`, async t => {
      const { element, connections, joins } = deferredJoiningWidget(t);
      await settle();
      if (phase === 'join') { connections[0]!.pending.resolve(); await settle(); }
      const pending = (phase === 'connect' ? connections : joins)[0]!.pending;
      Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
      assert.equal(element.client, null);
      assert.equal(element['status'].textContent, '');
      pending.reject(new Error('removed failure')); await settle();
      assertRetry(element, false);
      assert.equal(element['status'].textContent, '');
      assert.equal(element['error'].hidden, true);
      element.removeAttribute('name');
      Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
      assert.equal(element['status'].textContent, '請設定 room 與 name 屬性。');
      assert.equal(element.client, null);
    });
  }

  for (const terminal of terminalCases) {
    for (const outcome of ['resolve', 'reject'] as const) {
      it(`preserves ${terminal.title} before any snapshot when the pending join later ${outcome}s`, async t => {
        const { element, connections, joins } = deferredJoiningWidget(t);
        await settle(); connections[0]!.pending.resolve(); await settle();
        await element.client!['receive'](terminal.message);
        assert.equal(element['status'].textContent, terminal.text);
        if (outcome === 'resolve') joins[0]!.pending.resolve();
        else joins[0]!.pending.reject(new Error('late join failure'));
        await settle();
        assert.equal(element['status'].textContent, terminal.text);
        assertRetry(element, false);
        if (outcome === 'reject') assert.equal(element['error'].textContent, 'late join failure', 'existing current-client error behavior remains');
        element.playbackMuted = true;
        assert.equal(element['status'].textContent, terminal.text);
        assertRoomControlsHidden(element);
      });
    }
  }

  it('preserves disconnected status after a live pending join settles', async t => {
    const { element, connections, joins } = deferredJoiningWidget(t);
    await settle(); connections[0]!.pending.resolve(); await settle();
    const client = element.client!;
    await client['receive']({ type: 'room:state', ...roomState() });
    await client.disconnect();
    assert.equal(element['status'].textContent, '未連線');
    joins[0]!.pending.resolve(); await settle();
    assert.equal(element['status'].textContent, '未連線');
    element.playbackMuted = true;
    assert.equal(element['status'].textContent, '未連線');
    assertRoomControlsHidden(element);
  });

  it('does not let a rejected join overwrite a replacement started by its forwarded error', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t);
    await settle();
    const socket = sockets[0]!;
    const request = await hello(socket);
    const retired = element.client;
    element.addEventListener('stage-error', () => { element.setAttribute('room', 'two'); }, { once: true });
    socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' }); await settle();
    assert.notEqual(element.client, retired);
    assert.equal(element['status'].textContent, '連線中…');
    assert.equal(element['error'].hidden, true);
    const replacement = sockets[1]!;
    await hello(replacement);
    assert.equal(element['status'].textContent, '正在加入房間…');
    assert.equal(element['error'].hidden, true);
  });
});

function assertRetry(element: InstanceType<typeof StageElement>, available: boolean): void {
  const retry = element['retry'];
  assert.equal(retry.tagName, 'BUTTON');
  assert.equal(retry.type, 'button');
  assert.equal(retry.textContent, '重試加入');
  assert.equal(retry.hidden, !available, 'retry visibility follows the current initial attempt');
  assert.equal(retry.disabled, !available, 'a hidden retry cannot enter a fresh join');
}

function assertCancelJoin(element: InstanceType<typeof StageElement>, available: boolean): void {
  const cancel = element['cancelJoin'];
  assert.equal(cancel.tagName, 'BUTTON');
  assert.equal(cancel.type, 'button');
  assert.equal(cancel.textContent, '取消加入');
  assert.equal(cancel.hidden, !available, 'cancel visibility belongs to the pending initial attempt');
  assert.equal(cancel.disabled, !available, 'hidden cancellation cannot enter an action');
}

describe('widget manual initial join cancellation', () => {
  it('keeps cancellation hidden and inert before an initial attempt', async () => {
    const element = new StageElement(); widgets.push(element);
    assertCancelJoin(element, false); assertRetry(element, false);
    click(element['cancelJoin']); await settle();
    assert.equal(element.client, null);
    assert.equal(element['status'].textContent, '請設定 room 與 name 屬性。');
    assert.equal(element['error'].hidden, true);
    assert.equal(element['cancelJoin'].getAttribute('aria-busy'), null);
  });

  for (const phase of ['hello', 'queued join', 'join ACK'] as const) {
    for (const closeMode of ['stalled', 'throwing'] as const) {
      it(`cancels actual ${phase} waiting despite ${closeMode} close and releases the owned SDK resources`, async t => {
        const { element, sockets, hello, tick } = socketJoiningWidget(t);
        const scheduled = t.mock.method(globalThis, 'setTimeout');
        const cleared = t.mock.method(globalThis, 'clearTimeout');
        const statuses: unknown[] = [], errors: unknown[] = [];
        element.addEventListener('stage-status', event => statuses.push((event as CustomEvent).detail));
        element.addEventListener('stage-error', event => errors.push((event as CustomEvent).detail));
        await settle();
        const client = element.client!, socket = sockets[0]!;
        assertCancelJoin(element, true); assertRetry(element, false);
        if (phase === 'join ACK') await hello(socket);
        else if (phase === 'queued join') { socket.hello(); await settle(); assert.equal(socket.sent.length, 0); }
        else socket.readyState = 1;
        const timers = phase === 'hello' ? [scheduled.mock.calls[0]!.result]
          : [...client['pending'].values()].flatMap(pending => [pending.timer, pending.sendTimer].filter(value => value !== undefined));
        assert.ok(timers.length > 0);
        const close = t.mock.method(socket, 'close', () => {
          if (closeMode === 'throwing') throw new Error('stalled transport close failed');
          socket.readyState = 2;
        });
        const cancel = element['cancelInitial']; assert.ok(cancel);
        const generation = element['generation'];
        click(element['cancelJoin']);
        assertCancelJoin(element, false); assertRetry(element, true);
        assert.equal(element['status'].textContent, '已取消加入。');
        click(element['cancelJoin']); await cancel(); await settle(); await settle();
        assert.equal(close.mock.callCount(), 1);
        assert.equal(element.client, client, 'cancellation retains the exposed client and its event forwarding');
        assert.equal(element['generation'], generation);
        assert.equal(client.status, 'disconnected'); assert.equal(client.state, null);
        assert.equal(client['socket'], null); assert.equal(client['connecting'], null); assert.equal(client['helloWait'], null);
        assert.equal(client['session'], null); assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
        assert.equal(client['keepaliveTimer'], undefined); assert.equal(client['reconnectTimer'], undefined);
        assert.equal(client['audio'].isConnected, false); assert.equal(getEventListeners(window, 'pagehide').length, 0);
        for (const timer of timers) assert.ok(cleared.mock.calls.some(call => call.arguments[0] === timer), 'owned deadline and unsent pacing work are cleared');
        assert.equal(element['error'].hidden, true); assertRoomControlsHidden(element);
        assert.equal(element['cancelJoin'].getAttribute('aria-busy'), null); assert.equal(element['pendingActions'].size, 0);
        await tick(30000);
        assert.equal(sockets.length, 1, 'cancellation never starts automatic retry');
        assert.equal(close.mock.callCount(), 1, 'a retired deadline cannot close the transport again');
        assert.equal(socket.sent.length, phase === 'join ACK' ? 1 : 0);
        assert.equal(element['status'].textContent, '已取消加入。');
        assert.deepEqual(statuses, [], 'initial SDK status is already disconnected; widget cancellation must render explicitly');
        assert.deepEqual(errors, []);
        await client['receive']({ type: 'error', code: 'bad_request', message: 'current exposed client error' });
        assert.equal(element['error'].textContent, 'current exposed client error');
        assert.deepEqual(errors.map(error => (error as Error).message), ['current exposed client error']);
      });
    }
  }

  it('does not enter join when hello resolved just before the cancellation click', async t => {
    const { element, sockets, tick } = socketJoiningWidget(t); await settle();
    const client = element.client!, socket = sockets[0]!;
    const join = t.mock.method(client, 'join');
    socket.hello();
    click(element['cancelJoin']);
    await settle(); await tick(0);
    assert.equal(join.mock.callCount(), 0, 'the fulfilled connect continuation must check its cancellation token');
    assert.equal(sockets.length, 1); assert.equal(socket.sent.length, 0);
    assert.equal(client['socket'], null); assert.equal(client['session'], null);
    assertCancelJoin(element, false); assertRetry(element, true);
    assert.equal(element['status'].textContent, '已取消加入。'); assert.equal(element['error'].hidden, true);
  });

  it('allows repeated cancellation and manual retry with one new client per click and current preferences', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t, {
      url: 'wss://stage.example.test/ws', room: ' one ', name: ' Listener ', code: ' SECRET ',
      'playback-muted': '', 'playback-volume': '0.375',
    });
    await settle();
    const retired: StageClient[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = element.client!; retired.push(client);
      assertCancelJoin(element, true); assertRetry(element, false);
      if (attempt !== 0) {
        const request = await hello(sockets[attempt]!);
        assert.deepEqual({ roomId: request.roomId, name: request.name, code: request.code }, { roomId: 'one', name: 'Listener', code: 'SECRET' });
        assert.equal(request.resumeToken, undefined);
      }
      click(element['cancelJoin']); assertCancelJoin(element, false); assertRetry(element, true);
      element.playbackVolume = 0.25; element.playbackMuted = false;
      const generation = element['generation'];
      click(element['retry']); click(element['retry']); await settle(); await settle();
      assert.equal(element['generation'], generation + 1);
      assert.equal(sockets.length, attempt + 2); assert.notEqual(element.client, client);
      assert.equal(element.client?.playbackMuted, false); assert.equal(element.client?.playbackVolume, 0.25);
      assert.equal(element.client!['options'].url, 'wss://stage.example.test/ws');
      assert.equal(element['status'].textContent, '連線中…'); assert.equal(element['error'].hidden, true);
      assertCancelJoin(element, true); assertRetry(element, false);
      assert.equal(element['cancelJoin'].getAttribute('aria-busy'), null); assert.equal(element['pendingActions'].size, 0);
      assert.equal(client['socket'], null); assert.equal(client['audio'].isConnected, false);
    }
    const socket = sockets[3]!, request = await hello(socket);
    socket.deliver({ type: 'room:state', ...roomState() });
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assertCancelJoin(element, false); assertRetry(element, false);
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
    assert.equal(retired.every(client => client['session'] === null && client['pending'].size === 0), true);
  });

  it('allows a synchronous cancelled-status listener to retry without the old continuation clearing the new control', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const retired = element.client!;
    await retired['receive']({ type: 'status', state: 'waiting' });
    const cancel = element['cancelInitial']; assert.ok(cancel);
    const forwarded: string[] = [];
    element.addEventListener('stage-status', event => {
      if ((event as CustomEvent).detail !== 'disconnected') return;
      forwarded.push(element['status'].textContent ?? '');
      assertCancelJoin(element, false); assertRetry(element, true);
      click(element['cancelJoin']); click(element['retry']); click(element['retry']);
    });
    click(element['cancelJoin']); await settle(); await settle();
    assert.deepEqual(forwarded, ['已取消加入。']);
    assert.equal(sockets.length, 2); assert.notEqual(element.client, retired);
    assertCancelJoin(element, true); assertRetry(element, false);
    await cancel(); await settle();
    assert.equal(sockets.length, 2); assertCancelJoin(element, true);
    const request = await hello(sockets[1]!);
    sockets[1]!.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assertCancelJoin(element, false); assertRetry(element, false);
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`isolates delayed cancellation cleanup ${outcome} from a new cancellation pending on the reused button`, async t => {
      const { element, sockets } = socketJoiningWidget(t); await settle();
      const retired = element.client!, oldCleanup = deferred(), newCleanup = deferred();
      t.after(() => { oldCleanup.resolve(); newCleanup.resolve(); });
      const disconnect = retired.disconnect.bind(retired);
      let calls = 0;
      t.mock.method(retired, 'disconnect', () => {
        void disconnect();
        return ++calls === 1 ? oldCleanup.promise : Promise.resolve();
      });
      click(element['cancelJoin']);
      assert.equal(element['cancelJoin'].getAttribute('aria-busy'), 'true'); assertRetry(element, true);
      click(element['retry']); await settle(); await settle();
      const current = element.client!; assert.notEqual(current, retired); assert.equal(sockets.length, 2);
      const disconnectCurrent = current.disconnect.bind(current);
      t.mock.method(current, 'disconnect', () => { void disconnectCurrent(); return newCleanup.promise; });
      click(element['cancelJoin']); await settle();
      assert.equal(element['cancelJoin'].getAttribute('aria-busy'), 'true');
      assert.equal(element['pendingActions'].has(element['cancelJoin']), true);
      if (outcome === 'resolve') oldCleanup.resolve(); else oldCleanup.reject(new Error('retired cleanup failure'));
      await settle(); await settle();
      assert.equal(element.client, current); assert.equal(element['status'].textContent, '已取消加入。');
      assert.equal(element['error'].hidden, true); assertRetry(element, true); assertCancelJoin(element, false);
      assert.equal(element['cancelJoin'].getAttribute('aria-busy'), 'true', 'retired finally cannot unlock the new button action');
      assert.equal(element['pendingActions'].has(element['cancelJoin']), true);
      newCleanup.resolve(); await settle();
      assert.equal(element['cancelJoin'].getAttribute('aria-busy'), null); assert.equal(element['pendingActions'].size, 0);
    });
  }

  it('keeps the cancelled exposed client usable and forwards its later public join and ordinary disconnect', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const client = element.client!, cancel = element['cancelInitial']; assert.ok(cancel);
    click(element['cancelJoin']); await settle();
    const events: { type: string; detail: unknown }[] = [];
    for (const type of ['status', 'state']) element.addEventListener(`stage-${type}`, event => events.push({ type, detail: (event as CustomEvent).detail }));
    const joining = client.join({ roomId: 'public-room', name: 'Public caller' });
    const socket = sockets[1]!, request = await hello(socket);
    assert.equal(request.roomId, 'public-room');
    socket.deliver({ type: 'room:state', ...roomState(false, 'public-room') });
    socket.deliver({ type: 'ok', requestId: request.requestId }); await joining; await settle();
    assert.equal(element.client, client); assertCancelJoin(element, false); assertRetry(element, false);
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
    assert.equal(element['hand'].hidden, false); assert.deepEqual(events.map(event => event.type), ['status', 'state']);
    await cancel(); assert.equal(client['socket'], socket);
    await client.disconnect(); await settle();
    assert.equal(element.client, client); assert.equal(element['status'].textContent, '未連線');
    assertCancelJoin(element, false); assertRetry(element, false); assertRoomControlsHidden(element);
    assert.deepEqual(events.filter(event => event.type === 'status').map(event => event.detail), ['live', 'disconnected']);
    assert.equal(element['error'].hidden, true);
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    for (const phase of ['connect', 'join'] as const) {
      it(`isolates cancelled ${phase} late ${outcome} while a manual retry owns the same widget`, async t => {
        const { element, connections, joins } = deferredJoiningWidget(t); await settle();
        if (phase === 'join') { connections[0]!.pending.resolve(); await settle(); }
        const old = (phase === 'connect' ? connections : joins)[0]!;
        const cancel = element['cancelInitial']; assert.ok(cancel);
        click(element['cancelJoin']); assertRetry(element, true);
        click(element['retry']); await settle();
        const current = element.client!; assert.notEqual(current, old.client);
        assertCancelJoin(element, true);
        if (outcome === 'resolve') old.pending.resolve(); else old.pending.reject(new Error('cancelled old failure'));
        await cancel(); await settle(); await settle();
        assert.equal(element.client, current); assertCancelJoin(element, true); assertRetry(element, false);
        assert.equal(element['status'].textContent, '連線中…'); assert.equal(element['error'].hidden, true);
        assert.equal(element['pendingActions'].size, 0); assert.equal(element['cancelJoin'].getAttribute('aria-busy'), null);
        assert.equal(joins.length, phase === 'join' ? 1 : 0, 'a late cancelled connect must not start join');
        click(element['cancelJoin']); await settle();
        assert.equal(element['status'].textContent, '已取消加入。'); assertRetry(element, true);
      });
    }
  }

  for (const phase of ['connect', 'join'] as const) {
    it(`suppresses only the manually cancelled ${phase} rejection and preserves a later current error`, async t => {
      const { element, connections, joins } = deferredJoiningWidget(t); await settle();
      if (phase === 'join') { connections[0]!.pending.resolve(); await settle(); }
      const pending = (phase === 'connect' ? connections : joins)[0]!.pending;
      click(element['cancelJoin']); await settle();
      await element.client!['receive']({ type: 'error', code: 'bad_request', message: 'independent current error' });
      pending.reject(new Error('manually cancelled failure')); await settle();
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'independent current error');
      assert.equal(element['status'].textContent, '已取消加入。'); assertCancelJoin(element, false); assertRetry(element, true);
      element.playbackMuted = true; assert.equal(element['status'].textContent, '已取消加入。');
    });
  }

  for (const mode of ['reject', 'throw'] as const) {
    it(`shows a ${mode} from cancellation cleanup without replacing it with the cancelled connect error`, async t => {
      const { element, sockets } = socketJoiningWidget(t); await settle();
      const client = element.client!, disconnect = client.disconnect.bind(client);
      const cancel = t.mock.method(client, 'disconnect', () => {
        void disconnect();
        if (mode === 'throw') throw new Error('cancel cleanup failed');
        return Promise.reject(new Error('cancel cleanup failed'));
      });
      t.after(() => cancel.mock.restore());
      click(element['cancelJoin']); await settle(); await settle();
      assert.equal(cancel.mock.callCount(), 1); assert.equal(client['socket'], null);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'cancel cleanup failed');
      assert.equal(element['status'].textContent, '已取消加入。'); assertCancelJoin(element, false); assertRetry(element, true);
      cancel.mock.restore(); click(element['retry']); await settle();
      assert.equal(sockets.length, 2); assert.equal(element['error'].hidden, true); assertCancelJoin(element, true);
    });
  }

  it('revokes cancellation before forwarding live status and never restores it after a state-before-ACK disconnect', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const client = element.client!, socket = sockets[0]!, request = await hello(socket);
    const cancel = element['cancelInitial']; assert.ok(cancel);
    const disconnect = t.mock.method(client, 'disconnect');
    let live = 0;
    element.addEventListener('stage-status', event => {
      if ((event as CustomEvent).detail !== 'live') return;
      live++; assert.ok(client.state); assertCancelJoin(element, false); assertRetry(element, false);
      click(element['cancelJoin']); void cancel();
      assert.equal(disconnect.mock.callCount(), 0, 'state ownership is visible before the later state event');
      void client.disconnect();
    });
    socket.deliver({ type: 'room:state', ...roomState() }); await settle(); await settle();
    assert.equal(live, 1); assert.equal(disconnect.mock.callCount(), 1);
    assert.equal(client.state, null); assert.equal(client['pending'].has(request.requestId), false);
    assertCancelJoin(element, false); assertRetry(element, false);
    click(element['cancelJoin']); await cancel(); await settle();
    assert.equal(disconnect.mock.callCount(), 1); assert.equal(sockets.length, 1);
    assert.equal(element['status'].textContent, '未連線');
  });

  it('does not offer cancellation or retry after a successful ACK without state, or during an established reconnect', async t => {
    const { element, sockets, hello, tick } = socketJoiningWidget(t); await settle();
    const client = element.client!, socket = sockets[0]!, request = await hello(socket);
    const cancel = element['cancelInitial']; assert.ok(cancel);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assertCancelJoin(element, false); assertRetry(element, false);
    await cancel(); assert.equal(client['socket'], socket);
    socket.deliver({ type: 'room:state', ...roomState(), resumeToken: 'resume-me' }); await settle();
    socket.close(); await settle(); assert.equal(client.status, 'reconnecting');
    assertCancelJoin(element, false); assertRetry(element, false);
    click(element['cancelJoin']); await cancel(); await tick(500);
    assert.equal(sockets.length, 2); assert.equal(element.client, client);
    assertCancelJoin(element, false); assertRetry(element, false);
  });

  for (const terminal of terminalCases) {
    for (const phase of ['connect', 'join', 'cancelled'] as const) {
      it(`preserves ${terminal.title} precedence over ${phase} cancellation and retired callbacks`, async t => {
        const { element, connections, joins } = deferredJoiningWidget(t); await settle();
        if (phase === 'join') { connections[0]!.pending.resolve(); await settle(); }
        const client = element.client!, cancel = element['cancelInitial']; assert.ok(cancel);
        if (phase === 'cancelled') { click(element['cancelJoin']); await settle(); assertRetry(element, true); }
        const generation = element['generation'];
        element.addEventListener(`stage-${terminal.event}`, () => {
          assertCancelJoin(element, false); assertRetry(element, false);
          click(element['cancelJoin']); click(element['retry']); void cancel();
        });
        await client['receive'](terminal.message); await settle();
        assert.equal(element['status'].textContent, terminal.text); assertCancelJoin(element, false); assertRetry(element, false);
        (phase === 'join' ? joins[0]! : connections[0]!).pending.reject(new Error('retired initial failure')); await settle();
        element.playbackMuted = true; await cancel(); await settle();
        assert.equal(element.client, client); assert.equal(element['generation'], generation);
        assert.equal(element['status'].textContent, terminal.text); assertCancelJoin(element, false); assertRetry(element, false);
        assertRoomControlsHidden(element);
      });
    }
  }

  for (const transition of ['attributes', 'remount'] as const) {
    it(`retires cancelled SDK callbacks and its closure on ${transition} without touching the replacement`, async t => {
      const { element, sockets, hello } = socketJoiningWidget(t, { 'playback-muted': '', 'playback-volume': '0.25' }); await settle();
      const retired = element.client!, socket = sockets[0]!, request = await hello(socket);
      const cancel = element['cancelInitial']; assert.ok(cancel);
      const message = socket.onmessage, close = socket.onclose;
      click(element['cancelJoin']);
      if (transition === 'attributes') {
        element.setAttribute('room', 'two'); element.setAttribute('name', 'Replacement'); element.setAttribute('code', 'NEW');
      } else {
        Object.assign(element, { isConnected: false }); element.disconnectedCallback();
        assertCancelJoin(element, false); assertRetry(element, false);
        Object.assign(element, { isConnected: true }); element.connectedCallback();
      }
      await settle(); await settle();
      const current = element.client!; assert.notEqual(current, retired); assert.equal(sockets.length, 2);
      const forwarded: string[] = [];
      for (const type of ['status', 'state', 'error', 'closed', 'kicked']) element.addEventListener(`stage-${type}`, () => forwarded.push(type));
      for (const value of [
        { type: 'ok', requestId: request.requestId },
        { type: 'room:state', ...roomState(true), name: 'Retired room' },
        { type: 'error', code: 'bad_request', message: 'retired cancellation failure' },
        ...terminalCases.map(item => item.message),
      ] satisfies ServerMessage[]) {
        message?.({ data: JSON.stringify(value) }); await retired['receive'](value); await settle();
      }
      close?.(); await cancel(); await settle();
      assert.equal(element.client, current); assertCancelJoin(element, true); assertRetry(element, false);
      assert.equal(element['status'].textContent, '連線中…'); assert.equal(element['error'].hidden, true); assert.deepEqual(forwarded, []);
      assert.equal(current.playbackMuted, true); assert.equal(current.playbackVolume, 0.25);
      assert.equal(element['cancelJoin'].getAttribute('aria-busy'), null); assert.equal(element['pendingActions'].size, 0);
      const next = await hello(sockets[1]!);
      assert.equal(next.roomId, transition === 'attributes' ? 'two' : 'one');
      assert.equal(next.name, transition === 'attributes' ? 'Replacement' : 'Listener');
      assert.equal(next.code, transition === 'attributes' ? 'NEW' : undefined);
      click(element['cancelJoin']); await settle();
      assert.equal(current['socket'], null); assert.equal(element['status'].textContent, '已取消加入。'); assertRetry(element, true);
    });
  }

  it('keeps an ordinary disconnected initial failure visible and never calls it manual cancellation', async t => {
    const { element, sockets } = socketJoiningWidget(t); await settle();
    const cancel = element['cancelInitial']; assert.ok(cancel);
    sockets[0]!.close(); await settle(); await settle();
    assertCancelJoin(element, false); assertRetry(element, true);
    assert.equal(element['status'].textContent, '未連線');
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, '連線已中斷。');
    await cancel(); click(element['cancelJoin']); await settle();
    assert.equal(element['status'].textContent, '未連線'); assert.equal(element['error'].hidden, false);
  });
});

describe('widget manual initial join retry', () => {
  it('uses a native button and stays unavailable before failure, including unrelated SDK errors', async t => {
    const empty = new StageElement(); widgets.push(empty);
    assertRetry(empty, false);
    empty.connectedCallback(); await settle();
    assertRetry(empty, false);
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    assertRetry(element, false);
    const client = element.client!;
    await client['receive']({ type: 'error', code: 'bad_request', message: '收到無法解析的伺服器訊息。' });
    assertRetry(element, false);
    click(element['retry']); await settle();
    assert.equal(element.client, client);
    assert.equal(sockets.length, 1);
    const request = await hello(sockets[0]!);
    assertRetry(element, false);
    await client['receive']({ type: 'error', code: 'bad_request', message: '收到無法解析的伺服器訊息。' });
    assertRetry(element, false);
    sockets[0]!.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assert.equal(client.state, null, 'a successful ACK without a snapshot is not a failed attempt');
    assertRetry(element, false);
  });

  it('retries repeated server rejections once per click, keeps preferences and retires the old SDK resources', async t => {
    const { element, sockets, hello, tick } = socketJoiningWidget(t, {
      url: 'wss://stage.example.test/ws', room: ' one ', name: ' Listener ', code: ' SECRET ',
      'playback-muted': '', 'playback-volume': '0.375',
    });
    const statuses: unknown[] = [], errors: unknown[] = [];
    element.addEventListener('stage-status', event => { statuses.push((event as CustomEvent).detail); });
    element.addEventListener('stage-error', event => { errors.push((event as CustomEvent).detail); });
    await settle();
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = element.client!, socket = sockets[attempt]!;
      assert.equal(client.playbackMuted, true);
      assert.equal(client.playbackVolume, 0.375);
      assert.equal(client['options'].url, 'wss://stage.example.test/ws');
      assertRetry(element, false);
      const request = await hello(socket);
      assert.deepEqual({ roomId: request.roomId, name: request.name, code: request.code, resumeToken: request.resumeToken },
        { roomId: 'one', name: 'Listener', code: 'SECRET', resumeToken: undefined });
      socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' });
      await settle();
      assertRetry(element, true);
      assert.equal(element['error'].textContent, '房間不存在或代碼錯誤。');
      assert.equal(element['error'].hidden, false);
      assert.equal(element['retry'].getAttribute('aria-busy'), null);
      assert.equal(client['pending'].size, 0);
      await tick(1000);
      assert.equal(sockets.length, attempt + 1, 'a failed initial join never starts an automatic retry');
      const generation = element['generation'];
      click(element['retry']);
      assertRetry(element, false);
      click(element['retry']);
      await settle();
      assert.equal(element['generation'], generation + 1, 'a double click starts exactly one new generation');
      assert.equal(sockets.length, attempt + 2);
      assert.notEqual(element.client, client);
      assert.equal(socket.readyState, 3);
      assert.equal(client['audio'].isConnected, false);
      assert.equal(client['socket'], null);
      assert.equal(client['keepaliveTimer'], undefined);
      assert.equal(client['reconnectTimer'], undefined);
      assert.equal(client['pending'].size, 0);
      assert.equal(element['pendingActions'].size, 0);
      assert.equal(element['retry'].getAttribute('aria-busy'), null);
      assert.equal(element['error'].hidden, true);
      assert.equal(element['status'].textContent, '連線中…');
      assertRoomControlsHidden(element);
    }
    assert.deepEqual(statuses, [], 'manual retry adds no SDK status events');
    assert.equal(errors.length, 2, 'the SDK rejection event is forwarded once per failed request');
    const socket = sockets[2]!, request = await hello(socket);
    socket.deliver({ type: 'room:state', ...roomState() }); await settle();
    assertRetry(element, false);
    assert.equal(element.client!['pending'].has(request.requestId), true, 'state hides retry before ACK');
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assertRetry(element, false);
    assert.equal(element.client?.playbackMuted, true);
    assert.equal(element.client?.playbackVolume, 0.375);
    assert.equal(element['error'].hidden, true);
    assert.deepEqual(statuses, ['live']);
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 收聽中');
  });

  for (const phase of ['hello', 'join ACK'] as const) {
    it(`offers manual recovery only after the real ${phase} deadline and can fail again`, async t => {
      const { element, sockets, tick, hello } = socketJoiningWidget(t); await settle();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (phase === 'join ACK') await hello(sockets[attempt]!);
        assertRetry(element, false);
        await tick(14999); assertRetry(element, false);
        await tick(1); assertRetry(element, true);
        assert.equal(element.client?.state, null);
        assert.equal(element['error'].textContent, phase === 'hello' ? '連線逾時，請稍後再試。' : '請求逾時，請重試。');
        assert.equal(element.client!['pending'].size, 0);
        await tick(1000);
        assert.equal(sockets.length, attempt + 1);
        click(element['retry']); click(element['retry']); await settle();
        assertRetry(element, false);
        assert.equal(sockets.length, attempt + 2);
        assert.equal(element['error'].hidden, true);
      }
    });
  }

  it('stays unavailable while asynchronous retirement is pending and admits only one replacement', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const client = element.client!, socket = sockets[0]!, request = await hello(socket);
    socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' }); await settle();
    const cleanup = deferred();
    t.after(() => { cleanup.resolve(); });
    const disconnect = client.disconnect.bind(client);
    const retire = t.mock.method(client, 'disconnect', async () => { await disconnect(); await cleanup.promise; });
    click(element['retry']);
    assertRetry(element, false);
    assert.equal(element.client, null);
    element.playbackMuted = true;
    element.playbackVolume = 0.25;
    click(element['retry']); await settle();
    assert.equal(retire.mock.callCount(), 1);
    assert.equal(sockets.length, 1);
    cleanup.resolve(); await settle();
    assert.equal(sockets.length, 2);
    assertRetry(element, false);
    const replacement = element.client as StageClient | null;
    assert.ok(replacement);
    assert.equal(replacement.playbackMuted, true);
    assert.equal(replacement.playbackVolume, 0.25);
  });

  it('withdraws an offered retry if the current late room snapshot arrives', async t => {
    const { element, sockets, hello, tick } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!;
    await hello(socket); await tick(15000);
    assertRetry(element, true);
    const client = element.client;
    element.addEventListener('stage-status', event => {
      if ((event as CustomEvent).detail === 'live') click(element['retry']);
    });
    socket.deliver({ type: 'room:state', ...roomState() }); await settle();
    assertRetry(element, false);
    click(element['retry']); await settle();
    assert.equal(element.client, client);
    assert.equal(sockets.length, 1);
    assert.equal(element['hand'].hidden, false);
  });

  for (const outcome of ['rejection', 'timeout', 'disconnect'] as const) {
    it(`never treats a state-before-ACK ${outcome} as an initial join retry`, async t => {
      const { element, sockets, hello, tick } = socketJoiningWidget(t); await settle();
      const socket = sockets[0]!, request = await hello(socket), client = element.client!;
      socket.deliver({ type: 'room:state', ...roomState() }); await settle();
      assertRetry(element, false);
      if (outcome === 'disconnect') await client.disconnect();
      else if (outcome === 'rejection') socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' });
      if (outcome === 'timeout') await tick(15000);
      await settle();
      assertRetry(element, false);
      element.playbackMuted = true;
      assertRetry(element, false);
      click(element['retry']); await settle();
      assert.equal(element.client, client);
      assert.equal(sockets.length, 1);
    });
  }

  it('remembers state received before a forwarded live-status listener disconnects the SDK', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, request = await hello(socket), client = element.client!;
    let states = 0;
    element.addEventListener('stage-state', () => { states++; });
    element.addEventListener('stage-status', event => {
      if ((event as CustomEvent).detail === 'live') void client.disconnect();
    });
    socket.deliver({ type: 'room:state', ...roomState() }); await settle(); await settle();
    assert.equal(states, 0, 'disconnect during status forwarding suppresses the SDK state event');
    assert.equal(client.status, 'disconnected');
    assert.equal(client.state, null);
    assert.equal(client['pending'].has(request.requestId), false);
    assertRetry(element, false);
    click(element['retry']); await settle();
    assert.equal(element.client, client);
    assert.equal(sockets.length, 1);
  });

  it('does not offer a fresh join during the SDK reconnect loop or after a rejected resume', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t);
    socket.close(); await settle();
    assert.equal(client.status, 'reconnecting'); assertRetry(element, false);
    click(element['retry']); await tick(500);
    assert.equal(sockets.length, 2); assertRetry(element, false);
    const replacement = sockets[1]!, resume = await hello(replacement);
    assert.equal(resume.resumeToken, 'resume-me'); assertRetry(element, false);
    replacement.deliver({ type: 'error', requestId: resume.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' });
    await settle(); await settle();
    assert.equal(client.status, 'disconnected');
    assert.equal(client.state, null);
    assertRetry(element, false);
    click(element['retry']); await tick(1000);
    assert.equal(element.client, client);
    assert.equal(sockets.length, 2);
  });

  for (const terminal of terminalCases) {
    for (const phase of ['connecting', 'joining', 'retry offered'] as const) {
      it(`gives ${terminal.title} precedence while ${phase}`, async t => {
        const { element, sockets, hello, tick } = socketJoiningWidget(t); await settle();
        const socket = sockets[0]!;
        if (phase !== 'connecting') {
          const request = await hello(socket);
          if (phase === 'retry offered') {
            socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' });
            await settle(); assertRetry(element, true);
          }
        }
        const client = element.client!, generation = element['generation'];
        element.addEventListener(`stage-${terminal.event}`, () => { click(element['retry']); });
        socket.deliver(terminal.message); await settle(); await settle();
        assert.equal(element.client, client, 'a terminal-event listener cannot activate a previously offered retry');
        assert.equal(element['generation'], generation);
        assert.equal(element['status'].textContent, terminal.text);
        assertRetry(element, false);
        assertRoomControlsHidden(element);
        await client['receive']({ type: 'error', code: 'bad_request', message: 'late current error' });
        element.playbackMuted = true;
        click(element['retry']); await tick(15000);
        assertRetry(element, false);
        assert.equal(element['status'].textContent, terminal.text);
        assert.equal(sockets.length, 1);
      });
    }
  }

  it('ignores retired socket and SDK errors, states and terminal events after manual retry', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const retired = element.client!, socket = sockets[0]!, request = await hello(socket);
    socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' }); await settle();
    click(element['retry']); await settle();
    const client = element.client!, replacement = sockets[1]!;
    await hello(replacement);
    const forwarded: string[] = [];
    for (const type of ['error', 'state', 'status', 'closed', 'kicked']) element.addEventListener(`stage-${type}`, () => { forwarded.push(type); });
    const late: ServerMessage[] = [
      { type: 'error', requestId: request.requestId, code: 'bad_request', message: 'retired failure' },
      { type: 'room:state', ...roomState(true), name: 'Retired room' },
      ...terminalCases.map(terminal => terminal.message),
    ];
    for (const message of late) {
      socket.deliver(message);
      await retired['receive'](message);
      await settle();
      assert.equal(element.client, client);
      assertRetry(element, false);
      assert.equal(element['error'].hidden, true);
      assert.equal(element['status'].textContent, '正在加入房間…');
    }
    assert.deepEqual(forwarded, []);
    assert.equal(sockets.length, 2);
  });

  for (const phase of ['connect', 'join'] as const) {
    it(`ignores an old manual retry ${phase} rejection after rapid replacement and remount`, async t => {
      const { element, connections, joins } = deferredJoiningWidget(t); await settle();
      const enterPhase = async () => {
        if (phase === 'join') { connections.at(-1)!.pending.resolve(); await settle(); }
        return (phase === 'connect' ? connections : joins).at(-1)!;
      };
      const first = await enterPhase();
      first.pending.reject(new Error('initial failure')); await settle();
      assertRetry(element, true);
      click(element['retry']); await settle();
      const retired = await enterPhase();
      assertRetry(element, false);
      element.setAttribute('room', 'two');
      Object.assign(element, { isConnected: false }); element.disconnectedCallback();
      Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
      const current = await enterPhase();
      assert.notEqual(current.client, retired.client);
      retired.pending.reject(new Error('retired retry failure')); await settle();
      assert.equal(element.client, current.client);
      assertRetry(element, false);
      assert.equal(element['error'].hidden, true);
      assert.equal(element['retry'].getAttribute('aria-busy'), null);
      assert.equal(element['pendingActions'].size, 0);
      assert.equal(element['status'].textContent, phase === 'connect' ? '連線中…' : '正在加入房間…');
      if (phase === 'connect') { current.pending.resolve(); await settle(); }
      await current.client['receive']({ type: 'room:state', ...roomState(false, 'two') });
      joins.at(-1)!.pending.resolve(); await settle();
      assertRetry(element, false);
      assert.equal(element['hand'].hidden, false);
    });
  }

  for (const transition of ['attribute change', 'remount'] as const) {
    it(`resets retry eligibility on ${transition} and preserves playback preferences`, async t => {
      const { element, sockets, hello } = socketJoiningWidget(t, { 'playback-muted': '', 'playback-volume': '0.25' }); await settle();
      const retired = element.client!, socket = sockets[0]!, request = await hello(socket);
      socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' }); await settle();
      assertRetry(element, true);
      if (transition === 'attribute change') {
        element.setAttribute('room', 'two'); element.setAttribute('name', 'New listener'); element.setAttribute('code', 'NEW');
      } else {
        Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
        assertRetry(element, false);
        assert.equal(element.client, null);
        click(element['retry']); await settle();
        assert.equal(sockets.length, 1);
        Object.assign(element, { isConnected: true }); element.connectedCallback();
      }
      assertRetry(element, false);
      await settle();
      const client = element.client!;
      assert.notEqual(client, retired);
      assert.equal(sockets.length, 2);
      assert.equal(client.playbackMuted, true);
      assert.equal(client.playbackVolume, 0.25);
      assert.equal(element['error'].hidden, true);
      const next = await hello(sockets[1]!);
      assert.equal(next.roomId, transition === 'attribute change' ? 'two' : 'one');
      assert.equal(next.name, transition === 'attribute change' ? 'New listener' : 'Listener');
      assert.equal(next.code, transition === 'attribute change' ? 'NEW' : undefined);
      sockets[1]!.deliver({ type: 'error', requestId: next.requestId, code: 'unauthorized', message: '房間不存在或代碼錯誤。' }); await settle();
      assertRetry(element, true);
      click(element['retry']); await settle();
      assert.equal(sockets.length, 3);
      assertRetry(element, false);
    });
  }
});

describe('widget subscribed connection status', () => {
  it('shows disconnected and hides room controls after the exposed live client disconnects', async t => {
    for (const onStage of [false, true]) {
      const { element, client } = await subscribedWidget(t, onStage);
      assert.equal(element['status'].textContent, `Room & Hall · 直播中 · ${onStage ? '台上' : '收聽中'}`);
      assert.equal(element['listen'].hidden, false);
      assert.equal(element[onStage ? 'mic' : 'hand'].hidden, false);
      const forwarded: CustomEvent[] = [];
      const textAtForward: string[] = [];
      element.addEventListener('stage-status', event => {
        forwarded.push(event as CustomEvent);
        textAtForward.push(element['status'].textContent ?? '');
      });
      await element.client!.disconnect();
      assert.equal(element.client, client, 'the exposed client is retained until a rejoin or unmount');
      assert.equal(client.state, null);
      assert.equal(client.status, 'disconnected');
      assertRoomControlsHidden(element);
      assert.equal(element['status'].textContent, '未連線');
      assert.deepEqual(textAtForward, ['未連線'], 'the status label is updated before forwarding');
      assert.deepEqual(forwarded.map(event => event.detail), ['disconnected']);
      assert.equal(forwarded[0]!.bubbles, true);
      assert.equal(forwarded[0]!.composed, true);
      element.playbackMuted = true;
      assert.equal(element['status'].textContent, '未連線');
    }
  });

  it('retains current room state during reconnect and renders subsequent live state', async t => {
    const { element, client } = await subscribedWidget(t);
    const previous = client.state;
    await client['receive']({ type: 'status', state: 'reconnecting' });
    assert.equal(element.client, client);
    assert.equal(client.state, previous);
    assert.equal(element['status'].textContent, 'Room & Hall · 重新連線中 · 收聽中');
    assert.equal(element['hand'].hidden, false);
    assert.equal(element['listen'].hidden, false);
    assert.equal(element['listen'].disabled, false);
    await client['receive']({ type: 'room:state', ...roomState(true) });
    assert.equal(element['status'].textContent, 'Room & Hall · 直播中 · 台上');
    assert.equal(element['mic'].hidden, false);
    assert.equal(element['leaveStage'].hidden, false);
    assert.equal(element['hand'].hidden, true);
  });

  for (const terminal of terminalCases) {
    it(`preserves the ${terminal.title} notice and forwards the same terminal detail`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      let sdkDetail: unknown;
      const forwarded: CustomEvent[] = [];
      const textAtForward: string[] = [];
      client.on(terminal.event, ({ detail }) => { sdkDetail = detail; });
      element.addEventListener(`stage-${terminal.event}`, event => {
        forwarded.push(event as CustomEvent);
        textAtForward.push(element['status'].textContent ?? '');
      });
      await client['receive'](terminal.message);
      assert.equal(client.state, null);
      assert.equal(client.status, 'disconnected');
      assertRoomControlsHidden(element);
      assert.equal(element['status'].textContent, terminal.text);
      assert.deepEqual(textAtForward, [terminal.text]);
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0]!.detail, sdkDetail, 'event detail is forwarded without cloning or replacement');
      const { type: _, ...expectedDetail } = terminal.message;
      assert.deepEqual(sdkDetail, expectedDetail);
      assert.equal(forwarded[0]!.bubbles, true);
      assert.equal(forwarded[0]!.composed, true);
      element.playbackMuted = true;
      assert.equal(element['status'].textContent, terminal.text, 'an unrelated preference render keeps the notice');
      element.playbackMuted = false;
      assert.equal(element['status'].textContent, terminal.text);
    });
  }

  for (const transition of ['room change', 'remount'] as const) {
    it(`clears terminal notices on ${transition} before receiving a new room state`, async t => {
      for (const terminal of terminalCases) {
        const { element, client } = await subscribedWidget(t);
        await client['receive'](terminal.message);
        assert.equal(element['status'].textContent, terminal.text);
        if (transition === 'room change') element.setAttribute('room', 'two');
        else {
          Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
          assert.equal(element.client, null);
          Object.assign(element, { isConnected: true }); element.connectedCallback();
        }
        assert.equal(element['status'].textContent, '');
        await settle();
        const replacement = element.client as StageClient | null;
        assert.ok(replacement);
        assert.notEqual(replacement, client);
        assert.equal(element['status'].textContent, '未連線');
        assertRoomControlsHidden(element);
        await replacement['receive']({ type: 'room:state', ...roomState(false, 'two'), name: 'New room' });
        assert.equal(element['status'].textContent, 'New room · 直播中 · 收聽中');
      }
    });
  }

  it('ignores late status and terminal events from a retired client', async t => {
    const { element, client } = await subscribedWidget(t);
    element.setAttribute('room', 'two'); await settle();
    const replacement = element.client;
    assert.ok(replacement);
    assert.notEqual(replacement, client);
    await replacement['receive']({ type: 'room:state', ...roomState(false, 'two'), name: 'New room' });
    const forwarded: string[] = [];
    for (const type of ['status', 'state', 'closed', 'kicked']) element.addEventListener(`stage-${type}`, () => { forwarded.push(type); });
    await client['receive']({ type: 'status', state: 'reconnecting' });
    await client['receive']({ type: 'room:state', ...roomState(true), name: 'Old room' });
    for (const terminal of terminalCases) await client['receive'](terminal.message);
    assert.deepEqual(forwarded, []);
    assert.equal(element.client, replacement);
    assert.equal(element['status'].textContent, 'New room · 直播中 · 收聽中');
    assert.equal(element['hand'].hidden, false);
    assert.equal(element['mic'].hidden, true);
  });

  it('keeps a reentrant replacement clean when a forwarded disconnect starts a new room', async t => {
    const { element, client } = await subscribedWidget(t, true);
    const statusAtForward: string[] = [];
    const terminalEvents: Event[] = [];
    element.addEventListener('stage-status', event => {
      if ((event as CustomEvent).detail !== 'disconnected') return;
      statusAtForward.push(element['status'].textContent ?? '');
      element.setAttribute('room', 'two');
    });
    element.addEventListener('stage-closed', event => { terminalEvents.push(event); });
    await client['receive']({ type: 'room:closed', roomId: 'one', reason: 'shutdown' });
    await settle();
    assert.deepEqual(statusAtForward, ['未連線']);
    const replacement = element.client;
    assert.ok(replacement);
    assert.notEqual(replacement, client);
    assert.deepEqual(terminalEvents, [], 'the now-retired terminal event is not forwarded');
    assert.equal(element['status'].textContent, '未連線', 'the settled replacement has no snapshot or inherited terminal notice');
    await replacement['receive']({ type: 'room:state', ...roomState(false, 'two'), name: 'New room' });
    assert.equal(element['status'].textContent, 'New room · 直播中 · 收聽中');
  });
});

describe('widget playback unlock lifecycle ownership', () => {
  type Widget = InstanceType<typeof StageElement>;
  function assertUnlock(element: Widget, { hidden = false, busy = false }: { hidden?: boolean; busy?: boolean } = {}): void {
    assert.equal(element['unlock'].hidden, hidden, 'unlock visibility');
    assert.equal(element['unlock'].getAttribute('aria-busy'), busy ? 'true' : null, 'unlock accessibility ownership');
    assert.equal(element['pendingActions'].has(element['unlock']), busy, 'unlock pending ownership');
    if (busy) assert.equal(element['unlock'].disabled, true);
  }
  function blockedEvent(client: StageClient): void {
    client.dispatchEvent(new CustomEvent('audioblocked', { detail: { message: 'playback blocked' } }));
  }
  function currentError(client: StageClient): void {
    client.dispatchEvent(new CustomEvent('error', { detail: new Error('current room alert') }));
  }
  function assertCurrentError(element: Widget): void {
    assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, 'current room alert');
  }
  async function playbackWidget(t: TestContext) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
    class Peer {
      static instances: Peer[] = [];
      connectionState = 'connected'; signalingState = 'stable'; closed = false;
      ontrack?: (event: { streams: MediaStream[]; track: MediaStreamTrack }) => void;
      readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown,
        async replaceTrack(track: unknown) { this.track = track; },
      } };
      constructor() { Peer.instances.push(this); }
      addTransceiver() { return this.transceiver; }
      close(): void { this.closed = true; this.connectionState = 'closed'; }
      track(stream: MediaStream): void { this.ontrack?.({ streams: [stream], track: {} as MediaStreamTrack }); }
    }
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    // SDK playback/session ownership is real; SDP and media hardware are outside this fixture.
    t.mock.method(StageClient.prototype as unknown as { negotiate(): void }, 'negotiate', () => {});
    t.after(() => {
      if (original) Object.defineProperty(globalThis, 'RTCPeerConnection', original);
      else Reflect.deleteProperty(globalThis, 'RTCPeerConnection');
    });
    const fixture = await socketJoinedWidget(t, roomState(), true);
    const audio = fixture.client['audio'];
    const plays: ReturnType<typeof deferred>[] = [];
    const play = t.mock.method(audio, 'play', () => {
      const attempt = deferred(); plays.push(attempt); return attempt.promise;
    });
    t.after(async () => { for (const attempt of plays) attempt.resolve(); await settle(); });
    const blocked = async () => {
      const stream = {} as MediaStream;
      Peer.instances.at(-1)!.track(stream);
      assert.equal(audio.srcObject, stream);
      plays.at(-1)!.reject(new DOMException('autoplay denied', 'NotAllowedError'));
      await settle(); assertUnlock(fixture.element);
      return stream;
    };
    const rejoin = async (participantId = 'me') => {
      const connecting = fixture.client.connect();
      const socket = fixture.sockets.at(-1)!;
      socket.hello(); await connecting;
      const joining = fixture.client.join({ roomId: 'one', name: 'Listener' });
      void joining.catch(() => {}); // Preserve the original assertion if fixture setup fails.
      await settle(); await fixture.tick(100);
      const request = fixture.joinRequest(socket), state = roomState();
      state.me.participantId = participantId;
      socket.deliver({ type: 'room:state', ...state });
      socket.deliver({ type: 'ok', requestId: request.requestId });
      await joining; await settle();
      assert.equal(fixture.element.client, fixture.client, 'public reconnect/join reuses the exposed client');
      return socket;
    };
    return { ...fixture, audio, plays, play, Peer, blocked, rejoin };
  }

  it('rejects stale programmatic clicks and blocked notices before the first joined snapshot', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const client = element.client!, play = t.mock.method(client['audio'], 'play');
    for (const phase of ['connecting', 'joining'] as const) {
      if (phase === 'joining') await hello(sockets[0]!);
      blockedEvent(client); assertUnlock(element, { hidden: true });
      currentError(client);
      const revision = element['errorRevision'];
      element['unlock'].disabled = false; click(element['unlock']);
      assert.equal(play.mock.callCount(), 0, phase);
      assert.equal(element['errorRevision'], revision); assertCurrentError(element);
      assert.equal(element['pendingActions'].size, 0);
      assert.equal(element['unlock'].getAttribute('aria-busy'), null);
    }
  });

  for (const terminal of [null, ...terminalCases]) {
    it(`retires a visible unlock before forwarded ${terminal?.title ?? 'direct disconnect'} callbacks and rejects source-less clicks`, async t => {
      const { element, client, socket, audio, play, blocked, Peer } = await playbackWidget(t);
      await blocked();
      const peer = Peer.instances[0]!, generation = element['generation'];
      const callbacks: string[] = [];
      for (const type of ['status', ...(terminal ? [terminal.event] : [])]) {
        element.addEventListener(`stage-${type}`, event => {
          if (type === 'status' && (event as CustomEvent).detail !== 'disconnected') return;
          callbacks.push(type); assertUnlock(element, { hidden: true });
          assert.equal(audio.srcObject, null); assert.equal(peer.closed, true);
          currentError(client);
          const revision = element['errorRevision'];
          // Bypass the fake DOM's disabled/hidden surface to exercise handler admission itself.
          element['unlock'].disabled = false; click(element['unlock']);
          assert.equal(play.mock.callCount(), 1);
          assert.equal(element['errorRevision'], revision); assertCurrentError(element);
          assert.equal(element['pendingActions'].size, 0);
          assert.equal(element['unlock'].getAttribute('aria-busy'), null);
        });
      }
      if (terminal) socket.deliver(terminal.message); else await client.disconnect();
      await settle(); await settle();
      assert.deepEqual(callbacks, terminal ? ['status', terminal.event] : ['status']);
      assert.equal(element['generation'], generation, 'SDK retirement does not replace the widget generation');
      assert.equal(element.client, client); assert.equal(client.state, null);
      assertUnlock(element, { hidden: true });
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
      blockedEvent(client); assertUnlock(element, { hidden: true }); assertCurrentError(element);
      element['unlock'].disabled = false; click(element['unlock']); await settle();
      assert.equal(play.mock.callCount(), 1, 'retired audio is never played without a joined state');
      assertCurrentError(element);
    });

    for (const outcome of ['resolve', 'reject'] as const) {
      it(`ignores a pending unlock ${outcome} after ${terminal?.title ?? 'direct disconnect'}`, async t => {
        const { element, client, socket, audio, plays, play, blocked } = await playbackWidget(t);
        await blocked(); click(element['unlock']);
        assert.equal(play.mock.callCount(), 2, 'play is invoked in the click turn');
        assertUnlock(element, { busy: true }); const old = plays.at(-1)!;
        if (terminal) socket.deliver(terminal.message); else await client.disconnect();
        await settle(); assertUnlock(element, { hidden: true }); assert.equal(audio.srcObject, null);
        currentError(client); const revision = element['errorRevision'];
        // Pause/source clearing deliberately do not settle the fake promise: this tests ownership,
        // not any particular native browser ordering for pending HTMLMediaElement.play().
        if (outcome === 'resolve') old.resolve(); else old.reject(new DOMException('retired play failed', 'AbortError'));
        await settle(); await settle();
        assertUnlock(element, { hidden: true }); assertCurrentError(element);
        assert.equal(element['errorRevision'], revision);
        assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
        assert.equal(play.mock.callCount(), 2);
      });
    }
  }

  for (const identity of ['same', 'replacement'] as const) {
    for (const pending of [false, true]) {
      for (const outcome of ['resolve', 'reject'] as const) {
        it(`isolates old unlock ${outcome} after same-client ${identity}-identity rejoin with ${pending ? 'a new retry pending' : 'a new blocked notice'}`, async t => {
          const { element, client, audio, plays, play, blocked, rejoin } = await playbackWidget(t);
          await blocked(); click(element['unlock']); const old = plays.at(-1)!;
          const generation = element['generation'];
          await client.disconnect(); assertUnlock(element, { hidden: true }); assert.equal(audio.srcObject, null);
          await rejoin(identity === 'same' ? 'me' : 'replacement');
          assert.equal(element['generation'], generation);
          assertUnlock(element, { hidden: true }); await blocked();
          let active: ReturnType<typeof deferred> | undefined;
          if (pending) { click(element['unlock']); active = plays.at(-1)!; }
          assertUnlock(element, { busy: pending }); currentError(client);
          const revision = element['errorRevision'], calls = play.mock.callCount();
          if (outcome === 'resolve') old.resolve(); else old.reject(new Error('old seat unlock failure'));
          await settle(); await settle();
          assertUnlock(element, { busy: pending }); assertCurrentError(element);
          assert.equal(element['errorRevision'], revision); assert.equal(play.mock.callCount(), calls);
          if (!pending) { click(element['unlock']); active = plays.at(-1)!; }
          assertUnlock(element, { busy: true });
          active!.resolve(); await settle(); await settle();
          assertUnlock(element, { hidden: true });
        });
      }
    }
  }

  for (const transition of ['room', 'identity'] as const) {
    for (const outcome of ['resolve', 'reject'] as const) {
      it(`retires an unlock before forwarded ${transition} snapshot replacement and ignores its ${outcome}`, async t => {
        const { element, client } = await subscribedWidget(t);
        const old = deferred(), active = deferred();
        let calls = 0;
        t.mock.method(client, 'unlockAudio', () => ++calls === 1 ? old.promise : active.promise);
        blockedEvent(client); click(element['unlock']); assertUnlock(element, { busy: true });
        const next = roomState(false, transition === 'room' ? 'two' : 'one');
        if (transition === 'identity') next.me.participantId = 'replacement';
        let callbacks = 0;
        element.addEventListener('stage-state', () => {
          callbacks++; assertUnlock(element, { hidden: true });
        }, { once: true });
        await client['receive']({ type: 'room:state', ...next });
        assert.equal(callbacks, 1); assertUnlock(element, { hidden: true });
        blockedEvent(client); click(element['unlock']); assert.equal(calls, 2); assertUnlock(element, { busy: true });
        currentError(client);
        if (outcome === 'resolve') old.resolve(); else old.reject(new Error('replaced snapshot failure'));
        await settle(); assertUnlock(element, { busy: true }); assertCurrentError(element);
        active.resolve(); await settle(); assertUnlock(element, { hidden: true });
      });
    }
  }

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`preserves a current pending unlock ${outcome} across real transport reconnect and same-identity redraws`, async t => {
      const { element, client, socket, sockets, tick, hello, audio, plays, play, blocked, Peer } = await playbackWidget(t);
      const stream = await blocked(), peer = Peer.instances[0]!;
      const me = { ...client.me };
      click(element['unlock']); const pending = plays.at(-1)!;
      assert.equal(play.mock.callCount(), 2, 'the browser gesture reaches play synchronously');
      socket.close(); await settle();
      assert.equal(client.status, 'reconnecting'); assert.equal(audio.srcObject, stream); assert.equal(peer.closed, false);
      assertUnlock(element, { busy: true });
      click(element['listen']); await settle(); element.playbackVolume = 0.375;
      assert.equal(client.playbackMuted, true); assert.equal(client.playbackVolume, 0.375);
      assert.deepEqual(client.me, me); assertUnlock(element, { busy: true });
      await tick(500); assertUnlock(element, { busy: true });
      const replacement = sockets[1]!, request = await hello(replacement); assertUnlock(element, { busy: true });
      replacement.deliver({ type: 'room:state', ...roomState(), resumeToken: 'resume-me' });
      replacement.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      for (const state of ['waiting', 'live'] as const) {
        replacement.deliver({ type: 'status', state });
        replacement.deliver({ type: 'room:state', ...roomState(), status: state });
        await settle(); assertUnlock(element, { busy: true }); click(element['unlock']);
      }
      assert.equal(play.mock.callCount(), 2); assert.equal(audio.srcObject, stream); assert.equal(Peer.instances.length, 1);
      if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('current play failure'));
      await settle(); await settle();
      assertUnlock(element, { hidden: outcome === 'resolve' });
      assert.equal(element['error'].hidden, outcome === 'resolve');
      if (outcome === 'reject') {
        assert.equal(element['error'].textContent, 'current play failure');
        click(element['unlock']); assert.equal(play.mock.callCount(), 3); assertUnlock(element, { busy: true });
        assert.equal(element['error'].hidden, true);
        plays.at(-1)!.resolve(); await settle(); assertUnlock(element, { hidden: true });
      }
      assert.equal(client.playbackMuted, true); assert.equal(client.playbackVolume, 0.375);
      assert.equal(client['pending'].size, 0);
    });
  }

  it('preserves a newer same-seat blocked notice when an earlier synthetic play attempt resolves', async t => {
    const { element, client } = await subscribedWidget(t);
    const old = deferred(), retry = deferred(); let calls = 0;
    t.mock.method(client, 'unlockAudio', () => ++calls === 1 ? old.promise : retry.promise);
    blockedEvent(client); click(element['unlock']); assertUnlock(element, { busy: true });
    // Deliberately injected event/promise order tests notice ownership, not native play ordering.
    blockedEvent(client); click(element['unlock']); assert.equal(calls, 1);
    old.resolve(); await settle(); assertUnlock(element);
    assert.equal(element['error'].hidden, true);
    click(element['unlock']); assert.equal(calls, 2); assertUnlock(element, { busy: true });
    retry.resolve(); await settle(); assertUnlock(element, { hidden: true });
  });

  it('shows a current synchronous SDK unlock failure and admits a later retry without another blocked event', async t => {
    const { element, client } = await subscribedWidget(t);
    const pending = deferred(); let calls = 0;
    t.mock.method(client, 'unlockAudio', () => {
      if (++calls === 1) throw new Error('synchronous unlock failure');
      return pending.promise;
    });
    blockedEvent(client); click(element['unlock']); assert.equal(calls, 1); await settle();
    assertUnlock(element); assert.equal(element['error'].textContent, 'synchronous unlock failure');
    assert.equal(element['error'].hidden, false);
    click(element['unlock']); assert.equal(calls, 2); assertUnlock(element, { busy: true });
    assert.equal(element['error'].hidden, true);
    pending.resolve(); await settle(); assertUnlock(element, { hidden: true });
  });

  for (const transition of ['room', 'name', 'code', 'url', 'unmount'] as const) {
    for (const outcome of ['resolve', 'reject'] as const) {
      it(`isolates pending unlock ${outcome} across ${transition} replacement from a new pending retry`, async t => {
        const { element, client } = await subscribedWidget(t);
        const old = deferred(); t.mock.method(client, 'unlockAudio', () => old.promise);
        blockedEvent(client); click(element['unlock']); assertUnlock(element, { busy: true });
        if (transition === 'unmount') {
          Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
          assertUnlock(element, { hidden: true });
          Object.assign(element, { isConnected: true }); element.connectedCallback();
        } else element.setAttribute(transition, transition === 'url' ? 'wss://replacement.invalid/ws' : 'replacement');
        await settle(); const current = element.client!; assert.ok(current); assert.notEqual(current, client);
        await current['receive']({ type: 'room:state', ...roomState() }); assertUnlock(element, { hidden: true });
        const active = deferred(); t.mock.method(current, 'unlockAudio', () => active.promise);
        blockedEvent(current); click(element['unlock']); assertUnlock(element, { busy: true }); currentError(current);
        blockedEvent(client);
        if (outcome === 'resolve') old.resolve(); else old.reject(new Error('retired widget unlock failure'));
        await settle(); assertUnlock(element, { busy: true }); assertCurrentError(element);
        active.resolve(); await settle(); assertUnlock(element, { hidden: true });
      });
    }
  }
});

describe('widget actions and local playback', () => {
  it('keeps hand, mic and leave-stage actions disabled across renders until their request settles', async () => {
    for (const key of ['hand', 'mic', 'leaveStage'] as const) {
      const { element, pending, calls } = widget(key !== 'hand');
      const button = element[key];
      click(button);
      assert.equal(button.disabled, true);
      element['render'](); // Same render path as the cooldown timer and incoming state events.
      assert.equal(button.disabled, true);
      click(button);
      assert.equal(calls(), 1, 'a pending action cannot submit twice');
      pending.resolve(); await settle();
      assert.equal(button.disabled, false);
    }
  });

  it('shows asynchronous and synchronous failures and clears pending accessibility state', async () => {
    for (const synchronous of [false, true]) {
      const { element, pending, client } = widget();
      if (synchronous) client.raiseHand = () => { throw new Error('sync failure'); };
      click(element['hand']);
      if (!synchronous) {
        assert.equal(element['hand'].getAttribute('aria-busy'), 'true');
        pending.reject(new Error('async failure'));
      }
      await settle();
      assert.equal(element['hand'].disabled, false);
      assert.equal(element['hand'].getAttribute('aria-busy'), null);
      assert.equal(element['error'].hidden, false);
      assert.equal(element['error'].textContent, synchronous ? 'sync failure' : 'async failure');
    }
  });

  it('retains server policy and cooldown disabled state after completion', async () => {
    const mic = widget(true);
    click(mic.element['mic']);
    mic.client.me.forceMuted = true;
    mic.pending.resolve(); await settle();
    assert.equal(mic.element['mic'].disabled, true);
    const hand = widget();
    click(hand.element['hand']);
    hand.client.handCooldownMs = 9000;
    hand.pending.resolve(); await settle();
    assert.equal(hand.element['hand'].disabled, true);
  });

  it('a previous generation cannot unlock a new pending action or show its failure', async () => {
    const first = widget();
    click(first.element['hand']);
    ++first.element['generation'];
    await first.element['leave']();
    assert.equal(first.element['hand'].getAttribute('aria-busy'), null);
    const next = deferred();
    first.client.raiseHand = () => next.promise;
    first.element['current'] = first.client as unknown as StageClient;
    first.element['render']();
    click(first.element['hand']);
    first.pending.reject(new Error('retired request')); await settle();
    assert.equal(first.element['hand'].disabled, true);
    assert.equal(first.element['hand'].getAttribute('aria-busy'), 'true');
    assert.equal(first.element['error'].hidden, true);
    next.resolve(); await settle();
    assert.equal(first.element['hand'].disabled, false);
    assert.equal(first.element['hand'].getAttribute('aria-busy'), null);
  });

  it('tracks distinct buttons independently while audio unlock is pending', async () => {
    const { element, pending, client } = widget(true);
    const unlock = deferred();
    Object.assign(client, { unlockAudio: () => unlock.promise });
    element['unlock'].hidden = false;
    click(element['unlock']); click(element['mic']);
    element['render']();
    assert.equal(element['unlock'].disabled, true);
    assert.equal(element['mic'].disabled, true);
    unlock.resolve(); await settle();
    assert.equal(element['unlock'].hidden, true);
    assert.equal(element['unlock'].disabled, false);
    assert.equal(element['mic'].disabled, true);
    pending.resolve(); await settle();
    assert.equal(element['mic'].disabled, false);
  });

  it('invokes the selected action before a synchronous generation change', async () => {
    const { element, calls, pending } = widget();
    click(element['hand']);
    ++element['generation'];
    await element['leave']();
    assert.equal(calls(), 1);
    pending.resolve(); await settle();
    assert.equal(element['pendingActions'].size, 0);
  });


  it('toggles local listening without microphone or control requests and reflects its boolean attribute', async () => {
    const { element, client, calls } = widget(true);
    const before = { ...client.me };
    click(element['listen']); await settle();
    assert.equal(element.playbackMuted, true);
    assert.equal(element.hasAttribute('playback-muted'), true);
    assert.equal(client.playbackMuted, true);
    assert.equal(element['listen'].textContent, '恢復收聽');
    assert.equal(element['listen'].getAttribute('aria-pressed'), 'true');
    assert.equal(element['listen'].getAttribute('aria-label'), '靜音收聽');
    assert.equal(calls(), 0);
    assert.deepEqual(client.me, before);
    click(element['listen']); await settle();
    assert.equal(element.playbackMuted, false);
    assert.equal(client.playbackMuted, false);
    assert.equal(element['listen'].getAttribute('aria-pressed'), 'false');
    assert.equal(element['listen'].getAttribute('aria-label'), '靜音收聽');
  });

  it('applies attribute/property changes without rejoining or changing the current client', () => {
    const { element, client } = widget();
    const current = element.client, generation = element['generation'];
    element.setAttribute('playback-muted', 'false'); // HTML boolean attributes are true when present.
    assert.equal(element.playbackMuted, true);
    assert.equal(client.playbackMuted, true);
    element.playbackMuted = false;
    assert.equal(element.hasAttribute('playback-muted'), false);
    assert.equal(client.playbackMuted, false);
    assert.equal(element.client, current);
    assert.equal(element['generation'], generation);
  });

  it('retains the listening preference across actual rejoin and disconnect callbacks', async t => {
    const initialMutes: boolean[] = [];
    t.mock.method(StageClient.prototype, 'connect', async function (this: StageClient) { initialMutes.push(this.playbackMuted); });
    t.mock.method(StageClient.prototype, 'join', async () => {});
    t.mock.method(StageClient.prototype, 'disconnect', async () => {});
    const element = new StageElement();
    try {
      element.playbackMuted = true;
      element.setAttribute('room', 'one'); element.setAttribute('name', 'Listener');
      await settle();
      const first = element.client;
      assert.ok(first);
      assert.equal(first.playbackMuted, true);
      element.setAttribute('room', 'two'); await settle();
      assert.notEqual(element.client, first);
      assert.equal(element.client?.playbackMuted, true);
      element.disconnectedCallback(); await settle();
      assert.equal(element.client, null);
      assert.equal(element.playbackMuted, true);
      element.connectedCallback(); await settle();
      const reconnected = element.client as StageClient | null;
      assert.equal(reconnected?.playbackMuted, true);
      assert.deepEqual(initialMutes, [true, true, true], 'preference is applied before each connection starts');
      assert.equal(element['listen'].hidden, true, 'no joined state yet');
    } finally { element.disconnectedCallback(); await settle(); }
  });


  it('allows listening mute during signaling reconnect and hides it after leaving', async () => {
    const { element, client, calls } = widget();
    client.status = 'reconnecting'; element['render']();
    assert.equal(element['listen'].disabled, false);
    click(element['listen']); await settle();
    assert.equal(client.playbackMuted, true);
    assert.equal(calls(), 0);
    element.disconnectedCallback(); await settle();
    assert.equal(element['listen'].hidden, true);
    assert.equal(element['listen'].disabled, true);
    assert.equal(element.playbackMuted, true);
  });

});


describe('widget playback volume', () => {
  it('defaults to full volume and reads finite numeric attributes including zero, one and fractions', () => {
    const { element, client } = widget();
    assert.ok(StageElement.observedAttributes.includes('playback-volume'));
    assert.equal(element.playbackVolume, 1);
    assert.equal(element.hasAttribute('playback-volume'), false);
    for (const [attribute, expected] of [['0', 0], ['1', 1], ['0.375', 0.375], [' 0.25 ', 0.25], ['1e-1', 0.1]] as const) {
      element.setAttribute('playback-volume', attribute);
      assert.equal(element.playbackVolume, expected, attribute);
      assert.equal(client.playbackVolume, expected, attribute);
      assert.equal(element.getAttribute('playback-volume'), attribute, 'reading does not rewrite an attribute');
    }
  });

  it('uses full volume for empty, invalid and out-of-range attributes and for attribute removal', () => {
    const { element, client } = widget();
    for (const attribute of ['', ' ', '\t\n', 'NaN', 'Infinity', '-Infinity', '1e309', 'invalid', '0.5oops', '-0.01', '1.01']) {
      element.playbackVolume = 0.4;
      assert.doesNotThrow(() => element.setAttribute('playback-volume', attribute));
      assert.equal(element.playbackVolume, 1, JSON.stringify(attribute));
      assert.equal(client.playbackVolume, 1, JSON.stringify(attribute));
      assert.equal(element.getAttribute('playback-volume'), attribute);
    }
    element.playbackVolume = 0;
    element.removeAttribute('playback-volume');
    assert.equal(element.playbackVolume, 1);
    assert.equal(client.playbackVolume, 1);
    assert.equal(element.hasAttribute('playback-volume'), false);
  });

  it('reflects valid property values and derives its preference from the attribute rather than the client', () => {
    const { element, client } = widget();
    for (const volume of [0, 0.375, 1]) {
      element.playbackVolume = volume;
      assert.equal(element.getAttribute('playback-volume'), String(volume));
      assert.equal(element.playbackVolume, volume);
      assert.equal(client.playbackVolume, volume);
    }
    element.playbackVolume = 0.4;
    client.setPlaybackVolume(0.7);
    assert.equal(element.playbackVolume, 0.4, 'direct SDK changes do not replace the widget preference');
    element.setAttribute('playback-volume', '0.6');
    assert.equal(element.playbackVolume, 0.6);
    assert.equal(client.playbackVolume, 0.6);
  });

  it('rejects invalid property values with RangeError before mutating the attribute or client', t => {
    const { element, client } = widget();
    element.playbackVolume = 0.4;
    const reflect = t.mock.method(element, 'setAttribute');
    const apply = t.mock.method(client, 'setPlaybackVolume');
    const invalid: unknown[] = [NaN, Infinity, -Infinity, -0.01, 1.01, '0.4', '', ' ', null, undefined, true, false, {}, [], 0n];
    for (const value of invalid) {
      assert.throws(() => { element.playbackVolume = value as number; }, RangeError);
      assert.equal(element.getAttribute('playback-volume'), '0.4');
      assert.equal(element.playbackVolume, 0.4);
      assert.equal(client.playbackVolume, 0.4);
    }
    assert.equal(reflect.mock.callCount(), 0);
    assert.equal(apply.mock.callCount(), 0);
  });

  it('applies changes immediately during live and reconnecting states without rejoining or issuing control requests', () => {
    const { element, client, calls } = widget(true);
    const current = element.client, generation = element['generation'], before = { ...client.me };
    for (const status of ['live', 'reconnecting']) {
      client.status = status;
      element['render']();
      element.playbackVolume = 0;
      assert.equal(client.playbackVolume, 0);
      element.setAttribute('playback-volume', '0.65');
      assert.equal(client.playbackVolume, 0.65);
      element.removeAttribute('playback-volume');
      assert.equal(client.playbackVolume, 1);
      assert.equal(element.client, current);
      assert.equal(element['generation'], generation);
      assert.equal(client.status, status);
      assert.equal(calls(), 0);
      assert.deepEqual(client.me, before);
    }
  });

  it('keeps volume independent of listening mute and microphone state, including zero volume', async () => {
    const { element, client, calls } = widget(true);
    client.me.muted = true;
    const before = { ...client.me };
    for (const muted of [false, true]) {
      element.playbackMuted = muted;
      for (const volume of [0, 0.45, 1]) {
        element.playbackVolume = volume;
        assert.equal(client.playbackVolume, volume);
        assert.equal(element.playbackMuted, muted);
        assert.equal(client.playbackMuted, muted);
        assert.equal(element.hasAttribute('playback-muted'), muted);
      }
    }
    element.playbackVolume = 0;
    click(element['listen']); await settle();
    assert.equal(element.playbackMuted, false);
    assert.equal(client.playbackMuted, false);
    assert.equal(element.playbackVolume, 0);
    assert.equal(client.playbackVolume, 0);
    element.playbackMuted = true;
    element.removeAttribute('playback-volume');
    assert.equal(client.playbackVolume, 1);
    assert.equal(client.playbackMuted, true);
    assert.equal(calls(), 0);
    assert.deepEqual(client.me, before);
  });

  it('applies the preference before connect and preserves it across room changes and actual remount callbacks', async t => {
    const initialVolumes: number[] = [];
    t.mock.method(StageClient.prototype, 'connect', async function (this: StageClient) { initialVolumes.push(this.playbackVolume); });
    const join = t.mock.method(StageClient.prototype, 'join', async () => {});
    t.mock.method(StageClient.prototype, 'disconnect', async () => {});
    const element = new StageElement();
    try {
      Object.assign(element, { isConnected: false });
      element.setAttribute('playback-volume', '0.25');
      element.setAttribute('room', 'one'); element.setAttribute('name', 'Listener');
      assert.equal(element.client, null);
      Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
      const first = element.client as StageClient | null;
      assert.ok(first);
      assert.equal(first.playbackVolume, 0.25);
      element.playbackVolume = 0.625;
      element.setAttribute('room', 'two'); await settle();
      const second = element.client as StageClient | null;
      assert.ok(second);
      assert.notEqual(second, first);
      assert.equal(second.playbackVolume, 0.625);
      Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
      assert.equal(element.client, null);
      assert.equal(element.playbackVolume, 0.625);
      assert.equal(element.getAttribute('playback-volume'), '0.625');
      Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
      const remounted = element.client as StageClient | null;
      assert.ok(remounted);
      assert.notEqual(remounted, second);
      assert.equal(remounted.playbackVolume, 0.625);
      assert.deepEqual(initialVolumes, [0.25, 0.625, 0.625], 'the preference is applied before each connection starts');
      assert.equal(join.mock.callCount(), 3);
      const generation = element['generation'];
      element.removeAttribute('playback-volume');
      assert.equal(element.playbackVolume, 1);
      assert.equal(remounted.playbackVolume, 1);
      assert.equal(element.client, remounted);
      assert.equal(element['generation'], generation);
    } finally { element.disconnectedCallback(); await settle(); }
  });

  it('updates a client while connect is pending and ignores the retired connection after a room change', async t => {
    const connections: ReturnType<typeof deferred>[] = [];
    t.mock.method(StageClient.prototype, 'connect', function () {
      const pending = deferred(); connections.push(pending); return pending.promise;
    });
    const join = t.mock.method(StageClient.prototype, 'join', async () => {});
    t.mock.method(StageClient.prototype, 'disconnect', async () => {});
    const element = new StageElement();
    try {
      element.playbackVolume = 0.2;
      element.setAttribute('room', 'one'); element.setAttribute('name', 'Listener'); await settle();
      const first = element.client;
      assert.ok(first);
      assert.equal(connections.length, 1);
      const generation = element['generation'];
      element.playbackVolume = 0.4;
      assert.equal(first.playbackVolume, 0.4);
      element.setAttribute('playback-volume', '0.6');
      assert.equal(first.playbackVolume, 0.6);
      assert.equal(element.client, first);
      assert.equal(element['generation'], generation);
      assert.equal(connections.length, 1);
      assert.equal(join.mock.callCount(), 0);
      element.setAttribute('room', 'two'); await settle();
      const second = element.client;
      assert.ok(second);
      assert.notEqual(second, first);
      assert.equal(connections.length, 2);
      assert.equal(second.playbackVolume, 0.6);
      element.playbackVolume = 0.75;
      assert.equal(second.playbackVolume, 0.75);
      assert.equal(first.playbackVolume, 0.6, 'only the current client receives subsequent preference changes');
      connections[0]!.resolve(); await settle();
      assert.equal(join.mock.callCount(), 0, 'a superseded connection must not join its old room');
      assert.equal(element.client, second);
      assert.equal(second.playbackVolume, 0.75);
      connections[1]!.resolve(); await settle();
      assert.equal(join.mock.callCount(), 1);
      assert.equal(join.mock.calls[0]!.arguments[0]!.roomId, 'two');
    } finally {
      element.disconnectedCallback();
      for (const pending of connections) pending.resolve();
      await settle();
    }
  });
});


/** These assertions inspect the widget DOM and invoke its handler; they do not emulate native range interaction. */
describe('widget listening volume slider', () => {
  function descendants(node: Node, hidden = false): { node: Node; hidden: boolean }[] {
    hidden ||= node.hidden;
    return [{ node, hidden }, ...node.children.flatMap(child => descendants(child, hidden))];
  }
  function slider(element: InstanceType<typeof StageElement>): Node {
    const inputs = descendants(element as unknown as Node).filter(({ node }) => node.tagName === 'INPUT' && node.type === 'range');
    assert.equal(inputs.length, 1, 'the compact widget has exactly one native range control');
    return inputs[0]!.node;
  }
  function input(control: Node, value: string): void {
    control.value = value;
    assert.equal(typeof control.oninput, 'function', 'the range handles input rather than waiting for change');
    control.oninput!.call(control, new Event('input'));
  }
  function assertDisplay(element: InstanceType<typeof StageElement>, percent: number, visible = true): Node {
    const control = slider(element);
    assert.equal(control.value, String(percent));
    assert.equal(control.getAttribute('aria-valuetext'), `${percent}%`);
    const nodes = descendants(element as unknown as Node);
    assert.equal(nodes.find(({ node }) => node === control)!.hidden, !visible, 'the control follows joined-state visibility');
    if (visible) {
      const text = nodes.filter(({ hidden }) => !hidden).map(({ node }) => node.textContent).join(' ');
      assert.match(text, /收聽音量/, 'the listening volume has a visible label');
      assert.match(text, new RegExp(`(?:^|\\s|音量)${percent}%(?:\\s|$)`), 'the percentage is visible text');
    }
    return control;
  }

  it('provides a named 0–100 native range and keeps it hidden and disabled until joined', async t => {
    const { element, connections, joins } = deferredJoiningWidget(t);
    const control = assertDisplay(element, 100, false);
    assert.equal(control.min, '0'); assert.equal(control.max, '100'); assert.equal(control.step, '1');
    const label = descendants(element as unknown as Node).find(({ node }) => node.tagName === 'LABEL' && node.getAttribute('for') === control.id)?.node;
    assert.ok(control.id && label, 'a native label is associated with the range');
    assert.equal(label.textContent, '收聽音量');
    assert.equal(control.getAttribute('aria-busy'), null);
    assert.equal(control.disabled, true);
    assert.equal(element.hasAttribute('playback-volume'), false, 'render does not create a preference');
    await settle();
    assert.equal(control.disabled, true, 'an SDK client without a room snapshot is not joined');
    connections[0]!.pending.resolve(); await settle();
    assertDisplay(element, 100, false); assert.equal(control.disabled, true);
    await element.client!['receive']({ type: 'room:state', ...roomState() });
    assertDisplay(element, 100); assert.equal(control.disabled, false);
    assert.equal(element['listen'].hidden, false);
    joins[0]!.pending.resolve(); await settle();
  });

  it('applies zero, full and fractional input synchronously through reflection with no room work', async t => {
    const { element, client, socket } = await socketJoinedWidget(t);
    const control = slider(element);
    const generation = element['generation'], state = client.state, frames = [...socket.sent];
    const apply = t.mock.method(client, 'setPlaybackVolume');
    const timers = t.mock.method(globalThis, 'setTimeout');
    const intervals = t.mock.method(globalThis, 'setInterval');
    const play = t.mock.method(client['audio'], 'play');
    let statusText = element['status'].textContent, statusWrites = 0;
    Object.defineProperty(element['status'], 'textContent', { configurable: true,
      get: () => statusText, set: (value: string) => { statusText = value; statusWrites++; },
    });
    const events: string[] = [];
    for (const type of ['status', 'state', 'mic', 'hand', 'error', 'audioblocked']) {
      element.addEventListener(`stage-${type}`, () => { events.push(type); });
    }
    for (const [raw, expected] of [['0', 0], ['100', 1], ['37', 0.37], ['37.5', 0.375]] as const) {
      input(control, raw);
      assert.equal(element.playbackVolume, expected);
      assert.equal(element.getAttribute('playback-volume'), String(expected));
      assert.equal(client.playbackVolume, expected);
      assert.equal(client['audio'].volume, expected);
      assertDisplay(element, Math.round(expected * 100));
      assert.equal(control.disabled, false);
      assert.equal(control.getAttribute('aria-busy'), null);
      assert.equal(element['pendingActions'].size, 0);
    }
    assert.deepEqual(apply.mock.calls.map(call => call.arguments), [[0], [1], [0.37], [0.375]], 'each input reaches the existing reflected SDK path once');
    assert.equal(element.client, client); assert.equal(element['generation'], generation); assert.equal(client.state, state);
    assert.deepEqual(socket.sent, frames); assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
    assert.equal(timers.mock.callCount(), 0); assert.equal(intervals.mock.callCount(), 0); assert.equal(play.mock.callCount(), 0);
    assert.equal(statusWrites, 0, 'input does not rewrite the unrelated room-status live region');
    element.playbackVolume = 0.625; element.setAttribute('playback-volume', '0.4'); element.removeAttribute('playback-volume');
    assert.equal(statusWrites, 0, 'external volume reflection also leaves room status alone');
    assert.deepEqual(events, []);
  });

  it('synchronizes property and attribute changes without rounding the stored or applied preference', t => {
    const { element, client } = widget();
    const apply = t.mock.method(client, 'setPlaybackVolume');
    for (const value of [0, 0.3749, 0.375, 0.625, 0.99949, 1]) {
      element.playbackVolume = value;
      assertDisplay(element, Math.round(value * 100));
      assert.equal(element.getAttribute('playback-volume'), String(value));
      assert.equal(element.playbackVolume, value); assert.equal(client.playbackVolume, value);
      const applied = apply.mock.callCount();
      element['render'](); element['render']();
      assertDisplay(element, Math.round(value * 100));
      assert.equal(apply.mock.callCount(), applied, 'display-only rounding never writes back');
      assert.equal(element.getAttribute('playback-volume'), String(value));
      assert.equal(element.playbackVolume, value); assert.equal(client.playbackVolume, value);
    }
    element.setAttribute('playback-volume', ' 0.375 ');
    assertDisplay(element, 38);
    assert.equal(element.getAttribute('playback-volume'), ' 0.375 ');
    assert.equal(element.playbackVolume, 0.375); assert.equal(client.playbackVolume, 0.375);
    element.removeAttribute('playback-volume');
    assertDisplay(element, 100);
    assert.equal(element.hasAttribute('playback-volume'), false); assert.equal(client.playbackVolume, 1);
    for (const raw of ['', ' ', 'invalid', 'NaN', 'Infinity', '-0.01', '1.01']) {
      element.playbackVolume = 0.375;
      element.setAttribute('playback-volume', raw);
      assertDisplay(element, 100);
      assert.equal(element.getAttribute('playback-volume'), raw);
      assert.equal(element.playbackVolume, 1); assert.equal(client.playbackVolume, 1);
    }
  });

  it('restores its display after invalid synthetic input without throwing or mutating preferences', t => {
    const { element, client } = widget();
    element.playbackVolume = 0.375;
    const control = assertDisplay(element, 38);
    const apply = t.mock.method(client, 'setPlaybackVolume');
    const reflect = t.mock.method(element, 'setAttribute');
    // A real range normally sanitizes values. The minimal DOM deliberately permits hostile synthetic values.
    for (const raw of ['', ' ', '\t\n', 'NaN', 'Infinity', '-Infinity', '1e309', 'invalid', '37oops', '-1', '100.01']) {
      assert.doesNotThrow(() => input(control, raw), JSON.stringify(raw));
      assertDisplay(element, 38);
      assert.equal(element.getAttribute('playback-volume'), '0.375');
      assert.equal(element.playbackVolume, 0.375); assert.equal(client.playbackVolume, 0.375);
    }
    assert.equal(apply.mock.callCount(), 0); assert.equal(reflect.mock.callCount(), 0);
  });

  it('leaves the control synchronized when an invalid external property setter rejects', () => {
    const { element, client } = widget();
    element.playbackVolume = 0.375;
    for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1]) {
      assert.throws(() => { element.playbackVolume = value; }, RangeError);
      assertDisplay(element, 38);
      assert.equal(element.getAttribute('playback-volume'), '0.375'); assert.equal(client.playbackVolume, 0.375);
    }
  });

  it('keeps listening mute, zero volume and microphone policy independent', async () => {
    const { element, client, calls } = widget(true);
    const control = slider(element);
    for (const muted of [false, true]) {
      element.playbackMuted = muted;
      for (const micMuted of [false, true]) {
        Object.assign(client.me, { muted: micMuted, forceMuted: micMuted }); element['render']();
        const me = { ...client.me };
        for (const value of ['0', '45', '100']) {
          input(control, value);
          assert.equal(element.playbackMuted, muted); assert.equal(client.playbackMuted, muted);
          assert.equal(element.hasAttribute('playback-muted'), muted);
          assert.equal(element['listen'].getAttribute('aria-pressed'), String(muted));
          assert.equal(element['mic'].disabled, micMuted); assert.equal(control.disabled, false);
          assert.deepEqual(client.me, me); assert.equal(calls(), 0);
        }
      }
    }
    input(control, '0');
    click(element['listen']); await settle();
    assert.equal(element.playbackMuted, false); assert.equal(client.playbackMuted, false);
    assert.equal(element.playbackVolume, 0); assert.equal(client.playbackVolume, 0); assertDisplay(element, 0);
  });

  for (const action of ['hand', 'mic'] as const) {
    it(`stays local while ${action} is pending and preserves unrelated errors and busy state`, async () => {
      const { element, pending, calls } = widget(action === 'mic');
      const control = slider(element);
      click(element[action]);
      element['show'](new Error('Existing room action error'));
      for (const value of ['25', '0', '100']) {
        input(control, value);
        assertDisplay(element, Number(value));
        assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Existing room action error');
        assert.equal(element[action].disabled, true); assert.equal(element[action].getAttribute('aria-busy'), 'true');
        assert.deepEqual([...element['pendingActions']], [element[action]]);
        assert.equal(control.disabled, false); assert.equal(control.getAttribute('aria-busy'), null); assert.equal(calls(), 1);
      }
      pending.reject(new Error('Rejected room action')); await settle();
      input(control, '63');
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Rejected room action');
      assert.equal(element['pendingActions'].size, 0); assertDisplay(element, 63);
    });
  }

  it('does not trigger audio unlock or clear its failure when changing local volume', async t => {
    const { element, client } = await subscribedWidget(t);
    const control = slider(element), pending = deferred();
    const unlock = t.mock.method(client, 'unlockAudio', () => pending.promise);
    element['unlock'].hidden = false; click(element['unlock']);
    input(control, '20');
    assert.equal(element['unlock'].disabled, true); assert.equal(element['unlock'].getAttribute('aria-busy'), 'true');
    assert.equal(unlock.mock.callCount(), 1); assert.equal(control.disabled, false);
    pending.reject(new Error('Audio unlock failed')); await settle();
    input(control, '30');
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Audio unlock failed');
    assert.equal(element['unlock'].hidden, false); assert.equal(unlock.mock.callCount(), 1); assertDisplay(element, 30);
  });

  it('remains usable across reconnect backoff, opening, hello and pending resume ACK', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, roomState(true));
    const control = slider(element), generation = element['generation'];
    element.playbackMuted = true;
    socket.close(); await settle();
    for (let phase = 0; phase < 4; phase++) {
      if (phase === 1) await tick(500);
      if (phase === 2) sockets[1]!.readyState = 1;
      if (phase === 3) await hello(sockets[1]!);
      const frames = sockets.map(current => [...current.sent]), pending = client['pending'].size;
      assertDisplay(element, Math.round(element.playbackVolume * 100)); assert.equal(control.disabled, false);
      input(control, String(phase * 25));
      assert.equal(client.playbackVolume, phase / 4); assert.equal(client.playbackMuted, true);
      assert.equal(element.client, client); assert.equal(element['generation'], generation); assert.equal(client.status, 'reconnecting');
      assert.equal(element['mic'].disabled, true); assert.equal(element['pendingActions'].size, 0);
      assert.equal(client['pending'].size, pending); assert.deepEqual(sockets.map(current => current.sent), frames);
    }
    const replacement = sockets[1]!, resume = replacement.sent.find(message => message.type === 'join');
    assert.ok(resume && resume.type === 'join');
    replacement.deliver({ type: 'room:state', ...roomState(true), resumeToken: 'resume-me' }); await settle();
    assert.equal(client['pending'].has(resume.requestId), true);
    assertDisplay(element, 75); assert.equal(control.disabled, false);
    input(control, '38');
    replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assertDisplay(element, 38); assert.equal(client.playbackVolume, 0.38); assert.equal(client.playbackMuted, true);
  });

  it('rejects a disabled handler and stale input after detachment before its callback runs', () => {
    const { element, client } = widget();
    element.playbackVolume = 0.375;
    const control = slider(element);
    control.disabled = true;
    input(control, '90');
    assert.equal(element.playbackVolume, 0.375); assert.equal(client.playbackVolume, 0.375);
    element['render']();
    assertDisplay(element, 38); assert.equal(control.disabled, false);
    Object.assign(element, { isConnected: false });
    input(control, '70');
    assert.equal(element.playbackVolume, 0.375); assert.equal(client.playbackVolume, 0.375);
    element.disconnectedCallback();
    assertDisplay(element, 38, false); assert.equal(control.disabled, true);
    input(control, '80');
    assert.equal(element.playbackVolume, 0.375); assert.equal(client.playbackVolume, 0.375);
  });

  it('rejects stale enabled input when the current client or joined participant disappears', () => {
    const { element, client } = widget();
    element.playbackVolume = 0.375;
    const control = slider(element);
    Object.assign(client, { me: null });
    input(control, '90');
    assert.equal(element.playbackVolume, 0.375); assert.equal(client.playbackVolume, 0.375);
    element['render']();
    assertDisplay(element, 38, false); assert.equal(control.disabled, true);
    element['current'] = null;
    control.disabled = false;
    input(control, '80');
    assert.equal(element.playbackVolume, 0.375); assert.equal(client.playbackVolume, 0.375);
    element['render']();
    assertDisplay(element, 38, false); assert.equal(control.disabled, true);
  });

  for (const terminal of terminalCases) {
    it(`hides and disables the control after ${terminal.title} without losing its preference`, async t => {
      const { element, client } = await subscribedWidget(t);
      const control = slider(element);
      input(control, '37');
      await client['receive'](terminal.message);
      assertDisplay(element, 37, false); assert.equal(control.disabled, true);
      input(control, '90');
      assert.equal(element.playbackVolume, 0.37); assert.equal(client.playbackVolume, 0.37);
      assert.equal(element['status'].textContent, terminal.text);
    });
  }

  it('retains input preferences across room rejoin and remount, applying them before connecting', async t => {
    const { element, client: first, initialVolumes } = await subscribedWidget(t);
    const control = slider(element);
    input(control, '37'); element.playbackMuted = true;
    element.setAttribute('room', 'two'); await settle();
    const second = element.client;
    assert.ok(second); assert.notEqual(second, first);
    assertDisplay(element, 37, false); assert.equal(control.disabled, true); assert.equal(second.playbackVolume, 0.37);
    await second['receive']({ type: 'room:state', ...roomState(false, 'two') });
    assertDisplay(element, 37); assert.equal(control.disabled, false);
    element.playbackVolume = 0.625;
    assertDisplay(element, 63);
    Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
    assert.equal(element.client, null); assertDisplay(element, 63, false); assert.equal(control.disabled, true);
    input(control, '90');
    assert.equal(element.playbackVolume, 0.625); assert.equal(element.getAttribute('playback-volume'), '0.625');
    Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
    const remounted = element.client as StageClient | null;
    assert.ok(remounted); assert.notEqual(remounted, second);
    assert.deepEqual(initialVolumes, [1, 0.37, 0.625]);
    assert.equal(remounted.playbackVolume, 0.625); assert.equal(remounted.playbackMuted, true);
    assertDisplay(element, 63, false);
    await remounted['receive']({ type: 'room:state', ...roomState(false, 'two') });
    assertDisplay(element, 63); assert.equal(control.disabled, false); assert.equal(slider(element), control, 'remount reuses the same native control');
  });
});


/** Enforces registry name/constructor uniqueness; name syntax is only a fixture subset. */
class Registry {
  readonly definitions = new Map<string, CustomElementConstructor>();
  get(name: string): CustomElementConstructor | undefined { return this.definitions.get(name); }
  define(name: string, constructor: CustomElementConstructor): void {
    if (!/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(name)) throw new DOMException('invalid custom element name', 'SyntaxError');
    if (this.definitions.has(name) || [...this.definitions.values()].includes(constructor)) throw new DOMException('duplicate name or constructor', 'NotSupportedError');
    this.definitions.set(name, constructor);
  }
}
function registry(): Registry {
  const registry = new Registry();
  Object.defineProperty(globalThis, 'customElements', { configurable: true, value: registry });
  return registry;
}
describe('custom widget tag registration', () => {
  it('registers the default widget and multiple custom aliases with independent instances', () => {
    const custom = registry();
    defineStageElement(); defineStageElement('my-stage'); defineStageElement('other-stage');
    const Default = custom.get('stage-client')!, Alias = custom.get('my-stage')!, Other = custom.get('other-stage')!;
    assert.equal(Default, StageElement);
    assert.notEqual(Default, Alias); assert.notEqual(Alias, Other);
    const original = new Default() as InstanceType<typeof StageElement>;
    const alias = new Alias() as InstanceType<typeof StageElement>;
    assert.ok(alias instanceof StageElement);
    assert.deepEqual((Alias as typeof StageElement).observedAttributes, StageElement.observedAttributes);
    original.playbackMuted = true;
    assert.equal(alias.playbackMuted, false);
    original.playbackVolume = 0.25;
    assert.equal(alias.playbackVolume, 1);
    alias.playbackVolume = 0.75;
    assert.equal(alias.getAttribute('playback-volume'), '0.75');
    assert.equal(original.playbackVolume, 0.25);
    alias.removeAttribute('playback-volume');
    assert.equal(alias.playbackVolume, 1);
  });

  it('supports custom-first registration and makes repeated names a no-op', () => {
    const custom = registry();
    defineStageElement('my-stage');
    const alias = custom.get('my-stage');
    defineStageElement(); defineStageElement('my-stage'); defineStageElement();
    assert.equal(custom.get('my-stage'), alias);
    assert.equal(custom.get('stage-client'), StageElement);
    assert.equal(custom.definitions.size, 2);
  });

  it('preserves another component registered under the requested name and propagates invalid names', () => {
    const custom = registry();
    class Existing extends Node {}
    custom.define('existing-widget', Existing as unknown as CustomElementConstructor);
    defineStageElement('existing-widget');
    assert.equal(custom.get('existing-widget'), Existing);
    assert.throws(() => defineStageElement('invalid'), error => error instanceof DOMException && error.name === 'SyntaxError');
    defineStageElement();
    assert.equal(custom.get('stage-client'), StageElement);
  });

});


describe('widget countdown scheduling', () => {
  it('does no clock-driven rendering during an idle mounted minute', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    t.mock.method(StageClient.prototype, 'connect', async () => {});
    t.mock.method(StageClient.prototype, 'join', async () => {});
    t.mock.method(StageClient.prototype, 'disconnect', async () => {});
    const element = new StageElement(); widgets.push(element);
    element.setAttribute('room', 'one'); element.setAttribute('name', 'Listener'); await settle();
    const render = t.mock.method(element as unknown as { render(): void }, 'render');
    t.mock.timers.tick(60000);
    assert.equal(render.mock.callCount(), 0);
    assert.equal(element['cooldownTimer'], undefined);
  });

  it('keeps one non-postponed timer and updates only at displayed-second boundaries until expiry', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0;
    const { element, client } = widget();
    Object.defineProperty(client, 'handCooldownMs', { get: () => Math.max(0, 1500 - now) });
    element['render']();
    const timer = element['cooldownTimer']; assert.ok(timer);
    element['render'](); assert.equal(element['cooldownTimer'], timer);
    assert.equal(element['hand'].textContent, '舉手發言（2 秒）');
    const render = t.mock.method(element as unknown as { render(): void }, 'render');
    now += 499; t.mock.timers.tick(499); assert.equal(render.mock.callCount(), 0);
    now += 1; t.mock.timers.tick(1); assert.equal(render.mock.callCount(), 1);
    assert.equal(element['hand'].textContent, '舉手發言（1 秒）');
    now += 999; t.mock.timers.tick(999); assert.equal(render.mock.callCount(), 1);
    now += 1; t.mock.timers.tick(1); assert.equal(render.mock.callCount(), 2);
    assert.equal(element['hand'].textContent, '舉手發言'); assert.equal(element['hand'].disabled, false);
    assert.equal(element['cooldownTimer'], undefined);
    t.mock.timers.tick(60000); assert.equal(render.mock.callCount(), 2);
  });

  it('rounds fractional deadlines up so timer truncation cannot cause an early extra render', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const schedule = t.mock.method(globalThis, 'setTimeout');
    let now = 0;
    const { element, client } = widget();
    Object.defineProperty(client, 'handCooldownMs', { get: () => Math.max(0, 1500.4 - now) });
    element['render']();
    assert.equal(schedule.mock.calls[0]!.arguments[1], 501);
    const render = t.mock.method(element as unknown as { render(): void }, 'render');
    now = 500; t.mock.timers.tick(500); assert.equal(render.mock.callCount(), 0);
    now = 501; t.mock.timers.tick(1); assert.equal(render.mock.callCount(), 1);
    assert.equal(element['hand'].textContent, '舉手發言（1 秒）');
    assert.equal(schedule.mock.calls[1]!.arguments[1], 1000);
    now = 1501; t.mock.timers.tick(1000); assert.equal(render.mock.callCount(), 2);
    assert.equal(element['cooldownTimer'], undefined);
  });

  it('recomputes an expired cooldown after a delayed wake without replaying missed ticks', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let remaining = 1500;
    const { element, client } = widget();
    Object.defineProperty(client, 'handCooldownMs', { get: () => remaining });
    element['render']();
    const render = t.mock.method(element as unknown as { render(): void }, 'render');
    remaining = 0; // The monotonic deadline elapsed while the page could not run its timer.
    t.mock.timers.tick(30000);
    assert.equal(render.mock.callCount(), 1);
    assert.equal(element['hand'].textContent, '舉手發言'); assert.equal(element['hand'].disabled, false);
    assert.equal(element['cooldownTimer'], undefined);
  });

  it('clears countdown work when raised, on stage, controller, closed or disconnected', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const stop of ['raised', 'stage', 'controller', 'closed', 'disconnected']) {
      const { element, client } = widget(); client.handCooldownMs = 10000; element['render']();
      assert.ok(element['cooldownTimer']);
      if (stop === 'raised') client.me.handRaised = true;
      if (stop === 'stage') client.me.onStage = true;
      if (stop === 'controller') client.me.role = 'controller';
      if (stop === 'closed') Object.defineProperty(client, 'me', { value: null });
      if (stop === 'disconnected') { element.disconnectedCallback(); await settle(); }
      else element['render']();
      assert.equal(element['cooldownTimer'], undefined);
      const render = t.mock.method(element as unknown as { render(): void }, 'render'); t.mock.timers.tick(60000);
      assert.equal(render.mock.callCount(), 0);
    }
  });

  it('starts countdown after withdrawal and does not unlock a still-pending action at expiry', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { element, client, pending } = widget();
    client.me.handRaised = true; client.handCooldownMs = 500; element['render']();
    assert.equal(element['cooldownTimer'], undefined);
    click(element['hand']); client.me.handRaised = false; element['render']();
    assert.ok(element['cooldownTimer']);
    client.handCooldownMs = 0; t.mock.timers.tick(500);
    assert.equal(element['cooldownTimer'], undefined); assert.equal(element['hand'].disabled, true);
    assert.equal(element['hand'].getAttribute('aria-busy'), 'true');
    pending.resolve(); await settle(); assert.equal(element['hand'].disabled, false);
  });
});

function retimingWidget(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000, expires = now;
  t.mock.method(performance, 'now', () => now);
  const schedule = t.mock.method(globalThis, 'setTimeout');
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const fixture = widget();
  const { element, client } = fixture;
  Object.defineProperty(client, 'handCooldownMs', { get: () => Math.max(0, expires - now) });
  const render = t.mock.method(element as unknown as { render(): void }, 'render');
  const active = () => {
    const handle = element['cooldownTimer']; assert.notEqual(handle, undefined);
    const call = schedule.mock.calls.find(call => call.result === handle); assert.ok(call);
    return { handle, delay: call.arguments[1], callback: call.arguments[0] as () => void };
  };
  const retime = (remaining: number) => { expires = now + remaining; element['render'](); };
  const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
  const label = (seconds: number, pending = false, reconnecting = false) => {
    assert.equal(element['hand'].textContent, seconds ? `舉手發言（${seconds} 秒）` : '舉手發言');
    assert.equal(element['hand'].disabled, seconds > 0 || pending || reconnecting);
    assert.equal(element['hand'].getAttribute('aria-busy'), pending ? 'true' : null);
  };
  return { ...fixture, active, retime, advance, label, render, schedule, clear };
}

describe('widget cooldown retiming', () => {
  it('retains its exact handle across repeated snapshots with an unchanged monotonic deadline', t => {
    const h = retimingWidget(t); h.retime(2500); const first = h.active(); h.advance(250);
    for (let i = 0; i < 20; i++) h.element['render']();
    assert.equal(h.active().handle, first.handle); assert.equal(h.schedule.mock.callCount(), 1);
    assert.equal(h.clear.mock.calls.filter(call => call.arguments[0] !== undefined).length, 0);
    h.advance(249); h.label(3); h.advance(1); h.label(2);
    assert.notEqual(h.active().handle, first.handle); assert.equal(h.active().delay, 1000);
  });

  it('replaces an earlier same-label boundary and rejects the replaced callback', t => {
    const h = retimingWidget(t); h.retime(2000); const old = h.active(); assert.equal(old.delay, 1000);
    h.advance(100); h.retime(1100); const next = h.active(); h.label(2);
    assert.notEqual(next.handle, old.handle); assert.equal(next.delay, 100);
    assert.equal(h.clear.mock.calls.filter(call => call.arguments[0] === old.handle).length, 1);
    const renders = h.render.mock.callCount(); old.callback();
    assert.equal(h.render.mock.callCount(), renders); assert.equal(h.active().handle, next.handle);
    h.advance(99); h.label(2); h.advance(1); h.label(1);
    h.advance(999); h.label(1); h.advance(1); h.label(0);
    assert.equal(h.element['cooldownTimer'], undefined);
  });

  it('keeps one earlier wake for an extended deadline and then follows the later boundaries', t => {
    const h = retimingWidget(t); h.retime(1100); const first = h.active(); h.advance(50);
    h.retime(1950); assert.equal(h.active().handle, first.handle); h.label(2);
    assert.equal(h.schedule.mock.callCount(), 1);
    h.advance(50); h.label(2); assert.equal(h.active().delay, 900);
    h.advance(900); h.label(1); assert.equal(h.active().delay, 1000);
    h.advance(100); h.label(1); h.advance(900); h.label(0);
    assert.equal(h.element['cooldownTimer'], undefined);
    assert.equal(h.schedule.mock.callCount(), 3, 'only the already-owned early wake is additional');
  });

  for (const remaining of [0.25, 1000.25, 2500.25]) {
    it(`rounds an earlier retimed ${remaining} ms boundary upward without early expiry`, t => {
      const h = retimingWidget(t); h.retime(4000); const old = h.active(); h.advance(100); h.retime(remaining);
      const first = h.active(); const delay = Math.ceil(remaining % 1000);
      assert.notEqual(first.handle, old.handle); assert.equal(first.delay, delay);
      const renders = h.render.mock.callCount(); h.advance(delay - 0.5);
      assert.equal(h.render.mock.callCount(), renders); h.label(Math.ceil(remaining / 1000));
      h.advance(0.5); h.label(Math.ceil(Math.max(0, remaining - delay) / 1000));
      for (let i = 1; i < Math.ceil(remaining / 1000); i++) h.advance(1000);
      h.label(0); assert.equal(h.element['cooldownTimer'], undefined);
      const settled = h.render.mock.callCount(); h.advance(10000); assert.equal(h.render.mock.callCount(), settled);
    });
  }

  it('immediate expiry clears ownership and a retired callback cannot erase a fresh countdown', t => {
    const h = retimingWidget(t); h.retime(2500); const old = h.active(); h.advance(100); h.retime(0);
    h.label(0); assert.equal(h.element['cooldownTimer'], undefined);
    let renders = h.render.mock.callCount(); old.callback(); assert.equal(h.render.mock.callCount(), renders);
    h.retime(1200); const fresh = h.active(); assert.equal(fresh.delay, 200); renders = h.render.mock.callCount();
    old.callback(); assert.equal(h.render.mock.callCount(), renders); assert.equal(h.active().handle, fresh.handle);
    h.advance(200); h.label(1); h.advance(1000); h.label(0);
  });

  it('an already-fired callback cannot clear or duplicate the next boundary timer', t => {
    const h = retimingWidget(t); h.retime(2500); const first = h.active(); h.advance(500);
    const next = h.active(); const renders = h.render.mock.callCount(); first.callback();
    assert.equal(h.active().handle, next.handle); assert.equal(h.render.mock.callCount(), renders);
    assert.equal(h.schedule.mock.callCount(), 2); h.advance(1000); h.label(1);
  });

  it('retimed expiry cannot release a still-pending withdrawal', async t => {
    const h = retimingWidget(t); h.client.me.handRaised = true; h.retime(2000);
    assert.equal(h.element['cooldownTimer'], undefined); click(h.element['hand']); assert.equal(h.calls(), 1);
    h.client.me.handRaised = false; h.element['render'](); const old = h.active();
    h.advance(100); h.retime(50); assert.notEqual(h.active().handle, old.handle); h.label(1, true);
    h.advance(50); h.label(0, true); assert.equal(h.element['cooldownTimer'], undefined);
    click(h.element['hand']); assert.equal(h.calls(), 1);
    h.pending.resolve(); await settle(); h.label(0);
  });

  it('retimed expiry preserves reconnect admission until status recovery', t => {
    const h = retimingWidget(t); h.retime(2000); const old = h.active(); h.advance(100);
    h.client.status = 'reconnecting'; h.retime(50); assert.notEqual(h.active().handle, old.handle);
    h.label(1, false, true); h.advance(50); h.label(0, false, true);
    assert.equal(h.element['cooldownTimer'], undefined); click(h.element['hand']); assert.equal(h.calls(), 0);
    h.client.status = 'live'; h.element['render'](); h.label(0);
  });

  for (const policy of ['raised', 'stage', 'controller'] as const) {
    it(`${policy} retires a hidden countdown and rejects its callback after visibility returns`, t => {
      const h = retimingWidget(t); h.retime(2500); const old = h.active();
      if (policy === 'raised') h.client.me.handRaised = true;
      if (policy === 'stage') h.client.me.onStage = true;
      if (policy === 'controller') h.client.me.role = 'controller';
      h.element['render'](); assert.equal(h.element['cooldownTimer'], undefined);
      const renders = h.render.mock.callCount(); old.callback(); assert.equal(h.render.mock.callCount(), renders);
      h.advance(100); Object.assign(h.client.me, { handRaised: false, onStage: false, role: 'audience' });
      h.element['render'](); const next = h.active(); assert.equal(next.delay, 400);
      old.callback(); assert.equal(h.active().handle, next.handle); h.advance(400); h.label(2);
    });
  }

  it('unmount rejects its retired callback before and after a replacement client countdown', async t => {
    const h = retimingWidget(t); h.retime(2500); const old = h.active(); h.element.disconnectedCallback(); await settle();
    assert.equal(h.element['cooldownTimer'], undefined);
    let renders = h.render.mock.callCount(); old.callback(); assert.equal(h.render.mock.callCount(), renders);
    const replacement = { ...h.client, handCooldownMs: 4500 };
    h.element['current'] = replacement as unknown as StageClient; h.element['render'](); const active = h.active();
    renders = h.render.mock.callCount(); old.callback();
    assert.equal(h.active().handle, active.handle); assert.equal(h.render.mock.callCount(), renders); h.label(5);
  });
});

function controllerState(onStage = false, roomId = 'one'): RoomStatePayload {
  const state = roomState(onStage, roomId);
  state.me.role = 'controller'; state.controllerId = state.me.participantId;
  return state;
}

function assertPersonalStage(element: InstanceType<typeof StageElement>, expected: { hidden?: boolean; disabled?: boolean; returning?: boolean; busy?: boolean } = {}): void {
  const button = element['leaveStage'];
  assert.equal(button.hidden, expected.hidden ?? false);
  assert.equal(button.disabled, expected.disabled ?? false);
  if (expected.returning !== undefined) assert.equal(button.textContent, expected.returning ? '返回舞台' : '離開舞台');
  assert.equal(button.getAttribute('aria-busy'), expected.busy ? 'true' : null);
}

/** Direct invocation also models stale or application-mutated button DOM, not a browser click. */
function forcePersonalStage(element: InstanceType<typeof StageElement>): void {
  const button = element['leaveStage'], disabled = button.disabled;
  button.disabled = false;
  // Restore the test's DOM mutation; rejected admission intentionally has no render/finally side effect.
  try { click(button); } finally { button.disabled = disabled; }
}

const personalStageActions = [
  { title: 'controller return', state: () => controllerState(), method: 'returnToStage', type: 'stage:approve' },
  { title: 'controller leave', state: () => controllerState(true), method: 'leaveStage', type: 'stage:leave' },
  { title: 'speaker leave', state: () => roomState(true), method: 'leaveStage', type: 'stage:leave' },
] as const;

describe('widget personal stage control', () => {
  it('reuses one role-aware button and never gives offstage audience or an absent participant a stage action', async t => {
    const { element, client } = await subscribedWidget(t);
    const button = element['leaveStage'];
    const leave = t.mock.method(client, 'leaveStage', async () => {});
    const returning = t.mock.method(client, 'returnToStage', async () => {});
    for (const state of [roomState(true), controllerState(true), controllerState(), roomState()]) {
      await client['receive']({ type: 'room:state', ...state });
      const eligible = state.me.onStage || state.me.role === 'controller';
      assert.equal(element['leaveStage'], button);
      assertPersonalStage(element, { hidden: !eligible, disabled: !eligible, returning: !state.me.onStage });
      assert.equal(button.type, 'button');
      if (!state.me.onStage) {
        assert.equal(element['hand'].hidden, state.me.role === 'controller');
        assert.equal(element['mic'].hidden, true);
      }
      if (!eligible) { click(button); forcePersonalStage(element); await settle(); }
    }
    await client.disconnect();
    assertPersonalStage(element, { hidden: true, disabled: true });
    forcePersonalStage(element); await settle();
    element['current'] = null; element['render'](); forcePersonalStage(element); await settle();
    assertPersonalStage(element, { hidden: true, disabled: true });
    assert.equal(leave.mock.callCount(), 0);
    assert.equal(returning.mock.callCount(), 0);
    assert.equal(element['pendingActions'].size, 0);
  });

  for (const action of personalStageActions) {
    it(`sends the public SDK ${action.title} request and keeps the same button pending across state before ACK`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t, action.state());
      const selected = t.mock.method(client, action.method);
      const opposite = t.mock.method(client, action.method === 'leaveStage' ? 'returnToStage' : 'leaveStage');
      const initial = client.state;
      const button = element['leaveStage'];
      assertPersonalStage(element, { returning: action.method === 'returnToStage' });
      click(button); click(button); await tick(100);
      assert.equal(selected.mock.callCount(), 1); assert.equal(opposite.mock.callCount(), 0);
      const commands = socket.sent.filter(message => message.type === action.type);
      assert.equal(commands.length, 1);
      const command = commands[0]!; assert.ok('requestId' in command);
      if (command.type === 'stage:approve') assert.equal(command.targetId, client.me!.participantId);
      assert.equal(client.state, initial, 'a click does not optimistically alter membership');
      const state = action.method === 'returnToStage' ? controllerState(true)
        : action.title === 'controller leave' ? controllerState() : roomState();
      socket.deliver({ type: 'room:state', ...state }); await settle();
      assert.equal(element['leaveStage'], button);
      const hidden = state.me.role !== 'controller' && !state.me.onStage;
      assertPersonalStage(element, { hidden, disabled: true, returning: !state.me.onStage, busy: true });
      forcePersonalStage(element); await tick(100);
      assert.equal(selected.mock.callCount(), 1); assert.equal(opposite.mock.callCount(), 0);
      assert.equal(client['pending'].has(command.requestId), true);
      socket.deliver({ type: 'ok', requestId: command.requestId }); await settle();
      assertPersonalStage(element, { hidden, disabled: hidden, returning: !state.me.onStage });
      assert.equal(element['error'].hidden, true);
      assert.equal(client['pending'].size, 0);
    });
  }

  for (const code of ['stage_full', 'forbidden'] as const) {
    it(`preserves ${code} errors, releases return pending state and allows an explicit retry`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t, controllerState());
      const before = client.state;
      const returning = t.mock.method(client, 'returnToStage');
      click(element['leaveStage']); await tick(100);
      const command = socket.sent.find(message => message.type === 'stage:approve');
      assert.ok(command && command.type === 'stage:approve');
      socket.deliver({ type: 'error', requestId: command.requestId, code, message: `server ${code}` }); await settle();
      assertPersonalStage(element, { returning: true });
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, `server ${code}`);
      assert.equal(client.state, before); assert.equal(client['pending'].size, 0);
      click(element['leaveStage']); await tick(100);
      assert.equal(returning.mock.callCount(), 2); assert.equal(element['error'].hidden, true);
      const retry = socket.sent.filter(message => message.type === 'stage:approve').at(-1)!;
      assert.notEqual(retry.requestId, command.requestId);
      socket.deliver({ type: 'ok', requestId: retry.requestId }); await settle();
      assertPersonalStage(element, { returning: true });
    });
  }

  it('preserves an actual local SDK queue_full error without sending a return request, then admits retry after capacity releases', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, controllerState());
    // The widget uses the SDK's unbounded default; select its supported finite-capacity policy at the test seam.
    Object.defineProperty(client, 'maxPendingControlRequests', { value: 1 });
    const occupied = client.mute(); void occupied.catch(() => {}); await tick(100);
    const held = socket.sent.find(message => message.type === 'mic:mute'); assert.ok(held);
    click(element['leaveStage']); await settle();
    assertPersonalStage(element, { returning: true });
    assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, '待回覆控制請求已滿，請等待完成後再試。');
    assert.equal(socket.sent.some(message => message.type === 'stage:approve'), false);
    assert.equal(client['pendingControlRequests'], 1);
    socket.deliver({ type: 'ok', requestId: held.requestId }); await occupied;
    click(element['leaveStage']); await tick(100);
    const retry = socket.sent.find(message => message.type === 'stage:approve'); assert.ok(retry);
    assert.equal(element['error'].hidden, true);
    socket.deliver({ type: 'ok', requestId: retry.requestId }); await settle();
    assertPersonalStage(element, { returning: true });
    assert.equal(client['pendingControlRequests'], 0);
  });

  it('allows a force-muted participant to leave without calling unmute', async t => {
    const state = controllerState(true); Object.assign(state.me, { muted: true, forceMuted: true });
    const { element, client, socket, tick } = await socketJoinedWidget(t, state);
    const unmute = t.mock.method(client, 'unmute');
    assert.equal(element['mic'].disabled, true); assertPersonalStage(element, { returning: false });
    click(element['leaveStage']); await tick(100);
    const command = socket.sent.find(message => message.type === 'stage:leave');
    assert.ok(command && command.type === 'stage:leave'); assert.equal(unmute.mock.callCount(), 0);
    socket.deliver({ type: 'ok', requestId: command.requestId }); await settle();
    assertPersonalStage(element, { returning: false }); assert.equal(element['mic'].disabled, true);
  });

  for (const phase of ['backoff', 'CONNECTING', 'OPEN before hello', 'awaiting resume state'] as const) {
    it(`blocks controller return during ${phase} and restores it on authoritative state before resume ACK`, async t => {
      const state = controllerState();
      const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, state);
      const returning = t.mock.method(client, 'returnToStage');
      socket.close(); await settle();
      if (phase !== 'backoff') await tick(500);
      if (phase === 'OPEN before hello') sockets[1]!.readyState = 1;
      let resume = phase === 'awaiting resume state' ? await hello(sockets[1]!) : undefined;
      assertPersonalStage(element, { returning: true, disabled: true });
      const frames = sockets.map(current => [...current.sent]);
      click(element['leaveStage']); forcePersonalStage(element); await settle();
      assert.equal(returning.mock.callCount(), 0); assert.deepEqual(sockets.map(current => current.sent), frames);
      assertPersonalStage(element, { returning: true, disabled: true });
      if (phase === 'backoff') await tick(500);
      const replacement = sockets[1]!; resume ??= await hello(replacement);
      replacement.deliver({ type: 'room:state', ...state }); await settle();
      assert.equal(client['pending'].has(resume.requestId), true);
      assertPersonalStage(element, { returning: true });
      click(element['leaveStage']); await tick(100);
      const command = replacement.sent.find(message => message.type === 'stage:approve');
      assert.ok(command && command.type === 'stage:approve'); assert.equal(command.targetId, state.me.participantId);
      replacement.deliver({ type: 'ok', requestId: command.requestId });
      replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
      assertPersonalStage(element, { returning: true }); assert.equal(returning.mock.callCount(), 1);
    });
  }

  for (const transition of ['controller demotion', 'speaker departure', 'controller returns', 'controller steps down', 'reconnecting', 'detached', 'current cleared'] as const) {
    it(`rechecks current membership during forwarded ${transition} before the old eligible button is rendered`, async t => {
      const { element, client } = await subscribedWidget(t);
      const initial = transition === 'speaker departure' ? roomState(true)
        : transition === 'controller steps down' ? controllerState(true) : controllerState();
      await client['receive']({ type: 'room:state', ...initial });
      const leave = t.mock.method(client, 'leaveStage', async () => {});
      const returning = t.mock.method(client, 'returnToStage', async () => {});
      const oldLabel = element['leaveStage'].textContent;
      let calls = 0;
      element.addEventListener(transition === 'reconnecting' ? 'stage-status' : 'stage-state', () => {
        calls++;
        assert.equal(element['leaveStage'].disabled, false, 'the callback runs before the post-forward render');
        assert.equal(element['leaveStage'].textContent, oldLabel);
        if (transition === 'detached') Object.assign(element, { isConnected: false });
        if (transition === 'current cleared') element['current'] = null;
        click(element['leaveStage']);
      }, { once: true });
      if (transition === 'reconnecting') await client['receive']({ type: 'status', state: 'reconnecting' });
      else {
        const next = transition === 'controller returns' ? controllerState(true)
          : transition === 'controller steps down' ? controllerState()
          : transition === 'controller demotion' || transition === 'speaker departure' ? roomState() : initial;
        await client['receive']({ type: 'room:state', ...next });
      }
      await settle();
      assert.equal(calls, 1);
      assert.equal(leave.mock.callCount(), transition === 'controller returns' ? 1 : 0);
      assert.equal(returning.mock.callCount(), transition === 'controller steps down' ? 1 : 0);
      if (transition === 'current cleared') await client.disconnect();
      assert.equal(element['pendingActions'].size, 0);
    });
  }

  for (const transition of ['room change', 'attribute change', 'remount'] as const) {
    for (const outcome of ['resolution', 'rejection'] as const) {
      it(`isolates old stage ${outcome} and finally after ${transition} from a replacement pending action and error`, async t => {
        const { element, client } = await subscribedWidget(t);
        await client['receive']({ type: 'room:state', ...controllerState() });
        const retired = deferred(), active = deferred();
        t.after(async () => { retired.resolve(); active.resolve(); await settle(); });
        t.mock.method(client, 'returnToStage', () => retired.promise);
        click(element['leaveStage']); assertPersonalStage(element, { returning: true, disabled: true, busy: true });
        if (transition === 'remount') {
          Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
          assertPersonalStage(element, { hidden: true, disabled: true });
          Object.assign(element, { isConnected: true }); element.connectedCallback();
        } else element.setAttribute(transition === 'room change' ? 'room' : 'code', 'replacement');
        await settle();
        const replacement = element.client; assert.ok(replacement); assert.notEqual(replacement, client);
        await replacement['receive']({ type: 'room:state', ...controllerState(false, 'replacement') });
        t.mock.method(replacement, 'returnToStage', () => active.promise);
        click(element['leaveStage']);
        await replacement['receive']({ type: 'error', code: 'forbidden', message: 'current room error' });
        if (outcome === 'resolution') retired.resolve(); else retired.reject(new Error('retired stage failure'));
        await settle();
        assert.equal(element.client, replacement);
        assertPersonalStage(element, { returning: true, disabled: true, busy: true });
        assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'current room error');
        assert.equal(element['pendingActions'].size, 1);
        active.resolve(); await settle(); assertPersonalStage(element, { returning: true });
        assert.equal(element['error'].textContent, 'current room error'); assert.equal(element['error'].hidden, false);
      });
    }
  }

  for (const outcome of ['ok', 'error'] as const) {
    it(`ignores a retired socket's late ${outcome} while a replacement return is pending`, async t => {
      const { element, socket, sockets, tick, hello } = await socketJoinedWidget(t, controllerState());
      click(element['leaveStage']); await tick(100);
      const retired = socket.sent.find(message => message.type === 'stage:approve'); assert.ok(retired);
      element.setAttribute(outcome === 'ok' ? 'room' : 'code', 'replacement'); await settle();
      const replacement = sockets[1]!; const join = await hello(replacement);
      replacement.deliver({ type: 'room:state', ...controllerState(false, 'replacement') });
      replacement.deliver({ type: 'ok', requestId: join.requestId }); await settle();
      click(element['leaveStage']); await tick(100);
      const active = replacement.sent.find(message => message.type === 'stage:approve'); assert.ok(active);
      replacement.deliver({ type: 'error', code: 'forbidden', message: 'current room error' });
      if (outcome === 'ok') socket.deliver({ type: 'ok', requestId: retired.requestId });
      else socket.deliver({ type: 'error', requestId: retired.requestId, code: 'forbidden', message: 'retired wire error' });
      await settle();
      assertPersonalStage(element, { returning: true, disabled: true, busy: true });
      assert.equal(element['error'].textContent, 'current room error'); assert.equal(element['error'].hidden, false);
      assert.equal(element.client!['pending'].has(active.requestId), true);
      replacement.deliver({ type: 'ok', requestId: active.requestId }); await settle();
      assertPersonalStage(element, { returning: true });
      assert.equal(element['error'].textContent, 'current room error'); assert.equal(element['error'].hidden, false);
    });
  }

  for (const terminal of [null, ...terminalCases]) {
    it(`hides and blocks personal stage control after ${terminal?.title ?? 'exposed-client disconnect'}`, async t => {
      const { element, client } = await subscribedWidget(t);
      await client['receive']({ type: 'room:state', ...controllerState() });
      const returning = t.mock.method(client, 'returnToStage', async () => {});
      if (terminal) await client['receive'](terminal.message); else await client.disconnect();
      assertPersonalStage(element, { hidden: true, disabled: true });
      forcePersonalStage(element); await settle();
      assert.equal(returning.mock.callCount(), 0);
      assertPersonalStage(element, { hidden: true, disabled: true });
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
    });
  }

  it('uses an actual Hub expiry snapshot and the public SDK to take the reserved ninth seat and voluntarily leave it', async t => {
    const config = testConfig(c => { c.limits.maxSpeakersPerRoom = 8; c.rooms.qualityIntervalMs = 0; c.rooms.controllerGraceMs = 60_000; c.rooms.participantGraceMs = 15_000; });
    const h = harness(config);
    t.after(async () => {
      await h.hub.shutdown();
      assert.equal(h.hub.roomCount, 0); assert.equal(h.transport.rooms.size, 0);
      assert.equal(h.timers.filter(timer => !timer.cleared).length, 0);
    });
    const host = await h.create(); assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    const audience = await h.join(host.roomId, host.code, 'Next controller');
    assert.equal(await h.req(audience.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
    const speakers: Awaited<ReturnType<Harness['join']>>[] = [];
    for (let i = 0; i < 8; i++) {
      h.clock.now++; const speaker = await h.join(host.roomId, host.code, `Speaker ${i}`);
      assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
      assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
      assert.equal(await h.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok'); speakers.push(speaker);
    }
    const { element, client, socket, tick } = await socketJoinedWidget(t, audience.s.last('room:state')!);
    assertPersonalStage(element, { hidden: true, disabled: true });
    await h.hub.detach(host.s);
    const expiry = h.timers.find(timer => !timer.cleared && timer.ms === config.rooms.controllerGraceMs); assert.ok(expiry);
    h.clock.now += 52_500; for (const speaker of speakers) await h.hub.detach(speaker.s); h.clock.now += 7500;
    const peer = h.transport.rooms.get(host.roomId)!.peers.get(audience.id);
    const retained = speakers.map(person => h.transport.rooms.get(host.roomId)!.peers.get(person.id));
    expiry.cleared = true; expiry.fn(); await nextTurn();
    const promoted = audience.s.last('room:state')!;
    assert.equal(promoted.me.role, 'controller'); assert.equal(promoted.me.onStage, false);
    assert.equal(promoted.speakers.length, 8); assert.ok(promoted.speakers.every(person => !person.connected));
    socket.deliver(promoted); await settle();
    assertPersonalStage(element, { returning: true }); assert.equal(element['hand'].hidden, true);
    click(element['leaveStage']); await tick(100);
    const returning = socket.sent.find(message => message.type === 'stage:approve');
    assert.ok(returning && returning.type === 'stage:approve'); assert.equal(returning.targetId, audience.id);
    const relay = async (command: ClientMessage) => {
      assert.ok('requestId' in command);
      const start = audience.s.inbox.length;
      await h.hub.handle(audience.s, command);
      const replies = audience.s.inbox.slice(start);
      for (const message of replies.filter(message => message.type !== 'ok' && message.type !== 'error')) socket.deliver(message);
      const reply = replies.find(message => (message.type === 'ok' || message.type === 'error') && message.requestId === command.requestId);
      assert.ok(reply && reply.type === 'ok');
      await settle(); return reply;
    };
    const returned = await relay(returning);
    assert.equal(client.me!.onStage, true); assert.equal(client.state!.speakers.length, 9);
    assertPersonalStage(element, { returning: false, disabled: true, busy: true });
    socket.deliver(returned); await settle(); assertPersonalStage(element, { returning: false });
    click(element['leaveStage']); await tick(100);
    const leaving = socket.sent.find(message => message.type === 'stage:leave'); assert.ok(leaving);
    const left = await relay(leaving);
    assert.equal(client.me!.role, 'controller'); assert.equal(client.me!.onStage, false);
    assert.equal(client.state!.controllerId, audience.id); assert.equal(client.state!.code, host.code);
    assertPersonalStage(element, { returning: true, disabled: true, busy: true });
    socket.deliver(left); await settle(); assertPersonalStage(element, { returning: true });
    assert.equal(await h.req(audience.s, { type: 'hand:raise' }), 'conflict');
    assert.equal(await h.req(audience.s, { type: 'mic:force-mute', targetId: speakers[0]!.id }), 'ok');
    assert.equal(await h.req(audience.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'forbidden');
    const extra = await h.join(host.roomId, host.code, 'Waiting audience');
    assert.equal(await h.req(extra.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(audience.s, { type: 'stage:approve', targetId: extra.id }), 'stage_full');
    assert.equal(await h.req(extra.s, { type: 'stage:approve', targetId: extra.id }), 'forbidden');
    assert.equal(h.transport.rooms.get(host.roomId)!.peers.get(audience.id), peer);
    assert.deepEqual(speakers.map(person => h.transport.rooms.get(host.roomId)!.peers.get(person.id)), retained);
  });

  it('stops capture on the leave snapshot before ACK and reacquires a fresh fake microphone only on an accepted return snapshot', async t => {
    const originals = new Map(['navigator', 'RTCPeerConnection', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const tracks: { enabled: boolean; stops: number; stop(): void }[] = [];
    class Peer {
      static instances: Peer[] = [];
      connectionState = 'connected'; signalingState = 'stable'; localDescription = null; closed = false;
      readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown, replaceTrack: async (track: unknown) => { this.transceiver.sender.track = track; } } };
      constructor() { Peer.instances.push(this); }
      addTransceiver() { return this.transceiver; }
      close(): void { this.closed = true; }
    }
    class Context {
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
      async resume() {} async close() {}
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
      const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; } }); tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    } } } });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
    // This covers the real capture lifecycle and sender attachment, not browser SDP negotiation.
    t.mock.method(StageClient.prototype as unknown as { negotiate(): void }, 'negotiate', () => {});
    t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
    const { element, client, socket, tick } = await socketJoinedWidget(t, controllerState(true), true);
    await client['mediaTask'];
    assert.equal(tracks.length, 1); const first = tracks[0]!; const peer = Peer.instances[0]!;
    assert.equal(peer.transceiver.sender.track, first); assert.equal(peer.transceiver.direction, 'sendrecv');
    click(element['leaveStage']); await tick(100);
    const leaving = socket.sent.find(message => message.type === 'stage:leave'); assert.ok(leaving);
    assert.equal(first.stops, 0, 'a request alone cannot fabricate stage membership');
    socket.deliver({ type: 'room:state', ...controllerState() });
    assert.equal(first.stops, 1, 'capture stops synchronously before forwarding offstage state');
    assert.equal(first.enabled, false); await client['mediaTask'];
    assert.equal(client['mic'], null); assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.transceiver.direction, 'recvonly');
    assertPersonalStage(element, { returning: true, disabled: true, busy: true });
    socket.deliver({ type: 'ok', requestId: leaving.requestId }); await settle();
    click(element['leaveStage']); await tick(100);
    const returning = socket.sent.find(message => message.type === 'stage:approve'); assert.ok(returning);
    assert.equal(tracks.length, 1, 'return requests do not optimistically open a microphone');
    const accepted = controllerState(true); Object.assign(accepted.me, { muted: true, forceMuted: true });
    socket.deliver({ type: 'room:state', ...accepted }); await client['mediaTask'];
    assert.equal(tracks.length, 2); assert.equal(first.stops, 1);
    assert.notEqual(tracks[1], first); assert.equal(tracks[1]!.enabled, false); assert.equal(tracks[1]!.stops, 0);
    assert.equal(peer.transceiver.sender.track, tracks[1]); assert.equal(Peer.instances.length, 1); assert.equal(peer.closed, false);
    assertPersonalStage(element, { returning: false, disabled: true, busy: true }); assert.equal(element['mic'].disabled, true);
    socket.deliver({ type: 'ok', requestId: returning.requestId }); await settle();
    assertPersonalStage(element, { returning: false });
    await client.disconnect(); assert.equal(tracks[1]!.stops, 1); assert.equal(peer.closed, true);
  });
});

describe('widget explicit microphone retry', () => {
  type Widget = InstanceType<typeof StageElement>;
  type Track = EventTarget & { enabled: boolean; readyState: string; stops: number; stop(): void; end(): void };
  function captureRequest() {
    let resolve!: (stream: MediaStream) => void, reject!: (error: unknown) => void;
    const promise = new Promise<MediaStream>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function fakeCapture(t: TestContext, denyInitial = true) {
    const originals = new Map(['navigator', 'RTCPeerConnection', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const requests: ReturnType<typeof captureRequest>[] = [], tracks: Track[] = [];
    let holdCapture = false, holdInstall = false;
    function source(): MediaStream {
      const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
        stop() { this.stops++; this.readyState = 'ended'; },
        end(this: Track) { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); },
      });
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    }
    class Peer {
      static instances: Peer[] = [];
      connectionState = 'connected'; signalingState = 'stable'; localDescription = null; closed = false;
      readonly installs: ReturnType<typeof deferred>[] = [];
      readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown,
        replaceTrack: async (track: unknown) => {
          if (holdInstall && track) { const pending = deferred(); this.installs.push(pending); await pending.promise; }
          this.transceiver.sender.track = track;
        },
      } };
      constructor() { Peer.instances.push(this); }
      addTransceiver() { return this.transceiver; }
      close(): void { this.closed = true; }
    }
    class Context {
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
      async resume() {} async close() {}
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => {
      const request = captureRequest(); requests.push(request);
      if (requests.length === 1 && denyInitial) request.reject(new DOMException('controlled denial', 'NotAllowedError'));
      else if (!holdCapture) request.resolve(source());
      return request.promise;
    } } } });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
    // Exercises real capture ownership and sender installation, not browser SDP or audible delivery.
    t.mock.method(StageClient.prototype as unknown as { negotiate(): void }, 'negotiate', () => {});
    t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
    return { requests, tracks, Peer, source,
      hold(capture = true, install = false) { holdCapture = capture; holdInstall = install; },
    };
  }
  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) { if (predicate()) return; await settle(); }
    assert.fail(label);
  }
  function microphoneError(client: StageClient, message = 'controlled microphone failure'): void {
    client.dispatchEvent(new CustomEvent('micerror', { detail: { name: 'NotReadableError', message } }));
  }
  function microphoneReady(client: StageClient): void {
    client.dispatchEvent(new CustomEvent('micready', { detail: undefined }));
  }
  function assertRetry(element: Widget, { hidden = false, disabled = hidden, busy = false }: { hidden?: boolean; disabled?: boolean; busy?: boolean } = {}): void {
    const button = element['micRetry'];
    assert.equal(button.textContent, busy ? '正在要求麥克風…' : '重試麥克風');
    assert.equal(button.getAttribute('aria-label'), '重試麥克風');
    assert.equal(button.type, 'button');
    assert.equal(button.hidden, hidden, 'microphone retry visibility');
    assert.equal(button.disabled, disabled, 'microphone retry admission');
    assert.equal(button.getAttribute('aria-busy'), String(busy), 'microphone retry event-owned pending');
  }
  function forceRetry(element: Widget): void {
    element['micRetry'].disabled = false;
    click(element['micRetry']);
  }
  async function failedWidget(t: TestContext) {
    const fixture = await subscribedWidget(t, true);
    microphoneError(fixture.client);
    assertRetry(fixture.element);
    return fixture;
  }

  for (const cause of ['initial denial', 'natural end'] as const) {
    it(`offers ${cause} recovery only on an explicit click and retains one peer and participant`, async t => {
      const media = fakeCapture(t, cause === 'initial denial');
      const { element, client, socket, sockets } = await socketJoinedWidget(t, roomState(true), true);
      await client['mediaTask'];
      const peer = media.Peer.instances[0]!;
      if (cause === 'natural end') {
        assertRetry(element, { hidden: true });
        assert.equal(peer.transceiver.sender.track, media.tracks[0]);
        media.tracks[0]!.end();
        assert.equal(client['mic'], null); assert.equal(client['micFailed'], true);
        assertRetry(element);
        await client['mediaTask'];
      }
      assertRetry(element); assert.equal(element['error'].hidden, false);
      assert.equal(element['retry'].hidden, true, 'capture failure does not offer fresh room join');
      assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.transceiver.direction, 'recvonly');
      const captures = media.requests.length, frames = [...socket.sent];
      socket.deliver({ type: 'room:state', ...roomState(true) }); await client['mediaTask'];
      assert.equal(media.requests.length, captures, 'ordinary snapshots never reacquire failed capture');
      media.hold(true, true);
      const retry = t.mock.method(client, 'retryMicrophone');
      click(element['micRetry']);
      assertRetry(element, { disabled: true, busy: true });
      assert.equal(element['error'].hidden, true, 'admission clears the unchanged prior capture alert');
      await until(() => media.requests.length === captures + 1, 'the admitted capture starts');
      await settle(); await settle();
      assertRetry(element, { disabled: true, busy: true });
      click(element['micRetry']); forceRetry(element);
      assert.equal(retry.mock.callCount(), 1, 'even a forced duplicate handler cannot prompt twice');
      assert.equal(media.requests.length, captures + 1);
      let ready = 0;
      element.addEventListener('stage-micready', event => {
        ready++;
        assert.equal((event as CustomEvent).detail, new CustomEvent('micready', { detail: undefined }).detail);
        assert.equal(event.bubbles, true); assert.equal(event.composed, true);
        assertRetry(element, { hidden: true });
        assert.equal(peer.transceiver.sender.track, null, 'capture-ready precedes sender attachment');
        assert.equal(peer.transceiver.direction, 'recvonly');
        forceRetry(element);
      }, { once: true });
      media.requests.at(-1)!.resolve(media.source());
      await until(() => peer.installs.length === 1, 'sender installation reaches its controlled gate');
      assert.equal(ready, 1); assertRetry(element, { hidden: true });
      assert.equal(retry.mock.callCount(), 1); assert.equal(client['micFailed'], false);
      assert.equal(peer.transceiver.sender.track, null, 'the widget does not wait for or claim installed audio');
      peer.installs[0]!.resolve(); await client['mediaTask'];
      assert.equal(peer.transceiver.sender.track, media.tracks.at(-1)); assert.equal(peer.transceiver.direction, 'sendrecv');
      assert.equal(element.client, client); assert.equal(client.me!.participantId, 'me'); assert.equal(client.me!.onStage, true);
      assert.equal(sockets.length, 1); assert.equal(media.Peer.instances.length, 1); assert.equal(peer.closed, false);
      assert.deepEqual(socket.sent, frames, 'no room control traffic; only SDP negotiation is stubbed');
    });
  }

  it('restores explicit retry on a subsequent real capture error without another automatic prompt', async t => {
    const media = fakeCapture(t);
    const { element, client, socket } = await socketJoinedWidget(t, roomState(true), true);
    await client['mediaTask']; media.hold();
    click(element['micRetry']); await until(() => media.requests.length === 2, 'retry requests capture');
    media.requests[1]!.reject(new DOMException('controlled missing device', 'NotFoundError'));
    await client['mediaTask'];
    assertRetry(element); assert.equal(element['error'].hidden, false);
    assert.match(element['error'].textContent ?? '', /找不到麥克風/);
    socket.deliver({ type: 'room:state', ...roomState(true) }); await client['mediaTask'];
    assert.equal(media.requests.length, 2);
    click(element['micRetry']); await until(() => media.requests.length === 3, 'a later click retries once');
    media.requests[2]!.resolve(media.source()); await client['mediaTask'];
    assertRetry(element, { hidden: true }); assert.equal(element['error'].hidden, true);
  });

  for (const policy of ['muted', 'force-muted'] as const) {
    it(`recaptures a ${policy} microphone without issuing unmute or overriding mute policy`, async t => {
      const media = fakeCapture(t);
      const state = roomState(true); state.me.muted = true; state.me.forceMuted = policy === 'force-muted';
      const { element, client, socket } = await socketJoinedWidget(t, state, true);
      await client['mediaTask']; assertRetry(element);
      assert.equal(element['mic'].disabled, state.me.forceMuted);
      const frames = [...socket.sent];
      const mute = t.mock.method(client, 'mute'), unmute = t.mock.method(client, 'unmute');
      click(element['micRetry']); await client['mediaTask'];
      assertRetry(element, { hidden: true });
      assert.equal(media.requests.length, 2); assert.equal(media.tracks.at(-1)!.enabled, false);
      assert.equal(client.me!.muted, true); assert.equal(client.me!.forceMuted, state.me.forceMuted);
      assert.equal(mute.mock.callCount(), 0); assert.equal(unmute.mock.callCount(), 0); assert.deepEqual(socket.sent, frames);
    });
  }

  it('surfaces generic sender-install rejection after capture-ready without claiming audio recovery or reopening capture retry', async t => {
    const media = fakeCapture(t);
    const { element, client } = await socketJoinedWidget(t, roomState(true), true);
    await client['mediaTask']; media.hold(true, true);
    click(element['micRetry']); await until(() => media.requests.length === 2, 'retry requests capture');
    media.requests[1]!.resolve(media.source());
    const peer = media.Peer.instances[0]!;
    await until(() => peer.installs.length === 1, 'capture-ready precedes gated installation');
    assertRetry(element, { hidden: true }); assert.equal(element['error'].hidden, true);
    peer.installs[0]!.reject(new Error('controlled sender install rejection')); await client['mediaTask'];
    assertRetry(element, { hidden: true }); assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, 'controlled sender install rejection');
    assert.equal(peer.transceiver.sender.track, null); assert.equal(client['micFailed'], false);
    assert.equal(client.retryMicrophone(), false); assert.equal(media.requests.length, 2);
    assert.doesNotMatch(element['status'].textContent ?? '', /麥克風已恢復|音訊已恢復/);
  });

  it('honestly treats preview-shared micready as capture-ready even while room capture still awaits permission', async t => {
    const media = fakeCapture(t);
    const { element, client } = await socketJoinedWidget(t, roomState(true), true);
    await client['mediaTask']; media.hold();
    click(element['micRetry']); await until(() => media.requests.length === 2, 'room retry awaits permission');
    const previewPromise = client.startMicTest();
    assert.equal(media.requests.length, 3);
    media.requests[2]!.resolve(media.source()); const preview = await previewPromise;
    assertRetry(element, { hidden: true });
    assert.equal(client['mic'], null); assert.equal(media.Peer.instances[0]!.transceiver.sender.track, null);
    assert.equal(client.retryMicrophone(), false, 'preview readiness does not create another room admission');
    assert.equal(media.requests.length, 3);
    media.requests[1]!.reject(new DOMException('room capture still denied', 'NotAllowedError'));
    await client['mediaTask']; assertRetry(element); assert.equal(element['error'].hidden, false);
    preview.stop(); assert.equal(media.tracks[0]!.stops, 1);
  });

  it('does not offer capture retry for healthy room state, generic errors, audience, or an offstage controller', async t => {
    const { element, client } = await subscribedWidget(t, true);
    const retry = t.mock.method(client, 'retryMicrophone', () => true);
    assertRetry(element, { hidden: true }); forceRetry(element); assert.equal(retry.mock.callCount(), 0);
    await client['receive']({ type: 'error', code: 'forbidden', message: 'generic audio problem' });
    assertRetry(element, { hidden: true });
    microphoneReady(client); assertRetry(element, { hidden: true });
    for (const role of ['audience', 'controller'] as const) {
      const state = roomState(); state.me.role = role;
      await client['receive']({ type: 'room:state', ...state }); microphoneError(client);
      assertRetry(element, { hidden: true }); forceRetry(element); assert.equal(retry.mock.callCount(), 0);
    }
  });

  for (const outcome of ['false', 'throw'] as const) {
    it(`restores failed-capture admission after a synchronous ${outcome} result`, async t => {
      const { element, client } = await failedWidget(t);
      const retry = t.mock.method(client, 'retryMicrophone', () => {
        assertRetry(element, { disabled: true, busy: true });
        if (outcome === 'throw') throw new Error('controlled retry exception');
        return false;
      });
      click(element['micRetry']); await settle();
      assertRetry(element); assert.equal(retry.mock.callCount(), 1); assert.equal(element['error'].hidden, false);
      assert.equal(element['error'].textContent, outcome === 'throw' ? 'controlled retry exception' : 'controlled microphone failure');
      click(element['micRetry']); assert.equal(retry.mock.callCount(), 2); assertRetry(element);
    });
  }

  for (const outcome of ['true', 'false', 'throw'] as const) {
    for (const event of ['micerror', 'error'] as const) {
      it(`preserves a newer synchronous ${event} alert when admission returns ${outcome}`, async t => {
        const { element, client } = await failedWidget(t);
        t.mock.method(client, 'retryMicrophone', () => {
          if (event === 'micerror') microphoneError(client, 'new capture failure');
          else client.dispatchEvent(new CustomEvent('error', { detail: new Error('new generic failure') }));
          if (outcome === 'throw') throw new Error('older admission exception');
          return outcome === 'true';
        });
        click(element['micRetry']); await settle();
        assert.equal(element['error'].hidden, false);
        assert.equal(element['error'].textContent, event === 'micerror' ? 'new capture failure' : 'new generic failure');
        const pending = outcome === 'true' && event === 'error';
        assertRetry(element, { disabled: pending, busy: pending });
      });
    }
  }

  it('admits a retry from a forwarded micerror listener without the outer event undoing pending state', async t => {
    const { element, client } = await subscribedWidget(t, true);
    const retry = t.mock.method(client, 'retryMicrophone', () => true);
    const detail = { name: 'NotReadableError', message: 'reentrant capture failure' };
    let forwarded = 0;
    element.addEventListener('stage-micerror', event => {
      forwarded++; assert.equal((event as CustomEvent).detail, detail);
      assert.equal(event.bubbles, true); assert.equal(event.composed, true);
      assertRetry(element); click(element['micRetry']);
      assertRetry(element, { disabled: true, busy: true });
    }, { once: true });
    client.dispatchEvent(new CustomEvent('micerror', { detail })); await settle();
    assert.equal(forwarded, 1); assert.equal(retry.mock.callCount(), 1);
    assertRetry(element, { disabled: true, busy: true }); assert.equal(element['error'].hidden, true);
    microphoneReady(client); assertRetry(element, { hidden: true });
  });

  for (const outcome of ['true', 'false', 'throw'] as const) {
    for (const newerError of [false, true]) {
      it(`does not roll back synchronous micready after admission ${outcome}${newerError ? ' with a newer forwarded-listener error' : ''}`, async t => {
        const { element, client } = await failedWidget(t);
        const retry = t.mock.method(client, 'retryMicrophone', () => {
          microphoneReady(client);
          if (outcome === 'throw') throw new Error('obsolete admission exception');
          return outcome === 'true';
        });
        element.addEventListener('stage-micready', () => {
          assertRetry(element, { hidden: true }); forceRetry(element);
          if (newerError) client.dispatchEvent(new CustomEvent('error', { detail: new Error('new ready-listener error') }));
        }, { once: true });
        click(element['micRetry']); await settle();
        assertRetry(element, { hidden: true }); assert.equal(retry.mock.callCount(), 1);
        assert.equal(element['error'].hidden, !newerError);
        if (newerError) assert.equal(element['error'].textContent, 'new ready-listener error');
      });
    }
  }

  it('does not restore an old failure when false follows synchronous disconnect and a new participant capture failure', async t => {
    const { element, client } = await failedWidget(t);
    const retry = t.mock.method(client, 'retryMicrophone', () => {
      void client.disconnect();
      const replacement = roomState(true, 'replacement'); replacement.me.participantId = 'new-participant';
      void client['receive']({ type: 'room:state', ...replacement });
      microphoneError(client, 'new participant capture failure');
      return false;
    });
    click(element['micRetry']); await settle();
    assertRetry(element); assert.equal(retry.mock.callCount(), 1);
    assert.equal(client.me!.participantId, 'new-participant'); assert.equal(client.state!.roomId, 'replacement');
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'new participant capture failure');
    microphoneReady(client); assertRetry(element, { hidden: true }); assert.equal(element['error'].hidden, true);
  });

  it('does not restore old admission after false starts a widget rejoin and the replacement later fails capture', async t => {
    const { element, client } = await failedWidget(t);
    const retry = t.mock.method(client, 'retryMicrophone', () => {
      element.setAttribute('name', 'replacement'); return false;
    });
    click(element['micRetry']); assertRetry(element, { hidden: true });
    await settle();
    const replacement = element.client; assert.ok(replacement); assert.notEqual(replacement, client);
    await replacement['receive']({ type: 'room:state', ...roomState(true, 'replacement') });
    microphoneError(replacement, 'replacement capture failure'); assertRetry(element);
    microphoneReady(client); microphoneError(client, 'retired capture failure');
    assertRetry(element); assert.equal(retry.mock.callCount(), 1);
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'replacement capture failure');
  });

  it('keeps a newer failure raised inside a forwarded micready listener eligible', async t => {
    const { element, client } = await failedWidget(t);
    t.mock.method(client, 'retryMicrophone', () => true);
    click(element['micRetry']);
    element.addEventListener('stage-micready', () => { microphoneError(client, 'ended during ready callback'); }, { once: true });
    microphoneReady(client);
    assertRetry(element); assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, 'ended during ready callback');
  });

  it('preserves an unrelated newer error when pending capture becomes ready', async t => {
    const { element, client } = await failedWidget(t);
    t.mock.method(client, 'retryMicrophone', () => true);
    click(element['micRetry']);
    await client['receive']({ type: 'error', code: 'forbidden', message: 'new control error' });
    microphoneReady(client);
    assertRetry(element, { hidden: true }); assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, 'new control error');
  });

  it('does not clear an unrelated alert already present before the explicit retry', async t => {
    const { element, client } = await failedWidget(t);
    t.mock.method(client, 'retryMicrophone', () => true);
    await client['receive']({ type: 'error', code: 'forbidden', message: 'existing control error' });
    click(element['micRetry']); assertRetry(element, { disabled: true, busy: true });
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'existing control error');
    microphoneReady(client); assertRetry(element, { hidden: true });
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'existing control error');
  });

  for (const newerError of [false, true]) {
    it(`retires a capture notice on direct SDK micready ${newerError ? 'without hiding a newer alert' : 'without requiring a widget click'}`, async t => {
      const { element, client } = await failedWidget(t);
      const retry = t.mock.method(client, 'retryMicrophone', () => true);
      if (newerError) await client['receive']({ type: 'error', code: 'forbidden', message: 'newer room error' });
      microphoneReady(client); assertRetry(element, { hidden: true });
      assert.equal(element['error'].hidden, !newerError);
      if (newerError) assert.equal(element['error'].textContent, 'newer room error');
      assert.equal(retry.mock.callCount(), 0);
    });
  }

  for (const transition of ['reconnecting', 'offstage', 'disconnect', 'replacement', 'unmount'] as const) {
    it(`does not restore stale admission after synchronous ${transition} inside retryMicrophone`, async t => {
      const { element, client } = await failedWidget(t);
      const retry = t.mock.method(client, 'retryMicrophone', () => {
        if (transition === 'reconnecting') void client['receive']({ type: 'status', state: 'reconnecting' });
        else if (transition === 'offstage') void client['receive']({ type: 'room:state', ...roomState() });
        else if (transition === 'disconnect') void client.disconnect();
        else if (transition === 'replacement') element.setAttribute('name', 'replacement');
        else { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
        return true;
      });
      click(element['micRetry']); await settle();
      assert.equal(retry.mock.callCount(), 1);
      if (transition === 'reconnecting') {
        assertRetry(element, { disabled: true, busy: true });
        await client['receive']({ type: 'status', state: 'live' });
        assertRetry(element, { disabled: true, busy: true });
        microphoneError(client, 'retry ended after reconnect'); assertRetry(element);
      } else assertRetry(element, { hidden: true });
    });
  }

  for (const pending of [false, true]) {
    it(`retains ${pending ? 'pending capture' : 'failed capture'} across an ordinary socket reconnect and disables backoff/hello/resume`, async t => {
      const media = fakeCapture(t);
      const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, roomState(true), true);
      await client['mediaTask']; media.hold();
      const retry = t.mock.method(client, 'retryMicrophone');
      if (pending) { click(element['micRetry']); await until(() => media.requests.length === 2, 'pending retry starts'); }
      const captures = media.requests.length;
      socket.close(); assert.equal(client.status, 'reconnecting');
      assertRetry(element, { disabled: true, busy: pending }); forceRetry(element);
      assert.equal(retry.mock.callCount(), pending ? 1 : 0);
      await tick(500); assertRetry(element, { disabled: true, busy: pending });
      const replacement = sockets[1]!; const resume = await hello(replacement);
      assertRetry(element, { disabled: true, busy: pending }); forceRetry(element);
      assert.equal(retry.mock.callCount(), pending ? 1 : 0); assert.equal(media.requests.length, captures);
      replacement.deliver({ type: 'room:state', ...roomState(true) }); await settle();
      assertRetry(element, { disabled: pending, busy: pending });
      replacement.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
      assertRetry(element, { disabled: pending, busy: pending });
      assert.equal(media.requests.length, captures); assert.equal(media.Peer.instances.length, 1);
      if (pending) {
        media.requests[1]!.resolve(media.source()); await client['mediaTask'];
        assertRetry(element, { hidden: true });
      } else {
        click(element['micRetry']); await until(() => media.requests.length === 2, 'explicit retry after resume');
        media.requests[1]!.resolve(media.source()); await client['mediaTask']; assertRetry(element, { hidden: true });
      }
    });
  }

  for (const transition of ['waiting', 'reconnecting', 'offstage', 'identity', 'room', 'disconnect', 'detached'] as const) {
    it(`rechecks ${transition} before a forwarded callback can invoke an old eligible button`, async t => {
      const { element, client } = await failedWidget(t);
      const retry = t.mock.method(client, 'retryMicrophone', () => true);
      const statusTransition = transition === 'waiting' || transition === 'reconnecting' || transition === 'disconnect';
      let callbacks = 0;
      element.addEventListener(statusTransition ? 'stage-status' : 'stage-state', () => {
        callbacks++;
        if (transition === 'detached') Object.assign(element, { isConnected: false });
        forceRetry(element);
      }, { once: true });
      if (transition === 'disconnect') await client.disconnect();
      else if (statusTransition) await client['receive']({ type: 'status', state: transition as 'waiting' | 'reconnecting' });
      else {
        const state = roomState(transition !== 'offstage', transition === 'room' ? 'two' : 'one');
        if (transition === 'identity') state.me.participantId = 'replacement';
        await client['receive']({ type: 'room:state', ...state });
      }
      await settle(); assert.equal(callbacks, 1); assert.equal(retry.mock.callCount(), 0);
      if (transition === 'waiting' || transition === 'reconnecting') {
        assertRetry(element, { disabled: true });
        await client['receive']({ type: 'status', state: 'live' }); assertRetry(element);
      } else assertRetry(element, transition === 'detached' ? { disabled: true } : { hidden: true });
    });
  }

  it('preserves failure across onstage role changes and retires it on leaving the stage', async t => {
    const { element, client } = await failedWidget(t);
    const retry = t.mock.method(client, 'retryMicrophone', () => true);
    const controller = roomState(true); controller.me.role = 'controller';
    await client['receive']({ type: 'room:state', ...controller }); assertRetry(element);
    await client['receive']({ type: 'role:update', participantId: 'me', role: 'speaker', reason: 'transferred' });
    assertRetry(element);
    await client['receive']({ type: 'room:state', ...roomState() }); assertRetry(element, { hidden: true });
    await client['receive']({ type: 'room:state', ...roomState(true) }); assertRetry(element, { hidden: true });
    forceRetry(element); assert.equal(retry.mock.callCount(), 0);
    microphoneError(client, 'new stage capture failure'); assertRetry(element);
  });

  for (const terminal of [null, ...terminalCases]) {
    it(`retires pending capture retry after ${terminal?.title ?? 'exposed-client disconnect'}`, async t => {
      const { element, client } = await failedWidget(t);
      const retry = t.mock.method(client, 'retryMicrophone', () => true);
      click(element['micRetry']); assertRetry(element, { disabled: true, busy: true });
      if (terminal) await client['receive'](terminal.message); else await client.disconnect();
      assertRetry(element, { hidden: true }); forceRetry(element); assert.equal(retry.mock.callCount(), 1);
      microphoneReady(client); microphoneError(client, 'late retired failure');
      assertRetry(element, { hidden: true });
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
    });
  }

  for (const transition of ['room', 'name', 'code', 'url', 'unmount'] as const) {
    it(`isolates old mic events after ${transition} replacement from a new pending capture and alert`, async t => {
      const { element, client } = await failedWidget(t);
      t.mock.method(client, 'retryMicrophone', () => true);
      click(element['micRetry']);
      if (transition === 'unmount') {
        Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
        assertRetry(element, { hidden: true });
        Object.assign(element, { isConnected: true }); element.connectedCallback();
      } else element.setAttribute(transition, transition === 'url' ? 'wss://replacement.invalid/ws' : 'replacement');
      await settle();
      const replacement = element.client; assert.ok(replacement); assert.notEqual(replacement, client);
      await replacement['receive']({ type: 'room:state', ...roomState(true, 'replacement') });
      assertRetry(element, { hidden: true }); microphoneError(replacement, 'replacement capture failure');
      const retry = t.mock.method(replacement, 'retryMicrophone', () => true);
      click(element['micRetry']);
      await replacement['receive']({ type: 'error', code: 'forbidden', message: 'replacement control error' });
      microphoneReady(client); microphoneError(client, 'retired capture error'); await settle();
      assert.equal(element.client, replacement); assertRetry(element, { disabled: true, busy: true });
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'replacement control error');
      assert.equal(retry.mock.callCount(), 1);
      microphoneReady(replacement); assertRetry(element, { hidden: true });
      assert.equal(element['error'].textContent, 'replacement control error');
    });
  }

  for (const transition of ['offstage', 'disconnect', 'unmount'] as const) {
    it(`cancels real deferred capture on ${transition} and disposes late permission success`, async t => {
      const media = fakeCapture(t);
      const { element, client, socket } = await socketJoinedWidget(t, roomState(true), true);
      await client['mediaTask']; media.hold();
      click(element['micRetry']); await until(() => media.requests.length === 2, 'retry permission is pending');
      if (transition === 'offstage') socket.deliver({ type: 'room:state', ...roomState() });
      else if (transition === 'disconnect') await client.disconnect();
      else { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      await settle(); assertRetry(element, { hidden: true });
      const late = media.source(); media.requests[1]!.resolve(late); await settle(); await client['mediaTask'];
      assert.equal(media.tracks.at(-1)!.stops, 1); assert.equal(client['mic'], null);
      assertRetry(element, { hidden: true }); assert.equal(media.requests.length, 2);
    });
  }
});

describe('widget explicit room leave and manual rejoin', () => {
  type Widget = InstanceType<typeof StageElement>;
  function assertPresence(element: Widget, { left = false, hidden = false, disabled = hidden, busy = false }: {
    left?: boolean; hidden?: boolean; disabled?: boolean; busy?: boolean;
  } = {}): void {
    const button = element['roomAction'];
    assert.equal(button.tagName, 'BUTTON'); assert.equal(button.type, 'button');
    assert.equal(button.textContent, left ? '重新加入' : '離開房間');
    assert.equal(button.hidden, hidden, 'room action visibility');
    assert.equal(button.disabled, disabled, 'room action admission');
    assert.equal(button.getAttribute('aria-busy'), String(busy), 'room cleanup ownership');
  }
  function assertLeft(element: Widget): void {
    assert.equal(element.client, null); assert.equal(element['status'].textContent, '已離開房間。');
    assert.equal(element['status'].getAttribute('role'), 'status');
    assert.equal(element['status'].getAttribute('aria-live'), 'polite');
    assertRoomControlsHidden(element); assertCancelJoin(element, false); assertRetry(element, false);
    assert.equal(element['playback'].hidden, true); assert.equal(element['volume'].disabled, true);
    assert.equal(element['unlock'].hidden, true); assert.equal(element['micRetry'].hidden, true);
    assert.equal(element['pendingActions'].size, 0); assert.equal(element['cooldownTimer'], undefined);
  }

  it('keeps room presence inert before a snapshot and retains initial cancellation semantics', async t => {
    const unmounted = new StageElement(); widgets.push(unmounted);
    assertPresence(unmounted, { hidden: true }); click(unmounted['roomAction']);
    assert.equal(unmounted.client, null); assert.equal(unmounted['leftRoom'], false);
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const client = element.client!;
    assertPresence(element, { hidden: true }); assertCancelJoin(element, true);
    click(element['roomAction']); await settle(); assert.equal(element.client, client);
    await hello(sockets[0]!);
    assertPresence(element, { hidden: true }); assertCancelJoin(element, true);
    click(element['roomAction']); assert.equal(element['leftRoom'], false);
    click(element['cancelJoin']); await settle(); await settle();
    assertPresence(element, { hidden: true }); assertRetry(element, true);
    assert.equal(element['status'].textContent, '已取消加入。');
  });

  for (const role of ['audience', 'speaker', 'offstage controller', 'onstage controller'] as const) {
    it(`leaves a joined ${role} once, revokes event forwarding and never autojoins`, async t => {
      const state = roomState(role === 'speaker' || role === 'onstage controller');
      if (role.includes('controller')) state.me.role = 'controller';
      const { element, client, socket, sockets, tick } = await socketJoinedWidget(t, state);
      const disconnect = t.mock.method(client, 'disconnect');
      const close = t.mock.method(socket, 'close');
      const forwarded: string[] = [];
      for (const type of ['status', 'state', 'error', 'closed', 'kicked']) element.addEventListener(`stage-${type}`, () => forwarded.push(type));
      const generation = element['generation']; assertPresence(element);
      click(element['roomAction']); assertLeft(element);
      assertPresence(element, { left: true, disabled: true, busy: true });
      click(element['roomAction']); click(element['roomAction']); await settle(); await settle();
      assert.equal(element['generation'], generation + 1); assert.equal(disconnect.mock.callCount(), 1); assert.equal(close.mock.callCount(), 1);
      assert.equal(client.status, 'disconnected'); assert.equal(client.state, null); assert.equal(client['session'], null);
      assert.equal(client['socket'], null); assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
      assert.equal(client['keepaliveTimer'], undefined); assert.equal(client['reconnectTimer'], undefined);
      assert.equal(client['audio'].isConnected, false); assert.equal(getEventListeners(window, 'pagehide').length, 0);
      assertPresence(element, { left: true }); assert.equal(element['error'].hidden, true);
      assert.deepEqual(socket.sent.map(message => message.type), ['join'], 'room leave uses disconnect, never stage:leave or room:close');
      await tick(30000); assert.equal(sockets.length, 1); assertLeft(element); assert.deepEqual(forwarded, []);
    });
  }

  for (const phase of ['backoff', 'opening', 'hello', 'resume ACK'] as const) {
    it(`allows leave during reconnect ${phase} and retires deadlines and retained callbacks`, async t => {
      const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t);
      socket.close(); await settle(); assert.equal(client.status, 'reconnecting');
      if (phase !== 'backoff') await tick(500);
      if (phase === 'hello') sockets[1]!.readyState = 1;
      if (phase === 'resume ACK') await hello(sockets[1]!);
      const latest = sockets.at(-1)!, message = latest.onmessage, close = latest.onclose;
      const socketCount = sockets.length; const frames = sockets.map(current => [...current.sent]);
      assertPresence(element); click(element['roomAction']); await settle(); await settle();
      assertLeft(element); assertPresence(element, { left: true });
      assert.equal(client['socket'], null); assert.equal(client['connecting'], null); assert.equal(client['helloWait'], null);
      assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
      assert.equal(client['keepaliveTimer'], undefined); assert.equal(client['reconnectTimer'], undefined);
      message?.({ data: JSON.stringify({ type: 'room:state', ...roomState(), name: 'Retired reconnect' }) });
      close?.(); await tick(30000);
      assert.equal(sockets.length, socketCount); assert.deepEqual(sockets.map(current => current.sent), frames);
      assertLeft(element); assert.equal(element['error'].hidden, true);
    });
  }

  for (const event of ['stage-status', 'stage-state'] as const) {
    it(`admits leave inside ${event} before initial join ACK with action-time admission`, async t => {
      const { element, sockets, hello } = socketJoiningWidget(t); await settle();
      const client = element.client!, socket = sockets[0]!, request = await hello(socket);
      let callbacks = 0;
      element.addEventListener(event, () => {
        callbacks++; assert.equal(client['pending'].has(request.requestId), true);
        assertPresence(element, { hidden: event === 'stage-status' }); click(element['roomAction']);
      }, { once: true });
      socket.deliver({ type: 'room:state', ...roomState() }); await settle(); await settle();
      assert.equal(callbacks, 1); assertLeft(element); assertPresence(element, { left: true });
      socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      assert.equal(client['session'], null); assertLeft(element); assert.equal(element['error'].hidden, true);
    });
  }

  for (const outcome of ['resolve', 'reject'] as const) {
    for (const rejoin of [false, true]) {
      it(`ignores state-before-ACK late ${outcome} after leave${rejoin ? ' and manual rejoin' : ''}`, async t => {
        const { element, connections, joins } = deferredJoiningWidget(t); await settle();
        connections[0]!.pending.resolve(); await settle();
        const old = joins[0]!, client = element.client!;
        await client['receive']({ type: 'room:state', ...roomState() });
        assertPresence(element); assertCancelJoin(element, false);
        click(element['roomAction']); await settle(); await settle(); assertLeft(element);
        if (rejoin) { click(element['roomAction']); click(element['roomAction']); await settle(); assert.equal(connections.length, 2); }
        const current = element.client;
        if (outcome === 'resolve') old.pending.resolve(); else old.pending.reject(new Error('retired initial ACK failed'));
        await settle(); await settle();
        assert.equal(element.client, current); assert.equal(element['error'].hidden, true);
        assert.equal(element['pendingActions'].size, 0); assertRetry(element, false);
        if (rejoin) { assert.equal(element['status'].textContent, '連線中…'); assertCancelJoin(element, true); }
        else { assertLeft(element); assertPresence(element, { left: true }); }
      });
    }
  }

  for (const terminal of [null, ...terminalCases]) {
    it(`never turns ${terminal?.title ?? 'exposed-client disconnect'} into voluntary leave during forwarded callbacks`, async t => {
      const { element, client, sockets, tick } = await socketJoinedWidget(t);
      const generation = element['generation']; let callbacks = 0;
      element.addEventListener('stage-status', event => {
        if ((event as CustomEvent).detail !== 'disconnected') return;
        callbacks++; click(element['roomAction']);
      });
      if (terminal) {
        element.addEventListener(`stage-${terminal.event}`, () => { callbacks++; click(element['roomAction']); });
        await client['receive'](terminal.message);
      } else await client.disconnect();
      await settle(); assert.equal(callbacks, terminal ? 2 : 1);
      assert.equal(element.client, client); assert.equal(element['generation'], generation); assert.equal(element['leftRoom'], false);
      assertPresence(element, { hidden: true }); assertCancelJoin(element, false); assertRetry(element, false);
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
      click(element['roomAction']); element.playbackMuted = true; await tick(30000);
      assert.equal(sockets.length, 1); assertPresence(element, { hidden: true });
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
    });
  }

  it('retains voluntary-left across identity edits and remount, then joins once with current trimmed attrs and preferences', async t => {
    const { element, client, socket, sockets, hello, tick } = await socketJoinedWidget(t);
    const message = socket.onmessage, close = socket.onclose;
    click(element['roomAction']); await settle(); await settle(); assertLeft(element);
    element.setAttribute('url', 'wss://replacement.example.test/new-ws');
    element.setAttribute('room', ' two '); element.setAttribute('name', ' Replacement '); element.setAttribute('code', ' NEW ');
    element.playbackMuted = true; element.playbackVolume = 0.375;
    await tick(30000); assert.equal(sockets.length, 1); assertLeft(element);
    Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
    assertPresence(element, { left: true, disabled: true }); click(element['roomAction']); assert.equal(sockets.length, 1);
    Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
    assertLeft(element); assertPresence(element, { left: true }); assert.equal(sockets.length, 1);
    click(element['roomAction']); click(element['roomAction']); await settle(); await settle();
    const current = element.client!; assert.notEqual(current, client); assert.equal(sockets.length, 2);
    assert.equal(current['options'].url, 'wss://replacement.example.test/new-ws');
    assert.equal(current.playbackMuted, true); assert.equal(current.playbackVolume, 0.375);
    const forwarded: string[] = [];
    for (const type of ['status', 'state', 'error', 'closed', 'kicked', 'audioblocked', 'micerror', 'micready']) element.addEventListener(`stage-${type}`, () => forwarded.push(type));
    for (const value of [
      { type: 'room:state', ...roomState(true), name: 'Retired room' },
      { type: 'error', code: 'bad_request', message: 'retired leave error' },
      ...terminalCases.map(item => item.message),
    ] satisfies ServerMessage[]) {
      message?.({ data: JSON.stringify(value) }); await client['receive'](value);
    }
    for (const type of ['audioblocked', 'micerror', 'micready']) client.dispatchEvent(new CustomEvent(type, { detail: { message: 'retired media' } }));
    close?.(); await settle();
    assert.equal(element.client, current); assert.equal(element['status'].textContent, '連線中…');
    assert.equal(element['error'].hidden, true); assert.equal(element['unlock'].hidden, true); assert.deepEqual(forwarded, []);
    assertPresence(element, { hidden: true }); assertCancelJoin(element, true);
    const request = await hello(sockets[1]!);
    assert.equal(request.roomId, 'two'); assert.equal(request.name, 'Replacement'); assert.equal(request.code, 'NEW');
    assert.equal(request.resumeToken, undefined, 'manual rejoin requests a new seat rather than resuming the old identity');
    sockets[1]!.deliver({ type: 'room:state', ...roomState(false, 'two') });
    sockets[1]!.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assertPresence(element); assert.equal(element['volume'].value, '38');
    assert.equal(element['listen'].getAttribute('aria-pressed'), 'true');
  });

  it('requires current nonempty room and name for manual rejoin and remains inert while detached', async t => {
    const { element, sockets } = await socketJoinedWidget(t);
    click(element['roomAction']); await settle(); await settle();
    for (const attribute of ['room', 'name']) {
      const value = element.getAttribute(attribute)!;
      element.setAttribute(attribute, '  '); assertPresence(element, { left: true, disabled: true });
      click(element['roomAction']); await settle(); assert.equal(sockets.length, 1); assertLeft(element);
      element.removeAttribute(attribute); click(element['roomAction']); await settle(); assert.equal(sockets.length, 1);
      element.setAttribute(attribute, value); assertPresence(element, { left: true });
    }
    Object.assign(element, { isConnected: false }); click(element['roomAction']); await settle();
    assert.equal(sockets.length, 1); assertLeft(element);
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`keeps deferred leave cleanup ${outcome} owned across identity edits and remount`, async t => {
      const { element, client, sockets } = await socketJoinedWidget(t);
      const pending = deferred(), disconnect = client.disconnect.bind(client);
      const call = t.mock.method(client, 'disconnect', () => { void disconnect(); return pending.promise; });
      click(element['roomAction']); assertLeft(element);
      assertPresence(element, { left: true, disabled: true, busy: true });
      element.setAttribute('room', 'two'); element.setAttribute('name', 'Replacement');
      element.playbackMuted = true; element.playbackVolume = 0.2;
      click(element['roomAction']); await settle(); assert.equal(sockets.length, 1);
      Object.assign(element, { isConnected: false }); element.disconnectedCallback();
      Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
      assertPresence(element, { left: true, disabled: true, busy: true });
      click(element['roomAction']); await settle(); assert.equal(sockets.length, 1);
      if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('leave cleanup failed'));
      await settle(); await settle();
      assert.equal(call.mock.callCount(), 1); assertLeft(element); assertPresence(element, { left: true });
      assert.equal(element['error'].hidden, outcome === 'resolve');
      if (outcome === 'reject') assert.equal(element['error'].textContent, 'leave cleanup failed');
      click(element['roomAction']); await settle();
      assert.equal(sockets.length, 2); assert.equal(element.client!.playbackMuted, true); assert.equal(element.client!.playbackVolume, 0.2);
      assert.equal(element['error'].hidden, true);
    });
  }

  for (const outcome of ['throw', 'reject'] as const) {
    it(`shows a current leave cleanup ${outcome} while preserving the manual-rejoin action`, async t => {
      const { element, client, sockets } = await socketJoinedWidget(t);
      const disconnect = client.disconnect.bind(client);
      t.mock.method(client, 'disconnect', () => {
        void disconnect();
        if (outcome === 'throw') throw new Error('current leave failure');
        return Promise.reject(new Error('current leave failure'));
      });
      click(element['roomAction']); await settle(); await settle();
      assertLeft(element); assertPresence(element, { left: true });
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'current leave failure');
      assert.equal(client['socket'], null); assert.equal(client['pending'].size, 0);
      click(element['roomAction']); await settle(); assert.equal(sockets.length, 2); assert.equal(element['error'].hidden, true);
    });
  }

  it('blocks reentrant duplicate actions inside the retiring client disconnect event', async t => {
    const { element, client, sockets } = await socketJoinedWidget(t);
    const disconnect = t.mock.method(client, 'disconnect'); let callbacks = 0;
    client.on('status', ({ detail }) => {
      if (detail !== 'disconnected') return;
      callbacks++; assertLeft(element); assertPresence(element, { left: true, disabled: true, busy: true });
      click(element['roomAction']); click(element['roomAction']);
    });
    click(element['roomAction']); await settle(); await settle();
    assert.equal(callbacks, 1); assert.equal(disconnect.mock.callCount(), 1); assert.equal(sockets.length, 1);
    assertLeft(element); assertPresence(element, { left: true });
  });

  for (const action of ['hand', 'mic', 'leaveStage'] as const) {
    it(`retires pending ${action} control and prevents its rejection from clearing a new action`, async t => {
      const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, roomState(action !== 'hand'));
      click(element[action]); await tick(100);
      assert.equal(element[action].getAttribute('aria-busy'), 'true'); assert.equal(client['pending'].size, 1);
      const oldRequest = socket.sent.at(-1)!; assert.ok(oldRequest.type !== 'ping');
      click(element['roomAction']); await settle(); await settle();
      assertLeft(element); assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
      assert.equal(element[action].getAttribute('aria-busy'), null); assert.equal(element['error'].hidden, true);
      click(element['roomAction']); await settle(); const next = sockets[1]!, request = await hello(next);
      next.deliver({ type: 'room:state', ...roomState(action !== 'hand') });
      next.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      click(element[action]); await tick(100); const activeRequest = next.sent.at(-1)!; assert.ok(activeRequest.type !== 'ping');
      socket.deliver({ type: 'error', code: 'forbidden', requestId: oldRequest.requestId, message: 'retired action failure' });
      await settle();
      assert.equal(element[action].getAttribute('aria-busy'), 'true'); assert.equal(element['pendingActions'].has(element[action]), true);
      assert.equal(element['error'].hidden, true); assertPresence(element);
      next.deliver({ type: 'ok', requestId: activeRequest.requestId }); await settle();
      assert.equal(element[action].getAttribute('aria-busy'), null); assert.equal(element['pendingActions'].size, 0);
    });
  }

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`isolates a pending audio unlock ${outcome} from a new room unlock action`, async t => {
      const { element, client } = await subscribedWidget(t);
      const old = deferred(); t.mock.method(client, 'unlockAudio', () => old.promise);
      client.dispatchEvent(new CustomEvent('audioblocked', { detail: { message: 'blocked' } }));
      click(element['unlock']); assert.equal(element['unlock'].getAttribute('aria-busy'), 'true');
      click(element['roomAction']); await settle(); await settle(); assertLeft(element);
      click(element['roomAction']); await settle(); const current = element.client!;
      await current['receive']({ type: 'room:state', ...roomState() });
      const active = deferred(); t.mock.method(current, 'unlockAudio', () => active.promise);
      current.dispatchEvent(new CustomEvent('audioblocked', { detail: { message: 'new blocked' } })); click(element['unlock']);
      if (outcome === 'resolve') old.resolve(); else old.reject(new Error('retired unlock failure'));
      await settle();
      assert.equal(element['unlock'].hidden, false); assert.equal(element['unlock'].getAttribute('aria-busy'), 'true');
      assert.equal(element['pendingActions'].has(element['unlock']), true); assert.equal(element['error'].hidden, true);
      active.resolve(); await settle(); assert.equal(element['unlock'].hidden, true); assert.equal(element['pendingActions'].size, 0);
    });
  }
});

describe('widget room leave media teardown', () => {
  type Track = EventTarget & { enabled: boolean; readyState: string; stops: number; stop(): void };
  function fakeRoomMedia(t: TestContext, holdCapture = false, holdInstall = false) {
    const originals = new Map(['navigator', 'RTCPeerConnection', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const tracks: Track[] = [];
    const captures: { promise: Promise<MediaStream>; resolve: (stream: MediaStream) => void }[] = [];
    function source(): MediaStream {
      const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
        stop() { this.stops++; this.readyState = 'ended'; },
      });
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    }
    class Peer {
      static instances: Peer[] = [];
      connectionState = 'connected'; signalingState = 'stable'; localDescription = null; closed = false;
      ontrack?: (event: { streams: MediaStream[]; track: MediaStreamTrack }) => void;
      onconnectionstatechange?: () => void;
      readonly installs: ReturnType<typeof deferred>[] = [];
      readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown,
        replaceTrack: async (track: unknown) => {
          if (holdInstall && track) { const pending = deferred(); this.installs.push(pending); await pending.promise; }
          this.transceiver.sender.track = track;
        },
      } };
      constructor() { Peer.instances.push(this); }
      addTransceiver() { return this.transceiver; }
      close(): void { this.closed = true; }
    }
    class Context {
      static instances: Context[] = [];
      closed = false;
      constructor() { Context.instances.push(this); }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
      async resume() {} async close() { this.closed = true; }
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => {
      let resolve!: (stream: MediaStream) => void;
      const promise = new Promise<MediaStream>(yes => { resolve = yes; }); captures.push({ promise, resolve });
      if (!holdCapture) resolve(source());
      return promise;
    } } } });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
    // Real SDK capture/abort, sender and playback ownership; fake DOM, sockets and hardware do not prove browser audio or SDP.
    t.mock.method(StageClient.prototype as unknown as { negotiate(): void }, 'negotiate', () => {});
    t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
    return { tracks, captures, Peer, Context, source,
      releaseFuture() { holdCapture = false; holdInstall = false; },
    };
  }
  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) { if (predicate()) return; await settle(); }
    assert.fail(label);
  }

  it('stops installed capture, meter and playback synchronously, closes its peer and clears pending control work', async t => {
    const media = fakeRoomMedia(t);
    const { element, client, socket, sockets, tick } = await socketJoinedWidget(t, roomState(true), true);
    await client['mediaTask'];
    const track = media.tracks[0]!, peer = media.Peer.instances[0]!, audio = client['audio'];
    assert.equal(peer.transceiver.sender.track, track); assert.equal(track.stops, 0); assert.equal(media.Context.instances.length, 1);
    const stream = {} as MediaStream;
    peer.ontrack?.({ streams: [stream], track: {} as MediaStreamTrack }); await settle(); assert.equal(audio.srcObject, stream);
    const pause = t.mock.method(audio, 'pause'), remove = t.mock.method(audio, 'remove');
    const lateTrack = peer.ontrack, lateState = peer.onconnectionstatechange;
    click(element['mic']); await tick(100); assert.equal(client['pending'].size, 1);
    client.dispatchEvent(new CustomEvent('audioblocked', { detail: { message: 'blocked audio' } }));
    assert.equal(element['unlock'].hidden, false);
    click(element['roomAction']);
    assert.equal(track.stops, 1); assert.equal(track.enabled, false); assert.equal(peer.closed, true);
    assert.equal(media.Context.instances[0]!.closed, true); assert.equal(audio.srcObject, null); assert.equal(audio.isConnected, false);
    assert.equal(pause.mock.callCount(), 1); assert.equal(remove.mock.callCount(), 1);
    assert.equal(client['mic'], null); assert.equal(client['micMeter'], null); assert.equal(client['pc'], null);
    assert.equal(client['transceiver'], null); assert.equal(client['pending'].size, 0); assert.equal(client['pendingControlRequests'], 0);
    assert.equal(getEventListeners(track, 'ended').length, 0); assert.equal(getEventListeners(window, 'pagehide').length, 0);
    await settle(); await settle();
    lateTrack?.({ streams: [stream], track: {} as MediaStreamTrack }); peer.connectionState = 'failed'; lateState?.();
    track.dispatchEvent(new Event('ended')); await tick(30000);
    assert.equal(audio.srcObject, null); assert.equal(media.captures.length, 1); assert.equal(media.Peer.instances.length, 1);
    assert.equal(track.stops, 1); assert.equal(sockets.length, 1); assert.equal(element.client, null);
    assert.equal(element['status'].textContent, '已離開房間。'); assert.equal(element['error'].hidden, true);
    assert.equal(element['unlock'].hidden, true); assert.equal(element['micRetry'].hidden, true);
    assert.equal(element['roomAction'].textContent, '重新加入'); assert.equal(element['roomAction'].disabled, false);
    assert.equal(socket.sent.some(message => message.type === 'stage:leave' || message.type === 'room:close'), false);
  });

  for (const pending of ['capture permission', 'sender install'] as const) {
    it(`retires pending ${pending} and disposes its late result without touching the manual rejoin microphone`, async t => {
      const media = fakeRoomMedia(t, pending === 'capture permission', pending === 'sender install');
      const { element, client, sockets, hello } = await socketJoinedWidget(t, roomState(true), true);
      await until(() => pending === 'capture permission' ? media.captures.length === 1 : media.Peer.instances[0]!.installs.length === 1, 'old media work is pending');
      const oldPeer = media.Peer.instances[0]!, oldTask = client['mediaTask'];
      click(element['roomAction']); await settle(); await settle();
      assert.equal(oldPeer.closed, true); assert.equal(client['mic'], null); assert.equal(element.client, null);
      assert.equal(element['micRetry'].hidden, true); assert.equal(element['error'].hidden, true);
      media.releaseFuture(); click(element['roomAction']); await settle();
      const replacement = element.client!, socket = sockets[1]!, request = await hello(socket);
      const state = roomState(true); state.me.participantId = 'new-speaker';
      socket.deliver({ type: 'room:state', ...state }); socket.deliver({ type: 'ok', requestId: request.requestId });
      await settle(); await replacement['mediaTask'];
      const currentPeer = media.Peer.instances[1]!, currentTrack = media.tracks.at(-1)!;
      assert.equal(currentPeer.transceiver.sender.track, currentTrack); assert.equal(currentTrack.stops, 0);
      const forwarded: string[] = [];
      for (const type of ['micready', 'micerror', 'error', 'audioblocked']) element.addEventListener(`stage-${type}`, () => forwarded.push(type));
      let retiredTrack: Track;
      if (pending === 'capture permission') {
        const late = media.source(); retiredTrack = media.tracks.at(-1)!; media.captures[0]!.resolve(late);
      } else { retiredTrack = media.tracks[0]!; oldPeer.installs[0]!.resolve(); }
      await settle(); await oldTask; await settle();
      assert.equal(retiredTrack.stops, 1); assert.equal(client['mic'], null); assert.equal(client['pc'], null);
      assert.equal(replacement['mic']!.getAudioTracks()[0], currentTrack); assert.equal(currentTrack.stops, 0); assert.equal(currentTrack.enabled, true);
      assert.equal(currentPeer.closed, false); assert.equal(media.captures.length, 2); assert.equal(sockets.length, 2);
      assert.equal(element.client, replacement); assert.equal(element['roomAction'].textContent, '離開房間');
      assert.equal(element['micRetry'].hidden, true); assert.equal(element['error'].hidden, true); assert.deepEqual(forwarded, []);
    });
  }
});

/**
 * Name-editor tests use the real StageClient request/state lane with fake sockets and DOM.
 * Hub cases also use the real server parser and room model; capture/media remain stubbed.
 * Calling onclick / assigning value checks handler admission, not browser keyboard or IME behavior.
 */
describe('widget inline participant name editor', () => {
  type Widget = InstanceType<typeof StageElement>;
  function nodes(node: Node): Node[] { return [node, ...node.children.flatMap(nodes)]; }
  function draft(element: Widget, value: string): void { element['nameInput'].value = value; }
  function assertEditor(element: Widget, { accepted = 'Listener', value = accepted, hidden = false,
    disabled = hidden, busy = false }: { accepted?: string; value?: string; hidden?: boolean; disabled?: boolean; busy?: boolean } = {}): void {
    assert.equal(element['namePanel'].hidden, hidden, 'name editor visibility');
    assert.equal(element['acceptedName'].textContent, hidden ? '' : `目前名稱：${accepted}`, 'only the accepted state names the participant');
    assert.equal(element['nameInput'].value, value, 'editable draft ownership');
    assert.equal(element['nameUpdate'].disabled, disabled, 'current name-update admission');
    assert.equal(element['nameUpdate'].getAttribute('aria-busy'), hidden ? null : String(busy), 'name request remains busy until its own settlement');
    assert.equal(Boolean(element['nameAttempt']), busy);
  }
  function assertRetired(element: Widget): void {
    assertEditor(element, { accepted: '', value: '', hidden: true });
    assert.equal(element['nameOwner'], undefined);
    assert.equal(element['nameInput'].disabled, true);
  }
  function renameRequest(socket: ReturnType<typeof socketJoiningWidget>['sockets'][number], index = -1) {
    const request = socket.sent.filter(message => message.type === 'participant:rename').at(index);
    assert.ok(request && request.type === 'participant:rename', 'the public SDK sent participant:rename');
    return request;
  }

  it('keeps native labeled text controls hidden and inert before state, including an ACK-only initial join', async t => {
    const empty = new StageElement(); widgets.push(empty);
    assertRetired(empty); click(empty['nameUpdate']); assert.equal(empty.client, null);
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const client = element.client!, setName = t.mock.method(client, 'setName');
    assertRetired(element); click(element['nameUpdate']);
    const request = await hello(sockets[0]!);
    assertRetired(element); click(element['nameUpdate']);
    sockets[0]!.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assertRetired(element); click(element['nameUpdate']);
    assert.equal(setName.mock.callCount(), 0); assert.equal(client['pending'].size, 0);
    assert.equal(element['error'].hidden, true);
    const input = element['nameInput'], button = element['nameUpdate'];
    assert.equal(input.tagName, 'INPUT'); assert.equal(input.type, 'text');
    assert.equal(input.hasAttribute('maxlength'), false, 'server name limits are not duplicated in markup');
    assert.equal(Reflect.get(input, 'maxLength'), undefined, 'the fake DOM records no property-based length cap either');
    assert.equal(input.hasAttribute('required'), false, 'empty drafts must reach the server');
    assert.ok(input.id);
    const label = nodes(element as unknown as Node).find(node => node.tagName === 'LABEL' && node.getAttribute('for') === input.id);
    assert.ok(label?.textContent, 'the text input has an associated visible label');
    assert.equal(button.tagName, 'BUTTON'); assert.equal(button.type, 'button'); assert.equal(button.textContent, '更新名稱');
  });

  for (const role of ['audience', 'speaker', 'offstage controller', 'onstage controller'] as const) {
    it(`offers safe decoded accepted text and a raw editor to a joined ${role}`, async t => {
      const state = roomState(role === 'speaker' || role === 'onstage controller');
      if (role.includes('controller')) state.me.role = 'controller';
      state.me.name = '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Q&quot; &#39;S&#39; &amp;lt;';
      const decoded = '<img src=x onerror=alert(1)> & "Q" \'S\' &lt;';
      const { element, client, socket, tick } = await socketJoinedWidget(t, state);
      assertEditor(element, { accepted: decoded });
      const accepted = element['acceptedName'] as unknown as Node;
      assert.match(accepted.textContent, /^目前名稱：/, 'the accepted value has a visible descriptive label');
      assert.deepEqual(accepted.children, [], 'escaped markup stays plain text, never child elements');
      assert.equal(Reflect.get(accepted, 'innerHTML'), undefined, 'rendering did not assign HTML');
      assert.equal(element['nameInput'].disabled, false);
      const raw = '  \u200be\u0301 & <tag> \n  ';
      draft(element, raw); click(element['nameUpdate']); await tick(100);
      assert.equal(renameRequest(socket).name, raw);
      assertEditor(element, { accepted: decoded, value: raw, disabled: true, busy: true });
      socket.deliver({ type: 'ok', requestId: renameRequest(socket).requestId }); await settle();
      assertEditor(element, { accepted: decoded, value: raw });
      assert.equal(client.me?.name, state.me.name, 'an ACK does not invent an accepted name');
      assert.equal(element.getAttribute('name'), 'Listener');
    });
  }

  it('shows the real server-normalized snapshot before ACK without replacing the draft or reflecting name', async t => {
    const h = harness(); t.after(async () => { await h.hub.shutdown(); });
    const host = await h.create(), person = await h.join(host.roomId, host.code, 'Listener');
    const initial = person.s.last('room:state'); assert.ok(initial);
    const { element, client, socket, sockets, tick } = await socketJoinedWidget(t, initial);
    const owner = element['nameOwner'], generation = element['generation'];
    const input = element['nameInput'], accepted = element['acceptedName'];
    const setName = t.mock.method(client, 'setName');
    const raw = '  \u200be\u0301 <&> "name"\n  ';
    draft(element, raw); click(element['nameUpdate']); click(element['nameUpdate']); await tick(100);
    assert.equal(setName.mock.callCount(), 1); assert.deepEqual(setName.mock.calls[0]!.arguments, [raw]);
    const request = renameRequest(socket);
    const start = person.s.inbox.length;
    await h.hub.handle(person.s, parseClientMessage(JSON.stringify(request), testConfig().limits));
    const replies = person.s.inbox.slice(start);
    const snapshot = replies.find(message => message.type === 'room:state');
    const ack = replies.find(message => message.type === 'ok' && message.requestId === request.requestId);
    assert.ok(snapshot && snapshot.type === 'room:state'); assert.ok(ack);
    assert.equal(snapshot.me.name, 'é &lt;&amp;&gt; &quot;name&quot;');
    socket.deliver(snapshot);
    assertEditor(element, { accepted: 'é <&> "name"', value: raw, disabled: true, busy: true });
    assert.equal(client['pending'].has(request.requestId), true);
    draft(element, '  next unsent draft  ');
    element.playbackMuted = true; element.playbackVolume = 0.37;
    socket.deliver(snapshot); socket.deliver({ type: 'status', state: 'waiting' });
    assertEditor(element, { accepted: 'é <&> "name"', value: '  next unsent draft  ', disabled: true, busy: true });
    assert.equal(input.disabled, false, 'pending rename does not prevent editing the next draft');
    click(element['nameUpdate']); await tick(100); assert.equal(setName.mock.callCount(), 1);
    socket.deliver(ack); await settle();
    assertEditor(element, { accepted: 'é <&> "name"', value: '  next unsent draft  ' });
    assert.equal(element['nameOwner'], owner); assert.equal(element['nameInput'], input); assert.equal(element['acceptedName'], accepted);
    assert.equal(element.client, client); assert.equal(element['generation'], generation); assert.equal(sockets.length, 1);
    assert.equal(element.getAttribute('name'), 'Listener'); assert.equal(element['error'].hidden, true);
  });

  for (const raw of ['', ' \n\t\u200b ', '🐱'.repeat(testConfig().limits.nameMaxLength + 1)]) {
    it(`sends an invalid ${raw === '' ? 'empty' : raw.includes('🐱') ? 'over-limit' : 'whitespace'} draft unchanged and preserves the actual parser bad_request`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t);
      draft(element, raw); click(element['nameUpdate']); await tick(100);
      const request = renameRequest(socket); assert.equal(request.name, raw);
      let failure: ValidationError | undefined;
      try { parseClientMessage(JSON.stringify(request), testConfig().limits); }
      catch (error) { assert.ok(error instanceof ValidationError); failure = error; }
      assert.ok(failure); assert.equal(failure.code, 'bad_request');
      const forwarded: unknown[] = [];
      element.addEventListener('stage-error', event => forwarded.push((event as CustomEvent).detail));
      socket.deliver({ type: 'error', code: failure.code, message: failure.message, requestId: request.requestId }); await settle();
      assertEditor(element, { value: raw });
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, failure.message);
      assert.equal(forwarded.length, 1); assert.equal(client['pending'].size, 0);
      assert.equal(element.getAttribute('name'), 'Listener');
    });
  }

  it('preserves an older server unknown_type error and the draft, then retries through the same SDK', async t => {
    const { element, client, socket, sockets, tick } = await socketJoinedWidget(t);
    const forwarded: unknown[] = [];
    element.addEventListener('stage-error', event => forwarded.push((event as CustomEvent).detail));
    draft(element, '  Unsupported draft  '); click(element['nameUpdate']); await tick(100);
    const first = renameRequest(socket);
    socket.deliver({ type: 'error', code: 'unknown_type', message: 'Unknown message type', requestId: first.requestId }); await settle();
    assertEditor(element, { value: '  Unsupported draft  ' });
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Unknown message type');
    assert.equal(forwarded.length, 1); assert.equal(client['pending'].size, 0);
    click(element['nameUpdate']); assert.equal(element['error'].hidden, true); await tick(100);
    const next = renameRequest(socket); assert.notEqual(next.requestId, first.requestId); assert.equal(next.name, first.name);
    socket.deliver({ type: 'ok', requestId: next.requestId }); await settle();
    assertEditor(element, { value: first.name }); assert.equal(element.client, client); assert.equal(sockets.length, 1);
  });

  for (const outcome of ['throw', 'reject'] as const) {
    it(`retains a current setName ${outcome} and never changes accepted text or raw input`, async t => {
      const { element, client } = await subscribedWidget(t);
      const failure = new Error(`current name ${outcome}`);
      t.mock.method(client, 'setName', () => { if (outcome === 'throw') throw failure; return Promise.reject(failure); });
      draft(element, '  unaccepted draft  '); click(element['nameUpdate']); await settle();
      assertEditor(element, { value: '  unaccepted draft  ' });
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, failure.message);
      assert.equal(element.getAttribute('name'), 'Listener');
    });
  }

  it('keeps an unsent draft and server-accepted resume name through automatic reconnect, then manually rejoins with original attrs', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t);
    draft(element, '  e\u0301 & <N>  '); click(element['nameUpdate']); await tick(100);
    const command = renameRequest(socket), accepted = roomState(); accepted.me.name = 'é &amp; &lt;N&gt;';
    socket.deliver({ type: 'room:state', ...accepted, resumeToken: 'resume-renamed' });
    socket.deliver({ type: 'ok', requestId: command.requestId }); await settle();
    draft(element, 'unsubmitted after rename');
    const owner = element['nameOwner'];
    socket.close(); await settle();
    assertEditor(element, { accepted: 'é & <N>', value: 'unsubmitted after rename', disabled: true });
    click(element['nameUpdate']); await tick(500);
    const next = sockets[1]!, resume = await hello(next);
    assert.equal(resume.name, 'é & <N>'); assert.equal(resume.resumeToken, 'resume-renamed');
    assertEditor(element, { accepted: 'é & <N>', value: 'unsubmitted after rename', disabled: true });
    next.deliver({ type: 'room:state', ...accepted, resumeToken: 'resume-renamed' });
    assertEditor(element, { accepted: 'é & <N>', value: 'unsubmitted after rename' });
    assert.equal(element['nameOwner'], owner); assert.equal(element.client, client);
    next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assert.equal(next.sent.some(message => message.type === 'participant:rename'), false);
    click(element['roomAction']); await settle(); await settle(); assertRetired(element);
    click(element['roomAction']); await settle(); const manual = await hello(sockets[2]!);
    assert.equal(manual.name, 'Listener'); assert.equal(manual.resumeToken, undefined);
    sockets[2]!.deliver({ type: 'room:state', ...roomState() });
    sockets[2]!.deliver({ type: 'ok', requestId: manual.requestId }); await settle(); assertEditor(element);
    assert.notEqual(element['nameOwner'], owner); assert.equal(element.getAttribute('name'), 'Listener');
  });

  it('uses the latest declarative name on manual rejoin after an inline rename and post-leave attribute edits', async t => {
    const { element, socket, sockets, tick, hello } = await socketJoinedWidget(t);
    draft(element, 'Inline'); click(element['nameUpdate']); await tick(100);
    const accepted = roomState(); accepted.me.name = 'Inline';
    socket.deliver({ type: 'room:state', ...accepted }); socket.deliver({ type: 'ok', requestId: renameRequest(socket).requestId }); await settle();
    click(element['roomAction']); await settle(); await settle();
    element.setAttribute('room', ' two '); element.setAttribute('name', '  Latest attribute  '); element.setAttribute('code', ' NEW ');
    assertRetired(element); assert.equal(sockets.length, 1);
    click(element['roomAction']); await settle(); const join = await hello(sockets[1]!);
    assert.equal(join.name, 'Latest attribute'); assert.equal(join.roomId, 'two'); assert.equal(join.code, 'NEW');
    assert.equal(join.resumeToken, undefined);
    const state = roomState(false, 'two'); state.me.name = 'Latest attribute';
    sockets[1]!.deliver({ type: 'room:state', ...state }); sockets[1]!.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    assertEditor(element, { accepted: 'Latest attribute' }); assert.equal(element.getAttribute('name'), '  Latest attribute  ');
  });

  for (const callback of ['stage-status', 'stage-state'] as const) {
    it(`initializes a fresh owner before forwarded ${callback} and admits an immediate update before join ACK`, async t => {
      const { element, sockets, hello, tick } = socketJoiningWidget(t); await settle();
      const socket = sockets[0]!, join = await hello(socket), client = element.client!;
      const state = roomState(); state.me.name = 'Fresh &amp; accepted';
      let calls = 0;
      element.addEventListener(callback, () => {
        calls++;
        assert.equal(element['nameInput'].value, 'Fresh & accepted');
        assert.equal(element['acceptedName'].textContent, '目前名稱：Fresh & accepted');
        draft(element, '  host callback draft  '); click(element['nameUpdate']); click(element['nameUpdate']);
        assert.equal(element['nameUpdate'].getAttribute('aria-busy'), 'true');
      }, { once: true });
      socket.deliver({ type: 'room:state', ...state }); await tick(100);
      assert.equal(calls, 1); assert.equal(socket.sent.filter(message => message.type === 'participant:rename').length, 1);
      const rename = renameRequest(socket); assert.equal(rename.name, '  host callback draft  ');
      assert.equal(client['pending'].has(join.requestId), true);
      assertEditor(element, { accepted: 'Fresh & accepted', value: rename.name, disabled: true, busy: true });
      socket.deliver({ type: 'ok', requestId: join.requestId }); await settle();
      assertEditor(element, { accepted: 'Fresh & accepted', value: rename.name, disabled: true, busy: true });
      socket.deliver({ type: 'ok', requestId: rename.requestId }); await settle();
      assertEditor(element, { accepted: 'Fresh & accepted', value: rename.name });
    });
  }

  it('blocks a direct onclick during socket-loss forwarding without clearing an existing alert or creating pending work', async t => {
    const { element, client, socket } = await socketJoinedWidget(t);
    const setName = t.mock.method(client, 'setName');
    draft(element, 'retained draft'); socket.deliver({ type: 'error', code: 'conflict', message: 'Existing name error' });
    const frames = [...socket.sent]; let calls = 0;
    element.addEventListener('stage-status', event => {
      calls++; assert.equal((event as CustomEvent).detail, 'reconnecting');
      click(element['nameUpdate']);
      assert.equal(element['nameAttempt'], undefined); assert.equal(element['error'].hidden, false);
      assert.equal(element['error'].textContent, 'Existing name error');
    }, { once: true });
    socket.close(); await settle();
    assert.equal(calls, 1); assert.equal(setName.mock.callCount(), 0); assert.deepEqual(socket.sent, frames);
    assertEditor(element, { value: 'retained draft', disabled: true }); assert.equal(client['pending'].size, 0);
  });

  it('preserves the pending owner across reconnect and resumes admission only after its deferred operation settles', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t);
    // Synthetic deferred method isolates widget ownership; ordinary socket loss rejects SDK controls synchronously.
    const pending = deferred(), setName = t.mock.method(client, 'setName', () => pending.promise);
    draft(element, 'pending draft'); click(element['nameUpdate']);
    const owner = element['nameOwner'], attempt = element['nameAttempt'];
    socket.close(); await settle();
    socket.deliver({ type: 'error', code: 'conflict', message: 'retired wire error' });
    client.dispatchEvent(new CustomEvent('error', { detail: new Error('Current reconnect error') }));
    click(element['nameUpdate']);
    assert.equal(element['nameAttempt'], attempt); assert.equal(element['nameOwner'], owner);
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Current reconnect error');
    assertEditor(element, { value: 'pending draft', disabled: true, busy: true });
    await tick(500); const next = sockets[1]!, resume = await hello(next);
    const accepted = roomState(); accepted.me.name = 'Accepted while pending';
    next.deliver({ type: 'room:state', ...accepted }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assertEditor(element, { accepted: 'Accepted while pending', value: 'pending draft', disabled: true, busy: true });
    click(element['nameUpdate']); assert.equal(setName.mock.callCount(), 1);
    assert.equal(element['nameAttempt'], attempt); assert.equal(element['error'].textContent, 'Current reconnect error');
    pending.resolve(); await settle();
    assertEditor(element, { accepted: 'Accepted while pending', value: 'pending draft' });
    assert.equal(element['error'].hidden, false, 'settling an operation does not erase an independent error');
  });

  it('keeps a real lost-request failure and draft across reconnect without accepting an old-wire ACK or error', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t);
    draft(element, 'lost request draft'); click(element['nameUpdate']); await tick(100);
    const command = renameRequest(socket), oldMessage = socket.onmessage;
    socket.close(); await settle();
    assertEditor(element, { value: 'lost request draft', disabled: true });
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, '連線已中斷。');
    click(element['nameUpdate']); assert.equal(client['pending'].size, 0);
    await tick(500); const next = sockets[1]!, resume = await hello(next);
    next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    draft(element, 'new request draft'); click(element['nameUpdate']); await tick(100);
    const active = renameRequest(next), attempt = element['nameAttempt'];
    for (const message of [
      { type: 'ok', requestId: command.requestId },
      { type: 'error', code: 'bad_request', requestId: command.requestId, message: 'Old-wire rename error' },
      { type: 'room:state', ...roomState(), me: { ...roomState().me, name: 'Old-wire name' } },
    ] satisfies ServerMessage[]) oldMessage?.({ data: JSON.stringify(message) });
    await settle(); assert.equal(element['nameAttempt'], attempt); assert.equal(element['error'].hidden, true);
    assertEditor(element, { value: 'new request draft', disabled: true, busy: true });
    next.deliver({ type: 'ok', requestId: active.requestId }); await settle(); assertEditor(element, { value: 'new request draft' });
  });

  for (const transition of ['leave', 'detach', 'direct disconnect', 'ordinary close', 'kick', 'shutdown'] as const) {
    it(`retires accepted text, draft and pending immediately on ${transition}`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t);
      draft(element, 'private pending draft'); click(element['nameUpdate']); await tick(100);
      assertEditor(element, { value: 'private pending draft', disabled: true, busy: true });
      if (transition === 'leave') click(element['roomAction']);
      else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else if (transition === 'direct disconnect') await client.disconnect();
      else socket.deliver(terminalCases.find(item => item.title === transition)!.message);
      await settle(); await settle(); assertRetired(element);
      const error = element['error'].textContent, hidden = element['error'].hidden;
      click(element['nameUpdate']); element.playbackMuted = true; await settle(); assertRetired(element);
      assert.equal(element['error'].textContent, error); assert.equal(element['error'].hidden, hidden);
      assert.equal(client['pending'].size, 0);
    });
  }

  for (const transition of ['room', 'participant'] as const) {
    for (const outcome of ['resolve', 'reject'] as const) {
      it(`isolates a retired ${transition} owner's late ${outcome} from a new pending name operation`, async t => {
        const { element, client, socket } = await socketJoinedWidget(t);
        const old = deferred(), active = deferred();
        // Synthetic delayed methods let an old completion arrive after a fresh owner has submitted.
        let calls = 0; t.mock.method(client, 'setName', () => (++calls === 1 ? old : active).promise);
        draft(element, 'old draft'); click(element['nameUpdate']); const owner = element['nameOwner'];
        const next = roomState(false, transition === 'room' ? 'two' : 'one');
        if (transition === 'participant') next.me.participantId = 'replacement';
        next.me.name = 'Fresh &amp; owner';
        let forwarded = 0;
        element.addEventListener('stage-state', () => {
          forwarded++; assert.equal(element['nameInput'].value, 'Fresh & owner');
          assert.notEqual(element['nameOwner'], owner); assert.equal(element['nameAttempt'], undefined);
          draft(element, 'new pending draft'); click(element['nameUpdate']);
        }, { once: true });
        socket.deliver({ type: 'room:state', ...next });
        assert.equal(forwarded, 1); assert.equal(calls, 2);
        const attempt = element['nameAttempt'];
        socket.deliver({ type: 'error', code: 'conflict', message: 'Current owner error' });
        if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Retired owner error'));
        await settle();
        assert.equal(element['nameAttempt'], attempt);
        assertEditor(element, { accepted: 'Fresh & owner', value: 'new pending draft', disabled: true, busy: true });
        assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Current owner error');
        active.resolve(); await settle(); assertEditor(element, { accepted: 'Fresh & owner', value: 'new pending draft' });
      });
    }
  }

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`isolates a retired client's delayed ${outcome} across attribute rejoin using the reused name controls`, async t => {
      const { element, client, socket, sockets, hello } = await socketJoinedWidget(t);
      const old = deferred(); t.mock.method(client, 'setName', () => old.promise);
      draft(element, 'old-client draft'); click(element['nameUpdate']);
      const oldMessage = socket.onmessage, oldClose = socket.onclose;
      element.setAttribute('room', 'two'); await settle(); await settle(); assertRetired(element);
      const current = element.client!; assert.notEqual(current, client);
      const next = sockets[1]!, join = await hello(next), state = roomState(false, 'two'); state.me.name = 'New room name';
      next.deliver({ type: 'room:state', ...state }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
      const active = deferred(); t.mock.method(current, 'setName', () => active.promise);
      draft(element, 'new-client pending draft'); click(element['nameUpdate']);
      const owner = element['nameOwner'], attempt = element['nameAttempt'];
      next.deliver({ type: 'error', code: 'conflict', message: 'Current client failure' });
      if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Retired client failure'));
      oldMessage?.({ data: JSON.stringify({ type: 'room:state', ...roomState(), me: { ...roomState().me, name: 'Old wire' } }) });
      oldClose?.(); await settle();
      assert.equal(element['nameOwner'], owner); assert.equal(element['nameAttempt'], attempt);
      assertEditor(element, { accepted: 'New room name', value: 'new-client pending draft', disabled: true, busy: true });
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Current client failure');
      active.resolve(); await settle(); assertEditor(element, { accepted: 'New room name', value: 'new-client pending draft' });
    });
  }

  it('retires an initial state-before-ACK seat on actual socket loss and isolates a same-ID rejoin after silent disconnect', async t => {
    const { element, sockets, hello, tick, joinRequest } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, initialJoin = await hello(socket), client = element.client!;
    socket.deliver({ type: 'room:state', ...roomState() });
    assert.equal(client['session'], null, 'initial state precedes the join ACK and installed resume session');
    assert.equal(client['pending'].has(initialJoin.requestId), true);
    const old = deferred(), active = deferred(); let calls = 0;
    // Delayed method isolates an old widget completion while the real SDK handles both join lifecycles.
    t.mock.method(client, 'setName', () => (++calls === 1 ? old : active).promise);
    draft(element, 'retired same-ID draft'); click(element['nameUpdate']); const owner = element['nameOwner'];
    socket.close(); await settle();
    assert.equal(client.status, 'disconnected'); assert.ok(client.state, 'initial socket loss retains the SDK snapshot');
    assertRetired(element);
    let statuses = 0; element.addEventListener('stage-status', () => { statuses++; });
    await client.disconnect(); assert.equal(statuses, 0, 'explicit disconnect repeats the current status');
    assert.equal(client.state, null); assertRetired(element);
    const connecting = client.connect(), next = sockets[1]!;
    next.hello(); await connecting;
    const joining = client.join({ roomId: 'one', name: 'Fresh same-ID name' }); await settle(); await tick(100);
    const request = joinRequest(next), fresh = roomState(); fresh.me.name = 'Fresh same-ID name';
    next.deliver({ type: 'room:state', ...fresh }); next.deliver({ type: 'ok', requestId: request.requestId }); await joining;
    assert.notEqual(element['nameOwner'], owner); assertEditor(element, { accepted: 'Fresh same-ID name' });
    draft(element, 'fresh same-ID pending'); click(element['nameUpdate']); const attempt = element['nameAttempt'];
    next.deliver({ type: 'error', code: 'conflict', message: 'Fresh same-ID error' });
    old.reject(new Error('Retired same-ID error')); await settle();
    assert.equal(element['nameAttempt'], attempt);
    assertEditor(element, { accepted: 'Fresh same-ID name', value: 'fresh same-ID pending', disabled: true, busy: true });
    assert.equal(element['error'].textContent, 'Fresh same-ID error');
    active.resolve(); await settle(); assertEditor(element, { accepted: 'Fresh same-ID name', value: 'fresh same-ID pending' });
  });

  it('keeps rename pending independent from a concurrent hand action and ignores a duplicate old ACK', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t);
    click(element['hand']); draft(element, 'first draft'); click(element['nameUpdate']); await tick(200);
    const hand = socket.sent.find(message => message.type === 'hand:raise'); assert.ok(hand);
    const first = renameRequest(socket), state = roomState(); state.me.name = 'Accepted first';
    state.me.handRaised = true; state.hands = [state.me];
    socket.deliver({ type: 'room:state', ...state });
    assertEditor(element, { accepted: 'Accepted first', value: 'first draft', disabled: true, busy: true });
    assert.equal(element['hand'].getAttribute('aria-busy'), 'true');
    assert.equal(element['pendingActions'].has(element['nameUpdate']), false, 'rename has dedicated operation ownership');
    socket.deliver({ type: 'ok', requestId: first.requestId }); await settle();
    assertEditor(element, { accepted: 'Accepted first', value: 'first draft' });
    assert.equal(element['hand'].getAttribute('aria-busy'), 'true'); assert.equal(client['pending'].size, 1);
    draft(element, 'second draft'); click(element['nameUpdate']); await tick(100);
    const second = renameRequest(socket), attempt = element['nameAttempt']; assert.notEqual(second.requestId, first.requestId);
    socket.deliver({ type: 'ok', requestId: first.requestId });
    socket.deliver({ type: 'ok', requestId: hand.requestId }); await settle();
    assert.equal(element['nameAttempt'], attempt); assert.equal(element['hand'].getAttribute('aria-busy'), null);
    assertEditor(element, { accepted: 'Accepted first', value: 'second draft', disabled: true, busy: true });
    socket.deliver({ type: 'ok', requestId: second.requestId }); await settle();
    assertEditor(element, { accepted: 'Accepted first', value: 'second draft' });
  });

  it('preserves an actual SDK queue_full failure without consuming another request slot or clearing the draft', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t);
    Object.defineProperty(client, 'maxPendingControlRequests', { value: 1 });
    const occupied = client.mute(); void occupied.catch(() => {}); await tick(100);
    const held = socket.sent.find(message => message.type === 'mic:mute'); assert.ok(held);
    const frames = [...socket.sent];
    draft(element, '  retained queue draft  '); click(element['nameUpdate']); await settle();
    assertEditor(element, { value: '  retained queue draft  ' });
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, '待回覆控制請求已滿，請等待完成後再試。');
    assert.equal(client['pendingControlRequests'], 1); assert.deepEqual(socket.sent, frames);
    socket.deliver({ type: 'ok', requestId: held.requestId }); await occupied;
    click(element['nameUpdate']); await tick(100);
    const request = renameRequest(socket); assert.equal(request.name, '  retained queue draft  ');
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    assertEditor(element, { value: '  retained queue draft  ' }); assert.equal(element['error'].hidden, true);
  });

  it('reserves the operation before a synchronous setName callback can reenter the same-seat editor', async t => {
    const { element, client, socket } = await socketJoinedWidget(t);
    const pending = deferred(), state = roomState(); state.me.name = 'Accepted synchronously';
    let callbacks = 0;
    element.addEventListener('stage-state', () => {
      callbacks++;
      assert.equal(element['nameUpdate'].getAttribute('aria-busy'), 'true');
      draft(element, 'draft edited inside callback'); click(element['nameUpdate']);
    }, { once: true });
    // The SDK ordinarily awaits a wire response; this synthetic method stresses synchronous host reentry.
    const setName = t.mock.method(client, 'setName', () => {
      socket.deliver({ type: 'room:state', ...state });
      return pending.promise;
    });
    draft(element, 'submitted primitive'); click(element['nameUpdate']);
    assert.equal(callbacks, 1); assert.equal(setName.mock.callCount(), 1);
    assert.deepEqual(setName.mock.calls[0]!.arguments, ['submitted primitive']);
    assertEditor(element, { accepted: 'Accepted synchronously', value: 'draft edited inside callback', disabled: true, busy: true });
    pending.resolve(); await settle();
    assertEditor(element, { accepted: 'Accepted synchronously', value: 'draft edited inside callback' });
  });

  for (const guard of ['detached', 'current cleared'] as const) {
    it(`rejects a synthetic still-callable ${guard} editor without clearing an unrelated alert`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t);
      const setName = t.mock.method(client, 'setName');
      socket.deliver({ type: 'error', code: 'conflict', message: 'Existing guarded error' });
      const frames = [...socket.sent]; draft(element, 'guarded draft');
      if (guard === 'detached') Object.assign(element, { isConnected: false });
      else element['current'] = null;
      click(element['nameUpdate']); await settle();
      assert.equal(setName.mock.callCount(), 0); assert.deepEqual(socket.sent, frames);
      assert.equal(client['pending'].size, 0); assert.equal(element['nameAttempt'], undefined);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Existing guarded error');
      if (guard === 'current cleared') await client.disconnect();
    });
  }
});

/**
 * Room-name cases exercise the real SDK request/state lane with controlled sockets and DOM.
 * Hub cases use the real parser and room model. Media is stubbed; assigning input.value and
 * calling onclick tests handler ownership, not browser layout, keyboard/IME, or device capture.
 */
describe('widget inline controller room name editor', () => {
  type Widget = InstanceType<typeof StageElement>;
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  function controllerState(onStage = false, roomId = 'one'): RoomStatePayload {
    const state = roomState(onStage, roomId); state.me.role = 'controller'; state.controllerId = state.me.participantId;
    return state;
  }
  function draft(element: Widget, value: string): void { element['roomNameInput'].value = value; }
  function assertEditor(element: Widget, { accepted = 'Room & Hall', value = accepted, hidden = false,
    disabled = hidden, busy = false }: { accepted?: string; value?: string; hidden?: boolean; disabled?: boolean; busy?: boolean } = {}): void {
    assert.equal(element['roomNamePanel'].hidden, hidden, 'controller-only room editor visibility');
    assert.equal(element['acceptedRoomName'].textContent, hidden ? '' : `目前房間名稱：${accepted}`, 'accepted title comes only from state');
    assert.equal(element['roomNameInput'].value, value, 'room draft belongs to the current controller tenure');
    assert.equal(element['roomNameUpdate'].disabled, disabled);
    assert.equal(element['roomNameUpdate'].getAttribute('aria-busy'), hidden ? null : String(busy));
    assert.equal(Boolean(element['roomNameAttempt']), busy);
  }
  function assertRetired(element: Widget): void {
    assertEditor(element, { accepted: '', value: '', hidden: true });
    assert.equal(element['roomNameOwner'], undefined); assert.equal(element['roomNameInput'].disabled, true);
  }
  function renameRequest(socket: ReturnType<typeof socketJoiningWidget>['sockets'][number]) {
    const request = socket.sent.filter(message => message.type === 'room:rename').at(-1);
    assert.ok(request && request.type === 'room:rename', 'public setRoomName sends room:rename'); return request;
  }

  it('exposes one labeled room-name part with no client-side limit and stays inert before state or with an ACK-only join', async t => {
    const empty = new StageElement(); widgets.push(empty); assertRetired(empty); click(empty['roomNameUpdate']);
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const client = element.client!, setRoomName = t.mock.method(client, 'setRoomName');
    assertRetired(element); click(element['roomNameUpdate']);
    const join = await hello(sockets[0]!); sockets[0]!.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    assertRetired(element); click(element['roomNameUpdate']);
    assert.equal(setRoomName.mock.callCount(), 0); assert.equal(client['pending'].size, 0);
    const matches = nodes(element as unknown as Node).filter(node => node.part.has('room-name'));
    assert.deepEqual(matches, [element['roomNamePanel']]);
    const input = element['roomNameInput'], button = element['roomNameUpdate'];
    assert.equal(input.tagName, 'INPUT'); assert.equal(input.type, 'text'); assert.equal(input.id, 'room-name');
    assert.equal(input.hasAttribute('maxlength'), false); assert.equal(Reflect.get(input, 'maxLength'), undefined);
    assert.equal(input.hasAttribute('required'), false);
    const label = nodes(element as unknown as Node).find(node => node.tagName === 'LABEL' && node.getAttribute('for') === input.id);
    assert.ok(label?.textContent); assert.equal(button.type, 'button'); assert.equal(button.textContent, '更新房間名稱');
    assert.notEqual(input.id, element['nameInput'].id); assert.equal(element['error'].hidden, true);
  });

  for (const onStage of [false, true]) {
    it(`hides the editor from a joined ${onStage ? 'speaker' : 'audience'} and rejects direct invocation without clearing errors`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, roomState(onStage));
      const setRoomName = t.mock.method(client, 'setRoomName');
      socket.deliver({ type: 'error', code: 'conflict', message: 'Existing role error' });
      const frames = [...socket.sent]; assertRetired(element); draft(element, 'unauthorized direct draft');
      click(element['roomNameUpdate']); await settle();
      assert.equal(setRoomName.mock.callCount(), 0); assert.deepEqual(socket.sent, frames); assert.equal(client['pending'].size, 0);
      assertRetired(element); assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Existing role error');
      assert.equal(element['namePanel'].hidden, false, 'participant name editing is still available');
    });

    it(`offers an ${onStage ? 'onstage' : 'offstage'} controller safe decoded accepted text and forwards the exact raw draft`, async t => {
      const state = controllerState(onStage); state.name = '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Q&quot; &#39;S&#39; &amp;lt;';
      const decoded = '<img src=x onerror=alert(1)> & "Q" \'S\' &lt;';
      const { element, client, socket, tick } = await socketJoinedWidget(t, state);
      assertEditor(element, { accepted: decoded }); assert.equal(element['roomNameInput'].disabled, false);
      assert.deepEqual((element['acceptedRoomName'] as unknown as Node).children, []);
      assert.equal(Reflect.get(element['acceptedRoomName'], 'innerHTML'), undefined);
      const raw = '  \u200be\u0301 & <room> \n  ', attrs = [...(element as unknown as Node).attributes];
      draft(element, raw); click(element['roomNameUpdate']); await tick(100); const request = renameRequest(socket);
      assert.equal(request.name, raw); assertEditor(element, { accepted: decoded, value: raw, disabled: true, busy: true });
      socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      assertEditor(element, { accepted: decoded, value: raw }); assert.equal(client.state?.name, state.name);
      assert.deepEqual([...(element as unknown as Node).attributes], attrs, 'room/name/code attributes are never rewritten');
    });
  }

  it('renders the actual Hub normalized title before ACK without replacing drafts, controls, playback, or the client', async t => {
    const h = harness(); t.after(async () => { await h.hub.shutdown(); }); const host = await h.create();
    const initial = host.s.last('room:state')!;
    const { element, client, socket, sockets, tick } = await socketJoinedWidget(t, initial);
    const owner = element['roomNameOwner'], generation = element['generation'];
    const controls = [element['roomNameInput'], element['acceptedRoomName'], element['nameInput'], element['hand'], element['mic'], element['roomAction'], element['volume']];
    const setRoomName = t.mock.method(client, 'setRoomName');
    element.playbackMuted = true; element.playbackVolume = 0.37;
    element['nameInput'].value = 'unsubmitted personal name';
    const raw = '  \u200be\u0301 <&> "room"\n  ';
    draft(element, raw); click(element['roomNameUpdate']); click(element['roomNameUpdate']); await tick(100);
    assert.equal(setRoomName.mock.callCount(), 1); assert.deepEqual(setRoomName.mock.calls[0]!.arguments, [raw]);
    const request = renameRequest(socket), start = host.s.inbox.length;
    await h.hub.handle(host.s, parseClientMessage(JSON.stringify(request), testConfig().limits));
    const replies = host.s.inbox.slice(start), snapshot = replies.find(message => message.type === 'room:state');
    const ack = replies.find(message => message.type === 'ok' && message.requestId === request.requestId);
    assert.ok(snapshot && snapshot.type === 'room:state'); assert.ok(ack);
    assert.equal(snapshot.name, 'é &lt;&amp;&gt; &quot;room&quot;'); socket.deliver(snapshot);
    assertEditor(element, { accepted: 'é <&> "room"', value: raw, disabled: true, busy: true });
    assert.equal(client['pending'].has(request.requestId), true);
    draft(element, '  next unsent room draft  '); socket.deliver(snapshot); socket.deliver({ type: 'status', state: 'waiting' });
    click(element['roomNameUpdate']); await tick(100); assert.equal(setRoomName.mock.callCount(), 1);
    assert.equal(element['roomNameInput'].disabled, false, 'pending submission still allows typing the next draft');
    socket.deliver(ack); await settle();
    assertEditor(element, { accepted: 'é <&> "room"', value: '  next unsent room draft  ' });
    assert.equal(element['roomNameOwner'], owner); assert.equal(element['generation'], generation); assert.equal(element.client, client); assert.equal(sockets.length, 1);
    assert.deepEqual([element['roomNameInput'], element['acceptedRoomName'], element['nameInput'], element['hand'], element['mic'], element['roomAction'], element['volume']], controls);
    assert.equal(element['nameInput'].value, 'unsubmitted personal name'); assert.equal(element['acceptedName'].textContent, '目前名稱：Host');
    assert.equal(element.getAttribute('room'), host.roomId); assert.equal(element.getAttribute('name'), 'Listener');
    assert.equal(client.playbackMuted, true); assert.equal(client.playbackVolume, 0.37); assert.equal(element['volume'].value, '37');
    assert.equal(client['pc'], null, 'stubbed media remains untouched'); assert.equal(element['error'].hidden, true);
  });

  it('lets the real server parser own empty, whitespace and custom length limits without trimming or imposing a default cap', async t => {
    const config = testConfig(c => { c.limits.nameMaxLength = 2; });
    const { element, client, socket, tick } = await socketJoinedWidget(t, controllerState());
    for (const raw of ['', ' \n\t\u200b ', '🐱🐱🐱']) {
      draft(element, raw); click(element['roomNameUpdate']); await tick(100); const request = renameRequest(socket);
      assert.equal(request.name, raw); let failure: ValidationError | undefined;
      try { parseClientMessage(JSON.stringify(request), config.limits); }
      catch (error) { assert.ok(error instanceof ValidationError); failure = error; }
      assert.ok(failure); assert.equal(failure.code, 'bad_request');
      socket.deliver({ type: 'error', code: failure.code, message: failure.message, requestId: request.requestId }); await settle();
      assertEditor(element, { value: raw }); assert.equal(element['error'].textContent, failure.message); assert.equal(client['pending'].size, 0);
    }
    const raw = '  e\u0301<\u200b  '; draft(element, raw); click(element['roomNameUpdate']); await tick(100);
    const normalized = parseClientMessage(JSON.stringify(renameRequest(socket)), config.limits);
    assert.deepEqual(normalized, { ...renameRequest(socket), name: 'é&lt;' });
    socket.deliver({ type: 'ok', requestId: renameRequest(socket).requestId }); await settle();
    const long = '🐱'.repeat(testConfig().limits.nameMaxLength + 1);
    draft(element, long); click(element['roomNameUpdate']); await tick(100);
    const custom = testConfig(c => { c.limits.nameMaxLength = long.length; });
    assert.equal(renameRequest(socket).name, long);
    assert.doesNotThrow(() => parseClientMessage(JSON.stringify(renameRequest(socket)), custom.limits));
    socket.deliver({ type: 'ok', requestId: renameRequest(socket).requestId }); await settle(); assertEditor(element, { value: long });
  });

  it('preserves actual Hub forbidden failures when control changed on the server before the widget receives its snapshot', async t => {
    const h = harness(); t.after(async () => { await h.hub.shutdown(); });
    const host = await h.create(), next = await h.join(host.roomId, host.code, 'Next');
    const { element, client, socket, tick } = await socketJoinedWidget(t, host.s.last('room:state')!);
    assert.equal(await h.req(host.s, { type: 'control:transfer', targetId: next.id }), 'ok');
    const raw = '  unauthorized server title  '; draft(element, raw); click(element['roomNameUpdate']); await tick(100);
    const request = renameRequest(socket), start = host.s.inbox.length;
    await h.hub.handle(host.s, parseClientMessage(JSON.stringify(request), testConfig().limits));
    const failure = host.s.inbox.slice(start).find(message => message.type === 'error' && message.requestId === request.requestId);
    assert.ok(failure && failure.type === 'error'); assert.equal(failure.code, 'forbidden');
    const forwarded: unknown[] = []; element.addEventListener('stage-error', event => forwarded.push((event as CustomEvent).detail));
    socket.deliver(failure); await settle(); assertEditor(element, { accepted: 'Room', value: raw });
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, failure.message);
    assert.equal(forwarded.length, 1); assert.equal(client['pending'].size, 0); assert.equal(client.state?.name, 'Room');
    socket.deliver(host.s.last('room:state')!); assertRetired(element);
  });

  it('keeps the draft after actual SDK queue_full and retries without creating an extra occupied request', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, controllerState());
    Object.defineProperty(client, 'maxPendingControlRequests', { value: 1 });
    const occupied = client.mute(); void occupied.catch(() => {}); await tick(100);
    const held = socket.sent.find(message => message.type === 'mic:mute'); assert.ok(held); const frames = [...socket.sent];
    draft(element, '  queue draft  '); click(element['roomNameUpdate']); await settle();
    assertEditor(element, { value: '  queue draft  ' }); assert.equal(element['error'].hidden, false);
    assert.equal(element['error'].textContent, '待回覆控制請求已滿，請等待完成後再試。');
    assert.equal(client['pendingControlRequests'], 1); assert.deepEqual(socket.sent, frames);
    socket.deliver({ type: 'ok', requestId: held.requestId }); await occupied;
    click(element['roomNameUpdate']); await tick(100); const request = renameRequest(socket); assert.equal(request.name, '  queue draft  ');
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle(); assertEditor(element, { value: request.name }); assert.equal(element['error'].hidden, true);
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`retires a controller tenure before role-loss forwarding and isolates its late ${outcome} after transfer back`, async t => {
      const h = harness(); t.after(async () => { await h.hub.shutdown(); });
      const host = await h.create(), next = await h.join(host.roomId, host.code, 'Next');
      const { element, client, socket } = await socketJoinedWidget(t, host.s.last('room:state')!);
      const old = deferred(), active = deferred(); let calls = 0;
      // Deferred SDK method isolates widget completion after the real Hub transfers authority twice.
      t.mock.method(client, 'setRoomName', () => (++calls === 1 ? old : active).promise);
      draft(element, 'old controller draft'); click(element['roomNameUpdate']); const owner = element['roomNameOwner'];
      socket.deliver({ type: 'error', code: 'conflict', message: 'Retained transfer error' });
      assert.equal(await h.req(host.s, { type: 'control:transfer', targetId: next.id }), 'ok');
      let lost = 0; element.addEventListener('stage-state', () => {
        lost++; assertRetired(element); click(element['roomNameUpdate']); assert.equal(calls, 1);
        assert.equal(element['error'].textContent, 'Retained transfer error'); assert.equal(element['error'].hidden, false);
      }, { once: true });
      socket.deliver(host.s.last('room:state')!); assert.equal(lost, 1); assertRetired(element);
      assert.equal(await h.req(next.s, { type: 'room:rename', name: 'Changed while away' }), 'ok');
      assert.equal(await h.req(next.s, { type: 'control:transfer', targetId: host.id }), 'ok');
      let regained = 0; element.addEventListener('stage-state', () => {
        regained++; assertEditor(element, { accepted: 'Changed while away' }); assert.notEqual(element['roomNameOwner'], owner);
        draft(element, 'new tenure pending'); click(element['roomNameUpdate']);
      }, { once: true });
      socket.deliver(host.s.last('room:state')!); assert.equal(regained, 1); assert.equal(calls, 2);
      const attempt = element['roomNameAttempt']; socket.deliver({ type: 'error', code: 'conflict', message: 'New tenure error' });
      if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Old tenure error')); await settle();
      assert.equal(element['roomNameAttempt'], attempt); assertEditor(element, { accepted: 'Changed while away', value: 'new tenure pending', disabled: true, busy: true });
      assert.equal(element['error'].textContent, 'New tenure error'); active.resolve(); await settle();
      assertEditor(element, { accepted: 'Changed while away', value: 'new tenure pending' });
    });
  }

  for (const transition of ['room', 'participant'] as const) {
    for (const outcome of ['resolve', 'reject'] as const) {
      it(`isolates a retired ${transition} owner's ${outcome} from a replacement pending room draft`, async t => {
        const { element, client, socket } = await socketJoinedWidget(t, controllerState());
        const old = deferred(), active = deferred(); let calls = 0;
        t.mock.method(client, 'setRoomName', () => (++calls === 1 ? old : active).promise);
        draft(element, 'old owner draft'); click(element['roomNameUpdate']); const owner = element['roomNameOwner'];
        const next = controllerState(false, transition === 'room' ? 'two' : 'one');
        if (transition === 'participant') { next.me.participantId = 'replacement'; next.controllerId = 'replacement'; }
        next.name = 'Fresh &amp; room'; socket.deliver({ type: 'room:state', ...next });
        assert.notEqual(element['roomNameOwner'], owner); assertEditor(element, { accepted: 'Fresh & room' });
        draft(element, 'fresh pending'); click(element['roomNameUpdate']); const attempt = element['roomNameAttempt'];
        socket.deliver({ type: 'error', code: 'conflict', message: 'Current owner error' });
        if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Retired owner error')); await settle();
        assert.equal(element['roomNameAttempt'], attempt); assertEditor(element, { accepted: 'Fresh & room', value: 'fresh pending', disabled: true, busy: true });
        assert.equal(element['error'].textContent, 'Current owner error'); active.resolve(); await settle();
      });
    }
  }

  it('retires on real pre-ACK socket loss with retained snapshot, then isolates silent disconnect and same-ID public rejoin', async t => {
    const { element, sockets, hello, tick, joinRequest } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, initialJoin = await hello(socket), client = element.client!;
    socket.deliver({ type: 'room:state', ...controllerState() });
    assert.equal(client['session'], null); assert.equal(client['pending'].has(initialJoin.requestId), true);
    const old = deferred(), active = deferred(); let calls = 0;
    t.mock.method(client, 'setRoomName', () => (++calls === 1 ? old : active).promise);
    draft(element, 'old same-ID room draft'); click(element['roomNameUpdate']); const owner = element['roomNameOwner'];
    socket.close(); await settle(); assert.equal(client.status, 'disconnected'); assert.ok(client.state); assertRetired(element);
    let statuses = 0; element.addEventListener('stage-status', () => { statuses++; });
    await client.disconnect(); assert.equal(statuses, 0); assert.equal(client.state, null); assertRetired(element);
    const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
    const joining = client.join({ roomId: 'one', name: 'Listener' }); await settle(); await tick(100);
    const request = joinRequest(next), fresh = controllerState(); fresh.name = 'Fresh same-ID room';
    next.deliver({ type: 'room:state', ...fresh }); next.deliver({ type: 'ok', requestId: request.requestId }); await joining;
    assert.notEqual(element['roomNameOwner'], owner); assertEditor(element, { accepted: fresh.name });
    draft(element, 'fresh same-ID pending'); click(element['roomNameUpdate']); const attempt = element['roomNameAttempt'];
    next.deliver({ type: 'error', code: 'conflict', message: 'Fresh same-ID error' }); old.reject(new Error('Retired same-ID error')); await settle();
    assert.equal(element['roomNameAttempt'], attempt); assertEditor(element, { accepted: fresh.name, value: 'fresh same-ID pending', disabled: true, busy: true });
    assert.equal(element['error'].textContent, 'Fresh same-ID error'); active.resolve(); await settle();
  });

  for (const callback of ['stage-status', 'stage-state'] as const) {
    it(`initializes room ownership before forwarded ${callback} and admits one reentrant update before join ACK`, async t => {
      const { element, sockets, hello, tick } = socketJoiningWidget(t); await settle();
      const socket = sockets[0]!, join = await hello(socket), client = element.client!, state = controllerState(); state.name = 'Fresh &amp; title';
      let callbacks = 0; element.addEventListener(callback, () => {
        callbacks++; assertEditor(element, { accepted: 'Fresh & title' });
        draft(element, '  callback room draft  '); click(element['roomNameUpdate']); click(element['roomNameUpdate']);
        assert.equal(element['roomNameUpdate'].getAttribute('aria-busy'), 'true');
      }, { once: true });
      socket.deliver({ type: 'room:state', ...state }); await tick(100);
      assert.equal(callbacks, 1); assert.equal(socket.sent.filter(message => message.type === 'room:rename').length, 1);
      const rename = renameRequest(socket); assert.equal(rename.name, '  callback room draft  '); assert.equal(client['pending'].has(join.requestId), true);
      socket.deliver({ type: 'ok', requestId: join.requestId }); await settle();
      assertEditor(element, { accepted: 'Fresh & title', value: rename.name, disabled: true, busy: true });
      socket.deliver({ type: 'ok', requestId: rename.requestId }); await settle(); assertEditor(element, { accepted: 'Fresh & title', value: rename.name });
    });
  }

  it('reserves the room operation before a synchronous method callback can edit and resubmit the same tenure', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState());
    const pending = deferred(), state = controllerState(); state.name = 'Accepted synchronously'; let callbacks = 0;
    element.addEventListener('stage-state', () => {
      callbacks++; assert.equal(element['roomNameUpdate'].getAttribute('aria-busy'), 'true');
      draft(element, 'edited inside callback'); click(element['roomNameUpdate']);
    }, { once: true });
    const setRoomName = t.mock.method(client, 'setRoomName', () => { socket.deliver({ type: 'room:state', ...state }); return pending.promise; });
    draft(element, 'submitted primitive'); click(element['roomNameUpdate']);
    assert.equal(callbacks, 1); assert.equal(setRoomName.mock.callCount(), 1); assert.deepEqual(setRoomName.mock.calls[0]!.arguments, ['submitted primitive']);
    assertEditor(element, { accepted: state.name, value: 'edited inside callback', disabled: true, busy: true });
    pending.resolve(); await settle(); assertEditor(element, { accepted: state.name, value: 'edited inside callback' });
  });

  it('retains a deferred pending draft through same-seat reconnect and blocks direct invocation without clearing errors', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, controllerState());
    // Unlike real SDK requests, this deferred method deliberately survives socket loss to isolate widget ownership.
    const pending = deferred(), setRoomName = t.mock.method(client, 'setRoomName', () => pending.promise);
    draft(element, 'pending reconnect room draft'); click(element['roomNameUpdate']);
    const owner = element['roomNameOwner'], attempt = element['roomNameAttempt'];
    socket.deliver({ type: 'error', code: 'conflict', message: 'Existing reconnect error' });
    let forwarded = 0; element.addEventListener('stage-status', () => {
      forwarded++; click(element['roomNameUpdate']); assert.equal(setRoomName.mock.callCount(), 1);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Existing reconnect error');
    }, { once: true });
    socket.close(); await settle(); assert.equal(forwarded, 1);
    assertEditor(element, { value: 'pending reconnect room draft', disabled: true, busy: true });
    assert.equal(element['roomNameOwner'], owner); assert.equal(element['roomNameAttempt'], attempt);
    await tick(500); const next = sockets[1]!, resume = await hello(next), state = controllerState(); state.name = 'Changed on resume';
    next.deliver({ type: 'room:state', ...state }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assertEditor(element, { accepted: state.name, value: 'pending reconnect room draft', disabled: true, busy: true });
    click(element['roomNameUpdate']); assert.equal(setRoomName.mock.callCount(), 1); assert.equal(element['roomNameOwner'], owner);
    pending.resolve(); await settle(); assertEditor(element, { accepted: state.name, value: 'pending reconnect room draft' });
    assert.equal(element['error'].textContent, 'Existing reconnect error');
    assert.equal(next.sent.some(message => message.type === 'room:rename'), false, 'reconnect does not replay a title update');
  });

  it('preserves a real lost request failure and ignores old-wire ACK, error and state during a new pending rename', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, controllerState());
    draft(element, 'lost room draft'); click(element['roomNameUpdate']); await tick(100);
    const first = renameRequest(socket), oldMessage = socket.onmessage; socket.close(); await settle();
    assertEditor(element, { value: 'lost room draft', disabled: true }); assert.equal(element['error'].textContent, '連線已中斷。');
    click(element['roomNameUpdate']); assert.equal(client['pending'].size, 0);
    await tick(500); const next = sockets[1]!, resume = await hello(next);
    next.deliver({ type: 'room:state', ...controllerState() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    draft(element, 'new room draft'); click(element['roomNameUpdate']); await tick(100); const active = renameRequest(next), attempt = element['roomNameAttempt'];
    for (const message of [
      { type: 'ok', requestId: first.requestId },
      { type: 'error', code: 'bad_request', message: 'Old-wire room error', requestId: first.requestId },
      { type: 'room:state', ...controllerState(), name: 'Old-wire room name' },
    ] satisfies ServerMessage[]) oldMessage?.({ data: JSON.stringify(message) });
    await settle(); assert.equal(element['roomNameAttempt'], attempt); assert.equal(element['error'].hidden, true);
    assertEditor(element, { value: 'new room draft', disabled: true, busy: true });
    next.deliver({ type: 'ok', requestId: active.requestId }); await settle(); assertEditor(element, { value: 'new room draft' });
  });

  for (const transition of ['leave', 'detach', 'direct disconnect', 'ordinary close', 'kick', 'shutdown'] as const) {
    it(`retires room title, draft and pending immediately on ${transition}`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t, controllerState());
      draft(element, 'private controller draft'); click(element['roomNameUpdate']); await tick(100);
      if (transition === 'leave') click(element['roomAction']);
      else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else if (transition === 'direct disconnect') await client.disconnect();
      else socket.deliver(terminalCases.find(item => item.title === transition)!.message);
      await settle(); await settle(); assertRetired(element);
      const error = element['error'].textContent, hidden = element['error'].hidden;
      click(element['roomNameUpdate']); element.playbackMuted = true; await settle(); assertRetired(element);
      assert.equal(element['error'].textContent, error); assert.equal(element['error'].hidden, hidden); assert.equal(client['pending'].size, 0);
    });
  }

  it('isolates a retired client and generation across attribute rejoin using the same DOM nodes', async t => {
    const { element, client, socket, sockets, hello } = await socketJoinedWidget(t, controllerState());
    const old = deferred(); t.mock.method(client, 'setRoomName', () => old.promise);
    draft(element, 'old client draft'); click(element['roomNameUpdate']); const oldMessage = socket.onmessage, oldClose = socket.onclose;
    const input = element['roomNameInput'], generation = element['generation'];
    element.setAttribute('room', 'two'); await settle(); await settle(); assertRetired(element);
    const current = element.client!; assert.notEqual(current, client); assert.ok(element['generation'] > generation);
    const next = sockets[1]!, join = await hello(next), state = controllerState(false, 'two'); state.name = 'New client title';
    next.deliver({ type: 'room:state', ...state }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    const active = deferred(); t.mock.method(current, 'setRoomName', () => active.promise);
    draft(element, 'new client pending'); click(element['roomNameUpdate']); const owner = element['roomNameOwner'], attempt = element['roomNameAttempt'];
    next.deliver({ type: 'error', code: 'conflict', message: 'Current client error' }); old.reject(new Error('Retired client error'));
    oldMessage?.({ data: JSON.stringify({ type: 'room:state', ...controllerState(), name: 'Old-wire title' }) }); oldClose?.(); await settle();
    assert.equal(element['roomNameInput'], input); assert.equal(element['roomNameOwner'], owner); assert.equal(element['roomNameAttempt'], attempt);
    assertEditor(element, { accepted: state.name, value: 'new client pending', disabled: true, busy: true }); assert.equal(element['error'].textContent, 'Current client error');
    active.resolve(); await settle();
  });

  it('rechecks authority on settlement even if the current SDK snapshot changed without a forwarded render', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState());
    const pending = deferred(); t.mock.method(client, 'setRoomName', () => pending.promise);
    draft(element, 'now unauthorized'); click(element['roomNameUpdate']);
    socket.deliver({ type: 'error', code: 'conflict', message: 'Unrelated current error' });
    // Synthetic silent mutation stresses the settlement guard, not the normal event delivery path.
    client.state!.me.role = 'speaker'; client.state!.controllerId = 'someone-else';
    pending.reject(new Error('Late unauthorized failure')); await settle(); assertRetired(element);
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Unrelated current error');
  });

  it('keeps room and personal rename pending lanes independent and ignores a duplicate old room ACK', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, controllerState(true));
    element['nameInput'].value = 'Personal draft'; click(element['nameUpdate']);
    draft(element, 'First room draft'); click(element['roomNameUpdate']); click(element['mic']); await tick(300);
    const personal = socket.sent.find(message => message.type === 'participant:rename'), mic = socket.sent.find(message => message.type === 'mic:mute');
    assert.ok(personal); assert.ok(mic); const first = renameRequest(socket);
    assert.equal(element['pendingActions'].has(element['roomNameUpdate']), false);
    socket.deliver({ type: 'ok', requestId: first.requestId }); await settle();
    assertEditor(element, { value: 'First room draft' }); assert.equal(element['nameUpdate'].getAttribute('aria-busy'), 'true'); assert.equal(element['mic'].getAttribute('aria-busy'), 'true');
    draft(element, 'Second room draft'); click(element['roomNameUpdate']); await tick(100); const second = renameRequest(socket), attempt = element['roomNameAttempt'];
    socket.deliver({ type: 'ok', requestId: first.requestId }); socket.deliver({ type: 'ok', requestId: personal.requestId }); socket.deliver({ type: 'ok', requestId: mic.requestId }); await settle();
    assert.equal(element['roomNameAttempt'], attempt); assert.equal(element['nameUpdate'].getAttribute('aria-busy'), 'false'); assert.equal(element['mic'].getAttribute('aria-busy'), null);
    assertEditor(element, { value: 'Second room draft', disabled: true, busy: true }); assert.equal(client['pending'].size, 1);
    socket.deliver({ type: 'ok', requestId: second.requestId }); await settle(); assertEditor(element, { value: 'Second room draft' });
  });
});

describe('widget latest own connection quality', () => {
  type Widget = InstanceType<typeof StageElement>;
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  function qualityNode(element: Widget): Node {
    const matches = nodes(element as unknown as Node).filter(node => node.part.has('quality'));
    assert.equal(matches.length, 1, 'one stable quality summary is exposed through ::part(quality)');
    return matches[0]!;
  }
  const summary = (up = '1.2%', down = '3.5%', rtt = '46 ms') =>
    `你的連線品質（最近收到）：上行掉包 ${up} · 下行掉包 ${down} · RTT ${rtt}（非端到端音訊延遲）`;
  const report = (participantId = 'me') => ({ type: 'quality' as const, participants: [
    { participantId, uplinkLossPercent: 1.24, downlinkLossPercent: 3.46, rttMs: 45.6 },
  ] });
  function assertQuality(element: Widget, text?: string): void {
    const node = qualityNode(element);
    assert.equal(node.hidden, text === undefined);
    assert.equal(node.textContent, text ?? '');
    assert.equal(node.tagName, 'P');
    assert.equal(node.getAttribute('aria-live'), null, 'periodic quality reports are not live announcements');
    assert.equal(node.getAttribute('role'), null, 'quality is neither a status live region nor an alert');
    assert.deepEqual(node.children, [], 'the summary remains plain text');
    assert.equal(Reflect.get(node, 'innerHTML'), undefined);
  }

  /** Real SDK capture and sender ownership with fake hardware; no browser audio or SDP claim. */
  function qualityMedia(t: TestContext) {
    const originals = new Map(['navigator', 'RTCPeerConnection', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const tracks: (EventTarget & { enabled: boolean; readyState: string; stops: number; stop(): void })[] = [];
    class Peer {
      static instances: Peer[] = [];
      connectionState = 'connected'; signalingState = 'stable'; localDescription = null; closed = false;
      readonly installs: unknown[] = [];
      readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown, replaceTrack: async (track: unknown) => {
        this.installs.push(track); this.transceiver.sender.track = track;
      } } };
      constructor() { Peer.instances.push(this); }
      addTransceiver() { return this.transceiver; }
      getStats(): never { assert.fail('the widget must not poll browser media stats'); }
      close(): void { this.closed = true; }
    }
    class Context {
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
      async resume() {} async close() {}
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
      const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
        stop() { this.stops++; this.readyState = 'ended'; } }); tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    } } } });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
    const negotiate = t.mock.method(StageClient.prototype as unknown as { negotiate(): void }, 'negotiate', () => {});
    t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
    return { Peer, tracks, negotiate };
  }

  it('starts empty and does not put quality inside an ancestor live region', () => {
    const element = new StageElement(); widgets.push(element);
    assertQuality(element);
    const target = qualityNode(element);
    const ancestors = (node: Node): Node[] | undefined => node === target ? []
      : node.children.map(child => ancestors(child)).find(path => path !== undefined)?.concat(node);
    const path = ancestors(element as unknown as Node); assert.ok(path);
    assert.ok(path.every(node => !node.hasAttribute('aria-live') && !['status', 'alert', 'log'].includes(node.getAttribute('role') ?? '')));
    assert.equal(element['status'].getAttribute('aria-live'), 'polite');
    assert.equal(element['error'].getAttribute('role'), 'alert');
  });

  it('shows only the actual Hub own publisher report while forwarding the full raw SDK detail unchanged', async t => {
    const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; }), h = harness(config);
    t.after(async () => { await h.hub.shutdown(); });
    const host = await h.create('Private host name'), speaker = await h.join(host.roomId, host.code, 'Private speaker name');
    const audience = await h.join(host.roomId, host.code, 'Private audience name');
    assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
    assert.equal(await h.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    const media = qualityMedia(t), { element, client, socket } = await socketJoinedWidget(t, host.s.last('room:state')!, true);
    await client['mediaTask']; assert.equal(media.tracks.length, 1);
    const peer = media.Peer.instances[0]!, track = media.tracks[0]!;
    const frames = [...socket.sent], installs = [...peer.installs], negotiations = media.negotiate.mock.callCount();
    const nonQuality = () => nodes(element as unknown as Node).filter(node => !node.part.has('quality') && node.tagName !== 'STYLE')
      .map(node => [node.tagName, node.hidden, node.disabled, node.textContent, [...node.attributes]]);
    const before = nonQuality(), sdk: unknown[] = [], forwarded: CustomEvent[] = [];
    client.on('quality', ({ detail }) => sdk.push(detail));
    element.addEventListener('stage-quality', event => { assertQuality(element, summary('8.0%', '2.0%', '37 ms')); forwarded.push(event as CustomEvent); });
    let reads = 0;
    h.transport.getStats = async (_room, id) => { reads++; return id === host.id
      ? { inbound: { packetsReceived: 92, packetsLost: 8 }, outbound: { fractionLost: 0.02 }, rttMs: 36.6 }
      : { inbound: { packetsReceived: 1, packetsLost: 99 }, outbound: { fractionLost: 0.88 }, rttMs: 9876 }; };
    const fire = async () => {
      const timers = h.timers.filter(timer => !timer.cleared && timer.ms === config.rooms.qualityIntervalMs);
      assert.equal(timers.length, 1); timers[0]!.cleared = true; timers[0]!.fn(); await nextTurn();
    };
    host.s.clear(); speaker.s.clear(); audience.s.clear(); await fire();
    const message = host.s.last('quality'); assert.ok(message);
    assert.deepEqual(message.participants.map(person => person.participantId).sort(), [host.id, speaker.id].sort());
    assert.deepEqual(speaker.s.last('quality'), message); assert.equal(audience.s.last('quality'), undefined);
    const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
    socket.deliver(message); await settle();
    assert.equal(forwarded.length, 1); assert.equal(forwarded[0]!.detail, sdk[0]);
    assert.deepEqual(forwarded[0]!.detail, { participants: message.participants });
    assert.equal(forwarded[0]!.bubbles, true); assert.equal(forwarded[0]!.composed, true);
    assert.deepEqual(Object.keys(forwarded[0]!.detail), ['participants'], 'wire quality has no room, peer epoch or timestamp');
    assertQuality(element, summary('8.0%', '2.0%', '37 ms'));
    assert.deepEqual(nonQuality(), before); assert.deepEqual(socket.sent, frames);
    assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0);
    assert.equal(reads, 2, 'only the existing Hub collection obtains stats');
    assert.equal(media.tracks.length, 1); assert.equal(track.stops, 0); assert.equal(track.enabled, true);
    assert.equal(media.Peer.instances.length, 1); assert.equal(peer.closed, false); assert.deepEqual(peer.installs, installs);
    assert.equal(media.negotiate.mock.callCount(), negotiations);
  });

  for (const role of ['audience', 'offstage controller', 'speaker', 'onstage controller'] as const) {
    it(`admits only an onstage own report for ${role}`, async t => {
      const state = roomState(role === 'speaker' || role === 'onstage controller');
      if (role.includes('controller')) state.me.role = 'controller';
      const { element, socket } = await socketJoinedWidget(t, state);
      const forwarded: CustomEvent[] = []; element.addEventListener('stage-quality', event => forwarded.push(event as CustomEvent));
      assertQuality(element); socket.deliver(report());
      assertQuality(element, state.me.onStage ? summary() : undefined);
      assert.equal(forwarded.length, 1, 'offstage admission never filters the public event');
      assert.deepEqual(forwarded[0]!.detail, { participants: report().participants });
    });
  }

  it('clears a full replacement set without an own report, including empty, and never treats another publisher as self', async t => {
    const { element, socket } = await socketJoinedWidget(t, roomState(true));
    const node = qualityNode(element);
    for (const participants of [report('private-other-id').participants, []]) {
      socket.deliver(report()); assertQuality(element, summary());
      socket.deliver({ type: 'quality', participants }); assertQuality(element);
      socket.deliver({ type: 'room:state', ...roomState(true) }); element.playbackMuted = true;
      assertQuality(element, undefined); assert.equal(qualityNode(element), node);
    }
    socket.deliver({ type: 'quality', participants: [{ participantId: 'me' }] });
    assertQuality(element, summary('—', '—', '—'));
  });

  const numericCases = [
    { label: 'zero', up: 0, down: 0, rtt: 0, text: summary('0.0%', '0.0%', '0 ms') },
    { label: 'maximum losses and unbounded finite RTT', up: 100, down: 100, rtt: 123456.6, text: summary('100.0%', '100.0%', '123457 ms') },
    { label: 'rounding without a quality verdict', up: 99.96, down: 0.04, rtt: 0.49, text: summary('100.0%', '0.0%', '0 ms') },
    { label: 'missing', up: undefined, down: undefined, rtt: undefined, text: summary('—', '—', '—') },
    { label: 'NaN and infinities', up: NaN, down: Infinity, rtt: -Infinity, text: summary('—', '—', '—') },
    { label: 'outside allowed ranges', up: -0.01, down: 100.01, rtt: -0.01, text: summary('—', '—', '—') },
    { label: 'strings and null', up: '5', down: null, rtt: '30', text: summary('—', '—', '—') },
    { label: 'independent field validation', up: 2.31, down: NaN, rtt: 4.7, text: summary('2.3%', '—', '5 ms') },
  ];
  for (const value of numericCases) {
    it(`formats ${value.label} from synthetic untrusted event fields without coercing raw detail`, async t => {
      const { element, client } = await socketJoinedWidget(t, roomState(true));
      // NaN/Infinity and wrong runtime types cannot all be represented by the JSON wire; this is deliberate robustness coverage.
      const detail = { participants: [{ participantId: 'me', uplinkLossPercent: value.up, downlinkLossPercent: value.down, rttMs: value.rtt }] };
      let forwarded: unknown;
      element.addEventListener('stage-quality', event => { forwarded = (event as CustomEvent).detail; assertQuality(element, value.text); });
      client.dispatchEvent(new CustomEvent('quality', { detail }));
      assert.equal(forwarded, detail); assertQuality(element, value.text);
      assert.equal(detail.participants[0]!.uplinkLossPercent, value.up);
      assert.equal(detail.participants[0]!.downlinkLossPercent, value.down);
      assert.equal(detail.participants[0]!.rttMs, value.rtt);
    });
  }

  it('copies displayed primitives before raw-event listeners mutate the report and keeps them across same-owner snapshots', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, roomState(true));
    const detail = { participants: report().participants };
    element.addEventListener('stage-quality', event => {
      assert.equal((event as CustomEvent).detail, detail); assertQuality(element, summary());
      Object.assign(detail.participants[0]!, { participantId: 'private-mutated-id', uplinkLossPercent: 99, downlinkLossPercent: 88, rttMs: 7777 });
      detail.participants.splice(0);
    }, { once: true });
    // Synthetic application mutation tests public detail identity, not a JSON transport mutation.
    client.dispatchEvent(new CustomEvent('quality', { detail }));
    assertQuality(element, summary());
    for (const role of ['controller', 'speaker'] as const) {
      const state = roomState(true); state.me.role = role; state.me.name = 'Updated own name'; state.me.muted = true;
      socket.deliver({ type: 'room:state', ...state }); socket.deliver({ type: 'status', state: 'waiting' });
      element.playbackMuted = !element.playbackMuted; element.playbackVolume = 0.23;
      assertQuality(element, summary());
    }
    assert.deepEqual(detail.participants, []);
  });

  for (const transition of ['offstage', 'participant identity', 'room identity'] as const) {
    it(`clears before forwarding ${transition} and requires a new quality event after restoration`, async t => {
      const { element, socket } = await socketJoinedWidget(t, roomState(true));
      socket.deliver(report()); assertQuality(element, summary());
      const next = roomState(true);
      if (transition === 'offstage') next.me.onStage = false;
      else if (transition === 'participant identity') next.me.participantId = 'replacement';
      else next.roomId = 'replacement';
      next.status = 'waiting';
      let callbacks = 0;
      for (const event of ['stage-status', 'stage-state']) element.addEventListener(event, () => { callbacks++; assertQuality(element); }, { once: true });
      socket.deliver({ type: 'room:state', ...next }); assert.equal(callbacks, 2); assertQuality(element);
      socket.deliver({ type: 'room:state', ...roomState(true) }); assertQuality(element);
      socket.deliver(report()); assertQuality(element, summary());
    });
  }

  it('clears synchronously on actual reconnect and ignores the retired wire until a new own report arrives', async t => {
    const { element, client, socket, sockets, hello, tick } = await socketJoinedWidget(t, roomState(true));
    socket.deliver(report()); const retiredMessage = socket.onmessage;
    element.addEventListener('stage-status', event => { if ((event as CustomEvent).detail === 'reconnecting') assertQuality(element); });
    let reports = 0; element.addEventListener('stage-quality', () => { reports++; });
    socket.close(); assert.equal(client.status, 'reconnecting'); assertQuality(element);
    retiredMessage?.({ data: JSON.stringify(report()) }); assert.equal(reports, 0); assertQuality(element);
    await tick(500); const next = sockets[1]!, request = await hello(next);
    next.deliver({ type: 'room:state', ...roomState(true), resumeToken: 'resume-me' }); assertQuality(element);
    next.deliver({ type: 'ok', requestId: request.requestId }); await settle(); assertQuality(element);
    retiredMessage?.({ data: JSON.stringify(report()) }); assert.equal(reports, 0);
    next.deliver(report()); assertQuality(element, summary()); assert.equal(reports, 1);
  });

  for (const terminal of [null, ...terminalCases]) {
    it(`clears before forwarded ${terminal?.title ?? 'public disconnect'} without changing the terminal notice`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, roomState(true));
      socket.deliver(report()); assertQuality(element, summary());
      let callbacks = 0;
      element.addEventListener('stage-status', event => { if ((event as CustomEvent).detail === 'disconnected') { callbacks++; assertQuality(element); } });
      if (terminal) element.addEventListener(`stage-${terminal.event}`, () => { callbacks++; assertQuality(element); });
      if (terminal) socket.deliver(terminal.message); else await client.disconnect();
      await settle(); assertQuality(element); assert.equal(callbacks, terminal ? 2 : 1);
      assert.equal(element['status'].textContent, terminal?.text ?? '未連線');
      socket.deliver(report()); assertQuality(element);
    });
  }

  it('clears on a real microphone track loss; preview micready and snapshots cannot revive it, and a later report means only latest received', async t => {
    const media = qualityMedia(t), { element, client, socket } = await socketJoinedWidget(t, roomState(true), true);
    await client['mediaTask']; assert.equal(media.tracks.length, 1);
    socket.deliver(report()); assertQuality(element, summary());
    let errors = 0;
    element.addEventListener('stage-micerror', () => { errors++; assertQuality(element); });
    media.tracks[0]!.readyState = 'ended'; media.tracks[0]!.dispatchEvent(new Event('ended'));
    assert.equal(errors, 1); assertQuality(element); await client['mediaTask'];
    assert.equal(client.me!.onStage, true); assert.equal(media.tracks.length, 1);
    const preview = await client.startMicTest(); assertQuality(element);
    assert.equal(client['mic'], null, 'the real preview micready does not install a room sender');
    assert.equal(media.tracks.length, 2); preview.stop();
    socket.deliver({ type: 'room:state', ...roomState(true) }); await client['mediaTask']; assertQuality(element);
    // A quality frame has no peer epoch: receipt alone cannot prove recovery or identify pre-error measurements.
    socket.deliver(report()); assertQuality(element, summary());
    assert.match(qualityNode(element).textContent, /最近收到/);
    assert.equal(media.tracks.length, 2, 'quality never retries capture after the explicitly started preview');
  });

  it('keeps status, unrelated errors, and pending name/microphone controls unchanged while reports refresh or clear', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, roomState(true));
    element['nameInput'].value = 'unsent after ACK'; click(element['nameUpdate']); click(element['mic']); await tick(200);
    const name = socket.sent.find(message => message.type === 'participant:rename');
    const mute = socket.sent.find(message => message.type === 'mic:mute'); assert.ok(name); assert.ok(mute);
    socket.deliver({ type: 'error', code: 'conflict', message: 'Unrelated current failure' });
    const before = nodes(element as unknown as Node).filter(node => !node.part.has('quality') && node.tagName !== 'STYLE')
      .map(node => [node.hidden, node.disabled, node.textContent, node.value, [...node.attributes]]);
    const frames = [...socket.sent], pending = client['pending'].size, attempt = element['nameAttempt'];
    for (const message of [report(), { type: 'quality' as const, participants: [] }, report()]) socket.deliver(message);
    assertQuality(element, summary());
    assert.equal(element['nameAttempt'], attempt); assert.equal(client['pending'].size, pending); assert.deepEqual(socket.sent, frames);
    assert.deepEqual(nodes(element as unknown as Node).filter(node => !node.part.has('quality') && node.tagName !== 'STYLE')
      .map(node => [node.hidden, node.disabled, node.textContent, node.value, [...node.attributes]]), before);
    socket.deliver({ type: 'ok', requestId: name.requestId }); socket.deliver({ type: 'ok', requestId: mute.requestId }); await settle();
    assertQuality(element, summary()); assert.equal(element['error'].textContent, 'Unrelated current failure');
  });

  for (const transition of ['room', 'code', 'name', 'url', 'detach', 'leave room'] as const) {
    it(`retires on ${transition}, isolates replacement quality from old callbacks and keeps the same DOM node`, async t => {
      const { element, client, socket, sockets, hello } = await socketJoinedWidget(t, roomState(true));
      socket.deliver(report()); const node = qualityNode(element), oldMessage = socket.onmessage, oldClose = socket.onclose;
      if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else if (transition === 'leave room') click(element['roomAction']);
      else element.setAttribute(transition, transition === 'url' ? 'wss://replacement.invalid/ws' : 'replacement');
      assertQuality(element); await settle();
      if (transition === 'detach') { Object.assign(element, { isConnected: true }); element.connectedCallback(); }
      else if (transition === 'leave room') click(element['roomAction']);
      await settle(); await settle();
      const current = element.client; assert.ok(current); assert.notEqual(current, client);
      const next = sockets[1]!, request = await hello(next), state = roomState(true, transition === 'room' ? 'replacement' : 'one');
      next.deliver({ type: 'room:state', ...state }); next.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      assertQuality(element); assert.equal(qualityNode(element), node);
      next.deliver({ type: 'quality', participants: [{ participantId: 'me', rttMs: 123 }] }); assertQuality(element, summary('—', '—', '123 ms'));
      let callbacks = 0; element.addEventListener('stage-quality', () => { callbacks++; });
      oldMessage?.({ data: JSON.stringify(report()) }); oldClose?.();
      // A direct retired-client dispatch additionally stresses the widget subscription generation guard.
      client.dispatchEvent(new CustomEvent('quality', { detail: { participants: report().participants } }));
      await settle(); assert.equal(callbacks, 0); assertQuality(element, summary('—', '—', '123 ms'));
    });
  }

  for (const initialBeforeAck of [false, true]) {
    it(`does not restore same-ID quality after public same-client disconnect/rejoin${initialBeforeAck ? ' following initial state-before-ACK socket loss' : ''}`, async t => {
      const fixture = socketJoiningWidget(t); await settle();
      const { element, sockets, hello, tick, joinRequest } = fixture;
      const socket = sockets[0]!, initialJoin = await hello(socket), client = element.client!;
      socket.deliver({ type: 'room:state', ...roomState(true) });
      if (!initialBeforeAck) { socket.deliver({ type: 'ok', requestId: initialJoin.requestId }); await settle(); }
      socket.deliver(report()); assertQuality(element, summary());
      if (initialBeforeAck) {
        assert.equal(client['session'], null); socket.close(); await settle();
        assert.equal(client.status, 'disconnected'); assert.ok(client.state, 'socket loss retains initial snapshot'); assertQuality(element);
      }
      let statuses = 0; element.addEventListener('stage-status', () => { statuses++; });
      await client.disconnect(); assertQuality(element); assert.equal(client.state, null);
      if (initialBeforeAck) assert.equal(statuses, 0, 'the second disconnected status is intentionally silent');
      const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
      const joining = client.join({ roomId: 'one', name: 'Listener' }); await settle(); await tick(100);
      const join = joinRequest(next);
      next.deliver({ type: 'room:state', ...roomState(true) }); assertQuality(element);
      next.deliver({ type: 'ok', requestId: join.requestId }); await joining; assertQuality(element);
      assert.equal(element.client, client);
      next.deliver(report()); assertQuality(element, summary());
    });
  }

  it('preserves a newer nested report when a forwarded quality callback synchronously reenters the public event lane', async t => {
    const { element, socket } = await socketJoinedWidget(t, roomState(true));
    let callbacks = 0;
    element.addEventListener('stage-quality', () => {
      callbacks++;
      if (callbacks === 1) { assertQuality(element, summary()); socket.deliver({ type: 'quality', participants: [{ participantId: 'me', rttMs: 321 }] }); }
      else assertQuality(element, summary('—', '—', '321 ms'));
    });
    socket.deliver(report()); assert.equal(callbacks, 2); assertQuality(element, summary('—', '—', '321 ms'));
  });

  it('does not repaint an old report after a forwarded quality callback synchronously leaves the room', async t => {
    const { element, socket } = await socketJoinedWidget(t, roomState(true));
    element.addEventListener('stage-quality', () => { assertQuality(element, summary()); click(element['roomAction']); assertQuality(element); }, { once: true });
    socket.deliver(report()); await settle(); assertQuality(element); assert.equal(element.client, null);
    assert.equal(element['status'].textContent, '已離開房間。');
  });

  it('does not adopt a pre-snapshot quality event and uses the last whole duplicate own entry without merging', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, request = await hello(socket), client = element.client!;
    const sdk: unknown[] = [], forwarded: CustomEvent[] = [];
    client.on('quality', ({ detail }) => sdk.push(detail));
    element.addEventListener('stage-quality', event => forwarded.push(event as CustomEvent));
    socket.deliver(report()); assertQuality(element);
    socket.deliver({ type: 'room:state', ...roomState(true) }); assertQuality(element);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle(); assertQuality(element);
    const message = { type: 'quality' as const, participants: [
      ...report().participants, ...report('private-other-id').participants,
      { participantId: 'me', downlinkLossPercent: 0 },
    ] };
    socket.deliver(message); assertQuality(element, summary('—', '0.0%', '—'));
    assert.equal(forwarded.length, 2); assert.equal(forwarded[1]!.detail, sdk[1]);
    assert.deepEqual(forwarded[1]!.detail, { participants: message.participants });
  });

  it('retires on actual Hub own stage:left before its snapshot but retains quality when another participant leaves', async t => {
    const h = harness(testConfig(c => { c.rooms.presenceBroadcastMs = 0; })); t.after(async () => { await h.hub.shutdown(); });
    const host = await h.create(), speaker = await h.join(host.roomId, host.code, 'Other speaker');
    assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
    const { element, client, socket } = await socketJoinedWidget(t, host.s.last('room:state')!);
    socket.deliver(report(host.id)); assertQuality(element, summary());
    let callbacks = 0;
    element.addEventListener('stage-stageleft', event => {
      callbacks++; const detail = (event as CustomEvent).detail;
      assert.equal(client.me!.onStage, true, 'Hub transition events precede the personalised snapshot');
      assertQuality(element, detail.participantId === host.id ? undefined : summary());
    });
    host.s.clear(); assert.equal(await h.req(speaker.s, { type: 'stage:leave' }), 'ok');
    const other = host.s.inbox.find(message => message.type === 'stage:left'); assert.ok(other);
    socket.deliver(other); assertQuality(element, summary());
    socket.deliver(host.s.last('room:state')!); assertQuality(element, summary());
    host.s.clear(); assert.equal(await h.req(host.s, { type: 'stage:leave' }), 'ok');
    const own = host.s.inbox.find(message => message.type === 'stage:left'); assert.ok(own);
    socket.deliver(own); assertQuality(element);
    element.playbackMuted = true; assertQuality(element, undefined);
    socket.deliver(host.s.last('room:state')!); assertQuality(element); assert.equal(client.me!.onStage, false);
    assert.equal(callbacks, 2);
  });

  for (const terminal of terminalCases) {
    it(`accepts new quality after ${terminal.title} and a public same-client same-ID rejoin without accepting the retired socket`, async t => {
      const { element, client, socket, sockets, tick, joinRequest } = await socketJoinedWidget(t, roomState(true));
      const generation = element['generation'], oldMessage = socket.onmessage;
      socket.deliver(report()); assertQuality(element, summary());
      socket.deliver(terminal.message); await settle(); assertQuality(element);
      assert.equal(element.client, client); assert.equal(client.state, null);
      const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
      const joining = client.join({ roomId: 'one', name: 'Listener' }); await settle(); await tick(100);
      const join = joinRequest(next);
      next.deliver({ type: 'room:state', ...roomState(true) }); assertQuality(element);
      next.deliver({ type: 'ok', requestId: join.requestId }); await joining; assertQuality(element);
      assert.equal(element['generation'], generation); assert.equal(element.client, client);
      next.deliver(report()); assertQuality(element, summary());
      let callbacks = 0; element.addEventListener('stage-quality', () => { callbacks++; });
      oldMessage?.({ data: JSON.stringify({ type: 'quality', participants: [] }) });
      await settle(); assert.equal(callbacks, 0); assertQuality(element, summary());
    });
  }

  it('does not revive retired values when an actual microphone retry emits micready', async t => {
    const media = qualityMedia(t), { element, client, socket } = await socketJoinedWidget(t, roomState(true), true);
    await client['mediaTask']; socket.deliver(report()); assertQuality(element, summary());
    media.tracks[0]!.readyState = 'ended'; media.tracks[0]!.dispatchEvent(new Event('ended'));
    await client['mediaTask']; assertQuality(element);
    let ready = 0; element.addEventListener('stage-micready', () => { ready++; assertQuality(element); });
    click(element['micRetry']); assertQuality(element); await client['mediaTask'];
    assert.equal(ready, 1); assert.equal(media.tracks.length, 2); assertQuality(element);
    assert.equal(client['mic']!.getAudioTracks()[0], media.tracks[1]);
    socket.deliver(report()); assertQuality(element, summary());
  });
});
