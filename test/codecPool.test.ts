import { test } from 'node:test';
import assert from 'node:assert/strict';
import { silentLogger } from '../src/log.ts';
import { CodecPool } from '../src/transport/codecPool.ts';
import { testConfig } from './helpers.ts';

test('codec workers encode concurrently without corrupting each other', async () => {
  const audio = testConfig(c => { c.audio.codecWorkers = 2; }).audio;
  const pool = new CodecPool(audio, silentLogger);
  try {
    const tone = (freq: number, f: number) => Float32Array.from({ length: 960 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * freq * (f * 960 + i) / 48000));
    // Rooms are spread over both workers: a/b get the same stream on different threads, as do c/d.
    const rooms = ['a', 'b', 'c', 'd'];
    const out = new Map<string, string[]>(rooms.map(r => [r, []]));
    for (let f = 0; f < 150; f++) {
      const results = await Promise.all(rooms.map(r => pool.encode(r, [{ key: '', pcm: tone(r < 'c' ? 330 : 870, f) }])));
      results.forEach(([packet], i) => out.get(rooms[i]!)!.push(Buffer.from(packet!).toString('hex')));
    }
    // Identical input and codec state must give identical packets on either thread.
    assert.deepEqual(out.get('b'), out.get('a'));
    assert.deepEqual(out.get('d'), out.get('c'));
  } finally { await pool.close(); }
});
