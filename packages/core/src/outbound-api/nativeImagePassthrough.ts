/**
 * nativeImagePassthrough — "the image feature being OFF must not break an
 * upstream that natively speaks images".
 *
 * Codex's built-in `image_gen` tool executes LOCALLY: when the model calls it,
 * codex POSTs `<active provider base>/images/generations` (or `/images/edits`)
 * itself — see `codex-rs/ext/image-generation` + `codex-api` `ImagesClient`.
 * With Omnicross configured as the Codex provider those requests land on THIS
 * gateway. Until now a disabled Omnicross image runtime answered them with
 * 501/422, which silently killed a capability the user's own upstream already
 * had (a ChatGPT/Codex subscription, or the official OpenAI API).
 *
 * The rule these helpers implement: when the image runtime cannot serve a
 * request, relay it VERBATIM to the key's bound upstream IFF that upstream
 * natively supports the images wire —
 *
 *   - Codex subscription (account/group/pool) → `chatgpt.com/backend-api/codex/
 *     images/{generations,edits}` with the account's OAuth + Codex CLI markers
 *     (the same endpoint codex would have called directly).
 *   - Official OpenAI provider row → the row's `…/images/{generations,edits}`
 *     with its own API key.
 *
 * Every other target (third-party BYO, other subscriptions) keeps the
 * structured `unsupported_capability` error: relaying an images body to an
 * upstream that does not speak it would substitute a confusing upstream 404
 * for an honest local answer.
 *
 * @module outbound-api/nativeImagePassthrough
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { getProviderHeaders } from '../completion/header-builder';
import { resolveApiFormat } from '../completion/url-builder';
import { isOfficialOpenAIImageUpstream } from '../image-generation/nativeImageTargets';
import {
  extractCodexClientHeaders,
  fillMissingCodexCliIdentity,
  fillMissingHeaders,
} from '../provider-proxy/identity/codexCliHeaders';

import { bindDelegatedSubscriptionProfile } from './routeResolver';
import { getSubscriptionRegistryForOutbound } from './subscriptionRegistryPort';
import type { EndpointRoutingConfig, GatewayBindingTarget } from './types';

export type NativeImageAction = 'generate' | 'edit';

/** What the router needs to relay one image request upstream verbatim. */
export interface NativeImagePassthroughPlan {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Upstream identity for logs/audit (`codex` / the BYO provider row id). */
  readonly providerId: string;
}

/** The Codex subscription root the image wire lives under. */
export const CODEX_SUBSCRIPTION_IMAGE_ROOT = 'https://chatgpt.com/backend-api/codex';

/** The two image wire paths every capable upstream shares. */
function imageActionPath(action: NativeImageAction): string {
  return action === 'edit' ? 'images/edits' : 'images/generations';
}

export { isOfficialOpenAIImageUpstream };

/** Resolve a `$ENV_VAR` key reference or return the literal (routeResolver idiom). */
function providerKeyLiteral(apiKey: string | undefined): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) return process.env[apiKey.slice(1)] || '';
  return apiKey;
}

/** Root-join one image path onto a provider row's configured base. */
function providerImageUrl(provider: LLMProvider, action: NativeImageAction): string | null {
  const base = provider.api_base_url?.trim().replace(/\/+$/u, '') ?? '';
  if (!base) return null;
  const format = resolveApiFormat(provider);
  // Mirror `directUpstreamRoot`: strip the wire's own endpoint suffix so a
  // versioned base (`…/v1/chat/completions`, `…/v1/responses`) keeps its `/v1`
  // and a bare host gains one.
  const root = format === 'openai-response'
    ? base.replace(/\/responses$/u, '')
    : base.replace(/\/chat\/completions$/u, '');
  if (!/\/v\d+[a-z]*$/u.test(root)) {
    return `${root}/v1/${imageActionPath(action)}`;
  }
  return `${root}/${imageActionPath(action)}`;
}

/** The subscription root for a codex image call, derived from its profile. */
function codexImageRoot(): string {
  const profile = getSubscriptionRegistryForOutbound()?.getProfile('codex');
  const responsesUrl = profile?.resolveUpstreamUrl?.('gpt-5.6-luna');
  if (typeof responsesUrl === 'string' && responsesUrl.trim()) {
    return responsesUrl.trim().replace(/\/+$/u, '').replace(/\/responses$/u, '');
  }
  return CODEX_SUBSCRIPTION_IMAGE_ROOT;
}

/**
 * Resolve the verbatim relay plan for one image request, or `null` when the
 * bound target does not natively support the images wire.
 */
export async function resolveNativeImagePassthrough(args: {
  readonly target: GatewayBindingTarget;
  /** The winning binding projected to the routing config (account pins ride it). */
  readonly endpointConfig: EndpointRoutingConfig;
  readonly llmConfig: { getProvider(id: string): Promise<LLMProvider | null | undefined> };
  readonly action: NativeImageAction;
  readonly model: string;
  readonly sessionKey: string;
  /** Inbound headers — the caller's own Codex CLI markers are forwarded. */
  readonly clientHeaders?: Record<string, string | string[] | undefined>;
}): Promise<NativeImagePassthroughPlan | null> {
  const { target, endpointConfig, llmConfig, action, model, sessionKey } = args;

  // ── Codex subscription: the account pool owns the credential — the same
  // OAuth `AuthStrategy` the Responses relay uses, so per-account selection,
  // refresh and health gating stay single-sourced.
  if (target.kind === 'account' || target.kind === 'account-group' || target.kind === 'account-pool') {
    if (target.providerId !== 'codex') return null;
    const profile = getSubscriptionRegistryForOutbound()?.getProfile('codex');
    if (!profile) return null;
    const bound = bindDelegatedSubscriptionProfile(profile, endpointConfig);
    const url = `${codexImageRoot()}/${imageActionPath(action)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      accept: 'application/json',
    };
    await bound.authStrategy.applyHeaders(headers, {
      upstreamUrl: url,
      resolvedModel: model,
      sessionKey,
    });
    // The Codex backend fingerprints its clients: forward the CALLER's own
    // markers (a real codex CLI sends originator/version/session-id) and fill
    // the always-safe originator for anything else.
    fillMissingHeaders(headers, extractCodexClientHeaders(args.clientHeaders ?? {}));
    fillMissingCodexCliIdentity(headers);
    return { url, headers, providerId: 'codex' };
  }

  // ── BYO provider row: only the official OpenAI API speaks this wire.
  const provider = await llmConfig.getProvider(target.providerId);
  if (!provider || !isOfficialOpenAIImageUpstream(provider)) return null;
  const url = providerImageUrl(provider, action);
  if (!url) return null;
  const headers = getProviderHeaders(provider, providerKeyLiteral(provider.api_key));
  headers['Content-Type'] = 'application/json';
  headers.accept = headers.accept ?? 'application/json';
  return { url, headers, providerId: provider.id };
}
