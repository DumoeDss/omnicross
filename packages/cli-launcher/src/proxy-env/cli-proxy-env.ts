/**
 * Per-CLI launch-config builders for the GENUINELY-NEW interceptable backends
 * (qwen / copilot / opencode) — the OpenAI-Chat-Completions analogue of
 * `codex/codex-proxy-env.ts`'s `buildCodexLaunchConfig`.
 *
 * Each backend's model egress is redirected at the resident `ProviderProxy`'s
 * OpenAI Chat Completions ingress (`POST <base>/v1/chat/completions`). Like the
 * codex builder, this registers ONE route on the resident proxy (`addRoute →
 * token`) and returns an `onSessionEnd` that drops it. The route TOKEN is
 * forwarded by the CLI as its API key; the proxy looks it up, discards it, and
 * re-authenticates upstream from the route's own provider credential — so the
 * key the CLI carries is never used upstream.
 *
 * The redirect MECHANISM differs per CLI (from the 2026-05-27 R1/R2 research):
 *   - qwen-code:  env `OPENAI_BASE_URL` + `OPENAI_API_KEY` (token) + `OPENAI_MODEL`.
 *   - copilot:    env `COPILOT_PROVIDER_BASE_URL` + `COPILOT_PROVIDER_TYPE=openai`
 *                 + `COPILOT_PROVIDER_API_KEY` (token) + `COPILOT_MODEL`.
 *   - opencode:   a CONFIG FILE (`@ai-sdk/openai-compatible` adapter, no base-url
 *                 env redirect — the anthropic adapter's baseURL is buggy). The
 *                 file sets `provider.<id>.options.baseURL` + `apiKey:"{env:VAR}"`
 *                 with the token in that env var; opencode is fixed to this
 *                 provider until restart (NOT live-reconfigurable mid-session).
 *
 * Gating (the two-bucket rule) lives in the CALLER (`applyCliProxyForCli`):
 * these builders are invoked ONLY for `providerChannel ∈ {api-key, relay}`.
 *
 * @module @omnicross/cli-launcher/proxy-env/cli-proxy-env
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderConfigSource, UsageRecorderImport } from '@omnicross/core';
import { resolveProviderEndpoint } from '@omnicross/core/completion';
import type { ApiKeyPoolService } from '@omnicross/core/completion/ApiKeyPoolService';
import type { RouteContext } from '@omnicross/core/provider-proxy';
import { getProviderProxy } from '@omnicross/core/provider-proxy';

/** Which genuinely-new chat-completions backend this launch config is for. */
export type ChatCliBackendId = 'qwen' | 'copilot' | 'opencode';

/**
 * The base PATH the OpenAI Chat Completions ingress is served under. The proxy
 * matches any path ENDING in `/chat/completions`; we serve the canonical
 * `/v1/chat/completions` so the qwen / copilot OpenAI clients append nothing
 * (they treat `OPENAI_BASE_URL` as `<base>` and POST `<base>/chat/completions`,
 * so the base we hand them is `<listener>/v1`).
 */
export const CHAT_PROXY_BASE_PATH = '/v1';

/**
 * The opencode provider id written into the session-scoped config file. Distinct,
 * proxy-owned so it can never collide with a provider in the user's own opencode
 * config.
 */
export const OPENCODE_PROXY_PROVIDER_ID = 'omnicross';

/** The env var the opencode config's `apiKey:"{env:VAR}"` reference resolves. */
export const OPENCODE_PROXY_TOKEN_ENV = 'OMNICROSS_OPENCODE_TOKEN';

/** Inputs for `buildChatCliLaunchConfig`. */
export interface ChatCliLaunchConfigInputs {
  readonly backendId: ChatCliBackendId;
  readonly llmConfig: ProviderConfigSource;
  /** OpenAI-compatible provider row id (BYO / api-key / relay) the proxy re-auths with. */
  readonly providerId: string;
  /** The provider model the CLI's model name is mapped to. */
  readonly model: string;
  /** Pool for session-affine key selection + 429/401 failover (optional). */
  readonly apiKeyPool?: ApiKeyPoolService | null;
  /** Session id for pool affinity + usage attribution. */
  readonly sessionId?: string | null;
  /** Usage recorder — when set, non-stream chat-ingress usage is persisted. */
  readonly usageRecorder?: UsageRecorderImport | null;
}

/**
 * The launch redirection for a chat-completions CLI subprocess. Mirrors
 * `CodexLaunchConfig`: `env` + `onSessionEnd`, plus the listener `baseUrl`. (No
 * `extraArgs` — these backends redirect via env / config file, not CLI flags.)
 */
export interface ChatCliLaunchConfig {
  /** Env vars to merge into the CLI subprocess env (redirect + auth sentinel). */
  readonly env: Record<string, string>;
  /** Listener base (`http://127.0.0.1:<port>`). */
  readonly baseUrl: string;
  /** Drop this run's route (+ clean up any temp config file). Best-effort; never throws. */
  readonly onSessionEnd: () => void;
}

