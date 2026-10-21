import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { Deferred as SenderGate, flush } from './fixtures/embedApp.ts';
import { actualApp, actualState, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { flushSample, roomState, SamplePreview, sampleApp } from './fixtures/sampleApp.ts';

type View = Pick<ReturnType<typeof sampleApp>, 'app' | 'find' | 'id'>;
const permissionNotice = '主控已邀請你上台，請允許麥克風權限。';
const copiedNotice = '已複製邀請連結，請只分享給受邀者。';
const rotatedNotice = '已更換房間代碼，請重新分享邀請連結。';
const unrelatedError = '保留其他操作的錯誤。';
const notices = (h: View) => h.find(node => node.classList.contains('notices')).textContent;
const errorBox = (h: View) => h.find(node => node.attributes.role === 'alert');
const stageState = () => roomState({ role: 'speaker', onStage: true });
function noRetry(h: View): void { assert.equal(h.app.descendants().filter(node => node.id === 'mic-retry').length, 0); }
function fakeSetup(t: TestContext) {
  const h = sampleApp({ clipboard: { async writeText() {} }, confirm: () => true });
  Object.assign(h.sdk, { async rotateCode() {} });
  t.after(() => h.cleanup()); return h;
}
type FakeApp = ReturnType<typeof fakeSetup>;
function invite(h: FakeApp): void {
  assert.ok(h.sdk.me); h.sdk.emit('invite', { participantId: h.sdk.me.participantId });
  assert.equal(notices(h), permissionNotice);
}
async function join(h: FakeApp, state = roomState()): Promise<void> {
  const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
  for (const [name, value] of Object.entries({ roomId: state.roomId, name: state.me.name })) {
    const input = form.descendants().filter(node => node.type !== 'histogram').find(node => node.name === name); assert.ok(input); input.value = value;
  }
  form.submit(); h.sdk.acceptJoin(state); await flushSample();
}

async function actualSetup(t: TestContext) {
  // Dispose the sample before actualApp restores browser globals. Both complete production
  // modules share the real public SDK; only socket, DOM and media boundaries are fakes.
  let cleanup = async (): Promise<void> => {};
  t.after(() => cleanup());
  const boundary = await actualApp(t, { deferCapture: true });
  boundary.form.submit(); await flush();
  const sdk = boundary.clients[0]!;
  const h = sampleApp({ sdk }); cleanup = () => h.cleanup();
  const socket = StageSocket.instances[0]!;
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await boundary.until(() => socket.sent.some(message => message.type === 'join'), 'public SDK join request');
  const request = socket.sent.find(message => message.type === 'join')!;
  const audience = { ...actualState({ role: 'audience', handRaised: true }), controllerId: 'host' };
  audience.hands = [audience.me]; audience.audienceCount = 1;
  socket.deliver({ type: 'room:state', ...audience }); socket.deliver({ type: 'ok', requestId: request.requestId });
  const peer = StagePeer.instances[0]!;
  await boundary.until(() => peer.localDescription !== null && peer.signalingState === 'stable', 'initial listening negotiation');
  return { ...h, boundary, socket, peer,
    async promote() {
      // This is the hub's approval order: invite and role update precede the seat snapshot.
      socket.deliver({ type: 'stage:invite', participantId: 'guest', byId: 'host' });
      assert.equal(notices(h), permissionNotice); assert.equal(sdk.me?.onStage, false);
      socket.deliver({ type: 'role:update', participantId: 'guest', role: 'speaker', reason: 'approved' });
      assert.equal(notices(h), permissionNotice); assert.equal(sdk.me?.onStage, false);
      const promoted = { ...actualState({ role: 'speaker', onStage: true }), controllerId: 'host' };
      promoted.speakers = [promoted.me]; socket.deliver({ type: 'room:state', ...promoted });
      await boundary.until(() => boundary.captures.length === 1, 'stage permission request');
      assert.equal(notices(h), permissionNotice); assert.equal(boundary.ready(), 0); noRetry(h);
    },
  };
}

for (const outcome of ['success', 'failure'] as const) {
  it(`whole sample and actual SDK clear the stage permission prompt at capture-ready before sender ${outcome}`, async t => {
    const h = await actualSetup(t); await h.promote();
    h.socket.deliver({ type: 'error', code: 'bad_request', message: unrelatedError });
    h.peer.gate = new SenderGate(); const offers = h.peer.offers.length;
    let atReady: unknown;
    h.sdk.on('micready', () => {
      atReady = { notice: notices(h), direction: h.peer.transceiver.direction, sender: h.peer.transceiver.sender.track };
    });
    const track = h.boundary.captures[0]!.resolve();
    await h.boundary.until(() => h.peer.gateEntered, 'held sender installation after capture-ready');
    assert.equal(h.boundary.ready(), 1); assert.deepEqual(atReady, { notice: '', direction: 'recvonly', sender: null });
    assert.equal(notices(h), '', 'capture-ready removes only the obsolete request; it makes no publishing claim');
    assert.equal(h.peer.transceiver.sender.track, null); assert.equal(h.peer.transceiver.direction, 'recvonly');
    assert.equal(h.peer.offers.length, offers, 'capture-ready is before a new publishing offer');
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, unrelatedError); noRetry(h);
    if (outcome === 'success') {
      h.peer.gate.resolve();
      await h.boundary.until(() => h.peer.transceiver.sender.track === track && h.peer.transceiver.direction === 'sendrecv'
        && h.peer.offers.length > offers && h.peer.signalingState === 'stable', 'sender installed and offer answered');
      assert.equal(track.enabled, true); assert.equal(track.stopped, false);
      assert.equal(errorBox(h).textContent, unrelatedError);
    } else {
      h.peer.gate.reject('controlled sender installation failure');
      await h.boundary.until(() => errorBox(h).textContent === 'controlled sender installation failure', 'generic sender failure');
      assert.equal(errorBox(h).hidden, false); assert.equal(h.peer.transceiver.sender.track, null);
      assert.equal(h.peer.transceiver.direction, 'recvonly'); assert.equal(h.peer.offers.length, offers);
    }
    assert.equal(h.boundary.ready(), 1); assert.equal(notices(h), ''); noRetry(h);
  });
}

