import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { ClientMessage, ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { Deferred, embedApp, flush, type EmbedNode, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageContext, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { harness, testConfig } from './helpers.ts';

type ActualApp = Awaited<ReturnType<typeof actualApp>>;
const rename = (h: { node(id: string): EmbedNode }) => h.node('rename');
const draft = (h: { node(id: string): EmbedNode }) => h.node('name');
const latest = (sdk: EmbedSdk) => { const request = sdk.renames.at(-1); assert.ok(request); return request; };
const requests = (socket: StageSocket) => socket.sent.filter((message): message is Extract<ClientMessage, { type: 'participant:rename' }> => message.type === 'participant:rename');
function control(button: EmbedNode, options: { hidden?: boolean; disabled?: boolean; busy?: boolean } = {}): void {
  assert.equal(button.hidden, options.hidden ?? false);
  assert.equal(button.disabled, options.disabled ?? options.hidden ?? options.busy ?? false);
  assert.equal(button.attributes['aria-busy'], String(options.busy ?? false));
}
function bypass(button: EmbedNode): void { button.hidden = button.disabled = false; button.invoke(); }
async function command(h: ActualApp, socket: StageSocket, name: string) {
  const count = requests(socket).length; draft(h).value = name; rename(h).click();
  await h.until(() => requests(socket).length === count + 1, 'public SDK participant:rename');
  return requests(socket).at(-1)!;
}
async function hello(h: ActualApp, socket: StageSocket) {
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'public SDK join');
  const request = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join'); assert.ok(request); return request;
}

it('embed HTML has one initially hidden explicit non-submit rename action beside the existing name draft', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  assert.equal((html.match(/id="name"/g) ?? []).length, 1);
  assert.equal((html.match(/id="rename"/g) ?? []).length, 1);
  assert.match(html, /<button id="rename" type="button" aria-busy="false" hidden disabled>更新名稱<\/button>/);
  assert.ok(html.indexOf('</form>') < html.indexOf('id="rename"'), 'renaming is distinct from submitting a replacement join');
});

it('whole embed blocks direct rename invocation before a client or its first authoritative snapshot', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); control(rename(h), { hidden: true }); bypass(rename(h));
  assert.equal(h.clients.length, 0); control(rename(h), { hidden: true });
  h.form.submit(); await flush(); const sdk = h.clients[0]!;
  bypass(rename(h)); assert.equal(sdk.renames.length, 0); control(rename(h), { hidden: true });
  sdk.snapshot(); control(rename(h));
  assert.equal(h.clients.length, 1); assert.equal(sdk.joins.length, 1);
});

