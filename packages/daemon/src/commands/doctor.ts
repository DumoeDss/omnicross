/**
 * commands/doctor.ts — `omnicross doctor claude` (§9, claude-api-experience-extras).
 *
 * A READ-ONLY local health check for the Claude/Anthropic gateway surface:
 * loads the SAME persisted config `omnicross start` serves (same loadConfig →
 * buildDaemon → loadServerConfig path — no second parser), runs a PURE-FUNCTION
 * check array (no IO, table-testable), prints a human-readable report, and sets
 * a per-item-informed exit code (0 = all pass, 1 = any hard failure).
 *
 * `--live` optionally sends ONE minimal `/v1/messages/count_tokens` to a running
 * gateway (the FREE endpoint — zero generation calls) and reports the status +
 * the `x-omnicross-count-estimate` marker header. No interactive repair.
 *
 * @module @omnicross/daemon/commands/doctor
 */

import { parseArgs } from 'node:util';

import type {
  SearchProviderCapabilities,
  SearchProviderDiagnostic,
} from '@omnicross/contracts/search-types';
import {
  DEFAULT_IMAGES_SERVER_CONFIG,
  loadServerConfig,
} from '@omnicross/core/outbound-api';
import type {
  GatewayBinding,
  OutboundApiServerConfig,
  SearchServerConfig,
} from '@omnicross/core/outbound-api/types';
import {
  apiSearchContributions,
  type SearchApiProviderConfigs,
} from '@omnicross/core/search/api';
import { builtinHttpSearchContributions } from '@omnicross/core/search/http';
import {
  DEFAULT_SEARCH_FRONTEND_MODES,
  SEARCH_FRONTEND_NAMES,
  type SearchRuntime,
} from '@omnicross/core/search';

import { buildDaemon, type DaemonPaths } from '../bootstrap';
import { loadConfig } from '../config';
import type {
  ImageDoctorLocalSnapshot,
  ImageDoctorService,
} from '../image-generation/ImageDoctorService';
import {
  buildSearchDoctorSnapshot,
  runSearchLiveChecks,
  SEARCH_DOCTOR_QUERY,
  type SearchProviderDeclaration,
} from '../search/searchDoctorProjection';

import { defaultKeysPath, defaultTokensPath } from './paths';

// search-settings-ui: the pure search-doctor vocabulary moved to
// `search/searchDoctorProjection.ts` (a leaf the admin router can import
// without the bootstrap cycle). Re-exported here so existing importers — the
// tests and the CLI — keep their `commands/doctor` surface unchanged.
export {
  buildSearchDoctorSnapshot,
  classifyLiveSearchOutcome,
  runSearchLiveChecks,
  SEARCH_DOCTOR_QUERY,
} from '../search/searchDoctorProjection';
export type {
  LiveSearchOutcome,
  SearchDoctorRow,
  SearchProviderDeclaration,
} from '../search/searchDoctorProjection';

/** One doctor finding. `warn` items print ⚠; out-of-range warns co-occur with `ok:false` and flip the exit code to 1. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** Advisory severity (prints as a warning); exit behavior is governed by `ok` alone. */
  warn?: boolean;
  detail: string;
}

/** The spec-recommended heartbeat window (§8/§10): 15–30s. */
export const RECOMMENDED_HEARTBEAT_MS: readonly [number, number] = [15_000, 30_000];

/**
 * The pure check array (no IO — table-testable). Inputs: the NORMALIZED server
 * config. Checks: messages routing readiness (hard), countTokens mode +
 * modelsShape + proxyOauthUsage/apiHello reports (informational), heartbeat
 * interval range (warn outside 15–30s; ≤0 noted as disabled).
 */
