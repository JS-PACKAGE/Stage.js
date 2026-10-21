import assert from 'node:assert/strict';
import { it } from 'node:test';
import { flushSample, roomState, sampleApp, SamplePreview } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
const key = 'stage-playback';
const record = (volume: number, muted: boolean): string => JSON.stringify({ version: 1, volume, muted });
function storage(initial?: string) {
  const values = new Map<string, string>([['stage-theme', 'dark']]);
  if (initial !== undefined) values.set(key, initial);
  const reads: string[] = [], writes: { key: string; value: string }[] = [];
  return {
    values, reads, writes,
    getItem(key: string): string | null { reads.push(key); return values.get(key) ?? null; },
    setItem(key: string, value: string): void { writes.push({ key, value }); values.set(key, value); },
  };
}
function assertPlayback(h: App, volume: number, muted: boolean): void {
  assert.equal(h.sdk.playbackVolume, volume);
  assert.equal(h.sdk.playbackMuted, muted);
  assert.equal(h.id('playback-volume').value, String(Math.round(volume * 100)));
  assert.equal(h.id('playback-mute').attributes['aria-pressed'], String(muted));
  assert.equal(h.id('playback-mute').textContent, muted ? '恢復收聽' : '靜音收聽');
}
function inputVolume(h: App, percent: number): void {
  const input = h.id('playback-volume'); input.value = String(percent);
  assert.ok(input.oninput); input.oninput();
  const output = h.find(node => node.tagName === 'output' && node.htmlFor.value === input.id);
  assert.equal(output.value, `${percent}%`);
}
function assertSaved(s: ReturnType<typeof storage>, volume: number, muted: boolean): void {
  const last = s.writes.at(-1); assert.ok(last);
  assert.equal(last.key, key);
  assert.deepEqual(JSON.parse(last.value), { version: 1, volume, muted });
  assert.ok(last.value.length <= 128);
}

it('whole sample leaves SDK playback defaults and storage untouched when no preference exists', async t => {
  const localStorage = storage(), h = sampleApp({ localStorage }); t.after(() => h.cleanup());
  assertPlayback(h, 1, false); await flushSample();
  assert.deepEqual(localStorage.reads, [key, 'stage-theme']);
  assert.deepEqual(localStorage.writes, []);
  assert.equal(localStorage.values.has(key), false);
  assert.equal(h.sdk.previews.length, 0);
  assert.equal(h.sdk.joins.length, 0);
});

for (const volume of [0, 1, 0.37, 0.005]) {
  for (const muted of [false, true]) {
    it(`whole sample restores volume ${volume} and muted ${muted} before the first controls without writing`, async t => {
      const localStorage = storage(record(volume, muted)), h = sampleApp({ localStorage }); t.after(() => h.cleanup());
      assertPlayback(h, volume, muted);
      const output = h.find(node => node.tagName === 'output' && node.htmlFor.value === 'playback-volume');
      assert.equal(output.textContent, `${Math.round(volume * 100)}%`);
      await flushSample(); assertPlayback(h, volume, muted);
      assert.deepEqual(localStorage.reads, [key, 'stage-theme']);
      assert.deepEqual(localStorage.writes, []);
      assert.equal(localStorage.values.get(key), record(volume, muted));
      assert.equal(h.sdk.state, null);
      assert.equal(h.sdk.previews.length, 0);
      assert.deepEqual(h.sdk.inputDevices, []); assert.deepEqual(h.sdk.outputDevices, []);
    });
  }
}

const invalid: [string, string][] = [
  ['empty text', ''], ['malformed JSON', '{'], ['null', 'null'], ['array', '[]'],
  ['array of records', '[{"version":1,"volume":0.2,"muted":true}]'],
  ['string', '"preferences"'], ['number', '1'], ['boolean', 'true'], ['empty object', '{}'],
  ['missing version', '{"volume":0.2,"muted":true}'],
  ['missing volume', '{"version":1,"muted":true}'],
  ['missing muted', '{"version":1,"volume":0.2}'],
  ['old version', '{"version":0,"volume":0.2,"muted":true}'],
  ['future version', '{"version":2,"volume":0.2,"muted":true}'],
  ['string version', '{"version":"1","volume":0.2,"muted":true}'],
  ['object version', '{"version":{},"volume":0.2,"muted":true}'],
  ['negative volume', '{"version":1,"volume":-0.01,"muted":true}'],
  ['excess volume', '{"version":1,"volume":1.01,"muted":true}'],
  ['infinite volume', '{"version":1,"volume":1e309,"muted":true}'],
  ['negative infinite volume', '{"version":1,"volume":-1e309,"muted":true}'],
  ['null volume', '{"version":1,"volume":null,"muted":true}'],
  ['string volume', '{"version":1,"volume":"0.2","muted":true}'],
  ['boolean volume', '{"version":1,"volume":false,"muted":true}'],
  ['array volume', '{"version":1,"volume":[],"muted":true}'],
  ['object volume', '{"version":1,"volume":{},"muted":true}'],
  ['null muted', '{"version":1,"volume":0.2,"muted":null}'],
  ['string muted', '{"version":1,"volume":0.2,"muted":"false"}'],
  ['numeric muted', '{"version":1,"volume":0.2,"muted":0}'],
  ['array muted', '{"version":1,"volume":0.2,"muted":[]}'],
  ['object muted', '{"version":1,"volume":0.2,"muted":{}}'],
];
for (const [label, raw] of invalid) {
  it(`whole sample rejects the entire ${label} playback record without partial restore or repair writes`, async t => {
    const localStorage = storage(raw), h = sampleApp({ localStorage }); t.after(() => h.cleanup());
    assertPlayback(h, 1, false); await flushSample();
    assert.deepEqual(localStorage.writes, []);
    assert.equal(localStorage.values.get(key), raw);
    assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);
  });
}

