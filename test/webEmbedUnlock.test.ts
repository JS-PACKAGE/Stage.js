import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Deferred, embedApp, flush } from './fixtures/embedApp.ts';
import type { EmbedSdk } from './fixtures/embedApp.ts';

const interruptedMessage = 'The play() request was interrupted by a new load request.';
const blockedMessage = '瀏覽器已阻擋播放，請再試一次。';

function setup(options: Parameters<typeof embedApp>[0] = {}) {
  const h = embedApp(options), plays: Deferred[] = [], cleanupCalls: string[] = [];
  const audio = Object.assign(h.node('audio'), {
    srcObject: null as object | null,
    play(): Promise<void> { const work = new Deferred(); plays.push(work); return work.promise; },
    pause(): void { cleanupCalls.push('pause'); },
  });
  let stream: object | null = null;
  Object.defineProperty(audio, 'srcObject', {
    get: () => stream,
    set(value: object | null) {
      stream = value;
      if (value !== null) return;
      cleanupCalls.push('srcObject:null');
      // Bound the combined pause/source-detach cleanup to the native-reproduced rejection;
      // this does not model pause() alone or allow canceled playback to fulfill later.
      for (const play of plays) if (!play.settled) play.reject(interruptedMessage);
    },
  });
  const unlock = h.node('unlock');
  return {
    ...h, audio, unlock, plays, cleanupCalls,
    async join(): Promise<EmbedSdk> {
      const sdk = await h.join(), disconnect = sdk.disconnect.bind(sdk);
      audio.srcObject = {};
      Object.assign(sdk, {
        async unlockAudio(): Promise<void> {
          // Match the SDK's extra await continuation while starting play in the click stack.
          await audio.play();
        },
        disconnect(): Promise<void> {
          // Mirror destroyMedia's ordering before disconnected/closed/kicked notifications.
          audio.pause(); audio.srcObject = null; return disconnect();
        },
      });
      return sdk;
    },
    play(): Deferred {
      const count = plays.length; unlock.click();
      assert.equal(plays.length, count + 1, 'play must start synchronously in the unlock click stack');
      assert.equal(unlock.disabled, true, 'a pending unlock disables repeat activation');
      assert.equal(unlock.attributes['aria-busy'], 'true');
      return plays.at(-1)!;
    },
    async cleanup(): Promise<void> {
      for (const play of plays) if (!play.settled) play.resolve();
      await h.cleanup();
      assert.ok(plays.every(play => play.settled), 'all playback promises must settle');
    },
  };
}

for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const) {
  it(`whole embed ${terminal} preserves its notice when SDK-shaped cleanup interrupts pending playback`, async t => {
    const h = setup(); t.after(() => h.cleanup()); const sdk = await h.join();
    const play = h.play();
    if (terminal === 'leave') h.leave.click();
    else {
      await sdk.disconnect();
      if (terminal !== 'disconnected') sdk.emit(terminal, { roomId: 'same-room' });
    }
    assert.equal(play.settled, true, 'cleanup must reject the pending play immediately');
    assert.deepEqual(h.cleanupCalls, ['pause', 'srcObject:null']); assert.equal(h.audio.srcObject, null);
    await flush();
    const notice = { leave: '已離開。', disconnected: '未連線', closed: '房間已關閉。', kicked: '你已被主控移出房間。' }[terminal];
    assert.equal(h.status.textContent, notice); assert.equal(h.hand.disabled, true); assert.equal(h.leave.disabled, true);
    assert.equal(h.plays.length, 1);
  });
}

for (const connected of [false, true]) {
  it(`whole embed ${connected ? 'current-client' : 'no-client fallback'} unlock errors stay visible and allow immediate retry`, async t => {
    const h = setup(); t.after(() => h.cleanup()); if (connected) await h.join();
    const first = h.play(); first.reject(blockedMessage); await flush();
    assert.equal(h.status.textContent, blockedMessage);
    const retry = h.play(); retry.resolve(); await flush();
    assert.equal(h.status.textContent, blockedMessage, 'successful playback must retain the existing status behavior');
    assert.equal(h.plays.length, 2);
  });
}

