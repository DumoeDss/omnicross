import type { ImageStartupReconciler } from './ImageStartupReconciler';
import type { ImageStorageMountCatalog } from './ImageStorageMountCatalog';

export interface BoundedImageEvidenceCleanup {
  cleanup(
    now: number,
    limit: number,
  ): Promise<{ readonly entriesRemoved: number; readonly bytesRemoved: number }>;
}

export interface ImageCleanupTimer {
  unref(): unknown;
}

export interface ImageCleanupServiceOptions {
  readonly reconciler: ImageStartupReconciler;
  readonly catalog: ImageStorageMountCatalog;
  readonly intervalMs: number;
  readonly maxEvidenceEntriesPerPass?: number;
  readonly maxRetiredMountsPerPass?: number;
  readonly evidence?: BoundedImageEvidenceCleanup;
  readonly now?: () => number;
  readonly scheduleInterval?: (callback: () => void, intervalMs: number) => ImageCleanupTimer;
  readonly clearScheduledInterval?: (timer: ImageCleanupTimer) => void;
}

export interface ImageCleanupPolicy {
  readonly reconciler: ImageStartupReconciler;
  readonly intervalMs: number;
  readonly evidence?: BoundedImageEvidenceCleanup;
}

export interface PreparedImageCleanupPolicyChange {
  publish(): void;
  rollback(): void;
  dispose(): void;
}

export interface ImageCleanupServicePassResult {
  readonly stateBindingsRemoved: number;
  readonly brokenBindingsRemoved: number;
  readonly referenceEntriesRemoved: number;
  readonly orphanFilesRemoved: number;
  readonly incompleteFilesRemoved: number;
  readonly transactionFilesRemoved: number;
  readonly temporaryDirectoriesRemoved: number;
  readonly evidenceEntriesRemoved: number;
  readonly evidenceBytesRemoved: number;
  readonly evidenceCleanupFailures: number;
  readonly retiredMountsRemoved: number;
  readonly referenceEntries: number;
  readonly referenceBytes: number;
  readonly referenceTombstones: number;
  readonly stateCalls: number;
  readonly stateResponses: number;
  readonly stateTombstones: number;
  readonly pendingReferenceDeletes: number;
  readonly finishedAt: number;
}

export interface ImageCleanupServiceStatus extends ImageCleanupServicePassResult {
  readonly running: boolean;
  readonly passesCompleted: number;
  readonly passFailures: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
  return value;
}

function emptyPass(finishedAt = 0): ImageCleanupServicePassResult {
  return Object.freeze({
    stateBindingsRemoved: 0,
    brokenBindingsRemoved: 0,
    referenceEntriesRemoved: 0,
    orphanFilesRemoved: 0,
    incompleteFilesRemoved: 0,
    transactionFilesRemoved: 0,
    temporaryDirectoriesRemoved: 0,
    evidenceEntriesRemoved: 0,
    evidenceBytesRemoved: 0,
    evidenceCleanupFailures: 0,
    retiredMountsRemoved: 0,
    referenceEntries: 0,
    referenceBytes: 0,
    referenceTombstones: 0,
    stateCalls: 0,
    stateResponses: 0,
    stateTombstones: 0,
    pendingReferenceDeletes: 0,
    finishedAt,
  });
}

/** Unref'ed recurring lifecycle owner with one non-overlapping bounded pass. */
export class ImageCleanupService {
  #reconciler: ImageStartupReconciler;
  readonly #catalog: ImageStorageMountCatalog;
  #intervalMs: number;
  readonly #maxEvidenceEntriesPerPass: number;
  readonly #maxRetiredMountsPerPass: number;
  #evidence: BoundedImageEvidenceCleanup | undefined;
  readonly #now: () => number;
  readonly #scheduleInterval: (callback: () => void, intervalMs: number) => ImageCleanupTimer;
  readonly #clearScheduledInterval: (timer: ImageCleanupTimer) => void;
  #timer: ImageCleanupTimer | undefined;
  #passPromise: Promise<ImageCleanupServicePassResult> | undefined;
  #last = emptyPass();
  #passesCompleted = 0;
  #passFailures = 0;

