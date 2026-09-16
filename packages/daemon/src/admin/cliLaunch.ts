/**
 * cliLaunch — the admin API's "launch a coding CLI in a terminal, pointed at the
 * daemon" surface (dashboard parity with the desktop app's Code CLI tab).
 *
 * This is the EXTERNAL-terminal analogue of `commands/launch.ts`: it reuses the
 * same `@omnicross/cli-launcher` builders (which register one route on the
 * RESIDENT `ProviderProxy` and return the redirect env — `ANTHROPIC_BASE_URL` +
 * a one-shot ROUTE token, codex's `-c base_url=…` overrides, etc.), then opens a
 * NEW terminal window running the CLI with that env injected. The route token —
 * NOT an upstream credential — is the only secret in the env; it is removed when
 * the session is stopped (`onSessionEnd`).
 *
 * SECRET DISCIPLINE: the env carries a route token (proxy-scoped, revocable),
 * never a provider key. On win32 the token rides the spawned process environment
 * (inherited by the terminal), never the command line / a file on disk.
 *
 * KEY-SCOPED LAUNCH (`{ keyId }` body, codex + claude): instead of a route
 * lease, the terminal's CLI authenticates to the RESIDENT outbound gateway as
 * ONE chosen access key, so routing follows that key's gateway bindings.
 * Concurrent terminals can then use different keys (hence different upstreams)
 * at once. Codex redirects via `-c` overrides reusing the INSTALLED provider
 * name (`omnicross`) plus a `--key-id`-scoped auth command — no secret enters
 * the spawned env (Codex invokes the helper itself). Claude Code redirects via
 * env (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`), the only per-launch
 * channel it offers.
 *
 * ROUTE-SCOPED LAUNCH (`{ bindingId }` body, codex + claude): pick a
 * downstream ROUTE by id; the daemon picks an eligible key that can enter it
 * (or honors an explicit `keyId`) and adds `x-omnicross-binding-id` to the
 * client's request headers (Codex provider `http_headers`; Claude Code
 * `ANTHROPIC_CUSTOM_HEADERS`, ≥ v2.1.227), so the gateway serves that terminal
 * from exactly the chosen route instead of the key's priority-ordered
 * candidates.
 *
 * @module @omnicross/daemon/admin/cliLaunch
 */

import { exec, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  buildChatCliLaunchConfig,
  buildClaudeCliLaunchConfig,
  buildCodexLaunchConfig,
  buildGeminiCliLaunchConfig,
  CODEX_PROXY_PROVIDER_NAME,
  type ChatCliBackendId,
  type ChatCliLaunchConfig,
} from '@omnicross/cli-launcher';
import type { ProviderConfigSource } from '@omnicross/core';
import {
  ROUTE_LEASE_REQUEST_SCHEMA,
  RouteLeaseError,
  type RouteLeaseManager,
} from '@omnicross/core/provider-proxy';
import {
  candidateGatewayBindings,
  effectivePermissionsForRow,
  GATEWAY_BINDING_PIN_HEADER,
  type GatewayBinding,
  type OutboundKeyDb,
  type OutboundEndpoint,
  type OutboundPermission,
} from '@omnicross/core/outbound-api';

import type { CodexAuthHelperConfig } from '../integrations/codexAuthHelper';
import { CLAUDE_API_KEY_SENTINEL } from '../integrations/configAdapters';
import { startTerminalLeaseRenewal } from '../routeLeaseRenewal';


/** The CLIs the dashboard can launch (one per cli-launcher builder). */
export const LAUNCHABLE_CLIS = [
  { id: 'claude', displayName: 'Claude Code', command: 'claude' },
  { id: 'codex', displayName: 'Codex CLI', command: 'codex' },
  { id: 'gemini', displayName: 'Gemini CLI', command: 'gemini' },
  { id: 'qwen', displayName: 'Qwen Code', command: 'qwen' },
  { id: 'copilot', displayName: 'GitHub Copilot CLI', command: 'copilot' },
  { id: 'opencode', displayName: 'OpenCode', command: 'opencode' },
] as const;

export type LaunchCliId = (typeof LAUNCHABLE_CLIS)[number]['id'];

/**
 * CLIs the dashboard tracks for INSTALL/UPGRADE only — no cli-launcher builder
 * speaks their env contract yet, so the Launch button stays hidden for them.
 */
export const INSTALL_ONLY_CLIS = [
  { id: 'grok', displayName: 'Grok Build', command: 'grok' },
  { id: 'openclaw', displayName: 'OpenClaw', command: 'openclaw' },
  { id: 'hermes', displayName: 'Hermes Agent', command: 'hermes' },
  { id: 'pi', displayName: 'Pi Coding Agent', command: 'pi' },
] as const;

/** Every CLI the dashboard lists (launchable + install-only). */
export const TRACKED_CLIS = [...LAUNCHABLE_CLIS, ...INSTALL_ONLY_CLIS] as const;

export type TrackedCliId = (typeof TRACKED_CLIS)[number]['id'];

/**
 * Per-CLI global install command (run on the daemon host). CLIs absent from this
 * map are manual-install only — the dashboard hides the Install button for them.
 * `Partial` keeps the absence meaningful even though every tracked CLI currently
 * has one.
 */
export const INSTALL_COMMANDS: Partial<Record<TrackedCliId, string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  qwen: 'npm install -g @qwen-code/qwen-code',
  copilot: 'npm install -g @github/copilot',
  opencode: 'npm install -g opencode-ai',
  grok: 'npm install -g @xai-official/grok',
  openclaw: 'npm install -g openclaw',
  // Hermes has no npm package — its vendor installer is a PowerShell script
  // (stored decoded: `irm <url> | iex`), so this entry is Windows-only.
  hermes: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex"',
  pi: 'npm install -g @earendil-works/pi-coding-agent',
};

/** Install commands that only exist for Windows hosts (no POSIX equivalent). */
const WINDOWS_ONLY_INSTALLS = new Set<string>(['hermes']);

