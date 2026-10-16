import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ClientMessage, RoomStatePayload, ServerMessage, ParticipantView } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { harness, testConfig, FakeSession, SENDRECV_OFFER, RECVONLY_OFFER, sine } from './helpers.ts';
import { Deferred, embedApp, flush, type EmbedNode, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket, StagePeer } from './fixtures/embedSdkApp.ts';

// Entire embed module. Controlled DOM and media do not establish native-browser,
// keyboard, focus, accessibility-tree, physical microphone or audible-media behavior.
type View = { node(id: string): EmbedNode };
const panel = (h: View) => h.node('stage-management');
const list = (h: View) => h.node('stage-management-list');
const summary = (h: View) => h.node('stage-management-summary').textContent;
const caveat = '解除靜音鎖定會保留對方自行靜音設定；移下台後仍留在房間。';
function row(h: View, index = 0) {
  const node = list(h).children[index]; assert.ok(node, `stage row ${index}`);
  const name = node.children[0], actions = node.children[1]; assert.ok(name); assert.ok(actions);
  const mute = actions.children[0], remove = actions.children[1]; assert.ok(mute); assert.ok(remove);
  return { node, name, actions, mute, remove };
}
const person = (id: string, patch: Partial<ParticipantView> = {}): ParticipantView => ({
  participantId: id, name: id, role: 'speaker', onStage: true, handRaised: false, muted: false,
  forceMuted: false, connected: true, gainDb: 0, joinedAt: 0, ...patch,
});
function snapshot(sdk: EmbedSdk, speakers: ParticipantView[] = [person('first'), person('second')],
  patch: { roomId?: string; me?: Partial<ParticipantView> } = {}, emit = true): void {
  assert.ok(sdk.state); assert.ok(sdk.me);
  sdk.state = { ...sdk.state, ...patch, speakers, me: { ...sdk.me, ...patch.me } }; sdk.me = sdk.state.me;
  if (emit) sdk.emit('state', sdk.state);
}
function retired(h: View): void {
  assert.equal(panel(h).hidden, true); assert.equal(panel(h).open, false);
  assert.equal(list(h).children.length, 0); assert.equal(summary(h), '');
  assert.equal(h.node('stage-management-notice').textContent, '');
}
function locked(buttons: ReturnType<typeof row>, pending = true, disabled = pending): void {
  for (const button of [buttons.mute, buttons.remove]) {
    assert.equal(button.disabled, disabled); assert.equal(button.attributes['aria-busy'], String(pending));
  }
}
function force(button: EmbedNode): void { button.disabled = false; button.invoke(); }
function notice(h: View, text: string): void {
  assert.equal(h.node('error-notice').hidden, false); assert.equal(h.node('last-error').textContent, `最近錯誤：${text}`);
}
async function app(t: TestContext, onStage = false) {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role: 'controller', onStage });
  snapshot(sdk); return { h, sdk };
}

it('authored embed stage panel is one native hidden closed details outside the form with labeled list and privacy notice', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
  const details = html.match(/<details\b[^>]*id="stage-management"[^>]*>[\s\S]*?<\/details>/)?.[0]; assert.ok(details);
  assert.match(details, /^<details\b[^>]*\bhidden(?:\s|>)/); assert.doesNotMatch(details, /\bopen(?:\s|>)/);
  assert.match(details, /<summary id="stage-management-summary">舞台管理（0）<\/summary>/);
  assert.match(details, /<ul id="stage-management-list" class="people" aria-label="其他台上發言者"><\/ul>/);
  assert.ok(details.includes(caveat)); assert.ok(html.indexOf(details) > html.indexOf('</form>'));
  for (const id of ['stage-management', 'stage-management-summary', 'stage-management-notice', 'stage-management-list'])
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1);
  assert.doesNotMatch(details, /aria-live|role="(?:status|alert)"/); assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});

