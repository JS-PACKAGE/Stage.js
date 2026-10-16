import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { it, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ClientMessage, ParticipantView, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { Deferred, EmbedNode, embedApp, flush } from './fixtures/embedApp.ts';
import type { EmbedSdk } from './fixtures/embedApp.ts';

const latest = (sdk: EmbedSdk): Deferred => { const action = sdk.actions.at(-1); assert.ok(action); return action.work; };
function assertMic(mic: EmbedNode, expected: { hidden?: boolean; disabled?: boolean; muted?: boolean; busy?: boolean; forced?: boolean }): void {
  assert.equal(mic.attributes['aria-label'], '麥克風靜音', 'the toggle keeps its accessible name across changes');
  if (expected.hidden !== undefined) assert.equal(mic.hidden, expected.hidden);
  if (expected.disabled !== undefined) assert.equal(mic.disabled, expected.disabled);
  if (expected.muted !== undefined) assert.equal(mic.attributes['aria-pressed'], String(expected.muted));
  if (expected.busy !== undefined) assert.equal(mic.attributes['aria-busy'], String(expected.busy));
  if (expected.forced) assert.equal(mic.textContent, '麥克風已被主控靜音');
  else if (expected.muted !== undefined) assert.equal(mic.textContent, expected.muted ? '取消麥克風靜音' : '靜音麥克風');
}

it('whole embed provides an initially hidden native microphone toggle with an accessible pressed state', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const button = html.match(/<button\b[^>]*\bid="mic"[^>]*>[^<]*<\/button>/)?.[0];
  assert.ok(button, 'a promoted embed participant needs a visible microphone control');
  for (const attribute of ['type="button"', 'aria-label="麥克風靜音"', 'aria-pressed="false"', 'aria-busy="false"', 'hidden', 'disabled']) {
    assert.ok(button.includes(attribute), `native microphone button has ${attribute}`);
  }
});

it('whole embed microphone stays hidden before a snapshot and for audience, even on direct invocation', async t => {
  const h = embedApp(); t.after(() => h.cleanup());
  assertMic(h.mic, { hidden: true, disabled: true, muted: false, busy: false }); h.mic.invoke();
  assert.equal(h.clients.length, 0);
  h.form.submit(); await flush(); const sdk = h.clients[0]!;
  h.mic.disabled = false; h.mic.hidden = false; h.mic.invoke();
  assertMic(h.mic, { hidden: true, disabled: true, busy: false }); assert.equal(sdk.actions.length, 0);
  sdk.snapshot(); h.mic.disabled = false; h.mic.hidden = false; h.mic.invoke();
  assertMic(h.mic, { hidden: true, disabled: true, muted: false }); assert.equal(sdk.actions.length, 0);
});

for (const role of ['speaker', 'controller'] as const) {
  it(`whole embed microphone follows onStage rather than the ${role} role alone`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role, onStage: false });
    assertMic(h.mic, { hidden: true, disabled: true }); h.mic.invoke(); assert.equal(sdk.actions.length, 0);
    sdk.snapshot({ onStage: true }); assertMic(h.mic, { hidden: false, disabled: false, muted: false });
    h.mic.click(); assert.equal(sdk.actions.length, 1); assert.equal(sdk.actions[0]!.type, 'mute');
    sdk.snapshot({ onStage: false }); assertMic(h.mic, { hidden: true, disabled: true, busy: true });
    latest(sdk).resolve(); await flush(); assertMic(h.mic, { hidden: true, disabled: true, busy: false });
    h.mic.invoke(); assert.equal(sdk.actions.length, 1);
  });
}

