import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import { loadState, saveState } from '../src/persistence.ts';
import { silentLogger } from '../src/log.ts';
import { harness, testConfig } from './helpers.ts';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const startup = source.slice(source.indexOf('const stateFile ='), source.indexOf('const processMetrics ='));
it('production saver refreshes a quiet room beyond restoreGraceMs and retries a failed write', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-persistence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = testConfig(c => { c.persistence.stateFile = 'state.json'; c.persistence.restoreGraceMs = 2000; });
  const h = harness(config); await h.create(); t.after(() => h.hub.shutdown());
  let tick!: () => void, failures = 1, writes = 0;
  const errors: unknown[] = [];
  const saver = runInNewContext(stripTypeScriptTypes(`${startup}\n({ drain: () => saving });`), {
    config, root: dir, resolve, stageHub: h.hub, Date: { now: () => h.clock.now }, loadState,
    log: { ...silentLogger, error: (_: string, error: unknown) => errors.push(error) },
    setInterval(callback: () => void) { tick = callback; return { unref() {} }; },
    saveState: async (file: string, state: Parameters<typeof saveState>[1]) => {
      writes++; if (failures-- > 0) throw new Error('temporary disk failure');
      await saveState(file, state);
    },
  }) as { drain(): Promise<void> };
  await saver.drain(); assert.equal(errors.length, 1);
  const revision = h.hub.stateRevision;
  for (let i = 0; i < 5; i++) { h.clock.now += 1000; tick(); tick(); await saver.drain(); }
  assert.equal(writes, 6, 'one pending write despite overlapping ticks');
  assert.equal(h.hub.stateRevision, revision, 'no control activity');
  const saved = loadState(join(dir, 'state.json'), config.persistence.restoreGraceMs, h.clock.now, silentLogger);
  assert.ok(saved); assert.equal(saved.savedAt, h.clock.now); assert.equal(saved.rooms.length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).savedAt, h.clock.now);
});

it('production recording wiring uses 48 kHz granules for every supported input rate', () => {
  const recording = source.slice(source.indexOf('  startRecording: (roomId)'), source.indexOf('\n});\nhub = stageHub;'));
  for (const sampleRate of [8000, 12000, 16000, 24000, 48000]) for (const frameMs of [10, 20, 40, 60]) {
    const factory = runInNewContext(stripTypeScriptTypes(`({${recording}})`), {
      audio: { sampleRate, frameMs }, config: { recording: { dir: 'recordings' } }, root: '/tmp', resolve,
      version: 'test', log: silentLogger, startRecording: (options: unknown) => options,
    }) as { startRecording(roomId: string): { frameSamples: number } };
    assert.equal(factory.startRecording('room').frameSamples, frameMs * 48);
  }
});

it('existing main configurations keep recording and persistence opt-in', async () => {
  const { parseConfig } = await import('../src/config.ts');
  const { parse } = await import('yaml');
  const raw = parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
  delete raw.recording; delete raw.persistence; delete raw.rooms.chatHistory;
  delete raw.limits.chatMaxLength; delete raw.limits.chatIntervalMs; delete raw.limits.reactionIntervalMs;
  const config = parseConfig(raw);
  assert.equal(config.recording.enabled, false); assert.equal(config.persistence.stateFile, '');
  assert.equal(config.rooms.chatHistory, 50); assert.equal(config.limits.chatMaxLength, 500);
});
