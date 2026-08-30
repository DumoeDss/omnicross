# Completion audit: automatic updates

Date: 2026-08-24  
Final branch head: `911fc614644e0292c28e604c92222c749af61944`  
Final tree: `2fb55eda9eaa4c767404b6d12dc3134c4b2e85a1`  
Pull request: https://github.com/DumoeDss/omnicross/pull/25

## Objective-to-evidence audit

| Objective requirement | Authoritative evidence | Verdict |
| --- | --- | --- |
| Detect GitHub updates after startup | Packaged startup creates a detached Tauri async task, waits five seconds, and invokes the silent check; `tauri.conf.json` points the updater at GitHub's immutable latest-release manifest URL. | Proven |
| Never block startup or normal use | The check is detached from window and daemon startup; the native manager enforces an eight-second metadata timeout. Silent network/timeout failures return to idle without a visible error. Current-head Cargo tests pass 19/19, including timeout, failure, and single-flight cases. | Proven |
| Setting to automatically download | `autoDownloadUpdates` is persisted through Rust and TypeScript settings, defaults to false, and the Settings General UI exposes the switch. Enabling can start one already-discovered download; disabling prevents future automatic starts without cancelling an in-flight download. | Proven |
| Download automatically but never install automatically | Manager tests prove opt-in automatic download reaches Ready with zero install calls. Install/restart remains an explicit Settings action and staged bytes are discarded on verification/install failure. | Proven |
| Signed, usable updater delivery | Protected GitHub signing secrets exist by name; no private material is committed. Fully green Actions run 32672108557 built Windows x64 NSIS, macOS universal, and Linux x86_64 updater assets, verified all signatures with the committed public key, generated one `latest.json`, uploaded it, downloaded it, byte-compared it, and revalidated it. | Proven |
| Worktree and development branch | Dedicated worktree `omnicross-auto-update` is attached to `feat/automatic-updates`; main worktree remains separate. Local and remote feature heads match `911fc61`. | Proven |
| Pull request to main | PR #25 is open, non-draft, head `feat/automatic-updates`, base `main`, head SHA `911fc61`. | Proven |

## Final gates

- Current-head Rust updater/settings tests: 19 passed.
- Current-head release-contract tests: 10 passed.
- Current-head updater renderer/component tests: 4 files, 15 tests passed.
- Current-head UI typecheck: passed.
- All 31 locale checks: passed.
- Fully green signed-draft workflow: https://github.com/DumoeDss/omnicross/actions/runs/32672108557
- Independent review cycle before delivery: Blocker 0 / Major 0 / Minor 0 / Trivial 0.
- Task checklist: 33/33 complete.
- Delivered diff: 74 committed paths; `git diff --check origin/main...HEAD` passes.
- Secret audit: zero committed private-key/password paths. Only `.rasen/` process ephemera remains untracked in the dedicated worktree.

The test release remains an explicitly labeled unpublished draft. Human interactive installer acceptance is a release-publication precaution, not an unmet requirement of the requested implementation or PR delivery.
