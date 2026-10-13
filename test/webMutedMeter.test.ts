import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { flushSample, roomState, sampleApp, SamplePreview } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
function liveState(me: Partial<ParticipantView> = {}): RoomStatePayload {
  const state = roomState(me);
  // Another speaker keeps room status fixed, so mute/stage transitions require the state listener.
  state.status = 'live';
  state.speakers.push({ ...state.me, participantId: 'other-speaker', name: '另一位發言者', role: 'speaker',
    onStage: true, muted: false, forceMuted: false });
  return state;
}
const speaker = (muted = false, forceMuted = false) => liveState({ role: 'speaker', onStage: true, muted, forceMuted });
const statusEvents = (h: App) => h.sdk.events.filter(type => type === 'status').length;
async function join(h: App, state: RoomStatePayload): Promise<void> {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [name, value] of [['roomId', 'same-room'], ['code', ''], ['name', '測試聽眾']] as const) {
    const input = form.descendants().find(node => node.tagName === 'input' && node.name === name); assert.ok(input); input.value = value;
  }
  form.submit(); h.sdk.acceptJoin(state); await flushSample();
}

for (const [kind, forceMuted] of [['self-muted', false], ['force-muted', true]] as const) {
  it(`whole sample cancels and zeros the ${kind} stage meter on state alone, then resumes one interval on unmute`, async t => {
    const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
    h.sdk.micLevelValue = 0.65; h.sdk.snapshot(speaker());
    const stats = h.clock.intervals(2000), active = h.clock.intervals(50), statuses = statusEvents(h);
    assert.equal(active.length, 1); assert.equal(stats.length, 1);
    h.clock.advance(50); assert.equal(h.id('mic-level').value, 0.65); assert.equal(h.sdk.micLevelReads, 1);

    h.sdk.micLevelValue = 0; h.sdk.snapshot(speaker(true, forceMuted));
    assert.equal(statusEvents(h), statuses, 'mute must not depend on a status transition');
    assert.equal(h.id('mic-level').value, 0, 'zero immediately, before advancing the clock');
    assert.equal(h.clock.intervals(50).length, 0);
    assert.equal(h.clock.jobs.has(active[0]!), false, 'the old interval must be canceled');
    assert.equal(h.id('mic-test').disabled, true, 'a muted stage participant still cannot start a preview');
    for (let i = 0; i < 3; i++) h.sdk.snapshot(speaker(true, forceMuted));
    h.clock.advance(250); assert.equal(h.sdk.micLevelReads, 1); assert.equal(h.id('mic-level').value, 0);
    assert.deepEqual(h.clock.intervals(2000), stats);

    h.sdk.micLevelValue = 0.4; h.sdk.snapshot(speaker());
    const resumed = h.clock.intervals(50); assert.equal(resumed.length, 1); assert.notDeepEqual(resumed, active);
    for (let i = 0; i < 3; i++) h.sdk.snapshot(speaker());
    assert.equal(statusEvents(h), statuses); assert.deepEqual(h.clock.intervals(50), resumed);
    assert.deepEqual(h.clock.intervals(2000), stats);
    h.clock.advance(49); assert.equal(h.sdk.micLevelReads, 1); assert.equal(h.id('mic-level').value, 0);
    h.clock.advance(1); assert.equal(h.sdk.micLevelReads, 2); assert.equal(h.id('mic-level').value, 0.4);
  });

  it(`whole sample performs zero ${kind} stage mic reads over 10 seconds while preserving five stats polls`, async t => {
    const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
    // Match the real SDK's known zero result for a disabled microphone track.
    h.sdk.micLevelValue = 0; h.sdk.snapshot(speaker(true, forceMuted));
    const stats = h.clock.intervals(2000); assert.equal(stats.length, 1);
    assert.equal(h.clock.intervals(50).length, 0); assert.equal(h.id('mic-level').value, 0);
    h.clock.advance(10_000);
    assert.equal(h.sdk.micLevelReads, 0); assert.equal(h.sdk.polls.length, 5);
    assert.deepEqual(h.clock.fired, Array<number>(5).fill(stats[0]!));
    assert.deepEqual(h.clock.intervals(2000), stats); assert.equal(h.clock.intervals(50).length, 0);
  });
}

