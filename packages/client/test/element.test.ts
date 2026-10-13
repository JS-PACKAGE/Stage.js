import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { StageClient } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';

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
  tagName = '';
  isConnected = true;
  onclick?: () => void;
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
    me: { onStage, muted: false, forceMuted: false, handRaised: false, role: 'audience' },
    state: { name: 'Room' }, status: 'live', handCooldownMs: 0,
    raiseHand: action, withdrawHand: action, mute: action, unmute: action, leaveStage: action,
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

async function subscribedWidget(t: TestContext, onStage = false) {
  t.mock.method(StageClient.prototype, 'connect', async () => {});
  t.mock.method(StageClient.prototype, 'join', async () => {});
  t.mock.method(StageClient.prototype as unknown as { createMedia(): void }, 'createMedia', () => {});
  const element = new StageElement(); widgets.push(element);
  Object.assign(element, { isConnected: false });
  element.setAttribute('room', 'one'); element.setAttribute('name', 'Listener');
  Object.assign(element, { isConnected: true }); element.connectedCallback(); await settle();
  const client = element.client;
  assert.ok(client);
  await client['receive']({ type: 'room:state', ...roomState(onStage) });
  return { element, client };
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

/** Runs the real SDK deadlines and request path without opening sockets or creating media. */
function socketJoiningWidget(t: TestContext, attributes: Record<string, string> = {}) {
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
  t.mock.method(StageClient.prototype as unknown as { createMedia(): void }, 'createMedia', () => {});
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

async function socketJoinedWidget(t: TestContext, state = roomState()) {
  const fixture = socketJoiningWidget(t);
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
      assert.equal(element['leaveStage'].hidden, !state.me.onStage);
      assert.equal(element['mic'].disabled, role === 'force-muted speaker');
      assert.equal(element['leaveStage'].disabled, false);
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
