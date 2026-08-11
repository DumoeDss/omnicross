## 1. Route Lease contracts and validation

- [x] 1.1 Add core Route Lease request, upstream union, runtime, metadata, token-bearing create result, token-free renew/release result, capability, adapter-port, clock, and typed error contracts with the exact version-1 constants and field limits from the design.
- [x] 1.2 Implement request/header parsing and normalization for schema major version, idempotency key, consumer, runtime, upstream discriminants, model, execution attribution, and `ttlSeconds` (default 600, range 1-3600), rejecting control characters and byte-limit violations without echoing unsafe input.
- [x] 1.3 Implement stable semantic payload canonicalization/hashing and domain-separated per-process session-id HMAC projection; unit-test key-order independence, payload-sensitive fields, bounded identifiers, and absence of raw session/idempotency values in safe projections.

## 2. Route-map lifecycle seams

- [x] 2.1 Extend `ProviderProxyRouteMap`/`ProviderProxy.addRoute()` compatibly with lease registration options for activity and eviction callbacks while preserving every existing numeric `idleMs` caller and 256-bit token behavior.
- [x] 2.2 Add same-token route renewal/re-arm and idempotent eviction/removal behavior, ensuring lookup activity is observable without exposing the token through metadata or logs.
- [x] 2.3 Expand route-map/ProviderProxy tests for legacy idle behavior, renew without token rotation, callback ordering, release/expiry races, exact lookup, and one-route cleanup isolation.

## 3. Strict target resolution and static preflight

- [x] 3.1 Add the exhaustive version-1 runtime table (`claude` → messages/`anthropic-messages`, `codex` → responses/`openai-responses`) and tests that unknown runtimes never enter a default branch.
- [x] 3.2 Extract/reuse the GatewayBinding target projection and outbound route-resolution helpers so an ephemeral strict provider/account/account-group/account-pool target produces a frozen `RouteContext` without writing a binding or consulting a global default.
- [x] 3.3 Implement provider target preflight for enabled provider rows, explicit strict `keyId`, configured/allowed model, resolvable BYO credential/key-pool semantics, and safe `upstream_not_found`/`upstream_unavailable`/`upstream_exhausted` mapping.
- [x] 3.4 Implement subscription account, account-group, and account-pool preflight using existing registry, credential, health, priority, allowance, and supported-model seams; prove strict account/group boundaries and pool-only fallback behavior.
- [x] 3.5 Implement resident-proxy readiness, runtime-adapter availability, and request/response transformer-chain resolution checks using serving's registered transformer SSOT, returning `format_unsupported` before route registration and without any upstream model request.
- [x] 3.6 Add target/preflight unit tests covering all upstream discriminants, missing/disabled/keyless/unschedulable resources, strict key/account/group failures, model rejection, unsupported formats, frozen request-body model behavior, and actual provider/model usage attribution.

## 4. Pure runtime launch descriptors

- [x] 4.1 Extract pure argv-safe descriptor builders from CLI launcher so already-resolved proxy URL/model/token inputs return `{ env, extraArgs }` without registering routes, opening processes, or touching user files.
- [x] 4.2 Replace the Codex contract with `OMNICROSS_CODEX_ROUTE_TOKEN` plus exact quoted `omnicross`/`OmniCross`/base URL/Responses/`env_key`/storage argv elements; remove `requires_openai_auth` and route-token `OPENAI_API_KEY` behavior.
- [x] 4.3 Preserve the Claude descriptor contract with resident base URL, `ANTHROPIC_AUTH_TOKEN`, non-secret API-key sentinel, and frozen model, excluding every upstream credential.
- [x] 4.4 Update CLI-launcher unit/regression tests to assert exact argv array boundaries and TOML quoting, secret-only-in-env discipline, no global config/auth/credential access, and compatibility wrappers' cleanup behavior.

## 5. RouteLeaseManager lifecycle and safety

- [x] 5.1 Implement the injected-clock `RouteLeaseManager` active registry, bounded token-free tombstones, safe metadata projection, activity timestamps, and O(1) lease/idempotency lookup without owning or stopping the resident proxy.
- [x] 5.2 Implement consumer-scoped same/same idempotent replay, same/different conflict, and released/expired recreate semantics while retaining the exact live descriptor only in memory and dropping secrets at the terminal transition.
- [x] 5.3 Implement transactional create ordering (normalize → idempotency → resolve/preflight → add route → descriptor → publish/timer) with rollback for every failure after route registration and no orphan route/idempotency success record.
- [x] 5.4 Implement absolute TTL expiry, same-token renew of manager and route deadlines, immediate idempotent release, double DELETE support, route-idle callback handling, and shutdown-all cleanup that continues after individual failures.
- [x] 5.5 Thread token-free consumer/run/stage/lease attribution into existing usage records while preserving actual provider/model and excluding route token, raw session id, prompt, and request/response body from logs/errors/telemetry.
- [x] 5.6 Add fake-clock manager tests for create/renew/release/expiry ordering, same-time races, rollback, tombstone bounds, daemon-style shutdown, old-token invalidation, cleanup exceptions, and restart-empty state.
- [x] 5.7 Add canary-secret serialization tests for create versus get/list/renew/release/error/audit/log projections, plus 32-or-more concurrent mixed-route isolation and a repeatable ready-daemon lifecycle benchmark demonstrating sub-100 ms P95 and no proxy restart.

