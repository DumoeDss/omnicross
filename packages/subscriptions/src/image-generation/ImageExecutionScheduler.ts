declare const imageExecutionAccountKeyBrand: unique symbol;

/** A daemon-keyed, non-public scheduling identity for one selected account. */
export type ImageExecutionAccountKey = string & {
  readonly [imageExecutionAccountKeyBrand]: 'image-execution-account-key';
};

/** Credential- and content-blind admission input for selected-account work. */
export interface ImageExecutionSchedulerRequest {
  readonly tenantId: string;
  readonly accountKey: ImageExecutionAccountKey;
  readonly signal: AbortSignal;
}

export interface ImageExecutionSchedulerGrant {
  /** Optional scheduler-owned cancellation used for retirement/shutdown. */
  readonly signal?: AbortSignal;
  /** Release is required to be idempotent and safe on every terminal path. */
  release(): Promise<void> | void;
}

export interface ImageExecutionScheduler {
  /**
   * Immediately derive a local opaque key. The raw identity is transient and
   * must never enter scheduler state, status, logs, or metrics.
   */
  deriveAccountKey(selectedAccountId: string): ImageExecutionAccountKey;

  /** The scheduler instance and its limits are bound to one runtime snapshot. */
  acquire(
    request: ImageExecutionSchedulerRequest,
  ): Promise<ImageExecutionSchedulerGrant> | ImageExecutionSchedulerGrant;
}
