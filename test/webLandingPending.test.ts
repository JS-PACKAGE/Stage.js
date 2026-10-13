import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type Action = 'create' | 'join';
interface CreateOptions { name: string; roomName?: string; codeRequired?: boolean; token?: string }
interface CreatedRoom { roomId: string; code?: string }
interface LandingForm { form: SampleNode; submit: SampleNode }
type Forms = Record<Action, LandingForm>;

function setup() {
  const h = sampleApp();
  const creates: { options: CreateOptions; work: Deferred<CreatedRoom> }[] = [];
  Object.assign(h.sdk, {
    createRoom(options: CreateOptions): Promise<CreatedRoom> {
      const work = new Deferred<CreatedRoom>(); creates.push({ options, work }); return work.promise;
    },
  });
  return {
    ...h, creates,
    requestCount: () => creates.length + h.sdk.joins.length,
    pending: (action: Action) => action === 'create' ? creates.at(-1)!.work : h.sdk.joins.at(-1)!.work,
    acknowledge(action: Action): void {
      if (action === 'create') creates.at(-1)!.work.resolve({ roomId: 'same-room', code: 'TEST42' });
      else h.sdk.joins.at(-1)!.work.resolve(undefined);
    },
    async cleanup(): Promise<void> {
      for (const { work } of creates) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
      await h.cleanup();
      assert.ok(creates.every(({ work }) => work.status !== 'pending'), 'all create requests must settle');
    },
  };
}
type App = ReturnType<typeof setup>;

function forms(h: App): Forms {
  const find = (heading: string): LandingForm => {
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === heading));
    const submit = form.descendants().find(node => node.tagName === 'button' && node.type === 'submit');
    assert.ok(submit); return { form, submit };
  };
  return { create: find('建立房間'), join: find('加入房間') };
}
function fill(landing: Forms): void {
  for (const [action, values] of [
    ['create', { name: ' 測試主控 ', roomName: ' 測試舞台 ', token: 'create-token' }],
    ['join', { roomId: ' same-room ', code: ' TEST42 ', name: ' 測試聽眾 ' }],
  ] as const) {
    for (const [name, value] of Object.entries(values)) {
      const input = landing[action].form.descendants().find(node => node.tagName === 'input' && node.name === name);
      assert.ok(input); input.value = value;
    }
  }
}
function assertPending(landing: Forms, pending: boolean): void {
  const submits = [landing.create.submit, landing.join.submit];
  assert.deepEqual(submits.map(node => node.disabled), [pending, pending], 'create and join must show the same shared pending lock');
  assert.deepEqual(submits.map(node => node.attributes['aria-busy']), [String(pending), String(pending)]);
}
function assertRequest(h: App, action: Action): void {
  if (action === 'create') assert.deepEqual({ ...h.creates.at(-1)!.options }, {
    name: '測試主控', roomName: '測試舞台', codeRequired: true, token: 'create-token',
  });
  else assert.deepEqual({ ...h.sdk.joins.at(-1)!.options }, { roomId: 'same-room', code: 'TEST42', name: '測試聽眾' });
}
function snapshotBeforeAck(h: App, action: Action): void {
  if (action === 'create') h.sdk.emit('created', { roomId: 'same-room', code: 'TEST42' });
  const state = roomState(action === 'create' ? { role: 'controller', onStage: true } : {});
  if (action === 'create') { state.controllerId = state.me.participantId; state.codeRequired = true; }
  h.sdk.snapshot(state);
}
const errorBox = (h: App) => h.find(node => node.attributes.role === 'alert');

