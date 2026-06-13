/**
 * migrationAdapter.ts — the daemon ⇄ Data Migration section adapter
 * (app-parity child 6).
 *
 * Drives the daemon's encrypted-pack endpoints:
 *  - `exportPack(passphrase)` → POST `/export` → returns ONLY the opaque pack
 *    (safe to display/copy — it is passphrase-encrypted ciphertext). The
 *    passphrase is sent IN the body and never round-trips back.
 *  - `importPack({ blob, passphrase, mode })` → POST `/import` → returns the
 *    STATUS-ONLY counts (provider/pool/token + duplicates/skipped). No secret is
 *    ever displayed; on a wrong passphrase the daemon's clean error is surfaced.
 *
 * SECRET SPINE: the passphrase is held only for the duration of the call (the
 * caller drops it). The adapter never logs the passphrase or the pack.
 */

import { adminClient } from './adminClient';
import type {
  AgentMigrationApi,
  ExportPackResponse,
  ExportPackResult,
  ImportPackRequest,
  ImportPackResponse,
  ImportPackResult,
} from './types-migration';

export function createMigrationAdapter(): AgentMigrationApi {
  return {
    async exportPack(passphrase: string): Promise<ExportPackResult> {
      try {
        const data = await adminClient.post<ExportPackResponse>('/export', { passphrase });
        return { success: true, pack: data.pack, version: data.version };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'export failed' };
      }
    },

    async importPack(input: ImportPackRequest): Promise<ImportPackResult> {
      try {
        const body: Record<string, unknown> = { blob: input.blob, passphrase: input.passphrase };
        if (input.mode) body['mode'] = input.mode;
        const counts = await adminClient.post<ImportPackResponse>('/import', body);
        return { success: true, counts };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'import failed' };
      }
    },
  };
}