export function buildClaudeDoctorChecks(config: OutboundApiServerConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // A messages route is READY only when it can actually route: passthrough
  // mode, at least one non-blank modelMapping source, or a kind map with at
  // least one NON-EMPTY ref (a blank-ref kind is unroutable — mirrors the
  // models-list advertising rule). Spec scenario: blank-ref-only ⇒ not ready.
  const isRoutableMessagesRoute = (binding: GatewayBinding): boolean =>
    binding.enabled &&
    binding.endpoint === 'messages' &&
    (binding.modelMode === 'passthrough' ||
      (binding.modelMappings ?? []).some((m) => m.source.trim() !== '') ||
      Object.values(binding.modelMap ?? {}).some((ref) => typeof ref === 'string' && ref.trim() !== ''));
  const messagesRoutes = (config.bindings ?? []).filter(
    (binding) => binding.enabled && binding.endpoint === 'messages',
  );
  const readyRoutes = messagesRoutes.filter(isRoutableMessagesRoute);
  checks.push({
    name: 'messages routing',
    ok: readyRoutes.length > 0,
    detail:
      readyRoutes.length > 0
        ? `${readyRoutes.length} ready route(s): ${readyRoutes.map((b) => b.name).join(', ')}`
        : messagesRoutes.length > 0
          ? 'enabled messages route(s) exist but none carry a routable target (all refs blank)'
          : 'no enabled messages-endpoint route — Claude Code requests will 503',
  });

  const anthropic = config.anthropic;
  const mode = anthropic?.countTokens?.mode ?? 'auto';
  checks.push({
    name: 'count_tokens mode',
    ok: ['auto', 'passthrough', 'estimate', 'reject'].includes(mode),
    detail: `mode=${mode} (auto: Anthropic-wire → passthrough, translation → estimate)`,
  });

  const shape = anthropic?.modelsShape ?? 'auto';
  checks.push({
    name: 'models shape',
    ok: ['auto', 'anthropic', 'openai'].includes(shape),
    detail: `modelsShape=${shape} (auto: messages-authorized keys get the Anthropic list shape)`,
  });

  const heartbeat = anthropic?.heartbeatIntervalMs ?? 20_000;
  const [lo, hi] = RECOMMENDED_HEARTBEAT_MS;
  const inRange = heartbeat >= lo && heartbeat <= hi;
  checks.push({
    name: 'synthetic ping heartbeat',
    // Spec scenario: an out-of-range positive interval is a FAILURE (exit 1);
    // ≤0 (disabled) is a legal configuration and only informational.
    ok: inRange || heartbeat <= 0,
    warn: !inRange && heartbeat > 0,
    detail:
      heartbeat <= 0
        ? 'disabled (≤0) — silent translation streams have no keepalive'
        : `${heartbeat}ms${inRange ? '' : ` (outside the recommended ${lo}-${hi}ms window)`}`,
  });

  checks.push({
    name: 'oauth usage proxy',
    ok: true,
    detail: `proxyOauthUsage=${anthropic?.proxyOauthUsage === true} (default false — /api/oauth/usage stays a generic 404 unless enabled)`,
  });
  checks.push({
    name: 'api hello',
    ok: true,
    detail: `apiHello=${anthropic?.apiHello !== false} (default true — HEAD /api/hello answers 200)`,
  });

  return checks;
}

