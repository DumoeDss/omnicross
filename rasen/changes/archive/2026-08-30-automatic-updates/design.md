## Context

Omnicross is a Tauri v2 desktop shell around `packages/ui`. Native startup is assembled in `apps/desktop/src-tauri/src/lib.rs`: settings are loaded synchronously, the window is revealed, and daemon adoption/spawn is already dispatched off the setup thread. Desktop preferences are serialized as camelCase JSON in `<app_config_dir>/ui-settings.json` through `ui_settings.rs` and mirrored by `packages/ui/src/shared/tauri/uiSettings.ts` and `SettingsPage.tsx`.

The GitHub release workflow builds Windows x64 NSIS/MSI, macOS universal app/DMG, and Linux x86_64 AppImage/deb/rpm assets. The latest published release currently has ordinary installer assets (and a macOS app archive) but no signed Tauri updater manifest or `.sig` assets. At release time the workflow already derives `tauri.conf.json`'s version from the Git tag; the Cargo package version is not authoritative.

The Elftia reference demonstrates useful lifecycle principles: schedule a delayed fire-and-forget startup check, centralize updater events, persist a boolean preference, keep manual check/download/install actions, and never auto-install. Its `autoUpdateEnabled` setting disables both checking and downloading and its one-shot event listener is not a concurrency guard, so those details must not be copied: Omnicross must always detect updates and its new setting controls download only.

Dependencies are classified as follows: version comparison and state transitions are in-process; persisted preferences are local-substitutable; GitHub Releases and its CDN are true external dependencies; and the Tauri updater plugin is the production adapter at the external update seam. Tests use a fake adapter rather than real GitHub traffic.

## Goals / Non-Goals

**Goals:**

- Make startup update discovery delayed, asynchronous, bounded, single-flight, and unable to delay the window, daemon, or normal commands.
- Use a published stable GitHub Release as the authoritative release source and accept only signed, platform-compatible artifacts newer than the running app.
- Keep detection enabled independently of a persistent, opt-in automatic-download preference.
- Put check/download/install policy behind one deep native module with a small command/event interface shared by startup, settings, and app-wide UI.
- Preserve explicit user control over installation/restart and provide manual check, download/retry, and install actions.
- Produce release metadata and tests that prove every supported updater target has a signed asset.

**Non-Goals:**

- Silent installation, forced restart, downgrade, prerelease-channel selection, delta/patch updates, or an in-app release-notes browser.
- Updating daemon-only/npm/browser deployments; only the packaged Tauri desktop distribution is covered.
- Making deb, rpm, MSI, DMG, or other manual-download formats silently cross-update an incompatible installation type.
- Building a bespoke installer, signature scheme, GitHub token flow, or long-lived update history database.

## Decisions

### D1. Use GitHub-hosted signed Tauri update metadata

The runtime endpoint is the stable GitHub Release asset URL `https://github.com/Dumoedss/omnicross/releases/latest/download/latest.json`. GitHub's `latest` route selects the latest published, non-draft, non-prerelease release. The manifest `version` is the runtime authority; release CI derives it from the release tag by stripping one leading `v` and validates exact SemVer parity with the synchronized Tauri application version. The running version comes from Tauri package metadata, not `package.json` or Cargo metadata.

`tauri-plugin-updater` is the production adapter. Its SemVer comparator, target selection, redirect handling, and Minisign verification are used rather than reimplementing them. Downgrades and prereleases are rejected. The updater public key is committed in Tauri configuration; the private key and password exist only as protected GitHub secrets. TLS/certificate validation remains enabled. A release job fails closed when signing secrets, signatures, the final manifest, version parity, or target coverage are missing.

The workflow has one finalizer that owns `latest.json` after all platform jobs complete. It assembles/uploads one manifest and verifies its URLs and signatures, avoiding concurrent matrix jobs overwriting a partial manifest. Draft releases remain invisible to the `latest` endpoint until a maintainer publishes them.

Supported in-app targets are explicit: Windows x64 uses NSIS, macOS uses the universal app archive, and Linux x86_64 uses AppImage. MSI, DMG, deb, and rpm can remain release-page downloads, but the native module must detect an unsupported package/target and offer the GitHub release page instead of applying a mismatched artifact. Adding another architecture or package type requires adding and testing a signed manifest entry first.

