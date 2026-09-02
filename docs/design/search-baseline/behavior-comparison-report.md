# Behavior comparison: Elftia old search vs Omnicross new search (frozen)

> **Frozen at the close of Phase 1 (plan 阶段5), 2026-09-02.** Point-in-time
> acceptance-gate artifact for
> [`omnicross-search-runtime-extraction-plan.md`](./../omnicross-search-runtime-extraction-plan.md).
> Companion to [`elftia-search-baseline.md`](./elftia-search-baseline.md),
> [`duplicate-fallback-and-consumers.md`](./duplicate-fallback-and-consumers.md),
> [`wire-baseline.md`](./wire-baseline.md) and
> [`phase1-release-state.md`](./phase1-release-state.md).

Plan 阶段5 requires "Elftia 旧实现与 Omnicross 新实现的行为对照报告，覆盖请求、结果、
错误、fallback 与取消". This is that report.

## 0. Rules this document follows

1. **Every row cites evidence.** Old behavior cites the 阶段0 baseline (file and
   section); new behavior cites a source file or a test.
2. **Three verdicts only.** `IDENTICAL`, `ALLOWED-DIVERGENCE` (with the recorded
   decision it came from), or `UNVERIFIED` (naming the missing evidence).
3. **The ALLOWED-DIVERGENCE set is closed.** It is exactly the eight decisions
   recorded across 阶段2–4; nothing was added here and nothing recorded was
   dropped. §3 lists them, §2 uses them, and §5 lists the things that are
   explicitly *not* divergences so they cannot be mistaken for omissions.
4. **The UNVERIFIED set is the wire ledger's, unchanged.** It is exactly the four
   surviving UNVERIFIED entries of `wire-baseline.md` §4 — two of which are the
   Codex request and response shapes.
5. **No claim of verified compatibility is made anywhere for an UNVERIFIED
   surface.** Golden fixtures in the test suite pin *Omnicross's own emissions*
   so they cannot change unnoticed; they are not evidence about a vendor.

## 1. Oracle re-verification (done before any citation below)

The 阶段0 manifest pinned the Elftia files this report reads as oracles. Elftia's
HEAD has moved since (unrelated work), so every oracle was re-hashed at
`6c6a03900596cb786d3befd620ea7db4ef18e420` **before** it was cited. Method:
`sha256sum` over raw working-tree bytes, as `elftia-search-baseline.md` §1
specifies.

| File (Elftia) | Manifest sha256 | Re-verified 2026-09-02 |
| --- | --- | --- |
| `.../capabilities/search/WebSearchOrchestrator.ts` | `07baab17…f4bc27` | **identical** |
| `.../capabilities/search/WebSearchService.ts` | `9f692b29…4008b0` | **identical** |
| `.../search/registry/WebSearchProviderRegistry.ts` | `f8925194…855a01` | **identical** |
| `.../search/registry/builtin-search-adapters.ts` | `bf0f01c1…8996b1`¹ | **identical** |
| `.../search/providers/TavilyProvider.ts` | `3134dcd7…a195a6` | **identical** |
| `.../search/providers/JinaProvider.ts` | `374d2252…2eee15` | **identical** |
| `.../search/providers/SearxngProvider.ts` | `c1ec6694…279374` | **identical** |
| `.../search/providers/ZhipuProvider.ts` | `2a9a0f5b…6118e5` | **identical** |
| `.../search/providers/types.ts` | `af63939f…4ee7d0` | **identical** |
| `.../tinyelf/tools/WebTools.ts` | `cd0b3030…c45c6` | **identical** |
| `.../tinyelf/tools/webFetchSearch.ts` | `2fa0275e…ab057` | **identical** |
| `.../tinyelf/tools/webFetchHttp.ts` | `5affcc1d…5715b0` | **identical** |
| `.../tinyelf/tools/HttpOnlyWebSearchService.ts` | `531440a5…a42f5c`¹ | **identical** |
| `.../tinyelf/tools/WebSearchServiceTool.ts` | `dbddf69b…ec0bd4` | **identical** |

