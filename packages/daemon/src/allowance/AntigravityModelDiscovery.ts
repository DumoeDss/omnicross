/**
 * AntigravityModelDiscovery — the antigravity subscription's DYNAMIC model
 * discovery over `v1internal:fetchAvailableModels`
 * (antigravity-subscription-provider design D7):
 *
 *   - the denylist (`chat_20706` / `chat_23310` / `gemini-2.5-pro`) and
 *     internal-only ids NEVER surface,
 *   - the discovered catalog MERGES with the static catalog — on a conflict
 *     the STATIC entry wins and the conflict is logged,
 *   - per-model metadata (displayName / supportsImages / supportsThinking /
 *     thinkingBudget / maxTokens) rides each discovered entry.
 *
 * The merged catalog is served over the admin API (`GET
 * /accounts/antigravity/models`) — the static catalog remains the offline
 * baseline (the pickers stay usable when the upstream is unreachable).
 *
 * @module @omnicross/daemon/allowance/AntigravityModelDiscovery
 */

import { lookupCanonicalCapabilities } from '@omnicross/contracts/canonical-models';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import { SUBSCRIPTION_MODEL_CATALOG } from '@omnicross/contracts/subscription-model-catalog';
import { ANTIGRAVITY_CODE_ASSIST_ENDPOINT } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { getAntigravityUserAgent } from '@omnicross/core/transformer/transformers/antigravityIdentity';

import { ANTIGRAVITY_DISCOVERY_DENYLIST } from './AntigravityAllowanceCollector';

/** One discovered antigravity model + its upstream metadata. */
export interface AntigravityDiscoveredModel {
  id: string;
  displayName?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
}

/** The merged (static-priority) catalog row. */
export interface AntigravityCatalogEntry {
  id: string;
  /** `static` (the built-in census) or `discovered` (fetchAvailableModels). */
  origin: 'static' | 'discovered';
  displayName?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
}

export type AntigravityDiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Parse a fetchAvailableModels payload into discovered entries (denylist +
 * `isInternal` filtered, metadata extracted). Pure; exported for tests.
 */
export function parseAntigravityAvailableModels(payload: unknown): AntigravityDiscoveredModel[] {
  if (!isRecord(payload)) return [];
  const models = payload['models'];
  if (!isRecord(models)) return [];

  const out: AntigravityDiscoveredModel[] = [];
  for (const [id, raw] of Object.entries(models)) {
    // Denylist: the id never surfaces in the external catalog.
    if (ANTIGRAVITY_DISCOVERY_DENYLIST.has(id)) continue;
    if (!isRecord(raw)) continue;
    if (raw['isInternal'] === true) continue;
    out.push({
      id,
      ...(optionalString(raw['displayName']) ? { displayName: optionalString(raw['displayName']) } : {}),
      ...(optionalBoolean(raw['supportsImages']) !== undefined
        ? { supportsImages: optionalBoolean(raw['supportsImages']) }
        : {}),
      ...(optionalBoolean(raw['supportsThinking']) !== undefined
        ? { supportsThinking: optionalBoolean(raw['supportsThinking']) }
        : {}),
      ...(optionalNumber(raw['thinkingBudget']) !== undefined
        ? { thinkingBudget: optionalNumber(raw['thinkingBudget']) }
        : {}),
      ...(optionalNumber(raw['maxTokens']) !== undefined
        ? { maxTokens: optionalNumber(raw['maxTokens']) }
        : {}),
      ...(optionalNumber(raw['maxOutputTokens']) !== undefined
        ? { maxOutputTokens: optionalNumber(raw['maxOutputTokens']) }
        : {}),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Merge the discovered models into the STATIC catalog: static entries win
 * verbatim (origin `static`), a discovered id already present statically is a
 * logged conflict and dropped, genuinely new ids append (origin `discovered`).
 * Pure except the conflict log. Exported for tests.
 */
export function mergeAntigravityCatalog(
  discovered: readonly AntigravityDiscoveredModel[],
  log: (message: string) => void = (line) => console.warn(line),
  staticIds: readonly string[] = SUBSCRIPTION_MODEL_CATALOG.antigravity,
): AntigravityCatalogEntry[] {
  const entries: AntigravityCatalogEntry[] = staticIds.map((id) => {
    const capabilities = lookupCanonicalCapabilities(id);
    return {
      id,
      origin: 'static',
      displayName: id,
      ...(capabilities?.vision !== undefined ? { supportsImages: capabilities.vision } : {}),
      ...(capabilities?.reasoning !== undefined ? { supportsThinking: capabilities.reasoning } : {}),
      ...(capabilities?.thinkingTokenLimit ? { thinkingBudget: capabilities.thinkingTokenLimit.max } : {}),
      // Discovery calls the context window maxTokens, not the output ceiling.
      ...(capabilities?.contextLength !== undefined ? { maxTokens: capabilities.contextLength } : {}),
      ...(capabilities?.maxTokens !== undefined ? { maxOutputTokens: capabilities.maxTokens } : {}),
    };
  });
  const staticSet = new Set(staticIds);
  for (const model of discovered) {
    if (staticSet.has(model.id)) {
      log(
        `[AntigravityModelDiscovery] dynamic model '${model.id}' conflicts with the static catalog — static entry kept`,
      );
      continue;
    }
    entries.push({ ...model, origin: 'discovered' });
  }
  return entries;
}

/**
 * Fetch + parse the live catalog for one account's access token. The probe
 * carries the antigravity/hub UA (the upstream rejects unstyled traffic);
 * failures return `null` (the caller keeps the static baseline).
 */
export async function fetchAntigravityAvailableModels(
  accessToken: string,
  fetchImpl: AntigravityDiscoveryFetch = (url, init) =>
    fetchUpstream(url, init, { providerId: 'antigravity', redactBodies: true }),
): Promise<AntigravityDiscoveredModel[] | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${ANTIGRAVITY_CODE_ASSIST_ENDPOINT}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': getAntigravityUserAgent(),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload['models'])) return null;
  return parseAntigravityAvailableModels(payload);
}

/** The provider this module serves (type-level documentation). */
export type AntigravityDiscoveryProviderId = Extract<SubscriptionProviderId, 'antigravity'>;

/**
 * The admin route handler behind `GET /accounts/antigravity/models`: resolve
 * the ACTIVE account's access token, probe the live catalog, and answer the
 * STATIC-PRIORITY merged list. An unreachable upstream answers the static
 * baseline (`discovered: false`) — the endpoint never fails on discovery.
 * Secret-free: only model ids + metadata cross the wire.
 */
export async function handleAntigravityModelsRoute(deps: {
  resolveAntigravityAccessToken: () => Promise<string | null>;
  fetchImpl?: AntigravityDiscoveryFetch;
}): Promise<{ status: number; body: unknown }> {
  const accessToken = await deps.resolveAntigravityAccessToken().catch(() => null);
  const discovered = accessToken ? await fetchAntigravityAvailableModels(accessToken, deps.fetchImpl) : null;
  const models = mergeAntigravityCatalog(discovered ?? []);
  return {
    status: 200,
    body: { models, discovered: discovered !== null },
  };
}
