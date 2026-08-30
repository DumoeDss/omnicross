import { describe, expect, it, vi } from 'vitest';

import { ImageGenerationError } from '@omnicross/core/image-generation';
import {
  DEFAULT_IMAGES_SERVER_CONFIG,
  type ImagesServerConfig,
} from '@omnicross/core/outbound-api';

import { createImageDoctorService } from '../ImageDoctorService';

function images(enabled: boolean): ImagesServerConfig {
  return {
    ...DEFAULT_IMAGES_SERVER_CONFIG,
    enabled,
    modelAliases: { ...DEFAULT_IMAGES_SERVER_CONFIG.modelAliases },
    account: { ...DEFAULT_IMAGES_SERVER_CONFIG.account },
    queue: { ...DEFAULT_IMAGES_SERVER_CONFIG.queue },
    temporary: { ...DEFAULT_IMAGES_SERVER_CONFIG.temporary },
    limits: { ...DEFAULT_IMAGES_SERVER_CONFIG.limits },
    references: { ...DEFAULT_IMAGES_SERVER_CONFIG.references },
    remote: { ...DEFAULT_IMAGES_SERVER_CONFIG.remote },
  };
}

function harness(options: {
  readonly accountOk?: boolean;
  readonly rows?: readonly unknown[];
  readonly verify?: ReturnType<typeof vi.fn>;
  readonly record?: ReturnType<typeof vi.fn>;
  readonly dispose?: ReturnType<typeof vi.fn>;
  readonly evidenceStatus?: {
    entries: number;
    freshEntries: number;
    staleEntries: number;
    bytes: number;
  };
} = {}) {
  const verify = options.verify ?? vi.fn();
  const record = options.record ?? vi.fn(async () => undefined);
  const dispose = options.dispose ?? vi.fn();
  const verifiedRoot = vi.fn(() => 'PRIVATE_PATH_SENTINEL');
  const service = createImageDoctorService({
    keyDb: {
      outboundApiKeysList: async () => (options.rows ?? []) as never,
    },
    subscriptionAccounts: {
      listAll: async () => [{
        providerId: 'codex',
        displayName: 'Codex',
        kind: 'oauth-bearer',
        credentialStatus: {
          providerId: 'codex',
          ok: options.accountOk !== false,
          ...(options.accountOk === false ? { reason: 'missing-credential' as const } : {}),
        },
      }],
      getStrategy: () => ({ providerId: 'codex' }) as never,
    },
    storageCatalog: {
      active: () => ({ resolver: { verifiedRoot } }) as never,
      status: () => ({ mounts: 1, retiredMounts: 0 }),
      utilization: () => ({
        referenceEntries: 2,
        referenceBytes: 128,
        referenceTombstones: 0,
        stateCalls: 3,
        stateResponses: 1,
        stateTombstones: 0,
        pendingReferenceDeletes: 0,
      }),
      startupReconciliationStatus: () => ({ corruptManifestsQuarantined: 0 }),
    },
    createEvidenceStore: () => ({
      status: () => options.evidenceStatus ?? {
        entries: 1,
        freshEntries: 1,
        staleEntries: 0,
        bytes: 64,
      },
      recordSuccessfulVerification: record,
      dispose,
    }),
    createLiveVerifier: () => ({ verify }),
  });
  return { service, verify, record, dispose, verifiedRoot };
}

