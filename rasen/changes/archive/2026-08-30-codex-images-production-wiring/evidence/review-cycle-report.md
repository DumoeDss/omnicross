# Review Cycle Report: codex-images-production-wiring

## Cycle state

- **Round:** 1 delta re-review
- **Mode:** dispatched, report-only
- **Verdict:** REQUEST CHANGES
- **Baseline content tree:** `4d65b0d4a2a2ac8d1cdd31ddd9f87c3f18599644`
- **Post-fix content tree:** `83a6d5812b1e7da0f33a8485f6852b732a0647c8`
- **Post-fix tree entries:** 1,125
- **Exact delta:** 28 files; 1,000 insertions; 94 deletions
- **Fixer identity:** `/root/production_fixer_round1`
- **Reviewer independence:** Same non-author reviewer independently reread the exact fixer delta and relevant full-file context; no fixer code was authored in this round.

## Counts

| Stage | Blocker | Major | Minor | Trivial | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Entering Round 1 | 1 | 2 | 2 | 1 | 6 |
| Prior findings resolved | 1 | 2 | 2 | 1 | 6 |
| New delta findings | 0 | 1 | 1 | 0 | 2 |
| Open after Round 1 | 0 | 1 | 1 | 0 | 2 |

## Per-finding confirmation

| ID | Prior severity | Round-1 disposition | Independent evidence |
| --- | --- | --- | --- |
| R0-1 generation-bound stores/policy | Blocker | Resolved | Backend-bound `saveWithLimits`/`commitWithLimits`, generation backend retention, cross-mount reads; publication/rollback and same-root policy tests pass |
| R0-2 cleanup safety/hot reload | Major | Resolved | App-session active-scope registry, active-directory exclusion, minimum stale window, prepared cadence/reconciler policy; focused tests pass |
| R0-3 resident live-doctor visibility | Major | Resolved | Shared revision-refreshing owner and external-writer/resident-reader regression pass; a separate TTL pinning regression remains below |
| R0-4 production evidence cleanup | Minor | Resolved | Bootstrap injects evidence cleanup; real-daemon composition test passes |
| R0-5 doctor pool fallback | Minor | Resolved | Config fallback reaches verifier/auth selection; strict/pool tests pass |
| R0-6 legacy badge | Trivial | Resolved in implementation | Explicit safe DTO marker reaches UI conditional; daemon projection test passes; added UI test is undiscoverable (N1-2) |

## New findings and triage

| ID | Severity | Finding | Triage |
| --- | --- | --- | --- |
| N1-1 | Major | A single mutable evidence source has its TTL updated in place, so old leased generations evaluate freshness under the new generation's TTL, violating the explicit pinned-evidence contract | REQUEST CHANGES; route generation-scoped immutable evidence views plus fake-clock HTTP/hosted reload/rollback coverage to `/root/production_fixer_round1` |
| N1-2 | Minor | `KeyManagementSection.legacy.test.tsx` is excluded by the repository's `.ts`-only Vitest include and never runs | Retain open; extend discovery or rewrite/rename the test, then execute it |

## Post-fix delta paths

```text
packages/core/src/image-generation/openai-images/TemporaryImageAsset.ts
packages/core/src/outbound-api/__tests__/imagesServerConfig.test.ts
packages/core/src/outbound-api/imagesServerConfig.ts
packages/core/src/outbound-api/types.ts
packages/daemon/src/__tests__/admin-key-permissions.test.ts
packages/daemon/src/__tests__/image-daemon-composition.test.ts
packages/daemon/src/admin/adminApi.ts
packages/daemon/src/bootstrap.ts
packages/daemon/src/image-generation/FileCodexImageCapabilityEvidenceSource.ts
packages/daemon/src/image-generation/FileImageReferenceStore.ts
packages/daemon/src/image-generation/FileResponsesImageStateStore.ts
packages/daemon/src/image-generation/ImageCleanupService.ts
packages/daemon/src/image-generation/ImageDoctorService.ts
packages/daemon/src/image-generation/ImageRuntimeConfigController.ts
packages/daemon/src/image-generation/ImageRuntimeGenerationFactory.ts
packages/daemon/src/image-generation/ImageStartupReconciler.ts
packages/daemon/src/image-generation/ImageStorageMountCatalog.ts
packages/daemon/src/image-generation/__tests__/FileCodexImageCapabilityEvidenceSource.test.ts
packages/daemon/src/image-generation/__tests__/ImageCleanupService.test.ts
packages/daemon/src/image-generation/__tests__/ImageDoctorService.test.ts
packages/daemon/src/image-generation/__tests__/ImageStartupReconciler.test.ts
packages/daemon/src/image-generation/__tests__/ImageStorageMountCatalog.test.ts
packages/daemon/src/image-generation/imageTemporaryResources.ts
packages/subscriptions/src/image-generation/CodexImageLiveVerifier.ts
packages/subscriptions/src/image-generation/__tests__/CodexImageLiveVerifier.test.ts
packages/ui/src/daemon/types-server.ts
packages/ui/src/features/api-service/KeyManagementSection.tsx
packages/ui/src/features/api-service/__tests__/KeyManagementSection.legacy.test.tsx
```

