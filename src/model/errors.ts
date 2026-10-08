import type { ErrorCode } from '../../shared/protocol.ts';

/** A rejected request. `code` goes to the client; `detail` stays in the local log only (AGENTS.md §S8). */
export class StageError extends Error {
  readonly code: ErrorCode;
  readonly detail: string;
  constructor(code: ErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

/** State machine invariant broken — the room is closed fail-closed (AGENTS.md §S6). */
export class InvariantViolation extends Error {}

/** Fixed generic client-facing messages; internal reasons never leave the server. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bad_request: 'Bad request',
  unknown_type: 'Unknown message type',
  not_joined: 'Not in a room',
  already_joined: 'Already in a room',
  unauthorized: 'Cannot join room',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  conflict: 'Not allowed in current state',
  room_full: 'Room is full',
  stage_full: 'Stage is full',
  rate_limited: 'Too many requests',
  internal: 'Internal error',
};
