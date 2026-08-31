# responses-image-generation-tool Specification

## Purpose
TBD - created by archiving change codex-responses-image-tool. Update Purpose after archive.
## Requirements
### Requirement: Injectable hosted image contribution
The system SHALL export one self-contained, non-self-registering contribution for hosted Responses tools whose public discriminator is `image_generation`. The contribution MUST inspect only the image-owned portions of a Responses request, MUST leave unrelated tools and outputs untouched, and MUST expose narrow request-scope methods that a final Native Responses integrator can call without an internal HTTP request.

#### Scenario: Contribution remains dormant until injected
- **WHEN** the factory is constructed but no Responses integrator invokes it
- **THEN** no registry, route, global singleton, daemon, or upstream provider is mutated or called

#### Scenario: Other tools remain available
- **WHEN** a request declares `image_generation` together with function, custom, or other hosted tools
- **THEN** inspection returns the image admission metadata without deleting, reordering, or assuming ownership of the other declarations

### Requirement: Tool declaration and selection semantics
The contribution SHALL validate at most one `image_generation` declaration and SHALL represent omitted/`auto`, generic `required`, forced `{"type":"image_generation"}`, and an explicitly forced non-image tool as distinct selection policies. Automatic model selection remains integrator-owned; the contribution MUST validate the model-selected plan but MUST NOT infer selection from prompt text or force an image when automatic selection chose none.

#### Scenario: Automatic selection chooses no image
- **WHEN** `image_generation` is declared with omitted or `auto` tool choice and the model-selected plan contains no image call
- **THEN** selection validation succeeds and no image provider call or synthetic output item is produced

#### Scenario: Generic required is satisfied by another tool
- **WHEN** generic `required` is present and the selected plan contains a declared non-image tool but no image call
- **THEN** image selection validation succeeds without forcing an image call

#### Scenario: Generic required selects nothing
- **WHEN** generic `required` is present and the selected plan contains no tool call of any type
- **THEN** the contribution reports a structured stable protocol failure rather than silently returning a successful no-tool response

#### Scenario: Forced image is honored
- **WHEN** `{"type":"image_generation"}` is present and the selected plan contains one or more image calls
- **THEN** each selected image call is eligible for execution

#### Scenario: Forced image is missing from the selected plan
- **WHEN** `{"type":"image_generation"}` is present but the selected plan contains no image call
- **THEN** the contribution reports a structured stable protocol failure and does not fabricate an image

#### Scenario: Forced image lacks a declaration
- **WHEN** tool choice forces `image_generation` but the request does not declare that tool
- **THEN** inspection fails with `invalid_image_request` and parameter `tool_choice` before provider acquisition

### Requirement: Image tool option and action normalization
The contribution SHALL normalize `size`, `quality`, `output_format`, `output_compression`, `background`, `partial_images`, and `action: auto | generate | edit` through the same image-domain constraints as the Images API. The Responses request model MUST remain the main text/reasoning model; the trusted runtime SHALL supply the actual image model. Each selected hosted call SHALL become exactly one image output request (`n = 1`).

#### Scenario: Invalid option combination is rejected early
- **WHEN** a declaration requests an invalid combination such as transparent JPEG, PNG output compression, an unknown action, or partial images on a non-stream Responses request
- **THEN** inspection or request-scope creation fails with `invalid_image_request` before provider acquisition

#### Scenario: Automatic action with no image context generates
- **WHEN** action is `auto` and no authorized image reference is available from the request or previous response
- **THEN** the selected call executes as `generate`

#### Scenario: Automatic action with image context edits
- **WHEN** action is `auto` and one or more authorized image references resolve successfully
- **THEN** the selected call executes as `edit` with those assets in deterministic request order

#### Scenario: Explicit edit has no image
- **WHEN** action is `edit` and no authorized image asset is available
- **THEN** execution fails with user-correctable `invalid_image_request` and no provider job starts

#### Scenario: Explicit generate does not silently edit
- **WHEN** action is `generate` while prior image context exists
- **THEN** the provider receives a generate request with no edit assets

