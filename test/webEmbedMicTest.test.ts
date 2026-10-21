import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import type { RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { harness, testConfig } from './helpers.ts';
import { embedApp, flush, type EmbedSdk, type EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageContext, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';

// Complete production embed and, where stated, real SDK/Hub. DOM, sockets and media are fake.
// Native keyboard, accessibility-tree, permission prompts and hardware audio are not exercised.
interface TestHandle { readonly stopped?: boolean; level(): number; stop(): void }
interface PreviewClient extends EventTarget {
  state: RoomStatePayload | null;
  startMicTest(options?: { signal?: AbortSignal }): Promise<TestHandle>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
type App = ReturnType<typeof embedApp>;
const node = (h: Pick<App, 'node'>, suffix: string): EmbedNode => h.node(`mic-test-${suffix}`);
function idle(h: Pick<App, 'node'>, hidden = false, busy = false): void {
  assert.equal(node(h, 'panel').hidden, hidden); assert.equal(node(h, 'start').disabled, hidden || busy);
  assert.equal(node(h, 'cancel').hidden, true); assert.equal(node(h, 'stop').hidden, true);
  assert.equal(Number(node(h, 'meter').value), 0);
}
function pending(h: Pick<App, 'node'>): void {
  assert.equal(node(h, 'panel').hidden, false); assert.equal(node(h, 'start').disabled, true);
  assert.equal(node(h, 'start').getAttribute('aria-busy'), 'true');
  assert.equal(node(h, 'cancel').hidden, false); assert.equal(node(h, 'cancel').disabled, false);
  assert.equal(node(h, 'stop').hidden, true); assert.equal(Number(node(h, 'meter').value), 0);
}
function active(h: Pick<App, 'node'>, level = 0): void {
  assert.equal(node(h, 'panel').hidden, false); assert.equal(node(h, 'start').disabled, true);
  assert.equal(node(h, 'cancel').hidden, true); assert.equal(node(h, 'stop').hidden, false);
  assert.equal(node(h, 'stop').disabled, false); assert.equal(Number(node(h, 'meter').value), level);
}
function force(h: Pick<App, 'node'>, suffix = 'start'): void {
  node(h, 'panel').hidden = false; node(h, suffix).hidden = node(h, suffix).disabled = false; node(h, suffix).invoke();
}
function captures(sdk: EmbedSdk) {
  const requests: { signal: AbortSignal; work: ReturnType<typeof Promise.withResolvers<TestHandle>> }[] = [];
  Reflect.set(sdk, 'startMicTest', ({ signal }: { signal: AbortSignal }) => {
    const work = Promise.withResolvers<TestHandle>(); requests.push({ signal, work }); return work.promise;
  });
  return requests;
}
function handle(level = 0.25) {
  return { stops: 0, reads: 0, stopped: false, level() { this.reads++; return level; }, stop() { this.stops++; this.stopped = true; } };
}
async function fake(t: TestContext) {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  const requests = captures(sdk); return { h, sdk, requests };
}
async function actual(t: TestContext) {
  const h = await actualApp(t, { deferCapture: true }); const room = await h.join({ role: 'audience', onStage: false });
  const client = h.clients[0] as unknown as PreviewClient; return { ...h, ...room, client };
}
function graph(t: TestContext) {
  const values = { amplitude: 0.25, reads: 0 };
  t.mock.method(StageContext.prototype, 'createAnalyser', () => ({ fftSize: 2048,
    getFloatTimeDomainData(samples: Float32Array) { values.reads++; samples.fill(values.amplitude); }, disconnect() {} }));
  return values;
}
function onceSetter(target: EmbedNode, property: 'textContent' | 'disabled' | 'value', callback: () => void): void {
  let value: unknown = Reflect.get(target, property), armed = true;
  Object.defineProperty(target, property, { configurable: true, get() { return value; }, set(next: unknown) {
    value = next; if (armed) { armed = false; callback(); }
  } });
}

it('embed microphone test uses native labelled actions and meter with honest level-only copy', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  for (const suffix of ['panel', 'start', 'cancel', 'stop', 'meter', 'status', 'notice'])
    assert.equal(html.split(`id="mic-test-${suffix}"`).length, 2);
  for (const suffix of ['start', 'cancel', 'stop']) {
    const button = html.match(new RegExp(`<button\\b[^>]*id="mic-test-${suffix}"[^>]*>[^<]+</button>`))?.[0]; assert.ok(button);
    assert.match(button, /type="button"/); assert.match(button, /\bdisabled\b/);
    assert.doesNotMatch(button, /tabindex=|role=|aria-pressed=|aria-label=/);
    if (suffix !== 'start') assert.match(button, /\bhidden\b/);
  }
  assert.match(html, /<label for="mic-test-meter">麥克風測試音量<\/label>/);
  assert.match(html, /<meter id="mic-test-meter" min="0" max="1" value="0"/);
  assert.match(html, /id="mic-test-status" role="status"/); assert.match(html, /不會回放或送上舞台/);
  assert.match(html, /可能要求麥克風權限/); assert.match(html, /不保證別人聽得見/);
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
  assert.match(source, /enableMicMeter: false/);
  assert.doesNotMatch(source, /\bgetUserMedia\b|\benumerateDevices\b|\btestMicrophone\b/);
  assert.equal(source.match(/\.startMicTest\b/g)?.length, 1, 'one public call site belongs to the explicit test path');
});

it('test eligibility requires current joined offstage seat; all roles can test without automatic capture', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); idle(h, true); force(h); idle(h, true);
  h.form.submit(); await flush(); const sdk = h.clients[0]!, requests = captures(sdk); force(h); idle(h, true);
  for (const role of ['audience', 'speaker', 'controller'] as const) {
    sdk.snapshot({ role, onStage: false }); idle(h); sdk.setStatus('live'); idle(h);
    h.node('unlock').click(); h.tick(1000); await flush(); assert.equal(requests.length, 0);
    sdk.snapshot({ onStage: true }); force(h); idle(h, true); assert.equal(requests.length, 0);
  }
  assert.equal(h.clock.timers.length, 0); assert.equal(sdk.actions.length, 0); assert.equal(sdk.retryCalls, 0);
});

