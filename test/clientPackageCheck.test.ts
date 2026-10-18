import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { checkClientPackage } from '../scripts/check-client-package.ts';

const rootModule = `
export class StageClient extends EventTarget {}
export class StageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const MAX_GAIN_DB = 20;
export const decodeName = value => value.replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&gt;/g, '>');
`;
const elementModule = `
export * from './stage-client.js';
export class StageElement extends HTMLElement {}
export function defineStageElement(name = 'stage-client') {
  if (!customElements.get(name)) customElements.define(name, name === 'stage-client' ? StageElement : class extends StageElement {});
}
defineStageElement();
`;

interface Fixture {
  root: string;
  packageDirectory: string;
  compilerPath: string;
  temporaryRoot: string;
  calls: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'stage-package-check-test-'));
  const fixture: Fixture = {
    root, packageDirectory: join(root, 'package with spaces'),
    compilerPath: join(root, 'compiler with spaces.mjs'), temporaryRoot: join(root, 'consumers'), calls: join(root, 'compiler-calls.txt'),
  };
  try {
    await mkdir(join(fixture.packageDirectory, 'dist', 'types'), { recursive: true });
    await mkdir(join(fixture.packageDirectory, 'src'));
    await mkdir(fixture.temporaryRoot);
    await writeFile(join(fixture.packageDirectory, 'src', 'must-not-copy.ts'), 'throw new Error("Source leaked");');
    await writeFile(join(fixture.packageDirectory, 'package.json'), JSON.stringify({
      name: '@stage-js/client', type: 'module', exports: {
        '.': { types: './dist/types/index.d.ts', import: './dist/stage-client.js' },
        './element': { types: './dist/types/element.d.ts', import: './dist/stage-element.js' },
      },
    }));
    await writeFile(join(fixture.packageDirectory, 'dist', 'stage-client.js'), rootModule);
    await writeFile(join(fixture.packageDirectory, 'dist', 'stage-element.js'), elementModule);
    await writeFile(join(fixture.packageDirectory, 'dist', 'types', 'index.d.ts'), 'export {};');
    await writeFile(join(fixture.packageDirectory, 'dist', 'types', 'element.d.ts'), 'export {};');
    // This compiler double checks orchestration; the build command tests real emitted declarations.
    await writeFile(fixture.compilerPath, `
import assert from 'node:assert/strict';
import { appendFileSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
assert.equal(process.argv[2], '--project');
assert.deepEqual(process.argv.slice(4), ['--pretty', 'false', '--listFiles']);
const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const mode = config.compilerOptions.moduleResolution;
assert.ok(['NodeNext', 'Bundler'].includes(mode));
assert.equal(config.compilerOptions.module, mode === 'NodeNext' ? 'NodeNext' : 'ESNext');
assert.equal(config.compilerOptions.strict, true);
assert.equal(config.compilerOptions.skipLibCheck, false);
assert.equal(config.compilerOptions.noEmit, true);
assert.deepEqual(config.compilerOptions.types, []);
assert.deepEqual(config.files, ['consumer.ts']);
assert.equal(process.env.NODE_PATH, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.deepEqual(readdirSync('node_modules/@stage-js/client').sort(), ['dist', 'package.json']);
assert.equal(lstatSync('node_modules/@stage-js/client').isSymbolicLink(), false);
assert.match(readFileSync('consumer.ts', 'utf8'), /@stage-js\\/client\\/element/);
assert.match(readFileSync('consumer.ts', 'utf8'), /@ts-expect-error/);
appendFileSync(${JSON.stringify(fixture.calls)}, mode + '\\n');
console.log(join(process.cwd(), 'consumer.ts'));
console.log(join(process.cwd(), 'node_modules/@stage-js/client/dist/types/index.d.ts'));
`);
    await run(fixture);
    assert.deepEqual(await readdir(fixture.temporaryRoot), [], 'Consumer workspace is removed on every exit');
    assert.equal(await readFile(join(fixture.packageDirectory, 'src', 'must-not-copy.ts'), 'utf8'), 'throw new Error("Source leaked");');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('checks a copied package and both compiler modes without depending on repository dist', async () => {
  await withFixture(async fixture => {
    await checkClientPackage(fixture);
    assert.equal(await readFile(fixture.calls, 'utf8'), 'NodeNext\nBundler\n');
  });
});

it('accepts a linked temporary directory while checking canonical consumer paths', async () => {
  await withFixture(async fixture => {
    const alias = join(fixture.root, 'linked consumers');
    await symlink(fixture.temporaryRoot, alias, 'junction');
    await checkClientPackage({ ...fixture, temporaryRoot: alias });
    assert.equal(await readFile(fixture.calls, 'utf8'), 'NodeNext\nBundler\n');
  });
});

it('the standalone CLI fails nonzero with build guidance before requiring artifacts or a compiler', async () => {
  await withFixture(async fixture => {
    const scripts = join(fixture.root, 'scripts');
    await mkdir(scripts);
    await writeFile(join(fixture.root, 'package.json'), '{"type":"module"}');
    await copyFile(new URL('../scripts/check-client-package.ts', import.meta.url), join(scripts, 'check-client-package.ts'));
    const result = spawnSync(process.execPath, [join(scripts, 'check-client-package.ts')], {
      cwd: fixture.temporaryRoot, encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /artifacts are missing or invalid\. Run npm run build/);
  });
});

it('reports missing and malformed artifacts with normal build guidance', async t => {
  const cases = [
    ['manifest', async (fixture: Fixture) => rm(join(fixture.packageDirectory, 'package.json'))],
    ['dist', async (fixture: Fixture) => rm(join(fixture.packageDirectory, 'dist'), { recursive: true })],
    ['runtime target', async (fixture: Fixture) => rm(join(fixture.packageDirectory, 'dist', 'stage-client.js'))],
    ['declaration target', async (fixture: Fixture) => rm(join(fixture.packageDirectory, 'dist', 'types', 'element.d.ts'))],
    ['invalid JSON', async (fixture: Fixture) => writeFile(join(fixture.packageDirectory, 'package.json'), '{')],
    ['invalid shape', async (fixture: Fixture) => writeFile(join(fixture.packageDirectory, 'package.json'), '[]')],
  ] as const;
  for (const [name, mutate] of cases) await t.test(name, async () => {
    await withFixture(async fixture => {
      await mutate(fixture);
      await assert.rejects(checkClientPackage(fixture), /artifacts are missing or invalid\. Run npm run build/);
      assert.deepEqual(await readdir(fixture.temporaryRoot), []);
    });
  });
});

it('rejects source export paths and linked artifacts rather than exposing checkout sources', async t => {
  for (const target of ['./src/must-not-copy.ts', './dist/../src/must-not-copy.ts']) await t.test(target, async () => {
    await withFixture(async fixture => {
      const path = join(fixture.packageDirectory, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.exports['.'].import = target;
      await writeFile(path, JSON.stringify(manifest));
      await assert.rejects(checkClientPackage(fixture), /target \.\/dist\/|escapes dist/);
    });
  });
  await t.test('dist directory link', async () => {
    await withFixture(async fixture => {
      await symlink(join(fixture.packageDirectory, 'src'), join(fixture.packageDirectory, 'dist', 'source-link'), 'junction');
      await assert.rejects(checkClientPackage(fixture), /Only regular files and directories/);
    });
  });
  await t.test('runtime absolute source import', async () => {
    await withFixture(async fixture => {
      const external = join(fixture.packageDirectory, 'src', 'otherwise-valid.mjs');
      await writeFile(external, rootModule);
      await writeFile(join(fixture.packageDirectory, 'dist', 'stage-client.js'), `export * from ${JSON.stringify(pathToFileURL(external).href)};`);
      await assert.rejects(checkClientPackage(fixture), /Runtime import resolved outside the copied package dist/);
    });
  });
  await t.test('compiler-reported declaration source escape', async () => {
    await withFixture(async fixture => {
      const compiler = await readFile(fixture.compilerPath, 'utf8');
      const external = join(fixture.packageDirectory, 'src', 'outside.d.ts');
      await writeFile(external, 'export {};');
      await writeFile(fixture.compilerPath, compiler + `\nconsole.log(${JSON.stringify(external)});`);
      await assert.rejects(checkClientPackage(fixture), /declarations \(NodeNext\) resolved outside the isolated consumer/);
    });
  });
});

it('propagates actual bare-import runtime failures and never calls the compiler afterwards', async t => {
  const cases = [
    ['missing export', rootModule.replace('export class StageError', 'class StageError'), elementModule, /Root export StageError/],
    ['network access', rootModule + '\nvoid fetch("data:text/plain,forbidden");', elementModule, /import-time browser\/network\/audio access: fetch/],
    ['DOM access', rootModule + '\nvoid HTMLElement;', elementModule, /import-time browser\/network\/audio access: HTMLElement/],
    ['missing registration', rootModule, elementModule.replace('defineStageElement();', ''), /automatically registers stage-client/],
    ['duplicate identity', rootModule, elementModule.replace("'./stage-client.js'", "'./duplicate.js'"), /Shared StageClient identity/],
  ] as const;
  for (const [name, root, element, reason] of cases) await t.test(name, async () => {
    await withFixture(async fixture => {
      await writeFile(join(fixture.packageDirectory, 'dist', 'stage-client.js'), root);
      await writeFile(join(fixture.packageDirectory, 'dist', 'stage-element.js'), element);
      await writeFile(join(fixture.packageDirectory, 'dist', 'duplicate.js'), rootModule);
      await assert.rejects(checkClientPackage(fixture), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Client package runtime failed/);
        assert.match(error.message, reason);
        return true;
      });
      await assert.rejects(readFile(fixture.calls), { code: 'ENOENT' });
    });
  });
});

it('rejects a runtime entry that exits successfully before completing its assertions', async () => {
  await withFixture(async fixture => {
    await writeFile(join(fixture.packageDirectory, 'dist', 'stage-client.js'), 'process.exit(0);');
    await assert.rejects(checkClientPackage(fixture), /runtime exited without completing all assertions/);
    await assert.rejects(readFile(fixture.calls), { code: 'ENOENT' });
  });
});

it('reports failures in either declaration mode and stops at the failed mode', async t => {
  for (const mode of ['NodeNext', 'Bundler']) await t.test(mode, async () => {
    await withFixture(async fixture => {
      const compiler = await readFile(fixture.compilerPath, 'utf8');
      await writeFile(fixture.compilerPath, compiler + `\nif (mode === '${mode}') { console.error('Synthetic declaration failure'); process.exitCode = 23; }`);
      await assert.rejects(checkClientPackage(fixture), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`declarations (${mode}) failed (exit 23`));
        assert.match(error.message, /Synthetic declaration failure/);
        return true;
      });
      assert.equal(await readFile(fixture.calls, 'utf8'), mode === 'NodeNext' ? 'NodeNext\n' : 'NodeNext\nBundler\n');
    });
  });
});

it('bounds stuck subprocesses and diagnostics while still removing the consumer', async t => {
  await t.test('runtime timeout', async () => {
    await withFixture(async fixture => {
      await writeFile(join(fixture.packageDirectory, 'dist', 'stage-client.js'), rootModule + '\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
      await assert.rejects(checkClientPackage({ ...fixture, timeoutMs: 200 }), /Client package runtime failed.*SIGKILL/);
    });
  });
  await t.test('compiler timeout', async () => {
    await withFixture(async fixture => {
      await writeFile(fixture.compilerPath, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
      await assert.rejects(checkClientPackage({ ...fixture, timeoutMs: 1000 }), /declarations \(NodeNext\) failed.*SIGKILL/);
    });
  });
  await t.test('large diagnostics', async () => {
    await withFixture(async fixture => {
      await writeFile(fixture.compilerPath, 'process.stderr.write("x".repeat(128 * 1024)); process.exitCode = 2;');
      await assert.rejects(checkClientPackage(fixture), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /declarations \(NodeNext\) failed/);
        assert.ok(error.message.length < 4_200);
        assert.match(error.message, /output truncated/);
        return true;
      });
    });
  });
});
