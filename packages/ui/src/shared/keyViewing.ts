import { adminClient } from '@/daemon/adminClient';

export interface ViewingRequest {
  mode: 'set' | 'verify';
  run: (password: string) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}
let pending: ViewingRequest | null = null;
let generation = 0;
const listeners = new Set<() => void>();
export const viewingRequests = {
  get: () => pending,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

export function cancelViewingRequest(): void {
  generation += 1;
  const previous = pending;
  pending = null;
  previous?.reject(new Error('view-password-cancelled'));
  listeners.forEach((listener) => listener());
}

export function completeViewingRequest(request: ViewingRequest, value: unknown): void {
  if (pending !== request) return;
  pending = null;
  request.resolve(value);
  listeners.forEach((listener) => listener());
}

/** One prompt and backend verification (or first-time setup) per action. */
export async function protectedPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  cancelViewingRequest();
  const started = generation;
  const status = await adminClient.get<{ enabled: boolean }>('/key-viewing-password');
  if (started !== generation) throw new Error('view-password-cancelled');
  return new Promise<T>((resolve, reject) => {
    pending = {
      mode: status.enabled ? 'verify' : 'set',
      run: (viewingPassword) => adminClient.post<T>(path, { ...body, viewingPassword }),
      resolve: (value) => resolve(value as T), reject,
    };
    listeners.forEach((listener) => listener());
  });
}