const LAUNCHABLE_IDS = new Set<string>(LAUNCHABLE_CLIS.map((c) => c.id));
export function isLaunchCliId(id: string | undefined): id is LaunchCliId {
  return id !== undefined && LAUNCHABLE_IDS.has(id);
}

const TRACKED_IDS = new Set<string>(TRACKED_CLIS.map((c) => c.id));
export function isTrackedCliId(id: string | undefined): id is TrackedCliId {
  return id !== undefined && TRACKED_IDS.has(id);
}

/** The install command for this CLI on this platform, or null (manual only). */
export function installCommandFor(
  cli: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const cmd = INSTALL_COMMANDS[cli as TrackedCliId];
  if (!cmd) return null;
  if (WINDOWS_ONLY_INSTALLS.has(cli) && platform !== 'win32') return null;
  return cmd;
}

/** The npm package name behind a CLI's install command, or null (non-npm). */
export function npmPackageFor(cli: string): string | null {
  const cmd = INSTALL_COMMANDS[cli as TrackedCliId];
  if (!cmd || !cmd.startsWith('npm ')) return null;
  const token = cmd.split(/\s+/).pop();
  // Filter the fixed verb flags, keeping only the package operand.
  return token && !token.startsWith('-') ? token : null;
}

/**
 * The upgrade command: npm-installed CLIs pin `@latest`; script installers are
 * simply re-run (Hermes' installer refreshes in place).
 */
export function upgradeCommandFor(
  cli: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const install = installCommandFor(cli, platform);
  if (!install) return null;
  const pkg = npmPackageFor(cli);
  return pkg ? `npm install -g ${pkg}@latest` : install;
}

/** Injectable PATH probe (tests stub this; default scans `process.env.PATH`). */
export type PathProbe = (candidate: string) => string | null;

function probeDefault(candidate: string): string | null {
  const segments = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const seg of segments) {
    const full = join(seg, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Is the CLI's binary resolvable on PATH (platform-aware extensions)? */
export function isCliInstalled(
  command: string,
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
): boolean {
  if (platform === 'win32') {
    return Boolean(probe(`${command}.exe`) || probe(`${command}.cmd`) || probe(`${command}.bat`));
  }
  return Boolean(probe(command));
}

/** One row of the CLI availability list. */
export interface CliStatus {
  id: TrackedCliId;
  displayName: string;
  command: string;
  installed: boolean;
  /** Has a known global install command (dashboard shows an Install button). */
  installable: boolean;
  /** Has a cli-launcher builder (dashboard shows a Launch button). */
  launchable: boolean;
}

export function detectClis(
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
): CliStatus[] {
  return TRACKED_CLIS.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    command: c.command,
    installed: isCliInstalled(c.command, platform, probe),
    installable: installCommandFor(c.id, platform) !== null,
    launchable: isLaunchCliId(c.id),
  }));
}

/** Pick the provider+model a launch routes through (explicit, else first enabled). */
export interface LaunchTarget {
  providerId: string;
  model: string;
}

interface ProviderRowLike {
  id: string;
  enabled?: boolean;
  models?: string[];
  modelConfigs?: Array<{ id: string }>;
}

/** Resolve the launch target from the provider catalog (throws if none usable). */
export function resolveLaunchTarget(
  providers: ProviderRowLike[],
  requested?: { providerId?: string; model?: string },
): LaunchTarget {
  const pick =
    (requested?.providerId
      ? providers.find((p) => p.id === requested.providerId)
      : undefined) ??
    providers.find((p) => p.enabled !== false && firstModel(p)) ??
    providers.find((p) => firstModel(p));
  if (!pick) {
    throw new Error('no provider with a model is configured — add one on the Providers page first');
  }
  const model = requested?.model || firstModel(pick);
  if (!model) {
    throw new Error(`provider "${pick.id}" has no models — add a model on the Providers page first`);
  }
  return { providerId: pick.id, model };
}

function firstModel(p: ProviderRowLike): string | undefined {
  return p.models?.[0] ?? p.modelConfigs?.[0]?.id;
}

// ── Key-scoped terminal launches (gateway-key routing) ───────────────────────

/**
 * cmd.exe metacharacters that would be re-interpreted inside the `cmd /k` line
 * the win32 terminal opener builds. Quotes are deliberately EXCLUDED — they are
 * structural in the `-c` TOML values. Key-scoped launches embed real PATHs
 * (auth helper + config file), so they are checked up front rather than
 * silently corrupted by cmd.exe parsing.
 */
const CMD_METACHAR_RE = /[&|<>^%]/;

/** Terminal CLIs that can authenticate to the gateway as ONE access key. */
export type KeyScopedClient = 'codex' | 'claude';

/** Is this launchable CLI one of the key-scoped clients? */
export function isKeyScopedClient(cli: LaunchCliId): cli is KeyScopedClient {
  return cli === 'codex' || cli === 'claude';
}

/**
 * Per-client key-scoped contract: the gateway endpoint the terminal speaks and
 * the endpoint permissions its key must hold (Codex also generates images, so
 * it needs `images` on top of `responses`; Claude Code only needs `messages`).
 */
const KEY_SCOPED_CONTRACT: Record<
  KeyScopedClient,
  { endpoint: OutboundEndpoint; permissions: readonly OutboundPermission[] }
> = {
  codex: { endpoint: 'responses', permissions: ['responses', 'images'] },
  claude: { endpoint: 'messages', permissions: ['messages'] },
};

/** The deps the key-scoped branch needs beyond the lease-path context. */
export interface KeyScopedLaunchDeps {
  /** Named outbound-key store (usability preflight for the chosen key). */
  keyDb: OutboundKeyDb;
  /** Live gateway bindings; the chosen key must own an enabled responses route. */
  bindings: readonly GatewayBinding[];
  /** Whether the RESIDENT outbound gateway is accepting requests right now. */
  gatewayRunning: boolean;
  /** Loopback base of the resident outbound gateway (e.g. http://127.0.0.1:8765). */
  gatewayBaseUrl: string;
  /** Codex command-auth helper invocation (this daemon's own entrypoint). */
  codexAuthHelper: CodexAuthHelperConfig;
}

