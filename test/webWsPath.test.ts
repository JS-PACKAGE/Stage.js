import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import { harness, testConfig } from './helpers.ts';

const PATH_ERROR = 'WebSocket 路徑無效，請修正網址中的 wsPath（例如 /ws）後重新載入。';
const SECRET = 'SYNTHETIC_SAMPLE_PATH_SECRET_4f21';
type Action = 'create' | 'join';
type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'find' | 'id' | 'button'>;
interface CreatedRoom { roomId: string; code?: string }
function page(path?: string, base = 'https://sample.test/stage/'): URL {
  const url = new URL(base);
  if (path !== undefined) url.searchParams.set('wsPath', path);
  return url;
}
function form(h: View, action: Action): SampleNode {
  return h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2'
    && child.textContent === (action === 'create' ? '建立房間' : '加入房間')));
}
function input(form: SampleNode, name: string): SampleNode {
  const node = form.descendants().find(node => node.tagName === 'input' && node.name === name);
  assert.ok(node); return node;
}
function fill(h: View, action: Action): SampleNode {
  const node = form(h, action);
  const values = action === 'create' ? { name: '主控', roomName: '路徑測試', token: SECRET }
    : { name: '聽眾', roomId: 'same-room', code: 'TEST42' };
  for (const [name, value] of Object.entries(values)) input(node, name).value = value;
  return node;
}
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
const notices = (h: View) => h.find(node => node.classList.contains('notices'));
const inviteLink = (h: View) => h.find(node => node.classList.contains('invite-link'));
function idle(h: View): void {
  for (const action of ['create', 'join'] as const) {
    const submit = form(h, action).descendants().find(node => node.type === 'submit'); assert.ok(submit);
    assert.equal(submit.disabled, false); assert.equal(submit.attributes['aria-busy'], 'false');
  }
  assert.equal(h.id('landing-cancel').hidden, true); assert.equal(h.id('landing-cancel').disabled, true);
}
function controllerState(code = 'OLD23456'): RoomStatePayload {
  const state = roomState({ participantId: 'controller', role: 'controller' });
  state.controllerId = state.me.participantId; state.audienceCount = 0; state.audience = [];
  state.codeRequired = true; state.code = code; return state;
}
function setup(t: TestContext, location = page(), expectedSdkUrl = 'wss://sample.test/ws') {
  const copies: { text: string; work: Deferred<void> }[] = [], rotations: Deferred<void>[] = [];
  const creates: { options: unknown; work: Deferred<CreatedRoom> }[] = [];
  const confirmations: string[] = [];
  const h = sampleApp({ location, expectedSdkUrl,
    clipboard: { writeText(text) { const work = new Deferred<void>(); copies.push({ text, work }); return work.promise; } },
    confirm(message) { confirmations.push(message); return true; },
  });
  Object.assign(h.sdk, {
    createRoom(options: unknown) { const work = new Deferred<CreatedRoom>(); creates.push({ options, work }); return work.promise; },
    rotateCode() { const work = new Deferred<void>(); rotations.push(work); return work.promise; },
  });
  t.after(async () => {
    for (const { work } of copies) if (work.status === 'pending') work.resolve(undefined);
    for (const work of [...creates.map(call => call.work), ...rotations]) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
    await h.cleanup();
    assert.ok([...copies.map(call => call.work), ...creates.map(call => call.work), ...rotations].every(work => work.status !== 'pending'));
  });
  return { ...h, copies, rotations, confirmations, creates };
}
async function enter(h: ReturnType<typeof setup>, state = controllerState()): Promise<void> {
  const node = fill(h, 'join'); node.submit(); h.sdk.acceptJoin(state); await flushSample();
  assert.equal(node.isConnected, false); assert.equal(errorBox(h).hidden, true);
}

