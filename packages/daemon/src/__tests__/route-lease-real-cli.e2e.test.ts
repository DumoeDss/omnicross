/**
 * Opt-in real-runtime interoperability against a real local daemon and local
 * mock upstreams. The suite is non-billable by construction: every provider
 * base URL is a loopback server owned by this file.
 *
 * Run explicitly with OMNICROSS_REAL_ROUTE_LEASE_E2E=1. When a native binary
 * is absent (or only an unsafe Windows .cmd shim is present), that runtime's
 * case reports an explicit skip instead of silently passing.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { ROUTE_LEASE_REQUEST_SCHEMA } from '@omnicross/core/provider-proxy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';
import {
  createSyntheticVerifiedImageCapture,
  createSyntheticVerifiedImageProviderSeam,
} from './syntheticVerifiedImageProvider';

const OPT_IN = process.env.OMNICROSS_REAL_ROUTE_LEASE_E2E === '1';
const ADMIN_TOKEN = 'real-cli-local-mock-admin-token';

type Runtime = 'codex' | 'claude';

interface FileSnapshot {
  readonly exists: boolean;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly sha256?: string;
}

interface RuntimeMock {
  readonly runtime: Runtime;
  readonly server: Server;
  readonly baseUrl: string;
  hits: number;
  streamHits: number;
  toolCalls: number;
  errorHits: number;
  cancelHits: number;
  aborted: number;
  imageToolAdvertisements: number;
}

interface LeaseCreate {
  readonly leaseId: string;
  readonly launch: { readonly env: Record<string, string>; readonly extraArgs: string[] };
}

interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

let tmpDir = '';
let configPath = '';
let daemon: Daemon;
let adminBase = '';
let codexMock: RuntimeMock;
let claudeMock: RuntimeMock;
let imageCapture: ReturnType<typeof createSyntheticVerifiedImageCapture>;

function snapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return {
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function runtimeFiles(runtime: Runtime): string[] {
  if (runtime === 'codex') {
    const root = process.env.CODEX_HOME || join(homedir(), '.codex');
    return [join(root, 'config.toml'), join(root, 'auth.json')];
  }
  const root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return [
    join(root, 'settings.json'),
    join(root, '.credentials.json'),
    join(homedir(), '.claude.json'),
  ];
}

function snapshotRuntimeFiles(runtime: Runtime): Record<string, FileSnapshot> {
  return Object.fromEntries(runtimeFiles(runtime).map((path) => [path, snapshot(path)]));
}

function resolveCodexNativeBinary(shimDirectory: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const target = process.arch === 'x64'
    ? { packageName: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' }
    : process.arch === 'arm64'
      ? { packageName: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
      : undefined;
  if (!target) return undefined;
  const packageRoots = [
    join(shimDirectory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', target.packageName),
    join(shimDirectory, 'node_modules', '@openai', target.packageName),
  ];
  for (const packageRoot of packageRoots) {
    const candidate = join(packageRoot, 'vendor', target.triple, 'bin', 'codex.exe');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveBinary(name: Runtime): { path?: string; reason?: string } {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((value) => value.toLowerCase())
    : [''];
  let unsafeShim: string | undefined;
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (!existsSync(candidate)) continue;
      if (process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(candidate).toLowerCase())) {
        const nativeCodex = name === 'codex' ? resolveCodexNativeBinary(directory) : undefined;
        if (nativeCodex) return { path: nativeCodex };
        unsafeShim ??= candidate;
        continue;
      }
      return { path: candidate };
    }
  }
  if (unsafeShim) {
    return { reason: `${name} is available only as a Windows command shim; quoted provider argv cannot be passed safely` };
  }
  return { reason: `${name} binary is unavailable on PATH` };
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) as Record<string, unknown> : {});
      } catch {
        resolve({});
      }
    });
  });
}

function bodyText(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function hasToolResult(runtime: Runtime, body: Record<string, unknown>): boolean {
  const text = bodyText(body);
  return runtime === 'codex'
    ? /function_call_output|custom_tool_call_output|image_generation_call/u.test(text)
    : /tool_result/u.test(text);
}

function codexToolSpecs(body: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(body.tools)) return body.tools as Array<Record<string, unknown>>;
  if (!Array.isArray(body.input)) return [];
  const additionalTools = (body.input as Array<Record<string, unknown>>)
    .find((item) => item.type === 'additional_tools');
  return Array.isArray(additionalTools?.tools)
    ? additionalTools.tools as Array<Record<string, unknown>>
    : [];
}

function hasCodexImageTool(body: Record<string, unknown>): boolean {
  return codexToolSpecs(body).some((entry) =>
    entry.type === 'namespace'
    && entry.name === 'image_gen'
    && Array.isArray(entry.tools)
    && (entry.tools as Array<Record<string, unknown>>).some((tool) => tool.name === 'imagegen')
  );
}

function writeSse(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function responseEnvelope(id: string, model: string, output: unknown[] = []) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_chars: null,
    max_tool_calls: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    user: null,
    metadata: {},
  };
}

function sendCodexText(res: ServerResponse, model: string, text: string): void {
  const id = `resp_${Date.now()}`;
  const item = {
    id: `msg_${Date.now()}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  writeSse(res, { type: 'response.created', sequence_number: 0, response: { ...responseEnvelope(id, model), status: 'in_progress' } });
  writeSse(res, { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  writeSse(res, { type: 'response.content_part.added', sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
  writeSse(res, { type: 'response.output_text.delta', sequence_number: 3, item_id: item.id, output_index: 0, content_index: 0, delta: text, logprobs: [] });
  writeSse(res, { type: 'response.output_text.done', sequence_number: 4, item_id: item.id, output_index: 0, content_index: 0, text, logprobs: [] });
  writeSse(res, { type: 'response.content_part.done', sequence_number: 5, item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  writeSse(res, { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item });
  writeSse(res, { type: 'response.completed', sequence_number: 7, response: responseEnvelope(id, model, [item]) });
  res.end();
}

function sendCodexTool(res: ServerResponse, body: Record<string, unknown>, model: string): boolean {
  const tools = Array.isArray(body.tools) ? body.tools as Array<Record<string, unknown>> : [];
  const tool = tools.find((entry) => typeof entry.name === 'string');
  if (!tool) return false;
  const name = tool.name as string;
  const custom = tool.type === 'custom';
  const id = `resp_${Date.now()}`;
  const itemId = `tool_${Date.now()}`;
  const callId = `call_${Date.now()}`;
  const input = custom ? 'echo route-lease-tool-ok' : JSON.stringify({ command: 'echo route-lease-tool-ok' });
  const item = custom
    ? { id: itemId, type: 'custom_tool_call', status: 'completed', call_id: callId, name, input }
    : { id: itemId, type: 'function_call', status: 'completed', call_id: callId, name, arguments: input };
  const prefix = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  writeSse(res, { type: 'response.created', sequence_number: 0, response: { ...responseEnvelope(id, model), status: 'in_progress' } });
  writeSse(res, { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) } });
  writeSse(res, { type: `${prefix}.delta`, sequence_number: 2, item_id: itemId, output_index: 0, delta: input });
  writeSse(res, { type: `${prefix}.done`, sequence_number: 3, item_id: itemId, output_index: 0, ...(custom ? { input } : { arguments: input }) });
  writeSse(res, { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item });
  writeSse(res, { type: 'response.completed', sequence_number: 5, response: responseEnvelope(id, model, [item]) });
  res.end();
  return true;
}

function sendCodexImageTool(res: ServerResponse, model: string): void {
  const id = `resp_${Date.now()}`;
  const itemId = `tool_${Date.now()}`;
  const callId = `call_${Date.now()}`;
  const args = JSON.stringify({ prompt: 'route-lease-image-tool one pixel validation image' });
  const item = {
    id: itemId,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    namespace: 'image_gen',
    name: 'imagegen',
    arguments: args,
  };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  writeSse(res, { type: 'response.created', sequence_number: 0, response: { ...responseEnvelope(id, model), status: 'in_progress' } });
  writeSse(res, { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } });
  writeSse(res, { type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: itemId, output_index: 0, delta: args });
  writeSse(res, { type: 'response.function_call_arguments.done', sequence_number: 3, item_id: itemId, output_index: 0, arguments: args });
  writeSse(res, { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item });
  writeSse(res, { type: 'response.completed', sequence_number: 5, response: responseEnvelope(id, model, [item]) });
  res.end();
}

function sendClaudeText(res: ServerResponse, model: string, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const id = `msg_${Date.now()}`;
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } })}\n\n`);
  res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
  res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`);
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  res.end();
}

function sendClaudeTool(res: ServerResponse, body: Record<string, unknown>, model: string): boolean {
  const tools = Array.isArray(body.tools) ? body.tools as Array<Record<string, unknown>> : [];
  const tool = tools.find((entry) => typeof entry.name === 'string');
  if (!tool) return false;
  const name = tool.name as string;
  const input = name.toLowerCase().includes('bash')
    ? { command: 'echo route-lease-tool-ok' }
    : { command: 'echo route-lease-tool-ok' };
  const id = `msg_${Date.now()}`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } })}\n\n`);
  res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name, input: {} } })}\n\n`);
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`);
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
  res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`);
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  res.end();
  return true;
}

async function handleMock(mock: RuntimeMock, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const text = bodyText(body);
  mock.hits += 1;
  req.on('aborted', () => { mock.aborted += 1; });
  const hasImageTool = mock.runtime === 'codex' && hasCodexImageTool(body);
  if (hasImageTool) mock.imageToolAdvertisements += 1;
  if (text.includes('route-lease-error')) {
    mock.errorHits += 1;
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: { message: 'local mock rate limit', type: 'local_mock_error' } }));
    return;
  }
  if (text.includes('route-lease-cancel')) {
    mock.cancelHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (mock.runtime === 'codex') {
      writeSse(res, { type: 'response.created', sequence_number: 0, response: { ...responseEnvelope(`resp_${Date.now()}`, 'codex-frozen'), status: 'in_progress' } });
    } else {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-frozen', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
    }
    return;
  }
  if (mock.runtime === 'codex' && text.includes('route-lease-image-tool')) {
    if (!hasToolResult(mock.runtime, body) && hasImageTool) {
      sendCodexImageTool(res, 'codex-frozen');
      return;
    }
    mock.streamHits += 1;
    sendCodexText(res, 'codex-frozen', 'route-lease-image-ok');
    return;
  }
  if (text.includes('route-lease-tool') && !hasToolResult(mock.runtime, body)) {
    const sent = mock.runtime === 'codex'
      ? sendCodexTool(res, body, 'codex-frozen')
      : sendClaudeTool(res, body, 'claude-frozen');
    if (sent) {
      mock.toolCalls += 1;
      return;
    }
  }
  mock.streamHits += 1;
  if (mock.runtime === 'codex') sendCodexText(res, 'codex-frozen', 'route-lease-stream-ok');
  else sendClaudeText(res, 'claude-frozen', 'route-lease-stream-ok');
}

function startMock(runtime: Runtime): Promise<RuntimeMock> {
  return new Promise((resolve) => {
    const mock = {
      runtime,
      hits: 0,
      streamHits: 0,
      toolCalls: 0,
      errorHits: 0,
      cancelHits: 0,
      aborted: 0,
      imageToolAdvertisements: 0,
    } as RuntimeMock;
    const server = createServer((req, res) => { void handleMock(mock, req, res); });
    server.listen(0, '127.0.0.1', () => {
      Object.assign(mock, {
        server,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      resolve(mock);
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function createLease(runtime: Runtime, key: string, ttlSeconds = 30): Promise<LeaseCreate> {
  const response = await fetch(`${adminBase}/admin/api/route-leases`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
      consumer: 'rasen-real-cli-e2e',
      runtime,
      upstream: { kind: 'provider', providerId: runtime === 'codex' ? 'codex-local' : 'claude-local' },
      model: runtime === 'codex' ? 'codex-frozen' : 'claude-frozen',
      ttlSeconds,
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<LeaseCreate>;
}

function runtimeArgs(runtime: Runtime, lease: LeaseCreate, prompt: string): string[] {
  if (runtime === 'codex') {
    return [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--model',
      'codex-frozen',
      ...lease.launch.extraArgs,
      '-c',
      'features.plugins=false',
      prompt,
    ];
  }
  return [
    '-p',
    prompt,
    '--bare',
    '--no-chrome',
    '--no-session-persistence',
    '--model',
    'claude-frozen',
    '--output-format',
    'text',
    '--permission-mode',
    'bypassPermissions',
    ...lease.launch.extraArgs,
  ];
}

function spawnRuntime(
  binary: string,
  runtime: Runtime,
  lease: LeaseCreate,
  prompt: string,
): ChildProcess {
  return spawn(binary, runtimeArgs(runtime, lease, prompt), {
    cwd: tmpDir,
    env: {
      ...process.env,
      ...lease.launch.env,
      ...(runtime === 'codex' ? { CODEX_HOME: join(tmpDir, 'codex-home') } : {}),
      ...(runtime === 'claude' ? {
        CLAUDE_CONFIG_DIR: join(tmpDir, 'claude-home'),
        HOME: tmpDir,
        USERPROFILE: tmpDir,
      } : {}),
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collect(child: ChildProcess, timeoutMs = 20_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`real CLI local-mock run timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function renew(leaseId: string): Promise<Response> {
  return fetch(`${adminBase}/admin/api/route-leases/${leaseId}/renew`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttlSeconds: 30 }),
  });
}

async function release(leaseId: string): Promise<Response> {
  return fetch(`${adminBase}/admin/api/route-leases/${leaseId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

beforeAll(async () => {
  if (!OPT_IN) return;
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-real-cli-route-lease-'));
  mkdirSync(join(tmpDir, 'codex-home'), { recursive: true });
  mkdirSync(join(tmpDir, 'claude-home'), { recursive: true });
  configPath = join(tmpDir, 'config.json');
  [codexMock, claudeMock] = await Promise.all([startMock('codex'), startMock('claude')]);
  imageCapture = createSyntheticVerifiedImageCapture();
  writeFileSync(configPath, JSON.stringify({
    providers: [
      { id: 'codex-local', apiFormat: 'openai-response', baseUrl: codexMock.baseUrl, apiKey: 'local-codex-key', models: ['codex-frozen'] },
      { id: 'claude-local', apiFormat: 'anthropic', baseUrl: claudeMock.baseUrl, apiKey: 'local-claude-key', models: ['claude-frozen'] },
    ],
    server: { images: { enabled: true } },
    admin: { port: 0, token: ADMIN_TOKEN },
  }, null, 2), 'utf8');
  daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
    testOnlySyntheticVerifiedImageProvider:
      createSyntheticVerifiedImageProviderSeam(imageCapture),
  });
  await daemon.llmConfig.ready();
  await daemon.providerProxy.start();
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
}, 30_000);

afterAll(async () => {
  if (!OPT_IN) return;
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.providerProxy.stop();
    daemon.apiKeyPool.dispose();
    daemon.tokenRefreshScheduler.dispose();
    daemon.claudeAllowanceRefreshScheduler.dispose();
    daemon.accountHealthSweeper.dispose();
    daemon.accountHealthProbeScheduler.dispose();
    daemon.auditPruneSweeper.dispose();
    daemon.billingRetrySweeper.dispose();
    daemon.pricingRefreshScheduler.dispose();
  }
  await Promise.all([stopServer(codexMock.server), stopServer(claudeMock.server)]);
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!OPT_IN)('real CLI Route Lease interoperability (explicit opt-in, local mocks only)', () => {
  for (const runtime of ['codex', 'claude'] as const) {
    const binary = resolveBinary(runtime);
    const skipReason = binary.reason ? ` (${binary.reason})` : '';
    it.skipIf(!binary.path)(`${runtime} covers streaming, a tool round, error, cancellation, renew, release, and config non-pollution${skipReason}`, async () => {
      const executable = binary.path;
      if (!executable) throw new Error(binary.reason);
      const before = snapshotRuntimeFiles(runtime);
      const mock = runtime === 'codex' ? codexMock : claudeMock;
      const lease = await createLease(runtime, `real-${runtime}-${Date.now()}`);
      const token = runtime === 'codex'
        ? lease.launch.env.OMNICROSS_CODEX_ROUTE_TOKEN
        : lease.launch.env.ANTHROPIC_AUTH_TOKEN;

      try {
        const streamed = await collect(spawnRuntime(executable, runtime, lease, 'Return the text route-lease-stream.'));
        expect(streamed.code, streamed.stderr).toBe(0);
        expect(streamed.stdout + streamed.stderr).toContain('route-lease-stream-ok');

        const tool = await collect(spawnRuntime(executable, runtime, lease, 'Use one available local shell tool for route-lease-tool, then finish.'));
        expect(tool.code, tool.stderr).toBe(0);
        expect(mock.toolCalls).toBeGreaterThan(0);

        if (runtime === 'codex') {
          const advertisementsBefore = mock.imageToolAdvertisements;
          const imageStartsBefore = imageCapture.starts;
          const image = await collect(spawnRuntime(
            executable,
            runtime,
            lease,
            'Call image_gen/imagegen exactly once for route-lease-image-tool, then finish.'
          ), 30_000);
          expect(image.code, image.stderr).toBe(0);
          expect(image.stdout + image.stderr).toContain('route-lease-image-ok');
          expect(mock.imageToolAdvertisements).toBeGreaterThan(advertisementsBefore);
          expect(imageCapture.starts).toBeGreaterThan(imageStartsBefore);
        }

        const errorChild = spawnRuntime(executable, runtime, lease, 'Trigger route-lease-error and stop.');
        const errorResult = await collect(errorChild, 10_000).catch((error: unknown) => ({
          code: null,
          signal: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        }));
        expect(mock.errorHits).toBeGreaterThan(0);
        expect(errorResult.code).not.toBe(0);

        const cancelHitsBefore = mock.cancelHits;
        const cancelChild = spawnRuntime(executable, runtime, lease, 'Wait for route-lease-cancel.');
        const cancelled = collect(cancelChild, 10_000);
        try {
          await waitFor(() => mock.cancelHits > cancelHitsBefore, 5_000);
          const renewed = await renew(lease.leaseId);
          expect(renewed.status).toBe(200);
          cancelChild.kill();
          await cancelled;
        } finally {
          if (cancelChild.exitCode === null && cancelChild.signalCode === null) cancelChild.kill();
          await cancelled.catch(() => undefined);
        }
        expect(mock.cancelHits).toBeGreaterThan(cancelHitsBefore);
      } finally {
        const released = await release(lease.leaseId);
        expect(released.status).toBe(200);
      }

      const oldTokenResponse = await fetch(`${daemon.providerProxy.getBaseUrl()}${runtime === 'codex' ? '/openai/responses' : '/v1/messages'}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'old-token-must-fail', input: 'ping', messages: [] }),
      });
      expect(oldTokenResponse.status).toBe(401);
      expect(snapshotRuntimeFiles(runtime)).toEqual(before);
    }, 90_000);
  }
});
