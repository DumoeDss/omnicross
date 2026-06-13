/**
 * child_process spawn adapter.
 *
 * Wraps Node.js child_process.spawn with platform-specific defaults:
 * - Windows: windowsHide=true, not detached
 * - Unix: detached=true for process group kill support
 *
 * @module child-adapter
 */

import { type ChildProcess, spawn as cpSpawn, type SpawnOptions } from 'node:child_process';

import { killProcessTree } from './kill-tree';
import type { SpawnChildInput } from './types';

const TAG = '[ProcessSupervisor]';
const IS_WIN = process.platform === 'win32';

export interface ChildAdapterHandle {
  pid: number | undefined;
  onStdout: (cb: (chunk: string) => void) => void;
  onStderr: (cb: (chunk: string) => void) => void;
  wait: () => Promise<{ code: number | null; signal: string | null }>;
  kill: (signal?: NodeJS.Signals) => void;
  stdin: ChildProcess['stdin'];
  dispose: () => void;
}

export function createChildAdapter(input: SpawnChildInput): ChildAdapterHandle {
  const [command, ...args] = input.argv;
  if (!command) {
    throw new Error(`${TAG} argv must have at least one element (the command)`);
  }

  const opts: SpawnOptions = {
    cwd: input.cwd,
    env: input.env ? { ...process.env, ...input.env } : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: IS_WIN,
    windowsVerbatimArguments: input.windowsVerbatimArguments,
    detached: !IS_WIN,
  };

  const child = cpSpawn(command, args, opts);

  // Handle stdin based on stdinMode
  const stdinMode = input.stdinMode ?? (input.input ? 'pipe-closed' : 'pipe-open');
  if (input.input && child.stdin) {
    child.stdin.write(input.input, () => {
      if (stdinMode === 'pipe-closed') {
        child.stdin?.end();
      }
    });
  } else if (stdinMode === 'pipe-closed' && child.stdin) {
    child.stdin.end();
  }

  let disposed = false;

  return {
    pid: child.pid,

    onStdout(cb: (chunk: string) => void): void {
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', cb);
    },

    onStderr(cb: (chunk: string) => void): void {
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', cb);
    },

    wait(): Promise<{ code: number | null; signal: string | null }> {
      return new Promise((resolve) => {
        // Handle spawn errors (e.g., ENOENT)
        child.on('error', (err) => {
          console.error(TAG, `spawn error for "${command}":`, err.message);
          resolve({ code: -1, signal: null });
        });

        child.on('close', (code, signal) => {
          resolve({ code, signal: signal ?? null });
        });
      });
    },

    kill(signal?: NodeJS.Signals): void {
      if (disposed || !child.pid) return;
      if (signal === 'SIGKILL') {
        killProcessTree(child.pid);
      } else {
        try {
          child.kill(signal ?? 'SIGTERM');
        } catch (err) {
          console.warn(TAG, `child.kill failed for pid=${child.pid}:`, err);
        }
      }
    },

    stdin: child.stdin,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    },
  };
}
