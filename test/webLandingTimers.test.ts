import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp, SampleNode, SamplePreview } from './fixtures/sampleApp.ts';

// These bounded fake-clock counts describe scheduled application work, not CPU or browser throttling.
type Action = 'create' | 'join';
type App = ReturnType<typeof sampleApp>;
type View = Pick<App, 'app' | 'find' | 'clock'>;
interface Stats { inbound: { rtt?: number; lossPercent?: number; bufferMs?: number } | null; outbound: null }
const result = (rtt = 0.02, lossPercent = 0): Stats => ({ inbound: { rtt, lossPercent, bufferMs: 10 }, outbound: null });
const connection = (h: Pick<View, 'find'>) => h.find(node => node.classList.contains('connection'));
const forms = (h: Pick<View, 'app'>) => h.app.descendants().filter(node => node.tagName === 'form' && !node.classList.contains('chat-form'));
function timers(h: Pick<View, 'clock'>, meter: number, stats: number): void {
  assert.equal(h.clock.intervals(50).length, meter, '50 ms microphone meter count');
  assert.equal(h.clock.intervals(2000).length, stats, '2000 ms connection diagnostics count');
}
function callbacks(h: Pick<View, 'clock'>, delay: number): (() => void)[] {
  return h.clock.intervals(delay).map(id => h.clock.jobs.get(id)!.callback);
}
function submit(h: Pick<View, 'find'>, action: Action): void {
  const form = h.find(node => node.tagName === 'form'
    && node.children.some(child => child.tagName === 'h2' && child.textContent === (action === 'create' ? '建立房間' : '加入房間')));
  for (const input of form.descendants().filter(node => node.tagName === 'input')) {
    if (input.name === 'name') input.value = '測試使用者';
    if (input.name === 'roomId') input.value = 'same-room';
    if (input.name === 'roomName') input.value = '測試舞台';
  }
  form.submit();
}
function writes(node: SampleNode): () => number {
  const descriptor = Object.getOwnPropertyDescriptor(SampleNode.prototype, 'textContent')!;
  let count = 0;
  Object.defineProperty(node, 'textContent', { configurable: true,
    get() { return descriptor.get!.call(node); },
    set(value: string) { count++; descriptor.set!.call(node, value); } });
  return () => count;
}

