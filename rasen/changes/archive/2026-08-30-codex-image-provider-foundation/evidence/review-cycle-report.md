# Review Cycle: codex-image-provider-foundation

**Round:** 1/3  
**Tier:** A  
**Status:** **CLEAN** — all 0 Blocker / 3 Major findings are independently confirmed resolved.  
**Mode:** non-author delta re-review; report-only.  
**Reviewer:** independent Codex reviewer, not the implementation/fixer author.  
**Fixer:** the implementation/fixer worker that produced the current working-tree delta; no fixer identity was surfaced to this reviewer.  
**Branch / HEAD:** `feat/codex-hosted-tools-and-images` / `eb2d20a8278870f36af2996914b831f7b8446484`.

No product code, tests, planning artifacts, or run-state were edited by this reviewer. The only reviewer write is this report.

## Round summary

| Round | Canonical prior findings (B/Ma/Mi/T) | Triage | Fixed by | Confirmed by (non-author) | Prior findings resolved |
|---|---:|---|---|---|---:|
| 1 | 0/3/1/0 | 2 non-trivial implementation fixes; 1 retry-contract correction; 1 mechanical newline normalization | implementation/fixer worker | independent Codex reviewer, source diff + adversarial probes + test/typecheck/build gates | 4/4 |

One new Minor was found while probing the decoded-byte boundary. It is accepted-known for this dormant provider slice and does not reopen any Blocker/Major finding; see **Accepted-known Minor** below.

## Fix delta reviewed

The re-review was limited to the fixer surfaces corresponding to the four prior findings:

- Complete decode and limits: `packages/subscriptions/src/image-generation/privateWireResponse.ts`, its `privateWire.test.ts`, `packages/subscriptions/package.json`, and `package-lock.json`.
- Trace identity separation: `CodexSubscriptionImageProvider.ts`, `packages/core/src/pipeline/upstreamFetch.ts`, and `CodexSubscriptionImageProvider.test.ts`.
- Acceptance-aware retry metadata: `privateWireErrors.ts`, `CodexSubscriptionImageProvider.ts`, and the two image-adapter test files.
- Newline cleanup: the six pre-existing contracts/core/subscriptions export/build files named in the prior report.

`sharp@0.35.4` is a direct runtime dependency of `@omnicross/subscriptions`; the package engine was aligned from Node `>=20` to `>=20.9`, matching sharp's `>=20.9.0` requirement. The installed Windows x64 runtime loaded as sharp `0.35.4` / libvips `8.18.6` under Node `v24.14.0`. Both ESM and CJS built-import smoke tests loaded the subscriptions package and sharp successfully.

## Prior-finding dispositions

### 1. [Major] Header-only/corrupt image data was certified as independently decodable — RESOLVED

**Fix evidence:** `privateWireResponse.ts` now enforces a 70,000,000-byte response cap, a 50 MiB encoded-image byte cap, an 8,294,400-pixel cap, a derived four-channel raw-memory cap, complete PNG/JPEG/WebP container termination, and a full `sharp(..., { failOn: 'warning', limitInputPixels, sequentialRead: true }).raw().toBuffer()` decode before constructing `InMemoryImageAsset`. Metadata format/dimensions and decoded width/height/channel/byte counts must agree before `independentlyDecodable: true` can be reached.

**Independent confirmation:** the focused suite accepts valid PNG, JPEG, WebP VP8, and WebP VP8L and rejects all four truncated forms. A separate adversarial probe rejected the old 26-byte/header-only PNG reproduction, corrupt PNG/JPEG/VP8/VP8L payloads, a 2,881×2,880 image one row above the pixel limit, and a declared body one byte above the response cap. A 2,880×2,880 RGBA image at exactly 8,294,400 pixels / 33,177,600 raw bytes decoded successfully. A 50 MiB + 1 byte candidate also failed closed and never produced an asset; its non-canonical internal error is recorded separately as a Minor.

**Disposition:** **RESOLVED**, confirmed by a non-author.

### 2. [Major] Raw selected account ID entered debug trace under forced body redaction — RESOLVED

**Fix evidence:** the adapter now computes `sha256:<64 lowercase hex>` and passes it as `traceAccountFingerprint`, while retaining the raw `accountId` in the existing proxy context. `fetchUpstream` uses the fingerprint only for `writeUpstreamTrace`; dispatcher resolution, allowance header attribution, and route-activity internals continue to consume `ctx.accountId`.

