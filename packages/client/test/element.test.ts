import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { FakeSession, harness, sine, RECVONLY_OFFER, SENDRECV_OFFER, testConfig, type Harness } from '../../../test/helpers.ts';
import { after, afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { StageClient } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { Room } from '../../../src/model/room.ts';
import type { Session } from '../../../src/ws/hub.ts';
import { parseClientMessage, ValidationError } from '../../../src/ws/validate.ts';

/** Minimal DOM surface for widget state tests; this does not simulate a browser layout or input system. */
class Node extends EventTarget {
  readonly children: Node[] = [];
  readonly part = new Set<string>();
  readonly attributes = new Map<string, string>();
  hidden = false;
  open = false;
  disabled = false;
  textContent = '';
  className = '';
  type = '';
  id = '';
  private storedValue = '';
  get value(): string { return this.storedValue; }
  set value(value: string) { this.storedValue = String(value); }
  selected = false;
  min = '';
  max = '';
  step = '';
  tagName = '';
  isConnected = true;
  onclick?: () => void;
  oninput?: (event: Event) => void;
  onchange?: (event: Event) => void;
  contains(node: Node): boolean { return this === node || this.children.some(child => child.contains(node)); }
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]): void { this.children.splice(0, this.children.length, ...nodes); }
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
/** Single-select value/option behavior only; no native focus, keyboard, IME, or accessibility simulation. */
class Select extends Node {
  get options(): Node[] { return this.children.filter(node => node.tagName === 'OPTION'); }
  get selectedIndex(): number { return this.options.findIndex(option => option.selected); }
  set selectedIndex(index: number) { this.options.forEach((option, position) => { option.selected = position === index; }); }
  override get value(): string { return this.options[this.selectedIndex]?.value ?? ''; }
  override set value(value: string) { this.selectedIndex = this.options.findIndex(option => option.value === String(value)); }
  override append(...nodes: Node[]): void { super.append(...nodes); this.resetSelection(); }
  override replaceChildren(...nodes: Node[]): void { super.replaceChildren(...nodes); this.resetSelection(); }
  private resetSelection(): void {
    const selected = this.options.reduce((last, option, index) => option.selected ? index : last, -1);
    this.selectedIndex = selected >= 0 ? selected : this.options.findIndex(option => !option.disabled);
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
Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => Object.assign(tag === 'audio' ? new Audio() : tag === 'select' ? new Select() : new Node(), { tagName: tag.toUpperCase() }), body: { append() {} } } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { confirm: () => false }) });
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

describe('widget transient hand rejection feedback', () => {
  const message = '主控已婉拒這次舉手申請。';
  const rejected = (roomId = 'one', participantId = 'me'): Extract<ServerMessage, { type: 'hand:rejected' }> =>
    ({ type: 'hand:rejected', roomId, participantId });
  function feedback(element: InstanceType<typeof StageElement>, visible = false): void {
    const notice = element['handRejection'];
    assert.equal(notice.hidden, !visible);
    assert.equal(notice.textContent, visible ? message : '');
    assert.equal(notice.getAttribute('role'), 'status');
    assert.equal(notice.getAttribute('aria-live'), 'polite');
    assert.ok((notice as unknown as Node).part.has('hand-rejection'));
    assert.equal(Reflect.get(notice, 'innerHTML'), undefined);
    assert.equal((notice as unknown as Node).children.length, 0, 'feedback uses a plain text paragraph');
  }

  it('shows actual successful Hub rejection only after the target snapshot, preserving ordinary errors and SDK detail identity', async t => {
    const h = harness(); t.after(async () => { await h.hub.shutdown(); });
    const host = await h.create(), listener = await h.join(host.roomId, host.code, '<img src=x> & Listener');
    const observer = await h.join(host.roomId, host.code, 'Observer');
    assert.equal(await h.req(listener.s, { type: 'hand:raise' }), 'ok');
    const initial = listener.s.last('room:state'); assert.ok(initial);
    const { element, client, socket } = await socketJoinedWidget(t, initial);
    feedback(element);
    socket.deliver({ type: 'error', code: 'conflict', message: 'Keep this existing error' });
    const before = { frames: [...socket.sent], pending: client['pending'].size, controls: element['pendingActions'].size,
      cooldown: client.handCooldownMs, error: element['error'].textContent };
    const raw: unknown[] = [], forwarded: CustomEvent[] = [];
    client.on('handrejected', event => raw.push(event.detail));
    element.addEventListener('stage-handrejected', event => {
      feedback(element, true); assert.equal(client.me?.handRaised, false);
      forwarded.push(event as CustomEvent);
    });
    listener.s.clear(); host.s.clear(); observer.s.clear();
    assert.equal(await h.req(host.s, { type: 'stage:reject', targetId: listener.id }), 'ok');
    const replies = [...listener.s.inbox], at = replies.findIndex(item => item.type === 'hand:rejected');
    assert.ok(at >= 0); assert.ok(replies.slice(0, at).some(item => item.type === 'room:state' && !item.me.handRaised));
    assert.equal(host.s.all('hand:rejected').length, 0); assert.equal(observer.s.all('hand:rejected').length, 0);
    for (const reply of replies.slice(0, at)) { socket.deliver(reply); feedback(element); }
    socket.deliver(replies[at]!); feedback(element, true);
    for (const reply of replies.slice(at + 1)) socket.deliver(reply);
    assert.equal(raw.length, 1); assert.equal(forwarded.length, 1); assert.equal(forwarded[0]!.detail, raw[0]);
    assert.deepEqual(raw[0], { roomId: host.roomId, participantId: listener.id });
    assert.equal(forwarded[0]!.bubbles, true); assert.equal(forwarded[0]!.composed, true);
    assert.equal(element['error'].hidden, false); assert.equal(element['status'].textContent, 'Room · 直播中 · 收聽中');
    assert.equal(element['hand'].textContent, '舉手發言'); assert.equal(element['hand'].disabled, false);
    assert.deepEqual({ frames: socket.sent, pending: client['pending'].size, controls: element['pendingActions'].size,
      cooldown: client.handCooldownMs, error: element['error'].textContent }, before);
    assert.doesNotMatch(element['handRejection'].textContent ?? '', /img|Listener|Observer|audio|音訊/);
  });

  it('never infers rejection from real Hub withdrawal, approval or failed moderation', async t => {
    const h = harness(); t.after(async () => { await h.hub.shutdown(); });
    const host = await h.create(), listener = await h.join(host.roomId, host.code, 'Listener');
    const { element, socket } = await socketJoinedWidget(t, listener.s.last('room:state')!);
    const relay = async (actor: FakeSession, command: Parameters<Harness['req']>[1]) => {
      listener.s.clear(); const result = await h.req(actor, command);
      for (const reply of listener.s.inbox) { socket.deliver(reply); feedback(element); }
      assert.equal(listener.s.all('hand:rejected').length, 0); return result;
    };
    assert.equal(await relay(host.s, { type: 'stage:reject', targetId: listener.id }), 'conflict');
    assert.equal(await relay(listener.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await relay(listener.s, { type: 'stage:reject', targetId: listener.id }), 'forbidden');
    assert.equal(await relay(listener.s, { type: 'hand:withdraw' }), 'ok');
    assert.equal(await relay(host.s, { type: 'stage:reject', targetId: listener.id }), 'conflict');
    assert.equal(await relay(listener.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await relay(host.s, { type: 'stage:approve', targetId: listener.id }), 'ok');
    assert.equal(await relay(host.s, { type: 'stage:reject', targetId: listener.id }), 'conflict');
  });

  it('forwards pre-snapshot and mismatched events without storing them for a later matching seat', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, join = await hello(socket), client = element.client!;
    const seen: unknown[] = []; element.addEventListener('stage-handrejected', event => seen.push((event as CustomEvent).detail));
    socket.deliver(rejected()); feedback(element);
    assert.equal(seen.length, 0, 'the SDK drops an unowned wire rejection');
    client.dispatchEvent(new CustomEvent('handrejected', { detail: { roomId: 'one', participantId: 'me' } })); feedback(element);
    socket.deliver({ type: 'room:state', ...roomState() }); feedback(element);
    socket.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    for (const report of [rejected('another-room'), rejected('one', 'another-person')]) {
      socket.deliver(report); feedback(element);
      const { type: _, ...detail } = report;
      client.dispatchEvent(new CustomEvent('handrejected', { detail })); feedback(element);
    }
    const replacement = roomState(false, 'another-room'); replacement.me.participantId = 'another-person';
    socket.deliver({ type: 'room:state', ...replacement }); feedback(element);
    assert.equal(seen.length, 3);
  });

  it('uses safe static text and copies ownership before mutable details are forwarded', async t => {
    const { element, client, socket } = await socketJoinedWidget(t);
    const detail = { roomId: 'one', participantId: 'me', message: '<img src=x onerror=alert(1)>', name: 'SECRET' };
    let forwarded: unknown, raw: unknown;
    client.on('handrejected', event => { raw = event.detail; });
    element.addEventListener('stage-handrejected', event => {
      feedback(element, true); forwarded = (event as CustomEvent).detail;
      detail.roomId = 'mutated-room'; detail.participantId = 'mutated-person';
    }, { once: true });
    client.dispatchEvent(new CustomEvent('handrejected', { detail }));
    assert.equal(forwarded, detail); assert.equal(raw, detail); feedback(element, true);
    socket.deliver({ type: 'room:state', ...roomState() }); element.playbackMuted = true; feedback(element, true);
    assert.doesNotMatch(element['handRejection'].textContent ?? '', /SECRET|img|mutated/);
    for (const invalid of [undefined, null, {}, { roomId: 'one' }, { participantId: 'me' }, { roomId: 1, participantId: 'me' }]) {
      await client.disconnect(); await client['receive']({ type: 'room:state', ...roomState() });
      let received: unknown;
      element.addEventListener('stage-handrejected', event => { received = (event as CustomEvent).detail; }, { once: true });
      const event = new CustomEvent('handrejected', { detail: invalid }); client.dispatchEvent(event);
      assert.equal(received, event.detail); feedback(element);
    }
  });

  for (const transition of ['raised', 'onstage', 'speaker', 'offstage controller', 'onstage controller', 'room', 'participant'] as const) {
    it(`retires on ${transition} before forwarding state and does not revive on return`, async t => {
      const { element, socket } = await socketJoinedWidget(t);
      socket.deliver(rejected()); feedback(element, true);
      const next = roomState();
      if (transition === 'raised') next.me.handRaised = true;
      else if (transition === 'onstage') next.me.onStage = true;
      else if (transition === 'speaker') next.me.role = 'speaker';
      else if (transition.includes('controller')) { next.me.role = 'controller'; next.me.onStage = transition === 'onstage controller'; }
      else if (transition === 'room') next.roomId = 'two';
      else next.me.participantId = 'new-me';
      let callbacks = 0;
      element.addEventListener('stage-state', () => { callbacks++; feedback(element); }, { once: true });
      socket.deliver({ type: 'room:state', ...next }); assert.equal(callbacks, 1); feedback(element);
      socket.deliver(rejected()); feedback(element);
      socket.deliver({ type: 'room:state', ...roomState() }); feedback(element);
      socket.deliver(rejected()); feedback(element, true);
    });
  }

  it('retains notice across ordinary waiting/live state and playback changes without touching pending actions', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t);
    socket.deliver(rejected()); feedback(element, true);
    const node = element['handRejection'];
    for (const status of ['waiting', 'live'] as const) {
      const next = roomState(); next.status = status;
      socket.deliver({ type: 'room:state', ...next }); feedback(element, true);
      element.playbackMuted = !element.playbackMuted; element.playbackVolume = .25; feedback(element, true);
      assert.equal(element['handRejection'], node);
    }
    click(element['hand']); await tick(100);
    const raise = socket.sent.find(item => item.type === 'hand:raise'); assert.ok(raise && raise.type === 'hand:raise');
    assert.equal(element['hand'].getAttribute('aria-busy'), 'true'); assert.equal(client['pending'].has(raise.requestId), true);
    socket.deliver(rejected()); feedback(element, true);
    assert.equal(element['hand'].disabled, true); assert.equal(element['hand'].getAttribute('aria-busy'), 'true');
    const raised = roomState(); raised.me.handRaised = true; raised.hands = [raised.me];
    socket.deliver({ type: 'room:state', ...raised }); feedback(element);
    assert.equal(element['hand'].textContent, '收回舉手'); assert.equal(element['hand'].disabled, true);
    socket.deliver({ type: 'ok', requestId: raise.requestId }); await settle();
    assert.equal(element['hand'].disabled, false); assert.equal(element['pendingActions'].size, 0);
    socket.deliver({ type: 'hand:withdraw', participantId: 'me' });
    socket.deliver({ type: 'room:state', ...roomState() }); feedback(element);
  });

  for (const event of [
    { wire: { type: 'hand:raise', participantId: 'me' }, forwarded: 'hand' },
    { wire: { type: 'stage:joined', participantId: 'me', role: 'speaker' }, forwarded: 'stagejoined' },
    { wire: { type: 'role:update', participantId: 'me', role: 'controller', reason: 'transfer' }, forwarded: 'role' },
    { wire: { type: 'control:transferred', fromId: 'host', toId: 'me' }, forwarded: 'transferred' },
  ] as const satisfies readonly { wire: ServerMessage; forwarded: string }[]) {
    it(`retires before forwarding own ${event.forwarded}, without waiting for the next snapshot`, async t => {
      const { element, socket } = await socketJoinedWidget(t);
      socket.deliver(rejected()); feedback(element, true);
      const other = 'participantId' in event.wire ? { ...event.wire, participantId: 'other' } : { ...event.wire, toId: 'other' };
      socket.deliver(other); feedback(element, true);
      let callbacks = 0;
      element.addEventListener(`stage-${event.forwarded}`, () => { callbacks++; feedback(element); }, { once: true });
      socket.deliver(event.wire); assert.equal(callbacks, 1); feedback(element);
      socket.deliver({ type: 'room:state', ...roomState() }); feedback(element);
    });
  }

  it('clears reconnect feedback before forwarding status and rejects old socket callbacks after same-seat resume', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t);
    socket.deliver(rejected()); feedback(element, true);
    const oldMessage = socket.onmessage, retained = client.state;
    let callbacks = 0;
    element.addEventListener('stage-status', () => { callbacks++; feedback(element); }, { once: true });
    socket.close(); await settle(); feedback(element); assert.equal(callbacks, 1); assert.equal(client.state, retained);
    await client['receive'](rejected()); feedback(element);
    await tick(500); const next = sockets[1]!, join = await hello(next);
    next.deliver({ type: 'room:state', ...roomState() }); feedback(element);
    next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    let reports = 0; element.addEventListener('stage-handrejected', () => { reports++; });
    oldMessage?.({ data: JSON.stringify(rejected()) }); feedback(element); assert.equal(reports, 0);
    next.deliver(rejected()); feedback(element, true); assert.equal(reports, 1);
  });

  it('retires direct public disconnect and allows a same-client same-ID rejoin without replaying its notice', async t => {
    const { element, client, socket, sockets, tick, joinRequest } = await socketJoinedWidget(t);
    socket.deliver(rejected()); feedback(element, true);
    const oldMessage = socket.onmessage;
    await client.disconnect(); feedback(element);
    const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
    const joining = client.join({ roomId: 'one', name: 'Listener' }); await settle(); await tick(100);
    const join = joinRequest(next); next.deliver({ type: 'room:state', ...roomState() }); feedback(element);
    next.deliver({ type: 'ok', requestId: join.requestId }); await joining;
    assert.equal(element.client, client); oldMessage?.({ data: JSON.stringify(rejected()) }); feedback(element);
    next.deliver(rejected()); feedback(element, true);
  });

  it('clears a pre-ACK disconnected snapshot and silent public disconnect without carrying notice into a fresh join', async t => {
    const { element, sockets, hello, tick, joinRequest } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, join = await hello(socket), client = element.client!;
    socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver(rejected()); feedback(element, true);
    assert.equal(client['pending'].has(join.requestId), true); assert.equal(client['session'], null);
    socket.close(); await settle(); assert.equal(client.status, 'disconnected'); assert.ok(client.state); feedback(element);
    let statuses = 0; element.addEventListener('stage-status', () => { statuses++; });
    await client.disconnect(); assert.equal(statuses, 0); feedback(element);
    const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
    const joining = client.join({ roomId: 'one', name: 'Listener' }); await settle(); await tick(100);
    const fresh = joinRequest(next); next.deliver({ type: 'room:state', ...roomState() }); feedback(element);
    next.deliver({ type: 'ok', requestId: fresh.requestId }); await joining; feedback(element);
    next.deliver(rejected()); feedback(element, true);
  });

  it('retires generation ownership and the old client event lane across a same-seat remount', async t => {
    const { element, client } = await subscribedWidget(t);
    await client['receive'](rejected()); feedback(element, true);
    ++element['generation']; element['render'](); feedback(element);
    await client['receive'](rejected()); feedback(element);
    Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
    Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
    const replacement = element.client; assert.ok(replacement); assert.notEqual(replacement, client);
    await replacement['receive']({ type: 'room:state', ...roomState() }); feedback(element);
    let reports = 0; element.addEventListener('stage-handrejected', () => { reports++; });
    client.dispatchEvent(new CustomEvent('handrejected', { detail: { roomId: 'one', participantId: 'me' } }));
    assert.equal(reports, 0); feedback(element);
    await replacement['receive'](rejected()); assert.equal(reports, 1); feedback(element, true);
    await client['receive']({ type: 'status', state: 'reconnecting' }); feedback(element, true);
  });

  it('does not rewrite the live notice for unrelated reports or routine same-seat renders', async t => {
    const { element, socket } = await socketJoinedWidget(t);
    socket.deliver(rejected()); feedback(element, true);
    let text = element['handRejection'].textContent, writes = 0;
    Object.defineProperty(element['handRejection'], 'textContent', {
      configurable: true, get: () => text, set: (value: string) => { writes++; text = value; },
    });
    socket.deliver({ type: 'speaking', participantIds: [] });
    socket.deliver({ type: 'quality', participants: [] });
    socket.deliver({ type: 'room:state', ...roomState() });
    element.playbackMuted = true; element.playbackVolume = .5;
    assert.equal(writes, 0); feedback(element, true);
  });

  for (const transition of ['leave', 'detach', 'room attribute', 'ordinary close', 'kick', 'shutdown'] as const) {
    it(`clears notice on ${transition} and ignores its retired event lane`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t);
      socket.deliver(rejected()); feedback(element, true);
      if (transition === 'leave') click(element['roomAction']);
      else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else if (transition === 'room attribute') element.setAttribute('room', 'two');
      else socket.deliver(terminalCases.find(item => item.title === transition)!.message);
      await settle(); feedback(element);
      client.dispatchEvent(new CustomEvent('handrejected', { detail: { roomId: 'one', participantId: 'me' } })); feedback(element);
      element.playbackMuted = true; feedback(element);
    });
  }

  for (const transition of ['new raised snapshot', 'public disconnect', 'snapshot mutation', 'attribute rejoin', 'own role event'] as const) {
    it(`does not restore an outer notice after a nested ${transition} callback`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t);
      let callbacks = 0;
      element.addEventListener('stage-handrejected', () => {
        callbacks++; feedback(element, true);
        if (transition === 'new raised snapshot') {
          const next = roomState(); next.me.handRaised = true; socket.deliver({ type: 'room:state', ...next });
        } else if (transition === 'public disconnect') void client.disconnect();
        else if (transition === 'snapshot mutation') client.me!.onStage = true;
        else if (transition === 'attribute rejoin') element.setAttribute('room', 'two');
        else socket.deliver({ type: 'role:update', participantId: 'me', role: 'controller', reason: 'transfer' });
      }, { once: true });
      socket.deliver(rejected()); assert.equal(callbacks, 1); feedback(element);
      await settle(); feedback(element); element.playbackMuted = true; feedback(element);
    });
  }
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

  it('keeps real failed and pending capture ownership when explicitly dismissing the widget error', async t => {
    const media = fakeCapture(t);
    const { element, client, socket, sockets } = await socketJoinedWidget(t, roomState(true), true);
    await client['mediaTask']; assertRetry(element);
    assert.equal(element['errorDismiss'].hidden, false);
    const failure = element['micFailure'], revision = element['errorRevision'], message = element['error'].textContent;
    const peer = media.Peer.instances[0]!, frames = [...socket.sent], status = element['status'].textContent;
    const retry = t.mock.method(client, 'retryMicrophone');
    const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
    click(element['errorDismiss']);
    assert.equal(element['error'].hidden, true); assert.equal(element['errorDismiss'].hidden, true);
    assert.equal(element['error'].textContent, message); assert.equal(element['errorRevision'], revision);
    assert.equal(element['micFailure'], failure); assertRetry(element);
    assert.equal(client['micFailed'], true); assert.equal(client['mic'], null); assert.equal(peer.transceiver.sender.track, null);
    assert.equal(media.requests.length, 1); assert.equal(retry.mock.callCount(), 0);
    assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0);
    assert.deepEqual(socket.sent, frames); assert.equal(sockets.length, 1); assert.equal(media.Peer.instances.length, 1);
    assert.equal(element['status'].textContent, status); assert.equal(element.client, client);
    media.hold();
    t.after(async () => { for (const request of media.requests) request.reject(new DOMException('test cleanup', 'AbortError')); await client['mediaTask']; });
    click(element['micRetry']); await until(() => media.requests.length === 2, 'explicit retry starts controlled capture');
    const attempt = element['micFailure'], pendingMicFailed = client['micFailed']; assertRetry(element, { disabled: true, busy: true });
    await client['receive']({ type: 'error', code: 'conflict', message: 'Error during pending capture' });
    click(element['errorDismiss']);
    assert.equal(element['micFailure'], attempt); assertRetry(element, { disabled: true, busy: true });
    assert.equal(media.requests.length, 2); assert.equal(retry.mock.callCount(), 1); assert.equal(client['micFailed'], pendingMicFailed);
    media.requests[1]!.reject(new DOMException('controlled missing device', 'NotFoundError')); await client['mediaTask'];
    assertRetry(element); assert.equal(element['error'].hidden, false); assert.equal(element['errorDismiss'].hidden, false);
    assert.match(element['error'].textContent ?? '', /找不到麥克風/);
    click(element['errorDismiss']); click(element['micRetry']);
    await until(() => media.requests.length === 3, 'only another explicit retry requests capture');
    media.requests[2]!.resolve(media.source()); await client['mediaTask'];
    assertRetry(element, { hidden: true }); assert.equal(element['error'].hidden, true); assert.equal(element['errorDismiss'].hidden, true);
    assert.equal(client['micFailed'], false); assert.equal(peer.transceiver.sender.track, media.tracks[0]);
    assert.equal(retry.mock.callCount(), 2); assert.deepEqual(socket.sent, frames); assert.equal(peer.closed, false);
  });

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

/** Controlled DOM/SDK/Hub evidence only; this does not validate native assistive technology or audible output. */
describe('widget latest room speaking report', () => {
  type Widget = InstanceType<typeof StageElement>;
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  const unknown = '發言偵測：等待伺服器回報。';
  const empty = '最近收到的發言回報：未偵測到發言。';
  const unmatched = '最近收到的發言回報：沒有可對應的台上成員。';
  const names = (...values: string[]) => `最近收到的發言回報：${values.join('、')}（${values.length} 人）。`;
  const report = (...participantIds: string[]) => ({ type: 'speaking' as const, participantIds });
  function speakingNode(element: Widget): Node {
    const matches = nodes(element as unknown as Node).filter(node => node.part.has('speaking'));
    assert.equal(matches.length, 1, 'one persistent paragraph is exposed through ::part(speaking)');
    return matches[0]!;
  }
  function assertSpeaking(element: Widget, text?: string): void {
    const node = speakingNode(element);
    assert.equal(node.hidden, text === undefined);
    assert.equal(node.textContent, text ?? '');
    assert.equal(node.tagName, 'P');
    assert.equal(node.getAttribute('aria-live'), null);
    assert.equal(node.getAttribute('role'), null);
    assert.deepEqual(node.children, [], 'server names remain ordinary text, never parsed markup');
    assert.equal(Reflect.get(node, 'innerHTML'), undefined);
  }
  function speakingState(): RoomStatePayload {
    const state = roomState();
    state.speakers = [
      { ...state.me, participantId: 'host', name: '甲', role: 'controller', onStage: true },
      { ...state.me, participantId: 'speaker', name: '乙', role: 'speaker', onStage: true },
    ];
    return state;
  }
  const nonSpeaking = (element: Widget) => nodes(element as unknown as Node)
    .filter(node => !node.part.has('speaking') && node.tagName !== 'STYLE')
    .map(node => [node.tagName, node.hidden, node.disabled, node.textContent, node.value, [...node.attributes]]);
  const view = (element: Widget) => {
    const node = nodes(element as unknown as Node).find(node => node.part.has('speaking'));
    return { hidden: node?.hidden, text: node?.textContent };
  };
  const visible = (text: string) => ({ hidden: false, text });
  const hidden = { hidden: true, text: '' };

  it('starts hidden and keeps the ordinary paragraph outside every live-region ancestor', () => {
    const element = new StageElement(); widgets.push(element);
    assertSpeaking(element);
    const target = speakingNode(element);
    const ancestors = (node: Node): Node[] | undefined => node === target ? []
      : node.children.map(child => ancestors(child)).find(path => path !== undefined)?.concat(node);
    const path = ancestors(element as unknown as Node); assert.ok(path);
    assert.ok(path.every(node => !node.hasAttribute('aria-live') && !['status', 'alert', 'log'].includes(node.getAttribute('role') ?? '')));
    assert.equal(element['status'].getAttribute('aria-live'), 'polite');
    assert.equal(element['error'].getAttribute('role'), 'alert');
  });

  for (const activeSeed of [true, false]) {
    it(`projects a real Hub ${activeSeed ? 'active grace-speaker' : 'explicit empty'} seed before the public widget join ACK`, async t => {
      const config = testConfig(c => { c.rooms.presenceBroadcastMs = 250; c.rooms.qualityIntervalMs = 0; });
      const h = harness(config), sockets: BridgeSocket[] = [];
      class BridgeSocket {
        static OPEN = 1;
        readyState = 1;
        onmessage: ((event: { data: string }) => void) | null = null;
        onclose: (() => void) | null = null;
        chain = Promise.resolve();
        readonly session = new FakeSession();
        readonly sent: ClientMessage[] = [];
        constructor() {
          sockets.push(this);
          const record = this.session.send.bind(this.session);
          this.session.send = (message: ServerMessage, encoded?: string) => {
            record(message, encoded);
            if (this.readyState === BridgeSocket.OPEN) this.onmessage?.({ data: encoded ?? JSON.stringify(message) });
          };
          queueMicrotask(() => h.hub.attach(this.session));
        }
        send(data: string): void {
          const message = parseClientMessage(data, config.limits); this.sent.push(message);
          this.chain = this.chain.then(() => h.hub.handle(this.session, message));
        }
        close(code = 1006): void {
          if (this.readyState !== BridgeSocket.OPEN) return;
          this.readyState = 3;
          this.chain = this.chain.then(() => h.hub.detach(this.session, code === 1000)).then(() => this.onclose?.());
        }
      }
      const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: BridgeSocket });
      const media = t.mock.method(StageClient.prototype as unknown as { createMedia(): void }, 'createMedia', () => {});
      let now = 1000; t.mock.method(performance, 'now', () => now);
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
      let element: Widget | undefined;
      t.after(async () => {
        element?.disconnectedCallback(); await flush(); await Promise.all(sockets.map(socket => socket.chain));
        await h.hub.shutdown(); await h.transport.close();
        if (original) Object.defineProperty(globalThis, 'WebSocket', original); else Reflect.deleteProperty(globalThis, 'WebSocket');
      });
      const host = await h.create('Private host'), speaker = await h.join(host.roomId, host.code, 'Grace & Speaker');
      assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
      assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
      assert.equal(await h.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
      if (activeSeed) {
        assert.equal(h.transport.emitUplink(host.roomId, speaker.id, sine(960, 0.5)), true);
        h.mixers.get(host.roomId)!.tick();
      }
      await h.hub.detach(speaker.s);
      element = mountJoiningWidget({ room: host.roomId, code: host.code });
      const e = element, node = speakingNode(e), trace: string[] = [], raw: unknown[] = [], forwarded: CustomEvent[] = [];
      const observations: { view: ReturnType<typeof view>; pending: number }[] = [];
      e.addEventListener('stage-state', () => {
        trace.push('state'); observations.push({ view: view(e), pending: e.client!['pending'].size });
      });
      e.addEventListener('stage-speaking', event => {
        trace.push('speaking'); forwarded.push(event as CustomEvent);
        observations.push({ view: view(e), pending: e.client!['pending'].size });
      });
      for (let i = 0; i < 100 && !(e.client?.me && e.client['pending'].size === 0); i++) {
        await flush();
        now += 20; t.mock.timers.tick(20); await flush();
      }
      assert.ok(e.client?.me); assert.equal(e.client['pending'].size, 0);
      assert.equal(sockets.length, 1);
      const socket = sockets[0]!, client = e.client;
      assert.equal(h.hub.isJoined(socket.session), true);
      assert.deepEqual(socket.session.inbox.slice(0, 5).map(message => message.type), ['hello', 'rtc:config', 'room:state', 'speaking', 'ok']);
      assert.deepEqual(trace, ['state', 'speaking']);
      assert.deepEqual(observations, [
        { view: visible(unknown), pending: 1 },
        { view: visible(activeSeed ? names('Grace & Speaker') : empty), pending: 1 },
      ], 'both the unknown snapshot and the actual Hub seed are visible before the join ACK');
      const member = client.state!.speakers.find(person => person.participantId === speaker.id)!;
      assert.equal(member.connected, false); assert.equal(member.onStage, true);
      assert.deepEqual(socket.session.last('speaking')!.participantIds, activeSeed ? [speaker.id] : []);
      assert.equal(forwarded[0]!.bubbles, true); assert.equal(forwarded[0]!.composed, true);
      assert.deepEqual(Object.keys(forwarded[0]!.detail), ['participantIds']);
      const before = nonSpeaking(e), frames = [...socket.sent], mediaCalls = media.mock.callCount();
      const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
      client.on('speaking', ({ detail }) => raw.push(detail));
      if (!activeSeed) {
        assert.equal(h.transport.emitUplink(host.roomId, speaker.id, sine(960, 0.5)), true);
        h.mixers.get(host.roomId)!.tick(); assertSpeaking(e, names('Grace & Speaker'));
      }
      h.mixers.get(host.roomId)!.tick(); h.mixers.get(host.roomId)!.tick(); assertSpeaking(e, empty);
      assert.equal(h.transport.emitUplink(host.roomId, speaker.id, sine(960, 0.5)), true, 'control grace retains the media publisher');
      h.mixers.get(host.roomId)!.tick(); assertSpeaking(e, names('Grace & Speaker'));
      assert.equal(forwarded.at(-1)!.detail, raw.at(-1), 'the original SDK detail is forwarded unchanged');
      assert.equal(speakingNode(e), node); assert.deepEqual(nonSpeaking(e), before); assert.deepEqual(socket.sent, frames);
      assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0);
      assert.equal(media.mock.callCount(), mediaCalls, 'reports never create media');
    });
  }

  it('makes the same room-wide report available to audience, speaker, onstage controller and offstage controller', async t => {
    const { element, client } = await subscribedWidget(t);
    for (const role of ['audience', 'speaker', 'onstage controller', 'offstage controller'] as const) {
      const state = speakingState();
      state.me.role = role.includes('controller') ? 'controller' : role === 'speaker' ? 'speaker' : 'audience';
      state.me.onStage = role === 'speaker' || role === 'onstage controller';
      await client['receive']({ type: 'room:state', ...state });
      await client['receive'](report('speaker', 'host'));
      assertSpeaking(element, names('甲', '乙'));
    }
  });

  it('projects unique eligible IDs in current stage order, keeps equal names and grace, and decodes only into text', async t => {
    const state = speakingState(), first = state.speakers[0]!;
    state.speakers = [
      { ...first, name: '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;&amp;lt;', connected: false },
      { ...first, participantId: 'same-a', name: '同名', role: 'speaker' },
      { ...first, participantId: 'same-b', name: '同名', role: 'speaker' },
      { ...first, participantId: 'same-b', name: 'DUPLICATE ROW' },
      { ...first, participantId: 'offstage-id', name: 'OFFSTAGE PRIVATE', onStage: false },
      { ...first, participantId: 'audience-id', name: 'AUDIENCE PRIVATE', role: 'audience' },
    ];
    state.hands = [{ ...state.me, participantId: 'hand-id', name: 'HAND PRIVATE' }];
    const { element, socket } = await socketJoinedWidget(t, state), node = speakingNode(element);
    assertSpeaking(element, unknown);
    socket.deliver(report('same-b', 'unknown-private-id', 'audience-id', 'offstage-id', 'same-a', 'host', 'same-b', 'hand-id'));
    assertSpeaking(element, names('<img src=x onerror=alert(1)>&"\'&lt;', '同名', '同名'));
    assert.doesNotMatch(node.textContent, /PRIVATE|unknown-private-id|DUPLICATE ROW/);
    socket.deliver(report('same-b')); assertSpeaking(element, names('同名'));
    socket.deliver(report('unknown-private-id', 'audience-id', 'offstage-id', 'hand-id')); assertSpeaking(element, unmatched);
    socket.deliver(report()); assertSpeaking(element, empty);
    socket.deliver(report('host', 'same-a')); assertSpeaking(element, names('<img src=x onerror=alert(1)>&"\'&lt;', '同名'));
    const renamed = structuredClone(state); renamed.speakers[0]!.name = '已改名 &amp; 安全';
    renamed.speakers[1]!.onStage = false;
    let forwardedView: ReturnType<typeof view> | undefined;
    element.addEventListener('stage-state', () => { forwardedView = view(element); }, { once: true });
    socket.deliver({ type: 'room:state', ...renamed }); assertSpeaking(element, names('已改名 & 安全'));
    assert.deepEqual(forwardedView, visible(names('已改名 & 安全')));
    assert.equal(speakingNode(element), node);
  });

  it('forwards pre-snapshot reports without adopting them or bootstrapping the initial SDK getter', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, request = await hello(socket), client = element.client!;
    const seen: unknown[] = []; element.addEventListener('stage-speaking', event => seen.push((event as CustomEvent).detail));
    socket.deliver(report('host')); assertSpeaking(element); assert.deepEqual([...client.speaking], ['host']);
    socket.deliver({ type: 'room:state', ...speakingState() }); assertSpeaking(element, unknown);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle(); assertSpeaking(element, unknown);
    socket.deliver(report()); assertSpeaking(element, empty); assert.equal(seen.length, 2);
  });

  it('permanently prunes lost membership and initially unmatched IDs until another complete report arrives', async t => {
    const state = speakingState(), { element, socket } = await socketJoinedWidget(t, state);
    for (const removal of ['missing', 'offstage', 'audience'] as const) {
      socket.deliver(report('host', 'speaker')); assertSpeaking(element, names('甲', '乙'));
      const changed = speakingState();
      if (removal === 'missing') changed.speakers.splice(1);
      else if (removal === 'offstage') changed.speakers[1]!.onStage = false;
      else changed.speakers[1]!.role = 'audience';
      socket.deliver({ type: 'room:state', ...changed }); assertSpeaking(element, names('甲'));
      socket.deliver({ type: 'room:state', ...state }); assertSpeaking(element, names('甲'));
      socket.deliver(report('speaker')); assertSpeaking(element, names('乙'));
      socket.deliver({ type: 'room:state', ...changed }); assertSpeaking(element, unmatched);
      socket.deliver({ type: 'room:state', ...state }); assertSpeaking(element, unmatched);
    }
    const offstage = speakingState(); offstage.speakers[1]!.role = 'audience'; offstage.speakers[1]!.onStage = false;
    socket.deliver({ type: 'room:state', ...offstage });
    socket.deliver(report('speaker', 'previously-unknown')); assertSpeaking(element, unmatched);
    const promoted = speakingState();
    promoted.speakers.push({ ...promoted.speakers[1]!, participantId: 'previously-unknown', name: '丙' });
    socket.deliver({ type: 'room:state', ...promoted }); assertSpeaking(element, unmatched);
    socket.deliver(report('speaker', 'previously-unknown')); assertSpeaking(element, names('乙', '丙'));
    socket.deliver(report()); socket.deliver({ type: 'room:state', ...state }); assertSpeaking(element, empty);
  });

  it('treats malformed synthetic reports as unknown rather than silence and leaves their forwarded detail untouched', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, speakingState());
    for (const detail of [undefined, null, {}, { participantIds: 'host' }, { participantIds: null },
      { participantIds: ['host', 1] }, { participantIds: [null] }, { participantIds: Array(1) }]) {
      socket.deliver(report('host')); assertSpeaking(element, names('甲'));
      const event = new CustomEvent('speaking', { detail });
      const observations: { detail: unknown; view: ReturnType<typeof view> }[] = [];
      element.addEventListener('stage-speaking', event => {
        observations.push({ detail: (event as CustomEvent).detail, view: view(element) });
      }, { once: true });
      client.dispatchEvent(event);
      assert.equal(observations.length, 1); assert.equal(observations[0]!.detail, event.detail);
      assert.deepEqual(observations[0]!.view, visible(unknown)); assertSpeaking(element, unknown);
      socket.deliver({ type: 'room:state', ...speakingState() }); assertSpeaking(element, unknown);
    }
    const detail = Object.freeze({ participantIds: Object.freeze(['host']) });
    client.dispatchEvent(new CustomEvent('speaking', { detail })); assertSpeaking(element, names('甲'));
  });

  it('keeps a copied report across own role, stage, waiting/live, microphone failure and local playback changes', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, speakingState());
    socket.deliver(report('speaker')); assertSpeaking(element, names('乙'));
    for (const onStage of [true, false]) {
      const state = speakingState(); state.me.role = 'controller'; state.me.onStage = onStage;
      state.me.muted = true; state.status = onStage ? 'waiting' : 'live';
      socket.deliver({ type: 'room:state', ...state }); assertSpeaking(element, names('乙'));
      client.dispatchEvent(new CustomEvent('micerror', { detail: { name: 'NotAllowedError', message: 'Mic denied' } }));
      assertSpeaking(element, names('乙'));
      client.dispatchEvent(new CustomEvent('micready', { detail: undefined }));
      element.playbackMuted = !element.playbackMuted; element.playbackVolume = 0;
      assertSpeaking(element, names('乙'));
    }
    socket.deliver({ type: 'stage:left', participantId: 'me', role: 'controller', reason: 'leave' });
    assertSpeaking(element, names('乙'));
  });

  it('copies complete primitive IDs before forwarding mutation and never changes raw detail identity', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, speakingState());
    const detail = { participantIds: ['speaker', 'host'] }, sdk: unknown[] = [];
    const observations: { detail: unknown; view: ReturnType<typeof view>; bubbles: boolean; composed: boolean }[] = [];
    client.on('speaking', event => sdk.push(event.detail));
    element.addEventListener('stage-speaking', event => {
      observations.push({ detail: (event as CustomEvent).detail, view: view(element), bubbles: event.bubbles, composed: event.composed });
      detail.participantIds.splice(0, 2, 'mutated-private-id');
    }, { once: true });
    client.dispatchEvent(new CustomEvent('speaking', { detail }));
    assert.equal(observations.length, 1); assert.equal(observations[0]!.detail, detail);
    assert.deepEqual(observations[0]!.view, visible(names('甲', '乙')));
    assert.equal(observations[0]!.bubbles, true); assert.equal(observations[0]!.composed, true);
    assert.equal(sdk[0], detail); assertSpeaking(element, names('甲', '乙'));
    socket.deliver({ type: 'room:state', ...speakingState() }); element.playbackMuted = true;
    assertSpeaking(element, names('甲', '乙')); assert.deepEqual(detail.participantIds, ['mutated-private-id']);
  });

  it('preserves a nested newer full report rather than restoring the outer speaking event', async t => {
    const { element, socket } = await socketJoinedWidget(t, speakingState());
    const observations: ReturnType<typeof view>[] = [];
    element.addEventListener('stage-speaking', () => {
      observations.push(view(element));
      if (observations.length === 1) socket.deliver(report('speaker'));
    });
    socket.deliver(report('host')); assert.deepEqual(observations, [visible(names('甲')), visible(names('乙'))]); assertSpeaking(element, names('乙'));
    socket.deliver({ type: 'room:state', ...speakingState() }); assertSpeaking(element, names('乙'));
  });

  it('projects authoritative state before host callbacks and preserves their nested newer report after the outer render', async t => {
    const { element, socket } = await socketJoinedWidget(t, speakingState());
    socket.deliver(report('host'));
    const renamed = speakingState(); renamed.speakers[0]!.name = '已改名'; renamed.status = 'waiting';
    const observations: ReturnType<typeof view>[] = [];
    element.addEventListener('stage-status', () => {
      observations.push(view(element)); socket.deliver(report('speaker')); observations.push(view(element));
    }, { once: true });
    element.addEventListener('stage-state', () => {
      observations.push(view(element)); socket.deliver(report()); observations.push(view(element));
    }, { once: true });
    socket.deliver({ type: 'room:state', ...renamed }); assertSpeaking(element, empty);
    assert.deepEqual(observations, [visible(names('已改名')), visible(names('乙')), visible(names('乙')), visible(empty)]);
  });

  it('clears before forwarding reconnect, ignores retired wire messages, and waits for a new seed despite the stale SDK getter', async t => {
    const state = speakingState(), { element, client, socket, sockets, hello, tick } = await socketJoinedWidget(t, state);
    socket.deliver(report('host')); const oldMessage = socket.onmessage;
    let reconnectingView: ReturnType<typeof view> | undefined;
    element.addEventListener('stage-status', event => { if ((event as CustomEvent).detail === 'reconnecting') reconnectingView = view(element); });
    socket.close(); assert.equal(client.status, 'reconnecting'); assertSpeaking(element);
    assert.deepEqual(reconnectingView, hidden);
    assert.deepEqual([...client.speaking], ['host']);
    let reports = 0; element.addEventListener('stage-speaking', () => { reports++; });
    oldMessage?.({ data: JSON.stringify(report('speaker')) }); assert.equal(reports, 0);
    await tick(500); const next = sockets[1]!, request = await hello(next);
    next.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' }); assertSpeaking(element, unknown);
    assert.deepEqual([...client.speaking], ['host'], 'resumed snapshot does not refresh the SDK speaking getter');
    next.deliver({ type: 'ok', requestId: request.requestId }); await settle(); assertSpeaking(element, unknown);
    next.deliver(report()); assertSpeaking(element, empty);
    oldMessage?.({ data: JSON.stringify(report('host')) }); assert.equal(reports, 1); assertSpeaking(element, empty);
  });

  for (const initialBeforeAck of [false, true]) {
    it(`requires a new report after public same-client same-ID disconnect/reentry${initialBeforeAck ? ' following pre-ACK loss and silent disconnect' : ''}`, async t => {
      const { element, sockets, hello, tick, joinRequest } = socketJoiningWidget(t); await settle();
      const socket = sockets[0]!, initial = await hello(socket), client = element.client!;
      socket.deliver({ type: 'room:state', ...speakingState() });
      if (!initialBeforeAck) { socket.deliver({ type: 'ok', requestId: initial.requestId }); await settle(); }
      socket.deliver(report('host')); assertSpeaking(element, names('甲'));
      if (initialBeforeAck) {
        assert.equal(client['session'], null); socket.close(); await settle();
        assert.equal(client.status, 'disconnected'); assert.ok(client.state); assertSpeaking(element);
      }
      const statuses: ReturnType<typeof view>[] = [];
      const disconnected = () => { statuses.push(view(element)); };
      element.addEventListener('stage-status', disconnected);
      await client.disconnect(); assert.equal(client.state, null); assertSpeaking(element);
      element.removeEventListener('stage-status', disconnected);
      assert.deepEqual(statuses, initialBeforeAck ? [] : [hidden], 'a duplicate disconnected status is silent');
      const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
      const joining = client.join({ roomId: 'one', name: 'Listener' }); await settle(); await tick(100);
      const request = joinRequest(next);
      next.deliver({ type: 'room:state', ...speakingState() }); assertSpeaking(element, unknown);
      next.deliver({ type: 'ok', requestId: request.requestId }); await joining; assertSpeaking(element, unknown);
      assert.equal(element.client, client); next.deliver(report('speaker')); assertSpeaking(element, names('乙'));
    });
  }

  for (const terminal of terminalCases) {
    it(`retires before ${terminal.title} callbacks and does not revive through same-client terminal reentry`, async t => {
      const { element, client, socket, sockets, tick, joinRequest } = await socketJoinedWidget(t, speakingState());
      socket.deliver(report('host')); const oldMessage = socket.onmessage;
      const callbacks: ReturnType<typeof view>[] = [];
      element.addEventListener('stage-status', event => { if ((event as CustomEvent).detail === 'disconnected') callbacks.push(view(element)); });
      element.addEventListener(`stage-${terminal.event}`, () => { callbacks.push(view(element)); });
      socket.deliver(terminal.message); await settle(); assert.deepEqual(callbacks, [hidden, hidden]); assertSpeaking(element);
      assert.equal(element['status'].textContent, terminal.text);
      const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
      const joining = client.join({ roomId: 'one', name: 'Listener' }); await settle(); await tick(100);
      const request = joinRequest(next); next.deliver({ type: 'room:state', ...speakingState() }); assertSpeaking(element, unknown);
      next.deliver({ type: 'ok', requestId: request.requestId }); await joining;
      next.deliver(report('speaker')); assertSpeaking(element, names('乙'));
      oldMessage?.({ data: JSON.stringify(report('host')) }); assertSpeaking(element, names('乙'));
    });
  }

  it('replaces ownership on room or self identity changes before forwarded status/state and never revives old reports', async t => {
    const { element, socket } = await socketJoinedWidget(t, speakingState());
    for (const identity of ['room', 'self'] as const) {
      socket.deliver(report('host')); assertSpeaking(element, names('甲'));
      const state = speakingState(); state.status = 'waiting';
      if (identity === 'room') state.roomId = 'different'; else state.me.participantId = 'different';
      const callbacks: ReturnType<typeof view>[] = [];
      for (const event of ['stage-status', 'stage-state']) element.addEventListener(event, () => { callbacks.push(view(element)); }, { once: true });
      socket.deliver({ type: 'room:state', ...state }); assert.deepEqual(callbacks, [visible(unknown), visible(unknown)]); assertSpeaking(element, unknown);
      socket.deliver({ type: 'room:state', ...speakingState() }); assertSpeaking(element, unknown);
    }
  });

  for (const action of ['attribute replacement', 'detach/remount', 'manual leave/rejoin'] as const) {
    it(`retires synchronously during ${action} from a forwarded report and rejects the old client lane`, async t => {
      const { element, client, socket, sockets, hello } = await socketJoinedWidget(t, speakingState());
      const node = speakingNode(element), oldMessage = socket.onmessage;
      const observations: ReturnType<typeof view>[] = [];
      element.addEventListener('stage-speaking', () => {
        observations.push(view(element));
        if (action === 'attribute replacement') element.setAttribute('room', 'two');
        else if (action === 'detach/remount') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
        else click(element['roomAction']);
        observations.push(view(element));
      }, { once: true });
      socket.deliver(report('host')); await settle(); assertSpeaking(element);
      assert.deepEqual(observations, [visible(names('甲')), hidden]);
      if (action === 'detach/remount') { Object.assign(element, { isConnected: true }); element.connectedCallback(); }
      else if (action === 'manual leave/rejoin') { assert.equal(element['status'].textContent, '已離開房間。'); click(element['roomAction']); }
      await settle(); const next = sockets[1]!, request = await hello(next), state = speakingState();
      if (action === 'attribute replacement') state.roomId = 'two';
      next.deliver({ type: 'room:state', ...state }); assertSpeaking(element, unknown);
      next.deliver({ type: 'ok', requestId: request.requestId }); await settle(); next.deliver(report('speaker'));
      assertSpeaking(element, names('乙')); assert.notEqual(element.client, client); assert.equal(speakingNode(element), node);
      let callbacks = 0; element.addEventListener('stage-speaking', () => { callbacks++; });
      oldMessage?.({ data: JSON.stringify(report('host')) });
      client.dispatchEvent(new CustomEvent('speaking', { detail: { participantIds: ['host'] } }));
      assert.equal(callbacks, 0); assertSpeaking(element, names('乙'));
    });
  }

  it('does not affect pending controls, drafts, unrelated errors, requests, media or timers as reports replace each other', async t => {
    const state = speakingState(); state.me.role = 'speaker'; state.me.onStage = true;
    const { element, client, socket, tick } = await socketJoinedWidget(t, state);
    element['nameInput'].value = 'Unsent draft'; click(element['nameUpdate']); click(element['mic']); await tick(200);
    const rename = socket.sent.find(message => message.type === 'participant:rename');
    const mute = socket.sent.find(message => message.type === 'mic:mute'); assert.ok(rename); assert.ok(mute);
    socket.deliver({ type: 'error', code: 'conflict', message: 'Existing unrelated error' });
    const before = nonSpeaking(element), frames = [...socket.sent], pending = client['pending'].size, attempt = element['nameAttempt'];
    const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
    const media = t.mock.method(client as unknown as { createMedia(): void }, 'createMedia', () => assert.fail('speaking must not start media'));
    for (const message of [report('host'), report(), report('unknown'), report('speaker')]) socket.deliver(message);
    assertSpeaking(element, names('乙')); assert.deepEqual(nonSpeaking(element), before);
    assert.deepEqual(socket.sent, frames); assert.equal(client['pending'].size, pending); assert.equal(element['nameAttempt'], attempt);
    assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0); assert.equal(media.mock.callCount(), 0);
    socket.deliver({ type: 'ok', requestId: rename.requestId }); socket.deliver({ type: 'ok', requestId: mute.requestId }); await settle();
    assert.equal(client['pending'].size, 0); assertSpeaking(element, names('乙'));
  });
});

describe('widget explicit error dismissal', () => {
  type Widget = InstanceType<typeof StageElement>;
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  function view(element: Widget) {
    return { hidden: element['error'].hidden, dismissHidden: element['errorDismiss'].hidden,
      dismissDisabled: element['errorDismiss'].disabled, text: element['error'].textContent, revision: element['errorRevision'] };
  }
  function assertHidden(element: Widget, hidden: boolean): void {
    assert.equal(element['error'].hidden, hidden, 'error visibility');
    assert.equal(element['errorDismiss'].hidden, hidden, 'dismiss visibility follows the error');
    assert.equal(element['errorDismiss'].disabled, hidden, 'only a visible dismissal is enabled');
    assert.equal(element['errorDismiss'].getAttribute('aria-busy'), null, 'dismissal has no pending operation');
  }
  function otherView(element: Widget) {
    return nodes(element as unknown as Node).filter(node => node !== (element['error'] as unknown as Node)
      && node !== (element['errorDismiss'] as unknown as Node) && node.tagName !== 'STYLE')
      .map(node => [node.tagName, node.textContent, node.hidden, node.disabled, node.value, [...node.attributes]]);
  }
  function errorEvent(client: StageClient, detail: unknown = new Error('Current failure')): void {
    client.dispatchEvent(new CustomEvent('error', { detail }));
  }
  function micError(client: StageClient): void {
    client.dispatchEvent(new CustomEvent('micerror', { detail: { name: 'NotReadableError', message: 'Current capture failure' } }));
  }

  it('starts with a hidden native button beside the unchanged alert and outside live-region ancestors', () => {
    const element = new StageElement(); widgets.push(element);
    const all = nodes(element as unknown as Node), error = element['error'] as unknown as Node;
    const dismiss = element['errorDismiss'] as unknown as Node;
    assertHidden(element, true); assert.equal(element['errorRevision'], 0); assert.equal(error.textContent, '');
    assert.equal(dismiss.tagName, 'BUTTON'); assert.equal(dismiss.type, 'button'); assert.equal(dismiss.textContent, '關閉錯誤訊息');
    assert.equal(dismiss.part.has('error-dismiss'), true);
    assert.equal(dismiss.getAttribute('role'), null); assert.equal(dismiss.getAttribute('aria-live'), null);
    assert.equal(error.tagName, 'P'); assert.equal(error.getAttribute('role'), 'alert'); assert.deepEqual(error.children, []);
    const parent = all.find(node => node.children.includes(error)); assert.ok(parent);
    assert.ok(parent.children.includes(dismiss)); assert.equal(parent.children.indexOf(dismiss), parent.children.indexOf(error) + 1);
    const ancestors = (node: Node): Node[] | undefined => node === dismiss ? []
      : node.children.map(child => ancestors(child)).find(path => path !== undefined)?.concat(node);
    const path = ancestors(element as unknown as Node); assert.ok(path);
    assert.ok(path.every(node => !node.hasAttribute('aria-live') && !['status', 'alert', 'log'].includes(node.getAttribute('role') ?? '')));
    assert.equal(all.filter(node => node === dismiss).length, 1);
    click(element['errorDismiss']); assertHidden(element, true); assert.equal(element['errorRevision'], 0);
  });

  it('dismisses only presentation, keeps literal error text and raw event identity, and shows every later error', async t => {
    const { element, client } = await subscribedWidget(t);
    const detail = { message: '<img src=x onerror=alert(1)> &amp; "private"', code: 'conflict' };
    const forwarded: { detail: unknown; bubbles: boolean; composed: boolean; shown: ReturnType<typeof view> }[] = [];
    element.addEventListener('stage-error', event => forwarded.push({ detail: (event as CustomEvent).detail,
      bubbles: event.bubbles, composed: event.composed, shown: view(element) }));
    errorEvent(client, detail);
    assertHidden(element, false); assert.equal(element['error'].textContent, detail.message);
    assert.deepEqual((element['error'] as unknown as Node).children, []); assert.equal(Reflect.get(element['error'], 'innerHTML'), undefined);
    assert.equal(forwarded.length, 1); assert.equal(forwarded[0]!.detail, detail);
    assert.equal(forwarded[0]!.bubbles, true); assert.equal(forwarded[0]!.composed, true); assert.equal(forwarded[0]!.shown.hidden, false);
    const before = otherView(element), revision = element['errorRevision'], generation = element['generation'];
    const state = client.state, timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
    const connect = t.mock.method(client, 'connect'), disconnect = t.mock.method(client, 'disconnect');
    click(element['errorDismiss']);
    assertHidden(element, true); assert.equal(element['error'].textContent, detail.message); assert.equal(element['errorRevision'], revision);
    assert.deepEqual(otherView(element), before); assert.equal(element['generation'], generation); assert.equal(element.client, client); assert.equal(client.state, state);
    assert.equal(connect.mock.callCount(), 0); assert.equal(disconnect.mock.callCount(), 0);
    assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0); assert.equal(forwarded.length, 1);
    element['render'](); await client['receive']({ type: 'room:state', ...roomState() });
    assertHidden(element, true); assert.equal(element['errorRevision'], revision);
    errorEvent(client, detail); assertHidden(element, false); assert.equal(element['errorRevision'], revision + 1);
    assert.equal(forwarded[1]!.detail, detail, 'even the same error object can be shown again');
    click(element['errorDismiss']); errorEvent(client, 'unstructured failure');
    assertHidden(element, false); assert.equal(element['error'].textContent, '操作失敗。');
    assert.equal(forwarded[2]!.detail, 'unstructured failure');
  });

  it('dismisses a settled real command rejection without issuing a retry or changing room state', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t);
    click(element['hand']); await tick(100);
    const request = socket.sent.find(message => message.type === 'hand:raise'); assert.ok(request);
    socket.deliver({ type: 'error', code: 'forbidden', message: 'Control request rejected', requestId: request.requestId }); await settle();
    assertHidden(element, false); assert.equal(element['error'].textContent, 'Control request rejected'); assert.equal(client['pending'].size, 0);
    const before = otherView(element), frames = [...socket.sent], revision = element['errorRevision'];
    click(element['errorDismiss']);
    assertHidden(element, true); assert.equal(element['errorRevision'], revision); assert.equal(element['error'].textContent, 'Control request rejected');
    assert.deepEqual(otherView(element), before); assert.deepEqual(socket.sent, frames); assert.equal(client.me!.handRaised, false);
    await tick(1000); assertHidden(element, true); assert.deepEqual(socket.sent, frames);
  });

  it('allows the same real request catch to show again after its earlier SDK error event was dismissed', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t);
    click(element['hand']); await tick(100);
    const request = socket.sent.find(message => message.type === 'hand:raise'); assert.ok(request);
    const observations: { detail: unknown; before: ReturnType<typeof view>; after: ReturnType<typeof view> }[] = [];
    const sdkDetails: unknown[] = []; client.on('error', ({ detail }) => sdkDetails.push(detail));
    element.addEventListener('stage-error', event => {
      const before = view(element); click(element['errorDismiss']);
      observations.push({ detail: (event as CustomEvent).detail, before, after: view(element) });
    });
    socket.deliver({ type: 'error', code: 'forbidden', message: 'One request failure', requestId: request.requestId });
    assert.equal(observations.length, 1); assert.equal(observations[0]!.before.hidden, false); assert.equal(observations[0]!.after.hidden, true);
    assert.equal(sdkDetails.length, 1); assert.equal(observations[0]!.detail, sdkDetails[0]);
    assert.equal(observations[0]!.after.dismissHidden, true); assert.equal(observations[0]!.before.revision, observations[0]!.after.revision);
    assertHidden(element, true); await settle();
    assertHidden(element, false); assert.equal(element['error'].textContent, 'One request failure');
    assert.equal(element['errorRevision'], observations[0]!.after.revision + 1, 'dismissal does not deduplicate a later show from the command catch');
    assert.equal(observations.length, 1, 'the catch does not synthesize another SDK error event'); assert.equal(client['pending'].size, 0);
    click(element['errorDismiss']); assertHidden(element, true);
  });

  it('retains initial-entry retry and failure status after dismissal without reconnecting or cancelling', async t => {
    const { element, connections, joins } = deferredJoiningWidget(t); await settle();
    assert.equal(connections.length, 1); connections[0]!.pending.reject(new Error('Initial connection rejected')); await settle();
    assertHidden(element, false); assert.equal(element['retry'].hidden, false); assert.equal(element['retry'].disabled, false);
    const before = otherView(element), client = element.client, generation = element['generation'];
    click(element['errorDismiss']); await settle();
    assertHidden(element, true); assert.deepEqual(otherView(element), before); assert.equal(element.client, client); assert.equal(element['generation'], generation);
    assert.equal(connections.length, 1); assert.equal(joins.length, 0); assert.equal(element['error'].textContent, 'Initial connection rejected');
  });

  for (const terminal of terminalCases) {
    it(`keeps the ${terminal.title} notice and retired room controls after dismissing a retained error`, async t => {
      const { element, client, socket, sockets } = await socketJoinedWidget(t);
      socket.deliver({ type: 'error', code: 'conflict', message: 'Retained terminal failure' }); socket.deliver(terminal.message); await settle();
      assertHidden(element, false); assert.equal(element['status'].textContent, terminal.text); assertRoomControlsHidden(element);
      const before = otherView(element), frames = [...socket.sent], revision = element['errorRevision'];
      click(element['errorDismiss']); await settle();
      assertHidden(element, true); assert.deepEqual(otherView(element), before); assert.equal(element['errorRevision'], revision);
      assert.equal(element['status'].textContent, terminal.text); assert.equal(client.state, null); assert.equal(client.status, 'disconnected');
      assert.equal(element['retry'].hidden, true); assert.equal(sockets.length, 1); assert.deepEqual(socket.sent, frames);
    });
  }

  for (const control of ['hand', 'mic'] as const) {
    it(`keeps an unrelated pending ${control} request busy and lets a later rejection become visible`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t, roomState(control === 'mic'));
      click(element[control]); await tick(100);
      const request = socket.sent.find(message => message.type === (control === 'mic' ? 'mic:mute' : 'hand:raise')); assert.ok(request && 'requestId' in request);
      socket.deliver({ type: 'error', code: 'conflict', message: 'Unrelated pending-control error' });
      const before = otherView(element), frames = [...socket.sent], pending = [...element['pendingActions']], size = client['pending'].size;
      const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
      click(element['errorDismiss']);
      assertHidden(element, true); assert.deepEqual(otherView(element), before); assert.deepEqual([...element['pendingActions']], pending);
      assert.equal(element[control].disabled, true); assert.equal(element[control].getAttribute('aria-busy'), 'true');
      assert.equal(client['pending'].size, size); assert.deepEqual(socket.sent, frames);
      assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0);
      socket.deliver({ type: 'error', code: 'forbidden', message: 'Later pending request rejection', requestId: request.requestId }); await settle();
      assertHidden(element, false); assert.equal(element['error'].textContent, 'Later pending request rejection');
      assert.equal(client['pending'].size, 0); assert.equal(element['pendingActions'].has(element[control]), false);
      assert.equal(element[control].getAttribute('aria-busy'), null);
    });
  }

  it('keeps a new nested error when a forwarded error callback dismisses its predecessor', async t => {
    const { element, client } = await subscribedWidget(t);
    const first = new Error('Outer error'), next = new Error('Nested new error');
    const observations: ReturnType<typeof view>[] = [], details: unknown[] = [];
    element.addEventListener('stage-error', event => details.push((event as CustomEvent).detail));
    element.addEventListener('stage-error', () => {
      observations.push(view(element)); click(element['errorDismiss']); observations.push(view(element)); errorEvent(client, next);
    }, { once: true });
    errorEvent(client, first);
    assert.equal(observations.length, 2); assert.equal(observations[0]!.hidden, false); assert.equal(observations[1]!.hidden, true);
    assert.equal(observations[0]!.revision, observations[1]!.revision); assert.deepEqual(details, [first, next]);
    assertHidden(element, false); assert.equal(element['error'].textContent, next.message);
    assert.equal(element['errorRevision'], observations[1]!.revision + 1);
  });

  it('shows a new synchronous retry exception after its SDK callback dismisses the prior microphone error', async t => {
    const { element, client } = await subscribedWidget(t, true); micError(client);
    const revision = element['errorRevision'], observations: ReturnType<typeof view>[] = [];
    const retry = t.mock.method(client, 'retryMicrophone', () => {
      observations.push(view(element)); click(element['errorDismiss']); observations.push(view(element));
      throw new Error('New synchronous retry failure');
    });
    click(element['micRetry']);
    assert.equal(retry.mock.callCount(), 1); assert.equal(observations.length, 2);
    assert.equal(observations[0]!.revision, revision); assert.equal(observations[1]!.revision, revision);
    assert.equal(observations[1]!.hidden, true); assert.equal(observations[1]!.dismissHidden, true);
    assertHidden(element, false); assert.equal(element['error'].textContent, 'New synchronous retry failure');
    assert.equal(element['errorRevision'], revision + 1); assert.equal(element['micFailure']!.errorRevision, revision + 1);
    assert.equal(element['micFailure']!.pending, false); assert.equal(element['micRetry'].hidden, false); assert.equal(element['micRetry'].disabled, false);
  });

  for (const newer of [false, true]) {
    for (const dismissed of [false, true]) {
      it(`preserves natural micready ownership with ${newer ? 'a newer independent' : 'its own'} ${dismissed ? 'dismissed' : 'visible'} error`, async t => {
        const { element, client } = await subscribedWidget(t, true); micError(client);
        if (newer) errorEvent(client, new Error('Newer unrelated control failure'));
        const failure = element['micFailure'], revision = element['errorRevision'], text = element['error'].textContent;
        if (dismissed) click(element['errorDismiss']);
        assert.equal(element['micFailure'], failure); assert.equal(element['errorRevision'], revision);
        const observations: ReturnType<typeof view>[] = [];
        element.addEventListener('stage-micready', () => observations.push(view(element)));
        client.dispatchEvent(new CustomEvent('micready', { detail: undefined }));
        assertHidden(element, dismissed || !newer); assert.equal(observations.length, 1);
        assert.equal(observations[0]!.hidden, dismissed || !newer); assert.equal(observations[0]!.dismissHidden, dismissed || !newer);
        assert.equal(element['errorRevision'], revision); assert.equal(element['error'].textContent, text);
        assert.equal(element['micFailure'], undefined); assert.equal(element['micRetry'].hidden, true);
      });
    }
  }

  for (const guard of ['hidden button', 'hidden alert', 'detached', 'unmounted'] as const) {
    it(`does nothing on a direct dismissal handler invocation with a ${guard}`, async t => {
      const { element, client } = await subscribedWidget(t); errorEvent(client);
      if (guard === 'hidden button') element['errorDismiss'].hidden = true;
      else if (guard === 'hidden alert') element['error'].hidden = true;
      else {
        Object.assign(element, { isConnected: false });
        if (guard === 'unmounted') { element.disconnectedCallback(); await settle(); }
      }
      const before = view(element), other = otherView(element), generation = element['generation'];
      click(element['errorDismiss']); await settle();
      assert.deepEqual(view(element), before); assert.deepEqual(otherView(element), other); assert.equal(element['generation'], generation);
    });
  }

  for (const transition of ['attribute rejoin', 'unmount and remount'] as const) {
    it(`isolates old errors, readiness and deferred command rejection after ${transition}`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const pending = deferred(); t.mock.method(client, 'mute', () => pending.promise);
      t.after(async () => { pending.resolve(); await settle(); });
      click(element['mic']); errorEvent(client, new Error('Retired failure')); click(element['errorDismiss']);
      if (transition === 'attribute rejoin') element.setAttribute('name', 'Replacement');
      else {
        Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await settle();
        Object.assign(element, { isConnected: true }); element.connectedCallback();
      }
      await settle();
      const replacement = element.client; assert.ok(replacement); assert.notEqual(replacement, client);
      await replacement['receive']({ type: 'room:state', ...roomState(true) });
      const detail = new Error('Current same-ID failure'), forwarded: unknown[] = [];
      element.addEventListener('stage-error', event => forwarded.push((event as CustomEvent).detail));
      errorEvent(replacement, detail); const before = view(element), other = otherView(element);
      errorEvent(client, new Error('Retired client error')); micError(client); client.dispatchEvent(new CustomEvent('micready', { detail: undefined }));
      pending.reject(new Error('Retired command rejection')); await settle();
      assert.deepEqual(view(element), before); assert.deepEqual(otherView(element), other); assert.deepEqual(forwarded, [detail]);
      click(element['errorDismiss']); assertHidden(element, true); assert.equal(element.client, replacement);
      errorEvent(replacement, detail); assertHidden(element, false);
    });
  }

  for (const action of ['hand', 'participant name', 'room name', 'playback unlock', 'leave room', 'attribute rejoin',
    'initial retry', 'initial cancel', 'microphone retry', 'microphone ready'] as const) {
    it(`hides the dismissal together with its existing error clear on ${action}`, async t => {
      let element: Widget, client: StageClient;
      if (action === 'initial retry' || action === 'initial cancel') {
        const fixture = deferredJoiningWidget(t); element = fixture.element; await settle();
        client = fixture.connections[0]!.client;
        if (action === 'initial retry') { fixture.connections[0]!.pending.reject(new Error('Retryable initial failure')); await settle(); }
      } else ({ element, client } = await subscribedWidget(t, action.startsWith('microphone')));
      if (action === 'room name') {
        const state = roomState(); state.me.role = 'controller'; await client['receive']({ type: 'room:state', ...state });
      }
      if (action.startsWith('microphone')) micError(client); else errorEvent(client);
      if (action === 'playback unlock') client.dispatchEvent(new CustomEvent('audioblocked', { detail: { message: 'Blocked playback' } }));
      assertHidden(element, false); const text = element['error'].textContent, revision = element['errorRevision'];
      if (action === 'hand') { t.mock.method(client, 'raiseHand', async () => {}); click(element['hand']); }
      else if (action === 'participant name') { t.mock.method(client, 'setName', async () => {}); click(element['nameUpdate']); }
      else if (action === 'room name') { t.mock.method(client, 'setRoomName', async () => {}); click(element['roomNameUpdate']); }
      else if (action === 'playback unlock') { t.mock.method(client, 'unlockAudio', async () => {}); click(element['unlock']); }
      else if (action === 'leave room') click(element['roomAction']);
      else if (action === 'attribute rejoin') element.setAttribute('name', 'Replacement');
      else if (action === 'initial retry') click(element['retry']);
      else if (action === 'initial cancel') click(element['cancelJoin']);
      else if (action === 'microphone retry') { t.mock.method(client, 'retryMicrophone', () => true); click(element['micRetry']); }
      else client.dispatchEvent(new CustomEvent('micready', { detail: undefined }));
      await settle(); assertHidden(element, true); assert.equal(element['error'].textContent, text); assert.equal(element['errorRevision'], revision);
    });
  }
});

describe('widget controller hand request panel', () => {
  type Widget = InstanceType<typeof StageElement>;
  type ModerationRequest = Extract<ClientMessage, { type: 'stage:approve' | 'stage:reject' }>;
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  const text = (node: Node): string => [node.textContent, ...node.children.map(text)].join(' ');
  const visibleText = (node: Node): string => node.hidden ? '' : [node.textContent, ...node.children.map(visibleText)].join(' ');
  function panel(element: Widget): Node {
    const matches = nodes(element as unknown as Node).filter(node => node.part.has('hands'));
    assert.equal(matches.length, 1, 'one native disclosure is exposed through ::part(hands)');
    assert.equal(matches[0]!.tagName, 'DETAILS');
    return matches[0]!;
  }
  function queue(element: Widget) {
    const disclosure = panel(element);
    const summary = disclosure.children.find(node => node.tagName === 'SUMMARY');
    const list = disclosure.children.find(node => node.tagName === 'UL');
    const empty = disclosure.children.find(node => node.tagName === 'P');
    assert.ok(summary && list && empty, 'native summary, list and ordinary empty paragraph');
    assert.equal(empty.getAttribute('aria-live'), null);
    assert.equal(empty.getAttribute('role'), null);
    return { disclosure, summary, list, empty, rows: list.children };
  }
  function buttons(row: Node) {
    assert.equal(row.tagName, 'LI');
    const found = nodes(row).filter(node => node.tagName === 'BUTTON');
    assert.equal(found.length, 2, 'each request has only approve and reject');
    for (const button of found) assert.equal(button.type, 'button');
    const approve = found.find(button => /核准|同意|批准/.test(button.textContent));
    const reject = found.find(button => /拒/.test(button.textContent));
    assert.ok(approve && reject);
    return { approve, reject };
  }
  function press(button: Node): void { button.onclick?.(); }
  function force(button: Node): void { const disabled = button.disabled; button.disabled = false; press(button); button.disabled = disabled; }
  function busy(row: Node, expected: boolean, disabled = expected): void {
    for (const button of Object.values(buttons(row))) {
      assert.equal(button.disabled, disabled);
      assert.equal(button.getAttribute('aria-busy') === 'true', expected);
    }
  }
  function retired(element: Widget): void {
    const { disclosure, list } = queue(element);
    assert.equal(disclosure.hidden, true); assert.equal(disclosure.open, false);
    assert.deepEqual(list.children, [], 'retirement clears private request rows');
    assert.doesNotMatch(text(disclosure), /Private queued|Unraised secret/);
  }
  function state(ids = ['first', 'second'], onStage = false, roomId = 'one'): RoomStatePayload {
    const snapshot = controllerState(onStage, roomId);
    snapshot.hands = ids.map((participantId, index) => ({ ...roomState().me, participantId,
      name: `Private queued ${participantId}`, handRaised: true, joinedAt: 100 - index }));
    return snapshot;
  }
  function request(socket: { sent: ClientMessage[] }, type?: ModerationRequest['type']): ModerationRequest {
    const message = socket.sent.filter((message): message is ModerationRequest =>
      (message.type === 'stage:approve' || message.type === 'stage:reject') && (!type || message.type === type)).at(-1);
    assert.ok(message); return message;
  }
  function error(socket: { deliver(message: ServerMessage): void }, message = 'Existing widget error'): void {
    socket.deliver({ type: 'error', code: 'conflict', message });
  }

  /** Observe only mounted hand-row setters/methods, not render calls or elapsed time. */
  function rowWrites(t: TestContext, rows: Node[]) {
    const writes = { text: 0, attribute: 0, disabled: 0 }, changes = { ...writes };
    for (const row of rows) {
      const name = row.children.find(node => node.tagName === 'SPAN'); assert.ok(name);
      let label = name.textContent;
      Object.defineProperty(name, 'textContent', { configurable: true, get: () => label, set: (value: string) => {
        writes.text++; if (label !== value) changes.text++; label = value;
      } });
      t.after(() => { Object.defineProperty(name, 'textContent', { configurable: true, writable: true, value: label }); });
      for (const button of Object.values(buttons(row))) {
        let disabled = button.disabled;
        Object.defineProperty(button, 'disabled', { configurable: true, get: () => disabled, set: (value: boolean) => {
          writes.disabled++; if (disabled !== value) changes.disabled++; disabled = value;
        } });
        t.after(() => { Object.defineProperty(button, 'disabled', { configurable: true, writable: true, value: disabled }); });
        const setAttribute = button.setAttribute;
        t.mock.method(button, 'setAttribute', function (this: Node, key: string, value: string): void {
          if (key === 'aria-label' || key === 'aria-busy') {
            writes.attribute++; if (this.getAttribute(key) !== value) changes.attribute++;
          }
          setAttribute.call(this, key, value);
        });
      }
    }
    const reset = () => { for (const key of ['text', 'attribute', 'disabled'] as const) writes[key] = changes[key] = 0; };
    const expect = (text = 0, attribute = 0, disabled = 0) => {
      assert.deepEqual({ ...writes }, { text, attribute, disabled }, 'only necessary current-value hand-row writes');
      assert.deepEqual({ ...changes }, { ...writes }, 'each guarded write changes its current DOM value');
      reset();
    };
    const snapshot = () => ({ writes: { ...writes }, changes: { ...changes } });
    return { writes, changes, reset, expect, snapshot };
  }

  for (const shape of [
    { hands: 20, speakers: 8, audience: 40 }, { hands: 20, speakers: 8, audience: 292 },
    { hands: 292, speakers: 8, audience: 292 }, { hands: 300, speakers: 0, audience: 300 },
  ]) {
    it(`hand-row writes: skips unchanged actual Room/SDK events for ${shape.hands} hands among ${shape.speakers + shape.audience + 1} participants`, async t => {
      const room = new Room({ roomId: 'one', name: 'Room', code: '', codeRequired: false, now: 0,
        limits: { maxSpeakers: 8, maxAudience: 300 }, controller: { participantId: 'me', name: 'Host', resumeToken: 'host-token' } });
      for (let i = 0; i < shape.speakers; i++) {
        const participantId = `speaker-${i}`;
        room.join({ participantId, name: `Speaker ${i}`, resumeToken: `token-${participantId}` }, i + 1);
        room.raiseHand(participantId); room.approve('me', participantId, i + 1);
      }
      for (let i = 0; i < shape.audience; i++) {
        const participantId = `audience-${i}`;
        room.join({ participantId, name: `Listener ${i} &amp; safe`, resumeToken: `token-${participantId}` }, i + 10);
        if (i < shape.hands) room.raiseHand(participantId);
      }
      const { element, socket, client } = await socketJoinedWidget(t, room.snapshot('me'));
      const original = [...queue(element).rows], observed = rowWrites(t, original);
      const replaceRows = t.mock.method(queue(element).list, 'replaceChildren');
      let states = 0, mics = 0;
      element.addEventListener('stage-state', () => { states++; });
      element.addEventListener('stage-mic', () => { mics++; });
      for (let i = 0; i < 100; i++) {
        for (const event of i % 2 ? room.unmute('me') : room.mute('me')) socket.deliver(event);
        socket.deliver({ type: 'room:state', ...room.snapshot('me') });
      }
      observed.expect();
      assert.equal(states, 100); assert.equal(mics, 100, 'event forwarding is not skipped');
      assert.deepEqual(queue(element).rows, original); assert.equal(replaceRows.mock.callCount(), 0);
      assert.equal(client.state!.hands.length, shape.hands); room.assertInvariants();
    });
  }

  it('hand-row writes: updates decoded names and offline text without rewriting unchanged controls', async t => {
    const initial = state(), { element, socket } = await socketJoinedWidget(t, initial);
    const first = queue(element).rows[0]!, observed = rowWrites(t, [first]), other = rowWrites(t, [queue(element).rows[1]!]);
    const next = structuredClone(initial); next.hands[0]!.name = 'Renamed &lt;safe&gt; &amp; text';
    socket.deliver({ type: 'room:state', ...next }); observed.expect(1, 2); other.expect();
    assert.equal(first.children[0]!.textContent, 'Renamed <safe> & text');
    assert.equal(buttons(first).approve.getAttribute('aria-label'), '核准 Renamed <safe> & text 上台');
    assert.equal(buttons(first).reject.getAttribute('aria-label'), '婉拒 Renamed <safe> & text 的舉手申請');
    next.hands[0]!.connected = false;
    socket.deliver({ type: 'room:state', ...next }); observed.expect(1); other.expect();
    assert.equal(first.children[0]!.textContent, 'Renamed <safe> & text（暫時離線）'); busy(first, false);
    next.hands[0]!.name = 'Renamed <safe> & text';
    socket.deliver({ type: 'room:state', ...next }); observed.expect(); other.expect();
    next.hands[0]!.connected = true;
    socket.deliver({ type: 'room:state', ...next }); observed.expect(1); other.expect();
  });

  for (const action of ['approve', 'reject'] as const) for (const outcome of ['ok', 'error'] as const) {
    it(`hand-row writes: changes only pending ${action} controls through actual SDK ${outcome} settlement`, async t => {
      const { element, socket, tick } = await socketJoinedWidget(t, state());
      const first = queue(element).rows[0]!, observed = rowWrites(t, [first]), other = rowWrites(t, [queue(element).rows[1]!]);
      press(buttons(first)[action]); observed.expect(0, 2, 2); other.expect(); busy(first, true);
      socket.deliver({ type: 'room:state', ...state() }); observed.expect(); other.expect();
      await tick(100); const sent = request(socket); assert.equal(sent.type, `stage:${action}`);
      if (outcome === 'ok') socket.deliver({ type: 'ok', requestId: sent.requestId });
      else socket.deliver({ type: 'error', requestId: sent.requestId, code: 'conflict', message: 'Try again' });
      await settle(); observed.expect(0, 2, 2); other.expect(); busy(first, false);
      socket.deliver({ type: 'room:state', ...state() }); observed.expect(); other.expect();
    });
  }

  it('hand-row writes: preserves pending/reconnection policy and updates only changed values on resume', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, state());
    const first = queue(element).rows[0]!, pending = deferred();
    t.mock.method(client, 'approve', () => pending.promise);
    const observed = rowWrites(t, [...queue(element).rows]);
    press(buttons(first).approve); observed.expect(0, 2, 2);
    socket.close(); await settle(); observed.expect(0, 0, 2);
    busy(first, true); busy(queue(element).rows[1]!, false, true);
    pending.resolve(); await settle(); observed.expect(0, 2);
    busy(first, false, true);
    await tick(500); const next = sockets[1]!, resume = await hello(next); observed.expect();
    next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: resume.requestId });
    await settle(); observed.expect(0, 0, 4); busy(first, false); busy(queue(element).rows[1]!, false);
    assert.equal(queue(element).rows[0], first);
    next.deliver({ type: 'room:state', ...state() }); observed.expect();
  });

  it('hand-row writes: retains row order/removal behavior without rewriting surviving rows', async t => {
    const { element, socket } = await socketJoinedWidget(t, state());
    const [first, second] = queue(element).rows; assert.ok(first && second);
    const removed = rowWrites(t, [first]), survivor = rowWrites(t, [second]);
    const replacements = t.mock.method(queue(element).list, 'replaceChildren');
    socket.deliver({ type: 'room:state', ...state(['second', 'first']) });
    removed.expect(); survivor.expect(); assert.deepEqual(queue(element).rows, [second, first]);
    assert.equal(replacements.mock.callCount(), 1);
    socket.deliver({ type: 'room:state', ...state(['second']) });
    survivor.expect(); assert.deepEqual(queue(element).rows, [second]); assert.equal(replacements.mock.callCount(), 2);
    // Retirement deliberately keeps its existing unconditional safety writes outside the guarded loop.
    assert.deepEqual(removed.writes, { text: 0, attribute: 2, disabled: 2 });
    assert.deepEqual(removed.changes, { text: 0, attribute: 0, disabled: 2 }); removed.reset();
    busy(first, false, true);
    socket.deliver({ type: 'room:state', ...state() });
    removed.expect(); survivor.expect(); assert.equal(queue(element).rows[1], second); assert.notEqual(queue(element).rows[0], first);
  });

  it('hand-row writes: repairs all seven host-edited DOM values on an otherwise unchanged snapshot', async t => {
    const initial = state(), { element, socket } = await socketJoinedWidget(t, initial);
    const first = queue(element).rows[0]!, observed = rowWrites(t, [first]), other = rowWrites(t, [queue(element).rows[1]!]);
    first.children[0]!.textContent = 'Host-edited label';
    for (const button of Object.values(buttons(first))) {
      button.setAttribute('aria-label', 'Host-edited action'); button.disabled = true; button.removeAttribute('aria-busy');
    }
    observed.reset(); socket.deliver({ type: 'room:state', ...initial });
    observed.expect(1, 4, 2); other.expect(); busy(first, false);
    assert.equal(first.children[0]!.textContent, 'Private queued first');
    assert.equal(buttons(first).approve.getAttribute('aria-label'), '核准 Private queued first 上台');
    assert.equal(buttons(first).reject.getAttribute('aria-label'), '婉拒 Private queued first 的舉手申請');
    socket.deliver({ type: 'room:state', ...initial }); observed.expect(); other.expect();
  });

  it('hand-row writes: reconciles same-snapshot and DOM mutations after a forwarded callback', async t => {
    const initial = state(), { element, client, socket } = await socketJoinedWidget(t, initial);
    const first = queue(element).rows[0]!, observed = rowWrites(t, [first]);
    const labels: string[] = [], observations: ReturnType<typeof observed.snapshot>[] = [];
    element.addEventListener('stage-state', () => {
      labels.push(first.children[0]!.textContent); observations.push(observed.snapshot()); observed.reset();
      client.state!.hands[0]!.name = 'Callback &amp; name'; client.state!.hands[0]!.connected = false;
      for (const button of Object.values(buttons(first))) {
        button.setAttribute('aria-label', 'Host edit'); button.disabled = true; button.setAttribute('aria-busy', 'true');
      }
      observed.reset();
    }, { once: true });
    const next = structuredClone(initial); next.hands[0]!.name = 'Outer name';
    socket.deliver({ type: 'room:state', ...next });
    assert.deepEqual(labels, ['Outer name']);
    const expected = { text: 1, attribute: 2, disabled: 0 };
    assert.deepEqual(observations, [{ writes: expected, changes: expected }]); observed.expect(1, 4, 2);
    assert.equal(first.children[0]!.textContent, 'Callback & name（暫時離線）'); busy(first, false);
    assert.equal(buttons(first).approve.getAttribute('aria-label'), '核准 Callback & name 上台');
    assert.equal(buttons(first).reject.getAttribute('aria-label'), '婉拒 Callback & name 的舉手申請');
  });

  it('hand-row writes: preserves a newer nested state instead of restoring the outer callback snapshot', async t => {
    const initial = state(), { element, client, socket } = await socketJoinedWidget(t, initial);
    const first = queue(element).rows[0]!, observed = rowWrites(t, [first]);
    const outer = structuredClone(initial), nested = structuredClone(initial);
    outer.hands[0]!.name = 'Outer'; nested.hands[0]!.name = 'Nested &amp; current'; nested.hands[0]!.connected = false;
    const labels: string[] = [], observations: ReturnType<typeof observed.snapshot>[] = [];
    element.addEventListener('stage-state', () => {
      labels.push(first.children[0]!.textContent); observations.push(observed.snapshot()); observed.reset();
      socket.deliver({ type: 'room:state', ...nested });
      labels.push(first.children[0]!.textContent); observations.push(observed.snapshot()); observed.reset();
    }, { once: true });
    socket.deliver({ type: 'room:state', ...outer }); observed.expect();
    assert.deepEqual(labels, ['Outer', 'Nested & current（暫時離線）']);
    const expected = { text: 1, attribute: 2, disabled: 0 };
    assert.deepEqual(observations, [{ writes: expected, changes: expected }, { writes: expected, changes: expected }]);
    assert.equal(client.state!.hands[0]!.name, nested.hands[0]!.name);
    assert.equal(first.children[0]!.textContent, 'Nested & current（暫時離線）');
    assert.equal(buttons(first).approve.getAttribute('aria-label'), '核准 Nested & current 上台');
    assert.equal(buttons(first).reject.getAttribute('aria-label'), '婉拒 Nested & current 的舉手申請');
  });

  it('keeps audience and speakers private, then exposes a collapsed onstage/offstage controller queue and ordinary empty state', async t => {
    const unjoined = new StageElement(); widgets.push(unjoined); retired(unjoined);
    const { element, client } = await subscribedWidget(t);
    retired(element);
    for (const role of ['audience', 'speaker'] as const) {
      const next = state(); next.me.role = role; next.me.onStage = role === 'speaker'; next.controllerId = 'host';
      await client['receive']({ type: 'room:state', ...next }); retired(element);
      assert.doesNotMatch(visibleText(element as unknown as Node), /Private queued/);
    }
    const stable = panel(element);
    for (const onStage of [false, true]) {
      await client['receive']({ type: 'room:state', ...state([], onStage) });
      const view = queue(element);
      assert.equal(view.disclosure, stable); assert.equal(stable.hidden, false); assert.equal(stable.open, false);
      assert.match(view.summary.textContent, /0/); assert.equal(view.empty.hidden, false); assert.ok(view.empty.textContent);
      assert.equal(element['hand'].hidden, true);
    }
    await client.disconnect(); retired(element);
  });

  it('preserves snapshot order and same-order row identity, safely decodes names, and never renders the controller audience roster or code', async t => {
    const initial = state(['z', 'a', 'same-name']);
    initial.hands[0]!.name = '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Q&quot; &#39;S&#39; &amp;lt;';
    initial.hands[1]!.name = initial.hands[2]!.name = 'Same display name';
    initial.hands[2]!.connected = false;
    initial.audience = [{ ...roomState().me, participantId: 'private', name: 'Unraised secret' }];
    initial.code = 'SECRET-ROOM-CODE';
    const { element, socket } = await socketJoinedWidget(t, initial);
    const view = queue(element), first = [...view.rows], firstButtons = first.map(buttons);
    const replaceRows = t.mock.method(view.list, 'replaceChildren');
    assert.match(view.summary.textContent, /3/); assert.doesNotMatch(view.empty.textContent, /沒有舉手/); assert.equal(view.disclosure.open, false);
    assert.match(text(first[0]!), /<img src=x onerror=alert\(1\)> & "Q" 'S' &lt;/);
    assert.match(text(first[2]!), /未連線|離線|斷線/);
    assert.doesNotMatch(visibleText(element as unknown as Node), /Unraised secret|SECRET-ROOM-CODE/);
    for (const node of nodes(view.disclosure)) {
      assert.equal(Reflect.get(node, 'innerHTML'), undefined, 'names are plain text, never parsed HTML');
      assert.ok(!['IMG', 'SCRIPT'].includes(node.tagName));
    }
    view.disclosure.open = true;
    const renamed = structuredClone(initial); renamed.hands[1]!.name = 'Renamed &amp; safe';
    socket.deliver({ type: 'room:state', ...renamed });
    const updated = queue(element);
    assert.deepEqual(updated.rows, first); assert.equal(updated.disclosure.open, true);
    assert.deepEqual(updated.rows.map(buttons), firstButtons); assert.match(text(updated.rows[1]!), /Renamed & safe/);
    assert.equal(replaceRows.mock.callCount(), 0, 'unchanged order does not detach focused or expanded row controls');
    const reordered = structuredClone(renamed); reordered.hands.reverse();
    socket.deliver({ type: 'room:state', ...reordered });
    assert.deepEqual(queue(element).rows, [...first].reverse(), 'keys follow authoritative order without replacing surviving nodes');
    assert.deepEqual(initial.hands.map(person => person.participantId), ['z', 'a', 'same-name']);
  });

  for (const action of ['approve', 'reject'] as const) {
    it(`holds a target-wide ${action} lock through state-before-ACK removal and same-ID reappearance, without trusting the retired row callback`, async t => {
      const { element, socket, tick } = await socketJoinedWidget(t, state());
      const original = queue(element).rows[0]!, old = buttons(original);
      error(socket); press(old[action]); force(old.approve); force(old.reject); busy(original, true);
      assert.equal(element['error'].hidden, true); await tick(100);
      const first = request(socket); assert.equal(first.type, `stage:${action}`); assert.equal(first.targetId, 'first');
      socket.deliver({ type: 'room:state', ...state(['second']) });
      socket.deliver({ type: 'room:state', ...state() });
      const replacement = queue(element).rows[0]!; assert.notEqual(replacement, original); busy(replacement, true);
      error(socket, 'Keep pending error'); force(old.approve); force(old.reject);
      force(buttons(replacement).approve); force(buttons(replacement).reject); await tick(100);
      assert.equal(socket.sent.filter(message => message.type.startsWith('stage:')).length, 1);
      assert.equal(element['error'].textContent, 'Keep pending error'); assert.equal(element['error'].hidden, false);
      socket.deliver({ type: 'ok', requestId: first.requestId }); await settle(); busy(replacement, false);
      force(old.approve); force(old.reject); assert.equal(element['error'].hidden, false, 'stale row cannot clear current errors after ACK');
      press(buttons(replacement)[action]); await tick(100); const second = request(socket);
      assert.notEqual(second.requestId, first.requestId); assert.equal(second.targetId, first.targetId);
      socket.deliver({ type: 'ok', requestId: first.requestId }); await settle(); busy(replacement, true);
      socket.deliver({ type: 'ok', requestId: second.requestId }); await settle(); busy(replacement, false);
    });
  }

  it('uses exact participant IDs for duplicate display names, shares each target lock across both actions, and permits a different target concurrently', async t => {
    const initial = state(); initial.hands.forEach(person => { person.name = 'Same name'; });
    const { element, socket, tick } = await socketJoinedWidget(t, initial);
    const [first, second] = queue(element).rows; assert.ok(first && second);
    press(buttons(first).approve); press(buttons(first).reject); press(buttons(second).reject); press(buttons(second).approve);
    busy(first, true); busy(second, true); await tick(200);
    const sent = socket.sent.filter((message): message is ModerationRequest => message.type === 'stage:approve' || message.type === 'stage:reject');
    assert.deepEqual(sent.map(message => [message.type, message.targetId]), [['stage:approve', 'first'], ['stage:reject', 'second']]);
    socket.deliver({ type: 'ok', requestId: sent[1]!.requestId }); await settle(); busy(second, false); busy(first, true);
    socket.deliver({ type: 'error', code: 'conflict', message: 'Target withdrew', requestId: sent[0]!.requestId });
    await settle(); busy(first, false); assert.equal(element['error'].textContent, 'Target withdrew');
  });

  for (const callback of ['stage-status', 'stage-state'] as const) {
    it(`prepares current rows before forwarded ${callback} and reserves a single reentrant request before join ACK`, async t => {
      const { element, sockets, hello, tick } = socketJoiningWidget(t); await settle();
      const socket = sockets[0]!, join = await hello(socket); let callbacks = 0;
      element.addEventListener(callback, () => {
        callbacks++; assert.equal(panel(element).hidden, false);
        const row = queue(element).rows[0]!; press(buttons(row).approve); force(buttons(row).reject); busy(row, true);
      }, { once: true });
      socket.deliver({ type: 'room:state', ...state() }); await tick(100);
      assert.equal(callbacks, 1); const sent = request(socket); assert.equal(sent.targetId, 'first');
      assert.equal(socket.sent.filter(message => message.type.startsWith('stage:')).length, 1);
      socket.deliver({ type: 'ok', requestId: join.requestId }); await settle(); busy(queue(element).rows[0]!, true);
      socket.deliver({ type: 'ok', requestId: sent.requestId }); await settle(); busy(queue(element).rows[0]!, false);
    });
  }

  it('reserves the target before synchronous SDK callbacks can forward newer state and resubmit either action', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state());
    const pending = deferred(); let callbacks = 0;
    element.addEventListener('stage-state', () => {
      callbacks++; const row = queue(element).rows[0]!; busy(row, true); force(buttons(row).approve); force(buttons(row).reject);
    }, { once: true });
    const approve = t.mock.method(client, 'approve', () => { socket.deliver({ type: 'room:state', ...state() }); return pending.promise; });
    const reject = t.mock.method(client, 'reject', async () => {});
    press(buttons(queue(element).rows[0]!).approve);
    assert.equal(callbacks, 1); assert.equal(approve.mock.callCount(), 1); assert.equal(reject.mock.callCount(), 0);
    pending.resolve(); await settle(); busy(queue(element).rows[0]!, false);
  });

  it('rechecks target membership, hand, role and offstage authority even when a snapshot is changed without rendering', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state());
    const approve = t.mock.method(client, 'approve', async () => {}), reject = t.mock.method(client, 'reject', async () => {});
    for (const invalid of ['missing', 'withdrawn', 'speaker', 'controller', 'onstage'] as const) {
      socket.deliver({ type: 'room:state', ...state() }); const row = queue(element).rows[0]!, actions = buttons(row);
      error(socket, `Keep ${invalid}`);
      if (invalid === 'missing') client.state!.hands.splice(0, 1);
      else if (invalid === 'withdrawn') client.state!.hands[0]!.handRaised = false;
      else if (invalid === 'onstage') client.state!.hands[0]!.onStage = true;
      else client.state!.hands[0]!.role = invalid;
      force(actions.approve); force(actions.reject); await settle();
      assert.equal(approve.mock.callCount(), 0); assert.equal(reject.mock.callCount(), 0);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, `Keep ${invalid}`);
    }
  });

  for (const transition of ['role', 'room', 'participant', 'generation'] as const) {
    it(`retires ${transition} ownership before forwarded reentry, then isolates old callbacks and promise rejection from a fresh same-target pending action`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state());
      const old = deferred(), active = deferred(); let calls = 0;
      t.mock.method(client, 'approve', () => (++calls === 1 ? old : active).promise);
      const oldRow = queue(element).rows[0]!, oldActions = buttons(oldRow); panel(element).open = true; press(oldActions.approve);
      let callbacks = 0; element.addEventListener('stage-state', () => {
        callbacks++; error(socket, 'Keep owner change error'); force(oldActions.approve); force(oldActions.reject);
        assert.equal(calls, 1); assert.equal(element['error'].hidden, false);
      }, { once: true });
      const next = state();
      if (transition === 'role') { next.me.role = 'audience'; next.controllerId = 'someone-else'; }
      else if (transition === 'room') next.roomId = 'two';
      else if (transition === 'participant') { next.me.participantId = 'new-controller'; next.controllerId = 'new-controller'; }
      else ++element['generation'];
      if (transition === 'generation') { element['render'](); } else socket.deliver({ type: 'room:state', ...next });
      if (transition === 'role') retired(element);
      // A generation-only change intentionally retires the old event lane; use its public snapshot and render seam.
      if (transition === 'generation') { element['render'](); } else socket.deliver({ type: 'room:state', ...state() });
      const fresh = queue(element).rows[0]!; assert.notEqual(fresh, oldRow); assert.equal(panel(element).open, false);
      press(buttons(fresh).approve); assert.equal(calls, 2); busy(fresh, true);
      element['show'](new Error('Fresh owner error')); old.reject(new Error('Obsolete moderation error')); await settle();
      busy(fresh, true); assert.equal(element['error'].textContent, 'Fresh owner error');
      force(oldActions.approve); force(oldActions.reject); assert.equal(calls, 2); assert.equal(element['error'].hidden, false);
      active.resolve(); await settle(); busy(fresh, false);
      if (transition !== 'generation') assert.equal(callbacks, 1);
    });
  }

  it('retains rows, expansion and a deferred lock through reconnect, blocks forwarded status reentry, and never replays moderation automatically', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, state());
    const pending = deferred(), approve = t.mock.method(client, 'approve', () => pending.promise);
    const row = queue(element).rows[0]!, actions = buttons(row); panel(element).open = true; press(actions.approve);
    error(socket, 'Keep reconnect error'); let callbacks = 0;
    element.addEventListener('stage-status', () => {
      callbacks++; force(actions.approve); force(actions.reject); force(buttons(queue(element).rows[1]!).approve);
      assert.equal(element['error'].hidden, false);
    }, { once: true });
    socket.close(); await settle();
    assert.equal(callbacks, 1); assert.equal(queue(element).rows[0], row); assert.equal(panel(element).open, true);
    assert.match(text(panel(element)), /重新連線|重連/); assert.match(queue(element).summary.textContent, /最近|上次|最後|先前/);
    busy(row, true); busy(queue(element).rows[1]!, false, true); assert.equal(approve.mock.callCount(), 1);
    await tick(500); const next = sockets[1]!, resume = await hello(next);
    next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assert.equal(queue(element).rows[0], row); assert.equal(panel(element).open, true); busy(row, true);
    assert.doesNotMatch(text(panel(element)), /重新連線|重連/);
    assert.equal(next.sent.some(message => message.type.startsWith('stage:')), false);
    pending.resolve(); await settle(); busy(row, false); assert.equal(element['error'].textContent, 'Keep reconnect error');
  });

  it('shows actual socket-loss rejection, then ignores old-wire state, error and ACK during a fresh request', async t => {
    const { element, socket, sockets, tick, hello } = await socketJoinedWidget(t, state());
    panel(element).open = true; press(buttons(queue(element).rows[0]!).approve); await tick(100);
    const old = request(socket), oldMessage = socket.onmessage; socket.close(); await settle();
    assert.equal(element['error'].textContent, '連線已中斷。'); busy(queue(element).rows[0]!, false, true);
    await tick(500); const next = sockets[1]!, resume = await hello(next);
    next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    const row = queue(element).rows[0]!; press(buttons(row).reject); await tick(100); const active = request(next);
    for (const message of [
      { type: 'ok', requestId: old.requestId },
      { type: 'error', code: 'conflict', message: 'Old wire error', requestId: old.requestId },
      { type: 'room:state', ...state([]) },
    ] satisfies ServerMessage[]) oldMessage?.({ data: JSON.stringify(message) });
    await settle(); busy(row, true); assert.equal(queue(element).rows[0], row); assert.equal(element['error'].hidden, true);
    next.deliver({ type: 'ok', requestId: active.requestId }); await settle(); busy(row, false);
  });

  it('retires a pre-ACK disconnected snapshot and silent public disconnect, then admits a new same-ID owner without stale promise effects', async t => {
    const { element, sockets, hello, tick, joinRequest } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, join = await hello(socket), client = element.client!;
    socket.deliver({ type: 'room:state', ...state() }); assert.equal(client['session'], null); assert.ok(client['pending'].has(join.requestId));
    const old = deferred(), active = deferred(); let calls = 0;
    t.mock.method(client, 'approve', () => (++calls === 1 ? old : active).promise);
    const oldRow = queue(element).rows[0]!, oldActions = buttons(oldRow); panel(element).open = true; press(oldActions.approve);
    socket.close(); await settle(); assert.equal(client.status, 'disconnected'); assert.ok(client.state); retired(element);
    let statuses = 0; element.addEventListener('stage-status', () => { statuses++; });
    await client.disconnect(); assert.equal(statuses, 0); retired(element);
    const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
    const joining = client.join({ roomId: 'one', name: 'Listener' }); await settle(); await tick(100);
    const freshJoin = joinRequest(next); next.deliver({ type: 'room:state', ...state() });
    next.deliver({ type: 'ok', requestId: freshJoin.requestId }); await joining;
    const fresh = queue(element).rows[0]!; assert.notEqual(fresh, oldRow); assert.equal(panel(element).open, false);
    press(buttons(fresh).approve); error(next, 'Fresh same-ID error'); old.reject(new Error('Obsolete pre-ACK error')); await settle();
    busy(fresh, true); force(oldActions.approve); force(oldActions.reject); assert.equal(calls, 2);
    assert.equal(element['error'].textContent, 'Fresh same-ID error'); active.resolve(); await settle(); busy(fresh, false);
  });

  for (const transition of ['leave', 'detach', 'direct disconnect', 'ordinary close', 'kick', 'shutdown'] as const) {
    it(`clears rows, expansion and pending ownership on ${transition} before stale callbacks can clear current errors`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state());
      const pending = deferred(), approve = t.mock.method(client, 'approve', () => pending.promise);
      const old = buttons(queue(element).rows[0]!); panel(element).open = true; press(old.approve);
      if (transition === 'leave') press(element['roomAction'] as unknown as Node);
      else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else if (transition === 'direct disconnect') await client.disconnect();
      else socket.deliver(terminalCases.find(item => item.title === transition)!.message);
      await settle(); retired(element); element['show'](new Error('Current terminal error'));
      force(old.approve); force(old.reject); pending.reject(new Error('Obsolete terminal error')); await settle();
      assert.equal(approve.mock.callCount(), 1); assert.equal(element['error'].textContent, 'Current terminal error');
      assert.equal(element['error'].hidden, false); retired(element);
    });
  }

  it('isolates a retired client across attribute rejoin and suppresses its delayed rejection while the replacement owns a pending request', async t => {
    const { element, client, socket, sockets, hello } = await socketJoinedWidget(t, state());
    const old = deferred(); t.mock.method(client, 'approve', () => old.promise);
    const oldActions = buttons(queue(element).rows[0]!); press(oldActions.approve); panel(element).open = true;
    const oldMessage = socket.onmessage, oldClose = socket.onclose;
    element.setAttribute('room', 'two'); await settle(); await settle(); retired(element);
    const replacement = element.client!; assert.notEqual(replacement, client);
    const next = sockets[1]!, join = await hello(next); next.deliver({ type: 'room:state', ...state(['first'], false, 'two') });
    next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    const pending = deferred(), approve = t.mock.method(replacement, 'approve', () => pending.promise);
    const row = queue(element).rows[0]!; press(buttons(row).approve); error(next, 'Replacement error');
    old.reject(new Error('Retired client error')); oldMessage?.({ data: JSON.stringify({ type: 'room:state', ...state([]) }) }); oldClose?.(); await settle();
    force(oldActions.approve); force(oldActions.reject); busy(row, true);
    assert.equal(approve.mock.callCount(), 1); assert.equal(element['error'].textContent, 'Replacement error');
    pending.resolve(); await settle(); busy(row, false);
  });

  it('suppresses an obsolete settlement after silent role loss, but keeps the SDK global error event contract', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, state());
    const pending = deferred(); const approve = t.mock.method(client, 'approve', () => pending.promise);
    press(buttons(queue(element).rows[0]!).approve); error(socket, 'Unrelated current error');
    client.state!.me.role = 'audience'; client.state!.controllerId = 'other';
    pending.reject(new Error('Late unauthorized error')); await settle(); retired(element);
    assert.equal(element['error'].textContent, 'Unrelated current error'); approve.mock.restore();
    socket.deliver({ type: 'room:state', ...state() }); press(buttons(queue(element).rows[0]!).approve); await tick(100);
    const sent = request(socket); socket.deliver({ type: 'room:state', ...roomState() }); retired(element);
    socket.deliver({ type: 'room:state', ...state() }); const fresh = queue(element).rows[0]!;
    press(buttons(fresh).reject); await tick(100); const current = request(socket); busy(fresh, true);
    let forwarded = 0; element.addEventListener('stage-error', () => { forwarded++; });
    socket.deliver({ type: 'error', code: 'forbidden', message: 'Server denied old request', requestId: sent.requestId }); await settle();
    assert.equal(forwarded, 1); assert.equal(element['error'].textContent, 'Server denied old request');
    busy(fresh, true); assert.equal(client['pending'].size, 1, 'old promise cannot settle the new tenure target lock');
    socket.deliver({ type: 'ok', requestId: current.requestId }); await settle(); busy(fresh, false);
    assert.equal(element['error'].textContent, 'Server denied old request');
  });

  it('shows synchronous SDK failure and real local queue_full without a frame, unlocking only the affected target for an explicit retry', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, state());
    const row = queue(element).rows[0]!;
    const throwing = t.mock.method(client, 'approve', () => { throw new Error('Synchronous failure'); });
    press(buttons(row).approve); await settle(); busy(row, false); assert.equal(element['error'].textContent, 'Synchronous failure'); throwing.mock.restore();
    Object.defineProperty(client, 'maxPendingControlRequests', { value: 1 });
    const unrelated = client.reject('unlisted').catch(() => {});
    press(buttons(row).approve); await settle(); busy(row, false); assert.match(element['error'].textContent ?? '', /佇列|請求/);
    await tick(100); assert.deepEqual(socket.sent.filter(message => message.type.startsWith('stage:')).map(message => (message as ModerationRequest).targetId), ['unlisted']);
    socket.deliver({ type: 'ok', requestId: request(socket).requestId }); await unrelated;
    press(buttons(row).approve); await tick(100); const accepted = request(socket); assert.equal(accepted.targetId, 'first');
    socket.deliver({ type: 'ok', requestId: accepted.requestId }); await settle(); busy(row, false);
  });

  /** Relay real SDK frames through validation and Hub, delivering authoritative state before the request ACK. */
  async function hubWidget(t: TestContext, maxSpeakers = 8) {
    const config = testConfig(c => { c.limits.maxSpeakersPerRoom = maxSpeakers; c.limits.handRaiseIntervalMs = 0;
      c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 0; });
    const h = harness(config); t.after(async () => { await h.hub.shutdown(); await h.transport.close(); });
    const host = await h.create('Original host'), successor = await h.join(host.roomId, host.code, 'Next controller');
    const first = await h.join(host.roomId, host.code, 'Same & <request>');
    const second = await h.join(host.roomId, host.code, 'Same & <request>');
    const privateAudience = await h.join(host.roomId, host.code, 'Unraised secret');
    assert.equal(await h.req(first.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await h.req(second.s, { type: 'hand:raise' }), 'ok');
    const fixture = await socketJoinedWidget(t, successor.s.last('room:state')!);
    const deliver = () => {
      // Hub presence snapshots use the harness timer queue, independently of SDK timers.
      for (const timer of h.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); }
      fixture.socket.deliver(successor.s.last('room:state')!);
    };
    const relay = async (message: ModerationRequest) => {
      const parsed = parseClientMessage(JSON.stringify(message), config.limits), start = successor.s.inbox.length;
      await h.hub.handle(successor.s, parsed);
      const replies = successor.s.inbox.slice(start);
      for (const event of replies) if (event.type !== 'ok' && event.type !== 'error') fixture.socket.deliver(event);
      await settle();
      const reply = replies.find(event => (event.type === 'ok' || event.type === 'error') && event.requestId === message.requestId);
      assert.ok(reply && (reply.type === 'ok' || reply.type === 'error')); return reply;
    };
    const promote = async () => {
      assert.equal(await h.req(host.s, { type: 'control:transfer', targetId: successor.id }), 'ok'); deliver();
      assert.equal(fixture.client.me!.role, 'controller'); assert.equal(fixture.client.me!.onStage, false);
    };
    return { ...fixture, h, host, successor, first, second, privateAudience, deliver, relay, promote, config };
  }

  it('handles a real Hub controller transfer entirely offstage, approving and rejecting only hand requests via validated SDK frames and state-before-ACK', async t => {
    const { element, client, socket, tick, h, host, first, second, privateAudience, promote, relay } = await hubWidget(t);
    retired(element); assert.equal(client.state!.audience, undefined); assert.equal(client.state!.code, undefined);
    await promote(); const view = queue(element);
    assert.deepEqual(client.state!.hands.map(person => person.participantId), [first.id, second.id]);
    assert.equal(client.state!.audience!.some(person => person.participantId === privateAudience.id), true);
    assert.doesNotMatch(visibleText(element as unknown as Node), /Unraised secret/);
    assert.equal(visibleText(element as unknown as Node).includes(host.code), false);
    assert.match(text(view.rows[0]!), /Same & <request>/); assert.match(text(view.rows[1]!), /Same & <request>/);
    const old = buttons(view.rows[0]!); press(old.approve); await tick(100);
    const approving = request(socket); assert.equal(approving.targetId, first.id);
    const approved = await relay(approving); assert.equal(approved.type, 'ok');
    assert.deepEqual(client.state!.hands.map(person => person.participantId), [second.id]);
    assert.equal(client.state!.speakers.some(person => person.participantId === first.id), true);
    force(old.approve); force(old.reject); await tick(100); assert.equal(socket.sent.filter(message => message.type.startsWith('stage:')).length, 1);
    // A different target remains actionable while the first successful request is waiting for ACK.
    press(buttons(queue(element).rows[0]!).reject); await tick(100);
    const rejecting = request(socket); assert.equal(rejecting.targetId, second.id); assert.equal(rejecting.type, 'stage:reject');
    const rejected = await relay(rejecting); assert.equal(rejected.type, 'ok'); assert.deepEqual(client.state!.hands, []);
    socket.deliver(rejected); socket.deliver(approved); await settle();
    assert.equal(queue(element).rows.length, 0); assert.match(queue(element).summary.textContent, /0/);
    assert.equal(client.me!.onStage, false); assert.equal(client.me!.role, 'controller');
    assert.equal(await h.req(second.s, { type: 'stage:approve', targetId: second.id }), 'forbidden');
    assert.deepEqual(socket.sent.filter(message => message.type.startsWith('stage:')).map(message => message.type), ['stage:approve', 'stage:reject']);
  });

  it('defers real stage capacity and disconnected-target decisions to Hub, leaving reject available and showing current server failures', async t => {
    const { element, client, socket, tick, h, first, second, deliver, promote, relay } = await hubWidget(t, 1);
    await promote(); assert.equal(client.state!.speakers.length, 1, 'former controller occupies the ordinary stage slot');
    let row = queue(element).rows[0]!; busy(row, false); press(buttons(row).approve); await tick(100);
    const full = await relay(request(socket)); assert.equal(full.type, 'error'); if (full.type === 'error') assert.equal(full.code, 'stage_full');
    socket.deliver(full); await settle(); busy(row, false); assert.equal(element['error'].hidden, false);
    press(buttons(row).reject); await tick(100); const rejected = await relay(request(socket)); assert.equal(rejected.type, 'ok');
    socket.deliver(rejected); await settle(); assert.equal(client.state!.hands.some(person => person.participantId === first.id), false);
    await h.hub.detach(second.s);
    for (const timer of h.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); }
    deliver(); row = queue(element).rows[0]!; assert.match(text(row), /未連線|離線|斷線/); busy(row, false);
    press(buttons(row).approve); await tick(100); const offline = await relay(request(socket));
    assert.equal(offline.type, 'error'); if (offline.type === 'error') assert.equal(offline.code, 'conflict');
    socket.deliver(offline); await settle(); busy(row, false);
    press(buttons(row).reject); await tick(100); const cleared = await relay(request(socket)); assert.equal(cleared.type, 'ok');
    socket.deliver(cleared); await settle(); assert.deepEqual(client.state!.hands, []);
    assert.equal(client.me!.onStage, false); assert.equal(client['pending'].size, 0);
  });

  it('reports the actual Hub withdrawal conflict after a valid click without reviving the removed request or accepting its stale callback', async t => {
    const { element, client, socket, tick, h, first, deliver, promote, relay } = await hubWidget(t);
    await promote(); const old = buttons(queue(element).rows[0]!); press(old.approve); await tick(100);
    const sent = request(socket); assert.equal(sent.targetId, first.id);
    assert.equal(await h.req(first.s, { type: 'hand:withdraw' }), 'ok'); deliver();
    assert.equal(client.state!.hands.some(person => person.participantId === first.id), false);
    const result = await relay(sent); assert.equal(result.type, 'error'); if (result.type === 'error') assert.equal(result.code, 'conflict');
    socket.deliver(result); await settle(); const currentError = element['error'].textContent;
    assert.equal(element['error'].hidden, false); force(old.approve); force(old.reject); await tick(100);
    assert.equal(element['error'].textContent, currentError); assert.equal(element['error'].hidden, false);
    assert.equal(socket.sent.filter(message => message.type.startsWith('stage:')).length, 1);
    assert.equal(client.state!.hands.length, 1); assert.equal(client['pending'].size, 0);
  });

  it('shows automatically promoted offstage controller requests after actual Hub controller expiry', async t => {
    const { element, client, socket, tick, h, host, config, first, second, deliver, relay } = await hubWidget(t);
    await h.hub.detach(host.s);
    const expiry = h.timers.find(timer => !timer.cleared && timer.ms === config.rooms.controllerGraceMs); assert.ok(expiry);
    h.clock.now += expiry.ms; expiry.cleared = true; expiry.fn(); await nextTurn(); deliver();
    assert.equal(client.me!.role, 'controller'); assert.equal(client.me!.onStage, false); assert.equal(panel(element).hidden, false);
    assert.deepEqual(client.state!.hands.map(person => person.participantId), [first.id, second.id]);
    press(buttons(queue(element).rows[0]!).approve); await tick(100); const result = await relay(request(socket));
    assert.equal(result.type, 'ok'); socket.deliver(result); await settle();
    assert.equal(client.state!.speakers.some(person => person.participantId === first.id), true); assert.equal(client.me!.onStage, false);
  });

  for (const onStage of [false, true]) {
    it(`does not create or replace ${onStage ? 'an active' : 'an offstage'} controller microphone when moderating another participant with actual SDK fake-media ownership`, async t => {
      const originals = new Map(['navigator', 'RTCPeerConnection', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
      const tracks: (EventTarget & { enabled: boolean; readyState: string; stops: number; stop(): void })[] = [];
      class Peer {
        static instances: Peer[] = [];
        connectionState = 'connected'; signalingState = 'stable'; localDescription = { type: 'offer', sdp: 'fake-installed-description' }; closed = false;
        readonly installs: unknown[] = [];
        readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown, replaceTrack: async (track: unknown) => {
          this.installs.push(track); this.transceiver.sender.track = track;
        } } };
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
      const negotiate = t.mock.method(StageClient.prototype as unknown as { negotiate(): void }, 'negotiate', () => {});
      t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
      const { element, client, socket, tick } = await socketJoinedWidget(t, state(['first'], onStage), true);
      await client['mediaTask']; const peer = Peer.instances[0]!; assert.ok(peer);
      const before = { tracks: tracks.length, installed: [...peer.installs], track: peer.transceiver.sender.track,
        direction: peer.transceiver.direction, negotiations: negotiate.mock.callCount() };
      assert.equal(before.tracks, onStage ? 1 : 0);
      press(buttons(queue(element).rows[0]!).approve); await tick(100);
      assert.equal(tracks.length, before.tracks); assert.deepEqual(peer.installs, before.installed, 'the action itself has no media side effects');
      const sent = request(socket), next = state([], onStage);
      next.speakers = [{ ...roomState(true).me, participantId: 'first', name: 'Promoted request' }];
      socket.deliver({ type: 'room:state', ...next }); await client['mediaTask'];
      socket.deliver({ type: 'ok', requestId: sent.requestId }); await settle();
      assert.equal(tracks.length, before.tracks); assert.equal(peer.transceiver.sender.track, before.track);
      assert.ok(peer.installs.every(track => track === before.track), 'normal snapshot reconciliation only reasserts the same owned track');
      assert.equal(peer.transceiver.direction, before.direction);
      assert.equal(negotiate.mock.callCount(), before.negotiations); assert.equal(Peer.instances.length, 1);
      assert.ok(tracks.every(track => track.stops === 0)); assert.equal(client.me!.onStage, onStage);
      assert.equal(socket.sent.some(message => message.type === 'rtc:offer'), false);
    });
  }
});

/**
 * Stage172 microphone picker: real SDK enumeration, capture ownership, media replacement and
 * signaling over controlled DOM/navigator/peer/socket fixtures. These tests do not prove native
 * keyboard/IME, assistive technology, permission UI, device availability, or audible hardware.
 */
describe('widget explicit microphone selection', () => {
  type Widget = InstanceType<typeof StageElement>;
  type Track = EventTarget & { enabled: boolean; readyState: string; stops: number; stop(): void; end(): void };
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  const visibleText = (element: Widget): string => nodes(element['microphonePanel'] as unknown as Node).map(node => node.textContent).join('\n');
  function pending<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function device(deviceId: string, label = '', kind: MediaDeviceKind = 'audioinput'): MediaDeviceInfo {
    return { deviceId, label, kind, groupId: 'private-group', toJSON() { return {}; } };
  }
  function options(element: Widget): { value: string; label: string; disabled: boolean }[] {
    return Array.from(element['microphoneSelect'].options, option => ({ value: option.value, label: option.textContent ?? '', disabled: option.disabled }));
  }
  function draft(element: Widget, value: string): void {
    element['microphoneSelect'].value = value;
    assert.equal(element['microphoneSelect'].value, value, 'the native-like select must actually contain the requested option');
  }
  function force(button: HTMLButtonElement): void { button.disabled = false; click(button); }
  function assertPicker(element: Widget, { hidden = false, disabled = hidden, refresh = false, apply = false, value = '' }:
    { hidden?: boolean; disabled?: boolean; refresh?: boolean; apply?: boolean; value?: string } = {}): void {
    assert.equal(element['microphonePanel'].hidden, hidden, 'picker owner visibility');
    assert.equal(element['microphoneSelect'].disabled, disabled, 'select admission');
    assert.equal(element['microphoneRefresh'].disabled, disabled, 'refresh admission');
    assert.equal(element['microphoneApply'].disabled, disabled, 'apply admission');
    assert.equal(element['microphoneSelect'].value, value, 'selection remains a draft');
    assert.equal(element['microphoneRefresh'].getAttribute('aria-busy'), hidden ? null : String(refresh));
    assert.equal(element['microphoneApply'].getAttribute('aria-busy'), hidden ? null : String(apply));
    assert.equal(Boolean(element['refreshAttempt']), refresh); assert.equal(Boolean(element['inputDeviceAttempt']), apply);
  }
  function assertRetired(element: Widget): void {
    assertPicker(element, { hidden: true });
    assert.equal(element['microphoneOwner'], undefined);
    assert.ok(options(element).every(option => option.value === ''), 'retired devices and identifiers are removed');
  }
  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) { if (predicate()) return; await settle(); }
    assert.fail(label);
  }
  function fakeMedia(t: TestContext, denyInitial = false) {
    const originals = new Map(['navigator', 'RTCPeerConnection', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const captures: (ReturnType<typeof pending<MediaStream>> & { constraints: MediaStreamConstraints })[] = [];
    const enumerations: ReturnType<typeof pending<MediaDeviceInfo[]>>[] = [], tracks: Track[] = [];
    let holdCapture = false, holdEnumeration = false;
    let available = [device('private-mic-a', 'USB microphone'), device('private-mic-b')];
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
      connectionState = 'connected'; signalingState = 'stable'; closed = false;
      localDescription: RTCSessionDescriptionInit | null = null;
      readonly offers: RTCSessionDescriptionInit[] = [];
      readonly gates: (ReturnType<typeof pending<void>> & { entered: boolean })[] = [];
      readonly replacements: unknown[] = [];
      readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown,
        replaceTrack: async (track: unknown) => {
          this.replacements.push(track);
          const gate = this.gates.find(gate => !gate.entered);
          if (gate) { gate.entered = true; await gate.promise; }
          this.transceiver.sender.track = track;
        },
      } };
      constructor() { Peer.instances.push(this); }
      addTransceiver() { return this.transceiver; }
      hold() { const gate = { ...pending<void>(), entered: false }; this.gates.push(gate); return gate; }
      async createOffer(): Promise<RTCSessionDescriptionInit> {
        const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` };
        this.offers.push(offer); return offer;
      }
      async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; this.signalingState = 'have-local-offer'; }
      async setRemoteDescription() { this.signalingState = 'stable'; }
      async addIceCandidate() {}
      close(): void { this.closed = true; this.connectionState = 'closed'; }
    }
    class Context {
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
      async resume() {} async close() {}
    }
    const devices = Object.assign(new EventTarget(), {
      enumerateDevices: () => {
        const request = pending<MediaDeviceInfo[]>(); enumerations.push(request);
        if (!holdEnumeration) request.resolve(available);
        return request.promise;
      },
      getUserMedia: (constraints: MediaStreamConstraints) => {
        const request = { ...pending<MediaStream>(), constraints }; captures.push(request);
        if (captures.length === 1 && denyInitial) request.reject(new DOMException('controlled initial denial', 'NotAllowedError'));
        else if (!holdCapture) request.resolve(source());
        return request.promise;
      },
    });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: devices } });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
    t.after(async () => {
      for (const request of captures) request.reject(new DOMException('test cleanup', 'AbortError'));
      for (const request of enumerations) request.reject(new Error('test cleanup'));
      for (const peer of Peer.instances) for (const gate of peer.gates) gate.resolve();
      await settle();
      for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    });
    return { captures, enumerations, tracks, devices, Peer, source,
      holdCapture(value = true) { holdCapture = value; }, holdEnumeration(value = true) { holdEnumeration = value; },
      list(value: MediaDeviceInfo[]) { available = value; },
    };
  }
  async function refresh(element: Widget): Promise<void> { click(element['microphoneRefresh']); await settle(); await settle(); }
  async function seed(t: TestContext, element: Widget, client: StageClient): Promise<void> {
    t.mock.method(client, 'listAudioDevices', async () => ({ inputs: [device('private-mic-a', 'USB microphone'), device('private-mic-b')], outputs: [] }));
    await refresh(element);
  }
  async function mediaJoinedWidget(t: TestContext, state: RoomStatePayload) {
    const fixture = socketJoiningWidget(t, { room: state.roomId }, true); await settle();
    const socket = fixture.sockets[0]!, request = await fixture.hello(socket);
    socket.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' });
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle(); await settle();
    const client = fixture.element.client!;
    assert.equal(client.status, state.status);
    assert.equal(client['pending'].has(request.requestId), false, 'join is acknowledged even when real SDP negotiation is pending');
    return { ...fixture, socket, client };
  }
  async function negotiate(fixture: Awaited<ReturnType<typeof socketJoinedWidget>>): Promise<void> {
    const answered = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt++) {
      await fixture.tick(100);
      for (const message of fixture.socket.sent) if (message.type === 'rtc:offer' && !answered.has(message.requestId)) {
        answered.add(message.requestId);
        fixture.socket.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
        fixture.socket.deliver({ type: 'ok', requestId: message.requestId });
      }
      await settle(); await settle();
      if (!fixture.client['negotiating'] && fixture.client['pc']?.localDescription) return;
    }
    assert.fail('real SDK negotiation settles through controlled socket ACK and answer');
  }

  it('uses labeled native draft controls and stays inert before state, including an ACK-only join', async t => {
    const media = fakeMedia(t), fixture = socketJoiningWidget(t);
    const { element, sockets, hello } = fixture; assertRetired(element);
    await settle(); const socket = sockets[0]!, request = await hello(socket), client = element.client!;
    const list = t.mock.method(client, 'listAudioDevices'), apply = t.mock.method(client, 'setInputDevice');
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    force(element['microphoneRefresh']); force(element['microphoneApply']); assertRetired(element);
    assert.equal(list.mock.callCount(), 0); assert.equal(apply.mock.callCount(), 0);
    assert.equal(media.enumerations.length, 0); assert.equal(media.captures.length, 0);
    socket.deliver({ type: 'room:state', ...roomState() }); assertPicker(element);
    const select = element['microphoneSelect'], panelNodes = nodes(element['microphonePanel'] as unknown as Node);
    assert.equal(select.tagName, 'SELECT'); assert.equal(select.id, 'microphone-device');
    const label = panelNodes.find(node => node.tagName === 'LABEL' && node.getAttribute('for') === select.id);
    assert.equal(label?.textContent, '麥克風選擇（草稿）');
    assert.equal(select.getAttribute('aria-describedby'), 'microphone-draft-notice');
    assert.ok(panelNodes.some(node => node.id === 'microphone-draft-notice' && /草稿不代表目前實際擷取裝置/.test(node.textContent)));
    assert.equal(element['microphonePanel'].part.contains?.('microphone') ?? (element['microphonePanel'].part as unknown as Set<string>).has('microphone'), true);
    assert.equal(element['microphoneRefresh'].type, 'button'); assert.equal(element['microphoneApply'].type, 'button');
    assert.equal(element['microphoneRefresh'].textContent, '重新整理麥克風清單'); assert.equal(element['microphoneApply'].textContent, '送出麥克風選擇');
    assert.deepEqual(options(element), [{ value: '', label: '預設（依 SDK 設定）', disabled: false }]);
    assert.match(visibleText(element), /草稿不代表目前實際擷取裝置/); assert.match(visibleText(element), /麥克風失敗後需另按「重試麥克風」/);
    assert.match(visibleText(element), /重試麥克風/); assert.equal(media.enumerations.length, 0);
  });

  it('explicitly enumerates only audio inputs without capture, preview, devicechange listeners, or displayed identifiers', async t => {
    const media = fakeMedia(t), { element, client, socket } = await socketJoinedWidget(t);
    media.list([device('', ''), device('private-mic-a', ''), device('private-mic-b', '<img src=x onerror=alert(1)> &amp; mic'),
      device('private-output', 'Output name', 'audiooutput'), device('private-camera', 'Camera name', 'videoinput')]);
    const preview = t.mock.method(client, 'startMicTest'), setter = t.mock.method(client, 'setInputDevice');
    const frames = [...socket.sent]; assert.equal(media.enumerations.length, 0);
    await refresh(element); assert.equal(media.enumerations.length, 1);
    const listed = options(element); assert.equal(listed[0]!.value, '');
    assert.ok(listed.some(option => option.value === 'private-mic-a' && /麥克風/.test(option.label)));
    assert.ok(listed.some(option => option.value === 'private-mic-b' && option.label.includes('<img')));
    assert.equal(listed.filter(option => option.value === '').length, 1, 'unselectable empty IDs do not duplicate the default');
    assert.ok(listed.every(option => option.value !== 'private-output' && option.value !== 'private-camera'));
    assert.doesNotMatch(visibleText(element), /private-mic|private-output|private-camera|private-group|Output name|Camera name/);
    assert.ok(nodes(element['microphonePanel'] as unknown as Node).every(node => node.tagName !== 'IMG'), 'labels remain text nodes');
    assert.equal(media.captures.length, 0); assert.equal(preview.mock.callCount(), 0); assert.equal(setter.mock.callCount(), 0);
    assert.equal(getEventListeners(media.devices, 'devicechange').length, 0);
    media.devices.dispatchEvent(new Event('devicechange')); socket.deliver({ type: 'room:state', ...roomState() }); await settle();
    assert.equal(media.enumerations.length, 1); assert.deepEqual(socket.sent, frames);
    draft(element, 'private-mic-a'); assert.equal(media.captures.length, 0); assert.equal(setter.mock.callCount(), 0);
  });

  it('stores an audience preference only on Apply and captures that choice on a later stage snapshot', async t => {
    const media = fakeMedia(t), fixture = await mediaJoinedWidget(t, roomState());
    const { element, client, socket } = fixture; await client['mediaTask']; await negotiate(fixture);
    const peer = media.Peer.instances[0]!, frames = [...socket.sent];
    await refresh(element); draft(element, 'private-mic-a'); assert.equal(client['inputDeviceId'], '');
    click(element['microphoneApply']); assertPicker(element, { value: 'private-mic-a', disabled: true, apply: true });
    await client['mediaTask']; await settle(); assertPicker(element, { value: 'private-mic-a' });
    assert.equal(client['inputDeviceId'], 'private-mic-a'); assert.equal(media.captures.length, 0); assert.deepEqual(socket.sent, frames);
    socket.deliver({ type: 'room:state', ...roomState(true) }); await client['mediaTask']; await negotiate(fixture);
    assert.equal(media.captures.length, 1); assert.deepEqual((media.captures[0]!.constraints.audio as MediaTrackConstraints).deviceId, { exact: 'private-mic-a' });
    assert.equal(peer.transceiver.sender.track, media.tracks[0]); assert.equal(media.Peer.instances.length, 1);
    const count = media.enumerations.length; await client.setInputDevice('private-mic-b'); await settle();
    assertPicker(element, { value: 'private-mic-a' }); assert.equal(media.enumerations.length, count);
    assert.match(visibleText(element), /草稿不代表目前實際擷取裝置/, 'public SDK setters do not establish widget hardware truth');
  });

  for (const policy of ['unmuted', 'muted', 'force-muted'] as const) {
    it(`switches a healthy ${policy} microphone on its existing peer without a new offer or mute-policy change`, async t => {
      const media = fakeMedia(t), state = roomState(true); state.me.muted = policy !== 'unmuted'; state.me.forceMuted = policy === 'force-muted';
      const fixture = await mediaJoinedWidget(t, state), { element, client, socket, sockets } = fixture;
      await client['mediaTask']; await negotiate(fixture); await refresh(element); draft(element, 'private-mic-a');
      const peer = media.Peer.instances[0]!, prior = media.tracks[0]!, frames = [...socket.sent], offers = peer.offers.length;
      const mute = t.mock.method(client, 'mute'), unmute = t.mock.method(client, 'unmute');
      click(element['microphoneApply']); await client['mediaTask']; await settle();
      assertPicker(element, { value: 'private-mic-a' }); assert.equal(media.captures.length, 2);
      assert.equal(peer.transceiver.sender.track, media.tracks[1]); assert.equal(prior.stops, 1);
      assert.equal(media.tracks[1]!.enabled, !state.me.muted); assert.equal(client.me!.muted, state.me.muted); assert.equal(client.me!.forceMuted, state.me.forceMuted);
      assert.equal(client['inputDeviceId'], 'private-mic-a'); assert.equal(peer.closed, false); assert.equal(media.Peer.instances.length, 1); assert.equal(sockets.length, 1);
      assert.equal(peer.offers.length, offers); assert.deepEqual(socket.sent, frames); assert.equal(mute.mock.callCount(), 0); assert.equal(unmute.mock.callCount(), 0);
      draft(element, ''); click(element['microphoneApply']); await client['mediaTask']; await settle();
      assert.equal((media.captures.at(-1)!.constraints.audio as MediaTrackConstraints).deviceId, undefined);
      assert.equal(client['inputDeviceId'], ''); assert.equal(peer.offers.length, offers); assertPicker(element);
    });
  }

  it('passes an empty draft through to the SDK original constraints rather than claiming an OS default', async t => {
    const media = fakeMedia(t), { element, client } = await socketJoinedWidget(t);
    // Existing SDK options are controlled here because the widget exposes no constraints attribute.
    client['options'].micConstraints = { deviceId: { exact: 'configured-sdk-input' }, echoCancellation: false };
    await refresh(element); draft(element, 'private-mic-a'); click(element['microphoneApply']); await client['mediaTask']; await settle();
    draft(element, ''); click(element['microphoneApply']); await client['mediaTask']; await settle();
    assert.equal(media.captures.length, 0);
    const preview = await client.startMicTest();
    assert.deepEqual((media.captures[0]!.constraints.audio as MediaTrackConstraints).deviceId, { exact: 'configured-sdk-input' });
    assert.equal((media.captures[0]!.constraints.audio as MediaTrackConstraints).echoCancellation, false); preview.stop();
    assert.equal(options(element)[0]!.label, '預設（依 SDK 設定）'); assertPicker(element);
  });

  for (const failure of ['permission denial', 'sender rejection'] as const) {
    it(`retains the working microphone and draft after ${failure}, then admits a separate Apply retry`, async t => {
      const media = fakeMedia(t), fixture = await mediaJoinedWidget(t, roomState(true)), { element, client, socket } = fixture;
      await client['mediaTask']; await negotiate(fixture); await refresh(element); draft(element, 'private-mic-a');
      const peer = media.Peer.instances[0]!, prior = media.tracks[0]!, frames = [...socket.sent];
      let micErrors = 0; element.addEventListener('stage-micerror', () => { micErrors++; });
      const gate = failure === 'sender rejection' ? peer.hold() : undefined;
      media.holdCapture(failure === 'permission denial');
      click(element['microphoneApply']);
      await until(() => gate ? gate.entered : media.captures.length === 2, 'explicit replacement reaches its controlled failure');
      if (gate) gate.reject(new Error('controlled sender rejection'));
      else media.captures[1]!.reject(new DOMException('controlled permission denial', 'NotAllowedError'));
      await client['mediaTask']; await settle();
      assertPicker(element, { value: 'private-mic-a' }); assert.equal(element['error'].hidden, false);
      assert.match(element['error'].textContent ?? '', failure === 'sender rejection' ? /controlled sender rejection/ : /controlled permission denial/);
      assert.equal(peer.transceiver.sender.track, prior); assert.equal(prior.stops, 0); assert.equal(client['inputDeviceId'], '');
      assert.equal(micErrors, 0); assert.equal(element['micRetry'].hidden, true); assert.deepEqual(socket.sent, frames);
      media.holdCapture(false); click(element['microphoneApply']); await client['mediaTask']; await settle();
      assert.equal(peer.transceiver.sender.track, media.tracks.at(-1)); assert.equal(prior.stops, 1);
      assert.equal(client['inputDeviceId'], 'private-mic-a'); assert.equal(element['error'].hidden, true); assertPicker(element, { value: 'private-mic-a' });
    });
  }

  for (const cause of ['initial denial', 'natural track end'] as const) {
    it(`after ${cause}, changing and applying a draft only saves preference; the existing retry performs capture`, async t => {
      const media = fakeMedia(t, cause === 'initial denial'), fixture = await mediaJoinedWidget(t, roomState(true));
      const { element, client, socket } = fixture; await client['mediaTask']; await negotiate(fixture);
      if (cause === 'natural track end') { media.tracks[0]!.end(); await client['mediaTask']; await negotiate(fixture); }
      assert.equal(client['mic'], null); assert.equal(client['micFailed'], true); assert.equal(element['micRetry'].hidden, false);
      await refresh(element); const count = media.captures.length, frames = [...socket.sent];
      draft(element, 'private-mic-b'); await settle(); assert.equal(media.captures.length, count);
      click(element['microphoneApply']); await client['mediaTask']; await settle();
      assert.equal(media.captures.length, count); assert.equal(client['inputDeviceId'], 'private-mic-b');
      assert.equal(client['micFailed'], true); assert.equal(element['micRetry'].hidden, false);
      assertPicker(element, { value: 'private-mic-b' }); assert.match(visibleText(element), /麥克風失敗後需另按「重試麥克風」/);
      socket.deliver({ type: 'room:state', ...roomState(true) }); await client['mediaTask']; assert.equal(media.captures.length, count);
      click(element['micRetry']); await client['mediaTask']; await settle();
      assert.equal(media.captures.length, count + 1); assert.deepEqual((media.captures.at(-1)!.constraints.audio as MediaTrackConstraints).deviceId, { exact: 'private-mic-b' });
      assert.equal(client['micFailed'], false); assert.equal(element['micRetry'].hidden, true);
      assert.equal(media.Peer.instances[0]!.transceiver.sender.track, media.tracks.at(-1));
      assert.equal(socket.sent.filter(message => message.type !== 'rtc:offer').length, frames.filter(message => message.type !== 'rtc:offer').length);
    });
  }

  it('serializes an immediately following existing microphone retry behind a failed-seat Apply and captures the new preference', async t => {
    const media = fakeMedia(t, true), fixture = await mediaJoinedWidget(t, roomState(true)), { element, client } = fixture;
    await client['mediaTask']; await negotiate(fixture); await refresh(element); draft(element, 'private-mic-b'); media.holdCapture();
    const apply = t.mock.method(client, 'setInputDevice'), retry = t.mock.method(client, 'retryMicrophone');
    click(element['microphoneApply']); assertPicker(element, { value: 'private-mic-b', disabled: true, apply: true });
    assert.equal(element['micRetry'].disabled, false, 'the existing retry keeps its own SDK admission');
    click(element['micRetry']); assert.equal(retry.mock.callCount(), 1); assert.equal(apply.mock.callCount(), 1);
    await until(() => media.captures.length === 2, 'retry executes after queued input preference');
    assert.deepEqual((media.captures[1]!.constraints.audio as MediaTrackConstraints).deviceId, { exact: 'private-mic-b' });
    assert.equal(client['inputDeviceId'], 'private-mic-b'); assert.equal(client['mic'], null);
    media.captures[1]!.resolve(media.source()); await client['mediaTask']; await settle();
    assert.equal(media.Peer.instances[0]!.transceiver.sender.track, media.tracks.at(-1)); assertPicker(element, { value: 'private-mic-b' });
  });

  it('does not release Apply on an independent real preview micready, snapshots, or forced duplicate clicks', async t => {
    const media = fakeMedia(t), fixture = await mediaJoinedWidget(t, roomState(true)), { element, client, socket } = fixture;
    await client['mediaTask']; await negotiate(fixture); await refresh(element); draft(element, 'private-mic-a');
    const peer = media.Peer.instances[0]!, gate = peer.hold(), apply = t.mock.method(client, 'setInputDevice');
    click(element['microphoneApply']); await until(() => gate.entered, 'replacement waits for sender install');
    const attempt = element['inputDeviceAttempt'];
    const observations: { attempt: object | undefined; value: string; disabled: boolean[]; busy: string | null }[] = [];
    element.addEventListener('stage-micready', () => {
      observations.push({ attempt: element['inputDeviceAttempt'], value: element['microphoneSelect'].value,
        disabled: [element['microphoneSelect'].disabled, element['microphoneRefresh'].disabled, element['microphoneApply'].disabled],
        busy: element['microphoneApply'].getAttribute('aria-busy') });
      force(element['microphoneApply']); force(element['microphoneRefresh']);
    });
    const expected = { attempt, value: 'private-mic-a', disabled: [true, true, true], busy: 'true' };
    const preview = await client.startMicTest(); assert.deepEqual(observations, [expected]);
    socket.deliver({ type: 'room:state', ...roomState(true) });
    assertPicker(element, { value: 'private-mic-a', disabled: true, apply: true });
    assert.equal(apply.mock.callCount(), 1); assert.equal(media.enumerations.length, 1); assert.equal(client['inputDeviceId'], '');
    preview.stop(); gate.resolve(); await client['mediaTask']; await settle();
    assert.deepEqual(observations, [expected, expected]); assert.equal(apply.mock.callCount(), 1); assert.equal(client['inputDeviceId'], 'private-mic-a');
    assertPicker(element, { value: 'private-mic-a' });
  });

  it('makes no applied-device or audio-success claim when a stage-exit/re-entry setter fulfills without committing its choice', async t => {
    const media = fakeMedia(t), fixture = await mediaJoinedWidget(t, roomState(true)), { element, client, socket } = fixture;
    await client['mediaTask']; await negotiate(fixture); await refresh(element); draft(element, 'private-mic-a');
    const peer = media.Peer.instances[0]!, gate = peer.hold(), setter = t.mock.method(client, 'setInputDevice');
    const text = visibleText(element), owner = element['microphoneOwner'];
    click(element['microphoneApply']); await until(() => gate.entered, 'replacement is pending before stage exit');
    const attempt = element['inputDeviceAttempt'];
    socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver({ type: 'room:state', ...roomState(true) });
    assert.equal(element['microphoneOwner'], owner); assert.equal(element['inputDeviceAttempt'], attempt);
    assertPicker(element, { value: 'private-mic-a', disabled: true, apply: true });
    gate.resolve(); await setter.mock.calls[0]!.result; await client['mediaTask']; await settle();
    assert.equal(client['inputDeviceId'], '', 'the real SDK fulfilled without storing the retired replacement');
    assert.equal(media.tracks[1]!.stops, 1); assert.equal(peer.transceiver.sender.track, media.tracks[2]);
    assert.equal((media.captures[2]!.constraints.audio as MediaTrackConstraints).deviceId, undefined);
    assertPicker(element, { value: 'private-mic-a' }); assert.equal(visibleText(element), text);
    assert.doesNotMatch(visibleText(element), /已套用|切換成功|音訊已恢復|目前裝置：/);
  });

  it('preserves a healthy admitted replacement across signaling reconnect, but blocks further picker actions until resume', async t => {
    const media = fakeMedia(t), fixture = await mediaJoinedWidget(t, roomState(true));
    const { element, client, socket, sockets, tick, hello } = fixture;
    await client['mediaTask']; await negotiate(fixture); await refresh(element); draft(element, 'private-mic-a');
    const peer = media.Peer.instances[0]!, gate = peer.hold(), setter = t.mock.method(client, 'setInputDevice');
    click(element['microphoneApply']); await until(() => gate.entered, 'live switch admitted before socket loss');
    const owner = element['microphoneOwner'], attempt = element['inputDeviceAttempt'], listed = options(element);
    socket.close(); await settle();
    assert.equal(client.status, 'reconnecting'); assert.equal(element['microphoneOwner'], owner); assert.equal(element['inputDeviceAttempt'], attempt);
    assertPicker(element, { value: 'private-mic-a', disabled: true, apply: true }); assert.deepEqual(options(element), listed);
    force(element['microphoneApply']); force(element['microphoneRefresh']); assert.equal(setter.mock.callCount(), 1);
    gate.resolve(); await client['mediaTask']; await settle();
    assert.equal(client['inputDeviceId'], 'private-mic-a'); assert.equal(peer.transceiver.sender.track, media.tracks[1]);
    assertPicker(element, { value: 'private-mic-a', disabled: true }); assert.equal(media.Peer.instances.length, 1);
    await tick(500); const next = sockets[1]!, resume = await hello(next);
    next.deliver({ type: 'room:state', ...roomState(true) }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assertPicker(element, { value: 'private-mic-a' }); assert.equal(element['microphoneOwner'], owner); assert.deepEqual(options(element), listed);
    assert.equal(media.enumerations.length, 1); assert.equal(media.captures.length, 2);
  });

  it('retains a missing draft as an explicit unavailable choice and allows an intentional retry or default reset', async t => {
    const media = fakeMedia(t), { element, client } = await socketJoinedWidget(t);
    await refresh(element); draft(element, 'private-mic-a');
    media.list([device('private-mic-b', 'Available'), device('private-mic-b', 'Duplicate')]); await refresh(element);
    assertPicker(element, { value: 'private-mic-a' });
    assert.deepEqual(options(element).filter(option => option.value === 'private-mic-a'), [{ value: 'private-mic-a', label: '先前選擇（目前清單未提供）', disabled: true }]);
    assert.equal(options(element).filter(option => option.value === 'private-mic-b').length, 1);
    assert.doesNotMatch(visibleText(element), /private-mic/);
    const setter = t.mock.method(client, 'setInputDevice'); click(element['microphoneApply']); await client['mediaTask']; await settle();
    assert.deepEqual(setter.mock.calls[0]!.arguments, ['private-mic-a']); assert.equal(media.captures.length, 0);
    draft(element, ''); click(element['microphoneApply']); await client['mediaTask']; await settle();
    media.list([]); await refresh(element); assertPicker(element);
    assert.deepEqual(options(element), [{ value: '', label: '預設（依 SDK 設定）', disabled: false }]);
    assert.deepEqual(setter.mock.calls[1]!.arguments, ['']);
  });

  type Operation = 'refresh' | 'apply';
  const operationButton = (element: Widget, operation: Operation) => operation === 'refresh' ? element['microphoneRefresh'] : element['microphoneApply'];
  const operationAttempt = (element: Widget, operation: Operation) => operation === 'refresh' ? element['refreshAttempt'] : element['inputDeviceAttempt'];
  const operationBusy = (operation: Operation) => operation === 'refresh' ? { refresh: true } : { apply: true };
  function holdOperations(t: TestContext, client: StageClient, operation: Operation, callback?: () => void) {
    const requests: ReturnType<typeof pending<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>>[] = [];
    const invoke = () => { const request = pending<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>(); requests.push(request); callback?.(); return request.promise; };
    if (operation === 'refresh') t.mock.method(client, 'listAudioDevices', invoke);
    else t.mock.method(client, 'setInputDevice', () => invoke().then(() => {}));
    return requests;
  }
  const result = (label = 'Current list') => ({ inputs: [device('private-mic-a', label), device('private-mic-b')], outputs: [] });

  for (const operation of ['refresh', 'apply'] as const) {
    it(`reserves ${operation} before a synchronous public-SDK callback and blocks both forced duplicate handlers`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t); await seed(t, element, client); draft(element, 'private-mic-a');
      const listed = options(element); let callbacks = 0;
      element.addEventListener('stage-state', () => {
        callbacks++; assertPicker(element, { value: 'private-mic-a', disabled: true, ...operationBusy(operation) });
        force(element['microphoneRefresh']); force(element['microphoneApply']);
      }, { once: true });
      const requests = holdOperations(t, client, operation, () => socket.deliver({ type: 'room:state', ...roomState() }));
      click(operationButton(element, operation)); assert.equal(callbacks, 1); assert.equal(requests.length, 1);
      assert.deepEqual(options(element), listed); assert.equal(element['pendingActions'].has(operationButton(element, operation)), false);
      force(element['microphoneRefresh']); force(element['microphoneApply']); assert.equal(requests.length, 1);
      client.dispatchEvent(new CustomEvent('micready', { detail: undefined }));
      assertPicker(element, { value: 'private-mic-a', disabled: true, ...operationBusy(operation) });
      socket.deliver({ type: 'error', code: 'conflict', message: 'Independent current failure' });
      requests[0]!.resolve(result()); await settle(); await settle();
      assertPicker(element, { value: 'private-mic-a' }); assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Independent current failure');
    });

    for (const outcome of ['throw', 'reject'] as const) {
      it(`shows a current ${operation} ${outcome}, keeps its list/draft, and permits an explicit new attempt`, async t => {
        const { element, client } = await socketJoinedWidget(t); await seed(t, element, client); draft(element, 'private-mic-b');
        const listed = options(element), failure = new Error(`current ${operation} ${outcome}`);
        const run = () => { if (outcome === 'throw') throw failure; return Promise.reject(failure); };
        if (operation === 'refresh') t.mock.method(client, 'listAudioDevices', run); else t.mock.method(client, 'setInputDevice', run);
        click(operationButton(element, operation)); await settle();
        assertPicker(element, { value: 'private-mic-b' }); assert.deepEqual(options(element), listed);
        assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, failure.message);
        const requests = holdOperations(t, client, operation); click(operationButton(element, operation));
        assert.equal(requests.length, 1); assert.equal(element['error'].hidden, true);
        requests[0]!.resolve(result()); await settle(); await settle(); assertPicker(element, { value: 'private-mic-b' });
      });
    }

    for (const outcome of ['resolve', 'reject'] as const) {
      it(`retains ${operation} ownership through reconnect and its ${outcome} without allowing a second operation`, async t => {
        const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t); await seed(t, element, client); draft(element, 'private-mic-a');
        const requests = holdOperations(t, client, operation); click(operationButton(element, operation));
        const owner = element['microphoneOwner'], attempt = operationAttempt(element, operation), listed = options(element);
        element.addEventListener('stage-status', () => {
          assertPicker(element, { value: 'private-mic-a', disabled: true, ...operationBusy(operation) });
          force(element['microphoneRefresh']); force(element['microphoneApply']);
        }, { once: true });
        socket.close(); await settle(); assert.equal(element['microphoneOwner'], owner); assert.equal(operationAttempt(element, operation), attempt);
        assert.deepEqual(options(element), listed); assert.equal(requests.length, 1);
        await tick(500); const next = sockets[1]!, resume = await hello(next);
        next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
        assertPicker(element, { value: 'private-mic-a', disabled: true, ...operationBusy(operation) });
        force(element['microphoneRefresh']); force(element['microphoneApply']); assert.equal(requests.length, 1);
        if (outcome === 'resolve') requests[0]!.resolve(result()); else requests[0]!.reject(new Error('current reconnect operation failure'));
        await settle(); await settle(); assertPicker(element, { value: 'private-mic-a' });
        assert.equal(element['microphoneOwner'], owner); assert.equal(element['error'].hidden, outcome === 'resolve');
        if (outcome === 'reject') assert.equal(element['error'].textContent, 'current reconnect operation failure');
      });
    }

    for (const transition of ['room', 'participant'] as const) for (const outcome of ['resolve', 'reject'] as const) {
      it(`isolates retired ${operation} ${outcome} from a new ${transition} owner's operation, including nested state callbacks`, async t => {
        const { element, client, socket } = await socketJoinedWidget(t); await seed(t, element, client); draft(element, 'private-mic-a');
        const requests = holdOperations(t, client, operation); click(operationButton(element, operation));
        const oldOwner = element['microphoneOwner'];
        const next = roomState(false, transition === 'room' ? 'two' : 'one'); if (transition === 'participant') next.me.participantId = 'fresh-seat';
        let forwards = 0;
        element.addEventListener('stage-state', () => {
          forwards++; assertPicker(element); assert.notEqual(element['microphoneOwner'], oldOwner);
          click(operationButton(element, operation));
        }, { once: true });
        socket.deliver({ type: 'room:state', ...next }); assert.equal(forwards, 1); assert.equal(requests.length, 2);
        const owner = element['microphoneOwner'], attempt = operationAttempt(element, operation);
        socket.deliver({ type: 'error', code: 'conflict', message: 'New owner failure' });
        if (outcome === 'resolve') requests[0]!.resolve(result('Retired private label')); else requests[0]!.reject(new Error('Retired operation failure'));
        await settle(); await settle();
        assert.equal(element['microphoneOwner'], owner); assert.equal(operationAttempt(element, operation), attempt);
        assertPicker(element, { disabled: true, ...operationBusy(operation) }); assert.doesNotMatch(visibleText(element), /Retired private label/);
        assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'New owner failure');
        requests[1]!.resolve(result()); await settle(); await settle(); assertPicker(element);
      });
    }

    for (const transition of ['leave', 'detach', 'direct disconnect', 'ordinary close', 'kick', 'shutdown'] as const) {
      it(`retires pending ${operation}, list and draft immediately on ${transition} and rejects stale forced buttons`, async t => {
        const { element, client, socket } = await socketJoinedWidget(t); await seed(t, element, client); draft(element, 'private-mic-a');
        const requests = holdOperations(t, client, operation); click(operationButton(element, operation));
        if (transition === 'leave') click(element['roomAction']);
        else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
        else if (transition === 'direct disconnect') await client.disconnect();
        else {
          const terminal = terminalCases.find(item => item.title === transition)!;
          element.addEventListener(`stage-${terminal.event}`, () => {
            assertRetired(element); force(element['microphoneRefresh']); force(element['microphoneApply']); assertRetired(element);
          }, { once: true });
          socket.deliver(terminal.message);
        }
        await settle(); assertRetired(element); const message = element['error'].textContent, hidden = element['error'].hidden;
        force(element['microphoneRefresh']); force(element['microphoneApply']); assert.equal(requests.length, 1); assertRetired(element);
        requests[0]!.reject(new Error('retired late failure')); await settle(); await settle();
        assertRetired(element); assert.equal(element['error'].textContent, message); assert.equal(element['error'].hidden, hidden);
      });
    }

    for (const guard of ['detached', 'current cleared', 'snapshot cleared', 'unknown status'] as const) {
      it(`rejects still-callable ${operation} when ${guard}, without clearing an independent alert`, async t => {
        const { element, client, socket } = await socketJoinedWidget(t); await seed(t, element, client);
        const requests = holdOperations(t, client, operation);
        socket.deliver({ type: 'error', code: 'conflict', message: 'Existing guarded failure' });
        if (guard === 'detached') Object.assign(element, { isConnected: false });
        else if (guard === 'current cleared') element['current'] = null;
        else if (guard === 'snapshot cleared') client['snapshot'] = null;
        else client['currentStatus'] = 'unknown' as typeof client.status;
        force(operationButton(element, operation)); assert.equal(requests.length, 0); assertRetired(element);
        assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Existing guarded failure');
        await client.disconnect();
      });
    }
  }

  for (const operation of ['refresh', 'apply'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    it(`isolates ${operation} late ${outcome} after attribute client replacement and a new pending operation`, async t => {
      const { element, client, socket, sockets, hello } = await socketJoinedWidget(t); await seed(t, element, client); draft(element, 'private-mic-a');
      const oldRequests = holdOperations(t, client, operation); click(operationButton(element, operation));
      const oldMessage = socket.onmessage, oldClose = socket.onclose;
      element.setAttribute('room', 'two'); await settle(); await settle(); assertRetired(element);
      const current = element.client!, next = sockets[1]!, join = await hello(next);
      assert.notEqual(current, client);
      next.deliver({ type: 'room:state', ...roomState(false, 'two') }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
      assertPicker(element); const requests = holdOperations(t, current, operation); click(operationButton(element, operation));
      const owner = element['microphoneOwner'], attempt = operationAttempt(element, operation);
      next.deliver({ type: 'error', code: 'conflict', message: 'Current client failure' });
      if (outcome === 'resolve') oldRequests[0]!.resolve(result('Retired label')); else oldRequests[0]!.reject(new Error('Retired client failure'));
      oldMessage?.({ data: JSON.stringify({ type: 'room:state', ...roomState() }) }); oldClose?.();
      client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); await settle(); await settle();
      assert.equal(element['microphoneOwner'], owner); assert.equal(operationAttempt(element, operation), attempt);
      assertPicker(element, { disabled: true, ...operationBusy(operation) }); assert.doesNotMatch(visibleText(element), /Retired label/);
      assert.equal(element['error'].textContent, 'Current client failure'); assert.equal(element['error'].hidden, false);
      requests[0]!.resolve(result()); await settle(); await settle(); assertPicker(element);
    });
  }

  for (const operation of ['refresh', 'apply'] as const) {
    it(`retires a pre-ACK ${operation} snapshot on socket loss and survives public same-client silent disconnect/rejoin`, async t => {
      const { element, sockets, hello, tick, joinRequest } = socketJoiningWidget(t); await settle();
      const socket = sockets[0]!, initial = await hello(socket), client = element.client!;
      socket.deliver({ type: 'room:state', ...roomState() });
      assert.equal(client['session'], null); assert.equal(client['pending'].has(initial.requestId), true);
      await seed(t, element, client); draft(element, 'private-mic-a');
      const requests = holdOperations(t, client, operation); click(operationButton(element, operation)); const retired = element['microphoneOwner'];
      socket.close(); await settle(); assert.equal(client.status, 'disconnected'); assert.ok(client.state); assertRetired(element);
      let statuses = 0; element.addEventListener('stage-status', () => { statuses++; });
      await client.disconnect(); assert.equal(statuses, 0, 'silent repeat disconnect has no status transition'); assert.equal(client.state, null);
      const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
      const joining = client.join({ roomId: 'one', name: 'Fresh same seat' }); await settle(); await tick(100);
      const request = joinRequest(next);
      next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: request.requestId }); await joining;
      assertPicker(element); assert.notEqual(element['microphoneOwner'], retired);
      click(operationButton(element, operation)); assert.equal(requests.length, 2); const attempt = operationAttempt(element, operation);
      next.deliver({ type: 'error', code: 'conflict', message: 'Fresh same-seat failure' });
      requests[0]!.reject(new Error('Retired pre-ACK failure')); await settle(); await settle();
      assert.equal(operationAttempt(element, operation), attempt); assertPicker(element, { disabled: true, ...operationBusy(operation) });
      assert.equal(element['error'].textContent, 'Fresh same-seat failure'); requests[1]!.resolve(result()); await settle(); await settle(); assertPicker(element);
    });
  }

  for (const terminal of terminalCases) for (const identity of ['same', 'new'] as const) {
    it(`allows public same-client ${terminal.title} rejoin with a ${identity} identity and isolates a retired refresh result`, async t => {
      const { element, client, socket, sockets, tick, joinRequest } = await socketJoinedWidget(t);
      await seed(t, element, client); draft(element, 'private-mic-a'); const requests = holdOperations(t, client, 'refresh');
      click(element['microphoneRefresh']); const retired = element['microphoneOwner'];
      socket.deliver(terminal.message); await settle(); assertRetired(element);
      const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
      const joining = client.join({ roomId: 'one', name: 'New join' }); await settle(); await tick(100);
      const request = joinRequest(next), state = roomState(); if (identity === 'new') state.me.participantId = 'fresh-participant';
      next.deliver({ type: 'room:state', ...state }); next.deliver({ type: 'ok', requestId: request.requestId }); await joining;
      assertPicker(element); assert.notEqual(element['microphoneOwner'], retired); assert.equal(element.client, client);
      click(element['microphoneRefresh']); assert.equal(requests.length, 2); const attempt = element['refreshAttempt'];
      requests[0]!.resolve(result('Old terminal list')); await settle(); await settle();
      assert.equal(element['refreshAttempt'], attempt); assertPicker(element, { disabled: true, refresh: true });
      assert.doesNotMatch(visibleText(element), /Old terminal list/);
      requests[1]!.resolve(result('Fresh terminal list')); await settle(); await settle(); assertPicker(element);
      assert.match(visibleText(element), /Fresh terminal list/);
    });
  }

  it('clears device privacy state on remount, retains explicit room-leave consent, and starts a fresh owner only after manual rejoin', async t => {
    const { element, client, sockets, hello } = await socketJoinedWidget(t);
    await seed(t, element, client); draft(element, 'private-mic-a'); const requests = holdOperations(t, client, 'refresh'); click(element['microphoneRefresh']);
    click(element['roomAction']); await settle(); assertRetired(element);
    Object.assign(element, { isConnected: false }); element.disconnectedCallback();
    Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
    assertRetired(element); assert.equal(element.client, null); assert.equal(sockets.length, 1);
    requests[0]!.resolve(result('Retired remount list')); await settle(); assertRetired(element);
    click(element['roomAction']); await settle(); const current = element.client!, next = sockets[1]!, join = await hello(next);
    next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    assert.notEqual(current, client); assertPicker(element); assert.equal(options(element).length, 1); assert.doesNotMatch(visibleText(element), /Retired remount list/);
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`checks real enumeration ${outcome} against silent public snapshot retirement before updating any UI`, async t => {
      const media = fakeMedia(t), { element, client, socket } = await socketJoinedWidget(t);
      await refresh(element); draft(element, 'private-mic-a'); media.holdEnumeration(); click(element['microphoneRefresh']);
      assert.equal(media.enumerations.length, 2); socket.deliver({ type: 'error', code: 'conflict', message: 'Unrelated visible failure' });
      // An already-disconnected public client can clear its retained snapshot without another event.
      client['currentStatus'] = 'disconnected'; await client.disconnect();
      assert.equal(client.state, null);
      if (outcome === 'resolve') media.enumerations[1]!.resolve([device('retired-id', 'Retired enumeration label')]);
      else media.enumerations[1]!.reject(new Error('Retired enumeration rejection'));
      await settle(); await settle(); assertRetired(element); assert.doesNotMatch(visibleText(element), /Retired enumeration label/);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Unrelated visible failure'); assert.equal(media.captures.length, 0);
    });
  }

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`ignores real late enumeration ${outcome} while a replacement seat's enumeration is pending`, async t => {
      const media = fakeMedia(t), { element, client, socket } = await socketJoinedWidget(t);
      await refresh(element); draft(element, 'private-mic-a'); media.holdEnumeration(); click(element['microphoneRefresh']);
      const next = roomState(); next.me.participantId = 'replacement-seat'; socket.deliver({ type: 'room:state', ...next });
      assertPicker(element); click(element['microphoneRefresh']); const attempt = element['refreshAttempt'];
      assert.equal(media.enumerations.length, 3);
      socket.deliver({ type: 'error', code: 'conflict', message: 'Replacement-seat current failure' });
      if (outcome === 'resolve') media.enumerations[1]!.resolve([device('retired-input', 'Retired native enumeration label')]);
      else media.enumerations[1]!.reject(new Error('Retired native enumeration failure'));
      await settle(); await settle(); assertPicker(element, { disabled: true, refresh: true });
      assert.equal(element['refreshAttempt'], attempt); assert.doesNotMatch(visibleText(element), /Retired native/);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Replacement-seat current failure');
      media.enumerations[2]!.resolve([device('new-input', 'Fresh enumeration')]); await settle(); await settle();
      assertPicker(element); assert.match(visibleText(element), /Fresh enumeration/); assert.equal(media.captures.length, 0);
      assert.equal(client.me!.participantId, 'replacement-seat');
    });

    it(`allows an admitted enumeration to ${outcome} during reconnect while keeping all picker controls disabled until resume`, async t => {
      const media = fakeMedia(t), { element, socket, sockets, tick, hello } = await socketJoinedWidget(t);
      await refresh(element); draft(element, 'private-mic-a'); media.holdEnumeration(); click(element['microphoneRefresh']);
      const owner = element['microphoneOwner']; socket.close(); await settle();
      assertPicker(element, { value: 'private-mic-a', disabled: true, refresh: true });
      if (outcome === 'resolve') media.enumerations[1]!.resolve([device('private-mic-a', 'Updated during reconnect')]);
      else media.enumerations[1]!.reject(new Error('Enumeration failed during reconnect'));
      await settle(); await settle(); assertPicker(element, { value: 'private-mic-a', disabled: true });
      force(element['microphoneRefresh']); force(element['microphoneApply']); assert.equal(media.enumerations.length, 2);
      assert.equal(element['microphoneOwner'], owner); assert.equal(media.captures.length, 0);
      if (outcome === 'resolve') assert.match(visibleText(element), /Updated during reconnect/);
      else assert.equal(element['error'].textContent, 'Enumeration failed during reconnect');
      await tick(500); const next = sockets[1]!, resume = await hello(next);
      next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
      assertPicker(element, { value: 'private-mic-a' }); assert.equal(element['microphoneOwner'], owner); assert.equal(media.enumerations.length, 2);
    });
  }

  it('retires a draft after a nested forwarded callback clears the public snapshot, and does not create an owner from a new reconnect-only identity', async t => {
    const { element, client, socket } = await socketJoinedWidget(t); await seed(t, element, client); draft(element, 'private-mic-a');
    const requests = holdOperations(t, client, 'refresh'); click(element['microphoneRefresh']);
    element.addEventListener('stage-micready', () => { client['snapshot'] = null; }, { once: true });
    client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); assertRetired(element);
    requests[0]!.resolve(result('Nested retired list')); await settle(); assertRetired(element);
    const next = roomState(); next.me.participantId = 'different-reconnecting-seat';
    client['snapshot'] = next; client['currentStatus'] = 'reconnecting';
    client.dispatchEvent(new CustomEvent('status', { detail: 'reconnecting' })); assertRetired(element);
    force(element['microphoneRefresh']); force(element['microphoneApply']); assert.equal(requests.length, 1); assertRetired(element);
    socket.deliver({ type: 'room:state', ...next }); assertPicker(element); assert.equal(options(element).length, 1);
  });
});

describe('widget controller stage management panel', () => {
  type Widget = InstanceType<typeof StageElement>;
  type StageRequest = Extract<ClientMessage, { type: 'mic:force-mute' | 'mic:force-unmute' | 'stage:remove' | 'control:transfer' }>;
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  const text = (node: Node): string => [node.textContent, ...node.children.map(text)].join(' ');
  const visibleText = (node: Node): string => node.hidden ? '' : [node.textContent, ...node.children.map(visibleText)].join(' ');
  function panel(element: Widget): Node {
    const matches = nodes(element as unknown as Node).filter(node => node.part.has('stage-management'));
    assert.equal(matches.length, 1, 'one stage-management styling part');
    assert.equal(matches[0]!.tagName, 'DETAILS'); return matches[0]!;
  }
  function view(element: Widget) {
    const disclosure = panel(element), summary = disclosure.children.find(node => node.tagName === 'SUMMARY');
    const list = disclosure.children.find(node => node.tagName === 'UL'), notice = disclosure.children.find(node => node.tagName === 'P');
    assert.ok(summary && list && notice, 'native disclosure with a list and ordinary notice');
    assert.equal(notice.getAttribute('role'), null); assert.equal(notice.getAttribute('aria-live'), null);
    return { disclosure, summary, list, notice, rows: list.children };
  }
  function buttons(row: Node) {
    assert.equal(row.tagName, 'LI');
    const found = nodes(row).filter(node => node.tagName === 'BUTTON');
    assert.equal(found.length, 4, 'force-lock, remove-from-stage, confirmed control transfer and explicit gain Apply');
    assert.equal(found.filter(button => button.textContent === '套用混音增益').length, 1);
    found.forEach(button => assert.equal(button.type, 'button'));
    const mute = found.find(button => /靜音/.test(button.textContent)), remove = found.find(button => button.textContent === '移下台');
    const transfer = found.find(button => button.textContent === '移交控制權');
    assert.ok(mute && remove && transfer); return { mute, remove, transfer };
  }
  function press(button: Node): void { button.onclick?.(); }
  function force(button: Node): void { const disabled = button.disabled; button.disabled = false; try { press(button); } finally { button.disabled = disabled; } }
  function flags(row: Node) { return Object.values(buttons(row)).map(button => ({ disabled: button.disabled, busy: button.getAttribute('aria-busy') === 'true' })); }
  function peek(element: Widget) {
    return { disclosure: element['stageManagementPanel'] as unknown as Node, rows: (element['stageManagementList'] as unknown as Node).children };
  }
  function reenter(row: Node | undefined): void {
    if (row) for (const button of Object.values(buttons(row))) force(button);
  }
  function busy(row: Node, expected: boolean, disabled = expected, transferDisabled = disabled): void {
    assert.deepEqual(flags(row), [{ disabled, busy: expected }, { disabled, busy: expected }, { disabled: transferDisabled, busy: false }]);
  }
  function retired(element: Widget): void {
    const current = view(element); assert.equal(current.disclosure.hidden, true); assert.equal(current.disclosure.open, false);
    assert.deepEqual(current.rows, [], 'retirement clears target identities and actions');
    assert.doesNotMatch(text(current.disclosure), /Managed speaker|Private audience/);
  }
  function state(ids = ['first', 'second'], onStage = false, roomId = 'one'): RoomStatePayload {
    const snapshot = controllerState(onStage, roomId);
    snapshot.speakers = ids.map(participantId => ({ ...roomState(true).me, participantId, name: `Managed speaker ${participantId}` }));
    return snapshot;
  }
  function requests(socket: { sent: ClientMessage[] }): StageRequest[] {
    return socket.sent.filter((message): message is StageRequest => ['mic:force-mute', 'mic:force-unmute', 'stage:remove', 'control:transfer'].includes(message.type));
  }
  function request(socket: { sent: ClientMessage[] }): StageRequest { const sent = requests(socket).at(-1); assert.ok(sent); return sent; }
  function error(socket: { deliver(message: ServerMessage): void }, message = 'Current independent error'): void {
    socket.deliver({ type: 'error', code: 'conflict', message });
  }

  it('exposes a collapsed native controller-only disclosure onstage or offstage and keeps an empty list ordinary', async t => {
    const unjoined = new StageElement(); widgets.push(unjoined); retired(unjoined);
    const { element, client } = await subscribedWidget(t); retired(element);
    for (const role of ['audience', 'speaker'] as const) {
      const next = state(); next.me.role = role; next.me.onStage = role === 'speaker'; next.controllerId = 'host';
      await client['receive']({ type: 'room:state', ...next }); retired(element);
    }
    const stable = panel(element);
    for (const onStage of [false, true]) {
      await client['receive']({ type: 'room:state', ...state([], onStage) });
      const current = view(element); assert.equal(current.disclosure, stable); assert.equal(stable.hidden, false); assert.equal(stable.open, false);
      assert.match(current.summary.textContent, /舞台管理.*0/); assert.equal(current.notice.hidden, false); assert.ok(current.notice.textContent);
      assert.equal(element['hand'].hidden, true);
    }
    await client.disconnect(); retired(element);
  });

  it('renders unique current other speakers in snapshot order with plain once-decoded names, effective mute, lock and offline status', async t => {
    const initial = state(['z', 'a', 'same-name']);
    initial.speakers[0]!.name = '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Q&quot; &#39;S&#39; &amp;lt;';
    initial.speakers[1]!.name = initial.speakers[2]!.name = 'Same name';
    initial.speakers[1]!.muted = true;
    initial.speakers[2]!.muted = true; initial.speakers[2]!.forceMuted = true; initial.speakers[2]!.connected = false;
    initial.speakers.push({ ...initial.speakers[0]! }, { ...initial.me, onStage: true },
      { ...initial.speakers[0]!, participantId: 'offstage', onStage: false },
      { ...initial.speakers[0]!, participantId: 'unknown', role: 'unknown' as 'speaker' });
    initial.audience = [{ ...roomState().me, participantId: 'private', name: 'Private audience' }]; initial.code = 'PRIVATE-CODE';
    const { element, socket } = await socketJoinedWidget(t, initial), current = view(element), rows = [...current.rows];
    assert.equal(rows.length, 3); assert.match(current.summary.textContent, /3/);
    assert.match(text(rows[0]!), /<img src=x onerror=alert\(1\)> & "Q" 'S' &lt;/);
    assert.match(text(rows[0]!), /未靜音/); assert.match(text(rows[1]!), /已靜音/); assert.match(text(rows[2]!), /已鎖定靜音/);
    assert.match(text(rows[2]!), /離線|未連線|斷線/); assert.equal(buttons(rows[1]!).mute.textContent, '鎖定靜音');
    assert.equal(buttons(rows[2]!).mute.textContent, '解除靜音鎖定'); busy(rows[2]!, false, false, true);
    assert.doesNotMatch(visibleText(element as unknown as Node), /Private audience|PRIVATE-CODE/);
    for (const node of nodes(current.disclosure)) { assert.equal(Reflect.get(node, 'innerHTML'), undefined); assert.ok(!['IMG', 'SCRIPT'].includes(node.tagName)); }
    assert.doesNotMatch(text(current.disclosure), /踢出|移出房間/);
    assert.equal(nodes(current.disclosure).filter(node => node.tagName === 'INPUT' && node.type === 'number').length, 3);
    current.disclosure.open = true; const replace = t.mock.method(current.list, 'replaceChildren'), renamed = structuredClone(initial);
    renamed.speakers[1]!.name = 'Renamed &amp; safe'; renamed.speakers[1]!.forceMuted = true;
    socket.deliver({ type: 'room:state', ...renamed });
    assert.deepEqual(view(element).rows, rows); assert.equal(panel(element).open, true); assert.equal(replace.mock.callCount(), 0);
    assert.equal(buttons(rows[1]!).mute.textContent, '解除靜音鎖定');
    for (const button of Object.values(buttons(rows[1]!))) assert.match(button.getAttribute('aria-label') ?? '', /Renamed & safe/);
    const reordered = state(['same-name', 'a', 'z']); socket.deliver({ type: 'room:state', ...reordered });
    assert.deepEqual(view(element).rows, [...rows].reverse()); assert.equal(panel(element).open, true);
  });

  it('branches from the current force-lock snapshot, even when effective mute and an unrendered name disagree with the old button', async t => {
    const initial = state(); initial.speakers[0]!.muted = true;
    const { element, client, socket, tick } = await socketJoinedWidget(t, initial), row = view(element).rows[0]!;
    assert.equal(buttons(row).mute.textContent, '鎖定靜音');
    client.state!.speakers[0]!.forceMuted = true; client.state!.speakers[0]!.name = 'Latest &amp; name';
    press(buttons(row).mute); busy(row, true); await tick(100);
    const sent = request(socket); assert.equal(sent.type, 'mic:force-unmute'); assert.equal(sent.targetId, 'first');
    assert.equal(buttons(row).mute.textContent, '解除靜音鎖定'); assert.match(buttons(row).mute.getAttribute('aria-label') ?? '', /Latest & name/);
    socket.deliver({ type: 'ok', requestId: sent.requestId }); await settle(); busy(row, false);
  });

  for (const action of ['mute', 'remove'] as const) for (const outcome of ['ok', 'reject'] as const) {
    it(`retains the ${action} target lock through state-before-ACK disappearance/reappearance and isolates a retired row's ${outcome}`, async t => {
      const { element, socket, tick } = await socketJoinedWidget(t, state()), original = view(element).rows[0]!, old = buttons(original);
      press(old[action]); force(old.mute); force(old.remove); busy(original, true); await tick(100); const first = request(socket);
      socket.deliver({ type: 'room:state', ...state(['second']) });
      assert.equal(old.mute.disabled, true); assert.equal(old.remove.disabled, true);
      socket.deliver({ type: 'room:state', ...state() }); const fresh = view(element).rows[0]!;
      assert.notEqual(fresh, original); busy(fresh, true); error(socket, 'Reappeared row current error');
      force(old.mute); force(old.remove); force(buttons(fresh).mute); force(buttons(fresh).remove); await tick(100);
      assert.equal(requests(socket).length, 1); assert.equal(element['error'].textContent, 'Reappeared row current error');
      if (outcome === 'ok') socket.deliver({ type: 'ok', requestId: first.requestId });
      else socket.deliver({ type: 'error', code: 'conflict', message: 'Global wire rejection', requestId: first.requestId });
      await settle(); busy(fresh, false);
      // Wire errors retain the SDK-wide error contract even though the retired row's catch cannot own new UI.
      assert.equal(element['error'].textContent, outcome === 'ok' ? 'Reappeared row current error' : 'Global wire rejection');
      force(old.mute); force(old.remove); assert.equal(requests(socket).length, 1);
      press(buttons(fresh)[action]); await tick(100); const active = request(socket); assert.notEqual(active.requestId, first.requestId);
      socket.deliver({ type: 'ok', requestId: first.requestId }); await settle(); busy(fresh, true);
      socket.deliver({ type: 'ok', requestId: active.requestId }); await settle(); busy(fresh, false);
    });
  }

  for (const action of ['mute', 'remove'] as const) {
    it(`suppresses the disappeared ${action} row's delayed promise catch while unlocking only its own reappeared target`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), pending = deferred(), second = deferred();
      const method = action === 'mute' ? 'forceMute' : 'removeFromStage'; let calls = 0;
      t.mock.method(client, method, () => (++calls === 1 ? pending : second).promise);
      const old = buttons(view(element).rows[0]!); press(old[action]);
      socket.deliver({ type: 'room:state', ...state(['second']) }); socket.deliver({ type: 'room:state', ...state() });
      const fresh = view(element).rows[0]!, independent = view(element).rows[1]!; press(buttons(independent)[action]);
      error(socket, 'Keep reappeared error'); pending.reject(new Error('Retired row promise rejection')); await settle();
      busy(fresh, false, false, true); busy(independent, true); assert.equal(element['error'].textContent, 'Keep reappeared error');
      force(old.mute); force(old.remove); assert.equal(calls, 2); second.resolve(); await settle(); busy(independent, false);
    });
  }

  it('shares mute/remove pending per exact participant ID while allowing another identically named target independently', async t => {
    const initial = state(); initial.speakers.forEach(person => { person.name = 'Same name'; });
    const { element, socket, tick } = await socketJoinedWidget(t, initial), [first, second] = view(element).rows; assert.ok(first && second);
    press(buttons(first).mute); force(buttons(first).remove); press(buttons(second).remove); force(buttons(second).mute); await tick(200);
    busy(first, true); busy(second, true); assert.deepEqual(requests(socket).map(message => [message.type, message.targetId]), [['mic:force-mute', 'first'], ['stage:remove', 'second']]);
    const [a, b] = requests(socket); socket.deliver({ type: 'ok', requestId: b!.requestId }); await settle(); busy(second, false, false, true); busy(first, true);
    socket.deliver({ type: 'error', code: 'conflict', message: 'First target failure', requestId: a!.requestId }); await settle(); busy(first, false);
    assert.equal(element['error'].textContent, 'First target failure');
  });

  for (const callback of ['stage-status', 'stage-state'] as const) {
    it(`prepares the stage rows before forwarded ${callback} and reserves a reentrant target before initial join ACK`, async t => {
      const { element, sockets, hello, tick } = socketJoiningWidget(t); await settle(); const socket = sockets[0]!, join = await hello(socket);
      const observed: { hidden: boolean; rows: number; flags: ReturnType<typeof flags> }[] = [];
      element.addEventListener(callback, () => {
        const current = peek(element), row = current.rows[0]; reenter(row);
        observed.push({ hidden: current.disclosure.hidden, rows: current.rows.length, flags: row ? flags(row) : [] });
      }, { once: true });
      socket.deliver({ type: 'room:state', ...state() }); await tick(100);
      assert.deepEqual(observed, [{ hidden: false, rows: 2, flags: [{ disabled: true, busy: true }, { disabled: true, busy: true }, { disabled: true, busy: false }] }]);
      assert.equal(requests(socket).length, 1); const sent = request(socket);
      socket.deliver({ type: 'ok', requestId: join.requestId }); await settle(); busy(view(element).rows[0]!, true);
      socket.deliver({ type: 'ok', requestId: sent.requestId }); await settle(); busy(view(element).rows[0]!, false);
    });
  }

  it('reserves the target before invoking an SDK method that synchronously forwards state and attempts both actions', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state()), pending = deferred();
    const observed: ReturnType<typeof flags>[] = [];
    element.addEventListener('stage-state', () => {
      const row = peek(element).rows[0]; observed.push(row ? flags(row) : []); reenter(row);
    }, { once: true });
    const mute = t.mock.method(client, 'forceMute', () => { socket.deliver({ type: 'room:state', ...state() }); return pending.promise; });
    const remove = t.mock.method(client, 'removeFromStage', async () => {}); press(buttons(view(element).rows[0]!).mute);
    assert.deepEqual(observed, [[{ disabled: true, busy: true }, { disabled: true, busy: true }, { disabled: true, busy: false }]]);
    assert.equal(mute.mock.callCount(), 1); assert.equal(remove.mock.callCount(), 0); pending.resolve(); await settle(); busy(view(element).rows[0]!, false);
  });

  it('rejects stale membership, self, offstage, unknown role and detached admission without clearing independent errors', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state());
    const mute = t.mock.method(client, 'forceMute', async () => {}), unmute = t.mock.method(client, 'forceUnmute', async () => {}), remove = t.mock.method(client, 'removeFromStage', async () => {});
    for (const invalid of ['missing', 'self', 'offstage', 'unknown', 'detached', 'current cleared', 'snapshot cleared', 'unknown status'] as const) {
      element['current'] = client; Object.assign(element, { isConnected: true }); socket.deliver({ type: 'room:state', ...state() });
      const old = buttons(view(element).rows[0]!); error(socket, `Keep ${invalid}`);
      if (invalid === 'missing') client.state!.speakers.splice(0, 1);
      else if (invalid === 'self') client.state!.me.participantId = 'first';
      else if (invalid === 'offstage') client.state!.speakers[0]!.onStage = false;
      else if (invalid === 'unknown') client.state!.speakers[0]!.role = 'unknown' as 'speaker';
      else if (invalid === 'detached') Object.assign(element, { isConnected: false });
      else if (invalid === 'current cleared') element['current'] = null;
      else if (invalid === 'snapshot cleared') client['snapshot'] = null;
      else client['currentStatus'] = 'unknown' as typeof client.status;
      force(old.mute); force(old.remove); await settle();
      assert.equal(mute.mock.callCount(), 0); assert.equal(unmute.mock.callCount(), 0); assert.equal(remove.mock.callCount(), 0);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, `Keep ${invalid}`);
    }
    element['current'] = client; Object.assign(element, { isConnected: true }); await client.disconnect();
  });

  for (const transition of ['role', 'room', 'participant', 'generation'] as const) {
    it(`retires ${transition} ownership before forwarded reentry and prevents old finally from unlocking a fresh same-target request`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), old = deferred(), active = deferred(); let calls = 0;
      t.mock.method(client, 'forceMute', () => (++calls === 1 ? old : active).promise);
      const original = view(element).rows[0]!, oldButtons = buttons(original); panel(element).open = true; press(oldButtons.mute);
      const observed: { calls: number; oldDisabled: boolean[]; error: string | null }[] = [];
      element.addEventListener('stage-state', () => {
        error(socket, 'Keep ownership change error'); force(oldButtons.mute); force(oldButtons.remove);
        observed.push({ calls, oldDisabled: Object.values(oldButtons).map(button => button.disabled), error: element['error'].textContent });
      }, { once: true });
      const next = state();
      if (transition === 'role') { next.me.role = 'audience'; next.controllerId = 'another'; }
      else if (transition === 'room') next.roomId = 'two';
      else if (transition === 'participant') { next.me.participantId = 'new-controller'; next.controllerId = 'new-controller'; }
      else ++element['generation'];
      if (transition === 'generation') element['render'](); else socket.deliver({ type: 'room:state', ...next });
      if (transition === 'role') retired(element);
      if (transition === 'generation') element['render'](); else socket.deliver({ type: 'room:state', ...state() });
      if (transition !== 'generation') assert.deepEqual(observed, [{ calls: 1, oldDisabled: [true, true, true], error: 'Keep ownership change error' }]);
      const fresh = view(element).rows[0]!; assert.notEqual(fresh, original); assert.equal(panel(element).open, false); press(buttons(fresh).mute);
      assert.equal(calls, 2); busy(fresh, true); element['show'](new Error('Fresh target error')); old.reject(new Error('Old owner rejection')); await settle();
      busy(fresh, true); assert.equal(element['error'].textContent, 'Fresh target error'); force(oldButtons.mute); force(oldButtons.remove); assert.equal(calls, 2);
      active.resolve(); await settle(); busy(fresh, false);
    });
  }

  it('retains rows, expansion, name draft and deferred pending through reconnect while blocking status reentry and automatic replay', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, state()), pending = deferred();
    const mute = t.mock.method(client, 'forceMute', () => pending.promise), row = view(element).rows[0]!, old = buttons(row);
    panel(element).open = true; element['roomNameInput'].value = 'Keep room draft'; press(old.mute); error(socket, 'Keep reconnect error');
    const observed: { error: string | null; rows: number; disabled: boolean[][] }[] = [];
    element.addEventListener('stage-status', () => {
      force(old.mute); force(old.remove); const current = peek(element); reenter(current.rows[1]);
      observed.push({ error: element['error'].textContent, rows: current.rows.length, disabled: current.rows.map(row => flags(row).map(button => button.disabled)) });
    }, { once: true });
    socket.close(); await settle();
    assert.deepEqual(observed, [{ error: 'Keep reconnect error', rows: 2, disabled: [[true, true, true], [true, true, true]] }]);
    assert.equal(view(element).rows[0], row); assert.equal(panel(element).open, true); assert.equal(element['roomNameInput'].value, 'Keep room draft');
    assert.match(text(panel(element)), /重新連線|重連/); assert.match(view(element).summary.textContent, /上次|最近|最後/);
    busy(row, true); busy(view(element).rows[1]!, false, true); assert.equal(mute.mock.callCount(), 1);
    await tick(500); const next = sockets[1]!, resume = await hello(next);
    next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assert.equal(view(element).rows[0], row); assert.equal(panel(element).open, true); assert.equal(element['roomNameInput'].value, 'Keep room draft');
    busy(row, true); busy(view(element).rows[1]!, false, false, true); assert.equal(requests(next).length, 0);
    pending.resolve(); await settle(); busy(row, false); assert.equal(element['error'].textContent, 'Keep reconnect error');
  });

  it('surfaces actual socket rejection, ignores stale wire callbacks, and unlocks only the resumed request ACK', async t => {
    const { element, socket, sockets, tick, hello } = await socketJoinedWidget(t, state());
    panel(element).open = true; press(buttons(view(element).rows[0]!).mute); await tick(100); const old = request(socket), oldMessage = socket.onmessage;
    socket.close(); await settle(); assert.equal(element['error'].textContent, '連線已中斷。'); busy(view(element).rows[0]!, false, true);
    await tick(500); const next = sockets[1]!, resume = await hello(next);
    next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    const row = view(element).rows[0]!; press(buttons(row).remove); await tick(100); const active = request(next);
    for (const message of [{ type: 'ok', requestId: old.requestId }, { type: 'error', code: 'conflict', message: 'Stale wire error', requestId: old.requestId },
      { type: 'room:state', ...state([]) }] satisfies ServerMessage[]) oldMessage?.({ data: JSON.stringify(message) });
    await settle(); assert.equal(view(element).rows[0], row); busy(row, true); assert.equal(element['error'].hidden, true);
    next.deliver({ type: 'ok', requestId: active.requestId }); await settle(); busy(row, false);
  });

  for (const transition of ['leave', 'detach', 'direct disconnect', 'ordinary close', 'kick', 'shutdown'] as const) {
    it(`clears stage identities, expansion and pending on ${transition} before terminal forwarded callbacks`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), pending = deferred();
      const mute = t.mock.method(client, 'forceMute', () => pending.promise), old = buttons(view(element).rows[0]!); panel(element).open = true; press(old.mute);
      const observed: { hidden: boolean; open: boolean; rows: number; disabled: boolean[]; calls: number }[] = [];
      const terminal = terminalCases.find(item => item.title === transition);
      if (terminal) element.addEventListener(`stage-${terminal.event}`, () => {
        force(old.mute); force(old.remove);
        const current = peek(element); observed.push({ hidden: current.disclosure.hidden, open: current.disclosure.open, rows: current.rows.length,
          disabled: Object.values(old).map(button => button.disabled), calls: mute.mock.callCount() });
      }, { once: true });
      if (transition === 'leave') click(element['roomAction']);
      else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else if (transition === 'direct disconnect') await client.disconnect();
      else socket.deliver(terminal!.message);
      await settle(); retired(element);
      if (terminal) assert.deepEqual(observed, [{ hidden: true, open: false, rows: 0, disabled: [true, true, true], calls: 1 }]);
      element['show'](new Error('Current terminal error')); force(old.mute); force(old.remove); pending.reject(new Error('Retired terminal rejection')); await settle();
      retired(element); assert.equal(mute.mock.callCount(), 1); assert.equal(element['error'].textContent, 'Current terminal error');
    });
  }

  it('retires initial pre-ACK socket loss and silent public disconnect before same-client same-ID rejoin', async t => {
    const { element, sockets, hello, tick, joinRequest } = socketJoiningWidget(t); await settle(); const socket = sockets[0]!, joining = await hello(socket), client = element.client!;
    socket.deliver({ type: 'room:state', ...state() }); assert.equal(client['session'], null); assert.equal(client['pending'].has(joining.requestId), true);
    const old = deferred(), active = deferred(); let calls = 0; t.mock.method(client, 'forceMute', () => (++calls === 1 ? old : active).promise);
    const original = view(element).rows[0]!, stale = buttons(original); panel(element).open = true; press(stale.mute);
    socket.close(); await settle(); assert.equal(client.status, 'disconnected'); assert.ok(client.state); retired(element);
    let statuses = 0; element.addEventListener('stage-status', () => { statuses++; }); await client.disconnect(); assert.equal(statuses, 0); assert.equal(client.state, null);
    const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
    const joiningAgain = client.join({ roomId: 'one', name: 'New same-ID tenure' }); await settle(); await tick(100); const join = joinRequest(next);
    next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: join.requestId }); await joiningAgain;
    const fresh = view(element).rows[0]!; assert.notEqual(fresh, original); assert.equal(panel(element).open, false); press(buttons(fresh).mute); busy(fresh, true);
    error(next, 'Fresh same-ID error'); old.reject(new Error('Retired pre-ACK rejection')); await settle(); force(stale.mute); force(stale.remove);
    assert.equal(calls, 2); busy(fresh, true); assert.equal(element['error'].textContent, 'Fresh same-ID error'); active.resolve(); await settle(); busy(fresh, false);
  });

  for (const terminal of terminalCases) {
    it(`starts new same-client same-ID ownership after ${terminal.title} without reviving an old pending action`, async t => {
      const { element, client, socket, sockets, tick, joinRequest } = await socketJoinedWidget(t, state()), old = deferred(), active = deferred(); let calls = 0;
      t.mock.method(client, 'forceMute', () => (++calls === 1 ? old : active).promise);
      const original = view(element).rows[0]!; press(buttons(original).mute); panel(element).open = true; socket.deliver(terminal.message); await settle(); retired(element);
      const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
      const joining = client.join({ roomId: 'one', name: 'Fresh controller' }); await settle(); await tick(100); const join = joinRequest(next);
      next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: join.requestId }); await joining;
      const fresh = view(element).rows[0]!; assert.notEqual(fresh, original); assert.equal(panel(element).open, false); press(buttons(fresh).mute);
      error(next, 'Fresh terminal-rejoin error'); old.reject(new Error('Obsolete terminal action')); await settle(); busy(fresh, true);
      assert.equal(element['error'].textContent, 'Fresh terminal-rejoin error'); active.resolve(); await settle(); busy(fresh, false);
    });
  }

  for (const attribute of ['room', 'name', 'code', 'url'] as const) {
    it(`isolates ${attribute} attribute client replacement from retired wire and promise callbacks`, async t => {
      const { element, client, socket, sockets, hello } = await socketJoinedWidget(t, state()), old = deferred(); t.mock.method(client, 'forceMute', () => old.promise);
      const stale = buttons(view(element).rows[0]!); press(stale.mute); panel(element).open = true; const oldMessage = socket.onmessage, oldClose = socket.onclose;
      element.setAttribute(attribute, attribute === 'url' ? 'ws://localhost/new-stage' : attribute === 'room' ? 'two' : 'Changed'); await settle(); await settle(); retired(element);
      const replacement = element.client!; assert.notEqual(replacement, client); const next = sockets[1]!, join = await hello(next);
      next.deliver({ type: 'room:state', ...state(['first'], false, attribute === 'room' ? 'two' : 'one') }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
      const active = deferred(), mute = t.mock.method(replacement, 'forceMute', () => active.promise), row = view(element).rows[0]!; press(buttons(row).mute); error(next, 'Replacement current error');
      old.reject(new Error('Old client rejection')); oldMessage?.({ data: JSON.stringify({ type: 'room:state', ...state([]) }) }); oldClose?.(); await settle(); force(stale.mute); force(stale.remove);
      busy(row, true); assert.equal(mute.mock.callCount(), 1); assert.equal(element['error'].textContent, 'Replacement current error'); active.resolve(); await settle(); busy(row, false);
    });
  }

  it('suppresses obsolete promise rejection after silent role loss while preserving late SDK-wide wire error delivery', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, state()), old = deferred(); const mock = t.mock.method(client, 'forceMute', () => old.promise);
    press(buttons(view(element).rows[0]!).mute); error(socket, 'Independent current error'); client.state!.me.role = 'audience'; client.state!.controllerId = 'other';
    old.reject(new Error('Silently retired owner rejection')); await settle(); retired(element); assert.equal(element['error'].textContent, 'Independent current error'); mock.mock.restore();
    socket.deliver({ type: 'room:state', ...state() }); press(buttons(view(element).rows[0]!).mute); await tick(100); const sent = request(socket);
    socket.deliver({ type: 'room:state', ...roomState() }); retired(element); socket.deliver({ type: 'room:state', ...state() });
    const fresh = view(element).rows[0]!; press(buttons(fresh).remove); await tick(100); const active = request(socket); let forwarded = 0;
    element.addEventListener('stage-error', () => { forwarded++; });
    socket.deliver({ type: 'error', code: 'forbidden', message: 'Server denied old ownership request', requestId: sent.requestId }); await settle();
    assert.equal(forwarded, 1); assert.equal(element['error'].textContent, 'Server denied old ownership request'); busy(fresh, true); assert.equal(client['pending'].size, 1);
    socket.deliver({ type: 'ok', requestId: active.requestId }); await settle(); busy(fresh, false);
  });

  for (const failure of ['synchronous', 'queue_full', 'timeout'] as const) {
    it(`reports ${failure}, unlocks the affected target, and permits only an explicit retry`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!;
      let unrelated: Promise<void> | undefined;
      if (failure === 'synchronous') {
        const mock = t.mock.method(client, 'forceMute', () => { throw new Error('Synchronous stage management failure'); });
        press(buttons(row).mute); await settle(); mock.mock.restore(); assert.equal(element['error'].textContent, 'Synchronous stage management failure'); assert.equal(requests(socket).length, 0);
      } else if (failure === 'queue_full') {
        Object.defineProperty(client, 'maxPendingControlRequests', { value: 1 }); unrelated = client.forceMute('unlisted').catch(() => {});
        press(buttons(row).mute); await settle(); assert.match(element['error'].textContent ?? '', /佇列|請求/); await tick(100);
        assert.deepEqual(requests(socket).map(message => message.targetId), ['unlisted']); socket.deliver({ type: 'ok', requestId: request(socket).requestId }); await unrelated;
      } else {
        press(buttons(row).mute); await tick(100); const expired = request(socket); await tick(15000);
        assert.match(element['error'].textContent ?? '', /逾時/); assert.equal(requests(socket).length, 1);
        socket.deliver({ type: 'ok', requestId: expired.requestId }); await settle();
      }
      busy(row, false); busy(view(element).rows[1]!, false); press(buttons(row).mute); await tick(100); const retry = request(socket);
      assert.equal(retry.targetId, 'first'); busy(row, true); assert.equal(element['error'].hidden, true);
      socket.deliver({ type: 'ok', requestId: retry.requestId }); await settle(); busy(row, false);
    });
  }

  /** Real SDK request scheduling → wire validation → Hub. Only browser/media surfaces are fake. */
  async function hubWidget(t: TestContext, selfMuted = false, controllerOnStage = false) {
    const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 0; c.limits.handRaiseIntervalMs = 0; });
    const h = harness(config); t.after(async () => { await h.hub.shutdown(); await h.transport.close(); });
    const host = await h.create('Original host'), successor = await h.join(host.roomId, host.code, 'Offstage controller');
    const first = await h.join(host.roomId, host.code, 'Managed & <speaker>'), second = await h.join(host.roomId, host.code, 'Other speaker');
    for (const person of [first, second]) {
      assert.equal(await h.req(person.s, { type: 'hand:raise' }), 'ok'); assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: person.id }), 'ok');
      assert.equal(await h.req(person.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    }
    if (selfMuted) assert.equal(await h.req(first.s, { type: 'mic:mute' }), 'ok');
    if (controllerOnStage) {
      assert.equal(await h.req(successor.s, { type: 'hand:raise' }), 'ok');
      assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: successor.id }), 'ok');
    }
    assert.equal(await h.req(successor.s, { type: 'rtc:offer', payload: controllerOnStage ? SENDRECV_OFFER : RECVONLY_OFFER }), 'ok');
    assert.equal(await h.req(host.s, { type: 'control:transfer', targetId: successor.id }), 'ok');
    const fixture = await socketJoinedWidget(t, successor.s.last('room:state')!);
    const flush = () => { for (const timer of h.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); } };
    const deliver = () => { flush(); fixture.socket.deliver(successor.s.last('room:state')!); };
    const relay = async (message: StageRequest | Extract<ClientMessage, { type: 'mic:gain' | 'room:rename' | 'stage:approve' }>) => {
      const start = successor.s.inbox.length; await h.hub.handle(successor.s, parseClientMessage(JSON.stringify(message), config.limits)); flush();
      const replies = successor.s.inbox.slice(start);
      for (const reply of replies) if (reply.type !== 'ok' && reply.type !== 'error') fixture.socket.deliver(reply);
      await settle(); const reply = replies.find(reply => (reply.type === 'ok' || reply.type === 'error') && reply.requestId === message.requestId);
      assert.ok(reply && (reply.type === 'ok' || reply.type === 'error')); return { reply, replies };
    };
    const target = (id = first.id) => {
      const index = fixture.client.state!.speakers.filter(person => person.role === 'speaker' && person.onStage && person.participantId !== fixture.client.me!.participantId).findIndex(person => person.participantId === id);
      assert.ok(index >= 0); const row = view(fixture.element).rows[index]; assert.ok(row); return row;
    };
    return { ...fixture, h, config, host, successor, first, second, deliver, relay, target };
  }

  /** Count mounted stage-row writes only; DOM, transport, clocks and media are controlled test surfaces. */
  function rowWrites(t: TestContext, rows: Node[]) {
    const writes = { text: 0, attribute: 0, disabled: 0, hidden: 0 }, changes = { ...writes };
    for (const row of rows) {
      const controls = buttons(row), name = row.children[0]!;
      const fields: [Node, 'textContent' | 'disabled' | 'hidden', 'text' | 'disabled' | 'hidden'][] = [
        [name, 'textContent', 'text'], [controls.mute, 'textContent', 'text'],
        ...Object.values(controls).map((button): [Node, 'disabled', 'disabled'] => [button, 'disabled', 'disabled']),
        [controls.transfer, 'hidden', 'hidden'],
      ];
      for (const [node, key, counter] of fields) {
        let value = node[key];
        Object.defineProperty(node, key, { configurable: true, get: () => value, set: (next: string | boolean) => {
          writes[counter]++; if (value !== next) changes[counter]++; value = next;
        } });
        t.after(() => { Object.defineProperty(node, key, { configurable: true, writable: true, value }); });
      }
      for (const button of Object.values(controls)) {
        const original = button.setAttribute;
        t.mock.method(button, 'setAttribute', function (this: Node, key: string, value: string): void {
          if (key === 'aria-label' || key === 'aria-busy') {
            writes.attribute++; if (this.getAttribute(key) !== value) changes.attribute++;
          }
          original.call(this, key, value);
        });
      }
    }
    const reset = () => { for (const key of ['text', 'attribute', 'disabled', 'hidden'] as const) writes[key] = changes[key] = 0; };
    const expect = (text = 0, attribute = 0, disabled = 0, hidden = 0) => {
      assert.deepEqual({ ...writes }, { text, attribute, disabled, hidden }, 'only necessary current-value stage-row writes');
      assert.deepEqual({ ...changes }, { ...writes }, 'each guarded write changes its current DOM value');
      reset();
    };
    const snapshot = () => ({ writes: { ...writes }, changes: { ...changes } });
    return { reset, expect, snapshot };
  }

  for (const managedRows of [1, 3, 8]) for (const workload of ['gain', 'room-title'] as const) {
    it(`stage-row writes: actual SDK validator Hub ${workload} changes preserve ${managedRows} unchanged rows`, async t => {
      const f = await hubWidget(t);
      if (managedRows === 1) {
        for (const id of [f.host.id, f.second.id]) assert.equal(await f.h.req(f.successor.s, { type: 'stage:remove', targetId: id }), 'ok');
      }
      for (let i = 3; i < managedRows; i++) {
        const person = await f.h.join(f.host.roomId, f.host.code, `Extra speaker ${i}`);
        assert.equal(await f.h.req(person.s, { type: 'hand:raise' }), 'ok');
        assert.equal(await f.h.req(f.successor.s, { type: 'stage:approve', targetId: person.id }), 'ok');
        assert.equal(await f.h.req(person.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
      }
      f.deliver(); await settle();
      const current = view(f.element), rows = [...current.rows]; assert.equal(rows.length, managedRows);
      current.disclosure.open = true;
      const controls = rows.map(row => Object.values(buttons(row))), callbacks = controls.flat().map(button => button.onclick);
      const observed = rowWrites(t, rows), replaces = t.mock.method(current.list, 'replaceChildren');
      const client = f.client, socket = f.socket, pending = client['pending'].size;
      const media = f.h.transport.rooms.get(f.host.roomId)!, peer = media.peers.get(f.first.id), publisher = media.publishers.get(f.first.id);
      assert.ok(peer && publisher);
      const events: string[] = [];
      for (const kind of ['state', 'mic', 'role', 'stageleft', 'transferred']) f.element.addEventListener(`stage-${kind}`, () => events.push(kind));
      const startFrames = socket.sent.length;
      for (let i = 0; i < 24; i++) {
        const expected = i % 2 ? -3 : 3;
        const work = workload === 'gain' ? client.setGain(f.first.id, expected) : client.setRoomName(`Session ${i}`);
        await f.tick(100);
        const sent = socket.sent.at(-1);
        assert.ok(sent && (sent.type === 'mic:gain' || sent.type === 'room:rename'));
        assert.equal(sent.type, workload === 'gain' ? 'mic:gain' : 'room:rename');
        const { reply } = await f.relay(sent); assert.equal(reply.type, 'ok');
        socket.deliver(reply); await work;
        if (workload === 'gain') assert.equal(client.state!.speakers.find(person => person.participantId === f.first.id)!.gainDb, expected);
        else assert.equal(client.state!.name, `Session ${i}`);
      }
      assert.deepEqual(events, Array<string>(24).fill('state'));
      assert.deepEqual(view(f.element).rows, rows); assert.equal(replaces.mock.callCount(), 0);
      assert.deepEqual(rows.map(row => Object.values(buttons(row))), controls);
      assert.deepEqual(controls.flat().map(button => button.onclick), callbacks);
      assert.equal(current.disclosure.open, true); assert.equal(f.element.client, client); assert.equal(f.sockets[0], socket);
      assert.equal(socket.sent.length - startFrames, 24); assert.equal(client['pending'].size, pending);
      assert.equal(media.peers.get(f.first.id), peer); assert.equal(media.publishers.get(f.first.id), publisher);
      observed.expect();
    });
  }

  it('stage-row writes: actual Hub lock then unlock changes presentation and retains request reservations', async t => {
    const f = await hubWidget(t), row = f.target(), other = f.target(f.second.id);
    const active = rowWrites(t, [row]), passive = rowWrites(t, [other]);
    for (const lock of [true, false]) {
      press(buttons(row).mute); press(buttons(row).mute); press(buttons(row).remove);
      busy(row, true); busy(other, false, false, true);
      await f.tick(100); const sent = request(f.socket), { reply } = await f.relay(sent);
      assert.equal(sent.type, lock ? 'mic:force-mute' : 'mic:force-unmute'); assert.equal(reply.type, 'ok');
      assert.equal(f.client.state!.speakers.find(person => person.participantId === f.first.id)!.forceMuted, lock);
      busy(row, true); busy(other, false, false, true); assert.equal(f.target(), row);
      f.socket.deliver(reply); await settle(); busy(row, false); busy(other, false);
      assert.equal(buttons(row).mute.textContent, lock ? '解除靜音鎖定' : '鎖定靜音');
    }
    assert.equal(requests(f.socket).length, 2);
    active.expect(4, 10, 12); passive.expect(0, 0, 4);
  });

  it('stage-row writes: repairs all twelve host-mutated row fields on an unchanged real Hub snapshot', async t => {
    const f = await hubWidget(t), row = f.target(), controls = buttons(row), name = row.children[0]!;
    const observed = rowWrites(t, [row]);
    name.textContent = 'Host label'; controls.mute.textContent = 'Host mute'; controls.transfer.hidden = true;
    for (const button of Object.values(controls)) {
      button.disabled = true; button.setAttribute('aria-label', 'Host action'); button.setAttribute('aria-busy', 'host');
    }
    observed.reset(); f.deliver(); await settle(); observed.expect(2, 6, 3, 1);
    assert.equal(name.textContent, 'Managed & <speaker> · 未靜音'); assert.equal(controls.mute.textContent, '鎖定靜音');
    assert.equal(controls.mute.getAttribute('aria-label'), '鎖定 Managed & <speaker> 靜音');
    assert.equal(controls.remove.getAttribute('aria-label'), '將 Managed & <speaker> 移下台');
    assert.equal(controls.transfer.getAttribute('aria-label'), '將控制權移交給 Managed & <speaker>');
    assert.equal(controls.transfer.hidden, false); busy(row, false); assert.equal(f.target(), row);
    f.deliver(); await settle(); observed.expect();
  });

  it('stage-row writes: reconciles same-snapshot and DOM mutations after a forwarded callback', async t => {
    const f = await hubWidget(t), row = f.target(), controls = buttons(row), observed = rowWrites(t, [row]);
    const snapshots: RoomStatePayload[] = [], labels: string[] = [], counts: ReturnType<typeof observed.snapshot>[] = [];
    f.element.addEventListener('stage-state', () => {
      snapshots.push(f.client.state!); labels.push(row.children[0]!.textContent); counts.push(observed.snapshot());
      f.client.state!.speakers.find(person => person.participantId === f.first.id)!.name = 'Callback &amp; speaker';
      controls.remove.setAttribute('aria-label', 'Callback mutation'); observed.reset();
    }, { once: true });
    f.deliver(); await settle();
    assert.deepEqual(labels, ['Managed & <speaker> · 未靜音']); assert.equal(snapshots[0], f.client.state);
    const unchanged = { text: 0, attribute: 0, disabled: 0, hidden: 0 };
    assert.deepEqual(counts, [{ writes: unchanged, changes: unchanged }]); observed.expect(1, 3);
    assert.equal(row.children[0]!.textContent, 'Callback & speaker · 未靜音');
    assert.equal(controls.mute.getAttribute('aria-label'), '鎖定 Callback & speaker 靜音');
    assert.equal(controls.remove.getAttribute('aria-label'), '將 Callback & speaker 移下台');
    assert.equal(controls.transfer.getAttribute('aria-label'), '將控制權移交給 Callback & speaker'); assert.equal(f.target(), row);
  });

  it('stage-row writes: preserves a newer nested state instead of restoring the outer callback snapshot', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state(['first'])), row = view(element).rows[0]!;
    const observed = rowWrites(t, [row]), outer = state(['first']), nested = state(['first']);
    outer.speakers[0]!.name = 'Outer'; nested.speakers[0]!.name = 'Nested &amp; current'; nested.speakers[0]!.connected = false;
    const labels: string[] = [], counts: ReturnType<typeof observed.snapshot>[] = [];
    element.addEventListener('stage-state', () => {
      labels.push(row.children[0]!.textContent); counts.push(observed.snapshot()); observed.reset();
      socket.deliver({ type: 'room:state', ...nested });
      labels.push(row.children[0]!.textContent); counts.push(observed.snapshot()); observed.reset();
    }, { once: true });
    socket.deliver({ type: 'room:state', ...outer }); observed.expect();
    assert.deepEqual(labels, ['Outer · 未靜音', 'Nested & current · 未靜音 · 暫時離線（席位保留中）']);
    const outerChanges = { text: 1, attribute: 3, disabled: 0, hidden: 0 }, nestedChanges = { ...outerChanges, disabled: 1 };
    assert.deepEqual(counts, [{ writes: outerChanges, changes: outerChanges }, { writes: nestedChanges, changes: nestedChanges }]);
    assert.equal(client.state!.speakers[0]!.name, nested.speakers[0]!.name); assert.equal(view(element).rows[0], row);
    assert.equal(buttons(row).transfer.getAttribute('aria-label'), '將控制權移交給 Nested & current'); busy(row, false, false, true);
  });

  for (const field of ['name', 'mute text', 'mute label', 'remove label', 'transfer label', 'mute disabled', 'mute busy',
    'remove disabled', 'remove busy', 'transfer hidden', 'transfer disabled', 'transfer busy'] as const) {
    it(`stage-row writes: retries a failed ${field} write from live DOM and finishes remaining fields`, async t => {
      const f = await hubWidget(t), row = f.target(), controls = buttons(row), name = row.children[0]!;
      name.textContent = 'Host label'; controls.mute.textContent = 'Host mute'; controls.transfer.hidden = true;
      for (const button of Object.values(controls)) {
        button.disabled = true; button.setAttribute('aria-label', 'Host action'); button.setAttribute('aria-busy', 'host');
      }
      const node = field === 'name' ? name : field.startsWith('mute') ? controls.mute : field.startsWith('remove') ? controls.remove : controls.transfer;
      let fail = true, attempts = 0;
      if (field.endsWith('label') || field.endsWith('busy')) {
        const key = field.endsWith('label') ? 'aria-label' : 'aria-busy', original = node.setAttribute;
        t.mock.method(node, 'setAttribute', function (this: Node, attribute: string, value: string): void {
          if (attribute === key) { attempts++; if (fail) throw new Error('Controlled DOM write failure'); }
          original.call(this, attribute, value);
        });
      } else {
        const key = field === 'name' || field.endsWith('text') ? 'textContent' : field.endsWith('hidden') ? 'hidden' : 'disabled';
        let value = node[key];
        Object.defineProperty(node, key, { configurable: true, get: () => value, set: (next: string | boolean) => {
          attempts++; if (fail) throw new Error('Controlled DOM write failure'); value = next;
        } });
        t.after(() => { Object.defineProperty(node, key, { configurable: true, writable: true, value }); });
      }
      assert.throws(() => f.element['syncStageManagement'](), /Controlled DOM write failure/); assert.equal(attempts, 1);
      fail = false; f.element['syncStageManagement'](); assert.equal(attempts, 2);
      assert.equal(name.textContent, 'Managed & <speaker> · 未靜音'); assert.equal(controls.mute.textContent, '鎖定靜音');
      assert.equal(controls.mute.getAttribute('aria-label'), '鎖定 Managed & <speaker> 靜音');
      assert.equal(controls.remove.getAttribute('aria-label'), '將 Managed & <speaker> 移下台');
      assert.equal(controls.transfer.getAttribute('aria-label'), '將控制權移交給 Managed & <speaker>');
      assert.equal(controls.transfer.hidden, false); busy(row, false); assert.equal(f.target(), row);
      f.element['syncStageManagement'](); assert.equal(attempts, 2, 'a completed value does not need another write');
    });
  }

  it('stage-row writes: rechecks transfer eligibility on equal rows and preserves pending-attempt short-circuiting', async t => {
    const { element, client } = await socketJoinedWidget(t, state()), rows = [...view(element).rows];
    const original = element['canTransferStage'], calls: { id: string; node: HTMLLIElement }[] = [];
    t.mock.method(element as unknown as { canTransferStage(id: string, node: HTMLLIElement): boolean }, 'canTransferStage',
      function (this: Widget, id: string, node: HTMLLIElement): boolean { calls.push({ id, node }); return original.call(this, id, node); });
    const expected = rows.map((row, index) => ({ id: ['first', 'second'][index]!, node: row }));
    for (let pass = 0; pass < 2; pass++) { calls.length = 0; element['syncStageManagement'](); assert.deepEqual(calls, expected); }
    const pending = deferred(); confirm(t); const transfer = t.mock.method(client, 'transferControl', () => pending.promise);
    press(buttons(rows[0]!).transfer); transferBusy(element); assert.equal(transfer.mock.callCount(), 1);
    for (let pass = 0; pass < 2; pass++) {
      calls.length = 0; element['syncStageManagement'](); assert.deepEqual(calls, expected.slice(0, 1), 'only the existing post-row attempt-validity check runs');
      transferBusy(element);
    }
    client.state!.speakers[0]!.connected = false; element['syncStageManagement'](); assert.equal(element['stageTransferAttempt']!.invalid, true);
    pending.resolve(); await settle(); assert.equal(element['stageTransferAttempt'], undefined); busy(rows[0]!, false, false, true); busy(rows[1]!, false);
  });

  for (const selfMuted of [false, true]) {
    it(`locks and unlocks a real Hub target with selfMuted=${selfMuted} from an offstage controller without relying on mic events`, async t => {
      const { element, client, socket, tick, h, host, first, relay, target } = await hubWidget(t, selfMuted);
      const media = h.transport.rooms.get(host.roomId)!, peer = media.peers.get(first.id), publisher = media.publishers.get(first.id);
      assert.ok(peer && publisher); assert.equal(client.me!.onStage, false); assert.equal(client.me!.role, 'controller');
      const row = target(); assert.match(text(row), /Managed & <speaker>/); assert.equal(buttons(row).mute.textContent, '鎖定靜音');
      for (const lock of [true, false]) {
        press(buttons(row).mute); await tick(100); const sent = request(socket);
        assert.equal(sent.targetId, first.id); assert.equal(sent.type, lock ? 'mic:force-mute' : 'mic:force-unmute');
        const { reply, replies } = await relay(sent); assert.equal(reply.type, 'ok');
        const person = client.state!.speakers.find(person => person.participantId === first.id)!;
        assert.equal(person.forceMuted, lock); assert.equal(person.muted, selfMuted || lock); assert.equal(target(), row); busy(row, true);
        assert.equal(buttons(row).mute.textContent, lock ? '解除靜音鎖定' : '鎖定靜音');
        assert.equal(replies.filter(reply => reply.type === 'mic:muted' || reply.type === 'mic:unmuted').length, selfMuted ? 0 : 1);
        force(buttons(row).mute); force(buttons(row).remove); assert.equal(requests(socket).length, lock ? 1 : 2);
        socket.deliver(reply); await settle(); busy(row, false);
        assert.equal(media.peers.get(first.id), peer); assert.equal(media.publishers.get(first.id), publisher); assert.equal(client.me!.onStage, false);
      }
      assert.equal(media.muted.has(first.id), selfMuted); assert.equal(client.state!.speakers.find(person => person.participantId === first.id)!.muted, selfMuted);
      assert.equal(socket.sent.some(message => ['rtc:offer', 'participant:kick', 'control:transfer', 'mic:gain'].includes(message.type)), false);
    });
  }

  it('accepts real Hub idempotent force-lock ACKs and updates authoritative state before unlocking the target', async t => {
    const { element, socket, tick, h, successor, first, relay, target } = await hubWidget(t);
    const row = target(); press(buttons(row).mute); await tick(100); const sent = request(socket);
    assert.equal(await h.req(successor.s, { type: 'mic:force-mute', targetId: first.id }), 'ok');
    const { reply, replies } = await relay(sent); assert.equal(reply.type, 'ok'); assert.equal(replies.some(reply => reply.type === 'mic:muted'), false);
    assert.equal(replies.some(reply => reply.type === 'room:state'), true); assert.equal(buttons(row).mute.textContent, '解除靜音鎖定'); busy(row, true);
    socket.deliver(reply); await settle(); busy(row, false); assert.equal(element['error'].hidden, true);
  });

  it('removes a real Hub speaker to audience without kicking or recreating the retained listener peer', async t => {
    const { element, client, socket, tick, h, host, first, relay, target } = await hubWidget(t, true);
    const media = h.transport.rooms.get(host.roomId)!, peer = media.peers.get(first.id); assert.ok(peer); assert.equal(media.subscribers.has(first.id), true);
    const old = buttons(target()); press(old.remove); await tick(100); const sent = request(socket); assert.equal(sent.type, 'stage:remove');
    const { reply, replies } = await relay(sent); assert.equal(reply.type, 'ok'); assert.equal(client.state!.speakers.some(person => person.participantId === first.id), false);
    const audience = client.state!.audience!.find(person => person.participantId === first.id)!;
    assert.ok(audience); assert.equal(audience.role, 'audience'); assert.equal(audience.onStage, false); assert.equal(audience.muted, false); assert.equal(audience.forceMuted, false);
    assert.equal(media.peers.get(first.id), peer); assert.equal(media.subscribers.has(first.id), true); assert.equal(media.publishers.has(first.id), false);
    assert.equal(h.transport.emitUplink(host.roomId, first.id, sine(960, .5)), false); assert.equal(first.s.closed, undefined);
    assert.equal(first.s.all('kicked').length, 0); assert.equal(replies.some(reply => reply.type === 'stage:left' && reply.reason === 'removed'), true);
    force(old.mute); force(old.remove); await tick(100); assert.equal(requests(socket).length, 1);
    socket.deliver(reply); await settle(); assert.equal(client.me!.onStage, false); assert.equal(panel(element).hidden, false);
    assert.equal(await h.req(first.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok'); assert.equal(media.peers.get(first.id), peer);
  });

  it('leaves offline grace speakers visible and delegates their force-lock and removal to the real Hub', async t => {
    const { client, socket, tick, h, first, deliver, relay, target } = await hubWidget(t);
    await h.hub.detach(first.s); deliver(); const row = target(); assert.match(text(row), /離線|未連線|斷線/); busy(row, false, false, true);
    for (const action of ['mute', 'mute', 'remove'] as const) {
      press(buttons(row)[action]); await tick(100); const sent = request(socket), { reply } = await relay(sent); assert.equal(reply.type, 'ok');
      socket.deliver(reply); await settle();
    }
    const person = client.state!.audience!.find(person => person.participantId === first.id); assert.ok(person); assert.equal(person.connected, false); assert.equal(person.onStage, false);
    assert.deepEqual(requests(socket).map(message => message.type), ['mic:force-mute', 'mic:force-unmute', 'stage:remove']);
  });

  it('reports real server permission denial after role loss, retires stale controls, and never restores the old target action', async t => {
    const { element, client, socket, tick, h, host, successor, deliver, relay, target } = await hubWidget(t);
    const old = buttons(target()); press(old.mute); await tick(100); const sent = request(socket);
    assert.equal(await h.req(successor.s, { type: 'control:transfer', targetId: host.id }), 'ok'); deliver(); retired(element); assert.notEqual(client.me!.role, 'controller');
    const { reply } = await relay(sent); assert.equal(reply.type, 'error'); if (reply.type === 'error') assert.equal(reply.code, 'forbidden');
    socket.deliver(reply); await settle(); assert.equal(element['error'].hidden, false); retired(element);
    const message = element['error'].textContent; force(old.mute); force(old.remove); await tick(100); assert.equal(requests(socket).length, 1); assert.equal(element['error'].textContent, message);
  });

  it('reports a real Hub target-left conflict and leaves removed targets and callbacks retired', async t => {
    const { element, socket, tick, h, first, deliver, relay, target } = await hubWidget(t);
    const old = buttons(target()); press(old.remove); await tick(100); const sent = request(socket);
    assert.equal(await h.req(first.s, { type: 'stage:leave' }), 'ok'); deliver();
    const { reply } = await relay(sent); assert.equal(reply.type, 'error'); if (reply.type === 'error') assert.equal(reply.code, 'conflict');
    socket.deliver(reply); await settle(); assert.equal(element['error'].hidden, false); const message = element['error'].textContent;
    force(old.mute); force(old.remove); await tick(100); assert.equal(requests(socket).length, 1); assert.equal(element['error'].textContent, message);
  });

  for (const change of ['controller transfer', 'target leaves'] as const) {
    it(`defers a real Hub ${change} delta-before-state action to server authority without treating SDK notifications as snapshots`, async t => {
      const { element, client, socket, tick, h, host, successor, first, relay, deliver, target } = await hubWidget(t);
      const old = buttons(target()), start = successor.s.inbox.length;
      const observed: { role: string; hidden: boolean; hasTarget: boolean }[] = [];
      element.addEventListener(change === 'controller transfer' ? 'stage-transferred' : 'stage-stageleft', () => {
        observed.push({ role: client.me?.role ?? 'missing', hidden: peek(element).disclosure.hidden,
          hasTarget: Boolean(client.state?.speakers.some(person => person.participantId === first.id)) });
        press(change === 'controller transfer' ? old.mute : old.remove);
      }, { once: true });
      if (change === 'controller transfer') assert.equal(await h.req(successor.s, { type: 'control:transfer', targetId: host.id }), 'ok');
      else assert.equal(await h.req(first.s, { type: 'stage:leave' }), 'ok');
      const events = successor.s.inbox.slice(start);
      // Deliberately hold the authoritative snapshot while forwarding the real earlier Hub deltas.
      for (const event of events) if (!['room:state', 'ok', 'error'].includes(event.type)) socket.deliver(event);
      assert.deepEqual(observed, [{ role: 'controller', hidden: false, hasTarget: true }]);
      await tick(100); const sent = request(socket); assert.equal(sent.targetId, first.id);
      const { reply } = await relay(sent); assert.equal(reply.type, 'error');
      if (reply.type === 'error') assert.equal(reply.code, change === 'controller transfer' ? 'forbidden' : 'conflict');
      socket.deliver(reply); await settle(); assert.equal(element['error'].hidden, false);
      const before = (change === 'controller transfer' ? host.s : successor.s).last('room:state')!, person = [...before.speakers, ...(before.audience ?? [])].find(person => person.participantId === first.id);
      assert.ok(person); assert.equal(person.forceMuted, false); assert.equal(person.onStage, change === 'controller transfer');
      deliver(); if (change === 'controller transfer') retired(element);
      else assert.equal(client.state!.speakers.some(person => person.participantId === first.id), false);
      force(old.mute); force(old.remove); await tick(100); assert.equal(requests(socket).length, 1);
    });
  }

  it('retires target ownership after a forwarded host callback clears the snapshot and refuses reconnect-only fresh ownership', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state()), pending = deferred();
    const mute = t.mock.method(client, 'forceMute', () => pending.promise), old = buttons(view(element).rows[0]!); press(old.mute); panel(element).open = true;
    let callbacks = 0; element.addEventListener('stage-micready', () => { callbacks++; client['snapshot'] = null; }, { once: true });
    client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); assert.equal(callbacks, 1); retired(element);
    error(socket, 'Keep nested-retirement error'); pending.reject(new Error('Late nested-retirement rejection')); await settle(); retired(element);
    assert.equal(element['error'].textContent, 'Keep nested-retirement error');
    const next = state(); next.me.participantId = 'new-reconnecting-controller'; next.controllerId = next.me.participantId;
    client['snapshot'] = next; client['currentStatus'] = 'reconnecting'; client.dispatchEvent(new CustomEvent('status', { detail: 'reconnecting' }));
    retired(element); force(old.mute); force(old.remove); assert.equal(mute.mock.callCount(), 1);
    socket.deliver({ type: 'room:state', ...next }); assert.equal(panel(element).hidden, false); assert.equal(panel(element).open, false); busy(view(element).rows[0]!, false);
  });
  function transferBusy(element: Widget): void {
    for (const row of view(element).rows) assert.deepEqual(flags(row), [
      { disabled: true, busy: false }, { disabled: true, busy: false }, { disabled: true, busy: true },
    ]);
  }
  function confirm(t: TestContext, action: (message: string) => boolean = () => true) {
    return t.mock.method(window, 'confirm', action);
  }

  for (const decision of ['cancel', 'throw'] as const) {
    it(`control transfer ${decision} preserves feedback until a valid confirmation and releases only its reservation`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state());
      const transfer = t.mock.method(client, 'transferControl', async () => {}), row = view(element).rows[0]!;
      error(socket, 'Keep previous feedback');
      const dialog = confirm(t, message => {
        transferBusy(element); assert.equal(element['error'].textContent, 'Keep previous feedback');
        assert.match(message, /Managed speaker first/); assert.match(message, /失去主控權限/); assert.match(message, /保留目前台位.*留在房間/);
        if (decision === 'throw') throw new Error('Dialog unavailable'); return false;
      });
      press(buttons(row).transfer); await settle();
      assert.equal(dialog.mock.callCount(), 1); assert.equal(transfer.mock.callCount(), 0); assert.equal(requests(socket).length, 0);
      for (const current of view(element).rows) busy(current, false);
      assert.equal(element['error'].textContent, decision === 'throw' ? 'Dialog unavailable' : 'Keep previous feedback');
      dialog.mock.restore(); confirm(t); press(buttons(row).transfer); await settle(); assert.equal(transfer.mock.callCount(), 1);
    });
  }

  it('control transfer reserves the whole list before reentrant confirmation and sends one exact ID using the safe current name', async t => {
    const initial = state(); initial.speakers.forEach(person => { person.name = 'Same &amp; &lt;name&gt;'; });
    const { element, client, socket, tick } = await socketJoinedWidget(t, initial), rows = [...view(element).rows];
    client.state!.speakers[1]!.name = 'Latest &lt;img&gt; &amp;lt;';
    const dialog = confirm(t, message => {
      transferBusy(element); assert.match(message, /Latest <img> &lt;/);
      for (const row of rows) reenter(row);
      socket.deliver({ type: 'room:state', ...structuredClone(client.state!) });
      for (const row of view(element).rows) reenter(row);
      transferBusy(element); return true;
    });
    press(buttons(rows[1]!).transfer); transferBusy(element); await tick(100);
    assert.equal(dialog.mock.callCount(), 1); assert.deepEqual(requests(socket).map(request => [request.type, request.targetId]), [['control:transfer', 'second']]);
    assert.equal(client.me!.role, 'controller'); assert.equal(panel(element).hidden, false); assert.doesNotMatch(visibleText(element as unknown as Node), /移交成功|已移交/);
    error(socket, 'Current feedback while waiting'); socket.deliver({ type: 'ok', requestId: request(socket).requestId }); await settle();
    for (const row of view(element).rows) busy(row, false);
    assert.equal(element['error'].textContent, 'Current feedback while waiting');
  });

  for (const action of ['mute', 'remove'] as const) {
    it(`control transfer waits for every existing ${action} target and blocks all moderation after reservation`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), first = deferred(), second = deferred(), handoff = deferred();
      let calls = 0; const method = action === 'mute' ? 'forceMute' : 'removeFromStage';
      t.mock.method(client, method, () => (++calls === 1 ? first : second).promise);
      const transfer = t.mock.method(client, 'transferControl', () => handoff.promise), dialog = confirm(t);
      const [a, b] = view(element).rows; assert.ok(a && b); press(buttons(a)[action]); press(buttons(b)[action]);
      error(socket, 'Keep blocked feedback'); for (const row of view(element).rows) force(buttons(row).transfer);
      assert.equal(dialog.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0); assert.equal(element['error'].textContent, 'Keep blocked feedback');
      first.resolve(); await settle(); busy(a, false, false, true); force(buttons(a).transfer); assert.equal(dialog.mock.callCount(), 0);
      second.resolve(); await settle(); press(buttons(a).transfer); transferBusy(element);
      for (const row of view(element).rows) reenter(row);
      assert.equal(calls, 2); assert.equal(dialog.mock.callCount(), 1); assert.equal(transfer.mock.callCount(), 1);
      handoff.resolve(); await settle(); for (const row of view(element).rows) busy(row, false);
    });
  }

  for (const reason of ['target offline', 'local offline', 'unsupported SDK', 'unavailable dialog', 'target missing', 'target offstage', 'target role', 'self', 'stale row', 'detached'] as const) {
    it(`control transfer refuses ${reason} even through a forced retained handler without clearing an error`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, old = buttons(row);
      const transfer = t.mock.method(client, 'transferControl', async () => {}), dialog = confirm(t);
      error(socket, 'Preserve blocked handoff error');
      if (reason === 'target offline') client.state!.speakers[0]!.connected = false;
      else if (reason === 'local offline') client.state!.me.connected = false;
      else if (reason === 'unsupported SDK') Reflect.set(client, 'transferControl', undefined);
      else if (reason === 'unavailable dialog') Reflect.set(window, 'confirm', undefined);
      else if (reason === 'target missing') client.state!.speakers.splice(0, 1);
      else if (reason === 'target offstage') client.state!.speakers[0]!.onStage = false;
      else if (reason === 'target role') client.state!.speakers[0]!.role = 'audience';
      else if (reason === 'self') client.state!.me.participantId = 'first';
      else if (reason === 'stale row') { socket.deliver({ type: 'room:state', ...state(['second']) }); socket.deliver({ type: 'room:state', ...state() }); }
      else Object.assign(element, { isConnected: false });
      force(old.transfer); await settle(); assert.equal(transfer.mock.callCount(), 0); assert.equal(dialog.mock.callCount(), 0); assert.equal(requests(socket).length, 0);
      assert.equal(element['error'].textContent, 'Preserve blocked handoff error');
      if (['target offline', 'local offline', 'unsupported SDK', 'unavailable dialog'].includes(reason)) {
        assert.equal(old.mute.disabled, false); assert.equal(old.remove.disabled, false); assert.equal(old.transfer.hidden, reason === 'unsupported SDK');
      }
    });
  }

  const confirmationChanges = ['target absent', 'target offline', 'target offstage', 'target role', 'local offline', 'reconnect', 'SDK unavailable',
    'role lost', 'participant replaced', 'room replaced', 'generation replaced', 'snapshot cleared', 'client cleared', 'detached',
    'leave', 'direct disconnect', 'room attribute', 'name attribute', 'code attribute', 'url attribute', 'ordinary close', 'kick', 'shutdown'] as const;
  for (const change of confirmationChanges) {
    it(`control transfer never revives confirmation after observed ${change}, even if eligible state returns`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, old = buttons(row);
      const transfer = t.mock.method(client, 'transferControl', async () => {});
      const dialog = confirm(t, () => {
        const next = state();
        if (change === 'target absent') next.speakers.shift();
        else if (change === 'target offline') next.speakers[0]!.connected = false;
        else if (change === 'target offstage') next.speakers[0]!.onStage = false;
        else if (change === 'target role') next.speakers[0]!.role = 'audience';
        else if (change === 'local offline') next.me.connected = false;
        else if (change === 'role lost') { next.me.role = 'audience'; next.controllerId = 'other'; }
        else if (change === 'participant replaced') { next.me.participantId = 'new-seat'; next.controllerId = 'new-seat'; }
        else if (change === 'room replaced') next.roomId = 'two';
        if (['target absent', 'target offline', 'target offstage', 'target role', 'local offline', 'role lost', 'participant replaced', 'room replaced'].includes(change)) {
          socket.deliver({ type: 'room:state', ...next }); socket.deliver({ type: 'room:state', ...state() });
        } else if (change === 'reconnect') { socket.deliver({ type: 'status', state: 'reconnecting' }); socket.deliver({ type: 'status', state: 'live' }); }
        else if (change === 'SDK unavailable') {
          const method = client.transferControl; Reflect.set(client, 'transferControl', undefined); element['render'](); Reflect.set(client, 'transferControl', method); element['render']();
        } else if (change === 'generation replaced') { ++element['generation']; element['render'](); }
        else if (change === 'snapshot cleared') { client['snapshot'] = null; element['render'](); client['snapshot'] = state(); element['render'](); }
        else if (change === 'client cleared') { element['current'] = null; element['render'](); element['current'] = client; element['render'](); }
        else if (change === 'detached') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
        else if (change === 'leave') click(element['roomAction']);
        else if (change === 'direct disconnect') void client.disconnect();
        else if (change.endsWith(' attribute')) element.setAttribute(change.split(' ')[0]!, change === 'url attribute' ? 'ws://localhost/next' : 'next');
        else socket.deliver(terminalCases.find(terminal => terminal.title === change)!.message);
        element['show'](new Error('Keep callback error')); force(old.transfer); return true;
      });
      press(old.transfer); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(transfer.mock.callCount(), 0);
      assert.equal(requests(socket).length, 0); assert.equal(element['error'].textContent, 'Keep callback error');
      assert.equal(element['stageTransferAttempt'], undefined);
    });
  }

  const transferDeltas = [
    { title: 'own role loss', event: 'stage-role', message: { type: 'role:update', participantId: 'me', role: 'audience' } },
    { title: 'own transfer away', event: 'stage-transferred', message: { type: 'control:transferred', fromId: 'me', toId: 'second' } },
    { title: 'target leaves', event: 'stage-stageleft', message: { type: 'stage:left', participantId: 'first', role: 'audience', reason: 'leave' } },
    { title: 'target role loss', event: 'stage-role', message: { type: 'role:update', participantId: 'first', role: 'audience' } },
  ] as const satisfies readonly { title: string; event: string; message: ServerMessage }[];
  for (const delta of transferDeltas) {
    it(`control transfer fences ${delta.title} before forwarded callbacks while preserving the authoritative snapshot`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), transfer = t.mock.method(client, 'transferControl', async () => {}), dialog = confirm(t);
      const old = buttons(view(element).rows[0]!); let forwarded = 0;
      element.addEventListener(delta.event, () => {
        forwarded++; assert.equal(client.me!.role, 'controller'); assert.equal(client.state!.speakers[0]!.role, 'speaker');
        assert.equal(old.transfer.disabled, true); force(old.transfer);
      }, { once: true });
      socket.deliver(delta.message); force(old.transfer); await settle(); assert.equal(forwarded, 1);
      assert.equal(dialog.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0); assert.equal(old.mute.disabled, false); assert.equal(old.remove.disabled, false);
      socket.deliver({ type: 'room:state', ...state() }); press(old.transfer); await settle(); assert.equal(transfer.mock.callCount(), 1);
    });
    it(`control transfer invalidates a reserved dialog on ${delta.title} despite a nested authoritative restoration`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), transfer = t.mock.method(client, 'transferControl', async () => {});
      const dialog = confirm(t, () => { socket.deliver(delta.message); socket.deliver({ type: 'room:state', ...state() }); transferBusy(element); reenter(view(element).rows[1]); return true; });
      press(buttons(view(element).rows[0]!).transfer); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(transfer.mock.callCount(), 0);
      dialog.mock.restore(); confirm(t); press(buttons(view(element).rows[0]!).transfer); await settle(); assert.equal(transfer.mock.callCount(), 1);
    });
  }

  for (const outcome of ['resolve', 'reject'] as const) for (const change of ['target returns', 'target reconnects', 'local reconnects', 'reconnects', 'target delta'] as const) {
    it(`control transfer keeps the global reservation across ${change}, ignores obsolete ${outcome}, and never unlocks on a snapshot`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), pending = deferred(), transfer = t.mock.method(client, 'transferControl', () => pending.promise);
      confirm(t); const old = buttons(view(element).rows[0]!); panel(element).open = true; press(old.transfer);
      const next = state();
      if (change === 'target returns') next.speakers.shift();
      else if (change === 'target reconnects') next.speakers[0]!.connected = false;
      else if (change === 'local reconnects') next.me.connected = false;
      if (change === 'reconnects') { socket.deliver({ type: 'status', state: 'reconnecting' }); transferBusy(element); socket.deliver({ type: 'status', state: 'live' }); }
      else if (change === 'target delta') socket.deliver(transferDeltas[2]!.message);
      else socket.deliver({ type: 'room:state', ...next });
      socket.deliver({ type: 'room:state', ...state() }); transferBusy(element); assert.equal(panel(element).open, true);
      for (const row of view(element).rows) reenter(row); force(old.transfer); assert.equal(transfer.mock.callCount(), 1);
      error(socket, 'Keep later independent feedback'); if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('Obsolete handoff failure'));
      await settle(); for (const row of view(element).rows) busy(row, false); assert.equal(element['error'].textContent, 'Keep later independent feedback');
    });
  }

  for (const outcome of ['resolve', 'reject'] as const) for (const change of ['role', 'participant', 'room', 'generation', 'terminal', 'attribute'] as const) {
    it(`control transfer's retired ${change} ${outcome} cannot clear a new controller's reservation or error`, async t => {
      const { element, client, socket, sockets, hello } = await socketJoinedWidget(t, state()), old = deferred(), active = deferred(); let calls = 0;
      t.mock.method(client, 'transferControl', () => (++calls === 1 ? old : active).promise); confirm(t);
      const stale = buttons(view(element).rows[0]!); press(stale.transfer);
      const next = state();
      if (change === 'role') { next.me.role = 'audience'; next.controllerId = 'other'; }
      else if (change === 'participant') { next.me.participantId = 'new'; next.controllerId = 'new'; }
      else if (change === 'room') next.roomId = 'two';
      if (['role', 'participant', 'room'].includes(change)) { socket.deliver({ type: 'room:state', ...next }); socket.deliver({ type: 'room:state', ...state() }); }
      else if (change === 'generation') { ++element['generation']; element['render'](); }
      else if (change === 'terminal') {
        client.dispatchEvent(new CustomEvent('closed', { detail: { roomId: 'one' } })); retired(element);
        socket.deliver({ type: 'room:state', ...state() });
      } else {
        element.setAttribute('name', 'Replacement'); await settle(); const replacement = element.client!, fresh = sockets[1]!, join = await hello(fresh);
        fresh.deliver({ type: 'room:state', ...state() }); fresh.deliver({ type: 'ok', requestId: join.requestId }); await settle();
        t.mock.method(replacement, 'transferControl', () => { calls++; return active.promise; });
      }
      press(buttons(view(element).rows[0]!).transfer); transferBusy(element); assert.equal(calls, 2);
      element['show'](new Error('Fresh controller feedback')); if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Retired controller failure'));
      await settle(); force(stale.transfer); transferBusy(element); assert.equal(calls, 2); assert.equal(element['error'].textContent, 'Fresh controller feedback');
      active.resolve(); await settle(); for (const row of view(element).rows) busy(row, false);
    });
  }

  for (const failure of ['synchronous SDK', 'rejection', 'queue_full', 'timeout'] as const) {
    it(`control transfer reports current ${failure} and releases its reservation only for an explicit retry`, async t => {
      const { element, client, socket, tick } = await socketJoinedWidget(t, state()); confirm(t);
      let unrelated: Promise<void> | undefined;
      if (failure === 'synchronous SDK' || failure === 'rejection') {
        const mock = t.mock.method(client, 'transferControl', () => {
          if (failure === 'synchronous SDK') throw new Error('Current transfer failure'); return Promise.reject(new Error('Current transfer failure'));
        });
        press(buttons(view(element).rows[0]!).transfer); await settle(); mock.mock.restore(); assert.equal(element['error'].textContent, 'Current transfer failure');
      } else if (failure === 'queue_full') {
        Object.defineProperty(client, 'maxPendingControlRequests', { value: 1 }); unrelated = client.forceMute('unlisted').catch(() => {});
        press(buttons(view(element).rows[0]!).transfer); await settle(); assert.match(element['error'].textContent ?? '', /佇列|請求/); await tick(100);
        assert.deepEqual(requests(socket).map(message => message.type), ['mic:force-mute']); socket.deliver({ type: 'ok', requestId: request(socket).requestId }); await unrelated;
      } else {
        press(buttons(view(element).rows[0]!).transfer); await tick(100); const sent = request(socket); await tick(15000); assert.match(element['error'].textContent ?? '', /逾時/);
        socket.deliver({ type: 'ok', requestId: sent.requestId }); await settle();
      }
      for (const row of view(element).rows) busy(row, false);
      press(buttons(view(element).rows[0]!).transfer); await tick(100); assert.equal(request(socket).type, 'control:transfer'); transferBusy(element);
      socket.deliver({ type: 'ok', requestId: request(socket).requestId }); await settle(); for (const row of view(element).rows) busy(row, false);
    });
  }

  for (const onStage of [false, true]) {
    it(`control transfer from an onStage=${onStage} controller uses the real SDK, validator and Hub and retires before ACK without new media`, async t => {
      const { element, client, socket, tick, h, host, successor, first, second, relay, target } = await hubWidget(t, true, onStage);
      const dialog = confirm(t), media = h.transport.rooms.get(host.roomId)!, peers = new Map(media.peers), publishers = new Map(media.publishers);
      const before = client.me!, old = buttons(target()); assert.equal(before.onStage, onStage);
      press(old.transfer); transferBusy(element); await tick(100); const sent = request(socket);
      assert.equal(sent.type, 'control:transfer'); assert.equal(sent.targetId, first.id); assert.equal(client.me!.role, 'controller');
      assert.match(String(dialog.mock.calls[0]!.arguments[0]), /Managed & <speaker>/);
      const { reply, replies } = await relay(sent); assert.equal(reply.type, 'ok'); retired(element);
      assert.equal(client.me!.participantId, before.participantId); assert.equal(client.state!.roomId, host.roomId);
      assert.equal(client.me!.onStage, onStage); assert.equal(client.me!.role, onStage ? 'speaker' : 'audience'); assert.equal(client.state!.controllerId, first.id);
      assert.equal(client.state!.audience, undefined); assert.equal(client.state!.code, undefined); assert.equal(client['pending'].has(sent.requestId), true);
      const newController = first.s.last('room:state')!; assert.equal(newController.me.role, 'controller'); assert.equal(newController.me.onStage, true);
      assert.equal(newController.me.muted, true); assert.equal(newController.me.forceMuted, false);
      assert.ok(replies.some(reply => reply.type === 'control:transferred')); assert.deepEqual(media.peers, peers); assert.deepEqual(media.publishers, publishers);
      assert.equal(socket.sent.some(message => message.type === 'rtc:offer'), false);
      assert.equal(await h.req(successor.s, { type: 'mic:force-mute', targetId: second.id }), 'forbidden');
      assert.equal(await h.req(first.s, { type: 'mic:force-mute', targetId: second.id }), 'ok');
      element['show'](new Error('Feedback after role change')); force(old.transfer); force(old.mute); force(old.remove);
      socket.deliver(reply); await settle(); retired(element); assert.equal(element['error'].textContent, 'Feedback after role change'); assert.equal(requests(socket).length, 1);
    });
  }

  for (const race of ['target offline', 'target leaves', 'authority lost'] as const) {
    it(`control transfer leaves an unobserved real Hub ${race} race to existing server policy`, async t => {
      const { element, socket, tick, h, host, successor, first, relay, target } = await hubWidget(t); confirm(t);
      press(buttons(target()).transfer); await tick(100); const sent = request(socket);
      if (race === 'target offline') await h.hub.detach(first.s);
      else if (race === 'target leaves') assert.equal(await h.req(first.s, { type: 'stage:leave' }), 'ok');
      else assert.equal(await h.req(successor.s, { type: 'control:transfer', targetId: host.id }), 'ok');
      const { reply } = await relay(sent);
      // The existing server also permits connected offstage targets; widget eligibility is intentionally narrower.
      if (race === 'target leaves') {
        assert.equal(reply.type, 'ok'); const promoted = first.s.last('room:state')!;
        assert.equal(promoted.me.role, 'controller'); assert.equal(promoted.me.onStage, false); assert.equal(promoted.controllerId, first.id);
      }
      else { assert.equal(reply.type, 'error'); if (reply.type === 'error') assert.equal(reply.code, race === 'authority lost' ? 'forbidden' : 'conflict'); }
      socket.deliver(reply); await settle(); assert.equal(requests(socket).length, 1);
      if (reply.type === 'error') assert.equal(element['error'].hidden, false);
    });
  }

  it('control transfer reserves before an SDK method synchronously forwards state and reenters all three actions', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state()), pending = deferred(); confirm(t);
    const mute = t.mock.method(client, 'forceMute', async () => {}), remove = t.mock.method(client, 'removeFromStage', async () => {});
    const transfer = t.mock.method(client, 'transferControl', () => {
      socket.deliver({ type: 'room:state', ...state() }); transferBusy(element);
      for (const row of view(element).rows) reenter(row); return pending.promise;
    });
    press(buttons(view(element).rows[0]!).transfer); transferBusy(element);
    assert.equal(transfer.mock.callCount(), 1); assert.equal(mute.mock.callCount(), 0); assert.equal(remove.mock.callCount(), 0);
    pending.resolve(); await settle(); for (const row of view(element).rows) busy(row, false);
  });

  for (const decision of ['cancel', 'throw'] as const) {
    it(`control transfer's retired dialog ${decision} cannot release a nested replacement controller's pending transfer`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), pending = deferred(); let dialogs = 0;
      const transfer = t.mock.method(client, 'transferControl', () => pending.promise);
      confirm(t, () => {
        if (++dialogs === 2) return true;
        const demoted = state(); demoted.me.role = 'audience'; demoted.controllerId = 'other';
        socket.deliver({ type: 'room:state', ...demoted }); socket.deliver({ type: 'room:state', ...state() });
        press(buttons(view(element).rows[1]!).transfer); transferBusy(element); error(socket, 'Nested controller feedback');
        if (decision === 'throw') throw new Error('Obsolete dialog exception'); return false;
      });
      press(buttons(view(element).rows[0]!).transfer); await settle(); transferBusy(element);
      assert.equal(dialogs, 2); assert.equal(transfer.mock.callCount(), 1); assert.equal(transfer.mock.calls[0]!.arguments[0], 'second');
      assert.equal(element['error'].textContent, 'Nested controller feedback'); pending.resolve(); await settle();
      for (const row of view(element).rows) busy(row, false);
    });
  }

  it('control transfer restores a supported method only for a fresh explicit action and leaves moderation available while unsupported', async t => {
    const { element, client } = await socketJoinedWidget(t, state()); const transfer = t.mock.method(client, 'transferControl', async () => {}), method = client.transferControl;
    const dialog = confirm(t), row = view(element).rows[0]!, action = buttons(row).transfer;
    Reflect.set(client, 'transferControl', undefined); element['render'](); assert.equal(action.hidden, true); force(action);
    assert.equal(dialog.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0); assert.equal(buttons(row).mute.disabled, false);
    Reflect.set(client, 'transferControl', method); element['render'](); assert.equal(action.hidden, false); assert.equal(action.disabled, false);
    press(action); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(transfer.mock.callCount(), 1);
  });

  it('control transfer isolates actual socket rejection and stale old socket callbacks from a resumed pending handoff', async t => {
    const { element, socket, sockets, tick, hello } = await socketJoinedWidget(t, state()); confirm(t);
    press(buttons(view(element).rows[0]!).transfer); await tick(100); const old = request(socket), stale = socket.onmessage;
    error(socket, 'Current reconnect feedback'); socket.close(); await settle();
    for (const row of view(element).rows) busy(row, false, true);
    await tick(500); const next = sockets[1]!, join = await hello(next);
    next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    press(buttons(view(element).rows[1]!).transfer); await tick(100); const active = request(next); transferBusy(element);
    error(next, 'Fresh resumed feedback');
    for (const message of [{ type: 'ok', requestId: old.requestId }, { type: 'error', requestId: old.requestId, code: 'forbidden', message: 'Stale transfer socket error' },
      { type: 'room:state', ...roomState() }] satisfies ServerMessage[]) stale?.({ data: JSON.stringify(message) });
    await settle(); transferBusy(element); assert.equal(element['error'].textContent, 'Fresh resumed feedback');
    next.deliver({ type: 'ok', requestId: active.requestId }); await settle(); for (const row of view(element).rows) busy(row, false);
  });

  for (const race of ['controller transferred', 'target left'] as const) for (const duringConfirm of [false, true]) {
    it(`control transfer fences actual Hub ${race} notifications before state with duringConfirm=${duringConfirm}`, async t => {
      const { element, client, socket, tick, h, host, successor, first, deliver, target } = await hubWidget(t);
      const original = target(), old = buttons(original), start = successor.s.inbox.length;
      if (race === 'controller transferred') assert.equal(await h.req(successor.s, { type: 'control:transfer', targetId: host.id }), 'ok');
      else assert.equal(await h.req(first.s, { type: 'stage:leave' }), 'ok');
      const events = successor.s.inbox.slice(start).filter(event => !['room:state', 'ok', 'error'].includes(event.type)); assert.ok(events.length);
      let callbacks = 0; element.addEventListener(race === 'controller transferred' ? 'stage-transferred' : 'stage-stageleft', () => {
        callbacks++; assert.equal(client.me!.role, 'controller'); assert.equal(old.transfer.disabled, true); force(old.transfer);
      }, { once: true });
      const dialog = confirm(t, () => { if (duringConfirm) for (const event of events) socket.deliver(event); return true; });
      if (!duringConfirm) for (const event of events) socket.deliver(event);
      press(old.transfer); await tick(100); assert.equal(callbacks, 1); assert.equal(dialog.mock.callCount(), duringConfirm ? 1 : 0); assert.equal(requests(socket).length, 0);
      force(old.transfer); await tick(100); assert.equal(requests(socket).length, 0);
      deliver(); if (race === 'controller transferred') retired(element); else assert.equal(view(element).rows.includes(original), false);
      force(old.transfer); await tick(100); assert.equal(requests(socket).length, 0);
    });
  }

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`control transfer isolates old ${outcome} after actual same-client same-ID disconnect and rejoin`, async t => {
      const { element, client, socket, sockets, tick, joinRequest } = await socketJoinedWidget(t, state()), old = deferred(), active = deferred(); let calls = 0;
      t.mock.method(client, 'transferControl', () => (++calls === 1 ? old : active).promise); confirm(t);
      const original = view(element).rows[0]!, stale = buttons(original); press(stale.transfer); await client.disconnect(); retired(element);
      const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
      const joining = client.join({ roomId: 'one', name: 'Same-ID new controller tenure' }); await settle(); await tick(100); const join = joinRequest(next);
      next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: join.requestId }); await joining;
      assert.notEqual(view(element).rows[0], original); press(buttons(view(element).rows[0]!).transfer); transferBusy(element);
      error(next, 'Fresh same-client handoff feedback'); if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Retired same-client handoff'));
      await settle(); force(stale.transfer); transferBusy(element); assert.equal(calls, 2); assert.equal(element['error'].textContent, 'Fresh same-client handoff feedback');
      assert.equal(requests(socket).length, 0); active.resolve(); await settle(); for (const row of view(element).rows) busy(row, false);
    });
  }

  it('control transfer uses the same first eligible duplicate row for online admission and safe confirmation name', async t => {
    const initial = state(['first']); initial.speakers[0]!.connected = false;
    initial.speakers.push({ ...initial.speakers[0]!, connected: true, name: 'Later duplicate must not authorize handoff' });
    const { element, client, socket } = await socketJoinedWidget(t, initial), transfer = t.mock.method(client, 'transferControl', async () => {}), dialog = confirm(t);
    assert.equal(view(element).rows.length, 1); const row = view(element).rows[0]!; assert.equal(buttons(row).transfer.disabled, true); force(buttons(row).transfer);
    assert.equal(dialog.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
    const next = state(['first']); next.speakers.unshift({ ...next.speakers[0]!, onStage: false, name: 'Offstage duplicate is not the rendered row' });
    socket.deliver({ type: 'room:state', ...next }); press(buttons(row).transfer); await settle();
    assert.equal(transfer.mock.callCount(), 1); assert.match(dialog.mock.calls[0]!.arguments[0] ?? '', /Managed speaker first/);
    assert.doesNotMatch(dialog.mock.calls[0]!.arguments[0] ?? '', /Offstage duplicate/);
  });
  // Complete widget and public SDK with controlled DOM/socket/timers; native number editing, layout,
  // keyboard/IME, accessibility announcements and hardware audio require browser/device validation.
  function gainControls(row: Node) {
    const label = row.children.find(node => node.tagName === 'LABEL'); assert.ok(label);
    const input = label.children.find(node => node.tagName === 'INPUT'), labelText = label.children.find(node => node.tagName === 'SPAN');
    const accepted = row.children.find(node => node.tagName === 'SPAN' && node !== row.children[0]);
    const apply = nodes(row).find(node => node.tagName === 'BUTTON' && node.textContent === '套用混音增益');
    assert.ok(input && labelText && accepted && apply);
    assert.equal(input.type, 'number'); assert.equal(input.min, '-20'); assert.equal(input.max, '20'); assert.equal(input.step, '0.1');
    assert.equal(apply.type, 'button'); assert.equal(accepted.getAttribute('aria-live'), null); assert.equal(accepted.getAttribute('role'), null);
    return { input, label: labelText, accepted, apply };
  }
  function gainDraft(row: Node, value: string): void {
    const controls = gainControls(row); controls.input.value = value; controls.input.oninput?.(new Event('input'));
  }
  function gainRequests(socket: { sent: ClientMessage[] }) {
    return socket.sent.filter((message): message is Extract<ClientMessage, { type: 'mic:gain' }> => message.type === 'mic:gain');
  }
  function gainRequest(socket: { sent: ClientMessage[] }) { const sent = gainRequests(socket).at(-1); assert.ok(sent); return sent; }
  function gainBusy(row: Node, expected: boolean, disabled = expected): void {
    const { input, apply } = gainControls(row);
    for (const node of [input, apply]) { assert.equal(node.disabled, disabled); assert.equal(node.getAttribute('aria-busy'), String(expected)); }
  }
  function gainWrites(t: TestContext, rows: Node[]) {
    const writes = { text: 0, attribute: 0, disabled: 0, value: 0, static: 0 }, changes = { ...writes };
    for (const row of rows) {
      const controls = gainControls(row);
      const fields: [Node, 'textContent' | 'disabled' | 'value' | 'type' | 'min' | 'max' | 'step', keyof typeof writes][] = [
        [controls.accepted, 'textContent', 'text'], [controls.label, 'textContent', 'text'], [controls.apply, 'textContent', 'static'],
        [controls.input, 'disabled', 'disabled'], [controls.apply, 'disabled', 'disabled'], [controls.input, 'value', 'value'],
        [controls.input, 'type', 'static'], [controls.input, 'min', 'static'], [controls.input, 'max', 'static'], [controls.input, 'step', 'static'], [controls.apply, 'type', 'static'],
      ];
      for (const [node, key, counter] of fields) {
        let value = node[key];
        Object.defineProperty(node, key, { configurable: true, get: () => value, set: (next: string | boolean) => {
          writes[counter]++; if (value !== next) changes[counter]++; value = next;
        } });
        t.after(() => { Object.defineProperty(node, key, { configurable: true, writable: true, value }); });
      }
      for (const node of [controls.accepted, controls.label, controls.input, controls.apply]) {
        const original = node.setAttribute;
        t.mock.method(node, 'setAttribute', function (this: Node, key: string, value: string): void {
          writes.attribute++; if (this.getAttribute(key) !== value) changes.attribute++; original.call(this, key, value);
        });
      }
    }
    const reset = () => { for (const key of Object.keys(writes) as (keyof typeof writes)[]) writes[key] = changes[key] = 0; };
    const expect = (text = 0, attribute = 0, disabled = 0) => {
      assert.deepEqual(writes, { text, attribute, disabled, value: 0, static: 0 });
      assert.deepEqual(changes, writes, 'every new guarded field write changes its current DOM value'); reset();
    };
    return { reset, expect };
  }

  for (const onStage of [false, true]) it(`gain UI: actual ${onStage ? 'onstage' : 'offstage'} controller Apply reaches SDK validator Hub, bounds, rounding and reset`, async t => {
    const f = await hubWidget(t, false, onStage), row = f.target(), controls = gainControls(row);
    const media = f.h.transport.rooms.get(f.host.roomId)!, peer = media.peers.get(f.first.id), publisher = media.publishers.get(f.first.id);
    assert.equal(controls.input.value, '0'); assert.equal(controls.accepted.textContent, '目前混音增益：0 dB');
    assert.match(controls.label.textContent, /Managed & <speaker>.*草稿.*dB.*-20.*\+20.*0.1/);
    assert.match(controls.apply.getAttribute('aria-label')!, /Managed & <speaker>/);
    assert.match(view(f.element).notice.textContent, /房間混音.*0.*本機播放音量.*硬體增益.*不會解除靜音.*下次上台/);
    for (const [raw, wire, accepted] of [['3.26', 3.26, 3.3], ['-6.04', -6.04, -6], ['20', 20, 20], ['-20', -20, -20], ['0', 0, 0]] as const) {
      gainDraft(row, raw); const before = gainRequests(f.socket).length; controls.input.onchange?.(new Event('change')); await f.tick(100);
      assert.equal(gainRequests(f.socket).length, before, 'edits never submit');
      press(controls.apply); force(controls.apply); gainBusy(row, true); await f.tick(100);
      const sent = gainRequest(f.socket); assert.equal(sent.targetId, f.first.id); assert.equal(sent.gainDb, wire); assert.equal(gainRequests(f.socket).length, before + 1);
      const { reply } = await f.relay(sent); assert.equal(reply.type, 'ok'); gainBusy(row, true);
      assert.equal(controls.accepted.textContent, `目前混音增益：${accepted > 0 ? '+' : ''}${accepted} dB`);
      assert.equal(controls.input.value, raw); f.socket.deliver(reply); await settle(); gainBusy(row, false); assert.equal(controls.input.value, raw);
    }
    assert.equal(f.client.playbackVolume, 1); assert.equal(f.client.playbackMuted, false);
    assert.equal(media.peers.get(f.first.id), peer); assert.equal(media.publishers.get(f.first.id), publisher);
    assert.equal(f.socket.sent.some(message => message.type === 'rtc:offer'), false); assert.equal(f.target(), row);
  });

  it('gain UI: retained offline self-muted and force-muted speaker accepts gain without unmuting or changing local playback', async t => {
    const f = await hubWidget(t, true); await f.h.hub.detach(f.first.s);
    assert.equal(await f.h.req(f.successor.s, { type: 'mic:force-mute', targetId: f.first.id }), 'ok'); f.deliver();
    const row = f.target(); assert.match(text(row), /暫時離線.*目前混音增益/); gainBusy(row, false);
    for (const value of ['20', '-20', '0']) {
      gainDraft(row, value); press(gainControls(row).apply); await f.tick(100); const { reply } = await f.relay(gainRequest(f.socket));
      assert.equal(reply.type, 'ok'); f.socket.deliver(reply); await settle();
      const person = f.client.state!.speakers.find(person => person.participantId === f.first.id)!;
      assert.equal(person.gainDb, Number(value)); assert.equal(person.connected, false); assert.equal(person.muted, true); assert.equal(person.forceMuted, true);
      assert.equal(f.client.playbackVolume, 1); assert.equal(f.target(), row);
    }
  });

  it('gain UI: actual hand approval creates a gain editor whose explicit Apply changes the newly approved speaker', async t => {
    const f = await hubWidget(t), applicant = await f.h.join(f.host.roomId, f.host.code, 'New & <speaker>');
    assert.equal(await f.h.req(applicant.s, { type: 'hand:raise' }), 'ok'); f.deliver();
    const hand = f.element['handQueueRows'].get(applicant.id); assert.ok(hand); click(hand.approve); await f.tick(100);
    const sent = f.socket.sent.at(-1)!; assert.equal(sent.type, 'stage:approve');
    const approval = await f.relay(sent); assert.equal(approval.reply.type, 'ok'); f.socket.deliver(approval.reply); await settle();
    assert.equal(f.element['handQueueRows'].has(applicant.id), false);
    const row = f.target(applicant.id); gainDraft(row, '-4.56'); press(gainControls(row).apply); await f.tick(100);
    const changed = await f.relay(gainRequest(f.socket)); assert.equal(changed.reply.type, 'ok'); f.socket.deliver(changed.reply); await settle();
    assert.equal(gainControls(row).accepted.textContent, '目前混音增益：-4.6 dB'); assert.equal(gainControls(row).input.value, '-4.56');
  });

  for (const race of ['departed target', 'transferred controller'] as const) it(`gain UI: real server owns the ${race} race after widget admission`, async t => {
    const f = await hubWidget(t), row = f.target(); gainDraft(row, '-6.04'); press(gainControls(row).apply); await f.tick(100); const sent = gainRequest(f.socket);
    if (race === 'departed target') assert.equal(await f.h.req(f.first.s, { type: 'stage:leave' }), 'ok');
    else assert.equal(await f.h.req(f.successor.s, { type: 'control:transfer', targetId: f.host.id }), 'ok');
    f.deliver(); assert.equal(view(f.element).rows.includes(row), false); const result = await f.relay(sent);
    if (race === 'departed target') {
      assert.equal(result.reply.type, 'ok'); assert.equal(f.client.state!.audience!.find(person => person.participantId === f.first.id)!.gainDb, -6);
      assert.equal(await f.h.req(f.first.s, { type: 'hand:raise' }), 'ok');
      assert.equal(await f.h.req(f.successor.s, { type: 'stage:approve', targetId: f.first.id }), 'ok'); f.deliver();
      const fresh = f.target(); assert.notEqual(fresh, row); assert.equal(gainControls(fresh).input.value, '-6'); gainBusy(fresh, true);
      force(gainControls(row).apply); force(gainControls(fresh).apply); await f.tick(100); assert.equal(gainRequests(f.socket).length, 1);
      f.socket.deliver(result.reply); await settle(); gainBusy(fresh, false);
    } else {
      assert.equal(result.reply.type, 'error'); if (result.reply.type === 'error') assert.equal(result.reply.code, 'forbidden');
      f.socket.deliver(result.reply); await settle(); retired(f.element);
    }
  });

  it('gain UI: rejects invalid forced drafts without requests or error clearing and accepts finite decimal precision', async t => {
    const { element, socket, tick } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, controls = gainControls(row);
    error(socket, 'Keep invalid draft feedback');
    for (const raw of ['', ' ', '\t\n', '-', '+', '.', '1..2', '1e', '0x10', '0b10', 'NaN', 'Infinity', '-Infinity', '1e999', '20.001', '-20.001', '2 dB', '1,5']) {
      gainDraft(row, raw); controls.input.onchange?.(new Event('change')); assert.equal(controls.apply.disabled, true); force(controls.apply);
      assert.equal(controls.input.value, raw); assert.equal(element['error'].textContent, 'Keep invalid draft feedback');
    }
    await tick(100); assert.equal(gainRequests(socket).length, 0);
    for (const [raw, value] of [['.25', .25], ['+1.234', 1.234], ['-0', -0], ['1e-1', .1], [' 2.5 ', 2.5]] as const) {
      gainDraft(row, raw); assert.equal(controls.apply.disabled, false); press(controls.apply); await tick(100); const sent = gainRequest(socket);
      assert.equal(sent.gainDb, value === 0 ? 0 : value); socket.deliver({ type: 'ok', requestId: sent.requestId }); await settle();
      assert.equal(controls.input.value, raw); assert.equal(controls.accepted.textContent, '目前混音增益：0 dB', 'ACK alone never changes accepted gain');
    }
  });

  it('gain UI: 24 fresh and 24 reused snapshots preserve all dirty drafts and write zero equal fields', async t => {
    const f = await hubWidget(t), rows = [...view(f.element).rows], row = f.target(), controls = gainControls(row);
    gainDraft(row, ''); f.element['nameInput'].value = 'Dirty name'; f.element['roomNameInput'].value = 'Dirty room'; view(f.element).disclosure.open = true;
    const observed = gainWrites(t, rows), original = rowWrites(t, rows), replace = t.mock.method(view(f.element).list, 'replaceChildren');
    for (let i = 0; i < 24; i++) f.deliver();
    for (let i = 0; i < 24; i++) f.client.dispatchEvent(new CustomEvent('state', { detail: f.client.state! }));
    observed.expect(); original.expect(); assert.equal(controls.input.value, ''); assert.equal(f.element['nameInput'].value, 'Dirty name'); assert.equal(f.element['roomNameInput'].value, 'Dirty room');
    assert.equal(replace.mock.callCount(), 0); assert.equal(view(f.element).disclosure.open, true);
    const update = f.client.setGain(f.first.id, 5.12); await f.tick(100); const result = await f.relay(gainRequest(f.socket)); f.socket.deliver(result.reply); await update;
    observed.expect(1); original.expect(); assert.equal(controls.accepted.textContent, '目前混音增益：+5.1 dB'); assert.equal(controls.input.value, '');
    const current = f.client.state!; current.speakers.find(person => person.participantId === f.first.id)!.name = '&lt;img&gt; &amp; &quot;safe&quot;';
    current.speakers.reverse(); f.client.dispatchEvent(new CustomEvent('state', { detail: current }));
    observed.expect(1, 1); original.expect(1, 3); assert.equal(controls.input.value, ''); assert.match(controls.label.textContent, /<img> & "safe"/);
    assert.equal(nodes(row).some(node => node.tagName === 'IMG'), false); assert.equal(Reflect.get(controls.label, 'innerHTML'), undefined);
    f.element['syncStageManagement'](); observed.expect(); original.expect();
  });

  it('gain UI: host-corrupted dynamic fields are repaired from live DOM while draft text remains user-owned', async t => {
    const f = await hubWidget(t), row = f.target(), controls = gainControls(row); gainDraft(row, '4.444');
    controls.accepted.textContent = 'Corrupt'; controls.label.textContent = 'Corrupt'; controls.apply.setAttribute('aria-label', 'Corrupt');
    for (const node of [controls.input, controls.apply]) { node.disabled = true; node.setAttribute('aria-busy', 'Corrupt'); }
    const observed = gainWrites(t, [row]); f.deliver(); observed.expect(2, 3, 2); assert.equal(controls.input.value, '4.444');
    f.deliver(); observed.expect();
  });

  for (const field of ['accepted', 'label', 'apply label', 'input disabled', 'apply disabled', 'input busy', 'apply busy'] as const) {
    it(`gain UI: retries a failed ${field} write without cached snapshot or draft repair`, async t => {
      const f = await hubWidget(t), row = f.target(), controls = gainControls(row); gainDraft(row, '1.234');
      const node = field === 'accepted' ? controls.accepted : field === 'label' ? controls.label : field.startsWith('input') ? controls.input : controls.apply;
      const key = field === 'accepted' || field === 'label' ? 'textContent' : field.endsWith('disabled') ? 'disabled' : field.endsWith('busy') ? 'aria-busy' : 'aria-label';
      let fail = true, attempts = 0;
      if (key === 'textContent' || key === 'disabled') {
        let value: string | boolean = key === 'disabled' ? true : 'Corrupt';
        Object.defineProperty(node, key, { configurable: true, get: () => value, set: (next: string | boolean) => { attempts++; if (fail) throw new Error('Gain DOM failure'); value = next; } });
        t.after(() => Object.defineProperty(node, key, { configurable: true, writable: true, value }));
      } else {
        node.setAttribute(key, 'Corrupt'); const original = node.setAttribute;
        t.mock.method(node, 'setAttribute', function (this: Node, attribute: string, value: string): void {
          if (attribute === key) { attempts++; if (fail) throw new Error('Gain DOM failure'); } original.call(this, attribute, value);
        });
      }
      assert.throws(() => f.element['syncStageManagement'](), /Gain DOM failure/); assert.equal(attempts, 1);
      fail = false; f.element['syncStageManagement'](); assert.equal(attempts, 2); f.element['syncStageManagement'](); assert.equal(attempts, 2);
      assert.equal(controls.input.value, '1.234'); gainBusy(row, false);
    });
  }

  for (const action of ['mute', 'unmute', 'remove'] as const) for (const gainFirst of [false, true]) {
    it(`gain UI: shares target reservation with ${action}, gainFirst=${gainFirst}, but leaves other targets independent`, async t => {
      const initial = state(); initial.speakers[0]!.forceMuted = action === 'unmute';
      const { element, client, socket } = await socketJoinedWidget(t, initial), first = view(element).rows[0]!, second = view(element).rows[1]!;
      const pending = deferred(), independent = deferred();
      const gain = t.mock.method(client, 'setGain', (id: string) => id === 'first' ? pending.promise : independent.promise);
      const moderate = t.mock.method(client, action === 'remove' ? 'removeFromStage' : action === 'unmute' ? 'forceUnmute' : 'forceMute', () => pending.promise);
      const button = action === 'remove' ? buttons(first).remove : buttons(first).mute;
      if (gainFirst) press(gainControls(first).apply); else press(button);
      force(gainControls(first).apply); force(buttons(first).mute); force(buttons(first).remove); gainBusy(first, true);
      assert.equal(gain.mock.callCount(), gainFirst ? 1 : 0); assert.equal(moderate.mock.callCount(), gainFirst ? 0 : 1);
      const dialog = confirm(t); for (const row of view(element).rows) force(buttons(row).transfer); assert.equal(dialog.mock.callCount(), 0);
      press(gainControls(second).apply); gainBusy(second, true); assert.equal(gain.mock.callCount(), gainFirst ? 2 : 1);
      pending.resolve(); await settle(); gainBusy(first, false); gainBusy(second, true); independent.resolve(); await settle(); gainBusy(second, false);
      assert.equal(requests(socket).length, 0);
    });
  }

  for (const decision of ['cancel', 'accept', 'throw'] as const) it(`gain UI: global transfer ${decision} disables draft and Apply throughout reentrant confirmation and settlement`, async t => {
    const { element, client } = await socketJoinedWidget(t, state()), pending = deferred();
    const gain = t.mock.method(client, 'setGain', async () => {}), transfer = t.mock.method(client, 'transferControl', () => pending.promise);
    const check = () => { for (const row of view(element).rows) { gainBusy(row, false, true); force(gainControls(row).apply); } assert.equal(gain.mock.callCount(), 0); };
    confirm(t, () => { check(); if (decision === 'throw') throw new Error('Confirmation failed'); return decision === 'accept'; });
    press(buttons(view(element).rows[0]!).transfer); await settle();
    if (decision === 'accept') { check(); assert.equal(transfer.mock.callCount(), 1); pending.resolve(); await settle(); }
    else assert.equal(transfer.mock.callCount(), 0);
    for (const row of view(element).rows) gainBusy(row, false);
  });

  it('gain UI: synchronously reserves before SDK and event reentry, capturing the submitted decimal before a newer draft', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, pending = deferred(); gainDraft(row, '3.267');
    element.addEventListener('stage-state', () => { force(gainControls(row).apply); force(buttons(row).mute); force(buttons(row).remove); gainDraft(row, '-2.001'); }, { once: true });
    const gain = t.mock.method(client, 'setGain', (_id: string, _value: number) => { socket.deliver({ type: 'room:state', ...state() }); return pending.promise; });
    const mute = t.mock.method(client, 'forceMute', async () => {}), remove = t.mock.method(client, 'removeFromStage', async () => {});
    press(gainControls(row).apply); assert.equal(gain.mock.callCount(), 1); assert.deepEqual(gain.mock.calls[0]!.arguments, ['first', 3.267]);
    assert.equal(mute.mock.callCount(), 0); assert.equal(remove.mock.callCount(), 0); gainBusy(row, true); assert.equal(gainControls(row).input.value, '-2.001');
    pending.resolve(); await settle(); gainBusy(row, false); assert.equal(gainControls(row).input.value, '-2.001');
  });

  for (const outcome of ['resolve', 'reject'] as const) it(`gain UI: removed/reappeared same-ID row keeps reservation and isolates obsolete row ${outcome}`, async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state()), original = view(element).rows[0]!, old = deferred(), active = deferred(); let calls = 0;
    const gain = t.mock.method(client, 'setGain', () => (++calls === 1 ? old : active).promise); gainDraft(original, '5.555'); press(gainControls(original).apply);
    socket.deliver({ type: 'room:state', ...state(['second']) }); assert.equal(gainControls(original).input.disabled, true);
    for (const row of view(element).rows) { assert.equal(buttons(row).transfer.disabled, true); force(buttons(row).transfer); }
    const freshState = state(); freshState.speakers[0]!.gainDb = 7; socket.deliver({ type: 'room:state', ...freshState });
    const fresh = view(element).rows[0]!; assert.notEqual(fresh, original); assert.equal(gainControls(fresh).input.value, '7'); gainBusy(fresh, true);
    force(gainControls(original).apply); force(gainControls(fresh).apply); assert.equal(gain.mock.callCount(), 1); error(socket, 'Keep replacement error');
    if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Retired row gain failure')); await settle(); gainBusy(fresh, false);
    assert.equal(element['error'].textContent, 'Keep replacement error'); assert.equal(gainControls(fresh).input.value, '7');
    press(gainControls(fresh).apply); force(gainControls(original).apply); gainBusy(fresh, true); assert.equal(calls, 2); active.resolve(); await settle(); gainBusy(fresh, false);
  });

  for (const failure of ['synchronous', 'rejection', 'queue_full', 'timeout'] as const) it(`gain UI: current ${failure} preserves draft and unlocks for explicit retry only`, async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!; gainDraft(row, '2.345');
    if (failure === 'synchronous' || failure === 'rejection') {
      const mock = t.mock.method(client, 'setGain', () => { if (failure === 'synchronous') throw new Error('Current gain failure'); return Promise.reject(new Error('Current gain failure')); });
      press(gainControls(row).apply); await settle(); mock.mock.restore(); assert.equal(element['error'].textContent, 'Current gain failure');
    } else if (failure === 'queue_full') {
      Object.defineProperty(client, 'maxPendingControlRequests', { value: 1 }); const unrelated = client.forceMute('unlisted').catch(() => {});
      press(gainControls(row).apply); await settle(); assert.match(element['error'].textContent ?? '', /佇列|請求/); await tick(100);
      socket.deliver({ type: 'ok', requestId: request(socket).requestId }); await unrelated; assert.equal(gainRequests(socket).length, 0);
    } else {
      press(gainControls(row).apply); await tick(100); const expired = gainRequest(socket); await tick(15000); assert.match(element['error'].textContent ?? '', /逾時/);
      socket.deliver({ type: 'ok', requestId: expired.requestId }); await settle(); assert.equal(gainRequests(socket).length, 1);
    }
    gainBusy(row, false); assert.equal(gainControls(row).input.value, '2.345'); assert.equal(gainControls(row).accepted.textContent, '目前混音增益：0 dB');
    press(gainControls(row).apply); await tick(100); const retry = gainRequest(socket); gainBusy(row, true); assert.equal(retry.gainDb, 2.345);
    socket.deliver({ type: 'ok', requestId: retry.requestId }); await settle(); gainBusy(row, false); assert.equal(gainControls(row).input.value, '2.345');
  });

  it('gain UI: start and ACK preserve independent feedback and never treat ACK as accepted gain', async t => {
    const { element, socket, tick } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!;
    gainDraft(row, '3.26'); error(socket, 'Keep independent feedback'); press(gainControls(row).apply);
    assert.equal(element['error'].textContent, 'Keep independent feedback'); assert.equal(element['error'].hidden, false); await tick(100); const sent = gainRequest(socket);
    socket.deliver({ type: 'ok', requestId: sent.requestId }); await settle(); assert.equal(element['error'].textContent, 'Keep independent feedback'); assert.equal(element['error'].hidden, false);
    assert.equal(gainControls(row).accepted.textContent, '目前混音增益：0 dB'); assert.equal(gainControls(row).input.value, '3.26');
  });

  for (const removed of ['row', 'input', 'apply'] as const) it(`gain UI: physically removed ${removed} cannot authorize a retained forced callback`, async t => {
    const { element, client } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, controls = gainControls(row);
    const gain = t.mock.method(client, 'setGain', async () => {});
    if (removed === 'row') view(element).list.children.splice(0, 1);
    else if (removed === 'input') row.children.find(node => node.tagName === 'LABEL')!.children.pop();
    else row.children.splice(row.children.indexOf(controls.apply), 1);
    force(controls.apply); await settle(); assert.equal(gain.mock.callCount(), 0); assert.equal(element['stageManagementPending'].size, 0);
  });

  for (const ancestor of ['list', 'panel'] as const) it(`gain UI: disconnected ${ancestor} subtree cannot authorize retained Apply`, async t => {
    const { element, client } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, controls = gainControls(row);
    const gain = t.mock.method(client, 'setGain', async () => {});
    // The controlled DOM supplies the native disconnected-subtree flags, not browser tree propagation.
    for (const node of nodes(ancestor === 'list' ? view(element).list : view(element).disclosure)) node.isConnected = false;
    force(controls.apply); await settle(); assert.equal(gain.mock.callCount(), 0); assert.equal(element['stageManagementPending'].size, 0);
  });

  for (const mutation of ['role', 'target', 'status', 'method', 'owner offline', 'row replacement', 'input detached'] as const) it(`gain UI: reservation render ${mutation} reentry cannot submit a retired or ineligible action`, async t => {
    const { element, client } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, controls = gainControls(row);
    const gain = t.mock.method(client, 'setGain', async () => {}); let disabled = false, changed = false;
    Object.defineProperty(controls.input, 'disabled', { configurable: true, get: () => disabled, set: (value: boolean) => {
      disabled = value; if (!value || changed) return; changed = true;
      if (mutation === 'role') client.state!.me.role = 'audience';
      else if (mutation === 'target') client.state!.speakers[0]!.onStage = false;
      else if (mutation === 'status') client['currentStatus'] = 'reconnecting';
      else if (mutation === 'method') Object.defineProperty(client, 'setGain', { configurable: true, value: undefined });
      else if (mutation === 'owner offline') client.state!.me.connected = false;
      else if (mutation === 'input detached') row.children.find(node => node.tagName === 'LABEL')!.children.pop();
      else {
        const person = client.state!.speakers.shift()!; element['syncStageManagement'](); client.state!.speakers.unshift(person);
      }
      element['syncStageManagement']();
    } });
    t.after(() => Object.defineProperty(controls.input, 'disabled', { configurable: true, writable: true, value: disabled }));
    press(controls.apply); await settle(); assert.equal(changed, true); assert.equal(gain.mock.callCount(), 0); assert.equal(element['stageManagementPending'].size, 0);
  });

  it('gain UI: reconnect retains dirty raw drafts, accepted stale marker, disclosure and deferred token without replay', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, other = view(element).rows[1]!, pending = deferred();
    gainDraft(row, '3.260'); gainDraft(other, ''); view(element).disclosure.open = true;
    const gain = t.mock.method(client, 'setGain', () => pending.promise); press(gainControls(row).apply);
    error(socket, 'Keep reconnect feedback');
    element.addEventListener('stage-status', () => { for (const current of view(element).rows) force(gainControls(current).apply); }, { once: true });
    socket.close(); await settle(); assert.equal(view(element).rows[0], row); gainBusy(row, true); assert.equal(gainControls(other).input.disabled, true);
    assert.match(gainControls(row).accepted.textContent, /上次收到/); assert.equal(gainControls(row).input.value, '3.260'); assert.equal(gainControls(other).input.value, '');
    await tick(500); const next = sockets[1]!, resume = await hello(next), changed = state(['second', 'first'], true);
    changed.speakers[1]!.name = 'Resumed &amp; renamed'; changed.speakers[1]!.gainDb = -4.5;
    next.deliver({ type: 'room:state', ...changed }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assert.equal(view(element).rows[1], row); assert.equal(view(element).disclosure.open, true); gainBusy(row, true);
    assert.equal(gainControls(row).accepted.textContent, '目前混音增益：-4.5 dB'); assert.equal(gainControls(row).input.value, '3.260');
    assert.equal(gainControls(other).input.value, ''); assert.equal(gainControls(other).input.disabled, false); assert.equal(gainControls(other).apply.disabled, true);
    assert.equal(gain.mock.callCount(), 1); assert.equal(gainRequests(next).length, 0); pending.resolve(); await settle(); gainBusy(row, false);
    assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Keep reconnect feedback');
  });

  it('gain UI: actual socket loss releases failed request while stale old wire cannot settle a resumed gain', async t => {
    const { element, socket, sockets, tick, hello } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!;
    gainDraft(row, '5.550'); press(gainControls(row).apply); await tick(100); const old = gainRequest(socket), stale = socket.onmessage;
    socket.close(); await settle(); assert.equal(gainControls(row).input.value, '5.550'); assert.equal(gainControls(row).input.disabled, true);
    assert.equal(gainControls(row).apply.getAttribute('aria-busy'), 'false'); assert.equal(element['error'].textContent, '連線已中斷。');
    await tick(500); const next = sockets[1]!, resume = await hello(next); next.deliver({ type: 'room:state', ...state() }); next.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assert.equal(view(element).rows[0], row); press(gainControls(row).apply); await tick(100); const active = gainRequest(next);
    for (const message of [{ type: 'ok', requestId: old.requestId }, { type: 'error', code: 'conflict', message: 'Obsolete wire', requestId: old.requestId }, { type: 'room:state', ...state([]) }] satisfies ServerMessage[]) stale?.({ data: JSON.stringify(message) });
    await settle(); gainBusy(row, true); assert.equal(element['error'].textContent, '連線已中斷。'); assert.equal(gainControls(row).input.value, '5.550');
    next.deliver({ type: 'ok', requestId: active.requestId }); await settle(); gainBusy(row, false);
  });

  for (const invalid of ['missing target', 'self', 'offstage target', 'unknown target role', 'owner offline', 'owner role', 'detached element', 'missing current', 'missing snapshot', 'unknown status', 'disconnected', 'reconnecting'] as const) {
    it(`gain UI: silent ${invalid} blocks forced callback without clearing current feedback`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, controls = gainControls(row);
      const gain = t.mock.method(client, 'setGain', async () => {}); error(socket, 'Keep gate feedback');
      if (invalid === 'missing target') client.state!.speakers.splice(0, 1);
      else if (invalid === 'self') client.state!.me.participantId = 'first';
      else if (invalid === 'offstage target') client.state!.speakers[0]!.onStage = false;
      else if (invalid === 'unknown target role') client.state!.speakers[0]!.role = 'unknown' as 'speaker';
      else if (invalid === 'owner offline') client.state!.me.connected = false;
      else if (invalid === 'owner role') client.state!.me.role = 'audience';
      else if (invalid === 'detached element') Object.assign(element, { isConnected: false });
      else if (invalid === 'missing current') element['current'] = null;
      else if (invalid === 'missing snapshot') client['snapshot'] = null;
      else client['currentStatus'] = (invalid === 'unknown status' ? 'unknown' : invalid) as typeof client.status;
      force(controls.apply); await settle(); assert.equal(gain.mock.callCount(), 0); assert.equal(element['stageManagementPending'].size, 0);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Keep gate feedback');
      element['current'] = client; Object.assign(element, { isConnected: true });
    });
  }

  for (const status of ['waiting', 'live'] as const) it(`gain UI: connected controller can apply in ${status} regardless of own stage seat`, async t => {
    const { element, client } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, gain = t.mock.method(client, 'setGain', async () => {});
    for (const onStage of [false, true]) {
      client['currentStatus'] = status; client.state!.me.onStage = onStage; element['render'](); assert.equal(view(element).rows[0], row);
      press(gainControls(row).apply); await settle();
    }
    assert.equal(gain.mock.callCount(), 2);
  });

  it('gain UI: absent SDK capability disables only new controls; restored capability never auto-submits', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, state()), row = view(element).rows[0]!, method = client.setGain;
    gainDraft(row, '7.77'); Reflect.set(client, 'setGain', undefined); element['render'](); gainBusy(row, false, true); busy(row, false);
    force(gainControls(row).apply); await tick(100); assert.equal(gainRequests(socket).length, 0);
    Reflect.set(client, 'setGain', method); element['render'](); gainBusy(row, false); assert.equal(gainControls(row).input.value, '7.77'); await tick(100);
    assert.equal(gainRequests(socket).length, 0); press(gainControls(row).apply); await tick(100); const sent = gainRequest(socket);
    socket.deliver({ type: 'ok', requestId: sent.requestId }); await settle();
  });

  for (const outcome of ['resolve', 'reject'] as const) for (const change of ['role', 'room', 'participant', 'generation'] as const) {
    it(`gain UI: retired ${change} ${outcome} cannot change new tenure draft, accepted gain, feedback or pending`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), original = view(element).rows[0]!, old = deferred(), active = deferred(); let calls = 0;
      t.mock.method(client, 'setGain', () => (++calls === 1 ? old : active).promise); gainDraft(original, '3.33'); press(gainControls(original).apply);
      const changed = state();
      if (change === 'role') { changed.me.role = 'audience'; changed.controllerId = 'other'; }
      else if (change === 'room') changed.roomId = 'two';
      else if (change === 'participant') { changed.me.participantId = 'new'; changed.controllerId = 'new'; }
      else ++element['generation'];
      if (change === 'generation') element['render'](); else socket.deliver({ type: 'room:state', ...changed });
      const freshState = state(); freshState.speakers[0]!.gainDb = -2.5;
      if (change === 'generation') { client['snapshot'] = freshState; element['render'](); } else socket.deliver({ type: 'room:state', ...freshState });
      const fresh = view(element).rows[0]!; assert.notEqual(fresh, original); gainDraft(fresh, '-4.567'); press(gainControls(fresh).apply); element['show'](new Error('Fresh gain feedback'));
      if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Obsolete gain failure')); await settle(); force(gainControls(original).apply);
      assert.equal(calls, 2); gainBusy(fresh, true); assert.equal(gainControls(fresh).input.value, '-4.567'); assert.equal(gainControls(fresh).accepted.textContent, '目前混音增益：-2.5 dB');
      assert.equal(element['error'].textContent, 'Fresh gain feedback'); assert.equal(element['error'].hidden, false); active.resolve(); await settle(); gainBusy(fresh, false);
    });
  }

  for (const transition of ['leave', 'detach', 'direct disconnect', 'ordinary close', 'kick', 'shutdown'] as const) {
    it(`gain UI: ${transition} retires drafts and pending before forwarded callbacks and ignores old rejection`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, state()), old = view(element).rows[0]!, controls = gainControls(old), pending = deferred();
      const gain = t.mock.method(client, 'setGain', () => pending.promise); gainDraft(old, '9.99'); press(controls.apply); view(element).disclosure.open = true;
      const terminal = terminalCases.find(item => item.title === transition); let callbacks = 0;
      if (terminal) element.addEventListener(`stage-${terminal.event}`, () => { callbacks++; retired(element); assert.equal(controls.input.disabled, true); force(controls.apply); }, { once: true });
      if (transition === 'leave') click(element['roomAction']);
      else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else if (transition === 'direct disconnect') await client.disconnect();
      else socket.deliver(terminal!.message);
      await settle(); retired(element); if (terminal) assert.equal(callbacks, 1); assert.equal(element['stageManagementPending'].size, 0);
      element['show'](new Error('Current terminal feedback')); pending.reject(new Error('Obsolete terminal gain')); await settle(); force(controls.apply);
      assert.equal(gain.mock.callCount(), 1); assert.equal(element['error'].textContent, 'Current terminal feedback'); assert.equal(element['error'].hidden, false);
    });
  }

  for (const terminal of [null, ...terminalCases]) it(`gain UI: same-client same-ID rejoin after ${terminal?.title ?? 'disconnect'} starts a fresh draft and isolates old settlement`, async t => {
    const { element, client, socket, sockets, tick, joinRequest } = await socketJoinedWidget(t, state()), old = deferred(), active = deferred(), original = view(element).rows[0]!; let calls = 0;
    t.mock.method(client, 'setGain', () => (++calls === 1 ? old : active).promise); gainDraft(original, '9.999'); press(gainControls(original).apply);
    if (terminal) socket.deliver(terminal.message); else await client.disconnect(); await settle(); retired(element);
    const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
    const joining = client.join({ roomId: 'one', name: 'Fresh same-ID controller' }); await settle(); await tick(100); const join = joinRequest(next), freshState = state(); freshState.speakers[0]!.gainDb = 4.5;
    next.deliver({ type: 'room:state', ...freshState }); next.deliver({ type: 'ok', requestId: join.requestId }); await joining;
    const fresh = view(element).rows[0]!; assert.notEqual(fresh, original); assert.equal(gainControls(fresh).input.value, '4.5'); gainDraft(fresh, '-1.234'); press(gainControls(fresh).apply);
    error(next, 'Fresh rejoin feedback'); old.reject(new Error('Retired same-ID gain')); await settle(); force(gainControls(original).apply);
    assert.equal(calls, 2); gainBusy(fresh, true); assert.equal(gainControls(fresh).input.value, '-1.234'); assert.equal(element['error'].textContent, 'Fresh rejoin feedback');
    active.resolve(); await settle(); gainBusy(fresh, false);
  });

  for (const attribute of ['room', 'name', 'code', 'url'] as const) it(`gain UI: ${attribute} client replacement cannot inherit old draft, callbacks or token`, async t => {
    const { element, client, socket, sockets, hello } = await socketJoinedWidget(t, state()), old = deferred(), original = view(element).rows[0]!;
    t.mock.method(client, 'setGain', () => old.promise); gainDraft(original, '3.456'); press(gainControls(original).apply); const oldMessage = socket.onmessage, oldClose = socket.onclose;
    element.setAttribute(attribute, attribute === 'url' ? 'ws://localhost/new-stage' : attribute === 'room' ? 'two' : 'Changed'); await settle(); await settle(); retired(element);
    const replacement = element.client!; assert.notEqual(replacement, client); const next = sockets[1]!, join = await hello(next);
    const freshState = state(['first'], false, attribute === 'room' ? 'two' : 'one'); freshState.speakers[0]!.gainDb = -3;
    next.deliver({ type: 'room:state', ...freshState }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    const active = deferred(), gain = t.mock.method(replacement, 'setGain', () => active.promise), fresh = view(element).rows[0]!;
    assert.equal(gainControls(fresh).input.value, '-3'); gainDraft(fresh, '1.234'); press(gainControls(fresh).apply); error(next, 'New client feedback');
    old.reject(new Error('Old client gain')); oldMessage?.({ data: JSON.stringify({ type: 'room:state', ...state([]) }) }); oldClose?.(); await settle(); force(gainControls(original).apply);
    gainBusy(fresh, true); assert.equal(gain.mock.callCount(), 1); assert.equal(gainControls(fresh).input.value, '1.234'); assert.equal(element['error'].textContent, 'New client feedback'); active.resolve(); await settle(); gainBusy(fresh, false);
  });

  it('gain UI: forwarded callback snapshot retirement and reconnect-only fresh snapshot cannot restore old ownership', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, state()), old = view(element).rows[0]!, pending = deferred();
    const gain = t.mock.method(client, 'setGain', () => pending.promise); press(gainControls(old).apply);
    element.addEventListener('stage-micready', () => { client['snapshot'] = null; }, { once: true });
    client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); retired(element); error(socket, 'Keep retired feedback');
    pending.reject(new Error('Retired callback gain')); await settle(); assert.equal(element['error'].textContent, 'Keep retired feedback');
    const next = state(); next.me.participantId = 'new-controller'; next.controllerId = next.me.participantId;
    client['snapshot'] = next; client['currentStatus'] = 'reconnecting'; client.dispatchEvent(new CustomEvent('status', { detail: 'reconnecting' })); retired(element);
    force(gainControls(old).apply); assert.equal(gain.mock.callCount(), 1); socket.deliver({ type: 'room:state', ...next }); assert.equal(view(element).rows.length, 2);
  });

  it('gain UI: silent role loss retires on settlement while SDK-global old wire errors retain their documented behavior', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, state()), pending = deferred(), mock = t.mock.method(client, 'setGain', () => pending.promise);
    press(gainControls(view(element).rows[0]!).apply); error(socket, 'Independent feedback'); client.state!.me.role = 'audience';
    pending.reject(new Error('Silent obsolete gain')); await settle(); retired(element); assert.equal(element['error'].textContent, 'Independent feedback'); mock.mock.restore();
    socket.deliver({ type: 'room:state', ...state() }); press(gainControls(view(element).rows[0]!).apply); await tick(100); const old = gainRequest(socket);
    socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver({ type: 'room:state', ...state() });
    const fresh = view(element).rows[0]!; gainDraft(fresh, '6.66'); press(gainControls(fresh).apply); await tick(100); const active = gainRequest(socket);
    socket.deliver({ type: 'error', code: 'forbidden', message: 'Global old wire error', requestId: old.requestId }); await settle();
    assert.equal(element['error'].textContent, 'Global old wire error'); gainBusy(fresh, true); assert.equal(gainControls(fresh).input.value, '6.66');
    socket.deliver({ type: 'ok', requestId: active.requestId }); await settle(); gainBusy(fresh, false);
  });

  for (const race of ['controller transferred', 'target left'] as const) it(`gain UI: notification-before-state ${race} retains moderation policy and server authority`, async t => {
    const f = await hubWidget(t), row = f.target(), start = f.successor.s.inbox.length;
    if (race === 'controller transferred') assert.equal(await f.h.req(f.successor.s, { type: 'control:transfer', targetId: f.host.id }), 'ok');
    else assert.equal(await f.h.req(f.first.s, { type: 'stage:leave' }), 'ok');
    const events = f.successor.s.inbox.slice(start).filter(message => !['room:state', 'ok', 'error'].includes(message.type)); let calls = 0;
    f.element.addEventListener(race === 'controller transferred' ? 'stage-transferred' : 'stage-stageleft', () => {
      calls++; assert.equal(f.client.me!.role, 'controller'); gainDraft(row, '4.56'); press(gainControls(row).apply); assert.equal(buttons(row).transfer.disabled, true);
    }, { once: true });
    for (const event of events) f.socket.deliver(event); assert.equal(calls, 1); await f.tick(100); const sent = gainRequest(f.socket), result = await f.relay(sent);
    assert.equal(result.reply.type, race === 'controller transferred' ? 'error' : 'ok');
    if (result.reply.type === 'error') assert.equal(result.reply.code, 'forbidden'); f.socket.deliver(result.reply); await settle(); f.deliver();
    if (race === 'controller transferred') retired(f.element); else assert.equal(f.client.state!.audience!.find(person => person.participantId === f.first.id)!.gainDb, 4.6);
    force(gainControls(row).apply); await f.tick(100); assert.equal(gainRequests(f.socket).length, 1);
  });

});

/**
 * Stage175 output picker: real SDK enumeration and output selection with controlled native sinks.
 * This proves widget admission and settlement ordering, not audible routing, browser permissions,
 * operating-system defaults, native keyboard/AT behavior, or ordering of direct host SDK calls.
 */
describe('widget explicit output selection', () => {
  type Widget = InstanceType<typeof StageElement>;
  type Operation = 'refresh' | 'apply';
  type Fixture = Awaited<ReturnType<typeof socketJoinedWidget>>;
  const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
  function view(element: Widget) {
    const panel = nodes(element as unknown as Node).find(node => node.part.has('output-device'));
    assert.ok(panel, 'the output-device part exists');
    const children = nodes(panel), select = children.find(node => node.id === 'output-device');
    const refresh = children.find(node => node.textContent === '重新整理輸出裝置清單');
    const apply = children.find(node => node.textContent === '送出輸出裝置選擇');
    assert.ok(select instanceof Select && refresh && apply);
    return { panel, select, refresh, apply };
  }
  const text = (element: Widget) => nodes(view(element).panel).map(node => node.textContent).join('\n');
  const options = (element: Widget) => view(element).select.options.map(option => ({ value: option.value, label: option.textContent, disabled: option.disabled }));
  const owner = (element: Widget): unknown => Reflect.get(element, 'outputDeviceOwner');
  const attempt = (element: Widget): unknown => Reflect.get(element, 'outputDeviceAttempt');
  const button = (element: Widget, operation: Operation) => view(element)[operation];
  function press(node: Node): void { node.onclick?.(); }
  function force(element: Widget): void {
    for (const key of ['outputDeviceRefresh', 'outputDeviceApply']) {
      const node = Reflect.get(element, key) as Node; node.disabled = false; press(node);
    }
  }
  function draft(element: Widget, value: string): void {
    const select = view(element).select; select.value = value;
    assert.equal(select.value, value, 'requested draft exists in the select');
    select.onchange?.(new Event('change'));
  }
  function assertPicker(element: Widget, { hidden = false, disabled = hidden, value = '', busy }:
    { hidden?: boolean; disabled?: boolean; value?: string; busy?: Operation } = {}): void {
    const { panel, select, refresh, apply } = view(element);
    assert.equal(panel.hidden, hidden, 'output picker visibility');
    assert.deepEqual([select.disabled, refresh.disabled, apply.disabled], [disabled, disabled, disabled], 'output admission');
    assert.equal(select.value, value, 'output selection is the retained draft');
    if (busy) assert.equal(view(element)[busy].getAttribute('aria-busy'), 'true');
    else assert.equal(Boolean(attempt(element)), false, 'no operation remains pending');
  }
  function assertRetired(element: Widget): void {
    assertPicker(element, { hidden: true }); assert.equal(owner(element), undefined);
    assert.deepEqual(options(element), [{ value: '', label: '系統預設', disabled: false }]);
  }
  function pending<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function device(deviceId: string, label = '', kind: MediaDeviceKind = 'audiooutput'): MediaDeviceInfo {
    return { deviceId, label, kind, groupId: 'private-output-group', toJSON() { return {}; } };
  }
  function fakeOutput(t: TestContext, supported = true) {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const sinkDescriptor = Object.getOwnPropertyDescriptor(Audio.prototype, 'setSinkId');
    const sinks: (ReturnType<typeof pending<void>> & { audio: Audio; id: string })[] = [];
    const enumerations: ReturnType<typeof pending<MediaDeviceInfo[]>>[] = [];
    const actual = new WeakMap<Audio, string>();
    let available = [device('private-output-a', 'USB speaker'), device('private-output-b', 'Headphones')], held = false;
    let captures = 0;
    const devices = Object.assign(new EventTarget(), {
      enumerateDevices() {
        const request = pending<MediaDeviceInfo[]>(); enumerations.push(request);
        if (!held) request.resolve(available);
        return request.promise;
      },
      async getUserMedia(): Promise<MediaStream> { captures++; throw new Error('Output picker must not request capture'); },
    });
    const setSinkId = function (this: Audio, id: string) {
      const request = { ...pending<void>(), audio: this, id }; sinks.push(request);
      return request.promise.then(() => { actual.set(this, id); });
    };
    function support(value: boolean): void {
      if (value) Object.defineProperty(Audio.prototype, 'setSinkId', { configurable: true, writable: true, value: setSinkId });
      else Reflect.deleteProperty(Audio.prototype, 'setSinkId');
    }
    support(supported);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: devices } });
    t.after(async () => {
      for (const request of sinks) request.resolve();
      for (const request of enumerations) request.resolve([]);
      await settle(); await settle();
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator');
      if (sinkDescriptor) Object.defineProperty(Audio.prototype, 'setSinkId', sinkDescriptor); else Reflect.deleteProperty(Audio.prototype, 'setSinkId');
    });
    return { sinks, enumerations, devices, support, captures: () => captures,
      actual(client: StageClient) { return actual.get(client['audio'] as unknown as Audio) ?? ''; },
      hold(value = true) { held = value; }, list(value: MediaDeviceInfo[]) { available = value; },
    };
  }
  async function refresh(element: Widget): Promise<void> { press(view(element).refresh); await settle(); await settle(); }
  function error(element: Widget, message = 'Independent current error'): void { element['show'](new Error(message)); }
  async function rejoin(fixture: Fixture, state = roomState(false, 'two')) {
    const { client, sockets, tick, joinRequest } = fixture;
    const connecting = client.connect(), socket = sockets.at(-1)!; socket.hello(); await connecting;
    const joining = client.join({ roomId: state.roomId, name: 'New seat' }); await settle(); await tick(100);
    const request = joinRequest(socket); socket.deliver({ type: 'room:state', ...state });
    socket.deliver({ type: 'ok', requestId: request.requestId }); await joining; await settle();
    return socket;
  }
  function observation(element: Widget) {
    // EventTarget reports thrown assertions asynchronously; collect raw observations for the test body.
    const panel = Reflect.get(element, 'outputDevicePanel') as Node, select = Reflect.get(element, 'outputDeviceSelect') as Select;
    const refresh = Reflect.get(element, 'outputDeviceRefresh') as Node, apply = Reflect.get(element, 'outputDeviceApply') as Node;
    return { hidden: panel.hidden, disabled: [select.disabled, refresh.disabled, apply.disabled], value: select.value,
      owner: owner(element), attempt: attempt(element), refresh: refresh.getAttribute('aria-busy'), apply: apply.getAttribute('aria-busy') };
  }

  it('starts hidden without room state and performs no enumeration, sink change, capture, or autoplay while joining', async t => {
    const media = fakeOutput(t), play = t.mock.method(Audio.prototype, 'play');
    const empty = new StageElement(); widgets.push(empty); assertRetired(empty); force(empty); assertRetired(empty);
    const { element, connections, joins } = deferredJoiningWidget(t); await settle();
    assertRetired(element); force(element); assert.equal(connections.length, 1);
    connections[0]!.pending.resolve(); await settle(); assert.equal(joins.length, 1); assertRetired(element); force(element);
    assert.equal(media.enumerations.length, 0); assert.equal(media.sinks.length, 0); assert.equal(media.captures(), 0); assert.equal(play.mock.callCount(), 0);
  });

  it('explains unsupported routing and rejects forced controls without enumeration or SDK output calls', async t => {
    const media = fakeOutput(t, false), { element, client } = await socketJoinedWidget(t);
    const list = t.mock.method(client, 'listAudioDevices'), set = t.mock.method(client, 'setOutputDevice');
    assert.equal(client.outputDeviceSupported, false); assertPicker(element, { disabled: true });
    assert.match(text(element), /此瀏覽器不支援選擇輸出裝置。/); error(element); force(element);
    assert.equal(list.mock.callCount(), 0); assert.equal(set.mock.callCount(), 0); assert.equal(media.enumerations.length, 0);
    assert.equal(element['error'].textContent, 'Independent current error'); assertPicker(element, { disabled: true });
  });

  for (const status of ['waiting', 'live'] as const) for (const role of ['audience', 'speaker', 'controller'] as const) {
    it(`allows explicit output selection for ${status} ${role} without requiring microphone authority`, async t => {
      const media = fakeOutput(t), state = roomState(role === 'speaker'); state.status = status; state.me.role = role;
      if (role === 'controller') state.controllerId = state.me.participantId;
      const { element, client, socket } = await socketJoinedWidget(t, state), frames = [...socket.sent];
      assertPicker(element); assert.equal(media.enumerations.length, 0); await refresh(element); draft(element, 'private-output-a');
      assert.equal(media.sinks.length, 0); press(view(element).apply); assertPicker(element, { disabled: true, value: 'private-output-a', busy: 'apply' });
      assert.equal(media.sinks.length, 1); assert.equal(media.sinks[0]!.id, 'private-output-a');
      media.sinks[0]!.resolve(); await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
      assert.equal(media.actual(client), 'private-output-a'); assert.deepEqual(socket.sent, frames); assert.equal(media.captures(), 0);
    });
  }

  it('labels a draft, filters real outputs, safely renders names, deduplicates IDs, and refreshes without choosing or changing the actual sink', async t => {
    const media = fakeOutput(t), { element, client } = await socketJoinedWidget(t);
    const hostile = '<img src=x onerror=alert(1)> &amp; "speaker"';
    media.list([device('input-secret', 'Not an output', 'audioinput'), device('', 'Empty ID'), device('default', 'OS default'),
      device('private-output-a', hostile), device('private-output-a', 'Duplicate label'), device('anonymous-id', '   ')]);
    await refresh(element); const list = options(element);
    assert.deepEqual(list.map(option => option.value), ['', 'default', 'private-output-a', 'anonymous-id']);
    assert.equal(list[0]!.label, '系統預設'); assert.equal(list[2]!.label, hostile);
    assert.match(list[3]!.label, /輸出裝置|揚聲器/); assert.doesNotMatch(list[3]!.label, /anonymous-id/);
    assert.match(text(element), /輸出裝置選擇（草稿）/); assert.match(text(element), /草稿.*不代表|不代表.*實際/);
    const label = nodes(view(element).panel).find(node => node.tagName === 'LABEL'); assert.equal(label?.getAttribute('for'), 'output-device');
    const described = view(element).select.getAttribute('aria-describedby'); assert.ok(described);
    for (const id of described.split(/\s+/)) assert.ok(nodes(view(element).panel).some(node => node.id === id));
    for (const node of nodes(view(element).panel)) { assert.equal(Reflect.get(node, 'innerHTML'), undefined); assert.ok(!['IMG', 'SCRIPT'].includes(node.tagName)); }
    assert.doesNotMatch(text(element), /Not an output|Empty ID|Duplicate label|input-secret|private-output-group/);
    draft(element, 'private-output-a'); assert.equal(media.sinks.length, 0);
    media.list([device('private-output-b', 'New speaker')]); await refresh(element);
    const retained = options(element).find(option => option.value === 'private-output-a'); assert.ok(retained); assert.equal(retained.disabled, true);
    assert.doesNotMatch(retained.label, /private-output-a/); assert.equal(view(element).select.value, 'private-output-a');
    media.list([]); await refresh(element); assert.equal(view(element).select.value, 'private-output-a');
    media.list([device('private-output-a', 'Returned speaker')]); await refresh(element);
    assert.equal(options(element).find(option => option.value === 'private-output-a')?.disabled, false);
    assert.equal(media.actual(client), ''); assert.equal(media.sinks.length, 0);
    const count = media.enumerations.length; media.devices.dispatchEvent(new Event('devicechange')); await settle(); assert.equal(media.enumerations.length, count);
    assert.equal(getEventListeners(media.devices, 'devicechange').length, 0);
  });

  it('changes only the local sink, retains volume/listen/mic policy and autoplay notice, and restores system default only on explicit Apply', async t => {
    const media = fakeOutput(t), state = roomState(true); state.me.muted = true; state.me.forceMuted = true;
    const { element, client, socket } = await socketJoinedWidget(t, state), frames = [...socket.sent];
    element.playbackVolume = .37; element.playbackMuted = true;
    client.dispatchEvent(new CustomEvent('audioblocked', { detail: { message: 'Autoplay blocked' } }));
    const play = t.mock.method(Audio.prototype, 'play'), unlock = t.mock.method(client, 'unlockAudio');
    const input = t.mock.method(client, 'setInputDevice'), retry = t.mock.method(client, 'retryMicrophone');
    const before = structuredClone(client.me); await refresh(element); draft(element, 'private-output-a');
    const beforeText = text(element); press(view(element).apply); force(element); assert.equal(media.sinks.length, 1);
    media.sinks[0]!.resolve(); await settle(); await settle(); assert.equal(text(element), beforeText, 'completion adds no actual-device or audible-success claim');
    assert.equal(element['unlock'].hidden, false); assert.equal(play.mock.callCount(), 0); assert.equal(unlock.mock.callCount(), 0);
    assert.equal(input.mock.callCount(), 0); assert.equal(retry.mock.callCount(), 0); assert.equal(media.captures(), 0);
    assert.equal(client.playbackVolume, .37); assert.equal(client.playbackMuted, true); assert.deepEqual(client.me, before); assert.deepEqual(socket.sent, frames);
    draft(element, ''); assert.equal(media.actual(client), 'private-output-a'); press(view(element).apply); assert.equal(media.sinks[1]!.id, '');
    media.sinks[1]!.resolve(); await settle(); await settle(); assert.equal(media.actual(client), ''); assertPicker(element);
  });

  for (const operation of ['refresh', 'apply'] as const) for (const event of ['state', 'status', 'micready'] as const) {
    it(`reserves ${operation} before synchronous SDK ${event} reentry and shares one lock across both controls`, async t => {
      const media = fakeOutput(t), { element, client, socket } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a');
      const gate = pending<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>(), seen: ReturnType<typeof observation>[] = [];
      const emit = () => {
        if (event === 'state') socket.deliver({ type: 'room:state', ...roomState() });
        else client.dispatchEvent(new CustomEvent(event, { detail: event === 'status' ? 'live' : undefined }));
      };
      const list = t.mock.method(client, 'listAudioDevices', () => { emit(); return gate.promise; });
      const sink = t.mock.method(client, 'setOutputDevice', () => { emit(); return gate.promise.then(() => {}); });
      element.addEventListener(`stage-${event}`, () => { seen.push(observation(element)); force(element); });
      press(button(element, operation)); const retained = attempt(element); assert.ok(retained);
      assert.equal(seen.length, 1); assert.deepEqual(seen[0]!.disabled, [true, true, true]); assert.equal(seen[0]!.attempt, retained);
      assert.equal(seen[0]!.value, 'private-output-a'); assert.equal(seen[0]![operation], 'true');
      force(element); client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); force(element);
      assert.equal(list.mock.callCount(), operation === 'refresh' ? 1 : 0); assert.equal(sink.mock.callCount(), operation === 'apply' ? 1 : 0);
      const select = view(element).select; select.value = ''; select.onchange?.(new Event('change'));
      assert.equal(select.value, 'private-output-a', 'disabled change cannot replace the pending draft');
      gate.resolve({ inputs: [], outputs: [device('private-output-a', 'Updated')] }); await settle(); await settle();
      assertPicker(element, { value: 'private-output-a' }); assert.equal(media.sinks.length, 0);
    });
  }

  for (const operation of ['refresh', 'apply'] as const) for (const failure of ['synchronous SDK throw', 'asynchronous native rejection'] as const) {
    it(`reports ${operation} ${failure}, retains its draft and list, and permits an explicit retry without automatic replay`, async t => {
      const media = fakeOutput(t), { element, client } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a');
      const listed = options(element);
      const mock = failure === 'synchronous SDK throw'
        ? t.mock.method(client, operation === 'refresh' ? 'listAudioDevices' : 'setOutputDevice', () => { throw new Error('Current output failure'); }) : undefined;
      if (operation === 'refresh') media.hold();
      press(button(element, operation));
      if (!mock) {
        if (operation === 'refresh') media.enumerations.at(-1)!.reject(new Error('Current output failure'));
        else media.sinks.at(-1)!.reject(new DOMException('Current output failure', 'NotAllowedError'));
      }
      await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
      assert.equal(element['error'].textContent, 'Current output failure'); assert.equal(element['error'].hidden, false); assert.deepEqual(options(element), listed);
      const counts = [media.enumerations.length, media.sinks.length]; await settle(); assert.deepEqual([media.enumerations.length, media.sinks.length], counts);
      mock?.mock.restore(); press(button(element, operation)); assert.equal(element['error'].hidden, true);
      if (operation === 'refresh') media.enumerations.at(-1)!.resolve([device('private-output-a', 'Retry list')]); else media.sinks.at(-1)!.resolve();
      await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
    });
  }

  for (const operation of ['refresh', 'apply'] as const) {
    it(`preserves a newer unrelated error when pending ${operation} succeeds`, async t => {
      const media = fakeOutput(t), { element } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a'); media.hold();
      press(button(element, operation)); error(element, 'Newer independent error');
      if (operation === 'refresh') media.enumerations.at(-1)!.resolve([device('private-output-a')]); else media.sinks.at(-1)!.resolve();
      await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
      assert.equal(element['error'].textContent, 'Newer independent error'); assert.equal(element['error'].hidden, false);
    });
  }

  it('rechecks capability at callback time and preserves a pending lock if browser support disappears', async t => {
    const media = fakeOutput(t), { element, client } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a');
    media.support(false); force(element); assert.equal(media.sinks.length, 0); assert.equal(media.enumerations.length, 1); assertPicker(element, { disabled: true, value: 'private-output-a' });
    media.support(true); client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); press(view(element).apply);
    const active = attempt(element); media.support(false); client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); force(element);
    assert.equal(attempt(element), active); assert.equal(media.sinks.length, 1); media.sinks[0]!.resolve(); await settle(); await settle();
    assertPicker(element, { disabled: true, value: 'private-output-a' }); media.support(true); element['render'](); assertPicker(element, { value: 'private-output-a' });
  });

  for (const operation of ['refresh', 'apply'] as const) for (const identity of ['room', 'participant'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    it(`retains the same audio owner and pending ${operation} across a ${identity} change until ${outcome}`, async t => {
      const media = fakeOutput(t), { element, client, socket } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a'); media.hold();
      press(button(element, operation)); const original = owner(element), active = attempt(element), listed = options(element), audio = client['audio'];
      const seen: ReturnType<typeof observation>[] = [];
      element.addEventListener('stage-state', () => { seen.push(observation(element)); force(element); }, { once: true });
      const state = roomState(false, identity === 'room' ? 'two' : 'one'); if (identity === 'participant') state.me.participantId = 'new-seat';
      socket.deliver({ type: 'room:state', ...state });
      assert.equal(seen.length, 1); assert.equal(seen[0]!.owner, original); assert.equal(seen[0]!.attempt, active); assert.deepEqual(seen[0]!.disabled, [true, true, true]);
      assert.equal(client['audio'], audio); assert.deepEqual(options(element), listed); force(element);
      assert.equal(media.sinks.length, operation === 'apply' ? 1 : 0); assert.equal(media.enumerations.length, operation === 'refresh' ? 2 : 1);
      const request = operation === 'refresh' ? media.enumerations.at(-1)! : media.sinks.at(-1)!;
      if (outcome === 'reject') request.reject(new Error('Retained owner failure'));
      else if (operation === 'refresh') media.enumerations.at(-1)!.resolve([device('private-output-a', 'Retained result')]); else media.sinks.at(-1)!.resolve();
      await settle(); await settle(); assertPicker(element, { value: 'private-output-a' }); assert.equal(owner(element), original);
      assert.equal(element['error'].hidden, outcome === 'resolve'); if (outcome === 'reject') assert.equal(element['error'].textContent, 'Retained owner failure');
    });
  }

  for (const operation of ['refresh', 'apply'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    it(`retains ${operation} through automatic reconnect and handles its ${outcome} only once after resume`, async t => {
      const media = fakeOutput(t), { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a'); media.hold();
      press(button(element, operation)); const original = owner(element), active = attempt(element), listed = options(element), seen: ReturnType<typeof observation>[] = [];
      element.addEventListener('stage-status', () => { seen.push(observation(element)); force(element); }, { once: true });
      socket.close(); await settle(); assert.equal(client.status, 'reconnecting');
      assert.equal(seen.length, 1); assert.equal(seen[0]!.hidden, false); assert.deepEqual(seen[0]!.disabled, [true, true, true]);
      assertPicker(element, { disabled: true, value: 'private-output-a', busy: operation }); assert.equal(owner(element), original); assert.equal(attempt(element), active); assert.deepEqual(options(element), listed);
      await tick(500); const next = sockets[1]!, join = await hello(next); next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
      force(element); assert.equal(media.sinks.length, operation === 'apply' ? 1 : 0); assert.equal(media.enumerations.length, operation === 'refresh' ? 2 : 1);
      if (outcome === 'reject') (operation === 'refresh' ? media.enumerations.at(-1)! : media.sinks.at(-1)!).reject(new Error('Resumed operation failure'));
      else if (operation === 'refresh') media.enumerations.at(-1)!.resolve([device('private-output-a')]); else media.sinks.at(-1)!.resolve();
      await settle(); await settle(); assertPicker(element, { value: 'private-output-a' }); assert.equal(owner(element), original);
      assert.equal(element['error'].hidden, outcome === 'resolve'); if (outcome === 'reject') assert.equal(element['error'].textContent, 'Resumed operation failure');
    });
  }

  for (const transition of ['direct disconnect', 'ordinary close', 'kick', 'shutdown'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    it(`keeps the actual native sink call pending through ${transition} and same-client new-room/pid rejoin until ${outcome}, then admits a next choice and default`, async t => {
      const media = fakeOutput(t), fixture = await socketJoinedWidget(t), { element, client, socket } = fixture;
      await refresh(element); draft(element, 'private-output-a'); press(view(element).apply);
      const original = owner(element), active = attempt(element), audio = client['audio'], listed = options(element), seen: ReturnType<typeof observation>[] = [];
      const event = transition === 'direct disconnect' ? 'status' : terminalCases.find(item => item.title === transition)!.event;
      element.addEventListener(`stage-${event}`, () => { seen.push(observation(element)); force(element); }, { once: true });
      if (transition === 'direct disconnect') await client.disconnect(); else socket.deliver(terminalCases.find(item => item.title === transition)!.message);
      await settle(); assert.equal(seen.length, 1); assert.equal(seen[0]!.hidden, true); assert.deepEqual(seen[0]!.disabled, [true, true, true]);
      assertPicker(element, { hidden: true, value: 'private-output-a', busy: 'apply' }); assert.equal(owner(element), original); assert.equal(attempt(element), active); assert.deepEqual(options(element), listed);
      const state = roomState(false, 'two'); state.me.participantId = 'new-audio-seat'; await rejoin(fixture, state);
      assert.equal(element.client, client); assert.equal(client['audio'], audio); assert.equal(owner(element), original); assert.equal(attempt(element), active);
      assertPicker(element, { disabled: true, value: 'private-output-a', busy: 'apply' }); force(element); assert.equal(media.sinks.length, 1);
      if (outcome === 'resolve') media.sinks[0]!.resolve(); else media.sinks[0]!.reject(new DOMException('Old native operation failed', 'NotAllowedError'));
      await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
      assert.equal(media.actual(client), outcome === 'resolve' ? 'private-output-a' : '', 'disconnect does not cancel the same audio element native call');
      if (outcome === 'reject') assert.equal(element['error'].textContent, 'Old native operation failed');
      draft(element, 'private-output-b'); press(view(element).apply); assert.equal(media.sinks.length, 2); assert.equal(media.sinks[1]!.audio, audio); assert.equal(media.sinks[1]!.id, 'private-output-b');
      media.sinks[1]!.resolve(); await settle(); await settle(); assert.equal(media.actual(client), 'private-output-b');
      draft(element, ''); press(view(element).apply); assert.equal(media.sinks[2]!.id, ''); media.sinks[2]!.resolve(); await settle(); await settle(); assert.equal(media.actual(client), ''); assertPicker(element);
    });
  }

  for (const operation of ['refresh', 'apply'] as const) for (const transition of ['disconnected', 'terminal', 'snapshot cleared'] as const) {
    it(`suppresses ${operation} rejection while ${transition} without losing the same-client draft or inventing a retry`, async t => {
      const media = fakeOutput(t), fixture = await socketJoinedWidget(t), { element, client, socket } = fixture;
      await refresh(element); draft(element, 'private-output-a'); media.hold(); press(button(element, operation)); const original = owner(element);
      if (transition === 'disconnected') await client.disconnect(); else if (transition === 'terminal') socket.deliver(terminalCases[0]!.message);
      else { client['snapshot'] = null; client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); }
      error(element, 'Keep inactive error'); (operation === 'refresh' ? media.enumerations.at(-1)! : media.sinks.at(-1)!).reject(new Error('Inactive native failure'));
      await settle(); await settle(); assertPicker(element, { hidden: true, value: 'private-output-a' }); assert.equal(owner(element), original);
      assert.equal(element['error'].textContent, 'Keep inactive error'); force(element); assert.equal(media.sinks.length, operation === 'apply' ? 1 : 0);
      if (transition === 'snapshot cleared') socket.deliver({ type: 'room:state', ...roomState() }); else await rejoin(fixture);
      assertPicker(element, { value: 'private-output-a' }); assert.equal(owner(element), original); assert.equal(media.enumerations.length, operation === 'refresh' ? 2 : 1);
    });
  }

  for (const operation of ['refresh', 'apply'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    it(`isolates old-client ${operation} ${outcome} from replacement pending state, errors, list and event callbacks`, async t => {
      const media = fakeOutput(t), { element, client, socket, sockets, hello } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a'); media.hold();
      press(button(element, operation)); const oldOwner = owner(element), oldMessage = socket.onmessage, oldClose = socket.onclose;
      const oldEnumeration = media.enumerations.at(-1)!, oldSink = media.sinks.at(-1);
      element.setAttribute('room', 'two'); await settle(); await settle(); assertRetired(element);
      const current = element.client!, next = sockets[1]!, request = await hello(next); assert.notEqual(current, client);
      next.deliver({ type: 'room:state', ...roomState(false, 'two') }); next.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      assertPicker(element); assert.notEqual(owner(element), oldOwner); press(button(element, operation)); const active = attempt(element), currentOwner = owner(element);
      error(element, 'Replacement client error');
      if (outcome === 'reject') (operation === 'refresh' ? oldEnumeration : oldSink!).reject(new Error('Retired native failure'));
      else if (operation === 'refresh') oldEnumeration.resolve([device('retired-output', 'Retired private output')]); else oldSink!.resolve();
      oldMessage?.({ data: JSON.stringify({ type: 'room:state', ...roomState() }) }); oldClose?.(); client.dispatchEvent(new CustomEvent('micready', { detail: undefined }));
      client.dispatchEvent(new CustomEvent('error', { detail: new Error('Retired event failure') })); await settle(); await settle();
      assert.equal(attempt(element), active); assert.equal(owner(element), currentOwner); assertPicker(element, { disabled: true, busy: operation });
      assert.equal(element['error'].textContent, 'Replacement client error'); assert.doesNotMatch(text(element), /Retired private output|retired-output/);
      if (operation === 'refresh') media.enumerations.at(-1)!.resolve([device('fresh-output', 'Fresh output')]); else media.sinks.at(-1)!.resolve();
      await settle(); await settle(); assertPicker(element); assert.equal(element['error'].textContent, 'Replacement client error');
      if (operation === 'apply') assert.notEqual(oldSink!.audio, media.sinks.at(-1)!.audio);
    });
  }

  for (const operation of ['refresh', 'apply'] as const) for (const transition of ['leave', 'detach', 'generation'] as const) {
    it(`clears ${operation} ownership and device privacy state on widget ${transition}, ignoring late rejection and forced callbacks`, async t => {
      const media = fakeOutput(t), { element, client } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a'); media.hold();
      press(button(element, operation));
      if (transition === 'leave') click(element['roomAction']);
      else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else { ++element['generation']; element['current'] = null; element['render'](); }
      await settle(); assertRetired(element); error(element, 'Current teardown error'); force(element);
      (operation === 'refresh' ? media.enumerations.at(-1)! : media.sinks.at(-1)!).reject(new Error('Late teardown failure'));
      await settle(); await settle(); assertRetired(element); assert.equal(element['error'].textContent, 'Current teardown error');
      assert.equal(media.sinks.length, operation === 'apply' ? 1 : 0); assert.equal(media.enumerations.length, operation === 'refresh' ? 2 : 1);
      await client.disconnect();
    });
  }

  it('retains a pre-ACK sink operation through socket loss, silent disconnect and public rejoin of the same audio element', async t => {
    const media = fakeOutput(t), fixture = socketJoiningWidget(t); await settle();
    const { element, sockets, hello, tick, joinRequest } = fixture, socket = sockets[0]!, join = await hello(socket), client = element.client!;
    socket.deliver({ type: 'room:state', ...roomState() }); assert.equal(client['session'], null); assert.equal(client['pending'].has(join.requestId), true);
    await refresh(element); draft(element, 'private-output-a'); press(view(element).apply); const original = owner(element), active = attempt(element);
    socket.close(); await settle(); assert.equal(client.status, 'disconnected'); assertPicker(element, { hidden: true, value: 'private-output-a', busy: 'apply' });
    let statuses = 0; element.addEventListener('stage-status', () => { statuses++; }); await client.disconnect(); assert.equal(statuses, 0);
    const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
    const joining = client.join({ roomId: 'two', name: 'Fresh seat' }); await settle(); await tick(100); const request = joinRequest(next);
    const state = roomState(false, 'two'); state.me.participantId = 'different-seat'; next.deliver({ type: 'room:state', ...state }); next.deliver({ type: 'ok', requestId: request.requestId }); await joining;
    assert.equal(owner(element), original); assert.equal(attempt(element), active); force(element); assert.equal(media.sinks.length, 1);
    media.sinks[0]!.resolve(); await settle(); await settle(); assertPicker(element, { value: 'private-output-a' }); assert.equal(media.actual(client), 'private-output-a');
  });

  it('rechecks after a forwarded micready callback silently removes the snapshot, and never admits another call before restoration', async t => {
    const media = fakeOutput(t), { element, client, socket } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a'); press(view(element).apply);
    const original = owner(element), active = attempt(element); let calls = 0;
    element.addEventListener('stage-micready', () => { calls++; client['snapshot'] = null; }, { once: true });
    client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); assert.equal(calls, 1);
    assertPicker(element, { hidden: true, value: 'private-output-a', busy: 'apply' }); force(element); assert.equal(media.sinks.length, 1);
    socket.deliver({ type: 'room:state', ...roomState(false, 'two') }); assert.equal(owner(element), original); assert.equal(attempt(element), active);
    force(element); assert.equal(media.sinks.length, 1); media.sinks[0]!.resolve(); await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
  });

  for (const transition of ['direct disconnect', 'ordinary close', 'kick', 'shutdown'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    it(`retains enumeration ownership through ${transition} and same-client rejoin until ${outcome}`, async t => {
      const media = fakeOutput(t), fixture = await socketJoinedWidget(t), { element, client, socket } = fixture;
      await refresh(element); draft(element, 'private-output-a'); media.hold(); press(view(element).refresh);
      const original = owner(element), active = attempt(element), listed = options(element);
      if (transition === 'direct disconnect') await client.disconnect(); else socket.deliver(terminalCases.find(item => item.title === transition)!.message);
      await settle(); assertPicker(element, { hidden: true, value: 'private-output-a', busy: 'refresh' });
      assert.equal(owner(element), original); assert.equal(attempt(element), active); assert.deepEqual(options(element), listed);
      await rejoin(fixture); force(element); assert.equal(media.enumerations.length, 2); assert.equal(media.sinks.length, 0);
      if (outcome === 'resolve') media.enumerations[1]!.resolve([device('private-output-a', 'Same audio refreshed list')]);
      else media.enumerations[1]!.reject(new Error('Current same-audio enumeration failure'));
      await settle(); await settle(); assertPicker(element, { value: 'private-output-a' }); assert.equal(owner(element), original);
      if (outcome === 'resolve') assert.match(text(element), /Same audio refreshed list/);
      else assert.equal(element['error'].textContent, 'Current same-audio enumeration failure');
      assert.equal(media.enumerations.length, 2);
    });
  }

  for (const operation of ['refresh', 'apply'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    it(`settles ${operation} ${outcome} during reconnect without enabling controls, reporting inactive errors or replaying on resume`, async t => {
      const media = fakeOutput(t), { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t);
      await refresh(element); draft(element, 'private-output-a'); media.hold(); press(button(element, operation)); const original = owner(element);
      socket.close(); await settle(); error(element, 'Keep reconnect error');
      if (outcome === 'reject') (operation === 'refresh' ? media.enumerations.at(-1)! : media.sinks.at(-1)!).reject(new Error('Silent reconnect failure'));
      else if (operation === 'refresh') media.enumerations.at(-1)!.resolve([device('private-output-a', 'Updated during reconnect')]); else media.sinks.at(-1)!.resolve();
      await settle(); await settle(); assertPicker(element, { disabled: true, value: 'private-output-a' }); force(element);
      assert.equal(element['error'].textContent, 'Keep reconnect error'); assert.equal(owner(element), original);
      assert.equal(media.enumerations.length, operation === 'refresh' ? 2 : 1); assert.equal(media.sinks.length, operation === 'apply' ? 1 : 0);
      await tick(500); const next = sockets[1]!, request = await hello(next); next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: request.requestId }); await settle();
      assert.equal(client.status, 'live'); assertPicker(element, { value: 'private-output-a' }); assert.equal(owner(element), original);
      assert.equal(media.enumerations.length, operation === 'refresh' ? 2 : 1); assert.equal(media.sinks.length, operation === 'apply' ? 1 : 0);
    });
  }

  it('keeps an unresolved native operation reserved beyond control-request deadlines and requires its actual settlement', async t => {
    const media = fakeOutput(t), fixture = await socketJoinedWidget(t), { element, client, tick } = fixture;
    await refresh(element); draft(element, 'private-output-a'); press(view(element).apply); const active = attempt(element);
    await client.disconnect(); await tick(60000); assert.equal(attempt(element), active); assertPicker(element, { hidden: true, value: 'private-output-a', busy: 'apply' });
    await rejoin(fixture); force(element); assert.equal(media.sinks.length, 1); assert.equal(attempt(element), active);
    media.sinks[0]!.resolve(); await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
  });

  it('uses the actual SDK generic fallback for a non-Error native rejection and retries only after a fresh explicit Apply', async t => {
    const media = fakeOutput(t), { element } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a'); press(view(element).apply);
    media.sinks[0]!.reject('private native failure'); await settle(); await settle(); assert.equal(element['error'].textContent, '無法切換揚聲器。');
    assert.doesNotMatch(element['error'].textContent ?? '', /private native/); assertPicker(element, { value: 'private-output-a' }); assert.equal(media.sinks.length, 1);
    press(view(element).apply); assert.equal(media.sinks.length, 2); media.sinks[1]!.resolve(); await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
  });

  it('handles actual SDK unsupported rejection after admission and waits for restored support before explicit retry', async t => {
    const media = fakeOutput(t), { element, client } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a');
    const original = client.setOutputDevice;
    const wrapper = t.mock.method(client, 'setOutputDevice', function (this: StageClient, id: string) { media.support(false); return original.call(this, id); });
    press(view(element).apply); await settle(); await settle(); assertPicker(element, { disabled: true, value: 'private-output-a' });
    assert.equal(element['error'].textContent, '此瀏覽器不支援選擇揚聲器。'); force(element); assert.equal(wrapper.mock.callCount(), 1); assert.equal(media.sinks.length, 0);
    wrapper.mock.restore(); media.support(true); element['render'](); press(view(element).apply); assert.equal(media.sinks.length, 1);
    media.sinks[0]!.resolve(); await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
  });

  for (const policy of ['audience', 'unmuted', 'self-muted', 'force-muted'] as const) {
    it(`preserves the real SDK ${policy} capture/peer resources and negotiation count during output refresh, apply and default`, async t => {
      const media = fakeOutput(t), descriptors = new Map(['RTCPeerConnection', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
      const tracks: (EventTarget & { enabled: boolean; readyState: string; stops: number; stop(): void })[] = [];
      const capture = t.mock.method(media.devices, 'getUserMedia', async () => {
        const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
          stop() { this.stops++; this.readyState = 'ended'; } }); tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
      });
      class Peer {
        static instances: Peer[] = [];
        connectionState = 'connected'; signalingState = 'stable'; localDescription = { type: 'offer', sdp: 'installed' }; closed = false;
        readonly replacements: unknown[] = [];
        readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown,
          replaceTrack: async (track: unknown) => { this.replacements.push(track); this.transceiver.sender.track = track; } } };
        constructor() { Peer.instances.push(this); }
        addTransceiver() { return this.transceiver; }
        close(): void { this.closed = true; }
      }
      class Context {
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
        async resume() {} async close() {}
      }
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
      t.after(() => { for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
      const negotiate = t.mock.method(StageClient.prototype as unknown as { negotiate(): void }, 'negotiate', () => {});
      const state = roomState(policy !== 'audience'); state.me.muted = policy === 'self-muted' || policy === 'force-muted'; state.me.forceMuted = policy === 'force-muted';
      const { element, client, socket } = await socketJoinedWidget(t, state, true); await client['mediaTask'];
      const peer = Peer.instances[0]!; assert.ok(peer); assert.equal(capture.mock.callCount(), policy === 'audience' ? 0 : 1);
      const before = { captures: capture.mock.callCount(), tracks: [...tracks], replacements: [...peer.replacements], direction: peer.transceiver.direction,
        track: peer.transceiver.sender.track, offers: negotiate.mock.callCount(), mic: client['mic'], input: client['inputDeviceId'], flags: structuredClone(client.me), frames: [...socket.sent] };
      element.playbackVolume = .43; element.playbackMuted = true; await refresh(element); draft(element, 'private-output-a'); press(view(element).apply);
      media.sinks[0]!.resolve(); await settle(); await settle(); draft(element, ''); press(view(element).apply); media.sinks[1]!.resolve(); await settle(); await settle();
      assert.equal(capture.mock.callCount(), before.captures); assert.deepEqual(tracks, before.tracks); assert.deepEqual(peer.replacements, before.replacements);
      assert.equal(peer.transceiver.sender.track, before.track); assert.equal(peer.transceiver.direction, before.direction); assert.equal(peer.closed, false); assert.equal(Peer.instances.length, 1);
      assert.equal(negotiate.mock.callCount(), before.offers); assert.equal(client['mic'], before.mic); assert.equal(client['inputDeviceId'], before.input); assert.deepEqual(client.me, before.flags);
      assert.ok(tracks.every(track => track.stops === 0)); if (tracks[0]) assert.equal(tracks[0].enabled, !state.me.muted);
      assert.equal(client.playbackVolume, .43); assert.equal(client.playbackMuted, true); assert.deepEqual(socket.sent, before.frames); assertPicker(element);
    });
  }

  for (const operation of ['refresh', 'apply'] as const) for (const first of ['output', 'microphone'] as const) {
    it(`keeps input and output ${operation} lanes independent when ${first} starts first, including shared micready`, async t => {
      const media = fakeOutput(t), { element, client } = await socketJoinedWidget(t);
      media.list([device('private-output-a', 'Speaker'), device('private-input-a', 'Microphone', 'audioinput')]);
      await refresh(element); click(element['microphoneRefresh']); await settle(); await settle();
      draft(element, 'private-output-a'); element['microphoneSelect'].value = 'private-input-a';
      const input = deferred(), setter = t.mock.method(client, 'setInputDevice', () => input.promise); media.hold();
      const inputButton = operation === 'refresh' ? element['microphoneRefresh'] : element['microphoneApply'];
      if (first === 'output') {
        press(button(element, operation));
        assert.equal(element['microphoneSelect'].disabled, false); assert.equal(element['microphoneRefresh'].disabled, false); assert.equal(element['microphoneApply'].disabled, false);
        click(inputButton);
      } else {
        click(inputButton); assertPicker(element, { value: 'private-output-a' }); press(button(element, operation));
      }
      const outputAttempt = attempt(element), inputAttempt = operation === 'refresh' ? element['refreshAttempt'] : element['inputDeviceAttempt'];
      assert.ok(outputAttempt && inputAttempt); assert.notEqual(outputAttempt, inputAttempt);
      assertPicker(element, { disabled: true, value: 'private-output-a', busy: operation });
      assert.equal(element['microphoneSelect'].disabled, true); assert.equal(inputButton.getAttribute('aria-busy'), 'true');
      client.dispatchEvent(new CustomEvent('micready', { detail: undefined })); force(element); click(inputButton);
      assert.equal(attempt(element), outputAttempt); assert.equal(operation === 'refresh' ? element['refreshAttempt'] : element['inputDeviceAttempt'], inputAttempt);
      assert.equal(media.enumerations.length, operation === 'refresh' ? 4 : 2); assert.equal(media.sinks.length, operation === 'apply' ? 1 : 0); assert.equal(setter.mock.callCount(), operation === 'apply' ? 1 : 0);
      const finishOutput = () => {
        if (operation === 'apply') media.sinks[0]!.resolve();
        else media.enumerations[first === 'output' ? 2 : 3]!.resolve([device('private-output-a', 'Refreshed speaker')]);
      };
      const finishInput = () => {
        if (operation === 'apply') input.resolve();
        else media.enumerations[first === 'microphone' ? 2 : 3]!.resolve([device('private-input-a', 'Refreshed microphone', 'audioinput')]);
      };
      if (first === 'output') {
        finishOutput(); await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
        assert.equal(operation === 'refresh' ? element['refreshAttempt'] : element['inputDeviceAttempt'], inputAttempt); assert.equal(inputButton.disabled, true);
        finishInput();
      } else {
        finishInput(); await settle(); await settle(); assert.equal(element['microphoneSelect'].disabled, false);
        assert.equal(attempt(element), outputAttempt); assertPicker(element, { disabled: true, value: 'private-output-a', busy: operation }); finishOutput();
      }
      await settle(); await settle(); assertPicker(element, { value: 'private-output-a' });
      assert.equal(element['microphoneSelect'].disabled, false); assert.equal(element['microphoneSelect'].value, 'private-input-a');
    });
  }

  it('does not claim to serialize direct host SDK calls or present its draft as the actual sink', async t => {
    const media = fakeOutput(t), { element, client } = await socketJoinedWidget(t); await refresh(element); draft(element, 'private-output-a'); press(view(element).apply);
    const active = attempt(element), host = client.setOutputDevice('private-output-b'); assert.equal(media.sinks.length, 2);
    media.sinks[1]!.resolve(); await host; assert.equal(media.actual(client), 'private-output-b'); assert.equal(attempt(element), active);
    assertPicker(element, { disabled: true, value: 'private-output-a', busy: 'apply' });
    media.sinks[0]!.resolve(); await settle(); await settle(); assert.equal(media.actual(client), 'private-output-a'); assertPicker(element, { value: 'private-output-a' });
    const hostDefault = client.setOutputDevice(''); media.sinks[2]!.resolve(); await hostDefault;
    assert.equal(media.actual(client), ''); assertPicker(element, { value: 'private-output-a' });
  });
});

/** Fake DOM and controlled native promises verify handler/SDK ordering, never audible recovery or real hardware. */
describe('widget manual audio negotiation recovery', () => {
  type Widget = InstanceType<typeof StageElement>;
  const drain = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
  const press = (element: Widget) => click(element['audioRetry']);
  const force = (element: Widget) => {
    element['audioRetry'].disabled = false; element['audioRetry'].hidden = false; press(element);
  };
  const error = (element: Widget, message = 'Keep newer error') => element['show'](new Error(message));
  function view(element: Widget, { hidden = false, busy = false, disabled = hidden || busy, text = busy ? '正在重新協商音訊連線…' : '' }:
    { hidden?: boolean; busy?: boolean; disabled?: boolean; text?: string } = {}): void {
    assert.equal(element['audioRetry'].hidden, hidden, 'retry visibility');
    assert.equal(element['audioRetry'].disabled, disabled, 'retry admission');
    assert.equal(element['audioRetry'].getAttribute('aria-busy'), String(busy));
    assert.equal(element['audioRecovery'].textContent, text);
    assert.equal(element['audioRecovery'].hidden, !text);
  }
  async function rejoin(fixture: Awaited<ReturnType<typeof socketJoinedWidget>>, state = roomState()) {
    const { client, sockets, tick, joinRequest } = fixture;
    const connected = client.connect(), socket = sockets.at(-1)!; socket.hello(); await connected;
    const joined = client.join({ roomId: state.roomId, name: 'Listener' }); await drain(); await tick(100);
    const request = joinRequest(socket); socket.deliver({ type: 'room:state', ...state });
    socket.deliver({ type: 'ok', requestId: request.requestId }); await joined; await drain();
    return socket;
  }

  for (const status of ['waiting', 'live'] as const) for (const policy of ['audience', 'speaker', 'controller'] as const) {
    it(`offers a native, separate polite recovery action for a joined ${status} ${policy}`, async t => {
      const state = roomState(policy !== 'audience'); state.status = status; state.me.role = policy;
      const { element, client } = await socketJoinedWidget(t, state);
      const pending = deferred(), retry = t.mock.method(client, 'retryAudioConnection', () => pending.promise);
      assert.equal(element['audioRetry'].type, 'button'); assert.equal(element['audioRetry'].textContent, '重試音訊連線');
      assert.equal(element['audioRecovery'].getAttribute('role'), 'status');
      assert.equal(element['audioRecovery'].getAttribute('aria-live'), 'polite');
      assert.equal(element['audioRetry'].getAttribute('aria-describedby'), element['audioRecovery'].id);
      assert.notEqual(element['audioRecovery'], element['status']); assert.notEqual(element['audioRetry'], element['micRetry']);
      view(element); error(element); press(element); view(element, { busy: true }); assert.equal(element['error'].hidden, true);
      press(element); force(element); assert.equal(retry.mock.callCount(), 1); view(element, { busy: true });
      error(element); pending.resolve(); await drain(); view(element, { text: '音訊連線協商已完成。' });
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Keep newer error');
    });
  }

  it('keeps no-room, joining and failed-entry controls hidden and protects existing errors from forced handlers', async t => {
    const { element, connections } = deferredJoiningWidget(t); await drain();
    const client = element.client!, retry = t.mock.method(client, 'retryAudioConnection', async () => {});
    error(element); force(element); view(element, { hidden: true }); assert.equal(retry.mock.callCount(), 0);
    connections[0]!.pending.reject(new Error('Initial connection failure')); await drain();
    error(element); force(element); view(element, { hidden: true }); assert.equal(retry.mock.callCount(), 0);
    assert.equal(element['error'].textContent, 'Keep newer error'); assert.equal(element['error'].hidden, false);
  });

  it('reserves synchronously across forwarded state reentry and preserves the same seat through role and name changes', async t => {
    const { element, client, socket } = await socketJoinedWidget(t);
    const pending = deferred(); let observations = 0;
    element.addEventListener('stage-state', () => { observations++; force(element); });
    const retry = t.mock.method(client, 'retryAudioConnection', () => {
      const state = roomState(true); state.me.role = 'controller'; state.me.name = 'Updated';
      socket.deliver({ type: 'room:state', ...state }); return pending.promise;
    });
    const owner = element['audioRecoveryOwner']; press(element); const attempt = element['audioRecoveryAttempt'];
    assert.equal(retry.mock.callCount(), 1); assert.equal(observations, 1); assert.equal(element['audioRecoveryOwner'], owner);
    socket.deliver({ type: 'room:state', ...roomState() });
    assert.equal(element['audioRecoveryAttempt'], attempt); view(element, { busy: true });
    pending.resolve(); await drain(); view(element, { text: '音訊連線協商已完成。' });
  });

  for (const synchronous of [true, false]) {
    it(`shows a current ${synchronous ? 'synchronous' : 'asynchronous'} failure and allows a later manual attempt`, async t => {
      const { element, client } = await socketJoinedWidget(t); const pending = deferred(); let calls = 0;
      t.mock.method(client, 'retryAudioConnection', () => {
        if (++calls === 1) { if (synchronous) throw new Error('Controlled retry failure'); return Promise.reject(new Error('Controlled retry failure')); }
        return pending.promise;
      });
      press(element); await drain(); view(element); assert.equal(element['error'].textContent, 'Controlled retry failure');
      press(element); view(element, { busy: true }); assert.equal(calls, 2); pending.resolve(); await drain(); view(element, { text: '音訊連線協商已完成。' });
    });
  }

  for (const outcome of ['resolve', 'reject'] as const) for (const transition of ['room', 'participant', 'generation', 'client'] as const) {
    it(`isolates a retired ${transition} owner's ${outcome} from a fresh pending attempt and error`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t);
      const old = deferred(), fresh = deferred(); let calls = 0;
      t.mock.method(client, 'retryAudioConnection', () => (++calls === 1 ? old : fresh).promise);
      press(element); const owner = element['audioRecoveryOwner'];
      if (transition === 'client') {
        const replacement = new StageClient({ url: 'ws://localhost/ws' });
        replacement['snapshot'] = roomState(); replacement['currentStatus'] = 'live';
        t.mock.method(replacement, 'retryAudioConnection', () => { calls++; return fresh.promise; });
        element['current'] = replacement; element['render']();
        t.after(() => client.disconnect());
      } else if (transition === 'generation') { ++element['generation']; element['render'](); }
      else { const state = roomState(false, transition === 'room' ? 'two' : 'one'); if (transition === 'participant') state.me.participantId = 'new-seat'; socket.deliver({ type: 'room:state', ...state }); }
      assert.notEqual(element['audioRecoveryOwner'], owner); view(element); press(element);
      const attempt = element['audioRecoveryAttempt']; error(element);
      if (outcome === 'resolve') old.resolve(); else old.reject(new Error('Retired failure'));
      await drain(); assert.equal(element['audioRecoveryAttempt'], attempt); view(element, { busy: true });
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Keep newer error');
      force(element); assert.equal(calls, 2); fresh.resolve(); await drain(); view(element, { text: '音訊連線協商已完成。' });
    });
  }

  for (const transition of ['leave', 'detach', 'disconnect', 'ordinary close', 'kick', 'shutdown'] as const) {
    it(`retires on ${transition} before forced callback admission and ignores stale rejection`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t); const pending = deferred();
      const retry = t.mock.method(client, 'retryAudioConnection', () => pending.promise); press(element);
      let observed: boolean | undefined;
      const event = transition === 'disconnect' ? 'stage-status' : `stage-${terminalCases.find(item => item.title === transition)?.event ?? 'status'}`;
      element.addEventListener(event, () => { observed = element['audioRecoveryOwner'] === undefined; error(element); force(element); }, { once: true });
      if (transition === 'leave') click(element['roomAction']);
      else if (transition === 'detach') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else if (transition === 'disconnect') await client.disconnect();
      else socket.deliver(terminalCases.find(item => item.title === transition)!.message);
      await drain(); view(element, { hidden: true });
      if (transition !== 'leave' && transition !== 'detach') assert.equal(observed, true);
      error(element); force(element); pending.reject(new Error('Obsolete teardown failure')); await drain();
      view(element, { hidden: true }); assert.equal(retry.mock.callCount(), 1); assert.equal(element['error'].textContent, 'Keep newer error');
    });
  }

  for (const terminal of terminalCases) {
    it(`allows a later authoritative same-client same-ID state after ${terminal.title}, without reviving the old operation`, async t => {
      const fixture = await socketJoinedWidget(t), { element, client, socket } = fixture;
      const old = deferred(), fresh = deferred(); let calls = 0;
      t.mock.method(client, 'retryAudioConnection', () => (++calls === 1 ? old : fresh).promise);
      press(element); const original = element['audioRecoveryOwner']; socket.deliver(terminal.message); await drain(); view(element, { hidden: true });
      await rejoin(fixture); assert.notEqual(element['audioRecoveryOwner'], original); view(element); press(element);
      error(element); old.reject(new Error('Old terminal failure')); await drain(); view(element, { busy: true });
      assert.equal(element['error'].textContent, 'Keep newer error'); fresh.resolve(); await drain(); view(element, { text: '音訊連線協商已完成。' });
    });
  }

  it('retires a pre-ACK disconnected snapshot and silent public disconnect before same-ID rejoin', async t => {
    const fixture = socketJoiningWidget(t); await drain();
    const { element, sockets, hello } = fixture, socket = sockets[0]!, join = await hello(socket), client = element.client!;
    socket.deliver({ type: 'room:state', ...roomState() }); assert.equal(client['session'], null); assert.ok(client['pending'].has(join.requestId));
    const old = deferred(), fresh = deferred(); let calls = 0;
    t.mock.method(client, 'retryAudioConnection', () => (++calls === 1 ? old : fresh).promise);
    press(element); const owner = element['audioRecoveryOwner']; socket.close(); await drain();
    assert.equal(client.status, 'disconnected'); assert.ok(client.state); view(element, { hidden: true });
    error(element); force(element); assert.equal(calls, 1); assert.equal(element['error'].textContent, 'Keep newer error');
    let statuses = 0; element.addEventListener('stage-status', () => { statuses++; }); await client.disconnect(); assert.equal(statuses, 0);
    await rejoin({ ...fixture, client, socket }); assert.notEqual(element['audioRecoveryOwner'], owner); press(element);
    error(element); old.resolve(); await drain(); view(element, { busy: true }); assert.equal(element['error'].textContent, 'Keep newer error');
    fresh.resolve(); await drain(); view(element, { text: '音訊連線協商已完成。' });
  });

  it('keeps pending ownership through reconnect, clears feedback, blocks admission and never replays the action', async t => {
    const { element, client, socket, sockets, hello, tick } = await socketJoinedWidget(t);
    const pending = deferred(), retry = t.mock.method(client, 'retryAudioConnection', () => pending.promise);
    press(element); const owner = element['audioRecoveryOwner'], attempt = element['audioRecoveryAttempt'];
    error(element); let blocked = false;
    element.addEventListener('stage-status', () => { force(element); blocked = element['audioRetry'].disabled; }, { once: true });
    socket.close(); await drain(); view(element, { busy: true, text: '' }); assert.equal(blocked, true);
    assert.equal(element['audioRecoveryOwner'], owner); assert.equal(element['audioRecoveryAttempt'], attempt);
    assert.equal(element['error'].hidden, false); assert.equal(retry.mock.callCount(), 1);
    await tick(500); const next = sockets[1]!, join = await hello(next);
    next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: join.requestId }); await drain();
    view(element, { busy: true }); assert.equal(element['audioRecoveryOwner'], owner); assert.equal(retry.mock.callCount(), 1);
    pending.resolve(); await drain(); view(element, { text: '音訊連線協商已完成。' });
    next.close(); await drain(); view(element, { disabled: true }); assert.equal(retry.mock.callCount(), 1);
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`clears pending silently on ${outcome} during reconnect and does not restore completion on resume`, async t => {
      const { element, client, socket, sockets, hello, tick } = await socketJoinedWidget(t);
      const pending = deferred(), retry = t.mock.method(client, 'retryAudioConnection', () => pending.promise);
      press(element); socket.close(); error(element);
      if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('Reconnect failure'));
      await drain(); view(element, { disabled: true }); assert.equal(element['error'].textContent, 'Keep newer error');
      await tick(500); const next = sockets[1]!, join = await hello(next);
      next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: join.requestId }); await drain();
      view(element); assert.equal(retry.mock.callCount(), 1);
    });
  }

  for (const event of ['state', 'status', 'error', 'micready', 'speaking'] as const) {
    it(`rechecks ownership after a forwarded stage-${event} callback silently removes the exposed snapshot`, async t => {
      const { element, client } = await socketJoinedWidget(t); const pending = deferred();
      t.mock.method(client, 'retryAudioConnection', () => pending.promise); press(element);
      element.addEventListener(`stage-${event}`, () => { client['snapshot'] = null; }, { once: true });
      const detail = event === 'state' ? roomState() : event === 'status' ? 'live' : event === 'error' ? new Error('Host error') : event === 'speaking' ? { participantIds: [] } : undefined;
      client.dispatchEvent(new CustomEvent(event, { detail })); view(element, { hidden: true });
      error(element); pending.reject(new Error('Retired silent mutation')); await drain(); assert.equal(element['error'].textContent, 'Keep newer error');
    });
  }

  it('preserves the SDK global error forwarding contract after a local retry has retired', async t => {
    const { element, client, socket } = await socketJoinedWidget(t); const pending = deferred();
    t.mock.method(client, 'retryAudioConnection', () => pending.promise); press(element);
    const state = roomState(); state.me.participantId = 'replacement'; socket.deliver({ type: 'room:state', ...state });
    error(element); pending.reject(new Error('Retired local failure')); await drain(); assert.equal(element['error'].textContent, 'Keep newer error');
    let seen = 0; element.addEventListener('stage-error', () => { seen++; });
    socket.deliver({ type: 'error', code: 'internal', message: 'Global wire error still visible' });
    assert.equal(seen, 1); assert.equal(element['error'].textContent, 'Global wire error still visible');
  });

  async function mediaFixture(t: TestContext, state = roomState()) {
    let captures = 0, plays = 0;
    const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stops: 0,
      stop() { this.stops++; this.readyState = 'ended'; } });
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    class Peer {
      static instances: Peer[] = [];
      connectionState = 'new'; signalingState = 'stable';
      localDescription: RTCSessionDescriptionInit | null = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      readonly operations: { name: string; resolve(): void; reject(error: unknown): void }[] = [];
      readonly calls: string[] = [];
      readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
      readonly replacements: unknown[] = [];
      readonly failures = new Map<string, Error>();
      readonly transceiver = { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
        replaceTrack: async (value: MediaStreamTrack | null) => { this.replacements.push(value); this.transceiver.sender.track = value; } } };
      constructor() { Peer.instances.push(this); }
      addTransceiver() { return this.transceiver; }
      private enqueue<T>(name: string, apply: () => T): Promise<T> {
        this.calls.push(name); const failure = this.failures.get(name);
        if (failure) { this.failures.delete(name); throw failure; }
        const operation = deferred(); this.operations.push({ name, resolve: operation.resolve, reject: operation.reject });
        return operation.promise.then(apply);
      }
      complete(name: string, error?: unknown): void {
        const operation = this.operations.shift(); assert.ok(operation, `pending ${name}`); assert.equal(operation.name, name);
        if (error !== undefined) operation.reject(error); else operation.resolve();
      }
      createOffer(options?: RTCOfferOptions) { this.offerOptions.push(options); return this.enqueue('createOffer', () => ({ ...(state.me.onStage ? SENDRECV_OFFER : RECVONLY_OFFER) })); }
      setLocalDescription(description: RTCSessionDescriptionInit) { return this.enqueue('setLocalDescription', () => { this.localDescription = description; this.signalingState = 'have-local-offer'; }); }
      setRemoteDescription(description: RTCSessionDescriptionInit) { return this.enqueue('setRemoteDescription', () => { this.remoteDescription = description; this.signalingState = 'stable'; }); }
      addIceCandidate(candidate?: RTCIceCandidateInit) { return this.enqueue(`ice:${candidate?.candidate}`, () => {}); }
      restartIce() { this.calls.push('restartIce'); }
      close() { this.connectionState = this.signalingState = 'closed'; }
    }
    class Context {
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
      async resume() {} async close() {}
    }
    const originals = new Map(['RTCPeerConnection', 'navigator', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const [name, value] of Object.entries({ RTCPeerConnection: Peer, AudioContext: Context,
      navigator: { mediaDevices: { async getUserMedia() { captures++; return stream; } } } })) Object.defineProperty(globalThis, name, { configurable: true, value });
    t.mock.method(Audio.prototype, 'play', async () => { plays++; });
    const f = await socketJoinedWidget(t, state, true); await drain(); const peer = Peer.instances[0]!;
    t.after(async () => {
      await f.client.disconnect();
      for (const item of Peer.instances) for (const operation of item.operations.splice(0)) operation.reject(new Error('Fixture cleanup'));
      await drain();
      for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    });
    const offers = () => f.socket.sent.filter(message => message.type === 'rtc:offer');
    async function sentOffer() {
      peer.complete('createOffer'); await drain(); peer.complete('setLocalDescription'); await drain(); await f.tick(100); await drain();
      const offer = offers().at(-1); assert.ok(offer); return offer;
    }
    const acknowledge = (offer: Extract<ClientMessage, { type: 'rtc:offer' }>) => f.socket.deliver({ type: 'ok', requestId: offer.requestId });
    const answer = () => f.socket.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
    async function failInitial() {
      const offer = await sentOffer(); f.socket.deliver({ type: 'error', requestId: offer.requestId, code: 'internal', message: 'Initial negotiation rejected' });
      await drain(); assert.equal(f.client['negotiating'], false); view(f.element);
    }
    async function finish() { const offer = await sentOffer(); acknowledge(offer); answer(); await drain(); peer.complete('setRemoteDescription'); await drain(); }
    return { ...f, peer, Peer, track, stream, offers, sentOffer, acknowledge, answer, failInitial, finish, counts: () => ({ captures, plays }) };
  }

  for (const status of ['waiting', 'live'] as const) for (const policy of ['audience', 'speaker', 'self-muted', 'force-muted'] as const) {
    it(`repairs a real SDK rejected initial ${status} ${policy} negotiation on the same socket, peer and seat without recapture or playback`, async t => {
      const state = roomState(policy !== 'audience'); state.status = status;
      state.me.muted = policy === 'self-muted' || policy === 'force-muted'; state.me.forceMuted = policy === 'force-muted';
      const f = await mediaFixture(t, state); await f.failInitial();
      const before = { counts: f.counts(), replacements: [...f.peer.replacements], direction: f.peer.transceiver.direction, track: f.peer.transceiver.sender.track, mic: f.client['mic'], flags: structuredClone(f.client.me) };
      f.element.playbackMuted = true; f.element.playbackVolume = .37;
      for (let n = 0; n < 5; n++) await f.tick(100);
      assert.equal(f.offers().length, 1); press(f.element); view(f.element, { busy: true }); force(f.element);
      await f.finish(); view(f.element, { text: '音訊連線協商已完成。' });
      assert.equal(f.client.me!.participantId, 'me'); assert.equal(f.Peer.instances.length, 1); assert.equal(f.sockets.length, 1);
      assert.equal(f.socket.sent.filter(message => message.type === 'join').length, 1); assert.equal(f.offers().length, 2);
      assert.deepEqual(f.counts(), before.counts); assert.deepEqual(f.peer.replacements, before.replacements);
      assert.equal(f.peer.transceiver.direction, before.direction); assert.equal(f.peer.transceiver.sender.track, before.track);
      assert.equal(f.client['mic'], before.mic); assert.deepEqual(f.client.me, before.flags); assert.equal(f.track.stops, 0);
      assert.equal(f.peer.calls.includes('restartIce'), false); assert.deepEqual(f.peer.offerOptions, [undefined, undefined]);
      assert.equal(f.client.playbackMuted, true); assert.equal(f.client.playbackVolume, .37);
      assert.equal(f.peer.connectionState, 'new', 'completed negotiation is not evidence of connected ICE or audible audio');
    });
  }

  for (const order of ['ack-first', 'answer-first'] as const) {
    it(`retains busy feedback through actual ${order} ACK, answer installation, buffered ICE and a dirty second round`, async t => {
      const f = await mediaFixture(t); await f.failInitial(); press(f.element); const offer = await f.sentOffer();
      const owner = f.element['audioRecoveryOwner'], attempt = f.element['audioRecoveryAttempt'];
      f.socket.deliver({ type: 'room:state', ...roomState() }); await drain(); assert.equal(f.client['negotiationDirty'], true);
      assert.equal(f.element['audioRecoveryOwner'], owner); assert.equal(f.element['audioRecoveryAttempt'], attempt);
      for (let n = 1; n <= 2; n++) f.socket.deliver({ type: 'rtc:ice', fromId: 'server', payload: { candidate: String(n), sdpMid: '0', sdpMLineIndex: 0 } });
      if (order === 'ack-first') f.acknowledge(offer);
      f.answer(); await drain(); view(f.element, { busy: true });
      f.peer.complete('setRemoteDescription'); await drain(); view(f.element, { busy: true });
      f.peer.complete('ice:1'); await drain(); view(f.element, { busy: true });
      f.peer.complete('ice:2'); await drain(); view(f.element, { busy: true });
      if (order === 'answer-first') { f.acknowledge(offer); await drain(); }
      assert.deepEqual(f.peer.operations.map(operation => operation.name), ['createOffer']);
      error(f.element); await f.finish(); view(f.element, { text: '音訊連線協商已完成。' });
      assert.equal(f.element['error'].textContent, 'Keep newer error'); assert.equal(f.element['error'].hidden, false); assert.equal(f.offers().length, 3);
    });
  }

  it('exposes the real SDK initial-negotiation conflict without dirtying it, then permits one manual retry', async t => {
    const f = await mediaFixture(t); press(f.element); await drain(); view(f.element);
    assert.match(f.element['error'].textContent ?? '', /音訊協商進行中/); assert.equal(f.client['negotiationDirty'], false);
    assert.deepEqual(f.peer.operations.map(operation => operation.name), ['createOffer']);
    await f.failInitial(); press(f.element); await f.finish(); view(f.element, { text: '音訊連線協商已完成。' });
  });

  for (const failure of ['wire', 'offer', 'answer', 'ice', 'synchronous offer', 'ack timeout', 'answer timeout'] as const) {
    it(`shows real SDK ${failure} failure, settles busy state and never automatically retries`, async t => {
      const f = await mediaFixture(t); await f.failInitial();
      if (failure === 'synchronous offer') f.peer.failures.set('createOffer', new Error('Controlled synchronous offer failure'));
      press(f.element);
      if (failure === 'offer') f.peer.complete('createOffer', new Error('Controlled native offer failure'));
      else if (failure !== 'synchronous offer') {
        const offer = await f.sentOffer();
        if (failure === 'wire') f.socket.deliver({ type: 'error', requestId: offer.requestId, code: 'internal', message: 'Controlled wire failure' });
        else {
          if (failure !== 'ack timeout') f.acknowledge(offer);
          if (failure !== 'answer timeout') {
            if (failure === 'ice') f.socket.deliver({ type: 'rtc:ice', fromId: 'server', payload: { candidate: '1', sdpMid: '0', sdpMLineIndex: 0 } });
            f.answer(); await drain(); f.peer.complete('setRemoteDescription', failure === 'answer' ? new Error('Controlled native answer failure') : undefined);
            await drain(); if (failure === 'ice') f.peer.complete('ice:1', new Error('Controlled native ICE failure'));
          }
          if (failure.endsWith('timeout')) await f.tick(15000);
        }
      }
      await drain(); view(f.element); assert.equal(f.element['error'].hidden, false); assert.equal(f.client['negotiating'], false);
      const count = f.offers().length; await f.tick(100); assert.equal(f.offers().length, count);
      assert.doesNotMatch(f.element['audioRecovery'].textContent ?? '', /完成/);
    });
  }

  it('rejects immediately on actual SDK socket loss while a controlled peer operation retains its lock, then exposes conflict after resume without another offer', async t => {
    const f = await mediaFixture(t); await f.failInitial(); press(f.element); view(f.element, { busy: true });
    const original = f.element['audioRecoveryOwner']; f.socket.close();
    view(f.element, { busy: true, text: '' }); await drain(); view(f.element, { disabled: true });
    assert.equal(f.client['negotiating'], true); assert.equal(f.element['audioRecoveryOwner'], original);
    await f.tick(500); const next = f.sockets[1]!, join = await f.hello(next);
    next.deliver({ type: 'room:state', ...roomState() }); next.deliver({ type: 'ok', requestId: join.requestId }); await drain();
    press(f.element); await drain(); view(f.element); assert.match(f.element['error'].textContent ?? '', /音訊協商進行中/);
    assert.equal(next.sent.filter(message => message.type === 'rtc:offer').length, 0);
    f.peer.complete('createOffer', new Error('Held native operation finally failed')); await drain();
    assert.equal(f.client['negotiating'], false); view(f.element);
  });

  it('does not let a synchronous old-method throw clear a new attempt installed by forwarded disconnect and same-ID state reentry', async t => {
    const { element, client } = await socketJoinedWidget(t), fresh = deferred(); let calls = 0;
    const retired: boolean[] = [];
    element.addEventListener('stage-error', () => {
      void client.disconnect(); retired.push(element['audioRecoveryOwner'] === undefined);
      void client['receive']({ type: 'room:state', ...roomState() }); press(element); error(element, 'Fresh reentrant error');
    }, { once: true });
    t.mock.method(client, 'retryAudioConnection', () => {
      if (++calls === 1) {
        client.dispatchEvent(new CustomEvent('error', { detail: new Error('Old synchronous error') }));
        throw new Error('Retired synchronous throw');
      }
      return fresh.promise;
    });
    press(element); await drain(); assert.deepEqual(retired, [true]); assert.equal(calls, 2);
    view(element, { busy: true }); assert.equal(element['error'].textContent, 'Fresh reentrant error');
    fresh.resolve(); await drain(); view(element, { text: '音訊連線協商已完成。' }); assert.equal(element['error'].textContent, 'Fresh reentrant error');
  });

  for (const invalid of ['snapshot', 'participant', 'room', 'detached', 'current client', 'disconnected', 'unknown status'] as const) {
    it(`guards a silently invalid ${invalid} before changing errors or pending state`, async t => {
      const { element, client } = await socketJoinedWidget(t), retry = t.mock.method(client, 'retryAudioConnection', async () => {});
      if (invalid === 'snapshot') client['snapshot'] = null;
      else if (invalid === 'participant') client.state!.me.participantId = '';
      else if (invalid === 'room') client.state!.roomId = '';
      else if (invalid === 'detached') Object.assign(element, { isConnected: false });
      else if (invalid === 'current client') element['current'] = null;
      else client['currentStatus'] = (invalid === 'unknown status' ? 'unknown' : invalid) as typeof client.status;
      error(element); force(element); view(element, { hidden: true }); assert.equal(retry.mock.callCount(), 0);
      assert.equal(element['error'].hidden, false); assert.equal(element['error'].textContent, 'Keep newer error');
      await client.disconnect();
    });
  }

  for (const invalid of ['missing peer', 'failed peer', 'closed peer', 'closed signaling', 'closed socket'] as const) {
    it(`lets the actual SDK reject ${invalid} with controlled media without capture, play or a new offer`, async t => {
      const f = await mediaFixture(t); await f.failInitial();
      if (invalid === 'missing peer') f.client['pc'] = null;
      else if (invalid === 'closed signaling') f.peer.signalingState = 'closed';
      else if (invalid === 'closed socket') f.socket.readyState = 3;
      else f.peer.connectionState = invalid === 'failed peer' ? 'failed' : 'closed';
      const before = f.counts(); press(f.element); await drain(); view(f.element);
      assert.equal(f.element['error'].hidden, false); assert.equal(f.offers().length, 1); assert.deepEqual(f.counts(), before);
    });
  }

  it('repairs the real hub subscriber after initial transport rejection through the native widget button, without rejoin, capture, play or ICE restart', async t => {
    const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; });
    const h = harness(config), host = await h.create(), rejected = deferred();
    const negotiate = h.transport.negotiate.bind(h.transport);
    let negotiations = 0, captures = 0, plays = 0, serverWork = Promise.resolve();
    h.transport.negotiate = (...args) => ++negotiations === 1 ? rejected.promise.then(() => negotiate(...args)) : negotiate(...args);
    class Socket {
      static OPEN = 1; static instances: Socket[] = [];
      readyState = 1; readonly sent: ClientMessage[] = [];
      readonly id = `widget-recovery-${Socket.instances.length}`;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      readonly session = { id: this.id,
        send: (message: ServerMessage) => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) }); },
        close: () => this.close() };
      constructor() { Socket.instances.push(this); queueMicrotask(() => h.hub.attach(this.session)); }
      send(data: string) { const message = parseClientMessage(data, config.limits); this.sent.push(message); serverWork = serverWork.then(() => h.hub.handle(this.session, message)); }
      close(code?: number) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); serverWork = serverWork.then(() => h.hub.detach(this.session, code === 1000)); }
    }
    class Peer {
      static instances: Peer[] = []; connectionState = 'new'; signalingState = 'stable';
      localDescription: RTCSessionDescriptionInit | null = null; remoteDescription: RTCSessionDescriptionInit | null = null;
      readonly offerOptions: (RTCOfferOptions | undefined)[] = []; restarts = 0;
      readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown, async replaceTrack(track: unknown) { this.track = track; } } };
      constructor() { Peer.instances.push(this); }
      addTransceiver() { return this.transceiver; }
      async createOffer(options?: RTCOfferOptions) { this.offerOptions.push(options); return { ...RECVONLY_OFFER }; }
      async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; this.signalingState = 'have-local-offer'; }
      async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; this.signalingState = 'stable'; }
      async addIceCandidate() {} async getStats() { return new Map(); }
      restartIce() { this.restarts++; } close() { this.connectionState = 'closed'; }
    }
    const globals = { WebSocket: Socket, RTCPeerConnection: Peer,
      navigator: { mediaDevices: { async getUserMedia() { captures++; throw new Error('Audience must not capture'); } } } };
    const originals = new Map(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
    t.mock.method(Audio.prototype, 'play', async () => { plays++; });
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 0; t.mock.method(performance, 'now', () => now);
    const tick = async (ms = 25) => { now += ms; t.mock.timers.tick(ms); await drain(); };
    const until = async (predicate: () => boolean, label: string) => {
      for (let n = 0; n < 100 && !predicate(); n++) await tick(); assert.ok(predicate(), label);
    };
    const element = mountJoiningWidget({ url: 'wss://stage.example.test/ws', room: host.roomId, code: host.code!, 'playback-muted': '', 'playback-volume': '.37' });
    await drain(); const client = element.client!;
    t.after(async () => {
      try {
        Object.assign(element, { isConnected: false }); element.disconnectedCallback(); await client.disconnect();
        rejected.reject(new Error('Fixture cleanup')); await drain(); await serverWork; await h.hub.shutdown(); await h.transport.close();
        assert.ok(Socket.instances.every(socket => socket.readyState === 3)); assert.ok(Peer.instances.every(peer => peer.connectionState === 'closed'));
      } finally { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
    });
    await until(() => negotiations === 1 && Boolean(client.state), 'first real hub negotiation and joined snapshot');
    const socket = Socket.instances[0]!, peer = Peer.instances[0]!, id = client.me!.participantId;
    for (const timer of h.timers) if (!timer.cleared && timer.ms === config.rooms.presenceBroadcastMs) { timer.cleared = true; timer.fn(); }
    await drain(); rejected.reject(new Error('Controlled transient transport failure')); await drain(); await serverWork;
    assert.equal(client.status, 'live'); assert.equal(h.hub.isJoined(socket.session), true);
    assert.equal(h.transport.rooms.get(host.roomId)!.subscribers.has(id), false); assert.equal(peer.remoteDescription, null);
    assert.equal(element['error'].hidden, false); view(element); assert.equal(element['retry'].hidden, true); assert.equal(element['micRetry'].hidden, true);
    for (let n = 0; n < 8; n++) await tick(15000);
    assert.equal(negotiations, 1, 'two minutes of healthy control keepalive do not retry media');
    assert.equal(client.retryMicrophone(), false); await client.unlockAudio(); await drain(); assert.equal(negotiations, 1);
    const playsBefore = plays; press(element); view(element, { busy: true });
    await until(() => !element['audioRecoveryAttempt'], 'button-driven actual SDK ACK and installed answer'); await serverWork;
    view(element, { text: '音訊連線協商已完成。' }); assert.equal(h.transport.rooms.get(host.roomId)!.subscribers.has(id), true);
    assert.ok(peer.remoteDescription); assert.equal(negotiations, 2); assert.equal(Peer.instances.length, 1); assert.equal(Socket.instances.length, 1);
    assert.equal(client.me!.participantId, id); assert.equal(socket.sent.filter(message => message.type === 'join').length, 1);
    assert.equal(socket.sent.filter(message => message.type === 'rtc:offer').length, 2); assert.deepEqual(peer.offerOptions, [undefined, undefined]);
    assert.equal(captures, 0); assert.equal(plays, playsBefore); assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.restarts, 0);
    assert.equal(client.playbackMuted, true); assert.equal(client.playbackVolume, .37); assert.equal(peer.connectionState, 'new');
  });
});


describe('widget confirmed room closure', () => {
  type CloseWidget = InstanceType<typeof StageElement>;
  const closePrompt = '確定關閉此房間並讓所有人離場？關閉後無法再加入此房間。';
  function controllerState(onStage = false): RoomStatePayload {
    const state = roomState(onStage); state.controllerId = state.me.participantId; state.me.role = 'controller';
    state.speakers = ['target', 'second'].map(participantId => ({ ...roomState(true).me, participantId, name: `Speaker ${participantId}` }));
    return state;
  }
  const closeRequests = (socket: { sent: ClientMessage[] }) => socket.sent.filter(message => message.type === 'room:close');
  const closeBusy = (element: CloseWidget, busy: boolean) => assert.equal(element['roomClose'].getAttribute('aria-busy'), String(busy));
  const transferButton = (element: CloseWidget, id = 'target') => {
    const row = element['stageManagementRows'].get(id); assert.ok(row); return row.transfer;
  };
  function feedback(element: CloseWidget, message = 'Keep existing feedback'): void { element['show'](new Error(message)); }
  function controlSetter(t: TestContext, control: Node, property: 'hidden' | 'disabled' | 'textContent', callback: () => void): void {
    let value = control[property];
    Object.defineProperty(control, property, { configurable: true, get: () => value, set(next: string | boolean) { value = next; callback(); } });
    t.after(() => Object.defineProperty(control, property, { configurable: true, writable: true, value }));
  }

  for (const onStage of [false, true]) for (const muted of [false, true]) it(`offers independent destructive closure for controller onStage=${onStage} muted=${muted}`, async t => {
    const state = controllerState(onStage); state.me.muted = muted; state.me.forceMuted = muted;
    const { element, client } = await socketJoinedWidget(t, state), pending = deferred();
    const close = t.mock.method(client, 'closeRoom', () => pending.promise), dialog = t.mock.method(window, 'confirm', () => true);
    const action = element['roomClose'];
    assert.equal(action.type, 'button'); assert.equal(action.className, 'danger'); assert.equal(action.hidden, false); assert.equal(action.disabled, false);
    assert.equal(action.textContent, '關閉房間'); assert.equal(action.getAttribute('aria-describedby'), element['roomCloseNotice'].id);
    assert.equal(element['roomCloseNotice'].hidden, false); assert.equal(element['roomCloseNotice'].textContent,
      '關閉房間會讓所有人離場，且無法再加入此房間。離開房間只會讓你離場，房間可能保留並由其他人接任主控。');
    assert.equal(element['roomAction'].textContent, '離開房間'); feedback(element);
    click(action); closeBusy(element, true); assert.equal(action.disabled, true); click(action);
    assert.equal(dialog.mock.callCount(), 1); assert.equal(dialog.mock.calls[0]!.arguments[0], closePrompt); assert.equal(close.mock.callCount(), 1);
    pending.resolve(); await settle(); closeBusy(element, false); assert.equal(action.disabled, false);
    assert.equal(element['error'].textContent, 'Keep existing feedback'); assert.equal(element['error'].hidden, false);
    assert.equal(element['leftRoom'], false); assert.equal(element.client, client); assert.notEqual(element['status'].textContent, '房間已關閉。');
  });

  for (const condition of ['initial', 'unjoined', 'audience', 'speaker', 'disconnected', 'unsupported', 'unmounted'] as const) {
    it(`rejects retained closure clicks for ${condition} without a dialog or SDK call`, async t => {
      const { element, client } = await socketJoinedWidget(t, controllerState()), action = element['roomClose'];
      const close = t.mock.method(client, 'closeRoom', async () => {}), dialog = t.mock.method(window, 'confirm', () => true);
      feedback(element);
      if (condition === 'initial') element['current'] = null;
      else if (condition === 'unjoined') client['snapshot'] = null;
      else if (condition === 'audience' || condition === 'speaker') client.me!.role = condition;
      else if (condition === 'disconnected') client['setStatus']('disconnected');
      else if (condition === 'unsupported') Reflect.set(client, 'closeRoom', undefined);
      else Object.assign(element, { isConnected: false });
      element['render'](); assert.equal(action.hidden, true); assert.equal(action.disabled, true); action.disabled = false; click(action);
      assert.equal(dialog.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0); assert.equal(element['error'].textContent, 'Keep existing feedback');
      assert.equal(element['error'].hidden, false); closeBusy(element, false);
    });
  }

  for (const decision of ['cancel', 'throw', 'missing'] as const) it(`handles ${decision} confirmation without dispatch or fallback and permits a fresh action`, async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState()), action = element['roomClose'];
    const close = t.mock.method(client, 'closeRoom', async () => {}), leave = t.mock.method(client, 'disconnect', async () => {});
    const transfer = t.mock.method(client, 'transferControl', async () => {}); feedback(element);
    const dialog = t.mock.method(window, 'confirm', () => { if (decision === 'throw') throw new Error('Confirmation failed'); return false; });
    if (decision === 'missing') Reflect.set(window, 'confirm', undefined);
    element['render'](); assert.equal(action.hidden, false); assert.equal(action.disabled, decision === 'missing'); click(action); await settle();
    assert.equal(close.mock.callCount(), 0); assert.equal(leave.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0); closeBusy(element, false);
    assert.equal(element['error'].textContent, decision === 'throw' ? 'Confirmation failed' : 'Keep existing feedback'); assert.equal(element['error'].hidden, false);
    dialog.mock.restore(); t.mock.method(window, 'confirm', () => true); element['render'](); click(action); await settle(); assert.equal(close.mock.callCount(), 1);
  });

  for (const entry of ['reservation setter', 'confirmation', 'SDK invocation'] as const) it(`reserves exact close consent before ${entry} reentry`, async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState()), pending = deferred();
    let entered = false;
    const reenter = () => { if (entered) return; entered = true; click(element['roomClose']); click(transferButton(element)); };
    const close = t.mock.method(client, 'closeRoom', () => { if (entry === 'SDK invocation') { socket.deliver({ type: 'room:state', ...controllerState() }); reenter(); } return pending.promise; });
    const transfer = t.mock.method(client, 'transferControl', async () => {});
    const dialog = t.mock.method(window, 'confirm', () => { if (entry === 'confirmation') reenter(); return true; });
    if (entry === 'reservation setter') controlSetter(t, element['roomClose'] as unknown as Node, 'disabled', reenter);
    click(element['roomClose']); assert.equal(entered, true); assert.equal(close.mock.callCount(), 1); assert.equal(dialog.mock.callCount(), 1);
    assert.equal(transfer.mock.callCount(), 0); closeBusy(element, true); pending.resolve(); await settle(); closeBusy(element, false);
  });

  it('reserves the original owner before the first admission render can replace its controller tenure', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState()), action = element['roomClose'], owner = element['roomCloseOwner'];
    const close = t.mock.method(client, 'closeRoom', async () => {}), dialog = t.mock.method(window, 'confirm', () => true);
    action.hidden = true; let replaced = false;
    controlSetter(t, action as unknown as Node, 'hidden', () => {
      if (replaced || action.hidden) return; replaced = true;
      socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver({ type: 'room:state', ...controllerState() });
    });
    click(action); await settle(); assert.equal(replaced, true); assert.notEqual(element['roomCloseOwner'], owner);
    assert.equal(dialog.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0); closeBusy(element, false);
    click(action); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 1);
  });

  for (const boundary of ['reconnect', 'local disconnected', 'role', 'method', 'confirmation', 'button disconnected', 'button moved', 'actions removed', 'snapshot', 'room', 'seat', 'client'] as const) {
    it(`permanently invalidates consent after observed ${boundary} even when restored inside confirmation`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, controllerState()), action = element['roomClose'];
      const close = t.mock.method(client, 'closeRoom', async () => {}); let once = false;
      const dialog = t.mock.method(window, 'confirm', () => {
        if (once) return true; once = true;
        if (boundary === 'reconnect') { client['setStatus']('reconnecting'); socket.deliver({ type: 'room:state', ...controllerState() }); }
        else if (boundary === 'local disconnected') { client.me!.connected = false; element['render'](); client.me!.connected = true; }
        else if (boundary === 'role') { socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver({ type: 'room:state', ...controllerState() }); }
        else if (boundary === 'method') { const method = client.closeRoom; Reflect.set(client, 'closeRoom', undefined); element['render'](); Reflect.set(client, 'closeRoom', method); }
        else if (boundary === 'confirmation') { const confirm = window.confirm; Reflect.set(window, 'confirm', undefined); element['render'](); Reflect.set(window, 'confirm', confirm); }
        else if (boundary === 'button disconnected') { Object.assign(action, { isConnected: false }); element['render'](); Object.assign(action, { isConnected: true }); }
        else if (boundary === 'button moved') {
          const actions = element['roomActions'] as unknown as Node, original = [...actions.children], root = element['widgetRoot'] as unknown as Node;
          actions.replaceChildren(...original.filter(node => node !== action as unknown as Node)); root.append(action as unknown as Node);
          assert.equal(action.isConnected, true); element['render'](); root.children.splice(root.children.indexOf(action as unknown as Node), 1); actions.replaceChildren(...original);
        } else if (boundary === 'actions removed') {
          const root = element['widgetRoot'] as unknown as Node, original = [...root.children]; root.replaceChildren(); element['render'](); root.replaceChildren(...original);
        } else if (boundary === 'snapshot') { const original = client['snapshot']; client['snapshot'] = null; element['render'](); client['snapshot'] = original; }
        else if (boundary === 'room') { client.state!.roomId = 'other'; element['render'](); client.state!.roomId = 'one'; }
        else if (boundary === 'seat') { client.me!.participantId = 'other'; element['render'](); client.me!.participantId = 'me'; }
        else { element['current'] = null; element['render'](); element['current'] = client; }
        element['render'](); click(action); return true;
      });
      feedback(element); click(action); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 0);
      assert.equal(element['error'].textContent, 'Keep existing feedback'); closeBusy(element, false);
      click(action); await settle(); assert.equal(dialog.mock.callCount(), 2); assert.equal(close.mock.callCount(), 1);
    });
  }

  for (const attribute of ['room', 'name', 'code', 'url'] as const) it(`invalidates consent for ${attribute} identity replacement and never replays it`, async t => {
    const { element, client, tick } = await socketJoinedWidget(t, controllerState());
    const close = t.mock.method(client, 'closeRoom', async () => {}), dialog = t.mock.method(window, 'confirm', () => {
      element.setAttribute(attribute, attribute === 'url' ? 'wss://synthetic.invalid/replacement' : 'replacement'); click(element['roomClose']); return true;
    });
    click(element['roomClose']); await tick(100); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 0);
    assert.notEqual(element.client, client); assert.equal(element['leftRoom'], false); closeBusy(element, false);
  });

  it('invalidates an open dialog through unmount/remount while retaining its synchronous exclusion', async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState());
    const close = t.mock.method(client, 'closeRoom', async () => {}), dialog = t.mock.method(window, 'confirm', () => {
      Object.assign(element, { isConnected: false }); element.disconnectedCallback();
      Object.assign(element, { isConnected: true }); element.connectedCallback(); click(element['roomClose']); return true;
    });
    click(element['roomClose']); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 0); closeBusy(element, false);
  });

  for (const update of ['snapshot', 'names', 'stage and mute', 'target removal', 'other role delta', 'other stage delta', 'playback volume', 'playback mute'] as const) {
    it(`keeps room-level consent through unrelated ${update}`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, controllerState()), owner = element['roomCloseOwner'];
      const close = t.mock.method(client, 'closeRoom', async () => {});
      const dialog = t.mock.method(window, 'confirm', () => {
        const state = controllerState();
        if (update === 'names') { state.name = 'Renamed room'; state.me.name = 'Renamed controller'; }
        if (update === 'stage and mute') { state.me.onStage = true; state.me.muted = true; state.me.forceMuted = true; }
        if (update === 'target removal') state.speakers = [];
        if (update === 'other role delta') socket.deliver({ type: 'role:update', participantId: 'target', role: 'audience' });
        else if (update === 'other stage delta') socket.deliver({ type: 'stage:left', participantId: 'target', role: 'audience' });
        else if (update === 'playback volume') element.playbackVolume = .41;
        else if (update === 'playback mute') element.playbackMuted = true;
        else socket.deliver({ type: 'room:state', ...state });
        assert.equal(element['roomCloseOwner'], owner); return true;
      });
      click(element['roomClose']); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 1);
    });
  }

  for (const boundary of ['closed', 'shutdown', 'kicked', 'disconnect', 'role tenure', 'unmount', 'identity'] as const) for (const result of ['resolve', 'reject'] as const) {
    it(`ignores delayed ${result} after ${boundary} and preserves newer feedback`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, controllerState()), old = deferred(), active = deferred(); let calls = 0;
      t.mock.method(client, 'closeRoom', () => (++calls === 1 ? old : active).promise); t.mock.method(window, 'confirm', () => true);
      click(element['roomClose']); closeBusy(element, true);
      if (boundary === 'closed' || boundary === 'shutdown') socket.deliver({ type: 'room:closed', roomId: 'one', ...(boundary === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
      else if (boundary === 'kicked') socket.deliver({ type: 'kicked', roomId: 'one' });
      else if (boundary === 'disconnect') await client.disconnect();
      else if (boundary === 'role tenure') { socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver({ type: 'room:state', ...controllerState() }); click(element['roomClose']); closeBusy(element, true); }
      else if (boundary === 'unmount') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      else element.setAttribute('name', 'Replacement');
      await settle(); feedback(element, 'New feedback'); if (result === 'resolve') old.resolve(); else old.reject(new Error('Obsolete close failure')); await settle();
      assert.equal(element['error'].textContent, 'New feedback'); assert.equal(element['error'].hidden, false); closeBusy(element, boundary === 'role tenure');
      if (boundary === 'role tenure') { assert.equal(calls, 2); active.resolve(); await settle(); closeBusy(element, false); }
      if (boundary === 'closed' || boundary === 'shutdown' || boundary === 'kicked') { assert.equal(element['roomAction'].hidden, true); assert.equal(element['roomClose'].hidden, true); assert.equal(element['leftRoom'], false); }
    });
  }

  for (const newerFeedback of [false, true]) it(`reports current close rejection only with unchanged feedback revision: newer=${newerFeedback}`, async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState()), pending = deferred();
    t.mock.method(client, 'closeRoom', () => pending.promise); t.mock.method(window, 'confirm', () => true);
    feedback(element); click(element['roomClose']); if (newerFeedback) feedback(element, 'Newer feedback');
    pending.reject(new Error('Current close failed')); await settle();
    assert.equal(element['error'].textContent, newerFeedback ? 'Newer feedback' : 'Current close failed'); closeBusy(element, false);
  });

  it('releases an actual SDK ACK without synthesizing terminal state, clearing feedback, or replaying closure', async t => {
    const { element, client, socket, tick } = await socketJoinedWidget(t, controllerState()); t.mock.method(window, 'confirm', () => true); feedback(element);
    click(element['roomClose']); await tick(100); const request = closeRequests(socket)[0]!; assert.deepEqual(Object.keys(request).sort(), ['requestId', 'type']);
    socket.deliver({ type: 'ok', requestId: request.requestId }); await settle(); closeBusy(element, false);
    assert.equal(client.me!.role, 'controller'); assert.equal(element['leftRoom'], false); assert.equal(element['roomAction'].textContent, '離開房間');
    assert.notEqual(element['status'].textContent, '房間已關閉。'); assert.equal(element['error'].textContent, 'Keep existing feedback'); assert.equal(element['error'].hidden, false);
    await tick(500); assert.equal(closeRequests(socket).length, 1);
  });

  it('retains the same pending owner across reconnect, releases only its request rejection and permits a fresh resumed action', async t => {
    const { element, client, socket, sockets, tick, hello } = await socketJoinedWidget(t, controllerState()); t.mock.method(window, 'confirm', () => true);
    click(element['roomClose']); await tick(100); const owner = element['roomCloseOwner'], stale = socket.onmessage, old = closeRequests(socket)[0]!;
    socket.close(); assert.equal(element['roomCloseOwner'], owner); assert.equal(element['roomClose'].disabled, true); await settle(); closeBusy(element, false);
    feedback(element, 'Reconnect feedback'); await tick(500); const next = sockets[1]!, join = await hello(next);
    next.deliver({ type: 'room:state', ...controllerState() }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    assert.equal(element['roomCloseOwner'], owner); assert.equal(closeRequests(next).length, 0); click(element['roomClose']); await tick(100); closeBusy(element, true);
    feedback(element, 'Fresh feedback'); stale?.({ data: JSON.stringify({ type: 'error', requestId: old.requestId, code: 'forbidden', message: 'Stale wire error' }) }); await settle();
    assert.equal(element['error'].textContent, 'Fresh feedback'); closeBusy(element, true);
    next.deliver({ type: 'ok', requestId: closeRequests(next)[0]!.requestId }); await settle(); closeBusy(element, false); assert.equal(client.me!.role, 'controller');
  });

  for (const property of ['hidden', 'disabled', 'aria-busy', 'notice'] as const) it(`stops old close render writes after ${property} setter retires the owner without another render`, async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState()), action = element['roomClose']; let retired = false;
    const retire = () => { if (retired) return; retired = true; client.me!.role = 'audience'; };
    if (property === 'hidden') { action.hidden = true; controlSetter(t, action as unknown as Node, 'hidden', retire); }
    else if (property === 'disabled') { action.disabled = true; controlSetter(t, action as unknown as Node, 'disabled', retire); }
    else if (property === 'notice') { element['roomCloseNotice'].hidden = true; controlSetter(t, element['roomCloseNotice'] as unknown as Node, 'hidden', retire); }
    else { action.setAttribute('aria-busy', 'tampered'); const original = action.setAttribute; t.mock.method(action, 'setAttribute', function (this: HTMLButtonElement, key: string, value: string) { original.call(this, key, value); retire(); }); }
    element['syncRoomClose'](); assert.equal(retired, true); assert.equal(action.hidden, true); assert.equal(action.disabled, true); closeBusy(element, false);
    assert.equal(element['roomCloseNotice'].hidden, true); assert.equal(element['roomCloseOwner'], undefined);
  });

  for (const direction of ['close to transfer', 'transfer to close'] as const) for (const decision of ['cancel', 'throw', 'replacement', 'remount'] as const) {
    it(`excludes ${direction} during ${decision} while allowing a fresh action after synchronous scope exit`, async t => {
      const { element, client, socket } = await socketJoinedWidget(t, controllerState()), pending = deferred();
      const close = t.mock.method(client, 'closeRoom', () => pending.promise), transfer = t.mock.method(client, 'transferControl', () => pending.promise);
      const outer = direction === 'close to transfer' ? element['roomClose'] : transferButton(element);
      let dialogs = 0;
      t.mock.method(window, 'confirm', () => {
        dialogs++;
        if (decision === 'replacement') { socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver({ type: 'room:state', ...controllerState() }); }
        if (decision === 'remount') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); Object.assign(element, { isConnected: true }); element.connectedCallback(); }
        const inner = direction === 'close to transfer' ? (element['stageManagementRows'].get('target')?.transfer ?? outer) : element['roomClose']; click(inner);
        if (decision === 'throw') throw new Error('Dialog failed'); return false;
      });
      click(outer); await settle(); assert.equal(dialogs, 1); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
      assert.equal(element['roomCloseDialog'], undefined); assert.equal(element['stageTransferDialogs'].size, 0);
      if (decision !== 'remount') { t.mock.method(window, 'confirm', () => true); click(direction === 'close to transfer' ? transferButton(element) : element['roomClose']);
        assert.equal(direction === 'close to transfer' ? transfer.mock.callCount() : close.mock.callCount(), 1); pending.resolve(); await settle(); }
    });
  }

  it('retains an outer transfer scope after a nested replacement transfer exits and releases it before waiting for ACK', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState()), pending = deferred(); let transfers = 0, closes = 0;
    const transfer = t.mock.method(client, 'transferControl', () => pending.promise), close = t.mock.method(client, 'closeRoom', async () => {});
    t.mock.method(window, 'confirm', (message: string) => {
      if (message === closePrompt) { closes++; return true; }
      if (++transfers === 2) return true;
      socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver({ type: 'room:state', ...controllerState() });
      click(transferButton(element, 'second')); assert.equal(transfer.mock.callCount(), 1);
      click(element['roomClose']); assert.equal(closes, 0); return false;
    });
    click(transferButton(element)); await settle(); assert.equal(transfers, 2); assert.equal(transfer.mock.callCount(), 1); assert.equal(closes, 0);
    assert.equal(element['stageTransferDialogs'].size, 0); click(element['roomClose']); await settle(); assert.equal(closes, 1); assert.equal(close.mock.callCount(), 1);
    pending.resolve(); await settle(); assert.equal(element['stageTransferAttempt'], undefined);
  });

  it('preserves transfer pre-admission reconciliation even when a close dialog excludes it', async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState()), action = transferButton(element);
    const close = t.mock.method(client, 'closeRoom', async () => {}), transfer = t.mock.method(client, 'transferControl', async () => {});
    t.mock.method(window, 'confirm', () => { client.me!.role = 'audience'; click(action); assert.equal(element['stageManagementOwner'], undefined); return true; });
    click(element['roomClose']); await settle(); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
  });

  it('marks transfer admission before pre-admission setters can attempt closure', async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState()); let entered = false;
    const close = t.mock.method(client, 'closeRoom', async () => {}), transfer = t.mock.method(client, 'transferControl', async () => {});
    const dialog = t.mock.method(window, 'confirm', () => true);
    controlSetter(t, element['stageManagementSummary'] as unknown as Node, 'textContent', () => { if (entered) return; entered = true; click(element['roomClose']); });
    click(transferButton(element)); await settle(); assert.equal(entered, true); assert.equal(dialog.mock.callCount(), 1);
    assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 1);
  });

  for (const event of ['role:update', 'control:transferred'] as const) for (const lane of ['audio', 'output', 'transfer', 'close'] as const) {
    it(`fences both controller actions before ${lane} DOM setters on real Hub ${event} with its snapshot held`, async t => {
      const f = await hubCloseWidget(t), transferNode = [...f.element['stageManagementRows'].values()][0]?.transfer;
      assert.ok(transferNode); f.holdSnapshots(); f.holdDeltas();
      await f.server.hub.handle(f.session, { type: 'control:transfer', requestId: 'real-held-deltas', targetId: f.host.id }); await f.drain();
      const delta = f.heldDeltas.find(message => message.type === event && (message.type !== 'role:update' || message.participantId === f.pid)); assert.ok(delta);
      assert.equal(f.client.me!.role, 'controller');
      const close = t.mock.method(f.client, 'closeRoom', async () => {}), transfer = t.mock.method(f.client, 'transferControl', async () => {});
      const dialog = t.mock.method(window, 'confirm', () => true); let entered = false;
      const node = lane === 'audio' ? f.element['audioRetry'] : lane === 'output' ? f.element['outputDeviceApply'] : lane === 'transfer' ? transferNode : f.element['roomClose'];
      controlSetter(t, node as unknown as Node, lane === 'close' ? 'hidden' : 'disabled', () => {
        if (entered) return; entered = true; assert.equal(f.client.me!.role, 'controller');
        click(f.element['roomClose']); click(transferNode);
      });
      f.socket.deliver(delta); await settle(); assert.equal(entered, true); assert.equal(dialog.mock.callCount(), 0);
      assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0); assert.equal(f.element['roomCloseOwner'], undefined);
      assert.equal(f.element['roomCloseAuthority']?.awaitingState, true); assert.equal(f.element['stageManagementOwner']?.transferAwaitingState, true);
    });
  }

  for (const event of ['role:update', 'control:transferred'] as const) it(`cannot restore consent inside confirmation after a real ${event} loses control before its snapshot`, async t => {
    const f = await hubCloseWidget(t), state = structuredClone(f.client.state!); f.holdSnapshots(); f.holdDeltas();
    await f.server.hub.handle(f.session, { type: 'control:transfer', requestId: 'real-confirm-delta', targetId: f.host.id }); await f.drain();
    const delta = f.heldDeltas.find(message => message.type === event && (message.type !== 'role:update' || message.participantId === f.pid)); assert.ok(delta);
    const close = t.mock.method(f.client, 'closeRoom', async () => {}), owner = f.element['roomCloseOwner'];
    const dialog = t.mock.method(window, 'confirm', () => {
      f.socket.deliver(delta); assert.equal(f.client.me!.role, 'controller'); click(f.element['roomClose']);
      f.socket.deliver({ type: 'room:state', ...state }); assert.notEqual(f.element['roomCloseOwner'], owner); click(f.element['roomClose']); return true;
    });
    click(f.element['roomClose']); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 0); closeBusy(f.element, false);
  });

  it('retains the own-role fence when unsupported close capability retires the UI owner before the real delta', async t => {
    const f = await hubCloseWidget(t); f.holdSnapshots(); f.holdDeltas();
    const method = f.client.closeRoom; Reflect.set(f.client, 'closeRoom', undefined); f.element['render'](); assert.equal(f.element['roomCloseOwner'], undefined);
    await f.server.hub.handle(f.session, { type: 'control:transfer', requestId: 'missing-method-fence', targetId: f.host.id }); await f.drain();
    const delta = f.heldDeltas.find(message => message.type === 'role:update' && message.participantId === f.pid); assert.ok(delta);
    const dialog = t.mock.method(window, 'confirm', () => true); let restored = false;
    controlSetter(t, f.element['audioRetry'] as unknown as Node, 'disabled', () => {
      if (restored) return; restored = true; Reflect.set(f.client, 'closeRoom', method); click(f.element['roomClose']);
    });
    f.socket.deliver(delta); await f.drain(); assert.equal(restored, true); assert.equal(dialog.mock.callCount(), 0);
    assert.equal(f.validated.some(message => message.type === 'room:close'), false); assert.equal(f.element['roomCloseAuthority']?.awaitingState, true);
    for (const state of f.heldSnapshots) f.socket.deliver(state); assert.equal(f.element['roomClose'].hidden, true);
  });

  it('never establishes a fresh close owner from a reconnecting snapshot', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, roomState()); t.mock.method(window, 'confirm', () => true);
    client['setStatus']('reconnecting'); client.me!.role = 'controller'; element['render'](); assert.equal(element['roomCloseOwner'], undefined);
    assert.equal(element['roomClose'].hidden, true); click(element['roomClose']); assert.equal(closeRequests(socket).length, 0);
    client['setStatus']('live'); assert.ok(element['roomCloseOwner']); assert.equal(element['roomClose'].disabled, false);
  });

  for (const result of ['resolve', 'reject'] as const) it(`isolates old ${result} after same-client same-ID actual disconnect and rejoin`, async t => {
    const { element, client, socket, sockets, tick, joinRequest } = await socketJoinedWidget(t, controllerState());
    const old = deferred(), active = deferred(); let calls = 0;
    t.mock.method(client, 'closeRoom', () => (++calls === 1 ? old : active).promise); t.mock.method(window, 'confirm', () => true);
    click(element['roomClose']); const owner = element['roomCloseOwner']; await client.disconnect(); assert.equal(element['roomCloseOwner'], undefined);
    const connecting = client.connect(), next = sockets[1]!; next.hello(); await connecting;
    const joining = client.join({ roomId: 'one', name: 'Same-ID controller' }); await settle(); await tick(100); const join = joinRequest(next);
    next.deliver({ type: 'room:state', ...controllerState() }); next.deliver({ type: 'ok', requestId: join.requestId }); await joining;
    assert.notEqual(element['roomCloseOwner'], owner); click(element['roomClose']); closeBusy(element, true); feedback(element, 'New tenure feedback');
    if (result === 'resolve') old.resolve(); else old.reject(new Error('Retired close failure')); await settle();
    closeBusy(element, true); assert.equal(element['error'].textContent, 'New tenure feedback'); assert.equal(calls, 2); assert.equal(closeRequests(socket).length, 0);
    active.resolve(); await settle(); closeBusy(element, false);
  });

  for (const result of ['resolve', 'reject'] as const) it(`keeps a pending same-tenure attempt across temporary reconnect until exact ${result}`, async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState()), pending = deferred();
    const close = t.mock.method(client, 'closeRoom', () => pending.promise), dialog = t.mock.method(window, 'confirm', () => true);
    click(element['roomClose']); const owner = element['roomCloseOwner'], attempt = element['roomCloseAttempt'];
    client['setStatus']('reconnecting'); assert.equal(element['roomCloseOwner'], owner); closeBusy(element, true);
    socket.deliver({ type: 'room:state', ...controllerState() }); click(element['roomClose']);
    assert.equal(element['roomCloseAttempt'], attempt); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 1);
    feedback(element, 'Reconnect feedback'); if (result === 'resolve') pending.resolve(); else pending.reject(new Error('Obsolete request failure'));
    await settle(); closeBusy(element, false); assert.equal(element['error'].textContent, 'Reconnect feedback'); assert.equal(element['roomClose'].disabled, false);
  });

  it('does not let an old render overwrite a nested replacement controller pending close', async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState()), pending = deferred(); let replaced = false;
    const close = t.mock.method(client, 'closeRoom', () => pending.promise); t.mock.method(window, 'confirm', () => true);
    element['roomClose'].hidden = true;
    controlSetter(t, element['roomClose'] as unknown as Node, 'hidden', () => {
      if (replaced || element['roomClose'].hidden) return; replaced = true;
      socket.deliver({ type: 'room:state', ...roomState() }); socket.deliver({ type: 'room:state', ...controllerState() }); click(element['roomClose']);
    });
    element['syncRoomClose'](); assert.equal(replaced, true); assert.equal(close.mock.callCount(), 1);
    closeBusy(element, true); assert.equal(element['roomClose'].disabled, true); assert.equal(element['roomCloseNotice'].hidden, false);
    pending.resolve(); await settle(); closeBusy(element, false);
  });

  for (const terminal of ['room:closed', 'kicked'] as const) it(`stops a close renderer when a setter delivers ${terminal}`, async t => {
    const { element, socket } = await socketJoinedWidget(t, controllerState()); let terminalSent = false;
    element['roomClose'].disabled = true;
    controlSetter(t, element['roomClose'] as unknown as Node, 'disabled', () => {
      if (terminalSent) return; terminalSent = true; socket.deliver({ type: terminal, roomId: 'one' });
    });
    element['syncRoomClose'](); assert.equal(element['roomCloseOwner'], undefined); assert.equal(element['roomClose'].hidden, true);
    assert.equal(element['roomClose'].disabled, true); assert.equal(element['roomCloseNotice'].hidden, true); closeBusy(element, false);
  });

  it('releases only its exact attempt even when reservation and finalizer DOM setters throw', async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState()), action = element['roomClose'];
    const close = t.mock.method(client, 'closeRoom', async () => {}), dialog = t.mock.method(window, 'confirm', () => true); let fail = true;
    controlSetter(t, action as unknown as Node, 'disabled', () => { if (fail) throw new Error('Controlled DOM failure'); });
    click(action); await settle(); assert.equal(element['roomCloseAttempt'], undefined); assert.equal(element['roomCloseDialog'], undefined);
    assert.equal(dialog.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0);
    fail = false; element['render'](); click(action); await settle(); assert.equal(close.mock.callCount(), 1); closeBusy(element, false);
  });

  it('keeps synchronous dialog exclusion local to each widget instance', async t => {
    const first = await subscribedWidget(t), second = await subscribedWidget(t);
    await first.client['receive']({ type: 'room:state', ...controllerState() }); await second.client['receive']({ type: 'room:state', ...controllerState() });
    const firstClose = t.mock.method(first.client, 'closeRoom', async () => {}), secondClose = t.mock.method(second.client, 'closeRoom', async () => {}); let dialogs = 0;
    t.mock.method(window, 'confirm', () => { if (++dialogs === 1) click(second.element['roomClose']); return true; });
    click(first.element['roomClose']); await settle(); assert.equal(dialogs, 2); assert.equal(firstClose.mock.callCount(), 1); assert.equal(secondClose.mock.callCount(), 1);
  });

  it('reconciles a retained direct handler after capability removal without transferring that click to a restored owner', async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState()), action = element['roomClose'];
    const close = t.mock.method(client, 'closeRoom', async () => {}), method = client.closeRoom, dialog = t.mock.method(window, 'confirm', () => true);
    Reflect.set(client, 'closeRoom', undefined); click(action); await settle();
    assert.equal(dialog.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0); assert.equal(action.hidden, true); assert.equal(action.disabled, true);
    Reflect.set(client, 'closeRoom', method); click(action); await settle(); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 1);
  });

  for (const boundary of ['role', 'connectivity', 'room', 'seat'] as const) it(`observes ${boundary} replacement state before an early audio setter can restore it inside confirmation`, async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState()), close = t.mock.method(client, 'closeRoom', async () => {});
    let restoring = false, restored = false;
    controlSetter(t, element['audioRetry'] as unknown as Node, 'disabled', () => {
      if (!restoring || restored) return; restored = true;
      client.me!.role = 'controller'; client.me!.connected = true; client.me!.participantId = 'me'; client.state!.roomId = 'one';
      click(element['roomClose']);
    });
    const dialog = t.mock.method(window, 'confirm', () => {
      restoring = true; const state = controllerState();
      if (boundary === 'role') state.me.role = 'audience';
      else if (boundary === 'connectivity') state.me.connected = false;
      else if (boundary === 'room') state.roomId = 'other';
      else state.me.participantId = 'other';
      socket.deliver({ type: 'room:state', ...state }); return true;
    });
    click(element['roomClose']); await settle(); assert.equal(restored, true); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 0); closeBusy(element, false);
  });

  for (const boundary of ['role', 'connectivity', 'room', 'seat'] as const) it(`fences a transfer's observed ${boundary} replacement state before an early setter restores the old controller`, async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState()), action = transferButton(element);
    const transfer = t.mock.method(client, 'transferControl', async () => {}); let restoring = false, restored = false, dialogs = 0;
    controlSetter(t, element['audioRetry'] as unknown as Node, 'disabled', () => {
      if (!restoring || restored) return; restored = true;
      client.me!.role = 'controller'; client.me!.connected = true; client.me!.participantId = 'me'; client.state!.roomId = 'one';
      click(transferButton(element)); click(element['roomClose']);
    });
    t.mock.method(window, 'confirm', () => {
      if (++dialogs > 1) return true;
      restoring = true; const state = controllerState();
      if (boundary === 'role') state.me.role = 'audience';
      else if (boundary === 'connectivity') state.me.connected = false;
      else if (boundary === 'room') state.roomId = 'other';
      else state.me.participantId = 'other';
      socket.deliver({ type: 'room:state', ...state }); return true;
    });
    click(action); await settle(); assert.equal(restored, true); assert.equal(dialogs, 1); assert.equal(transfer.mock.callCount(), 0);
    assert.equal(element['stageManagementOwner']?.transferAwaitingState, true); click(transferButton(element)); await settle(); assert.equal(dialogs, 1);
    socket.deliver({ type: 'room:state', ...controllerState() }); click(transferButton(element)); await settle(); assert.equal(dialogs, 2); assert.equal(transfer.mock.callCount(), 1);
  });

  it('permits waiting offstage controller closure with an empty stage and preserves independent Leave', async t => {
    const state = controllerState(); state.status = 'waiting'; state.speakers = [];
    const { element, client } = await socketJoinedWidget(t, state), close = t.mock.method(client, 'closeRoom', async () => {});
    t.mock.method(window, 'confirm', () => true); assert.equal(element['roomClose'].disabled, false);
    assert.equal(element['roomAction'].disabled, false); assert.equal(element['stageManagementRows'].size, 0);
    click(element['roomClose']); await settle(); assert.equal(close.mock.callCount(), 1); assert.equal(element['leftRoom'], false);
  });

  for (const status of ['reconnecting', 'disconnected'] as const) it(`invalidates active transfer consent on observed ${status} before an early setter restores live status`, async t => {
    const { element, client } = await socketJoinedWidget(t, controllerState()), action = transferButton(element);
    const transfer = t.mock.method(client, 'transferControl', async () => {}); let restoring = false, restored = false;
    controlSetter(t, element['audioRetry'] as unknown as Node, 'disabled', () => {
      if (!restoring || restored) return; restored = true; client['setStatus']('live');
    });
    const dialog = t.mock.method(window, 'confirm', () => { restoring = true; client['setStatus'](status); return true; });
    click(action); await settle(); assert.equal(restored, true); assert.equal(dialog.mock.callCount(), 1); assert.equal(transfer.mock.callCount(), 0);
  });

  for (const boundary of ['role', 'connectivity', 'room', 'seat'] as const) it(`fences a transfer's ${boundary} loss in a status-changing snapshot before the following state event`, async t => {
    const { element, client, socket } = await socketJoinedWidget(t, controllerState()), transfer = t.mock.method(client, 'transferControl', async () => {});
    let restoring = false, restored = false;
    controlSetter(t, element['audioRetry'] as unknown as Node, 'disabled', () => {
      if (!restoring || restored) return; restored = true;
      client.me!.role = 'controller'; client.me!.connected = true; client.me!.participantId = 'me'; client.state!.roomId = 'one';
    });
    const dialog = t.mock.method(window, 'confirm', () => {
      restoring = true; const state = controllerState(); state.status = 'waiting';
      if (boundary === 'role') state.me.role = 'audience';
      else if (boundary === 'connectivity') state.me.connected = false;
      else if (boundary === 'room') state.roomId = 'other';
      else state.me.participantId = 'other';
      socket.deliver({ type: 'room:state', ...state }); return true;
    });
    click(transferButton(element)); await settle(); assert.equal(restored, true); assert.equal(dialog.mock.callCount(), 1); assert.equal(transfer.mock.callCount(), 0);
  });

  // Controlled browser-media surfaces for the complete widget/SDK/validator/Hub path.
  // These do not establish native dialog, focus, layout, accessibility or hardware-audio behavior.
  class StagePeer {
    static instances: StagePeer[] = [];
    connectionState = 'connected'; signalingState = 'stable';
    localDescription: { type: 'offer'; sdp: string } | null = null;
    readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown,
      replaceTrack: async (track: unknown) => { this.transceiver.sender.track = track; } } };
    constructor() { StagePeer.instances.push(this); }
    addTransceiver() { return this.transceiver; }
    async createOffer() { return { type: 'offer' as const, sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` }; }
    async setLocalDescription(description: { type: 'offer'; sdp: string }): Promise<void> { this.localDescription = description; this.signalingState = 'have-local-offer'; }
    async setRemoteDescription(): Promise<void> { this.signalingState = 'stable'; }
    async addIceCandidate(): Promise<void> {}
    close(): void { this.connectionState = 'closed'; }
  }
  class StageContext {
    static instances: StageContext[] = [];
    closes = 0;
    constructor() { StageContext.instances.push(this); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData() {}, disconnect() {} }; }
    async resume(): Promise<void> {}
    async close(): Promise<void> { this.closes++; }
  }

  async function hubCloseWidget(t: TestContext, onStage = false, asController = true) {
    const tracks: { enabled: boolean; stopped: boolean; readyState: string; stop(): void }[] = [];
    const mediaGlobals = new Map(['navigator', 'RTCPeerConnection', 'AudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: StagePeer });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: StageContext });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
      const track = Object.assign(new EventTarget(), { enabled: true, stopped: false, readyState: 'live', stop() { this.stopped = true; this.readyState = 'ended'; } });
      tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } } });
    t.after(() => { for (const [key, descriptor] of mediaGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
    const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.controllerGraceMs = 60_000; });
    const server = harness(config), host = await server.create('Synthetic original controller');
    const sockets: Socket[] = [], elements: InstanceType<typeof StageElement>[] = [];
    const validated: ClientMessage[] = [], incoming: ServerMessage[] = [], held: ServerMessage[] = [];
    const sessions = new Map<Socket, Session>();
    const closes: { socket: Socket; code: number | undefined }[] = [];
    const peersStart = StagePeer.instances.length, contextsStart = StageContext.instances.length, tracksStart = tracks.length;
    let serverWork = Promise.resolve(), sequence = 0, holdCloseAck = false, holdSnapshots = false, holdDeltas = false;
    const heldDeltas: ServerMessage[] = [];
    let beforeClose: (() => Promise<void>) | undefined;
    const heldSnapshots: ServerMessage[] = [];
    class Socket {
      static OPEN = 1;
      readyState = 1;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        sockets.push(this);
        const session: Session = { id: `widget-close-${++sequence}`,
          send: message => {
            incoming.push(message);
            if (holdDeltas && (message.type === 'role:update' || message.type === 'control:transferred')) { heldDeltas.push(message); return; }
            if (holdCloseAck && message.type === 'ok' && validated.some(request => request.type === 'room:close' && request.requestId === message.requestId)) { held.push(message); return; }
            if (holdSnapshots && message.type === 'room:state') { heldSnapshots.push(message); return; }
            if (this.readyState === Socket.OPEN) this.deliver(message);
          },
          close: code => this.close(code),
        };
        sessions.set(this, session);
        queueMicrotask(() => server.hub.attach(session));
      }
      send(data: string) {
        assert.equal(this.readyState, Socket.OPEN);
        const message = parseClientMessage(data, config.limits), session = sessions.get(this)!;
        validated.push(message);
        serverWork = serverWork.then(async () => { if (message.type === 'room:close') await beforeClose?.(); await server.hub.handle(session, message); });
      }
      deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
      close(code?: number) {
        if (this.readyState === 3) return;
        closes.push({ socket: this, code }); this.readyState = 3; this.onclose?.();
        const session = sessions.get(this)!;
        serverWork = serverWork.then(() => server.hub.detach(session, code === 1000));
      }
    }
    const oldSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let now = 1000; t.mock.method(performance, 'now', () => now);
    const tick = async (ms = 200) => { now += ms; t.mock.timers.tick(ms); await settle(); await serverWork; await settle(); };
    const drain = async () => { for (let n = 0; n < 8; n++) await tick(); };
    const flushStates = async () => {
      for (const timer of server.timers) if (!timer.cleared && (timer.ms === 0 || timer.ms === config.rooms.presenceBroadcastMs)) { timer.cleared = true; timer.fn(); }
      await nextTurn(); await settle();
    };
    const mount = async (name: string) => {
      const element = new StageElement(); elements.push(element); Object.assign(element, { isConnected: false });
      element.setAttribute('url', 'wss://synthetic.invalid/ws'); element.setAttribute('room', host.roomId); element.setAttribute('code', host.code); element.setAttribute('name', name);
      Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle(); await drain();
      assert.ok(element.client?.me, 'actual widget joined through actual SDK and Hub'); return element;
    };
    t.after(async () => {
      for (const element of elements) { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      await settle(); await serverWork; await server.hub.shutdown(); await server.transport.close(); await settle();
      if (oldSocket) Object.defineProperty(globalThis, 'WebSocket', oldSocket); else Reflect.deleteProperty(globalThis, 'WebSocket');
    });
    const element = await mount('Synthetic widget controller'), client = element.client!, socket = sockets[0]!, session = sessions.get(socket)!, pid = client.me!.participantId;
    if (asController) { assert.equal(await server.req(host.s, { type: 'control:transfer', targetId: pid }), 'ok'); await drain(); assert.equal(client.me!.role, 'controller'); }
    if (onStage) {
      const work = asController ? client.returnToStage() : client.raiseHand(); await drain(); await work;
      if (!asController) { assert.equal(await server.req(host.s, { type: 'stage:approve', targetId: pid }), 'ok'); await drain(); }
      assert.equal(client.me!.onStage, true);
    }
    return { config, server, host, sockets, sessions, closes, validated, incoming, held, heldSnapshots, heldDeltas, peersStart, contextsStart, tracksStart, tracks,
      element, client, socket, session, pid, tick, drain, flushStates, mount,
      holdAck: () => { holdCloseAck = true; }, beforeClose: (fn: () => Promise<void>) => { beforeClose = fn; },
      holdSnapshots: () => { holdSnapshots = true; }, holdDeltas: () => { holdDeltas = true; },
    };
  }

  for (const onStage of [false, true]) it(`widget Leave onStage=${onStage} keeps controller grace, live guests and later succession without room:close`, async t => {
    const f = await hubCloseWidget(t, onStage), guest = await f.mount('Synthetic guest'), guestSession = f.sessions.get(f.sockets.at(-1)!)!;
    click(f.element['roomAction']); await f.drain(); await f.flushStates();
    assert.equal(f.closes.find(close => close.socket === f.socket)?.code, 1000);
    assert.equal(f.element.client, null); assert.equal(f.client.status, 'disconnected');
    assert.equal(f.element['status'].textContent, '已離開房間。'); assert.equal(f.element['roomAction'].textContent, '重新加入');
    assert.equal(f.validated.some(message => message.type === 'room:close'), false);
    assert.equal(f.server.hub.roomCount, 1); assert.equal(f.server.transport.rooms.has(f.host.roomId), true);
    assert.equal(f.server.hub.isJoined(guestSession), true); assert.equal(guest.client!.state!.controllerId, f.pid);
    assert.notEqual(guest.client!.status, 'disconnected'); assert.equal(f.incoming.some(message => message.type === 'room:closed'), false);
    const late = await f.server.join(f.host.roomId, f.host.code, 'Synthetic late join'); assert.ok(late.id);
    const grace = f.server.timers.find(timer => !timer.cleared && timer.ms === f.config.rooms.controllerGraceMs); assert.ok(grace);
    grace.cleared = true; grace.fn(); await nextTurn(); await f.flushStates();
    assert.equal(f.server.hub.roomCount, 1); assert.notEqual(guest.client!.state!.controllerId, f.pid);
    assert.equal(f.incoming.some(message => message.type === 'room:closed'), false);
  });

  it('ordinary audience Leave immediately removes only its own seat and leaves the room joinable', async t => {
    const f = await hubCloseWidget(t, false, false); click(f.element['roomAction']); await f.drain(); await f.flushStates();
    assert.equal(f.server.hub.isJoined(f.session), false); assert.equal(f.server.hub.isJoined(f.host.s), true);
    assert.equal(f.host.s.last('room:state')!.audience!.some(person => person.participantId === f.pid), false);
    assert.equal(f.server.hub.roomCount, 1); assert.equal(f.validated.some(message => message.type === 'room:close'), false);
  });

  for (const onStage of [false, true]) it(`confirmed widget button onStage=${onStage} closes all seats/media, unlike Leave`, async t => {
    const f = await hubCloseWidget(t, onStage), guest = await f.mount('Synthetic guest'), guestSession = f.sessions.get(f.sockets.at(-1)!)!;
    const closed: unknown[] = []; f.element.addEventListener('stage-closed', event => closed.push((event as CustomEvent).detail));
    t.mock.method(window, 'confirm', () => true); click(f.element['roomClose']); await f.drain();
    assert.deepEqual(f.validated.filter(message => message.type === 'room:close').map(message => Object.keys(message).sort()), [['requestId', 'type']]);
    assert.equal(f.server.hub.roomCount, 0); assert.equal(f.server.transport.rooms.has(f.host.roomId), false);
    for (const session of [f.session, guestSession, f.host.s]) assert.equal(f.server.hub.isJoined(session), false);
    assert.equal(f.client.me, null); assert.equal(guest.client!.me, null); assert.equal(f.client.status, 'disconnected');
    assert.equal(f.element['status'].textContent, '房間已關閉。'); assert.equal(guest['status'].textContent, '房間已關閉。');
    assert.equal(f.element['roomAction'].hidden, true); assert.deepEqual(closed, [{ roomId: f.host.roomId }]);
    assert.ok(f.server.timers.every(timer => timer.cleared));
    assert.ok(StagePeer.instances.length > f.peersStart);
    if (onStage) { assert.ok(f.tracks.length > f.tracksStart); assert.ok(StageContext.instances.length > f.contextsStart); }
    assert.ok(StagePeer.instances.slice(f.peersStart).every(peer => peer.connectionState === 'closed'));
    assert.ok(StageContext.instances.slice(f.contextsStart).every(context => context.closes > 0));
    assert.ok(f.tracks.slice(f.tracksStart).every(track => track.stopped));
    const late = new FakeSession(); f.server.hub.attach(late);
    assert.equal(await f.server.req(late, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Cannot rejoin closed room' }), 'unauthorized');
  });

  for (const onStage of [false, true]) it(`Hub rejects actual widget ${onStage ? 'speaker' : 'audience'} SDK closure without affecting room`, async t => {
    const f = await hubCloseWidget(t, onStage, false), dialog = t.mock.method(window, 'confirm', () => true);
    assert.equal(f.element['roomClose'].hidden, true); assert.equal(f.element['roomClose'].disabled, true);
    click(f.element['roomClose']); await f.drain(); assert.equal(dialog.mock.callCount(), 0);
    assert.equal(f.validated.some(message => message.type === 'room:close'), false);
    const result = f.client.closeRoom().then(() => 'ok', error => error.code);
    await f.drain(); assert.equal(await result, 'forbidden'); assert.equal(f.server.hub.roomCount, 1);
    assert.equal(f.server.hub.isJoined(f.session), true); assert.equal(f.incoming.some(message => message.type === 'room:closed'), false);
    assert.equal(f.element['error'].hidden, false);
  });

  it('terminal before withheld ACK rejects local close promise but complete widget shows terminal result and never retries', async t => {
    const f = await hubCloseWidget(t); f.holdAck();
    t.mock.method(window, 'confirm', () => true); click(f.element['roomClose']); await f.drain();
    assert.equal(f.held.length, 1); assert.equal(f.client['pending'].size, 0);
    assert.equal(f.element['status'].textContent, '房間已關閉。'); assert.equal(f.element['error'].hidden, true);
    for (const ack of f.held) f.socket.deliver(ack); await f.tick(30_000); await f.drain();
    assert.equal(f.sockets.length, 1); assert.equal(f.validated.filter(message => message.type === 'room:close').length, 1);
    assert.equal(f.element['status'].textContent, '房間已關閉。');
  });

  it('server authority wins if control is transferred after close is queued but before Hub executes it', async t => {
    const f = await hubCloseWidget(t);
    // Inject the competing authoritative request before the queued close executes.
    f.beforeClose(async () => { await f.server.hub.handle(f.session, { type: 'control:transfer', requestId: 'competing-transfer', targetId: f.host.id }); });
    t.mock.method(window, 'confirm', () => true); click(f.element['roomClose']); await f.drain();
    assert.ok(f.incoming.some(message => message.type === 'error' && message.code === 'forbidden')); assert.notEqual(f.client.me!.role, 'controller'); assert.equal(f.server.hub.roomCount, 1);
    assert.equal(f.incoming.some(message => message.type === 'room:closed'), false);
  });

  it('actual transfer notifications precede authoritative snapshot and expose stale controller getter to host callbacks', async t => {
    const f = await hubCloseWidget(t), observed: { type: string; role: string | undefined }[] = [];
    for (const type of ['stage-role', 'stage-transferred']) f.element.addEventListener(type, () => observed.push({ type, role: f.client.me?.role }));
    f.holdSnapshots(); await f.server.hub.handle(f.session, { type: 'control:transfer', requestId: 'notify-before-state', targetId: f.host.id }); await f.drain();
    assert.ok(observed.some(event => event.type === 'stage-transferred' && event.role === 'controller'));
    assert.ok(f.heldSnapshots.length); assert.equal(f.client.me!.role, 'controller');
    const result = f.client.closeRoom().then(() => 'ok', error => error.code); await f.drain(); assert.equal(await result, 'forbidden');
    for (const state of f.heldSnapshots) f.socket.deliver(state); await settle(); assert.notEqual(f.client.me!.role, 'controller');
  });

  it('validator cannot use extra roomId, targetId or role fields to confer closure authority', async t => {
    const f = await hubCloseWidget(t, false, false);
    const request = parseClientMessage(JSON.stringify({ type: 'room:close', requestId: 'spoof-close', roomId: 'another-room', targetId: f.host.id, role: 'controller' }), f.config.limits);
    assert.deepEqual(request, { type: 'room:close', requestId: 'spoof-close' });
    await f.server.hub.handle(f.session, request); await settle();
    assert.ok(f.incoming.some(message => message.type === 'error' && message.requestId === 'spoof-close' && message.code === 'forbidden'));
    assert.equal(f.server.hub.roomCount, 1);
  });

  it('Leave opt-out survives widget attribute changes and unmount/remount until explicit rejoin', async t => {
    const f = await hubCloseWidget(t); click(f.element['roomAction']); await f.drain();
    f.element.setAttribute('name', 'New synthetic name'); f.element.setAttribute('code', f.host.code);
    Object.assign(f.element, { isConnected: false }); f.element.disconnectedCallback();
    Object.assign(f.element, { isConnected: true }); f.element.connectedCallback(); await f.drain();
    assert.equal(f.sockets.length, 1); assert.equal(f.element.client, null); assert.equal(f.element['status'].textContent, '已離開房間。');
    click(f.element['roomAction']); await f.drain(); assert.equal(f.sockets.length, 2); assert.ok(f.element.client!.me);
    assert.equal(f.validated.some(message => message.type === 'room:close'), false);
  });


  /** Counts controlled DOM calls, not browser layout, focus, IME, or accessibility behavior. */
  function instrumentEditors(element: InstanceType<typeof StageElement>) {
    const counts = new Map<string, { calls: number; changes: number; reads: number }>();
    const restores: (() => void)[] = [], writes: string[] = []; let recording = true;
    const bump = (key: string, kind: 'calls' | 'changes' | 'reads') => {
      if (!recording) return;
      if (kind === 'calls') writes.push(key);
      const value = counts.get(key) ?? { calls: 0, changes: 0, reads: 0 }; value[kind]++; counts.set(key, value);
    };
    for (const [key, property] of [
      ['namePanel', 'hidden'], ['nameInput', 'value'], ['nameInput', 'disabled'], ['acceptedName', 'textContent'], ['nameUpdate', 'disabled'],
      ['roomNamePanel', 'hidden'], ['roomNameInput', 'value'], ['roomNameInput', 'disabled'], ['acceptedRoomName', 'textContent'], ['roomNameUpdate', 'disabled'],
    ] as const) {
      const node = element[key], original = Object.getOwnPropertyDescriptor(node, property);
      let stored = Reflect.get(node, property);
      Object.defineProperty(node, property, { configurable: true, get() { bump(`${key}.${property}`, 'reads'); return stored; }, set(value) {
        bump(`${key}.${property}`, 'calls'); if (stored !== value) bump(`${key}.${property}`, 'changes'); stored = value;
      } });
      restores.push(() => { if (original) Object.defineProperty(node, property, { ...original, value: stored }); else { Reflect.deleteProperty(node, property); Reflect.set(node, property, stored); } });
    }
    for (const key of ['nameUpdate', 'roomNameUpdate'] as const) {
      const node = element[key], set = node.setAttribute, remove = node.removeAttribute, get = node.getAttribute, has = node.hasAttribute;
      node.setAttribute = function(name, value) {
        if (name === 'aria-busy') { bump(`${key}.aria-busy`, 'calls'); if (get.call(this, name) !== value) bump(`${key}.aria-busy`, 'changes'); }
        set.call(this, name, value);
      };
      node.removeAttribute = function(name) {
        if (name === 'aria-busy') { bump(`${key}.aria-busy`, 'calls'); if (has.call(this, name)) bump(`${key}.aria-busy`, 'changes'); }
        remove.call(this, name);
      };
      node.getAttribute = function(name) { if (name === 'aria-busy') bump(`${key}.aria-busy`, 'reads'); return get.call(this, name); };
      node.hasAttribute = function(name) { if (name === 'aria-busy') bump(`${key}.aria-busy`, 'reads'); return has.call(this, name); };
      restores.push(() => { node.setAttribute = set; node.removeAttribute = remove; node.getAttribute = get; node.hasAttribute = has; });
    }
    const snapshot = () => {
      const properties = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
      return { calls: [...counts.values()].reduce((n, v) => n + v.calls, 0), changes: [...counts.values()].reduce((n, v) => n + v.changes, 0), properties, writes: [...writes] };
    };
    return { snapshot, reset: () => { counts.clear(); writes.length = 0; }, hostWrite(fn: () => void) { recording = false; try { fn(); } finally { recording = true; } }, restore: () => restores.forEach(fn => fn()) };
  }

  it('editor DOM guards counts full widget legal SDK validator Hub workloads with retained drafts and callback order', async t => {
    const f = await hubCloseWidget(t), guest = await f.mount('Synthetic audience');
    await f.flushStates(); await f.drain();
    const controller = f.element, viewers = [controller, guest], meters = viewers.map(instrumentEditors);
    t.after(() => meters.forEach(meter => meter.restore()));
    const identities = viewers.map(element => ['namePanel', 'acceptedName', 'nameInput', 'nameUpdate', 'roomNamePanel', 'acceptedRoomName', 'roomNameInput', 'roomNameUpdate'].map(key => Reflect.get(element, key)));
    const handlers = viewers.map(element => [element['nameUpdate'].onclick, element['roomNameUpdate'].onclick]);
    controller['nameInput'].value = '  untouched controller draft  '; controller['roomNameInput'].value = '  untouched room draft  '; guest['nameInput'].value = '  untouched audience draft  ';
    for (const input of [controller['nameInput'], controller['roomNameInput'], guest['nameInput']]) Object.assign(input, { selectionStart: 2, selectionEnd: 7, selectionDirection: 'backward' });
    const methods = ['syncNameOwner', 'syncRoomNameOwner', 'noteRoomCloseEvent', 'noteStageTransferEvent'] as const;
    const syncs = viewers.map(element => methods.map(method => t.mock.method(element as unknown as Record<(typeof methods)[number], (...args: unknown[]) => void>, method)));
    const eventTrace: string[] = [];
    for (const [index, element] of viewers.entries()) for (const type of ['state', 'status', 'role', 'transferred', 'error']) element.addEventListener(`stage-${type}`, () => eventTrace.push(`${index}:${type}`));
    type EditorCounts = ReturnType<ReturnType<typeof instrumentEditors>['snapshot']>;
    type Workload = {
      label: string; controller: EditorCounts; audience: EditorCounts;
      callbacks: string[]; synchronizations: number[][]; commands: string[];
    };
    const results: Workload[] = [];
    async function measure(label: string, work: () => Promise<void>) {
      meters.forEach(meter => meter.reset());
      const before = syncs.map(items => items.map(item => item.mock.callCount())), trace = eventTrace.length, request = f.validated.length;
      await work(); await f.drain();
      results.push({ label, controller: meters[0]!.snapshot(), audience: meters[1]!.snapshot(), callbacks: eventTrace.slice(trace),
        synchronizations: syncs.map((items, i) => items.map((item, j) => item.mock.callCount() - before[i]![j]!)),
        commands: f.validated.slice(request).filter(message => message.type !== 'ping').map(message => message.type) });
    }
    async function run(action: () => Promise<void>) { const result = action(); await f.drain(); await result; }
    await measure('20 audience participant rename changes', async () => { for (let i = 0; i < 20; i++) await run(() => guest.client!.setName(`Audience ${i}`)); });
    await measure('20 controller room rename changes', async () => { for (let i = 0; i < 20; i++) await run(() => f.client.setRoomName(`Room ${i}`)); });
    await measure('20 controller no-op room submissions', async () => { for (let i = 0; i < 20; i++) await run(() => f.client.setRoomName('Room 19')); });
    assert.equal(controller['nameInput'].value, '  untouched controller draft  '); assert.equal(controller['roomNameInput'].value, '  untouched room draft  '); assert.equal(guest['nameInput'].value, '  untouched audience draft  ');
    for (const input of [controller['nameInput'], controller['roomNameInput'], guest['nameInput']]) assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 7, 'backward']);
    for (const [index, element] of viewers.entries()) {
      for (const [position, key] of ['namePanel', 'acceptedName', 'nameInput', 'nameUpdate', 'roomNamePanel', 'acceptedRoomName', 'roomNameInput', 'roomNameUpdate'].entries()) assert.equal(Reflect.get(element, key), identities[index]![position]);
      assert.equal(element['nameUpdate'].onclick, handlers[index]![0]); assert.equal(element['roomNameUpdate'].onclick, handlers[index]![1]);
    }
    await measure('20 controller participant editor button submissions', async () => {
      for (let i = 0; i < 20; i++) { meters[0]!.hostWrite(() => { controller['nameInput'].value = `UI Controller ${i}`; }); click(controller['nameUpdate']); await f.drain(); assert.equal(controller['nameAttempt'], undefined); }
    });
    await measure('20 controller room editor button submissions', async () => {
      for (let i = 0; i < 20; i++) { meters[0]!.hostWrite(() => { controller['roomNameInput'].value = `UI Room ${i}`; }); click(controller['roomNameUpdate']); await f.drain(); assert.equal(controller['roomNameAttempt'], undefined); }
    });
    await measure('20 audience participant editor button submissions', async () => {
      for (let i = 0; i < 20; i++) { meters[1]!.hostWrite(() => { guest['nameInput'].value = `UI Audience ${i}`; }); click(guest['nameUpdate']); await f.drain(); assert.equal(guest['nameAttempt'], undefined); }
    });
    // Per-property expectations retain every accepted-text and retired-draft write, including equal values.
    const expected = [
      { calls: [80, 120], changes: [0, 20], command: 'participant:rename', events: ['1:state', '0:state'], syncs: [[40, 40, 20, 20], [40, 40, 20, 20]], changed: [null, 'name'], pending: [null, null] },
      { calls: [80, 120], changes: [20, 0], command: 'room:rename', events: ['0:state', '1:state'], syncs: [[40, 40, 20, 20], [40, 40, 20, 20]], changed: ['roomName', null], pending: [null, null] },
      { calls: [80, 0], changes: [0, 0], command: 'room:rename', events: ['0:state'], syncs: [[40, 40, 20, 20], [0, 0, 0, 0]], changed: [null, null], pending: [null, null] },
      { calls: [240, 120], changes: [100, 0], command: 'participant:rename', events: ['0:state', '1:state'], syncs: [[120, 40, 20, 20], [40, 40, 20, 20]], changed: ['name', null], pending: ['name', null] },
      { calls: [240, 120], changes: [100, 0], command: 'room:rename', events: ['0:state', '1:state'], syncs: [[40, 120, 20, 20], [40, 40, 20, 20]], changed: ['roomName', null], pending: ['roomName', null] },
      { calls: [80, 280], changes: [0, 100], command: 'participant:rename', events: ['1:state', '0:state'], syncs: [[40, 40, 20, 20], [120, 40, 20, 20]], changed: [null, 'name'], pending: [null, 'name'] },
    ] as const;
    assert.equal(results.length, expected.length);
    for (const [index, result] of results.entries()) {
      const want = expected[index]!;
      assert.deepEqual(result.commands, Array(20).fill(want.command), result.label);
      assert.deepEqual(result.callbacks, Array.from({ length: 20 }, () => [...want.events]).flat(), result.label);
      assert.deepEqual(result.synchronizations, want.syncs, result.label);
      for (const [viewer, measured] of [result.controller, result.audience].entries()) {
        assert.equal(measured.calls, want.calls[viewer], `${result.label}: viewer ${viewer} writes`);
        assert.equal(measured.changes, want.changes[viewer], `${result.label}: viewer ${viewer} changed writes`);
        for (const [editorIndex, editor] of (['name', 'roomName'] as const).entries()) {
          const sync = want.syncs[viewer]![editorIndex]!, pending = want.pending[viewer] === editor;
          const text = editor === 'name' ? 'acceptedName' : 'acceptedRoomName';
          const propertyCounts: Record<string, readonly [number, number]> = {
            [`${text}.textContent`]: [sync, want.changed[viewer] === editor ? 20 : 0],
            [`${editor}Input.value`]: [viewer === 1 && editor === 'roomName' ? sync : 0, 0],
            [`${editor}Panel.hidden`]: [0, 0], [`${editor}Input.disabled`]: [0, 0],
            [`${editor}Update.disabled`]: [pending ? 40 : 0, pending ? 40 : 0],
            [`${editor}Update.aria-busy`]: [pending ? 40 : 0, pending ? 40 : 0],
          };
          for (const [key, counts] of Object.entries(propertyCounts)) {
            const actual = measured.properties[key];
            assert.deepEqual([actual?.calls ?? 0, actual?.changes ?? 0], counts, `${result.label}: viewer ${viewer} ${key}`);
          }
        }
      }
    }
    assert.equal(results.reduce((sum, result) => sum + result.controller.calls + result.audience.calls, 0), 1560);
    assert.equal(results.reduce((sum, result) => sum + result.controller.changes + result.audience.changes, 0), 340);
    assert.equal(eventTrace.length, 220);

  });

  for (const editor of ['name', 'roomName'] as const) it(`editor DOM guards ${editor} full Hub pending ACK, draft edits, validation failure and retry`, async t => {
    const f = await hubCloseWidget(t), element = f.element, input = editor === 'name' ? element['nameInput'] : element['roomNameInput'];
    const button = editor === 'name' ? element['nameUpdate'] : element['roomNameUpdate'];
    const accepted = editor === 'name' ? element['acceptedName'] : element['acceptedRoomName'];
    const command = editor === 'name' ? 'participant:rename' : 'room:rename';
    const attempt = editor === 'name' ? 'nameAttempt' : 'roomNameAttempt';
    let hold = true; const held: ServerMessage[] = [], deliver = f.socket.deliver.bind(f.socket);
    t.mock.method(f.socket, 'deliver', (message: ServerMessage) => {
      if (hold && message.type === 'ok' && f.validated.some(request => request.type === command && request.requestId === message.requestId)) { held.push(message); return; }
      deliver(message);
    });
    input.value = '  e\u0301 & <Editor>  '; click(button); const token = element[attempt]; assert.ok(token);
    await f.drain(); assert.equal(held.length, 1); assert.equal(element[attempt], token); assert.equal(button.disabled, true); assert.equal(input.disabled, false); assert.match(accepted.textContent!, /é & <Editor>/);
    input.value = 'Next raw draft'; Object.assign(input, { selectionStart: 1, selectionEnd: 5 }); click(button); await f.drain();
    assert.equal(f.validated.filter(message => message.type === command).length, 1); assert.equal(input.value, 'Next raw draft');
    hold = false; for (const message of held.splice(0)) deliver(message); await f.drain();
    assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-busy'), 'false'); assert.equal(element[attempt], undefined);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 5]);
    input.value = ' '; click(button); await f.drain(); assert.equal(element['error'].hidden, false); assert.equal(input.value, ' '); assert.equal(button.disabled, false);
    input.value = 'Successful retry'; click(button); await f.drain(); assert.equal(element['error'].hidden, true); assert.match(accepted.textContent!, /Successful retry/); assert.equal(f.validated.filter(message => message.type === command).length, 2);
  });

  for (const asController of [true, false]) it(`editor DOM guards repairs corrupted live DOM via legal Hub update controller=${asController}`, async t => {
    const f = await hubCloseWidget(t, false, asController), element = f.element;
    const nameDraft = element['nameInput'].value = 'Preserve personal raw', roomAccepted = element['acceptedRoomName'].textContent;
    if (asController) element['roomNameInput'].value = 'Preserve room raw';
    element['namePanel'].hidden = true; element['nameInput'].disabled = true; element['nameUpdate'].disabled = true; element['nameUpdate'].setAttribute('aria-busy', 'corrupt'); element['acceptedName'].textContent = 'Corrupt accepted';
    element['roomNamePanel'].hidden = !asController; element['roomNameInput'].disabled = asController; element['roomNameUpdate'].disabled = asController; element['roomNameUpdate'].setAttribute('aria-busy', 'corrupt'); element['acceptedRoomName'].textContent = 'Corrupt room accepted';
    if (!asController) { element['roomNamePanel'].hidden = false; element['roomNameInput'].disabled = false; element['roomNameUpdate'].disabled = false; element['roomNameInput'].value = 'Stale retired draft'; }
    const work = f.client.setName('Repair via authoritative state'); await f.drain(); await work;
    assert.equal(element['namePanel'].hidden, false); assert.equal(element['nameInput'].disabled, false); assert.equal(element['nameUpdate'].disabled, false); assert.equal(element['nameUpdate'].getAttribute('aria-busy'), 'false'); assert.equal(element['nameInput'].value, nameDraft); assert.match(element['acceptedName'].textContent!, /Repair via authoritative state/);
    assert.equal(element['roomNamePanel'].hidden, !asController); assert.equal(element['roomNameInput'].disabled, !asController); assert.equal(element['roomNameUpdate'].disabled, !asController); assert.equal(element['roomNameUpdate'].getAttribute('aria-busy'), asController ? 'false' : null); assert.equal(element['roomNameInput'].value, asController ? 'Preserve room raw' : '');
    assert.equal(element['acceptedRoomName'].textContent, roomAccepted);
  });

  for (const editor of ['name', 'roomName'] as const) for (const retired of [false, true]) for (const property of ['hidden', 'input-disabled', 'update-disabled', 'aria-busy'] as const) it(`editor DOM guards retries failed ${editor} ${property} setter retired=${retired}`, async t => {
    const f = await hubCloseWidget(t), element = f.element;
    if (retired) await f.client.disconnect();
    const panel = editor === 'name' ? element['namePanel'] : element['roomNamePanel'];
    const input = editor === 'name' ? element['nameInput'] : element['roomNameInput'];
    const button = editor === 'name' ? element['nameUpdate'] : element['roomNameUpdate'];
    let failed = false, writes = 0;
    if (property === 'aria-busy') {
      if (retired) button.setAttribute('aria-busy', 'corrupt'); else button.removeAttribute('aria-busy');
      const method = retired ? 'removeAttribute' : 'setAttribute', original = button[method];
      Object.defineProperty(button, method, { configurable: true, value: function(...args: unknown[]) {
        if (args[0] === 'aria-busy') {
          writes++;
          if (!failed) { failed = true; throw new Error('Synthetic editor write failure'); }
        }
        return Reflect.apply(original, this, args);
      } });
      t.after(() => { Object.defineProperty(button, method, { configurable: true, value: original }); });
    } else {
      const node = property === 'hidden' ? panel : property === 'input-disabled' ? input : button;
      const key = property === 'hidden' ? 'hidden' : 'disabled'; let value = !retired;
      Object.defineProperty(node, key, { configurable: true, get: () => value, set(next: boolean) {
        writes++;
        if (!failed) { failed = true; throw new Error('Synthetic editor write failure'); } value = next;
      } });
    }
    assert.throws(() => element['render'](), /Synthetic editor write failure/); assert.equal(failed, true); assert.equal(writes, 1);
    element['render'](); assert.equal(writes, 2);
    assert.equal(panel.hidden, retired); assert.equal(input.disabled, retired); assert.equal(button.disabled, retired); assert.equal(button.getAttribute('aria-busy'), retired ? null : 'false');
    element['render'](); assert.equal(writes, 2, 'the successful retry alone makes subsequent equal writes unnecessary');
  });

  for (const action of ['close', 'transfer'] as const) it(`editor DOM guards preserves early ${action} authority notes across editor setter reentry and skipped equal writes`, async t => {
    const f = await hubCloseWidget(t), element = f.element;
    const originalState = structuredClone(f.client.state!), closeOwner = element['roomCloseOwner'], transferOwner = element['stageManagementOwner'];
    const close = t.mock.method(f.client, 'closeRoom', async () => {}), transfer = t.mock.method(f.client, 'transferControl', async () => {});
    const transferAction = transferButton(element, f.host.id), closeAction = element['roomClose'];
    f.holdSnapshots(); f.holdDeltas();
    await f.server.hub.handle(f.session, { type: 'control:transfer', requestId: 'editor-authority-loss', targetId: f.host.id }); await f.drain();
    const loss = f.heldSnapshots.find(message => message.type === 'room:state' && message.me.role !== 'controller'); assert.ok(loss);
    let armed = false, reentered = false;
    controlSetter(t, element['acceptedName'] as unknown as Node, 'textContent', () => {
      if (!armed || reentered) return; reentered = true;
      assert.notEqual(element['roomCloseOwner'], closeOwner, 'old close owner retired before editor text setter'); assert.equal(transferOwner?.transferAwaitingState, true, 'old transfer owner fenced before editor text setter');
      f.client.me!.role = 'controller'; f.client.me!.connected = true;
      click(closeAction); click(transferAction);
    });
    const dialog = t.mock.method(window, 'confirm', () => {
      armed = true; f.socket.deliver(loss); f.socket.deliver({ type: 'room:state', ...originalState }); return true;
    });
    click(action === 'close' ? closeAction : transferAction); await settle();
    assert.equal(reentered, true); assert.equal(dialog.mock.callCount(), 1); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
  });

  it('editor DOM guards retain retirement write order and unconditional draft/text resets', async t => {
    const f = await hubCloseWidget(t), element = f.element;
    await f.client.disconnect();
    for (const editor of ['name', 'roomName'] as const) {
      element[`${editor}Panel`].hidden = false;
      element[`${editor}Input`].disabled = false;
      element[`${editor}Update`].disabled = false;
      element[`${editor}Update`].setAttribute('aria-busy', 'corrupt');
    }
    const meter = instrumentEditors(element); t.after(() => meter.restore());
    element['render']();
    assert.deepEqual(meter.snapshot().writes, ['name', 'roomName'].flatMap(editor => [
      `${editor}Input.value`, `${editor === 'name' ? 'acceptedName' : 'acceptedRoomName'}.textContent`,
      `${editor}Panel.hidden`, `${editor}Update.disabled`, `${editor}Input.disabled`, `${editor}Update.aria-busy`,
    ]));
    meter.reset(); element['render']();
    assert.deepEqual(meter.snapshot().writes, ['nameInput.value', 'acceptedName.textContent', 'roomNameInput.value', 'acceptedRoomName.textContent']);
  });

  for (const editor of ['name', 'roomName'] as const) it(`editor DOM guards evaluate ${editor} disabled and busy at their original setter boundaries`, async t => {
    const f = await hubCloseWidget(t), element = f.element;
    const panel = element[`${editor}Panel`], input = element[`${editor}Input`], button = element[`${editor}Update`];
    const attempt = editor === 'name' ? 'nameAttempt' : 'roomNameAttempt', calls: string[] = [];
    let inspecting = true;
    panel.hidden = true; input.disabled = true; button.disabled = false; button.setAttribute('aria-busy', 'corrupt');
    controlSetter(t, input as unknown as Node, 'disabled', () => {
      if (!inspecting) return;
      assert.equal(panel.hidden, false); calls.push('input'); element[attempt] = {};
    });
    controlSetter(t, button as unknown as Node, 'disabled', () => {
      if (!inspecting) return;
      assert.equal(input.disabled, false); calls.push('update'); element[attempt] = undefined;
    });
    try {
      element['render']();
      assert.deepEqual(calls, ['input', 'update']);
      assert.equal(button.disabled, true, 'disabled observes the attempt created by the preceding input setter');
      assert.equal(button.getAttribute('aria-busy'), 'false', 'busy observes the attempt retired by the preceding update setter');
      assert.equal(element[attempt], undefined);
      element['render'](); assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-busy'), 'false');
    } finally { inspecting = false; }
  });

});

describe('widget room occupancy summary', () => {
  type Widget = InstanceType<typeof StageElement>;
  const text = (room: number, stage: number, audience: number, controllerOnStage: boolean, maxAudience = 300, maxSpeakers = 8, freshness = '最近快照') =>
    `房間席位（${freshness}）：主控以外 ${room} / ${maxAudience} 人，其中台上 ${stage} / ${maxSpeakers} 人、觀眾 ${audience} 人；主控另計 1 人（${controllerOnStage ? '台上' : '台下'}）。含斷線保留席位。`;
  const hidden = (element: Widget) => { assert.equal(element['occupancy'].hidden, true); assert.equal(element['occupancy'].textContent, ''); };
  const shown = (element: Widget, expected: string) => { assert.equal(element['occupancy'].hidden, false); assert.equal(element['occupancy'].textContent, expected); };
  function state(audience = 2, stage = 1, controllerOnStage = true, viewer: 'audience' | 'speaker' | 'controller' = 'audience'): RoomStatePayload {
    const value = roomState(); value.audienceCount = audience;
    value.speakers = Array.from({ length: stage }, (_, i) => ({ ...value.me, participantId: `speaker-${i}`, name: 'Private stage name', role: 'speaker', onStage: true, connected: i !== 0 }));
    const host = { ...value.me, participantId: value.controllerId, name: 'Private controller', role: 'controller' as const, onStage: controllerOnStage };
    if (controllerOnStage) value.speakers.push(host);
    if (viewer === 'controller') { value.me = host; value.audience = [{ ...roomState().me, name: 'SECRET audience <script>' }]; value.code = 'SECRET-CODE'; }
    if (viewer === 'speaker') value.me = value.speakers[0]!;
    value.resumeToken = 'SECRET-TOKEN';
    return value;
  }
  async function receive(client: StageClient, value: RoomStatePayload) { await client['receive']({ type: 'room:state', ...value }); }
  function setter<T extends 'textContent' | 'hidden'>(t: TestContext, node: HTMLParagraphElement, key: T, callback: () => void) {
    let value = node[key];
    Object.defineProperty(node, key, { configurable: true, get: () => value, set(next: typeof value) { value = next; callback(); } });
    t.after(() => Object.defineProperty(node, key, { configurable: true, writable: true, value }));
  }

  it('creates one ordinary private wrapping paragraph and stays empty until an authoritative state', async t => {
    const { element, connections } = deferredJoiningWidget(t); await settle();
    const paragraph = element['occupancy'], node = paragraph as unknown as Node;
    hidden(element); assert.equal(node.tagName, 'P'); assert.equal(node.part.size, 0); assert.equal(node.children.length, 0);
    for (const attr of ['role', 'aria-live', 'tabindex', 'title']) assert.equal(paragraph.hasAttribute(attr), false);
    const all = (item: Node): Node[] => [item, ...item.children.flatMap(all)];
    assert.equal(all(element as unknown as Node).filter(item => item.className === 'room-occupancy').length, 1);
    assert.match(all(element as unknown as Node).find(item => item.tagName === 'STYLE')!.textContent, /\.room-occupancy[^}]*overflow-wrap: anywhere/);
    const client = connections[0]!.client;
    client['setStatus']('live'); element['render'](); hidden(element);
    await receive(client, state()); shown(element, text(3, 1, 2, true)); assert.equal(element['occupancy'], paragraph);
  });

  for (const controllerOnStage of [false, true]) {
    it(`shows the empty valid controller-only room with controllerOnStage=${controllerOnStage}`, async t => {
      const { element, client } = await subscribedWidget(t); const value = state(0, 0, controllerOnStage, 'controller'); value.status = 'waiting';
      await receive(client, value); shown(element, text(0, 0, 0, controllerOnStage));
    });
    for (const viewer of ['audience', 'speaker', 'controller'] as const) it(`shows default maximum seats for ${viewer}, controllerOnStage=${controllerOnStage}, without private data`, async t => {
      const { element, client } = await subscribedWidget(t); const value = state(292, 8, controllerOnStage, viewer);
      value.hands = [{ ...roomState().me, name: 'SECRET hand name', handRaised: true, connected: false }];
      for (const person of [...value.speakers, ...value.hands, ...(value.audience ?? [])]) Object.freeze(person);
      Object.freeze(value.speakers); Object.freeze(value.hands); Object.freeze(value.limits); Object.freeze(value.me);
      if (value.audience) Object.freeze(value.audience);
      const before = JSON.stringify(value), details: unknown[] = [];
      element.addEventListener('stage-state', event => details.push((event as CustomEvent).detail));
      await receive(client, value); shown(element, text(300, 8, 292, controllerOnStage));
      assert.equal(JSON.stringify(value), before); assert.equal(details[0], client.state);
      assert.doesNotMatch(element['occupancy'].textContent!, /SECRET|Private|speaker-|host|script|undefined|NaN|Infinity/);
      assert.deepEqual([...(element['occupancy'] as unknown as Node).attributes], []);
      assert.equal(client.state!.speakers, value.speakers); assert.equal(client.state!.hands, value.hands);
    });
  }

  it('copies validated primitives before forwarding mutable state and ignores non-snapshot deltas', async t => {
    const { element, client } = await subscribedWidget(t); const value = state();
    const rawDetails: unknown[] = [];
    element.addEventListener('stage-state', event => { const detail = (event as CustomEvent<RoomStatePayload>).detail; rawDetails.push(detail); detail.audienceCount = 99; detail.limits.maxAudience = 999; });
    await receive(client, value); shown(element, text(3, 1, 2, true)); assert.equal(rawDetails[0], client.state);
    const messages: ServerMessage[] = [
      { type: 'hand:raise', participantId: 'me' }, { type: 'hand:withdraw', participantId: 'me' },
      { type: 'role:update', participantId: 'me', role: 'speaker' }, { type: 'control:transferred', fromId: 'host', toId: 'me' },
      { type: 'stage:joined', participantId: 'me', role: 'speaker' }, { type: 'stage:left', participantId: 'me', role: 'audience' },
      { type: 'mic:muted', participantId: 'speaker-0' },
      { type: 'speaking', participantIds: ['speaker-0'] }, { type: 'quality', participants: [] },
    ];
    let writes = 0; setter(t, element['occupancy'], 'textContent', () => writes++);
    for (const message of messages) { await client['receive'](message); shown(element, text(3, 1, 2, true)); }
    client['emit']('micerror', { name: 'NotAllowedError', message: 'Synthetic pending capture failure' });
    client['emit']('micready', undefined); element['render'](); shown(element, text(3, 1, 2, true)); assert.equal(writes, 0);
    client['emit']('state', client.state!); shown(element, text(3, 1, 2, true)); assert.equal(writes, 0);
  });

  it('reuses its paragraph and avoids equal writes without changing frames, drafts, errors, busy state or preferences', async t => {
    const f = await socketJoinedWidget(t, state()); const { element, client, socket } = f;
    const paragraph = element['occupancy'], beforeFrames = socket.sent.length;
    const nameDraft = element['nameInput']; nameDraft.value = 'Unsaved name';
    element.playbackMuted = true; element.playbackVolume = 0.37;
    const nameAttempt = {}; element['nameAttempt'] = nameAttempt; element['render']();
    client['emit']('error', { name: 'StageError', code: 'forbidden', message: 'Keep this existing error' });
    const beforeError = element['error'].textContent, beforePending = client['pending'].size;
    let writes = 0; setter(t, paragraph, 'textContent', () => writes++);
    for (let i = 0; i < 8; i++) { await receive(client, state()); client['emit']('quality', { participants: [] }); element['render'](); }
    shown(element, text(3, 1, 2, true)); assert.equal(element['occupancy'], paragraph); assert.equal(writes, 0);
    assert.equal(nameDraft.value, 'Unsaved name'); assert.equal(element['nameAttempt'], nameAttempt); assert.equal(element['nameUpdate'].disabled, true);
    assert.equal(element['nameUpdate'].getAttribute('aria-busy'), 'true'); assert.equal(element['error'].textContent, beforeError);
    assert.equal(element.playbackMuted, true); assert.equal(element.playbackVolume, 0.37); assert.equal(client['pending'].size, beforePending); assert.equal(socket.sent.length, beforeFrames);
    await receive(client, state(1, 2, false)); shown(element, text(3, 2, 1, false)); assert.equal(writes, 1);
  });

  const malformed: [string, (value: RoomStatePayload) => void][] = [];
  for (const cap of ['maxAudience', 'maxSpeakers'] as const) for (const value of [undefined, null, NaN, Infinity, -Infinity, '3', 1.5, -1, 0, Number.MAX_SAFE_INTEGER + 1])
    malformed.push([`${cap}=${String(value)}`, state => { (state.limits as unknown as Record<string, unknown>)[cap] = value; }]);
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '2', 0.5, -1, Number.MAX_SAFE_INTEGER + 1])
    malformed.push([`audience=${String(value)}`, state => { (state as unknown as Record<string, unknown>).audienceCount = value; }]);
  for (const limits of [undefined, null]) malformed.push([`limits=${String(limits)}`, state => { (state as unknown as Record<string, unknown>).limits = limits; }]);
  for (const controllerId of [undefined, null, '', ' ', 1]) malformed.push([`controllerId=${String(controllerId)}`, state => { (state as unknown as Record<string, unknown>).controllerId = controllerId; }]);
  malformed.push(['above room cap', state => { state.limits.maxAudience = 2; }], ['above stage cap', state => { state.limits.maxSpeakers = 1; state.speakers.push({ ...state.speakers[0]!, participantId: 'second-speaker' }); }],
    ['unsafe addition', state => { state.audienceCount = Number.MAX_SAFE_INTEGER; state.limits.maxAudience = Number.MAX_SAFE_INTEGER; }],
    ['duplicate controller', state => { state.speakers.push({ ...state.speakers.at(-1)! }); }],
    ['ambiguous controller', state => { state.speakers[0] = { ...state.speakers[0]!, role: 'controller' }; }],
    ['mismatched controller id', state => { state.controllerId = 'different-controller'; }],
    ['controller id on speaker', state => { state.speakers.at(-1)!.role = 'speaker'; }],
    ['offstage entry', state => { state.speakers[0]!.onStage = false; }]);
  for (const [label, mutate] of malformed) it(`locally hides malformed ${label}, preserves controls and event identity, then recovers on a new state`, async t => {
    const { element, client } = await subscribedWidget(t); await receive(client, state());
    const invalid = state(); mutate(invalid); let forwarded: unknown;
    element.addEventListener('stage-state', event => { forwarded = (event as CustomEvent).detail; });
    const before = structuredClone(invalid); await receive(client, invalid); hidden(element);
    assert.equal(forwarded, client.state); assert.deepEqual(invalid, before); assert.equal(element['hand'].hidden, false); assert.equal(element['hand'].disabled, false);
    assert.equal(element['nameInput'].disabled, false); assert.equal(element['error'].hidden, true);
    element['render'](); hidden(element); await receive(client, state(0, 0, false)); shown(element, text(0, 0, 0, false));
  });

  for (const speakers of [null, undefined, {}, [null], new Array(1)]) it(`locally rejects structural speakers=${JSON.stringify(speakers)} without broad protocol validation`, async t => {
    const { element, client } = await subscribedWidget(t);
    const value = state(); (value as unknown as Record<string, unknown>).speakers = speakers;
    // Existing panels assume protocol-valid arrays; isolate only the private projection under test.
    client['snapshot'] = value; element['syncOccupancy'](value); hidden(element);
    client['snapshot'] = roomState();
  });

  it('accepts state before ACK but retires an unestablished session on socket loss without reviving stale state', async t => {
    const f = socketJoiningWidget(t); await settle(); const socket = f.sockets[0]!; await f.hello(socket); hidden(f.element);
    socket.deliver({ type: 'room:state', ...state(), resumeToken: 'pre-ack' }); const client = f.element.client!, stale = client.state!;
    shown(f.element, text(3, 1, 2, true)); socket.close(); await settle(); assert.equal(client.status, 'disconnected'); hidden(f.element);
    client['setStatus']('live'); client['emit']('state', stale); f.element['render'](); hidden(f.element);
    await f.tick(600); assert.equal(f.sockets.length, 1); hidden(f.element);
  });

  for (const outcome of ['rejected', 'timed out', 'cancelled'] as const) it(`never creates occupancy for an entry ${outcome} before any state`, async t => {
    const f = socketJoiningWidget(t); await settle(); const socket = f.sockets[0]!, request = await f.hello(socket);
    if (outcome === 'rejected') socket.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: '無法加入房間。' });
    else if (outcome === 'cancelled') click(f.element['cancelJoin']);
    else await f.tick(20000);
    await settle(); hidden(f.element); f.element['render'](); hidden(f.element);
  });

  it('keeps exact-owner reconnect counts last through status-only restoration and requires an unseen state to refresh', async t => {
    const f = await socketJoinedWidget(t, state()), stale = f.client.state!;
    f.socket.close(); await settle(); shown(f.element, text(3, 1, 2, true, 300, 8, '重新連線中，上次快照'));
    f.client['emit']('state', stale); f.client['setStatus']('live'); shown(f.element, text(3, 1, 2, true, 300, 8, '上次快照'));
    f.client['emit']('state', stale); f.element['render'](); shown(f.element, text(3, 1, 2, true, 300, 8, '上次快照'));
    await receive(f.client, state(1, 2, false)); shown(f.element, text(3, 2, 1, false));
    f.client['setStatus']('reconnecting'); const ineligible = state(0, 0, false); ineligible.roomId = 'other'; f.client['snapshot'] = ineligible;
    f.client['emit']('state', ineligible); hidden(f.element); f.client['setStatus']('waiting'); f.client['emit']('state', ineligible); hidden(f.element);
    await receive(f.client, state(0, 0, false)); shown(f.element, text(0, 0, 0, false));
  });

  for (const { title, message, event } of terminalCases) it(`clears before ${title} callbacks and rejects stale owner revival`, async t => {
    const f = await socketJoinedWidget(t, state()), stale = f.client.state!; let observed = false;
    f.element.addEventListener(`stage-${event}`, () => {
      observed = true; hidden(f.element); f.client['snapshot'] = stale; f.client['setStatus']('live'); f.client['emit']('state', stale); f.element['render'](); hidden(f.element);
    });
    f.socket.deliver(message); await settle(); await settle(); assert.equal(observed, true); hidden(f.element);
    await receive(f.client, state(0, 0, false)); shown(f.element, text(0, 0, 0, false));
  });

  it('supports direct public SDK disconnect and same-client same-ID fresh rejoin without stale socket revival', async t => {
    const f = await socketJoinedWidget(t, state()); const stale = f.client.state!, oldMessage = f.socket.onmessage;
    f.element.addEventListener('stage-status', event => { if ((event as CustomEvent).detail === 'disconnected') hidden(f.element); });
    await f.client.disconnect(); hidden(f.element);
    const connect = f.client.connect(); await settle(); const socket = f.sockets.at(-1)!; socket.hello(); await connect;
    const joining = f.client.join({ roomId: 'one', name: 'Listener' }); await settle(); await f.tick(100); const request = f.joinRequest(socket);
    hidden(f.element); socket.deliver({ type: 'room:state', ...state(0, 0, false), resumeToken: 'new-session' }); socket.deliver({ type: 'ok', requestId: request.requestId }); await joining;
    shown(f.element, text(0, 0, 0, false)); oldMessage?.({ data: JSON.stringify({ type: 'room:state', ...stale }) }); shown(f.element, text(0, 0, 0, false));
  });

  for (const transition of ['room', 'name', 'manual leave', 'unmount'] as const) it(`clears synchronously for ${transition} and permits only the replacement ownership`, async t => {
    const f = await socketJoinedWidget(t, state()); const old = f.client, stale = old.state!;
    if (transition === 'room' || transition === 'name') f.element.setAttribute(transition, 'replacement');
    else if (transition === 'manual leave') click(f.element['roomAction']);
    else { Object.assign(f.element, { isConnected: false }); f.element.disconnectedCallback(); }
    hidden(f.element); await settle(); old['emit']('state', stale); old['emit']('status', 'live'); hidden(f.element);
    if (transition === 'manual leave') { await settle(); click(f.element['roomAction']); }
    if (transition === 'unmount') { Object.assign(f.element, { isConnected: true }); f.element.connectedCallback(); }
    await settle(); const socket = f.sockets.at(-1)!, request = await f.hello(socket), next = state(1, 0, false); if (transition === 'room') next.roomId = 'replacement';
    socket.deliver({ type: 'room:state', ...next }); socket.deliver({ type: 'ok', requestId: request.requestId }); await settle(); shown(f.element, text(1, 0, 1, false));
    old['emit']('state', stale); f.socket.deliver({ type: 'room:state', ...stale }); shown(f.element, text(1, 0, 1, false));
  });

  for (const event of ['state', 'status'] as const) for (const transition of ['disconnect', 'room', 'unmount'] as const)
    it(`does not resurrect after reentrant stage-${event} ${transition}`, async t => {
      const f = await socketJoinedWidget(t, state()); let acted = false;
      f.element.addEventListener(`stage-${event}`, () => {
        if (acted) return; acted = true;
        if (transition === 'disconnect') void f.client.disconnect();
        else if (transition === 'room') f.element.setAttribute('room', 'replacement');
        else { Object.assign(f.element, { isConnected: false }); f.element.disconnectedCallback(); }
        hidden(f.element);
      });
      const next = state(1, 0, false); next.status = event === 'status' ? 'waiting' : 'live'; await receive(f.client, next); await settle(); assert.equal(acted, true); hidden(f.element);
    });

  for (const key of ['textContent', 'hidden'] as const) for (const transition of ['unmount', 'new state'] as const)
    it(`fences ${key} setter reentry that installs ${transition}`, async t => {
      const { element, client } = await subscribedWidget(t); let acted = false;
      if (key === 'hidden') { client['emit']('closed', { roomId: 'one' }); hidden(element); }
      setter(t, element['occupancy'], key, () => {
        if (acted) return; acted = true;
        if (transition === 'unmount') { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
        else void receive(client, state(0, 0, false));
      });
      await receive(client, state()); await settle(); assert.equal(acted, true);
      if (transition === 'unmount') hidden(element); else shown(element, text(0, 0, 0, false));
    });

async function occupancyHub(t: TestContext, maxSpeakers = 1, maxAudience = 3) {
  let room: Room | undefined;
  const original = Room.prototype.sharedSnapshot;
  t.mock.method(Room.prototype, 'sharedSnapshot', function(this: Room) { room = this; return original.call(this); });
  const config = testConfig(c => { c.limits.maxSpeakersPerRoom = maxSpeakers; c.limits.maxAudiencePerRoom = maxAudience;
    c.limits.controlPerSecond = 2000; c.limits.handRaiseIntervalMs = 0; c.rooms.participantGraceMs = 15000;
    c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 0; });
  const h = harness(config);
  t.after(async () => { await h.hub.shutdown(); await h.transport.close(); assert.equal(h.timers.filter(timer => !timer.cleared).length, 0); });
  const host = await h.create('Hidden host', { codeRequired: false });
  const fixture = socketJoiningWidget(t, { room: host.roomId });
  await settle(); const socket = fixture.sockets[0]!;
  const session = new FakeSession(); h.hub.attach(session);
  socket.readyState = 1; socket.deliver(session.last('hello')!); await settle(); await fixture.tick(0);
  let sessionRead = session.inbox.length;
  const deliver = () => { for (const event of session.inbox.slice(sessionRead)) socket.deliver(event); sessionRead = session.inbox.length; };
  const parsedFrames: string[] = [];
  async function validated(s: FakeSession, message: ClientMessage) {
    const parsed = parseClientMessage(JSON.stringify(message), config.limits); parsedFrames.push(parsed.type);
    await h.hub.handle(s, parsed);
    for (const timer of h.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); }
    deliver(); await settle();
    const requestId = 'requestId' in message ? message.requestId : undefined;
    return [...s.inbox].reverse().find(event => (event.type === 'ok' || event.type === 'error') && event.requestId === requestId);
  }
  await validated(session, fixture.joinRequest(socket));
  const client = fixture.element.client!; assert.ok(client.state); assert.ok(room);
  let requestId = 1000;
  async function server(s: FakeSession, message: object) { return validated(s, { ...message, requestId: `probe-${requestId++}` } as ClientMessage); }
  async function command(type: string, action: () => Promise<void>, expected = 'ok') {
    const start = socket.sent.length; const work = action().then(() => 'ok', error => error.code);
    await fixture.tick(100);
    const frame = socket.sent.slice(start).find(event => event.type === type); assert.ok(frame, `SDK emitted ${type}`);
    const reply = await validated(session, frame); assert.ok(reply);
    assert.equal(await work, expected);
    return reply;
  }
  function counts() {
    const state = client.state!; assert.ok(state);
    const members = [...room!.participants.values()];
    const speakerGuests = state.speakers.filter(person => person.role !== 'controller').length;
    const controllerOnStage = state.speakers.some(person => person.role === 'controller');
    assert.equal(speakerGuests, members.filter(person => person.role === 'speaker').length);
    assert.equal(state.audienceCount, members.filter(person => person.role === 'audience').length);
    assert.equal(state.audienceCount + speakerGuests, members.length - 1);
    assert.equal(controllerOnStage, room!.get(room!.controllerId)!.onStage);
    assert.ok(speakerGuests <= state.limits.maxSpeakers);
    assert.ok(state.audienceCount + speakerGuests <= state.limits.maxAudience);
    shown(fixture.element, text(members.length - 1, speakerGuests, state.audienceCount, controllerOnStage, state.limits.maxAudience, state.limits.maxSpeakers));
    return [speakerGuests, state.audienceCount, members.length - 1, Number(controllerOnStage)];
  }
  return { ...fixture, socket, client, session, h, host, config, room: room!, command, server, deliver, counts, parsedFrames };
}

  it('SDK → validator → Hub proves offstage controller exclusion, asymmetrical caps, hand and stage boundaries', async t => {
    const f = await occupancyHub(t); const { client, h, host, command, server } = f;
    const extra = await h.join(host.roomId, '', 'Hidden guest');
    const hand = await h.join(host.roomId, '', 'Hidden request'); f.deliver(); await settle();
    assert.deepEqual(f.counts(), [0, 3, 3, 1]);
    await server(host.s, { type: 'stage:leave' }); assert.deepEqual(f.counts(), [0, 3, 3, 0]);
    await server(host.s, { type: 'control:transfer', targetId: client.me!.participantId });
    assert.deepEqual(f.counts(), [0, 3, 3, 0]);
    await command('stage:approve', () => client.returnToStage()); assert.deepEqual(f.counts(), [0, 3, 3, 1]);
    await server(extra.s, { type: 'hand:raise' }); assert.deepEqual(f.counts(), [0, 3, 3, 1]);
    await command('stage:approve', () => client.approve(extra.id)); assert.deepEqual(f.counts(), [1, 2, 3, 1]);
    await server(hand.s, { type: 'hand:raise' }); assert.deepEqual(f.counts(), [1, 2, 3, 1]);
    await command('stage:approve', () => client.approve(hand.id), 'stage_full');
    const overflow = new FakeSession(); h.hub.attach(overflow);
    const roomFull = await server(overflow, { type: 'join', roomId: host.roomId, name: 'Overflow' });
    assert.equal(roomFull!.type, 'error'); assert.equal((roomFull as { code: string }).code, 'room_full');
    assert.equal(client.state!.audienceCount, 2, 'room full despite audience 2 < maxAudience 3');
    assert.equal(client.state!.speakers.length, 2, 'two on-stage seats despite maxSpeakers 1: controller seat is extra');
    await command('stage:leave', () => client.leaveStage()); assert.deepEqual(f.counts(), [1, 2, 3, 0]);
    await command('stage:approve', () => client.returnToStage()); assert.deepEqual(f.counts(), [1, 2, 3, 1]);
    await command('stage:remove', () => client.removeFromStage(extra.id)); assert.deepEqual(f.counts(), [0, 3, 3, 1]);
    assert.ok(f.parsedFrames.includes('stage:approve') && f.parsedFrames.includes('stage:leave'));
    assert.equal(client['pending'].size, 0);
  });

  it('held offline audience, hands, speaker and controller retain seats; resume does not add a member; expiry removes', async t => {
    const f = await occupancyHub(t); const { h, host, client, command, server } = f;
    const guest = await h.join(host.roomId, '', 'Held member'); f.deliver(); await settle();
    const token = guest.s.last('room:state')!.resumeToken!;
    await command('hand:raise', () => client.raiseHand()); assert.deepEqual(f.counts(), [0, 2, 2, 1]);
    await command('hand:withdraw', () => client.withdrawHand()); assert.deepEqual(f.counts(), [0, 2, 2, 1]);
    await server(guest.s, { type: 'hand:raise' });
    await h.hub.detach(guest.s); f.deliver(); await settle(); assert.deepEqual(f.counts(), [0, 2, 2, 1]);
    assert.equal(client.state!.hands[0]!.connected, false);
    const resumed = new FakeSession(); h.hub.attach(resumed);
    await server(resumed, { type: 'join', roomId: host.roomId, name: 'Held member', resumeToken: token });
    assert.equal(resumed.last('room:state')!.me.participantId, guest.id); assert.deepEqual(f.counts(), [0, 2, 2, 1]);
    await server(host.s, { type: 'stage:approve', targetId: guest.id }); assert.deepEqual(f.counts(), [1, 1, 2, 1]);
    await h.hub.detach(resumed); f.deliver(); await settle(); assert.deepEqual(f.counts(), [1, 1, 2, 1]);
    assert.equal(client.state!.speakers.find(p => p.participantId === guest.id)!.connected, false);
    await h.hub.detach(host.s); f.deliver(); await settle(); assert.deepEqual(f.counts(), [1, 1, 2, 1]);
    assert.equal(client.state!.speakers.find(p => p.role === 'controller')!.connected, false);
    const expiry = h.timers.find(timer => !timer.cleared && timer.ms === 15000)!;
    expiry.cleared = true; expiry.fn(); await nextTurn(); f.deliver(); await settle(); assert.deepEqual(f.counts(), [0, 1, 1, 1]);
    const controllerExpiry = h.timers.find(timer => !timer.cleared && timer.ms === f.config.rooms.controllerGraceMs)!;
    controllerExpiry.cleared = true; controllerExpiry.fn(); await nextTurn(); f.deliver(); await settle();
    assert.equal(client.me!.role, 'controller'); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
  });

  it('control transfer changes which stage seat is capped, while total room membership stays fixed', async t => {
    const f = await occupancyHub(t, 2, 3); const { h, host, client, server, command } = f;
    const guest = await h.join(host.roomId, '', 'Other'); f.deliver(); await settle();
    await server(host.s, { type: 'control:transfer', targetId: client.me!.participantId }); assert.deepEqual(f.counts(), [1, 1, 2, 0]);
    await command('stage:approve', () => client.returnToStage()); assert.deepEqual(f.counts(), [1, 1, 2, 1]);
    await command('control:transfer', () => client.transferControl(guest.id)); assert.deepEqual(f.counts(), [2, 0, 2, 0]);
    await command('stage:leave', () => client.leaveStage()); assert.deepEqual(f.counts(), [1, 1, 2, 0]);
    await server(guest.s, { type: 'stage:approve', targetId: guest.id }); assert.deepEqual(f.counts(), [1, 1, 2, 1]);
  });

  it('SDK reconnect → validated Hub resume preserves seat and clears before actual Hub terminal callbacks', async t => {
    const f = await occupancyHub(t); const before = f.client.state!;
    await f.h.hub.detach(f.session);
    f.socket.close(); await settle(); assert.equal(f.client.status, 'reconnecting'); assert.equal(f.client.state, before);
    shown(f.element, text(1, 0, 1, true, 3, 1, '重新連線中，上次快照'));
    await f.tick(500); const resumeSocket = f.sockets.at(-1)!; assert.notEqual(resumeSocket, f.socket);
    await f.hello(resumeSocket); const request = f.joinRequest(resumeSocket);
    assert.equal(request.resumeToken, before.resumeToken);
    const resumed = new FakeSession(); f.h.hub.attach(resumed);
    let received = resumed.inbox.length;
    await f.h.hub.handle(resumed, parseClientMessage(JSON.stringify(request), f.config.limits));
    const resumeReplies = resumed.inbox.slice(received);
    assert.ok(resumeReplies.findIndex(event => event.type === 'room:state') < resumeReplies.findIndex(event => event.type === 'ok'));
    for (const event of resumeReplies) resumeSocket.deliver(event);
    received = resumed.inbox.length; await settle(); await settle();
    assert.equal(f.client.me!.participantId, before.me.participantId); assert.notEqual(f.client.state, before);
    assert.deepEqual(f.counts(), [0, 1, 1, 1]);
    assert.equal(f.h.timers.filter(timer => !timer.cleared && timer.ms === 15000).length, 0);
    let observed = false;
    f.element.addEventListener('stage-closed', () => { observed = true; hidden(f.element); assert.equal(f.client.state, null); assert.equal(f.client.status, 'disconnected'); });
    await f.server(f.host.s, { type: 'room:close' });
    for (const event of resumed.inbox.slice(received)) resumeSocket.deliver(event);
    await settle(); await settle(); assert.equal(observed, true);
  });
  for (const controllerOnStage of [false, true]) for (const targetOnStage of [false, true])
    it(`actual Hub transfer recomputes only its authoritative state, controllerOnStage=${controllerOnStage}, targetOnStage=${targetOnStage}`, async t => {
      const f = await occupancyHub(t, 2, 3), target = f.client.me!.participantId;
      if (!controllerOnStage) await f.server(f.host.s, { type: 'stage:leave' });
      if (targetOnStage) { await f.command('hand:raise', () => f.client.raiseHand()); await f.server(f.host.s, { type: 'stage:approve', targetId: target }); }
      f.counts(); const oldText = f.element['occupancy'].textContent; let deltas = 0;
      for (const event of ['stage-role', 'stage-transferred']) f.element.addEventListener(event, () => { deltas++; assert.equal(f.element['occupancy'].textContent, oldText); });
      await f.server(f.host.s, { type: 'control:transfer', targetId: target });
      assert.ok(deltas > 0); assert.equal(f.client.me!.role, 'controller');
      assert.deepEqual(f.counts(), [Number(controllerOnStage), Number(!controllerOnStage), 1, Number(targetOnStage)]);
    });

  it('keeps actual Hub stage_full rejection for an onstage-controller to offstage-target transfer at the stage cap', async t => {
    const f = await occupancyHub(t), speaker = await f.h.join(f.host.roomId, '', 'Other speaker'); f.deliver(); await settle();
    await f.server(speaker.s, { type: 'hand:raise' }); await f.server(f.host.s, { type: 'stage:approve', targetId: speaker.id }); f.counts();
    const before = f.element['occupancy'].textContent, reply = await f.server(f.host.s, { type: 'control:transfer', targetId: f.client.me!.participantId });
    assert.equal(reply?.type, 'error'); assert.equal((reply as { code: string }).code, 'stage_full'); assert.equal(f.element['occupancy'].textContent, before); f.counts();
  });

  it('actual Hub private controller audience and offstage seat stay separate while rejection, explicit leave and kick change only snapshots', async t => {
    const f = await occupancyHub(t), guest = await f.h.join(f.host.roomId, '', 'SECRET guest'); f.deliver(); await settle(); f.counts();
    await f.server(f.host.s, { type: 'control:transfer', targetId: f.client.me!.participantId }); f.counts();
    assert.ok(f.client.state!.audience); assert.equal(f.client.me!.onStage, false); assert.doesNotMatch(f.element['occupancy'].textContent!, /SECRET|Private|host|speaker/);
    await f.server(guest.s, { type: 'hand:raise' }); const before = f.element['occupancy'].textContent;
    await f.command('stage:reject', () => f.client.reject(guest.id)); assert.equal(f.element['occupancy'].textContent, before); f.counts();
    await f.h.hub.detach(guest.s, true); f.deliver(); await settle(); assert.deepEqual(f.counts(), [1, 0, 1, 0]);
    const replacement = await f.h.join(f.host.roomId, '', 'Replacement'); f.deliver(); await settle(); f.counts();
    await f.command('participant:kick', () => f.client.kick(replacement.id)); assert.deepEqual(f.counts(), [1, 0, 1, 0]);
    let terminal = false; f.element.addEventListener('stage-closed', () => { terminal = true; hidden(f.element); });
    await f.h.hub.shutdown(); f.deliver(); await settle(); assert.equal(terminal, true); hidden(f.element);
  });

  for (const field of ['roomId', 'participantId', 'status'] as const) for (const key of ['textContent', 'hidden'] as const)
    it(`revalidates ${key} setter direct ${field} mutation before forwarding state`, async t => {
      const { element, client } = await subscribedWidget(t); let armed = true;
      if (key === 'hidden') client['emit']('closed', { roomId: 'one' });
      setter(t, element['occupancy'], key, () => {
        if (!armed) return; armed = false;
        if (field === 'roomId') client.state!.roomId = 'changed-directly';
        else if (field === 'participantId') client.state!.me.participantId = 'changed-directly';
        else client['currentStatus'] = 'disconnected';
      });
      let observed = false; element.addEventListener('stage-state', () => { observed = true; hidden(element); });
      await receive(client, state()); assert.equal(observed, true); assert.equal(armed, false); hidden(element);
    });

  for (const event of ['role', 'transferred'] as const) it(`preserves early close and transfer authority fences before occupancy setter during ${event}`, async t => {
    const { element, client } = await subscribedWidget(t); const value = state(1, 1, true, 'controller'); value.speakers[0]!.connected = true;
    await receive(client, value); const close = t.mock.method(client, 'closeRoom', async () => {}), transfer = t.mock.method(client, 'transferControl', async () => {});
    const confirm = t.mock.method(window, 'confirm', () => true), row = element['stageManagementRows'].get('speaker-0')!;
    element['occupancy'].textContent = 'Corrupted summary'; let acted = false;
    setter(t, element['occupancy'], 'textContent', () => { if (acted) return; acted = true; click(element['roomClose']); click(row.transfer); });
    if (event === 'role') client['emit']('role', { participantId: 'host', role: 'speaker' });
    else client['emit']('transferred', { fromId: 'host', toId: 'speaker-0' });
    assert.equal(acted, true); assert.equal(confirm.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
  });

  it('preserves accepted gain, its draft and pending moderation while counts change', async t => {
    const { element, client } = await subscribedWidget(t); await receive(client, state(2, 1, true, 'controller'));
    const row = element['stageManagementRows'].get('speaker-0')!, pending = {};
    row.gainInput.value = '1.25'; element['stageManagementPending'].set('speaker-0', pending); element['render']();
    const draft = row.gainInput.value, accepted = row.gainAccepted.textContent, disabled = row.gainInput.disabled, busy = row.gainApply.getAttribute('aria-busy');
    await receive(client, state(1, 1, true, 'controller')); shown(element, text(2, 1, 1, true));
    assert.equal(element['stageManagementRows'].get('speaker-0'), row); assert.equal(row.gainInput.value, draft); assert.equal(row.gainAccepted.textContent, accepted);
    assert.equal(row.gainInput.disabled, disabled); assert.equal(row.gainApply.getAttribute('aria-busy'), busy); assert.equal(element['stageManagementPending'].get('speaker-0'), pending);
  });

  it('retires ownership before manual-leave error setter reentry and clears before a different panel forwards mutated ownership', async t => {
    const f = await socketJoinedWidget(t, state()); let leaving = false;
    setter(t, f.element['error'], 'hidden', () => { if (leaving) assert.equal(f.element['occupancyOwner'], undefined); });
    leaving = true; click(f.element['roomAction']); hidden(f.element); leaving = false; await settle();
    click(f.element['roomAction']); await settle(); const socket = f.sockets.at(-1)!, request = await f.hello(socket);
    socket.deliver({ type: 'room:state', ...state() }); socket.deliver({ type: 'ok', requestId: request.requestId }); await settle();
    const client = f.element.client!; let armed = true, observed = false;
    setter(t, f.element['acceptedName'] as HTMLParagraphElement, 'textContent', () => { if (armed) { armed = false; client.state!.roomId = 'mutated-in-name-setter'; } });
    f.element.addEventListener('stage-state', () => { observed = true; hidden(f.element); });
    const next = state(); next.me.name = 'Another accepted name'; await receive(client, next); assert.equal(observed, true); hidden(f.element);
  });

  it('keeps stage seats during real SDK failed and pending capture without summary-triggered requests, timers or media work', async t => {
    const descriptors = new Map(['navigator', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const captures: { promise: Promise<MediaStream>; reject: (error: unknown) => void }[] = [];
    class Peer {
      connectionState = 'connected'; signalingState = 'stable'; localDescription = null;
      transceiver = { direction: 'recvonly', sender: { replaceTrack: async () => {} } };
      addTransceiver() { return this.transceiver; } close() {}
    }
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => {
      let reject!: (error: unknown) => void; const promise = new Promise<MediaStream>((_, no) => { reject = no; }); captures.push({ promise, reject });
      if (captures.length === 1) reject(new DOMException('Controlled denied capture', 'NotAllowedError'));
      return promise;
    } } } });
    t.mock.method(StageClient.prototype as unknown as { negotiate(): void }, 'negotiate', () => {});
    t.after(async () => { for (const capture of captures) capture.reject(new DOMException('Cleanup', 'AbortError')); await settle(); for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
    const f = await socketJoinedWidget(t, state(1, 1, true, 'speaker'), true); await f.client['mediaTask'];
    assert.equal(captures.length, 1); assert.equal(f.client['micFailed'], true); shown(f.element, text(2, 1, 1, true));
    click(f.element['micRetry']); await settle(); assert.equal(captures.length, 2); assert.equal(f.element['micRetry'].disabled, true);
    const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
    const frames = [...f.socket.sent], pending = f.client['pending'].size, owner = f.element['micFailure'];
    for (let i = 0; i < 3; i++) { await receive(f.client, state(2, 1, true, 'speaker')); f.element['render'](); shown(f.element, text(3, 1, 2, true)); }
    assert.equal(captures.length, 2); assert.equal(f.element['micFailure'], owner); assert.equal(f.element['micRetry'].disabled, true);
    assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0); assert.deepEqual(f.socket.sent, frames); assert.equal(f.client['pending'].size, pending);
    captures[1]!.reject(new DOMException('Controlled capture failure', 'NotFoundError')); await f.client['mediaTask']; shown(f.element, text(3, 1, 2, true));
  });

  for (const key of ['hidden', 'textContent'] as const) for (const action of ['close', 'transfer'] as const)
    it(`does not introduce ${action} admission from the summary ${key} setter during manual leave`, async t => {
      const { element, client } = await subscribedWidget(t); const value = state(1, 1, true, 'controller'); value.speakers[0]!.connected = true;
      await receive(client, value); const row = element['stageManagementRows'].get('speaker-0')!;
      const close = t.mock.method(client, 'closeRoom', async () => {}), transfer = t.mock.method(client, 'transferControl', async () => {}), confirm = t.mock.method(window, 'confirm', () => true);
      let acted = false; setter(t, element['occupancy'], key, () => { if (acted) return; acted = true; click(action === 'close' ? element['roomClose'] : row.transfer); });
      click(element['roomAction']); await settle(); assert.equal(acted, true); hidden(element);
      assert.equal(confirm.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
    });
});

/** Complete widget and SDK regression coverage; controlled DOM does not model browser paint or audio. */
describe('widget own quality observation window', () => {
  const report = (rttMs = 46) => ({ participants: [{ participantId: 'me', rttMs }] });
  const emit = (client: StageClient, type: string, detail: unknown) => client.dispatchEvent(new CustomEvent(type, { detail }));
  const view = (element: InstanceType<typeof StageElement>) => ({ hidden: element['quality'].hidden, text: element['quality'].textContent });
  function hidden(element: InstanceType<typeof StageElement>): void { assert.deepEqual(view(element), { hidden: true, text: '' }); }
  function shown(element: InstanceType<typeof StageElement>, rtt = 46): void { assert.equal(view(element).hidden, false); assert.match(view(element).text, new RegExp(`RTT ${rtt} ms`)); }
  const state = async (client: StageClient, value = roomState(true)) => { await client['receive']({ type: 'room:state', ...value }); return client.state!; };
  function setter(node: object, property: string, action: () => void): () => void {
    let value = Reflect.get(node, property), armed = true;
    Object.defineProperty(node, property, { configurable: true, get: () => value, set: next => { value = next; if (armed) { armed = false; action(); } } });
    return () => { Object.defineProperty(node, property, { configurable: true, writable: true, value }); };
  }


  for (const boundary of ['role', 'stageleft', 'reconnect', 'terminal'] as const) {
    it(`${boundary} requires unseen current state, and records new reports rejected before it`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const accepted = report(46), rejected = report(88), oldState = client.state!;
      emit(client, 'quality', accepted); shown(element);
      if (boundary === 'role') emit(client, 'role', { participantId: 'me', role: 'audience' });
      else if (boundary === 'stageleft') emit(client, 'stageleft', { participantId: 'me' });
      else if (boundary === 'terminal') emit(client, 'closed', { roomId: 'one' });
      else client['setStatus']('reconnecting');
      hidden(element);
      client['setStatus']('live');
      emit(client, 'quality', rejected); hidden(element);
      emit(client, 'state', oldState); emit(client, 'quality', report(99)); hidden(element);
      await state(client); emit(client, 'quality', accepted); hidden(element);
      emit(client, 'quality', rejected); hidden(element);
      emit(client, 'quality', report(123)); shown(element, 123);
    });
  }

  it('a state identity first rejected during reconnect cannot reopen after status-only recovery', async t => {
    const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report());
    client['setStatus']('reconnecting');
    const rejected = roomState(true); client['snapshot'] = rejected; emit(client, 'state', rejected); hidden(element);
    client['setStatus']('live'); emit(client, 'state', rejected); emit(client, 'quality', report(77)); hidden(element);
    await state(client); emit(client, 'quality', report(78)); shown(element, 78);
  });

  it('an unseen noncurrent state event is consumed, not retained for later owner admission', async t => {
    const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report());
    emit(client, 'stageleft', { participantId: 'me' });
    const rejected = roomState(true); emit(client, 'state', rejected); hidden(element);
    client['snapshot'] = rejected; emit(client, 'state', rejected); emit(client, 'quality', report(79)); hidden(element);
    await state(client); emit(client, 'quality', report(80)); shown(element, 80);
  });

  it('SDK status-before-state cannot admit a receipt before the replacement state event', async t => {
    const { element, client } = await subscribedWidget(t, true); const rejected = report(97);
    client['setStatus']('reconnecting'); let observed: ReturnType<typeof view> | undefined;
    element.addEventListener('stage-status', event => {
      if ((event as CustomEvent).detail === 'live') { emit(client, 'quality', rejected); observed = view(element); }
    }, { once: true });
    await state(client); assert.deepEqual(observed, { hidden: true, text: '' }); hidden(element);
    emit(client, 'quality', rejected); hidden(element);
    emit(client, 'quality', report(98)); shown(element, 98);
  });

  it('micerror clears the receipt without requiring a new authoritative state', async t => {
    const { element, client } = await subscribedWidget(t, true); const accepted = report(); emit(client, 'quality', accepted);
    emit(client, 'micerror', { name: 'NotAllowedError', message: 'Unavailable' }); hidden(element);
    emit(client, 'micready', undefined); emit(client, 'quality', accepted); hidden(element);
    emit(client, 'quality', report(81)); shown(element, 81);
  });

  it('preserves baseline onstage admission despite retained disconnected flag', async t => {
    const { element, client } = await subscribedWidget(t, true);
    const next = roomState(true); next.me.connected = false;
    await state(client, next); emit(client, 'quality', report(90)); shown(element, 90);
  });

  it('replaying accepted quality identity cannot overwrite newer same-owner metrics', async t => {
    const { element, client } = await subscribedWidget(t, true); const old = report(91);
    emit(client, 'quality', old); emit(client, 'quality', report(92)); shown(element, 92);
    old.participants[0]!.rttMs = 999; emit(client, 'quality', old); shown(element, 92);
  });

  it('same-owner state and stage-preserving role transfer preserve copied whole last-own-entry policy', async t => {
    const { element, client } = await subscribedWidget(t, true);
    const detail = { participants: [{ participantId: 'me', rttMs: 1 }, { participantId: 'me', downlinkLossPercent: 0 }] };
    let forwarded: unknown; element.addEventListener('stage-quality', event => { forwarded = (event as CustomEvent).detail; }, { once: true });
    emit(client, 'quality', detail); assert.equal(forwarded, detail);
    const original = view(element); assert.match(original.text, /下行掉包 0.0% · RTT —/);
    detail.participants[1]!.downlinkLossPercent = 99;
    await state(client); emit(client, 'role', { participantId: 'me', role: 'controller' });
    emit(client, 'transferred', { fromId: 'host', toId: 'me' }); emit(client, 'stageleft', { participantId: 'other' });
    assert.deepEqual(view(element), original);
  });

  for (const property of ['hidden', 'textContent']) {
    it(`quality ${property} setter cannot restore a retired receipt after nested ownership loss`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const pending = report(82); let calls = 0;
      const restore = setter(element['quality'], property, () => {
        calls++; emit(client, 'stageleft', { participantId: 'me' });
        emit(client, 'quality', pending);
      }); t.after(restore);
      emit(client, 'quality', pending); assert.equal(calls, 1); hidden(element);
      await state(client); emit(client, 'quality', pending); hidden(element);
      emit(client, 'quality', report(83)); shown(element, 83);
    });

    it(`quality ${property} setter keeps newer nested same-owner metrics`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const restore = setter(element['quality'], property, () => emit(client, 'quality', report(85))); t.after(restore);
      emit(client, 'quality', report(84)); shown(element, 85);
    });
  }

  for (const property of ['hidden', 'textContent']) {
    it(`quality ${property} setter reconciles a silent ownership loss after completing a newer nested report`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const restore = setter(element['quality'], property, () => { emit(client, 'quality', report(94)); client.state!.me.onStage = false; }); t.after(restore);
      emit(client, 'quality', report(93)); hidden(element);
      client.state!.me.onStage = true; emit(client, 'quality', report(95)); hidden(element);
      await state(client); emit(client, 'quality', report(96)); shown(element, 96);
    });
  }

  it('forwarded quality mutation of current authority is reconciled without another event', async t => {
    const { element, client } = await subscribedWidget(t, true);
    element.addEventListener('stage-quality', () => { client.state!.me.onStage = false; }, { once: true });
    emit(client, 'quality', report(86)); hidden(element);
    client.state!.me.onStage = true; emit(client, 'quality', report(87)); hidden(element);
    await state(client); emit(client, 'quality', report(88)); shown(element, 88);
  });

  it('equal-value quality updates preserve baseline removal of host-added same-text descendants', async t => {
    const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report(89));
    const node = element['quality'] as unknown as Node; let value = node.textContent, writes = 0;
    node.children.push(new Node());
    Object.defineProperty(node, 'textContent', { configurable: true, get: () => value, set: next => { value = next; writes++; node.children.splice(0); } });
    t.after(() => Object.defineProperty(node, 'textContent', { configurable: true, writable: true, value }));
    emit(client, 'quality', report(89)); shown(element, 89);
    assert.ok(writes > 0); assert.equal(node.children.length, 0);
  });

  for (const key of ['hidden', 'textContent']) {
    it(`own-role loss fences close and transfer before quality ${key} setter reentry`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const value = roomState(true); value.me.role = 'controller'; value.controllerId = 'me';
      const target = { ...value.me, participantId: 'target', role: 'speaker' as const }; value.speakers = [value.me, target];
      await state(client, value); emit(client, 'quality', report());
      const row = element['stageManagementRows'].get('target')!; assert.ok(row);
      const close = t.mock.method(client, 'closeRoom', async () => {}), transfer = t.mock.method(client, 'transferControl', async () => {});
      const confirm = t.mock.method(window, 'confirm', () => true);
      let calls = 0; const restore = setter(element['quality'], key, () => { calls++; click(element['roomClose']); click(row.transfer); }); t.after(restore);
      emit(client, 'role', { participantId: 'me', role: 'audience' }); hidden(element);
      assert.equal(calls, 1); assert.equal(confirm.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
    });

    it(`manual leave fences close and transfer before quality ${key} setter reentry`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const value = roomState(true); value.me.role = 'controller'; value.controllerId = 'me';
      const target = { ...value.me, participantId: 'target', role: 'speaker' as const }; value.speakers = [value.me, target];
      await state(client, value); emit(client, 'quality', report());
      const row = element['stageManagementRows'].get('target')!; assert.ok(row);
      const close = t.mock.method(client, 'closeRoom', async () => {}), transfer = t.mock.method(client, 'transferControl', async () => {});
      const confirm = t.mock.method(window, 'confirm', () => true);
      let calls = 0; const restore = setter(element['quality'], key, () => { calls++; click(element['roomClose']); click(row.transfer); }); t.after(restore);
      click(element['roomAction']); await settle(); hidden(element);
      assert.equal(calls, 1); assert.equal(confirm.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
    });
  }

  for (const transition of ['speaker leave', 'controller removal', 'controller leave'] as const) {
    it(`actual Hub ${transition} retires before every pre-state callback and only new state plus new quality reopens`, async t => {
      const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; });
      const h = harness(config); t.after(async () => { await h.hub.shutdown(); });
      const host = await h.create(), speaker = await h.join(host.roomId, host.code, 'Speaker');
      assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
      assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
      assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
      assert.equal(await h.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
      const own = transition === 'controller leave' ? host : speaker;
      const { element, client, socket } = await socketJoinedWidget(t, own.s.last('room:state')!);
      h.transport.getStats = async () => ({ inbound: { packetsReceived: 988, packetsLost: 12 }, outbound: { fractionLost: 0.035 }, rttMs: 46 });
      const timer = h.timers.find(timer => !timer.cleared && timer.ms === config.rooms.qualityIntervalMs)!;
      assert.ok(timer); timer.cleared = true; timer.fn(); await nextTurn();
      const wireReport = own.s.last('quality'); assert.ok(wireReport);
      let accepted: unknown;
      element.addEventListener('stage-quality', event => { accepted = (event as CustomEvent).detail; }, { once: true });
      socket.deliver(wireReport); shown(element);
      const retained = client.state!, rejected = { participants: [{ participantId: own.id, rttMs: 88 }] };
      let callbacks = 0;
      const observe = () => {
        callbacks++; assert.equal(client.me!.onStage, true); hidden(element);
        for (const detail of [accepted, rejected, { participants: [{ participantId: own.id, rttMs: 89 }] }]) {
          emit(client, 'quality', detail); hidden(element);
        }
        emit(client, 'state', retained); emit(client, 'stagejoined', { participantId: own.id, role: 'speaker' });
        emit(client, 'role', { participantId: own.id, role: 'controller' });
        socket.deliver({ type: 'status', state: 'waiting' }); element['render'](); hidden(element);
      };
      if (transition !== 'controller leave') element.addEventListener('stage-role', observe, { once: true });
      element.addEventListener('stage-stageleft', observe, { once: true });
      own.s.clear();
      assert.equal(await h.req(transition === 'controller removal' ? host.s : own.s,
        transition === 'controller removal' ? { type: 'stage:remove', targetId: own.id } : { type: 'stage:leave' }), 'ok');
      const events = own.s.inbox.filter(message => ['role:update', 'stage:left', 'room:state'].includes(message.type));
      assert.deepEqual(events.map(message => message.type), transition === 'controller leave'
        ? ['stage:left', 'room:state'] : ['role:update', 'stage:left', 'room:state']);
      for (const message of events) socket.deliver(message);
      hidden(element); assert.equal(callbacks, transition === 'controller leave' ? 1 : 2);
      own.s.clear();
      if (own === speaker) assert.equal(await h.req(own.s, { type: 'hand:raise' }), 'ok');
      assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: own.id }), 'ok');
      assert.equal(await h.req(own.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
      for (const message of own.s.inbox) socket.deliver(message);
      assert.equal(client.me!.onStage, true); hidden(element);
      emit(client, 'quality', accepted); emit(client, 'quality', rejected); hidden(element);
      socket.deliver(wireReport); shown(element);
    });
  }

  it('actual SDK reconnect consumes status-only and retained-state reports until a distinct resume state', async t => {
    const { element, client, socket, sockets, hello, tick } = await socketJoinedWidget(t, roomState(true));
    const accepted = report(), rejected = report(90), statusOnly = report(91);
    emit(client, 'quality', accepted); shown(element); const retained = client.state!;
    socket.close(); hidden(element); assert.equal(client.state, retained);
    await tick(500); const next = sockets[1]!, join = await hello(next);
    emit(client, 'quality', rejected); hidden(element);
    next.deliver({ type: 'status', state: 'live' }); emit(client, 'quality', statusOnly); hidden(element);
    emit(client, 'state', retained); emit(client, 'quality', report(92)); hidden(element);
    next.deliver({ type: 'room:state', ...roomState(true), resumeToken: 'resume-me' });
    next.deliver({ type: 'ok', requestId: join.requestId }); await settle(); hidden(element);
    for (const detail of [accepted, rejected, statusOnly]) { emit(client, 'quality', detail); hidden(element); }
    emit(client, 'quality', report(91)); shown(element, 91);
  });

  it('a receipt rejected before the first authoritative state stays rejected after admission', async t => {
    const { element, sockets, hello } = socketJoiningWidget(t); await settle();
    const socket = sockets[0]!, join = await hello(socket), client = element.client!, rejected = report(90);
    emit(client, 'quality', rejected); hidden(element);
    socket.deliver({ type: 'room:state', ...roomState(true) }); socket.deliver({ type: 'ok', requestId: join.requestId }); await settle();
    emit(client, 'quality', rejected); hidden(element); emit(client, 'quality', report(90)); shown(element, 90);
  });

  for (const property of ['hidden', 'textContent'] as const) {
    for (const loss of ['status', 'identity'] as const) {
      it(`${property} setter reconciles ${loss} loss after a newer report and cannot reopen from restored getters`, async t => {
        const { element, client } = await subscribedWidget(t, true);
        const restore = setter(element['quality'], property, () => {
          emit(client, 'quality', report(102));
          if (loss === 'status') client['currentStatus'] = 'reconnecting'; else client.state!.roomId = 'different';
        }); t.after(restore);
        emit(client, 'quality', report(101)); hidden(element);
        client['currentStatus'] = 'live'; client.state!.roomId = 'one';
        emit(client, 'quality', report(103)); hidden(element);
        await state(client); emit(client, 'quality', report(104)); shown(element, 104);
      });
    }

    it(`${property} setter preserves a newer admitted replacement entry`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const next = roomState(true, 'replacement'); next.me.participantId = 'replacement';
      const restore = setter(element['quality'], property, () => {
        void state(client, next);
        emit(client, 'quality', { participants: [{ participantId: 'replacement', rttMs: 106 }] });
      }); t.after(restore);
      emit(client, 'quality', report(105)); shown(element, 106);
      assert.equal(client.state!.roomId, 'replacement');
    });
  }

  for (const getter of ['state', 'status'] as const) {
    for (const loss of ['onstage', 'identity', 'status'] as const) {
      it(`${getter} getter tail reconciles silent ${loss} loss after a completed newer report`, async t => {
        const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report(107));
        const read = Object.getOwnPropertyDescriptor(StageClient.prototype, getter)!.get!;
        let armed = true;
        Object.defineProperty(client, getter, { configurable: true, get() {
          const result: unknown = read.call(client);
          if (armed) {
            armed = false; emit(client, 'quality', report(108));
            if (loss === 'onstage') client['snapshot']!.me.onStage = false;
            else if (loss === 'identity') client['snapshot']!.roomId = 'different';
            else client['currentStatus'] = 'reconnecting';
          }
          return result;
        } });
        t.after(() => Reflect.deleteProperty(client, getter));
        element['syncQualityOwner'](); hidden(element);
        client['snapshot']!.me.onStage = true; client['snapshot']!.roomId = 'one'; client['currentStatus'] = 'live';
        emit(client, 'quality', report(109)); hidden(element);
        await state(client); emit(client, 'quality', report(110)); shown(element, 110);
      });
    }
  }

  it('consumes an outer receipt before a public authority getter admits a newer report', async t => {
    const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report(111));
    const read = Object.getOwnPropertyDescriptor(StageClient.prototype, 'state')!.get!;
    const old = report(112); let armed = true;
    Object.defineProperty(client, 'state', { configurable: true, get() {
      const result: unknown = read.call(client);
      if (armed) { armed = false; emit(client, 'quality', report(113)); }
      return result;
    } });
    t.after(() => Reflect.deleteProperty(client, 'state'));
    emit(client, 'quality', old); shown(element, 113);
    emit(client, 'quality', old); shown(element, 113);
  });

  for (const action of ['close', 'transfer'] as const) {
    for (const loss of ['status', 'identity'] as const) {
      for (const property of ['hidden', 'textContent'] as const) {
        it(`corrective quality ${property} paint cannot restore pending ${action} consent after silent ${loss} loss`, async t => {
          const { element, client } = await subscribedWidget(t, true);
          const value = roomState(true); value.me.role = 'controller'; value.controllerId = 'me';
          const target = { ...value.me, participantId: 'target', role: 'speaker' as const }; value.speakers = [value.me, target];
          await state(client, value); emit(client, 'quality', report());
          const row = element['stageManagementRows'].get('target')!;
          const close = t.mock.method(client, 'closeRoom', async () => {}), transfer = t.mock.method(client, 'transferControl', async () => {});
          let stored = Reflect.get(element['quality'], property), armed = false, lost = false;
          Object.defineProperty(element['quality'], property, { configurable: true, get: () => stored, set: next => {
            stored = next;
            if (armed) {
              armed = false; emit(client, 'quality', report(115)); lost = true;
              if (loss === 'status') client['currentStatus'] = 'reconnecting'; else client.state!.me.participantId = 'different';
            } else if (lost) {
              lost = false; client['currentStatus'] = 'live'; client.state!.me.participantId = 'me';
            }
          } });
          t.after(() => Object.defineProperty(element['quality'], property, { configurable: true, writable: true, value: stored }));
          const confirm = t.mock.method(window, 'confirm', () => {
            armed = true; emit(client, 'quality', report(114)); hidden(element); return true;
          });
          click(action === 'close' ? element['roomClose'] : row.transfer); await settle();
          assert.equal(confirm.mock.callCount(), 1); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
          emit(client, 'quality', report(116)); hidden(element);
          await state(client, value); emit(client, 'quality', report(117)); shown(element, 117);
        });
      }
    }
  }

  it('keeps unconditional normal hidden-then-text writes even when metrics are unchanged', async t => {
    const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report(118));
    const writes: string[] = [], values = { hidden: element['quality'].hidden, textContent: element['quality'].textContent };
    for (const property of ['hidden', 'textContent'] as const) {
      let stored = values[property];
      Object.defineProperty(element['quality'], property, { configurable: true, get: () => stored, set: next => { stored = next; writes.push(property); } });
      t.after(() => Object.defineProperty(element['quality'], property, { configurable: true, writable: true, value: stored }));
    }
    emit(client, 'quality', report(118)); shown(element, 118);
    assert.ok(writes.length >= 2);
    for (let i = 0; i < writes.length; i += 2) assert.deepEqual(writes.slice(i, i + 2), ['hidden', 'textContent']);
  });

  for (const property of ['hidden', 'textContent'] as const) {
    it(`${property} setter cannot repaint through nested terminal teardown or retire a later valid tenure`, async t => {
      const { element, client } = await subscribedWidget(t, true);
      const accepted = report(120);
      const restore = setter(element['quality'], property, () => { void client['receive']({ type: 'room:closed', roomId: 'one' }); }); t.after(restore);
      emit(client, 'quality', accepted); hidden(element); assert.equal(client.state, null); await settle();
      await state(client); emit(client, 'quality', accepted); hidden(element);
      emit(client, 'quality', report(121)); shown(element, 121);
    });

    it(`${property} setter entry replacement stays clear and old terminal callbacks cannot touch its new report`, async t => {
      const { element, client, socket, sockets, hello } = await socketJoinedWidget(t, roomState(true));
      const restore = setter(element['quality'], property, () => { element.setAttribute('room', 'replacement'); }); t.after(restore);
      socket.deliver({ type: 'quality', ...report(122) }); hidden(element); await settle(); await settle();
      const next = sockets[1]!, join = await hello(next);
      next.deliver({ type: 'room:state', ...roomState(true, 'replacement') }); next.deliver({ type: 'ok', requestId: join.requestId }); await settle();
      next.deliver({ type: 'quality', ...report(123) }); shown(element, 123);
      emit(client, 'closed', { roomId: 'one' }); emit(client, 'kicked', { roomId: 'one' }); emit(client, 'status', 'disconnected');
      shown(element, 123); assert.notEqual(element.client, client);
    });
  }

  for (const getter of ['state', 'status'] as const) {
    it(`${getter} getter tail preserves a newer authoritative entry rather than retiring it with the old owner`, async t => {
      const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report(124));
      const read = Object.getOwnPropertyDescriptor(StageClient.prototype, getter)!.get!;
      let armed = true;
      Object.defineProperty(client, getter, { configurable: true, get() {
        const result: unknown = read.call(client);
        if (armed) {
          armed = false; const replacement = roomState(true, 'replacement'); replacement.me.participantId = 'replacement';
          void state(client, replacement); emit(client, 'quality', { participants: [{ participantId: 'replacement', rttMs: 125 }] });
        }
        return result;
      } });
      t.after(() => Reflect.deleteProperty(client, getter));
      element['syncQualityOwner'](); shown(element, 125); assert.equal(client.state!.roomId, 'replacement');
    });
  }

  it('a quality receipt rejected for an offstage seat cannot be replayed after promotion', async t => {
    const { element, client } = await subscribedWidget(t, false), rejected = report(126);
    emit(client, 'quality', rejected); hidden(element); await state(client);
    emit(client, 'quality', rejected); hidden(element); emit(client, 'quality', report(126)); shown(element, 126);
  });

  for (const participants of [[], [{ participantId: 'other', rttMs: 1000 }]]) {
    it(`replaying a previously accepted ${participants.length ? 'foreign-only' : 'empty'} full replacement set cannot clear a newer report`, async t => {
      const { element, client } = await subscribedWidget(t, true), empty = { participants };
      emit(client, 'quality', report(127)); shown(element, 127); emit(client, 'quality', empty); hidden(element);
      emit(client, 'quality', report(128)); shown(element, 128); emit(client, 'quality', empty); shown(element, 128);
    });
  }

  for (const event of ['quality', 'state', 'status', 'micerror', 'micready', 'role', 'transferred', 'speaking', 'error'] as const) {
    it(`preserves ordinary ${event} quality setter trace without additional paints`, async t => {
      const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report(100));
      const writes: string[] = [], node = element['quality'];
      for (const property of ['hidden', 'textContent'] as const) {
        let value = Reflect.get(node, property);
        Object.defineProperty(node, property, { configurable: true, get: () => value, set: next => { value = next; writes.push(property); } });
        t.after(() => Object.defineProperty(node, property, { configurable: true, writable: true, value }));
      }
      if (event === 'quality') emit(client, event, report(101));
      else if (event === 'state') await state(client);
      else if (event === 'status') client['setStatus']('waiting');
      else if (event === 'micerror') emit(client, event, { name: 'NotFoundError', message: 'Unavailable' });
      else if (event === 'micready') emit(client, event, undefined);
      else if (event === 'role') emit(client, event, { participantId: 'me', role: 'controller' });
      else if (event === 'transferred') emit(client, event, { fromId: 'host', toId: 'me' });
      else if (event === 'speaking') emit(client, event, { participantIds: ['me'] });
      else emit(client, event, new Error('Unrelated'));
      const expected = event === 'quality' ? ['hidden', 'textContent']
        : event === 'state' || event === 'status' ? ['hidden', 'textContent', 'hidden', 'textContent']
        : event === 'micerror' ? ['textContent', 'hidden'] : [];
      assert.deepEqual(writes, expected);
    });
  }


  for (const boundary of ['closed', 'status', 'role', 'stageleft'] as const) {
    for (const getter of ['state', 'status'] as const) {
      it(`${boundary} pure retirement precedes ${getter} getter reentry without preventing a later new tenure`, async t => {
        const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report(129));
        const read = Object.getOwnPropertyDescriptor(StageClient.prototype, getter)!.get!, rejected = report(130);
        let armed = true;
        Object.defineProperty(client, getter, { configurable: true, get() {
          const result: unknown = read.call(client);
          if (armed) { armed = false; emit(client, 'quality', rejected); }
          return result;
        } });
        t.after(() => Reflect.deleteProperty(client, getter));
        emit(client, boundary, boundary === 'closed' ? { roomId: 'one' } : boundary === 'status' ? 'reconnecting'
          : { participantId: 'me', ...(boundary === 'role' ? { role: 'audience' } : {}) });
        hidden(element); await state(client); emit(client, 'quality', rejected); hidden(element);
        emit(client, 'quality', report(131)); shown(element, 131);
      });
    }
  }

  it('early pure terminal retirement preserves a genuine new state and report admitted by a getter callback', async t => {
    const { element, client } = await subscribedWidget(t, true); emit(client, 'quality', report(132));
    const read = Object.getOwnPropertyDescriptor(StageClient.prototype, 'state')!.get!; let armed = true;
    Object.defineProperty(client, 'state', { configurable: true, get() {
      const result: unknown = read.call(client);
      if (armed) { armed = false; void state(client); emit(client, 'quality', report(133)); }
      return result;
    } });
    t.after(() => Reflect.deleteProperty(client, 'state'));
    emit(client, 'closed', { roomId: 'one' }); shown(element, 133);
  });

});