for (const muted of [false, true]) {
  it(`whole embed ${muted ? 'unmute' : 'mute'} stays locked across state-before-ACK without optimistic state`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'speaker', onStage: true, muted });
    h.mic.click(); assert.equal(sdk.actions.length, 1); assert.equal(sdk.actions[0]!.type, muted ? 'unmute' : 'mute');
    assert.equal(sdk.me!.muted, muted); assertMic(h.mic, { hidden: false, disabled: true, muted, busy: true });
    h.mic.invoke(); sdk.snapshot(); sdk.setStatus('live'); h.mic.click();
    assert.equal(sdk.actions.length, 1, 'repaints and repeat clicks cannot submit the same pending action');
    sdk.snapshot({ muted: !muted }); assertMic(h.mic, { disabled: true, muted: !muted, busy: true }); h.mic.invoke();
    assert.equal(sdk.actions.length, 1, 'state-before-ACK cannot submit the opposite microphone action');
    latest(sdk).resolve(); await flush(); assertMic(h.mic, { disabled: false, muted: !muted, busy: false });
    h.mic.click(); assert.equal(sdk.actions.length, 2); assert.equal(sdk.actions[1]!.type, muted ? 'mute' : 'unmute');
  });
}

it('whole embed ACK alone never invents a microphone state change', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'speaker', onStage: true });
  h.mic.click(); latest(sdk).resolve(); await flush();
  assert.equal(sdk.me!.muted, false); assertMic(h.mic, { disabled: false, muted: false, busy: false });
  sdk.snapshot({ muted: true }); assertMic(h.mic, { disabled: false, muted: true });
  h.mic.click(); assert.equal(sdk.actions[1]!.type, 'unmute');
});

it('whole embed microphone handler resynchronizes authoritative state before selecting an action', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ onStage: true, role: 'speaker' });
  sdk.me!.muted = true; h.mic.invoke(); assert.equal(sdk.actions[0]!.type, 'unmute');
  assertMic(h.mic, { disabled: true, muted: true, busy: true }); latest(sdk).resolve(); await flush();
  for (const restriction of ['offstage', 'forced', 'reconnecting'] as const) {
    sdk.me!.onStage = restriction !== 'offstage'; sdk.me!.forceMuted = restriction === 'forced';
    sdk.status = restriction === 'reconnecting' ? 'reconnecting' : 'live';
    h.mic.hidden = false; h.mic.disabled = false; h.mic.invoke();
    assert.equal(sdk.actions.length, 1, `${restriction} must be checked inside the handler`); assert.equal(h.mic.disabled, true);
  }
});

for (const failure of ['rejection', 'synchronous throw'] as const) {
  for (const muted of [false, true]) {
    it(`whole embed ${muted ? 'unmute' : 'mute'} ${failure} releases the current lock for retry`, async t => {
      const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'speaker', onStage: true, muted });
      const method = muted ? 'unmute' : 'mute', original = sdk[method].bind(sdk); let attempts = 0;
      if (failure === 'synchronous throw') sdk[method] = () => { if (++attempts === 1) throw new Error('麥克風操作失敗，請重試。'); return original(); };
      h.mic.click(); if (failure === 'rejection') latest(sdk).reject('麥克風操作失敗，請重試。');
      await flush(); assert.equal(h.status.textContent, '麥克風操作失敗，請重試。');
      assertMic(h.mic, { disabled: false, muted, busy: false }); assert.equal(sdk.me!.muted, muted);
      const count = sdk.actions.length; h.mic.click(); assert.equal(sdk.actions.length, count + 1);
      assert.equal(sdk.actions.at(-1)!.type, method); assertMic(h.mic, { disabled: true, busy: true });
    });
  }
}

for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed controller force-mute wins over pending unmute ${settlement}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'speaker', onStage: true, muted: true });
    h.mic.click(); const work = latest(sdk); assert.equal(sdk.actions[0]!.type, 'unmute');
    sdk.snapshot({ muted: true, forceMuted: true }); assertMic(h.mic, { disabled: true, muted: true, busy: true, forced: true });
    h.mic.invoke(); assert.equal(sdk.actions.length, 1);
    if (settlement === 'resolve') work.resolve(); else work.reject('禁止此操作。');
    await flush(); assertMic(h.mic, { disabled: true, muted: true, busy: false, forced: true });
    h.mic.disabled = false; h.mic.invoke(); assert.equal(sdk.actions.length, 1);
    sdk.snapshot({ forceMuted: false }); assertMic(h.mic, { disabled: false, muted: true, busy: false });
    h.mic.click(); assert.equal(sdk.actions[1]!.type, 'unmute', 'lifting the controller lock keeps authoritative self mute');
  });
}

