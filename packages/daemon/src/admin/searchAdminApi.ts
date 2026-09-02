/**
 * searchAdminApi — the admin API's search surface (search-settings-ui, design D3).
 *
 * Two routes over the daemon's search state, dispatched from `adminApi.ts`'s
 * `case 'search'`:
 *
 * - `GET /admin/api/search/diagnostics` — a READ-ONLY, secret-free, network-free
 *   snapshot: one row per provider the daemon can run (the ONE runtime's
 *   descriptors, plus `unconfigured` rows for known API providers the persisted
 *   config does not name — the doctor's classification), the effective frontend
 *   modes, and the explicit apply semantics (codex immediate, rest restart).
 * - `POST /admin/api/search/test { providerId }` — ONE live fixed-query check on
 *   a configured provider, classified by the doctor's pure functions.
 *
 * SECRET SPINE: neither response ever carries a configured VALUE, a user query,
 * or result content (titles/URLs/snippets). The test endpoint sends exactly
 * `SEARCH_DOCTOR_QUERY` — never a caller-supplied query (plan §11.3: the admin
 * surface is not a query channel).
 *
 * The diagnostics dep is OPTIONAL (`AdminApiDeps.searchStatus`): light embedders
 * that wire no search runtime get 501 for both routes (the voucher/allowance
 * optionality precedent) rather than a fabricated snapshot.
 *
 * @module @omnicross/daemon/admin/searchAdminApi
 */

import http from 'node:http';

import { DEFAULT_SEARCH_SERVER_CONFIG, loadServerConfig } from '@omnicross/core/outbound-api';
import { apiSearchContributions } from '@omnicross/core/search/api';
import { builtinHttpSearchContributions, createSearchHttpTransport } from '@omnicross/core/search/http';
import type { SearchFrontendModes, SearchRuntime } from '@omnicross/core/search';
import type {
  SearchProviderContribution,
  SearchProviderDiagnostic,
  SearchProviderId,
} from '@omnicross/contracts/search-types';

import type { JsonApiServerSettingsStore } from '../ports/JsonApiServerSettingsStore';
import {
  buildSearchDoctorSnapshot,
  classifyLiveSearchOutcome,
  SEARCH_DOCTOR_QUERY,
  type SearchDoctorRow,
} from '../search/searchDoctorProjection';
import { searchEgressPolicyFrom } from '../search/SearchAssembly';

/** The two provider ids that need no configuration entry to be testable. */
const KEYLESS_HTTP_PROVIDER_IDS: ReadonlySet<string> = new Set(['http-bing', 'http-duckduckgo']);
/** Every API provider id the persisted config may name. */
const API_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'tavily', 'jina', 'searxng', 'zhipu', 'z.ai',
]);

/**
 * The daemon search state the admin surface needs. Structurally satisfied by
 * what `bootstrap.ts` already holds (the ONE runtime + its captured modes);
 * `testFetch` is a TEST SEAM so route tests can intercept the one live probe
 * without any network.
 */
export interface SearchAdminRuntimeStatus {
  /** The daemon's ONE assembled search runtime (provider descriptors). */
  readonly runtime: SearchRuntime;
  /** Modes as captured at bootstrap (responses/anthropic are these, live). */
  readonly modes: SearchFrontendModes;
  /** TEST SEAM: fetch primitive for the live-test probe. Absent ⇒ real transport. */
  readonly testFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** The subset of admin deps the search surface needs. */
export interface SearchAdminDeps {
  /** Runtime + modes; absent ⇒ 501 (the feature is not wired in this build). */
  readonly searchStatus?: SearchAdminRuntimeStatus;
  /** Outbound server settings store — the PERSISTED config is the test source. */
  readonly settingsStore: JsonApiServerSettingsStore;
}

/** `GET /admin/api/search/diagnostics` response body. */
export interface SearchDiagnosticsSnapshot {
  rows: SearchDoctorRow[];
  /** Effective modes: codex from the live config (applies immediately),
   * responses/anthropic as captured at bootstrap. */
  modes: SearchFrontendModes;
  /** Which edits apply when. Honest by construction, not by inference. */
  applySemantics: { codex: 'immediate'; rest: 'restart' };
}

/** `POST /admin/api/search/test` response body. */
export interface SearchTestResponse {
  /** The doctor-classified diagnostic (status/reason/sanitized error shape). */
  diagnostic: SearchProviderDiagnostic;
  /** Result count on a `healthy`/`degraded` outcome — never the results. */
  resultCount?: number;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeErr(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'admin_api_error', message } });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `case 'search'` — diagnostics + test. 501 for both when the dep is absent. */
