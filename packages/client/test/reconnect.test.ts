import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { StageClient } from '../src/index.ts';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: { type: string; requestId?: string; roomId?: string }[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  deferClose = false;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; if (!this.deferClose) this.onclose?.(); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const hello = (socket: Socket) => socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
function setup(t: TestContext) {
  Socket.instances = [];
  const originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  t.mock.method(performance, 'now', () => 1000);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const client = new StageClient({ url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement, requestTimeoutMs: 5000, reconnect: { initialDelayMs: 500, maxDelayMs: 2000 } });
  t.after(async () => {
    await client.disconnect();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  return client;
}
async function answerJoin(t: TestContext, socket: Socket) {
  assert.equal(socket.readyState, Socket.OPEN);
  hello(socket); await flush(); t.mock.timers.tick(0);
  const request = socket.sent.at(-1)!; assert.equal(request.type, 'join');
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flush();
}
async function joined(t: TestContext, client: StageClient, roomId: string) {
  const pending = client.join({ roomId, name: 'guest' }); pending.catch(() => {});
  const socket = Socket.instances.at(-1)!; await answerJoin(t, socket); await pending; return socket;
}
async function reconnectJoin(t: TestContext, old: Socket) {
  old.close(); t.mock.timers.tick(500);
  const resume = Socket.instances.at(-1)!; hello(resume); await flush(); t.mock.timers.tick(0);
  const request = resume.sent.at(-1)!; assert.equal(request.type, 'join'); return { resume, request };
}

it('does not arm reconnect work after its status listener disconnects', async t => {
  const client = setup(t), old = await joined(t, client, 'old');
  client.on('status', event => { if (event.detail === 'reconnecting') void client.disconnect(); });
  old.close(); assert.equal(client['reconnectTimer'], undefined);
  t.mock.timers.tick(2000); await flush(); assert.equal(Socket.instances.length, 1);
});

it('does not let an old reconnect timer join a replacement session twice', async t => {
  const client = setup(t), old = await joined(t, client, 'old'); let next: Promise<void> | undefined;
  client.on('status', event => {
    if (event.detail === 'reconnecting') { void client.disconnect(); next = client.join({ roomId: 'new', name: 'guest' }); next.catch(() => {}); }
  });
  old.close(); const replacement = Socket.instances.at(-1)!;
  await answerJoin(t, replacement); assert.ok(next); await next;
  assert.equal(client['reconnectTimer'], undefined);
  t.mock.timers.tick(500); await flush(); t.mock.timers.tick(100); await flush();
  assert.deepEqual(replacement.sent.filter(message => message.type === 'join').map(message => message.roomId), ['new']);
  assert.equal(client['session']!.roomId, 'new'); assert.equal(replacement.readyState, Socket.OPEN);
});

for (const code of ['unauthorized', 'not_found', 'room_full'] as const) {
  for (const switchAt of [1, 2]) it(`keeps replacement join alive when ${code} error listener ${switchAt} switches sessions`, async t => {
    const client = setup(t), old = await joined(t, client, 'old');
    const { resume, request } = await reconnectJoin(t, old);
    let next: Promise<void> | undefined; const errors: string[] = [];
    client.on('error', event => {
      errors.push(event.detail.code);
      if (errors.length === switchAt) { void client.disconnect(); next = client.join({ roomId: 'new', name: 'guest' }); next.catch(() => {}); }
    });
    resume.deliver({ type: 'error', requestId: request.requestId, code, message: 'rejected' }); await flush();
    assert.ok(next); const replacement = Socket.instances.at(-1)!;
    await answerJoin(t, replacement); await next;
    assert.deepEqual(errors, Array.from({ length: switchAt }, () => code));
    assert.equal(client['session']!.roomId, 'new'); assert.equal(replacement.readyState, Socket.OPEN);
    assert.equal(client['reconnectTimer'], undefined);
  });
}

it('ignores an abandoned reconnect hello rejection after a replacement has joined', async t => {
  const client = setup(t), old = await joined(t, client, 'old');
  old.close(); t.mock.timers.tick(500); const abandoned = Socket.instances.at(-1)!;
  abandoned.deferClose = true; await client.disconnect();
  const replacement = await joined(t, client, 'new'); const errors: string[] = [];
  client.on('error', event => errors.push(event.detail.code));
  abandoned.onclose?.(); await flush();
  assert.equal(replacement.readyState, Socket.OPEN); assert.equal(client['session']!.roomId, 'new');
  assert.deepEqual(errors, []); assert.equal(client['reconnectTimer'], undefined);
});

it('still resumes normally and backs off after a transient hello failure', async t => {
  const client = setup(t), old = await joined(t, client, 'old'), session = client['session'];
  old.close(); t.mock.timers.tick(500); const failed = Socket.instances.at(-1)!;
  failed.close(); await flush(); const retry = client['reconnectTimer']; assert.ok(retry);
  t.mock.timers.tick(999); assert.equal(Socket.instances.length, 2);
  t.mock.timers.tick(1); assert.equal(Socket.instances.length, 3);
  const recovered = Socket.instances.at(-1)!; await answerJoin(t, recovered);
  assert.equal(client['session'], session); assert.equal(recovered.readyState, Socket.OPEN);
  assert.equal(client['reconnectTimer'], undefined);
  assert.deepEqual(recovered.sent.filter(message => message.type === 'join').map(message => message.roomId), ['old']);
});

it('still clears the session for a current terminal resume rejection', async t => {
  const client = setup(t), old = await joined(t, client, 'old');
  const { resume, request } = await reconnectJoin(t, old);
  resume.deliver({ type: 'error', requestId: request.requestId, code: 'unauthorized', message: 'rejected' }); await flush();
  assert.equal(client['session'], null); assert.equal(client.status, 'disconnected');
  assert.equal(client['reconnectTimer'], undefined); assert.equal(resume.readyState, 3);
});

for (const operation of ['join', 'create'] as const) {
  for (const expireFirst of [false, true]) it(`reconnects a replacement ${operation} lost ${expireFirst ? 'after' : 'before'} the old timer deadline`, async t => {
    const client = setup(t), old = await joined(t, client, 'old');
    old.close();
    let replacement: Socket;
    if (operation === 'join') replacement = await joined(t, client, 'new');
    else {
      const creating = client.createRoom({ name: 'Host' }); creating.catch(() => {});
      replacement = Socket.instances.at(-1)!; hello(replacement); await flush(); t.mock.timers.tick(0);
      const request = replacement.sent.at(-1)!; assert.equal(request.type, 'room:create');
      replacement.deliver({ type: 'room:created', roomId: 'new', code: 'test-code' });
      replacement.deliver({ type: 'ok', requestId: request.requestId }); await creating;
    }
    assert.equal(client['reconnectTimer'], undefined, 'installing a new session cancels its predecessor timer');
    if (expireFirst) { t.mock.timers.tick(500); await flush(); }
    replacement.close(); t.mock.timers.tick(2000); await flush();
    assert.equal(Socket.instances.length, 3, 'new session can still schedule its own reconnect');
    const resumed = Socket.instances.at(-1)!; await answerJoin(t, resumed);
    assert.deepEqual(resumed.sent.filter(message => message.type === 'join').map(message => message.roomId), ['new']);
    assert.equal(client['session']!.roomId, 'new'); assert.equal(client['reconnectTimer'], undefined);
  });
}

for (const phase of ['hello', 'resume'] as const) {
  it(`retries a stalled ${phase} without waiting for its close event`, async t => {
    const client = setup(t), old = await joined(t, client, 'old'), session = client['session'];
    old.close(); t.mock.timers.tick(500); const stalled = Socket.instances.at(-1)!;
    stalled.deferClose = true;
    if (phase === 'resume') { hello(stalled); await flush(); t.mock.timers.tick(0); }
    t.mock.timers.tick(5000); await flush();
    assert.equal(client['socket'], null); assert.ok(client['reconnectTimer']);
    assert.equal(client['session'], session); assert.equal(client['connecting'], null);
    t.mock.timers.tick(999); assert.equal(Socket.instances.length, 2);
    t.mock.timers.tick(1); assert.equal(Socket.instances.length, 3);
    const recovered = Socket.instances.at(-1)!; await answerJoin(t, recovered);
    stalled.onclose?.(); hello(stalled); await flush();
    assert.equal(client['socket'], recovered); assert.equal(recovered.readyState, Socket.OPEN);
    assert.equal(client['session'], session); assert.equal(client['reconnectTimer'], undefined);
    assert.equal(recovered.sent.filter(message => message.type === 'join').length, 1);
  });
}

it('lets a timeout status callback immediately connect without reusing its rejected hello promise', async t => {
  const client = setup(t); const first = client.connect(); first.catch(() => {});
  const stalled = Socket.instances[0]!; stalled.deferClose = true;
  // Start from a visible nonterminal status so the disconnected callback is emitted.
  stalled.deliver({ type: 'status', state: 'waiting' });
  let replacement: Promise<void> | undefined;
  client.on('status', event => { if (event.detail === 'disconnected') replacement = client.connect(); });
  t.mock.timers.tick(5000); await assert.rejects(first, /逾時/); await flush();
  assert.ok(replacement); assert.notEqual(replacement, first); assert.equal(Socket.instances.length, 2);
  const next = Socket.instances[1]!; hello(next); await replacement;
  stalled.onclose?.(); await flush(); assert.equal(client['socket'], next);
});

it('keeps retry scheduled when closing the timed-out transport throws', async t => {
  const client = setup(t), old = await joined(t, client, 'old');
  old.close(); t.mock.timers.tick(500); const stalled = Socket.instances.at(-1)!;
  stalled.close = () => { throw new Error('transport already failed'); };
  t.mock.timers.tick(5000); await flush();
  assert.equal(client['socket'], null); assert.ok(client['reconnectTimer']);
  t.mock.timers.tick(1000); const recovered = Socket.instances.at(-1)!;
  assert.notEqual(recovered, stalled); await answerJoin(t, recovered);
  assert.equal(client['socket'], recovered); assert.equal(client['reconnectTimer'], undefined);
});
