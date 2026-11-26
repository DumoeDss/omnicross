/**
 * Host-configurable route-lease launch descriptors for the embedding entry.
 *
 * The standalone daemon uses `@omnicross/cli-launcher`'s descriptors, which name
 * the product in the Codex `model_provider` block, the Codex token env var and
 * the Claude placeholder key. An embedding host's users never see that name, so
 * this module builds the SAME launch shapes from host-supplied identifiers, with
 * neutral defaults. The proxy authenticates by route token only — none of these
 * names reach it — so any well-formed value works.
 *
 * @module @omnicross/daemon/embed/descriptors
 */

import {
  RouteLeaseError,
  type RouteLeaseDescriptorPort,
  type RouteLeaseRuntime,
  type RuntimeLaunchDescriptor,
} from '@omnicross/core/provider-proxy';

/** Identifiers the Claude CLI launch env carries. */
export interface ClaudeLaunchIdentity {
  /**
   * Non-secret `ANTHROPIC_API_KEY` placeholder (the route token rides
   * `ANTHROPIC_AUTH_TOKEN`). Default `local-proxy`.
   */
  readonly apiKeyPlaceholder?: string;
  /** Extra env merged into every Claude launch (host-owned, non-secret). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/** Identifiers the Codex CLI `-c` overrides and env carry. */
export interface CodexLaunchIdentity {
  /** `model_provider` id (a TOML bare key). Default `local-proxy`. */
  readonly providerId?: string;
  /** `model_providers.<id>.name` display name. Default `Local Proxy`. */
  readonly providerName?: string;
  /** Env var named by `env_key` that holds the route token. Default `LOCAL_PROXY_ROUTE_TOKEN`. */
  readonly tokenEnv?: string;
  /**
   * Value of the `X-OpenAI-Actor-Authorization` header that makes Codex expose
   * its image tool for a custom provider (not a credential). `false` omits the
   * header. Default: the provider id.
   */
  readonly imageToolMarker?: string | false;
  /** Extra `-c` style args appended after the redirect overrides. */
  readonly extraArgs?: readonly string[];
}

/** Options for {@link createRouteLeaseDescriptors}. */
export interface RouteLeaseDescriptorOptions {
  readonly claude?: ClaudeLaunchIdentity;
  readonly codex?: CodexLaunchIdentity;
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_TEXT = /^[^"\\\u0000-\u001f\u007f]{1,128}$/u;

function checked(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value)) throw new TypeError(`route lease descriptor: ${field} is not a valid value`);
  return value;
}

/**
 * Build a {@link RouteLeaseDescriptorPort} for the `claude` and `codex` runtimes
 * from host identifiers. Throws a `TypeError` at construction for values that
 * would break the CLI's config parsing (quotes, control characters, non-key
 * characters).
 */
export function createRouteLeaseDescriptors(
  options: RouteLeaseDescriptorOptions = {},
): RouteLeaseDescriptorPort {
  const claudeKey = checked(options.claude?.apiKeyPlaceholder ?? 'local-proxy', SAFE_TEXT, 'claude.apiKeyPlaceholder');
  const claudeExtraEnv = { ...(options.claude?.extraEnv ?? {}) };
  for (const name of Object.keys(claudeExtraEnv)) checked(name, ENV_NAME, `claude.extraEnv name '${name}'`);

  const providerId = checked(options.codex?.providerId ?? 'local-proxy', TOML_BARE_KEY, 'codex.providerId');
  const providerName = checked(options.codex?.providerName ?? 'Local Proxy', SAFE_TEXT, 'codex.providerName');
  const tokenEnv = checked(options.codex?.tokenEnv ?? 'LOCAL_PROXY_ROUTE_TOKEN', ENV_NAME, 'codex.tokenEnv');
  const marker = options.codex?.imageToolMarker === undefined ? providerId : options.codex.imageToolMarker;
  if (marker !== false) checked(marker, SAFE_TEXT, 'codex.imageToolMarker');
  const codexExtraArgs = [...(options.codex?.extraArgs ?? [])];

  const codexArgs = (proxyBaseUrl: string): string[] => {
    const providerBaseUrl = `${proxyBaseUrl}/openai`;
    return [
      '-c', `model_provider="${providerId}"`,
      '-c', `model_providers.${providerId}.name="${providerName}"`,
      '-c', `model_providers.${providerId}.base_url="${providerBaseUrl}"`,
      '-c', `model_providers.${providerId}.wire_api="responses"`,
      '-c', `model_providers.${providerId}.env_key="${tokenEnv}"`,
      ...(marker === false
        ? []
        : ['-c', `model_providers.${providerId}.http_headers={"X-OpenAI-Actor-Authorization"="${marker}"}`]),
      // The proxy is stateless w.r.t. Codex's response-id store; Codex must send
      // full context every turn.
      '-c', 'disable_response_storage=true',
      ...codexExtraArgs,
    ];
  };

  return {
    has(runtime: RouteLeaseRuntime): boolean {
      return runtime === 'claude' || runtime === 'codex';
    },
    build(runtime, input): RuntimeLaunchDescriptor {
      switch (runtime) {
        case 'claude':
          return {
            env: {
              ...claudeExtraEnv,
              ANTHROPIC_BASE_URL: input.proxyBaseUrl,
              ANTHROPIC_AUTH_TOKEN: input.routeToken,
              ANTHROPIC_API_KEY: claudeKey,
              ANTHROPIC_MODEL: input.model,
            },
            extraArgs: [],
          };
        case 'codex':
          return { env: { [tokenEnv]: input.routeToken }, extraArgs: codexArgs(input.proxyBaseUrl) };
        default:
          throw new RouteLeaseError('runtime_unsupported', 'runtime launch adapter is unavailable');
      }
    },
  };
}
