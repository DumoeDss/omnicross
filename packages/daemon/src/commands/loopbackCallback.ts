/**
 * commands/loopbackCallback.ts — the codex login one-shot loopback listener
 * (omnicross-daemon-parity-oauth D3).
 *
 * Codex's redirect_uri is `http://localhost:1455/auth/callback` (fixed by the
 * upstream — NOT changed here). `awaitLoopbackCode` binds a SINGLE-USE
 * `node:http` server on `127.0.0.1:1455`, waits for the browser to hit
 * `/auth/callback?code=…&state=…`, validates `state`, replies with a minimal
 * "you may close this window" HTML, and resolves the `code`. The listener:
 *   - rejects if port 1455 is already in use (clear error — never silent),
 *   - rejects on a `state` mismatch (and tells the browser it failed),
 *   - times out after a bounded window,
 *   - is always closed (success, error, or timeout) so the port is freed.
 *
 * Split out of `login.ts` for file-size discipline (design D6).
 *
 * @module @omnicross/daemon/commands/loopbackCallback
 */

import { createServer, type Server } from 'node:http';

/** The codex loopback host/port/path (mirrors the codex redirect_uri). */
const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
/** Bounded wait so a never-completed login can't hang the listener forever. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Minimal browser-facing HTML (no token material — just a close prompt). */
function pageHtml(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>omnicross login</title><body style="font-family:sans-serif;padding:2rem"><h2>${message}</h2><p>You can close this window and return to the terminal.</p></body>`;
}

/**
 * Listen ONCE on `127.0.0.1:1455` for the codex OAuth callback, validate the
 * returned `state` against `expectedState`, and resolve the authorization
 * `code`. Always closes the server before settling.
 */
export function awaitLoopbackCode(
  expectedState: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (server: Server, fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => fn());
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(pageHtml('Not found'));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(pageHtml('Login failed: missing authorization code.'));
        finish(server, () => reject(new Error('login: callback did not include an authorization code')));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(pageHtml('Login failed: state mismatch.'));
        finish(server, () => reject(new Error('login: callback state did not match (possible CSRF) — aborting')));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(pageHtml('Login complete.'));
      finish(server, () => resolve(code));
    });

    const abort = () => finish(server, () => reject(new Error('login: cancelled')));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `login: cannot bind ${LOOPBACK_HOST}:${LOOPBACK_PORT} (address in use) — another codex login or process is holding the port`,
          ),
        );
      } else {
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      finish(server, () => reject(new Error(`login: timed out after ${Math.round(timeoutMs / 1000)}s waiting for the callback`)));
    }, timeoutMs);
    // Don't let the timer keep the process alive on its own.
    if (typeof timer.unref === 'function') timer.unref();

    server.listen(LOOPBACK_PORT, LOOPBACK_HOST);
  });
}
