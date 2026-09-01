# Duplicate fallback implementations and search consumers (frozen)

> **Frozen as of 2026-09-01, Elftia HEAD `1d4746ea65ce1d583e8be74346a78d2d6854fe20`,
> Omnicross branch `feat/search-runtime-extraction-phase1` @ `97aed26`.**
> Point-in-time record. Companion to
> [`elftia-search-baseline.md`](./elftia-search-baseline.md).

Phase 1 阶段0 artifact. Two jobs:

1. Put the **three independent fallback-order implementations** side by side and state
   their divergences as facts. Choosing a canonical order is 阶段3's decision, not this
   document's.
2. Give the orchestrator change (阶段3) a complete **kill-list**: every call site whose
   behavior depends on any of the three orders, so no consumer is migrated blind.

Elftia paths are relative to `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia`;
Omnicross paths to the repository root of this worktree.

---

## 1. The three fallback implementations

| # | Implementation | File | Runs in |
| --- | --- | --- | --- |
| A | `WebSearchOrchestrator.searchWithFallback` | Elftia `packages/desktop/app/main/services/capabilities/search/WebSearchOrchestrator.ts` | Electron main (desktop host) |
| B | `createHttpOnlyWebSearchService(...).searchWithFallback` | Elftia `packages/agent-engine/src/engine/tinyelf/tools/HttpOnlyWebSearchService.ts` | non-Electron hosts (`elftia-server`) |
| C | `BuiltinToolExecutor.resolveProviderChain` | Omnicross `packages/core/src/completion/BuiltinToolExecutor.ts` | Omnicross serving core — but **not reached in production today**, see §1.4 |

### 1.1 Concrete orders

**A — `WebSearchOrchestrator`** (`resolveCandidates`, lines 143–167). Deduplicated,
first-wins, and every step after the first filters on `describeProvider(id).eligible`:

```
1. explicit selection (or defaultProvider when selection === 'auto')   [unfiltered]
2. registry registration order:  tavily, jina, searxng, zhipu, z.ai, grok
3. HTTP ids:                     http-bing, http-duckduckgo
4. local ids:                    local-google, local-bing, local-baidu, local-duckduckgo
```

`native` is never appended by steps 2–4 and is hard-skipped during execution
(`provider === 'native'`, line 91).

**B — `HttpOnlyWebSearchService`** (`resolveHttpCandidates`, lines 151–157). HTTP ids only:

```
first  = isHttpWebSearchProviderId(selection) ? selection : defaultProvider   // default 'http-bing'
order  = [first, ...HTTP_WEB_SEARCH_PROVIDER_IDS.filter(p => p !== first)]
       = http-bing, http-duckduckgo        (with the default selection)
```

A non-HTTP explicit selection is not executed; it is recorded as one `ineligible` attempt
with reason `Provider is unavailable in this host; only keyless HTTP search is supported`
(lines 85–91) before the HTTP candidates run.

**C — Omnicross `BuiltinToolExecutor`** (`FALLBACK_ORDER`, lines 23–26; chain built at
lines 149–159). Filtered by `webSearch.isProviderEnabled(id)`:

```
FALLBACK_ORDER = tavily, jina, searxng, zhipu, z.ai, bocha, grok,
                 local-google, local-bing, local-baidu, local-duckduckgo
then: if the chain does not already contain 'local-google', append it
      (IMPLICIT_LOCAL_FALLBACK, line 28)
```

### 1.2 Divergence table

These are differences in what each implementation *would do* when invoked. A and B both run
in production; **C does not run at all today** (§1.4), so its rows describe latent behavior,
not observable behavior.

