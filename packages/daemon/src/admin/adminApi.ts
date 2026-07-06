/**
 * adminApi — the daemon admin dashboard's management API router (`/admin/api/*`,
 * JSON) (RT3, design D3/D4/D5).
 *
 * A small method+path router over the LIVE daemon handles + exported core fns.
 * Resources: providers (CRUD + hot-reload), keys (CRUD + one-time plaintext),
 * server config (live apply), accounts (read-only status), status, playground
 * (same-origin proxy to `/v1/*`).
 *
 * SECRET SPINE (design D4 — the load-bearing invariant): secrets flow IN
 * (POST/PUT) and NEVER OUT (GET). The provider mask (`maskProviderApiKey`) and
 * the key DTO map (`toKeyInfo`) are the single places the masking is applied so
 * the invariant lives in one spot.
 *
 * @module @omnicross/daemon/admin/adminApi
 */

import http from 'node:http';

import {
  createNamedKey,
  type EndpointModelConfigError,
  isKindMappedEndpoint,
  loadServerConfig,
  mergeServerConfig,
  type OutboundApiKeyInfo,
  type OutboundApiServer,
  type OutboundApiServerConfig,
  type OutboundKeyDb,
  type OutboundKeyDbRow,
  saveServerConfig,
  validateServerModelConfig,
} from '@omnicross/core/outbound-api';
import type { PricingEngine, UsageRecorder } from '@omnicross/core/usage';
import type { FetchLike } from '@omnicross/subscriptions';

import {
  type DaemonApiKeyEntry,
  type DaemonApiMode,
  type DaemonCodingPlanConfig,
  type DaemonConfig,
  type DaemonModelConfig,
  type DaemonProviderConfig,
  type DaemonTransformerConfig,
  type DaemonTransformerEntry,
  loadConfig,
  saveConfig,
  validateTransformerEntry,
} from '../config';
import type { AutoDisableStore } from '../pool/autoDisableStore';
import { resolveEnvKey } from '../pool/resolveEnvKey';
import type { ConfigFileProviderConfigSource } from '../ports/ConfigFileProviderConfigSource';
import type { JsonApiServerSettingsStore } from '../ports/JsonApiServerSettingsStore';
import type { JsonPricingStore } from '../ports/JsonPricingStore';
import { listMappablePresets } from '../preset-map';

import {
  type CodexLoopbackFn,
  CodexOAuthSessionStore,
  handleCodexOAuthStart,
  handleCodexOAuthStatus,
} from './accountsCodexOAuth';
import {
  handleOAuthComplete,
  handleOAuthStart,
  type SubscriptionAccountAppender,
} from './accountsOAuth';
import {
  asSubscriptionProviderId,
  statusEntryFor,
  type SubscriptionTokenWriter,
  validateTokenBody,
} from './accountsWrite';
import {
  type CommandRunner,
  handleCliInstall,
  handleCliLaunch,
  handleCliList,
  handleCliSessions,
  handleCliStop,
  isLaunchCliId,
  type PathProbe,
  type TerminalOpener,
} from './cliLaunch';
import { handleDashboard } from './dashboard';
import { handleExport, handleImport, type MigrationDeps } from './adminMigration';
import type { MigrationCredentialStore } from '../migration/migration';
import type { OAuthSessionStore } from './oauthSessions';
import {
  handlePricingDelete,
  handlePricingFetchLatest,
  handlePricingList,
  handlePricingResolveConflicts,
  handlePricingUpsert,
  handleUsageGet,
  type UsagePricingResult,
} from './usagePricing';

/** Token-free subscription account list entry (passthrough from core's service). */
export interface AdminAccountsLister {
  listAll(): Promise<unknown[]>;
}

/** One key's live cooldown health (mirrors core `KeyHealthEntry`; read-only). */
export interface PoolKeyHealth {
  until: number;
  errors: number;
  lastStatus: number | null;
}

/**
 * The READ-ONLY pool-health surface the admin view needs (key-pool design D7).
 * Structurally satisfied by core's `ApiKeyPoolService.getKeyHealth`; typed as a
 * minimal reader so `adminApi` carries no class coupling and can never reach a
 * key value through it (cooldown health only).
 */
export interface PoolHealthReader {
  getKeyHealth(providerId: string): Promise<Record<string, PoolKeyHealth>>;
}

/** The live daemon handles the management API operates over. */
export interface AdminApiDeps {
  /** Path to the daemon's `config.json` (provider catalog + `server` field). */
  readonly configPath: string;
  /** Live provider catalog (hot-reload target). */
  readonly llmConfig: ConfigFileProviderConfigSource;
  /** Named outbound-key store. */
  readonly keyDb: OutboundKeyDb;
  /** Outbound server settings store (server config persistence). */
  readonly settingsStore: JsonApiServerSettingsStore;
  /** The running outbound server (status + live applyConfig). */
  readonly outboundApiServer: OutboundApiServer;
  /** Subscription accounts (token-free `listAll`). */
  readonly subscriptionAccounts: AdminAccountsLister;
  /**
   * Least-authority subscription-token WRITER (design D4) — ONLY the mutation
   * methods (`writeProviderTokens` / `clearProvider`), never a token-returning
   * read. The token-free `subscriptionAccounts` lister stays separate so a GET
   * handler can never reach a token through this dep.
   */
  readonly subscriptionTokenWriter: SubscriptionTokenWriter;
  /**
   * Read-only pool-health reader (key-pool design D7) — cooldown health only,
   * never a key value. Drives `GET /admin/api/providers/:id/keys`.
   */
  readonly apiKeyPool: PoolHealthReader;
  /** In-memory auto-disable store (design D5) — read-only for the health view. */
  readonly autoDisableStore: AutoDisableStore;
  /**
   * Pending interactive-OAuth sessions (app-parity child 4, design D1) — the
   * in-memory `{ codeVerifier, state }` map keyed by a minted `sessionId`,
   * NEVER serialized to the client.
   */
  readonly oauthSessions: OAuthSessionStore;
  /**
   * Injected token-exchange `FetchLike` (oauth design D2-a) — defaults to global
   * `fetch` in `bootstrap.ts`; tests inject a mock so no real token endpoint is
   * hit. Mirrors how `login.ts` injects its exchange fetch.
   */
  readonly oauthExchangeFetch: FetchLike;
  /**
   * NARROW append handle (oauth design D2-a) — the OAuth complete handler needs
   * `appendProviderAccount` (NOT on the least-authority `SubscriptionTokenWriter`).
   * A minimal interface, NOT the full read-capable store, so no token-returning
   * read is reachable. Wired from the concrete `credentialStore` in `bootstrap.ts`.
   */
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
  /**
   * Codex interactive-OAuth flow store (app-parity-2 child 5). Tracks the async
   * loopback sign-in's polled status (token-free); only ONE codex login may be in
   * flight (port 1455 is one resource). Wired in `bootstrap.ts`.
   */
  readonly codexSessions: CodexOAuthSessionStore;
  /**
   * Codex loopback listener (app-parity-2 child 5) — defaults to `awaitLoopbackCode`
   * (binds 127.0.0.1:1455) in `bootstrap.ts`; tests inject a mock so no real port
   * is bound. The captured code crosses to the daemon ONLY (never the client).
   */
  readonly codexAwaitLoopback: CodexLoopbackFn;
  /**
   * Migration credential-store handle (app-parity child 6, design D2/D3). The
   * export gather needs `getFullConfig()` (full DECRYPTED tokens, in-memory only —
   * the pack is the only thing that leaves) and import needs `appendProviderAccount`
   * (multi-account append + re-encrypt at-rest). Confined to the migration
   * handlers (which seal/validate everything); never reached by a GET handler.
   * Wired from the concrete `credentialStore` in `bootstrap.ts`.
   */
  readonly migrationCredentialStore: MigrationCredentialStore;
  /**
   * Usage-stats query facade (usage-pricing child) — delegates to the JSONL
   * usage-event store. Aggregates only; carries no key material.
   */
  readonly usageRecorder: UsageRecorder;
  /** Pricing engine (upsert / source refresh / conflict resolution). */
  readonly pricingEngine: PricingEngine;
  /**
   * CONCRETE pricing store — ONLY for the store-local row `delete` (the core
   * `PricingStore` port is frozen; delete is a daemon-local extra).
   */
  readonly pricingStore: JsonPricingStore;
  /**
   * External-terminal opener for the Code CLI launch route (dashboard parity).
   * Optional — defaults to the real `defaultTerminalOpener`; tests inject a spy so
   * no terminal window is actually spawned.
   */
  readonly cliTerminalOpener?: TerminalOpener;
  /** Injectable PATH probe for CLI detection (tests fake "installed"). */
  readonly cliPathProbe?: PathProbe;
  /**
   * Injectable shell runner for the Code CLI install route. Optional — defaults
   * to the real `exec`-based runner; tests inject a stub so no package manager
   * actually runs.
   */
  readonly cliCommandRunner?: CommandRunner;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read the full request body as a UTF-8 string (mirrors the outbound router). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parse the request body as JSON (→ `{}` on an empty/invalid body). */
async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeJsonError(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'admin_api_error', message } });
}

/**
 * Mask a provider's stored `apiKey` so no literal/env secret ever leaves via a
 * GET (design D4). A literal `sk-…wxyz` → `'sk-…wxyz'` (last4 only); a `$ENV_VAR`
 * reference → `'$ENV(•••)'` (the var NAME is masked too, so the indirection
 * never leaks). Empty → empty.
 */
export function maskProviderApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) return '$ENV(•••)';
  const last4 = apiKey.length >= 4 ? apiKey.slice(-4) : apiKey;
  return `sk-…${last4}`;
}

/** Project a stored key row to the never-secret DTO (drops keyHash + plaintext). */
export function toKeyInfo(row: OutboundKeyDbRow): OutboundApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    enabled: row.enabled,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revoked: row.revokedAt !== null,
    maxConcurrency: row.maxConcurrency,
  };
}

