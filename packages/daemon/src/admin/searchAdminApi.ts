/**
 * searchAdminApi — the admin API's search surface (search-settings-ui D3 +
 * search-settings-tab D4).
 *
 * Three routes over the daemon's search state, dispatched from `adminApi.ts`'s
 * `case 'search'`:
 *
 * - `GET /admin/api/search/diagnostics` — a READ-ONLY, secret-free, network-free
 *   snapshot: one row per provider the daemon can run (the ONE runtime's
 *   descriptors, plus `unconfigured` rows for known API providers the persisted
 *   config does not name — the doctor's classification), the effective frontend
 *   modes, and the explicit apply semantics (codex immediate, rest restart).
 * - `POST /admin/api/search/test { providerId }` — ONE live fixed-query check on
 *   a configured provider, classified by the doctor's pure functions. The
 *   machine-facing health probe: it sends exactly `SEARCH_DOCTOR_QUERY`, never a
 *   caller-supplied query, and never returns result content (plan §11.3 — its
 *   contract is the automated doctor's fixed-query discipline).
 * - `POST /admin/api/search/query { providerId, query }` — the INTERACTIVE
 *   channel for the settings page's per-provider test panel (owner feedback
 *   2026-09-02): ONE operator-typed query through ONE provider's contribution
 *   built from the PERSISTED config, returning the doctor-classified diagnostic
 *   PLUS the sanitized results. The two disciplines stay separate routes on
 *   purpose: bending `/test` to accept a query would erase the boundary its
 *   pinned tests and consumers depend on.
 *
 * SECRET SPINE (all three routes): no response ever carries a configured VALUE,
 * and a failure response carries only the doctor's SANITIZED error shape — raw
 * upstream error bodies (which may quote the stored key) never serialize. The
 * query endpoint additionally sanitizes every returned result field BEFORE
 * serialization (plan §11.1: search results are untrusted input), and the
 * operator's query is never logged anywhere.
 *
 * The diagnostics dep is OPTIONAL (`AdminApiDeps.searchStatus`): light embedders
 * that wire no search runtime get 501 for all routes (the voucher/allowance
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
import {
  resolveSearchUpstreamDispatcher,
  resolveSearchUpstreamProxyConfig,
  searchEgressPolicyFrom,
} from '../search/SearchAssembly';

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

/** One sanitized interactive-query result (plan §11.1: untrusted input). */
export interface SearchQueryResultItem {
  title: string;
  url: string;
  content: string;
}

/** `POST /admin/api/search/query` response body. */
export interface SearchQueryResponse {
  /** The doctor-classified diagnostic (status/reason/sanitized error shape). */
  diagnostic: SearchProviderDiagnostic;
  /** Sanitized result count on the success arm. */
  resultCount?: number;
  /** Sanitized results (≤5) on the success arm. Absent on the failure arm. */
  results?: SearchQueryResultItem[];
}

// ── Interactive-query bounds + sanitization (plan §11.1) ─────────────────────

/** An accepted interactive query: at most 256 UTF-16 code units. */
const SEARCH_QUERY_MAX_CODE_UNITS = 256;
/** Control characters (C0 + DEL) — never accepted in a query, never echoed. */
const QUERY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
/** Per-field code-unit caps for a serialized result field. */
const SEARCH_RESULT_FIELD_CAPS = { title: 512, url: 2048, content: 1024 } as const;
/** At most this many results cross the wire. */
const SEARCH_QUERY_MAX_RESULTS = 5;

/**
 * Sanitize one result field before serialization: coerce to string (a hostile
 * upstream may hand back anything), strip control characters, cap the length.
 */
function sanitizeResultField(value: unknown, cap: number): string {
  const text =
    typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  return text.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, cap);
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeErr(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'admin_api_error', message } });
}

/**
 * Body cap for the admin search POST routes — the in-repo idiom
 * (`routeLeaseApi.ts` MAX_BODY_BYTES): 64 KiB, counted while streaming, with a
 * structured 400 refusal on overflow. Both routes are new-in-0.2.1, so the cap
 * changes no legacy behavior.
 */
const SEARCH_MAX_BODY_BYTES = 64 * 1024;

/** Distinguishes the body-cap refusal from a transport failure in the handlers. */
class SearchBodyTooLargeError extends Error {}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > SEARCH_MAX_BODY_BYTES) throw new SearchBodyTooLargeError('request body is too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
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

/** Read the POST body with the cap surfaced as a structured 400. */
async function readBodyOrReject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await readJsonBody(req);
  } catch (error) {
    if (error instanceof SearchBodyTooLargeError) {
      writeErr(res, 400, error.message);
      return undefined;
    }
    throw error;
  }
}

