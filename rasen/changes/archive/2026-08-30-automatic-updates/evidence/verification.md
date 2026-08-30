# Automatic updates verification

Verified on Windows x64 on 2026-08-24.

## Automated checks

- `cargo test`: 19 passed after the review-fix delta, including production updater-error classification.
- `npm test`: 258 test files passed, 1 skipped; 2386 tests passed, 4 skipped.
- `npm run typecheck`: all six workspaces passed.
- `npm run build`: all six workspaces passed. Vite reported only the existing large-chunk advisory.
- `npx vitest run packages/ui/src/features/settings/__tests__/SettingsPage.updates.test.ts packages/ui/src/shared/state/__tests__/updateModel.test.ts packages/ui/src/shared/tauri/__tests__/update.test.ts packages/ui/src/shared/tauri/__tests__/uiSettings.test.ts`: 4 files and 15 tests passed, including 4 Settings General component integration tests.
- `npm run typecheck -w @omnicross/ui`: passed after the component-test and locale changes.
- `npm run test:release-contract`: 9 passed, including valid signatures, changed bytes, a wrong key, a malformed signature, and finalizer fail-before-write behavior using the key read from Tauri config.
- `node packages/ui/scripts/check-i18n.mjs`: passed for all 31 locales.
- JSON parsing: 38 updater/config/locale fixture files passed.
- `.github/workflows/release.yml`: parsed successfully with PyYAML. `actionlint` was not installed.
- Changed Rust files passed `rustfmt --check`. The repository-wide check still reports only pre-existing formatting in unchanged `daemon_runtime.rs`.
- Strict UTF-8 decoding, unexpected-BOM, common-mojibake, and trailing-whitespace checks passed over all 74 changed/untracked product files; `git diff --check` and exact private-key/password leak scans also passed.
- The verifier's generated Cargo `target/` directory is ignored; only its source manifest, lockfile, and Rust source remain visible to Git.

The first root `npm test` attempt ran before workspace build output existed and failed two daemon lifecycle assertions because `@omnicross/cli-launcher/dist/index.js` was absent. After `npm run build`, the affected file passed (11 passed, 1 skipped) and the full suite passed.

## Independent-review fix delta

- Updater `TargetNotFound` and `TargetsNotFound` errors now map to the unsupported-target release-page fallback while real network failures remain retryable network errors; the adapter-level regression test passed.
- The release finalizer now verifies all three asset/signature pairs with the committed updater public key before manifest assembly or write. Disposable signed fixtures cover success, changed bytes, wrong keys, malformed signatures, and config-to-finalizer plumbing; no fixture private key remains.
- All 30 non-English locale update blocks now contain locale-appropriate copy. The checker also enforces English placeholder parity and rejects a wholly English block in any non-English locale.
- The unused process plugin dependency, builder registration, renderer restart capability, and lockfile package were removed. A repository scan found no remaining process-plugin reference.
- Settings General component coverage now exercises switch persistence, browser hiding, check/download/install dispatch, phase-specific retry routing, and failure/progress/ready rendering.

## Packaged evidence

- `npm run stage-daemon -w omnicross-desktop`: passed.
- A local signed Windows x64 NSIS build passed using the repository-external private key and a current-user DPAPI-protected password supplied only through the child process environment.
- The build produced `Omnicross_0.1.10_x64-setup.exe` and its updater `.sig` under the ignored Tauri target directory.

## Intentionally outstanding

- The protected GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are not provisioned.
- No GitHub draft release was produced, and no signed install/relaunch/owned-daemon smoke test was run on Windows, macOS, or Linux.
- The initial non-author review produced five findings. Their fix delta is implemented and locally verified, but the same independent review gate still needs to re-review and close task 7.1.
- No commit, push, or pull request was created.
