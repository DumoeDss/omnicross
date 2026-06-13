/**
 * external-cli-store — WRITE side of the external CLI native credential stores
 * (external-cli-sync, import + write-back).
 *
 * Counterpart of `external-cli-credentials` (the read side). The daemon only
 * ever writes a file it MANAGES: an explicit "import existing CLI login" puts
 * an `.omnicross-managed` marker (recording the owning account id) next to the
 * native store, and every subsequent successful refresh of THAT account writes
 * the rotated credential back into the file. Without the write-back, the
 * daemon's refresh would rotate the single-use refresh token and silently log
 * the user's bare CLI out — the write-back keeps both sides on the same live
 * credential.
 *
 * Safety properties:
 *  - NEVER writes without a matching marker (an unmanaged / foreign-account
 *    file is untouched);
 *  - read-then-merge: unrelated top-level keys in the native file (e.g.
 *    claude `email`, codex `OPENAI_API_KEY`) are preserved;
 *  - one-time `.omnicross-backup` of the original file before the FIRST
 *    overwrite (restorable by hand if the user wants the daemon out);
 *  - atomic write (temp file → rename) so a crash never leaves a torn file.
 *
 * The envelope shapes mirror what the CLIs themselves write — the round-trip
 * test parses a written file back through `external-cli-credentials` to keep
 * the two sides from drifting.
 *
 * @module @omnicross/daemon/ports/external-cli-store
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import type {
  ClaudeTokenConfig,
  CodexTokenConfig,
} from '@omnicross/contracts/account-tokens-types';

import { type ExternalCliProvider, externalStorePath } from './external-cli-credentials';

/** Token blocks the write-back accepts (the two external-store providers). */
export type ExternalWritableTokens = ClaudeTokenConfig | CodexTokenConfig;

/**
 * Injectable port over the external store writes (tests use an in-memory fake;
 * the store wires `realExternalCliStore`).
 */
export interface ExternalCliStorePort {
  /** The owning account id recorded by the marker, or undefined when unmanaged. */
  readMarkerAccountId(provider: ExternalCliProvider): string | undefined;
  /** Record (or move) ownership of the provider's native store to an account. */
  writeMarker(provider: ExternalCliProvider, accountId: string): void;
  /**
   * Write the refreshed tokens back into the native store — ONLY when the
   * marker names `accountId`. Returns true when a write happened.
   */
  writeBack(
    provider: ExternalCliProvider,
    accountId: string,
    tokens: ExternalWritableTokens,
  ): boolean;
}

/** Marker / backup sit next to the native store file. */
function markerPath(provider: ExternalCliProvider, home: string): string {
  return `${externalStorePath(provider, home)}.omnicross-managed`;
}

function backupPath(provider: ExternalCliProvider, home: string): string {
  return `${externalStorePath(provider, home)}.omnicross-backup`;
}

/** Build the `claudeAiOauth` envelope (ISO expiry → number ms epoch). */
export function buildClaudeOAuthEnvelope(
  tokens: ClaudeTokenConfig,
): Record<string, unknown> | null {
  if (!tokens.accessToken) return null;
  const envelope: Record<string, unknown> = { accessToken: tokens.accessToken };
  if (tokens.refreshToken) envelope.refreshToken = tokens.refreshToken;
  if (tokens.expiresAt) {
    const ms = Date.parse(tokens.expiresAt);
    if (Number.isFinite(ms)) envelope.expiresAt = ms;
  }
  if (tokens.scopes && tokens.scopes.length > 0) envelope.scopes = tokens.scopes;
  return envelope;
}

/** Build the codex `tokens` envelope (camelCase → snake_case). */
export function buildCodexTokensEnvelope(
  tokens: CodexTokenConfig,
): Record<string, unknown> | null {
  if (!tokens.accessToken && !tokens.idToken) return null;
  const envelope: Record<string, unknown> = { access_token: tokens.accessToken ?? '' };
  if (tokens.idToken) envelope.id_token = tokens.idToken;
  if (tokens.refreshToken) envelope.refresh_token = tokens.refreshToken;
  return envelope;
}

/** Tolerant read of the native store's current JSON object (absent ⇒ {}). */
function readExistingObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Atomic write: temp sibling → rename (never a torn native store). */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.omnicross-tmp`;
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, path);
}

/** The real, homedir-backed implementation. */
export function createExternalCliStore(home: string = homedir()): ExternalCliStorePort {
  return {
    readMarkerAccountId(provider) {
      const path = markerPath(provider, home);
      if (!existsSync(path)) return undefined;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { accountId?: unknown };
        return typeof parsed.accountId === 'string' && parsed.accountId
          ? parsed.accountId
          : undefined;
      } catch {
        return undefined;
      }
    },

    writeMarker(provider, accountId) {
      writeAtomic(
        markerPath(provider, home),
        JSON.stringify({ accountId, at: new Date().toISOString() }, null, 2) + '\n',
      );
    },

    writeBack(provider, accountId, tokens) {
      // Ownership gate: only the marker-named account may touch the file.
      const owner = this.readMarkerAccountId(provider);
      if (owner !== accountId) return false;

      const envelope =
        provider === 'claude'
          ? buildClaudeOAuthEnvelope(tokens as ClaudeTokenConfig)
          : buildCodexTokensEnvelope(tokens as CodexTokenConfig);
      if (!envelope) return false;

      const storePath = externalStorePath(provider, home);
      // One-time backup of the ORIGINAL file before the first overwrite.
      if (existsSync(storePath) && !existsSync(backupPath(provider, home))) {
        copyFileSync(storePath, backupPath(provider, home));
      }
      // Read-then-merge: preserve unrelated top-level keys.
      const existing = readExistingObject(storePath);
      const merged =
        provider === 'claude'
          ? { ...existing, claudeAiOauth: envelope }
          : { ...existing, tokens: envelope };
      writeAtomic(storePath, JSON.stringify(merged, null, 2) + '\n');
      return true;
    },
  };
}
