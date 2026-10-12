import assert from 'node:assert/strict';
import { it } from 'node:test';
import { flushSample, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleAudioDevices, SampleNode } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
const empty: SampleAudioDevices = { inputs: [], outputs: [] };
const initial: SampleAudioDevices = {
  inputs: [{ deviceId: 'mic-a', label: '原本的麥克風' }],
  outputs: [{ deviceId: 'speaker-a', label: '原本的揚聲器' }],
};
const current: SampleAudioDevices = {
  inputs: [{ deviceId: 'mic-current', label: '目前的麥克風' }],
  outputs: [{ deviceId: 'speaker-current', label: '目前的揚聲器' }],
};
function options(node: SampleNode): (string | number)[][] {
  assert.ok(node.children.every(child => child.tagName === 'option' && child.isConnected));
  return node.children.map(child => [child.value, child.textContent]);
}
function assertDevices(h: App, devices: SampleAudioDevices, chosen: readonly [string, string] = ['', '']): void {
  for (const [id, list, selected] of [
    ['microphone-device', devices.inputs, chosen[0]], ['speaker-device', devices.outputs, chosen[1]],
  ] as const) {
    const node = h.id(id);
    assert.deepEqual(options(node), [['', '系統預設'], ...list.map((device, index) => [device.deviceId, device.label || `音訊裝置 ${index + 1}`])]);
    // SampleNode does not model native select clamping, so assert membership before its stored value.
    assert.ok(node.children.some(child => child.value === selected), `selected ${id} must remain in the menu`);
    assert.equal(node.value, selected);
  }
}
async function selectDevices(h: App, input: string, output: string): Promise<void> {
  for (const [id, value] of [['microphone-device', input], ['speaker-device', output]] as const) {
    const node = h.id(id); assert.equal(node.disabled, false);
    assert.ok(node.children.some(child => child.value === value)); assert.ok(node.onchange);
    node.value = value; node.onchange();
  }
  await flushSample();
  assert.equal(h.id('microphone-device').disabled, false);
  assert.equal(h.id('speaker-device').disabled, false);
  assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);
}

it('whole sample keeps immediate device enumeration as the fixture default', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
  assert.equal(h.sdk.deviceLists.length, 0); assert.equal(h.deviceChangeListeners.length, 1);
  assertDevices(h, {
    inputs: [{ deviceId: 'mic-a', label: '測試麥克風' }], outputs: [{ deviceId: 'speaker-a', label: '測試揚聲器' }],
  });
  h.dispatchDeviceChange(); await flushSample();
  assert.equal(h.sdk.deviceLists.length, 0);
  assert.equal(h.id('microphone-device').children.length, 2);
  assert.equal(h.id('speaker-device').children.length, 2);
});

it('whole sample startup, micready, and registered devicechange refresh both menus, including labels and empty lists', async t => {
  const h = sampleApp({ deferAudioDevices: true }); t.after(() => h.cleanup());
  assert.equal(h.sdk.deviceLists.length, 1, 'module initialization must start enumeration');
  assert.equal(h.deviceChangeListeners.length, 1, 'the module must register its media-device listener');
  assert.equal(h.id('microphone-device').children.length, 0);
  assert.equal(h.id('speaker-device').children.length, 0);
  h.sdk.deviceLists[0]!.resolve(initial); await flushSample(); assertDevices(h, initial);

  h.sdk.emit('micready', undefined); assert.equal(h.sdk.deviceLists.length, 2);
  h.sdk.deviceLists[1]!.resolve(current); await flushSample(); assertDevices(h, current);
  h.dispatchDeviceChange(); assert.equal(h.sdk.deviceLists.length, 3);
  h.sdk.deviceLists[2]!.resolve(empty); await flushSample(); assertDevices(h, empty);

  h.dispatchDeviceChange(); assert.equal(h.sdk.deviceLists.length, 4);
  h.sdk.deviceLists[3]!.resolve({
    inputs: [{ deviceId: 'mic-hidden', label: '' }, { deviceId: 'mic-named', label: 'USB 麥克風' }],
    outputs: [{ deviceId: 'speaker-named', label: 'USB 揚聲器' }, { deviceId: 'speaker-hidden', label: '' }],
  });
  await flushSample();
  assert.deepEqual(options(h.id('microphone-device')), [['', '系統預設'], ['mic-hidden', '音訊裝置 1'], ['mic-named', 'USB 麥克風']]);
  assert.deepEqual(options(h.id('speaker-device')), [['', '系統預設'], ['speaker-named', 'USB 揚聲器'], ['speaker-hidden', '音訊裝置 2']]);
  assert.equal(h.id('microphone-device').value, ''); assert.equal(h.id('speaker-device').value, '');
  assert.deepEqual(h.sdk.inputDevices, []); assert.deepEqual(h.sdk.outputDevices, []); h.sdk.assertSettled();
});

