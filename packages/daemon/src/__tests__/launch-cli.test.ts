/**
 * launch-cli.test.ts — unit tests for `omnicross launch` (commands/launch.ts).
 *
 * Covers (spec `daemon-cli-launch`):
 *  - `buildCliSpawnPlan` (PURE, design D5): posix passthrough; win32 `.exe`
 *    direct; win32 `.cmd` shim → ComSpec /d /s /c with per-element quoting;
 *    metacharacter/quote args REJECTED on the `.cmd` path (codex's TOML
 *    overrides contain `"` by contract → guarded error, never cmd-corrupted);
 *    no candidate → bare-name fallthrough (ENOENT surfaces the install hint).
 *  - `runLaunch` dispatch: per-CLI env/argv construction via an injected
 *    `spawnCli` stub (no real CLI spawned); route-token (not the real key) in
 *    the child env; route removed + proxy stopped after exit.
 *  - error paths: unknown CLI / missing flags / missing provider — all with
 *    ZERO leftover routes.
 *
 * @module @omnicross/daemon/__tests__/launch-cli.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getProviderProxy } from '@omnicross/core/provider-proxy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetDaemonSingletonsForTests } from '../bootstrap';
import { buildCliSpawnPlan, type LaunchDeps, runLaunch } from '../commands/launch';

const PROVIDER_REAL_KEY = 'sk-real-upstream-key-9999';

let tmpDir: string;
let configPath: string;
let masterKeyArg: string[];

beforeEach(() => {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-launch-'));
  configPath = join(tmpDir, 'config.json');
  // Hermetic master key location (plaintext config never resolves it — lazy box).
  masterKeyArg = ['--master-key-file', join(tmpDir, 'master.key')];
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: [
        {
          id: 'mock',
          apiFormat: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: PROVIDER_REAL_KEY,
          models: ['mock-model'],
        },
        {
          id: 'anth',
          apiFormat: 'anthropic',
          baseUrl: 'http://127.0.0.1:1',
          apiKey: PROVIDER_REAL_KEY,
          models: ['claude-x'],
        },
      ],
    }),
  );
});

afterEach(() => {
  resetDaemonSingletonsForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Run launch with a capturing spawn stub; returns the captured plan. */
async function launchWithStub(cli: string, extra: string[] = []) {
  let captured: Parameters<NonNullable<LaunchDeps['spawnCli']>>[0] | null = null;
  const code = await runLaunch(
    [cli, '--provider', cli === 'claude' ? 'anth' : 'mock', '--model', 'mock-model', '--config', configPath, ...masterKeyArg, ...extra],
    {
      spawnCli: async (plan) => {
        captured = plan;
        return 0;
      },
      // Hermetic vs the host PATH (this dev machine really has codex.cmd!).
      resolveInPath: () => null,
    },
  );
  expect(code).toBe(0);
  if (!captured) throw new Error('spawnCli was not invoked');
  return captured as Parameters<NonNullable<LaunchDeps['spawnCli']>>[0];
}

