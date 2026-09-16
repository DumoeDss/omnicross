/**
 * askProCore.ts — the ask_pro consultation engine: ChatGPT Pro as a Codex
 * MCP advisor that can itself call local tools.
 *
 * The harness tool loop's executor is whoever holds the /v1/responses HTTP
 * stream — the broker routes purely by turn token. This module IS that client:
 * it runs a harness browser turn, receives function_call events as SSE,
 * executes them locally (read-only allowlist by default), and answers each in
 * a follow-up request whose history echoes the call plus its output, resuming
 * the SAME browser turn until Pro's final answer completes. The wire protocol
 * is exactly what scripts/chatgpt-web-harness-roundtrip.ts proved on Pro.
 *
 * Everything browser- or tunnel-side is untouched: connector, tunnel-client,
 * MCP server child, and broker all route by turn token and never learn who
 * the HTTP client is.
 *
 * @module @omnicross/chatgpt-web/askpro/askProCore
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Errors -------------------------------------------------------------------

export type AskProErrorCode =
  | 'bridge-down'
  | 'harness-off'
  | 'busy'
  | 'http'
  | 'turn-failed'
  | 'deadline'
  | 'aborted'
  | 'rounds-exceeded';

/** A consult failure with a machine code plus whatever text Pro already produced. */
export class AskProError extends Error {
  constructor(
    readonly code: AskProErrorCode,
    message: string,
    readonly partialText: string = '',
  ) {
    super(message);
    this.name = 'AskProError';
  }
}

// --- Read-only command policy ---------------------------------------------------

const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'blame', 'rev-parse', 'ls-files',
  'ls-remote', 'remote', 'tag', 'reflog', 'describe', 'shortlog', 'name-rev',
  'grep', 'cat-file', 'show-branch', 'merge-base', 'version',
]);

/** Two-word git subcommands where only the listed second word is read-only. */
const GIT_TWO_WORD: Record<string, ReadonlySet<string>> = {
  stash: new Set(['list']),
  worktree: new Set(['list']),
};

/** `git config` is allowed only with a listing/reading flag first. */
const GIT_CONFIG_FLAGS = new Set(['--list', '-l', '--get', '--get-all', '--get-regexp']);

/** Global git flags that may precede the subcommand (`-C <path>` etc. consume a value). */
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree', '-c', '--namespace']);
const GIT_GLOBAL_FLAGS_ALONE = new Set(['--no-pager', '--no-optional-locks', '--literal-pathspecs', '--paginate']);

/** Plain read-only executables (matched on the argv[0] basename, extension stripped). */
const READONLY_COMMANDS = new Set([
  'cat', 'head', 'tail', 'wc', 'grep', 'findstr', 'rg', 'fd', 'ls', 'dir', 'tree',
  'sort', 'uniq', 'file', 'stat', 'du', 'pwd', 'echo', 'which', 'where', 'type',
  'diff', 'comm', 'cut', 'date', 'basename', 'dirname', 'realpath',
]);

/** Windows cmd builtins that have no .exe and must ride the `cmd /c` wrapper. */
const CMD_READONLY_BUILTINS = new Set(['type', 'dir', 'ver']);

/** find(1) flags that mutate — any occurrence rejects the command. */
const FIND_MUTATING_FLAGS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf',
]);

/** Shell metacharacters banned inside `cmd /c` wrapper arguments. */
const CMD_METACHARS = /[<>|&^%]/;

export type ReadonlyVerdict = { ok: true } | { ok: false; reason: string };

function baseNameOf(command: string): string {
  return basename(command).replace(/\.(exe|com|bat|cmd|ps1)$/i, '').toLowerCase();
}

function checkGitReadonly(argv: string[]): ReadonlyVerdict {
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index];
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS_ALONE.has(arg)) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = argv[index]?.toLowerCase();
  if (!subcommand) return { ok: false, reason: 'git requires a read-only subcommand (e.g. git log, git show, git diff)' };
  const twoWord = GIT_TWO_WORD[subcommand];
  if (twoWord) {
    const second = argv[index + 1]?.toLowerCase();
    if (second && twoWord.has(second)) return { ok: true };
    return { ok: false, reason: `only \`git ${subcommand} ${[...twoWord][0]}\` is read-only` };
  }
  if (subcommand === 'config') {
    const flag = argv[index + 1];
    if (flag && GIT_CONFIG_FLAGS.has(flag)) return { ok: true };
    return { ok: false, reason: 'only `git config --list/--get…` is read-only' };
  }
  if (GIT_READONLY_SUBCOMMANDS.has(subcommand)) return { ok: true };
  return { ok: false, reason: `git subcommand "${subcommand}" is not in the read-only set` };
}

