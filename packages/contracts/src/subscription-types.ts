/**
 * Multi-subscription dispatch contracts.
 *
 * Subscription providers are catalog entries that route an agent through a
 * user's third-party subscription (Claude Pro/Max, ChatGPT Plus/Pro via Codex
 * OAuth, Google Gemini OAuth, OpenCodeGo Bearer key). They are distinct from
 * user-configured LLM providers.
 *
 * Holds the provider-id / OpenCodeGo / status / list contracts plus the resolver
 * helpers the `@omnicross/*` packages consume.
 */

/** Stable IDs for built-in subscription providers. */
export type SubscriptionProviderId = 'claude' | 'codex' | 'gemini' | 'opencodego';

/**
 * OpenCodeGo routing scenarios, mirroring `_others/oc-go-cc/internal/router/`
 * (and `_others/oc-go-cc/configs/config.example.json`).
 *
 * `background` is DORMANT in this version: the scenario router never
 * auto-selects it (keyword-driven selection is a downstream change). It is
 * reachable ONLY when a user explicitly keys `background` in
 * `OpenCodeGoTokenConfig.modelMap` / `fallbacks`.
 */
export type OpenCodeGoScenario =
  | 'default'
  | 'long_context'
  | 'think'
  | 'complex'
  | 'fast'
  | 'background';

/** One entry of the OpenCodeGo model map — selected by the scenario router. */
export interface OpenCodeGoModelEntry {
  /** Provider model id sent upstream (e.g. `kimi-k2.6`, `minimax-m2.5`). */
  modelId: string;
  /**
   * Which opencode provider HALF this model lives on. Mirrors the reference
   * `ModelConfig.Provider` (`_others/oc-go-cc`). When ABSENT it defaults to
   * `'go'` (the reference's `Provider("")` → `opencode-go`), so every existing
   * stored config behaves byte-identically (no zen traffic). The built-in
   * default `modelMap`/`fallbacks` are entirely `'go'`; a `'zen'` model is
   * reachable ONLY via a user-supplied entry that explicitly sets this field
   * (strict user-only parity, mirroring the reference's `model_overrides`).
   */
  provider?: 'go' | 'zen';
  /** Optional temperature override. */
  temperature?: number;
  /** Optional max_tokens override. */
  maxTokens?: number;
  /** When set, the scenario router only picks this entry when the estimated
   *  cl100k_base input-token count meets/exceeds the threshold. */
  contextThreshold?: number;
}

/**
 * Persisted OpenCodeGo subscription configuration. Mirrors the
 * Claude/Codex/Gemini siblings in `account-tokens-types.ts` but is
 * static-bearer only (no OAuth, no refresh token).
 */
export interface OpenCodeGoTokenConfig {
  /** No OAuth — only manual API key entry is supported. */
  authMethod: 'manual';
  status: 'unconfigured' | 'configured' | 'error';
  /** Encrypted on disk; decrypted in memory only via the host's token store. */
  apiKey?: string;
  /** Optional override of the default OpenCodeGo upstream host. Applies to the
   *  GO half ONLY (mirrors the reference's `OC_GO_CC_OPENCODE_URL`); the zen
   *  half is overridden by `zenBaseUrl`. */
  baseUrl?: string;
  /** Optional override of the default opencode-ZEN upstream host. Applies to the
   *  ZEN half ONLY (mirrors the reference's `OC_GO_CC_OPENCODE_ZEN_URL`). When
   *  unset, zen models resolve under the built-in zen constants. A go-half
   *  override (`baseUrl`) NEVER redirects zen traffic and vice-versa. */
  zenBaseUrl?: string;
  /** Optional override of the built-in model map per scenario. */
  modelMap?: Partial<Record<OpenCodeGoScenario, OpenCodeGoModelEntry>>;
  /** Optional override of the built-in fallback chain per scenario. */
  fallbacks?: Partial<Record<OpenCodeGoScenario, OpenCodeGoModelEntry[]>>;
  lastRefreshedAt?: string;
  errorMessage?: string;
}