/** Pure inputs of `buildKeyScopedCodexArgs`. */
export interface KeyScopedCodexArgsInput {
  gatewayBaseUrl: string;
  authHelper: CodexAuthHelperConfig;
  keyId: string;
  /**
   * OPTIONAL downstream-route pin: every request this terminal sends carries
   * `x-omnicross-binding-id`, and the gateway narrows the key's candidate
   * routes to exactly that one. Absent keeps the key's normal routing.
   */
  bindingId?: string;
}

/**
 * The `-c` config overrides for a key-scoped Codex launch: the SAME provider
 * shape the integration install writes (`renderCodexConfig`) under the SAME
 * provider NAME — Codex sessions are bound to the provider name, so a
 * launch-time alias would split these sessions from the ones plain `codex`
 * creates. Every dotted path here is the same key path the installed block
 * uses, so the `-c` values simply win per-key over whatever
 * `~/.codex/config.toml` holds: the launch is self-contained whether or not
 * the install is enabled, and the file's own `auth` sub-table is shadowed —
 * never mixed with `env_key`, whose precedence against `auth` is undocumented.
 */
export function buildKeyScopedCodexArgs(input: KeyScopedCodexArgsInput): string[] {
  let root = input.gatewayBaseUrl;
  while (root.endsWith('/')) root = root.slice(0, -1);
  const name = CODEX_PROXY_PROVIDER_NAME;
  const helperArgs = [...input.authHelper.args, '--key-id', input.keyId];
  // The static provider headers ride EVERY codex request. A route-pinned launch
  // adds the binding pin alongside the actor marker so the gateway serves this
  // terminal from exactly the chosen downstream route.
  const httpHeaders = input.bindingId
    ? `{"X-OpenAI-Actor-Authorization"="omnicross","${GATEWAY_BINDING_PIN_HEADER}"="${input.bindingId}"}`
    : '{"X-OpenAI-Actor-Authorization"="omnicross"}';
  return [
    '-c', `model_provider="${name}"`,
    '-c', `model_providers.${name}.name="OmniCross Local Gateway"`,
    '-c', `model_providers.${name}.base_url="${root}/v1"`,
    '-c', `model_providers.${name}.wire_api="responses"`,
    '-c', `model_providers.${name}.supports_websockets=false`,
    '-c', `model_providers.${name}.http_headers=${httpHeaders}`,
    '-c', `model_providers.${name}.auth.command=${JSON.stringify(input.authHelper.command)}`,
    '-c', `model_providers.${name}.auth.args=${JSON.stringify(helperArgs)}`,
    '-c', `model_providers.${name}.auth.refresh_interval_ms=0`,
    '-c', `model_providers.${name}.auth.timeout_ms=5000`,
    '-c', 'disable_response_storage=true',
  ];
}

/**
 * The env a key-scoped Claude Code terminal needs: point Claude Code at the
 * RESIDENT outbound gateway and authenticate it as the chosen access key, so
 * routing follows that key's bindings. Unlike Codex — whose auth-command
 * helper fetches the token at CLI start — Claude Code has no per-launch
 * helper hook, so the key plaintext rides the spawned terminal's environment
 * (the same channel the lease path's route token already uses); the launch
 * RESPONSE and session rows stay secret-free either way.
 *
 * `ANTHROPIC_API_KEY` carries the install sentinel (an empty value would let
 * Claude Code fall back to its OAuth login state). A pinned launch adds
 * `ANTHROPIC_CUSTOM_HEADERS` (`Name: Value`, newline-separated — Claude Code
 * ≥ v2.1.227) carrying the gateway route pin.
 */
export function buildKeyScopedClaudeEnv(input: {
  gatewayBaseUrl: string;
  secret: string;
  bindingId?: string;
}): Record<string, string> {
  let root = input.gatewayBaseUrl;
  while (root.endsWith('/')) root = root.slice(0, -1);
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: root,
    ANTHROPIC_AUTH_TOKEN: input.secret,
    ANTHROPIC_API_KEY: CLAUDE_API_KEY_SENTINEL,
  };
  if (input.bindingId) {
    env['ANTHROPIC_CUSTOM_HEADERS'] = `${GATEWAY_BINDING_PIN_HEADER}: ${input.bindingId}`;
  }
  return env;
}

/** Preflight outcome for the chosen gateway key (optionally route-pinned). */
export type KeyScopedPreflight =
  | {
      ok: true;
      keyId: string;
      keyName: string;
      bindingId?: string;
      bindingName?: string;
      /**
       * The revealed key plaintext. Codex discards it (its auth-command helper
       * re-reveals at CLI start); Claude Code's env carries it — it never
       * leaves this launch path (response + session rows stay secret-free).
       */
      secret: string;
    }
  | { ok: false; status: number; message: string };

/**
 * Is this stored key row eligible to power a key-scoped terminal? Exists,
 * enabled, not revoked, revealable, and holding the client-required endpoint
 * permissions. Returns an error message instead of the row when NOT eligible.
 */
async function keyScopedEligibilityError(
  deps: KeyScopedLaunchDeps,
  row: { id: string; name: string; enabled: boolean; revokedAt: number | null; kind?: 'client' | 'integration'; allowedEndpoints?: OutboundPermission[] },
  client: KeyScopedClient,
): Promise<string | null> {
  if (!row.enabled || row.revokedAt !== null) {
    return `access key '${row.name}' is disabled or revoked`;
  }
  const secret = await deps.keyDb.outboundApiKeysReveal(row.id);
  if (!secret) {
    return `access key '${row.name}' is not revealable`;
  }
  // Client keys hold every permission by kind; only integration keys scope.
  const allowed = effectivePermissionsForRow(row);
  for (const permission of KEY_SCOPED_CONTRACT[client].permissions) {
    if (!allowed.includes(permission)) {
      return `access key '${row.name}' lacks the '${permission}' endpoint permission ${client} requires`;
    }
  }
  return null;
}