**Alternatives considered:** A renderer call to the GitHub REST API plus direct asset download spreads lifecycle and security policy across UI code and would require CSP/permissions expansion. A custom Rust GitHub client plus installer downloader would duplicate platform selection and signature verification. Both provide less leverage and a larger security surface than the official updater adapter.

### D2. Put policy behind a native `UpdateManager` seam

Add one managed native module responsible for release discovery, version/target acceptance, state, progress, the automatic-download policy, signature failures, and installation. Its external interface has four operations: read status, request an interactive check, request a download/retry, and explicitly install/relaunch. Startup uses an internal `schedule_startup_check` entry point. The renderer receives one typed status snapshot plus a single status-change event; it does not know GitHub URLs, asset rules, keys, or plugin objects.

Internally, an `UpdateBackend` seam isolates the true external Tauri updater adapter from an in-memory fake used by tests. The production adapter returns release metadata and a verified download. The manager retains the pending update handle and the plugin-verified bytes only for the current process, clears them after install/failure/shutdown, and never marks an artifact ready before signature verification succeeds. Losing a staged in-memory artifact on exit is acceptable; the next launch checks and downloads again.

The native state machine is:

`idle/up-to-date -> checking -> available -> downloading -> ready -> installing`

Failures retain their phase (`check`, `download`, or `install`) and a retry action. State snapshots include current/latest version, release URL/notes when available, bytes/percent when known, whether automatic download is enabled, and whether the current target can install in-app. No secret or local path crosses to the renderer.

**Alternative considered:** Keeping the updater object in a React hook makes startup and manual flows separate owners and is vulnerable to React remount/listener duplication. A native manager yields one interface and concentrates concurrency/security behavior.

### D3. Schedule a silent startup check without joining startup

After the existing settings/window setup succeeds, `lib.rs` spawns a Tauri async task that waits 5 seconds and calls the manager's silent check. Neither `setup` nor daemon adoption awaits it. Packaged builds only perform the check; development/test builds report an unsupported/no-op state without network access.

The metadata request has an 8-second total timeout enforced around the check future. DNS, proxy, TLS, HTTP, JSON, timeout, missing-manifest, unsupported-target, and GitHub availability errors from the automatic check are logged without a modal, toast, banner, panic, retry loop, or startup failure; the visible state returns to idle. Download requests are background operations and do not block interaction. They use the updater adapter's streaming/progress path and normal network failure handling rather than the short metadata timeout.

Interactive checks use the same manager but expose checking, up-to-date, and sanitized failure status inline. Automatic or manual download/signature failures are visible non-modally with retry/open-release actions because bytes were explicitly requested or expected, while install failures remain visible until dismissed or retried.

**Alternative considered:** Checking immediately in `.setup()` or awaiting a spawned future would make startup latency depend on networking. An unbounded fire-and-forget request avoids an await but leaks work indefinitely on broken networks. The delayed, bounded task satisfies both responsiveness and cleanup.

### D4. Enforce single-flight checks and downloads

The manager owns an operation guard plus state mutex. At most one metadata check and one download/install chain exist. A startup/manual request arriving while a check runs observes the existing state instead of issuing another HTTP request. Check requests during download/install do not disturb that operation. Repeated availability events or setting writes cannot start a second download; automatic download is consumed once per discovered version per process. All locks are released before awaiting network, emitting events, or invoking install.

Toggling automatic download on while the same version is already `available` may trigger the manager's idempotent download entry point. Toggling it off prevents future automatic starts but does not cancel an already verified/in-progress download; cancellation would add partial-file semantics without improving startup safety.

### D5. Persist only the automatic-download preference

Extend `UiSettings`, its view/patch, and the TypeScript bridge with `autoDownloadUpdates`, defaulting to `false` so existing and new installations do not incur installer bandwidth without consent. Serde's field default keeps old `ui-settings.json` files compatible. `set_ui_settings` persists the value using the existing desktop settings path, updates managed state, and then notifies `UpdateManager` after releasing the settings lock.