for (const length of [128, 129]) {
  it(`whole sample ${length === 128 ? 'accepts' : 'rejects'} a ${length}-character raw playback record`, async t => {
    const raw = record(0.2, true).padEnd(length, ' ');
    assert.equal(raw.length, length);
    const localStorage = storage(raw), h = sampleApp({ localStorage }); t.after(() => h.cleanup());
    assertPlayback(h, length === 128 ? 0.2 : 1, length === 128);
    await flushSample(); assert.deepEqual(localStorage.writes, []);
    assert.equal(localStorage.values.get(key), raw);
  });
}

it('whole sample writes only explicit volume and mute choices, keeping volume, playback mute, and microphone mute independent', async t => {
  const localStorage = storage(), h = sampleApp({ localStorage }); t.after(() => h.cleanup());
  h.sdk.snapshot(roomState({ muted: true })); await flushSample();
  assert.deepEqual(localStorage.writes, []);
  inputVolume(h, 0); assertPlayback(h, 0, false); assertSaved(localStorage, 0, false);
  assert.equal(localStorage.writes.length, 1);
  h.id('playback-mute').click(); await flushSample();
  assertPlayback(h, 0, true); assertSaved(localStorage, 0, true);
  assert.equal(localStorage.writes.length, 2);
  inputVolume(h, 37); assertPlayback(h, 0.37, true); assertSaved(localStorage, 0.37, true);
  assert.equal(localStorage.writes.length, 3);
  h.id('playback-mute').click(); await flushSample();
  assertPlayback(h, 0.37, false); assertSaved(localStorage, 0.37, false);
  assert.equal(localStorage.writes.length, 4);
  inputVolume(h, 100); assertPlayback(h, 1, false); assertSaved(localStorage, 1, false);
  assert.equal(localStorage.writes.length, 5);
  assert.equal(h.sdk.me?.muted, true);
  assert.equal(h.sdk.previews.length, 0);
  assert.deepEqual(h.sdk.inputDevices, []); assert.deepEqual(h.sdk.outputDevices, []);
  assert.equal(localStorage.values.get('stage-theme'), 'dark');
  assert.deepEqual([...localStorage.values.keys()], ['stage-theme', key]);
});

it('whole sample preserves local choices through redraws, reconnect, leave, and a fresh module reload without extra writes', async t => {
  const localStorage = storage(record(0.61, true)), first = sampleApp({ localStorage }); t.after(() => first.cleanup());
  inputVolume(first, 29); first.id('playback-mute').click(); await flushSample();
  assertPlayback(first, 0.29, false); assertSaved(localStorage, 0.29, false);
  const volume = first.id('playback-volume'), mute = first.id('playback-mute');
  const writes = [...localStorage.writes], reads = [...localStorage.reads];
  for (let i = 0; i < 3; i++) first.sdk.snapshot(roomState());
  first.sdk.setStatus('reconnecting'); first.sdk.snapshot(roomState());
  first.clock.advance(2000); assert.equal(first.sdk.polls.length, 1);
  first.sdk.polls[0]!.resolve({ inbound: { rtt: 0.04 }, outbound: null }); await flushSample();
  first.dispatchDeviceChange(); await flushSample();
  await first.sdk.disconnect(); await flushSample();
  assertPlayback(first, 0.29, false);
  assert.equal(first.id('playback-volume'), volume); assert.equal(first.id('playback-mute'), mute);
  assert.deepEqual(localStorage.writes, writes); assert.deepEqual(localStorage.reads, reads);
  await first.cleanup();

  const reloaded = sampleApp({ localStorage }); t.after(() => reloaded.cleanup());
  assert.notEqual(reloaded.sdk, first.sdk); assert.notEqual(reloaded.app, first.app);
  assertPlayback(reloaded, 0.29, false); await flushSample();
  assert.deepEqual(localStorage.writes, writes);
  assert.deepEqual(localStorage.reads, [...reads, key, 'stage-theme']);
  // The saved value is read once at module startup, not used as live cross-tab state.
  localStorage.values.set(key, record(0.9, true));
  reloaded.sdk.snapshot(roomState()); reloaded.sdk.setStatus('reconnecting'); reloaded.sdk.snapshot(roomState());
  assertPlayback(reloaded, 0.29, false);
  assert.deepEqual(localStorage.reads, [...reads, key, 'stage-theme']);
  assert.deepEqual(localStorage.writes, writes);
});

