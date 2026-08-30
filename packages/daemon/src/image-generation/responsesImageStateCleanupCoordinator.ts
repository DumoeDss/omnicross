import type { ImageReferenceId } from '@omnicross/contracts/image-generation-types';

import type {
  FileResponsesImageStateStore,
  PendingResponsesImageReferenceDelete,
} from './FileResponsesImageStateStore';

export interface HashedTenantImageReferenceDeleter {
  deleteByHashedTenantKey(tenantKey: string, referenceId: ImageReferenceId): Promise<boolean>;
}

export interface ResponsesImageStateCleanupCoordinatorOptions {
  readonly stateStore: FileResponsesImageStateStore;
  readonly referenceStore: HashedTenantImageReferenceDeleter;
  readonly maxReferenceDeletesPerPass?: number;
}

export interface ResponsesImageStateCleanupResult {
  readonly stateBindingsRemoved: number;
  readonly referenceDeletesAttempted: number;
  readonly referenceDeletesAcknowledged: number;
  readonly referenceDeleteFailures: number;
  readonly pendingReferenceDeletes: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
  return value;
}

/**
 * Persists state removal before attempting artifact deletion. A failed delete or
 * acknowledgement remains queued and is safe to retry after restart.
 */
export class ResponsesImageStateCleanupCoordinator {
  readonly #stateStore: FileResponsesImageStateStore;
  readonly #referenceStore: HashedTenantImageReferenceDeleter;
  readonly #maxReferenceDeletesPerPass: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ResponsesImageStateCleanupCoordinatorOptions) {
    this.#stateStore = options.stateStore;
    this.#referenceStore = options.referenceStore;
    this.#maxReferenceDeletesPerPass = positiveInteger(
      options.maxReferenceDeletesPerPass ?? 100,
      'responses image reference deletes per pass',
    );
  }

  async cleanup(now?: number): Promise<ResponsesImageStateCleanupResult> {
    return this.exclusive(async () => {
      const removed = now === undefined
        ? await this.#stateStore.cleanup()
        : await this.#stateStore.cleanup(now);
      return this.drain(removed.length);
    });
  }

  async drainPending(): Promise<ResponsesImageStateCleanupResult> {
    return this.exclusive(() => this.drain(0));
  }

  private async drain(stateBindingsRemoved: number): Promise<ResponsesImageStateCleanupResult> {
    const pending = this.#stateStore.pendingReferenceDeletes(this.#maxReferenceDeletesPerPass);
    const completed: PendingResponsesImageReferenceDelete[] = [];
    let failures = 0;
    for (const item of pending) {
      try {
        await this.#referenceStore.deleteByHashedTenantKey(
          item.referenceTenantKey,
          item.binding.referenceId,
        );
        completed.push(item);
      } catch {
        failures += 1;
      }
    }
    const acknowledged = completed.length > 0
      ? await this.#stateStore.acknowledgeReferenceDeletes(completed)
      : 0;
    return Object.freeze({
      stateBindingsRemoved,
      referenceDeletesAttempted: pending.length,
      referenceDeletesAcknowledged: acknowledged,
      referenceDeleteFailures: failures,
      pendingReferenceDeletes: this.#stateStore.status().pendingReferenceDeletes,
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
