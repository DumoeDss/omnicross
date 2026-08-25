/**
 * child_process spawn adapter.
 *
 * Wraps Node.js child_process.spawn with platform-specific defaults:
 * - Windows: windowsHide=true, not detached
 * - Unix: detached=true for process group kill support
 *
 * PIPES ARE DRAINED FROM THE FIRST TICK, not from whenever a consumer shows up.
 * `stdio` is `['pipe','pipe','pipe']`, and a piped stream nobody reads stalls the
 * child once the OS pipe buffer fills — on Windows and Linux the child's write is
 * synchronous, so "stalls" means its event loop stops, permanently, with the
 * process still alive. (The desktop app hit exactly this with the daemon's
 * stderr.) So both streams are attached immediately and buffered into a bounded
 * ring; `onStdout`/`onStderr` replay that ring to the consumer, so early output
 * is not lost either. A caller that never subscribes still cannot wedge its
 * child.
 *
 * @module child-adapter
 */

import { type ChildProcess, spawn as cpSpawn, type SpawnOptions } from 'node:child_process';

import { killProcessTree } from './kill-tree';
import type { SpawnChildInput } from './types';

const TAG = '[ProcessSupervisor]';
const IS_WIN = process.platform === 'win32';

/**
 * Chunks held per stream while nothing is subscribed. Bounded so an unattended
 * chatty child costs memory in the low megabytes rather than without limit —
 * past the cap the OLDEST chunks are dropped, which keeps the most recent (and
 * for a crash, the most informative) output.
 */
const PREBUFFER_CHUNK_LIMIT = 512;

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

  // Drain both pipes NOW. Until a consumer subscribes, chunks land in a bounded
  // ring; `onStdout`/`onStderr` replay it and then stream live.
  const stdoutPump = pump(child.stdout);
  const stderrPump = pump(child.stderr);

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
      stdoutPump.subscribe(cb);
    },

    onStderr(cb: (chunk: string) => void): void {
      stderrPump.subscribe(cb);
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
      stdoutPump.dispose();
      stderrPump.dispose();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    },
  };
}

/** A subscriber sink plus the bounded ring that covers the gap before one exists. */
interface Pump {
  subscribe: (cb: (chunk: string) => void) => void;
  dispose: () => void;
}

/**
 * Attach to `stream` immediately so it can never back-pressure the child, and
 * hold what arrives until someone subscribes. Subscribing replays the ring in
 * order, then switches to live delivery.
 */
function pump(stream: NodeJS.ReadableStream | null): Pump {
  const buffered: string[] = [];
  let subscriber: ((chunk: string) => void) | null = null;
  if (!stream) {
    return { subscribe: () => {}, dispose: () => {} };
  }
  stream.setEncoding('utf8');
  const onData = (chunk: string): void => {
    if (subscriber) {
      subscriber(chunk);
      return;
    }
    if (buffered.length >= PREBUFFER_CHUNK_LIMIT) buffered.shift();
    buffered.push(chunk);
  };
  stream.on('data', onData);
  return {
    subscribe(cb: (chunk: string) => void): void {
      subscriber = cb;
      const replay = buffered.splice(0, buffered.length);
      for (const chunk of replay) cb(chunk);
    },
    dispose(): void {
      subscriber = null;
      buffered.length = 0;
      stream.off('data', onData);
      // Keep the stream flowing even with no listener — a paused pipe is the
      // deadlock this whole mechanism exists to prevent.
      stream.resume();
    },
  };
}