/**
 * The bindings that serve one key row — the mirror of the wire layer's
 * UPSTREAM ROUTING MODEL rule: a key carrying an `upstreamBinding` is served
 * ONLY by its derived (`keyup:<id>:*`) bindings, never by legacy stored
 * routes. Keeps the launch preflight and the gateway from disagreeing.
 */
function bindingsServingKey(
  bindings: readonly GatewayBinding[],
  row: { id: string; upstreamBinding?: unknown },
): readonly GatewayBinding[] {
  if (!row.upstreamBinding) return bindings;
  const prefix = `keyup:${row.id}:`;
  return bindings.filter((binding) => binding.id.startsWith(prefix));
}

/**
 * Fail-fast checks for a key-scoped launch, so a misconfigured key surfaces as
 * a clear admin error instead of a terminal that 401s/404s on its first
 * request: gateway running; key exists, enabled, not revoked, revealable;
 * client-required endpoint permissions; at least one enabled binding on the
 * client's endpoint scoped to the key (that binding is what routes this
 * terminal's upstream).
 */
export async function preflightKeyScopedLaunch(
  deps: KeyScopedLaunchDeps,
  keyId: string,
  client: KeyScopedClient,
): Promise<KeyScopedPreflight> {
  const { endpoint } = KEY_SCOPED_CONTRACT[client];
  if (!deps.gatewayRunning) {
    return {
      ok: false,
      status: 409,
      message: 'the outbound gateway is not running — key-scoped launches route through it',
    };
  }
  const rows = await deps.keyDb.outboundApiKeysList();
  const row = rows.find((candidate) => candidate.id === keyId);
  if (!row) return { ok: false, status: 404, message: `access key '${keyId}' does not exist` };
  const eligibilityError = await keyScopedEligibilityError(deps, row, client);
  if (eligibilityError) return { ok: false, status: 400, message: eligibilityError };
  if (candidateGatewayBindings(bindingsServingKey(deps.bindings, row), keyId, endpoint).length === 0) {
    return {
      ok: false,
      status: 400,
      message:
        `access key '${row.name}' has no enabled ${endpoint} route — bind it to a downstream route ` +
        'on the API Service page first',
    };
  }
  const secret = await deps.keyDb.outboundApiKeysReveal(keyId);
  return { ok: true, keyId, keyName: row.name, secret: secret ?? '' };
}

/**
 * Fail-fast checks for a ROUTE-scoped launch (`{ bindingId }`): the terminal
 * authenticates as an eligible gateway key (explicit `keyId`, or the first
 * eligible key the route admits) and pins the chosen downstream route via
 * `x-omnicross-binding-id`, so that exact route — not the key's
 * priority-ordered candidates — serves the terminal. Binding ids are embedded
 * in TOML/argv `-c` overrides and env values, so only a conservative id
 * charset is accepted.
 */
const BINDING_ID_CHARSET_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export async function preflightBindingScopedLaunch(
  deps: KeyScopedLaunchDeps,
  bindingId: string,
  keyId: string | undefined,
  client: KeyScopedClient,
): Promise<KeyScopedPreflight> {
  const { endpoint, permissions } = KEY_SCOPED_CONTRACT[client];
  if (!deps.gatewayRunning) {
    return {
      ok: false,
      status: 409,
      message: 'the outbound gateway is not running — route-scoped launches route through it',
    };
  }
  if (!BINDING_ID_CHARSET_RE.test(bindingId)) {
    return {
      ok: false,
      status: 400,
      message: 'route id contains characters that cannot be passed through a terminal launch',
    };
  }
  const binding = deps.bindings.find((candidate) => candidate.id === bindingId);
  if (!binding) {
    return { ok: false, status: 404, message: `downstream route '${bindingId}' does not exist` };
  }
  if (!binding.enabled || binding.endpoint !== endpoint) {
    return {
      ok: false,
      status: 400,
      message: `downstream route '${binding.name}' is disabled or does not serve the ${endpoint} endpoint`,
    };
  }
  const rows = await deps.keyDb.outboundApiKeysList();
  const candidates = keyId
    ? rows.filter((row) => row.id === keyId)
    : rows;
  if (keyId && candidates.length === 0) {
    return { ok: false, status: 404, message: `access key '${keyId}' does not exist` };
  }
  // First eligible key the pinned route admits. Eligibility mirrors the
  // key-scoped contract; admission is decided by the gateway's own candidate
  // filter with the pin applied (never widens a key's routing).
  for (const row of candidates) {
    const eligibilityError = await keyScopedEligibilityError(deps, row, client);
    if (eligibilityError) {
      if (keyId) return { ok: false, status: 400, message: eligibilityError };
      continue;
    }
    if (candidateGatewayBindings(bindingsServingKey(deps.bindings, row), row.id, endpoint, bindingId).length === 0) {
      if (keyId) {
        return {
          ok: false,
          status: 400,
          message: `access key '${row.name}' cannot enter downstream route '${binding.name}'`,
        };
      }
      continue;
    }
    const secret = await deps.keyDb.outboundApiKeysReveal(row.id);
    return {
      ok: true,
      keyId: row.id,
      keyName: row.name,
      bindingId,
      bindingName: binding.name,
      secret: secret ?? '',
    };
  }
  return {
    ok: false,
    status: 400,
    message:
      `downstream route '${binding.name}' has no eligible gateway key — an enabled, revealable key ` +
      `with the ${permissions.join('+')} permissions must be able to enter it (bind one on the API Service page)`,
  };
}

/** Dispatch to the matching cli-launcher builder (registers the resident route). */
export async function buildLaunchEnv(
  cli: LaunchCliId,
  llmConfig: ProviderConfigSource,
  target: LaunchTarget,
): Promise<ChatCliLaunchConfig & { extraArgs?: string[] }> {
  const common = {
    llmConfig,
    providerId: target.providerId,
    model: target.model,
    sessionId: `dashboard:${cli}`,
  };
  switch (cli) {
    case 'claude':
      return buildClaudeCliLaunchConfig(common);
    case 'codex':
      return buildCodexLaunchConfig(common);
    case 'gemini':
      return buildGeminiCliLaunchConfig(common);
    case 'qwen':
    case 'copilot':
    case 'opencode':
      return buildChatCliLaunchConfig({ backendId: cli as ChatCliBackendId, ...common });
  }
}

