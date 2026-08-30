import type { ImageGenerationErrorCode } from '@omnicross/contracts/image-generation-types';
import {
  normalizeImageGenerationError,
} from '@omnicross/core/image-generation';
import {
  validateImagesServerConfig,
  validateOutboundPermissions,
  type ImagesServerConfig,
  type OutboundKeyDb,
} from '@omnicross/core/outbound-api';
import {
  createCodexImageLiveVerifier,
  type CodexImageCapabilityObservation,
  type CodexImageLiveVerifier,
  type SubscriptionAccountService,
} from '@omnicross/subscriptions';

import {
  FileCodexImageCapabilityEvidenceSource,
  type FileCodexImageCapabilityEvidenceStatus,
} from './FileCodexImageCapabilityEvidenceSource';
import type { ImageStorageMountCatalog } from './ImageStorageMountCatalog';
import type {
  DaemonImagePathArea,
  DaemonImagePathResolver,
} from './imagePathResolver';

const ROOT_AREAS: readonly DaemonImagePathArea[] = Object.freeze([
  'temporary',
  'artifacts',
  'state',
  'evidence',
  'mountManifest',
]);

export interface ImageDoctorLocalSnapshot {
  readonly config: Readonly<{
    enabled: boolean;
    provider: 'codex-subscription';
    model: string;
    valid: boolean;
    errorCount: number;
  }>;
  readonly roots: Readonly<{
    valid: boolean;
    verifiedAreas: number;
    expectedAreas: number;
  }>;
  readonly stores: Readonly<{
    valid: boolean;
    mounts: number;
    retiredMounts: number;
    referenceEntries: number;
    referenceBytes: number;
    stateCalls: number;
    stateResponses: number;
    corruptManifestsQuarantined: number;
  }>;
  readonly permissions: Readonly<{
    valid: boolean;
    rows: number;
    legacyRows: number;
    invalidRows: number;
    imagesAuthorizedRows: number;
  }>;
  readonly account: Readonly<{
    present: boolean;
    usable: boolean;
    reason: 'ready' | 'missing' | 'unavailable';
  }>;
  readonly evidence: Readonly<FileCodexImageCapabilityEvidenceStatus & { valid: boolean }>;
}

export type ImageDoctorLiveFailureCode =
  | 'images_disabled'
  | 'codex_account_unavailable'
  | 'evidence_store_unavailable'
  | 'evidence_persist_failed'
  | ImageGenerationErrorCode;

export type ImageDoctorLiveResult =
  | Readonly<{
      ok: true;
      code: 'verified';
      model: 'gpt-image-2';
      quality: 'low';
      outputFormat: 'png';
      freshEvidenceEntries: number;
    }>
  | Readonly<{
      ok: false;
      code: ImageDoctorLiveFailureCode;
    }>;

interface ImageDoctorEvidenceStore {
  status(): FileCodexImageCapabilityEvidenceStatus;
  recordSuccessfulVerification(observation: CodexImageCapabilityObservation): Promise<void>;
  dispose?(): void;
}

export interface ImageDoctorServiceOptions {
  readonly keyDb: Pick<OutboundKeyDb, 'outboundApiKeysList'>;
  readonly subscriptionAccounts: Pick<SubscriptionAccountService, 'getStrategy' | 'listAll'>;
  readonly storageCatalog: Pick<
    ImageStorageMountCatalog,
    'active' | 'status' | 'utilization' | 'startupReconciliationStatus'
  >;
  readonly createEvidenceStore?: (
    paths: DaemonImagePathResolver,
    config: ImagesServerConfig,
  ) => ImageDoctorEvidenceStore;
  readonly createLiveVerifier?: (
    strategy: NonNullable<ReturnType<SubscriptionAccountService['getStrategy']>>,
    config: ImagesServerConfig,
  ) => CodexImageLiveVerifier;
}

