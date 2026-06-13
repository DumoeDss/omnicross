/**
 * Claude CLI launch-config builder — the claude analogue of
 * `cli-proxy-env.ts`'s `buildChatCliLaunchConfig` (daemon-parity launch knife).
 *
 * The claude CLI honors `ANTHROPIC_BASE_URL` as the API base (it appends
 * `/v1/messages` itself) and forwards `ANTHROPIC_AUTH_TOKEN` as
 * `Authorization: Bearer <value>` — which is exactly where the resident
 * `ProviderProxy` router reads the route token from (`providerProxyRouter.ts`
 * `resolveRouteToken`: `Authorization: Bearer` first, `x-goog-api-key` as the
 * gemini-only fallback; `x-api-key` is NOT a route-token source). So the token
 * rides `ANTHROPIC_AUTH_TOKEN`, the proxy looks the route up, discards the
 * sentinel, and re-authenticates upstream from the route's own provider
 * credential.
 *
 * `ANTHROPIC_API_KEY` is set to a NON-SECRET placeholder (`omnicross-proxy`)
 * purely to suppress the CLI's interactive login/keychain prompts. A host that
 * passes the REAL key for anthropic-format providers would let the Claude Agent
 * SDK detect a first-party provider and enable server-side WebSearch; this
 * launch contract DELIBERATELY does not — "upstream credentials NEVER enter the
 * CLI env" — so claude's server-side tools won't self-enable.
 *
 * `targetProviderFormat` mirrors the BYO mint point: `'anthropic'` for an
 * anthropic-format provider (same-format fast path) and `'transform'` otherwise.
 *
 * @module @omnicross/cli-launcher/proxy-env/claude-proxy-env
 */

import type { ProviderConfigSource, UsageRecorderImport } from '@omnicross/core';
import { resolveProviderEndpoint } from '@omnicross/core/completion';
import type { ApiKeyPoolService } from '@omnicross/core/completion/ApiKeyPoolService';
import type { RouteContext } from '@omnicross/core/provider-proxy';
import { getProviderProxy } from '@omnicross/core/provider-proxy';

import type { ChatCliLaunchConfig } from './cli-proxy-env';

/**
 * Non-secret `ANTHROPIC_API_KEY` placeholder. The proxy router strips every
 * auth header (`AUTH_HEADER_KEYS` includes `x-api-key`) before re-authing
 * upstream, so this value never reaches a provider.
 */
export const CLAUDE_PROXY_API_KEY_SENTINEL = 'omnicross-proxy';

/** Inputs for `buildClaudeCliLaunchConfig` — mirrors the chat-CLI inputs. */
export interface ClaudeCliLaunchConfigInputs {
  readonly llmConfig: ProviderConfigSource;
  /** Provider row id (BYO) the proxy re-auths with. */
  readonly providerId: string;
  /** The provider model the claude CLI's model name is mapped to. */
  readonly model: string;
  /** Pool for session-affine key selection + 429/401 failover (optional). */
  readonly apiKeyPool?: ApiKeyPoolService | null;
  /** Session id for pool affinity + usage attribution. */
  readonly sessionId?: string | null;
  /** Usage recorder — when set, anthropic-ingress usage is persisted. */
  readonly usageRecorder?: UsageRecorderImport | null;
}

/**
 * Build the env + route for a claude CLI redirect (BYO only). Validates the
 * provider row + key up front (throws BEFORE registering a route when the
 * provider is missing / keyless), then registers one anthropic-messages route
 * on the resident proxy.
 */
export async function buildClaudeCliLaunchConfig(
  inputs: ClaudeCliLaunchConfigInputs,
): Promise<ChatCliLaunchConfig> {
  const provider = await inputs.llmConfig.getProvider(inputs.providerId);
  if (!provider) {
    throw new Error(
      `claude proxy: provider not found: ${inputs.providerId}. ` +
        'Add a provider row to the daemon config (omnicross providers add …).',
    );
  }
  const { apiKey } = resolveProviderEndpoint(provider);
  if (!resolveApiKey(apiKey)) {
    throw new Error(
      `claude proxy: provider "${inputs.providerId}" has no valid API key. ` +
        'Set apiKey (or a $ENV_VAR reference) on the provider row.',
    );
  }

  // Register the Anthropic-Messages route on the resident proxy. Same-format
  // fast path for anthropic-format providers, transform chain otherwise —
  // mirroring the host BYO mint point's semantics (provider-env.ts:543).
  const route: RouteContext = {
    sessionId: inputs.sessionId ?? null,
    targetProviderFormat: provider.apiFormat === 'anthropic' ? 'anthropic' : 'transform',
    model: inputs.model,
    ingressFormat: 'anthropic-messages',
    authMode: 'byo',
    providerId: inputs.providerId,
  };
  const proxy = getProviderProxy();
  const token = proxy.addRoute(route);
  const baseUrl = proxy.getBaseUrl();

  console.info('[buildClaudeCliLaunchConfig] claude route ready', {
    sessionId: inputs.sessionId,
    baseUrl,
    providerId: inputs.providerId,
    model: inputs.model,
  });

  // base = listener ROOT (the claude CLI appends `/v1/messages` itself).
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: CLAUDE_PROXY_API_KEY_SENTINEL,
    ANTHROPIC_MODEL: inputs.model,
  };

  return {
    env,
    baseUrl,
    onSessionEnd: () => {
      try {
        proxy.removeRoute(token);
      } catch {
        // best-effort
      }
    },
  };
}

/** Resolve an `$ENV_VAR` reference or return the literal key (mirrors siblings). */
function resolveApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) {
    return process.env[apiKey.slice(1)] || '';
  }
  return apiKey;
}
