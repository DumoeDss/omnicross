# Elftia search baseline (frozen)

> **Frozen as of 2026-09-01, Elftia HEAD `1d4746ea65ce1d583e8be74346a78d2d6854fe20`.**
> This is a point-in-time record, not a living document. Later stages of
> [`omnicross-search-runtime-extraction-plan.md`](./../omnicross-search-runtime-extraction-plan.md)
> compare against it; they append comparison reports elsewhere rather than editing this file.

Phase 1 阶段0 artifact. Its purpose is to let every later change answer "what did Elftia
actually do?" without re-opening the Elftia repository. Companion documents:
[`duplicate-fallback-and-consumers.md`](./duplicate-fallback-and-consumers.md) (the three
fallback implementations and their consumers) and [`wire-baseline.md`](./wire-baseline.md)
(protocol-level search surfaces).

Every statement below cites the Elftia source file it was read from. Paths are relative to
the Elftia repository root `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia`
unless stated otherwise.

---

## 1. Reference provenance

| Fact | Value |
| --- | --- |
| Elftia repository | `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia` |
| HEAD commit | `1d4746ea65ce1d583e8be74346a78d2d6854fe20` |
| HEAD subject | `merge: integrate plugin packaging fix` |
| HEAD date | 2026-09-01 19:53:51 +0800 |
| Behavior reference | **the WORKING TREE, not HEAD** |
| Freeze date | 2026-09-01 |
| Access mode | read-only (no commits, no working-tree changes made by this change) |

**The working tree is the behavior reference.** At freeze time the Elftia working tree is
dirty. Within the search-relevant paths listed in §2, `git status --porcelain` reports
exactly two deviations from HEAD:

```
 M packages/desktop/app/main/services/capabilities/search/providers/LocalSearchProvider.ts
?? packages/desktop/app/main/services/capabilities/search/providers/__tests__/
```

Anything Phase 1 replicates from `LocalSearchProvider.ts` must be read from the working
tree; the committed HEAD version is *not* the behavior Elftia runs today.

**Drift check result (task 1.1):** `LocalSearchProvider.ts` hashes to
`d8144dd1eadda24d3940a204ad8f24adb0c655b809334e05922027054a5be950` (579 lines) at
implementation time, which **matches** the planning-time hash recorded in the change
design. No drift; no re-baselining was required.

**Elftia HEAD advanced during the freeze — recorded, not absorbed.** Between the start and
the end of this baseline work, the Elftia repository (an active checkout) moved from
`1d4746ea65ce1d583e8be74346a78d2d6854fe20` to `1e4bcbde666596f72784847773c9776aafdeb55e`
by one commit, `1e4bcbde6 test(plugins): cover legacy BYO seed upgrade`. That commit touches
`packages/desktop/app/main/services/platform/plugins/__tests__/seedBundledPlugins.test.ts`,
which is outside every path in the manifest below. **All 34 manifest entries were
re-computed after the move and are byte-identical**, and the two search-relevant
working-tree deviations are unchanged. The manifest and the behavior it pins therefore
still hold; the banner deliberately keeps naming `1d4746ea` as the freeze point, with
`1e4bcbde` recorded here as the observed successor. Later stages re-verifying this manifest
should expect Elftia's HEAD to have moved further and should compare **hashes**, not the
commit id.

**Note on the untracked directory.** Two files with the same name and different content
coexist in the working tree: the tracked
`providers/LocalSearchProvider.concurrency.test.ts` and the untracked
`providers/__tests__/LocalSearchProvider.concurrency.test.ts` (different sha256, see §2).
Both are recorded in the manifest so a later reader is not surprised by the duplicate.

### Hash method

Hashes are `sha256` over the **raw bytes of the working-tree file** as they sit on the
Windows filesystem (line endings not normalised), computed with `sha256sum`. Re-verify
with the same method or the values will not reproduce.

---

## 2. File hash manifest (working tree, 2026-09-01)

`H` = identical to HEAD; `M` = modified vs HEAD; `??` = untracked.

### `packages/desktop/app/main/services/capabilities/search/**`

