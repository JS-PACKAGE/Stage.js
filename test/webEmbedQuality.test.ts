import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { StageClient } from '../packages/client/src/index.ts';
import type { ClientMessage, ServerMessage, RoomStatePayload, ParticipantView } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { embedApp, EmbedNode, EmbedSdk, flush, Deferred } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket, StagePeer, StageContext } from './fixtures/embedSdkApp.ts';
import { harness, testConfig, SENDRECV_OFFER } from './helpers.ts';

function person(id: string, role: ParticipantView['role'] = 'speaker', onStage = role !== 'audience'): ParticipantView {
  return { participantId: id, name: `Private ${id}`, role, onStage, handRaised: false, muted: false,
    forceMuted: false, connected: true, gainDb: 0, joinedAt: 1 };
}
function state(me: Partial<ParticipantView> = {}): RoomStatePayload {
  const own = { ...person('controller', 'controller'), ...me };
  return { roomId: 'same-room', name: 'Synthetic room', controllerId: 'controller',
    me: own, speakers: [...(own.onStage ? [own] : []), person('target')], hands: [], audienceCount: 0,
    limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', codeRequired: true,
    code: 'PRIVATE-CODE', resumeToken: 'PRIVATE-TOKEN' };
}
function publish(sdk: EmbedSdk, snapshot = state()): void { sdk.state = snapshot; sdk.me = snapshot.me; sdk.emit('state', snapshot); }
function report(rttMs = 37, participantId = 'controller') {
  return { participants: [{ participantId, uplinkLossPercent: 8, downlinkLossPercent: 2, rttMs }] };
}
function summary(uplink = '8.0%', downlink = '2.0%', rtt = '37 ms'): string {
  return `你的連線品質（最近收到）：上行掉包 ${uplink} · 下行掉包 ${downlink} · RTT ${rtt}（非端到端音訊延遲）`;
}
function shown(node: EmbedNode, text = summary()): void { assert.equal(node.hidden, false); assert.equal(node.textContent, text); }
function empty(node: EmbedNode): void { assert.equal(node.hidden, true); assert.equal(node.textContent, ''); }
function instrument(node: EmbedNode, hook: (property: 'textContent' | 'hidden') => void = () => {}) {
  const writes = { textContent: 0, hidden: 0 };
  for (const property of ['textContent', 'hidden'] as const) {
    let value = node[property];
    Object.defineProperty(node, property, { configurable: true, get: () => value, set(next: typeof value) {
      assert.notEqual(next, value, `equal ${property} must not be written`);
      value = next; writes[property]++; hook(property);
    } });
  }
  return writes;
}
async function setup(t: TestContext, options: Parameters<typeof embedApp>[0] = {}) {
  const app = embedApp(options); t.after(() => app.cleanup()); const sdk = await app.join();
  publish(sdk); return { app, sdk, node: app.node('own-connection-quality') };
}
function transfer(app: ReturnType<typeof embedApp>): EmbedNode {
  const button = app.node('stage-management-list').children[0]?.children[1]?.children[2]; assert.ok(button); return button;
}

it('embed quality authors one empty hidden ordinary paragraph and no automatic announcement', async t => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  assert.equal(html.match(/id="own-connection-quality"/g)?.length, 1);
  assert.match(html, /<p id="room-occupancy" hidden><\/p><p id="own-connection-quality" hidden><\/p>/);
  const app = embedApp(); t.after(() => app.cleanup()); const node = app.node('own-connection-quality');
  empty(node); await app.join(); empty(node); assert.deepEqual(node.attributes, {}); assert.equal(node.children.length, 0);
});
for (const role of ['controller', 'speaker', 'audience'] as const)
  for (const onStage of [true, false]) for (const status of ['waiting', 'live'] as const)
    it(`embed quality ${role}/${onStage}/${status} shows only an eligible own transport report`, async t => {
      const { sdk, node } = await setup(t); sdk.setStatus(status); publish(sdk, state({ role, onStage })); empty(node);
      sdk.emit('quality', report()); if (onStage && role !== 'audience') shown(node); else empty(node);
    });