it('whole sample retains one constant SDK and the fixture keeps strict default construction assertions', async t => {
  const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
  assert.equal(source.match(/\bnew StageClient\(/g)?.length, 1);
  assert.match(source, /\bconst client = new StageClient\(/);
  const h = sampleApp(); t.after(() => h.cleanup()); idle(h);
  assert.throws(() => sampleApp({ location: page('/custom') }), /wss:\/\/sample\.test\/(custom|ws)/,
    'a location override must not silently weaken the default SDK URL assertion');
});

for (const [label, path, expected] of [
  ['omitted', undefined, '/ws'], ['empty', '', '/ws'], ['spaces only', '   ', '/ws'],
  ['explicit default', '/ws', '/ws'], ['custom', '/custom/stage', '/custom/stage'],
  ['trimmed custom', '  /custom/stage  ', '/custom/stage'], ['root', '/', '/'],
  ['internal double slash', '/stage//ws', '/stage//ws'],
  ['encoded delimiters', '/%2F%2fother.test/%5C%3F%23', '/%2F%2fother.test/%5C%3F%23'],
  ['encoded percent', '/%252e%252e/%252F', '/%252e%252e/%252F'],
  ['literal encoded space', '/stage%20ws', '/stage%20ws'],
  ['ordinary dots', '/v1.2/stage.../..name', '/v1.2/stage.../..name'],
  ['Unicode', '/舞台/音訊', '/%E8%88%9E%E5%8F%B0/%E9%9F%B3%E8%A8%8A'],
] as const) {
  it(`whole sample selects ${label} wsPath at page load and preserves ordinary join behavior`, async t => {
    const h = setup(t, page(path), `wss://sample.test${expected}`);
    await flushSample(); idle(h); assert.equal(errorBox(h).hidden, true);
    const landing = fill(h, 'join'); landing.submit();
    assert.deepEqual({ ...h.sdk.joins[0]!.options }, { roomId: 'same-room', code: 'TEST42', name: '聽眾' });
    h.sdk.acceptJoin(roomState()); await flushSample(); assert.equal(landing.isConnected, false);
    h.button('離開房間').click(); await flushSample(); idle(h); assert.equal(h.clock.jobs.size, 0);
  });
}

for (const [search, expected] of [
  ['?wsPath=%2Ffirst&wsPath=%2Fsecond', '/first'],
  ['?wsPath=&wsPath=%2Fsecond', '/ws'],
  ['?wsPath=%2F%252Fother.test%2Fws', '/%2Fother.test/ws'],
  ['?wsPath=%2F%253Ftoken%253Dsecret%2F%2523fragment', '/%3Ftoken%3Dsecret/%23fragment'],
  ['?wsPath=+%2Ftrimmed+&room=same-room', '/trimmed'],
] as const) {
  it(`whole sample uses the first query value and decodes only the outer query: ${search}`, async t => {
    const url = page(); url.search = search;
    const h = setup(t, url, `wss://sample.test${expected}`); await flushSample(); idle(h);
    assert.equal(errorBox(h).hidden, true);
  });
}

it('whole sample uses page protocol and authority rather than host query parameters', async t => {
  const url = page('/custom/stage', 'http://127.0.0.1:4321/prefix');
  url.searchParams.set('host', 'https://untrusted.example.test');
  const h = setup(t, url, 'ws://127.0.0.1:4321/custom/stage'); await flushSample(); idle(h);
});

const invalidPaths = [
  'relative/ws', 'ws', '//other.example.test/ws', '///other.example.test/ws',
  'https://other.example.test/ws', 'wss://other.example.test/ws', 'javascript:alert(1)',
  '/\\other.example.test/ws', '\\other.example.test/ws', '/a\\b', '/ws?x=1', '/ws#fragment',
  '/a b', '/a\u00a0b', '/a\u2003b', '/.', '/..', '/a/./ws', '/a/../ws', '/a/..',
  '/%2e', '/%2E%2e', '/a/.%2E/ws', '/a/%2e./ws', '/a/%2E%2e/ws', '/a/%2e/ws',
  `/ws?token=${SECRET}`, `/ws#${SECRET}`, `/a <img src=x onerror=${SECRET}>`,
];
for (const path of invalidPaths) {
  it(`whole sample renders safely and blocks both entry forms for invalid wsPath ${JSON.stringify(path)}`, async t => {
    const h = setup(t, page(path)); await flushSample();
    assert.match(h.app.textContent, /Stage.js 音訊舞台/); idle(h);
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, PATH_ERROR);
    assert.equal(errorBox(h).children.length, 0); assert.doesNotMatch(h.app.textContent, /SYNTHETIC_SAMPLE_PATH_SECRET|<img|other\.example/);
    for (const action of ['create', 'join', 'create'] as const) { fill(h, action).submit(); await flushSample(); idle(h); }
    assert.equal(h.creates.length, 0); assert.equal(h.sdk.joins.length, 0); assert.equal(h.sdk.state, null);
    assert.equal(errorBox(h).textContent, PATH_ERROR); assert.equal(h.clock.jobs.size, 0);
  });
}

it('whole sample rejects every raw ASCII control and C1 control without trimming it into a valid path', async t => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), ...Array.from({ length: 33 }, (_, index) => index + 127)]) {
    const h = setup(t, page(`/ws${String.fromCharCode(code)}`)); await flushSample();
    for (const action of ['create', 'join'] as const) fill(h, action).submit();
    await flushSample(); assert.equal(errorBox(h).textContent, PATH_ERROR, `control ${code}`); idle(h);
    assert.equal(h.creates.length + h.sdk.joins.length, 0); assert.equal(h.clock.jobs.size, 0);
  }
});

