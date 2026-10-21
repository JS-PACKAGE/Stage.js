import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { ClientMessage, ParticipantView, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { parseClientMessage, ValidationError } from '../src/ws/validate.ts';
import { Deferred, embedApp, flush, type EmbedNode, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageContext, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { harness, testConfig } from './helpers.ts';

// Whole production embed and public SDK with controlled DOM/socket/media boundaries.
// Hub requests are relayed explicitly; these tests do not claim native-browser rendering,
// SDP interoperability, permission prompts, or audible playback.
interface View { node(id: string): EmbedNode }
type ActualApp = Awaited<ReturnType<typeof actualApp>>;
type Rename = Extract<ClientMessage, { type: 'room:rename' }>;
const draft = (h: View) => h.node('room-name-draft');
const update = (h: View) => h.node('room-name-update');
const requests = (socket: StageSocket) => socket.sent.filter((message): message is Rename => message.type === 'room:rename');
const latest = (sdk: EmbedSdk) => { const request = sdk.roomRenames.at(-1); assert.ok(request); return request; };
function editor(h: View, accepted = '測試舞台', value = accepted, options: { busy?: boolean; disabled?: boolean } = {}): void {
  assert.equal(h.node('room-name-panel').hidden, false);
  assert.equal(h.node('room-name-current').textContent, `目前房間名稱：${accepted}`);
  assert.equal(draft(h).value, value); assert.equal(draft(h).disabled, false, 'draft remains editable');
  assert.equal(update(h).disabled, options.disabled ?? options.busy ?? false);
  assert.equal(update(h).attributes['aria-busy'], String(options.busy ?? false));
}
function retired(h: View): void {
  assert.equal(h.node('room-name-panel').hidden, true); assert.equal(h.node('room-name-current').textContent, '');
  assert.equal(draft(h).value, ''); assert.equal(draft(h).disabled, true); assert.equal(update(h).disabled, true);
  assert.equal(update(h).attributes['aria-busy'], 'false');
}
function bypass(h: View): void { update(h).disabled = false; update(h).invoke(); }
function snapshot(sdk: EmbedSdk, patch: { name?: string; roomId?: string; me?: Partial<ParticipantView> } = {}): void {
  assert.ok(sdk.state); assert.ok(sdk.me);
  sdk.state = { ...sdk.state, ...patch, me: { ...sdk.me, ...patch.me } }; sdk.me = sdk.state.me; sdk.emit('state', sdk.state);
}
function notice(h: View, message: string): void {
  assert.equal(h.node('error-notice').hidden, false); assert.equal(h.node('last-error').textContent, `最近錯誤：${message}`);
}
async function command(h: ActualApp, socket: StageSocket, name: string): Promise<Rename> {
  const count = requests(socket).length; draft(h).value = name; update(h).click();
  await h.until(() => requests(socket).length === count + 1, 'public SDK room:rename');
  return requests(socket).at(-1)!;
}
async function hello(h: ActualApp, socket: StageSocket) {
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'public SDK join');
  const request = socket.sent.find((message): message is Extract<ClientMessage, { type: 'join' }> => message.type === 'join');
  assert.ok(request); return request;
}

it('embed HTML separates a labeled controller room-title draft, accepted title and explicit non-submit update', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  for (const id of ['room-name-panel', 'room-name-current', 'room-name-draft', 'room-name-update']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `unique ${id}`);
  }
  const panel = html.match(/<div\b[^>]*\bid="room-name-panel"[^>]*>[\s\S]*?<\/div>/)?.[0]; assert.ok(panel);
  assert.match(panel, /^<div\b[^>]*\bhidden(?:\s|>)/);
  assert.match(panel, /<p\b[^>]*\bid="room-name-current"[^>]*><\/p>/);
  assert.match(panel, /<label\b[^>]*\bfor="room-name-draft"[^>]*>[^<]+/);
  const input = panel.match(/<input\b[^>]*\bid="room-name-draft"[^>]*>/)?.[0]; assert.ok(input);
  assert.match(input, /\bdisabled(?:\s|>)/); assert.doesNotMatch(input, /\b(?:maxlength|required|pattern|value)\s*(?:=|\s|>)/);
  const type = input.match(/\btype="([^"]+)"/)?.[1]; assert.ok(type === undefined || type === 'text');
  const button = panel.match(/<button\b[^>]*\bid="room-name-update"[^>]*>更新房間名稱<\/button>/)?.[0]; assert.ok(button);
  assert.match(button, /\btype="button"/); assert.match(button, /\baria-busy="false"/); assert.match(button, /\bdisabled(?:\s|>)/);
  assert.ok(html.indexOf(panel) > html.indexOf('</form>')); assert.equal((html.match(/id="name"/g) ?? []).length, 1);
});

