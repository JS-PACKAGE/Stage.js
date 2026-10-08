import {
  CLIENT_MESSAGE_TYPES,
  type ClientMessage,
  type ClientMessageType,
  type IceCandidatePayload,
  type SessionDescriptionPayload,
} from '../../shared/protocol.ts';
import type { AppConfig } from '../config.ts';
import { StageError } from '../model/errors.ts';

export type ValidationLimits = Pick<AppConfig['limits'], 'nameMaxLength' | 'codeMaxLength' | 'sdpMaxLength'>;

/** Failed validation; `requestId` is echoed when it could be read safely. */
export class ValidationError extends StageError {
  readonly requestId: string | undefined;
  constructor(code: 'bad_request' | 'unknown_type', detail: string, requestId: string | undefined) {
    super(code, detail);
    this.requestId = requestId;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_RE = /^[A-Za-z0-9]+$/;
/** Control, format (bidi overrides, zero-width) and line/paragraph separators are stripped from names. */
const UNSAFE_CHARS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const KNOWN_TYPES: Record<string, true> = Object.fromEntries(CLIENT_MESSAGE_TYPES.map((t) => [t, true]));

/** Display names are stored and emitted HTML-escaped so embedding sites stay XSS-safe (AGENTS.md §S8). */
export function sanitizeName(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.normalize('NFC').replace(UNSAFE_CHARS_RE, '').trim();
  const length = [...cleaned].length;
  if (length === 0 || length > maxLength) return undefined;
  return cleaned.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Parse and whitelist one inbound frame. Builds fresh objects field by field,
 * so unknown properties never reach the core.
 */
export function parseClientMessage(text: string, limits: ValidationLimits): ClientMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError('bad_request', 'invalid json', undefined);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('bad_request', 'not an object', undefined);
  }
  const m = raw as Record<string, unknown>;
  const requestId = typeof m.requestId === 'string' && ID_RE.test(m.requestId) ? m.requestId : undefined;
  const type = m.type;
  if (typeof type !== 'string' || KNOWN_TYPES[type] !== true) {
    throw new ValidationError('unknown_type', 'unknown type', requestId);
  }
  const bad = (detail: string): never => {
    throw new ValidationError('bad_request', `${type}: ${detail}`, requestId);
  };
  const t = type as ClientMessageType;
  if (t === 'ping') return { type: 'ping' };
  if (requestId === undefined) bad('requestId');
  const rid = requestId as string;

  const id = (key: string): string => {
    const v = m[key];
    if (typeof v !== 'string' || !ID_RE.test(v)) bad(key);
    return v as string;
  };
  const optCode = (): string | undefined => {
    const v = m.code;
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > limits.codeMaxLength || !CODE_RE.test(v)) bad('code');
    return (v as string).toUpperCase();
  };

  switch (t) {
    case 'room:create': {
      const out: ClientMessage = { type: t, requestId: rid };
      if (m.name !== undefined) out.name = sanitizeName(m.name, limits.nameMaxLength) ?? bad('name');
      if (m.roomName !== undefined) out.roomName = sanitizeName(m.roomName, limits.nameMaxLength) ?? bad('roomName');
      if (m.codeRequired !== undefined) {
        if (typeof m.codeRequired !== 'boolean') bad('codeRequired');
        out.codeRequired = m.codeRequired as boolean;
      }
      return out;
    }
    case 'join': {
      const out: ClientMessage = {
        type: t,
        requestId: rid,
        roomId: id('roomId'),
        name: sanitizeName(m.name, limits.nameMaxLength) ?? bad('name'),
      };
      const code = optCode();
      if (code !== undefined) out.code = code;
      if (m.resumeToken !== undefined) out.resumeToken = id('resumeToken');
      return out;
    }
    case 'room:close':
    case 'hand:raise':
    case 'hand:withdraw':
    case 'stage:leave':
    case 'mic:mute':
    case 'mic:unmute':
      return { type: t, requestId: rid };
    case 'stage:approve':
    case 'stage:reject':
    case 'control:transfer':
    case 'mic:force-mute':
    case 'mic:force-unmute':
    case 'stage:remove':
      return { type: t, requestId: rid, targetId: id('targetId') };
    case 'rtc:offer':
    case 'rtc:answer':
      return { type: t, requestId: rid, payload: description(m.payload, t === 'rtc:offer' ? 'offer' : 'answer', limits, bad) };
    case 'rtc:ice':
      return { type: t, requestId: rid, payload: candidate(m.payload, bad) };
  }
}

function description(
  v: unknown,
  expected: 'offer' | 'answer',
  limits: ValidationLimits,
  bad: (d: string) => never,
): SessionDescriptionPayload {
  if (typeof v !== 'object' || v === null) return bad('payload');
  const p = v as Record<string, unknown>;
  if (p.type !== expected) bad('payload.type');
  if (typeof p.sdp !== 'string' || p.sdp.length === 0 || p.sdp.length > limits.sdpMaxLength) bad('payload.sdp');
  return { type: expected, sdp: p.sdp as string };
}

function candidate(v: unknown, bad: (d: string) => never): IceCandidatePayload | null {
  if (v === null) return null;
  if (typeof v !== 'object') return bad('payload');
  const p = v as Record<string, unknown>;
  if (typeof p.candidate !== 'string' || p.candidate.length > 1024) bad('payload.candidate');
  const out: IceCandidatePayload = { candidate: p.candidate as string };
  if (p.sdpMid !== undefined) {
    if (p.sdpMid !== null && (typeof p.sdpMid !== 'string' || p.sdpMid.length > 64)) bad('payload.sdpMid');
    out.sdpMid = p.sdpMid as string | null;
  }
  if (p.sdpMLineIndex !== undefined) {
    const i = p.sdpMLineIndex;
    if (i !== null && (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i > 64)) bad('payload.sdpMLineIndex');
    out.sdpMLineIndex = i as number | null;
  }
  if (p.usernameFragment !== undefined) {
    const u = p.usernameFragment;
    if (u !== null && (typeof u !== 'string' || u.length > 256)) bad('payload.usernameFragment');
    out.usernameFragment = u as string | null;
  }
  return out;
}