### Requirement: Direct orchestrator execution and stable failures
Every selected image call SHALL invoke `ImageOrchestrator.run` directly with the trusted request ID, outbound-key tenant identity, cancellation signal, provider/account hints, runtime image model, and provider ID. The contribution MUST NOT round-trip through `/v1/images/*`, and unsupported model/capability, moderation, rate/usage, timeout, cancellation, and protocol failures MUST remain distinct stable image errors.

#### Scenario: Unsupported capability fails closed
- **WHEN** the resolved provider/account/upstream capability does not affirm an option, edit, partial streaming, or Responses-tool support
- **THEN** execution terminates with `unsupported_capability` and no completed image item is returned

#### Scenario: Provider failed event is not a completed item
- **WHEN** the orchestrator reports a failed terminal event
- **THEN** the contribution returns one sanitized failed terminal result for the Responses error path and never returns `status: completed` with an empty result

### Requirement: Completed image call mapping
For each successful selected call, the contribution SHALL create one unpredictable stable `ig_` item ID, reserve one integrator-owned output index, and return an `image_generation_call` item with `status: completed` and the final image Base64 in `result`. It SHALL include `revised_prompt` only when the validated provider output supplied it and SHALL retain a one-to-one internal reference binding for the item ID.

#### Scenario: Non-stream result contains valid Base64
- **WHEN** a selected call completes with one independently decodable image
- **THEN** the terminal item has type `image_generation_call`, status `completed`, a stable `ig_` ID, and a `result` whose decoded bytes exactly equal the final artifact

#### Scenario: Revised prompt is truthful
- **WHEN** the provider omits a revised prompt
- **THEN** the output item omits `revised_prompt`

#### Scenario: Mixed outputs keep their positions
- **WHEN** the final integrator has already reserved output positions for messages, reasoning, or other tools
- **THEN** the image call uses the next index returned by the shared allocator and never assumes or overwrites `output[0]`

#### Scenario: Multiple image calls remain distinct
- **WHEN** one Response selects multiple image calls
- **THEN** every call receives a distinct item ID, output index, retained reference, result, and terminal record

### Requirement: Official real-partial event mapping
When `partial_images > 0`, the contribution SHALL forward only real orchestrator partial artifacts as `response.image_generation_call.partial_image` payloads. Each payload MUST use the call's stable item ID and reserved output index, the provider-validated `partial_image_index`, bounded Base64 bytes, and a sequence number obtained from the integrator's global monotonic allocator. A final image MUST NOT be repeated or transformed into a synthetic partial.

#### Scenario: Partial identities and sequence are stable
- **WHEN** a provider emits multiple real partials for one or more image calls interleaved with other response events
- **THEN** every image partial keeps its call item/output identity and its sequence number is greater than the preceding globally allocated event sequence

#### Scenario: Provider has no real partial capability
- **WHEN** partial images are requested but the resolved provider capability does not affirm streaming partials
- **THEN** the request fails with `unsupported_capability` instead of emitting the final image as a partial

#### Scenario: Non-stream request never emits partials
- **WHEN** the Responses request is non-streaming
- **THEN** nonzero `partial_images` is rejected and no partial event is produced

### Requirement: Tenant-safe multi-turn image state
The contribution SHALL maintain an injected bounded Responses image-state index that maps stable call IDs to retained `ImageReferenceStore` IDs and successful response IDs to ordered call-ID context. The final integrator SHALL authorize `previous_response_id` through the existing Responses affinity boundary before passing it to the contribution. A successfully committed child response SHALL carry forward inherited call IDs and add newly completed image calls, enabling both authorized previous-response continuation and explicit call-ID editing.

#### Scenario: Previous response carries image context forward
- **WHEN** an authorized previous response contains image calls and a later successful response adds no new image
- **THEN** committing the later response preserves the inherited call IDs so a subsequent continuation can still edit the same retained images

