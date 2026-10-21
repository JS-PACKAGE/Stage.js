import { monitorEventLoopDelay } from 'node:perf_hooks';

export type MetricSample =
  | { name: string; help: string; type: 'counter' | 'gauge'; value: number }
  | { name: string; help: string; type: 'histogram'; histogram: Histogram };

/** Prometheus text exposition format (0.0.4). */
export function renderPrometheus(samples: MetricSample[]): string {
  let out = '';
  for (const s of samples) {
    out += `# HELP ${s.name} ${s.help}\n# TYPE ${s.name} ${s.type}\n`;
    if (s.type !== 'histogram') { out += `${s.name} ${Number.isFinite(s.value) ? s.value : 0}\n`; continue; }
    const h = s.histogram;
    let cumulative = 0;
    h.bounds.forEach((le, i) => { cumulative += h.counts[i]!; out += `${s.name}_bucket{le="${le}"} ${cumulative}\n`; });
    out += `${s.name}_bucket{le="+Inf"} ${h.count}\n${s.name}_sum ${h.sum}\n${s.name}_count ${h.count}\n`;
  }
  return out;
}

/** Fixed-bucket histogram (seconds); `observe` allocates nothing, so it can sit on per-frame paths. */
export class Histogram {
  readonly bounds: readonly number[];
  /** Per-bucket (not cumulative) counts; the last slot is beyond the largest bound. */
  readonly counts: number[];
  sum = 0;
  count = 0;
  constructor(bounds: readonly number[]) {
    this.bounds = bounds;
    this.counts = new Array<number>(bounds.length + 1).fill(0);
  }
  observe(value: number): void {
    let i = 0;
    while (i < this.bounds.length && value > this.bounds[i]!) i++;
    this.counts[i]!++;
    this.sum += value;
    this.count++;
  }
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
