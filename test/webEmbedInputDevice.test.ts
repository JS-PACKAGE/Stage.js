import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { Deferred, embedApp, flush, type EmbedDevices, type EmbedNode, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageContext, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';

// The whole production embed and existing public SDK run against controlled DOM/socket/media
// boundaries. These checks do not claim native browser rendering, permissions or real hardware.
interface View { node(id: string): EmbedNode }
type Kind = 'refresh' | 'apply';
const select = (h: View) => h.node('microphone-device');
const button = (h: View, kind: Kind) => h.node(`microphone-${kind}`);
const devices = (...ids: string[]): EmbedDevices => ({ inputs: ids.map(deviceId => ({ kind: 'audioinput', deviceId, label: `Label ${deviceId}` })), outputs: [] });
const list = (sdk: EmbedSdk) => { const work = sdk.deviceLists.at(-1); assert.ok(work); return work; };
const selection = (sdk: EmbedSdk) => { const work = sdk.inputSelections.at(-1); assert.ok(work); return work; };
function picker(h: View, draft = '', pending?: Kind, disabled = Boolean(pending)): void {
  assert.equal(h.node('microphone-panel').hidden, false);
  assert.equal(select(h).value, draft); assert.equal(select(h).disabled, disabled);
  for (const kind of ['refresh', 'apply'] as const) {
    assert.equal(button(h, kind).disabled, disabled); assert.equal(button(h, kind).attributes['aria-busy'], String(pending === kind));
  }
}
function retired(h: View): void {
  assert.equal(h.node('microphone-panel').hidden, true); assert.equal(select(h).value, '');
  assert.equal(select(h).disabled, true); assert.deepEqual(select(h).children.map(option => option.value), ['']);
  for (const kind of ['refresh', 'apply'] as const) {
    assert.equal(button(h, kind).disabled, true); assert.equal(button(h, kind).attributes['aria-busy'], 'false');
  }
}
function force(h: View, kind: Kind): void { button(h, kind).hidden = button(h, kind).disabled = false; button(h, kind).invoke(); }
function forceChange(h: View, value: string): void { select(h).disabled = false; select(h).value = value; select(h).invokeChange(); }
function notice(h: View, message: string): void {
  assert.equal(h.node('error-notice').hidden, false); assert.equal(h.node('last-error').textContent, `最近錯誤：${message}`);
}
async function setup(t: TestContext, overrides: Parameters<ReturnType<typeof embedApp>['join']>[0] = {}) {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(overrides); return { ...h, sdk };
}
async function enumerate(h: View, sdk: EmbedSdk, value: EmbedDevices = devices('usb-a', 'usb-b')): Promise<void> {
  button(h, 'refresh').click(); list(sdk).resolve(value); await flush();
}
function mutateRoom(sdk: EmbedSdk, roomId: string): void { assert.ok(sdk.state); sdk.state = { ...sdk.state, roomId }; sdk.emit('state', sdk.state); }

it('embed HTML declares a hidden labeled manual microphone draft with separate accessible refresh/apply actions', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  for (const id of ['microphone-panel', 'microphone-device', 'microphone-refresh', 'microphone-apply', 'microphone-draft-notice']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `unique ${id}`);
  }
  const panel = html.match(/<div\b[^>]*\bid="microphone-panel"[^>]*>[\s\S]*?<\/div>/)?.[0]; assert.ok(panel);
  assert.match(panel, /^<div\b[^>]*\bhidden(?:\s|>)/);
  assert.match(panel, /<label\b[^>]*\bfor="microphone-device"[^>]*>[^<]*草稿/);
  assert.match(panel, /<select\b[^>]*\bid="microphone-device"[^>]*\bdisabled(?:\s|>)/);
  assert.match(panel, /<option\b[^>]*\bvalue=""[^>]*>[^<]*預設[^<]*<\/option>/);
  assert.match(panel, /aria-describedby="microphone-draft-notice"/);
  for (const kind of ['refresh', 'apply'] as const) {
    const action = panel.match(new RegExp(`<button\\b[^>]*\\bid="microphone-${kind}"[^>]*>[^<]+<\\/button>`))?.[0]; assert.ok(action);
    assert.match(action, /\btype="button"/); assert.match(action, /\baria-busy="false"/); assert.match(action, /\bdisabled(?:\s|>)/);
    assert.doesNotMatch(action, /aria-pressed|tabindex=/);
  }
  assert.ok(html.indexOf(panel) > html.indexOf('</form>'));
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:local|session)Storage|\bgetUserMedia\b|\benumerateDevices\b|\bdevicechange\b|\btestMicrophone\b/);
});