/** Open a NEW terminal window running `command [extraArgs…]` with `env` injected. */
export type TerminalCleanup = () => void;

export type TerminalOpener = (input: {
  cli: string;
  command: string;
  extraArgs: string[];
  env: Record<string, string>;
  cwd?: string;
  platform: NodeJS.Platform;
  onFailure?: () => void;
}) => void | TerminalCleanup;

/** Single-quote a posix shell word. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Secret-free bootstrap used by macOS Terminal. The descriptor arrives over a
 * private one-shot local socket, then only the final CLI child receives it.
 */
export const MAC_TERMINAL_BOOTSTRAP_SOURCE = `
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const [socketPath, launchDir, cwd, command, ...args] = process.argv.slice(2);
let payload = '';
const socket = net.createConnection(socketPath);
socket.setEncoding('utf8');
socket.on('data', (chunk) => { payload += chunk; });
socket.on('end', () => {
  const descriptor = JSON.parse(payload);
  if (!descriptor || Array.isArray(descriptor) || Object.values(descriptor).some((value) => typeof value !== 'string')) {
    throw new Error('invalid terminal launch descriptor');
  }
  try { fs.rmSync(launchDir, { recursive: true, force: true }); } catch {}
  const child = spawn(command, args, {
    cwd: cwd || undefined,
    env: { ...process.env, ...descriptor },
    stdio: 'inherit',
  });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code == null ? 1 : code;
  });
});
socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
`;

const MAC_TERMINAL_IPC_TIMEOUT_MS = 120_000;
type TerminalSpawn = typeof spawn;

export interface MacTerminalIpcOptions {
  socketPath?: string;
  timeoutMs?: number;
  onListening?: () => void;
  onClaimed?: () => void;
  onAccepted?: (socket: Socket) => void;
  removeArtifacts?: (launchDir: string) => void;
}

/**
 * Default opener. POSIX command strings contain command/cwd arguments but no
 * environment values. macOS transfers its descriptor through private IPC
 * because Launch Services does not propagate the `open` process environment.
 */
