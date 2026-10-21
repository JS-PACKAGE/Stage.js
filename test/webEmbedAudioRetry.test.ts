import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, ParticipantView, ServerMessage } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { Deferred, EmbedSdk, embedApp, flush, type EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { harness, testConfig } from './helpers.ts';

// Whole embed module and real SDK/validator/Hub paths use controlled DOM, sockets and media.
// They establish negotiation ownership and protocol completion, not native accessibility,
// browser SDP interoperability, device permissions, ICE connectivity or audible playback.
const SUCCESS = '音訊連線協商已完成。';
const PENDING = '正在重新協商音訊連線…';
interface View { node(id: string): EmbedNode }
const button = (h: View) => h.node('audio-retry');
const feedback = (h: View) => h.node('audio-retry-status');
function hiddenFeedback(h: View): void { assert.equal(feedback(h).hidden, true); assert.equal(feedback(h).textContent, ''); }
function pendingFeedback(h: View): void { assert.equal(feedback(h).hidden, false); assert.equal(feedback(h).textContent, PENDING); }
function shownFeedback(h: View): void { assert.equal(feedback(h).hidden, false); assert.equal(feedback(h).textContent, SUCCESS); }
function control(h: View, options: { hidden?: boolean; pending?: boolean; disabled?: boolean } = {}): void {
  assert.equal(button(h).hidden, options.hidden ?? false);
  assert.equal(button(h).disabled, options.disabled ?? options.hidden ?? options.pending ?? false);
  assert.equal(button(h).attributes['aria-busy'], String(options.pending ?? false));
}
function force(h: View): void { button(h).hidden = button(h).disabled = false; button(h).invoke(); }
function notice(h: View, message?: string): void {
  assert.equal(h.node('error-notice').hidden, message === undefined);
  assert.equal(h.node('last-error').textContent, message === undefined ? '' : `最近錯誤：${message}`);
}
function installRetry(sdk: EmbedSdk): Deferred[] {
  const work: Deferred[] = [];
  Reflect.set(sdk, 'retryAudioConnection', function (this: EmbedSdk): Promise<void> {
    assert.equal(this, sdk, 'public method retains its SDK receiver');
    const attempt = new Deferred(); work.push(attempt); return attempt.promise;
  });
  return work;
}
async function setup(t: TestContext, overrides: Partial<ParticipantView> = {}) {
  const h = embedApp(), work: Deferred[][] = [];
  t.after(async () => { for (const group of work) for (const attempt of group) if (!attempt.settled) attempt.resolve(); await h.cleanup(); });
  const enter = async (overrides: Partial<ParticipantView> = {}) => {
    const sdk = await h.join(overrides), attempts = installRetry(sdk); work.push(attempts); sdk.snapshot();
    return { sdk, attempts };
  };
  return { ...h, ...await enter(overrides), enter };
}
function snapshot(sdk: EmbedSdk, patch: { roomId?: string; me?: Partial<ParticipantView> } = {}): void {
  assert.ok(sdk.state); assert.ok(sdk.me);
  sdk.state = { ...sdk.state, ...patch, me: { ...sdk.me, ...patch.me } }; sdk.me = sdk.state.me; sdk.emit('state', sdk.state);
}

it('embed declares a native manual retry and separate initially hidden negotiation status outside the join form', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  for (const id of ['audio-retry', 'audio-retry-status']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1);
  const action = html.match(/<button\b[^>]*\bid="audio-retry"[^>]*>重試音訊連線<\/button>/)?.[0]; assert.ok(action);
  assert.match(action, /\btype="button"/); assert.match(action, /\baria-busy="false"/);
  assert.match(action, /\bhidden(?:\s|>)/); assert.match(action, /\bdisabled(?:\s|>)/);
  assert.match(action, /\baria-describedby="audio-retry-status"/); assert.doesNotMatch(action, /aria-pressed|tabindex=/);
  const status = html.match(/<p\b[^>]*\bid="audio-retry-status"[^>]*><\/p>/)?.[0]; assert.ok(status);
  assert.match(status, /\brole="status"/); assert.match(status, /\bhidden(?:\s|>)/); assert.doesNotMatch(status, /alert/);
  assert.ok(html.indexOf(action) > html.indexOf('</form>')); assert.ok(html.indexOf(status) > html.indexOf('</form>'));
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
  assert.match(source, /typeof current\.retryAudioConnection !== 'function'/);
  assert.doesNotMatch(source, /\brestartIce\b|\bgetUserMedia\b|\bRTCPeerConnection\b|\bonnegotiationneeded\b|\bsetLocalDescription\b/);
});

