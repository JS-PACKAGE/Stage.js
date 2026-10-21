import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { StageClient } from '../packages/client/src/index.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { harness, testConfig } from './helpers.ts';
import { StagePeer } from './fixtures/embedSdkApp.ts';
import { sampleApp, roomState, flushSample } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import type { ClientMessage, ServerMessage, RoomStatePayload, ParticipantView } from '../shared/protocol.ts';

const heading = (app: SampleNode, prefix: string): SampleNode => {
  const found = app.descendants().filter(n => n.tagName === 'h2' && n.textContent.startsWith(prefix));
  assert.equal(found.length, 1); return found[0]!;
};
function person(id: string, role: ParticipantView['role'] = 'audience', onStage = role !== 'audience'): ParticipantView {
  return { ...roomState().me, participantId: id, role, onStage, name: `Private ${id}` };
}
function snapshot(options: { audience?: number; stage?: number; controllerOnStage?: boolean; viewer?: ParticipantView['role']; maxAudience?: number; maxSpeakers?: number; roomId?: string; participantId?: string } = {}): RoomStatePayload {
  const controllerOnStage = options.controllerOnStage ?? true, viewer = options.viewer ?? 'audience';
  return { roomId: options.roomId ?? 'room', name: '測試舞台', controllerId: 'controller',
    speakers: [...(controllerOnStage ? [person('controller', 'controller')] : []),
      ...Array.from({ length: options.stage ?? 1 }, (_, i) => person(`speaker-${i}`, 'speaker'))],
    hands: [], audienceCount: options.audience ?? 2, limits: { maxAudience: options.maxAudience ?? 300, maxSpeakers: options.maxSpeakers ?? 8 },
    status: 'live', codeRequired: false, recording: false, recordingAvailable: false,
    me: person(options.participantId ?? (viewer === 'controller' ? 'controller' : viewer === 'speaker' ? 'speaker-0' : 'listener'), viewer,
      viewer === 'controller' ? controllerOnStage : viewer === 'speaker') };
}
function summary(room = 3, stage = 1, audience = 2, onStage = true, maxAudience = 300, maxSpeakers = 8, freshness = '最近快照'): string {
  return `房間席位（${freshness}）：主控以外 ${room} / ${maxAudience} 人，其中台上 ${stage} / ${maxSpeakers} 人、觀眾 ${audience} 人；主控另計 1 人（${onStage ? '台上' : '台下'}）。含斷線保留席位。`;
}
function shown(node: SampleNode, expected = summary()): void { assert.equal(node.hidden, false); assert.equal(node.textContent, expected); }
function empty(node: SampleNode): void { assert.equal(node.hidden, true); assert.equal(node.textContent, ''); }
async function synthetic(t: TestContext) {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample(); return { ...h, node: h.id('room-occupancy') };
}
function instrument(node: SampleNode, hook?: (property: 'textContent' | 'hidden') => void, before = false) {
  const writes = { textContent: 0, hidden: 0 };
  for (const property of ['textContent', 'hidden'] as const) {
    let value = node[property];
    Object.defineProperty(node, property, { configurable: true, get: () => value, set(next: typeof value) {
      assert.notEqual(next, value, `equal ${property} must not be written`);
      writes[property]++; if (before) hook?.(property); value = next; if (!before) hook?.(property);
    } });
  }
  return writes;
}

