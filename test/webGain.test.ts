import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { MAX_GAIN_DB } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

interface GainRequest { targetId: string; gainDb: number; work: Deferred<void>; errorGate?: Deferred<void> }

function setup(delayGainErrors = false) {
  const h = sampleApp(), gains: GainRequest[] = [];
  const disconnect = h.sdk.disconnect.bind(h.sdk);
  let disconnects = 0;
  Object.assign(h.sdk, {
    setGain(targetId: string, gainDb: number): Promise<void> {
      const work = new Deferred<void>();
      const errorGate = delayGainErrors ? new Deferred<void>() : undefined;
      gains.push({ targetId, gainDb, work, errorGate });
      if (!errorGate) return work.promise;
      // Only the public continuation is delayed: disconnect still rejects the request
      // before emitting status, as the SDK does. This is an ordering double, not real SDK coverage.
      return work.promise.catch(async error => { await errorGate.promise; throw error; });
    },
    disconnect(): Promise<void> {
      disconnects++;
      for (const { work } of gains) if (work.status === 'pending') work.reject(new Error('連線已中斷。'));
      return disconnect();
    },
  });
  return {
    ...h, gains, disconnects: () => disconnects,
    async cleanup(): Promise<void> {
      for (const { errorGate } of gains) if (errorGate?.status === 'pending') errorGate.resolve(undefined);
      await h.cleanup();
      assert.ok(gains.every(({ work, errorGate }) => work.status !== 'pending' && errorGate?.status !== 'pending'));
    },
  };
}
type App = ReturnType<typeof setup>;
type View = Pick<App, 'find'>;

function managementState(): RoomStatePayload {
  const state = roomState({ participantId: 'controller', name: '測試主控', role: 'controller' });
  state.status = 'live'; state.audienceCount = 0; state.audience = [];
  state.speakers = ['speaker-a', 'speaker-b'].map(participantId => ({
    ...state.me, participantId, name: participantId, role: 'speaker', onStage: true,
  }));
  return state;
}
function slider(h: View, targetId = 'speaker-a'): SampleNode {
  const row = h.find(node => node.classList.contains('person') && node.dataset.participantId === targetId);
  const sliders = row.descendants().filter(node => node.tagName === 'input' && node.type === 'range');
  assert.equal(sliders.length, 1); return sliders[0]!;
}
function release(node: SampleNode, gainDb: number): void {
  assert.equal(node.disabled, false); assert.ok(node.onchange);
  node.value = String(gainDb); node.onchange();
}
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
const notices = (h: App) => h.find(node => node.classList.contains('notices'));
function assertLanding(h: App): void {
  assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected');
  assert.equal(h.app.descendants().filter(node => node.tagName === 'form').length, 2);
  assert.equal(h.clock.jobs.size, 0);
}
async function join(h: App, state = managementState()): Promise<void> {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [name, value] of Object.entries({ roomId: state.roomId, name: state.me.name, code: '' })) {
    const input = form.descendants().find(node => node.tagName === 'input' && node.name === name);
    assert.ok(input); input.value = value;
  }
  form.submit();
  assert.deepEqual({ ...h.sdk.joins.at(-1)!.options }, { roomId: state.roomId, name: state.me.name, code: undefined });
  h.sdk.acceptJoin(state); await flushSample();
  assert.equal(form.isConnected, false);
}

it('whole sample Leave click retires a pending gain before its ordered cancellation can show an error on landing', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const control = slider(h); release(control, 4);
  assert.equal(h.gains.length, 1); assert.equal(h.gains[0]!.work.status, 'pending');
  h.button('離開房間').click();
  assert.equal(h.disconnects(), 1); assert.equal(h.gains[0]!.work.status, 'rejected');
  assert.equal(h.sdk.events.at(-1), 'status'); assert.equal(control.isConnected, false); assertLanding(h);
  await flushSample();
  assertLanding(h); assert.equal(notices(h).textContent, '');
  assert.equal(errorBox(h).hidden, true, 'the retired gain cancellation must not be shown after Leave');
});

