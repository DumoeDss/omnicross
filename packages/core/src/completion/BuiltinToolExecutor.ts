/**
 * BuiltinToolExecutor — Executes built-in tools (web_search, web_fetch)
 * for the non-agent chat pipeline.
 *
 * Built-in tools use `serverId: 'builtin'` in MCPTool metadata and are
 * dispatched here instead of going through McpService.callTool().
 */

import type { MCPCallToolResponse, MCPTool } from '@omnicross/contracts/mcp-types';
import type { WebSearchProviderId } from '@omnicross/contracts/websearch-types';

import type { WebSearchBackend } from '../ports/web-search-backend';
import type { AnthropicTool, OpenAITool } from '../tool-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SEARCH_COUNT = 5;
const DEFAULT_FETCH_MAX_CHARS = 20_000;

/** Provider fallback order (same as WebSearchServiceTool) */
const FALLBACK_ORDER: WebSearchProviderId[] = [
  'tavily', 'jina', 'searxng', 'zhipu', 'z.ai', 'bocha', 'grok',
  'local-google', 'local-bing', 'local-baidu', 'local-duckduckgo',
];

const IMPLICIT_LOCAL_FALLBACK: WebSearchProviderId = 'local-google';

// ---------------------------------------------------------------------------
// Tool metadata (MCPTool format)
// ---------------------------------------------------------------------------

const WEB_SEARCH_TOOL: MCPTool = {
  id: 'builtin__web_search',
  serverId: 'builtin',
  serverName: 'builtin',
  name: 'web_search',
  description:
    'Search the web for current information. Returns a list of results with title, URL, and snippet. ' +
    'Use web_fetch afterwards to get full page content if snippets are insufficient.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      count: { type: 'integer', description: 'Maximum number of results (1-10).', default: DEFAULT_SEARCH_COUNT },
    },
    required: ['query'],
  },
  type: 'mcp',
  isBuiltIn: true,
};

const WEB_FETCH_TOOL: MCPTool = {
  id: 'builtin__web_fetch',
  serverId: 'builtin',
  serverName: 'builtin',
  name: 'web_fetch',
  description:
    'Fetch and extract the main content of a web page as clean Markdown. ' +
    'Use this to read the full content of a URL found via web_search.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (http or https).' },
      maxChars: { type: 'integer', description: 'Maximum characters to return.', default: DEFAULT_FETCH_MAX_CHARS },
    },
    required: ['url'],
  },
  type: 'mcp',
  isBuiltIn: true,
};

// ---------------------------------------------------------------------------
// BuiltinToolExecutor
// ---------------------------------------------------------------------------

export class BuiltinToolExecutor {
  constructor(private webSearch: WebSearchBackend) {}

  async execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<MCPCallToolResponse> {
    switch (toolName) {
      case 'web_search':
        return this.executeWebSearch(args);
      case 'web_fetch':
        return this.executeWebFetch(args);
      default:
        return { isError: true, content: [{ type: 'text', text: `Unknown built-in tool: ${toolName}` }] };
    }
  }

  // -----------------------------------------------------------------------
  // web_search
  // -----------------------------------------------------------------------

  private async executeWebSearch(
    args: Record<string, unknown>
  ): Promise<MCPCallToolResponse> {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return { isError: true, content: [{ type: 'text', text: 'Error: query parameter is required.' }] };
    }

    const count = Math.min(Math.max(Number(args.count ?? DEFAULT_SEARCH_COUNT), 1), 10);

    // Build provider chain (same logic as WebSearchServiceTool)
    const chain = this.resolveProviderChain();
    let lastError = '';

    for (const providerId of chain) {
      try {
        const result = await this.webSearch.search(query, providerId, { maxResults: count });

        if (!result.success) {
          lastError = result.error || 'Unknown error';
          console.log(`[BuiltinToolExecutor] Search provider ${providerId} failed: ${lastError}, trying next...`);
          continue;
        }

        const items = result.results.slice(0, count);
        if (items.length === 0) {
          console.log(`[BuiltinToolExecutor] Search provider ${providerId} returned 0 results, trying next...`);
          continue;
        }

        const text = items
          .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content || ''}`)
          .join('\n\n');

        return { isError: false, content: [{ type: 'text', text }] };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.log(`[BuiltinToolExecutor] Search provider ${providerId} threw: ${lastError}, trying next...`);
        continue;
      }
    }

    return {
      isError: false,
      content: [{ type: 'text', text: lastError
        ? `Search failed after trying ${chain.length} provider(s). Last error: ${lastError}`
        : `No results found for "${query}" after trying ${chain.length} provider(s). Try rephrasing your search.` }],
    };
  }

  private resolveProviderChain(): WebSearchProviderId[] {
    const chain: WebSearchProviderId[] = [];
    for (const id of FALLBACK_ORDER) {
      if (this.webSearch.isProviderEnabled(id)) {
        chain.push(id);
      }
    }
    if (!chain.includes(IMPLICIT_LOCAL_FALLBACK)) {
      chain.push(IMPLICIT_LOCAL_FALLBACK);
    }
    return chain;
  }

  // -----------------------------------------------------------------------
  // web_fetch
  // -----------------------------------------------------------------------

  private async executeWebFetch(
    args: Record<string, unknown>
  ): Promise<MCPCallToolResponse> {
    const url = String(args.url ?? '').trim();
    if (!url) {
      return { isError: true, content: [{ type: 'text', text: 'Error: url parameter is required.' }] };
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { isError: true, content: [{ type: 'text', text: 'Error: only http and https URLs are supported.' }] };
      }
    } catch {
      return { isError: true, content: [{ type: 'text', text: `Error: invalid URL "${url}".` }] };
    }

    const maxChars = Number(args.maxChars ?? DEFAULT_FETCH_MAX_CHARS);

    try {
      // Try JinaReader first (if available — it produces LLM-optimized output)
      const jinaResult = await this.webSearch.readUrl(url, { timeout: 15_000 });
      if (jinaResult.success && jinaResult.content) {
        const content = jinaResult.content.length > maxChars
          ? jinaResult.content.slice(0, maxChars) + '\n\n[Content truncated]'
          : jinaResult.content;
        const header = jinaResult.title ? `# ${jinaResult.title}\n\n` : '';
        return { isError: false, content: [{ type: 'text', text: header + content }] };
      }

      // Fallback: direct HTTP fetch + Readability + Turndown
      // Import lazily to avoid loading heavy deps when JinaReader suffices
      const { fetchAndExtractUrl } = await import('./builtin-web-fetch.js');
      const text = await fetchAndExtractUrl(url, maxChars);
      return { isError: false, content: [{ type: 'text', text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: `Fetch error: ${message}` }] };
    }
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Get the built-in MCPTool definitions for web search tools. */
export function getBuiltinSearchTools(): MCPTool[] {
  return [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];
}

/** Convert built-in tools to OpenAI function format. */
export function convertBuiltinToolsToOpenAI(tools: MCPTool[]): OpenAITool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.id,
      description: t.description || t.name,
      parameters: t.inputSchema,
    },
  }));
}

/** Convert built-in tools to Anthropic format. */
export function convertBuiltinToolsToAnthropic(tools: MCPTool[]): AnthropicTool[] {
  return tools.map(t => ({
    name: t.id,
    description: t.description || t.name,
    input_schema: t.inputSchema,
  }));
}