Update discovery itself has no disable preference. At the point a release becomes available, the manager reads the current managed setting. If false, it stays `available`; if true, it idempotently starts a verified background download. The setting row and update controls are disabled/no-op in the browser-served UI, matching existing desktop settings behavior.

### D6. Keep installation explicit and UI non-modal by default

Add an app-level update host/banner near the existing daemon status surface so a release found at startup is visible regardless of route. The Settings > General desktop section contains the automatic-download switch, current/latest version, “Check now,” download/retry, open-release, and install/restart actions. Add localized strings to every supported locale and keep English fallback valid.

Automatic discovery never opens a dialog. `available`, `downloading`, `ready`, and actionable failures use a compact non-blocking surface. A ready update is not installed until the user clicks the install/restart action. The manager then uses the plugin installer: Windows may exit after launching NSIS; macOS/Linux install and relaunch through the normal Tauri lifecycle. Existing daemon shutdown semantics must still run on every explicit install exit path. Progress is throttled before emitting to avoid render/event storms.

### D7. Test through the manager interface and release contract

Rust tests drive `UpdateManager` with fake backend/settings/event adapters and cover: delayed startup not awaited, 8-second timeout, silent automatic failures, manual error visibility, newer/equal/older/prerelease/invalid versions, unsupported targets, single-flight re-entry, automatic-download on/off, toggle races, verified-ready state, signature/download failure, and explicit-only install. Settings tests cover defaults, legacy JSON, round-trip/patch behavior, and corrupt-file fallback.

Renderer tests cover status normalization and action availability through a pure model/reducer, plus the Settings integration and Tauri/browser bridge behavior at the existing Vitest seam. A release-contract script/test validates tag/config parity, the three supported target keys, HTTPS GitHub asset URLs, one signature per update asset, and the absence of secrets from committed files. Verification runs targeted Rust/TypeScript tests during iteration, then full `cargo test`, workspace tests/typecheck/build, JSON/YAML parsing, and a packaged smoke check before review.

## Risks / Trade-offs

- [A signed release pipeline is operationally stricter and key loss blocks updates] → Store the private key only in protected secrets, document offline backup/rotation, commit only the public key, and fail releases rather than publish unsigned metadata.
- [A matrix release can publish an incomplete or racing `latest.json`] → Make one post-matrix finalizer the only manifest writer and validate all target entries before upload/publish.
- [The updater plugin buffers a verified installer in memory] → Keep only one download, expose progress, release bytes promptly, and monitor packaged artifact size; move to a plugin-supported disk cache in a later change if measured memory is unacceptable.
- [GitHub outage, captive portal, or slow DNS can outlive normal startup] → Delay and detach the check, hard-bound metadata discovery to 8 seconds, suppress automatic-check UI errors, and leave manual retry/open-release available.
- [Manual Linux package formats may not match the in-app AppImage path] → Detect supported bundle/target explicitly and fall back to the GitHub release page rather than guessing or cross-installing.
- [An installer-triggered exit could orphan the bundled daemon] → Route explicit installation through the established exit/shutdown lifecycle and add a packaged smoke test for owned-daemon cleanup.
- [Default-off automatic download reduces immediate update uptake] → Detection and notification remain always on; the setting explains the bandwidth trade-off and can be enabled once.

## Migration Plan

1. Add the updater plugin, native manager, setting field, commands/events, renderer presentation, and tests while keeping release publication unchanged.
2. Generate the updater key pair; commit/configure the public key and add protected private-key/password secrets. Update the release workflow to sign supported artifacts and finalize/validate one manifest.
3. Produce a draft release in a temporary version/tag, verify packaged checks against its signed metadata on each supported target, and verify invalid-signature and offline behavior before publishing.
4. Publish normally only after the draft passes. Older Omnicross builds ignore the new assets; new builds use them. Rollback removes or supersedes a bad `latest.json`/release, while clients reject unsigned, invalid, equal, or older versions. Never reuse a tag or silently replace an already published signed artifact.

## Open Questions

None for implementation. Expanding in-app updates beyond Windows x64 NSIS, macOS universal, and Linux x86_64 AppImage is a future capability change that must first define signed release-manifest coverage for the added target/package type.