/** Pure projection of the local-only Images diagnostic snapshot. */
export function buildImagesDoctorChecks(snapshot: ImageDoctorLocalSnapshot): DoctorCheck[] {
  const enabled = snapshot.config.enabled;
  const accountOk = !enabled || snapshot.account.usable;
  const evidenceOk = !enabled || (snapshot.evidence.valid && snapshot.evidence.freshEntries > 0);
  return [
    {
      name: 'normalized Images config',
      ok: snapshot.config.valid,
      detail: snapshot.config.valid
        ? `enabled=${enabled}, provider=${snapshot.config.provider}, model=${snapshot.config.model}`
        : `invalid normalized configuration (${snapshot.config.errorCount} issue(s))`,
    },
    {
      name: 'private roots',
      ok: snapshot.roots.valid,
      detail: `${snapshot.roots.verifiedAreas}/${snapshot.roots.expectedAreas} roots verified`,
    },
    {
      name: 'persistent stores',
      ok: snapshot.stores.valid,
      warn: snapshot.stores.corruptManifestsQuarantined > 0,
      detail:
        `mounts=${snapshot.stores.mounts}, retired=${snapshot.stores.retiredMounts}, ` +
        `references=${snapshot.stores.referenceEntries}/${snapshot.stores.referenceBytes}B, ` +
        `state=${snapshot.stores.stateCalls} calls/${snapshot.stores.stateResponses} responses, ` +
        `quarantined=${snapshot.stores.corruptManifestsQuarantined}`,
    },
    {
      name: 'key permission schema',
      ok: snapshot.permissions.valid,
      detail:
        `rows=${snapshot.permissions.rows}, legacy=${snapshot.permissions.legacyRows}, ` +
        `invalid=${snapshot.permissions.invalidRows}, Images-authorized=${snapshot.permissions.imagesAuthorizedRows}`,
    },
    {
      name: 'Codex account',
      ok: accountOk,
      warn: !snapshot.account.usable,
      detail: snapshot.account.usable
        ? 'eligible local credential is present'
        : `${snapshot.account.reason}; Images live verification is unavailable`,
    },
    {
      name: 'cached capability evidence',
      ok: evidenceOk,
      warn: snapshot.evidence.freshEntries === 0,
      detail: snapshot.evidence.valid
        ? `entries=${snapshot.evidence.entries}, fresh=${snapshot.evidence.freshEntries}, stale=${snapshot.evidence.staleEntries}`
        : 'evidence store could not be read safely',
    },
  ];
}

/** Execute only the explicitly consuming Images verifier and print safe metadata. */
export async function runImagesLiveDoctor(
  config: OutboundApiServerConfig,
  doctor: ImageDoctorService,
  signal: AbortSignal = new AbortController().signal,
): Promise<boolean> {
  console.info(
    '  [⚠] live Images verification may consume subscription quota; one minimal low-quality PNG request will be sent',
  );
  const result = await doctor.verifyLive(config.images ?? DEFAULT_IMAGES_SERVER_CONFIG, signal);
  if (!result.ok) {
    console.info(`  [✗] live Images verification: ${result.code}`);
    return false;
  }
  console.info(
    `  [✓] live Images verification: model=${result.model}, quality=${result.quality}, ` +
      `format=${result.outputFormat}, freshEvidence=${result.freshEvidenceEntries}`,
  );
  return true;
}

/**
 * The doctor-only environment convenience — now a FALLBACK, not the source.
 *
 * 阶段5's daemon `search` config section is the configuration system; this is
 * not, and must never become one. It survives only so an operator can probe a
 * provider that the config does not carry, without editing config to do it:
 * {@link resolveSearchApiConfigs} consults it strictly AFTER the config, per
 * provider id.
 *
 * The values are read here, handed straight to `apiSearchContributions`, and
 * never persisted, logged, or passed to any other subsystem. `z.ai` reads
 * `Z_AI` because a dot is not valid in an environment variable name.
 */
export function readSearchApiConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SearchApiProviderConfigs {
  const configs: SearchApiProviderConfigs = {};
  const read = (name: string): string | undefined => {
    const value = env[`OMNICROSS_SEARCH_${name}`]?.trim();
    return value ? value : undefined;
  };

  const tavilyKey = read('TAVILY_API_KEY');
  if (tavilyKey) {
    configs.tavily = { apiKey: tavilyKey, ...optionalHost(read('TAVILY_API_HOST')) };
  }

  // Jina is the one provider a host alone can enable, because it runs keyless.
  const jinaKey = read('JINA_API_KEY');
  const jinaHost = read('JINA_API_HOST');
  if (jinaKey || jinaHost) {
    configs.jina = { ...(jinaKey ? { apiKey: jinaKey } : {}), ...optionalHost(jinaHost) };
  }

  const searxngHost = read('SEARXNG_API_HOST');
  if (searxngHost) {
    const username = read('SEARXNG_BASIC_AUTH_USERNAME');
    const password = read('SEARXNG_BASIC_AUTH_PASSWORD');
    configs.searxng = {
      apiHost: searxngHost,
      ...(username ? { basicAuthUsername: username } : {}),
      ...(password ? { basicAuthPassword: password } : {}),
    };
  }

  const zhipuKey = read('ZHIPU_API_KEY');
  if (zhipuKey) {
    configs.zhipu = { apiKey: zhipuKey, ...optionalHost(read('ZHIPU_API_HOST')) };
  }

  const zaiKey = read('Z_AI_API_KEY');
  if (zaiKey) {
    configs['z.ai'] = { apiKey: zaiKey, ...optionalHost(read('Z_AI_API_HOST')) };
  }

  return configs;
}

