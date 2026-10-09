/**
 * Stage.js wire protocol (control plane over WebSocket, JSON frames).
 *
 * Single source of truth shared by the server (`src/`) and the browser client
 * (`packages/client`). Types only plus a few constants — no runtime deps.
 *
 * Extensions beyond PLAN.md §4 (documented in README):
 *   - S→C `ok`        : success acknowledgement for a request carrying `requestId`.
 *   - S→C `pong`      : reply to `ping`.
 *   - S→C `rtc:config`: ICE servers for the client PeerConnection (sent after join).
 *   - `room:create.roomName` / `room:create.codeRequired`: room display name and
 *     whether the room code is required (PLAN 假設 9: code can be disabled).
 *   - `join.resumeToken`: lets a disconnected controller reclaim its seat within
 *     the grace period (PLAN §5: controller auto-transfer only after 60 s).
 *   - `room:state` carries `onStage`/`forceMuted` per participant, `audienceCount`,
 *     and controller-only fields (`code`, `audience`), recipient-only `resumeToken`.
 *   - S→C `speaking`  : participants currently audible in the mix (voice activity with
 *     a release hold); sent only when the set changes.
 *   - C→S `participant:kick` (controller): removes a participant from the room; the target
 *     gets S→C `kicked` and its connection is closed (it must not auto-rejoin). Kick, then
 *     `room:rotate-code`, to keep them out.
 *   - C→S `room:rotate-code` (controller, code-protected rooms): replaces the room code;
 *     participants already inside stay. The controller's next `room:state` carries the new code.
 *   - S→C `quality`   : connection quality of everyone publishing audio, every
 *     `rooms.qualityIntervalMs`, sent to the controller and on-stage participants.
 */

export const PROTOCOL_VERSION = 1;

/** Opaque id assigned by the server to the server-side WebRTC peer. */
export const SERVER_PEER_ID = 'server';

export type Role = 'controller' | 'speaker' | 'audience';

export type StageStatus = 'waiting' | 'live' | 'reconnecting';

export interface ParticipantView {
  participantId: string;
  name: string;
  role: Role;
  /** Controller can be off stage while keeping control (PLAN 假設 4). */
  onStage: boolean;
  handRaised: boolean;
  /** Effective mute (self-mute OR force-mute). */
  muted: boolean;
  /** Muted by the controller; participant cannot self-unmute. */
  forceMuted: boolean;
  /** ms since epoch */
  joinedAt: number;
}

export interface RoomStatePayload {
  roomId: string;
  name: string;
  controllerId: string;
  /** Everyone currently on stage (controller included when on stage), stage-join order. */
  speakers: ParticipantView[];
  /** Raised hands in queue order. */
  hands: ParticipantView[];
  audienceCount: number;
  codeRequired: boolean;
  limits: { maxSpeakers: number; maxAudience: number };
  status: Exclude<StageStatus, 'reconnecting'>;
  me: ParticipantView;
  /** Controller only: full audience list (role `audience`, plus off-stage controller is in `me`). */
  audience?: ParticipantView[];
  /** Controller only. */
  code?: string;
  /** Recipient only: reclaim seat after disconnect (controller grace period). */
  resumeToken?: string;
}

export interface SessionDescriptionPayload {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Measured since the previous `quality` report; fields are absent until there is data. */
export interface ConnectionQuality {
  participantId: string;
  /** Share of the participant's uplink packets the server lost (0–100). */
  uplinkLossPercent?: number;
  /** Share of the mix the participant reports losing (0–100, smoothed RTCP receiver reports). */
  downlinkLossPercent?: number;
  rttMs?: number;
}

export type StageLeftReason = 'leave' | 'removed';

export type ErrorCode =
  | 'bad_request'
  | 'unknown_type'
  | 'not_joined'
  | 'already_joined'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'room_full'
  | 'stage_full'
  | 'rate_limited'
  | 'internal';

// ───────────────────────────── Server → Client ─────────────────────────────

export interface ServerMessageMap {
  hello: { protocol: number; serverVersion: string };
  'room:state': RoomStatePayload;
  'room:created': { roomId: string; code?: string };
  'room:closed': { roomId: string };
  'role:update': { participantId: string; role: Role; reason?: string };
  'hand:raise': { participantId: string };
  'hand:withdraw': { participantId: string };
  'stage:invite': { participantId: string; byId: string };
  'stage:joined': { participantId: string; role: Role };
  'stage:left': { participantId: string; role: Role; reason?: StageLeftReason };
  'control:transferred': { fromId: string; toId: string };
  'mic:muted': { participantId: string };
  'mic:unmuted': { participantId: string };
  'rtc:offer': { fromId: string; payload: SessionDescriptionPayload };
  'rtc:answer': { fromId: string; payload: SessionDescriptionPayload };
  'rtc:ice': { fromId: string; payload: IceCandidatePayload | null };
  'rtc:config': { iceServers: IceServerConfig[] };
  speaking: { participantIds: string[] };
  error: { requestId?: string; code: ErrorCode; message: string };
  status: { state: StageStatus };
  ok: { requestId: string };
  pong: Record<never, never>;
  kicked: { roomId: string };
  quality: { participants: ConnectionQuality[] };
}

export type ServerMessageType = keyof ServerMessageMap;

export type ServerMessage = {
  [K in ServerMessageType]: { type: K } & ServerMessageMap[K];
}[ServerMessageType];

// ───────────────────────────── Client → Server ─────────────────────────────

export interface ClientMessageMap {
  'room:create': { requestId: string; name?: string; roomName?: string; codeRequired?: boolean };
  'room:close': { requestId: string };
  join: { requestId: string; roomId: string; code?: string; name: string; resumeToken?: string };
  'hand:raise': { requestId: string };
  'hand:withdraw': { requestId: string };
  'stage:approve': { requestId: string; targetId: string };
  'stage:reject': { requestId: string; targetId: string };
  'stage:leave': { requestId: string };
  'control:transfer': { requestId: string; targetId: string };
  'mic:mute': { requestId: string };
  'mic:unmute': { requestId: string };
  'mic:force-mute': { requestId: string; targetId: string };
  'mic:force-unmute': { requestId: string; targetId: string };
  'stage:remove': { requestId: string; targetId: string };
  'participant:kick': { requestId: string; targetId: string };
  'room:rotate-code': { requestId: string };
  'rtc:offer': { requestId: string; payload: SessionDescriptionPayload };
  'rtc:answer': { requestId: string; payload: SessionDescriptionPayload };
  'rtc:ice': { requestId: string; payload: IceCandidatePayload | null };
  ping: Record<never, never>;
}

export type ClientMessageType = keyof ClientMessageMap;

export type ClientMessage = {
  [K in ClientMessageType]: { type: K } & ClientMessageMap[K];
}[ClientMessageType];

export const CLIENT_MESSAGE_TYPES: readonly ClientMessageType[] = [
  'room:create',
  'room:close',
  'join',
  'hand:raise',
  'hand:withdraw',
  'stage:approve',
  'stage:reject',
  'stage:leave',
  'control:transfer',
  'mic:mute',
  'mic:unmute',
  'mic:force-mute',
  'mic:force-unmute',
  'stage:remove',
  'participant:kick',
  'room:rotate-code',
  'rtc:offer',
  'rtc:answer',
  'rtc:ice',
  'ping',
];
