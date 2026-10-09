import { createHmac } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import type { IceServerConfig } from '../../shared/protocol.ts';

/**
 * ICE servers for one participant: the static list plus, when `rtc.turn` is configured,
 * a TURN entry with time-limited credentials (coturn `use-auth-secret`, TURN REST API):
 * username `<expiry unix seconds>:<participantId>`, credential base64(HMAC-SHA1(secret, username)).
 * The shared secret never leaves the server; a leaked credential expires after `ttlSeconds`.
 */
export function iceServersFor(rtc: AppConfig['rtc'], participantId: string, nowMs: number): IceServerConfig[] {
  const { turn } = rtc;
  if (!turn.urls.length) return rtc.iceServers;
  const username = `${Math.floor(nowMs / 1000) + turn.ttlSeconds}:${participantId}`;
  const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
  return [...rtc.iceServers, { urls: turn.urls, username, credential }];
}
