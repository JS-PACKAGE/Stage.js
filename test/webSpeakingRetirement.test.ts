import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { StageClient, decodeName } from '../packages/client/src/index.ts';
import { FakeSession, harness, SENDRECV_OFFER, testConfig, sine } from './helpers.ts';
import { sampleApp, flushSample, roomState } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import type { ClientMessage, ServerMessage, RoomStatePayload } from '../shared/protocol.ts';

// The complete production sample, SDK, validator, Hub, RoomMixer and MockMediaTransport
// execute unchanged. This controls only DOM, clocks, WebSocket delivery and native RTC/capture.
// It does not open an actual socket, room, browser or microphone.
const source = readFileSync(process.env.STAGE_SAMPLE_SOURCE ?? new URL('../web/src/main.ts', import.meta.url), 'utf8');
class Socket {
  static OPEN = 1; static instances: Socket[] = [];
  readyState = 1; sent: ClientMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send(data: string) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(data)); }
  deliver(message: ServerMessage) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}
class Peer {
  static instances: Peer[] = [];
  connectionState = 'connected'; signalingState = 'stable'; localDescription = null;
  closes = 0; rejectOffer?: (reason: Error) => void;
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return { direction: 'recvonly', sender: { track: null, async replaceTrack() {} } }; }
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  getStats() { return Promise.resolve(new Map()); }
  close() { this.closes++; this.connectionState = 'closed'; this.rejectOffer?.(new Error('controlled cleanup')); }
}
let sequence = 0;
async function setup(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.presenceBroadcastMs = 0; c.rooms.participantGraceMs = 60000; c.limits.controlPerSecond = 2000; });
  const wire = harness(config), host = await wire.create('Publishing host', { codeRequired: false });
  const speaker = await wire.join(host.roomId, undefined, 'Publishing speaker');
  const command = async (session: FakeSession, data: Record<string, unknown>) => {
    const requestId = data.requestId ?? `speaking-discovery-${sequence++}`;
    await wire.hub.handle(session, parseClientMessage(JSON.stringify({ ...data, requestId }), config.limits));
    const result = session.inbox.find(m => (m.type === 'ok' || m.type === 'error') && m.requestId === requestId);
    assert.equal(result?.type, 'ok', JSON.stringify(result));
  };
  await command(speaker.s, { type: 'hand:raise' });
  await command(host.s, { type: 'stage:approve', targetId: speaker.id });
  await command(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
  await command(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals = { window: new EventTarget(), WebSocket: Socket, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { async enumerateDevices() { return []; }, async getUserMedia(): Promise<never> { throw new DOMException('Controlled refusal', 'NotAllowedError'); } } } };
  for (const [key, value] of Object.entries(globals)) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value }); }
  Socket.instances = []; Peer.instances = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0; t.mock.method(performance, 'now', () => now);
  const sdk = new StageClient({ url: 'wss://sample.test/ws', enableMicMeter: false, reconnect: { initialDelayMs: 25, maxDelayMs: 25 },
    audioElement: { srcObject: null, volume: 1, muted: false, pause() {}, async play() {} } as unknown as HTMLAudioElement });
  const h = sampleApp({ sdk, source, decodeName });
  const sessions = new Map<Socket, FakeSession>(), cursors = new Map<Socket, number>();
  const tick = async (ms = 1) => { now += ms; t.mock.timers.tick(ms); h.clock.advance(ms); await flushSample(); };
  const until = async (predicate: () => boolean) => { for (let n = 0; n < 100 && !predicate(); n++) await tick(); assert.ok(predicate(), 'SDK progress'); };
  function drain(socket: Socket, beforeType?: ServerMessage['type']) {
    const session = sessions.get(socket)!; const delivered: ServerMessage[] = [];
    let cursor = cursors.get(socket)!;
    while (cursor < session.inbox.length) {
      const message = session.inbox[cursor]!; if (message.type === beforeType) break;
      cursors.set(socket, ++cursor); delivered.push(message); socket.deliver(message);
    }
    return delivered;
  }
  const attach = (socket: Socket) => { const session = new FakeSession(); sessions.set(socket, session); cursors.set(socket, 0); wire.hub.attach(session); drain(socket); return session; };
  async function acceptJoin(socket: Socket, beforeType?: ServerMessage['type']) {
    await until(() => socket.sent.some(m => m.type === 'join'));
    const request = socket.sent.find(m => m.type === 'join')!;
    await command(sessions.get(socket)!, request as unknown as Record<string, unknown>);
    const frames = drain(socket, beforeType); await flushSample(); return frames;
  }
  t.after(async () => {
    try { await h.cleanup(); await wire.hub.shutdown(); await wire.transport.close(); await flushSample(); }
    finally { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
  });
  const joining = sdk.join({ roomId: host.roomId, name: 'Audience reader' }); await flushSample();
  const socket = Socket.instances.at(-1)!, session = attach(socket); await acceptJoin(socket); await joining;
  const rows = () => h.app.descendants().filter(node => node.classList.contains('person') && node.dataset.participantId !== undefined);
  const row = (id: string) => { const result = rows().find(node => node.dataset.participantId === id); assert.ok(result, `row ${id}`); return result; };
  const active = () => rows().filter(node => node.classList.contains('speaking')).map(node => node.dataset.participantId!);
  const mixer = wire.mixers.get(host.roomId)!;
  const speak = (ids = [speaker.id]) => {
    for (const id of ids) assert.equal(wire.transport.emitUplink(host.roomId, id, sine(960, 0.2)), true);
    mixer.tick(); drain(socket);
  };
  const silence = () => { for (let n = 0; n < 4; n++) mixer.tick(); drain(socket); };
  const drop = async () => { socket.close(); await wire.hub.detach(session); await flushSample(); assert.equal(sdk.status, 'reconnecting'); };
  const resume = async (beforeType?: ServerMessage['type']) => {
    await tick(25); const next = Socket.instances.at(-1)!; assert.notEqual(next, socket); attach(next);
    const frames = await acceptJoin(next, beforeType); return { next, frames };
  };
  return { ...h, wire, config, sdk, host, speaker, socket, session, sessions, row, rows, active, speak, silence, mixer, command, drain, tick, drop, resume, attach, acceptJoin };
}

