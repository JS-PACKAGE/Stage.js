import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { StageClient, decodeName } from '../packages/client/src/index.ts';
import { Room } from '../src/model/room.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import type { ParticipantView } from '../shared/protocol.ts';
import { testConfig } from './helpers.ts';
import { embedApp, flush, type EmbedNode, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket, StagePeer } from './fixtures/embedSdkApp.ts';

// Complete embed module + controlled DOM, and real SDK/Room below. No native keyboard,
// focus, details layout, accessibility tree, real network, microphone or audible-media claim.
type View = { node(id: string): EmbedNode };
const search = (h: View) => h.node('hand-queue-search');
const clear = (h: View) => h.node('hand-queue-clear');
const panel = (h: View) => h.node('hand-queue');
const rows = (h: View) => h.node('hand-queue-list').children;
const results = (h: View) => h.node('hand-queue-results').textContent;
const visible = (h: View) => rows(h).filter(row => !row.hidden);
const label = (row: EmbedNode) => row.children[0]!.textContent;
const button = (row: EmbedNode, kind: 'approve' | 'reject' = 'approve') => row.children[1]!.children[kind === 'approve' ? 0 : 1]!;
function query(h: View, value: string): void { search(h).value = value; assert.ok(search(h).oninput); search(h).oninput!(); }
function force(row: EmbedNode, kind: 'approve' | 'reject' = 'approve'): void { button(row, kind).disabled = false; button(row, kind).invoke(); }
function locked(row: EmbedNode, pending: boolean, disabled = pending): void {
  for (const kind of ['approve', 'reject'] as const) {
    assert.equal(button(row, kind).disabled, disabled); assert.equal(button(row, kind).getAttribute('aria-busy'), String(pending));
  }
}
function retired(h: View): void {
  assert.equal(panel(h).hidden, true); assert.equal(panel(h).open, false); assert.equal(rows(h).length, 0);
  assert.equal(search(h).value, ''); assert.equal(search(h).disabled, true); assert.equal(clear(h).disabled, true); assert.equal(results(h), '');
}
const person = (id: string, name = id, patch: Partial<ParticipantView> = {}): ParticipantView => ({
  participantId: id, name, role: 'audience', onStage: false, handRaised: true, connected: true,
  muted: false, forceMuted: false, gainDb: 0, joinedAt: 0, ...patch,
});
function snapshot(sdk: EmbedSdk, hands: ParticipantView[] = [person('a', 'Alice'), person('b', 'Bob')], patch: { roomId?: string; me?: Partial<ParticipantView> } = {}, emit = true): void {
  assert.ok(sdk.state); assert.ok(sdk.me);
  sdk.state = { ...sdk.state, ...patch, hands, me: { ...sdk.me, ...patch.me } }; sdk.me = sdk.state.me;
  if (emit) sdk.emit('state', sdk.state);
}
async function setup(t: TestContext) {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller' }); snapshot(sdk); return { h, sdk };
}
function onceProperty<T extends object>(object: T, key: keyof T, edge: 'get' | 'set', callback: () => void): void {
  let value = object[key], fired = false;
  Object.defineProperty(object, key, { configurable: true,
    get() { if (edge === 'get' && !fired) { fired = true; callback(); } return value; },
    set(next: T[keyof T]) { if (edge === 'set' && !fired) { fired = true; callback(); } value = next; },
  });
}

it('authored search is explicitly labelled native search, clear is a non-submit button, and status is associated outside join form', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
  const details = html.match(/<details\b[^>]*id="hand-queue"[^>]*>[\s\S]*?<\/details>/)?.[0]; assert.ok(details);
  assert.match(details, /<label[^>]*for="hand-queue-search">搜尋舉手者名稱<input id="hand-queue-search" type="search" autocomplete="off" aria-describedby="hand-queue-results" disabled>/);
  assert.match(details, /<button id="hand-queue-clear" type="button" disabled>清除搜尋<\/button>/);
  assert.match(details, /<p id="hand-queue-results"[^>]*role="status"><\/p>/);
  assert.ok(html.indexOf(details) > html.indexOf('</form>'));
  for (const id of ['hand-queue-search', 'hand-queue-clear', 'hand-queue-results']) assert.equal(html.split(`id="${id}"`).length, 2);
  assert.doesNotMatch(details, /tabindex|onkey/); assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});

