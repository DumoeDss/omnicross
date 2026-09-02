# Phase 1 release state (frozen)

> **Frozen at the close of Phase 1 (plan 阶段5), 2026-09-02.** Point-in-time
> acceptance-gate artifact for
> [`omnicross-search-runtime-extraction-plan.md`](./../omnicross-search-runtime-extraction-plan.md).
> Companion to [`behavior-comparison-report.md`](./behavior-comparison-report.md),
> [`elftia-search-baseline.md`](./elftia-search-baseline.md),
> [`duplicate-fallback-and-consumers.md`](./duplicate-fallback-and-consumers.md)
> and [`wire-baseline.md`](./wire-baseline.md).

Plan 阶段5 requires "发布一个可被 Elftia 精确锁定的 Omnicross 版本". **This document
is that deliverable.** It records a clean, evidenced, lockable state.

> ## No tag. No publish. No version bump.
>
> This change creates **no git tag**, publishes **no npm package**, and bumps
> **no version**. Omnicross's release is dual-channel and entirely manual — six
> `npm publish` calls plus a `v*` tag that triggers the Tauri draft release — and
> nothing in the repository automates either channel. Whether and when to fire
> them is the portfolio delivery decision, not this change's. Until then the
> exact state below is what Phase 2 pins.

## 1. The state being locked

| Field | Value |
| --- | --- |
| Repository | Omnicross |
| Branch | `feat/search-runtime-extraction-phase1` |
| Worktree | `omnicross--search-runtime-extraction` (branched from local `main` @ `97aed26`) |
| Parent commit | `3f095e4` — *feat(search): add API search provider adapters with SSRF egress policy* (阶段4) |
| Closing commit | **stamped at ship time.** This change does not commit; the shipper records the id here. |

### 1.1 The six workspace packages, at this state

All six are `0.2.0`. None was bumped by Phase 1 — a version change is a release
act, and this change deliberately performs none.

| Package | Version |
| --- | --- |
| `@omnicross/contracts` | `0.2.0` |
| `@omnicross/core` | `0.2.0` |
| `@omnicross/daemon` | `0.2.0` |
| `@omnicross/subscriptions` | `0.2.0` |
| `@omnicross/cli-launcher` | `0.2.0` |
| `@omnicross/ui` | `0.2.0` |

The workspace root is `private: true`; that is not a signal that the packages are
unpublishable — the six above are published individually.

### 1.2 The six commits that make up Phase 1

| Stage | Commit | Subject |
| --- | --- | --- |
| 阶段0 | `ffb51ad` | docs(search): freeze Elftia search behavior baseline for phase 1 |
| 阶段1 | `a5c2a92` | feat(contracts): add target search contract surface and legacy compat layer |
| 阶段2 | `434a2b5` | feat(search): add keyless HTTP search vertical slice (Bing, DuckDuckGo) |
| 阶段3 | `d27eb2e` | feat(search): add provider registry and orchestrator with runtime facade |
| 阶段4 | `3f095e4` | feat(search): add API search provider adapters with SSRF egress policy |
| 阶段5 | *(this change — stamped at ship time)* | protocol frontends + acceptance-gate artifacts |

## 2. The 第一阶段总验收门, item by item

Every verdict carries a concrete pointer. No item is asserted bare.

### Gate 1 — Elftia has zero changes caused by this plan

**PASS.** Re-verified fresh at 2026-09-02, not inherited from 阶段0.

- Elftia HEAD is `6c6a03900596cb786d3befd620ea7db4ef18e420` (moved since the
  阶段0 pin `1d4746ea…` through work unrelated to this plan — flagged, never
  re-baselined).
- `git status --short` over every search-relevant path
  (`capabilities/search/**`, `tinyelf/tools/**`, `shared/contracts/runtime/**`,
  `agent-core/agent/proxy/**`) reports exactly the two entries the 阶段0 baseline
  already recorded as pre-existing: `providers/LocalSearchProvider.ts` (M) and
  the untracked `providers/__tests__/`.
- Both re-hash **identical** to the 阶段0 manifest —
  `d8144dd1…5be950` and `e7cf84b0…f626a` respectively — so they are unchanged
  since the baseline, not merely unchanged in name.
- All 14 manifest-pinned porting oracles plus `proxySearchIntercept.ts` re-hash
  identical: [`behavior-comparison-report.md`](./behavior-comparison-report.md) §1.
- No Omnicross change touched the Elftia working tree at any point in Phase 1.

### Gate 2 — Omnicross searches standalone, with no Elftia and no Electron

**PASS.**

