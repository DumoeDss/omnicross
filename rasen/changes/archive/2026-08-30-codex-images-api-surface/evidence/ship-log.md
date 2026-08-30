# Ship Log: codex-images-api-surface

**Date:** 2026-08-30T05:59:41+08:00  
**Mode:** local  
**Branch:** feat/codex-hosted-tools-and-images  
**Commit:** 78d3b6c635dbbfb7e07ae7d871bc361e66554e72  
**Tree:** 93575c32695b4a48300827b47724fb14de38c0be  
**Parent:** a468f3ccfcf1575b254d34400d006d6f73b0584e  
**BASE_SHA:** eb2d20a8278870f36af2996914b831f7b8446484  
**Status:** Committed (delivery deferred to portfolio level)  
**Archive timing:** on-merge  
**Archived in ship:** no

## Pre-Flight Results

- Verification: PASS — independent review cycle Round 3 is CLEAN with 0 Blocker, 0 Major, 0 Minor, and 0 Trivial findings open.
- Tasks: 30/30 complete.
- Change validation: `rasen validate codex-images-api-surface --type change --strict --json` passed with zero issues.
- Candidate identity: 44 staged paths, 5,196 insertions and 26 deletions; staged tree exactly matched the reviewed Round-3 tree `93575c32695b4a48300827b47724fb14de38c0be` before commit.
- Working tree/index: clean after the commit, excluding intentionally ignored Rasen evidence.

## Baseline and Main Integration

- The required portfolio baseline `eb2d20a8278870f36af2996914b831f7b8446484` is an ancestor of the committed branch.
- The local `origin/main` ref is `83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594`; it was already an ancestor of the pre-ship HEAD and remains an ancestor of this commit.
- Merge commit `a468f3ccfcf1575b254d34400d006d6f73b0584e` has `83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594` as its second parent. No fetch or merge was performed during this child ship stage.
- Foundation commit `1f1845a39f4c289d5f7e960dd0e9a80ebf1cc19e` and both upstream-main merge commits were preserved.

## Exported Contribution Interfaces

`@omnicross/core` and `@omnicross/core/image-generation` export the following non-self-registering integration surface:

```ts
createImageApiContributions(
  deps: ImageApiContributionsDeps,
): ImageApiContributions

interface ImageApiContributionsDeps {
  orchestrator: ImageOrchestrator;
  resolveRuntime: ImageApiRuntimeResolver;
  createRequestId?: () => string;
  now?: () => number;
  createResourceScope?: (
    limits: ImageApiLimits,
    signal: AbortSignal,
  ) => Promise<ImageRequestResourceScope>;
  audit?: (record: ImageApiAuditRecord) => void | Promise<void>;
}

interface ImageApiContributions {
  generate: { operationId: 'images.generate'; handler: OpenAIOperationHandler };
  edit: { operationId: 'images.edit'; handler: OpenAIOperationHandler };
  all: readonly ImageOpenAIOperationContribution[];
}
```

- The factory validates the required orchestrator/runtime resolver and returns frozen `images.generate`, `images.edit`, and `all` contributions.
- The final integrator owns registry registration. This child does not modify or self-register through the shared classifier, registry, Responses ingress, or daemon/UI bootstrap.
- `resolveRuntime(context)` supplies trusted tenant/provider/model identity, finite limits, aliases, and optional reference store, remote resolver, user fingerprinting, and retention policy. Raw bearer tokens are never used as tenant identity.
- `createSafeRemoteImageResolver(options)` is exported separately and remains opt-in.

## Capability Matrix

| Capability | Status | Boundary |
|---|---|---|
| `POST /v1/images/generations` JSON | Implemented | Exported as `images.generate`; bounded JSON, normalized options, exact-`n` non-stream output, or SSE. |
| `POST /v1/images/edits` multipart | Implemented | Exported as `images.edit`; ordered `image`/`image[]`, 1–16 inputs, optional alpha mask, bounded Busboy streaming. |
| JSON edits | Implemented | Exactly one of `image` or ordered `images`; closed data URL, `file_id`, or `image_url` carriers plus optional mask. |
| PNG/JPEG/WebP validation | Implemented | Signature/container checks, single-frame metadata, complete bounded Sharp raw decode, and pixel/channel/raw-byte ceilings. |
| Mask validation | Implemented | Mask must match primary format and dimensions and contain a real alpha channel before provider start. |
| Multiple outputs | Implemented | HTTP 200 is withheld until all exact-`n` outputs stage within per-output, aggregate, and spool limits. |
| Transparent output | Conditional and truthful | Supported only when the provider emits an alpha-capable PNG/WebP with verified alpha; never synthesized. |
| Partial image stream | Conditional and truthful | Emits indexed, monotonic SSE only from provider-emitted complete partial assets; no synthetic partials. |
| `file_id` references | Optional injected capability | Trusted tenant scoping and leases; no generic Files API is added. Missing resolver fails closed. |
| Remote `image_url` | Disabled by default | Optional hardened resolver validates and pins public addresses on every redirect hop and enforces redirect/time/header/download limits. |
| Usage, revised prompt, moderation detail | Truthful optional mapping | Omitted unless supplied by verified provider events; no default-zero usage/cost or fabricated moderation evidence. |
| Codex/ChatGPT subscription generation | Fail closed for live production | No permitted positive entitlement/private-wire fixture exists, so entitlement, usage, moderation, partial, and transparency support are not invented. |