it('live speech and natural silence update classes through actual mixer reports without rebuilding rows', async t => {
  const h = await setup(t), before = h.rows(); h.speak([h.host.id, h.speaker.id]);
  assert.deepEqual(new Set(h.active()), new Set([h.host.id, h.speaker.id]));
  h.silence(); assert.deepEqual(h.active(), []); assert.deepEqual(h.rows(), before);
});

it('disconnected publisher with continuing media stays active within grace for a connected reader', async t => {
  const h = await setup(t); h.speak(); await h.wire.hub.detach(h.speaker.s); h.drain(h.socket);
  assert.equal(h.sdk.state!.speakers.find(p => p.participantId === h.speaker.id)!.connected, false);
  assert.equal(h.row(h.speaker.id).classList.contains('speaking'), true);
  h.silence(); assert.equal(h.row(h.speaker.id).classList.contains('speaking'), false);
  h.speak(); assert.equal(h.row(h.speaker.id).classList.contains('speaking'), true);
});

it('reader reconnect retires the mounted indication while actual server speech ends and the media peer survives', async t => {
  const h = await setup(t); h.speak(); const row = h.row(h.speaker.id), peer = Peer.instances[0]!;
  await h.drop(); h.silence();
  assert.deepEqual(h.host.s.last('speaking')!.participantIds, [], 'server has reported silence');
  for (let n = 0; n < 30; n++) await h.tick(1000);
  assert.equal(h.sdk.status, 'reconnecting'); assert.equal(peer.closes, 0, 'retained media is intentional');
  assert.deepEqual([...h.sdk.speaking], [h.speaker.id], 'SDK getter is last received report');
  assert.equal(h.row(h.speaker.id), row, 'visible row is still installed');
  assert.equal(row.classList.contains('speaking'), false, 'active speaking indication must retire when the reader loses report delivery');
});

it('normal resumed snapshot stays retired until the speaking baseline', async t => {
  const h = await setup(t); h.speak(); const id = h.sdk.me!.participantId;
  await h.drop(); h.silence(); const { next, frames } = await h.resume('speaking');
  assert.equal(h.sdk.me!.participantId, id);
  assert.ok(frames.some(m => m.type === 'room:state'));
  assert.equal(h.row(h.speaker.id).classList.contains('speaking'), false, 'resume snapshot alone must not restore the retained report');
  const tail = h.drain(next); await flushSample();
  assert.equal(tail[0]!.type, 'speaking'); assert.deepEqual(h.active(), []);
});

