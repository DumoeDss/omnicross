/**
 * chatgptWebCodexProfile — the one-time codex wiring for the ChatGPT Web
 * bridge: a persistent bridge token, a managed `[profiles.chatgptweb]` +
 * provider section in ~/.codex/config.toml, and the token as a user-level
 * environment variable (codex providers authenticate via env_key only).
 *
 * ask_pro mode additionally manages an `[mcp_servers.omnicross-chatgptweb-pro]`
 * section pointing at a STABLE copy of the ask-pro stdio server
 * (~/.omnicross/chatgpt-web/ask-pro/server.mjs) — a copy, not a reference into
 * the app's dist, because desktop-app updates move the daemon-runtime
 * directory and a baked dist path would silently rot. The server's module
 * graph is copied wholesale (its entry imports siblings like askProCore.js),
 * and the install self-verifies by importing the copy.
 *
 * The user's existing codex config is never touched beyond our managed
 * sections — the native OpenAI route keeps working exactly as before.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveAskProServerEntry } from '@omnicross/chatgpt-web/askpro/askProServer';

export const CODEX_PROFILE_NAME = 'chatgptweb';
export const CODEX_PROVIDER_NAME = 'omnicross-chatgptweb';
export const CODEX_TOKEN_ENV = 'OMNICROSS_CHATGPT_WEB_TOKEN';
/** codex mcp_servers key for the ask_pro advisor (codex loads these for EVERY session — always opt-in). */
export const CODEX_ASK_PRO_MCP_NAME = 'omnicross-chatgptweb-pro';
const MANAGED_MARKER = '# --- omnicross-chatgpt-web (managed) ---';
const ASK_PRO_HEADER = `[mcp_servers.${CODEX_ASK_PRO_MCP_NAME}]`;
/** ask_pro consults run full Pro browser turns; the internal deadline is 600s, keep codex's client timeout just above it. */
export const ASK_PRO_TOOL_TIMEOUT_SEC = 660;

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

// --- managed-section engine (shared by the profile and ask-pro sections) -------

function renderSection(header: string, entries: Array<[string, string]>): string[] {
  return [header, ...entries.map(([key, value]) => `${key} = ${JSON.stringify(value)}`)];
}

/**
 * Idempotently upsert managed TOML table sections. Existing sections are
 * replaced whole (header through the line before the next table header);
 * absent ones are appended behind the marker comment. Everything else passes
 * through byte-for-byte. Pure — no filesystem access.
 */
function upsertManagedSections(text: string, sections: Map<string, string[]>, marker: string): string {
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
    if (!output.includes(marker)) output.push(marker);
    for (const [header, body] of sections) {
      if (!replaced.has(header)) output.push('', ...body);
    }
  }

  const result = output.join('\n');
  return hadTrailingNewline || result.length > 0 ? `${result}\n` : result;
}

/** Remove one managed section (header through the line before the next table header). Pure. */
function removeManagedSection(text: string, header: string): string {
  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();

  const isTableHeader = (line: string) => /^\s*\[/.test(line);
  const output: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === header) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (isTableHeader(line)) {
        skipping = false;
      } else {
        continue;
      }
    }
    output.push(line);
  }
  while (output.length > 0 && output[output.length - 1] === '') output.pop();

  const result = output.join('\n');
  return result.length > 0 ? `${result}\n` : '';
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
  return upsertManagedSections(
    text,
    new Map<string, string[]>([
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
    ]),
    MANAGED_MARKER,
  );
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

// --- ask_pro managed section ----------------------------------------------------

export interface CodexAskProSectionInput {
  /** Absolute path of the installed stable server entry (server.mjs). */
  entryFile: string;
  /** Executable codex spawns (default 'node'; resolves via PATH like codex itself). */
  command?: string;
  bridgeBaseUrl?: string;
  model?: string;
  writable?: boolean;
  toolTimeoutSec?: number;
}

