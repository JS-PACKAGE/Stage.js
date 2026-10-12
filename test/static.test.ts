import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, rename, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';
import { acceptedAssetEncodings } from '../src/http/encoding.ts';
import { createStaticHandler } from '../src/http/static.ts';
import { precompressDirectory } from '../scripts/precompress.ts';

describe('Accept-Encoding preference', () => {
  it('handles qvalues, exclusions, wildcards, case and identity fallback', () => {
    assert.deepEqual(acceptedAssetEncodings(undefined), ['identity']);
    assert.deepEqual(acceptedAssetEncodings(''), ['identity']);
    assert.deepEqual(acceptedAssetEncodings('gzip, br'), ['br', 'gzip', 'identity']);
    assert.deepEqual(acceptedAssetEncodings('BR;q=0.3, gzip;q=0.8'), ['gzip', 'br', 'identity']);
    assert.deepEqual(acceptedAssetEncodings('br;q=0, *;q=0.4'), ['gzip', 'identity']);
    assert.deepEqual(acceptedAssetEncodings('gzip;q=0.5, identity;q=1'), ['identity', 'gzip']);
    assert.deepEqual(acceptedAssetEncodings('br;q=0, gzip;q=0, identity;q=0'), []);
    assert.deepEqual(acceptedAssetEncodings('*;q=0'), []);
    assert.deepEqual(acceptedAssetEncodings('*;q=0, identity;q=0.5'), ['identity']);
    assert.deepEqual(acceptedAssetEncodings('br;q=bogus, gzip;q=2, zstd'), ['identity']);
    assert.deepEqual(acceptedAssetEncodings('br;q=1, br;q=0'), ['identity']);
  });
});