| State | Path (under `packages/desktop/app/main/services/capabilities/search/`) | sha256 |
| --- | --- | --- |
| H | `ApiKeyRotator.ts` | `9c649cba995ff6201628c8ffd2eb183b4579a1267a009fb536fa64d2ed067a6c` |
| H | `WebSearchOrchestrator.ts` | `07baab17e49336f0517710c37e7a775191493bc61d7f8f7eda303b4cf4f87c27` |
| H | `WebSearchService.ts` | `9f692b29c8ba9542a75457344e421d61f53f3bf069163695b42a65022c4008b0` |
| H | `index.ts` | `34c264d0590c3df57d2a93a2abf1ef119650743fbd7b05bd49bd9fd9f4aba2a5` |
| H | `searchSecretRefs.ts` | `d7c1d8a6431db6e1a07ecbf36a320d24dde01a0c0b9c834a6dc018dd0ad87861` |
| H | `setSearchProviderKey.ts` | `a4a022c1d3c3094970191eed8b245798f435d01e3a942944b0a1d92f4ab0deb5` |
| H | `__tests__/ApiKeyRotator.test.ts` | `f66e218808a4a4afb89c87a5b7cd191c67dc643e0a3b75ceae29bcf7fbb3f4bc` |
| H | `__tests__/WebSearchService.hydration.test.ts` | `2bf8e14ee8e9d3c8835933ac28a51f90edf7d7265ad0fd530e545f19c3931ff8` |
| H | `__tests__/WebSearchService.orchestration.test.ts` | `c472bde75f355eace720929ccdbedc277429c981e71a76150ae29e2bf9ae3199` |
| H | `providers/ClaudeSearchProvider.ts` | `e09451f97151cee00b4aad01d2ea17a4951292f438b7dba402d1156a2163fab1` |
| H | `providers/GrokSearchProvider.ts` | `84d52a7645f5b5b50e9216af08a29fa7709547b826e1e2eb170f8e4ff1b007e2` |
| H | `providers/JinaProvider.ts` | `374d2252e22ab4249b3b969ce882e1e8e6f5c1b6deb456b9d3f1ab89b22eee15` |
| H | `providers/JinaReader.ts` | `85d8b2a671c20dd214ae961316c661be11a946808a3083976cf059e31aae908d` |
| H | `providers/LocalSearchProvider.concurrency.test.ts` | `2453a22d49f2be6d7f666326d3424375762c56bbcade44d15c1a49dd59f414b3` |
| **M** | `providers/LocalSearchProvider.ts` | `d8144dd1eadda24d3940a204ad8f24adb0c655b809334e05922027054a5be950` |
| H | `providers/SearxngProvider.ts` | `c1ec6694715e264d6a170b3d280b8388f987cb85737bee84915c86a7e6279374` |
| H | `providers/TavilyProvider.ts` | `3134dcd74f4d3c2023abf54792c3b36587b2024f5d0018eccbd1c53836a195a6` |
| H | `providers/ZhipuProvider.ts` | `2a9a0f5b6d65d1d55bf55f4c6324d5491544427f8eaafc4d3889a1b1366118e5` |
| H | `providers/types.ts` | `af63939fd9f1b1dbdc0bdeea10c1d6fd0c93160f62b4d9a21b661d6234ee7d0c` |
| **??** | `providers/__tests__/LocalSearchProvider.concurrency.test.ts` | `e7cf84b01727dc321b974e56214c51dce427bcc62c9cf0877017076f350f626a` |
| H | `registry/WebSearchProviderRegistry.ts` | `f8925194014a7bfb04007490fa82820aa55f2bd8a2a28259098a5cec68855a01` |
| H | `registry/builtin-search-adapters.ts` | `bf0f01c16dbb4e089ea63db0807dd301c248709e3aa6759003398391f88996f1` |
| H | `registry/types.ts` | `b272fa3681280e58db3bfcfb6b8b17701f3feae446fcaa2f5f6fdf31910638fc` |
| H | `registry/__tests__/WebSearchProviderRegistry.test.ts` | `eb3a1ca79cd1e9b7b046f09153f80da64d24777c173091c9ceeef4a784e87473` |
| H | `registry/__tests__/registry-completeness.test.ts` | `e4c56f96ea6affd20dcda1b88c612c5ac047ced9bbd11a1419d989830b869d8f` |