for (const [role, onStage, handRaised, muted, forceMuted] of [
  ['audience', false, false, false, false], ['audience', false, true, false, false],
  ['speaker', true, false, false, false], ['speaker', true, false, true, false],
  ['speaker', true, false, true, true], ['controller', true, false, false, false],
  ['controller', false, false, true, true],
] as const) {
  it(`whole embed permits self rename for ${role}, onStage=${onStage}, raised=${handRaised}, muted=${muted}, forced=${forceMuted}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role, onStage, handRaised, muted, forceMuted });
    const status = h.status.textContent; draft(h).value = '  New & <name>  '; control(rename(h)); rename(h).click();
    assert.equal(latest(sdk).name, '  New & <name>  '); control(rename(h), { busy: true });
    assert.equal(h.status.textContent, status); assert.equal(sdk.me!.name, '測試聽眾');
    latest(sdk).work.resolve(); await flush(); control(rename(h));
    assert.equal(h.status.textContent, status, 'ACK alone cannot invent the accepted name');
    assert.equal(draft(h).value, '  New & <name>  '); assert.equal(sdk.joins.length, 1); assert.equal(sdk.actions.length, 0);
  });
}

for (const value of ['', '   ', ' Cafe\u0301\u0000 & <茶> ', 'x'.repeat(100)]) {
  it(`whole embed forwards raw draft ${JSON.stringify(value)} without imposing a second validation policy`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(); draft(h).value = value; rename(h).click();
    assert.equal(latest(sdk).name, value); latest(sdk).work.reject('伺服器拒絕此名稱。'); await flush();
    assert.equal(h.status.textContent, '伺服器拒絕此名稱。'); control(rename(h)); assert.equal(draft(h).value, value);
  });
}

it('whole embed state-before-ACK preserves one pending rename while an edited draft belongs to the next click', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  draft(h).value = 'First'; rename(h).click(); const first = latest(sdk);
  draft(h).value = '  Second draft  '; rename(h).click(); bypass(rename(h));
  sdk.snapshot({ name: 'Server accepted First', role: 'controller', onStage: true });
  h.tick(1000); bypass(rename(h)); control(rename(h), { busy: true });
  assert.equal(sdk.renames.length, 1); assert.equal(first.name, 'First'); assert.equal(draft(h).value, '  Second draft  ');
  assert.equal(h.status.textContent, '測試舞台 · Server accepted First · 已上台');
  first.work.resolve(); await flush(); control(rename(h));
  assert.equal(draft(h).value, '  Second draft  '); rename(h).click(); assert.equal(latest(sdk).name, '  Second draft  ');
  assert.equal(sdk.renames.length, 2); assert.equal(sdk.actions.length, 0); assert.equal(sdk.joins.length, 1);
});

for (const failure of ['rejection', 'synchronous throw'] as const) {
  it(`whole embed releases current rename ${failure} and retries with the newest draft`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
    const setName = sdk.setName.bind(sdk); let attempts = 0;
    if (failure === 'synchronous throw') sdk.setName = name => { if (++attempts === 1) throw new Error('請重試名稱。'); return setName(name); };
    draft(h).value = 'Failed'; rename(h).click(); if (failure === 'rejection') latest(sdk).work.reject('請重試名稱。');
    await flush(); control(rename(h)); assert.equal(h.status.textContent, '請重試名稱。');
    draft(h).value = 'Fresh retry'; rename(h).click(); assert.equal(latest(sdk).name, 'Fresh retry'); control(rename(h), { busy: true });
    latest(sdk).work.resolve(); await flush(); control(rename(h));
  });
}

for (const settlement of ['before recovery', 'after recovery'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed retains same-seat rename ownership through reconnect with ${outcome} ${settlement}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
    draft(h).value = 'Requested'; rename(h).click(); const pending = latest(sdk); sdk.setStatus('reconnecting');
    control(rename(h), { busy: true }); bypass(rename(h)); assert.equal(sdk.renames.length, 1);
    sdk.snapshot({ name: 'Accepted' }); control(rename(h), { busy: true });
    const settle = async () => {
      if (outcome === 'resolve') pending.work.resolve(); else pending.work.reject('Current reconnect rename failure');
      await flush(); if (outcome === 'reject') assert.equal(h.status.textContent, 'Current reconnect rename failure');
    };
    if (settlement === 'before recovery') {
      await settle(); control(rename(h), { disabled: true }); bypass(rename(h)); assert.equal(sdk.renames.length, 1);
    }
    sdk.setStatus('live');
    if (settlement === 'after recovery') {
      control(rename(h), { busy: true }); bypass(rename(h)); assert.equal(sdk.renames.length, 1);
      await settle();
    }
    control(rename(h)); draft(h).value = 'Recovered'; rename(h).click(); assert.equal(latest(sdk).name, 'Recovered');
  });
}

for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const) for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed ${terminal} retires rename before late ${settlement}, even with retained snapshots`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(); rename(h).click(); const retired = latest(sdk);
    if (terminal === 'leave') h.leave.click(); else if (terminal === 'disconnected') await sdk.disconnect(); else sdk.emit(terminal, {});
    await flush(); const status = h.status.textContent; control(rename(h), { hidden: true }); bypass(rename(h));
    if (settlement === 'resolve') retired.work.resolve(); else retired.work.reject('Retired rename failure');
    await flush(); assert.equal(h.status.textContent, status); control(rename(h), { hidden: true }); assert.equal(sdk.renames.length, 1);
    sdk.snapshot(); bypass(rename(h)); control(rename(h), { hidden: true }); assert.equal(sdk.renames.length, 1);
  });
}

