import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Deferred, flushSample, roomState, sampleApp, SamplePreview } from './fixtures/sampleApp.ts';
import type { SampleAudioDevices, SampleNode } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
const unlistedLabel = '已選擇的裝置（目前未列出）';
const initial: SampleAudioDevices = {
  inputs: [{ deviceId: 'mic-a', label: '原本的麥克風' }, { deviceId: 'mic-b', label: '另一支麥克風' }],
  outputs: [{ deviceId: 'speaker-a', label: '原本的揚聲器' }, { deviceId: 'speaker-b', label: '另一組揚聲器' }],
};
const empty: SampleAudioDevices = { inputs: [], outputs: [] };
const cases = [
  { name: 'input', id: 'microphone-device', key: 'inputs', first: 'mic-a', next: 'mic-b', calls: 'inputDevices', set: 'setInputDevice' },
  { name: 'output', id: 'speaker-device', key: 'outputs', first: 'speaker-a', next: 'speaker-b', calls: 'outputDevices', set: 'setOutputDevice' },
] as const;

/** Model native value assignment only here; older sample tests intentionally assign unlisted IDs. */
function clampSelectValue(select: SampleNode): void {
  assert.equal(select.tagName, 'select');
  let selected = select.options.find(option => option.value === select.value) ?? null;
  Object.defineProperty(select, 'value', {
    get: () => selected && select.options.includes(selected) ? selected.value : '',
    set: (value: string | number) => { selected = select.options.find(option => String(option.value) === String(value)) ?? null; },
  });
}
function mount() {
  const writes: [string, string][] = [];
  const h = sampleApp({ deferAudioDevices: true, localStorage: {
    getItem: () => null,
    setItem: (key, value) => { writes.push([key, value]); },
  } });
  for (const device of cases) clampSelectValue(h.id(device.id));
  return { h, writes };
}
async function startup(h: App): Promise<void> {
  assert.equal(h.sdk.deviceLists.length, 1);
  h.sdk.deviceLists[0]!.resolve(initial); await flushSample();
}
async function refresh(h: App, devices: SampleAudioDevices): Promise<void> {
  h.dispatchDeviceChange(); h.sdk.deviceLists.at(-1)!.resolve(devices); await flushSample();
}
function change(h: App, id: string, value: string): void {
  const select = h.id(id);
  assert.equal(select.disabled, false);
  assert.ok(select.options.some(option => option.value === value && !option.disabled), 'user must choose an enabled option');
  select.value = value; assert.equal(select.value, value);
  assert.ok(select.onchange); select.onchange();
}
async function chooseBoth(h: App): Promise<void> {
  for (const device of cases) change(h, device.id, device.first);
  await flushSample();
}
function assertMenu(select: SampleNode, devices: SampleAudioDevices['inputs'], chosen: string): void {
  const missing = Boolean(chosen) && !devices.some(device => device.deviceId === chosen);
  assert.deepEqual(select.options.map(option => [option.value, option.textContent, option.disabled]), [
    ['', '系統預設', false],
    ...devices.map((device, index) => [device.deviceId, device.label || `音訊裝置 ${index + 1}`, false]),
    ...(missing ? [[chosen, unlistedLabel, true]] : []),
  ]);
  assert.equal(select.options.filter(option => option.dataset.unlisted === 'true').length, Number(missing));
  assert.ok(select.options.every(option => option.isConnected));
  assert.equal(select.value, chosen, 'native selection must retain the committed choice');
  assert.equal(select.disabled, false);
}
function assertNoAutomaticSwitch(h: App): void {
  assert.deepEqual(h.sdk.inputDevices, ['mic-a']);
  assert.deepEqual(h.sdk.outputDevices, ['speaker-a']);
}

it('device selection test models native missing-value clamping and disabled selected options', async t => {
  const { h } = mount(); t.after(() => h.cleanup()); await startup(h);
  const select = h.id('microphone-device');
  select.value = 'mic-a'; assert.equal(select.value, 'mic-a');
  select.value = 'not-an-option'; assert.equal(select.value, '');
  select.options[1]!.disabled = true;
  select.value = 'mic-a'; assert.equal(select.value, 'mic-a', 'disabled options can still be selected programmatically');
  select.options[1]!.remove(); assert.equal(select.value, '');
  h.sdk.assertSettled();
});

