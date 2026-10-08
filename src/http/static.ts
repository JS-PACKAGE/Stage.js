import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
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
    let size: number;
    try {
      const st = await stat(file);
      if (!st.isFile()) return false;
      size = st.size;
    } catch {
      return false;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', extname(file) === '.html' ? 'no-cache' : 'public, max-age=300');
    if (mount.cors) res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  };
}
