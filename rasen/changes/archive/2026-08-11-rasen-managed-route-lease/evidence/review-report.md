# Independent Code Review: Rasen-managed Route Lease

- Change: `rasen-managed-route-lease`
- Mode: dispatched, report-only
- Date: 2026-08-11
- Verdict: **FAIL — 1 Blocker, 5 Major, 1 Minor, 1 Trivial**
- Scope: the Route Lease implementation, its Admin API and launch consumers, the originating change artifacts, and the requirements baseline at `docs/design/rasen-managed-route-lease-requirements.md`

The focused test gate is green, but it does not exercise several lifecycle, process-boundary, remapping, and error-contract paths. The Blocker and all Major findings must be resolved and independently re-reviewed before shipping.

## Standards

### S1 — [Blocker] POSIX terminal launch exposes the lease token in process argv

Evidence:

- `packages/daemon/src/admin/cliLaunch.ts:220-224` serializes every entry in the launch environment into an `export ...` shell script.
- `packages/daemon/src/admin/cliLaunch.ts:226-232` passes that script as an `osascript -e` or `bash -lc` argument.
- `packages/daemon/src/admin/cliLaunch.ts:390-403` supplies the token-bearing Route Lease descriptor environment to this path for Claude and Codex.

The token is therefore observable through the process list on macOS and Linux. This breaks the implementation's secret boundary and the baseline rule at `docs/design/rasen-managed-route-lease-requirements.md:528`: secrets may enter only the child environment, never argv. It also contradicts `design.md:89-106` and `spec.md:109`, which make argv safety a core descriptor guarantee.

Required resolution: preserve the token exclusively in the launched child's environment across the default POSIX terminal openers; do not embed the environment in a shell command passed through argv. Add a regression test that inspects the real spawn arguments for both macOS and Linux opener paths and proves the canary token is absent.

### S2 — [Major] Shutdown can race an in-flight create and publish a live lease afterward

Evidence:

- `packages/core/src/provider-proxy/RouteLeaseManager.ts:140-141` checks `closed` only before asynchronous target resolution.
- `packages/core/src/provider-proxy/RouteLeaseManager.ts:189` awaits the resolver without rechecking shutdown state.
- `packages/core/src/provider-proxy/RouteLeaseManager.ts:247-250` can then publish the route and active lease after `shutdown()` has already drained the registry.
- `packages/core/src/provider-proxy/RouteLeaseManager.ts:318-327` only finalizes leases that are active at the instant shutdown begins.

A controlled pending-resolver reproduction produced:

```json
{"created":true,"activeCount":1,"routeCount":1,"status":"active"}
```

That leaves authority live after shutdown and violates the manager's lifecycle invariant. The change design explicitly requires deterministic shutdown and fake-clock race coverage (`design.md:13`, `design.md:45`; `tasks.md:34-36`).

Required resolution: make shutdown and publication mutually exclusive, recheck state after awaited preflight, and roll back any route created during the losing race. Add a deterministic pending-resolver shutdown test.

### S3 — [Trivial] Codex builder comments still document the removed authentication contract

`packages/cli-launcher/src/proxy-env/codex-proxy-env.ts:11-23` and `:94-106`, plus comments in `packages/cli-launcher/src/proxy-env/__tests__/codex-proxy-env.test.ts`, still describe `requires_openai_auth=true` and `OPENAI_API_KEY` even though the implementation correctly moved to `OMNICROSS_CODEX_ROUTE_TOKEN`. These comments now mislead future maintainers and directly contradict `design.md:104` and `spec.md:116`.

Standards axis result: **FAIL — 1 Blocker, 1 Major, 1 Trivial. Worst: S1, secret exposure through process argv.**

## Spec

### P1 — [Major] Built-in Claude/Codex terminal sessions lose routing after the default 600-second TTL

`packages/daemon/src/admin/cliLaunch.ts:390-403` and `packages/daemon/src/commands/launch.ts:242-256` create internal leases without a non-default TTL or any renewal loop. The schema default is 600 seconds (`packages/core/src/provider-proxy/routeLeaseSchema.ts:10`), and Route Lease expiry is absolute rather than activity-extended. Both consumers only release on session end.

Any terminal session lasting more than ten minutes will therefore retain a running CLI but lose its proxy authority. This regresses the previous activity-touched terminal-route behavior and conflicts with the compatibility promise in `tasks.md:51` and the documented lifecycle responsibility in `design.md:41-47,156`.

Required resolution: give these internal terminal consumers a lifecycle-appropriate renewal mechanism (or another explicitly designed compatible lifetime) and cover a session that remains usable beyond 600 seconds without allowing an unbounded orphaned lease.

### P2 — [Major] Subscription account model remapping is not consistently applied or attributed

There are two manifestations of one contract failure:

- `packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts:575-585` receives account selection through `reportSelection`, but its callback accepts only `accountId` and discards the reported remapped model. A Codex subscription lease can consequently continue with the logical model instead of the account's actual upstream model.
- `packages/core/src/provider-proxy/ingress/anthropicSubscriptionPlan.ts:489-543` does apply an account remap to the outbound Anthropic body, but `packages/core/src/provider-proxy/ingress/anthropicMessagesByo.ts:141-146` attributes usage to `plan.resolvedModel`, not the later `outboundModel` actually sent.

This violates `spec.md:83-93`: the lease must freeze the actual upstream model and usage/cost attribution must record that actual identity.