for (const replacement of ['rejoin', 'leave and rejoin'] as const) for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed ${replacement} prevents old rename ${settlement} from unlocking a new pending request`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join(); draft(h).value = 'Old'; rename(h).click(); const retired = latest(old);
    if (replacement === 'leave and rejoin') { h.leave.click(); await flush(); }
    draft(h).value = 'Fresh join'; const current = await h.join(); assert.notEqual(current, old);
    assert.equal(current.joins[0]!.name, 'Fresh join'); draft(h).value = 'Current'; rename(h).click(); const active = latest(current);
    const status = h.status.textContent;
    if (settlement === 'resolve') retired.work.resolve(); else retired.work.reject('Old rename failure'); await flush();
    old.snapshot({ name: 'Retired snapshot' }); old.setStatus('disconnected'); old.emit('closed', {}); old.emit('kicked', {});
    assert.equal(h.status.textContent, status); control(rename(h), { busy: true }); bypass(rename(h));
    assert.equal(old.renames.length, 1); assert.equal(current.renames.length, 1); assert.equal(draft(h).value, 'Current');
    active.work.resolve(); await flush(); control(rename(h));
  });
}

for (const replacement of [false, true]) {
  it(`whole embed ${replacement ? 'replacement join' : 'leave'} revokes rename before an asynchronous disconnect settles`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(), gate = new Deferred();
    const disconnect = sdk.disconnect.bind(sdk); sdk.disconnect = async () => { await gate.promise; await disconnect(); };
    t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); });
    rename(h).click(); const retired = latest(sdk); if (replacement) h.form.submit(); else h.leave.click();
    control(rename(h), { hidden: true }); bypass(rename(h)); sdk.snapshot(); sdk.setStatus('live'); bypass(rename(h));
    control(rename(h), { hidden: true }); assert.equal(sdk.renames.length, 1);
    const status = h.status.textContent; retired.work.reject('Old disconnect-period failure'); await flush(); assert.equal(h.status.textContent, status);
    gate.resolve(); await flush(); control(rename(h), { hidden: true });
  });
}

for (const drift of ['room', 'participant'] as const) for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed defensive same-client ${drift} drift retires old rename ${settlement} without unlocking its replacement`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(); rename(h).click(); const retired = latest(sdk);
    const state = { ...sdk.state!, me: { ...sdk.me! } };
    if (drift === 'room') state.roomId = 'replacement-room'; else state.me.participantId = 'replacement-participant';
    sdk.state = state; sdk.me = state.me; sdk.emit('state', state); control(rename(h));
    draft(h).value = 'Replacement'; rename(h).click(); const active = latest(sdk), status = h.status.textContent;
    if (settlement === 'resolve') retired.work.resolve(); else retired.work.reject('Retired identity error'); await flush();
    assert.equal(h.status.textContent, status); control(rename(h), { busy: true }); bypass(rename(h)); assert.equal(sdk.renames.length, 2);
    active.work.resolve(); await flush(); control(rename(h));
  });
}

it('whole embed actual SDK admits rename after room state arrives before the join ACK', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  const joining = await hello(h, socket); control(rename(h), { hidden: true });
  socket.deliver({ type: 'room:state', ...actualState({ role: 'audience', name: 'Before' }) });
  assert.equal(h.form.submitButton!.disabled, true); control(rename(h));
  const request = await command(h, socket, '  During join ACK  '); assert.equal(request.name, '  During join ACK  ');
  socket.deliver({ type: 'room:state', ...actualState({ role: 'audience', name: 'Accepted during join' }) });
  socket.deliver({ type: 'ok', requestId: joining.requestId }); await flush();
  assert.equal(h.form.submitButton!.disabled, false); control(rename(h), { busy: true });
  bypass(rename(h)); assert.equal(requests(socket).length, 1);
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flush(); control(rename(h));
  assert.equal(h.status.textContent, '測試舞台 · Accepted during join · 收聽中'); assert.equal(h.captures.length, 0);
});