function optionalHost(apiHost: string | undefined): { apiHost?: string } {
  return apiHost ? { apiHost } : {};
}

/**
 * Resolve the API provider configs the doctor should report on: the daemon
 * `search` section FIRST, the diagnostic environment variables only for
 * providers the config does not name.
 *
 * Whole-entry precedence, not per-field: a config entry that exists is the
 * operator's statement about that provider, and letting an environment variable
 * silently override one of its fields would make `doctor` report on something
 * the daemon would never actually run.
 */
export function resolveSearchApiConfigs(
  configured: SearchApiProviderConfigs | undefined,
  env: Record<string, string | undefined> = process.env,
): SearchApiProviderConfigs {
  const fromEnv = readSearchApiConfigFromEnv(env);
  const resolved: SearchApiProviderConfigs = {};
  const tavily = configured?.tavily ?? fromEnv.tavily;
  if (tavily) resolved.tavily = tavily;
  const jina = configured?.jina ?? fromEnv.jina;
  if (jina) resolved.jina = jina;
  const searxng = configured?.searxng ?? fromEnv.searxng;
  if (searxng) resolved.searxng = searxng;
  const zhipu = configured?.zhipu ?? fromEnv.zhipu;
  if (zhipu) resolved.zhipu = zhipu;
  const zai = configured?.['z.ai'] ?? fromEnv['z.ai'];
  if (zai) resolved['z.ai'] = zai;
  return resolved;
}

function formatCapabilities(capabilities: SearchProviderCapabilities): string {
  return [
    `apiKey=${capabilities.requiresApiKey}`,
    `cancellation=${capabilities.supportsCancellation}`,
    `urlRead=${capabilities.supportsUrlRead}`,
    `region=${capabilities.supportsRegion}`,
    `language=${capabilities.supportsLanguage}`,
    `timeRange=${capabilities.supportsTimeRange}`,
    `maxResults=${capabilities.maxResults ?? 'unbounded'}`,
  ].join(', ');
}

/**
 * Format one diagnostic for the console.
 *
 * Provider id, status, reason and sanitized error fields only — never a result
 * title, URL, snippet, or any part of a response body.
 */
function formatDiagnostic(diagnostic: SearchProviderDiagnostic): string {
  const parts: string[] = [diagnostic.status];
  if (diagnostic.reason) parts.push(diagnostic.reason);
  if (diagnostic.error) {
    const { code, details } = diagnostic.error;
    parts.push(
      `code=${code}, transport=${details?.transport ?? 'unknown'}, stage=${details?.stage ?? 'unknown'}`,
    );
  }
  return parts.join(' — ');
}

/** What `doctor search` reports on, when a daemon config was loaded. */
export interface SearchDoctorSource {
  /** The daemon `search` section. Its provider entries outrank the env fallback. */
  readonly config?: SearchServerConfig;
  /**
   * The daemon's ONE assembled runtime. When present its `listProviders()` is
   * the offline row source, so the report describes what the daemon would
   * actually run rather than a look-alike rebuilt here.
   */
  readonly runtime?: SearchRuntime;
}

/**
 * Run `omnicross doctor search`.
 *
 * CONFIG-FIRST: with a daemon config loaded, the `search` section supplies the
 * provider entries, the egress allowlist and the frontend modes, and the
 * documented environment variables fill in only the providers the config does
 * not name. Without a config (`doctor search` with no `--config`) the env
 * convenience is the only source, which keeps the zero-setup probe working.
 *
 * Nothing printed here is derived from a configured VALUE — only from whether
 * one is present. That rule covers config-sourced values exactly as it covers
 * environment ones.
 */
