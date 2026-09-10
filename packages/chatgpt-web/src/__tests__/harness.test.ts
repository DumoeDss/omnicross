/**
 * Full-harness tests: broker round-trips, MCP tool surface, harness config
 * persistence, and SSE tool-call framing.
 *
 * @module @omnicross/chatgpt-web/tunnel/__tests__/harness.test
 */

import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { TurnBroker } from '../tunnel/broker';
import { MCP_TOOLS } from '../tunnel/mcpServer';
import { loadHarnessConfig, saveHarnessConfig, harnessSetupChecklist, DEFAULT_CONNECTOR_NAME } from '../tunnel/harnessConfig';
import { bridgeToResponsesSSE } from '../bridge/sse';
import type { BridgeEvent } from '../bridge/types';

const broker = new TurnBroker();
let brokerEndpoint: { port: number; secret: string } | null = null;

afterAll(async () => {
  await broker.stop();
});

describe('TurnBroker', () => {
  it('routes in-process invocations to the registered turn handler', async () => {
    const seen: string[] = [];
    broker.registerTurn('turn_testtoken0001', {
      onToolRequest: async (request) => {
        seen.push(request.tool);
        return { content: [{ type: 'text', text: `ran ${request.tool}` }] };
      },
    });
    const result = await broker.invokeInProcess('turn_testtoken0001', {
      callId: 'call_1',
      tool: 'codex_shell',
      arguments: { command: ['ls'] },
    });
    expect(result.content[0]?.text).toBe('ran codex_shell');
    expect(seen).toEqual(['codex_shell']);
  });

  it('rejects unknown turn tokens with an error result', async () => {
    const result = await broker.invokeInProcess('turn_missing000001', { callId: 'c', tool: 'codex_shell', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('serves claim/invoke over loopback TCP with the shared secret', async () => {
    brokerEndpoint ??= await broker.listen();
    const { port, secret } = brokerEndpoint;
    broker.registerTurn('turn_tcptesttoken1', {
      onToolRequest: async () => ({ content: [{ type: 'text', text: 'tcp ok' }] }),
    });
    const reply = await tcpRoundTrip(port, { op: 'claim', secret, token: 'turn_tcptesttoken1' });
    expect(reply['ok']).toBe(true);
    const bad = await tcpRoundTrip(port, { op: 'claim', secret: 'wrong', token: 'turn_tcptesttoken1' });
    expect(bad['ok']).toBe(false);
    const invoked = await tcpRoundTrip(port, {
      op: 'invoke',
      secret,
      token: 'turn_tcptesttoken1',
      callId: 'call_tcp',
      tool: 'codex_shell',
      arguments: { command: ['pwd'] },
    });
    expect(invoked['ok']).toBe(true);
    expect((invoked['result'] as { content: Array<{ text: string }> }).content[0].text).toBe('tcp ok');
  });
});

function tcpRoundTrip(port: number, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1', () => {
      socket.write(`${JSON.stringify({ replyTo: 'x', ...payload })}\n`);
    });
    socket.once('data', (chunk: Buffer) => {
      resolve(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      socket.end();
    });
    socket.once('error', reject);
    setTimeout(() => reject(new Error('tcp timeout')), 5_000).unref();
  });
}

describe('MCP tool surface', () => {
  it('exposes codex_shell and codex_apply_patch, both requiring turn_token', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(['codex_shell', 'codex_apply_patch']);
    for (const tool of MCP_TOOLS) {
      const properties = tool.inputSchema['properties'] as Record<string, unknown>;
      expect(properties['turn_token']).toBeDefined();
      expect((tool.inputSchema['required'] as string[]).includes('turn_token')).toBe(true);
    }
  });
});

describe('harness config', () => {
  it('round-trips setup values and enforces the tunnel id shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-harness-'));
    try {
      const path = join(dir, 'harness.json');
      expect(() =>
        saveHarnessConfig({ tunnelId: 'nope', runtimeKey: 'sk-test123', path }),
      ).toThrow(/tunnel_/);
      const saved = saveHarnessConfig({
        tunnelId: 'tunnel_' + 'a'.repeat(32),
        runtimeKey: 'sk-test123',
        path,
      });
      expect(saved.connectorName).toBe(DEFAULT_CONNECTOR_NAME);
      const loaded = loadHarnessConfig(path);
      expect(loaded?.tunnelId).toBe(saved.tunnelId);
      expect(loaded?.runtimeKey).toBe('sk-test123');
      const checklist = harnessSetupChecklist(path);
      expect(checklist.tunnelConfigured).toBe(true);
      expect(checklist.steps.join('\n')).toContain('Codex Native2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SSE tool-call framing', () => {
  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  it('frames function_call items and terminates cleanly', async () => {
    const output = await collect(
      bridgeToResponsesSSE(
        (async function* () {
          yield { type: 'text_delta', text: 'checking…' } satisfies BridgeEvent;
          yield { type: 'tool_call_start', id: 'call_1', name: 'shell' } satisfies BridgeEvent;
          yield { type: 'tool_call_delta', arguments: '{"command":["ls"]}' } satisfies BridgeEvent;
          yield { type: 'tool_call_end' } satisfies BridgeEvent;
          yield { type: 'done' } satisfies BridgeEvent;
        })(),
        'chatgpt-web/pro',
      ),
    );
    expect(output).toContain('event: response.function_call_arguments.delta');
    expect(output).toContain('"name":"shell"');
    expect(output).toContain('"arguments":"{\\"command\\":[\\"ls\\"]}"');
    expect(output).toContain('event: response.completed');
    expect(output.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('frames freeform calls as custom_tool_call with unwrapped input', async () => {
    const output = await collect(
      bridgeToResponsesSSE(
        (async function* () {
          yield { type: 'tool_call_start', id: 'call_p', name: 'apply_patch', freeform: true } satisfies BridgeEvent;
          yield { type: 'tool_call_delta', arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) } satisfies BridgeEvent;
          yield { type: 'tool_call_end' } satisfies BridgeEvent;
          yield { type: 'done' } satisfies BridgeEvent;
        })(),
        'chatgpt-web/pro',
      ),
    );
    expect(output).toContain('"type":"custom_tool_call"');
    expect(output).toContain('*** Begin Patch');
    expect(output).not.toContain('response.function_call_arguments');
  });
});
