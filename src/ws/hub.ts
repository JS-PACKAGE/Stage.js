import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  SERVER_PEER_ID,
  type ClientMessage,
  type ConnectionQuality,
  type IceCandidatePayload,
  type ServerMessage,
  type SessionDescriptionPayload,
} from '../../shared/protocol.ts';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../log.ts';
import type { MetricSample } from '../metrics.ts';
import { ERROR_MESSAGES, InvariantViolation, StageError } from '../model/errors.ts';
import { Room, type RoomEvent } from '../model/room.ts';
import { offerSendsAudio, summarizeOffer } from '../rtc/sdp.ts';
import { iceServersFor } from '../rtc/turn.ts';
import type { MediaTransport, MixedPcmSource } from '../transport/MediaTransport.ts';
import { SerialQueue } from './serialQueue.ts';

/** A client connection as seen by the hub (ws in production, fakes in tests). */
export interface Session {
  readonly id: string;
  /** `encoded` is `msg` already serialized; broadcasts pass it so N recipients cost one JSON.stringify. */
  send(msg: ServerMessage, encoded?: string): void;
  close(code: number, reason: string): void;
}

/** The slice of RoomMixer the hub drives. */
export interface Mixer extends MixedPcmSource {
  addSource(participantId: string): void;
  removeSource(participantId: string): void;
  setMuted(participantId: string, muted: boolean): void;
  setGain(participantId: string, gainDb: number): void;
  push(participantId: string, samples: Float32Array): void;
  stop(): void;
  /** Listener receives the full speaking set whenever it changes; returns an unsubscribe function. */
  onSpeaking(listener: (participantIds: string[]) => void): () => void;
}

