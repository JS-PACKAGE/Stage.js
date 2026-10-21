import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { Deferred, embedApp, flush, type EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';

const failure = { name: 'NotAllowedError', message: '麥克風權限遭拒。' };
const originalNotice = `${failure.message}（${failure.name}）`;
const pendingNotice = '重新取得麥克風中…';
const readyNotice = '已取得麥克風。';
const onstage = { role: 'speaker' as const, onStage: true };
function retry(node: EmbedNode, hidden = false, pending = false, disabled = hidden || pending): void {
  assert.equal(node.hidden, hidden); assert.equal(node.disabled, disabled);
  assert.equal(node.textContent, '重試麥克風'); assert.equal(node.attributes['aria-busy'], String(pending));
}
function forceInvoke(node: EmbedNode): void { node.hidden = node.disabled = false; node.invoke(); }
async function setup(t: TestContext) {
  const h = embedApp(); t.after(() => h.cleanup());
  const sdk = await h.join(onstage); sdk.setStatus('live');
  sdk.emit('micerror', failure); retry(h.micRetry);
  return { ...h, sdk };
}

it('whole embed declares an initially hidden native microphone retry action with visible accessible name', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const button = html.match(/<button\b[^>]*\bid="mic-retry"[^>]*>[^<]*<\/button>/)?.[0];
  assert.ok(button, 'onstage capture failure needs an explicit retry control');
  for (const attribute of ['type="button"', 'aria-busy="false"', 'hidden', 'disabled']) assert.ok(button.includes(attribute), attribute);
  assert.match(button, />重試麥克風<\/button>$/);
  assert.doesNotMatch(button, /aria-(?:pressed|label)=|tabindex=/);
});

it('whole embed exposes retry only after current onstage failure and never retries from snapshots or time', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); retry(h.micRetry, true); forceInvoke(h.micRetry);
  h.form.submit(); await flush(); const sdk = h.clients[0]!;
  sdk.emit('micerror', failure); forceInvoke(h.micRetry); retry(h.micRetry, true);
  sdk.snapshot(); sdk.setStatus('live'); sdk.emit('micerror', failure); forceInvoke(h.micRetry); retry(h.micRetry, true);
  sdk.emit('micready', undefined); sdk.snapshot(onstage); retry(h.micRetry, true);
  sdk.emit('micerror', failure); retry(h.micRetry); assert.equal(h.status.textContent, originalNotice);
  for (let n = 0; n < 3; n++) sdk.snapshot(onstage);
  sdk.emit('audioblocked', undefined); h.node('unlock').click(); h.tick(5000); await flush();
  retry(h.micRetry); assert.equal(sdk.retryCalls, 0); assert.equal(sdk.actions.length, 0); assert.equal(h.clock.timers.length, 0);
  sdk.emit('micready', undefined); retry(h.micRetry, true); assert.equal(h.status.textContent, readyNotice);
  assert.equal(sdk.retryCalls, 0);
});

for (const role of ['speaker', 'controller'] as const) for (const forceMuted of [false, true]) {
  it(`whole embed permits explicit capture retry for ${forceMuted ? 'force-muted' : 'unmuted'} onstage ${role}`, async t => {
    const h = await setup(t); h.sdk.snapshot({ role, muted: forceMuted, forceMuted }); retry(h.micRetry);
    h.micRetry.click(); retry(h.micRetry, false, true); assert.equal(h.sdk.retryCalls, 1);
    assert.equal(h.status.textContent, pendingNotice); assert.equal(h.sdk.me!.muted, forceMuted);
    assert.equal(h.sdk.me!.forceMuted, forceMuted); assert.equal(h.sdk.actions.length, 0);
    assert.equal(h.stage.disabled, false, 'capture retry does not block stepping down');
    assert.equal(h.mic.disabled, forceMuted, 'the separate mute control keeps its authoritative gate');
  });
}

