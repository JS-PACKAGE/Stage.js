import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Synthetic boundary probe only: it does not parse YAML or import production
// dependencies. The real built checker/schema is covered by the Linux gates.
const root = process.cwd();
const token = process.env.STAGE_FIXTURE_TOKEN;
if (!token || !/^[a-f0-9]{32}$/.test(token)) throw new Error('Missing fixture ownership token');
const settings = JSON.parse(readFileSync(join(root, 'fixture-settings.json'), 'utf8'));
appendFileSync(join(root, 'fixture-checks.jsonl'), `${JSON.stringify({
  token, cwd: root, argv: process.argv.slice(2), config: process.env.STAGE_CONFIG ?? null,
})}\n`);
process.exit(settings.checkerExit ?? 0);
