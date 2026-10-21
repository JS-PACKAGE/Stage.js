import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, embedApp, flush } from './fixtures/embedApp.ts';
import type { EmbedNode, EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageContext, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { harness, testConfig } from './helpers.ts';

// Whole production embed and public SDK; controlled boundaries do not model native AT or audible playback.
const MESSAGE = '主控已婉拒這次舉手申請。';
interface View { node(id: string): EmbedNode }
const notice = (h: View) => h.node('hand-rejected');
function shown(h: View): void { assert.equal(notice(h).hidden, false); assert.equal(notice(h).textContent, MESSAGE); }
function hidden(h: View): void { assert.equal(notice(h).hidden, true); assert.equal(notice(h).textContent, ''); }
function reject(sdk: EmbedSdk): void { sdk.emit('handrejected', { roomId: sdk.state!.roomId, participantId: sdk.me!.participantId }); }
function snapshot(sdk: EmbedSdk, patch: { roomId?: string; me?: Partial<ParticipantView> } = {}): void {
  assert.ok(sdk.state); assert.ok(sdk.me); sdk.state = { ...sdk.state, ...patch, me: { ...sdk.me, ...patch.me } };
  sdk.me = sdk.state.me; sdk.emit('state', sdk.state);
}
function synthetic(client: unknown, roomId = 'same-room', participantId = 'guest'): void {
  (client as EventTarget).dispatchEvent(new CustomEvent('handrejected', { detail: { roomId, participantId } }));
}

it('embed HTML provides a separate initially hidden ordinary status paragraph', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  assert.equal((html.match(/id="hand-rejected"/g) ?? []).length, 1);
  const paragraph = html.match(/<p\b[^>]*\bid="hand-rejected"[^>]*><\/p>/)?.[0]; assert.ok(paragraph);
  assert.match(paragraph, /\bhidden(?:\s|>)/); assert.match(paragraph, /\brole="status"/); assert.doesNotMatch(paragraph, /alert|error/);
  assert.ok(html.indexOf(paragraph) > html.indexOf('</form>'));
});

it('whole embed rejection is safe separate text and preserves errors, main status, buttons and timer ownership', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); hidden(h); const sdk = await h.join();
  Object.defineProperty(notice(h), 'innerHTML', { set() { assert.fail('rejection must use textContent'); } });
  sdk.emit('error', new Error('Keep unrelated error')); const status = h.status.textContent, timers = h.clock.timers;
  const controls = { hand: h.hand.textContent, disabled: h.hand.disabled, mic: h.mic.hidden, stage: h.stage.hidden };
  reject(sdk); shown(h); assert.equal(h.status.textContent, status);
  assert.equal(h.node('last-error').textContent, '最近錯誤：Keep unrelated error'); assert.equal(h.node('error-notice').hidden, false);
  assert.deepEqual({ hand: h.hand.textContent, disabled: h.hand.disabled, mic: h.mic.hidden, stage: h.stage.hidden }, controls);
  const writes = notice(h).writes.textContent;
  for (let i = 0; i < 5; i++) snapshot(sdk); shown(h); h.tick(1000); shown(h);
  assert.equal(notice(h).writes.textContent, writes, 'identical status text is not rewritten');
  assert.deepEqual(h.clock.timers, timers); assert.equal(sdk.actions.length, 0); assert.equal(sdk.retryCalls, 0);
  h.node('error-dismiss').click(); shown(h); assert.equal(h.node('error-notice').hidden, true);
});

it('whole embed generic withdrawal, old-server snapshots and invalid synthetic details never imply rejection', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
  sdk.emit('hand', { participantId: 'listener', raised: false }); hidden(h); sdk.snapshot({ handRaised: false }); hidden(h);
  for (const detail of [null, undefined, {}, { roomId: 'other', participantId: 'listener' }, { roomId: 'same-room', participantId: 'other' }]) {
    sdk.emit('handrejected', detail); hidden(h);
  }
  snapshot(sdk); hidden(h); assert.equal(sdk.actions.length, 0);
});

for (const overrides of [{ handRaised: true }, { onStage: true }, { role: 'controller' as const }, { role: 'speaker' as const }]) {
  it(`whole embed rejects ineligible feedback for ${JSON.stringify(overrides)} and clears when eligibility is lost`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(overrides); reject(sdk); hidden(h);
    sdk.snapshot({ role: 'audience', onStage: false, handRaised: false }); reject(sdk); shown(h);
    snapshot(sdk, { me: overrides }); hidden(h); sdk.snapshot({ role: 'audience', onStage: false, handRaised: false }); hidden(h);
  });
}
for (const identity of ['room', 'participant'] as const) {
  it(`whole embed copies payload ownership and retires changed ${identity} without replay on return`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(), payload = { roomId: 'same-room', participantId: 'listener' };
    sdk.emit('handrejected', payload); shown(h); payload.roomId = payload.participantId = 'mutated'; snapshot(sdk); shown(h);
    snapshot(sdk, identity === 'room' ? { roomId: 'other' } : { me: { participantId: 'other' } }); hidden(h);
    snapshot(sdk, { roomId: 'same-room', me: { participantId: 'listener' } }); hidden(h); reject(sdk); shown(h);
  });
}

