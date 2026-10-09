import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { RoomMixer } from './mixer/RoomMixer.ts';
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
hub = new StageHub({
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
    });
    mixer.start();
    return mixer;
  },
});

const server = createStageServer({ config, hub, log, baseDir: root });
const addr = await server.listen();
const secure = config.server.tls.certFile !== '';
log.info('Stage.js listening', {
  url: `${secure ? 'https' : 'http'}://${config.server.host}:${addr.port}`,
  ws: `${secure ? 'wss' : 'ws'}://${config.server.host}:${addr.port}${config.server.wsPath}`,
  insecure: !secure,
  version,
});

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  await server.close();
  await transport.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
