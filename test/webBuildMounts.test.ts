import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createStaticHandler } from '../src/http/static.ts';

function get(url: URL): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, headers: { 'accept-encoding': 'identity' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    const deadline = setTimeout(() => req.destroy(new Error(`Built web request timed out: ${url.href}`)), 5000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end();
  });
}

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/\b([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(match => [match[1]!.toLowerCase(), match[2] ?? match[3]!]));
}

function moduleSpecifiers(node: unknown, found = new Set<string>()): Set<string> {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) moduleSpecifiers(child, found);
    return found;
  }
  const record = node as Record<string, unknown>;
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(String(record.type))) {
    const source = record.source as { value?: unknown } | null | undefined;
    // The embed page's user-selected SDK host is a runtime expression, not a built chunk.
    if (typeof source?.value === 'string') found.add(source.value);
  }
  for (const child of Object.values(record)) moduleSpecifiers(child, found);
  return found;
}

describe('production web build at configured static mounts', () => {
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const files = new Map<string, Buffer>();
  const imports = new Map<string, Set<string>>();
  let outputDir: string | undefined;

  before(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'stage-web-build-mounts-'));
    // Keep the real production config, especially its base, while isolating all build output.
    await build({
      root: webRoot,
      configFile: join(webRoot, 'vite.config.ts'),
      configLoader: 'native',
      logLevel: 'silent',
      build: { outDir: outputDir, emptyOutDir: true },
      plugins: [{
        name: 'inspect-built-module-references',
        enforce: 'post',
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type === 'chunk') imports.set(output.fileName, moduleSpecifiers(this.parse(output.code)));
          }
        },
      }],
    });
    for (const name of await readdir(outputDir, { recursive: true })) {
      if (['.html', '.js', '.mjs', '.css'].includes(extname(name))) {
        files.set(name.split(sep).join('/'), await readFile(join(outputDir, name)));
      }
    }
    assert.ok(files.has('index.html'));
    assert.ok(files.has('embed.html'));
    assert.ok(imports.size > 0, 'the real build must emit JavaScript chunks');
  });

  after(async () => {
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  });

  for (const mount of ['/', '/demo/', '/nested/demo/']) {
    describe(`mounted only at ${mount}`, () => {
      let server: ReturnType<typeof createServer> | undefined;
      let origin: string;

      before(async () => {
        assert.ok(outputDir);
        // A root fallback would hide broken /assets URLs on either prefixed deployment.
        const serve = createStaticHandler([{ mount, dir: outputDir, cors: false }], outputDir);
        server = createServer((req, res) => {
          void serve(req, res).then(found => { if (!found) res.writeHead(404).end(); })
            .catch(() => res.writeHead(500).end());
        });
        const listener = server;
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(0, '127.0.0.1', resolve);
        });
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      });

      after(async () => {
        if (server) {
          const closed = new Promise<void>(resolve => server!.close(() => resolve()));
          server.closeAllConnections();
          await closed;
        }
      });

      async function verifyDocument(pageUrl: URL, fileName: string): Promise<void> {
        const page = await get(pageUrl);
        assert.equal(page.status, 200, pageUrl.href);
        assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
        assert.deepEqual(page.body, files.get(fileName), pageUrl.href);
        const html = page.body.toString();
        const baseTag = html.match(/<base\b[^>]*>/i)?.[0];
        const baseHref = baseTag ? attributes(baseTag).href : undefined;
        const documentBase = baseHref === undefined ? pageUrl : new URL(baseHref, pageUrl);
        const references: Array<{ url: URL; type: 'script' | 'modulepreload' | 'stylesheet' }> = [];
        for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
          const attr = attributes(match[0]);
          if (match[1]!.toLowerCase() === 'script' && attr.type === 'module') {
            assert.ok(attr.src, `${pageUrl.href}: emitted module entry must have a source`);
            references.push({ url: new URL(attr.src, documentBase), type: 'script' });
          } else if (attr.rel === 'modulepreload' || attr.rel === 'stylesheet') {
            assert.ok(attr.href, `${pageUrl.href}: emitted ${attr.rel} must have a URL`);
            references.push({ url: new URL(attr.href, documentBase), type: attr.rel });
          }
        }
        assert.ok(references.some(ref => ref.type === 'script'), `${pageUrl.href}: module entry missing`);
        assert.ok(references.some(ref => ref.type === 'stylesheet'), `${pageUrl.href}: stylesheet missing`);
        const visited = new Set<string>();

        async function verifyAsset(url: URL, expectedType: 'script' | 'modulepreload' | 'stylesheet'): Promise<void> {
          assert.equal(url.origin, origin, 'built assets must stay on their serving origin');
          if (visited.has(url.href)) return;
          visited.add(url.href);
          const response = await get(url);
          assert.equal(response.status, 200, `${pageUrl.pathname} references unreachable ${url.pathname}`);
          assert.ok(url.pathname.startsWith(mount), `${url.pathname} escaped ${mount}`);
          const name = decodeURIComponent(url.pathname.slice(mount.length));
          const bytes = files.get(name);
          assert.ok(bytes, `${url.pathname} must identify a real emitted file`);
          assert.equal(response.headers['content-type'], expectedType === 'stylesheet'
            ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', url.pathname);
          assert.equal(response.headers['x-content-type-options'], 'nosniff');
          assert.deepEqual(response.body, bytes, url.pathname);
          if (expectedType !== 'stylesheet') {
            assert.ok(imports.has(name), `${name} must be a parsed emitted chunk`);
            for (const specifier of imports.get(name)!) {
              assert.match(specifier, /^(?:\.{1,2}\/|\/)/, `${name}: unexpected bare or external module ${specifier}`);
              await verifyAsset(new URL(specifier, url), 'script');
            }
          }
        }

        for (const reference of references) await verifyAsset(reference.url, reference.type);
        if (mount !== '/') {
          for (const reference of references) {
            const rootAsset = new URL(reference.url.pathname.slice(mount.length), `${origin}/`);
            assert.equal((await get(rootAsset)).status, 404, 'root assets must not mask a broken prefixed build');
          }
        }
      }

      for (const page of ['', 'index.html', 'embed.html']) {
        it(`serves ${page || 'the main directory entry'} and its actual emitted asset graph`, async () => {
          await verifyDocument(new URL(`${mount}${page}?deployment=mount-test`, origin), page || 'index.html');
        });
      }

      if (mount !== '/') {
        it('preserves the full query through the canonical 308 and loads assets at the followed URL', async () => {
          const query = '?next=%2Froom%3Fx%3D1&plus=a+b&empty=&again=1&again=2';
          const initialUrl = new URL(`${mount.slice(0, -1)}${query}`, origin);
          const redirect = await get(initialUrl);
          assert.equal(redirect.status, 308);
          assert.equal(redirect.body.length, 0);
          assert.ok(redirect.headers.location);
          const canonicalUrl = new URL(redirect.headers.location, initialUrl);
          assert.equal(canonicalUrl.origin, origin);
          assert.equal(canonicalUrl.pathname, mount);
          assert.equal(canonicalUrl.search, query);
          await verifyDocument(canonicalUrl, 'index.html');
        });
      }
    });
  }
});