interface Request { type: string; requestId: string }
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
  closeCalls = 0;
  readonly sent: Request[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string): void { assert.equal(this.readyState, Socket.OPEN); this.sent.push(JSON.parse(data) as Request); }
  deliver(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello(): void {
    this.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  }
  close(): void { this.closeCalls++; this.readyState = 3; this.onclose?.(); }
}
type Report = Map<string, Record<string, unknown>>;
class Peer {
  static instances: Peer[] = [];
  connectionState = 'new'; signalingState = 'stable'; localDescription = null;
  closes = 0;
  readonly polls: Deferred<Report>[] = [];
  private rejectOffer: ((error: Error) => void) | undefined;
  constructor() { Peer.instances.push(this); }
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as unknown,
      async replaceTrack(track: unknown): Promise<void> { this.track = track; } } };
  }
  // Negotiation stays outside the tested lifecycle and is released by normal SDK peer cleanup.
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  getStats(): Promise<Report> { const work = new Deferred<Report>(); this.polls.push(work); return work.promise; }
  close(): void { this.closes++; this.connectionState = 'closed'; this.rejectOffer?.(new Error('fixture peer closed')); }
}
interface ActualClient {
  readonly state: RoomStatePayload | null;
  readonly status: string;
  readonly session: unknown;
  disconnect(): Promise<void>;
  getStats(): Promise<Stats>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
async function actualSetup(t: TestContext, initialHidden = false) {
  // Dynamic import keeps browser types outside the server project's type graph. Both production
  // modules execute whole; only browser globals, transport, peer and audio element are doubles.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const target = new EventTarget(); let captures = 0;
  const globals = { window: target, WebSocket: Socket, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { enumerateDevices: async () => [], getUserMedia: async () => {
      captures++; throw new Error('fixture microphone unavailable');
    } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Socket.instances = []; Peer.instances = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const audio = { volume: 1, muted: false, srcObject: null as unknown, pauses: 0, pause() { this.pauses++; } };
  const sdk: ActualClient = new StageClient({ url: 'ws://localhost/ws', audioElement: audio, enableMicMeter: false });
  const h = sampleApp({ sdk, initialHidden });
  const statuses: unknown[] = []; sdk.on('status', event => statuses.push(event.detail));
  const stats = t.mock.method(sdk, 'getStats');
  t.after(async () => {
    try {
      await h.cleanup();
      for (const peer of Peer.instances) for (const poll of peer.polls) if (poll.status === 'pending') poll.reject(new Error('fixture cleanup'));
      await flushSample();
      assert.equal(getEventListeners(target, 'pagehide').length, 0);
      assert.ok(Peer.instances.every(peer => peer.closes === 1), 'each real SDK peer retires exactly once');
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  await flushSample();
  return { ...h, statuses, stats, audio, captures: () => captures,
    async enter(action: Action, acknowledge = false): Promise<Socket> {
      submit(h, action);
      const socket = Socket.instances.at(-1); assert.ok(socket); socket.hello();
      await flushSample(); t.mock.timers.tick(0); await flushSample();
      const request = socket.sent.find(message => message.type === (action === 'create' ? 'room:create' : 'join')); assert.ok(request);
      if (action === 'create') socket.deliver({ type: 'room:created', roomId: 'same-room', code: 'TEST42' });
      const state = roomState(action === 'create' ? { role: 'controller', onStage: true } : {});
      if (action === 'create') { state.controllerId = state.me.participantId; state.codeRequired = true; }
      socket.deliver({ type: 'room:state', ...state }); await flushSample();
      assert.equal(forms(h).length, 0); assert.equal(sdk.state?.roomId, 'same-room');
      assert.equal(sdk.session, null, 'the initial authoritative snapshot precedes the entry ACK');
      if (acknowledge) { socket.deliver({ type: 'ok', requestId: request.requestId }); await flushSample(); assert.ok(sdk.session); }
      return socket;
    },
  };
}

for (const action of ['create', 'join'] as const) {
  for (const hidden of [false, true]) {
    it(`whole sample actual SDK ${action} pre-ACK socket loss then Leave retires ${hidden ? 'hidden' : 'visible'} diagnostics without a second status event`, async t => {
      const h = await actualSetup(t, hidden), socket = await h.enter(action);
      timers(h, !hidden && action === 'create' ? 1 : 0, hidden ? 0 : 1);
      const oldTimers = [...h.clock.jobs.keys()], queued = [...callbacks(h, 50), ...callbacks(h, 2000)];
      const line = connection(h);
      if (!hidden) {
        h.clock.advance(2000); await flushSample();
        assert.equal(h.stats.mock.callCount(), 1);
        const peer = Peer.instances[0]!;
        peer.polls[0]!.resolve(new Map([
          ['in', { id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp: 2000 }],
          ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.08 }],
        ]));
        await flushSample(); assert.match(line.textContent, /80 ms/);
      }
      const state = h.sdk.state; socket.close(); await flushSample();
      assert.equal(h.sdk.status, 'disconnected'); assert.equal(h.sdk.session, null); assert.equal(h.sdk.state, state);
      assert.equal(forms(h).length, 0, 'socket loss retains the authoritative room view until explicit Leave');
      const statusCount = h.statuses.length, captures = h.captures(), sent = socket.sent.length;
      h.button('離開房間').click(); await flushSample();
      assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected'); assert.equal(h.statuses.length, statusCount);
      assert.equal(forms(h).length, 2); timers(h, 0, 0); assert.equal(h.clock.jobs.size, 0);
      assert.equal(line.textContent, ''); assert.equal(line.classList.contains('error'), false);
      const fired = h.clock.fired.length, polls = h.stats.mock.callCount();
      for (const callback of queued) callback(); h.clock.advance(6000); await flushSample();
      assert.equal(h.clock.fired.length, fired, 'no recurring application callback runs over three diagnostics periods on landing');
      assert.equal(h.stats.mock.callCount(), polls); assert.equal(h.captures(), captures); assert.equal(socket.sent.length, sent);
      h.setHidden(true); h.setHidden(false); h.setHidden(false); timers(h, 0, 0);
      assert.equal(h.stats.mock.callCount(), polls, 'visibility changes cannot restart room diagnostics on landing');
      await h.enter(action, true);
      timers(h, action === 'create' ? 1 : 0, 1);
      const fresh = h.clock.intervals(2000)[0]!; assert.ok(!oldTimers.includes(fresh), 'same room/person gets a new timer owner');
      const currentPolls = h.stats.mock.callCount(); for (const callback of queued) callback(); await flushSample();
      assert.equal(h.stats.mock.callCount(), currentPolls, 'retired queued callbacks cannot poll the replacement room');
      h.clock.advance(2000); await flushSample(); assert.equal(h.stats.mock.callCount(), currentPolls + 1);
      timers(h, action === 'create' ? 1 : 0, 1); assert.equal(h.visibilityListeners.size, 1);
    });
  }
}

for (const action of ['create', 'join'] as const) {
  for (const ending of ['leave', 'closed', 'shutdown', 'kicked'] as const) {
    it(`whole sample actual SDK acknowledged ${action} ${ending} clears diagnostics and late peer results`, async t => {
      const h = await actualSetup(t), socket = await h.enter(action, true);
      const queued = [...callbacks(h, 50), ...callbacks(h, 2000)], line = connection(h);
      h.clock.advance(2000); await flushSample();
      const old = Peer.instances[0]!.polls[0]!; assert.equal(old.status, 'pending');
      if (ending === 'leave') h.button('離開房間').click();
      else socket.deliver(ending === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
        : { type: 'room:closed', roomId: 'same-room', ...(ending === 'shutdown' ? { reason: 'shutdown' } : {}) });
      await flushSample();
      assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected'); assert.equal(forms(h).length, 2);
      timers(h, 0, 0); assert.equal(h.clock.jobs.size, 0);
      const count = writes(line), before = h.stats.mock.callCount(), fired = h.clock.fired.length;
      for (const callback of queued) callback();
      old.resolve(new Map([['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.9 }]]));
      h.clock.advance(6000); await flushSample();
      assert.equal(count(), 0); assert.equal(line.textContent, ''); assert.equal(h.stats.mock.callCount(), before);
      assert.equal(h.clock.fired.length, fired);
      const notice = h.find(node => node.classList.contains('notices')).textContent;
      if (ending === 'closed') assert.match(notice, /房間已關閉/);
      if (ending === 'shutdown') assert.match(notice, /伺服器維護或重新啟動/);
      if (ending === 'kicked') assert.match(notice, /你已被主控移出房間/);
    });
  }
}

async function setup(t: TestContext): Promise<App> {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample(); return h;
}
for (const outcome of ['poor', 'empty', 'reject'] as const) {
  for (const settlement of ['landing', 'replacement'] as const) {
    it(`whole sample explicit landing drops pending ${outcome} stats settling on ${settlement}`, async t => {
      const h = await setup(t); h.sdk.snapshot(roomState()); h.clock.advance(2000);
      h.sdk.polls[0]!.resolve(result(0.08, 20)); await flushSample();
      const line = connection(h); assert.match(line.textContent, /80 ms/); assert.equal(line.classList.contains('error'), true);
      h.clock.advance(2000); const old = h.sdk.polls[1]!, queued = callbacks(h, 2000), oldTimer = h.clock.intervals(2000)[0];
      h.sdk.setStatus('disconnected'); assert.ok(h.sdk.state);
      h.button('離開房間').click(); await flushSample(); timers(h, 0, 0);
      assert.equal(line.textContent, ''); assert.equal(line.classList.contains('error'), false);
      if (settlement === 'replacement') {
        h.sdk.snapshot(roomState()); timers(h, 0, 1); assert.notEqual(h.clock.intervals(2000)[0], oldTimer);
        h.clock.advance(2000); h.sdk.polls[2]!.resolve(result()); await flushSample(); assert.match(line.textContent, /20 ms/);
      }
      const count = writes(line), before = h.sdk.polls.length;
      if (outcome === 'reject') old.reject(new Error('retired diagnostics failed'));
      else old.resolve(outcome === 'empty' ? { inbound: null, outbound: null } : result(0.9, 80));
      for (const callback of queued) callback(); await flushSample();
      assert.equal(count(), 0); assert.equal(h.sdk.polls.length, before); assert.equal(line.classList.contains('error'), false);
      if (settlement === 'replacement') { assert.match(line.textContent, /20 ms/); timers(h, 0, 1); }
      else { assert.equal(line.textContent, ''); h.clock.advance(6000); assert.equal(h.clock.jobs.size, 0); }
    });
  }
}

for (const hidden of [false, true]) {
  it(`whole sample ${hidden ? 'hidden' : 'visible'} landing cleanup cancels old preview and control work while fresh preview stays independent`, async t => {
    const h = await setup(t); h.sdk.snapshot(roomState());
    h.id('mic-test').click(); const pending = h.sdk.previews[0]!, signal = h.sdk.previewSignals[0]!;
    h.find(node => node.dataset.roomAction === 'hand').click(); assert.equal(h.sdk.raises.length, 1);
    const control = h.find(node => node.dataset.roomAction === 'hand'); assert.ok(control.onclick);
    const callback = control.onclick;
    if (hidden) h.setHidden(true);
    h.sdk.setStatus('disconnected'); h.button('離開房間').click(); await flushSample();
    assert.equal(pending.status, 'rejected'); assert.equal(h.sdk.raises[0]!.status, 'rejected');
    assert.equal(signal.aborted, false, 'SDK disconnect already settled capture before landing resets its UI');
    assert.equal(h.id('mic-test-cancel').hidden, true); assert.equal(h.id('mic-test').disabled, false);
    timers(h, 0, 0); assert.equal(h.clock.timeouts().length, 0); callback();
    assert.equal(h.sdk.raises.length, 1); assert.equal(h.sdk.previews.length, 1);
    h.id('mic-test').click(); const fresh = h.sdk.previews[1]!, freshSignal = h.sdk.previewSignals[1]!;
    h.setHidden(true); assert.equal(fresh.status, 'pending'); assert.equal(freshSignal.aborted, false); timers(h, 0, 0);
    const preview = new SamplePreview(0.35); h.sdk.grantPreview(fresh, preview); await flushSample();
    assert.equal(preview.stops, 0); h.clock.advance(6000); assert.equal(preview.reads, 0); assert.equal(h.sdk.polls.length, 0);
    h.setHidden(false); timers(h, 1, 0); h.clock.advance(50); assert.equal(preview.reads, 1);
    assert.equal(h.id('mic-level').value, 0.35); assert.equal(h.id('mic-test').textContent, '停止測試');
    assert.equal(preview.stops, 0); assert.equal(freshSignal.aborted, false);
    assert.equal(h.sdk.raises.length, 1); assert.equal(h.sdk.previews.length, 2); assert.deepEqual(h.sdk.inputDevices, []);
    assert.deepEqual(h.sdk.outputDevices, []); assert.deepEqual(h.sdk.joins, []);
    h.id('mic-test').click(); await flushSample(); assert.equal(preview.stops, 1); timers(h, 0, 0);
  });
}
