# Independent review report: automatic-updates

Date: 2026-08-24  
Mode: dispatched, report-only, non-author re-review  
Scope: final rustfmt cleanup delta only  
Base: `origin/main`

## Current verdict

**CLEAN — ship is unblocked by code review.** Both prior Major findings, all three prior Minor findings, and the final Trivial formatting finding are resolved. Current open counts: **Blocker 0 / Major 0 / Minor 0 / Trivial 0**.

The final delta is limited to rustfmt's multiline wrapping of the verifier function signature and success message. It has no behavior, security, or release-contract impact, and the independent formatting gate now passes.

## Prior-finding resolution

1. **RESOLVED — production target mismatch reaches the release-page fallback.** `apps/desktop/src-tauri/src/update_manager.rs:180-186` classifies the real `tauri_plugin_updater::Error::TargetNotFound` and `TargetsNotFound` variants as `BackendError::unsupported`; the production adapter applies it at `:234`. The manager consumes that exact kind at `:627-644`, sets `RELEASE_PAGE`, and makes the error non-retryable. The adapter-level test at `:891-906` constructs both real target variants and a real network variant; the existing manager test proves the unsupported kind exposes the fallback without downloading. Independent `cargo test` passed all 19 tests.

2. **RESOLVED — finalizer cryptographically verifies all updater assets before manifest write.** `scripts/updater-contract.mjs:76-95` selects all three required asset/signature pairs and invokes a locked Rust verifier without a shell; `:126-142` verifies using `tauriConfig.plugins.updater.pubkey` before manifest assembly or `writeFileSync`. The workflow passes the tagged commit's Tauri config at `.github/workflows/release.yml:183-203` and uploads only afterward at `:205-209`. `scripts/updater-signature-verifier/src/main.rs:6-38` matches the updater's base64/Minisign trusted-comment verification policy. Tests at `scripts/__tests__/updater-contract.test.mjs:43-107` cover all three valid pairs, changed bytes, wrong key, malformed signature, config plumbing, and fail-before-write. Independent `npm run test:release-contract` passed 9/9.

3. **RESOLVED — locale copy is localized and regression-guarded.** All 30 non-English locale update titles and blocks contain locale-specific text; an exact-value audit found no locale with a wholly English block. `packages/ui/scripts/check-i18n.mjs:15-40` enforces key presence, English placeholder parity, and rejection of a wholly English non-English block. Independent i18n validation passed all 31 locales.

4. **RESOLVED — unused renderer restart capability is removed.** Repository search found no `tauri-plugin-process`, `tauri_plugin_process`, `process:allow-restart`, or plugin-process reference outside build output/evidence. The dependency, Tauri builder registration, capability, and lockfile package are gone.

5. **RESOLVED — Settings General component integration coverage is meaningful.** `packages/ui/src/features/settings/__tests__/SettingsPage.updates.test.ts:160-234` renders the actual `SettingsPage` in jsdom and covers switch persistence wiring, browser hiding/no action, check/download/install dispatch, phase-specific retry routing, and failure/progress/ready presentation. Independent targeted Vitest passed 4 files / 15 tests.

## Final-delta resolution

- **RESOLVED — verifier formatting.** `scripts/updater-signature-verifier/src/main.rs:11-15` and `:41-44` contain only rustfmt's multiline wrapping of the `verify` signature and `println!`. Independent `cargo fmt --manifest-path scripts/updater-signature-verifier/Cargo.toml -- --check` now passes.

## Independent commands and results

- `cargo test` in `apps/desktop/src-tauri` — PASS, 19 passed.
- `npm run test:release-contract` — PASS, 9 passed; the crypto negative cases executed the Rust verifier.
- `npx vitest run packages/ui/src/features/settings/__tests__/SettingsPage.updates.test.ts packages/ui/src/shared/state/__tests__/updateModel.test.ts packages/ui/src/shared/tauri/__tests__/update.test.ts packages/ui/src/shared/tauri/__tests__/uiSettings.test.ts` — PASS, 4 files / 15 tests.
- `npm run typecheck -w @omnicross/ui` — PASS.
- `node packages/ui/scripts/check-i18n.mjs` — PASS.
- PyYAML `safe_load` of `.github/workflows/release.yml` — PASS.
- Node parse of all changed/untracked JSON — PASS, 39 files.
- `git diff --check origin/main` — PASS; only local LF-to-CRLF warnings were emitted.
- Strict UTF-8/BOM scan — PASS, 75 files, 0 decode failures, 0 BOM.
- Private-key material, process-plugin reference, and untracked build/key-artifact scans — PASS, no matches; verifier `target/` is ignored by `.gitignore:9`.
- `cargo fmt --manifest-path scripts/updater-signature-verifier/Cargo.toml -- --check` — PASS after the behavior-neutral wrapping cleanup.

## External deployment gates (unchanged, not code findings)

- Provision protected `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Produce and smoke-test a real signed draft on Windows x64 NSIS, macOS universal app, and Linux x86_64 AppImage, including install/relaunch and owned-daemon cleanup.
- Exclude `.rasen/changes/automatic-updates/ephemera/auto-run.json` and build output from the commit.
