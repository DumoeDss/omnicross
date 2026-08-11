## Context

OmniCross already owns one process-resident `ProviderProxy`, one `ProviderProxyRouteMap`, four ingress parsers, BYO key pools, subscription account scheduling, transformer chains, and per-CLI launch builders. The existing launch builders validate a provider, call `getProviderProxy().addRoute()`, return process environment/config overrides, and expose an `onSessionEnd` callback. The Admin `POST /admin/api/cli/:cli/launch` path immediately opens a terminal, so it cannot serve Rasen's machine-managed child-process lifecycle.

The route map already provides 256-bit random tokens, exact lookup, fail-closed 401 behavior, 10-minute idle reaping, and resident-proxy shutdown clearing. The outbound gateway already defines `GatewayBindingTarget` and projects its strict account/key hints into `RouteContext`. This change must compose those facilities without persisting a GatewayBinding, creating an outbound key, starting another proxy, or importing daemon concerns into core.

The consumer is a Rasen stage runner that needs an argv-safe descriptor for a single Claude or Codex child. The control plane handles secrets, idempotent retries, and lifecycle; Rasen continues to own prompt, sandbox, approval, output schema, and session/thread-resume arguments.

## Goals / Non-Goals

**Goals:**

- Add one daemon-lifetime lease registry over the existing resident route map, with deterministic create/renew/release/expiry/shutdown semantics.
- Resolve provider, exact key, exact subscription account, account group, or full account pool targets with existing selection semantics and no implicit global fallback.
- Fail before child launch when the resource, credential/profile, model, transformer chain, runtime adapter, or resident proxy is unavailable.
- Expose an authenticated, socket-loopback-only, versioned Admin API whose only secret-bearing response is successful create.
- Return exact Codex `env_key` and Claude environment descriptors without reading or writing user-global CLI state.
- Preserve terminal launch, persistent gateway, IntegrationManager, and all routes that do not use leases.
- Make expiry, races, rollback, redaction, concurrency, and configuration non-pollution testable.

**Non-Goals:**

- Remote daemon access, TLS/mTLS, multi-tenant lease authorization, or a public cloud control plane.
- Rasen workflow UI, run-record persistence, prompts/workspaces, or stage scheduling inside OmniCross.
- Persisting or recovering lease ids, route tokens, idempotency records, or launch descriptors across daemon restarts.
- Supporting user-defined runtimes/ingresses, server-side Codex response storage, or paid upstream calls in default CI.
- Removing persistent integrations, GatewayBinding, or existing terminal launch products.

## Decisions

### D1. A core lease manager owns lifecycle; daemon bootstrap owns the instance

Add a `RouteLeaseManager` beside the provider-proxy core with injected ports for target resolution, descriptor construction, route registration, and a clock. `buildDaemon()` creates exactly one manager after the resident `ProviderProxy` and supplies it to Admin and terminal-launch adapters. The manager does not own or stop the proxy.

The manager stores active records in `Map<leaseId, ActiveLease>` and idempotency entries in `Map<consumer + NUL + idempotencyKey, IdempotencyRecord>`. An active record contains the route token, frozen `RouteContext`, token-bearing launch descriptor, normalized payload hash, safe metadata, expiration timer, and idempotent cleanup state. Token-free released/expired tombstones are retained with a bounded age/count only to support status and double-release semantics; unknown DELETE is also a successful `{ released: false }`, so tombstone eviction does not break idempotency.

Alternative considered: put leases directly in `AdminServer` or create persistent GatewayBindings. That would bind lifecycle to HTTP, duplicate terminal logic, and violate the process-local/no-persistence contract.

### D2. Absolute lease TTL is authoritative; route-map idle TTL remains a safety net

Normalize `ttlSeconds` to an integer in `1..3600`, defaulting to 600. `expiresAt` is an absolute deadline set by create or renew; proxy traffic updates `lastActivityAt` but never extends that deadline. This preserves the existing 10-minute duration while ensuring an active stream cannot make a lease permanent. Rasen must renew explicitly.

