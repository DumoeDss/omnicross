# rasen-managed-route-leases Specification

## Purpose
TBD - created by archiving change rasen-managed-route-lease. Update Purpose after archive.
## Requirements
### Requirement: Resident Route Lease lifecycle
The daemon MUST own one process-lifetime Route Lease manager over the existing resident `ProviderProxy`. Each active lease MUST register exactly one frozen `RouteContext` through the shared route map, release only its own route token, and MUST NOT stop or restart the proxy. The manager MUST release all leases on daemon shutdown, automatically reclaim expired routes, keep route tokens only in memory, and MUST NOT create an Outbound API Key, Integration Key, or GatewayBinding.

#### Scenario: Multiple stages reuse one daemon
- **WHEN** several Rasen stages create and release leases during one daemon process
- **THEN** every lease uses the same resident proxy and releasing one lease removes only its route

#### Scenario: Daemon shutdown cleans all leases
- **WHEN** the daemon shuts down with active leases
- **THEN** the manager best-effort removes every lease route before the resident proxy stops

#### Scenario: Lease creation leaves persistent routing data unchanged
- **WHEN** a lease is created and released
- **THEN** persistent outbound key, integration key, GatewayBinding, and user CLI configuration stores are byte-for-byte unchanged

### Requirement: Versioned creation and scoped idempotency
Creation MUST require schema version `omnicross.route-lease.request/1` and an `Idempotency-Key` bounded to 1-256 allowed ASCII characters. Within a normalized consumer scope, the manager MUST compare a canonical semantic-payload hash: a live same-key/same-payload retry MUST return the same lease, token-bearing descriptor, and HTTP 200; a same-key/different-payload retry MUST return HTTP 409 `idempotency_conflict`; a released or expired prior lease MUST allow a new lease id and HTTP 201. The key MUST NOT be used as a filesystem path or logged without bounded hashing/redaction.

#### Scenario: Lost create response is retried safely
- **WHEN** a consumer repeats an identical create request with the same idempotency key while the first lease is active
- **THEN** the API returns HTTP 200 with the original lease id and exact original launch descriptor without registering another route

#### Scenario: Idempotency payload conflict
- **WHEN** a consumer reuses a live idempotency key with a different runtime, upstream, model, execution, or TTL payload
- **THEN** the API returns HTTP 409 `idempotency_conflict` and leaves the original lease unchanged

#### Scenario: Expired idempotency key creates a new lease
- **WHEN** the lease formerly associated with a key has expired or been released and the consumer retries creation
- **THEN** the API creates a new independent lease id and token and clearly returns HTTP 201

### Requirement: Explicit upstream target contract
Create MUST accept exactly the `provider`, `account`, `account-group`, and `account-pool` discriminated target kinds aligned with `GatewayBindingTarget`. A provider with `keyId`, an account, and a group boundary MUST be strict; an account group MUST schedule only eligible members of that group; account pool MUST use the specified subscription provider's eligible pool. Only an explicitly selected pool-capable target MAY switch credentials under existing health, priority, allowance, and quota policy. Resolution MUST NOT fall back to a global default provider and MUST NOT persist an ephemeral GatewayBinding.

#### Scenario: Strict provider key selection
- **WHEN** creation names a provider and `keyId`
- **THEN** the frozen route uses that eligible key or creation fails without selecting another key

#### Scenario: Strict subscription account selection
- **WHEN** creation names a provider and account id
- **THEN** the route binds that eligible account or creation fails without selecting another account

#### Scenario: Account group stays within its group
- **WHEN** creation names an account group with multiple healthy and unhealthy accounts
- **THEN** existing scheduling selects only an eligible member of that group and never an account outside it

#### Scenario: Full account pool is explicit
- **WHEN** creation names `account-pool` for a subscription provider
- **THEN** existing pool scheduling may select an eligible account only from that provider

#### Scenario: Missing or disabled strict resource
- **WHEN** the requested provider, key, account, group, or pool does not exist, is disabled, lacks usable credentials, or has no schedulable candidate
- **THEN** creation returns the corresponding structured `upstream_not_found`, `upstream_unavailable`, or `upstream_exhausted` error before route registration