/** Sanitized view of `OpenCodeGoTokenConfig` for client display. */
export interface OpenCodeGoTokenSanitized {
  authMethod: 'manual';
  status: 'unconfigured' | 'configured' | 'error';
  hasApiKey: boolean;
  baseUrl?: string;
  /** Mirrors `OpenCodeGoTokenConfig.zenBaseUrl` (zen-half host override) for
   *  client display parity with `baseUrl`. */
  zenBaseUrl?: string;
  lastRefreshedAt?: string;
  errorMessage?: string;
}

/** Status of a single subscription provider, surfaced by `subscription:status`. */
export interface SubscriptionStatusEntry {
  providerId: SubscriptionProviderId;
  ok: boolean;
  /** Machine-readable reason when `ok === false`. */
  reason?:
    | 'missing-credential'
    | 'expired'
    | 'reauth-required'
    | 'refresh-failed'
    | 'not-refreshable'
    | 'unknown';
  /** ISO timestamp when the credential expires (OAuth providers only). */
  expiresAt?: string;
}

/** Catalog entry returned by `subscription:list`. */
export interface SubscriptionListEntry {
  providerId: SubscriptionProviderId;
  displayName: string;
  /** Auth model — same discriminator as the dispatch `AuthStrategy.kind`. */
  kind: 'pass-through' | 'oauth-bearer' | 'static-bearer';
  credentialStatus: SubscriptionStatusEntry;
}

/**
 * Map a legacy `cliBackend` engine-marker token to the subscription-target
 * `SubscriptionProviderId` it used to imply. Pre-D6
 * (`provider-proxy-transformer-matrix`) the subscription target was DERIVED
 * from `cliBackend`; this function preserves that derivation as a backfill /
 * in-flight fallback only. New sessions carry an explicit
 * `subscriptionProviderId` and SHOULD NOT rely on this.
 *
 * `'opencodego'` is intentionally accepted as an input here even though it is
 * no longer a `CodeCliBackend` member — the migration backfill reads raw DB
 * rows that may still hold the legacy token.
 */
export function legacyCliBackendToSubscriptionProvider(
  cliBackend: string | null | undefined,
): SubscriptionProviderId | null {
  switch (cliBackend) {
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'gemini-cli':
      return 'gemini';
    case 'opencodego':
      return 'opencodego';
    default:
      return null;
  }
}

/**
 * Resolve the subscription-target `SubscriptionProviderId` for a session.
 *
 * Precedence (D6): the EXPLICIT `subscriptionProviderId` field wins. When it
 * is unset (in-flight rows created before the field existed / before backfill),
 * fall back to the legacy `cliBackend`-derived mapping. Returns `null` when
 * neither resolves — the caller treats that as "no subscription target".
 *
 * This is the SINGLE place engine code should consult to find a session's
 * upstream subscription Provider — never the `cliBackend` token directly.
 */
export function subscriptionTargetForSession(session: {
  subscriptionProviderId?: SubscriptionProviderId | null;
  cliBackend?: string | null;
}): SubscriptionProviderId | null {
  return (
    session.subscriptionProviderId ??
    legacyCliBackendToSubscriptionProvider(session.cliBackend)
  );
}

/**
 * Provider-channel axis (Axis 2) — HOW a session's provider credential is
 * sourced / routed, orthogonal to the engine (Axis 1, `EngineType`).
 *
 * - `native`       — the provider's own egress (e.g. a CLI binary talking to
 *                    its own backend, or a direct first-party API). Replaces
 *                    the old `EngineSource = 'cli'` value.
 * - `subscription` — routed through a user's third-party subscription
 *                    (Claude Pro/Max, Codex/ChatGPT, Gemini, OpenCodeGo).
 * - `relay`        — routed through a relay / proxy endpoint.
 * - `api-key`      — routed with a user-supplied BYO API key.
 *
 * Renamed from `EngineSource` and value-space-expanded by the
 * `engine-provider-decouple` change (Phase 0). The engine type is now a pure
 * `f(engine)` lookup and no longer reads this axis; per-channel injection
 * wiring lands in Phase 1b.
 */
export type ProviderChannel = 'native' | 'subscription' | 'relay' | 'api-key';
