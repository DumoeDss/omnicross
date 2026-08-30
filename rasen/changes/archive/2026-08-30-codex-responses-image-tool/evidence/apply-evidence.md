# Apply evidence: codex-responses-image-tool

## Scope and baseline

- Required baseline: `eb2d20a8278870f36af2996914b831f7b8446484` (verified ancestor of the working branch).
- Product changes are confined to `packages/core/src/image-generation/ImageOrchestrator.ts`, `packages/core/src/image-generation/index.ts`, and `packages/core/src/image-generation/responses/**`.
- No authored change exists under `packages/core/src/openai-operation/**`, any `openaiResponsesIngress.ts`, `providerProxyShared.ts`, or the Native Responses profile/driver/affinity/core modules.
- The contribution is dormant and non-self-registering. Final Responses ingress composition remains a later Change.

## Exported integration interface

`@omnicross/core/image-generation` and the root core barrel export:

- `createResponsesImageGenerationContribution(deps)`
- `inspectResponsesImageRequest(input)` and `validateResponsesImageSelection(admission, selection)`
- `ResponsesImageGenerationContribution`, request-scope/runtime/admission/selection/event/item types
- `ResponsesImageStateStore` and the bounded deterministic `InMemoryResponsesImageStateStore`

The final integrator must perform this exact order:

1. `inspectRequest` over the user request.
2. Obtain a real selected-call plan from the main Responses model path; do not infer selection from prompt text.
3. `validateSelection` against the inspected declaration and tool-choice policy.
4. Authorize `previous_response_id` through existing Responses affinity, then create one request scope with trusted tenant/provider/image-model/limit/signal inputs.
5. Execute selected image calls serially through `scope.executeSelectedCall(call, sharedAllocator)`, using the same response-global allocator as non-image output/events.
6. Buffer successful image items and call `scope.commit(responseId)` before exposing the containing Response as successful.
7. Insert the returned items at their reserved output indexes and publish the normal containing Response terminal.
8. Always call `scope.dispose()` in `finally`; it waits for active execution, releases all leases, and rolls back newly retained uncommitted references.

Identity ownership is split deliberately: the image contribution creates unpredictable `ig_` item/call IDs; the injected allocator owns response-global output indexes and partial-event sequence numbers; the final integrator owns mixed-output insertion, non-image allocation, and the containing Response terminal. A completed event carries a wire-safe `image_generation_call` item with Base64 `result`; only real provider partials produce `response.image_generation_call.partial_image` events.

## State, references, and failure behavior

- State commits inherited plus newly completed call bindings atomically. Exact replay is idempotent; conflicting response/call writes fail with a stable image error.
- Direct call IDs and authorized previous responses are tenant-scoped. Cross-tenant/capacity-evicted state is non-disclosing `not_found`; owning-tenant TTL expiry is distinguishable only through bounded tombstones.
- State leases and `ImageReferenceStore` leases are held together for the request lifetime. Cleanup cannot remove leased entries; capacity eviction prefers expired unleased entries, then LRU entries.
- Generate never forwards retained images. Edit requires retained authorized images. Auto chooses edit iff such images exist.
- Every selected call is `n=1`, uses the trusted image model and moderation `auto`, and requests provider streaming only for requested real partials.
- One decoded-byte budget covers every partial and final artifact in the scope. Declared bytes are reserved before reads; exact metadata/byte agreement and abort are checked before Base64 delivery.
- Provider failures, protocol drift, allocator failures, cancellation, retention mismatch, and unexpected exceptions serialize only allow-listed stable image fields. No usage, moderation result, entitlement, provider-private reference, credential, raw cause, prompt, or image content is invented in errors/state/audit data.

## Capability matrix

| Capability | Contribution contract | Current Codex subscription evidence |
| --- | --- | --- |
| Generate / edit / auto | Implemented and fake-provider tested; same acquired lease must affirm `responsesTool` | Fail closed: no verified image model or entitlement |
| Multiple calls / mixed outputs | Serial execution with distinct call IDs and global allocator-owned indexes | No verified production selector yet |
| Previous-response / direct-call editing | Tenant-scoped retained state with dual leases and atomic carry-forward | Local contract only; no private upstream claim |
| Partial images | Real provider partials only; bounded Base64 and global monotonic sequence allocation | Unsupported until capability evidence affirms streaming partials |
| Transparent output / usage / moderation details | Requested options and stable error contract only | No claim of actual support, usage, or moderation result |

Not supported by this Change: final ingress wiring, a production main-model image selector, arbitrary initial Responses URL/data/file image carriers, generic Files API, stored/background Responses, Responses WebSocket, compact, standalone web search, or Codex host `$imagegen` enablement.

## Verification

- `npx vitest run packages/core/src/image-generation/responses` — 4 files, 52 tests passed.
- Expanded affected regression command over Responses image, orchestrator/capability/registry, Images output/security, and Responses profile/affinity/public-export suites — 13 files, 164 tests passed.
- `npx tsc -p packages/core/tsconfig.typecheck.json --noEmit` — passed.
- `npx tsup` from `packages/core` — ESM, CJS, and DTS builds passed; final DTS build completed in 40.192 s.
- The workspace-local `pnpm --filter @omnicross/core typecheck` wrapper could not locate `tsc` because this worktree has no independent `node_modules`; the repository's established `npx` toolchain above ran the same TypeScript project successfully.
- `rasen validate codex-responses-image-tool --type change --strict --json` — valid, zero issues.
- Strict UTF-8/no-BOM/U+FFFD/mojibake audit — passed for 13 implementation/test/artifact files, including untracked source files.
- Static high-confidence credential/private-key sentinel scan — passed for all 11 candidate product files; runtime secret-sentinel assertions are also included in the test suites.
- Forbidden-path audit — passed across all 11 candidate product paths.
- Working-tree `git diff --check` and temporary-index candidate `git diff --cached --check` — passed. Candidate tree: `9d38da18c93e1dacb0903403850495cb79fe64e3`.
- Built ESM root and `image-generation` entrypoint import smoke — passed for the contribution factory and state-store export.

## Durable findings for production wiring

1. Native Responses still has no verified hosted-image selection seam; production wiring must inject a real selected-call plan and one allocator shared with all other response events.
2. Existing Responses affinity authorizes the previous response, while the image state store independently enforces tenant ownership and holds artifact leases; both layers are required.
3. The request scope is the atomic lifecycle boundary: execute calls serially, commit inherited/new bindings before success, and dispose in `finally` so containing-response failures delete only uncommitted new references.
