/**
 * adminClient.ts — a tiny typed fetch wrapper over the daemon admin API
 * (`${base}/admin/api/*`) (design D5).
 *
 * The daemon mounts its management API under `/admin/api/*`, so this is a small
 * purpose-built client (the upstream UI's web client targets a different
 * `/api/v1` server contract and is not reused).
 *
 * Base URL: `VITE_DAEMON_BASE_URL` when set; otherwise same-origin relative
 * URLs in a browser (daemon-served `/ui`, or the Vite dev proxy) and the
 * loopback daemon inside Tauri. An optional `VITE_DAEMON_ADMIN_TOKEN` is sent
 * as `Authorization: Bearer`; when unset, no auth header is sent (works
 * against a token-free loopback daemon).
 *
 * The transport goes through `daemonFetch` (the dual-path seam): the Tauri HTTP
 * plugin inside Tauri (CORS-bypassing native fetch), the platform `fetch` in
 * browser-dev. The Bearer token is never logged on either path.
 */

import { isTauri } from '@tauri-apps/api/core';

import { daemonFetch } from './httpFetch';

const LOOPBACK_BASE_URL = 'http://127.0.0.1:8766';

function readEnv(key: string): string | undefined {
  // import.meta.env is the Vite-injected env bag.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.[key];
}

/**
 * Default base URL by host context:
 *  - Tauri shell → the loopback daemon (native fetch, no CORS check applies).
 *  - Anywhere else (Vite dev server OR the daemon-served `/ui` build) →
 *    same-origin relative URLs. The daemon sends no CORS headers by design, so
 *    a browser must never call it cross-origin: in production the daemon
 *    serves the UI itself; in dev the Vite proxy forwards `/admin/*` to it.
 */
function defaultBaseUrl(): string {
  if (isTauri()) return LOOPBACK_BASE_URL;
  return '';
}

export const DAEMON_BASE_URL = (readEnv('VITE_DAEMON_BASE_URL') || defaultBaseUrl()).replace(/\/+$/, '');
const ADMIN_TOKEN = readEnv('VITE_DAEMON_ADMIN_TOKEN') || '';

/** A typed error carrying the HTTP status + the daemon's `error.message`. */
export class AdminApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

type DaemonErrorBody = { error?: { type?: string; message?: string } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (ADMIN_TOKEN) headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;

  let res: Response;
  try {
    res = await daemonFetch(`${DAEMON_BASE_URL}/admin/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Network failure (daemon down / CSP / CORS) — surface a typed error at 0.
    throw new AdminApiError(0, err instanceof Error ? err.message : 'network error');
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = (json as DaemonErrorBody)?.error?.message || `request failed (${res.status})`;
    throw new AdminApiError(res.status, msg);
  }
  return json as T;
}

export const adminClient = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export type AdminClient = typeof adminClient;
