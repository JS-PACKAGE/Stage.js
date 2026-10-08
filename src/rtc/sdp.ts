export type MediaDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

export interface OfferSummary {
  /** Kinds of every m-line, in order. */
  kinds: string[];
  /** Direction of each audio m-line (from the client's point of view). */
  audioDirections: MediaDirection[];
}

const DIRECTIONS: Record<string, MediaDirection> = {
  sendrecv: 'sendrecv',
  sendonly: 'sendonly',
  recvonly: 'recvonly',
  inactive: 'inactive',
};

/**
 * Parse just enough SDP to enforce role policy before the offer reaches the
 * WebRTC stack. Direction defaults: m-line attribute, else session attribute,
 * else `sendrecv` (RFC 4566 §6). Rejected m-lines (port 0) count as inactive.
 */
export function summarizeOffer(sdp: string): OfferSummary {
  const lines = sdp.split(/\r?\n/);
  let sessionDir: MediaDirection | undefined;
  const sections: { kind: string; port: string; dir?: MediaDirection }[] = [];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const [kind = '', port = ''] = line.slice(2).split(' ');
      sections.push({ kind, port });
      continue;
    }
    if (!line.startsWith('a=')) continue;
    const attr = line.slice(2).trim();
    if (!Object.hasOwn(DIRECTIONS, attr)) continue;
    const dir = DIRECTIONS[attr] as MediaDirection;
    const current = sections.at(-1);
    if (current) current.dir = dir;
    else sessionDir = dir;
  }
  return {
    kinds: sections.map((s) => s.kind),
    audioDirections: sections
      .filter((s) => s.kind === 'audio')
      .map((s) => (s.port === '0' ? 'inactive' : (s.dir ?? sessionDir ?? 'sendrecv'))),
  };
}

/** True if the client intends to send audio on any m-line. */
export function offerSendsAudio(summary: OfferSummary): boolean {
  return summary.audioDirections.some((d) => d === 'sendrecv' || d === 'sendonly');
}