it('whole sample shutdown preserves its maintenance notice without a retired gain cancellation error', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h); release(slider(h), -3);
  const closing = h.sdk.terminal('closed', 'shutdown');
  assert.equal(h.gains[0]!.work.status, 'rejected'); assertLanding(h);
  assert.equal(notices(h).textContent, '', 'the disconnected status precedes the shutdown event');
  await closing; await flushSample();
  assert.deepEqual(h.sdk.events.slice(-2), ['status', 'closed']); assertLanding(h);
  assert.match(notices(h).textContent, /伺服器維護或重新啟動/);
  assert.equal(errorBox(h).hidden, true, 'the shutdown notice must not be accompanied by a stale gain error');
});

for (const currentMessage of ['notice', 'error'] as const) {
  it(`whole sample same-room same-identity rejoin keeps its new ${currentMessage} after a delayed old gain rejection`, async t => {
    const h = setup(true); t.after(() => h.cleanup()); await join(h);
    const original = h.sdk.state; assert.ok(original);
    release(slider(h), 5); const old = h.gains[0]!;
    h.button('離開房間').click(); await flushSample();
    assert.equal(old.work.status, 'rejected'); assert.equal(old.errorGate!.status, 'pending'); assertLanding(h);
    await join(h);
    assert.equal(h.sdk.state?.roomId, original.roomId); assert.equal(h.sdk.me?.participantId, original.me.participantId);
    const current = slider(h); release(current, 2);
    const replacement = h.gains[1]!; assert.equal(replacement.work.status, 'pending');
    if (currentMessage === 'notice') h.sdk.emit('invite', { participantId: original.me.participantId });
    else h.sdk.emit('error', { message: '目前房間的新錯誤。' });
    const notice = notices(h).textContent, error = errorBox(h).textContent, hidden = errorBox(h).hidden;
    if (currentMessage === 'notice') assert.match(notice, /主控已邀請你上台/);
    else assert.equal(error, '目前房間的新錯誤。');

    old.errorGate!.resolve(undefined); await flushSample();
    assert.equal(notices(h).textContent, notice); assert.equal(errorBox(h).hidden, hidden);
    assert.equal(errorBox(h).textContent, error, 'old gain settlement must not overwrite the new room message');
    assert.equal(slider(h), current); assert.equal(current.disabled, false);
    assert.equal(replacement.work.status, 'pending', 'an old completion does not settle a new gain request');
    replacement.work.resolve(undefined); replacement.errorGate!.resolve(undefined); await flushSample();
  });
}

for (const changed of ['room', 'participant'] as const) {
  it(`whole sample ignores a gain rejection after its ${changed} identity changes without an intermediate landing`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h); release(slider(h), 3);
    const next = managementState();
    if (changed === 'room') next.roomId = 'replacement-room';
    else { next.me.participantId = 'replacement-controller'; next.controllerId = next.me.participantId; }
    h.sdk.snapshot(next); h.sdk.emit('error', { message: '替換房間的錯誤。' });
    h.gains[0]!.work.reject(new Error('舊房間的音量錯誤。')); await flushSample();
    assert.equal(h.sdk.state, next); assert.equal(errorBox(h).hidden, false);
    assert.equal(errorBox(h).textContent, '替換房間的錯誤。');
  });
}

it('whole sample still displays current-generation gain rejection after same-identity redraw and allows retry', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const retired = slider(h); release(retired, 8); h.sdk.snapshot(managementState());
  const current = slider(h); assert.notEqual(current, retired); assert.equal(retired.isConnected, false);
  h.gains[0]!.work.reject(new Error('目前音量調整失敗。')); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '目前音量調整失敗。');
  assert.equal(current.disabled, false); release(current, -2);
  assert.equal(h.gains.length, 2); assert.equal(errorBox(h).hidden, true);
  h.gains[1]!.work.resolve(undefined); await flushSample(); assert.equal(errorBox(h).hidden, true);
});

