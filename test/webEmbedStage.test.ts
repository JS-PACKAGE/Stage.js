import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, EmbedNode, embedApp, flush, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket, StagePeer, StageContext } from './fixtures/embedSdkApp.ts';
import { harness, RECVONLY_OFFER, SENDRECV_OFFER, testConfig, type Harness } from './helpers.ts';

const latest = (sdk: EmbedSdk): Deferred => { const action = sdk.actions.at(-1); assert.ok(action); return action.work; };
function assertStage(stage: EmbedNode, expected: { hidden?: boolean; disabled?: boolean; busy?: boolean; returning?: boolean }): void {
  if (expected.hidden !== undefined) assert.equal(stage.hidden, expected.hidden);
  if (expected.disabled !== undefined) assert.equal(stage.disabled, expected.disabled);
  if (expected.busy !== undefined) assert.equal(stage.attributes['aria-busy'], String(expected.busy));
  if (expected.returning !== undefined) assert.equal(stage.textContent, expected.returning ? '返回舞台' : '離開舞台');
  assert.equal(stage.attributes['aria-pressed'], undefined, 'this is a native action, not a state toggle');
}
function forceInvoke(stage: EmbedNode): void { stage.hidden = stage.disabled = false; stage.invoke(); }

it('whole embed provides an initially hidden native personal stage action with its visible accessible name', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const button = html.match(/<button\b[^>]*\bid="stage"[^>]*>[^<]*<\/button>/)?.[0];
  assert.ok(button, 'embed participants need a personal stage action');
  for (const attribute of ['type="button"', 'aria-busy="false"', 'hidden', 'disabled']) assert.ok(button.includes(attribute), attribute);
  assert.match(button, />離開舞台<\/button>$/);
  assert.doesNotMatch(button, /aria-(?:pressed|label)=|tabindex=/, 'native semantics and current visible action supply the accessible name');
});

it('whole embed hides stage actions before join, before a snapshot, and for offstage noncontrollers', async t => {
  const h = embedApp(); t.after(() => h.cleanup());
  assertStage(h.stage, { hidden: true, disabled: true, busy: false }); forceInvoke(h.stage); assert.equal(h.clients.length, 0);
  h.form.submit(); await flush(); const sdk = h.clients[0]!;
  forceInvoke(h.stage); assertStage(h.stage, { hidden: true, disabled: true }); assert.equal(sdk.actions.length, 0);
  for (const role of ['audience', 'speaker'] as const) {
    sdk.snapshot({ role, onStage: false }); forceInvoke(h.stage);
    assertStage(h.stage, { hidden: true, disabled: true, busy: false }); assert.equal(sdk.actions.length, 0);
  }
  assert.equal(h.clock.timers.length, 0);
});

for (const role of ['speaker', 'controller'] as const) for (const forceMuted of [false, true]) {
  it(`whole embed lets ${forceMuted ? 'force-muted' : 'unmuted'} onstage ${role} step down`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role, onStage: true, forceMuted, muted: forceMuted });
    assertStage(h.stage, { hidden: false, disabled: false, busy: false, returning: false });
    h.stage.click(); assert.equal(sdk.actions[0]!.type, 'leaveStage'); assert.equal(sdk.me!.onStage, true);
    assertStage(h.stage, { disabled: true, busy: true }); h.stage.invoke(); sdk.snapshot(); sdk.setStatus('live'); forceInvoke(h.stage);
    assert.equal(sdk.actions.length, 1); assert.equal(h.clock.timers.length, 0);
    sdk.snapshot({ role: role === 'controller' ? 'controller' : 'audience', onStage: false, forceMuted: false, muted: false });
    assertStage(h.stage, { hidden: role !== 'controller', disabled: true, busy: true, returning: role === 'controller' });
    forceInvoke(h.stage); assert.equal(sdk.actions.length, 1, 'the next action stays locked even when state precedes ACK');
    latest(sdk).resolve(); await flush();
    assertStage(h.stage, { hidden: role !== 'controller', disabled: role !== 'controller', busy: false, returning: role === 'controller' });
    if (role === 'controller') { h.stage.click(); assert.equal(sdk.actions[1]!.type, 'returnToStage'); }
    else { forceInvoke(h.stage); assert.equal(sdk.actions.length, 1); assert.equal(h.hand.disabled, false); }
  });
}