- The whole `packages/core/src/search/**` tree is pure Node. A module-boundary
  test asserts it imports no Elftia package and no Electron, by matching import
  SPECIFIERS (so the documentation may name Electron while explaining why it is
  unused): `packages/core/src/search/__tests__/runtime.test.ts`, plus the
  equivalents under `search/http/__tests__/` and `search/api/__tests__/`.
- The keyless HTTP providers run against committed sanitized fixtures:
  `packages/core/test-fixtures/http-search/` driven by
  `packages/core/src/search/http/__tests__/`.
- The four API adapters run against fixture transports:
  `packages/core/src/search/api/__tests__/`.
- The daemon assembles and runs the whole thing with no host:
  `packages/daemon/src/__tests__/search-assembly.test.ts` builds a real daemon
  from a temp config and asserts the constructed runtime's provider set.

### Gate 3 — Automated evidence for contracts, registry, orchestrator, providers, protocol frontends and doctor

**PASS.** One pointer per required surface.

| Surface | Evidence |
| --- | --- |
| contracts | `packages/contracts/src/__tests__/search-types.test.ts`, `search-compat.test.ts` |
| registry | `packages/core/src/search/__tests__/registry.test.ts` |
| orchestrator | `packages/core/src/search/__tests__/orchestrator.test.ts`, `runtime.test.ts` |
| normalization | `packages/core/src/search/__tests__/normalize.test.ts` |
| egress / SSRF | `packages/core/src/search/__tests__/egress.test.ts` |
| HTTP providers | `packages/core/src/search/http/__tests__/**` |
| API providers | `packages/core/src/search/api/__tests__/**` |
| legacy port compat | `packages/core/src/search/__tests__/webSearchBackendCompat.test.ts`, `packages/core/src/ports/__tests__/web-search-backend.port.test.ts` |
| daemon config section | `packages/core/src/outbound-api/__tests__/searchServerConfig.test.ts` |
| daemon assembly | `packages/daemon/src/__tests__/search-assembly.test.ts` |
| Codex frontend | `packages/core/src/outbound-api/__tests__/searchRoute.test.ts`, `outboundApiSearchDispatch.test.ts` |
| Responses frontend | `packages/core/src/provider-proxy/responses/hosted-search/__tests__/nativeResponsesSearchMediator.test.ts` |
| Anthropic frontend | `packages/core/src/provider-proxy/ingress/__tests__/anthropicManagedSearch.test.ts` |
| mode isolation, both frontends, both directions | `packages/core/src/provider-proxy/__tests__/ProviderProxy.searchFrontends.test.ts` |
| doctor | `packages/daemon/src/__tests__/doctor-search.test.ts`, `doctor-search-api.test.ts`, `doctor-search-config.test.ts` |

The plan-§12.2 failure matrix — non-streaming, streaming, interruption, timeout,
upstream error, no-available-provider — is covered per frontend inside the three
frontend suites above.

### Gate 4 — No unexplained semantic differences; allowed differences are written down

**PASS.** [`behavior-comparison-report.md`](./behavior-comparison-report.md) is the
migration note this gate asks for.

- The comparison matrix covers requests, results, errors, fallback and
  cancellation across seven surfaces (§2).
- The ALLOWED-DIVERGENCE set is **closed at eight** entries, each citing the stage
  and role that recorded it (§3).
- The UNVERIFIED set is exactly the wire ledger's four surviving entries, each
  naming the capture that would settle it (§4).
- Items that look like divergences but are not — the resolved cross-origin
  credential fix, the synthesized `server_tool_use` block, the `model` field, and
  the managed-Responses turn shape — are recorded as notes with their reasoning
  (§5), so nothing is silently absent.

### Gate 5 — A precisely lockable, independently rollback-able release state

**PASS as a state; the release act is deferred.**

- Lockable: Phase 2 pins the closing commit of `feat/search-runtime-extraction-phase1`
  (or the published `0.2.x` versions of the six packages once the portfolio
  delivery publishes them).
- Independently rollback-able: Phase 1 changed **only** Omnicross. Plan §15's
  rollback for this phase is "revert the Omnicross commit / release version;
  Elftia needs no action", and that holds literally here — Elftia has zero
  changes (Gate 1).
- The single visible default-behavior change is `POST /v1/alpha/search`:
  the generic 404 becomes a structured `unsupported_capability`. Everything else
  defaults to today's behavior (Responses and Anthropic search stay `native`).
  Reverting the commit restores the 404.

### Gate 6 — Phase 2's Elftia fallback path is defined but not enabled or committed

**PASS.** §4 below defines it. Nothing has been enabled in Elftia and nothing has
been committed there.

