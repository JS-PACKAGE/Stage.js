import assert from 'node:assert/strict';
import { FakeSession, harness, testConfig } from '../../../test/helpers.ts';
import { after, it } from 'node:test';
import type { TestContext } from 'node:test';
import { StageClient } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { parseClientMessage } from '../../../src/ws/validate.ts';

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


const drain = async () => { for (let i = 0; i < 45; i++) await Promise.resolve(); };
function visibleText(node: Node): string {
  if (node.hidden || node.tagName === 'STYLE') return '';
  const children = node.tagName === 'DETAILS' && !node.open
    ? node.children.filter(child => child.tagName === 'SUMMARY') : node.children;
  return [node.textContent, ...children.map(visibleText)].filter(Boolean).join('\n');
}
function allNodes(node: Node): Node[] { return [node, ...node.children.flatMap(allNodes)]; }
async function setup(t: TestContext, maxSpeakers = 8) {
  const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; c.limits.maxSpeakersPerRoom = maxSpeakers; c.rooms.qualityIntervalMs = 0;
    c.rooms.participantGraceMs = 15000; c.limits.handRaiseIntervalMs = 0; c.limits.controlPerSecond = 2000; });
  const h = harness(config), sockets: BridgeSocket[] = [];
  let sequence = 0;
  async function request(session: FakeSession, message: object) {
    const requestId = `public-roster-${++sequence}`;
    const parsed = parseClientMessage(JSON.stringify({ ...message, requestId }), config.limits);
    await h.hub.handle(session, parsed); await drain();
    const reply = [...session.inbox].reverse().find(m => (m.type === 'ok' || m.type === 'error') && m.requestId === requestId);
    assert.ok(reply); assert.equal(reply.type, 'ok');
  }
  const hostSession = new FakeSession(); h.hub.attach(hostSession);
  await request(hostSession, { type: 'room:create', name: 'Silent Controller', roomName: 'Synthetic Room', codeRequired: false });
  const roomId = hostSession.last('room:created')!.roomId;
  const hostId = hostSession.last('room:state')!.me.participantId;
  const speakerSession = new FakeSession(); h.hub.attach(speakerSession);
  await request(speakerSession, { type: 'join', roomId, name: 'Silent Speaker' });
  const speakerId = speakerSession.last('room:state')!.me.participantId;
  await request(speakerSession, { type: 'hand:raise' });
  await request(hostSession, { type: 'stage:approve', targetId: speakerId });
  class BridgeSocket {
    static OPEN = 1; readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    chain = Promise.resolve(); readonly session = new FakeSession(); readonly sent: ClientMessage[] = [];
    constructor() {
      sockets.push(this); const record = this.session.send.bind(this.session);
      this.session.send = (message: ServerMessage, encoded?: string) => {
        record(message, encoded);
        if (this.readyState === BridgeSocket.OPEN) this.onmessage?.({ data: encoded ?? JSON.stringify(message) });
      };
      queueMicrotask(() => h.hub.attach(this.session));
    }
    send(data: string) { const message = parseClientMessage(data, config.limits); this.sent.push(message);
      this.chain = this.chain.then(() => h.hub.handle(this.session, message)); }
    deliver(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close(code = 1006) { if (this.readyState !== BridgeSocket.OPEN) return; this.readyState = 3;
      this.chain = this.chain.then(() => h.hub.detach(this.session, code === 1000)).then(() => this.onclose?.()); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: BridgeSocket });
  let mediaCalls = 0;
  t.mock.method(StageClient.prototype as unknown as { createMedia(): void }, 'createMedia', () => { mediaCalls++; });
  let now = 1000; t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const element = new StageElement(); Object.assign(element, { isConnected: false });
  element.setAttribute('room', roomId); element.setAttribute('name', 'Roster Reader');
  Object.assign(element, { isConnected: true }); element.connectedCallback();
  const tick = async (ms = 100) => { now += ms; t.mock.timers.tick(ms); await drain(); await Promise.all(sockets.map(s => s.chain)); await drain(); };
  t.after(async () => {
    element.disconnectedCallback(); await drain(); await Promise.all(sockets.map(s => s.chain));
    await h.hub.shutdown(); await h.transport.close();
    if (original) Object.defineProperty(globalThis, 'WebSocket', original); else Reflect.deleteProperty(globalThis, 'WebSocket');
  });
  for (let i = 0; i < 100 && !(element.client?.me && element.client['pending'].size === 0); i++) await tick(20);
  const client = element.client!; assert.ok(client?.me); assert.equal(client.me.role, 'audience');
  const socket = sockets[0]!;
  return { h, config, hostSession, hostId, speakerSession, speakerId, roomId, element, client, socket, sockets, request, tick,
    text: () => visibleText(element as unknown as Node), mediaCalls: () => mediaCalls };
}