async function actual(t: TestContext, viewerRole: 'audience' | 'speaker' | 'controller') {
  const config = testConfig(c => {
    c.rooms.qualityIntervalMs = 0; c.rooms.presenceBroadcastMs = 0; c.rooms.participantGraceMs = 5000;
    c.limits.maxAudiencePerRoom = 3; c.limits.maxSpeakersPerRoom = 1;
  });
  const server = harness(config); let work = Promise.resolve();
  class Socket {
    static OPEN = 1; static instances: Socket[] = [];
    readonly id = `occupancy-${Socket.instances.length}`; readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
    readonly sent: ClientMessage[] = [];
    readonly session = { id: this.id, send: (message: ServerMessage) => this.deliver(message), close: () => this.close() };
    constructor() { Socket.instances.push(this); queueMicrotask(() => server.hub.attach(this.session)); }
    deliver(message: ServerMessage) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) }); }
    send(data: string) { const message = parseClientMessage(data, config.limits); this.sent.push(message); work = work.then(() => server.hub.handle(this.session, message)); }
    close(code?: number) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); work = work.then(() => server.hub.detach(this.session, code === 1000)); }
  }
  StagePeer.instances = []; let captures = 0;
  const globals = { window: new EventTarget(), WebSocket: Socket, RTCPeerConnection: StagePeer,
    navigator: { mediaDevices: { async enumerateDevices() { return []; }, async getUserMedia() { captures++; throw new DOMException('Controlled media denial', 'NotAllowedError'); } } } };
  const saved = new Map(Object.keys(globals).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, value: v });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 0; t.mock.method(performance, 'now', () => now);
  const clients: StageClient[] = [], sockets = new Map<StageClient, Socket>();
  function makeClient() { const client = new StageClient({ url: 'wss://sample.test/ws', audioElement: { srcObject: null, volume: 1, muted: false, async play() {}, pause() {} } as unknown as HTMLAudioElement }); clients.push(client); return client; }
  async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); await work; for (let i = 0; i < 100; i++) await Promise.resolve(); }
  async function request<T>(promise: Promise<T>): Promise<T> {
    let done = false; promise.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 400 && !done; i++) { now += 25; t.mock.timers.tick(25); await flush(); }
    assert.ok(done, 'request settles'); return promise;
  }
  const host = makeClient(); const created = await request(host.createRoom({ name: 'Host', roomName: 'Occupancy probe', codeRequired: false })); sockets.set(host, Socket.instances.at(-1)!);
  const viewer = viewerRole === 'controller' ? host : makeClient(), h = sampleApp({ sdk: viewer, confirm: () => true });
  if (viewer !== host) { await request(viewer.join({ roomId: created.roomId, name: 'Viewer' })); sockets.set(viewer, Socket.instances.at(-1)!); await flush(); }
  async function join(name: string) { const guest = makeClient(); await request(guest.join({ roomId: created.roomId, name })); sockets.set(guest, Socket.instances.at(-1)!); await flush(); return guest; }
  const other = await join('Other'), tail = await join('Private audience');
  if (viewer === host) await join('Extra audience');
  const speaker = viewerRole === 'speaker' ? viewer : other;
  await request(speaker.raiseHand()); await request(host.approve(speaker.me!.participantId)); await flush();
  t.after(async () => {
    try { for (const client of [...clients].reverse()) await client.disconnect(); await h.cleanup(); await flush(); await server.hub.shutdown(); await server.transport.close(); assert.equal(h.clock.jobs.size, 0); }
    finally { for (const [k, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else Reflect.deleteProperty(globalThis, k); } }
  });
  return { h, host, viewer, speaker, tail, other, server, sockets, request, flush, join, captures: () => captures,
    async resume() { for (let i = 0; i < 100; i++) { now += 25; t.mock.timers.tick(25); await flush(); } },
  };
}

