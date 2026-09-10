/**
 * commands/chatgpt-web.ts — `omnicross chatgpt-web check|launch`.
 *
 * EXPERIMENTAL bridge driver: starts the loopback ChatGPT Web Responses bridge
 * (browser-driven via the user's Chrome over CDP) and — for `launch` — spawns
 * Codex wired at it through `-c` config overrides (the same redirection
 * mechanism `omnicross launch codex` uses, but pointed at this bridge and
 * carrying its own env-key token; no daemon/proxy boot is involved).
 *
 * `check` verifies the CDP endpoint, the ChatGPT login, and (optionally, with
 * --smoke) runs one real browser turn.
 *
 * @module @omnicross/daemon/commands/chatgpt-web
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { buildCliSpawnPlan } from './launch';

const DEFAULT_MODEL = 'chatgpt-web/high';
const DEFAULT_PORT = 17850;

/** Env var naming the bridge token in the Codex provider block. */
export const CHATGPT_WEB_TOKEN_ENV = 'OMNICROSS_CHATGPT_WEB_TOKEN';

const PROVIDER_NAME = 'omnicross-chatgptweb';

/** `-c` overrides pointing Codex at the bridge (mirrors codex-proxy-env's builder). */
export function buildChatGptWebConfigOverrides(baseUrl: string): string[] {
  return [
    '-c',
    `model_provider="${PROVIDER_NAME}"`,
    '-c',
    `model_providers.${PROVIDER_NAME}.name="OmniCross ChatGPT Web (experimental)"`,
    '-c',
    `model_providers.${PROVIDER_NAME}.base_url="${baseUrl}/v1"`,
    '-c',
    `model_providers.${PROVIDER_NAME}.wire_api="responses"`,
    '-c',
    `model_providers.${PROVIDER_NAME}.env_key="${CHATGPT_WEB_TOKEN_ENV}"`,
    '-c',
    'disable_response_storage=true',
  ];
}

/**
 * Win32 hardening: npm `.cmd` shims re-quote argv through cmd.exe, which
 * splits values containing spaces (e.g. a provider name). When the shim
 * references a JS entry (`"%dp0%\node_modules\…\bin\….js"`), spawn it directly
 * with `process.execPath` so the argument array survives verbatim.
 */