it('test reserves before busy setters and method lookup, and micready cannot settle its own pending gate', async t => {
  const { h, sdk, requests } = await fake(t);
  onceSetter(node(h, 'start'), 'disabled', () => { force(h); sdk.emit('micready', undefined); });
  const original = Reflect.get(sdk, 'startMicTest'); let getters = 0;
  Object.defineProperty(sdk, 'startMicTest', { get() { getters++; pending(h); force(h); sdk.snapshot(); return original; } });
  node(h, 'start').click(); pending(h); assert.equal(requests.length, 1); assert.equal(getters, 1);
  sdk.emit('micready', undefined); force(h); pending(h); assert.equal(requests.length, 1);
  const test = handle(); requests[0]!.work.resolve(test); await flush(); active(h, .25);
  assert.equal(node(h, 'start').getAttribute('aria-busy'), 'false'); assert.equal(h.clock.timers.length, 1);
  node(h, 'stop').click(); idle(h); assert.equal(h.clock.timers.length, 0); assert.equal(test.stops, 1);
});

it('cancel revokes result and timer ownership now but reserves unresolved request until settlement', async t => {
  const { h, requests } = await fake(t); node(h, 'start').click(); node(h, 'cancel').click();
  idle(h, false, true); assert.equal(requests[0]!.signal.aborted, true); force(h); assert.equal(requests.length, 1);
  const stale = handle(); requests[0]!.work.resolve(stale); await flush(); idle(h); assert.equal(stale.stops, 1); assert.equal(stale.reads, 0);
  node(h, 'start').click(); assert.equal(requests.length, 2); pending(h);
  requests[1]!.work.reject(new Error('private platform detail')); await flush(); idle(h);
  assert.match(node(h, 'status').textContent, /無法開始/); assert.doesNotMatch(node(h, 'status').textContent, /private/);
});