it('whole sample and actual SDK keep denied stage capture actionable and preserve the current generic error', async t => {
  const h = await actualSetup(t); await h.promote();
  h.socket.deliver({ type: 'error', code: 'bad_request', message: unrelatedError });
  h.boundary.captures[0]!.reject(new DOMException('controlled permission denial', 'NotAllowedError'));
  await h.boundary.until(() => notices(h).includes('（NotAllowedError）'), 'capture permission denial');
  assert.ok(notices(h).includes(permissionNotice)); assert.match(notices(h), /麥克風權限遭拒/);
  const retry = h.id('mic-retry'); assert.equal(retry.textContent, '重試麥克風'); assert.equal(retry.disabled, false);
  assert.equal(retry.attributes['aria-busy'], 'false'); assert.equal(h.boundary.ready(), 0);
  assert.equal(h.peer.transceiver.sender.track, null); assert.equal(h.peer.transceiver.direction, 'recvonly');
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, unrelatedError);
});

it('whole sample preserves a pending own invitation through offstage preview-ready and clears it on the later stage capture', async t => {
  const h = fakeSetup(t); h.sdk.snapshot(roomState()); invite(h);
  h.button('測試麥克風').click(); assert.equal(h.sdk.previews.length, 1);
  const preview = new SamplePreview(0.25); h.sdk.grantPreview(h.sdk.previews[0]!, preview); await flushSample();
  assert.equal(h.sdk.me?.onStage, false); assert.equal(notices(h), permissionNotice);
  assert.equal(h.button('停止測試').isConnected, true); assert.equal(preview.stopped, false);
  h.sdk.snapshot(stageState()); assert.equal(preview.stopped, true); assert.equal(notices(h), permissionNotice);
  h.sdk.emit('error', { message: unrelatedError }); h.sdk.emit('micready', undefined);
  assert.equal(notices(h), ''); assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, unrelatedError);
});