Required resolution: carry the selected remapped model through request construction and usage attribution on both ingress paths. Add subscription tests that use a logical-to-physical model mapping and assert both the exact outbound body model and the usage record model.

### P3 — [Major] A blank model returns `invalid_request` instead of `model_not_configured`

`packages/core/src/provider-proxy/routeLeaseSchema.ts:302-309` sends `model` through the generic normalized-string validator. For an empty model, the observed response is:

```json
{"code":"invalid_request","status":400,"message":"model is invalid"}
```

The required stable contract is `model_not_configured` (`spec.md:70-76`; baseline error table at `docs/design/rasen-managed-route-lease-requirements.md:504`). Stable error codes are part of the consumer protocol, not merely message wording.

Required resolution: classify missing/blank model separately from malformed general fields and add API/schema assertions for the documented code.

### P4 — [Major] An exhausted provider key pool is mapped to `upstream_unavailable` instead of HTTP 429 `upstream_exhausted`

`packages/core/src/provider-proxy/RouteLeaseTargetResolver.ts:126-132` reduces the implicit provider-key-pool decision to `hasUsableKeys()`. If all configured keys are cooling down or quota-exhausted, it throws `upstream_unavailable` and loses the exhaustion reason and retry horizon.

`tasks.md:17,44`, `spec.md:209-221`, and the baseline at `docs/design/rasen-managed-route-lease-requirements.md:512` require `upstream_exhausted`, HTTP 429, and a safe bounded `Retry-After` for this condition.

Required resolution: preserve the pool's exhausted/cooldown outcome and safe retry delay through target resolution and the Admin API. Add a test with a non-empty pool whose every key is cooling down.

### P5 — [Minor] Create/renew error responses do not consistently set `Cache-Control: no-store`

`packages/daemon/src/admin/routeLeaseApi.ts:52-58` adds `no-store` to error responses only for `daemon_not_ready`; successful create and renew set it explicitly at `:85-86` and `:97-104`. The current expired-renew test even asserts the header is absent at `packages/daemon/src/__tests__/admin-route-leases.test.ts:319-321`.

The design states that create and renew always set `Cache-Control: no-store` (`design.md:129`; `spec.md:138-154`; `tasks.md:43`). Error bodies are also responses to those operations and may carry lifecycle metadata suitable for caching avoidance.

Required resolution: make the response policy endpoint-aware so every create/renew response, including parsing and domain errors, receives `no-store`; update the contrary test assertion.

Spec axis result: **FAIL — 4 Major, 1 Minor. Worst: P1-P4 (equal Major severity).**

## Focused test gate

Command:

```text
npx vitest run packages/cli-launcher/src/proxy-env/__tests__/codex-proxy-env.test.ts packages/core/src/completion/__tests__/ApiKeyPoolService.routeLease.test.ts packages/core/src/provider-proxy/__tests__/providerProxyRouteMap.test.ts packages/core/src/provider-proxy/__tests__/RouteLeaseManager.test.ts packages/core/src/provider-proxy/__tests__/routeLeaseSchema.test.ts packages/core/src/provider-proxy/__tests__/RouteLeaseTargetResolver.test.ts packages/core/src/provider-proxy/__tests__/usageTapAttribution.test.ts packages/core/src/usage/__tests__/usage-recorder.test.ts packages/daemon/src/__tests__/admin-cli-route-leases.test.ts packages/daemon/src/__tests__/admin-route-leases.test.ts packages/daemon/src/__tests__/launch-cli.test.ts packages/daemon/src/__tests__/route-lease-real-cli.e2e.test.ts packages/daemon/src/__tests__/route-lease-subscription-preflight.test.ts
```

Result:

```text
Test Files  12 passed | 1 skipped (13)
Tests       107 passed | 2 skipped (109)
treeFingerprint: 73ca5858c06ae7c06ec3bb6aca6ec39c38d0d1a8
```

`git diff --check` also passed before this report was written. The green gate does not override the uncovered behavior below.

## Test coverage diagram

```text
Route Lease create
|-- request/schema normalization
|   |-- ordinary valid/invalid fields ................ covered
|   `-- blank model -> model_not_configured ........... GAP [P3]
|-- target resolution
|   |-- explicit not-found/unavailable key ............ covered
|   `-- non-empty pool with all keys cooling down ..... GAP [P4]
|-- async preflight and publication
|   |-- ordinary rollback/lifecycle paths ............. covered
|   `-- shutdown while resolver is pending ............ GAP [S2]
`-- Admin response policy
    |-- successful create/renew no-store ............... covered
    `-- create/renew error no-store .................... GAP [P5]

Runtime launch
|-- descriptor env and discrete extraArgs ............. covered
|-- default macOS/Linux terminal opener argv .......... GAP [S1]
|-- session release cleanup ............................ covered
`-- active terminal session beyond 600 seconds ........ GAP [P1]

Leased proxy request
|-- ordinary provider/model routing ................... covered
|-- Codex subscription account model remap ............ GAP [P2]
|-- Anthropic remapped-model usage attribution ........ GAP [P2]
`-- real default Claude/Codex executable lifecycle .... SKIPPED (opt-in)
```

All coverage gaps shown above are already attached to canonical findings; no duplicate gap-only findings are added.

## Review disposition

- No code was changed by this report-only reviewer.
- Shipping is blocked by S1.
- S2 and P1-P4 require fixes or an explicit design-level escalation; they must not be silently accepted.
- P5 should be corrected in the same fix cycle.
- S3 may be handled as a trivial cleanup, but its resolution still needs non-author confirmation if changed alongside the functional fixes.