### TinyElf web-search / web-fetch tools

All under `packages/agent-engine/src/engine/tinyelf/tools/`, all identical to HEAD.

| Path | sha256 |
| --- | --- |
| `WebTools.ts` | `cd0b303021eac7a6278ede1b35888d9efa0a0d6c554c1bd84fc76b627b4c45c6` |
| `webFetchSearch.ts` | `2fa0275e2430cc87c2dfb7702ad3c62f2e7b71734dfa94475865856e5f5ab057` |
| `webFetchHttp.ts` | `5affcc1d62416ae10da88c0220cbf52870b339fcb1930ce150f31b466d5715b0` |
| `nodeWebFetchTransport.ts` | `bfdd3e3aee6b17649da86693370fe1d5a4adea33650d1fcecf2ac4e7ebe40229` |
| `HttpOnlyWebSearchService.ts` | `531440a5e1fcf403505204bdd6bfa41189daf119c5c1b460848a198b426a42c6` |
| `WebSearchServiceTool.ts` | `dbddf69be6e3731223d473e1586f4286ff7236ca9479a040b5029c331aec0bd4` |
| `WebSearchProvidersTool.ts` | `014ef8ea5cb6e4aa686ef34b1615d4272099432e7958a867439179d3a9a9dacb` |

### Shared contracts

Both identical to HEAD.

| Path | sha256 |
| --- | --- |
| `packages/shared/src/contracts/runtime/web-search-orchestration.ts` | `49c53cf9af876917623181d40ffbe986452279ef77ccc58cb74ca2552388ab8d` |
| `packages/shared/src/contracts/runtime/websearch-types.ts` | `7c132e8798cdaf207d3bc7a835f854e2aa3e8ea9b6e3b8facafdaa93c78c2804` |

**Dependency direction note.** `packages/shared/src/contracts/runtime/websearch-types.ts`
is a one-line re-export shim: `export * from '@omnicross/contracts/websearch-types';`.
Elftia already depends on Omnicross for the search contract SSOT. Phase 1 preserves this
direction; the contracts change (阶段1) must keep the
`@omnicross/contracts/websearch-types` entry point resolvable or Elftia's build breaks.

---

## 3. Provider inventory

Sources: `WebSearchOrchestrator.ts` (id groups, lines 25–47),
`registry/builtin-search-adapters.ts` (what is actually registered),
`packages/contracts/src/websearch-types.ts` in Omnicross (the id union, re-exported into
Elftia as `@shared/websearch-types`).

### 3.1 Local browser-automation providers (4)

`local-google`, `local-bing`, `local-baidu`, `local-duckduckgo`
— `LOCAL_PROVIDER_IDS` in `WebSearchOrchestrator.ts`.

Implemented by `providers/LocalSearchProvider.ts` (Electron hidden `BrowserWindow`), which
is *not* registry-dispatched — `WebSearchService.search()` branches on the `local-` prefix
before reaching the registry (`WebSearchService.ts` line 226).

Per-provider config from `LOCAL_PROVIDER_CONFIGS` (`LocalSearchProvider.ts` lines 43–103):

| id | search URL template | wait selector | notes |
| --- | --- | --- | --- |
| `local-google` | `https://www.google.com/search?q={{query}}&hl=en` | `#search` | has `aiOverviewSelectors` for AI Overview / AI Mode extraction |
| `local-bing` | `https://www.bing.com/search?q={{query}}` | `#b_results` | result container `li.b_algo` |
| `local-baidu` | `https://www.baidu.com/s?wd={{query}}` | `#content_left` | selectors scoped to `#content_left` to skip the sidebar |
| `local-duckduckgo` | `https://html.duckduckgo.com/html/` | `#links` | `postParam: 'q'` — POSTs the query; a GET only returns the form |

Defaults: `DEFAULT_TIMEOUT = 15000` ms, `maxResults` defaults to **10**
(`options.maxResults || 10`, line 186), default user agent is a pinned Chrome 120 UA
string (line 38). Login state is detected from `persist:websearch` session cookies:
`SID`/`__Secure-1PSID`/`SAPISID` for Google, `_U` for Bing, `BDUSS` for Baidu;
`local-duckduckgo` always reports logged in (`WebSearchService.checkLoginStatus`,
lines 442–470).

