import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, gzip } from 'node:zlib';
import { isCompressibleAsset } from '../src/http/encoding.ts';

const brotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
export interface CompressionResult { file: string; originalBytes: number; brBytes: number; gzipBytes: number }

/** Only generated text assets; symlinks and existing encoded files are never followed/recompressed. */
export async function precompressDirectory(dir: string): Promise<CompressionResult[]> {
  const rows: CompressionResult[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...await precompressDirectory(file));
    else if (entry.isFile() && isCompressibleAsset(file)) {
      const input = await readFile(file);
      const [br, gz] = await Promise.all([brotli(input), compressGzip(input)]);
      for (const [extension, bytes] of [['br', br], ['gz', gz]] as const) {
        // Tiny or incompressible files must not grow just because the browser accepts compression.
        if (bytes.length < input.length) {
          const temporary = `${file}.${extension}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, bytes, { flag: 'wx' });
            await rename(temporary, `${file}.${extension}`);
          } finally { await rm(temporary, { force: true }); }
        }
        else await rm(`${file}.${extension}`, { force: true });
      }
      rows.push({ file, originalBytes: input.length, brBytes: Math.min(input.length, br.length), gzipBytes: Math.min(input.length, gz.length) });
    }
  }
  return rows;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/precompress.ts <built-directory> [...]');
  const rows: CompressionResult[] = [];
  for (const dir of process.argv.slice(2)) rows.push(...await precompressDirectory(dir));
  const total = rows.reduce((sum, row) => ({ originalBytes: sum.originalBytes + row.originalBytes, brBytes: sum.brBytes + row.brBytes, gzipBytes: sum.gzipBytes + row.gzipBytes }), { originalBytes: 0, brBytes: 0, gzipBytes: 0 });
  console.table(rows);
  console.log(JSON.stringify({ assets: rows.length, ...total }));
}
