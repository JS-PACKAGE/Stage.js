import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { after, it, type TestContext } from 'node:test';
import { StageClient, type MicTestOptions } from '../src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class TestTrack extends EventTarget {
  enabled = true; readyState = 'live'; stops = 0; onStop: (() => void) | undefined;
  stop(): void { this.stops++; this.readyState = 'ended'; this.onStop?.(); }
  end(): void { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
class StageSocket {
  static OPEN = 1; static instances: StageSocket[] = [];
  readyState = StageSocket.OPEN; readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor() { StageSocket.instances.push(this); }
  deliver(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(data: string): void {
    assert.equal(this.readyState, StageSocket.OPEN); const message = JSON.parse(data) as ClientMessage; this.sent.push(message);
    if (message.type === 'rtc:offer') queueMicrotask(() => {
      this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
      this.deliver({ type: 'ok', requestId: message.requestId });
    });
  }
  close(): void { this.readyState = 3; this.onclose?.(); }
}
class StagePeer {
  static instances: StagePeer[] = [];
  connectionState = 'connected'; signalingState = 'stable'; localDescription: { type: 'offer'; sdp: string } | null = null;
  readonly offers: string[] = []; readonly replacements: (TestTrack | null)[] = [];
  readonly transceiver = { direction: 'recvonly', sender: { track: null as TestTrack | null,
    replaceTrack: async (track: TestTrack | null) => { this.replacements.push(track); this.transceiver.sender.track = track; } } };
  constructor() { StagePeer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  async createOffer() {
    this.offers.push(this.transceiver.direction);
    return { type: 'offer' as const, sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` };
  }
  async setLocalDescription(description: { type: 'offer'; sdp: string }): Promise<void> { this.localDescription = description; this.signalingState = 'have-local-offer'; }
  async setRemoteDescription(): Promise<void> { this.signalingState = 'stable'; }
  async addIceCandidate(): Promise<void> {}
  close(): void { this.connectionState = 'closed'; }
}

// Controlled host DOM only. This is not a native browser, layout, keyboard or AT fixture.
export class HostNode extends EventTarget {
  readonly children: HostNode[] = []; readonly part = new Set<string>(); readonly attributes = new Map<string, string>();
  parent: HostNode | null = null; shadowRoot: HostNode | null = null;
  hidden = false; open = false; disabled = false; textContent = ''; className = ''; type = ''; id = ''; tagName = '';
  private attached = false;
  get isConnected(): boolean { return this.parent ? this.parent.isConnected : this.attached; }
  set isConnected(value: boolean) { this.attached = value; }
  value: string | number = ''; selected = false; min: string | number = ''; max: string | number = ''; step = '';
  onclick?: () => void; oninput?: (event: Event) => void; onchange?: (event: Event) => void;
  contains(node: HostNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
  append(...nodes: HostNode[]): void { for (const node of nodes) { node.parent = this; node.isConnected = this.isConnected; this.children.push(node); } }
  replaceChildren(...nodes: HostNode[]): void { for (const child of this.children) child.parent = null; this.children.splice(0); this.append(...nodes); }
  remove(): void { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; this.isConnected = false; }
  attachShadow(): HostNode { const root = new HostNode(); this.shadowRoot = root; root.parent = this; return root; }
  setAttribute(name: string, value: string): void { const old = this.getAttribute(name); this.attributes.set(name, value); this.changed(name, old, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { const old = this.getAttribute(name); this.attributes.delete(name); this.changed(name, old, null); }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  toggleAttribute(name: string, force: boolean): boolean { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); return force; }
  private changed(name: string, old: string | null, value: string | null): void {
    const instance = this as unknown as { attributeChangedCallback?(name: string, old: string | null, value: string | null): void };
    if (old !== value && (this.constructor as unknown as { observedAttributes?: string[] }).observedAttributes?.includes(name)) instance.attributeChangedCallback?.(name, old, value);
  }
  click(): void { if (!this.disabled) this.onclick?.(); }
}
export class HostAudio extends HostNode {
  volume = 1; muted = false; srcObject: unknown = null; plays = 0; pauses = 0;
  play(): Promise<void> { this.plays++; return Promise.resolve(); } pause(): void { this.pauses++; }
}
export class MeterContext {
  static instances: MeterContext[] = [];
  closes = 0; resumes = 0; reads = 0; sourceDisconnects = 0; analyserDisconnects = 0;
  readonly destination = {}; readonly connections: unknown[] = [];
  readonly analyser = { fftSize: 2048, getFloatTimeDomainData: (samples: Float32Array) => { this.reads++; samples.fill(0.25); }, disconnect: () => { this.analyserDisconnects++; } };
  constructor() { MeterContext.instances.push(this); }
  createMediaStreamSource() { return { connect: (target: unknown) => { this.connections.push(target); }, disconnect: () => { this.sourceDisconnects++; } }; }
  createAnalyser() { return this.analyser; }
  async resume(): Promise<void> { this.resumes++; } async close(): Promise<void> { this.closes++; }
}
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: HostNode });
const { StageElement } = await import('../src/element.ts');
after(() => { if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement); else Reflect.deleteProperty(globalThis, 'HTMLElement'); });
export type Widget = InstanceType<typeof StageElement>;
export const nodes = (node: HostNode): HostNode[] => [node, ...node.children.flatMap(nodes)];
export function button(element: Widget, label: string): HostNode {
  const result = nodes(element.shadowRoot as unknown as HostNode).find(node => node.tagName === 'BUTTON' && node.textContent === label);
  assert.ok(result, `button ${label}`); return result;
}
export function byId(element: Widget, id: string): HostNode {
  const result = nodes(element.shadowRoot as unknown as HostNode).find(node => node.id === id); assert.ok(result, `id ${id}`); return result;
}
export const flush = async (): Promise<void> => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
export function state(overrides: Partial<RoomStatePayload> = {}): RoomStatePayload { return { roomId: 'same-room', name: '測試舞台', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', resumeToken: 'test-resume',
    me: { participantId: 'guest', name: '測試聽眾', role: 'audience', onStage: false, handRaised: false, muted: false,
      forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 }, ...overrides }; }

export async function widgetFixture(t: TestContext, initial = state()) {
  StageSocket.instances = []; StagePeer.instances = []; MeterContext.instances = [];
  const elements: Widget[] = [], audio: HostAudio[] = [];
  const tracks: TestTrack[] = [];
  const captures: { constraints: unknown; settled: boolean; resolve(): typeof tracks[number]; reject(error: unknown): void }[] = [];
  let enumerations = 0;
  const pageDocument = Object.assign(new EventTarget(), { hidden: false, body: Object.assign(new HostNode(), { isConnected: true }),
    createElement(tag: string) {
      assert.ok(['style', 'div', 'p', 'button', 'label', 'input', 'select', 'option', 'ul', 'li', 'span', 'audio', 'details', 'summary', 'meter'].includes(tag), `unmodeled tag ${tag}`);
      const node = tag === 'audio' ? new HostAudio() : new HostNode(); node.tagName = tag.toUpperCase(); if (node instanceof HostAudio) audio.push(node); return node;
    } });
  const pageWindow = Object.assign(new EventTarget(), { confirm: (): boolean => false });
  const globals = { document: pageDocument, window: pageWindow, WebSocket: StageSocket, RTCPeerConnection: StagePeer, AudioContext: MeterContext,
    navigator: { mediaDevices: { enumerateDevices: async () => { enumerations++; return [{ kind: 'audioinput', deviceId: 'test-input', label: 'Synthetic mic' }]; },
      getUserMedia(constraints: unknown) {
        const pending = deferred<unknown>();
        const request = { constraints, settled: false, resolve() {
          assert.equal(this.settled, false); this.settled = true;
          const track = new TestTrack();
          tracks.push(track); pending.resolve({ getTracks: () => [track], getAudioTracks: () => [track] }); return track;
        }, reject(error: unknown) { assert.equal(this.settled, false); this.settled = true; pending.reject(error); } };
        captures.push(request); return pending.promise;
      } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 1000; t.mock.method(performance, 'now', () => now);
  const tick = async (ms = 1): Promise<void> => { now += ms; t.mock.timers.tick(ms); await flush(); };
  const until = async (check: () => boolean, reason: string): Promise<void> => { for (let count = 0; count < 100 && !check(); count++) await tick(); assert.ok(check(), reason); };
  const joinLatest = async (snapshot = initial) => {
    await flush(); const socket = StageSocket.instances.at(-1)!; assert.ok(socket);
    socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'fixture', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
    await until(() => socket.sent.some(message => message.type === 'join'), 'actual SDK join');
    const join = socket.sent.find(message => message.type === 'join')!;
    socket.deliver({ type: 'room:state', ...snapshot }); socket.deliver({ type: 'ok', requestId: join.requestId });
    const peer = StagePeer.instances.at(-1)!;
    await until(() => peer.localDescription !== null && peer.signalingState === 'stable', 'actual SDK recvonly negotiation');
    return { socket, peer };
  };
  const mount = async (snapshot = initial) => {
    const element = new StageElement(); elements.push(element);
    element.setAttribute('url', 'wss://synthetic.invalid/ws'); element.setAttribute('room', snapshot.roomId); element.setAttribute('name', 'Synthetic listener');
    Object.assign(element, { isConnected: true }); element.connectedCallback();
    const joined = await joinLatest(snapshot), client = element.client; assert.ok(client instanceof StageClient);
    return { element, client, ...joined };
  };
  t.after(async () => {
    try {
      for (const element of elements) { Object.assign(element, { isConnected: false }); element.disconnectedCallback(); }
      for (const request of captures) if (!request.settled) request.reject(new DOMException('fixture teardown', 'AbortError'));
      await flush();
      assert.ok(tracks.every(track => track.stops === 1), 'every fake track is stopped once');
      assert.ok(MeterContext.instances.every(context => context.closes === 1), 'every fake context is closed once');
      assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'), 'every fake peer closed');
    } finally { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
  });
  const joined = await mount();
  return { ...joined, mount, joinLatest, tick, until, elements, audio, captures, tracks, pageDocument, pageWindow, enumerations: () => enumerations };
}

const control = (element: Widget, suffix: string) => byId(element, `mic-test-${suffix}`);
const start = (element: Widget) => control(element, 'start').click();
const meter = (element: Widget) => control(element, 'meter').value;
const invoke = (node: HostNode) => node.onclick?.();
async function active(h: Awaited<ReturnType<typeof widgetFixture>>, element = h.element) {
  start(element); const track = h.captures.at(-1)!.resolve(); await flush(); return track;
}

it('uses labelled native controls and a local status without passive capture, playback, publication or signaling', async t => {
  const h = await widgetFixture(t);
  const before = { sent: h.socket.sent.length, offers: h.peer.offers.length, replacements: h.peer.replacements.length, plays: h.audio[0]!.plays };
  assert.equal(control(h.element, 'panel').hidden, false);
  for (const suffix of ['start', 'cancel', 'stop']) {
    assert.equal(control(h.element, suffix).tagName, 'BUTTON'); assert.equal(control(h.element, suffix).type, 'button');
  }
  assert.equal(control(h.element, 'meter').tagName, 'METER'); assert.equal(control(h.element, 'meter').min, 0); assert.equal(control(h.element, 'meter').max, 1);
  assert.ok(nodes(h.element.shadowRoot as unknown as HostNode).some(node => node.tagName === 'LABEL' && node.getAttribute('for') === 'mic-test-meter' && node.textContent.length));
  assert.equal(control(h.element, 'status').getAttribute('role'), 'status'); assert.equal(control(h.element, 'status').getAttribute('aria-live'), 'polite');
  await h.tick(1000); assert.equal(h.captures.length, 0);
  const track = await active(h); assert.equal(meter(h.element), 0.25); assert.equal(control(h.element, 'stop').hidden, false);
  assert.equal(h.client.micLevel, 0); assert.equal(h.peer.transceiver.sender.track, null); assert.equal(h.peer.transceiver.direction, 'recvonly');
  assert.deepEqual({ sent: h.socket.sent.length, offers: h.peer.offers.length, replacements: h.peer.replacements.length, plays: h.audio[0]!.plays }, before);
  assert.deepEqual(MeterContext.instances[0]!.connections, [MeterContext.instances[0]!.analyser]);
  control(h.element, 'stop').click(); assert.equal(track.stops, 1); assert.equal(meter(h.element), 0); assert.equal(control(h.element, 'start').disabled, false);
});

it('reserves one pending lane before API lookup and keeps micready pending until its promise settles', async t => {
  const h = await widgetFixture(t); let pendingAtReady = false;
  h.element.addEventListener('stage-micready', () => {
    pendingAtReady = !control(h.element, 'cancel').hidden && control(h.element, 'stop').hidden;
    invoke(control(h.element, 'start'));
  });
  start(h.element); invoke(control(h.element, 'start')); assert.equal(h.captures.length, 1);
  h.captures[0]!.resolve(); await flush(); assert.equal(pendingAtReady, true); assert.equal(h.captures.length, 1);
});

for (const completion of ['grant', 'denial'] as const) it(`cancel aborts pending SDK work and handles late ${completion} without reviving UI`, async t => {
  const h = await widgetFixture(t); start(h.element); control(h.element, 'cancel').click();
  assert.equal(control(h.element, 'cancel').hidden, true); assert.equal(meter(h.element), 0);
  invoke(control(h.element, 'start')); assert.equal(h.captures.length, 1, 'lane held synchronously until settlement');
  await flush(); assert.equal(control(h.element, 'start').disabled, false);
  if (completion === 'grant') { const track = h.captures[0]!.resolve(); await flush(); assert.equal(track.stops, 1); }
  else { h.captures[0]!.reject(new Error('raw secret failure')); await flush(); }
  assert.equal(MeterContext.instances.length, 0); assert.equal(meter(h.element), 0); assert.doesNotMatch(control(h.element, 'status').textContent, /raw secret/);
});

it('denial has fixed local status, preserves the global SDK error, and requires explicit retry', async t => {
  const h = await widgetFixture(t);
  h.socket.deliver({ type: 'error', code: 'conflict', message: '既有全域錯誤' }); await flush();
  const globalError = nodes(h.element.shadowRoot as unknown as HostNode).find(node => node.part.has('error'))!;
  start(h.element); h.captures[0]!.reject(new Error('permission detail must stay private')); await flush();
  assert.match(control(h.element, 'status').textContent, /無法完成/); assert.doesNotMatch(control(h.element, 'status').textContent, /permission/);
  assert.equal(globalError.textContent, '既有全域錯誤');
  h.socket.deliver({ type: 'room:state', ...state() }); await h.tick(500); assert.equal(h.captures.length, 1);
  await active(h); assert.equal(h.captures.length, 2); assert.equal(globalError.textContent, '既有全域錯誤');
});

it('natural end clears the meter and timer; explicit Stop stays idempotent', async t => {
  const h = await widgetFixture(t), track = await active(h), context = MeterContext.instances[0]!;
  const reads = context.reads; await h.tick(99); assert.equal(context.reads, reads); await h.tick(1); assert.equal(context.reads, reads + 1);
  track.end(); await h.tick(100); assert.equal(meter(h.element), 0); assert.match(control(h.element, 'status').textContent, /已結束/);
  const endedReads = context.reads; invoke(control(h.element, 'stop')); await h.tick(1000); assert.equal(context.reads, endedReads); assert.equal(track.stops, 1);
});

for (const notice of ['invite', 'stagejoined'] as const) it(`early own ${notice} retires before forwarding, does not reopen on old offstage state, and leaves stage capture independent`, async t => {
  const h = await widgetFixture(t), track = await active(h), stale = h.client.state!; let forwarded = false;
  h.element.addEventListener(`stage-${notice}`, () => {
    forwarded = true; assert.equal(track.stops, 1); assert.equal(control(h.element, 'panel').hidden, true); invoke(control(h.element, 'start'));
  });
  h.socket.deliver(notice === 'invite' ? { type: 'stage:invite', participantId: 'guest', byId: 'host' } : { type: 'stage:joined', participantId: 'guest', role: 'speaker' });
  assert.equal(forwarded, true); assert.equal(h.captures.length, 1);
  h.element.setAttribute('playback-muted', ''); assert.equal(control(h.element, 'panel').hidden, true);
  h.client.dispatchEvent(new CustomEvent('state', { detail: stale })); assert.equal(control(h.element, 'panel').hidden, true);
  const onStage = state({ me: { ...state().me, onStage: true, role: 'speaker' } }); h.socket.deliver({ type: 'room:state', ...onStage }); await flush();
  assert.equal(h.captures.length, 2); const roomTrack = h.captures[1]!.resolve(); await h.until(() => h.peer.transceiver.sender.track === roomTrack, 'stage microphone installed');
  invoke(control(h.element, 'start')); invoke(control(h.element, 'stop')); await h.tick(100); assert.equal(roomTrack.stops, 0); assert.equal(h.client.micLevel, 0.25);
});

it('another participant early notice retains preview while authoritative own onstage retires before normal capture', async t => {
  const h = await widgetFixture(t), track = await active(h);
  h.socket.deliver({ type: 'stage:joined', participantId: 'other', role: 'speaker' }); assert.equal(track.stops, 0);
  h.socket.deliver({ type: 'room:state', ...state({ me: { ...state().me, onStage: true, role: 'speaker' } }) }); await flush();
  assert.equal(track.stops, 1); assert.equal(control(h.element, 'panel').hidden, true); assert.equal(h.captures.length, 2);
  h.captures[1]!.resolve(); await flush();
});

for (const boundary of ['hidden', 'pagehide', 'reconnect', 'closed', 'kicked', 'detach', 'leave'] as const) {
  for (const pending of [false, true]) it(`${boundary} retires ${pending ? 'pending' : 'active'} preview and never restarts on restoration`, async t => {
    const h = await widgetFixture(t); let track: typeof h.tracks[number] | undefined;
    if (pending) start(h.element); else track = await active(h);
    if (boundary === 'hidden') { h.pageDocument.hidden = true; h.pageDocument.dispatchEvent(new Event('visibilitychange')); }
    else if (boundary === 'pagehide') h.pageWindow.dispatchEvent(new Event('pagehide'));
    else if (boundary === 'reconnect') h.socket.close();
    else if (boundary === 'closed') h.socket.deliver({ type: 'room:closed', roomId: 'same-room' });
    else if (boundary === 'kicked') h.socket.deliver({ type: 'kicked', roomId: 'same-room' });
    else if (boundary === 'detach') { Object.assign(h.element, { isConnected: false }); h.element.disconnectedCallback(); }
    else button(h.element, '離開房間').click();
    await flush(); if (track) assert.equal(track.stops, 1);
    assert.equal(meter(h.element), 0); assert.equal(control(h.element, 'panel').hidden, true);
    if (pending) { track = h.captures[0]!.resolve(); await flush(); assert.equal(track.stops, 1); }
    if (boundary === 'hidden') { h.pageDocument.hidden = false; h.pageDocument.dispatchEvent(new Event('visibilitychange')); }
    if (boundary === 'pagehide') h.pageWindow.dispatchEvent(new Event('pageshow'));
    await flush(); assert.equal(h.captures.length, 1);
  });
}

for (const attr of ['url', 'room', 'code', 'name'] as const) it(`${attr} changes retire exact old binding before reentrant stop and new entry`, async t => {
  const h = await widgetFixture(t), track = await active(h);
  track.onStop = () => { invoke(control(h.element, 'start')); };
  h.element.setAttribute(attr, attr === 'url' ? 'wss://other-synthetic.invalid/ws' : 'replacement'); await flush();
  assert.equal(track.stops, 1); assert.equal(h.captures.length, 1); assert.notEqual(h.element.client, h.client);
  await h.joinLatest(state({ roomId: attr === 'room' ? 'replacement' : 'same-room' })); assert.equal(h.captures.length, 1);
  await active(h); assert.equal(h.captures.length, 2);
});

it('playback attributes keep a valid test and the manual Leave/remount contract', async t => {
  const h = await widgetFixture(t), track = await active(h);
  h.element.setAttribute('playback-volume', '0.4'); h.element.setAttribute('playback-muted', ''); assert.equal(track.stops, 0); assert.equal(h.element.client, h.client);
  button(h.element, '離開房間').click(); await flush(); assert.equal(track.stops, 1);
  const sockets = StageSocket.instances.length;
  Object.assign(h.element, { isConnected: false }); h.element.disconnectedCallback(); h.element.setAttribute('name', 'Changed');
  Object.assign(h.element, { isConnected: true }); h.element.connectedCallback(); await flush(); assert.equal(StageSocket.instances.length, sockets); assert.equal(h.element.client, null);
  button(h.element, '重新加入').click(); await h.joinLatest(); assert.equal(h.captures.length, 1);
});

it('two instances have independent pending lanes and listeners removed exactly on detach', async t => {
  const h = await widgetFixture(t), other = await h.mount();
  assert.equal(getEventListeners(h.pageDocument, 'visibilitychange').length, 2);
  const one = await active(h), two = await active(h, other.element);
  Object.assign(h.element, { isConnected: false }); h.element.disconnectedCallback(); await flush();
  assert.equal(one.stops, 1); assert.equal(two.stops, 0); assert.equal(getEventListeners(h.pageDocument, 'visibilitychange').length, 1);
  assert.equal(meter(other.element), 0.25); h.pageDocument.hidden = true; h.pageDocument.dispatchEvent(new Event('visibilitychange')); assert.equal(two.stops, 1);
});

it('input enumeration and unapplied drafts do not capture; Apply stops preview and reserves against reentry', async t => {
  const h = await widgetFixture(t);
  button(h.element, '重新整理麥克風清單').click(); await flush(); byId(h.element, 'microphone-device').value = 'test-input';
  assert.equal(h.captures.length, 0); const track = await active(h);
  assert.equal((h.captures[0]!.constraints as { audio: { deviceId?: unknown } }).audio.deviceId, undefined);
  track.onStop = () => invoke(control(h.element, 'start'));
  const gate = deferred<void>(), apply = h.client.setInputDevice.bind(h.client);
  t.mock.method(h.client, 'setInputDevice', async (draft: string) => { await gate.promise; return apply(draft); });
  button(h.element, '送出麥克風選擇').click(); assert.equal(track.stops, 1); assert.equal(control(h.element, 'start').disabled, true);
  invoke(control(h.element, 'start')); assert.equal(h.captures.length, 1); gate.resolve(); await flush(); assert.equal(h.captures.length, 1);
  await active(h); assert.deepEqual((h.captures[1]!.constraints as { audio: { deviceId: unknown } }).audio.deviceId, { exact: 'test-input' });
});

it('Apply stops pending test and does not call old client after stop cleanup changes entry', async t => {
  const h = await widgetFixture(t), track = await active(h); let applies = 0;
  t.mock.method(h.client, 'setInputDevice', async () => { applies++; });
  track.onStop = () => h.element.setAttribute('name', 'replacement');
  button(h.element, '送出麥克風選擇').click(); await flush(); assert.equal(applies, 0); assert.equal(h.captures.length, 1);
  await h.joinLatest();
});

for (const boundary of ['cancel', 'detach', 'rejoin'] as const) it(`forwarded micready ${boundary} cannot install a stale handle`, async t => {
  const h = await widgetFixture(t);
  h.element.addEventListener('stage-micready', () => {
    if (boundary === 'cancel') control(h.element, 'cancel').click();
    else if (boundary === 'detach') { Object.assign(h.element, { isConnected: false }); h.element.disconnectedCallback(); }
    else h.element.setAttribute('name', 'replacement');
  }, { once: true });
  start(h.element); const track = h.captures[0]!.resolve(); await flush(); assert.equal(track.stops, 1); assert.equal(meter(h.element), 0); assert.equal(control(h.element, 'stop').hidden, true);
  if (boundary === 'rejoin') await h.joinLatest();
});

it('a canceled wrapper keeps its pending lane until settlement and safely disposes the late handle', async t => {
  const h = await widgetFixture(t), gate = deferred<void>(), native = h.client.startMicTest.bind(h.client);
  t.mock.method(h.client, 'startMicTest', async (options?: MicTestOptions) => { const handle = await native(options); await gate.promise; return handle; });
  start(h.element); const old = h.captures[0]!.resolve(); await flush();
  control(h.element, 'cancel').click(); await flush(); assert.equal(old.stops, 1); assert.equal(control(h.element, 'start').disabled, true);
  h.element.setAttribute('name', 'replacement'); await h.joinLatest(); invoke(control(h.element, 'start')); assert.equal(h.captures.length, 1);
  gate.resolve(); await flush(); assert.equal(control(h.element, 'start').disabled, false);
  const fresh = await active(h); assert.equal(fresh.stops, 0); assert.equal(old.stops, 1);
});

it('a public SDK preview is independent of the widget-owned handle', async t => {
  const h = await widgetFixture(t), owned = await active(h), otherWork = h.client.startMicTest(), track = h.captures[1]!.resolve(), other = await otherWork;
  control(h.element, 'stop').click(); assert.equal(owned.stops, 1); assert.equal(track.stops, 0); assert.equal(other.stopped, false); other.stop();
});

for (const value of [NaN, Infinity, -Infinity, -1, 2]) it(`meter projection safely clamps ${String(value)}`, async t => {
  const h = await widgetFixture(t), native = h.client.startMicTest.bind(h.client);
  t.mock.method(h.client, 'startMicTest', async (options?: MicTestOptions) => {
    const handle = await native(options); return { get stopped() { return handle.stopped; }, level: () => value, stop: () => handle.stop() };
  });
  await active(h); assert.equal(meter(h.element), Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
});

for (const field of ['stopped', 'level'] as const) it(`${field} failure stops exact handle and never reveals raw exception`, async t => {
  const h = await widgetFixture(t), native = h.client.startMicTest.bind(h.client); let fail = false;
  t.mock.method(h.client, 'startMicTest', async (options?: MicTestOptions) => {
    const handle = await native(options); return {
      get stopped() { if (fail && field === 'stopped') throw new Error('PRIVATE_METER'); return handle.stopped; },
      level() { if (fail && field === 'level') throw new Error('PRIVATE_METER'); return handle.level(); }, stop: () => handle.stop(),
    };
  });
  const track = await active(h); fail = true; await h.tick(100); assert.equal(track.stops, 1); assert.equal(meter(h.element), 0);
  assert.match(control(h.element, 'status').textContent, /無法完成/); assert.doesNotMatch(control(h.element, 'status').textContent, /PRIVATE_METER/);
  const reads = MeterContext.instances[0]!.reads; await h.tick(1000); assert.equal(MeterContext.instances[0]!.reads, reads);
});

it('missing method is only inspected after explicit Test and fails locally', async t => {
  const h = await widgetFixture(t); let reads = 0;
  Object.defineProperty(h.client, 'startMicTest', { configurable: true, get() { reads++; return undefined; } });
  h.socket.deliver({ type: 'room:state', ...state() }); await h.tick(1000); assert.equal(reads, 0);
  start(h.element); await flush(); assert.equal(reads, 1); assert.equal(h.captures.length, 0); assert.match(control(h.element, 'status').textContent, /無法完成/);
});

it('method getter cannot borrow the old client under a newly created widget generation', async t => {
  const h = await widgetFixture(t); let calls = 0;
  Object.defineProperty(h.client, 'startMicTest', { configurable: true, get() {
    h.element.setAttribute('room', 'replacement'); return () => { calls++; return Promise.reject(new Error()); };
  } });
  start(h.element); await flush(); assert.equal(calls, 0); assert.equal(h.captures.length, 0); await h.joinLatest(state({ roomId: 'replacement' }));
});

it('level callback that stops and explicitly starts another test cannot erase the new pending owner', async t => {
  const h = await widgetFixture(t), native = h.client.startMicTest.bind(h.client); let wrapped = false, change = false;
  t.mock.method(h.client, 'startMicTest', async (options?: MicTestOptions) => {
    const handle = await native(options); if (wrapped) return handle; wrapped = true;
    return { get stopped() { return handle.stopped; }, level() {
      if (change) { change = false; control(h.element, 'stop').click(); start(h.element); } return 0.9;
    }, stop: () => handle.stop() };
  });
  const old = await active(h); change = true; await h.tick(100); assert.equal(old.stops, 1); assert.equal(h.captures.length, 2);
  assert.equal(control(h.element, 'cancel').disabled, false); const fresh = h.captures[1]!.resolve(); await flush(); assert.equal(meter(h.element), 0.25); assert.equal(fresh.stops, 0);
});

it('stale meter setter is repainted after nested Stop and explicit new Test', async t => {
  const h = await widgetFixture(t), old = await active(h), node = control(h.element, 'meter'); let value = node.value, armed = true;
  Object.defineProperty(node, 'value', { configurable: true, get: () => value, set(next) {
    if (armed) { armed = false; control(h.element, 'stop').click(); start(h.element); } value = next;
  } });
  MeterContext.instances[0]!.analyser.getFloatTimeDomainData = samples => samples.fill(0.7);
  await h.tick(100); assert.equal(old.stops, 1); assert.equal(h.captures.length, 2); assert.equal(meter(h.element), 0);
  h.captures[1]!.resolve(); await flush(); assert.equal(meter(h.element), 0.25);
});

it('removed test controls deny stale handler invocation and stop an active test', async t => {
  const h = await widgetFixture(t), old = await active(h), node = control(h.element, 'start'); node.remove(); invoke(node);
  await h.tick(100); assert.equal(old.stops, 1); assert.equal(h.captures.length, 1); assert.equal(control(h.element, 'panel').hidden, true);
});

for (const action of ['關閉房間', '移交控制權'] as const) it(`known own-role loss is fenced before preview authority getter reenters ${action}`, async t => {
  const initial = state(); initial.me = { ...initial.me, role: 'controller' }; initial.controllerId = 'guest';
  initial.speakers = [{ ...initial.me, participantId: 'speaker', name: 'Other', role: 'speaker', onStage: true }];
  const h = await widgetFixture(t, initial); let armed = true, observed = false, commands = 0;
  h.pageWindow.confirm = () => true;
  t.mock.method(h.client, 'closeRoom', async () => { commands++; }); t.mock.method(h.client, 'transferControl', async () => { commands++; });
  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(h.client), 'state')!.get!;
  Object.defineProperty(h.client, 'state', { configurable: true, get() {
    if (armed) { armed = false; observed = true; button(h.element, action).click(); } return original.call(h.client);
  } });
  h.socket.deliver({ type: 'role:update', participantId: 'guest', role: 'audience' }); await flush(); assert.equal(observed, true); assert.equal(commands, 0);
});

for (const boundary of ['leave', 'entry'] as const) for (const action of ['關閉房間', '移交控制權'] as const) {
  it(`${boundary} revokes consent before preview cleanup can reenter ${action}`, async t => {
    const initial = state(); initial.me = { ...initial.me, role: 'controller' }; initial.controllerId = 'guest';
    initial.speakers = [{ ...initial.me, participantId: 'speaker', name: 'Other', role: 'speaker', onStage: true }];
    const h = await widgetFixture(t, initial), native = h.client.startMicTest.bind(h.client); let commands = 0, armed = true;
    h.pageWindow.confirm = () => true;
    t.mock.method(h.client, 'closeRoom', async () => { commands++; }); t.mock.method(h.client, 'transferControl', async () => { commands++; });
    t.mock.method(h.client, 'startMicTest', async (options?: MicTestOptions) => {
      const handle = await native(options); return { get stopped() { return handle.stopped; }, level: () => handle.level(), stop() {
        handle.stop(); if (armed) { armed = false; button(h.element, action).click(); }
      } };
    });
    await active(h);
    if (boundary === 'leave') button(h.element, '離開房間').click(); else h.element.setAttribute('name', 'replacement');
    await flush(); assert.equal(commands, 0); if (boundary === 'entry') await h.joinLatest(initial);
  });
}

it('newer explicit Leave during preview cleanup wins over outer attribute rejoin', async t => {
  const h = await widgetFixture(t), native = h.client.startMicTest.bind(h.client); let armed = true;
  t.mock.method(h.client, 'startMicTest', async (options?: MicTestOptions) => {
    const handle = await native(options); return { get stopped() { return handle.stopped; }, level: () => handle.level(), stop() {
      handle.stop(); if (armed) { armed = false; button(h.element, '離開房間').click(); }
    } };
  });
  await active(h); const sockets = StageSocket.instances.length; h.element.setAttribute('name', 'replacement'); await flush();
  assert.equal(h.element.client, null); assert.equal(StageSocket.instances.length, sockets); assert.equal(button(h.element, '重新加入').disabled, false);
});

for (const event of ['invite', 'stagejoined'] as const) it(`${event} inside status-before-state cannot be cleared by its already installed snapshot`, async t => {
  const h = await widgetFixture(t), track = await active(h);
  h.element.addEventListener('stage-status', () => {
    h.socket.deliver(event === 'invite' ? { type: 'stage:invite', participantId: 'guest', byId: 'host' } : { type: 'stage:joined', participantId: 'guest', role: 'speaker' });
  }, { once: true });
  h.socket.deliver({ type: 'room:state', ...state({ status: 'waiting' }) }); await flush(); assert.equal(track.stops, 1);
  invoke(control(h.element, 'start')); assert.equal(h.captures.length, 1);
  h.socket.deliver({ type: 'room:state', ...state({ status: 'waiting' }) }); await flush(); await active(h); assert.equal(h.captures.length, 2);
});

for (const fault of ['roomId', 'participantId', 'onStage', 'connected'] as const) it(`malformed public ${fault} fails closed before capture`, async t => {
  const h = await widgetFixture(t), snapshot = h.client.state!;
  if (fault === 'roomId') snapshot.roomId = '  ';
  else if (fault === 'participantId') snapshot.me.participantId = '';
  else if (fault === 'onStage') Reflect.deleteProperty(snapshot.me, 'onStage');
  else Reflect.set(snapshot.me, 'connected', 'yes');
  invoke(control(h.element, 'start')); await flush(); assert.equal(h.captures.length, 0);
});

it('manual Leave and its remount keep widget lifecycle listeners released until explicit Rejoin', async t => {
  const h = await widgetFixture(t); button(h.element, '離開房間').click(); await flush();
  assert.equal(getEventListeners(h.pageDocument, 'visibilitychange').length, 0); assert.equal(getEventListeners(h.pageWindow, 'pagehide').length, 0);
  Object.assign(h.element, { isConnected: false }); h.element.disconnectedCallback();
  Object.assign(h.element, { isConnected: true }); h.element.connectedCallback(); await flush();
  assert.equal(getEventListeners(h.pageDocument, 'visibilitychange').length, 0); assert.equal(getEventListeners(h.pageWindow, 'pagehide').length, 0);
  button(h.element, '重新加入').click(); await h.joinLatest(); assert.equal(getEventListeners(h.pageDocument, 'visibilitychange').length, 1); assert.equal(h.captures.length, 0);
});

it('same-client explicit SDK reentry restores widget listeners only on current authoritative state', async t => {
  const h = await widgetFixture(t); await h.client.disconnect(); await flush();
  assert.equal(getEventListeners(h.pageDocument, 'visibilitychange').length, 0); assert.equal(getEventListeners(h.pageWindow, 'pagehide').length, 0);
  const connected = h.client.connect(); await flush();
  StageSocket.instances.at(-1)!.deliver({ type: 'hello', protocol: 1, serverVersion: 'fixture', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await connected; const joined = h.client.join({ roomId: 'same-room', name: 'Restored' }); await h.joinLatest(); await joined;
  assert.equal(getEventListeners(h.pageDocument, 'visibilitychange').length, 1); assert.equal(h.captures.length, 0); await active(h);
});
