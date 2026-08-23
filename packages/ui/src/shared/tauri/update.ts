import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { isDesktop } from './uiSettings';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'failed';

export type UpdatePhase = 'check' | 'download' | 'install';

export interface UpdateErrorView {
  phase: UpdatePhase;
  message: string;
  retryable: boolean;
}

export interface UpdateSnapshot {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  progressPercent?: number;
  autoDownloadUpdates: boolean;
  canInstall: boolean;
  error?: UpdateErrorView;
}

const UPDATE_STATUS_EVENT = 'omnicross://update-status';

let snapshot: UpdateSnapshot | null = null;
let initPromise: Promise<void> | null = null;
let unlisten: UnlistenFn | null = null;
const subscribers = new Set<() => void>();

function publish(next: UpdateSnapshot): void {
  snapshot = next;
  for (const subscriber of subscribers) subscriber();
}

export function getUpdateSnapshot(): UpdateSnapshot | null {
  return snapshot;
}

export function subscribeUpdateSnapshot(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

/**
 * Start exactly one native subscription for this renderer process. Listening
 * first closes the read/listen gap; if an event wins the race, the older
 * initial snapshot is not allowed to overwrite it.
 */
export function ensureUpdateBridge(): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    let eventSeen = false;
    try {
      unlisten = await listen<UpdateSnapshot>(UPDATE_STATUS_EVENT, ({ payload }) => {
        eventSeen = true;
        publish(payload);
      });
    } catch {
      // A missing event API/permission leaves the updater quietly unavailable.
      return;
    }
    try {
      const initial = await invoke<UpdateSnapshot>('update_status');
      if (!eventSeen) publish(initial);
    } catch {
      // A missing/outdated native shell leaves the updater quietly unavailable.
    }
  })();
  return initPromise;
}

async function command(name: string): Promise<UpdateSnapshot | null> {
  if (!isDesktop()) return null;
  try {
    await ensureUpdateBridge();
    const next = await invoke<UpdateSnapshot>(name);
    publish(next);
    return next;
  } catch {
    return null;
  }
}

export const checkForUpdates = () => command('check_for_updates');
export const downloadUpdate = () => command('download_update');
export const installUpdate = () => command('install_update');

/** Test-only reset; never called by product code. */
export async function resetUpdateBridgeForTests(): Promise<void> {
  unlisten?.();
  unlisten = null;
  initPromise = null;
  snapshot = null;
  subscribers.clear();
}