export function openTerminal(
  { cli, command, extraArgs, env, cwd, platform, onFailure }: Parameters<TerminalOpener>[0],
  spawnProcess: TerminalSpawn = spawn,
  macIpc: MacTerminalIpcOptions = {},
): () => void {
  const childEnv = { ...process.env, ...env };
  if (platform === 'win32') {
    const args = ['/c', 'start', `"omnicross ${cli}"`];
    if (cwd) args.push('/D', `"${cwd}"`);
    args.push('cmd', '/k', command, ...extraArgs);
    spawnProcess(process.env['ComSpec'] || 'cmd.exe', args, {
      env: childEnv,
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
    return () => {};
  }

  const runLine = [command, ...extraArgs].map(shq).join(' ');
  const script = `${cwd ? `cd ${shq(cwd)}; ` : ''}${runLine}`;

  if (platform === 'darwin') {
    const launchDir = mkdtempSync(join(tmpdir(), 'omnicross-terminal-'));
    const commandFile = join(launchDir, 'launch.command');
    const bootstrapFile = join(launchDir, 'bootstrap.cjs');
    const socketPath = macIpc.socketPath ?? join(launchDir, 'descriptor.sock');
    const openerEnv = { ...process.env };
    for (const key of Object.keys(env)) delete openerEnv[key];
    let claimed = false;
    let cleaned = false;
    let failureNotified = false;
    let timer: NodeJS.Timeout | undefined;
    const notifyFailure = (): void => {
      cleanup();
      if (failureNotified) return;
      failureNotified = true;
      try {
        onFailure?.();
      } catch {}
    };
    const handleLaunchFailure = (): void => {
      if (claimed) cleanup();
      else notifyFailure();
    };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      socket.unref();
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      try {
        macIpc.onAccepted?.(socket);
      } catch {
        cleanup();
        return;
      }
      if (claimed || cleaned) {
        socket.destroy();
        return;
      }
      claimed = true;
      try {
        macIpc.onClaimed?.();
        if (cleaned) return;
        socket.end(JSON.stringify(env), cleanup);
      } catch {
        cleanup();
      }
    });
    const cleanup = (): void => {
      if (!cleaned) {
        cleaned = true;
        if (timer) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        try {
          server.close();
        } catch {}
      }
      try {
        if (macIpc.removeArtifacts) {
          macIpc.removeArtifacts(launchDir);
        } else {
          rmSync(launchDir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 20,
          });
        }
      } catch {}
    };

    try {
      writeFileSync(bootstrapFile, MAC_TERMINAL_BOOTSTRAP_SOURCE, { encoding: 'utf8', mode: 0o700 });
      writeFileSync(commandFile, `#!/bin/bash\nrm -f -- "$0"\nexec ${shq(process.execPath)} ${shq(bootstrapFile)} ${shq(socketPath)} ${shq(launchDir)} ${shq(cwd ?? '')} ${runLine}\n`, {
        encoding: 'utf8',
        mode: 0o700,
      });
      chmodSync(commandFile, 0o700);
      chmodSync(bootstrapFile, 0o700);

      server.once('error', handleLaunchFailure);
      server.listen(socketPath, () => {
        if (cleaned) return;
        try {
          macIpc.onListening?.();
          if (cleaned) return;
          if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
          const opener = spawnProcess('open', ['-n', '-a', 'Terminal', commandFile], {
            env: openerEnv,
            detached: true,
            stdio: 'ignore',
          });
          opener.once('error', handleLaunchFailure);
          opener.unref();
          server.unref();
        } catch {
          handleLaunchFailure();
        }
      });
      timer = setTimeout(handleLaunchFailure, macIpc.timeoutMs ?? MAC_TERMINAL_IPC_TIMEOUT_MS);
      timer.unref?.();
      return cleanup;
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  // linux (best-effort): the generic Debian alternative, keep the shell open.
  spawnProcess('x-terminal-emulator', ['-e', 'bash', '-lc', `${script}; exec bash`], {
    env: childEnv,
    detached: true,
    stdio: 'ignore',
  }).unref();
  return () => {};
}

export const defaultTerminalOpener: TerminalOpener = (input) => openTerminal(input);

// ── Session registry + admin handlers ─────────────────────────────────────────
//
// A launched CLI runs in a DETACHED external terminal the daemon cannot track, so
// its resident route stays registered until the user stops it (or the daemon
// restarts). The registry holds the `onSessionEnd` (route removal) per launch.

interface CliSession {
  id: string;
  cli: LaunchCliId;
  providerId: string;
  model: string;
  /**
   * Key-scoped rows: the gateway key this terminal authenticates as (codex
   * only). No lease exists for these — the key outlives the terminal — so
   * providerId/model are empty and routing follows the key's bindings.
   */
  keyId?: string;
  keyName?: string;
  /**
   * Route-pinned rows: the downstream route this terminal pinned via
   * `x-omnicross-binding-id` (codex only). Absent on plain key-scoped rows.
   */
  bindingId?: string;
  bindingName?: string;
  leaseId?: string;
  startedAt: string;
  onSessionEnd: () => void;
}

const sessions = new Map<string, CliSession>();

/** Tear down every live route (test isolation + daemon shutdown hook). */
export function resetCliSessions(): void {
  for (const s of sessions.values()) {
    try {
      s.onSessionEnd();
    } catch {
      // best-effort
    }
  }
  sessions.clear();
}

export interface CliHandlerResult {
  status: number;
  body: unknown;
}

function errBody(message: string): { error: { type: string; message: string } } {
  return { error: { type: 'admin_api_error', message } };
}

/**
 * Injectable shell runner for `POST /cli/:cli/install` (tests stub this; the
 * default execs the install command with a bounded timeout). Returns the host's
 * honest install outcome — `error` carries stderr/the failure reason.
 */
export type CommandRunner = (command: string) => Promise<{ ok: boolean; error?: string }>;

const defaultCommandRunner: CommandRunner = (command) =>
  new Promise((resolve) => {
    exec(command, { timeout: 180_000 }, (err, _stdout, stderr) => {
      if (err) resolve({ ok: false, error: stderr.trim() || err.message });
      else resolve({ ok: true });
    });
  });

/**
 * POST /cli/:cli/install → run the CLI's global install command on the daemon
 * host (npm/PowerShell). STATUS-ONLY `{ ok: true }` on success; a 400 when the
 * CLI has no known install command, a 500 (with the failure reason) when the
 * command fails. No secret is involved — this is a plain package-manager
 * invocation.
 */
export async function handleCliInstall(
  cli: TrackedCliId,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CliHandlerResult> {
  const cmd = installCommandFor(cli);
  if (!cmd) {
    return { status: 400, body: errBody(`no install command for cli '${cli}' (manual install only)`) };
  }
  const result = await runner(cmd);
  if (!result.ok) {
    return { status: 500, body: errBody(result.error || 'install failed') };
  }
  return { status: 200, body: { ok: true } };
}

// ── Version detection + upgrade (dashboard parity) ────────────────────────────

/**
 * Injectable command runner for the version probes (`<cli> --version`,
 * `npm view <pkg> version`). Returns the command's stdout on success — version
 * parsing happens in ONE place (`parseCliVersion`/`firstNonEmptyLine`).
 */
export type VersionRunner = (command: string) => Promise<{ ok: boolean; output?: string; error?: string }>;

const defaultVersionRunner: VersionRunner = (command) =>
  new Promise((resolve) => {
    exec(command, { timeout: 20_000, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: stderr.trim() || err.message });
      else resolve({ ok: true, output: stdout });
    });
  });

/**
 * First semver-looking token in a `--version` output: the first line wins
 * (every tracked CLI prints its version there), the rest of the output is a
 * fallback for multi-line shapes. A leading `v` is left out of the match.
 */
const SEMVER_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;

export function parseCliVersion(output: string): string | null {
  const text = output.trim();
  if (!text) return null;
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const fromFirstLine = firstLine.match(SEMVER_RE);
  if (fromFirstLine) return fromFirstLine[0];
  const anywhere = text.match(SEMVER_RE);
  return anywhere ? anywhere[0] : null;
}

function firstNonEmptyLine(output: string): string | null {
  const line = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? null;
}

/** Version probe outcome for ONE CLI (each field is best-effort/absent). */
export interface CliVersionStatus {
  /** Version reported by the installed binary (`--version`). */
  installed?: string;
  /** Latest release on the npm registry (npm-installed CLIs only). */
  latest?: string;
}

/** `npm view` prints the version bare; `--json` quoting is tolerated. */
function parseRegistryVersion(output: string): string | null {
  const line = firstNonEmptyLine(output);
  if (!line) return null;
  return line.replace(/^"|"$/g, '') || null;
}

/**
 * Probe versions for every INSTALLED tracked CLI: the binary's own `--version`
 * plus (npm CLIs) the registry's latest, so the dashboard can show "current →
 * latest" and offer Upgrade. Not-installed CLIs are simply absent from the map;
 * failed probes leave their field out rather than failing the whole call.
 */
export async function detectCliVersions(
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
  runner: VersionRunner = defaultVersionRunner,
): Promise<Record<string, CliVersionStatus>> {
  const settled = await Promise.all(TRACKED_CLIS.map(async (cli) => {
    if (!isCliInstalled(cli.command, platform, probe)) return null;
    const status: CliVersionStatus = {};
    await Promise.all([
      runner(`${cli.command} --version`)
        .then((r) => {
          const parsed = r.ok ? parseCliVersion(r.output ?? '') : null;
          if (parsed) status.installed = parsed;
        })
        .catch(() => {}),
      (async () => {
        const pkg = npmPackageFor(cli.id);
        if (!pkg) return;
        try {
          const r = await runner(`npm view ${pkg} version`);
          const parsed = r.ok ? parseRegistryVersion(r.output ?? '') : null;
          if (parsed) status.latest = parsed;
        } catch {
          /* offline / registry unreachable — latest stays unknown */
        }
      })(),
    ]);
    return [cli.id, status] as const;
  }));
  const versions: Record<string, CliVersionStatus> = {};
  for (const entry of settled) {
    if (entry) versions[entry[0]] = entry[1];
  }
  return versions;
}