it('whole embed reserves one retry synchronously and keeps its own pending gate across state and reconnect', async t => {
  const h = await setup(t);
  h.sdk.retryAdmission = () => { retry(h.micRetry, false, true); forceInvoke(h.micRetry); return true; };
  h.micRetry.click(); retry(h.micRetry, false, true); assert.equal(h.sdk.retryCalls, 1);
  h.sdk.snapshot(); forceInvoke(h.micRetry); h.sdk.setStatus('reconnecting'); retry(h.micRetry, false, true);
  h.sdk.snapshot(); forceInvoke(h.micRetry); h.sdk.setStatus('live'); h.tick(5000); await flush();
  retry(h.micRetry, false, true); assert.equal(h.sdk.retryCalls, 1);
  h.sdk.emit('micerror', { name: 'NotReadableError', message: '麥克風仍無法使用。' }); retry(h.micRetry);
  assert.equal(h.status.textContent, '麥克風仍無法使用。（NotReadableError）');
  h.micRetry.click(); retry(h.micRetry, false, true); assert.equal(h.sdk.retryCalls, 2);
});

it('whole embed requires live status at invocation and restores eligibility without an automatic retry', async t => {
  const h = await setup(t);
  for (const status of ['waiting', 'reconnecting'] as const) {
    h.sdk.setStatus(status); retry(h.micRetry, false, false, true); forceInvoke(h.micRetry);
    retry(h.micRetry, false, false, true); assert.equal(h.sdk.retryCalls, 0);
  }
  h.sdk.setStatus('live'); retry(h.micRetry); assert.equal(h.sdk.retryCalls, 0);
  h.sdk.me!.onStage = false; forceInvoke(h.micRetry); retry(h.micRetry, true);
  h.sdk.snapshot(onstage); retry(h.micRetry, true); h.sdk.emit('micerror', failure); retry(h.micRetry);
  h.sdk.me!.participantId = 'replacement'; forceInvoke(h.micRetry); retry(h.micRetry, true); assert.equal(h.sdk.retryCalls, 0);
});

it('whole embed false admission preserves current feedback and permits another manual attempt', async t => {
  const h = await setup(t); h.sdk.retryAdmission = () => false;
  for (let count = 1; count <= 2; count++) {
    h.micRetry.click(); retry(h.micRetry); assert.equal(h.sdk.retryCalls, count); assert.equal(h.status.textContent, originalNotice);
  }
  h.sdk.retryAdmission = () => { throw new Error('無法要求重試麥克風。'); };
  h.micRetry.click(); retry(h.micRetry); assert.equal(h.status.textContent, '無法要求重試麥克風。');
  h.sdk.retryAdmission = () => true; h.micRetry.click(); retry(h.micRetry, false, true); assert.equal(h.sdk.retryCalls, 4);
});

for (const accepted of [false, true]) for (const event of ['micready', 'micerror'] as const) {
  it(`whole embed synchronous ${event} wins over retry admission ${accepted}`, async t => {
    const h = await setup(t);
    h.sdk.retryAdmission = () => {
      retry(h.micRetry, false, true);
      h.sdk.emit(event, event === 'micready' ? undefined : { name: 'NotFoundError', message: '找不到麥克風。' }); return accepted;
    };
    h.micRetry.click(); assert.equal(h.sdk.retryCalls, 1);
    retry(h.micRetry, event === 'micready');
    assert.equal(h.status.textContent, event === 'micready' ? readyNotice : '找不到麥克風。（NotFoundError）');
  });
}

for (const outcome of ['false', 'true', 'throw'] as const) {
  it(`whole embed a synchronous newer retry owns its pending state after the old admission ${outcome}`, async t => {
    const h = await setup(t);
    h.sdk.retryAdmission = () => {
      h.sdk.emit('micerror', { name: 'NotFoundError', message: '新的擷取失敗。' });
      h.sdk.retryAdmission = () => true; h.micRetry.click();
      if (outcome === 'throw') throw new Error('retired admission failure'); return outcome === 'true';
    };
    h.micRetry.click(); retry(h.micRetry, false, true); assert.equal(h.sdk.retryCalls, 2);
    assert.equal(h.status.textContent, pendingNotice); forceInvoke(h.micRetry); assert.equal(h.sdk.retryCalls, 2);
  });
}

