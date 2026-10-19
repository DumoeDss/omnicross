/**
 * nativeImageTargets — which configured upstreams natively speak the OpenAI
 * images wire, independent of the Omnicross image runtime.
 *
 * Shared by the two "image feature is off" seams so they agree on the answer:
 *  - the outbound router's `/v1/images/*` relay (`outbound-api/nativeImagePassthrough`)
 *  - the Responses hosted-`image_generation` pass-through
 *    (`provider-proxy/ingress/openaiResponsesIngress`)
 *
 * Kept free of provider-proxy imports: the ingress imports this module, so any
 * dependency back into provider-proxy would close an import cycle.
 *
 * @module image-generation/nativeImageTargets
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { resolveProviderEndpoint } from '../completion/url-builder';

/** The official OpenAI API host whose Images endpoints are publicly documented. */
const OFFICIAL_OPENAI_HOST = 'api.openai.com';

/**
 * Whether this provider row IS the official OpenAI API.
 *
 * Host-based on purpose: provider rows whose preset never set `isOfficial`
 * still hit `api.openai.com` (the shipped OpenAI preset does exactly that), and
 * a relayed `…/images/generations` there is the documented public API. Anything
 * else — proxies, aggregators, Azure deployments — is NOT guessed at; its
 * image capability stays exactly what the Omnicross runtime (or the local
 * error) says it is.
 */
export function isOfficialOpenAIImageUpstream(provider: LLMProvider | null | undefined): boolean {
  if (!provider) return false;
  let base: string;
  try {
    base = resolveProviderEndpoint(provider).baseUrl;
  } catch {
    return false;
  }
  try {
    return new URL(base).hostname.toLowerCase() === OFFICIAL_OPENAI_HOST;
  } catch {
    return false;
  }
}
