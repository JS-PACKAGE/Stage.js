import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.ts';

const USAGE = 'Usage: node src/check-config.ts [path]\n       node dist/src/check-config.js [path]\nPath precedence: explicit path > STAGE_CONFIG > repository config.yaml\n';

function main(): number {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const positional = args[0] === '--' ? args.slice(1) : args;
  if (positional.length > 1 || (args[0] === '--' && positional.length !== 1)
    || positional[0] === '' || (args[0] !== '--' && positional[0]?.startsWith('-'))) {
    process.stderr.write(USAGE);
    return 2;
  }
  // Match the startup entry point in both source and built layouts, regardless of cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, basename(dirname(here)) === 'dist' ? '../..' : '..');
  const path = resolve(positional[0] ?? process.env.STAGE_CONFIG ?? resolve(root, 'config.yaml'));
  try {
    loadConfig(path);
    process.stdout.write('Configuration is valid.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`config error: ${error instanceof ConfigError ? error.message : 'unable to validate configuration'}\n`);
    return 1;
  }
}

process.exitCode = main();