it('whole sample sends every same- and different-target gain release concurrently and keeps snapshot-authoritative redraw', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const first = slider(h), second = slider(h, 'speaker-b');
  assert.equal(first.min, String(-MAX_GAIN_DB)); assert.equal(first.max, String(MAX_GAIN_DB)); assert.equal(first.step, '1');
  assert.equal(first.oninput, null, 'dragging alone does not send gain requests');
  first.value = '2'; assert.equal(h.gains.length, 0);
  release(first, 4); release(first, 5); release(first, 5); release(second, -6);
  assert.deepEqual(h.gains.map(({ targetId, gainDb }) => ({ targetId, gainDb })), [
    { targetId: 'speaker-a', gainDb: 4 }, { targetId: 'speaker-a', gainDb: 5 },
    { targetId: 'speaker-a', gainDb: 5 }, { targetId: 'speaker-b', gainDb: -6 },
  ]);
  assert.ok(h.gains.every(({ work }) => work.status === 'pending'));
  assert.equal(first.disabled, false); assert.equal(second.disabled, false);
  assert.deepEqual(h.sdk.state!.speakers.map(person => person.gainDb), [0, 0]);
  assert.equal(first.title, '0 dB'); assert.equal(second.title, '0 dB');

  h.gains[0]!.work.resolve(undefined); await flushSample();
  assert.equal(slider(h), first, 'an ACK alone must not replace the slider or invent a snapshot');
  assert.deepEqual(h.sdk.state!.speakers.map(person => person.gainDb), [0, 0]);
  const authoritative = managementState(); authoritative.speakers[0]!.gainDb = 2; authoritative.speakers[1]!.gainDb = -3;
  h.sdk.snapshot(authoritative);
  const redrawn = slider(h), redrawnSecond = slider(h, 'speaker-b');
  assert.equal(first.isConnected, false); assert.equal(second.isConnected, false);
  assert.equal(redrawn.value, '2'); assert.equal(redrawn.title, '2 dB');
  assert.equal(redrawnSecond.value, '-3'); assert.equal(redrawnSecond.title, '-3 dB');
  assert.match(redrawn.parentNode!.parentNode!.parentNode!.textContent, /音量 \+2 dB/);
  for (const index of [3, 2, 1]) h.gains[index]!.work.resolve(undefined);
  await flushSample();
  assert.equal(h.sdk.state, authoritative); assert.equal(slider(h), redrawn); assert.equal(slider(h, 'speaker-b'), redrawnSecond);
  assert.equal(redrawn.value, '2'); assert.equal(redrawnSecond.value, '-3'); assert.equal(errorBox(h).hidden, true);
});

it('whole sample checks gain error ownership at the UI write when rejection and replacement interleave in microtasks', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h); release(slider(h), 1); await flushSample();
  h.gains[0]!.work.reject(new Error('較早的音量錯誤。'));
  // The cross-realm fixture promise first settles the VM await. A wrapper that checks
  // ownership and then rethrows adds another continuation after the replacement below.
  await Promise.resolve(); await Promise.resolve();
  const replacement = managementState(); replacement.roomId = 'replacement-room'; h.sdk.snapshot(replacement);
  h.sdk.emit('error', { message: '目前房間的錯誤。' }); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '目前房間的錯誤。');
});

it('whole sample unrelated generic output-device action still reports its failure after Leave', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const output = new Deferred<void>();
  Object.assign(h.sdk, { setOutputDevice: (id: string) => { h.sdk.outputDevices.push(id); return output.promise; } });
  t.after(async () => { if (output.status === 'pending') output.resolve(undefined); await flushSample(); });
  const select = h.id('speaker-device'); select.value = 'speaker-a'; assert.ok(select.onchange); select.onchange();
  assert.deepEqual(h.sdk.outputDevices, ['speaker-a']); assert.equal(select.disabled, true);
  h.button('離開房間').click(); await flushSample(); assertLanding(h);
  assert.equal(output.status, 'pending'); output.reject(new Error('揚聲器選擇失敗。')); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '揚聲器選擇失敗。');
  assert.equal(select.disabled, false); assert.equal(select.value, '');
});

