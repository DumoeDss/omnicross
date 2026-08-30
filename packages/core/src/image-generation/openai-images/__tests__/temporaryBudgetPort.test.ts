import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImageGenerationError } from '../../errors';
import {
  ImageRequestResourceScope,
  createImageRequestResourceScope,
  type ImageTemporaryResourceBudget,
  type ImageTemporaryResourceBudgetLease,
} from '../TemporaryImageAsset';
import { DEFAULT_IMAGE_API_LIMITS } from '../types';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'omnicross-images-budget-port-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class TrackingBudget implements ImageTemporaryResourceBudget {
  activeScopes = 0;
  totalBytes = 0;
  readonly tenantBytes = new Map<string, number>();
  onReserve?: () => void;

  constructor(private readonly maxBytes = Number.MAX_SAFE_INTEGER) {}

  acquireScope(tenantId: string): ImageTemporaryResourceBudgetLease {
    this.activeScopes += 1;
    let bytes = 0;
    let released = false;
    return {
      reserve: (amount) => {
        if (this.totalBytes + amount > this.maxBytes) {
          throw new ImageGenerationError('image_too_large');
        }
        bytes += amount;
        this.totalBytes += amount;
        this.tenantBytes.set(tenantId, (this.tenantBytes.get(tenantId) ?? 0) + amount);
        this.onReserve?.();
      },
      release: (amount) => {
        const actual = Math.min(bytes, amount);
        bytes -= actual;
        this.totalBytes -= actual;
        this.tenantBytes.set(tenantId, (this.tenantBytes.get(tenantId) ?? 0) - actual);
      },
      releaseScope: () => {
        if (released) return;
        released = true;
        this.activeScopes -= 1;
      },
    };
  }
}

async function* bytes(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}

describe('ImageRequestResourceScope shared budget port', () => {
  it('charges one active tenant scope and releases input/spool bytes exactly once', async () => {
    const budget = new TrackingBudget();
    const scope = await createImageRequestResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      new AbortController().signal,
      await root(),
      { tenantId: 'tenant-a', sharedBudget: budget },
    );
    expect(budget.activeScopes).toBe(1);

    await scope.materialize(bytes('input'));
    const spoolWriter = await scope.createWriter({ kind: 'spool', maxBytes: 32 });
    await spoolWriter.write(Buffer.from('spool'));
    const spool = await spoolWriter.finish();
    expect(budget.totalBytes).toBe(10);
    expect(budget.tenantBytes.get('tenant-a')).toBe(10);

    await spool.dispose();
    await spool.dispose();
    expect(budget.totalBytes).toBe(5);
    await scope.cleanup();
    await scope.cleanup();
    expect(budget.totalBytes).toBe(0);
    expect(budget.tenantBytes.get('tenant-a')).toBe(0);
    expect(budget.activeScopes).toBe(0);
  });

  it('rolls back a charged chunk when cancellation wins before the write', async () => {
    const controller = new AbortController();
    const budget = new TrackingBudget();
    const scope = await createImageRequestResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      controller.signal,
      await root(),
      { tenantId: 'tenant-a', sharedBudget: budget },
    );
    budget.onReserve = () => controller.abort();

    await expect(scope.materialize(bytes('cancelled'))).rejects.toMatchObject({
      code: 'request_cancelled',
    });
    expect(budget.totalBytes).toBe(0);
    expect(budget.activeScopes).toBe(1);
    await scope.cleanup();
    expect(budget.activeScopes).toBe(0);
  });

  it('fails before writing when shared capacity rejects a reservation', async () => {
    const budget = new TrackingBudget(3);
    const scope = await createImageRequestResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      new AbortController().signal,
      await root(),
      { tenantId: 'tenant-b', sharedBudget: budget },
    );
    await expect(scope.materialize(bytes('four'))).rejects.toMatchObject({ code: 'image_too_large' });
    expect(budget.totalBytes).toBe(0);
    await scope.cleanup();
    expect(budget.activeScopes).toBe(0);
  });

  it('releases the active-scope reservation when directory creation fails', async () => {
    const testRoot = await root();
    const invalidRoot = join(testRoot, 'not-a-directory');
    await writeFile(invalidRoot, 'file');
    const budget = new TrackingBudget();
    await expect(createImageRequestResourceScope(
      DEFAULT_IMAGE_API_LIMITS,
      new AbortController().signal,
      invalidRoot,
      { tenantId: 'tenant-c', sharedBudget: budget },
    )).rejects.toBeDefined();
    expect(budget.activeScopes).toBe(0);
  });

  it('requires a trusted tenant whenever a shared budget is provided', async () => {
    const budget = new TrackingBudget();
    await expect(ImageRequestResourceScope.create({
      limits: DEFAULT_IMAGE_API_LIMITS,
      signal: new AbortController().signal,
      tempRoot: await root(),
      sharedBudget: budget,
    })).rejects.toThrow(/trusted tenant id/);
    expect(budget.activeScopes).toBe(0);
  });
});
