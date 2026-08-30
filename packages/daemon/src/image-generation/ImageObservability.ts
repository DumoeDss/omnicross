import {
  IMAGE_GENERATION_ERROR_CODES,
  type ImageGenerationErrorCode,
} from '@omnicross/contracts/image-generation-types';
import type {
  ImageApiAuditRecord,
  ImageTelemetryRecord,
  ImageTelemetrySink,
} from '@omnicross/core/image-generation';

const MAX_DIMENSION_SETS = 256;
const MAX_CONFIGURATION_AUDIT_RECORDS = 128;
const MAX_OBSERVATION_COUNT = 1_000_000;
const ERROR_CODES = new Set<string>(IMAGE_GENERATION_ERROR_CODES);
const LATENCY_BUCKETS_MS = Object.freeze([
  1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
  30_000, 60_000, 120_000, 180_000, 300_000, 600_000,
]);
const BYTE_BUCKETS = Object.freeze([
  0, 1_024, 64 * 1_024, 1024 * 1_024, 8 * 1024 * 1_024,
  50 * 1024 * 1_024, 500 * 1024 * 1_024, 1024 * 1024 * 1_024,
]);
const COUNT_BUCKETS = Object.freeze([0, 1, 2, 4, 8, 16, 32, 64, 256, 1_024]);

type SafeProvider = 'codex-subscription' | 'unknown' | 'other';
type SafeModel = 'gpt-image-2' | 'unknown' | 'other';
type SafeErrorCode = ImageGenerationErrorCode | 'none' | 'other';
type SafeCountOption = 'unknown' | '0' | '1' | '2-4' | '5+';
type SafeBooleanOption = boolean | 'unknown';
type SafeQuality = 'auto' | 'low' | 'medium' | 'high' | 'unknown' | 'other';
type SafeBackground = 'auto' | 'opaque' | 'transparent' | 'unknown' | 'other';
type SafeOutputFormat = 'png' | 'jpeg' | 'webp' | 'unknown' | 'other';

export const IMAGE_CONFIGURATION_AUDIT_FIELDS = Object.freeze([
  'enablement',
  'provider',
  'model',
  'account',
  'queue',
  'temporary',
  'limits',
  'retention',
  'storage',
  'remote',
  'evidence',
] as const);

export type ImageConfigurationAuditField =
  typeof IMAGE_CONFIGURATION_AUDIT_FIELDS[number];

/** Values are deliberately limited to safe categories and internal generation ids. */
export interface ImageConfigurationAuditRecord {
  readonly outcome: 'applied';
  readonly fields: readonly ImageConfigurationAuditField[];
  readonly previousGenerationId?: string;
  readonly generationId?: string;
}

export interface ImageHistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  /** Non-cumulative fixed buckets; `upperBound:null` is the overflow bucket. */
  readonly buckets: readonly {
    readonly upperBound: number | null;
    readonly count: number;
  }[];
}

export interface ImageApiMetricDimensions {
  readonly endpoint: 'images.generate' | 'images.edit';
  readonly provider: SafeProvider;
  readonly model: SafeModel;
  readonly action: 'generate' | 'edit';
  readonly quality: SafeQuality;
  readonly background: SafeBackground;
  readonly outputFormat: SafeOutputFormat;
  readonly streaming: SafeBooleanOption;
  readonly requestedOutputs: SafeCountOption;
  readonly partialImages: SafeCountOption;
  readonly terminal: 'completed' | 'failed' | 'cancelled';
  readonly errorCode: SafeErrorCode;
}

export interface ImageExecutionMetricDimensions {
  readonly provider: SafeProvider;
  readonly model: SafeModel;
  readonly action: 'generate' | 'edit' | 'other';
  readonly quality: SafeQuality;
  readonly background: SafeBackground;
  readonly outputFormat: SafeOutputFormat;
  readonly streaming: SafeBooleanOption;
  readonly requestedOutputs: SafeCountOption;
  readonly terminal: 'completed' | 'failed' | 'cancelled' | 'other';
  readonly errorCode: SafeErrorCode;
}

