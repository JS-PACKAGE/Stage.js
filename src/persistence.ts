import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from './log.ts';
import type { PersistedState } from './ws/hub.ts';

/**
 * Reads the saved rooms. A missing file is a normal first start; an unreadable, foreign or
 * too-old file is logged and ignored (nobody's seat would have survived that long anyway).
 */
export function loadState(file: string, maxAgeMs: number, now: number, log: Logger): PersistedState | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.error('state file unreadable', { error: (err as Error).message });
    return undefined;
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    log.error('state file is not valid JSON, ignored');
    return undefined;
  }
  const s = state as Partial<PersistedState> | null;
  if (!s || s.version !== 1 || typeof s.savedAt !== 'number' || !Array.isArray(s.rooms)) {
    log.error('state file has an unknown format, ignored');
    return undefined;
  }
  if (now - s.savedAt > maxAgeMs) {
    log.info('state file older than persistence.restoreGraceMs, ignored', { ageMs: now - s.savedAt });
    return undefined;
  }
  return s as PersistedState;
}

/**
 * Writes atomically (temp file, then rename) so a crash mid-write leaves the previous state.
 * Mode 600: the file holds room codes and resume tokens. Async, so the mixer clock is not stalled
 * by the disk; only the JSON.stringify runs on the main thread.
 */
export async function saveState(file: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, file);
}