const values: [string, unknown, string, string][] = [
  ['absent', undefined, '—', '—'], ['zero', 0, '0.0%', '0 ms'], ['fractional', 1.26, '1.3%', '1 ms'],
  ['round milliseconds', 36.6, '36.6%', '37 ms'], ['upper loss bound', 100, '100.0%', '100 ms'],
  ['negative', -0.1, '—', '—'], ['above loss bound', 100.1, '—', '100 ms'],
  ['infinity', Infinity, '—', '—'], ['negative infinity', -Infinity, '—', '—'], ['NaN', NaN, '—', '—'],
  ['numeric string', '2', '—', '—'], ['null', null, '—', '—'], ['boolean', false, '—', '—'],
  ['object', {}, '—', '—'], ['array', [], '—', '—'],
];
for (const [label, value, loss, rtt] of values) it(`embed quality validates primitive ${label} without coercion or clamping`, async t => {
  const { sdk, node } = await setup(t); sdk.emit('quality', report());
  sdk.emit('quality', { participants: [{ participantId: 'controller', uplinkLossPercent: value, downlinkLossPercent: value, rttMs: value }] });
  shown(node, summary(loss, loss, rtt));
});
for (const [label, detail] of [
  ['null', null], ['primitive', 'bad'], ['array envelope', []], ['missing participants', {}],
  ['object participants', { participants: {} }], ['null participants', { participants: null }],
  ['empty list', { participants: [] }], ['missing own', { participants: [{ participantId: 'private-other', rttMs: 999 }] }],
  ['nonexact own ID', { participants: [{ participantId: new String('controller'), rttMs: 999 }] }],
  ['duplicate own', { participants: [...report(11).participants, ...report(99).participants] }],
] as const) it(`embed quality ${label} clears its full replacement without altering errors or SDK`, async t => {
  const { app, sdk, node } = await setup(t); sdk.emit('quality', report());
  app.node('last-error').textContent = 'Existing failure'; app.node('error-notice').hidden = false;
  const identity = sdk.state, message = app.status.textContent; sdk.emit('quality', detail); empty(node);
  assert.equal(sdk.state, identity); assert.equal(app.status.textContent, message);
  assert.equal(app.node('last-error').textContent, 'Existing failure'); assert.equal(app.node('error-notice').hidden, false);
});
it('embed quality skips malformed and foreign entries without reading foreign metrics or private fields', async t => {
  const { sdk, node } = await setup(t), other = { participantId: 'private-other' };
  for (const key of ['uplinkLossPercent', 'downlinkLossPercent', 'rttMs', 'name', 'code', 'resumeToken'])
    Object.defineProperty(other, key, { get() { throw new Error(`private ${key}`); } });
  const own = Object.freeze(report().participants[0]!);
  const detail = Object.freeze({ participants: Object.freeze([null, false, 1, 'invalid', [], {}, other, own]) });
  sdk.emit('quality', detail); shown(node); assert.doesNotMatch(node.textContent, /private|controller|target|TOKEN|CODE/);
  sdk.emit('quality', { participants: [{ participantId: 'controller', downlinkLossPercent: 4 }] });
  shown(node, summary('—', '4.0%', '—'));
});
it('embed quality copies primitive history, coalesces equal values, and repairs different host-corrupted values', async t => {
  const { sdk, node } = await setup(t), detail = report(); sdk.emit('quality', detail); shown(node);
  const writes = instrument(node); detail.participants[0]!.rttMs = 999; detail.participants.length = 0;
  publish(sdk); sdk.setStatus('live'); sdk.emit('quality', detail); shown(node);
  for (let i = 0; i < 30; i++) { sdk.emit('quality', report()); publish(sdk); sdk.setStatus('waiting'); }
  assert.deepEqual(writes, { textContent: 0, hidden: 0 });
  node.textContent = 'host corruption'; node.hidden = true; sdk.emit('quality', report()); shown(node);
  assert.deepEqual(writes, { textContent: 2, hidden: 2 });
  sdk.emit('quality', report(51)); shown(node, summary('8.0%', '2.0%', '51 ms'));
});
it('embed quality records rejected receipts before state admission and preserves newest accepted history on replay', async t => {
  const app = embedApp(); t.after(() => app.cleanup()); app.form.submit(); await flush(); const sdk = app.clients[0]!;
  const node = app.node('own-connection-quality'), before = report(11), foreign = state();
  sdk.emit('quality', before); sdk.emit('state', foreign); publish(sdk, foreign); sdk.emit('quality', report()); empty(node);
  publish(sdk); sdk.emit('quality', before); empty(node); const accepted = report(); sdk.emit('quality', accepted); shown(node);
  sdk.emit('quality', report(51)); sdk.emit('quality', accepted); shown(node, summary('8.0%', '2.0%', '51 ms'));
});
for (const loss of ['reconnecting', 'stageleft', 'audience-role'] as const)
  it(`embed quality ${loss} fences status, role, joined and seen receipts until new actual state plus new quality`, async t => {
    const { sdk, node } = await setup(t), previous = sdk.state!, accepted = report(), rejected = report(88);
    sdk.emit('quality', accepted); shown(node);
    if (loss === 'reconnecting') sdk.setStatus('reconnecting');
    else if (loss === 'stageleft') sdk.emit('stageleft', { participantId: 'controller' });
    else sdk.emit('role', { participantId: 'controller', role: 'audience' });
    empty(node); const rejectedState = state();
    sdk.emit('quality', rejected); sdk.emit('state', rejectedState); sdk.setStatus('live');
    sdk.emit('role', { participantId: 'controller', role: 'controller' }); sdk.emit('stagejoined', { participantId: 'controller' });
    sdk.emit('state', previous); sdk.emit('quality', report(99)); empty(node);
    publish(sdk, rejectedState); sdk.emit('quality', report(99)); empty(node);
    publish(sdk); empty(node); sdk.emit('quality', accepted); sdk.emit('quality', rejected); empty(node);
    sdk.emit('quality', report(51)); shown(node, summary('8.0%', '2.0%', '51 ms'));
  });
