# Pre-Landing Review: codex-image-provider-foundation

**Mode:** dispatched / report-only  
**Reviewer:** independent Codex reviewer (not the implementation author)  
**Branch:** `feat/codex-hosted-tools-and-images`  
**Base / HEAD:** `eb2d20a8278870f36af2996914b831f7b8446484` (`origin/main` matches)  
**Verdict:** **NOT CLEAN** — 4 issues: 0 Blocker, 3 Major, 1 Minor, 0 Trivial.

No product code, tests, planning artifacts, or run-state were changed by this review.

## Scope check

**Scope Check: CLEAN**

- **Intent:** freeze provider-neutral image contracts/orchestration/reference ports and add a dormant, fail-closed Codex subscription adapter without adding public routes or host wiring.
- **Delivered:** 6 tracked export/build edits plus 22 untracked foundation implementation/test files (2,937 lines), covering contracts, core image generation, and the subscriptions adapter.
- The child correctly excludes `/v1/images/*`, Responses hosted-image execution, permissions/configuration, queues, daemon/UI wiring, and live entitlement claims; those remain dependent Changes per the artifacts.
- `packages/core/src/openai-operation/**`: no changed or untracked path.
- `openaiResponsesIngress.ts`: no changed or untracked path.
- `providerProxyShared.ts`: no changed or untracked path.
- No PR exists yet, so Greptile triage was not applicable.

## Standards axis

### [Major] [ASK] Header-only/corrupt image data is certified as independently decodable

**Evidence:** `packages/subscriptions/src/image-generation/privateWireResponse.ts:82-89`, `:92-119`, and `:121-127` validate only a small signature/header subset, then construct `InMemoryImageAsset`, whose `independentlyDecodable` property is unconditionally `true` (`packages/core/src/image-generation/ports.ts:22-30`). The PNG path does not validate a chunk chain, IDAT/IEND, CRCs, or actual decodability; JPEG similarly accepts a stream after finding SOF without proving a complete image; WebP accepts only the VP8X container and rejects valid VP8/VP8L forms.

**Authoritative reproduction:** a read-only `tsx` probe supplied a 26-byte buffer containing only the PNG signature, width/height bytes, and color type. `parseCandidateCodexImageResponse()` returned:

```json
{"accepted":1,"byteLength":26,"width":1,"height":1,"independentlyDecodable":true}
```

This violates the spec requirement that malformed output never completes and that provider artifacts marked as partial/final images be independently decodable. With affirmative injected capability evidence, a corrupt upstream body can therefore become a successful image artifact.

**Recommended fix:** validate/decode output through a bounded raster decoder (or an equivalently complete format validator), derive MIME/dimensions/alpha from decoded data, enforce output byte/pixel limits, and add truncated/corrupt PNG/JPEG/WebP plus valid VP8/VP8L coverage before setting `independentlyDecodable: true`.

### [Minor] [AUTO-FIX] Six edited existing files now have mixed CRLF/LF endings

**Evidence:** `core.autocrlf=true`, no relevant `.gitattributes` override exists, and byte inspection found original CRLF lines plus bare-LF inserted lines in:

- `packages/contracts/package.json` (`150` CRLF, `11` bare LF)
- `packages/contracts/src/index.ts` (`34` CRLF, `3` bare LF)
- `packages/contracts/tsup.config.ts` (`35` CRLF, `3` bare LF)
- `packages/core/src/index.ts` (`103` CRLF, `6` bare LF)
- `packages/core/tsup.config.ts` (`93` CRLF, `3` bare LF)
- `packages/subscriptions/src/index.ts` (`53` CRLF, `11` bare LF)

Git consequently warns that LF will be replaced by CRLF on every diff/check invocation. `git diff --check HEAD` still exits `0`, and the normalized Git diff is not a whole-file rewrite, but the working files violate the requested preserve-existing-newline discipline and remain formatting-unstable.

**Recommended fix:** normalize only these six pre-existing files back to their original CRLF convention without changing content; keep new files UTF-8 without BOM.

**Standards result:** 2 findings; worst severity Major.

## Spec axis

### [Major] [ASK] Forced body redaction still persists the full selected account ID in debug trace

**Evidence:** the new adapter passes the raw selected `accountId` to `fetchUpstream` at `packages/subscriptions/src/image-generation/CodexSubscriptionImageProvider.ts:166-178`. The existing trace seam copies it into the trace record at `packages/core/src/pipeline/upstreamFetch.ts:338` and `:351-366`. `redactBodies: true` redacts request/response bodies and authorization headers, but it does not redact or digest `accountId`.

