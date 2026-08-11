# Rasen review-loop round 1 — independent review

- Change: `rasen-managed-route-lease`
- Date: 2026-08-11
- Overall verdict: **FAIL**
- Shipping: **MUST NOT proceed**

Seven of the eight original findings are resolved. S1 remains open at Blocker severity: the revised macOS opener removes the token from argv and from the temporary command file, but supplies it only as the environment of `/usr/bin/open`. A process launched through macOS Launch Services is not guaranteed to inherit the invoking `open` process environment; the implementation does not use an environment-transfer mechanism such as `open --env`, nor does the command file establish the environment without exposing the secret. Consequently the real Terminal/CLI child may start without `OMNICROSS_CODEX_ROUTE_TOKEN` / Claude route variables. The unit seam proves only the environment passed to `open`, not the environment received by Terminal or the CLI.

## Original finding verdicts

### S1 — Blocker — **OPEN**

Evidence:

- `packages/daemon/src/admin/cliLaunch.ts:212-243` builds `childEnv`, creates a mode-0700 `.command` file containing only command/cwd data, then invokes `open -n -a Terminal <file>` with `env: childEnv`.
- `packages/daemon/src/admin/cliLaunch.ts:226-251` keeps environment values out of the Linux and macOS argv. The Linux `x-terminal-emulator` path starts directly beneath the spawned process and can inherit `childEnv` normally.
- `packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts:20-42` asserts that the canary is absent from the immediate spawn argv and present in the immediate spawn options. It does not launch macOS Terminal or inspect the eventual CLI environment.

Behavioral reasoning:

- The original argv disclosure is fixed: neither POSIX spawn argv contains the token, and the macOS temporary file contains no token.
- Temporary-file exposure is limited: `mkdtempSync` creates a private directory, the file is mode 0700, and it deletes itself before executing the CLI (`cliLaunch.ts:232-238`). However, if `open` successfully returns but Terminal never executes the file, the non-secret script/directory can remain; this is cleanup debris rather than a secret leak.
- The security/functional contract requires the secret to reach only the actual agent child environment. On macOS the parent of the new Terminal application is Launch Services/launchd rather than the `open` process in the ordinary direct-child sense. Passing `env` to the `open` process alone is not sufficient proof that Terminal, its shell, or the CLI receives those variables. The current test mocks `spawn` and therefore cannot validate this boundary.
- This is a practical launch failure, not merely a missing test: a Codex launch can receive argv selecting `env_key="OMNICROSS_CODEX_ROUTE_TOKEN"` while the named variable is absent from its environment, causing authentication failure. Claude can similarly miss its proxy/auth/model environment.

Required resolution: use a macOS mechanism that explicitly transfers the descriptor environment to the launched application/command without putting values in argv or a readable temporary file, and add a macOS integration reproduction that observes the eventual command environment (with a canary) rather than only the immediate `open` spawn options. Cleanup should also remove an unconsumed command file on opener failure where feasible.

### S2 — Major — **RESOLVED**

Evidence:

- `packages/core/src/provider-proxy/RouteLeaseManager.ts:188-190` rechecks manager state immediately after awaited target resolution.
- `packages/core/src/provider-proxy/RouteLeaseManager.ts:208-218` registers the route/builds the descriptor within a rollback-protected transaction and checks state again.
- `packages/core/src/provider-proxy/RouteLeaseManager.ts:236-265` installs the timer, publishes both maps, checks for closure after the optional publication seam, and removes records/timer/route on every losing path.
- `packages/core/src/provider-proxy/RouteLeaseManager.ts:325-335` sets `closed` before draining active leases.
- `packages/core/src/provider-proxy/__tests__/RouteLeaseManager.test.ts:120-147` deterministically holds the resolver, calls shutdown, releases the resolver, expects `daemon_not_ready`, and asserts zero active leases/routes.

Behavioral reasoning: before route registration, shutdown can only win at an `assertOpen`; after synchronous registration, all subsequent throws enter rollback. JavaScript cannot interleave ordinary shutdown calls between adjacent synchronous operations. Re-entrant/test-seam shutdown after publication is detected at `:254-257`, finalized, and then rolled back idempotently. No reviewed interleaving can publish durable authority after shutdown.

### P1 — Major — **RESOLVED**

Evidence:

