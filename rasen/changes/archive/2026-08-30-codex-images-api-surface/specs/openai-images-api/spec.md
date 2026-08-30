## ADDED Requirements

### Requirement: Exported Images operation contributions
The core image module SHALL export self-contained contributions for the existing extension operations `images.generate` and `images.edit`. Each contribution MUST expose its operation ID and handler without registering itself, and the final integrator MUST be able to register both through the existing operation registry without modifying the shared operation classifier, registry implementation, `openaiResponsesIngress.ts`, or `providerProxyShared.ts`.

#### Scenario: Integrator registers both contributions
- **WHEN** an app-session composition creates the Images dependencies and registers the two exported contributions
- **THEN** authenticated `POST /v1/images/generations` and `POST /v1/images/edits` requests dispatch to the image handlers while unregistered extension operations remain fail-closed

#### Scenario: Shared operation code remains unchanged
- **WHEN** the Images API surface is built and tested
- **THEN** no product or test edit exists under `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, or `providerProxyShared.ts`

### Requirement: Generate request normalization
The generate handler SHALL accept bounded `application/json` and normalize `prompt`, configured image model/default alias, `n`, `quality`, `size`, `background`, `output_format`, `output_compression`, `moderation`, `stream`, `partial_images`, and an optional `user` fingerprint into one `NormalizedImageGenerateRequest`. It MUST reject unknown or malformed values, blank or over-32,000-character prompts, `n` outside `1..10`, invalid GPT Image dimensions, transparent JPEG, PNG compression, and partial images without streaming before invoking the orchestrator.

#### Scenario: Valid generation reaches the orchestrator
- **WHEN** a caller submits a valid generation body and every requested feature is affirmed by the acquired capability snapshot
- **THEN** the handler invokes the configured provider through `ImageOrchestrator.run` exactly once with the normalized values and request-lifetime abort signal

#### Scenario: Invalid option combination is local
- **WHEN** a caller requests transparent JPEG, compression for PNG, an invalid dimension, or non-stream partial images
- **THEN** the handler returns `invalid_image_request` naming only the safe parameter and upstream start count remains zero

#### Scenario: Unsupported capability is not substituted
- **WHEN** normalization succeeds but the selected account capability cannot affirm the requested model, format, transparency, count, streaming, or moderation behavior
- **THEN** the request returns `unsupported_model` or `unsupported_capability` without changing the requested option or synthesizing a fallback

### Requirement: Edit request normalization
The edit handler SHALL accept bounded `multipart/form-data` and `application/json`, preserve the order of one to sixteen reference images, accept an optional mask, and normalize the same output/streaming options as generation into one `NormalizedImageEditRequest<ImageAsset>`. Multipart SHALL accept the official repeated `image` form and the documented `image[]` compatibility form; JSON SHALL accept supported `image_url` or `file_id` reference objects only through the bounded asset-resolution layer.

#### Scenario: Multipart multi-reference edit
- **WHEN** an OpenAI SDK sends repeated image parts, scalar options, and an optional mask
- **THEN** the handler supplies the validated assets to the orchestrator in request order with the mask kept distinct

#### Scenario: JSON references resolve before dispatch
- **WHEN** a JSON edit contains supported tenant-owned image references
- **THEN** every reference is leased and validated before the orchestrator starts and every lease is released after the terminal outcome

#### Scenario: Unresolvable carrier fails honestly
- **WHEN** a JSON edit uses `file_id` or remote `image_url` but the required resolver or verified capability is unavailable
- **THEN** the handler returns `unsupported_capability`, `image_reference_not_found`, or `image_reference_expired` and never advertises a generic Files API

### Requirement: OpenAI-compatible non-stream response
After a successful non-stream job, the handler SHALL return `created` plus exactly `n` `data` entries containing bounded Base64 `b64_json`. It MUST include `revised_prompt` and image usage only when the orchestrator supplied verified values, MUST translate usage field names to the OpenAI Images shape, and MUST omit unknown usage rather than write zero or a cost estimate.

#### Scenario: Successful response contains exact output count
- **WHEN** a non-stream request for `n` images completes successfully
- **THEN** the response is JSON, `data.length` equals `n`, and each decoded `b64_json` is the exact independently decodable artifact returned for that output

#### Scenario: Usage is unavailable
- **WHEN** the provider completes without verified usage or revised prompt data
- **THEN** the response omits those fields and does not synthesize token counts, subscription consumption, cost, or prompt revision

### Requirement: Partial-image SSE with cancellation and backpressure
For `stream: true`, the handler SHALL emit `text/event-stream` frames using the endpoint-specific `image_generation.partial_image` / `image_generation.completed` or `image_edit.partial_image` / `image_edit.completed` event names. Every partial payload MUST contain a complete independently decodable Base64 image and its zero-based monotonic partial index, multi-output events MUST preserve their output index, final completion MUST not be omitted, and every socket write MUST honor backpressure while racing the request abort signal.

#### Scenario: Generation emits partial and final events
- **WHEN** the orchestrator emits accepted, partial images, and a completed event
- **THEN** the client receives ordered endpoint-specific partial frames followed by one completion for every final output and no synthetic partial copied from a final image

#### Scenario: Slow client applies backpressure
- **WHEN** a response write returns false
- **THEN** the handler waits for drain or cancellation before reading/encoding and writing more image data, keeping bounded in-flight memory

#### Scenario: Client disconnect cancels upstream work
- **WHEN** the HTTP client disconnects before the terminal event
- **THEN** the registry request signal aborts the orchestrator/job, temporary resources are released, and the handler does not write a later completed or error frame to the closed socket

### Requirement: Stable Images error wire
Before streaming begins, every image-domain failure SHALL map to an OpenAI-compatible JSON `error` object containing only the stable message, `type`, `code`, optional safe `param`, verified retry timing, and verified coarse moderation details. After SSE headers begin, a non-cancellation failure SHALL become one bounded SSE error frame followed by stream closure. Unexpected exceptions MUST be normalized without exposing causes, request bodies, prompt text, image bytes, Base64, credentials, account identity, or private upstream fields.

#### Scenario: Moderation error retains only verified detail
- **WHEN** the provider reports a verified moderation block with a stage and coarse categories
- **THEN** the response uses `image_generation_user_error` and `moderation_blocked` with only those allow-listed details and no invented score

#### Scenario: Protocol drift is diagnostic but redacted
- **WHEN** the private response cannot be recognized or contains a malformed image
- **THEN** the client receives `upstream_protocol_changed` with HTTP 502 or an SSE error and no upstream body excerpt

#### Scenario: Retry-After is validated
- **WHEN** an upstream rate or subscription limit supplies a valid retry delay
- **THEN** the public response preserves the bounded delay while invalid or absent timing is omitted

### Requirement: Request identity and content-safe observability
Each handler SHALL create an Omnicross request ID, return it through a safe response header, derive tenant identity from an injected trusted route resolver, and never use the inbound bearer token as an identity or upstream credential. The optional `user` value MAY become only an injected keyed irreversible fingerprint; without such a facility it MUST be omitted from normalized telemetry.

#### Scenario: Outbound key scopes references
- **WHEN** an authenticated outbound-key route invokes an edit
- **THEN** asset/reference resolution uses its trusted tenant ID and a different key cannot infer or resolve those references

#### Scenario: Raw user value is unavailable to logs
- **WHEN** a request includes `user`
- **THEN** ordinary audit/telemetry receives only a keyed irreversible fingerprint or no field, never the original value

### Requirement: Official SDK contract compatibility
The Images contributions SHALL be exercised through current stable OpenAI JavaScript and Python SDK request constructors against a local real HTTP server and fake image provider. The contract suite MUST cover generation, multipart single/multi-image edit, mask edit, transparent PNG/WebP, non-stream Base64, streaming partials, cancellation, and representative stable errors without requiring live subscription entitlement.

#### Scenario: JavaScript SDK generate and edit
- **WHEN** the JavaScript SDK targets the local Omnicross test server
- **THEN** its `images.generate` and `images.edit` calls complete through the exported contributions with the expected response objects and multipart ordering

#### Scenario: Python SDK generate and edit
- **WHEN** the Python SDK targets the same local contract server
- **THEN** its generate and edit calls use accepted wire shapes and decode the returned image content without a custom client workaround

