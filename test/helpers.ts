import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ClientMessage, ServerMessage, ServerMessageMap, ServerMessageType } from '../shared/protocol.ts';
import { parseConfig, type AppConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import { MockMediaTransport } from '../src/transport/MockMediaTransport.ts';
import { StageHub, type Session } from '../src/ws/hub.ts';

export function testConfig(patch?: (c: AppConfig) => void): AppConfig {
  const config = parseConfig(parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8')));
  patch?.(config);
  return config;
}

export const RECVONLY_OFFER = { type: 'offer' as const, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n' };
export const SENDRECV_OFFER = { type: 'offer' as const, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' };

export class FakeSession implements Session {
  static seq = 0;
  readonly id = `s${FakeSession.seq++}`;
  readonly inbox: ServerMessage[] = [];
  closed?: { code: number; reason: string };
  send(msg: ServerMessage, encoded?: string): void {
    // Pre-serialized broadcasts are what the ws client actually receives; they must match `msg`.
    if (encoded !== undefined) assert.deepEqual(JSON.parse(encoded), JSON.parse(JSON.stringify(msg)));
    this.inbox.push(msg);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  all<K extends ServerMessageType>(type: K): ({ type: K } & ServerMessageMap[K])[] {
    return this.inbox.filter((m) => m.type === type) as ({ type: K } & ServerMessageMap[K])[];
  }
  last<K extends ServerMessageType>(type: K): ({ type: K } & ServerMessageMap[K]) | undefined {
    return this.all(type).at(-1);
  }
  clear(): void {
    this.inbox.length = 0;
  }
}

export interface Harness {
  hub: StageHub;
  transport: MockMediaTransport;
  mixers: Map<string, RoomMixer>;
  timers: { fn: () => void; ms: number; cleared: boolean }[];
  clock: { now: number };
  /** Send a request and return the reply status for its requestId. */
  req(session: FakeSession, msg: DistributiveOmit<ClientMessage, 'requestId'>): Promise<'ok' | string>;
  create(name?: string, opts?: { codeRequired?: boolean }): Promise<{ s: FakeSession; roomId: string; code: string; id: string }>;
  join(roomId: string, code: string | undefined, name: string): Promise<{ s: FakeSession; id: string }>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let rid = 0;

export function harness(config = testConfig()): Harness {
  const timers: Harness['timers'] = [];
  const clock = { now: 1_000_000 };
  const mixers = new Map<string, RoomMixer>();
  let hub: StageHub | undefined;
  const transport = new MockMediaTransport({
    onLocalCandidate: (roomId, pid, c) => hub?.onLocalCandidate(roomId, pid, c),
  });
  hub = new StageHub({
    config,
    transport,
    log: silentLogger,
    serverVersion: 'test',
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const t = timers.find((x) => x === h);
      if (t) t.cleared = true;
    },
    // Not started: tests drive mixer.tick() by hand for determinism.
    createMixer: (roomId) => {
      const m = new RoomMixer({ sampleRate: config.audio.sampleRate, frameMs: config.audio.frameMs, maxBufferedFrames: 10, playoutFrames: 1, limiterThreshold: 0.9, speakingThreshold: 0.02, speakingHoldMs: 40 });
      mixers.set(roomId, m);
      return m;
    },
  });
  const h: Harness = {
    hub,
    transport,
    mixers,
    timers,
    clock,
    async req(session, msg) {
      const requestId = `r${rid++}`;
      await hub.handle(session, { ...msg, requestId } as ClientMessage);
      const reply = session.inbox.find(
        (m) => (m.type === 'ok' || m.type === 'error') && m.requestId === requestId,
      );
      if (!reply) return 'no-reply';
      return reply.type === 'error' ? reply.code : 'ok';
    },
    async create(name = 'Host', opts) {
      const s = new FakeSession();
      hub.attach(s);
      const r = await h.req(s, { type: 'room:create', name, roomName: 'Room', ...(opts ?? {}) });
      if (r !== 'ok') throw new Error(`create failed: ${r}`);
      const created = s.last('room:created')!;
      const state = s.last('room:state')!;
      return { s, roomId: created.roomId, code: state.code ?? '', id: state.me.participantId };
    },
    async join(roomId, code, name) {
      const s = new FakeSession();
      hub.attach(s);
      const r = await h.req(s, { type: 'join', roomId, name, ...(code !== undefined ? { code } : {}) });
      if (r !== 'ok') throw new Error(`join failed: ${r}`);
      return { s, id: s.last('room:state')!.me.participantId };
    },
  };
  return h;
}

export function sine(len: number, amp: number, freq = 440, rate = 48000): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}