for (const role of ['audience', 'speaker', 'controller'] as const) {
  it(`actual ${role} sees the full non-controller room cap even though audience count is lower`, async t => {
    const x = await actual(t, role), node = x.h.id('room-occupancy');
    shown(node, summary(3, 1, 2, true, 3, 1));
    assert.equal(heading(x.h.app, '觀眾 ·').textContent, '觀眾 · 2 人');
    assert.equal(heading(x.h.app, '舞台 ·').textContent, '舞台 · 發言者 1/1');
    if (role !== 'controller') {
      assert.equal(x.viewer.state!.audience, undefined); assert.doesNotMatch(x.h.app.textContent, /Private audience/);
    }
    await assert.rejects(x.join('Overflow'), (error: { code?: string }) => error.code === 'room_full');
    await x.request(x.host.leaveStage()); shown(node, summary(3, 1, 2, false, 3, 1));
    await assert.rejects(x.join('Still full'), (error: { code?: string }) => error.code === 'room_full');
    assert.ok(x.captures() > 0, 'controlled microphone denial does not erase the stage seat');
    await x.request(x.speaker.leaveStage()); shown(node, summary(3, 0, 3, false, 3, 1));
  });
}
it('actual audience grace expiry releases capacity without reading hidden membership', async t => {
  const x = await actual(t, 'speaker'), node = x.h.id('room-occupancy'), tailId = x.tail.me!.participantId;
  x.sockets.get(x.tail)!.close(); await x.flush(); shown(node, summary(3, 1, 2, true, 3, 1));
  assert.equal(x.host.state!.audience!.find(p => p.participantId === tailId)!.connected, false);
  assert.equal(x.viewer.state!.audience, undefined);
  const expiry = x.server.timers.find(timer => !timer.cleared && timer.ms === 5000); assert.ok(expiry);
  expiry.cleared = true; expiry.fn(); await x.flush(); shown(node, summary(2, 1, 1, true, 3, 1));
  await x.tail.disconnect(); const replacement = await x.join('Replacement');
  assert.notEqual(replacement.me!.participantId, tailId); shown(node, summary(3, 1, 2, true, 3, 1));
});
it('actual speaker grace and same-seat resume preserve occupancy', async t => {
  const x = await actual(t, 'audience'), node = x.h.id('room-occupancy'), id = x.speaker.me!.participantId;
  x.sockets.get(x.speaker)!.close(); await x.flush();
  assert.equal(x.viewer.state!.speakers.find(p => p.participantId === id)!.connected, false);
  shown(node, summary(3, 1, 2, true, 3, 1));
  await x.resume(); assert.equal(x.speaker.me!.participantId, id); shown(node, summary(3, 1, 2, true, 3, 1));
});
it('actual viewer reconnect retains historical counts until authoritative resume; disconnect clears', async t => {
  const x = await actual(t, 'audience'), node = x.h.id('room-occupancy'), oldHeading = heading(x.h.app, '觀眾 ·');
  x.sockets.get(x.viewer)!.close(); await x.flush();
  shown(node, summary(3, 1, 2, true, 3, 1, '重新連線中，上次快照'));
  assert.equal(heading(x.h.app, '觀眾 ·'), oldHeading);
  await x.resume(); shown(node, summary(3, 1, 2, true, 3, 1));
  await x.viewer.disconnect(); await x.flush(); empty(node);
});
it('actual controller transfer reclassifies seats from the next authoritative state', async t => {
  const x = await actual(t, 'audience'), node = x.h.id('room-occupancy');
  await assert.rejects(x.request(x.host.transferControl(x.tail.me!.participantId)), (error: { code?: string }) => error.code === 'stage_full');
  shown(node, summary(3, 1, 2, true, 3, 1));
  await x.request(x.host.leaveStage()); await x.request(x.host.transferControl(x.tail.me!.participantId));
  assert.equal(x.viewer.state!.controllerId, x.tail.me!.participantId);
  shown(node, summary(3, 1, 2, false, 3, 1));
});

it('one ordinary persistent empty paragraph sits immediately before main, outside live notices', async t => {
  const h = await synthetic(t); empty(h.node); assert.equal(h.node.tagName, 'p');
  assert.deepEqual(h.node.attributes, {}); assert.equal(h.node.children.length, 0);
  const main = h.find(n => n.tagName === 'main');
  assert.equal(h.app.children[h.app.children.indexOf(main) - 1], h.node);
  assert.equal(h.node.parentNode, h.app); assert.equal(h.app.descendants().filter(n => n.id === 'room-occupancy').length, 1);
  h.sdk.snapshot(snapshot()); shown(h.node); assert.equal(h.id('room-occupancy'), h.node);
  assert.doesNotMatch(h.node.textContent, /Private|controller|listener|speaker-/);
});
for (const viewer of ['audience', 'speaker', 'controller'] as const)
  for (const status of ['waiting', 'live'] as const)
    for (const controllerOnStage of [false, true])
      for (const caps of [[300, 8], [3, 1]] as const) {
        it(`public ${viewer}/${status}/${controllerOnStage}/${caps} uses bounded seats rather than connection or hand counts`, async t => {
          const h = await synthetic(t), state = snapshot({ viewer, controllerOnStage, maxAudience: caps[0], maxSpeakers: caps[1] });
          state.status = status; state.hands = [person('hand1'), person('hand2')];
          for (const p of [...state.speakers, ...state.hands]) { p.connected = false; p.muted = p.forceMuted = true; }
          h.sdk.snapshot(state); shown(h.node, summary(3, 1, 2, controllerOnStage, ...caps));
        });
      }
