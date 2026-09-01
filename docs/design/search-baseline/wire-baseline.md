# Protocol wire baseline for search surfaces (frozen)

> **Frozen as of 2026-09-01.** Point-in-time record for Phase 1 阶段0 of
> [`omnicross-search-runtime-extraction-plan.md`](./../omnicross-search-runtime-extraction-plan.md).
> Companion to [`elftia-search-baseline.md`](./elftia-search-baseline.md) and
> [`duplicate-fallback-and-consumers.md`](./duplicate-fallback-and-consumers.md).

Covers the three protocol surfaces on which search crosses the wire: Codex
`POST /v1/alpha/search`, OpenAI Responses `web_search`, and Anthropic Messages
`web_search_*`.

**Rules this document follows.**

1. Every statement carries an evidence ledger entry: **VERIFIED** with its concrete source,
   or **UNVERIFIED** naming the exact capture that would settle it.
2. **No schema is inferred from an endpoint or tool name.** An UNVERIFIED entry is an
   acceptable — and here, a correct — final state for 阶段0. `docs/design/codex-full-protocol-relay-requirements.md` §7.2
   states the same rule for the Codex search endpoint: the protocol MUST be locked by a
   reproducible capture or golden fixture before implementation, and a `/search` route must
   not be guessed from its name.
3. Everything derived from the local audit store is reduced to **schema level** — field
   names, types, enum values, event names and ordering. No prompts, no queries, no keys, no
   account identifiers. The outbound key id observed on the Codex records is written here as
   `<key-id>`.

## Evidence sources

| Source | What it is |
| --- | --- |
| Local audit store | `%APPDATA%\io.github.dumoedss.omnicross\audit` — READ-ONLY evidence. 7 retained day directories (`audit-2026-08-26` … `audit-2026-09-01`), 150 357 metadata records, 444 body shards. |
| Omnicross source | `packages/core/src/completion/NativeSearchInjector.ts`, `packages/core/src/sse-parser.ts`, `packages/core/src/transformer/transformers/AnthropicToolHandling.ts`, `packages/core/src/provider-proxy/responses/hosted-image/nativeResponsesImageSelection.ts`, `packages/contracts/src/provider-presets/defaults.ts`, `packages/daemon/src/audit/**` |
| Elftia source (read-only) | `packages/desktop/app/main/services/agent-core/agent/proxy/proxySearchIntercept.ts` |
| Design doc | `docs/design/codex-full-protocol-relay-requirements.md` |

### Audit-store layout (VERIFIED — `packages/daemon/src/audit/AuditWriter.ts`, `auditBodyReader.ts`, and the on-disk store)

```
audit/audit-YYYY-MM-DD/
  meta.jsonl            one JSON line per request, NO bodies
  meta.stats.json       sidecar counters
  bodies/<sessionKey>.jsonl[.gz]   captured bodies, sharded per conversation
```

Body shard lines are `{ id, ts, req?, res? }`. `req` is a delta
`{ base: string|null, anchor?, cont?, pre: number, suf: number, ins: string }` reconstructed
as `next = prev.slice(0, pre) + ins + prev.slice(prev.length - suf)`, walking `base` links
back to a snapshot (`base: null`). Shards are gzipped when the day rolls over.

---

## 1. Codex `POST /v1/alpha/search`

### 1.1 What is verified

| # | Statement | Evidence |
| --- | --- | --- |
| C1 | The Codex TUI issues `POST /v1/alpha/search` against the Omnicross outbound gateway. | **VERIFIED** — 11 metadata records with `"method":"POST"`, `"path":"/v1/alpha/search"`. |
| C2 | Omnicross answers **404** to every one of them. | **VERIFIED** — `"status":404` on all 11. |
| C3 | The 11 records span two days: 4 in `audit-2026-08-31`, 7 in `audit-2026-09-01`. | **VERIFIED** — per-day count over `meta.jsonl`. |
| C4 | Two client versions are represented: `codex-tui/0.152.0 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.152.0)` (4 records) and `codex-tui/0.151.0 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.151.0)` (7 records). | **VERIFIED** — `ua` field. |
| C5 | Every request carried a body (`hasBody: true`) and came from a loopback client address; latencies were 7–22 ms; all 11 authenticated under the same outbound key id `<key-id>`. | **VERIFIED** — `hasBody`, `ip`, `latencyMs`, `keyId` fields. |
| C6 | The 11 records carry **only** `id, ts, method, path, status, latencyMs, keyId, ip, ua, hasBody`. They have **no `sessionKey`, `model`, or `provider`** — the request 404s before route resolution assigns any of them. | **VERIFIED** — key-set comparison: 148 903 of the store's 150 357 records carry `sessionKey`/`model`/`provider`; none of these 11 do. |

