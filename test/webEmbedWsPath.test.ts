import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import type { RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import { Deferred, EmbedNode, embedApp, flush } from './fixtures/embedApp.ts';
import { harness, testConfig } from './helpers.ts';

const query = (path?: string, host = 'https://stage.example.test/prefix?unused=1#fragment'): string => {
  const params = new URLSearchParams({ host, room: 'same-room', code: 'TEST42' });
  if (path !== undefined) params.set('wsPath', path);
  return `?${params}`;
};
function idle(h: ReturnType<typeof embedApp>): void {
  assert.equal(h.submit.disabled, false); assert.equal(h.submit.attributes['aria-busy'], 'false');
  assert.equal(h.node('cancel-join').hidden, true); assert.equal(h.node('cancel-join').disabled, true);
}

it('embed provides an optional labeled text input for its WebSocket path', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const field = html.match(/<label\b[^>]*>[^<]*<input\b[^>]*\bid="ws-path"[^>]*><\/label>/)?.[0];
  assert.ok(field, 'the path needs a native label');
  assert.equal(field.match(/\btype="([^"]+)"/)?.[1] ?? 'text', 'text');
  assert.doesNotMatch(field, /\brequired\b/);
});

for (const [label, path, expected] of [
  ['omitted', undefined, '/ws'], ['blank', '', '/ws'], ['spaces only', '   ', '/ws'],
  ['custom', '/custom/stage', '/custom/stage'], ['root', '/', '/'],
  ['encoded separators', '/%2F%2fother.test/%5C%3F%23', '/%2F%2fother.test/%5C%3F%23'],
  ['encoded percent', '/%252e%252e/%252F', '/%252e%252e/%252F'],
  ['ordinary dots', '/v1.2/stage.../..name', '/v1.2/stage.../..name'],
  ['Unicode', '/舞台/音訊', '/%E8%88%9E%E5%8F%B0/%E9%9F%B3%E8%A8%8A'],
] as const) {
  it(`whole embed uses ${label} wsPath with one outer query decode and the unchanged module origin`, async t => {
    const h = embedApp({ search: query(path) }); t.after(() => h.cleanup());
    assert.equal(h.node('ws-path').value, path ?? '/ws');
    const sdk = await h.join();
    assert.equal(sdk.options.url, `wss://stage.example.test${expected}`);
    assert.deepEqual(h.moduleUrls, ['https://stage.example.test/lib/stage-client.js']); idle(h);
  });
}

it('whole embed honors the first duplicate wsPath query value and a later manual override', async t => {
  const h = embedApp({ search: `${query('/first')}&wsPath=%2Fsecond` }); t.after(() => h.cleanup());
  assert.equal(h.node('ws-path').value, '/first');
  h.node('ws-path').value = '/manual/stage'; h.node('host').value = 'http://127.0.0.1:4321/ignored';
  assert.equal((await h.join()).options.url, 'ws://127.0.0.1:4321/manual/stage');
  assert.deepEqual(h.moduleUrls, ['http://127.0.0.1:4321/lib/stage-client.js']);
});

const invalidPaths = [
  'relative/ws', 'ws', '//other.example.test/ws', '///other.example.test/ws',
  'https://other.example.test/ws', 'wss://other.example.test/ws', 'javascript:alert(1)',
  '/\\other.example.test/ws', '\\other.example.test/ws', '/a\\b', '/ws?x=1', '/ws#fragment',
  '/a b', '/.', '/..', '/a/./ws', '/a/../ws', '/a/..', '/%2e', '/%2E%2e',
  '/a/.%2E/ws', '/a/%2e./ws', '/a/%2E%2e/ws', '/a/%2e/ws',
];
for (const path of invalidPaths) {
  it(`whole embed rejects unsafe path ${JSON.stringify(path)} before loading a module or creating a client`, async t => {
    const h = embedApp({ search: query(path) }); t.after(() => h.cleanup());
    h.form.submit(); await flush();
    assert.equal(h.moduleUrls.length, 0); assert.equal(h.clients.length, 0);
    assert.match(h.status.textContent, /路徑/); idle(h);
  });
}