  constructor(options: ImageCleanupServiceOptions) {
    this.#reconciler = options.reconciler;
    this.#catalog = options.catalog;
    this.#intervalMs = positiveInteger(options.intervalMs, 'image cleanup interval');
    this.#maxEvidenceEntriesPerPass = positiveInteger(
      options.maxEvidenceEntriesPerPass ?? 100,
      'image evidence cleanup bound',
    );
    this.#maxRetiredMountsPerPass = positiveInteger(
      options.maxRetiredMountsPerPass ?? 4,
      'image retired-mount cleanup bound',
    );
    this.#evidence = options.evidence;
    this.#now = options.now ?? Date.now;
    this.#scheduleInterval = options.scheduleInterval ?? ((callback, intervalMs) =>
      setInterval(callback, intervalMs));
    this.#clearScheduledInterval = options.clearScheduledInterval ?? ((timer) =>
      clearInterval(timer as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.#timer) return;
    this.schedule();
  }

  private schedule(): void {
    const timer = this.#scheduleInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, this.#intervalMs);
    timer.unref();
    this.#timer = timer;
  }

  /** Prepares a hot-reloadable cadence/reconciler/evidence snapshot. */
  preparePolicy(policy: ImageCleanupPolicy): PreparedImageCleanupPolicyChange {
    const nextIntervalMs = positiveInteger(policy.intervalMs, 'image cleanup interval');
    const previous = {
      reconciler: this.#reconciler,
      intervalMs: this.#intervalMs,
      evidence: this.#evidence,
    };
    const wasRunning = this.#timer !== undefined;
    let state: 'prepared' | 'published' | 'rolled_back' | 'disposed' = 'prepared';
    const apply = (next: ImageCleanupPolicy): void => {
      const timer = this.#timer;
      this.#timer = undefined;
      if (timer) this.#clearScheduledInterval(timer);
      this.#reconciler = next.reconciler;
      this.#intervalMs = next.intervalMs;
      this.#evidence = next.evidence;
      if (wasRunning) this.schedule();
    };
    const next: ImageCleanupPolicy = {
      reconciler: policy.reconciler,
      intervalMs: nextIntervalMs,
      ...(policy.evidence ? { evidence: policy.evidence } : {}),
    };
    return Object.freeze({
      publish: () => {
        if (state === 'published') return;
        if (state !== 'prepared') throw new TypeError('cleanup policy cannot be published');
        try {
          apply(next);
          state = 'published';
        } catch (error) {
          apply(previous);
          throw error;
        }
      },
      rollback: () => {
        if (state === 'rolled_back') return;
        if (state !== 'published') return;
        apply(previous);
        state = 'rolled_back';
      },
      dispose: () => {
        if (state === 'disposed' || state === 'published') return;
        state = 'disposed';
      },
    });
  }

  async stop(): Promise<void> {
    const timer = this.#timer;
    this.#timer = undefined;
    if (timer) this.#clearScheduledInterval(timer);
    await this.#passPromise?.catch(() => undefined);
  }

  async reset(): Promise<void> {
    await this.stop();
    this.#last = emptyPass();
    this.#passesCompleted = 0;
    this.#passFailures = 0;
  }

  async runOnce(): Promise<ImageCleanupServicePassResult> {
    if (this.#passPromise) return this.#passPromise;
    const current = this.performPass();
    this.#passPromise = current;
    try {
      const result = await current;
      this.#last = result;
      this.#passesCompleted += 1;
      return result;
    } catch (error) {
      this.#passFailures += 1;
      throw error;
    } finally {
      if (this.#passPromise === current) this.#passPromise = undefined;
    }
  }

  status(): ImageCleanupServiceStatus {
    return Object.freeze({
      ...this.#last,
      running: this.#timer !== undefined,
      passesCompleted: this.#passesCompleted,
      passFailures: this.#passFailures,
    });
  }

  private async performPass(): Promise<ImageCleanupServicePassResult> {
    const reconciler = this.#reconciler;
    const evidenceOwner = this.#evidence;
    const reconciliation = await reconciler.run();
    const now = this.#now();
    let evidenceEntriesRemoved = 0;
    let evidenceBytesRemoved = 0;
    let evidenceCleanupFailures = 0;
    if (evidenceOwner) {
      try {
        const evidence = await evidenceOwner.cleanup(now, this.#maxEvidenceEntriesPerPass);
        evidenceEntriesRemoved = evidence.entriesRemoved;
        evidenceBytesRemoved = evidence.bytesRemoved;
      } catch {
        evidenceCleanupFailures = 1;
      }
    }

    const activeMountId = this.#catalog.active().id;
    let retiredMountsRemoved = 0;
    for (const mount of this.#catalog.mountsForRead()) {
      if (mount.id === activeMountId || retiredMountsRemoved >= this.#maxRetiredMountsPerPass) {
        continue;
      }
      if (this.#catalog.retireEmptyMount(mount.id)) retiredMountsRemoved += 1;
    }
    const utilization = this.#catalog.utilization();
    return Object.freeze({
      stateBindingsRemoved: reconciliation.stateBindingsRemoved,
      brokenBindingsRemoved: reconciliation.brokenBindingsRemoved,
      referenceEntriesRemoved: reconciliation.referenceEntriesRemoved + reconciliation.metadataRemoved,
      orphanFilesRemoved: reconciliation.orphanFilesRemoved,
      incompleteFilesRemoved: reconciliation.incompleteFilesRemoved,
      transactionFilesRemoved: reconciliation.transactionFilesRemoved,
      temporaryDirectoriesRemoved: reconciliation.temporaryDirectoriesRemoved,
      evidenceEntriesRemoved,
      evidenceBytesRemoved,
      evidenceCleanupFailures,
      retiredMountsRemoved,
      ...utilization,
      finishedAt: now,
    });
  }
}
