## ADDED Requirements

### Requirement: Provider-neutral image contract
The system SHALL define dependency-light normalized generate/edit requests, output descriptors, capability values, usage, stable errors, events, and artifact/reference identifiers without any ChatGPT/Codex private field or HTTP wire shape. Edit inputs SHALL arrive at the provider seam as bounded image asset handles rather than raw multipart fields, URLs, data URLs, or public file IDs.

#### Scenario: Protocol frontends use one request union
- **WHEN** an Images API frontend or Responses hosted-tool frontend normalizes an equivalent generate or edit request
- **THEN** both frontends can invoke the same discriminated image request contract without provider-specific fields

#### Scenario: Raw input carriers stay outside the provider seam
- **WHEN** an edit originated from multipart, a data URL, a remote URL, or an opaque file/reference ID
- **THEN** the provider receives only a validated asset handle with trusted MIME, byte length, dimensions, and a bounded content stream

### Requirement: Account-bound provider lease
An `ImageProvider` SHALL acquire a short-lived provider lease that binds the selected upstream account/credential context, its resolved capability snapshot, and the job-start operation. The orchestrator MUST validate and start the request through the same lease so account selection cannot drift between capability checking and upstream dispatch, and releasing the lease MUST discard credential-bearing state.

#### Scenario: Capability and dispatch use the same account
- **WHEN** more than one eligible subscription account exists
- **THEN** the account whose evidence produced the lease capability snapshot is the account used for the image job

#### Scenario: Lease is released after a terminal outcome
- **WHEN** a job completes, fails, is cancelled, or cannot start
- **THEN** the orchestrator releases the provider lease exactly once and does not retain its authentication headers

### Requirement: Fail-closed capability intersection
The system SHALL resolve effective image capabilities by intersecting the adapter declaration, selected-account evidence, and verified observed-upstream evidence. Missing, stale, unknown, or contradictory evidence MUST resolve to unsupported; models, formats, and enum sets SHALL be intersected, boolean features SHALL require affirmative evidence at every required layer, and numeric maxima SHALL use the lowest verified limit.

#### Scenario: Unknown entitlement is unavailable
- **WHEN** the adapter declares image support but the selected account has no verified image entitlement evidence
- **THEN** effective availability is false and an image job is not dispatched

#### Scenario: Feature is not inferred from model name
- **WHEN** a model catalog contains `gpt-image-2` but transparent-background or streaming evidence is absent
- **THEN** those features are reported unsupported and requests requiring them fail before provider dispatch

#### Scenario: Restrictive layer wins
- **WHEN** static support allows 16 input images but verified account or upstream evidence allows 4
- **THEN** the effective maximum input image count is 4

### Requirement: Deterministic provider registry and orchestration
The provider registry SHALL reject duplicate provider IDs and resolve only explicitly registered providers. The orchestrator SHALL acquire one provider lease, validate the normalized request against its effective capabilities before starting upstream work, and expose one asynchronous event stream to all protocol frontends.

#### Scenario: Duplicate provider is rejected
- **WHEN** two adapters attempt to register the same provider ID
- **THEN** registry construction or registration fails deterministically without replacing the first adapter

#### Scenario: Unsupported request never starts upstream work
- **WHEN** a request requires generate, edit, mask, format, transparency, partial streaming, or output count beyond the effective snapshot
- **THEN** the orchestrator returns `unsupported_capability` without invoking the lease start operation

### Requirement: Image job lifecycle invariants
Each image job SHALL emit at most one `accepted` event, zero or more `partial_image` events containing independently decodable complete images, and exactly one terminal `completed` or `failed` event. `accepted` MUST precede partial/final output, no event may follow a terminal event, and successful completion MUST contain exactly the requested number of final images.

#### Scenario: Valid lifecycle completes
- **WHEN** a provider emits accepted, independent partial images, and a final output count equal to the normalized request
- **THEN** the orchestrator forwards the ordered events and completes the stream once