it('whole embed rejects every raw ASCII control in wsPath, including controls removed by URL parsing', async t => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    const h = embedApp({ search: query(`/ws${String.fromCharCode(code)}`) }); t.after(() => h.cleanup());
    h.form.submit(); await flush();
    assert.equal(h.moduleUrls.length, 0, `control ${code} must not import`);
    assert.equal(h.clients.length, 0); assert.match(h.status.textContent, /路徑/); idle(h);
  }
});

it('whole embed rejects a query-decoded authority but keeps percent-encoded slash path bytes', async t => {
  const bad = embedApp({ search: '?wsPath=%2F%2Fother.example.test%2Fws' }); t.after(() => bad.cleanup());
  assert.equal(bad.node('ws-path').value, '//other.example.test/ws'); bad.form.submit(); await flush();
  assert.equal(bad.moduleUrls.length, 0); assert.equal(bad.clients.length, 0); idle(bad);
  const good = embedApp({ search: '?wsPath=%2F%252Fother.example.test%2Fws' }); t.after(() => good.cleanup());
  assert.equal(good.node('ws-path').value, '/%2Fother.example.test/ws');
  assert.equal((await good.join()).options.url, 'wss://embed.example.test/%2Fother.example.test/ws');
});

it('whole embed recovers from invalid path input using the corrected path on retry', async t => {
  const h = embedApp({ search: query('//other.example.test/ws') }); t.after(() => h.cleanup());
  h.form.submit(); await flush(); assert.equal(h.moduleUrls.length, 0); idle(h);
  h.node('ws-path').value = '/fixed/stage';
  assert.equal((await h.join()).options.url, 'wss://stage.example.test/fixed/stage');
  assert.equal(h.moduleUrls.length, 1); idle(h);
});

it('whole embed captures host and path before a pending prior disconnect and module import', async t => {
  const gates = [new Deferred(), new Deferred()];
  const h = embedApp({ search: query('/first'), libraryLoad: async (_url, attempt) => gates[attempt - 1]!.promise });
  t.after(async () => { for (const gate of gates) if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  h.form.submit(); await flush(); gates[0]!.resolve(); await flush();
  const old = h.clients[0]!; old.snapshot();
  const disconnect = new Deferred(), original = old.disconnect.bind(old);
  old.disconnect = async () => { await disconnect.promise; await original(); };
  t.after(async () => { if (!disconnect.settled) disconnect.resolve(); await flush(); });
  h.node('host').value = 'http://127.0.0.1:4321/initial'; h.node('ws-path').value = '/captured';
  h.form.submit();
  h.node('host').value = 'https://changed.example.test'; h.node('ws-path').value = '/changed-before-import';
  await flush(); assert.equal(h.moduleUrls.length, 1);
  disconnect.resolve(); await flush();
  assert.equal(h.moduleUrls[1], 'http://127.0.0.1:4321/lib/stage-client.js');
  h.node('host').value = 'https://changed-again.example.test'; h.node('ws-path').value = '//bad.example.test';
  gates[1]!.resolve(); await flush();
  assert.equal(h.clients.length, 2); assert.equal(h.clients[1]!.options.url, 'ws://127.0.0.1:4321/captured'); idle(h);
});

it('whole embed reports import failure, releases controls, and captures changed path on retry', async t => {
  const failed = new Deferred();
  const h = embedApp({ search: query('/failed'), libraryLoad: async (_url, attempt) => { if (attempt === 1) await failed.promise; } });
  t.after(() => h.cleanup());
  h.form.submit(); await flush(); failed.reject('舞台元件載入失敗。'); await flush();
  assert.equal(h.status.textContent, '舞台元件載入失敗。'); assert.equal(h.clients.length, 0); idle(h);
  h.node('ws-path').value = '/retried';
  assert.equal((await h.join()).options.url, 'wss://stage.example.test/retried');
  assert.deepEqual(h.moduleUrls, Array(2).fill('https://stage.example.test/lib/stage-client.js')); idle(h);
});

for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed ignores a cancelled path import's late ${settlement} after a replacement joins`, async t => {
    const retired = new Deferred();
    const h = embedApp({ search: query('/retired'), libraryLoad: async (_url, attempt) => { if (attempt === 1) await retired.promise; } });
    t.after(async () => { if (!retired.settled) retired.resolve(); await flush(); await h.cleanup(); });
    h.form.submit(); await flush(); h.node('cancel-join').click(); await flush();
    assert.equal(h.status.textContent, '已取消連線。'); assert.equal(h.clients.length, 0); idle(h);
    h.node('ws-path').value = '/replacement'; const sdk = await h.join(), status = h.status.textContent;
    assert.equal(sdk.options.url, 'wss://stage.example.test/replacement');
    if (settlement === 'resolve') retired.resolve(); else retired.reject('retired import failure');
    await flush(); assert.equal(h.clients.length, 1); assert.equal(h.status.textContent, status); idle(h);
  });
}