- `packages/daemon/src/routeLeaseRenewal.ts:3-25` renews a 600-second lease every five minutes, stops on renewal failure/explicit cleanup, unrefs its timer, and enforces a 24-hour hard renewal bound.
- `packages/daemon/src/admin/cliLaunch.ts:409-427` starts renewal for Admin Claude/Codex terminal leases and stops renewal before release.
- `packages/daemon/src/commands/launch.ts:243-264` does the same for foreground `omnicross launch`, with cleanup in its existing `finally` path at `:228-233`.
- `packages/daemon/src/admin/cliLaunch.ts:274-283` runs each tracked session cleanup on reset; `packages/daemon/src/bootstrap.ts:464` registers that reset before provider-proxy stop.
- `packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts:47-67` advances fake time beyond 600 seconds, observes renewal, verifies explicit cleanup stops renewal, and verifies the hard bound.

Behavioral reasoning: healthy sessions remain routed past ten minutes; both launch owners stop their renewal timers and release their lease on their observable lifecycle end. Detached terminal exits remain intrinsically unobservable, but renewal authority is bounded to 24 hours and the final 600-second lease TTL bounds the orphan after renewal stops. Timers are unref'ed and renewal failure self-cleans the timer.

### P2 — Major — **RESOLVED**

Evidence:

- `packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts:571-590` captures the account-selected remapped model, writes it to the outbound Responses body, and updates transformer provider models.
- `packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts:623-650` uses that actual model for activity and returns it for usage attribution; the top-level attribution selects `providerResponse.actualModel` at `:257-261`.
- `packages/core/src/provider-proxy/ingress/anthropicSubscriptionPlan.ts:475-574` captures account remapping, rewrites the same-format body where applicable, uses the outbound model for beta headers/activity, and returns `actualModel`.
- `packages/core/src/provider-proxy/ingress/anthropicMessagesByo.ts:141-149` attributes usage to `actualModel` with a resolved-model fallback.
- `packages/core/src/provider-proxy/__tests__/ProviderProxy.openaiResponsesSubscription.test.ts:230-292` asserts the Codex physical model in both upstream body and usage record.
- `packages/core/src/provider-proxy/__tests__/ProviderProxy.anthropicSubscription.test.ts:343-368` asserts the Anthropic physical model in both upstream body and usage record.

Behavioral reasoning: both requested subscription paths now couple account selection's physical model to the exact outbound request and to usage/activity attribution. The mutation is request-local (`responsesBody`, per-call transformer provider, or per-call Anthropic body/result), so no shared route model is rewritten.

### P3 — Major — **RESOLVED**

Evidence:

- `packages/core/src/provider-proxy/routeLeaseSchema.ts:308-311` classifies non-string/missing/trim-blank models as `model_not_configured` before generic normalized-string validation.
- `packages/daemon/src/__tests__/admin-route-leases.test.ts:352-354,363-370` checks missing and blank models use `model_not_configured`, while an overlong nonblank model remains `invalid_request`.

Behavioral reasoning: absence/blankness now has the stable domain code, while malformed nonblank data continues through bounded/control-safe generic validation.

### P4 — Major — **RESOLVED**

Evidence:

- `packages/core/src/completion/ApiKeyPoolService.ts:299-317` distinguishes empty/unavailable pools from a non-empty all-cooling pool and calculates the earliest safe delay, clamped to 1..3600 seconds.
- `packages/core/src/provider-proxy/RouteLeaseTargetResolver.ts:133-148` maps exhausted provider pools to `upstream_exhausted` and carries only `retryAfterSeconds`; empty/disabled/no-credential conditions remain `upstream_unavailable`.
- `packages/core/src/provider-proxy/routeLeaseSchema.ts:152,156-179` maps exhaustion to HTTP 429/retryable and clamps the delay again before exposure.
- `packages/daemon/src/admin/routeLeaseApi.ts:52-57` emits only the typed bounded delay in `Retry-After` and serializes the safe error projection.
- `packages/core/src/provider-proxy/__tests__/RouteLeaseTargetResolver.test.ts:155-170` verifies typed exhaustion and delay preservation.
- `packages/daemon/src/__tests__/admin-route-leases.test.ts:389-423` verifies HTTP 429, a 3600-second clamp, and absence of an unsafe cause string.

