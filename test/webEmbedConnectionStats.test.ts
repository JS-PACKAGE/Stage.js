/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { StageClient } from '../packages/client/src/index.ts';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { EmbedNode, embedApp, flush } from './fixtures/embedApp.ts';
import { actualApp, actualState, StagePeer, StageSocket, StageContext } from './fixtures/embedSdkApp.ts';

// Execute the complete production entry with the real SDK; replace only browser/external-host boundaries.
type App = Awaited<ReturnType<typeof actualApp>>;
type Entry = Record<string, unknown>;
const INITIAL = '尚未手動讀取連線統計。';
const FAILED = '無法讀取連線統計，請稍後手動再試。';
const RETAINED = '本次讀取失敗，仍顯示上次手動讀取結果。';
const report = (...entries: Entry[]) => new Map(entries.map(entry => [String(entry.id), entry])) as unknown as RTCStatsReport;
const inbound = (timestamp = 1000, received = 100, lost = 0, delay = 2, emitted = 100): Entry =>
  ({ id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp, bytesReceived: timestamp,
    packetsReceived: received, packetsLost: lost, jitterBufferDelay: delay, jitterBufferEmittedCount: emitted });
const pair = { id: 'pair', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: .043 };
const outbound = { id: 'out', type: 'outbound-rtp', kind: 'audio', timestamp: 1000, bytesSent: 300, remoteId: 'remote' };
const remote = { id: 'remote', type: 'remote-inbound-rtp', fractionLost: .125, roundTripTime: .1 };
const stats = (rtt = .04) => ({ inbound: { lossPercent: 4, rtt, bufferMs: 20 }, outbound: { lossPercent: 12.5, rtt: .09 } });
const text = (h: App) => h.node('connection-stats-text').textContent;
const refresh = (h: App) => h.node('connection-stats-update').invoke();
function state(role: ParticipantView['role'] = 'audience', onStage = false): RoomStatePayload {
  const s = actualState({ role, onStage }); s.controllerId = role === 'controller' ? s.me.participantId : 'host';
  const controller = { ...s.me, participantId: s.controllerId, role: 'controller' as const, onStage: true };
  s.speakers = role === 'controller' ? (onStage ? [{ ...s.me }] : []) : [controller, ...(onStage ? [{ ...s.me }] : [])];
  s.audienceCount = role === 'audience' && !onStage ? 1 : 0; return s;
}
function hello(socket: StageSocket) {
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
}
async function join(h: App, s = state()) {
  h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!; hello(socket);
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'join request');
  const request = socket.sent.find(m => m.type === 'join')!;
  socket.deliver({ type: 'room:state', ...s }); socket.deliver({ type: 'ok', requestId: request.requestId });
  await h.until(() => StagePeer.instances.at(-1)?.localDescription !== null && StagePeer.instances.at(-1)?.signalingState === 'stable', 'negotiation');
  await h.tick(20); return { socket, peer: StagePeer.instances.at(-1)!, client: h.clients.at(-1)! as StageClient };
}
async function setup(t: TestContext, s = state(), options: Parameters<typeof actualApp>[1] = {}) {
  const h = await actualApp(t, options); return { h, ...await join(h, s) };
}
function samples(peer: StagePeer, get: () => Promise<RTCStatsReport>) { Object.defineProperty(peer, 'getStats', { configurable: true, value: get }); }
function fake(client: StageClient, get: () => unknown) { Object.defineProperty(client, 'getStats', { configurable: true, value: get }); }
function busy(h: App, value: boolean): void {
  assert.equal(h.node('connection-stats-update').disabled, value);
  assert.equal(h.node('connection-stats-update').getAttribute('aria-busy'), String(value));
}
function hidden(h: App): void {
  assert.equal(h.node('connection-stats-panel').hidden, true); assert.equal(text(h), '');
  assert.equal(h.node('connection-stats-update').disabled, true);
  assert.equal(h.node('connection-stats-update').getAttribute('aria-busy'), 'false');
}
function media(h: App) {
  return { captures: h.captures.length, plays: h.audio.plays, pauses: h.audio.pauses, peers: StagePeer.instances.length,
    contexts: StageContext.instances.length, enumerations: h.enumerations.length, sinks: h.sinks.length,
    stops: h.tracks.map(track => track.stops), offers: StagePeer.instances.map(peer => peer.offers.length),
    replacements: StagePeer.instances.map(peer => peer.replacements.length) };
}
function unaffected(h: App) {
  return ['status', 'room-occupancy', 'own-connection-quality', 'speaking-summary', 'last-error', 'error-notice',
    'close-room', 'stage-management-list', 'mic-retry', 'audio-retry-status'].map(id => {
      const n = h.node(id); return [id, n.textContent, n.hidden, n.disabled, { ...n.attributes }];
    });
}
function setter(node: EmbedNode, property: 'hidden' | 'disabled' | 'textContent', action: () => void, late = false) {
  let value: unknown = node[property], armed = true;
  Object.defineProperty(node, property, { configurable: true, get: () => value, set(next: unknown) {
    if (!late) value = next;
    if (armed) { armed = false; action(); }
    if (late) value = next;
  } });
}
function transfer(h: App): EmbedNode {
  const button = h.node('stage-management-list').children[0]?.children[1]?.children[2]; assert.ok(button); return button;
}
async function controller(t: TestContext, options: Parameters<typeof actualApp>[1] = {}) {
  const s = state('controller'); s.speakers.push({ ...s.me, participantId: 'target', role: 'speaker', onStage: true });
  return setup(t, s, options);
}