Extend `ProviderProxyRouteMap` compatibly so a registered entry can report activity/eviction and its idle timer can be re-armed for the same token. `renew` first updates the manager deadline/timer and re-arms the underlying route without minting a new token. The manager's absolute timer calls one idempotent cleanup transition that removes only that token. Route-map idle eviction reports back so the lease becomes expired rather than remaining nominally active. Existing numeric `addRoute(context, idleMs)` callers remain supported.

Inject `Clock { now, setTimeout, clearTimeout }` into the manager. Fake-clock unit tests drive create, renew, expiry, release races, rollback, and shutdown without wall-clock sleeps.

Alternative considered: rely only on route-map lookup-touch idle expiry. That cannot guarantee a bounded lifetime or keep `expiresAt` and renew semantics authoritative.

### D3. Creation is a transaction with scoped, canonical idempotency

Creation performs these ordered steps:

1. Parse and normalize the versioned request. `idempotencyKey` is required from the `Idempotency-Key` header, 1-256 ASCII characters matching `[A-Za-z0-9._:-]+`; `consumer` is 1-64 safe bytes; run/stage ids are at most 128 UTF-8 bytes with controls/newlines rejected; session id is at most 512 bytes and is never retained raw in metadata; `attempt` is a positive bounded integer.
2. Canonicalize the semantic payload (schema version, consumer, runtime, upstream, model, execution, TTL) with stable object-key order and hash it with SHA-256. The header key itself is never used as a path and logs only a short digest.
3. Within consumer scope, return `200` with the exact same live lease and descriptor for a matching key/hash, return `409 idempotency_conflict` for a different hash, or discard a stale released/expired pointer and continue.
4. Resolve and statically preflight a frozen `RouteContext` and launch adapter without an upstream model request.
5. Register exactly one route, construct the descriptor from that token, then publish the lease/idempotency records and timer. Any exception after route registration removes the route before returning an error.

New creation returns `201`; a live idempotency replay returns `200`. Releasing/expiring drops the token and secret descriptor immediately and unlinks the live idempotency entry, allowing the same key to create a new lease id later.

Alternative considered: make the idempotency key equal the lease id or derive the token from it. That would couple public identity to bearer authority and weaken token independence.

### D4. Target resolution reuses gateway semantics without writing a binding

Define `RouteLeaseUpstream` as the existing `GatewayBindingTarget` shape and add a pure lease target resolver in core. It builds an ephemeral strict routing projection (equivalent to `gatewayBindingToEndpointConfig(... fallback: 'fail')`) and reuses/refactors the existing outbound route resolution helpers to produce `RouteContext`; no config row is written.

Selection behavior is explicit:

- `provider` resolves a BYO row; a provided `keyId` is strict and a missing/disabled/cooling key fails create. Without `keyId`, the configured provider/key-pool policy may select a key.
- `account` requires that exact enabled, credential-resolvable, model-compatible account and uses strict fallback.
- `account-group` requires at least one schedulable, model-compatible member and confines normal health/priority/allowance selection to that group.
- `account-pool` is the explicit opt-in to full provider-pool scheduling.

No branch consults the global default provider. Unknown, disabled, credential-less, or unschedulable resources are mapped to stable lease errors before route publication.

### D5. Runtime mapping and format preflight are closed and capability-driven

Use an exhaustive runtime table:

| Runtime | Endpoint projection | Ingress | Proxy URL |
|---|---|---|---|
| `claude` | messages | `anthropic-messages` | `<proxy>/v1/messages` |
| `codex` | responses | `openai-responses` | `<proxy>/openai/responses` |