it('embed keeps audio retry inert before a valid owned seat and supports older remote SDKs without a fallback', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); control(h, { hidden: true }); hiddenFeedback(h); force(h); control(h, { hidden: true });
  h.form.submit(); await flush(); const sdk = h.clients[0]!, attempts = installRetry(sdk);
  sdk.emit('error', new Error('Keep entry error')); force(h); control(h, { hidden: true }); notice(h, 'Keep entry error'); assert.equal(attempts.length, 0);
  sdk.snapshot(); control(h); Reflect.set(sdk, 'retryAudioConnection', undefined); sdk.snapshot();
  force(h); control(h, { hidden: true }); hiddenFeedback(h); notice(h, 'Keep entry error');
  Reflect.set(sdk, 'retryAudioConnection', true); sdk.setStatus('live'); force(h); control(h, { hidden: true }); assert.equal(attempts.length, 0);
  assert.equal(sdk.retryCalls, 0); assert.equal(sdk.actions.length, 0); assert.equal(sdk.deviceLists.length, 0);
  assert.equal(h.clients.length, 1); assert.equal(h.clock.timers.length, 0);
});

for (const [role, onStage, handRaised, forceMuted] of [
  ['audience', false, false, false], ['audience', false, true, false], ['speaker', true, false, false],
  ['speaker', true, false, true], ['controller', false, false, false], ['controller', true, false, true],
] as const) for (const status of ['waiting', 'live'] as const) {
  it(`embed admits one explicit retry for ${role}, stage=${onStage}, hand=${handRaised}, forced=${forceMuted}, ${status}`, async t => {
    const h = await setup(t, { role, onStage, handRaised, forceMuted }); h.sdk.setStatus(status); control(h);
    const mainStatus = h.status.textContent; button(h).click(); control(h, { pending: true }); force(h); assert.equal(h.attempts.length, 1);
    h.attempts[0]!.resolve(); await flush(); control(h); shownFeedback(h); assert.equal(h.status.textContent, mainStatus);
    assert.equal(h.sdk.retryCalls, 0); assert.equal(h.sdk.inputSelections.length, 0); assert.equal(h.sdk.deviceLists.length, 0); assert.equal(h.sdk.actions.length, 0);
  });
}

it('embed reserves synchronously before SDK reentry and ordinary snapshots preserve pending work and feedback', async t => {
  const h = await setup(t), retry = Reflect.get(h.sdk, 'retryAudioConnection') as () => Promise<void>;
  Reflect.set(h.sdk, 'retryAudioConnection', () => {
    control(h, { pending: true }); force(h); snapshot(h.sdk, { me: { role: 'speaker', onStage: true } });
    h.sdk.emit('micready', undefined); h.sdk.setStatus('live'); control(h, { pending: true }); return retry.call(h.sdk);
  });
  h.sdk.emit('error', new Error('Previous unrelated error')); const before = h.clock.metrics;
  button(h).click(); notice(h, 'Previous unrelated error'); pendingFeedback(h);
  for (let index = 0; index < 4; index++) { snapshot(h.sdk); h.sdk.emit('micready', undefined); force(h); }
  h.tick(5000); await flush(); assert.equal(h.attempts.length, 1); control(h, { pending: true }); pendingFeedback(h);
  h.sdk.emit('error', new Error('Newer unrelated error')); const mainStatus = h.status.textContent;
  h.attempts[0]!.resolve(); await flush(); shownFeedback(h); notice(h, 'Newer unrelated error'); assert.equal(h.status.textContent, mainStatus);
  snapshot(h.sdk); shownFeedback(h); control(h); assert.deepEqual(h.clock.metrics, before);
  h.node('error-dismiss').click(); notice(h); shownFeedback(h);
  button(h).click(); pendingFeedback(h); control(h, { pending: true }); assert.equal(h.attempts.length, 2);
});