it('whole embed has no room editor before SDK/state and does not admit a tampered hidden button', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); retired(h); bypass(h); retired(h); assert.equal(h.clients.length, 0);
  h.form.submit(); await flush(); const sdk = h.clients[0]!; retired(h); bypass(h); retired(h);
  assert.equal(sdk.roomRenames.length, 0); sdk.snapshot({ role: 'controller' }); editor(h);
  assert.equal(sdk.status, 'waiting', 'initial state is sufficient before media/live');
});

for (const [role, onStage, handRaised] of [['audience', false, false], ['audience', false, true], ['speaker', true, false]] as const) {
  it(`whole embed ${role}, raised=${handRaised} is a read-only room-title observer`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role, onStage, handRaised });
    sdk.emit('error', new Error('Keep role error')); retired(h); draft(h).value = 'Unauthorized'; bypass(h); retired(h);
    assert.equal(sdk.roomRenames.length, 0); notice(h, 'Keep role error');
    snapshot(sdk, { name: 'Updated by controller' }); retired(h);
    assert.equal(h.status.textContent, `Updated by controller · 測試聽眾 · ${onStage ? '已上台' : '收聽中'}`);
    assert.equal(h.node('rename').hidden, false, 'personal rename remains available');
  });
}

for (const onStage of [false, true]) {
  it(`whole embed controller onStage=${onStage} seeds once, preserves draft and accepts raw updates`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage }); editor(h);
    const personal = h.node('name').value; draft(h).value = '  Next & <title>  ';
    snapshot(sdk, { name: 'Authoritative change', me: { onStage: !onStage, name: 'New personal name' } });
    editor(h, 'Authoritative change', '  Next & <title>  '); const status = h.status.textContent;
    update(h).click(); assert.equal(latest(sdk).name, '  Next & <title>  '); editor(h, 'Authoritative change', '  Next & <title>  ', { busy: true });
    latest(sdk).work.resolve(); await flush(); editor(h, 'Authoritative change', '  Next & <title>  ');
    assert.equal(h.status.textContent, status, 'ACK cannot invent an accepted title'); assert.equal(h.node('name').value, personal);
    assert.equal(sdk.joins.length, 1); assert.equal(sdk.renames.length, 0); assert.equal(sdk.actions.length, 0);
  });
}

for (const raw of ['', ' \t\n ', ' Cafe\u0301\u0000 & <茶> ', '🐱'.repeat(40), 'x'.repeat(100)]) {
  it(`whole embed forwards raw room draft ${JSON.stringify(raw)} without client validation`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
    draft(h).value = raw; update(h).click(); assert.equal(latest(sdk).name, raw);
    latest(sdk).work.reject('Server title rejection'); await flush(); editor(h, '測試舞台', raw); notice(h, 'Server title rejection');
  });
}

it('whole embed reserves room rename before synchronous SDK callbacks, retaining one attempt through state-before-ACK', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
  const setRoomName = sdk.setRoomName.bind(sdk); let callbacks = 0;
  sdk.setRoomName = name => {
    callbacks++; assert.equal(update(h).attributes['aria-busy'], 'true');
    draft(h).value = 'Next draft'; snapshot(sdk, { name: 'Accepted First' }); bypass(h); return setRoomName(name);
  };
  draft(h).value = 'First'; update(h).click(); update(h).click(); bypass(h); h.tick(1000);
  assert.equal(callbacks, 1); assert.equal(sdk.roomRenames.length, 1); assert.equal(latest(sdk).name, 'First');
  editor(h, 'Accepted First', 'Next draft', { busy: true }); latest(sdk).work.resolve(); await flush(); editor(h, 'Accepted First', 'Next draft');
  update(h).click(); assert.equal(callbacks, 2); assert.equal(latest(sdk).name, 'Next draft');
});

