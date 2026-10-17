import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// This entry has no service imports, sockets, rooms, peers, or dependencies.
const root = process.cwd();
const token = process.env.STAGE_FIXTURE_TOKEN;
if (!token || !/^[a-f0-9]{32}$/.test(token)) throw new Error('Missing fixture ownership token');
const record = { token, pid: process.pid, cwd: root };
const finish = (reason) => {
  appendFileSync(join(root, 'fixture-exits.jsonl'), `${JSON.stringify({ ...record, reason })}\n`);
  process.exit(reason === 'watchdog' ? 82 : 0);
};
appendFileSync(join(root, 'fixture-starts.jsonl'), `${JSON.stringify(record)}\n`);
writeFileSync(join(root, `fixture-ready-${process.pid}.json`), JSON.stringify(record));
process.stdout.write(`fixture stdout ${token}\n`);
process.stderr.write(`fixture stderr ${token}\n`);
setInterval(() => {
  const beforeWrite = join(root, 'fixture-exit-before-pid-write');
  if (existsSync(beforeWrite) && readFileSync(beforeWrite, 'utf8') === token) finish('before-pid-write');
  const cleanup = join(root, 'fixture-cleanup');
  if (existsSync(cleanup) && readFileSync(cleanup, 'utf8') === token) finish('cleanup');
}, 50);
// Also bounds the child lifetime if the test runner or PowerShell driver dies.
setTimeout(() => finish('watchdog'), 30_000);