export interface HubDeps {
  config: AppConfig;
  transport: MediaTransport;
  log: Logger;
  serverVersion: string;
  /** Returns a running mixer for a new room. */
  createMixer(roomId: string): Mixer;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Binding {
  roomId: string;
  participantId: string;
}

interface RoomRuntime {
  readonly room: Room;
  readonly queue: SerialQueue;
  readonly mixer: Mixer;
  readonly sessions: Map<string, Session>;
  readonly publishers: Set<string>;
  graceTimer: unknown;
  /** Seat-hold timers of disconnected non-controllers (`rooms.participantGraceMs`). */
  readonly graceTimers: Map<string, unknown>;
  /** Pending coalesced `room:state` broadcast (see `presenceChanged`). */
  stateTimer: unknown;
  /** Next connection-quality report; scheduled only while someone publishes. */
  qualityTimer: unknown;
  /** Uplink counters at the previous report, so each report covers one interval. */
  readonly uplinkCounts: Map<string, { received: number; lost: number }>;
  lastStatus: 'waiting' | 'live';
  closed: boolean;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Application close code (RFC 6455 private range) telling the client it was removed, not dropped. */
const CLOSE_KICKED = 4001;
const round1 = (x: number) => Math.round(x * 10) / 10;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Control-plane core: room registry, per-room serial command queue, event
 * fan-out and coupling to the media plane. Transport-agnostic and ws-agnostic.
 */
export class StageHub {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly bindings = new Map<Session, Binding>();
  private readonly deps: HubDeps;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(deps: HubDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  metrics(): MetricSample[] {
    let participants = 0, sessions = 0, publishers = 0;
    for (const rt of this.rooms.values()) { participants += rt.room.participants.size; sessions += rt.sessions.size; publishers += rt.publishers.size; }
    return [
      { name: 'stage_rooms', help: 'Open rooms.', type: 'gauge', value: this.rooms.size },
      { name: 'stage_participants', help: 'Participants in all rooms, including disconnected ones within grace.', type: 'gauge', value: participants },
      { name: 'stage_sessions', help: 'Connected ws sessions bound to a room.', type: 'gauge', value: sessions },
      { name: 'stage_publishers', help: 'Participants whose uplink feeds a mixer.', type: 'gauge', value: publishers },
    ];
  }

  attach(session: Session): void {
    const { controlPerSecond, icePerSecond, handRaiseIntervalMs } = this.deps.config.limits;
    session.send({ type: 'hello', protocol: PROTOCOL_VERSION, serverVersion: this.deps.serverVersion, limits: { controlPerSecond, icePerSecond, handRaiseIntervalMs } });
  }

  /** Whether the session has created or joined a room (and not been evicted since). */
  isJoined(session: Session): boolean {
    return this.bindings.has(session);
  }

  /** Handle one validated message. Never throws; failures become `error` frames. */
  async handle(session: Session, msg: ClientMessage): Promise<void> {
    const requestId = msg.type === 'ping' ? undefined : msg.requestId;
    try {
      if (msg.type === 'ping') {
        session.send({ type: 'pong' });
        return;
      }
      const binding = this.bindings.get(session);
      if (msg.type === 'room:create') {
        if (binding) throw new StageError('already_joined', 'room:create while joined');
        this.createRoom(session, msg);
        return;
      }
      if (msg.type === 'join') {
        if (binding) throw new StageError('already_joined', 'join while joined');
        const rt = this.rooms.get(msg.roomId);
        if (!rt) throw new StageError('unauthorized', 'unknown room');
        await rt.queue.run(() => this.join(rt, session, msg));
        return;
      }
      if (!binding) throw new StageError('not_joined', msg.type);
      const rt = this.rooms.get(binding.roomId);
      if (!rt) throw new StageError('not_joined', 'room gone');
      await rt.queue.run(() => this.command(rt, session, binding.participantId, msg));
    } catch (err) {
      this.fail(session, requestId, err);
    }
  }

  /** Connection closed. */
  async detach(session: Session): Promise<void> {
    const b = this.bindings.get(session);
    if (!b) return;
    this.bindings.delete(session);
    const rt = this.rooms.get(b.roomId);
    if (!rt) return;
    await rt.queue.run(() => this.disconnect(rt, session, b.participantId)).catch((err) => this.internalFailure(rt, err));
  }

  /** MediaTransport callback: trickle server ICE to the participant. */
  onLocalCandidate(roomId: string, participantId: string, candidate: IceCandidatePayload | null): void {
    this.rooms.get(roomId)?.sessions.get(participantId)?.send({ type: 'rtc:ice', fromId: SERVER_PEER_ID, payload: candidate });
  }

  /**
   * MediaTransport callback: the peer died on the network side. Stop mixing its uplink and discard
   * the PeerConnection: a failed werift peer cannot be renegotiated, so the participant's next offer
   * must create a new one (their seat and session are untouched).
   */
  onPeerClosed(roomId: string, participantId: string): void {
    const rt = this.rooms.get(roomId);
    if (!rt) return;
    void rt.queue.run(() => {
      this.unpublish(rt, participantId);
      this.deps.transport.closePeer(roomId, participantId);
    }).catch((err) => this.internalFailure(rt, err));
  }

  async shutdown(): Promise<void> {
    for (const rt of [...this.rooms.values()]) await rt.queue.run(() => this.closeRoom(rt, 'shutdown', true));
  }

  // ─────────────────────────────── commands ───────────────────────────────

  private createRoom(session: Session, msg: Extract<ClientMessage, { type: 'room:create' }>): void {
    const { config, transport, log } = this.deps;
    if (this.rooms.size >= config.limits.maxRooms) throw new StageError('room_full', 'max rooms');
    if (config.rooms.createToken && !(msg.token !== undefined && safeEqual(msg.token, config.rooms.createToken))) {
      throw new StageError('unauthorized', 'bad create token');
    }
    let roomId: string;
    do roomId = randomBytes(6).toString('base64url');
    while (this.rooms.has(roomId));
    const code = this.newCode();
    const codeRequired = msg.codeRequired ?? true;
    const controller = { participantId: randomBytes(9).toString('base64url'), name: msg.name ?? 'Host', resumeToken: randomBytes(24).toString('base64url') };
    const room = new Room({
      roomId,
      name: msg.roomName ?? 'Stage',
      code,
      codeRequired,
      limits: { maxSpeakers: config.limits.maxSpeakersPerRoom, maxAudience: config.limits.maxAudiencePerRoom },
      now: this.now(),
      controller,
    });
    const mixer = this.deps.createMixer(roomId);
    const rt: RoomRuntime = {
      room,
      queue: new SerialQueue(),
      mixer,
      sessions: new Map([[controller.participantId, session]]),
      publishers: new Set(),
      graceTimer: undefined,
      graceTimers: new Map(),
      stateTimer: undefined,
      qualityTimer: undefined,
      uplinkCounts: new Map(),
      lastStatus: room.status,
      closed: false,
    };
    this.rooms.set(roomId, rt);
    transport.setMixedStream(roomId, mixer);
    // Fired from the mixer clock, outside the room queue: read-only fan-out, so no queueing needed.
    mixer.onSpeaking((participantIds) => { if (!rt.closed) this.broadcast(rt, { type: 'speaking', participantIds }); });
    this.bindings.set(session, { roomId, participantId: controller.participantId });
    log.info('room created', { roomId, participantId: controller.participantId, codeRequired });

    session.send(codeRequired ? { type: 'room:created', roomId, code } : { type: 'room:created', roomId });
    session.send({ type: 'rtc:config', iceServers: iceServersFor(config.rtc, controller.participantId, this.now()) });
    session.send({ type: 'room:state', ...room.snapshot(controller.participantId) });
    session.send({ type: 'ok', requestId: msg.requestId });
  }

  private join(rt: RoomRuntime, session: Session, msg: Extract<ClientMessage, { type: 'join' }>): void {
    const { room } = rt;
    if (rt.closed) throw new StageError('unauthorized', 'room closed');
    if (this.bindings.has(session)) throw new StageError('already_joined', 'join raced');
    if (room.codeRequired && !(msg.code !== undefined && safeEqual(msg.code, room.code))) {
      throw new StageError('unauthorized', 'bad code');
    }

    let participantId: string | undefined;
    if (msg.resumeToken !== undefined) {
      for (const p of room.participants.values()) {
        if (!p.connected && safeEqual(p.resumeToken, msg.resumeToken)) {
          p.connected = true;
          participantId = p.participantId;
          break;
        }
      }
      if (participantId !== undefined) {
        if (participantId === room.controllerId) {
          if (rt.graceTimer !== undefined) this.clearTimer(rt.graceTimer);
          rt.graceTimer = undefined;
        } else {
          const timer = rt.graceTimers.get(participantId);
          if (timer !== undefined) { this.clearTimer(timer); rt.graceTimers.delete(participantId); }
        }
      }
    }
    if (participantId === undefined) {
      participantId = room.join(
        { participantId: randomBytes(9).toString('base64url'), name: msg.name, resumeToken: randomBytes(24).toString('base64url') },
        this.now(),
      ).participantId;
    }
    rt.sessions.set(participantId, session);
    this.bindings.set(session, { roomId: room.roomId, participantId });
    this.deps.log.info('participant joined', { roomId: room.roomId, participantId, resumed: msg.resumeToken !== undefined });

    session.send({ type: 'rtc:config', iceServers: iceServersFor(this.deps.config.rtc, participantId, this.now()) });
    session.send({ type: 'room:state', ...room.snapshot(participantId) });
    this.presenceChanged(rt);
    session.send({ type: 'ok', requestId: msg.requestId });
  }

  private async command(rt: RoomRuntime, session: Session, pid: string, msg: ClientMessage): Promise<void> {
    if (rt.closed || rt.sessions.get(pid) !== session) throw new StageError('not_joined', 'stale binding');
    const { room } = rt;
    const now = this.now();
    let events: RoomEvent[];
    switch (msg.type) {
      case 'room:close':
        if (pid !== room.controllerId) throw new StageError('forbidden', 'controller only');
        session.send({ type: 'ok', requestId: msg.requestId });
        this.closeRoom(rt, 'closed by controller');
        return;
      case 'hand:raise':
        events = room.raiseHand(pid);
        break;
      case 'hand:withdraw':
        events = room.withdrawHand(pid);
        break;
      case 'stage:approve':
        events = room.approve(pid, msg.targetId, now);
        break;
      case 'stage:reject':
        events = room.reject(pid, msg.targetId);
        break;
      case 'stage:leave':
        events = room.leaveStage(pid);
        break;
      case 'stage:remove':
        events = room.removeFromStage(pid, msg.targetId);
        break;
      case 'control:transfer':
        events = room.transfer(pid, msg.targetId);
        break;
      case 'mic:mute':
        events = room.mute(pid);
        break;
      case 'mic:unmute':
        events = room.unmute(pid);
        break;
      case 'mic:force-mute':
        events = room.forceMute(pid, msg.targetId);
        break;
      case 'mic:force-unmute':
        events = room.forceUnmute(pid, msg.targetId);
        break;
      case 'participant:kick':
        events = room.kick(pid, msg.targetId);
        // Off the session list before the state fan-out: the room no longer knows this participant.
        this.evict(rt, msg.targetId);
        this.deps.log.info('participant kicked', { roomId: room.roomId, byId: pid, participantId: msg.targetId });
        break;
      case 'mic:gain':
        room.setGain(pid, msg.targetId, msg.gainDb);
        if (rt.publishers.has(msg.targetId)) rt.mixer.setGain(msg.targetId, msg.gainDb);
        events = [];
        break;
      case 'room:rotate-code':
        room.rotateCode(pid, this.newCode());
        // Only the controller's snapshot carries the code.
        session.send({ type: 'room:state', ...room.snapshot(pid) });
        session.send({ type: 'ok', requestId: msg.requestId });
        this.deps.log.info('room code rotated', { roomId: room.roomId });
        return;
      case 'rtc:offer':
        await this.negotiate(rt, session, pid, msg.payload);
        session.send({ type: 'ok', requestId: msg.requestId });
        return;
      case 'rtc:ice':
        try {
          await this.deps.transport.addRemoteCandidate(room.roomId, pid, msg.payload);
        } catch (err) {
          // e.g. a candidate before any offer: that client's signaling error, not a room failure.
          this.deps.log.debug('remote candidate rejected', { roomId: room.roomId, participantId: pid, error: String(err) });
          throw new StageError('bad_request', 'candidate rejected');
        }
        session.send({ type: 'ok', requestId: msg.requestId });
        return;
      case 'rtc:answer':
        // The server never sends offers, so an answer is always out of protocol.
        throw new StageError('bad_request', 'unexpected rtc:answer');
      default:
        throw new StageError('bad_request', `unroutable ${msg.type}`);
    }
    this.apply(rt, events);
    session.send({ type: 'ok', requestId: msg.requestId });
    if (msg.type === 'control:transfer') this.deps.log.info('control transferred', { roomId: room.roomId, fromId: pid, toId: msg.targetId });
  }

  private newCode(): string {
    let code = '';
    for (let i = 0; i < this.deps.config.rooms.codeLength; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return code;
  }

  /** Tears down a kicked participant's media and connection; the client must not rejoin on its own. */
  private evict(rt: RoomRuntime, pid: string): void {
    const session = rt.sessions.get(pid);
    rt.sessions.delete(pid);
    const grace = rt.graceTimers.get(pid);
    if (grace !== undefined) { this.clearTimer(grace); rt.graceTimers.delete(pid); }
    this.unpublish(rt, pid);
    this.deps.transport.closePeer(rt.room.roomId, pid);
    if (!session) return;
    this.bindings.delete(session);
    session.send({ type: 'kicked', roomId: rt.room.roomId });
    session.close(CLOSE_KICKED, 'kicked');
  }

  private async negotiate(
    rt: RoomRuntime,
    session: Session,
    pid: string,
    offer: SessionDescriptionPayload,
  ): Promise<void> {
    const { room } = rt;
    const { transport, log } = this.deps;
    const p = room.get(pid);
    if (!p) throw new StageError('not_joined', 'participant gone');
    const summary = summarizeOffer(offer.sdp);
    if (summary.audioDirections.length === 0) throw new StageError('bad_request', 'offer without audio');
    const sends = offerSendsAudio(summary);
    if (sends && !p.onStage) {
      // Audience may only receive (AGENTS.md §S2): reject the whole offer, fail-closed.
      log.warn('uplink offer from off-stage participant rejected', { roomId: room.roomId, participantId: pid });
      throw new StageError('forbidden', 'audience offer must be recvonly');
    }
    let answer: SessionDescriptionPayload;
    try {
      answer = await transport.negotiate(room.roomId, pid, offer, { allowUplink: p.onStage });
    } catch (err) {
      // A bad offer is that client's problem, not a reason to tear down the room.
      log.warn('negotiation failed', { roomId: room.roomId, participantId: pid, error: String(err) });
      this.unpublish(rt, pid);
      transport.closePeer(room.roomId, pid);
      throw new StageError('bad_request', 'negotiation failed');
    }
    if (rt.closed) return;
    session.send({ type: 'rtc:answer', fromId: SERVER_PEER_ID, payload: answer });
    transport.subscribe(room.roomId, pid);
    if (sends && !rt.publishers.has(pid)) {
      rt.publishers.add(pid);
      rt.mixer.addSource(pid);
      rt.mixer.setGain(pid, p.gainDb);
      this.scheduleQuality(rt);
      transport.addPublisher(room.roomId, pid, (samples) => rt.mixer.push(pid, samples));
      this.setPublisherMuted(rt, pid, p.selfMuted || p.forceMuted);
      this.broadcast(rt, { type: 'stage:joined', participantId: pid, role: p.role });
    } else if (!sends) {
      this.unpublish(rt, pid);
    }
  }

  /**
   * The ws dropped. The media plane is left alone: a short ws outage must not cost the participant
   * their PeerConnection (PLAN 九), so audio keeps flowing while the seat is held. The seat, stage
   * position and raised hand survive the grace period; a `join` with the resume token reclaims them.
   */
  private disconnect(rt: RoomRuntime, session: Session, pid: string): void {
    if (rt.closed || rt.sessions.get(pid) !== session) return;
    const { room } = rt;
    rt.sessions.delete(pid);
    const p = room.get(pid);
    if (!p) return;
    const { controllerGraceMs, participantGraceMs } = this.deps.config.rooms;
    const controller = p.role === 'controller';
    const graceMs = controller ? controllerGraceMs : participantGraceMs;
    if (controller || graceMs > 0) {
      p.connected = false;
      const timer = this.setTimer(() => {
        void rt.queue.run(() => (controller ? this.expireController(rt, pid) : this.expireParticipant(rt, pid))).catch((err) => this.internalFailure(rt, err));
      }, graceMs);
      if (controller) rt.graceTimer = timer; else rt.graceTimers.set(pid, timer);
      this.deps.log.info('participant disconnected, grace started', { roomId: room.roomId, participantId: pid, role: p.role });
      if (p.onStage) this.broadcastState(rt); else this.presenceChanged(rt);
      return;
    }
    this.dropMedia(rt, pid);
    const events = room.remove(pid);
    if (events.length) this.apply(rt, events);
    else this.presenceChanged(rt);
  }

  private dropMedia(rt: RoomRuntime, pid: string): void {
    this.unpublish(rt, pid);
    this.deps.transport.closePeer(rt.room.roomId, pid);
  }

  private expireParticipant(rt: RoomRuntime, pid: string): void {
    rt.graceTimers.delete(pid);
    const p = rt.room.get(pid);
    if (rt.closed || !p || p.connected || p.role === 'controller') return;
    this.dropMedia(rt, pid);
    const events = rt.room.remove(pid);
    if (events.length) this.apply(rt, events);
    else this.presenceChanged(rt);
  }

  private expireController(rt: RoomRuntime, pid: string): void {
    rt.graceTimer = undefined;
    const { room } = rt;
    const p = room.get(pid);
    if (rt.closed || room.controllerId !== pid || !p || p.connected) return;
    const successor = room.pickSuccessor();
    if (!successor) {
      this.closeRoom(rt, 'controller gone, room empty');
      return;
    }
    this.deps.log.info('controller auto-transfer', { roomId: room.roomId, fromId: pid, toId: successor.participantId });
    this.dropMedia(rt, pid);
    const events = room.transfer(pid, successor.participantId, 'auto');
    this.apply(rt, [...events, ...room.remove(pid)]);
  }

  // ─────────────────────────────── effects ───────────────────────────────

  /** Broadcast transition events, mirror them into the media plane, then push fresh snapshots. */
  private apply(rt: RoomRuntime, events: RoomEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'stage:left') this.unpublish(rt, ev.participantId);
      if (ev.type === 'mic:muted' || ev.type === 'mic:unmuted') {
        if (rt.publishers.has(ev.participantId)) this.setPublisherMuted(rt, ev.participantId, ev.type === 'mic:muted');
      }
      this.broadcast(rt, ev);
    }
    this.broadcastState(rt);
  }