### Requirement: Closed runtime-to-ingress mapping
The version 1 runtime set MUST contain only `claude` and `codex`. Claude MUST map to `anthropic-messages` at `POST /v1/messages`; Codex MUST map to `openai-responses` at `POST /openai/responses`. Callers MUST NOT submit an arbitrary ingress string, and unknown runtimes MUST fail with `runtime_unsupported` rather than entering a default branch.

#### Scenario: Supported runtime mapping
- **WHEN** a valid Claude or Codex lease is created
- **THEN** its frozen route uses the documented deterministic ingress and wire path

#### Scenario: Unknown runtime is rejected
- **WHEN** creation requests a runtime outside the version 1 capability set
- **THEN** creation returns HTTP 400 `runtime_unsupported` without registering a route

### Requirement: Static preflight before route publication
Before creating a route, the service MUST statically verify that the selected resource exists and matches its target kind, credentials or subscription profile can be resolved, the model is non-empty and allowed for the resource, the ingress-to-upstream-format transformer chain can be resolved in both directions, the resident proxy is ready, and the runtime launch adapter is available. Preflight MUST NOT call a billable model endpoint. An unsupported format combination MUST return `format_unsupported` before child launch rather than an upstream 502.

#### Scenario: Unsupported transformer combination fails early
- **WHEN** no registered transformer chain can bridge the runtime ingress to the selected upstream API format
- **THEN** creation returns HTTP 400 `format_unsupported` and no route or lease remains

#### Scenario: Model is missing or disallowed
- **WHEN** model is blank or not enabled for the selected provider/account
- **THEN** creation returns `model_not_configured` before registering a route

#### Scenario: Static preflight makes no paid request
- **WHEN** a valid lease is created against a mock resource that records upstream calls
- **THEN** creation succeeds without any upstream model request

### Requirement: Frozen routing and model authority
The lease MUST freeze its upstream selector, auth mode, runtime ingress, actual upstream model, and safe attribution in `RouteContext`. A client request-body model MUST NOT change the selected upstream model. If a client-visible model is preserved in response projection, usage and cost attribution MUST still name the actual provider and upstream model.

#### Scenario: Client model cannot reroute the lease
- **WHEN** a client sends a different model name through an active lease token
- **THEN** the proxy invokes the frozen upstream/model and does not consult a default or recent route

#### Scenario: Usage records actual upstream identity
- **WHEN** response projection preserves a client-facing model alias
- **THEN** usage attribution records the frozen actual provider and model rather than the alias or route token

### Requirement: Independent ephemeral bearer tokens
Each newly created lease MUST receive a distinct 256-bit cryptographically random route token different from its public lease id. Exact token lookup MUST select only that lease's `RouteContext`. Unknown, expired, released, and pre-restart tokens MUST return 401 with no fallback. The proxy MUST remove downstream auth headers and re-authenticate with OmniCross-held upstream credentials; the route token MUST NOT be forwarded as an upstream API key.

#### Scenario: Concurrent tokens isolate routes
- **WHEN** two leases target different providers or models concurrently
- **THEN** each token reaches only its own frozen route and the tokens and lease ids are all distinct

#### Scenario: Invalid token fails closed
- **WHEN** the proxy receives an unknown, expired, released, or old-process route token
- **THEN** it returns 401 and does not route through any configured default

#### Scenario: Upstream receives stored credential only
- **WHEN** a leased request reaches a mock upstream
- **THEN** downstream token/sentinel headers have been stripped and the request uses the selected OmniCross-held credential

### Requirement: Argv-safe runtime launch descriptors
Successful creation MUST return `RuntimeLaunchDescriptor { env: Record<string,string>, extraArgs: string[] }`. `extraArgs` MUST be discrete argv entries and MUST NOT be a shell command. The descriptor MUST contain only runtime routing/auth material; prompt, sandbox, approval, output schema, structured-output, and resume arguments remain the caller's responsibility. No secret MAY appear in argv.

#### Scenario: Descriptor is directly spawnable
- **WHEN** Rasen merges the returned environment and appends `extraArgs` to a direct child-process argv array
- **THEN** the runtime reaches the resident proxy without shell parsing or global configuration writes