it('whole embed stage management stays retired before entry, loading and first snapshot, then shows an empty controller panel', async t => {
  const gate = new Deferred(), h = embedApp({ libraryLoad: gate.promise });
  t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  retired(h); h.form.submit(); await flush(); retired(h); gate.resolve(); await flush(); retired(h);
  h.clients[0]!.snapshot({ role: 'controller' }); assert.equal(panel(h).hidden, false);
  assert.equal(summary(h), '舞台管理（0）'); assert.equal(h.node('stage-management-notice').textContent, `目前沒有其他台上發言者。${caveat}`);
});
for (const [role, onStage] of [['audience', false], ['speaker', true]] as const) {
  it(`whole embed ${role} has no controller stage panel`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ role, onStage }); snapshot(sdk);
    retired(h); assert.equal(sdk.stageModerations.length, 0);
  });
}
for (const onStage of [false, true]) for (const status of ['waiting', 'live'] as const) {
  it(`whole embed controller onStage=${onStage} status=${status} renders safe ordered distinct-ID speakers and offline retained seats`, async t => {
    const { h, sdk } = await app(t, onStage); sdk.setStatus(status);
    snapshot(sdk, [person('a', { name: '<img src=x>' }), person('b', { name: '<img src=x>', connected: false, forceMuted: true, muted: true })]);
    assert.equal(panel(h).hidden, false); assert.equal(summary(h), '舞台管理（2）');
    assert.equal(row(h).name.textContent, '<img src=x> · 未靜音 · 靜音未鎖定');
    assert.equal(row(h, 1).name.textContent, '<img src=x> · 已靜音 · 靜音已鎖定 · 暫時離線（保留席位）');
    for (const i of [0, 1]) {
      const r = row(h, i); assert.equal(r.node.tagName, 'LI'); assert.equal(r.name.tagName, 'SPAN'); assert.equal(r.name.children.length, 0);
      assert.equal(r.mute.type, 'button'); assert.equal(r.remove.type, 'button'); assert.equal(r.remove.textContent, '移下台');
      assert.equal(r.remove.attributes['aria-label'], '將 <img src=x> 移下台'); locked(r, false);
    }
    assert.equal(row(h).mute.textContent, '鎖定靜音'); assert.equal(row(h, 1).mute.textContent, '解除靜音鎖定');
    assert.equal(row(h).mute.attributes['aria-label'], '鎖定靜音：<img src=x>');
    row(h).mute.click(); row(h, 1).mute.click();
    assert.deepEqual(sdk.stageModerations.map(({ kind, id }) => [kind, id]), [['forceMute', 'a'], ['forceUnmute', 'b']]);
  });
}
it('whole embed projects only other nonempty unique current stage speakers while retaining snapshot order', async t => {
  const { h, sdk } = await app(t);
  snapshot(sdk, [person(''), person(sdk.me!.participantId), person('a'), person('a', { name: 'duplicate' }),
    person('controller', { role: 'controller' }), person('audience', { role: 'audience' }), person('offstage', { onStage: false }),
    person('b', { connected: false }), person('later-valid', { role: 'audience' }), person('later-valid')]);
  assert.equal(summary(h), '舞台管理（3）'); assert.equal(row(h).name.textContent, 'a · 未靜音 · 靜音未鎖定');
  row(h, 1).remove.click(); row(h, 2).mute.click();
  assert.deepEqual(sdk.stageModerations.map(({ kind, id }) => [kind, id]), [['removeFromStage', 'b'], ['forceMute', 'later-valid']]);
});
it('whole embed preserves keyed rows, disclosure choice and live labels across reorders and controller personal-stage updates', async t => {
  const { h, sdk } = await app(t), a = row(h), b = row(h, 1); panel(h).open = true;
  for (let i = 0; i < 4; i++) snapshot(sdk, undefined, { me: { onStage: i % 2 === 0 } });
  assert.equal(row(h).node, a.node); assert.equal(row(h, 1).node, b.node);
  snapshot(sdk, [person('second', { name: 'renamed', muted: true }), person('first', { forceMuted: true, muted: true })]);
  assert.equal(row(h).node, b.node); assert.equal(row(h, 1).node, a.node); assert.equal(panel(h).open, true);
  assert.equal(b.name.textContent, 'renamed · 已靜音 · 靜音未鎖定'); assert.equal(b.mute.textContent, '鎖定靜音');
  assert.equal(a.mute.textContent, '解除靜音鎖定'); assert.equal(b.remove.attributes['aria-label'], '將 renamed 移下台');
});
for (const forceMuted of [false, true]) it(`whole embed rereads silent forceMuted=${forceMuted} at admission independent of effective self-mute or stale label`, async t => {
  const { h, sdk } = await app(t), a = row(h);
  snapshot(sdk, [person('first', { muted: true, forceMuted: !forceMuted })]);
  snapshot(sdk, [person('first', { muted: true, forceMuted })], {}, false);
  a.mute.click(); assert.deepEqual(sdk.stageModerations.map(({ kind, id }) => [kind, id]), [[forceMuted ? 'forceUnmute' : 'forceMute', 'first']]);
});
it('whole embed per-target shared pending disables both actions, keeps other targets independent and never treats ACK as state', async t => {
  const { h, sdk } = await app(t), a = row(h), b = row(h, 1);
  sdk.emit('error', new Error('unrelated failure')); a.mute.click(); locked(a); locked(b, false); notice(h, 'unrelated failure');
  a.mute.click(); a.remove.click(); force(a.mute); force(a.remove); assert.equal(sdk.stageModerations.length, 1);
  b.remove.click(); locked(b); snapshot(sdk); locked(a); locked(b); assert.equal(sdk.stageModerations.length, 2);
  sdk.stageModerations[0]!.work.resolve(); await flush(); locked(a, false); locked(b);
  assert.equal(row(h).mute.textContent, '鎖定靜音'); assert.equal(list(h).children.length, 2); notice(h, 'unrelated failure');
});
for (const kind of ['forceMute', 'forceUnmute', 'removeFromStage'] as const) {
  it(`whole embed reserves pending before synchronous ${kind} callback reenters either action`, async t => {
    const { h, sdk } = await app(t); snapshot(sdk, [person('first', { forceMuted: kind === 'forceUnmute' })]);
    const a = row(h), original = sdk[kind].bind(sdk);
    sdk[kind] = id => { force(a.mute); force(a.remove); sdk.emit('state', sdk.state); force(a.remove); return original(id); };
    a[kind === 'removeFromStage' ? 'remove' : 'mute'].click(); assert.equal(sdk.stageModerations.length, 1); locked(a);
  });
  for (const outcome of ['throw', 'reject'] as const) it(`whole embed current ${kind} ${outcome} reports and permits explicit retry`, async t => {
    const { h, sdk } = await app(t); snapshot(sdk, [person('first', { forceMuted: kind === 'forceUnmute' })]);
    const a = row(h), original = sdk[kind].bind(sdk);
    if (outcome === 'throw') sdk[kind] = () => { throw new Error('current failure'); };
    a[kind === 'removeFromStage' ? 'remove' : 'mute'].click();
    if (outcome === 'reject') sdk.stageModerations[0]!.work.reject('current failure'); await flush();
    notice(h, 'current failure'); locked(a, false); sdk[kind] = original;
    a[kind === 'removeFromStage' ? 'remove' : 'mute'].click(); locked(a); sdk.stageModerations.at(-1)!.work.resolve(); await flush();
    locked(a, false); notice(h, 'current failure');
  });
  it(`whole embed absent or removed ${kind} fails closed only for the selected action`, async t => {
    const { h, sdk } = await app(t); Reflect.set(sdk, kind, undefined);
    snapshot(sdk, [person('first', { forceMuted: kind === 'forceUnmute' })]); const a = row(h);
    const selected = kind === 'removeFromStage' ? a.remove : a.mute, other = kind === 'removeFromStage' ? a.mute : a.remove;
    assert.equal(selected.disabled, true); assert.equal(other.disabled, false); force(selected); assert.equal(sdk.stageModerations.length, 0);
    other.click(); assert.equal(sdk.stageModerations.length, 1); sdk.stageModerations[0]!.work.resolve(); await flush();
    Reflect.set(sdk, kind, (id: string) => { assert.equal(id, 'first'); return Promise.resolve(); }); sdk.emit('state', sdk.state);
    assert.equal(selected.disabled, false); Reflect.set(sdk, kind, undefined); force(selected); assert.equal(sdk.stageModerations.length, 1);
  });
}
// Synthetic render reentry checks the final dispatch guard, without claiming native DOM writes invoke callbacks.
for (const kind of ['forceMute', 'forceUnmute', 'removeFromStage'] as const)
  for (const change of ['role', 'room', 'participant', 'reconnecting', 'row', 'button', 'method', 'target'] as const)
    it(`whole embed reserve-time ${change} change blocks obsolete ${kind} dispatch`, async t => {
      const { h, sdk } = await app(t); snapshot(sdk, [person('first', { forceMuted: kind === 'forceUnmute' })]);
      const a = row(h), button = kind === 'removeFromStage' ? a.remove : a.mute;
      let fired = false; const original = a.mute.setAttribute.bind(a.mute);
      a.mute.setAttribute = (key, value) => {
        original(key, value); if (fired || key !== 'aria-busy' || value !== 'true') return; fired = true;
        if (change === 'role') snapshot(sdk, [person('first')], { me: { role: 'audience' } }, false);
        else if (change === 'room') snapshot(sdk, [person('first')], { roomId: 'replacement-room' }, false);
        else if (change === 'participant') snapshot(sdk, [person('first')], { me: { participantId: 'replacement-controller' } }, false);
        else if (change === 'reconnecting') sdk.status = 'reconnecting';
        else if (change === 'row') a.node.remove();
        else if (change === 'button') button.remove();
        else if (change === 'method') Reflect.set(sdk, kind, undefined);
        else snapshot(sdk, [], {}, false);
      };
      sdk.emit('error', new Error('retain feedback')); button.click(); await flush();
      assert.equal(fired, true); assert.equal(sdk.stageModerations.length, 0); notice(h, 'retain feedback');
    });