function roster(element: InstanceType<typeof StageElement>) {
  const panel = element['publicRosterPanel'], list = element['publicRosterList'];
  return { panel, list, notice: element['publicRosterNotice'], rows: () => (list as unknown as Node).children,
    text: () => (list as unknown as Node).children.map(row => row.textContent) };
}
function replacement(client: StageClient, update: Partial<RoomStatePayload> = {}): RoomStatePayload {
  const old = client.state!;
  return { roomId: old.roomId, name: old.name, controllerId: old.controllerId,
    speakers: old.speakers.map(person => ({ ...person })), hands: [], audienceCount: old.audienceCount,
    codeRequired: false, recording: false, recordingAvailable: false, limits: { ...old.limits }, status: old.status, me: { ...old.me }, ...update };
}
async function receive(client: StageClient, state: RoomStatePayload): Promise<void> {
  await client['receive']({ type: 'room:state', ...state }); await drain();
}

it('public snapshot is passive, native, collapsed, ordered and available to all viewer roles', async t => {
  const f = await setup(t), r = roster(f.element), sent = f.socket.sent.length;
  assert.equal(r.panel.tagName, 'DETAILS'); assert.equal(r.panel.hidden, false); assert.equal(r.panel.open, false);
  const children = (r.panel as unknown as Node).children;
  assert.equal(children[0]!.tagName, 'SUMMARY'); assert.equal(children[0]!.textContent, '台上成員快照');
  assert.equal(r.list.tagName, 'UL'); assert.ok(r.rows().every(row => row.tagName === 'LI'));
  assert.deepEqual(r.text(), ['Silent Controller · 主控 · 未靜音 · 控制連線已連接',
    'Silent Speaker · 發言者 · 未靜音 · 控制連線已連接']);
  assert.ok(!allNodes(r.panel as unknown as Node).some(node => ['BUTTON', 'INPUT', 'SELECT'].includes(node.tagName)));
  assert.ok(allNodes(r.panel as unknown as Node).every(node => !node.id && node.attributes.size === 0));
  r.panel.open = true;
  assert.ok(f.text().includes('Silent Controller')); assert.ok(f.text().includes('Silent Speaker'));
  assert.equal(f.socket.sent.length, sent);
  await f.request(f.socket.session, { type: 'hand:raise' });
  await f.request(f.hostSession, { type: 'stage:approve', targetId: f.client.me!.participantId });
  assert.equal(f.client.me!.role, 'speaker'); assert.equal(r.panel.hidden, false); assert.equal(r.panel.open, true);
  await f.request(f.hostSession, { type: 'control:transfer', targetId: f.client.me!.participantId });
  assert.equal(f.client.me!.role, 'controller'); assert.equal(r.panel.hidden, false);
  await f.request(f.socket.session, { type: 'stage:leave' });
  assert.equal(f.client.me!.role, 'controller'); assert.equal(f.client.me!.onStage, false);
  assert.equal(r.panel.hidden, false); assert.ok(r.text().every(text => !text.startsWith('Roster Reader')));
});

