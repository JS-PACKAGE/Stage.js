import { extname } from 'node:path';

export type AssetEncoding = 'br' | 'gzip' | 'identity';
const TEXT_ASSETS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest']);
export function isCompressibleAsset(file: string): boolean { return TEXT_ASSETS.has(extname(file).toLowerCase()); }

/** RFC 9110 §12.5.3: explicit exclusions override wildcard, unlisted identity remains a fallback. */
export function acceptedAssetEncodings(header: string | undefined): AssetEncoding[] {
  if (!header?.trim()) return ['identity'];
  const quality = new Map<string, number>();
  for (const entry of header.split(',')) {
    const [token, ...params] = entry.trim().toLowerCase().split(';');
    if (!token) continue;
    let q = 1;
    if (params.length) {
      const match = params.length === 1 && /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(params[0]!);
      q = match ? Number(match[1]) : 0;
    }
    // Contradictory duplicate entries are treated conservatively, especially explicit q=0.
    quality.set(token.trim(), Math.min(quality.get(token.trim()) ?? 1, q));
  }
  const wildcard = quality.get('*');
  const q = (encoding: AssetEncoding): number => quality.get(encoding)
    ?? (encoding === 'identity' ? (wildcard === 0 ? 0 : Number.MIN_VALUE) : wildcard ?? 0);
  return (['br', 'gzip', 'identity'] as const).filter(encoding => q(encoding) > 0).sort((a, b) => q(b) - q(a));
}