it('whole embed unavailable forceMute does not disable unlock selected from the current forceMuted state', async t => {
  const { h, sdk } = await app(t); Reflect.set(sdk, 'forceMute', undefined);
  snapshot(sdk, [person('first', { forceMuted: true, muted: true })]); locked(row(h), false); row(h).mute.click();
  assert.equal(sdk.stageModerations[0]!.kind, 'forceUnmute');
});
for (const outcome of ['resolve', 'reject'] as const) it(`whole embed disappeared and reappeared same-ID stays pending until ${outcome}, with no old-row feedback`, async t => {
  const { h, sdk } = await app(t), old = row(h); old.remove.click(); const pending = sdk.stageModerations[0]!.work;
  snapshot(sdk, [person('second')]); assert.equal(old.node.parentElement, null); assert.equal(old.mute.disabled, true); force(old.remove);
  snapshot(sdk); const replacement = row(h); assert.notEqual(replacement.node, old.node); locked(replacement);
  force(replacement.mute); force(old.mute); assert.equal(sdk.stageModerations.length, 1); sdk.emit('error', new Error('new independent failure'));
  if (outcome === 'resolve') pending.resolve(); else pending.reject('old row failure'); await flush();
  locked(replacement, false); notice(h, 'new independent failure'); replacement.mute.click(); locked(replacement);
  force(old.remove); assert.equal(sdk.stageModerations.length, 2);
});
for (const kind of ['mute', 'remove'] as const) for (const detach of ['row', 'button'] as const)
  it(`whole embed detached ${detach} retained ${kind} handler cannot dispatch or erase feedback`, async t => {
    const { h, sdk } = await app(t), a = row(h); (detach === 'row' ? a.node : a[kind]).remove();
    sdk.emit('error', new Error('keep feedback')); force(a[kind]); assert.equal(sdk.stageModerations.length, 0); notice(h, 'keep feedback');
  });
it('whole embed stage management leaves hand and personal action lanes independent', async t => {
  const { h, sdk } = await app(t, true); sdk.state!.hands = [person('hand', { role: 'audience', onStage: false, handRaised: true })]; sdk.emit('state', sdk.state);
  row(h).mute.click(); h.node('hand-queue-list').children[0]!.children[1]!.children[0]!.click(); h.mic.click(); h.stage.click();
  assert.equal(sdk.stageModerations.length, 1); assert.equal(sdk.moderations.length, 1);
  assert.deepEqual(sdk.actions.map(action => action.type), ['mute', 'leaveStage']); locked(row(h));
  assert.equal(sdk.deviceLists.length, 0); assert.equal(sdk.inputSelections.length, 0); assert.equal(sdk.retryCalls, 0);
  assert.equal(sdk.renames.length, 0); assert.equal(sdk.roomRenames.length, 0); assert.equal(h.clock.timers.length, 0);
});
it('whole embed reconnect retains rows, open choice and pending; active return does not replay', async t => {
  const { h, sdk } = await app(t), a = row(h); panel(h).open = true; a.mute.click(); sdk.setStatus('reconnecting');
  assert.equal(row(h).node, a.node); assert.equal(panel(h).open, true); assert.equal(summary(h), '舞台管理（2） · 上次收到');
  assert.ok(h.node('stage-management-notice').textContent.includes('重新連線中')); locked(a); locked(row(h, 1), false, true);
  force(a.remove); force(row(h, 1).remove); assert.equal(sdk.stageModerations.length, 1);
  sdk.setStatus('live'); locked(a); locked(row(h, 1), false); assert.equal(panel(h).open, true);
  sdk.stageModerations[0]!.work.resolve(); await flush(); locked(a, false); assert.equal(sdk.stageModerations.length, 1);
});
it('whole embed reconnect settlement releases only its token and suppresses promise-specific feedback', async t => {
  const { h, sdk } = await app(t); row(h).mute.click(); row(h, 1).remove.click(); sdk.setStatus('reconnecting');
  sdk.emit('error', new Error('global error')); sdk.stageModerations[0]!.work.reject('offline promise failure'); await flush();
  locked(row(h), false, true); locked(row(h, 1)); notice(h, 'global error'); sdk.setStatus('live'); locked(row(h), false); locked(row(h, 1));
});
for (const identity of ['role', 'room', 'participant'] as const) it(`whole embed reconnect cannot establish a fresh ${identity} owner`, async t => {
  const { h, sdk } = await app(t); sdk.setStatus('reconnecting');
  if (identity === 'role') { snapshot(sdk, [], { me: { role: 'audience' } }); snapshot(sdk, [person('first')], { me: { role: 'controller' } }); }
  else snapshot(sdk, [person('first')], identity === 'room' ? { roomId: 'new-room' } : { me: { participantId: 'new-controller' } });
  retired(h); sdk.setStatus('live'); assert.equal(panel(h).hidden, false); locked(row(h), false);
});
for (const boundary of ['role', 'missing state', 'room', 'participant', 'leave', 'disconnected', 'closed', 'kicked', 'new entry'] as const)
  for (const outcome of ['resolve', 'reject'] as const) it(`whole embed ${boundary} retires stage owner and late ${outcome} cannot release new work or overwrite feedback`, async t => {
    const { h, sdk } = await app(t), old = row(h); panel(h).open = true; old.mute.click(); const work = sdk.stageModerations[0]!.work;
    let next = sdk;
    if (boundary === 'role') snapshot(sdk, [], { me: { role: 'audience' } });
    else if (boundary === 'missing state') { sdk.state = null; sdk.emit('status', sdk.status); }
    else if (boundary === 'room') snapshot(sdk, [], { roomId: 'other-room' });
    else if (boundary === 'participant') snapshot(sdk, [], { me: { participantId: 'other-controller' } });
    else if (boundary === 'leave') h.leave.click();
    else if (boundary === 'disconnected') sdk.setStatus('disconnected');
    else if (boundary === 'closed') sdk.emit('closed', { reason: 'closed' });
    else if (boundary === 'kicked') sdk.emit('kicked', {}); else h.form.submit();
    assert.equal(old.mute.disabled, true); assert.equal(old.remove.disabled, true); assert.equal(panel(h).open, false);
    if (boundary === 'room' || boundary === 'participant') { assert.equal(panel(h).hidden, false); assert.equal(list(h).children.length, 0); }
    else retired(h);
    if (['leave', 'disconnected', 'closed', 'kicked', 'new entry'].includes(boundary)) {
      if (boundary === 'new entry') { await flush(); next = h.clients.at(-1)!; next.snapshot({ role: 'controller' }); }
      else next = await h.join({ role: 'controller' });
    } else if (boundary === 'missing state') sdk.snapshot({ role: 'controller' });
    else snapshot(sdk, [], { me: { role: 'controller' } });
    snapshot(next); const current = row(h); current.remove.click(); locked(current); panel(h).open = true;
    next.emit('error', new Error('new-owner failure')); const status = h.status.textContent;
    if (outcome === 'resolve') work.resolve(); else work.reject('retired failure'); await flush();
    assert.equal(row(h).node, current.node); locked(current); assert.equal(panel(h).open, true); notice(h, 'new-owner failure'); assert.equal(h.status.textContent, status);
    const count = next.stageModerations.length; force(old.mute); force(old.remove); assert.equal(next.stageModerations.length, count);
  });
