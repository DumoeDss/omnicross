/**
 * commands/launch.ts — `omnicross launch <cli> --provider <id> --model <m>
 * --config <path> [--cwd <dir>] [--master-key-file <p>] [-- <cli-args…>]`.
 *
 * SELF-CONTAINED launcher (design D1): builds the daemon in-process, starts the
 * resident `ProviderProxy` on an ephemeral loopback port (outbound/admin servers
 * are NOT started), asks the matching `@omnicross/cli-launcher` builder for the
 * redirect env/args (route-token auth — the CLI carries a one-shot token, never
 * an upstream credential), then foreground-spawns the CLI with
 * `stdio: 'inherit'` (design D4 — a bare spawn, NOT ProcessSupervisor: TUI CLIs
 * need the real TTY; the supervisor's child mode pipes stdout for capture).
 *
 * win32 discipline (design D5, oauth-knife lesson): NEVER `shell: true`, never
 * string-concatenated command lines. npm `.cmd` shims can't be spawned directly
 * on Node 20+ (EINVAL), so they route through `ComSpec /d /s /c` with every arg
 * double-quoted — and args containing quotes/metacharacters are REJECTED up
 * front (refuse > silently corrupt). Tokens/URLs ride env/config, never argv
 * (the one exception is codex's `-c base_url=…` TOML overrides — builder
 * contract, passed as argv ELEMENTS, which is exactly why the `.cmd` fallback
 * rejects them rather than risking cmd.exe parsing).
 *
 * Cleanup is `finally`-forced: route removal (+ opencode temp config dir) via
 * `onSessionEnd`, then `providerProxy.stop()`, then `apiKeyPool.dispose()`.
 *
 * Test seam: `runLaunch(argv, deps?)` accepts an injectable `spawnCli` so unit
 * tests assert the spawn PLAN and the boot-smoke drives a fake `node` CLI.
 *
 * @module @omnicross/daemon/commands/launch
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  buildChatCliLaunchConfig,
  buildClaudeCliLaunchConfig,
  buildCodexLaunchConfig,
  buildGeminiCliLaunchConfig,
  type ChatCliBackendId,
  type ChatCliLaunchConfig,
} from '@omnicross/cli-launcher';

import { buildDaemon, type DaemonPaths } from '../bootstrap';
import { loadConfig } from '../config';

import { defaultKeysPath, defaultTokensPath } from './paths';

/** The CLIs `launch` can drive (one per builder). */
export const SUPPORTED_LAUNCH_CLIS = [
  'claude',
  'codex',
  'gemini',
  'qwen',
  'copilot',
  'opencode',
] as const;
export type LaunchCliId = (typeof SUPPORTED_LAUNCH_CLIS)[number];

