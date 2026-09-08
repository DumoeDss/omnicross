/**
 * antigravityQuotaFamily — the antigravity subscription's counter-family ←→
 * model-family mapping, SHARED between the quota collector (scheduling), the
 * allowance gating, and the transformer's per-family decoration (design D6).
 *
 * The Antigravity quota backend meters usage in three COUNTER families
 * (Google / Anthropic / OpenAI) while the model catalog spans three MODEL
 * families (`gemini-*` / `claude-*` / `gpt-oss-*`). One table keeps the
 * mapping authoritative everywhere:
 *
 *   counter family   model family   catalog ids
 *   ──────────────   ────────────   ─────────────────────────────
 *   Google           gemini         gemini-* (+ the tab_* autocomplete ids)
 *   Anthropic        claude         claude-*
 *   OpenAI           gpt-oss        gpt-oss-*
 *
 * @module pipeline/antigravityQuotaFamily
 */

import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

/** The quota counter families the Antigravity quotaSummary response reports. */
export type AntigravityCounterFamily = 'google' | 'anthropic' | 'openai';

/** The antigravity model families (also the allowance window's `modelFamily`). */
export type AntigravityModelFamily = 'gemini' | 'claude' | 'gpt-oss';

/** Counter family → model family (the authoritative direction). */
export const ANTIGRAVITY_COUNTER_TO_MODEL_FAMILY: Readonly<
  Record<AntigravityCounterFamily, AntigravityModelFamily>
> = {
  google: 'gemini',
  anthropic: 'claude',
  openai: 'gpt-oss',
};

/** Model family → counter family (derived once; keep in sync with the above). */
export const ANTIGRAVITY_MODEL_TO_COUNTER_FAMILY: Readonly<
  Record<AntigravityModelFamily, AntigravityCounterFamily>
> = {
  gemini: 'google',
  claude: 'anthropic',
  'gpt-oss': 'openai',
};

/** The counter-family keys as they appear in a quotaSummary group/bucket id. */
export const ANTIGRAVITY_COUNTER_FAMILY_KEYS: readonly AntigravityCounterFamily[] = [
  'google',
  'anthropic',
  'openai',
];

/**
 * Classify an antigravity model id into its model family by id prefix. The
 * `tab_*` autocomplete ids meter on the Google counter (they are Google-served)
 * and route as the gemini family. Unknown ids resolve `undefined` (callers
 * treat them as ungated).
 */
export function antigravityModelFamily(modelId: string | undefined): AntigravityModelFamily | undefined {
  if (!modelId) return undefined;
  if (modelId.startsWith('claude-')) return 'claude';
  if (modelId.startsWith('gpt-oss-')) return 'gpt-oss';
  if (modelId.startsWith('gemini-') || modelId.startsWith('tab_')) return 'gemini';
  return undefined;
}

/** The counter family a model id meters on (undefined for unknown ids). */
export function antigravityCounterFamilyForModel(
  modelId: string | undefined,
): AntigravityCounterFamily | undefined {
  const family = antigravityModelFamily(modelId);
  return family ? ANTIGRAVITY_MODEL_TO_COUNTER_FAMILY[family] : undefined;
}

/**
 * Parse a quotaSummary group/bucket identifier into its counter family:
 * `gemini-*` bucket ids → google; `3p-*` / claude / gpt / third-party → the
 * SHARED third-party group, metered by BOTH anthropic and openai (the upstream
 * exposes one shared third-party bucket — D6 keeps both families gated on it).
 * Returns the counter families the bucket meters.
 */
export function antigravityCounterFamiliesForBucketId(
  bucketId: string | undefined,
  groupName: string | undefined,
): readonly AntigravityCounterFamily[] {
  const bucket = (bucketId ?? '').toLowerCase();
  const group = (groupName ?? '').toLowerCase();
  if (bucket.startsWith('gemini-') || group.includes('gemini')) return ['google'];
  if (
    bucket.startsWith('3p-') ||
    group.includes('claude') ||
    group.includes('gpt') ||
    group.includes('third party')
  ) {
    return ['anthropic', 'openai'];
  }
  return [];
}

/** Type-level guard: this module only serves the antigravity provider. */
export type AntigravityProviderId = Extract<SubscriptionProviderId, 'antigravity'>;