for (const pending of [false, true]) for (const transition of ['offstage', 'participant'] as const) {
  it(`whole embed ${transition} retires ${pending ? 'pending' : 'available'} retry without restoring it on return`, async t => {
    const h = await setup(t); if (pending) h.micRetry.click(); const calls = h.sdk.retryCalls;
    h.sdk.snapshot(transition === 'offstage' ? { onStage: false } : { participantId: 'new-person' });
    retry(h.micRetry, true); forceInvoke(h.micRetry); assert.equal(h.sdk.retryCalls, calls);
    h.sdk.snapshot({ ...onstage, participantId: 'listener' }); retry(h.micRetry, true);
    h.sdk.emit('micerror', failure); retry(h.micRetry); assert.equal(h.sdk.retryCalls, calls);
  });
}

for (const pending of [false, true]) for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const) {
  it(`whole embed ${terminal} retires ${pending ? 'pending' : 'available'} retry and ignores retired capture events`, async t => {
    const h = await setup(t); if (pending) h.micRetry.click(); const calls = h.sdk.retryCalls;
    if (terminal === 'leave') h.leave.click(); else if (terminal === 'disconnected') h.sdk.setStatus(terminal); else h.sdk.emit(terminal, {});
    await flush(); const status = h.status.textContent; retry(h.micRetry, true);
    h.sdk.emit('micerror', failure); h.sdk.emit('micready', undefined); assert.equal(h.status.textContent, status);
    forceInvoke(h.micRetry); retry(h.micRetry, true); assert.equal(h.sdk.retryCalls, calls);
    h.sdk.snapshot(onstage); h.sdk.setStatus('live'); h.sdk.emit('micerror', failure); forceInvoke(h.micRetry);
    retry(h.micRetry, true); assert.equal(h.sdk.retryCalls, calls);
  });
}

for (const accepted of [false, true]) {
  it(`whole embed synchronous leave wins over retry admission ${accepted}`, async t => {
    const h = await setup(t); h.sdk.retryAdmission = () => { h.leave.click(); return accepted; };
    h.micRetry.click(); retry(h.micRetry, true); await flush(); assert.equal(h.status.textContent, '已離開。');
    h.sdk.emit('micerror', failure); h.sdk.emit('micready', undefined); retry(h.micRetry, true);
    assert.equal(h.status.textContent, '已離開。'); assert.equal(h.sdk.retryCalls, 1);
  });
}

for (const replacement of [false, true]) {
  it(`whole embed ${replacement ? 'replacement join' : 'leave'} revokes retry before disconnect settles`, async t => {
    const h = await setup(t), gate = new Deferred(), disconnect = h.sdk.disconnect.bind(h.sdk);
    h.sdk.disconnect = async () => { await gate.promise; await disconnect(); };
    t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); });
    h.micRetry.click(); if (replacement) h.form.submit(); else h.leave.click();
    const status = h.status.textContent; retry(h.micRetry, true);
    h.sdk.emit('micerror', failure); h.sdk.emit('micready', undefined); assert.equal(h.status.textContent, status);
    h.sdk.snapshot(onstage); h.sdk.setStatus('live'); forceInvoke(h.micRetry); retry(h.micRetry, true); assert.equal(h.sdk.retryCalls, 1);
    gate.resolve(); await flush(); retry(h.micRetry, true);
  });
}

for (const leave of [false, true]) {
  it(`whole embed ${leave ? 'leave and rejoin' : 'replacement join'} keeps new pending capture safe from old callbacks`, async t => {
    const h = await setup(t); h.micRetry.click();
    if (leave) { h.leave.click(); await flush(); }
    const current = await h.join(onstage); current.setStatus('live'); current.emit('micerror', failure); h.micRetry.click();
    const status = h.status.textContent;
    h.sdk.emit('micerror', { name: 'NotFoundError', message: 'retired failure' }); h.sdk.emit('micready', undefined);
    h.sdk.snapshot(); h.sdk.setStatus('disconnected'); h.sdk.emit('closed', {}); h.sdk.emit('kicked', {});
    assert.equal(h.status.textContent, status); retry(h.micRetry, false, true); forceInvoke(h.micRetry);
    assert.equal(current.retryCalls, 1); assert.equal(h.sdk.retryCalls, 1);
    current.emit('micerror', failure); retry(h.micRetry); current.emit('micready', undefined); retry(h.micRetry, true);
  });
}