it('embed authors one ordinary independent panel and explicit native button, without an automatic read', async t => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  for (const id of ['connection-stats-panel', 'connection-stats-update', 'connection-stats-text']) assert.equal(html.match(new RegExp(`id="${id}"`, 'g'))?.length, 1);
  const authored = html.match(/<div id="connection-stats-panel"[\s\S]*?<\/div>/)![0];
  assert.match(authored, /<button[^>]*type="button"[^>]*disabled>更新我的連線統計<\/button>/);
  assert.match(authored, /aria-describedby="connection-stats-text"/); assert.doesNotMatch(authored, /role=|aria-live=|innerHTML/);
  const { h, client, peer } = await setup(t); let reads = 0; samples(peer, async () => { reads++; return report(inbound()); });
  assert.equal(text(h), INITIAL); busy(h, false);
  for (let i = 0; i < 4; i++) {
    client.dispatchEvent(new CustomEvent('state', { detail: client.state }));
    client.dispatchEvent(new CustomEvent('quality', { detail: { participants: [] } }));
    client.dispatchEvent(new CustomEvent('speaking', { detail: { participantIds: [] } }));
    client['setStatus']('waiting'); client['setStatus']('live'); await h.tick(200);
  }
  assert.equal(reads, 0); assert.equal(text(h), INITIAL); refresh(h); await flush(); assert.equal(reads, 1);
});
for (const role of ['audience', 'speaker', 'controller'] as const) for (const onStage of [false, true])
  for (const active of ['waiting', 'live'] as const) it(`actual SDK manual ${role}/${onStage}/${active} read adds no commands, timers, media or old UI changes`, async t => {
    const s = state(role, onStage); s.me.connected = false; s.me.muted = s.me.forceMuted = true;
    const { h, client, peer, socket } = await setup(t, s); client['setStatus'](active); let calls = 0;
    samples(peer, async () => { calls++; return report(inbound(), pair, ...(onStage ? [outbound, remote] : [])); });
    const oldUi = unaffected(h), oldMedia = media(h), frames = [...socket.sent];
    const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
    refresh(h); await flush(); assert.equal(calls, 1); assert.match(text(h), /接收掉包 —% · 接收 RTT 43 ms · 接收緩衝 — ms/);
    assert.match(text(h), onStage ? /傳送掉包 12.5% · 傳送 RTT 100 ms/ : /傳送：暫無統計/);
    assert.match(text(h), /上次手動讀取（SDK 取樣區間）/); assert.match(text(h), /RTT 不是端到端音訊延遲/);
    assert.deepEqual(unaffected(h), oldUi); assert.deepEqual(media(h), oldMedia); assert.deepEqual(socket.sent, frames);
    assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0);
  });
