## 1. Remove the pre-route Base64 blocker

- [x] 1.1 Replace `packages/subscriptions/src/image-generation/privateWireResponse.ts::decodeStrictBase64` with decoded-length/padding arithmetic and a stack-safe linear alphabet scan; reject zero or over-50-MiB decoded candidates before `Buffer.from`, preserve canonical re-encode checking, and map every failure through `upstream_protocol_changed`.
- [x] 1.2 Extend `packages/subscriptions/src/image-generation/__tests__/privateWire.test.ts` with exact-limit, limit-plus-one, malformed-padding, and very-large-alphabet regressions proving no raw `RangeError`, no over-limit decode/image parse, and stable redacted errors.

## 2. Establish Images protocol dependencies and contracts

- [x] 2.1 Add direct `busboy` and `sharp` runtime dependencies plus Busboy TypeScript declarations to `packages/core/package.json`/the appropriate dev manifest, update `package-lock.json`, and confirm Sharp stays on the already-locked version used by subscriptions.
- [x] 2.2 Create `packages/core/src/image-generation/openai-images/types.ts` defining finite `ImageApiLimits`, trusted runtime/tenant resolution, optional reference/remote/user-fingerprint ports, request resource leases, and the `ImageOpenAIOperationContribution`/`ImageApiContributions` public shapes without credentials, content, file paths, or private wire fields.
- [x] 2.3 Create `packages/core/src/image-generation/openai-images/normalizeOptions.ts` for prompt/model alias/default, `n`, quality, GPT Image dimensions, background, format/compression, moderation, stream/partial count, and keyed user fingerprint normalization; add table tests proving invalid combinations fail before provider acquisition.

## 3. Implement bounded body and local asset ingestion

- [x] 3.1 Implement `openai-images/readJsonBody.ts` with Content-Type/Content-Encoding checks, declared and observed byte limits, fatal UTF-8 decoding, abort propagation, closed reference-object shapes, and stable invalid/too-large errors; add declared, chunked, malformed UTF-8, and abort tests.
- [x] 3.2 Implement `openai-images/TemporaryImageAsset.ts` and a request resource scope using an unpredictable verified directory beneath an injected safe temp root/`os.tmpdir()`, exclusive restrictive files, fresh bounded `open()` streams, idempotent writer/lease/spool cleanup, and no public/local path exposure.
- [x] 3.3 Implement `openai-images/validateRaster.ts` with signature-derived PNG/JPEG/WebP format, single-page Sharp metadata plus full raw pixel decode, pixel/channel/raw-byte budgets, complete-container/truncation checks, and trusted width/height/alpha metadata; add forged MIME, corrupt/truncated, zero/huge dimension, animation, and pixel-bomb tests.
- [x] 3.4 Implement `openai-images/readMultipartEdit.ts` with Busboy streaming into the resource scope and limits for aggregate/per-file bytes, files, fields, parts, header pairs, field names/values, truncation, malformed boundary, duplicate mask, and premature close; preserve repeated `image`/`image[]` order and never trust caller filenames/MIME.
- [x] 3.5 Implement pre-dispatch edit validation for one-to-sixteen images and an optional mask matching the primary image's decoded format/dimensions with a real alpha channel; add valid and mismatched mask/multi-reference tests with upstream start count fixed at zero on failure.

## 4. Resolve JSON edit carriers safely

- [x] 4.1 Implement `openai-images/resolveImageInput.ts` for closed `file_id`/`image_url` objects and a bounded manual data-URL Base64 decoder that length-checks before allocation, materializes into the temp scope, and runs the common raster validator.
- [x] 4.2 Adapt the injected `ImageReferenceStore`/minimal asset port so `file_id` uses trusted tenant identity, holds found leases through the job, distinguishes owning-tenant expiry, hides cross-tenant existence, and returns `unsupported_capability` when no resolver is wired without adding Files routes.
- [x] 4.3 Implement `openai-images/safeRemoteImageResolver.ts` disabled by default, using manual redirects and an Undici address-pinning connector; reject URL credentials/non-HTTP(S)/loopback/private/link-local/multicast/unspecified/metadata addresses including IPv4-mapped IPv6, revalidate each hop, and cap redirects/time/headers/download bytes before common raster validation.
- [x] 4.4 Add resolver tests with controlled DNS/connect doubles for no-policy/no-network, data URLs, redirect-to-private, DNS rebinding, mixed public/private answers, oversized/chunked downloads, timeouts, abort, and redacted URL-query credentials.

## 5. Implement bounded OpenAI Images output mapping

