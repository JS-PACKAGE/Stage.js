import assert from 'node:assert/strict';
import { it } from 'node:test';
import { flushSample, roomState, sampleApp, SamplePreview } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
function submitJoin(h: App): { form: SampleNode; submit: SampleNode } {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [name, value] of [['roomId', ' same-room '], ['code', ''], ['name', ' 測試聽眾 ']]) {
    const input = form.descendants().find(node => node.tagName === 'input' && node.name === name); assert.ok(input); input.value = value!;
  }
  const submit = form.descendants().find(node => node.tagName === 'button' && node.type === 'submit'); assert.ok(submit);
  form.submit(); assert.equal(submit.disabled, true);
  assert.deepEqual({ ...h.sdk.joins.at(-1)!.options }, { roomId: 'same-room', code: undefined, name: '測試聽眾' });
  return { form, submit };
}
async function join(h: App): Promise<void> {
  const previous = submitJoin(h); h.sdk.acceptJoin(roomState()); await flushSample();
  assert.equal(previous.form.isConnected, false); assert.equal(previous.submit.isConnected, false);
  assert.equal(previous.submit.disabled, true, 'a finished handler must not mutate its detached submit button');
}
const errorBox = (h: App) => h.find(node => node.attributes.role === 'alert');
const notices = (h: App) => h.find(node => node.classList.contains('notices'));
const hand = (h: App) => h.find(node => node.dataset.roomAction === 'hand');
const connection = (h: App) => h.find(node => node.classList.contains('connection'));

it('whole sample joins through its form, isolates preview generations across same-identity rejoin, and keeps the post-disconnect shutdown notice', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
  assert.equal(h.app.descendants().filter(node => node.tagName === 'form' && !node.classList.contains('chat-form')).length, 2);
  assert.equal(h.id('microphone-device').children.length, 2);
  assert.equal(h.id('playback-volume').value, '100');
  assert.equal(h.clock.jobs.size, 0);
  await join(h);

  h.id('mic-test').click(); const canceled = h.sdk.previews[0]!;
  assert.equal(h.id('microphone-device').disabled, true);
  const leaving = h.sdk.disconnect();
  assert.equal(canceled.status, 'rejected', 'the SDK cancels pending capture on disconnect');
  assert.equal(h.app.descendants().filter(node => node.tagName === 'form' && !node.classList.contains('chat-form')).length, 2);
  submitJoin(h); h.sdk.acceptJoin(roomState()); h.id('mic-test').click();
  const replacement = h.sdk.previews[1]!;
  await leaving; await flushSample();
  assert.equal(errorBox(h).hidden, true, 'old cancellation must not surface in the replacement session');
  assert.equal(h.id('mic-test').disabled, true); assert.equal(h.id('microphone-device').disabled, true);
  const first = new SamplePreview(0.2); h.sdk.grantPreview(replacement, first); await flushSample();
  assert.equal(h.id('mic-test').textContent, '停止測試');
  h.id('mic-test').click(); await flushSample(); assert.equal(first.stops, 1);

  h.id('mic-test').click(); const queued = h.sdk.previews[2]!, old = new SamplePreview(0.9);
  // Fulfill before cleanup, without a microtask drain: the promise is already fulfilled but the
  // sample's await continuation is queued. A genuinely canceled SDK request cannot later fulfill.
  h.sdk.grantPreview(queued, old); assert.equal(queued.status, 'fulfilled');
  const disconnecting = h.sdk.disconnect(); assert.equal(old.stopCalls, 1);
  submitJoin(h); h.sdk.acceptJoin(roomState()); h.id('mic-test').click();
  const currentWork = h.sdk.previews[3]!;
  await disconnecting; await flushSample();
  assert.equal(old.stopCalls, 2, 'the stale UI continuation also disposes its own already-stopped preview');
  assert.equal(old.stops, 1); assert.equal(currentWork.status, 'pending');
  assert.equal(h.id('mic-test').disabled, true); assert.equal(h.id('microphone-device').disabled, true);
  assert.equal(h.clock.intervals(50).length, 0); assert.equal(errorBox(h).hidden, true);
  const current = new SamplePreview(0.35); h.sdk.grantPreview(currentWork, current); await flushSample();
  h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.35);
  assert.equal(h.id('mic-test').attributes['aria-pressed'], 'true'); assert.equal(current.stops, 0);

  const closing = h.sdk.terminal('closed', 'shutdown');
  assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected');
  assert.equal(notices(h).textContent, '', 'disconnect renders landing before the closed notification');
  await closing; await flushSample();
  assert.match(notices(h).textContent, /伺服器維護或重新啟動/);
  assert.equal(h.app.descendants().filter(node => node.tagName === 'form' && !node.classList.contains('chat-form')).length, 2);
  assert.equal(h.clock.jobs.size, 0); assert.equal(current.stops, 1); assert.equal(h.id('mic-level').value, 0);
  assert.deepEqual(h.sdk.events.slice(-2), ['status', 'closed']); h.sdk.assertSettled();
});