it('actual SDK delta units use shared sampling baseline and last matching audio RTP, never aggregate streams', async t => {
  const { h, peer, client } = await setup(t); let entries = report(inbound(), pair); samples(peer, async () => entries);
  refresh(h); await flush();
  entries = report(inbound(2000, 119, 1, 2.4, 120), pair); refresh(h); await flush();
  assert.match(text(h), /接收掉包 5.0% · 接收 RTT 43 ms · 接收緩衝 20 ms/);
  entries = report(inbound(3000, 219, 1, 4.4, 220), pair); await client.getStats();
  entries = report(inbound(4000, 318, 2, 4.9, 320), pair); refresh(h); await flush();
  assert.match(text(h), /接收掉包 1.0% · 接收 RTT 43 ms · 接收緩衝 5 ms/);
  entries = report(inbound(5000), { ...inbound(5000), id: 'last-in', remoteId: 'last-remote' }, pair,
    { id: 'last-remote', type: 'remote-outbound-rtp', roundTripTime: .222 }, outbound, remote,
    { ...outbound, id: 'last-out', remoteId: 'last-out-remote' }, { ...remote, id: 'last-out-remote', fractionLost: .5 },
    { id: 'video', type: 'inbound-rtp', kind: 'video' });
  refresh(h); await flush(); assert.match(text(h), /接收 RTT 222 ms/); assert.match(text(h), /傳送掉包 50.0%/);
});
it('actual SDK missing audio, partial and repeated/reset counters never invent zero loss', async t => {
  const { h, peer } = await setup(t); let entries = report(); samples(peer, async () => entries);
  refresh(h); await flush(); assert.match(text(h), /接收：暫無統計；傳送：暫無統計/);
  entries = report({ id: 'video', type: 'inbound-rtp', kind: 'video' }); refresh(h); await flush(); assert.match(text(h), /接收：暫無統計/);
  entries = report({ id: 'in', type: 'inbound-rtp', kind: 'audio' }); refresh(h); await flush(); assert.match(text(h), /接收掉包 —% · 接收 RTT — ms · 接收緩衝 — ms/);
  for (const stamp of [1000, 1000, 500]) { entries = report(inbound(stamp)); refresh(h); await flush(); assert.match(text(h), /接收掉包 —%/); }
  entries = report(inbound(2000, 1, 0, 0, 1)); refresh(h); await flush(); assert.match(text(h), /接收掉包 —%/);
});
it('actual state before ACK and peer creation permits an explicitly empty manual result', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!; hello(socket);
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'join');
  const client = h.clients[0] as StageClient;
  client.on('state', () => { assert.equal(StagePeer.instances.length, 0); refresh(h); });
  socket.deliver({ type: 'room:state', ...state() });
  await flush(); assert.match(text(h), /接收：暫無統計；傳送：暫無統計/);
  socket.deliver({ type: 'ok', requestId: socket.sent.find(m => m.type === 'join')!.requestId }); await h.tick(20);
});
for (const invalid of [undefined, null, '1', -1, NaN, Infinity, -Infinity, {}, new Number(1), 101])
  it(`projects only numeric primitives without coercion: ${String(invalid)}`, async t => {
    const { h, client } = await setup(t);
    fake(client, async () => ({ inbound: { lossPercent: invalid, rtt: invalid, bufferMs: invalid }, outbound: { lossPercent: invalid, rtt: invalid } }));
    refresh(h); await flush(); assert.match(text(h), /接收掉包 —%/); assert.match(text(h), /傳送掉包 —%/);
    if (invalid !== 101) assert.match(text(h), /接收 RTT — ms · 接收緩衝 — ms；傳送掉包 —% · 傳送 RTT — ms/);
    assert.doesNotMatch(text(h), /NaN|Infinity|\[object|失敗/);
  });
it('preserves zero, rounds bounded percentages and milliseconds, and rejects conversion overflow', async t => {
  const { h, client } = await setup(t); let raw: unknown = { inbound: { lossPercent: 0, rtt: 0, bufferMs: 0 }, outbound: { lossPercent: 100, rtt: 0 } };
  fake(client, async () => raw); refresh(h); await flush(); assert.match(text(h), /接收掉包 0.0% · 接收 RTT 0 ms · 接收緩衝 0 ms；傳送掉包 100.0% · 傳送 RTT 0 ms/);
  raw = { inbound: { lossPercent: 1.26, rtt: .0126, bufferMs: 20.6 }, outbound: { lossPercent: 2.34, rtt: Number.MAX_VALUE } };
  refresh(h); await flush(); assert.match(text(h), /接收掉包 1.3% · 接收 RTT 13 ms · 接收緩衝 21 ms；傳送掉包 2.3% · 傳送 RTT — ms/);
});
for (const malformed of [null, undefined, false, 42, 'private', [], { inbound: [] }, { outbound: 1 }, { inbound: () => 1 }])
  it(`malformed envelope/direction retains historical result: ${JSON.stringify(malformed)}`, async t => {
    const { h, client } = await setup(t); let raw: unknown = stats(); fake(client, async () => raw); refresh(h); await flush();
    const historical = text(h); raw = malformed; refresh(h); await flush(); assert.equal(text(h), historical + RETAINED); busy(h, false);
  });
for (const [direction, field] of [['root', 'inbound'], ['root', 'outbound'], ['inbound', 'lossPercent'], ['inbound', 'rtt'], ['inbound', 'bufferMs'], ['outbound', 'lossPercent'], ['outbound', 'rtt']] as const)
  it(`throwing used getter ${direction}.${field} produces only fixed local feedback`, async t => {
    const { h, client } = await setup(t), raw = stats(), secret = { toString() { assert.fail('exception must not be coerced'); } };
    Object.defineProperty(direction === 'root' ? raw : raw[direction], field, { get() { throw secret; } });
    const old = unaffected(h); fake(client, async () => raw); refresh(h); await flush(); assert.equal(text(h), FAILED); assert.deepEqual(unaffected(h), old); busy(h, false);
  });
it('copies only five metrics, never reads RTC raw/private fields, and ignores later result mutation', async t => {
  const { h, client } = await setup(t), raw = stats();
  for (const object of [raw, raw.inbound, raw.outbound]) for (const key of ['address', 'mimeType', 'jitter', 'bitrateKbps', 'packetsLost', 'timestamp', 'ssrc', 'token', 'toString'])
    Object.defineProperty(object, key, { get() { assert.fail(`unused ${key}`); } });
  fake(client, async () => raw); refresh(h); await flush(); const historical = text(h);
  raw.inbound.rtt = 999; raw.outbound.lossPercent = 88; client['setStatus']('waiting'); assert.equal(text(h), historical);
  assert.equal((historical.match(/掉包| RTT \d|緩衝/g) ?? []).length, 5);
});
it('busy and failure retain history; successful empty read replaces it without changing old error/quality/speaking', async t => {
  const { h, client, socket } = await setup(t, state('speaker', true)); const work = Promise.withResolvers<unknown>(); let calls = 0;
  fake(client, () => ++calls === 1 ? Promise.resolve(stats()) : work.promise);
  socket.deliver({ type: 'error', code: 'conflict', message: '既有操作失敗。' });
  socket.deliver({ type: 'quality', participants: [{ participantId: 'guest', rttMs: 77 }] }); socket.deliver({ type: 'speaking', participantIds: [] });
  const old = unaffected(h); refresh(h); await flush(); const historical = text(h); refresh(h); busy(h, true); assert.equal(text(h), historical);
  refresh(h); h.node('connection-stats-update').disabled = false; refresh(h); assert.equal(calls, 2); busy(h, true);
  work.reject({ message: 'PRIVATE_ADDRESS_TOKEN' }); await flush(); assert.equal(text(h), historical + RETAINED); assert.deepEqual(unaffected(h), old);
  fake(client, async () => ({})); refresh(h); await flush(); assert.match(text(h), /接收：暫無統計；傳送：暫無統計/); assert.doesNotMatch(text(h), /失敗|40 ms/);
});
for (const mode of ['missing', 'noncallable', 'sync', 'reject', 'getter'])
  it(`missing or failing public capability (${mode}) has fixed local feedback and permits explicit retry`, async t => {
    const { h, client } = await setup(t);
    Object.defineProperty(client, 'getStats', { configurable: true, ...(mode === 'getter' ? { get() { throw 'PRIVATE'; } }
      : { value: mode === 'missing' ? undefined : mode === 'noncallable' ? 1 : () => { if (mode === 'sync') throw 'PRIVATE'; return Promise.reject('PRIVATE'); } }) });
    refresh(h); await flush(); assert.equal(text(h), FAILED); busy(h, false);
    fake(client, async () => stats()); refresh(h); await flush(); assert.match(text(h), /40 ms/);
  });
it('reserves before method getter, method call, and thenable assimilation can synthetically reclick', async t => {
  const { h, client } = await setup(t); let getters = 0, calls = 0, thenReads = 0;
  const again = () => { h.node('connection-stats-update').disabled = false; refresh(h); };
  Object.defineProperty(client, 'getStats', { configurable: true, get() {
    getters++; again(); return () => { calls++; again(); return { get then() { thenReads++; again(); return (resolve: (value: unknown) => void) => resolve(stats()); } }; };
  } });
  refresh(h); await flush(); assert.deepEqual([getters, calls, thenReads], [1, 1, 1]); busy(h, false); assert.match(text(h), /40 ms/);
});
for (const boundary of ['getter', 'call', 'inbound', 'outbound', 'inbound.lossPercent', 'inbound.rtt', 'inbound.bufferMs', 'outbound.lossPercent', 'outbound.rtt'])
  it(`${boundary} reentry cannot publish stale projection or release a newer attempt`, async t => {
    const { h, client } = await setup(t), newer = Promise.withResolvers<unknown>(); let entered = false, calls = 0;
    const replace = () => { entered = true; client['setStatus']('reconnecting'); client['setStatus']('live'); refresh(h); };
    Object.defineProperty(client, 'getStats', { configurable: true, get() {
      if (boundary === 'getter' && !entered) { replace(); return () => assert.fail('retired getter cannot be invoked'); }
      return () => {
        calls++; if (entered) return newer.promise;
        if (boundary === 'call') replace();
        const raw = stats();
        if (boundary !== 'call' && boundary !== 'getter') {
          const [direction, field] = boundary.split('.'); const object = field ? Reflect.get(raw, direction!) : raw;
          const key = field ?? direction!, value = Reflect.get(object, key);
          Object.defineProperty(object, key, { get() { replace(); return value; } });
        }
        return Promise.resolve(raw);
      };
    } });
    refresh(h); await flush(); assert.ok(entered); assert.equal(calls, boundary === 'getter' ? 1 : 2); busy(h, true); assert.equal(text(h), INITIAL);
    newer.resolve(stats(.123)); await flush(); busy(h, false); assert.match(text(h), /123 ms/); assert.doesNotMatch(text(h), /40 ms/);
  });
for (const cause of ['reconnecting', 'disconnected', 'closed', 'kicked', 'room', 'participant', 'leave', 'new-entry'])
  for (const outcome of ['resolve', 'reject']) it(`${cause} retires history and ignores late ${outcome}`, async t => {
    const { h, client } = await setup(t), old = Promise.withResolvers<unknown>(); let calls = 0;
    fake(client, () => ++calls === 1 ? Promise.resolve(stats()) : old.promise); refresh(h); await flush(); refresh(h); busy(h, true);
    if (cause === 'reconnecting' || cause === 'disconnected') client['setStatus'](cause);
    else if (cause === 'closed' || cause === 'kicked') client.dispatchEvent(new CustomEvent(cause, { detail: { reason: 'closed' } }));
    else if (cause === 'room' || cause === 'participant') {
      if (cause === 'room') client.state!.roomId = 'another-room'; else client.state!.me.participantId = 'another-seat';
      client['setStatus']('waiting');
    } else if (cause === 'leave') h.leave.click(); else h.form.submit();
    await flush(); if (outcome === 'resolve') old.resolve(stats(.999)); else old.reject('PRIVATE'); await flush();
    assert.doesNotMatch(text(h), /40 ms|999|失敗/);
    if (cause === 'room' || cause === 'participant') { assert.equal(text(h), INITIAL); busy(h, false); }
    else hidden(h);
  });
it('reconnect retains its captured binding and permits fresh manual work without a distinct state; old finally cannot unlock it', async t => {
  const { h, client } = await setup(t), old = Promise.withResolvers<unknown>(), newer = Promise.withResolvers<unknown>(); let calls = 0;
  fake(client, () => ++calls === 1 ? old.promise : newer.promise); const snapshot = client.state;
  refresh(h); client['setStatus']('reconnecting'); hidden(h); client['setStatus']('live');
  assert.equal(client.state, snapshot); assert.equal(calls, 1); assert.equal(text(h), INITIAL); refresh(h); busy(h, true);
  old.reject('PRIVATE'); await flush(); busy(h, true); assert.equal(text(h), INITIAL);
  newer.resolve(stats(.073)); await flush(); busy(h, false); assert.match(text(h), /73 ms/); assert.equal(calls, 2);
});
it('actual socket reconnect retains peer; stale native completion advances shared SDK baseline but cannot publish retired history', async t => {
  const original = state(), { h, socket, peer, client } = await setup(t, original); let entries = report(inbound());
  samples(peer, async () => entries); refresh(h); await flush();
  const old = Promise.withResolvers<RTCStatsReport>(); samples(peer, () => old.promise); refresh(h);
  socket.close(); hidden(h); assert.equal(peer.connectionState, 'connected'); await h.tick(500);
  const resumed = StageSocket.instances.at(-1)!; hello(resumed); await h.until(() => resumed.sent.some(m => m.type === 'join'), 'resume');
  resumed.deliver({ type: 'room:state', ...original }); resumed.deliver({ type: 'ok', requestId: resumed.sent.find(m => m.type === 'join')!.requestId }); await h.tick(20);
  assert.equal(client.status, 'live'); assert.equal(StagePeer.instances.length, 1); assert.equal(text(h), INITIAL);
  old.resolve(report(inbound(2000, 190, 10, 4, 200))); await flush(); assert.equal(text(h), INITIAL);
  entries = report(inbound(3000, 290, 10, 6, 300)); samples(peer, async () => entries); refresh(h); await flush();
  assert.match(text(h), /接收掉包 0.0%/);
});
it('actual newer external completion suppresses older UI native result without failure or aggregate deltas', async t => {
  const { h, peer, client } = await setup(t), old = Promise.withResolvers<RTCStatsReport>(); let count = 0;
  samples(peer, () => ++count === 1 ? old.promise : Promise.resolve(report(inbound(2000))));
  refresh(h); await client.getStats(); old.resolve(report(inbound(1000))); await flush();
  assert.match(text(h), /接收：暫無統計；傳送：暫無統計/); assert.doesNotMatch(text(h), /失敗/); busy(h, false);
});
for (const outcome of ['resolve', 'reject']) it(`new legitimate client reads despite unresolved old peer and shared-audio sink; late ${outcome} cannot change new stats`, async t => {
  const { h, client, peer } = await setup(t, state(), { output: true }), old = Promise.withResolvers<RTCStatsReport>(); samples(peer, () => old.promise);
  refresh(h); h.node('output-apply').click(); assert.equal(h.sinks.length, 1);
  h.leave.click(); await flush(); const newer = await join(h); assert.notEqual(newer.client, client); assert.notEqual(newer.peer, peer);
  assert.equal(client['audio'], newer.client['audio']); assert.equal(h.node('output-apply').disabled, true);
  let entries = report(inbound(2000, 190, 10, 4, 200), pair); samples(newer.peer, async () => entries); refresh(h); await flush();
  assert.match(text(h), /接收掉包 —% · 接收 RTT 43 ms · 接收緩衝 — ms/); const historical = text(h);
  if (outcome === 'resolve') old.resolve(report(inbound(9000, 9000, 90))); else old.reject('PRIVATE'); await flush();
  assert.equal(text(h), historical); busy(h, false); entries = report(inbound(3000, 290, 10, 6, 300)); refresh(h); await flush(); assert.match(text(h), /接收掉包 0.0%/);
  h.sinks[0]!.work.resolve(); await flush();
});
for (const terminal of ['disconnected', 'closed', 'kicked', 'leave']) it(`${terminal} permanently retires embed binding even when actual same client directly rejoins`, async t => {
  const { h, client, peer } = await setup(t); samples(peer, async () => report(inbound(), pair)); refresh(h); await flush();
  if (terminal === 'disconnected') await client.disconnect();
  else if (terminal === 'leave') h.leave.click();
  else { client.dispatchEvent(new CustomEvent(terminal, { detail: {} })); await client.disconnect(); }
  await flush(); hidden(h);
  const returning = client.join({ roomId: 'same-room', name: 'Returning' }); await flush(); const socket = StageSocket.instances.at(-1)!; hello(socket);
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'same-client join');
  socket.deliver({ type: 'room:state', ...state() }); socket.deliver({ type: 'ok', requestId: socket.sent.find(m => m.type === 'join')!.requestId }); await returning; await h.tick(20);
  assert.equal(client.status, 'live'); hidden(h); let calls = 0; samples(StagePeer.instances.at(-1)!, async () => { calls++; return report(inbound(), pair); });
  h.node('connection-stats-update').disabled = false; h.node('connection-stats-panel').hidden = false; refresh(h); await flush(); assert.equal(calls, 0); hidden(h);
  assert.equal(h.leave.disabled, true); assert.equal((await client.getStats()).inbound?.rtt, .043);
});
it('actual initial state without ACK followed by disconnect cannot recreate controls from retained state/status', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!; hello(socket);
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'join'); socket.deliver({ type: 'room:state', ...state() });
  const client = h.clients[0] as StageClient; socket.close(); await flush(); assert.equal(client.status, 'disconnected'); assert.ok(client.state); hidden(h);
  client['currentStatus'] = 'live'; client.dispatchEvent(new CustomEvent('state', { detail: client.state }));
  client.dispatchEvent(new CustomEvent('status', { detail: 'live' })); hidden(h);
  let reads = 0; fake(client, async () => { reads++; return stats(); }); h.node('connection-stats-update').disabled = false;
  h.node('connection-stats-panel').hidden = false; refresh(h); await flush(); assert.equal(reads, 0); hidden(h);
});
it('same-seat role/stage/connected/microphone changes preserve pending and historical own metrics', async t => {
  const { h, client, socket } = await setup(t, state('speaker', true)), work = Promise.withResolvers<unknown>(); let calls = 0;
  fake(client, () => { calls++; return work.promise; }); refresh(h);
  for (const role of ['audience', 'controller', 'speaker'] as const) {
    const s = state(role, role === 'speaker'); s.me.connected = false; s.me.muted = s.me.forceMuted = true;
    socket.deliver({ type: 'room:state', ...s }); await h.tick(20); busy(h, true);
  }
  client.dispatchEvent(new CustomEvent('micerror', { detail: { message: '麥克風不可用', name: 'NotAllowedError' } }));
  const old = unaffected(h), oldMedia = media(h); work.resolve(stats()); await flush(); assert.match(text(h), /40 ms/);
  assert.deepEqual(unaffected(h), old); assert.deepEqual(media(h), oldMedia); const historical = text(h);
  client.dispatchEvent(new CustomEvent('state', { detail: client.state })); assert.equal(text(h), historical); assert.equal(calls, 1);
});
for (const kind of ['disabled', 'button-hidden', 'panel-hidden', 'button-detached', 'text-detached', 'reparented'])
  it(`rejects retained synthetic ${kind} click without stats lookup`, async t => {
    const { h, client } = await setup(t); let calls = 0; fake(client, async () => { calls++; return stats(); });
    if (kind === 'disabled') h.node('connection-stats-update').disabled = true;
    if (kind === 'button-hidden') h.node('connection-stats-update').hidden = true;
    if (kind === 'panel-hidden') h.node('connection-stats-panel').hidden = true;
    if (kind === 'button-detached') h.node('connection-stats-update').remove();
    if (kind === 'text-detached') h.node('connection-stats-text').remove();
    if (kind === 'reparented') new EmbedNode().append(h.node('connection-stats-update'));
    refresh(h); await flush(); assert.equal(calls, 0);
  });
