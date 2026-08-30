# Review Cycle: `codex-responses-image-tool`

Rounds: 3/3 + H5 strategyAttempt 1 (R4 material-delta re-review)  
Tier: A  
Status: **CLEAN — 0 Blocker, 0 Major, 0 Minor, 0 Trivial**

| Round | Findings (B/Ma/Mi/T) | Triage and fix actor | Confirmed by (non-author) | Result |
|---|---:|---|---|---|
| 1 | 2/2/1/0 | S1/P1/P2/S2 by a fresh design-level fixer; S3 normalized in the same delta | Fresh dispatched reviewer | Original five findings resolved; reviewer found one new Major cancellation race |
| 2 | 0/1/0/0 | Pre-scope abort race fixed by a fresh non-author fixer | Same independent reviewer, delta-only re-review | Resolved; 0 open findings |
| 3 | 0/1/0/0 | Delayed-retention rollback and completion-exposure audit fixes in the cumulative uncommitted delta | Same independent reviewer, final-delta re-review | R2 and R3 resolved; one Major Responses ownership-handoff leak remains open |
| H5 strategyAttempt 1 | 0/0/0/0 | R4 synchronous consumer ownership claim and deterministic race matrix | Same independent reviewer, exact two-file material-delta re-review | R4 resolved; CLEAN |

## H5 strategyAttempt 1 disposition

### R4 resolved: Responses claims the exposed reference before observing cancellation

The producer boundary remains explicit in `ImageOrchestrator`: after the last abort check at `packages/core/src/image-generation/ImageOrchestrator.ts:385-388`, no await occurs before `completionExposed = true` and `yield completed` at lines 391-392. Once exposed, provider-terminal cancellation remains completed and the orchestrator no longer rolls the consumer-owned reference back.

The H5 delta makes the Responses consumer accept that ownership synchronously. Immediately after `await iterator.next()` resolves, a structurally valid single-image/single-reference completed event adds its ID to `#newReferenceIds` before `assertNotAborted()` or any further await. Concurrent disposal therefore waits for execution closure and deletes the claimed uncommitted reference exactly once.

The reviewer reran the exact prior 0–12 microtask-depth sweep against the freshly built ESM output. Formerly failing depths 2 and 3 now produce:

```json
{"outer":"failed","error":"request_cancelled","reference":"not_found","audit":"completed","cancel":0,"release":1,"deleted":1}
```

The full sweep proves the terminal truth table without contradictory public records: earlier pre-exposure disposal emits one cancelled audit and deletes once; depths 2–9 emit only an outer cancelled record while preserving one truthful completed provider audit and deleting the scope-owned reference once; later post-public-completion disposal emits only completed publicly and deletes the uncommitted reference once. Provider cancel remains zero after provider terminal and release occurs once throughout.

The deterministic tests additionally confirm double-dispose promise identity, abort after claim, successful commit retention, inherited-reference preservation through edit/multi-turn flows, and redaction when scope rollback deletion throws. No Blocker, Major, Minor, or Trivial finding remains open.

## Resolved findings from this re-review

- R2 is resolved for delayed reference saves. After a save returns, the new metadata is immediately added to the request-owned retention attempt; pre-exposure cancellation performs one memoized tenant/reference delete before surfacing `request_cancelled`.
- R3 is resolved inside `ImageOrchestrator`. Normal completion is exposed without awaiting telemetry; immediate or delayed-audit abort after exposure remains completed with exactly one completed audit and no orchestrator rollback. Pre-exposure rollback failure remains stable cancellation and records only redacted `retentionRollbackFailures`.
- R4 is resolved inside `ResponsesImageGenerationContribution`. The consumer claims the newly exposed reference synchronously before cancellation observation, so scope disposal owns and deletes it even in the former microtask gap.

## Previously reported finding disposition

- S1/P3: serialized request-scope lifecycle, commit/dispose coordination, linked cancellation, iterator closure, and rollback are confirmed resolved.
- P1: tenant-scoped known-empty response state remains distinct from missing, cross-tenant, expired, and capacity-evicted state.
- P2: selected non-image tool identity and count are checked against declarations and exact forced choice.
- S2: completed/failed execution records use internal `kind` values; only partial events expose the official OpenAI discriminator.
- S3: `packages/core/src/image-generation/index.ts` is strict UTF-8 without BOM and consistently CRLF.
- R1: linked cancellation is established before the first asynchronous state/reference lookup; each returned lease is owned before the post-await abort check, and provider acquisition/start remains zero on cancellation.

