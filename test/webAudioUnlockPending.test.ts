import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

const blockedNotice = '自動播放遭阻擋。點擊啟用音訊';
const interruptedMessage = 'The play() request was interrupted by a call to pause().';
interface ActualClient {
  readonly state: RoomStatePayload | null;
  readonly status: string;
  disconnect(): Promise<void>;
  unlockAudio(): Promise<void>;
}

/** Native-like pending play batches: pause and source changes reject, never later fulfill. */
class PendingAudio {
  autoplay = false; hidden = false; isConnected = true; volume = 1; muted = false;
  readonly plays: Deferred<void>[] = [];
  private source: unknown = null;
  get srcObject(): unknown { return this.source; }
  set srcObject(value: unknown) {
    if (value !== this.source) this.rejectPending(new DOMException('The play() request was interrupted by a new load request.', 'AbortError'));
    this.source = value;
  }
  play(): Promise<void> { const request = new Deferred<void>(); this.plays.push(request); return request.promise; }
  pending(): Deferred<void>[] { return this.plays.filter(request => request.status === 'pending'); }
  rejectPending(error: Error): void { for (const request of this.pending()) request.reject(error); }
  resolvePending(): void { for (const request of this.pending()) request.resolve(undefined); }
  pause(): void { this.rejectPending(new DOMException(interruptedMessage, 'AbortError')); }
  remove(): void { this.isConnected = false; }
}

