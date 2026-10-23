import {
  SearchProviderError,
  type SearchProviderId,
  type SearchResult,
} from '@omnicross/contracts/search-types';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../domainFilters';
import type { ApiKeyRotator } from './rotator';
import { apiConfigMissing } from './transport';
import { SEARCH_API_TRANSPORT_ID } from './types';

export function keyedCredentials(
  rawKey: string,
  rotator: ApiKeyRotator,
  providerId: SearchProviderId,
  label: string,
): { apiKey: string; secrets: string[] } {
  const apiKey = rotator.pick(rawKey);
  if (!apiKey) throw apiConfigMissing(providerId, `${label} API key is required`);
  return { apiKey, secrets: rotator.allKeys(rawKey) };
}

/** Accept a base host, a versioned base, or the complete search endpoint. */
export function keyedEndpoint(
  host: string | undefined,
  defaultUrl: string,
  providerId: SearchProviderId,
): string {
  if (!host?.trim()) return defaultUrl;
  try {
    const url = new URL(host.trim());
    const base = url.pathname.split('/').filter(Boolean);
    const endpoint = new URL(defaultUrl).pathname.split('/').filter(Boolean);
    let overlap = Math.min(base.length, endpoint.length);
    while (overlap > 0 && base.slice(-overlap).join('/') !== endpoint.slice(0, overlap).join('/')) {
      overlap -= 1;
    }
    // A full endpoint must not have its path appended a second time.
    if (endpoint.length && base.slice(-endpoint.length).join('/') === endpoint.join('/')) {
      overlap = endpoint.length;
    }
    url.pathname = `/${[...base, ...endpoint.slice(overlap)].join('/')}`;
    return url.toString();
  } catch {
    throw apiConfigMissing(providerId, 'Search API host must be an absolute URL');
  }
}

export function boundedResults(value: number | undefined, fallback: number, cap: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(1, Math.min(cap, Math.floor(value)));
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function keyedParseError(providerId: SearchProviderId, label: string): SearchProviderError {
  return new SearchProviderError('parse_failed', `${label} returned an invalid search response`, {
    providerId,
    retryable: false,
    details: { transport: SEARCH_API_TRANSPORT_ID, stage: 'parse' },
  });
}

/** Body-level failures must not masquerade as successful empty searches. No upstream text is echoed. */
export function keyedEnvelopeError(
  providerId: SearchProviderId,
  label: string,
  status: unknown,
): SearchProviderError {
  const code = Number(status);
  return new SearchProviderError(
    code === 401 || code === 403 ? 'auth_failed' : code === 429 ? 'rate_limited' : 'upstream_unavailable',
    `${label} rejected the search request`,
    {
      providerId,
      retryable: code === 429 || code >= 500,
      details: { transport: SEARCH_API_TRANSPORT_ID, stage: 'fetch' },
    },
  );
}

export function searchText(value: unknown, cap = 8_000): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:n\/?a|null|undefined)$/i.test(text) ? '' : text.slice(0, cap);
}

export interface SourceFields {
  url: unknown;
  title: unknown;
  content: unknown;
}

/** Only real, direct HTTP sources survive; excluded sites stay excluded even if upstream ignores them. */
export function normalizeKeyedSources(
  items: readonly unknown[],
  fields: (record: Record<string, unknown>) => SourceFields,
  query: string,
  limit: number,
  providerId: SearchProviderId,
  label: string,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const excluded = excludedDomainsFromQuery(query);
  let validSources = 0;
  for (const item of items) {
    const record = objectRecord(item);
    if (!record) continue;
    const source = fields(record);
    if (typeof source.url !== 'string' || source.url.length > 2_048) continue;
    let url: URL;
    try { url = new URL(source.url.trim()); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    validSources += 1;
    if (isExcludedSearchUrl(url, excluded)) continue;
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ title: searchText(source.title, 300) || href, url: href, content: searchText(source.content) });
    if (results.length >= limit) break;
  }
  if (items.length > 0 && validSources === 0) throw keyedParseError(providerId, label);
  return results;
}

