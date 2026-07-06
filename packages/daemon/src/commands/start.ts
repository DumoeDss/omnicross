/**
 * commands/start.ts — `omnicross start --config <path>`.
 *
 * Boots the standalone daemon and starts both listeners:
 *   loadConfig → buildDaemon → providerProxy.start() →
 *   outboundApiServer.applyConfig(loadServerConfig(settingsStore) with enabled:true)
 * then prints the bound format URLs from `getStatus()` and keeps the process
 * alive (the HTTP listeners hold the event loop open).
 *
 * @module @omnicross/daemon/commands/start
 */

import { parseArgs } from 'node:util';

import { loadServerConfig, OutboundApiConfigError } from '@omnicross/core/outbound-api';
import { getSharedAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';

import { applyAuditConfig } from '../audit/auditRuntime';
import { buildDaemon, type DaemonPaths } from '../bootstrap';
import { loadConfig } from '../config';
import { applyWebhookConfig } from '../webhook/webhookRuntime';

import { defaultKeysPath, defaultTokensPath } from './paths';

/** What `runStart` reports back to programmatic callers (e.g. `omnicross ui`). */
export interface StartResult {
  /** The admin/dashboard base URL, or null when the dashboard is disabled. */
  dashboardUrl: string | null;
}

/** Run the `start` subcommand. */
export async function runStart(argv: string[]): Promise<StartResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      'no-dashboard': { type: 'boolean' },
      'master-key-file': { type: 'string' },
    },
    allowPositionals: false,
  });
  const configPath = values.config;
  if (!configPath) {
    throw new Error('start: --config <path> is required');
  }

  // `loadConfig` runs BEFORE the box is set (no box → returns raw rows, possibly
  // still `enc:`); `buildDaemon` resolves the master key, sets the box, and
  // re-decrypts the config (idempotent on plaintext). Forwarding the
  // `--master-key-file` here means `buildDaemon` honors it (env still wins).
  const config = loadConfig(configPath);
  const paths: DaemonPaths = {
    configPath,
    keysPath: defaultKeysPath(configPath),
    tokensPath: defaultTokensPath(configPath),
    masterKeyFilePath: values['master-key-file'],
  };
  const daemon = buildDaemon(config, paths);

  // Ensure the built-in transformers are registered before any request routes.
  await daemon.llmConfig.ready();

  await daemon.providerProxy.start();

  const serverConfig = await loadServerConfig(daemon.settingsStore);

  // Apply the persisted account-health config to the shared tracker (subscription-
  // account-health, LEAD OQ1) — the strategies/relay/sweeper already hold this
  // exact instance, so `configure` retunes the live 529 overload cooldown.
  getSharedAccountHealth().configure({
    overloadEnabled: serverConfig.accountHealth?.overloadCooldownEnabled,
    overloadTtlMs: serverConfig.accountHealth?.overloadCooldownMs,
  });

  // Startup gate (model-kind-mapping): if the persisted config enables the
  // outbound server but a kind-mapped endpoint (messages/responses) is missing
  // required mappings, `applyConfig` throws `OutboundApiConfigError` and does not
  // bind. Catch it so the daemon boots with the outbound server STOPPED (the rest
  // of the daemon — admin API, provider proxy — still comes up) instead of
  // crashing; the operator fixes the mappings and re-enables via the admin API.
  try {
    await daemon.outboundApiServer.applyConfig({
      enabled: true,
      networkBinding: serverConfig.networkBinding,
      endpoints: serverConfig.endpoints,
      port: serverConfig.port,
    });
  } catch (err) {
    if (err instanceof OutboundApiConfigError) {
      console.warn(`[outbound] not started — incomplete model configuration: ${err.message}`);
    } else {
      throw err;
    }
  }

  // Admin dashboard (RT3) — always-on by default; opt out via `--no-dashboard`
  // or `admin.enabled:false`. `adminServer.start()` honors the LAN fail-closed
  // gate internally (refuses to bind 0.0.0.0 without an admin.token).
  let dashboardUrl: string | null = null;
  if (!values['no-dashboard']) {
    await daemon.adminServer.start();
    dashboardUrl = daemon.adminServer.getStatus().url;
  }

  // Proactive background OAuth refresh (external-cli-sync): sweep all
  // subscription accounts each minute, refreshing tokens that enter the 5-min
  // expiry lead window — an idle daemon stays warm instead of paying the
  // refresh (or a dead rotated token) on the first request.
  daemon.tokenRefreshScheduler.start();

  // Proactive account-health recovery (subscription-account-health, D6): surface
  // idle accounts whose cooldown elapsed (fires the recovery signal #5/#8 consume)
  // + nudge a fresh token so a recovered account resumes instantly.
  daemon.accountHealthSweeper.start();

  // Scheduled ACTIVE account-health probe (subscription-account-probe #8): apply
  // the persisted `accountProbe` segment, then start ONLY when enabled (default
  // OFF ⇒ `start()` is a no-op ⇒ zero regression). A cheap, staggered, multi-
  // account-only background GET discovers a dead account before real traffic.
  if (serverConfig.accountProbe) {
    daemon.accountHealthProbeScheduler.configure(serverConfig.accountProbe);
  }
  daemon.accountHealthProbeScheduler.start();

  // Webhook notifications (webhook-notifications): register the core emit sink +
  // subscribe the #2 health recovery/anomaly signals ONLY when the persisted
  // `webhook` segment is enabled with ≥1 destination. Absent/disabled ⇒ no sink ⇒
  // `emitWebhookEvent` stays a no-op (zero regression). The dispatcher receives
  // the live (decrypted) config so the admin test button can probe destinations.
  applyWebhookConfig(serverConfig.webhook);

  // Request audit (request-audit-log): register the core capture config + the
  // file-backed sink and arm the TTL prune ONLY when the persisted `audit`
  // segment is enabled (`applyAuditConfig` configures + starts the sweeper, which
  // runs one prune at boot). Absent/disabled ⇒ no sink ⇒ the capture hook is a
  // no-op (zero regression).
  applyAuditConfig(serverConfig.audit);

  const status = daemon.outboundApiServer.getStatus();
  console.info('omnicross daemon is running.');
  if (dashboardUrl) console.info(`  dashboard : ${dashboardUrl}`);
  console.info(`  loopback : ${status.loopbackUrl ?? '(not bound)'}`);
  if (status.lanUrl) console.info(`  lan      : ${status.lanUrl}`);
  if (status.formats) {
    console.info('  endpoints:');
    console.info(`    chat      ${status.formats.chat}`);
    console.info(`    responses ${status.formats.responses}`);
    console.info(`    gemini    ${status.formats.gemini}`);
    console.info(`    messages  ${status.formats.messages}`);
  }
  // Subscription routing: `/v1/responses` subscription dispatch is now wired
  // (drop a `tokens.json` next to config.json + set `useSubscription:true` with a
  // `"<subId>,<model>"` model ref that has no BYO row). DEFERRED follow-ups:
  // `/v1/messages` subscription (RT2.1 — the BYO Anthropic path hard-rejects
  // subscription auth) and the Gemini paid Code-Assist tier (resolver unwired →
  // free-tier behavior).
  console.info('  responses subscription routing: enabled (drop tokens.json + useSubscription:true)');
  console.info('  (deferred: /v1/messages subscription, Gemini paid Code-Assist tier)');
  // Dashboard (RT3): localhost-default, port 8766, `--no-dashboard` (or
  // `admin.enabled:false`) to disable. Set `admin.token` for a bearer gate;
  // `admin.networkBinding:true` REQUIRES a non-empty `admin.token` (the admin
  // server refuses to bind 0.0.0.0 without one — fail closed). DEFERRED: the
  // token-paste WRITE path (accounts stay read-only — operator drops tokens.json
  // by hand) and the advanced UI. This dashboard COMPLETES the omnicross
  // Phase 0→3 portfolio (RT1 ingress, RT2 subscriptions, RT3 dashboard).
  if (dashboardUrl) {
    console.info('  dashboard: localhost-default; --no-dashboard to disable; admin.token for a bearer gate');
  }
  console.info('Press Ctrl+C to stop.');
  return { dashboardUrl };
}