#### Scenario: Provider violates event ordering
- **WHEN** a provider emits output before accepted, emits two terminal events, emits after terminal, or completes with fewer final images than requested
- **THEN** the orchestrator terminates with a stable `upstream_protocol_changed` or `image_generation_failed` error and never reports successful completion

#### Scenario: Partial image is not a byte delta
- **WHEN** a provider marks an event as `partial_image`
- **THEN** the event artifact can be decoded independently and its index is non-negative and monotonic for that output

### Requirement: End-to-end cancellation and acceptance-aware retry
The orchestrator SHALL propagate the caller `AbortSignal` to provider acquisition, asset reads, and the image job; it SHALL invoke job cancellation at most once and stop yielding binary output after cancellation. A request MUST NOT be transparently retried after `accepted` unless an upstream idempotency guarantee explicitly proves the retry safe.

#### Scenario: Caller cancels an active job
- **WHEN** the caller aborts after the job starts but before a terminal event
- **THEN** the job cancel operation is invoked once, the stream terminates as `request_cancelled`, and no later provider output is forwarded

#### Scenario: Failure follows acceptance
- **WHEN** transport or timeout failure occurs after `accepted`
- **THEN** the orchestrator surfaces the stable failure without starting a replacement image job

### Requirement: Stable errors and truthful usage
The foundation SHALL expose the image error codes required by the complete image-generation design, safe parameter/retry metadata, and redacted diagnostics while retaining original causes only inside trusted process state. Image usage SHALL be present only when validated upstream data exists; missing usage MUST be omitted rather than synthesized as zero, and subscription consumption MUST NOT be converted to API-dollar cost.

#### Scenario: Missing usage is omitted
- **WHEN** a provider completes without trustworthy token or image usage values
- **THEN** the completed event contains no usage object and metadata may record only `usageUnavailable=true`

#### Scenario: Upstream error maps without secrets
- **WHEN** the provider reports authentication, rate limit, subscription limit, moderation, timeout, protocol drift, or cancellation
- **THEN** the public failure uses the corresponding stable image error code and contains no token, Cookie, account identifier, prompt, image bytes, Base64, or private upstream body

### Requirement: Tenant-safe artifact and reference ports
The foundation SHALL define opaque artifact/reference ports that can retain final binary content or an opaque provider reference behind a random public ID, enforce tenant/key isolation, distinguish same-tenant expiry from absence, and lease resolved content so cleanup cannot delete an actively used artifact. The ports MUST support configurable TTL and deletion without defining or advertising a generic Files API.

#### Scenario: Same tenant resolves an active reference
- **WHEN** the originating tenant resolves an unexpired image call/reference ID
- **THEN** the store returns a content lease and cleanup preserves the artifact until the lease is released

#### Scenario: Cross-tenant reference is hidden
- **WHEN** a different tenant/key attempts to resolve an existing reference
- **THEN** resolution is indistinguishable from `image_reference_not_found` and reveals no metadata

#### Scenario: Same-tenant reference expired
- **WHEN** the originating tenant resolves a reference after its TTL with no active lease
- **THEN** resolution reports `image_reference_expired` and the content is eligible for cleanup

### Requirement: Metadata-only image observability
Image orchestration SHALL emit only a bounded metadata record containing identifiers, provider/model/action and enum options, counts/byte sizes/dimensions, timing, terminal code, and the truthful usage-availability flag. Its observability interface MUST make prompt text, raw images, masks, Base64/data URLs, credentials, Cookies, and opaque account IDs structurally unavailable.

#### Scenario: Metadata sink receives a successful job
- **WHEN** an image job completes
- **THEN** the sink receives bounded counts, byte sizes, timing, and selected non-sensitive enums without any content-bearing field

#### Scenario: Sink failure is non-fatal
- **WHEN** the metadata sink throws or rejects
- **THEN** image execution and its client-facing terminal result are unaffected

