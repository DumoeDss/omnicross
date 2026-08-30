## Context

The two prerequisite children are review-clean at HEAD. `@omnicross/contracts` now defines provider-neutral image requests, events, capabilities, stable errors, and references. `@omnicross/core/image-generation` supplies `ImageOrchestrator`, `ImageReferenceStore` leases, bounded asset reads, and OpenAI Images option/input helpers. The Images API child exports dormant `images.generate`/`images.edit` contributions and proved bounded binary handling with fake providers and official SDK clients.

The newly landed Responses core/profile owns route classification, upstream execution, cancellation, credential affinity, usage observation, and byte relay. `openaiResponsesIngress.ts` currently relays one upstream response and has no hosted-tool execution hook. This child cannot edit it, `providerProxyShared.ts`, or `packages/core/src/openai-operation/**`; it must instead export a complete execution contribution that a final integrator can inject in a small composition change.

Hosted-tool selection and hosted-tool execution are different responsibilities. A main Responses model decides whether an automatic request selects an image call and supplies a prompt/plan. Local image execution then validates that selection and calls `ImageOrchestrator`. The repository has no verified private Codex subscription image selection/execution exchange, so this Change cannot invent a production selector or reinterpret ordinary text as a selection. Tests use explicit fake selected-call plans; production remains fail-closed until the integrator and verified capability evidence are supplied.

## Goals / Non-Goals

**Goals:**

- Export one frozen, non-self-registering Responses `image_generation` contribution with explicit request inspection, selection validation, request-scope execution, commit, and disposal contracts.
- Reuse the existing image option constraints, orchestrator, stable errors, asset reads, retention store, abort signal, and account hints without an Images HTTP round-trip.
- Produce official completed `image_generation_call` items and real-only `response.image_generation_call.partial_image` payloads while cooperating with a response-global output/sequence allocator.
- Preserve image context through `previous_response_id` chains and direct call-ID references using tenant-scoped state plus existing artifact leases.
- Make cancellation, uncommitted output rollback, TTL/expiry, active leases, aggregate Base64 limits, and content-free diagnostics deterministic and testable.

**Non-Goals:**

- No edit to `packages/core/src/openai-operation/**`, any `openaiResponsesIngress.ts`, `providerProxyShared.ts`, current Responses profile/driver/affinity implementation, or daemon/UI/bootstrap/config/permission code.
- No self-registration and no final ingress composition. The integrator still owns main-model streaming mediation, existing response/credential affinity, selection, mixed-output assembly, terminal `response.completed`/failure writing, and app-session lifetime.
- No generic Files API, public upload route, standalone web search, compact, Responses WebSocket, stored/background Responses, or new text-provider transformation.
- No initial arbitrary Responses URL/data/file input frontend in this slice. The execution scope consumes retained previous-response/call-ID images; the already-built bounded Images resolver remains available for a future documented input carrier without weakening the state contract.
- No fabricated Codex entitlement, private wire, positive live fixture, usage, moderation, partial image, transparent output, or host `$imagegen` support claim.

## Decisions

### 1. Put the contribution under the owned image deep module

Add `packages/core/src/image-generation/responses/**`, exported through `packages/core/src/image-generation/index.ts` and therefore the root core barrel. Candidate files are:

- `types.ts`: wire-safe item/event types, admission/selection/runtime/allocation contracts, request-scope and contribution interfaces.
- `normalizeResponsesImageTool.ts`: closed image declaration parsing, tool-choice policy, call-ID extraction, option/action normalization, and selection validation.
- `ResponsesImageStateStore.ts`: state port plus deterministic bounded in-memory test implementation with leases and owner-only expiry tombstones.
- `ResponsesImageGenerationContribution.ts`: factory, request scope, reference resolution, orchestrator execution, Base64/event mapping, commit/rollback, and cleanup coordination.
- `index.ts` and colocated tests.

The factory returns data/behavior only and freezes its public object. It imports existing image and Responses-adjacent types where useful but never registers an operation or mutates a module singleton.

Alternative considered: implement a new `responses.create` operation handler. Rejected because create is a built-in ingress, registration would conflict with shared dispatch, and Session B assigns final composition—not business behavior—to the integrator.

### 2. Freeze selection versus execution as an explicit two-phase contract

The contribution exposes a shape equivalent to:

```ts
interface ResponsesImageGenerationContribution {
  readonly toolType: 'image_generation'
  inspectRequest(input: ResponsesImageInspectionInput): ResponsesImageAdmission
  validateSelection(
    admission: ResponsesImageAdmission,
    selection: ResponsesHostedToolSelection,
  ): void
  createRequestScope(input: ResponsesImageRequestScopeInput):
    Promise<ResponsesImageRequestScope>
}

interface ResponsesImageRequestScope {
  executeSelectedCall(
    call: ResponsesSelectedImageCall,
    allocator: ResponsesImageEventAllocator,
  ): AsyncIterable<ResponsesImageExecutionEvent>
  commit(responseId: string): Promise<void>
  dispose(): Promise<void>
}
```

