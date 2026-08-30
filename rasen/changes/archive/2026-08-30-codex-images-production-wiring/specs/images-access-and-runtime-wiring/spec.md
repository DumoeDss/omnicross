## ADDED Requirements

### Requirement: Explicit independent Images permission
The system SHALL represent `images` as an explicit named-key permission independent from the existing Chat, Responses, Messages, and Gemini routing endpoints. A legacy or newly created key whose permission list is absent MUST retain access to the four legacy families but MUST NOT gain Images access; an explicit list MUST be enforced exactly, and the native Codex/Claude integration-key defaults MUST NOT include Images.

#### Scenario: Legacy unrestricted key is upgraded
- **WHEN** a persisted key has no permission list and the daemon is upgraded
- **THEN** its existing four text endpoint behaviors remain unchanged and both Images endpoints return a pre-body 403 for that key

#### Scenario: Responses-only key attempts Images
- **WHEN** a key explicitly authorized for `responses` calls `/v1/images/generations` or `/v1/images/edits`
- **THEN** the system returns 403 before reading the body, resolving an account, entering the image queue, or calling a provider

#### Scenario: Images permission is granted explicitly
- **WHEN** an authenticated administrator atomically updates a live key's exact permission list to include `images`
- **THEN** subsequent Images requests can enter image runtime admission without automatically changing that key's other permissions

### Requirement: Strict permission persistence and administration
The key database, admin API, CLI-safe DTOs, and UI SHALL round-trip the exact permission list including `images`. `OutboundEndpoint` MUST remain the four-member text-routing vocabulary, while a distinct `OutboundPermission` adds `images` for key authorization. Permission updates MUST reject duplicates, unknown values, malformed arrays, missing/revoked keys, and unsafe partial writes without changing the stored row, and list/read responses MUST never reveal plaintext key material.

#### Scenario: Invalid permission update is failure-atomic
- **WHEN** an administrator submits an unknown permission or duplicate permission entry
- **THEN** the API returns 400 and the prior permission list remains byte-for-byte effective

#### Scenario: UI distinguishes Images from Responses
- **WHEN** key management displays or edits endpoint permissions
- **THEN** it renders separate `images` and `responses` choices and the daemon echo matches the saved exact list

### Requirement: Own-body Images outbound dispatch
After named-key authentication, rate limiting, loopback policy, and explicit Images permission, the outbound server SHALL dispatch the already-classified `images.generate` and `images.edit` operations through the app-session `OpenAIOperationRegistry` with the original request stream. It MUST NOT run downstream text-binding resolution, generic JSON/body audit capture, generic body buffering/replay, generic text concurrency, text cost conversion, or text model restriction before the Images contribution owns the body. Operation classification MUST occur early enough to suppress response-body wrapping while retaining metadata-only audit coverage for authentication and permission failures.

#### Scenario: Multipart edit reaches the contribution unconsumed
- **WHEN** an authorized client sends a chunked multipart edit through the daemon outbound listener
- **THEN** the registered edit contribution receives the original stream and its bounded multipart parser observes every part in order

#### Scenario: Unauthorized oversized upload is not consumed
- **WHEN** a non-Images key sends an oversized multipart request
- **THEN** the server rejects permission before consuming upload bytes or creating a temporary image resource

#### Scenario: Unregistered contribution fails closed
- **WHEN** an Images operation is authorized but its app-session handler is absent or the image runtime is disabled
- **THEN** the request returns a safe unsupported/unavailable error and no text ingress or upstream fallback is attempted

### Requirement: App-session Images composition
Daemon bootstrap SHALL construct one app-session `OpenAIOperationRegistry`, one image runtime manager, and one stable pair of forwarding contributions for `images.generate` and `images.edit` before the first resident `ProviderProxy` construction. It SHALL inject that registry into `ProviderProxyDeps`, register each Images operation exactly once, and dispose registrations/runtime resources exactly once during daemon shutdown or test reset.

#### Scenario: Real daemon boot registers both operations
- **WHEN** the daemon boots with Images configured
- **THEN** the shared registry contains exactly the exported generate and edit handlers and authenticated requests reach them through both the outbound listener and resident route dispatch

