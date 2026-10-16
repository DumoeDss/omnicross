import type {
  ImageCapabilityEvidenceLayer,
  ImageCapabilityValues,
} from '@omnicross/contracts/image-generation-types';

import { CODEX_IMAGE_MODELS } from './imageModels';

/** Translate verified upstream model IDs into the base-model override's public IDs. */
export function applyCodexImageModelOverrideEvidence(
  layer: ImageCapabilityEvidenceLayer,
  imageModel?: string,
): ImageCapabilityEvidenceLayer {
  if (!imageModel || imageModel === 'gpt-image-2' || !layer.values?.models) return layer;
  const models = layer.values.models.filter((model) => model !== 'gpt-image-2');
  if (models.includes(imageModel)) models.unshift('gpt-image-2');
  return { ...layer, values: { ...layer.values, models } };
}

/** Safe evidence request; accountId is trusted-process input and must not be logged. */
export interface CodexImageCapabilityEvidenceRequest {
  readonly accountId: string;
  readonly signal: AbortSignal;
}

export interface CodexImageCapabilityEvidence {
  readonly account: ImageCapabilityEvidenceLayer;
  readonly upstream: ImageCapabilityEvidenceLayer;
  /** Enable only when these response fields have separate verified provenance. */
  readonly verifiedResponseFields?: {
    readonly usage?: boolean;
    readonly revisedPrompt?: boolean;
  };
}

export interface CodexImageCapabilityEvidenceSource {
  resolve(request: CodexImageCapabilityEvidenceRequest): Promise<CodexImageCapabilityEvidence>;
}

/**
 * Local adapter implementation limits. These are not entitlement/protocol
 * claims; the account and observed-upstream layers must independently agree.
 */
export const CODEX_IMAGE_ADAPTER_VALUES: ImageCapabilityValues = {
  available: true,
  models: CODEX_IMAGE_MODELS,
  generate: true,
  edit: true,
  maskEdit: false,
  maxInputImages: 1,
  maxOutputImages: 1,
  streaming: false,
  maxPartialImages: 0,
  transparentBackground: false,
  flexibleSizes: true,
  outputFormats: ['png', 'jpeg', 'webp'],
  qualityLevels: ['auto', 'low', 'medium', 'high'],
  moderationModes: ['auto', 'low'],
  outputCompression: { supported: true, formats: ['jpeg', 'webp'], min: 0, max: 100 },
  responsesTool: true,
  multiTurnEdit: false,
  supportsFileId: false,
  supportsImageUrl: false,
};

export function createCodexImageAdapterEvidence(
  now = Date.now(),
  imageModel?: string,
): ImageCapabilityEvidenceLayer & { readonly values: ImageCapabilityValues } {
  return {
    kind: 'adapter',
    source: 'codex-image-adapter-declaration',
    verifiedAt: now,
    values: imageModel && /^gpt-image-2\.5-(?:flare|sunburst)$/u.test(imageModel)
      ? { ...CODEX_IMAGE_ADAPTER_VALUES, qualityLevels: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] }
      : imageModel && !(CODEX_IMAGE_MODELS as readonly string[]).includes(imageModel)
      ? { ...CODEX_IMAGE_ADAPTER_VALUES, models: [imageModel, ...CODEX_IMAGE_MODELS] }
      : CODEX_IMAGE_ADAPTER_VALUES,
  };
}

/** Production-safe default: no model name, config toggle, or text success upgrades it. */
export class UnknownCodexImageCapabilityEvidenceSource
  implements CodexImageCapabilityEvidenceSource
{
  async resolve(_request: CodexImageCapabilityEvidenceRequest): Promise<CodexImageCapabilityEvidence> {
    return {
      account: { kind: 'account', source: 'codex-image-entitlement-unknown' },
      upstream: { kind: 'upstream', source: 'codex-image-protocol-unverified' },
    };
  }
}
