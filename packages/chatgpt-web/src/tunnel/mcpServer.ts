/**
 * mcpServer.ts — stdio MCP server child for the ChatGPT tunnel.
 *
 * The tunnel spawns this process (`--mcp-command`) and bridges ChatGPT's
 * connector calls to it. Speaks MCP over newline-delimited JSON-RPC 2.0 on
 * stdin/stdout (initialize / tools/list / tools/call / ping) and forwards
 * tool calls to the bridge's turn broker over loopback TCP.
 *
 * Entry: node mcpServer.js --broker-port <n> --broker-secret <s>
 *
 * @module @omnicross/chatgpt-web/tunnel/mcpServer
 */

import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface BrokerToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const MCP_PROTOCOL_VERSION = '2025-06-18';

function out(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string, result: Record<string, unknown>): void {
  out({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string, code: number, message: string): void {
  out({ jsonrpc: '2.0', id, error: { code, message } });
}

// --- Broker TCP client -----------------------------------------------------

class BrokerClient {
  private buffer = '';
  private pending = new Map<string, (payload: Record<string, unknown>) => void>();

  constructor(
    private readonly port: number,
    private readonly secret: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.port, '127.0.0.1', () => resolve());
      socket.setNoDelay(true);
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (line.trim()) {
            try {
              const payload = JSON.parse(line) as { replyTo?: string };
              if (payload.replyTo && this.pending.has(payload.replyTo)) {
                this.pending.get(payload.replyTo)!(payload);
                this.pending.delete(payload.replyTo);
              }
            } catch {
              // Ignore malformed broker frames.
            }
          }
          newline = this.buffer.indexOf('\n');
        }
      });
      this.socket = socket;
    });
  }

  private socket: import('node:net').Socket | null = null;

  request(op: string, extra: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const replyTo = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(replyTo);
        resolve({ ok: false, error: `broker ${op} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(replyTo, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      this.socket?.write(`${JSON.stringify({ op, replyTo, secret: this.secret, ...extra })}\n`);
    });
  }
}

// --- Tool surface -----------------------------------------------------------

interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TURN_TOKEN_SCHEMA = {
  type: 'string',
  description: 'The turn_token from the active Codex request. Pass it through unchanged on every call in this response.',
};

export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: 'codex_shell',
    description:
      'Run a shell command in the user\'s Codex workspace sandbox. Use for listing/reading files, searching, git, and any local inspection. Codex applies its own sandbox and approval rules.',
    inputSchema: {
      type: 'object',
      properties: {
        turn_token: TURN_TOKEN_SCHEMA,
        command: { type: 'array', items: { type: 'string' }, description: 'Argv array to execute, e.g. ["git","status"].' },
        timeout_ms: { type: 'number', description: 'Optional per-command timeout in milliseconds.' },
      },
      required: ['turn_token', 'command'],
    },
  },
  {
    name: 'codex_apply_patch',
    description:
      'Apply a file patch in the Codex workspace. The input follows the standard Codex apply_patch envelope beginning with *** Begin Patch.',
    inputSchema: {
      type: 'object',
      properties: {
        turn_token: TURN_TOKEN_SCHEMA,
        input: { type: 'string', description: 'Raw apply_patch body starting with *** Begin Patch (no trailing ***).' },
      },
      required: ['turn_token', 'input'],
    },
  },
];

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  // The tunnel rejects mcp-command argv carrying secret material AND spawns
  // this child with a sanitized environment, so the broker secret normally
  // arrives via a private file reference: --broker-secret-file=<path>.
  const portArg = process.argv.find((arg) => arg.startsWith('--broker-port='));
  const secretFileArg = process.argv.find((arg) => arg.startsWith('--broker-secret-file='));
  const secretArg = process.argv.find((arg) => arg.startsWith('--broker-secret='));
  const port = portArg
    ? Number.parseInt(portArg.slice('--broker-port='.length), 10)
    : Number.parseInt(process.env['OMNICROSS_CHATGPT_WEB_BROKER_PORT'] ?? '', 10);
  const secret = secretFileArg
    ? readFileSync(secretFileArg.slice('--broker-secret-file='.length), 'utf8').trim()
    : secretArg
      ? secretArg.slice('--broker-secret='.length)
      : process.env['OMNICROSS_CHATGPT_WEB_BROKER_SECRET'] ?? '';
  if (!Number.isInteger(port) || port <= 0 || !secret) {
    process.stderr.write('mcpServer: broker port/secret are required (file, env, or argv)\n');
    process.exit(2);
  }
  const broker = new BrokerClient(port, secret);
  try {
    await broker.connect();
  } catch (error) {
    process.stderr.write(`mcpServer: broker connect failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

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
    if (request.id === undefined) {
      return; // Notifications need no response.
    }
    switch (request.method) {
      case 'initialize':
        reply(request.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'omnicross-chatgpt-web', version: '0.4.4' },
        });
        return;
      case 'ping':
        reply(request.id, {});
        return;
      case 'tools/list':
        reply(request.id, { tools: MCP_TOOLS });
        return;
      case 'tools/call': {
        const name = String(request.params?.['name'] ?? '');
        const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;
        const token = typeof args['turn_token'] === 'string' ? args['turn_token'] : '';
        if (!token) {
          reply(request.id, {
            content: [{ type: 'text', text: 'turn_token is required on every Codex tool call.' }],
            isError: true,
          });
          return;
        }
        if (!MCP_TOOLS.some((tool) => tool.name === name)) {
          replyError(request.id, -32602, `Unknown tool: ${name}`);
          return;
        }
        // A tool call may wait for Codex to execute and reply on its next
        // request — bound it well below the tunnel's 2-minute deadline.
        const payload = await broker.request(
          'invoke',
          { token, callId: randomUUID(), tool: name, arguments: args },
          110_000,
        );
        const result = payload['result'] as BrokerToolResult | undefined;
        if (payload['ok'] === true && result) {
          reply(request.id, { content: result.content, isError: result.isError === true });
        } else {
          reply(request.id, {
            content: [{ type: 'text', text: `Codex tool call failed: ${String(payload['error'] ?? 'broker rejected')}` }],
            isError: true,
          });
        }
        return;
      }
      default:
        replyError(request.id, -32601, `Method not found: ${request.method}`);
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`mcpServer: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