### Requirement: Codex uses a dedicated custom-provider env key
The Codex descriptor MUST set only `OMNICROSS_CODEX_ROUTE_TOKEN=<route-token>` as its route secret and MUST include exact argv overrides for provider `omnicross`, display name `OmniCross`, resident base URL ending `/openai`, `wire_api="responses"`, `env_key="OMNICROSS_CODEX_ROUTE_TOKEN"`, and `disable_response_storage=true`. It MUST NOT set `requires_openai_auth`, place the token in `OPENAI_API_KEY`, read or write `auth.json`, or write `config.toml`.

#### Scenario: Codex descriptor contract
- **WHEN** a Codex lease is created
- **THEN** its environment and argv exactly select the reserved OmniCross custom provider through `OMNICROSS_CODEX_ROUTE_TOKEN` and contain no alternate auth mode

#### Scenario: Codex login state is irrelevant
- **WHEN** Codex has no OpenAI/ChatGPT login or has unrelated existing login/config files
- **THEN** the leased Codex process authenticates through the dedicated route env key without reading or modifying those files

### Requirement: Claude descriptor contains no upstream credential
The Claude descriptor MUST include the resident `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=<route-token>`, a non-secret `ANTHROPIC_API_KEY` sentinel when required, and `ANTHROPIC_MODEL=<frozen-model>`. It MUST NOT include an upstream credential or read/write Claude credentials or settings.

#### Scenario: Claude descriptor contract
- **WHEN** a Claude lease is created
- **THEN** its environment contains only the proxy base, lease token, non-secret sentinel, and frozen model needed for the child

#### Scenario: Claude user settings remain untouched
- **WHEN** a leased Claude process runs and exits
- **THEN** the user's Claude credentials and settings hash, mtime, and size are unchanged

### Requirement: Authenticated loopback-only Admin API
The daemon MUST expose create, list, get, renew, and delete endpoints under `/admin/api/route-leases`, plus capability discovery. Every endpoint MUST pass the existing Admin authentication gate and independently require a loopback socket peer without trusting forwarded headers. Endpoints MUST NOT launch a terminal or agent process. Create and renew responses MUST set `Cache-Control: no-store`, and access logging MUST NOT record secret request/response bodies or authentication/idempotency headers.

#### Scenario: Authorized loopback create
- **WHEN** an authenticated loopback client posts a valid create request
- **THEN** the API returns HTTP 201 with `Cache-Control: no-store` and a lease descriptor without opening a process

#### Scenario: Authentication failure
- **WHEN** a request omits or supplies the wrong configured Admin control token
- **THEN** the existing control-plane gate returns 401/403 without invoking the lease manager

#### Scenario: Forwarded header cannot bypass loopback
- **WHEN** a non-loopback socket sends a valid Admin token and a forged loopback forwarded header
- **THEN** the Route Lease API rejects it and creates no lease

#### Scenario: Renew response is non-cacheable and secret-free
- **WHEN** an active lease is renewed
- **THEN** the response sets `Cache-Control: no-store`, updates expiry, and contains no token or launch descriptor

### Requirement: Token-free metadata and bounded attribution
List and get MUST return explicit metadata DTOs containing lease id, consumer, runtime, credential-free upstream selector, frozen model, created/expiry/activity timestamps, status, and optional bounded execution attribution. They MUST NOT return route token, launch secrets, Admin token, upstream credentials, prompts, or request/response bodies. Raw session id MUST be replaced with a domain-separated per-process hash; run/stage/idempotency fields MUST have byte limits and reject log-control characters. Usage MAY attribute by consumer/run/stage/lease but MUST NOT use the route token as an attribution id.

#### Scenario: Metadata serialization is whitelist-only
- **WHEN** list/get serializes leases created with canary tokens, credentials, and session ids
- **THEN** the response contains only the safe metadata schema and none of the canary secrets or raw session id

#### Scenario: Execution identifiers are bounded
- **WHEN** a create request supplies overlong or log-unsafe consumer/run/stage/session/idempotency values
- **THEN** creation returns `invalid_request` without logging or storing the unsafe value