#### Scenario: Explicit call ID resolves one image
- **WHEN** the input references a committed `image_generation_call.id` owned by the same tenant
- **THEN** the contribution resolves and leases its exact retained artifact for edit execution

#### Scenario: Reference order and duplicates are deterministic
- **WHEN** explicit call IDs and previous-response context overlap
- **THEN** explicit request order is preserved first and duplicate call IDs are removed before orchestrator validation

#### Scenario: Failed response does not publish orphan call IDs
- **WHEN** one call completed locally but the containing Response fails or is cancelled before state commit
- **THEN** request-scope disposal removes the uncommitted retained reference and no call/response mapping becomes resolvable

### Requirement: Reference isolation, expiry, leases, and cleanup
Image call and response state SHALL be scoped by trusted tenant/outbound-key identity. Missing, capacity-evicted, and cross-tenant direct call IDs MUST resolve as `image_reference_not_found`; an owning tenant's TTL-expired call or response MUST resolve as `image_reference_expired` while its bounded tombstone is retained. State and image leases MUST pin active values through execution, and cleanup MUST remove only expired/deleted values with no active lease.

#### Scenario: Cross-key direct call reference is hidden
- **WHEN** a different outbound-key tenant supplies an existing call ID
- **THEN** resolution returns `image_reference_not_found` without revealing owner, metadata, or expiry

#### Scenario: Owning tenant observes expiry
- **WHEN** the owning tenant resolves a call or previous-response image context after TTL expiry
- **THEN** resolution returns `image_reference_expired` rather than degrading the edit to a fresh generation

#### Scenario: Active edit lease survives cleanup
- **WHEN** cleanup runs after TTL while an edit request holds both state and image leases
- **THEN** the active request can finish and physical/mapping removal occurs only after the leases are released and cleanup runs again

### Requirement: Cancellation and request-scope finalization
The contribution SHALL propagate the final integrator's request signal into asset reads and `ImageOrchestrator`. Ending iteration, client disconnect, timeout, selection failure after start, or scope disposal MUST stop further Base64 production, release every state/image lease, and rely on the orchestrator to cancel a started nonterminal `ImageJob` exactly once. Provider-terminal work MUST NOT receive an extra cancel.

#### Scenario: Client disconnect during partial mapping
- **WHEN** the request signal aborts while a partial asset is being read or before its payload is delivered
- **THEN** no later Base64 payload is returned, the job is cancelled once if nonterminal, and every lease is released

#### Scenario: Provider terminal precedes outer cleanup
- **WHEN** the provider has already completed before the final response is committed or the handler finally block runs
- **THEN** cleanup releases resources without calling provider cancellation

### Requirement: Bounded and redacted binary handling
The trusted runtime SHALL provide positive per-artifact and aggregate per-Response output limits. The contribution MUST reserve declared bytes before reading, verify actual bytes against metadata, count partial and final images across all calls, and fail with `image_too_large` before exceeding the budget. Public events/items MAY contain required Base64 results, but errors, state metadata, audit records, logs, snapshots, and thrown causes MUST NOT contain image bytes, Base64/data URLs, complete prompts, credentials, account IDs, raw provider references, or raw bearer keys.

#### Scenario: Aggregate output budget spans calls and partials
- **WHEN** individually valid partial/final artifacts across multiple selected calls exceed the shared response budget
- **THEN** the first over-budget artifact fails with `image_too_large` and no additional asset is read or encoded

#### Scenario: Sensitive failure is sanitized
- **WHEN** an asset/provider/state dependency throws an error containing token, Cookie, prompt, path, URL, Base64, or opaque-reference sentinels
- **THEN** the contribution exposes only the allow-listed stable image error fields and the sentinels are absent from logs, snapshots, and terminal payloads

### Requirement: Honest integration boundary
The contribution SHALL be publicly exported from the owned image-generation module, SHALL remain unregistered until final app-session composition, and SHALL be usable with fake verified capabilities in tests. Production Codex/ChatGPT image execution MUST remain unavailable unless fresh adapter, selected-account, and upstream-protocol evidence all affirm the requested capability; text Responses success, model names, public documentation, or a configuration toggle MUST NOT satisfy that evidence.

