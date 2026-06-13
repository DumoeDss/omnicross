/**
 * useDaemonStatus.ts — the shell's honest view of the daemon lifecycle.
 *
 * Inside Tauri it invokes the Rust `daemon_status` command and polls it until a
 * terminal state (`running` | `failed`), then stops. In a plain browser (no
 * Tauri command), it falls back to a real liveness probe via the daemon fetch
 * seam — and NEVER defaults to `running` when the daemon is unreachable.
 */

import { useEffect, useRef, useState } from 'react';

import { isTauri } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';

import { DAEMON_BASE_URL } from '@/daemon/adminClient';
import { daemonFetch } from '@/daemon/httpFetch';

export type DaemonState = 'probing' | 'adopted' | 'spawning' | 'running' | 'failed';

export interface DaemonStatus {
  state: DaemonState;
  reason?: string;
  port?: number;
  adopted?: boolean;
}

const POLL_INTERVAL_MS = 750;

function isTerminal(state: DaemonState): boolean {
  return state === 'running' || state === 'failed';
}

/** Browser-dev fallback: a real liveness probe — any HTTP response ⇒ running. */
async function probeLiveness(): Promise<DaemonStatus> {
  try {
    // Any response (even 401) proves the daemon is listening.
    await daemonFetch(`${DAEMON_BASE_URL}/admin/api/status`, { method: 'GET' });
    return { state: 'running', port: 8766, adopted: true };
  } catch {
    return {
      state: 'failed',
      reason: 'daemon not reachable on 127.0.0.1:8766',
    };
  }
}

export function useDaemonStatus(): DaemonStatus {
  const [status, setStatus] = useState<DaemonStatus>({ state: 'probing' });
  // Guard against setState after unmount across the async poll loop.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      let next: DaemonStatus;
      if (isTauri()) {
        try {
          next = await invoke<DaemonStatus>('daemon_status');
        } catch {
          // Command unavailable — treat as browser-dev fallback rather than
          // assuming running.
          next = await probeLiveness();
        }
      } else {
        next = await probeLiveness();
      }
      if (!aliveRef.current) return;
      setStatus(next);
      if (!isTerminal(next.state)) {
        timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    }

    void tick();

    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return status;
}