/** Project a provider row to the masked GET shape (literal apiKey never serialized). */
function toProviderView(row: DaemonProviderConfig): {
  id: string;
  name?: string;
  apiFormat: string;
  baseUrl: string;
  models: string[];
  modelConfigs?: DaemonModelConfig[];
  hasApiKey: boolean;
  apiKeyMasked: string;
  enabled: boolean;
  isOfficial?: boolean;
  apiVersion?: string;
  maxConcurrency?: number;
  modelsEndpoint?: string;
  transformer?: DaemonTransformerConfig;
  codingPlan?: { enabled: boolean; baseUrl?: string; hasApiKey: boolean; note?: string };
  apiModes?: Array<{ id: string; label: string; baseUrl: string; hasApiKey: boolean; apiKeyPrefix?: string; note?: string }>;
  selectedApiModeId?: string;
} {
  return {
    id: row.id,
    // app-parity-2 child 1: mutable display name (non-secret) round-trips verbatim;
    // absent stays absent (the app falls back to the id for display).
    name: row.name,
    apiFormat: row.apiFormat,
    baseUrl: row.baseUrl,
    models: row.models ?? [],
    // app-parity child 2: per-model metadata round-trips verbatim (non-secret —
    // no masking; absent stays absent so a flat-models-only row has no key).
    modelConfigs: row.modelConfigs,
    hasApiKey: row.apiKey.length > 0,
    apiKeyMasked: maskProviderApiKey(row.apiKey),
    // app-foundation D8: absent `enabled` reads as enabled (back-compat).
    enabled: row.enabled !== false,
    // app-parity child 1: non-secret scalar fields round-trip verbatim (no masking).
    isOfficial: row.isOfficial,
    apiVersion: row.apiVersion,
    maxConcurrency: row.maxConcurrency,
    modelsEndpoint: row.modelsEndpoint,
    // app-parity child 5: transformer config round-trips VERBATIM (non-secret —
    // transform-rule names + options, no key material; absent stays absent).
    transformer: row.transformer,
    // app-parity-2 child 3: coding-plan endpoint MASKED — the secret `apiKey` is
    // NEVER serialized out (only a `hasApiKey` boolean); enabled/baseUrl/note are
    // non-secret. Absent stays absent.
    codingPlan: row.codingPlan
      ? {
          enabled: row.codingPlan.enabled,
          baseUrl: row.codingPlan.baseUrl,
          hasApiKey: typeof row.codingPlan.apiKey === 'string' && row.codingPlan.apiKey.length > 0,
          note: row.codingPlan.note,
        }
      : undefined,
    // app-parity-2 child 4: API modes MASKED — each mode's secret `apiKey` is
    // NEVER serialized out (only a per-mode `hasApiKey`); id/label/baseUrl/prefix/
    // note are non-secret. Absent stays absent.
    apiModes: row.apiModes
      ? row.apiModes.map((m) => ({
          id: m.id,
          label: m.label,
          baseUrl: m.baseUrl,
          hasApiKey: typeof m.apiKey === 'string' && m.apiKey.length > 0,
          apiKeyPrefix: m.apiKeyPrefix,
          note: m.note,
        }))
      : undefined,
    selectedApiModeId: row.selectedApiModeId,
  };
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Dispatch one `/admin/api/*` request. `path` is the already-extracted pathname
 * (no query). The auth gate has already run in `AdminServer`.
 */
export async function handleAdminApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  deps: AdminApiDeps,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const sub = path.slice('/admin/api/'.length);
  const [resource, ...rest] = sub.split('/').filter((s) => s.length > 0);

  try {
    switch (resource) {
      case 'providers':
        return await handleProviders(req, res, method, rest, deps);
      case 'presets':
        return handlePresets(res, method);
      case 'keys':
        return await handleKeys(req, res, method, rest, deps);
      case 'server':
        return await handleServer(req, res, method, deps);
      case 'accounts':
        return await handleAccounts(req, res, method, rest, deps);
      case 'cli':
        return await handleCli(req, res, method, rest, deps);
      case 'status':
        return await handleStatus(res, method, deps);
      case 'playground':
        return await handlePlayground(req, res, method, deps);
      case 'export':
        return await handleMigrationExport(req, res, method, deps);
      case 'import':
        return await handleMigrationImport(req, res, method, deps);
      case 'usage':
        return await handleUsage(req, res, method, rest, deps);
      case 'dashboard':
        return await handleDashboardRoute(res, method, deps);
      case 'pricing':
        return await handlePricing(req, res, method, rest, deps);
      default:
        return writeJsonError(res, 404, `unknown admin resource '${resource}'`);
    }
  } catch (err) {
    writeJsonError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

// ── Usage stats + pricing table (usage-pricing child) ─────────────────────────

/** Query params for the current request (the router strips them off `path`). */
function requestQuery(req: http.IncomingMessage): URLSearchParams {
  const raw = req.url ?? '';
  const qIdx = raw.indexOf('?');
  return new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
}

function writeResult(res: http.ServerResponse, result: UsagePricingResult): void {
  writeJson(res, result.status, result.body);
}

/** `GET /admin/api/usage/{totals|by-model|by-api-key}?startTs&endTs` */
async function handleUsage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'GET') return writeJsonError(res, 405, `method ${method} not allowed on usage`);
  return writeResult(res, await handleUsageGet(rest[0], requestQuery(req), deps));
}

/**
 * `GET /admin/api/dashboard` → the read-only `DashboardSummary` aggregate.
 * GET-only (405 otherwise). `AdminApiDeps` structurally satisfies the focused
 * `DashboardDeps` — no deps widening.
 */
async function handleDashboardRoute(
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'GET') return writeJsonError(res, 405, `method ${method} not allowed on dashboard`);
  const result = await handleDashboard(deps);
  return writeJson(res, result.status, result.body);
}

/** `/admin/api/pricing` (GET/PUT/DELETE) + `/fetch-latest` + `/resolve-conflicts`. */
async function handlePricing(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (rest.length === 0) {
    if (method === 'GET') return writeResult(res, await handlePricingList(deps));
    if (method === 'PUT') {
      return writeResult(res, await handlePricingUpsert(await readJsonBody(req), deps));
    }
    if (method === 'DELETE') {
      return writeResult(res, await handlePricingDelete(requestQuery(req), deps));
    }
    return writeJsonError(res, 405, `method ${method} not allowed on pricing`);
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'fetch-latest') {
    return writeResult(res, await handlePricingFetchLatest(deps));
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'resolve-conflicts') {
    return writeResult(res, await handlePricingResolveConflicts(await readJsonBody(req), deps));
  }
  return writeJsonError(res, 404, `unknown pricing route '${rest.join('/')}'`);
}

// ── Migration pack (export / import) ──────────────────────────────────────────

/** Build the `MigrationDeps` view from the live admin deps (app-parity child 6). */
function migrationDeps(deps: AdminApiDeps): MigrationDeps {
  return {
    configPath: deps.configPath,
    llmConfig: deps.llmConfig,
    credentialStore: deps.migrationCredentialStore,
    parseProviderInput,
  };
}

/** `POST /admin/api/export { passphrase }` → seal the full state under the
 *  passphrase; respond ONLY `{ pack, version }` (the opaque blob). */
async function handleMigrationExport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'POST') return writeJsonError(res, 405, `method ${method} not allowed on export`);
  const body = await readJsonBody(req);
  const result = await handleExport(body, migrationDeps(deps));
  return writeJson(res, result.status, result.body);
}

/** `POST /admin/api/import { blob, passphrase, mode? }` → open + validate + apply
 *  (re-encrypt at-rest); respond STATUS-ONLY counts. */
async function handleMigrationImport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'POST') return writeJsonError(res, 405, `method ${method} not allowed on import`);
  const body = await readJsonBody(req);
  const result = await handleImport(body, migrationDeps(deps));
  return writeJson(res, result.status, result.body);
}

// ── Providers (CRUD + hot-reload) ─────────────────────────────────────────────