¹ Truncated for readability; the full values are in `elftia-search-baseline.md` §2
and were compared in full.

**No drift.** One additional oracle is used by §2.6 and is *not* in the 阶段0
manifest, so it is pinned fresh here:
`packages/desktop/app/main/services/agent-core/agent/proxy/proxySearchIntercept.ts`
= `f5023ca1809da8b6d7785a98e6528a3a5a5314eeeb3005290b7cf8feaf7c50a5` (149 lines,
identical to Elftia HEAD).

**Baseline erratum carried forward** (recorded by the contracts reviewer, not
corrected in the frozen 阶段0 doc): `elftia-search-baseline.md` §6.2 lists the
Google JS-shell trust string under `webFetchSearch`'s "always `${engine.id}:`"
rule, but engine ids are only `bing|duckduckgo`, so a `google:` prefix cannot
occur; the production form is `Fetch error: <message>` via `WebTools.ts:158-159`.
This report cites the corrected form.

## 2. The comparison matrix

Dimensions: **requests**, **results**, **errors**, **fallback**, **cancellation**.
Surfaces: the orchestrated search runtime, the HTTP providers, the API providers,
the three protocol frontends, and the legacy port compat path.

### 2.1 Orchestrated search (Elftia `WebSearchOrchestrator` → Omnicross `SearchRuntime`)

| Dimension | Old (Elftia) | New (Omnicross) | Verdict |
| --- | --- | --- | --- |
| Requests | `searchWithFallback(query, selection, { maxResults, timeout, signal })`; candidate order = registry registration order (baseline §3, §4.1) | `SearchRuntime.search({ query, provider?, options })`; candidate order = registry order, one implementation (`search/orchestrator.ts`; `search/__tests__/orchestrator.test.ts`) | IDENTICAL |
| Requests — explicit provider | explicit selection may still fall through to other providers (baseline §4.1) | `request.provider` PINS strictly; the soft form is `policy.preferred` (`orchestrator.ts` `planCandidates`) | IDENTICAL *in reachable behavior* — the soft semantics are preserved under `policy.preferred`, which is what the compat path uses |
| Results | `{title, url, content}` items, deduped by exact trimmed URL, capped at `maxResults` (baseline §6.3) | same fields, same dedupe, same cap (`search/normalize.ts`; `normalize.test.ts`) | IDENTICAL |
| Results — none found | `empty` outcome → attempt fails → walk continues; exhaustion string `No eligible web search provider returned usable results` (baseline §6.2) | an empty `SearchResult[]` is a SUCCESS and ends the walk | **ALLOWED-DIVERGENCE** — D1 |
| Results — all filtered | `invalid` + `Provider returned no usable direct results`; walk continues (baseline §6.2/§6.3) | normalization filters but never fails; a fully filtered set is a success with `results: []` | **ALLOWED-DIVERGENCE** — D7 |
| Results — `maxResults` unset/NaN | `slice(0, NaN)` yields `[]` | non-finite `maxResults` maps to the documented default 5 (`normalize.ts` `normalizedResultLimit`) | **ALLOWED-DIVERGENCE** — D8 |
| Errors | free-text strings (baseline §6.2) | closed 8-code taxonomy + pre-sanitized message (`@omnicross/contracts/search-types`); the legacy strings are reproduced by `search-compat` for legacy callers | IDENTICAL *for legacy callers*, superseded for new ones — the total string→code mapping is `contracts/src/search-compat.ts`, tested row-by-row |
| Errors — single attempt | last failure's reason | the provider's OWN error object is rethrown, preserving `stage`/status details | IDENTICAL in classification, strictly richer in detail |
| Fallback | one order, three implementations (baseline `duplicate-fallback-and-consumers.md` §1) | ONE implementation; `BuiltinToolExecutor` delegates (`completion/BuiltinToolExecutor.ts`) | IDENTICAL behavior, duplication removed — the plan's §14 acceptance item |
| Cancellation | `signal` passed to providers; a non-conforming provider could leak `AbortError` | `options.signal.aborted` is the AUTHORITY on the failure path: an aborted walk ends as `cancelled` and sends nothing further (`orchestrator.test.ts`) | IDENTICAL intent, hardened — no query egress after cancellation |