for (const kind of ['throw', 'reject', 'non-Error'] as const) {
  it(`embed current ${kind} failure uses safe existing error reporting and releases pending without automatic retry`, async t => {
    const h = await setup(t), message = '<img src=x onerror=alert(1)> & failure';
    for (const id of ['status', 'last-error', 'audio-retry-status']) Object.defineProperty(h.node(id), 'innerHTML', { set() { assert.fail('feedback must be safe text'); } });
    h.sdk.emit('error', new Error('Previous error'));
    if (kind === 'throw') Reflect.set(h.sdk, 'retryAudioConnection', () => { throw new Error(message); });
    if (kind === 'non-Error') Reflect.set(h.sdk, 'retryAudioConnection', () => Promise.reject({ message }));
    button(h).click(); if (kind === 'reject') h.attempts[0]!.reject(message); await flush();
    control(h); hiddenFeedback(h); notice(h, kind === 'non-Error' ? '操作失敗。' : message);
    assert.equal(h.status.textContent, kind === 'non-Error' ? '操作失敗。' : message);
    snapshot(h.sdk); h.tick(5000); await flush(); assert.equal(h.attempts.length, kind === 'reject' ? 1 : 0);
  });
}

for (const outcome of ['resolve', 'reject'] as const) {
  it(`embed same-seat reconnect keeps the lane until ${outcome}, disables retry and clears feedback`, async t => {
    const h = await setup(t); button(h).click(); h.attempts[0]!.resolve(); await flush(); shownFeedback(h);
    h.sdk.setStatus('reconnecting'); control(h, { disabled: true }); hiddenFeedback(h); force(h); assert.equal(h.attempts.length, 1);
    h.sdk.setStatus('live'); button(h).click(); control(h, { pending: true });
    h.sdk.setStatus('reconnecting'); control(h, { pending: true, disabled: true }); hiddenFeedback(h);
    h.sdk.emit('error', new Error('SDK reconnect error')); force(h); control(h, { pending: true });
    if (outcome === 'resolve') h.attempts[1]!.resolve(); else h.attempts[1]!.reject('Obsolete negotiation failure');
    await flush(); control(h, { disabled: true }); hiddenFeedback(h); notice(h, 'SDK reconnect error'); assert.equal(h.attempts.length, 2);
    h.sdk.setStatus('live'); control(h); hiddenFeedback(h); button(h).click(); assert.equal(h.attempts.length, 3);
  });
}

it('embed same-seat resumed snapshots cannot release an unsettled manual retry', async t => {
  const h = await setup(t); button(h).click(); h.sdk.setStatus('reconnecting'); h.sdk.setStatus('waiting'); snapshot(h.sdk);
  control(h, { pending: true }); force(h); assert.equal(h.attempts.length, 1);
  h.attempts[0]!.resolve(); await flush(); control(h); shownFeedback(h);
});

