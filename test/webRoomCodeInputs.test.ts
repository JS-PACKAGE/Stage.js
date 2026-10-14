import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ClientMessage, ParticipantView, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { parseConfig } from '../src/config.ts';
import { ERROR_MESSAGES } from '../src/model/errors.ts';
import { parseClientMessage, ValidationError } from '../src/ws/validate.ts';
import { actualApp, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { flushSample, SampleNode, sampleApp } from './fixtures/sampleApp.ts';
import { FakeSession, harness, testConfig } from './helpers.ts';

type Join = Extract<ClientMessage, { type: 'join' }>;
type Surface = 'full sample' | 'embed';
type SampleView = Pick<ReturnType<typeof sampleApp>, 'find'>;
function joinForm(h: SampleView) {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  return { form,
    input(name: string): SampleNode {
      const node = form.descendants().find(node => node.tagName === 'input' && node.name === name); assert.ok(node); return node;
    },
    submitButton: form.descendants().find(node => node.tagName === 'button' && node.type === 'submit')!,
  };
}

it('both room-code controls omit authored maxlength and remain optional', async t => {
  const h = sampleApp(); t.after(() => h.cleanup());
  const code = joinForm(h).input('code');
  assert.equal(code.maxLength, -1); assert.equal(code.required, false);
  assert.equal(code.attributes.maxlength, undefined); assert.equal(code.attributes.maxLength, undefined);
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  const tags = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).filter(tag => /\bid="code"/.test(tag));
  assert.equal(tags.length, 1); assert.doesNotMatch(tags[0]!, /\bmaxlength\s*=/i); assert.doesNotMatch(tags[0]!, /\brequired\b/i);
  // This is the authored-control regression. Direct .value assignment (including query prefill)
  // did not truncate under the old cap; the bounded fixtures do not model keyboard or paste.
});

