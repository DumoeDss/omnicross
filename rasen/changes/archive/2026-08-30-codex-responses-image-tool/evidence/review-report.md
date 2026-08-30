# Pre-Landing Review: `codex-responses-image-tool`

Pre-Landing Review: No issues found.

**VERDICT: CLEAN — 0 Blocker, 0 Major, 0 Minor, 0 Trivial.**

Review mode: round-2 independent dispatched `rasen-review`, report-only. This round reviewed only the cancellation fix delta in `ResponsesImageGenerationContribution.ts` and its test file. The reviewer did not modify product code/tests, run tests, stage, commit, push, or alter run-state.

## Scope check

**Scope Check: CLEAN**

- Intent: close round-1 Major R1, where abort could be lost during delayed `resolveResponse`, `resolveCall`, or image-reference resolution.
- Delivered delta: one linked-cancellation helper, pre-scope ownership transfer/cleanup changes, stricter trusted-signal validation, and three focused delayed-resolution regression tests.
- No unrelated product behavior or shared-owner file changed in this round's reviewed delta.
- The real Git index remains empty.

## Round-2 disposition

### R1 — [RESOLVED] Cancellation remains live throughout asynchronous request-scope construction

**Linked cancellation starts before awaits.** [`ResponsesImageGenerationContribution.ts`](../../../../packages/core/src/image-generation/responses/ResponsesImageGenerationContribution.ts) validates the signal API at lines 80–83, then `linkAbortSignal` registers the runtime listener and immediately seeds the linked controller for an already-aborted signal at lines 94–107. `createScope` creates that link before entering any state/reference lookup at lines 143–164.

**Every post-await lease is owned before cancellation is observed.** A found response lease is pushed before the post-`resolveResponse` abort check at lines 177–185; a found call-state lease is pushed before the post-`resolveCall` check at lines 189–194; and a found image lease is pushed before the post-reference check at lines 195–201. A final abort check runs immediately before scope construction at line 213. Consequently, cancellation after a dependency has created a lease cannot bypass cleanup.

**Failure and success transfer listener ownership exactly once.** Before scope creation succeeds, the catch path releases every accumulated lease, removes the runtime listener, and returns the stable cancellation error at lines 223–226. On success, the linked controller and removal callback are transferred into `RequestScope` at lines 214–222 and stored at lines 257–274. `dispose()` retains normal execution/commit coordination, releases scope-held leases, aborts the local controller if needed, and removes the runtime listener at lines 633–664.

**Provider start is excluded after construction-time abort.** Execution receives only the linked controller signal. Because every delayed lookup path now abort-checks before returning a scope, no cancelled construction can reach provider acquisition/start.

### Regression-test evidence

[`ResponsesImageGenerationContribution.test.ts`](../../../../packages/core/src/image-generation/responses/__tests__/ResponsesImageGenerationContribution.test.ts) contains separate delayed-dependency tests:

- lines 989–1050: abort during `resolveResponse`; the returned response lease is released once, call resolution is not entered, listener is removed once, and provider acquire/start remain zero.
- lines 1052–1106: abort during `resolveCall`; the call-state lease is released once, reference resolution is not entered, listener is removed once, and provider acquire/start remain zero.
- lines 1108–1180: abort during `referenceStore.resolve`; both state and image leases are released once, listener is removed once, and provider acquire/start remain zero.
- lines 1182 onward preserve the existing already-aborted and active-provider cancellation paths, so the construction fix does not replace later lifecycle coverage.

## Standards axis

No Blocker, Major, Minor, or Trivial finding remains in the reviewed delta. The linked-listener ownership is explicit, cleanup is deterministic, and the added helper does not introduce a Fowler-baseline smell material enough to report.

**Standards count:** 0 findings.

## Spec axis

The round-1 gap against [`spec.md`](../specs/responses-image-generation-tool/spec.md) lines 143–144 is closed: the final integrator's request signal is linked before state/reference work, cancellation wins after each asynchronous boundary, acquired leases are released, and a provider cannot start from a cancelled scope construction. This also matches the single cancellation-source decision in [`design.md`](../design.md) lines 158–160.

No missing, extra, or incorrectly implemented Change behavior was found in the round-2 delta.

**Spec count:** 0 findings.

## Finding-to-fix confirmation

| Finding | Final status | Evidence |
|---|---|---|
| S1 lifecycle/commit-dispose race | **RESOLVED** | Serialized lifecycle, pre-await commit publication, owned iterator cancellation, coordinated dispose/rollback; round-2 linked construction closes the remaining pre-scope cancellation edge. |
| P1 authorized known-empty previous response | **RESOLVED** | Empty response bindings remain explicit bounded state, distinct from missing/cross-tenant/expired/evicted state. |
| P2 selected non-image tool trust | **RESOLVED** | Selected identities and counts are checked against declaration index/type/name and exact forced choice. |
| S2 official terminal discriminator mismatch | **RESOLVED** | Only partial events use the official discriminator; completed/failed values are internal `kind` records with SDK contract coverage. |
| S3 mixed EOL | **RESOLVED** | `image-generation/index.ts` remains strict UTF-8 without BOM and consistently CRLF. |
| R1 delayed scope-resolution abort | **RESOLVED** | Linked listener precedes awaits; every found lease is registered before abort checks; failure/dispose own cleanup; three delayed-resolution regressions assert zero provider start. |

## Coverage audit

```text
CODE PATH COVERAGE
==================
[+] linked signal setup
    ├── [★★★ TESTED] signal already aborted before creation
    └── [★★★ TESTED] abort listener remains live before first await
[+] asynchronous scope resolution
    ├── [★★★ TESTED] abort during resolveResponse; response lease released
    ├── [★★★ TESTED] abort during resolveCall; state lease released
    └── [★★★ TESTED] abort during reference resolve; state + image leases released
[+] listener ownership
    ├── [★★★ TESTED] construction failure removes listener exactly once
    └── [★★★ COVERED] successful scope transfers listener to idempotent dispose
[+] provider boundary
    └── [★★★ TESTED] acquire/start remain zero for all construction-time aborts

USER FLOW COVERAGE
==================
[+] disconnect/timeout before scope construction                             [★★★ TESTED]
[+] disconnect/timeout during previous-response lookup                       [★★★ TESTED]
[+] disconnect/timeout during direct-call state lookup                       [★★★ TESTED]
[+] disconnect/timeout during retained-image lookup                          [★★★ TESTED]
[+] disconnect/dispose after provider work starts                            [★★★ TESTED]

ROUND-2 MATERIAL COVERAGE: 10/10 paths covered; no reported gap.
```

## Static verification performed by this reviewer

| Check | Result |
|---|---|
| Branch/worktree | Pass — `feat/codex-hosted-tools-and-images` in the required existing worktree |
| Full read of the round-2 source/test delta | Pass |
| `git diff --check` | Pass (exit 0) |
| Real Git index | Pass — empty |
| Tests/typecheck/build | Not run by this dispatched reviewer, as required; regression tests were inspected statically |

## Durable findings for production wiring

- The linked request signal is now created before all persistent image-state/reference lookups and is transferred to the request scope only after the final abort check.
- Any production state/reference implementation may resolve after cancellation, but a returned lease must still be surfaced normally: the contribution records it first, then cancellation cleanup releases it deterministically.
- Final integration must continue disposing every successfully created scope in `finally`; that disposal owns the long-lived runtime abort listener after construction succeeds.