for (const terminal of ['disconnected', 'closed', 'kicked', 'leave'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  it(`embed ${terminal} retires pending ownership before old ${outcome} and forced callback`, async t => {
    const h = await setup(t); button(h).click();
    if (terminal === 'disconnected') h.sdk.setStatus('disconnected');
    else if (terminal === 'leave') h.leave.click(); else h.sdk.emit(terminal, {});
    await flush(); control(h, { hidden: true }); hiddenFeedback(h); force(h); assert.equal(h.attempts.length, 1);
    h.sdk.snapshot(); force(h); control(h, { hidden: true });
    const { sdk, attempts } = await h.enter(); sdk.emit('error', new Error('Current owner error')); button(h).click(); control(h, { pending: true });
    if (outcome === 'resolve') h.attempts[0]!.resolve(); else h.attempts[0]!.reject('Retired operation error');
    await flush(); control(h, { pending: true }); pendingFeedback(h); notice(h, 'Current owner error'); assert.equal(attempts.length, 1);
    attempts[0]!.resolve(); await flush(); shownFeedback(h); notice(h, 'Current owner error');
  });
}

for (const identity of ['room', 'participant'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  it(`embed ${identity} replacement protects a new pending attempt from old ${outcome}`, async t => {
    const h = await setup(t); button(h).click();
    snapshot(h.sdk, identity === 'room' ? { roomId: 'replacement-room' } : { me: { participantId: 'replacement-seat' } });
    control(h); hiddenFeedback(h); h.sdk.emit('error', new Error('Replacement identity error')); button(h).click(); control(h, { pending: true });
    if (outcome === 'resolve') h.attempts[0]!.resolve(); else h.attempts[0]!.reject('Old identity error');
    await flush(); control(h, { pending: true }); pendingFeedback(h); notice(h, 'Replacement identity error'); assert.equal(h.attempts.length, 2);
    h.attempts[1]!.resolve(); await flush(); shownFeedback(h);
  });
}

it('embed reconnect cannot establish a different owner or retain an old owner across disappearance of state/method', async t => {
  const h = await setup(t); button(h).click(); h.sdk.setStatus('reconnecting'); snapshot(h.sdk, { me: { participantId: 'new-seat' } });
  force(h); control(h, { hidden: true }); h.sdk.emit('error', new Error('Keep connection error'));
  h.attempts[0]!.reject('Retired same-client error'); await flush(); notice(h, 'Keep connection error');
  h.sdk.setStatus('live'); control(h); button(h).click(); Reflect.set(h.sdk, 'retryAudioConnection', undefined); snapshot(h.sdk);
  force(h); control(h, { hidden: true }); h.attempts[1]!.resolve(); await flush(); hiddenFeedback(h);
  const attempts = installRetry(h.sdk); snapshot(h.sdk); control(h); h.sdk.state = null; force(h); control(h, { hidden: true }); assert.equal(attempts.length, 0);
});

it('embed new entry retires pending retry synchronously even while old disconnect is unresolved', async t => {
  const h = await setup(t), stopping = new Deferred(), disconnect = h.sdk.disconnect.bind(h.sdk);
  t.after(() => { if (!stopping.settled) stopping.resolve(); });
  h.sdk.disconnect = async () => { await stopping.promise; await disconnect(); };
  button(h).click(); h.form.submit(); control(h, { hidden: true }); hiddenFeedback(h); force(h); assert.equal(h.attempts.length, 1);
  h.node('audio').play = () => Promise.reject(new Error('Loading new entry error'));
  h.sdk.unlockAudio = () => Promise.reject(new Error('Loading new entry error')); h.node('unlock').click(); await flush(); notice(h, 'Loading new entry error');
  h.attempts[0]!.reject('Old pending retry error'); await flush(); notice(h, 'Loading new entry error'); control(h, { hidden: true });
  stopping.resolve(); await flush(); assert.equal(h.clients.length, 2); control(h, { hidden: true });
});

it('embed cancel before state keeps forced retry inert and preserves later errors', async t => {
  const connecting = new Deferred(); t.mock.method(EmbedSdk.prototype, 'connect', function (this: EmbedSdk) { this.setStatus('waiting'); return connecting.promise; });
  const h = embedApp(); t.after(async () => { if (!connecting.settled) connecting.resolve(); await h.cleanup(); });
  h.form.submit(); await flush(); const sdk = h.clients[0]!, attempts = installRetry(sdk); force(h); assert.equal(attempts.length, 0);
  h.node('cancel-join').click(); control(h, { hidden: true });
  sdk.unlockAudio = () => Promise.reject(new Error('Current manual playback error')); h.node('unlock').click(); await flush();
  notice(h, 'Current manual playback error'); sdk.snapshot(); sdk.setStatus('live'); force(h); control(h, { hidden: true });
  connecting.reject('Cancelled entry error'); await flush(); notice(h, 'Current manual playback error'); assert.equal(attempts.length, 0);
});

it('embed actual SDK → validator → Hub repairs a rejected initial offer on the same joined seat and peer, before join ACK', async t => {
  const config = testConfig(config => { config.rooms.qualityIntervalMs = 0; }), server = harness(config);
  const host = await server.create('Synthetic host'), h = await actualApp(t), firstOffer = Promise.withResolvers<never>();
  let serverWork = Promise.resolve(), offers = 0, joinRequestId: string | undefined;
  let heldJoinAck: ServerMessage | undefined, heldOfferAck: ServerMessage | undefined;
  const negotiate = server.transport.negotiate.bind(server.transport);
  server.transport.negotiate = (...args) => ++offers === 1 ? firstOffer.promise : negotiate(...args);
  const sessions = new Map<StageSocket, Session>();
  const validated: ClientMessage[] = [];
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this); assert.ok(session);
    this.sent.push(message); validated.push(message); if (message.type === 'join') joinRequestId = message.requestId;
    serverWork = serverWork.then(() => server.hub.handle(session, message));
  });
  const answer = new Deferred(), ice = new Deferred(); let answerEntered = 0, iceEntered = 0;
  const installAnswer = StagePeer.prototype.setRemoteDescription;
  t.mock.method(StagePeer.prototype, 'setRemoteDescription', async function (this: StagePeer) {
    answerEntered++; await answer.promise; await installAnswer.call(this);
  });
  t.mock.method(StagePeer.prototype, 'addIceCandidate', async () => { iceEntered++; await ice.promise; });
  t.after(async () => {
    if (!answer.settled) answer.resolve(); if (!ice.settled) ice.resolve(); firstOffer.reject(new Error('fixture cleanup'));
    await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close();
  });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic listener';
  h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  const session: Session = { id: 'audio-retry-embed', send(message) {
    if (message.type === 'ok' && message.requestId === joinRequestId) { heldJoinAck = message; return; }
    if (message.type === 'ok' && socket.sent.some(request => request.type === 'rtc:offer' && request.requestId === message.requestId)) {
      heldOfferAck = message; return;
    }
    if (socket.readyState === StageSocket.OPEN) socket.deliver(message);
  }, close() { socket.close(); } };
  sessions.set(socket, session); server.hub.attach(session);
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'real SDK join');
  await h.tick(100); await h.until(() => offers === 1, 'first real SDK offer');
  const client = h.clients[0]!, peer = StagePeer.instances[0]!, participantId = client.me!.participantId;
  assert.equal(server.hub.isJoined(session), true); assert.equal(h.form.submitButton!.disabled, true, 'the join ACK is still held');
  assert.ok(heldJoinAck); control(h); assert.equal(server.transport.rooms.get(host.roomId)!.subscribers.has(participantId), false);
  // Deliver the initial batched presence state while the SDK's first negotiation is still owned.
  for (const timer of server.timers) if (!timer.cleared && timer.ms === config.rooms.presenceBroadcastMs) { timer.cleared = true; timer.fn(); }
  await flush(); firstOffer.reject(new Error('controlled private initial offer failure')); await flush(); await serverWork; await flush();
  assert.equal(client.status, 'live'); notice(h, 'Bad request'); assert.equal(peer.signalingState, 'have-local-offer');
  await h.tick(1000); assert.equal(offers, 1, 'elapsed time never retries the rejected negotiation');
  const plays = h.audio.plays, pauses = h.audio.pauses, tracks = h.tracks.length, captures = h.captures.length;
  peer.connectionState = 'new';
  button(h).click(); control(h, { pending: true }); pendingFeedback(h); force(h);
  await h.tick(100); await h.until(() => answerEntered === 1 && heldOfferAck !== undefined, 'recovery reaches answer installation and ACK');
  assert.equal(offers, 2); assert.equal(server.transport.rooms.get(host.roomId)!.subscribers.has(participantId), true);
  control(h, { pending: true }); pendingFeedback(h);
  socket.deliver(heldOfferAck!); await flush(); control(h, { pending: true }); pendingFeedback(h);
  answer.resolve(); await h.until(() => iceEntered === 1, 'buffered ICE drain'); control(h, { pending: true }); pendingFeedback(h);
  socket.deliver({ type: 'error', code: 'internal', message: 'Newer independent operation error' });
  ice.resolve(); await h.until(() => !button(h).disabled, 'entire retry promise settles'); shownFeedback(h); notice(h, 'Newer independent operation error');
  assert.equal(iceEntered, 2, 'both buffered candidate and end-of-candidates drain');
  assert.equal(client.me!.participantId, participantId); assert.equal(server.hub.isJoined(session), true);
  assert.equal(StageSocket.instances.length, 1); assert.equal(StagePeer.instances.length, 1); assert.equal(offers, 2);
  assert.equal(validated.filter(message => message.type === 'join').length, 1); assert.equal(validated.filter(message => message.type === 'rtc:offer').length, 2);
  assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.connectionState, 'new', 'negotiation completion does not prove ICE connectivity');
  assert.equal(h.audio.plays, plays); assert.equal(h.audio.pauses, pauses); assert.equal(h.tracks.length, tracks); assert.equal(h.captures.length, captures);
  assert.equal(client.playbackVolume, 0.37); assert.equal(client.playbackMuted, true); assert.equal(h.calls(), 0);
  socket.deliver(heldJoinAck!); await flush(); assert.equal(h.form.submitButton!.disabled, false); shownFeedback(h);
});

