import type {
  ParticipantView,
  Role,
  RoomStatePayload,
  ServerMessage,
  StageLeftReason,
} from '../../shared/protocol.ts';
import { InvariantViolation, StageError } from './errors.ts';

export interface Participant {
  readonly participantId: string;
  /** Already HTML-escaped (AGENTS.md §S3/§S8). */
  readonly name: string;
  readonly resumeToken: string;
  readonly joinedAt: number;
  role: Role;
  onStage: boolean;
  /** When the participant last stepped on stage; orders auto-transfer successors. */
  stageSince: number;
  handRaised: boolean;
  selfMuted: boolean;
  forceMuted: boolean;
  /** Controller-set level trim in dB; survives stage changes for as long as they stay. */
  gainDb: number;
  connected: boolean;
}

export interface RoomLimits {
  maxSpeakers: number;
  /** Cap on non-controller participants, so audience ≤ max holds through every transition. */
  maxAudience: number;
}

export interface NewParticipant {
  participantId: string;
  name: string;
  resumeToken: string;
}

/** Wire events produced by a transition; broadcast to the whole room. */
export type RoomEvent = Extract<
  ServerMessage,
  {
    type:
      | 'role:update'
      | 'hand:raise'
      | 'hand:withdraw'
      | 'stage:invite'
      | 'stage:left'
      | 'control:transferred'
      | 'mic:muted'
      | 'mic:unmuted';
  }
>;

/** Everything needed to rebuild a room after a restart (`persistence.stateFile`). Holds the code and resume tokens: secret. */
export interface RoomSnapshot {
  roomId: string;
  name: string;
  code: string;
  codeRequired: boolean;
  createdAt: number;
  controllerId: string;
  participants: Omit<Participant, 'connected'>[];
  speakers: string[];
  handQueue: string[];
}

const ROLES: Record<string, true> = { controller: true, speaker: true, audience: true };

/**
 * One stage. Pure, synchronous state machine: every method validates fully
 * before mutating (fail-closed), then re-checks invariants. No I/O here — the
 * hub serialises calls through the room's command queue and does the fan-out.
 */
export class Room {
  readonly roomId: string;
  readonly name: string;
  code: string;
  readonly codeRequired: boolean;
  readonly createdAt: number;
  readonly limits: RoomLimits;
  controllerId: string;
  readonly participants = new Map<string, Participant>();
  /** On-stage participant ids in stage-entry order (controller included while on stage). */
  readonly speakers = new Set<string>();
  readonly handQueue: string[] = [];
  readonly recordingAvailable: boolean;
  /** The mix is being recorded; the hub owns the file, the room owns the state everyone sees. */
  recording = false;

  constructor(init: {
    roomId: string;
    name: string;
    code: string;
    codeRequired: boolean;
    limits: RoomLimits;
    recordingAvailable?: boolean;
    now: number;
    controller: NewParticipant;
  }) {
    this.roomId = init.roomId;
    this.name = init.name;
    this.code = init.code;
    this.codeRequired = init.codeRequired;
    this.limits = init.limits;
    this.recordingAvailable = init.recordingAvailable ?? false;
    this.createdAt = init.now;
    const c = init.controller;
    this.participants.set(c.participantId, {
      ...c,
      joinedAt: init.now,
      role: 'controller',
      onStage: true,
      stageSince: init.now,
      handRaised: false,
      selfMuted: false,
      forceMuted: false,
      gainDb: 0,
      connected: true,
    });
    this.speakers.add(c.participantId);
    this.controllerId = c.participantId;
    this.assertInvariants();
  }

