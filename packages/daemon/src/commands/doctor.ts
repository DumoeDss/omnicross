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

import { toSearchErrorShape } from '@omnicross/contracts/search-types';
import type {
  SearchProviderCapabilities,
  SearchProviderContribution,
  SearchProviderDiagnostic,
  SearchProviderHealthStatus,
  SearchProviderId,
  SearchProviderSource,
  SearchTransportKind,
} from '@omnicross/contracts/search-types';
import {
  DEFAULT_IMAGES_SERVER_CONFIG,
  loadServerConfig,
} from '@omnicross/core/outbound-api';
import type {
  GatewayBinding,
  OutboundApiServerConfig,
} from '@omnicross/core/outbound-api/types';
import { builtinHttpSearchContributions } from '@omnicross/core/search/http';

import { buildDaemon, type DaemonPaths } from '../bootstrap';
import { loadConfig } from '../config';
import type {
  ImageDoctorLocalSnapshot,
  ImageDoctorService,
} from '../image-generation/ImageDoctorService';

import { defaultKeysPath, defaultTokensPath } from './paths';

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

/** One row of the offline `doctor search` snapshot. */
export interface SearchDoctorRow {
  providerId: SearchProviderId;
  source: SearchProviderSource;
  kind: SearchTransportKind;
  capabilities: SearchProviderCapabilities;
}

/**
 * Project the builtin HTTP search contributions into a printable snapshot.
 *
 * Pure and IO-free: it reads what the contributions DECLARE (`source`, `kind`,
 * capabilities) and infers nothing from a provider id's spelling.
 */
export function buildSearchDoctorSnapshot(
  contributions: SearchProviderContribution[] = builtinHttpSearchContributions(),
): SearchDoctorRow[] {
  return contributions.map((contribution) => ({
    providerId: contribution.id,
    source: contribution.source,
    kind: contribution.kind,
    capabilities: contribution.capabilities,
  }));
}

/**
 * The one fixed query `--live` sends.
 *
 * Public, low-sensitivity, and already committed in the fixture README — the
 * live check must never send a user's query, and this is also the query the
 * trust-passing Bing capture was taken with.
 */
export const SEARCH_DOCTOR_QUERY = 'mozilla developer network http headers';

/** What one live provider check produced. */
export type LiveSearchOutcome =
  | { kind: 'results'; count: number }
  | { kind: 'failure'; error: unknown };

/**
 * Map a live outcome onto the five diagnostic statuses. Pure — no clock, no
 * network, no IO — so the whole table is unit-testable.
 *
 * `unconfigured` is unreachable here by design: these providers are keyless and
 * fixed-host, so there is nothing to misconfigure in 阶段2.
 */
export function classifyLiveSearchOutcome(
  providerId: SearchProviderId,
  outcome: LiveSearchOutcome,
  checkedAt: string,
): SearchProviderDiagnostic {
  if (outcome.kind === 'results') {
    if (outcome.count > 0) return { providerId, status: 'healthy', checkedAt };
    // A recognized SERP with zero results. There is NO error here — inventing
    // one would recreate exactly the empty-vs-parser-failure conflation this
    // slice exists to remove — so the diagnostic carries a reason only.
    return {
      providerId,
      status: 'degraded',
      checkedAt,
      reason: 'reachable, but the engine returned no usable results (possible partial drift)',
    };
  }

  const error = toSearchErrorShape(outcome.error);
  const stage = error.details?.stage;
  const { status, reason } = classifySearchFailure(stage, error.code);
  return { providerId, status, checkedAt, reason, error };
}

function classifySearchFailure(
  stage: string | undefined,
  code: string,
): { status: SearchProviderHealthStatus; reason: string } {
  // Challenge and trust are network/engine verdicts about US, not breakage:
  // a different egress path may well succeed, so they are `blocked`.
  if (stage === 'challenge') {
    return { status: 'blocked', reason: 'the engine served a bot challenge instead of results' };
  }
  if (stage === 'trust') {
    return {
      status: 'blocked',
      reason: 'the engine served a page that failed the anti-decoy trust check',
    };
  }
  if (code === 'parse_failed') {
    return {
      status: 'failed',
      reason: 'the response was not recognizable as a search result page (parser drift suspected)',
    };
  }
  if (code === 'timeout') {
    return { status: 'failed', reason: 'the request exceeded its time budget' };
  }
  return { status: 'failed', reason: `the request failed (${code})` };
}

/** Run the fixed query once per provider, classifying whatever comes back. */
export async function runSearchLiveChecks(
  contributions: SearchProviderContribution[],
  now: () => string = () => new Date().toISOString(),
): Promise<SearchProviderDiagnostic[]> {
  const diagnostics: SearchProviderDiagnostic[] = [];
  for (const contribution of contributions) {
    try {
      const results = await contribution.provider.search(SEARCH_DOCTOR_QUERY, { maxResults: 5 });
      diagnostics.push(
        classifyLiveSearchOutcome(contribution.id, { kind: 'results', count: results.length }, now()),
      );
    } catch (error) {
      diagnostics.push(classifyLiveSearchOutcome(contribution.id, { kind: 'failure', error }, now()));
    }
  }
  return diagnostics;
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

/**
 * Run `omnicross doctor search`.
 *
 * Offline mode needs no config and touches no network, so it never loads the
 * daemon: keyless fixed-host providers have no persisted state to inspect.
 */
export async function runSearchDoctor(live: boolean): Promise<number> {
  const contributions = builtinHttpSearchContributions();

  console.info('omnicross doctor search — builtin HTTP search contributions (offline, no network)');
  for (const row of buildSearchDoctorSnapshot(contributions)) {
    console.info(
      `  [✓] ${row.providerId}: source=${row.source}, kind=${row.kind}, ${formatCapabilities(row.capabilities)}`,
    );
  }
  if (!live) return 0;

  console.info(
    `  [⚠] live search sends ONE fixed public query per provider ("${SEARCH_DOCTOR_QUERY}") to the engine itself`,
  );
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
  // `search` inspects builtin code, not persisted state: no --config, no daemon.
  if (subject === 'search') return runSearchDoctor(values.live === true);
  if (subject !== 'claude' && subject !== 'images') {
    throw new Error(`doctor: unknown subject '${subject}' (supported: 'claude', 'images', 'search')`);
  }
  const configPath = values.config;
  if (!configPath) {
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