for (const id of ['connection-stats-panel', 'connection-stats-update', 'connection-stats-text'])
  it(`exact document identity rejects replaced ${id} even with original panel containment`, async t => {
    // Instrument only querySelector's result inside the actual production module seam.
    const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8')
      + `\nconst originalQuery = document.querySelector.bind(document);\n(document as any).querySelector = (selector: string) => selector === '#${id}' ? document.createElement('div') : originalQuery(selector);\n`;
    const h = embedApp({ source }); t.after(() => h.cleanup()); const client = await h.join(); let calls = 0;
    Object.defineProperty(client, 'getStats', { value: async () => { calls++; return stats(); } });
    h.node('connection-stats-panel').hidden = false; h.node('connection-stats-update').disabled = false; h.node('connection-stats-update').invoke(); await flush(); assert.equal(calls, 0);
  });
for (const property of ['disabled', 'button-text', 'result-text', 'aria-busy', 'hidden']) for (const late of [false, true])
  it(`${property} setter reconciles nested newer winner, including late outer overwrite=${late}`, async t => {
    const { h, client } = await setup(t), newer = Promise.withResolvers<unknown>(); let calls = 0;
    fake(client, () => { calls++; return property === 'result-text' && calls === 1 ? Promise.resolve(stats()) : newer.promise; });
    const replace = () => { client['setStatus']('reconnecting'); client['setStatus']('live'); refresh(h); };
    if (property === 'aria-busy') {
      const node = h.node('connection-stats-update'), set = node.setAttribute.bind(node); let armed = true;
      t.mock.method(node, 'setAttribute', (key: string, value: string) => {
        if (!late) set(key, value); if (key === 'aria-busy' && armed) { armed = false; replace(); } if (late) set(key, value);
      });
    } else if (property === 'hidden') { client['setStatus']('reconnecting'); setter(h.node('connection-stats-panel'), 'hidden', replace, late); client['setStatus']('live'); }
    else setter(h.node(property === 'result-text' ? 'connection-stats-text' : 'connection-stats-update'), property === 'disabled' ? 'disabled' : 'textContent', replace, late);
    refresh(h); await flush(); assert.equal(calls, property === 'result-text' ? 2 : 1); busy(h, true); assert.equal(text(h), INITIAL);
    newer.resolve(stats(.081)); await flush(); busy(h, false); assert.match(text(h), /81 ms/); assert.doesNotMatch(text(h), /40 ms/);
  });
