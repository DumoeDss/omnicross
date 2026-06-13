/**
 * Cross-platform process tree kill.
 *
 * Windows: taskkill /T (tree), graceful then forced.
 * Unix: negative-PID group signal, SIGTERM then SIGKILL.
 *
 * @module kill-tree
 */

import { spawn as cpSpawn } from 'node:child_process';

const TAG = '[ProcessSupervisor]';
const MIN_GRACE_MS = 0;
const MAX_GRACE_MS = 60_000;
const DEFAULT_GRACE_MS = 3_000;
const IS_WIN = process.platform === 'win32';

export interface KillTreeOptions {
  graceMs?: number;
}

/**
 * Check whether a process with the given PID is still alive.
 * Uses signal 0 which performs the check without actually sending a signal.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process and its entire subtree.
 *
 * Sends a graceful termination first, waits `graceMs`, then forces
 * if the process is still alive.
 */
export function killProcessTree(pid: number, opts?: KillTreeOptions): void {
  const graceMs = Math.max(MIN_GRACE_MS, Math.min(MAX_GRACE_MS, opts?.graceMs ?? DEFAULT_GRACE_MS));

  if (!isProcessAlive(pid)) return;

  if (IS_WIN) {
    killTreeWindows(pid, graceMs);
  } else {
    killTreeUnix(pid, graceMs);
  }
}

function killTreeWindows(pid: number, graceMs: number): void {
  // Graceful: taskkill /T /PID <pid>
  try {
    cpSpawn('taskkill', ['/T', '/PID', String(pid)], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
  } catch (err) {
    console.warn(TAG, `taskkill graceful failed for pid=${pid}:`, err);
  }

  // Forced after grace period
  const timer = setTimeout(() => {
    if (!isProcessAlive(pid)) return;
    try {
      cpSpawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
    } catch (err) {
      console.warn(TAG, `taskkill forced failed for pid=${pid}:`, err);
    }
  }, graceMs);
  timer.unref();
}

function killTreeUnix(pid: number, graceMs: number): void {
  // SIGTERM to process group (negative pid)
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.warn(TAG, `SIGTERM failed for pgid=${pid}:`, err);
    }
    return; // Process already gone
  }

  // SIGKILL after grace period
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.warn(TAG, `SIGKILL failed for pgid=${pid}:`, err);
      }
    }
  }, graceMs);
  timer.unref();
}