function server(t: TestContext, length?: number) {
  const config = parseConfig(testConfig(value => {
    if (length !== undefined) { value.rooms.codeLength = length; value.limits.codeMaxLength = length; }
    value.limits.controlPerSecond = 2000; value.rooms.qualityIntervalMs = 0;
  }));
  const h = harness(config), sessions = new Map<StageSocket, FakeSession>();
  t.after(async () => {
    await h.hub.shutdown(); await h.transport.close();
    assert.equal(h.hub.roomCount, 0); assert.equal(h.transport.rooms.size, 0);
    assert.equal(h.timers.filter(timer => !timer.cleared).length, 0);
  });
  return { ...h, config,
    attach(socket: StageSocket): void {
      if (sessions.has(socket)) return;
      const session = new FakeSession(); sessions.set(socket, session); h.hub.attach(session);
      const hello = session.last('hello'); assert.ok(hello); socket.deliver(hello);
    },
    async process(socket: StageSocket, request: Join) {
      const session = sessions.get(socket); assert.ok(session);
      const before = session.inbox.length, metricsBefore = h.hub.metrics();
      let parsed: Join;
      try {
        const message = parseClientMessage(JSON.stringify(request), config.limits);
        assert.equal(message.type, 'join'); parsed = message as Join;
      } catch (error) {
        assert.ok(error instanceof ValidationError); assert.equal(error.code, 'bad_request'); assert.equal(error.requestId, request.requestId);
        assert.equal(session.inbox.length, before); assert.deepEqual(h.hub.metrics(), metricsBefore, 'invalid wire input never reaches the Hub');
        // Mirror the production WebSocket boundary's fixed public error, never its internal detail.
        const reply: ServerMessage = { type: 'error', requestId: error.requestId, code: error.code, message: ERROR_MESSAGES[error.code] };
        return { parsed: undefined, replies: [reply], state: undefined };
      }
      await h.hub.handle(session, parsed);
      for (const timer of h.timers.filter(timer => !timer.cleared && timer.ms === 0)) { timer.cleared = true; timer.fn(); }
      const replies = session.inbox.slice(before);
      if (replies.some(reply => reply.type === 'error')) assert.deepEqual(h.hub.metrics(), metricsBefore, 'rejected entry does not allocate a participant');
      return { parsed, replies, state: session.last('room:state') };
    },
  };
}
interface PublicClient {
  readonly me: ParticipantView | null;
  readonly state: RoomStatePayload | null;
  readonly status: string;
  disconnect(): Promise<void>;
  on(type: string, listener: (event: { detail: unknown }) => void): () => void;
}
async function actualSample(t: TestContext, search: string) {
  const { StageClient, decodeName } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  StageSocket.instances = []; StagePeer.instances = [];
  const globals = { window: new EventTarget(), WebSocket: StageSocket, RTCPeerConnection: StagePeer,
    navigator: { mediaDevices: { enumerateDevices: async () => [] } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 1000; t.mock.method(performance, 'now', () => now);
  const sdk: PublicClient = new StageClient({ url: 'ws://localhost/ws', requestTimeoutMs: 1000,
    audioElement: { volume: 1, muted: false, pause() {}, async play() {} } });
  const h = sampleApp({ sdk, decodeName, location: new URL(`https://sample.test/${search}`) });
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
  return { ...h, async until(predicate: () => boolean, label: string): Promise<void> {
    for (let count = 0; count < 80 && !predicate(); count++) { now++; t.mock.timers.tick(1); await flushSample(); }
    assert.ok(predicate(), label);
  } };
}
async function actualUi(t: TestContext, surface: Surface, search = '') {
  const view = surface === 'embed' ? await (async () => {
    const h = await actualApp(t, { search });
    return { input: (name: string) => h.node(name === 'roomId' ? 'room' : name),
      form: h.form, submitButton: h.form.submitButton!, cancel: () => h.node('cancel-join').click(),
      message: () => h.status.textContent, current: () => h.clients.at(-1), until: h.until };
  })() : await (async () => {
    const h = await actualSample(t, search), form = joinForm(h);
    return { ...form, cancel: () => h.id('landing-cancel').click(),
      message: () => { const box = h.find(node => node.attributes.role === 'alert'); return box.hidden ? '' : box.textContent; },
      current: () => h.sdk, until: h.until };
  })();
  const errors: unknown[] = [], observed = new Set<object>();
  const joinCount = () => StageSocket.instances.reduce((sum, socket) => sum + socket.sent.filter(message => message.type === 'join').length, 0);
  return { ...view, errors,
    async submit(wire: ReturnType<typeof server>) {
      const before = joinCount(); view.form.submit(); assert.equal(view.submitButton.disabled, true);
      await flushSample(); const socket = StageSocket.instances.at(-1)!; assert.ok(socket);
      const client = view.current(); assert.ok(client);
      if (!observed.has(client)) { observed.add(client); client.on('error', ({ detail }) => errors.push(detail)); }
      wire.attach(socket); await view.until(() => joinCount() === before + 1, 'actual public SDK join reaches the socket');
      const request = socket.sent.filter((message): message is Join => message.type === 'join').at(-1)!;
      return { socket, request };
    },
  };
}
const query = (roomId: string, code: string): string => `?${new URLSearchParams({ room: roomId, code })}`;
function deliver(socket: StageSocket, replies: ServerMessage[]): void { for (const reply of replies) socket.deliver(reply); }
async function accept(wire: ReturnType<typeof server>, ui: Awaited<ReturnType<typeof actualUi>>, entry: Awaited<ReturnType<Awaited<ReturnType<typeof actualUi>>['submit']>>, code?: string) {
  const result = await wire.process(entry.socket, entry.request);
  assert.equal(result.parsed?.code, code); assert.ok(result.state);
  assert.ok(result.replies.some(reply => reply.type === 'ok' && reply.requestId === entry.request.requestId));
  assert.ok(!result.replies.some(reply => reply.type === 'error')); assert.equal(ui.current()?.me, null);
  assert.equal(result.state.code, undefined, 'audience snapshots do not reveal the room code');
  deliver(entry.socket, result.replies); await flushSample();
  assert.equal(ui.current()?.me?.participantId, result.state.me.participantId); assert.deepEqual(ui.errors, []);
}
function publicError(replies: ServerMessage[], requestId: string, code: 'unauthorized' | 'bad_request') {
  assert.deepEqual(replies, [{ type: 'error', requestId, code, message: ERROR_MESSAGES[code] }]);
  return { code, message: ERROR_MESSAGES[code] };
}

for (const surface of ['full sample', 'embed'] as const) {
  it(`${surface} keeps the default eight-character code path with trim and server uppercase normalization`, async t => {
    const wire = server(t), host = await wire.create(), ui = await actualUi(t, surface);
    assert.equal(wire.config.rooms.codeLength, 8); assert.equal(wire.config.limits.codeMaxLength, 16); assert.equal(host.code.length, 8);
    const draft = `  ${host.code.toLowerCase()}  `;
    ui.input('roomId').value = `  ${host.roomId}  `; ui.input('code').value = draft; ui.input('name').value = 'Listener';
    const entry = await ui.submit(wire); assert.equal(entry.request.roomId, host.roomId); assert.equal(entry.request.code, host.code.toLowerCase());
    await accept(wire, ui, entry, host.code); assert.equal(ui.input('code').value, draft);
  });

  it(`${surface} preserves a configured 24-character generated code from query prefill through the public SDK and Hub`, async t => {
    const wire = server(t, 24), host = await wire.create(), draft = `  ${host.code.toLowerCase()}  `;
    assert.equal(host.code.length, 24);
    const ui = await actualUi(t, surface, query(`  ${host.roomId}  `, draft)); ui.input('name').value = 'Listener';
    assert.equal(ui.input('code').value, draft); assert.equal(ui.input('roomId').value, `  ${host.roomId}  `);
    const entry = await ui.submit(wire); assert.equal(entry.request.code, host.code.toLowerCase()); assert.equal(entry.request.roomId, host.roomId);
    await accept(wire, ui, entry, host.code); assert.equal(ui.input('code').value, draft);
  });

  it(`${surface} sends an explicit manual replacement of a prefilled code intact under a configured 32-character maximum`, async t => {
    const wire = server(t, 32), host = await wire.create(), prefill = 'A'.repeat(24);
    assert.equal(host.code.length, 32);
    const ui = await actualUi(t, surface, query(host.roomId, prefill)); ui.input('name').value = 'Listener';
    assert.equal(ui.input('code').value, prefill);
    const draft = `  ${host.code.toLowerCase()}  `; ui.input('code').value = draft;
    const entry = await ui.submit(wire); assert.equal(entry.request.code, host.code.toLowerCase()); assert.notEqual(entry.request.code, prefill);
    await accept(wire, ui, entry, host.code); assert.equal(ui.input('code').value, draft);
  });

  it(`${surface} keeps missing, wrong and nonexistent-room failures generically unauthorized without disclosing code or room existence`, async t => {
    const wire = server(t, 24), host = await wire.create(), ui = await actualUi(t, surface);
    ui.input('name').value = 'Listener';
    const wrong = `${host.code[0] === 'A' ? 'B' : 'A'}${host.code.slice(1)}`, outcomes = [], messages = [];
    for (const [roomId, code] of [[host.roomId, '   '], [host.roomId, wrong], ['nonexistent-room', host.code]] as const) {
      ui.input('roomId').value = roomId; ui.input('code').value = code;
      const entry = await ui.submit(wire); assert.equal(entry.request.code, code.trim() || undefined);
      if (!code.trim()) assert.equal(Object.hasOwn(entry.request, 'code'), false);
      const result = await wire.process(entry.socket, entry.request); assert.ok(result.parsed); assert.equal(result.state, undefined);
      outcomes.push(publicError(result.replies, entry.request.requestId, 'unauthorized'));
      deliver(entry.socket, result.replies); await flushSample();
      assert.equal(ui.current()?.me, null); assert.equal(ui.submitButton.disabled, false); assert.equal(ui.input('code').value, code);
      const message = ui.message(); messages.push(message); assert.ok(message.startsWith(ERROR_MESSAGES.unauthorized));
      for (const secret of [host.roomId, host.code, wrong, 'nonexistent-room']) assert.ok(!message.includes(secret));
      const error = ui.errors.at(-1); assert.ok(error instanceof Error); assert.equal(error.message, ERROR_MESSAGES.unauthorized);
      assert.equal((error as Error & { code: string }).code, 'unauthorized');
    }
    assert.deepEqual(outcomes, [outcomes[0], outcomes[0], outcomes[0]]); assert.deepEqual(messages, [messages[0], messages[0], messages[0]]);
  });

  it(`${surface} leaves the configured maximum to the validator, retains an over-limit draft, and retries with the full valid code`, async t => {
    const wire = server(t, 24), host = await wire.create(), ui = await actualUi(t, surface, query(host.roomId, ''));
    ui.input('name').value = 'Listener'; const draft = `  ${host.code}A  `; ui.input('code').value = draft;
    const rejected = await ui.submit(wire); assert.equal(rejected.request.code, host.code + 'A');
    const result = await wire.process(rejected.socket, rejected.request); assert.equal(result.parsed, undefined); assert.equal(result.state, undefined);
    publicError(result.replies, rejected.request.requestId, 'bad_request'); deliver(rejected.socket, result.replies); await flushSample();
    assert.equal(ui.current()?.me, null); assert.equal(ui.submitButton.disabled, false); assert.equal(ui.input('code').value, draft);
    assert.ok(ui.message().startsWith(ERROR_MESSAGES.bad_request)); assert.ok(!ui.message().includes(host.code)); assert.doesNotMatch(ui.message(), /24|25|最多|上限/);
    const error = ui.errors.at(-1); assert.ok(error instanceof Error); assert.equal(error.message, ERROR_MESSAGES.bad_request);
    assert.equal((error as Error & { code: string }).code, 'bad_request'); ui.errors.length = 0;
    ui.input('code').value = host.code; await accept(wire, ui, await ui.submit(wire), host.code);
  });

  it(`${surface} omits a blank code for code-optional rooms`, async t => {
    const wire = server(t, 24), host = await wire.create('Host', { codeRequired: false }), ui = await actualUi(t, surface);
    ui.input('roomId').value = host.roomId; ui.input('code').value = '   '; ui.input('name').value = 'Listener';
    const entry = await ui.submit(wire); assert.equal(Object.hasOwn(entry.request, 'code'), false);
    await accept(wire, ui, entry); assert.equal(ui.input('code').value, '   ');
  });

  it(`${surface} preserves a replacement draft across pending entry cancellation and ignores the abandoned code's late rejection`, async t => {
    const wire = server(t, 24), host = await wire.create(), wrong = `${host.code[0] === 'A' ? 'B' : 'A'}${host.code.slice(1)}`;
    const ui = await actualUi(t, surface, query(host.roomId, wrong)); ui.input('name').value = 'Listener';
    const old = await ui.submit(wire); assert.equal(old.request.code, wrong);
    const rejected = await wire.process(old.socket, old.request); publicError(rejected.replies, old.request.requestId, 'unauthorized');
    const replacement = `  ${host.code.toLowerCase()}  `; ui.input('code').value = replacement;
    assert.equal(old.request.code, wrong, 'changing the draft cannot mutate an already serialized request');
    ui.cancel(); await flushSample();
    assert.equal(old.socket.readyState, 3); assert.equal(ui.current()?.me, null); assert.equal(ui.submitButton.disabled, false);
    assert.equal(ui.input('code').value, replacement); const message = ui.message();
    deliver(old.socket, rejected.replies); await flushSample(); assert.equal(ui.message(), message); assert.equal(ui.input('code').value, replacement);
    const retry = await ui.submit(wire); assert.notEqual(retry.socket, old.socket); assert.equal(retry.request.code, host.code.toLowerCase());
    await accept(wire, ui, retry, host.code); assert.equal(ui.input('code').value, replacement);
  });
}