export function resolveWindowsJsEntry(cmdShimPath: string): string | null {
  try {
    const content = readFileSync(cmdShimPath, 'utf8');
    const match = content.match(/"%dp0%\\([^"]+\.js)"/);
    if (!match) return null;
    const directory = cmdShimPath.slice(0, Math.max(cmdShimPath.lastIndexOf('\\'), cmdShimPath.lastIndexOf('/')) + 1);
    const entry = directory + match[1];
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** Run the `chatgpt-web` subcommand; returns the CLI exit code. */
export async function runChatgptWeb(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand !== 'check' && subcommand !== 'launch') {
    printUsage();
    return subcommand === 'help' || subcommand === '--help' ? 0 : 1;
  }
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const passthrough = sep === -1 ? [] : argv.slice(sep + 1);

  const { values } = parseArgs({
    args: own.slice(1),
    options: {
      model: { type: 'string', short: 'm' },
      port: { type: 'string' },
      'cdp-port': { type: 'string' },
      cwd: { type: 'string' },
      smoke: { type: 'boolean' },
      'skip-check': { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const cdpPort = parsePortOption(values['cdp-port'], '--cdp-port');
  const port = subcommand === 'launch' ? parsePortOption(values.port, '--port') ?? DEFAULT_PORT : undefined;
  if (cdpPort === null || port === null) return 1;

  // Heavy deps (jsdom / tiktoken) load only when the command actually runs.
  const chatgptWeb = await import('@omnicross/chatgpt-web');

  if (subcommand === 'check') {
    return runCheck(chatgptWeb, { cdpPort, smoke: values.smoke === true });
  }

  const model = values.model ?? DEFAULT_MODEL;
  const bridgeModule = await import('@omnicross/chatgpt-web/server');
  if (values['skip-check'] !== true) {
    const ok = await runCheck(chatgptWeb, { cdpPort, smoke: false });
    if (ok !== 0) return ok;
  }

  const token = bridgeModule.generateBridgeToken();
  const bridge = await bridgeModule.startChatGptWebBridge({
    port,
    authToken: token,
    cdpPort,
    onError: (error) => console.error(`[chatgpt-web] ${error.message}`),
  });
  console.info(`chatgpt-web bridge listening on ${bridge.baseUrl} (model: ${model})`);

  const extraArgs = [...buildChatGptWebConfigOverrides(bridge.baseUrl), '--model', model, ...passthrough];
  const plan = buildCliSpawnPlan({
    platform: process.platform,
    cliName: 'codex',
    cliArgs: extraArgs,
  });
  // Prefer the shim's real JS entry on win32 (space-safe argv, no cmd.exe).
  const spawnPlan =
    plan.viaCmdShim && process.platform === 'win32'
      ? (() => {
          const entry = resolveWindowsJsEntry(plan.command);
          return entry
            ? { command: process.execPath, args: [entry, ...plan.args.slice(4)], viaCmdShim: false }
            : plan;
        })()
      : plan;
  console.info(`launching codex against the chatgpt-web bridge (provider: ${PROVIDER_NAME})`);
  const exitCode = await spawnInherit({
    ...spawnPlan,
    env: { ...process.env, [CHATGPT_WEB_TOKEN_ENV]: token },
    cwd: values.cwd,
  });
  await bridge.stop();
  return exitCode;
}

function parsePortOption(value: string | undefined, label: string): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    console.error(`chatgpt-web: ${label} must be an integer in 1..65535`);
    return null;
  }
  return parsed;
}

type ChatgptWebModule = typeof import('@omnicross/chatgpt-web');

async function runCheck(chatgptWeb: ChatgptWebModule, options: { cdpPort?: number; smoke: boolean }): Promise<number> {
  const connection = new chatgptWeb.CdpConnection({ explicitPort: options.cdpPort });
  try {
    console.info('probing Chrome remote debugging…');
    await connection.ensureConnected();
    console.info(`  connected: ${connection.describeEndpoint()}`);
    console.info('probing ChatGPT session (opens one background tab)…');
    const inspection = await chatgptWeb.inspectChatGptSession(connection, { detectCapabilities: true });
    if (!inspection.authenticated) {
      console.error(`  NOT signed in: ${inspection.detail ?? inspection.url}`);
      return 1;
    }
    const capabilities = inspection.capabilities;
    if (!capabilities) {
      console.error('  capability probe did not complete');
      return 1;
    }
    console.info(
      `  account: ${capabilities.solAvailable ? 'Sol selector' : 'Luna-only'}${capabilities.proAvailable ? ' + Pro' : ''}`,
    );
    const routes = await chatgptWeb.availableChatGptWebModelRoutes(capabilities);
    console.info(`  models: ${routes.map((route) => route.slug).join(', ')}`);
    if (options.smoke) {
      console.info('running one smoke browser turn…');
      const { runChatGptWebSmokeTurn } = await import('@omnicross/chatgpt-web/chatgpt/turn');
      const route = routes.find((candidate) => !candidate.isLuna) ?? routes[0];
      if (!route) {
        console.error('  no route available for the smoke turn');
        return 1;
      }
      let answer = '';
      for await (const event of runChatGptWebSmokeTurn(connection, route)) {
        if (event.type === 'text_delta') answer += event.text;
        if (event.type === 'error') {
          console.error(`  smoke turn failed: ${event.message}`);
          return 1;
        }
      }
      const ok = answer.includes('OMNICROSS WEB READY');
      console.info(`  smoke turn: ${ok ? 'PASS' : `unexpected answer: ${answer.slice(0, 200)}`}`);
      if (!ok) return 1;
    }
    console.info('chatgpt-web: ready');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ${message}`);
    if (/not reachable|WebSocket/i.test(message)) {
      console.error(`\n${chatgptWeb.CHROME_DEBUG_SETUP_GUIDANCE}`);
    }
    return 1;
  } finally {
    connection.close();
  }
}

/** stdio-inherit spawn with signal forwarding (mirrors launch.ts's helper). */
function spawnInherit(plan: {
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
        reject(new Error('chatgpt-web: "codex" not found on PATH — install the Codex CLI first.'));
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

function printUsage(): void {
  console.info(`omnicross chatgpt-web — EXPERIMENTAL ChatGPT Web bridge for Codex (browser automation over your Chrome)

Usage:
  omnicross chatgpt-web check [--cdp-port <n>] [--smoke]
                                           Verify Chrome remote debugging, the chatgpt.com login,
                                           and account capabilities (--smoke also sends one real turn).
  omnicross chatgpt-web launch [--model <chatgpt-web/…>] [--port <n>] [--cdp-port <n>] [--cwd <dir>]
                               [--skip-check] [-- <codex-args…>]
                                           Start the bridge and launch Codex wired to it.
                                           Default model: ${DEFAULT_MODEL}; default port: ${DEFAULT_PORT}.

Requires Chrome with remote debugging enabled (chrome://inspect/#remote-debugging)
and an active chatgpt.com login in that Chrome. Unofficial automation — use your
own account and obey the applicable OpenAI terms.`);
}