it('whole sample rejects a query-decoded authority while leaving an encoded slash literal', async t => {
  const bad = page(); bad.search = '?wsPath=%2F%2Fother.example.test%2Fws';
  const h = setup(t, bad); assert.equal(errorBox(h).textContent, PATH_ERROR);
  const good = page(); good.search = '?wsPath=%2F%252Fother.example.test%2Fws';
  const accepted = setup(t, good, 'wss://sample.test/%2Fother.example.test/ws');
  assert.equal(errorBox(accepted).hidden, true);
});

it('whole sample does not replace an invalid first wsPath with a valid duplicate', async t => {
  const location = page(); location.search = '?wsPath=%2F%2Fother.example.test%2Fws&wsPath=%2Fvalid';
  const h = setup(t, location);
  for (const action of ['create', 'join'] as const) fill(h, action).submit();
  await flushSample(); assert.equal(errorBox(h).textContent, PATH_ERROR); idle(h);
  assert.equal(h.creates.length + h.sdk.joins.length, 0);
});

for (const [path, expected] of [[undefined, '/ws'], ['', '/ws'], [' /ws ', '/ws'],
  ['/custom/%2F/舞台/%3F%23', '/custom/%2F/%E8%88%9E%E5%8F%B0/%3F%23']] as const) {
  it(`whole sample invitation allowlist retains only the serialized nondefault path (${path ?? 'omitted'})`, async t => {
    const location = page(path, `https://sample.test/nested/stage/?token=${SECRET}&resumeToken=${SECRET}&host=https%3A%2F%2Fother.test#${SECRET}`);
    location.searchParams.set('room', 'stale-room'); location.searchParams.set('code', 'STALE42');
    const h = setup(t, location, `wss://sample.test${expected}`); await enter(h);
    const link = new URL(String(inviteLink(h).value));
    assert.equal(link.origin, location.origin); assert.equal(link.pathname, '/nested/stage/'); assert.equal(link.hash, '');
    assert.deepEqual([...link.searchParams.keys()].sort(), expected === '/ws' ? ['code', 'room'] : ['code', 'room', 'wsPath']);
    assert.equal(link.searchParams.get('wsPath'), expected === '/ws' ? null : expected);
    assert.equal(link.searchParams.get('room'), 'same-room'); assert.equal(link.searchParams.get('code'), 'OLD23456');
    assert.ok(!link.href.includes(SECRET)); assert.ok(!link.href.includes('STALE42'));
    h.button('複製邀請連結').click(); assert.equal(h.copies[0]!.text, link.href);
    h.copies[0]!.work.resolve(undefined); await flushSample(); assert.match(notices(h).textContent, /已複製邀請連結/);
    const invited = setup(t, link, `wss://sample.test${expected}`);
    assert.equal(input(form(invited, 'join'), 'roomId').value, 'same-room');
    assert.equal(input(form(invited, 'join'), 'code').value, 'OLD23456');
    input(form(invited, 'join'), 'name').value = '受邀者'; form(invited, 'join').submit();
    assert.deepEqual({ ...invited.sdk.joins[0]!.options }, { roomId: 'same-room', code: 'OLD23456', name: '受邀者' });
    invited.sdk.acceptJoin(roomState()); await flushSample();
  });
}

