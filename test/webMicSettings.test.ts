import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';

const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
const testButton = source.slice(source.indexOf('const testButton = button('), source.indexOf("testButton.id = 'mic-test'"));
const inputChange = source.slice(source.indexOf('micSelect.onchange ='), source.indexOf('speakerSelect.onchange ='));
const meter = source.slice(source.indexOf('function cancelPreviewCapture()'), source.indexOf("client.on('state', syncMeter)"));
const button = source.slice(source.indexOf('function button('), source.indexOf('/** Room controls retain'));
interface Preview { stops: number; stop(): void; level(): number }
const preview = (): Preview => ({ stops: 0, stop() { this.stops++; }, level: () => 0 });
function setup() {
  const starts: ReturnType<typeof Promise.withResolvers<Preview>>[] = [];
  const devices: { id: string; request: ReturnType<typeof Promise.withResolvers<void>> }[] = [];
  const client = { me: { onStage: false }, micLevel: 0,
    startMicTest() { const request = Promise.withResolvers<Preview>(); starts.push(request); return request.promise; },
    setInputDevice(id: string) { const request = Promise.withResolvers<void>(); devices.push({ id, request }); return request.promise; },
  };
  const ui = runInNewContext(stripTypeScriptTypes(`
    let micTest = null, testingBusy = false, selectedInput = '', meterTimer, micSettingsGeneration = 0, previewCapture;
    const cancelTestButton = { hidden: true, disabled: true };
    const micSelect = { disabled: false, value: '' }, level = { value: 0 }, errors = [];
    const errorBox = { hidden: true }, setInterval = () => 1, clearInterval = () => {};
    function element() { return { disabled: false, isConnected: true, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } }; }
    function showError(message) { errors.push(message); }
    function updateCooldown() {}
    // This fragment tests capture ownership; whole-app selection tests exercise actual option reconciliation.
    function restoreDeviceSelection(select, chosen) { select.value = chosen; }
    ${button}
    ${testButton}
    ${inputChange}
    ${meter}
    ({ toggle() { testButton.onclick(); }, change(id) { micSelect.value = id; micSelect.onchange(); }, refresh: syncMeter, reset: resetMicSettings,
      testDisabled: () => testButton.disabled, inputDisabled: () => micSelect.disabled, text: () => testButton.textContent,
      selected: () => selectedInput, preview: () => micTest, errors });
  `), { client, Error, AbortController }) as {
    toggle(): void; change(id: string): void; refresh(): void; reset(): void;
    testDisabled(): boolean; inputDisabled(): boolean; text(): string;
    selected(): string; preview(): Preview | null; errors: string[];
  };
  return { ui, client, starts, devices };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('locks preview toggle throughout device switching and replacement capture', async () => {
  const { ui, starts, devices } = setup(); const first = preview(), replacement = preview();
  ui.toggle(); starts[0]!.resolve(first); await flush();
  ui.change('new-mic'); assert.equal(ui.testDisabled(), true); assert.equal(ui.inputDisabled(), true);
  ui.toggle(); ui.change('ignored'); ui.refresh();
  assert.equal(starts.length, 1); assert.equal(devices.length, 1);
  devices[0]!.request.resolve(); await flush(); assert.equal(first.stops, 1); assert.equal(starts.length, 2);
  ui.toggle(); ui.change('also-ignored'); ui.refresh();
  assert.equal(starts.length, 2); assert.equal(devices.length, 1); assert.equal(ui.testDisabled(), true);
  starts[1]!.resolve(replacement); await flush(); assert.equal(ui.preview(), replacement);
  assert.equal(ui.testDisabled(), false); assert.equal(ui.inputDisabled(), false); assert.equal(ui.selected(), 'new-mic');
  ui.toggle(); await flush(); assert.equal(replacement.stops, 1); assert.equal(ui.preview(), null);
});

it('blocks reentrant preview and device handlers while initial permission is pending', async () => {
  const { ui, starts, devices } = setup(); ui.toggle(); ui.toggle(); ui.change('ignored'); ui.refresh();
  assert.equal(starts.length, 1); assert.equal(devices.length, 0);
  assert.equal(ui.testDisabled(), true); assert.equal(ui.inputDisabled(), true);
  starts[0]!.resolve(preview()); await flush(); ui.toggle(); await flush();
});

for (const oldFirst of [true, false]) {
  it(`late preview ownership survives leave/rejoin (${oldFirst ? 'old' : 'new'} capture completes first)`, async () => {
    const { ui, starts } = setup(); const old = preview(), current = preview();
    ui.toggle(); ui.reset(); ui.toggle(); assert.equal(starts.length, 2);
    if (oldFirst) {
      starts[0]!.resolve(old); await flush(); assert.equal(old.stops, 1);
      assert.equal(ui.testDisabled(), true); assert.equal(ui.inputDisabled(), true);
      starts[1]!.resolve(current); await flush();
    } else {
      starts[1]!.resolve(current); await flush(); starts[0]!.resolve(old); await flush();
    }
    assert.equal(ui.preview(), current); assert.equal(old.stops, 1); assert.equal(current.stops, 0);
    ui.toggle(); await flush(); assert.equal(current.stops, 1);
  });
}

it('late old rejection does not show an error or unlock a replacement capture', async () => {
  const { ui, starts } = setup(); ui.toggle(); ui.reset(); ui.toggle();
  starts[0]!.reject(new Error('old cancellation')); await flush();
  assert.equal(ui.errors.length, 0); assert.equal(ui.testDisabled(), true); assert.equal(ui.inputDisabled(), true);
  starts[1]!.resolve(preview()); await flush(); ui.reset();
});

it('an old device change cannot restart preview or overwrite selection after leave/rejoin', async () => {
  const { ui, starts, devices } = setup(); const first = preview();
  ui.toggle(); starts[0]!.resolve(first); await flush(); ui.change('old-device'); ui.reset(); ui.toggle();
  devices[0]!.request.resolve(); await flush();
  assert.equal(starts.length, 2); assert.equal(ui.selected(), ''); assert.equal(first.stops, 1);
  assert.equal(ui.testDisabled(), true); starts[1]!.resolve(preview()); await flush(); ui.reset();
});

it('replacement preview failure releases both controls and permits retry', async () => {
  const { ui, starts, devices } = setup(); const first = preview();
  ui.toggle(); starts[0]!.resolve(first); await flush(); ui.change('new-device');
  devices[0]!.request.resolve(); await flush(); starts[1]!.reject(new Error('permission denied')); await flush();
  assert.equal(first.stops, 1); assert.equal(ui.preview(), null); assert.deepEqual([...ui.errors], ['permission denied']);
  assert.equal(ui.testDisabled(), false); assert.equal(ui.inputDisabled(), false);
  ui.toggle(); starts[2]!.resolve(preview()); await flush(); ui.reset();
});

it('preserves on-stage restrictions and stops a preview granted after stepping on stage', async () => {
  const { ui, client, starts } = setup(); client.me.onStage = true; ui.refresh(); ui.toggle(); await flush();
  assert.equal(starts.length, 0); assert.equal(ui.testDisabled(), true);
  client.me.onStage = false; ui.refresh(); ui.toggle(); client.me.onStage = true; ui.refresh();
  const late = preview(); starts[0]!.resolve(late); await flush();
  assert.equal(late.stops, 1); assert.equal(ui.preview(), null); assert.equal(ui.testDisabled(), true);
});

it('disposes a late device-replacement preview without replacing the new room preview', async () => {
  const { ui, starts, devices } = setup(); const first = preview(), retired = preview(), current = preview();
  ui.toggle(); starts[0]!.resolve(first); await flush(); ui.change('replacement');
  devices[0]!.request.resolve(); await flush(); assert.equal(starts.length, 2);
  ui.reset(); ui.toggle(); starts[1]!.resolve(retired); await flush();
  assert.equal(first.stops, 1); assert.equal(retired.stops, 1); assert.equal(ui.testDisabled(), true);
  starts[2]!.resolve(current); await flush(); assert.equal(ui.preview(), current); assert.equal(current.stops, 0);
  ui.reset(); assert.equal(current.stops, 1);
});

it('a rejected device selection retains the existing preview and permits another selection', async () => {
  const { ui, starts, devices } = setup(); const active = preview();
  ui.toggle(); starts[0]!.resolve(active); await flush(); ui.change('missing');
  devices[0]!.request.reject(new Error('device unavailable')); await flush();
  assert.equal(ui.preview(), active); assert.equal(active.stops, 0); assert.equal(ui.selected(), '');
  assert.equal(ui.testDisabled(), false); assert.equal(ui.inputDisabled(), false);
  ui.change('working'); assert.equal(devices.length, 2); devices[1]!.request.resolve(); await flush();
  starts[1]!.resolve(preview()); await flush(); assert.equal(ui.selected(), 'working'); assert.equal(active.stops, 1);
  ui.reset();
});