it('local names filter with trimmed case-insensitive substrings; no-match, empty and clear preserve keyed full queue', async t => {
  const { h, sdk } = await setup(t); panel(h).open = true;
  const originals = [...rows(h)], state = JSON.stringify(sdk.state);
  assert.equal(results(h), '符合 2 / 2 筆舉手申請。'); assert.equal(clear(h).disabled, true);
  query(h, '  ALi  '); assert.deepEqual(visible(h).map(label), ['Alice']); assert.equal(rows(h).length, 2); locked(originals[1]!, false, true);
  assert.equal(results(h), '符合 1 / 2 筆舉手申請。'); assert.equal(search(h).value, '  ALi  '); assert.equal(clear(h).disabled, false);
  query(h, 'missing'); assert.equal(visible(h).length, 0); assert.equal(results(h), '符合 0 / 2 筆舉手申請。沒有符合搜尋的舉手者。');
  query(h, '   '); assert.equal(visible(h).length, 2); clear(h).click(); assert.equal(search(h).value, ''); assert.equal(clear(h).disabled, true);
  assert.deepEqual([...rows(h)], originals); assert.equal(panel(h).open, true); assert.equal(h.node('hand-queue-summary').textContent, '舉手申請（2）');
  assert.equal(JSON.stringify(sdk.state), state); assert.equal(sdk.moderations.length, 0); assert.equal(sdk.actions.length, 0);
  assert.equal(sdk.joins.length, 1); assert.equal(sdk.deviceLists.length, 0); assert.equal(sdk.inputSelections.length, 0); assert.equal(h.clock.timers.length, 0);
});

it('name matching excludes IDs and offline annotation while retaining order, duplicate names and invalid-row exclusion', async t => {
  const { h, sdk } = await setup(t);
  snapshot(sdk, [person('secret-target', 'Same'), person('other-id', 'Same', { connected: false }), person('secret-target', 'wrong'),
    person('stage', 'Same', { onStage: true }), person('down', 'Same', { handRaised: false }), person('', 'Same')]);
  query(h, 'same'); assert.equal(visible(h).length, 2); assert.equal(results(h), '符合 2 / 2 筆舉手申請。');
  query(h, 'secret-target'); assert.equal(visible(h).length, 0);
  query(h, '暫時離線'); assert.equal(visible(h).length, 0);
  clear(h).click(); button(rows(h)[1]!, 'reject').click(); assert.equal(sdk.moderations[0]!.id, 'other-id');
});

it('filtered same-seat snapshots preserve query and nodes while rename, withdrawal and authoritative reorder update matches', async t => {
  const { h, sdk } = await setup(t), a = rows(h)[0]!, b = rows(h)[1]!; query(h, 'AL'); panel(h).open = true;
  snapshot(sdk, [person('b', 'Albert'), person('a', 'Changed')], { me: { onStage: true } });
  assert.equal(rows(h)[0], b); assert.equal(rows(h)[1], a); assert.deepEqual(visible(h).map(label), ['Albert']); assert.equal(search(h).value, 'AL');
  snapshot(sdk, [person('b', 'Albert')]); assert.equal(a.parentElement, null); force(a); assert.equal(sdk.moderations.length, 0);
  snapshot(sdk, [person('b', 'Albert'), person('a', 'Alina')]); assert.notEqual(rows(h)[1], a); assert.equal(panel(h).open, true);
  assert.equal(results(h), '符合 2 / 2 筆舉手申請。');
});