export async function runSearchDoctor(
  live: boolean,
  env: Record<string, string | undefined> = process.env,
  source: SearchDoctorSource = {},
): Promise<number> {
  const apiConfigs = resolveSearchApiConfigs(source.config?.providers, env);
  const egressPolicy = source.config && source.config.egress.allowedPrivateHosts.length > 0
    ? { allowedPrivateHosts: [...source.config.egress.allowedPrivateHosts] }
    : undefined;
  // Live probing needs provider INSTANCES, which descriptors deliberately do
  // not carry, so the probe set is built here. It is not a second fallback
  // order: `--live` asks each provider in turn on purpose, and never
  // orchestrates.
  const contributions = [
    ...builtinHttpSearchContributions(),
    ...apiSearchContributions(apiConfigs, { ...(egressPolicy ? { egressPolicy } : {}) }),
  ];
  const declarations: ReadonlyArray<SearchProviderDeclaration> =
    source.runtime?.listProviders() ?? contributions;

  console.info('omnicross doctor search — builtin search contributions (offline, no network)');
  const modes = source.config?.modes ?? DEFAULT_SEARCH_FRONTEND_MODES;
  console.info(
    `  [i] frontend modes: ${SEARCH_FRONTEND_NAMES.map((name) => `${name}=${modes[name]}`).join(', ')}`,
  );
  // The asymmetry is real and invisible otherwise: the Codex mode is read from
  // the live server config on every request, while the Responses/Anthropic
  // modes and the whole runtime (providers, egress allowlist, default policy)
  // are captured once at bootstrap. An operator who edits those and sees
  // nothing change deserves to be told why rather than to debug it.
  console.info(
    '  [i] codex mode applies immediately; responses/anthropic modes, provider config, ' +
      'egress allowlist and policy apply on daemon restart',
  );
  for (const row of buildSearchDoctorSnapshot(declarations, apiConfigs)) {
    const mark = row.status === 'unconfigured' ? '–' : '✓';
    const suffix = row.status ? ` — ${row.status}: ${row.reason ?? ''}` : '';
    console.info(
      `  [${mark}] ${row.providerId}: source=${row.source}, kind=${row.kind}, ` +
        `${formatCapabilities(row.capabilities)}${suffix}`,
    );
  }
  if (!live) return 0;

  console.info(
    `  [⚠] live search sends ONE fixed public query per provider ("${SEARCH_DOCTOR_QUERY}") to the engine itself`,
  );
  // Only CONFIGURED providers are probed: an unconfigured one has nothing to
  // probe with, and asking it would just manufacture a `config_missing`.
  let hardFailure = false;
  for (const diagnostic of await runSearchLiveChecks(contributions)) {
    // `blocked`/`degraded` are honest observations about a hostile network, not
    // Omnicross defects — only `failed` (drift, timeout, transport) exits 1.
    const mark = diagnostic.status === 'healthy' ? '✓' : diagnostic.status === 'failed' ? '✗' : '⚠';
    if (diagnostic.status === 'failed') hardFailure = true;
    console.info(`  [${mark}] ${diagnostic.providerId}: ${formatDiagnostic(diagnostic)}`);
  }
  return hardFailure ? 1 : 0;
}

/** The `--live` probe result (also consumed by tests via an injected fetch). */
export interface LiveProbeResult {
  status: number | null;
  estimateHeader: string | null;
  error?: string;
}

/**
 * Send ONE minimal count_tokens POST (the free endpoint — never a generation
 * call) to `url` with `key`, reporting the status + the estimate marker header.
 * Uses plain global-style fetch (the target is the LOCAL gateway, not an
 * upstream — `fetchUpstream` does not apply).
 */