it('whole sample keeps preview polling independent of local listening mute, then tears it down on forced-muted stage entry', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
  h.sdk.snapshot(liveState());
  const stats = h.clock.intervals(2000), statuses = statusEvents(h);
  h.id('mic-test').click(); assert.equal(h.clock.intervals(50).length, 0, 'pending capture is not an active preview');
  const preview = new SamplePreview(0.3); h.sdk.grantPreview(h.sdk.previews[0]!, preview); await flushSample();
  const active = h.clock.intervals(50); assert.equal(active.length, 1);
  h.clock.advance(50); assert.equal(preview.reads, 1); assert.equal(h.id('mic-level').value, 0.3);
  h.id('playback-mute').click(); await flushSample(); assert.equal(h.sdk.playbackMuted, true);
  h.sdk.snapshot(liveState());
  assert.deepEqual(h.clock.intervals(50), active); assert.equal(preview.stops, 0);
  h.clock.advance(50); assert.equal(preview.reads, 2); assert.equal(h.id('mic-level').value, 0.3);
  assert.equal(h.sdk.micLevelReads, 0, 'the preview must use its own level source');

  h.sdk.snapshot(speaker(true, true));
  assert.equal(statusEvents(h), statuses); assert.equal(preview.stops, 1);
  assert.equal(h.id('mic-test').disabled, true); assert.equal(h.id('mic-test').textContent, '測試麥克風');
  assert.equal(h.id('mic-test').attributes['aria-pressed'], 'false');
  assert.equal(h.id('mic-level').value, 0); assert.equal(h.clock.intervals(50).length, 0);
  assert.deepEqual(h.clock.intervals(2000), stats);
  h.clock.advance(100); assert.equal(preview.reads, 2); assert.equal(h.sdk.micLevelReads, 0);

  h.sdk.micLevelValue = 0.55; h.sdk.snapshot(speaker());
  const stage = h.clock.intervals(50); assert.equal(stage.length, 1); assert.equal(h.sdk.playbackMuted, true);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 1); assert.equal(h.id('mic-level').value, 0.55);
  h.id('playback-mute').click(); await flushSample(); assert.equal(h.sdk.playbackMuted, false);
  assert.deepEqual(h.clock.intervals(50), stage);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 2); assert.equal(h.id('mic-level').value, 0.55);
});

it('whole sample retains one unmuted meter and no muted meter across reconnect statuses without restarting stats', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
  h.sdk.snapshot(speaker(true));
  const stats = h.clock.intervals(2000), retainedMuted = h.sdk.state;
  h.sdk.setStatus('reconnecting'); h.sdk.setStatus('reconnecting');
  assert.equal(h.sdk.state, retainedMuted); assert.equal(h.clock.intervals(50).length, 0);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 0); assert.equal(h.id('mic-level').value, 0);
  h.sdk.setStatus('live'); assert.equal(h.clock.intervals(50).length, 0);

  h.sdk.micLevelValue = 0.2; h.sdk.snapshot(speaker());
  const active = h.clock.intervals(50), retainedUnmuted = h.sdk.state; assert.equal(active.length, 1);
  h.sdk.setStatus('reconnecting'); h.sdk.setStatus('reconnecting');
  assert.equal(h.sdk.state, retainedUnmuted); assert.deepEqual(h.clock.intervals(50), active);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 1); assert.equal(h.id('mic-level').value, 0.2);
  h.sdk.setStatus('live'); h.sdk.snapshot(speaker());
  assert.deepEqual(h.clock.intervals(50), active); assert.deepEqual(h.clock.intervals(2000), stats);
  h.sdk.micLevelValue = 0; h.sdk.snapshot(speaker(true, true)); h.sdk.setStatus('reconnecting');
  assert.equal(h.clock.intervals(50).length, 0); assert.equal(h.id('mic-level').value, 0);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 1); assert.deepEqual(h.clock.intervals(2000), stats);
});

it('whole sample removes meter work on leaving and restarts only once after same-identity muted rejoin and unmute', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample(); await join(h, speaker());
  h.sdk.micLevelValue = 0.8; h.clock.advance(50);
  const oldMeter = h.clock.intervals(50), oldStats = h.clock.intervals(2000);
  assert.equal(h.id('mic-level').value, 0.8); assert.equal(h.sdk.micLevelReads, 1);
  h.button('離開房間').click(); await flushSample();
  assert.equal(h.sdk.state, null); assert.equal(h.clock.jobs.size, 0); assert.equal(h.id('mic-level').value, 0);
  h.clock.advance(100); assert.equal(h.sdk.micLevelReads, 1);

  h.sdk.micLevelValue = 0; await join(h, speaker(true));
  const stats = h.clock.intervals(2000); assert.equal(stats.length, 1); assert.notDeepEqual(stats, oldStats);
  assert.equal(h.clock.intervals(50).length, 0); assert.equal(h.id('mic-test').disabled, true);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 1);
  h.sdk.micLevelValue = 0.45; h.sdk.snapshot(speaker());
  const active = h.clock.intervals(50); assert.equal(active.length, 1); assert.notDeepEqual(active, oldMeter);
  h.sdk.snapshot(speaker()); h.sdk.setStatus('reconnecting'); h.sdk.setStatus('live');
  assert.deepEqual(h.clock.intervals(50), active); assert.deepEqual(h.clock.intervals(2000), stats);
  h.clock.advance(50); assert.equal(h.sdk.micLevelReads, 2); assert.equal(h.id('mic-level').value, 0.45);

  const statuses = statusEvents(h); h.sdk.snapshot(liveState());
  assert.equal(statusEvents(h), statuses); assert.equal(h.clock.intervals(50).length, 0);
  assert.equal(h.id('mic-level').value, 0); assert.equal(h.id('mic-test').disabled, false);
  h.sdk.snapshot(speaker()); assert.equal(h.clock.intervals(50).length, 1);
  await h.sdk.terminal('kicked'); await flushSample();
  assert.equal(h.clock.jobs.size, 0); assert.equal(h.id('mic-level').value, 0);
  const callbacks = h.clock.fired.length; h.clock.advance(2000);
  assert.equal(h.clock.fired.length, callbacks); assert.equal(h.sdk.micLevelReads, 2); assert.equal(h.sdk.polls.length, 0);
});