/** GET /cli/versions → installed + npm-latest versions for the installed CLIs. */
export async function handleCliVersions(
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
  runner: VersionRunner = defaultVersionRunner,
): Promise<CliHandlerResult> {
  return { status: 200, body: { versions: await detectCliVersions(platform, probe, runner) } };
}

/**
 * POST /cli/:cli/upgrade → re-install at latest on the daemon host (npm CLIs
 * pin `@latest`; script installers re-run their script). STATUS-ONLY `{ ok: true,
 * version? }` — the version is re-probed so the dashboard can confirm the landed
 * release; a probe failure still reports a successful upgrade without one.
 */
export async function handleCliUpgrade(
  cli: TrackedCliId,
  runner: CommandRunner = defaultCommandRunner,
  versionRunner: VersionRunner = defaultVersionRunner,
): Promise<CliHandlerResult> {
  const cmd = upgradeCommandFor(cli);
  if (!cmd) {
    return { status: 400, body: errBody(`no install command for cli '${cli}' (manual install only)`) };
  }
  const result = await runner(cmd);
  if (!result.ok) {
    return { status: 500, body: errBody(result.error || 'upgrade failed') };
  }
  let version: string | undefined;
  try {
    const probed = await versionRunner(`${TRACKED_CLIS.find((c) => c.id === cli)!.command} --version`);
    const parsed = probed.ok ? parseCliVersion(probed.output ?? '') : null;
    if (parsed) version = parsed;
  } catch {
    /* best-effort confirmation only */
  }
  return { status: 200, body: { ok: true, ...(version ? { version } : {}) } };
}

/** GET /cli → the per-CLI availability list. */
export function handleCliList(
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
): CliHandlerResult {
  return { status: 200, body: { clis: detectClis(platform, probe) } };
}

/** GET /cli/sessions → the running launches (token-free). */
export function handleCliSessions(): CliHandlerResult {
  const list = [...sessions.values()].map(({ onSessionEnd: _drop, ...rest }) => rest);
  return { status: 200, body: { sessions: list } };
}

/** DELETE /cli/sessions/:id → remove the route + forget the session. */
export function handleCliStop(id: string): CliHandlerResult {
  const s = sessions.get(id);
  if (!s) return { status: 404, body: errBody(`session '${id}' not found`) };
  try {
    s.onSessionEnd();
  } catch {
    // best-effort
  }
  sessions.delete(id);
  return { status: 200, body: { ok: true } };
}

/** Context the launch handler needs (the caller supplies the live deps). */
export interface CliLaunchContext {
  llmConfig: ProviderConfigSource;
  providers: ProviderRowLike[];
  /** Daemon-owned Route Lease service used by Claude/Codex launches. */
  routeLeaseManager?: RouteLeaseManager;
  /** Deps for key-scoped codex launches; absent ⇒ `keyId` requests get a 501. */
  keyScoped?: KeyScopedLaunchDeps;
  opener?: TerminalOpener;
  platform?: NodeJS.Platform;
  probe?: PathProbe;
}

interface LaunchMaterial {
  readonly env: Record<string, string>;
  readonly extraArgs?: string[];
  readonly onSessionEnd: () => void;
}


/**
 * POST /cli/:cli/launch { providerId?, model?, cwd?, keyId?, bindingId? } →
 * register the resident route (or, with `keyId`/`bindingId`, skip the lease and
 * authenticate the terminal's Codex to the gateway as the chosen key — pinned
 * to the chosen downstream route when `bindingId` is set), open a terminal with
 * the redirect env, track the session. STATUS-ONLY: the response carries the
 * sessionId + resolved provider/model (or key id/name + route id/name) — NEVER
 * the route token or the key plaintext (the token rides only the spawned
 * terminal's environment; the key never even does that — Codex's auth helper
 * fetches it).
 */