for (const change of ['room', 'participant', 'offstage', 'missing-state'] as const)
  it(`embed quality ${change} retires history; restoring status cannot revive it`, async t => {
    const { sdk, node } = await setup(t); sdk.emit('quality', report()); const old = sdk.state!;
    if (change === 'room') sdk.state = { ...old, roomId: 'new-room' };
    else if (change === 'participant') sdk.state = { ...old, me: { ...old.me, participantId: 'replacement' } };
    else if (change === 'offstage') sdk.state = { ...old, me: { ...old.me, onStage: false } };
    else sdk.state = null;
    sdk.emit('quality', report()); empty(node); sdk.state = old; sdk.setStatus('live'); sdk.emit('quality', report()); empty(node);
    publish(sdk); sdk.emit('quality', report()); shown(node);
  });
it('embed quality unrelated deltas and a pure onstage control transfer preserve historical values', async t => {
  const { sdk, node } = await setup(t); sdk.emit('quality', report()); const writes = instrument(node);
  sdk.emit('stageleft', { participantId: 'target' }); sdk.emit('role', { participantId: 'target', role: 'audience' });
  sdk.emit('transferred', { fromId: 'controller', toId: 'target' }); sdk.emit('role', { participantId: 'controller', role: 'speaker' });
  publish(sdk, state({ role: 'speaker' })); shown(node); assert.deepEqual(writes, { textContent: 0, hidden: 0 });
});
it('embed quality micerror, micready, mute and explicit microphone retry retain history without making new values', async t => {
  const { app, sdk, node } = await setup(t); sdk.emit('quality', report()); const writes = instrument(node);
  sdk.setStatus('live'); sdk.emit('micerror', { name: 'NotReadableError', message: '失去麥克風' }); shown(node); assert.equal(app.micRetry.hidden, false);
  app.micRetry.click(); shown(node); assert.equal(sdk.retryCalls, 1);
  sdk.emit('micready', undefined); shown(node); app.mic.click(); shown(node);
  publish(sdk, state({ muted: true })); shown(node); assert.deepEqual(writes, { textContent: 0, hidden: 0 });
});
it('embed quality adds no commands, timers, draft edits, occupancy writes, or unrelated control writes', async t => {
  const { app, sdk, node } = await setup(t); sdk.emit('quality', report());
  const unchanged = ['status', 'last-error', 'error-notice', 'room-occupancy', 'room-name-draft', 'name', 'close-room', 'stage-management-list'];
  app.node('name').value = 'unsent'; app.node('room-name-draft').value = 'unsent room';
  const ui = () => unchanged.map(id => { const n = app.node(id); return [n.textContent, n.hidden, n.disabled, n.value, { ...n.attributes }, { ...n.writes }]; });
  const calls = () => [sdk.actions.length, sdk.moderations.length, sdk.stageModerations.length, sdk.transfers.length, sdk.closes.length,
    sdk.deviceLists.length, sdk.inputSelections.length, sdk.retryCalls, app.clients.length];
  const before = ui(), commands = calls(), timers = app.clock.metrics;
  for (let i = 0; i < 30; i++) sdk.emit('quality', report(40 + i));
  assert.deepEqual(ui(), before); assert.deepEqual(calls(), commands); assert.deepEqual(app.clock.metrics, timers);
  shown(node, summary('8.0%', '2.0%', '69 ms'));
});

for (const property of ['textContent', 'hidden'] as const)
  for (const action of ['new-report', 'clear-report', 'state-offstage', 'silent-offstage', 'silent-room', 'silent-participant', 'reconnect', 'leave', 'closed', 'kicked'] as const)
    it(`embed quality ${property} setter yields to ${action} and never exposes retired history`, async t => {
      const { app, sdk, node } = await setup(t); if (property === 'textContent') sdk.emit('quality', report());
      let entered = false; instrument(node, key => {
        if (entered || key !== property) return; entered = true;
        if (action === 'new-report') sdk.emit('quality', report(71));
        else if (action === 'clear-report') sdk.emit('quality', { participants: [] });
        else if (action === 'state-offstage') publish(sdk, state({ onStage: false }));
        else if (action === 'silent-offstage') sdk.state!.me.onStage = false;
        else if (action === 'silent-room') sdk.state!.roomId = 'other';
        else if (action === 'silent-participant') sdk.state!.me.participantId = 'other';
        else if (action === 'reconnect') sdk.setStatus('reconnecting');
        else if (action === 'leave') app.leave.invoke();
        else sdk.emit(action, {});
      });
      sdk.emit('quality', report(61)); assert.equal(entered, true);
      if (action === 'new-report') shown(node, summary('8.0%', '2.0%', '71 ms')); else empty(node);
    });
