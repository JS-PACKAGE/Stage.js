import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { StageClient } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { Room } from '../../../src/model/room.ts';

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
const { StageElement } = await import('../src/element.ts');
after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const widgets: InstanceType<typeof StageElement>[] = [];
afterEach(async () => { for (const element of widgets.splice(0)) { element.disconnectedCallback(); await settle(); } });
function click(button: HTMLButtonElement): void { button.onclick?.call(button, {} as PointerEvent); }
function mountJoiningWidget(attributes: Record<string, string> = {}) {
  const element = new StageElement(); widgets.push(element);
  Object.assign(element, { isConnected: false });
  element.setAttribute('room', 'one'); element.setAttribute('name', 'Listener');
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  Object.assign(element, { isConnected: true }); element.connectedCallback();
  return element;
}

/** Runs real SDK deadlines and requests with fake sockets; media is disabled unless explicitly faked. */
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

async function socketJoinedWidget(t: TestContext, state = longRoom().snapshot('me')) {
  const fixture = socketJoiningWidget(t, { room: state.roomId });
  await settle();
  const socket = fixture.sockets[0]!;
  const request = await fixture.hello(socket);
  socket.deliver({ type: 'room:state', ...state, resumeToken: 'resume-me' });
  socket.deliver({ type: 'ok', requestId: request.requestId });
  await settle(); await settle();
  const client = fixture.element.client;
  assert.ok(client);
  assert.equal(client.status, state.status);
  return { ...fixture, socket, client };
}


function longRoom() {
  const room = new Room({ roomId: 'one', name: 'Search test room', code: 'NOT-A-NAME-CODE', codeRequired: true, now: 0,
    limits: { maxSpeakers: 8, maxAudience: 300 }, controller: { participantId: 'me', name: 'Host', resumeToken: 'synthetic-token' } });
  for (let i = 0; i < 120; i++) {
    const name = [12, 75, 118].includes(i) ? 'Repeated Alice' : i === 64 ? 'A&amp;B &lt;Team&gt;' : `Listener ${String(i).padStart(3, '0')}`;
    room.join({ participantId: `private-id-${i}`, name, resumeToken: `synthetic-${i}` }, i + 1);
  }
  room.join({ participantId: 'unraised-private-id', name: 'Unraised private listener', resumeToken: 'synthetic-unraised' }, 999);
  // Deliberately differ from name, ID and join-time order. The snapshot controls display order.
  for (let i = 119; i >= 0; i--) room.raiseHand(`private-id-${i}`);
  room.assertInvariants(); return room;
}