  private unpublish(rt: RoomRuntime, pid: string): void {
    if (!rt.publishers.delete(pid)) return;
    this.deps.transport.removePublisher(rt.room.roomId, pid);
    rt.mixer.removeSource(pid);
    rt.uplinkCounts.delete(pid);
  }

  private scheduleQuality(rt: RoomRuntime): void {
    const interval = this.deps.config.rooms.qualityIntervalMs;
    if (interval === 0 || rt.qualityTimer !== undefined) return;
    rt.qualityTimer = this.setTimer(() => {
      rt.qualityTimer = undefined;
      void this.reportQuality(rt).catch((err) => this.deps.log.warn('quality report failed', { roomId: rt.room.roomId, error: String(err) }));
    }, interval);
  }

  /**
   * Tells the controller and the stage how every publisher's connection is doing. Read-only on
   * the room and outside its queue, like `speaking`; stops rescheduling once nobody publishes.
   */
  private async reportQuality(rt: RoomRuntime): Promise<void> {
    if (rt.closed || !rt.publishers.size) return;
    const { roomId } = rt.room;
    const ids = [...rt.publishers];
    const stats = await Promise.all(ids.map((id) => this.deps.transport.getStats(roomId, id)));
    if (rt.closed) return;
    const participants: ConnectionQuality[] = [];
    ids.forEach((participantId, i) => {
      const s = stats[i];
      if (!s || !rt.publishers.has(participantId)) return;
      const q: ConnectionQuality = { participantId };
      const received = s.inbound?.packetsReceived, lost = s.inbound?.packetsLost;
      if (received !== undefined && lost !== undefined) {
        const previous = rt.uplinkCounts.get(participantId) ?? { received: 0, lost: 0 };
        const total = received - previous.received + lost - previous.lost;
        if (total > 0) q.uplinkLossPercent = round1(100 * (lost - previous.lost) / total);
        rt.uplinkCounts.set(participantId, { received, lost });
      }
      if (s.outbound?.fractionLost !== undefined) q.downlinkLossPercent = round1(100 * s.outbound.fractionLost);
      if (s.rttMs !== undefined) q.rttMs = Math.round(s.rttMs);
      participants.push(q);
    });
    if (participants.length) {
      const msg: ServerMessage = { type: 'quality', participants };
      const encoded = JSON.stringify(msg);
      for (const [pid, session] of rt.sessions) {
        const p = rt.room.get(pid);
        if (p && (p.onStage || pid === rt.room.controllerId)) session.send(msg, encoded);
      }
    }
    if (rt.publishers.size) this.scheduleQuality(rt);
  }