export interface ImageDoctorService {
  inspectLocal(config: ImagesServerConfig): Promise<ImageDoctorLocalSnapshot>;
  verifyLive(config: ImagesServerConfig, signal: AbortSignal): Promise<ImageDoctorLiveResult>;
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Local-only diagnostics plus the one explicitly consuming live-verification entry point. */
export function createImageDoctorService(options: ImageDoctorServiceOptions): ImageDoctorService {
  const createEvidenceStore = options.createEvidenceStore ?? ((paths, config) =>
    new FileCodexImageCapabilityEvidenceSource({
      paths,
      ttlMs: config.evidenceTtlMs,
    }));
  const createLiveVerifier = options.createLiveVerifier ?? ((strategy, config) =>
    createCodexImageLiveVerifier({
      authStrategy: strategy,
      generationTimeoutMs: config.queue.generationTimeoutMs,
    }));

  const readAccount = async () => {
    const codex = (await options.subscriptionAccounts.listAll())
      .find((entry) => entry.providerId === 'codex');
    return Object.freeze({
      present: codex !== undefined,
      usable: codex?.credentialStatus.ok === true,
      reason: codex === undefined
        ? 'missing' as const
        : codex.credentialStatus.ok
          ? 'ready' as const
          : 'unavailable' as const,
    });
  };

  const activePaths = (): DaemonImagePathResolver => options.storageCatalog.active().resolver;

  return Object.freeze({
    inspectLocal: async (config: ImagesServerConfig): Promise<ImageDoctorLocalSnapshot> => {
      const configErrors = validateImagesServerConfig(config);
      let verifiedAreas = 0;
      try {
        const paths = activePaths();
        for (const area of ROOT_AREAS) {
          paths.verifiedRoot(area);
          verifiedAreas += 1;
        }
      } catch {
        // Report only aggregate root health; never serialize a machine path.
      }

      let storesValid = true;
      let mounts = 0;
      let retiredMounts = 0;
      let referenceEntries = 0;
      let referenceBytes = 0;
      let stateCalls = 0;
      let stateResponses = 0;
      let corruptManifestsQuarantined = 0;
      try {
        const catalog = options.storageCatalog.status();
        const utilization = options.storageCatalog.utilization();
        const reconciliation = options.storageCatalog.startupReconciliationStatus();
        mounts = safeCount(catalog.mounts);
        retiredMounts = safeCount(catalog.retiredMounts);
        referenceEntries = safeCount(utilization.referenceEntries);
        referenceBytes = safeCount(utilization.referenceBytes);
        stateCalls = safeCount(utilization.stateCalls);
        stateResponses = safeCount(utilization.stateResponses);
        corruptManifestsQuarantined = safeCount(reconciliation.corruptManifestsQuarantined);
      } catch {
        storesValid = false;
      }

      const rows = await options.keyDb.outboundApiKeysList();
      let legacyRows = 0;
      let invalidRows = 0;
      let imagesAuthorizedRows = 0;
      for (const row of rows) {
        if (row.allowedEndpoints === undefined) {
          legacyRows += 1;
          continue;
        }
        try {
          const permissions = validateOutboundPermissions(row.allowedEndpoints);
          if (permissions.includes('images')) imagesAuthorizedRows += 1;
        } catch {
          invalidRows += 1;
        }
      }

      const account = await readAccount();
      let evidence: FileCodexImageCapabilityEvidenceStatus & { valid: boolean };
      let evidenceStore: ImageDoctorEvidenceStore | undefined;
      try {
        evidenceStore = createEvidenceStore(activePaths(), config);
        evidence = { ...evidenceStore.status(), valid: true };
      } catch {
        evidence = { entries: 0, freshEntries: 0, staleEntries: 0, bytes: 0, valid: false };
      } finally {
        evidenceStore?.dispose?.();
      }

      return Object.freeze({
        config: Object.freeze({
          enabled: config.enabled,
          provider: config.provider,
          model: config.defaultModel,
          valid: configErrors.length === 0,
          errorCount: configErrors.length,
        }),
        roots: Object.freeze({
          valid: verifiedAreas === ROOT_AREAS.length,
          verifiedAreas,
          expectedAreas: ROOT_AREAS.length,
        }),
        stores: Object.freeze({
          valid: storesValid,
          mounts,
          retiredMounts,
          referenceEntries,
          referenceBytes,
          stateCalls,
          stateResponses,
          corruptManifestsQuarantined,
        }),
        permissions: Object.freeze({
          valid: invalidRows === 0,
          rows: rows.length,
          legacyRows,
          invalidRows,
          imagesAuthorizedRows,
        }),
        account,
        evidence: Object.freeze(evidence),
      });
    },

    verifyLive: async (
      config: ImagesServerConfig,
      signal: AbortSignal,
    ): Promise<ImageDoctorLiveResult> => {
      if (!config.enabled) return Object.freeze({ ok: false, code: 'images_disabled' });
      const account = await readAccount();
      if (!account.usable) {
        return Object.freeze({ ok: false, code: 'codex_account_unavailable' });
      }
      const strategy = options.subscriptionAccounts.getStrategy('codex');
      if (!strategy || strategy.providerId !== 'codex') {
        return Object.freeze({ ok: false, code: 'codex_account_unavailable' });
      }

      let evidence: ImageDoctorEvidenceStore;
      try {
        evidence = createEvidenceStore(activePaths(), config);
      } catch {
        return Object.freeze({ ok: false, code: 'evidence_store_unavailable' });
      }

      try {
        let observation: CodexImageCapabilityObservation;
        try {
          observation = await createLiveVerifier(strategy, config).verify({
            signal,
            sessionKey: 'doctor:images:live',
            ...(config.account.id ? { preferredAccountId: config.account.id } : {}),
            ...(config.account.group ? { preferredAccountGroup: config.account.group } : {}),
            boundAccountFallbackPolicy: config.account.fallback,
          });
        } catch (error) {
          const normalized = normalizeImageGenerationError(error);
          return Object.freeze({ ok: false, code: normalized.code });
        }

        try {
          await evidence.recordSuccessfulVerification(observation);
        } catch {
          return Object.freeze({ ok: false, code: 'evidence_persist_failed' });
        }
        const status = evidence.status();
        return Object.freeze({
          ok: true,
          code: 'verified',
          model: 'gpt-image-2',
          quality: 'low',
          outputFormat: 'png',
          freshEvidenceEntries: safeCount(status.freshEntries),
        });
      } finally {
        evidence.dispose?.();
      }
    },
  });
}