for (const mode of ['remove', 'leave', 'kick', 'mute'] as const) {
  it(`actual ${mode} retires active publisher before fresh state without needing sample-specific lifecycle logic`, async t => {
    const h = await setup(t); h.speak([h.host.id, h.speaker.id]);
    const data = mode === 'remove' ? { type: 'stage:remove', targetId: h.speaker.id }
      : mode === 'leave' ? { type: 'stage:leave' }
      : mode === 'kick' ? { type: 'participant:kick', targetId: h.speaker.id }
      : { type: 'mic:force-mute', targetId: h.speaker.id };
    await h.command(mode === 'leave' ? h.speaker.s : h.host.s, data);
    const prefix = h.drain(h.socket, 'room:state');
    assert.ok(prefix.some(m => m.type === 'speaking'));
    assert.deepEqual(h.active(), [h.host.id], 'unrelated active publisher is preserved');
    assert.equal(h.sdk.state!.speakers.some(p => p.participantId === h.speaker.id), true, 'old roster remains until state');
    await h.tick(250); assert.deepEqual(h.active(), [h.host.id]);
    const tail = h.drain(h.socket); assert.ok(tail.some(m => m.type === 'room:state'));
    assert.deepEqual(h.active(), [h.host.id]);
  });
}

for (const mode of ['disconnect', 'kick', 'close'] as const) {
  it(`${mode} removes active rows and later entry cannot reuse them`, async t => {
    const h = await setup(t); h.speak(); const oldRows = h.rows();
    if (mode === 'disconnect') { await h.sdk.disconnect(); await h.wire.hub.detach(h.session, true); }
    else { await h.command(h.host.s, mode === 'kick' ? { type: 'participant:kick', targetId: h.sdk.me!.participantId } : { type: 'room:close' }); h.drain(h.socket); }
    await flushSample(); assert.equal(h.sdk.state, null); assert.deepEqual([...h.sdk.speaking], []);
    assert.deepEqual(h.rows(), []); assert.ok(oldRows.every(row => !row.isConnected));
    const oldClasses = oldRows.map(row => row.className);
    const newRoom = await h.wire.create('New room', { codeRequired: false });
    const join = h.sdk.join({ roomId: newRoom.roomId, name: 'New entry' }); await flushSample();
    const next = Socket.instances.at(-1)!; h.attach(next); await h.acceptJoin(next); await join;
    assert.deepEqual(h.active(), []); assert.deepEqual(oldRows.map(row => row.className), oldClasses);
    assert.ok(h.rows().every(row => !oldRows.includes(row)));
  });
}

it('ordinary room rename preserves an unchanged last report and keeps active indication', async t => {
  const h = await setup(t); h.speak(); await h.command(h.host.s, { type: 'room:rename', name: 'Renamed' });
  h.drain(h.socket); assert.equal(h.row(h.speaker.id).classList.contains('speaking'), true);
});

it('fresh post-resume speaking report displays activity again while the same peer and seat survive', async t => {
  const h = await setup(t); h.speak(); const ownId = h.sdk.me!.participantId, peer = Peer.instances[0]!;
  await h.drop(); const { next, frames } = await h.resume('speaking');
  assert.equal(h.sdk.me!.participantId, ownId); assert.equal(Peer.instances[0], peer); assert.equal(peer.closes, 0);
  assert.ok(frames.some(m => m.type === 'room:state'));
  const tail = h.drain(next); const fresh = tail.find(m => m.type === 'speaking');
  assert.ok(fresh && fresh.type === 'speaking'); assert.deepEqual(fresh.participantIds, [h.speaker.id]);
  assert.equal(h.row(h.speaker.id).classList.contains('speaking'), true);
});

it('resumed authoritative snapshot keeps replacement rows retired before any fresh report', async t => {
  const h = await setup(t); h.speak(); const oldRow = h.row(h.speaker.id);
  let receipts = 0; h.sdk.on('speaking', () => receipts++);
  await h.drop(); h.silence();
  await h.command(h.host.s, { type: 'room:rename', name: 'Changed while offline' });
  const { next } = await h.resume('speaking');
  const replacement = h.row(h.speaker.id);
  assert.equal(h.sdk.status, 'live'); assert.equal(h.sdk.state!.name, 'Changed while offline');
  assert.notEqual(replacement, oldRow, 'real changed snapshot forces ordinary full sample rendering');
  assert.equal(oldRow.isConnected, false); assert.equal(replacement.isConnected, true);
  assert.equal(receipts, 0, 'no new SDK speaking receipt since reconnect');
  assert.deepEqual([...h.sdk.speaking], [h.speaker.id], 'snapshot did not refresh the public getter');
  const beforeFreshReport = replacement.classList.contains('speaking');
  h.drain(next); await flushSample(); assert.equal(receipts, 1); assert.equal(replacement.classList.contains('speaking'), false, 'new empty receipt repairs the indication');
  assert.equal(beforeFreshReport, false, 'resumed snapshot must not reactivate retired activity from a retained getter');
});