async function handleProviders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  const cfg = loadConfig(deps.configPath);

  // GET /providers/:id/keys → read-only pool-health view (key-pool design D7).
  if (method === 'GET' && rest.length === 2 && rest[1] === 'keys') {
    return await handleProviderKeys(res, rest[0], cfg, deps);
  }

  // POST /providers/:id/keys → add a pool key (app-parity child 3). Mints the id
  // daemon-side (OQ2). Matched BEFORE the generic `:id` POST (a sub-path, not a body).
  if (method === 'POST' && rest.length === 2 && rest[1] === 'keys') {
    return await handleAddProviderKey(req, res, rest[0], cfg, deps);
  }

  // POST /providers/:id/keys/:keyId/enabled → toggle one pool key (child 3).
  // Matched before the 3-segment update/delete (it has a reserved trailing seg).
  if (method === 'POST' && rest.length === 4 && rest[1] === 'keys' && rest[3] === 'enabled') {
    return await handleToggleProviderKey(req, res, rest[0], rest[2], cfg, deps);
  }

  // PUT /providers/:id/keys/:keyId → update one pool key (child 3).
  if (method === 'PUT' && rest.length === 3 && rest[1] === 'keys') {
    return await handleUpdateProviderKey(req, res, rest[0], rest[2], cfg, deps);
  }

  // DELETE /providers/:id/keys/:keyId → remove one pool key (child 3).
  if (method === 'DELETE' && rest.length === 3 && rest[1] === 'keys') {
    return await handleDeleteProviderKey(res, rest[0], rest[2], cfg, deps);
  }

  // POST /providers/reorder → reorder the persisted provider array (D8). Matched
  // BEFORE the `:id` fallthrough (`reorder` is a reserved sub-path, not an id).
  if (method === 'POST' && rest.length === 1 && rest[0] === 'reorder') {
    return await handleProviderReorder(req, res, cfg, deps);
  }

  // POST /providers/:id/discover-models → list upstream models (OpenAI-format
  // scoped, D8). Matched before the generic `:id` write handlers.
  if (method === 'POST' && rest.length === 2 && rest[1] === 'discover-models') {
    return await handleDiscoverModels(res, rest[0], cfg);
  }

  // POST /providers/:id/test { model } → a minimal upstream completion using the
  // provider's OWN stored key, so the per-model "test" button on each model card
  // works without minting a client key. Matched before the generic `:id` handlers.
  if (method === 'POST' && rest.length === 2 && rest[1] === 'test') {
    return await handleTestModel(req, res, rest[0], cfg);
  }

  // GET /providers/:id/reveal-key → the DECRYPTED stored provider key. The daemon
  // holds the BYO key reversibly at rest (`enc:`), so unlike the masked list GET
  // this returns the real key for the "view key" affordance. The secret crosses
  // OUT here BY DESIGN, ONLY on this explicit per-key request (never in the list).
  // `cfg` is from `loadConfig`, which decrypts, so `apiKey` is already plaintext.
  if (method === 'GET' && rest.length === 2 && rest[1] === 'reveal-key') {
    const row = cfg.providers.find((p) => p.id === rest[0]);
    if (!row) return writeJsonError(res, 404, `provider '${rest[0]}' not found`);
    return writeJson(res, 200, { apiKey: row.apiKey ?? '' });
  }

  if (method === 'GET') {
    return writeJson(res, 200, { providers: cfg.providers.map(toProviderView) });
  }

  if (method === 'POST') {
    const body = await readJsonBody(req);
    const provider = parseProviderInput(body, undefined);
    if (!provider) return writeJsonError(res, 400, 'invalid provider (id, apiFormat, baseUrl required)');
    if (cfg.providers.some((p) => p.id === provider.id)) {
      return writeJsonError(res, 409, `provider '${provider.id}' already exists`);
    }
    cfg.providers.push(provider);
    persistProviders(cfg, deps);
    return writeJson(res, 201, { provider: toProviderView(provider) });
  }

  const id = rest[0];
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return writeJsonError(res, 404, `provider '${id}' not found`);

  if (method === 'PUT') {
    const body = await readJsonBody(req);
    // Blank/omitted apiKey keeps the existing stored key (edit without re-entry).
    const existing = cfg.providers[idx];
    const updated = parseProviderInput(body, existing);
    if (!updated) return writeJsonError(res, 400, 'invalid provider (apiFormat, baseUrl required)');
    cfg.providers[idx] = updated;
    persistProviders(cfg, deps);
    return writeJson(res, 200, { provider: toProviderView(updated) });
  }

  if (method === 'DELETE') {
    cfg.providers.splice(idx, 1);
    persistProviders(cfg, deps);
    return writeJson(res, 200, { ok: true });
  }

  return writeJsonError(res, 405, `method ${method} not allowed on providers`);
}

/** Persist the config to disk AND hot-reload the live provider catalog. */
function persistProviders(cfg: DaemonConfig, deps: AdminApiDeps): void {
  saveConfig(deps.configPath, cfg);
  deps.llmConfig.reload(cfg);
}

/**
 * `POST /admin/api/providers/reorder` (app-foundation D8) — reorder `cfg.providers`
 * to match the body's `{ order: string[] }`. Ids present in `order` are placed
 * first in that order; ids NOT in `order` (omitted) keep their prior relative
 * order, appended after; unknown ids in `order` are ignored. No error, no data
 * loss. Persists + hot-reloads via `persistProviders`, returns the masked DTO.
 */
async function handleProviderReorder(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: DaemonConfig,
  deps: AdminApiDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const rawOrder = body['order'];
  if (!Array.isArray(rawOrder)) {
    return writeJsonError(res, 400, 'reorder requires { order: string[] }');
  }
  const order = rawOrder.filter((x): x is string => typeof x === 'string');
  const byId = new Map(cfg.providers.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const reordered: DaemonProviderConfig[] = [];
  // 1) Ordered ids first (unknown ids ignored; duplicates de-duped).
  for (const id of order) {
    const row = byId.get(id);
    if (row && !seen.has(id)) {
      reordered.push(row);
      seen.add(id);
    }
  }
  // 2) Omitted ids appended preserving their prior relative order.
  for (const row of cfg.providers) {
    if (!seen.has(row.id)) {
      reordered.push(row);
      seen.add(row.id);
    }
  }
  cfg.providers = reordered;
  persistProviders(cfg, deps);
  return writeJson(res, 200, { ok: true, providers: cfg.providers.map(toProviderView) });
}

/**
 * `POST /admin/api/providers/:id/discover-models` (app-foundation D8) — list the
 * upstream models for an OpenAI-format provider via `GET {baseUrl}/models`.
 *
 * SCOPE: openai format only. anthropic/gemini return `{ models: [],
 * unsupportedFormat: true }` (HTTP 200, no upstream call). On any upstream
 * failure the daemon returns `{ models: [], error: <message> }` (HTTP 200) so the
 * UI can show it inline.
 *
 * SECRET SPINE (design D4): the resolved key authenticates the upstream GET but
 * is NEVER serialized into the response. The error message is the upstream's
 * status/parsed-message text only — it never echoes the key or `$ENV` name.
 */
async function handleDiscoverModels(
  res: http.ServerResponse,
  id: string | undefined,
  cfg: DaemonConfig,
): Promise<void> {
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  const row = cfg.providers.find((p) => p.id === id);
  if (!row) return writeJsonError(res, 404, `provider '${id}' not found`);

  if (row.apiFormat !== 'openai') {
    return writeJson(res, 200, { models: [], unsupportedFormat: true });
  }

  // Resolve the stored key (literal or `$ENV`) — same semantics as the outbound
  // path (`resolveEnvKey`). Used ONLY as the upstream auth header, never echoed.
  const resolvedKey = resolveEnvKey(row.apiKey);
  const base = row.baseUrl.replace(/\/+$/, '');
  const url = `${base}/models`;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (resolvedKey) headers['Authorization'] = `Bearer ${resolvedKey}`;
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        // keep the raw text slice
      }
      return writeJson(res, 200, {
        models: [],
        error: `discovery failed (${response.status})${message ? `: ${message}` : ''}`,
      });
    }
    const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(data?.data)
      ? data.data
          .map((m) => (typeof m?.id === 'string' ? m.id : ''))
          .filter((m): m is string => m.length > 0)
      : [];
    return writeJson(res, 200, { models });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return writeJson(res, 200, { models: [], error: `discovery failed: ${message}` });
  }
}

/**
 * `POST /admin/api/providers/:id/test` `{ model }` — issue ONE minimal upstream
 * completion using the provider's stored key, so the per-model "test" button on
 * the Provider page works (parity with the host app's per-model test). Mirrors
 * `handleDiscoverModels`' key-resolution + direct-fetch pattern. The provider's
 * `baseUrl` IS the full completion endpoint (per the preset catalog). Format-aware
 * body/headers for openai + anthropic; gemini is reported unsupported (its request
 * shape puts the model + key in the URL — out of this minimal tester's scope).
 *
 * SECRET-SAFE: the resolved key is used ONLY as the upstream auth header and is
 * NEVER serialized into the response (which carries only ok/status/latency/sample/
 * message).
 */
async function handleTestModel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string | undefined,
  cfg: DaemonConfig,
): Promise<void> {
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  const row = cfg.providers.find((p) => p.id === id);
  if (!row) return writeJsonError(res, 404, `provider '${id}' not found`);

  const body = (await readJsonBody(req)) as { model?: unknown };
  const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
  if (!model) return writeJsonError(res, 400, 'test requires a { model } string');

  if (row.apiFormat === 'gemini') {
    return writeJson(res, 200, { ok: false, unsupportedFormat: true });
  }

  const resolvedKey = resolveEnvKey(row.apiKey);
  if (!resolvedKey) {
    return writeJson(res, 200, { ok: false, message: 'no API key configured for this provider' });
  }
  const url = row.baseUrl.replace(/\/+$/, '');
  const prompt = 'Reply with the single word: OK.';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let payload: Record<string, unknown>;
  if (row.apiFormat === 'anthropic') {
    headers['x-api-key'] = resolvedKey;
    headers['anthropic-version'] = '2023-06-01';
    payload = { model, max_tokens: 16, messages: [{ role: 'user', content: prompt }] };
  } else {
    // openai wire format (also covers azure-openai / openai-response BYO rows).
    headers['Authorization'] = `Bearer ${resolvedKey}`;
    payload = {
      model,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        // keep the raw slice
      }
      return writeJson(res, 200, { ok: false, status: response.status, latencyMs, message });
    }
    return writeJson(res, 200, {
      ok: true,
      status: response.status,
      latencyMs,
      sample: extractSampleText(text, row.apiFormat),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return writeJson(res, 200, { ok: false, latencyMs: Date.now() - startedAt, message });
  }
}

/** Pull a short reply snippet from an openai/anthropic completion body (best-effort). */
function extractSampleText(text: string, apiFormat: DaemonProviderConfig['apiFormat']): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (apiFormat === 'anthropic') {
      const content = (data['content'] as Array<{ text?: unknown }> | undefined)?.[0]?.text;
      return typeof content === 'string' ? content.slice(0, 200) : '';
    }
    const choice = (data['choices'] as Array<{ message?: { content?: unknown } }> | undefined)?.[0];
    const content = choice?.message?.content;
    return typeof content === 'string' ? content.slice(0, 200) : '';
  } catch {
    return '';
  }
}

/** The masked, never-secret pool-key DTO the health view projects. */
interface PoolKeyView {
  id: string;
  label: string;
  enabled: boolean;
  weight: number;
  apiKeyMasked: string;
  health?: { cooldown?: PoolKeyHealth; autoDisabled?: { status: number; at: number; reason: string } };
}