### 2.2 HTTP providers (Bing, DuckDuckGo)

| Dimension | Old (Elftia `webFetchSearch`) | New (`@omnicross/core/search/http`) | Verdict |
| --- | --- | --- | --- |
| Requests | 15 s / 2 MiB search budget over a 30 s / 5 MiB transport, `MAX_REDIRECTS = 5`, Chrome browser header profile (baseline §5) | same budgets, same cap, same header profile (`search/http/transport.ts`, `headers.ts`) | IDENTICAL |
| Requests — User-Agent | Chrome version inherited from Electron | pinned at `144.0.0.0`, because plain Node has no `process.versions.chrome` and sniffing would silently change the fixture-captured profile per host | **ALLOWED-DIVERGENCE** — D3 |
| Results | selector-based parse of the SERP; `isDirectResultUrl` pathname match is EXACT | same parsers, same exact pathname matching (`search/http/parsers/`, fixture suite) | IDENTICAL |
| Errors — challenge | `server returned a bot-challenge response (HTTP 202)` | `upstream_unavailable` with `stage: 'challenge'`; the legacy string is reproduced by `search-compat` | IDENTICAL (classification preserved) |
| Errors — anti-decoy | Bing trust strings (baseline §6.2), computed from `q` on the FINAL url | same check, same source of `q` | IDENTICAL |
| Errors — empty page | `response contained no result entries` for BOTH empty and drift | recognized-empty → `[]` (a success); unrecognized → `parse_failed`. The three-way distinction the plan asks for | **ALLOWED-DIVERGENCE** — D1 |
| Errors — oversize body | stops reading and parses the truncated fragment, yielding a plausible partial result set no caller can distinguish from a real one | throws `upstream_unavailable` with `stage: 'body-cap'` | **ALLOWED-DIVERGENCE** — D2 |
| Fallback | per-engine candidate URL walk (html → lite for DDG) | same walk; a recognized-empty page does not kill it — `[]` is returned only after the walk ends | IDENTICAL |
| Cancellation | `signal` honored by the fetch layer | same | IDENTICAL |

### 2.3 API providers (Tavily, Jina, SearXNG, Zhipu, Z.AI)

| Dimension | Old (Elftia providers) | New (`@omnicross/core/search/api`) | Verdict |
| --- | --- | --- | --- |
| Requests — endpoints/bodies | per-adapter, recorded in the api-providers change design | ported unchanged (`search/api/*Provider.ts`, per-adapter fixture tests) | IDENTICAL |
| Requests — redirects | `redirect: 'follow'` (browser default) | manual walk, cap 5, per-hop egress validation; fetch-standard method/body handling (303 and POST+301/302 → GET, 307/308 preserved) | **ALLOWED-DIVERGENCE** — D4 |
| Requests — credentials on redirect | undici strips `Authorization`/`Cookie`/`Proxy-Authorization` on an origin change | the manual walk does the same, permanently for the rest of the walk (`search/api/transport.ts`) | IDENTICAL — see §5.1 |
| Requests — key placement | Tavily sends its key in the request BODY | unchanged; echoed-error redaction covers both the plain and backslash-escaped JSON forms | IDENTICAL, with redaction added |
| Results | per-adapter mapping (`link`→url for Zhipu, `content \|\| description` for Jina) | identical mappings | IDENTICAL |
| Results — default count | 5 everywhere except Zhipu's 10 | same defaults | IDENTICAL |
| Results — declared cap | n/a (no capability surface) | `capabilities.maxResults` deliberately UNSET on all four: a DEFAULT is not a CAP, and declaring one would be a false capability | **ALLOWED-DIVERGENCE** — D6 |
| Errors — missing result array | `data.results \|\| []` turns a changed response shape into an empty-but-successful search | the array is REQUIRED; its absence is `parse_failed`. A present-but-empty array is still a success | **ALLOWED-DIVERGENCE** — D5 |
| Errors — oversize body | truncated parse | throws (`stage: 'body-cap'`) | **ALLOWED-DIVERGENCE** — D2 |
| Errors — SSRF | none (custom `apiHost` unchecked) | `validateEgressUrl` + connect-time DNS validation on direct connections; denial is `policy_denied`, restamped by the transport that raised it | new capability, no old behavior to diverge from |
| Fallback | orchestrator-owned | orchestrator-owned | IDENTICAL |
| Cancellation | `signal` → adapter | same; an abort maps to `cancelled` | IDENTICAL |

