import { createReadStream } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { acceptedAssetEncodings, isCompressibleAsset } from './encoding.ts';
import type { StaticMount } from '../config.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
};

function within(root: string, file: string): boolean {
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Serve built assets (web/dist, packages/client/dist). Only GET/HEAD, only
 * files inside the mount directory, `nosniff` everywhere; `cors` mounts allow
 * cross-origin ESM import of the client library by third-party sites.
 */
export function createStaticHandler(mounts: StaticMount[], baseDir: string) {
  const resolved = mounts
    .map((m) => ({ ...m, root: resolve(baseDir, m.dir) }))
    // Longest mount first so `/lib/` wins over `/`.
    .sort((a, b) => b.mount.length - a.mount.length);

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return false;
    }
    if (pathname.includes('\0')) return false;
    const mount = resolved.find((m) => pathname.startsWith(m.mount) || pathname === m.mount.slice(0, -1));
    if (!mount) return false;
    let rel = pathname.slice(mount.mount.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = resolve(mount.root, rel);
    if (!within(mount.root, file)) return false;
    let canonicalRoot: string, canonicalFile: string;
    let metadata: BigIntStats;
    try {
      [canonicalRoot, canonicalFile] = await Promise.all([realpath(mount.root), realpath(file)]);
      // Lexical containment alone follows asset/directory symlinks outside the public tree.
      // Resolve per request so release-root symlink swaps and later builds still work.
      if (!within(canonicalRoot, canonicalFile)) return false;
      const st = await stat(canonicalFile, { bigint: true });
      if (!st.isFile()) return false;
      metadata = st;
    } catch {
      return false;
    }
    const encodings = acceptedAssetEncodings(req.headers['accept-encoding']);
    let selected = canonicalFile;
    let encoding: string | undefined;
    for (const candidate of encodings) {
      if (candidate === 'identity') { encoding = 'identity'; break; }
      if (!isCompressibleAsset(file)) continue;
      const sidecar = `${file}.${candidate === 'gzip' ? 'gz' : 'br'}`;
      try {
        const compressed = await lstat(sidecar, { bigint: true });
        // Old sidecars from a partial rebuild must not hide a newer source; don't follow symlinks.
        if (!compressed.isFile() || compressed.mtimeNs < metadata.mtimeNs || compressed.size >= metadata.size) continue;
        const canonicalSidecar = await realpath(sidecar);
        if (!within(canonicalRoot, canonicalSidecar)) continue;
        selected = canonicalSidecar; encoding = candidate; metadata = compressed;
        break;
      } catch { /* No usable precompressed representation; try the next accepted encoding. */ }
    }
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (mount.cors) res.setHeader('Access-Control-Allow-Origin', '*');
    if (encoding === undefined) {
      res.statusCode = 406;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return true;
    }
    if (encoding !== 'identity') res.setHeader('Content-Encoding', encoding);
    // A weak metadata validator, not a content hash. File identity distinguishes release swaps
    // that preserve size/mtime; bigint fields retain filesystem precision without extra reads.
    const stamp = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs]
      .map(value => value.toString(16)).join('-');
    const etag = `W/"${encoding}-${stamp}"`;
    // Match ordinary Stats' millisecond rounding for the existing HTTP date contract.
    // BigIntStats.mtime truncates instead, which can change the second at a .9995 boundary.
    const modifiedMs = Number(metadata.mtimeNs / 1_000_000_000n) * 1000
      + Number(metadata.mtimeNs % 1_000_000_000n) / 1_000_000;
    const mtime = new Date(Math.round(modifiedMs));
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', mtime.toUTCString());
    res.setHeader('Cache-Control', extname(file) === '.html' ? 'no-cache' : 'public, max-age=300');
    const since = req.headers['if-modified-since'];
    const fresh = req.headers['if-none-match']?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.slice(2))
      || (req.headers['if-none-match'] === undefined && since !== undefined && Math.floor(mtime.getTime() / 1000) <= Math.floor(new Date(since).getTime() / 1000));
    if (fresh) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', metadata.size.toString());
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    // Missing/replaced assets or clients disconnecting during a stream must not crash the server.
    pipeline(createReadStream(selected), res, () => {});
    return true;
  };
}
