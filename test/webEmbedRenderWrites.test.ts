import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { StageClient } from '../packages/client/src/index.ts';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { flush, type EmbedNode } from './fixtures/embedApp.ts';
import { actualApp, StageSocket, StagePeer } from './fixtures/embedSdkApp.ts';
import { harness, testConfig, FakeSession } from './helpers.ts';

type View = { node(id: string): EmbedNode };
function controls(h: View, index = 0) {
  const node = h.node('stage-management-list').children[index]; assert.ok(node, `stage row ${index}`);
  const name = node.children[0], actions = node.children[1]; assert.ok(name); assert.ok(actions);
  const mute = actions.children[0], remove = actions.children[1], transfer = actions.children[2];
  assert.ok(mute); assert.ok(remove); assert.ok(transfer, 'confirmed handoff action is present');
  return { node, name, actions, mute, remove, transfer };
}

// Whole modules with controlled DOM/media. Native layout, keyboard/focus, assistive
// technology and hardware/codec audio are separate, unverified validation layers.
function tree(node: EmbedNode): EmbedNode[] { return [node, ...node.children.flatMap(tree)]; }
function row(h: View, index = 0) {
  const r = controls(h, index), nodes = tree(r.node);
  const draft = nodes.find(node => node.tagName === 'INPUT'), label = nodes.find(node => node.tagName === 'LABEL');
  const apply = nodes.find(node => node.textContent === '套用混音增益');
  const accepted = nodes.find(node => node.textContent.startsWith('目前混音增益：'));
  assert.ok(draft); assert.ok(label); assert.ok(apply); assert.ok(accepted);
  assert.ok(label.contains(draft), 'native wrapping label identifies draft');
  return { ...r, draft, label, apply, accepted };
}
function edit(r: ReturnType<typeof row>, value: string): void { r.draft.value = value; assert.ok(r.draft.oninput); r.draft.oninput(); }
function locked(r: ReturnType<typeof row>, pending = true, disabled = pending): void {
  for (const control of [r.draft, r.apply, r.mute, r.remove]) {
    assert.equal(control.disabled, disabled); assert.equal(control.getAttribute('aria-busy'), String(pending));
  }
}
async function setup(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; });
  const server = harness(config), host = await server.create('Synthetic host');
  const h = await actualApp(t, { confirm: () => true });
  let serverWork = Promise.resolve(), requestNo = 0;
  const validated: ClientMessage[] = [], incoming: ServerMessage[] = [];
  const sessions = new Map<StageSocket, Session>();
  let holdStageAck = false;
  let beforeTransfer: (() => Promise<void>) | undefined;
  const originalClose = StageSocket.prototype.close;
  t.mock.method(StageSocket.prototype, 'close', function (this: StageSocket, code?: number) {
    originalClose.call(this);
    const session = sessions.get(this);
    if (session) serverWork = serverWork.then(() => server.hub.detach(session, code === 1000));
  });
  const heldAcks: ServerMessage[] = [];
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this);
    assert.ok(session); this.sent.push(message); validated.push(message);
    serverWork = serverWork.then(async () => {
      if (message.type === 'control:transfer') await beforeTransfer?.();
      await server.hub.handle(session, message);
    });
  });
  t.after(async () => { await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close(); });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic embed host';
  h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  const session: Session = {
    id: 'render-write-embed',
    send(message) {
      incoming.push(message);
      if (holdStageAck && message.type === 'ok' && validated.some(request =>
        request.type === 'mic:gain' && request.requestId === message.requestId)) {
        heldAcks.push(message); return;
      }
      if (socket.readyState === StageSocket.OPEN) socket.deliver(message);
    },
    close() { socket.close(); },
  };
  sessions.set(socket, session); server.hub.attach(session);
  await h.until(() => h.clients[0]?.me !== null && h.clients[0]?.me !== undefined, 'actual SDK joined');
  await h.tick(200); await serverWork; await flush();
  const client = h.clients[0] as StageClient;
  assert.equal(client.me?.role, 'audience'); assert.equal(client.me?.onStage, false);
  assert.equal(StageSocket.instances.length, 1); assert.equal(StagePeer.instances.length, 1);
  assert.equal(server.hub.isJoined(session), true);
  const pid = client.me!.participantId;
  const req = async (actor: FakeSession, message: Omit<ClientMessage, 'requestId'> & Record<string, unknown>) => {
    const requestId = `render-setup-${++requestNo}`;
    await server.hub.handle(actor, parseClientMessage(JSON.stringify({ ...message, requestId }), config.limits));
    const reply = actor.inbox.find(message => (message.type === 'ok' || message.type === 'error') && message.requestId === requestId);
    assert.ok(reply); return reply.type === 'error' ? reply.code : 'ok';
  };
  const flushStates = async () => {
    for (const timer of server.timers) if (!timer.cleared && (timer.ms === 0 || timer.ms === config.rooms.presenceBroadcastMs)) {
      timer.cleared = true; timer.fn();
    }
    await nextTurn(); await flush();
  };
  const approveUI = async (id: string) => {
    const index = client.state!.hands.findIndex(person => person.participantId === id); assert.ok(index >= 0);
    const row = h.node('hand-queue-list').children[index]!;
    row.children[1]!.children[0]!.click(); await h.tick(200); await serverWork; await flush();
    assert.equal(client.state!.speakers.some(person => person.participantId === id), true);
    assert.equal(client.state!.hands.some(person => person.participantId === id), false);
  };
  const transfer = async () => {
    assert.equal(await req(host.s, { type: 'control:transfer', targetId: pid }), 'ok'); await flush();
    assert.equal(client.me?.role, 'controller'); assert.equal(client.me?.onStage, false);
    assert.equal(h.node('room-name-panel').hidden, false);
    assert.equal(h.node('hand').disabled, true);
    assert.equal(h.stage.textContent, '返回舞台');
  };
  const sdkApplicant = async (name: string) => {
    const audio = { autoplay: true, srcObject: null, volume: 1, muted: false, pauses: 0, plays: 0,
      pause() { this.pauses++; }, async play() { this.plays++; } };
    const target = new StageClient({ url: 'wss://stage.example.test/ws', audioElement: audio as unknown as HTMLAudioElement });
    h.clients.push(target);
    const joining = target.join({ roomId: host.roomId, code: host.code, name });
    const targetSocket = StageSocket.instances.at(-1)!;
    const s = new FakeSession();
    const send = s.send.bind(s);
    s.send = message => { send(message); if (targetSocket.readyState === StageSocket.OPEN) targetSocket.deliver(message); };
    s.close = () => { targetSocket.close(); };
    sessions.set(targetSocket, s); server.hub.attach(s);
    await h.until(() => target.me !== null, 'actual target SDK joined'); await h.tick(200); await serverWork; await flush(); await joining;
    const raising = target.raiseHand(); await h.tick(200); await serverWork; await flushStates(); await raising;
    return { client: target, id: target.me!.participantId, socket: targetSocket, s, audio, peer: StagePeer.instances.at(-1)! };
  };
  return { server, host, h, client, pid, socket, validated, incoming, req, flushStates, approveUI, transfer, sdkApplicant,
    drain: async () => { await serverWork; await flush(); }, holdAck: () => { holdStageAck = true; }, heldAcks,
    beforeTransfer: (work: () => Promise<void>) => { beforeTransfer = work; } };
}
const counts = (f: Awaited<ReturnType<typeof setup>>) => ({ captures: f.h.captures.length, peers: StagePeer.instances.length,
  offers: StagePeer.instances.map(peer => peer.offers.length), plays: f.h.audio.plays, clients: f.h.clients.length, sockets: StageSocket.instances.length });