| # | Divergence | A (orchestrator) | B (http-only) | C (BuiltinToolExecutor) |
| --- | --- | --- | --- | --- |
| D1 | `bocha` in the order | absent from the candidate walk (it is in `API_PROVIDER_IDS` but never registered, so step 2 never yields it) | n/a | **present, between `z.ai` and `grok`** — and Elftia never registers a `bocha` adapter, so in a shared backend it can only ever return `Provider bocha not implemented` |
| D2 | `grok` position | 6th in registry order | n/a | **7th**, after `bocha` |
| D3 | `http-bing` / `http-duckduckgo` | present (step 3) | the only providers | **absent entirely** — `FALLBACK_ORDER` is typed `WebSearchProviderId[]`, which has no `http-*` members |
| D4 | Implicit `local-google` append | none — an ineligible provider is simply not a candidate | none | **appends `local-google` unconditionally** when absent, i.e. it is attempted even when `isProviderEnabled('local-google')` returned false |
| D5 | Explicit selection honoured | yes — prepended, and recorded as `ineligible` when it is not usable | partially — HTTP selection prepended, non-HTTP recorded as `ineligible` | **no selection parameter at all**; the tool takes only `query`/`count` |
| D6 | Attempt record on the wire | full `attempts[]` with `ineligible/failed/empty/invalid/success` | full `attempts[]`, same outcome vocabulary | **none** — failures are only `console.log`ged; the tool returns a single text blob |
| D7 | Eligibility source | `describeProvider` (enabled + configured + registered, per kind) | `options.enabledProviders?.[p] ?? true` | `WebSearchBackend.isProviderEnabled(id)` — the host's method, which does not know about registry availability |
| D8 | SERP-redirect URL rejection | yes — `isDirectResultUrl` rejects Google `/search` `/goto`, Bing `/search`, DDG `/html/` `/l/`, Baidu `/s` | **no** — `isDirectHttpUrl` only checks the `http:`/`https:` protocol | none — no result validation layer at all beyond `result.success` and a non-empty `results` array |
| D9 | Duplicate-only invalidation | yes (`Provider returned only duplicate results`) | no — dedupe happens, but one surviving result is accepted | no |
| D10 | `maxResults` handling | `Math.max(1, options.maxResults ?? 5)`, no upper bound | same | `Math.min(Math.max(count ?? 5, 1), 10)` — clamped to 10 at the tool boundary |
| D11 | Failure-reason sanitizer fallback literal | `HTTP provider request failed` | `HTTP search request failed` | none (raw `result.error` is logged and the last one is surfaced in the tool text) |

### 1.3 The stale parity comment

`BuiltinToolExecutor.ts` line 22 reads:

```ts
/** Provider fallback order (same as WebSearchServiceTool) */
```

and line 109 repeats `// Build provider chain (same logic as WebSearchServiceTool)`.

**Both comments are stale.** Elftia's `WebSearchServiceTool`
(`packages/agent-engine/src/engine/tinyelf/tools/WebSearchServiceTool.ts`) holds no
provider order at all: it calls `searchService.searchWithFallback(query, requested, …)` and
formats `result.attempts`. Ordering moved into implementation A. Nothing in the repository
still matches the order the comment claims parity with.

### 1.4 Implementation C's order executes nowhere in production today

Order C is real code with a real divergence table, but nothing currently calls it:

- Elftia's only construction site is `new ElftiaBuiltinToolExecutor(this.deps.webSearch)`
  (`ChatCompletionPipeline.ts` line 409). That subclass **overrides `execute` and intercepts
  all three web builtins** (`ElftiaBuiltinToolExecutor.ts` lines 57–72): `web_search` goes to
  `hostSearch.searchWithFallback(...)` — implementation **A** — `web_search_providers` to
  `hostSearch.listAvailableProviders()`, and `web_fetch` to its own `createWebFetchTool()`.
  `super.execute` is reached **only for an unrecognised tool name**, which no builtin
  produces. So `FALLBACK_ORDER` / `resolveProviderChain` never run in Elftia.
- `grep` for `new BuiltinToolExecutor` across Elftia returns nothing; across Omnicross it
  returns exactly two hits, both in
  `packages/core/src/ports/__tests__/web-search-backend.port.test.ts` (lines 55, 76).

**Consequence for 阶段3:** removing C's own provider order is a *lower-risk* edit than the
divergence table alone suggests. Divergences D1–D11 describe how C *would* behave if it ran,
and they are the reason the order must not simply be copied into the shared orchestrator —
but no live traffic changes when C's order is deleted today. The real compatibility
constraints are the **exported class surface** (`BuiltinToolExecutor` and
`getBuiltinSearchTools` from `packages/core/src/completion/index.ts`, which
`ElftiaBuiltinToolExecutor` extends and Elftia is read-only in Phase 1) and the **port
test**, not any production call path.

