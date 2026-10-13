import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

const blockedNotice = '自動播放遭阻擋。點擊啟用音訊';
const interruptedMessage = 'The play() request was interrupted by a call to pause().';

function setup() {
  const h = sampleApp(), plays: Deferred<void>[] = [];
  const disconnect = h.sdk.disconnect.bind(h.sdk);
  Object.assign(h.sdk, {
    async unlockAudio(): Promise<void> {
      const play = new Deferred<void>(); plays.push(play);
      // Match the SDK's await around audio.play(), including its separate continuation.
      await play.promise;
    },
    disconnect(): Promise<void> {
      // Model pause interrupting pending play; an interrupted request cannot later fulfill.
      for (const play of plays) if (play.status === 'pending') play.reject(new Error(interruptedMessage));
      return disconnect();
    },
  });
  return {
    ...h, plays,
    async cleanup(): Promise<void> {
      await h.cleanup();
      assert.ok(plays.every(play => play.status !== 'pending'));
    },
  };
}
type App = ReturnType<typeof setup>;
const errorBox = (h: App) => h.find(node => node.attributes.role === 'alert');
const notices = (h: App) => h.find(node => node.classList.contains('notices'));

function acceptJoin(h: App): void {
  const state = roomState();
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [name, value] of Object.entries({ roomId: state.roomId, code: '', name: state.me.name })) {
    const input = form.descendants().find(node => node.tagName === 'input' && node.name === name);
    assert.ok(input); input.value = value;
  }
  form.submit(); h.sdk.acceptJoin(state);
  assert.equal(form.isConnected, false);
}
async function join(h: App): Promise<void> { acceptJoin(h); await flushSample(); }
function block(h: App): void {
  h.sdk.emit('audioblocked', { message: '瀏覽器已阻擋自動播放，請點擊啟用音訊。' });
  assert.equal(notices(h).textContent, blockedNotice);
}
function unlock(h: App): { button: SampleNode; play: Deferred<void> } {
  const button = h.button('點擊啟用音訊'), before = h.plays.length;
  button.click();
  assert.equal(h.plays.length, before + 1, 'invoke playback synchronously from the click handler');
  assert.equal(button.disabled, true);
  button.click(); assert.equal(h.plays.length, before + 1, 'the pending rendered button cannot be clicked twice');
  return { button, play: h.plays.at(-1)! };
}
function assertLanding(h: App): void {
  assert.equal(h.sdk.state, null); assert.equal(h.sdk.status, 'disconnected');
  assert.equal(h.app.descendants().filter(node => node.tagName === 'form').length, 2);
  assert.equal(h.clock.jobs.size, 0);
}

it('whole sample Leave suppresses the retired unlock rejection caused by pausing pending playback', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h); block(h);
  const pending = unlock(h);
  h.button('離開房間').click();
  assert.equal(pending.play.status, 'rejected'); assertLanding(h);
  await flushSample();
  assertLanding(h); assert.equal(notices(h).textContent, '');
  assert.equal(errorBox(h).hidden, true, 'the canceled room must not report its play interruption on landing');
  assert.equal(pending.button.isConnected, false);
  assert.equal(pending.button.disabled, true, 'finally must not mutate the detached unlock button');
});

for (const terminal of ['shutdown', 'kicked'] as const) {
  it(`whole sample preserves the ${terminal} notice when terminal cleanup cancels pending playback`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h); block(h);
    const pending = unlock(h);
    await h.sdk.terminal(terminal === 'shutdown' ? 'closed' : 'kicked', terminal === 'shutdown' ? 'shutdown' : undefined);
    await flushSample();
    assert.equal(pending.play.status, 'rejected'); assertLanding(h);
    assert.match(notices(h).textContent, terminal === 'shutdown' ? /伺服器維護或重新啟動/ : /你已被主控移出房間/);
    assert.doesNotMatch(notices(h).textContent, /自動播放遭阻擋/);
    assert.equal(errorBox(h).hidden, true);
    assert.equal(pending.button.isConnected, false); assert.equal(pending.button.disabled, true);
  });
}

for (const outcome of ['rejected-on-pause', 'already-fulfilled'] as const) {
  it(`whole sample queued ${outcome} unlock continuation cannot own a same-identity rejoin notice`, async t => {
    const h = setup(); t.after(() => h.cleanup()); await join(h); block(h);
    const retired = unlock(h);
    // This intentionally bounds UI ownership with synchronous fixture lifecycle events. It is
    // not a real-browser/network rejoin timing claim, nor fulfillment after pause cancellation.
    if (outcome === 'already-fulfilled') retired.play.resolve(undefined);
    const leaving = h.sdk.disconnect();
    assert.equal(retired.play.status, outcome === 'already-fulfilled' ? 'fulfilled' : 'rejected');
    acceptJoin(h); block(h);
    const currentButton = h.button('點擊啟用音訊');
    await leaving; await flushSample();
    assert.equal(h.sdk.state?.roomId, 'same-room');
    assert.equal(notices(h).textContent, blockedNotice, 'a retired success cannot clear the replacement notice');
    assert.equal(errorBox(h).hidden, true, 'a retired failure cannot report into the replacement room');
    assert.equal(currentButton.isConnected, true); assert.equal(currentButton.disabled, false);
    assert.equal(retired.button.isConnected, false); assert.equal(retired.button.disabled, true);
    const current = unlock(h); current.play.resolve(undefined); await flushSample();
    assert.equal(notices(h).textContent, ''); assert.equal(errorBox(h).hidden, true);
  });
}

it('whole sample current unlock failures remain visible and retry succeeds after a harmless room redraw', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h); block(h);
  const first = unlock(h);
  h.sdk.snapshot(roomState());
  assert.equal(first.button.isConnected, false);
  first.play.reject(new Error('仍無法播放，請再試一次。')); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '仍無法播放，請再試一次。');
  assert.equal(notices(h).textContent, blockedNotice); assert.equal(first.button.disabled, true);
  assert.equal(h.button('點擊啟用音訊').disabled, false);
  const retry = unlock(h);
  assert.equal(errorBox(h).hidden, true);
  h.sdk.snapshot(roomState());
  retry.play.resolve(undefined); await flushSample();
  assert.equal(notices(h).textContent, ''); assert.equal(errorBox(h).hidden, true);
  assert.equal(retry.button.isConnected, false); assert.equal(retry.button.disabled, true);
  assert.equal(h.plays.length, 2);
});

it('whole sample keeps unscoped global playback-button errors visible across room cleanup', async t => {
  const h = setup(); t.after(() => h.cleanup()); await join(h);
  Object.assign(h.sdk, { setPlaybackMuted() { throw new Error('收聽設定失敗。'); } });
  const mute = h.id('playback-mute'); mute.click();
  await h.sdk.disconnect(); await flushSample();
  assertLanding(h); assert.equal(mute.isConnected, true); assert.equal(mute.disabled, false);
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '收聽設定失敗。');
  assert.equal(h.plays.length, 0);
});