for (const failure of ['rejection', 'synchronous throw'] as const) {
  it(`whole embed releases a current room-title ${failure} and retries only on a fresh click`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
    const setRoomName = sdk.setRoomName.bind(sdk); let calls = 0;
    if (failure === 'synchronous throw') sdk.setRoomName = name => { if (++calls === 1) throw new Error('Current title failure'); return setRoomName(name); };
    sdk.emit('error', new Error('Retained error')); draft(h).value = 'Failed'; update(h).click();
    if (failure === 'rejection') { notice(h, 'Retained error'); latest(sdk).work.reject('Current title failure'); }
    await flush(); editor(h, '測試舞台', 'Failed'); notice(h, 'Current title failure');
    const count = sdk.roomRenames.length; h.tick(1000); assert.equal(sdk.roomRenames.length, count);
    draft(h).value = 'Fresh retry'; update(h).click(); assert.equal(latest(sdk).name, 'Fresh retry');
    latest(sdk).work.resolve(); await flush(); editor(h, '測試舞台', 'Fresh retry');
  });
}

it('whole embed unavailable old SDK room-name method fails safely without retry or stale optimistic title', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
  const setRoomName = sdk.setRoomName.bind(sdk); Reflect.set(sdk, 'setRoomName', undefined);
  draft(h).value = 'Old SDK draft'; update(h).click(); await flush(); editor(h, '測試舞台', 'Old SDK draft');
  assert.equal(h.node('error-notice').hidden, false); assert.ok(h.node('last-error').textContent);
  assert.equal(sdk.roomRenames.length, 0); h.tick(1000); assert.equal(sdk.roomRenames.length, 0);
  sdk.setRoomName = setRoomName; draft(h).value = 'Explicit retry'; update(h).click(); assert.equal(latest(sdk).name, 'Explicit retry');
  latest(sdk).work.resolve(); await flush(); editor(h, '測試舞台', 'Explicit retry');
});

for (const mutation of ['role', 'state cleared', 'disconnected', 'reconnecting'] as const) {
  it(`whole embed rereads live ${mutation} before room-title submission even without an event`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
    draft(h).value = 'Must not send'; sdk.emit('error', new Error('Keep admission error'));
    if (mutation === 'role') sdk.state!.me.role = 'audience'; else if (mutation === 'state cleared') sdk.state = null;
    else sdk.status = mutation;
    bypass(h); assert.equal(sdk.roomRenames.length, 0); notice(h, 'Keep admission error');
    if (mutation === 'reconnecting') editor(h, '測試舞台', 'Must not send', { disabled: true }); else retired(h);
  });
}

for (const outcome of ['resolve', 'reject'] as const) for (const settlement of ['before recovery', 'after recovery'] as const) {
  it(`whole embed preserves controller room draft and pending across reconnect, ${outcome} ${settlement}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
    draft(h).value = 'Requested'; update(h).click(); const old = latest(sdk); draft(h).value = 'Next'; sdk.setStatus('reconnecting');
    editor(h, '測試舞台', 'Next', { busy: true }); bypass(h); snapshot(sdk, { name: 'Recovered title' });
    const settle = async () => { if (outcome === 'resolve') old.work.resolve(); else old.work.reject('Current outage failure'); await flush(); };
    if (settlement === 'before recovery') { await settle(); editor(h, 'Recovered title', 'Next', { disabled: true }); bypass(h); }
    else editor(h, 'Recovered title', 'Next', { busy: true });
    assert.equal(sdk.roomRenames.length, 1); sdk.setStatus('live');
    if (settlement === 'after recovery') { editor(h, 'Recovered title', 'Next', { busy: true }); await settle(); }
    if (outcome === 'reject') notice(h, 'Current outage failure');
    editor(h, 'Recovered title', 'Next'); update(h).click(); assert.equal(latest(sdk).name, 'Next'); assert.equal(sdk.roomRenames.length, 2);
  });
}

for (const transition of ['role loss', 'room', 'participant'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed retires ${transition} room owner and isolates late ${outcome} from replacement pending`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' });
    draft(h).value = 'Retired draft'; update(h).click(); const old = latest(sdk);
    if (transition === 'role loss') {
      snapshot(sdk, { me: { role: 'audience' } }); retired(h); bypass(h); assert.equal(sdk.roomRenames.length, 1);
      snapshot(sdk, { name: 'Fresh owner title', me: { role: 'controller' } });
    } else snapshot(sdk, { name: 'Fresh owner title', ...(transition === 'room' ? { roomId: 'different-room' } : { me: { participantId: 'different-person' } }) });
    editor(h, 'Fresh owner title'); draft(h).value = 'Fresh pending'; update(h).click(); const active = latest(sdk);
    sdk.emit('error', new Error('Fresh owner error')); const status = h.status.textContent;
    if (outcome === 'resolve') old.work.resolve(); else old.work.reject('Obsolete owner failure'); await flush();
    editor(h, 'Fresh owner title', 'Fresh pending', { busy: true }); notice(h, 'Fresh owner error'); assert.equal(h.status.textContent, status);
    bypass(h); assert.equal(sdk.roomRenames.length, 2); active.work.resolve(); await flush(); editor(h, 'Fresh owner title', 'Fresh pending');
  });
}