### 1.2 Request schema — UNVERIFIED

**Status: UNVERIFIED. The captured request bodies do not exist on disk and cannot be
recovered.**

This is not rotation, gzip, or a format problem — the mechanism is exact and code-cited:

- `hasBody: true` only means the audit record carried a body at capture time
  (`packages/core/src/outbound-api/auditCapture.ts` line 235;
  `packages/contracts/src/audit-types.ts` line 44 — *"True when a body snapshot for this
  record exists in the session body store"*).
- `AuditWriter.appendBody` (`packages/daemon/src/audit/AuditWriter.ts` lines 129–137)
  **drops the body** when `record.sessionKey` is missing or unsafe, logging
  `dropping audit body with no usable session key`, while the metadata line still lands.
  The two writes are independent by design.
- These 11 records have no `sessionKey` (C6), so no shard line was ever written for them.
- Confirmed exhaustively: scanning **all 444 body shards across all 7 retained day
  directories** for a shard entry whose `id` equals any of the 11 record ids returns
  **zero** matches.

**Missing evidence:** a captured `POST /v1/alpha/search` exchange whose record reaches
route resolution (so a `sessionKey` is assigned and the body persists) — in practice, one
relayed to an upstream that actually implements the endpoint. Until then the request body
schema is unknown, and per rule 2 it is **not** reconstructed from the endpoint name or from
the plan document's prose.

### 1.3 Response schema — UNVERIFIED

**Status: UNVERIFIED, and unverifiable from this environment.** All 11 recorded exchanges
are 404s produced by Omnicross itself; no upstream ever answered, so no successful response
shape exists anywhere in the store.

`docs/design/codex-full-protocol-relay-requirements.md` §7.2 records the surrounding facts:
the public Codex documentation does not publish a complete wire schema for the standalone
search endpoint; the change that implements it MUST first lock the protocol with a
repeatable capture / golden fixture against the current Codex version; and the provider
capability `supports_standalone_web_search` is **off by default and still an in-development
capability** (§2.1). §7.2 additionally requires, before the capability may be advertised,
that endpoint/request-schema/response-item/error semantics be verified against the current
Codex version, that live/indexed modes and allowed-domains actually work rather than being
ignored, that web results be treated as untrusted input with citation fields preserved, and
that workspace/managed restrictions still apply.

**Missing evidence:** one non-404 `/v1/alpha/search` exchange against a real upstream,
captured end to end. Owner: the protocol-frontends change (阶段5).

---

## 2. OpenAI Responses `web_search`

### 2.1 What Omnicross verifiably does today

All statements cite the constructing source file, never vendor documentation from memory.

| # | Statement | Evidence |
| --- | --- | --- |
| R1 | For OpenAI Chat-Completions search-preview models, native search is injected as the **body field** `web_search_options: { search_context_size }`. | **VERIFIED** — `NativeSearchInjector.ts` `buildOpenAIAugmentation`, lines 164–172. |
| R2 | For other OpenAI models the injection is an **additional tool** `{ type: 'web_search', web_search: { search_context_size } }`. | **VERIFIED** — same function, lines 174–184. |
| R3 | `search_context_size` is derived from the user's `maxResults`: `<= 2 → 'low'`, `<= 5 → 'medium'`, else `'high'`; the default when `maxResults` is unset is `'medium'`. | **VERIFIED** — `mapMaxResultsToContextSize`, lines 288–292. |
| R4 | Vendor variants: Google Gemini 2.0+ gets the `google_search` tool (Gemini 1.5 the legacy `googleSearchRetrieval`); xAI gets the `search_parameters` body field; OpenRouter gets a `plugins` body field carrying the `web` plugin. | **VERIFIED** — `NativeSearchInjector.ts` lines 215–274. |
| R5 | xAI is detected by an `x.ai` / `xai.com` base URL; OpenRouter by `isOpenRouterProvider`. | **VERIFIED** — lines 53–58, 282–285. |
| R6 | In the Responses hosted-tool selection, the output item type `web_search_call` maps to the declaration types `['web_search_preview', 'web_search']`. | **VERIFIED** — `HOSTED_CALL_DECLARATION_TYPES` in `packages/core/src/provider-proxy/responses/hosted-image/nativeResponsesImageSelection.ts` line 57. |
| R7 | The shipped OpenAI provider preset declares the builtin tool as `{ type: 'web_search_preview' }`. | **VERIFIED** — `packages/contracts/src/provider-presets/defaults.ts` lines 162–168. |

### 2.2 Live upstream event sequence — UNVERIFIED

**Status: UNVERIFIED.** A structural scan of all 444 body shards for
`"type": "web_search_call"` — the marker of a Responses hosted-search output item on the
wire — returns **zero** occurrences. Three loose textual mentions of the string
`web_search_call` exist in two shards, but they sit inside captured conversation text, not
in a response payload, so they are not wire evidence.

**Missing evidence:** a live upstream Responses exchange in which a hosted `web_search`
tool actually runs, captured with bodies enabled — specifically the
`response.web_search_call.*` streaming events and the resulting output item's fields. Owner:
the protocol-frontends change (阶段5).

---

## 3. Anthropic Messages `web_search_*`

### 3.1 What Omnicross verifiably does today

| # | Statement | Evidence |
| --- | --- | --- |
| A1 | The Anthropic augmentation constructs `{ type: 'web_search_20250305', name: 'web_search' }`, adding `max_uses` when the user set `maxResults` and `blocked_domains` when the user configured any. | **VERIFIED** — `NativeSearchInjector.ts` `buildAnthropicAugmentation`, lines 193–207. |
| A2 | Server-side tools are detected by type **prefix**, not by an exact list: `type.startsWith('web_search_')` (alongside `code_execution_`, `text_editor_`, `memory_`, `web_fetch_`, `search_tool_`). | **VERIFIED** — `isServerSideTool` in `packages/core/src/transformer/transformers/AnthropicToolHandling.ts` lines 19–27. |
| A3 | The SSE parser tracks `server_tool_use` content blocks, emitting a `ToolUseBlock` whose `toolName` defaults to `'web_search'` and whose `status` starts as `'running'`. | **VERIFIED** — `packages/core/src/sse-parser.ts` lines 226–241. |
| A4 | It also tracks `web_search_tool_result` blocks, turning the block's `content` array into a `tool_result` block bound to the last `server_tool_use` id. | **VERIFIED** — `sse-parser.ts` lines 244–273. |
| A5 | `input_json_delta` deltas are accumulated into a buffer to reassemble the server tool's input. | **VERIFIED** — `sse-parser.ts` lines 299–302. |
| A6 | An Anthropic BYO relay passes a `web_search_20250305` tool through byte-for-byte. | **VERIFIED** — `packages/core/src/provider-proxy/__tests__/ProviderProxy.anthropicByo.test.ts` lines 302–324. |

### 3.2 Elftia's synthetic Anthropic response (read-only reference)

`proxySearchIntercept.ts` intercepts search-only sub-requests and fabricates an Anthropic
Messages response rather than forwarding a tool non-Anthropic providers reject.

| # | Statement | Evidence |
| --- | --- | --- |
| A7 | A sub-request counts as search-only when every tool has `type` starting with `web_search` **or** `name === 'web_search'`, and either `tool_choice` forces the `web_search` tool or exactly one tool is present. | **VERIFIED** — `isSearchOnlySubRequest`, lines 32–48. |
| A8 | The synthesized body is `{ id: 'msg_search_<ts>', type: 'message', role: 'assistant', content: [...], model: 'local-search-proxy/<providerUsed>', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }`. | **VERIFIED** — `buildSearchResponse`, lines 109–149. |
| A9 | `content[0]` is `{ type: 'web_search_tool_result', tool_use_id: 'toolu_search_<ts>', content: [ { type: 'web_search_result', url, title, encrypted_content, page_age: null } ] }`; `content[1]` is a plain `text` block restating the results. | **VERIFIED** — same function. `encrypted_content` is filled with the result **snippet**, not real encrypted content. |
| A10 | The search itself runs through the host orchestrator: `searchWithFallback(query, 'auto', { maxResults: 5 })`. | **VERIFIED** — `executeLocalSearch`, line 88. |

### 3.3 Live upstream event sequence — VERIFIED (with a truncated tail)

Unlike the other two surfaces, real upstream Anthropic hosted-search traffic **is** present
in the local audit store. Four independent SSE response bodies were located by structural
scan:

| day | shard | record | body length |
| --- | --- | --- | --- |
| `audit-2026-08-27` | `ad500d68…jsonl.gz` | `42a751ed…` | 8 192 chars |
| `audit-2026-08-27` | `f7b87910…jsonl.gz` | `a272a952…` | 8 190 chars |
| `audit-2026-08-28` | `269a05cb…jsonl.gz` | `805b9891…` | 8 167–8 192 chars |
| `audit-2026-08-28` | `f7218710…jsonl.gz` | `163282e4…` | 8 167 chars |

**Request side (VERIFIED).** The request bodies contain a tools entry of shape
`{ "type": string, "name": string, "max_uses": number }` — matching what A1 constructs.

**Block ordering (VERIFIED)**, consistent across all four captures:

```
message_start
content_block_start   content_block.type = "server_tool_use"
ping
content_block_delta   delta.type = "input_json_delta"   (xN)
content_block_stop
[ optionally a second server_tool_use round: content_block_start -> input_json_delta xN -> content_block_stop ]
content_block_start   content_block.type = "web_search_tool_result"
… (beyond the capture limit)
```

Record `805b9891…` is the one showing two `server_tool_use` rounds before the result block;
the other three show one.

**Block shapes (VERIFIED)**, values reduced to types:

```jsonc
// content_block_start — server tool invocation
{ "type": "string", "index": "number",
  "content_block": { "type": "string", "id": "string", "name": "string", "input": {} } }

// content_block_delta — streamed tool input
{ "type": "string", "index": "number",
  "delta": { "type": "string", "partial_json": "string" } }

// content_block_start — search results
// keys observed: type, index, content_block{ type, tool_use_id, content[] }
//                where each content item carries: type, url, title, encrypted_content, page_age
```

```jsonc
// message_start
{ "type": "string",
  "message": { "model": "string", "id": "string", "type": "string", "role": "string",
    "content": [], "stop_reason": null, "stop_sequence": null, "stop_details": null,
    "usage": { "input_tokens": "number", "cache_creation_input_tokens": "number",
      "cache_read_input_tokens": "number",
      "cache_creation": { "ephemeral_5m_input_tokens": "number", "ephemeral_1h_input_tokens": "number" },
      "output_tokens": "number", "service_tier": "string", "inference_geo": "string" } } }
```

**Consequence worth carrying forward:** the real upstream `web_search_tool_result` item
fields — `url`, `title`, `encrypted_content`, `page_age` — are exactly the fields Elftia's
`proxySearchIntercept` fabricates (A9). Elftia's synthetic response is therefore
field-compatible with the genuine wire shape; the difference is that upstream
`encrypted_content` is opaque provider data while Elftia puts the plain snippet there.

### 3.4 What is still UNVERIFIED here

- **The tail of the Anthropic hosted-search stream.** All four captures were truncated by
  the audit body-size limit at ~8 KB, cutting off immediately after the
  `web_search_tool_result` `content_block_start`. The trailing `content_block_stop`, any
  subsequent text blocks, `message_delta` (with `stop_reason` and final usage) and
  `message_stop` are **not** captured.
  **Missing evidence:** one Anthropic hosted-search exchange captured with a raised or
  disabled body cap (`maxBodyBytes`), so the complete event stream lands.
- **Error semantics.** No captured exchange shows a hosted-search failure (upstream error,
  `max_uses` exhaustion, blocked domain), so the error shapes are unknown.
  **Missing evidence:** a captured failing hosted-search exchange.

---

## 4. Ledger summary

| Surface | Item | Status |
| --- | --- | --- |
| Codex `/v1/alpha/search` | route, method, status 404, client UA, `hasBody`, record count, store layout | **VERIFIED** |
| Codex `/v1/alpha/search` | request body schema | **UNVERIFIED** — bodies dropped for lack of a `sessionKey`; needs an exchange reaching route resolution |
| Codex `/v1/alpha/search` | response schema, error semantics | **UNVERIFIED** — no non-404 exchange exists; needs live upstream capture (§7.2 capture-first mandate) |
| Responses `web_search` | Omnicross-side injection and hosted-call mapping | **VERIFIED** (code-cited) |
| Responses `web_search` | live upstream event sequence / output item fields | **UNVERIFIED** — zero `web_search_call` payloads in 444 shards |
| Anthropic `web_search_*` | tool construction, server-tool prefix rule, SSE tracking, BYO passthrough | **VERIFIED** (code-cited) |
| Anthropic `web_search_*` | Elftia synthetic response shape | **VERIFIED** (code-cited, read-only reference) |
| Anthropic `web_search_*` | live upstream block ordering and block shapes | **VERIFIED** — 4 captures, 2 days |
| Anthropic `web_search_*` | stream tail (`content_block_stop` / `message_delta` / `message_stop`), error shapes | **UNVERIFIED** — capture truncated at ~8 KB |

Three UNVERIFIED items are owned by the protocol-frontends change (阶段5); none blocks 阶段0.
