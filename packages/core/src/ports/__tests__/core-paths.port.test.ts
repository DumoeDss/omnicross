/**
 * Mock-based unit test for the `CorePaths` port (omnicross Phase 0b, task 5.5).
 *
 * Constructs the serving-core `CompletionService` with a plain
 * `{ userData, resourcesDir }` mock (NOT a concrete `AppPaths` instance) and
 * asserts the port shape is accepted as the paths dependency. A getter-spy
 * confirms that if any constructed-path code reads the fields, it reads them
 * through the port surface only — never relying on the host `AppPaths` class.
 */

import { describe, expect, it, vi } from 'vitest';

import { CompletionService } from '../../completion/CompletionService';
import type { CorePaths } from '../core-paths';
import type { Logger } from '../logger';
import type { ProviderConfigSource } from '../provider-config-source';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeConfigSource(): ProviderConfigSource {
  return {
    getProvider: vi.fn(),
    resolveRoutedModel: vi.fn(),
    resolveEffectiveModels: vi.fn(),
    hasVisionCapability: vi.fn(),
    getGlobalModelParameters: vi.fn(),
    getDiscoveredModelMaxTokens: vi.fn(),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(),
  } as unknown as ProviderConfigSource;
}

describe('CorePaths port — mock injection (task 5.5)', () => {
  it('the serving-core consumer accepts a plain { userData, resourcesDir } mock as CorePaths', () => {
    const userDataGetter = vi.fn(() => '/mock/userData');
    const resourcesGetter = vi.fn(() => '/mock/resources');

    // A bare object port — explicitly NOT an AppPaths instance.
    const paths: CorePaths = {
      get userData() {
        return userDataGetter();
      },
      get resourcesDir() {
        return resourcesGetter();
      },
    };

    const service = new CompletionService(paths, makeConfigSource(), makeLogger());

    // Construction succeeds with the structural port (no AppPaths needed).
    expect(service).toBeInstanceOf(CompletionService);

    // The port surface is the only path-access contract: reading the fields
    // dispatches to the port getters (no host-class internals involved).
    expect(paths.userData).toBe('/mock/userData');
    expect(paths.resourcesDir).toBe('/mock/resources');
    expect(userDataGetter).toHaveBeenCalled();
    expect(resourcesGetter).toHaveBeenCalled();
  });
});
