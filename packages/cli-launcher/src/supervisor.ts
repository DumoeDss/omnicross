/**
 * ProcessSupervisor — subprocess lifecycle manager.
 *
 * Manages CLI tool subprocesses with dual timeouts (overall + no-output
 * watchdog), scope-based cancellation, and cross-platform process tree kill.
 *
 * @module supervisor
 */

import { randomUUID } from 'node:crypto';

import { serializeError } from '@omnicross/core/serializeError';

import type { ChildAdapterHandle } from './child-adapter';
import { createChildAdapter } from './child-adapter';
import type * as PtyAdapterModule from './pty-adapter';
import type { PtyAdapterHandle } from './pty-adapter';
import { createRunRegistry } from './run-registry';
import type {
  ManagedRun,
  ManagedRunStdin,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  RunRegistry,
  SpawnInput,
  TerminationReason,
} from './types';

const TAG = '[ProcessSupervisor]';

interface ActiveEntry {
  cancel: (reason?: TerminationReason) => void;
  adapter: ChildAdapterHandle | PtyAdapterHandle;
  scopeKey?: string;
}

export function createProcessSupervisor(): ProcessSupervisor {
  const registry: RunRegistry = createRunRegistry();
  const active = new Map<string, ActiveEntry>();

  // ------------------------------------------------------------------
  // spawn
  // ------------------------------------------------------------------
  function spawn(input: SpawnInput): ManagedRun {
    const runId = input.runId ?? randomUUID();
    const now = Date.now();
    const captureOutput = input.captureOutput ?? true;

    // Scope replacement: cancel all existing runs in this scope
    if (input.replaceExistingScope && input.scopeKey) {
      cancelScope(input.scopeKey, 'manual-cancel');
    }

    // Create initial registry record
    const record: RunRecord = {
      runId,
      sessionId: input.sessionId,
      backendId: input.backendId,
      scopeKey: input.scopeKey,
      startedAtMs: now,
      lastOutputAtMs: now,
      createdAtMs: now,
      updatedAtMs: now,
      state: 'starting',
    };
    registry.add(record);

    // Accumulators and control state
    let stdout = '';
    let stderr = '';
    let forcedReason: TerminationReason | null = null;
    let settled = false;

    // Timers (to be cleared on settle)
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    let noOutputTimer: ReturnType<typeof setTimeout> | null = null;

    // Create the adapter (child-process or PTY)
    let adapter: ChildAdapterHandle | PtyAdapterHandle;
    try {
      if (input.mode === 'pty') {
        const { createPtyAdapter } = require('./pty-adapter') as typeof PtyAdapterModule;
        adapter = createPtyAdapter(input);
      } else {
        adapter = createChildAdapter(input);
      }
    } catch (err) {
      // Spawn failed synchronously
      registry.finalize(runId, 'spawn-error', -1, null);
      const exit: RunExit = {
        reason: 'spawn-error',
        exitCode: -1,
        exitSignal: null,
        durationMs: 0,
        stdout: '',
        stderr: serializeError(err),
        timedOut: false,
        noOutputTimedOut: false,
      };
      return {
        runId,
        startedAtMs: now,
        wait: () => Promise.resolve(exit),
        cancel: () => {},
      };
    }

    // Update to running with pid
    registry.updateState(runId, 'running', { pid: adapter.pid });

    // ------------------------------------------------------------------
    // Cancellation helper
    // ------------------------------------------------------------------
    function cancelRun(reason?: TerminationReason): void {
      if (settled) return;
      forcedReason = reason ?? 'manual-cancel';
      registry.updateState(runId, 'exiting', { terminationReason: forcedReason });
      adapter.kill('SIGKILL');
    }

    // Register in active map
    active.set(runId, { cancel: cancelRun, adapter, scopeKey: input.scopeKey });

    // ------------------------------------------------------------------
    // Timers
    // ------------------------------------------------------------------
    function clearTimers(): void {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null; }
      if (noOutputTimer) { clearTimeout(noOutputTimer); noOutputTimer = null; }
    }

    if (input.timeoutMs && input.timeoutMs > 0) {
      overallTimer = setTimeout(() => {
        if (!settled) {
          console.warn(TAG, `overall timeout (${input.timeoutMs}ms) for run=${runId}`);
          cancelRun('overall-timeout');
        }
      }, input.timeoutMs);
      overallTimer.unref();
    }

    function resetNoOutputTimer(): void {
      if (noOutputTimer) clearTimeout(noOutputTimer);
      if (!input.noOutputTimeoutMs || input.noOutputTimeoutMs <= 0 || settled) return;
      noOutputTimer = setTimeout(() => {
        if (!settled) {
          console.warn(TAG, `no-output timeout (${input.noOutputTimeoutMs}ms) for run=${runId}`);
          cancelRun('no-output-timeout');
        }
      }, input.noOutputTimeoutMs);
      noOutputTimer.unref();
    }

    // Start the no-output watchdog
    resetNoOutputTimer();

    // ------------------------------------------------------------------
    // Wire stdout / stderr
    // ------------------------------------------------------------------
    adapter.onStdout((chunk: string) => {
      if (captureOutput) stdout += chunk;
      registry.touchOutput(runId);
      resetNoOutputTimer();
      input.onStdout?.(chunk);
    });

    adapter.onStderr((chunk: string) => {
      if (captureOutput) stderr += chunk;
      registry.touchOutput(runId);
      resetNoOutputTimer();
      input.onStderr?.(chunk);
    });

    // ------------------------------------------------------------------
    // Build stdin handle
    // ------------------------------------------------------------------
    let stdinHandle: ManagedRunStdin | undefined;
    if (adapter.stdin) {
      stdinHandle = {
        write(data: string): void { adapter.stdin?.write(data); },
        end(): void { adapter.stdin?.end(); },
        destroy(): void { adapter.stdin?.destroy(); },
      };
    }

    // ------------------------------------------------------------------
    // Wait promise
    // ------------------------------------------------------------------
    const waitPromise = adapter.wait().then(({ code, signal }): RunExit => {
      settled = true;
      clearTimers();

      const reason: TerminationReason = forcedReason
        ?? (code === -1 ? 'spawn-error' : signal ? 'signal' : 'exit');

      registry.finalize(runId, reason, code, signal);
      active.delete(runId);
      adapter.dispose();

      return {
        reason,
        exitCode: code,
        exitSignal: signal,
        durationMs: Date.now() - now,
        stdout,
        stderr,
        timedOut: reason === 'overall-timeout',
        noOutputTimedOut: reason === 'no-output-timeout',
      };
    });

    // Cache the promise so multiple wait() calls return the same result
    let cachedWait: Promise<RunExit> | null = null;

    return {
      runId,
      pid: adapter.pid,
      startedAtMs: now,
      stdin: stdinHandle,
      wait(): Promise<RunExit> {
        if (!cachedWait) cachedWait = waitPromise;
        return cachedWait;
      },
      cancel: cancelRun,
    };
  }

  // ------------------------------------------------------------------
  // cancel / cancelScope / getRecord
  // ------------------------------------------------------------------
  function cancel(runId: string, reason?: TerminationReason): void {
    const entry = active.get(runId);
    if (!entry) return;
    entry.cancel(reason);
  }

  function cancelScope(scopeKey: string, reason?: TerminationReason): void {
    for (const [runId, entry] of active) {
      if (entry.scopeKey === scopeKey) {
        entry.cancel(reason);
        console.warn(TAG, `cancelled run=${runId} in scope="${scopeKey}"`);
      }
    }
  }

  function getRecord(runId: string): RunRecord | undefined {
    return registry.get(runId);
  }

  /**
   * Resize the PTY terminal for a given run.
   * No-op if the run is not a PTY adapter or doesn't exist.
   */
  function resizePty(runId: string, cols: number, rows: number): boolean {
    const entry = active.get(runId);
    if (!entry) return false;
    if ('resize' in entry.adapter && typeof entry.adapter.resize === 'function') {
      entry.adapter.resize(cols, rows);
      return true;
    }
    return false;
  }

  return { spawn, cancel, cancelScope, getRecord, resizePty };
}