for (const ending of ['room', 'participant', 'onstage', 'reconnecting', 'disconnected', 'closed', 'kicked', 'leave', 'hidden', 'pagehide'] as const)
  for (const phase of ['pending', 'active'] as const) it(`${ending} retires ${phase} preview with no delayed writes or restart`, async t => {
    const { h, sdk, requests } = await fake(t); node(h, 'start').click(); const test = handle();
    if (phase === 'active') { requests[0]!.work.resolve(test); await flush(); active(h, .25); }
    if (ending === 'room') { sdk.state!.roomId = 'replacement'; sdk.emit('state', sdk.state); }
    else if (ending === 'participant') sdk.snapshot({ participantId: 'replacement' });
    else if (ending === 'onstage') sdk.snapshot({ onStage: true });
    else if (ending === 'reconnecting' || ending === 'disconnected') sdk.setStatus(ending);
    else if (ending === 'closed' || ending === 'kicked') sdk.emit(ending, { roomId: 'same-room' });
    else if (ending === 'leave') h.leave.click();
    else if (ending === 'hidden') { h.pageDocument.hidden = true; h.pageDocument.dispatchEvent(new Event('visibilitychange')); }
    else h.pageWindow.dispatchEvent(new Event('pagehide'));
    assert.equal(requests[0]!.signal.aborted, true); assert.equal(Number(node(h, 'meter').value), 0); assert.equal(h.clock.timers.length, 0);
    await flush(); const message = h.status.textContent;
    if (phase === 'pending') requests[0]!.work.resolve(test);
    await flush(); h.tick(5000); assert.equal(test.stops, 1); assert.equal(h.status.textContent, message);
    assert.equal(requests.length, 1);
    if (ending === 'hidden') { h.pageDocument.hidden = false; h.pageDocument.dispatchEvent(new Event('visibilitychange')); idle(h); }
    if (ending === 'pagehide') { h.pageWindow.dispatchEvent(new Event('pageshow')); idle(h); }
    assert.equal(requests.length, 1);
  });

it('retired callback and old rejection cannot repaint a replacement entry or its pending request', async t => {
  const { h, requests } = await fake(t); node(h, 'start').click(); const first = handle(); requests[0]!.work.resolve(first); await flush();
  const timer = h.clock.timers[0]!.id; const freshSdk = await h.join(), fresh = captures(freshSdk); node(h, 'start').click(); pending(h);
  h.clock.fireRetired(timer); pending(h); assert.equal(first.stops, 1); assert.equal(fresh.length, 1);
  fresh[0]!.work.reject(new Error('failure')); await flush(); idle(h);
});

for (const level of [NaN, Infinity, -Infinity, -1, 2, .4]) it(`meter clamps finite numeric level ${level} without live status churn`, async t => {
  const { h, requests } = await fake(t); const test = handle(level); node(h, 'start').click(); requests[0]!.work.resolve(test); await flush();
  const expected = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0; active(h, expected);
  node(h, 'status').resetWrites(); h.tick(500); active(h, expected); assert.equal(node(h, 'status').writes.textContent, 0);
  test.stopped = true; const reads = test.reads; h.tick(100); idle(h); assert.equal(test.reads, reads); assert.equal(h.clock.timers.length, 0);
});

for (const boundary of ['stopped', 'level', 'meter']) it(`${boundary} reentry cannot retain stale preview value or timer`, async t => {
  const { h, sdk, requests } = await fake(t); const test = handle();
  if (boundary === 'stopped') Object.defineProperty(test, 'stopped', { get() { sdk.snapshot({ onStage: true }); return false; }, set() {} });
  if (boundary === 'level') test.level = () => { sdk.snapshot({ onStage: true }); return .9; };
  if (boundary === 'meter') onceSetter(node(h, 'meter'), 'value', () => sdk.snapshot({ onStage: true }));
  node(h, 'start').click(); requests[0]!.work.resolve(test); await flush(); idle(h, true); assert.equal(test.stops, 1); assert.equal(h.clock.timers.length, 0);
});