async function failedCapture(t: TestContext, name = 'NotAllowedError') {
  const h = await actualApp(t, { deferCapture: true });
  const { socket, peer } = await h.join({ role: 'audience' });
  const listening = { getTracks: () => [], getAudioTracks: () => [] };
  assert.ok(peer.ontrack); peer.ontrack({ streams: [listening] }); await flush();
  const pauses = h.audio.pauses;
  socket.deliver({ type: 'room:state', ...actualState(onstage) });
  await h.until(() => h.captures.length === 1, 'initial capture'); retry(h.micRetry, true);
  h.captures[0]!.reject(new DOMException('controlled initial failure', name));
  await h.until(() => !h.micRetry.hidden, 'capture failure exposes retry'); retry(h.micRetry); await h.tick();
  assert.equal(h.calls(), 0); assert.equal(h.audio.srcObject, listening); assert.equal(h.audio.pauses, pauses);
  return { ...h, socket, peer, listening, pauses };
}

for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
  it(`whole embed actual SDK retries ${name} only manually, retaining its seat and clearing pending before sender install`, async t => {
    const h = await failedCapture(t, name), { socket, peer } = h;
    assert.match(h.status.textContent, new RegExp(name)); assert.equal(peer.transceiver.sender.track, null);
    assert.equal(peer.transceiver.direction, 'recvonly');
    for (let n = 0; n < 3; n++) socket.deliver({ type: 'room:state', ...actualState(onstage) });
    h.mic.click(); await h.tick(); const mute = socket.sent.find(message => message.type === 'mic:mute'); assert.ok(mute);
    socket.deliver({ type: 'room:state', ...actualState({ ...onstage, muted: true, forceMuted: true }) });
    socket.deliver({ type: 'ok', requestId: mute.requestId }); await h.tick(5000);
    assert.equal(h.captures.length, 1, 'snapshots, mute and time do not retry failed capture'); retry(h.micRetry);
    h.micRetry.click(); retry(h.micRetry, false, true); forceInvoke(h.micRetry); assert.equal(h.calls(), 1);
    await h.until(() => h.captures.length === 2, 'second explicit capture');
    assert.deepEqual(h.captures[1]!.constraints, { audio: { channelCount: 1, sampleRate: 48000,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    socket.deliver({ type: 'room:state', ...actualState({ ...onstage, muted: true, forceMuted: true }) });
    await h.tick(10); retry(h.micRetry, false, true); assert.equal(h.captures.length, 2);
    h.captures[1]!.reject(new DOMException('controlled repeat failure', 'NotReadableError'));
    await h.until(() => !h.micRetry.disabled, 'repeated denial restores manual retry'); retry(h.micRetry); await h.tick();
    assert.match(h.status.textContent, /NotReadableError/);
    peer.gate = new Deferred(); const offers = peer.offers.length;
    h.micRetry.click(); await h.until(() => h.captures.length === 3, 'third explicit capture');
    const track = h.captures[2]!.resolve(); await h.until(() => peer.gateEntered, 'micready before sender installation');
    assert.equal(h.ready(), 1); retry(h.micRetry, true); assert.equal(h.status.textContent, readyNotice);
    assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.transceiver.direction, 'recvonly');
    assert.equal(peer.offers.length, offers, 'capture feedback is not publication or negotiation completion');
    assert.equal(h.audio.srcObject, h.listening); assert.equal(h.audio.pauses, h.pauses);
    assert.equal(h.audio.volume, 0.37); assert.equal(h.audio.muted, true); forceInvoke(h.micRetry); assert.equal(h.calls(), 2);
    peer.gate.resolve();
    await h.until(() => peer.transceiver.sender.track === track && peer.transceiver.direction === 'sendrecv' && peer.signalingState === 'stable', 'sender installation');
    assert.equal(track.enabled, false); assert.equal(track.stops, 0);
    assert.equal(h.clients[0]!.me!.participantId, 'guest'); assert.equal(h.clients[0]!.me!.onStage, true);
    assert.equal(StagePeer.instances.length, 1); assert.equal(StageSocket.instances.length, 1); assert.equal(h.captures.length, 3);
  });
}

it('whole embed actual SDK reports sender-install failure after capture readiness without claiming publication or auto-retrying', async t => {
  const h = await failedCapture(t), { peer } = h; peer.gate = new Deferred(); const offers = peer.offers.length;
  h.micRetry.click(); await h.until(() => h.captures.length === 2, 'explicit retry capture'); h.captures[1]!.resolve();
  await h.until(() => peer.gateEntered, 'held sender install'); retry(h.micRetry, true); assert.equal(h.status.textContent, readyNotice);
  peer.gate.reject('受控的音軌安裝失敗。');
  await h.until(() => h.status.textContent === '受控的音軌安裝失敗。', 'generic installation error');
  retry(h.micRetry, true); await h.tick(5000); assert.equal(h.captures.length, 2); assert.equal(h.calls(), 1);
  assert.equal(peer.transceiver.sender.track, null); assert.equal(peer.transceiver.direction, 'recvonly'); assert.equal(peer.offers.length, offers);
  assert.equal(h.audio.srcObject, h.listening); assert.equal(h.audio.pauses, h.pauses);
});

for (const pending of [false, true]) {
  it(`whole embed actual SDK same-client reconnect preserves ${pending ? 'pending' : 'available'} retry without extra capture`, async t => {
    const h = await failedCapture(t), client = h.clients[0]!;
    if (pending) { h.micRetry.click(); await h.until(() => h.captures.length === 2, 'pending retry'); }
    const captures = h.captures.length, calls = h.calls(); h.socket.close(); await flush();
    assert.equal(client.status, 'reconnecting'); retry(h.micRetry, false, pending, true); forceInvoke(h.micRetry); assert.equal(h.calls(), calls);
    await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, h.socket);
    resumed.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
    await h.until(() => resumed.sent.some(message => message.type === 'join'), 'resume join');
    const join = resumed.sent.find(message => message.type === 'join')!;
    resumed.deliver({ type: 'room:state', ...actualState(onstage) }); resumed.deliver({ type: 'ok', requestId: join.requestId }); await h.tick();
    assert.equal(h.clients.length, 1); assert.equal(h.clients[0], client); assert.equal(StagePeer.instances.length, 1);
    assert.equal(h.captures.length, captures); retry(h.micRetry, false, pending); const status = h.status.textContent;
    h.socket.deliver({ type: 'error', code: 'forbidden', message: 'retired socket error' }); await flush(); assert.equal(h.status.textContent, status);
    if (!pending) { h.micRetry.click(); await h.until(() => h.captures.length === 2, 'manual retry after resume'); }
    const track = h.captures[1]!.resolve(); await h.until(() => h.peer.transceiver.sender.track === track, 'resumed capture installation');
    assert.equal(h.ready(), 1); retry(h.micRetry, true); assert.equal(h.calls(), 1); assert.equal(h.captures.length, 2);
  });
}

