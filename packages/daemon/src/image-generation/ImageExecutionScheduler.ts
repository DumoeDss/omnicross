import { createHmac } from 'node:crypto';

import { ImageGenerationError } from '@omnicross/core/image-generation';
import type { ImagesServerConfig } from '@omnicross/core/outbound-api';
import type {
  ImageExecutionAccountKey,
  ImageExecutionScheduler,
  ImageExecutionSchedulerGrant,
  ImageExecutionSchedulerRequest,
} from '@omnicross/subscriptions';

const ACCOUNT_DOMAIN = Buffer.from('omnicross:image-execution:account:v1\0', 'utf8');
const TENANT_DOMAIN = Buffer.from('omnicross:image-execution:tenant:v1\0', 'utf8');
const OPAQUE_KEY_PATTERN = /^[a-f0-9]{64}$/u;

type ImageQueueConfigSnapshot = Readonly<ImagesServerConfig['queue']>;

interface ImageExecutionWaiter {
  readonly tenantKey: string;
  readonly signal: AbortSignal;
  readonly resolve: (grant: ImageExecutionSchedulerGrant) => void;
  readonly reject: (error: ImageGenerationError) => void;
  onAbort: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface ImageExecutionAccountState {
  activeJobs: number;
  readonly activeGrants: Set<{ readonly controller: AbortController }>;
  readonly tenantQueues: Map<string, ImageExecutionWaiter[]>;
  readonly tenantOrder: string[];
}

export interface DaemonImageExecutionSchedulerOptions {
  readonly config: ImagesServerConfig['queue'];
  /** Persistent private daemon key material; copied on construction. */
  readonly hmacKey: Uint8Array;
}

export interface DaemonImageExecutionSchedulerStatus {
  readonly activeJobs: number;
  readonly waitingJobs: number;
  readonly activeAccounts: number;
  readonly waitingAccounts: number;
  readonly waitingTenants: number;
  readonly maxConcurrentJobsPerAccount: number;
  readonly maxQueuedJobs: number;
  readonly accepting: boolean;
  readonly shuttingDown: boolean;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function trustedIdentity(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function cancelled(signal: AbortSignal): ImageGenerationError {
  return new ImageGenerationError('request_cancelled', {
    retrySafety: 'before_acceptance',
    cause: signal.reason,
  });
}

/**
 * Snapshot-bound image admission with per-account active caps and fair tenant
 * rotation under one bounded global waiting population.
 */
export class DaemonImageExecutionScheduler implements ImageExecutionScheduler {
  readonly #config: ImageQueueConfigSnapshot;
  readonly #hmacKey: Buffer;
  readonly #accounts = new Map<string, ImageExecutionAccountState>();
  #waitingJobs = 0;
  #accepting = true;
  #shuttingDown = false;

  constructor(options: DaemonImageExecutionSchedulerOptions) {
    if (options.hmacKey.byteLength !== 32) {
      throw new TypeError('image execution scheduler HMAC key is invalid');
    }
    this.#hmacKey = Buffer.from(options.hmacKey);
    this.#config = Object.freeze({
      maxConcurrentJobsPerAccount: positiveSafeInteger(
        options.config.maxConcurrentJobsPerAccount,
        'images.queue.maxConcurrentJobsPerAccount',
      ),
      maxQueuedJobs: positiveSafeInteger(
        options.config.maxQueuedJobs,
        'images.queue.maxQueuedJobs',
      ),
      queueTimeoutMs: positiveSafeInteger(
        options.config.queueTimeoutMs,
        'images.queue.queueTimeoutMs',
      ),
      generationTimeoutMs: positiveSafeInteger(
        options.config.generationTimeoutMs,
        'images.queue.generationTimeoutMs',
      ),
    });
  }