it('whole embed pending and failed raise preserve feedback until own raised hand arrives', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(); reject(sdk); h.hand.click(); shown(h);
  assert.equal(sdk.actions.length, 1); assert.equal(h.hand.attributes['aria-busy'], 'true'); sdk.actions[0]!.work.reject('Raise failed'); await flush(); shown(h);
  assert.equal(h.node('last-error').textContent, '最近錯誤：Raise failed');
  sdk.emit('hand', { participantId: 'other', raised: true }); shown(h); sdk.emit('hand', { participantId: 'listener', raised: false }); shown(h);
  sdk.emit('hand', { participantId: 'listener', raised: true }); hidden(h); snapshot(sdk); hidden(h);
  reject(sdk); shown(h); sdk.snapshot({ handRaised: true }); hidden(h); sdk.snapshot({ handRaised: false }); hidden(h);
});
for (const event of ['stagejoined', 'role', 'transferred'] as const) {
  it(`whole embed own ${event} clears feedback before the next snapshot`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(); reject(sdk);
    const detail = event === 'transferred' ? { fromId: 'host', toId: 'listener' } : { participantId: 'listener', role: 'speaker' };
    sdk.emit(event, detail); hidden(h); snapshot(sdk); hidden(h);
  });
}
for (const terminal of ['leave', 'disconnected', 'closed', 'shutdown', 'kicked', 'submit'] as const) {
  it(`whole embed ${terminal} retires feedback and old callbacks cannot contaminate fresh same-ID entry`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join(); reject(old); shown(h);
    if (terminal === 'leave') h.leave.click(); else if (terminal === 'disconnected') old.setStatus('disconnected');
    else if (terminal === 'submit') h.form.submit(); else old.emit(terminal === 'shutdown' ? 'closed' : terminal, { reason: terminal === 'shutdown' ? 'shutdown' : undefined });
    hidden(h); old.emit('handrejected', { roomId: 'same-room', participantId: 'listener' }); hidden(h); await flush();
    const sdk = await h.join(); hidden(h); reject(sdk); shown(h);
    for (const [type, detail] of [['handrejected', { roomId: 'same-room', participantId: 'listener' }], ['hand', { participantId: 'listener', raised: true }],
      ['stagejoined', { participantId: 'listener' }], ['role', { participantId: 'listener', role: 'controller' }], ['transferred', { toId: 'listener' }]] as const) {
      old.emit(type, detail); shown(h);
    }
  });
}

