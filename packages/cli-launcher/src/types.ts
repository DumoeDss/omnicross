/**
 * Process Supervisor types.
 *
 * Defines all interfaces for subprocess lifecycle management:
 * spawn inputs, run records, exit results, and module contracts.
 *
 * @module types
 */

// ============================================================
// Enums / Unions
// ============================================================

export type RunState = 'starting' | 'running' | 'exiting' | 'exited';

export type TerminationReason =
  | 'manual-cancel'
  | 'overall-timeout'
  | 'no-output-timeout'
  | 'spawn-error'
  | 'signal'
  | 'exit';

// ============================================================
// Spawn Input
// ============================================================

export interface SpawnBaseInput {
  runId?: string;
  sessionId: string;
  backendId: string;
  scopeKey?: string;
  replaceExistingScope?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  captureOutput?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnChildInput extends SpawnBaseInput {
  mode: 'child';
  argv: string[];
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: 'inherit' | 'pipe-open' | 'pipe-closed';
}

export interface SpawnPtyInput extends SpawnBaseInput {
  mode: 'pty';
  /** Shell executable (defaults: powershell.exe on Windows, /bin/bash on Unix). */
  shell?: string;
  /** Arguments passed to the shell. */
  args?: string[];
  /** Terminal columns (default: 120). */
  cols?: number;
  /** Terminal rows (default: 30). */
  rows?: number;
}

/** Spawn input union — child-process or PTY mode. */
export type SpawnInput = SpawnChildInput | SpawnPtyInput;

// ============================================================
// Run Record (registry state)
// ============================================================

export interface RunRecord {
  runId: string;
  sessionId: string;
  backendId: string;
  scopeKey?: string;
  pid?: number;
  startedAtMs: number;
  lastOutputAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  state: RunState;
  terminationReason?: TerminationReason;
  exitCode?: number | null;
  exitSignal?: string | null;
}

// ============================================================
// Run Exit Result
// ============================================================

export interface RunExit {
  reason: TerminationReason;
  exitCode: number | null;
  exitSignal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
}

// ============================================================
// Managed Run (returned from spawn)
// ============================================================

export interface ManagedRunStdin {
  write(data: string): void;
  end(): void;
  destroy(): void;
}

export interface ManagedRun {
  runId: string;
  pid?: number;
  startedAtMs: number;
  stdin?: ManagedRunStdin;
  wait: () => Promise<RunExit>;
  cancel: (reason?: TerminationReason) => void;
}

// ============================================================
// Module Interfaces
// ============================================================

export interface ProcessSupervisor {
  spawn(input: SpawnInput): ManagedRun;
  cancel(runId: string, reason?: TerminationReason): void;
  cancelScope(scopeKey: string, reason?: TerminationReason): void;
  getRecord(runId: string): RunRecord | undefined;
  /** Resize the PTY terminal. No-op for non-PTY runs. */
  resizePty(runId: string, cols: number, rows: number): boolean;
}

export interface RunRegistry {
  add(record: RunRecord): void;
  get(runId: string): RunRecord | undefined;
  list(): RunRecord[];
  listByScope(scopeKey: string): RunRecord[];
  updateState(runId: string, state: RunState, patch?: Partial<RunRecord>): void;
  touchOutput(runId: string): void;
  finalize(runId: string, reason: TerminationReason, exitCode?: number | null, exitSignal?: string | null): void;
  delete(runId: string): void;
}
