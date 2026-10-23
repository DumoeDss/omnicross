# Search providers

Omnicross exposes search through `@omnicross/core/search`, the daemon's managed search frontends, and **Control Panel → Search**. Search configuration lives under `server.search` in the daemon config.

## Provider catalog

| Provider ID | Authentication / transport | Notes |
| --- | --- | --- |
| `exa` | Public MCP or API key | Public endpoint: `https://mcp.exa.ai/mcp`; keyed mode uses the Search API. |
| `parallel` | Public MCP or API key | Public endpoint: `https://search.parallel.ai/mcp`; keyed mode uses the current `/v1/search` API. |
| `firecrawl` | Keyless REST or API key | Both modes use `/v2/search`; the public mode sends no Authorization header. |
| `brave` | API key | Brave Search API; supports region, language and recency hints. |
| `kagi` | API key | Kagi Search API, not a browser session. |
| `kimi` | Kimi Code / search API key | The coding search endpoint requires the appropriate credential; an ordinary Moonshot chat key is not interchangeable. |
| `synthetic` | API key | Synthetic search API. |
| `ollama` | Ollama Cloud API key | Cloud web search, not a local/offline Ollama index. |
| `tinyfish` | API key | TinyFish search API with bounded pagination. |
| `perplexity` | API key | Official Search API; no Sonar/model parameter, imported cookies or internal consumer website API. |
| `bocha` | API key | Bocha Web Search API. |
| `claude` | Anthropic API key | Anthropic Messages native web search. Optional `model` override; default `claude-opus-5-5`. Uses real search sources/citations, not an ungrounded model answer. |
| `tavily`, `jina`, `zhipu`, `z.ai` | Existing API configuration | Keep using the provider's own account, limits and billing. Jina Search and Jina Reader are different endpoints; do not assume Reader's anonymous allowance applies to search. |
| `deepseek` | Search key or existing official DeepSeek provider key | Existing request-time key reuse remains available. |
| `searxng` | Instance URL; optional Basic authentication | Self-hosted instance access and costs are operator-owned. |
| `http-bing`, `http-duckduckgo` | Keyless HTML | The original zero-configuration HTTP engines. |
| `http-startpage`, `http-ecosia`, `http-mojeek` | Keyless HTML | Explicit opt-in. Fail closed on challenge/empty-shell pages; no browser or CAPTCHA solving. |
| `public` | Aggregate of enabled HTTP engines | Explicit opt-in. Only configured, policy-allowed children receive the query. |

Google's browser-only behavior is not represented as a working server-side HTML engine. Browser-backed `local-*` providers remain embedding-host contributions. Model-native search for OpenAI, Gemini, Codex, xAI and OpenRouter remains a model/frontend concern rather than a duplicate account-import mechanism in this catalog.

## Public versus API mode

Exa, Parallel and Firecrawl accept `authMode: "public" | "api"`:

- **Public:** no API key is required or sent. Stored keys and custom API hosts are ignored; the provider uses its official public endpoint.
- **API:** an explicit key is required. Missing or rejected credentials never trigger a silent downgrade to public mode. A custom API host still goes through the shared egress checks.
- An omitted mode preserves an older explicit key as API mode; without a key it selects public mode. New configuration should always write an explicit mode.
- Removing a provider entry disables it. Merely having a key elsewhere does not enable these services.
- Switching modes does not implicitly delete a stored key. Masked admin reads do not echo it; blank key fields preserve it, and the existing explicit clear action removes it.

**Keyless does not mean unlimited, permanently free, private or offline.** Public Exa and Parallel are rate-limited; Firecrawl keyless usage has per-IP daily request and credit limits. API keys may consume free credits, a paid balance or account-specific allowances. Token prices in a model catalog are not a search-provider billing guarantee.

The daemon's preferred provider is a soft preference. A failed public search can fall back to an enabled paid provider unless `policy.allowed` excludes it. To restrict a route to public services, set the complete allow-list rather than relying on preference alone.

## Daemon configuration examples

Enable only the three official public paths:

```json
{
  "server": {
    "search": {
      "providers": {
        "exa": { "authMode": "public" },
        "parallel": { "authMode": "public" },
        "firecrawl": { "authMode": "public" }
      },
      "policy": {
        "preferred": "exa",
        "allowed": ["exa", "parallel", "firecrawl"],
        "fallbackEnabled": true
      }
    }
  }
}
```

An API-key service uses its own configuration, for example:

```json
{
  "server": {
    "search": {
      "providers": {
        "exa": { "authMode": "api", "apiKey": "YOUR_EXA_KEY" },
        "brave": { "apiKey": "YOUR_BRAVE_KEY" },
        "claude": { "apiKey": "YOUR_ANTHROPIC_KEY", "model": "claude-opus-5-5" }
      }
    }
  }
}
```

Do not paste real credentials into version-controlled configuration. Use the existing write-only Control Panel inputs and secure configuration workflow. Model API calls and search tools can incur separate charges; Omnicross does not pay those charges on the operator's behalf.

Enable an HTTP aggregate without silently opting into every engine:

```json
{
  "server": {
    "search": {
      "providers": {
        "http-bing": { "enabled": true },
        "http-duckduckgo": { "enabled": false },
        "http-startpage": { "enabled": true },
        "public": { "enabled": true }
      },
      "policy": {
        "preferred": "public",
        "allowed": ["public", "http-bing", "http-startpage"],
        "fallbackEnabled": true
      }
    }
  }
}
```

