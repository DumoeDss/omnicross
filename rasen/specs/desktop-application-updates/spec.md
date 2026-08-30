# desktop-application-updates Specification

## Purpose
TBD - created by archiving change automatic-updates. Update Purpose after archive.
## Requirements
### Requirement: Startup update discovery is non-blocking and bounded
The packaged desktop application SHALL schedule update discovery asynchronously after startup without awaiting it from window creation, daemon startup, or the normal application-ready path. Automatic metadata discovery MUST start after a 5-second delay and MUST stop after an 8-second timeout.

#### Scenario: Application becomes usable before update discovery finishes
- **WHEN** the packaged desktop application starts while the update endpoint is slow
- **THEN** the window and daemon become usable without waiting for the delayed check or its network response

#### Scenario: Automatic check cannot reach GitHub
- **WHEN** DNS, proxy, TLS, timeout, HTTP, or manifest parsing prevents the startup check from completing
- **THEN** the application silently returns update status to idle, records a sanitized diagnostic, and continues normal operation without a modal, banner error, retry loop, or crash

#### Scenario: Development build starts
- **WHEN** the desktop shell is not a packaged production build
- **THEN** startup discovery performs no external update request and does not report a false available update

### Requirement: GitHub release metadata is authoritative
The updater SHALL use the signed `latest.json` attached to the latest published, non-draft, non-prerelease GitHub Release for `Dumoedss/omnicross`. The manifest version MUST be exact SemVer derived from that release tag, and the updater MUST compare it against Tauri's running package version while rejecting equal, older, invalid, and prerelease candidates.

#### Scenario: New stable GitHub release exists
- **WHEN** the latest published release has a valid signed manifest whose version is newer than the running Tauri package version
- **THEN** the application reports that release as available

#### Scenario: Candidate is not an upgrade
- **WHEN** the release manifest version is equal to or older than the running version
- **THEN** the application reports no update and MUST NOT download or install the candidate

#### Scenario: Draft or prerelease exists
- **WHEN** GitHub contains a newer draft or prerelease but the latest stable published release is not newer than the application
- **THEN** the automatic stable updater reports no update

### Requirement: Update artifacts are signed and platform-compatible
The release pipeline MUST publish a cryptographically signed updater artifact and manifest entry for each supported in-app target: Windows x64 NSIS, macOS universal app archive, and Linux x86_64 AppImage. Runtime download MUST use HTTPS, MUST verify the artifact against the committed updater public key, and MUST fail closed on a missing/invalid signature or target mismatch.

#### Scenario: Compatible signed artifact is downloaded
- **WHEN** an available release contains the current supported target's HTTPS URL and valid signature
- **THEN** the updater verifies the bytes and transitions the release to ready-to-install

#### Scenario: Signature validation fails
- **WHEN** downloaded bytes do not match the manifest signature or the signature is absent
- **THEN** the application deletes/discards the bytes, does not expose an install action for them, and reports an actionable download failure

#### Scenario: Installed package type is unsupported
- **WHEN** update metadata exists but no supported in-app artifact matches the running architecture/package type
- **THEN** the application does not download a mismatched installer and offers the GitHub release page as the manual path

#### Scenario: Release manifest is assembled
- **WHEN** all platform build jobs finish for a release tag
- **THEN** one finalizer validates tag/version parity, all required target entries, asset URLs, and signatures before it uploads the sole `latest.json`

### Requirement: Automatic-download preference is persistent and download-only
Settings SHALL expose a desktop-only `autoDownloadUpdates` boolean persisted in `ui-settings.json`, defaulting to false when absent. The preference MUST control automatic download only; startup discovery MUST still run when it is false.

#### Scenario: Existing settings file is loaded
- **WHEN** an existing `ui-settings.json` has no `autoDownloadUpdates` field
- **THEN** the application preserves all existing preferences and treats automatic download as disabled