/**
 * Build the env + route for a chat-completions CLI redirect. Validates the
 * provider row + key up front (throws BEFORE registering a route when the
 * provider is missing / keyless), then registers one route on the resident proxy
 * and shapes the per-backend env.
 */
export async function buildChatCliLaunchConfig(
  inputs: ChatCliLaunchConfigInputs,
): Promise<ChatCliLaunchConfig> {
  const provider = await inputs.llmConfig.getProvider(inputs.providerId);
  if (!provider) {
    throw new Error(
      `${inputs.backendId} proxy: provider not found: ${inputs.providerId}. ` +
        'Add an OpenAI-compatible provider in Settings → LLM Providers.',
    );
  }
  const { apiKey } = resolveProviderEndpoint(provider);
  if (!resolveApiKey(apiKey)) {
    throw new Error(
      `${inputs.backendId} proxy: provider "${inputs.providerId}" has no valid API key. ` +
        'Add an API key in Settings → LLM Providers.',
    );
  }

  // Register the OpenAI Chat Completions route on the resident proxy.
  const route: RouteContext = {
    sessionId: inputs.sessionId ?? null,
    targetProviderFormat: 'transform',
    model: inputs.model,
    ingressFormat: 'openai-chat',
    authMode: 'byo',
    providerId: inputs.providerId,
  };
  const proxy = getProviderProxy();
  const token = proxy.addRoute(route);
  const baseUrl = proxy.getBaseUrl();
  const chatBase = `${baseUrl}${CHAT_PROXY_BASE_PATH}`;

  const cleanups: Array<() => void> = [() => proxy.removeRoute(token)];
  const env = buildBackendEnv(inputs.backendId, {
    chatBase,
    baseUrl,
    token,
    model: inputs.model,
    cleanups,
  });

  console.log('[buildChatCliLaunchConfig] chat-CLI route ready', {
    backendId: inputs.backendId,
    sessionId: inputs.sessionId,
    baseUrl,
    providerId: inputs.providerId,
    model: inputs.model,
  });

  return {
    env,
    baseUrl,
    onSessionEnd: () => {
      for (const c of cleanups) {
        try {
          c();
        } catch {
          // best-effort
        }
      }
    },
  };
}

interface BackendEnvCtx {
  readonly chatBase: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly model: string;
  readonly cleanups: Array<() => void>;
}

/** Shape the per-backend env (and, for opencode, write the session config file). */
function buildBackendEnv(backendId: ChatCliBackendId, ctx: BackendEnvCtx): Record<string, string> {
  switch (backendId) {
    case 'qwen':
      // OpenAI-client env: base + key (token) + model. The qwen client POSTs
      // `<OPENAI_BASE_URL>/chat/completions`, so the base is `<listener>/v1`.
      return {
        OPENAI_BASE_URL: ctx.chatBase,
        OPENAI_API_KEY: ctx.token,
        OPENAI_MODEL: ctx.model,
      };
    case 'copilot':
      // Copilot custom-provider env (v2026-04-07+). PROVIDER_BASE_URL is the
      // OpenAI base; copilot appends `/chat/completions` itself.
      return {
        COPILOT_PROVIDER_BASE_URL: ctx.chatBase,
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_PROVIDER_API_KEY: ctx.token,
        COPILOT_MODEL: ctx.model,
      };
    case 'opencode':
      return buildOpencodeEnv(ctx);
    default: {
      const _exhaustive: never = backendId;
      throw new Error(`Unsupported chat CLI backend: ${String(_exhaustive)}`);
    }
  }
}

/**
 * opencode redirect: write a session-scoped config file (`@ai-sdk/openai-compatible`
 * adapter) and point opencode at it via `OPENCODE_CONFIG`. The token rides the
 * `OMNICROSS_OPENCODE_TOKEN` env var, referenced by `apiKey:"{env:…}"` in the file
 * (opencode's documented env-substitution syntax) so the secret is not written to
 * disk. Registers a cleanup that removes the temp dir on session end.
 *
 * ASSUMPTION (flagged): opencode honors the `OPENCODE_CONFIG` env var pointing at
 * a JSON config file, and the `@ai-sdk/openai-compatible` npm adapter is selected
 * via `provider.<id>.npm`. This is the most-documented opencode config path; if a
 * given opencode build instead requires a project-local `opencode.json`, this
 * env-located file would be ignored. The base-url redirect lives in the FILE (not
 * an env var) per the design's "config file, no env redirect, needs restart" rule.
 */