// Controlled SDK callbacks isolate lifecycle and reentrant DOM boundaries; the cases above
// independently exercise the real SDK and server reports. Neither fixture models a native browser.
function syntheticState(): RoomStatePayload {
  const state = roomState({ participantId: 'host', role: 'controller', onStage: true });
  const a = { ...state.me, participantId: 'a', role: 'speaker' as const };
  const b = { ...a, participantId: 'b' };
  const c = { ...a, participantId: 'c', role: 'audience' as const, onStage: false, handRaised: true };
  return { ...state, speakers: [state.me, a, b], hands: [c], audience: [c], audienceCount: 1 };
}
async function synthetic(t: TestContext, active = ['a', 'b', 'c']) {
  const h = sampleApp({ source }); t.after(() => h.cleanup()); await flushSample();
  const state = syntheticState(); h.sdk.speaking = new Set(active); h.sdk.snapshot(state);
  const rows = () => h.app.descendants().filter(row => row.classList.contains('person') && row.dataset.participantId !== undefined);
  const check = (ids: string[]) => {
    for (const row of rows()) assert.equal(row.classList.contains('speaking'), ids.includes(row.dataset.participantId!), row.dataset.participantId);
  };
  const emit = (ids: string[]) => { h.sdk.speaking = new Set(ids); h.sdk.emit('speaking', { participantIds: ids }); };
  return { ...h, state, rows, check, emit };
}

it('reconnect clears both duplicate rows in place, adds no SDK work and ignores reports until a current resumed state', async t => {
  const h = await synthetic(t), rows = h.rows(), jobs = [...h.clock.jobs.values()].map(job => [job.kind, job.delay]);
  const nodes = h.app.descendants();
  h.sdk.setStatus('reconnecting'); h.check([]);
  assert.deepEqual(h.rows(), rows); assert.deepEqual(h.app.descendants(), nodes);
  assert.deepEqual([...h.clock.jobs.values()].map(job => [job.kind, job.delay]), jobs);
  assert.equal(h.sdk.audioRetries.length, 0); assert.equal(h.sdk.previews.length, 0); assert.equal(h.sdk.joins.length, 0);
  h.emit(['a']); h.check([]);
  h.sdk.setStatus('live'); h.emit(['b']); h.check([]);
  h.sdk.emit('state', h.state); h.emit(['c']); h.check([]);
  h.sdk.snapshot({ ...h.state }); h.check([]); h.emit(['c']); h.check(['c']);
});

it('a snapshot processed during reconnect cannot be admitted later by status alone', async t => {
  const h = await synthetic(t); h.sdk.setStatus('reconnecting');
  const during = { ...h.state, name: 'During loss' };
  h.sdk.state = during; h.sdk.emit('state', during); h.check([]);
  h.sdk.setStatus('live'); h.emit(['a']); h.check([]);
  h.sdk.snapshot({ ...during }); h.emit(['b']); h.check(['b']);
});

it('resume status-before-state and fresh empty reports preserve ordinary snapshot seeding afterward', async t => {
  const h = await synthetic(t); h.sdk.setStatus('reconnecting');
  const resumed = { ...h.state, name: 'Resumed' };
  h.sdk.state = resumed; h.sdk.setStatus('live'); h.emit(['a']); h.check([]);
  h.sdk.emit('state', resumed); h.check([]);
  h.emit([]); h.check([]);
  h.sdk.speaking = new Set(['b', 'c']); h.sdk.snapshot({ ...resumed, name: 'Ordinary update' }); h.check(['b', 'c']);
  h.sdk.snapshot(h.state); h.emit(['a']); h.check(['a']);
  h.sdk.setStatus('reconnecting'); h.check([]); h.sdk.emit('status', 'reconnecting'); h.check([]);
  h.sdk.snapshot({ ...resumed, name: 'Second resume' }); h.check([]); h.emit(['a']); h.check(['a']);
});

it('landing retires speaking ownership and same-identity reentry retains ordinary seeding', async t => {
  const h = await synthetic(t); h.sdk.setStatus('reconnecting');
  await h.sdk.disconnect(); const retired = h.rows(); assert.deepEqual(retired, []);
  h.emit(['a']); h.sdk.emit('status', 'live'); assert.deepEqual(h.rows(), []);
  h.sdk.speaking = new Set(['b']); h.sdk.snapshot(h.state); h.check(['b']);
  h.sdk.setStatus('reconnecting'); h.check([]);
  h.sdk.speaking = new Set(['a']); h.sdk.snapshot({ ...h.state, roomId: 'new-room' }); h.check(['a']);
});

