/**
 * commands/secrets.ts — `omnicross secrets encrypt|status|rotate|decrypt`.
 *
 * The at-rest encryption command family (secrets design D6). All actions operate
 * on a `config.json` AND its sibling `tokens.json` (when present), reusing the
 * daemon's master-key resolution (env → keyfile → auto-gen 0600) so they work
 * OFFLINE (no running daemon):
 *
 *   secrets encrypt  --config <p>   → re-encrypt every secret field in place.
 *   secrets status   --config <p>   → per-field classification (plaintext /
 *                                     encrypted / env-ref) + last-4 mask ONLY.
 *   secrets rotate    --config <p> [--new-master-key-file <p>]
 *                                   → decrypt with the OLD key, re-seal with NEW.
 *   secrets decrypt   --config <p> --force
 *                                   → restore plaintext (HIDDEN footgun; requires
 *                                     --force + prints a stderr warning).
 *
 * SECRET HYGIENE: `status` NEVER prints a full secret value or an `enc:`
 * envelope — only the classification + a last-4 mask (literals) / `$ENV(•••)`
 * (env refs). No command logs key material.
 *
 * @module @omnicross/daemon/commands/secrets
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { maskProviderApiKey } from '../admin/adminApi';
import {
  type DaemonConfig,
  loadConfig,
  saveConfig,
  setSecretBox,
  validateConfig,
} from '../config';
import { encryptTokens, isEnvelope, type SecretBox } from '../secrets';

import { defaultTokensPath, resolveSecretBox } from './paths';

/** The parsed `secrets` flags (every action shares this surface). */
interface SecretsArgs {
  config: string | undefined;
  masterKeyFile: string | undefined;
  newMasterKeyFile: string | undefined;
  force: boolean;
}

/** Run the `secrets` subcommand. `argv` is everything after `secrets`. */
export async function runSecrets(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      'master-key-file': { type: 'string' },
      'new-master-key-file': { type: 'string' },
      force: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const args: SecretsArgs = {
    config: values.config,
    masterKeyFile: values['master-key-file'],
    newMasterKeyFile: values['new-master-key-file'],
    force: values.force === true,
  };
  if (!args.config) {
    throw new Error('secrets: --config <path> is required');
  }

  const action = positionals[0];
  switch (action) {
    case 'encrypt':
      return secretsEncrypt(args);
    case 'status':
      return secretsStatus(args);
    case 'rotate':
      return secretsRotate(args);
    case 'decrypt':
      return secretsDecrypt(args);
    default:
      throw new Error(
        `secrets: unknown action '${action ?? ''}' (expected encrypt|status|rotate)`,
      );
  }
}

// ── encrypt ───────────────────────────────────────────────────────────────────

/**
 * `secrets encrypt` — load (decrypting legacy `enc:` + passing plaintext
 * through) then save (encrypt-on-write re-seals EVERY secret). Idempotent:
 * already-encrypted files re-seal with fresh IVs; `$ENV` refs stay literal.
 */
function secretsEncrypt(args: SecretsArgs): void {
  const box = resolveSecretBox(args.masterKeyFile);
  setSecretBox(box);
  try {
    const cfg = loadConfig(args.config as string);
    saveConfig(args.config as string, cfg);
    encryptTokensFileInPlace(args.config as string, box);
  } finally {
    setSecretBox(null);
  }
  console.info(`Encrypted secrets in ${args.config}` + tokensSuffix(args.config as string));
}

// ── status ──────────────────────────────────────────────────────────────────

/** A field's tri-state classification (never the value). */
type Classification = 'encrypted' | 'env-ref' | 'plaintext';

/** Classify a raw on-disk value WITHOUT decrypting it (status never decrypts). */
function classify(raw: string): Classification {
  if (raw.startsWith('$')) return 'env-ref';
  if (isEnvelope(raw)) return 'encrypted';
  return 'plaintext';
}

/**
 * A safe display for `status`: encrypted → `[encrypted]`, env-ref →
 * `$ENV(•••)`, plaintext → last-4 mask (`maskProviderApiKey`). NEVER the full
 * value or the envelope body.
 */