  private setPublisherMuted(rt: RoomRuntime, pid: string, muted: boolean): void {
    rt.mixer.setMuted(pid, muted);
    this.deps.transport.setPublisherMuted(rt.room.roomId, pid, muted);
  }

  private broadcast(rt: RoomRuntime, msg: ServerMessage): void {
    const encoded = JSON.stringify(msg);
    for (const s of rt.sessions.values()) s.send(msg, encoded);
  }

  /**
   * An audience member came or went: everyone else's snapshot changes only in `audienceCount` (and
   * the controller's audience list). A crowd joining or leaving at once would otherwise cost
   * N broadcasts of N snapshots, so these are folded into one broadcast per `presenceBroadcastMs`.
   */
  private presenceChanged(rt: RoomRuntime): void {
    const delay = this.deps.config.rooms.presenceBroadcastMs;
    if (delay === 0) { this.broadcastState(rt); return; }
    rt.stateTimer ??= this.setTimer(() => {
      rt.stateTimer = undefined;
      if (!rt.closed) this.broadcastState(rt);
    }, delay);
  }

  private broadcastState(rt: RoomRuntime): void {
    // Supersedes a pending coalesced broadcast.
    if (rt.stateTimer !== undefined) { this.clearTimer(rt.stateTimer); rt.stateTimer = undefined; }
    // Views shared by all recipients are built and serialized once; only `me` & co. are per session.
    const shared = rt.room.sharedSnapshot();
    const prefix = JSON.stringify({ type: 'room:state', ...shared }).slice(0, -1);
    for (const [pid, s] of rt.sessions) {
      const personal = rt.room.personalSnapshot(pid);
      s.send({ type: 'room:state', ...shared, ...personal }, `${prefix},${JSON.stringify(personal).slice(1)}`);
    }
    const status = rt.room.status;
    if (status !== rt.lastStatus) {
      rt.lastStatus = status;
      this.broadcast(rt, { type: 'status', state: status });
    }
  }