The aggregate intersects enabled children with the active policy, including per-request policy narrowing. Enabling `public` alone does not grant permission to contact disabled engines. It deduplicates source URLs and ranks cross-engine results under a bounded shared deadline; partial success is allowed, but challenge pages and source-free responses are not usable results.

Without search configuration, the standalone runtime and daemon retain Bing/DuckDuckGo only. New HTTP engines cannot become fallback destinations merely because their code is installed. Embedders can opt into additional contributions explicitly or name additional builtins in the runtime's allowed policy.

## Library usage

```ts
import { createSearchRuntime } from '@omnicross/core/search';
import { apiSearchContributions } from '@omnicross/core/search/api';

const runtime = createSearchRuntime({
  contributions: apiSearchContributions({ exa: { authMode: 'public' } }),
});

const response = await runtime.search({
  query: 'Node.js documentation site:nodejs.org',
  provider: 'exa', // a hard pin; failure cannot use another provider
  options: { maxResults: 3, timeout: 30_000 },
});

console.log(response.providerId, response.results);
```

For aggregates, `SearchExecutionContext.allowedProviderIds` is a trusted runtime input passed separately from caller-controlled options. Custom composite providers must intersect their children with this context; request options cannot widen the active runtime policy.

## Control Panel and diagnostics

The Search page provides provider entries, public/API mode controls, write-only credential inputs, HTTP opt-in switches and operator-entered test queries. Claude exposes a model override; Perplexity's direct Search API does not.

Changes retain the existing apply semantics: the Codex managed-search mode applies immediately; runtime provider changes and other captured frontend settings require a daemon restart. The page shows pending restart rather than claiming all settings are already live. Interactive provider tests build from persisted configuration, and show actual provider attribution/fallback information.

- `GET /admin/api/search/diagnostics`: sanitized, network-free runtime/configuration projection.
- `POST /admin/api/search/test`: bounded, fixed-query health probe.
- `POST /admin/api/search/query`: operator query and sanitized source results.

HTTP engines may still be blocked by an operator's network or a search site's challenge policy. A blocked result is not a reason to bypass egress restrictions or automate CAPTCHA solving.

## Safety boundaries

- Shared transports enforce egress checks, redirect limits, response byte caps, timeouts and cancellation.
- Cross-origin redirects permanently remove provider authentication headers. Body-preserving redirects cannot forward configured secrets to an unrelated origin.
- JSON/SSE MCP responses are matched to their JSON-RPC request; protocol and tool-level errors are not source results.
- Missing or `N/A` source metadata is normalized without inventing information.
- Hard `-site:` exclusions are checked locally, including subdomains, DNS trailing dots, IDNA-equivalent hosts and exclusion sets beyond upstream parameter limits. They are never relaxed to obtain a nonempty answer.
- Invalid-only result arrays fail parsing so an allowed fallback can run; genuinely empty searches remain distinct from malformed responses.

## Release verification snapshot (2026-10-23)

- The root `npm run typecheck` and `npm run build` pipelines passed. Contracts/core exports resolved through both ESM and CommonJS, including the new search adapters; declaration generation passed. The UI was rebuilt after the browser-discovered fixes.
- Search/configuration/admin/UI/localization regression scope: **45 test files, 1,045 tests passed**, including the real isolated-daemon settings smoke.
- `npm run release:check -- 0.7.0` passed. Release-contract tests passed **20/20**; desktop daemon-runtime packaging contracts passed **10/10**.
- Dry-run tarball inspection passed for the six publishable `0.7.0` workspaces: contracts, core, subscriptions, CLI launcher, daemon and UI. Tests, fixtures and caches were excluded; package licenses and READMEs were included. Core also contains the third-party `NOTICE`. Private `@omnicross/chatgpt-web@0.5.0` is not a publish target.

Live calls used the built adapters and runtime, with explicit public modes and no credentials:

- **Exa:** returned three Node.js documentation sources.
- **Firecrawl:** returned three Node.js sources.
- **Parallel:** returned **HTTP 429**, explicitly identifying the free-tier MCP quota. The hard-pinned request surfaced `rate_limited`; it did not silently change authentication modes or bypass the quota. This run does not establish currently available anonymous Parallel quota.

The production-built Control Panel was also exercised against a real daemon using an isolated temporary configuration:

- API mode without a key disabled saving. Saving a non-real sentinel credential, reading its masked state, and switching back to public mode preserved the explicit mode without echoing the secret.
- Only Claude offered a model override; Perplexity and the other direct search APIs did not.
- A real query whose first candidate was rejected by egress policy fell back to Firecrawl and displayed **`via firecrawl · Fallback: 1 · 5 results`**, with actual Node.js URLs. A separate Chinese React query also returned real Chinese documentation sources. Browser console errors were empty.
- The temporary daemon/configuration and smoke launcher were removed after verification.

No paid-provider live calls, installer/signing builds, npm publication or Git writes were performed. Paid adapters were covered by protocol-fixture and error-path tests, not account-billing verification. The UI build still emits a non-fatal large-chunk warning (approximately 3.16 MB minified / 1.02 MB gzip); this task did not change chunking policy.

## Official service references

- [Exa MCP](https://exa.ai/docs/get-started/exa-mcp.md)
- [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
- [Firecrawl Search](https://docs.firecrawl.dev/features/search) and [keyless limits](https://docs.firecrawl.dev/rate-limits#keyless-no-api-key)
- [Perplexity Search API](https://docs.perplexity.ai/api-reference/search-post)
- [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

Provider terms, prices, models and public limits can change independently of this package. Test against the target deployment network and verify account billing before enabling paid services.