### 3.2 API providers (9 declared, 6 registered)

`API_PROVIDER_IDS` (`WebSearchOrchestrator.ts` lines 32–42) declares, in order:
`tavily`, `jina`, `searxng`, `zhipu`, `z.ai`, `grok`, `exa`, `bocha`, `claude`.

`registerBuiltinSearchAdapters()` (`registry/builtin-search-adapters.ts` lines 34–41)
registers exactly six adapter instances, in this order:

```
TavilyProvider()  →  id 'tavily'
JinaProvider()    →  id 'jina'
SearxngProvider() →  id 'searxng'
ZhipuProvider('zhipu')  →  id 'zhipu'
ZhipuProvider('z.ai')   →  id 'z.ai'
GrokSearchProvider()    →  id 'grok'
```

- **`ZhipuProvider` is registered twice** — one class, two instances, distinct `.id`
  (`'zhipu'` and `'z.ai'`). The ids do not alias each other anywhere: they carry separate
  secret refs (§5) and separate registry entries.
- **`claude`, `exa`, `bocha` are declared-but-dead.** They appear in `API_PROVIDER_IDS`
  and in the keyed-provider list, but no adapter is ever registered for them, so
  `WebSearchService.search()` returns the literal string ``Provider <id> not implemented``
  (`WebSearchService.ts` line 252). `ClaudeSearchProvider.ts` exists on disk but is never
  constructed. The deliberateness note lives in the **registry** file, not in the provider:
  `registry/builtin-search-adapters.ts` lines 12–17 record that `ClaudeSearchProvider` /
  `exa` / `bocha` are *"deliberately NOT registered (design Q3)"* so `WebSearchService.search()`
  keeps returning `'Provider <id> not implemented'` exactly as before, and that wiring
  `claude` would change behavior and is out of scope. `ClaudeSearchProvider.ts`'s own header
  carries no such note.
- **`grok` is registered in Elftia but is deliberately NOT registered in Omnicross Phase 1**
  (extraction plan, hard constraint 5: Grok prompt-search and the Claude search
  implementation are excluded from Phase 1). Downstream changes must not treat its absence
  as an oversight to fix.

### 3.3 Keyless HTTP providers (2)

`http-bing`, `http-duckduckgo` — `HTTP_WEB_SEARCH_PROVIDER_IDS` in
`packages/shared/src/contracts/runtime/web-search-orchestration.ts` line 7.

Executed by `webFetchSearch.ts` (`searchWebViaFetch` / `createKeylessHttpSearchPort`),
never through the adapter registry: the orchestrator branches on
`isHttpWebSearchProviderId(provider)` and calls `deps.httpSearch.search(...)` directly
(`WebSearchOrchestrator.ts` lines 102–107).

Engine definitions (`webFetchSearch.ts` lines 43–59):

| provider | URLs tried, in order | parser |
| --- | --- | --- |
| `http-bing` | `https://www.bing.com/search?q=<enc>` | `parseBingResults` |
| `http-duckduckgo` | `https://html.duckduckgo.com/html/?q=<enc>`, then `https://lite.duckduckgo.com/lite/?q=<enc>` | `parseDuckDuckGoResults` |

Transport limits: `SEARCH_RESPONSE_BYTES = 2 MiB`, `DEFAULT_SEARCH_TIMEOUT_MS = 15_000`,
`maxResults` clamped to `[1, 10]` with default 5 (`webFetchSearch.ts` lines 13–14, 110).
The remaining timeout budget is split evenly across the remaining candidate URLs
(lines 117–120).

### 3.4 The pseudo-provider `native`

`native` is a *selection* id, not an executable provider
(`WEB_SEARCH_SPECIAL_SELECTION_IDS = ['auto', 'native']`). `describeProvider('native')`
always returns `eligible: false` with reason
``Native search is controlled by the model caller``
(`WebSearchOrchestrator.ts` lines 172–181), and `searchWithFallback` additionally
hard-skips it (`provider === 'native'` check, line 91). It is listed by
`listAvailableProviders()` so the UI can show it, but it can never be attempted.