it('busy DOM callback can replace entry before method invocation without forwarding old capture', async t => {
  const { h, requests } = await fake(t); onceSetter(node(h, 'start'), 'disabled', () => h.form.submit());
  node(h, 'start').click(); await flush(); assert.equal(requests.length, 0); assert.equal(h.clients.length, 2); idle(h, true);
});

it('cancel clears ownership before abort callback can replace entry; obsolete finally cannot clear new work', async t => {
  const { h, requests } = await fake(t); node(h, 'start').click();
  requests[0]!.signal.addEventListener('abort', () => h.form.submit(), { once: true }); node(h, 'cancel').click(); await flush();
  assert.equal(h.clients.length, 2); const sdk = h.clients[1]!, fresh = captures(sdk); sdk.snapshot(); idle(h, false, true);
  requests[0]!.work.reject(new Error('old')); await flush(); idle(h); node(h, 'start').click(); pending(h); assert.equal(fresh.length, 1);
  fresh[0]!.work.resolve(handle()); await flush(); active(h, .25);
});

it('hidden, disabled and detached controls do not obtain consent from manufactured events', async t => {
  const { h, requests } = await fake(t);
  for (const field of ['hidden', 'disabled'] as const) {
    node(h, 'start')[field] = true; node(h, 'start').invoke(); assert.equal(requests.length, 0);
    node(h, 'start')[field] = false;
  }
  node(h, 'start').remove(); force(h); assert.equal(requests.length, 0);
});

it('explicit input Apply stops preview and blocks Test until Apply settles; enumeration and drafts never capture', async t => {
  const { h, sdk, requests } = await fake(t); h.node('microphone-refresh').click();
  sdk.deviceLists[0]!.resolve({ inputs: [{ kind: 'audioinput', deviceId: 'chosen', label: 'Chosen' }], outputs: [] }); await flush();
  h.node('microphone-device').change('chosen'); assert.equal(requests.length, 0);
  node(h, 'start').click(); requests[0]!.work.resolve(handle()); await flush(); active(h, .25);
  h.node('microphone-apply').click(); assert.equal(requests[0]!.signal.aborted, true); idle(h, false, true);
  force(h); assert.equal(requests.length, 1); assert.equal(sdk.inputSelections[0]!.deviceId, 'chosen');
  sdk.inputSelections[0]!.work.resolve(); await flush(); idle(h); assert.equal(requests.length, 1);
  node(h, 'start').click(); requests[1]!.work.resolve(handle()); await flush(); active(h, .25);
});

it('preview failures keep global error feedback and consent decisions unchanged', async t => {
  const { h, sdk, requests } = await fake(t); sdk.emit('error', new Error('既有錯誤'));
  const old = [h.status.textContent, h.node('last-error').textContent, h.node('error-notice').hidden];
  node(h, 'start').click(); requests[0]!.work.reject(new Error('sensitive system path')); await flush();
  assert.deepEqual([h.status.textContent, h.node('last-error').textContent, h.node('error-notice').hidden], old);
  assert.match(node(h, 'status').textContent, /無法開始/); assert.equal(h.confirmations.length, 0);
  assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
});