- [x] 5.1 Create `openai-images/imageApiErrors.ts` mapping every `ImageGenerationError` to the snake_case OpenAI Images JSON/SSE allow-list, safe statuses/`Retry-After`/`x-request-id`, verified coarse moderation details, and generic redacted fallback; test token/Cookie/prompt/path/URL/Base64/cause sentinels.
- [x] 5.2 Create `openai-images/imageApiResponse.ts` to bounded-read final assets, Base64-encode into secure request spools, withhold HTTP 200 until all outputs stage successfully, and stream an exact-`n` JSON envelope with backpressure, truthful optional revised prompts/usage, and no default-zero/cost fields.
- [x] 5.3 Create `openai-images/imageApiSse.ts` that commits headers at `accepted`, emits indexed `image_generation.*`/`image_edit.*` partial/completed frames from complete assets, waits for drain or abort before pulling more events, emits one safe post-header error frame when writable, and never synthesizes partials or writes after disconnect.
- [x] 5.4 Add response/SSE tests for exact counts and byte equality, omitted/provided usage, multiple outputs, monotonic per-output partial indexes, slow-client drain, spool/output limits, pre/post-accept errors, cancellation, cleanup, and absence of duplicate large in-memory Base64 arrays.

## 6. Build the generate/edit handlers and exports

- [x] 6.1 Implement `openai-images/generateHandler.ts` to resolve trusted runtime/tenant/request ID, parse/normalize JSON, call `ImageOrchestrator.run` once, and choose non-stream/SSE mapping while ensuring all parser/provider/resource exits are cancelled and cleaned.
- [x] 6.2 Implement `openai-images/editHandler.ts` to select JSON versus multipart by Content-Type, resolve/validate ordered assets and mask before orchestrator start, and use the same terminal response/error/resource semantics as generation.
- [x] 6.3 Implement `openai-images/contributions.ts` returning non-self-registering `images.generate` and `images.edit` contributions plus a stable `all` collection, then export only the safe frontend surface from `packages/core/src/image-generation/index.ts` and `packages/core/src/index.ts` without adding bootstrap registration.
- [x] 6.4 Add real `routeRequest`/`OpenAIOperationRegistry` integration tests proving authenticated extension dispatch occurs before shared body reading, missing/unregistered contributions remain 501, trusted `route.apiKeyId` scopes assets, raw route tokens never become identities/credentials, and the three forbidden ownership areas are untouched.

## 7. Prove protocol, SDK, and security contracts

- [x] 7.1 Build a real local HTTP contract harness with `ProviderProxyRouteMap`, operation registry, both contributions, deterministic runtime resolver, fake `ImageProvider`, valid PNG/JPEG/WebP/alpha fixtures, controllable partial/failure/cancel events, and secret-capture assertions.
- [x] 7.2 Add current-stable official JavaScript `openai` SDK smoke tests for generate, multipart single/multi-image edit, mask, transparent PNG/WebP, non-stream Base64, stream partial/completed, cancellation, and representative errors against the local harness; record the tested SDK version.
- [x] 7.3 Add a pinned, non-vendored Python OpenAI SDK contract script/requirements convention and launcher against the same local harness covering generate and multipart edit/mask response decoding; run it with an explicit interpreter and record a truthful pass or unsupported environment rather than substituting a handwritten client.
- [x] 7.4 Add end-to-end protocol/security tests for unsupported entitlement/capability, file resolver absence/not-found/expired/cross-tenant, forged MIME, oversized JSON/multipart/download/output, remote SSRF/rebinding, client disconnect, temporary cleanup, and audit/snapshot secret sentinels with provider start counts asserted.

## 8. Verify and hand off the child Change

- [x] 8.1 Run focused Vitest suites for the new core Images API modules and the subscription Base64 regression, then run any directly affected existing image-generation/operation-dispatch tests once after integration.
- [x] 8.2 Run `npm run typecheck -w @omnicross/core` and `npm run typecheck -w @omnicross/subscriptions`, then build those two workspaces after tests; include contracts only if implementation changes its public types/exports.
- [x] 8.3 Run `rasen validate codex-images-api-surface --type change --strict --json`; strictly decode every candidate-tree text file including untracked files as UTF-8, reject BOM/U+FFFD/mojibake, run `git diff --check`, secret-scan content-bearing sentinels, and verify zero changes under `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, or `providerProxyShared.ts`.
- [x] 8.4 Write apply/verification evidence documenting BASE_SHA `eb2d20a8278870f36af2996914b831f7b8446484`, public operation contribution exports and injection dependencies, JS/Python SDK versions/results, capability matrix, fail-closed live subscription status, unsupported generic Files/Responses/production wiring items, test/typecheck/build commands, and durable findings for the Responses child planner.