`inspectRequest` reads only `tools`, `tool_choice`, `stream`, the image call-reference portions of `input`, and the syntactic `previous_response_id`. It identifies exactly one image declaration and returns its index plus normalized options without cloning or rewriting unrelated tools. Omitted/`auto` is optional; generic `required` requires some selected tool; forced image requires at least one selected image; a forced other tool forbids local image selection. `validateSelection` sees image calls plus an other-tool count and treats an upstream/integrator plan that violates forced/required policy as stable protocol failure. Auto with zero image calls is a valid no-op.

The selected-call plan contains a bounded non-empty image prompt. It is produced by the final integrator's actual main-model selection path, not this module. The contribution does not inspect natural language to guess a call and does not claim that current Codex private Responses automatically supplies such a plan.

Alternative considered: derive selection directly from `tool_choice` and always generate for `auto`. Rejected because it breaks automatic no-selection/text behavior and would fake the main model's decision.

### 3. Use one request scope as the lifecycle/rollback unit

`createRequestScope` receives the admission, trusted runtime, `ImageProviderContext`, an optional previous response ID that the integrator has already authorized through existing Responses affinity, and positive byte/TTL limits. It resolves/deduplicates explicit call IDs and inherited prior-response call IDs, acquires state and image leases, and creates one aggregate output budget. Explicit IDs retain request order and precede inherited nonduplicates.

The scope serializes selected image executions. Serial execution avoids racing one mutable aggregate budget and keeps one parent cancellation/rollback path; the final integrator can still place several calls among mixed output items. Every completed call accumulates an uncommitted `{callId, imageReferenceId, expiresAt}` binding. `commit(responseId)` atomically records inherited plus new call context before the integrator publishes the final successful Response. `dispose()` always releases input/state leases; if commit did not succeed, it also deletes every newly retained reference. Calls from a failed containing Response therefore never become public references.

Commit is idempotent only for the exact same response/call set. A conflicting response or call ID is an internal stable failure. A response with inherited image context but no new image call is committed with the inherited IDs so a text-only middle turn does not sever later editing. A response with no inherited or new image state is a no-op and need not consume an index entry.

Alternative considered: register each call globally immediately after provider completion. Rejected because a later call/outer response failure would leave a resolvable item ID the client never received.

### 4. Keep response/call identity state separate from credential affinity and binary storage

`ResponsesAffinityStore` remains authoritative for `previous_response_id` provider/client/session/credential routing and must run first in final integration. The new `ResponsesImageStateStore` contains no credentials or response bodies. It provides atomic response commit, `resolveResponse`, `resolveCall`, delete/cleanup, and leases over:

```ts
interface ResponsesImageCallBinding {
  readonly callId: `ig_${string}`
  readonly referenceId: ImageReferenceId
  readonly expiresAt: number
}
```

Call entries map one public item ID to one existing `ImageReferenceStore` value; response entries hold ordered call IDs. Both are keyed internally by tenant plus random public ID. Cross-tenant lookup is indistinguishable from missing. Owner TTL expiry yields `expired` while a bounded owner tombstone remains; capacity eviction is `not_found`. Active state leases prevent mapping removal, and the existing image reference leases independently prevent asset removal.

The in-memory implementation is a deterministic-clock, size-bounded test/default implementation, not the production persistence promise. It prunes expired/unleased entries first and uses bounded LRU behavior for capacity. Cleanup returns/removes only call bindings no longer pinned, after which the contribution or production scheduler best-effort deletes the corresponding image reference and calls the generic reference-store cleanup. Production wiring may supply a persistent atomic implementation through the same port.

Alternative considered: encode `ImageReferenceId` directly into the `ig_` ID and keep only response mappings. Rejected because cleanup would erase the owner's expired/not-found distinction, there would be no atomic commit/rollback boundary, and future storage migrations would leak their identifier form.

### 5. Reuse the existing option normalizer and keep the image model trusted

The declaration accepts only documented image-owned keys: `type`, `size`, `quality`, `output_format`, `output_compression`, `background`, `partial_images`, and `action`. `action` defaults to `auto`; unknown keys/types and duplicate image declarations fail closed. The module either calls the pure existing Images normalizer with a constructed closed object or extracts a shared pure helper without changing Images wire behavior.