it('whole embed reconnect clears feedback permanently until a fresh explicit rejection', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(); reject(sdk); sdk.setStatus('reconnecting'); hidden(h);
  reject(sdk); hidden(h); sdk.setStatus('waiting'); snapshot(sdk); hidden(h); reject(sdk); shown(h);
});
for (const terminal of ['leave', 'submit'] as const) for (const result of ['resolve', 'reject'] as const) {
  it(`whole embed ${terminal} clears before awaited disconnect and ignores old hand ${result}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(), gate = new Deferred(); reject(sdk); h.hand.click();
    const work = sdk.actions[0]!.work, disconnect = sdk.disconnect.bind(sdk); sdk.disconnect = async () => { await gate.promise; await disconnect(); };
    t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); });
    if (terminal === 'leave') h.leave.click(); else h.form.submit(); hidden(h); reject(sdk); hidden(h); snapshot(sdk); hidden(h);
    if (result === 'resolve') work.resolve(); else work.reject('Retired hand failure'); await flush(); hidden(h);
    assert.doesNotMatch(h.node('last-error').textContent, /Retired hand failure/); gate.resolve(); await flush();
    const fresh = await h.join(); hidden(h); reject(fresh); shown(h);
  });
}
for (const transition of ['raised and withdrawn', 'room and back', 'reconnect and recover', 'leave'] as const) {
  it(`whole embed nested ${transition} callbacks cannot restore retired feedback`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(); let active = true;
    sdk.on('handrejected', () => {
      if (!active) return;
      if (transition === 'raised and withdrawn') { sdk.snapshot({ handRaised: true }); sdk.snapshot({ handRaised: false }); }
      else if (transition === 'room and back') { snapshot(sdk, { roomId: 'other' }); snapshot(sdk, { roomId: 'same-room' }); }
      else if (transition === 'reconnect and recover') { sdk.setStatus('reconnecting'); sdk.setStatus('waiting'); }
      else h.leave.click();
    });
    reject(sdk); hidden(h); active = false;
    if (transition !== 'leave') { reject(sdk); shown(h); }
  });
}

it('whole embed real SDK and Hub distinguish targeted rejection from generic withdrawal without media or control actions', async t => {
  const server = harness(testConfig(config => { config.rooms.qualityIntervalMs = 0; config.rooms.presenceBroadcastMs = 0; }));
  t.after(async () => { await server.hub.shutdown(); assert.equal(server.transport.rooms.size, 0); });
  const host = await server.create(), self = await server.join(host.roomId, host.code, 'Self'), other = await server.join(host.roomId, host.code, 'Other');
  await server.req(self.s, { type: 'hand:raise' }); const h = await actualApp(t), { socket, peer } = await h.join(self.s.last('room:state')!.me);
  socket.deliver(self.s.last('room:state')!); await flush(); hidden(h);
  const before = { sent: socket.sent.length, offers: [...peer.offers], peers: [...StagePeer.instances], volume: h.audio.volume, muted: h.audio.muted, plays: h.audio.plays, pauses: h.audio.pauses };
  let index = self.s.inbox.length; await server.req(self.s, { type: 'hand:withdraw' }); for (const message of self.s.inbox.slice(index)) socket.deliver(message); hidden(h);
  await server.req(self.s, { type: 'hand:raise' }); socket.deliver(self.s.last('room:state')!); hidden(h);
  index = self.s.inbox.length; await server.req(host.s, { type: 'stage:reject', targetId: self.id });
  const replies = self.s.inbox.slice(index); assert.ok(replies.some(message => message.type === 'hand:rejected'));
  for (const message of replies) { socket.deliver(message); if (message.type === 'hand:withdraw' || message.type === 'room:state') hidden(h); }
  shown(h); assert.equal(other.s.inbox.some(message => message.type === 'hand:rejected'), false);
  socket.deliver({ type: 'error', code: 'conflict', message: 'Preserved error' }); shown(h);
  assert.equal(h.node('last-error').textContent, '最近錯誤：Preserved error');
  socket.deliver(self.s.last('room:state')!); shown(h); assert.equal(h.node('hand').textContent, '舉手發言');
  socket.deliver({ type: 'hand:raise', participantId: self.id }); hidden(h); socket.deliver({ type: 'hand:withdraw', participantId: self.id }); hidden(h);
  synthetic(h.clients[0], host.roomId, self.id); shown(h);
  assert.equal(socket.sent.length, before.sent); assert.deepEqual(peer.offers, before.offers); assert.deepEqual(StagePeer.instances, before.peers);
  assert.equal(h.captures.length, 0); assert.equal(StageContext.instances.length, 0);
  assert.deepEqual({ volume: h.audio.volume, muted: h.audio.muted, plays: h.audio.plays, pauses: h.audio.pauses },
    { volume: before.volume, muted: before.muted, plays: before.plays, pauses: before.pauses });
});

it('whole embed real SDK reconnect never replays old feedback and retired sockets cannot restore it', async t => {
  const h = await actualApp(t), { socket } = await h.join({ role: 'audience' });
  socket.deliver({ type: 'hand:rejected', roomId: 'same-room', participantId: 'guest' }); shown(h); socket.close(); hidden(h);
  synthetic(h.clients[0]); hidden(h); await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  resumed.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => resumed.sent.some(message => message.type === 'join'), 'resume request'); const join = resumed.sent.find(message => message.type === 'join')!;
  resumed.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); resumed.deliver({ type: 'ok', requestId: join.requestId }); await flush(); hidden(h);
  socket.deliver({ type: 'hand:rejected', roomId: 'same-room', participantId: 'guest' }); hidden(h);
  resumed.deliver({ type: 'hand:rejected', roomId: 'same-room', participantId: 'guest' }); shown(h);
});

it('whole embed real pre-ACK disconnection retires feedback despite retained SDK state', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'join request');
  socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
  socket.deliver({ type: 'hand:rejected', roomId: 'same-room', participantId: 'guest' }); shown(h);
  const old = h.clients[0]!; socket.close(); await flush(); hidden(h); assert.equal(old.status, 'disconnected');
  assert.ok((old as unknown as { state: RoomStatePayload | null }).state); synthetic(old); hidden(h);
  await h.join({ role: 'audience' }); hidden(h); synthetic(h.clients.at(-1)); shown(h); synthetic(old); shown(h);
});
