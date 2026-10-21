import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { RoomStatePayload } from '../../../shared/protocol.ts';
import { StageClient } from '../src/index.ts';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {
    Socket.instances.push(this);
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } }) }));
  }
  send(data: string) {
    this.sent.push(data);
    const message = JSON.parse(data);
    if (message.requestId) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'ok', requestId: message.requestId }) }));
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

describe('monotonic client intervals', () => {
  let client: StageClient;
  let wall: number, monotonic: number;
  let originals: Map<string, PropertyDescriptor | undefined>;
  beforeEach(t => {
    assert.ok('mock' in t);
    wall = 1700000000000; monotonic = 1000; Socket.instances = [];
    originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    t.mock.method(Date, 'now', () => wall);
    t.mock.method(performance, 'now', () => monotonic);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    client = new StageClient({ url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement });
  });
  afterEach(async () => {
    await client.disconnect();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it('keeps request pacing bounded when wall time moves backward', async t => {
    await client.connect();
    const first = client.rotateCode(); first.catch(() => {});
    t.mock.timers.tick(0); await first;
    wall -= 3600000; monotonic += 100;
    const next = client.rotateCode(); next.catch(() => {});
    t.mock.timers.tick(100);
    await Promise.resolve();
    assert.equal(Socket.instances[0]!.sent.length, 2, 'a clock correction must not defer the request for an hour');
    await next;
  });

  it('measures hand cooldown by elapsed time rather than wall-clock corrections', async t => {
    await client.connect();
    const raised = client.raiseHand(); raised.catch(() => {});
    t.mock.timers.tick(0); await raised;
    wall -= 3600000; monotonic += 1000;
    assert.equal(client.handCooldownMs, 9000);
    wall += 7200000; monotonic += 9000;
    assert.equal(client.handCooldownMs, 0);
  });

  it('ignores forward wall jumps for keepalive but still disconnects after elapsed silence', async t => {
    await client.connect();
    wall += 3600000; monotonic += 15000;
    t.mock.timers.tick(15000);
    assert.equal(Socket.instances[0]!.readyState, Socket.OPEN);
    assert.equal(JSON.parse(Socket.instances[0]!.sent[0]!).type, 'ping');
    monotonic += 30000;
    t.mock.timers.tick(30000);
    assert.equal(Socket.instances[0]!.readyState, 3);
  });
  it('clears the old room cooldown on disconnect and lets the reused client raise immediately', async t => {
    await client.connect(); const first = client.raiseHand(); t.mock.timers.tick(0); await first;
    assert.equal(client.handCooldownMs, 10000);
    await client.disconnect(); assert.equal(client.handCooldownMs, 0);
    await client.connect(); const second = client.raiseHand(); t.mock.timers.tick(0); await second;
    assert.equal(JSON.parse(Socket.instances[1]!.sent[0]!).type, 'hand:raise');
  });

  it('preserves cooldown for same-identity snapshots and resets it only for a new participant', async t => {
    client['createMedia'] = () => {}; client['syncMedia'] = () => {};
    const state = (participantId: string): RoomStatePayload => ({
      roomId: 'room', name: 'Room', controllerId: 'host', speakers: [], hands: [], audienceCount: 1,
      codeRequired: false, recording: false, recordingAvailable: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
      me: { participantId, name: 'Guest', role: 'audience', onStage: false, handRaised: false,
        muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 },
    });
    await client.connect(); await client['receive']({ type: 'room:state', ...state('old') });
    const raised = client.raiseHand(); t.mock.timers.tick(0); await raised;
    monotonic += 1000;
    await client['receive']({ type: 'room:state', ...state('old') });
    assert.equal(client.handCooldownMs, 9000, 'ordinary or resumed snapshots must not reset the cooldown');
    await client['receive']({ type: 'room:state', ...state('new') });
    assert.equal(client.handCooldownMs, 0);
  });

});
