# Rasen review-loop round 3 — final independent review

- Change: `rasen-managed-route-lease`
- Date: 2026-08-11
- Overall verdict: **PASS**
- M1 verdict: **RESOLVED**
- N1 verdict: **RESOLVED**
- Shipping: **MAY proceed**

The final lifecycle fix closes the asynchronous macOS opener-failure ownership gap without reopening the descriptor secret boundary. The Admin launch owns a once-only session-end callback before invoking the opener; the default macOS opener reports genuine pre-claim failures through that callback, while descriptor claim permanently changes later opener errors/timeouts into IPC cleanup only. No new Blocker, Major, Minor, or other actionable finding survived this review.

## M1 — Major — **RESOLVED**

### Opener contract and failure classification

- `TerminalOpener` adds only an optional `onFailure?: () => void` input and continues to accept both `void` and cleanup-function returns (`packages/daemon/src/admin/cliLaunch.ts:188-198`). Existing injected openers may ignore the extra property and return `void`; the legacy-opener test confirms this (`packages/daemon/src/__tests__/admin-cli-route-leases.test.ts:157-166`).
- The callback has no arguments and the default implementation invokes it without logging or projecting descriptor data (`cliLaunch.ts:289-300`). The descriptor remains outside the notification contract, so the addition is secret-free.
- The macOS opener separates `failureNotified` from `cleaned`. `notifyFailure()` performs cleanup, flips the notification gate before invoking user code, and catches callback errors (`cliLaunch.ts:285-300`). Repeated server/opener/timeout signals therefore notify at most once.
- Before descriptor claim, server error, synchronous `spawnProcess('open', ...)` throw, opener `error`, and unclaimed timeout all reach `handleLaunchFailure()` and notify (`cliLaunch.ts:297-300,358-378`).
- The connection callback sets `claimed = true` synchronously before the claim hook and before descriptor transfer (`cliLaunch.ts:312-320`). After that point, opener error or timeout calls cleanup only and cannot falsely report launch failure (`cliLaunch.ts:297-300`). Normal `socket.end(..., cleanup)` likewise performs cleanup without notification.

### Admin ownership and callback ordering

- `handleCliLaunch()` constructs the once-only `onSessionEnd` closure, including its `ended` and `published` state, before invoking the opener (`cliLaunch.ts:576-600`). There is no uninitialized-closure callback window.
- A re-entrant pre-publication callback sets `ended`, stops opener IPC when a handle becomes available, stops renewal, releases the lease/route, returns HTTP 500, and never inserts a session (`cliLaunch.ts:581-609`). The deterministic test asserts status 500, one opener cleanup, zero lease/route, and an empty session list (`admin-cli-route-leases.test.ts:168-177`).
- An asynchronous post-publication callback sees `published`, deletes the session, invokes opener cleanup, stops renewal, and releases lease/route through the same once-only owner (`cliLaunch.ts:581-590,611-622`). The integration test invokes failure twice, advances through a renewal interval, and confirms no renewal, empty session map, zero active lease/route, one cleanup, and a subsequent 404 stop (`admin-cli-route-leases.test.ts:179-203`).
- Manual stop, reset, provider-proxy shutdown, and repeated failure all converge on the same `ended` gate. The stop-vs-late-failure test and shutdown test confirm one teardown and no authority/session residue (`admin-cli-route-leases.test.ts:205-216,250-260`). Shutdown registration runs `resetCliSessions()` before `RouteLeaseManager.shutdown()` because hooks execute in reverse registration order; both paths are idempotent (`packages/daemon/src/bootstrap.ts:463-464`).
- There is no publication-after-failure window: JavaScript cannot interleave asynchronous callbacks between the synchronous `ended` check, `sessions.set`, `published = true`, and final defensive delete (`cliLaunch.ts:606-622`). A synchronous/re-entrant failure has already set `ended` and exits before publication; a later callback sees `published` and removes the entry. No reviewed ordering leaves a stale map entry.