describe('precompressed static delivery', () => {
  let root: string;
  let port: number;
  const source = Buffer.from('console.log("Stage.js 測試音訊舞台");\n'.repeat(300));
  const br = brotliCompressSync(source);
  const gz = gzipSync(source);
  let server: ReturnType<typeof createServer>;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'stage-compressed-'));
    const pub = join(root, 'public');
    await mkdir(pub);
    await writeFile(join(pub, 'asset.js'), source);
    await writeFile(join(pub, 'asset.js.br'), br);
    await writeFile(join(pub, 'asset.js.gz'), gz);
    // Date rounds fractional milliseconds; compare the original stat precision, not Date values.
    for (const name of ['asset.js', 'asset.js.br', 'asset.js.gz']) await utimes(join(pub, name), 1740000000.00075, 1740000000.00075);
    await writeFile(join(pub, 'plain.js'), source);
    await writeFile(join(pub, 'image.png'), source);
    await writeFile(join(pub, 'image.png.br'), br);
    await writeFile(join(pub, 'stale.js'), source);
    await writeFile(join(pub, 'stale.js.br'), br);
    await utimes(join(pub, 'stale.js.br'), new Date(0), new Date(0));
    await writeFile(join(pub, 'linked.js'), source);
    await writeFile(join(root, 'secret.br'), br);
    await symlink(join(root, 'secret.br'), join(pub, 'linked.js.br'));
    await writeFile(join(root, 'outside.js'), 'synthetic outside-mount fixture');
    await symlink(join(root, 'outside.js'), join(pub, 'outside-link.js'));
    await mkdir(join(root, 'public-other'));
    await writeFile(join(root, 'public-other', 'other.js'), 'synthetic sibling fixture');
    await symlink(join(root, 'public-other'), join(pub, 'outside-dir'));
    await symlink(join(pub, 'asset.js'), join(root, 'public-other', 'back.js'));
    await writeFile(join(root, 'public-other', 'back.js.br'), 'synthetic external sidecar');
    await symlink(join(pub, 'asset.js'), join(pub, 'inside-link.js'));
    await symlink(pub, join(root, 'mounted-link'));
    await symlink(join(pub, 'cycle.js'), join(pub, 'cycle.js'));
    await symlink(join(root, 'missing-target.js'), join(pub, 'dangling.js'));
    const serve = createStaticHandler([{ mount: '/late/', dir: join(root, 'late-build'), cors: false }, { mount: '/linked-root/', dir: join(root, 'mounted-link'), cors: false }, { mount: '/', dir: pub, cors: true }], root);
    server = createServer((req, res) => { void serve(req, res).then(found => { if (!found) res.writeHead(404).end(); }).catch(() => res.writeHead(500).end()); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject); req.end();
    });
  }
  it('serves the preferred representation with original MIME and correct byte length', async () => {
    const response = await get('/asset.js', { 'accept-encoding': 'gzip, br' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'br');
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(response.headers['content-length'], String(br.length));
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(response.body, br);
    assert.deepEqual(brotliDecompressSync(response.body), source);
    const gzip = await get('/asset.js', { 'accept-encoding': 'br;q=0.1, gzip;q=0.8' });
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(gzip.body), source);
  });
  it('falls back for absent, stale or symlinked sidecars and honors identity preference', async () => {
    for (const path of ['/plain.js', '/stale.js', '/linked.js']) {
      const response = await get(path, { 'accept-encoding': 'br' });
      assert.equal(response.headers['content-encoding'], undefined, path);
      assert.deepEqual(response.body, source, path);
    }
    const identity = await get('/asset.js', { 'accept-encoding': 'br;q=0.5, identity;q=1' });
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.deepEqual(identity.body, source);
    assert.equal(identity.headers.vary, 'Accept-Encoding');
    assert.deepEqual((await get('/asset.js')).body, source);
  });
  it('returns 406 only when no available representation is acceptable', async () => {
    for (const [path, accept] of [['/asset.js', '*;q=0'], ['/plain.js', 'br, identity;q=0'], ['/asset.js', 'br;q=0, gzip;q=0, identity;q=0'], ['/image.png', 'br, identity;q=0']]) {
      const response = await get(path!, { 'accept-encoding': accept! });
      assert.equal(response.status, 406);
      assert.equal(response.body.length, 0);
      assert.equal(response.headers.vary, 'Accept-Encoding');
    }
    const response = await get('/asset.js', { 'accept-encoding': 'br;q=0, *;q=1, identity;q=0' });
    assert.equal(response.headers['content-encoding'], 'gzip');
  });
  it('uses encoding-specific validators and preserves headers on HEAD/304', async () => {
    const identity = await get('/asset.js');
    const zipped = await get('/asset.js', { 'accept-encoding': 'gzip' });
    assert.notEqual(identity.headers.etag, zipped.headers.etag);
    const wrong = await get('/asset.js', { 'accept-encoding': 'gzip', 'if-none-match': identity.headers.etag! });
    assert.equal(wrong.status, 200);
    for (const validator of [zipped.headers.etag!, `W/"other", ${zipped.headers.etag}`, '*', zipped.headers.etag!.slice(2)]) {
      const same = await get('/asset.js', { 'accept-encoding': 'gzip', 'if-none-match': validator });
      assert.equal(same.status, 304);
      assert.equal(same.headers.vary, 'Accept-Encoding');
      assert.equal(same.headers['content-encoding'], 'gzip');
      assert.equal(same.body.length, 0);
    }
    const dated = await get('/asset.js', { 'accept-encoding': 'gzip', 'if-modified-since': zipped.headers['last-modified']! });
    assert.equal(dated.status, 304);
    const precedence = await get('/asset.js', { 'accept-encoding': 'gzip', 'if-modified-since': zipped.headers['last-modified']!, 'if-none-match': 'W/"old"' });
    assert.equal(precedence.status, 200, 'If-None-Match takes precedence over a matching date');
    const head = await get('/asset.js', { 'accept-encoding': 'gzip' }, 'HEAD');
    assert.equal(head.headers.etag, zipped.headers.etag);
    assert.equal(head.headers['content-length'], String(gz.length));
    assert.equal(head.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(head.body.length, 0);
  });
  it('rejects source and directory symlinks escaping the canonical mount while allowing internal and configured-root links', async () => {
    for (const path of ['/outside-link.js', '/outside-dir/other.js', '/cycle.js', '/dangling.js']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await get(path, { 'accept-encoding': 'br, gzip' }, method);
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(response.body.length, 0);
      }
    }
    assert.deepEqual((await get('/inside-link.js')).body, source);
    const back = await get('/outside-dir/back.js', { 'accept-encoding': 'br' });
    assert.equal(back.headers['content-encoding'], undefined, 'a linked-back source must not authorize its outside sidecar');
    assert.deepEqual(back.body, source);
    assert.deepEqual((await get('/linked-root/asset.js')).body, source);
  });
  it('supports a mount built after startup and symlinked release-root replacement without stale canonical caching', async () => {
    assert.equal((await get('/late/ready.js')).status, 404);
    await mkdir(join(root, 'late-build'));
    await writeFile(join(root, 'late-build', 'ready.js'), 'late build');
    assert.equal((await get('/late/ready.js')).body.toString(), 'late build');
    const release = join(root, 'release-two');
    await mkdir(release);
    await writeFile(join(release, 'asset.js'), 'new release');
    await symlink(release, join(root, 'new-link'));
    await rename(join(root, 'new-link'), join(root, 'mounted-link'));
    try {
      assert.equal((await get('/linked-root/asset.js')).body.toString(), 'new release');
      assert.deepEqual((await get('/asset.js')).body, source, 'other mounts stay independent');
    } finally {
      await symlink(join(root, 'public'), join(root, 'restored-link'));
      await rename(join(root, 'restored-link'), join(root, 'mounted-link'));
    }
  });
  it('retains path-traversal protection and never recompresses encoded URLs', async () => {
    assert.equal((await get('/..%2fsecret.br', { 'accept-encoding': 'br' })).status, 404);
    const direct = await get('/asset.js.gz', { 'accept-encoding': 'br, gzip' });
    assert.equal(direct.headers['content-encoding'], undefined);
    assert.deepEqual(direct.body, gz);
  });
});