for (const phase of ['admission', 'settlement'] as const)
  for (const boundary of ['role', 'room', 'participant', 'missing state', 'disconnected', 'reconnecting', 'target left', 'target absent'] as const)
    it(`whole embed ${phase} rechecks silent ${boundary} before dispatch or feedback`, async t => {
      const { h, sdk } = await app(t), old = row(h);
      if (phase === 'settlement') old.mute.click(); sdk.emit('error', new Error('preserve feedback'));
      if (boundary === 'missing state') sdk.state = null;
      else if (boundary === 'disconnected' || boundary === 'reconnecting') sdk.status = boundary;
      else if (boundary === 'target absent') snapshot(sdk, [], {}, false);
      else if (boundary === 'target left') snapshot(sdk, [person('first', { onStage: false })], {}, false);
      else snapshot(sdk, [person('first')], boundary === 'role' ? { me: { role: 'audience' } }
        : boundary === 'room' ? { roomId: 'changed' } : { me: { participantId: 'changed' } }, false);
      if (phase === 'admission') { force(old.remove); assert.equal(sdk.stageModerations.length, 0); }
      else { sdk.stageModerations[0]!.work.reject('obsolete settlement'); await flush(); }
      notice(h, 'preserve feedback'); assert.equal(old.remove.disabled, true);
    });
for (const boundary of ['role', 'leave', 'new entry'] as const) it(`whole embed synchronous SDK ${boundary} callback cannot restore retired stage controls`, async t => {
  const { h, sdk } = await app(t), old = row(h);
  sdk.forceMute = () => {
    if (boundary === 'role') snapshot(sdk, [], { me: { role: 'audience' } });
    else if (boundary === 'leave') h.leave.click(); else h.form.submit();
    return Promise.reject(new Error('retired callback failure'));
  };
  old.mute.click(); await flush(); retired(h); assert.equal(h.node('error-notice').hidden, true);
});
it('whole embed cancelled replacement entry cannot revive old stage callbacks or promise feedback', async t => {
  const gate = new Deferred(), h = embedApp({ libraryLoad: async (_url, count) => { if (count === 2) await gate.promise; } });
  t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  const sdk = await h.join({ role: 'controller' }); snapshot(sdk); const old = row(h); old.remove.click();
  h.form.submit(); await flush(); h.node('cancel-join').click(); retired(h); const text = h.status.textContent;
  sdk.stageModerations[0]!.work.reject('old entry failure'); gate.resolve(); await flush();
  force(old.mute); retired(h); assert.equal(h.status.textContent, text); assert.equal(h.clients.length, 1);
});
it('whole embed event-only mute, stage, role and transfer notifications do not replace authoritative stage snapshots', async t => {
  const { h, sdk } = await app(t), a = row(h); a.mute.click();
  sdk.emit('muted', { participantId: 'first', force: true }); sdk.emit('stageleft', { participantId: 'first', reason: 'removed' });
  sdk.emit('role', { participantId: sdk.me!.participantId, role: 'audience' }); sdk.emit('transferred', { fromId: sdk.me!.participantId, toId: 'elsewhere' });
  assert.equal(row(h).node, a.node); assert.equal(summary(h), '舞台管理（2）'); assert.equal(a.mute.textContent, '鎖定靜音'); locked(a);
  row(h, 1).remove.click(); assert.equal(sdk.stageModerations.length, 2);
});

it('whole embed actual SDK decodes stage names exactly once through textContent and safe labels', async t => {
  const h = await actualApp(t), { socket } = await h.join();
  socket.deliver({ type: 'room:state', ...actualState(), speakers: [person('a', { name: '&lt;img src=x&gt; &amp;amp; &quot;x&quot; &#39;y&#39;' })] });
  const a = row(h); assert.equal(a.name.textContent, '<img src=x> &amp; "x" \'y\' · 未靜音 · 靜音未鎖定');
  assert.equal(a.mute.attributes['aria-label'], '鎖定靜音：<img src=x> &amp; "x" \'y\''); assert.equal(a.name.children.length, 0);
});
it('whole embed actual SDK reconnect retains row/open, releases its rejected promise and never replays stage moderation', async t => {
  const h = await actualApp(t), { socket, peer } = await h.join(), state = { ...actualState(), speakers: [person('a'), person('b')] };
  socket.deliver({ type: 'room:state', ...state }); const a = row(h); panel(h).open = true; a.mute.click();
  await h.until(() => socket.sent.some(message => message.type === 'mic:force-mute'), 'lock request');
  const oldRequest = socket.sent.find(message => message.type === 'mic:force-mute')!;
  socket.close(); assert.equal(summary(h), '舞台管理（2） · 上次收到'); assert.equal(row(h).node, a.node); locked(a);
  await flush(); locked(a, false, true); assert.equal(h.node('error-notice').hidden, true); assert.equal(panel(h).open, true);
  force(a.remove); await h.tick(500); const resumed = StageSocket.instances.at(-1)!; assert.notEqual(resumed, socket);
  resumed.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => resumed.sent.some(message => message.type === 'join'), 'resume join');
  const joined = resumed.sent.find(message => message.type === 'join'); assert.ok(joined?.type === 'join'); assert.equal(joined.resumeToken, 'test-resume');
  resumed.deliver({ type: 'ok', requestId: joined.requestId }); await flush(); locked(a, false, true);
  resumed.deliver({ type: 'room:state', ...state }); await flush(); locked(a, false); assert.equal(row(h).node, a.node); assert.equal(panel(h).open, true);
  assert.equal(resumed.sent.filter(message => message.type === 'mic:force-mute' || message.type === 'mic:force-unmute' || message.type === 'stage:remove').length, 0);
  a.remove.click(); await h.until(() => resumed.sent.some(message => message.type === 'stage:remove'), 'explicit remove'); locked(a);
  socket.deliver({ type: 'error', requestId: oldRequest.requestId, code: 'conflict', message: 'obsolete socket error' }); await flush();
  locked(a); assert.equal(h.node('error-notice').hidden, true);
  const request = resumed.sent.find(message => message.type === 'stage:remove')!; resumed.deliver({ type: 'ok', requestId: request.requestId }); await flush(); locked(a, false);
  assert.equal(h.clients.length, 1); assert.equal(StagePeer.instances.length, 1); assert.equal(StagePeer.instances[0], peer); assert.equal(h.captures.length, 0);
});
it('whole embed actual SDK initial state-before-ACK disconnect retires controls despite retained SDK snapshot', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'initial join');
  socket.deliver({ type: 'room:state', ...actualState(), speakers: [person('a')] });
  const a = row(h); panel(h).open = true; socket.close(); await flush();
  assert.equal(h.clients[0]!.status, 'disconnected'); assert.equal(h.clients[0]!.me!.role, 'controller');
  retired(h); assert.equal(a.node.parentElement, null); locked(a, false, true); force(a.mute); force(a.remove);
  socket.deliver({ type: 'room:state', ...actualState(), speakers: [person('a')] }); retired(h);
  assert.equal(socket.sent.filter(message => message.type === 'mic:force-mute').length, 0);
});
it('whole embed actual SDK current-socket global error stays visible while retired promise cannot unlock a new tenure', async t => {
  const h = await actualApp(t), { socket } = await h.join(), state = { ...actualState(), speakers: [person('a')] };
  socket.deliver({ type: 'room:state', ...state }); const old = row(h); old.mute.click();
  await h.until(() => socket.sent.some(message => message.type === 'mic:force-mute'), 'old lock');
  const oldRequest = socket.sent.find(message => message.type === 'mic:force-mute')!;
  socket.deliver({ type: 'room:state', ...state, me: { ...state.me, role: 'audience' } }); retired(h);
  socket.deliver({ type: 'room:state', ...state }); row(h).remove.click();
  await h.until(() => socket.sent.some(message => message.type === 'stage:remove'), 'new tenure removal'); locked(row(h));
  socket.deliver({ type: 'error', requestId: oldRequest.requestId, code: 'forbidden', message: 'global old-command error' }); await flush();
  notice(h, 'global old-command error'); locked(row(h));
  const current = socket.sent.find(message => message.type === 'stage:remove')!; socket.deliver({ type: 'ok', requestId: current.requestId }); await flush();
  locked(row(h), false); notice(h, 'global old-command error'); force(old.remove); assert.equal(socket.sent.filter(message => message.type === 'stage:remove').length, 1);
});
// The complete candidate embed generates every moderation request. Only DOM, socket,
// browser capture and peer boundaries are modeled; SDK, validator, Hub and mixer are real.
type BridgeAction = 'forceMute' | 'forceUnmute' | 'removeFromStage';
type BridgeActualClient = Awaited<ReturnType<typeof actualApp>>['clients'][number];
interface BridgeClient extends BridgeActualClient {
  readonly me: ParticipantView | null;
  readonly state: RoomStatePayload | null;
  join(options: { roomId: string; code?: string; name: string }): Promise<void>;
  raiseHand(): Promise<void>;
  mute(): Promise<void>;
  transferControl(id: string): Promise<void>;
}
const bridgeWireType = { forceMute: 'mic:force-mute', forceUnmute: 'mic:force-unmute', removeFromStage: 'stage:remove' } as const;
const bridgeIsStageRequest = (message: ClientMessage) => message.type === 'mic:force-mute' || message.type === 'mic:force-unmute' || message.type === 'stage:remove';