  /**
   * Rebuild a persisted room with everyone disconnected (they reclaim seats with their resume
   * tokens). Fields are re-read one by one and invariants re-checked against today's limits, so a
   * damaged file or tightened config fails here instead of corrupting a live room.
   */
  static restore(s: RoomSnapshot, limits: RoomLimits, recordingAvailable: boolean): Room {
    const bad = (why: string): never => { throw new InvariantViolation(`restore: ${why}`); };
    const text = (v: unknown, what: string): string => (typeof v === 'string' ? v : bad(what));
    const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : bad(what));
    const flag = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : bad(what));
    if (!Array.isArray(s.participants) || !Array.isArray(s.speakers) || !Array.isArray(s.handQueue)) bad('lists');
    const participants: Participant[] = s.participants.map((p) => ({
      participantId: text(p.participantId, 'participantId'),
      name: text(p.name, 'name'),
      resumeToken: text(p.resumeToken, 'resumeToken'),
      joinedAt: num(p.joinedAt, 'joinedAt'),
      role: ROLES[p.role] ? p.role : bad('role'),
      onStage: flag(p.onStage, 'onStage'),
      stageSince: num(p.stageSince, 'stageSince'),
      handRaised: flag(p.handRaised, 'handRaised'),
      selfMuted: flag(p.selfMuted, 'selfMuted'),
      forceMuted: flag(p.forceMuted, 'forceMuted'),
      gainDb: num(p.gainDb, 'gainDb'),
      connected: false,
    }));
    const controller = participants.find((p) => p.participantId === s.controllerId) ?? bad('controller missing');
    const room = new Room({
      roomId: text(s.roomId, 'roomId'),
      name: text(s.name, 'name'),
      code: text(s.code, 'code'),
      codeRequired: flag(s.codeRequired, 'codeRequired'),
      limits,
      recordingAvailable,
      now: num(s.createdAt, 'createdAt'),
      controller,
    });
    room.participants.clear();
    room.speakers.clear();
    for (const p of participants) room.participants.set(p.participantId, p);
    for (const id of s.speakers) room.speakers.add(text(id, 'speaker'));
    for (const id of s.handQueue) room.handQueue.push(text(id, 'hand'));
    room.assertInvariants();
    return room;
  }

  snapshotForRestart(): RoomSnapshot {
    return {
      roomId: this.roomId,
      name: this.name,
      code: this.code,
      codeRequired: this.codeRequired,
      createdAt: this.createdAt,
      controllerId: this.controllerId,
      participants: [...this.participants.values()].map(({ connected: _, ...p }) => p),
      speakers: [...this.speakers],
      handQueue: [...this.handQueue],
    };
  }

  get audienceCount(): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.role === 'audience') n++;
    return n;
  }

  get status(): 'waiting' | 'live' {
    return this.speakers.size > 0 ? 'live' : 'waiting';
  }

  /** On-stage participants other than the controller: what `limits.maxSpeakers` caps (the controller's seat is extra, like the audience cap). */
  get speakerCount(): number {
    return this.speakers.size - (this.speakers.has(this.controllerId) ? 1 : 0);
  }

  get(participantId: string): Participant | undefined {
    return this.participants.get(participantId);
  }

  // ─────────────────────────────── membership ───────────────────────────────

  join(np: NewParticipant, now: number): Participant {
    if (this.participants.size - 1 >= this.limits.maxAudience) throw new StageError('room_full', 'audience cap');
    if (this.participants.has(np.participantId)) throw new InvariantViolation('duplicate participant id');
    const p: Participant = {
      ...np,
      joinedAt: now,
      role: 'audience',
      onStage: false,
      stageSince: 0,
      handRaised: false,
      selfMuted: false,
      forceMuted: false,
      gainDb: 0,
      connected: true,
    };
    this.participants.set(p.participantId, p);
    this.assertInvariants();
    return p;
  }

  /** Remove a non-controller participant (disconnect). The controller seat must be transferred first. */
  remove(participantId: string): RoomEvent[] {
    const p = this.require(participantId);
    if (p.role === 'controller') throw new InvariantViolation('controller removed without transfer');
    const events: RoomEvent[] = [];
    if (p.onStage) {
      this.speakers.delete(participantId);
      events.push({ type: 'stage:left', participantId, role: 'audience', reason: 'leave' });
    }
    if (p.handRaised) {
      this.dequeueHand(participantId);
      events.push({ type: 'hand:withdraw', participantId });
    }
    this.participants.delete(participantId);
    this.assertInvariants();
    return events;
  }

  /** Controller removes someone from the room (their session is closed by the hub). */
  kick(byId: string, targetId: string): RoomEvent[] {
    this.requireController(byId);
    if (targetId === byId) throw new StageError('conflict', 'controller cannot kick itself');
    this.require(targetId);
    return this.remove(targetId);
  }

  /** Trim one participant's level in the mix; validation bounds the range. */
  setGain(byId: string, targetId: string, gainDb: number): void {
    this.requireController(byId);
    this.require(targetId).gainDb = gainDb;
  }

  /** New code for future joins; whoever is already inside stays. */
  rotateCode(byId: string, code: string): void {
    this.requireController(byId);
    if (!this.codeRequired) throw new StageError('conflict', 'room has no code');
    this.code = code;
  }

  /** Controller turns recording on or off; the hub starts or stops the file around this. */
  setRecording(byId: string, on: boolean): void {
    this.requireController(byId);
    if (!this.recordingAvailable) throw new StageError('forbidden', 'recording disabled on this server');
    if (this.recording === on) throw new StageError('conflict', on ? 'already recording' : 'not recording');
    this.recording = on;
  }

  // ─────────────────────────────── hands ───────────────────────────────

  raiseHand(participantId: string): RoomEvent[] {
    const p = this.require(participantId);
    if (p.role !== 'audience') throw new StageError('conflict', 'only audience can raise hand');
    if (p.handRaised) throw new StageError('conflict', 'hand already raised');
    p.handRaised = true;
    this.handQueue.push(participantId);
    this.assertInvariants();
    return [{ type: 'hand:raise', participantId }];
  }

  withdrawHand(participantId: string): RoomEvent[] {
    const p = this.require(participantId);
    if (!p.handRaised) throw new StageError('conflict', 'hand not raised');
    p.handRaised = false;
    this.dequeueHand(participantId);
    this.assertInvariants();
    return [{ type: 'hand:withdraw', participantId }];
  }

  // ─────────────────────────────── stage ───────────────────────────────

  /** Controller approves a raised hand — or approves itself to return to stage after stepping down. */
  approve(byId: string, targetId: string, now: number): RoomEvent[] {
    this.requireController(byId);
    const t = this.require(targetId);
    if (t.onStage) throw new StageError('conflict', 'target already on stage');
    if (targetId !== byId && !t.handRaised) throw new StageError('conflict', 'target has not raised hand');
    if (!t.connected) throw new StageError('conflict', 'target disconnected');
    if (targetId !== byId && this.speakerCount >= this.limits.maxSpeakers) throw new StageError('stage_full', 'speaker cap');

    const events: RoomEvent[] = [{ type: 'stage:invite', participantId: targetId, byId }];
    if (t.handRaised) {
      t.handRaised = false;
      this.dequeueHand(targetId);
    }
    if (t.role === 'audience') {
      t.role = 'speaker';
      events.push({ type: 'role:update', participantId: targetId, role: 'speaker', reason: 'approved' });
    }
    t.onStage = true;
    t.stageSince = now;
    this.speakers.add(targetId);
    this.assertInvariants();
    return events;
  }

  reject(byId: string, targetId: string): RoomEvent[] {
    this.requireController(byId);
    const t = this.require(targetId);
    if (!t.handRaised) throw new StageError('conflict', 'target has not raised hand');
    t.handRaised = false;
    this.dequeueHand(targetId);
    this.assertInvariants();
    return [{ type: 'hand:withdraw', participantId: targetId }];
  }

  /** Step down. The controller only stops speaking and keeps control (PLAN 假設 4). */
  leaveStage(participantId: string): RoomEvent[] {
    const p = this.require(participantId);
    if (!p.onStage) throw new StageError('conflict', 'not on stage');
    return this.takeOffStage(p, 'leave');
  }

  removeFromStage(byId: string, targetId: string): RoomEvent[] {
    this.requireController(byId);
    if (targetId === byId) throw new StageError('conflict', 'controller uses stage:leave');
    const t = this.require(targetId);
    if (!t.onStage) throw new StageError('conflict', 'target not on stage');
    return this.takeOffStage(t, 'removed');
  }

  private takeOffStage(p: Participant, reason: StageLeftReason): RoomEvent[] {
    p.onStage = false;
    p.selfMuted = false;
    p.forceMuted = false;
    this.speakers.delete(p.participantId);
    const events: RoomEvent[] = [];
    if (p.role === 'speaker') {
      p.role = 'audience';
      events.push({ type: 'role:update', participantId: p.participantId, role: 'audience', reason });
    }
    events.push({ type: 'stage:left', participantId: p.participantId, role: p.role, reason });
    this.assertInvariants();
    return events;
  }

  // ─────────────────────────────── control ───────────────────────────────

  transfer(byId: string, targetId: string, reason = 'transfer'): RoomEvent[] {
    this.requireController(byId);
    if (targetId === byId) throw new StageError('conflict', 'already controller');
    const t = this.require(targetId);
    if (!t.connected) throw new StageError('conflict', 'target disconnected');
    const from = this.require(byId);
    // The old controller's seat becomes a capped speaker seat; refuse rather than exceed the cap (step down first).
    if (from.onStage && !t.onStage && this.speakerCount >= this.limits.maxSpeakers) throw new StageError('stage_full', 'stage full for the outgoing controller');

    const events: RoomEvent[] = [];
    if (t.handRaised) {
      t.handRaised = false;
      this.dequeueHand(targetId);
      events.push({ type: 'hand:withdraw', participantId: targetId });
    }
    from.role = from.onStage ? 'speaker' : 'audience';
    t.role = 'controller';
    this.controllerId = targetId;
    this.assertInvariants();
    events.push(
      { type: 'control:transferred', fromId: byId, toId: targetId },
      { type: 'role:update', participantId: byId, role: from.role, reason },
      { type: 'role:update', participantId: targetId, role: 'controller', reason },
    );
    return events;
  }

  /**
   * Successor after the controller's grace period expired: earliest on-stage
   * speaker, else earliest audience member (PLAN 假設 4). Only connected people qualify.
   */
  pickSuccessor(): Participant | undefined {
    let best: Participant | undefined;
    for (const id of this.speakers) {
      const p = this.participants.get(id);
      if (p && id !== this.controllerId && p.connected && (!best || p.stageSince < best.stageSince)) best = p;
    }
    if (best) return best;
    for (const p of this.participants.values()) {
      if (p.role === 'audience' && p.connected && (!best || p.joinedAt < best.joinedAt)) best = p;
    }
    return best;
  }

  // ─────────────────────────────── mic ───────────────────────────────

  mute(participantId: string): RoomEvent[] {
    const p = this.require(participantId);
    if (!p.onStage) throw new StageError('conflict', 'not on stage');
    return this.setMute(p, () => (p.selfMuted = true));
  }

  unmute(participantId: string): RoomEvent[] {
    const p = this.require(participantId);
    if (!p.onStage) throw new StageError('conflict', 'not on stage');
    if (p.forceMuted) throw new StageError('forbidden', 'force-muted by controller');
    return this.setMute(p, () => (p.selfMuted = false));
  }

  forceMute(byId: string, targetId: string): RoomEvent[] {
    this.requireController(byId);
    const t = this.require(targetId);
    if (!t.onStage) throw new StageError('conflict', 'target not on stage');
    return this.setMute(t, () => (t.forceMuted = true));
  }

  /** Lifts the controller lock only; the participant's own self-mute is preserved (no remote mic opening). */
  forceUnmute(byId: string, targetId: string): RoomEvent[] {
    this.requireController(byId);
    const t = this.require(targetId);
    if (!t.onStage) throw new StageError('conflict', 'target not on stage');
    return this.setMute(t, () => (t.forceMuted = false));
  }

  private setMute(p: Participant, mutate: () => void): RoomEvent[] {
    const before = p.selfMuted || p.forceMuted;
    mutate();
    const after = p.selfMuted || p.forceMuted;
    this.assertInvariants();
    if (before === after) return [];
    return [{ type: after ? 'mic:muted' : 'mic:unmuted', participantId: p.participantId }];
  }

  // ─────────────────────────────── views ───────────────────────────────

  view(p: Participant): ParticipantView {
    return {
      participantId: p.participantId,
      name: p.name,
      role: p.role,
      onStage: p.onStage,
      handRaised: p.handRaised,
      muted: p.selfMuted || p.forceMuted,
      forceMuted: p.forceMuted,
      gainDb: p.gainDb,
      connected: p.connected,
      joinedAt: p.joinedAt,
    };
  }

  /** Snapshot fields identical for every recipient; compute once per broadcast. */
  sharedSnapshot(): Omit<RoomStatePayload, 'me' | 'resumeToken' | 'audience' | 'code'> {
    const pick = (ids: Iterable<string>) => [...ids].map((id) => this.view(this.require(id)));
    return {
      roomId: this.roomId,
      name: this.name,
      controllerId: this.controllerId,
      speakers: pick(this.speakers),
      hands: pick(this.handQueue),
      audienceCount: this.audienceCount,
      codeRequired: this.codeRequired,
      limits: { maxSpeakers: this.limits.maxSpeakers, maxAudience: this.limits.maxAudience },
      status: this.status,
      recording: this.recording,
      recordingAvailable: this.recordingAvailable,
    };
  }

  /** Recipient-specific fields; controller-only and recipient-only fields are added here, nowhere else. */
  personalSnapshot(forId: string): Pick<RoomStatePayload, 'me' | 'resumeToken' | 'audience' | 'code'> {
    const me = this.require(forId);
    const state: Pick<RoomStatePayload, 'me' | 'resumeToken' | 'audience' | 'code'> = { me: this.view(me), resumeToken: me.resumeToken };
    if (me.role === 'controller') {
      state.audience = [...this.participants.values()].filter((p) => p.role === 'audience').map((p) => this.view(p));
      if (this.codeRequired) state.code = this.code;
    }
    return state;
  }

  snapshot(forId: string): RoomStatePayload {
    return { ...this.sharedSnapshot(), ...this.personalSnapshot(forId) };
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private require(participantId: string): Participant {
    const p = this.participants.get(participantId);
    if (!p) throw new StageError('not_found', 'participant not in room');
    return p;
  }

  private requireController(byId: string): void {
    if (byId !== this.controllerId) throw new StageError('forbidden', 'controller only');
  }

  private dequeueHand(participantId: string): void {
    const i = this.handQueue.indexOf(participantId);
    if (i >= 0) this.handQueue.splice(i, 1);
  }

  /** PLAN §5 invariants. Throws InvariantViolation; the hub then closes the room (fail-closed). */
  assertInvariants(): void {
    const fail = (why: string): never => {
      throw new InvariantViolation(`room ${this.roomId}: ${why}`);
    };
    let controllers = 0;
    let nonController = 0;
    for (const p of this.participants.values()) {
      if (p.role === 'controller') controllers++;
      else nonController++;
      if (p.onStage !== this.speakers.has(p.participantId)) fail('onStage/speakers mismatch');
      if (p.role === 'speaker' && !p.onStage) fail('speaker off stage');
      if (p.handRaised !== this.handQueue.includes(p.participantId)) fail('hand flag/queue mismatch');
      if (p.handRaised && p.role !== 'audience') fail('non-audience in hand queue');
      if (!p.onStage && (p.selfMuted || p.forceMuted)) fail('mute flags off stage');
    }
    if (controllers !== 1) fail(`expected 1 controller, found ${controllers}`);
    if (this.participants.get(this.controllerId)?.role !== 'controller') fail('controllerId mismatch');
    for (const id of this.speakers) if (!this.participants.has(id)) fail('unknown speaker');
    if (new Set(this.handQueue).size !== this.handQueue.length) fail('duplicate hand');
    if (this.speakerCount > this.limits.maxSpeakers) fail('speaker cap exceeded');
    if (nonController > this.limits.maxAudience) fail('audience cap exceeded');
  }
}