it('whole embed same-client reconnect retains the pending lock until settlement and recovers on status alone', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'speaker', onStage: true });
  h.mic.click(); sdk.setStatus('reconnecting'); h.mic.invoke();
  assertMic(h.mic, { hidden: false, disabled: true, busy: true }); assert.equal(sdk.actions.length, 1);
  sdk.snapshot({ muted: true }); assertMic(h.mic, { disabled: true, muted: true, busy: true });
  latest(sdk).reject('連線已中斷。'); await flush(); assertMic(h.mic, { disabled: true, muted: true, busy: false });
  h.mic.invoke(); assert.equal(sdk.actions.length, 1);
  sdk.setStatus('live'); assertMic(h.mic, { disabled: false, muted: true, busy: false });
  h.mic.click(); assert.equal(sdk.actions[1]!.type, 'unmute');
  sdk.setStatus('reconnecting'); sdk.setStatus('live'); h.mic.invoke();
  assertMic(h.mic, { disabled: true, busy: true }); assert.equal(sdk.actions.length, 2);
});

for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const) {
  for (const settlement of ['resolve', 'reject'] as const) {
    it(`whole embed ${terminal} retires pending microphone ${settlement} without changing terminal feedback`, async t => {
      const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'speaker', onStage: true });
      h.mic.click(); const work = latest(sdk);
      if (terminal === 'leave') h.leave.click();
      else { await sdk.disconnect(); if (terminal !== 'disconnected') sdk.emit(terminal, { roomId: 'same-room' }); }
      await flush(); const status = h.status.textContent;
      assertMic(h.mic, { hidden: true, disabled: true, muted: false, busy: false }); h.mic.invoke();
      if (settlement === 'resolve') work.resolve(); else work.reject('retired microphone failure');
      await flush(); assert.equal(h.status.textContent, status); assert.equal(sdk.actions.length, 1);
      assertMic(h.mic, { hidden: true, disabled: true, busy: false });
    });
  }
}

for (const transition of ['leave and rejoin', 'replacement join'] as const) {
  for (const settlement of ['resolve', 'reject'] as const) {
    it(`whole embed ${transition} ignores old microphone ${settlement} while the replacement remains pending`, async t => {
      const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join({ role: 'speaker', onStage: true });
      h.mic.click(); const retired = latest(old);
      if (transition === 'leave and rejoin') { h.leave.click(); await flush(); }
      const current = await h.join({ role: 'speaker', onStage: true, muted: true }); h.mic.click();
      const active = latest(current), status = h.status.textContent;
      if (settlement === 'resolve') retired.resolve(); else retired.reject('retired microphone failure');
      await flush(); assert.equal(h.status.textContent, status); assertMic(h.mic, { hidden: false, disabled: true, muted: true, busy: true });
      old.snapshot({ forceMuted: true, muted: true }); old.setStatus('disconnected'); old.emit('closed', { roomId: 'same-room' }); old.emit('kicked', { roomId: 'same-room' });
      h.mic.invoke(); assert.equal(h.status.textContent, status); assertMic(h.mic, { hidden: false, disabled: true, muted: true, busy: true });
      assert.equal(old.actions.length, 1); assert.equal(current.actions.length, 1);
      current.snapshot({ muted: false }); active.resolve(); await flush(); assertMic(h.mic, { disabled: false, muted: false, busy: false });
      h.mic.click(); assert.equal(current.actions[1]!.type, 'mute');
    });
  }
}

for (const transition of ['leave', 'replacement join'] as const) {
  it(`whole embed ${transition} immediately gates microphone actions while disconnect is pending`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'speaker', onStage: true });
    const disconnect = sdk.disconnect.bind(sdk), gate = new Deferred();
    sdk.disconnect = async () => { await gate.promise; await disconnect(); };
    t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); });
    h.mic.click(); const retired = latest(sdk);
    if (transition === 'leave') h.leave.click(); else h.form.submit();
    assertMic(h.mic, { hidden: true, disabled: true, busy: false });
    h.mic.disabled = false; h.mic.hidden = false; h.mic.invoke();
    assertMic(h.mic, { hidden: true, disabled: true, busy: false }); assert.equal(sdk.actions.length, 1);
    sdk.snapshot({ muted: true }); sdk.setStatus('reconnecting'); sdk.setStatus('live'); h.mic.invoke();
    assertMic(h.mic, { hidden: true, disabled: true, busy: false }); assert.equal(sdk.actions.length, 1);
    const status = h.status.textContent; retired.reject('late retired failure'); await flush(); assert.equal(h.status.textContent, status);
    gate.resolve(); await flush(); assertMic(h.mic, { hidden: true, disabled: true, busy: false });
  });
}