**Authoritative reproduction:** a read-only Node probe ran the built provider with trace enabled and a fake selected account identifier. It returned:

```json
{"rawAccountIdPersisted":true,"requestBodyRedacted":true,"responseBodyRedacted":true}
```

This contradicts the adapter spec's diagnostics rule excluding full account IDs and the Session B privacy boundary. The existing redaction test (`packages/subscriptions/src/image-generation/__tests__/CodexSubscriptionImageProvider.test.ts:197-231`) asserts body/token sentinels only and misses `trace.accountId`.

**Recommended fix:** preserve the raw account ID only for in-process allowance/account attribution while supplying a separate irreversible trace fingerprint (or an explicit trace-redaction option) to diagnostics, then add an assertion that the raw selected account ID is absent from the JSONL record.

### [Major] [ASK] HTTP 5xx/timeout failures are falsely advertised as safe before acceptance

**Evidence:** `packages/subscriptions/src/image-generation/privateWireErrors.ts:29-47` creates one options object with `retrySafety: 'before_acceptance'` and applies it to every mapped HTTP response, including `500`, `503`, and `504`. Receiving those statuses does not prove that the upstream did not accept or spend quota on the image job. The adapter currently auto-refreshes/retries only `401` (`CodexSubscriptionImageProvider.ts:164-199`), but the stable error contract is consumed by later Images/Responses contributions and can incorrectly authorize a duplicate retry.

**Authoritative reproduction:** a read-only parser probe returned:

```text
{"status":500,"code":"image_generation_failed","retrySafety":"before_acceptance"}
{"status":503,"code":"image_generation_failed","retrySafety":"before_acceptance"}
{"status":504,"code":"image_generation_timeout","retrySafety":"before_acceptance"}
```

This violates the acceptance-aware retry contract: retry is safe only with proof that acceptance did not occur (or an upstream idempotency guarantee).

**Recommended fix:** use `unknown`/omit retry safety for ambiguous server errors and timeouts; reserve `before_acceptance` for conditions that prove non-acceptance (such as the narrowly controlled authentication refresh path). Add explicit 5xx/timeout/connection-reset retry-safety tests.

**Spec result:** 2 findings; worst severity Major.

## Task and contract audit

| Area | Evidence-backed result |
|---|---|
| Stable contracts and exports | Present and buildable through `@omnicross/contracts/image-generation-types`, `@omnicross/core/image-generation`, and the subscriptions root factory. Built-import smoke found no exported private wire symbol/class/URL. |
| Account-bound capability evidence | Lease acquisition binds the selected account to evidence and dispatch; default evidence remains unknown/unavailable. Unknown, stale, contradictory, set-intersection, and numeric-minimum behavior is tested. |
| Strict/fail-closed parsing | JSON/base64/terminal/count negative paths fail closed, but binary decodability is not actually established; Major finding above. |
| One safe pre-accept refresh | Exactly one `401` refresh is implemented and tested with the same selected account. No post-2xx retry occurs. Ambiguous non-401 retry-safety metadata is incorrect; Major finding above. |
| Forced `redactBodies: true` | Confirmed on every adapter egress call; request/response bodies and authorization headers are redacted in trace. Raw account ID remains exposed; Major finding above. |
| Sensitive fixtures | No golden/fixture file was added. Regex scan found no API-key/JWT/long-Base64-shaped literals. Test credentials/prompts are explicit fake sentinels. |
| Cancellation and release | Acquisition signal propagation, active-job cancellation-at-most-once, timeout vs cancellation, and lease release through the orchestrator are exercised. |
| Errors and usage | Public errors use canonical messages/allow-listed fields and non-enumerable causes; unverified usage/revised prompt is omitted. Retry-safety defect noted above. |
| Artifact/reference lifecycle | Tenant hiding, same-tenant expiry, active-lease pinning, deletion, bounded reads, retention, and non-fatal telemetry are implemented/tested through ports and orchestrator. |
| Capability truthfulness | Production default remains unavailable. README explicitly marks entitlement, protocol, partials, transparency, usage, and Codex `$imagegen` unverified/unsupported. No usage, moderation, entitlement, or private-protocol stability is fabricated. |
| Session B ownership | No forbidden file changed. No endpoint, daemon/UI, Responses ingress, Files API, compact, WebSocket, stored/background Responses, or standalone web search implementation leaked into this child. |

## Coverage diagram

```text
CODE PATH COVERAGE
==================
[+] contracts / capabilities / errors
    |-- [★★★ TESTED] generate/edit discrimination, optional usage, safe error shape
    |-- [★★★ TESTED] unknown/stale/contradictory evidence, intersections, minima
    `-- [★★★ TESTED] cause/credential/prompt/Base64/account sentinel redaction