for (const recoveredStatus of ['live', 'waiting'] as const) {
  it(`whole sample disables connected gains on reconnect and restores them on ${recoveredStatus} status`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h);
    const first = slider(h), second = slider(h, 'speaker-b');
    const forceMute = h.find(node => node.dataset.roomAction === 'force-mute:speaker-a');
    assert.equal(first.disabled, false); assert.equal(second.disabled, false);
    h.sdk.setStatus('reconnecting');
    assert.equal(h.sdk.state?.status, 'live', 'socket status does not rewrite the retained room snapshot');
    assert.equal(slider(h), first); assert.equal(first.isConnected, true);
    assert.equal(first.disabled, true); assert.equal(second.disabled, true); assert.equal(forceMute.disabled, true);
    assert.equal(first.attributes['aria-busy'], 'false', 'reconnect is not a pending gain request');
    h.sdk.setStatus(recoveredStatus);
    assert.equal(slider(h), first); assert.equal(first.disabled, false); assert.equal(second.disabled, false);
    release(first, 3); release(second, -4);
    assert.deepEqual(h.gains.map(({ targetId, gainDb }) => ({ targetId, gainDb })), [
      { targetId: 'speaker-a', gainDb: 3 }, { targetId: 'speaker-b', gainDb: -4 },
    ]);
    for (const { work } of h.gains) work.resolve(undefined);
    await flushSample();
  });
}

it('whole sample gain handler rejects explicit disabled and reconnect bypasses without hiding the current error', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const current = slider(h); assert.ok(current.onchange);
  h.sdk.emit('error', { message: '目前房間的錯誤。' });
  current.disabled = true; current.value = '4'; current.onchange();
  await flushSample();
  assert.equal(h.gains.length, 0); assert.equal(errorBox(h).hidden, false);
  assert.equal(errorBox(h).textContent, '目前房間的錯誤。');
  current.disabled = false; h.sdk.setStatus('reconnecting');
  // Explicit handler calls and tampered disabled state are defensive probes, not browser gestures.
  current.disabled = false; current.value = '5'; current.onchange(); await flushSample();
  assert.equal(h.gains.length, 0); assert.equal(errorBox(h).hidden, false);
  assert.equal(errorBox(h).textContent, '目前房間的錯誤。');
  h.sdk.setStatus('live'); release(current, 6);
  assert.equal(h.gains.length, 1); assert.equal(errorBox(h).hidden, true);
  h.gains[0]!.work.resolve(undefined); await flushSample();
});

it('whole sample defensively redraws retained gains disabled while socket status remains reconnecting', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const retired = slider(h); h.sdk.setStatus('reconnecting');
  const retained = h.sdk.state; assert.ok(retained);
  // Defensive public-event replay only. Real room:state processing restores a non-reconnecting
  // status before its state notification; no reconnecting room:state payload is invented here.
  h.sdk.emit('state', retained);
  const current = slider(h), second = slider(h, 'speaker-b');
  assert.notEqual(current, retired); assert.equal(retired.isConnected, false);
  assert.equal(h.sdk.status, 'reconnecting'); assert.equal(current.isConnected, true);
  assert.equal(current.disabled, true); assert.equal(second.disabled, true);
  h.sdk.emit('error', { message: '重連中的目前錯誤。' });
  assert.ok(current.onchange); current.value = '7'; current.onchange(); await flushSample();
  assert.equal(h.gains.length, 0); assert.equal(errorBox(h).hidden, false);
  assert.equal(errorBox(h).textContent, '重連中的目前錯誤。');
  h.sdk.snapshot(managementState());
  assert.equal(h.sdk.status, 'live'); assert.equal(slider(h).disabled, false);
  release(slider(h), -2); h.gains[0]!.work.resolve(undefined); await flushSample();
});

