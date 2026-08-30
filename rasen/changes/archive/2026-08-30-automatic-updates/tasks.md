## 1. Updater and release configuration

- [x] 1.1 Add the Tauri updater dependency and the minimum desktop capability permissions needed for status, download, install, and relaunch; do not broaden browser UI network access.
- [x] 1.2 Generate and securely back up the updater signing key pair, commit only the public key, configure the GitHub `latest.json` endpoint, and set protected signing key/password secrets without logging their values.
- [x] 1.3 Configure explicit Windows x64 NSIS, macOS universal app archive, and Linux x86_64 AppImage updater targets while preserving MSI/DMG/deb/rpm as manual release assets.
- [x] 1.4 Add a release-contract validator that checks stable tag/Tauri-version parity, required target entries, HTTPS GitHub asset URLs, and non-empty signatures without contacting or installing from production during unit tests.

## 2. Native update manager

- [x] 2.1 Define serializable update status/version/progress/error models plus a small `UpdateBackend` seam and fake adapter for tests.
- [x] 2.2 Implement the Tauri updater production adapter using running package SemVer, GitHub-hosted manifest metadata, explicit target compatibility, and plugin signature verification.
- [x] 2.3 Implement `UpdateManager` state transitions and snapshot/event publication for idle, checking, up-to-date, available, downloading, ready, installing, and phase-specific failure states.
- [x] 2.4 Add operation guards so overlapping startup/manual checks reuse current state, repeated availability/preference signals start no duplicate download, and check requests cannot disrupt download/install.
- [x] 2.5 Implement separate silent and interactive check policies, including the 8-second metadata timeout, sanitized diagnostics, stable-only/no-downgrade acceptance, and unsupported-target release-page fallback.
- [x] 2.6 Implement verified background download with throttled progress, one in-memory staged artifact, retry/discard cleanup, and no automatic install/exit/restart.
- [x] 2.7 Implement explicit install/relaunch behavior for Windows NSIS and macOS/Linux, ensuring the owned daemon follows the existing shutdown path and pending bytes are cleared.

## 3. Settings and startup integration

- [x] 3.1 Extend Rust `UiSettings`, view, patch, defaults, and persistence with camelCase `autoDownloadUpdates`, default false, without changing existing field values or corrupt-file fallback.
- [x] 3.2 Extend the TypeScript Tauri settings bridge/default UI state with `autoDownloadUpdates` and preserve safe null/no-op behavior outside Tauri.
- [x] 3.3 Notify `UpdateManager` after a saved preference change so enabling can idempotently download an already available release and disabling affects future automatic starts without cancelling in-flight work.
- [x] 3.4 Register managed updater state and snapshot/check/download/install commands plus one typed status event in the desktop builder.
- [x] 3.5 Schedule the packaged-only startup check in a detached Tauri task after a 5-second delay, independently of window reveal and the existing daemon `spawn_blocking` lifecycle.

## 4. Renderer interaction and localization

- [x] 4.1 Add a renderer update bridge/store that reads an initial native snapshot, subscribes exactly once to status changes, normalizes actions, and survives late mount or React StrictMode remount.
- [x] 4.2 Add a compact app-wide non-modal update surface near `DaemonStatusBanner` for available, downloading, ready, and actionable failure states without showing silent startup-check failures.
- [x] 4.3 Add Settings > General rows for the persistent automatic-download switch, current/latest version, Check now/up-to-date feedback, download/retry, open-release, and explicit install/restart actions.
- [x] 4.4 Add clear update and automatic-download strings to every supported locale, retain English fallback behavior, and validate every locale JSON file.
- [x] 4.5 Ensure browser-served UI hides/disables desktop updater controls and that update metadata never exposes signing secrets, credentials, or local artifact paths.

## 5. Release automation

- [x] 5.1 Update the GitHub release build to create signed updater artifacts for the three supported in-app targets and fail closed when signing configuration is unavailable.
- [x] 5.2 Replace per-matrix manifest publication with one post-build finalizer that assembles, validates, and uploads the sole `latest.json` to the draft GitHub Release after all platform artifacts/signatures exist.
- [x] 5.3 Document release signing, protected-secret setup/rotation, supported versus manual-only packages, draft/publish behavior, and the rule against replacing artifacts under an existing tag.

## 6. Automated and packaged verification

- [x] 6.1 Add Rust manager tests for newer/equal/older/prerelease/invalid versions, unsupported targets, single-flight check/download races, silent timeout/failure, manual failure visibility, auto-download on/off/toggle races, verified readiness, signature/download failure, cleanup, and explicit-only installation.
- [x] 6.2 Add Rust settings tests for missing-field defaults, legacy JSON compatibility, round-trip/patch persistence, and corrupt-file fallback.
- [x] 6.3 Add renderer model/bridge/settings tests for initial snapshot plus event reconciliation, status/action mapping, switch persistence, desktop/browser behavior, progress throttling outcomes, and error visibility boundaries.
- [x] 6.4 Add release-contract tests using fixture manifests for missing targets/signatures, tag/version mismatch, unsafe URLs, and a complete supported matrix.
- [x] 6.5 Run targeted tests during iteration, then full Cargo tests, workspace tests/typecheck/build, locale/JSON/YAML validation, strict UTF-8 and diff checks, and record results.
- [x] 6.6 Produce a signed draft test release and smoke-test offline startup latency, manual check, auto-download off/on, invalid-signature rejection, ready-without-restart behavior, install/relaunch, and owned-daemon cleanup on each supported target (or record target-specific CI evidence where hardware is unavailable).

## 7. Review and delivery

- [x] 7.1 Run an independent code/security review focused on updater trust, lifecycle races, logging, permissions, and release-secret handling; fix findings and repeat until clean.
- [x] 7.2 Confirm the implementation satisfies every scenario in `desktop-application-updates`, update user/developer documentation, and verify no unrelated worktree changes are included.
- [x] 7.3 Commit the completed change on `feat/automatic-updates`, push it, and create a PR targeting `main` with the design decisions, verification evidence, supported-target limits, and signing/deployment notes.