it('actual SDK explicit success meters committed input without sender, signaling, playback or stage side effects', async t => {
  const h = await actual(t), values = graph(t);
  h.node('microphone-refresh').click(); h.enumerations[0]!.resolve([{ kind: 'audioinput', deviceId: 'selected', label: 'Synthetic input' }]); await flush();
  h.node('microphone-device').change('selected'); h.node('microphone-apply').click(); await flush();
  const before = { sent: h.socket.sent.length, offers: h.peer.offers.length, replacements: h.peer.replacements.length, plays: h.audio.plays, pauses: h.audio.pauses };
  node(h, 'start').click(); pending(h); assert.equal(h.captures.length, 1);
  assert.equal((h.captures[0]!.constraints as { audio: { deviceId: { exact: string } } }).audio.deviceId.exact, 'selected');
  const track = h.captures[0]!.resolve(); await flush(); active(h, .25); assert.equal(StageContext.instances.length, 1);
  values.amplitude = .5; await h.tick(100); active(h, .5);
  assert.deepEqual({ sent: h.socket.sent.length, offers: h.peer.offers.length, replacements: h.peer.replacements.length, plays: h.audio.plays, pauses: h.audio.pauses }, before);
  assert.equal(h.peer.transceiver.sender.track, null); assert.equal(h.peer.transceiver.direction, 'recvonly');
  node(h, 'stop').click(); idle(h); assert.equal(track.stops, 1); assert.equal(StageContext.instances[0]!.closes, 1);
  const reads = values.reads; await h.tick(5000); assert.equal(values.reads, reads); assert.equal(h.captures.length, 1);
});

for (const late of ['grant', 'denial'] as const) it(`actual SDK cancel settles before native ${late}; deliberate retry owns its own handle`, async t => {
  const h = await actual(t); node(h, 'start').click(); node(h, 'cancel').click(); idle(h, false, true);
  force(h); assert.equal(h.captures.length, 1); await flush(); idle(h);
  node(h, 'start').click(); const fresh = h.captures[1]!.resolve(); await flush(); active(h);
  if (late === 'grant') { const stale = h.captures[0]!.resolve(); await flush(); assert.equal(stale.stops, 1); }
  else { h.captures[0]!.reject(new DOMException('late denied', 'NotAllowedError')); await flush(); }
  active(h); assert.equal(fresh.stops, 0); assert.equal(StageContext.instances.length, 1);
  node(h, 'stop').click(); assert.equal(fresh.stops, 1);
});

it('actual SDK shared micready arrives before promise settlement and can cancel without accepting a handle', async t => {
  const h = await actual(t); let observed = false;
  h.client.on('micready', () => { observed = true; pending(h); force(h); assert.equal(h.captures.length, 1); node(h, 'cancel').click(); });
  node(h, 'start').click(); const track = h.captures[0]!.resolve(); await flush();
  assert.equal(observed, true); idle(h); assert.equal(track.stops, 1); assert.equal(StageContext.instances[0]!.closes, 1);
});

it('actual SDK natural track end clears meter and stops polling without treating zero as end', async t => {
  const h = await actual(t), values = graph(t); values.amplitude = 0;
  node(h, 'start').click(); const track = h.captures[0]!.resolve(); await flush(); active(h);
  await h.tick(100); active(h); const reads = values.reads;
  track.readyState = 'ended'; (track as unknown as EventTarget).dispatchEvent(new Event('ended'));
  await h.tick(100); idle(h); assert.equal(track.stops, 1); assert.equal(values.reads, reads);
  await h.tick(5000); assert.equal(values.reads, reads); assert.equal(h.captures.length, 1);
});

for (const event of ['invite', 'stagejoined'] as const) it(`actual SDK own early ${event} fences stale offstage snapshot until fresh state`, async t => {
  const h = await actual(t); node(h, 'start').click(); const track = h.captures[0]!.resolve(); await flush();
  const old = h.client.state!;
  h.socket.deliver(event === 'invite' ? { type: 'stage:invite', participantId: old.me.participantId, byId: 'host' }
    : { type: 'stage:joined', participantId: old.me.participantId, role: 'speaker' });
  assert.equal(h.client.state!.me.onStage, false); assert.equal(track.stops, 1); idle(h, true);
  h.client.dispatchEvent(new CustomEvent('state', { detail: old })); h.client.dispatchEvent(new CustomEvent('status', { detail: 'live' }));
  force(h); idle(h, true); assert.equal(h.captures.length, 1);
  h.socket.deliver({ type: 'room:state', ...actualState({ role: 'audience', onStage: false }) }); await flush(); idle(h);
  assert.equal(h.captures.length, 1); node(h, 'start').click(); pending(h); assert.equal(h.captures.length, 2);
});

