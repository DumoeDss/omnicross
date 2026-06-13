/**
 * types-migration.ts — hand-mirrored daemon admin-API DTOs for the Data
 * Migration section (`POST /admin/api/export` + `POST /admin/api/import`,
 * app-parity child 6).
 *
 * SECRET SPINE: the export RESPONSE is the OPAQUE passphrase-encrypted pack only
 * (safe to display/copy — it is ciphertext). The import RESPONSE is STATUS-ONLY
 * counts — never a secret, never the blob. The passphrase is sent IN the request
 * body and never round-trips back.
 */

/** `POST /admin/api/export { passphrase }` response — the opaque pack only. */
export interface ExportPackResponse {
  /** The opaque, passphrase-encrypted pack string (`OMCXPACK1.<header>.<ct>`). */
  pack: string;
  /** The bundle format version (currently 1). */
  version: number;
}

/** Import merge mode: additive-skip (default) or overwrite colliding ids. */
export type ImportMode = 'merge' | 'overwrite';

/** `POST /admin/api/import` request body. */
export interface ImportPackRequest {
  /** The opaque pack string to restore. */
  blob: string;
  /** The passphrase used at export time. */
  passphrase: string;
  /** Merge mode (default `merge`). */
  mode?: ImportMode;
}

/**
 * `POST /admin/api/import` response — STATUS-ONLY counts (never a secret/blob).
 * The field names match the i18n summary placeholders exactly
 * (`providerKeys` / `poolKeys` / `tokenSets`, `duplicates`, `skipped`).
 */
export interface ImportPackResponse {
  /** Providers imported (each carries its BYO single key). */
  providerKeys: number;
  /** Total pool keys imported across those providers. */
  poolKeys: number;
  /** Subscription token sets (accounts) imported. */
  tokenSets: number;
  /** Pool keys skipped because the key id already existed. */
  duplicates: number;
  /** Provider ids skipped because they already existed (additive-merge default). */
  skipped: string[];
}

/** The Export adapter result — the opaque pack, or an honest failure. */
export interface ExportPackResult {
  success: boolean;
  /** The opaque pack (present on success). */
  pack?: string;
  version?: number;
  message?: string;
}

/** The Import adapter result — the status-only counts, or an honest failure. */
export interface ImportPackResult {
  success: boolean;
  /** The restore counts (present on success). */
  counts?: ImportPackResponse;
  message?: string;
}

/** The migration API the Data Migration section consumes. */
export interface AgentMigrationApi {
  exportPack(passphrase: string): Promise<ExportPackResult>;
  importPack(input: ImportPackRequest): Promise<ImportPackResult>;
}