/**
 * Decide whether an argv is allowed under the read-only policy. Pure — the
 * security boundary of ask_pro's default mode; keep exhaustive tests green.
 */
export function checkReadonlyCommand(argv: string[]): ReadonlyVerdict {
  if (argv.length === 0 || typeof argv[0] !== 'string' || argv[0].trim() === '') {
    return { ok: false, reason: 'empty command' };
  }
  const head = baseNameOf(argv[0]);
  if (head === 'cmd') {
    if (argv[1]?.toLowerCase() !== '/c' || argv.length < 3) {
      return { ok: false, reason: 'cmd is only allowed as `cmd /c <builtin> …` for read-only builtins (type, dir, ver)' };
    }
    const builtin = baseNameOf(argv[2]);
    if (!CMD_READONLY_BUILTINS.has(builtin)) {
      return { ok: false, reason: `cmd builtin "${builtin}" is not in the read-only set (type, dir, ver)` };
    }
    for (const arg of argv.slice(3)) {
      if (typeof arg === 'string' && CMD_METACHARS.test(arg)) {
        return { ok: false, reason: 'cmd /c arguments must not contain shell metacharacters (< > | & ^ %)' };
      }
    }
    return { ok: true };
  }
  if (head === 'git') return checkGitReadonly(argv);
  if (head === 'find') {
    if (argv.some((arg) => typeof arg === 'string' && FIND_MUTATING_FLAGS.has(arg))) {
      return { ok: false, reason: 'find is read-only only without -delete/-exec*/-ok*/-fprint*/-fls' };
    }
    return { ok: true };
  }
  if (READONLY_COMMANDS.has(head)) return { ok: true };
  return {
    ok: false,
    reason:
      `"${argv[0]}" is not in the read-only allowlist. Allowed: git read-only subcommands, ` +
      'file readers/inspectors (cat, head, tail, grep, rg, findstr, ls, …), and `cmd /c type|dir|ver` on Windows. ' +
      'Mutating commands, interpreters (awk/sed/node/python/…), and package managers are rejected — adapt with allowed reads.',
  };
}

// --- Command execution ----------------------------------------------------------

export interface ShellExecResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  notFound: boolean;
}

/**
 * Resolve a command name to an executable WITHOUT ever searching the current
 * directory (Windows CreateProcess searches cwd first — a workspace
 * `cat.bat`/`cat.cmd` must not shadow under an allowlisted name) and without
 * ever resolving to a script extension (.bat/.cmd/.ps1 — only .exe/.com).
 */
export function resolveCommandExecutable(name: string, cwd: string): string | null {
  if (/[\\/]/.test(name)) {
    return /\.(exe|com)$/i.test(name) && existsSync(name) ? name : null;
  }
  const cwdResolved = resolve(cwd);
  const dirs = (process.env.PATH ?? '')
    .split(delimiter)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => {
      try {
        return resolve(segment).toLowerCase() !== cwdResolved.toLowerCase();
      } catch {
        return true;
      }
    });
  const extensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Run one command, capturing stdout+stderr with a hard timeout. */
export function executeShellCommand(
  argv: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<ShellExecResult> {
  return new Promise((resolvePromise) => {
    if (argv.length === 0 || typeof argv[0] !== 'string') {
      resolvePromise({ output: '', exitCode: null, timedOut: false, notFound: true });
      return;
    }
    const executable = resolveCommandExecutable(argv[0], options.cwd);
    if (!executable) {
      resolvePromise({ output: '', exitCode: null, timedOut: false, notFound: true });
      return;
    }
    let output = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ output, exitCode, timedOut, notFound: false });
    };
    const child = spawn(executable, argv.slice(1), { cwd: options.cwd, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        clearTimeout(timer);
        resolvePromise({ output: '', exitCode: null, timedOut: false, notFound: true });
        settled = true;
        return;
      }
      output += `${error.message}\n`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Cap a tool output: keep the head and tail with an explicit truncation note. */
export function capOutput(text: string, maxChars = 64_000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars - 8_000);
  const tail = text.slice(-8_000);
  return `${head}\n…[output truncated ${text.length - maxChars + 8_000} chars]…\n${tail}`;
}

// --- SSE accumulator --------------------------------------------------------------

export interface AskProToolCall {
  callId: string;
  name: string;
  /** true for custom_tool_call (freeform apply_patch-style) items. */
  freeform: boolean;
  argumentsJson: string;
}

export interface ProSseSnapshot {
  text: string;
  calls: AskProToolCall[];
  terminal: null | 'completed' | 'failed' | 'incomplete';
  failureMessage: string | null;
  incompleteReason: string | null;
  sawData: boolean;
}

interface SseItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
}

