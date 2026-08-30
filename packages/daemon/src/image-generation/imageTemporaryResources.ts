import {
  ImageGenerationError,
  ImageRequestResourceScope,
  type ImageApiLimits,
  type ImageTemporaryResourceBudget,
  type ImageTemporaryResourceBudgetLease,
} from '@omnicross/core/image-generation';
import type { ImagesServerConfig } from '@omnicross/core/outbound-api';
import { dirname, resolve } from 'node:path';

import type { DaemonImagePathResolver } from './imagePathResolver';

export interface ImageTemporaryBudgetStatus {
  readonly activeScopes: number;
  readonly totalBytes: number;
  readonly tenantCount: number;
}

interface TenantUsage {
  scopes: number;
  bytes: number;
}

function capacityExceeded(): never {
  throw new ImageGenerationError('image_too_large');
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

/** Process-local atomic budget shared by every scope in one pinned runtime generation. */
export class DaemonImageTemporaryBudget implements ImageTemporaryResourceBudget {
  readonly #maxActiveScopes: number;
  readonly #maxTotalBytes: number;
  readonly #maxTenantBytes: number;
  readonly #tenants = new Map<string, TenantUsage>();
  #activeScopes = 0;
  #totalBytes = 0;

  constructor(config: ImagesServerConfig['temporary']) {
    positiveSafeInteger(config.maxActiveScopes, 'images.temporary.maxActiveScopes');
    positiveSafeInteger(config.maxTotalBytes, 'images.temporary.maxTotalBytes');
    positiveSafeInteger(config.maxTenantBytes, 'images.temporary.maxTenantBytes');
    if (config.maxTotalBytes < config.maxTenantBytes) {
      throw new TypeError('images.temporary.maxTotalBytes must cover maxTenantBytes');
    }
    this.#maxActiveScopes = config.maxActiveScopes;
    this.#maxTotalBytes = config.maxTotalBytes;
    this.#maxTenantBytes = config.maxTenantBytes;
  }

  acquireScope(tenantId: string): ImageTemporaryResourceBudgetLease {
    if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId.length > 256) {
      throw new TypeError('image temporary scope requires a trusted tenant id');
    }
    if (this.#activeScopes >= this.#maxActiveScopes) capacityExceeded();
    const tenant = this.#tenants.get(tenantId) ?? { scopes: 0, bytes: 0 };
    tenant.scopes += 1;
    this.#tenants.set(tenantId, tenant);
    this.#activeScopes += 1;

    let leaseBytes = 0;
    let released = false;
    const releaseBytes = (requested: number): void => {
      if (!Number.isSafeInteger(requested) || requested <= 0 || leaseBytes <= 0) return;
      const amount = Math.min(requested, leaseBytes);
      leaseBytes -= amount;
      this.#totalBytes = Math.max(0, this.#totalBytes - amount);
      tenant.bytes = Math.max(0, tenant.bytes - amount);
    };
    const pruneTenant = (): void => {
      if (tenant.scopes === 0 && tenant.bytes === 0) this.#tenants.delete(tenantId);
    };

    return {
      reserve: (bytes) => {
        if (released) throw new ImageGenerationError('request_cancelled');
        positiveSafeInteger(bytes, 'image temporary reservation');
        if (
          !Number.isSafeInteger(this.#totalBytes + bytes) ||
          !Number.isSafeInteger(tenant.bytes + bytes) ||
          this.#totalBytes + bytes > this.#maxTotalBytes ||
          tenant.bytes + bytes > this.#maxTenantBytes
        ) {
          capacityExceeded();
        }
        leaseBytes += bytes;
        this.#totalBytes += bytes;
        tenant.bytes += bytes;
      },
      release: (bytes) => {
        releaseBytes(bytes);
        pruneTenant();
      },
      releaseScope: () => {
        if (released) return;
        released = true;
        releaseBytes(leaseBytes);
        tenant.scopes = Math.max(0, tenant.scopes - 1);
        this.#activeScopes = Math.max(0, this.#activeScopes - 1);
        pruneTenant();
      },
    };
  }

  status(): ImageTemporaryBudgetStatus {
    return Object.freeze({
      activeScopes: this.#activeScopes,
      totalBytes: this.#totalBytes,
      tenantCount: this.#tenants.size,
    });
  }
}

export interface DaemonImageTemporaryResourceFactoryOptions {
  readonly paths: DaemonImagePathResolver;
  readonly config: ImagesServerConfig['temporary'];
  readonly activeScopes?: DaemonImageActiveScopeRegistry;
}

/** App-session registry shared by all runtime generations and recurring cleanup. */
export class DaemonImageActiveScopeRegistry {
  readonly #temporaryRoot: string;
  readonly #active = new Set<string>();

  constructor(paths: DaemonImagePathResolver) {
    this.#temporaryRoot = resolve(paths.paths.temporaryRoot);
  }

  register(privateDirectory: string): () => void {
    const normalized = resolve(privateDirectory);
    if (dirname(normalized) !== this.#temporaryRoot || this.#active.has(normalized)) {
      throw new TypeError('image temporary scope directory is invalid or already active');
    }
    this.#active.add(normalized);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active.delete(normalized);
    };
  }

  isActive(privateDirectory: string): boolean {
    return this.#active.has(resolve(privateDirectory));
  }

  status(): { readonly activeDirectories: number } {
    return Object.freeze({ activeDirectories: this.#active.size });
  }
}

/** Binds the private root, fixed owner marker, tenant, and shared budget in one seam. */
export class DaemonImageTemporaryResourceFactory {
  readonly budget: DaemonImageTemporaryBudget;
  readonly #paths: DaemonImagePathResolver;
  readonly #activeScopes: DaemonImageActiveScopeRegistry | undefined;

  constructor(options: DaemonImageTemporaryResourceFactoryOptions) {
    this.#paths = options.paths;
    this.#activeScopes = options.activeScopes;
    this.budget = new DaemonImageTemporaryBudget(options.config);
  }

  readonly createResourceScope = (
    limits: ImageApiLimits,
    signal: AbortSignal,
    tenantId: string,
  ): Promise<ImageRequestResourceScope> => ImageRequestResourceScope.create({
    limits,
    signal,
    tempRoot: this.#paths.paths.temporaryRoot,
    tenantId,
    sharedBudget: this.budget,
    ownedDirectoryMarker: true,
    ...(this.#activeScopes
      ? { onDirectoryActive: (directory: string) => this.#activeScopes!.register(directory) }
      : {}),
  });
}
