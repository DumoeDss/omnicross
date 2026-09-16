/**
 * ask_pro tests: read-only command policy, SSE accumulation, and the full
 * consult loop against a mock bridge (two harness rounds with a parked
 * function_call answered in a follow-up request — the wire shape the
 * harness round-trip script proved against real Pro).
 *
 * @module @omnicross/chatgpt-web/__tests__/askpro.test
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AskProError,
  capOutput,
  checkReadonlyCommand,
  consultPro,
  createProSseAccumulator,
  resolveCommandExecutable,
  type ShellExecResult,
} from '../askpro/askProCore';

// --- read-only policy ----------------------------------------------------------

describe('checkReadonlyCommand', () => {
  const ok = (argv: string[]) => expect(checkReadonlyCommand(argv).ok).toBe(true);
  const rejected = (argv: string[]) => {
    const verdict = checkReadonlyCommand(argv);
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.reason.length).toBeGreaterThan(0);
  };

  it('allows git read-only subcommands including global flags', () => {
    ok(['git', 'log', '--oneline', '-5']);
    ok(['git', 'show', 'HEAD:README.md']);
    ok(['git', '-C', 'E:\\some repo', 'log', '-p']);
    ok(['git', '--no-pager', 'diff', '--stat']);
    ok(['git', 'grep', '-n', 'askProCore']);
    ok(['git', 'stash', 'list']);
    ok(['git', 'worktree', 'list']);
    ok(['git', 'config', '--list']);
    ok(['git.exe', 'status']);
  });

  it('rejects mutating git subcommands and two-word/config forms', () => {
    rejected(['git', 'push']);
    rejected(['git', 'commit', '-m', 'x']);
    rejected(['git', 'clean', '-fd']);
    rejected(['git', 'stash', 'pop']);
    rejected(['git', 'config', 'user.email', 'a@b.c']);
    rejected(['git']);
  });

  it('allows plain readers and rejects interpreters, mutators, and package managers', () => {
    ok(['cat', 'src/index.ts']);
    ok(['rg', '-n', 'pattern', '.']);
    ok(['findstr', '/i', 'needle', 'haystack.txt']);
    ok(['head', '-n', '50', 'log.txt']);
    rejected(['rm', '-rf', '/']);
    rejected(['node', '-e', 'console.log(1)']);
    rejected(['python', 'script.py']);
    rejected(['awk', '{print > "out"}']);
    rejected(['sed', '-i', 's/a/b/', 'file']);
    rejected(['powershell', '-Command', 'Get-ChildItem']);
    rejected(['npm', 'install']);
    rejected(['./malicious-tool']);
    rejected([]);
    rejected(['']);
  });

  it('gates find on mutating flags', () => {
    ok(['find', '.', '-name', '*.ts']);
    rejected(['find', '.', '-name', 'x', '-delete']);
    rejected(['find', '.', '-exec', 'rm', '{}', ';']);
  });

  it('allows cmd /c only for read-only builtins without shell metacharacters', () => {
    ok(['cmd', '/c', 'type', 'package.json']);
    ok(['cmd', '/C', 'dir', '/b']);
    rejected(['cmd', '/c', 'del', 'file.txt']);
    rejected(['cmd', '/k', 'type', 'file']);
    rejected(['cmd', '/c', 'type', 'a.txt', '>', 'b.txt']);
    rejected(['cmd', '/c', 'type', 'a%PATH%.txt']);
    rejected(['cmd']);
  });
});

// --- output capping --------------------------------------------------------------

it('capOutput keeps head and tail with a truncation note', () => {
  const text = 'a'.repeat(70_000);
  const capped = capOutput(text, 64_000);
  expect(capped.length).toBeLessThan(70_000);
  expect(capped).toContain('[output truncated');
  expect(capped.startsWith('a'.repeat(100))).toBe(true);
  expect(capped.endsWith('a'.repeat(100))).toBe(true);
  expect(capOutput('short', 64_000)).toBe('short');
});

// --- SSE accumulator ---------------------------------------------------------------

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe('createProSseAccumulator', () => {
  it('collects text, tool calls, and a normal park (adapter_eof after calls)', () => {
    const acc = createProSseAccumulator();
    acc.push(
      sse({ type: 'response.output_text.delta', delta: 'Let me check…' }) +
        sse({
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["git","log"]}' },
        }) +
        sse({ type: 'response.incomplete', response: { incomplete_details: { reason: 'adapter_eof' } } }),
    );
    const snap = acc.snapshot();
    expect(snap.text).toBe('Let me check…');
    expect(snap.calls).toHaveLength(1);
    expect(snap.calls[0]).toMatchObject({ callId: 'call_1', name: 'shell', freeform: false });
    expect(snap.terminal).toBe('incomplete');
    expect(snap.incompleteReason).toBe('adapter_eof');
  });

  it('handles custom_tool_call items and completed terminals across split chunks', () => {
    const acc = createProSseAccumulator();
    const stream =
      sse({ type: 'response.output_item.done', item: { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch' } }) +
        sse({ type: 'response.output_text.delta', delta: 'Done.' }) +
        sse({ type: 'response.completed' }) +
        'data: [DONE]\n\n';
    // Feed in odd-sized slices so frame boundaries split mid-JSON.
    for (let index = 0; index < stream.length; index += 7) {
      acc.push(stream.slice(index, index + 7));
    }
    const snap = acc.snapshot();
    expect(snap.calls).toHaveLength(1);
    expect(snap.calls[0]).toMatchObject({ freeform: true, argumentsJson: '*** Begin Patch' });
    expect(snap.text).toBe('Done.');
    expect(snap.terminal).toBe('completed');
    expect(snap.sawData).toBe(true);
  });

  it('captures failure messages', () => {
    const acc = createProSseAccumulator();
    acc.push(sse({ type: 'response.failed', response: { error: { message: 'usage limit' } } }));
    expect(acc.snapshot().terminal).toBe('failed');
    expect(acc.snapshot().failureMessage).toBe('usage limit');
  });
});

// --- executable resolution -----------------------------------------------------------

describe('resolveCommandExecutable', () => {
  it('never resolves from the cwd directory and rejects script extensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'askpro-path-'));
    try {
      // cwd contains a shadowing script — must never be picked.
      writeFileSync(join(dir, 'zz-askpro-shadow.cmd'), '@echo off\n');
      writeFileSync(join(dir, 'zz-askpro-shadow.bat'), '@echo off\n');
      const previousPath = process.env.PATH;
      process.env.PATH = dir;
      try {
        expect(resolveCommandExecutable('zz-askpro-shadow', dir)).toBeNull();
      } finally {
        process.env.PATH = previousPath;
      }
      // A real executable further down PATH resolves by extension.
      const binDir = join(dir, 'bin');
      mkdirSync(binDir);
      if (process.platform === 'win32') {
        writeFileSync(join(binDir, 'zz-askpro-real.exe'), '');
      } else {
        writeFileSync(join(binDir, 'zz-askpro-real'), '');
      }
      process.env.PATH = binDir;
      try {
        const resolved = resolveCommandExecutable('zz-askpro-real', dir);
        expect(resolved).toContain('zz-askpro-real');
      } finally {
        process.env.PATH = previousPath;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- the consult loop against a mock bridge ---------------------------------------------

interface CapturedRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

function frame(...events: Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

describe('consultPro against a mock bridge', () => {
  let server: Server;
  let baseUrl: string;
  let harnessOn: boolean;
  let forceStatus: { status: number; body: string } | null;
  let respondWith: (requests: CapturedRequest[]) => string;
  let captured: CapturedRequest[];
  let executed: string[][];
  let executeResult: ShellExecResult;

  const fakeExecute = (argv: string[], options: { cwd: string; timeoutMs: number }): Promise<ShellExecResult> => {
    expect(options.cwd.length).toBeGreaterThan(0);
    executed.push(argv);
    return Promise.resolve(executeResult);
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', harness: harnessOn }));
          return;
        }
        if (req.url === '/v1/responses' && req.method === 'POST') {
          captured.push({
            authorization: req.headers['authorization'],
            body: JSON.parse(bodyText) as Record<string, unknown>,
          });
          if (forceStatus) {
            res.writeHead(forceStatus.status, { 'content-type': 'application/json' });
            res.end(forceStatus.body);
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(respondWith(captured));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  beforeEach(() => {
    harnessOn = true;
    forceStatus = null;
    captured = [];
    executed = [];
    executeResult = { output: '1a1bad7 feat: probe', exitCode: 0, timedOut: false, notFound: false };
  });

  const baseOptions = () => ({
    baseUrl,
    token: 'tok-1',
    model: 'chatgpt-web/pro',
    question: 'What is the latest commit?',
    cwd: process.cwd(),
    platform: process.platform,
    execute: fakeExecute,
  });

  it('runs a parked tool round and answers it in a follow-up request with full echo', async () => {
    respondWith = (requests) =>
      requests.length === 1
        ? frame(
            { type: 'response.output_text.delta', delta: 'Checking… ' },
            {
              type: 'response.output_item.done',
              item: { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"command":["git","log","--oneline","-1"]}' },
            },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'adapter_eof' } } },
          )
        : frame(
            { type: 'response.output_text.delta', delta: 'The latest commit is 1a1bad7.' },
            { type: 'response.completed' },
          );

    const result = await consultPro(baseOptions());

    expect(result.answer).toBe('Checking… The latest commit is 1a1bad7.');
    expect(result.toolCalls).toBe(1);
    expect(result.toolRounds).toBe(1);
    expect(executed).toEqual([['git', 'log', '--oneline', '-1']]);

    expect(captured).toHaveLength(2);
    expect(captured[0].authorization).toBe('Bearer tok-1');
    expect(captured[0].body['model']).toBe('chatgpt-web/pro');
    expect(captured[0].body['stream']).toBe(true);
    const followUp = captured[1].body['input'] as Array<Record<string, unknown>>;
    const types = followUp.map((item) => item['type']);
    expect(types).toEqual(['message', 'function_call', 'function_call_output']);
    const echoedCall = followUp[1];
    expect(echoedCall['call_id']).toBe('call_a');
    expect(echoedCall['arguments']).toBe('{"command":["git","log","--oneline","-1"]}');
    const output = followUp[2];
    expect(output['call_id']).toBe('call_a');
    expect(String(output['output'])).toContain('1a1bad7 feat: probe');
    expect(String(output['output'])).toContain('[exit 0]');
  });

  it('answers readonly violations as in-band errors Pro can adapt to', async () => {
    executeResult = { output: '', exitCode: 0, timedOut: false, notFound: false };
    respondWith = (requests) =>
      requests.length === 1
        ? frame(
            {
              type: 'response.output_item.done',
              item: { type: 'function_call', call_id: 'call_b', name: 'shell', arguments: '{"command":["npm","install"]}' },
            },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'adapter_eof' } } },
          )
        : frame({ type: 'response.completed' });

    const result = await consultPro(baseOptions());

    expect(executed).toEqual([]); // never executed — policy rejected it first
    const followUp = captured[1].body['input'] as Array<Record<string, unknown>>;
    expect(String(followUp[2]['output'])).toContain('read-only policy');
    expect(result.toolCalls).toBe(1);
  });

  it('reports apply_patch as unavailable in v1', async () => {
    respondWith = (requests) =>
      requests.length === 1
        ? frame(
            {
              type: 'response.output_item.done',
              item: { type: 'custom_tool_call', call_id: 'call_c', name: 'apply_patch', input: '*** Begin Patch' },
            },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'adapter_eof' } } },
          )
        : frame({ type: 'response.completed' });

    await consultPro(baseOptions());

    const followUp = captured[1].body['input'] as Array<Record<string, unknown>>;
    expect(followUp[1]['type']).toBe('custom_tool_call');
    expect(followUp[2]['type']).toBe('custom_tool_call_output');
    expect(String(followUp[2]['output'])).toContain('apply_patch is not available');
  });

  it('fails fast on bridge-down and harness-off', async () => {
    harnessOn = false;
    await expect(consultPro(baseOptions())).rejects.toMatchObject({ code: 'harness-off' });
    harnessOn = true;
    await expect(consultPro({ ...baseOptions(), baseUrl: 'http://127.0.0.1:1' })).rejects.toMatchObject({ code: 'bridge-down' });
  });

  it('maps HTTP 429 to a busy error and turn failures to partial-text errors', async () => {
    forceStatus = { status: 429, body: JSON.stringify({ error: { message: 'a full-harness turn is still waiting' } }) };
    await expect(consultPro(baseOptions())).rejects.toMatchObject({ code: 'busy' });
    forceStatus = null;

    respondWith = () => frame({ type: 'response.output_text.delta', delta: 'partial…' }, { type: 'response.failed', response: { error: { message: 'usage limit' } } });
    const failure = await consultPro(baseOptions()).catch((error: unknown) => error as AskProError);
    expect(failure).toBeInstanceOf(AskProError);
    expect((failure as AskProError).code).toBe('turn-failed');
    expect((failure as AskProError).message).toContain('usage limit');
    expect((failure as AskProError).partialText).toBe('partial…');
  });

  it('stops after maxToolRounds and reports rounds-exceeded with partial text', async () => {
    respondWith = () =>
      frame(
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: `call_${Math.random()}`, name: 'shell', arguments: '{"command":["git","status"]}' },
        },
        { type: 'response.incomplete', response: { incomplete_details: { reason: 'adapter_eof' } } },
      );
    const failure = await consultPro({ ...baseOptions(), maxToolRounds: 2 }).catch((error: unknown) => error as AskProError);
    expect(failure).toBeInstanceOf(AskProError);
    expect((failure as AskProError).code).toBe('rounds-exceeded');
    expect(captured).toHaveLength(3); // initial + 2 tool rounds
  });
});
