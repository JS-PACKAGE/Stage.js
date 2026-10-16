import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { Deferred, embedApp, flush, type EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket } from './fixtures/embedSdkApp.ts';

type View = { node(id: string): EmbedNode };
const select = (h: View) => h.node('output-device');
const refresh = (h: View) => h.node('output-refresh');
const apply = (h: View) => h.node('output-apply');
const device = (deviceId: string, label = deviceId, kind = 'audiooutput') => ({ kind, deviceId, label });
function locked(h: View, kind: 'refresh' | 'apply'): void {
  assert.equal(select(h).disabled, true); assert.equal(refresh(h).disabled, true); assert.equal(apply(h).disabled, true);
  assert.equal(h.node(`output-${kind}`).attributes['aria-busy'], 'true');
}
function force(h: View): void { refresh(h).disabled = apply(h).disabled = false; refresh(h).invoke(); apply(h).invoke(); }
async function setup(t: TestContext) {
  const h = await actualApp(t, { output: true }); await h.join({ role: 'audience' }); return h;
}
async function list(h: Awaited<ReturnType<typeof actualApp>>, devices = [device('usb')]): Promise<void> {
  refresh(h).click(); h.enumerations.at(-1)!.resolve(devices); await flush();
}

it('embed has labelled manual output controls and truthful page-lifetime draft text', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  assert.match(html, /for="output-device"/); assert.match(html, /aria-describedby="output-draft-notice output-support"/);
  for (const id of ['output-refresh', 'output-apply']) assert.match(html, new RegExp(`id="${id}" type="button" aria-busy="false" disabled`));
  assert.match(html, /草稿不代表目前實際輸出或可聽見聲音/); assert.match(html, /離房不會重設輸出裝置/);
});

it('actual SDK whole embed performs only explicit list and apply, preserving media, labels and drafts', async t => {
  const h = await setup(t); assert.equal(h.enumerations.length, 0); assert.equal(h.sinks.length, 0);
  const before = { captures: h.captures.length, plays: h.audio.plays, volume: h.audio.volume, muted: h.audio.muted };
  await list(h, [device('usb', '<img src=x onerror=bad>'), device('usb', 'duplicate'), device('', 'empty'), device('blank', '  '), device('mic', 'mic', 'audioinput')]);
  assert.deepEqual(select(h).children.map(x => [x.value, x.textContent]), [['', '系統預設'], ['usb', '<img src=x onerror=bad>'], ['blank', '揚聲器 2']]);
  select(h).change('usb'); assert.equal(h.sinks.length, 0);
  select(h).value = 'forged'; select(h).invokeChange(); assert.equal(select(h).value, 'usb');
  const status = h.status.textContent; apply(h).click(); locked(h, 'apply'); force(h); assert.equal(h.sinks.length, 1); assert.equal(h.enumerations.length, 1);
  h.sinks[0]!.work.resolve(); await flush(); assert.equal(Reflect.get(h.audio, 'sinkId'), 'usb'); assert.equal(h.status.textContent, status);
  select(h).change(''); apply(h).click(); assert.equal(h.sinks[1]!.id, ''); h.sinks[1]!.work.resolve(); await flush();
  assert.deepEqual({ captures: h.captures.length, plays: h.audio.plays, volume: h.audio.volume, muted: h.audio.muted }, before);
});

it('actual SDK missing drafts cannot apply; failed list preserves choices and failed apply is retryable', async t => {
  const h = await setup(t); await list(h); select(h).change('usb');
  refresh(h).click(); h.enumerations.at(-1)!.reject(new Error('enumeration failed')); await flush();
  assert.equal(select(h).value, 'usb'); assert.equal(select(h).children.length, 2); assert.match(h.node('last-error').textContent, /enumeration failed/);
  apply(h).click(); h.sinks[0]!.work.reject('sink failed'); await flush(); assert.equal(apply(h).disabled, false); assert.match(h.node('last-error').textContent, /sink failed/);
  apply(h).click(); h.sinks[1]!.work.resolve(); await flush(); assert.match(h.node('last-error').textContent, /sink failed/);
  await list(h, []); assert.equal(select(h).value, 'usb'); assert.equal(select(h).children.at(-1)!.disabled, true); assert.equal(apply(h).disabled, true);
  apply(h).disabled = false; apply(h).invoke(); assert.equal(h.sinks.length, 2);
  select(h).change(''); assert.equal(apply(h).disabled, false);
});

