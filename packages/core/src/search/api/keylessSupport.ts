import {
  SearchProviderError,
  type SearchProviderCapabilities,
  type SearchProviderId,
  type SearchResult,
  type SearchTimeRange,
} from '@omnicross/contracts/search-types';

import { apiConfigMissing, payloadText } from './transport';
import type { KeylessSearchProviderConfig } from './types';

export function publicSearchMode(config: KeylessSearchProviderConfig): boolean {
  return (config.authMode ?? (config.apiKey?.trim() ? 'api' : 'public')) === 'public';
}

export function keylessCapabilities(maxResults: number): Readonly<SearchProviderCapabilities> {
  return Object.freeze({
    requiresApiKey: false,
    supportsRegion: false,
    supportsLanguage: false,
    supportsTimeRange: true,
    supportsUrlRead: false,
    supportsCancellation: true,
    maxResults,
  });
}

export function requireSearchKey(key: string, id: SearchProviderId, label: string): string {
  if (!key) throw apiConfigMissing(id, `${label} API mode requires an API key`);
  return key;
}

export function searchApiEndpoint(host: string | undefined, fallback: string, path: string): string {
  const base = (host?.trim() || fallback).replace(/\/+$/, '');
  if (base.endsWith(path)) return base;
  const version = /^\/v\d+/.exec(path)?.[0];
  return version && base.endsWith(version) ? `${base}${path.slice(version.length)}` : `${base}${path}`;
}

export function resultLimit(value: number | undefined, maximum: number): number {
  return value && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : 5;
}

export function recencyDate(range: SearchTimeRange | undefined): string | undefined {
  if (!range) return undefined;
  const days = { day: 1, week: 7, month: 30, year: 365 }[range];
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function sourceResult(title: unknown, url: unknown, content: unknown): SearchResult | undefined {
  const address = payloadText(url).trim();
  try {
    const parsed = new URL(address);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
  } catch {
    return;
  }
  const name = payloadText(title).trim();
  return {
    title: !name || /^(?:n\/?a|null|undefined)$/i.test(name) ? address : name,
    url: address,
    content: payloadText(content).trim(),
  };
}

export function stringList(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('\n') : '';
}

export function invalidSearchPayload(id: SearchProviderId, label: string): SearchProviderError {
  return new SearchProviderError('parse_failed', `${label} returned an unexpected search response`, {
    providerId: id,
    retryable: false,
    details: { transport: 'undici', stage: 'parse' },
  });
}