/** Shell metacharacters (incl. `"` and `%`) we refuse to hand to cmd.exe. */
const CMD_UNSAFE_RE = /[&|<>^"%]/;

/** A fully-resolved spawn plan (pure output of `buildCliSpawnPlan`). */
export interface CliSpawnPlan {
  readonly command: string;
  readonly args: string[];
  /** True when routed through `ComSpec /d /s /c` (win32 `.cmd` shim). */
  readonly viaCmdShim: boolean;
}

/**
 * Resolve + shape the spawn plan for a CLI (PURE — unit-testable; design D5).
 *
 * posix: spawn the name directly (PATH resolution is the OS's job).
 * win32: prefer a real `.exe` from PATH (direct spawn, args verbatim); fall
 * back to the npm `.cmd` shim via `ComSpec /d /s /c` with every element
 * double-quoted — REJECTING any arg that contains a quote or cmd
 * metacharacter (`& | < > ^ " %`), because cmd.exe would parse it before the
 * shim runs (the oauth knife's `start`-truncation lesson, generalized).
 */
export function buildCliSpawnPlan(opts: {
  platform: NodeJS.Platform;
  cliName: string;
  cliArgs: string[];
  /** Injectable PATH probe (tests stub this; default scans process.env.PATH). */
  resolveInPath?: (candidate: string) => string | null;
  comSpec?: string;
}): CliSpawnPlan {
  const { platform, cliName, cliArgs } = opts;
  if (platform !== 'win32') {
    return { command: cliName, args: cliArgs, viaCmdShim: false };
  }
  const probe = opts.resolveInPath ?? resolveInPathDefault;
  const exe = probe(`${cliName}.exe`);
  if (exe) {
    return { command: exe, args: cliArgs, viaCmdShim: false };
  }
  const cmdShim = probe(`${cliName}.cmd`);
  if (!cmdShim) {
    // No resolvable candidate — spawn the bare name and let ENOENT surface the
    // install hint (PATH scanning can miss exotic setups; trying is honest).
    return { command: cliName, args: cliArgs, viaCmdShim: false };
  }
  const unsafe = [cmdShim, ...cliArgs].filter((a) => CMD_UNSAFE_RE.test(a));
  if (unsafe.length > 0) {
    throw new Error(
      `launch: "${cliName}" resolves to an npm .cmd shim, which must run through ` +
        `cmd.exe — but ${unsafe.length} argument(s) contain quote/metacharacters ` +
        `(${unsafe[0]}). Refusing to pass them through cmd.exe (it would parse ` +
        `them before the CLI runs). Install the native ${cliName} executable ` +
        `(.exe on PATH) or drop the offending arguments.`,
    );
  }
  // `/s` strips the outer quotes of the /c payload, leaving `"shim" "a1" …`.
  const payload = [cmdShim, ...cliArgs].map((a) => `"${a}"`).join(' ');
  return {
    command: opts.comSpec ?? process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${payload}"`],
    viaCmdShim: true,
  };
}

/** Default PATH probe: scan each PATH segment for the candidate file. */
function resolveInPathDefault(candidate: string): string | null {
  const segments = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const seg of segments) {
    const full = join(seg, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Injectable side-effects so the command can be tested without a real CLI. */
export interface LaunchDeps {
  /** Spawn the CLI and resolve its exit code. Default = stdio-inherit spawn. */
  spawnCli?: (plan: {
    command: string;
    args: string[];
    viaCmdShim: boolean;
    env: NodeJS.ProcessEnv;
    cwd?: string;
  }) => Promise<number>;
  /** PATH probe override (tests inject for hermeticity vs the host PATH). */
  resolveInPath?: (candidate: string) => string | null;
}

/** Run the `launch` subcommand; returns the CLI's exit code. */
export async function runLaunch(argv: string[], deps?: LaunchDeps): Promise<number> {
  // `--` splits launch's own flags from args passed through to the CLI.
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const passthrough = sep === -1 ? [] : argv.slice(sep + 1);

  const { values, positionals } = parseArgs({
    args: own,
    options: {
      provider: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      config: { type: 'string', short: 'c' },
      cwd: { type: 'string' },
      'master-key-file': { type: 'string' },
    },
    allowPositionals: true,
  });

  const cliName = positionals[0];
  if (!cliName || !SUPPORTED_LAUNCH_CLIS.includes(cliName as LaunchCliId)) {
    throw new Error(
      `launch: a supported <cli> is required — one of: ${SUPPORTED_LAUNCH_CLIS.join(', ')}` +
        (cliName ? ` (got "${cliName}")` : ''),
    );
  }
  const cli = cliName as LaunchCliId;
  if (!values.provider) throw new Error('launch: --provider <id> is required');
  if (!values.model) throw new Error('launch: --model <model> is required');
  if (!values.config) throw new Error('launch: --config <path> is required');

  // Self-contained boot (design D1): in-process daemon, proxy listener only.
  const config = loadConfig(values.config);
  const paths: DaemonPaths = {
    configPath: values.config,
    keysPath: defaultKeysPath(values.config),
    tokensPath: defaultTokensPath(values.config),
    masterKeyFilePath: values['master-key-file'],
  };
  const daemon = buildDaemon(config, paths);
  try {
    await daemon.llmConfig.ready();
    await daemon.providerProxy.start();
  } catch (err) {
    // start() failed mid-bind — still release the pool's cleanup interval
    // (review T1: otherwise it only dies with the process).
    daemon.apiKeyPool.dispose();
    daemon.tokenRefreshScheduler.dispose();
    daemon.accountHealthSweeper.dispose();
    throw err;
  }

  let launch: ChatCliLaunchConfig & { extraArgs?: string[] };
  try {
    launch = await buildLaunchConfig(cli, daemon.llmConfig, {
      providerId: values.provider,
      model: values.model,
    });
  } catch (err) {
    // Builder validation failed BEFORE any route was registered — still stop
    // the listener we started.
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    daemon.tokenRefreshScheduler.dispose();
    daemon.accountHealthSweeper.dispose();
    throw err;
  }

  try {
    const plan = buildCliSpawnPlan({
      platform: process.platform,
      cliName: cli,
      cliArgs: [...(launch.extraArgs ?? []), ...passthrough],
      resolveInPath: deps?.resolveInPath,
    });
    // Banner — NEVER prints the route token.
    console.info(`launching ${cli} via omnicross proxy ${launch.baseUrl}`);
    console.info(`  provider: ${values.provider}  model: ${values.model}`);
    const spawnCli = deps?.spawnCli ?? spawnCliInherit;
    return await spawnCli({
      ...plan,
      env: { ...process.env, ...launch.env },
      cwd: values.cwd,
    });
  } finally {
    launch.onSessionEnd();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    daemon.tokenRefreshScheduler.dispose();
    daemon.accountHealthSweeper.dispose();
  }
}

/** Dispatch to the per-CLI builder (design D2/D3). */
async function buildLaunchConfig(
  cli: LaunchCliId,
  llmConfig: Parameters<typeof buildClaudeCliLaunchConfig>[0]['llmConfig'],
  opts: { providerId: string; model: string },
): Promise<ChatCliLaunchConfig & { extraArgs?: string[] }> {
  const common = {
    llmConfig,
    providerId: opts.providerId,
    model: opts.model,
    // Stable, bounded session id — pool failover (poolseam) fires on launch
    // traffic with one binding per CLI flavor.
    sessionId: `launch:${cli}`,
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
    default: {
      const _exhaustive: never = cli;
      throw new Error(`Unsupported launch CLI: ${String(_exhaustive)}`);
    }
  }
}

/** Default spawn: stdio inherit (real TTY), signal forwarding, exit-code relay. */
function spawnCliInherit(plan: {
  command: string;
  args: string[];
  viaCmdShim: boolean;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      stdio: 'inherit',
      env: plan.env,
      cwd: plan.cwd,
      // Only the cmd.exe fallback needs verbatim args (we pre-quoted them).
      windowsVerbatimArguments: plan.viaCmdShim || undefined,
    });
    const onSignal = (sig: NodeJS.Signals) => {
      try {
        child.kill(sig);
      } catch {
        // best-effort
      }
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const detach = () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };
    child.on('error', (err) => {
      detach();
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            `launch: "${plan.command}" not found on PATH — install the CLI first.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('exit', (code, signal) => {
      detach();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