const hubRow = (f: Awaited<ReturnType<typeof setup>>, id: string) => {
  const i = f.client.state!.speakers.filter(p => p.participantId !== f.pid && p.role === 'speaker' && p.onStage).findIndex(p => p.participantId === id);
  assert.ok(i >= 0); const node = f.h.node('stage-management-list').children[i]!; assert.ok(node); return node;
};
function hubControls(f: Awaited<ReturnType<typeof setup>>, id: string) {
  const index = f.h.node('stage-management-list').children.indexOf(hubRow(f, id)); return row(f.h, index);
}

interface Write {
  node: string;
  field: string;
  before: unknown;
  value: unknown;
  equal: boolean;
  failed: boolean;
}
function auditRows(h: View) {
  const records: Write[] = [], eligibility: number[] = [];
  let failure: { node: EmbedNode; field: string; remaining: number } | undefined;
  let replacements = 0;
  const list = h.node('stage-management-list'), originalReplace = list.replaceChildren.bind(list);
  list.replaceChildren = (...nodes) => { replacements++; originalReplace(...nodes); };
  function beforeWrite(node: EmbedNode, label: string, field: string, before: unknown, value: unknown): void {
    const failed = !!failure && failure.node === node && failure.field === field && failure.remaining-- > 0;
    records.push({ node: label, field, before, value, equal: before === value, failed });
    if (failed) throw new Error(`intentional failed DOM write ${field}`);
  }
  for (let index = 0; index < list.children.length; index++) {
    const r = row(h, index);
    const fields: [string, EmbedNode][] = [
      ['name', r.name], ['mute', r.mute], ['remove', r.remove], ['transfer', r.transfer],
      ['gainCurrent', r.accepted], ['gainLabel', r.label.children[0]!], ['gainDraft', r.draft],
      ['gainApply', r.apply], ['gainNotice', r.node.children[2]!.children[2]!],
    ];
    const originalContains = r.node.contains.bind(r.node);
    r.node.contains = node => { if (node === r.transfer) eligibility.push(index); return originalContains(node); };
    for (const [name, node] of fields) {
      const label = `${index}.${name}`;
      for (const field of ['disabled', 'textContent', 'hidden', 'min', 'max', 'value'] as const) {
        let cursor: object | null = node, descriptor: PropertyDescriptor | undefined;
        while (cursor && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(cursor, field); cursor = Object.getPrototypeOf(cursor); }
        let current = node[field];
        const get = descriptor?.get ? () => descriptor!.get!.call(node) : () => current;
        const set = descriptor?.set ? (value: unknown) => descriptor!.set!.call(node, value) : (value: unknown) => { current = value as never; };
        Object.defineProperty(node, field, { configurable: true, get, set(value: unknown) {
          beforeWrite(node, label, field, get(), value); set(value);
        } });
      }
      const original = node.setAttribute.bind(node);
      node.setAttribute = (field, value) => {
        beforeWrite(node, label, field, node.getAttribute(field), value); original(field, value);
      };
    }
  }
  const summary = () => {
    const fields: Record<string, { equal: number; necessary: number; failed: number }> = {};
    for (const write of records) {
      const key = `${write.node.slice(write.node.indexOf('.') + 1)}.${write.field}`;
      const field = fields[key] ??= { equal: 0, necessary: 0, failed: 0 };
      if (write.failed) field.failed++; else if (write.equal) field.equal++; else field.necessary++;
    }
    return {
      attempts: records.length, equal: records.filter(write => write.equal && !write.failed).length,
      necessary: records.filter(write => !write.equal && !write.failed).length,
      failed: records.filter(write => write.failed).length, valueWrites: records.filter(write => write.field === 'value').length,
      replacements, eligibility: [...eligibility], fields,
    };
  };
  return { summary, reset() { records.length = 0; replacements = 0; eligibility.length = 0; },
    fail(node: EmbedNode, field: string) { failure = { node, field, remaining: 1 }; }, clearFailure() { failure = undefined; } };
}
function identities(h: View) {
  return h.node('stage-management-list').children.map(node => tree(node).map(node => [node, node.onclick, node.oninput, node.onchange] as const));
}
function checkIdentities(h: View, original: ReturnType<typeof identities>): void {
  const current = identities(h); assert.equal(current.length, original.length);
  for (let i = 0; i < current.length; i++) {
    assert.equal(current[i]!.length, original[i]!.length);
    for (let j = 0; j < current[i]!.length; j++) for (let k = 0; k < 4; k++)
      assert.equal(current[i]![j]![k], original[i]![j]![k]);
  }
}
async function sdkWork(f: Awaited<ReturnType<typeof setup>>, work: Promise<unknown>): Promise<void> {
  await f.h.tick(200); await f.drain(); await f.flushStates(); await work;
}
async function withSpeakers(t: TestContext, count: number) {
  const f = await setup(t); await f.transfer();
  for (let index = 1; index < count; index++) {
    const target = await f.sdkApplicant(`Speaker ${index}`);
    await f.approveUI(target.id); await f.h.tick(200); await f.drain();
  }
  assert.equal(f.h.node('stage-management-list').children.length, count); return f;
}
function checkRetained(a: ReturnType<typeof auditRows>, necessary: number): void {
  const result = a.summary();
  assert.equal(result.necessary, necessary);
  assert.equal(result.equal, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.valueWrites, 0);
  assert.equal(result.replacements, 0);
}