## Exact command evidence

| Command | Result |
| --- | --- |
| `$PSVersionTable.PSVersion.ToString()` | `5.1.26100.8875` |
| `git cat-file -t <baseline>` / `git cat-file -t <post-fix>` | `tree` / `tree` |
| `git ls-tree -r --name-only <post-fix> \| Measure-Object -Line` | 1,125 entries |
| `git diff --stat <baseline> <post-fix>` | 28 files; 1,000 insertions; 94 deletions |
| Per-delta-file `git rev-parse <post-fix>:<path>` versus `git hash-object <path>` | 28 checked; 0 mismatches |
| `npm test -- --run` with config, admin permissions, daemon composition, evidence, cleanup, doctor, runtime config, startup reconciler, mount catalog, verifier, and legacy UI paths | Exit 0; 10 discovered files / 48 tests passed |
| `npx vitest run packages/ui/src/features/api-service/__tests__/KeyManagementSection.legacy.test.tsx --reporter=verbose` | Exit 1; `No test files found`; include is `.ts`-only |
| `npm run typecheck` | Exit 0; all 6 workspace typechecks passed |
| `git diff --check <baseline> <post-fix>` | Exit 0 |
| Forbidden-path match over exact delta | 0 matches |
| Strict UTF-8 decoder + BOM/U+FFFD/mojibake scan over exact delta files | 28 files; 0 issues |
| `rasen validate codex-images-production-wiring --type change --strict` | Exit 0; Change is valid |

## Durable findings

1. A revision-aware shared evidence manifest owner must be separated from the immutable policy view held by each runtime generation; sharing storage does not authorize sharing mutable TTL semantics.
2. Explicitly naming a `.tsx` file on the Vitest command line does not override this repository's `.ts`-only `include`; test-file counts must be checked to detect silently skipped regressions.
3. Generation-bound durable writes require both a pinned backend and pinned write limits; shared catalog reads and current maintenance policy can remain app-session concerns.

## Constraints observed

Only `evidence/review-report.md` and `evidence/review-cycle-report.md` were written. No product/spec/task/run-state file, commit, push, PR, archive, live/paid probe, subagent, delegation, message, or wait operation was performed.

## Round 2 delta re-review

### Cycle state

- **Mode:** dispatched, report-only
- **Verdict:** REQUEST CHANGES
- **Baseline content tree:** `83a6d5812b1e7da0f33a8485f6852b732a0647c8`
- **Post-fix content tree:** `0ab1c0adae82f280625dbfc280616fb0fda69677`
- **Post-fix tree entries:** 1,125
- **Exact delta:** 7 paths; 295 insertions; 73 deletions
- **Fixer identity:** `/root/production_fixer_round2`
- **Reviewer independence:** Same non-author reviewer reread the exact delta and relevant full-file context; no fixer code was authored in this round.

### Counts

| Stage | Blocker | Major | Minor | Trivial | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Entering Round 2 | 0 | 1 | 1 | 0 | 2 |
| Resolved in Round 2 | 0 | 0 | 1 | 0 | 1 |
| Retained open after re-review | 0 | 1 | 0 | 0 | 1 |
| New Round-2 findings | 0 | 0 | 0 | 0 | 0 |
| Open after Round 2 | 0 | 1 | 0 | 0 | 1 |

### Per-finding confirmation

| ID | Prior severity | Round-2 disposition | Independent evidence |
| --- | --- | --- | --- |
| N1-1 generation-pinned evidence TTL | Major | Partially fixed; still open | Immutable views and rollback work when the manifest is unchanged, but a short view's same-account rewrite persists its own short `expiresAt`, clamps the old view, and permits physical cleanup. Runtime probe returned `oldAvailable:false` and `cleanupRemoved:1`. |
| N1-2 legacy badge test discovery | Minor | Resolved | Test renamed to `.test.ts`, JSX removed, and Vitest discovered and passed it in the 6-file/23-test slice. |