### 2.4 Codex `POST /v1/alpha/search`

| Dimension | Old | New | Verdict |
| --- | --- | --- | --- |
| Requests — routing | Omnicross answered the generic `404 Unsupported: POST /v1/alpha/search` to all 11 recorded requests (`wire-baseline.md` C1/C2) | detected before the 404 fallthrough; default mode `off` answers a structured 4xx `unsupported_capability`, never the bare 404 (plan §15). Other unknown routes keep the generic 404 | **DELIBERATE VISIBLE CHANGE** — the one default-behavior change in this phase (`outbound-api/searchRoute.ts`; `__tests__/outboundApiSearchDispatch.test.ts`) |
| Requests — body schema | — | **UNVERIFIED** (`wire-baseline.md` §1.2): the captured bodies were dropped for lack of a `sessionKey` and cannot be recovered. Parsing accepts a JSON object carrying a non-empty `query` / `q` / `search_query`, rejects everything else with a structured error, and interprets no other field | **UNVERIFIED** — U1 |
| Results / response schema | — | **UNVERIFIED** (`wire-baseline.md` §1.3): no upstream ever answered one of these requests. Omnicross emits its own documented `{ object: 'omnicross.search.results', query, provider, results[] }`, golden-pinned as ours | **UNVERIFIED** — U2 |
| Errors | generic 404 | search taxonomy → HTTP (`rate_limited`→429, `timeout`→504, `cancelled`→499, `config_missing`→503, everything else→502), always a structured JSON body | new, structured |
| Fallback | — | runtime-owned; the route builds no candidate list | IDENTICAL to every other surface |
| Cancellation | — | the router builds a request-lifecycle abort signal (`pipeline/requestLifecycleSignal.ts`) and threads it into the runtime search, so a client disconnect stops the fallback walk instead of sending the query onward. `handleOutboundRequest` inherits no signal, so a router-level handler that executes must construct one | new |
| **Evidence path** | bodies unrecoverable | a dispatched request now reaches route resolution and is assigned a `sessionKey`, so `AuditWriter.appendBody` will persist the body — the 阶段0 capture gap, closed (asserted in `outboundApiSearchDispatch.test.ts`). **This is how U1 and U2 become verifiable.** | — |

### 2.5 OpenAI Responses `web_search`

| Dimension | Old | New | Verdict |
| --- | --- | --- | --- |
| Requests — native (DEFAULT) | `NativeSearchInjector` builds the declaration; the relay forwards it (`wire-baseline.md` R1–R7) | unchanged; the hosted declaration reaches the upstream unrewritten and the injector is untouched (`ProviderProxy.searchFrontends.test.ts`) | IDENTICAL |
| Requests — managed (opt-in) | — | the hosted declaration is replaced with a function-tool selector and the upstream turn is forced non-streaming; every other field passes through | new mode |
| Results — native | upstream `web_search_call` items relayed verbatim | unchanged | IDENTICAL |
| Results — managed | — | Omnicross emits its own `web_search_call` item (`status`, `action.type='search'`, `provider`, `results[]`) plus a `message` item carrying the findings. **The live upstream sequence is UNVERIFIED** (zero `web_search_call` payloads in 444 shards) | **UNVERIFIED** — U3 |
| Errors — managed | — | a failed search becomes a `web_search_call` with `status: 'failed'` and the taxonomy code; mode `off` is a structured `unsupported_capability` | new, structured |
| Fallback | — | runtime-owned; one runtime search per hosted call, no frontend-side fallback | IDENTICAL to every other surface |
| Cancellation — managed | — | the request's abort signal reaches the runtime | new |
| Mode mixing | — | impossible by construction: the mode is resolved once per request and the lanes share no emission code; spied both directions | — |

