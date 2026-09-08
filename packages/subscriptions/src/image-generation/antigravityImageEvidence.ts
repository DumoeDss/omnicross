/**
 * antigravityImageEvidence — the antigravity image adapter's fail-closed
 * capability layers (multi-provider-image-generation D5). v1 keeps the
 * evidence source minimal: the DEFAULT `Unknown…` source always reports
 * entitlement-unknown + protocol-unverified, which the provider resolves to
 * the codex-precedent bootstrap-eligible state (one real upstream attempt).
 * A persistent evidence store can slot in behind the same interface later.
 */

import type {
  ImageCapabilityEvidenceLayer,
  ImageCapabilityValues,
} from '@omnicross/contracts/image-generation-types';

export interface AntigravityImageCapabilityEvidenceRequest {
  readonly accountId: string;
  readonly signal: AbortSignal;
}

export interface AntigravityImageCapabilityEvidence {
  readonly account: ImageCapabilityEvidenceLayer;
  readonly upstream: ImageCapabilityEvidenceLayer;
}

export interface AntigravityImageCapabilityEvidenceSource {
  resolve(request: AntigravityImageCapabilityEvidenceRequest): Promise<AntigravityImageCapabilityEvidence>;
}

/**
 * The antigravity image models the adapter can speak (the NanoBanana census on
 * the antigravity identity — gemini-cli is out of scope for images by the
 * 2026-09-08 decision). Adapter-local limits, NOT entitlement claims.
 */
export const ANTIGRAVITY_IMAGE_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-2.5-flash-image-preview',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
] as const;

export const ANTIGRAVITY_IMAGE_ADAPTER_VALUES: ImageCapabilityValues = {
  available: true,
  models: [...ANTIGRAVITY_IMAGE_MODELS],
  generate: true,
  edit: true,
  maskEdit: false,
  maxInputImages: 1,
  maxOutputImages: 1,
  streaming: false,
  maxPartialImages: 0,
  transparentBackground: false,
  flexibleSizes: true,
  // v1 declares PNG-only: the upstream has no output-format parameter, PNG is
  // the dominant NanoBanana output, and a declared-but-uncontrollable format
  // would be a capability lie (design D4).
  outputFormats: ['png'],
  qualityLevels: ['auto'],
  moderationModes: ['auto'],
  outputCompression: { supported: false },
  responsesTool: false,
  multiTurnEdit: false,
  supportsFileId: false,
  supportsImageUrl: false,
};

export function createAntigravityImageAdapterEvidence(now = Date.now()): ImageCapabilityEvidenceLayer {
  return {
    kind: 'adapter',
    source: 'antigravity-image-adapter-declaration',
    verifiedAt: now,
    values: ANTIGRAVITY_IMAGE_ADAPTER_VALUES,
  };
}

/** Always entitlement-unknown + protocol-unverified → bootstrap-eligible. */
export class UnknownAntigravityImageCapabilityEvidenceSource
  implements AntigravityImageCapabilityEvidenceSource
{
  async resolve(): Promise<AntigravityImageCapabilityEvidence> {
    return {
      account: { kind: 'account', source: 'antigravity-image-entitlement-unknown' },
      upstream: { kind: 'upstream', source: 'antigravity-image-protocol-unverified' },
    };
  }
}