for (const newer of ['copy', 'code'] as const) {
  it(`whole sample capture-ready preserves the newer invitation ${newer} notice and generic error`, async t => {
    const h = fakeSetup(t);
    const state = roomState({ role: 'controller', onStage: true }); state.controllerId = state.me.participantId;
    state.codeRequired = true; state.code = 'OLD23456'; h.sdk.snapshot(state); invite(h);
    h.button(newer === 'copy' ? '複製邀請連結' : '更換房間代碼').click(); await flushSample();
    const expected = newer === 'copy' ? copiedNotice : rotatedNotice; assert.equal(notices(h), expected);
    h.sdk.emit('error', { message: unrelatedError }); h.sdk.emit('micready', undefined);
    assert.equal(notices(h), expected); assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, unrelatedError);
    h.sdk.emit('micready', undefined); assert.equal(notices(h), expected);
  });
}

it('whole sample an invitation for another participant neither creates nor replaces own prompt ownership', t => {
  const h = fakeSetup(t); h.sdk.snapshot(stageState());
  h.sdk.emit('invite', { participantId: 'someone-else' }); assert.equal(notices(h), '');
  h.sdk.emit('micready', undefined); assert.equal(notices(h), '');
  invite(h); h.sdk.emit('invite', { participantId: 'someone-else' }); assert.equal(notices(h), permissionNotice);
  h.sdk.emit('micready', undefined); assert.equal(notices(h), '');
});

for (const transition of ['room', 'participant'] as const) {
  it(`whole sample capture-ready does not consume an invitation owned by a different ${transition}`, t => {
    const h = fakeSetup(t); h.sdk.snapshot(roomState()); invite(h);
    const replacement = stageState();
    if (transition === 'room') replacement.roomId = 'different-room'; else replacement.me.participantId = 'different-person';
    h.sdk.snapshot(replacement); const previousNotice = notices(h);
    h.sdk.emit('micready', undefined);
    assert.equal(notices(h), previousNotice, 'a different current identity cannot complete the old invitation');
    h.sdk.snapshot(stageState()); h.sdk.emit('micready', undefined);
    assert.equal(notices(h), previousNotice, 'returning to the same room and participant cannot revive an older generation');
    invite(h); h.sdk.emit('micready', undefined); assert.equal(notices(h), '');
  });
}

it('whole sample stage removal retires its prompt and keeps the removal notice on later capture-ready', t => {
  const h = fakeSetup(t); h.sdk.snapshot(stageState()); invite(h);
  h.sdk.emit('stageleft', { participantId: 'someone-else', reason: 'removed' }); assert.equal(notices(h), permissionNotice);
  h.sdk.emit('stageleft', { participantId: 'same-person', reason: 'removed' });
  const removed = '主控已將你移出舞台，你仍可收聽。'; assert.equal(notices(h), removed);
  h.sdk.snapshot(roomState()); h.sdk.emit('micready', undefined); assert.equal(notices(h), removed);
  h.sdk.snapshot(stageState()); h.sdk.emit('micready', undefined); assert.equal(notices(h), removed);
  invite(h); h.sdk.emit('micready', undefined); assert.equal(notices(h), '');
});

for (const transition of ['Leave', 'shutdown', 'kicked'] as const) {
  it(`whole sample ${transition} retires permission ownership and protects a same-identity rejoin`, async t => {
    const h = fakeSetup(t); await join(h); invite(h); h.sdk.snapshot(stageState());
    if (transition === 'Leave') { h.button('離開房間').click(); await flushSample(); }
    else await h.sdk.terminal(transition === 'shutdown' ? 'closed' : 'kicked', transition === 'shutdown' ? 'shutdown' : undefined);
    const terminal = notices(h);
    if (transition === 'Leave') assert.equal(terminal, '');
    else assert.match(terminal, transition === 'shutdown' ? /伺服器維護或重新啟動/ : /你已被主控移出房間/);
    assert.equal(h.sdk.state === null, true); h.sdk.emit('micready', undefined); assert.equal(notices(h), terminal);
    await join(h); assert.equal(h.sdk.state?.roomId, 'same-room'); assert.equal(h.sdk.me?.participantId, 'same-person');
    assert.equal(notices(h), ''); invite(h);
    h.sdk.emit('micready', undefined); assert.equal(notices(h), permissionNotice, 'offstage ready cannot complete the rejoined invitation');
    h.sdk.snapshot(stageState()); h.sdk.emit('micready', undefined); assert.equal(notices(h), '');
  });
}
