# omnicross-desktop — Tauri shell

The native desktop wrapper for the Omnicross Control Panel. This project is
**only the shell**: a Tauri v2 window (tray, autostart, daemon lifecycle
commands) around the `@omnicross/ui` frontend in `packages/ui` — it contains no
UI code of its own. It is a private workspace member (never published).

## Prerequisites

- Node 18+ and npm (`npm install` at the repo root installs the workspace)
- Rust / cargo 1.77+ (Tauri compiles native crates)
- Windows: the WebView2 runtime (preinstalled on Windows 10/11); the NSIS
  installer target needs no extra setup. Linux: the usual Tauri system deps
  (`webkit2gtk`, etc. — see the Tauri docs).
- End-user machines need **nothing extra** — the installer bundles both the
  daemon and a private Node runtime (see "Daemon runtime" below). Node + Rust
  above are build-time only.

## Develop

```bash
npm run dev:app  # at the repo root — runs `tauri dev` here
# or from this directory (apps/desktop):
npm run dev      # tauri dev — starts the ui package's Vite server (port 1430) + native window
```

In dev, the shell spawns the daemon from the repo checkout
(`packages/daemon/dist/cli.js` — run `npm run build` once first), or from
`OMNICROSS_DAEMON_ENTRY` when set.

## Package (release build)

Signed in-app updater targets, release-secret setup, draft finalization, and key
rotation are documented in [`../../docs/desktop-updates.md`](../../docs/desktop-updates.md).

```bash
npm run build:app   # at the repo root
# or from this directory:
npm run build       # tauri build
```

`npm run build` first **stages the daemon runtime** (`scripts/build-daemon-runtime.mjs`:
`npm pack`s all workspace packages and does a production `npm install` into
`src-tauri/daemon-runtime/`). The install uses `--omit=optional`, so node-pty
(a native addon the daemon never loads — pty mode is for embedded-terminal
hosts) stays out, then explicitly installs only the target-specific Sharp addon
needed for image processing. It then **stages a private Node binary**
(`scripts/stage-node.mjs`) into `daemon-runtime/runtime/` and verifies that this
binary can load Sharp. The daemon can therefore run without any system Node.js.
Then `tauri build` vite-builds
`packages/ui` (via `beforeBuildCommand`), compiles the Rust shell in release
mode, and produces:

- the bare executable — `src-tauri/target/release/omnicross-app.exe`
  (`omnicross-app` on macOS/Linux),
- installers under `src-tauri/target/release/bundle/`:
  - Windows: `nsis/*-setup.exe` and `msi/*.msi`
  - macOS: `dmg/` + `macos/*.app`
  - Linux: `deb/`, `rpm/`, `appimage/`

`bundle.targets` defaults to `["nsis"]` in `tauri.conf.json`; CI selects the
targets for each platform. To build just the exe without installers:
`npx tauri build --no-bundle`.

> **Daemon runtime:** the installer **bundles both the daemon and a private Node
> runtime**, so the target machine needs **nothing installed**. The staged
> `daemon-runtime/` ships as a Tauri resource (plus Sharp's target-specific
> native addon), with
> the platform's official `node` binary at `daemon-runtime/runtime/node[.exe]`
> (staged by `scripts/stage-node.mjs`; macOS universal builds `lipo` the arm64 +
> x64 node into one fat binary). At startup the shell resolves the daemon entry
> in priority order — `OMNICROSS_DAEMON_ENTRY` env override → the bundled runtime
> in the app's resource dir → the repo checkout (dev) — and runs it with the
> bundled node (`bundled_node` in `daemon_runtime.rs`), falling back to a PATH
> `node` only if a build shipped without one.

### Runtime content gate

`npm install --omit=dev` excludes development dependencies, but production
dependencies can still publish their own tests, fixtures and benchmarks.
`scripts/build-daemon-runtime.mjs` therefore runs
`scripts/prune-daemon-runtime.mjs` after installation to remove audited,
explicit package paths. Runtime code, exports, types and licenses are retained.

`scripts/verify-daemon-runtime.mjs` rejects remaining audited paths and scans
the entire staged runtime for common test/fixture/benchmark/cache directories
and `*.test.*` / `*.spec.*` JavaScript or TypeScript files. Unknown matches stop
packaging and report their paths. After reviewing a new dependency or upgrade,
add confirmed development assets to `DEVELOPMENT_ONLY_PATHS`. If a matched path
is required at runtime, add its exact staging-relative path and reason to
`REVIEWED_RUNTIME_PATHS`. The generic scan never deletes unknown files.

Both `stage-daemon` and Tauri's `beforeBundleCommand` run the verifier. This
covers local builds, CI and direct `tauri bundle` calls. Keep the hook enabled
in any custom Tauri configuration. To check an already staged runtime without
rebuilding, run from `apps/desktop`:

```bash
node scripts/daemon-runtime-version.mjs
node scripts/verify-daemon-runtime.mjs
```

Before delivering an installer, inspect its final file list (for Windows NSIS,
`src-tauri/target/release/nsis/x64/installer.nsi`) and record the version,
artifact path, size and SHA256. Reusing an existing compiled executable requires
confirming its source, dependencies and build configuration have not changed.

## Architecture notes

The WebView's CSP `connect-src` allowlists the daemon origin
(`http://127.0.0.1:8766`), and HTTP calls go through `@tauri-apps/plugin-http`
(native transport, no CORS) — see `packages/ui/src/daemon/httpFetch.ts`.

If you only need the UI without a native window, you don't need this project at
all: run `omnicross ui` (daemon-served at `/ui`) or `npm run dev -w @omnicross/ui`.

### Windows page recovery

The native shell monitors WebView2 process failures. A failed or unresponsive
main renderer is reloaded; a browser-process exit recreates the main window,
preserving its position, size, and visible/minimized state. Recovery leaves the
daemon running. WebView2 handles GPU-process restarts itself.

A native supervisor also probes JavaScript every five seconds while the window
is visible. Thirty seconds without a reply triggers a reload, then a window
rebuild if the reload does not restore the heartbeat. Hidden/minimized windows
and long pauses such as system sleep get a fresh heartbeat grace period.

At most three recoveries are attempted within five minutes. Reaching that limit
stops automatic recovery for the session and shows a native message with the
browser fallback (`http://127.0.0.1:8766/ui/`). Restarting the app enables recovery
again. Diagnostics are written to `logs/webview-recovery.log` in the app data
directory (bounded to approximately 128 KiB). System-wide DWM or display-driver
failures may still require recovery outside the app.

Run policy tests with `cargo test --lib --manifest-path apps/desktop/src-tauri/Cargo.toml`.
On a Windows desktop, the isolated native fault-injection test also kills its own
WebView2 browser and renderer and checks that their heartbeats recover:
`cargo test --lib --features custom-protocol --manifest-path apps/desktop/src-tauri/Cargo.toml native_browser_and_renderer_crashes_recover -- --ignored --nocapture`.
It uses a separate WebView profile and never manages the normal daemon.

If a Windows library-test executable exits before running tests with
`0xc0000139`, it needs the Common Controls v6 activation manifest (the packaged
app already gets its manifest from Tauri). Build the test with `--no-run`, save
the following XML to a temporary `.manifest` file, and embed it in the generated
test executable using the Windows SDK's
`mt.exe -manifest <manifest-file> "-outputresource:<test-executable>;#1"`.
Then run that executable directly with the desired test arguments.

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
      version="6.0.0.0" processorArchitecture="*"
      publicKeyToken="6595b64144ccf1df" language="*" />
  </dependentAssembly></dependency>
</assembly>
```