it('whole embed returning controller changes label on state but waits for ACK before allowing another action', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
  assertStage(h.stage, { hidden: false, disabled: false, returning: true }); h.stage.click();
  assert.equal(sdk.actions[0]!.type, 'returnToStage'); assert.equal(sdk.me!.onStage, false);
  sdk.snapshot({ onStage: true }); assertStage(h.stage, { disabled: true, busy: true, returning: false });
  forceInvoke(h.stage); assert.equal(sdk.actions.length, 1); latest(sdk).resolve(); await flush();
  assertStage(h.stage, { disabled: false, busy: false, returning: false }); h.stage.click(); assert.equal(sdk.actions[1]!.type, 'leaveStage');
});

for (const onStage of [false, true]) {
  it(`whole embed stage ACK alone leaves authoritative onStage=${onStage} unchanged`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage });
    h.stage.click(); latest(sdk).resolve(); await flush();
    assert.equal(sdk.me!.onStage, onStage); assertStage(h.stage, { disabled: false, busy: false, returning: !onStage });
  });
  for (const synchronous of [false, true]) {
    it(`whole embed ${onStage ? 'leave' : 'return'} ${synchronous ? 'throw' : 'rejection'} displays an error and allows retry`, async t => {
      const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage });
      const method = onStage ? 'leaveStage' : 'returnToStage', original = sdk[method].bind(sdk); let attempts = 0;
      if (synchronous) sdk[method] = () => { if (++attempts === 1) throw new Error('舞台操作失敗，請重試。'); return original(); };
      h.stage.click(); if (!synchronous) latest(sdk).reject('舞台操作失敗，請重試。'); await flush();
      assert.equal(h.status.textContent, '舞台操作失敗，請重試。');
      assertStage(h.stage, { disabled: false, busy: false, returning: !onStage }); assert.equal(sdk.me!.onStage, onStage);
      const count = sdk.actions.length; h.stage.click(); assert.equal(sdk.actions.length, count + 1); assert.equal(sdk.actions.at(-1)!.type, method);
    });
  }
}

it('whole embed stage handler rechecks current role, stage and reconnect state after DOM tampering', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage: true });
  sdk.me!.onStage = false; h.stage.invoke(); assert.equal(sdk.actions[0]!.type, 'returnToStage'); latest(sdk).resolve(); await flush();
  sdk.me!.role = 'audience'; forceInvoke(h.stage); assertStage(h.stage, { hidden: true, disabled: true });
  sdk.me!.role = 'controller'; sdk.status = 'reconnecting'; forceInvoke(h.stage);
  assertStage(h.stage, { hidden: false, disabled: true, returning: true }); assert.equal(sdk.actions.length, 1);
  sdk.setStatus('waiting'); assertStage(h.stage, { disabled: false }); h.stage.click(); assert.equal(sdk.actions.length, 2);
});

it('whole embed same-client reconnect preserves stage pending until settlement and recovers on status alone', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage: true });
  h.stage.click(); sdk.setStatus('reconnecting'); sdk.snapshot({ onStage: false });
  assertStage(h.stage, { disabled: true, busy: true, returning: true }); sdk.setStatus('waiting'); forceInvoke(h.stage);
  assert.equal(sdk.actions.length, 1); sdk.setStatus('reconnecting'); latest(sdk).reject('連線中斷。'); await flush();
  assertStage(h.stage, { disabled: true, busy: false }); forceInvoke(h.stage); assert.equal(sdk.actions.length, 1);
  sdk.setStatus('waiting'); assertStage(h.stage, { disabled: false }); h.stage.click(); assert.equal(sdk.actions[1]!.type, 'returnToStage');
});

