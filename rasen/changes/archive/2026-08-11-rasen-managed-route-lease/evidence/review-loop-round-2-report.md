# Rasen review-loop round 2 — independent review

- Change: `rasen-managed-route-lease`
- Date: 2026-08-11
- Overall verdict: **FAIL**
- S1 verdict: **RESOLVED**
- Shipping: **MUST NOT proceed** because one new Major lifecycle finding remains

Round 2 resolves the original S1 Blocker. The macOS path no longer depends on Launch Services propagating `/usr/bin/open`'s environment: a static, secret-free bootstrap receives the descriptor from a private Unix-domain socket and places it only in the eventual CLI child's environment. The descriptor is absent from the argv and regular-file contents reviewed, while `open` receives an environment with every descriptor key removed.

A new Major lifecycle defect prevents an overall PASS: the production opener discards the cleanup handle, and the listening server/accepted sockets remain referenced. An unconsumed launch can therefore delay daemon exit for up to 120 seconds; an accepted peer that does not complete its side of the connection can keep the daemon alive beyond that timeout because cleanup closes only the listener, not accepted sockets. This violates the explicit round-2 requirement that the IPC server cannot hang the daemon.

## S1 — Blocker — **RESOLVED**

### Secret location and transfer

Concrete evidence in `packages/daemon/src/admin/cliLaunch.ts`:

- `openTerminal()` constructs the macOS command file from the executable, cwd, socket path, launch directory, command, and discrete CLI args; it does not serialize `env` into the file (`:268-299`).
- The route descriptor is serialized only when a socket has connected (`:280-283`). No descriptor payload is supplied to `open`, Terminal, the command file, the bootstrap's argv, helper argv, or final CLI argv.
- Before spawning `open`, the code clones `process.env` and deletes every key present in the descriptor (`:276-277`). The resulting sanitized `openerEnv` is supplied to `open` at `:307-311`.
- The private directory is created with `mkdtempSync()` (`:272`), whose POSIX directory mode is 0700. The socket is placed inside that directory by default (`:275`) and is explicitly changed to mode 0600 before `open` is spawned (`:304-307`). Other local users cannot traverse the directory or connect to/read the socket authority.
- The bootstrap connects to the socket, accumulates UTF-8 data, parses JSON, verifies that the top-level value is a non-array object whose values are all strings, and merges it into the final child's environment (`:211-225`). JSON encoding avoids shell interpretation and preserves quotes, whitespace, newlines, backslashes, and Unicode accepted by Node environment strings. Descriptor contents are never evaluated as code.
- The bootstrap source is static. Every command-file field is POSIX-single-quoted through `shq()` (`:197-200,296`), so cwd, paths, command, and argv entries cannot terminate quoting or inject shell syntax. Descriptor values never enter that shell text at all.
- The socket path and launch directory used by production are generated internally under the private temporary directory; descriptor content cannot redirect either. The injectable `macIpc.socketPath` is a test seam, not request-controlled production input.
- The server does not write before connection: `socket.end(JSON.stringify(env))` occurs only in the connection callback (`:280-283`). The normal consumer receives one complete JSON document and the bootstrap spawns exactly `command` with the original discrete `args`, preserving cwd and argv semantics (`:217-230`). It merges the descriptor over the Terminal/bootstrap ambient environment, preserving non-conflicting ambient variables.
- The visible-window behavior remains `open -n -a Terminal <launch.command>` (`:307`), and the command file `exec`s the bootstrap, which in turn runs the requested CLI with inherited stdio. This preserves a new visible Terminal window, cwd, command, discrete argv, and terminal I/O behavior.
- Linux remains functionally on the prior direct `x-terminal-emulator -e bash -lc` path. Its script contains only quoted cwd/command/args, while the descriptor travels in the spawned process environment (`:326-331`); the token is absent from argv.

### Same-user boundary

