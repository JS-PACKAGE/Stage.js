import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { ERROR_MESSAGES } from '../src/model/errors.ts';
import { parseClientMessage, ValidationError } from '../src/ws/validate.ts';
import { actualApp, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { flushSample, SampleNode, sampleApp } from './fixtures/sampleApp.ts';
import { FakeSession, harness, testConfig } from './helpers.ts';

type Action = 'create' | 'join';
type Entry = Extract<ClientMessage, { type: 'room:create' | 'join' }>;
type Rename = Extract<ClientMessage, { type: 'participant:rename' }>;
type SampleView = Pick<ReturnType<typeof sampleApp>, 'find'>;
function entryForm(h: SampleView, action: Action) {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2'
    && child.textContent === (action === 'create' ? '建立房間' : '加入房間')));
  return { form,
    input(name: string): SampleNode {
      const node = form.descendants().find(node => node.tagName === 'input' && node.name === name); assert.ok(node); return node;
    },
    submit: form.descendants().find(node => node.tagName === 'button' && node.type === 'submit')!,
  };
}
const errorBox = (h: SampleView) => h.find(node => node.attributes.role === 'alert');
const unicodeCases = [
  { label: '32 supplementary-plane emoji', raw: '🐱'.repeat(32), accepted: '🐱'.repeat(32) },
  { label: '32 decomposed accented letters', raw: 'e\u0301'.repeat(32), accepted: 'é'.repeat(32) },
];

it('four name controls omit authored maxlength while required flags and fixed ID/token caps stay intact', async t => {
  assert.equal(new SampleNode('input').maxLength, -1, 'the fixture represents the unset native property, not browser editing');
  const h = sampleApp(); t.after(() => h.cleanup());
  const create = entryForm(h, 'create'), join = entryForm(h, 'join');
  for (const [input, required] of [[create.input('name'), true], [create.input('roomName'), false], [join.input('name'), true]] as const) {
    assert.equal(input.maxLength, -1); assert.equal(input.required, required);
    assert.equal(input.attributes.maxlength, undefined); assert.equal(input.attributes.maxLength, undefined);
  }
  for (const [input, cap, required] of [[create.input('token'), 256, false], [join.input('roomId'), 128, true], [join.input('code'), -1, false]] as const) {
    assert.equal(input.maxLength, cap); assert.equal(input.required, required);
  }
  assert.equal(create.input('token').type, 'password');
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const input = (id: string): string => {
    const tags = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).filter(tag => tag.includes(`id="${id}"`));
    assert.equal(tags.length, 1); return tags[0]!;
  };
  assert.doesNotMatch(input('name'), /\bmaxlength\s*=/i); assert.match(input('name'), /\brequired\b/);
  assert.match(input('room'), /\brequired\b/); assert.match(input('room'), /\bmaxlength="128"/);
  assert.doesNotMatch(input('code'), /\bmaxlength\s*=/i); assert.doesNotMatch(input('code'), /\brequired\b/);
  // The embed fixtures execute the script but do not parse HTML or model native input editing.
});