/**
 * Project the provider's pool (mirroring the loader's D1 synthesis: an explicit
 * `apiKeys[]`, else a single-key 1-key fallback) to the masked health DTO. The
 * key value is ALWAYS run through `maskProviderApiKey` — the literal/`$ENV` name
 * never leaves (design D7). `health` merges the live cooldown map + the
 * in-memory auto-disable record.
 */
function toPoolKeyView(
  row: DaemonProviderConfig,
  cooldown: Record<string, PoolKeyHealth>,
  deps: AdminApiDeps,
): PoolKeyView[] {
  const entries: Array<{ id: string; apiKey: string; label?: string; enabled?: boolean; weight?: number }> =
    row.apiKeys && row.apiKeys.length > 0
      ? row.apiKeys
      : row.apiKey.length > 0
        ? [{ id: `${row.id}:default`, apiKey: row.apiKey, weight: 1, enabled: true }]
        : [];
  return entries.map((e) => {
    const auto = deps.autoDisableStore.get(e.id);
    const cd = cooldown[e.id];
    const health: PoolKeyView['health'] = {};
    if (cd) health.cooldown = cd;
    if (auto) health.autoDisabled = { status: auto.status, at: auto.at, reason: auto.reason };
    return {
      id: e.id,
      label: e.label && e.label.length > 0 ? e.label : e.id,
      // An auto-disabled key reads disabled even when the config flag is true.
      enabled: e.enabled !== false && !deps.autoDisableStore.isDisabled(e.id),
      weight: typeof e.weight === 'number' && Number.isFinite(e.weight) ? e.weight : 1,
      apiKeyMasked: maskProviderApiKey(e.apiKey),
      ...(Object.keys(health).length > 0 ? { health } : {}),
    };
  });
}

/**
 * `GET /admin/api/providers/:id/keys` (key-pool design D7) — read-only masked
 * pool health for one provider. Secret IN-never-OUT: no `apiKey` literal or
 * `$VAR` name is ever serialized (the mask handles both).
 */
