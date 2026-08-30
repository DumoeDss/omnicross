# Pre-Landing Strategy Delta Re-Review: codex-images-production-wiring

**Strategy attempt:** 1 after the normal three-round review cap

**Mode:** dispatched, report-only

**Verdict:** CLEAN

**Fixer:** `/root/production_strategy_fixer1`

**Exact strategy delta:** tree `b8a5165c824e9b6bf64b35c630f8d50a112324df` → tree `969d5b6885bff3ba02ddcbc17c1d09566ac6b072`

**Scope:** 3 files, 217 insertions, 63 deletions. This re-review considered only that exact delta against the sole open Major and scanned the delta itself for regressions.

**CWD guard:** repository root `E:/AI/ChatAI/Agents/VibeCodingProjects/elftia/elftia/omnicross--codex-hosted-tools-and-images`; branch `feat/codex-hosted-tools-and-images`; HEAD `bee04cc3f9f72150138f7a740034dd9659b46282`.

**Reviewer independence:** The same non-author reviewer independently reread the complete exact delta, all three complete post-tree files, the authoritative Images configuration ceiling/validators, the relevant proposal/tasks/spec, and the prior review history. No fixer code was authored.

## Sole finding disposition

### N1-1. [Major][Spec + Standards] Resolved by a process-independent bounded envelope

The strategy is materially different from the three lease-based iterations and closes the cross-process hole:

- `PHYSICAL_RETENTION_TTL_MS` is derived directly from the authoritative `IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs` (`FileCodexImageCapabilityEvidenceSource.ts:23`, `:43-48`; `imagesServerConfig.ts:11-12`, `:60`). The same ceiling bounds tolerant normalization and strict admin validation (`imagesServerConfig.ts:312-316`, `:467-472`).
- Every successful writer—resident, independent doctor, early, late, or first-row—persists exactly `verifiedAt + 604800000` after an overflow-safe clock check (`FileCodexImageCapabilityEvidenceSource.ts:287-310`). Physical retention therefore no longer depends on another process seeing an in-memory lease.
- Each immutable generation/doctor view still computes its own logical expiry as `min(physicalExpiresAt, verifiedAt + ttlMs)` (`FileCodexImageCapabilityEvidenceSource.ts:256-285`, `:385-387`). A short view becomes stale without deleting evidence still logically fresh for a longer resident view.
- Both direct logical TTLs and persisted rows fail closed above the same ceiling, including safe-integer overflow (`FileCodexImageCapabilityEvidenceSource.ts:146-160`, `:214-218`). Cleanup remains bounded and removes rows only when `entry.expiresAt <= now` (`FileCodexImageCapabilityEvidenceSource.ts:326-349`).
- The obsolete process-local active-TTL registry is gone; `dispose()` remains lifecycle-compatible but is correctly a no-op because safety is persisted (`FileCodexImageCapabilityEvidenceSource.ts:477-524`).

The prior exact late-doctor failure now reproduces successfully under an independent ad-hoc probe:

```json
{"physical":604800000,"longFresh":true,"longExpiresAt":290,"shortFresh":false,"shortExpiresAt":230,"cleanupAfterShort":0,"restartFresh":true,"cleanupAtEnvelope":1}
```

At time `231`, the resident view remains fresh through logical deadline `290`, the short doctor view is stale at `230`, cleanup removes nothing, and a restarted resident sees the same fresh row. Cleanup removes the row exactly at `190 + 604800000`.

**Disposition:** Resolved. No Blocker or Major remains.

## Boundary confirmation

| Required path | Evidence | Result |
| --- | --- | --- |
| Independent first short-doctor writer | Evidence-source test writes the first row through a separate short owner, checks physical envelope, long/short logical views, cleanup, and restart (`FileCodexImageCapabilityEvidenceSource.test.ts:57-119`) | Pass |
| Independent late short-doctor writer | Legacy floor `200`, rewrite at `190`, read/cleanup at `231`, restart, and exact physical cleanup (`FileCodexImageCapabilityEvidenceSource.test.ts:121-189`) plus independent probe above | Pass |
| Rewrite after the old floor | Rewrite at `201`, cleanup after short deadline, resident logical deadline `301`, exact bounded cleanup (`FileCodexImageCapabilityEvidenceSource.test.ts:191-233`) | Pass |
| Restarted owner | First-writer and late-writer tests reconstruct an independent source and retain the resident logical window (`FileCodexImageCapabilityEvidenceSource.test.ts:103-118`, `:176-188`) | Pass |
| Old HTTP and hosted leases plus rollback | Controller test keeps generation N HTTP/hosted work active while an independent doctor creates the row, makes N+1 stale, rolls back, and rechecks hosted evidence (`ImageRuntimeConfigController.test.ts:346-471`) | Pass |
| Short-view staleness | Short view omits values at its own deadline while resident remains available (`FileCodexImageCapabilityEvidenceSource.test.ts:158-174`, `:387-409`; controller test `:427-456`) | Pass |
| Cleanup before and exactly at envelope | No removal after logical expiry; removal exactly at `verifiedAt + IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs` (`FileCodexImageCapabilityEvidenceSource.test.ts:411-417`; controller test `:472-501`) | Pass |
| Malformed and over-ceiling rows | Existing strict-schema test plus new logical-TTL and persisted-expiry upper-bound tests (`FileCodexImageCapabilityEvidenceSource.test.ts:337-370`, `:420-444`) | Pass |
| Authoritative maximum alignment | Source, tests, tolerant config normalization, and strict config validation all reference `IMAGE_SERVER_HARD_CEILINGS.evidenceTtlMs` | Pass |

