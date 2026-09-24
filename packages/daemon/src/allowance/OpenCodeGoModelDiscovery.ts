/**
 * OpenCodeGoModelDiscovery — the opencodego subscription's LIVE model-list
 * discovery over the zen half's OpenAI-wire `GET /v1/models`.
 *
 * Unlike antigravity (static census + dynamic merge), opencodego has NO
 * hand-maintained preset catalog: `SUBSCRIPTION_MODEL_CATALOG.opencodego` is
 * empty by design and the per-account model picker fetches this route
 * (`GET /accounts/opencodego/models[?accountId=…]`). The probe carries the
 * opencode.ai egress identity (library user-agent — the announcement's
 * "identify your tool" rule) plus the account's static bearer key, and honors
 * that account's `zenBaseUrl` override (a go-half override never redirects
 * zen traffic).
 *
 * Secret-free on the wire: only model ids (and an error string) cross the
 * admin API — the key is used daemon-side only.
 *
 * @module @omnicross/daemon/allowance/OpenCodeGoModelDiscovery
 */

import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { getOpenCodeGoUserAgent } from '@omnicross/core/provider-proxy/identity/openCodeGoHeaders';
import { normalizeOpenCodeGoBaseUrl } from '@omnicross/subscriptions';

/** The default zen-half root the `/v1/models` probe appends to. */
const OPENCODEGO_DEFAULT_ZEN_ROOT = 'https://opencode.ai/zen';

/** The account-scoped credential the admin route resolves per request. */
export interface OpenCodeGoModelsAccount {
  /** The account's static API key (`null` when the account has none). */
  apiKey: string | null;
  /** The account's zen-half host override, if any. */
  zenBaseUrl?: string;
}

export type OpenCodeGoModelsFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The models URL for a zen-half root/override — exported for tests. */
export function openCodeGoModelsUrl(zenBaseUrl?: string): string {
  const root = zenBaseUrl
    ? normalizeOpenCodeGoBaseUrl(zenBaseUrl)
    : OPENCODEGO_DEFAULT_ZEN_ROOT;
  return `${root}/v1/models`;
}

/** Parse an OpenAI-wire `/models` payload into model ids. Pure; test-exported. */
export function parseOpenCodeGoModelsPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((entry) =>
      entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
        ? (entry as { id: string }).id.trim()
        : '',
    )
    .filter((id) => id.length > 0);
  return [...new Set(ids)];
}

/**
 * Probe the zen half's `/v1/models` with one account's key. Never throws —
 * failures surface as `{ models: [], error }` so the route can answer an
 * honest message instead of a 500.
 */
export async function fetchOpenCodeGoModels(
  account: OpenCodeGoModelsAccount,
  fetchImpl: OpenCodeGoModelsFetch = (url, init) =>
    fetchUpstream(url, init, { providerId: 'opencodego', redactBodies: true }),
): Promise<{ models: string[]; error?: string }> {
  if (!account.apiKey) return { models: [], error: 'account has no API key' };
  let response: Response;
  try {
    response = await fetchImpl(openCodeGoModelsUrl(account.zenBaseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        Accept: 'application/json',
        // opencodego-egress-identity: the library UA, never Node's bare `node`.
        'User-Agent': getOpenCodeGoUserAgent(),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { models: [], error: `model list fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { models: [], error: `model list fetch failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}` };
  }
  const payload: unknown = await response.json().catch(() => null);
  const models = parseOpenCodeGoModelsPayload(payload);
  if (models.length === 0) return { models: [], error: 'model list fetch failed: unexpected /models payload' };
  return { models };
}

/**
 * The admin route handler behind `GET /accounts/opencodego/models`: resolve the
 * requested (or ACTIVE) account's key + zen override, probe the live list, and
 * answer `{ models, discovered }`. Secret-free: only model ids + the error
 * string cross the wire.
 */
export async function handleOpenCodeGoModelsRoute(deps: {
  resolveAccount: (accountId?: string) => Promise<OpenCodeGoModelsAccount | null>;
  fetchImpl?: OpenCodeGoModelsFetch;
}, accountId?: string): Promise<{ status: number; body: unknown }> {
  const account = await deps
    .resolveAccount(accountId && accountId.length > 0 ? accountId : undefined)
    .catch(() => null);
  if (!account) {
    return { status: 200, body: { models: [], discovered: false, error: 'no opencodego account configured' } };
  }
  const { models, error } = await fetchOpenCodeGoModels(account, deps.fetchImpl);
  return { status: 200, body: { models, discovered: models.length > 0, ...(error ? { error } : {}) } };
}