it('whole sample state/status subscriptions own one stats interval and preserve pending controls through cooldown, reconnect, terminal cleanup, and stale rejoin stats', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  assert.deepEqual(h.sdk.events, ['status', 'state']);
  const interval = h.clock.intervals(2000); assert.equal(interval.length, 1);
  const oldConnection = connection(h);
  for (let i = 0; i < 3; i++) h.sdk.snapshot(roomState());
  h.sdk.setStatus('reconnecting'); h.sdk.setStatus('reconnecting');
  assert.equal(hand(h).disabled, true); h.sdk.snapshot(roomState());
  assert.deepEqual(h.clock.intervals(2000), interval);
  assert.equal(connection(h), oldConnection, 'the persistent stats node is reparented, not duplicated');
  assert.equal(oldConnection.isConnected, true);

  const oldButton = hand(h); oldButton.click(); assert.equal(h.sdk.raises.length, 1);
  h.sdk.snapshot(roomState()); assert.equal(oldButton.isConnected, true);
  assert.equal(hand(h), oldButton, 'an unchanged snapshot retains the pending hand control');
  assert.equal(hand(h).disabled, true); assert.equal(hand(h).attributes['aria-busy'], 'true');
  h.clock.advance(500); assert.match(hand(h).textContent, /1 秒/); assert.equal(hand(h).disabled, true);
  h.clock.advance(1000); assert.equal(hand(h).textContent, '舉手發言');
  assert.equal(h.clock.timeouts().length, 0); assert.equal(hand(h).disabled, true);
  hand(h).click(); assert.equal(h.sdk.raises.length, 1, 'the expired cooldown cannot bypass a pending ACK');
  h.sdk.raises[0]!.resolve(undefined); await flushSample(); assert.equal(hand(h).disabled, false);
  h.clock.advance(500); assert.equal(h.sdk.polls.length, 1);
  h.sdk.snapshot(roomState()); h.sdk.setStatus('reconnecting'); h.sdk.snapshot(roomState());
  h.clock.advance(2000); assert.equal(h.sdk.polls.length, 2, 'an unresolved poll must not suppress the next scheduled poll');
  assert.deepEqual(h.clock.intervals(2000), interval);
  h.sdk.polls[1]!.resolve({ inbound: { rtt: 0.04, lossPercent: 8 }, outbound: null }); await flushSample();
  assert.match(connection(h).textContent, /40 ms/); assert.equal(connection(h).classList.contains('error'), true);

  hand(h).click(); assert.equal(h.clock.timeouts().length, 1);
  await h.sdk.terminal('kicked'); await flushSample();
  assert.equal(h.sdk.raises[1]!.status, 'rejected'); assert.equal(errorBox(h).hidden, true);
  assert.equal(h.clock.jobs.size, 0); assert.equal(oldConnection.isConnected, false); assert.equal(oldConnection.textContent, '');
  assert.match(notices(h).textContent, /你已被主控移出房間/);
  const callbacks = h.clock.fired.length; h.clock.advance(5000);
  assert.equal(h.clock.fired.length, callbacks); assert.equal(h.sdk.polls.length, 2);

  await join(h); assert.equal(h.clock.intervals(2000).length, 1);
  h.clock.advance(2000); assert.equal(h.sdk.polls.length, 3);
  h.sdk.polls[2]!.resolve({ inbound: { rtt: 0.02, lossPercent: 0 }, outbound: null }); await flushSample();
  assert.match(connection(h).textContent, /20 ms/); assert.equal(connection(h).classList.contains('error'), false);
  h.sdk.polls[0]!.resolve({ inbound: null, outbound: null }); await flushSample();
  assert.match(connection(h).textContent, /20 ms/, 'a retired SDK poll returning empty must not erase the same-identity rejoin display');
  await h.sdk.disconnect(); await flushSample(); assert.equal(h.clock.jobs.size, 0); h.sdk.assertSettled();
});