it('safe names, effective/forced mute, grace seats and empty snapshots use only public metadata', async t => {
  const f = await setup(t), r = roster(f.element);
  await f.request(f.speakerSession, { type: 'participant:rename', name: '<b>&"\'' });
  await f.request(f.speakerSession, { type: 'mic:unmute' });
  assert.match(r.text()[1]!, /^<b>&"' · 發言者 · 未靜音/);
  assert.equal(r.rows()[1]!.children.length, 0);
  await f.request(f.hostSession, { type: 'mic:force-mute', targetId: f.speakerId });
  assert.match(r.text()[1]!, /主控鎖定靜音/);
  await f.h.hub.detach(f.speakerSession); await drain();
  assert.match(r.text()[1]!, /控制連線中斷，保留席位/);
  await f.request(f.hostSession, { type: 'stage:leave' });
  assert.equal(r.text().length, 1); assert.ok(!r.text()[0]!.includes('Silent Controller'));
  await f.request(f.hostSession, { type: 'stage:remove', targetId: f.speakerId });
  assert.deepEqual(r.text(), []); assert.equal(r.panel.hidden, false); assert.match(r.notice.textContent!, /最近快照：沒有台上成員/);
});

it('role and stage-left deltas keep copied snapshot order until the authoritative state', async t => {
  const f = await setup(t), r = roster(f.element), before = r.text();
  const observed: string[][] = [];
  for (const name of ['stage-role', 'stage-stageleft']) f.element.addEventListener(name, () => {
    observed.push(r.text()); assert.match(r.notice.textContent!, /上次快照，等待新快照/);
  });
  await f.request(f.hostSession, { type: 'stage:remove', targetId: f.speakerId });
  assert.deepEqual(observed, [before, before]); assert.equal(r.text().length, 1);
  assert.match(r.notice.textContent!, /最近快照/);
});

it('reconnect preserves copied history and open choice; status alone and replay cannot refresh it', async t => {
  const f = await setup(t), r = roster(f.element), before = r.text(), snapshot = f.client.state!;
  r.panel.open = true; f.socket.close(); await f.tick(1);
  assert.equal(f.client.status, 'reconnecting'); assert.deepEqual(r.text(), before);
  assert.match(r.notice.textContent!, /重新連線中，上次快照/); assert.equal(r.panel.open, true);
  snapshot.speakers[0]!.name = 'Raw mutation';
  await f.client['receive']({ type: 'status', state: 'live' });
  assert.deepEqual(r.text(), before); assert.match(r.notice.textContent!, /上次快照/);
  f.client['emit']('state', snapshot);
  assert.deepEqual(r.text(), before); assert.match(r.notice.textContent!, /上次快照/);
  await receive(f.client, replacement(f.client));
  assert.match(r.text()[0]!, /^Raw mutation/); assert.match(r.notice.textContent!, /最近快照/);
});

it('equivalent snapshots and unrelated reports never rewrite or rescan the copied rows', async t => {
  const f = await setup(t), r = roster(f.element), originalRows = [...r.rows()], originalText = r.text();
  r.panel.open = true;
  let writes = 0;
  for (const row of originalRows) {
    let text = row.textContent;
    Object.defineProperty(row, 'textContent', { configurable: true, get: () => text, set(value) { writes++; text = value; } });
  }
  const replace = t.mock.method(r.list, 'replaceChildren', () => { throw new Error('unexpected list rebuild'); });
  await receive(f.client, replacement(f.client));
  const current = f.client.state!;
  let privateReads = 0;
  for (const key of ['audience', 'code', 'resumeToken']) Object.defineProperty(current, key, { configurable: true, get() { privateReads++; throw new Error('private roster read'); } });
  Object.defineProperty(current.speakers[0]!, 'name', { configurable: true, get() { throw new Error('unrelated event rescanned name'); } });
  f.socket.deliver({ type: 'quality', participants: [] });
  f.socket.deliver({ type: 'speaking', participantIds: [] });
  assert.deepEqual(r.text(), originalText); assert.deepEqual(r.rows(), originalRows);
  assert.equal(writes, 0); assert.equal(replace.mock.callCount(), 0); assert.equal(privateReads, 0); assert.equal(r.panel.open, true);
  replace.mock.restore();
});

it('changed rows reuse identities and reordered arrays reuse their keyed nodes', async t => {
  const f = await setup(t), r = roster(f.element), originalRows = [...r.rows()];
  const changed = replacement(f.client); changed.speakers[1]!.name = 'Changed';
  await receive(f.client, changed);
  assert.deepEqual(r.rows(), originalRows); assert.match(r.text()[1]!, /^Changed/);
  const reordered = replacement(f.client); reordered.speakers.reverse();
  await receive(f.client, reordered);
  assert.equal(r.rows()[0], originalRows[1]); assert.equal(r.rows()[1], originalRows[0]);
});

it('actual advertised limits allow more than eight speakers and one additional controller', async t => {
  const f = await setup(t, 12), r = roster(f.element), initial = replacement(f.client);
  const controller = initial.speakers[0]!, speaker = initial.speakers[1]!;
  initial.speakers = [controller, ...Array.from({ length: 12 }, (_, index) => ({ ...speaker, participantId: `speaker-${index}`, name: `Speaker ${index}` }))];
  await receive(f.client, initial); assert.equal(r.text().length, 13);
  const small = replacement(f.client, { limits: { maxSpeakers: 1, maxAudience: 300 }, speakers: [controller, speaker] });
  await receive(f.client, small); assert.equal(r.text().length, 2);
  await receive(f.client, replacement(f.client, { limits: { maxSpeakers: Number.MAX_SAFE_INTEGER, maxAudience: 300 } }));
  assert.equal(r.text().length, 2);
});

it('malformed public projections fail closed without partial rows or private fields', async t => {
  const f = await setup(t), r = roster(f.element), good = replacement(f.client);
  const cases: ((state: RoomStatePayload) => void)[] = [
    state => { state.limits.maxSpeakers = 0; }, state => { state.limits.maxSpeakers = NaN; },
    state => { state.limits.maxSpeakers = 1.5; }, state => { state.limits.maxSpeakers = Number.MAX_SAFE_INTEGER + 1; },
    state => { state.speakers.push({ ...state.speakers[1]! }); },
    state => { state.speakers[1]!.onStage = false; }, state => { state.speakers[1]!.role = 'audience'; },
    state => { state.speakers[1]!.name = 42 as unknown as string; },
    state => { state.speakers[1]!.connected = 'true' as unknown as boolean; },
    state => { state.speakers[1]!.muted = null as unknown as boolean; },
    state => { state.speakers[1]!.forceMuted = 1 as unknown as boolean; },
    state => { state.speakers[1]!.forceMuted = true; state.speakers[1]!.muted = false; },
    state => { state.controllerId = 'wrong-controller'; },
    state => { state.speakers[1]!.role = 'controller'; },
    state => { state.speakers[1]!.participantId = ''; },
    state => { state.limits.maxSpeakers = 1; state.speakers.push({ ...state.speakers[1]!, participantId: 'third' }); },
  ];
  for (const mutate of cases) {
    await receive(f.client, { ...good, speakers: good.speakers.map(person => ({ ...person })), limits: { ...good.limits } });
    r.panel.open = true;
    const invalid = replacement(f.client); mutate(invalid);
    await receive(f.client, invalid);
    assert.equal(r.panel.hidden, true); assert.equal(r.panel.open, false); assert.deepEqual(r.text(), []);
  }
});

it('copied state is unchanged by forwarded-host mutation and only a fresh receipt changes it', async t => {
  const f = await setup(t), r = roster(f.element), before = r.text();
  f.element.addEventListener('stage-state', event => {
    const detail = (event as CustomEvent<RoomStatePayload>).detail;
    detail.speakers[0]!.name = 'Mutated after receipt'; detail.speakers.reverse();
  }, { once: true });
  await receive(f.client, replacement(f.client));
  assert.deepEqual(r.text(), before);
  await receive(f.client, replacement(f.client));
  assert.match(r.text()[1]!, /^Mutated after receipt/);
});

it('terminal, own-seat replacement, detach and manual leave clear names and collapse', async t => {
  const f = await setup(t), r = roster(f.element), original = replacement(f.client);
  for (const terminal of [{ type: 'room:closed', roomId: f.roomId }, { type: 'kicked', roomId: f.roomId }] as const) {
    r.panel.open = true;
    await f.client['receive'](terminal);
    assert.equal(r.panel.hidden, true); assert.equal(r.panel.open, false); assert.deepEqual(r.text(), []);
    await receive(f.client, { ...original, speakers: original.speakers.map(person => ({ ...person })) });
    assert.equal(r.panel.hidden, false);
  }
  r.panel.open = true;
  await receive(f.client, replacement(f.client, { me: { ...f.client.me!, participantId: 'new-seat' } }));
  assert.equal(r.panel.open, false); assert.equal(r.panel.hidden, false);
  r.panel.open = true; f.element['changeRoomPresence'](); await drain();
  assert.equal(r.panel.hidden, true); assert.equal(r.panel.open, false); assert.deepEqual(r.text(), []);
  f.element['current'] = f.client;
  await receive(f.client, original);
  Object.assign(f.element, { isConnected: false }); f.element.disconnectedCallback(); await drain();
  assert.equal(r.panel.hidden, true); assert.equal(r.panel.open, false); assert.deepEqual(r.text(), []);
});

it('a nested newer state wins when an old row text setter completes late', async t => {
  const f = await setup(t), r = roster(f.element), row = r.rows()[1]!, original = row.textContent;
  let stored = original, nested = false;
  Object.defineProperty(row, 'textContent', { configurable: true, get: () => stored, set(value: string) {
    if (!nested && value.startsWith('Outer')) {
      nested = true; const next = replacement(f.client); next.speakers[1]!.name = 'Winner';
      void f.client['receive']({ type: 'room:state', ...next });
    }
    stored = value;
  } });
  const outer = replacement(f.client); outer.speakers[1]!.name = 'Outer'; await receive(f.client, outer);
  assert.equal(nested, true); assert.match(r.text()[1]!, /^Winner/);
});

it('a late list rebuild cannot restore retired names after a nested terminal event', async t => {
  const f = await setup(t), r = roster(f.element), list = r.list as unknown as Node;
  const replace = list.replaceChildren.bind(list); let nested = false;
  t.mock.method(list, 'replaceChildren', (...nodes: Node[]) => {
    if (!nested && nodes.length) { nested = true; void f.client['receive']({ type: 'kicked', roomId: f.roomId }); }
    replace(...nodes);
  });
  const next = replacement(f.client); next.speakers.reverse(); await receive(f.client, next);
  assert.equal(nested, true); assert.equal(r.panel.hidden, true); assert.deepEqual(r.text(), []);
});

for (const boundary of ['room', 'participant', 'status'] as const) it(`observed ${boundary} loss permanently retires an in-flight copied receipt`, async t => {
  const f = await setup(t), r = roster(f.element), outer = replacement(f.client);
  let armed = true;
  Object.defineProperty(outer.speakers[0]!, 'name', { configurable: true, get() {
    if (armed) {
      armed = false; const restoring = f.client.state!, status = f.client.status, lost = replacement(f.client);
      if (boundary === 'room') lost.roomId = 'replacement-room';
      else lost.me.participantId = 'replacement-seat';
      f.client['snapshot'] = lost;
      if (boundary === 'status') f.client['currentStatus'] = 'disconnected';
      f.element['syncPublicRoster']();
      f.client['snapshot'] = restoring; f.client['currentStatus'] = status;
    }
    return 'Retired payload';
  } });
  await receive(f.client, outer);
  assert.equal(armed, false); assert.equal(r.panel.hidden, true); assert.deepEqual(r.text(), []);
  f.client['emit']('state', f.client.state!);
  assert.equal(r.panel.hidden, true); assert.deepEqual(r.text(), []);
  const fresh = replacement(f.client); fresh.speakers[0]!.name = 'Fresh payload';
  await receive(f.client, fresh); assert.match(r.text()[0]!, /^Fresh payload/);
});