for (const action of ['create', 'join'] as const) {
  const opposite: Action = action === 'create' ? 'join' : 'create';
  it(`whole sample ${action} locks both landing submissions, ignores keyboard resubmission, and releases both for retries`, async t => {
    const h = setup(); t.after(() => h.cleanup()); const landing = forms(h); fill(landing);
    assert.deepEqual([landing.create.submit.disabled, landing.join.submit.disabled], [false, false]);
    landing[action].form.submit(); assert.equal(h.requestCount(), 1); assertRequest(h, action); assertPending(landing, true);
    // Form submission can bypass a disabled button (for example, an Enter-key handler).
    landing[action].form.submit(); landing[opposite].form.submit(); await flushSample();
    assert.equal(h.requestCount(), 1); assertPending(landing, true);

    h.pending(action).reject(new Error('請稍後再試。')); await flushSample();
    assertPending(landing, false); assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '請稍後再試。');
    landing[opposite].form.submit(); assert.equal(h.requestCount(), 2); assertRequest(h, opposite);
    assert.equal(errorBox(h).hidden, true); assertPending(landing, true);
    landing[action].form.submit(); landing[opposite].form.submit(); assert.equal(h.requestCount(), 2);
    h.pending(opposite).reject(new Error('再試一次。')); await flushSample(); assertPending(landing, false);
    landing[action].form.submit(); assert.equal(h.requestCount(), 3); assertPending(landing, true);
    h.pending(action).reject(new Error('最後一次測試失敗。')); await flushSample(); assertPending(landing, false);
    h.sdk.assertSettled();
  });

  it(`whole sample ${action} state before ACK retires landing nodes without changing pending room controls on settlement`, async t => {
    const h = setup(); t.after(() => h.cleanup()); const landing = forms(h); fill(landing);
    const mute = new Deferred<void>(); let muteCalls = 0;
    Object.assign(h.sdk, { mute: () => { muteCalls++; return mute.promise; } });
    t.after(async () => { if (mute.status === 'pending') mute.resolve(undefined); await flushSample(); });
    landing[action].form.submit(); assertPending(landing, true); snapshotBeforeAck(h, action);
    assert.equal(h.pending(action).status, 'pending');
    for (const entry of Object.values(landing)) { assert.equal(entry.form.isConnected, false); assert.equal(entry.submit.isConnected, false); }
    assert.equal(h.app.descendants().filter(node => node.tagName === 'form').length, 0);
    const key = action === 'create' ? 'mute' : 'hand';
    const control = () => h.find(node => node.dataset.roomAction === key);
    control().click(); assert.equal(action === 'create' ? muteCalls : h.sdk.raises.length, 1);
    const state = h.sdk.state; assert.ok(state);
    h.acknowledge(action); await flushSample();
    assert.equal(h.sdk.state, state); assert.equal(h.app.descendants().filter(node => node.tagName === 'form').length, 0);
    assertPending(landing, true); // Detached controls retain their last rendered state.
    assert.equal(control().disabled, true); assert.equal(control().attributes['aria-busy'], 'true');
    control().click(); assert.equal(action === 'create' ? muteCalls : h.sdk.raises.length, 1);
    if (action === 'create') { assert.match(h.app.textContent, /房間代碼：TEST42/); mute.resolve(undefined); }
    else { h.sdk.raises[0]!.resolve(undefined); h.clock.advance(h.sdk.handCooldownDurationMs); }
    await flushSample(); assert.equal(control().disabled, false); assert.equal(control().attributes['aria-busy'], 'false');
    await h.sdk.disconnect(); await flushSample(); assertPending(forms(h), false); assertPending(landing, true);
    assert.equal(h.clock.jobs.size, 0); h.sdk.assertSettled();
  });

  it(`whole sample ${action} disconnected landing inherits the lock until its rejected request settles, then allows a fresh room`, async t => {
    const h = setup(); t.after(() => h.cleanup()); const retired = forms(h); fill(retired);
    retired[action].form.submit(); assertPending(retired, true); snapshotBeforeAck(h, action);
    // The SDK rejects pending requests before its synchronous disconnected status callback;
    // the async form continuation has not run when that callback builds fresh landing nodes.
    h.pending(action).reject(new Error('連線已中斷。'));
    const disconnecting = h.sdk.disconnect();
    const replacement = forms(h); fill(replacement);
    assert.notEqual(replacement.create.form, retired.create.form); assert.notEqual(replacement.join.form, retired.join.form);
    assertPending(replacement, true);
    replacement.create.form.submit(); replacement.join.form.submit(); assert.equal(h.requestCount(), 1);
    await disconnecting; await flushSample();
    assertPending(replacement, false); assertPending(retired, true); assert.equal(h.clock.jobs.size, 0);
    replacement[opposite].form.submit(); assert.equal(h.requestCount(), 2); assertPending(replacement, true);
    assert.equal(errorBox(h).hidden, true); snapshotBeforeAck(h, opposite); h.acknowledge(opposite); await flushSample();
    assert.equal(h.sdk.state?.roomId, 'same-room'); assert.equal(h.app.descendants().filter(node => node.tagName === 'form').length, 0);
    assertPending(retired, true); assertPending(replacement, true); assert.equal(errorBox(h).hidden, true);
    assert.equal(h.clock.intervals(2000).length, 1); h.sdk.assertSettled();
  });
}