for (const outcome of ['resolve', 'reject'] as const) it(`filtered pending ${outcome} releases exact per-ID reservation without replacing row or showing obsolete promise feedback`, async t => {
  const { h, sdk } = await setup(t), a = rows(h)[0]!, b = rows(h)[1]!; button(a).click(); const work = sdk.moderations[0]!.work;
  query(h, 'Bob'); locked(a, true, true); locked(b, false); a.hidden = false; force(a, 'reject'); assert.equal(sdk.moderations.length, 1);
  query(h, 'Alice'); locked(a, true); force(a); assert.equal(sdk.moderations.length, 1);
  query(h, 'Bob'); sdk.emit('error', new Error('independent feedback'));
  if (outcome === 'resolve') work.resolve(); else work.reject('hidden promise failure'); await flush();
  assert.equal(h.node('last-error').textContent, '最近錯誤：independent feedback'); locked(a, false, true);
  clear(h).click(); assert.equal(rows(h)[0], a); locked(a, false); button(a, 'reject').click(); assert.equal(sdk.moderations.length, 2);
});

it('a hidden pending ID disappearing and reappearing retains lock independently of query and original row', async t => {
  const { h, sdk } = await setup(t), old = rows(h)[0]!; button(old).click(); query(h, 'Bob');
  snapshot(sdk, [person('b', 'Bob')]); snapshot(sdk); const replacement = rows(h)[0]!;
  assert.notEqual(replacement, old); locked(replacement, true, true); clear(h).click(); locked(replacement, true);
  force(old); force(replacement); assert.equal(sdk.moderations.length, 1);
  sdk.moderations[0]!.work.resolve(); await flush(); locked(replacement, false);
});

it('retained hidden action cannot forge name eligibility with hidden/disabled flags, text or method reentry', async t => {
  const { h, sdk } = await setup(t), a = rows(h)[0]!; query(h, 'Bob'); a.hidden = false; a.children[0]!.textContent = 'Bob'; force(a);
  assert.equal(sdk.moderations.length, 0); assert.equal(a.hidden, true); assert.equal(label(a), 'Alice');
  clear(h).click(); const method = sdk.approve.bind(sdk); let reads = 0;
  Object.defineProperty(sdk, 'approve', { configurable: true, get() { if (++reads === 4) query(h, 'Bob'); return method; } });
  force(a); assert.equal(sdk.moderations.length, 0); assert.equal(search(h).value, 'Bob');
});

it('same-owner reconnect preserves query/open and permits only local search until active state returns', async t => {
  const { h, sdk } = await setup(t), a = rows(h)[0]!; query(h, 'Alice'); panel(h).open = true;
  sdk.setStatus('reconnecting'); assert.equal(search(h).value, 'Alice'); assert.equal(panel(h).open, true); assert.equal(rows(h)[0], a);
  assert.equal(h.node('hand-queue-summary').textContent, '舉手申請（2） · 上次收到'); locked(a, false, true);
  query(h, 'Bob'); assert.equal(visible(h).length, 1); force(rows(h)[1]!); assert.equal(sdk.moderations.length, 0);
  sdk.setStatus('live'); locked(rows(h)[1]!, false); assert.equal(search(h).value, 'Bob'); assert.equal(a.hidden, true);
});

for (const boundary of ['role', 'room', 'participant', 'missing state', 'disconnected', 'leave', 'closed', 'kicked', 'new entry'] as const) {
  it(`${boundary} clears private search ownership; old input, clear and row callbacks cannot restore previous query`, async t => {
    const { h, sdk } = await setup(t), old = rows(h)[0]!; query(h, 'Alice'); panel(h).open = true;
    const oldInput = search(h).oninput!, oldClear = clear(h).onclick!;
    if (boundary === 'role') snapshot(sdk, [], { me: { role: 'audience' } });
    else if (boundary === 'room') snapshot(sdk, [], { roomId: 'other' });
    else if (boundary === 'participant') snapshot(sdk, [], { me: { participantId: 'other' } });
    else if (boundary === 'missing state') { sdk.state = null; sdk.emit('status', sdk.status); }
    else if (boundary === 'disconnected') sdk.setStatus('disconnected');
    else if (boundary === 'leave') h.leave.click();
    else if (boundary === 'closed' || boundary === 'kicked') sdk.emit(boundary, { reason: 'closed' });
    else h.form.submit();
    assert.equal(search(h).value, ''); assert.equal(panel(h).open, false); assert.equal(rows(h).length, 0);
    force(old); oldInput(); oldClear(); assert.equal(sdk.moderations.length, 0); assert.equal(search(h).value, '');
    if (boundary !== 'room' && boundary !== 'participant') retired(h);
  });
}