for (const timing of ['before', 'after'] as const) {
  it(`nested ${timing}-write speaking receipt finishes interrupted duplicate-row and multi-ID changes`, async t => {
    const h = await synthetic(t), rows = h.rows(); let fired = false;
    const row = rows.find(row => row.dataset.participantId === 'a')!, original = row.classList.toggle;
    row.classList.toggle = (name, force) => {
      if (name === 'speaking' && !fired) {
        fired = true;
        if (timing === 'before') h.emit(['a', 'c']);
        const result = original(name, force);
        if (timing === 'after') h.emit(['a', 'c']);
        return result;
      }
      return original(name, force);
    };
    h.emit([]); assert.equal(fired, true); h.check(['a', 'c']); assert.deepEqual(h.rows(), rows);
    h.emit(['a', 'c']); h.check(['a', 'c']); h.emit([]); h.check([]);
  });
}

it('two finite nested before-write receipts leave the newest projection and preserve unrelated classes', async t => {
  const h = await synthetic(t); let receipts = 0;
  for (const row of h.rows()) {
    row.className += ' preserved'; const original = row.classList.toggle;
    row.classList.toggle = (name, force) => {
      if (name === 'speaking' && receipts < 2) {
        receipts++; h.emit(receipts === 1 ? ['a', 'c'] : ['b']);
      }
      return original(name, force);
    };
  }
  h.emit([]); assert.equal(receipts, 2); h.check(['b']);
  assert.ok(h.rows().every(row => row.classList.contains('preserved')));
});

for (const target of ['state', 'landing', 'new-entry'] as const) {
  it(`a nested ${target} replaces speaking-row ownership before the old diff can continue`, async t => {
    const h = await synthetic(t), oldRows = h.rows();
    const calls: SampleNode[] = []; let fired = false, retiredClasses: string[] = [];
    for (const row of oldRows) {
      const original = row.classList.toggle;
      row.classList.toggle = (name, force) => {
        calls.push(row); const result = original(name, force);
        if (name === 'speaking' && !fired) {
          fired = true;
          if (target === 'state') { h.sdk.speaking = new Set(['c']); h.sdk.snapshot({ ...h.state, name: 'Replacement' }); }
          else {
            void h.sdk.disconnect();
            if (target === 'new-entry') { h.sdk.speaking = new Set(['b']); h.sdk.snapshot({ ...h.state, roomId: 'Replacement room' }); }
          }
          retiredClasses = oldRows.map(row => row.className);
        }
        return result;
      };
    }
    h.emit([]); assert.equal(fired, true); assert.equal(calls.length, 1);
    assert.ok(oldRows.every(row => !row.isConnected)); assert.deepEqual(oldRows.map(row => row.className), retiredClasses);
    if (target === 'state') h.check(['c']);
    else if (target === 'new-entry') h.check(['b']);
    else assert.deepEqual(h.rows(), []);
  });
}

for (const status of ['reconnecting', 'disconnected'] as const) {
  it(`a new identity snapshot while ${status} cannot restore retained speaking before live entry`, async t => {
    const h = await synthetic(t); h.sdk.setStatus(status); h.check([]);
    const next = { ...h.state, roomId: 'new identity' };
    h.sdk.state = next; h.sdk.emit('state', next); h.check([]);
    h.sdk.setStatus('live'); h.emit(['c']); h.check([]);
    h.sdk.speaking = new Set(['b']); h.sdk.emit('state', next); h.check([]);
    h.emit(['a']); h.check(['a']);
  });
}

it('a fresh receipt during ordinary row construction updates current unmounted rows before they mount', async t => {
  let h: ReturnType<typeof sampleApp> | undefined, armed = false, fired = false;
  const app = sampleApp({ source, decodeName(value) {
    if (armed && value === 'Trigger second speaker' && !fired) {
      fired = true; h!.sdk.speaking = new Set(['b']); h!.sdk.emit('speaking', { participantIds: ['b'] });
    }
    return value;
  } });
  h = app; t.after(() => app.cleanup()); await flushSample();
  const state = syntheticState(); state.speakers[2]!.name = 'Trigger second speaker';
  h.sdk.speaking = new Set(['a']); h.sdk.snapshot(state); armed = true;
  h.sdk.snapshot({ ...state, name: 'Rebuild' }); assert.equal(fired, true);
  const check = () => {
    const rows = app.app.descendants().filter(row => row.classList.contains('person'));
    for (const row of rows) assert.equal(row.classList.contains('speaking'), row.dataset.participantId === 'b');
  };
  check(); h.sdk.emit('speaking', { participantIds: ['b'] }); check();
});
