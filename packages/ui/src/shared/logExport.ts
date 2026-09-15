/**
 * logExport.ts — one-click daemon log export (bug reports).
 *
 * Fetches `GET /admin/api/logs/export` (the daemon bundles + redacts
 * `logs/daemon.log*` itself), then saves it: inside the Tauri desktop shell
 * via the native save dialog (`save_log_export` command — the webview cannot
 * offer a reliable download UX there), and via a blob anchor download in a
 * plain browser.
 */

import { invoke } from '@tauri-apps/api/core';

import { adminClient } from '@/daemon/adminClient';
import { isDesktop } from '@/shared/tauri/uiSettings';

export interface LogExportResult {
  ok: boolean;
  /** Where the bundle landed (native save path in the desktop shell). */
  savedPath?: string;
  /** Failure / status detail (`'cancelled'` when the save dialog was dismissed). */
  message?: string;
}

export async function exportDaemonLogs(): Promise<LogExportResult> {
  let text: string;
  let filename: string | null;
  try {
    ({ text, filename } = await adminClient.getRaw('/logs/export'));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'failed to export logs' };
  }
  const name = filename ?? `omnicross-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;

  if (isDesktop()) {
    try {
      const saved = await invoke<string | null>('save_log_export', {
        filename: name,
        contents: text,
      });
      return saved === null || saved === undefined
        ? { ok: false, message: 'cancelled' }
        : { ok: true, savedPath: saved };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'failed to save the export' };
    }
  }

  // Browser: anchor download via a blob URL (revoke after the click settles).
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
  return { ok: true, savedPath: name };
}