for (const kind of ['refresh', 'apply'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  it(`actual SDK page lock survives replacement entry: old ${kind} ${outcome}`, async t => {
    const h = await setup(t); await list(h); select(h).change('usb'); h.node(`output-${kind}`).click();
    const oldEnumeration = h.enumerations.at(-1)!, oldSink = h.sinks.at(-1);
    await h.join({ role: 'audience' }); locked(h, kind); force(h);
    assert.equal(h.enumerations.length, kind === 'refresh' ? 2 : 1); assert.equal(h.sinks.length, kind === 'apply' ? 1 : 0);
    const currentStatus = h.status.textContent;
    if (kind === 'refresh') { if (outcome === 'resolve') oldEnumeration.resolve([device('stale', 'OBSOLETE')]); else oldEnumeration.reject(new Error('obsolete failure')); }
    else if (outcome === 'resolve') oldSink!.work.resolve(); else oldSink!.work.reject('obsolete failure');
    await flush(); assert.equal(apply(h).disabled, false); assert.equal(select(h).value, 'usb');
    assert.equal(select(h).children.some(x => x.textContent === 'OBSOLETE'), false); assert.equal(h.status.textContent, currentStatus); assert.equal(h.node('error-notice').hidden, true);
    apply(h).click(); assert.equal(h.sinks.at(-1)!.id, 'usb'); h.sinks.at(-1)!.work.resolve(); await flush();
  });
}

it('actual SDK reconnect disables pending controls and ignores a refresh resolved while reconnecting', async t => {
  const h = await setup(t); await list(h); select(h).change('usb'); refresh(h).click();
  StageSocket.instances.at(-1)!.close(); await flush(); assert.equal(h.clients[0]!.status, 'reconnecting'); locked(h, 'refresh'); force(h);
  h.enumerations.at(-1)!.resolve([device('obsolete')]); await flush();
  assert.equal(refresh(h).disabled, true); assert.equal(select(h).value, 'usb'); assert.equal(select(h).children.some(x => x.value === 'obsolete'), false);
  h.leave.click(); await flush(); await h.join({ role: 'audience' }); assert.equal(select(h).value, 'usb'); assert.equal(refresh(h).disabled, false);
});

for (const absent of ['listAudioDevices', 'setOutputDevice', 'outputDeviceSupported', 'native'] as const) {
  it(`actual SDK older/unsupported output API remains inert: ${absent}`, async t => {
    const h = await setup(t), sdk = h.clients[0]!;
    if (absent === 'native') Reflect.deleteProperty(h.audio, 'setSinkId');
    else Object.defineProperty(sdk, absent, { configurable: true, value: absent === 'outputDeviceSupported' ? false : undefined });
    force(h); assert.equal(apply(h).disabled, true); assert.equal(refresh(h).disabled, true); assert.equal(h.node('output-support').hidden, false);
    assert.equal(h.enumerations.length, 0); assert.equal(h.sinks.length, 0);
  });
}

it('actual SDK newer error survives a pending output rejection and fulfillment', async t => {
  const h = await setup(t); apply(h).click();
  StageSocket.instances.at(-1)!.deliver({ type: 'error', code: 'forbidden', message: 'newer error' });
  h.sinks[0]!.work.reject('older sink error'); await flush(); assert.match(h.node('last-error').textContent, /newer error/);
  apply(h).click(); h.sinks[1]!.work.resolve(); await flush(); assert.match(h.node('last-error').textContent, /newer error/);
});

it('actual SDK state before join ACK may select; disconnected state never admits output', async t => {
  const h = await actualApp(t, { output: true }); force(h); assert.equal(h.sinks.length, 0);
  h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'join request');
  force(h); assert.equal(h.sinks.length, 0);
  socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); apply(h).click(); assert.equal(h.sinks.length, 1);
  await h.clients[0]!.disconnect(); force(h); assert.equal(h.sinks.length, 1); assert.equal(h.node('output-panel').hidden, true);
  h.sinks[0]!.work.reject('old disconnected'); await flush(); assert.doesNotMatch(h.node('last-error').textContent, /old disconnected/);
});

it('same client and seat after controls retirement cannot inherit old presentation ownership', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join(); const work = new Deferred();
  Reflect.set(sdk, 'outputDeviceSupported', true); Reflect.set(sdk, 'setOutputDevice', () => work.promise); sdk.snapshot();
  apply(h).click(); sdk.setStatus('disconnected'); sdk.setStatus('live'); sdk.snapshot(); force(h); locked(h, 'apply');
  work.reject('old same-seat failure'); await flush(); assert.doesNotMatch(h.node('last-error').textContent, /old same-seat failure/);
});

for (const role of ['audience', 'speaker', 'controller'] as const) {
  it(`actual SDK output remains independent of ${role} role and same-seat updates`, async t => {
    const h = await actualApp(t, { output: true }); const { socket } = await h.join({ role, onStage: false });
    await list(h); select(h).change('usb'); apply(h).click();
    socket.deliver({ type: 'room:state', ...actualState({ role: role === 'controller' ? 'audience' : 'controller', onStage: false, forceMuted: true, handRaised: true }) });
    locked(h, 'apply'); assert.equal(select(h).value, 'usb'); force(h); assert.equal(h.sinks.length, 1);
    h.sinks[0]!.work.resolve(); await flush(); assert.equal(apply(h).disabled, false); assert.equal(h.captures.length, 0);
  });
}