### Remaining finding and triage

| ID | Severity | Finding | Triage |
| --- | --- | --- | --- |
| N1-1 | Major | Shared manifest rows still derive physical expiry from the latest writer's TTL, so N+1/live-doctor short rewrites can truncate evidence required by a leased or restored N generation | REQUEST CHANGES; route safe physical retention plus short-writer/cleanup/rollback coverage to `/root/production_fixer_round2` |

No unrelated regression was found in the exact Round-2 delta.

### Round-2 delta paths

```text
packages/daemon/src/bootstrap.ts
packages/daemon/src/image-generation/FileCodexImageCapabilityEvidenceSource.ts
packages/daemon/src/image-generation/ImageRuntimeConfigController.ts
packages/daemon/src/image-generation/ImageRuntimeGenerationFactory.ts
packages/daemon/src/image-generation/__tests__/FileCodexImageCapabilityEvidenceSource.test.ts
packages/daemon/src/image-generation/__tests__/ImageRuntimeConfigController.test.ts
packages/ui/src/features/api-service/__tests__/KeyManagementSection.legacy.test.tsx -> packages/ui/src/features/api-service/__tests__/KeyManagementSection.legacy.test.ts
```

### Exact command evidence

| Command | Result |
| --- | --- |
| `$PSVersionTable.PSVersion.ToString()` | `5.1.26100.8875` |
| `git cat-file -t <baseline>` / `git cat-file -t <post-fix>` | `tree` / `tree` |
| `git diff --stat <baseline> <post-fix>` | 7 paths; 295 insertions; 73 deletions |
| Per-delta-file `git ls-tree <post-fix>` versus `git hash-object <path>` | 7 checked; 0 mismatches |
| Focused Vitest run: evidence source, runtime controller, renamed legacy UI, doctor, cleanup, daemon composition | Exit 0; 6 files / 23 tests passed |
| Targeted `tsx -e` short-writer probe | Exit 0; `{"verifiedAt":110,"expiresAt":150,"oldAvailable":false,"cleanupRemoved":1}` |
| `npm run typecheck` | Exit 0; all 6 workspace typechecks passed |
| `git diff --check <baseline> <post-fix>` | Exit 0 |
| Strict UTF-8 decoder + BOM/U+FFFD/mojibake scan over exact delta | 7 files; 0 issues |
| Forbidden-path gate over exact delta | 0 matches |
| `rasen validate codex-images-production-wiring --type change --strict` | Exit 0; Change is valid |

### Durable findings

4. Immutable logical TTL views do not by themselves guarantee generation pinning: a shared row's physical retention deadline must not be shortened by a writer with a shorter policy while longer-lived generations remain active.
5. Shared-store policy regressions need a writer-interleaving test, not only read-only comparisons between views; the decisive sequence is long write → short rewrite → advance clock → cleanup → old-view read/rollback.

### Constraints observed

Only `evidence/review-report.md` and `evidence/review-cycle-report.md` were written. No product/spec/task/run-state file, commit, push, PR, archive, live/paid probe, subagent, delegation, external message, or wait operation was performed.

## Round 3 delta re-review

### Cycle state

- **Mode:** dispatched, report-only
- **Verdict:** REQUEST CHANGES
- **Round-cap action:** Final normal round reached; return to the LEAD's review-cycle strategy ladder
- **Baseline content tree:** `0ab1c0adae82f280625dbfc280616fb0fda69677`
- **Post-fix content tree:** `b8a5165c824e9b6bf64b35c630f8d50a112324df`
- **Post-fix tree entries:** 1,125
- **Exact delta:** 7 files; 199 insertions; 47 deletions
- **Fixer identity:** `/root/production_fixer_round3`
- **Reviewer independence:** Same non-author reviewer reread the exact delta and all seven full modified files; no fixer code was authored in this round.

### Counts

| Stage | Blocker | Major | Minor | Trivial | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Entering Round 3 | 0 | 1 | 0 | 0 | 1 |
| Resolved in Round 3 | 0 | 0 | 0 | 0 | 0 |
| Retained open after re-review | 0 | 1 | 0 | 0 | 1 |
| New Round-3 findings | 0 | 0 | 0 | 0 | 0 |
| Open after Round 3 | 0 | 1 | 0 | 0 | 1 |

### Sole finding confirmation