function safeDisplay(raw: string, cls: Classification): string {
  if (cls === 'encrypted') return '[encrypted]';
  return maskProviderApiKey(raw); // handles $ENV(•••) + sk-…last4
}

/**
 * `secrets status` — read the file RAW (no box, no decrypt) and report each
 * secret field's classification + a safe mask. Emits NO full value or envelope.
 */
function secretsStatus(args: SecretsArgs): void {
  const cfg = readRawConfig(args.config as string);
  console.info(`Secret status for ${args.config}:`);
  for (const p of cfg.providers) {
    reportField(`provider '${p.id}'.apiKey`, p.apiKey);
    for (const k of p.apiKeys ?? []) {
      reportField(`provider '${p.id}'.apiKeys['${k.id}']`, k.apiKey);
    }
  }
  if (cfg.admin && typeof cfg.admin.token === 'string' && cfg.admin.token.length > 0) {
    reportField('admin.token', cfg.admin.token);
  }

  const tokensPath = defaultTokensPath(args.config as string);
  if (existsSync(tokensPath)) {
    console.info(`Secret status for ${tokensPath}:`);
    reportTokenFields(tokensPath);
  }
}

/** Print one field's `name: classification mask` line (secret-free). */
function reportField(name: string, raw: string): void {
  const cls = classify(raw);
  console.info(`  ${name}: ${cls}  ${safeDisplay(raw, cls)}`);
}

/** Report each token-material field's classification from a raw tokens.json. */
function reportTokenFields(tokensPath: string): void {
  const parsed = readRawJson(tokensPath);
  const blocks: Record<string, readonly string[]> = {
    claude: ['accessToken', 'refreshToken'],
    codex: ['accessToken', 'refreshToken', 'idToken'],
    gemini: ['accessToken', 'refreshToken'],
    opencodego: ['apiKey'],
  };
  for (const [provider, fields] of Object.entries(blocks)) {
    const block = parsed[provider];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const field of fields) {
      const value = (block as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.length > 0) {
        reportField(`${provider}.${field}`, value);
      }
    }
  }
}

// ── rotate ────────────────────────────────────────────────────────────────────

/**
 * `secrets rotate` — decrypt all envelopes with the OLD master key, then re-seal
 * with the NEW key (`--new-master-key-file`). Load with the old box, save with
 * the new box. Requires a `--new-master-key-file` (otherwise it would re-seal
 * with the same key — a no-op rotate is rejected to avoid surprise).
 */
function secretsRotate(args: SecretsArgs): void {
  if (!args.newMasterKeyFile) {
    throw new Error('secrets rotate: --new-master-key-file <path> is required');
  }
  const oldBox = resolveSecretBox(args.masterKeyFile);
  const newBox = resolveSecretBox(args.newMasterKeyFile);

  // Decrypt the whole file with the OLD box.
  setSecretBox(oldBox);
  let cfg: DaemonConfig;
  let tokensPlain: ReturnType<typeof readRawJson> | null = null;
  const tokensPath = defaultTokensPath(args.config as string);
  try {
    cfg = loadConfig(args.config as string);
    if (existsSync(tokensPath)) tokensPlain = decryptTokensFile(tokensPath, oldBox);
  } finally {
    setSecretBox(null);
  }

  // Re-seal with the NEW box.
  setSecretBox(newBox);
  try {
    saveConfig(args.config as string, cfg);
    if (tokensPlain) writeTokensEncrypted(tokensPath, tokensPlain, newBox);
  } finally {
    setSecretBox(null);
  }
  console.info(`Rotated master key for ${args.config}` + tokensSuffix(args.config as string));
}

// ── decrypt (hidden footgun) ────────────────────────────────────────────────

/**
 * `secrets decrypt --force` — restore plaintext in place (load with the box,
 * save with NO box). HIDDEN from the main --help (single-direction design); the
 * `--force` flag + a loud stderr warning are mandatory.
 */
