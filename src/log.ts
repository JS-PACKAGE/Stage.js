/**
 * Minimal structured logger. Security rule (AGENTS.md §S5/§S8/§S10): never pass
 * room codes, resume tokens, TURN credentials or raw SDP into log fields.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Field names that must never reach the log, even by accident. */
const REDACT = /^(code|resumeToken|token|credential|password|username|secret|sdp|payload)$/i;

export function createLogger(level: LogLevel, sink: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const safe: Record<string, unknown> = {};
    if (fields) for (const [k, v] of Object.entries(fields)) safe[k] = REDACT.test(k) ? '[redacted]' : v;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...safe }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