async function handleProviderKeys(
  res: http.ServerResponse,
  id: string | undefined,
  cfg: DaemonConfig,
  deps: AdminApiDeps,
): Promise<void> {
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  const row = cfg.providers.find((p) => p.id === id);
  if (!row) return writeJsonError(res, 404, `provider '${id}' not found`);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return writeJson(res, 200, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * Positive-construction allowlist for ONE pool-key write (app-parity child 3).
 * Mirrors `parseApiKeysInput`'s per-entry discipline at the single-entry level:
 * only `{ label?, weight?, enabled?, apiKey? }` are ever read; every unknown
 * field is dropped (deny-by-default). A blank/omitted `apiKey` keeps the
 * `existing?.apiKey` (the child-1/2 omit→keep contract, per entry); a non-empty
 * `apiKey` replaces it. `id`/`providerId` are NOT taken from the body — the id is
 * minted on add / read from the path on update, the provider from the path.
 */
function parsePoolKeyInput(
  body: Record<string, unknown>,
  existing?: DaemonApiKeyEntry,
): { label?: string; weight?: number; enabled?: boolean; apiKey?: string } {
  const out: { label?: string; weight?: number; enabled?: boolean; apiKey?: string } = {};
  if (typeof body['label'] === 'string' && body['label'].length > 0) out.label = body['label'];
  else if (existing?.label) out.label = existing.label;
  if (typeof body['weight'] === 'number' && Number.isFinite(body['weight'])) out.weight = body['weight'];
  else if (typeof existing?.weight === 'number') out.weight = existing.weight;
  if (typeof body['enabled'] === 'boolean') out.enabled = body['enabled'];
  else if (typeof existing?.enabled === 'boolean') out.enabled = existing.enabled;
  const submitted = typeof body['apiKey'] === 'string' && body['apiKey'].length > 0 ? body['apiKey'] : '';
  const apiKey = submitted || existing?.apiKey || '';
  if (apiKey) out.apiKey = apiKey;
  return out;
}

/**
 * `POST /admin/api/providers/:id/keys` (app-parity child 3) — add one pool key.
 * Server-side read-modify-write on the provider row's `apiKeys[]`: mint a stable
 * id (OQ2 — never accept a client-suggested id), require a non-empty `apiKey`,
 * `persistProviders` (encrypts at rest via the SAME `saveConfig`+SecretBox path +
 * hot-reloads the pool keyCache). Responds ONLY the masked health view.
 *
 * SECRET-IN-never-OUT (design D3): the plaintext key crosses on the request IN
 * only — the response + any log carry ONLY `toPoolKeyView`'s masked output.
 */
async function handleAddProviderKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string | undefined,
  cfg: DaemonConfig,
  deps: AdminApiDeps,
): Promise<void> {
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return writeJsonError(res, 404, `provider '${id}' not found`);

  const body = await readJsonBody(req);
  const parsed = parsePoolKeyInput(body);
  if (!parsed.apiKey) return writeJsonError(res, 400, 'add requires a non-empty apiKey');

  const keyId = `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: DaemonApiKeyEntry = { id: keyId, apiKey: parsed.apiKey };
  if (parsed.label !== undefined) entry.label = parsed.label;
  if (parsed.enabled !== undefined) entry.enabled = parsed.enabled;
  if (parsed.weight !== undefined) entry.weight = parsed.weight;

  const row = cfg.providers[idx];
  row.apiKeys = [...(row.apiKeys ?? []), entry];
  persistProviders(cfg, deps);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return writeJson(res, 201, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * `PUT /admin/api/providers/:id/keys/:keyId` (child 3) — update ONE pool key's
 * `{ label?, weight?, enabled?, apiKey? }`. A blank/omitted `apiKey` KEEPS the
 * stored key (omit→keep); a non-empty one replaces it (re-encrypted at rest).
 * Responds ONLY the masked view (secret-IN-never-OUT).
 */
async function handleUpdateProviderKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string | undefined,
  keyId: string | undefined,
  cfg: DaemonConfig,
  deps: AdminApiDeps,
): Promise<void> {
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  if (!keyId) return writeJsonError(res, 400, 'key id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return writeJsonError(res, 404, `provider '${id}' not found`);
  const row = cfg.providers[idx];
  const keyIdx = (row.apiKeys ?? []).findIndex((k) => k.id === keyId);
  if (keyIdx < 0) return writeJsonError(res, 404, `pool key '${keyId}' not found`);

  const body = await readJsonBody(req);
  const existing = row.apiKeys![keyIdx];
  const parsed = parsePoolKeyInput(body, existing);
  // `apiKey` always resolves (blank keeps `existing.apiKey`); an entry with no
  // key at all is meaningless — keep the stored one defensively.
  const entry: DaemonApiKeyEntry = { id: keyId, apiKey: parsed.apiKey || existing.apiKey };
  if (parsed.label !== undefined) entry.label = parsed.label;
  if (parsed.enabled !== undefined) entry.enabled = parsed.enabled;
  if (parsed.weight !== undefined) entry.weight = parsed.weight;
  row.apiKeys![keyIdx] = entry;

  persistProviders(cfg, deps);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return writeJson(res, 200, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * `DELETE /admin/api/providers/:id/keys/:keyId` (child 3) — remove ONE pool key.
 * If the pool empties, set `apiKeys` to `undefined` (consistent with
 * `validateApiKeys`'s "empty → undefined = single-key fallback"). Responds the
 * masked view of the remaining pool.
 */
async function handleDeleteProviderKey(
  res: http.ServerResponse,
  id: string | undefined,
  keyId: string | undefined,
  cfg: DaemonConfig,
  deps: AdminApiDeps,
): Promise<void> {
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  if (!keyId) return writeJsonError(res, 400, 'key id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return writeJsonError(res, 404, `provider '${id}' not found`);
  const row = cfg.providers[idx];
  const keyIdx = (row.apiKeys ?? []).findIndex((k) => k.id === keyId);
  if (keyIdx < 0) return writeJsonError(res, 404, `pool key '${keyId}' not found`);

  row.apiKeys!.splice(keyIdx, 1);
  if (row.apiKeys!.length === 0) row.apiKeys = undefined;
  persistProviders(cfg, deps);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return writeJson(res, 200, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * `POST /admin/api/providers/:id/keys/:keyId/enabled` (child 3) — flip ONE pool
 * key's `enabled` flag from `{ enabled: boolean }` (coerced). Responds the masked
 * view (the live pool's auto-disable health still applies post-hot-reload).
 */
async function handleToggleProviderKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string | undefined,
  keyId: string | undefined,
  cfg: DaemonConfig,
  deps: AdminApiDeps,
): Promise<void> {
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  if (!keyId) return writeJsonError(res, 400, 'key id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return writeJsonError(res, 404, `provider '${id}' not found`);
  const row = cfg.providers[idx];
  const keyIdx = (row.apiKeys ?? []).findIndex((k) => k.id === keyId);
  if (keyIdx < 0) return writeJsonError(res, 404, `pool key '${keyId}' not found`);

  const body = await readJsonBody(req);
  row.apiKeys![keyIdx].enabled = Boolean(body['enabled']);
  persistProviders(cfg, deps);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return writeJson(res, 200, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * Parse the body's `apiKeys[]` pool (key-pool design D7), reusing the
 * "blank key keeps the stored value" semantics PER pool key id: a submitted
 * entry whose `apiKey` is blank/omitted keeps the matching existing entry's key
 * (matched by `id`). Bad entries (missing id) are skipped. A non-array → keep
 * the existing pool unchanged; an explicit empty array → clear the pool.
 */
function parseApiKeysInput(
  raw: unknown,
  existing: DaemonApiKeyEntry[] | undefined,
): DaemonApiKeyEntry[] | undefined {
  if (!Array.isArray(raw)) return existing;
  const byId = new Map((existing ?? []).map((e) => [e.id, e]));
  const out: DaemonApiKeyEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const k = item as Record<string, unknown>;
    const id = typeof k['id'] === 'string' && k['id'].trim() ? k['id'].trim() : '';
    if (!id) continue;
    const prior = byId.get(id);
    const submittedKey = typeof k['apiKey'] === 'string' && k['apiKey'].length > 0 ? k['apiKey'] : '';
    const apiKey = submittedKey || prior?.apiKey || '';
    if (!apiKey) continue; // no key submitted and none stored → drop
    const entry: DaemonApiKeyEntry = { id, apiKey };
    if (typeof k['label'] === 'string' && k['label'].length > 0) entry.label = k['label'];
    else if (prior?.label) entry.label = prior.label;
    if (typeof k['enabled'] === 'boolean') entry.enabled = k['enabled'];
    else if (typeof prior?.enabled === 'boolean') entry.enabled = prior.enabled;
    if (typeof k['weight'] === 'number' && Number.isFinite(k['weight'])) entry.weight = k['weight'];
    else if (typeof prior?.weight === 'number') entry.weight = prior.weight;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the body's `modelConfigs[]` per-model metadata (app-parity child 2),
 * mirroring `parseApiKeysInput`: ARRAY-REPLACE with per-entry prior-id fallback.
 * A non-array → keep the `existing` array unchanged (the caller handles the
 * explicit-`null`-clears contract before calling here). For a submitted entry,
 * the body's fields win; an OMITTED field on a provided entry falls back to the
 * prior same-id entry's value (so metadata the daemon stores but the client did
 * not echo is not silently dropped). Deny-by-default: only the named-five
 * allowlisted fields are ever copied; a bad entry (missing id) is skipped. An
 * empty/all-bad array collapses to `undefined` (same as "no metadata").
 */
function parseModelConfigsInput(
  raw: unknown,
  existing: DaemonModelConfig[] | undefined,
): DaemonModelConfig[] | undefined {
  if (!Array.isArray(raw)) return existing;
  const byId = new Map((existing ?? []).map((e) => [e.id, e]));
  const out: DaemonModelConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m['id'] === 'string' && m['id'].trim() ? m['id'].trim() : '';
    if (!id) continue;
    const prior = byId.get(id);
    const entry: DaemonModelConfig = { id };
    if (typeof m['name'] === 'string' && m['name'].length > 0) entry.name = m['name'];
    else if (prior?.name) entry.name = prior.name;
    if (typeof m['group'] === 'string' && m['group'].length > 0) entry.group = m['group'];
    else if (prior?.group) entry.group = prior.group;
    if (typeof m['enabled'] === 'boolean') entry.enabled = m['enabled'];
    else if (typeof prior?.enabled === 'boolean') entry.enabled = prior.enabled;
    if (typeof m['vision'] === 'boolean') entry.vision = m['vision'];
    else if (typeof prior?.vision === 'boolean') entry.vision = prior.vision;
    if (typeof m['reasoning'] === 'boolean') entry.reasoning = m['reasoning'];
    else if (typeof prior?.reasoning === 'boolean') entry.reasoning = prior.reasoning;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the body's `transformer` config (app-parity child 5). Mirrors the SAME
 * allowlist as the load guard (`validateTransformer` in config.ts), reusing the
 * shared `validateTransformerEntry` so the two gateways stay LOCKSTEP. On a
 * provided object the BODY WINS (full replace — the app sends the FULL desired
 * `transformer`): keep each well-formed `use[]` entry (non-empty string OR
 * `[string, object]` tuple, drop the rest) + preserve unknown per-model keys
 * VERBATIM only when object/array-shaped (deny-by-default: scalar/garbage at an
 * unknown key is dropped). A non-object → keep `existing`; an empty result
 * collapses to `undefined`. (The caller handles explicit `null` → clear before
 * calling here.) Never throws. NON-SECRET.
 */
function parseTransformerInput(
  raw: unknown,
  existing: DaemonTransformerConfig | undefined,
): DaemonTransformerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return existing;
  const t = raw as Record<string, unknown>;
  const out: DaemonTransformerConfig = {};
  let kept = false;
  if (Array.isArray(t['use'])) {
    const use: DaemonTransformerEntry[] = [];
    for (const item of t['use']) {
      const entry = validateTransformerEntry(item);
      if (entry !== null) use.push(entry);
    }
    if (use.length > 0) {
      out.use = use;
      kept = true;
    }
  }
  for (const key of Object.keys(t)) {
    if (key === 'use') continue;
    const value = t[key];
    if (value && typeof value === 'object') {
      out[key] = value;
      kept = true;
    }
  }
  return kept ? out : undefined;
}

/**
 * Parse a `codingPlan` write body (app-parity-2 child 3). Called ONLY when the
 * body carries a non-null `codingPlan` OBJECT (the null/omit three-way lives in
 * `parseProviderInput`). Deny-by-default allowlist `{enabled,baseUrl,apiKey,note}`.
 * NESTED-SECRET blank-keeps: a non-empty `apiKey` SETS; an empty/absent `apiKey`
 * KEEPS the existing stored coding-plan key (mirrors the main apiKey blank-on-edit,
 * since the masked GET never returns the literal key). `baseUrl`/`note` follow the
 * value/`null`-clear/omit-keep contract. Collapses to undefined when nothing
 * meaningful remains (not enabled + no fields), reading as "no coding-plan".
 */
function parseCodingPlanInput(
  raw: Record<string, unknown>,
  existing: DaemonCodingPlanConfig | undefined,
): DaemonCodingPlanConfig | undefined {
  const enabled = raw['enabled'] === true;
  const baseUrl =
    typeof raw['baseUrl'] === 'string' && raw['baseUrl'].length > 0
      ? (raw['baseUrl'] as string)
      : raw['baseUrl'] === null
        ? undefined
        : existing?.baseUrl;
  // nested-secret blank-keeps: non-empty SETS; empty/absent KEEPS the stored key.
  const apiKey =
    typeof raw['apiKey'] === 'string' && raw['apiKey'].length > 0
      ? (raw['apiKey'] as string)
      : existing?.apiKey;
  const note =
    typeof raw['note'] === 'string' && raw['note'].length > 0
      ? (raw['note'] as string)
      : raw['note'] === null
        ? undefined
        : existing?.note;
  if (!enabled && !baseUrl && !apiKey && !note) return undefined;
  const out: DaemonCodingPlanConfig = { enabled };
  if (baseUrl) out.baseUrl = baseUrl;
  if (apiKey) out.apiKey = apiKey;
  if (note) out.note = note;
  return out;
}

/**
 * Parse an `apiModes` write body (app-parity-2 child 4). Array-replace via a
 * deny-by-default allowlist `{id,label,baseUrl,apiKey,apiKeyPrefix,note}`, keyed by
 * mode id so each mode's NESTED-SECRET `apiKey` blank-keeps: an empty/absent key
 * keeps the prior stored key for that mode id (the masked view never returns it).
 * An entry missing `id` or `baseUrl` is dropped; a non-array → keep existing.
 */
function parseApiModesInput(
  raw: unknown,
  existing: DaemonApiMode[] | undefined,
): DaemonApiMode[] | undefined {
  if (!Array.isArray(raw)) return existing;
  const byId = new Map((existing ?? []).map((m) => [m.id, m]));
  const out: DaemonApiMode[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m['id'] === 'string' && m['id'].trim() ? m['id'].trim() : '';
    const baseUrl = typeof m['baseUrl'] === 'string' && m['baseUrl'].length > 0 ? (m['baseUrl'] as string) : '';
    if (!id || !baseUrl) continue;
    const prior = byId.get(id);
    const label = typeof m['label'] === 'string' && m['label'].length > 0 ? (m['label'] as string) : (prior?.label ?? id);
    const entry: DaemonApiMode = { id, label, baseUrl };
    // nested-secret blank-keeps for the mode key.
    if (typeof m['apiKey'] === 'string' && m['apiKey'].length > 0) entry.apiKey = m['apiKey'];
    else if (prior?.apiKey) entry.apiKey = prior.apiKey;
    const prefix = typeof m['apiKeyPrefix'] === 'string' && m['apiKeyPrefix'].length > 0 ? (m['apiKeyPrefix'] as string) : prior?.apiKeyPrefix;
    if (prefix) entry.apiKeyPrefix = prefix;
    const note = typeof m['note'] === 'string' && m['note'].length > 0 ? (m['note'] as string) : prior?.note;
    if (note) entry.note = note;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate a provider input body. When `existing` is supplied (PUT), a
 * blank/omitted `apiKey`/`id` falls back to the stored value (id is immutable on
 * edit; the key is kept when not re-entered). Returns `null` on a bad shape.
 */
export function parseProviderInput(
  body: Record<string, unknown>,
  existing: DaemonProviderConfig | undefined,
): DaemonProviderConfig | null {
  // `id` is the IMMUTABLE identity (model refs `"<id>,<model>"`, pool + account
  // keys). On a PUT (existing present) the STORED id ALWAYS wins — a body `id` is
  // ignored, so a mismatched/forged `id` can never silently rename/orphan the row
  // at this slot (the editable display label is the separate `name` field). On a
  // POST (no existing) the body must supply a non-empty `id`.
  const id = existing
    ? existing.id
    : typeof body['id'] === 'string' && body['id'].trim()
      ? body['id'].trim()
      : undefined;
  const apiFormat = body['apiFormat'];
  const baseUrl = body['baseUrl'];
  if (!id) return null;
  // Display name (app-parity-2 child 1): the SAME three-way write contract —
  //   OMIT (key absent)  → keep the stored value;
  //   null               → CLEAR (→ undefined; the app falls back to the id);
  //   non-empty string   → set it.
  const name =
    typeof body['name'] === 'string' && body['name'].length > 0
      ? (body['name'] as string)
      : body['name'] === null
        ? undefined
        : existing?.name;
  if (apiFormat !== 'openai' && apiFormat !== 'anthropic' && apiFormat !== 'gemini') return null;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
  const rawKey = body['apiKey'];
  let apiKey =
    typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : (existing?.apiKey ?? '');
  const models = Array.isArray(body['models'])
    ? (body['models'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : existing?.models;
  // Per-model metadata (app-parity child 2): the same three-way write contract at
  // the ARRAY level — OMIT (key absent) keeps the stored array (no accidental
  // wipe on an unrelated edit); explicit `null` clears it (→ undefined); an array
  // replaces it via the deny-by-default allowlist parse (per-entry prior-id
  // fallback for omitted fields). The app always sends the FULL desired array.
  const modelConfigs =
    body['modelConfigs'] === null
      ? undefined
      : parseModelConfigsInput(body['modelConfigs'], existing?.modelConfigs);
  // Pool keys (key-pool change): edit the row's `apiKeys[]` through the SAME PUT
  // (no new write endpoint, design D7). Absent in the body → keep existing.
  const apiKeys = parseApiKeysInput(body['apiKeys'], existing?.apiKeys);
  // Enable flag (app-foundation D8): a real boolean in the body wins; absent →
  // keep the existing stored value (no accidental re-enable on an unrelated edit).
  const enabled =
    typeof body['enabled'] === 'boolean' ? (body['enabled'] as boolean) : existing?.enabled;
  // Scalar fields (app-parity child 1): deny-by-default (only these allowlisted
  // keys are ever copied) with a uniform three-way write contract per field —
  //   OMIT (key absent)  → keep the existing stored value (no accidental wipe);
  //   null               → CLEAR the stored field (→ undefined);
  //   value (right type) → set it.
  const isOfficial =
    typeof body['isOfficial'] === 'boolean' ? (body['isOfficial'] as boolean) : existing?.isOfficial;
  // apiVersion / modelsEndpoint (string): non-empty string sets; explicit `null`
  // clears; absent keeps (the app sends `null`, never `''`, to clear — D4 / OQ2).
  const apiVersion =
    typeof body['apiVersion'] === 'string' && body['apiVersion'].length > 0
      ? (body['apiVersion'] as string)
      : body['apiVersion'] === null
        ? undefined
        : existing?.apiVersion;
  const modelsEndpoint =
    typeof body['modelsEndpoint'] === 'string' && body['modelsEndpoint'].length > 0
      ? (body['modelsEndpoint'] as string)
      : body['modelsEndpoint'] === null
        ? undefined
        : existing?.modelsEndpoint;
  // maxConcurrency (number): a finite number sets; explicit `null` clears; absent keeps.
  const maxConcurrency =
    typeof body['maxConcurrency'] === 'number' && Number.isFinite(body['maxConcurrency'])
      ? (body['maxConcurrency'] as number)
      : body['maxConcurrency'] === null
        ? undefined
        : existing?.maxConcurrency;
  // Transformer config (app-parity child 5): the SAME three-way write contract —
  //   OMIT (key absent)  → keep the existing stored value (no accidental wipe);
  //   null               → CLEAR the stored config (→ undefined);
  //   object             → REPLACE via the deny-by-default allowlist parse
  //                        (preserving unknown per-model keys verbatim).
  // PERSISTED-NOT-ENFORCED: stored + round-tripped, but the daemon's transform
  // chain stays apiFormat-keyed (no routing change from a stored transformer).
  const transformer =
    body['transformer'] === null
      ? undefined
      : parseTransformerInput(body['transformer'], existing?.transformer);
  // Coding-plan endpoint (app-parity-2 child 3): the SAME three-way at the object
  // level — `null` clears, omit keeps the stored value, a non-null object merges
  // via `parseCodingPlanInput` (nested-secret blank-keeps for its apiKey). A
  // garbage non-object keeps the stored value (deny-by-default, no wipe).
  const codingPlan =
    body['codingPlan'] === null
      ? undefined
      : body['codingPlan'] === undefined
        ? existing?.codingPlan
        : body['codingPlan'] && typeof body['codingPlan'] === 'object' && !Array.isArray(body['codingPlan'])
          ? parseCodingPlanInput(body['codingPlan'] as Record<string, unknown>, existing?.codingPlan)
          : existing?.codingPlan;
  // API modes (app-parity-2 child 4): array-replace via the allowlist (nested-secret
  // blank-keeps per mode); `null` clears; omit keeps. selectedApiModeId: value sets,
  // `null` clears, omit keeps.
  const apiModes =
    body['apiModes'] === null ? undefined : parseApiModesInput(body['apiModes'], existing?.apiModes);
  const selectedApiModeId =
    typeof body['selectedApiModeId'] === 'string' && body['selectedApiModeId'].length > 0
      ? (body['selectedApiModeId'] as string)
      : body['selectedApiModeId'] === null
        ? undefined
        : existing?.selectedApiModeId;
  // Server-side mode-key sync on a SWITCH (app-parity-2 child 4): the app syncs the
  // selected mode's baseUrl app-side (non-secret) but CANNOT sync the mode's key
  // (masked). So when this PUT switches `selectedApiModeId` (changed vs stored),
  // passes NO explicit `apiKey`, AND the body's `baseUrl` EQUALS the selected mode's
  // baseUrl (a NORMAL switch — "keep customizations" sends the current/custom URL,
  // which won't match), adopt the selected mode's stored key (if it has one) —
  // server-side, where the real decrypted key lives. The baseUrl-match discriminator
  // preserves keepCustomizations (custom URL ≠ mode URL → key untouched).
  if (
    typeof body['selectedApiModeId'] === 'string' &&
    body['selectedApiModeId'].length > 0 &&
    body['selectedApiModeId'] !== existing?.selectedApiModeId &&
    !(typeof rawKey === 'string' && rawKey.length > 0)
  ) {
    const mode = apiModes?.find((m) => m.id === selectedApiModeId);
    if (mode?.apiKey && typeof body['baseUrl'] === 'string' && body['baseUrl'] === mode.baseUrl) {
      apiKey = mode.apiKey;
    }
  }
  return {
    id,
    name,
    apiFormat,
    baseUrl: baseUrl.trim(),
    apiKey,
    models,
    modelConfigs,
    apiKeys,
    enabled,
    isOfficial,
    apiVersion,
    maxConcurrency,
    modelsEndpoint,
    transformer,
    codingPlan,
    apiModes,
    selectedApiModeId,
  };
}

// ── Presets (read-only catalog projection; no secrets) ────────────────────────

/**
 * `GET /admin/api/presets` → the curated catalog projected to a minimal
 * whitelist DTO for the dashboard's preset picker. Presets carry NO apiKey, but
 * DTO discipline still holds: only `id/presetId/name/apiFormat/baseUrl/models`
 * are projected — the full `PresetProviderTemplate` (transformer/searchConfig/…)
 * is NEVER serialized. `apiFormat` is the NARROWED daemon format (google→gemini),
 * so a picked preset validates against the provider write path unchanged.
 */
function handlePresets(res: http.ServerResponse, method: string): void {
  if (method !== 'GET') return writeJsonError(res, 405, `method ${method} not allowed on presets`);
  const { mappable, excluded } = listMappablePresets();
  const presets = mappable.map((p) => ({
    id: p.id,
    presetId: p.presetId,
    name: p.name,
    apiFormat: p.apiFormat,
    baseUrl: p.baseUrl,
    models: p.models,
  }));
  return writeJson(res, 200, { presets, excluded });
}

// ── Keys (CRUD + one-time plaintext) ──────────────────────────────────────────

async function handleKeys(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (method === 'GET' && rest.length === 0) {
    const rows = await deps.keyDb.outboundApiKeysList();
    return writeJson(res, 200, { keys: rows.map(toKeyInfo) });
  }

  if (method === 'POST' && rest.length === 0) {
    const body = await readJsonBody(req);
    const name = typeof body['name'] === 'string' && body['name'].trim() ? body['name'].trim() : 'key';
    const created = await createNamedKey(deps.keyDb, name);
    // `plaintextOnce` is the ONLY place a full key crosses the wire (design D4).
    return writeJson(res, 201, {
      id: created.id,
      name: created.name,
      keyPrefix: created.keyPrefix,
      createdAt: created.createdAt,
      plaintextOnce: created.plaintextOnce,
    });
  }

  const id = rest[0];
  const action = rest[1];
  if (method === 'POST' && id && action === 'revoke') {
    const ok = await deps.keyDb.outboundApiKeysRevoke(id);
    return writeJson(res, ok ? 200 : 404, { ok });
  }
  if (method === 'POST' && id && action === 'enabled') {
    const body = await readJsonBody(req);
    const enabled = body['enabled'] === true;
    const ok = await deps.keyDb.outboundApiKeysSetEnabled(id, enabled);
    return writeJson(res, ok ? 200 : 404, { ok, enabled });
  }
  if (method === 'POST' && id && action === 'max-concurrency') {
    const body = await readJsonBody(req);
    const raw = body['maxConcurrency'];
    // Strict admin-edge validation (unlike core's lenient clamp): a positive
    // integer 1..1000, or explicit `null` to clear. Anything else → 400.
    let value: number | null;
    if (raw === null) {
      value = null;
    } else if (
      typeof raw === 'number' &&
      Number.isInteger(raw) &&
      raw >= 1 &&
      raw <= 1000
    ) {
      value = raw;
    } else {
      return writeJsonError(
        res,
        400,
        'maxConcurrency must be an integer 1..1000 or null',
      );
    }
    const ok = await deps.keyDb.outboundApiKeysSetMaxConcurrency(id, value);
    return writeJson(res, ok ? 200 : 404, { ok, maxConcurrency: value });
  }

  return writeJsonError(res, 405, `method ${method} not allowed on keys`);
}

// ── Server config (live apply) ────────────────────────────────────────────────

/**
 * Strictly range-validate the queue config segments PRESENT in a `PUT /server`
 * patch (§1 ranges, planning-context). Deliberately stricter than core's lenient
 * `normalizeQueueSegments` clamp — an operator write gets a clear error, not a
 * silently coerced value. Only validates segments actually present in the patch
 * (a partial PUT stays partial). Returns a list of field errors (empty = valid).
 */
function validateQueueSegments(patch: Partial<OutboundApiServerConfig>): string[] {
  const errors: string[] = [];
  const checkNum = (label: string, value: unknown, min: number, max: number): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      errors.push(`${label} must be a number ${min}..${max}`);
    }
  };
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  // A PRESENT segment must be a plain object before we deref its fields — an
  // explicit `null` / string / array otherwise dereferences null → TypeError →
  // 500; reject it as a 400 like any other malformed input.
  const umq: unknown = patch.userMessageQueue;
  if (umq !== undefined) {
    if (!isPlainObject(umq)) {
      errors.push('userMessageQueue must be an object');
    } else {
      if (typeof umq.enabled !== 'boolean') {
        errors.push('userMessageQueue.enabled must be a boolean');
      }
      checkNum('userMessageQueue.delayMs', umq.delayMs, 0, 10_000);
      checkNum('userMessageQueue.waitTimeoutMs', umq.waitTimeoutMs, 1000, 300_000);
    }
  }

  const cq: unknown = patch.concurrencyQueue;
  if (cq !== undefined) {
    if (!isPlainObject(cq)) {
      errors.push('concurrencyQueue must be an object');
    } else {
      checkNum('concurrencyQueue.maxQueueSizeFactor', cq.maxQueueSizeFactor, 1, 10);
      checkNum('concurrencyQueue.minQueueSize', cq.minQueueSize, 1, 100);
      checkNum('concurrencyQueue.waitTimeoutMs', cq.waitTimeoutMs, 1000, 300_000);
    }
  }

  return errors;
}

async function handleServer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method === 'GET') {
    const config = await loadServerConfig(deps.settingsStore);
    return writeJson(res, 200, { server: config });
  }
  if (method === 'PUT') {
    const patch = (await readJsonBody(req)) as Partial<OutboundApiServerConfig>;
    // Strict queue-segment validation BEFORE any merge/persist: an illegal value
    // in a PRESENT segment → 400 and nothing is written (unlike core's lenient
    // clamp). Segments absent from the patch are not validated (partial PUT).
    const queueErrors = validateQueueSegments(patch);
    if (queueErrors.length > 0) {
      return writeJsonError(res, 400, `invalid queue config: ${queueErrors.join('; ')}`);
    }
    const current = await loadServerConfig(deps.settingsStore);
    const merged = mergeServerConfig(current, patch);
    // Always persist the (partial) config so the editor retains the user's
    // in-progress mappings even when the config can't yet start the listener.
    await saveServerConfig(deps.settingsStore, merged);

    // Startup gate (model-kind-mapping): when enabling with an incomplete
    // kind map, refuse to bind and return an actionable envelope (HTTP 200 so
    // the client reads `error.missing`; a 4xx would collapse to a bare message).
    // The core validator is the SSOT; catching serving's config error below is
    // defense-in-depth (the pre-check normally makes it unreachable).
    if (merged.enabled) {
      const missing = validateServerModelConfig(merged);
      if (missing.length > 0) {
        // The persisted config is now incomplete, so the outbound server must not
        // keep serving a STALE mapping: if a previous (valid) config left the
        // listener bound, tear it down so live state matches the "cannot start"
        // the UI shows (honors 未配置→无法启动接口服务). stop() is idempotent.
        if (deps.outboundApiServer.getStatus().running) {
          await deps.outboundApiServer.stop();
        }
        return writeJson(res, 200, {
          server: merged,
          error: { code: 'incomplete-model-config', missing },
        });
      }
    }

    try {
      await deps.outboundApiServer.applyConfig({
        enabled: merged.enabled,
        networkBinding: merged.networkBinding,
        endpoints: merged.endpoints,
        port: merged.port,
        userMessageQueue: merged.userMessageQueue,
        concurrencyQueue: merged.concurrencyQueue,
      });
    } catch (err) {
      // Defense-in-depth: if serving still throws an incomplete-config error
      // (duck-typed to avoid coupling to serving's concrete error class), surface
      // the same envelope instead of a 500. Other failures propagate as before.
      const missing = incompleteConfigMissing(err);
      if (missing) {
        return writeJson(res, 200, {
          server: merged,
          error: { code: 'incomplete-model-config', missing },
        });
      }
      throw err;
    }
    return writeJson(res, 200, { server: merged });
  }
  return writeJsonError(res, 405, `method ${method} not allowed on server`);
}

/**
 * Duck-typed guard for serving's incomplete-config throw (`OutboundApiConfigError`
 * carries `missing: EndpointModelConfigError[]`). Structural on purpose — the
 * surface stays independent of serving's concrete error class.
 */
function incompleteConfigMissing(err: unknown): EndpointModelConfigError[] | null {
  if (typeof err !== 'object' || err === null) return null;
  const missing = (err as { missing?: unknown }).missing;
  return Array.isArray(missing) ? (missing as EndpointModelConfigError[]) : null;
}

// ── Accounts (token-free GET status + secret-IN-never-OUT write) ───────────────

/**
 * `GET /admin/api/accounts` → token-free `listAll()` (UNCHANGED read path).
 * `PUT|POST /admin/api/accounts/:providerId` → validate the body to the
 * provider's token shape, write it via the least-authority writer, respond
 * STATUS-ONLY (the token-free `SubscriptionListEntry`).
 * `DELETE /admin/api/accounts/:providerId` → clear that provider's block.
 *
 * SECRET SPINE (design D5): the response NEVER serializes the request body or any
 * token field — only the token-free status. The write is auth-gated by
 * `AdminServer.dispatch` (constant-time `admin.token` + LAN fail-closed) like
 * every `/admin/*` route.
 */
async function handleAccounts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  // GET (no `:providerId`) → token-free list + sanitized per-provider accounts
  // arrays (design D8 — id/label/status/expiresAt/hasAccessToken/isActive only,
  // NEVER a raw token or `enc:` envelope).
  if (method === 'GET' && rest.length === 0) {
    const accounts = await deps.subscriptionAccounts.listAll();
    const providerAccounts = await deps.subscriptionTokenWriter.listSanitizedAccounts();
    // External CLI login detection (external-cli-sync): pure file-presence
    // booleans for the UI's "import existing CLI login" affordance — no token.
    const externalCli = await deps.subscriptionTokenWriter.listExternalCliAvailability();
    return writeJson(res, 200, { accounts, providerAccounts, externalCli });
  }

  // GET /accounts/codex/oauth/:sessionId/status → token-free poll for the async
  // codex loopback sign-in (app-parity-2 child 5). Returns ONLY { state, message? }.
  if (method === 'GET' && rest[0] === 'codex' && rest[1] === 'oauth' && rest[3] === 'status') {
    const result = handleCodexOAuthStatus(rest[2], deps);
    return writeJson(res, result.status, result.body);
  }

  if (method === 'PUT' || method === 'POST' || method === 'DELETE') {
    const providerId = asSubscriptionProviderId(rest[0]);
    if (!providerId) {
      return writeJsonError(res, 400, `unknown subscription provider '${rest[0] ?? ''}'`);
    }

    // POST /accounts/:providerId/oauth/start → mint the authorize URL + an opaque
    // sessionId. Matched BEFORE the generic write fallthrough. Returns ONLY
    // { authUrl, sessionId } — no secret crosses the wire. codex (app-parity-2 child
    // 5) is LOOPBACK-based (async + polled), so it routes to the codex start; claude/
    // gemini (app-parity child 4) are code-paste (two-phase start/complete).
    if (method === 'POST' && rest[1] === 'oauth' && rest[2] === 'start') {
      const result = providerId === 'codex' ? handleCodexOAuthStart(deps) : handleOAuthStart(providerId, deps);
      return writeJson(res, result.status, result.body);
    }

    // POST /accounts/:providerId/oauth/complete { sessionId, code } → exchange +
    // persist (encrypted) + activate; respond ONLY the sanitized status (the
    // minted token is NEVER echoed or logged).
    if (method === 'POST' && rest[1] === 'oauth' && rest[2] === 'complete') {
      const body = await readJsonBody(req);
      const result = await handleOAuthComplete(providerId, body, deps);
      return writeJson(res, result.status, result.body);
    }

    // POST /accounts/:providerId/accounts → APPEND a new account (manual add).
    // The body is the same validated token block (+ an optional `label`). Unlike
    // the generic PUT/POST write below (which REPLACES the active account), this
    // always appends + activates — the only way to add a SECOND manual account
    // (and the sole multi-account path for the OAuth-less opencodego provider).
    if (method === 'POST' && rest[1] === 'accounts') {
      const body = await readJsonBody(req);
      const block = validateTokenBody(providerId, body);
      if (!block) {
        return writeJsonError(res, 400, `malformed token body for provider '${providerId}'`);
      }
      const label =
        typeof body['label'] === 'string' && body['label'].trim() ? body['label'].trim() : undefined;
      await deps.subscriptionAccountAppender.appendProviderAccount(providerId, block, label);
      const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
      return writeJson(res, 200, status ? { account: status } : { ok: true });
    }

    // POST /accounts/:providerId/import-external { label? } → import the external
    // CLI's current login as a NEW account + take managed ownership of the native
    // store (external-cli-sync). claude/codex only. STATUS-ONLY response — the
    // imported credential never crosses the wire.
    if (method === 'POST' && rest[1] === 'import-external') {
      if (providerId !== 'claude' && providerId !== 'codex') {
        return writeJsonError(res, 400, `provider '${providerId}' has no external CLI store`);
      }
      const body = await readJsonBody(req);
      const label =
        typeof body['label'] === 'string' && body['label'].trim() ? body['label'].trim() : undefined;
      const result = await deps.subscriptionTokenWriter.importExternalCliAccount(providerId, label);
      if (!result.ok) {
        return writeJsonError(res, 409, `no usable external ${providerId} CLI credential found`);
      }
      const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
      return writeJson(res, 200, { ok: true, account: status ?? undefined });
    }

    // POST /accounts/:providerId/refresh → refresh the ACTIVE account's OAuth
    // token (the daemon already holds the refresh capability; the active block's
    // refresh_token is used). opencodego is a static key → not refreshable. The
    // response is STATUS-ONLY with an honest `ok` (false → no refresh_token or the
    // upstream refresh failed); the minted token is never echoed.
    if (method === 'POST' && rest[1] === 'refresh') {
      if (providerId === 'opencodego') {
        return writeJsonError(res, 400, 'opencodego credentials are not refreshable');
      }
      const writer = deps.subscriptionTokenWriter;
      const ok =
        providerId === 'claude'
          ? await writer.refreshClaudeToken()
          : providerId === 'codex'
            ? await writer.refreshCodexToken()
            : await writer.refreshGeminiToken();
      const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
      return writeJson(res, 200, { ok, account: status ?? undefined });
    }

    // POST /accounts/:providerId/:accountId/label { label } → rename one account
    // (label-only; no token is read or written). STATUS-ONLY ack.
    if (method === 'POST' && rest[2] === 'label') {
      const accountId = rest[1];
      const body = await readJsonBody(req);
      const label = typeof body['label'] === 'string' ? body['label'].trim() : '';
      const result = await deps.subscriptionTokenWriter.renameAccount(providerId, accountId, label);
      if (!result.ok) return writeJsonError(res, 404, `account '${accountId}' not found`);
      return writeJson(res, 200, { ok: true });
    }

    // POST /accounts/:providerId/:accountId/priority { priority } → set one
    // account's scheduling priority (subscription-account-scheduling). Secret-free
    // (no token read/write). STATUS-ONLY ack.
    if (method === 'POST' && rest[2] === 'priority') {
      const accountId = rest[1];
      const body = await readJsonBody(req);
      const raw = body['priority'];
      const priority = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(priority)) {
        return writeJsonError(res, 400, 'priority must be a finite number');
      }
      const result = await deps.subscriptionTokenWriter.setAccountPriority(providerId, accountId, priority);
      if (!result.ok) return writeJsonError(res, 404, `account '${accountId}' not found`);
      return writeJson(res, 200, { ok: true });
    }

    // PUT /accounts/:providerId/active { id } → switch active account (STATUS-ONLY).
    if (method === 'PUT' && rest[1] === 'active') {
      const body = await readJsonBody(req);
      const id = typeof body['id'] === 'string' ? body['id'] : '';
      if (!id) return writeJsonError(res, 400, 'active switch requires { id }');
      const result = await deps.subscriptionTokenWriter.setActiveAccount(providerId, id);
      if (!result.ok) return writeJsonError(res, 404, `account '${id}' not found`);
      return writeJson(res, 200, { ok: true });
    }

    // DELETE /accounts/:providerId/:accountId → remove one account (STATUS-ONLY).
    if (method === 'DELETE' && rest.length >= 2) {
      const accountId = rest[1];
      const result = await deps.subscriptionTokenWriter.removeAccount(providerId, accountId);
      if (!result.removed) return writeJsonError(res, 404, `account '${accountId}' not found`);
      return writeJson(res, 200, { ok: true });
    }

    // DELETE /accounts/:providerId → clear the whole provider block.
    if (method === 'DELETE') {
      await deps.subscriptionTokenWriter.clearProvider(providerId);
      return writeJson(res, 200, { ok: true });
    }

    const body = await readJsonBody(req);
    const config = validateTokenBody(providerId, body);
    if (!config) {
      return writeJsonError(res, 400, `malformed token body for provider '${providerId}'`);
    }
    await deps.subscriptionTokenWriter.writeProviderTokens(providerId, config);
    // STATUS-ONLY response — the token-free entry for this provider (never the body).
    const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
    return writeJson(res, 200, status ? { account: status } : { ok: true });
  }

  return writeJsonError(res, 405, `method ${method} not allowed on accounts`);
}

