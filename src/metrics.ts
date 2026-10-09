import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface MetricSample {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  value: number;
}

/** Prometheus text exposition format (0.0.4). */
export function renderPrometheus(samples: MetricSample[]): string {
  let out = '';
  for (const s of samples) out += `# HELP ${s.name} ${s.help}\n# TYPE ${s.name} ${s.type}\n${s.name} ${Number.isFinite(s.value) ? s.value : 0}\n`;
  return out;
}

/** Monotonic counters shared by every room mixer (rooms come and go; totals must not drop). */
export class MixerCounters {
  ticks = 0;
  /** A primed source ran dry and had to re-buffer. */
  underruns = 0;
  /** Frames dropped because a source's queue was full or drifted past twice the playout target. */
  droppedFrames = 0;
  /** Ticks that started more than one frame late (event loop stalled). */
  lateTicks = 0;
  maxTickLagMs = 0;
  samples(): MetricSample[] {
    return [
      { name: 'stage_mixer_ticks_total', help: 'Mixer ticks across all rooms.', type: 'counter', value: this.ticks },
      { name: 'stage_mixer_underruns_total', help: 'Uplink jitter-buffer underruns (re-priming).', type: 'counter', value: this.underruns },
      { name: 'stage_mixer_dropped_frames_total', help: 'Uplink PCM frames dropped for overflow or clock drift.', type: 'counter', value: this.droppedFrames },
      { name: 'stage_mixer_late_ticks_total', help: 'Mixer ticks that started over one frame late.', type: 'counter', value: this.lateTicks },
      { name: 'stage_mixer_max_tick_lag_ms', help: 'Worst mixer tick lateness since start.', type: 'gauge', value: this.maxTickLagMs },
    ];
  }
}

/** Event-loop delay and memory of this process. */
export function processSamples(): () => MetricSample[] {
  const resolutionMs = 10;
  const loop = monitorEventLoopDelay({ resolution: resolutionMs });
  loop.enable();
  // The histogram records the whole sampling interval, so an idle loop reads ≈ resolution; report the excess.
  const delayMs = (ns: number) => Math.max(0, ns / 1e6 - resolutionMs);
  return () => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return [
      { name: 'stage_event_loop_delay_p99_ms', help: 'Main event-loop delay, 99th percentile since start.', type: 'gauge', value: delayMs(loop.percentile(99)) },
      { name: 'stage_event_loop_delay_max_ms', help: 'Main event-loop delay, maximum since start.', type: 'gauge', value: delayMs(loop.max) },
      { name: 'stage_process_cpu_seconds_total', help: 'User + system CPU time of all threads.', type: 'counter', value: (cpu.user + cpu.system) / 1e6 },
      { name: 'stage_process_rss_bytes', help: 'Resident set size.', type: 'gauge', value: mem.rss },
      { name: 'stage_process_heap_used_bytes', help: 'V8 heap in use.', type: 'gauge', value: mem.heapUsed },
    ];
  };
}