[+] core registry / ports / orchestrator
    |-- [★★★ TESTED] duplicate provider rejection; bounded/reopenable assets
    |-- [★★★ TESTED] tenant isolation, expiry, pinning, deletion
    |-- [★★★ TESTED] accepted/partial/completed ordering and exact final count
    |-- [★★★ TESTED] malformed lifecycle, iterator throws, pre/post-accept boundary
    `-- [★★★ TESTED] cancellation, retention, optional usage, non-fatal telemetry

[+] subscription adapter
    |-- [★★★ TESTED] no credential/default unavailable, stable HTTP mappings
    |-- [★★★ TESTED] one same-account 401 refresh, no retry after 2xx
    |-- [★★★ TESTED] timeout/cancel and forced body/header redaction
    |-- [★★  TESTED] malformed JSON/Base64/count/terminal rejection
    |-- [GAP] corrupt/truncated raster still passes header-only validation (Major)
    |-- [GAP] raw account ID survives debug-trace redaction (Major)
    `-- [GAP] ambiguous 5xx/timeout marked before-acceptance safe (Major)

USER FLOW COVERAGE
==================
[N/A] This child deliberately exposes no HTTP/UI/daemon user flow and advertises no
      live image capability. Images API, Responses tool, and live Codex flows belong
      to dependent Changes and must not be credited to this foundation.

Reviewed behavior groups: 13 covered, 3 correctness/privacy gaps.
No E2E/eval is appropriate for this dormant internal slice; later live capability
validation must remain explicit and quota-consuming only when authorized.
```

## Verification evidence

### Test gate

Command:

```text
npx vitest run packages/contracts/src/__tests__/image-generation-types.test.ts packages/core/src/image-generation/__tests__/ImageOrchestrator.test.ts packages/core/src/image-generation/__tests__/capabilities-errors.test.ts packages/core/src/image-generation/__tests__/ports-registry.test.ts packages/subscriptions/src/image-generation/__tests__/CodexSubscriptionImageProvider.test.ts packages/subscriptions/src/image-generation/__tests__/capabilityEvidence.test.ts packages/subscriptions/src/image-generation/__tests__/importSurface.test.ts packages/subscriptions/src/image-generation/__tests__/privateWire.test.ts
```

Result: **PASS** — 8 files, 59 tests passed, 0 failed.

Required fingerprint at the time of the gate/report:

```text
git rev-parse HEAD^{tree}
959ef0beb1d5d2b39fbd5e3b36de55c3b6dbb671
```

This fingerprint is the committed `HEAD` tree and therefore does not encode the dirty/untracked working-tree delta; the full review separately included all 6 tracked modifications and 22 untracked files.

### Typecheck

- `npm run typecheck -w @omnicross/contracts` — **PASS**
- `npm run typecheck -w @omnicross/core` — **PASS**
- `npm run typecheck -w @omnicross/subscriptions` — **PASS**

### Build

- `npm run build -w @omnicross/contracts` — **PASS** (ESM/CJS/DTS)
- `npm run build -w @omnicross/core` — **PASS** (ESM/CJS/DTS, including `image-generation` subpath)
- `npm run build -w @omnicross/subscriptions` — **PASS** (ESM/CJS/DTS)
- Built import smoke — **PASS** for contracts subpath, core subpath, subscriptions provider factory; forbidden private wire exports absent.

### Change, encoding, diff, and security checks

- `rasen validate codex-image-provider-foundation --type change --strict --json` — **PASS**, 0 issues.
- Strict UTF-8 decode of all 28 changed/untracked text files — **PASS**; no BOM, U+FFFD, or common mojibake signatures.
- `git diff --check HEAD` — exit `0`; repeated LF→CRLF warnings remain and are reported as the Minor finding above.
- Normalized tracked diff — 21 insertions across 6 export/build files; no unrelated whole-file diff.
- Secret-shaped literal scan — **PASS**; no API-key/JWT/long-Base64-shaped literals.
- Forbidden-path audit — **PASS**, count `0`.

## Final verdict

**NOT CLEAN.** Tests, typechecks, builds, strict Rasen validation, UTF-8 checks, exports, scope boundaries, fail-closed default capability, cancellation, and body redaction all pass. Shipping this child should wait for non-author fixes and re-review of the three Major findings: real binary decodability validation, account-ID-safe tracing, and honest acceptance/retry safety. The mixed line endings are a mechanical Minor cleanup.