### 1.5 Duplicated helpers (not order, but same drift risk)

`sanitizeHttpFailureReason` is byte-identical in A (`WebSearchOrchestrator.ts` 300–314) and
B (`HttpOnlyWebSearchService.ts` 182–196) except for the fallback literal (D11). Any
consolidation in 阶段3 should fold both.

---

## 2. Consumer map — Elftia

Every site that reaches search behavior, with the role it plays. `Port` =
`WebSearchServicePort` (`packages/agent-engine/src/ports/index.ts` lines 78–87:
`search`, `isProviderEnabled`, `searchWithFallback`, `listAvailableProviders`).

### 2.1 Implementations and wiring

| Site | Role |
| --- | --- |
| `packages/desktop/app/main/services/capabilities/search/WebSearchService.ts` | The desktop implementation; owns the config/secret maps, the `local-*` pre-branch, registry dispatch, and delegates all policy to implementation A. |
| `.../capabilities/search/WebSearchOrchestrator.ts` | **Implementation A** — eligibility, order, fallback, result validation. |
| `.../capabilities/search/registry/WebSearchProviderRegistry.ts` + `builtin-search-adapters.ts` | Registration order *is* the API-provider fallback order for A (step 2). |
| `packages/agent-engine/src/engine/tinyelf/tools/HttpOnlyWebSearchService.ts` | **Implementation B** — the port implementation for non-Electron hosts. |
| `packages/agent-engine/src/engine/tinyelf/tools/webFetchSearch.ts` | Executes `http-bing` / `http-duckduckgo` for both A and B; owns the per-engine URL list, parsers, 202-challenge detection and Bing anti-decoy trust check. |
| `packages/desktop/app/main/bootstrap/capabilities-transformer-search.ts` | Desktop bootstrap: constructs `WebSearchService(undefined, deps.secrets, createKeylessHttpSearchPort())` and publishes it via `AgentProxyServer.setGlobalWebSearchService`. |
| `packages/desktop/app/main/bootstrap/router-dependencies.ts`, `.../services/routers/routerDependencies.ts`, `.../services/routers/Router.ts` | Thread the single `WebSearchService` instance into every IPC router. |
| `packages/server/src/host/AgentEngineServer.ts` line 319 | Non-Electron host: falls back to `createHttpOnlyWebSearchService()` when no `webSearchService` dep is supplied — **the only production entry into implementation B**. |

### 2.2 Agent-engine (TinyElf) consumers

| Site | Role |
| --- | --- |
| `.../tinyelf/TinyElfToolRegistryBuilder.ts` (lines 755–900) | Decides between the explicit `WebSearch` tool, provider-native request-level search, and no search; constructs `WebSearchServiceTool` + `WebSearchProvidersTool` and passes `config.webSearchProviderId` as the preferred selection. |
| `.../tinyelf/TinyElfEngine.ts` | Holds the `webSearchService` dep and hands it to the registry builder. |
| `.../tinyelf/tools/WebSearchServiceTool.ts` | Agent tool `WebSearch`; clamps `count` to 1–10, validates the `provider` enum against `WEB_SEARCH_SELECTION_IDS`, calls `searchWithFallback`, and renders `Provider used:` + `Attempts: a:outcome -> b:outcome`. Holds **no** provider order. |
| `.../tinyelf/tools/WebSearchProvidersTool.ts` | Agent tool `WebSearchProviders`; returns `JSON.stringify({ providers: listAvailableProviders() })` — sanitized descriptors only, never keys. |
| `.../tinyelf/tools/WebTools.ts` | `WebFetch` tool; re-exports `createKeylessHttpSearchPort` and reuses `searchPageTrustError` from `webFetchSearch.ts` for fetched search pages. |
| `.../tinyelf/tools/webFetchHttp.ts`, `nodeWebFetchTransport.ts` | Shared HTTP transport under both `WebFetch` and keyless HTTP search (2 MiB cap, timeout, redirect handling). |