for (const property of ['textContent', 'hidden'] as const)
  for (const cause of ['omitted', 'reconnecting', 'disconnected', 'leave', 'closed', 'kicked', 'submit'] as const)
    it(`embed quality ${cause} ${property} clearing cannot erase a nested replacement entry`, async t => {
      const { app, sdk, node } = await setup(t, { confirm: () => true }); sdk.emit('quality', report());
      const close = app.node('close-room'), target = transfer(app); let entered = false;
      instrument(node, key => {
        if (entered || key !== property) return; entered = true;
        if (cause !== 'omitted' && cause !== 'reconnecting') { close.invoke(); target.invoke(); }
        app.form.submit();
      });
      if (cause === 'omitted') sdk.emit('quality', { participants: [] });
      else if (cause === 'reconnecting' || cause === 'disconnected') sdk.setStatus(cause);
      else if (cause === 'leave') app.leave.invoke(); else if (cause === 'submit') app.form.submit(); else sdk.emit(cause, {});
      await flush(); assert.equal(entered, true); assert.equal(app.confirmations.length, 0);
      const next = app.clients.at(-1)!; assert.notEqual(next, sdk); publish(next); next.emit('quality', report(91));
      shown(node, summary('8.0%', '2.0%', '91 ms')); sdk.emit('quality', report(99)); sdk.emit('closed', {}); sdk.emit('kicked', {});
      shown(node, summary('8.0%', '2.0%', '91 ms')); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
    });
for (const command of ['close', 'transfer'] as const)
  for (const change of ['role', 'identity', 'connected', 'status', 'capability', 'target'] as const)
    it(`embed quality cannot resurrect ${command} consent after observed ${change} loss and restoration in its setter`, async t => {
      let inside = () => {}; const { app, sdk, node } = await setup(t, { confirm: () => { inside(); return true; } });
      sdk.emit('quality', report()); const old = state(), close = sdk.closeRoom, transferMethod = sdk.transferControl;
      let entered = false; instrument(node, () => {
        if (entered) return; entered = true; publish(sdk, old); sdk.closeRoom = close; sdk.transferControl = transferMethod; sdk.status = 'live';
      });
      inside = () => {
        if (change === 'role') sdk.state!.me.role = 'speaker';
        else if (change === 'identity') sdk.state!.me.participantId = 'replacement';
        else if (change === 'connected') sdk.state!.me.connected = false;
        else if (change === 'status') sdk.status = 'reconnecting';
        else if (change === 'capability') Reflect.set(sdk, command === 'close' ? 'closeRoom' : 'transferControl', undefined);
        else sdk.state!.speakers.find(p => p.participantId === 'target')!.connected = false;
        sdk.emit('quality', report(51));
      };
      (command === 'close' ? app.node('close-room') : transfer(app)).click(); await flush(); assert.equal(entered, true);
      if (command === 'close' && change === 'target') assert.equal(sdk.closes.length, 1, 'unrelated target loss cannot revoke Close');
      else { assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0); }
      assert.equal(app.confirmations.length, 1);
    });
for (const command of ['close', 'transfer'] as const)
  it(`embed quality ordinary receipt preserves valid ${command} consent and cannot open a nested dialog`, async t => {
    let inside = () => {}; const { app, sdk, node } = await setup(t, { confirm: () => { inside(); return true; } });
    sdk.emit('quality', report()); let entered = false;
    instrument(node, () => { if (entered) return; entered = true; app.node('close-room').invoke(); transfer(app).invoke(); });
    inside = () => sdk.emit('quality', report(51)); (command === 'close' ? app.node('close-room') : transfer(app)).click();
    await flush(); assert.equal(entered, true); assert.equal(app.confirmations.length, 1);
    assert.equal(sdk.closes.length, Number(command === 'close')); assert.equal(sdk.transfers.length, Number(command === 'transfer'));
  });
it('embed quality cancellation before library load and failed imports stay empty', async t => {
  const gate = new Deferred(), app = embedApp({ libraryLoad: gate.promise }); t.after(() => app.cleanup());
  const node = app.node('own-connection-quality'); app.form.submit(); await flush(); app.node('cancel-join').invoke(); empty(node);
  gate.resolve(); await flush(); assert.equal(app.clients.length, 0); empty(node);
  const failed = embedApp({ libraryLoad: async () => { throw new Error('synthetic import failure'); } }); t.after(() => failed.cleanup());
  failed.form.submit(); await flush(); empty(failed.node('own-connection-quality')); assert.equal(failed.clients.length, 0);
});