// ── Code CLI launch (dashboard parity) ────────────────────────────────────────

/**
 * `GET /cli` → per-CLI availability (PATH probe). `POST /cli/:cli/launch
 * { providerId?, model?, cwd? }` → open a terminal running the CLI pointed at the
 * daemon proxy (route-token env — never a provider key). `GET /cli/sessions` /
 * `DELETE /cli/sessions/:id` → list / stop the registered launches.
 */
async function handleCli(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (method === 'GET' && rest.length === 0) {
    const result = handleCliList(process.platform, deps.cliPathProbe);
    return writeJson(res, result.status, result.body);
  }
  if (method === 'GET' && rest[0] === 'sessions') {
    const result = handleCliSessions();
    return writeJson(res, result.status, result.body);
  }
  if (method === 'DELETE' && rest[0] === 'sessions' && rest[1]) {
    const result = handleCliStop(rest[1]);
    return writeJson(res, result.status, result.body);
  }
  if (method === 'POST' && rest[1] === 'install') {
    const cli = rest[0];
    if (!isLaunchCliId(cli)) {
      return writeJsonError(res, 400, `unknown cli '${cli ?? ''}'`);
    }
    const result = await handleCliInstall(cli, deps.cliCommandRunner);
    return writeJson(res, result.status, result.body);
  }
  if (method === 'POST' && rest[1] === 'launch') {
    const cli = rest[0];
    if (!isLaunchCliId(cli)) {
      return writeJsonError(res, 400, `unknown cli '${cli ?? ''}'`);
    }
    const body = await readJsonBody(req);
    const providers = loadConfig(deps.configPath).providers ?? [];
    const result = await handleCliLaunch(cli, body, {
      llmConfig: deps.llmConfig,
      providers,
      opener: deps.cliTerminalOpener,
      probe: deps.cliPathProbe,
    });
    return writeJson(res, result.status, result.body);
  }
  return writeJsonError(res, 405, `method ${method} not allowed on cli`);
}

