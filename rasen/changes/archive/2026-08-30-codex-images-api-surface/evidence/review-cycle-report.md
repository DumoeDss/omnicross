# Review Cycle: codex-images-api-surface

**Round:** 3 / 3  
**Mode:** dispatched delta re-review / report-only  
**Verifier:** original independent reviewer, not the fix author  
**Status:** **CLEAN**  
**Open:** 0 Blocker, 0 Major, 0 Minor, 0 Trivial

This re-review changed no product code, tests, or run-state. Its only write is this report.

## Candidate and delta identity

- Original reviewed candidate tree: `9ab797118334d95185501f5eada36568d89b56f9`.
- Round-1 candidate tree, including all untracked files: `89f8a2e3f10f2b926bf17f806d50d512d4a717e1`.
- Current merge HEAD: `a468f3ccfcf1575b254d34400d006d6f73b0584e`; HEAD tree: `3c9c4d068e73c25e2250bc89dfc7087a100df823`.
- `origin/main`: `83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594`; it is the merge-base/ancestor of HEAD. The branch is zero behind and three commits ahead.
- Delta `9ab797..89f8a2e`: 22 paths, 570 insertions, 27 deletions. Two paths are the disjoint overview UI commit merged from main; the remaining delta is the review fix/tooling work.
- Worktree tracked content plus all 26 untracked blobs matches the expected round-1 tree. The 60-path feature candidate against `origin/main` has zero authored diff under `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, or `providerProxyShared.ts`.

## Round summary

| Round | Original findings (B/Ma/Mi/T) | Original dispositions | New delta findings | Fixed by | Confirmed by |
|---|---:|---|---:|---|---|
| 1 | 0/4/2/0 | 4 resolved, 2 Major open | 0/0/1/0 | LEAD-dispatched fixer, separate from reviewer | original non-author reviewer |
| 2 | 0/2/1/0 | compression Major and EOL Minor resolved; cancellation Major partially resolved and remains open | 0/0/0/0 | fresh design-level fixer | original non-author reviewer |
| 3 | 0/1/0/0 | remaining cancellation Major resolved; no new findings | 0/0/0/0 | original implementation worker | original non-author reviewer |

## Original finding dispositions

### 1. [Major] Accepted/nonterminal cancellation — **OPEN**

**Resolved portion:** the fix tracks `accepted` and `providerTerminal`, cancels an accepted nonterminal job on consumer early return, accepted iterator failure, partial-budget failure, and local SSE output failure, while ordinary completed/failed collections do not cancel. Relevant regressions pass at `ImageOrchestrator.test.ts:108-201`, `:313-348`, and `securityE2e.test.ts:234-253`.

**Remaining defect:** terminal/abort races still produce a spurious cancel. `providerTerminal` becomes true as soon as a completed/failed event is received (`ImageOrchestrator.ts:415-436`), but the abort listener unconditionally calls `cancelOnce()` at `:298-300`, and the final condition at `:454` also cancels whenever the signal is aborted without excluding a provider terminal.

An independent probe delivered `accepted`, then a valid `completed` event, held the provider iterator before `done`, and aborted the request after the terminal event had been received. Result:

```json
{"first":"accepted","observed":{"code":"request_cancelled"},"cancels":1,"releases":1}
```

The provider had already declared a terminal, so this violates the required “no terminal spurious cancel” half of the original finding.

**Round-2 fix required:** gate both the abort listener and final cancellation on `!providerTerminal`, while retaining cancellation for a started nonterminal job before or after acceptance. Add an abort-after-completed-event and abort-after-failed-event race regression; preserve exactly-once cancellation for preterminal abort/local failure/early return/iterator failure.

### 2. [Major] Final format/size/transparent-alpha postconditions — **RESOLVED**

`assertFinalOutputMatchesRequest()` compares canonical MIME to the requested output format, exact width/height for explicit pixel sizes, and `hasAlpha === true` for transparent background. Completion validates every output before assigning `pendingTerminal`, before reference retention, telemetry success, or outward completion (`ImageOrchestrator.ts:170-188`, `:415-431`).

Independent review confirmed regressions for MIME, width, height, alpha, and a mismatching member of a multi-output completion. The tests assert `upstream_protocol_changed`, no reference-store save, one release, and no cancellation after an actual provider terminal. **Non-author confirmed resolved.**

### 3. [Major] Requested per-output partial budget — **RESOLVED**

The orchestrator now keeps per-output indexes and counts, rejects every partial when the budget is zero, rejects count or index overflow, and retains independent budgets for multiple outputs (`ImageOrchestrator.ts:315-413`). Exact-budget and zero/overflow regressions pass; overflow paths cancel the accepted nonterminal job exactly once and release once. **Non-author confirmed resolved.**

### 4. [Major] Quality/moderation/compression capability truthfulness — **OPEN**

**Resolved portion:** the public contract now carries `qualityLevels`, `moderationModes`, and structured `outputCompression`; orchestrator and subscription guards reject unsupported options before start/egress. Quality/moderation use allow-listed set intersection, and missing/empty/disjoint sets fail the whole capability snapshot closed. The dormant production source still returns unknown account/upstream evidence and remains unavailable. Unknown, empty, and disjoint compression tests return `{ supported: false }`.

**Remaining defect:** invalid compression evidence can be normalized into affirmative support. `intersectOutputCompression()` at `capabilities.ts:72-99` checks that the fields exist and are integers, but it does not validate each layer's format members or each layer's range bounds before intersecting them. Invalid outer bounds can be masked by stricter valid layers, and an illegal common format can be advertised.

Independent runtime probe:

```json
{
  "invalidRangeMasked":{"supported":true,"formats":["jpeg","webp"],"min":0,"max":100},
  "invalidFormatAffirmed":{"supported":true,"formats":["gif"],"min":0,"max":100}
}
```

The first case supplied one evidence layer with `min: -5, max: 105`; the second supplied `formats: ["gif"]` from all layers. Both must fail closed.

**Round-2 fix required:** validate every affirmative layer independently before intersection: all formats must be unique supported `ImageOutputFormat` values, bounds must be integers in 0–100, and `min <= max`. Any invalid layer yields `{ supported: false }`. Add explicit invalid-format, invalid-bound, reversed-range, unknown, empty, and disjoint regressions.

### 5. [Minor] Eleven mixed-EOL Images files — **RESOLVED**

All 11 originally reported files are now uniform LF with no BOM. Ignoring EOL, eight are semantically identical to the original candidate; the other three contain only reviewed intentional harness/SDK/security changes. No original content was lost. **Non-author confirmed resolved.**

### 6. [Minor] Core runtime versus official SDK engine policy — **RESOLVED**

The official SDK moved from `packages/core` to root contributor tooling. `@omnicross/core` still publishes `engines.node: >=20.9` and no longer has an OpenAI dev dependency. Root tooling resolves official `openai@7.8.0`; `test:images-sdk-contract` executes a Node-major-22 guard before loading the SDK, and the SDK test itself dynamically imports only after the same runtime check. README and executable policy tests record the split. **Non-author confirmed resolved.**

## New delta finding

### [Minor] [AUTO-FIX] Three engine-policy files now have mixed CRLF/LF endings — **OPEN**

The fix for finding 6 inserted LF lines into existing CRLF files without normalizing them:

| File | CRLF | bare LF |
|---|---:|---:|
| `package.json` | 37 | 5 |
| `packages/core/README.md` | 11 | 11 |
| `packages/core/package.json` | 65 | 4 |

`git diff --check` remains clean because Git normalizes these paths, but the Windows working tree is formatting-unstable. Normalize only these three files to their existing CRLF convention, preserving semantic content and UTF-8 without BOM.

No Minor/Trivial item is accepted-known in this round; this mechanical item remains open for round 2.

## Verification evidence

### Targeted behavior tests

```powershell
npx vitest run packages/core/src/image-generation/__tests__/ImageOrchestrator.test.ts packages/core/src/image-generation/__tests__/capabilities-errors.test.ts packages/core/src/image-generation/openai-images/__tests__/securityE2e.test.ts packages/subscriptions/src/image-generation/__tests__/CodexSubscriptionImageProvider.test.ts packages/subscriptions/src/image-generation/__tests__/capabilityEvidence.test.ts
```

**PASS:** 5 files, 73 tests. This scope directly exercises cancellation, final postconditions, partial budgets, capability intersection, subscription fail-closed behavior, and the real HTTP cleanup path.

```powershell
npm run test:node-tooling-policy
npm run test:images-sdk-contract
```

- Node tooling policy: **PASS**, 2/2 on Node 24.14.0, including simulated Node 21 rejection and Node 22/24 acceptance.
- Root SDK contract command: **PASS**, 9 JavaScript tests; one environment-gated Python test skipped in that combined invocation.
- Explicit `OMNICROSS_PYTHON_SDK_EXECUTABLE` invocation: **PASS**, 1/1 using the previously provisioned official Python SDK environment.

### Typecheck and build

- Contracts/core/subscriptions typecheck: **PASS**.
- Contracts/core/subscriptions ESM/CJS/DTS builds: **PASS**.

These are required because the delta changes the public capability contract and both core/subscription consumers.

### Candidate integrity and safety

- `rasen validate codex-images-api-surface --type change --strict --json`: **PASS**, valid with zero issues.
- Tree-to-tree `git diff --check origin/main 89f8a2e...`: **PASS**.
- Strict UTF-8 decode across all 60 feature-candidate paths: **PASS**; no BOM, U+FFFD, or common mojibake signatures.
- Secret-pattern scan: **PASS**; no real API-key/JWT-shaped value. Test sentinels remain intentionally fake and redacted.
- Forbidden authored diff: **PASS**, zero protected path.
- Latest-main integration: **PASS**, `83a3cfb` merged at `a468f3c`; the two upstream UI files are disjoint from the Images fix.

## Final disposition

**NOT CLEAN.** Round 1 resolves two of the four original Majors and both original Minors, but shipping remains blocked by the terminal/abort spurious-cancel race and invalid compression evidence being affirmed after intersection. Round 2 should make those two bounded fixes, normalize the three newly mixed-EOL files, then return only that delta to this non-author reviewer.

---

## Round 2 delta re-review

### Candidate and delta identity

- Round-1 candidate tree: 89f8a2e3f10f2b926bf17f806d50d512d4a717e1.
- Round-2 candidate tree: 6a84ce1273cda55e07205023eb6fa6cd8677ab82.
- Round-2 delta: 4 paths, 172 insertions, 36 deletions.
- HEAD remains a468f3ccfcf1575b254d34400d006d6f73b0584e; HEAD tree remains 3c9c4d068e73c25e2250bc89dfc7087a100df823.
- A fresh fetch left origin/main at 83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594. It is already an ancestor of HEAD; the branch is ahead 3 and behind 0, so no additional merge is required.
- Current tracked modifications plus untracked candidate files have the same 44-path set as HEAD..6a84ce1 and zero filtered-blob mismatches. The real Git index is empty.

### Finding 1: [Major] Started/nonterminal cancellation — PARTIALLY RESOLVED, OPEN

Resolved in round 2:

- The abort listener and finalizer no longer call ImageJob.cancel after a valid completed or failed provider terminal has been received.
- Deterministic held-iterator regressions cover completed-terminal plus abort and failed-terminal plus abort. Both assert zero cancels, one iterator return, and one lease release.
- The accepted/nonterminal control still asserts exactly one cancel and one release.
- Ordinary completed and failed collections still do not cancel, while accepted early return, accepted iterator failure, local output failure, and partial-budget failure retain exactly-once cancellation.

The targeted matrix passed all 85 tests, including the three new terminal-race controls.

Remaining defect:

ImageOrchestrator.ts:265-267 defines cancelAcceptedNonterminalOnce with an accepted guard:

    if (!accepted || providerTerminal) return

Both the abort listener at :302-304 and the finalizer at :458 use that helper. A job can already exist before its accepted event arrives. If the caller aborts during that interval, the stream terminates as request_cancelled but the live provider job is never cancelled.

Independent runtime probe against the built ESM surface:

    {"observed":"request_cancelled","cancels":0,"releases":1}

The probe acquires the lease, starts the job, holds the first iterator read before any accepted event, then aborts. This violates image-provider-foundation/spec.md:66-71: when the caller aborts after the job starts but before a terminal event, job cancellation must be invoked once. It also risks leaving subscription work and quota consumption alive after the client has disconnected.

Round-3 fix required:

- Gate cancellation on whether a job exists and the provider is nonterminal, not on accepted.
- Preserve the newly-correct zero-cancel behavior after completed and failed terminals.
- Add a deterministic abort-after-start-before-accepted regression asserting request_cancelled, cancel exactly once, iterator return exactly once, and release exactly once.
- Keep the accepted/nonterminal, local failure, early return, iterator failure, ordinary completed, and ordinary failed assertions green.

Shipping remains blocked by this Major.

### Finding 2: [Major] Final format, dimensions, and transparent-alpha postconditions — RESOLVED

The round-2 delta does not weaken final artifact validation. MIME must match the requested output format, explicit dimensions must match exactly, and transparent output requires hasAlpha=true before retention or successful completion. The focused orchestrator/security tests covering single- and multi-output mismatch, no retention, cleanup, and stable upstream_protocol_changed behavior pass. Non-author confirmation remains valid.

### Finding 3: [Major] Requested per-output partial budget — RESOLVED

Per-output counts and indexes still reject zero-budget partials, count/index overflow, and preserve independent budgets for multiple outputs. Exact-budget completion remains valid; overflow cancels the accepted nonterminal job exactly once. Focused regressions pass. Non-author confirmation remains valid.

### Finding 4: [Major] Quality, moderation, and output-compression capability truthfulness — RESOLVED

capabilities.ts now validates every affirmative output-compression evidence layer before intersection:

- formats must be a non-empty, unique subset of png, jpeg, and webp;
- min and max must be integers in the inclusive 0-100 range;
- min must not exceed max;
- missing, supported=false, malformed, empty, invalid, or disjoint evidence fails closed.

Only validated layers are intersected. The focused tests cover unsupported and duplicate formats, negative and over-limit bounds, reversed ranges, non-integer bounds, malformed affirmative shape, unknown/empty evidence, valid disjoint formats/ranges, and a valid overlap.

Independent built-surface probe:

    {
      "invalidRangeMasked":{"supported":false},
      "invalidFormatAffirmed":{"supported":false},
      "validOverlap":{"supported":true,"formats":["jpeg"],"min":40,"max":80}
    }

Quality and moderation allow-listed intersections remain unchanged and their supported, empty, and pre-egress rejection paths pass. The dormant subscription evidence source still returns account/protocol unknown, an unavailable capability snapshot, and no upstream request. Non-author confirmed resolved.

### Finding 5: [Minor] Original eleven mixed-EOL Images files — RESOLVED

The original eleven Images files remain uniformly LF, strict UTF-8, and free of semantic corruption. No round-2 delta touches them except the reviewed TypeScript source/test changes represented in the candidate tree. Non-author confirmation remains valid.

### Finding 6: [Minor] Published core runtime versus official SDK tooling policy — RESOLVED

The root contributor toolchain still owns openai@7.8.0 behind an executable Node-major-22 guard. The published core package remains engines.node >=20.9 and carries no OpenAI runtime or dev dependency. Round 2 made no semantic change to these policy files; their filtered blobs exactly match the candidate tree. Non-author confirmation remains valid.

### Finding 7: [Minor] Three mixed-CRLF engine-policy files — RESOLVED

All three files are strict UTF-8 without BOM and now consistently use their existing CRLF convention:

| File | CRLF | bare LF | bare CR | Candidate blob match |
|---|---:|---:|---:|---|
| package.json | 42 | 0 | 0 | yes |
| packages/core/README.md | 22 | 0 | 0 | yes |
| packages/core/package.json | 69 | 0 | 0 | yes |

Git-filtered working-tree hashes match 6a84ce1 exactly, proving the normalization introduced no semantic change beyond the already-reviewed tooling-policy edits. Non-author confirmed resolved.

No Minor or Trivial item is accepted-known in round 2.

## Round 2 verification evidence

### Targeted behavior tests

Command:

    npx vitest run packages/core/src/image-generation/__tests__/ImageOrchestrator.test.ts packages/core/src/image-generation/__tests__/capabilities-errors.test.ts packages/core/src/image-generation/openai-images/__tests__/securityE2e.test.ts packages/subscriptions/src/image-generation/__tests__/CodexSubscriptionImageProvider.test.ts packages/subscriptions/src/image-generation/__tests__/capabilityEvidence.test.ts

Result: PASS — 5 files, 85 tests.

This scope directly covers terminal/abort races, active-job cancellation controls, final postconditions, requested partial budgets, capability intersection and pre-egress rejection, dormant subscription fail-closed behavior, and the real HTTP cleanup path. The independent pre-accept abort probe exposes the one uncovered lifecycle regression described above.

### Typecheck and build

- contracts typecheck: PASS.
- core typecheck: PASS.
- subscriptions typecheck: PASS.
- contracts ESM/CJS/DTS build: PASS.
- core ESM/CJS/DTS build: PASS.
- subscriptions ESM/CJS/DTS build: PASS.

### Candidate integrity and safety

- Strict Rasen validation: PASS, valid with zero issues.
- git diff --check from origin/main to 6a84ce1: PASS.
- Round-2 tree delta check from 89f8a2e to 6a84ce1: PASS.
- Working candidate identity: 44 current changed/untracked paths, 44 expected candidate paths, zero path-set or filtered-blob mismatches.
- Feature candidate against origin/main: 60 paths.
- Strict UTF-8 decode across all 60 paths: PASS; zero BOM, U+FFFD, or common mojibake signals.
- Secret-shape and oversized literal Base64 scan: PASS; zero matching files.
- Forbidden-path audit: PASS; zero authored path under packages/core/src/openai-operation, openaiResponsesIngress.ts, or providerProxyShared.ts.
- Latest-main integration: PASS; origin/main 83a3cfb is already contained in HEAD a468f3c.
- Real Git index: empty.

The test/build evidence applies to candidate tree 6a84ce1273cda55e07205023eb6fa6cd8677ab82. Generated dist output is ignored and does not alter the candidate.

## Round 2 final disposition

**NOT CLEAN.** Round 2 independently closes the invalid-compression Major and the three-file EOL Minor, and confirms all earlier resolved findings remain resolved. The terminal-side half of cancellation is fixed, but the same change regresses caller abort after job start and before accepted: request cancellation is surfaced while ImageJob.cancel is never invoked. One bounded lifecycle fix and a non-author round-3 delta re-review are required before shipping.

---

## Round 3 final delta re-review

### Candidate and delta identity

- Round-2 candidate tree: 6a84ce1273cda55e07205023eb6fa6cd8677ab82.
- Round-3 candidate tree: 93575c32695b4a48300827b47724fb14de38c0be.
- Final delta: 2 paths, 26 insertions, 6 deletions.
- The only changed paths are ImageOrchestrator.ts and ImageOrchestrator.test.ts.
- Current tracked modifications plus untracked candidate files have the same 44-path set as HEAD..93575c3 and zero filtered-blob mismatches.
- HEAD remains a468f3ccfcf1575b254d34400d006d6f73b0584e. origin/main remains 83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594 and is already an ancestor of HEAD.

### Remaining finding: [Major] Started/nonterminal cancellation — RESOLVED

The final helper is now cancelStartedNonterminalOnce. It suppresses cancellation only after a provider terminal has been accepted. It delegates job existence and exactly-once ownership to cancelOnce:

    if (providerTerminal) return
    return cancelOnce(reason)

cancelOnce remains a no-op before ImageJob exists and remains idempotent after the first call. This establishes the required boundary:

- acquisition or validation before start: zero cancel;
- ImageJob exists and no terminal: cancel exactly once, whether accepted has arrived or not;
- completed or failed provider terminal received: later abort/finalization performs zero cancel;
- lease release and iterator teardown remain exactly once.

The final tests add both missing pre-accept controls:

- a provider iterator failure before accepted now asserts one cancel and one release;
- a held pre-accept iterator followed by caller abort asserts request_cancelled, one cancel, one iterator return, and one release.

They retain the accepted/nonterminal, completed-terminal, failed-terminal, acquisition-abort, ordinary completed/failed, early-return, local-failure, final-postcondition, and partial-budget controls.

Independent built-ESM runtime probe:

    {
      "preaccept":{"observed":"request_cancelled","cancels":1,"releases":1,"returns":1},
      "acceptedNonterminal":{"observed":"request_cancelled","cancels":1,"releases":1,"returns":1},
      "completedTerminal":{"observed":"request_cancelled","cancels":0,"releases":1,"returns":1},
      "failedTerminal":{"observed":"request_cancelled","cancels":0,"releases":1,"returns":1},
      "acquisitionAbort":{"observed":"request_cancelled","starts":0,"cancels":0}
    }

This satisfies image-provider-foundation/spec.md:66-71. Non-author confirmed resolved.

### Prior resolved findings

All prior dispositions remain resolved:

- final MIME, explicit dimensions, and transparent alpha are still validated before retention/completion;
- per-output partial budgets still cover zero, exact, overflow, and multi-output behavior;
- compression evidence remains validated per layer before intersection, with invalid/unknown/disjoint values fail-closed;
- quality/moderation intersections and dormant subscription unavailability remain truthful;
- the original eleven Images files and the three engine-policy files have no mixed EOL;
- the root Node 22 contributor guard and published core Node >=20.9 split are unchanged.

The two-file round-3 delta does not touch contracts, subscriptions, SDK tooling, API ingress, or any forbidden integration path. The 86-test matrix re-runs the relevant capability/subscription/HTTP cleanup regressions rather than relying only on unchanged source inspection.

## Round 3 verification evidence

### Lifecycle matrix

Command:

    npx vitest run packages/core/src/image-generation/__tests__/ImageOrchestrator.test.ts

Result: PASS — 1 file, 39 tests.

### Focused cross-layer regression matrix

Command:

    npx vitest run packages/core/src/image-generation/__tests__/ImageOrchestrator.test.ts packages/core/src/image-generation/__tests__/capabilities-errors.test.ts packages/core/src/image-generation/openai-images/__tests__/securityE2e.test.ts packages/subscriptions/src/image-generation/__tests__/CodexSubscriptionImageProvider.test.ts packages/subscriptions/src/image-generation/__tests__/capabilityEvidence.test.ts

Result: PASS — 5 files, 86 tests.

### Typecheck and build

- core typecheck: PASS.
- core ESM/CJS/DTS build: PASS.

Contracts and subscriptions were not rebuilt in round 3 because the final delta changes only core implementation and its test. Their round-2 typecheck/build evidence remains tied to the same unchanged candidate blobs, and the focused matrix re-exercises the consuming subscription behavior.

### Candidate integrity and safety

- Strict Rasen validation: PASS, valid with zero issues.
- git diff --check for 6a84ce1..93575c3: PASS.
- git diff --check for origin/main..93575c3: PASS.
- Working candidate identity: 44 current changed/untracked paths, 44 expected candidate paths, zero path-set or filtered-blob mismatches.
- Feature candidate against origin/main: 60 paths.
- Strict UTF-8 decode failures: 0.
- BOM, U+FFFD, and common mojibake signals: 0.
- Mixed-EOL files across all 60 candidate paths: 0.
- Secret/JWT/Bearer/private-key/oversized-literal-Base64 shape files: 0.
- Forbidden authored paths: 0.
- Real Git index paths: 0.
- Latest-main integration: PASS; origin/main is already an ancestor of HEAD.

The final test/build evidence applies to candidate tree 93575c32695b4a48300827b47724fb14de38c0be. Generated dist output is ignored and does not alter the candidate.

## Round 3 final disposition

**CLEAN.** All Blocker and Major findings are independently confirmed resolved. No new finding was introduced by the final two-file delta, and no Minor or Trivial item remains to accept-known. The codex-images-api-surface child is review-clean and may proceed to its ship stage.