interface SseEvent {
  type: string;
  delta?: string;
  item?: SseItem;
  response?: { error?: { message?: string }; incomplete_details?: { reason?: string } };
}

/**
 * Incremental SSE parser for one /v1/responses round. A parked stream ends
 * with response.incomplete {reason:'adapter_eof'} AFTER emitting its tool-call
 * items — callers treat "has calls" as a normal park, not a failure.
 */
export function createProSseAccumulator(): {
  push(chunk: string): void;
  snapshot(): ProSseSnapshot;
} {
  let buffer = '';
  let text = '';
  let terminal: ProSseSnapshot['terminal'] = null;
  let failureMessage: string | null = null;
  let incompleteReason: string | null = null;
  let sawData = false;
  const calls: AskProToolCall[] = [];

  const handle = (event: SseEvent): void => {
    sawData = true;
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') text += event.delta;
        return;
      case 'response.output_item.done': {
        const item = event.item;
        if (!item || typeof item.call_id !== 'string') return;
        if (item.type === 'function_call') {
          calls.push({ callId: item.call_id, name: item.name ?? '', freeform: false, argumentsJson: item.arguments || '{}' });
        } else if (item.type === 'custom_tool_call') {
          calls.push({ callId: item.call_id, name: item.name ?? '', freeform: true, argumentsJson: item.input ?? '' });
        }
        return;
      }
      case 'response.completed':
        terminal = 'completed';
        return;
      case 'response.failed':
        terminal = 'failed';
        failureMessage = event.response?.error?.message ?? 'unknown failure';
        return;
      case 'response.incomplete':
        terminal = 'incomplete';
        incompleteReason = event.response?.incomplete_details?.reason ?? 'unknown';
        return;
      case 'error':
        terminal = 'failed';
        failureMessage = (event as { message?: string }).message ?? 'bridge error';
        return;
      default:
        return;
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const payload = dataLine.slice(6);
        if (payload === '[DONE]') continue;
        try {
          handle(JSON.parse(payload) as SseEvent);
        } catch {
          // Ignore malformed frames — the stream's terminal events decide.
        }
      }
    },
    snapshot(): ProSseSnapshot {
      return { text, calls, terminal, failureMessage, incompleteReason, sawData };
    },
  };
}

// --- Request wire shapes -----------------------------------------------------------

export function buildAskProInstructions(options: { cwd: string; platform: string; writable: boolean }): string {
  const lines = [
    'You are ChatGPT Pro, consulted as a senior advisor by a local coding agent that works with a smaller model.',
    `Workspace directory: ${options.cwd} (platform ${options.platform}).`,
  ];
  if (options.writable) {
    lines.push(
      'You may use the attached Codex Native shell tool freely (commands run as the user in the workspace directory).',
    );
  } else {
    lines.push(
      'You may inspect the workspace through the attached Codex Native shell tool under an enforced READ-ONLY allowlist:',
      'git read-only subcommands (git show HEAD:<path>, git log -p, git diff, git grep …), file-reading executables (cat, head, tail, wc, grep, rg, findstr, ls, …), and on Windows `cmd /c type|dir <path>` for builtins (avoid paths with spaces — prefer git show).',
      'Mutating commands, interpreters (awk/sed/node/python/powershell), and package managers are rejected — do NOT retry a rejected command; adapt using allowed reads.',
    );
  }
  lines.push(
    'The consulting agent keeps NO memory between consultations: the question carries all context. If context is missing, derive it from the workspace by inspection instead of asking back.',
    'Answer thoroughly and self-contained, grounded in concrete evidence (file paths, symbols, command outputs). Your answer is returned verbatim to the consulting agent.',
  );
  return lines.join('\n');
}

/** The shell tool declaration (shape proven by the harness round-trip script). */
export function askProToolsDeclaration(): unknown[] {
  return [
    {
      type: 'function',
      name: 'shell',
      description: 'Run a shell command in the workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'array', items: { type: 'string' }, description: 'Argv array to execute.' },
          timeout_ms: { type: 'number', description: 'Optional per-command timeout in milliseconds.' },
        },
        required: ['command'],
      },
    },
  ];
}