| ID | Prior severity | Round-3 disposition | Independent evidence |
| --- | --- | --- | --- |
| N1-1 generation-pinned evidence TTL | Major | Substantially improved; still open | Same-owner active TTL registration, HTTP/hosted rollback, long-deadline cleanup, and disposal work. A separate late short-doctor owner cannot observe resident TTL leases and persists only `max(existingExpiresAt, verifiedAt + shortTtl)`, so the resident row was stale/removed at `230` instead of its logical `290` deadline. |

### Round-cap triage

| ID | Severity | Remaining finding | Triage |
| --- | --- | --- | --- |
| N1-1 | Major | Process-local TTL leases do not make physical retention safe for an independent doctor rewrite near/after the prior persisted floor | REQUEST CHANGES; enter strategy ladder because the third normal review round is complete |

All prior resolved Blocker/Minor/Trivial dispositions remain closed. No unrelated regression was found in the exact Round-3 delta.

### Round-3 delta paths

```text
packages/daemon/src/image-generation/FileCodexImageCapabilityEvidenceSource.ts
packages/daemon/src/image-generation/ImageDoctorService.ts
packages/daemon/src/image-generation/ImageRuntimeConfigController.ts
packages/daemon/src/image-generation/ImageRuntimeGenerationFactory.ts
packages/daemon/src/image-generation/__tests__/FileCodexImageCapabilityEvidenceSource.test.ts
packages/daemon/src/image-generation/__tests__/ImageDoctorService.test.ts
packages/daemon/src/image-generation/__tests__/ImageRuntimeConfigController.test.ts
```

### Exact command evidence

| Command | Result |
| --- | --- |
| `$PSVersionTable.PSVersion.ToString()` | `5.1.26100.8875` |
| `git cat-file -t <baseline>` / `git cat-file -t <post-fix>` | `tree` / `tree` |
| `git diff --stat <baseline> <post-fix>` | 7 files; 199 insertions; 47 deletions |
| Per-delta-file `git ls-tree <post-fix>` versus `git hash-object <path>` | 7 checked; 0 mismatches |
| Focused Vitest run: evidence, doctor, runtime controller/factory, cleanup, daemon composition, bootstrap | Exit 0; 7 files / 30 tests passed |
| Same-owner plus independent early-doctor `tsx -e` probe | Exit 0; old available after short deadline; long and post-disposal short cleanup each removed one row |
| Independent late-doctor `tsx -e` challenge | Exit 0; `{"verifiedAt":190,"physicalAndEffectiveExpiresAt":230,"residentAvailable":false,"cleanupRemoved":1,"expectedLongLogicalDeadline":290}` |
| `npm run typecheck` | Exit 0; all 6 workspace typechecks passed |
| `git diff --check <baseline> <post-fix>` | Exit 0 |
| Strict UTF-8 decoder + BOM/U+FFFD/mojibake scan over exact delta | 7 files; 0 issues |
| Forbidden-path gate over exact delta | 0 matches |
| `rasen validate codex-images-production-wiring --type change --strict` | Exit 0; Change is valid |

### Durable findings

6. In-memory TTL-view leases solve only writers sharing that owner; cross-process maintenance needs a persisted physical horizon that is independently sufficient for every allowed logical view.
7. A separate-writer test that preserves only the previous row's absolute expiry misses late-refresh truncation; place the short rewrite near the old floor and assert `newVerifiedAt + oldViewTtl` before cleanup.

### Constraints observed

Only `evidence/review-report.md` and `evidence/review-cycle-report.md` were written. No product/spec/task/run-state file, commit, push, PR, archive, live/paid probe, subagent, delegation, external message, or wait operation was performed.

## Strategy attempt 1 delta re-review

### Cycle state

- **Mode:** dispatched, report-only
- **Verdict:** CLEAN
- **Baseline content tree:** `b8a5165c824e9b6bf64b35c630f8d50a112324df`
- **Post-fix content tree:** `969d5b6885bff3ba02ddcbc17c1d09566ac6b072`
- **Post-fix tree entries:** 1,125
- **Exact delta:** 3 files; 217 insertions; 63 deletions
- **Fixer identity:** `/root/production_strategy_fixer1`
- **Reviewer independence:** Same non-author reviewer independently reread the exact delta, all modified full-file context, authoritative config ceiling/validators, relevant change artifacts, and prior review history; no fixer code was authored.
- **CWD evidence:** root `E:/AI/ChatAI/Agents/VibeCodingProjects/elftia/elftia/omnicross--codex-hosted-tools-and-images`; branch `feat/codex-hosted-tools-and-images`; HEAD `bee04cc3f9f72150138f7a740034dd9659b46282`.

