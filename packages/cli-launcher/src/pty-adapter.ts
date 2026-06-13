/**
 * PTY Adapter — wraps node-pty into the same handle shape
 * used by child-adapter, so ProcessSupervisor can manage
 * both child_process and PTY sessions uniformly.
 *
 * node-pty is lazily loaded — the import only happens when
 * a PTY spawn is actually requested.
 *
 * @module pty-adapter
 */

import type * as NodePty from 'node-pty';

import type { SpawnPtyInput } from './types';

// ── Public Handle ────────────────────────────────────────────

export interface PtyAdapterHandle {
  pid: number | undefined;
  onStdout(cb: (data: string) => void): void;
  onStderr(cb: (data: string) => void): void;
  stdin: {
    write(data: string): void;
    end(): void;
    destroy(): void;
  };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  wait(): Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: string): void;
  dispose(): void;
}

/**
 * Build the env object passed to node-pty.spawn.
 *
 * Inherits `process.env` as base so the PTY shell sees PATH/HOME/APPDATA
 * and any directories the host has injected at runtime — notably the bin
 * dirs of portable-installed Node/uv/git. Without this, PTY-mode CLI backends
 * (Claude Code, Codex, Gemini-CLI) silently fail to find host-managed tools
 * because the underlying shell only sees the system-level PATH from the
 * Windows registry / Unix dotfiles, not the augmented `process.env.PATH`.
 *
 * Mirrors the merge already performed in `child-adapter.ts:37`.
 *
 * Exported for direct unit testing — the adapter itself depends on the
 * native `node-pty` module which is awkward to mock from a unit test.
 */
export function buildPtyEnv(
  overlay: Record<string, string> | undefined,
): Record<string, string> {
  return overlay
    ? { ...(process.env as Record<string, string>), ...overlay }
    : { ...(process.env as Record<string, string>) };
}

// ── Factory ──────────────────────────────────────────────────

export function createPtyAdapter(input: SpawnPtyInput): PtyAdapterHandle {
  // Lazy-load node-pty so the module is only required when PTY mode is used.
   
  const nodePty = require('node-pty') as typeof NodePty;

  const shell =
    input.shell ??
    (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');

  const pty = nodePty.spawn(shell, input.args ?? [], {
    name: 'xterm-256color',
    cols: input.cols ?? 120,
    rows: input.rows ?? 30,
    cwd: input.cwd,
    env: buildPtyEnv(input.env),
  });

  // node-pty merges stdout/stderr into a single data stream.
  // We route everything through the onStdout callback.
  const stdoutListeners: Array<(data: string) => void> = [];
  const stderrListeners: Array<(data: string) => void> = [];

  const dataDisposable = pty.onData((data: string) => {
    for (const cb of stdoutListeners) cb(data);
    // PTY has no separate stderr — intentionally empty stderrListeners
  });

  // Exit promise
  let exitResolve: ((result: { code: number | null; signal: string | null }) => void) | null = null;
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    exitResolve = resolve;
  });

  const exitDisposable = pty.onExit(({ exitCode, signal }) => {
    exitResolve?.({ code: exitCode, signal: signal != null ? String(signal) : null });
  });

  let disposed = false;

  return {
    pid: pty.pid,

    onStdout(cb: (data: string) => void): void {
      stdoutListeners.push(cb);
    },

    onStderr(cb: (data: string) => void): void {
      stderrListeners.push(cb);
    },

    stdin: {
      write(data: string): void {
        if (!disposed) pty.write(data);
      },
      end(): void {
        // PTY doesn't have a distinct end — send EOF character
        if (!disposed) pty.write('\x04');
      },
      destroy(): void {
        // No-op for PTY; kill() handles teardown
      },
    },

    write(data: string): void {
      if (!disposed) pty.write(data);
    },

    resize(cols: number, rows: number): void {
      if (!disposed) pty.resize(cols, rows);
    },

    wait(): Promise<{ code: number | null; signal: string | null }> {
      return exitPromise;
    },

    kill(signal?: string): void {
      if (disposed) return;
      try {
        // node-pty's kill accepts a signal string on unix, ignored on Windows
        pty.kill(signal);
      } catch {
        // Already exited
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      dataDisposable.dispose();
      exitDisposable.dispose();
      try { pty.kill(); } catch { /* ignore */ }
    },
  };
}