#### Scenario: Prompt data is absent from lease diagnostics
- **WHEN** requests containing prompts pass through a leased route
- **THEN** lease metadata, manager logs, errors, audit details, and telemetry contain no prompt or body content

### Requirement: Bounded TTL, renewal, and idempotent release
Every lease MUST have an absolute `expiresAt`, a default TTL of 600 seconds compatible with the existing route-map duration, and a maximum TTL of 3600 seconds. No permanent/unbounded lease is allowed. Renewing an active lease MUST extend the lease and underlying route validity without changing its token. Releasing MUST invalidate the token immediately and run cleanup once. Repeated DELETE MUST return success with `released: false`. Renewing a released/expired lease MUST return `lease_not_found` or `lease_expired`. Expiry and races MUST be controllable by a fake clock.

#### Scenario: Renew preserves token
- **WHEN** Rasen renews an active lease before expiry
- **THEN** `expiresAt` and route validity extend while the original route token remains valid and unchanged

#### Scenario: Expiry reclaims route
- **WHEN** fake time reaches an active lease's absolute deadline without renewal
- **THEN** the manager marks it expired, removes its route, and the old token returns 401

#### Scenario: Double release is safe
- **WHEN** DELETE is called twice for the same lease
- **THEN** the first response reports `released: true`, the second reports `released: false`, and cleanup executes only once

#### Scenario: Cleanup race is isolated
- **WHEN** renew, release, route idle eviction, and expiry race
- **THEN** the lease reaches one valid terminal state without stopping the proxy or affecting another lease

### Requirement: Process-local restart semantics
Lease records, idempotency state, descriptors, and tokens MUST be process-local and MUST NOT be recovered after daemon restart. Rasen MAY recreate a lease from its own frozen logical request. A get for an old lease MUST return 404 rather than guessing or rebuilding a route.

#### Scenario: Restart invalidates all old authority
- **WHEN** the daemon restarts after issuing a lease
- **THEN** the old token returns 401, the old lease id returns 404, and a recreated request receives a new lease id and token

### Requirement: Concurrent lease isolation and capacity
The service MUST support at least 32 simultaneous active leases with approximately O(1) lease and token lookup. Concurrent stages and runs MAY share or differ in runtime, upstream, and model. Failure, expiry, or release of one lease MUST NOT change any other route or the resident proxy.

#### Scenario: Thirty-two concurrent leases remain independent
- **WHEN** at least 32 leases are created and exercised concurrently across repeated and distinct targets
- **THEN** every request resolves by its own token with no route/model/account cross-talk

#### Scenario: One failed lease does not cascade
- **WHEN** one lease's upstream request, renewal, expiry, or cleanup fails
- **THEN** other leases and the resident proxy continue serving normally

### Requirement: Stable structured errors
Lease failures MUST use `{ error: { type: 'route_lease_error', code, message, retryable } }` with the documented HTTP mapping for `invalid_request`, `runtime_unsupported`, `model_not_configured`, `format_unsupported`, `control_unauthorized`, `upstream_not_found`, `lease_not_found`, `idempotency_conflict`, `upstream_unavailable`, `lease_expired`, `upstream_exhausted`, and `daemon_not_ready`. Retryability MUST reflect operation semantics, `upstream_exhausted` MUST expose only a safe `Retry-After`, and messages MUST NOT contain credentials or tokens.

#### Scenario: Retryable readiness failure
- **WHEN** creation occurs before the resident proxy or required daemon dependency is ready
- **THEN** the API returns HTTP 503 `daemon_not_ready` with `retryable: true` and no secret

#### Scenario: Non-retryable identifier failure
- **WHEN** creation names a resource that does not exist
- **THEN** the API returns HTTP 404 `upstream_not_found` with `retryable: false` and only safe resource identifiers

#### Scenario: Pool exhaustion supplies safe backoff
- **WHEN** an explicitly selected account/key pool has no currently eligible candidate
- **THEN** the API returns HTTP 429 `upstream_exhausted` with a safe bounded `Retry-After` and no account secret

