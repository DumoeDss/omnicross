/**
 * In-memory run registry for tracking subprocess lifecycle.
 *
 * Stores RunRecords in a Map, returns shallow copies from getters,
 * and auto-prunes oldest exited records beyond MAX_EXITED.
 *
 * @module run-registry
 */

import type { RunRecord, RunRegistry, RunState, TerminationReason } from './types';

const MAX_EXITED = 500;

export function createRunRegistry(): RunRegistry {
  const records = new Map<string, RunRecord>();

  function shallowCopy(r: RunRecord): RunRecord {
    return { ...r };
  }

  function pruneExited(): void {
    const exited: RunRecord[] = [];
    for (const r of records.values()) {
      if (r.state === 'exited') exited.push(r);
    }
    if (exited.length <= MAX_EXITED) return;

    // Sort oldest first by updatedAtMs
    exited.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    const toRemove = exited.length - MAX_EXITED;
    for (let i = 0; i < toRemove; i++) {
      records.delete(exited[i].runId);
    }
  }

  return {
    add(record: RunRecord): void {
      records.set(record.runId, { ...record });
    },

    get(runId: string): RunRecord | undefined {
      const r = records.get(runId);
      return r ? shallowCopy(r) : undefined;
    },

    list(): RunRecord[] {
      return Array.from(records.values()).map(shallowCopy);
    },

    listByScope(scopeKey: string): RunRecord[] {
      const result: RunRecord[] = [];
      for (const r of records.values()) {
        if (r.scopeKey === scopeKey) result.push(shallowCopy(r));
      }
      return result;
    },

    updateState(runId: string, state: RunState, patch?: Partial<RunRecord>): void {
      const r = records.get(runId);
      if (!r) return;
      r.state = state;
      r.updatedAtMs = Date.now();
      if (patch) {
        if (patch.pid !== undefined) r.pid = patch.pid;
        if (patch.terminationReason !== undefined) r.terminationReason = patch.terminationReason;
        if (patch.exitCode !== undefined) r.exitCode = patch.exitCode;
        if (patch.exitSignal !== undefined) r.exitSignal = patch.exitSignal;
      }
    },

    touchOutput(runId: string): void {
      const r = records.get(runId);
      if (!r) return;
      const now = Date.now();
      r.lastOutputAtMs = now;
      r.updatedAtMs = now;
    },

    finalize(
      runId: string,
      reason: TerminationReason,
      exitCode?: number | null,
      exitSignal?: string | null,
    ): void {
      const r = records.get(runId);
      if (!r) return;
      r.state = 'exited';
      // Preserve first-set termination reason
      if (!r.terminationReason) {
        r.terminationReason = reason;
      }
      if (exitCode !== undefined) r.exitCode = exitCode;
      if (exitSignal !== undefined) r.exitSignal = exitSignal;
      r.updatedAtMs = Date.now();
      pruneExited();
    },

    delete(runId: string): void {
      records.delete(runId);
    },
  };
}
