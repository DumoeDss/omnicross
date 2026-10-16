import { randomUUID } from 'node:crypto';
import type { ImageReferenceId } from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError } from './errors';
import type { ImageReferenceMetadata } from '@omnicross/contracts/image-generation-types';
import type { ImageReferenceResolution, ImageReferenceSaveInput, ImageReferenceStore } from './ports';

interface Entry {
  readonly input: ImageReferenceSaveInput;
  readonly metadata: ImageReferenceMetadata;
  leases: number;
  deleted: boolean;
}

/** Session-local retention with finite entry/byte budgets and pinned lease accounting. */
export class BoundedMemoryImageReferenceStore implements ImageReferenceStore {
  readonly #entries = new Map<ImageReferenceId, Entry>();
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  #bytes = 0;
  constructor(options: { maxBytes?: number; maxEntries?: number; now?: () => number } = {}) {
    this.#maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.#maxEntries = options.maxEntries ?? 256;
    this.#now = options.now ?? Date.now;
    if ([this.#maxBytes, this.#maxEntries].some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Invalid image retention budget');
  }
  async save(input: ImageReferenceSaveInput): Promise<ImageReferenceMetadata> {
    await this.cleanup();
    if (!input.artifact || input.artifact.byteLength !== input.metadata.byteLength ||
      !input.tenantId || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new ImageGenerationError('invalid_image_request');
    if (this.#entries.size >= this.#maxEntries || this.#bytes + input.artifact.byteLength > this.#maxBytes) {
      throw new ImageGenerationError('image_too_large');
    }
    const now = this.#now();
    const metadata = Object.freeze({ ...input.metadata, referenceId: randomUUID() as ImageReferenceId,
      createdAt: now, expiresAt: now + input.ttlMs });
    this.#entries.set(metadata.referenceId, { input, metadata, leases: 0, deleted: false });
    this.#bytes += metadata.byteLength;
    return metadata;
  }
  async resolve(tenantId: string, referenceId: ImageReferenceId): Promise<ImageReferenceResolution> {
    const entry = this.#entries.get(referenceId);
    if (!entry || entry.deleted || entry.input.tenantId !== tenantId) return { status: 'not_found' };
    if (entry.metadata.expiresAt <= this.#now()) return { status: 'expired' };
    entry.leases++;
    let released = false;
    return { status: 'found', lease: { metadata: entry.metadata,
      value: { artifact: entry.input.artifact, providerReference: entry.input.providerReference },
      release: async () => {
        if (released) return;
        released = true; entry.leases--;
        if (entry.deleted && entry.leases === 0) this.#remove(referenceId, entry);
      },
    } };
  }
  async delete(tenantId: string, referenceId: ImageReferenceId): Promise<boolean> {
    const entry = this.#entries.get(referenceId);
    if (!entry || entry.deleted || entry.input.tenantId !== tenantId) return false;
    entry.deleted = true;
    if (entry.leases === 0) this.#remove(referenceId, entry);
    return true;
  }
  async cleanup(now = this.#now()): Promise<number> {
    let removed = 0;
    for (const [id, entry] of this.#entries) if (entry.leases === 0 && (entry.deleted || entry.metadata.expiresAt <= now)) {
      this.#remove(id, entry); removed++;
    }
    return removed;
  }
  clear(): void {
    for (const [id, entry] of this.#entries) {
      entry.deleted = true;
      if (entry.leases === 0) this.#remove(id, entry);
    }
  }
  #remove(id: ImageReferenceId, entry: Entry): void {
    if (this.#entries.delete(id)) this.#bytes -= entry.metadata.byteLength;
  }
}