for (const speakers of [1, 3, 8]) it(`whole embed avoids equal row writes for 24 actual SDK/validator/Hub updates with ${speakers} speakers`, async t => {
  const f = await withSpeakers(t, speakers), requester = await f.sdkApplicant('Queue participant');
  await sdkWork(f, requester.client.withdrawHand());
  const beforeMedia = counts(f), stable = identities(f.h);
  f.h.node('stage-management').open = true;
  const drafts = Array.from({ length: speakers }, (_, index) => index % 3 === 0 ? '3.260' : index % 3 === 1 ? '' : '-');
  drafts.forEach((text, index) => edit(row(f.h, index), text));
  const a = auditRows(f.h), incomingAt = f.incoming.length, requestsAt = f.validated.length;
  let stateEvents = 0; const off = f.client.on('state', () => { stateEvents++; });
  for (let round = 0; round < 4; round++) {
    await sdkWork(f, f.client.setName(`Controller ${round}`));
    await sdkWork(f, f.client.setRoomName(`Room ${round}`));
    await sdkWork(f, f.client.setGain(f.host.id, 0));
    await sdkWork(f, f.client.setRoomName(`Room ${round}`));
    await f.h.tick(10001); f.server.clock.now += 10001;
    await sdkWork(f, requester.client.raiseHand());
    await sdkWork(f, requester.client.withdrawHand());
  }
  off(); const result = a.summary();
  assert.equal(stateEvents, 24);
  assert.equal(f.incoming.slice(incomingAt).filter(message => message.type === 'room:state').length, 24);
  assert.equal(f.validated.slice(requestsAt).filter(message => message.type !== 'ping').length, 24);
  assert.equal(f.validated.slice(requestsAt).filter(message => message.type === 'ping').length, 3 * (speakers + 1));
  checkRetained(a, 0);
  const order = Array.from({ length: speakers }, (_, index) => index);
  assert.deepEqual(result.eligibility, Array.from({ length: 24 }, () => [...order, ...order]).flat(),
    'both transfer eligibility passes run in row order on every actual snapshot');
  drafts.forEach((text, index) => assert.equal(row(f.h, index).draft.value, text));
  checkIdentities(f.h, stable);
  assert.equal(f.h.node('stage-management').open, true); assert.deepEqual(counts(f), beforeMedia);
  t.diagnostic(JSON.stringify({ scenario: 'ordinary', speakers, stateEvents, ...result }));
});