for (const event of ['role', 'transferred'] as const) it(`${event} event-only policy remains snapshot-authoritative; actual role loss clears search`, async t => {
  const { h, sdk } = await setup(t), old = rows(h)[0]!; query(h, 'Alice'); panel(h).open = true;
  sdk.emit(event, event === 'role' ? { participantId: sdk.me!.participantId, role: 'audience' }
    : { fromId: sdk.me!.participantId, toId: 'other' });
  assert.equal(rows(h)[0], old); assert.equal(search(h).value, 'Alice'); assert.equal(panel(h).open, true);
  snapshot(sdk, [], { me: { role: 'audience' } }); retired(h); force(old); assert.equal(sdk.moderations.length, 0);
  snapshot(sdk, [person('a', 'Alice')], { me: { role: 'controller' } }); assert.equal(search(h).value, ''); assert.equal(panel(h).open, false);
});

it('input value getter cannot overwrite a newer query handler on the same owner', async t => {
  const { h } = await setup(t); search(h).value = 'Alice';
  onceProperty(search(h), 'value', 'get', () => query(h, 'Bob')); search(h).oninput!();
  assert.equal(search(h).value, 'Bob'); assert.deepEqual(visible(h).map(label), ['Bob']); assert.equal(results(h), '符合 1 / 2 筆舉手申請。');
});

for (const edge of ['get', 'set'] as const) it(`results ${edge} reentry cannot restore older matching counts or query`, async t => {
  const { h } = await setup(t); onceProperty(h.node('hand-queue-results'), 'textContent', edge, () => query(h, 'Bob'));
  query(h, 'nothing'); assert.equal(search(h).value, 'Bob'); assert.deepEqual(visible(h).map(label), ['Bob']);
  assert.equal(results(h), '符合 1 / 2 筆舉手申請。');
});

for (const edge of ['get', 'set'] as const) it(`row hidden ${edge} reentry respects newer state and query`, async t => {
  const { h, sdk } = await setup(t), a = rows(h)[0]!;
  onceProperty(a, 'hidden', edge, () => { snapshot(sdk, [person('a', 'Alex'), person('b', 'Bobby')]); query(h, 'Bob'); });
  query(h, 'missing'); assert.equal(search(h).value, 'Bob'); assert.deepEqual(visible(h).map(label), ['Bobby']);
  assert.equal(results(h), '符合 1 / 2 筆舉手申請。');
});

it('input getter starting new entry cannot copy old private query into the next controller', async t => {
  const { h } = await setup(t); search(h).value = 'old private query';
  onceProperty(search(h), 'value', 'get', () => h.form.submit()); search(h).oninput!(); await flush();
  const next = h.clients.at(-1)!; next.snapshot({ role: 'controller' }); snapshot(next);
  assert.equal(search(h).value, ''); assert.equal(panel(h).open, false); assert.equal(visible(h).length, 2);
});

it('search render silently losing controller authority retires private rows immediately', async t => {
  const { h, sdk } = await setup(t);
  onceProperty(h.node('hand-queue-results'), 'textContent', 'set', () => snapshot(sdk, [], { me: { role: 'audience' } }, false));
  query(h, 'Alice'); retired(h); assert.equal(sdk.moderations.length, 0);
});

