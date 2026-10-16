import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import type { ClientMessage, RateLimits } from '../../../shared/protocol.ts';
import { ConnectionRateLimiter } from '../../../src/ws/rateLimit.ts';
import { testConfig } from '../../../test/helpers.ts';
import { StageClient, StageError, type StageClientOptions } from '../src/index.ts';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: { at: number; message: ClientMessage }[] = [];
  ack = true;
  pong = true;
  limiter: ConnectionRateLimiter | undefined;
  onSend: ((message: ClientMessage) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) {
    const message = JSON.parse(data) as ClientMessage;
    const at = performance.now();
    assert.equal(this.limiter?.allow(message.type, at), true, `${message.type} at ${at} must satisfy the unchanged server limiter`);
    this.sent.push({ at, message });
    this.onSend?.(message);
    if (message.type === 'ping') { if (this.pong) this.deliver({ type: 'pong' }); }
    else if (this.ack) this.deliver({ type: 'ok', requestId: message.requestId });
  }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const settle = (request: Promise<unknown>): Promise<unknown> => request.then(() => undefined, (error: unknown) => error);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const reservation = (client: StageClient) => [client['lastSendAt'], client['nextControlAt'], client['nextIceAt']];
function assertError(error: unknown, code: StageError['code']): void {
  assert.ok(error instanceof StageError); assert.equal(error.code, code);
}