function media(h: Awaited<ReturnType<typeof actualApp>>) { return {captures:h.captures.length, plays:h.audio.plays, pauses:h.audio.pauses,
  peers:StagePeer.instances.length, contexts:StageContext.instances.length, enumerations:h.enumerations.length, sinks:h.sinks.length,
  trackStops:h.tracks.map(track => track.stops), replacements:StagePeer.instances.map(p=>p.replacements.length), offers:StagePeer.instances.map(p=>p.offers.length)}; }
async function server(t: TestContext) {
  const config = testConfig(c=>{c.rooms.presenceBroadcastMs=0; c.rooms.qualityIntervalMs=2000; c.limits.controlPerSecond=2000;});
  const s = harness(config), host=await s.create('Synthetic host'), speaker=await s.join(host.roomId,host.code,'Synthetic speaker');
  const audience=await s.join(host.roomId,host.code,'Synthetic audience');
  await s.req(host.s,{type:'rtc:offer',payload:SENDRECV_OFFER});
  await s.req(speaker.s,{type:'hand:raise'}); await s.req(host.s,{type:'stage:approve',targetId:speaker.id});
  await s.req(speaker.s,{type:'rtc:offer',payload:SENDRECV_OFFER});
  let reads=0;
  s.transport.getStats=async (_room,id)=>{reads++;return id===host.id ? {inbound:{packetsReceived:92,packetsLost:8},outbound:{fractionLost:0.02},rttMs:36.6}
    : {inbound:{packetsReceived:1,packetsLost:99},outbound:{fractionLost:0.88},rttMs:9876};};
  const fire=async()=>{const timers=s.timers.filter(x=>!x.cleared&&x.ms===config.rooms.qualityIntervalMs);assert.equal(timers.length,1);timers[0]!.cleared=true;timers[0]!.fn();await nextTurn();};
  t.after(async()=>{await s.hub.shutdown(); await s.transport.close();});
  return {s,host,speaker,audience,fire,reads:()=>reads};
}
async function enter(t:TestContext,state:RoomStatePayload) {
  const h=await actualApp(t); h.form.submit();await flush();const socket=StageSocket.instances.at(-1)!;
  socket.deliver({type:'hello',protocol:1,serverVersion:'test',limits:{controlPerSecond:2000,icePerSecond:2000,handRaiseIntervalMs:10000}});
  await h.until(()=>socket.sent.some(m=>m.type==='join'),'join request');const request=socket.sent.find(m=>m.type==='join')!;
  socket.deliver({type:'room:state',...state});socket.deliver({type:'ok',requestId:request.requestId});
  await h.until(()=>StagePeer.instances.at(-1)?.signalingState==='stable' && StagePeer.instances.at(-1)?.localDescription!==null,'negotiation');
  await h.tick(20);return {h,socket,client:h.clients[0] as StageClient};
}
function unchangedUi(h: Awaited<ReturnType<typeof actualApp>>) {
  return ['status', 'last-error', 'error-notice', 'room-occupancy', 'room-name-draft', 'name', 'close-room', 'stage-management-list', 'mic-retry']
    .map(id => { const n = h.node(id); return [n.textContent, n.hidden, n.disabled, n.value, { ...n.attributes }, { ...n.writes }]; });
}
for (const seat of ['host', 'speaker', 'audience'] as const)
  it(`embed quality renders actual Hub report for ${seat} through actual SDK without extra work`, async t => {
    const f = await server(t), who = f[seat], { h, socket, client } = await enter(t, who.s.last('room:state')!);
    const node = h.node('own-connection-quality'); empty(node);
    const noStats = t.mock.method(client, 'getStats', () => { assert.fail('quality must not poll browser stats'); });
    f.host.s.clear(); f.speaker.s.clear(); f.audience.s.clear(); await f.fire();
    const quality = who.s.last('quality');
    if (seat === 'audience') { assert.equal(quality, undefined); socket.deliver(f.host.s.last('quality')!); empty(node); return; }
    assert.ok(quality); const before = unchangedUi(h), frames = [...socket.sent], beforeMedia = media(h);
    const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
    socket.deliver(quality); await flush();
    shown(node, seat === 'host' ? summary() : summary('99.0%', '88.0%', '9876 ms'));
    assert.deepEqual(unchangedUi(h), before); assert.deepEqual(socket.sent, frames); assert.deepEqual(media(h), beforeMedia);
    assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0); assert.equal(noStats.mock.callCount(), 0);
    assert.doesNotMatch(node.textContent, /Synthetic|PRIVATE|TOKEN|CODE/); assert.equal(f.reads(), 2);
  });