function secretsDecrypt(args: SecretsArgs): void {
  if (!args.force) {
    throw new Error(
      'secrets decrypt: refusing without --force (this writes plaintext secrets to disk)',
    );
  }
  console.error(
    'WARNING: secrets decrypt --force writes ALL secrets back to PLAINTEXT on disk. ' +
      'Only use this to roll back to an older daemon. The file will no longer be encrypted.',
  );
  const box = resolveSecretBox(args.masterKeyFile);
  const tokensPath = defaultTokensPath(args.config as string);

  setSecretBox(box);
  let cfg: DaemonConfig;
  let tokensPlain: ReturnType<typeof readRawJson> | null = null;
  try {
    cfg = loadConfig(args.config as string);
    if (existsSync(tokensPath)) tokensPlain = decryptTokensFile(tokensPath, box);
  } finally {
    setSecretBox(null);
  }

  // Save with NO box → plaintext on disk.
  saveConfig(args.config as string, cfg);
  if (tokensPlain) {
    writeFileSync(tokensPath, JSON.stringify(tokensPlain, null, 2) + '\n', 'utf8');
  }
  console.info(`Decrypted secrets to plaintext in ${args.config}` + tokensSuffix(args.config as string));
}

// ── shared helpers ──────────────────────────────────────────────────────────

/** Read + validate a config.json WITHOUT any box (raw on-disk values kept). */
function readRawConfig(path: string): DaemonConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`secrets: cannot read or parse '${path}'`);
  }
  return validateConfig(parsed);
}

/** Read + parse a JSON object file (tokens.json), tolerating absence/corruption. */
function readRawJson(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/** Encrypt a tokens.json file in place (read raw → encrypt-on-write). */
function encryptTokensFileInPlace(configPath: string, box: SecretBox): void {
  const tokensPath = defaultTokensPath(configPath);
  if (!existsSync(tokensPath)) return;
  // Decrypt-then-encrypt so any legacy/mixed file re-seals uniformly.
  const plain = decryptTokensFile(tokensPath, box);
  writeTokensEncrypted(tokensPath, plain, box);
}

/** Read a tokens.json and return it with token fields DECRYPTED (plaintext). */
function decryptTokensFile(tokensPath: string, box: SecretBox): Record<string, unknown> {
  const raw = readRawJson(tokensPath);
  return walkTokens(raw, (v) => box.decryptMaybe(v));
}

/** Write a tokens.json with token fields ENCRYPTED (uses the shared selector). */
function writeTokensEncrypted(
  tokensPath: string,
  plain: Record<string, unknown>,
  box: SecretBox,
): void {
  // `encryptTokens` expects an AccountTokensConfig shape; the raw object is
  // structurally compatible (extra fields pass through untouched).
  const encrypted = encryptTokens(
    { updatedAt: '', ...(plain as object) } as never,
    box,
  ) as unknown as Record<string, unknown>;
  writeFileSync(tokensPath, JSON.stringify(encrypted, null, 2) + '\n', 'utf8');
}

/** The token-material fields per provider block (mirrors secretFields). */
const TOKEN_FIELDS: Record<string, readonly string[]> = {
  claude: ['accessToken', 'refreshToken'],
  codex: ['accessToken', 'refreshToken', 'idToken'],
  gemini: ['accessToken', 'refreshToken'],
  opencodego: ['apiKey'],
};

/** Apply a transform to every token-material field of a raw object (new object). */
function walkTokens(
  raw: Record<string, unknown>,
  fn: (v: string) => string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  for (const [provider, fields] of Object.entries(TOKEN_FIELDS)) {
    const block = next[provider];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const nextBlock: Record<string, unknown> = { ...(block as Record<string, unknown>) };
    for (const field of fields) {
      const value = nextBlock[field];
      if (typeof value === 'string' && value.length > 0) nextBlock[field] = fn(value);
    }
    next[provider] = nextBlock;
  }
  return next;
}

/** " + tokens.json" suffix when a sibling tokens.json exists (else ""). */
function tokensSuffix(configPath: string): string {
  return existsSync(defaultTokensPath(configPath)) ? ' (+ tokens.json)' : '';
}