describe('SDK keepalive shares control pacing', () => {
  let now: number;
  let originals: Map<string, PropertyDescriptor | undefined>;
  const clients: StageClient[] = [];
  beforeEach(t => {
    assert.ok('mock' in t);
    now = 0; Socket.instances = [];
    originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    t.mock.method(performance, 'now', () => now);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.disconnect();
    await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  function make(options: Partial<StageClientOptions> = {}): StageClient {
    const client = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 60000,
      audioElement: { pause() {} } as unknown as HTMLAudioElement, ...options });
    clients.push(client); return client;
  }
  function hello(socket: Socket, controlPerSecond = 1, icePerSecond = 30): void {
    const limits: RateLimits = { controlPerSecond, icePerSecond, handRaiseIntervalMs: 10000 };
    socket.limiter = new ConnectionRateLimiter({ ...testConfig().limits, ...limits }, now);
    socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits });
  }
  async function connect(client: StageClient, controlPerSecond = 1, icePerSecond = 30): Promise<Socket> {
    const ready = client.connect(), socket = Socket.instances.at(-1)!;
    hello(socket, controlPerSecond, icePerSecond); await ready; return socket;
  }
  function tick(t: TestContext, milliseconds: number): void { now += milliseconds; t.mock.timers.tick(milliseconds); }

  it('skips a conflicting tick after a rate-one control and sends the later idle ping', async t => {
    const client = make(), socket = await connect(client);
    tick(t, 14500); const rename = client.setName('Guest'); tick(t, 0); await rename;
    const before = reservation(client), heard = client['lastHeardAt'];
    tick(t, 500);
    assert.deepEqual(socket.sent.map(({ message }) => message.type), ['participant:rename']);
    assert.deepEqual(reservation(client), before); assert.equal(client['lastHeardAt'], heard);
    tick(t, 15000);
    assert.deepEqual(socket.sent.map(({ at, message }) => [at, message.type]), [[14500, 'participant:rename'], [30000, 'ping']]);
    assert.deepEqual(socket.sent.at(-1)!.message, { type: 'ping' });
    assert.equal(client['lastHeardAt'], 30000); assert.equal(client['pending'].size, 0);
  });

  it('makes a control after a rate-one ping wait until the shared slot', async t => {
    const client = make(), socket = await connect(client);
    tick(t, 15000); tick(t, 500);
    const rename = client.setName('Guest'); tick(t, 1499);
    assert.deepEqual(socket.sent.map(({ message }) => message.type), ['ping']);
    tick(t, 1); await rename;
    assert.deepEqual(socket.sent.map(({ at, message }) => [at, message.type]), [[15000, 'ping'], [17000, 'participant:rename']]);
  });

  for (const rate of [1, 20]) it(`keeps quiet rate-${rate} clients alive without request IDs, pending capacity or ACK timers`, async t => {
    const client = make({ maxPendingControlRequests: 1 }), socket = await connect(client, rate);
    const timeouts = t.mock.method(globalThis, 'setTimeout'), uuid = t.mock.method(crypto, 'randomUUID');
    for (let i = 1; i <= 4; i++) {
      tick(t, 15000);
      assert.equal(socket.sent.length, i); assert.deepEqual(socket.sent.at(-1)!.message, { type: 'ping' });
      assert.equal(client['pendingControlRequests'], 0); assert.equal(client['pending'].size, 0);
      assert.deepEqual(reservation(client), [now, now + Math.ceil(2000 / rate), 0]);
    }
    assert.equal(timeouts.mock.calls.length, 0); assert.equal(uuid.mock.calls.length, 0);
    assert.equal(socket.readyState, Socket.OPEN);
  });

  it('preserves queued control slots, timers, capacity and order when omitting a ping', async t => {
    const client = make({ maxPendingControlRequests: 3 }), socket = await connect(client);
    tick(t, 14500);
    const requests = ['First', 'Second', 'Third'].map(name => client.setName(name)); tick(t, 0); await requests[0];
    const before = reservation(client), pending = [...client['pending'].values()].map(p => ({ ...p }));
    const timeouts = t.mock.method(globalThis, 'setTimeout');
    tick(t, 500);
    assert.deepEqual(reservation(client), before); assert.deepEqual([...client['pending'].values()], pending);
    assert.equal(client['pendingControlRequests'], 2); assert.equal(timeouts.mock.calls.length, 0);
    tick(t, 1500); await requests[1]; tick(t, 2000); await requests[2];
    assert.deepEqual(socket.sent.map(({ at, message }) => [at, message.type === 'participant:rename' && message.name]), [[14500, 'First'], [16500, 'Second'], [18500, 'Third']]);
  });

  it('respects a future ICE tail even after the control reservation expires', async t => {
    const client = make(), socket = await connect(client, 1, 1);
    tick(t, 13000);
    const requests = [client['request']('rtc:offer', { payload: { type: 'offer', sdp: 'v=0\r\n' } }), ...Array.from({ length: 3 }, () => client['request']('rtc:ice', { payload: null }))];
    tick(t, 0); await requests[0]; await requests[1]; tick(t, 1500); await requests[2];
    assert.deepEqual(reservation(client), [16000, 15000, 17500]);
    const before = reservation(client), heard = client['lastHeardAt'];
    tick(t, 500);
    assert.deepEqual(reservation(client), before); assert.equal(client['lastHeardAt'], heard);
    assert.equal(socket.sent.some(({ message }) => message.type === 'ping'), false);
    tick(t, 1000); await requests[3];
    assert.deepEqual(socket.sent.map(({ at, message }) => [at, message.type]), [[13000, 'rtc:offer'], [13000, 'rtc:ice'], [14500, 'rtc:ice'], [16000, 'rtc:ice']]);
  });

  it('admits equality at the control boundary without extending ICE spacing', async t => {
    const client = make(), socket = await connect(client);
    tick(t, 13000); const rename = client.setName('Guest'); tick(t, 0); await rename;
    assert.equal(client['nextControlAt'], 15000);
    tick(t, 2000);
    assert.deepEqual(socket.sent.at(-1), { at: 15000, message: { type: 'ping' } });
    assert.deepEqual(reservation(client), [15000, 17000, 0]);
  });

  it('admits equality with the final ICE slot while preserving offer-before-ICE order', async t => {
    const client = make(), socket = await connect(client, 1, 1);
    tick(t, 12000);
    const requests = [client['request']('rtc:offer', { payload: { type: 'offer', sdp: 'v=0\r\n' } }), ...Array.from({ length: 3 }, () => client['request']('rtc:ice', { payload: null }))];
    tick(t, 0); tick(t, 1500);
    assert.deepEqual(reservation(client), [15000, 14000, 16500]);
    tick(t, 1500); await Promise.all(requests);
    assert.equal(socket.sent.filter(({ message }) => message.type === 'ping').length, 1);
    assert.deepEqual(socket.sent.filter(({ message }) => message.type !== 'ping').map(({ at, message }) => [at, message.type]), [[12000, 'rtc:offer'], [12000, 'rtc:ice'], [13500, 'rtc:ice'], [15000, 'rtc:ice']]);
    assert.deepEqual(reservation(client), [15000, 17000, 16500]);
  });

  it('allows ping at full caller capacity when an already-sent request has used its spacing', async t => {
    const client = make({ maxPendingControlRequests: 1 }), socket = await connect(client); socket.ack = false;
    const request = settle(client.setName('Guest')); tick(t, 0);
    const pending = [...client['pending']];
    tick(t, 15000);
    assert.deepEqual(socket.sent.at(-1)!.message, { type: 'ping' });
    assert.deepEqual([...client['pending']], pending); assert.equal(client['pendingControlRequests'], 1);
    assertError(await settle(client.setName('Full')), 'queue_full');
    await client.disconnect(); assertError(await request, 'disconnected');
  });

  it('gives a request after ping its full post-slot acknowledgement deadline', async t => {
    const client = make({ requestTimeoutMs: 1000 }), socket = await connect(client); socket.ack = false;
    tick(t, 15000); tick(t, 500);
    let outcome: unknown = 'pending'; const request = settle(client.setName('Guest')).then(value => { outcome = value; });
    tick(t, 1499); await flush(); assert.equal(outcome, 'pending');
    tick(t, 1); assert.equal(socket.sent.at(-1)!.at, 17000);
    tick(t, 999); await flush(); assert.equal(outcome, 'pending');
    tick(t, 1); await request; assertError(outcome, 'timeout');
  });

  it('reserves the ping slot before synchronous send reentry schedules a control', async t => {
    const client = make(), socket = await connect(client); let request: Promise<void> | undefined;
    socket.onSend = message => { if (message.type === 'ping') request = client.setName('Reentrant'); };
    tick(t, 15000);
    assert.ok(request); assert.deepEqual(reservation(client), [17000, 19000, 0]);
    tick(t, 1999); assert.equal(socket.sent.length, 1); tick(t, 1); await request;
    assert.equal(socket.sent.at(-1)!.at, 17000);
  });

  it('does not overwrite reservations reset by synchronous disconnect during ping send', async t => {
    const client = make(), socket = await connect(client);
    socket.onSend = message => { if (message.type === 'ping') void client.disconnect(); };
    tick(t, 15000);
    assert.deepEqual(reservation(client), [0, 0, 0]); assert.equal(client['keepaliveTimer'], undefined);
    const replacement = await connect(client, 20);
    const request = client.setName('Replacement'); tick(t, 0); await request;
    assert.equal(replacement.sent[0]!.at, 15000); assert.deepEqual(reservation(client), [15000, 15100, 0]);
  });

  it('keeps the conservative reservation if the unchanged ping send path throws', async t => {
    const client = make(), socket = await connect(client);
    socket.onSend = () => { throw new Error('transport send failed'); };
    assert.throws(() => tick(t, 15000), /transport send failed/);
    assert.deepEqual(reservation(client), [15000, 17000, 0]); assert.equal(client['pending'].size, 0);
  });

  it('checks silence before future reservations and cancels all queued work on the existing deadline', async t => {
    const client = make(), socket = await connect(client); socket.ack = false; socket.pong = false;
    client['session'] = { roomId: 'room', name: 'Guest' };
    const errors: StageError[] = []; client.on('error', event => errors.push(event.detail));
    const requests = Array.from({ length: 31 }, () => settle(client.setName('Guest')));
    tick(t, 0);
    for (let i = 1; i < 45; i++) tick(t, 1000);
    assert.equal(socket.readyState, Socket.OPEN); assert.equal(client['lastHeardAt'], 0);
    assert.equal(socket.sent.some(({ message }) => message.type === 'ping'), false);
    assert.ok(client['lastSendAt'] > now);
    tick(t, 1000);
    assert.equal(socket.readyState, 3); assert.equal(client.status, 'reconnecting');
    assert.deepEqual(errors.map(error => error.code), ['timeout']);
    assert.equal(client['pending'].size, 0); assert.equal(client['keepaliveTimer'], undefined);
    assert.deepEqual(reservation(client), [0, 0, 0]);
    for (const error of await Promise.all(requests)) assertError(error, 'disconnected');
  });

  it('keeps acknowledged busy traffic live while omitting conflicting interval ticks', async t => {
    const client = make(), socket = await connect(client);
    for (let at = 500; at <= 60500; at += 500) {
      tick(t, 500);
      if (at % 2000 !== 500) continue;
      const request = client.setName(`Guest ${at}`); tick(t, 0); await request;
    }
    assert.equal(socket.readyState, Socket.OPEN); assert.equal(client['lastHeardAt'], 60500);
    assert.equal(socket.sent.some(({ message }) => message.type === 'ping'), false);
    assert.equal(client['pending'].size, 0);
  });

  it('resets stale queued slots on socket loss and uses replacement hello limits for resume and ping', async t => {
    const client = make({ reconnect: { initialDelayMs: 1, maxDelayMs: 1 } }), old = await connect(client);
    client['session'] = { roomId: 'room', name: 'Guest' };
    tick(t, 15000);
    const abandoned = settle(client.setName('Old queued'));
    old.close(); assert.deepEqual(reservation(client), [0, 0, 0]);
    tick(t, 1); const replacement = Socket.instances.at(-1)!; assert.notEqual(replacement, old);
    hello(replacement, 20); await flush(); tick(t, 0); await flush();
    assertError(await abandoned, 'disconnected');
    assert.equal(replacement.sent[0]!.message.type, 'join'); assert.equal(replacement.sent[0]!.at, 15001);
    tick(t, 15000);
    assert.deepEqual(replacement.sent.at(-1), { at: 30001, message: { type: 'ping' } });
    assert.deepEqual(reservation(client), [30001, 30101, 0]);
    assert.deepEqual(old.sent.map(({ message }) => message.type), ['ping']);
    assert.equal(Socket.instances.length, 2);
  });
});