for (const seat of ['host', 'speaker'] as const)
  it(`embed quality actual Hub ${seat} departure retires before stale SDK state and requires new actual state`, async t => {
    const f = await server(t), who = f[seat], { h, socket, client } = await enter(t, who.s.last('room:state')!);
    const node = h.node('own-connection-quality'); socket.deliver({ type: 'quality', ...report(37, who.id) }); shown(node);
    const previous = client.state!; who.s.clear(); await f.s.req(who.s, { type: 'stage:leave' });
    const stateIndex = who.s.inbox.findIndex(m => m.type === 'room:state');
    const leftIndex = who.s.inbox.findIndex(m => m.type === 'stage:left' && m.participantId === who.id);
    const roleIndex = who.s.inbox.findIndex(m => m.type === 'role:update' && m.participantId === who.id && m.role === 'audience');
    assert.ok(leftIndex >= 0 && stateIndex > leftIndex);
    if (seat === 'speaker') assert.ok(roleIndex >= 0 && roleIndex < leftIndex);
    for (const message of who.s.inbox.slice(0, stateIndex)) {
      socket.deliver(message);
      if ((message.type === 'role:update' || message.type === 'stage:left') && message.participantId === who.id) {
        assert.equal(client.me!.onStage, true, 'SDK state is still the previous authoritative snapshot'); empty(node);
        socket.deliver({ type: 'quality', ...report(88, who.id) }); empty(node);
        client.dispatchEvent(new CustomEvent('state', { detail: previous }));
        socket.deliver({ type: 'quality', ...report(99, who.id) }); empty(node);
      }
    }
    socket.deliver(who.s.inbox[stateIndex]!); empty(node); assert.equal(client.me!.onStage, false);
    const active = { ...previous, me: { ...previous.me, onStage: true } };
    socket.deliver({ type: 'room:state', ...active }); empty(node);
    socket.deliver({ type: 'quality', ...report(51, who.id) }); shown(node, summary('8.0%', '2.0%', '51 ms'));
  });
