/**
 * Shared vocabulary for the API search slice (plan 阶段4).
 *
 * Config shapes, the transport seams, and the failure-stage vocabulary, in one
 * place so the four adapters, the shared transport, the contributions factory
 * and the doctor can agree on names without importing each other.
 *
 * The config shapes stay CORE-LOCAL rather than moving into
 * `@omnicross/contracts`: their only consumers are in this package until
 * 阶段5's daemon assembles real configuration, and promoting them then — with
 * whatever that assembly actually needs — beats freezing a guess now. Recorded
 * as an explicit deferral in the change's design.
 *
 * @module search/api/types
 */

import type { SearchProviderId } from '@omnicross/contracts/search-types';

/**
 * The transport identity stamped on every failure this slice throws.
 *
 * Same client as the HTTP slice, declared separately rather than imported: the
 * two subpaths are independent, and a shared constant would couple them for a
 * five-character string.
 */
export const SEARCH_API_TRANSPORT_ID = 'undici';

/**
 * Which phase of an API search failed (plan §11.4).
 *
 * - `config` — a required key or host is absent; nothing was sent.
 * - `egress` — the policy refused the target or a redirect hop.
 * - `connect` — the request never produced a response (DNS, TCP, TLS).
 * - `fetch` — a response arrived but its status is unusable.
 * - `redirect` — the redirect chain exceeded its cap.
 * - `body-cap` — the response body outgrew its byte cap mid-stream.
 * - `parse` — the body is not the JSON shape this API documents.
 */
export type SearchApiStage =
  | 'config'
  | 'egress'
  | 'connect'
  | 'fetch'
  | 'redirect'
  | 'body-cap'
  | 'parse';

/** Tavily: key required, host overridable. */
export interface TavilyProviderConfig {
  /** API key. Comma-separated values rotate round-robin. */
  apiKey: string;
  /** Override for `https://api.tavily.com`. */
  apiHost?: string;
}

/** Jina: key OPTIONAL — the search endpoint works unauthenticated (rate-limited). */
export interface JinaProviderConfig {
  /** API key. Comma-separated values rotate round-robin. Omit to run keyless. */
  apiKey?: string;
  /** Override for `https://s.jina.ai`. */
  apiHost?: string;
}

/** SearXNG: the HOST is the required setting; there is no API key. */
export interface SearxngProviderConfig {
  /** Base URL of the SearXNG instance. Required — this is its "configured" signal. */
  apiHost: string;
  /** Basic-auth user. Sent only when both user and password are present. */
  basicAuthUsername?: string;
  /** Basic-auth password. Sent only when both user and password are present. */
  basicAuthPassword?: string;
}

/** Zhipu and Z.AI: one wire contract, two ids, two default hosts. */
export interface ZhipuProviderConfig {
  /** API key. Comma-separated values rotate round-robin. */
  apiKey: string;
  /** Override for the per-id default host; normalized onto `/web_search`. */
  apiHost?: string;
}

/**
 * Per-provider configuration, keyed by provider id.
 *
 * A provider absent from this object is UNCONFIGURED, not broken: it produces
 * no contribution at all, so capability discovery never advertises something
 * that cannot run.
 */
export interface SearchApiProviderConfigs {
  tavily?: TavilyProviderConfig;
  jina?: JinaProviderConfig;
  searxng?: SearxngProviderConfig;
  zhipu?: ZhipuProviderConfig;
  'z.ai'?: ZhipuProviderConfig;
}

/**
 * One API request, as the shared transport takes it.
 *
 * `secrets` is the redaction input: every value listed is stripped out of any
 * upstream text before it can reach an error message or a diagnostic. Tavily
 * transmits its key in the request BODY, so an upstream 4xx that echoes the
 * request would otherwise put the key straight into a log.
 */
export interface SearchApiRequest {
  /** Absolute request URL. Validated against the egress policy before use. */
  url: string;
  /** HTTP method. */
  method: 'GET' | 'POST';
  /** Request headers. Never logged, never echoed into an error. */
  headers?: Record<string, string>;
  /** Body to serialize as JSON. Omit for GET. */
  jsonBody?: unknown;
  /** Stamped onto every thrown error. */
  providerId: SearchProviderId;
  /** Human-readable provider name for failure messages (never the query). */
  label: string;
  /** Hard budget for this request in milliseconds. */
  timeoutMs?: number;
  /** Caller cancellation. Aborting surfaces as `cancelled`, never `timeout`. */
  signal?: AbortSignal;
  /** Credential values to redact from any upstream text. */
  secrets?: ReadonlyArray<string | undefined>;
}

/**
 * The seam every adapter calls: a request in, parsed JSON out.
 *
 * Deliberately `unknown` rather than generic. The transport cannot know an
 * API's shape, and a generic here would be a promise it cannot keep — each
 * adapter validates its own response and raises `parse_failed` itself, which is
 * where that failure actually belongs.
 */
export type SearchApiTransport = (request: SearchApiRequest) => Promise<unknown>;

/**
 * The low-level fetch primitive the shared transport drives — undici's `fetch`
 * by default. Separate from {@link SearchApiTransport} so redirect, status and
 * redaction behavior can be unit-tested without a network.
 */
export type SearchApiFetch = (url: string, init: RequestInit) => Promise<Response>;