---

## 4. Eligibility, ordering, and fallback semantics

All from `WebSearchOrchestrator.ts`.

### 4.1 Eligibility rules per kind (`describeProvider`, lines 169–239)

| kind | `enabled` | `configured` | `available` | `eligible` |
| --- | --- | --- | --- | --- |
| `native` | `true` | `true` | `false` | **always `false`** |
| `http` | `getHttpProviderConfig(id)?.enabled ?? true` (**default on**) | `true` | `Boolean(deps.httpSearch)` | `enabled && available` |
| `local-browser` | `getProviderConfig(id)?.enabled ?? true` (**default on**) | `true` | `true` | `enabled` |
| `api` | `config?.enabled ?? false` (**default off**) | see below | `registry.has(id)` | `enabled && configured && available` |

API `configured` is decided by id:

- `searxng` → `Boolean(config?.apiHost?.trim())` — configured by **host, not key**;
- any id in `SEARCH_PROVIDERS_WITH_KEY` (§5) → `Boolean(config?.apiKey?.trim())`;
- otherwise → `Boolean(config)`.

Descriptor `reason` strings (first failing check wins):

| condition | reason |
| --- | --- |
| native | `Native search is controlled by the model caller` |
| http, `!enabled` | `Provider is disabled` |
| http, `!available` | `HTTP search transport is unavailable` |
| local, `!enabled` | `Provider is disabled` |
| api, `!enabled` | `Provider is disabled` |
| api, `!configured` | `Provider is not configured` |
| api, `!available` | `Provider is not implemented` |

Note the local-provider prefix test in `describeProvider` is a literal
`provider.startsWith('local-')` (line 202) — the same string-prefix inference that
Omnicross Phase 1 hard-constraint 3 forbids in the extracted runtime (type/source/
capabilities become explicit declarations). This is recorded as *observed Elftia behavior*,
not as a pattern to carry over.

### 4.2 Candidate order (`resolveCandidates`, lines 143–167)

Deduplicated (first occurrence wins), built in this order:

1. **Explicit selection** — `selection`, or `this.defaultProvider` when `selection === 'auto'`;
   appended unconditionally (even if ineligible, so its `ineligible` outcome is recorded).
2. **Registry registration order**, eligible only — `registry.list()` returns
   `Array.from(map.values())`, i.e. insertion order, which is
   `tavily, jina, searxng, zhipu, z.ai, grok` (§3.2).
3. **HTTP ids**, eligible only — `http-bing`, `http-duckduckgo`.
4. **Local ids**, eligible only — `local-google`, `local-bing`, `local-baidu`,
   `local-duckduckgo`.

`native` never enters via steps 2–4 and is skipped in step 1's execution.

### 4.3 Default policy

`defaultProvider` starts as `'auto'` and is only overwritten by
`configureSearchPolicy({ defaultProvider })` when that field is truthy
(`WebSearchOrchestrator.ts` lines 65–71). Type: `WebSearchPolicyConfig` in
`web-search-orchestration.ts` lines 46–48.

### 4.4 Attempt loop (`searchWithFallback`, lines 80–141)

- `maxResults = Math.max(1, options.maxResults ?? 5)` — **no upper clamp at this layer**
  (the 1–10 clamp lives in `webFetchSearch.ts` and in the tool wrappers).
- Ineligible or `native` → push `{ outcome: 'ineligible', reason: descriptor.reason ?? 'Provider is not eligible in the host runtime' }`, continue.
- HTTP id → `deps.httpSearch.search(...)`; if `deps.httpSearch` is absent, throws
  `HTTP search transport is unavailable`.
- Otherwise → `deps.executeExact(...)`, which is `WebSearchService.search()`.
- Response passes through `validateResponse` (§6.3); the first `success` returns
  `{ success: true, query, results, providerUsed, attempts }`.
- Thrown errors → `{ outcome: 'failed', reason }`, where `reason` is
  `sanitizeHttpFailureReason(error)` for HTTP providers and the fixed string
  ``Provider request failed`` for everything else.
- Exhaustion → `{ success: false, query, results: [], attempts, error: 'No eligible web search provider returned usable results' }`.