for (const staleOrder of [[0, 1], [1, 0]]) {
  it(`whole sample keeps the latest devicechange menus and choices when startup/micready settle late (${staleOrder.join(', ')})`, async t => {
    const h = sampleApp({ deferAudioDevices: true }); t.after(() => h.cleanup());
    h.sdk.emit('micready', undefined); h.dispatchDeviceChange();
    assert.equal(h.sdk.deviceLists.length, 3, 'new events must not wait for an older pending enumeration');
    h.sdk.deviceLists[2]!.resolve(current); await flushSample();
    await selectDevices(h, 'mic-current', 'speaker-current');
    assertDevices(h, current, ['mic-current', 'speaker-current']);
    for (const index of staleOrder) {
      h.sdk.deviceLists[index]!.resolve(index === 0 ? initial : empty); await flushSample();
      assertDevices(h, current, ['mic-current', 'speaker-current']);
    }
    assert.deepEqual(h.sdk.inputDevices, ['mic-current']);
    assert.deepEqual(h.sdk.outputDevices, ['speaker-current']); h.sdk.assertSettled();
  });
}

it('whole sample uses the selections made while a fresh enumeration is pending', async t => {
  const h = sampleApp({ deferAudioDevices: true }); t.after(() => h.cleanup());
  const choices: SampleAudioDevices = { inputs: [...initial.inputs, ...current.inputs], outputs: [...initial.outputs, ...current.outputs] };
  h.sdk.deviceLists[0]!.resolve(choices); await flushSample();
  await selectDevices(h, 'mic-a', 'speaker-a');
  h.sdk.emit('micready', undefined); assert.equal(h.sdk.deviceLists.length, 2);
  await selectDevices(h, 'mic-current', 'speaker-current');
  const refreshed: SampleAudioDevices = {
    inputs: [{ deviceId: 'mic-current', label: '更新後的麥克風名稱' }, ...initial.inputs],
    outputs: [{ deviceId: 'speaker-current', label: '更新後的揚聲器名稱' }, ...initial.outputs],
  };
  h.sdk.deviceLists[1]!.resolve(refreshed); await flushSample();
  assertDevices(h, refreshed, ['mic-current', 'speaker-current']);
  assert.deepEqual(h.sdk.inputDevices, ['mic-a', 'mic-current']);
  assert.deepEqual(h.sdk.outputDevices, ['speaker-a', 'speaker-current']); h.sdk.assertSettled();
});

it('whole sample retains its last menus after the newest refresh fails, ignores older success, and recovers on a fresh event', async t => {
  const h = sampleApp({ deferAudioDevices: true }); t.after(() => h.cleanup());
  h.sdk.deviceLists[0]!.resolve(initial); await flushSample();
  await selectDevices(h, 'mic-a', 'speaker-a');
  const inputOptions = [...h.id('microphone-device').children], outputOptions = [...h.id('speaker-device').children];
  h.dispatchDeviceChange(); h.sdk.emit('micready', undefined); assert.equal(h.sdk.deviceLists.length, 3);
  h.sdk.deviceLists[2]!.reject(new Error('device enumeration temporarily unavailable')); await flushSample();
  assertDevices(h, initial, ['mic-a', 'speaker-a']);
  h.sdk.deviceLists[1]!.resolve(current); await flushSample();
  assertDevices(h, initial, ['mic-a', 'speaker-a']);
  assert.deepEqual(h.id('microphone-device').children, inputOptions);
  assert.deepEqual(h.id('speaker-device').children, outputOptions);
  assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);

  h.dispatchDeviceChange(); assert.equal(h.sdk.deviceLists.length, 4);
  const recovered: SampleAudioDevices = {
    inputs: [{ deviceId: 'mic-a', label: '恢復後的麥克風' }, ...current.inputs],
    outputs: [{ deviceId: 'speaker-a', label: '恢復後的揚聲器' }, ...current.outputs],
  };
  h.sdk.deviceLists[3]!.resolve(recovered); await flushSample(); assertDevices(h, recovered, ['mic-a', 'speaker-a']);
  assert.deepEqual(h.sdk.inputDevices, ['mic-a']); assert.deepEqual(h.sdk.outputDevices, ['speaker-a']); h.sdk.assertSettled();
});

it('whole sample ignores a stale startup rejection after micready refresh succeeds', async t => {
  const h = sampleApp({ deferAudioDevices: true }); t.after(() => h.cleanup());
  h.sdk.emit('micready', undefined); assert.equal(h.sdk.deviceLists.length, 2);
  h.sdk.deviceLists[1]!.resolve(current); await flushSample();
  await selectDevices(h, 'mic-current', 'speaker-current');
  h.sdk.deviceLists[0]!.reject(new Error('old startup enumeration failed')); await flushSample();
  assertDevices(h, current, ['mic-current', 'speaker-current']);
  assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true); h.sdk.assertSettled();
});
