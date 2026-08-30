import type {
  ImageApiAuditRecord,
  ImageTelemetryRecord,
} from '@omnicross/core/image-generation';
import { describe, expect, it } from 'vitest';

import { ImageObservability } from '../ImageObservability';

function apiRecord(overrides: Partial<ImageApiAuditRecord> = {}): ImageApiAuditRecord {
  return {
    requestId: 'request-canary',
    operationId: 'images.edit',
    providerId: 'codex-subscription',
    model: 'gpt-image-2',
    options: {
      n: 1,
      quality: 'low',
      background: 'auto',
      outputFormat: 'png',
      stream: false,
      partialImages: 0,
    },
    inputCount: 1,
    inputBytes: 1_024,
    terminal: 'completed',
    ...overrides,
  };
}

function telemetryRecord(overrides: Partial<ImageTelemetryRecord> = {}): ImageTelemetryRecord {
  return {
    requestId: 'execution-request-canary',
    providerId: 'codex-subscription',
    model: 'gpt-image-2',
    action: 'edit',
    quality: 'low',
    background: 'auto',
    outputFormat: 'png',
    streaming: false,
    inputCount: 1,
    inputBytes: 1_024,
    requestedOutputCount: 1,
    outputs: [{
      mimeType: 'image/png',
      byteLength: 2_048,
      width: 32,
      height: 32,
    }],
    startedAt: 100,
    acceptedAt: 130,
    firstPartialAt: 150,
    generationStartedAt: 120,
    finishedAt: 200,
    queueWaitMs: 20,
    retryCount: 1,
    authRefreshCount: 1,
    referenceSaveCount: 1,
    retentionRollbackFailures: 0,
    terminal: 'completed',
    usageUnavailable: true,
    ...overrides,
  };
}

