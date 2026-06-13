/**
 * Codex CLI launch-config builder — the Codex analogue of the host's
 * Claude-SDK provider-env builder (`buildProviderEnvWithProxy`).
 *
 * The Claude Agent SDK is redirected at a local proxy server by injecting
 * `ANTHROPIC_BASE_URL` (+ auth token) into the SDK subprocess env. The Codex CLI
 * is the same idea with a different redirect MECHANISM (see STEP 1 finding in the
 * `codex-responses-ingress` change): the Codex CLI does NOT honor an
 * `OPENAI_BASE_URL` env var for base-url redirection. It is redirected via its
 * config — `~/.codex/config.toml`'s `[model_providers.<name>]` block
 * (`base_url`, `wire_api = "responses"`, `requires_openai_auth = true`) selected
 * by `model_provider = "<name>"`. Codex exposes those config keys as
 * command-line `-c key=value` overrides (the SAME mechanism the canvas-MCP and
 * builtin-MCP CLI injectors already use for `mcp_servers.*`), so this builder
 * returns the `-c` overrides as `extraArgs` rather than writing the user's
 * `~/.codex/config.toml` on disk. This keeps the redirection session-scoped and
 * leaves the user's real config untouched (no file management, no rollback risk).
 *
 * The API key the CLI sends is supplied through the `requires_openai_auth` env
 * (`OPENAI_API_KEY`) — a placeholder is sufficient because the proxy
 * re-authenticates every upstream call with the resolved provider/subscription
 * credential; the value the CLI forwards is never used upstream. We still inject
 * a sentinel so the CLI's `requires_openai_auth = true` precondition is met
 * without the CLI falling back to a real `~/.codex/auth.json`.
 *
 * What this builder returns (mirroring `ProviderEnvResult` from provider-env.ts):
 *   - `env`        — env vars merged into the Codex subprocess (the auth sentinel).
 *   - `extraArgs`  — the `-c` config overrides that point the CLI at the proxy.
 *   - `onSessionEnd` — stops the booted proxy listener (proxy lifecycle tied
 *                      to the Codex run, exactly like provider-env.ts).
 *   - `baseUrl`    — the listener base (`http://127.0.0.1:<port>`); the CLI
 *                    appends the configured path → `<baseUrl>/openai/responses`.
 *
 * @module @omnicross/cli-launcher/proxy-env/codex-proxy-env
 */

import type { ProviderConfigSource, UsageRecorderImport } from '@omnicross/core';
import { resolveProviderEndpoint } from '@omnicross/core/completion';
import type { ApiKeyPoolService } from '@omnicross/core/completion/ApiKeyPoolService';
import type { SubscriptionAuthProfile } from '@omnicross/core/pipeline/SubscriptionAuthSource';
import type { RouteAuthMode, RouteContext } from '@omnicross/core/provider-proxy';
import { getProviderProxy } from '@omnicross/core/provider-proxy';

/**
 * The provider/model-provider NAME the Codex CLI selects via `model_provider`.
 * Distinct, proxy-owned name so it can never collide with a real provider the
 * user configured in their own `~/.codex/config.toml`.
 */
export const CODEX_PROXY_PROVIDER_NAME = 'omnicross';

/**
 * The base path the listener serves the Responses-API route under. The Codex
 * CLI appends `/responses` to `base_url`, so with `base_url = <listener>/openai`
 * the listener receives `POST /openai/responses` — the route the proxy's
 * Responses ingress matches.
 */
export const CODEX_PROXY_BASE_PATH = '/openai';

/** Inputs for `buildCodexLaunchConfig` — mirrors provider-env.ts's positional args as a struct. */
export interface CodexLaunchConfigInputs {
  readonly llmConfig: ProviderConfigSource;
  /**
   * OpenAI-compatible provider row id (BYO mode) whose key/headers authenticate
   * the upstream call. In subscription mode this is still the row to attribute
   * usage to, but auth flows through `subscriptionProfile`.
   */
  readonly providerId: string;
  /** The provider model the Codex CLI's model name is mapped to. */
  readonly model: string;
  /** Auth mode (design D4). Defaults to `'byo'`. */
  readonly authMode?: RouteAuthMode;
  /** REQUIRED when `authMode === 'subscription'`; ignored otherwise. */
  readonly subscriptionProfile?: SubscriptionAuthProfile | null;
  /** Pool for session-affine key selection + 429/401 failover (optional). */
  readonly apiKeyPool?: ApiKeyPoolService | null;
  /** Session id for pool affinity + usage attribution. */
  readonly sessionId?: string | null;
  /** Usage recorder — when set, non-stream codex-ingress usage is persisted. */
  readonly usageRecorder?: UsageRecorderImport | null;
}

/**
 * The launch redirection for the Codex CLI subprocess. Shaped to mirror
 * `ProviderEnvResult` (from provider-env.ts): `env` + `onSessionEnd`, plus the
 * Codex-specific `extraArgs` (config overrides) and the `baseUrl`.
 */
export interface CodexLaunchConfig {
  /**
   * Env vars to merge into the Codex subprocess env. The Codex CLI's
   * `requires_openai_auth = true` precondition is satisfied by a sentinel
   * `OPENAI_API_KEY` (the value is never used upstream — the proxy re-auths).
   */
  readonly env: Record<string, string>;
  /**
   * `-c key=value` config overrides appended to the Codex argv. These override
   * `~/.codex/config.toml` for THIS spawn only, pointing the CLI at the proxy:
   *   `-c model_provider="omnicross"`
   *   `-c model_providers.omnicross.name="omnicross"`
   *   `-c model_providers.omnicross.base_url="http://127.0.0.1:<port>/openai"`
   *   `-c model_providers.omnicross.wire_api="responses"`
   *   `-c model_providers.omnicross.requires_openai_auth=true`
   * (`requires_openai_auth` is an UNQUOTED boolean — TOML overrides are typed.)
   */
  readonly extraArgs: string[];
  /** Stops the booted proxy listener. Best-effort; never throws. */
  readonly onSessionEnd: () => void;
  /** Listener base (`http://127.0.0.1:<port>`); CLI appends `/openai/responses`. */
  readonly baseUrl: string;
}