// Complete sample and real SDK; only DOM, transport and browser media boundaries are replaced.
async function actualSample(t: TestContext) {
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  StageSocket.instances = []; StagePeer.instances = [];
  let captures = 0;
  const globals = { window: new EventTarget(), WebSocket: StageSocket, RTCPeerConnection: StagePeer,
    navigator: { mediaDevices: {
      async enumerateDevices() { return []; },
      async getUserMedia(): Promise<never> { captures++; throw new DOMException('測試麥克風權限遭拒。', 'NotAllowedError'); },
    } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const audio = new PendingAudio();
  const sdk: ActualClient = new StageClient({ url: 'wss://sample.test/ws', audioElement: audio });
  const h = sampleApp({ sdk });
  const notices = () => h.find(node => node.classList.contains('notices')).textContent;
  const error = () => h.find(node => node.attributes.role === 'alert');
  async function tick(): Promise<void> { now += 10; t.mock.timers.tick(10); await flushSample(); }
  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 80 && !predicate(); i++) await tick();
    assert.ok(predicate(), label);
  }
  async function join() {
    const state = roomState();
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
    for (const [name, value] of Object.entries({ roomId: state.roomId, name: state.me.name })) {
      const input = form.descendants().filter(node => node.type !== 'histogram').find(node => node.name === name); assert.ok(input); input.value = value;
    }
    form.submit(); await flushSample();
    const socket = StageSocket.instances.at(-1)!;
    socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
    await until(() => socket.sent.some(message => message.type === 'join'), 'initial join request');
    const request = socket.sent.find(message => message.type === 'join')!;
    socket.deliver({ type: 'room:state', ...state }); socket.deliver({ type: 'ok', requestId: request.requestId });
    const peer = StagePeer.instances.at(-1)!;
    await until(() => peer.localDescription !== null && peer.signalingState === 'stable', 'initial negotiation');
    return { socket, peer, state };
  }
  async function block(peer: StagePeer): Promise<void> {
    assert.ok(peer.ontrack);
    peer.ontrack({ streams: [{ getTracks: () => [], getAudioTracks: () => [] }] });
    audio.rejectPending(new DOMException('User activation required', 'NotAllowedError')); await flushSample();
    assert.equal(notices(), blockedNotice);
  }
  function unlock(): { button: SampleNode; play: Deferred<void> } {
    const button = h.button('點擊啟用音訊'), before = audio.plays.length;
    button.click();
    assert.equal(audio.plays.length, before + 1, 'public SDK invokes play synchronously in the click stack');
    assert.equal(button.disabled, true); button.click();
    assert.equal(audio.plays.length, before + 1, 'native repeated clicks cannot duplicate the pending play');
    return { button, play: audio.plays.at(-1)! };
  }
  t.after(async () => {
    try {
      await h.cleanup();
      assert.equal(audio.pending().length, 0); assert.equal(sdk.state, null);
      assert.equal(sdk.status, 'disconnected'); assert.equal(h.clock.jobs.size, 0);
      assert.ok(StageSocket.instances.every(socket => socket.readyState === 3));
      assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'));
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return { ...h, audio, sdk, notices, error, tick, until, join, block, unlock, captures: () => captures };
}

for (const redraw of ['snapshot', 'invitation', 'microphone-error'] as const) {
  it(`real SDK sample keeps one synchronous audio unlock pending across ${redraw} redraw`, async t => {
    const h = await actualSample(t), { socket, peer, state } = await h.join(); await h.block(peer);
    const first = h.unlock(); await h.tick();
    if (redraw === 'snapshot') socket.deliver({ type: 'room:state', ...state });
    else if (redraw === 'invitation') socket.deliver({ type: 'stage:invite', participantId: state.me.participantId, byId: state.controllerId });
    else {
      socket.deliver({ type: 'room:state', ...roomState({ onStage: true }) });
      await h.until(() => h.captures() === 1 && h.notices().includes('NotAllowedError'), 'real SDK microphone rejection notice');
    }
    await flushSample();
    const replacement = h.button('點擊啟用音訊');
    assert.equal(first.button.isConnected, false);
    assert.equal(replacement.disabled, true, 'redraw must retain the logical pending unlock');
    assert.equal(replacement.attributes['aria-busy'], 'true');
    socket.deliver({ type: 'error', code: 'bad_request', message: '保留目前操作錯誤。' });
    replacement.click(); replacement.onclick!(); first.button.onclick!();
    assert.equal(h.audio.plays.length, 2, 'one rejected autoplay plus one user unlock');
    assert.equal(h.audio.pending().length, 1);
    assert.equal(h.error().hidden, false, 'ignored clicks must not clear a current error');
    assert.equal(h.error().textContent, '保留目前操作錯誤。');
    h.audio.resolvePending(); await flushSample();
    assert.doesNotMatch(h.notices(), /自動播放遭阻擋/);
    if (redraw === 'invitation') assert.match(h.notices(), /主控已邀請你上台/);
    if (redraw === 'microphone-error') assert.match(h.notices(), /NotAllowedError/);
    assert.equal(h.error().hidden, false); assert.equal(h.error().textContent, '保留目前操作錯誤。');
    first.button.onclick!(); replacement.onclick!();
    assert.equal(h.audio.plays.length, 2, 'detached buttons cannot start playback after success');
    assert.equal(h.error().hidden, false);
  });
}

it('real SDK sample ignores direct pending click reentry without clearing the current error', async t => {
  const h = await actualSample(t), { socket, peer } = await h.join(); await h.block(peer);
  const first = h.unlock();
  socket.deliver({ type: 'error', code: 'bad_request', message: '保留目前操作錯誤。' });
  first.button.onclick!(); first.button.onclick!();
  assert.equal(h.audio.plays.length, 2, 'direct invocation cannot bypass pending ownership');
  assert.equal(h.audio.pending().length, 1); assert.equal(h.error().hidden, false);
  assert.equal(h.error().textContent, '保留目前操作錯誤。');
  assert.equal(first.button.disabled, true); assert.equal(first.button.attributes['aria-busy'], 'true');
  h.audio.resolvePending(); await flushSample(); assert.equal(h.notices(), '');
});

it('real SDK sample permits retry after pending playback rejects through a redrawn notice', async t => {
  const h = await actualSample(t), { socket, peer, state } = await h.join(); await h.block(peer);
  const first = h.unlock(); await h.tick(); socket.deliver({ type: 'room:state', ...state });
  const redrawn = h.button('點擊啟用音訊');
  h.audio.rejectPending(new Error('目前無法播放，請重試。')); await flushSample();
  assert.equal(first.play.status, 'rejected'); assert.equal(h.notices(), blockedNotice);
  assert.equal(h.error().hidden, false); assert.equal(h.error().textContent, '目前無法播放，請重試。');
  const retryButton = h.button('點擊啟用音訊');
  assert.notEqual(retryButton, redrawn); assert.equal(redrawn.isConnected, false);
  assert.equal(retryButton.disabled, false); assert.equal(retryButton.attributes['aria-busy'], 'false');
  first.button.onclick!(); redrawn.onclick!();
  assert.equal(h.audio.plays.length, 2); assert.equal(h.error().hidden, false);
  h.unlock(); assert.equal(h.error().hidden, true);
  h.audio.resolvePending(); await flushSample();
  assert.equal(h.notices(), ''); assert.equal(h.error().hidden, true); assert.equal(h.audio.plays.length, 3);
});

it('sample releases pending ownership after a synchronous SDK throw and retries through the real SDK', async t => {
  const h = await actualSample(t), { peer } = await h.join(); await h.block(peer);
  // A bounded defensive SDK-boundary probe, not a claim that the async SDK normally throws synchronously.
  const throwing = t.mock.method(h.sdk, 'unlockAudio', () => { throw new Error('同步啟用失敗。'); });
  h.button('點擊啟用音訊').click(); await flushSample();
  assert.equal(throwing.mock.callCount(), 1); throwing.mock.restore();
  assert.equal(h.error().hidden, false); assert.equal(h.error().textContent, '同步啟用失敗。');
  assert.equal(h.button('點擊啟用音訊').disabled, false);
  assert.equal(h.button('點擊啟用音訊').attributes['aria-busy'], 'false');
  h.unlock(); assert.equal(h.error().hidden, true);
  h.audio.resolvePending(); await flushSample(); assert.equal(h.notices(), '');
});

for (const transition of ['Leave', 'shutdown', 'kicked'] as const) {
  it(`real SDK sample ${transition} retires pending playback and allows a fresh same-seat unlock`, async t => {
    const h = await actualSample(t), { socket, peer, state } = await h.join(); await h.block(peer);
    const first = h.unlock();
    if (transition === 'Leave') h.button('離開房間').click();
    else socket.deliver(transition === 'shutdown' ? { type: 'room:closed', roomId: state.roomId, reason: 'shutdown' } : { type: 'kicked', roomId: state.roomId });
    assert.equal(first.play.status, 'rejected'); await flushSample();
    assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected'); assert.equal(h.error().hidden, true);
    assert.equal(first.button.isConnected, false); assert.equal(first.button.disabled, true);
    assert.equal(h.clock.jobs.size, 0);
    if (transition === 'Leave') assert.equal(h.notices(), '');
    else assert.match(h.notices(), transition === 'shutdown' ? /伺服器維護或重新啟動/ : /你已被主控移出房間/);
    first.button.onclick!(); assert.equal(h.audio.plays.length, 2); assert.equal(h.error().hidden, true);
    const rejoined = await h.join(); await h.block(rejoined.peer);
    const current = h.button('點擊啟用音訊');
    assert.equal(current.disabled, false); assert.equal(current.attributes['aria-busy'], 'false');
    first.button.onclick!(); assert.equal(h.audio.pending().length, 0);
    h.unlock(); h.audio.resolvePending(); await flushSample();
    assert.equal(h.notices(), ''); assert.equal(h.error().hidden, true);
  });
}

it('real SDK sample same-seat reconnect retains the existing play and pending notice ownership', async t => {
  const h = await actualSample(t), { socket, peer, state } = await h.join(); await h.block(peer);
  const first = h.unlock(); socket.close();
  assert.equal(h.sdk.status, 'reconnecting'); assert.equal(first.play.status, 'pending');
  assert.equal(peer.connectionState, 'connected'); assert.equal(first.button.disabled, true);
  assert.equal(h.audio.plays.length, 2);
  await h.until(() => StageSocket.instances.length === 2, 'reconnect socket');
  const resumed = StageSocket.instances.at(-1)!;
  resumed.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => resumed.sent.some(message => message.type === 'join'), 'resume join request');
  const request = resumed.sent.find(message => message.type === 'join')!;
  resumed.deliver({ type: 'room:state', ...state }); resumed.deliver({ type: 'ok', requestId: request.requestId }); await flushSample();
  assert.equal(h.sdk.status, 'waiting'); assert.equal(StagePeer.instances.length, 1);
  assert.equal(first.play.status, 'pending'); assert.equal(first.button.isConnected, false);
  const replacement = h.button('點擊啟用音訊');
  assert.equal(replacement.disabled, true); assert.equal(replacement.attributes['aria-busy'], 'true');
  replacement.click(); replacement.onclick!(); first.button.onclick!();
  assert.equal(h.audio.plays.length, 2); assert.equal(h.audio.pending().length, 1);
  h.audio.resolvePending(); await flushSample(); assert.equal(h.notices(), '');
});

for (const change of ['same-seat-rejoin', 'participant', 'room'] as const) {
  for (const outcome of ['reject', 'fulfill'] as const) {
    it(`bounded sample ${change} keeps its new unlock pending when the old ${outcome} finally runs`, async t => {
      const h = sampleApp(), plays: Deferred<void>[] = [];
      Object.assign(h.sdk, { async unlockAudio(): Promise<void> { const work = new Deferred<void>(); plays.push(work); await work.promise; } });
      t.after(async () => {
        for (const work of plays) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
        await h.cleanup(); assert.ok(plays.every(work => work.status !== 'pending'));
      });
      const notices = () => h.find(node => node.classList.contains('notices')).textContent;
      const error = () => h.find(node => node.attributes.role === 'alert');
      function acceptJoin(): void {
        const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
        for (const [name, value] of Object.entries({ roomId: 'same-room', name: '測試聽眾' })) {
          const input = form.descendants().filter(node => node.type !== 'histogram').find(node => node.name === name); assert.ok(input); input.value = value;
        }
        form.submit(); h.sdk.acceptJoin(roomState());
      }
      acceptJoin(); await flushSample(); h.sdk.emit('audioblocked', {});
      const oldButton = h.button('點擊啟用音訊'); oldButton.click(); assert.equal(plays.length, 1);
      // Queued settlement plus immediate lifecycle transitions only checks UI generation ownership.
      // It does not model an old native play succeeding after pause or new same-room notice revisions.
      if (outcome === 'reject') plays[0]!.reject(new Error('retired unlock failure')); else plays[0]!.resolve(undefined);
      if (change === 'same-seat-rejoin') { void h.sdk.disconnect(); acceptJoin(); }
      else h.sdk.snapshot(change === 'participant' ? roomState({ participantId: 'replacement' }) : { ...roomState(), roomId: 'replacement-room' });
      h.sdk.emit('audioblocked', {});
      const current = h.button('點擊啟用音訊');
      assert.equal(current.disabled, false); assert.equal(current.attributes['aria-busy'], 'false');
      current.click(); assert.equal(plays.length, 2);
      h.sdk.emit('error', { message: '保留新房間操作錯誤。' }); await flushSample();
      assert.equal(notices(), blockedNotice); assert.equal(error().hidden, false);
      assert.equal(error().textContent, '保留新房間操作錯誤。');
      assert.equal(current.isConnected, true); assert.equal(current.disabled, true);
      assert.equal(current.attributes['aria-busy'], 'true');
      oldButton.onclick!(); current.onclick!();
      assert.equal(plays.length, 2); assert.equal(error().hidden, false);
      h.sdk.snapshot(h.sdk.state!);
      const redrawn = h.button('點擊啟用音訊');
      assert.equal(redrawn.disabled, true); assert.equal(redrawn.attributes['aria-busy'], 'true');
      redrawn.onclick!(); assert.equal(plays.length, 2);
      plays[1]!.resolve(undefined); await flushSample();
      assert.equal(notices(), ''); assert.equal(error().hidden, false);
      assert.equal(error().textContent, '保留新房間操作錯誤。');
    });
  }
}
