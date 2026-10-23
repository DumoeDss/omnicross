import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTerminal } from '../admin/cliLaunch';
import {
  startTerminalLeaseRenewal,
  TERMINAL_LEASE_MAX_LIFETIME_MS,
  TERMINAL_LEASE_RENEW_INTERVAL_MS,
} from '../routeLeaseRenewal';

const TOKEN_CANARY = 'route-token-canary-must-never-appear-in-argv';
const LIFECYCLE_CHILD_WATCHDOG_MS = 10_000;
const LIFECYCLE_TEST_TIMEOUT_MS = 15_000;

function privatePipe(name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\omnicross-${name}-${process.pid}`
    : join(tmpdir(), `omnicross-${name}-${process.pid}.sock`);
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for terminal launch state');
}

interface LifecycleChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface LifecycleChild {
  close(): Promise<void>;
  run(source: string): Promise<LifecycleChildResult>;
}

async function startLifecycleChild(signal: AbortSignal): Promise<LifecycleChild> {
  signal.throwIfAborted();
  const readyMarker = '\u001eomnicross-lifecycle-ready\u001f';
  const wrappedSource = `
    import * as net from 'node:net';
    import { openTerminal } from ${JSON.stringify(CLI_LAUNCH_MODULE_URL)};
    let source = '';
    process.stdin.setEncoding('utf8').on('data', (chunk) => { source += chunk; });
    process.stdin.once('end', () => {
      // The preparation pipe must not participate in the lifecycle under test.
      process.stdin.unref?.();
      process.stdin.destroy();
      Promise.resolve().then(() => new Function('openTerminal', 'net', source)(openTerminal, net))
        .catch((error) => { console.error(error); process.exitCode = 1; });
    });
    process.stdout.write(${JSON.stringify(readyMarker)});
  `;
  const spawnAt = Date.now();
  // The tsx CLI adds a launcher process; on Windows killing it can leave the
  // evaluated Node process alive. Load tsx in the process the watchdog owns.
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', wrappedSource], {
    cwd: process.cwd(),
    signal,
    // An inherited Node compile cache writes hundreds of loader/dependency files
    // after JS 'exit', delaying OS process exit without any live listener/socket.
    // Keep that toolchain disk work outside this strict reference-lifetime test.
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyAt: number | undefined;
  let exitAt: number | undefined;
  let closeAt: number | undefined;
  let spawnError: Error | undefined;
  let inputError: Error | undefined;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  // A stdout frame avoids an IPC channel adding a ref to the child under test.
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    if (readyAt !== undefined) return;
    const markerIndex = stdout.indexOf(readyMarker);
    if (markerIndex === -1) return;
    readyAt = Date.now();
    stdout = stdout.slice(0, markerIndex) + stdout.slice(markerIndex + readyMarker.length);
    markReady();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', (error) => { inputError = error; });
  child.once('error', (error) => { spawnError = error; });
  child.once('exit', () => { exitAt = Date.now(); });
  const closed = new Promise<{ code: number | null }>((resolve) => {
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      closeAt = Date.now();
      resolve({ code });
    });
  });
  const close = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };
  // Vitest owns the preparation deadline and aborts its context on hook timeout.
  try {
    await Promise.race([
      ready,
      closed.then(() => {
        throw spawnError ?? new Error(`lifecycle child exited before module readiness: ${stderr}`);
      }),
      aborted,
    ]);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    close,
    async run(source: string): Promise<LifecycleChildResult> {
      const runAt = Date.now();
      let watchdog: NodeJS.Timeout | undefined;
      try {
        signal.throwIfAborted();
        const result = await Promise.race([
          closed,
          aborted,
          // Fake timers cannot detect another Node event loop staying alive.
          // Start the real deadline at execution, not cold module loading.
          new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(() => {
              const phase = exitAt === undefined ? 'listener lifecycle' : 'stdio close';
              const processState = {
                pid: child.pid,
                exitAfterExecutionMs: exitAt === undefined ? null : exitAt - runAt,
                closeAfterExecutionMs: closeAt === undefined ? null : closeAt - runAt,
                exitCode: child.exitCode,
                signalCode: child.signalCode,
                stdout: { ended: child.stdout.readableEnded, destroyed: child.stdout.destroyed },
                stderr: { ended: child.stderr.readableEnded, destroyed: child.stderr.destroyed },
              };
              reject(new Error(`lifecycle child did not exit during ${phase}: startupMs=${readyAt! - spawnAt}, executionMs=${Date.now() - runAt}, processState=${JSON.stringify(processState)}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)}`));
            }, LIFECYCLE_CHILD_WATCHDOG_MS);
            child.stdin.end(source);
          }),
        ]);
        if (spawnError) throw spawnError;
        if (inputError) throw inputError;
        return { ...result, stdout, stderr, elapsedMs: exitAt! - runAt };
      } finally {
        clearTimeout(watchdog);
        await close();
      }
    },
  };
}

const CLI_LAUNCH_MODULE_URL = pathToFileURL(join(process.cwd(), 'packages/daemon/src/admin/cliLaunch.ts')).href;

afterEach(() => {
  vi.useRealTimers();
});

describe('POSIX terminal launch secret boundary', () => {
  it.each(['darwin', 'linux'] as const)('%s keeps the route token out of actual spawn argv', async (platform) => {
    const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const spawnProcess = vi.fn((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      return { once: vi.fn(), unref: vi.fn() };
    });
    const cleanup = openTerminal({
      cli: 'codex',
      command: 'codex',
      extraArgs: ['-c', 'model_provider="omnicross"'],
      env: { OMNICROSS_CODEX_ROUTE_TOKEN: TOKEN_CANARY },
      cwd: '/tmp/workspace',
      platform,
    }, spawnProcess as never, { socketPath: privatePipe(`argv-${platform}`) });

    await waitFor(() => calls.length === 1);
    expect(JSON.stringify(calls[0].args)).not.toContain(TOKEN_CANARY);
    if (platform === 'darwin') {
      expect(calls[0].env?.OMNICROSS_CODEX_ROUTE_TOKEN).toBeUndefined();
      const commandFile = calls[0].args.at(-1)!;
      expect(readFileSync(commandFile, 'utf8')).not.toContain(TOKEN_CANARY);
      expect(readFileSync(join(dirname(commandFile), 'bootstrap.cjs'), 'utf8')).not.toContain(TOKEN_CANARY);
    } else {
      expect(calls[0].env?.OMNICROSS_CODEX_ROUTE_TOKEN).toBe(TOKEN_CANARY);
    }
    cleanup();
  });

  it('delivers every macOS descriptor value to the eventual command over private IPC', async () => {
    const descriptor = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8767',
      ANTHROPIC_AUTH_TOKEN: TOKEN_CANARY,
      ANTHROPIC_API_KEY: 'route-lease',
      ANTHROPIC_MODEL: 'claude-opus-5',
    };
    const resultPipe = privatePipe('result');
    const descriptorPipe = privatePipe('descriptor');
    let received: Record<string, string> | undefined;
    const resultServer = createServer((socket) => {
      let payload = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { payload += chunk; });
      socket.on('end', () => { received = JSON.parse(payload) as Record<string, string>; });
    });
    await new Promise<void>((resolve, reject) => resultServer.listen(resultPipe, resolve).once('error', reject));

    let launchDir = '';
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      const commandFile = args.at(-1)!;
      launchDir = dirname(commandFile);
      const bootstrapFile = join(launchDir, 'bootstrap.cjs');
      const reporter = `const net=require('node:net');const keys=${JSON.stringify(Object.keys(descriptor))};const out=Object.fromEntries(keys.map(k=>[k,process.env[k]]));net.createConnection(process.argv[1],function(){this.end(JSON.stringify(out))})`;
      const child = spawn(process.execPath, [bootstrapFile, descriptorPipe, launchDir, '', process.execPath, '-e', reporter, resultPipe], { stdio: 'ignore' });
      return { once: child.once.bind(child), unref: child.unref.bind(child) };
    });

    const cleanup = openTerminal({
      cli: 'claude', command: process.execPath, extraArgs: [], env: descriptor, platform: 'darwin',
    }, spawnProcess as never, { socketPath: descriptorPipe, timeoutMs: 2_000 });

    await waitFor(() => received !== undefined);
    expect(received).toEqual(descriptor);
    await new Promise<void>((resolve) => resultServer.close(() => resolve()));
    await waitFor(() => {
      cleanup();
      return !existsSync(launchDir);
    });
  });

  describe.skipIf(process.platform !== 'darwin' || process.env['OMNICROSS_REAL_MAC_TERMINAL_TEST'] !== '1')(
    'real macOS Terminal boundary (explicit opt-in)',
    () => {
      it('delivers the canary to the command launched by Terminal', async () => {
        const resultPipe = privatePipe('real-mac-result');
        let received = '';
        const resultServer = createServer((socket) => {
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => { received += chunk; });
        });
        await new Promise<void>((resolve, reject) => resultServer.listen(resultPipe, resolve).once('error', reject));
        const reporter = `require('node:net').createConnection(process.argv[1],function(){this.end(process.env.OMNICROSS_CODEX_ROUTE_TOKEN||'')})`;

        const cleanup = openTerminal({
          cli: 'codex',
          command: process.execPath,
          extraArgs: ['-e', reporter, resultPipe],
          env: { OMNICROSS_CODEX_ROUTE_TOKEN: TOKEN_CANARY },
          platform: 'darwin',
        });

        await waitFor(() => received.length > 0);
        expect(received).toBe(TOKEN_CANARY);
        cleanup();
        await new Promise<void>((resolve) => resultServer.close(() => resolve()));
      });
    },
  );

  describe('natural child-process exit', () => {
    let child: LifecycleChild | undefined;

    // Preparing the real Node/tsx process is separate from the strict lifecycle
    // deadline, and applies only to the two process-exit regressions.
    beforeEach(async (context) => {
      child = await startLifecycleChild(context.signal);
    });

    afterEach(async () => {
      await child?.close();
      child = undefined;
    });

    it('an unconsumed listener cannot keep a child process alive before its timeout', async () => {
      const source = `
        const cleanup = openTerminal(
          { cli: 'codex', command: 'codex', extraArgs: [], env: { OMNICROSS_CODEX_ROUTE_TOKEN: 'child-canary' }, platform: 'darwin' },
          () => ({ once() {}, unref() {} }),
          {
            socketPath: ${JSON.stringify(privatePipe('child-listener'))},
            timeoutMs: 120000,
            onListening: () => process.stdout.write('listening'),
          },
        );
        process.once('beforeExit', cleanup);
      `;
      const result = await child!.run(source);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('listening');
      expect(result.elapsedMs).toBeLessThan(LIFECYCLE_CHILD_WATCHDOG_MS);
    }, LIFECYCLE_TEST_TIMEOUT_MS);

    it('a claimed non-closing peer cannot keep a child process alive', async () => {
      const source = `
        const socketPath = ${JSON.stringify(privatePipe('child-peer'))};
        let cleanup;
        let claimWatchdog;
        cleanup = openTerminal(
          { cli: 'codex', command: 'codex', extraArgs: [], env: { OMNICROSS_CODEX_ROUTE_TOKEN: 'child-canary' }, platform: 'darwin' },
          () => ({ once() {}, unref() {} }),
          {
            socketPath,
            timeoutMs: 120000,
            onListening: () => {
              process.stdout.write('listening');
              // A real child watchdog bounds OS-pipe claim; parent fake timers
              // cannot advance this independent Node event loop.
              claimWatchdog = setTimeout(() => {
                process.stderr.write('timed out waiting for claimed peer');
                process.exitCode = 1;
              }, 2000);
              const peer = net.createConnection(socketPath);
              peer.pause();
              peer.unref();
            },
            onClaimed: () => {
              clearTimeout(claimWatchdog);
              cleanup();
              process.stdout.write('claimed-cleaned');
            },
          },
        );
      `;
      const result = await child!.run(source);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('listeningclaimed-cleaned');
      expect(result.elapsedMs).toBeLessThan(LIFECYCLE_CHILD_WATCHDOG_MS);
    }, LIFECYCLE_TEST_TIMEOUT_MS);
  });

  it('explicitly destroys a claimed non-closing accepted socket during cleanup', async () => {
    const socketPath = privatePipe('claimed-destroy');
    let acceptedDestroyCalls = 0;
    let accepted = false;
    let cleanup!: () => void;
    cleanup = openTerminal({
      cli: 'codex', command: 'codex', extraArgs: [], env: { OMNICROSS_CODEX_ROUTE_TOKEN: TOKEN_CANARY }, platform: 'darwin',
    }, () => ({ once: vi.fn(), unref: vi.fn() }) as never, {
      socketPath,
      timeoutMs: 2_000,
      onListening: () => {
        const peer = createConnection(socketPath);
        peer.pause();
        peer.unref();
      },
      onAccepted: (socket) => {
        accepted = true;
        const destroy = socket.destroy.bind(socket);
        socket.destroy = (...args) => {
          acceptedDestroyCalls += 1;
          return destroy(...args);
        };
      },
      onClaimed: () => setImmediate(cleanup),
    });

    await waitFor(() => accepted && acceptedDestroyCalls === 1);
    expect(acceptedDestroyCalls).toBe(1);
    cleanup();
    expect(acceptedDestroyCalls).toBe(1);
  });

  it('serves descriptor bytes to exactly one of two racing connections', async () => {
    const socketPath = privatePipe('one-shot');
    const payloads = ['', ''];
    const completions: Array<Promise<void>> = [];
    const cleanup = openTerminal({
      cli: 'codex', command: 'codex', extraArgs: [], env: { OMNICROSS_CODEX_ROUTE_TOKEN: TOKEN_CANARY }, platform: 'darwin',
    }, () => ({ once: vi.fn(), unref: vi.fn() }) as never, {
      socketPath,
      timeoutMs: 2_000,
      onListening: () => {
        for (let index = 0; index < 2; index += 1) {
          completions.push(new Promise<void>((resolve) => {
            const client = createConnection(socketPath);
            client.setEncoding('utf8');
            client.on('data', (chunk) => { payloads[index] += chunk; });
            client.on('error', () => resolve());
            client.on('close', () => resolve());
          }));
        }
      },
    });

    await waitFor(() => completions.length === 2);
    await Promise.all(completions);
    expect(payloads.filter((payload) => payload.includes(TOKEN_CANARY))).toHaveLength(1);
    expect(payloads.filter((payload) => payload.length === 0)).toHaveLength(1);
    cleanup();
  });

  it('notifies once and cleans private IPC after an opener error', async () => {
    let launchDir = '';
    const onFailure = vi.fn();
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      launchDir = dirname(args.at(-1)!);
      return {
        once: (event: string, listener: (error: Error) => void) => {
          if (event === 'error') queueMicrotask(() => listener(new Error('open failed')));
        },
        unref: vi.fn(),
      };
    });
    const cleanup = openTerminal({
      cli: 'codex',
      command: 'codex',
      extraArgs: [],
      env: { OMNICROSS_CODEX_ROUTE_TOKEN: TOKEN_CANARY },
      platform: 'darwin',
      onFailure,
    }, spawnProcess as never, { socketPath: privatePipe('opener-error'), timeoutMs: 2_000 });

    await waitFor(() => launchDir.length > 0 && !existsSync(launchDir));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(() => cleanup()).not.toThrow();
    expect(() => cleanup()).not.toThrow();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps cleanup non-throwing and idempotent when artifact removal throws EPERM', async () => {
    const socketPath = privatePipe('cleanup-eperm');
    const removeArtifacts = vi.fn(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    let acceptedDestroyCalls = 0;
    let launchDir = '';
    let cleanup!: () => void;
    cleanup = openTerminal({
      cli: 'codex', command: 'codex', extraArgs: [], env: { OMNICROSS_CODEX_ROUTE_TOKEN: TOKEN_CANARY }, platform: 'darwin',
    }, ((_command: string, args: readonly string[]) => {
      launchDir = dirname(args.at(-1)!);
      return { once: vi.fn(), unref: vi.fn() };
    }) as never, {
      socketPath,
      timeoutMs: 2_000,
      removeArtifacts,
      onListening: () => {
        const peer = createConnection(socketPath);
        peer.pause();
        peer.unref();
      },
      onAccepted: (socket) => {
        const destroy = socket.destroy.bind(socket);
        socket.destroy = (...args) => {
          acceptedDestroyCalls += 1;
          return destroy(...args);
        };
      },
      onClaimed: cleanup,
    });

    await waitFor(() => acceptedDestroyCalls === 1);
    const removalsBeforeExplicitCleanup = removeArtifacts.mock.calls.length;
    expect(() => cleanup()).not.toThrow();
    expect(() => cleanup()).not.toThrow();
    expect(acceptedDestroyCalls).toBe(1);
    expect(removeArtifacts).toHaveBeenCalledTimes(removalsBeforeExplicitCleanup + 2);
    rmSync(launchDir, { recursive: true, force: true });
  });

  it('cleans an unconsumed macOS descriptor channel after its timeout', async () => {
    let launchDir = '';
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      launchDir = dirname(args.at(-1)!);
      return { once: vi.fn(), unref: vi.fn() };
    });
    const cleanup = openTerminal({
      cli: 'codex', command: 'codex', extraArgs: [], env: { OMNICROSS_CODEX_ROUTE_TOKEN: TOKEN_CANARY }, platform: 'darwin',
    }, spawnProcess as never, { socketPath: privatePipe('timeout'), timeoutMs: 20 });

    await waitFor(() => launchDir.length > 0 && !existsSync(launchDir));
    cleanup();
  });
});

describe('built-in terminal lease renewal', () => {
  it('renews beyond 600 seconds, stops on cleanup, and retains a hard orphan bound', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
    const manager = { renew: vi.fn() };
    const stop = startTerminalLeaseRenewal(manager as never, 'lease-public-id');

    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(manager.renew).toHaveBeenCalledTimes(2);
    expect(manager.renew).toHaveBeenCalledWith('lease-public-id', 600);

    stop();
    vi.advanceTimersByTime(TERMINAL_LEASE_RENEW_INTERVAL_MS);
    expect(manager.renew).toHaveBeenCalledTimes(2);

    const boundedManager = { renew: vi.fn() };
    startTerminalLeaseRenewal(boundedManager as never, 'bounded-lease');
    vi.advanceTimersByTime(TERMINAL_LEASE_MAX_LIFETIME_MS + TERMINAL_LEASE_RENEW_INTERVAL_MS);
    const renewalsAtBound = boundedManager.renew.mock.calls.length;
    vi.advanceTimersByTime(TERMINAL_LEASE_RENEW_INTERVAL_MS * 2);
    expect(boundedManager.renew).toHaveBeenCalledTimes(renewalsAtBound);
  });
});