const config = testConfig();
function clean(name: string): string {
  const parsed = parseClientMessage(JSON.stringify({ type: 'join', requestId: 'clean', roomId: 'same-room', name }), config.limits);
  assert.equal(parsed.type, 'join'); return parsed.name;
}
function roomModel(count = 120): Room {
  const room = new Room({ roomId: 'same-room', name: 'Synthetic Q&A', code: 'H7K9P3X2', codeRequired: true,
    limits: { maxSpeakers: config.limits.maxSpeakersPerRoom, maxAudience: config.limits.maxAudiencePerRoom }, now: 0,
    controller: { participantId: 'guest', name: 'Controller', resumeToken: 'test-resume' } });
  room.leaveStage('guest');
  for (let i = 0; i < 300; i++) {
    const id = `p-${String(i + 1).padStart(3, '0')}`;
    const name = [19, 69, 119].includes(i) ? '陳小明 ALPHA & <QA>' : i === 120 ? 'Unraised private name' : `Applicant ${String(i + 1).padStart(3, '0')}`;
    room.join({ participantId: id, name: clean(name), resumeToken: `synthetic-resume-${i}` }, i + 1);
    if (i < count) room.raiseHand(id);
  }
  room.assertInvariants(); return room;
}
const moderation = (socket: StageSocket) => socket.sent.filter(m => m.type === 'stage:approve' || m.type === 'stage:reject');
async function actual(t: TestContext, count = 120) {
  const h = await actualApp(t), { socket } = await h.join(), room = roomModel(count);
  const client = h.clients[0] as unknown as StageClient;
  const deliver = (to = socket) => to.deliver({ type: 'room:state', ...room.snapshot('guest') }); deliver(); await flush();
  return { h, socket, room, client, deliver };
}

it('actual SDK + 301-seat Room filters 120 requests to three decoded same-name IDs in original order with zero commands/media', async t => {
  const { h, socket, room, client } = await actual(t), originals = [...rows(h)], sent = socket.sent.length, peers = StagePeer.instances.length;
  const before = JSON.stringify(room.snapshot('guest')); assert.equal(client.state!.hands.length, 120); assert.equal(room.participants.size, 301);
  query(h, '  alpha & <qa>  '); assert.equal(rows(h).length, 120); assert.equal(visible(h).length, 3);
  assert.deepEqual(visible(h), [originals[19], originals[69], originals[119]]); assert.equal(results(h), '符合 3 / 120 筆舉手申請。');
  assert.equal(rows(h).reduce((n, row) => n + row.children[1]!.children.length, 0), 240);
  assert.equal(h.node('hand-queue-summary').textContent, '舉手申請（120）');
  for (const value of ['p-020', room.code, 'synthetic-resume', 'Unraised private name', '&lt;QA&gt;']) {
    query(h, value); assert.equal(visible(h).length, 0, value);
  }
  query(h, '陳小明'); assert.equal(visible(h).length, 3); assert.equal(visible(h)[0]!.children[0]!.children.length, 0);
  clear(h).click(); assert.deepEqual([...rows(h)], originals); assert.equal(visible(h).length, 120);
  await h.tick(100); assert.equal(socket.sent.length, sent); assert.equal(JSON.stringify(room.snapshot('guest')), before);
  assert.equal(StagePeer.instances.length, peers); assert.equal(h.captures.length, 0); assert.equal(h.audio.plays, 0);
});

it('actual SDK decodes once for entity/markup matching without parsing displayed HTML', async t => {
  const h = await actualApp(t), { socket } = await h.join();
  socket.deliver({ type: 'room:state', ...actualState(), hands: [person('a', '&lt;img src=x&gt; &amp;amp; &quot;x&quot; &#39;y&#39;')] });
  const row = rows(h)[0]!; query(h, '<IMG'); assert.equal(row.hidden, false); assert.equal(row.children[0]!.children.length, 0);
  assert.equal(label(row), '<img src=x> &amp; "x" \'y\''); query(h, '&lt;img'); assert.equal(row.hidden, true);
  query(h, '&amp;'); assert.equal(row.hidden, false); assert.equal(moderation(socket).length, 0);
});

for (const outcome of ['ok', 'error'] as const) it(`actual SDK pending ${outcome} while filtered releases only exact same-name target reservation`, async t => {
  const { h, socket } = await actual(t), target = rows(h)[19]!, other = rows(h)[69]!;
  query(h, 'alpha'); button(target, 'reject').click(); await h.until(() => moderation(socket).length === 1, 'reject send');
  const request = moderation(socket)[0]!; assert.equal(request.targetId, 'p-020'); locked(target, true); locked(other, false);
  query(h, 'Applicant'); locked(target, true, true); target.hidden = false; force(target); await h.tick(50); assert.equal(moderation(socket).length, 1);
  socket.deliver(outcome === 'ok' ? { type: 'ok', requestId: request.requestId }
    : { type: 'error', requestId: request.requestId, code: 'forbidden', message: 'wire error remains global' }); await flush();
  locked(target, false, true); query(h, 'alpha'); locked(target, false); assert.equal(rows(h)[19], target);
  if (outcome === 'error') assert.equal(h.node('last-error').textContent, '最近錯誤：wire error remains global');
  button(other, 'reject').click(); await h.until(() => moderation(socket).length === 2, 'other same-name request');
  assert.equal(moderation(socket)[1]!.targetId, 'p-070'); socket.deliver({ type: 'ok', requestId: moderation(socket)[1]!.requestId }); await flush();
});