it('actual SDK other-person events and controller role alone cannot stop or fabricate stage entry', async t => {
  const h = await actual(t); node(h, 'start').click(); const track = h.captures[0]!.resolve(); await flush();
  h.socket.deliver({ type: 'stage:invite', participantId: 'other', byId: 'host' });
  h.socket.deliver({ type: 'stage:joined', participantId: 'other', role: 'speaker' });
  h.socket.deliver({ type: 'role:update', participantId: h.client.state!.me.participantId, role: 'controller', reason: 'transferred' });
  active(h); assert.equal(track.stops, 0); node(h, 'stop').click();
});

it('actual SDK entering stage disposes preview only and leaves newly captured room microphone alive', async t => {
  const h = await actual(t); node(h, 'start').click(); const preview = h.captures[0]!.resolve(); await flush();
  h.socket.deliver({ type: 'room:state', ...actualState({ role: 'speaker', onStage: true }) }); await flush();
  assert.equal(preview.stops, 1); idle(h, true); assert.equal(h.captures.length, 2);
  const room = h.captures[1]!.resolve(); await h.until(() => h.peer.transceiver.sender.track === room, 'room microphone attached');
  force(h, 'stop'); force(h, 'cancel'); force(h); await h.tick(500);
  assert.equal(room.stops, 0); assert.equal(h.peer.transceiver.sender.track, room); assert.equal(h.captures.length, 2);
});

it('actual SDK visibility and page lifecycle stop pending or active resources and never resume capture', async t => {
  const h = await actual(t); node(h, 'start').click(); h.pageDocument.hidden = true; h.pageDocument.dispatchEvent(new Event('visibilitychange'));
  await flush(); idle(h, true); const stale = h.captures[0]!.resolve(); await flush(); assert.equal(stale.stops, 1);
  h.pageDocument.hidden = false; h.pageDocument.dispatchEvent(new Event('visibilitychange')); idle(h); assert.equal(h.captures.length, 1);
  node(h, 'start').click(); const track = h.captures[1]!.resolve(); await flush(); h.pageWindow.dispatchEvent(new Event('pagehide'));
  assert.equal(track.stops, 1); idle(h, true); h.pageWindow.dispatchEvent(new Event('pageshow')); idle(h, true); await h.tick(1000);
  const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, h.socket);
  resumed.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await h.until(() => resumed.sent.some(message => message.type === 'join'), 'resume join');
  const request = resumed.sent.find(message => message.type === 'join')!;
  resumed.deliver({ type: 'room:state', ...actualState({ role: 'audience' }) }); resumed.deliver({ type: 'ok', requestId: request.requestId });
  await flush(); idle(h);
  assert.equal(h.captures.length, 2);
});

it('actual Hub approval delivers invite before state; preview ends before stage capture while room microphone survives', async t => {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.presenceBroadcastMs = 0; });
  const server = harness(config), host = await server.create('Host'), h = await actualApp(t, { deferCapture: true });
  let work = Promise.resolve(); const sessions = new Map<StageSocket, Session>(), incoming: ServerMessage[] = [];
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this); assert.ok(session);
    this.sent.push(message); work = work.then(() => server.hub.handle(session, message));
  });
  t.after(async () => { await work; await server.hub.shutdown(); await server.transport.close(); });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.form.submit(); await flush();
  const socket = StageSocket.instances[0]!; const session: Session = { id: 'preview-guest',
    send(message) { incoming.push(message); if (socket.readyState === StageSocket.OPEN) socket.deliver(message); }, close() { socket.close(); } };
  sessions.set(socket, session); server.hub.attach(session);
  await h.until(() => Boolean(h.clients[0]?.me), 'Hub join'); await h.tick(200); await work; await flush();
  const client = h.clients[0] as unknown as PreviewClient, pid = client.state!.me.participantId;
  node(h, 'start').click(); const preview = h.captures[0]!.resolve(); await flush(); active(h);
  let observedInvite = false;
  client.on('invite', () => { observedInvite = true; assert.equal(client.state!.me.onStage, false); assert.equal(preview.stops, 1); force(h); idle(h, true); });
  h.node('hand').click(); await h.tick(200); await work; await flush();
  const start = incoming.length; assert.equal(await server.req(host.s, { type: 'stage:approve', targetId: pid }), 'ok');
  await flush(); assert.equal(observedInvite, true); const sequence = incoming.slice(start).map(message => message.type);
  assert.ok(sequence.indexOf('stage:invite') < sequence.indexOf('room:state')); assert.equal(preview.stops, 1);
  assert.equal(h.captures.length, 2); const room = h.captures[1]!.resolve(); await h.tick(200); await work; await flush();
  assert.equal(StagePeer.instances[0]!.transceiver.sender.track, room); assert.equal(room.stops, 0); idle(h, true);
  await h.until(() => server.transport.rooms.get(host.roomId)!.publishers.has(pid) === true, 'Hub accepts stage publisher');
});

