/**
 * tunnelClient.ts — manage the official openai/tunnel-client runtime.
 *
 * Downloads the pinned release (SHA-256 verified against the release
 * manifest), then drives `runtimes connect` with our MCP command: the tunnel
 * spawns our MCP server as a child and bridges ChatGPT's connector calls to
 * it over an outbound connection (no inbound ports). Status/stop round out
 * the lifecycle. Port of codex-chatgpt-web's tunnel.ts (MIT).
 *
 * @module @omnicross/chatgpt-web/tunnel/tunnelClient
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

export const TUNNEL_VERSION = '0.0.12';
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}`;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const TUNNEL_READY_TIMEOUT_MS = 120_000;

export interface TunnelRuntimeConfig {
  binaryPath: string;
  tunnelId: string;
  runtimeKey: string;
  alias: string;
  profileDir: string;
  /** Command argv the tunnel spawns as its MCP child. */
  mcpCommand: string[];
}

export class TunnelClientError extends Error {
  constructor(message: string, readonly guidance?: string) {
    super(message);
    this.name = 'TunnelClientError';
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function platformAsset(): string {
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'windows' : undefined;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : undefined;
  if (!os || !arch) {
    throw new TunnelClientError(`openai/tunnel-client has no pinned build for ${process.platform}/${process.arch}`);
  }
  return `tunnel-client-v${TUNNEL_VERSION}-${os}-${arch}.zip`;
}

async function fetchBytes(url: string, timeoutMs = 120_000): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
    return bytes;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Download timed out after ${timeoutMs}ms: ${url}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseExpectedChecksum(text: string, asset: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().endsWith(asset));
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`SHA256SUMS.txt has no valid entry for ${asset}`);
  return checksum;
}

export function tunnelBinaryPath(binDir: string): string {
  return join(binDir, process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
}

export function tunnelManifestPath(binDir: string): string {
  return join(binDir, 'tunnel-client-manifest.json');
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Async spawn with output capture (connect/status/stop/version probes). */
function runBinary(executable: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return runBinaryWithEnv(executable, args, timeoutMs);
}

function runBinaryWithEnv(executable: string, args: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ status: 124, stdout, stderr: `${stderr}\n[omnicross timeout after ${timeoutMs}ms]` });
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: `${stderr}\n${String(error)}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

function unzipEntry(archive: Uint8Array, expectedName: string): Uint8Array | undefined {
  // Minimal ZIP reader: locate the central directory, find the entry, inflate
  // via node:zlib raw inflate. Avoids a dependency for exactly one file.
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  // Find EOCD (0x06054b50) from the tail.
  let eocd = -1;
  for (let i = archive.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('tunnel-client archive has no end-of-central-directory record');
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('tunnel-client archive central directory is corrupt');
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    if (basename(name.replaceAll('\\', '/')) === expectedName) {
      if (compression !== 0 && compression !== 8) throw new Error(`tunnel-client archive uses unsupported compression ${compression}`);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = archive.subarray(dataStart, dataStart + compressedSize);
      return compression === 0 ? new Uint8Array(data) : new Uint8Array(inflateRawSync(Buffer.from(data)));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

export interface InstalledTunnelClient {
  binaryPath: string;
  alreadyInstalled: boolean;
}

/** Install (or reuse) the pinned tunnel-client binary under `binDir`. */
export async function installTunnelClient(binDir: string): Promise<InstalledTunnelClient> {
  const executable = tunnelBinaryPath(binDir);
  const manifestFile = tunnelManifestPath(binDir);
  if (existsSync(executable) && existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { tunnelClientVersion?: string; binarySha256?: string };
    const installedBinary = new Uint8Array(readFileSync(executable));
    if (manifest.tunnelClientVersion === TUNNEL_VERSION && manifest.binarySha256 === sha256(installedBinary)) {
      return { binaryPath: executable, alreadyInstalled: true };
    }
  }
  mkdirSync(binDir, { recursive: true });
  const asset = platformAsset();
  const [archive, sums] = await Promise.all([fetchBytes(`${RELEASE_BASE}/${asset}`), fetchBytes(`${RELEASE_BASE}/SHA256SUMS.txt`)]);
  const expected = parseExpectedChecksum(new TextDecoder().decode(sums), asset);
  const archiveHash = sha256(archive);
  if (archiveHash !== expected) throw new TunnelClientError(`Checksum mismatch for ${asset}`);
  const expectedName = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
  const binary = unzipEntry(archive, expectedName);
  if (!binary) throw new TunnelClientError(`${asset} does not contain ${expectedName}`);
  const staged = `${executable}.install-${process.pid}-${randomUUID()}${process.platform === 'win32' ? '.exe' : ''}`;
  writeFileSync(staged, binary);
  if (process.platform !== 'win32') chmodSync(staged, 0o700);
  // Version probe before committing the final destination.
  const probe = await runBinary(staged, ['--version'], 10_000);
  if (!probe.stdout.includes(TUNNEL_VERSION) && !probe.stderr.includes(TUNNEL_VERSION)) {
    rmSync(staged, { force: true });
    throw new TunnelClientError(`Downloaded tunnel-client did not report version ${TUNNEL_VERSION}`);
  }
  rmSync(staged, { force: true });
  writeFileSync(executable, binary);
  if (process.platform !== 'win32') chmodSync(executable, 0o700);
  writeFileSync(
    manifestFile,
    `${JSON.stringify({ version: 1, tunnelClientVersion: TUNNEL_VERSION, asset, archiveSha256: archiveHash, binarySha256: sha256(binary) }, null, 2)}\n`,
  );
  return { binaryPath: executable, alreadyInstalled: false };
}

function redact(value: string): string {
  return value
    .replace(/tunnel_[a-f0-9]{32}/g, '[tunnel-id]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-key]')
    .slice(0, 2_000);
}

export interface TunnelRuntimeStatus {
  ok: boolean;
  detail: string;
  running: boolean;
  healthy: boolean;
  ready: boolean;
}

function commandOutput(result: RunResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return result.status === 0 ? stdout || stderr : [stderr, stdout].filter(Boolean).join('\n');
}

export function parseTunnelStatus(output: string, exitStatus = 0): TunnelRuntimeStatus {
  if (exitStatus !== 0) {
    return { ok: false, running: false, healthy: false, ready: false, detail: redact(output) };
  }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const running = parsed['process_running'] === true;
    const healthy = parsed['healthy'] === true;
    const ready = parsed['ready'] === true;
    const ok = running && healthy && ready;
    return {
      ok,
      running,
      healthy,
      ready,
      detail: ok ? 'process_running=true healthy=true ready=true' : redact(output),
    };
  } catch {
    return { ok: false, running: false, healthy: false, ready: false, detail: `tunnel-client returned non-JSON status: ${redact(output)}` };
  }
}

/** Validate a ChatGPT tunnel id shape (tunnel_ + 32 hex). */
export function isValidTunnelId(value: string): boolean {
  return /^tunnel_[a-f0-9]{32}$/.test(value);
}

/** Write the runtime key to a 0600-ish private file and return its path. */
export function writeRuntimeKey(secretsDir: string, key: string): string {
  mkdirSync(secretsDir, { recursive: true });
  const file = join(secretsDir, 'tunnel-runtime.key');
  writeFileSync(file, key.trim());
  return file;
}

/**
 * Connect the managed runtime (blocking; resolves when healthy/ready).
 * `childEnv` reaches the spawned MCP child through environment inheritance —
 * the tunnel refuses mcp-command argv containing secret-like material.
 */
export async function connectTunnel(config: TunnelRuntimeConfig, childEnv: Record<string, string> = {}): Promise<void> {
  mkdirSync(config.profileDir, { recursive: true });
  const keyFile = writeRuntimeKey(join(config.profileDir, 'secrets'), config.runtimeKey);
  // tunnel-client parses mcp.command with backslash escapes on every platform.
  const mcpCommand = config.mcpCommand.map((token) => `"${token.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(' ');
  const result = await runBinaryWithEnv(config.binaryPath, [
    'runtimes',
    'connect',
    '--alias', config.alias,
    '--profile', 'omnicross-chatgpt-web',
    '--profile-dir', config.profileDir,
    '--tunnel-client-bin', config.binaryPath,
    '--tunnel-id', config.tunnelId,
    '--runtime-api-key', `file:${keyFile}`,
    '--mcp-command', mcpCommand,
    '--json',
  ], TUNNEL_READY_TIMEOUT_MS, childEnv);
  if (result.status !== 0) {
    throw new TunnelClientError(
      `Tunnel managed startup failed: ${redact(commandOutput(result))}`,
      'Check the tunnel id and runtime key, and that the tunnel exists on platform.openai.com.',
    );
  }
}

