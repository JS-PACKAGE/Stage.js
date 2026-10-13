import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StageClient } from '../src/index.ts';
import type { RoomStatePayload } from '../../../shared/protocol.ts';

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
class Audio {
  autoplay = false;
  hidden = false;
  isConnected = false;
  volume = 1;
  muted = false;
  srcObject: unknown = null;
  readonly plays: ReturnType<typeof deferred>[] = [];
  play() { const attempt = deferred(); this.plays.push(attempt); return attempt.promise; }
  pause() {}
  remove() { this.isConnected = false; }
}
class Peer {
  static instances: Peer[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = null;
  closed = false;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  readonly transceiver = { direction: 'recvonly', sender: { track: null, async replaceTrack() {} } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  close() { this.closed = true; }
}
function state(id: string): RoomStatePayload {
  return { roomId: 'room', name: 'room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
    me: { participantId: id, name: id, role: 'audience', onStage: false,
      handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}
const blockedMessage = { message: '瀏覽器已阻擋自動播放，請點擊啟用音訊。' };

for (const custom of [false, true]) {
  describe(`autoplay ownership with ${custom ? 'custom' : 'owned'} audio`, () => {
    let originals: Map<string, PropertyDescriptor | undefined>;
    let client: StageClient;
    let audio: Audio;
    let blocked: unknown[];
    beforeEach(() => {
      originals = new Map(['window', 'document', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
      audio = new Audio(); blocked = []; Peer.instances = [];
      Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        createElement(tag: string) { assert.equal(tag, 'audio'); assert.equal(custom, false); return audio; },
        body: { append(element: Audio) { element.isConnected = true; } },
      } });
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
      client = new StageClient({ url: 'ws://localhost/ws', ...(custom ? { audioElement: audio as unknown as HTMLAudioElement } : {}) });
      client['negotiate'] = () => {};
      client.on('audioblocked', event => blocked.push(event.detail));
    });
    afterEach(async () => {
      await client.disconnect();
      for (const attempt of audio.plays) attempt.resolve();
      await settle();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    });
    async function receive(id: string) {
      await client['receive']({ type: 'room:state', ...state(id) });
      await client['mediaTask'];
      const peer = Peer.instances.at(-1)!;
      assert.ok(peer.ontrack);
      return peer;
    }
    function track(peer: Peer, id: string) {
      const stream = { id } as MediaStream;
      peer.ontrack!({ streams: [stream] });
      return stream;
    }

    it('reports a current peer autoplay denial exactly once', async () => {
      const peer = await receive('current');
      const stream = track(peer, 'current-stream');
      assert.equal(audio.srcObject, stream);
      assert.equal(audio.plays.length, 1);
      audio.plays[0]!.reject(new DOMException('denied', 'NotAllowedError'));
      await settle();
      assert.deepEqual(blocked, [blockedMessage]);
    });

    it('ignores an autoplay rejection after disconnect', async () => {
      const peer = await receive('old');
      track(peer, 'old-stream');
      await client.disconnect();
      assert.equal(peer.closed, true);
      assert.equal(audio.srcObject, null);
      audio.plays[0]!.reject(new DOMException('interrupted', 'AbortError'));
      await settle();
      assert.deepEqual(blocked, []);
    });

    it('ignores an old rejection after the replacement peer plays successfully', async () => {
      const old = await receive('old');
      track(old, 'old-stream');
      const current = await receive('current');
      assert.notEqual(current, old);
      assert.equal(old.closed, true);
      const stream = track(current, 'current-stream');
      assert.equal(audio.plays.length, 2);
      audio.plays[1]!.resolve();
      await settle();
      audio.plays[0]!.reject(new DOMException('interrupted', 'AbortError'));
      await settle();
      assert.deepEqual(blocked, []);
      assert.equal(audio.srcObject, stream);
    });

    it('ignores retired track callbacks after disconnect and peer replacement', async () => {
      const old = await receive('old');
      const retired = old.ontrack!;
      await client.disconnect();
      retired({ streams: [{ id: 'retired-stream' } as MediaStream] });
      assert.equal(audio.srcObject, null);
      assert.equal(audio.plays.length, 0);
      const current = await receive('current');
      const stream = track(current, 'current-stream');
      audio.plays[0]!.resolve();
      await settle();
      retired({ streams: [{ id: 'retired-stream' } as MediaStream] });
      assert.equal(audio.srcObject, stream);
      assert.equal(audio.plays.length, 1);
      assert.deepEqual(blocked, []);
    });

    for (const succeeds of [true, false]) {
      it(`preserves public unlockAudio ${succeeds ? 'fulfillment' : 'rejection'} without duplicate blocked events`, async () => {
        track(await receive('current'), 'current-stream');
        audio.plays[0]!.reject(new DOMException('denied', 'NotAllowedError'));
        await settle();
        assert.deepEqual(blocked, [blockedMessage]);
        const unlock = client.unlockAudio();
        assert.equal(audio.plays.length, 2);
        if (succeeds) {
          audio.plays[1]!.resolve();
          assert.equal(await unlock, undefined);
        } else {
          const error = new DOMException('still denied', 'NotAllowedError');
          const rejected = assert.rejects(unlock, value => value === error);
          audio.plays[1]!.reject(error);
          await rejected;
        }
        await settle();
        assert.deepEqual(blocked, [blockedMessage]);
      });
    }
  });
}