for (const controllerOnStage of [false, true]) it(`zero guest controller-only room with controller onstage=${controllerOnStage}`, async t => {
  const h = await synthetic(t); h.sdk.snapshot(snapshot({ viewer: 'controller', audience: 0, stage: 0, controllerOnStage }));
  shown(h.node, summary(0, 0, 0, controllerOnStage));
});
it('default 300/8 occupancy counts controller separately and leaves count-only room references intact', async t => {
  const h = await synthetic(t), state = snapshot({ audience: 292, stage: 8, viewer: 'speaker' });
  h.sdk.snapshot(state); shown(h.node, summary(300, 8, 292));
  const stage = heading(h.app, '舞台 ·').parentNode!, rows = stage.descendants(), mute = h.find(n => n.dataset.roomAction === 'mute');
  const audienceHeading = heading(h.app, '觀眾 ·');
  h.sdk.snapshot({ ...state, audienceCount: 291 }); shown(h.node, summary(299, 8, 291));
  assert.equal(heading(h.app, '觀眾 ·'), audienceHeading); assert.equal(audienceHeading.textContent, '觀眾 · 291 人');
  assert.equal(heading(h.app, '舞台 ·').parentNode, stage); assert.deepEqual(stage.descendants(), rows);
  assert.equal(h.find(n => n.dataset.roomAction === 'mute'), mute);
});
it('status and rejected/replayed state identities cannot invent or freshen reports', async t => {
  const h = await synthetic(t), state = snapshot(); h.sdk.state = state; h.sdk.setStatus('live'); empty(h.node);
  const rejected = snapshot({ audience: 9 }); h.sdk.emit('state', rejected); empty(h.node);
  h.sdk.snapshot(state); shown(h.node); h.sdk.setStatus('reconnecting');
  shown(h.node, summary(3, 1, 2, true, 300, 8, '重新連線中，上次快照'));
  state.audienceCount = 20; h.sdk.setStatus('live'); shown(h.node, summary(3, 1, 2, true, 300, 8, '上次快照'));
  h.sdk.snapshot(state); shown(h.node, summary(3, 1, 2, true, 300, 8, '上次快照'));
  h.sdk.snapshot(rejected); shown(h.node, summary(3, 1, 2, true, 300, 8, '上次快照'));
  h.sdk.snapshot(snapshot({ audience: 4 })); shown(h.node, summary(5, 1, 4));
  h.sdk.snapshot(state); shown(h.node, summary(5, 1, 4));
});
it('copying and painting do not inspect private payloads or mutable speaker objects again', async t => {
  const h = await synthetic(t), state = snapshot();
  for (const key of ['audience', 'code', 'resumeToken']) Object.defineProperty(state, key, { get() {
    assert.doesNotMatch(new Error().stack!, /projectOccupancy|renderOccupancy/, `${key} is unrelated to public seat projection`); return undefined;
  } });
  h.sdk.snapshot(state); shown(h.node);
  state.audienceCount = 99; state.speakers.length = 0; state.limits.maxAudience = 999;
  h.sdk.setStatus('reconnecting'); shown(h.node, summary(3, 1, 2, true, 300, 8, '重新連線中，上次快照'));
  assert.deepEqual(h.node.attributes, {});
});
it('identical and unrelated events add zero paragraph writes, timers, or commands', async t => {
  const h = await synthetic(t), state = snapshot(); h.sdk.snapshot(state);
  const writes = instrument(h.node), jobs = [...h.clock.jobs.values()].map(j => [j.id, j.kind, j.delay]);
  const before = [h.sdk.polls.length, h.sdk.joins.length, h.sdk.raises.length, h.sdk.previews.length, h.sdk.audioRetries.length];
  for (let i = 0; i < 20; i++) h.sdk.snapshot(structuredClone(state));
  h.sdk.emit('speaking', { participantIds: ['speaker-0'] }); h.sdk.emit('quality', { participants: [] });
  h.sdk.emit('hand', { participantId: 'other', raised: true }); h.sdk.emit('role', { participantId: 'other', role: 'speaker' });
  shown(h.node); assert.deepEqual(writes, { textContent: 0, hidden: 0 });
  assert.deepEqual([...h.clock.jobs.values()].map(j => [j.id, j.kind, j.delay]), jobs);
  assert.deepEqual([h.sdk.polls.length, h.sdk.joins.length, h.sdk.raises.length, h.sdk.previews.length, h.sdk.audioRetries.length], before);
});
const invalid: [string, (state: RoomStatePayload) => void][] = [
  ...[-1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined].map(value => [`audience ${String(value)}`, (s: RoomStatePayload) => { Reflect.set(s, 'audienceCount', value); }] as [string, (s: RoomStatePayload) => void]),
  ...['maxAudience', 'maxSpeakers'].flatMap(key => [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '3', undefined].map(value => [`${key} ${String(value)}`, (s: RoomStatePayload) => { Reflect.set(s.limits, key, value); }] as [string, (s: RoomStatePayload) => void])),
  ['room cap exceeded', s => { s.limits.maxAudience = 2; }], ['stage cap exceeded', s => { s.speakers.push(person('speaker-1', 'speaker')); s.limits.maxSpeakers = 1; }],
  ['duplicate ID', s => { s.speakers.push({ ...s.speakers[1]! }); }], ['empty ID', s => { s.speakers[0]!.participantId = ''; }],
  ['whitespace ID', s => { s.speakers[0]!.participantId = ' '; }], ['audience onstage', s => { s.speakers[0]!.role = 'audience'; }],
  ['offstage speaker', s => { s.speakers[1]!.onStage = false; }], ['wrong controller ID', s => { s.controllerId = 'other'; }],
  ['second controller', s => { s.speakers[1]!.role = 'controller'; }], ['controller marked speaker', s => { s.speakers[0]!.role = 'speaker'; }],
  ...['roomId', 'controllerId'].flatMap(key => ['', ' ', undefined, 7].map(value => [`${key} ${String(value)}`, (s: RoomStatePayload) => { Reflect.set(s, key, value); }] as [string, (s: RoomStatePayload) => void])),
  ...['', ' ', undefined, 7].map(value => [`participantId ${String(value)}`, (s: RoomStatePayload) => { Reflect.set(s.me, 'participantId', value); }] as [string, (s: RoomStatePayload) => void]),
];
for (const [name, mutate] of invalid) it(`invalid ${name} clears the paragraph without clamping or replay repair`, async t => {
  const h = await synthetic(t); h.sdk.snapshot(snapshot()); const bad = snapshot(); mutate(bad);
  // The old room renderer assumes a required ID; local validation still clears before its malformed-input exception returns.
  if (name === 'roomId undefined') assert.throws(() => h.sdk.snapshot(bad), /reading 'code'/);
  else h.sdk.snapshot(bad);
  empty(h.node);
  assert.equal(h.button('離開房間').disabled, false);
  Object.assign(bad, snapshot()); h.sdk.snapshot(bad); empty(h.node);
  h.sdk.snapshot(snapshot()); shown(h.node);
});
for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const)
  it(`${terminal} hides and empties copied text, replay cannot revive it and a new state can establish a seat`, async t => {
    const h = await synthetic(t), old = snapshot(); h.sdk.snapshot(old);
    if (terminal === 'leave') h.button('離開房間').click();
    else if (terminal === 'disconnected') await h.sdk.disconnect();
    else await h.sdk.terminal(terminal);
    await flushSample(); empty(h.node);
    h.sdk.snapshot(old); empty(h.node);
    h.sdk.snapshot(snapshot()); shown(h.node);
  });
