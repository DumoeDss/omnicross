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

import { loadServerConfig } from '@omnicross/core/outbound-api';
import type {
  GatewayBinding,
  OutboundApiServerConfig,
} from '@omnicross/core/outbound-api/types';

import { buildDaemon, type DaemonPaths } from '../bootstrap';
import { loadConfig } from '../config';

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
  if (subject !== 'claude') {
    throw new Error(`doctor: unknown subject '${subject}' (only 'claude' is supported)`);
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
  const serverConfig = await loadServerConfig(daemon.settingsStore);

  const checks = buildClaudeDoctorChecks(serverConfig);
  let hardFailure = false;
  console.info(`omnicross doctor ${subject} — config: ${configPath}`);
  for (const check of checks) {
    const mark = check.ok ? (check.warn ? '⚠' : '✓') : '✗';
    if (!check.ok) hardFailure = true;
    console.info(`  [${mark}] ${check.name}: ${check.detail}`);
  }

  if (values.live) {
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
}
