/**
 * httpFetch.ts — the single fetch seam for daemon calls.
 *
 * Inside Tauri (`isTauri()`), requests go through `@tauri-apps/plugin-http`'s
 * `fetch`, which uses the native (Rust) transport and so bypasses the webview's
 * CORS check — the daemon sends no CORS headers and must not (a token-free
 * loopback service with permissive CORS would be reachable by any website).
 *
 * In a plain browser (`npm run dev`), `isTauri()` is false and the platform
 * `fetch` is used against the CORS-enabled mock daemon. The plugin is imported
 * statically but only INVOKED under `isTauri()`, so the import stays inert in a
 * browser (the native call is never made).
 */

import { isTauri } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

// Tauri context is fixed for the page lifetime, so this resolves once.
const inTauri = isTauri();

/** Web-`fetch`-compatible seam: plugin-fetch inside Tauri, web-fetch otherwise. */
export const daemonFetch: typeof fetch = inTauri
  ? (input, init) => tauriFetch(input as URL | Request | string, init)
  : (input, init) => fetch(input, init);
