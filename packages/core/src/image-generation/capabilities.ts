import type {
  ImageCapabilities,
  ImageCapabilityEvidenceLayer,
  ImageCapabilityUnavailableReason,
  ImageCapabilityValues,
  ImageOutputFormat,
} from '@omnicross/contracts/image-generation-types';

export interface ImageCapabilityEvidenceSet {
  readonly adapter: ImageCapabilityEvidenceLayer;
  readonly account: ImageCapabilityEvidenceLayer;
  readonly upstream: ImageCapabilityEvidenceLayer;
}

const BOOLEAN_KEYS = [
  'available',
  'generate',
  'edit',
  'maskEdit',
  'streaming',
  'transparentBackground',
  'flexibleSizes',
  'responsesTool',
  'multiTurnEdit',
  'supportsFileId',
  'supportsImageUrl',
] as const satisfies readonly (keyof ImageCapabilityValues)[];

const NUMERIC_KEYS = [
  'maxInputImages',
  'maxOutputImages',
  'maxPartialImages',
] as const satisfies readonly (keyof ImageCapabilityValues)[];

function intersectStrings(layers: readonly ImageCapabilityEvidenceLayer[], key: 'models'): string[];
function intersectStrings(
  layers: readonly ImageCapabilityEvidenceLayer[],
  key: 'outputFormats',
): ImageOutputFormat[];
function intersectStrings(
  layers: readonly ImageCapabilityEvidenceLayer[],
  key: 'models' | 'outputFormats',
): string[] {
  const sets = layers.map((layer) => {
    const value = layer.values?.[key];
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  });
  if (sets.length === 0) return [];
  return [...sets[0]!].filter((value) => sets.slice(1).every((set) => set.has(value))).sort();
}

function unavailableReason(
  layers: readonly ImageCapabilityEvidenceLayer[],
  now: number,
): ImageCapabilityUnavailableReason | undefined {
  for (const layer of layers) {
    if (layer.kind !== 'adapter' && layer.kind !== 'account' && layer.kind !== 'upstream') {
      return 'missing_evidence';
    }
    if (!Number.isFinite(layer.verifiedAt) || !layer.values) {
      if (layer.kind === 'account') return 'account_unverified';
      if (layer.kind === 'upstream') return 'protocol_unverified';
      return 'missing_evidence';
    }
    if (layer.expiresAt != null && (!Number.isFinite(layer.expiresAt) || layer.expiresAt <= now)) {
      return 'stale_evidence';
    }
  }

  const availability = layers.map((layer) => layer.values?.available);
  if (availability.some((value) => value === true) && availability.some((value) => value === false)) {
    return 'contradictory_evidence';
  }
  if (availability.some((value) => value !== true)) {
    const unavailable = layers.find((layer) => layer.values?.available === false);
    if (unavailable?.kind === 'adapter') return 'adapter_unavailable';
    if (unavailable?.kind === 'account') return 'account_unverified';
    if (unavailable?.kind === 'upstream') return 'protocol_unverified';
    return 'missing_evidence';
  }
  return undefined;
}

/**
 * Resolve the adapter declaration, selected-account evidence, and observed
 * upstream evidence without inferring anything from model names.
 */
export function resolveImageCapabilities(
  evidence: ImageCapabilityEvidenceSet,
  now = Date.now(),
): ImageCapabilities {
  const layers = [evidence.adapter, evidence.account, evidence.upstream] as const;
  let reason = unavailableReason(layers, now);

  const booleans = Object.fromEntries(
    BOOLEAN_KEYS.map((key) => [key, layers.every((layer) => layer.values?.[key] === true)]),
  ) as Pick<ImageCapabilityValues, (typeof BOOLEAN_KEYS)[number]>;

  const numbers = Object.fromEntries(
    NUMERIC_KEYS.map((key) => {
      const values = layers.map((layer) => layer.values?.[key]);
      const valid = values.every((value) => Number.isInteger(value) && (value as number) >= 0);
      return [key, valid ? Math.min(...(values as number[])) : 0];
    }),
  ) as Pick<ImageCapabilityValues, (typeof NUMERIC_KEYS)[number]>;

  const models = intersectStrings(layers, 'models');
  const outputFormats = intersectStrings(layers, 'outputFormats');
  if (!reason && models.length === 0) reason = 'no_common_models';
  if (!reason && outputFormats.length === 0) reason = 'no_common_output_formats';

  const verifiedAt = layers
    .map((layer) => layer.verifiedAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  return {
    ...booleans,
    ...numbers,
    available: !reason && booleans.available && models.length > 0 && outputFormats.length > 0,
    models,
    outputFormats,
    reason,
    resolvedAt: now,
    oldestEvidenceAt: verifiedAt.length === layers.length ? Math.min(...verifiedAt) : undefined,
  };
}