it('whole sample switches its 50 ms preview meter to the stage mic and cleans it on offstage and terminal events', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await join(h);
  // Another publisher keeps the room live while our participant changes stage membership.
  // These transitions must exercise the state subscription independently of status callbacks.
  const liveState = (onStage = false) => {
    const state = roomState({ onStage, role: onStage ? 'speaker' : 'audience' });
    state.status = 'live';
    state.speakers.push({ ...state.me, participantId: 'other-speaker', name: '另一位發言者', role: 'speaker', onStage: true });
    return state;
  };
  h.sdk.snapshot(liveState());
  const statusEvents = h.sdk.events.filter(type => type === 'status').length;
  const meter = h.id('mic-level'); assert.equal(h.clock.intervals(50).length, 0);
  h.id('mic-test').click(); const preview = new SamplePreview(0.25);
  h.sdk.grantPreview(h.sdk.previews[0]!, preview); await flushSample();
  const interval = h.clock.intervals(50); assert.equal(interval.length, 1);
  h.clock.advance(49); assert.equal(meter.value, 0); assert.equal(preview.reads, 0);
  h.clock.advance(1); assert.equal(meter.value, 0.25); assert.equal(preview.reads, 1);

  h.sdk.micLevelValue = 0.7; h.sdk.snapshot(liveState(true));
  assert.equal(h.sdk.events.filter(type => type === 'status').length, statusEvents);
  assert.equal(preview.stops, 1); assert.equal(h.id('mic-test').disabled, true);
  assert.equal(h.id('mic-test').textContent, '測試麥克風'); assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
  h.sdk.snapshot(liveState(true));
  assert.deepEqual(h.clock.intervals(50), interval); assert.equal(h.clock.intervals(2000).length, 1);
  h.clock.advance(50); assert.equal(meter.value, 0.7); assert.equal(h.sdk.micLevelReads, 1); assert.equal(preview.reads, 1);
  const row = h.find(node => node.dataset.participantId === 'same-person');
  h.sdk.speaking = new Set(['same-person']); h.sdk.emit('speaking', { participantIds: ['same-person'] });
  assert.equal(row.classList.contains('speaking'), true);
  h.sdk.emit('quality', { participants: [{ participantId: 'same-person', uplinkLossPercent: 8 }] });
  const badge = row.querySelector('.badge.quality'); assert.ok(badge); assert.equal(badge.isConnected, true);
  h.sdk.emit('quality', { participants: [] }); assert.equal(badge.isConnected, false); assert.equal(row.querySelector('.badge.quality'), null);

  h.sdk.snapshot(liveState()); assert.equal(row.isConnected, false);
  assert.equal(h.sdk.events.filter(type => type === 'status').length, statusEvents);
  assert.equal(h.clock.intervals(50).length, 0); assert.equal(meter.value, 0); assert.equal(h.id('mic-test').disabled, false);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 1); assert.equal(preview.reads, 1);
  h.id('mic-test').click(); const last = new SamplePreview(0.4);
  h.sdk.grantPreview(h.sdk.previews[1]!, last); await flushSample(); h.clock.advance(50);
  assert.equal(meter.value, 0.4); assert.equal(h.clock.intervals(50).length, 1);
  await h.sdk.terminal('kicked'); await flushSample();
  assert.equal(last.stops, 1); assert.equal(meter.value, 0); assert.equal(h.clock.jobs.size, 0);
  assert.equal(h.id('mic-test').disabled, false); assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
  const reads = last.reads; h.clock.advance(2000);
  assert.equal(last.reads, reads); assert.equal(h.sdk.micLevelReads, 1); assert.equal(h.sdk.polls.length, 0); h.sdk.assertSettled();
});
