import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = fileURLToPath(new URL('../packages/client/', import.meta.url));
const fixtures = new URL('./fixtures/client-package/', import.meta.url);
const outputLimit = 4_000;

export interface ClientPackageCheckOptions {
  packageDirectory?: string;
  compilerPath?: string;
  temporaryRoot?: string;
  timeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function artifactFile(path: string): Promise<void> {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular artifact file: ${path}`);
}

async function readManifest(directory: string): Promise<string> {
  try {
    const path = join(directory, 'package.json');
    await artifactFile(path);
    const text = await readFile(path, 'utf8');
    const manifest: unknown = JSON.parse(text);
    if (!record(manifest) || manifest.name !== '@stage-js/client' || manifest.type !== 'module' || !record(manifest.exports)) {
      throw new Error('Expected the @stage-js/client ESM package and its public exports');
    }
    for (const entry of ['.', './element']) {
      const conditions = manifest.exports[entry];
      if (!record(conditions)) throw new Error(`Missing export conditions for ${entry}`);
      for (const condition of ['import', 'types']) {
        const target = conditions[condition];
        if (typeof target !== 'string' || !target.startsWith('./dist/')) {
          throw new Error(`Expected ${entry}.${condition} to target ./dist/`);
        }
        const path = resolve(directory, target);
        const withinDist = relative(join(directory, 'dist'), path);
        if (isAbsolute(withinDist) || withinDist === '..' || withinDist.startsWith(`..${sep}`)) {
          throw new Error(`Export ${entry}.${condition} escapes dist`);
        }
        await artifactFile(path);
      }
    }
    return text;
  } catch (error) {
    throw new Error(`Client package artifacts are missing or invalid. Run npm run build from the repository root.\n${error instanceof Error ? error.message : String(error)}`);
  }
}

async function copyArtifacts(source: string, destination: string): Promise<void> {
  // Symlinks could expose checkout sources or dependencies to the external consumer.
  if (!(await lstat(source)).isDirectory()) throw new Error(`Expected a regular artifact directory: ${source}`);
  await mkdir(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyArtifacts(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Only regular files and directories are allowed in client dist: ${from}`);
  }
}

function runCheck(label: string, args: string[], cwd: string, timeoutMs: number): string {
  const env = { ...process.env };
  // The check must resolve its own copied artifacts, without ambient loaders or package paths.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = spawnSync(process.execPath, args, {
    cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal) {
    const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${label} failed (exit ${result.status ?? 'none'}, signal ${result.signal ?? 'none'}).\n${diagnostic.slice(0, outputLimit)}${diagnostic.length > outputLimit ? '\n[output truncated]' : ''}`);
  }
  return result.stdout;
}

function checkDeclarationFiles(output: string, consumer: string, compilerLibraries: string[], label: string): void {
  const files = output.split(/\r?\n/).filter(Boolean);
  const entry = join(consumer, 'consumer.ts');
  const dist = join(consumer, 'node_modules', '@stage-js', 'client', 'dist');
  if (!files.some(file => relative(entry, file) === '')) throw new Error(`${label} did not report the consumer in --listFiles output`);
  for (const file of files) {
    const fromDist = relative(dist, file);
    const declaration = /\.d\.(?:ts|mts|cts)$/.test(file) && !isAbsolute(fromDist) && fromDist !== '..' && !fromDist.startsWith(`..${sep}`);
    const standardLibrary = compilerLibraries.some(directory => relative(directory, dirname(file)) === '') && /^lib(?:\..+)?\.d\.ts$/.test(basename(file));
    if (!isAbsolute(file) || (relative(entry, file) !== '' && !declaration && !standardLibrary)) {
      throw new Error(`${label} resolved outside the isolated consumer and TypeScript standard libraries: ${file.slice(0, outputLimit)}`);
    }
  }
}

/** Validate the delivered package only; building or installing here would hide missing artifacts. */
export async function checkClientPackage(options: ClientPackageCheckOptions = {}): Promise<void> {
  const directory = resolve(options.packageDirectory ?? packageDirectory);
  const manifest = await readManifest(directory);
  const compilerManifest = createRequire(import.meta.url).resolve('typescript/package.json');
  const compilerDirectory = dirname(compilerManifest);
  const compilerLibraries = [await realpath(join(compilerDirectory, 'lib'))];
  try {
    // TypeScript 7 ships its standard libraries alongside its platform-specific native compiler.
    const nativeManifest = createRequire(compilerManifest).resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`);
    compilerLibraries.push(await realpath(join(dirname(nativeManifest), 'lib')));
  } catch { /* Older installed compilers keep their standard libraries in typescript/lib. */ }
  const compiler = options.compilerPath ?? join(compilerDirectory, 'bin', 'tsc');
  const temporary = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'stage-client-package-'));
  try {
    // Compilers canonicalize package paths; macOS temporary directories can have /var aliases.
    const consumer = await realpath(temporary);
    const installed = join(consumer, 'node_modules', '@stage-js', 'client');
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'package.json'), manifest);
    await copyArtifacts(join(directory, 'dist'), join(installed, 'dist'));
    await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    await copyFile(new URL('runtime.mjs', fixtures), join(consumer, 'runtime.mjs'));
    await copyFile(new URL('consumer.ts.txt', fixtures), join(consumer, 'consumer.ts'));
    const timeoutMs = options.timeoutMs ?? 30_000;
    const runtime = runCheck('Client package runtime', [join(consumer, 'runtime.mjs')], consumer, timeoutMs);
    if (runtime.trim() !== 'Client package runtime assertions completed.') {
      throw new Error('Client package runtime exited without completing all assertions');
    }
    for (const resolution of ['NodeNext', 'Bundler']) {
      const config = {
        compilerOptions: {
          target: 'ES2022', module: resolution === 'NodeNext' ? 'NodeNext' : 'ESNext', moduleResolution: resolution,
          strict: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true,
          skipLibCheck: false, noEmit: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [],
        },
        files: ['consumer.ts'],
      };
      await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify(config));
      const label = `Client package declarations (${resolution})`;
      const files = runCheck(label, [compiler, '--project', join(consumer, 'tsconfig.json'), '--pretty', 'false', '--listFiles'], consumer, timeoutMs);
      checkDeclarationFiles(files, consumer, compilerLibraries, label);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await checkClientPackage();
    console.log('Client package passed: isolated ESM exports, shared identities, controlled registration, NodeNext and Bundler declarations.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