## Unsupported and Deferred Scope

- Responses hosted `image_generation` execution and `image_generation_call` events are not implemented by this child; the dependent Responses child consumes the exported orchestrator/provider/reference seams and supplies its own injectable hosted-image contribution.
- Independent `images` permission/configuration, daemon/UI/router composition, and a persistent production reference backend are deferred to the production-wiring child.
- Generic Files API routes, `response_format`, and `input_fidelity` are unsupported here.
- Standalone web search, compact, Responses WebSocket, and stored/background Responses remain outside this portfolio scope.
- No production live-success claim is made without verifiable upstream capability and entitlement evidence.

## SDK and Runtime Dependency Evidence

- Official JavaScript SDK: `openai@7.8.0`, root contributor tooling only, guarded by Node major 22+; published `@omnicross/core` runtime remains Node `>=20.9`.
- Official Python SDK: `openai==3.5.0` on Python 3.12.4 through the explicit non-vendored test environment.
- Direct/required runtime resolution: `busboy@1.6.0`, `streamsearch@1.1.0`, `sharp@0.35.4`, and `undici@6.28.0`.

## Test Gate

Required scope: the complete core/subscriptions image-generation surface, operation dispatch integration, official SDK contracts, contributor runtime policy, and contracts/core/subscriptions typecheck/build. This covers the shared public capability contract, orchestrator lifecycle, subscription fail-closed behavior, JSON/multipart/asset security boundaries, output/SSE mapping, registry dispatch, and published declarations affected by the child.

- `npx vitest run packages/core/src/image-generation packages/subscriptions/src/image-generation packages/core/src/openai-operation/__tests__/openAIOperation.test.ts packages/core/src/openai-operation/__tests__/openAIOperationRegistry.test.ts packages/core/src/provider-proxy/__tests__/openAIOperationDispatch.test.ts packages/core/src/provider-proxy/__tests__/ProviderProxy.lastResort500.test.ts` — PASS: 17 files passed, 1 environment-gated Python file skipped; 213 tests passed, 1 skipped.
- `npm run test:node-tooling-policy` — PASS: 2/2.
- `npm run test:images-sdk-contract` — PASS: 9 JavaScript tests; the Python test was environment-gated and skipped in this combined command.
- Explicit `OMNICROSS_PYTHON_SDK_EXECUTABLE` invocation of `pythonSdk.contract.test.ts` — PASS: 1/1 with Python 3.12.4 and `openai==3.5.0`.
- `npm run typecheck -w @omnicross/contracts` — PASS.
- `npm run typecheck -w @omnicross/core` — PASS.
- `npm run typecheck -w @omnicross/subscriptions` — PASS.
- `npm run build -w @omnicross/contracts` — PASS: ESM/CJS/DTS.
- `npm run build -w @omnicross/core` — PASS: ESM/CJS/DTS.
- `npm run build -w @omnicross/subscriptions` — PASS: ESM/CJS/DTS.
- Test/build tree: `93575c32695b4a48300827b47724fb14de38c0be`.

## Safety and Integrity Gates

- `git diff --cached --check` passed before commit; the committed tree is byte-for-byte the reviewed Round-3 candidate tree.
- Strict UTF-8 decode across all 44 committed candidate paths: 0 failures; 0 BOM; 0 U+FFFD; 0 common mojibake signatures.
- Line-ending audit: 0 mixed-EOL files.
- High-confidence private-key/API-key/JWT/Bearer/oversized-literal-Base64 shape scan: 0 matching files. Test-only redaction sentinels remain synthetic and non-secret.
- Added-line structural scan: 0 TODO, FIXME, `console.log`, or `debugger` remnants.
- Forbidden-path audit: 0 changes under `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, or `providerProxyShared.ts`.
- LEAD-owned stash object `522e3ea0277ec927cb713fb20764ec843369ccb6` remained untouched.

## Delivery

- Local child commit created; no push, PR, merge, deploy, or archive operation was performed.
- Portfolio delivery remains the parent Change's responsibility after all children are complete.

## Archive
**Date:** 2026-08-30T21:59:59.667Z
**Ship commit:** 78d3b6c635dbbfb7e07ae7d871bc361e66554e72
**Outcome:** archived at E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross--codex-hosted-tools-and-images\rasen\changes\archive\2026-08-30-codex-images-api-surface
**Transaction:** 02f5993c-a287-4b5c-aad1-2e011209ca59