### IPC and process-lifecycle properties

- Listener, timeout, opener child, and accepted sockets are unref'ed (`cliLaunch.ts:303,371-378`). Accepted sockets are tracked and destroyed by idempotent cleanup (`cliLaunch.ts:301-305,325-346`).
- Claim is strict one-shot: the first eligible callback sets `claimed` before hooks/write, while every later or cleaned connection is destroyed (`cliLaunch.ts:312-323`). Cleanup after a re-entrant claim hook prevents descriptor write.
- Cleanup marks resource teardown complete before closing sockets/listener, catches close/removal failures, and remains non-throwing (`cliLaunch.ts:325-347`). Re-entry cannot repeat socket/listener teardown.
- Child-process and real-socket tests cover unconsumed listener exit, non-closing accepted peer exit/destruction, and exactly one of two racing peers receiving descriptor bytes (`route-lease-terminal-lifecycle.test.ts:170-283`).

## N1 — Minor — **RESOLVED**

- Artifact deletion is injectable through `MacTerminalIpcOptions.removeArtifacts` (`cliLaunch.ts:242-249,335-346`).
- The deterministic test injects an error with `code: 'EPERM'`, establishes an accepted socket, invokes cleanup repeatedly, and asserts non-throwing behavior plus exactly one accepted-socket destruction (`route-lease-terminal-lifecycle.test.ts:313-352`). This directly supplies the previously missing EPERM evidence.
- Resource teardown is one-shot under `cleaned`; artifact removal is intentionally attempted on each caller invocation. The production removal call itself is bounded to `maxRetries: 3` with a 20 ms delay (`cliLaunch.ts:339-344`). The test explicitly verifies subsequent caller invocations trigger subsequent artifact-removal attempts rather than an accidental internal loop. Timeout/session/manual cleanup are finite invocation sources; no self-scheduling removal loop exists.

## S1/S2/P1/P2/P3/P4/P5/S3 regression verdicts

- **S1 — RESOLVED; no regression.** Descriptor values are absent from macOS `open` argv, command/bootstrap files, opener environment, and notification payload. They are serialized only after the private socket's one-shot claim and merged into only the eventual CLI child environment (`cliLaunch.ts:205-237,278-320,349-370`). Darwin/Linux argv checks and the eventual-child IPC test remain present (`route-lease-terminal-lifecycle.test.ts:71-139`). The real-macOS test is correctly opt-in and remains the sole skip; no physical macOS run is claimed.
- **S2 — RESOLVED; no regression.** Route-lease creation still rechecks shutdown after awaited resolution, after route/descriptor construction, before publication, and after the publication seam, with rollback of maps, timer, and route on every losing path (`packages/core/src/provider-proxy/RouteLeaseManager.ts:188-268`).
- **P1 — RESOLVED; no regression.** Built-in terminal leases renew every five minutes, stop on session end/renewal failure, and retain the 24-hour hard bound (`packages/daemon/src/routeLeaseRenewal.ts:3-25`). The final M1 fix now applies that stop path to asynchronous opener failure as well.
- **P2 — RESOLVED; no regression.** Codex Responses account remapping rewrites the request and actual-model attribution (`packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts:571-590,623-650`). Anthropic same-format remapping uses the outbound model for body, headers, activity, returned actual model, and usage attribution (`packages/core/src/provider-proxy/ingress/anthropicSubscriptionPlan.ts:475-574`; `packages/core/src/provider-proxy/ingress/anthropicMessagesByo.ts:141-149`).
- **P3 — RESOLVED; no regression.** Missing/non-string/trim-blank model values retain `model_not_configured`; malformed nonblank values retain generic validation (`packages/core/src/provider-proxy/routeLeaseSchema.ts:293-313`).
- **P4 — RESOLVED; no regression.** Exhausted non-empty provider pools retain `upstream_exhausted`, HTTP 429, and bounded `Retry-After`; unavailable pools remain distinct (`packages/core/src/provider-proxy/RouteLeaseTargetResolver.ts:133-148`; `packages/core/src/provider-proxy/routeLeaseSchema.ts:141-179`; `packages/daemon/src/admin/routeLeaseApi.ts:52-57`).
- **P5 — RESOLVED; no regression.** Create/renew endpoint policy determines `no-store` before parsing or manager work and applies it on success and errors (`packages/daemon/src/admin/routeLeaseApi.ts:67-112`).
- **S3 — RESOLVED; no regression.** The Codex builder documents and emits the dedicated `OMNICROSS_CODEX_ROUTE_TOKEN` `env_key`; the removed `OPENAI_API_KEY` authentication contract has not returned (`packages/cli-launcher/src/proxy-env/codex-proxy-env.ts:18-23,108-138`).