for (const terminal of ['leave', 'disconnected', 'closed', 'shutdown', 'kicked'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed ${terminal} clears room ownership immediately and ignores retired ${outcome}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' }); update(h).click(); const old = latest(sdk);
    if (terminal === 'leave') h.leave.click(); else if (terminal === 'disconnected') sdk.setStatus('disconnected');
    else sdk.emit(terminal === 'shutdown' ? 'closed' : terminal, terminal === 'shutdown' ? { reason: 'shutdown' } : {});
    retired(h); bypass(h); retired(h); await flush(); const status = h.status.textContent;
    if (outcome === 'resolve') old.work.resolve(); else old.work.reject('Retired terminal failure'); await flush();
    assert.equal(h.status.textContent, status); retired(h); sdk.snapshot({ role: 'controller' }); bypass(h); retired(h);
    assert.equal(sdk.roomRenames.length, 1);
  });
}

for (const replacement of ['submit', 'leave then submit'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed ${replacement} creates a fresh same-ID room draft unaffected by old ${outcome}`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const oldSdk = await h.join({ role: 'controller' });
    draft(h).value = 'Old draft'; update(h).click(); const old = latest(oldSdk);
    if (replacement === 'leave then submit') { h.leave.click(); retired(h); await flush(); }
    const sdk = await h.join({ role: 'controller' }); editor(h); draft(h).value = 'Fresh draft'; update(h).click();
    const status = h.status.textContent;
    if (outcome === 'resolve') old.work.resolve(); else old.work.reject('Retired entry failure'); await flush();
    oldSdk.snapshot({ role: 'controller' }); oldSdk.setStatus('disconnected'); oldSdk.emit('closed', {});
    editor(h, '測試舞台', 'Fresh draft', { busy: true }); assert.equal(h.status.textContent, status); bypass(h);
    assert.equal(sdk.roomRenames.length, 1); assert.equal(oldSdk.roomRenames.length, 1);
  });
}

for (const action of ['submit', 'leave'] as const) {
  it(`whole embed ${action} retires room draft before asynchronous disconnect finishes`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' }), gate = new Deferred();
    const disconnect = sdk.disconnect.bind(sdk); sdk.disconnect = async () => { await gate.promise; await disconnect(); };
    t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); });
    update(h).click(); const old = latest(sdk); if (action === 'submit') h.form.submit(); else h.leave.click();
    retired(h); sdk.snapshot({ role: 'controller' }); sdk.setStatus('live'); bypass(h); retired(h);
    const status = h.status.textContent; old.work.reject('Retired disconnect-period failure'); await flush(); assert.equal(h.status.textContent, status);
    assert.equal(sdk.roomRenames.length, 1); gate.resolve(); await flush(); retired(h);
  });
}

it('whole embed real SDK ACK-only join stays inert, while authoritative pre-ACK state admits a room update', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances[0]!, join = await hello(h, socket);
  retired(h); bypass(h); assert.equal(requests(socket).length, 0);
  const state = actualState(); state.name = 'Fresh &amp; title'; socket.deliver({ type: 'room:state', ...state });
  assert.equal(h.form.submitButton!.disabled, true); editor(h, 'Fresh & title');
  const request = await command(h, socket, '  During join ACK  '); socket.deliver({ type: 'ok', requestId: join.requestId }); await flush();
  assert.equal(h.form.submitButton!.disabled, false); editor(h, 'Fresh & title', request.name, { busy: true });
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flush(); editor(h, 'Fresh & title', request.name);
  h.form.submit(); await flush(); const next = StageSocket.instances.at(-1)!, joining = await hello(h, next);
  next.deliver({ type: 'ok', requestId: joining.requestId }); await flush(); retired(h); bypass(h);
  assert.equal(requests(next).length, 0); assert.equal(h.captures.length, 0);
});

it('whole embed real pre-ACK socket loss retires retained state and a fresh same-ID entry rejects late old completion', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances[0]!, join = await hello(h, socket);
  socket.deliver({ type: 'room:state', ...actualState() }); editor(h);
  const client = h.clients[0]! as typeof h.clients[number] & { setRoomName(name: string): Promise<void>; state: RoomStatePayload | null };
  const old = new Deferred(); t.mock.method(client, 'setRoomName', () => old.promise);
  t.after(async () => { if (!old.settled) old.resolve(); await flush(); });
  draft(h).value = 'Retired pre-ACK draft'; update(h).click(); socket.close(); await flush();
  assert.equal(client.status, 'disconnected'); assert.ok(client.state, 'SDK retains pre-ACK snapshot'); retired(h); bypass(h); retired(h);
  const { socket: fresh } = await h.join(); editor(h); const request = await command(h, fresh, 'Fresh same-ID pending');
  fresh.deliver({ type: 'error', code: 'conflict', message: 'Fresh entry error' }); const status = h.status.textContent;
  old.reject('Retired pre-ACK error'); socket.deliver({ type: 'ok', requestId: join.requestId }); await flush();
  editor(h, '測試舞台', request.name, { busy: true }); notice(h, 'Fresh entry error'); assert.equal(h.status.textContent, status);
  bypass(h); assert.equal(requests(fresh).length, 1); fresh.deliver({ type: 'ok', requestId: request.requestId }); await flush(); editor(h, '測試舞台', request.name);
});

it('whole embed real SDK decodes room titles once as text, handles current errors and preserves publishing media', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join({ onStage: true });
  await h.until(() => peer.transceiver.sender.track !== null && peer.signalingState === 'stable', 'healthy capture');
  for (const id of ['room-name-current', 'room-name-draft', 'status']) Object.defineProperty(h.node(id), 'innerHTML', {
    set() { assert.fail(`${id} must not interpret room titles as HTML`); },
  });
  const track = peer.transceiver.sender.track!, baseline = { captures: h.captures.length, peers: [...StagePeer.instances], offers: [...peer.offers], replacements: peer.replacements.length,
    volume: h.audio.volume, muted: h.audio.muted, plays: h.audio.plays, pauses: h.audio.pauses, sent: socket.sent.length };
  const raw = ' Cafe\u0301\u0000 <img src=x> &amp; ', accepted = 'Café &lt;img src=x&gt; &amp;amp;', displayed = 'Café <img src=x> &amp;';
  const request = await command(h, socket, raw); assert.deepEqual(request, { type: 'room:rename', name: raw, requestId: request.requestId });
  editor(h, '測試舞台', raw, { busy: true }); draft(h).value = 'Next unsubmitted';
  socket.deliver({ type: 'room:state', ...actualState({ onStage: true }), name: accepted });
  editor(h, displayed, 'Next unsubmitted', { busy: true }); bypass(h); assert.equal(requests(socket).length, 1);
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flush(); editor(h, displayed, 'Next unsubmitted');
  for (const [name, code, message] of [['', 'bad_request', '房間名稱無效。'], ['Older server', 'unknown_type', '伺服器不支援此操作。'], ['Stale authority', 'forbidden', '沒有主控權限。']] as const) {
    const failed = await command(h, socket, name); socket.deliver({ type: 'error', requestId: failed.requestId, code, message }); await flush();
    editor(h, displayed, name); notice(h, message); assert.equal(h.status.textContent, message);
  }
  const retry = await command(h, socket, 'Fresh retry'); socket.deliver({ type: 'ok', requestId: retry.requestId }); await flush(); editor(h, displayed, 'Fresh retry');
  assert.equal(socket.sent.length, baseline.sent + 5); assert.equal(requests(socket).length, 5); assert.equal(h.captures.length, baseline.captures);
  assert.deepEqual(StagePeer.instances, baseline.peers); assert.deepEqual(peer.offers, baseline.offers);
  assert.deepEqual(peer.replacements.slice(baseline.replacements), [track], 'state reapplies the existing track only');
  assert.equal(peer.transceiver.sender.track, track); assert.equal(track.stopped, false); assert.equal(track.stops, 0); assert.equal(track.enabled, true);
  assert.equal(peer.transceiver.direction, 'sendrecv'); assert.equal(StageContext.instances.length, 0);
  assert.deepEqual({ volume: h.audio.volume, muted: h.audio.muted, plays: h.audio.plays, pauses: h.audio.pauses },
    { volume: baseline.volume, muted: baseline.muted, plays: baseline.plays, pauses: baseline.pauses });
});

it('whole embed real SDK resumes its controller seat with preserved draft and no room-rename replay', async t => {
  const h = await actualApp(t), { socket } = await h.join(); const old = await command(h, socket, 'Pending before loss');
  draft(h).value = 'Fresh after reconnect'; socket.close(); editor(h, '測試舞台', 'Fresh after reconnect', { busy: true, disabled: true });
  await flush(); editor(h, '測試舞台', 'Fresh after reconnect', { disabled: true }); bypass(h); assert.equal(requests(socket).length, 1);
  await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  const join = await hello(h, resumed); assert.equal(join.resumeToken, 'test-resume'); resumed.deliver({ type: 'ok', requestId: join.requestId }); await flush();
  editor(h, '測試舞台', 'Fresh after reconnect', { disabled: true });
  resumed.deliver({ type: 'room:state', ...actualState(), name: 'Recovered authoritative' }); await flush(); editor(h, 'Recovered authoritative', 'Fresh after reconnect');
  assert.equal(requests(resumed).length, 0); const current = await command(h, resumed, draft(h).value); const status = h.status.textContent;
  socket.deliver({ type: 'error', requestId: old.requestId, code: 'bad_request', message: 'Obsolete socket error' }); await flush();
  assert.equal(h.status.textContent, status); editor(h, 'Recovered authoritative', current.name, { busy: true });
  resumed.deliver({ type: 'ok', requestId: current.requestId }); await flush(); editor(h, 'Recovered authoritative', current.name); assert.equal(h.captures.length, 0);
});

it('whole embed real SDK, validator and Hub rename after audience-to-controller transfer with configured Unicode limits and unchanged privacy', async t => {
  const config = testConfig(value => { value.limits.nameMaxLength = 40; value.rooms.presenceBroadcastMs = 0; value.rooms.qualityIntervalMs = 0; });
  const hub = harness(config); t.after(async () => {
    await hub.hub.shutdown(); assert.equal(hub.hub.roomCount, 0); assert.equal(hub.transport.rooms.size, 0);
    assert.equal(hub.timers.filter(timer => !timer.cleared).length, 0);
  });
  const host = await hub.create('Host'), self = await hub.join(host.roomId, host.code, 'Self'), witness = await hub.join(host.roomId, host.code, 'Witness');
  const broadcast = () => { for (const timer of hub.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); } }; broadcast();
  const h = await actualApp(t), { socket, peer } = await h.join(self.s.last('room:state')!.me);
  socket.deliver(self.s.last('room:state')!); await flush(); retired(h); bypass(h); assert.equal(requests(socket).length, 0);
  assert.equal(await hub.req(host.s, { type: 'control:transfer', targetId: self.id }), 'ok'); broadcast();
  socket.deliver(self.s.last('room:state')!); await flush(); editor(h, 'Room'); assert.equal(h.clients[0]!.me!.role, 'controller');
  assert.equal(h.clients[0]!.me!.onStage, false, 'transferred audience controller stays off stage');
  const seats = [host, self, witness], before = seats.map(seat => structuredClone(seat.s.last('room:state')!));
  const baseline = { offers: [...peer.offers], peers: [...StagePeer.instances], sent: socket.sent.length };
  const relay = async (request: Rename): Promise<ServerMessage[]> => {
    const start = self.s.inbox.length;
    try { await hub.hub.handle(self.s, parseClientMessage(JSON.stringify(request), config.limits)); }
    catch (error) { assert.ok(error instanceof ValidationError); return [{ type: 'error', requestId: error.requestId, code: error.code, message: error.message }]; }
    broadcast(); return self.s.inbox.slice(start);
  };
  for (const [raw, accepted, displayed] of [
    [' Cafe\u0301\u0000 & <茶> ', 'Café &amp; &lt;茶&gt;', 'Café & <茶>'],
    ['&lt;img src=x&gt;', '&amp;lt;img src=x&amp;gt;', '&lt;img src=x&gt;'],
    ['\u200bA\u202e\u2066\u2028\u2029B\u007f', 'AB', 'AB'],
    ['🐱'.repeat(40), '🐱'.repeat(40), '🐱'.repeat(40)],
  ] as const) {
    const previous = h.node('room-name-current').textContent, request = await command(h, socket, raw);
    assert.equal(request.name, raw); assert.equal(h.node('room-name-current').textContent, previous);
    const replies = await relay(request), stateIndex = replies.findIndex(message => message.type === 'room:state'), ackIndex = replies.findIndex(message => message.type === 'ok' && message.requestId === request.requestId);
    assert.ok(stateIndex >= 0 && stateIndex < ackIndex); const state = replies[stateIndex]; assert.ok(state?.type === 'room:state'); assert.equal(state.name, accepted);
    draft(h).value = 'Next draft'; socket.deliver(state); editor(h, displayed, 'Next draft', { busy: true }); bypass(h);
    socket.deliver(replies[ackIndex]!); await flush(); editor(h, displayed, 'Next draft');
    for (const [index, seat] of seats.entries()) {
      const after = structuredClone(seat.s.last('room:state')!); assert.equal(after.name, accepted); after.name = before[index]!.name; assert.deepEqual(after, before[index]);
      assert.equal('code' in after, seat === self); assert.equal('audience' in after, seat === self);
    }
  }
  const observerCounts = [host.s.inbox.length, witness.s.inbox.length];
  const same = await command(h, socket, '🐱'.repeat(40)), unchanged = await relay(same);
  assert.equal(unchanged.filter(message => message.type === 'room:state').length, 1, 'same-name success refreshes only the caller');
  assert.ok(unchanged.some(message => message.type === 'ok' && message.requestId === same.requestId));
  assert.deepEqual([host.s.inbox.length, witness.s.inbox.length], observerCounts, 'no redundant observer broadcast');
  for (const reply of unchanged) socket.deliver(reply); await flush(); editor(h, same.name, same.name);
  for (const raw of ['', ' \t\n ', '\u200b\u202e', '🐱'.repeat(41)]) {
    const request = await command(h, socket, raw), replies = await relay(request); assert.equal(replies.length, 1);
    const error = replies[0]; assert.ok(error?.type === 'error'); assert.equal(error.code, 'bad_request'); socket.deliver(error); await flush();
    editor(h, same.name, raw); notice(h, error.message);
  }
  assert.equal(await hub.req(self.s, { type: 'control:transfer', targetId: host.id }), 'ok'); broadcast();
  const forbidden = await command(h, socket, 'UI has not seen transfer yet'), replies = await relay(forbidden);
  const error = replies.find(message => message.type === 'error'); assert.ok(error?.type === 'error'); assert.equal(error.code, 'forbidden'); socket.deliver(error); await flush(); notice(h, error.message);
  socket.deliver(self.s.last('room:state')!); retired(h); bypass(h);
  assert.equal(await hub.req(host.s, { type: 'room:rename', name: 'Changed while away' }), 'ok');
  assert.equal(await hub.req(host.s, { type: 'control:transfer', targetId: self.id }), 'ok'); broadcast(); socket.deliver(self.s.last('room:state')!); editor(h, 'Changed while away');
  assert.equal(socket.sent.length, baseline.sent + 10); assert.equal(requests(socket).length, 10);
  assert.equal(h.captures.length, 0); assert.equal(StageContext.instances.length, 0); assert.deepEqual(StagePeer.instances, baseline.peers); assert.deepEqual(peer.offers, baseline.offers);
  assert.equal(socket.sent.filter(message => message.type === 'join').length, 1); assert.equal(h.clients.length, 1);
});