for (const boundary of ['result getter', 'result setter']) it(`${boundary} reconciles nested winner followed by silent disconnect and never restores old binding`, async t => {
  const { h, client } = await setup(t), newer = Promise.withResolvers<unknown>(); let calls = 0;
  const replaceThenLose = () => { client['setStatus']('reconnecting'); client['setStatus']('live'); refresh(h); client['currentStatus'] = 'disconnected'; };
  fake(client, () => {
    if (++calls > 1) return newer.promise; const raw = stats();
    if (boundary === 'result getter') Object.defineProperty(raw, 'inbound', { get() { replaceThenLose(); return stats().inbound; } });
    return Promise.resolve(raw);
  });
  if (boundary === 'result setter') setter(h.node('connection-stats-text'), 'textContent', replaceThenLose, true);
  refresh(h); await flush(); assert.equal(calls, 2); hidden(h); newer.resolve(stats(.999)); await flush(); hidden(h);
  client['setStatus']('live'); hidden(h); assert.equal(calls, 2);
});
for (const action of ['close', 'transfer']) for (const loss of ['none', 'reconnecting', 'disconnected', 'room', 'participant', 'role', 'connected', 'target'])
  it(`${action} consent ${loss === 'none' ? 'survives ordinary diagnostics' : `retires on observed ${loss} before corrective stats setters restore it`}`, async t => {
    let onConfirm = () => {};
    const { h, client } = await controller(t, { confirm: () => { onConfirm(); return true; } });
    const close = t.mock.method(client, 'closeRoom', async () => {}), handover = t.mock.method(client, 'transferControl', async () => {});
    const snapshot = client.state!, target = snapshot.speakers.find(p => p.participantId === 'target')!;
    const restore = () => {
      client['currentStatus'] = 'live'; snapshot.roomId = 'same-room'; snapshot.me.participantId = 'guest';
      snapshot.me.role = 'controller'; snapshot.me.connected = true; target.connected = true;
    };
    Object.defineProperty(client, 'getStats', { configurable: true, get() {
      if (loss === 'reconnecting' || loss === 'disconnected') client['currentStatus'] = loss;
      if (loss === 'room') snapshot.roomId = 'other';
      if (loss === 'participant') snapshot.me.participantId = 'other';
      if (loss === 'role') snapshot.me.role = 'audience';
      if (loss === 'connected') snapshot.me.connected = false;
      if (loss === 'target') target.connected = false;
      return async () => stats();
    } });
    // Status/identity loss hides or clears; role/target loss preserves readership but changes busy text.
    if (loss === 'reconnecting' || loss === 'disconnected') setter(h.node('connection-stats-panel'), 'hidden', restore, true);
    else setter(h.node('connection-stats-update'), 'textContent', () => {}, false);
    onConfirm = () => {
      refresh(h);
      // Synchronous getStats guard has already observed any loss before confirmation returns.
      restore();
    };
    (action === 'close' ? h.node('close-room') : transfer(h)).click(); await flush();
    const preserved = loss === 'none' || (action === 'close' && loss === 'target');
    assert.equal(close.mock.callCount(), preserved && action === 'close' ? 1 : 0);
    assert.equal(handover.mock.callCount(), preserved && action === 'transfer' ? 1 : 0);
  });