describe('ImageDoctorService', () => {
  it('reads only local aggregate config/root/store/key/account/evidence metadata', async () => {
    const { service, verify, dispose, verifiedRoot } = harness({
      rows: [
        { id: 'legacy' },
        { id: 'images', allowedEndpoints: ['responses', 'images'] },
        { id: 'malformed', allowedEndpoints: ['images', 'images'] },
      ],
    });
    const snapshot = await service.inspectLocal(images(false));

    expect(snapshot).toMatchObject({
      config: { enabled: false, valid: true, provider: 'codex-subscription' },
      roots: { valid: true, verifiedAreas: 5, expectedAreas: 5 },
      stores: {
        valid: true,
        mounts: 1,
        referenceEntries: 2,
        referenceBytes: 128,
        stateCalls: 3,
      },
      permissions: {
        valid: false,
        rows: 3,
        legacyRows: 1,
        invalidRows: 1,
        imagesAuthorizedRows: 1,
      },
      account: { present: true, usable: true, reason: 'ready' },
      evidence: { valid: true, entries: 1, freshEntries: 1 },
    });
    expect(verifiedRoot).toHaveBeenCalledTimes(5);
    expect(verify).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_PATH_SENTINEL');
  });

  it('performs exactly one live verification and persists only after strict success', async () => {
    const observation = {
      accountId: 'RAW_ACCOUNT_SENTINEL',
      model: 'gpt-image-2' as const,
      request: {
        action: 'generate' as const,
        n: 1 as const,
        quality: 'low' as const,
        size: 'auto',
        background: 'opaque' as const,
        outputFormat: 'png' as const,
        moderation: 'auto' as const,
        stream: false as const,
        partialImages: 0 as const,
      },
    };
    const verify = vi.fn(async () => observation);
    const record = vi.fn(async () => undefined);
    const { service, dispose } = harness({ verify, record });

    const poolConfig = {
      ...images(true),
      account: { id: 'preferred-account', fallback: 'pool' as const },
    };
    const result = await service.verifyLive(poolConfig, new AbortController().signal);
    expect(result).toEqual({
      ok: true,
      code: 'verified',
      model: 'gpt-image-2',
      quality: 'low',
      outputFormat: 'png',
      freshEvidenceEntries: 1,
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      preferredAccountId: 'preferred-account',
      boundAccountFallbackPolicy: 'pool',
    }));
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(observation);
    expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('RAW_ACCOUNT_SENTINEL');
  });

  it('does not create positive evidence on verifier failure and returns only a stable code', async () => {
    const verify = vi.fn(async () => {
      throw new ImageGenerationError('upstream_protocol_changed', {
        cause: new Error('PROMPT_AND_RESPONSE_SENTINEL'),
      });
    });
    const record = vi.fn(async () => undefined);
    const { service, dispose } = harness({ verify, record });

    const result = await service.verifyLive(images(true), new AbortController().signal);
    expect(result).toEqual({ ok: false, code: 'upstream_protocol_changed' });
    expect(verify).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('PROMPT_AND_RESPONSE_SENTINEL');
  });

  it('reports evidence persistence failure after one verified call without claiming success', async () => {
    const verify = vi.fn(async () => ({
      accountId: 'RAW_ACCOUNT_SENTINEL',
      model: 'gpt-image-2' as const,
      request: {
        action: 'generate' as const,
        n: 1 as const,
        quality: 'low' as const,
        size: 'auto',
        background: 'opaque' as const,
        outputFormat: 'png' as const,
        moderation: 'auto' as const,
        stream: false as const,
        partialImages: 0 as const,
      },
    }));
    const record = vi.fn(async () => {
      throw new Error('PERSISTENCE_PATH_SENTINEL');
    });
    const { service, dispose } = harness({ verify, record });
    const result = await service.verifyLive(images(true), new AbortController().signal);
    expect(result).toEqual({ ok: false, code: 'evidence_persist_failed' });
    expect(verify).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('PERSISTENCE_PATH_SENTINEL');
  });

  it('enforces enablement and account preconditions before creating a verifier', async () => {
    const disabled = harness();
    expect(await disabled.service.verifyLive(images(false), new AbortController().signal))
      .toEqual({ ok: false, code: 'images_disabled' });
    expect(disabled.verify).not.toHaveBeenCalled();

    const unavailable = harness({ accountOk: false });
    expect(await unavailable.service.verifyLive(images(true), new AbortController().signal))
      .toEqual({ ok: false, code: 'codex_account_unavailable' });
    expect(unavailable.verify).not.toHaveBeenCalled();
  });
});
