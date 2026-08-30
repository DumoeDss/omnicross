## Why

Omnicross desktop users currently have to discover and install new releases manually, so fixes and security updates can be missed. The desktop app should discover GitHub releases after startup without delaying the window or daemon, and optionally fetch a verified update in the background while leaving the user in control of installation.

## What Changes

- Check the latest supported GitHub release asynchronously after the desktop app has started; bounded network failures are ignored on the automatic path and never delay startup or normal use.
- Add a persistent “Automatically download updates” desktop setting. Detection remains enabled when the setting is off; the setting controls only whether an available update is downloaded without another click.
- Surface available, downloading, ready-to-install, and actionable failure states in the desktop UI, with manual check/download/retry/install actions.
- Publish platform-appropriate, cryptographically signed updater artifacts and GitHub-hosted release metadata for supported desktop targets.
- Prevent overlapping startup/manual checks or duplicate downloads, and define predictable behavior for development builds, unsupported packages, prereleases, timeouts, and app shutdown.

## Capabilities

### New Capabilities

- `desktop-application-updates`: Desktop release discovery, optional verified background download, user-driven installation, settings persistence, lifecycle status, and release compatibility/security requirements.

### Modified Capabilities

- None.

## Impact

- Tauri desktop shell startup and managed state under `apps/desktop/src-tauri`, including new updater commands/events and persisted UI settings.
- React settings and application-level update presentation under `packages/ui`, including localized copy and desktop-only behavior.
- Tauri/Cargo and frontend updater dependencies, capability/configuration declarations, and GitHub release automation for signed update manifests and artifacts.
- Unit/integration coverage for update state transitions, concurrency and timeout behavior, settings compatibility, renderer interaction, and release-manifest/platform coverage.