for (const cause of ['leave', 'new-entry', 'closed', 'kicked', 'disconnected']) for (const action of ['close', 'transfer'])
  it(`${cause} purely fences diagnostics before early teardown callbacks and invalidates old ${action} before new DOM`, async t => {
    const { h, client } = await controller(t, { confirm: () => true }); let reads = 0, inEarly = false, earlyPaints = 0;
    fake(client, async () => { reads++; return stats(); }); const oldButton = action === 'close' ? h.node('close-room') : transfer(h);
    const close = t.mock.method(client, 'closeRoom', async () => {}), handover = t.mock.method(client, 'transferControl', async () => {});
    setter(h.node('connection-stats-panel'), 'hidden', () => {
      if (inEarly) earlyPaints++;
      oldButton.disabled = false; oldButton.invoke();
    });
    const early = () => { inEarly = true; refresh(h); inEarly = false; };
    if (cause === 'disconnected') {
      const descriptor = Object.getOwnPropertyDescriptor(StageClient.prototype, 'state')!; let armed = true;
      Object.defineProperty(client, 'state', { configurable: true, get() { if (armed) { armed = false; early(); } return descriptor.get!.call(client); } });
    } else setter(h.node(cause === 'closed' || cause === 'kicked' ? 'cancel-join' : 'error-notice'), 'hidden', early);
    if (cause === 'leave') h.leave.click(); else if (cause === 'new-entry') h.form.submit();
    else if (cause === 'disconnected') client['setStatus']('disconnected');
    else client.dispatchEvent(new CustomEvent(cause, { detail: {} }));
    await flush(); assert.equal(reads, 0); assert.equal(earlyPaints, 0); assert.equal(close.mock.callCount(), 0); assert.equal(handover.mock.callCount(), 0);
    Reflect.deleteProperty(client, 'state');
  });
for (const cause of ['leave', 'new-entry', 'closed', 'kicked', 'disconnected']) for (const action of ['close', 'transfer'])
  it(`${cause} inside pending ${action} confirmation cannot restore its consent via diagnostics`, async t => {
    let onConfirm = () => {};
    const { h, client } = await controller(t, { confirm: () => { onConfirm(); return true; } });
    let reads = 0; fake(client, async () => { reads++; return stats(); });
    const close = t.mock.method(client, 'closeRoom', async () => {}), handover = t.mock.method(client, 'transferControl', async () => {});
    onConfirm = () => {
      if (cause === 'leave') h.leave.click(); else if (cause === 'new-entry') h.form.submit();
      else if (cause === 'disconnected') client['setStatus']('disconnected'); else client.dispatchEvent(new CustomEvent(cause, { detail: {} }));
      client['currentStatus'] = 'live'; h.node('connection-stats-panel').hidden = false; h.node('connection-stats-update').disabled = false; refresh(h);
    };
    (action === 'close' ? h.node('close-room') : transfer(h)).click(); await flush();
    assert.equal(reads, 0); assert.equal(close.mock.callCount(), 0); assert.equal(handover.mock.callCount(), 0);
  });