### 2.3 Desktop chat / proxy consumers

| Site | Role |
| --- | --- |
| `.../agent-core/engine/pipeline/ElftiaBuiltinToolExecutor.ts` | **Subclasses** Omnicross's `BuiltinToolExecutor` and re-uses `getBuiltinSearchTools()`, re-adding a `provider` enum to the `web_search` schema and an extra `web_search_providers` builtin tool. It **overrides `execute` and intercepts all three web builtins**, routing `web_search` to `hostSearch.searchWithFallback` (implementation **A**), so implementation C's order is bypassed entirely — the dependency on C is compile-surface only (see §1.4). Constructed at `ChatCompletionPipeline.ts:409`. |
| `.../agent-core/engine/pipeline/ChatCompletionPipeline.ts`, `.../engine/ChatEngine.ts` | Thread `nativeSearch` / `webSearchEnabled` through the non-agent chat pipeline and select the builtin executor. |
| `.../agent-core/agent/proxy/proxySearchIntercept.ts` | Intercepts Anthropic search-only sub-requests and answers them from `searchWithFallback(query, 'auto', { maxResults: 5 })`, synthesizing an Anthropic Messages response. Imports `WebSearchBackend` from `@omnicross/core/ports/web-search-backend` — a live Elftia→Omnicross dependency. |
| `.../agent-core/agent/proxy/createRequestHandlerForRoute.ts` (lines 80–86) | Resolves instance-level `webSearchService` first, then `AgentProxyServer.getGlobalWebSearchService()`. |
| `.../agent-core/agent/proxy/ProxyRequestHandler.ts`, `AgentProxyServer.ts`, `proxy/types.ts` | Carry the backend reference and the global setter/getter. |

### 2.4 IPC, plugin, and settings consumers

| Site | Role |
| --- | --- |
| `.../services/routers/web-search/handlers/search.ts` | `webSearch:search` IPC — validates the selection with `webSearchSelectionIdSchema` and calls `searchWithFallback`. |
| `.../services/routers/web-search/handlers/getProviders.ts` | `webSearch:getProviders` IPC — returns `runtime: listAvailableProviders()`. |
| `.../services/routers/WebSearchRouter.ts`, `web-search/index.ts`, `web-search/types.ts` | Router assembly for the `webSearch:*` channel family (incl. `configureProvider`, `setProviderKey`, `validate`). |
| `.../services/routers/completion/CompletionRouter.ts`, `ChatStreamHandler.ts`, `completion/types.ts` | Completion router path that reaches the builtin search tools. |
| `.../capabilities/search/setSearchProviderKey.ts` | Shared one-way key write used by both the `webSearch:setProviderKey` IPC and the plugin port. |
| `.../platform/plugins/bridge/searchConfigHostAdapter.ts` | Plugin `host.services.searchConfig` port — narrows the live service structurally and reads through the **masked** `getProviderConfig`; plugins never see a key. |
| `.../platform/plugins/bridge/buildAgentBackendHostApi.ts`, `packages/plugin-types/src/host-api/{backend-services,search-config}.ts` | Plugin-facing type surface for the same. |
| `.../routers/llm/secretsPack/secretsPackMediaSearch.ts`, `bridge/secretsPackHostAdapter.ts` | Secrets-pack import/export of `search-provider:<id>:apiKey` refs. |

### 2.5 Tests that pin current behavior

`.../capabilities/search/__tests__/WebSearchService.orchestration.test.ts` (implementation A),
`.../search/__tests__/WebSearchService.hydration.test.ts` (secret hydration),
`.../search/registry/__tests__/{WebSearchProviderRegistry,registry-completeness}.test.ts`
(registration set and order),
`.../tinyelf/tools/__tests__/WebTools.test.ts` (HTTP parsers, **inline synthetic HTML only —
no captured fixtures exist in Elftia**),
`.../bootstrap/__tests__/httpSearchNodeBoundary.test.ts`,
`.../agent-core/agent/proxy/__tests__/proxySearchIntercept.test.ts`,
`.../agent-core/engine/pipeline/__tests__/ElftiaBuiltinToolExecutor.test.ts`,
`.../services/__tests__/WebSearchService.local.test.ts`,
`.../routers/web-search/__tests__/webSearchRouter.test.ts`.