  private closeRoom(rt: RoomRuntime, reason: string, shutdown = false): void {
    if (rt.closed) return;
    rt.closed = true;
    const { roomId } = rt.room;
    if (rt.graceTimer !== undefined) this.clearTimer(rt.graceTimer);
    for (const timer of rt.graceTimers.values()) this.clearTimer(timer);
    rt.graceTimers.clear();
    if (rt.stateTimer !== undefined) this.clearTimer(rt.stateTimer);
    if (rt.qualityTimer !== undefined) this.clearTimer(rt.qualityTimer);
    const closed: ServerMessage = shutdown ? { type: 'room:closed', roomId, reason: 'shutdown' } : { type: 'room:closed', roomId };
    for (const s of rt.sessions.values()) {
      s.send(closed);
      this.bindings.delete(s);
    }
    rt.sessions.clear();
    rt.publishers.clear();
    this.deps.transport.setMixedStream(roomId, null);
    this.deps.transport.closeRoom(roomId);
    rt.mixer.stop();
    this.rooms.delete(roomId);
    this.deps.log.info('room closed', { roomId, reason });
  }

  // ─────────────────────────────── errors ───────────────────────────────

  private fail(session: Session, requestId: string | undefined, err: unknown): void {
    if (err instanceof StageError) {
      this.deps.log.debug('request rejected', { session: session.id, code: err.code, detail: err.detail });
      session.send({ type: 'error', ...(requestId ? { requestId } : {}), code: err.code, message: ERROR_MESSAGES[err.code] });
      return;
    }
    const b = this.bindings.get(session);
    const rt = b && this.rooms.get(b.roomId);
    if (rt) this.internalFailure(rt, err);
    else this.deps.log.error('internal error', { session: session.id, error: String(err) });
    session.send({ type: 'error', ...(requestId ? { requestId } : {}), code: 'internal', message: ERROR_MESSAGES.internal });
  }

  /** Invariant violations and unexpected errors close the room (fail-closed, AGENTS.md §S6). */
  private internalFailure(rt: RoomRuntime, err: unknown): void {
    const invariant = err instanceof InvariantViolation;
    this.deps.log.error(invariant ? 'invariant violation, closing room' : 'internal error, closing room', {
      roomId: rt.room.roomId,
      error: String(err),
    });
    this.closeRoom(rt, invariant ? 'invariant violation' : 'internal error');
  }
}