// ── Status ────────────────────────────────────────────────────────────────────

async function handleStatus(
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'GET') return writeJsonError(res, 405, `method ${method} not allowed on status`);
  const status = deps.outboundApiServer.getStatus();
  const serverConfig = await loadServerConfig(deps.settingsStore);
  // Class-aware read-only projection: kind-mapped endpoints (`messages`/
  // `responses`) summarize their per-kind `modelMap` (they no longer carry a
  // single `defaultModel`); role-based endpoints (`chat`/`gemini`) project the
  // `defaultModel`. The editable surface still drives off GET /server. The
  // kind-mapped set is read from core's `isKindMappedEndpoint` (SSOT over
  // `ENDPOINT_MODEL_KINDS`) — no daemon-side hand-mirror.
  const endpoints = serverConfig.endpoints.map((e) => {
    if (isKindMappedEndpoint(e.endpoint)) {
      return { endpoint: e.endpoint, kinds: e.modelMap ?? {}, useSubscription: e.useSubscription };
    }
    if (e.endpoint === 'chat') {
      return { endpoint: e.endpoint, models: e.models ?? [], useSubscription: e.useSubscription };
    }
    return { endpoint: e.endpoint, model: e.defaultModel ?? '', useSubscription: e.useSubscription };
  });
  // Live queue-occupancy snapshot from the wire layer's frozen `getQueueStatus()`
  // — included only when the server is running (§4 allows omission otherwise), so
  // the field stays genuinely optional. Existing status fields are untouched.
  if (status.running) {
    const queueStatus = deps.outboundApiServer.getQueueStatus();
    return writeJson(res, 200, { ...status, endpoints, queueStatus });
  }
  return writeJson(res, 200, { ...status, endpoints });
}