---

## 5. Config and secret shapes

### 5.1 Config field shapes

`WebSearchProviderConfig` — canonical definition in Omnicross
`packages/contracts/src/websearch-types.ts` lines 27–40, re-exported to Elftia:

| field | type | note |
| --- | --- | --- |
| `id` | `WebSearchProviderId` | required |
| `enabled` | `boolean` | required |
| `apiKey` | `string?` | comma-separated list supported → round-robin rotation |
| `apiHost` | `string?` | custom API host; the *only* configuration signal for `searxng` |
| `basicAuthUsername` | `string?` | SearXNG basic auth |
| `basicAuthPassword` | `string?` | SearXNG basic auth |

`HttpWebSearchProviderConfig` — `web-search-orchestration.ts` lines 41–44 — is deliberately
credential-free: `{ id: HttpWebSearchProviderId; enabled: boolean }`. `configureProvider`
stores only those two fields for HTTP ids and returns early
(`WebSearchService.ts` lines 108–111).

`WebSearchOptions` (`websearch-types.ts` lines 67–76): `maxResults?`, `timeout?`,
`signal?`, `fetchPageContent?`.

`ApiKeyRotator` (`ApiKeyRotator.ts`): in-memory round-robin over a comma-separated key
string, one instance per provider instance; index resets on process restart; a single key
is returned as-is; empty/whitespace yields `''` so the provider raises its own
"API key required" downstream.

### 5.2 Secret-ref scheme

From `searchSecretRefs.ts`:

- Prefix constant `SEARCH_SECRET_REF_PREFIX = 'search-provider:'`.
- Ref builder `searchApiKeyRef(id)` → `` `search-provider:<id>:apiKey` `` — the only place
  the namespace string is constructed.
- `SEARCH_PROVIDERS_WITH_KEY = ['tavily', 'jina', 'zhipu', 'z.ai', 'grok', 'exa', 'bocha', 'searxng']`.
  `searxng` is key-*optional* but included so a key can still be stored; `local-*` are
  absent (keyless browser automation); `z.ai` and `zhipu` each round-trip to their own ref
  with no implicit aliasing.
- `isKeyedSearchProvider(id)` is the predicate used both for hydration and for the
  orchestrator's `configured` test.

Hydration rules (`WebSearchService.configureProvider` / `resolveProviderKey`,
lines 105–174):

- Any inbound `config.apiKey` from the renderer is **discarded**; the key is resolved
  exclusively from `secrets.getSecret(searchApiKeyRef(id))`, main-process side.
- Secret-store failure degrades to `undefined` (unconfigured) and never throws.
- The resolved key lives only in the in-memory `providerConfigs` map.
- Idempotence: a repeat `configureProvider` with a structurally identical fully-resolved
  config (`sameProviderConfig`, lines 145–157, compares `id`/`enabled`/`apiKey`/`apiHost`/
  `basicAuthUsername`/`basicAuthPassword`) is a no-op, collapsing the renderer's duplicate
  boot-time pushes.
- Configuring `jina` also pushes the hydrated key into `JinaReader.setApiKey`.

Masked vs unmasked reads:

| accessor | returns | consumer |
| --- | --- | --- |
| `getProviderConfig(id)` | config **without** `apiKey` | plugin port (`searchConfigHostAdapter`) and internal reconfigure reads — plugins must never see a search key |
| `getProviderConfigWithKey(id)` | config **with** resolved `apiKey` | host renderer settings panel only (password-dots + eye reveal) |

---

## 6. Response, error, and validation shapes

### 6.1 Response types

`WebSearchResult` = `{ title: string; content: string; url: string }`
(`websearch-types.ts` lines 43–50).

`WebSearchResponse` = `{ success: boolean; query: string; results: WebSearchResult[]; provider?: WebSearchProviderId; error?: string }`
(lines 53–64).

`OrchestratedWebSearchResponse` (`web-search-orchestration.ts` lines 68–73) extends
`WebSearchResponse` minus `provider`/`results`, adding
`results: WebSearchResult[]`, `providerUsed?: WebSearchExecutionProviderId`, and
`attempts: WebSearchAttempt[]`.

