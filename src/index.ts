import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, samplesPerFrame } from './config.ts';
import { createLogger } from './log.ts';
import { MixerCounters, processSamples, renderPrometheus } from './metrics.ts';
import { MixerClock } from './mixer/MixerClock.ts';
import { RoomMixer } from './mixer/RoomMixer.ts';
import { startRecording } from './recording/recorder.ts';
import { loadState, saveState } from './persistence.ts';
import { WeriftMediaTransport } from './transport/WeriftMediaTransport.ts';
import { StageHub } from './ws/hub.ts';
import { createStageServer } from './ws/server.ts';

/** Repo root: `src/index.ts` (dev) lives one level down, `dist/src/index.js` (built) two. */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, basename(dirname(here)) === 'dist' ? '../..' : '..');

const configPath = resolve(process.env.STAGE_CONFIG ?? resolve(root, 'config.yaml'));
let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`config error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const log = createLogger(config.log.level);
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

let hub: StageHub | undefined;
const transport = new WeriftMediaTransport(
  config,
  {
    // Late-bound: the hub needs the transport, the transport reports back to the hub.
    onLocalCandidate: (roomId, pid, candidate) => hub?.onLocalCandidate(roomId, pid, candidate),
    onPeerClosed: (roomId, pid) => hub?.onPeerClosed(roomId, pid),
  },
  log,
);
const audio = config.audio;
const mixerCounters = new MixerCounters();
const mixerClock = new MixerClock(audio.frameMs, mixerCounters);
const stageHub = new StageHub({
  config,
  transport,
  log,
  serverVersion: version,
  createMixer: () => {
    const mixer = new RoomMixer({
      sampleRate: audio.sampleRate,
      frameMs: audio.frameMs,
      maxBufferedFrames: audio.mixer.maxBufferedFrames,
      playoutFrames: audio.jitter.playoutFrames,
      limiterThreshold: audio.mixer.limiterThreshold,
      speakingThreshold: audio.mixer.speakingThreshold,
      speakingHoldMs: audio.mixer.speakingHoldMs,
      ...(audio.noiseFilter.enabled && { noiseFilter: audio.noiseFilter }),
      ...(audio.loudness.enabled && { loudness: audio.loudness }),
    }, mixerCounters);
    mixer.start(mixerClock);
    return mixer;
  },
  startRecording: (roomId) => startRecording({
    dir: resolve(root, config.recording.dir),
    roomId,
    frameSamples: samplesPerFrame(audio),
    vendor: `Stage.js ${version}`,
    now: Date.now(),
    log,
  }),
});
hub = stageHub;

const stateFile = config.persistence.stateFile && resolve(root, config.persistence.stateFile);
let saveTimer: NodeJS.Timeout | undefined;
let saving: Promise<void> = Promise.resolve();
if (stateFile) {
  const saved = loadState(stateFile, config.persistence.restoreGraceMs, Date.now(), log);
  if (saved) log.info('rooms restored from state file', { restored: stageHub.restore(saved), saved: saved.rooms.length });
  let savedRevision = -1;
  const save = () => {
    const revision = stageHub.stateRevision;
    if (revision === savedRevision) return;
    savedRevision = revision;
    saving = saving.then(() => saveState(stateFile, stageHub.exportState())).catch((err: Error) => log.error('state file write failed', { error: err.message }));
  };
  // Written right away too, so a restored-but-unchanged state is not lost to an early crash.
  save();
  saveTimer = setInterval(save, config.persistence.saveIntervalMs);
  saveTimer.unref();
}

const processMetrics = processSamples();
const server = createStageServer({
  config,
  hub: stageHub,
  log,
  baseDir: root,
  metrics: async () => renderPrometheus([...stageHub.metrics(), ...await transport.metrics(), ...mixerCounters.samples(), ...processMetrics()]),
});
const addr = await server.listen();
const secure = config.server.tls.certFile !== '';
log.info('Stage.js listening', {
  url: `${secure ? 'https' : 'http'}://${config.server.host}:${addr.port}`,
  ws: `${secure ? 'wss' : 'ws'}://${config.server.host}:${addr.port}${config.server.wsPath}`,
  insecure: !secure,
  version,
});

let stopping = false;
const stop = async (signal: string, code = 0) => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  clearInterval(saveTimer);
  // With persistence, rooms survive the restart: clients just reconnect and resume their seats.
  await server.close(Boolean(stateFile));
  if (stateFile) {
    await saving;
    await saveState(stateFile, stageHub.exportState()).catch((err: Error) => log.error('state file write failed', { error: err.message }));
  }
  await transport.close();
  process.exit(code);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
// A stray rejection (typically a WebRTC stack timer firing after a peer closed) is logged, not fatal:
// Node's default would take every room down. An uncaught exception may have left state inconsistent,
// so the process stops (rooms closed, or saved for restore — each one is re-validated then) and exits
// non-zero for the supervisor.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception, shutting down', { error: err.stack ?? String(err) });
  void stop('uncaughtException', 1);
});