Unknown runtime values return `runtime_unsupported`; there is no default branch. Before registration, the resolver verifies a non-empty configured model, provider/account model allowlist, credential/profile resolution, target API format, required registered transformer/endpoint chain in both request and response directions, resident proxy readiness, and descriptor adapter availability. Transformer preflight uses the same registry/chain-resolution helpers as serving, not a second hard-coded compatibility table. It performs no upstream network request.

The resulting `RouteContext` freezes actual provider/account hints, ingress, auth mode, and upstream model. Ingress handlers continue rewriting request-body model to `route.model`; optional response projection may preserve the client's visible name, while usage records the real provider/model.

### D6. Descriptor construction is pure, secret-minimal, and argv-safe

Extract pure Claude/Codex descriptor functions from the current launch builders. They accept the already-started proxy base URL, frozen model, and route token, and return `RuntimeLaunchDescriptor { env, extraArgs }`. The lease manager injects these functions; existing CLI-launcher exports can call the same functions and wrap cleanup for compatibility.

Codex returns only `OMNICROSS_CODEX_ROUTE_TOKEN=<token>` in `env` and the discrete argv sequence:

```text
-c model_provider="omnicross"
-c model_providers.omnicross.name="OmniCross"
-c model_providers.omnicross.base_url="http://127.0.0.1:<port>/openai"
-c model_providers.omnicross.wire_api="responses"
-c model_providers.omnicross.env_key="OMNICROSS_CODEX_ROUTE_TOKEN"
-c disable_response_storage=true
```