it('whole embed never enumerates/applies before explicit actions, including entry, snapshots, unlock and elapsed time', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); retired(h); force(h, 'refresh'); force(h, 'apply'); forceChange(h, 'injected'); retired(h);
  h.form.submit(); await flush(); const sdk = h.clients[0]!; retired(h); force(h, 'refresh'); force(h, 'apply'); retired(h);
  sdk.snapshot(); picker(h); sdk.setStatus('live');
  for (let count = 0; count < 3; count++) sdk.snapshot();
  h.node('unlock').click(); sdk.emit('micready', undefined); h.tick(5000); await flush(); picker(h);
  assert.equal(sdk.deviceLists.length, 0); assert.equal(sdk.inputSelections.length, 0); assert.equal(sdk.actions.length, 0); assert.equal(sdk.retryCalls, 0);
  assert.equal(h.clock.timers.length, 0);
});

for (const [role, onStage, handRaised, forceMuted] of [
  ['audience', false, false, false], ['audience', false, true, false], ['speaker', true, false, false],
  ['speaker', true, false, true], ['controller', false, false, false], ['controller', true, false, false], ['controller', true, false, true],
] as const) {
  it(`whole embed explicit default input works for ${role}, stage=${onStage}, hand=${handRaised}, forced=${forceMuted}`, async t => {
    const h = await setup(t, { role, onStage, handRaised, forceMuted, muted: forceMuted }); picker(h);
    assert.equal(h.sdk.status, 'waiting', 'state before media-live is sufficient');
    const status = h.status.textContent; button(h, 'apply').click(); picker(h, '', 'apply'); assert.equal(selection(h.sdk).deviceId, '');
    assert.equal(h.sdk.deviceLists.length, 0); selection(h.sdk).work.resolve(); await flush(); picker(h);
    assert.equal(h.status.textContent, status, 'setter settlement cannot claim capture or an active device');
    assert.equal(h.sdk.me!.forceMuted, forceMuted); assert.equal(h.sdk.actions.length, 0); assert.equal(h.sdk.retryCalls, 0);
  });
}

it('whole embed refresh safely renders opaque IDs, anonymous labels, duplicates, output filtering and missing drafts', async t => {
  const h = await setup(t), raw = ' \tusb<&"\'雪\n ', htmlLabel = '<img src=x onerror=alert(1)> & "';
  await enumerate(h, h.sdk, { inputs: [
    { kind: 'audioinput', deviceId: '', label: 'private anonymous name' },
    { kind: 'audioinput', deviceId: raw, label: htmlLabel },
    { kind: 'audioinput', deviceId: raw, label: 'duplicate label must not replace first' },
    { kind: 'audioinput', deviceId: 'anonymous', label: '  \t' },
    { kind: 'audiooutput', deviceId: 'not-input', label: 'output' },
  ], outputs: [{ kind: 'audiooutput', deviceId: 'other-output', label: 'Output' }] });
  assert.deepEqual(select(h).children.map(option => option.value), ['', raw, 'anonymous']);
  assert.equal(select(h).children[1]!.textContent, htmlLabel); assert.match(select(h).children[2]!.textContent, /^麥克風 \d+$/);
  assert.ok(select(h).children.every(option => !Object.hasOwn(option, 'innerHTML')), 'device labels are plain text');
  select(h).change(raw); picker(h, raw); assert.equal(h.sdk.inputSelections.length, 0);
  h.sdk.snapshot({ role: 'speaker', onStage: true }); picker(h, raw);
  button(h, 'apply').click(); assert.equal(selection(h.sdk).deviceId, raw); selection(h.sdk).work.resolve(); await flush();
  await enumerate(h, h.sdk, devices()); picker(h, raw);
  assert.deepEqual(select(h).children.map(option => option.value), ['', raw]);
  assert.equal(select(h).children[1]!.disabled, true); assert.equal(select(h).children[1]!.textContent, '先前選擇（目前清單未提供）');
  button(h, 'apply').click(); assert.equal(selection(h.sdk).deviceId, raw, 'a retained missing draft is still explicit SDK preference');
  selection(h.sdk).work.resolve(); await flush(); select(h).change(''); button(h, 'apply').click(); assert.equal(selection(h.sdk).deviceId, '');
});