The runtime supplies `providerId`, `imageModel`, reference TTL, existing Images limits, and model aliases if needed. The top-level Responses `model` is never forwarded as the image model. For a selected call, the contribution constructs `n = 1`, moderation `auto`, and `stream = partialImages > 0`. Nonzero partials on a non-stream outer request are invalid. This avoids requiring provider streaming merely because the outer text response is SSE when no image partial was requested.

`action: generate` ignores retained edit context. `action: edit` requires at least one resolved asset. `auto` chooses edit iff the authorized context has at least one asset. No expired/missing explicit reference is silently dropped, and edit never degrades to a fresh generation.

Alternative considered: let the provider adapter reinterpret `auto` or choose the image model. Rejected because protocol semantics and trusted configuration would then vary by private provider wire.

### 6. Execute through `ImageOrchestrator` once per selected call

Each scope execution calls `ImageOrchestrator.run` directly with the normalized `n=1` request, trusted tenant/request/signal/account hints, provider ID, and retention `{enabled: true, ttlMs}`. It never invokes the public Images handlers. The orchestrator remains the authority for capability intersection, request support, provider lease stability, exact terminal count, real partial invariants, provider usage, and exactly-once started-nonterminal cancellation.

The contribution consumes `accepted` internally. A real partial becomes a partial execution event. A completed event must contain exactly one output and one retained reference; otherwise it is protocol drift. A provider failed event becomes one sanitized failed terminal event. Unexpected throws are normalized to a stable public image error without carrying the original cause. The request scope yields exactly one terminal (`completed` or `failed`) per selected call.

The factory receives the same `ImageReferenceStore` instance used to construct the orchestrator. Production composition is responsible for that invariant; a reference returned by retention is immediately round-tripped/validated before commit so a mismatch fails closed in tests rather than publishing an unusable call ID.

Alternative considered: save the final artifact a second time outside the orchestrator. Rejected because the orchestrator already owns retention and exposes ordered reference metadata; double-saving complicates cleanup and can diverge TTLs.

### 7. Split global response allocation from image-owned item identity

The contribution generates a cryptographically random `ig_` item/call ID through an injectable testable factory. The final integrator supplies one allocator shared with messages, reasoning, and all tools:

```ts
interface ResponsesImageEventAllocator {
  reserveOutputIndex(): number
  nextSequenceNumber(): number
}
```

The index is reserved once before the provider job for a selected call; the same index and image-owned item ID appear on all its partials and terminal result. Every partial obtains a sequence number only when emitted and the contribution verifies local monotonicity/nonnegative safe integers. The integrator remains responsible for using that same allocator for its other events and for inserting the terminal item at the returned index in the eventual `response.output` array. This supports mixed output and multiple calls without any `output[0]` assumption.

Alternative considered: let the contribution own a sequence counter starting at zero. Rejected because its partials would collide with already-emitted main-model events.

### 8. Map bytes once at the final Responses boundary under a shared budget

The request scope creates a decoded-byte budget from positive `maxOutputBytes` and `maxTotalOutputBytes` values. Before reading any partial/final asset, it reserves the declared byte length; partial and final assets across every selected call count toward the same total. `readImageAssetBytes` verifies the stream stays within the per-asset bound and exactly matches metadata. Only then is one Base64 string created. Abort is checked before reserve, during read, and immediately before returning the payload.

Completed output is:

```json
{"id":"ig_...","type":"image_generation_call","status":"completed","result":"..."}
```

with `revised_prompt` only from the validated provider output. A real partial is:

```json
{"type":"response.image_generation_call.partial_image","output_index":3,"item_id":"ig_...","sequence_number":17,"partial_image_index":0,"partial_image_b64":"..."}
```

Optional quality/background/size/format fields are omitted because a requested value is not proof of actual use. The final integrator delays/preserves `response.completed` until all selected calls and state commit succeed; on failure it takes the Responses failure path and must never append an empty completed image item.

Alternative considered: reuse the Images SSE/JSON writers. Rejected because they own HTTP, endpoint event names, and response commitment; reusing their normalization/assets is correct, round-tripping their wire is not.

### 9. Treat cancellation and consumer termination as scope-wide

The final ingress signal is the single cancellation source. The async generator uses `for await`/`return()` so consumer termination enters the orchestrator's `finally`; it never calls `ImageJob.cancel` itself. The orchestrator therefore retains its proven rule: once a job exists, cancel started nonterminal work exactly once; do not cancel provider-terminal work. Scope disposal releases response/call/image leases and uncommitted outputs idempotently.

Tests that simulate a client `response.end`/stream close wait for an authoritative scope/provider-idle promise before asserting cancellation, cleanup, or audit state because network completion can precede handler `finally`.

Alternative considered: cancel on `accepted` or have both layers call cancel. Rejected because a job can exist before acceptance and duplicate cancellation races with a terminal provider event.

### 10. Return only stable public failure data and content-free state

