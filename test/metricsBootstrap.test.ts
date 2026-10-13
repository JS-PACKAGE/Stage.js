import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderPrometheus, type MetricSample } from '../src/metrics.ts';

const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const metricsSource = readFileSync(new URL('../src/metrics.ts', import.meta.url), 'utf8');
const bootstrapMarker = 'const processMetrics =';
const bootstrapEnd = 'const secure =';
const samplerMarker = 'export function processSamples()';
for (const marker of [bootstrapMarker, bootstrapEnd]) assert.equal(indexSource.split(marker).length, 2);
assert.equal(metricsSource.split(samplerMarker).length, 2);
const bootstrapSource = indexSource.slice(indexSource.indexOf(bootstrapMarker), indexSource.indexOf(bootstrapEnd));
const samplerSource = metricsSource.slice(metricsSource.indexOf(samplerMarker)).replace('export function', 'function');

async function fixture(enabled: boolean) {
  const calls: string[] = [];
  const reads = { hub: 0, transport: 0, mixer: 0, memory: 0, cpu: 0, percentile: 0, max: 0 };
  let monitorCreations = 0, monitorEnables = 0;
  let collect: (() => Promise<string>) | undefined;
  // Evaluate the real sampler and CLI wiring, without starting media, a native timer or a listener.
  const processSamples = runInNewContext(stripTypeScriptTypes(`${samplerSource}\nprocessSamples;`), {
    monitorEventLoopDelay(options: { resolution: number }) {
      assert.equal(options.resolution, 10);
      calls.push('monitor.create'); monitorCreations++;
      return {
        enable() { calls.push('monitor.enable'); monitorEnables++; },
        percentile(percent: number) { assert.equal(percent, 99); reads.percentile++; return 19_000_000; },
        get max() { reads.max++; return 25_000_000; },
      };
    },
    process: {
      memoryUsage() { reads.memory++; return { rss: 1024, heapUsed: 512 }; },
      cpuUsage() { reads.cpu++; return { user: 1000, system: 2000 }; },
    },
  }, { timeout: 1000, filename: 'metrics-sampler.vm.js' }) as () => () => MetricSample[];
  const sample = (name: string, value: number): MetricSample[] => [{ name, help: name, type: 'gauge', value }];
  await runInNewContext(stripTypeScriptTypes(`(async () => {\n${bootstrapSource}\n})();`), {
    config: { server: { metrics: { enabled } } }, processSamples, renderPrometheus,
    stageHub: { metrics() { return sample('fixture_hub', ++reads.hub); } },
    transport: { async metrics() { return sample('fixture_transport', ++reads.transport); } },
    mixerCounters: { samples() { return sample('fixture_mixer', ++reads.mixer); } },
    log: {}, root: '/synthetic',
    createStageServer(deps: { metrics: () => Promise<string> }) {
      calls.push('server.create'); collect = deps.metrics;
      return { async listen() { calls.push('server.listen'); return { port: 0 }; } };
    },
  }, { timeout: 1000, filename: 'metrics-bootstrap.vm.js' });
  assert.ok(collect);
  return { calls, reads, collect, monitors: () => ({ created: monitorCreations, enabled: monitorEnables }) };
}

const noReads = { hub: 0, transport: 0, mixer: 0, memory: 0, cpu: 0, percentile: 0, max: 0 };
function values(text: string): string[] { return text.trim().split('\n').filter(line => !line.startsWith('#')); }

it('CLI metrics disabled does not construct or enable the periodic process sampler', async () => {
  const h = await fixture(false);
  assert.deepEqual(h.calls, ['server.create', 'server.listen']);
  assert.deepEqual(h.monitors(), { created: 0, enabled: 0 });
  assert.deepEqual(h.reads, noReads);
  // The HTTP route gates this callback. Direct invocation still has no process-sampling side effects.
  for (let count = 1; count <= 2; count++) {
    assert.deepEqual(values(await h.collect()), [`fixture_hub ${count}`, `fixture_transport ${count}`, `fixture_mixer ${count}`]);
    assert.deepEqual(h.reads, { ...noReads, hub: count, transport: count, mixer: count });
    assert.deepEqual(h.monitors(), { created: 0, enabled: 0 });
  }
});

it('CLI enabled metrics starts its single histogram before listening and preserves it across scrapes', async () => {
  const h = await fixture(true);
  assert.deepEqual(h.calls, ['monitor.create', 'monitor.enable', 'server.create', 'server.listen']);
  assert.deepEqual(h.monitors(), { created: 1, enabled: 1 });
  assert.deepEqual(h.reads, noReads, 'startup begins since-start monitoring without prematurely collecting metrics');
  for (let count = 1; count <= 2; count++) {
    assert.deepEqual(values(await h.collect()), [
      `fixture_hub ${count}`, `fixture_transport ${count}`, `fixture_mixer ${count}`,
      'stage_event_loop_delay_p99_ms 9', 'stage_event_loop_delay_max_ms 15',
      'stage_process_cpu_seconds_total 0.003', 'stage_process_rss_bytes 1024', 'stage_process_heap_used_bytes 512',
    ]);
    assert.deepEqual(h.reads, { hub: count, transport: count, mixer: count, memory: count, cpu: count, percentile: count, max: count });
    assert.deepEqual(h.monitors(), { created: 1, enabled: 1 }, 'scrapes must not reset the histogram history');
  }
});
