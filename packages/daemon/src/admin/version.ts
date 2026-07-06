/**
 * version.ts — the single source of the daemon package version.
 *
 * `__DAEMON_VERSION__` is a tsup `define` (bake-time replacement across every
 * bundled entry); a src run (vitest / tsc) falls back to a dev sentinel. Kept in
 * its own module so BOTH the `AdminServer` (identity handshake header) and the
 * bootstrap health-report builder read ONE constant.
 *
 * @module @omnicross/daemon/admin/version
 */

/** Build-time injected package version (tsup `define`). */
declare const __DAEMON_VERSION__: string | undefined;

/** The daemon package version, or `0.0.0-dev` in a src run. */
export const DAEMON_VERSION: string =
  typeof __DAEMON_VERSION__ === 'string' ? __DAEMON_VERSION__ : '0.0.0-dev';