describe('buildCliSpawnPlan (pure, design D5)', () => {
  const URLISH = 'http://127.0.0.1:5555/openai';

  it('posix: bare name + args verbatim, no shim', () => {
    const plan = buildCliSpawnPlan({
      platform: 'linux',
      cliName: 'codex',
      cliArgs: ['-c', `model_provider="omnicross"`],
    });
    expect(plan).toEqual({
      command: 'codex',
      args: ['-c', 'model_provider="omnicross"'],
      viaCmdShim: false,
    });
  });

  it('win32: .exe resolved → direct spawn, args verbatim (quotes allowed)', () => {
    const plan = buildCliSpawnPlan({
      platform: 'win32',
      cliName: 'codex',
      cliArgs: ['-c', `model_providers.omnicross.base_url="${URLISH}"`],
      resolveInPath: (c) => (c === 'codex.exe' ? 'C:\\bin\\codex.exe' : null),
    });
    expect(plan.command).toBe('C:\\bin\\codex.exe');
    expect(plan.viaCmdShim).toBe(false);
    expect(plan.args[1]).toContain(URLISH);
  });

  it('win32: .cmd shim → ComSpec /d /s /c with each element quoted', () => {
    const plan = buildCliSpawnPlan({
      platform: 'win32',
      cliName: 'qwen',
      cliArgs: ['chat', 'plain-arg'],
      resolveInPath: (c) => (c === 'qwen.cmd' ? 'C:\\npm\\qwen.cmd' : null),
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(plan.viaCmdShim).toBe(true);
    expect(plan.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\npm\\qwen.cmd" "chat" "plain-arg""',
    ]);
  });

  it('win32 .cmd path REJECTS quote/metachar args (refuse > corrupt)', () => {
    expect(() =>
      buildCliSpawnPlan({
        platform: 'win32',
        cliName: 'codex',
        cliArgs: ['-c', `model_provider="omnicross"`],
        resolveInPath: (c) => (c === 'codex.cmd' ? 'C:\\npm\\codex.cmd' : null),
      }),
    ).toThrow(/Refusing to pass them through cmd\.exe/);
    for (const bad of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a%b']) {
      expect(() =>
        buildCliSpawnPlan({
          platform: 'win32',
          cliName: 'qwen',
          cliArgs: [bad],
          resolveInPath: (c) => (c === 'qwen.cmd' ? 'C:\\npm\\qwen.cmd' : null),
        }),
      ).toThrow(/Refusing/);
    }
  });

  it('win32: no candidate found → bare name (ENOENT later surfaces install hint)', () => {
    const plan = buildCliSpawnPlan({
      platform: 'win32',
      cliName: 'claude',
      cliArgs: [],
      resolveInPath: () => null,
    });
    expect(plan).toEqual({ command: 'claude', args: [], viaCmdShim: false });
  });
});

describe('runLaunch dispatch (spawn stub — env/argv per builder contract)', () => {
  it('claude → ANTHROPIC_* env, token not the real key, route cleaned up', async () => {
    const plan = await launchWithStub('claude');
    expect(plan.env['ANTHROPIC_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(plan.env['ANTHROPIC_AUTH_TOKEN']).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.env['ANTHROPIC_API_KEY']).toBe('omnicross-proxy');
    expect(JSON.stringify(plan.env)).not.toContain(PROVIDER_REAL_KEY);
    expect(getProviderProxy().routeCount()).toBe(0);
  });

  it('codex → -c overrides in args + OPENAI_API_KEY token sentinel', async () => {
    const plan = await launchWithStub('codex');
    expect(plan.args).toContain('-c');
    expect(plan.args.join(' ')).toContain('model_provider="omnicross"');
    expect(plan.args.join(' ')).toContain('wire_api="responses"');
    expect(plan.env['OPENAI_API_KEY']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(plan.env)).not.toContain(PROVIDER_REAL_KEY);
  });

  it('gemini → GOOGLE_GEMINI_BASE_URL root + GEMINI_API_KEY token + GCA off', async () => {
    const plan = await launchWithStub('gemini');
    expect(plan.env['GOOGLE_GEMINI_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(plan.env['GEMINI_API_KEY']).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.env['GOOGLE_GENAI_USE_GCA']).toBe('false');
  });

  it('qwen → OPENAI_BASE_URL /v1 + token; passthrough args after -- reach argv', async () => {
    const plan = await launchWithStub('qwen', ['--', '--resume', 'sess1']);
    expect(plan.env['OPENAI_BASE_URL']).toMatch(/\/v1$/);
    expect(plan.env['OPENAI_API_KEY']).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.args).toEqual(expect.arrayContaining(['--resume', 'sess1']));
  });

  it('copilot → COPILOT_PROVIDER_* env', async () => {
    const plan = await launchWithStub('copilot');
    expect(plan.env['COPILOT_PROVIDER_TYPE']).toBe('openai');
    expect(plan.env['COPILOT_PROVIDER_API_KEY']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('opencode → OPENCODE_CONFIG temp file + token env; file removed on exit', async () => {
    let configFileDuringRun = '';
    const code = await runLaunch(
      ['opencode', '--provider', 'mock', '--model', 'mock-model', '--config', configPath, ...masterKeyArg],
      {
        spawnCli: async (plan) => {
          configFileDuringRun = plan.env['OPENCODE_CONFIG'] ?? '';
          expect(configFileDuringRun).toBeTruthy();
          expect(plan.env['OMNICROSS_OPENCODE_TOKEN']).toMatch(/^[0-9a-f]{64}$/);
          return 0;
        },
        resolveInPath: () => null,
      },
    );
    expect(code).toBe(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(configFileDuringRun)).toBe(false); // onSessionEnd cleanup
  });
});

describe('runLaunch error paths (zero leftover routes)', () => {
  it('unknown CLI → lists the supported set, no spawn', async () => {
    await expect(runLaunch(['foobar', '--config', configPath])).rejects.toThrow(
      /claude, codex, gemini, qwen, copilot, opencode/,
    );
  });

  it('missing --provider / --model / --config → clear errors', async () => {
    await expect(runLaunch(['qwen', '--model', 'm', '--config', configPath])).rejects.toThrow(
      /--provider/,
    );
    await expect(runLaunch(['qwen', '--provider', 'mock', '--config', configPath])).rejects.toThrow(
      /--model/,
    );
    await expect(runLaunch(['qwen', '--provider', 'mock', '--model', 'm'])).rejects.toThrow(
      /--config/,
    );
  });

  it('provider not found → builder pre-check throws, proxy stopped, zero routes', async () => {
    await expect(
      runLaunch(
        ['qwen', '--provider', 'nope', '--model', 'm', '--config', configPath, ...masterKeyArg],
        { spawnCli: async () => 0 },
      ),
    ).rejects.toThrow(/provider not found: nope/);
    expect(getProviderProxy().routeCount()).toBe(0);
  });

  it('spawn failure still cleans up the route', async () => {
    await expect(
      runLaunch(
        ['qwen', '--provider', 'mock', '--model', 'm', '--config', configPath, ...masterKeyArg],
        {
          spawnCli: async () => {
            throw new Error('launch: "qwen" not found on PATH — install the CLI first.');
          },
          resolveInPath: () => null,
        },
      ),
    ).rejects.toThrow(/install the CLI first/);
    expect(getProviderProxy().routeCount()).toBe(0);
  });
});