**Independent confirmation:** the adapter test asserts the resolver receives `RAW_ACCOUNT_ID_SHOULD_NEVER_REACH_TRACE`, the JSONL trace contains only a SHA-256 fingerprint, and bodies/token/account/prompt sentinels are absent. An additional allowance-store probe with both identities present returned:

```json
{"rawAttributed":true,"fingerprintAttributed":false}
```

This proves trace sanitization did not break raw internal account attribution.

**Disposition:** **RESOLVED**, confirmed by a non-author.

### 3. [Major] Ambiguous HTTP/transport failures claimed `before_acceptance` — RESOLVED

**Fix evidence:** `privateWireErrors.ts` now uses `retrySafety: 'unknown'` for rate limits, usage limits, moderation responses, 408/504 timeouts, all 5xx responses, and other ambiguous protocol failures. Only explicit 401/403 authentication rejection retains `before_acceptance`. The provider catch path supplies `unknown` before a provider acceptance event and `after_acceptance` after a 2xx acceptance event; abort timeout serialization omits retry safety rather than asserting pre-acceptance safety.

**Independent confirmation:** focused tests assert 500, 503, and 504 are `unknown`, connection reset is `unknown`, 403 remains the explicit pre-accept authentication case, and no retry occurs after 2xx. The direct serialization probe returned:

```json
{
  "timeout": {"code":"image_generation_timeout","httpStatus":504},
  "transport": {"code":"image_generation_failed","httpStatus":502,"retrySafety":"unknown"}
}
```

No ambiguous transport, 5xx, or timeout path observed by this review advertises `before_acceptance`.

**Disposition:** **RESOLVED**, confirmed by a non-author.

### 4. [Minor] Six pre-existing files had mixed CRLF/LF endings — RESOLVED

**Independent byte inspection:** all six files are UTF-8 without BOM, contain CRLF only, and have zero bare LF:

| File | CRLF | Bare LF |
|---|---:|---:|
| `packages/contracts/package.json` | 161 | 0 |
| `packages/contracts/src/index.ts` | 37 | 0 |
| `packages/contracts/tsup.config.ts` | 38 | 0 |
| `packages/core/src/index.ts` | 109 | 0 |
| `packages/core/tsup.config.ts` | 96 | 0 |
| `packages/subscriptions/src/index.ts` | 64 | 0 |

`git diff --check HEAD` exits 0 without the previous LF→CRLF warnings, and the normalized Git diff still shows only the intended local insertions rather than whole-file rewrites.

**Disposition:** **RESOLVED**, confirmed by a non-author.

## Accepted-known Minor

### [Minor] Maximum-size Base64 validation can throw a raw `RangeError`

An adversarial direct-parser probe created a syntactically shaped candidate whose decoded bytes were 50 MiB + 1. The candidate failed closed, did not construct an asset, and cannot complete the job, but the large anchored Base64 regular expression threw before `decodeStrictBase64()` reached its explicit decoded-byte check:

```json
{"bytes":52428801,"encodedLength":69905068,"outcome":"rejected","name":"RangeError","message":"Maximum call stack size exceeded","constructor":"RangeError"}
```

At provider level this is caught and normalized, so it does not expose the runtime message or violate the no-completion guarantee. It is accepted for this dormant, non-routed foundation slice because the 70,000,000-byte body cap bounds the input and all public behavior remains fail-closed. Before enabling a public Images/Responses route, derive decoded length from Base64 length/padding and reject over-limit input before running the full-string regular expression so malformed wire data consistently maps to `upstream_protocol_changed`.

## Verification evidence

### Focused regression gate

Command:

```text
npx vitest run packages/contracts/src/__tests__/image-generation-types.test.ts packages/core/src/image-generation/__tests__/ImageOrchestrator.test.ts packages/core/src/image-generation/__tests__/capabilities-errors.test.ts packages/core/src/image-generation/__tests__/ports-registry.test.ts packages/subscriptions/src/image-generation/__tests__/CodexSubscriptionImageProvider.test.ts packages/subscriptions/src/image-generation/__tests__/capabilityEvidence.test.ts packages/subscriptions/src/image-generation/__tests__/importSurface.test.ts packages/subscriptions/src/image-generation/__tests__/privateWire.test.ts
```

Result: **PASS** — 8 files, 71 tests passed, 0 failed.

Coverage rationale: these are the same eight foundation/adapter files used by the original review gate, now including the fixer's full-decode fixtures, retry-safety cases, transport reset case, and raw-account trace assertion. The additional inline adversarial probe covered corruption and byte/pixel/raw-memory boundaries not represented by the committed tests.

### Typecheck