for (const first of ['microphone', 'stage'] as const) {
  it(`whole embed keeps ${first}-first operation ownership independent`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage: true });
    const firstNode = first === 'microphone' ? h.mic : h.stage, secondNode = first === 'microphone' ? h.stage : h.mic;
    firstNode.click(); assert.equal(secondNode.disabled, false); secondNode.click();
    const mute = sdk.actions.find(action => action.type === 'mute')!, stepdown = sdk.actions.find(action => action.type === 'leaveStage')!;
    assert.equal(sdk.actions.length, 2); assert.equal(h.mic.attributes['aria-busy'], 'true'); assertStage(h.stage, { busy: true, disabled: true });
    sdk.snapshot({ onStage: false }); stepdown.work.resolve(); await flush();
    assert.equal(h.mic.attributes['aria-busy'], 'true'); assertStage(h.stage, { busy: false, disabled: false, returning: true });
    h.stage.click(); const active = latest(sdk); mute.work.reject('麥克風操作已取消。'); await flush();
    assertStage(h.stage, { busy: true, disabled: true }); assert.equal(h.mic.attributes['aria-busy'], 'false');
    active.resolve(); await flush(); assertStage(h.stage, { busy: false, disabled: false });
  });
}

for (const terminal of ['disconnected', 'closed', 'kicked'] as const) for (const reject of [false, true]) {
  it(`whole embed ${terminal} retires stage ${reject ? 'rejection' : 'ACK'} and blocks stale snapshots`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage: true });
    h.stage.click(); const work = latest(sdk);
    if (terminal === 'disconnected') sdk.setStatus(terminal); else sdk.emit(terminal, { roomId: 'same-room' });
    assertStage(h.stage, { hidden: true, disabled: true, busy: false }); const status = h.status.textContent;
    if (reject) work.reject('retired stage error'); else work.resolve(); await flush(); assert.equal(h.status.textContent, status);
    sdk.snapshot({ onStage: true }); sdk.setStatus('live'); forceInvoke(h.stage);
    assertStage(h.stage, { hidden: true, disabled: true, busy: false }); assert.equal(sdk.actions.length, 1);
  });
}

