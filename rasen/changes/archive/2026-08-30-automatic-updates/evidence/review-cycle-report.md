# Review cycle report: automatic-updates

Date: 2026-08-24  
Reviewer: independent non-author Codex reviewer  
Mode: dispatched, report-only

## Round history

| Round | Scope | Verdict | Counts | Evidence |
|---|---|---|---|---|
| Initial review | Full `origin/main` to working-tree product diff, including untracked files | FAIL | Blocker 0 / Major 2 / Minor 3 / Trivial 0 | Cryptographic finalizer verification and production target fallback were missing; locale, capability, and Settings integration gaps were recorded. |
| Fix round 1 | Implementer correction of the five canonical findings | Submitted for re-review | — | Fixes added real updater error classification, a locked Minisign verifier and signed fixtures, localized copy/guard, permission removal, and component integration tests. |
| Re-review round 1 | Only the fix delta for the five findings | **PASS WITH TRIVIAL — SHIP UNBLOCKED** | **Blocker 0 / Major 0 / Minor 0 / Trivial 1** | All five prior findings are resolved. One rustfmt-only issue in the new verifier remains recorded. |
| Trivial cleanup | Rustfmt wrapping in the signature verifier | Submitted for final re-review | — | Applied rustfmt's multiline wrapping to the `verify` signature and success message. |
| Final re-review | Only the rustfmt cleanup delta | **CLEAN — SHIP UNBLOCKED** | **Blocker 0 / Major 0 / Minor 0 / Trivial 0** | Independent rustfmt and diff-whitespace checks pass; no behavior changed. |

## Resolved findings

- **Major: release signature authenticity — RESOLVED.** Every selected Windows/macOS/Linux updater asset is verified against the public key read from the tagged Tauri config before manifest assembly/write. Valid, mutated, wrong-key, malformed-signature, and fail-before-write tests pass.
- **Major: production target mismatch fallback — RESOLVED.** Real `TargetNotFound`/`TargetsNotFound` variants map to the manager's unsupported path; release-page fallback and no-download behavior are proven by adapter classification plus manager tests, while network failures remain retryable network errors.
- **Minor: untranslated update copy — RESOLVED.** Thirty non-English locales contain localized blocks; checker enforces keys, placeholder parity, and rejection of a wholly English block.
- **Minor: unnecessary process capability — RESOLVED.** Dependency, builder plugin, permission, and lockfile references are absent.
- **Minor: Settings integration coverage — RESOLVED.** Actual `SettingsPage` jsdom tests cover persistence wiring, browser behavior, user actions, retry routing, and visible states.

## Final trivial resolution

- **Trivial: verifier rustfmt wrapping — RESOLVED.** `scripts/updater-signature-verifier/src/main.rs:11-15` and `:41-44` now use rustfmt's multiline wrapping. Independent `cargo fmt --manifest-path scripts/updater-signature-verifier/Cargo.toml -- --check` passes.

## Exact independent commands and results

1. `cargo test` from `apps/desktop/src-tauri` — PASS: 19 passed, 0 failed.
2. `npm run test:release-contract` — PASS: 9 passed, including real Minisign verification and all specified negative/fail-before-write cases.
3. `npx vitest run packages/ui/src/features/settings/__tests__/SettingsPage.updates.test.ts packages/ui/src/shared/state/__tests__/updateModel.test.ts packages/ui/src/shared/tauri/__tests__/update.test.ts packages/ui/src/shared/tauri/__tests__/uiSettings.test.ts` — PASS: 4 files, 15 tests.
4. `npm run typecheck -w @omnicross/ui` — PASS.
5. `node packages/ui/scripts/check-i18n.mjs` — PASS for 31 locales.
6. `python -c "import pathlib,yaml; p=pathlib.Path('.github/workflows/release.yml'); yaml.safe_load(p.read_text(encoding='utf-8')); print('YAML OK:',p)"` — PASS.
7. Node JSON parse over tracked/untracked changed `*.json` — PASS: 39 files.
8. `git diff --check origin/main` — PASS (Git emitted only local LF-to-CRLF warnings).
9. Strict UTF-8/BOM, private-key material, process-plugin, untracked build/key-artifact, and verifier-target-ignore scans — PASS.
10. `cargo fmt --manifest-path scripts/updater-signature-verifier/Cargo.toml -- --check` — PASS after the behavior-neutral wrapping cleanup.

## Final verdict

**CLEAN — SHIP UNBLOCKED BY REVIEW:** Blocker 0 / Major 0 / Minor 0 / Trivial 0. The review-cycle correctness, security, and formatting gates are clean. The existing external deployment gates remain: protected signing secrets must be provisioned and a genuine signed draft must be smoke-tested on all three supported updater targets before publish. Those are operational gates, not reopened code findings.