## Standards and spec axes

**Standards:** 0 findings. The exact delta is bounded, overflow-safe, fail-closed at persistence/config boundaries, and introduces no enum/value completeness gap, unsafe side effect, or unbounded cleanup path.

**Spec:** 0 findings. The strategy preserves generation-pinned evidence semantics required by `images-production-configuration/spec.md:52-61` for HTTP, hosted acquisition, and rollback while retaining a finite hard-safe policy.

Pre-Landing Review: No issues found.

## Regression scan

No Blocker, Major, Minor, or Trivial regression was found in the exact strategy delta. The longer physical envelope does not extend advertised capability: logical freshness and status remain view-specific. Storage remains bounded by the 256-entry owner limit and 4 MiB manifest limit, while expired cleanup remains limit-bounded.

Codex CLI/Greptile/live adversarial passes were not run because the dispatch explicitly prohibited live/paid probes and subagent/delegation work. This does not reduce the deterministic local evidence below.

## Focused coverage

```text
CODE PATH COVERAGE
===========================
[+] Persisted physical envelope
    ├── [★★★ TESTED] First independent short writer → long resident + restart
    ├── [★★★ TESTED] Late rewrite before old floor → resident survives short deadline
    ├── [★★★ TESTED] Rewrite after old floor → resident window restored
    ├── [★★★ TESTED] Cleanup before envelope does nothing
    └── [★★★ TESTED] Cleanup exactly at envelope removes row

[+] Per-view logical TTL
    ├── [★★★ TESTED] Long resident remains fresh
    ├── [★★★ TESTED] Short doctor/N+1 view becomes stale
    └── [★★★ TESTED] Restart preserves identical logical behavior

[+] Runtime flow
    ├── [★★★ TESTED] Old HTTP and hosted generation remain pinned
    ├── [★★★ TESTED] Replacement HTTP and hosted generation is stale
    └── [★★★ TESTED] Rollback restores old hosted generation

[+] Trust boundaries
    ├── [★★★ TESTED] Logical TTL above authoritative ceiling rejected
    ├── [★★★ TESTED] Persisted expiry above envelope rejected
    └── [★★★ TESTED] Unknown/malformed manifest fields rejected

─────────────────────────────────
OPEN GAPS: 0
─────────────────────────────────
```

## Exact verification evidence

| Check / command | Result |
| --- | --- |
| CWD/branch/HEAD guard via `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse HEAD` | Exact required root, branch, and HEAD confirmed at start, before tests, and before final gates |
| `git cat-file -t b8a5165c...` / `git cat-file -t 969d5b68...` | `tree` / `tree` |
| `git diff --stat b8a5165c... 969d5b68...` | 3 files; 217 insertions; 63 deletions |
| `git ls-tree -r --name-only 969d5b68...` | 1,125 entries |
| Per-file `git hash-object` versus `git rev-parse 969d5b68...:<path>` | 3 checked; 0 mismatches before and after dynamic verification |
| Focused `npm test -- --run ...` over config, evidence, doctor, runtime controller/factory, cleanup, daemon composition, bootstrap | Exit 0; 8 files / 41 tests passed |
| `npm run typecheck` | Exit 0; all 6 workspace typechecks passed |
| Independent wrapped `npx tsx -e` late-doctor challenge | Exit 0; resident fresh to `290`, short stale at `230`, no cleanup at `231`, restart fresh, one removal exactly at 7-day envelope |
| Initial full-matrix probe invocation | Exit 1 before scenario execution: Windows command line too long; reduced instead of repeated |
| First reduced probe invocation | Exit 1 before scenario execution: top-level await unsupported by CJS eval; corrected with an async wrapper |
| `git diff --check b8a5165c... 969d5b68...` | Exit 0 |
| Strict UTF-8/BOM/U+FFFD/mojibake scan | 3 files; 0 issues |
| Forbidden-path gate over the exact delta | 0 matches |
| Legacy in-memory lease-symbol scan | 0 matches |
| `rasen validate codex-images-production-wiring --type change --strict` | Exit 0; Change is valid |

## Triage and gate

| Item | Severity | Status | Route |
| --- | --- | --- | --- |
| N1-1 process-independent physical evidence retention | Major | Resolved | CLEAN |
| New strategy-delta findings | — | None | — |
| Minor/Trivial findings | — | None | — |

No product, task, spec, run-state, commit, push, PR, archive, live/paid probe, subagent, delegation, collaboration message, or wait operation was performed. Only this report and `evidence/review-cycle-report.md` were written.