for (const leave of [false, true]) for (const reject of [false, true]) {
  it(`whole embed ${leave ? 'leave and rejoin' : 'replacement join'} ignores retired stage ${reject ? 'rejection' : 'ACK'}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join({ role: 'controller', onStage: true });
    h.stage.click(); const retired = latest(old); if (leave) { h.leave.click(); await flush(); }
    const current = await h.join({ role: 'controller' }); h.stage.click(); const active = latest(current), status = h.status.textContent;
    if (reject) retired.reject('retired stage failure'); else retired.resolve(); await flush();
    old.snapshot({ onStage: true }); old.setStatus('disconnected'); old.emit('closed', {}); old.emit('kicked', {});
    assert.equal(h.status.textContent, status); assertStage(h.stage, { hidden: false, disabled: true, busy: true, returning: true });
    forceInvoke(h.stage); assert.equal(current.actions.length, 1); assert.equal(old.actions.length, 1);
    current.snapshot({ onStage: true }); active.resolve(); await flush(); assertStage(h.stage, { disabled: false, busy: false, returning: false });
  });
}

for (const replacement of [false, true]) {
  it(`whole embed ${replacement ? 'replacement join' : 'leave'} revokes stage actions before disconnect settles`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage: true });
    const disconnect = sdk.disconnect.bind(sdk), gate = new Deferred(); sdk.disconnect = async () => { await gate.promise; await disconnect(); };
    t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); });
    h.stage.click(); const retired = latest(sdk); if (replacement) h.form.submit(); else h.leave.click();
    assertStage(h.stage, { hidden: true, disabled: true, busy: false }); forceInvoke(h.stage);
    sdk.snapshot({ onStage: false }); sdk.setStatus('reconnecting'); sdk.setStatus('live'); forceInvoke(h.stage);
    assertStage(h.stage, { hidden: true, disabled: true, busy: false }); assert.equal(sdk.actions.length, 1);
    const status = h.status.textContent; retired.reject('retired failure'); await flush(); assert.equal(h.status.textContent, status);
    gate.resolve(); await flush(); assertStage(h.stage, { hidden: true, disabled: true });
  });
}

function applyState(sdk: EmbedSdk, state: RoomStatePayload): void { sdk.me = state.me; sdk.emit('state', state); }
it('whole embed actual Hub successor returns with eight retained speakers and keeps controller privileges after stepping down', async t => {
  const config = testConfig(c => { c.limits.maxSpeakersPerRoom = 8; c.rooms.qualityIntervalMs = 0; c.rooms.controllerGraceMs = 60_000; c.rooms.participantGraceMs = 15_000; });
  const hub = harness(config), h = embedApp(); t.after(() => h.cleanup());
  t.after(async () => { await hub.hub.shutdown(); assert.equal(hub.hub.roomCount, 0); assert.equal(hub.transport.rooms.size, 0); assert.equal(hub.timers.filter(timer => !timer.cleared).length, 0); });
  const host = await hub.create(); await hub.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
  const audience = await hub.join(host.roomId, host.code, 'Next controller'); await hub.req(audience.s, { type: 'rtc:offer', payload: RECVONLY_OFFER });
  const speakers: Awaited<ReturnType<Harness['join']>>[] = [];
  for (let i = 0; i < 8; i++) {
    hub.clock.now++; const person = await hub.join(host.roomId, host.code, `Speaker ${i}`);
    assert.equal(await hub.req(person.s, { type: 'hand:raise' }), 'ok');
    assert.equal(await hub.req(host.s, { type: 'stage:approve', targetId: person.id }), 'ok');
    assert.equal(await hub.req(person.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok'); speakers.push(person);
  }
  const sdk = await h.join(audience.s.last('room:state')!.me); assertStage(h.stage, { hidden: true });
  await hub.hub.detach(host.s); const expiry = hub.timers.find(timer => !timer.cleared && timer.ms === config.rooms.controllerGraceMs); assert.ok(expiry);
  hub.clock.now += 52_500; for (const person of speakers) await hub.hub.detach(person.s); hub.clock.now += 7500;
  const peer = hub.transport.rooms.get(host.roomId)!.peers.get(audience.id);
  const retained = speakers.map(person => hub.transport.rooms.get(host.roomId)!.peers.get(person.id));
  expiry.cleared = true; expiry.fn(); await nextTurn();
  const promoted = audience.s.last('room:state')!; assert.equal(promoted.me.role, 'controller'); assert.equal(promoted.me.onStage, false);
  assert.equal(promoted.speakers.length, 8); assert.ok(promoted.speakers.every(person => !person.connected));
  applyState(sdk, promoted); assertStage(h.stage, { hidden: false, disabled: false, returning: true }); assert.equal(h.hand.disabled, true);
  h.stage.click(); assert.equal(sdk.actions[0]!.type, 'returnToStage');
  assert.equal(await hub.req(audience.s, { type: 'stage:approve', targetId: audience.id }), 'ok', 'the controller owns its extra seat and does not raise a hand');
  const returned = audience.s.last('room:state')!; assert.equal(returned.me.onStage, true); assert.equal(returned.me.role, 'controller');
  assert.equal(returned.speakers.filter(person => person.role === 'speaker').length, 8);
  applyState(sdk, returned); assertStage(h.stage, { disabled: true, busy: true, returning: false }); latest(sdk).resolve(); await flush();
  assert.equal(await hub.req(audience.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  h.stage.click(); assert.equal(sdk.actions[1]!.type, 'leaveStage'); assert.equal(await hub.req(audience.s, { type: 'stage:leave' }), 'ok');
  const offstage = audience.s.last('room:state')!; applyState(sdk, offstage); latest(sdk).resolve(); await flush();
  assert.equal(offstage.controllerId, audience.id); assert.equal(offstage.me.role, 'controller'); assert.equal(offstage.me.onStage, false);
  assert.equal(offstage.code, host.code); assert.ok(offstage.audience); assertStage(h.stage, { disabled: false, returning: true });
  assert.equal(await hub.req(audience.s, { type: 'hand:raise' }), 'conflict');
  assert.equal(await hub.req(audience.s, { type: 'mic:force-mute', targetId: speakers[0]!.id }), 'ok', 'offstage controller retains moderation');
  assert.equal(await hub.req(audience.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'forbidden', 'offstage status still denies publishing');
  const extra = await hub.join(host.roomId, host.code, 'Waiting audience'); assert.equal(await hub.req(extra.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await hub.req(audience.s, { type: 'stage:approve', targetId: extra.id }), 'stage_full', 'ordinary speaker capacity is unchanged');
  assert.equal(await hub.req(extra.s, { type: 'stage:approve', targetId: extra.id }), 'forbidden', 'audience cannot self-approve');
  assert.equal(hub.transport.rooms.get(host.roomId)!.peers.get(audience.id), peer);
  assert.deepEqual(speakers.map(person => hub.transport.rooms.get(host.roomId)!.peers.get(person.id)), retained);
  assert.equal(h.clock.timers.length, 0);
});

it('whole embed actual SDK stage actions release capture before ACK, retain receiving peer, and reacquire fresh capture on controller return', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join(); assert.equal(h.tracks.length, 0);
  const returning = await h.command(socket, 'stage:approve'); assert.equal(returning.type, 'stage:approve');
  if (returning.type === 'stage:approve') assert.equal(returning.targetId, 'guest');
  assert.equal(h.tracks.length, 0, 'clicking return does not optimistically capture');
  socket.deliver({ type: 'room:state', ...actualState({ onStage: true, muted: true, forceMuted: true }) });
  await h.until(() => h.tracks.length === 1 && peer.transceiver.sender.track !== null && peer.signalingState === 'stable', 'accepted stage capture');
  const first = h.tracks[0]!; assert.equal(first.enabled, false); assertStage(h.stage, { busy: true, disabled: true, returning: false });
  socket.deliver({ type: 'ok', requestId: returning.requestId }); await flush(); assertStage(h.stage, { disabled: false, busy: false });
  assert.equal(h.mic.disabled, true); const leaving = await h.command(socket, 'stage:leave');
  assert.equal(first.stopped, false, 'the command alone does not fabricate an offstage state');
  socket.deliver({ type: 'room:state', ...actualState() });
  assert.equal(first.stopped, true, 'snapshot synchronously retires room capture before UI sees offstage');
  assert.equal(StageContext.instances.length, 0, 'the compact embed explicitly disables unused room metering'); assertStage(h.stage, { busy: true, disabled: true, returning: true });
  assert.equal(h.mic.hidden, true); assert.equal(socket.readyState, StageSocket.OPEN); assert.equal(peer.connectionState, 'connected');
  const requests = socket.sent.filter(message => message.type === 'stage:approve').length; forceInvoke(h.stage); await h.tick();
  assert.equal(socket.sent.filter(message => message.type === 'stage:approve').length, requests);
  socket.deliver({ type: 'ok', requestId: leaving.requestId }); await flush();
  await h.until(() => peer.transceiver.direction === 'recvonly' && peer.transceiver.sender.track === null && peer.signalingState === 'stable', 'receive-only negotiation');
  const reentry = await h.command(socket, 'stage:approve'); socket.deliver({ type: 'room:state', ...actualState({ onStage: true }) });
  socket.deliver({ type: 'ok', requestId: reentry.requestId });
  await h.until(() => h.tracks.length === 2 && peer.transceiver.sender.track === h.tracks[1], 'fresh capture after reentry');
  assert.equal(first.stopped, true); assert.equal(h.tracks[1]!.stopped, false); assert.equal(h.tracks[1]!.enabled, true);
  assert.equal(StagePeer.instances.length, 1); assert.equal(h.clients.length, 1);
});

for (const reject of [false, true]) it(`whole embed actual SDK ignores late stage ${reject ? 'error' : 'ACK'} after room leave and rejoin`, async t => {
  const h = await actualApp(t), { socket } = await h.join(); const retired = await h.command(socket, 'stage:approve');
  h.leave.click(); await flush(); assertStage(h.stage, { hidden: true, disabled: true, busy: false }); assert.equal(socket.readyState, 3);
  const { socket: current } = await h.join(); const active = await h.command(current, 'stage:approve'), status = h.status.textContent;
  if (reject) socket.deliver({ type: 'error', requestId: retired.requestId, code: 'forbidden', message: 'retired error' });
  else socket.deliver({ type: 'ok', requestId: retired.requestId }); await flush();
  assert.equal(h.status.textContent, status); assertStage(h.stage, { hidden: false, disabled: true, busy: true, returning: true });
  current.deliver({ type: 'error', requestId: active.requestId, code: 'forbidden', message: '禁止此操作。' }); await flush();
  assert.equal(h.status.textContent, '禁止此操作。'); assertStage(h.stage, { disabled: false, busy: false, returning: true });
  const retry = await h.command(current, 'stage:approve'); current.deliver({ type: 'ok', requestId: retry.requestId }); await flush();
  assertStage(h.stage, { disabled: false, busy: false, returning: true }); assert.equal(h.tracks.length, 0);
});