for (const transition of ['offstage', 'leave and rejoin', 'replacement join'] as const) {
  it(`whole embed actual SDK ${transition} disposes a late retry grant and suppresses retired socket feedback`, async t => {
    const h = await failedCapture(t); h.micRetry.click(); await h.until(() => h.captures.length === 2, 'pending capture');
    if (transition === 'offstage') h.socket.deliver({ type: 'room:state', ...actualState() });
    else {
      if (transition === 'leave and rejoin') { h.leave.click(); await flush(); }
      await h.join({ role: 'audience' });
    }
    retry(h.micRetry, true); const status = h.status.textContent, track = h.captures[1]!.resolve(); await flush();
    assert.equal(track.stops, 1); assert.equal(h.ready(), 0); assert.equal(h.status.textContent, status);
    retry(h.micRetry, true); forceInvoke(h.micRetry); assert.equal(h.calls(), 1); assert.equal(h.captures.length, 2);
    if (transition !== 'offstage') {
      h.socket.deliver({ type: 'error', code: 'forbidden', message: 'retired socket error' });
      h.socket.deliver({ type: 'room:state', ...actualState(onstage) }); await flush(); assert.equal(h.status.textContent, status);
      assert.equal(StagePeer.instances.at(-1)!.transceiver.sender.track, null);
    } else assert.equal(h.peer.connectionState, 'connected');
  });
}