function buildOpencodeEnv(ctx: BackendEnvCtx): Record<string, string> {
  const id = OPENCODE_PROXY_PROVIDER_ID;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [id]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Omnicross Proxy',
        options: {
          baseURL: ctx.chatBase,
          apiKey: `{env:${OPENCODE_PROXY_TOKEN_ENV}}`,
        },
        models: {
          [ctx.model]: {},
        },
      },
    },
  };

  const dir = mkdtempSync(join(tmpdir(), 'omnicross-opencode-'));
  const configPath = join(dir, 'opencode.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  ctx.cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  return {
    OPENCODE_CONFIG: configPath,
    [OPENCODE_PROXY_TOKEN_ENV]: ctx.token,
  };
}

// ===========================================================================
// gemini-CLI (SPECIAL CASE — api-key/relay ONLY; forces API-key mode)
// ===========================================================================

/**
 * Inputs for `buildGeminiCliLaunchConfig`. Same shape as the chat-CLI inputs
 * minus `backendId` (this builder is gemini-CLI only).
 */
export interface GeminiCliLaunchConfigInputs {
  readonly llmConfig: ProviderConfigSource;
  /** OpenAI-/Gemini-compatible provider row id the proxy re-auths with. */
  readonly providerId: string;
  /** The provider model the gemini-CLI's path model is mapped to. */
  readonly model: string;
  readonly apiKeyPool?: ApiKeyPoolService | null;
  readonly sessionId?: string | null;
  readonly usageRecorder?: UsageRecorderImport | null;
}

/**
 * Build the env + route for the gemini-CLI redirect (api-key/relay ONLY).
 *
 * The gemini-CLI treats `GOOGLE_GEMINI_BASE_URL` as the API BASE and itself
 * appends `/v1beta/models/<model>:generateContent` (or `:streamGenerateContent`),
 * so the base we hand it is the listener ROOT (no `/v1` suffix — unlike the
 * chat-completions CLIs). The route TOKEN rides `GEMINI_API_KEY`; the gemini-CLI
 * forwards it as the `x-goog-api-key` header, which the proxy router reads for
 * the route lookup and then discards (re-authing upstream from the route's own
 * provider credential).
 *
 * CRITICAL — force API-key mode: the gemini-CLI's DEFAULT egress is the
 * OAuth/Code-Assist (`LOGIN_WITH_GOOGLE`) path, which talks to
 * `cloudcode-pa.googleapis.com` and is NOT interceptable. The CLI's
 * auth-selection treats the PRESENCE of `GEMINI_API_KEY` as
 * `AuthType.USE_GEMINI` (the Gemini-API-key path that DOES honor
 * `GOOGLE_GEMINI_BASE_URL`). We additionally set `GOOGLE_GENAI_USE_GCA=false` to
 * defensively suppress the Code-Assist branch, and deliberately do NOT set
 * `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_CLOUD_PROJECT` (which
 * would steer the CLI onto the Vertex egress). See the change notes for the
 * binary-unverified caveat.
 */
export async function buildGeminiCliLaunchConfig(
  inputs: GeminiCliLaunchConfigInputs,
): Promise<ChatCliLaunchConfig> {
  const provider = await inputs.llmConfig.getProvider(inputs.providerId);
  if (!provider) {
    throw new Error(
      `gemini-cli proxy: provider not found: ${inputs.providerId}. ` +
        'Add a Gemini-compatible provider in Settings → LLM Providers.',
    );
  }
  const { apiKey } = resolveProviderEndpoint(provider);
  if (!resolveApiKey(apiKey)) {
    throw new Error(
      `gemini-cli proxy: provider "${inputs.providerId}" has no valid API key. ` +
        'Add an API key in Settings → LLM Providers.',
    );
  }

  // Register the Gemini generateContent route on the resident proxy.
  const route: RouteContext = {
    sessionId: inputs.sessionId ?? null,
    targetProviderFormat: 'transform',
    model: inputs.model,
    ingressFormat: 'gemini-generatecontent',
    authMode: 'byo',
    providerId: inputs.providerId,
  };
  const proxy = getProviderProxy();
  const token = proxy.addRoute(route);
  const baseUrl = proxy.getBaseUrl();

  console.log('[buildGeminiCliLaunchConfig] gemini-CLI route ready (forced API-key)', {
    sessionId: inputs.sessionId,
    baseUrl,
    providerId: inputs.providerId,
    model: inputs.model,
  });

  // base = listener ROOT (the gemini-CLI appends `/v1beta/models/<model>:...`).
  const env: Record<string, string> = {
    GOOGLE_GEMINI_BASE_URL: baseUrl,
    GEMINI_API_KEY: token,
    GEMINI_MODEL: inputs.model,
    // Force API-key mode off the OAuth/Code-Assist (non-interceptable) path.
    GOOGLE_GENAI_USE_GCA: 'false',
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

/** Resolve an `$ENV_VAR` reference or return the literal key. */
function resolveApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) {
    return process.env[apiKey.slice(1)] || '';
  }
  return apiKey;
}