export interface ImageApiMetricSnapshot {
  readonly dimensions: ImageApiMetricDimensions;
  readonly requests: number;
  readonly inputCount?: ImageHistogramSnapshot;
  readonly inputBytes?: ImageHistogramSnapshot;
  readonly referenceOutcomes: Readonly<{
    hits: number;
    notFound: number;
    expired: number;
    failed: number;
  }>;
  readonly cleanupOutcomes: Readonly<{ completed: number; failed: number }>;
}

export interface ImageExecutionMetricSnapshot {
  readonly dimensions: ImageExecutionMetricDimensions;
  readonly executions: number;
  readonly finalLatencyMs: ImageHistogramSnapshot;
  readonly queueWaitMs?: ImageHistogramSnapshot;
  readonly generationDurationMs?: ImageHistogramSnapshot;
  readonly firstPartialLatencyMs?: ImageHistogramSnapshot;
  readonly inputCount: ImageHistogramSnapshot;
  readonly inputBytes: ImageHistogramSnapshot;
  readonly outputCount: ImageHistogramSnapshot;
  readonly outputBytes: ImageHistogramSnapshot;
  readonly retryCount?: ImageHistogramSnapshot;
  readonly authRefreshCount?: ImageHistogramSnapshot;
  readonly referenceSaveCount?: ImageHistogramSnapshot;
  readonly retentionRollbackFailures?: ImageHistogramSnapshot;
}

export interface ImageObservabilitySnapshot {
  readonly apiRequests: readonly ImageApiMetricSnapshot[];
  readonly executions: readonly ImageExecutionMetricSnapshot[];
  readonly configurationChanges: readonly ImageConfigurationAuditRecord[];
  readonly overflow: Readonly<{ apiRecords: number; telemetryRecords: number }>;
}

export interface ImageObservabilityOptions {
  /** Hard cap applied independently to API and execution dimension maps. */
  readonly maxDimensionSets?: number;
}

function saturatingAdd(left: number, right: number): number {
  if (!Number.isFinite(right) || right <= 0) return left;
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function observationCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(MAX_OBSERVATION_COUNT, value)
    : 0;
}

class BoundedHistogram {
  readonly #bounds: readonly number[];
  readonly #counts: number[];
  #count = 0;
  #sum = 0;

  constructor(bounds: readonly number[]) {
    this.#bounds = bounds;
    this.#counts = Array.from({ length: bounds.length + 1 }, () => 0);
  }

  observe(value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
    const normalized = Math.min(Number.MAX_SAFE_INTEGER, value);
    const bucket = this.#bounds.findIndex((bound) => normalized <= bound);
    const index = bucket < 0 ? this.#bounds.length : bucket;
    this.#counts[index] = saturatingAdd(this.#counts[index]!, 1);
    this.#count = saturatingAdd(this.#count, 1);
    this.#sum = saturatingAdd(this.#sum, normalized);
  }

  snapshot(): ImageHistogramSnapshot {
    return Object.freeze({
      count: this.#count,
      sum: this.#sum,
      buckets: Object.freeze(this.#counts.map((count, index) => Object.freeze({
        upperBound: index < this.#bounds.length ? this.#bounds[index]! : null,
        count,
      }))),
    });
  }
}

function optionalHistogram(value: BoundedHistogram): ImageHistogramSnapshot | undefined {
  const snapshot = value.snapshot();
  return snapshot.count > 0 ? snapshot : undefined;
}

function safeProvider(value: unknown): SafeProvider {
  if (value === undefined) return 'unknown';
  return value === 'codex-subscription' ? value : 'other';
}

function safeModel(value: unknown): SafeModel {
  if (value === undefined) return 'unknown';
  return value === 'gpt-image-2' ? value : 'other';
}

function safeErrorCode(value: unknown): SafeErrorCode {
  if (value === undefined) return 'none';
  return typeof value === 'string' && ERROR_CODES.has(value)
    ? value as ImageGenerationErrorCode
    : 'other';
}

function countOption(value: unknown): SafeCountOption {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'unknown';
  if (value === 0) return '0';
  if (value === 1) return '1';
  if (value <= 4) return '2-4';
  return '5+';
}

function booleanOption(value: unknown): SafeBooleanOption {
  return typeof value === 'boolean' ? value : 'unknown';
}

function enumOption<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | 'unknown' | 'other' {
  if (value === undefined) return 'unknown';
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : 'other';
}

