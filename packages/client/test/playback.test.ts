import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StageClient } from '../src/index.ts';

class FakeAudio {
  volume = 1;
  muted = false;
  autoplay = false;
  hidden = false;
  isConnected = false;
  srcObject: unknown = null;
  playCalls = 0;
  pause() {}
  async play() { this.playCalls++; }
  remove() { this.isConnected = false; }
}
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } }) }));
  }
  send(data: string) {
    this.sent.push(data);
    const message = JSON.parse(data);
    if (message.type === 'join') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'ok', requestId: message.requestId }) }));
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

describe('local playback controls', () => {
  const clients: StageClient[] = [];
  let owned: FakeAudio[];
  let originals: Map<string, PropertyDescriptor | undefined>;
  beforeEach(() => {
    owned = [];
    FakeSocket.instances = [];
    originals = new Map(['document', 'window', 'WebSocket'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      createElement(tag: string) { assert.equal(tag, 'audio'); const audio = new FakeAudio(); owned.push(audio); return audio; },
      body: { append(audio: FakeAudio) { audio.isConnected = true; } },
    } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.disconnect();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  function make(audio?: FakeAudio): StageClient {
    const client = new StageClient({ url: 'ws://localhost/ws', reconnect: { initialDelayMs: 1, maxDelayMs: 1 }, ...(audio ? { audioElement: audio as unknown as HTMLAudioElement } : {}) });
    clients.push(client);
    return client;
  }
  it('controls owned audio without requesting media, connecting or playing', () => {
    const client = make();
    assert.equal(client.playbackVolume, 1);
    assert.equal(client.playbackMuted, false);
    client.setPlaybackVolume(0.35);
    client.setPlaybackMuted(true);
    assert.equal(owned[0]!.volume, 0.35);
    assert.equal(owned[0]!.muted, true);
    assert.equal(owned[0]!.playCalls, 0);
    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(client.me, null);
    assert.equal(client.micLevel, 0);
  });
  it('preserves custom audio settings and reads external updates live', () => {
    const audio = new FakeAudio();
    audio.volume = 0.2; audio.muted = true;
    const client = make(audio);
    assert.equal(client.playbackVolume, 0.2);
    assert.equal(client.playbackMuted, true);
    assert.equal(owned.length, 0);
    audio.volume = 0.6; audio.muted = false;
    assert.equal(client.playbackVolume, 0.6);
    assert.equal(client.playbackMuted, false);
  });
  it('rejects non-finite/out-of-range volume without changing the previous value', () => {
    const client = make();
    client.setPlaybackVolume(0.4);
    for (const value of [-1, 1.01, NaN, Infinity, -Infinity, '0.5' as unknown as number]) {
      assert.throws(() => client.setPlaybackVolume(value), RangeError);
      assert.equal(client.playbackVolume, 0.4);
    }
    client.setPlaybackVolume(0); assert.equal(client.playbackVolume, 0);
    client.setPlaybackVolume(1); assert.equal(client.playbackVolume, 1);
  });
  it('keeps volume and mute independent without issuing control messages', async () => {
    const client = make();
    await client.connect();
    client.setPlaybackVolume(0.3);
    client.setPlaybackMuted(true);
    client.setPlaybackVolume(0.8);
    assert.equal(client.playbackMuted, true);
    client.setPlaybackMuted(false);
    assert.equal(client.playbackVolume, 0.8);
    assert.deepEqual(FakeSocket.instances[0]!.sent, []);
  });
  it('preserves listening settings during automatic session reconnection', async () => {
    const client = make();
    await client.join({ roomId: 'room', name: 'Listener' });
    client.setPlaybackVolume(0.45); client.setPlaybackMuted(true);
    FakeSocket.instances[0]!.close();
    assert.equal(client.status, 'reconnecting');
    const deadline = Date.now() + 1000;
    while (FakeSocket.instances.length < 2 || !FakeSocket.instances[1]!.sent.some((data) => JSON.parse(data).type === 'join')) {
      assert.ok(Date.now() < deadline, 'session should rejoin without an explicit connect()');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(client.playbackVolume, 0.45);
    assert.equal(client.playbackMuted, true);
    assert.equal(owned.length, 1);
    assert.deepEqual(FakeSocket.instances.flatMap((ws) => ws.sent.map((data) => JSON.parse(data).type)), ['join', 'join']);
  });
  for (const custom of [false, true]) {
    it(`retains ${custom ? 'custom' : 'owned'} audio settings across dropped connections and disconnect/reuse`, async () => {
      const audio = custom ? new FakeAudio() : undefined;
      const client = make(audio);
      client.setPlaybackVolume(0.25); client.setPlaybackMuted(true);
      await client.connect();
      FakeSocket.instances[0]!.close();
      await client.connect();
      assert.equal(client.playbackVolume, 0.25); assert.equal(client.playbackMuted, true);
      await client.disconnect();
      await client.connect();
      assert.equal(client.playbackVolume, 0.25); assert.equal(client.playbackMuted, true);
      if (!custom) assert.equal(owned.length, 1, 'same audio is reattached');
      assert.ok(FakeSocket.instances.every((ws) => ws.sent.length === 0));
    });
  }
});
