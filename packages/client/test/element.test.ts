import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { StageClient } from '../src/index.ts';
import type { RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';

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
}
const originals = new Map(['HTMLElement', 'document', 'customElements', 'window'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: Node });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => tag === 'audio' ? new Audio() : new Node(), body: { append() {} } } });
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
        assert.equal(element['status'].textContent, '');
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
    assert.equal(element['status'].textContent, '', 'the old handler cannot restore its disconnect or terminal notice');
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
