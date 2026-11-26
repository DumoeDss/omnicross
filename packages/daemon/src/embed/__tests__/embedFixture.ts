/**
 * Shared fixtures for the embedding-entry tests: a local mock upstream (models,
 * Anthropic Messages, OpenAI Chat/Responses), a fake OAuth token/device
 * endpoint FetchLike, and a temp sandbox with its own HOME. No test here talks
 * to a real upstream.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface MockUpstream {
  readonly url: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Answers `/models`, Anthropic Messages, OpenAI Chat Completions and Responses. */
export async function startMockUpstream(models: readonly string[] = ['mock-a', 'mock-b']): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '/';
      requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && path.endsWith('/models')) {
        return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
      }
      let model = 'mock-a';
      try {
        model = (JSON.parse(body) as { model?: string }).model ?? model;
      } catch {
        // keep default
      }
      if (path.includes('/messages') || req.headers['anthropic-version']) {
        return json(200, {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        });
      }
      if (path.includes('/responses')) {
        return json(200, {
          id: 'resp_mock',
          object: 'response',
          status: 'completed',
          model,
          output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        });
      }
      return json(200, {
        id: 'chatcmpl_mock',
        object: 'chat.completion',
        created: 1,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An unsigned JWT-shaped string (some flows read claims from tokens). */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;
}

export interface FakeOAuthEndpoint {
  readonly calls: string[];
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * A FetchLike standing in for every provider's token / device endpoint: device
 * authorization requests get a device code, everything else gets a token set.
 */
export function fakeOAuthEndpoint(): FakeOAuthEndpoint {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string): Promise<Response> {
      calls.push(url);
      const json = (payload: unknown): Response =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      if (/device/i.test(url) && !/token/i.test(url)) {
        return json({
          device_code: 'device-code-1',
          user_code: 'USER-CODE',
          verification_uri: 'https://example.test/device',
          verification_uri_complete: 'https://example.test/device?code=USER-CODE',
          expires_in: 900,
          interval: 1,
        });
      }
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return json({
        access_token: fakeJwt({ sub: 'user-1', exp, user_id: 'user-1' }),
        refresh_token: 'refresh-token-1',
        id_token: fakeJwt({
          email: 'user@example.test',
          exp,
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' },
        }),
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'user:inference user:profile',
      });
    },
  };
}

export interface Sandbox {
  /** Root of everything the test owns. */
  readonly root: string;
  /** The host's `dataDir`. */
  readonly dataDir: string;
  /** A stand-in user home (HOME / USERPROFILE point here during the test). */
  readonly home: string;
  /** Every file under `root` outside `dataDir`, relative to `root`. */
  filesOutsideDataDir(): string[];
  /** Every file under `dataDir`, relative to it. */
  dataDirFiles(): string[];
  cleanup(): void;
}

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'embed-host-'));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  return {
    root,
    dataDir,
    home,
    filesOutsideDataDir: () =>
      walk(root)
        .filter((file) => !file.startsWith(dataDir))
        .map((file) => relative(root, file)),
    dataDirFiles: () => walk(dataDir).map((file) => relative(dataDir, file)).sort(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Poll `check` until it returns a value or `timeoutMs` elapses. */
export async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every string in a launch descriptor (env names, env values, args). */
export function launchStrings(launch: { env: Record<string, string>; extraArgs: readonly string[] }): string[] {
  return [...Object.keys(launch.env), ...Object.values(launch.env), ...launch.extraArgs];
}
