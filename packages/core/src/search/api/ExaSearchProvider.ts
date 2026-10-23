import type { SearchOptions, SearchProvider, SearchResult } from '@omnicross/contracts/search-types';

import { excludedDomainsFromQuery, isExcludedSearchUrl } from '../domainFilters';
import {
  invalidSearchPayload,
  keylessCapabilities,
  publicSearchMode,
  recencyDate,
  recordOf,
  requireSearchKey,
  resultLimit,
  searchApiEndpoint,
  sourceResult,
  stringList,
} from './keylessSupport';
import { callSearchMcp, mcpPayloads, mcpTextBlocks } from './mcp';
import { ApiKeyRotator } from './rotator';
import { defaultSearchApiTransport, payloadText, requireResultArray } from './transport';
import type { ExaProviderConfig, SearchApiTransport } from './types';

export const EXA_CAPABILITIES = keylessCapabilities(10);
const PUBLIC_URL = 'https://mcp.exa.ai/mcp?tools=web_search_exa';
const LABEL = 'Exa';

export class ExaSearchProvider implements SearchProvider {
  readonly id = 'exa';
  private readonly rotator = new ApiKeyRotator();

  constructor(
    private readonly config: ExaProviderConfig,
    private readonly transport: SearchApiTransport = defaultSearchApiTransport,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = resultLimit(options.maxResults, 10);
    const after = recencyDate(options.timeRange);
    let items: unknown[];
    if (publicSearchMode(this.config)) {
      const result = await callSearchMcp(this.transport, {
        url: PUBLIC_URL,
        providerId: this.id,
        label: LABEL,
        timeoutMs: options.timeout,
        signal: options.signal,
      }, 'web_search_exa', { query: after ? `${query} after:${after}` : query, numResults: limit });
      const structured = mcpPayloads(result).map(recordOf).find((value) => Array.isArray(value?.results));
      items = structured
        ? requireResultArray(structured, 'results', this.id, LABEL)
        : parseExaText(mcpTextBlocks(result).join('\n\n'));
      if (!structured && items.length === 0) throw invalidSearchPayload(this.id, LABEL);
    } else {
      const key = requireSearchKey(this.rotator.pick(this.config.apiKey), this.id, LABEL);
      const payload = await this.transport({
        url: searchApiEndpoint(this.config.apiHost, 'https://api.exa.ai', '/search'),
        method: 'POST',
        headers: { 'x-api-key': key },
        jsonBody: {
          query,
          numResults: limit,
          type: 'auto',
          contents: { highlights: true },
          ...(after ? { startPublishedDate: `${after}T00:00:00.000Z` } : {}),
        },
        providerId: this.id,
        label: LABEL,
        timeoutMs: options.timeout,
        signal: options.signal,
        secrets: this.rotator.allKeys(this.config.apiKey),
      });
      items = requireResultArray(payload, 'results', this.id, LABEL);
    }
    const results = items.flatMap((value) => {
      const item = recordOf(value);
      if (!item) return [];
      const source = sourceResult(item.title, item.url,
        stringList(item.highlights) || payloadText(item.summary) || payloadText(item.text));
      return source ? [source] : [];
    });
    if (items.length && !results.length) throw invalidSearchPayload(this.id, LABEL);
    const excluded = excludedDomainsFromQuery(query);
    return results.filter((result) => !isExcludedSearchUrl(result.url, excluded)).slice(0, limit);
  }
}

/** Hosted MCP also emits labeled source records, rather than JSON content. */
function parseExaText(text: string): unknown[] {
  const sections = text.replace(/\r\n?/g, '\n').split(/(?:^|\n)(?=Title:)/);
  const records: Record<string, unknown>[] = [];
  for (const section of sections) {
    if (!section.startsWith('Title:')) continue;
    const title = /^Title:[ \t]*([^\n]*)/.exec(section)?.[1];
    const url = /(?:^|\n)URL:[ \t]*([^\n]*)/.exec(section)?.[1];
    const content = /(?:^|\n)(?:Highlights|Text):[ \t]*([\s\S]*)/.exec(section)?.[1];
    records.push({ title, url, text: content });
  }
  return records;
}
