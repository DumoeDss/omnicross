import { LogJevError } from './types';
import type { LogJevProvider } from './types';

/** A permit is handed directly to a queued waiter, never briefly made free. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    if (active < concurrency) active++;
    else await new Promise<void>((resolve, reject) => {
      const grant = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const i = queue.indexOf(grant);
        if (i >= 0) queue.splice(i, 1);
        reject(signal.reason);
      };
      queue.push(grant);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { signal.throwIfAborted(); return await work(); }
    finally { const next = queue.shift(); if (next) next(); else active--; }
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createTransport(provider: LogJevProvider, fetcher: typeof globalThis.fetch) {
  const delays = provider.retryDelaysMs ?? [800, 2000, 5000];
  const headers = new Headers(provider.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  if (provider.apiKey) headers.set('Authorization', `Bearer ${provider.apiKey}`);
  return async (url: string, body: unknown, signal: AbortSignal, onAttempt: () => void): Promise<Record<string, unknown>> => {
    let status = 0;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      signal.throwIfAborted();
      onAttempt();
      try {
        const response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
        status = response.status;
        if (response.ok) {
          const data: unknown = await response.json().catch(() => null);
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new LogJevError('upstream', 'LogJev upstream returned invalid JSON');
          }
          return data as Record<string, unknown>;
        }
        // Never reflect upstream bodies, which may contain credentials or prompt data.
        await response.body?.cancel();
        if (![429, 500, 502, 503, 504, 529].includes(status)) break;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof LogJevError) throw error;
        status = 0;
      }
      if (attempt < delays.length) await delay(delays[attempt], signal);
    }
    throw new LogJevError('upstream', `LogJev upstream request failed (HTTP ${status || 'unavailable'})`);
  };
}
