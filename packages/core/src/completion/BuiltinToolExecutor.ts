/**
 * BuiltinToolExecutor — Executes built-in tools (web_search, web_fetch)
 * for the non-agent chat pipeline.
 *
 * Built-in tools use `serverId: 'builtin'` in MCPTool metadata and are
 * dispatched here instead of going through McpService.callTool().
 */

import type { MCPCallToolResponse, MCPTool } from '@omnicross/contracts/mcp-types';
import { toSearchErrorShape } from '@omnicross/contracts/search-types';

import type { WebSearchBackend } from '../ports/web-search-backend';
import type { SearchRuntime } from '../search/runtime';
import type { AnthropicTool, OpenAITool } from '../tool-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SEARCH_COUNT = 5;
const DEFAULT_FETCH_MAX_CHARS = 20_000;

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
  /**
   * @param webSearch - the legacy port, still the `web_fetch` URL reader.
   * @param runtime - the search runtime `web_search` delegates to. Optional so
   *   the single-argument construction hosts already use keeps compiling; when
   *   omitted, a default runtime over the builtin HTTP providers is built on
   *   first use.
   */
  constructor(
    private webSearch: WebSearchBackend,
    private runtime?: SearchRuntime,
  ) {}

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

    // ONE call. Choosing a provider, ordering the candidates and falling back
    // are the runtime's job — a loop here would be a second fallback policy,
    // which is exactly what this tool used to carry and what plan 阶段3 removed.
    let response;
    try {
      response = await (await this.getRuntime()).search({
        query,
        options: { maxResults: count },
      });
    } catch (err) {
      const shape = toSearchErrorShape(err);
      return {
        isError: false,
        content: [{ type: 'text', text: `Search failed (${shape.code}): ${shape.message}` }],
      };
    }

    if (response.results.length === 0) {
      return {
        isError: false,
        content: [{ type: 'text', text:
          `No results found for "${query}" after trying ${response.attempts.length} provider(s). Try rephrasing your search.` }],
      };
    }

    const text = response.results
      .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content || ''}`)
      .join('\n\n');

    return { isError: false, content: [{ type: 'text', text }] };
  }

  /** Memoized lazy construction, so concurrent first calls share one runtime. */
  private runtimeInit?: Promise<SearchRuntime>;

  /**
   * The runtime `web_search` delegates to.
   *
   * Imported lazily so the search stack's transport and HTML parsing stay out
   * of the module graph of every consumer that only wants the tool definitions
   * — the same reason `builtin-web-fetch` is loaded on demand below.
   *
   * The PROMISE is memoized, not just its result: two concurrent first searches
   * would otherwise each build a runtime and the later one would win. Harmless
   * while the default runtime is stateless, but it stops being harmless the
   * moment one holds a connection pool or a cache.
   */
  private getRuntime(): Promise<SearchRuntime> {
    if (this.runtime !== undefined) return Promise.resolve(this.runtime);
    this.runtimeInit ??= import('../search/runtime.js').then(({ createSearchRuntime }) => {
      this.runtime = createSearchRuntime();
      return this.runtime;
    });
    return this.runtimeInit;
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