for (const terminal of ['leave', 'closed', 'kicked'] as const) {
  it(`actual SDK ${terminal} retires presentation but retains page lock until old refresh settles`, async t => {
    const h = await setup(t); await list(h); select(h).change('usb'); refresh(h).click(); const old = h.enumerations.at(-1)!;
    if (terminal === 'leave') h.leave.click();
    else if (terminal === 'closed') StageSocket.instances.at(-1)!.deliver({ type: 'room:closed', roomId: 'same-room' });
    else StageSocket.instances.at(-1)!.deliver({ type: 'kicked', roomId: 'same-room' });
    await flush(); assert.equal(h.node('output-panel').hidden, true); force(h); assert.equal(h.enumerations.length, 2);
    await h.join({ role: 'audience' }); locked(h, 'refresh'); old.resolve([device('obsolete')]); await flush();
    assert.equal(select(h).value, 'usb'); assert.equal(refresh(h).disabled, false); assert.equal(select(h).children.some(x => x.value === 'obsolete'), false);
  });
}

it('actual SDK cancel during a replacement join cannot release an earlier page sink operation', async t => {
  const h = await setup(t); apply(h).click(); h.form.submit(); await flush(); h.node('cancel-join').click(); await flush();
  force(h); assert.equal(h.sinks.length, 1); await h.join({ role: 'audience' }); locked(h, 'apply');
  h.sinks[0]!.work.reject('obsolete cancellation'); await flush(); assert.equal(apply(h).disabled, false); assert.doesNotMatch(h.node('last-error').textContent, /obsolete cancellation/);
});

it('actual SDK synchronous reentrant sink calls cannot overlap refresh or another apply', async t => {
  const h = await setup(t); const native = Reflect.get(h.audio, 'setSinkId') as (id: string) => Promise<void>;
  Reflect.set(h.audio, 'setSinkId', (id: string) => { locked(h, 'apply'); force(h); return native(id); });
  apply(h).click(); assert.equal(h.sinks.length, 1); assert.equal(h.enumerations.length, 0);
  h.sinks[0]!.work.resolve(); await flush();
});

for (const identity of ['room', 'participant', 'missing seat'] as const) {
  it(`actual SDK ${identity} replacement retires pending refresh ownership even when IDs return`, async t => {
    const h = await setup(t); await list(h); select(h).change('usb'); refresh(h).click();
    const socket = StageSocket.instances.at(-1)!, changed = actualState({ role: 'audience' });
    if (identity === 'room') changed.roomId = 'another-room';
    else changed.me.participantId = identity === 'missing seat' ? '' : 'another-person';
    socket.deliver({ type: 'room:state', ...changed }); socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) });
    locked(h, 'refresh'); h.enumerations.at(-1)!.resolve([device('obsolete')]); await flush();
    assert.equal(select(h).value, 'usb'); assert.equal(select(h).children.some(x => x.value === 'obsolete'), false); assert.equal(refresh(h).disabled, false);
  });
}

for (const kind of ['refresh', 'apply'] as const) {
  it(`whole embed reserves before synchronous SDK ${kind} reentry and recovers from throw`, async t => {
    const h = await setup(t), sdk = h.clients[0]!, method = kind === 'refresh' ? 'listAudioDevices' : 'setOutputDevice';
    const original = Reflect.get(sdk, method) as () => Promise<unknown>; let calls = 0;
    Reflect.set(sdk, method, () => { calls++; locked(h, kind); force(h); throw new Error('synchronous failure'); });
    h.node(`output-${kind}`).click(); await flush(); assert.equal(calls, 1); assert.equal(refresh(h).disabled, false); assert.match(h.node('last-error').textContent, /synchronous failure/);
    Reflect.set(sdk, method, original); h.node(`output-${kind}`).click(); locked(h, kind);
    if (kind === 'refresh') h.enumerations.at(-1)!.resolve([]); else h.sinks.at(-1)!.work.resolve(); await flush();
  });
}

it('actual SDK forced changes during pending, reconnect and hidden controls cannot overwrite page draft', async t => {
  const h = await setup(t); await list(h); select(h).change('usb'); apply(h).click();
  select(h).disabled = false; select(h).value = ''; select(h).invokeChange(); assert.equal(select(h).value, 'usb');
  StageSocket.instances.at(-1)!.close(); await flush(); select(h).disabled = false; select(h).value = ''; select(h).invokeChange(); assert.equal(select(h).value, 'usb');
  h.leave.click(); await flush(); select(h).disabled = false; select(h).value = ''; select(h).invokeChange();
  h.sinks[0]!.work.resolve(); await flush(); await h.join({ role: 'audience' }); assert.equal(select(h).value, 'usb');
});

it('actual SDK same-seat reconnect retains the operation until settlement after resumed state and ACK', async t => {
  const h = await setup(t); await list(h); select(h).change('usb'); apply(h).click(); const original = StageSocket.instances.at(-1)!;
  original.close(); await flush(); await h.tick(500); const socket = StageSocket.instances.at(-1)!; assert.notEqual(socket, original);
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'resumed join'); const request = socket.sent.find(m => m.type === 'join')!;
  socket.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
  locked(h, 'apply'); force(h); assert.equal(h.sinks.length, 1); h.sinks[0]!.work.resolve(); await flush();
  assert.equal(apply(h).disabled, false); assert.equal(select(h).value, 'usb'); assert.equal(h.clients.length, 1);
});