`WebSearchAttempt` = `{ provider: WebSearchExecutionProviderId | 'native'; outcome: WebSearchAttemptOutcome; reason?: string }`.

`WebSearchAttemptOutcome` = `'ineligible' | 'failed' | 'empty' | 'invalid' | 'success'`
(line 38).

`WebSearchProviderDescriptor` = `{ id; kind; enabled; configured; available; eligible; reason? }`
with `WebSearchTransportKind = 'api' | 'http' | 'local-browser' | 'native'` (lines 37, 51–59).

### 6.2 Literal error strings (comparison oracles)

These exact strings are what 阶段5's behavior-comparison matrix must reproduce or
deliberately supersede.

From `WebSearchService.search()`:

| condition | string |
| --- | --- |
| local id with `config.enabled === false` | `Provider ${providerId} is disabled` |
| non-local id with no stored config | `Provider ${providerId} not configured` |
| non-local id with `enabled === false` | `Provider ${providerId} is disabled` |
| registry miss (declared-but-dead) | `Provider ${providerId} not implemented` |
| thrown non-`Error` | `Unknown error` |

From `WebSearchOrchestrator`:

| condition | string |
| --- | --- |
| ineligible with no descriptor reason | `Provider is not eligible in the host runtime` |
| non-HTTP provider threw | `Provider request failed` |
| missing HTTP transport (thrown) | `HTTP search transport is unavailable` |
| all candidates exhausted (`error` field) | `No eligible web search provider returned usable results` |
| `validateResponse`: non-object | `Provider returned an invalid response` |
| `validateResponse`: `success !== true` | `Provider returned an error` |
| `validateResponse`: `results` not an array | `Provider returned an invalid result list` |
| `validateResponse`: zero results | `Provider returned no results` |
| `validateResponse`: duplicate-only | `Provider returned only duplicate results` |
| `validateResponse`: nothing usable | `Provider returned no usable direct results` |

From `HttpOnlyWebSearchService` (the second, host-neutral implementation):

| condition | string |
| --- | --- |
| non-HTTP id passed to `search()` | `Provider ${provider} is unavailable in this host` |
| disabled | `Provider ${provider} is disabled` |
| non-HTTP explicit selection | `Provider is unavailable in this host; only keyless HTTP search is supported` |
| all candidates exhausted | `No keyless HTTP search provider returned usable results` |

From `webFetchSearch.searchWebViaFetch` — the `error` field is always
`` `${engine.id}: ${message}` `` where `engine.id` is `bing` or `duckduckgo`, and the
message is one of:

- `response contained no result entries` (also the initial `lastError` seed);
- `server returned a bot-challenge response (HTTP 202)` — DuckDuckGo only, raised when
  `resource.status === 202`;
- a trust error from `searchPageTrustError`:
  - `Bing returned an untrusted search result page with zero query-term hits in result titles; refusing to return possible bot-decoy content.`
  - `Bing returned an untrusted search result page; refusing to return possible bot-decoy content.`
  - `Google returned a JavaScript-only search shell without result entries.`
- or the underlying transport error message.

### 6.3 Result validation (`validateResponse`, `WebSearchOrchestrator.ts` lines 248–298)

In order:

1. Non-object response → `invalid`.
2. `success !== true` → `failed`. The reason is `sanitizeHttpFailureReason(candidate.error)`
   **only for HTTP providers** (`preserveHttpFailureReason`); every other provider gets the
   fixed `Provider returned an error`, so an API provider's own error text never reaches
   the attempt record.
3. `results` not an array → `invalid`; empty array → `empty`.
4. Per item: `title` must be a non-empty trimmed string **and** `url` must satisfy
   `isDirectResultUrl`. Items failing either are skipped entirely (they do not count as
   "structurally usable").
5. Structurally-usable items are counted before dedupe; duplicates by exact trimmed URL
   are dropped; accumulation stops at `maxResults`.
6. **Duplicate-only invalidation:** if exactly one result survives while
   `structurallyUsableCount > 1`, the outcome is `invalid` with
   `Provider returned only duplicate results` — a SERP that collapses to a single repeated
   link is treated as a scrape failure, not a one-result answer.