it('whole sample tolerates blocked storage reads and still applies and saves explicit local controls', async t => {
  const localStorage = storage(record(0.2, true));
  localStorage.getItem = key => { localStorage.reads.push(key); throw new Error('Storage access denied'); };
  const h = sampleApp({ localStorage }); t.after(() => h.cleanup()); await flushSample();
  assertPlayback(h, 1, false); assert.deepEqual(localStorage.writes, []);
  inputVolume(h, 45); h.id('playback-mute').click(); await flushSample();
  assertPlayback(h, 0.45, true); assertSaved(localStorage, 0.45, true);
  assert.equal(localStorage.writes.length, 2);
  assert.equal(h.id('playback-mute').disabled, false);
  assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);
});

it('whole sample tolerates blocked storage writes without reverting local controls or showing a playback error', async t => {
  const initial = record(0.2, true), localStorage = storage(initial);
  localStorage.setItem = (key, value) => { localStorage.writes.push({ key, value }); throw new Error('Storage quota exceeded'); };
  const h = sampleApp({ localStorage }); t.after(() => h.cleanup()); await flushSample();
  assertPlayback(h, 0.2, true); assert.deepEqual(localStorage.writes, []);
  inputVolume(h, 73); assertPlayback(h, 0.73, true);
  h.id('playback-mute').click(); await flushSample();
  assertPlayback(h, 0.73, false); assertSaved(localStorage, 0.73, false);
  assert.equal(localStorage.writes.length, 2);
  assert.equal(localStorage.values.get(key), initial);
  assert.equal(h.id('playback-mute').disabled, false);
  assert.equal(h.find(node => node.attributes.role === 'alert').hidden, true);
});

it('whole sample saves a fresh whitelist-only record rather than forwarding unrecognized stored fields', async t => {
  const raw = JSON.stringify({ version: 1, volume: 0.2, muted: true, roomId: 'private-room', deviceId: 'private-mic' });
  assert.ok(raw.length <= 128);
  const localStorage = storage(raw), h = sampleApp({ localStorage }); t.after(() => h.cleanup()); await flushSample();
  assert.equal(localStorage.writes.length, 0);
  inputVolume(h, 46); h.id('playback-mute').click(); await flushSample();
  assert.equal(localStorage.writes.length, 2);
  for (const write of localStorage.writes) {
    assert.equal(write.key, key);
    assert.deepEqual(Object.keys(JSON.parse(write.value)).sort(), ['muted', 'version', 'volume']);
    assert.doesNotMatch(write.value, /private-room|private-mic/);
  }
});

it('whole sample keeps theme changes separate and never saves device choices or microphone preview state', async t => {
  const saved = record(0.35, true), localStorage = storage(saved), h = sampleApp({ localStorage }); t.after(() => h.cleanup());
  await flushSample();
  const theme = h.find(node => node.tagName === 'select' && node.attributes['aria-label'] === '色彩主題');
  assert.equal(theme.value, 'dark'); theme.value = 'light'; assert.ok(theme.onchange); theme.onchange();
  assert.deepEqual(localStorage.writes, [{ key: 'stage-theme', value: 'light' }]);
  const input = h.id('microphone-device'), output = h.id('speaker-device');
  input.value = 'private-mic'; assert.ok(input.onchange); input.onchange(); await flushSample();
  output.value = 'private-speaker'; assert.ok(output.onchange); output.onchange(); await flushSample();
  h.id('mic-test').click();
  const preview = new SamplePreview(0.4), request = h.sdk.previews[0]; assert.ok(request);
  h.sdk.grantPreview(request, preview); await flushSample();
  h.clock.advance(50); h.id('mic-test').click(); await flushSample();
  assert.equal(preview.stopped, true);
  assert.deepEqual(h.sdk.inputDevices, ['private-mic']); assert.deepEqual(h.sdk.outputDevices, ['private-speaker']);
  assertPlayback(h, 0.35, true);
  assert.deepEqual(localStorage.writes, [{ key: 'stage-theme', value: 'light' }]);
  assert.equal(localStorage.values.get(key), saved);
  assert.deepEqual([...localStorage.values.keys()], ['stage-theme', key]);
});
