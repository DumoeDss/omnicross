/**
 * ui-static.test.ts — the `/ui` Control Panel static handler (design A:
 * same-origin UI serving from the @omnicross/ui dist).
 *
 * Runs `handleUiStatic` behind a real ephemeral node:http listener with a temp
 * dist dir. Covers: the `/ui` → `/ui/` redirect, index.html + asset serving with
 * correct content types, the SPA extension-less fallback, asset 404s, the
 * traversal guard (`..`, backslash), the not-installed hint, non-/ui pass-through,
 * and `resolveUiDist`'s OMNICROSS_UI_DIST env override. Also covers `runUi`'s
 * seams: forwards argv minus `--no-open`, opens `<dashboard>/ui/`, and skips
 * the browser open under `--no-open` / a disabled dashboard.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { handleUiStatic, resolveUiDist } from '../admin/uiStatic';
import { runUi } from '../commands/ui';

let distDir: string;
let server: Server;
let base: string;
/** When null, the handler should answer with the not-installed 404. */
let uiDistForRequests: string | null;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'omnix-ui-'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>panel</title>');
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("ui")');
  writeFileSync(join(distDir, 'assets', 'app.css'), 'body{}');
  uiDistForRequests = distDir;

  server = createServer((req, res) => {
    void handleUiStatic(req, res, (req.url ?? '/').split('?')[0], uiDistForRequests).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'not_found', message: 'fell through' } }));
        }
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(distDir, { recursive: true, force: true });
});

afterEach(() => {
  uiDistForRequests = distDir;
  delete process.env['OMNICROSS_UI_DIST'];
});

describe('handleUiStatic', () => {
  it('redirects /ui to /ui/ (relative-asset base needs the trailing slash)', async () => {
    const res = await fetch(`${base}/ui`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ui/');
  });

  it('serves index.html at /ui/ with the html content type', async () => {
    const res = await fetch(`${base}/ui/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('panel');
  });

  it('serves assets with their content types', async () => {
    const js = await fetch(`${base}/ui/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    const css = await fetch(`${base}/ui/assets/app.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('falls back to index.html for extension-less SPA paths only', async () => {
    const spa = await fetch(`${base}/ui/providers`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('panel');
    const missingAsset = await fetch(`${base}/ui/assets/nope.js`);
    expect(missingAsset.status).toBe(404);
  });

  it('blocks path traversal', async () => {
    // fetch normalizes `..` in the URL, so exercise the handler's own guard
    // with an encoded traversal (decoded server-side after path splitting).
    const encoded = await fetch(`${base}/ui/assets/%2e%2e/%2e%2e/secret.txt`);
    expect([400, 403, 404]).toContain(encoded.status);
    expect(encoded.status).not.toBe(200);
    const backslash = await fetch(`${base}/ui/assets/%5c..%5csecret.txt`);
    expect([400, 403, 404]).toContain(backslash.status);
  });

  it('answers 404 + install hint when no UI dist is installed', async () => {
    uiDistForRequests = null;
    const res = await fetch(`${base}/ui/`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('ui_not_installed');
    expect(body.error.message).toContain('@omnicross/ui');
  });

  it('ignores non-/ui paths (returns false → caller 404s)', async () => {
    const res = await fetch(`${base}/uiX`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('fell through');
  });

  it('rejects non-GET methods under /ui', async () => {
    const res = await fetch(`${base}/ui/`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('resolveUiDist', () => {
  it('honors OMNICROSS_UI_DIST when it holds an index.html', () => {
    process.env['OMNICROSS_UI_DIST'] = distDir;
    expect(resolveUiDist()).toBe(distDir);
  });

  it('returns null for an env dir without index.html', () => {
    const empty = mkdtempSync(join(tmpdir(), 'omnix-ui-empty-'));
    try {
      process.env['OMNICROSS_UI_DIST'] = empty;
      expect(resolveUiDist()).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('runUi', () => {
  it('starts the daemon (argv minus --no-open) and opens <dashboard>/ui/', async () => {
    const calls: { startArgv?: string[]; opened?: string } = {};
    await runUi(['--config', 'x.json', '--no-open'], {
      start: async (argv) => {
        calls.startArgv = argv;
        return { dashboardUrl: 'http://127.0.0.1:8766' };
      },
      openBrowser: async (url) => {
        calls.opened = url;
        return true;
      },
    });
    expect(calls.startArgv).toEqual(['--config', 'x.json']);
    expect(calls.opened).toBeUndefined(); // --no-open

    await runUi(['--config', 'x.json'], {
      start: async () => ({ dashboardUrl: 'http://127.0.0.1:8766' }),
      openBrowser: async (url) => {
        calls.opened = url;
        return true;
      },
    });
    expect(calls.opened).toBe('http://127.0.0.1:8766/ui/');
  });

  it('skips the browser when the dashboard is disabled', async () => {
    let opened = false;
    await runUi([], {
      start: async () => ({ dashboardUrl: null }),
      openBrowser: async () => {
        opened = true;
        return true;
      },
    });
    expect(opened).toBe(false);
  });
});
