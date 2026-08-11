# Rasen review-loop round 3 — independent review

- Change: `rasen-managed-route-lease`
- Date: 2026-08-11
- Overall verdict: **FAIL**
- M1 verdict: **OPEN**
- Shipping: **MUST NOT proceed**

The event-loop retention and one-shot socket defects identified in round 2 are corrected. The listener and accepted sockets are unref'ed, accepted sockets are tracked and destroyed by idempotent cleanup, and a synchronous claimed gate limits descriptor delivery to one peer. Cleanup is also connected to stop/reset/daemon shutdown for successful launches while preserving legacy void-returning opener compatibility.

M1 is nevertheless not fully resolved because the default macOS opener's asynchronous `error` path cleans only its IPC resources. It cannot notify the already-created Admin session to stop renewal and release its Route Lease. A failed `open` process can therefore leave route authority active after no terminal was launched. This is one of the required M1 failure paths and remains Major.

## M1 — Major — **OPEN**

### Corrected lifecycle behavior

Concrete evidence in `packages/daemon/src/admin/cliLaunch.ts`:

- `openTerminal()` unrefs every accepted socket immediately and tracks it in `sockets` until close (`:287-290`).
- The first connection synchronously flips `claimed` before any callback or write; later connections are destroyed without receiving bytes (`:297-305`). JavaScript cannot interleave another connection callback between the check and assignment.
- Cleanup sets `cleaned` before callbacks can re-enter it, clears the unref'ed timeout, destroys all tracked sockets, clears the set, closes the listener, and catches both server/filesystem cleanup failures (`:310-328`). Repeated cleanup remains non-throwing.
- The connection callback checks `cleaned` after the injectable claim callback and before `socket.end`; cleanup destroys tracked sockets, so cleanup cannot be followed by a descriptor write (`:301-307`). Late accepted callbacks see `cleaned` and destroy their socket (`:297-300`).
- The listen callback checks `cleaned` before its hook, chmod, and opener spawn, and checks it again after the hook (`:340-357`). A late callback after cleanup therefore cannot chmod or spawn. Synchronous chmod/spawn failures invoke cleanup.
- The opener child and listener are unref'ed after spawn (`:351-353`); the timeout is also unref'ed (`:358-359`). Before that callback, explicit cleanup closes the pending/listening server, and the callback's leading gate prevents later spawning.
- `TerminalOpener` now returns `void | TerminalCleanup`, preserving existing void-returning injected openers (`:188-197`). `defaultTerminalOpener` forwards the default cleanup exactly once (`:375`).
- `handleCliLaunch()` captures an optional cleanup and composes it into an idempotent session end before renewal stop/lease release (`:559-584`). Stop and reset invoke the same owned callback (`:396-405,467-476`); daemon shutdown registers reset with the provider proxy (`packages/daemon/src/bootstrap.ts:463-464`).
- Synchronous opener throws call `launch.onSessionEnd()` immediately, stopping renewal and releasing the new lease (`cliLaunch.ts:560-573`).

Focused tests provide meaningful evidence:

- Real child-process checks cover an unconsumed unref'ed listener and a claimed peer (`route-lease-terminal-lifecycle.test.ts:170-222`).
- A separate socket instrumentation test proves cleanup explicitly destroys the accepted socket exactly once (`:224-254`).
- Two racing real local clients prove exactly one receives descriptor bytes (`:256-283`).
- Repeated cleanup after a queued opener error and timeout cleanup are covered (`:285-317`).
- Stop/reset cleanup ownership and legacy void-returning opener compatibility are covered in `admin-cli-route-leases.test.ts:154-195`.

### Remaining Major failure: asynchronous opener error leaks route authority

**Reproduction:**

1. Launch Claude or Codex through `handleCliLaunch()` with a `RouteLeaseManager` and the default macOS opener.
2. Let `spawnProcess('open', ...)` return normally, so `openTerminal()` returns its cleanup and `handleCliLaunch()` publishes the session (`cliLaunch.ts:346-360,559-594`).
3. Have that opener child emit its asynchronous `error` event, as the existing lifecycle test does via `queueMicrotask` (`route-lease-terminal-lifecycle.test.ts:285-303`).
4. The registered listener is only `opener.once('error', cleanup)` (`cliLaunch.ts:351`). It removes IPC artifacts but has no path to the session's `onSessionEnd` closure.
5. The session remains listed, its renewal timer remains active, and `RouteLeaseManager.activeCount()` / proxy route count remain nonzero until manual stop/reset/shutdown or the hard renewal horizon. No terminal/CLI received the descriptor.

This violates the required condition that synchronous **and asynchronous** opener failures do not leak route authority or IPC resources. IPC cleanup succeeds, but route authority is orphaned after a failed launch. The current async-error test asserts only launch-directory removal and repeated cleanup; it does not exercise `handleCliLaunch()` or assert lease/renewal/session cleanup.