---

## 3. Consumer map — Omnicross

| Site | Role |
| --- | --- |
| `packages/core/src/ports/web-search-backend.ts` | The `WebSearchBackend` port — exactly three methods (`search`, `isProviderEnabled`, `readUrl`) over `@omnicross/contracts` types. The host's `WebSearchService` satisfies it with no adapter. **Elftia imports this path directly**, so 阶段1 must keep it resolvable. |
| `packages/core/src/completion/BuiltinToolExecutor.ts` | **Implementation C.** Owns `FALLBACK_ORDER`, `IMPLICIT_LOCAL_FALLBACK`, the `builtin__web_search` / `builtin__web_fetch` tool metadata, and `DEFAULT_SEARCH_COUNT = 5`. The order removed in 阶段3 lives here. |
| `packages/core/src/completion/builtin-web-fetch.ts` | Lightweight URL fetcher used by `web_fetch` after the JinaReader attempt. |
| `packages/core/src/completion/CompletionService.ts` (line 697), `ToolExecutor.ts` (line 399), `ToolHandler.ts` (line 63) | Accept an optional `builtinExecutor?: BuiltinToolExecutor` and dispatch `serverId: 'builtin'` tool calls to it. |
| `packages/core/src/completion/index.ts` (line 55) | Public export of `BuiltinToolExecutor` + `getBuiltinSearchTools` — the surface `ElftiaBuiltinToolExecutor` consumes. |
| `packages/core/src/provider-proxy/types.ts` (lines 237, 346) and `ingress/anthropicMessagesIngress.ts` (line 222) | Carry `webSearchService?: WebSearchBackend | null` as a proxy hint into the Anthropic ingress path. |
| `packages/core/src/ports/index.ts`, `packages/core/src/index.ts` (line 47) | Re-export the port type. |
| `packages/contracts/src/websearch-types.ts` | The id union SSOT plus the `isApiProvider`/`isLocalProvider` prefix helpers that 阶段1 replaces with explicit declarations. |
| `packages/core/src/ports/__tests__/web-search-backend.port.test.ts` | Injects a mock backend into `BuiltinToolExecutor` — the existing regression net around implementation C. |
| `packages/core/tsup.config.ts` | Entry registration for core sub-paths. **Not touched by this change**, but any new `packages/core/src/search/**` entry added in a later stage must be registered here or it will not be built or exported. |

---

## 4. Kill-list summary for 阶段3

**Read §1.4 first:** order C runs nowhere in production today, so removing it changes no live
behavior. What follows is the list of sites that must still keep **compiling and passing**,
in dependency order — a compile-and-test surface, not a behavioral blast radius:

1. `packages/core/src/completion/BuiltinToolExecutor.ts` — the order itself, plus the two
   stale parity comments (§1.3).
2. `packages/core/src/completion/{CompletionService,ToolExecutor,ToolHandler}.ts` — pass the
   executor through; a constructor-signature change lands here.
3. `packages/core/src/ports/__tests__/web-search-backend.port.test.ts` — asserts against C.
4. Elftia `.../agent-core/engine/pipeline/ElftiaBuiltinToolExecutor.ts` and its test — the
   only *subclass* of C. It overrides every web builtin, so it consumes no behavior from C,
   but it must keep compiling against whatever `@omnicross/core` exports (Elftia is
   read-only in Phase 1, so the exported class surface and `getBuiltinSearchTools` cannot
   break).
5. Elftia `.../agent-core/agent/proxy/proxySearchIntercept.ts` — imports the port path
   directly; the port module must not move or change shape.
6. Divergences D1 (`bocha`), D3 (`http-*` absent) and D4 (implicit `local-google`) are the
   three deltas a single shared order must consciously resolve. They are **not** live
   behavior deltas today (§1.4) — they are the reason C's order must not be adopted as the
   canonical one by default.
