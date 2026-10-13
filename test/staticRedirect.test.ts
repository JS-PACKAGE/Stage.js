import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createStaticHandler } from '../src/http/static.ts';

describe('static mount trailing-slash redirects', () => {
  let root: string;
  let port: number;
  let origin: string;
  let server: ReturnType<typeof createServer>;
  const page = Buffer.from('<script type="module" src="./asset.js"></script>\n'.repeat(100));
  const gzip = gzipSync(page);
  const asset = 'export const mounted = true;\n';
  const unusual = [
    { mount: '/space name/', path: '/space%20name', location: './space%20name/' },
    { mount: '/prefix/demo/', path: '/prefix%2fdemo', location: './prefix%2fdemo/' },
    { mount: '/back\\slash/', path: '/back%5Cslash', location: './back%5Cslash/' },
    { mount: '/drive:part/', path: '/drive:part', location: './drive:part/' },
    { mount: '//elsewhere.invalid/', path: '/%2Felsewhere.invalid', location: './%2Felsewhere.invalid/' },
    { mount: '/double//tail/', path: '/double//tail', location: './tail/' },
    { mount: '/url/back/', path: '/url\\back', location: './back/' },
    { mount: '/encoded?mark/', path: '/encoded%3Fmark', location: './encoded%3Fmark/' },
    { mount: '/percent%name/', path: '/percent%25name', location: './percent%25name/' },
  ];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'stage-static-redirect-'));
    for (const dir of ['public', 'demo', 'nested', 'empty', 'index-directory/index.html', 'outside-index', 'demo/child', 'demo/missing']) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, 'public', 'index.html'), 'default root page');
    await writeFile(join(root, 'demo', 'index.html'), page);
    await writeFile(join(root, 'demo', 'index.html.gz'), gzip);
    for (const name of ['index.html', 'index.html.gz']) await utimes(join(root, 'demo', name), 1740000000, 1740000000);
    await writeFile(join(root, 'demo', 'asset.js'), asset);
    await writeFile(join(root, 'demo', 'child', 'index.html'), 'ordinary child directory');
    await writeFile(join(root, 'demo', 'missing', 'index.html'), 'must not fall back to this parent mount');
    await writeFile(join(root, 'nested', 'index.html'), 'longest mount page');
    await writeFile(join(root, 'outside.html'), 'synthetic outside-mount page');
    await symlink(join(root, 'outside.html'), join(root, 'outside-index', 'index.html'));
    const serve = createStaticHandler([
      { mount: '/', dir: 'public', cors: false },
      { mount: '/demo/', dir: 'demo', cors: true },
      { mount: '/plain/', dir: 'demo', cors: false },
      { mount: '/demo/nested/', dir: 'nested', cors: false },
      { mount: '/demo/missing/', dir: 'empty', cors: false },
      { mount: '/missing/', dir: 'empty', cors: false },
      { mount: '/absent/', dir: 'not-built', cors: false },
      { mount: '/directory/', dir: 'index-directory', cors: false },
      { mount: '/outside/', dir: 'outside-index', cors: false },
      ...unusual.map(({ mount }) => ({ mount, dir: 'demo', cors: false })),
    ], root);
    server = createServer((req, res) => {
      void serve(req, res).then(found => { if (!found) res.writeHead(404).end(); }).catch(() => res.writeHead(500).end());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    if (server) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers, method, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      const deadline = setTimeout(() => req.destroy(new Error(`Static fixture request timed out: ${method} ${path}`)), 5000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', reject);
      req.end();
    });
  }

  function redirectTarget(response: Awaited<ReturnType<typeof get>>, path: string): URL {
    assert.equal(response.status, 308, path);
    assert.equal(response.body.length, 0, path);
    assert.equal(response.headers['cache-control'], 'no-cache', path);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', path);
    const location = response.headers.location;
    assert.ok(location, path);
    assert.ok(location.startsWith('./'), path);
    const target = new URL(location, new URL(path, origin));
    assert.equal(target.origin, origin, path);
    return target;
  }

  it('redirects GET and HEAD to the encoded mount spelling with the complete query intact', async () => {
    const query = '?next=%2Fsomewhere%3Fx%3D1&plus=a+b&empty=&again=1&again=2';
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/demo', `/demo${query}`, `/%64emo${query}`]) {
        const response = await get(path, {}, method);
        const target = redirectTarget(response, path);
        const original = new URL(path, origin);
        assert.equal(response.headers.location, `.${original.pathname}/${original.search}`);
        assert.equal(target.pathname, `${original.pathname}/`);
        assert.equal(target.search, original.search);
        assert.equal(response.headers['access-control-allow-origin'], '*');
        assert.equal(response.headers['content-encoding'], undefined);
        assert.equal(response.headers.etag, undefined);
        assert.equal(response.headers['last-modified'], undefined);
      }
    }
    assert.equal((await get('/plain')).headers['access-control-allow-origin'], undefined);
  });

  it('makes a followed page resolve its relative asset inside the configured mount', async () => {
    const path = '/demo?source=relative-test';
    const outsideAsset = new URL('./asset.js', new URL(path, origin));
    assert.equal((await get(outsideAsset.pathname)).status, 404);
    const target = redirectTarget(await get(path), path);
    const canonical = await get(target.pathname + target.search);
    assert.equal(canonical.status, 200);
    assert.equal(canonical.headers.location, undefined);
    assert.deepEqual(canonical.body, page);
    const relativeAsset = new URL('./asset.js', target);
    assert.equal(relativeAsset.pathname, '/demo/asset.js');
    const response = await get(relativeAsset.pathname);
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), asset);
  });

  it('leaves the default root, canonical mount, files and ordinary subdirectories unchanged', async () => {
    for (const method of ['GET', 'HEAD']) {
      for (const [path, body] of [['/', 'default root page'], ['/index.html', 'default root page'], ['/demo/', page.toString()], ['/demo/index.html', page.toString()], ['/demo/child/', 'ordinary child directory']]) {
        const response = await get(path!, {}, method);
        assert.equal(response.status, 200, `${method} ${path}`);
        assert.equal(response.headers.location, undefined, path);
        assert.equal(response.body.toString(), method === 'HEAD' ? '' : body, path);
      }
      const child = await get('/demo/child', {}, method);
      assert.equal(child.status, 404);
      assert.equal(child.headers.location, undefined);
    }
  });

  it('does not redirect missing, non-file or outside-symlink indexes', async () => {
    for (const mount of ['/missing', '/absent', '/directory', '/outside', '/demo/missing']) {
      for (const method of ['GET', 'HEAD']) {
        for (const suffix of ['', '/']) {
          const path = `${mount}${suffix}?preserved=1`;
          const response = await get(path, {}, method);
          assert.equal(response.status, 404, `${method} ${path}`);
          assert.equal(response.headers.location, undefined, path);
          assert.equal(response.body.length, 0, path);
        }
      }
    }
  });

  it('uses the longest configured mount before redirecting and serving its index', async () => {
    const path = '/demo/nested?version=2';
    const response = await get(path);
    const target = redirectTarget(response, path);
    assert.equal(response.headers.location, './nested/?version=2');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(target.pathname, '/demo/nested/');
    const canonical = await get(target.pathname + target.search);
    assert.equal(canonical.status, 200);
    assert.equal(canonical.body.toString(), 'longest mount page');
    assert.equal(canonical.headers.location, undefined);
  });

  it('redirects conditional GET and HEAD before canonical cache validation', async () => {
    const canonical = await get('/demo/');
    const conditions: Record<string, string>[] = [
      { 'if-none-match': canonical.headers.etag! },
      { 'if-none-match': '*' },
      { 'if-modified-since': canonical.headers['last-modified']! },
    ];
    for (const method of ['GET', 'HEAD']) {
      for (const headers of conditions) {
        const response = await get('/demo', headers, method);
        const target = redirectTarget(response, '/demo');
        assert.equal(response.headers.etag, undefined);
        const unchanged = await get(target.pathname, headers, method);
        assert.equal(unchanged.status, 304);
        assert.equal(unchanged.body.length, 0);
        assert.equal(unchanged.headers.etag, canonical.headers.etag);
        assert.equal(unchanged.headers.location, undefined);
      }
    }
  });

  it('redirects before encoding negotiation, then retains canonical gzip and 406 behavior', async () => {
    const requests: Record<string, string>[] = [{ 'accept-encoding': 'gzip' }, { 'accept-encoding': '*;q=0', 'if-none-match': '*' }];
    for (const method of ['GET', 'HEAD']) {
      for (const headers of requests) {
        const response = await get('/demo?encoding=1', headers, method);
        const target = redirectTarget(response, '/demo?encoding=1');
        assert.equal(response.headers['content-encoding'], undefined);
        const canonical = await get(target.pathname + target.search, headers, method);
        assert.equal(canonical.headers.location, undefined);
        if (headers['accept-encoding'] === 'gzip') {
          assert.equal(canonical.status, 200);
          assert.equal(canonical.headers['content-encoding'], 'gzip');
          assert.equal(canonical.headers['content-length'], String(gzip.length));
          if (method === 'GET') assert.deepEqual(gunzipSync(canonical.body), page);
          else assert.equal(canonical.body.length, 0);
        } else {
          assert.equal(canonical.status, 406);
          assert.equal(canonical.body.length, 0);
          assert.equal(canonical.headers['cache-control'], 'no-store');
        }
      }
    }
  });

  it('keeps encoded delimiters, backslashes, colons and double-slash mounts on the same origin', async () => {
    const query = '?next=%2F%2Felsewhere.invalid&plus=a+b&empty=';
    for (const { path, location } of unusual) {
      const response = await get(path + query, { host: 'untrusted.invalid:1234' });
      const target = redirectTarget(response, path + query);
      assert.equal(response.headers.location, location + query, path);
      assert.equal(target.search, query, path);
      const canonical = await get(target.pathname + target.search);
      assert.equal(canonical.status, 200, path);
      assert.equal(canonical.headers.location, undefined, path);
      assert.deepEqual(canonical.body, page, path);
    }
  });

  it('keeps unsupported methods and malformed or traversal paths fail-closed', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await get('/demo', {}, method);
      assert.equal(response.status, 404, method);
      assert.equal(response.headers.location, undefined, method);
    }
    for (const path of ['/demo%00', '/demo%', '/demo/%2e%2e%2foutside.html']) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.location, undefined, path);
    }
  });
});