it('embed quality offstage actual controller receives others publishers but displays no borrowed metrics', async t => {
  const f = await server(t); await f.s.req(f.host.s, { type: 'stage:leave' });
  const { h, socket, client } = await enter(t, f.host.s.last('room:state')!); assert.equal(client.me!.onStage, false);
  f.host.s.clear(); await f.fire(); const quality = f.host.s.last('quality')!;
  assert.deepEqual(quality.participants.map(p => p.participantId), [f.speaker.id]);
  socket.deliver(quality); empty(h.node('own-connection-quality'));
});
it('embed quality reconnect ignores retired socket and requires state receipt then quality from replacement socket', async t => {
  const { h, socket, client } = await enter(t, actualState({ onStage: true })); const node = h.node('own-connection-quality');
  const quality = { type: 'quality' as const, ...report(37, 'guest') }, previous = client.state!, old = socket.onmessage;
  socket.deliver(quality); shown(node); socket.close(); assert.equal(client.status, 'reconnecting'); empty(node);
  old?.({ data: JSON.stringify(quality) }); empty(node);
  client.dispatchEvent(new CustomEvent('quality', { detail: report(55, 'guest') })); empty(node);
  client.dispatchEvent(new CustomEvent('state', { detail: previous })); empty(node);
  await h.tick(500); const next = StageSocket.instances.at(-1)!; assert.notEqual(next, socket);
  next.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => next.sent.some(m => m.type === 'join'), 'resume join');
  next.deliver({ type: 'status', state: 'waiting' }); next.deliver(quality); empty(node);
  const request = next.sent.find(m => m.type === 'join')!;
  next.deliver({ type: 'room:state', ...actualState({ onStage: true }) }); next.deliver({ type: 'ok', requestId: request.requestId });
  await flush(); empty(node); next.deliver(quality); shown(node);
  assert.equal(client.status, 'live'); old?.({ data: JSON.stringify({ type: 'quality', ...report(99, 'guest') }) }); shown(node);
});
it('embed quality actual SDK → validator → Hub → SDK ingress supplies own summary after transfer and return to stage', async t => {
  const config = testConfig(c => { c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 2000; c.limits.controlPerSecond = 2000; });
  const s = harness(config), host = await s.create('Synthetic controller'), h = await actualApp(t);
  let work = Promise.resolve(); const incoming: ServerMessage[] = [], outgoing: ClientMessage[] = []; let session: Session;
  t.mock.method(StageSocket.prototype, 'send', function(this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits); this.sent.push(message); outgoing.push(message);
    work = work.then(() => s.hub.handle(session, message));
  });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  session = { id: 'embed-quality-bridge', send(message) { incoming.push(message); if (socket.readyState === StageSocket.OPEN) socket.deliver(message); }, close() { socket.close(); } };
  s.hub.attach(session); await h.until(() => h.clients[0]?.me != null, 'validated join'); await h.tick(100); await work; await flush();
  const client = h.clients[0] as StageClient, pid = client.me!.participantId, node = h.node('own-connection-quality');
  await s.req(host.s, { type: 'control:transfer', targetId: pid }); await flush(); assert.equal(client.me!.onStage, false); assert.equal(client.me!.role, 'controller'); empty(node);
  const returnWork = client.returnToStage(); await h.tick(100); await work; await h.tick(100); await work; await returnWork;
  assert.equal(client.me!.onStage, true); empty(node);
  s.transport.getStats = async () => ({ inbound: { packetsReceived: 90, packetsLost: 10 }, outbound: { fractionLost: 0 }, rttMs: 24 });
  const timers = s.timers.filter(x => !x.cleared && x.ms === config.rooms.qualityIntervalMs); assert.equal(timers.length, 1);
  const before = unchangedUi(h), frames = [...socket.sent], beforeMedia = media(h); timers[0]!.cleared = true; timers[0]!.fn(); await nextTurn(); await flush();
  shown(node, summary('10.0%', '0.0%', '24 ms')); assert.deepEqual(unchangedUi(h), before); assert.deepEqual(socket.sent, frames); assert.deepEqual(media(h), beforeMedia);
  assert.ok(outgoing.some(m => m.type === 'join')); assert.ok(outgoing.some(m => m.type === 'stage:approve'));
  assert.ok(outgoing.some(m => m.type === 'rtc:offer')); assert.ok(incoming.some(m => m.type === 'quality'));
  assert.ok(incoming.find(m => m.type === 'quality')?.participants.some(p => p.participantId === pid));
  await s.hub.shutdown(); await s.transport.close();
});
it('embed quality actual track-ended failure retains history and later transport receipt never recaptures or asserts recovery', async t => {
  const { h, socket, client } = await enter(t, actualState({ onStage: true })); const node = h.node('own-connection-quality');
  socket.deliver({ type: 'quality', ...report(37, 'guest') }); shown(node);
  const identity = client.state, track = h.tracks[0]!; track.readyState = 'ended';
  (track as unknown as EventTarget).dispatchEvent(new Event('ended')); await flush();
  assert.equal(client.status, 'live'); assert.equal(client.state, identity); assert.equal(client.me!.onStage, true);
  assert.equal(h.captures.length, 1); assert.equal(h.micRetry.hidden, false); shown(node);
  const before = media(h), frames = [...socket.sent], failure = h.status.textContent;
  socket.deliver({ type: 'quality', participants: [{ participantId: 'guest', downlinkLossPercent: 3, rttMs: 55 }] }); await flush();
  shown(node, summary('—', '3.0%', '55 ms')); assert.deepEqual(media(h), before); assert.deepEqual(socket.sent, frames);
  assert.equal(h.status.textContent, failure); assert.equal(h.micRetry.hidden, false); assert.equal(h.captures.length, 1);
  h.micRetry.click(); await flush(); assert.equal(h.captures.length, 2); shown(node, summary('—', '3.0%', '55 ms'));
  assert.doesNotMatch(node.textContent, /健康|已恢復|最新量測|可聽|已取得麥克風/);
});
it('embed quality initial state-before-ACK loss retires retained SDK snapshot permanently for that entry', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'join'); socket.deliver({ type: 'room:state', ...actualState({ onStage: true }) });
  const client = h.clients[0] as StageClient, node = h.node('own-connection-quality'); socket.deliver({ type: 'quality', ...report(37, 'guest') }); shown(node);
  socket.close(); await flush(); assert.equal(client.status, 'disconnected'); assert.ok(client.state); empty(node); assert.equal(h.leave.disabled, true);
  client.dispatchEvent(new CustomEvent('state', { detail: client.state })); client.dispatchEvent(new CustomEvent('status', { detail: 'live' }));
  client.dispatchEvent(new CustomEvent('quality', { detail: report(99, 'guest') })); empty(node); assert.equal(h.leave.disabled, true);
});
for (const terminal of ['closed', 'shutdown', 'kicked'] as const)
  it(`embed quality real ${terminal} continuation cannot erase replacement entry started from disconnected`, async t => {
    const { h, socket, client } = await enter(t, actualState({ onStage: true })); const node = h.node('own-connection-quality');
    socket.deliver({ type: 'quality', ...report(37, 'guest') }); shown(node); let entered = false;
    client.on('status', ({ detail }) => { if (detail === 'disconnected' && !entered) { entered = true; empty(node); h.form.submit(); } });
    socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
      : { type: 'room:closed', roomId: 'same-room', ...(terminal === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
    await flush(); assert.equal(entered, true); assert.equal(h.clients.length, 2); empty(node); assert.equal(h.status.textContent, '連線中…');
    const next = StageSocket.instances.at(-1)!;
    next.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
    await h.until(() => next.sent.some(m => m.type === 'join'), 'replacement join'); const request = next.sent.find(m => m.type === 'join')!;
    next.deliver({ type: 'room:state', ...actualState({ onStage: true }) }); next.deliver({ type: 'ok', requestId: request.requestId }); await h.tick(20);
    next.deliver({ type: 'quality', ...report(51, 'guest') }); shown(node, summary('8.0%', '2.0%', '51 ms'));
    const current = h.status.textContent; client.dispatchEvent(new CustomEvent('closed', { detail: { roomId: 'same-room' } }));
    client.dispatchEvent(new CustomEvent('quality', { detail: report(99, 'guest') })); client.dispatchEvent(new CustomEvent('kicked', { detail: { roomId: 'same-room' } }));
    shown(node, summary('8.0%', '2.0%', '51 ms')); assert.equal(h.status.textContent, current); assert.equal(h.leave.disabled, false);
  });

for (const property of ['textContent', 'hidden'] as const)
  for (const change of ['reconnecting', 'disconnected', 'room', 'participant', 'onStage'] as const)
    it(`embed quality ${property} nested receipt followed by silent ${change} reconciles the winning owner before return`, async t => {
      const { sdk, node } = await setup(t); if (property === 'textContent') sdk.emit('quality', report());
      let entered = false; instrument(node, key => {
        if (entered || key !== property) return; entered = true; sdk.emit('quality', report(71));
        if (change === 'room') sdk.state!.roomId = 'other-room';
        else if (change === 'participant') sdk.state!.me.participantId = 'other-seat';
        else if (change === 'onStage') sdk.state!.me.onStage = false;
        else sdk.status = change;
      });
      sdk.emit('quality', report(61)); assert.equal(entered, true); empty(node);
      sdk.status = 'live'; sdk.state!.roomId = 'same-room'; sdk.state!.me.participantId = 'controller'; sdk.state!.me.onStage = true;
      sdk.emit('status', 'live'); sdk.emit('quality', report(91)); empty(node);
      publish(sdk); sdk.emit('quality', report(51));
      if (change === 'disconnected') empty(node); else shown(node, summary('8.0%', '2.0%', '51 ms'));
    });
for (const property of ['textContent', 'hidden'] as const)
  for (const command of ['close', 'transfer'] as const)
    it(`embed quality ${command} consent cannot survive ${property} nested-report tail reconnect restored after return`, async t => {
      let inside = () => {}; const { app, sdk, node } = await setup(t, { confirm: () => { inside(); return true; } });
      if (property === 'textContent') sdk.emit('quality', report()); let entered = false;
      instrument(node, key => { if (entered || key !== property) return; entered = true; sdk.emit('quality', report(71)); sdk.status = 'reconnecting'; });
      inside = () => { sdk.emit('quality', report(61)); sdk.status = 'live'; };
      (command === 'close' ? app.node('close-room') : transfer(app)).click(); await flush();
      assert.equal(entered, true); empty(node); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
      assert.equal(app.confirmations.length, 1);
    });
for (const throwing of [false, true]) for (const silentTail of [false, true])
  it(`embed quality reentrant own metric getter throwing=${throwing}/silent-tail=${silentTail} cannot overwrite newer primitives`, async t => {
    const { sdk, node } = await setup(t), own = { participantId: 'controller', uplinkLossPercent: 8, downlinkLossPercent: 2 };
    Object.defineProperty(own, 'rttMs', { get() {
      sdk.emit('quality', report(71)); if (silentTail) sdk.status = 'reconnecting';
      if (throwing) throw new Error('synthetic metric getter failure'); return 61;
    } });
    sdk.emit('quality', { participants: [own] });
    if (silentTail) empty(node); else shown(node, summary('8.0%', '2.0%', '71 ms'));
  });
it('embed quality actual explicit preview and audio retry neither create nor replace received history', async t => {
  const { h, socket, client } = await enter(t, actualState({ onStage: true })); const node = h.node('own-connection-quality'); empty(node);
  const preview = await client.startMicTest(); empty(node); assert.equal(h.captures.length, 2);
  client.dispatchEvent(new CustomEvent('micready')); empty(node);
  socket.deliver({ type: 'quality', ...report(37, 'guest') }); shown(node);
  preview.stop(); await flush(); shown(node);
  let retried = false; const retry = client.retryAudioConnection().then(() => { retried = true; });
  await h.until(() => retried, 'explicit audio retry completes'); await retry; shown(node); assert.equal(h.captures.length, 2);
});