  deriveAccountKey(selectedAccountId: string): ImageExecutionAccountKey {
    if (!this.#accepting) throw new ImageGenerationError('request_cancelled');
    const accountId = trustedIdentity(selectedAccountId, 'selected image account id');
    return createHmac('sha256', this.#hmacKey)
      .update(ACCOUNT_DOMAIN)
      .update(accountId, 'utf8')
      .digest('hex') as ImageExecutionAccountKey;
  }

  async acquire(request: ImageExecutionSchedulerRequest): Promise<ImageExecutionSchedulerGrant> {
    if (request.signal.aborted) throw cancelled(request.signal);
    if (!this.#accepting) {
      throw new ImageGenerationError('request_cancelled', { retrySafety: 'before_acceptance' });
    }
    if (!OPAQUE_KEY_PATTERN.test(request.accountKey)) {
      throw new TypeError('image execution account key is invalid');
    }
    const tenantId = trustedIdentity(request.tenantId, 'image execution tenant id');
    const tenantKey = createHmac('sha256', this.#hmacKey)
      .update(TENANT_DOMAIN)
      .update(tenantId, 'utf8')
      .digest('hex');
    const accountKey = request.accountKey as string;
    const account = this.#accounts.get(accountKey) ?? {
      activeJobs: 0,
      activeGrants: new Set<{ readonly controller: AbortController }>(),
      tenantQueues: new Map<string, ImageExecutionWaiter[]>(),
      tenantOrder: [],
    };
    this.#accounts.set(accountKey, account);

    if (account.activeJobs < this.#config.maxConcurrentJobsPerAccount) {
      return this.#createGrant(accountKey, account);
    }
    if (this.#waitingJobs >= this.#config.maxQueuedJobs) {
      this.#pruneAccount(accountKey, account);
      throw new ImageGenerationError('image_queue_full', {
        retrySafety: 'before_acceptance',
      });
    }

    return new Promise<ImageExecutionSchedulerGrant>((resolve, reject) => {
      const waiter: ImageExecutionWaiter = {
        tenantKey,
        signal: request.signal,
        resolve,
        reject,
        onAbort: () => undefined,
        settled: false,
      };
      waiter.onAbort = () => {
        this.#removeWaiter(accountKey, account, waiter, cancelled(request.signal));
      };
      const queue = account.tenantQueues.get(tenantKey);
      if (queue) {
        queue.push(waiter);
      } else {
        account.tenantQueues.set(tenantKey, [waiter]);
        account.tenantOrder.push(tenantKey);
      }
      this.#waitingJobs += 1;
      request.signal.addEventListener('abort', waiter.onAbort, { once: true });
      waiter.timeout = setTimeout(() => {
        this.#removeWaiter(
          accountKey,
          account,
          waiter,
          new ImageGenerationError('image_queue_timeout', {
            retrySafety: 'before_acceptance',
          }),
        );
      }, this.#config.queueTimeoutMs);
      waiter.timeout.unref();
      if (request.signal.aborted) waiter.onAbort();
    });
  }

  status(): DaemonImageExecutionSchedulerStatus {
    let activeJobs = 0;
    let activeAccounts = 0;
    let waitingAccounts = 0;
    let waitingTenants = 0;
    for (const account of this.#accounts.values()) {
      activeJobs += account.activeJobs;
      if (account.activeJobs > 0) activeAccounts += 1;
      if (account.tenantQueues.size > 0) waitingAccounts += 1;
      waitingTenants += account.tenantQueues.size;
    }
    return Object.freeze({
      activeJobs,
      waitingJobs: this.#waitingJobs,
      activeAccounts,
      waitingAccounts,
      waitingTenants,
      maxConcurrentJobsPerAccount: this.#config.maxConcurrentJobsPerAccount,
      maxQueuedJobs: this.#config.maxQueuedJobs,
      accepting: this.#accepting,
      shuttingDown: this.#shuttingDown,
    });
  }

  /** Stop new admissions while allowing already queued and active work to drain. */
  retire(): void {
    this.#accepting = false;
  }

  /** Reject waiters and cancel active grants. Safe to call repeatedly. */
  shutdown(): void {
    if (this.#shuttingDown) return;
    this.#accepting = false;
    this.#shuttingDown = true;
    for (const [accountKey, account] of [...this.#accounts]) {
      for (const queue of [...account.tenantQueues.values()]) {
        for (const waiter of [...queue]) {
          this.#removeWaiter(
            accountKey,
            account,
            waiter,
            new ImageGenerationError('request_cancelled', {
              retrySafety: 'before_acceptance',
            }),
          );
        }
      }
      for (const grant of account.activeGrants) {
        grant.controller.abort(new ImageGenerationError('request_cancelled'));
      }
    }
  }

  #createGrant(
    accountKey: string,
    account: ImageExecutionAccountState,
  ): ImageExecutionSchedulerGrant {
    let released = false;
    const activeGrant = { controller: new AbortController() };
    account.activeJobs += 1;
    account.activeGrants.add(activeGrant);
    return Object.freeze({
      signal: activeGrant.controller.signal,
      release: (): void => {
        if (released) return;
        released = true;
        const current = this.#accounts.get(accountKey);
        if (!current || !current.activeGrants.delete(activeGrant)) return;
        current.activeJobs = Math.max(0, current.activeJobs - 1);
        if (!this.#shuttingDown) this.#drain(accountKey, current);
        this.#pruneAccount(accountKey, current);
      },
    });
  }

  #drain(accountKey: string, account: ImageExecutionAccountState): void {
    while (account.activeJobs < this.#config.maxConcurrentJobsPerAccount) {
      const waiter = this.#takeNextWaiter(account);
      if (!waiter) return;
      this.#waitingJobs = Math.max(0, this.#waitingJobs - 1);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
      if (waiter.signal.aborted) {
        waiter.settled = true;
        waiter.reject(cancelled(waiter.signal));
        continue;
      }
      waiter.settled = true;
      waiter.resolve(this.#createGrant(accountKey, account));
    }
  }

  #takeNextWaiter(account: ImageExecutionAccountState): ImageExecutionWaiter | undefined {
    while (account.tenantOrder.length > 0) {
      const tenantKey = account.tenantOrder.shift()!;
      const queue = account.tenantQueues.get(tenantKey);
      if (!queue || queue.length === 0) {
        account.tenantQueues.delete(tenantKey);
        continue;
      }
      const waiter = queue.shift()!;
      if (queue.length > 0) {
        account.tenantOrder.push(tenantKey);
      } else {
        account.tenantQueues.delete(tenantKey);
      }
      return waiter;
    }
    return undefined;
  }

  #removeWaiter(
    accountKey: string,
    account: ImageExecutionAccountState,
    waiter: ImageExecutionWaiter,
    error: ImageGenerationError,
  ): void {
    if (waiter.settled) return;
    const queue = account.tenantQueues.get(waiter.tenantKey);
    const index = queue?.indexOf(waiter) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    waiter.settled = true;
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
    this.#waitingJobs = Math.max(0, this.#waitingJobs - 1);
    if (queue.length === 0) {
      account.tenantQueues.delete(waiter.tenantKey);
      const orderIndex = account.tenantOrder.indexOf(waiter.tenantKey);
      if (orderIndex >= 0) account.tenantOrder.splice(orderIndex, 1);
    }
    waiter.reject(error);
    this.#pruneAccount(accountKey, account);
  }

  #pruneAccount(accountKey: string, account: ImageExecutionAccountState): void {
    if (account.activeJobs === 0 && account.tenantQueues.size === 0) {
      this.#accounts.delete(accountKey);
    }
  }
}