it('whole sample keeps reconnect restrictions through concurrent gain settlements and reports current errors', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  const first = slider(h), second = slider(h, 'speaker-b');
  release(first, 1); release(first, 2); release(second, -3);
  assert.equal(h.gains.length, 3); assert.ok(h.gains.every(({ work }) => work.status === 'pending'));
  assert.equal(first.disabled, false); assert.equal(second.disabled, false);
  h.sdk.setStatus('reconnecting');
  h.gains[0]!.work.resolve(undefined); await flushSample();
  assert.equal(first.disabled, true); assert.equal(second.disabled, true);
  assert.equal(h.gains[1]!.work.status, 'pending'); assert.equal(h.gains[2]!.work.status, 'pending');
  h.gains[1]!.work.reject(new Error('目前音量請求失敗。')); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '目前音量請求失敗。');
  assert.equal(first.disabled, true); assert.equal(second.disabled, true);
  assert.deepEqual(h.sdk.state!.speakers.map(person => person.gainDb), [0, 0]);

  const resumed = managementState(); resumed.speakers[0]!.gainDb = 1;
  h.sdk.snapshot(resumed);
  const current = slider(h), other = slider(h, 'speaker-b');
  assert.equal(first.isConnected, false); assert.equal(current.disabled, false); assert.equal(other.disabled, false);
  assert.equal(current.value, '1'); assert.equal(h.gains[2]!.work.status, 'pending');
  release(current, 5); release(other, -6);
  assert.equal(h.gains.length, 5, 'resumed gains are not locked behind earlier requests');
  h.gains[2]!.work.reject(new Error('同一房間的較早音量請求失敗。')); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '同一房間的較早音量請求失敗。');
  assert.equal(current.disabled, false); assert.equal(other.disabled, false);
  h.gains[4]!.work.resolve(undefined); h.gains[3]!.work.resolve(undefined); await flushSample();
  assert.equal(slider(h), current); assert.equal(current.value, '5');
  assert.deepEqual(h.sdk.state!.speakers.map(person => person.gainDb), [1, 0], 'ACKs do not invent gain snapshots');
});

it('whole sample leaves local playback controls usable while reconnect disables speaker gains', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h); h.sdk.setStatus('reconnecting');
  assert.equal(slider(h).disabled, true);
  const volume = h.id('playback-volume'), mute = h.id('playback-mute');
  assert.equal(volume.disabled, false); assert.equal(mute.disabled, false);
  assert.ok(volume.oninput); volume.value = '27'; volume.oninput(); mute.click(); await flushSample();
  assert.equal(h.sdk.playbackVolume, 0.27); assert.equal(h.sdk.playbackMuted, true);
  assert.equal(mute.attributes['aria-pressed'], 'true'); assert.equal(h.gains.length, 0);
  assert.equal(slider(h).disabled, true); assert.equal(h.sdk.status, 'reconnecting');
  volume.value = '63'; volume.oninput(); mute.click(); await flushSample();
  assert.equal(h.sdk.playbackVolume, 0.63); assert.equal(h.sdk.playbackMuted, false);
  assert.equal(mute.attributes['aria-pressed'], 'false'); assert.equal(h.gains.length, 0);
});

/** Only framing/lifecycle is modeled; no actual WebSocket, WebRTC, media, or browser input runs. */
class GainSocket {
  static OPEN = 1;
  static instances: GainSocket[] = [];
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { GainSocket.instances.push(this); }
  send(data: string): void {
    assert.equal(this.readyState, GainSocket.OPEN);
    const message = JSON.parse(data) as ClientMessage; this.sent.push(message);
    if (message.type === 'rtc:offer') queueMicrotask(() => {
      this.deliver({ type: 'ok', requestId: message.requestId });
      this.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
    });
  }
  deliver(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello(): void {
    this.readyState = GainSocket.OPEN;
    this.deliver({ type: 'hello', protocol: 1, serverVersion: 'test',
      limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } });
  }
  close(): void { this.readyState = 3; this.onclose?.(); }
}
class GainPeer {
  connectionState = 'new'; signalingState = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as unknown,
      async replaceTrack(track: unknown) { this.track = track; } } };
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
  async setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description; this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description; this.signalingState = 'stable';
  }
  close(): void { this.connectionState = 'closed'; }
}
interface GainClient {
  readonly state: RoomStatePayload | null;
  readonly status: string;
  join(options: { roomId: string; name: string }): Promise<void>;
  setGain(targetId: string, gainDb: number): Promise<void>;
  disconnect(): Promise<void>;
}