export async function handleSearchAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: SearchAdminDeps,
): Promise<void> {
  if (rest.length === 1 && rest[0] === 'diagnostics') {
    // The voucher/allowance optionality precedent: no wired runtime ⇒ an
    // honest 501, never a fabricated snapshot.
    if (!deps.searchStatus) {
      return writeErr(res, 501, 'Search status is not available in this build');
    }
    if (method !== 'GET') {
      return writeErr(res, 405, `method ${method} not allowed on search diagnostics`);
    }
    return handleSearchDiagnostics(res, deps);
  }
  if (rest.length === 1 && rest[0] === 'test') {
    if (!deps.searchStatus) {
      return writeErr(res, 501, 'Search status is not available in this build');
    }
    if (method !== 'POST') {
      return writeErr(res, 405, `method ${method} not allowed on search test`);
    }
    return handleSearchTest(req, res, deps);
  }
  return writeErr(res, 404, `unknown search route '/${rest.join('/')}'`);
}

/** `GET /admin/api/search/diagnostics` — read-only, secret-free, no network. */
async function handleSearchDiagnostics(
  res: http.ServerResponse,
  deps: SearchAdminDeps,
): Promise<void> {
  const status = deps.searchStatus!;
  // PERSISTED config only — the admin surface never reads the doctor's env
  // convenience (it is pinned to the CLI command path). `loadServerConfig`
  // normalizes `search` in, so the fallback is inert — typed optional, always
  // present after a load.
  const persisted = await loadServerConfig(deps.settingsStore);
  const search = persisted.search ?? DEFAULT_SEARCH_SERVER_CONFIG;

  // The rows describe the RUNNING runtime (descriptors) plus `unconfigured`
  // rows for API providers the persisted config does not name. A provider
  // configured after boot is absent from both sets until restart — the UI's
  // pending-restart comparison (design D4) covers exactly that case.
  const rows = buildSearchDoctorSnapshot(
    status.runtime.listProviders(),
    search.providers,
  );

  const snapshot: SearchDiagnosticsSnapshot = {
    rows,
    modes: {
      // codex is read from the LIVE config per request — an admin PUT has
      // already applied. responses/anthropic were captured at bootstrap.
      codex: search.modes.codex,
      responses: status.modes.responses,
      anthropic: status.modes.anthropic,
    },
    applySemantics: { codex: 'immediate', rest: 'restart' },
  };
  return writeJson(res, 200, { diagnostics: snapshot });
}

/** `POST /admin/api/search/test { providerId }` — one fixed-query live check. */
async function handleSearchTest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: SearchAdminDeps,
): Promise<void> {
  const status = deps.searchStatus!;
  const body = await readJsonBody(req);
  const providerId = body['providerId'];
  if (typeof providerId !== 'string' || providerId.length === 0) {
    return writeErr(res, 400, 'providerId must be a non-empty string');
  }
  if (!KEYLESS_HTTP_PROVIDER_IDS.has(providerId) && !API_PROVIDER_IDS.has(providerId)) {
    return writeErr(res, 404, `unknown search provider '${providerId}'`);
  }

  // Probe from the CURRENT PERSISTED config — NOT the bootstrap runtime — so an
  // operator can test a just-saved key before restarting (design D3). This is
  // the doctor's own one-off probe-construction pattern, not a second runtime:
  // no registry, no orchestration, no fallback walk, no ordering.
  const persisted = await loadServerConfig(deps.settingsStore);
  const search = persisted.search ?? DEFAULT_SEARCH_SERVER_CONFIG;
  const providers = search.providers as Record<string, unknown>;
  if (!KEYLESS_HTTP_PROVIDER_IDS.has(providerId) && providers[providerId] === undefined) {
    // Structured refusal, no fabricated `config_missing` probe, no upstream
    // request performed.
    return writeErr(res, 400, `search provider '${providerId}' is not configured`);
  }

  const egressPolicy = searchEgressPolicyFrom(search);
  const fetchImpl = status.testFetch;
  const transport = fetchImpl ? createSearchHttpTransport({ fetch: fetchImpl, egressPolicy }) : undefined;
  // Same construction the doctor probes with: the builtin http pair plus the
  // configured API providers. The ONLY provider exercised is the requested one.
  const contributions: SearchProviderContribution[] = [
    ...builtinHttpSearchContributions(transport),
    ...apiSearchContributions(search.providers, {
      egressPolicy,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  ];
  const contribution = contributions.find((c) => c.id === (providerId as SearchProviderId));
  if (!contribution) {
    // Unreachable for validated ids, but a refusal beats a fabrication if the
    // shape ever drifts.
    return writeErr(res, 400, `search provider '${providerId}' is not configured`);
  }

  const checkedAt = new Date().toISOString();
  try {
    const results = await contribution.provider.search(SEARCH_DOCTOR_QUERY, { maxResults: 5 });
    const diagnostic = classifyLiveSearchOutcome(
      contribution.id,
      { kind: 'results', count: results.length },
      checkedAt,
    );
    const response: SearchTestResponse = { diagnostic, resultCount: results.length };
    return writeJson(res, 200, { result: response });
  } catch (error) {
    // The classification is honest about hostile networks: challenge/trust/
    // egress denials are `blocked` observations, not daemon failures.
    const diagnostic = classifyLiveSearchOutcome(contribution.id, { kind: 'failure', error }, checkedAt);
    const response: SearchTestResponse = { diagnostic };
    return writeJson(res, 200, { result: response });
  }
}
