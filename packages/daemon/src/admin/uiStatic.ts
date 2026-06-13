/**
 * uiStatic.ts — static serving of the Control Panel web UI at `/ui` (design A:
 * same-origin UI, zero CORS).
 *
 * The built frontend ships as the `@omnicross/ui` package (pure static assets in
 * its `dist/`). Resolution order:
 *   1. `OMNICROSS_UI_DIST` env var (dev: point at the repo's `app/dist`),
 *   2. `require.resolve('@omnicross/ui/package.json')` → `<pkg>/dist`.
 * When neither resolves, `/ui` answers 404 with an install hint — the daemon
 * never fails to boot over a missing UI.
 *
 * Security: paths are decoded, backslash-rejected, and resolved against the
 * dist root with a prefix check (no traversal). Only GET/HEAD are served. The
 * admin token gate (when configured) runs in AdminServer BEFORE this handler.
 *
 * @module @omnicross/daemon/admin/uiStatic
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve the UI dist directory, or null when no UI is installed. */
export function resolveUiDist(): string | null {
  const fromEnv = process.env['OMNICROSS_UI_DIST'];
  if (fromEnv) {
    return existsSync(path.join(fromEnv, 'index.html')) ? path.resolve(fromEnv) : null;
  }
  try {
    // Works from both build formats: __filename in CJS, import.meta.url in ESM.
    const req = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);
    const pkgJson = req.resolve('@omnicross/ui/package.json');
    const dist = path.join(path.dirname(pkgJson), 'dist');
    return existsSync(path.join(dist, 'index.html')) ? dist : null;
  } catch {
    return null;
  }
}

/**
 * Serve `GET|HEAD /ui[/...]` from the UI dist. Returns `true` when the request
 * was handled (incl. 404s under /ui), `false` when the path is not a /ui route.
 */
export async function handleUiStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  uiDist: string | null,
): Promise<boolean> {
  if (urlPath !== '/ui' && !urlPath.startsWith('/ui/')) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'method_not_allowed', message: 'GET/HEAD only' } }));
    return true;
  }

  if (!uiDist) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'ui_not_installed',
          message:
            'Control Panel UI not installed (@omnicross/ui has no built dist). ' +
            'Install/build @omnicross/ui or set OMNICROSS_UI_DIST.',
        },
      }),
    );
    return true;
  }

  // The build uses relative asset paths (`base: './'`), so index.html must be
  // served under `/ui/` (trailing slash) for `./assets/*` to resolve.
  if (urlPath === '/ui') {
    res.writeHead(302, { Location: '/ui/' });
    res.end();
    return true;
  }

  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.slice('/ui/'.length));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'bad_request', message: 'malformed path' } }));
    return true;
  }

  // Traversal guard: no backslashes, and the resolved path must stay in dist.
  if (rel.includes('\\') || rel.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'bad_request', message: 'invalid path' } }));
    return true;
  }
  const filePath = path.resolve(uiDist, rel === '' ? 'index.html' : rel);
  if (filePath !== uiDist && !filePath.startsWith(uiDist + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'forbidden', message: 'path outside ui root' } }));
    return true;
  }

  // SPA fallback: unknown extension-less paths get index.html (client routing).
  let target = filePath;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    if (path.extname(rel) === '') {
      target = path.join(uiDist, 'index.html');
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: 'no such ui asset' } }));
      return true;
    }
  }

  const body = await readFile(target);
  const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