#### Scenario: Repeated bootstrap test reset does not leak registration
- **WHEN** daemon singleton reset and rebuild are performed repeatedly in one process
- **THEN** no duplicate-handler error, stale provider, store handle, timer, queue waiter, or contribution from the previous app session survives

### Requirement: Shared provider and orchestrator runtime
Each runtime generation SHALL obtain the configured Codex subscription `AuthStrategy` through `subscriptionAccounts.getStrategy('codex')`, construct the Codex subscription `ImageProvider`, register it in `ImageProviderRegistry`, and construct one `ImageOrchestrator` using the production reference store and metadata-only telemetry sink. The Images API and exported hosted Responses contribution MUST use that same provider/orchestrator/reference-store generation rather than duplicate transport, capability, retention, or cancellation behavior.

#### Scenario: Images generate uses configured Codex account pool
- **WHEN** an authorized generation request enters a runtime configured for the Codex subscription account pool
- **THEN** capability resolution and dispatch occur through one account-bound provider lease from the shared orchestrator

#### Scenario: Duplicate provider composition is rejected
- **WHEN** bootstrap attempts to register two image providers under the same configured provider ID
- **THEN** generation construction fails before publication and the active prior runtime, if any, remains unchanged

### Requirement: Trusted tenant and provider/account runtime resolution
The Images runtime resolver SHALL derive tenant identity only from non-empty authenticated `route.apiKeyId`, shall apply the configured image provider/model/aliases/limits/account or account-group hints, and shall supply the production reference/remote/user-fingerprint ports. It MUST reject missing trusted identity and MUST NOT use the raw inbound bearer as a tenant, scheduling key, upstream credential, fingerprint key, or logged value.

#### Scenario: Authenticated key scopes image references
- **WHEN** a request is authenticated as outbound key A and later key B presents A's reference
- **THEN** runtime resolution uses the two trusted key IDs as different tenants and B observes only `image_reference_not_found`

#### Scenario: Bound account remains stable
- **WHEN** configuration binds Images to one Codex account and a request acquires a provider lease
- **THEN** the same account supplies capability evidence, queue identity, authentication refresh, dispatch, and terminal attribution for that lease

#### Scenario: Raw bearer is replaced before local dispatch
- **WHEN** the outbound router prepares the trusted Images handler context
- **THEN** neither the context nor any upstream request contains the caller's Omnicross bearer secret

### Requirement: Hosted image factory remains injectable and dormant
Daemon composition SHALL expose an acquireable hosted-image contribution/factory that pins one runtime generation and returns the implemented `ResponsesImageGenerationContribution` plus deterministic release semantics. The factory MUST NOT self-register, inspect traffic, mutate the Native Responses ingress, or execute a provider until a final integrator invokes it.

#### Scenario: Daemon boots without a Responses integrator
- **WHEN** the daemon constructs and exposes the hosted factory but no integrator acquires it
- **THEN** Responses behavior, upstream requests, image state, and provider usage remain unchanged

#### Scenario: Final integrator acquires the factory
- **WHEN** a later integrator authorizes Responses affinity and acquires a hosted generation for one request
- **THEN** it can inspect and validate the real selected plan, create one scope, execute calls with its global allocator, commit before terminal success, dispose in `finally`, and release the generation

#### Scenario: Hot reload occurs during hosted execution
- **WHEN** a hosted request holds a generation lease while configuration is hot-reloaded
- **THEN** that request continues on its pinned provider/orchestrator/stores and later acquisitions use the newly published generation

### Requirement: Shared ownership boundaries remain intact
Production wiring SHALL NOT modify `packages/core/src/openai-operation/**`, any `openaiResponsesIngress.ts`, or `providerProxyShared.ts`, and SHALL NOT inject the hosted contribution into Responses ingress. It SHALL also exclude standalone web search, compact, Responses WebSocket, generic Files API, and stored/background Responses.

#### Scenario: Candidate tree is audited
- **WHEN** the production-wiring implementation is ready for verification
- **THEN** a forbidden-path check reports zero authored edits in all three ownership areas and no excluded product endpoint or fallback has been introduced