// ── Playground (same-origin proxy to /v1/*) ───────────────────────────────────

/** Map an endpoint id + body to the outbound `/v1/*` path. */
function resolvePlaygroundPath(endpoint: string, body: Record<string, unknown>): string | null {
  switch (endpoint) {
    case 'chat':
      return '/v1/chat/completions';
    case 'responses':
      return '/v1/responses';
    case 'messages':
      return '/v1/messages';
    case 'gemini': {
      const model = typeof body['model'] === 'string' ? body['model'] : 'gemini-pro';
      return `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    }
    default:
      return null;
  }
}

async function handlePlayground(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'POST') return writeJsonError(res, 405, `method ${method} not allowed on playground`);
  const body = await readJsonBody(req);
  const endpoint = typeof body['endpoint'] === 'string' ? body['endpoint'] : '';
  const key = typeof body['key'] === 'string' ? body['key'] : '';
  const payload = body['body'];

  const status = deps.outboundApiServer.getStatus();
  if (!status.running || !status.port) return writeJsonError(res, 503, 'outbound server not running');
  const path = resolvePlaygroundPath(endpoint, isRecord(payload) ? payload : {});
  if (!path) return writeJsonError(res, 400, `unknown endpoint '${endpoint}'`);

  // Stringify the payload (accept a JSON object or a raw string).
  const upstreamBody = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});

  await proxyToOutbound(res, status.port, path, key, upstreamBody);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Server-side proxy to the outbound `/v1/*` server (same-origin from the
 * browser's view — design D5). Pipes the upstream status + headers + body back,
 * streaming so SSE passes through.
 */
function proxyToOutbound(
  res: http.ServerResponse,
  outboundPort: number,
  path: string,
  key: string,
  body: string,
): Promise<void> {
  return new Promise((resolve) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: outboundPort,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${key}`,
        },
      },
      (proxRes) => {
        const headers: http.OutgoingHttpHeaders = {};
        const ct = proxRes.headers['content-type'];
        if (ct) headers['Content-Type'] = ct;
        res.writeHead(proxRes.statusCode ?? 502, headers);
        proxRes.on('data', (chunk) => res.write(chunk));
        proxRes.on('end', () => {
          res.end();
          resolve();
        });
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) writeJsonError(res, 502, `playground proxy failed: ${err.message}`);
      else res.end();
      resolve();
    });
    upstream.write(body);
    upstream.end();
  });
}