### Counts

| Stage | Blocker | Major | Minor | Trivial | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Entering strategy attempt 1 | 0 | 1 | 0 | 0 | 1 |
| Resolved in strategy attempt 1 | 0 | 1 | 0 | 0 | 1 |
| New strategy-delta findings | 0 | 0 | 0 | 0 | 0 |
| Open after strategy attempt 1 | 0 | 0 | 0 | 0 | 0 |

### Sole finding confirmation

| ID | Prior severity | Strategy-attempt disposition | Independent evidence |
| --- | --- | --- | --- |
| N1-1 generation-pinned evidence TTL | Major | Resolved | Every writer persists the authoritative 7-day physical envelope while each view clamps to its own TTL. Independent late-doctor probe at `231` returned resident fresh through `290`, doctor stale at `230`, no cleanup, restart fresh, and one removal exactly at `190 + 604800000`. |

No new Blocker, Major, Minor, or Trivial finding was identified. The strategy attempt is CLEAN.

### Strategy delta paths

```text
packages/daemon/src/image-generation/FileCodexImageCapabilityEvidenceSource.ts
packages/daemon/src/image-generation/__tests__/FileCodexImageCapabilityEvidenceSource.test.ts
packages/daemon/src/image-generation/__tests__/ImageRuntimeConfigController.test.ts
```

### Boundary confirmation

1. Independent first short-doctor writer: physical envelope persisted; long resident and restarted resident remain fresh; short view is stale; cleanup waits until exact envelope.
2. Independent late writer before and after the legacy floor: each rewrite establishes `newVerifiedAt + 7 days`; resident logical expiry is `newVerifiedAt + residentTtl`.
3. Old HTTP/hosted and rollback: generation N remains fresh while N+1 is stale, and rollback reacquires generation N.
4. Malformed/over-ceiling persistence: strict schema, overflow, direct TTL, and persisted expiry checks fail closed.
5. Authoritative alignment: source behavior, tolerant config normalization, and strict config validation share `IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs`.

### Exact command evidence

| Command | Result |
| --- | --- |
| CWD/branch/HEAD guard (`git rev-parse --show-toplevel`; `git branch --show-current`; `git rev-parse HEAD`) | Exact required root / `feat/codex-hosted-tools-and-images` / `bee04cc3f9f72150138f7a740034dd9659b46282` |
| `git cat-file -t <baseline>` / `git cat-file -t <post-fix>` | `tree` / `tree` |
| `git diff --stat <baseline> <post-fix>` | 3 files; 217 insertions; 63 deletions |
| Per-delta-file post-tree blob versus worktree `git hash-object` | 3 checked; 0 mismatches before and after tests |
| Focused Vitest slice: config, evidence, doctor, runtime controller/factory, cleanup, composition, bootstrap | Exit 0; 8 files / 41 tests passed |
| `npm run typecheck` | Exit 0; all 6 workspace typechecks passed |
| Wrapped independent `tsx -e` late-doctor probe | Exit 0; `{"physical":604800000,"longFresh":true,"longExpiresAt":290,"shortFresh":false,"shortExpiresAt":230,"cleanupAfterShort":0,"restartFresh":true,"cleanupAtEnvelope":1}` |
| Initial full-matrix probe / first reduced probe | Exit 1 before scenario execution due Windows command length / CJS top-level-await transform; reduced probe then corrected and passed |
| `git diff --check <baseline> <post-fix>` | Exit 0 |
| Strict UTF-8/BOM/U+FFFD/mojibake scan | 3 files; 0 issues |
| Forbidden-path gate | 0 matches |
| Legacy in-memory lease-symbol scan | 0 matches |
| `rasen validate codex-images-production-wiring --type change --strict` | Exit 0; Change is valid |

### Durable findings

8. Cross-process physical retention can be made deterministic without distributed lease coordination by persisting one finite envelope equal to the authoritative maximum accepted logical TTL, while keeping advertised freshness per view.
9. The retention ceiling must be enforced symmetrically at configuration input, direct source construction, clock arithmetic, and persisted-row load; sharing one exported constant prevents drift.
10. Decisive retention regressions combine independent first/late writers, short-view staleness, restarted readers, and cleanup checks immediately before and exactly at the physical deadline.

### Constraints observed

Only `evidence/review-report.md` and `evidence/review-cycle-report.md` were written. No product/spec/task/run-state file, commit, push, PR, archive, live/paid probe, subagent, delegation, external message, or collaboration wait operation was performed.
