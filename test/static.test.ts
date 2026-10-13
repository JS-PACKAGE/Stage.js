import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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
    const serve = createStaticHandler([{ mount: '/late/', dir: join(root, 'late-build'), cors: false }, { mount: '/cache-release/', dir: join(root, 'cache-release-link'), cors: false }, { mount: '/linked-root/', dir: join(root, 'mounted-link'), cors: false }, { mount: '/', dir: pub, cors: true }], root);
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
  it('invalidates same-size preserved-mtime release validators for every selected representation', async () => {
    const releases = [join(root, 'cache-release-one'), join(root, 'cache-release-two')];
    const bodies = ['ONE', 'TWO'].map(version => Buffer.from(`export const version = "${version}";\n`.repeat(100)));
    const representations = bodies.map(body => ({ identity: body, gzip: gzipSync(body), br: brotliCompressSync(body) }));
    for (const [index, release] of releases.entries()) {
      await mkdir(release);
      for (const [encoding, bytes] of Object.entries(representations[index]!)) {
        const file = join(release, `asset.js${encoding === 'identity' ? '' : encoding === 'gzip' ? '.gz' : '.br'}`);
        await writeFile(file, bytes);
        await utimes(file, 1740000000, 1740000000);
      }
    }
    await symlink(releases[0]!, join(root, 'cache-release-link'));
    const before = new Map<string, Awaited<ReturnType<typeof get>>>();
    for (const encoding of ['identity', 'gzip', 'br'] as const) {
      assert.equal(representations[0]![encoding].length, representations[1]![encoding].length);
      const headers = { 'accept-encoding': encoding };
      const first = await get('/cache-release/asset.js', headers);
      before.set(encoding, first);
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, representations[0]![encoding]);
      for (const method of ['GET', 'HEAD']) {
        const unchanged = await get('/cache-release/asset.js', { ...headers, 'if-none-match': first.headers.etag! }, method);
        assert.equal(unchanged.status, 304, `${encoding}: unchanged ${method}`);
        assert.equal(unchanged.body.length, 0);
      }
    }
    assert.equal(new Set([...before.values()].map(response => response.headers.etag)).size, 3);
    await symlink(releases[1]!, join(root, 'cache-release-next'));
    await rename(join(root, 'cache-release-next'), join(root, 'cache-release-link'));
    for (const encoding of ['identity', 'gzip', 'br'] as const) {
      const first = before.get(encoding)!;
      const headers = { 'accept-encoding': encoding, 'if-none-match': first.headers.etag!, 'if-modified-since': first.headers['last-modified']! };
      for (const method of ['GET', 'HEAD']) {
        const changed = await get('/cache-release/asset.js', headers, method);
        assert.equal(changed.status, 200, `${encoding}: changed ${method} must not reuse the old entity despite a matching date`);
        assert.notEqual(changed.headers.etag, first.headers.etag);
        assert.equal(changed.headers['last-modified'], first.headers['last-modified']);
        assert.equal(changed.headers['content-encoding'], encoding === 'identity' ? undefined : encoding);
        assert.equal(changed.headers['content-length'], String(representations[1]![encoding].length));
        assert.equal(changed.headers.vary, 'Accept-Encoding');
        assert.deepEqual(changed.body, method === 'HEAD' ? Buffer.alloc(0) : representations[1]![encoding]);
        const unchanged = await get('/cache-release/asset.js', { 'accept-encoding': encoding, 'if-none-match': changed.headers.etag! }, method);
        assert.equal(unchanged.status, 304, `${encoding}: new ${method} validator revalidates`);
      }
      const dateOnly = await get('/cache-release/asset.js', { 'accept-encoding': encoding, 'if-modified-since': first.headers['last-modified']! });
      assert.equal(dateOnly.status, 304, 'date-only validation cannot detect a deployment that preserves mtime');
    }
  });
  it('invalidates in-place same-size rewrites with restored mtime when change metadata advances', async () => {
    const file = join(root, 'public', 'rewritten.js');
    const original = 'export const version = "ONE";\n';
    const replacement = 'export const version = "TWO";\n';
    await writeFile(file, original);
    await utimes(file, 1740000000, 1740000000);
    const first = await get('/rewritten.js');
    const initial = await stat(file, { bigint: true });
    let changed = initial;
    // Establish the filesystem precondition explicitly instead of assuming clock precision.
    for (let attempt = 0; attempt < 100; attempt++) {
      await writeFile(file, replacement);
      await utimes(file, 1740000000, 1740000000);
      changed = await stat(file, { bigint: true });
      if (changed.ctimeNs !== initial.ctimeNs) break;
      if (attempt < 99) await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    assert.equal(changed.ino, initial.ino);
    assert.equal(changed.dev, initial.dev);
    assert.equal(changed.size, initial.size);
    assert.equal(changed.mtimeNs, initial.mtimeNs);
    assert.notEqual(changed.ctimeNs, initial.ctimeNs, 'fixture requires an observed metadata change');
    const response = await get('/rewritten.js', { 'if-none-match': first.headers.etag!, 'if-modified-since': first.headers['last-modified']! });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), replacement);
    assert.notEqual(response.headers.etag, first.headers.etag);
    assert.equal((await get('/rewritten.js', { 'if-none-match': response.headers.etag! })).status, 304);
  });
  it('preserves Last-Modified rounding at a fractional-second boundary for every representation', async () => {
    for (const [extension, bytes] of [['', source], ['.gz', gz], ['.br', br]] as const) {
      const file = join(root, 'public', `rounded-date.js${extension}`);
      await writeFile(file, bytes);
      await utimes(file, 1740000000.99975, 1740000000.99975);
    }
    for (const [encoding, extension] of [['identity', ''], ['gzip', '.gz'], ['br', '.br']] as const) {
      const expected = (await stat(join(root, 'public', `rounded-date.js${extension}`))).mtime.toUTCString();
      const first = await get('/rounded-date.js', { 'accept-encoding': encoding });
      assert.equal(first.status, 200);
      assert.equal(first.headers['content-encoding'], encoding === 'identity' ? undefined : encoding);
      assert.equal(first.headers['last-modified'], expected, encoding);
      for (const method of ['GET', 'HEAD']) {
        const same = await get('/rounded-date.js', { 'accept-encoding': encoding, 'if-modified-since': expected }, method);
        assert.equal(same.status, 304, `${encoding}: ${method} with the previously emitted date`);
        assert.equal(same.headers['last-modified'], expected);
        assert.equal(same.body.length, 0);
      }
    }
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