it('whole sample with actual SDK blocks gain through socket loss and OPEN-before-hello until the resumed snapshot', async t => {
  // URL import avoids adding the browser SDK's DOM type graph to the server test project.
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const originals = new Map(['window', 'WebSocket', 'navigator', 'RTCPeerConnection']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: GainSocket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: GainPeer });
  Object.defineProperty(globalThis, 'navigator', { configurable: true,
    value: { mediaDevices: { enumerateDevices: async () => [] } } });
  GainSocket.instances = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await flushSample(); };
  const sdk: GainClient = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    reconnect: { initialDelayMs: 500, maxDelayMs: 500 }, audioElement: { volume: 1, muted: false, pause() {} } });
  const h = sampleApp({ sdk });
  t.after(async () => {
    try { await h.cleanup(); }
    finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const state = managementState();
  const joining = sdk.join({ roomId: state.roomId, name: state.me.name });
  const old = GainSocket.instances[0]!; old.hello(); await flushSample(); await tick(0);
  const joiningRequest = old.sent.find(message => message.type === 'join'); assert.ok(joiningRequest);
  old.deliver({ type: 'room:state', ...state }); old.deliver({ type: 'ok', requestId: joiningRequest.requestId });
  await joining; await flushSample(); await tick(100);
  const original = slider(h); assert.equal(original.isConnected, true); assert.equal(original.disabled, false);
  const gainCalls = t.mock.method(sdk, 'setGain');
  old.close(); await flushSample();
  assert.equal(sdk.status, 'reconnecting'); assert.equal(slider(h), original); assert.equal(original.disabled, true);
  assert.ok(original.onchange); original.value = '2'; original.onchange(); await flushSample();
  assert.equal(gainCalls.mock.calls.length, 0); assert.equal(errorBox(h).hidden, true);

  await tick(500);
  const replacement = GainSocket.instances.at(-1)!; assert.notEqual(replacement, old);
  replacement.readyState = GainSocket.OPEN;
  assert.equal(sdk.status, 'reconnecting');
  assert.equal(h.find(node => node.dataset.roomAction === 'force-mute:speaker-a').disabled, true);
  original.value = '4'; original.onchange(); await tick(0);
  assert.equal(gainCalls.mock.calls.length, 0);
  assert.equal(replacement.sent.filter(message => message.type === 'mic:gain').length, 0);

  replacement.hello(); await flushSample(); await tick(0);
  const resume = replacement.sent.find(message => message.type === 'join'); assert.ok(resume);
  assert.equal(sdk.status, 'reconnecting'); assert.equal(original.disabled, true);
  original.value = '6'; original.onchange(); await tick(100);
  assert.equal(gainCalls.mock.calls.length, 0);
  assert.equal(replacement.sent.filter(message => message.type === 'mic:gain').length, 0);
  const resumed = managementState(); resumed.speakers[0]!.gainDb = 3;
  replacement.deliver({ type: 'room:state', ...resumed });
  replacement.deliver({ type: 'ok', requestId: resume.requestId }); await flushSample();
  assert.equal(sdk.status, 'live'); assert.equal(original.isConnected, false);
  const current = slider(h); assert.equal(current.disabled, false); assert.equal(current.value, '3');
  release(current, 5); await tick(0);
  assert.equal(gainCalls.mock.calls.length, 1);
  const gain = replacement.sent.find(message => message.type === 'mic:gain'); assert.ok(gain);
  assert.equal(gain.targetId, 'speaker-a'); assert.equal(gain.gainDb, 5);
  replacement.deliver({ type: 'ok', requestId: gain.requestId }); await flushSample();
  assert.equal(errorBox(h).hidden, true); assert.equal(current.disabled, false);
  assert.equal(sdk.state?.speakers[0]?.gainDb, 3, 'gain ACK does not replace the authoritative snapshot');
});