it('embed actual SDK waits for ACK after an installed answer without changing microphone/playback behavior', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join({ role: 'audience' });
  const sent: Extract<ClientMessage, { type: 'rtc:offer' }>[] = [];
  t.mock.method(socket, 'send', (data: string) => {
    const message = JSON.parse(data) as ClientMessage; socket.sent.push(message);
    if (message.type === 'rtc:offer') {
      sent.push(message); socket.deliver({ type: 'rtc:answer', fromId: 'server', payload: { type: 'answer', sdp: 'v=0\r\n' } });
    }
  });
  const plays = h.audio.plays; button(h).click(); await h.until(() => sent.length === 1, 'manual offer');
  await flush(); assert.equal(peer.signalingState, 'stable'); control(h, { pending: true }); pendingFeedback(h);
  force(h); assert.equal(sent.length, 1);
  socket.deliver({ type: 'ok', requestId: sent[0]!.requestId }); await flush(); control(h); shownFeedback(h);
  assert.equal(h.audio.plays, plays); assert.equal(h.captures.length, 0); assert.equal(h.calls(), 0); assert.equal(StagePeer.instances.length, 1);
});

it('embed actual SDK socket loss settles public pending while its native offer lock survives, without stale completion feedback', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join({ role: 'audience' }), client = h.clients[0]!;
  const native = new Deferred(), createOffer = peer.createOffer.bind(peer); let entered = 0;
  t.after(() => { if (!native.settled) native.resolve(); });
  t.mock.method(peer, 'createOffer', async () => { entered++; await native.promise; return createOffer(); });
  button(h).click(); await flush(); assert.equal(entered, 1); control(h, { pending: true });
  socket.close(); await flush(); assert.equal(client.status, 'reconnecting'); control(h, { disabled: true }); hiddenFeedback(h);
  await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  resumed.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => resumed.sent.some(message => message.type === 'join'), 'automatic control resume');
  const join = resumed.sent.find(message => message.type === 'join')!;
  resumed.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); resumed.deliver({ type: 'ok', requestId: join.requestId });
  await flush(); control(h); hiddenFeedback(h); button(h).click(); await flush();
  control(h); hiddenFeedback(h); notice(h, '音訊協商進行中，請等待完成後再試。'); assert.equal(entered, 1, 'SDK owns remaining native-operation exclusion');
  native.resolve(); await h.until(() => resumed.sent.some(message => message.type === 'rtc:offer') && peer.signalingState === 'stable', 'old native operation drains');
  await flush(); hiddenFeedback(h); notice(h, '音訊協商進行中，請等待完成後再試。');
  button(h).click(); await h.until(() => entered === 2 && !button(h).disabled, 'new explicit retry after SDK lock drains'); shownFeedback(h);
  notice(h, '音訊協商進行中，請等待完成後再試。'); assert.equal(StagePeer.instances.length, 1); assert.equal(h.captures.length, 0);
});