interface ActualClient { readonly status: string; readonly me: ParticipantView | null; disconnect(): Promise<void> }
class MicSocket {
  static OPEN = 1;
  static instances: MicSocket[] = [];
  readyState = MicSocket.OPEN;
  readonly sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { MicSocket.instances.push(this); }
  send(data: string): void { assert.equal(this.readyState, MicSocket.OPEN); this.sent.push(JSON.parse(data) as ClientMessage); }
  deliver(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  close(): void { this.readyState = 3; this.onclose?.(); }
}
class MicPeer {
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = null;
  private rejectOffer: ((error: Error) => void) | undefined;
  addTransceiver() { return { direction: 'recvonly', sender: { track: null as unknown, async replaceTrack(track: unknown) { this.track = track; } } }; }
  // Hold unrelated SDP negotiation; normal SDK cleanup retires this pending offer.
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  close(): void { this.connectionState = 'closed'; this.rejectOffer?.(new Error('test peer closed')); }
}
class MicContext {
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData() {}, disconnect() {} }; }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}
function actualState(overrides: Partial<ParticipantView> = {}): RoomStatePayload {
  return { roomId: 'same-room', name: '測試舞台', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', resumeToken: 'test-resume',
    me: { participantId: 'guest', name: '測試聽眾', role: 'audience', onStage: false, handRaised: false,
      muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0, ...overrides } };
}
/** The complete embed and actual SDK, with only browser media/socket boundaries replaced. */
async function actualApp(t: TestContext) {
  const { StageClient, decodeName } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const tracks: { enabled: boolean; stopped: boolean; stop(): void }[] = [];
  const globals = { window: new EventTarget(), WebSocket: MicSocket, RTCPeerConnection: MicPeer, AudioContext: MicContext,
    navigator: { mediaDevices: { async getUserMedia() {
      const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stopped: false,
        stop() { this.stopped = true; this.readyState = 'ended'; } }); tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  MicSocket.instances = []; t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const nodes = new Map(['host', 'ws-path', 'room', 'code', 'name', 'status', 'room-occupancy', 'own-connection-quality', 'speaking-summary', 'connection-stats-panel', 'connection-stats-update', 'connection-stats-text', 'hand-rejected', 'error-notice', 'last-error', 'error-dismiss', 'join', 'hand', 'mic', 'rename', 'room-name-panel', 'room-name-current', 'room-name-draft', 'room-name-update', 'hand-queue', 'hand-queue-summary', 'hand-queue-notice', 'hand-queue-list', 'stage-management', 'stage-management-summary', 'stage-management-notice', 'stage-management-list', 'stage', 'mic-retry', 'audio-retry', 'audio-retry-status', 'microphone-panel', 'microphone-device', 'microphone-refresh', 'microphone-apply', 'microphone-draft-notice', 'output-panel', 'output-device', 'output-refresh', 'output-apply', 'output-draft-notice', 'output-support', 'cancel-join', 'leave', 'close-room', 'audio', 'unlock'].map(id => [id, new EmbedNode()]));
  const node = (id: string): EmbedNode => { const found = nodes.get(id); assert.ok(found); return found; };
  node('connection-stats-panel').append(node('connection-stats-update'), node('connection-stats-text'));
  node('error-notice').hidden = true; node('hand-rejected').hidden = true; node('room-occupancy').hidden = true; node('own-connection-quality').hidden = true; node('speaking-summary').hidden = true;
  const cancel = node('cancel-join'); cancel.hidden = cancel.disabled = true; cancel.textContent = '取消連線';
  const form = node('join'), mic = node('mic'), status = node('status'), leave = node('leave');
  form.submitButton = new EmbedNode(); node('name').value = '測試聽眾'; mic.setAttribute('aria-label', '麥克風靜音');
  mic.hidden = mic.disabled = true; mic.textContent = '靜音麥克風';
  mic.setAttribute('aria-pressed', 'false'); mic.setAttribute('aria-busy', 'false');
  Object.assign(node('audio'), { pause() {} });
  const clients: ActualClient[] = [];
  const library = { StageClient: function (options: unknown): ActualClient { const client: ActualClient = new StageClient(options); clients.push(client); return client; }, decodeName };
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8'), dynamicImport = 'import(/* @vite-ignore */ moduleUrl)';
  assert.equal(source.split(dynamicImport).length, 2); assert.equal(source.split("import './styles.css';").length, 2);
  const executable = stripTypeScriptTypes(source.replace("import './styles.css';", '').replace(dynamicImport, 'loadLibrary(moduleUrl)'));
  assert.doesNotMatch(executable, /\bimport\s*(?:\(|['"])/, 'the external-host import must stay mocked');
  runInNewContext(executable, {
    document: { createElement(tag: string) { assert.equal(tag, 'option'); return new EmbedNode(); }, querySelector(selector: string) { assert.match(selector, /^#[a-z-]+$/); return node(selector.slice(1)); } },
    location: { search: '?room=same-room', origin: 'https://stage.example.test' },
    URL, URLSearchParams, Error, Promise, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    loadLibrary: async (url: string) => { assert.equal(url, 'https://stage.example.test/lib/stage-client.js'); return library; },
  }, { filename: 'web/src/embed.ts', timeout: 1000 });
  const tick = async (ms = 10): Promise<void> => { now += ms; t.mock.timers.tick(ms); await flush(); };
  t.after(async () => {
    try {
      for (const client of clients) await client.disconnect(); await flush();
      assert.ok(clients.every(client => client.status === 'disconnected' && client.me === null));
      assert.ok(MicSocket.instances.every(socket => socket.readyState === 3)); assert.ok(tracks.every(track => track.stopped));
    } finally {
      for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
  return { mic, status, leave, clients, tracks, tick,
    async join(): Promise<MicSocket> {
      form.submit(); await flush(); const socket = MicSocket.instances.at(-1); assert.ok(socket);
      socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
      await flush(); await tick(); const request = socket.sent.find(message => message.type === 'join'); assert.ok(request);
      socket.deliver({ type: 'room:state', ...actualState() }); socket.deliver({ type: 'ok', requestId: request.requestId }); await flush(); return socket;
    },
    async command(socket: MicSocket, type: 'mic:mute' | 'mic:unmute') {
      const before = socket.sent.length; mic.click(); await tick(); const request = socket.sent.at(-1);
      assert.equal(socket.sent.length, before + 1); assert.ok(request && request.type === type); return request;
    },
  };
}

it('whole embed actual SDK promotion exposes microphone control and only snapshots mute its captured track', async t => {
  const h = await actualApp(t), socket = await h.join();
  assert.equal(h.tracks.length, 0); assertMic(h.mic, { hidden: true, disabled: true });
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) }); await flush();
  assert.equal(h.tracks.length, 1); const track = h.tracks[0]!; assert.equal(track.enabled, true);
  assertMic(h.mic, { hidden: false, disabled: false, muted: false });
  const mute = await h.command(socket, 'mic:mute');
  assert.equal(track.enabled, true); assert.equal(h.clients[0]!.me!.muted, false); assertMic(h.mic, { disabled: true, muted: false, busy: true });
  socket.deliver({ type: 'mic:muted', participantId: 'guest' }); await flush();
  assert.equal(track.enabled, true, 'an informational mic event is not a room snapshot');
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true }) }); await flush();
  assert.equal(track.enabled, false); assertMic(h.mic, { disabled: true, muted: true, busy: true });
  const count = socket.sent.length; h.mic.invoke(); await h.tick(); assert.equal(socket.sent.length, count);
  socket.deliver({ type: 'ok', requestId: mute.requestId }); await flush(); assertMic(h.mic, { disabled: false, muted: true, busy: false });
  const unmute = await h.command(socket, 'mic:unmute');
  socket.deliver({ type: 'ok', requestId: unmute.requestId }); await flush();
  assert.equal(track.enabled, false, 'ACK alone cannot open the microphone'); assertMic(h.mic, { disabled: false, muted: true, busy: false });
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) }); await flush();
  assert.equal(track.enabled, true); assertMic(h.mic, { disabled: false, muted: false });
  socket.deliver({ type: 'room:state', ...actualState({ role: 'controller', onStage: false }) }); await flush();
  assert.equal(track.stopped, true); assertMic(h.mic, { hidden: true, disabled: true });
});

it('whole embed actual SDK force-mute failure permits retry only after the controller restriction clears', async t => {
  const h = await actualApp(t), socket = await h.join();
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true }) }); await flush();
  const request = await h.command(socket, 'mic:unmute');
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true, forceMuted: true }) });
  socket.deliver({ type: 'error', requestId: request.requestId, code: 'forbidden', message: '禁止此操作。' }); await flush();
  assert.equal(h.status.textContent, '禁止此操作。'); assert.equal(h.tracks[0]!.enabled, false);
  assertMic(h.mic, { disabled: true, muted: true, busy: false, forced: true });
  const count = socket.sent.length; h.mic.invoke(); await h.tick(); assert.equal(socket.sent.length, count);
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true }) }); await flush();
  assertMic(h.mic, { disabled: false, muted: true, busy: false }); const retry = await h.command(socket, 'mic:unmute');
  h.leave.click(); await flush(); const status = h.status.textContent;
  assert.equal(status, '已離開。'); assertMic(h.mic, { hidden: true, disabled: true, busy: false }); assert.equal(h.tracks[0]!.stopped, true);
  socket.deliver({ type: 'ok', requestId: retry.requestId });
  socket.deliver({ type: 'error', requestId: retry.requestId, code: 'forbidden', message: 'late failure' }); await flush();
  assert.equal(h.status.textContent, status);
  const current = await h.join(); current.deliver({ type: 'room:state', ...actualState({ role: 'controller', onStage: true }) }); await flush();
  const pending = await h.command(current, 'mic:mute'), newStatus = h.status.textContent;
  socket.deliver({ type: 'error', requestId: retry.requestId, code: 'forbidden', message: 'retired error' }); await flush();
  assert.equal(h.status.textContent, newStatus); assertMic(h.mic, { disabled: true, muted: false, busy: true });
  current.deliver({ type: 'ok', requestId: pending.requestId }); await flush(); assertMic(h.mic, { disabled: false, muted: false, busy: false });
});