it('whole embed actual SDK sends raw rename only, renders sanitized state once, retries current errors and preserves publishing media', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join({ onStage: true });
  await h.until(() => peer.transceiver.sender.track !== null && peer.signalingState === 'stable', 'healthy capture');
  const track = peer.transceiver.sender.track!, before = { captures: h.captures.length, peers: [...StagePeer.instances], offers: [...peer.offers], replacements: [...peer.replacements], sent: socket.sent.length,
    volume: h.audio.volume, muted: h.audio.muted, plays: h.audio.plays, pauses: h.audio.pauses };
  const raw = '  Cafe\u0301\u0000 & <茶> &amp;  ', accepted = 'Café &amp; &lt;茶&gt; &amp;amp;';
  const request = await command(h, socket, raw); assert.deepEqual(request, { type: 'participant:rename', name: raw, requestId: request.requestId });
  assert.equal(h.status.textContent, '測試舞台 · 測試主控 · 已上台'); draft(h).value = 'Next draft'; bypass(rename(h));
  socket.deliver({ type: 'room:state', ...actualState({ onStage: true, name: accepted }) });
  assert.equal(h.status.textContent, '測試舞台 · Café & <茶> &amp; · 已上台'); control(rename(h), { busy: true });
  assert.equal(draft(h).value, 'Next draft'); socket.deliver({ type: 'ok', requestId: request.requestId }); await flush(); control(rename(h));
  for (const [name, code, message] of [['', 'bad_request', '名稱不能為空白。'], ['Older server', 'unknown_type', '伺服器不支援此操作。']] as const) {
    const rejected = await command(h, socket, name); control(rename(h), { busy: true });
    socket.deliver({ type: 'error', requestId: rejected.requestId, code, message }); await flush();
    assert.equal(h.status.textContent, message); control(rename(h)); assert.equal(h.clients[0]!.me!.name, accepted); assert.equal(draft(h).value, name);
  }
  const retry = await command(h, socket, 'Current retry'); socket.deliver({ type: 'ok', requestId: retry.requestId }); await flush(); control(rename(h));
  assert.equal(requests(socket).length, 4); assert.equal(socket.sent.length, before.sent + 4);
  assert.equal(h.captures.length, before.captures); assert.deepEqual(StagePeer.instances, before.peers); assert.deepEqual(peer.offers, before.offers);
  assert.deepEqual(peer.replacements.slice(0, before.replacements.length), before.replacements);
  assert.deepEqual(peer.replacements.slice(before.replacements.length), [track], 'snapshot reapplies the existing healthy track');
  assert.equal(peer.transceiver.sender.track, track); assert.equal(track.stopped, false); assert.equal(track.stops, 0); assert.equal(track.enabled, true);
  assert.equal(peer.transceiver.direction, 'sendrecv'); assert.equal(peer.connectionState, 'connected'); assert.equal(StageContext.instances.length, 0);
  assert.deepEqual({ volume: h.audio.volume, muted: h.audio.muted, plays: h.audio.plays, pauses: h.audio.pauses },
    { volume: before.volume, muted: before.muted, plays: before.plays, pauses: before.pauses });
});

it('whole embed actual SDK resumes the same seat without replaying a pending rename or overwriting its next draft', async t => {
  const h = await actualApp(t), { socket } = await h.join({ role: 'audience', name: 'Before' });
  const retired = await command(h, socket, 'Pending before outage'); draft(h).value = 'Fresh after recovery'; socket.close();
  control(rename(h), { disabled: true, busy: true }); bypass(rename(h)); await flush(); control(rename(h), { disabled: true });
  assert.equal(requests(socket).length, 1); await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  const joining = await hello(h, resumed); assert.equal(joining.resumeToken, 'test-resume');
  resumed.deliver({ type: 'ok', requestId: joining.requestId }); await flush(); control(rename(h), { disabled: true });
  resumed.deliver({ type: 'room:state', ...actualState({ role: 'audience', name: 'Recovered authoritative' }) }); await flush(); control(rename(h));
  assert.equal(requests(resumed).length, 0); assert.equal(draft(h).value, 'Fresh after recovery');
  rename(h).click(); await h.until(() => requests(resumed).length === 1, 'fresh recovered rename'); const current = requests(resumed)[0]!;
  assert.equal(current.name, 'Fresh after recovery'); const status = h.status.textContent;
  socket.deliver({ type: 'error', requestId: retired.requestId, code: 'bad_request', message: 'Retired socket failure' }); await flush();
  assert.equal(h.status.textContent, status); control(rename(h), { busy: true });
  resumed.deliver({ type: 'ok', requestId: current.requestId }); await flush(); control(rename(h)); assert.equal(h.captures.length, 0);
});