#### Scenario: Automatic download is disabled
- **WHEN** a newer compatible release is discovered while `autoDownloadUpdates` is false
- **THEN** the application reports the release as available and waits for the user to request download

#### Scenario: Automatic download is enabled
- **WHEN** a newer compatible release is discovered while `autoDownloadUpdates` is true
- **THEN** the application starts one verified background download without requiring another click

#### Scenario: Preference survives restart
- **WHEN** the user changes the automatic-download switch and restarts Omnicross
- **THEN** the saved value is restored and governs the next discovered release

#### Scenario: Browser-served UI is used
- **WHEN** Settings is opened outside the Tauri desktop shell
- **THEN** update controls are disabled or hidden and no desktop preference/update command is attempted

### Requirement: Update work is single-flight and idempotent
The native update manager MUST allow at most one metadata check and one download/install chain at a time. Duplicate startup, manual, event, or preference-triggered requests MUST observe or reuse current state rather than create additional network requests or installers.

#### Scenario: Manual check overlaps startup check
- **WHEN** the user requests a check while the delayed startup check is already in progress
- **THEN** the application exposes the existing checking state and issues no second metadata request

#### Scenario: Availability is observed more than once
- **WHEN** duplicate callbacks or preference writes refer to the same available version
- **THEN** at most one download starts for that version in the current process

#### Scenario: Preference is disabled during download
- **WHEN** the user turns automatic download off after a verified download has already started
- **THEN** the current download may finish, no second download starts, and future discovered releases are not downloaded automatically

### Requirement: Manual and app-wide update interaction remains available
The desktop UI SHALL provide a manual “Check now” action and SHALL present available, downloading, ready-to-install, and actionable failure states outside a route-specific modal. Settings SHALL also provide download/retry, open-release, and install/restart actions appropriate to current state.

#### Scenario: Manual check finds no update
- **WHEN** the user selects “Check now” and the signed stable manifest is not newer
- **THEN** Settings reports that Omnicross is up to date

#### Scenario: Startup check finds an update
- **WHEN** an automatic startup check finds a newer compatible release
- **THEN** a compact non-blocking app-wide status surface identifies the version without stealing focus

#### Scenario: Manual check fails
- **WHEN** an interactive check fails or times out
- **THEN** Settings shows a sanitized inline error and retry action while the rest of the application remains usable

#### Scenario: Background download fails
- **WHEN** an automatic download fails due to network, I/O, or signature validation
- **THEN** the application shows a non-modal failure with retry and release-page actions and continues normal operation

### Requirement: Installation always requires explicit confirmation
Automatic download MUST NOT install, exit, or restart the application. Only an explicit install/restart action MAY invoke the verified updater installer, and that path MUST preserve the desktop shell's normal owned-daemon shutdown behavior.

#### Scenario: Automatic download completes
- **WHEN** a background download has been verified successfully
- **THEN** the application remains open in ready-to-install state until the user explicitly requests installation

#### Scenario: User installs a ready update
- **WHEN** the user invokes install/restart for a verified ready artifact
- **THEN** Windows launches the NSIS updater and exits as required, or macOS/Linux installs and relaunches, while the shell performs its normal owned-daemon cleanup

#### Scenario: App exits before installation
- **WHEN** the application closes while a verified artifact is only staged in process memory
- **THEN** no installation occurs and the next launch safely checks/downloads again if the release remains current

### Requirement: Update status events are safe and bounded
The native update manager SHALL expose a serializable status snapshot and one status-change event containing only user-safe metadata. It MUST NOT expose signing secrets, authentication data, arbitrary local paths, or unthrottled download chunks to the renderer.

#### Scenario: Renderer mounts after a state change
- **WHEN** the UI subscribes after update discovery has already progressed
- **THEN** it first reads the current snapshot and then receives subsequent transitions without losing the available/ready state

#### Scenario: Download reports frequent chunks
- **WHEN** the updater receives many network chunks during a download
- **THEN** renderer progress events are throttled while final progress and completion remain accurate