async function bridgeSetup(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; });
  const server = harness(config), host = await server.create('Synthetic host');
  const h = await actualApp(t);
  let serverWork = Promise.resolve(), requestNo = 0, holdStageAck = false, holdState = false;
  const validated: ClientMessage[] = [], incoming: ServerMessage[] = [];
  const heldStates: ServerMessage[] = [], heldAcks: ServerMessage[] = [];
  const sessions = new Map<StageSocket, Session>();
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this);
    assert.ok(session); this.sent.push(message); validated.push(message);
    serverWork = serverWork.then(() => server.hub.handle(session, message));
  });
  t.after(async () => { await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close(); });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic embed host';
  h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  const session: Session = {
    id: 'candidate-embed-stage',
    send(message) {
      incoming.push(message);
      if (holdState && message.type === 'room:state') { heldStates.push(message); return; }
      if (holdStageAck && message.type === 'ok' && validated.some(request => bridgeIsStageRequest(request) && request.requestId === message.requestId)) {
        heldAcks.push(message); return;
      }
      if (socket.readyState === StageSocket.OPEN) socket.deliver(message);
    },
    close() { socket.close(); },
  };
  sessions.set(socket, session); server.hub.attach(session);
  await h.until(() => h.clients[0]?.me !== null && h.clients[0]?.me !== undefined, 'actual SDK joined');
  await h.tick(200); await serverWork; await flush();
  const client = h.clients[0] as BridgeClient;
  assert.equal(client.me?.role, 'audience'); assert.equal(client.me?.onStage, false);
  assert.equal(StageSocket.instances.length, 1); assert.equal(StagePeer.instances.length, 1);
  assert.equal(server.hub.isJoined(session), true);
  const pid = client.me!.participantId;
  const req = async (actor: FakeSession, message: Omit<ClientMessage, 'requestId'> & Record<string, unknown>) => {
    const requestId = `candidate-stage-setup-${++requestNo}`;
    await server.hub.handle(actor, parseClientMessage(JSON.stringify({ ...message, requestId }), config.limits));
    const reply = actor.inbox.find(message => (message.type === 'ok' || message.type === 'error') && message.requestId === requestId);
    assert.ok(reply); return reply.type === 'error' ? reply.code : 'ok';
  };
  const flushStates = async () => {
    for (const timer of server.timers) if (!timer.cleared && (timer.ms === 0 || timer.ms === config.rooms.presenceBroadcastMs)) {
      timer.cleared = true; timer.fn();
    }
    await nextTurn(); await flush();
  };
  const stageRow = (id: string) => {
    const targets = client.state!.speakers.filter(person => person.role === 'speaker' && person.onStage && person.participantId !== pid);
    const index = targets.findIndex(person => person.participantId === id); assert.ok(index >= 0, `visible stage target ${id}`);
    const node = h.node('stage-management-list').children[index]; assert.ok(node);
    const name = node.children[0], actions = node.children[1]; assert.ok(name); assert.ok(actions);
    const toggle = actions.children[0], remove = actions.children[1]; assert.ok(toggle); assert.ok(remove);
    return { node, name, toggle, remove };
  };
  const command = async (kind: BridgeAction, id: string) => {
    const row = stageRow(id), button = kind === 'removeFromStage' ? row.remove : row.toggle;
    assert.equal(button.disabled, false, `${kind} must be available before click`);
    if (kind !== 'removeFromStage') assert.equal(button.textContent, kind === 'forceMute' ? '鎖定靜音' : '解除靜音鎖定');
    const before = validated.length; button.click();
    await h.tick(200); await serverWork; await flush();
    const requests = validated.slice(before).filter(bridgeIsStageRequest);
    assert.equal(requests.length, 1, 'one generated button click creates exactly one moderation request');
    const request = requests[0]!; assert.equal(request.type, bridgeWireType[kind]);
    assert.ok(request.type === 'mic:force-mute' || request.type === 'mic:force-unmute' || request.type === 'stage:remove');
    assert.equal(request.targetId, id);
    const reply = incoming.find(message => (message.type === 'ok' || message.type === 'error') && message.requestId === request.requestId);
    assert.ok(reply && (reply.type === 'ok' || reply.type === 'error'));
    return reply.type === 'ok' ? { ok: true as const } : { ok: false as const, code: reply.code };
  };
  const approveUI = async (id: string) => {
    const index = client.state!.hands.findIndex(person => person.participantId === id); assert.ok(index >= 0);
    const row = h.node('hand-queue-list').children[index]!;
    row.children[1]!.children[0]!.click(); await h.tick(200); await serverWork; await flush();
    assert.equal(client.state!.speakers.some(person => person.participantId === id), true);
    assert.equal(client.state!.hands.some(person => person.participantId === id), false);
    assert.equal(stageRow(id).node.parentElement, h.node('stage-management-list'));
  };
  const transfer = async () => {
    assert.equal(await req(host.s, { type: 'control:transfer', targetId: pid }), 'ok'); await flush();
    assert.equal(client.me?.role, 'controller'); assert.equal(client.me?.onStage, false);
    assert.equal(h.node('stage-management').hidden, false);
  };
  const applicant = async (name: string) => {
    const s = new FakeSession(); server.hub.attach(s);
    assert.equal(await req(s, { type: 'join', roomId: host.roomId, code: host.code, name }), 'ok');
    const person = { s, id: s.last('room:state')!.me.participantId };
    assert.equal(await req(s, { type: 'hand:raise' }), 'ok'); await flushStates(); return person;
  };
  const sdkApplicant = async (name: string) => {
    const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
    const audio = { autoplay: true, srcObject: null, volume: 1, muted: false, pauses: 0, plays: 0,
      pause() { this.pauses++; }, async play() { this.plays++; } };
    const target = new StageClient({ url: 'wss://stage.example.test/ws', audioElement: audio }) as BridgeClient;
    h.clients.push(target);
    const joining = target.join({ roomId: host.roomId, code: host.code, name });
    const targetSocket = StageSocket.instances.at(-1)!;
    const s = new FakeSession(), send = s.send.bind(s);
    s.send = message => { send(message); if (targetSocket.readyState === StageSocket.OPEN) targetSocket.deliver(message); };
    s.close = () => { targetSocket.close(); };
    sessions.set(targetSocket, s); server.hub.attach(s);
    await h.until(() => target.me !== null, 'actual target SDK joined'); await h.tick(200); await serverWork; await flush(); await joining;
    const raising = target.raiseHand(); await h.tick(200); await serverWork; await flushStates(); await raising;
    return { client: target, id: target.me!.participantId, socket: targetSocket, s, audio, peer: StagePeer.instances.at(-1)! };
  };
  return { config, server, host, h, client, pid, socket, session, validated, incoming, req, flushStates, command, approveUI, transfer, applicant, sdkApplicant, stageRow,
    drain: async () => { await serverWork; await flush(); }, holdAck: () => { holdStageAck = true; }, heldAcks,
    holdStates: () => { holdState = true; }, heldStates,
    releaseStates: () => { holdState = false; for (const message of heldStates.splice(0)) socket.deliver(message); } };
}
type BridgeFixture = Awaited<ReturnType<typeof bridgeSetup>>;
const bridgeMediaCounts = (f: BridgeFixture) => ({ captures: f.h.captures.length, peers: StagePeer.instances.length,
  offers: StagePeer.instances.map(peer => peer.offers.length), plays: f.h.audio.plays, clients: f.h.clients.length, sockets: StageSocket.instances.length });