function nonnegativeDelta(end: unknown, start: unknown): number | undefined {
  if (
    typeof end !== 'number' || !Number.isFinite(end) ||
    typeof start !== 'number' || !Number.isFinite(start) || end < start
  ) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, end - start);
}

function sumOutputBytes(record: ImageTelemetryRecord): number {
  let total = 0;
  for (const output of Array.isArray(record.outputs) ? record.outputs : []) {
    total = saturatingAdd(total, observationCount(output?.byteLength));
  }
  return total;
}

function keyOf(value: object): string {
  return JSON.stringify(value);
}

function safeGenerationId(value: unknown): string | undefined {
  return typeof value === 'string' && /^image-runtime-\d+$/.test(value)
    ? value
    : undefined;
}

interface MutableApiMetric {
  readonly dimensions: ImageApiMetricDimensions;
  requests: number;
  readonly inputCount: BoundedHistogram;
  readonly inputBytes: BoundedHistogram;
  readonly referenceOutcomes: { hits: number; notFound: number; expired: number; failed: number };
  readonly cleanupOutcomes: { completed: number; failed: number };
}

interface MutableExecutionMetric {
  readonly dimensions: ImageExecutionMetricDimensions;
  executions: number;
  readonly finalLatencyMs: BoundedHistogram;
  readonly queueWaitMs: BoundedHistogram;
  readonly generationDurationMs: BoundedHistogram;
  readonly firstPartialLatencyMs: BoundedHistogram;
  readonly inputCount: BoundedHistogram;
  readonly inputBytes: BoundedHistogram;
  readonly outputCount: BoundedHistogram;
  readonly outputBytes: BoundedHistogram;
  readonly retryCount: BoundedHistogram;
  readonly authRefreshCount: BoundedHistogram;
  readonly referenceSaveCount: BoundedHistogram;
  readonly retentionRollbackFailures: BoundedHistogram;
}

/** Process-local, metadata-only aggregation for HTTP and hosted Images work. */
export class ImageObservability {
  readonly telemetrySink: ImageTelemetrySink;
  readonly audit: (record: ImageApiAuditRecord) => void;
  readonly #maxDimensionSets: number;
  readonly #api = new Map<string, MutableApiMetric>();
  readonly #executions = new Map<string, MutableExecutionMetric>();
  readonly #configurationChanges: ImageConfigurationAuditRecord[] = [];
  #apiOverflow = 0;
  #telemetryOverflow = 0;

  constructor(options: ImageObservabilityOptions = {}) {
    const maxDimensionSets = options.maxDimensionSets ?? MAX_DIMENSION_SETS;
    if (!Number.isSafeInteger(maxDimensionSets) || maxDimensionSets <= 0 || maxDimensionSets > 1_024) {
      throw new RangeError('image observability dimension-set bound is invalid');
    }
    this.#maxDimensionSets = maxDimensionSets;
    this.telemetrySink = Object.freeze({
      record: (record: ImageTelemetryRecord) => this.recordTelemetry(record),
    });
    this.audit = (record) => this.recordApiAudit(record);
  }