### 2.6 Anthropic Messages `web_search_*`

Old behavior here is Elftia's `proxySearchIntercept.ts` (re-pinned in §1).

| Dimension | Old (Elftia) | New (Omnicross managed) | Verdict |
| --- | --- | --- | --- |
| Requests — native (DEFAULT) | BYO tool passthrough byte-for-byte (`wire-baseline.md` A6) | unchanged; managed mode is a pure short-circuit that never runs in `native` (`ProviderProxy.searchFrontends.test.ts`) | IDENTICAL |
| Requests — interception rule | search-only sub-request: every tool is a search tool AND (`tool_choice` forces `web_search` OR exactly one tool) (A7) | ported unchanged, including the `web_search_` PREFIX rule so a new tool version is data, not a branch (A2) | IDENTICAL |
| Requests — query extraction | strip the SDK's `search for the query:` prefix, else the last user message | same rule, with two micro-edges — see §5.5 | IDENTICAL on the rule; §5.5 notes the edges |
| Requests — result count | `searchWithFallback(query, 'auto', { maxResults: 5 })` (A10) | `runtime.search({ query, options: { maxResults: 5 } })` | IDENTICAL |
| Results — item fields | `{ type: 'web_search_result', url, title, encrypted_content, page_age: null }` (A9) | the same four fields, exactly — and they are the fields the REAL upstream carries (§3.3 VERIFIED) | IDENTICAL |
| Results — `encrypted_content` | the plain snippet | the plain snippet | IDENTICAL (upstream's is opaque provider data; both synthesize the snippet) |
| Results — block inventory | `web_search_tool_result` + a `text` summary; NO `server_tool_use` | `server_tool_use` + `web_search_tool_result` + the same `text` summary | see §5.2 — a wire-fidelity note, not a divergence |
| Results — provenance | `Provider used: <id>` inside the text block, and `model: local-search-proxy/<id>` | `Provider used: <id>` inside the same text block, verbatim; `model` echoes the request's model | see §5.3 |
| Errors | throws `All search providers failed (a:outcome -> b:outcome)` | the Anthropic error envelope with the taxonomy code and the runtime's own sanitized message; status per the shared mapping | superseded, structured — the old string had no protocol envelope at all |
| Fallback | host orchestrator | the shared runtime | IDENTICAL |
| Cancellation | none (no signal threaded) | the client's disconnect aborts the search; nothing is written after an abort | new, strictly better |
| Streaming | not supported (JSON only) | SSE synthesis following the VERIFIED block ordering; everything after the `web_search_tool_result` `content_block_start` is our documented tail | **UNVERIFIED** — U4 |

### 2.7 Legacy port compat path (`WebSearchBackend`)

| Dimension | Old | New | Verdict |
| --- | --- | --- | --- |
| Surface | `packages/core/src/ports/web-search-backend.ts`, consumed by Elftia | **byte-identical**; the export path still resolves under the core export guard | IDENTICAL |
| Implementation | host-supplied only; the Anthropic `webSearchService` hint slot carried `null` in core | `searchRuntimeAsWebSearchBackend` fills the slot when the route supplies no backend — the adapter's first production consumer. A route-supplied backend still wins | IDENTICAL contract, slot no longer dead |
| Results / errors | legacy `{success, query, results, provider?, error?}` | produced by `search-compat`'s single tested mapping, not re-derived | IDENTICAL |
| Provider selection | caller names a provider | `search` PINS it; a legacy caller naming a provider gets that provider or a failure, never a silent substitute | IDENTICAL to the legacy contract's plain reading |

## 3. The ALLOWED-DIVERGENCE set (closed — exactly eight)

| # | Divergence | Why it was accepted | Recorded by |
| --- | --- | --- | --- |
| D1 | **Recognized-empty → `[]` (a success)** instead of an error; and an empty success ends the fallback walk | The plan requires distinguishing "found nothing" from "could not look"; conflating them is what the extraction removes. Deferred within a multi-candidate engine so DDG's html→lite walk survives | 阶段2 planner + implementer; 阶段3 planner; reviewer-binding note on 阶段3 |
| D2 | **Body-cap overflow THROWS** (`upstream_unavailable`, `stage: 'body-cap'`) | Elftia parses the truncated fragment, producing a plausible partial result set no caller can distinguish from a complete one | 阶段2 implementer (HTTP); 阶段4 implementer (API) |
| D3 | **Chrome UA pinned at `144.0.0.0`** | Elftia inherits a real Chromium version from Electron; core runs in plain Node where `process.versions.chrome` is absent, so sniffing would silently change the fixture-captured header profile per host | 阶段2 implementer |
| D4 | **Manual redirect walk (cap 5) with fetch-standard method/body handling** replacing `redirect: 'follow'` | Per-hop egress validation is impossible otherwise. Method/body handling follows the fetch standard so observable behavior otherwise matches | 阶段4 planner + implementer |
| D5 | **API adapters REQUIRE their result array** (absence → `parse_failed`) | `data.results \|\| []` turned a changed upstream shape into an empty-but-successful search, re-conflating exactly what D1 separates. A present-but-empty array is still a success | 阶段4 implementer |
| D6 | **`capabilities.maxResults` UNSET on all four API adapters** | The contract defines that field as a cap the provider IMPOSES. 5 and 10 are DEFAULTS applied when the caller asks for nothing; declaring a default as a cap would be a false capability | 阶段4 implementer |
| D7 | **A fully filtered result set is a success with `results: []`**, not `invalid` | The PROVIDER's raw resolution decides the walk. Re-introducing the failure would hand the fallback policy a third outcome and undo D1 | 阶段3 implementer |
| D8 | **Non-finite `maxResults` maps to the default 5** | Closes the `slice(0, NaN)` → `[]` hole 阶段2 deliberately left for the runtime that owns option handling | 阶段3 implementer |

No other divergence exists, and no recorded divergence is missing. §5 covers the
items that look like candidates but are not.

## 4. The UNVERIFIED set (the wire ledger's, unchanged)

| # | Surface | What is unknown | Evidence that would settle it |
| --- | --- | --- | --- |
| U1 | Codex `/v1/alpha/search` | request body schema | a captured exchange that reaches route resolution — now possible, because the route assigns a `sessionKey` (§2.4) |
| U2 | Codex `/v1/alpha/search` | response schema and error semantics | one non-404 exchange against an upstream that implements the endpoint; `codex-full-protocol-relay-requirements.md` §7.2 is the standing capture-first mandate |
| U3 | Responses `web_search` | the live upstream event sequence and output-item fields | one live Responses exchange in which a hosted `web_search` actually runs, captured with bodies enabled |
| U4 | Anthropic `web_search_*` | the stream TAIL (`content_block_stop` / `message_delta` / `message_stop`) and error shapes | one hosted-search exchange captured with a raised `maxBodyBytes`; all four existing captures truncate at ~8 KB |

Omnicross's managed emissions on U2, U3 and U4 are documented best-effort and are
pinned by golden fixtures **labeled as Omnicross's own emission**. No test name,
comment, or document sentence in this change claims verified vendor
compatibility for any of them.

## 5. Resolved notes — things that are NOT divergences

### 5.1 Cross-origin credential forwarding (RESOLVED)

An earlier draft of the api-providers change forwarded `Authorization` /
`Cookie` / `Proxy-Authorization` across a redirect origin change, which
`redirect: 'follow'` would not have done. That was fixed in review round 1: the
manual walk now strips them permanently on any origin change (port included).
There is no header-forwarding divergence left to record.

### 5.2 The synthesized `server_tool_use` block (wire fidelity, not divergence)

Elftia's synthetic Anthropic response contains a `web_search_tool_result` block
with no preceding `server_tool_use`. The real upstream stream always has one
(`wire-baseline.md` §3.3, VERIFIED across four captures), and `sse-parser.ts`
binds a result block to *the last `server_tool_use` id* (A4) — so omitting it
leaves that linkage dangling. Omnicross synthesizes both blocks, which moves the
emission TOWARD the verified upstream shape rather than away from Elftia's
semantics: the result items, their fields, the summary text and the provenance
line are identical. Asserted in
`provider-proxy/ingress/__tests__/anthropicManagedSearch.test.ts`.

### 5.3 The `model` field on the synthesized Anthropic message (wire fidelity)

Elftia sets `model: 'local-search-proxy/<providerUsed>'`; Omnicross echoes the
request's model, which is what the real wire carries. Provenance is not lost:
both put `Provider used: <id>` in the text block, and that line is byte-identical.

### 5.4 Managed Responses ends the turn with the search report

The managed Responses lane emits the `web_search_call` item plus a `message`
item carrying the findings, and does not produce the model's own prose answer in
the same turn — the client's next turn sees the results in its `input`. This is
the hosted-image mediator's receipt pattern applied to text. It has no Elftia
counterpart (Elftia has no Responses search lane at all), the mode is opt-in and
off by default, and the surface it would be compared against is U3 — UNVERIFIED.
It is therefore recorded here rather than as a divergence from a known behavior.

### 5.5 Two micro-edges in Anthropic query extraction

Against the re-hashed reference (`proxySearchIntercept.ts`, `f5023ca1…`):

- **Multi-line queries.** Elftia's prefix regex is `(.*)`, which stops at a
  newline, so a query spanning lines keeps only its first line. Omnicross uses
  `([\s\S]*)` and keeps the whole tail.
- **No query found.** Elftia falls back to searching the literal string
  `'search'`. Omnicross answers a structured 400 naming what was missing.

Both Omnicross behaviors are strictly more useful and neither is a recorded
divergence: the first is a bug-compatible detail nobody relies on, and the
second replaces an accidental search for a meaningless word with an error the
caller can act on. Noted here rather than as a ninth divergence row, per this
report's own closure rule.

### 5.6 The Codex route is gated by MODE, not by key permission

`POST /v1/alpha/search` checks no `allowedEndpoints` entry, unlike the Images
operations. Search is not one of the four text endpoints, and adding a fifth
permission value would ripple through the key schema, the admin surface and
every stored key — for a capability that is `off` by default and turned on
process-wide by an operator editing config. The mode is therefore the gate. This
is a recorded decision, not an oversight; per-key gating becomes worth its cost
if managed search ever ships on by default.

### 5.7 One Responses request cannot combine managed search with hosted images

Both are body-rewriting mediators that prepare from the original request, so
running them together would send one rewrite upstream and silently drop the
other's. The combination is refused with a structured 422
`unsupported_capability` rather than composed: managed search forces the
upstream turn non-streaming, which is not a shape the image lane's SSE path was
built for, and the Responses hosted-search wire is UNVERIFIED, so a composed
rewrite could not be validated against anything. Each lane alone is unaffected.

### 5.8 Open items deliberately NOT closed in Phase 1

- **RFC 6598 shared address space (`100.64.0.0/10`)** is not denied by the egress
  policy — `http://100.100.100.200/latest/meta-data` (Alibaba Cloud metadata)
  passes. Named in the api-providers design under "Future hardening"; a
  cross-provider egress-hardening pass owns it. **It is not closed.**
- **The `readUrl` / `web_fetch` boundary** (plan §16) survives Phase 1 by design.
- **Grok and Claude** stay unregistered (plan hard constraint 5); **Exa** and
  **Bocha** have no Elftia adapter to port.