A same-UID process that learns the private socket path could race the bootstrap and connect first. The 0700 directory and 0600 socket intentionally protect against unrelated local users, not against the owning account. This does not reopen S1's confidentiality boundary under the existing local-process authority model: code executing as the daemon's user can already inspect/control that user's daemon process and local Admin/process authority. It does, however, expose an availability/one-shot weakness captured separately as M1 below. No cross-user route-authority disclosure was found.

### Test evidence

`packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts` provides the following focused checks:

- The Darwin and Linux spawn seams inspect the actual argv passed by `openTerminal()` and assert the canary is absent (`:36-63`). The Darwin assertion also verifies the descriptor key is absent from `open`'s environment and the canary is absent from both regular files.
- The IPC test executes the generated bootstrap as a real Node process, has the eventual child report its environment over a separate local socket, and compares all descriptor fields exactly (`:65-102`). This crosses the bootstrap/final-child boundary rather than merely inspecting immediate spawn options.
- The real-macOS opt-in test calls the production `open`/Terminal path and has the eventual Terminal-launched child report the canary (`:104-131`). It uses only Node, Terminal, and local Unix sockets, makes no model/API request, and is non-billable.

This reviewer did not run on a physical macOS host. The opt-in test was skipped in the lead-provided result, so there remains a **physical-host evidence gap**, not an open S1 implementation finding. Before a macOS release, the opt-in test should be executed on a real host; its current 500 ms polling budget (`100 × 5 ms`) may also be too short for cold Terminal/Launch Services startup and should be made realistically bounded to avoid false failures.

## New findings

### M1 — Major — macOS IPC can retain the daemon event loop after launch cleanup is no longer reachable

**Failure scenario / reproduction:**

1. On macOS, call the production `defaultTerminalOpener()` and let `open` succeed without the command file connecting (for example, Terminal fails to consume it).
2. `openTerminal()` creates a referenced `net.Server`. Its timeout is unref'ed, but the server itself is not (`cliLaunch.ts:280-320`).
3. `openTerminal()` returns a cleanup function, but `defaultTerminalOpener()` discards it (`:335-337`), and the `TerminalOpener` interface returns `void` (`:188-195`). Session stop, opener completion, bootstrap failure, and daemon session reset therefore cannot invoke this IPC cleanup handle.
4. A daemon attempting to exit remains alive until the 120-second timeout closes the server.
5. Worse, if a same-user peer connects first and keeps its side open, the accepted socket remains referenced. `cleanup()` calls `server.close()` and removes the directory but does not track, unref, or destroy accepted sockets (`:280-292`). The timeout therefore does not bound that connection, and the daemon can remain alive indefinitely.

Additional one-shot consequence: the connection callback has no `claimed` guard. Connections already accepted around `server.close()` can each execute `socket.end(JSON.stringify(env))`; cleanup's idempotence guards filesystem/server cleanup, not descriptor writes (`:280-292`). The private same-user boundary limits confidentiality impact, but this is not a strict one-shot channel.

**Why Major:** this violates the round-2 acceptance criteria that the transfer be one-shot/bounded and cannot hang the daemon. It also leaves cleanup disconnected from session stop/reset and bootstrap failure paths.

**Required resolution:**

- Make the listener and every accepted socket unable to retain the daemon event loop (`unref()`), and/or explicitly destroy tracked sockets during idempotent cleanup.
- Gate the connection callback with an atomic one-shot/claimed flag; reject/destroy every connection after the first accepted peer.
- Preserve and invoke the cleanup handle from the terminal/session lifecycle, including opener failure, session stop/reset, and daemon shutdown. If the public opener type remains fire-and-forget, provide an internal registration mechanism with equivalent ownership.
- Add deterministic child-process tests proving an unconsumed listener and a connected non-closing peer do not keep the process alive, plus a test that only one accepted connection receives the descriptor.

No other new Blocker/Major finding survived review.

## Cleanup-path assessment