#### Scenario: No live entitlement evidence exists
- **WHEN** production wiring supplies the current fail-closed Codex image provider evidence
- **THEN** the hosted contribution reports unsupported capability and tests do not claim live image generation, usage, moderation, transparency, or partial support

#### Scenario: Forbidden shared files are unnecessary
- **WHEN** the contribution and its tests are implemented
- **THEN** no implementation edit is required under `packages/core/src/openai-operation/**`, any `openaiResponsesIngress.ts`, or `providerProxyShared.ts`

### Requirement: Native Responses ingress executes the hosted image contribution
The Native Responses create ingress SHALL recognize image-owned declarations, forced choices, explicit image-call references, and authorized inherited image context and SHALL route them through the injected hosted image mediator. Requests with no image-owned declaration/reference/context MUST retain the existing Responses path without acquiring an image runtime generation. A reduced-profile route or a Native route without an injected runtime MUST fail closed when image execution is requested.

#### Scenario: Ordinary Responses request remains unchanged
- **WHEN** a Native Responses request has no `image_generation` declaration, image-call reference, or inherited image context
- **THEN** the ingress invokes the existing upstream/relay path and does not acquire the hosted image runtime

#### Scenario: Hosted runtime is unavailable
- **WHEN** a request declares or forces `image_generation` but no hosted image mediator/runtime is injected
- **THEN** the ingress returns structured `unsupported_capability` before forwarding the declaration upstream

#### Scenario: Reduced profile cannot host the image tool
- **WHEN** a reduced Responses route receives an `image_generation` declaration or forced image choice
- **THEN** it fails with `unsupported_capability` before main-model or image-provider execution

### Requirement: Hosted image execution requires independent Images permission
The authenticated outbound route SHALL carry a least-authority hosted-image permission fact derived only from the verified named key's explicit `images` permission. A key authorized only for `responses` MUST NOT execute `image_generation`, and raw bearer text, session metadata, model output, legacy text permissions, or configuration enablement MUST NOT satisfy this permission.

#### Scenario: Responses-only key is denied
- **WHEN** a key with `responses` permission but without `images` permission submits a Responses request that declares or forces `image_generation`
- **THEN** the request fails with 403 before the main-model selector, runtime acquisition, or image provider is called

#### Scenario: Explicit dual permission is admitted
- **WHEN** the verified key has both `responses` and `images` permission and the image runtime is injected
- **THEN** the request may enter hosted image admission while all capability/evidence checks remain fail closed

### Requirement: Main-model image selection uses a real bounded selection adapter
The mediator SHALL replace the image declaration only on the upstream request clone with a per-request non-colliding internal function whose closed arguments contain one bounded `prompt`. It SHALL map `auto`, generic `required`, forced image, forced other, and `none` choices without changing their selection semantics. Only a strictly valid internal function call actually returned by the main Responses model MAY become a `ResponsesSelectedImageCall`; the system MUST NOT infer selection or an image prompt from user natural language.

#### Scenario: Automatic selection chooses text
- **WHEN** an automatic request causes the main model to return no internal image-selection function call
- **THEN** no image provider is called and the ordinary text/other-tool output is preserved

#### Scenario: Forced image selects through the model
- **WHEN** `tool_choice` forces `image_generation`
- **THEN** the upstream request forces the private internal function and a valid returned `{prompt}` is validated and executed through the contribution

#### Scenario: Selector output is malformed
- **WHEN** the model returns invalid JSON, unknown fields, an empty/oversized prompt, a forged selector name, duplicate identity, or inconsistent tool selection
- **THEN** the request fails with sanitized `upstream_protocol_changed` and does not expose the internal function name or arguments

#### Scenario: Other tools remain model-selectable
- **WHEN** image generation is declared with function, custom, or another hosted tool
- **THEN** those declarations remain in their original order and a selected non-image tool is mapped back to its declared identity for contribution validation