it('installs actual new-client captured generation binding before its first syncUnlock callback', async t => {
  const h = await actualApp(t); let reads = 0, entered = false;
  const node = h.node('unlock'); let disabled = node.disabled;
  Object.defineProperty(node, 'disabled', { configurable: true, get: () => disabled, set(value: boolean) {
    disabled = value;
    if (!entered && h.clients.length === 1) {
      entered = true; const client = h.clients[0] as StageClient; client['snapshot'] = state(); client['currentStatus'] = 'live';
      fake(client, async () => { reads++; return stats(.064); });
      h.node('connection-stats-panel').hidden = false; h.node('connection-stats-update').disabled = false; refresh(h);
    }
  } });
  await join(h); await flush(); assert.ok(entered); assert.equal(reads, 1); assert.match(text(h), /64 ms/);
});
for (const getter of ['state', 'status']) for (const cause of ['new-entry', 'leave'])
  it(`public ${getter} getter starting ${cause} cannot manufacture a binding from the new global generation`, async t => {
    const { h, client } = await setup(t); let reads = 0, armed = true; fake(client, async () => { reads++; return stats(); });
    const descriptor = Object.getOwnPropertyDescriptor(StageClient.prototype, getter)!;
    Object.defineProperty(client, getter, { configurable: true, get() {
      const value: unknown = descriptor.get!.call(client);
      if (armed) { armed = false; if (cause === 'new-entry') h.form.submit(); else h.leave.click(); }
      return value;
    } });
    refresh(h); await flush(); assert.equal(reads, 0); Reflect.deleteProperty(client, getter); hidden(h);
  });
for (const getter of ['roomId', 'participantId'])
  it(`public ${getter} identity getter reentry retires attempt before SDK method lookup`, async t => {
    const { h, client } = await setup(t); let reads = 0, armed = true; fake(client, async () => { reads++; return stats(); });
    const target = getter === 'roomId' ? client.state! : client.state!.me, value = Reflect.get(target, getter);
    Object.defineProperty(target, getter, { configurable: true, get() {
      if (armed) { armed = false; h.leave.click(); } return value;
    } });
    refresh(h); await flush(); assert.equal(reads, 0); hidden(h);
  });
it('preserves unrelated UI and avoids equal writes on repeated same-seat state and status receipts', async t => {
  const { h, client } = await setup(t); fake(client, async () => stats()); refresh(h); await flush(); const historical = text(h);
  const nodes = ['connection-stats-panel', 'connection-stats-update', 'connection-stats-text'].map(id => h.node(id));
  for (const node of nodes) node.resetWrites();
  for (let i = 0; i < 3; i++) client.dispatchEvent(new CustomEvent('state', { detail: client.state }));
  assert.equal(text(h), historical); for (const node of nodes) assert.deepEqual(node.writes, { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 });
});
it('genuine hidden initial DOM rejects early syncUnlock retained handler without damaging normal join', async t => {
  const h = await actualApp(t); let early = 0, reads = 0;
  const node = h.node('unlock'); let disabled = node.disabled;
  Object.defineProperty(node, 'disabled', { configurable: true, get: () => disabled, set(value: boolean) {
    disabled = value;
    if (h.clients.length === 1 && early === 0) {
      early++; const client = h.clients[0] as StageClient; assert.equal(client.status, 'disconnected');
      assert.equal(h.node('connection-stats-panel').hidden, true); assert.equal(h.node('connection-stats-update').disabled, true);
      fake(client, async () => { reads++; return stats(); }); refresh(h);
    }
  } });
  await join(h); assert.equal(early, 1); assert.equal(reads, 0); assert.equal(text(h), INITIAL);
  refresh(h); await flush(); assert.equal(reads, 1); assert.match(text(h), /40 ms/);
});
it('host-forced initial disconnected visibility fails closed for that binding; a genuine new entry recovers', async t => {
  const h = await actualApp(t); let early = 0, reads = 0;
  const node = h.node('unlock'); let disabled = node.disabled;
  Object.defineProperty(node, 'disabled', { configurable: true, get: () => disabled, set(value: boolean) {
    disabled = value;
    if (h.clients.length === 1 && early === 0) {
      early++; const client = h.clients[0] as StageClient; assert.equal(client.status, 'disconnected');
      fake(client, async () => { reads++; return stats(); });
      h.node('connection-stats-panel').hidden = false; h.node('connection-stats-update').disabled = false; refresh(h);
    }
  } });
  const first = await join(h); assert.equal(early, 1); assert.equal(reads, 0); hidden(h);
  first.client['setStatus']('waiting'); first.client['setStatus']('live'); hidden(h); assert.equal(reads, 0);
  h.leave.click(); await flush(); const next = await join(h); fake(next.client, async () => { reads++; return stats(.088); });
  assert.equal(text(h), INITIAL); refresh(h); await flush(); assert.equal(reads, 1); assert.match(text(h), /88 ms/);
});
it('cancelling initial entry retires captured binding before late old state and admits only a genuine new entry', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const client = h.clients[0] as StageClient; let reads = 0;
  fake(client, async () => { reads++; return stats(); }); hidden(h); refresh(h); h.node('cancel-join').invoke(); await flush();
  assert.equal(client.status, 'disconnected'); client['snapshot'] = state(); client['currentStatus'] = 'live';
  client.dispatchEvent(new CustomEvent('state', { detail: client.state })); client.dispatchEvent(new CustomEvent('status', { detail: 'live' }));
  h.node('connection-stats-panel').hidden = false; h.node('connection-stats-update').disabled = false; refresh(h); await flush(); assert.equal(reads, 0); hidden(h);
  const newer = await join(h); fake(newer.client, async () => { reads++; return stats(.067); }); refresh(h); await flush(); assert.equal(reads, 1); assert.match(text(h), /67 ms/);
});
for (const member of ['connection-stats-update', 'connection-stats-text']) it(`pending result cannot survive detached ${member} or seed reattached history`, async t => {
  const { h, client } = await setup(t), old = Promise.withResolvers<unknown>(); fake(client, () => old.promise); refresh(h);
  h.node(member).remove(); old.resolve(stats(.999)); await flush(); hidden(h);
  h.node('connection-stats-panel').append(h.node(member)); client['setStatus']('waiting'); assert.equal(text(h), INITIAL);
  fake(client, async () => stats(.033)); refresh(h); await flush(); assert.match(text(h), /33 ms/); assert.doesNotMatch(text(h), /999/);
});
for (const action of ['close', 'transfer']) for (const loss of ['reconnecting', 'disconnected', 'room', 'participant'])
  for (const restoreAt of [2, 3]) it(`observed ${loss} on read1, restored on read${restoreAt}, permanently retires old ${action} consent`, async t => {
    let inspect = () => {};
    const { h, client } = await controller(t, { confirm: () => { inspect(); return true; } });
    const close = t.mock.method(client, 'closeRoom', async () => {}), handover = t.mock.method(client, 'transferControl', async () => {});
    const target = loss === 'room' ? client.state! : loss === 'participant' ? client.state!.me : client;
    const property = loss === 'room' ? 'roomId' : loss === 'participant' ? 'participantId' : 'status';
    const original = Reflect.get(target, property); let value = original, armed = false, reads = 0;
    Object.defineProperty(target, property, { configurable: true, get() { if (armed && ++reads === restoreAt) value = original; return value; } });
    Object.defineProperty(client, 'getStats', { configurable: true, get() {
      value = loss === 'room' || loss === 'participant' ? 'different-identity' : loss; reads = 0; armed = true;
      return async () => stats();
    } });
    inspect = () => refresh(h); (action === 'close' ? h.node('close-room') : transfer(h)).click(); await flush();
    assert.ok(reads >= restoreAt); assert.equal(close.mock.callCount(), 0); assert.equal(handover.mock.callCount(), 0);
    if (property === 'status') Reflect.deleteProperty(target, property); else Object.defineProperty(target, property, { configurable: true, writable: true, value: original });
  });