/** `case 'search'` — diagnostics + test + query. 501 for all when the dep is absent. */
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
  if (rest.length === 1 && rest[0] === 'query') {
    if (!deps.searchStatus) {
      return writeErr(res, 501, 'Search status is not available in this build');
    }
    if (method !== 'POST') {
      return writeErr(res, 405, `method ${method} not allowed on search query`);
    }
    return handleSearchQuery(req, res, deps);
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
  const body = await readBodyOrReject(req, res);
  if (body === undefined) return;
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
  // A test double replaces the whole fetch; production probes go through the
  // same layered daemon proxy as the bootstrap runtime's searches.
  const transport = fetchImpl
    ? createSearchHttpTransport({ fetch: fetchImpl, egressPolicy })
    : createSearchHttpTransport({
        resolveProxyDispatcher: resolveSearchUpstreamDispatcher,
        resolveProxyConfig: resolveSearchUpstreamProxyConfig,
      });
  // Same construction the doctor probes with: the builtin http pair plus the
  // configured API providers. The ONLY provider exercised is the requested one.
  const contributions: SearchProviderContribution[] = [
    ...builtinHttpSearchContributions(transport),
    ...apiSearchContributions(search.providers, {
      egressPolicy,
      ...(fetchImpl
        ? { fetchImpl }
        : { resolveProxyDispatcher: resolveSearchUpstreamDispatcher }),
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

/**
 * `POST /admin/api/search/query { providerId, query }` — the INTERACTIVE
 * test-panel probe (search-settings-tab D4). Mirrors `handleSearchTest`'s
 * one-off probe construction exactly (persisted config → egress policy →
 * contributions → the ONE requested provider; no registry, no walk, no
 * ordering), but sends the OPERATOR's query and returns the sanitized results.
 *
 * §11.1 discipline: every result field is coerced/stripped/capped BEFORE
 * serialization (the UI renders untrusted text on top — two layers); the query
 * is never logged; a failure carries the classified diagnostic only.
 */
async function handleSearchQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: SearchAdminDeps,
): Promise<void> {
  const status = deps.searchStatus!;
  const body = await readBodyOrReject(req, res);
  if (body === undefined) return;
  const providerId = body['providerId'];
  if (typeof providerId !== 'string' || providerId.length === 0) {
    return writeErr(res, 400, 'providerId must be a non-empty string');
  }
  if (!KEYLESS_HTTP_PROVIDER_IDS.has(providerId) && !API_PROVIDER_IDS.has(providerId)) {
    return writeErr(res, 404, `unknown search provider '${providerId}'`);
  }
  const query = body['query'];
  if (typeof query !== 'string' || query.trim().length === 0) {
    return writeErr(res, 400, 'query must be a non-empty string');
  }
  if (query.length > SEARCH_QUERY_MAX_CODE_UNITS) {
    return writeErr(res, 400, `query must be at most ${SEARCH_QUERY_MAX_CODE_UNITS} characters`);
  }
  if (QUERY_CONTROL_CHARS.test(query)) {
    return writeErr(res, 400, 'query must not contain control characters');
  }

  // Probe from the CURRENT PERSISTED config (same as `/test`) so a just-saved
  // key is testable before restart — deliberately not the bootstrap runtime.
  const persisted = await loadServerConfig(deps.settingsStore);
  const search = persisted.search ?? DEFAULT_SEARCH_SERVER_CONFIG;
  const providers = search.providers as Record<string, unknown>;
  if (!KEYLESS_HTTP_PROVIDER_IDS.has(providerId) && providers[providerId] === undefined) {
    // Structured refusal, no fabricated probe, no upstream request.
    return writeErr(res, 400, `search provider '${providerId}' is not configured`);
  }

  const egressPolicy = searchEgressPolicyFrom(search);
  const fetchImpl = status.testFetch;
  // A test double replaces the whole fetch; production probes go through the
  // same layered daemon proxy as the bootstrap runtime's searches.
  const transport = fetchImpl
    ? createSearchHttpTransport({ fetch: fetchImpl, egressPolicy })
    : createSearchHttpTransport({
        resolveProxyDispatcher: resolveSearchUpstreamDispatcher,
        resolveProxyConfig: resolveSearchUpstreamProxyConfig,
      });
  const contributions: SearchProviderContribution[] = [
    ...builtinHttpSearchContributions(transport),
    ...apiSearchContributions(search.providers, {
      egressPolicy,
      ...(fetchImpl
        ? { fetchImpl }
        : { resolveProxyDispatcher: resolveSearchUpstreamDispatcher }),
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
    const results = await contribution.provider.search(query, { maxResults: 5 });
    const sanitized: SearchQueryResultItem[] = results
      .slice(0, SEARCH_QUERY_MAX_RESULTS)
      .map((result) => ({
        title: sanitizeResultField(result.title, SEARCH_RESULT_FIELD_CAPS.title),
        url: sanitizeResultField(result.url, SEARCH_RESULT_FIELD_CAPS.url),
        content: sanitizeResultField(result.content, SEARCH_RESULT_FIELD_CAPS.content),
      }));
    // An empty result list is a SUCCESS here (the orchestrator's empty-[]-is-
    // success rule): the operator's query may legitimately match nothing, so
    // the fixed-query doctor's zero-results-implies-drift `degraded` does NOT
    // apply to the interactive channel — the panel renders an honest empty
    // state, never an error.
    const diagnostic: SearchProviderDiagnostic =
      sanitized.length === 0
        ? { providerId: contribution.id, status: 'healthy', checkedAt }
        : classifyLiveSearchOutcome(
            contribution.id,
            { kind: 'results', count: sanitized.length },
            checkedAt,
          );
    const response: SearchQueryResponse = {
      diagnostic,
      resultCount: sanitized.length,
      results: sanitized,
    };
    return writeJson(res, 200, { result: response });
  } catch (error) {
    // Same honest classification as `/test`: challenge/trust/egress denials
    // are `blocked` observations; the error shape is the doctor's SANITIZED
    // one, so an upstream body quoting the stored key never serializes.
    const diagnostic = classifyLiveSearchOutcome(contribution.id, { kind: 'failure', error }, checkedAt);
    const response: SearchQueryResponse = { diagnostic };
    return writeJson(res, 200, { result: response });
  }
}