it('whole embed rejects forced unlisted draft changes without altering the owned selection or prior error', async t => {
  const h = await setup(t); await enumerate(h, h.sdk); select(h).change('usb-a'); h.sdk.emit('error', new Error('Keep choice error'));
  forceChange(h, '<unlisted>'); picker(h, 'usb-a'); notice(h, 'Keep choice error');
  button(h, 'apply').click(); assert.equal(selection(h.sdk).deviceId, 'usb-a');
});

for (const kind of ['refresh', 'apply'] as const) {
  it(`whole embed ${kind} reserves the shared lane before synchronous SDK callbacks and survives stage/state/micready redraws`, async t => {
    const h = await setup(t); await enumerate(h, h.sdk); select(h).change('usb-a');
    let calls = 0;
    const callback = () => {
      calls++; picker(h, 'usb-a', kind); force(h, 'refresh'); force(h, 'apply'); forceChange(h, 'usb-b');
      h.sdk.snapshot({ role: 'speaker', onStage: true }); h.sdk.emit('micready', undefined); picker(h, 'usb-a', kind);
      h.sdk.snapshot({ role: 'controller', onStage: false }); picker(h, 'usb-a', kind);
    };
    if (kind === 'refresh') { const method = h.sdk.listAudioDevices.bind(h.sdk); h.sdk.listAudioDevices = () => { callback(); return method(); }; }
    else { const method = h.sdk.setInputDevice.bind(h.sdk); h.sdk.setInputDevice = value => { callback(); return method(value); }; }
    button(h, kind).click(); picker(h, 'usb-a', kind); h.tick(5000); await flush(); picker(h, 'usb-a', kind);
    assert.equal(calls, 1); assert.equal(h.sdk.deviceLists.length, kind === 'refresh' ? 2 : 1); assert.equal(h.sdk.inputSelections.length, kind === 'apply' ? 1 : 0);
    if (kind === 'refresh') list(h.sdk).resolve(devices('usb-a', 'usb-b')); else selection(h.sdk).work.resolve();
    await flush(); picker(h, 'usb-a'); assert.equal(calls, 1);
  });
}

