import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const delivery = realpathSync(process.env.STAGE_PACKAGE_DELIVERY);
const dependencies = realpathSync(process.env.STAGE_PACKAGE_DEPENDENCIES);
function within(root, path) {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
// This checks ordinary module resolution, not arbitrary filesystem access or hostile code.
// Canonical paths exclude workspace links back into the checkout. --import also runs in workers.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith('node:')) return result;
    if (!result.url.startsWith('file:')) throw new Error(`Server package module is not a delivered file: ${result.url}`);
    const path = realpathSync(fileURLToPath(result.url));
    if ((!within(delivery, path) && !within(dependencies, path)) || (within(delivery, path) && /\.(?:ts|mts|cts)$/.test(path))) {
      throw new Error(`Server package module escaped delivered JavaScript and installed dependencies: ${path}`);
    }
    return result;
  },
});