it('whole embed changed gain, rename and mute write only dependent fields and preserve the exact unsent draft', async t => {
  const f = await withSpeakers(t, 3), r = hubControls(f, f.host.id); edit(r, '3.260');
  const stable = identities(f.h), a = auditRows(f.h);
  await sdkWork(f, f.client.setGain(f.host.id, 2.34));
  checkRetained(a, 1); const gain = a.summary();
  assert.equal(r.accepted.textContent, '目前混音增益：+2.3 dB'); assert.equal(r.draft.value, '3.260');
  a.reset(); assert.equal(await f.req(f.host.s, { type: 'participant:rename', name: 'Renamed <safe>' }), 'ok'); await f.flushStates();
  checkRetained(a, 6); const rename = a.summary();
  assert.equal(r.name.children.length, 0); assert.equal(r.draft.value, '3.260');
  a.reset(); await sdkWork(f, f.client.forceMute(f.host.id)); checkRetained(a, 3); const mute = a.summary();
  assert.equal(r.draft.value, '3.260'); checkIdentities(f.h, stable);
  t.diagnostic(JSON.stringify({ scenario: 'changed', gain, rename, mute }));
});

it('whole embed gain state before ACK retains reservation and draft, blocks transfer, then permits the next action', async t => {
  const f = await withSpeakers(t, 3), r = hubControls(f, f.host.id); edit(r, '-6.04');
  const stable = identities(f.h), a = auditRows(f.h); f.holdAck();
  r.apply.click(); await f.h.tick(200); await f.drain();
  assert.equal(r.accepted.textContent, '目前混音增益：-6 dB'); assert.equal(r.draft.value, '-6.04'); locked(r);
  for (let index = 0; index < 3; index++) assert.equal(row(f.h, index).transfer.disabled, true);
  checkRetained(a, 12); const pending = a.summary();
  a.reset(); for (let index = 0; index < 8; index++) await sdkWork(f, f.client.setRoomName(`Pending ${index}`));
  checkRetained(a, 0); const unchanged = a.summary();
  assert.deepEqual(unchanged.eligibility, [], 'gain reservation still short-circuits both transfer passes');
  a.reset(); f.socket.deliver(f.heldAcks[0]!); await flush(); locked(r, false);
  checkRetained(a, 11); const settled = a.summary(); checkIdentities(f.h, stable);
  assert.equal(r.draft.value, '-6.04'); r.apply.click(); await f.h.tick(200); await f.drain(); locked(r);
  assert.equal(f.validated.filter(message => message.type === 'mic:gain').length, 2);
  f.socket.deliver(f.heldAcks[1]!); await flush(); locked(r, false);
  t.diagnostic(JSON.stringify({ scenario: 'pending', pending, unchanged, settled }));
});

