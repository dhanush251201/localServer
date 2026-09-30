import { createReadStream, statSync, type Stats } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

function tryStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** Resolve a URL path inside root, refusing anything that escapes it. */
function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = resolve(join(root, decoded));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string,
  urlPath: string,
  spaFallback: boolean,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const root = resolve(distDir);
  if (!tryStat(root)?.isDirectory()) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`localserver: static folder not found: ${root}\nBuild the frontend first.`);
    return;
  }

  const pathname = urlPath.split('?')[0];
  let file = safeJoin(root, pathname);
  if (!file) {
    res.writeHead(400).end();
    return;
  }
  let st = tryStat(file);
  if (st?.isDirectory()) {
    file = join(file, 'index.html');
    st = tryStat(file);
  }
  // SPA: unknown paths without a file extension render index.html so client-side routing works.
  if (!st?.isFile() && spaFallback && !extname(pathname)) {
    file = join(root, 'index.html');
    st = tryStat(file);
  }
  if (!st?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const ext = extname(file).toLowerCase();
  // Vite puts content-hashed files in /assets; everything else (index.html especially) must revalidate.
  const hashed = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(file) && file.includes(`${sep}assets${sep}`);
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': st.size,
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] as string }).end();
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
