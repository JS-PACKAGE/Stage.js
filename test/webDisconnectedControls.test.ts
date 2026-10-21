import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

// Both production modules execute whole. DOM, timers, dialogs, WebSocket and peer are controlled
// doubles; these tests do not claim browser layout, native permissions, signaling server or audio coverage.
const methods = ['raiseHand', 'withdrawHand', 'setName', 'setRoomName', 'mute', 'unmute', 'leaveStage',
  'returnToStage', 'approve', 'reject', 'forceMute', 'forceUnmute', 'removeFromStage', 'kick',
  'transferControl', 'closeRoom', 'setGain', 'rotateCode'] as const;
type Method = typeof methods[number];
type ActualClient = Record<Method, (...args: unknown[]) => Promise<void>> & {
  readonly state: RoomStatePayload | null;
  readonly status: string;
  readonly session: unknown;
  disconnect(): Promise<void>;
};
interface Request { type: string; requestId: string; targetId?: string; name?: string; gainDb?: number }
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
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
  close(): void { this.readyState = 3; this.onclose?.(); }
}
class Peer {
  static instances: Peer[] = [];
  connectionState = 'new'; signalingState = 'stable'; localDescription = null;
  closes = 0;
  private rejectOffer: ((error: Error) => void) | undefined;
  constructor() { Peer.instances.push(this); }
  addTransceiver() {
    return { direction: 'recvonly', sender: { track: null as unknown,
      async replaceTrack(track: unknown): Promise<void> { this.track = track; } } };
  }
  // Hold negotiation outside this control test; SDK destruction releases the pending offer.
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  async getStats(): Promise<Map<string, unknown>> { return new Map(); }
  close(): void { this.closes++; this.connectionState = 'closed'; this.rejectOffer?.(new Error('fixture peer closed')); }
}
type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'find'>;
const actions = (h: View): SampleNode[] => h.app.descendants().filter(node => node.dataset.roomAction !== undefined);
const matching = (h: View, key: string): SampleNode[] => actions(h).filter(node => node.dataset.roomAction === key);
function action(h: View, key: string, text?: string): SampleNode {
  const nodes = matching(h, key).filter(node => text === undefined || node.textContent === text);
  assert.ok(nodes.length, `missing room control ${key}`); return nodes[0]!;
}
const errorBox = (h: View): SampleNode => h.find(node => node.attributes.role === 'alert');
const forms = (h: View): SampleNode[] => h.app.descendants().filter(node => node.tagName === 'form' && !node.classList.contains('chat-form'));
function controllerState(onStage = false): RoomStatePayload {
  const state = roomState({ role: 'controller', onStage }); state.controllerId = state.me.participantId;
  const audience = roomState({ participantId: 'other', name: '其他觀眾', handRaised: true }).me;
  const speaker = roomState({ participantId: 'speaker-other', name: '其他發言者', role: 'speaker', onStage: true }).me;
  state.audience = [audience]; state.hands = [audience]; state.audienceCount = 1; state.speakers.push(speaker);
  state.status = 'live'; state.codeRequired = true;
  return state;
}
async function setup(t: TestContext) {
  // A dynamic URL import avoids pulling DOM types into the server project's type graph.
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
  const audio = { volume: 1, muted: false, srcObject: null as unknown, pause() {} };
  const sdk: ActualClient = new StageClient({ url: 'ws://localhost/ws', audioElement: audio, enableMicMeter: false,
    reconnect: { initialDelayMs: 20, maxDelayMs: 20 } });
  const dialogs: string[] = [];
  const h = sampleApp({ sdk,
    prompt: text => { dialogs.push(text); return '修改名稱'; },
    confirm: text => { dialogs.push(text); return true; } });
  const calls = Object.fromEntries(methods.map(name => [name, 0])) as Record<Method, number>;
  for (const name of methods) {
    const original = sdk[name].bind(sdk);
    t.mock.method(sdk, name, (...args: unknown[]) => { calls[name]++; return original(...args); });
  }
  t.after(async () => {
    try {
      await h.cleanup();
      assert.equal(getEventListeners(target, 'pagehide').length, 0);
      assert.ok(Peer.instances.every(peer => peer.closes === 1), 'each SDK peer is retired exactly once');
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const pump = async () => { await flushSample(); t.mock.timers.tick(10); await flushSample(); };
  const acknowledge = async (socket: Socket, request: Request) => {
    socket.deliver({ type: 'ok', requestId: request.requestId }); await flushSample();
  };
  await flushSample();
  return { ...h, calls, dialogs, pump, acknowledge, captures: () => captures,
    async enter(state: RoomStatePayload, kind: 'create' | 'join' = 'join', ack = false) {
      const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2'
        && child.textContent === (kind === 'create' ? '建立房間' : '加入房間')));
      for (const input of form.descendants().filter(node => node.tagName === 'input')) {
        if (input.name === 'name') input.value = '測試使用者';
        if (input.name === 'roomId') input.value = state.roomId;
        if (input.name === 'roomName') input.value = state.name;
      }
      form.submit(); const socket = Socket.instances.at(-1); assert.ok(socket); socket.hello(); await pump();
      const entry = socket.sent.find(message => message.type === (kind === 'create' ? 'room:create' : 'join')); assert.ok(entry);
      if (kind === 'create') socket.deliver({ type: 'room:created', roomId: state.roomId, code: 'TEST42' });
      socket.deliver({ type: 'room:state', ...state }); await flushSample();
      assert.equal(forms(h).length, 0); assert.equal(sdk.state?.roomId, state.roomId);
      assert.equal(sdk.session, null, 'authoritative entry state is received before the initial ACK');
      assert.equal(sdk.status, state.status);
      if (ack) { await acknowledge(socket, entry); assert.ok(sdk.session); }
      return { socket, entry };
    },
  };
}
type App = Awaited<ReturnType<typeof setup>>;
function feedback(h: App) { return { hidden: errorBox(h).hidden, text: errorBox(h).textContent }; }
function failBeforeAdmission(h: App): void {
  const before = feedback(h), calls = { ...h.calls }, dialogs = [...h.dialogs];
  assert.equal(before.hidden, false, 'retain the existing failure for the user');
  for (const node of actions(h)) {
    const key = node.dataset.roomAction!;
    assert.equal(node.disabled, true, `${key} must be visibly disabled`);
    assert.equal(node.attributes['aria-busy'], 'false', `${key} must not be pending`);
    // Deliberately bypass native disabled behavior: status must still deny the action itself.
    if (node.tagName === 'button') node.click();
    node.disabled = false;
    if (node.tagName === 'input') { node.value = '3'; assert.ok(node.onchange); node.onchange(); }
    else { assert.ok(node.onclick); node.onclick(); }
    assert.deepEqual(h.calls, calls, `${key} must not reach the SDK`);
    assert.deepEqual(h.dialogs, dialogs, `${key} must not open a prompt or confirmation`);
    assert.deepEqual(feedback(h), before, `${key} must not clear or replace the existing error`);
    assert.equal(node.attributes['aria-busy'], 'false', `${key} must not acquire pending state`);
    node.disabled = true;
  }
}
const scenarios: { name: string; state: () => RoomStatePayload; kind: 'create' | 'join'; keys: string[] }[] = [
  { name: 'audience raise', state: () => roomState(), kind: 'join', keys: ['hand', 'rename'] },
  { name: 'audience withdraw', state: () => roomState({ handRaised: true }), kind: 'join', keys: ['hand', 'rename'] },
  { name: 'speaker mute', state: () => roomState({ role: 'speaker', onStage: true }), kind: 'join', keys: ['mute', 'stage', 'rename'] },
  { name: 'speaker unmute', state: () => roomState({ role: 'speaker', onStage: true, muted: true }), kind: 'join', keys: ['mute', 'stage', 'rename'] },
  ...[false, true].map(onStage => ({ name: `controller ${onStage ? 'on' : 'off'} stage`, state: () => controllerState(onStage),
    kind: 'create' as const, keys: ['stage', 'rename', 'room-rename', 'stage:other', 'kick:other', 'transfer', 'close', 'gain:speaker-other'] })),
];
for (const scenario of scenarios) {
  it(`whole sample actual SDK pre-ACK ${scenario.kind} socket loss blocks ${scenario.name} before any admission side effect`, async t => {
    const h = await setup(t), { socket, entry } = await h.enter(scenario.state(), scenario.kind);
    for (const key of scenario.keys) assert.equal(action(h, key).disabled, false, `${key} is initially usable`);
    const snapshot = h.sdk.state, controls = actions(h); socket.close(); await flushSample();
    assert.equal(h.sdk.status, 'disconnected'); assert.equal(h.sdk.session, null); assert.equal(h.sdk.state, snapshot);
    assert.deepEqual(actions(h), controls, 'the pre-ACK retained view keeps its original controls');
    assert.equal(forms(h).length, 0);
    const before = feedback(h), sent = socket.sent.length, captures = h.captures();
    failBeforeAdmission(h); await h.pump();
    assert.deepEqual(feedback(h), before); assert.ok(Object.values(h.calls).every(count => count === 0));
    assert.equal(h.dialogs.length, 0); assert.equal(socket.sent.length, sent); assert.equal(h.captures(), captures);
    assert.ok(actions(h).every(node => node.disabled && node.attributes['aria-busy'] === 'false'));
    socket.deliver({ type: 'ok', requestId: entry.requestId }); await flushSample();
    assert.equal(h.sdk.session, null, 'a retired socket cannot install the initial session with a late ACK');
    assert.equal(h.button('離開房間').disabled, false); h.button('離開房間').click(); await flushSample();
    assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected'); assert.equal(forms(h).length, 2);
    assert.equal(h.clock.jobs.size, 0); assert.equal(socket.sent.length, sent);
    assert.ok(controls.every(node => !node.isConnected));
  });
}

for (const status of ['waiting', 'live'] as const) {
  it(`whole sample actual SDK ${status} permits pre-entry-ACK hand action and retains its key through state before control ACK`, async t => {
    const h = await setup(t), initial = roomState(); initial.status = status;
    if (status === 'live') initial.speakers.push(roomState({ role: 'speaker', onStage: true, participantId: 'speaker-other' }).me);
    const { socket, entry } = await h.enter(initial);
    socket.deliver({ type: 'error', code: 'forbidden', message: '保留的錯誤' });
    const hand = action(h, 'hand'); hand.click();
    assert.equal(h.calls.raiseHand, 1); assert.equal(hand.disabled, true); assert.equal(hand.attributes['aria-busy'], 'true');
    assert.equal(errorBox(h).hidden, true); assert.equal(h.sdk.session, null);
    await h.pump(); const raised = socket.sent.find(message => message.type === 'hand:raise'); assert.ok(raised);
    const next = structuredClone(initial); next.me.handRaised = true; next.hands = [next.me];
    socket.deliver({ type: 'room:state', ...next }); await flushSample();
    const withdraw = action(h, 'hand'); assert.notEqual(withdraw, hand); assert.equal(withdraw.textContent, '收回舉手');
    assert.equal(withdraw.disabled, true); assert.equal(withdraw.attributes['aria-busy'], 'true');
    withdraw.disabled = false; withdraw.onclick!(); assert.equal(h.calls.withdrawHand, 0);
    await h.acknowledge(socket, raised);
    assert.equal(withdraw.disabled, false); assert.equal(withdraw.attributes['aria-busy'], 'false');
    withdraw.click(); assert.equal(h.calls.withdrawHand, 1); assert.equal(withdraw.attributes['aria-busy'], 'true');
    await h.pump(); const withdrawn = socket.sent.find(message => message.type === 'hand:withdraw'); assert.ok(withdrawn);
    await h.acknowledge(socket, withdrawn); await h.acknowledge(socket, entry); assert.ok(h.sdk.session);
    assert.equal(withdraw.disabled, false); assert.equal(withdraw.attributes['aria-busy'], 'false');
    assert.equal(h.sdk.status, status); assert.equal(errorBox(h).hidden, true);
  });
}

interface AcceptedAction { key: string; method: Method; type: string; label?: string; targetId?: string; name?: string; gainDb?: number }
async function accepted(h: App, socket: Socket, spec: AcceptedAction): Promise<void> {
  const control = action(h, spec.key, spec.label), before = h.calls[spec.method], sent = socket.sent.length;
  assert.equal(control.disabled, false);
  socket.deliver({ type: 'error', code: 'forbidden', message: '操作前的錯誤' }); assert.equal(errorBox(h).hidden, false);
  if (spec.gainDb !== undefined) { control.value = String(spec.gainDb); control.onchange!(); } else control.click();
  assert.equal(h.calls[spec.method], before + 1); assert.equal(errorBox(h).hidden, true);
  if (spec.gainDb === undefined) {
    assert.equal(control.disabled, true); assert.equal(control.attributes['aria-busy'], 'true');
    control.disabled = false; control.onclick!(); assert.equal(h.calls[spec.method], before + 1, 'pending keys prevent duplicate admission');
  }
  await h.pump(); const request = socket.sent[sent]; assert.ok(request); assert.equal(request.type, spec.type);
  assert.equal(socket.sent.length, sent + 1);
  if (spec.targetId !== undefined) assert.equal(request.targetId, spec.targetId);
  if (spec.name !== undefined) assert.equal(request.name, spec.name);
  if (spec.gainDb !== undefined) assert.equal(request.gainDb, spec.gainDb);
  await h.acknowledge(socket, request); assert.equal(control.disabled, false); assert.equal(control.attributes['aria-busy'], 'false');
}
it('whole sample actual SDK live speaker mic, stage and name controls preserve normal request and pending behavior', async t => {
  const h = await setup(t), { socket } = await h.enter(roomState({ role: 'speaker', onStage: true }), 'join', true);
  for (const spec of [
    { key: 'mute', method: 'mute', type: 'mic:mute' },
    { key: 'stage', method: 'leaveStage', type: 'stage:leave' },
    { key: 'rename', method: 'setName', type: 'participant:rename', name: '修改名稱' },
  ] satisfies AcceptedAction[]) await accepted(h, socket, spec);
  assert.equal(h.dialogs.length, 1);
});
it('whole sample actual SDK live controller management and gain controls still send their intended requests', async t => {
  const h = await setup(t), state = controllerState();
  const { socket } = await h.enter(state, 'create', true);
  for (const spec of [
    { key: 'stage', method: 'returnToStage', type: 'stage:approve', targetId: state.me.participantId },
    { key: 'room-rename', method: 'setRoomName', type: 'room:rename', name: '修改名稱' },
    { key: 'stage:other', label: '核准上台', method: 'approve', type: 'stage:approve', targetId: 'other' },
    { key: 'kick:other', method: 'kick', type: 'participant:kick', targetId: 'other' },
    { key: 'transfer', method: 'transferControl', type: 'control:transfer', targetId: 'speaker-other' },
    { key: 'close', method: 'closeRoom', type: 'room:close' },
    { key: 'gain:speaker-other', method: 'setGain', type: 'mic:gain', targetId: 'speaker-other', gainDb: 3 },
  ] satisfies AcceptedAction[]) await accepted(h, socket, spec);
  assert.equal(h.dialogs.length, 4); assert.equal(h.sdk.status, 'live');
});

it('whole sample actual SDK reconnect blocks retained buttons and gain, then resumed state restores controls before resume ACK', async t => {
  const h = await setup(t), state = controllerState(), { socket } = await h.enter(state, 'create', true);
  const session = h.sdk.session, originalPeer = Peer.instances[0];
  socket.deliver({ type: 'error', code: 'forbidden', message: '重連時保留的錯誤' });
  socket.close(); await flushSample(); assert.equal(h.sdk.status, 'reconnecting'); assert.equal(h.sdk.session, session);
  const sent = socket.sent.length; failBeforeAdmission(h); await flushSample(); assert.equal(socket.sent.length, sent);
  t.mock.timers.tick(20); const resumed = Socket.instances.at(-1); assert.ok(resumed); assert.notEqual(resumed, socket);
  resumed.hello(); await h.pump(); const rejoin = resumed.sent.find(message => message.type === 'join'); assert.ok(rejoin);
  assert.equal(h.sdk.status, 'reconnecting'); assert.ok(actions(h).every(node => node.disabled));
  resumed.deliver({ type: 'room:state', ...state }); await flushSample();
  assert.equal(h.sdk.status, 'live'); assert.equal(h.sdk.session, session); assert.equal(Peer.instances[0], originalPeer);
  assert.equal(Peer.instances.length, 1); assert.ok(actions(h).every(node => !node.disabled));
  await accepted(h, resumed, { key: 'room-rename', method: 'setRoomName', type: 'room:rename', name: '修改名稱' });
  await accepted(h, resumed, { key: 'gain:speaker-other', method: 'setGain', type: 'mic:gain', targetId: 'speaker-other', gainDb: 2 });
  await h.acknowledge(resumed, rejoin); assert.equal(h.sdk.status, 'live'); assert.equal(h.dialogs.length, 1);
});
