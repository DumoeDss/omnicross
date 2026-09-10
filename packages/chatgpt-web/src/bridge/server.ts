/**
 * server.ts — the loopback OpenAI-Responses bridge over the browser worker.
 *
 * Serves exactly what Codex needs from a custom `model_providers` base_url:
 *   GET  /healthz              liveness + active turn count
 *   GET  /v1/models            the chatgpt-web/* catalog (full list, unfiltered)
 *   POST /v1/responses         SSE (stream=true) or JSON; chatgpt-web/* only
 *   POST /v1/responses/compact remote compaction v1 (unary replacement history)
 *
 * Loopback-only bind, optional bearer token (the codex launch wiring passes
 * one via env_key), request-abort propagation (Codex Esc → click Stop → close
 * the tab), and an explicit JSON error envelope for every failure.
 *
 * @module @omnicross/chatgpt-web/bridge/server
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { ChatGptWebCapacityError, ChatGptWebBridgeWorker } from './worker';
import { buildCompactV1Output, extractCompactUserMessages } from './compaction';
import { buildChatGptWebModelsDocument } from './models';
import { parseRequest } from './parser';
import { bridgeToResponsesSSE, formatErrorPayload } from './sse';
import type { BridgeEvent } from './types';

const MAX_BODY_BYTES = 160 * 1024 * 1024;

export interface ChatGptWebBridgeServerOptions {
  port?: number;
  /** Require this bearer token on /v1/* (omit to accept any loopback caller). */
  authToken?: string;
  cdpPort?: number;
  onDiagnostic?: (checkpoint: string) => void;
  onError?: (error: Error) => void;
}

export interface RunningBridge {
  server: Server;
  port: number;
  baseUrl: string;
  worker: ChatGptWebBridgeWorker;
  stop: () => Promise<void>;
}

/** Error carrying an HTTP status for the JSON error envelope. */
class BridgeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type = 'server_error',
  ) {
    super(message);
  }
}

/** Start the bridge on 127.0.0.1. Resolves once listening. */
export async function startChatGptWebBridge(options: ChatGptWebBridgeServerOptions = {}): Promise<RunningBridge> {
  const worker = new ChatGptWebBridgeWorker({
    cdpPort: options.cdpPort,
    onDiagnostic: options.onDiagnostic,
  });
  const authToken = options.authToken;
  const server = createServer((req, res) => {
    void handleRequest(req, res, { worker, authToken, onError: options.onError }).catch((error) => {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify(formatErrorPayload(500, 'server_error', 'bridge internal error')));
    });
  });
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    worker,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      worker.connection.close();
    },
  };
}

interface RequestContext {
  worker: ChatGptWebBridgeWorker;
  authToken?: string;
  onError?: (error: Error) => void;
}

async function handleRequest(req: IncomingMessage, res: import('node:http').ServerResponse, context: RequestContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'omnicross-chatgpt-web', pid: process.pid }));
    return;
  }

  if (pathname === '/v1/models' && req.method === 'GET') {
    // Serve the full catalog unfiltered: model selection rides `-m`, and gating
    // this on a live probe would break Codex startup while Chrome is closed.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildChatGptWebModelsDocument({ solAvailable: true, proAvailable: true })));
    return;
  }

  if (pathname.startsWith('/v1/')) {
    if (context.authToken !== undefined && !authorized(req, context.authToken)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(formatErrorPayload(401, 'authentication_error', 'missing or invalid bearer token')));
      return;
    }
    if (pathname === '/v1/responses' && req.method === 'POST') {
      await handleResponses(req, res, context);
      return;
    }
    if (pathname === '/v1/responses/compact' && req.method === 'POST') {
      await handleCompact(req, res, context);
      return;
    }
    if (pathname === '/v1/responses' && req.method === 'GET') {
      // Codex's WebSocket prewarm probe: 426 = capability negotiation signal.
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Responses WebSocket transport is not enabled on this local route');
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(formatErrorPayload(404, 'invalid_request_error', `unknown route: ${req.method} ${pathname}`)));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'] ?? '';
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(String(header));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new BridgeHttpError('request body exceeds the bridge size limit', 413, 'invalid_request_error');
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleResponses(req: IncomingMessage, res: import('node:http').ServerResponse, context: RequestContext): Promise<void> {
  let parsed;
  try {
    const body = await readJsonBody(req);
    parsed = parseRequest(body);
  } catch (error) {
    respondJson(res, 400, formatErrorPayload(400, 'invalid_request_error', error instanceof Error ? error.message : String(error)));
    return;
  }

  const abort = new AbortController();
  req.on('close', () => abort.abort());
  let events: AsyncGenerator<BridgeEvent>;
  try {
    events = context.worker.runRequest(parsed, abort.signal);
  } catch (error) {
    respondError(res, error, context);
    return;
  }

  if (!parsed.stream) {
    const collected: BridgeEvent[] = [];
    try {
      for await (const event of events) collected.push(event);
    } catch (error) {
      respondError(res, error, context);
      return;
    }
    const { buildResponseJSON } = await import('./sse');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildResponseJSON(collected, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      compaction: parsed._compactionRequest === true,
    })));
    return;
  }

  const stream = bridgeToResponsesSSE(events, parsed.modelId, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    compaction: parsed._compactionRequest === true,
  });
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const nodeStream = Readable.fromWeb(stream as import('node:stream/web').ReadableStream);
  nodeStream.pipe(res);
  nodeStream.on('error', (error) => {
    context.onError?.(error instanceof Error ? error : new Error(String(error)));
    res.end();
  });
}

async function handleCompact(req: IncomingMessage, res: import('node:http').ServerResponse, context: RequestContext): Promise<void> {
  let parsed;
  let rawInput: unknown;
  try {
    const body = await readJsonBody(req);
    rawInput = (body as { input?: unknown })?.input;
    parsed = parseRequest(body);
  } catch (error) {
    respondJson(res, 400, formatErrorPayload(400, 'invalid_request_error', error instanceof Error ? error.message : String(error)));
    return;
  }
  // v1 compaction: run the summarization turn and return replacement history.
  const summarized = Object.assign(parsed, { _compactionRequest: true });
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  let summary = '';
  try {
    for await (const event of context.worker.runRequest(summarized, abort.signal)) {
      if (event.type === 'text_delta') summary += event.text;
      if (event.type === 'error') throw new BridgeHttpError(event.message, event.status ?? 502);
    }
  } catch (error) {
    respondError(res, error, context);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      object: 'response',
      output: buildCompactV1Output(extractCompactUserMessages(rawInput), summary.trim()),
    }),
  );
}

function respondError(res: import('node:http').ServerResponse, error: unknown, context: RequestContext): void {
  if (error instanceof ChatGptWebCapacityError) {
    respondJson(res, 429, formatErrorPayload(429, 'rate_limit_error', error.message, 'browser_turn_capacity'));
    return;
  }
  const carried = (error as { status?: unknown })?.status;
  const status =
    typeof carried === 'number' && Number.isInteger(carried) && carried >= 400 && carried <= 599
      ? carried
      : (error as { name?: unknown })?.name === 'AbortError'
        ? 499
        : 500;
  const message = error instanceof Error ? error.message : String(error);
  context.onError?.(error instanceof Error ? error : new Error(message));
  respondJson(
    res,
    status,
    formatErrorPayload(status, status === 400 ? 'invalid_request_error' : 'server_error', message),
  );
}

function respondJson(res: import('node:http').ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Generate a random bearer token for the codex launch wiring. */
export function generateBridgeToken(): string {
  return randomBytes(24).toString('hex');
}