function server(t: TestContext, nameMaxLength = 32) {
  // Keep the SDK queue deterministic and fast; rate-limit behavior has separate coverage.
  const config = testConfig(value => { value.limits.nameMaxLength = nameMaxLength; value.limits.controlPerSecond = 2000; value.rooms.qualityIntervalMs = 0; });
  const h = harness(config);
  t.after(async () => {
    await h.hub.shutdown(); await h.transport.close();
    assert.equal(h.hub.roomCount, 0); assert.equal(h.transport.rooms.size, 0);
    assert.equal(h.timers.filter(timer => !timer.cleared).length, 0);
  });
  const sessions = new Map<StageSocket, FakeSession>();
  return { ...h,
    attach(socket: StageSocket): FakeSession {
      const existing = sessions.get(socket); if (existing) return existing;
      const session = new FakeSession(); sessions.set(socket, session); h.hub.attach(session);
      const hello = session.last('hello'); assert.ok(hello); socket.deliver(hello); return session;
    },
    async accept(socket: StageSocket, request: Entry | Rename) {
      const session = sessions.get(socket); assert.ok(session);
      const parsed = parseClientMessage(JSON.stringify(request), config.limits);
      const before = session.inbox.length; await h.hub.handle(session, parsed);
      for (const timer of h.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); }
      const replies = session.inbox.slice(before);
      assert.ok(replies.some(message => message.type === 'ok' && message.requestId === request.requestId));
      assert.ok(!replies.some(message => message.type === 'error'));
      return { parsed, replies, state: session.last('room:state')! };
    },
    reject(socket: StageSocket, request: Entry | Rename): void {
      const session = sessions.get(socket); assert.ok(session); const before = session.inbox.length;
      assert.throws(() => parseClientMessage(JSON.stringify(request), config.limits), error => {
        assert.ok(error instanceof ValidationError); assert.equal(error.code, 'bad_request'); assert.equal(error.requestId, request.requestId);
        socket.deliver({ type: 'error', requestId: error.requestId, code: error.code, message: ERROR_MESSAGES[error.code] }); return true;
      });
      assert.equal(session.inbox.length, before, 'invalid wire input cannot reach the Hub or mutate room state');
    },
  };
}
function deliver(socket: StageSocket, replies: ServerMessage[]): void { for (const reply of replies) socket.deliver(reply); }
interface SampleClient {
  readonly state: RoomStatePayload | null;
  readonly status: string;
  disconnect(): Promise<void>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
async function actualSample(t: TestContext) {
  const { StageClient, decodeName } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  StageSocket.instances = []; StagePeer.instances = [];
  const globals = { window: new EventTarget(), WebSocket: StageSocket, RTCPeerConnection: StagePeer,
    navigator: { mediaDevices: { enumerateDevices: async () => [] } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 1000; t.mock.method(performance, 'now', () => now);
  const sdk: SampleClient = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    audioElement: { volume: 1, muted: false, pause() {}, async play() {} } });
  const errors: unknown[] = []; sdk.on('error', ({ detail }) => errors.push(detail));
  const h = sampleApp({ sdk, decodeName });
  t.after(async () => {
    try {
      await h.cleanup(); assert.equal(sdk.status, 'disconnected'); assert.equal(sdk.state, null);
      assert.ok(StageSocket.instances.every(socket => socket.readyState === 3));
      assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'));
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const until = async (predicate: () => boolean): Promise<void> => {
    for (let count = 0; count < 80 && !predicate(); count++) { now++; t.mock.timers.tick(1); await flushSample(); }
    assert.ok(predicate(), 'actual SDK request must reach the socket');
  };
  return { ...h, errors,
    async submit(action: Action, wire: ReturnType<typeof server>) {
      const type = action === 'create' ? 'room:create' : 'join';
      const before = StageSocket.instances.reduce((sum, socket) => sum + socket.sent.filter(message => message.type === type).length, 0);
      const form = entryForm(h, action); form.form.submit(); assert.equal(form.submit.disabled, true);
      await flushSample(); const socket = StageSocket.instances.at(-1)!; assert.ok(socket); wire.attach(socket);
      await until(() => StageSocket.instances.reduce((sum, item) => sum + item.sent.filter(message => message.type === type).length, 0) === before + 1);
      const request = socket.sent.filter((message): message is Entry => message.type === type).at(-1)!;
      return { socket, request, form };
    },
  };
}

for (const sample of unicodeCases) for (const action of ['create', 'join'] as const) {
  it(`whole sample ${action} sends ${sample.label} unchanged to the default validator and Hub`, async t => {
    assert.equal(sample.raw.length, 64); assert.equal([...sample.accepted].length, 32);
    const wire = server(t), h = await actualSample(t), form = entryForm(h, action);
    form.input('name').value = `  ${sample.raw}  `;
    if (action === 'create') form.input('roomName').value = `  ${sample.raw}  `;
    else {
      const host = await wire.create(); form.input('roomId').value = `  ${host.roomId}  `; form.input('code').value = `  ${host.code}  `;
    }
    const { socket, request } = await h.submit(action, wire);
    assert.equal(request.name, sample.raw, 'preserve entry trim without client NFC normalization or truncation');
    if (request.type === 'room:create') assert.equal(request.roomName, sample.raw);
    const result = await wire.accept(socket, request); assert.equal(result.state.me.name, sample.accepted);
    if (action === 'create') assert.equal(result.state.name, sample.accepted);
    assert.equal(h.sdk.state, null, 'only a server snapshot publishes an accepted name');
    deliver(socket, result.replies); await flushSample();
    assert.equal((h.sdk.state as RoomStatePayload | null)?.me.name, sample.accepted); assert.equal(form.input('name').value, `  ${sample.raw}  `);
    assert.equal(errorBox(h).hidden, true); assert.deepEqual(h.errors, []);
  });
}

for (const nameMaxLength of [8, 64]) for (const action of ['create', 'join'] as const) {
  it(`whole sample ${action} obeys server limit ${nameMaxLength}, reports generic over-limit errors and retries without shortening drafts`, async t => {
    const wire = server(t, nameMaxLength), h = await actualSample(t), form = entryForm(h, action);
    const accepted = '🐱'.repeat(nameMaxLength), over = accepted + '🐱';
    if (action === 'join') {
      const host = await wire.create(); form.input('roomId').value = host.roomId; form.input('code').value = host.code;
    }
    const names = action === 'create' ? ['name', 'roomName'] : ['name'];
    for (const name of names) {
      form.input('name').value = 'Valid'; if (action === 'create') form.input('roomName').value = 'Valid';
      form.input(name).value = `  ${over}  `;
      const { socket, request } = await h.submit(action, wire);
      assert.equal(name === 'roomName' && request.type === 'room:create' ? request.roomName : request.name, over);
      wire.reject(socket, request); await flushSample();
      assert.equal(form.submit.disabled, false); assert.equal(form.input(name).value, `  ${over}  `);
      assert.equal(h.sdk.state, null); assert.ok(errorBox(h).textContent.startsWith('Bad request'));
      assert.ok(!errorBox(h).textContent.includes(over)); assert.doesNotMatch(errorBox(h).textContent, /\d|最多|上限|超過/);
      const error = h.errors.at(-1); assert.ok(error instanceof Error); assert.equal(error.message, 'Bad request');
      assert.equal((error as Error & { code: string }).code, 'bad_request');
    }
    form.input('name').value = accepted; if (action === 'create') form.input('roomName').value = accepted;
    const { socket, request } = await h.submit(action, wire); assert.equal(request.name, accepted);
    const result = await wire.accept(socket, request); deliver(socket, result.replies); await flushSample();
    assert.equal(h.sdk.state?.me.name, accepted); if (action === 'create') assert.equal(h.sdk.state?.name, accepted);
    assert.equal(errorBox(h).hidden, true);
  });
}

async function submitEmbed(h: Awaited<ReturnType<typeof actualApp>>, wire: ReturnType<typeof server>) {
  h.form.submit(); await flushSample(); const socket = StageSocket.instances.at(-1)!; assert.ok(socket); wire.attach(socket);
  await h.until(() => socket.sent.some(message => message.type === 'join'), 'actual public SDK join');
  const request = socket.sent.find((message): message is Extract<Entry, { type: 'join' }> => message.type === 'join')!;
  return { socket, request };
}
async function renameEmbed(h: Awaited<ReturnType<typeof actualApp>>, socket: StageSocket, raw: string) {
  const count = socket.sent.filter(message => message.type === 'participant:rename').length;
  h.node('name').value = raw; h.node('rename').click();
  await h.until(() => socket.sent.filter(message => message.type === 'participant:rename').length === count + 1, 'actual public SDK rename');
  return socket.sent.filter((message): message is Rename => message.type === 'participant:rename').at(-1)!;
}
for (const sample of unicodeCases) {
  it(`whole embed shares an uncapped join/rename draft for ${sample.label} with authoritative snapshots and pending ownership`, async t => {
    const wire = server(t), host = await wire.create(), h = await actualApp(t);
    const field = h.node('name'); field.value = `  ${sample.raw}  `;
    h.node('room').value = `  ${host.roomId}  `; h.node('code').value = `  ${host.code}  `;
    const { socket, request } = await submitEmbed(h, wire);
    assert.equal(request.name, sample.raw); assert.equal(request.roomId, host.roomId); assert.equal(request.code, host.code);
    const joined = await wire.accept(socket, request); deliver(socket, joined.replies); await flushSample();
    assert.equal(h.clients[0]!.me!.name, sample.accepted); assert.equal(field.value, `  ${sample.raw}  `);
    const rename = await renameEmbed(h, socket, `  ${sample.raw}  `); assert.equal(rename.name, `  ${sample.raw}  `);
    const result = await wire.accept(socket, rename), next = `  Next ${sample.raw}  `; field.value = next;
    deliver(socket, result.replies.filter(message => message.type !== 'ok')); await flushSample();
    assert.equal(h.clients[0]!.me!.name, sample.accepted); assert.equal(field.value, next);
    assert.equal(h.node('name'), field); assert.equal(h.node('rename').attributes['aria-busy'], 'true');
    h.node('rename').click(); assert.equal(socket.sent.filter(message => message.type === 'participant:rename').length, 1);
    deliver(socket, result.replies.filter(message => message.type === 'ok')); await flushSample();
    assert.equal(h.node('rename').disabled, false); assert.equal(h.node('rename').attributes['aria-busy'], 'false');
    assert.equal(field.value, next); assert.equal(h.captures.length, 0);
  });
}
for (const nameMaxLength of [8, 64]) {
  it(`whole embed join and explicit rename obey server limit ${nameMaxLength} and retain over-limit drafts for retry`, async t => {
    const wire = server(t, nameMaxLength), host = await wire.create(), h = await actualApp(t);
    const accepted = '🐱'.repeat(nameMaxLength), over = accepted + '🐱', field = h.node('name');
    h.node('room').value = host.roomId; h.node('code').value = host.code; field.value = over;
    const rejectedJoin = await submitEmbed(h, wire); assert.equal(rejectedJoin.request.name, over);
    wire.reject(rejectedJoin.socket, rejectedJoin.request); await flushSample();
    assert.equal(h.status.textContent, 'Bad request'); assert.equal(field.value, over); assert.equal(h.form.submitButton!.disabled, false);
    field.value = accepted; const { socket, request } = await submitEmbed(h, wire); assert.equal(request.name, accepted);
    const joined = await wire.accept(socket, request); deliver(socket, joined.replies); await flushSample();
    assert.equal(h.clients.at(-1)!.me!.name, accepted);
    const rejectedRename = await renameEmbed(h, socket, `  ${over}  `); assert.equal(rejectedRename.name, `  ${over}  `);
    wire.reject(socket, rejectedRename); await flushSample();
    assert.equal(h.status.textContent, 'Bad request'); assert.equal(field.value, `  ${over}  `);
    assert.equal(h.clients.at(-1)!.me!.name, accepted); assert.equal(h.node('rename').disabled, false);
    const retry = await renameEmbed(h, socket, `  ${accepted}  `); assert.equal(retry.name, `  ${accepted}  `);
    const result = await wire.accept(socket, retry); deliver(socket, result.replies); await flushSample();
    assert.equal(h.clients.at(-1)!.me!.name, accepted); assert.equal(field.value, `  ${accepted}  `);
    assert.equal(h.node('rename').disabled, false); assert.equal(h.captures.length, 0);
  });
}