  recordApiAudit(record: ImageApiAuditRecord): void {
    const endpoint = record.operationId === 'images.edit' ? 'images.edit' : 'images.generate';
    const dimensions: ImageApiMetricDimensions = Object.freeze({
      endpoint,
      provider: safeProvider(record.providerId),
      model: safeModel(record.model),
      action: endpoint === 'images.edit' ? 'edit' : 'generate',
      quality: enumOption(record.options?.quality, ['auto', 'low', 'medium', 'high'] as const),
      background: enumOption(record.options?.background, ['auto', 'opaque', 'transparent'] as const),
      outputFormat: enumOption(record.options?.outputFormat, ['png', 'jpeg', 'webp'] as const),
      streaming: booleanOption(record.options?.stream),
      requestedOutputs: countOption(record.options?.n),
      partialImages: countOption(record.options?.partialImages),
      terminal: record.terminal === 'completed' || record.terminal === 'cancelled'
        ? record.terminal
        : 'failed',
      errorCode: safeErrorCode(record.errorCode),
    });
    const key = keyOf(dimensions);
    let metric = this.#api.get(key);
    if (!metric) {
      if (this.#api.size >= this.#maxDimensionSets) {
        this.#apiOverflow = saturatingAdd(this.#apiOverflow, 1);
        return;
      }
      metric = {
        dimensions,
        requests: 0,
        inputCount: new BoundedHistogram(COUNT_BUCKETS),
        inputBytes: new BoundedHistogram(BYTE_BUCKETS),
        referenceOutcomes: { hits: 0, notFound: 0, expired: 0, failed: 0 },
        cleanupOutcomes: { completed: 0, failed: 0 },
      };
      this.#api.set(key, metric);
    }
    metric.requests = saturatingAdd(metric.requests, 1);
    if (record.inputCount !== undefined) metric.inputCount.observe(record.inputCount);
    if (record.inputBytes !== undefined) metric.inputBytes.observe(record.inputBytes);
    if (record.referenceOutcomes) {
      for (const outcome of ['hits', 'notFound', 'expired', 'failed'] as const) {
        metric.referenceOutcomes[outcome] = saturatingAdd(
          metric.referenceOutcomes[outcome],
          observationCount(record.referenceOutcomes[outcome]),
        );
      }
    }
    if (record.cleanupOutcome === 'completed' || record.cleanupOutcome === 'failed') {
      metric.cleanupOutcomes[record.cleanupOutcome] = saturatingAdd(
        metric.cleanupOutcomes[record.cleanupOutcome],
        1,
      );
    }
  }

  recordTelemetry(record: ImageTelemetryRecord): void {
    const dimensions: ImageExecutionMetricDimensions = Object.freeze({
      provider: safeProvider(record.providerId),
      model: safeModel(record.model),
      action: record.action === 'generate' || record.action === 'edit' ? record.action : 'other',
      quality: enumOption(record.quality, ['auto', 'low', 'medium', 'high'] as const),
      background: enumOption(record.background, ['auto', 'opaque', 'transparent'] as const),
      outputFormat: enumOption(record.outputFormat, ['png', 'jpeg', 'webp'] as const),
      streaming: booleanOption(record.streaming),
      requestedOutputs: countOption(record.requestedOutputCount),
      terminal: record.terminal === 'completed' || record.terminal === 'failed' || record.terminal === 'cancelled'
        ? record.terminal
        : 'other',
      errorCode: safeErrorCode(record.errorCode),
    });
    const key = keyOf(dimensions);
    let metric = this.#executions.get(key);
    if (!metric) {
      if (this.#executions.size >= this.#maxDimensionSets) {
        this.#telemetryOverflow = saturatingAdd(this.#telemetryOverflow, 1);
        return;
      }
      metric = {
        dimensions,
        executions: 0,
        finalLatencyMs: new BoundedHistogram(LATENCY_BUCKETS_MS),
        queueWaitMs: new BoundedHistogram(LATENCY_BUCKETS_MS),
        generationDurationMs: new BoundedHistogram(LATENCY_BUCKETS_MS),
        firstPartialLatencyMs: new BoundedHistogram(LATENCY_BUCKETS_MS),
        inputCount: new BoundedHistogram(COUNT_BUCKETS),
        inputBytes: new BoundedHistogram(BYTE_BUCKETS),
        outputCount: new BoundedHistogram(COUNT_BUCKETS),
        outputBytes: new BoundedHistogram(BYTE_BUCKETS),
        retryCount: new BoundedHistogram(COUNT_BUCKETS),
        authRefreshCount: new BoundedHistogram(COUNT_BUCKETS),
        referenceSaveCount: new BoundedHistogram(COUNT_BUCKETS),
        retentionRollbackFailures: new BoundedHistogram(COUNT_BUCKETS),
      };
      this.#executions.set(key, metric);
    }
    metric.executions = saturatingAdd(metric.executions, 1);
    metric.finalLatencyMs.observe(nonnegativeDelta(record.finishedAt, record.startedAt));
    metric.queueWaitMs.observe(record.queueWaitMs);
    metric.generationDurationMs.observe(
      nonnegativeDelta(record.finishedAt, record.generationStartedAt),
    );
    metric.firstPartialLatencyMs.observe(
      nonnegativeDelta(record.firstPartialAt, record.startedAt),
    );
    metric.inputCount.observe(record.inputCount);
    metric.inputBytes.observe(record.inputBytes);
    metric.outputCount.observe(Array.isArray(record.outputs) ? record.outputs.length : 0);
    metric.outputBytes.observe(sumOutputBytes(record));
    metric.retryCount.observe(record.retryCount);
    metric.authRefreshCount.observe(record.authRefreshCount);
    metric.referenceSaveCount.observe(record.referenceSaveCount);
    metric.retentionRollbackFailures.observe(record.retentionRollbackFailures);
  }