## New findings

**None.** No new finding with a reproducible implementation defect survived source, ordering, cleanup, and regression review.

## Exact checks run

### Executed by this reviewer

1. Read all canonical reports through round 3:
   - `rasen/changes/rasen-managed-route-lease/evidence/review-report.md`
   - `rasen/changes/rasen-managed-route-lease/evidence/review-loop-round-1-report.md`
   - `rasen/changes/rasen-managed-route-lease/evidence/review-loop-round-2-report.md`
   - `rasen/changes/rasen-managed-route-lease/evidence/review-loop-round-3-report.md`
2. Read and traced the current lifecycle implementation/tests in:
   - `packages/daemon/src/admin/cliLaunch.ts`
   - `packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts`
   - `packages/daemon/src/__tests__/admin-cli-route-leases.test.ts`
   - `packages/daemon/src/routeLeaseRenewal.ts`
   - `packages/daemon/src/bootstrap.ts`
3. Re-inspected regression implementation paths in `RouteLeaseManager.ts`, `RouteLeaseTargetResolver.ts`, `routeLeaseSchema.ts`, `routeLeaseApi.ts`, the Responses/Anthropic ingress files, and the Codex proxy-env builder.
4. Ran targeted repository searches for `TerminalOpener`, `onFailure`, claim handling, EPERM coverage, stop/reset/shutdown ownership, and prior finding identifiers.
5. Ran:

```text
git diff --check
git diff --stat
git status --short
git diff -- packages/daemon/src/admin/cliLaunch.ts packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts packages/daemon/src/__tests__/admin-cli-route-leases.test.ts packages/daemon/src/bootstrap.ts
```

`git diff --check` passed with LF/CRLF advisories only; no whitespace error was reported.

### Requested but not executed

The following read-only commands were requested, but the harness required additional approval unavailable in this reviewer turn:

```text
npx vitest run packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts packages/daemon/src/__tests__/admin-cli-route-leases.test.ts packages/daemon/src/__tests__/admin-route-leases.test.ts
npm run typecheck -w @omnicross/cli-launcher
npm run typecheck -w @omnicross/core
npm run typecheck -w @omnicross/daemon
```

No independent runtime or typecheck result is claimed. The lead-provided results — narrow 3-file suite **26 passed, 1 skipped**; focused 11-file suite **115 passed, 1 skipped**; cli-launcher/core/daemon workspace typechecks passed — are accepted as lead evidence, not represented as this reviewer's execution. The only skip is the explicit real-macOS opt-in eventual-child test; a physical macOS run is not claimed.

## Final disposition

- M1 independently resolved: **YES**.
- N1 independently resolved: **YES**.
- S1/S2/P1/P2/P3/P4/P5/S3 remain resolved: **YES**.
- Every Blocker and Major finding is independently resolved: **YES**.
- Ship may proceed: **YES**.

The absence of a physical-macOS opt-in run is an explicitly disclosed platform-evidence gap, not an open implementation finding or shipping blocker for this review.