### Requirement: Versioned capability discovery
`GET /admin/api/route-leases/capabilities` MUST return a token-free versioned document with schema `omnicross.route-lease.capabilities/1`, runtimes `claude` and `codex`, the four upstream kinds, lease API version 1, Codex auth mode `env_key`, and maximum TTL 3600. Future runtime or incompatible schema changes MUST use versioned capability expansion rather than silently accepting unknown values.

#### Scenario: Rasen discovers compatible daemon
- **WHEN** an authenticated loopback client fetches capabilities
- **THEN** it can determine the runtime/upstream/auth/TTL contract before creating a stage lease

#### Scenario: Unknown request major version is rejected
- **WHEN** create uses an unsupported schema major version
- **THEN** the API returns `invalid_request` and does not partially interpret or register the request

### Requirement: Failure rollback and performance
Route registration and lease publication MUST be transactional: failure after adding a route MUST remove that route and leave no active lease or idempotency success entry. Cleanup MUST be best-effort and idempotent, and one cleanup exception MUST NOT stop shutdown cleanup. With the daemon and resident proxy already running, local create, renew, and delete P95 MUST be below 100 ms without an upstream model request.

#### Scenario: Publication failure rolls back route
- **WHEN** descriptor construction, registry publication, or timer setup fails after route registration
- **THEN** the route is removed and a retry can create one manageable lease without an orphan

#### Scenario: Cleanup continues after an exception
- **WHEN** cleanup for one route throws during shutdown
- **THEN** the manager records a redacted error and continues releasing remaining leases and the proxy

#### Scenario: Local lifecycle latency budget
- **WHEN** a repeatable local benchmark measures create, renew, and delete against ready in-memory/mock dependencies
- **THEN** each operation's P95 is below 100 ms and no operation restarts the proxy

### Requirement: Existing product paths remain compatible
Persistent Gateway API Keys/GatewayBindings, IntegrationManager, existing `omnicross launch`, UI terminal launch/stop, provider key pools, subscription account/group scheduling, transformer/usage attribution, and non-lease ProviderProxy traffic MUST remain functional. Claude/Codex terminal launch MUST share the lease creation/descriptor service before opening a terminal, and the machine Route Lease API MUST never call `IntegrationManager.install()`.

#### Scenario: Terminal launch shares lease service
- **WHEN** the existing UI or CLI launches Claude/Codex in a terminal
- **THEN** it creates the same validated lease/descriptor, then opens the terminal and releases the lease on stop/failure/expiry

#### Scenario: Machine create never launches or installs
- **WHEN** Rasen creates a Route Lease through the Admin API
- **THEN** no terminal, agent process, integration install, persistent key, or GatewayBinding operation occurs

#### Scenario: Legacy gateway and proxy regression
- **WHEN** existing persistent gateway, integration, launch, and non-lease proxy suites run
- **THEN** their prior routing, auth, scheduling, transformation, and cleanup behavior remains valid

### Requirement: Real runtime interoperability without configuration pollution
Delivery MUST include opt-in real `codex exec` and `claude -p` E2E against a real local daemon and local mock compatible upstreams. Each runtime MUST complete streaming and a tool-call round, exercise error/cancel/renew/release behavior, and prove user Codex/Claude config, auth, settings, and credential file hash/mtime/size are unchanged. Default CI MUST NOT issue paid model requests; any billable smoke MUST require explicit user-provided credentials and invocation.

#### Scenario: Real Codex uses Responses and tools
- **WHEN** an installed real Codex binary is launched with a Codex lease against a local mock upstream
- **THEN** it completes a Responses streaming tool-call round through OmniCross and leaves Codex user files unchanged

#### Scenario: Real Claude uses Messages and tools
- **WHEN** an installed real Claude binary is launched with a Claude lease against a local mock upstream
- **THEN** it completes a Messages streaming tool-call round through OmniCross and leaves Claude user files unchanged

#### Scenario: Default CI is non-billable
- **WHEN** the default automated suite runs without explicitly supplied billable-test credentials
- **THEN** real-runtime coverage uses local mocks or skips with a clear reason and makes no paid upstream request
