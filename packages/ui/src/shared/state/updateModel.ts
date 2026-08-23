import type { UpdateSnapshot } from '@/shared/tauri/update';

export interface UpdateActions {
  canCheck: boolean;
  canDownload: boolean;
  canRetry: boolean;
  canInstall: boolean;
  canOpenRelease: boolean;
  showAppBanner: boolean;
}

export function updateActions(snapshot: UpdateSnapshot | null): UpdateActions {
  if (!snapshot) {
    return {
      canCheck: false,
      canDownload: false,
      canRetry: false,
      canInstall: false,
      canOpenRelease: false,
      showAppBanner: false,
    };
  }
  const busy = snapshot.state === 'checking' || snapshot.state === 'downloading' || snapshot.state === 'installing';
  const actionableFailure = snapshot.state === 'failed' && snapshot.error?.phase !== 'check';
  return {
    canCheck: !busy,
    canDownload: snapshot.state === 'available' && snapshot.canInstall,
    canRetry: snapshot.state === 'failed' && Boolean(snapshot.error?.retryable),
    canInstall: snapshot.state === 'ready' && snapshot.canInstall,
    canOpenRelease: Boolean(snapshot.releaseUrl),
    showAppBanner: ['available', 'downloading', 'ready'].includes(snapshot.state) || actionableFailure,
  };
}