it('whole embed actual SDK socket recovery preserves the microphone track and restores the same client toggle', async t => {
  const h = await actualApp(t), socket = await h.join(), client = h.clients[0]!;
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) }); await flush();
  const request = await h.command(socket, 'mic:mute'), track = h.tracks[0]!;
  socket.close(); await flush(); assert.equal(client.status, 'reconnecting');
  assert.equal(track.stopped, false, 'a recoverable socket drop retains the existing media session');
  assertMic(h.mic, { hidden: false, disabled: true, muted: false, busy: false }); h.mic.invoke();
  assert.equal(socket.sent.filter(message => message.type === 'mic:mute').length, 1);
  await h.tick(500); const resumed = MicSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  resumed.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await flush(); await h.tick(); const join = resumed.sent.find(message => message.type === 'join'); assert.ok(join);
  resumed.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true }) });
  resumed.deliver({ type: 'ok', requestId: join.requestId }); await flush();
  assert.equal(h.clients.length, 1); assert.equal(h.clients[0], client); assert.equal(h.tracks.length, 1); assert.equal(track.enabled, false);
  assertMic(h.mic, { hidden: false, disabled: false, muted: true, busy: false });
  const unmute = await h.command(resumed, 'mic:unmute'), status = h.status.textContent;
  socket.deliver({ type: 'error', requestId: request.requestId, code: 'forbidden', message: 'retired connection failure' }); await flush();
  assert.equal(h.status.textContent, status); assertMic(h.mic, { disabled: true, muted: true, busy: true });
  resumed.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) });
  resumed.deliver({ type: 'ok', requestId: unmute.requestId }); await flush();
  assert.equal(track.enabled, true); assertMic(h.mic, { disabled: false, muted: false, busy: false });
});
