/**
 * broker.ts — bridge-side turn broker for MCP tool calls.
 *
 * The tunnel spawns our MCP server as a separate child process; this broker
 * (a loopback TCP JSON endpoint inside the bridge process) is the ONLY thing
 * that process talks to. A live browser turn registers itself with a
 * one-shot turn token; MCP tool calls arrive tagged with that token and are
 * handed to the turn (which relays them to Codex as function_call SSE
 * events); the follow-up Codex request delivers the output and resolves the
 * parked invocation, which unblocks the MCP response to ChatGPT.
 *
 * @module @omnicross/chatgpt-web/tunnel/broker
 */

import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

export interface BrokerToolRequest {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface BrokerToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** The live-turn surface the broker calls into. */
export interface BrokerTurnHandler {
  /** Relay one tool call to Codex; resolves when the follow-up request lands. */
  onToolRequest(request: BrokerToolRequest): Promise<BrokerToolResult>;
}

interface RegisteredTurn {
  token: string;
  handler: BrokerTurnHandler;
  registeredAt: number;
}

interface BrokerMessage {
  op: 'register' | 'claim' | 'invoke' | 'resolve' | 'unregister' | 'ping';
  token?: string;
  callId?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: BrokerToolResult;
}

const TURN_TTL_MS = 30 * 60_000;

/** Loopback broker. One per bridge process. */
export class TurnBroker {
  private readonly turns = new Map<string, RegisteredTurn>();
  private readonly invocations = new Map<string, Promise<BrokerToolResult>>();
  private server: Server | null = null;
  private port = 0;
  private secret = '';

  /** Listen on an ephemeral loopback port; resolves with (port, secret). */
  listen(): Promise<{ port: number; secret: string }> {
    if (this.server) return Promise.resolve({ port: this.port, secret: this.secret });
    this.secret = randomBytes(24).toString('hex');
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleSocket(socket));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this.server = server;
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve({ port: this.port, secret: this.secret });
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.turns.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Register the live turn under its prompt-advertised token (the token the
   * model copies into every Codex Native call).
   */
  registerTurn(token: string, handler: BrokerTurnHandler): string {
    if (!/^turn_[A-Za-z0-9_-]{8,64}$/.test(token)) {
      throw new Error('turn token must be turn_ plus 8-64 url-safe characters');
    }
    this.turns.set(token, { token, handler, registeredAt: Date.now() });
    this.pruneExpired();
    return token;
  }

  unregisterTurn(token: string): void {
    this.turns.delete(token);
  }

  /** In-process invocation path (the turn loop itself never crosses TCP). */
  async invokeInProcess(token: string, request: BrokerToolRequest): Promise<BrokerToolResult> {
    const turn = this.turns.get(token);
    if (!turn) {
      return {
        content: [{ type: 'text', text: `Codex turn ${token} is not active (expired or completed).` }],
        isError: true,
      };
    }
    const existing = this.invocations.get(request.callId);
    if (existing) return existing;
    const invocation = turn.handler.onToolRequest(request).finally(() => {
      this.invocations.delete(request.callId);
    });
    this.invocations.set(request.callId, invocation);
    return invocation;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [token, turn] of this.turns) {
      if (now - turn.registeredAt > TURN_TTL_MS && !this.invocations.size) {
        this.turns.delete(token);
      }
    }
  }

  private handleSocket(socket: Socket): void {
    socket.setNoDelay(true);
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          void this.handleLine(line, socket);
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => undefined);
  }

  private async handleLine(line: string, socket: Socket): Promise<void> {
    let message: BrokerMessage & { replyTo?: string };
    try {
      const parsed = JSON.parse(line) as BrokerMessage & { secret?: string; replyTo?: string };
      if (parsed.secret !== this.secret) {
        this.reply(socket, { ok: false, error: 'unauthorized' });
        return;
      }
      message = parsed;
    } catch {
      this.reply(socket, { ok: false, error: 'invalid json' });
      return;
    }
    // Echo the caller's correlation id so child-process clients can match replies.
    const replyTo = message.replyTo;
    try {
      switch (message.op) {
        case 'ping':
          this.reply(socket, { replyTo,  ok: true });
          return;
        case 'register':
        case 'unregister':
          // Registration is in-process only (turns register directly).
          this.reply(socket, { replyTo,  ok: false, error: `op ${message.op} is in-process only` });
          return;
        case 'claim': {
          const active = this.turns.has(String(message.token));
          this.reply(socket, { replyTo,  ok: active, error: active ? undefined : 'unknown turn token' });
          return;
        }
        case 'invoke': {
          const result = await this.invokeInProcess(String(message.token), {
            callId: String(message.callId ?? ''),
            tool: String(message.tool ?? ''),
            arguments: message.arguments ?? {},
          });
          this.reply(socket, { replyTo,  ok: true, result });
          return;
        }
        case 'resolve':
          // Resolution arrives via the follow-up HTTP request, not via TCP.
          this.reply(socket, { replyTo,  ok: false, error: 'op resolve is HTTP-side only' });
          return;
        default:
          this.reply(socket, { replyTo,  ok: false, error: `unknown op ${String((message as BrokerMessage).op)}` });
      }
    } catch (error) {
      this.reply(socket, { replyTo,  ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private reply(socket: Socket, payload: Record<string, unknown>): void {
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(payload)}\n`);
    }
  }
}
