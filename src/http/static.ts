import { createReadStream } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
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
    if (file !== mount.root && !file.startsWith(mount.root + sep)) return false;
    let size: number, mtime: Date, modifiedMs: number;
    try {
      const st = await stat(file);
      if (!st.isFile()) return false;
      size = st.size;
      mtime = st.mtime;
      modifiedMs = st.mtimeMs;
    } catch {
      return false;
    }
    const encodings = acceptedAssetEncodings(req.headers['accept-encoding']);
    let selected = file;
    let encoding: string | undefined;
    for (const candidate of encodings) {
      if (candidate === 'identity') { encoding = 'identity'; break; }
      if (!isCompressibleAsset(file)) continue;
      const sidecar = `${file}.${candidate === 'gzip' ? 'gz' : 'br'}`;
      try {
        const compressed = await lstat(sidecar);
        // Old sidecars from a partial rebuild must not hide a newer source; don't follow symlinks.
        if (!compressed.isFile() || compressed.mtimeMs < modifiedMs || compressed.size >= size) continue;
        selected = sidecar; encoding = candidate; size = compressed.size; mtime = compressed.mtime; modifiedMs = compressed.mtimeMs;
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
    // Weak validator from size + mtime: enough for built assets, and the client library is fetched
    // by every embedding page, so revalidation must be a 304 rather than a full download.
    const etag = `W/"${encoding}-${size.toString(16)}-${modifiedMs.toString(16)}"`;
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
    res.setHeader('Content-Length', size);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    // Missing/replaced assets or clients disconnecting during a stream must not crash the server.
    pipeline(createReadStream(selected), res, () => {});
    return true;
  };
}