- **Normal consumer success:** descriptor is sent after accept; bootstrap removes the launch directory before spawning the CLI. Functional transfer is correct.
- **Synchronous file/setup failure:** the enclosing catch invokes idempotent cleanup and rethrows (`cliLaunch.ts:294-324`).
- **Asynchronous listen/server error:** `server.once('error', cleanup)` removes artifacts, but the fire-and-forget API cannot report the failed launch to `handleCliLaunch()`; the lease/session can still be reported as launched. This is secondary to M1's ownership defect.
- **Synchronous opener throw:** caught inside the listen callback and cleaned (`:306-316`).
- **Opener `error` event:** cleanup is registered (`:312`).
- **Opener nonzero exit without `error`:** not observed; cleanup waits for timeout.
- **No consumer:** filesystem/listener cleanup occurs after 120 seconds, but the referenced listener delays process exit until then (M1).
- **Repeated cleanup/races:** the `cleaned` guard makes timer/server/filesystem cleanup idempotent (`:278-292`). It does not terminate accepted sockets or prevent multiple callbacks from writing the descriptor (M1).
- **Bootstrap parse/spawn failure:** errors do not log descriptor content, but the daemon-side cleanup handle is not lifecycle-owned. Spawn failures are logged by message only; malformed JSON throws in the bootstrap without echoing the payload.

## Regression status for prior findings

- **S2 — RESOLVED, no round-2 regression found.** The round-2 delta is confined to terminal descriptor transport/tests and does not alter RouteLeaseManager's shutdown/publication transaction.
- **P1 — RESOLVED, no authority-lifetime regression found.** Renewal and release ownership remain present for built-in terminal leases. M1 concerns the auxiliary macOS IPC resources, not lease renewal correctness.
- **P2 — RESOLVED, no round-2 regression found.** Subscription remapping and actual-model attribution paths are untouched.
- **P3 — RESOLVED, no round-2 regression found.** Model error classification is untouched.
- **P4 — RESOLVED, no round-2 regression found.** Pool exhaustion mapping and Retry-After behavior are untouched.
- **P5 — RESOLVED, no round-2 regression found.** Admin create/renew cache policy is untouched.
- **S3 — RESOLVED, no round-2 regression found.** Codex descriptor authentication comments/contracts remain on the dedicated route-token env-key model.

## Checks actually run

### Executed

1. Read and traced:
   - `rasen/changes/rasen-managed-route-lease/evidence/review-report.md`
   - `rasen/changes/rasen-managed-route-lease/evidence/review-loop-round-1-report.md`
   - `docs/design/rasen-managed-route-lease-requirements.md`
   - `rasen/changes/rasen-managed-route-lease/design.md` (targeted contract search)
   - `rasen/changes/rasen-managed-route-lease/specs/rasen-managed-route-leases/spec.md` (targeted contract search)
   - `packages/daemon/src/admin/cliLaunch.ts`
   - `packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts`
   - relevant descriptor/schema references under `packages/core/src/provider-proxy`
2. Ran `git diff -- packages/daemon/src/admin/cliLaunch.ts packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts` and inspected the terminal-launch delta. It completed with an LF/CRLF advisory.
3. Ran targeted repository searches for the socket/bootstrap implementation, call sites, secret/argv requirements, and same-user/permission assumptions.
4. Ran `git diff --check`. It passed with LF/CRLF advisories only and no whitespace errors.

### Attempted but not executed

The following commands were requested but did **not** execute because the harness required additional approval unavailable in this review turn:

```text
npx vitest run packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts
npm run typecheck -w @omnicross/daemon
```

No independent runtime or typecheck result is claimed. The lead-provided `6 passed, 1 skipped`, prior `106 passed, 1 skipped`, and daemon typecheck results are treated as prior evidence only.

## Final disposition

- S1 independently confirmed resolved: **YES**.
- Regression findings S2/P1/P2/P3/P4/P5/S3 remain resolved: **YES**.
- All Blocker findings independently confirmed resolved: **YES**.
- All Major findings independently confirmed resolved: **NO** — new M1 remains open.
- Ship may proceed: **NO**. Fix and independently verify M1, then run the focused lifecycle test, daemon typecheck, and the real-macOS opt-in eventual-child test on a physical host.