export async function handleCliLaunch(
  cli: TrackedCliId,
  body: Record<string, unknown>,
  ctx: CliLaunchContext,
): Promise<CliHandlerResult> {
  const platform = ctx.platform ?? process.platform;
  const probe = ctx.probe ?? probeDefault;
  const meta = LAUNCHABLE_CLIS.find((c) => c.id === cli);
  if (!meta) {
    // A tracked-but-not-launchable CLI deserves better than "unknown".
    if (isTrackedCliId(cli)) {
      return { status: 400, body: errBody(`'${cli}' is install-only — the dashboard cannot launch it in a terminal yet`) };
    }
    return { status: 404, body: errBody(`unknown cli '${cli}'`) };
  }
  // `cli` is now known launchable — the narrowed id types the builder calls below.
  const launchCli: LaunchCliId = meta.id;
  if (!isCliInstalled(meta.command, platform, probe)) {
    return { status: 400, body: errBody(`"${meta.command}" is not installed (not found on PATH)`) };
  }

  const keyId = typeof body['keyId'] === 'string' && body['keyId'].trim() ? body['keyId'].trim() : undefined;
  const bindingId = typeof body['bindingId'] === 'string' && body['bindingId'].trim()
    ? body['bindingId'].trim()
    : undefined;

  let target: LaunchTarget | undefined;
  let keyLaunch: { keyId: string; keyName: string; bindingId?: string; bindingName?: string } | undefined;
  const id = randomUUID();
  let leaseId: string | undefined;
  let launch: LaunchMaterial;
  if (keyId || bindingId) {
    if (!isKeyScopedClient(launchCli)) {
      return { status: 400, body: errBody('key-scoped launch is only supported for codex and claude') };
    }
    const deps = ctx.keyScoped;
    if (!deps) {
      return { status: 501, body: errBody('key-scoped launch is not available in this build') };
    }
    const preflight = bindingId
      ? await preflightBindingScopedLaunch(deps, bindingId, keyId, launchCli)
      : await preflightKeyScopedLaunch(deps, keyId!, launchCli);
    if (!preflight.ok) return { status: preflight.status, body: errBody(preflight.message) };
    if (cli === 'codex') {
      if (platform === 'win32') {
        // The auth-helper invocation rides argv through the terminal opener's
        // `cmd /k` line on win32 — refuse metacharacter-bearing PATHs up front
        // instead of letting cmd.exe silently corrupt the override.
        const unsafe = [deps.codexAuthHelper.command, ...deps.codexAuthHelper.args]
          .filter((value) => CMD_METACHAR_RE.test(value));
        if (unsafe.length > 0) {
          return {
            status: 400,
            body: errBody(
              'the Codex auth-helper path contains cmd.exe metacharacters and cannot be ' +
              'passed through a Windows terminal launch',
            ),
          };
        }
      }
      // Codex keeps its secret OUT of the spawned env — the auth-command
      // helper re-reveals it at CLI start.
      launch = {
        env: {},
        extraArgs: buildKeyScopedCodexArgs({
          gatewayBaseUrl: deps.gatewayBaseUrl,
          authHelper: deps.codexAuthHelper,
          keyId: preflight.keyId,
          ...(preflight.bindingId ? { bindingId: preflight.bindingId } : {}),
        }),
        // No route or lease exists to release — the gateway key outlives the
        // terminal and its bindings route every request.
        onSessionEnd: () => {},
      };
    } else {
      // Claude Code has no per-launch helper hook, so its key rides the env
      // (see buildKeyScopedClaudeEnv).
      launch = {
        env: buildKeyScopedClaudeEnv({
          gatewayBaseUrl: deps.gatewayBaseUrl,
          secret: preflight.secret,
          ...(preflight.bindingId ? { bindingId: preflight.bindingId } : {}),
        }),
        onSessionEnd: () => {},
      };
    }
    keyLaunch = {
      keyId: preflight.keyId,
      keyName: preflight.keyName,
      ...(preflight.bindingId ? { bindingId: preflight.bindingId } : {}),
      ...(preflight.bindingName ? { bindingName: preflight.bindingName } : {}),
    };
  } else {
    let resolved: LaunchTarget;
    try {
      resolved = resolveLaunchTarget(ctx.providers, {
        providerId: typeof body['providerId'] === 'string' ? body['providerId'] : undefined,
        model: typeof body['model'] === 'string' ? body['model'] : undefined,
      });
    } catch (err) {
      return { status: 400, body: errBody(err instanceof Error ? err.message : 'no launch target') };
    }
    target = resolved;
    try {
      if ((cli === 'claude' || cli === 'codex') && ctx.routeLeaseManager) {
        const outcome = await ctx.routeLeaseManager.createFromRequest({
          schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
          consumer: 'omnicross-terminal',
          runtime: cli,
          upstream: { kind: 'provider', providerId: resolved.providerId },
          model: resolved.model,
          execution: { sessionId: id },
        }, `omnicross-terminal:${id}`);
        leaseId = outcome.result.leaseId;
        const stopRenewal = startTerminalLeaseRenewal(ctx.routeLeaseManager, leaseId);
        launch = {
          env: outcome.result.launch.env,
          extraArgs: outcome.result.launch.extraArgs,
          onSessionEnd: () => {
            stopRenewal();
            ctx.routeLeaseManager?.release(outcome.result.leaseId);
          },
        };
      } else {
        launch = await buildLaunchEnv(launchCli, ctx.llmConfig, resolved);
      }
    } catch (err) {
      const status = err instanceof RouteLeaseError ? err.status : 400;
      return { status, body: errBody(err instanceof Error ? err.message : 'failed to build launch env') };
    }
  }

  const cwd = typeof body['cwd'] === 'string' && body['cwd'].trim() ? body['cwd'].trim() : undefined;
  const opener = ctx.opener ?? defaultTerminalOpener;
  let openerCleanup: TerminalCleanup | undefined;
  let ended = false;
  let published = false;
  const onSessionEnd = (): void => {
    if (ended) return;
    ended = true;
    if (published) sessions.delete(id);
    try {
      openerCleanup?.();
    } finally {
      launch.onSessionEnd();
    }
  };
  try {
    const cleanup = opener({
      cli,
      command: meta.command,
      extraArgs: launch.extraArgs ?? [],
      env: launch.env,
      cwd,
      platform,
      onFailure: onSessionEnd,
    });
    if (cleanup) openerCleanup = cleanup;
  } catch (err) {
    onSessionEnd();
    return { status: 500, body: errBody(err instanceof Error ? err.message : 'failed to open terminal') };
  }
  if (ended) {
    openerCleanup?.();
    return { status: 500, body: errBody('failed to open terminal') };
  }

  sessions.set(id, {
    id,
    cli: launchCli,
    providerId: target?.providerId ?? '',
    model: target?.model ?? '',
    ...(keyLaunch
      ? {
          keyId: keyLaunch.keyId,
          keyName: keyLaunch.keyName,
          ...(keyLaunch.bindingId ? { bindingId: keyLaunch.bindingId } : {}),
          ...(keyLaunch.bindingName ? { bindingName: keyLaunch.bindingName } : {}),
        }
      : {}),
    ...(leaseId ? { leaseId } : {}),
    startedAt: new Date().toISOString(),
    onSessionEnd,
  });
  published = true;
  if (ended) sessions.delete(id);
  return {
    status: 200,
    body: keyLaunch
      ? {
          sessionId: id,
          keyId: keyLaunch.keyId,
          keyName: keyLaunch.keyName,
          ...(keyLaunch.bindingId ? { bindingId: keyLaunch.bindingId } : {}),
          ...(keyLaunch.bindingName ? { bindingName: keyLaunch.bindingName } : {}),
        }
      : { sessionId: id, providerId: target?.providerId, model: target?.model },
  };
}