const bridgeTargetView = (f: BridgeFixture, id: string) => f.client.state!.speakers.find(person => person.participantId === id)!;
function bridgeLocked(row: { toggle: EmbedNode; remove: EmbedNode }, disabled = true): void {
  assert.equal(row.toggle.disabled, disabled); assert.equal(row.remove.disabled, disabled);
}

it('candidate embed offstage controller approves then locks/unlocks a live publisher through generated buttons without controller media work', async t => {
  const f = await bridgeSetup(t), target = await f.applicant('Speaker <img src=x> & name'); await f.transfer(); await f.approveUI(target.id);
  assert.equal(f.h.node('hand-queue-list').children.length, 0);
  assert.equal(f.client.me!.role, 'controller'); assert.equal(f.client.me!.onStage, false);
  assert.equal(bridgeTargetView(f, target.id).name, 'Speaker &lt;img src=x&gt; &amp; name');
  assert.ok(f.stageRow(target.id).name.textContent.includes('Speaker <img src=x> & name'));
  assert.equal(f.stageRow(target.id).name.children.length, 0, 'decoded name stays text rather than participant HTML');
  assert.equal(await f.req(target.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  const room = f.server.transport.rooms.get(f.host.roomId)!, peer = room.peers.get(target.id), before = bridgeMediaCounts(f);
  assert.equal(room.publishers.has(target.id), true); assert.equal(room.subscribers.has(target.id), true);
  assert.equal(f.server.transport.emitUplink(f.host.roomId, target.id, sine(960, 0.4)), true);
  assert.deepEqual(await f.command('forceMute', target.id), { ok: true });
  assert.equal(bridgeTargetView(f, target.id).forceMuted, true); assert.equal(bridgeTargetView(f, target.id).muted, true);
  assert.equal(f.server.transport.emitUplink(f.host.roomId, target.id, sine(960, 0.4)), false);
  assert.equal(await f.req(target.s, { type: 'mic:unmute' }), 'forbidden');
  assert.deepEqual(await f.command('forceUnmute', target.id), { ok: true });
  assert.equal(bridgeTargetView(f, target.id).forceMuted, false); assert.equal(bridgeTargetView(f, target.id).muted, false);
  assert.equal(f.server.transport.emitUplink(f.host.roomId, target.id, sine(960, 0.4)), true);
  assert.equal(room.peers.get(target.id), peer); assert.deepEqual(bridgeMediaCounts(f), before);
  assert.equal(f.h.captures.length, 0);
});

it('candidate embed unlock preserves target self-mute and blocked uplink without a false unmuted notification', async t => {
  const f = await bridgeSetup(t), target = await f.applicant('Self-muted speaker'); await f.transfer(); await f.approveUI(target.id);
  assert.equal(await f.req(target.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  assert.equal(await f.req(target.s, { type: 'mic:mute' }), 'ok');
  const before = bridgeMediaCounts(f), unmuted = target.s.all('mic:unmuted').length;
  assert.deepEqual(await f.command('forceMute', target.id), { ok: true });
  assert.deepEqual(await f.command('forceUnmute', target.id), { ok: true });
  assert.equal(bridgeTargetView(f, target.id).forceMuted, false); assert.equal(bridgeTargetView(f, target.id).muted, true);
  assert.equal(f.stageRow(target.id).toggle.textContent, '鎖定靜音');
  assert.equal(target.s.all('mic:unmuted').length, unmuted);
  assert.equal(f.server.transport.emitUplink(f.host.roomId, target.id, sine(960, 0.4)), false);
  assert.deepEqual(bridgeMediaCounts(f), before);
});

it('candidate embed removal retains joined audience identity, token, peer and downlink while revoking publisher uplink', async t => {
  const f = await bridgeSetup(t), target = await f.applicant('Remove without kick'); await f.transfer(); await f.approveUI(target.id);
  assert.equal(await f.req(target.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  const room = f.server.transport.rooms.get(f.host.roomId)!, peer = room.peers.get(target.id)!;
  const token = target.s.last('room:state')!.resumeToken, before = bridgeMediaCounts(f), oldFrames = peer.received.length;
  const old = f.stageRow(target.id);
  assert.deepEqual(await f.command('removeFromStage', target.id), { ok: true });
  const me = target.s.last('room:state')!.me;
  assert.equal(me.role, 'audience'); assert.equal(me.onStage, false); assert.equal(me.connected, true);
  assert.equal(me.participantId, target.id); assert.equal(target.s.last('room:state')!.resumeToken, token);
  assert.equal(target.s.last('stage:left')!.reason, 'removed'); assert.equal(target.s.all('kicked').length, 0);
  assert.equal(target.s.closed, undefined); assert.equal(f.server.hub.isJoined(target.s), true);
  assert.equal(f.client.state!.audience!.some(person => person.participantId === target.id), true);
  assert.equal(f.client.state!.speakers.some(person => person.participantId === target.id), false);
  assert.equal(old.node.parentElement, null); bridgeLocked(old);
  assert.equal(room.peers.get(target.id), peer); assert.equal(room.subscribers.has(target.id), true); assert.equal(room.publishers.has(target.id), false);
  assert.equal(f.server.transport.emitUplink(f.host.roomId, target.id, sine(960, 0.4)), false);
  assert.equal(await f.req(f.host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  assert.equal(f.server.transport.emitUplink(f.host.roomId, f.host.id, sine(960, 0.4)), true);
  f.server.mixers.get(f.host.roomId)!.tick(); assert.equal(peer.received.length, oldFrames + 1);
  assert.ok(peer.received.at(-1)!.some(sample => sample !== 0), 'later real mixer audio reaches retained audience subscriber');
  assert.deepEqual(bridgeMediaCounts(f), before);
  assert.equal(await f.req(target.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
  assert.equal(room.peers.get(target.id), peer); assert.equal(room.subscribers.has(target.id), true);
});

it('candidate embed manages offline retained speaker and removal preserves its downlink and same-ID audience resume', async t => {
  const f = await bridgeSetup(t), target = await f.applicant('Offline retained speaker'); await f.transfer(); await f.approveUI(target.id);
  assert.equal(await f.req(target.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  const token = target.s.last('room:state')!.resumeToken, room = f.server.transport.rooms.get(f.host.roomId)!, peer = room.peers.get(target.id)!;
  await f.server.hub.detach(target.s); await f.flushStates();
  assert.equal(bridgeTargetView(f, target.id).connected, false); assert.equal(room.peers.get(target.id), peer);
  bridgeLocked(f.stageRow(target.id), false);
  const before = bridgeMediaCounts(f), oldFrames = peer.received.length;
  assert.deepEqual(await f.command('forceMute', target.id), { ok: true }); assert.equal(bridgeTargetView(f, target.id).forceMuted, true);
  assert.deepEqual(await f.command('forceUnmute', target.id), { ok: true }); assert.equal(bridgeTargetView(f, target.id).forceMuted, false);
  assert.deepEqual(await f.command('removeFromStage', target.id), { ok: true });
  assert.equal(f.client.state!.audience!.find(person => person.participantId === target.id)!.connected, false);
  assert.equal(room.peers.get(target.id), peer); assert.equal(room.subscribers.has(target.id), true); assert.equal(room.publishers.has(target.id), false);
  assert.equal(await f.req(f.host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  assert.equal(f.server.transport.emitUplink(f.host.roomId, f.host.id, sine(960, 0.4)), true);
  f.server.mixers.get(f.host.roomId)!.tick(); assert.equal(peer.received.length, oldFrames + 1);
  assert.ok(peer.received.at(-1)!.some(sample => sample !== 0));
  const resumed = new FakeSession(); f.server.hub.attach(resumed);
  assert.equal(await f.req(resumed, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Offline retained speaker', resumeToken: token }), 'ok');
  assert.equal(resumed.last('room:state')!.me.participantId, target.id); assert.equal(resumed.last('room:state')!.me.role, 'audience');
  assert.equal(resumed.last('room:state')!.me.onStage, false); assert.equal(resumed.last('room:state')!.resumeToken, token);
  assert.equal(f.server.hub.isJoined(resumed), true); assert.equal(room.peers.get(target.id), peer);
  assert.deepEqual(bridgeMediaCounts(f), before);
});

it('candidate embed held removal ACK keeps same-ID reapproved replacement locked until exact operation settles', async t => {
  const f = await bridgeSetup(t), target = await f.applicant('Pending removed target'); await f.transfer(); await f.approveUI(target.id);
  f.h.node('stage-management').open = true; const old = f.stageRow(target.id); f.holdAck();
  assert.deepEqual(await f.command('removeFromStage', target.id), { ok: true });
  assert.equal(target.s.last('room:state')!.me.onStage, false); assert.equal(old.node.parentElement, null); bridgeLocked(old);
  assert.equal(f.heldAcks.length, 1);
  assert.equal(await f.req(target.s, { type: 'hand:raise' }), 'ok'); await f.flushStates(); await f.approveUI(target.id);
  const replacement = f.stageRow(target.id); assert.notEqual(replacement.node, old.node); bridgeLocked(replacement);
  assert.equal(f.h.node('stage-management').open, true);
  const count = f.validated.filter(bridgeIsStageRequest).length;
  old.toggle.invoke(); old.remove.invoke(); replacement.toggle.invoke(); replacement.remove.invoke(); await f.h.tick(200); await f.drain();
  assert.equal(f.validated.filter(bridgeIsStageRequest).length, count);
  f.socket.deliver(f.heldAcks[0]!); await flush(); bridgeLocked(replacement, false);
  assert.deepEqual(await f.command('forceMute', target.id), { ok: true }); bridgeLocked(replacement);
  f.socket.deliver(f.heldAcks[0]!); await flush(); bridgeLocked(replacement);
  f.socket.deliver(f.heldAcks[1]!); await flush(); bridgeLocked(replacement, false);
});

for (const kind of ['forceMute', 'forceUnmute'] as const) it(`candidate embed ${kind} is server-idempotent with snapshot held and never edits local state on ACK`, async t => {
  const f = await bridgeSetup(t), target = await f.applicant(`Idempotent ${kind}`); await f.transfer(); await f.approveUI(target.id);
  if (kind === 'forceUnmute') assert.deepEqual(await f.command('forceMute', target.id), { ok: true });
  const originalLock = bridgeTargetView(f, target.id).forceMuted, originalRow = f.stageRow(target.id), before = bridgeMediaCounts(f);
  f.holdStates(); const messagesBefore = target.s.all(kind === 'forceMute' ? 'mic:muted' : 'mic:unmuted').length;
  assert.deepEqual(await f.command(kind, target.id), { ok: true }); bridgeLocked(originalRow, false);
  assert.equal(bridgeTargetView(f, target.id).forceMuted, originalLock, 'ACK does not replace the last authoritative snapshot');
  assert.equal(target.s.last('room:state')!.me.forceMuted, !originalLock);
  assert.deepEqual(await f.command(kind, target.id), { ok: true }); bridgeLocked(originalRow, false);
  assert.equal(target.s.all(kind === 'forceMute' ? 'mic:muted' : 'mic:unmuted').length, messagesBefore + 1, 'idempotent repeat has no second effective-mute notification');
  assert.equal(bridgeTargetView(f, target.id).forceMuted, originalLock);
  assert.ok(f.heldStates.length >= 2, 'both actual Hub replies carry authoritative state before ACK');
  f.releaseStates(); await flush(); assert.equal(bridgeTargetView(f, target.id).forceMuted, !originalLock);
  assert.equal(f.stageRow(target.id).node, originalRow.node); assert.deepEqual(bridgeMediaCounts(f), before);
});

for (const code of ['conflict', 'not_found', 'forbidden'] as const) {
  for (const kind of ['forceMute', 'forceUnmute', 'removeFromStage'] as const) {
    it(`candidate embed ${kind} preserves notification-before-state and real Hub ${code} arbitration`, async t => {
      const f = await bridgeSetup(t), target = await f.applicant(`${kind} ${code}`); await f.transfer(); await f.approveUI(target.id);
      if (kind === 'forceUnmute') assert.deepEqual(await f.command('forceMute', target.id), { ok: true });
      const old = f.stageRow(target.id), before = bridgeMediaCounts(f); f.holdStates();
      if (code === 'conflict') {
        assert.equal(await f.req(target.s, { type: 'stage:leave' }), 'ok');
        assert.ok(f.incoming.some(message => message.type === 'stage:left' && message.participantId === target.id));
      } else if (code === 'not_found') {
        await f.server.hub.detach(target.s); await f.flushStates();
        const expiry = f.server.timers.find(timer => !timer.cleared && timer.ms === f.config.rooms.participantGraceMs); assert.ok(expiry);
        f.server.clock.now += f.config.rooms.participantGraceMs; expiry.cleared = true; expiry.fn(); await nextTurn(); await f.flushStates();
        assert.ok(f.incoming.some(message => message.type === 'stage:left' && message.participantId === target.id));
      } else {
        const transfer = f.client.transferControl(f.host.id); await f.h.tick(200); await f.drain(); await transfer;
        assert.ok(f.incoming.some(message => message.type === 'control:transferred' && message.fromId === f.pid));
      }
      assert.equal(f.client.me!.role, 'controller', 'notifications alone do not replace the SDK snapshot');
      assert.equal(bridgeTargetView(f, target.id).onStage, true); assert.equal(f.stageRow(target.id).node, old.node); bridgeLocked(old, false);
      assert.deepEqual(await f.command(kind, target.id), { ok: false, code }); bridgeLocked(old, false);
      const error = f.incoming.findLast(message => message.type === 'error'); assert.ok(error?.type === 'error');
      assert.equal(f.h.node('error-notice').hidden, false); assert.equal(f.h.node('last-error').textContent, `最近錯誤：${error.message}`);
      assert.deepEqual(await f.command(kind, target.id), { ok: false, code }, 'current failure permits explicit user retry');
      f.releaseStates(); await flush(); assert.equal(old.node.parentElement, null); bridgeLocked(old);
      if (code === 'forbidden') assert.equal(f.h.node('stage-management').hidden, true);
      else assert.equal(f.client.state!.speakers.some(person => person.participantId === target.id), false);
      const count = f.validated.filter(bridgeIsStageRequest).length; old.toggle.invoke(); old.remove.invoke(); await f.h.tick(200); await f.drain();
      assert.equal(f.validated.filter(bridgeIsStageRequest).length, count); assert.deepEqual(bridgeMediaCounts(f), before);
    });
  }
}

it('candidate embed onstage controller approves and runs all three generated moderation actions without extra controller media work', async t => {
  const f = await bridgeSetup(t), target = await f.applicant('Onstage host target'); await f.transfer();
  f.h.stage.click(); await f.h.tick(200); await f.drain();
  await f.h.until(() => f.client.me?.onStage === true && StagePeer.instances[0]!.transceiver.sender.track !== null, 'controller onstage');
  await f.h.tick(200); await f.drain(); await f.approveUI(target.id);
  const before = bridgeMediaCounts(f); assert.equal(before.captures, 1);
  for (const kind of ['forceMute', 'forceUnmute', 'removeFromStage'] as const) assert.deepEqual(await f.command(kind, target.id), { ok: true });
  assert.equal(f.client.me!.onStage, true); assert.deepEqual(bridgeMediaCounts(f), before);
});

it('candidate buttons preserve actual target SDK self-mute and stop its track on removal with same peer/socket and recvonly renegotiation', async t => {
  const f = await bridgeSetup(t); await f.transfer(); const target = await f.sdkApplicant('Actual SDK participant');
  const controllerPeer = StagePeer.instances[0]!; assert.equal(f.h.captures.length, 0);
  await f.approveUI(target.id);
  await f.h.until(() => target.peer.transceiver.sender.track !== null, 'target microphone attached'); await f.h.tick(200); await f.drain();
  assert.equal(f.h.captures.length, 1); assert.equal(controllerPeer.transceiver.sender.track, null);
  const track = target.peer.transceiver.sender.track!;
  const selfMute = target.client.mute(); await f.h.tick(200); await f.drain(); await selfMute;
  assert.equal(track.enabled, false); assert.equal(target.client.me!.muted, true);
  const counts = bridgeMediaCounts(f), targetPlays = target.audio.plays, controllerOffers = controllerPeer.offers.length;
  assert.deepEqual(await f.command('forceMute', target.id), { ok: true });
  assert.deepEqual(await f.command('forceUnmute', target.id), { ok: true });
  assert.equal(target.client.me!.forceMuted, false); assert.equal(target.client.me!.muted, true); assert.equal(track.enabled, false);
  assert.equal(track.stopped, false); assert.deepEqual(bridgeMediaCounts(f), counts); assert.equal(target.audio.plays, targetPlays);
  const serverRoom = f.server.transport.rooms.get(f.host.roomId)!, targetServerPeer = serverRoom.peers.get(target.id)!;
  const token = target.client.state!.resumeToken, targetOffers = target.peer.offers.length;
  assert.deepEqual(await f.command('removeFromStage', target.id), { ok: true });
  await f.h.until(() => target.peer.transceiver.sender.track === null, 'target capture detached'); await f.h.tick(200); await f.drain();
  assert.equal(target.client.me!.participantId, target.id); assert.equal(target.client.state!.resumeToken, token);
  assert.equal(target.client.me!.role, 'audience'); assert.equal(target.client.me!.onStage, false); assert.equal(target.client.status, 'live');
  assert.equal(target.socket.readyState, StageSocket.OPEN); assert.equal(f.socket.readyState, StageSocket.OPEN);
  assert.equal(target.peer.connectionState, 'connected'); assert.equal(controllerPeer.connectionState, 'connected');
  assert.equal(track.stopped, true); assert.equal(track.stops, 1);
  assert.equal(serverRoom.peers.get(target.id), targetServerPeer); assert.equal(serverRoom.subscribers.has(target.id), true);
  assert.equal(serverRoom.publishers.has(target.id), false); assert.equal(target.peer.offers.at(-1), 'recvonly');
  assert.ok(target.peer.offers.length > targetOffers, 'removal must renegotiate target media direction');
  assert.equal(StagePeer.instances.length, counts.peers); assert.equal(StagePeer.instances[0], controllerPeer);
  assert.equal(StageSocket.instances.length, counts.sockets); assert.equal(f.h.clients.length, counts.clients);
  assert.equal(controllerPeer.offers.length, controllerOffers); assert.equal(f.h.captures.length, counts.captures);
  assert.equal(f.h.audio.plays, counts.plays); assert.equal(target.audio.plays, targetPlays);
  assert.equal(f.server.hub.isJoined(target.s), true); assert.equal(target.s.all('kicked').length, 0);
});
