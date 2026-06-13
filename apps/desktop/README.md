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

```bash
npm run build:app   # at the repo root
# or from this directory:
npm run build       # tauri build
```

`npm run build` first **stages the daemon runtime** (`scripts/build-daemon-runtime.mjs`:
`npm pack`s all workspace packages and does a production `npm install` into
`src-tauri/daemon-runtime/`). The install uses `--omit=optional`, so node-pty
(a native addon the daemon never loads — pty mode is for embedded-terminal
hosts) stays out; the staged tree is pure JS. It then **stages a private Node
binary** (`scripts/stage-node.mjs`) into `daemon-runtime/runtime/` so the pure-JS
daemon can run without any system Node.js. Then `tauri build` vite-builds
`packages/ui` (via `beforeBuildCommand`), compiles the Rust shell in release
mode, and produces:

- the bare executable — `src-tauri/target/release/omnicross-app.exe`
  (`omnicross-app` on macOS/Linux),
- installers under `src-tauri/target/release/bundle/`:
  - Windows: `nsis/*-setup.exe` and `msi/*.msi`
  - macOS: `dmg/` + `macos/*.app`
  - Linux: `deb/`, `rpm/`, `appimage/`

`bundle.targets` is `"all"` in `tauri.conf.json` — narrow it (e.g. `["nsis"]`)
to speed up packaging. To build just the exe without installers:
`npx tauri build --no-bundle`.

> **Daemon runtime:** the installer **bundles both the daemon and a private Node
> runtime**, so the target machine needs **nothing installed**. The staged
> `daemon-runtime/` ships as a Tauri resource (pure JS, no native addons), with
> the platform's official `node` binary at `daemon-runtime/runtime/node[.exe]`
> (staged by `scripts/stage-node.mjs`; macOS universal builds `lipo` the arm64 +
> x64 node into one fat binary). At startup the shell resolves the daemon entry
> in priority order — `OMNICROSS_DAEMON_ENTRY` env override → the bundled runtime
> in the app's resource dir → the repo checkout (dev) — and runs it with the
> bundled node (`bundled_node` in `daemon_runtime.rs`), falling back to a PATH
> `node` only if a build shipped without one.

## Architecture notes

The WebView's CSP `connect-src` allowlists the daemon origin
(`http://127.0.0.1:8766`), and HTTP calls go through `@tauri-apps/plugin-http`
(native transport, no CORS) — see `packages/ui/src/daemon/httpFetch.ts`.

If you only need the UI without a native window, you don't need this project at
all: run `omnicross ui` (daemon-served at `/ui`) or `npm run dev -w @omnicross/ui`.
