# Pre-Landing Review: codex-images-api-surface

**Mode:** dispatched / report-only  
**Reviewer:** independent Codex reviewer (not the implementation author)  
**Branch:** `feat/codex-hosted-tools-and-images`  
**Required portfolio baseline:** `eb2d20a8278870f36af2996914b831f7b8446484`  
**Review HEAD:** `0b38f35caa1c04225366b61854eb22eda3f8eb99`  
**Verdict:** **NOT CLEAN** — 6 issues: 0 Blocker, 4 Major, 2 Minor, 0 Trivial.

This review changed no product code, tests, planning inputs, or run-state. Its only write is this report.

## Scope check

**Scope Check: CLEAN**

- The review candidate contains 29 paths: 5 tracked modifications plus 24 untracked files under the new bounded Images API surface.
- Committed `HEAD` tree: `66eb4828ef1501e8438a668d0748ded4cc6595a1`.
- Full temporary-index candidate tree, including untracked files: `9ab797118334d95185501f5eada36568d89b56f9`.
- The child exports non-self-registering `images.generate` and `images.edit` contributions, safe input/reference seams, real JSON/multipart handlers, bounded output/SSE mapping, and official JavaScript/Python SDK contract tests. Production registration, Responses hosted-tool execution, permissions/configuration, daemon/UI wiring, and persistent storage remain in dependent children as designed.
- `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, and `providerProxyShared.ts` have zero candidate diff. No accidental edit overlaps the concurrent Responses ownership boundary.
- No generic Files API, standalone web search, compact, Responses WebSocket, or stored/background Responses implementation leaked into this child.
- No PR exists yet, so remote PR/Greptile triage was not applicable.

`origin/main` advanced during the final report step from the already-merged `7f14b7c52477ab7cc7f136db3589946216fba922` to `83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594` (`feat(ui): auto-refresh overview allowances`). That new commit changes only two overview UI files and does not invalidate the candidate findings, but the LEAD should merge it before the fix round as requested; this report-only reviewer did not mutate the branch.

## Standards axis

### [Minor] [AUTO-FIX] Eleven new files have mixed CRLF/LF working-tree endings

**Evidence:** byte inspection found both CRLF and bare-LF line endings in:

- `packages/core/src/image-generation/openai-images/__tests__/contractHarness.ts`
- `packages/core/src/image-generation/openai-images/__tests__/inputPipeline.test.ts`
- `packages/core/src/image-generation/openai-images/__tests__/openaiSdk.contract.test.ts`
- `packages/core/src/image-generation/openai-images/__tests__/python/images_contract.py`
- `packages/core/src/image-generation/openai-images/__tests__/pythonSdk.contract.test.ts`
- `packages/core/src/image-generation/openai-images/__tests__/safeRemoteResolver.test.ts`
- `packages/core/src/image-generation/openai-images/__tests__/securityE2e.test.ts`
- `packages/core/src/image-generation/openai-images/editHandler.ts`
- `packages/core/src/image-generation/openai-images/readMultipartEdit.ts`
- `packages/core/src/image-generation/openai-images/resolveImageInput.ts`
- `packages/core/src/image-generation/openai-images/types.ts`

`core.autocrlf=true` normalizes the candidate blobs, and `git diff --cached --check` passes, but the checked-out files remain formatting-unstable and produce conversion warnings.

**Recommended fix:** normalize only these files to one working-tree convention consistent with the repository policy, preserving UTF-8 without BOM and content byte-for-byte after newline normalization.

### [Minor] [ASK] The official JavaScript SDK test dependency requires a newer Node engine than the package advertises

**Evidence:** `packages/core/package.json:27-28` advertises Node `>=20.9`, while the newly added dev dependency at `packages/core/package.json:66-68` resolves to `openai@7.8.0`; its lock entry at `package-lock.json:5032-5040` declares Node `>=22.0.0`.

The SDK is test-only, so this does not prove the published runtime must move to Node 22. It does mean a contributor following the advertised package engine can encounter an unsupported test/install toolchain.

**Recommended decision:** explicitly establish Node 22+ as the contributor/contract-test runtime, or select a compatible official SDK/version policy without unnecessarily raising the published core runtime requirement.

**Standards result:** 2 Minor findings.

## Spec axis

### [Major] [ASK] An accepted provider job is not cancelled when local streaming fails or the consumer exits early

**Evidence:** `packages/core/src/image-generation/ImageOrchestrator.ts:211-216` defines `cancelOnce()`, but the `finally` block at `:391-400` invokes it only when `context.signal.aborted`. A consumer-side early return or a local response-limit failure closes only `iterator.return()` and releases the provider lease; it does not cancel an accepted, nonterminal job.

**Authoritative reproduction:** a real HTTP harness streamed a provider partial larger than the local limit. The handler rejected it, released resources, and removed temporary files, but never cancelled the already-accepted provider job:

```json
{"observed":["threw:image_too_large"],"starts":1,"cancels":0,"releases":1,"temp":[]}
```

This can leave subscription work and quota consumption running after Omnicross has stopped delivering the result.

**Recommended fix:** track whether the provider reached a terminal event and call the idempotent cancellation path for every accepted, nonterminal consumer exit, including local output failure and iterator early return. Add a regression that asserts exactly one cancel, one release, and empty temporary state.

### [Major] [ASK] Final artifacts are not checked against requested format, explicit dimensions, or transparency

**Evidence:** `assertArtifactMetadata()` and `sanitizeProviderOutput()` at `packages/core/src/image-generation/ImageOrchestrator.ts:115-152` validate only generic positive metadata and `image/*`. Completion at `:362-372` checks exact output count but never compares final artifacts with `request.outputFormat`, an explicit pixel size, or `background: 'transparent'`.

**Authoritative reproduction:** a request for a transparent 1024×1024 PNG was accepted and completed with an opaque 8×8 JPEG:

```json
[{"type":"accepted"},{"type":"completed","mime":"image/jpeg","width":8,"height":8,"alpha":false}]
```

The public API can therefore return a successful response that contradicts the caller's normalized request and the advertised capability contract.

**Recommended fix:** before retaining or emitting completion, reject final outputs whose MIME/format, explicit dimensions, or required alpha do not match the request. Map this provider drift to `upstream_protocol_changed` and cover all three postconditions independently.

### [Major] [ASK] Provider partial-image output is not bounded by the requested `partial_images`

**Evidence:** the partial branch at `packages/core/src/image-generation/ImageOrchestrator.ts:337-359` validates output index, non-negative partial index, and monotonic ordering. It never enforces the caller's `request.partialImages` count per output and does not reject partials when the request asked for zero.

**Authoritative reproduction:** `partialImages: 0` accepted five provider partials before completion:

```json
["accepted","partial:0","partial:1","partial:2","partial:3","partial:4","completed"]
```

This violates the normalized 0–3 request semantics and leaves response bandwidth unbounded under provider protocol drift.

**Recommended fix:** maintain a per-output partial count budget, reject every partial when the requested value is zero, and reject an event that would exceed the requested count. Add zero, exact-budget, and over-budget multi-output tests.

### [Major] [ASK] Capabilities cannot affirm or reject quality, moderation, or output-compression requests

**Evidence:** `assertRequestSupported()` at `packages/core/src/image-generation/ImageOrchestrator.ts:54-90` checks availability, model, counts, format, transparency, flexible size, streaming, action, mask, and input count. `ImageCapabilityValues` at `packages/contracts/src/image-generation-types.ts:190-205` has no representation for supported quality levels, moderation modes, or compression behavior.

The subscription adapter's start guard at `packages/subscriptions/src/image-generation/CodexSubscriptionImageProvider.ts:124-130` also does not reject those options, while `privateWireRequest.ts:20-28` forwards quality and conditionally forwards moderation/compression. Thus otherwise-positive evidence can allow unverified option combinations through acceptance, contrary to the capability-first/no-silent-degradation requirement.

**Recommended fix:** extend the stable capability contract with truthful supported quality/moderation/compression semantics, or introduce equally explicit provider validation before acceptance. Unknown evidence must fail closed. Add unsupported and verified-supported tests for each option without claiming live subscription entitlement.

**Spec result:** 4 Major findings; shipping remains blocked until non-author re-review confirms them resolved.

## Task and contract audit

| Area | Evidence-backed result |
|---|---|
| Generate/edit API contributions | Present, exported from the core root and `image-generation` subpath, and intentionally not self-registered. |
| JSON and multipart ingress | Bounded body parsing, ordered repeated edit images, mask validation, strict UTF-8, and cleanup paths are covered. |
| Raster validation | PNG/JPEG/WebP signature/container checks plus bounded Sharp decode reject malformed, animated, forged, and pixel-bomb inputs. |
| Reference and remote inputs | Tenant-scoped leases and fail-closed missing resolvers are present; the optional remote resolver pins validated addresses per redirect hop. |
| Non-stream response | Exact-`n` outputs are staged before HTTP 200 with bounded spools and truthful optional usage/revised prompt. Final request/output postconditions remain missing (Major). |
| SSE response | Accepted/partial/completed mapping, backpressure, safe errors, disconnect cancellation, and server-idle cleanup tests pass. Consumer-side non-abort termination and partial count enforcement remain missing (Majors). |
| Capability truthfulness | Live Codex subscription capability remains unavailable without evidence; entitlement/usage/moderation are not fabricated. Quality/moderation/compression expressiveness remains incomplete (Major). |
| Auditing and redaction | Metadata-only audit/error shapes and sentinel tests exclude credentials, prompts, content, paths, URLs, Base64, tenant and account identifiers. |
| SDK compatibility | Official JavaScript `openai@7.8.0` and Python `openai==3.5.0` contract paths pass; Node engine policy needs a recorded decision (Minor). |
| Session B ownership | Forbidden paths have zero diff; Responses ingress and final daemon/UI wiring remain injection-only follow-up work. |

## Coverage diagram

```text
OPENAI IMAGES REQUEST
        |
        +--> JSON / multipart limits -------- [TESTED]
        +--> reference / URL / raster safety - [TESTED]
        `--> normalize request --------------- [TESTED]
                    |
                    v
             IMAGE ORCHESTRATOR
                    |
        capability gate
        +-- model/count/format/size/stream --- [TESTED]
        `-- quality/moderation/compression --- [GAP #4]
                    |
              provider accepted
                    |
        +-----------+------------------+
        |                              |
        v                              v
   partial events                 final outputs
   monotonic/indexed [TESTED]      exact n [TESTED]
   requested count  [GAP #3]      format/size/alpha [GAP #2]
        |                              |
        +--------------+---------------+
                       v
              JSON / SSE mapper -------- [TESTED]
                       |
          abort cancel + cleanup -------- [TESTED]
          early local failure cancel ---- [GAP #1]

USER-FACING CONTRACT GROUPS
  10 covered groups; 4 acceptance/lifecycle gaps block shipping.
```

## Verification evidence

### Test gate

Command:

```powershell
npx vitest run packages/core/src/image-generation packages/subscriptions/src/image-generation packages/core/src/openai-operation/__tests__/openAIOperation.test.ts packages/core/src/openai-operation/__tests__/openAIOperationRegistry.test.ts packages/core/src/provider-proxy/__tests__/openAIOperationDispatch.test.ts packages/core/src/provider-proxy/__tests__/ProviderProxy.lastResort500.test.ts
```

Result: **PASS** — 18 files considered, 17 passed and one environment-gated Python contract file skipped; 180 tests passed and one skipped.

Explicit Python SDK gate:

```powershell
$env:OMNICROSS_PYTHON_SDK_EXECUTABLE = Join-Path $env:LOCALAPPDATA 'Temp\omnicross-openai-sdk-3.5.0\Scripts\python.exe'
npx vitest run packages/core/src/image-generation/openai-images/__tests__/pythonSdk.contract.test.ts
```

Result: **PASS** — 1 test with Python 3.12.4 and official `openai==3.5.0`. The combined JavaScript suite used official `openai@7.8.0`.

The test harness explicitly models server-side completion: `securityE2e.test.ts:122`, `:176`, `:208`, and `:242` await `harness.waitForIdle()` before cleanup assertions, while `contractHarness.ts:244-276` drains in-flight handlers on close. The server cleanup E2E passed, so the reported cancellation gap is specifically the provider-job cancellation state, not an artifact/temp-file leak or a client-response timing false positive.

### Typecheck, build, and exports

- `npm run typecheck -w @omnicross/core` — **PASS**
- `npm run typecheck -w @omnicross/subscriptions` — **PASS**
- `npm run build -w @omnicross/core` — **PASS** (ESM/CJS/DTS)
- `npm run build -w @omnicross/subscriptions` — **PASS** (ESM/CJS/DTS)
- Built ESM/CJS root and subpath imports — **PASS**; `createImageApiContributions` and `createSafeRemoteImageResolver` are functions from each intended surface.

### Change, dependency, encoding, diff, and security checks

- `rasen validate codex-images-api-surface --type change --strict --json` — **PASS**, valid with zero issues.
- Temporary-index candidate `git diff --cached --check` — **PASS**.
- Strict UTF-8 decode for all 29 candidate text files — **PASS**; no BOM, U+FFFD, or common mojibake signature.
- Secret scan — **PASS**; no real API-key/JWT/Bearer pattern and no large literal Base64 fixture.
- Forbidden-path audit — **PASS**, zero candidate path under the three Session B exclusions.
- `npm audit --omit=dev --json` — zero critical; no target direct-dependency finding. Two unrelated pre-existing transitive high findings remain in `form-data` and `ip-address`.
- Runtime dependency resolution — `busboy@1.6.0`, `streamsearch@1.1.0`, `sharp@0.35.4`, and `undici@6.28.0`.

The diff is large, but external adversarial delegation was not used because this dispatched reviewer was explicitly constrained to a flat, report-only leaf and forbidden from spawning/delegating subagents. The review instead covered the complete candidate tree and recorded reproducible evidence for every Major finding.

## Final verdict

**NOT CLEAN.** The public Images API shape, ingress limits, raster validation, reference/remote safety, SDK compatibility, redaction, build, and cleanup evidence are strong. Shipping this child is blocked by four acceptance/lifecycle contract gaps: cancellation on early local termination, final output postcondition validation, requested partial-image budgeting, and capability truthfulness for quality/moderation/compression. Normalize the mixed endings, decide the Node/SDK engine policy, merge the newly advanced disjoint `main`, then require a non-author delta re-review.