export async function stopTunnel(config: Pick<TunnelRuntimeConfig, 'binaryPath' | 'alias'>): Promise<void> {
  const result = await runBinary(config.binaryPath, ['runtimes', 'stop', config.alias, '--json'], 15_000);
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0 && !/not found|not running|unknown alias/i.test(text)) {
    throw new TunnelClientError(`Failed to stop tunnel runtime: ${redact(text.trim())}`);
  }
}

/** A supervised persistent `tunnel-client run` child owned by the bridge. */
export interface TunnelRuntimeHandle {
  /** Recent log tail for diagnostics. */
  readonly logTail: () => string;
  stop: () => Promise<void>;
}

const RUN_PROFILE_NAME = 'omnicross-chatgpt-web';

/**
 * Start the persistent runtime against the profile `runtimes connect`
 * wrote. `connect` only configures + probes; `run` is the long-lived daemon
 * that keeps the tunnel (and the MCP child) available to ChatGPT.
 */
export function startTunnelRuntime(
  config: Pick<TunnelRuntimeConfig, 'binaryPath' | 'profileDir'>,
  childEnv: Record<string, string> = {},
): TunnelRuntimeHandle {
  const profileYaml = join(config.profileDir, `${RUN_PROFILE_NAME}.yaml`);
  if (!existsSync(profileYaml)) {
    throw new TunnelClientError(`tunnel profile not found (expected ${profileYaml}); run connect first`);
  }
  const child = spawn(config.binaryPath, ['run', '--config', profileYaml], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...childEnv },
  });
  const tail: string[] = [];
  const record = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').slice(-40)) {
      if (line.trim()) tail.push(line.trim());
    }
    while (tail.length > 80) tail.shift();
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  return {
    logTail: () => tail.join('\n'),
    stop: async () => {
      if (child.exitCode !== null) return;
      if (process.platform === 'win32') {
        // Kill the whole tree: `run` supervises the MCP grandchild.
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export async function tunnelStatus(config: Pick<TunnelRuntimeConfig, 'binaryPath' | 'alias'>): Promise<TunnelRuntimeStatus> {
  if (!existsSync(config.binaryPath)) {
    return { ok: false, running: false, healthy: false, ready: false, detail: `Missing ${config.binaryPath}` };
  }
  // First-run machines initialize admin profiles, OAuth discovery and the
  // cloudflared supervisor before status answers — 10s probes timed out
  // there and cascaded into false "not ready" failures.
  const result = await runBinary(config.binaryPath, ['runtimes', 'status', config.alias, '--json'], 30_000);
  return parseTunnelStatus(commandOutput(result), result.status);
}

