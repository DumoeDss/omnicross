/**
 * File-backed persistence for the core allowance store.
 *
 * The file is a bounded, replace-on-write snapshot beside the daemon config.
 * The core store has already removed provider headers/tokens; this adapter
 * validates the public DTO again before writing and accepts only a small,
 * versioned payload on load. Missing, empty, malformed, and oversized files are
 * treated as an empty cache so a damaged telemetry file never blocks startup.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { AccountAllowancePersistence } from '@omnicross/core/pipeline/AccountAllowanceStore';
import { normalizeAccountAllowanceSnapshot } from '@omnicross/core/pipeline/AccountAllowanceStore';
import type { AccountAllowanceSnapshot } from '@omnicross/contracts/account-allowance-types';

export const ACCOUNT_ALLOWANCE_CACHE_VERSION = 1;
export const MAX_PERSISTED_ALLOWANCE_SNAPSHOTS = 256;
export const MAX_ALLOWANCE_CACHE_BYTES = 1_000_000;

interface PersistedAllowanceFile {
  version: typeof ACCOUNT_ALLOWANCE_CACHE_VERSION;
  snapshots: AccountAllowanceSnapshot[];
}

export class JsonAccountAllowancePersistence implements AccountAllowancePersistence {
  constructor(private readonly cachePath: string) {}

  /** Read only the `snapshots` payload; all row validation remains defensive. */
  load(): unknown {
    if (!existsSync(this.cachePath)) return [];
    try {
      if (statSync(this.cachePath).size > MAX_ALLOWANCE_CACHE_BYTES) return [];
      const raw = readFileSync(this.cachePath, 'utf8');
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw) as unknown;
      // Accept the early array shape as a harmless migration path, but all new
      // writes use the versioned object shape below.
      if (Array.isArray(parsed)) return parsed;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      const file = parsed as Record<string, unknown>;
      return file.version === ACCOUNT_ALLOWANCE_CACHE_VERSION && Array.isArray(file.snapshots)
        ? file.snapshots
        : [];
    } catch {
      return [];
    }
  }

  /** Replace the file atomically; the target remains intact if replacement fails. */
  save(snapshots: readonly AccountAllowanceSnapshot[]): void {
    const rows: AccountAllowanceSnapshot[] = [];
    for (const snapshot of snapshots) {
      const normalized = normalizeAccountAllowanceSnapshot(snapshot);
      if (!normalized) continue;
      rows.push(normalized);
      if (rows.length >= MAX_PERSISTED_ALLOWANCE_SNAPSHOTS) break;
    }
    const file: PersistedAllowanceFile = {
      version: ACCOUNT_ALLOWANCE_CACHE_VERSION,
      snapshots: rows,
    };
    const serialized = JSON.stringify(file, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ALLOWANCE_CACHE_BYTES) {
      // The core store's field bounds make this unlikely, but fail closed rather
      // than allowing an unbounded cache write if those bounds change later.
      throw new Error('account allowance cache exceeds its size limit');
    }

    mkdirSync(dirname(this.cachePath), { recursive: true });
    const temporaryPath = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporaryPath, this.cachePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