it('whole embed suppresses concurrent unlock calls and preserves a failure after a later serial success', async t => {
  const h = setup(); t.after(() => h.cleanup()); await h.join();
  const first = h.play(); h.unlock.click(); h.unlock.invoke(); assert.equal(h.plays.length, 1);
  first.reject(blockedMessage); await flush();
  assert.equal(h.unlock.disabled, false); assert.equal(h.unlock.attributes['aria-busy'], 'false');
  const second = h.play(); second.resolve(); await flush();
  assert.equal(h.status.textContent, blockedMessage, 'serial success must not erase an earlier failure');
  assert.equal(h.plays.length, 2);
});

it('whole embed still reports a new unlock failure after the current client disconnects', async t => {
  const h = setup(); t.after(() => h.cleanup()); const sdk = await h.join();
  await sdk.disconnect(); assert.equal(h.status.textContent, '未連線');
  const play = h.play(); play.reject(blockedMessage); await flush();
  assert.equal(h.status.textContent, blockedMessage, 'disconnect retires old feedback without silencing future clicks');
});

it('whole embed state redraw does not retire a current unlock failure', async t => {
  const h = setup(); t.after(() => h.cleanup()); const sdk = await h.join();
  const play = h.play(); sdk.snapshot({ handRaised: true }); h.tick();
  play.reject(blockedMessage); await flush();
  assert.equal(h.status.textContent, blockedMessage);
});

it('whole embed join start retires no-client playback before the host library becomes available', async t => {
  const library = new Deferred(), h = setup({ libraryLoad: library.promise });
  t.after(async () => { if (!library.settled) library.resolve(); await h.cleanup(); });
  const play = h.play(); h.form.submit(); await flush();
  assert.equal(h.clients.length, 0); assert.equal(h.submit.disabled, true);
  play.reject(blockedMessage); await flush();
  assert.equal(h.status.textContent, '載入舞台元件中…', 'the pending new join must not inherit a fallback playback error');
  library.resolve(); await flush(); const sdk = h.clients[0]!; sdk.snapshot();
  assert.equal(h.submit.disabled, false); assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中');
});

it('whole embed replacement join keeps the interruption retired and ignores disconnected from the old client', async t => {
  const h = setup(); t.after(() => h.cleanup()); const old = await h.join(), retired = h.play();
  const current = await h.join();
  assert.notEqual(current, old); assert.equal(retired.settled, true);
  assert.deepEqual(h.cleanupCalls, ['pause', 'srcObject:null']);
  assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中');
  const active = h.play(); old.setStatus('disconnected'); old.emit('closed', { roomId: 'same-room' }); old.emit('kicked', { roomId: 'same-room' });
  active.reject(blockedMessage); await flush();
  assert.equal(h.status.textContent, blockedMessage, 'retired SDK events must not revoke the current playback owner');
});

it('whole embed defensively rejects an arbitrarily delayed old-client failure after replacement join', async t => {
  const h = setup(), deferred = new Deferred();
  t.after(async () => { if (!deferred.settled) deferred.resolve(); await h.cleanup(); });
  const old = await h.join();
  // A synthetic SDK promise can outlive replacement. Native pause/source detach rejects play during
  // cleanup, so this is defensive ownership coverage, not a browser rejoin-race reproduction.
  old.unlockAudio = () => deferred.promise;
  h.unlock.click(); const current = await h.join(); assert.notEqual(current, old);
  deferred.reject('retired synthetic SDK failure'); await flush();
  assert.equal(h.status.textContent, '測試舞台 · 測試聽眾 · 收聽中');
  const retry = h.play(); retry.reject(blockedMessage); await flush(); assert.equal(h.status.textContent, blockedMessage);
});
