/**
 * adminMigration — the daemon admin API's encrypted migration-pack endpoints
 * (`POST /admin/api/export` + `POST /admin/api/import`, app-parity child 6,
 * design D2/D3).
 *
 * Thin HTTP adapters over `migration/migration.ts`:
 *  - `handleExport { passphrase }` → gather the FULL decrypted state, seal it
 *    under the passphrase-derived key, return ONLY `{ pack, version }` (the
 *    opaque passphrase-encrypted blob). NO plaintext secret leaves.
 *  - `handleImport { blob, passphrase, mode? }` → open + validate (deny-by-
 *    default) + apply (re-encrypt at-rest), return STATUS-ONLY counts.
 *
 * SECRET SPINE: the passphrase is IN-only (read from the body, used to derive the
 * key, dropped — never stored / echoed / logged). A weak/empty passphrase →
 * `400` with a clear, secret-free message. A wrong passphrase / tampered pack →
 * a clean `400` (GCM auth-tag failure) with NO partial write (atomic). No
 * decrypted secret reaches a response body or a log here (zero console/logger
 * calls touch secrets — this module logs nothing).
 *
 * @module @omnicross/daemon/admin/adminMigration
 */

import type { DaemonProviderConfig } from '../config';
import {
  applyImport,
  BUNDLE_VERSION,
  type ExportDeps,
  gatherExport,
  type ImportDeps,
  type ImportMode,
} from '../migration/migration';
import { WeakPassphraseError } from '../migration/packCodec';

/** The deps the migration handlers need (a subset of `AdminApiDeps`). */
export interface MigrationDeps extends ExportDeps, ImportDeps {
  /** The shared provider write gateway (reused from `adminApi.ts`, NOT duplicated). */
  parseProviderInput(
    body: Record<string, unknown>,
    existing: DaemonProviderConfig | undefined,
  ): DaemonProviderConfig | null;
}

/** The result of a handler — a status code + a JSON-able body. */
export interface MigrationHandlerResult {
  status: number;
  body: unknown;
}

function err(status: number, message: string): MigrationHandlerResult {
  return { status, body: { error: { type: 'admin_api_error', message } } };
}

/**
 * `export` — gather the full decrypted state + seal under the passphrase. Returns
 * ONLY `{ pack, version }` (the opaque pack). A weak/empty passphrase → 400.
 */
export async function handleExport(
  body: Record<string, unknown>,
  deps: MigrationDeps,
): Promise<MigrationHandlerResult> {
  const passphrase = typeof body['passphrase'] === 'string' ? body['passphrase'] : '';
  try {
    const pack = await gatherExport(deps, passphrase);
    return { status: 200, body: { pack, version: BUNDLE_VERSION } };
  } catch (error) {
    if (error instanceof WeakPassphraseError) {
      return err(400, error.message);
    }
    // Any other failure is reported WITHOUT any secret material.
    return err(500, 'failed to build the migration pack');
  }
}

/**
 * `import` — open + validate (deny-by-default) + apply (re-encrypt at-rest).
 * Returns STATUS-ONLY counts. A weak passphrase → 400; a wrong passphrase /
 * tampered / unreadable pack → 400 with NO partial write.
 */
export async function handleImport(
  body: Record<string, unknown>,
  deps: MigrationDeps,
): Promise<MigrationHandlerResult> {
  const blob = typeof body['blob'] === 'string' ? body['blob'] : '';
  const passphrase = typeof body['passphrase'] === 'string' ? body['passphrase'] : '';
  const mode: ImportMode = body['mode'] === 'overwrite' ? 'overwrite' : 'merge';
  if (!blob) return err(400, 'import requires { blob }');
  try {
    const counts = await applyImport(blob, passphrase, mode, deps, deps.parseProviderInput);
    return { status: 200, body: counts };
  } catch (error) {
    if (error instanceof WeakPassphraseError) {
      return err(400, error.message);
    }
    // A wrong passphrase / tampered / unreadable pack — a single secret-free
    // message; the GCM auth-tag failure left NO partial write (atomic).
    return err(400, error instanceof Error ? error.message : 'import failed');
  }
}
