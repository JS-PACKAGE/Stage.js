/** Real loopback control plane with a controlled limiter clock and mock media only. */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { parseConfig, type AppConfig } from '../../src/config.ts';
import { silentLogger } from '../../src/log.ts';
import { createStageServer } from '../../src/ws/server.ts';
import { harness } from '../helpers.ts';

// Validate the actual low-rate input rather than patching an already-validated config.
const raw = parse(readFileSync(new URL('../../config.example.yaml', import.meta.url), 'utf8')) as AppConfig;
raw.server.host = '127.0.0.1'; raw.server.port = 0; raw.server.static = [];
raw.limits.controlPerSecond = Number(process.argv[2]);
raw.rooms.presenceBroadcastMs = 0; raw.rooms.qualityIntervalMs = 0;
const config = parseConfig(raw);
let now = 0;
const warnings: { message: string; fields: unknown }[] = [];
const log = { ...silentLogger, warn(message: string, fields?: Record<string, unknown>) { warnings.push({ message, fields }); } };
const h = harness(config, log);
const host = await h.create('Host', { codeRequired: false });
const server = createStageServer({ config, hub: h.hub, log, baseDir: process.cwd(), now: () => now });
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(peer: object): number {
  if (!identities.has(peer)) identities.set(peer, ++nextIdentity);
  return identities.get(peer)!;
}
process.on('message', (message: { id: number; type: 'clock' | 'inspect'; now?: number }) => {
  if (message.type === 'clock') {
    if (message.now === undefined || message.now < now) throw new Error('invalid test clock');
    now = message.now;
  }
  const peers = [...h.transport.rooms].flatMap(([roomId, room]) => [...room.peers].map(([participantId, peer]) => ({ roomId, participantId, identity: identity(peer) })));
  process.send?.({ id: message.id, now, peers, warnings });
});
process.on('disconnect', () => { void server.close().finally(() => h.transport.close()); });
const address = await server.listen();
process.send?.({ url: `ws://127.0.0.1:${address.port}${config.server.wsPath}`, roomId: host.roomId, rate: config.limits.controlPerSecond });
