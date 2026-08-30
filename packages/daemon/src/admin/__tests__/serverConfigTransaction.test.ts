import { describe, expect, it } from 'vitest';

import {
  applyServerConfigTransaction,
  type PreparedServerConfigChange,
  ServerConfigTransactionError,
} from '../serverConfigTransaction';

function change(
  name: string,
  events: string[],
  faults: { publish?: boolean; rollback?: boolean; dispose?: boolean } = {},
): PreparedServerConfigChange {
  return {
    publish: () => {
      events.push(`publish:${name}`);
      if (faults.publish) throw new Error('injected publish failure');
    },
    rollback: () => {
      events.push(`rollback:${name}`);
      if (faults.rollback) throw new Error('injected rollback failure');
    },
    dispose: () => {
      events.push(`dispose:${name}`);
      if (faults.dispose) throw new Error('injected dispose failure');
    },
  };
}

describe('applyServerConfigTransaction', () => {
  it('prepares all participants, persists once, then publishes in order', async () => {
    const events: string[] = [];
    await applyServerConfigTransaction({ value: 1 }, { value: 2 }, {
      capturePersisted: () => {
        events.push('snapshot');
        return 'prior-bytes';
      },
      prepare: async () => {
        events.push('prepare');
        return [change('images', events), change('listener', events)];
      },
      persist: async () => {
        events.push('persist');
      },
      restorePersisted: () => {
        events.push('restore');
      },
    });
    expect(events).toEqual([
      'snapshot',
      'prepare',
      'persist',
      'publish:images',
      'publish:listener',
    ]);
  });

  it('reports prepare failure without persistence or publication', async () => {
    const events: string[] = [];
    await expect(applyServerConfigTransaction(1, 2, {
      capturePersisted: () => 'prior',
      prepare: async () => {
        events.push('prepare');
        throw new Error('injected prepare failure');
      },
      persist: async () => {
        events.push('persist');
      },
      restorePersisted: () => {
        events.push('restore');
      },
    })).rejects.toMatchObject({ phase: 'prepare', rollbackFailed: false });
    expect(events).toEqual(['prepare']);
  });

  it('disposes unpublished replacements after persistence failure', async () => {
    const events: string[] = [];
    await expect(applyServerConfigTransaction(1, 2, {
      capturePersisted: () => 'prior',
      prepare: async () => [change('images', events), change('listener', events)],
      persist: async () => {
        events.push('persist');
        throw new Error('injected persist failure');
      },
      restorePersisted: () => {
        events.push('restore');
      },
    })).rejects.toMatchObject({ phase: 'persist', rollbackFailed: false });
    expect(events).toEqual(['persist', 'dispose:listener', 'dispose:images']);
  });

  it('rolls back attempted runtime snapshots and the persisted document on commit failure', async () => {
    const events: string[] = [];
    await expect(applyServerConfigTransaction(1, 2, {
      capturePersisted: () => 'prior-bytes',
      prepare: async () => [
        change('images', events),
        change('listener', events, { publish: true }),
      ],
      persist: async () => {
        events.push('persist');
      },
      restorePersisted: (snapshot) => {
        events.push(`restore:${snapshot}`);
      },
    })).rejects.toMatchObject({ phase: 'publish', rollbackFailed: false });
    expect(events).toEqual([
      'persist',
      'publish:images',
      'publish:listener',
      'rollback:listener',
      'rollback:images',
      'restore:prior-bytes',
      'dispose:listener',
      'dispose:images',
    ]);
  });

  it('surfaces rollback failure without exposing the injected cause', async () => {
    const events: string[] = [];
    let caught: unknown;
    try {
      await applyServerConfigTransaction(1, 2, {
        capturePersisted: () => 'prior',
        prepare: async () => [change('images', events, { rollback: true, publish: true })],
        persist: async () => undefined,
        restorePersisted: () => {
          throw new Error('sensitive restore cause');
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerConfigTransactionError);
    expect(caught).toMatchObject({ phase: 'publish', rollbackFailed: true });
    expect((caught as Error).message).toBe(
      'server configuration update failed and rollback was incomplete',
    );
    expect((caught as Error).message).not.toContain('sensitive restore cause');
  });
});