Behavioral reasoning: a non-empty cooling pool no longer collapses into generic unavailability. Retry delay is integer, positive, doubly bounded, and derived from cooldown timestamps without key ids or credentials in the body/header.

### P5 — Minor — **RESOLVED**

Evidence:

- `packages/daemon/src/admin/routeLeaseApi.ts:67-71` determines no-store from the create/renew endpoint before parsing, manager lookup, or domain execution.
- `packages/daemon/src/admin/routeLeaseApi.ts:88-90,100-107` sets it on success, while the catch path passes the same endpoint policy to `writeError` at `:110-112`.
- `packages/daemon/src/__tests__/admin-route-leases.test.ts:319-333` asserts no-store on expired-renew and malformed-create errors; `:443-449` asserts it on create readiness failure.

Behavioral reasoning: all create/renew successes, parse failures, and domain failures pass through a no-store response path. Other endpoints are unaffected.

### S3 — Trivial — **RESOLVED**

Evidence:

- Search of `packages/cli-launcher/src/proxy-env/codex-proxy-env.ts` finds no stale `requires_openai_auth` or `OPENAI_API_KEY` comments/contracts.
- The only remaining occurrences under the proxy-env tests are negative assertions in `codex-proxy-env.test.ts:87,132`, which accurately enforce absence; unrelated CLI adapters legitimately still use `OPENAI_API_KEY`.

Behavioral reasoning: maintainers are no longer told that Codex Route Lease authentication depends on the removed contract; negative regression assertions remain appropriate.

## New findings

No separate new findings survived review. The macOS environment-transfer failure is the still-open S1 contract defect, not a duplicate new finding.

## Regression review

- **Security boundary:** argv and the temporary script are token-free, but the macOS eventual-child environment boundary remains unproven/broken as described in S1. Error and retry projections remain whitelist-based.
- **Process lifecycle and timers:** renewal timers are stopped by owned cleanup, stop after errors, are unref'ed, and have a finite renewal horizon. Manager lifecycle rollback remains idempotent.
- **Transformer/model mutation:** reviewed remap changes are scoped to per-request bodies/plans and return the actual model for attribution; no global route/model mutation was found.
- **Retry semantics:** cooling-pool delays are based on the earliest cooldown, rounded up, and clamped 1..3600; no key material is exposed.
- **Type safety:** no new cast/workaround was found that conceals a demonstrated runtime defect in the reviewed fixes. Test-only casts model narrow seams; production paths retain typed optional capabilities.

## Checks run

### Source/test inspection

Read the authoritative handoff, prior review, requirements baseline, design, spec, and the implementation/test paths cited above. Independently traced each original finding through production behavior and its focused regression tests. Searched for stale authentication-contract text and for all renewal owners/cleanup registrations.

### Attempted runtime check

Attempted this focused command:

```text
npx vitest run packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts packages/core/src/provider-proxy/__tests__/RouteLeaseManager.test.ts packages/core/src/provider-proxy/__tests__/routeLeaseSchema.test.ts packages/core/src/provider-proxy/__tests__/RouteLeaseTargetResolver.test.ts packages/core/src/provider-proxy/__tests__/ProviderProxy.openaiResponsesSubscription.test.ts packages/core/src/provider-proxy/__tests__/ProviderProxy.anthropicSubscription.test.ts packages/daemon/src/__tests__/admin-route-leases.test.ts packages/daemon/src/__tests__/admin-cli-route-leases.test.ts packages/daemon/src/__tests__/launch-cli.test.ts
```

Result: **not executed** because the harness required additional command approval that was not available in this reviewer turn. No runtime result is claimed. The lead-provided 11-file/103-test and three workspace typecheck results were treated as prior evidence only, not as this reviewer's independent execution.

A web lookup for macOS `open` environment inheritance was also attempted but permission was not granted. The S1 verdict therefore rests on the process-boundary semantics visible in the code and the absence of an explicit Launch Services environment-transfer mechanism or eventual-child integration proof.

## Final disposition

- All Blocker/Major findings independently confirmed resolved: **NO** — S1 remains open.
- Resolved: **S2, P1, P2, P3, P4, P5, S3**.
- Open: **S1 (Blocker)**.
- Shipping may proceed: **NO**. Resolve and independently validate the real macOS Terminal/CLI environment transfer without exposing secrets in argv or temporary-file contents, then rerun the focused lifecycle test slice and a real macOS eventual-child reproduction.
