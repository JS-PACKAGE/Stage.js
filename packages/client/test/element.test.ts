import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { StageClient } from '../src/index.ts';

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
const originals = new Map(['HTMLElement', 'document', 'customElements'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: Node });
Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Node(), body: { append() {} } } });
const { StageElement, defineStageElement } = await import('../src/element.ts');
after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function widget(onStage = false) {
  const element = new StageElement();
  const pending = deferred();
  let calls = 0;
  const action = () => { calls++; return pending.promise; };
  const client = {
    me: { onStage, muted: false, forceMuted: false, handRaised: false, role: 'audience' },
    state: { name: 'Room' }, status: 'live', handCooldownMs: 0,
    raiseHand: action, withdrawHand: action, mute: action, unmute: action, leaveStage: action,
    disconnect: async () => {}, playbackMuted: false, setPlaybackMuted(muted: boolean) { this.playbackMuted = muted; },
  };
  element['current'] = client as unknown as StageClient;
  element['render']();
  return { element, pending, client, calls: () => calls };
}
function click(button: HTMLButtonElement): void { button.onclick?.call(button, {} as PointerEvent); }

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