## 6. Daemon bootstrap and Admin Route Lease API

- [x] 6.1 Construct one manager in `buildDaemon()` with the live provider proxy, provider/subscription/transformer dependencies, descriptor adapters, and default clock; expose it on the daemon and shut it down before `providerProxy.stop()` in all normal/test teardown paths.
- [x] 6.2 Add focused `/admin/api/route-leases` routing for create/list/get/renew/delete and match `/capabilities` before `:leaseId`, using explicit token-free DTO writers everywhere except successful create.
- [x] 6.3 Enforce the existing Admin token gate plus an independent socket-peer loopback check that ignores forwarded headers; set `Cache-Control: no-store` on create and renew and prevent access-log capture of authorization/idempotency headers or lease request/response bodies.
- [x] 6.4 Map every typed domain failure to the documented stable `route_lease_error` status/code/retryable contract, including safe bounded `Retry-After`, without serializing keys, tokens, credentials, or raw unsafe identifiers.
- [x] 6.5 Add Admin HTTP tests for every method/status, 201 versus idempotent 200, auth, forged-forwarded-header rejection, schema/field limits, no-store headers, metadata whitelists, double DELETE, expired/unknown behavior, and proof that endpoints never invoke a terminal opener or IntegrationManager.
- [x] 6.6 Add create → leased proxy request → selected mock upstream → renew/release integration tests for Claude and Codex, including different concurrent providers/models, token stripping/re-auth, A cleanup not affecting B, old-token 401, and manager/proxy shutdown cleanup.

## 7. Existing launch-path migration and compatibility

- [x] 7.1 Migrate Admin UI Claude/Codex terminal launch to create an internal unique lease, open the terminal only after success, store its lease id, and release on opener failure, stop, expiry, reset, and daemon shutdown; keep other CLI runtimes unchanged.
- [x] 7.2 Migrate `omnicross launch` Claude/Codex composition to the same manager/descriptor service and direct argv/env spawn contract without changing prompt or terminal UX.
- [x] 7.3 Update existing launch/session tests for the manager-backed path and prove stop/failure cleanup, resident proxy reuse, no persistent key/binding creation, and no user configuration writes.
- [x] 7.4 Run and fix regressions in persistent Gateway Key/GatewayBinding, IntegrationManager, Provider key pool, account/group/pool scheduling, Responses/Messages transformer, usage attribution, non-lease ProviderProxy, UI launch, and CLI launch suites.

## 8. Capability discovery, documentation, and real CLI E2E

- [x] 8.1 Return the exact token-free `omnicross.route-lease.capabilities/1` document with runtimes, upstream kinds, API version, `codexAuthMode: env_key`, and `maxTtlSeconds: 3600`; test authenticated loopback discovery and additive-version behavior.
- [x] 8.2 Document the Route Lease request/response/error/renew/recreate flow for Rasen consumers, including Admin-token use, mandatory loopback endpoint validation/warning, argv/env merge rules, heartbeat/cleanup responsibilities, and the prohibition on global CLI configuration changes.
- [x] 8.3 Add an opt-in real-daemon/local-mock `codex exec` E2E covering Responses streaming, a tool call, errors, cancellation, renewal, release, and explicit skip when the binary is unavailable.
- [x] 8.4 Add an opt-in real-daemon/local-mock `claude -p` E2E covering Messages streaming, a tool call, errors, cancellation, renewal, release, and explicit skip when the binary is unavailable.
- [x] 8.5 Snapshot hash/mtime/size for Codex config/auth and Claude settings/credentials before/after real CLI E2E; keep default CI mock-only/non-billable and document a separate explicitly invoked user-credential smoke.

## 9. Final verification

- [x] 9.1 Run the targeted core, CLI-launcher, daemon Admin, launch, concurrency, redaction, transformer, gateway, and E2E-mock tests and record/fix every failure attributable to the change.
- [x] 9.2 Run the full workspace typecheck, test suite, and build once after integration, verifying no generated credential/config changes, no leaked canary secrets, and no untracked implementation artifacts outside the intended change.