/** The argv codex spawns the ask-pro server with. */
export function askProMcpArgs(input: CodexAskProSectionInput): string[] {
  return [
    input.entryFile,
    `--bridge-base-url=${input.bridgeBaseUrl ?? 'http://127.0.0.1:17850'}`,
    `--model=${input.model ?? 'chatgpt-web/pro'}`,
    ...(input.writable === true ? ['--writable'] : []),
  ];
}

function renderAskProSection(input: CodexAskProSectionInput): string[] {
  const args = askProMcpArgs(input);
  return [
    ASK_PRO_HEADER,
    `command = ${JSON.stringify(input.command ?? 'node')}`,
    `args = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    `tool_timeout_sec = ${input.toolTimeoutSec ?? ASK_PRO_TOOL_TIMEOUT_SEC}`,
  ];
}

/** Idempotently upsert ONLY the ask-pro mcp_servers section. Pure. */
export function upsertManagedCodexAskProSection(text: string, input: CodexAskProSectionInput): string {
  return upsertManagedSections(text, new Map([[ASK_PRO_HEADER, renderAskProSection(input)]]), MANAGED_MARKER);
}

/** Remove the ask-pro mcp_servers section. Pure; absent section is a no-op. */
export function removeManagedCodexAskProSection(text: string): string {
  return removeManagedSection(text, ASK_PRO_HEADER);
}

/** Whether the ask-pro mcp_servers section is present in the live config. */
export function askProMcpInstalled(): boolean {
  try {
    return readFileSync(codexConfigPath(), 'utf8').includes(ASK_PRO_HEADER);
  } catch {
    return false;
  }
}

// --- ask_pro install glue ---------------------------------------------------------

export function askProInstalledEntryFile(dataDir: string): string {
  return join(dataDir, 'ask-pro', 'server.mjs');
}

export interface AskProInstallResult {
  entryFile: string;
  command: string;
  args: string[];
  configPath: string;
  toolTimeoutSec: number;
}

/**
 * Copy the built ask-pro server into its stable location and register the
 * managed mcp_servers section. The build keeps askProServer.js
 * self-contained (see tsup.config.ts), so a single-file copy suffices; the
 * copy is verified by importing it (the entry guard means the import runs no
 * code) — a broken module graph fails the install instead of rotting
 * silently in codex's config.
 */
export async function installAskProServer(
  dataDir: string,
  overrides: { model?: string; writable?: boolean } = {},
): Promise<AskProInstallResult> {
  const builtEntry = resolveAskProServerEntry();
  if (!builtEntry || !existsSync(builtEntry)) {
    throw new Error('ask-pro server entry not found — build @omnicross/chatgpt-web first.');
  }
  const askProDir = join(dataDir, 'ask-pro');
  mkdirSync(askProDir, { recursive: true });
  const entryFile = askProInstalledEntryFile(dataDir);
  copyFileSync(builtEntry, entryFile);
  await import(pathToFileURL(entryFile).href);

  const input: CodexAskProSectionInput = {
    entryFile,
    command: 'node',
    model: overrides.model ?? 'chatgpt-web/pro',
    writable: overrides.writable === true,
  };
  const configPath = codexConfigPath();
  mkdirSync(join(homedir(), '.codex'), { recursive: true });
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  writeFileSync(configPath, upsertManagedCodexAskProSection(current, input));
  return {
    entryFile,
    command: input.command ?? 'node',
    args: askProMcpArgs(input),
    configPath,
    toolTimeoutSec: input.toolTimeoutSec ?? ASK_PRO_TOOL_TIMEOUT_SEC,
  };
}

/** Remove the managed mcp_servers section and the stable server copy. */
export function uninstallAskProServer(dataDir: string): { configPath: string; removedEntry: boolean } {
  const configPath = codexConfigPath();
  if (existsSync(configPath)) {
    const current = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, removeManagedCodexAskProSection(current));
  }
  const askProDir = join(dataDir, 'ask-pro');
  const removedEntry = existsSync(askProInstalledEntryFile(dataDir));
  if (existsSync(askProDir) && statSync(askProDir).isDirectory()) {
    rmSync(askProDir, { recursive: true, force: true });
  }
  return { configPath, removedEntry };
}

// --- user env var ------------------------------------------------------------------

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