describe('ImageObservability', () => {
  it('aggregates safe API, latency, byte, reference, cleanup, retry, and refresh metadata', () => {
    const observability = new ImageObservability();
    observability.audit(apiRecord({
      referenceOutcomes: { hits: 1, notFound: 0, expired: 0, failed: 0 },
      cleanupOutcome: 'completed',
    }));
    observability.audit(apiRecord({
      requestId: 'different-request-canary',
      cleanupOutcome: 'failed',
    }));
    observability.telemetrySink.record(telemetryRecord());
    observability.telemetrySink.record(telemetryRecord({
      requestId: 'different-execution-canary',
      startedAt: 1_000,
      firstPartialAt: undefined,
      generationStartedAt: 1_050,
      finishedAt: 1_200,
      queueWaitMs: undefined,
      retryCount: undefined,
      authRefreshCount: undefined,
      referenceSaveCount: undefined,
      retentionRollbackFailures: undefined,
    }));

    const snapshot = observability.snapshot();
    expect(snapshot.apiRequests).toHaveLength(1);
    expect(snapshot.apiRequests[0]).toMatchObject({
      requests: 2,
      referenceOutcomes: { hits: 1, notFound: 0, expired: 0, failed: 0 },
      cleanupOutcomes: { completed: 1, failed: 1 },
    });
    expect(snapshot.apiRequests[0]?.inputCount?.count).toBe(2);
    expect(snapshot.apiRequests[0]?.inputBytes?.sum).toBe(2_048);

    expect(snapshot.executions).toHaveLength(1);
    const execution = snapshot.executions[0]!;
    expect(execution.executions).toBe(2);
    expect(execution.finalLatencyMs).toMatchObject({ count: 2, sum: 300 });
    expect(execution.queueWaitMs).toMatchObject({ count: 1, sum: 20 });
    expect(execution.generationDurationMs).toMatchObject({ count: 2, sum: 230 });
    expect(execution.firstPartialLatencyMs).toMatchObject({ count: 1, sum: 50 });
    expect(execution.inputCount).toMatchObject({ count: 2, sum: 2 });
    expect(execution.inputBytes).toMatchObject({ count: 2, sum: 2_048 });
    expect(execution.outputCount).toMatchObject({ count: 2, sum: 2 });
    expect(execution.outputBytes).toMatchObject({ count: 2, sum: 4_096 });
    expect(execution.retryCount).toMatchObject({ count: 1, sum: 1 });
    expect(execution.authRefreshCount).toMatchObject({ count: 1, sum: 1 });
    expect(execution.referenceSaveCount).toMatchObject({ count: 1, sum: 1 });
    expect(execution.retentionRollbackFailures).toMatchObject({ count: 1, sum: 0 });
  });

  it('drops high-cardinality and content-bearing fields and folds identifiers to bounded labels', () => {
    const observability = new ImageObservability();
    const canaries = [
      'TENANT-ID-CANARY',
      'ACCOUNT-ID-CANARY',
      'PROMPT-CANARY',
      'URL-QUERY-CANARY',
      'PROVIDER-REFERENCE-CANARY',
      'REQUEST-ID-CANARY',
      'UNLISTED-PROVIDER-CANARY',
      'UNLISTED-MODEL-CANARY',
    ];
    observability.recordTelemetry({
      ...telemetryRecord({
        requestId: canaries[5],
        providerId: canaries[6],
        model: canaries[7],
      }),
      tenantId: canaries[0],
      accountId: canaries[1],
      prompt: canaries[2],
      url: `https://example.invalid/?${canaries[3]}`,
      providerReference: canaries[4],
      usage: undefined,
      cost: undefined,
    } as ImageTelemetryRecord);

    const snapshot = observability.snapshot();
    expect(snapshot.executions[0]?.dimensions).toMatchObject({
      provider: 'other',
      model: 'other',
    });
    const serialized = JSON.stringify(snapshot);
    for (const canary of canaries) expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('requestId');
    expect(serialized).not.toContain('usage');
    expect(serialized).not.toContain('cost');
  });

  it('records only allow-listed configuration categories after a committed update', () => {
    const observability = new ImageObservability();
    observability.recordConfigurationAudit({
      outcome: 'applied',
      fields: ['account', 'storage', 'SECRET_FIELD_CANARY'],
      previousGenerationId: 'RAW_ACCOUNT_ID_CANARY',
      generationId: 'image-runtime-2',
      accountId: 'RAW_ACCOUNT_ID_CANARY',
      storageRoot: 'PRIVATE_PATH_CANARY',
      prompt: 'PROMPT_CANARY',
    } as never);

    expect(observability.snapshot().configurationChanges).toEqual([{
      outcome: 'applied',
      fields: ['account', 'storage'],
      generationId: 'image-runtime-2',
    }]);
    const serialized = JSON.stringify(observability.snapshot());
    expect(serialized).not.toContain('RAW_ACCOUNT_ID_CANARY');
    expect(serialized).not.toContain('PRIVATE_PATH_CANARY');
    expect(serialized).not.toContain('PROMPT_CANARY');
    expect(serialized).not.toContain('SECRET_FIELD_CANARY');
  });

  it('caps dimension sets, counts overflow, and resets without retaining prior labels', () => {
    const observability = new ImageObservability({ maxDimensionSets: 1 });
    observability.recordApiAudit(apiRecord());
    observability.recordApiAudit(apiRecord({ terminal: 'failed', errorCode: 'image_queue_full' }));
    observability.recordTelemetry(telemetryRecord());
    observability.recordTelemetry(telemetryRecord({ terminal: 'failed', errorCode: 'image_queue_full' }));

    expect(observability.snapshot()).toMatchObject({
      overflow: { apiRecords: 1, telemetryRecords: 1 },
    });
    expect(observability.snapshot().apiRequests).toHaveLength(1);
    expect(observability.snapshot().executions).toHaveLength(1);

    observability.reset();
    expect(observability.snapshot()).toEqual({
      apiRequests: [],
      executions: [],
      configurationChanges: [],
      overflow: { apiRecords: 0, telemetryRecords: 0 },
    });
  });
});
