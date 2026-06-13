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
 * @module @omnicross/daemon/admin/cliLaunch
 */

import { exec, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  buildChatCliLaunchConfig,
  buildClaudeCliLaunchConfig,
  buildCodexLaunchConfig,
  buildGeminiCliLaunchConfig,
  type ChatCliBackendId,
  type ChatCliLaunchConfig,
} from '@omnicross/cli-launcher';
import type { ProviderConfigSource } from '@omnicross/core';

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
 * Per-CLI global install command (run on the daemon host). CLIs absent from this
 * map are manual-install only — the dashboard hides the Install button for them.
 * `Partial` keeps the absence meaningful even though every launchable CLI
 * currently has one.
 */
export const INSTALL_COMMANDS: Partial<Record<LaunchCliId, string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  qwen: 'npm install -g @qwen-code/qwen-code',
  copilot: 'npm install -g @github/copilot',
  opencode: 'npm install -g opencode-ai',
};

const LAUNCHABLE_IDS = new Set<string>(LAUNCHABLE_CLIS.map((c) => c.id));
export function isLaunchCliId(id: string | undefined): id is LaunchCliId {
  return id !== undefined && LAUNCHABLE_IDS.has(id);
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
  id: LaunchCliId;
  displayName: string;
  command: string;
  installed: boolean;
  /** Has a known global install command (dashboard shows an Install button). */
  installable: boolean;
}

export function detectClis(
  platform: NodeJS.Platform = process.platform,
  probe: PathProbe = probeDefault,
): CliStatus[] {
  return LAUNCHABLE_CLIS.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    command: c.command,
    installed: isCliInstalled(c.command, platform, probe),
    installable: Boolean(INSTALL_COMMANDS[c.id]),
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
export type TerminalOpener = (input: {
  cli: string;
  command: string;
  extraArgs: string[];
  env: Record<string, string>;
  cwd?: string;
  platform: NodeJS.Platform;
}) => void;

/** Single-quote a posix shell word. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Default opener. win32: `cmd /c start "title" [/D cwd] cmd /k <cli> [args]` with
 * the route token riding the spawned process env (inherited — never on the
 * command line / disk). darwin/linux: a one-liner that exports the env then execs
 * the CLI in the platform terminal (best-effort; the token rides the script
 * string — local-only, ephemeral route token).
 */
export const defaultTerminalOpener: TerminalOpener = ({ cli, command, extraArgs, env, cwd, platform }) => {
  const childEnv = { ...process.env, ...env };
  if (platform === 'win32') {
    const args = ['/c', 'start', `"omnicross ${cli}"`];
    if (cwd) args.push('/D', `"${cwd}"`);
    args.push('cmd', '/k', command, ...extraArgs);
    spawn(process.env['ComSpec'] || 'cmd.exe', args, {
      env: childEnv,
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  const exportLine = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join('; ');
  const runLine = [command, ...extraArgs].map(shq).join(' ');
  const script = `${exportLine}; ${cwd ? `cd ${shq(cwd)}; ` : ''}${runLine}`;

  if (platform === 'darwin') {
    const osa = `tell application "Terminal" to do script ${JSON.stringify(script)}`;
    spawn('osascript', ['-e', osa], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // linux (best-effort): the generic Debian alternative, keep the shell open.
  spawn('x-terminal-emulator', ['-e', 'bash', '-lc', `${script}; exec bash`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
};

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
 * host (npm/curl). STATUS-ONLY `{ ok: true }` on success; a 400 when the CLI has
 * no known install command, a 500 (with the failure reason) when the command
 * fails. No secret is involved — this is a plain package-manager invocation.
 */
export async function handleCliInstall(
  cli: LaunchCliId,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CliHandlerResult> {
  const cmd = INSTALL_COMMANDS[cli];
  if (!cmd) {
    return { status: 400, body: errBody(`no install command for cli '${cli}' (manual install only)`) };
  }
  const result = await runner(cmd);
  if (!result.ok) {
    return { status: 500, body: errBody(result.error || 'install failed') };
  }
  return { status: 200, body: { ok: true } };
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
  opener?: TerminalOpener;
  platform?: NodeJS.Platform;
  probe?: PathProbe;
}

/**
 * POST /cli/:cli/launch { providerId?, model?, cwd? } → register the resident
 * route, open a terminal with the redirect env, track the session. STATUS-ONLY:
 * the response carries the sessionId + resolved provider/model — NEVER the route
 * token (it rides only the spawned terminal's environment).
 */
export async function handleCliLaunch(
  cli: LaunchCliId,
  body: Record<string, unknown>,
  ctx: CliLaunchContext,
): Promise<CliHandlerResult> {
  const platform = ctx.platform ?? process.platform;
  const probe = ctx.probe ?? probeDefault;
  const meta = LAUNCHABLE_CLIS.find((c) => c.id === cli);
  if (!meta) return { status: 404, body: errBody(`unknown cli '${cli}'`) };
  if (!isCliInstalled(meta.command, platform, probe)) {
    return { status: 400, body: errBody(`"${meta.command}" is not installed (not found on PATH)`) };
  }

  let target: LaunchTarget;
  try {
    target = resolveLaunchTarget(ctx.providers, {
      providerId: typeof body['providerId'] === 'string' ? body['providerId'] : undefined,
      model: typeof body['model'] === 'string' ? body['model'] : undefined,
    });
  } catch (err) {
    return { status: 400, body: errBody(err instanceof Error ? err.message : 'no launch target') };
  }

  let launch: ChatCliLaunchConfig & { extraArgs?: string[] };
  try {
    launch = await buildLaunchEnv(cli, ctx.llmConfig, target);
  } catch (err) {
    return { status: 400, body: errBody(err instanceof Error ? err.message : 'failed to build launch env') };
  }

  const cwd = typeof body['cwd'] === 'string' && body['cwd'].trim() ? body['cwd'].trim() : undefined;
  const opener = ctx.opener ?? defaultTerminalOpener;
  try {
    opener({ cli, command: meta.command, extraArgs: launch.extraArgs ?? [], env: launch.env, cwd, platform });
  } catch (err) {
    launch.onSessionEnd();
    return { status: 500, body: errBody(err instanceof Error ? err.message : 'failed to open terminal') };
  }

  const id = randomUUID();
  sessions.set(id, {
    id,
    cli,
    providerId: target.providerId,
    model: target.model,
    startedAt: new Date().toISOString(),
    onSessionEnd: launch.onSessionEnd,
  });
  return { status: 200, body: { sessionId: id, providerId: target.providerId, model: target.model } };
}
