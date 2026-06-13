# @omnicross/ui — Control Panel frontend

The Omnicross Control Panel: a **Vite + React frontend** wired to the daemon's
localhost admin HTTP API (`/admin/api/*`). The package publishes only its built
`dist/` (static assets, zero runtime deps); the source lives right here. It has
no hard runtime dependency on any shell — the same build runs

1. **served by the daemon** at `http://127.0.0.1:8766/ui` (same origin as the
   admin API — no CORS). This is what `omnicross ui` launches; `@omnicross/daemon`
   depends on this package and resolves its `dist/` at runtime.
2. **inside the Tauri desktop shell** (`../../apps/desktop`) — the only
   Tauri-aware code paths are three `isTauri()`-guarded seams (native fetch, the
   `daemon_status` command, tray/autostart settings); in a plain browser they
   fall back to platform `fetch` / a liveness probe / hidden rows.
3. **on the Vite dev server** (port 1430). The daemon deliberately sends no
   CORS headers, so the dev server **proxies `/admin/*` to it server-side** —
   the browser only ever talks same-origin, exactly like the production `/ui`
   serving. Works against a real daemon or the mock, no `.env` needed.

## Prerequisites

- Node 18+ and npm. Nothing else for `npm run dev` at the repo root (it boots
  the daemon for you); frontend-only dev needs a daemon (or the mock) on
  `127.0.0.1:8766` for the proxy to forward to.

## Configure (optional)

Zero config by default. `.env` (see `.env.example`) is only for unusual setups:

- `VITE_DAEMON_ADMIN_TOKEN` — when the daemon sets `admin.token`, put the same
  value here so requests carry `Authorization: Bearer <token>`.
- `VITE_DAEMON_PROXY_TARGET` — where the dev proxy forwards `/admin/*`
  (default `http://127.0.0.1:8766`).
- `VITE_DAEMON_BASE_URL` — overrides the client's base URL entirely. Do NOT
  set it to an absolute URL for browser dev: that bypasses the proxy and
  cross-origin calls fail by design (the daemon sends no CORS headers).

## Run

This is a workspace member — `npm install` at the repo root installs everything.

```bash
# One command, both halves (recommended): daemon on 8766 + Vite on 1430
npm run dev            # at the REPO ROOT — seeds omnicross.dev.config.json on first run

# Frontend only (you provide the daemon or the mock on 8766):
npm run dev -w @omnicross/ui    # http://localhost:1430 — /admin/* proxied to 127.0.0.1:8766
node scripts/mock-daemon.mjs    # or: a no-key mock admin API on 8766
```

For the native desktop window, use the Tauri shell project instead:
`cd apps/desktop && npm run dev`.

## Build / verify

```bash
npm run typecheck -w @omnicross/ui    # tsc --noEmit
npm run build -w @omnicross/ui       # vite build → dist/ (relative-asset base; servable at any mount path)
```

`prepack` runs the build automatically, so `npm publish` always ships a fresh
`dist/`. The daemon serves whatever `packages/ui/dist/` holds — rebuild after
frontend changes (or point `OMNICROSS_UI_DIST` elsewhere).

## Architecture

- `src/daemon/` — the typed admin HTTP client (`adminClient.ts`) + the provider
  DTO adapter (`llmConfigAdapter.ts`) that maps the daemon's thin provider DTO
  to the Provider page's rich `LLMProvider` shape. `httpFetch.ts` is the
  transport seam (Tauri plugin-http inside the shell, platform `fetch` otherwise);
  `adminClient.ts` picks the base URL by host context (loopback inside Tauri,
  same-origin everywhere else — the daemon-served `/ui` directly, the Vite dev
  server via its `/admin` proxy).
- `src/shared/` — the local seam: `agent` (daemon-pointed, no `window.native`),
  a single-slice `settingsStore` (`useLlmProvidersData`), a `useTranslation`
  shim, and `cn`.
- `src/shared-types/` — the hand-mirrored subset of the daemon/upstream
  `llm-config` types the page consumes.
- `src/components/ui/` — the ported UI primitives.
- `src/features/` — the pages (provider settings, accounts, API service,
  Code CLI, settings).
- The Tauri shell itself lives in `apps/desktop/src-tauri` (separate project).

### Disabled-when-unbacked controls

The full Provider form is rendered for visual fidelity. Controls whose
underlying field has no daemon backing render **disabled with a tooltip**
("Not yet supported by the daemon") — never hidden, never fake-success. The only
hard exclusion is the Electron-only encrypted-credential migration pack.
