import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { parseDocument } from 'yaml';

const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const document = parseDocument(source, { uniqueKeys: true });
// This checks the authored automation contract, not GitHub's runtime or native media acceptance.
interface Step { uses?: string; run?: string; with?: Record<string, unknown>; [key: string]: unknown }
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, unknown>;
  concurrency: Record<string, unknown>;
  jobs: { validate: { steps: Step[]; [key: string]: unknown } };
  [key: string]: unknown;
}
const workflow = document.toJS() as Workflow;

it('defines valid YAML and only branch-push and pull-request automation', () => {
  assert.deepEqual(document.errors, []);
  assert.deepEqual(Object.keys(workflow).sort(), ['concurrency', 'jobs', 'name', 'on', 'permissions']);
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflow.on.push, { branches: ['**'] });
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(Object.keys(workflow.jobs), ['validate']);
});

it('limits the token to read-only contents without secrets or privileged event contexts', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.validate.permissions, undefined);
  assert.equal(workflow.env, undefined);
  assert.equal(workflow.jobs.validate.env, undefined);
  assert.equal(workflow.jobs.validate.environment, undefined);
  assert.doesNotMatch(source, /secrets\.|pull_request_target|workflow_run|self-hosted|id-token/);
});

it('uses a bounded standard hosted job and separates push and PR concurrency groups', () => {
  const job = workflow.jobs.validate;
  assert.deepEqual(Object.keys(job).sort(), ['name', 'runs-on', 'steps', 'timeout-minutes']);
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 20);
  assert.deepEqual(workflow.concurrency, {
    group: '${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}',
    'cancel-in-progress': true,
  });
  assert.equal(job.strategy, undefined);
  assert.equal(job['continue-on-error'], undefined);
});

it('pins official actions and does not persist checkout credentials or enable caches', () => {
  const steps = workflow.jobs.validate.steps;
  assert.equal(steps[0]!.uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.deepEqual(steps[0]!.with, { 'persist-credentials': false });
  assert.equal(steps[1]!.uses, 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1');
  assert.deepEqual(steps[1]!.with, { 'node-version': '24', 'package-manager-cache': false });
  assert.equal(steps.filter((step: Record<string, unknown>) => step.uses).length, 2);
});

it('installs from the lockfile then runs all existing validation commands without masked failures', () => {
  const steps = workflow.jobs.validate.steps;
  assert.equal(steps.length, 6);
  for (const [index, step] of steps.entries()) {
    assert.deepEqual(Object.keys(step).sort(), index < 2 ? ['name', 'uses', 'with'] : ['name', 'run']);
  }
  assert.deepEqual(steps.slice(2).map((step: Record<string, unknown>) => step.run), [
    'npm ci --no-audit --no-fund', 'npm run typecheck', 'npm test', 'npm run build',
  ]);
  for (const step of steps) {
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step.env, undefined);
    assert.equal(step['working-directory'], undefined);
  }
  assert.doesNotMatch(source, /npm publish|deploy|werift-loopback|bench-mixer|load-test/);
});

it('matches the repository Node major, lockfile and existing aggregate scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  const client = JSON.parse(readFileSync(new URL('../packages/client/package.json', import.meta.url), 'utf8'));
  const web = JSON.parse(readFileSync(new URL('../web/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit -p tsconfig.json && npm run typecheck -w packages/client && npm run typecheck -w web');
  assert.equal(client.scripts.typecheck, 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json');
  assert.equal(web.scripts.typecheck, 'tsc --noEmit -p tsconfig.json');
  assert.ok(pkg.scripts.test.includes('npm run test -w packages/client'));
  assert.ok(pkg.scripts.build.includes('npm run build -w packages/client'));
  assert.ok(pkg.scripts.build.includes('npm run build -w web'));
});
