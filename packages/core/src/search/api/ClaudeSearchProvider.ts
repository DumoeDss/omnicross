import {
  SearchProviderError,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderCapabilities,
  type SearchResult,
} from '@omnicross/contracts/search-types';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../domainFilters';
import { keyedEndpoint } from './keyedHelpers';
import { ApiKeyRotator } from './rotator';
import {
  apiConfigMissing,
  DEFAULT_API_TIMEOUT_MS,
  defaultSearchApiTransport,
  payloadText,
  requireResultArray,
  sanitizeUpstreamText,
} from './transport';
import { SEARCH_API_TRANSPORT_ID, type KeyedSearchProviderConfig, type SearchApiTransport } from './types';

export const CLAUDE_PROVIDER_ID = 'claude';
export const CLAUDE_DEFAULT_HOST = 'https://api.anthropic.com';
// Explicitly supported in the current official web-search examples; overridable.
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';
export const CLAUDE_WEB_SEARCH_TOOL = 'web_search_20250305';
export const CLAUDE_CAPABILITIES: Readonly<SearchProviderCapabilities> = Object.freeze({
  requiresApiKey: true,
  supportsRegion: false,
  supportsLanguage: false,
  supportsTimeRange: false,
  supportsUrlRead: false,
  supportsCancellation: true,
});

/** Anthropic Messages native web search, API keys only (no subscription/OAuth).
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 * Raw tool results expose encrypted content, not plaintext snippets. Only
 * citation.cited_text supplies snippets; the generated answer is never a result.
 */
export class ClaudeSearchProvider implements SearchProvider {
  readonly id = CLAUDE_PROVIDER_ID;
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: KeyedSearchProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const apiKey = this.rotator.pick(this.config.apiKey);
    if (!apiKey) throw apiConfigMissing(this.id, 'Claude search requires an Anthropic API key');
    const url = keyedEndpoint(this.config.apiHost, `${CLAUDE_DEFAULT_HOST}/v1/messages`, this.id);
    const maxResults = Number.isFinite(options.maxResults) && (options.maxResults ?? 0) > 0
      ? Math.max(1, Math.floor(options.maxResults ?? 5))
      : 5;
    const secrets = this.rotator.allKeys(this.config.apiKey);
    const excluded = excludedDomainsFromQuery(query);
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'user', content: `Search the web for the following query. Cite the sources you find.\n\n${query}` },
    ];
    const deadline = Date.now() + (options.timeout ?? DEFAULT_API_TIMEOUT_MS);

    // A pause is a protocol continuation, not a fresh search/retry. Preserve all
    // encrypted tool blocks unchanged and keep one deadline across the turn.
    for (let turn = 0; turn < 3; turn += 1) {
      if (options.signal?.aborted) {
        throw failure('cancelled', 'Claude search was cancelled by the caller', 'fetch');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw failure('timeout', 'Claude search exceeded its request budget', 'fetch', true);
      }
      const payload = await this.transport({
        url,
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        jsonBody: {
          model: this.config.model?.trim() || CLAUDE_DEFAULT_MODEL,
          max_tokens: 4096,
          system: 'Use web_search to retrieve actual web sources. Do not answer from memory. Keep the response concise and cite the sources.',
          messages,
          tools: [{ type: CLAUDE_WEB_SEARCH_TOOL, name: 'web_search', max_uses: 3 }],
        },
        providerId: this.id,
        label: 'Claude',
        timeoutMs: remaining,
        signal: options.signal,
        secrets,
      });
      const record = asRecord(payload);
      if (record.error != null || record.type === 'error') {
        throwPayloadError(asRecord(record.error), secrets);
      }
      const blocks = requireResultArray(payload, 'content', this.id, 'Claude');
      const results = extractSources(blocks, secrets);
      if (results.length > 0) {
        return results
          .filter((result) => !isExcludedSearchUrl(result.url, excluded))
          .slice(0, maxResults);
      }
      if (record.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: blocks });
        continue;
      }
      // An explicit successful empty tool result is a real zero-result search.
      if (blocks.some((value) => {
        const block = asRecord(value);
        return block.type === 'web_search_tool_result' &&
          Array.isArray(block.content) && block.content.length === 0;
      })) return [];
      throw failure('parse_failed', 'Claude returned no usable web-search sources or citations', 'parse');
    }
    throw failure('upstream_unavailable', 'Claude web search remained paused after three turns', 'fetch', true);
  }
}

function extractSources(blocks: unknown[], secrets: readonly string[]): SearchResult[] {
  const results: SearchResult[] = [];
  const byUrl = new Map<string, SearchResult>();
  let sourceCount = 0;
  for (const value of blocks) {
    const block = asRecord(value);
    let sources: unknown[];
    let citation = false;
    if (block.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) throwPayloadError(asRecord(block.content), secrets);
      sources = block.content as unknown[];
    } else if (block.type === 'text' && Array.isArray(block.citations)) {
      sources = block.citations;
      citation = true;
    } else continue;

    for (const item of sources) {
      const source = asRecord(item);
      if (source.type === 'web_search_tool_result_error') throwPayloadError(source, secrets);
      if (source.type !== (citation ? 'web_search_result_location' : 'web_search_result')) continue;
      sourceCount += 1;
      const url = sourceUrl(source.url);
      if (!url) continue;
      const existing = byUrl.get(url);
      const title = payloadText(source.title).trim();
      const content = citation ? payloadText(source.cited_text) : '';
      if (existing) {
        if (content && !existing.content) existing.content = content;
        continue;
      }
      if (!title || /^n\/?a$/i.test(title)) continue;
      const result = { title, url, content };
      byUrl.set(url, result);
      results.push(result);
    }
  }
  if (sourceCount > 0 && results.length === 0) {
    throw failure('parse_failed', 'Claude returned unusable web-search sources', 'parse');
  }
  return results;
}

function throwPayloadError(error: Record<string, unknown>, secrets: readonly string[]): never {
  const type = payloadText(error.error_code) || payloadText(error.type);
  const code = type === 'authentication_error' || type === 'permission_error'
    ? 'auth_failed'
    : type === 'too_many_requests' || type === 'rate_limit_error'
      ? 'rate_limited'
      : 'upstream_unavailable';
  const message = sanitizeUpstreamText(
    payloadText(error.message) || type || 'Malformed web-search tool result',
    secrets,
  );
  throw failure(code, `Claude: ${message}`, 'fetch',
    code === 'rate_limited' || type === 'unavailable' || type === 'overloaded_error' || type === 'api_error');
}

function failure(
  code: SearchProviderError['code'],
  message: string,
  stage: 'fetch' | 'parse',
  retryable = false,
): SearchProviderError {
  return new SearchProviderError(code, message, {
    providerId: CLAUDE_PROVIDER_ID,
    retryable,
    details: { transport: SEARCH_API_TRANSPORT_ID, stage },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sourceUrl(value: unknown): string {
  try {
    const url = new URL(payloadText(value));
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
