/// <reference lib="dom" />
/// <reference lib="es2024.promise" />
import assert from 'node:assert/strict';
import { after, it, type TestContext } from 'node:test';
import { getEventListeners } from 'node:events';
import { StageSocket, StagePeer, actualState } from '../../../test/fixtures/embedSdkApp.ts';
import { StageClient } from '../src/index.ts';
import type { ParticipantView, RoomStatePayload } from '../../../shared/protocol.ts';

// Controlled host DOM only. This is not a native browser, layout, keyboard or AT fixture.
class HostNode extends EventTarget {
  readonly children: HostNode[] = []; readonly part = new Set<string>(); readonly attributes = new Map<string, string>();
  parent: HostNode | null = null; shadowRoot: HostNode | null = null;
  hidden = false; open = false; disabled = false; textContent = ''; className = ''; type = ''; id = ''; tagName = ''; private connected = false;
  get isConnected(): boolean { return this.parent ? this.parent.isConnected : this.connected; }
  set isConnected(value: boolean) { this.connected = value; }
  value = ''; selected = false; min = ''; max = ''; step = '';
  onclick?: () => void; oninput?: (event: Event) => void; onchange?: (event: Event) => void;
  contains(node: HostNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
  append(...nodes: HostNode[]): void { for (const node of nodes) { node.parent = this; node.isConnected = this.isConnected; this.children.push(node); } }
  replaceChildren(...nodes: HostNode[]): void { for (const child of this.children) child.parent = null; this.children.splice(0); this.append(...nodes); }
  remove(): void { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; this.isConnected = false; }
  attachShadow(): HostNode { const root = new HostNode(); root.parent = this; this.shadowRoot = root; return root; }
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
class HostAudio extends HostNode {
  volume = 1; muted = false; srcObject: unknown = null; plays = 0; pauses = 0;
  play(): Promise<void> { this.plays++; return Promise.resolve(); } pause(): void { this.pauses++; }
}
class MeterContext {
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
type Widget = InstanceType<typeof StageElement>;
const flush = async (): Promise<void> => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function baseState(overrides: Partial<RoomStatePayload> = {}): RoomStatePayload { return { ...actualState({ role: 'audience', onStage: false }), controllerId: 'host', audienceCount: 1, ...overrides }; }

async function widgetFixture(t: TestContext, initial = baseState()) {
  StageSocket.instances = []; StagePeer.instances = []; MeterContext.instances = [];
  const elements: Widget[] = [], audio: HostAudio[] = [];
  const tracks: (EventTarget & { enabled: boolean; stopped: boolean; readyState: string; stops: number; stop(): void; end(): void })[] = [];
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
        const pending = Promise.withResolvers<unknown>();
        const request = { constraints, settled: false, resolve() {
          assert.equal(this.settled, false); this.settled = true;
          const track = Object.assign(new EventTarget(), { enabled: true, stopped: false, readyState: 'live', stops: 0,
            stop() { this.stopped = true; this.stops++; this.readyState = 'ended'; }, end() { this.readyState = 'ended'; (this as unknown as EventTarget).dispatchEvent(new Event('ended')); } });
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
    socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'fixture', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
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

type Fixture = Awaited<ReturnType<typeof widgetFixture>>;
function person(id: string, patch: Partial<ParticipantView> = {}): ParticipantView {
  return { participantId: id, name: `Name-${id}`, role: 'speaker', onStage: true, handRaised: false, muted: false,
    forceMuted: false, connected: true, gainDb: 0, joinedAt: 0, ...patch };
}
function state(patch: Partial<RoomStatePayload> = {}): RoomStatePayload {
  return baseState({ speakers: [person('host', { role: 'controller' }), person('one')], ...patch });
}
function roster(element: Widget) {
  const panel = element['publicRosterPanel'], notice = element['publicRosterNotice'], list = element['publicRosterList'] as unknown as HostNode;
  return { panel, notice, list, text: () => list.children.map(row => row.textContent).join('\n') };
}
// The complete production widget and SDK are imported directly. These private emit/snapshot
// assignments are synthetic callback tests, not wire payloads or claims about Hub getters.
function install(h: Fixture, snapshot: RoomStatePayload) { h.client['snapshot'] = snapshot; h.client['emit']('state', snapshot); }
function cleared(h: Fixture) { const r = roster(h.element); assert.equal(r.panel.hidden, true); assert.equal(r.panel.open, false); assert.equal(r.text(), ''); }

it('ordinary fresh state refreshes names, preserves open choice, and does no signaling/media work', async t => {
  const h = await widgetFixture(t, state()), r = roster(h.element); r.panel.open = true;
  const before = [h.socket.sent.length, h.captures.length, h.peer.offers.length];
  const fresh = state(); fresh.speakers[1]!.name = 'Fresh ordinary'; install(h, fresh);
  assert.equal(r.panel.hidden, false); assert.equal(r.panel.open, true); assert.match(r.text(), /Fresh ordinary/);
  assert.deepEqual([h.socket.sent.length, h.captures.length, h.peer.offers.length], before);
});

for (const boundary of ['room', 'participant'] as const) {
  it(`single exact-current new ${boundary} receipt establishes a fresh collapsed owner`, async t => {
    const h = await widgetFixture(t, state()), r = roster(h.element); r.panel.open = true;
    const fresh = state({ speakers: [person('new-only')] });
    if (boundary === 'room') fresh.roomId = 'new-room'; else fresh.me.participantId = 'new-seat';
    install(h, fresh);
    assert.equal(r.panel.hidden, false); assert.equal(r.panel.open, false); assert.match(r.text(), /Name-new-only/); assert.doesNotMatch(r.text(), /Name-one|Name-host/);
  });
  it(`actual SDK wire new ${boundary} receipt establishes its owner without a second state`, async t => {
    const h = await widgetFixture(t, state()), r = roster(h.element); r.panel.open = true;
    const fresh = state({ speakers: [person('wire-new')] });
    if (boundary === 'room') fresh.roomId = 'wire-room'; else fresh.me.participantId = 'wire-seat';
    const before = StagePeer.instances.length; h.socket.deliver({ type: 'room:state', ...fresh }); await flush();
    if (boundary === 'participant') await h.until(() => StagePeer.instances.length === before + 1 && StagePeer.instances.at(-1)!.signalingState === 'stable', 'new-seat peer');
    assert.equal(r.panel.hidden, false); assert.equal(r.panel.open, false); assert.match(r.text(), /Name-wire-new/);
  });
}

for (const predecessor of [false, true]) for (const boundary of ['room', 'participant', 'status'] as const) {
  it(`${predecessor ? 'PREDECESSOR' : 'PROJECTION'}: observed temporary ${boundary} retirement must reject restored outer state`, async t => {
    const h = await widgetFixture(t, state()), r = roster(h.element); r.panel.open = true;
    if (predecessor) h.socket.deliver({ type: 'speaking', participantIds: ['one'] });
    const outer = state(), trace: string[] = []; let armed = true, observedCleared = false, caller = '';
    const note = h.element['notePublicRosterEvent'].bind(h.element);
    t.mock.method(h.element as unknown as { notePublicRosterEvent: typeof note }, 'notePublicRosterEvent', (...args: Parameters<typeof note>) => { trace.push('tail-note-entry'); return note(...args); });
    const retirement = h.element['publicRosterRevision'], event = h.element['publicRosterEventRevision'];
    Object.defineProperty(outer.speakers[1]!, 'name', { configurable: true, get() {
      if (armed) { armed = false; caller = new Error('getter trace').stack ?? ''; trace.push('name-getter');
        const lost = state(); if (boundary === 'room') lost.roomId = 'temporarily-lost-room';
        else if (boundary === 'participant') lost.me.participantId = 'temporarily-lost-seat';
        h.client['snapshot'] = lost; if (boundary === 'status') h.client['currentStatus'] = 'disconnected';
        h.element['syncPublicRoster']();
        observedCleared = r.panel.hidden && !r.panel.open && r.text() === '' && h.element['publicRosterOwner'] === undefined;
        trace.push(`observed-retirement:${h.element['publicRosterRevision']}`);
        h.client['snapshot'] = outer; h.client['currentStatus'] = 'live'; trace.push('restored-outer');
      }
      return 'STALE-RESTORED';
    } });
    install(h, outer);
    assert.equal(armed, false); assert.equal(observedCleared, true, 'roster really observed retirement while identity was lost');
    assert.equal(h.element['publicRosterEventRevision'], event + 1, 'no nested event or fresh receipt masks the old continuation');
    if (predecessor) { assert.match(caller, /speakingProjection/); assert.equal(trace[0], 'name-getter'); }
    else { assert.match(caller, /notePublicRosterEvent/); assert.equal(trace[0], 'tail-note-entry'); }
    t.diagnostic(JSON.stringify({ predecessor, boundary, beforeRevision: retirement, afterRevision: h.element['publicRosterRevision'], trace,
      finalHidden: r.panel.hidden, finalOpen: r.panel.open, finalText: r.text() }));
    cleared(h);
    // Replay stays rejected; a genuinely new exact-current receipt can recover.
    h.client['emit']('state', outer); cleared(h);
    const fresh = state(); fresh.speakers[1]!.name = 'FRESH-RECOVERY'; install(h, fresh); assert.match(r.text(), /FRESH-RECOVERY/);
  });
}

it('newer nested state wins over suspended outer receipt in predecessor getter', async t => {
  const h = await widgetFixture(t, state()), r = roster(h.element); h.socket.deliver({ type: 'speaking', participantIds: ['one'] });
  const outer = state(), winner = state({ speakers: [person('winner')] }); let armed = true;
  Object.defineProperty(outer.speakers[1]!, 'name', { configurable: true, get() { if (armed) { armed = false; install(h, winner); } return 'STALE-OUTER'; } });
  install(h, outer); assert.equal(armed, false); assert.match(r.text(), /Name-winner/); assert.doesNotMatch(r.text(), /STALE-OUTER/);
});

it('nested terminal event in predecessor getter cannot revive old receipt', async t => {
  const h = await widgetFixture(t, state()); h.socket.deliver({ type: 'speaking', participantIds: ['one'] });
  const outer = state(); let armed = true;
  Object.defineProperty(outer.speakers[1]!, 'name', { configurable: true, get() { if (armed) { armed = false; h.client['emit']('closed', { roomId: outer.roomId }); } return 'STALE-TERMINAL'; } });
  install(h, outer); assert.equal(armed, false); cleared(h);
});

for (const boundary of ['room', 'participant'] as const) it(`legitimate single new ${boundary} survives predecessor observation of its own replacement`, async t => {
  const h = await widgetFixture(t, state()), r = roster(h.element); r.panel.open = true;
  const fresh = state({ speakers: [person('genuine-new')] });
  if (boundary === 'room') fresh.roomId = 'genuine-room'; else fresh.me.participantId = 'genuine-seat';
  let armed = true, observedCleared = false; const trace: string[] = [];
  const note = h.element['notePublicRosterEvent'].bind(h.element);
  t.mock.method(h.element as unknown as { notePublicRosterEvent: typeof note }, 'notePublicRosterEvent', (...args: Parameters<typeof note>) => { trace.push('tail-note-entry'); return note(...args); });
  Object.defineProperty(fresh.me, 'name', { configurable: true, get() {
    if (armed) { armed = false; trace.push('new-me-name-getter'); h.element['syncPublicRoster']();
      observedCleared = r.panel.hidden && !r.panel.open && r.text() === ''; trace.push('observed-new-seat-reset'); }
    return 'Legitimate new reader';
  } });
  install(h, fresh);
  assert.equal(armed, false); assert.equal(observedCleared, true); assert.equal(trace[0], 'new-me-name-getter');
  assert.equal(r.panel.hidden, false); assert.equal(r.panel.open, false); assert.match(r.text(), /Name-genuine-new/);
  assert.equal(h.client.state, fresh); t.diagnostic(JSON.stringify({ boundary, trace, finalText: r.text() }));
});

for (const identity of ['room', 'participant'] as const) for (const loss of ['room', 'participant', 'status'] as const) {
  it(`provisional new ${identity} remains retired after a second ${loss} loss before admission`, async t => {
    const h = await widgetFixture(t, state()), r = roster(h.element), fresh = state(); r.panel.open = true;
    if (identity === 'room') fresh.roomId = 'provisional-room'; else fresh.me.participantId = 'provisional-seat';
    let armed = true;
    Object.defineProperty(fresh.me, 'name', { configurable: true, get() {
      if (armed) { armed = false;
        h.element['syncPublicRoster'](); cleared(h);
        const lost = state({ roomId: fresh.roomId, me: { ...fresh.me } });
        if (loss === 'room') lost.roomId = 'lost-provisional-room';
        else if (loss === 'participant') lost.me.participantId = 'lost-provisional-seat';
        else h.client['currentStatus'] = 'disconnected';
        h.client['snapshot'] = lost; h.element['syncPublicRoster']();
        h.client['snapshot'] = fresh; h.client['currentStatus'] = 'live';
      }
      return 'Provisional reader';
    } });
    install(h, fresh); assert.equal(armed, false); cleared(h);
    assert.equal(h.element['publicRosterPending'], undefined, 'callback releases its token');
    h.client['emit']('state', fresh); cleared(h);
    const recovery = state({ roomId: fresh.roomId, me: { ...fresh.me } }); install(h, recovery);
    assert.equal(r.panel.hidden, false); assert.equal(r.panel.open, false);
  });
}

it('reconnect preserves copied history and open choice; a fresh receipt alone refreshes it', async t => {
  const h = await widgetFixture(t, state()), r = roster(h.element), text = r.text(), snapshot = h.client.state!;
  r.panel.open = true; snapshot.speakers[1]!.name = 'Raw unread change';
  h.client['currentStatus'] = 'reconnecting'; h.client['emit']('status', 'reconnecting');
  assert.equal(r.text(), text); assert.equal(r.panel.open, true); assert.match(r.notice.textContent!, /重新連線中，上次快照/);
  h.client['currentStatus'] = 'live'; h.client['emit']('status', 'live'); h.client['emit']('state', snapshot);
  assert.equal(r.text(), text); assert.match(r.notice.textContent!, /上次快照/);
  const fresh = state(); fresh.speakers[1]!.name = 'Fresh historical successor'; install(h, fresh);
  assert.match(r.text(), /Fresh historical successor/); assert.equal(r.panel.open, true); assert.match(r.notice.textContent!, /最近快照/);
});

it('equivalent receipts and no-op paints preserve row identities with no signaling or media work', async t => {
  const h = await widgetFixture(t, state()), r = roster(h.element), rows = [...r.list.children]; r.panel.open = true;
  let writes = 0;
  for (const row of rows) { let text = row.textContent; Object.defineProperty(row, 'textContent', {
    configurable: true, get: () => text, set(value: string) { writes++; text = value; },
  }); }
  const rebuild = t.mock.method(r.list, 'replaceChildren', () => { throw new Error('unexpected roster rebuild'); });
  const before = [h.socket.sent.length, h.captures.length, h.peer.offers.length, h.enumerations()];
  install(h, state()); h.element['syncPublicRoster'](); h.element['render']();
  h.client['emit']('speaking', { participantIds: [] }); h.client['emit']('quality', { participants: [] });
  assert.deepEqual(r.list.children, rows); assert.equal(writes, 0); assert.equal(rebuild.mock.callCount(), 0); assert.equal(r.panel.open, true);
  assert.deepEqual([h.socket.sent.length, h.captures.length, h.peer.offers.length, h.enumerations()], before);
  rebuild.mock.restore();
});

it('deferred restoration and replay cannot revive a receipt retired by its predecessor', async t => {
  const h = await widgetFixture(t, state()), r = roster(h.element), outer = state(), gate = Promise.withResolvers<void>();
  h.socket.deliver({ type: 'speaking', participantIds: ['one'] }); r.panel.open = true;
  let armed = true;
  const continuation = gate.promise.then(() => { h.client['snapshot'] = outer; h.element['render'](); h.client['emit']('state', outer); });
  Object.defineProperty(outer.speakers[1]!, 'name', { configurable: true, get() {
    if (armed) { armed = false; h.client['snapshot'] = state({ roomId: 'deferred-loss' }); h.element['syncPublicRoster'](); }
    return 'Deferred stale row';
  } });
  install(h, outer); assert.equal(armed, false); cleared(h);
  gate.resolve(); await continuation; cleared(h);
  install(h, state()); assert.equal(r.panel.hidden, false);
});

for (const replacement of [false, true]) it(`throwing ${replacement ? 'provisional' : 'old'} owner predecessor releases its receipt token`, async t => {
  const h = await widgetFixture(t, state()), r = roster(h.element), outer = state(); r.panel.open = true;
  if (replacement) outer.roomId = 'throwing-new-room';
  let armed = true;
  Object.defineProperty(outer.me, 'name', { configurable: true, get() {
    if (armed) { armed = false;
      if (!replacement) h.client['snapshot'] = state({ roomId: 'throwing-loss' });
      h.element['syncPublicRoster'](); h.client['snapshot'] = outer; throw new Error('controlled predecessor failure');
    }
    return 'Throwing reader';
  } });
  const callbacks = getEventListeners(h.client, 'state'); assert.equal(callbacks.length, 1);
  h.client['snapshot'] = outer;
  assert.throws(() => callbacks[0]!.call(h.client, new CustomEvent('state', { detail: outer })), /controlled predecessor failure/);
  assert.equal(h.element['publicRosterPending'], undefined); cleared(h);
  h.element['render'](); h.client['emit']('state', outer); cleared(h);
  install(h, state({ roomId: outer.roomId })); assert.equal(r.panel.hidden, false);
});

for (const action of ['close', 'transfer'] as const) for (const loss of ['room', 'participant', 'status'] as const) {
  it(`temporary ${loss} loss observed by roster cannot restore earlier ${action} consent`, async t => {
    const initial = state(); initial.me = person('host', { role: 'controller', onStage: false });
    const h = await widgetFixture(t, initial), original = h.client.state!; let confirmations = 0;
    t.mock.method(h.pageWindow, 'confirm', () => {
      confirmations++; const lost = state({ me: { ...original.me } });
      if (loss === 'room') lost.roomId = 'consent-lost-room';
      else if (loss === 'participant') lost.me.participantId = 'consent-lost-seat';
      else h.client['currentStatus'] = 'disconnected';
      h.client['snapshot'] = lost; h.element['syncPublicRoster']();
      h.client['snapshot'] = original; h.client['currentStatus'] = 'live'; return true;
    });
    const before = [h.socket.sent.length, h.captures.length, h.peer.offers.length];
    if (action === 'close') h.element['closeRoom']();
    else { const row = h.element['stageManagementRows'].get('one'); assert.ok(row); h.element['transferStageControl']('one', row.node); }
    await flush(); assert.equal(confirmations, 1);
    assert.deepEqual([h.socket.sent.length, h.captures.length, h.peer.offers.length], before);
  });
}