for (const boundary of ['leave', 'newentry'] as const) it(`${boundary} revokes original preview binding before cleanup callback can capture again`, async t => {
  const h = await actual(t), start = h.client.startMicTest.bind(h.client);
  h.client.startMicTest = async options => {
    const test = await start(options), stop = test.stop.bind(test); let first = true;
    test.stop = () => { stop(); if (first) { first = false; h.pageDocument.dispatchEvent(new Event('visibilitychange')); force(h); } };
    return test;
  };
  node(h, 'start').click(); const track = h.captures[0]!.resolve(); await flush(); active(h);
  if (boundary === 'leave') h.leave.click(); else h.form.submit();
  await flush(); assert.equal(track.stops, 1); assert.equal(h.captures.length, 1); idle(h, true);
});

it('observed disconnected getter permanently retires preview binding until a genuine new entry', async t => {
  const { h, sdk, requests } = await fake(t); node(h, 'start').click(); requests[0]!.work.resolve(handle()); await flush();
  let lost = true;
  Object.defineProperty(sdk, 'status', { configurable: true, get() { if (lost) { lost = false; return 'disconnected'; } return 'live'; } });
  h.tick(100); idle(h, true); force(h); idle(h, true); assert.equal(requests.length, 1);
  Object.defineProperty(sdk, 'status', { configurable: true, writable: true, value: 'live' });
  const fresh = await h.join(); captures(fresh); idle(h);
});

for (const failure of ['throw', 'missing', 'meter'] as const) it(`${failure} failure remains local and permits explicit retry`, async t => {
  const { h, sdk, requests } = await fake(t), original = Reflect.get(sdk, 'startMicTest');
  if (failure === 'throw') Reflect.set(sdk, 'startMicTest', () => { throw new Error('private details'); });
  if (failure === 'missing') Reflect.deleteProperty(sdk, 'startMicTest');
  const status = h.status.textContent; node(h, 'start').click();
  if (failure === 'meter') { const test = handle(); test.level = () => { throw new Error('private details'); }; requests[0]!.work.resolve(test); }
  await flush(); idle(h); assert.equal(h.status.textContent, status); assert.equal(h.node('error-notice').hidden, true);
  assert.doesNotMatch(node(h, 'status').textContent, /private/); assert.match(node(h, 'status').textContent, /無法/);
  Reflect.set(sdk, 'startMicTest', original); node(h, 'start').click(); requests.at(-1)!.work.resolve(handle()); await flush(); active(h, .25);
});

it('input Apply during pending test aborts preview and cannot start another until both requests settle', async t => {
  const { h, sdk, requests } = await fake(t); node(h, 'start').click(); h.node('microphone-apply').click();
  assert.equal(requests[0]!.signal.aborted, true); force(h); assert.equal(requests.length, 1);
  const late = handle(); requests[0]!.work.resolve(late); await flush(); assert.equal(late.stops, 1); idle(h, false, true);
  sdk.inputSelections[0]!.work.resolve(); await flush(); idle(h); assert.equal(requests.length, 1);
});