it('whole embed transfer reserves every row through the actual SDK call and retires rows after genuine role loss', async t => {
  const f = await withSpeakers(t, 3), r = hubControls(f, f.host.id); edit(r, '4.560');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); f.beforeTransfer(async () => gate);
  const a = auditRows(f.h); r.transfer.click();
  for (let index = 0; index < 3; index++) {
    const current = row(f.h, index);
    for (const control of [current.draft, current.apply, current.mute, current.remove, current.transfer]) assert.equal(control.disabled, true);
  }
  assert.equal(f.h.confirmations.length, 1); assert.equal(r.transfer.getAttribute('aria-busy'), 'true');
  checkRetained(a, 16); const reserved = a.summary();
  a.reset(); r.draft.oninput!(); checkRetained(a, 0); const same = a.summary();
  assert.equal(r.draft.value, '4.560'); release(); await f.h.tick(200); await f.drain();
  assert.equal(f.client.me?.role, 'audience'); assert.equal(f.h.node('stage-management-list').children.length, 0);
  assert.equal(r.node.parentElement, null);
  const sent = f.validated.length; r.apply.invoke(); await f.h.tick(200); await f.drain(); assert.equal(f.validated.length, sent);
  t.diagnostic(JSON.stringify({ scenario: 'transfer', reserved, same }));
});

it('whole embed repairs every guarded host value and retries failed writes from live DOM without replacing draft', async t => {
  const f = await withSpeakers(t, 1), r = row(f.h); edit(r, '7.001');
  const stable = identities(f.h), a = auditRows(f.h);
  const targets: [EmbedNode, string, unknown, unknown][] = [
    [r.draft, 'min', 'bad', r.draft.min], [r.draft, 'max', 'bad', r.draft.max],
    [r.draft, 'disabled', true, false], [r.apply, 'disabled', true, false],
    [r.draft, 'aria-busy', 'bad', 'false'], [r.apply, 'aria-busy', 'bad', 'false'],
    [r.apply, 'aria-label', 'bad', r.apply.getAttribute('aria-label')],
    [r.transfer, 'hidden', true, false], [r.transfer, 'disabled', true, false], [r.transfer, 'aria-busy', 'bad', 'false'],
    [r.accepted, 'textContent', 'bad', r.accepted.textContent], [r.label.children[0]!, 'textContent', 'bad', r.label.children[0]!.textContent],
    [r.name, 'textContent', 'bad', r.name.textContent], [r.transfer, 'aria-label', 'bad', r.transfer.getAttribute('aria-label')],
  ];
  const get = (node: EmbedNode, field: string) => field.startsWith('aria-') ? node.getAttribute(field) : Reflect.get(node, field);
  const set = (node: EmbedNode, field: string, value: unknown) => field.startsWith('aria-') ? node.setAttribute(field, String(value)) : Reflect.set(node, field, value);
  for (const [node, field, bad, wanted] of targets) {
    set(node, field, bad); a.reset(); a.fail(node, field);
    assert.throws(() => r.draft.oninput!(), /intentional failed DOM write/);
    assert.equal(get(node, field), bad); assert.equal(a.summary().failed, 1); a.clearFailure();
    a.reset(); await sdkWork(f, f.client.setRoomName('Repair cycle')); assert.equal(get(node, field), wanted); checkRetained(a, 1);
    a.reset(); await sdkWork(f, f.client.setRoomName('Repair cycle')); checkRetained(a, 0);
  }
  assert.equal(r.draft.value, '7.001'); checkIdentities(f.h, stable);
  t.diagnostic(JSON.stringify({ scenario: 'repair-and-failed-write-retry', fields: targets.length }));
});

it('whole embed synchronous public SDK callback reentry cannot duplicate gain or moderation and preserves live guards', async t => {
  const f = await withSpeakers(t, 3), r = hubControls(f, f.host.id), original = f.client.setGain.bind(f.client); edit(r, '2.34');
  let callbacks = 0;
  f.client.setGain = (id, value) => {
    callbacks++; r.apply.invoke(); r.mute.invoke(); r.remove.invoke(); r.draft.oninput!(); return original(id, value);
  };
  f.holdAck(); const stable = identities(f.h), a = auditRows(f.h), sent = f.validated.length;
  r.apply.click(); await f.h.tick(200); await f.drain();
  assert.equal(callbacks, 1); locked(r); checkRetained(a, 12); const during = a.summary();
  assert.deepEqual(f.validated.slice(sent).map(message => message.type), ['mic:gain']);
  f.socket.deliver(f.heldAcks[0]!); await flush(); locked(r, false); assert.equal(r.draft.value, '2.34'); checkIdentities(f.h, stable);
  t.diagnostic(JSON.stringify({ scenario: 'synchronous-sdk-reentry', ...during }));
});