export async function runLiveProbe(
  url: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveProbeResult> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    // Drain the (tiny) body so the socket is reusable/clean.
    await res.text().catch(() => '');
    return {
      status: res.status,
      estimateHeader: res.headers.get('x-omnicross-count-estimate'),
    };
  } catch (err) {
    return {
      status: null,
      estimateHeader: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run the `doctor` subcommand. `argv` is everything after `doctor claude`.
 *  `fetchImpl` is a test seam (default: the global fetch). */
export async function runDoctor(argv: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      'master-key-file': { type: 'string' },
      live: { type: 'boolean' },
      url: { type: 'string' },
      key: { type: 'string' },
    },
    allowPositionals: true,
  });
  const subject = positionals[0] ?? 'claude';
  if (subject !== 'claude' && subject !== 'images' && subject !== 'search') {
    throw new Error(`doctor: unknown subject '${subject}' (supported: 'claude', 'images', 'search')`);
  }
  const configPath = values.config;
  if (!configPath) {
    // `search` is the one subject that still works with no config at all: the
    // builtin HTTP providers need none, and the env convenience exists exactly
    // so a keyed provider can be probed without editing config first.
    if (subject === 'search') return runSearchDoctor(values.live === true);
    throw new Error('doctor: --config <path> is required (the same config `omnicross start` uses)');
  }

  // Same-source config loading as runStart (loadConfig → buildDaemon →
  // loadServerConfig) — no second parser to drift.
  const config = loadConfig(configPath);
  const paths: DaemonPaths = {
    configPath,
    keysPath: defaultKeysPath(configPath),
    tokensPath: defaultTokensPath(configPath),
    masterKeyFilePath: values['master-key-file'],
  };
  const daemon = await buildDaemon(config, paths);
  try {
    const serverConfig = await loadServerConfig(daemon.settingsStore);

    if (subject === 'search') {
      // The daemon built exactly one runtime; report on THAT one.
      return await runSearchDoctor(values.live === true, process.env, {
        ...(serverConfig.search ? { config: serverConfig.search } : {}),
        runtime: daemon.searchRuntime,
      });
    }

    const checks = subject === 'images'
      ? buildImagesDoctorChecks(await daemon.imageDoctor.inspectLocal(
          serverConfig.images ?? DEFAULT_IMAGES_SERVER_CONFIG,
        ))
      : buildClaudeDoctorChecks(serverConfig);
    let hardFailure = false;
    console.info(subject === 'images'
      ? 'omnicross doctor images — local metadata only'
      : `omnicross doctor ${subject} — config: ${configPath}`);
    for (const check of checks) {
      const mark = check.ok ? (check.warn ? '⚠' : '✓') : '✗';
      if (!check.ok) hardFailure = true;
      console.info(`  [${mark}] ${check.name}: ${check.detail}`);
    }

    if (values.live && subject === 'images') {
      if (!await runImagesLiveDoctor(serverConfig, daemon.imageDoctor)) hardFailure = true;
    } else if (values.live) {
      if (!values.key) {
        console.error('  --live requires --key <outbound API key> (the same key a client would present)');
        return 1;
      }
      const url = values.url ?? 'http://127.0.0.1:8765';
      const probe = await runLiveProbe(url, values.key, fetchImpl);
      if (probe.error !== undefined) {
        console.info(`  [✗] live probe (${url}): ${probe.error}`);
        hardFailure = true;
      } else {
        const okStatus = probe.status !== null && probe.status >= 200 && probe.status < 300;
        console.info(
          `  [${okStatus ? '✓' : '✗'}] live probe (${url}) count_tokens: status ${probe.status}` +
            `${probe.estimateHeader === 'true' ? ', local estimate (x-omnicross-count-estimate: true)' : ''}`,
        );
        if (!okStatus) hardFailure = true;
      }
    }

    return hardFailure ? 1 : 0;
  } finally {
    daemon.routeLeaseManager.shutdown();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    daemon.tokenRefreshScheduler.dispose();
    daemon.claudeAllowanceRefreshScheduler.dispose();
    daemon.accountHealthSweeper.dispose();
    daemon.accountHealthProbeScheduler.dispose();
    daemon.auditPruneSweeper.dispose();
    daemon.usagePruneSweeper.dispose();
    daemon.billingRetrySweeper.dispose();
    daemon.pricingRefreshScheduler.dispose();
  }
}