7. Otherwise `success` with the collected results, or `invalid` /
   `Provider returned no usable direct results` when nothing survived.

`content` is normalised to `result.content.trim()` or `''`.

### 6.4 Direct-URL rule (`isDirectResultUrl`, lines 316–343)

Accepts only `http:`/`https:`. Rejects these SERP-redirect shapes (host match is exact or
suffix `.<domain>`):

| host | rejected pathnames |
| --- | --- |
| `google.com` | `/search`, `/goto` |
| `bing.com` | `/search` |
| `duckduckgo.com` | `/html/`, `/l/` |
| `baidu.com` | `/s` |

An unparseable URL is rejected. Note `HttpOnlyWebSearchService.isDirectHttpUrl`
(lines 173–180) implements *only* the protocol check — it has **no** SERP-redirect
rejection list. That divergence is catalogued in
[`duplicate-fallback-and-consumers.md`](./duplicate-fallback-and-consumers.md).

### 6.5 HTTP failure-reason sanitizer

Implemented identically (duplicated verbatim) in `WebSearchOrchestrator.ts` lines 300–314
and `HttpOnlyWebSearchService.ts` lines 182–196:

1. Coerce: `string` as-is → `Error.message` → fallback literal
   (`HTTP provider request failed` in the orchestrator,
   `HTTP search request failed` in the HTTP-only service — the two fallbacks differ).
2. `replace(/\b(?:https?|socks5?):\/\/\S+/gi, '[redacted URL]')` — strips URLs, including
   proxy URLs that could carry credentials.
3. `replace(/[\r\n\t]+/g, ' ')` then `replace(/\s+/g, ' ')` — collapse whitespace.
4. `trim()` then `slice(0, 300)` — hard 300-character cap.
5. Empty result falls back to the same literal as step 1.

### 6.6 HTTP result cleaning (`webFetchSearch.ts`)

- `cleanText`: `decodeHTML` → collapse whitespace → trim → **`slice(0, 500)`**.
- `isUsableResult`: non-empty `title` and `url` matching `/^https?:\/\//i`.
- `cleanBingUrl`: for `*.bing.com/ck/a`, take query param `u`, require an `a1` prefix,
  `base64url`-decode the remainder, and accept the result only if it matches
  `/^https?:\/\//i`; otherwise fall back to the absolute href.
- `cleanDuckDuckGoUrl`: protocol-relative `//…` is promoted to `https:`; the `uddg` query
  parameter is unwrapped when present, otherwise the absolute href is used.
- Bing result links: `li.b_algo h2 a, #b_results .b_algo h2 a`, falling back to
  `h2 a[href]` when that yields nothing.
- DDG html layout: containers `.result, .result--web, .web-result`, link
  `a.result__a, .result__a`, snippet `.result__snippet, .result__body`.
- DDG lite layout (used only when the html layout yields zero results):
  `a.result-link`, snippet from the **next** table row's `.result-snippet`.
- Bing anti-decoy trust check (`bingTrustError`): tokenise the query with
  `/[\p{L}\p{N}]{2,}/gu`, drop stop words
  (`a, an, and, at, by, for, from, in, of, on, or, the, to, with, site, filetype, inurl, intitle`),
  expand CJK terms into character bigrams; require at least one term hit across result
  titles, then require `terms.length === 1 ? 1 : 2` distinct terms covered across
  title + href + caption text. Failing either check refuses the page as possible bot decoy.

---

## 7. What Phase 1 deliberately does not carry over

Recorded here so later stages do not read an omission as a bug:

- `local-*` providers stay in Elftia (they need Electron `BrowserWindow`); Omnicross core
  must never import Elftia or Electron. They join later via explicit host contribution
  registration (extraction plan Phase 2).
- `grok` prompt-search and `ClaudeSearchProvider` are not registered in Phase 1.
- `claude`, `exa`, `bocha` remain declared-but-dead; Phase 1 must not silently "fix" them.
- The `id.startsWith('local-')` inference used by `describeProvider`,
  `WebSearchService.search`, `isProviderEnabled`, and the `isApiProvider`/`isLocalProvider`
  helpers in `websearch-types.ts` is replaced by explicit declarations in 阶段1 — it is
  recorded above as observed behavior only.
