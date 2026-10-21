import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const options = JSON.parse(readFileSync(new URL('../fixture.json', import.meta.url), 'utf8'));
const config = parse(readFileSync(process.env.STAGE_CONFIG, 'utf8'));
const { scenario = 'success' } = options;
writeFileSync(options.reportPath, JSON.stringify({ pid: process.pid, root, cwd: process.cwd(), configPath: process.env.STAGE_CONFIG }));
assert.ok(isAbsolute(process.env.STAGE_CONFIG));
assert.notEqual(process.cwd(), root);
assert.deepEqual(readdirSync(process.cwd()), []);
assert.deepEqual(readdirSync(root).sort(), ['dist', 'node_modules', 'package.json', 'packages', 'web']);
assert.equal(existsSync(join(root, 'src')), false);
assert.equal(existsSync(join(root, 'config.yaml')), false);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.NODE_PATH, undefined);
assert.equal(config.server.host, '127.0.0.1');
assert.equal(config.server.port, 0);
assert.equal(config.server.allowInsecure, true);
assert.equal(config.server.trustProxy, false);
assert.deepEqual(config.server.tls, { certFile: '', keyFile: '' });
assert.deepEqual(config.server.metrics, { enabled: false, token: '' });
assert.deepEqual(config.rtc.iceServers, []);
assert.deepEqual(config.rtc.serverIceServers, []);
assert.deepEqual(config.rtc.turn, { urls: [], secret: '', ttlSeconds: 86400 });
assert.equal(config.rtc.mediaWorkers, 0);
assert.equal(config.audio.codecWorkers, 1);
assert.equal(config.rooms.createToken, '');
assert.equal(config.log.level, 'info');
const log = value => process.stderr.write(JSON.stringify(value) + '\n');
if (scenario === 'early-exit') process.exit(7);
if (scenario === 'never-ready') await new Promise(() => setInterval(() => {}, 1000));
if (scenario === 'malformed-log') { process.stderr.write('{bad JSON\n'); await new Promise(() => setInterval(() => {}, 1000)); }
if (scenario === 'output-limit') { process.stderr.write('x'.repeat(128 * 1024)); await new Promise(() => setInterval(() => {}, 1000)); }
const server = createServer((req, res) => {
  if (scenario === 'http-timeout' && req.url === '/healthz') { writeFileSync(options.reportPath + '.http', 'pending'); return; }
  if (scenario === 'http-trickle' && req.url === '/healthz') { res.write('x'); const tick = setInterval(() => res.write('x'), 20); res.once('close', () => clearInterval(tick)); return; }
  if (scenario === 'http-reset' && req.url === '/healthz') { req.socket.destroy(); return; }
  if (scenario === 'http-overflow' && req.url === '/healthz') { res.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
  if (req.url === '/healthz') { res.end(scenario === 'health-body' ? 'bad' : 'ok'); return; }
  if (req.url === '/readyz') { res.writeHead(scenario === 'not-ready' ? 503 : 200).end('ready'); return; }
  const route = new URL(req.url, 'http://127.0.0.1').pathname;
  const mount = config.server.static.find(item => route.startsWith(item.mount));
  if (!mount) { res.writeHead(404).end(); return; }
  const name = route.slice(mount.mount.length) || 'index.html';
  const file = join(root, mount.dir, name);
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript';
  res.setHeader('content-type', scenario === 'wrong-mime' ? 'text/plain' : `${type}; charset=utf-8`);
  res.end(scenario === 'wrong-bytes' || (scenario === 'wrong-asset' && name === 'assets/app.js') ? 'wrong artifact' : readFileSync(file));
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (scenario === 'ws-handshake-timeout') return;
  if (req.url !== config.server.wsPath || scenario === 'ws-reject') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', ws => {
  ws.on('message', () => { throw new Error('Checker must not send room or peer messages'); });
  if (scenario === 'ws-early-close') { ws.close(); return; }
  if (scenario === 'ws-timeout') return;
  if (scenario === 'ws-overflow') { ws.send('x'.repeat(65537)); return; }
  if (scenario === 'ws-malformed') { ws.send('{bad JSON'); return; }
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  ws.send(JSON.stringify({ type: 'hello', instance: 'test-server', protocol: 1, serverVersion: scenario === 'wrong-hello' ? 'wrong' : version, limits: { controlPerSecond: config.limits.controlPerSecond, icePerSecond: config.limits.icePerSecond, handRaiseIntervalMs: config.limits.handRaiseIntervalMs, chatIntervalMs: config.limits.chatIntervalMs, reactionIntervalMs: config.limits.reactionIntervalMs } }));
});
await new Promise(resolve => server.listen(config.server.port, config.server.host, resolve));
const port = server.address().port;
if (scenario === 'startup-error') log({ level: 'error', msg: 'synthetic startup error' });
log({ msg: 'Stage.js listening', url: scenario === 'malformed-address' ? 'not a URL' : scenario === 'foreign-address' ? `http://192.0.2.1:${port}` : `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}${config.server.wsPath}` });
if (scenario === 'ready-then-exit') process.exit(0);
if (scenario === 'late-output-limit') server.once('request', () => process.stderr.write('x'.repeat(128 * 1024)));
process.on('SIGTERM', () => {
  if (scenario === 'ignored-shutdown') return;
  log({ msg: 'shutting down', signal: 'SIGTERM' });
  for (const ws of wss.clients) ws.close(scenario === 'wrong-close' ? 1000 : 1001, 'server shutdown');
  server.close(() => process.exit(scenario === 'nonzero-shutdown' ? 9 : 0));
});
