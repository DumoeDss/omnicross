# Signed draft evidence: v0.1.12

Date: 2026-08-24  
Release ID: `375348913`  
Release state: draft, not published  
Release target used for the platform builds: `911fc614644e0292c28e604c92222c749af61944`

## Target-specific packaging evidence

GitHub Actions run [32672108557](https://github.com/DumoeDss/omnicross/actions/runs/32672108557) used the protected signing secrets and the final feature-branch commit. The complete run concluded successfully.

| Target | Job | Result | Signed updater evidence |
| --- | --- | --- | --- |
| Windows x64 | [NSIS/MSI job](https://github.com/DumoeDss/omnicross/actions/runs/32672108557/job/97274413984) | Passed | `Omnicross_0.1.12_x64-setup.exe` plus `.sig` |
| macOS universal | [app/DMG job](https://github.com/DumoeDss/omnicross/actions/runs/32672108557/job/97274413964) | Passed | `Omnicross_universal.app.tar.gz` plus `.sig` |
| Linux x86_64 | [AppImage/deb/rpm job](https://github.com/DumoeDss/omnicross/actions/runs/32672108557/job/97274413948) | Passed | `Omnicross_0.1.12_amd64.AppImage` plus `.sig` |

The final [finalize-updater job](https://github.com/DumoeDss/omnicross/actions/runs/32672108557/job/97275440526) also passed every step: asset download, cryptographic verification, manifest assembly, upload, byte-for-byte readback, and contract revalidation.

## Regression discovery history

Earlier test-draft runs exposed three release-only contract bugs rather than hiding them:

1. Draft releases do not create `refs/tags/<version>` before publication. Commit `847312f` resolves the draft's API `target_commitish`, pins downstream jobs to that immutable commit, and rejects a same-name draft that targets any other commit.
2. Tauri v2 emits a direct `.AppImage`, while the first finalizer contract accepted only the legacy `.AppImage.tar.gz` name. Commit `6e1c00b` accepts both forms while retaining the exactly-one-asset rule.
3. A newly-created draft is not guaranteed to appear in an immediate list query. Commit `911fc61` creates through the Releases REST API and consumes the authoritative POST response directly; existing-draft reuse still uses the paginated uniqueness check.

The failing runs stopped before unsafe mutation: the first stopped before platform jobs when its tag assumption failed, the second finalizer stopped before writing `latest.json` on the Linux naming mismatch, and the third stopped before platform jobs on the eventual-consistency gap. The final v0.1.12 run proves all corrections together.

## Real-asset verification and manifest evidence

The finalizer downloaded all 13 v0.1.12 platform assets from the same draft. It selected the Windows NSIS, macOS universal app archive, and Linux AppImage, then cryptographically verified all three bytes/signature pairs with the public key committed in `tauri.conf.json` before assembling the manifest.

The generated `latest.json` was uploaded to the draft, downloaded again, compared byte-for-byte, and revalidated. Results:

- Manifest version: `0.1.12`
- Targets: `windows-x86_64`, `darwin-universal`, `linux-x86_64`
- Uploaded manifest SHA-256: `23DD3EC13E67CD6272421BDBECD748A78AE35A3FE9DF3C2B9BE646316A7E3AE3`
- Draft asset count after upload: 14
- Release remains a draft and therefore does not affect `/releases/latest`.

## Behavior-smoke mapping

Interactive OS installer automation is not safe on the available shared Windows user profile, and no persistent macOS/Linux GUI hosts are attached. Task 6.6 therefore uses its permitted target-specific CI evidence path, combined with the native state-machine and renderer tests, rather than claiming an unattended GUI installation happened.

| Required behavior | Evidence |
| --- | --- |
| Startup stays responsive/offline | `lib.rs` launches the check in a detached async task after five seconds; `silent_failure_and_timeout_return_to_idle_without_user_error` proves offline/error/timeout returns to idle without a visible error; renderer tests suppress startup-check failures. |
| Manual check | Settings component tests route the explicit check action; manager interactive failure/up-to-date/available tests cover state and retry behavior. |
| Automatic download off/on | `automatic_download_is_opt_in_and_never_installs`, `disabling_preference_before_automatic_start_prevents_download`, and `enabled_discovery_downloads_once_and_progress_finishes_exactly`. |
| Invalid signature rejection | The release-contract suite rejects mutated bytes, wrong keys, and malformed signatures; `verification_failure_discards_bytes_and_has_download_retry_boundary` proves no installable bytes survive failure. |
| Ready without restart | Automatic-download tests reach `Ready` with zero install calls; UI tests show the explicit Install/Restart action only in ready state. |
| Install/relaunch is explicit | `installation_is_explicit_and_failure_clears_staged_artifact` and Settings action-routing tests prove no automatic install call and one explicit install boundary. Production adapters use updater install semantics, with explicit non-Windows restart. |
| Owned-daemon cleanup | Windows updater `on_before_exit` invokes `DaemonRuntime::shutdown` plus application cleanup; non-Windows install invokes `DaemonRuntime::shutdown` before restart. All three platform packages compiled these paths successfully. |

The draft is verification evidence only. A maintainer should still perform a human interactive install/relaunch acceptance pass before publishing any production release; that operational acceptance is not represented as an automated GUI test.
