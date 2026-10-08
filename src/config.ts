import { readFileSync } from 'node:fs';
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
  };
  rooms: {
    codeLength: number;
    controllerGraceMs: number;
    heartbeatIntervalMs: number;
  };
  audio: {
    sampleRate: number;
    frameMs: number;
    opus: {
      vbr: boolean;
      minBitrate: number;
      maxBitrate: number;
      bitrate: number;
      complexity: number;
    };
    mixer: {
      maxBufferedFrames: number;
      limiterThreshold: number;
      latencyTargetMs: number;
    };
  };
  rtc: {
    iceServers: IceServerConfig[];
    serverIceServers: IceServerConfig[];
    portRange: [number, number] | [];
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

const LOOPBACK: Record<string, true> = { '127.0.0.1': true, '::1': true, localhost: true };

export function parseConfig(raw: unknown): AppConfig {
  const root = obj(raw, 'config');

  const s = obj(root.server, 'server');
  const tls = obj(s.tls, 'server.tls');
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
  };
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
  };

  const r = obj(root.rooms, 'rooms');
  const rooms: AppConfig['rooms'] = {
    codeLength: int(r, 'codeLength', 'rooms', 4),
    controllerGraceMs: int(r, 'controllerGraceMs', 'rooms', 0),
    heartbeatIntervalMs: int(r, 'heartbeatIntervalMs', 'rooms', 1000),
  };
  if (rooms.codeLength > limits.codeMaxLength) throw new ConfigError('rooms.codeLength: exceeds limits.codeMaxLength');

  const a = obj(root.audio, 'audio');
  const o = obj(a.opus, 'audio.opus');
  const m = obj(a.mixer, 'audio.mixer');
  const audio: AppConfig['audio'] = {
    sampleRate: int(a, 'sampleRate', 'audio', 8000, 48000),
    frameMs: int(a, 'frameMs', 'audio', 10, 60),
    opus: {
      vbr: bool(o, 'vbr', 'audio.opus'),
      minBitrate: int(o, 'minBitrate', 'audio.opus', 6000, 510000),
      maxBitrate: int(o, 'maxBitrate', 'audio.opus', 6000, 510000),
      bitrate: int(o, 'bitrate', 'audio.opus', 6000, 510000),
      complexity: int(o, 'complexity', 'audio.opus', 0, 10),
    },
    mixer: {
      maxBufferedFrames: int(m, 'maxBufferedFrames', 'audio.mixer', 1, 100),
      limiterThreshold: num(m, 'limiterThreshold', 'audio.mixer', 0.1, 1),
      latencyTargetMs: int(m, 'latencyTargetMs', 'audio.mixer', 1),
    },
  };
  if (![10, 20, 40, 60].includes(audio.frameMs)) throw new ConfigError('audio.frameMs: must be 10, 20, 40 or 60 (Opus frame sizes)');
  // libopus only encodes/decodes at these rates; using one end-to-end avoids resampling.
  if (![8000, 12000, 16000, 24000, 48000].includes(audio.sampleRate)) {
    throw new ConfigError('audio.sampleRate: must be an Opus-native rate (8000|12000|16000|24000|48000)');
  }
  if (audio.opus.minBitrate > audio.opus.maxBitrate) throw new ConfigError('audio.opus: minBitrate > maxBitrate');
  if (audio.opus.bitrate < audio.opus.minBitrate || audio.opus.bitrate > audio.opus.maxBitrate) {
    throw new ConfigError('audio.opus.bitrate: must lie within [minBitrate, maxBitrate]');
  }

  const t = obj(root.rtc, 'rtc');
  const pr = t.portRange;
  let portRange: AppConfig['rtc']['portRange'];
  if (Array.isArray(pr) && pr.length === 0) portRange = [];
  else if (
    Array.isArray(pr) && pr.length === 2 &&
    pr.every((p) => Number.isInteger(p) && p > 0 && p <= 65535) && (pr[0] as number) <= (pr[1] as number)
  ) portRange = [pr[0] as number, pr[1] as number];
  else throw new ConfigError('rtc.portRange: expected [] or [min, max]');
  const rtc: AppConfig['rtc'] = {
    iceServers: iceServers(t.iceServers, 'rtc.iceServers'),
    serverIceServers: iceServers(t.serverIceServers, 'rtc.serverIceServers'),
    portRange,
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