**Required resolution:** add a failure notification owned by the launch session (or an equivalent opener result contract) so an asynchronous default-opener failure invokes the composed session end exactly once. Add a deterministic Admin integration test that emits the opener error after `handleCliLaunch()` has returned and asserts the session, renewal, lease, route, and IPC resources are all gone.

## New findings

### N1 — Minor — Windows EPERM cleanup behavior is not directly exercised

The production cleanup catches `rmSync` failures, so no throwing implementation defect was found (`cliLaunch.ts:320-327`). However, neither reviewed focused test forces `rmSync` to throw `EPERM`; running with Windows named-pipe paths does not deterministically produce EPERM. Thus the specifically requested Windows EPERM test evidence is absent. Add an injectable filesystem cleanup seam or module-level mock that throws `{ code: 'EPERM' }`, then assert cleanup remains idempotent/non-throwing and no socket or route authority survives.

No other new findings survived review.

## S1 and prior-finding regression status

- **S1 — RESOLVED, no regression found.** Descriptor values remain absent from `open` argv, regular command/bootstrap files, opener environment, and global state. The descriptor is serialized only to the claimed private socket and merged only into the eventual CLI child environment (`cliLaunch.ts:208-236,276-305,330-352`). Darwin/Linux spawn-boundary and eventual-child tests remain present (`route-lease-terminal-lifecycle.test.ts:71-139`). The physical-macOS opt-in test remains skipped unless explicitly enabled; no physical-host run is claimed.
- **S2 — RESOLVED, no regression found.** The M1 delta does not alter RouteLeaseManager's shutdown/publication transaction.
- **P1 — RESOLVED, but the async opener failure exposes the M1 authority-cleanup gap above.** Normal stop/reset/shutdown still stops renewal and releases the lease.
- **P2 — RESOLVED, no regression found.** Subscription physical-model request/attribution paths are outside the M1 delta.
- **P3 — RESOLVED, no regression found.** Missing/blank model classification is outside the M1 delta.
- **P4 — RESOLVED, no regression found.** Exhaustion and bounded Retry-After behavior are outside the M1 delta.
- **P5 — RESOLVED, no regression found.** Create/renew no-store response policy is outside the M1 delta.
- **S3 — RESOLVED, no regression found.** The route-token authentication contract remains current.

## Exact checks run

### Executed

1. Read all three prior canonical reports:
   - `evidence/review-report.md`
   - `evidence/review-loop-round-1-report.md`
   - `evidence/review-loop-round-2-report.md`
2. Read and traced the current implementation and focused tests in:
   - `packages/daemon/src/admin/cliLaunch.ts`
   - `packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts`
   - `packages/daemon/src/__tests__/admin-cli-route-leases.test.ts`
   - `packages/daemon/src/commands/launch.ts`
   - `packages/daemon/src/bootstrap.ts`
   - `packages/core/src/provider-proxy/ProviderProxy.ts`
3. Ran:

```text
git status --short
git diff --stat
git diff --name-only
git diff -- packages/daemon/src/admin/cliLaunch.ts packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts packages/daemon/src/__tests__/admin-cli-route-leases.test.ts packages/daemon/src/bootstrap.ts
git diff --check
```

`git diff --check` passed with LF/CRLF advisories only; no whitespace error was reported.

4. Ran targeted repository searches for cleanup ownership, opener contracts, accepted/claimed socket handling, shutdown registration, async errors, and EPERM coverage.

### Attempted but not executed

The following commands were requested but did **not** execute because the harness required additional approval unavailable in this reviewer turn:

```text
npx vitest run packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts packages/daemon/src/__tests__/admin-cli-route-leases.test.ts packages/daemon/src/__tests__/admin-route-leases.test.ts
npm run typecheck -w @omnicross/daemon
```

No independent runtime or typecheck result is claimed. The lead-provided `22 passed, 1 skipped`, `111 passed, 1 skipped`, and daemon typecheck results are prior evidence only. The one skip is the explicit real-macOS opt-in eventual-child test; no physical macOS host run is claimed.

## Final disposition

- M1 independently confirmed resolved: **NO** — its event-loop/socket mechanics are fixed, but asynchronous opener failure still orphans route authority.
- S1/S2/P1/P2/P3/P4/P5/S3 remain resolved: **YES**, subject to the M1 failure-path qualification above.
- All Blocker findings independently resolved: **YES**.
- All Major findings independently resolved: **NO** — M1 remains open.
- Ship may proceed: **NO**. Resolve and independently test asynchronous opener-failure ownership before shipping. N1 should also receive the explicitly requested deterministic EPERM regression coverage.
