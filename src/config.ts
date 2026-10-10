import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { parse } from 'yaml';
import type { IceServerConfig } from '../shared/protocol.ts';

export interface StaticMount {
  mount: string;
  dir: string;
  cors: boolean;
}

export interface AppConfig {
  server: {
    host: string;
    port: number;
    wsPath: string;
    allowInsecure: boolean;
    tls: { certFile: string; keyFile: string };
    static: StaticMount[];
    /** `GET /metrics` (Prometheus text). Non-empty `token` requires `Authorization: Bearer <token>`. */
    metrics: { enabled: boolean; token: string };
    /** Behind a reverse proxy: take the client address from `X-Forwarded-For` for per-IP limits. */
    trustProxy: boolean;
  };
  limits: {
    maxRooms: number;
    maxConnections: number;
    maxSpeakersPerRoom: number;
    maxAudiencePerRoom: number;
    maxFrameBytes: number;
    controlPerSecond: number;
    handRaiseIntervalMs: number;
    icePerSecond: number;
    nameMaxLength: number;
    codeMaxLength: number;
    sdpMaxLength: number;
    /** Connections that have not created or joined a room within this time are closed (0 = never). */
    joinTimeoutMs: number;
    /** Concurrent ws connections per client address (0 = unlimited). */
    maxConnectionsPerIp: number;
    /** Longest chat message in characters after sanitizing. */
    chatMaxLength: number;
    /** Minimum gap between one connection's chat messages (violation closes with 1008, like hand:raise). */
    chatIntervalMs: number;
    /** Minimum gap between one connection's reactions. */
    reactionIntervalMs: number;
  };
  rooms: {
    codeLength: number;
    controllerGraceMs: number;
    /** Non-controllers keep their seat, stage position, hand and media this long after a ws drop (0 = removed at once). */
    participantGraceMs: number;
    heartbeatIntervalMs: number;
    /** Audience joins/leaves are folded into one `room:state` broadcast per this many ms (0 = immediate). */
    presenceBroadcastMs: number;
    /** How often publishers' connection quality goes to the controller and stage (0 = never). */
    qualityIntervalMs: number;
    /** Chat messages kept per room and replayed to joiners (0 = no history). */
    chatHistory: number;
    /** Non-empty: `room:create` must carry this token (empty = anyone may create rooms). */
    createToken: string;
  };
  audio: {
    sampleRate: number;
    frameMs: number;
    codecWorkers: number;
    opus: {
      vbr: boolean;
      minBitrate: number;
      maxBitrate: number;
      bitrate: number;
      complexity: number;
      /** In-band forward error correction for the downlink. */
      fec: boolean;
      /** Expected downlink loss (0–100) the encoder provisions FEC for. */
      packetLossPercent: number;
      /** Discontinuous transmission: silent frames are not sent. */
      dtx: boolean;
    };
    /**
     * Audience listeners whose receiver reports show sustained loss get a second shared mix
     * encoded at `bitrate` with FEC provisioned for `packetLossPercent`; they return to the main
     * mix once loss falls to `exitLossPercent` (hysteresis keeps them from flapping).
     */
    lowTier: { enabled: boolean; bitrate: number; packetLossPercent: number; enterLossPercent: number; exitLossPercent: number };
    mixer: {
      maxBufferedFrames: number;
      limiterThreshold: number;
      /** Acceptance gate for scripts/bench-mixer.ts and load-test.ts only; the server does not use it. */
      latencyTargetMs: number;
      /** Frame RMS (0..1) at which a publisher counts as speaking. */
      speakingThreshold: number;
      /** How long the speaking state outlasts the last loud frame. */
      speakingHoldMs: number;
    };
    jitter: {
      /** Frames each uplink buffers before playing (latency vs. underrun trade-off). */
      playoutFrames: number;
      /** Out-of-order packets held behind a gap before the missing one is declared lost. */
      reorderPackets: number;
    };
    /** Server-side uplink high-pass + noise gate (in addition to the browser's noiseSuppression). */
    noiseFilter: {
      enabled: boolean;
      highPassHz: number;
      /** Frame RMS (0..1) below which a source is treated as background noise. */
      gateThreshold: number;
      gateHoldMs: number;
      /** Gain applied while gated (0 = silence). */
      gateFloor: number;
    };
    /** Server-side per-uplink loudness normalization (see src/mixer/loudness.ts). */
    loudness: { enabled: boolean; targetRms: number; maxGainDb: number; speechRms: number; adaptMs: number };
  };
  rtc: {
    iceServers: IceServerConfig[];
    serverIceServers: IceServerConfig[];
    portRange: [number, number] | [];
    /** Worker threads hosting PeerConnections (ICE/DTLS/SRTP); 0 keeps them on the main thread. */
    mediaWorkers: number;
    /** Ephemeral TURN (coturn use-auth-secret); empty `urls` disables it. */
    turn: { urls: string[]; secret: string; ttlSeconds: number };
  };
  log: { level: 'debug' | 'info' | 'warn' | 'error' };
}

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(`${path}: expected mapping`);
  return v as Obj;
}
function str(o: Obj, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new ConfigError(`${path}.${k}: expected string`);
  return v;
}
function bool(o: Obj, k: string, path: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new ConfigError(`${path}.${k}: expected boolean`);
  return v;
}
function int(o: Obj, k: string, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${path}.${k}: expected integer in [${min}, ${max}]`);
  }
  return v;
}
function num(o: Obj, k: string, path: string, min: number, max: number): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ConfigError(`${path}.${k}: expected number in [${min}, ${max}]`);
  }
  return v;
}

function iceServers(v: unknown, path: string): IceServerConfig[] {
  if (!Array.isArray(v)) throw new ConfigError(`${path}: expected list`);
  return v.map((entry, i) => {
    const p = `${path}[${i}]`;
    const e = obj(entry, p);
    const urls = e.urls;
    const list = typeof urls === 'string' ? [urls] : urls;
    const valid = Array.isArray(list) && list.length > 0 &&
      list.every((u) => typeof u === 'string' && /^(stun|stuns|turn|turns):/.test(u));
    if (!valid) {
      throw new ConfigError(`${p}.urls: expected stun:/turn: url or list of them`);
    }
    const out: IceServerConfig = { urls: urls as string | string[] };
    if (e.username !== undefined) out.username = str(e, 'username', p);
    if (e.credential !== undefined) out.credential = str(e, 'credential', p);
    return out;
  });
}

/**
 * `rtc.mediaWorkers: auto`: cores left after the main thread and the codec workers, never below the
 * 2 that the 300-listener cap needs (load-test), capped at 8 to bound idle threads on large hosts.
 */
export function autoMediaWorkers(codecWorkers: number, cores = availableParallelism()): number {
  return Math.min(8, Math.max(2, cores - 1 - codecWorkers));
}

const LOOPBACK: Record<string, true> = { '127.0.0.1': true, '::1': true, localhost: true };

export function parseConfig(raw: unknown): AppConfig {
  const root = obj(raw, 'config');

  const s = obj(root.server, 'server');
  const tls = obj(s.tls, 'server.tls');
  const mt = obj(s.metrics, 'server.metrics');
  if (!Array.isArray(s.static)) throw new ConfigError('server.static: expected list');
  const server: AppConfig['server'] = {
    host: str(s, 'host', 'server'),
    port: int(s, 'port', 'server', 0, 65535),
    wsPath: str(s, 'wsPath', 'server'),
    allowInsecure: bool(s, 'allowInsecure', 'server'),
    tls: { certFile: str(tls, 'certFile', 'server.tls'), keyFile: str(tls, 'keyFile', 'server.tls') },
    static: s.static.map((m, i) => {
      const p = `server.static[${i}]`;
      const o = obj(m, p);
      const mount = str(o, 'mount', p);
      if (!mount.startsWith('/') || !mount.endsWith('/')) throw new ConfigError(`${p}.mount: must start and end with "/"`);
      return { mount, dir: str(o, 'dir', p), cors: bool(o, 'cors', p) };
    }),
    metrics: { enabled: bool(mt, 'enabled', 'server.metrics'), token: str(mt, 'token', 'server.metrics') },
    trustProxy: bool(s, 'trustProxy', 'server'),
  };
  if (server.metrics.enabled && server.metrics.token === '' && LOOPBACK[server.host] !== true) {
    throw new ConfigError('server.metrics.token: required when metrics are enabled on a non-loopback host');
  }
  if (!server.wsPath.startsWith('/')) throw new ConfigError('server.wsPath: must start with "/"');
  const hasTls = server.tls.certFile !== '' && server.tls.keyFile !== '';
  if (!hasTls && !server.allowInsecure) {
    throw new ConfigError('server.tls: certFile/keyFile required unless server.allowInsecure is true (local dev only)');
  }
  if (!hasTls && LOOPBACK[server.host] !== true) {
    throw new ConfigError('server.allowInsecure: plaintext ws is only allowed on a loopback host');
  }

  const l = obj(root.limits, 'limits');
  const limits: AppConfig['limits'] = {
    maxRooms: int(l, 'maxRooms', 'limits', 1),
    maxConnections: int(l, 'maxConnections', 'limits', 1),
    maxSpeakersPerRoom: int(l, 'maxSpeakersPerRoom', 'limits', 1),
    maxAudiencePerRoom: int(l, 'maxAudiencePerRoom', 'limits', 1),
    maxFrameBytes: int(l, 'maxFrameBytes', 'limits', 1024),
    controlPerSecond: int(l, 'controlPerSecond', 'limits', 1),
    handRaiseIntervalMs: int(l, 'handRaiseIntervalMs', 'limits', 0),
    icePerSecond: int(l, 'icePerSecond', 'limits', 1),
    nameMaxLength: int(l, 'nameMaxLength', 'limits', 1),
    codeMaxLength: int(l, 'codeMaxLength', 'limits', 1),
    sdpMaxLength: int(l, 'sdpMaxLength', 'limits', 256),
    joinTimeoutMs: int(l, 'joinTimeoutMs', 'limits', 0),
    maxConnectionsPerIp: int(l, 'maxConnectionsPerIp', 'limits', 0),
    chatMaxLength: int(l, 'chatMaxLength', 'limits', 1, 2000),
    chatIntervalMs: int(l, 'chatIntervalMs', 'limits', 0),
    reactionIntervalMs: int(l, 'reactionIntervalMs', 'limits', 0),
  };

  const r = obj(root.rooms, 'rooms');
  const rooms: AppConfig['rooms'] = {
    codeLength: int(r, 'codeLength', 'rooms', 4),
    controllerGraceMs: int(r, 'controllerGraceMs', 'rooms', 0),
    participantGraceMs: int(r, 'participantGraceMs', 'rooms', 0),
    heartbeatIntervalMs: int(r, 'heartbeatIntervalMs', 'rooms', 1000),
    presenceBroadcastMs: int(r, 'presenceBroadcastMs', 'rooms', 0, 10000),
    qualityIntervalMs: int(r, 'qualityIntervalMs', 'rooms', 0, 60000),
    chatHistory: int(r, 'chatHistory', 'rooms', 0, 1000),
    createToken: str(r, 'createToken', 'rooms'),
  };
  if (rooms.codeLength > limits.codeMaxLength) throw new ConfigError('rooms.codeLength: exceeds limits.codeMaxLength');

  const a = obj(root.audio, 'audio');
  const o = obj(a.opus, 'audio.opus');
  const m = obj(a.mixer, 'audio.mixer');
  const j = obj(a.jitter, 'audio.jitter');
  const nf = obj(a.noiseFilter, 'audio.noiseFilter');
  const lt = obj(a.lowTier, 'audio.lowTier');
  const ld = obj(a.loudness, 'audio.loudness');
  const audio: AppConfig['audio'] = {
    sampleRate: int(a, 'sampleRate', 'audio', 8000, 48000),
    frameMs: int(a, 'frameMs', 'audio', 10, 60),
    codecWorkers: int(a, 'codecWorkers', 'audio', 1, 64),
    opus: {
      vbr: bool(o, 'vbr', 'audio.opus'),
      minBitrate: int(o, 'minBitrate', 'audio.opus', 6000, 510000),
      maxBitrate: int(o, 'maxBitrate', 'audio.opus', 6000, 510000),
      bitrate: int(o, 'bitrate', 'audio.opus', 6000, 510000),
      complexity: int(o, 'complexity', 'audio.opus', 0, 10),
      fec: bool(o, 'fec', 'audio.opus'),
      packetLossPercent: int(o, 'packetLossPercent', 'audio.opus', 0, 100),
      dtx: bool(o, 'dtx', 'audio.opus'),
    },
    lowTier: {
      enabled: bool(lt, 'enabled', 'audio.lowTier'),
      bitrate: int(lt, 'bitrate', 'audio.lowTier', 6000, 510000),
      packetLossPercent: int(lt, 'packetLossPercent', 'audio.lowTier', 0, 100),
      enterLossPercent: num(lt, 'enterLossPercent', 'audio.lowTier', 0.1, 100),
      exitLossPercent: num(lt, 'exitLossPercent', 'audio.lowTier', 0, 100),
    },
    mixer: {
      maxBufferedFrames: int(m, 'maxBufferedFrames', 'audio.mixer', 1, 100),
      limiterThreshold: num(m, 'limiterThreshold', 'audio.mixer', 0.1, 1),
      latencyTargetMs: int(m, 'latencyTargetMs', 'audio.mixer', 1),
      speakingThreshold: num(m, 'speakingThreshold', 'audio.mixer', 0.0001, 0.5),
      speakingHoldMs: int(m, 'speakingHoldMs', 'audio.mixer', 0, 10000),
    },
    jitter: {
      playoutFrames: int(j, 'playoutFrames', 'audio.jitter', 1, 100),
      reorderPackets: int(j, 'reorderPackets', 'audio.jitter', 0, 50),
    },
    noiseFilter: {
      enabled: bool(nf, 'enabled', 'audio.noiseFilter'),
      highPassHz: num(nf, 'highPassHz', 'audio.noiseFilter', 10, 1000),
      gateThreshold: num(nf, 'gateThreshold', 'audio.noiseFilter', 0, 0.5),
      gateHoldMs: int(nf, 'gateHoldMs', 'audio.noiseFilter', 0, 10000),
      gateFloor: num(nf, 'gateFloor', 'audio.noiseFilter', 0, 1),
    },
    loudness: {
      enabled: bool(ld, 'enabled', 'audio.loudness'),
      targetRms: num(ld, 'targetRms', 'audio.loudness', 0.001, 0.9),
      maxGainDb: num(ld, 'maxGainDb', 'audio.loudness', 0, 40),
      speechRms: num(ld, 'speechRms', 'audio.loudness', 0.0001, 0.5),
      adaptMs: int(ld, 'adaptMs', 'audio.loudness', 100, 60000),
    },
  };
  if (audio.jitter.playoutFrames > audio.mixer.maxBufferedFrames) throw new ConfigError('audio.jitter.playoutFrames: exceeds audio.mixer.maxBufferedFrames');
  if (audio.noiseFilter.enabled && audio.noiseFilter.gateThreshold >= audio.mixer.speakingThreshold) throw new ConfigError('audio.noiseFilter.gateThreshold: must be below audio.mixer.speakingThreshold');
  if (audio.loudness.enabled && audio.noiseFilter.enabled && audio.loudness.speechRms <= audio.noiseFilter.gateThreshold) throw new ConfigError('audio.loudness.speechRms: must be above audio.noiseFilter.gateThreshold');
  if (![10, 20, 40, 60].includes(audio.frameMs)) throw new ConfigError('audio.frameMs: must be 10, 20, 40 or 60 (Opus frame sizes)');
  // libopus only encodes/decodes at these rates; using one end-to-end avoids resampling.
  if (![8000, 12000, 16000, 24000, 48000].includes(audio.sampleRate)) {
    throw new ConfigError('audio.sampleRate: must be an Opus-native rate (8000|12000|16000|24000|48000)');
  }
  if (audio.opus.minBitrate > audio.opus.maxBitrate) throw new ConfigError('audio.opus: minBitrate > maxBitrate');
  if (audio.opus.bitrate < audio.opus.minBitrate || audio.opus.bitrate > audio.opus.maxBitrate) {
    throw new ConfigError('audio.opus.bitrate: must lie within [minBitrate, maxBitrate]');
  }
  if (audio.lowTier.bitrate < audio.opus.minBitrate || audio.lowTier.bitrate > audio.opus.bitrate) {
    throw new ConfigError('audio.lowTier.bitrate: must lie within [opus.minBitrate, opus.bitrate]');
  }
  if (audio.lowTier.exitLossPercent >= audio.lowTier.enterLossPercent) throw new ConfigError('audio.lowTier.exitLossPercent: must be below enterLossPercent');

  const t = obj(root.rtc, 'rtc');
  const pr = t.portRange;
  let portRange: AppConfig['rtc']['portRange'];
  if (Array.isArray(pr) && pr.length === 0) portRange = [];
  else if (
    Array.isArray(pr) && pr.length === 2 &&
    pr.every((p) => Number.isInteger(p) && p > 0 && p <= 65535) && (pr[0] as number) <= (pr[1] as number)
  ) portRange = [pr[0] as number, pr[1] as number];
  else throw new ConfigError('rtc.portRange: expected [] or [min, max]');
  const tu = obj(t.turn, 'rtc.turn');
  if (!Array.isArray(tu.urls) || !tu.urls.every((u) => typeof u === 'string' && /^turns?:/.test(u))) {
    throw new ConfigError('rtc.turn.urls: expected list of turn:/turns: urls ([] disables)');
  }
  const turn: AppConfig['rtc']['turn'] = {
    urls: tu.urls as string[],
    secret: str(tu, 'secret', 'rtc.turn'),
    ttlSeconds: int(tu, 'ttlSeconds', 'rtc.turn', 60),
  };
  if (turn.urls.length && turn.secret.length < 16) throw new ConfigError('rtc.turn.secret: at least 16 characters when urls are set');
  const rtc: AppConfig['rtc'] = {
    iceServers: iceServers(t.iceServers, 'rtc.iceServers'),
    serverIceServers: iceServers(t.serverIceServers, 'rtc.serverIceServers'),
    portRange,
    mediaWorkers: t.mediaWorkers === 'auto' ? autoMediaWorkers(audio.codecWorkers) : int(t, 'mediaWorkers', 'rtc', 0, 64),
    turn,
  };

  const lg = obj(root.log, 'log');
  const level = str(lg, 'level', 'log');
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError('log.level: debug|info|warn|error');

  return { server, limits, rooms, audio, rtc, log: { level: level as AppConfig['log']['level'] } };
}

export function loadConfig(path: string): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`cannot read ${path} (copy config.example.yaml to config.yaml)`);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(`invalid YAML in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(raw);
}

/** Samples per PCM frame at the mixer rate (960 for 48 kHz / 20 ms). */
export function samplesPerFrame(audio: AppConfig['audio']): number {
  return Math.round((audio.sampleRate * audio.frameMs) / 1000);
}