## 3. What Phase 2 pins and consumes

1. **Pin** the closing commit of `feat/search-runtime-extraction-phase1`, or the
   published versions of the six packages, exactly. Do not float.
2. **Consume these import paths**, all of which exist and are guarded at this
   state:
   - `@omnicross/contracts/search-types` — the target contract surface.
   - `@omnicross/contracts/websearch-types` — the LEGACY surface. Elftia's
     `@shared/websearch-types` is a re-export shim of it, so this path must keep
     resolving or Elftia's build breaks. Unchanged in Phase 1.
   - `@omnicross/contracts/search-compat` — legacy⇄new converters, scheduled for
     deletion in 阶段8.
   - `@omnicross/core/ports/web-search-backend` — imported directly by Elftia's
     `proxySearchIntercept.ts`. **Byte-untouched** in Phase 1.
   - `@omnicross/core/search` — `createSearchRuntime`, the registry, the
     orchestrator, the egress policy, the frontend-mode vocabulary, and
     `searchRuntimeAsWebSearchBackend`.
   - `@omnicross/core/search/http`, `@omnicross/core/search/api` — the provider
     contributions.
3. **Register `local-*` as explicit host contributions** (阶段7) through
   `SearchRuntime.registerContribution`. Provider `source`/`kind`/capabilities are
   DECLARED; nothing may be inferred from an id prefix.
4. **Read** [`behavior-comparison-report.md`](./behavior-comparison-report.md) §3
   before comparing behavior: those eight divergences are expected, and a Phase-2
   comparison that flags them is reporting the design, not a regression.

## 4. The Phase-2 fallback path (defined here; NOT enabled, NOT committed to Elftia)

Plan 阶段6 requires a feature flag with a working revert. The seams that make it
possible all exist at this state:

- **The flag lives in Elftia**, not here. Elftia's TinyElf `web_search` /
  `web_fetch` and its `WebSearchService` keep their current implementations and
  gain a switch that routes to the Omnicross runtime instead.
- **The adapter seam is already shipped**: `searchRuntimeAsWebSearchBackend`
  presents a `SearchRuntime` through the legacy `WebSearchBackend` port, so an
  Elftia call site can swap implementations without changing its own types. In
  Omnicross it is already wired into the Anthropic `webSearchService` hint slot,
  where a route-supplied backend still takes precedence — the same precedence
  rule an Elftia flag would use.
- **Reverting** means flipping the flag back to Elftia's own orchestrator. No
  Omnicross change and no redeploy is required, because both paths remain present
  in Elftia throughout 阶段6.
- **`local-*` providers are unaffected** by the flag: they stay in Elftia until
  阶段7 registers them as contributions, and a contribution problem is undone by
  not registering it.

## 5. Open items carried forward, by design

| Item | Status | Owner |
| --- | --- | --- |
| Codex `/v1/alpha/search` request + response schemas | **UNVERIFIED.** The route now assigns a `sessionKey`, so a real client's exchange finally persists its body — that is the designed evidence path | a future capture-driven change; `codex-full-protocol-relay-requirements.md` §7.2 is the standing mandate |
| Responses hosted-search live event sequence | **UNVERIFIED.** Zero `web_search_call` payloads in 444 audit shards | a live capture with bodies enabled |
| Anthropic hosted-search stream tail and error shapes | **UNVERIFIED.** All four captures truncate at the ~8 KB audit body cap | a capture with a raised `maxBodyBytes` |
| RFC 6598 shared address space (`100.64.0.0/10`) egress denial | **OPEN, deliberately.** `100.100.100.200` (Alibaba metadata) and `fd00:ec2::254` currently pass the policy | a post-Phase-1 cross-provider egress-hardening pass |
| The `readUrl` / `web_fetch` boundary (plan §16) | **OPEN, deliberately.** Jina Reader ships as the Jina contribution's `readUrl`; `BuiltinToolExecutor.web_fetch` is untouched | a later change |
| Grok, Claude (unregistered); Exa, Bocha (no adapter exists to port) | **Closed as decisions**, not gaps | plan hard constraint 5 / 阶段4 planner |
| `isApiProvider` / `isLocalProvider` prefix helpers | **Deprecated, not deleted** — the Elftia `export *` shim surface must stay byte-compatible | 阶段8 |

## 6. How to actually release, when the portfolio decides to

Recorded so the decision is a decision and not a research task. **Nothing below
was executed by this change.**

1. Publish the six packages manually with `npm publish` (the workspace root is
   `private: true`; the packages are not).
2. Push a `v*` tag to trigger the Tauri draft release.

The two channels are independent, and neither is automated from inside the
repository.
