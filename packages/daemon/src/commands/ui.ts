/**
 * commands/ui.ts — `omnicross ui --config <path>`.
 *
 * Boots the daemon exactly like `start` (same flags), then opens the Control
 * Panel (`<dashboard>/ui/`) in the OS default browser. The UI is served by the
 * admin listener itself (same origin as `/admin/api/*` — no CORS), from the
 * `@omnicross/ui` package's static dist.
 *
 * Browser open is best-effort: on failure (or `--no-open`, or a disabled
 * dashboard) the URL is printed so the operator can open it manually.
 *
 * Test seam: `runUi(argv, deps?)` accepts injectable `start` / `openBrowser`.
 *
 * @module @omnicross/daemon/commands/ui
 */

import { resolveUiDist } from '../admin/uiStatic';

import { openBrowser } from './login';
import { runStart, type StartResult } from './start';

/** Injectable seams for unit tests. */
export interface UiDeps {
  start(argv: string[]): Promise<StartResult>;
  openBrowser(url: string): Promise<boolean>;
}

/** Run the `ui` subcommand. */
export async function runUi(argv: string[], deps?: Partial<UiDeps>): Promise<void> {
  const start = deps?.start ?? runStart;
  const open = deps?.openBrowser ?? openBrowser;

  // Strip the ui-only flag; everything else is forwarded to `start` verbatim.
  const noOpen = argv.includes('--no-open');
  const startArgv = argv.filter((a) => a !== '--no-open');

  if (!resolveUiDist()) {
    console.warn(
      'omnicross ui: Control Panel assets not found (@omnicross/ui has no built dist). ' +
        'The daemon will still start, but /ui will 404. ' +
        'Install @omnicross/ui (or build it: npm run build -w @omnicross/ui), or set OMNICROSS_UI_DIST.',
    );
  }

  const { dashboardUrl } = await start(startArgv);
  if (!dashboardUrl) {
    console.warn('omnicross ui: the admin dashboard is disabled — no UI to open.');
    return;
  }

  const uiUrl = `${dashboardUrl}/ui/`;
  console.info(`Control Panel: ${uiUrl}`);
  if (noOpen) return;
  const launched = await open(uiUrl).catch(() => false);
  if (!launched) {
    console.info('(Could not open a browser automatically — open the URL above manually.)');
  }
}