for (const missing of ['room', 'participant'] as const) {
  it(`embed rejects a forced callback when the current joined state has an empty ${missing} identity`, async t => {
    const h = await setup(t); h.sdk.emit('error', new Error('Preserved invalid-identity error'));
    snapshot(h.sdk, missing === 'room' ? { roomId: '' } : { me: { participantId: '' } });
    force(h); control(h, { hidden: true }); hiddenFeedback(h); notice(h, 'Preserved invalid-identity error'); assert.equal(h.attempts.length, 0);
  });
}

for (const terminal of ['disconnected', 'closed', 'kicked', 'leave', 'reconnecting'] as const) {
  it(`embed synchronous SDK ${terminal} callback retires or disables the attempt before a following throw`, async t => {
    const h = await setup(t); let calls = 0;
    Reflect.set(h.sdk, 'retryAudioConnection', () => {
      calls++; control(h, { pending: true }); pendingFeedback(h);
      if (terminal === 'disconnected' || terminal === 'reconnecting') h.sdk.setStatus(terminal);
      else if (terminal === 'leave') h.leave.click(); else h.sdk.emit(terminal, {});
      throw new Error('Error after synchronous ownership change');
    });
    button(h).click(); await flush();
    control(h, terminal === 'reconnecting' ? { disabled: true } : { hidden: true }); hiddenFeedback(h); notice(h); assert.equal(calls, 1);
  });
}