it('actual SDK reconnect keeps search history while resume ACK alone cannot admit a command', async t => {
  const { h, socket, room, deliver } = await actual(t), original = rows(h)[19]!; query(h, 'ALPHA'); panel(h).open = true;
  socket.close(); await flush(); assert.equal(rows(h)[19], original); assert.equal(search(h).value, 'ALPHA'); locked(original, false, true);
  query(h, '陳小明'); force(original); await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  resumed.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => resumed.sent.some(m => m.type === 'join'), 'resume join');
  const request = resumed.sent.find(m => m.type === 'join')!; assert.equal(request.resumeToken, room.get('guest')!.resumeToken);
  resumed.deliver({ type: 'ok', requestId: request.requestId }); await flush(); locked(original, false, true); force(original);
  assert.equal(moderation(resumed).length, 0); deliver(resumed); await flush(); locked(original, false);
  assert.equal(search(h).value, '陳小明'); assert.equal(panel(h).open, true); assert.equal(rows(h)[19], original); assert.equal(visible(h).length, 3);
});

it('actual Room rename/withdraw/re-raise changes only matching projection and authoritative server order', async t => {
  const { h, room, deliver, socket } = await actual(t), original = rows(h)[19]!; query(h, 'alpha');
  room.rename('p-001', clean('New ALPHA')); room.get('p-070')!.connected = false; deliver();
  assert.equal(visible(h).length, 4); assert.equal(rows(h)[19], original); assert.equal(label(rows(h)[69]!), '陳小明 ALPHA & <QA>（暫時離線）');
  room.withdrawHand('p-020'); deliver(); assert.equal(original.parentElement, null); room.raiseHand('p-020'); deliver();
  assert.notEqual(rows(h).at(-1), original); assert.equal(visible(h).at(-1), rows(h).at(-1));
  assert.deepEqual(rows(h).map(label), room.snapshot('guest').hands.map(p => `${decodeName(p.name)}${p.connected ? '' : '（暫時離線）'}`));
  force(original); await h.tick(100); assert.equal(moderation(socket).length, 0);
});

it('final ownership state getter cannot let an outer input overwrite a newer nested query', async t => {
  const { h, sdk } = await setup(t); query(h, 'Alice'); search(h).value = 'stale outer';
  let state = sdk.state, reads = 0, fired = false;
  Object.defineProperty(sdk, 'state', { configurable: true,
    get() {
      if (new Error().stack?.split('\n')[2]?.includes('handQueueInputCurrent') && ++reads === 6) {
        fired = true; query(h, 'Bob');
      }
      return state;
    },
    set(next: EmbedSdk['state']) { state = next; },
  });
  search(h).oninput!(); assert.equal(fired, true); assert.equal(search(h).value, 'Bob');
  assert.deepEqual(visible(h).map(label), ['Bob']); assert.equal(results(h), '符合 1 / 2 筆舉手申請。');
});

it('final row hidden getter cannot submit when current name changes in place after the earlier match', async t => {
  const { h, sdk } = await setup(t); query(h, 'Alice'); const row = rows(h)[0]!;
  let hidden = row.hidden, reads = 0, fired = false;
  Object.defineProperty(row, 'hidden', { configurable: true,
    get() {
      if (new Error().stack?.split('\n')[2]?.includes('currentHandRow') && ++reads === 4) {
        fired = true; sdk.state!.hands[0]!.name = 'Bob';
      }
      return hidden;
    },
    set(next: boolean) { hidden = next; },
  });
  button(row).click(); await flush(); assert.equal(fired, true); assert.equal(sdk.moderations.length, 0);
  locked(row, false, true); assert.equal(results(h), '符合 0 / 2 筆舉手申請。沒有符合搜尋的舉手者。');
});

