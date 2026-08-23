import { useEffect, useSyncExternalStore } from 'react';

import {
  ensureUpdateBridge,
  getUpdateSnapshot,
  subscribeUpdateSnapshot,
  type UpdateSnapshot,
} from '@/shared/tauri/update';

export function useUpdateStatus(): UpdateSnapshot | null {
  useEffect(() => {
    void ensureUpdateBridge();
  }, []);
  return useSyncExternalStore(subscribeUpdateSnapshot, getUpdateSnapshot, () => null);
}