### Requirement: JSON and SSE mediation preserves official image output ordering
For a successful non-stream response, the mediator SHALL replace each hidden selector function item at its existing output position with the contribution's completed `image_generation_call` item. For SSE, it SHALL suppress every internal selector event, reuse its reserved output index for the public image call, allocate globally monotonic sequence numbers for forwarded and synthesized events, forward only real partial images, and delay the unique terminal success until image state commit succeeds.

#### Scenario: Non-stream image result is committed before exposure
- **WHEN** the main model selects an image and the contribution completes it
- **THEN** the response contains the exact Base64 result at the selector's mixed-output position only after `scope.commit(response.id)` succeeds

#### Scenario: Streaming image events are official and ordered
- **WHEN** the provider emits real partial images
- **THEN** the client observes one public image item start, zero or more `response.image_generation_call.partial_image` events, the completed image item, and `response.completed` with strictly increasing sequence numbers and one stable output index/item ID

#### Scenario: Internal selector wire is hidden
- **WHEN** the upstream JSON or SSE contains the request-private selector function call and argument deltas
- **THEN** no internal function name, call item, arguments, prompt, or completion receipt appears in the client response, errors, logs, audit, or usage snapshots

#### Scenario: Commit or image execution fails
- **WHEN** any selected call, output mapping, or image-state commit fails
- **THEN** no successful terminal response or empty completed image item is emitted and the failure uses the normal sanitized Responses error path

### Requirement: Hosted image continuation closes hidden function state safely
After image state commit and before terminal success, the ingress SHALL record bounded hosted-image continuation metadata inside the already-authorized Responses affinity record. A subsequent authorized `previous_response_id` request SHALL add the corresponding internal `function_call_output` receipt to the upstream input while retaining the public image context locally. Receipts MUST contain only completion status and public call identity, MUST be consumed at most once per upstream continuation, and MUST NOT contain image bytes, prompts, credentials, paths, provider references, or cross-tenant metadata.

#### Scenario: Previous response continues after image generation
- **WHEN** an authorized child request uses the response ID of a locally completed image call
- **THEN** the main-model request receives the bounded hidden function completion and the contribution resolves the same tenant's retained image context

#### Scenario: Text-only middle turn carries image context
- **WHEN** an authorized continuation after an image produces no new image
- **THEN** its successful response carries the inherited local image context forward so a later edit can resolve it

#### Scenario: Ordinary prior response has no image-state row
- **WHEN** a newly admitted image request follows an affinity-authorized text-only response that never entered the hosted mediator
- **THEN** missing local image state is treated as known empty context rather than cross-tenant authorization or expiry

#### Scenario: Cross-tenant continuation is hidden
- **WHEN** another outbound key supplies a response or image-call ID owned by a different tenant
- **THEN** existing affinity/reference isolation rejects it before any receipt, image metadata, or provider work is exposed

### Requirement: Runtime generation and request resources are pinned and finalized once
The injected hosted runtime lease SHALL derive provider ID, image model, reference TTL, output budgets, and configured account policy from the same immutable runtime generation as the contribution. The ingress MUST pass the request cancellation signal, trusted tenant/session identity, and—when compatible—the main model's actually selected account. Every path SHALL dispose the request scope before releasing the generation lease, with idempotent exact-once observable ownership.

#### Scenario: Main and image work share Codex account affinity
- **WHEN** the main-model selection used a concrete Codex subscription account
- **THEN** the pinned hosted runtime executes the image call with that account under strict binding rather than silently switching accounts

#### Scenario: Hot reload occurs during a request
- **WHEN** image configuration publishes a new runtime generation while a hosted request is active
- **THEN** the active request keeps the old generation until scope disposal and a later request acquires the new generation

#### Scenario: Client cancels during image streaming
- **WHEN** the request signal aborts during selector mediation, provider execution, asset reading, or partial delivery
- **THEN** no later Base64 is produced, uncommitted references roll back, provider cancellation occurs at most once, scope disposal completes, and the generation lease is released