for (const pathname of ['//invite-destination.invalid/stage', '///invite-destination.invalid/stage', '/%2F%2Finvite-destination.invalid/stage', '//invite-destination.invalid/%3F%23']) {
  it(`whole sample keeps invitations same-origin for document pathname ${pathname}`, async t => {
    const location = page('/custom'); location.pathname = pathname;
    location.searchParams.set('token', SECRET); location.hash = SECRET;
    const h = setup(t, location, 'wss://sample.test/custom'); await enter(h);
    const link = new URL(String(inviteLink(h).value));
    assert.equal(link.origin, location.origin); assert.equal(link.pathname, location.pathname);
    assert.equal(link.hash, ''); assert.deepEqual([...link.searchParams.keys()].sort(), ['code', 'room', 'wsPath']);
    assert.ok(!link.href.includes(SECRET));
    const invited = setup(t, link, 'wss://sample.test/custom'); idle(invited);
    assert.equal(input(form(invited, 'join'), 'roomId').value, 'same-room');
  });
}

it('whole sample captures custom path once and code rotation retires pending invitation copies without losing privacy', async t => {
  const location = page('/custom/%2F'); location.searchParams.set('token', SECRET);
  const h = setup(t, location, 'wss://sample.test/custom/%2F'); await enter(h);
  h.button('複製邀請連結').click(); const retired = h.copies[0]!, oldInput = inviteLink(h);
  let staleSelections = 0; Object.assign(oldInput, { focus() { staleSelections++; }, select() { staleSelections++; } });
  location.search = '?wsPath=%2Fchanged&token=changed';
  h.button('更換房間代碼').click(); assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0]!, /舊代碼與舊邀請連結立即失效/);
  h.sdk.snapshot(controllerState('NEW23456')); h.rotations[0]!.resolve(undefined); await flushSample();
  const link = new URL(String(inviteLink(h).value));
  assert.equal(link.searchParams.get('wsPath'), '/custom/%2F'); assert.equal(link.searchParams.get('code'), 'NEW23456');
  assert.ok(!link.href.includes(SECRET)); assert.ok(!link.href.includes('changed'));
  const notice = notices(h).textContent; assert.match(notice, /已更換房間代碼/);
  retired.work.reject(new Error('retired clipboard denied')); await flushSample();
  assert.equal(notices(h).textContent, notice); assert.equal(staleSelections, 0); assert.equal(oldInput.isConnected, false);
  h.button('複製邀請連結').click(); h.copies[1]!.work.resolve(undefined); await flushSample();
  assert.equal(h.copies[1]!.text, link.href); assert.equal(errorBox(h).hidden, true);
  const invited = setup(t, link, 'wss://sample.test/custom/%2F');
  assert.equal(input(form(invited, 'join'), 'code').value, 'NEW23456');
});

it('whole sample custom-path public-room invitations omit stale code and unrelated parameters', async t => {
  const location = page('/custom'); location.searchParams.set('code', 'PRIVATE42'); location.searchParams.set('token', SECRET);
  const h = setup(t, location, 'wss://sample.test/custom');
  const state = controllerState(); state.codeRequired = false; delete state.code; await enter(h, state);
  const link = new URL(String(inviteLink(h).value));
  assert.deepEqual([...link.searchParams.keys()].sort(), ['room', 'wsPath']);
  assert.ok(!link.href.includes('PRIVATE42')); assert.ok(!link.href.includes(SECRET));
});

for (const outcome of ['resolve', 'reject'] as const) {
  it(`whole sample custom-path Leave/rejoin ignores an old invitation copy's late ${outcome}`, async t => {
    const h = setup(t, page('/custom'), 'wss://sample.test/custom'); await enter(h);
    h.button('複製邀請連結').click(); const retired = h.copies[0]!, oldInput = inviteLink(h);
    let selections = 0; Object.assign(oldInput, { focus() { selections++; }, select() { selections++; } });
    h.button('離開房間').click(); await flushSample(); idle(h); assert.equal(h.clock.jobs.size, 0);
    await enter(h); const current = inviteLink(h); assert.equal(current.value, retired.text);
    h.sdk.emit('invite', { participantId: h.sdk.me!.participantId }); const notice = notices(h).textContent;
    if (outcome === 'resolve') retired.work.resolve(undefined); else retired.work.reject(new Error('retired copy'));
    await flushSample(); assert.equal(notices(h).textContent, notice); assert.equal(selections, 0);
    assert.equal(inviteLink(h), current); assert.equal(errorBox(h).hidden, true);
  });
}

