/**
 * aboutModel.ts — the pure constants + version math behind Settings → About.
 *
 * The project links and identity are compile-time constants (the repository is
 * part of the product's identity, not runtime config); the version precedence
 * is a pure function so the desktop-snapshot / daemon-health fallback order is
 * unit-testable without a browser.
 */

export const APP_NAME = 'Omnicross';
export const APP_LICENSE = 'MIT';
export const APP_AUTHOR = 'Sayo';

export const GITHUB_REPO_URL = 'https://github.com/DumoeDss/omnicross';
export const GITHUB_RELEASES_URL = 'https://github.com/DumoeDss/omnicross/releases/latest';
export const GITHUB_ISSUES_URL = 'https://github.com/DumoeDss/omnicross/issues';

/**
 * Resolve the About panel's version display. The desktop bundle version (the
 * Tauri updater snapshot) leads; the daemon `/health` version — the same
 * workspace version, released in lockstep — backs the browser UI, where the
 * updater bridge is inert. Neither known → undefined → "unknown" placeholder.
 */
export function resolveAboutVersion(
  desktopVersion: string | undefined,
  daemonVersion: string | null | undefined,
): string | undefined {
  const first = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  return first(desktopVersion) ?? first(daemonVersion ?? undefined);
}
