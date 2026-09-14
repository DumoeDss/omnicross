#!/usr/bin/env node
/**
 * askProServer.ts — stdio MCP server exposing `ask_pro` to Codex.
 *
 * Registered in ~/.codex/config.toml as a managed `[mcp_servers.*]` section
 * (command=node, args=[~/.omnicross/chatgpt-web/ask-pro/server.mjs]) and
 * spawned per codex session. Each tools/call runs one full harness browser
 * turn through the bridge (see askProCore) and returns Pro's answer.
 *
 * Entry guard: main() runs only when this file is executed directly —
 * importing the module (tests, the daemon's entry resolver) is side-effect
 * free, unlike tunnel/mcpServer.ts.
 *
 * @module @omnicross/chatgpt-web/askpro/askProServer
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AskProError, consultPro } from './askProCore';

// The daemon locates the built entry through this module (the bundled build
// inlines askProCore, so its import.meta.url-based resolution lands here).
export { resolveAskProServerEntry } from './askProCore';

const MCP_FALLBACK_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function out(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string, result: Record<string, unknown>): void {
  out({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string, code: number, message: string): void {
  out({ jsonrpc: '2.0', id, error: { code, message } });
}

const ASK_PRO_TOOL = {
  name: 'ask_pro',
  description:
    'Consult ChatGPT Pro as a senior advisor for the current task. Pro can inspect the workspace itself ' +
    'through read-only shell commands (git log/diff/show, file reading). There is NO memory between ' +
    'consultations — include ALL context in the question: the goal, relevant file paths, code snippets, ' +
    'constraints, and what has been tried. One consultation takes tens of seconds to a few minutes; ' +
    'prefer one well-formed question over repeated calls.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The complete, self-contained question for Pro, including all context it needs.' },
    },
    required: ['question'],
  },
};

// --- main ---------------------------------------------------------------------

interface ServerOptions {
  baseUrl: string;
  tokenFile: string;
  model: string;
  writable: boolean;
  deadlineMs: number;
  logFile: string | null;
}

function parseServerOptions(argv: string[]): ServerOptions {
  const find = (prefix: string): string | undefined => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const numeric = (prefix: string, fallback: number): number => {
    const raw = find(prefix);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    baseUrl: find('--bridge-base-url=') ?? 'http://127.0.0.1:17850',
    tokenFile: find('--bridge-token-file=') ?? join(homedir(), '.omnicross', 'chatgpt-web', 'bridge-token'),
    model: find('--model=') ?? 'chatgpt-web/pro',
    writable: argv.includes('--writable'),
    deadlineMs: numeric('--deadline-ms=', 600_000),
    logFile: find('--log-file=') ?? null,
  };
}

async function main(): Promise<void> {
  const options = parseServerOptions(process.argv);
  const log = (line: string): void => {
    if (options.logFile) {
      try {
        appendFileSync(options.logFile, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // Logging is best-effort.
      }
    }
  };

  let token = '';
  try {
    token = readFileSync(options.tokenFile, 'utf8').trim();
  } catch {
    process.stderr.write(`ask-pro: bridge token file not readable: ${options.tokenFile}\n`);
    process.exit(2);
  }
  if (!token) {
    process.stderr.write('ask-pro: bridge token file is empty\n');
    process.exit(2);
  }

  /** One consultation at a time — parallel calls fail fast instead of burning the client's tool timeout in a queue. */
  let busy = false;
  const aborts = new Map<number | string, AbortController>();

  const handleCall = async (request: JsonRpcRequest): Promise<void> => {
    const id = request.id!;
    const name = String(request.params?.['name'] ?? '');
    const args = (request.params?.['arguments'] ?? {}) as { question?: unknown };
    if (name !== 'ask_pro') {
      replyError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const question = typeof args['question'] === 'string' ? args['question'].trim() : '';
    if (!question) {
      reply(id, { content: [{ type: 'text', text: 'ask_pro requires a non-empty question string.' }], isError: true });
      return;
    }
    if (busy) {
      reply(id, {
        content: [{ type: 'text', text: 'Another ask_pro consultation is still running — wait for it to finish, then call again.' }],
        isError: true,
      });
      return;
    }
    busy = true;
    const controller = new AbortController();
    aborts.set(id, controller);
    log(`consultation start (model ${options.model}, question ${question.length} chars)`);
    try {
      const result = await consultPro({
        baseUrl: options.baseUrl,
        token,
        model: options.model,
        question,
        cwd: process.cwd(),
        platform: process.platform,
        writable: options.writable,
        deadlineMs: options.deadlineMs,
        signal: controller.signal,
        log,
      });
      log(`consultation done: ${result.toolCalls} tool call(s) over ${result.toolRounds} round(s)`);
      reply(id, { content: [{ type: 'text', text: result.answer }], isError: false });
    } catch (error) {
      if (error instanceof AskProError) {
        log(`consultation failed (${error.code}): ${error.message}`);
        const partial = error.partialText.trim();
        const text =
          `ask_pro failed (${error.code}): ${error.message}` +
          (partial ? `\n\nPartial output produced before the failure:\n${partial.slice(0, 8_000)}` : '');
        reply(id, { content: [{ type: 'text', text }], isError: true });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        log(`consultation crashed: ${message}`);
        reply(id, { content: [{ type: 'text', text: `ask_pro crashed: ${message}` }], isError: true });
      }
    } finally {
      busy = false;
      aborts.delete(id);
    }
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) void handleRequest(line);
      newline = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));

  async function handleRequest(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return; // Protocol garbage — ignore silently on a stream transport.
    }
    if (request.method === 'notifications/cancelled') {
      const requestId = request.params?.['requestId'];
      if (requestId !== undefined && (typeof requestId === 'number' || typeof requestId === 'string')) {
        aborts.get(requestId)?.abort();
        aborts.delete(requestId);
        log(`consultation cancelled by client (request ${String(requestId)})`);
      }
      return;
    }
    if (request.id === undefined) {
      return; // Other notifications need no response.
    }
    switch (request.method) {
      case 'initialize': {
        const clientVersion = request.params?.['protocolVersion'];
        reply(request.id, {
          protocolVersion: typeof clientVersion === 'string' ? clientVersion : MCP_FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'omnicross-chatgpt-web-askpro', version: '0.5.0' },
        });
        return;
      }
      case 'ping':
        reply(request.id, {});
        return;
      case 'tools/list':
        reply(request.id, { tools: [ASK_PRO_TOOL] });
        return;
      case 'tools/call':
        await handleCall(request);
        return;
      default:
        replyError(request.id, -32601, `Method not found: ${request.method}`);
    }
  }
}

// --- entry guard ---------------------------------------------------------------

function invokedDirectly(): boolean {
  try {
    if (!process.argv[1]) return false;
    const self = import.meta.url;
    const entry = pathToFileURL(process.argv[1]).href;
    return process.platform === 'win32'
      ? self.toLowerCase() === entry.toLowerCase()
      : self === entry;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    process.stderr.write(`ask-pro server: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