  recordConfigurationAudit(record: ImageConfigurationAuditRecord): void {
    const requested = new Set(record.fields);
    const fields = IMAGE_CONFIGURATION_AUDIT_FIELDS.filter((field) => requested.has(field));
    if (fields.length === 0) return;
    const previousGenerationId = safeGenerationId(record.previousGenerationId);
    const generationId = safeGenerationId(record.generationId);
    this.#configurationChanges.push(Object.freeze({
      outcome: 'applied',
      fields: Object.freeze(fields),
      ...(previousGenerationId ? { previousGenerationId } : {}),
      ...(generationId ? { generationId } : {}),
    }));
    if (this.#configurationChanges.length > MAX_CONFIGURATION_AUDIT_RECORDS) {
      this.#configurationChanges.shift();
    }
  }

  snapshot(): ImageObservabilitySnapshot {
    const apiRequests = [...this.#api.values()].map((metric): ImageApiMetricSnapshot => Object.freeze({
      dimensions: metric.dimensions,
      requests: metric.requests,
      ...(optionalHistogram(metric.inputCount) ? { inputCount: metric.inputCount.snapshot() } : {}),
      ...(optionalHistogram(metric.inputBytes) ? { inputBytes: metric.inputBytes.snapshot() } : {}),
      referenceOutcomes: Object.freeze({ ...metric.referenceOutcomes }),
      cleanupOutcomes: Object.freeze({ ...metric.cleanupOutcomes }),
    }));
    const executions = [...this.#executions.values()].map(
      (metric): ImageExecutionMetricSnapshot => Object.freeze({
        dimensions: metric.dimensions,
        executions: metric.executions,
        finalLatencyMs: metric.finalLatencyMs.snapshot(),
        ...(optionalHistogram(metric.queueWaitMs)
          ? { queueWaitMs: metric.queueWaitMs.snapshot() }
          : {}),
        ...(optionalHistogram(metric.generationDurationMs)
          ? { generationDurationMs: metric.generationDurationMs.snapshot() }
          : {}),
        ...(optionalHistogram(metric.firstPartialLatencyMs)
          ? { firstPartialLatencyMs: metric.firstPartialLatencyMs.snapshot() }
          : {}),
        inputCount: metric.inputCount.snapshot(),
        inputBytes: metric.inputBytes.snapshot(),
        outputCount: metric.outputCount.snapshot(),
        outputBytes: metric.outputBytes.snapshot(),
        ...(optionalHistogram(metric.retryCount)
          ? { retryCount: metric.retryCount.snapshot() }
          : {}),
        ...(optionalHistogram(metric.authRefreshCount)
          ? { authRefreshCount: metric.authRefreshCount.snapshot() }
          : {}),
        ...(optionalHistogram(metric.referenceSaveCount)
          ? { referenceSaveCount: metric.referenceSaveCount.snapshot() }
          : {}),
        ...(optionalHistogram(metric.retentionRollbackFailures)
          ? { retentionRollbackFailures: metric.retentionRollbackFailures.snapshot() }
          : {}),
      }),
    );
    return Object.freeze({
      apiRequests: Object.freeze(apiRequests),
      executions: Object.freeze(executions),
      configurationChanges: Object.freeze([...this.#configurationChanges]),
      overflow: Object.freeze({
        apiRecords: this.#apiOverflow,
        telemetryRecords: this.#telemetryOverflow,
      }),
    });
  }

  reset(): void {
    this.#api.clear();
    this.#executions.clear();
    this.#configurationChanges.length = 0;
    this.#apiOverflow = 0;
    this.#telemetryOverflow = 0;
  }
}