for (const device of cases) {
  it(`whole sample keeps the unlisted selected ${device.name}, without switching or storing it, until it returns`, async t => {
    const { h, writes } = mount(); t.after(() => h.cleanup()); await startup(h); await chooseBoth(h);
    const missing = { ...initial, [device.key]: [initial[device.key][1]!] };
    await refresh(h, missing);
    assertMenu(h.id(device.id), missing[device.key], device.first);
    for (const other of cases.filter(other => other !== device)) assertMenu(h.id(other.id), initial[other.key], other.first);
    assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);
    assertNoAutomaticSwitch(h);

    await refresh(h, missing);
    assertMenu(h.id(device.id), missing[device.key], device.first);
    await refresh(h, empty);
    for (const other of cases) assertMenu(h.id(other.id), [], other.first);
    assertNoAutomaticSwitch(h);

    const returned = {
      inputs: [{ deviceId: 'mic-b', label: '' }, { deviceId: 'mic-a', label: '重新列出的麥克風' }],
      outputs: [{ deviceId: 'speaker-b', label: '' }, { deviceId: 'speaker-a', label: '重新列出的揚聲器' }],
    };
    await refresh(h, returned);
    for (const other of cases) assertMenu(h.id(other.id), returned[other.key], other.first);
    assertNoAutomaticSwitch(h); assert.deepEqual(writes, []); h.sdk.assertSettled();
  });

  for (const target of ['another device', 'system default'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      it(`whole sample handles ${device.name} changing away from an unlisted choice to ${target} (${outcome})`, async t => {
        const { h, writes } = mount(); t.after(() => h.cleanup()); await startup(h); await chooseBoth(h);
        const missing = { ...initial, [device.key]: [initial[device.key][1]!] };
        await refresh(h, missing);
        const select = h.id(device.id);
        assertMenu(select, missing[device.key], device.first);
        const previousPlaceholder = select.options.at(-1)!;
        const work = new Deferred<void>();
        h.sdk[device.set] = (value: string) => { h.sdk[device.calls].push(value); return work.promise; };
        const chosen = target === 'system default' ? '' : device.next;
        change(h, device.id, chosen); assert.equal(select.disabled, true);
        if (outcome === 'success') work.resolve(undefined); else work.reject(new Error('裝置切換未完成。'));
        await flushSample();
        assertMenu(select, missing[device.key], outcome === 'success' ? chosen : device.first);
        assert.equal(previousPlaceholder.isConnected, false, 'completed change must remove the old placeholder');
        assert.deepEqual(h.sdk[device.calls], [device.first, chosen]);
        const other = cases.find(other => other !== device)!;
        assert.deepEqual(h.sdk[other.calls], [other.first]);
        assertMenu(h.id(other.id), initial[other.key], other.first);
        assert.equal(h.find(node => node.attributes.role === 'alert').hidden, outcome === 'success');
        assert.deepEqual(writes, []); h.sdk.assertSettled();
      });
    }
  }

  for (const outcome of ['success', 'failure'] as const) {
    for (const targetListed of [false, true]) {
      it(`whole sample restores ${device.name} after enumeration during a pending change (${outcome}, target listed ${targetListed})`, async t => {
        const { h, writes } = mount(); t.after(() => h.cleanup()); await startup(h); await chooseBoth(h);
        const work = new Deferred<void>();
        h.sdk[device.set] = (value: string) => { h.sdk[device.calls].push(value); return work.promise; };
        const select = h.id(device.id);
        change(h, device.id, device.next); assert.equal(select.disabled, true);
        const latest = { ...initial, [device.key]: targetListed ? [{ deviceId: device.next, label: '列舉更新後的裝置名稱' }] : [] };
        await refresh(h, latest);
        assert.equal(select.disabled, true, 'refresh must not allow another change while the current one is pending');
        assert.equal(select.value, device.first, 'enumeration keeps the last committed choice until the change succeeds');
        assert.deepEqual(select.options.filter(option => option.dataset.unlisted === 'true').map(option => option.value), [device.first]);
        assert.deepEqual(h.sdk[device.calls], [device.first, device.next]);
        if (outcome === 'success') work.resolve(undefined); else work.reject(new Error('裝置切換未完成。'));
        await flushSample();
        assertMenu(select, latest[device.key], outcome === 'success' ? device.next : device.first);
        assert.deepEqual(h.sdk[device.calls], [device.first, device.next]);
        const other = cases.find(other => other !== device)!;
        assert.deepEqual(h.sdk[other.calls], [other.first]);
        assertMenu(h.id(other.id), initial[other.key], other.first);
        assert.equal(h.find(node => node.attributes.role === 'alert').hidden, outcome === 'success');
        assert.deepEqual(writes, []); h.sdk.assertSettled();
      });
    }
  }
}

