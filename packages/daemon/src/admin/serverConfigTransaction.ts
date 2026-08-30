export interface PreparedServerConfigChange {
  /** Publish the prepared snapshot. Implementations should make this an infallible swap. */
  publish(): void | Promise<void>;
  /** Restore the exact runtime snapshot that preceded publish. */
  rollback(): void | Promise<void>;
  /** Release an unpublished or rolled-back replacement. */
  dispose(): void | Promise<void>;
}

export interface ServerConfigTransactionDeps<TConfig, TSnapshot> {
  capturePersisted(): TSnapshot;
  prepare(current: TConfig, next: TConfig): Promise<PreparedServerConfigChange[]>;
  persist(next: TConfig): Promise<void>;
  restorePersisted(snapshot: TSnapshot): void | Promise<void>;
}

export class ServerConfigTransactionError extends Error {
  readonly code = 'server_config_transaction_failed';

  constructor(
    readonly phase: 'prepare' | 'persist' | 'publish',
    readonly rollbackFailed: boolean,
  ) {
    super(
      rollbackFailed
        ? 'server configuration update failed and rollback was incomplete'
        : `server configuration update failed during ${phase}`,
    );
    this.name = 'ServerConfigTransactionError';
  }
}

async function disposePrepared(changes: readonly PreparedServerConfigChange[]): Promise<boolean> {
  let failed = false;
  for (const change of [...changes].reverse()) {
    try {
      await change.dispose();
    } catch {
      failed = true;
    }
  }
  return failed;
}

/** Prepare everything, persist once, publish, and restore both layers on any commit fault. */
export async function applyServerConfigTransaction<TConfig, TSnapshot>(
  current: TConfig,
  next: TConfig,
  deps: ServerConfigTransactionDeps<TConfig, TSnapshot>,
): Promise<void> {
  const persistedSnapshot = deps.capturePersisted();
  let prepared: PreparedServerConfigChange[];
  try {
    prepared = await deps.prepare(current, next);
  } catch {
    throw new ServerConfigTransactionError('prepare', false);
  }

  try {
    await deps.persist(next);
  } catch {
    const disposeFailed = await disposePrepared(prepared);
    throw new ServerConfigTransactionError('persist', disposeFailed);
  }

  const attempted: PreparedServerConfigChange[] = [];
  try {
    for (const change of prepared) {
      attempted.push(change);
      await change.publish();
    }
  } catch {
    let rollbackFailed = false;
    for (const change of [...attempted].reverse()) {
      try {
        await change.rollback();
      } catch {
        rollbackFailed = true;
      }
    }
    try {
      await deps.restorePersisted(persistedSnapshot);
    } catch {
      rollbackFailed = true;
    }
    if (await disposePrepared(prepared)) rollbackFailed = true;
    throw new ServerConfigTransactionError('publish', rollbackFailed);
  }
}