for (const before of [false, true]) for (const property of ['textContent', 'hidden'] as const)
  for (const action of ['state', 'reconnect', 'disconnect', 'owner', 'silent-status'] as const)
    it(`${before ? 'before' : 'after'} ${property} reentry into ${action} drains to the current report`, async t => {
      const h = await synthetic(t); let entered = false;
      instrument(h.node, key => {
        if (entered || key !== property) return; entered = true;
        if (action === 'state') h.sdk.snapshot(snapshot({ audience: 4 }));
        else if (action === 'reconnect') h.sdk.setStatus('reconnecting');
        else if (action === 'disconnect') void h.sdk.disconnect();
        else if (action === 'owner') h.sdk.state = snapshot({ roomId: 'replacement' });
        else h.sdk.status = 'disconnected';
      }, before);
      h.sdk.snapshot(snapshot()); assert.equal(entered, true);
      if (action === 'state') shown(h.node, summary(5, 1, 4));
      else if (action === 'reconnect') shown(h.node, summary(3, 1, 2, true, 300, 8, '重新連線中，上次快照'));
      else empty(h.node);
    });
it('a reentrant public-count getter cannot overwrite the newer accepted report', async t => {
  const h = await synthetic(t), outer = snapshot(), newer = snapshot({ audience: 4 }); let entered = false;
  Object.defineProperty(outer, 'audienceCount', { enumerable: true, get() {
    if (!entered) { entered = true; h.sdk.snapshot(newer); } return 2;
  } });
  h.sdk.snapshot(outer); assert.equal(entered, true); shown(h.node, summary(5, 1, 4));
});
it('new-entry failure and cancellation stay empty, while a pre-ACK current state is sufficient', async t => {
  const h = await synthetic(t), forms = h.app.descendants().filter(n => n.tagName === 'form');
  forms[1]!.submit(); empty(h.node); h.sdk.joins[0]!.work.reject(new Error('failed')); await flushSample(); empty(h.node);
  forms[1]!.submit(); empty(h.node); const pending = h.sdk.joins[1]!.work;
  h.sdk.snapshot(snapshot()); shown(h.node); assert.equal(pending.status, 'pending');
  pending.resolve(undefined); await flushSample(); shown(h.node);
  h.button('離開房間').click(); await flushSample(); empty(h.node);
  const join = h.app.descendants().filter(n => n.tagName === 'form')[1]!; join.submit(); h.button('取消連線').click();
  h.sdk.joins[2]!.work.reject(new Error('cancelled')); await flushSample(); empty(h.node);
});