it('whole sample never creates an unlisted placeholder for system-default choices or empty enumeration', async t => {
  const { h, writes } = mount(); t.after(() => h.cleanup()); await startup(h);
  for (const lists of [empty, initial, { inputs: [...initial.inputs].reverse(), outputs: [...initial.outputs].reverse() }, empty]) {
    await refresh(h, lists);
    for (const device of cases) assertMenu(h.id(device.id), lists[device.key], '');
  }
  assert.deepEqual(h.sdk.inputDevices, []); assert.deepEqual(h.sdk.outputDevices, []);
  assert.deepEqual(writes, []); h.sdk.assertSettled();
});

it('whole sample preserves unlisted choices on failed and stale enumeration, then restores returned choices on fresh success', async t => {
  const { h, writes } = mount(); t.after(() => h.cleanup()); await startup(h); await chooseBoth(h);
  await refresh(h, empty);
  const before = cases.map(device => [...h.id(device.id).options]);
  h.dispatchDeviceChange(); h.sdk.emit('micready', undefined); h.dispatchDeviceChange();
  assert.equal(h.sdk.deviceLists.length, 5);
  h.sdk.deviceLists[4]!.reject(new Error('latest enumeration failed')); await flushSample();
  h.sdk.deviceLists[2]!.resolve(initial); await flushSample();
  h.sdk.deviceLists[3]!.reject(new Error('stale enumeration failed')); await flushSample();
  for (const [index, device] of cases.entries()) {
    assertMenu(h.id(device.id), [], device.first);
    assert.deepEqual(h.id(device.id).options, before[index]);
  }
  assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);
  assertNoAutomaticSwitch(h);
  await refresh(h, initial);
  for (const device of cases) assertMenu(h.id(device.id), initial[device.key], device.first);
  assertNoAutomaticSwitch(h); assert.deepEqual(writes, []); h.sdk.assertSettled();
});

it('whole sample restores the newly committed unlisted input when leaving during its replacement preview', async t => {
  const { h, writes } = mount(); t.after(() => h.cleanup()); await startup(h); await chooseBoth(h);
  h.sdk.snapshot(roomState());
  h.id('mic-test').click();
  const preview = new SamplePreview(0.3);
  h.sdk.grantPreview(h.sdk.previews[0]!, preview);
  h.sdk.deviceLists.at(-1)!.resolve(initial); await flushSample();
  assert.equal(h.id('mic-test').textContent, '停止測試');

  const work = new Deferred<void>();
  h.sdk.setInputDevice = (value: string) => { h.sdk.inputDevices.push(value); return work.promise; };
  change(h, 'microphone-device', 'mic-b');
  await refresh(h, { inputs: [], outputs: initial.outputs });
  assert.equal(h.id('microphone-device').value, 'mic-a');
  work.resolve(undefined); await flushSample();
  assert.equal(preview.stops, 1);
  assert.equal(h.sdk.previews.length, 2);
  assert.equal(h.sdk.previews[1]!.status, 'pending');
  assert.equal(h.id('microphone-device').disabled, true);
  assert.ok(!h.id('microphone-device').options.some(option => option.value === 'mic-b'), 'the newly committed device is absent until the pending handler restores it');

  h.button('離開房間').click(); await flushSample();
  assert.equal(h.sdk.state, null);
  assert.equal(h.sdk.previews[1]!.status, 'rejected');
  assert.equal(h.sdk.previewSignals[1]!.aborted, true);
  assertMenu(h.id('microphone-device'), [], 'mic-b');
  assertMenu(h.id('speaker-device'), initial.outputs, 'speaker-a');
  assert.equal(h.id('mic-test').disabled, false);
  assert.equal(h.id('mic-test').textContent, '測試麥克風');
  assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);
  assert.deepEqual(h.sdk.inputDevices, ['mic-a', 'mic-b']);
  assert.deepEqual(h.sdk.outputDevices, ['speaker-a']);
  assert.deepEqual(writes, []); h.sdk.assertSettled();
});