it('whole sample custom-path canceled create does not leak a retired code into a replacement room', async t => {
  const h = setup(t, page('/custom'), 'wss://sample.test/custom'); const create = fill(h, 'create');
  create.submit(); const cancel = h.id('landing-cancel'); assert.ok(cancel.onclick); const retired = cancel.onclick;
  cancel.click(); h.creates[0]!.work.resolve({ roomId: 'same-room', code: 'RETIRED' }); await flushSample(); idle(h);
  create.submit(); h.sdk.snapshot(controllerState('FRESH234')); retired();
  h.creates[1]!.work.resolve({ roomId: 'same-room', code: 'FRESH234' }); await flushSample();
  const link = new URL(String(inviteLink(h).value));
  assert.equal(link.searchParams.get('code'), 'FRESH234'); assert.equal(link.searchParams.get('wsPath'), '/custom');
  assert.doesNotMatch(h.app.textContent, /RETIRED/); assert.equal(errorBox(h).hidden, true);
});

interface ActualClient {
  readonly status: string;
  readonly state: RoomStatePayload | null;
  disconnect(): Promise<void>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
  createRoom(options: unknown): Promise<CreatedRoom>;
  join(options: unknown): Promise<void>;
}
async function bounded<T>(work: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`localhost ${phase} exceeded 2500 ms`)), 2500);
    })]);
  } finally { clearTimeout(timer); }
}
class PendingPeer {
  connectionState = 'new'; signalingState = 'stable'; localDescription = null;
  private rejectOffer: ((error: Error) => void) | undefined;
  addTransceiver() { return { direction: 'recvonly', sender: { track: null as unknown,
    async replaceTrack(track: unknown) { this.track = track; } } }; }
  // Fake browser media only: the native integration exercises real SDK/server control-plane I/O.
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  async getStats(): Promise<Map<string, unknown>> { return new Map(); }
  close(): void { this.connectionState = 'closed'; this.rejectOffer?.(new Error('fake browser peer closed')); }
}
function browserGlobals(socket: unknown) {
  const keys = ['window', 'WebSocket', 'navigator', 'RTCPeerConnection'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const target = new EventTarget();
  const peers: PendingPeer[] = [], media = { captures: 0 };
  for (const [key, value] of Object.entries({ window: target, WebSocket: socket,
    RTCPeerConnection: class extends PendingPeer { constructor() { super(); peers.push(this); } },
    navigator: { mediaDevices: { enumerateDevices: async () => [],
      getUserMedia: async () => { media.captures++; throw new Error('fake browser media; no microphone device access'); } } } })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return { target, peers, media, restore() {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

it('whole sample actual SDK never opens a socket for invalid path create or join', async t => {
  let sockets = 0;
  const globals = browserGlobals(class { constructor() { sockets++; throw new Error('invalid path attempted a socket'); } });
  const apps: ReturnType<typeof sampleApp<ActualClient>>[] = [];
  t.after(async () => {
    try { for (const h of apps) await h.cleanup(); assert.equal(getEventListeners(globals.target, 'pagehide').length, 0); }
    finally { globals.restore(); }
  });
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  for (const path of [...invalidPaths, '/ws\n', '/ws\u0085']) {
    const sdk: ActualClient = new StageClient({ url: 'wss://sample.test/ws', requestTimeoutMs: 500,
      audioElement: { volume: 1, muted: false, pause() {} } });
    const h = sampleApp({ sdk, location: page(path) }); apps.push(h);
    fill(h, 'create').submit(); fill(h, 'join').submit(); await flushSample(); idle(h);
    assert.equal(errorBox(h).textContent, PATH_ERROR); assert.equal(sdk.state, null); assert.equal(sdk.status, 'disconnected');
  }
  assert.equal(sockets, 0); assert.equal(globals.peers.length, 0); assert.equal(globals.media.captures, 0);
  assert.ok(apps.every(h => h.clock.jobs.size === 0));
});

it('whole sample actual SDK creates and joins through a native localhost custom-path server and invitation roundtrip', { timeout: 15000 }, async t => {
  const wsPath = '/custom/%E8%88%9E%E5%8F%B0/%2F%3F%23';
  const config = testConfig(c => {
    c.server.host = '127.0.0.1'; c.server.port = 0; c.server.static = []; c.server.wsPath = wsPath;
    c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 0;
  });
  // harness deliberately supplies MockMediaTransport; neither real WebRTC nor physical devices are tested here.
  const serverHarness = harness(config);
  const server = createStageServer({ config, hub: serverHarness.hub, log: silentLogger, baseDir: process.cwd() });
  const sockets: WebSocket[] = [], urls: string[] = [], apps: ReturnType<typeof sampleApp<ActualClient>>[] = [];
  const globals = browserGlobals(class extends WebSocket {
    constructor(url: string) { super(url); urls.push(url); sockets.push(this); }
  });
  t.after(async () => {
    try {
      try { await bounded(Promise.all(apps.map(h => h.cleanup())), 'sample cleanup'); }
      finally {
        for (const socket of sockets) socket.terminate();
        try { await bounded(server.close(), 'server close'); }
        finally { await bounded(serverHarness.transport.close(), 'MockMediaTransport close'); }
      }
      assert.ok(apps.every(h => h.sdk.status === 'disconnected' && h.sdk.state === null && h.clock.jobs.size === 0));
      assert.equal(getEventListeners(globals.target, 'pagehide').length, 0);
      assert.ok(globals.peers.every(peer => peer.connectionState === 'closed'));
      assert.equal(serverHarness.hub.roomCount, 0); assert.equal(serverHarness.transport.rooms.size, 0);
      assert.equal(serverHarness.timers.filter(timer => !timer.cleared).length, 0);
    } finally { globals.restore(); }
  });
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const address = await bounded(server.listen(), 'listen');
  const origin = `http://127.0.0.1:${address.port}`, sdkUrl = `ws://127.0.0.1:${address.port}${wsPath}`;
  const location = page('/custom/舞台/%2F%3F%23', `${origin}//invite-destination.invalid/stage?token=${SECRET}#${SECRET}`);
  const createResult = new Deferred<CreatedRoom>();
  const controller: ActualClient = new StageClient({ url: sdkUrl, requestTimeoutMs: 1500,
    audioElement: { volume: 1, muted: false, pause() {} } });
  const realCreate = controller.createRoom.bind(controller);
  controller.createRoom = async options => {
    try { const result = await realCreate(options); createResult.resolve(result); return result; }
    catch (error) { createResult.reject(error as Error); throw error; }
  };
  const host = sampleApp({ sdk: controller, location, expectedSdkUrl: sdkUrl }); apps.push(host);
  const creating = fill(host, 'create'); input(creating, 'token').value = ''; creating.submit();
  const created = await bounded(createResult.promise, 'sample create and ACK'); await flushSample();
  assert.equal(controller.state?.me.role, 'controller'); assert.equal(controller.state?.roomId, created.roomId);
  assert.equal(serverHarness.hub.roomCount, 1); assert.equal(errorBox(host).hidden, true);
  const link = new URL(String(inviteLink(host).value));
  assert.equal(link.origin, origin); assert.equal(link.pathname, location.pathname); assert.equal(link.hash, '');
  assert.equal(link.searchParams.get('wsPath'), wsPath); assert.equal(link.searchParams.get('room'), created.roomId);
  assert.equal(link.searchParams.get('code'), created.code); assert.ok(created.code); assert.ok(!link.href.includes(SECRET));
  assert.deepEqual([...link.searchParams.keys()].sort(), ['code', 'room', 'wsPath']);
  const joined = new Deferred<void>();
  const audience: ActualClient = new StageClient({ url: sdkUrl, requestTimeoutMs: 1500,
    audioElement: { volume: 1, muted: false, pause() {} } });
  const realJoin = audience.join.bind(audience);
  audience.join = async options => {
    try { await realJoin(options); joined.resolve(undefined); }
    catch (error) { joined.reject(error as Error); throw error; }
  };
  const guest = sampleApp({ sdk: audience, location: link, expectedSdkUrl: sdkUrl }); apps.push(guest);
  const joining = form(guest, 'join');
  assert.equal(input(joining, 'roomId').value, created.roomId); assert.equal(input(joining, 'code').value, created.code);
  input(joining, 'name').value = '受邀聽眾'; joining.submit();
  await bounded(joined.promise, 'invitation join and ACK'); await flushSample();
  assert.equal(audience.state?.roomId, created.roomId); assert.equal(audience.state?.me.role, 'audience');
  assert.equal(audience.state?.me.name, '受邀聽眾'); assert.equal(audience.state?.audienceCount, 1);
  assert.equal(errorBox(guest).hidden, true); assert.deepEqual(urls, [sdkUrl, sdkUrl]);
  guest.button('離開房間').click(); await flushSample(); idle(guest); assert.equal(guest.clock.jobs.size, 0);
  assert.equal(audience.state, null); assert.equal(audience.status, 'disconnected');
});