for (const kind of ['refresh', 'apply'] as const) for (const failure of ['reject', 'throw', 'missing method'] as const) {
  it(`whole embed ${kind} ${failure} releases its lane without automatic retry or discarding the draft`, async t => {
    const h = await setup(t); await enumerate(h, h.sdk); select(h).change('usb-b'); h.sdk.emit('error', new Error('Previous failure'));
    const method = kind === 'refresh' ? 'listAudioDevices' : 'setInputDevice'; const original = h.sdk[method].bind(h.sdk);
    if (failure === 'throw') Reflect.set(h.sdk, method, () => { throw new Error('Current device failure'); });
    if (failure === 'missing method') Reflect.set(h.sdk, method, undefined);
    button(h, kind).click();
    if (failure === 'reject') { notice(h, 'Previous failure'); if (kind === 'refresh') list(h.sdk).reject('Current device failure'); else selection(h.sdk).work.reject('Current device failure'); }
    await flush(); picker(h, 'usb-b');
    if (failure === 'missing method') assert.equal(h.node('error-notice').hidden, false); else notice(h, 'Current device failure');
    const before = h.sdk.deviceLists.length + h.sdk.inputSelections.length; h.sdk.snapshot(); h.tick(5000); await flush();
    assert.equal(h.sdk.deviceLists.length + h.sdk.inputSelections.length, before);
    Reflect.set(h.sdk, method, original); button(h, kind).click(); picker(h, 'usb-b', kind);
    assert.equal(h.sdk.deviceLists.length + h.sdk.inputSelections.length, before + 1);
  });
}

for (const kind of ['refresh', 'apply'] as const) for (const outcome of ['resolve', 'reject'] as const) for (const recovered of [false, true]) {
  it(`whole embed ${kind} ${outcome} ${recovered ? 'after' : 'during'} reconnect retains same-seat draft and isolates the lane`, async t => {
    const h = await setup(t); await enumerate(h, h.sdk); select(h).change('usb-a'); button(h, kind).click();
    h.sdk.setStatus('reconnecting'); picker(h, 'usb-a', kind); h.sdk.emit('error', new Error('Keep recovery error'));
    force(h, 'refresh'); force(h, 'apply'); forceChange(h, 'usb-b'); picker(h, 'usb-a', kind);
    h.sdk.snapshot({ role: 'controller', onStage: true }); picker(h, 'usb-a', kind);
    if (recovered) h.sdk.setStatus('live');
    if (kind === 'refresh') { if (outcome === 'resolve') list(h.sdk).resolve(devices('usb-b')); else list(h.sdk).reject('Device request failed'); }
    else { if (outcome === 'resolve') selection(h.sdk).work.resolve(); else selection(h.sdk).work.reject('Device request failed'); }
    await flush(); picker(h, 'usb-a', undefined, !recovered);
    notice(h, outcome === 'reject' && recovered ? 'Device request failed' : 'Keep recovery error');
    h.sdk.setStatus('live'); picker(h, 'usb-a');
    const before = h.sdk.deviceLists.length + h.sdk.inputSelections.length; h.tick(5000); await flush(); assert.equal(h.sdk.deviceLists.length + h.sdk.inputSelections.length, before);
  });
}

for (const mutation of ['state cleared', 'disconnected', 'reconnecting'] as const) {
  it(`whole embed forced callbacks reread current ${mutation}, preserve errors and never invoke stale SDK work`, async t => {
    const h = await setup(t); await enumerate(h, h.sdk); select(h).change('usb-a'); h.sdk.emit('error', new Error('Keep admission error'));
    if (mutation === 'state cleared') h.sdk.state = null;
    else h.sdk.status = mutation;
    const oldLists = h.sdk.deviceLists.length; forceChange(h, 'usb-b'); force(h, 'refresh'); force(h, 'apply');
    assert.equal(h.sdk.inputSelections.length, 0); assert.equal(h.sdk.deviceLists.length, oldLists); notice(h, 'Keep admission error');
    if (mutation === 'reconnecting') picker(h, 'usb-a', undefined, true);
    else retired(h);
  });
}