for (const terminal of ['leave', 'disconnected', 'closed', 'shutdown', 'kicked'] as const) for (const outcome of ['ok', 'error'] as const) {
  it(`whole embed actual SDK ${terminal} ignores late rename ${outcome} after a fresh pending rejoin`, async t => {
    const h = await actualApp(t), { socket } = await h.join({ role: 'audience' }); const retired = await command(h, socket, 'Old');
    if (terminal === 'leave') h.leave.click(); else if (terminal === 'disconnected') await h.clients[0]!.disconnect();
    else socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
      : { type: 'room:closed', roomId: 'same-room', ...(terminal === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
    await flush(); control(rename(h), { hidden: true }); const terminalStatus = h.status.textContent; bypass(rename(h));
    if (outcome === 'ok') socket.deliver({ type: 'ok', requestId: retired.requestId });
    else socket.deliver({ type: 'error', requestId: retired.requestId, code: 'bad_request', message: 'Retired failure' });
    await flush(); assert.equal(h.status.textContent, terminalStatus); control(rename(h), { hidden: true });
    draft(h).value = 'New join name'; const { socket: fresh } = await h.join({ role: 'audience', participantId: 'replacement' });
    const current = await command(h, fresh, 'Current'); const status = h.status.textContent;
    socket.deliver({ type: 'room:state', ...actualState({ name: 'Retired name' }) });
    if (outcome === 'ok') socket.deliver({ type: 'ok', requestId: retired.requestId });
    else socket.deliver({ type: 'error', requestId: retired.requestId, code: 'bad_request', message: 'Retired failure again' });
    await flush(); assert.equal(h.status.textContent, status); control(rename(h), { busy: true }); bypass(rename(h)); assert.equal(requests(fresh).length, 1);
    fresh.deliver({ type: 'ok', requestId: current.requestId }); await flush(); control(rename(h)); assert.equal(h.captures.length, 0);
  });
}

it('whole embed actual SDK and Hub validate exact names and retain personalized audience privacy without optimistic state', async t => {
  const config = testConfig(value => { value.rooms.qualityIntervalMs = 0; }); const hub = harness(config);
  t.after(async () => {
    await hub.hub.shutdown(); assert.equal(hub.hub.roomCount, 0); assert.equal(hub.transport.rooms.size, 0);
    assert.equal(hub.timers.filter(timer => !timer.cleared).length, 0);
  });
  const host = await hub.create('Host'), self = await hub.join(host.roomId, host.code, 'Self'), witness = await hub.join(host.roomId, host.code, 'Witness');
  const broadcast = () => { for (const timer of hub.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); } };
  broadcast();
  const h = await actualApp(t), { socket } = await h.join(self.s.last('room:state')!.me);
  socket.deliver(self.s.last('room:state')!); await flush();
  const initial = { ...self.s.last('room:state')! }, initialMe = { ...initial.me }, witnessToken = witness.s.last('room:state')!.resumeToken;
  for (const [raw, expected, displayed] of [
    ['  Cafe\u0301\u0000 & <茶>  ', 'Café &amp; &lt;茶&gt;', 'Café & <茶>'],
    [' &lt;名字&gt; ', '&amp;lt;名字&amp;gt;', '&lt;名字&gt;'],
    ['\u200bA\u202e\u2066\u2028\u2029B\u007f', 'AB', 'AB'],
    ['🐱'.repeat(32), '🐱'.repeat(32), '🐱'.repeat(32)],
  ]) {
    const previous = h.status.textContent, request = await command(h, socket, raw!); assert.equal(h.status.textContent, previous);
    const index = self.s.inbox.length; await hub.hub.handle(self.s, parseClientMessage(JSON.stringify(request), config.limits)); broadcast();
    const replies = self.s.inbox.slice(index), snapshot = replies.find((message): message is { type: 'room:state' } & RoomStatePayload => message.type === 'room:state');
    assert.ok(snapshot); assert.equal(snapshot.me.name, expected); assert.equal(snapshot.roomId, host.roomId);
    assert.deepEqual({ ...snapshot.me, name: initialMe.name }, initialMe); assert.equal(snapshot.resumeToken, initial.resumeToken);
    assert.equal(snapshot.audience, undefined); assert.equal(snapshot.code, undefined);
    assert.ok(replies.findIndex(message => message.type === 'room:state') < replies.findIndex(message => message.type === 'ok' && message.requestId === request.requestId));
    draft(h).value = 'Next unsubmitted'; socket.deliver(snapshot); control(rename(h), { busy: true });
    assert.equal(h.status.textContent, `Room · ${displayed} · 收聽中`); assert.equal(draft(h).value, 'Next unsubmitted');
    const ack = replies.find(message => message.type === 'ok' && message.requestId === request.requestId); assert.ok(ack); socket.deliver(ack); await flush(); control(rename(h));
    const visible = host.s.last('room:state')!, hidden = witness.s.last('room:state')!;
    assert.equal(visible.audience!.find(person => person.participantId === self.id)!.name, expected);
    assert.equal(hidden.audience, undefined); assert.equal(hidden.code, undefined); assert.equal(hidden.resumeToken, witnessToken);
    const people: ParticipantView[] = [hidden.me, ...hidden.hands, ...hidden.speakers]; assert.ok(people.every(person => person.participantId !== self.id));
    assert.ok(people.every(person => !('resumeToken' in person) && !('code' in person)));
    assert.equal(h.captures.length, 0); assert.equal(h.clients.length, 1);
  }
  assert.equal(requests(socket).length, 4); assert.equal(socket.sent.filter(message => message.type === 'join').length, 1);
});