- `npm run typecheck -w @omnicross/contracts` — **PASS**.
- `npm run typecheck -w @omnicross/core` — **PASS**.
- `npm run typecheck -w @omnicross/subscriptions` — **PASS**.

### Build and runtime import

- `npm run build -w @omnicross/contracts` — **PASS**, ESM/CJS/DTS.
- `npm run build -w @omnicross/core` — **PASS**, ESM/CJS/DTS, including the image-generation subpath.
- `npm run build -w @omnicross/subscriptions` — **PASS**, ESM/CJS/DTS with sharp externalized as its declared runtime dependency.
- ESM built-import smoke — **PASS** for contracts image types, core image-generation, subscriptions factory; no private wire export detected.
- CJS built-import smoke — **PASS**; core orchestrator and subscriptions factory loaded and `require('sharp').versions.sharp` returned `0.35.4`.
- `npm ls sharp --all` / `npm explain sharp` — **PASS**; one direct `@omnicross/subscriptions -> sharp@0.35.4` dependency.

### Change, security, encoding, and scope checks

- `rasen validate codex-image-provider-foundation --type change --strict --json` — **PASS**, 1 item, 0 issues.
- Strict UTF-8 decoding of all 31 changed/untracked code files — **PASS**; no BOM, U+FFFD, or common mojibake marker.
- Secret-shaped literal scan over the 30 changed package source/test files — **PASS**, 0 matches. Explicit fake prompt/token/account sentinels remain test-only.
- Forbidden-path audit over the same working delta — **PASS**, 0 paths under `packages/core/src/openai-operation/**`, and no `openaiResponsesIngress.ts` or `providerProxyShared.ts` change.
- `git diff --check HEAD` — **PASS**, exit 0.
- `git status --short --branch` — expected dirty foundation implementation only; no unrelated reviewer edit outside this report.

### Tree identity

Required command and result:

```text
git rev-parse HEAD^{tree}
959ef0beb1d5d2b39fbd5e3b36de55c3b6dbb671
```

The branch remains based at `eb2d20a8278870f36af2996914b831f7b8446484`. As in the original review, `HEAD^{tree}` identifies the committed baseline and cannot encode the dirty/untracked implementation. For additional working-state identity, a SHA-256 over sorted `git ls-files --modified --others --exclude-standard -z` path/content pairs for the 31 code files was:

```text
0f92ad5c365edf48cf6b392d529c7d7eda506ab6d2e81978f1f0daa6730c20c5
```

## Final disposition

**CLEAN.** All prior Blocker/Major findings are independently confirmed resolved in Round 1, and the prior newline Minor is also resolved. The one new accepted-known Minor remains loud in this report and should be corrected before this dormant adapter is exposed through a public Images or Responses route.

## Post-review trivial delta confirmation

**Reviewer:** the same independent non-author reviewer.  
**Pre-fix candidate tree:** `ba3e1a9164fddf1ce67f4cc8557c296284d84222`.  
**Confirmed candidate tree:** `5281bc4d34ede08afd370b0cbacfe41610f44e63`.  
**Verdict:** **CLEAN** — no semantic change or line-ending corruption.

The ship-preflight fixer removed one surplus EOF LF from exactly the 11 files listed in `handoff/shipper-1.md`. Independent `git diff --name-status` and `--numstat` comparison between the two candidate trees showed exactly those 11 paths, each with `0` insertions and `1` deletion. For every path, byte inspection confirmed that the old blob equals the new blob plus exactly one final `0A`; the new blob retains exactly one EOF LF, is strict UTF-8 without BOM or mojibake markers, uses LF consistently, and exactly matches the current worktree file.

Checks:

- `git diff --check HEAD` — **PASS**, exit 0 for tracked changes.
- `git diff --check HEAD 5281bc4d34ede08afd370b0cbacfe41610f44e63` — **PASS**, exit 0 across the complete 31-path candidate tree, including files still untracked in the restored index.
- `git diff --check ba3e1a9164fddf1ce67f4cc8557c296284d84222 5281bc4d34ede08afd370b0cbacfe41610f44e63` — **PASS**, exit 0 for the trivial delta itself.
- `npx vitest run packages/core/src/image-generation/__tests__/capabilities-errors.test.ts packages/core/src/image-generation/__tests__/ports-registry.test.ts packages/subscriptions/src/image-generation/__tests__/capabilityEvidence.test.ts` — **PASS**, 3 files / 12 tests.
- `git diff --cached --name-status` — empty; the index remains restored.

The final review-cycle disposition remains **CLEAN**. The previously accepted-known maximum-size Base64 Minor is unchanged.