for (const kind of ['refresh', 'apply'] as const) for (const replacement of ['participant', 'room', 'new entry'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole embed retired ${kind} ${outcome} cannot touch pending ${replacement} owner`, async t => {
    const h = await setup(t); await enumerate(h, h.sdk); select(h).change('usb-a'); button(h, kind).click();
    const old = kind === 'refresh' ? list(h.sdk) : selection(h.sdk).work;
    let current = h.sdk;
    if (replacement === 'participant') h.sdk.snapshot({ participantId: 'new-seat' });
    else if (replacement === 'room') mutateRoom(h.sdk, 'other-room');
    else current = await h.join();
    picker(h); await enumerate(h, current, devices('fresh')); select(h).change('fresh'); button(h, kind).click();
    current.emit('error', new Error('Keep new owner error')); picker(h, 'fresh', kind);
    if (outcome === 'reject') old.reject('retired device failure'); else if (kind === 'refresh') (old as ReturnType<typeof list>).resolve(devices('stale')); else (old as Deferred).resolve();
    await flush(); picker(h, 'fresh', kind); notice(h, 'Keep new owner error');
    assert.deepEqual(select(h).children.map(option => option.value), ['', 'fresh']);
  });
}

for (const kind of ['refresh', 'apply'] as const) for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const) {
  it(`whole embed ${terminal} retires pending ${kind}, ignoring late settlements and old callbacks`, async t => {
    const h = await setup(t); await enumerate(h, h.sdk); select(h).change('usb-a'); button(h, kind).click();
    const old = kind === 'refresh' ? list(h.sdk) : selection(h.sdk).work;
    if (terminal === 'leave') h.leave.click(); else if (terminal === 'disconnected') h.sdk.setStatus('disconnected');
    else h.sdk.emit(terminal, { reason: 'shutdown' });
    await flush(); retired(h); const status = h.status.textContent;
    old.reject('late device failure'); await flush(); retired(h); assert.equal(h.status.textContent, status);
    h.sdk.emit('micready', undefined); h.sdk.emit('micerror', { name: 'NotFoundError', message: 'late capture failure' });
    force(h, 'refresh'); force(h, 'apply'); forceChange(h, 'usb-b'); retired(h); assert.equal(h.status.textContent, status);
    assert.equal(h.sdk.inputSelections.length, kind === 'apply' ? 1 : 0);
    const current = await h.join(); picker(h); button(h, 'apply').click(); assert.equal(selection(current).deviceId, '');
  });
}

it('whole embed cancel before initial state never creates an input owner and cannot resurrect one through late SDK state', async t => {
  const connection = new Deferred(), h = embedApp(); t.after(() => h.cleanup());
  h.form.submit(); await flush(); const old = h.clients[0]!;
  // A fresh entry waits for the previous public disconnect so cancellation remains offered.
  const original = old.disconnect.bind(old); old.disconnect = async () => { await connection.promise; await original(); };
  h.form.submit(); await flush(); retired(h); h.node('cancel-join').click(); retired(h); connection.resolve(); await flush();
  old.snapshot(); old.emit('micready', undefined); old.emit('error', new Error('cancelled callback')); retired(h);
  const current = await h.join(); picker(h); assert.equal(current.deviceLists.length, 0); assert.equal(current.inputSelections.length, 0);
});

it('whole embed input preference and microphone retry keep independent reservations and preserve mic failure feedback', async t => {
  const h = await setup(t, { role: 'speaker', onStage: true }); h.sdk.setStatus('live');
  await enumerate(h, h.sdk); select(h).change('usb-b'); h.sdk.emit('micerror', { name: 'NotFoundError', message: '找不到麥克風。' });
  const failure = h.status.textContent; button(h, 'apply').click(); picker(h, 'usb-b', 'apply');
  assert.equal(h.micRetry.disabled, false); assert.equal(h.status.textContent, failure);
  h.micRetry.click(); assert.equal(h.sdk.retryCalls, 1); assert.equal(h.micRetry.attributes['aria-busy'], 'true'); picker(h, 'usb-b', 'apply');
  h.sdk.emit('micready', undefined); picker(h, 'usb-b', 'apply'); assert.equal(h.micRetry.hidden, true);
  selection(h.sdk).work.resolve(); await flush(); picker(h, 'usb-b'); assert.equal(h.sdk.actions.length, 0);
});

// Actual SDK tests deliberately drive public embed controls, never its private state.
async function actualDevices(h: Awaited<ReturnType<typeof actualApp>>, ids: string[]): Promise<{ calls(): number }> {
  let calls = 0;
  Object.assign(navigator.mediaDevices, { async enumerateDevices() { calls++; return devices(...ids).inputs; } });
  button(h, 'refresh').click(); await h.until(() => !button(h, 'refresh').disabled, 'explicit device enumeration');
  assert.equal(calls, 1); return { calls: () => calls };
}
async function actualSelect(h: Awaited<ReturnType<typeof actualApp>>, id: string): Promise<void> {
  select(h).change(id); button(h, 'apply').click(); await h.until(() => !button(h, 'apply').disabled, 'input setter settlement');
}
function constraint(h: Awaited<ReturnType<typeof actualApp>>, index: number): unknown {
  return (h.captures[index]!.constraints as { audio: { deviceId?: unknown } }).audio.deviceId;
}

it('actual SDK whole embed audience preselect captures nothing; muted live switch keeps peer, mute and offer count', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join({ role: 'audience' });
  const enumerations = await actualDevices(h, ['usb-a', 'usb-b']); const frames = socket.sent.length;
  await actualSelect(h, 'usb-a'); assert.equal(h.captures.length, 0); assert.equal(socket.sent.length, frames); assert.equal(StageContext.instances.length, 0);
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true }) });
  await h.until(() => h.captures.length === 1 && peer.transceiver.sender.track !== null && peer.signalingState === 'stable', 'selected first capture');
  assert.deepEqual(constraint(h, 0), { exact: 'usb-a' }); const original = peer.transceiver.sender.track!; assert.equal(original.enabled, false);
  await flush(); const before = socket.sent.length, offers = peer.offers.length;
  await actualSelect(h, 'usb-b'); assert.equal(h.captures.length, 2); assert.deepEqual(constraint(h, 1), { exact: 'usb-b' });
  assert.equal(original.stopped, true); assert.equal(peer.transceiver.sender.track, h.tracks[1]); assert.equal(peer.transceiver.sender.track!.enabled, false);
  assert.equal(StagePeer.instances.length, 1); assert.equal(peer.offers.length, offers); assert.equal(socket.sent.length, before); assert.equal(enumerations.calls(), 1);
  await actualSelect(h, ''); assert.equal(constraint(h, 2), undefined); assert.equal(peer.offers.length, offers); assert.equal(peer.transceiver.sender.track!.enabled, false);
});

it('actual SDK whole embed setter queues before independent microphone retry and retry captures the newly selected input', async t => {
  const h = await actualApp(t, { deferCapture: true }), { socket, peer } = await h.join({ role: 'audience' });
  await actualDevices(h, ['replacement-usb']); socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) });
  await h.until(() => h.captures.length === 1, 'initial permission wait');
  h.captures[0]!.reject(new DOMException('controlled missing device', 'NotFoundError'));
  await h.until(() => !h.micRetry.hidden && !h.micRetry.disabled, 'failure exposes independent retry');
  const frames = socket.sent.filter(message => message.type !== 'rtc:offer').length;
  select(h).change('replacement-usb'); button(h, 'apply').click(); picker(h, 'replacement-usb', 'apply'); h.micRetry.click();
  await h.until(() => h.captures.length === 2, 'retry follows preference queue');
  assert.deepEqual(constraint(h, 1), { exact: 'replacement-usb' }); assert.equal(h.calls(), 1); assert.equal(h.micRetry.disabled, true);
  h.captures[1]!.resolve(); await h.until(() => peer.transceiver.sender.track !== null && h.micRetry.hidden, 'retry installs');
  picker(h, 'replacement-usb'); assert.equal(StagePeer.instances.length, 1); assert.equal(socket.sent.filter(message => message.type !== 'rtc:offer').length, frames);
});

for (const failure of ['capture', 'sender'] as const) {
  it(`actual SDK whole embed healthy replacement ${failure} failure retains old track and preference for later promotion`, async t => {
    const h = await actualApp(t, { deferCapture: true }), { socket, peer } = await h.join({ role: 'audience' });
    await actualDevices(h, ['original-usb', 'unavailable-usb']); await actualSelect(h, 'original-usb');
    socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true }) });
    await h.until(() => h.captures.length === 1, 'original capture'); h.captures[0]!.resolve();
    await h.until(() => peer.transceiver.sender.track !== null && peer.offers.at(-1) === 'sendrecv' && peer.signalingState === 'stable', 'original negotiation'); await flush();
    const prior = peer.transceiver.sender.track!, before = socket.sent.length, offers = peer.offers.length;
    if (failure === 'sender') peer.gate = new Deferred();
    select(h).change('unavailable-usb'); button(h, 'apply').click();
    await h.until(() => h.captures.length === 2, 'replacement capture');
    if (failure === 'capture') h.captures[1]!.reject(new DOMException('controlled capture failure', 'NotAllowedError'));
    else { h.captures[1]!.resolve(); await h.until(() => peer.gateEntered, 'sender gate'); peer.gate!.reject('controlled sender failure'); }
    await h.until(() => !button(h, 'apply').disabled, 'failed setter releases'); peer.gate = undefined;
    assert.equal(peer.transceiver.sender.track, prior); assert.equal(prior.stopped, false); assert.equal(prior.enabled, false);
    picker(h, 'unavailable-usb'); assert.equal(h.node('error-notice').hidden, false); assert.equal(h.micRetry.hidden, true);
    assert.equal(socket.sent.length, before); assert.equal(peer.offers.length, offers);
    socket.deliver({ type: 'room:state', ...actualState({ role: 'audience', onStage: false }) });
    socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true }) });
    await h.until(() => h.captures.length === 3, 'subsequent stage capture'); assert.deepEqual(constraint(h, 2), { exact: 'original-usb' });
    h.captures[2]!.resolve(); await h.until(() => peer.transceiver.sender.track === h.tracks.at(-1), 'subsequent sender');
    button(h, 'apply').click(); await h.until(() => h.captures.length === 4, 'explicit replacement retry'); h.captures[3]!.resolve();
    await h.until(() => !button(h, 'apply').disabled, 'retry setter complete'); assert.deepEqual(constraint(h, 3), { exact: 'unavailable-usb' });
    assert.equal(peer.transceiver.sender.track!.enabled, false); assert.equal(StagePeer.instances.length, 1);
  });
}

it('actual SDK whole embed same-seat stage exit/re-entry retains a pending draft without claiming its stale fulfillment captured it', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join({ role: 'speaker', onStage: true });
  await actualDevices(h, ['retained-usb', 'retired-candidate']); await actualSelect(h, 'retained-usb');
  const gate = peer.gate = new Deferred(); select(h).change('retired-candidate'); button(h, 'apply').click();
  await h.until(() => peer.gateEntered, 'candidate replaceTrack held'); picker(h, 'retired-candidate', 'apply');
  socket.deliver({ type: 'room:state', ...actualState({ role: 'audience', onStage: false }) }); picker(h, 'retired-candidate', 'apply');
  socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) }); picker(h, 'retired-candidate', 'apply');
  const candidate = h.tracks[2]!; assert.equal(candidate.stopped, true); gate.resolve();
  await h.until(() => h.captures.length === 4 && peer.transceiver.sender.track === h.tracks[3], 'fresh stage capture');
  assert.deepEqual(constraint(h, 3), { exact: 'retained-usb' }); picker(h, 'retired-candidate');
  assert.doesNotMatch(h.status.textContent, /retired-candidate|已套用|已切換/); assert.equal(StagePeer.instances.length, 1);
});

for (const stage of ['capture', 'sender'] as const) {
  it(`actual SDK whole embed leave during ${stage} disposes stale candidate and new entry resets input despite shared audio`, async t => {
    const h = await actualApp(t, { deferCapture: true }), first = await h.join({ role: 'audience' });
    await actualDevices(h, ['old-usb', 'pending-usb']); await actualSelect(h, 'old-usb');
    first.socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) });
    await h.until(() => h.captures.length === 1, 'first capture'); h.captures[0]!.resolve();
    await h.until(() => first.peer.transceiver.sender.track !== null, 'first sender');
    if (stage === 'sender') first.peer.gate = new Deferred();
    select(h).change('pending-usb'); button(h, 'apply').click(); await h.until(() => h.captures.length === 2, 'candidate capture');
    if (stage === 'sender') { h.captures[1]!.resolve(); await h.until(() => first.peer.gateEntered, 'candidate sender'); }
    const audio = h.audio; h.leave.click(); await flush(); retired(h); const status = h.status.textContent;
    if (stage === 'sender') first.peer.gate!.resolve(); else h.captures[1]!.resolve(); await flush();
    assert.equal(h.status.textContent, status); retired(h); assert.ok(h.tracks.every(track => track.stopped));
    const second = await h.join({ role: 'audience' }); picker(h); assert.equal(h.audio, audio); assert.notEqual(h.clients[0], h.clients[1]);
    second.socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) });
    await h.until(() => h.captures.length === 3, 'fresh default capture'); assert.equal(constraint(h, 2), undefined); h.captures[2]!.resolve();
    await h.until(() => second.peer.transceiver.sender.track !== null, 'new sender'); assert.equal(first.peer.connectionState, 'closed');
    assert.equal(h.clients[1]!.playbackVolume, 0.37); assert.equal(h.clients[1]!.playbackMuted, true);
  });
}

it('actual SDK whole embed initial state owns a no-capture default preference before join ACK settles', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'join request before ACK');
  const join = socket.sent.find(message => message.type === 'join')!;
  socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); picker(h);
  assert.equal(h.form.submitButton!.disabled, true, 'join ACK is still pending');
  await actualDevices(h, ['early-usb']); await actualSelect(h, 'early-usb'); assert.equal(h.captures.length, 0);
  socket.deliver({ type: 'ok', requestId: join.requestId }); await flush(); picker(h, 'early-usb');
  assert.equal(h.form.submitButton!.disabled, false); assert.equal(h.clients.length, 1); assert.equal(h.captures.length, 0);
});

it('actual SDK whole embed reconnect retains pending input replacement on its original client and peer', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join({ role: 'speaker', onStage: true, muted: true });
  await actualDevices(h, ['pending-usb']); await h.until(() => peer.transceiver.sender.track !== null, 'original track');
  const original = peer.transceiver.sender.track!, gate = peer.gate = new Deferred(), client = h.clients[0]!;
  select(h).change('pending-usb'); button(h, 'apply').click(); await h.until(() => peer.gateEntered, 'candidate sender wait');
  const captures = h.captures.length; socket.close(); await flush(); assert.equal(client.status, 'reconnecting'); picker(h, 'pending-usb', 'apply');
  force(h, 'apply'); force(h, 'refresh'); forceChange(h, ''); picker(h, 'pending-usb', 'apply'); assert.equal(h.captures.length, captures);
  await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  resumed.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => resumed.sent.some(message => message.type === 'join'), 'resume join');
  const join = resumed.sent.find(message => message.type === 'join')!;
  resumed.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true, muted: true }) });
  resumed.deliver({ type: 'ok', requestId: join.requestId }); await flush(); picker(h, 'pending-usb', 'apply');
  gate.resolve(); await h.until(() => !button(h, 'apply').disabled, 'resumed setter settles'); picker(h, 'pending-usb');
  assert.equal(h.clients[0], client); assert.equal(h.clients.length, 1); assert.equal(StagePeer.instances.length, 1);
  assert.equal(h.captures.length, captures); assert.equal(original.stopped, true); assert.equal(peer.transceiver.sender.track, h.tracks[1]);
  assert.equal(peer.transceiver.sender.track!.enabled, false);
});