const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
const text = (node: Node): string => [node.textContent, ...node.children.map(text)].join(' ');
function view(element: InstanceType<typeof StageElement>) {
  return { panel: element['handQueuePanel'], search: element['handQueueSearch'], clear: element['handQueueClear'],
    results: element['handQueueResults'], rows: () => (element['handQueueList'] as unknown as Node).children,
    visible: () => (element['handQueueList'] as unknown as Node).children.filter(row => !row.hidden),
    type(query: string) { this.search.value = query; this.search.oninput?.call(this.search, new Event('input') as InputEvent); } };
}
function commands(socket: { sent: ClientMessage[] }) {
  return socket.sent.filter(message => message.type === 'stage:approve' || message.type === 'stage:reject');
}
function results(element: InstanceType<typeof StageElement>, matching: number, total: number): void {
  assert.match(element['handQueueResults'].textContent!, new RegExp(`符合 ${matching} / ${total} 筆`));
}
function deliver(socket: { deliver(message: ServerMessage): void }, state: RoomStatePayload): void {
  socket.deliver({ type: 'room:state', ...state });
}
function row(element: InstanceType<typeof StageElement>, id: number) {
  const value = element['handQueueRows'].get(`private-id-${id}`); assert.ok(value); return value;
}
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('widget controller hand queue local name search', () => {
  it('filters 120 real Room requests by decoded name with native labeled controls and no commands', async t => {
    const room = longRoom(), state = room.snapshot('me'), f = await socketJoinedWidget(t, state), q = view(f.element);
    assert.equal(q.search.type, 'search'); assert.equal(q.clear.type, 'button');
    const label = nodes(q.panel as unknown as Node).find(node => node.tagName === 'LABEL' && node.contains(q.search as unknown as Node));
    assert.ok(label); assert.equal(label.textContent, '搜尋舉手者名稱'); assert.equal(q.results.getAttribute('role'), 'status');
    assert.equal(q.panel.open, false); q.panel.open = true;
    const originalRows = [...q.rows()], before = f.socket.sent.length;
    const replaced = t.mock.method(f.element['handQueueList'], 'replaceChildren');
    results(f.element, 120, 120); assert.equal(q.clear.disabled, true);
    q.type('   aLiCe   ');
    assert.equal(q.search.value, '   aLiCe   '); results(f.element, 3, 120);
    assert.deepEqual(q.visible().map(node => node.children[0]!.textContent), Array(3).fill('Repeated Alice'));
    assert.deepEqual(f.element['handQueueOrder'], state.hands.map(person => person.participantId));
    assert.equal(f.element['handQueueRows'].size, 120); assert.deepEqual(q.rows(), originalRows);
    assert.equal(q.panel.open, true); assert.equal(q.clear.disabled, false);
    q.type('a&b <team>'); results(f.element, 1, 120); assert.equal(q.visible()[0], row(f.element, 64).node);
    assert.equal(nodes(row(f.element, 64).node as unknown as Node).length, 4, 'decoded angle brackets remain text, never markup');
    q.type('  '); results(f.element, 120, 120);
    click(q.clear); results(f.element, 120, 120); assert.equal(q.search.value, ''); assert.equal(q.clear.disabled, true);
    assert.equal(replaced.mock.callCount(), 0); assert.equal(f.socket.sent.length, before);
    assert.deepEqual(f.client.state!.hands, state.hands); room.assertInvariants();
  });

  it('never matches IDs, room code, unraised audience names or displayed offline suffixes', async t => {
    const state = longRoom().snapshot('me'); state.hands[0]!.connected = false;
    const f = await socketJoinedWidget(t, state), q = view(f.element), before = f.socket.sent.length;
    for (const query of ['private-id-', 'NOT-A-NAME-CODE', 'Unraised private listener', '暫時離線', 'no matching name']) {
      q.type(query); results(f.element, 0, 120); assert.equal(q.visible().length, 0);
      assert.match(q.results.textContent!, /沒有符合搜尋/);
      assert.equal(f.element['handQueueRows'].size, 120);
    }
    assert.doesNotMatch(text(q.panel as unknown as Node), /NOT-A-NAME-CODE|private-id-|Unraised private listener/);
    assert.equal(f.socket.sent.length, before);
    const empty = structuredClone(state); empty.hands = []; deliver(f.socket, empty);
    results(f.element, 0, 0); assert.doesNotMatch(q.results.textContent!, /沒有符合搜尋/);
    assert.equal(f.element['handQueueNotice'].textContent, '目前沒有舉手申請。');
  });

  it('counts valid unique requests and preserves server order, row identity and renamed matches', async t => {
    const state = longRoom().snapshot('me');
    state.hands.push({ ...state.hands[0]!, name: 'Duplicate ID Alice' },
      { ...state.hands[0]!, participantId: 'invalid-speaker', role: 'speaker' },
      { ...state.hands[0]!, participantId: 'invalid-unraised', handRaised: false },
      { ...state.hands[0]!, participantId: 'invalid-onstage', onStage: true });
    const f = await socketJoinedWidget(t, state), q = view(f.element), original = [...q.rows()]; q.type('Alice');
    results(f.element, 3, 120); assert.equal(q.rows().length, 120);
    const update = longRoom().snapshot('me'); update.hands.find(p => p.participantId === 'private-id-118')!.name = 'Renamed';
    update.hands.find(p => p.participantId === 'private-id-64')!.name = 'Alice &amp; Co';
    update.hands = update.hands.filter(p => p.participantId !== 'private-id-75').reverse();
    deliver(f.socket, update); results(f.element, 2, 119);
    assert.deepEqual(f.element['handQueueOrder'], update.hands.map(p => p.participantId));
    assert.equal(q.search.value, 'Alice'); assert.equal(row(f.element, 118).node, original[1]);
    assert.equal(row(f.element, 118).node.hidden, true); assert.equal(row(f.element, 64).node.hidden, false);
    assert.deepEqual(q.visible().map(node => node.children[0]!.textContent), ['Repeated Alice', 'Alice & Co']);
    click(q.clear); results(f.element, 119, 119); assert.equal(q.visible().length, 119);
  });

  for (const outcome of ['ok', 'error'] as const) it(`retains exact per-ID pending reservations while filtered through ${outcome} settlement`, async t => {
    const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice');
    const first = row(f.element, 118), second = row(f.element, 75);
    click(first.approve); click(first.reject); click(second.reject); await f.tick(200);
    const sent = commands(f.socket);
    assert.deepEqual(sent.map(message => [message.type, message.targetId]), [['stage:approve', 'private-id-118'], ['stage:reject', 'private-id-75']]);
    q.type('Listener'); assert.equal(first.node.hidden, true); assert.equal(f.element['handQueuePending'].size, 2);
    click(first.approve); click(first.reject); assert.equal(commands(f.socket).length, 2);
    assert.equal(first.approve.getAttribute('aria-busy'), 'true');
    if (outcome === 'ok') f.socket.deliver({ type: 'ok', requestId: sent[0]!.requestId });
    else f.socket.deliver({ type: 'error', requestId: sent[0]!.requestId, code: 'conflict', message: 'Try another request' });
    await settle(); assert.equal(f.element['handQueuePending'].size, 1);
    assert.equal(first.approve.disabled, true); assert.equal(first.approve.getAttribute('aria-busy'), 'false');
    assert.equal(second.reject.getAttribute('aria-busy'), 'true');
    q.type('Alice'); assert.equal(first.approve.disabled, false); assert.equal(second.reject.disabled, true);
    f.socket.deliver({ type: 'ok', requestId: sent[1]!.requestId }); await settle();
    assert.equal(second.reject.disabled, false); assert.equal(f.element['handQueuePending'].size, 0);
  });

  it('rejects synthetic filtered and removed callbacks before pending/error changes or SDK commands', async t => {
    const f = await socketJoinedWidget(t), q = view(f.element), old = row(f.element, 118);
    f.socket.deliver({ type: 'error', code: 'conflict', message: 'Keep existing error' });
    const before = f.socket.sent.length, revision = f.element['errorRevision'];
    q.type('Listener'); click(old.approve); click(old.reject);
    assert.equal(f.element['handQueuePending'].size, 0); assert.equal(f.element['errorRevision'], revision);
    assert.equal(f.element['error'].textContent, 'Keep existing error');
    old.node.hidden = false; old.approve.disabled = false; click(old.approve);
    assert.equal(old.node.hidden, true); assert.equal(f.element['handQueuePending'].size, 0);
    const next = longRoom().snapshot('me'); next.hands = next.hands.filter(p => p.participantId !== 'private-id-118');
    deliver(f.socket, next); click(q.clear); click(old.approve); click(old.reject); await f.tick(200);
    assert.equal(f.element['errorRevision'], revision); assert.equal(f.socket.sent.length, before);
  });

  it('preserves query/open state and keyed reconnect history while disabling moderation until resumed state', async t => {
    const room = longRoom(), f = await socketJoinedWidget(t, room.snapshot('me')), q = view(f.element);
    q.panel.open = true; q.type('Alice'); const original = [...q.rows()];
    f.socket.close(); await settle();
    assert.equal(f.client.status, 'reconnecting'); assert.equal(q.search.value, 'Alice'); results(f.element, 3, 120);
    assert.equal(q.panel.open, true); assert.match(f.element['handQueueSummary'].textContent!, /上次收到/);
    q.type('<Team>'); results(f.element, 1, 120); assert.equal(row(f.element, 64).approve.disabled, true);
    click(row(f.element, 64).approve); assert.equal(f.element['handQueuePending'].size, 0);
    await f.tick(500); const socket = f.sockets[1]!, resume = await f.hello(socket);
    assert.equal(q.search.value, '<Team>'); assert.equal(row(f.element, 64).approve.disabled, true);
    deliver(socket, room.snapshot('me')); socket.deliver({ type: 'ok', requestId: resume.requestId }); await settle();
    assert.deepEqual(q.rows(), original); assert.equal(q.panel.open, true); assert.equal(q.search.value, '<Team>');
    assert.equal(row(f.element, 64).approve.disabled, false); assert.equal(row(f.element, 118).approve.disabled, true);
    assert.equal(commands(socket).length, 0);
  });

  for (const transition of ['controller loss', 'room', 'seat', 'detach', 'leave', 'entry', 'closed', 'kicked', 'shutdown'] as const) {
    it(`retires query/private controls on ${transition} and rejects old callbacks and settlements`, async t => {
      const f = await socketJoinedWidget(t), q = view(f.element), old = row(f.element, 118), pending = deferred();
      t.mock.method(f.client, 'approve', () => pending.promise);
      q.panel.open = true; q.type('Alice'); click(old.approve);
      if (transition === 'detach') { Object.assign(f.element, { isConnected: false }); f.element.disconnectedCallback(); }
      else if (transition === 'leave') click(f.element['roomAction']);
      else if (transition === 'entry') f.element.setAttribute('name', 'Replacement entry');
      else if (transition === 'closed' || transition === 'shutdown') {
        f.socket.deliver({ type: 'room:closed', roomId: 'one', ...(transition === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
      } else if (transition === 'kicked') f.socket.deliver({ type: 'kicked', roomId: 'one' });
      else {
        const next = longRoom().snapshot('me');
        if (transition === 'controller loss') { next.me.role = 'audience'; next.me.onStage = false; next.controllerId = 'other'; }
        else if (transition === 'room') next.roomId = 'two';
        else { next.me.participantId = 'new-seat'; next.controllerId = 'new-seat'; }
        deliver(f.socket, next);
      }
      await settle(); assert.equal(q.search.value, ''); assert.equal(f.element['handQueueQuery'], '');
      assert.equal(q.panel.open, false); assert.equal(old.approve.disabled, true);
      if (transition === 'room' || transition === 'seat') results(f.element, 120, 120);
      else { assert.equal(q.panel.hidden, true); assert.equal(q.results.textContent, ''); assert.equal(q.rows().length, 0); }
      const revision = f.element['errorRevision'], before = f.socket.sent.length;
      click(old.approve); click(old.reject); pending.reject(new Error('Retired failure')); await settle();
      assert.equal(f.element['errorRevision'], revision); assert.equal(f.socket.sent.length, before);
      assert.equal(f.element['handQueuePending'].size, 0);
    });
  }

  for (const type of ['role', 'transferred'] as const) it(`retires search before forwarding own ${type} delta and waits for a fresh snapshot`, async t => {
    const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice'); q.panel.open = true;
    let observed = false;
    f.element.addEventListener(`stage-${type}`, () => {
      observed = true; assert.equal(q.search.value, ''); assert.equal(q.panel.hidden, true); assert.equal(q.results.textContent, '');
      q.type('old-owner'); assert.equal(f.element['handQueueQuery'], '');
    }, { once: true });
    if (type === 'role') f.socket.deliver({ type: 'role:update', participantId: 'me', role: 'audience' });
    else f.socket.deliver({ type: 'control:transferred', fromId: 'me', toId: 'other' });
    assert.equal(observed, true); assert.equal(q.panel.hidden, true);
    deliver(f.socket, longRoom().snapshot('me')); assert.equal(q.search.value, ''); results(f.element, 120, 120);
  });

  it('allows an offstage controller to filter and target the exact visible requester', async t => {
    const room = longRoom(); room.leaveStage('me'); const f = await socketJoinedWidget(t, room.snapshot('me')), q = view(f.element);
    assert.equal(f.client.me!.onStage, false); assert.equal(q.panel.hidden, false);
    q.type('Alice'); results(f.element, 3, 120); click(row(f.element, 75).reject); await f.tick(100);
    assert.deepEqual(commands(f.socket).map(message => [message.type, message.targetId]), [['stage:reject', 'private-id-75']]);
  });

  it('keeps a newer nested snapshot and same-snapshot renamed matches after forwarded callbacks', async t => {
    const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice');
    f.element.addEventListener('stage-state', () => {
      const newer = longRoom().snapshot('me'); newer.hands = [newer.hands[1]!]; newer.hands[0]!.name = 'New Alice';
      deliver(f.socket, newer);
      f.client.state!.hands[0]!.name = 'Current Bob';
    }, { once: true });
    deliver(f.socket, longRoom().snapshot('me'));
    results(f.element, 0, 1); assert.equal(q.visible().length, 0); assert.equal(q.rows()[0]!.children[0]!.textContent, 'Current Bob');
    assert.equal(q.search.value, 'Alice'); assert.equal(commands(f.socket).length, 0);
  });

  for (const transition of ['room', 'seat', 'control loss', 'detach', 'newer query'] as const) {
    it(`rejects a stale input value getter after ${transition}`, async t => {
      const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice');
      let value = 'Stale input', fired = false;
      Object.defineProperty(q.search, 'value', { configurable: true, get() {
        const captured = value;
        if (!fired) {
          fired = true;
          if (transition === 'detach') { Object.assign(f.element, { isConnected: false }); f.element.disconnectedCallback(); }
          else if (transition === 'newer query') { value = '<Team>'; q.search.oninput?.call(q.search, new Event('input') as InputEvent); }
          else {
            const next = longRoom().snapshot('me');
            if (transition === 'room') next.roomId = 'two';
            else if (transition === 'seat') { next.me.participantId = 'new-seat'; next.controllerId = 'new-seat'; }
            else { next.me.role = 'audience'; next.me.onStage = false; next.controllerId = 'other'; }
            deliver(f.socket, next);
          }
        }
        return captured;
      }, set(next: string) { value = next; } });
      q.search.oninput?.call(q.search, new Event('input') as InputEvent);
      Object.defineProperty(q.search, 'value', { configurable: true, writable: true, value });
      assert.equal(f.element['handQueueQuery'], transition === 'newer query' ? '<Team>' : '');
      if (transition === 'room' || transition === 'seat') results(f.element, 120, 120);
      else if (transition !== 'newer query') { assert.equal(q.panel.hidden, true); assert.equal(q.results.textContent, ''); }
      assert.equal(commands(f.socket).length, 0);
    });
  }

  for (const paint of ['result text', 'row hidden', 'search value'] as const) for (const transition of ['room', 'newer state', 'newer query'] as const) {
    it(`repairs stale ${paint} writes after ${transition} reentry`, async t => {
      const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice');
      const target = paint === 'result text' ? q.results : paint === 'row hidden' ? row(f.element, 119).node : q.search;
      const key = paint === 'result text' ? 'textContent' : paint === 'row hidden' ? 'hidden' : 'value';
      let value: unknown = Reflect.get(target, key), fired = false;
      Object.defineProperty(target, key, { configurable: true, get: () => value, set(next: unknown) {
        if (!fired) {
          fired = true;
          if (transition === 'newer query') q.type('<Team>');
          else {
            const newer = longRoom().snapshot('me');
            if (transition === 'room') newer.roomId = 'two';
            else newer.hands = [newer.hands.find(p => p.participantId === 'private-id-64')!];
            deliver(f.socket, newer);
          }
        }
        value = next;
      } });
      click(q.clear);
      assert.equal(fired, true);
      assert.equal(f.element['handQueueQuery'], transition === 'newer query' ? '<Team>' : '');
      assert.equal(q.search.value, transition === 'newer query' ? '<Team>' : '');
      results(f.element, transition === 'room' ? 120 : 1, transition === 'newer query' || transition === 'room' ? 120 : 1);
      if (transition !== 'room') assert.equal(q.visible()[0], row(f.element, 64).node);
      assert.equal(commands(f.socket).length, 0);
    });
  }
});

it('retires the query when a row-hidden setter changes the current snapshot room in place', async t => {
  const f = await socketJoinedWidget(t), q = view(f.element), target = row(f.element, 119);
  let hidden = false, armed = true;
  Object.defineProperty(target.node, 'hidden', { configurable: true, get: () => hidden, set(next: boolean) {
    hidden = next;
    if (armed) { armed = false; f.client.state!.roomId = 'new-room-in-place'; }
  } });
  q.panel.open = true; q.type('Alice');
  assert.equal(armed, false); assert.equal(q.search.value, ''); assert.equal(q.panel.open, false);
  assert.equal(f.element['handQueueOwner']!.roomId, 'new-room-in-place'); results(f.element, 120, 120);
  assert.equal(q.visible().length, 120); assert.equal(commands(f.socket).length, 0);
});

it('fences a nested filter change from the new moderation hidden getter before reserving or clearing error', async t => {
  const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice');
  const target = row(f.element, 118); let hidden = false, armed = true;
  Object.defineProperty(target.node, 'hidden', { configurable: true, get() {
    const captured = hidden;
    // Isolate the admission read from earlier reconciliation reads of the same live property.
    const direct = new Error().stack?.split('\n')[2]?.includes('StageElement.moderateHand');
    if (armed && direct) { armed = false; q.type('Listener 119'); }
    return captured;
  }, set(next: boolean) { hidden = next; } });
  f.socket.deliver({ type: 'error', code: 'conflict', message: 'Preserve earlier error' });
  const errorRevision = f.element['errorRevision']; click(target.approve); await f.tick(200);
  assert.equal(armed, false); assert.equal(q.search.value, 'Listener 119'); assert.equal(commands(f.socket).length, 0);
  assert.equal(f.element['handQueuePending'].size, 0); assert.equal(f.element['errorRevision'], errorRevision);
  assert.equal(f.element['error'].textContent, 'Preserve earlier error');
});

for (const transition of ['owner', 'filter'] as const) it(`fences a post-reservation search getter ${transition} change without releasing another request`, async t => {
  const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice');
  const first = row(f.element, 118), other = row(f.element, 75);
  click(other.reject); await f.tick(100); assert.equal(commands(f.socket).length, 1);
  let value = q.search.value, armed = true;
  Object.defineProperty(q.search, 'value', { configurable: true, get() {
    const captured = value;
    if (armed && f.element['handQueuePending'].has('private-id-118')) {
      armed = false;
      if (transition === 'owner') {
        const next = longRoom().snapshot('me'); next.roomId = 'replacement-after-reservation'; deliver(f.socket, next);
      }
      q.type('Listener 119');
    }
    return captured;
  }, set(next: string) { value = next; } });
  f.socket.deliver({ type: 'error', code: 'conflict', message: 'Preserve earlier error' });
  const errorRevision = f.element['errorRevision']; click(first.approve); await f.tick(200);
  assert.equal(armed, false); assert.equal(q.search.value, 'Listener 119'); assert.equal(commands(f.socket).length, 1);
  assert.equal(f.element['handQueuePending'].has('private-id-118'), false);
  assert.equal(f.element['handQueuePending'].has('private-id-75'), transition === 'filter');
  assert.equal(f.element['errorRevision'], errorRevision); assert.equal(f.element['error'].textContent, 'Preserve earlier error');
  f.socket.deliver({ type: 'ok', requestId: commands(f.socket)[0]!.requestId }); await settle();
});

it('keeps the newer input when the last room identity getter reenters after reading the older query', async t => {
  const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice');
  const state = f.client.state!, roomId = state.roomId;
  let value = 'Listener 119', armed = false, armInput = true, nested = false;
  Object.defineProperty(state, 'roomId', { configurable: true, get() {
    if (armed) { armed = false; nested = true; q.type('Listener 117'); }
    return roomId;
  } });
  Object.defineProperty(q.search, 'value', { configurable: true, get() {
    const captured = value; if (armInput) { armInput = false; armed = true; } return captured;
  }, set(next: string) { value = next; } });
  q.search.oninput?.call(q.search, new Event('input') as InputEvent);
  assert.equal(nested, true); assert.equal(q.search.value, 'Listener 117'); results(f.element, 1, 120);
  assert.equal(q.visible()[0], row(f.element, 117).node); assert.equal(commands(f.socket).length, 0);
});

for (const type of ['role', 'transferred'] as const) {
  it(`preserves both original dialog fences before a new ${type} detail getter reenters`, async t => {
    const state = longRoom().snapshot('me');
    const target = { ...state.hands[0]!, role: 'speaker' as const, onStage: true, handRaised: false };
    state.speakers.push(target); state.hands = state.hands.filter(person => person.participantId !== target.participantId);
    const f = await socketJoinedWidget(t, state), q = view(f.element); q.type('Alice');
    const targetRow = f.element['stageManagementRows'].get(target.participantId)!; assert.ok(targetRow);
    const close = t.mock.method(f.client, 'closeRoom', async () => {});
    const transfer = t.mock.method(f.client, 'transferControl', async () => {});
    const confirm = t.mock.method(window, 'confirm', () => true);
    let armed = true;
    const detail = type === 'role' ? { participantId: 'me', role: 'audience' as const }
      : { fromId: 'me', toId: target.participantId };
    const key = type === 'role' ? 'role' : 'fromId', value = Reflect.get(detail, key);
    Object.defineProperty(detail, key, { configurable: true, get() {
      if (armed && new Error().stack?.includes('StageElement.noteHandQueueEvent')) {
        armed = false; click(targetRow.transfer); click(f.element['roomClose']);
      }
      return value;
    } });
    if (type === 'role') f.client['emit']('role', detail as { participantId: string; role: 'audience' });
    else f.client['emit']('transferred', detail as { fromId: string; toId: string });
    await settle(); assert.equal(armed, false);
    assert.equal(confirm.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0); assert.equal(transfer.mock.callCount(), 0);
    assert.equal(q.panel.hidden, true); assert.equal(q.search.value, '');
  });

  it(`revokes the old ${type} query before the existing transfer helper reads public state`, async t => {
    const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice'); q.panel.open = true;
    const target = row(f.element, 119), get = Object.getOwnPropertyDescriptor(StageClient.prototype, 'state')!.get!;
    let armed = true;
    Object.defineProperty(f.client, 'state', { configurable: true, get() {
      const state: unknown = get.call(f.client);
      if (armed) { armed = false; q.type('Listener 119'); click(target.approve); }
      return state;
    } });
    t.after(() => Reflect.deleteProperty(f.client, 'state'));
    if (type === 'role') f.socket.deliver({ type: 'role:update', participantId: 'me', role: 'speaker', reason: 'transferred' });
    else f.socket.deliver({ type: 'control:transferred', fromId: 'me', toId: 'other' });
    await f.tick(200); assert.equal(armed, false); assert.equal(q.search.value, '');
    assert.equal(q.panel.hidden, true); assert.equal(q.panel.open, false); assert.equal(commands(f.socket).length, 0);
  });
}

for (const type of ['role', 'transferred'] as const) it(`does not retire a newer seat created by a nested ${type} filter-detail getter`, async t => {
  const f = await socketJoinedWidget(t), q = view(f.element); q.type('Alice');
  let armed = true;
  const detail = type === 'role' ? { participantId: 'me', role: 'audience' as const } : { fromId: 'me', toId: 'other' };
  const key = type === 'role' ? 'role' : 'fromId', value = Reflect.get(detail, key);
  Object.defineProperty(detail, key, { configurable: true, get() {
    if (armed && new Error().stack?.includes('StageElement.noteHandQueueEvent')) {
      armed = false;
      const fresh = longRoom().snapshot('me'); fresh.me.participantId = 'new-seat'; fresh.controllerId = 'new-seat';
      deliver(f.socket, fresh); q.type('Listener 119'); q.panel.open = true;
    }
    return value;
  } });
  if (type === 'role') f.client['emit']('role', detail as { participantId: string; role: 'audience' });
  else f.client['emit']('transferred', detail as { fromId: string; toId: string });
  await settle(); assert.equal(armed, false); assert.equal(f.element['handQueueOwner']?.participantId, 'new-seat');
  assert.equal(q.search.value, 'Listener 119'); assert.equal(q.panel.hidden, false); assert.equal(q.panel.open, true);
  results(f.element, 1, 120); assert.equal(commands(f.socket).length, 0);
});
