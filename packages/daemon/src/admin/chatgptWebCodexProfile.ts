/**
 * chatgptWebCodexProfile — the one-time codex wiring for the ChatGPT Web
 * bridge: a persistent bridge token, a managed `[profiles.chatgptweb]` +
 * provider section in ~/.codex/config.toml, and the token as a user-level
 * environment variable (codex providers authenticate via env_key only).
 *
 * The user's existing codex config is never touched beyond our two managed
 * sections — the native OpenAI route keeps working exactly as before.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const CODEX_PROFILE_NAME = 'chatgptweb';
export const CODEX_PROVIDER_NAME = 'omnicross-chatgptweb';
export const CODEX_TOKEN_ENV = 'OMNICROSS_CHATGPT_WEB_TOKEN';
const MANAGED_MARKER = '# --- omnicross-chatgpt-web (managed) ---';

export interface CodexProfileInput {
  /** Bridge base URL including the /v1 suffix. */
  baseUrl: string;
  /** Default model the profile selects (overridable with -m). */
  model: string;
  /** The env var codex reads the bridge token from. */
  envKey?: string;
}

export interface CodexProfileResult {
  token: string;
  profileName: string;
  /** Null when the platform can't set a user-level env var from here. */
  envVarWritten: boolean;
}

function codexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

/**
 * The bridge's persistent auth token. Generated once, stored under the
 * feature's data dir — a profile baked into codex's config must survive
 * bridge restarts, so per-start random tokens would not do.
 */
export function ensureBridgeToken(dataDir: string): string {
  const file = join(dataDir, 'bridge-token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{48}$/.test(existing)) return existing;
  } catch {
    // Not there yet — mint one.
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, `${token}\n`);
  return token;
}

function renderSection(header: string, entries: Array<[string, string]>): string[] {
  return [header, ...entries.map(([key, value]) => `${key} = ${JSON.stringify(value)}`)];
}

/**
 * Idempotently upsert our two managed sections into a codex config.toml.
 * Only the `[model_providers.omnicross-chatgptweb]` and
 * `[profiles.chatgptweb]` tables are ever replaced; everything else passes
 * through byte-for-byte. Pure — no filesystem access.
 */
export function upsertManagedCodexSections(text: string, input: CodexProfileInput): string {
  const envKey = input.envKey ?? CODEX_TOKEN_ENV;
  const providerHeader = `[model_providers.${CODEX_PROVIDER_NAME}]`;
  const profileHeader = `[profiles.${CODEX_PROFILE_NAME}]`;
  const sections = new Map<string, string[]>([
    [
      providerHeader,
      renderSection(providerHeader, [
        ['name', 'OmniCross ChatGPT Web (experimental)'],
        ['base_url', input.baseUrl],
        ['wire_api', 'responses'],
        ['env_key', envKey],
      ]),
    ],
    [
      profileHeader,
      renderSection(profileHeader, [
        ['model', input.model],
        ['model_provider', CODEX_PROVIDER_NAME],
      ]),
    ],
  ]);

  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  // Drop a trailing empty element produced by the final newline; re-added at
  // the end so we normalize nothing about the middle of the file.
  if (lines[lines.length - 1] === '') lines.pop();

  const isTableHeader = (line: string) => /^\s*\[/.test(line);

  const output: string[] = [];
  const replaced = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = line.trim();
    if (sections.has(header)) {
      // Replace the whole existing section (header through the line before
      // the next table header) with the fresh body.
      let end = index + 1;
      while (end < lines.length && !isTableHeader(lines[end])) end += 1;
      output.push(...sections.get(header)!);
      replaced.add(header);
      index = end - 1;
      continue;
    }
    output.push(line);
  }

  if (replaced.size < sections.size) {
    if (!output.includes(MANAGED_MARKER)) output.push(MANAGED_MARKER);
    for (const [header, body] of sections) {
      if (!replaced.has(header)) output.push('', ...body);
    }
  }

  const result = output.join('\n');
  return hadTrailingNewline || result.length > 0 ? `${result}\n` : result;
}

/** Whether both managed sections are present in the live config. */
export function codexProfileInstalled(): boolean {
  try {
    const text = readFileSync(codexConfigPath(), 'utf8');
    return text.includes(`[model_providers.${CODEX_PROVIDER_NAME}]`) && text.includes(`[profiles.${CODEX_PROFILE_NAME}]`);
  } catch {
    return false;
  }
}

/** Set the token as a user-level env var so plain `codex --profile` works. */
function setUserEnvToken(token: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    spawn('setx', [CODEX_TOKEN_ENV, token], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The one-shot wiring: persistent token → managed config sections → user
 * env var. Returns what the UI needs to tell the user.
 */
export function writeCodexProfile(dataDir: string, input: CodexProfileInput): CodexProfileResult {
  const token = ensureBridgeToken(dataDir);
  const configPath = codexConfigPath();
  mkdirSync(join(homedir(), '.codex'), { recursive: true });
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  writeFileSync(configPath, upsertManagedCodexSections(current, input));
  const envVarWritten = setUserEnvToken(token);
  return { token, profileName: CODEX_PROFILE_NAME, envVarWritten };
}
