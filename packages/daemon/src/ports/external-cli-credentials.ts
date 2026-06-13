/**
 * external-cli-credentials — read-only access to the external CLI native
 * credential stores (external-cli-sync).
 *
 * The daemon never WRITES these files (they belong to the CLIs); it only reads
 * them back to (a) recover from the rotating-refresh-token race — when e.g.
 * Claude Code refreshes `~/.claude/.credentials.json` it rotates OUR stored
 * refresh token out from under us, and the external file then holds the only
 * live credential — and (b) detect divergence for the account-list warning.
 *
 * File shapes (mirrors the shapes the CLIs themselves write):
 *   claude `~/.claude/.credentials.json`
 *     → `{ claudeAiOauth: { accessToken, refreshToken?, expiresAt(number ms),
 *          scopes? } }`
 *   codex `~/.codex/auth.json`
 *     → `{ tokens: { id_token?, access_token, refresh_token? } }` — no explicit
 *       expiry; the access token's JWT `exp` claim is the only expiry signal.
 *
 * Gemini is deliberately excluded: the gemini CLI's oauth store is not a
 * supported import source (parity with the host app's external-sync scope).
 *
 * @module @omnicross/daemon/ports/external-cli-credentials
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The two external CLI providers with a readable native store. */
export type ExternalCliProvider = 'claude' | 'codex';

/**
 * External credentials parsed OUT of a native store file. Field axes match the
 * internal `*TokenConfig` shapes: `expiresAt` is an ISO STRING here (converted
 * from the native ms number / codex JWT `exp`).
 */
export interface ExternalCliCredentials {
  accessToken?: string;
  refreshToken?: string;
  /** ISO string. */
  expiresAt?: string;
  /** codex only. */
  idToken?: string;
  /** claude only. */
  scopes?: string[];
}

/** Reader port — injectable so tests never touch the real home directory. */
export type ExternalCliReader = (provider: ExternalCliProvider) => ExternalCliCredentials | null;

/** Absolute path to a provider's native credential store. */
export function externalStorePath(provider: ExternalCliProvider, home: string = homedir()): string {
  return provider === 'claude'
    ? join(home, '.claude', '.credentials.json')
    : join(home, '.codex', 'auth.json');
}

/**
 * Best-effort decode of a JWT's `exp` claim → ms since epoch. Defensive: any
 * malformed input → undefined.
 */
export function decodeJwtExpiryMs(token: string): number | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof decoded.exp === 'number' && Number.isFinite(decoded.exp)) {
      return decoded.exp * 1000;
    }
  } catch {
    /* not a JWT / malformed payload */
  }
  return undefined;
}

/** Parse the `claudeAiOauth` envelope out of a parsed `.credentials.json`. */
export function parseClaudeOAuthEnvelope(
  raw: Record<string, unknown> | undefined,
): ExternalCliCredentials | null {
  const oauth = raw?.claudeAiOauth as
    | { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; scopes?: unknown }
    | undefined;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;

  const parsed: ExternalCliCredentials = { accessToken: oauth.accessToken };
  if (typeof oauth.refreshToken === 'string' && oauth.refreshToken) {
    parsed.refreshToken = oauth.refreshToken;
  }
  // Number ms epoch → ISO string (the internal axis). Non-finite ⇒ omitted.
  if (typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)) {
    parsed.expiresAt = new Date(oauth.expiresAt).toISOString();
  }
  if (Array.isArray(oauth.scopes) && oauth.scopes.every((s) => typeof s === 'string')) {
    parsed.scopes = oauth.scopes as string[];
  }
  return parsed;
}

/** Parse the `tokens` envelope out of a parsed codex `auth.json` (snake_case). */
export function parseCodexTokensEnvelope(
  raw: Record<string, unknown> | undefined,
): ExternalCliCredentials | null {
  const tokens = raw?.tokens as
    | { id_token?: unknown; access_token?: unknown; refresh_token?: unknown }
    | undefined;
  if (!tokens) return null;

  const accessToken =
    typeof tokens.access_token === 'string' && tokens.access_token
      ? tokens.access_token
      : undefined;
  const idToken =
    typeof tokens.id_token === 'string' && tokens.id_token ? tokens.id_token : undefined;
  if (!accessToken && !idToken) return null;

  const parsed: ExternalCliCredentials = {};
  if (accessToken) {
    parsed.accessToken = accessToken;
    const expMs = decodeJwtExpiryMs(accessToken);
    if (expMs !== undefined) parsed.expiresAt = new Date(expMs).toISOString();
  }
  if (idToken) parsed.idToken = idToken;
  if (typeof tokens.refresh_token === 'string' && tokens.refresh_token) {
    parsed.refreshToken = tokens.refresh_token;
  }
  return parsed;
}

/**
 * Default reader: read + parse one provider's native store. Tolerates an
 * absent / unreadable / malformed file by returning `null` (nothing to sync).
 */
export function readExternalCliCredentials(
  provider: ExternalCliProvider,
  home: string = homedir(),
): ExternalCliCredentials | null {
  const path = externalStorePath(provider, home);
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    raw =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
  } catch {
    return null;
  }
  return provider === 'claude' ? parseClaudeOAuthEnvelope(raw) : parseCodexTokensEnvelope(raw);
}