describe('precompression build step', () => {
  it('round-trips nested text assets, skips symlinks/binary/encoded files and removes larger sidecars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stage-precompress-'));
    try {
      await mkdir(join(root, 'assets'));
      const original = Buffer.from('const message = "Stage.js 音訊";\n'.repeat(100));
      await writeFile(join(root, 'assets', 'client.js'), original);
      await writeFile(join(root, 'untouched.txt'), 'do not overwrite');
      await symlink(join(root, 'untouched.txt'), join(root, 'assets', 'client.js.br'));
      await writeFile(join(root, 'small.css'), 'x');
      await writeFile(join(root, 'small.css.gz'), 'stale');
      await writeFile(join(root, 'image.png'), original);
      await symlink(join(root, 'assets', 'client.js'), join(root, 'linked.js'));
      const rows = await precompressDirectory(root);
      assert.equal(rows.length, 2);
      assert.equal(await readFile(join(root, 'untouched.txt'), 'utf8'), 'do not overwrite', 'atomic sidecar replacement must not follow an old symlink');
      assert.deepEqual(brotliDecompressSync(await readFile(join(root, 'assets', 'client.js.br'))), original);
      assert.deepEqual(gunzipSync(await readFile(join(root, 'assets', 'client.js.gz'))), original);
      for (const file of ['small.css.gz', 'small.css.br', 'image.png.br', 'linked.js.br', 'assets/client.js.gz.br']) {
        await assert.rejects(readFile(join(root, file)), { code: 'ENOENT' });
      }
      assert.equal((await precompressDirectory(root)).length, 2, 'repeat runs do not compress sidecars');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