It never sets `requires_openai_auth` or `OPENAI_API_KEY`. Claude returns `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, the existing non-secret `ANTHROPIC_API_KEY` sentinel, and `ANTHROPIC_MODEL`. Upstream credentials never enter either descriptor. Neither builder reads or writes `config.toml`, `auth.json`, Claude credentials, or settings.

Alternative considered: send a shell command or token-bearing argv. Both are unsafe on Windows and expose secrets via quoting/process-list behavior.

### D7. Token-bearing and token-free DTOs are separate types

Define separate create-result and metadata projections so list/get/renew cannot accidentally serialize `routeToken` or `launch.env`. Only the active in-memory record has those fields. Lease ids use random UUIDs and are never the route token; route tokens remain independent 32-byte cryptographic random values minted by the route map.

Metadata contains consumer, runtime, credential-free upstream selector, frozen model, timestamps/status, and bounded execution attribution. The manager hashes raw session ids with a per-process random HMAC key and the domain `omnicross.route-lease.session/v1`; only the hex digest is stored. Extend usage attribution with token-free lease/consumer/run/stage fields, never the token. Prompt and request/response bodies are not lease-manager inputs and are never logged by it.

All errors and logs pass whitelist projections. Automated tests serialize every metadata/error/audit/log surface with canary secrets and assert absence.

### D8. Admin API is a thin authenticated, loopback-only adapter

Add a focused `routeLeaseApi.ts` and route `route-leases` from the Admin control plane after its existing bearer/x-admin-token gate. The handler independently checks `req.socket.remoteAddress` with the existing loopback predicate and ignores forwarded headers, even if the general dashboard was configured for LAN binding.

Endpoints are:

- `POST /admin/api/route-leases`
- `GET /admin/api/route-leases`
- `GET /admin/api/route-leases/capabilities` (matched before `:leaseId`)
- `GET /admin/api/route-leases/:leaseId`
- `POST /admin/api/route-leases/:leaseId/renew`
- `DELETE /admin/api/route-leases/:leaseId`

Create and renew always set `Cache-Control: no-store`; create is the only endpoint that can serialize the route token, inside the descriptor. Access logging must not capture authorization/idempotency headers or request/response bodies on these routes. No handler imports a terminal opener or child-process API.

Errors use `{ error: { type: 'route_lease_error', code, message, retryable } }` and the documented status/code mapping. The service throws typed domain errors; the HTTP adapter only maps them. Unknown major request schema versions are rejected, while additive fields under major version 1 are ignored/retained only where explicitly supported.

Capabilities are static/versioned plus the configured max TTL. The integration guide requires Rasen to use loopback and warns/refuses a non-loopback endpoint when no control token is configured; the server itself refuses every non-loopback Route Lease request regardless of headers.

### D9. Existing launch paths share the service without changing products

For Claude and Codex terminal launches, the daemon creates an internal lease (`consumer: omnicross-terminal`, unique internal idempotency key), opens the terminal with its descriptor, stores `leaseId` in the session registry, and releases it on stop/failure/shutdown. `omnicross launch` follows the same composition. Other CLI builders continue their existing route registration until their runtimes are added to the versioned lease capability.

Persistent outbound keys/GatewayBindings and `IntegrationManager` are not invoked by lease creation. Non-lease proxy requests use the same route map and ingress handlers unchanged. Daemon shutdown calls `routeLeaseManager.shutdown()` before `providerProxy.stop()`, then performs existing cleanup; one cleanup failure is caught and does not prevent remaining leases or the proxy from being stopped.

Alternative considered: leave terminal paths on independent builders. That would preserve duplicate creation/preflight logic and make regression comparison harder.

### D10. Verification has deterministic and opt-in real-CLI layers

Core tests cover schema, target union, strict selection, runtime table, transform preflight, canonical idempotency, token independence, fake-clock lifecycle/races, rollback, metadata whitelists, and 32+ concurrent leases. Daemon HTTP tests cover auth, socket loopback, status/error mapping, headers, create-to-proxy-to-mock-upstream-to-release, shutdown/restart, and absence of persistent key/binding writes. CLI-launcher tests assert every exact argv element and environment key.

Real Codex and Claude executable E2E uses a real daemon and local mock Anthropic/OpenAI-compatible upstreams, includes streaming/tool/cancel/renew/release paths, and snapshots hash/mtime/size for user CLI config/credential files before and after. It is opt-in and skips with an explicit reason when binaries are absent. A separately documented manual smoke may use user-supplied billable credentials; default CI never does.

## Risks / Trade-offs

- [Risk] A lease timer and route-map idle timer race during renew/release. → Route state transitions and cleanup are idempotent, renew validates active state before rearming both timers, and fake-clock race tests cover every ordering.
- [Risk] Refactoring outbound target resolution could regress persistent GatewayBindings. → Extract shared pure helpers without changing existing call-site inputs and run the full outbound binding/account/key regression suite.
- [Risk] A future Codex CLI changes custom-provider override syntax. → Keep exact contract tests plus opt-in real-binary E2E; capability discovery advertises `codexAuthMode: env_key` and creation fails if the adapter is unavailable.
- [Risk] List/get serialization leaks a token through object spread or errors. → Use explicit metadata constructors and token-bearing/token-free types with canary redaction tests; never serialize internal records.
- [Risk] Terminal launch cleanup is not observable after detached process exit. → Preserve explicit stop plus bounded lease expiry; expiry is the final safety net.
- [Trade-off] Absolute TTL requires Rasen renewals during long active stages. → This is intentional to prevent unbounded live leases and provides a deterministic recovery contract.

## Migration Plan

1. Land types, pure descriptor builders, route-map lifecycle hooks, and manager tests without exposing HTTP.
2. Wire one manager into daemon bootstrap and shutdown; add the Admin API and integration tests behind the new versioned path.
3. Migrate Claude/Codex terminal launch composition to the manager and run existing launch, integration, outbound gateway, account scheduling, transformer, typecheck, build, and test suites.
4. Run local mock-upstream real-CLI E2E where binaries are available; perform one explicitly authorized manual paid smoke separately.

Rollback removes the new Admin route and returns terminal call sites to the compatibility builders. No data migration or token revocation database is needed: process-local leases disappear on restart, and persistent gateway/integration data is untouched.

## Open Questions

None. Runtime expansion and remote control-plane transport require a future capability/schema version rather than an implementation-time choice in this change.