## Verification evidence on the current candidate

Candidate identity and scope:

- HEAD: `098a55d549c6398f0c958d5642eb6c5b9d4ec065`.
- Uncommitted candidate tree: `2a0e81a9f2a2960e24abb7bc6f3eafbc2dbe397d`.
- Exact cumulative uncommitted delta: 5 image-generation paths, 625 insertions and 18 deletions.
- H5 strategyAttempt 1 delta from `c6cfa1e7d80039b6bfd127516a47f72aa2c8abe6`: only `ResponsesImageGenerationContribution.ts` and its test, 246 insertions and 1 deletion.
- Real Git index: empty. Product worktree changes are limited to the expected five image-generation source/test paths.
- Live `git ls-remote origin refs/heads/main` and local `origin/main` both resolve to `83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594`; that commit is an ancestor of HEAD, so another merge is a no-op.

Behavior and regression gates:

- Focused orchestrator and Responses scope contracts: 2 files, 87 tests passed.
- Complete `packages/core/src/image-generation` suite: 14 files passed and 1 environment-gated Python SDK file skipped; 219 tests passed and 1 skipped.
- Relevant Native Responses regressions: 12 files, 76 tests passed.
- Full directly relevant regression total: 295 tests passed; the pinned Python SDK contract remains the single environment skip.
- Independent completion-boundary proof: normal resume/close and immediate/delayed-audit abort preserve one completed audit, provider cancel 0, release once, and no orchestrator delete after ownership transfer.
- Independent 0–12 microtask handoff sweep: every cancelled/disposed path resolves the new reference as `not_found`; former failing depths 2 and 3 now have outer cancellation, one completed provider audit, provider cancel 0, release once, and delete once.
- Inherited references remain outside `#newReferenceIds` and survive edit/multi-turn scope disposal; successful commit retains the claimed new reference and binding.
- Scope rollback delete failure remains best-effort, does not replace stable outer cancellation, and exposes none of the synthetic credential, tenant, prompt, or reference sentinels in public events or telemetry.
- `npm run typecheck -w @omnicross/core`: passed.
- `npm run build -w @omnicross/core`: ESM, CJS, and DTS passed.
- Root and deep runtime exports: ESM and CJS passed; root/deep DTS declarations contain the hosted-image seam.
- `rasen validate codex-responses-image-tool --type change --strict --json`: valid, 0 issues.

Static and safety gates:

- Audited union: 70 candidate paths; current worktree: exactly 5 paths.
- Strict UTF-8 decode issues: 0; BOM: 0; replacement/mojibake sentinels: 0; mixed/bare-CR EOL issues: 0.
- High-signal token/JWT/private-key pattern paths: 0.
- Forbidden/shared-owner paths under `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, and `providerProxyShared.ts`: 0.
- `git diff --check` for the worktree and committed branch delta: passed.
- `packages/core/src/image-generation/index.ts`: 24 CRLF, 0 bare LF.
- No nested-agent production-wiring spillover was found.

The pinned Python OpenAI SDK contract remains environment-skipped because the required executable is not configured in this environment. No SDK result was fabricated.

## Final disposition

**CLEAN.** H5 strategyAttempt 1 resolves the last Major. No Blocker, Major, Minor, or Trivial finding remains; the candidate may proceed to the parent ship gate.

## Durable findings for production wiring

- A producer's synchronous exposure boundary transfers cleanup responsibility before the consumer observes cancellation; claiming the reference first closes the promise-continuation handoff gap.
- Provider completion and containing-Response completion are distinct terminals. A completed inner audit can coexist with an outer cancellation because the outer scope has accepted and deterministically cleans the uncommitted reference.
- Cleanup-failure handling remains best-effort and redacted; tenant IDs, reference IDs, prompts, bytes, URLs, credentials, and provider-private content never enter public terminal records or telemetry.
- `origin/main` is already incorporated; no additional merge or review-cycle blocker remains before the parent ship gate.