Admission/request-scope failures use `ImageGenerationError`. Execution converts every terminal into a closed `completed | failed` contribution union; `failed.error` is `ImageGenerationPublicError` only. Commit/dispose unexpected failures normalize to `image_generation_failed`. The final integrator maps this stable object to its non-stream/SSE Responses error path.

No state-store record, allocator, audit hook, exception serialization, or test snapshot contains prompt, image bytes/Base64, URL/data URL, bearer, credential/account ID, opaque provider reference, or local path. Output items/partial events necessarily contain Base64 for the requesting client, but they are never passed to ordinary logs/audit callbacks. Usage is not synthesized or added to the Responses result by this contribution; provider usage remains available only if a later integrator has a truthful accounting contract.

Alternative considered: throw raw storage/provider errors and let ingress serialize them. Rejected because current generic error handling can include arbitrary exception messages and would weaken the image module's allow-list.

### 11. Test the contribution independently of forbidden integration files

Unit/contract tests use a fake selected-call plan, deterministic event allocator starting after existing mixed outputs, fake provider capabilities/events, the real orchestrator, in-memory image/state stores, and abortable assets. Coverage includes auto/required/forced/no-selection, invalid actions/options, generate/edit choice, unsupported capability, exact completed bytes, truthful revised prompt, real partials, multiple/mixed calls, sequence failure, response carry-forward, direct call IDs, owner expiry/cross-tenant hiding, active cleanup leases, aggregate budgets, abort/consumer return, rollback, and secret sentinels.

A public-export test imports the factory/types from the core root. Candidate-tree checks prove no forbidden path changed. No test claims live Codex success; the existing fail-closed adapter is used for a negative capability test only.

## Risks / Trade-offs

- [The final ingress selector/stream mediator is outside this child] → Freeze a small explicit selection/execution contract and test it end-to-end with fake selected plans; document the exact call order the integrator must follow.
- [One Response can contain many large partial/final strings] → Execute image calls serially and enforce a response-global decoded-byte budget before each read/encode.
- [State commit happens after upstream image work] → Hold new references uncommitted inside the scope and delete them on every non-commit exit.
- [State and binary stores are separate ports] → Commit only validated reference IDs, hold both lease types, exact-idempotency-check writes, and fail closed/rollback if either store disagrees.
- [A bounded index can evict live history before TTL] → Capacity eviction becomes non-disclosing not-found like existing Responses affinity; TTL expiry remains owner-distinguishable via bounded tombstones.
- [Previous-response security spans two modules] → Existing Responses affinity must authorize route/client/session first; the image index independently scopes every image call/reference by tenant and never receives bearer material.
- [Only retained call/previous-response images are supported here] → State the input limitation honestly; do not introduce a generic Files route or unsafe URL downloader through the hosted contribution.
- [Current Codex image capability is unverified] → Keep production evidence false and test only synthetic provider success plus real fail-closed capability rejection.

## Migration Plan

1. Add the Responses image types, pure declaration/selection normalizer, and tests with no provider execution.
2. Add the state-store port/in-memory implementation, owner-expiry tombstones, leases, atomic commit, and cleanup tests.
3. Add the request scope and direct orchestrator execution with retention, rollback, Base64 budget, partial/final mapping, and cancellation tests.
4. Export the frozen contribution/types through the image-generation/core barrels and add a root-public-export test.
5. Run focused and existing image suites, core/contracts typecheck/build as affected, strict Rasen/UTF-8/diff/secret/forbidden-path checks, and commit locally for the portfolio.
6. In the later integration composition, authorize previous responses through current affinity, obtain real model selections, create one image request scope, execute selected calls with the response-global allocator, commit before the terminal success is exposed, and dispose in `finally`. Rollback before that integration is deletion of dormant exports/modules; existing Responses and Images behavior is unchanged.

## Open Questions

- Which verified Native Responses selection adapter will produce `ResponsesSelectedImageCall` in production without exposing or inventing a private Codex wire? Until supplied, the contribution remains injectable/tested but production-disabled.
- Will the final integrator expose initial Responses `input_image` URL/data/reference carriers in the same release? This child intentionally freezes only retained call/previous-response inputs; any extension must reuse the existing bounded input resolver and update the spec.
- What production persistence implementation and exact entry/byte/tombstone limits will `codex-images-production-wiring` choose for the state and reference stores?
- Can a verified subscription upstream consume its opaque provider image reference more efficiently than re-uploading the retained artifact? The current provider request seam accepts assets, so correctness uses retained content and keeps the opaque value private for future evidence-backed optimization.
- Live subscription entitlement, partial streaming, transparency, usage, moderation detail, and Codex host `$imagegen` enablement remain unknown until a permitted fresh probe produces sanitized evidence.
