import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StageClient, StageError } from '../src/index.ts';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('configurable client request deadlines', () => {
  const clients: StageClient[] = [];
  let originals: Map<string, PropertyDescriptor | undefined>;
  beforeEach(t => {
    assert.ok('mock' in t);
    Socket.instances = [];
    originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    t.mock.method(performance, 'now', () => 1000);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.disconnect();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  function make(timeout?: number) {
    const client = new StageClient({ url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement, ...(timeout !== undefined ? { requestTimeoutMs: timeout } : {}) });
    clients.push(client); return client;
  }
  async function connect(client: StageClient) {
    const ready = client.connect();
    const socket = Socket.instances.at(-1)!;
    socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
    await ready; return socket;
  }
  function peer(client: StageClient) {
    const pc = {
      localDescription: null as RTCSessionDescriptionInit | null,
      async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\n' }; },
      async setLocalDescription(offer: RTCSessionDescriptionInit) { this.localDescription = offer; },
      async setRemoteDescription(_answer: RTCSessionDescriptionInit) {},
      close() {},
    };
    client['pc'] = pc as unknown as RTCPeerConnection;
  }

  it('validates the option before mutating supplied audio', () => {
    for (const value of [0, -1, 1.5, 300001, NaN, Infinity, '50', null]) {
      const audio = { autoplay: false } as HTMLAudioElement;
      assert.throws(() => new StageClient({ url: 'ws://localhost/ws', audioElement: audio, requestTimeoutMs: value as number }), RangeError);
      assert.equal(audio.autoplay, false);
    }
    make(1); make(300000);
  });

  for (const timeout of [undefined, 50]) it(`uses ${timeout ?? 'the default 15000'}ms for the initial hello`, async t => {
    const client = make(timeout), duration = timeout ?? 15000;
    const pending = client.connect();
    const rejected = assert.rejects(pending, error => error instanceof StageError && error.code === 'timeout');
    t.mock.timers.tick(duration - 1);
    assert.equal(Socket.instances[0]!.readyState, Socket.OPEN);
    t.mock.timers.tick(1); await rejected;
    assert.equal(Socket.instances[0]!.readyState, 3);
  });

  it('applies acknowledgement timeout after the paced send slot', async t => {
    const client = make(50), socket = await connect(client);
    client['nextControlAt'] = 1200;
    const request = client.rotateCode();
    const rejected = assert.rejects(request, error => error instanceof StageError && error.code === 'timeout');
    t.mock.timers.tick(199); assert.equal(socket.sent.length, 0);
    t.mock.timers.tick(1); assert.equal(socket.sent.length, 1);
    t.mock.timers.tick(49); assert.equal(client['pending'].size, 1);
    t.mock.timers.tick(1); await rejected;
    assert.equal(client['pending'].size, 0);
  });

  for (const answer of [false, true]) it(`starts SDP answer deadline at actual send and ${answer ? 'cleans up on success' : 'expires on silence'}`, async t => {
    const client = make(50), socket = await connect(client);
    const errors: StageError[] = [];
    client.on('error', event => errors.push(event.detail));
    peer(client); client['nextControlAt'] = 1200;
    client['negotiate'](); await flush();
    assert.ok(client['answerWait']);
    t.mock.timers.tick(199); await flush();
    assert.equal(socket.sent.length, 0); assert.equal(errors.length, 0);
    t.mock.timers.tick(1);
    const offer = JSON.parse(socket.sent[0]!);
    socket.deliver({ type: 'ok', requestId: offer.requestId });
    t.mock.timers.tick(49); await flush(); assert.equal(errors.length, 0);
    if (answer) { socket.deliver({ type: 'rtc:answer', payload: { type: 'answer', sdp: 'v=0\r\n' } }); await flush(); }
    t.mock.timers.tick(1); await flush();
    assert.equal(errors.length, answer ? 0 : 1);
    if (!answer) assert.equal(errors[0]!.code, 'timeout');
    assert.equal(client['answerWait'], null);
    assert.equal(client['answerTimer'], undefined);
    assert.equal(client['negotiating'], false);
    assert.equal(client['pending'].size, 0);
  });

  for (const ackFirst of [false, true]) it(`cleans up immediate SDP replies with ${ackFirst ? 'ACK' : 'answer'} first`, async t => {
    const client = make(50), socket = await connect(client);
    const errors: StageError[] = [];
    client.on('error', event => errors.push(event.detail));
    peer(client);
    socket.send = data => {
      const offer = JSON.parse(data);
      const ack = { type: 'ok', requestId: offer.requestId };
      const answer = { type: 'rtc:answer', payload: { type: 'answer', sdp: 'v=0\r\n' } };
      for (const reply of ackFirst ? [ack, answer] : [answer, ack]) socket.deliver(reply);
    };
    client['negotiate'](); await flush();
    t.mock.timers.tick(0); await flush();
    assert.equal(client['negotiating'], false);
    assert.equal(client['answerTimer'], undefined);
    assert.equal(client['pending'].size, 0);
    t.mock.timers.tick(100); await flush();
    assert.equal(errors.length, 0);
  });

  it('clears the armed answer deadline if sending the offer throws', async t => {
    const client = make(50), socket = await connect(client);
    const errors: StageError[] = [];
    client.on('error', event => errors.push(event.detail));
    peer(client); socket.send = () => { throw new Error('send failed'); };
    client['negotiate'](); await flush();
    t.mock.timers.tick(0); await flush();
    assert.equal(client['answerTimer'], undefined);
    assert.equal(client['answerWait'], null);
    assert.equal(client['pending'].size, 0);
    t.mock.timers.tick(100); await flush();
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.code, 'disconnected');
  });

  it('does not let a retired peer send a queued offer or replace the new answer deadline', async t => {
    const client = make(50), socket = await connect(client);
    peer(client); client['nextControlAt'] = 1200;
    client['negotiate'](); await flush();
    client['destroyMedia'](); peer(client);
    const newWait = { resolve() {}, reject() { assert.fail('old deadline rejected the new peer'); } };
    client['answerWait'] = newWait;
    t.mock.timers.tick(200); await flush();
    assert.equal(socket.sent.length, 0);
    assert.equal(client['answerWait'], newWait);
    assert.equal(client['answerTimer'], undefined);
    assert.equal(client['pending'].size, 0);
    client['answerWait'] = null;
  });

  it('cancels an unsent offer and answer wait on disconnect', async t => {
    const client = make(50), socket = await connect(client);
    peer(client); client['nextControlAt'] = 1200;
    client['negotiate'](); await flush();
    await client.disconnect(); t.mock.timers.tick(1000); await flush();
    assert.equal(socket.sent.length, 0);
    assert.equal(client['answerWait'], null);
    assert.equal(client['answerTimer'], undefined);
    assert.equal(client['pending'].size, 0);
  });
});