/**
 * Build the `-c` config overrides that redirect the Codex CLI at the proxy.
 * Split out so it can be unit-tested without booting a server (the values are
 * the load-bearing contract — the TOML keys + types the CLI must receive).
 *
 * @param baseUrl listener base (`http://127.0.0.1:<port>`)
 */
export function buildCodexConfigOverrides(baseUrl: string): string[] {
  const name = CODEX_PROXY_PROVIDER_NAME;
  const providerBaseUrl = `${baseUrl}${CODEX_PROXY_BASE_PATH}`;
  return [
    '-c',
    `model_provider="${name}"`,
    '-c',
    `model_providers.${name}.name="${name}"`,
    '-c',
    `model_providers.${name}.base_url="${providerBaseUrl}"`,
    '-c',
    `model_providers.${name}.wire_api="responses"`,
    // requires_openai_auth is a boolean — UNQUOTED so the TOML override is typed
    // as a bool, not the string "true".
    '-c',
    `model_providers.${name}.requires_openai_auth=true`,
    // disable_response_storage: the CLI sends full context each turn (no
    // server-side response store) — required because the proxy upstream is
    // stateless w.r.t. Codex's response-id store (design Q3 contract).
    '-c',
    'disable_response_storage=true',
  ];
}

/**
 * Boot the codex proxy route and return the launch redirection for the Codex CLI
 * subprocess. The analogue of `buildProviderEnvWithProxy` for the Codex CLI.
 *
 * Lifecycle: this starts the proxy (so `baseUrl` has a real port) and returns an
 * `onSessionEnd` that stops it — the caller wires `onSessionEnd` into the run's
 * cleanup (the host CLI runner's `finally`), exactly as provider-env callers wire
 * `ProviderEnvResult.onSessionEnd`.
 *
 * In BYO mode this validates the provider row + key up front and throws a clear
 * error (no proxy is started) when the key is missing, mirroring
 * `buildProviderEnvWithProxy`'s empty-env error contract — except here we throw
 * rather than return `{}` because the CLI launch has no "fall back to process.env"
 * path that would make sense for a Responses-API redirect.
 */
export async function buildCodexLaunchConfig(
  inputs: CodexLaunchConfigInputs
): Promise<CodexLaunchConfig> {
  const authMode: RouteAuthMode = inputs.authMode ?? 'byo';

  // BYO: validate provider + key BEFORE booting the listener so a misconfigured
  // provider surfaces a clear error instead of a dead listener.
  if (authMode === 'byo') {
    const provider = await inputs.llmConfig.getProvider(inputs.providerId);
    if (!provider) {
      throw new Error(
        `Codex proxy: provider not found: ${inputs.providerId}. ` +
          'Add an OpenAI-compatible provider in Settings → LLM Providers.'
      );
    }
    const { apiKey } = resolveProviderEndpoint(provider);
    const resolved = resolveApiKey(apiKey);
    if (!resolved) {
      throw new Error(
        `Codex proxy: provider "${inputs.providerId}" has no valid API key. ` +
          'Add an API key in Settings → LLM Providers.'
      );
    }
  } else if (!inputs.subscriptionProfile) {
    throw new Error('Codex proxy: subscription mode requires a codex subscription profile.');
  }

  // Register a route on the resident `ProviderProxy` (engine-provider-decouple
  // task 2.9) instead of booting a per-session proxy. The resident
  // proxy's OpenAI-Responses ingress is a faithful re-expression of
  // the host's codex request handler; per-run state (providerId/model/auth) rides the
  // `RouteContext`, and the proxy's app-wide deps supply apiKeyPool +
  // usageRecorder (the per-call inputs here are kept for caller compat but the
  // proxy's wired singletons are the SAME instances).
  const route: RouteContext = {
    sessionId: inputs.sessionId ?? null,
    targetProviderFormat: 'openai-responses',
    model: inputs.model,
    ingressFormat: 'openai-responses',
    authMode,
    providerId: inputs.providerId,
    subscriptionProfile: inputs.subscriptionProfile ?? null,
  };

  const proxy = getProviderProxy();
  const token = proxy.addRoute(route);
  const baseUrl = proxy.getBaseUrl();

  console.log('[buildCodexLaunchConfig] Codex route ready', {
    sessionId: inputs.sessionId,
    baseUrl,
    providerId: inputs.providerId,
    model: inputs.model,
    authMode,
  });

  return {
    env: {
      // Satisfy the CLI's `requires_openai_auth = true` precondition. The CLI
      // forwards this as the Responses-API key; the resident proxy uses it as
      // the route TOKEN (looked up, then discarded) and re-authenticates
      // upstream from the route's own provider/subscription credential.
      OPENAI_API_KEY: token,
    },
    extraArgs: buildCodexConfigOverrides(baseUrl),
    baseUrl,
    onSessionEnd: () => {
      // Resident proxy stays up for the app session — only drop this run's route.
      proxy.removeRoute(token);
    },
  };
}

/** Resolve an `$ENV_VAR` reference or return the literal key (mirrors provider-env.ts). */
function resolveApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) {
    return process.env[apiKey.slice(1)] || '';
  }
  return apiKey;
}