export function toolCallWireItem(call: AskProToolCall): Record<string, unknown> {
  return call.freeform
    ? { type: 'custom_tool_call', call_id: call.callId, name: call.name, input: call.argumentsJson }
    : { type: 'function_call', call_id: call.callId, name: call.name, arguments: call.argumentsJson };
}

export function toolOutputWireItem(call: AskProToolCall, output: string): Record<string, unknown> {
  return call.freeform
    ? { type: 'custom_tool_call_output', call_id: call.callId, output }
    : { type: 'function_call_output', call_id: call.callId, output };
}

// --- Bridge health ------------------------------------------------------------------

export interface BridgeHealth {
  reachable: boolean;
  harness: boolean;
  detail: string;
}

export async function probeBridgeHealth(baseUrl: string, timeoutMs = 2_500): Promise<BridgeHealth> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { reachable: false, harness: false, detail: `/healthz HTTP ${response.status}` };
    }
    const payload = (await response.json()) as { status?: string; harness?: boolean };
    return {
      reachable: payload['status'] === 'ok',
      harness: payload['harness'] === true,
      detail: payload['status'] === 'ok' ? 'ok' : `status ${String(payload['status'])}`,
    };
  } catch (error) {
    return { reachable: false, harness: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// --- The consult loop ------------------------------------------------------------------

export interface ConsultProOptions {
  /** Bridge origin, no trailing /v1 (e.g. http://127.0.0.1:17850). */
  baseUrl: string;
  token: string;
  model: string;
  question: string;
  cwd: string;
  platform: string;
  writable?: boolean;
  deadlineMs?: number;
  maxToolRounds?: number;
  /** Per-command timeout default for Pro's shell calls. */
  commandTimeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; defaults to executeShellCommand. */
  execute?: (argv: string[], options: { cwd: string; timeoutMs: number }) => Promise<ShellExecResult>;
  log?: (line: string) => void;
}

export interface ConsultProResult {
  answer: string;
  toolRounds: number;
  toolCalls: number;
  model: string;
}

/** Execute one parked tool call; violations come back as error TEXT for Pro to adapt on. */
async function executeAskProToolCall(
  call: AskProToolCall,
  options: ConsultProOptions,
): Promise<string> {
  if (call.name === 'apply_patch') {
    return 'ERROR: apply_patch is not available through ask_pro in this version (read-only advisor mode). Work from inspection and describe the exact edit instead.';
  }
  if (call.name !== 'shell') {
    return `ERROR: unknown tool "${call.name}"`;
  }
  let args: { command?: unknown; timeout_ms?: unknown };
  try {
    args = JSON.parse(call.argumentsJson || '{}') as { command?: unknown; timeout_ms?: unknown };
  } catch {
    return `ERROR: could not parse shell arguments: ${call.argumentsJson.slice(0, 200)}`;
  }
  const command = Array.isArray(args.command) ? args.command.filter((part) => typeof part === 'string') : [];
  if (command.length === 0) {
    return 'ERROR: shell requires a non-empty command argv array.';
  }
  if (!options.writable) {
    const verdict = checkReadonlyCommand(command as string[]);
    if (!verdict.ok) return `ERROR (read-only policy): ${verdict.reason}`;
  }
  const requestedTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : (options.commandTimeoutMs ?? 30_000);
  const timeoutMs = Math.min(120_000, Math.max(1_000, requestedTimeout));
  const execute = options.execute ?? executeShellCommand;
  const result = await execute(command as string[], { cwd: options.cwd, timeoutMs });
  if (result.notFound) {
    return (
      `ERROR: executable not found: "${String(command[0])}". Executables resolve strictly via PATH ` +
      '(the workspace directory is never searched); Windows cmd builtins need the ["cmd","/c","type","<path>"] form.'
    );
  }
  const status = `[exit ${result.exitCode ?? 'none'}${result.timedOut ? ' — TIMED OUT' : ''}]`;
  const body = capOutput(result.output).trim();
  return body.length > 0 ? `${body}\n${status}` : status;
}

/**
 * One full ask_pro consultation: health precheck, then harness rounds until
 * Pro's answer completes. Each parked round's calls are executed locally and
 * answered in the follow-up request (full history echo, like Codex itself).
 */
export async function consultPro(options: ConsultProOptions): Promise<ConsultProResult> {
  const base = options.baseUrl.replace(/\/+$/, '');
  const health = await probeBridgeHealth(base);
  if (!health.reachable) {
    throw new AskProError(
      'bridge-down',
      `The ChatGPT Web bridge is not running at ${base} (${health.detail}). Start it from the OmniCross ChatGPT Web page with the harness enabled, then retry.`,
    );
  }
  if (!health.harness) {
    throw new AskProError(
      'harness-off',
      `The bridge at ${base} is running WITHOUT harness mode — local tools are unavailable. Restart it with the harness enabled from the OmniCross ChatGPT Web page.`,
    );
  }

  const deadlineAt = Date.now() + (options.deadlineMs ?? 600_000);
  const maxToolRounds = options.maxToolRounds ?? 12;
  const baseInput = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: options.question }],
    },
  ];
  const instructions = buildAskProInstructions({
    cwd: options.cwd,
    platform: options.platform,
    writable: options.writable === true,
  });
  const history: Array<Record<string, unknown>> = [];
  let input: unknown[] = baseInput;
  let text = '';
  let toolCalls = 0;

  for (let round = 0; round <= maxToolRounds; round += 1) {
    if (options.signal?.aborted) throw new AskProError('aborted', 'consultation cancelled');
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new AskProError('deadline', `ask_pro deadline exceeded after ${round} round(s)`, text);
    }
    options.log?.(`round ${round}: POST /v1/responses (model ${options.model})`);

    const roundAbort = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(remaining)]);
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
      body: JSON.stringify({
        model: options.model,
        stream: true,
        instructions,
        tools: askProToolsDeclaration(),
        input,
      }),
      signal: roundAbort,
    }).catch((error: unknown) => {
      if (options.signal?.aborted) throw new AskProError('aborted', 'consultation cancelled', text);
      if (Date.now() >= deadlineAt) throw new AskProError('deadline', 'ask_pro deadline exceeded mid-request', text);
      throw new AskProError('http', `bridge request failed: ${error instanceof Error ? error.message : String(error)}`, text);
    });

    if (!response.ok || !response.body) {
      const detail = await response
        .text()
        .then((body) => {
          try {
            const parsed = JSON.parse(body) as { error?: { message?: string } };
            return parsed.error?.message ?? body.slice(0, 400);
          } catch {
            return body.slice(0, 400);
          }
        })
        .catch(() => `HTTP ${response.status}`);
      if (response.status === 429) {
        throw new AskProError('busy', `the bridge is busy: ${detail}`, text);
      }
      throw new AskProError('http', `bridge HTTP ${response.status}: ${detail}`, text);
    }

    const accumulator = createProSseAccumulator();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read().catch((error: unknown) => {
        if (options.signal?.aborted) throw new AskProError('aborted', 'consultation cancelled', text);
        if (Date.now() >= deadlineAt) throw new AskProError('deadline', 'ask_pro deadline exceeded mid-stream', text);
        throw new AskProError('http', `stream failed: ${error instanceof Error ? error.message : String(error)}`, text);
      });
      if (done) break;
      accumulator.push(decoder.decode(value, { stream: true }));
    }
    const snapshot = accumulator.snapshot();
    text += snapshot.text;

    if (snapshot.calls.length > 0) {
      toolCalls += snapshot.calls.length;
      if (round === maxToolRounds) break;
      options.log?.(`round ${round}: executing ${snapshot.calls.length} tool call(s): ${snapshot.calls.map((call) => call.name).join(', ')}`);
      for (const call of snapshot.calls) {
        history.push(toolCallWireItem(call));
      }
      for (const call of snapshot.calls) {
        const output = await executeAskProToolCall(call, options);
        history.push(toolOutputWireItem(call, output));
      }
      input = [...baseInput, ...history];
      continue;
    }

    if (snapshot.terminal === 'completed') {
      return { answer: text.trim(), toolRounds: round, toolCalls, model: options.model };
    }
    const reason =
      snapshot.terminal === 'failed'
        ? `Pro turn failed: ${snapshot.failureMessage ?? 'unknown'}`
        : snapshot.terminal === 'incomplete'
          ? `Pro turn incomplete (${snapshot.incompleteReason ?? 'unknown'})`
          : 'Pro stream ended without a terminal event';
    throw new AskProError('turn-failed', reason, text);
  }
  throw new AskProError(
    'rounds-exceeded',
    `ask_pro exceeded ${maxToolRounds} tool rounds without a final answer`,
    text,
  );
}

// --- Entry resolution ------------------------------------------------------------

/** Locate the built ask-pro MCP server entry (dist layout, or dist from src runs). */
export function resolveAskProServerEntry(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, 'askProServer.js'), // dist/askpro/askProCore.js layout
      join(here, '..', '..', 'dist', 'askpro', 'askProServer.js'), // src/askpro (vitest/tsx) → dist
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  } catch {
    return null;
  }
}