it('projection getter reconnect retains the previously accepted report rather than an uncommitted replacement', async t => {
  const h = await synthetic(t); h.sdk.snapshot(snapshot()); const next = snapshot({ audience: 4 }); let entered = false;
  Object.defineProperty(next, 'audienceCount', { enumerable: true, get() {
    if (!entered) { entered = true; h.sdk.setStatus('reconnecting'); } return 4;
  } });
  h.sdk.snapshot(next); shown(h.node, summary(3, 1, 2, true, 300, 8, '重新連線中，上次快照'));
  h.sdk.setStatus('live'); h.sdk.snapshot(next); shown(h.node, summary(3, 1, 2, true, 300, 8, '上次快照'));
  h.sdk.snapshot(snapshot({ audience: 5 })); shown(h.node, summary(6, 1, 5));
});
for (const action of ['close', 'transfer'] as const)
  for (const boundary of ['room', 'seat', 'same-owner'] as const)
    it(`predecessor status fences ${boundary} ownership for retained ${action} before summary callbacks`, async t => {
      const h = sampleApp({ confirm: () => true }); t.after(() => h.cleanup()); await flushSample();
      const calls: string[] = [];
      Object.assign(h.sdk, { async closeRoom() { calls.push('close'); }, async transferControl() { calls.push('transfer'); } });
      h.sdk.snapshot(snapshot({ viewer: 'controller', audience: 1 }));
      const old = h.find(n => n.dataset.roomAction === action
        && (action === 'close' || n.parentNode?.parentNode?.dataset.participantId === 'speaker-0'));
      const meter = h.button('測試麥克風'), node = h.id('room-occupancy');
      let disabled = meter.disabled, entered = false, invoked = false;
      Object.defineProperty(meter, 'disabled', { configurable: true, get: () => disabled, set(next: boolean) {
        disabled = next;
        if (!entered) { entered = true; h.sdk.emit('status', h.sdk.status); }
      } });
      instrument(node, property => {
        if (invoked || property !== 'textContent') return; invoked = true; old.disabled = false; old.onclick!();
      });
      h.sdk.snapshot(snapshot({ viewer: 'controller', audience: 4,
        roomId: boundary === 'room' ? 'replacement' : 'room', participantId: boundary === 'seat' ? 'replacement' : 'controller' }));
      await flushSample(); assert.equal(entered, true); assert.equal(invoked, true);
      assert.deepEqual(calls, boundary === 'same-owner' ? [action] : []);
      shown(node, summary(5, 1, 4));
    });