for (const change of ['query', 'room', 'role'] as const) it(`pending paint ${change} reentry cannot submit or strand a hidden pending lock`, async t => {
  const { h, sdk } = await setup(t); query(h, 'Alice'); const row = rows(h)[0]!, approve = button(row);
  const original = approve.setAttribute.bind(approve); let fired = false;
  approve.setAttribute = (key, value) => {
    original(key, value);
    if (!fired && key === 'aria-busy' && value === 'true') {
      fired = true;
      if (change === 'query') query(h, 'Bob');
      else if (change === 'room') snapshot(sdk, undefined, { roomId: 'new-room' });
      else sdk.state!.me.role = 'audience';
    }
  };
  approve.click(); await flush(); assert.equal(fired, true); assert.equal(sdk.moderations.length, 0);
  assert.equal(approve.getAttribute('aria-busy'), 'false');
  if (change === 'query') { assert.equal(search(h).value, 'Bob'); locked(row, false, true); }
  else if (change === 'room') { assert.equal(search(h).value, ''); assert.equal(visible(h).length, 2); }
  else retired(h);
});

for (const operation of ['closeRoom', 'transferControl'] as const) {
  it(`input getter loss invalidates original ${operation} consent before corrective search retirement can restore state`, async t => {
    let mutate = () => {};
    const h = await actualApp(t, { confirm: () => { mutate(); return true; } }), { socket } = await h.join();
    const client = h.clients[0] as unknown as StageClient, room = roomModel(4); room.approve('guest', 'p-001', 10);
    const deliver = () => socket.deliver({ type: 'room:state', ...room.snapshot('guest') }); deliver(); query(h, 'Applicant');
    let calls = 0; t.mock.method(client, operation, async () => { calls++; });
    let value = search(h).value, armed = false, lost = false, restored = false;
    Object.defineProperty(search(h), 'value', { configurable: true,
      get() { const captured = value; if (armed) { armed = false; lost = true; client.state!.me.role = 'audience'; } return captured; },
      set(next: string) { if (lost && !restored) { restored = true; deliver(); } value = next; },
    });
    mutate = () => { armed = true; search(h).oninput!(); };
    if (operation === 'closeRoom') h.node('close-room').click();
    else h.node('stage-management-list').children[0]!.children[1]!.children[2]!.click();
    await flush(); assert.equal(lost, true); assert.equal(restored, true); assert.equal(calls, 0); assert.equal(h.confirmations.length, 1);
  });
}

for (const event of ['role', 'transferred'] as const) for (const operation of ['closeRoom', 'transferControl'] as const) {
  it(`original ${operation} consent stays fenced on ${event} before new search setter reentry`, async t => {
    let mutate = () => {};
    const h = await actualApp(t, { confirm: () => { mutate(); return true; } }), { socket } = await h.join();
    const client = h.clients[0] as unknown as StageClient, room = roomModel(4); room.approve('guest', 'p-001', 10);
    const deliver = () => socket.deliver({ type: 'room:state', ...room.snapshot('guest') }); deliver(); query(h, 'Applicant');
    let calls = 0; t.mock.method(client, operation, async () => { calls++; });
    let value = search(h).value, once = true;
    Object.defineProperty(search(h), 'value', { configurable: true, get: () => value,
      set(next: string) { if (once) { once = false; deliver(); } value = next; },
    });
    mutate = () => {
      socket.deliver(event === 'role' ? { type: 'role:update', participantId: 'guest', role: 'audience' }
        : { type: 'control:transferred', fromId: 'guest', toId: 'p-001' });
      clear(h).click();
    };
    if (operation === 'closeRoom') h.node('close-room').click();
    else h.node('stage-management-list').children[0]!.children[1]!.children[2]!.click();
    await flush(); assert.equal(once, false); assert.equal(calls, 0); assert.equal(h.confirmations.length, 1);
  });
}