interface ActualClient {
  readonly status: string;
  readonly state: RoomStatePayload | null;
  disconnect(): Promise<void>;
}
async function bounded<T>(work: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`localhost ${phase} exceeded 2000 ms`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
class PendingPeer {
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = null;
  private rejectOffer: ((error: Error) => void) | undefined;
  addTransceiver() { return { direction: 'recvonly', sender: { track: null, async replaceTrack() {} } }; }
  // The integration proves real control-plane routing; normal SDK cleanup retires fake browser media.
  createOffer(): Promise<never> { return new Promise((_resolve, reject) => { this.rejectOffer = reject; }); }
  close(): void { this.connectionState = 'closed'; this.rejectOffer?.(new Error('test peer closed')); }
}

for (const wsPath of ['/custom/stage', '/ws']) {
  it(`whole embed actual SDK joins a room created through a localhost server configured for ${wsPath}`, { timeout: 10000 }, async t => {
    const config = testConfig(c => {
      c.server.host = '127.0.0.1'; c.server.port = 0; c.server.static = []; c.server.wsPath = wsPath;
      c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 0;
    });
    const h = harness(config), server = createStageServer({ config, hub: h.hub, log: silentLogger, baseDir: process.cwd() });
    const clients: ActualClient[] = [], sockets: WebSocket[] = [], moduleUrls: string[] = [];
    const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let host: WebSocket | undefined;
    t.after(async () => {
      try {
        try { await bounded(Promise.all(clients.map(client => client.disconnect())), 'client disconnect'); }
        finally {
          host?.terminate(); for (const socket of sockets) socket.terminate();
          try { await bounded(server.close(), 'server close'); }
          finally { await bounded(h.transport.close(), 'transport close'); }
        }
        await flush();
        assert.ok(clients.every(client => client.status === 'disconnected' && client.state === null));
        assert.equal(h.hub.roomCount, 0); assert.equal(h.transport.rooms.size, 0);
        assert.equal(h.timers.filter(timer => !timer.cleared).length, 0);
      } finally {
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
        }
      }
    });
    const address = await bounded(server.listen(), 'listen'), origin = `http://127.0.0.1:${address.port}`, url = `ws://127.0.0.1:${address.port}${wsPath}`;
    host = new WebSocket(url);
    const created = Promise.withResolvers<RoomStatePayload>(), acknowledged = Promise.withResolvers<void>();
    host.on('message', data => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === 'room:state') created.resolve(message);
      if (message.type === 'ok' && message.requestId === 'create') acknowledged.resolve();
      if (message.type === 'error') { created.reject(new Error(message.message)); acknowledged.reject(new Error(message.message)); }
    });
    await bounded(once(host, 'open'), 'host open');
    host.send(JSON.stringify({ type: 'room:create', requestId: 'create', name: '主控', roomName: '路徑測試', codeRequired: false }));
    const [room] = await bounded(Promise.all([created.promise, acknowledged.promise]), 'room create and ACK');
    assert.equal(room.me.role, 'controller'); assert.equal(h.hub.roomCount, 1);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: PendingPeer });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class extends WebSocket {
      constructor(target: string) { assert.equal(target, url, 'embed must select the configured path'); super(target); sockets.push(this); }
    } });
    const { StageClient, decodeName } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
    const joined = Promise.withResolvers<RoomStatePayload>();
    const nodes = new Map(['host', 'ws-path', 'room', 'code', 'name', 'status', 'room-occupancy', 'own-connection-quality', 'speaking-summary', 'public-roster', 'public-roster-summary', 'public-roster-notice', 'public-roster-list', 'connection-stats-panel', 'connection-stats-update', 'connection-stats-text', 'hand-rejected', 'error-notice', 'last-error', 'error-dismiss', 'join', 'hand', 'mic', 'rename', 'room-name-panel', 'room-name-current', 'room-name-draft', 'room-name-update', 'hand-queue', 'hand-queue-summary', 'hand-queue-notice', 'hand-queue-search', 'hand-queue-clear', 'hand-queue-results', 'hand-queue-list', 'stage-management', 'stage-management-summary', 'stage-management-notice', 'stage-management-list', 'stage', 'mic-retry', 'audio-retry', 'audio-retry-status', 'microphone-panel', 'microphone-device', 'microphone-refresh', 'microphone-apply', 'microphone-draft-notice', 'mic-test-panel', 'mic-test-start', 'mic-test-cancel', 'mic-test-stop', 'mic-test-meter', 'mic-test-status', 'mic-test-notice', 'output-panel', 'output-device', 'output-refresh', 'output-apply', 'output-draft-notice', 'output-support', 'cancel-join', 'leave', 'close-room', 'audio', 'unlock'].map(id => [id, new EmbedNode()]));
    const node = (id: string): EmbedNode => { const value = nodes.get(id); assert.ok(value, `unmodeled node: ${id}`); return value; };
    node('public-roster').append(node('public-roster-summary'), node('public-roster-notice'), node('public-roster-list'));
    node('public-roster').hidden = true;
    node('connection-stats-panel').append(node('connection-stats-update'), node('connection-stats-text'));
    node('mic-test-panel').append(...['mic-test-start', 'mic-test-cancel', 'mic-test-stop', 'mic-test-meter', 'mic-test-status', 'mic-test-notice'].map(node));
    node('error-notice').hidden = true; node('hand-rejected').hidden = true; node('room-occupancy').hidden = true; node('own-connection-quality').hidden = true; node('speaking-summary').hidden = true;
    node('join').submitButton = new EmbedNode(); node('name').value = '嵌入聽眾';
    Object.assign(node('audio'), { pause() {} });
    const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
    const seam = 'import(/* @vite-ignore */ moduleUrl)';
    assert.equal(source.split(seam).length, 2); assert.equal(source.split("import './styles.css';").length, 2);
    const executable = stripTypeScriptTypes(source.replace("import './styles.css';", '').replace(seam, 'loadLibrary(moduleUrl)'));
    assert.doesNotMatch(executable, /\bimport\s*(?:\(|['"])/, 'no HTTP module import or remote host is used');
    const params = new URLSearchParams({ host: `${origin}/ignored`, room: room.roomId });
    if (wsPath !== '/ws') params.set('wsPath', wsPath);
    const pageDocument = Object.assign(new EventTarget(), { hidden: false, createElement(tag: string) { assert.ok(['option', 'li'].includes(tag), `unmodeled element: ${tag}`); return new EmbedNode(); }, querySelector(selector: string) { assert.match(selector, /^#[a-z-]+$/); return node(selector.slice(1)); } });
    const pageWindow = Reflect.get(globalThis, 'window') as EventTarget;
    runInNewContext(executable, {
      document: pageDocument, window: pageWindow, AbortController,
      location: { search: `?${params}`, origin }, URL, URLSearchParams, Error, Promise, performance, setTimeout, clearTimeout,
      loadLibrary: async (moduleUrl: string) => {
        moduleUrls.push(moduleUrl); assert.equal(moduleUrl, `${origin}/lib/stage-client.js`);
        return { decodeName, StageClient: function (options: unknown): ActualClient {
          const client = new StageClient(options); clients.push(client);
          client.on('state', (event: { detail: RoomStatePayload }) => joined.resolve(event.detail));
          client.on('error', (event: { detail: Error }) => joined.reject(event.detail));
          return client;
        } };
      },
    }, { filename: 'web/src/embed.ts', timeout: 1000 });
    assert.equal(node('ws-path').value, wsPath); node('join').submit();
    const state = await bounded(joined.promise, 'embed join'); await flush();
    assert.equal(state.roomId, room.roomId); assert.equal(state.me.role, 'audience');
    assert.equal(state.me.name, '嵌入聽眾'); assert.equal(state.audienceCount, 1);
    assert.equal(node('status').textContent, '路徑測試 · 嵌入聽眾 · 收聽中');
    assert.equal(clients.length, 1); assert.equal(sockets.length, 1);
    assert.deepEqual(moduleUrls, [`${origin}/lib/stage-client.js`]);
  });
}