for (const action of ['close', 'transfer']) it(`observed loss with no stats owner still retires old ${action} consent`, async t => {
  let inspect = () => {};
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8')
    + '\nconnectionStatsUpdate.onclick = () => { retireConnectionStats(); refreshConnectionStats(); };\n';
  const h = embedApp({ source, confirm: () => { inspect(); return true; } }); t.after(() => h.cleanup()); const sdk = await h.join();
  const s = state('controller'); s.speakers.push({ ...s.me, participantId: 'target', role: 'speaker', onStage: true });
  sdk.state = s; sdk.me = s.me; sdk.emit('state', s); let value = sdk.status, armed = false, reads = 0;
  Object.defineProperty(sdk, 'status', { configurable: true, get() { if (armed && ++reads === 2) value = 'live'; return value; }, set(next) { value = next; } });
  inspect = () => { value = 'reconnecting'; armed = true; h.node('connection-stats-update').invoke(); };
  const handover = h.node('stage-management-list').children[0]!.children[1]!.children[2]!;
  (action === 'close' ? h.node('close-room') : handover).click(); await flush(); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
});
for (const action of ['close', 'transfer']) it(`older status value cannot invalidate a fresh actual SDK ${action} token created in that getter`, async t => {
  const { h, client } = await controller(t, { confirm: () => true }), work = Promise.withResolvers<void>(); fake(client, async () => stats());
  const command = t.mock.method(client, action === 'close' ? 'closeRoom' : 'transferControl', () => work.promise);
  const original = Object.getOwnPropertyDescriptor(StageClient.prototype, 'status')!; let armed = true;
  Object.defineProperty(client, 'status', { configurable: true, get() {
    if (!armed) return original.get!.call(client);
    armed = false; (action === 'close' ? h.node('close-room') : transfer(h)).click(); return 'reconnecting';
  } });
  refresh(h); await flush(); assert.equal(command.mock.callCount(), 1); assert.equal(h.confirmations.length, 1);
  work.reject(new Error('fresh authorized action failed')); await flush(); assert.match(h.node('last-error').textContent, /fresh authorized action failed/);
  Reflect.deleteProperty(client, 'status');
});
for (const action of ['close', 'transfer']) it(`old identity getter starting a genuine new entry cannot invalidate its later fresh ${action} consent`, async t => {
  const { h, client } = await controller(t, { confirm: () => true }); fake(client, async () => stats());
  const original = Object.getOwnPropertyDescriptor(StageClient.prototype, 'state')!; let armed = true;
  Object.defineProperty(client, 'state', { configurable: true, get() {
    const value: unknown = original.get!.call(client);
    if (armed) { armed = false; h.form.submit(); }
    return value;
  } });
  refresh(h); await flush(); Reflect.deleteProperty(client, 'state');
  const next = h.clients.at(-1) as StageClient; assert.notEqual(next, client); const socket = StageSocket.instances.at(-1)!; hello(socket);
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'new entry join');
  const s = state('controller'); s.speakers.push({ ...s.me, participantId: 'target', role: 'speaker', onStage: true });
  socket.deliver({ type: 'room:state', ...s }); socket.deliver({ type: 'ok', requestId: socket.sent.find(m => m.type === 'join')!.requestId }); await h.tick(20);
  const work = Promise.withResolvers<void>(); const command = t.mock.method(next, action === 'close' ? 'closeRoom' : 'transferControl', () => work.promise);
  fake(next, async () => stats(.062)); refresh(h); await flush(); assert.match(text(h), /62 ms/);
  (action === 'close' ? h.node('close-room') : transfer(h)).click(); assert.equal(command.mock.callCount(), 1);
  work.reject(new Error('new entry authorized action failed')); await flush(); assert.match(h.node('last-error').textContent, /new entry authorized action failed/);
});
