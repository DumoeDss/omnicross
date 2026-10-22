/**
 * AntigravityClaudeRoute tests — the anthropic-messages CLIENT end-to-end over
 * the antigravity subscription (antigravity-subscription-provider group-4
 * gates, tasks 4.1–4.4):
 *
 *   Anthropic wire ──AnthropicTransformer.transformRequestOut──▶ Unified
 *                ──AntigravityTransformer.transformRequestIn──▶ CCA envelope
 *   CCA SSE ──AntigravityTransformer.transformResponseOut──▶ OpenAI-compatible
 *          ──AnthropicTransformer.transformResponseIn───▶ Anthropic wire
 *
 * Asserts:
 *   - the Claude envelope snapshot (legacy `parameters` schema, VALIDATED,
 *     `anthropic-beta`, no `model_enum`, thinking wire id),
 *   - the legacy schema cleaning (NO `$schema` / `additionalProperties` /
 *     `$ref` / format / unsupported constraints survive),
 *   - thinking/tool_use block semantics survive the FULL round trip — a
 *     multi-turn tool_use → tool_result conversation replays the
 *     `thoughtSignature` back to the upstream (the CCA/Gemini signature
 *     channel), and the decoded response carries thinking + tool_use blocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.stubEnv('ANTIGRAVITY_VERSION', '2.8.0'));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

import { AnthropicTransformer } from '../transformers/AnthropicTransformer';
import { AntigravityTransformer } from '../transformers/AntigravityTransformer';
import { cleanSchemaForCcaLegacyParameters } from '../transformers/utils/ccaLegacySchema';
import type { LLMProvider, TransformerContext, UnifiedMessage } from '../types';

const ctx: TransformerContext = {};

const antigravityProvider: LLMProvider = {
  name: 'antigravity',
  baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
  apiKey: '',
  models: ['claude-sonnet-4-5'],
  geminiProject: 'proj-1',
};

/** One anthropic-messages request body (the Claude Code client shape). */
function anthropicBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    stream: true,
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather',
        input_schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name', pattern: '^[a-z ]+$' },
            unit: { type: ['string', 'null'], enum: ['c', 'f'] },
          },
          required: ['city'],
          additionalProperties: false,
        },
      },
    ],
    ...overrides,
  };
}

/** Drive anthropic-wire → Unified → the antigravity CCA envelope. */
async function toCcaEnvelope(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const unified = await new AnthropicTransformer().transformRequestOut(body, ctx);
  const out = await new AntigravityTransformer().transformRequestIn(
    unified,
    antigravityProvider,
    ctx,
  );
  return (out as { body: Record<string, unknown> }).body;
}

describe('Claude envelope snapshot (anthropic-messages client → CCA)', () => {
  it('carries the Claude decoration: legacy parameters schema, VALIDATED, beta header, thinking wire id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The anthropic-native thinking knob (adaptive + output effort) — the
    // decoder maps it to a unified reasoning intent.
    const envelope = await toCcaEnvelope(
      anthropicBody({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }),
    );

    // Thinking variant wire id.
    expect(envelope.model).toBe('claude-sonnet-4-5-thinking');
    expect(envelope.project).toBe('proj-1');
    expect(envelope.userAgent).toBe('antigravity');
    expect(envelope.requestType).toBe('agent');

    const inner = envelope.request as Record<string, unknown>;
    // ALWAYS VALIDATED for the Claude family.
    const toolConfig = inner.toolConfig as { functionCallingConfig: { mode: string } };
    expect(toolConfig.functionCallingConfig.mode).toBe('VALIDATED');
    // Legacy `parameters` (NOT parametersJsonSchema).
    const tools = inner.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    const declaration = tools[0]?.functionDeclarations[0];
    expect(declaration?.parameters).toBeDefined();
    expect(declaration?.parametersJsonSchema).toBeUndefined();
    // No model_enum for the Claude family.
    const labels = inner.labels as Record<string, string>;
    expect(labels.model_enum).toBeUndefined();
    expect(labels.used_claude).toBe('true');
  });
});

describe('legacy schema cleaning', () => {
  it('strips $schema/additionalProperties/$ref/format and unsupported constraints', () => {
    const cleaned = cleanSchemaForCcaLegacyParameters({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'urn:weather',
      $defs: { x: { type: 'string', enum: ['resolved'] } },
      type: 'object',
      properties: {
        city: { type: 'string', minLength: 2, maxLength: 40 },
        nested: {
          type: 'object',
          properties: { deep: { $ref: '#/$defs/x' } },
          additionalProperties: false,
        },
      },
      required: ['city'],
      additionalProperties: false,
    }) as Record<string, unknown>;

    const json = JSON.stringify(cleaned);
    expect(json).not.toContain('$schema');
    expect(json).not.toContain('additionalProperties');
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('$id');
    // Constraints survive as description hints, not keywords.
    expect(json).toContain('minLength: 2');
    // Structure survives.
    const properties = (cleaned['properties'] as Record<string, unknown>)['city'] as Record<string, unknown>;
    expect(properties['type']).toBe('string');
    expect(cleaned).toMatchObject({
      properties: { nested: { properties: { deep: { type: 'string', enum: ['resolved'] } } } },
    });
  });

  it('collapses anyOf to the most-structured alternative and folds const into enum', () => {
    const cleaned = cleanSchemaForCcaLegacyParameters({
      anyOf: [
        { type: 'string', enum: ['a', 'b'] },
        { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      ],
    }) as Record<string, unknown>;
    expect(cleaned['type']).toBe('object');
    expect(cleaned['properties']).toBeDefined();

    const asConst = cleanSchemaForCcaLegacyParameters({ const: 'fixed' }) as Record<string, unknown>;
    expect(asConst['enum']).toEqual(['fixed']);
    expect(asConst['type']).toBe('string');
  });

  it('preserves referenced tool arguments, nullable values and allOf sibling properties on the wire', async () => {
    const envelope = await toCcaEnvelope(anthropicBody({
      tools: [{
        name: 'lookup',
        input_schema: {
          type: 'object',
          $defs: { address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
          properties: {
            address: { $ref: '#/$defs/address' },
            note: { type: ['string', 'null'] },
            optionalCity: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['address'],
          allOf: [{
            type: 'object',
            properties: {
              unit: { const: 'c' },
              address: { type: 'object', properties: { zip: { type: 'string' } }, required: ['zip'] },
            },
          }, { required: ['unit'] }],
        },
      }],
    }));
    const tools = (envelope.request as Record<string, unknown>).tools as Array<{
      functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
    }>;
    expect(tools[0].functionDeclarations[0].parameters).toMatchObject({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: { city: { type: 'string' }, zip: { type: 'string' } },
          required: ['city', 'zip'],
        },
        note: { type: 'string', nullable: true },
        optionalCity: { type: 'string', nullable: true },
        unit: { type: 'string', enum: ['c'] },
      },
      required: ['address', 'unit'],
    });
  });

  it.each([
    { type: 'object', properties: { value: { $ref: '#/$defs/missing' } } },
    { $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } }, $ref: '#/$defs/node' },
  ])('rejects unresolved or recursive references instead of sending empty tool argument schemas', (schema) => {
    expect(() => cleanSchemaForCcaLegacyParameters(schema)).toThrow(/reference/);
  });
});

describe('multi-turn tool round trip (thinking + tool_use/tool_result + thoughtSignature replay)', () => {
  it('replays the thoughtSignature to the upstream and decodes thinking + tool_use blocks back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const transformer = new AntigravityTransformer();
    const firstResponse = await transformer.transformResponseOut(Response.json({
      response: {
        candidates: [{
          content: { role: 'model', parts: [
            { thought: true, text: 'I should check both cities.', thoughtSignature: 'sig-thought=' },
            { functionCall: { id: 'call-paris', name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-paris=' },
            { functionCall: { id: 'call-rome', name: 'get_weather', args: { city: 'Rome' } }, thoughtSignature: 'sig-rome=' },
          ] },
          finishReason: 'STOP',
        }],
      },
    }), ctx);
    const first = await firstResponse.json() as { choices: Array<{ message: UnifiedMessage }> };
    const assistant = first.choices[0].message;
    const calls = assistant.tool_calls!;
    expect(calls).toHaveLength(2);
    const encoded = await transformer.transformRequestIn({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'Check Paris and Rome.' },
        assistant,
        ...calls.map((call) => ({ role: 'tool' as const, tool_call_id: call.id, content: '18c, clear' })),
      ],
    }, antigravityProvider, ctx);
    const envelope = encoded.body as Record<string, unknown>;
    const inner = envelope.request as Record<string, unknown>;
    const contents = inner.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;

    // CCA-origin signatures stay attached to their original parts on replay.
    const modelTurn = contents.find((content) => content.role === 'model');
    expect(modelTurn).toBeDefined();
    const signatureParts = modelTurn?.parts.filter((part) => 'thoughtSignature' in part) ?? [];
    expect(signatureParts.map((part) => part.thoughtSignature)).toEqual(['sig-thought=', 'sig-paris=', 'sig-rome=']);

    // The tool_result lands as a functionResponse part paired to the call.
    const responseParts = contents
      .filter((content) => content.role === 'user')
      .flatMap((content) => content.parts)
      .filter((part) => 'functionResponse' in part);
    expect(responseParts).toHaveLength(2);
    expect(responseParts.map((part) => (part.functionResponse as Record<string, unknown>).name))
      .toEqual(['get_weather', 'get_weather']);

    // ── Response direction: CCA SSE → OpenAI-compatible → Anthropic wire ──
    const ccaSse = [
      'data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me check.', thought: true, thoughtSignature: 'sig-resp1=' }] } }] } }),
      '',
      'data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] } }] } }),
      '',
      'data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'It is 18c.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }),
      '',
    ].join('\n');

    const ccaResponse = new Response(ccaSse, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const openaiCompatible = await new AntigravityTransformer().transformResponseOut(ccaResponse, ctx);
    expect(openaiCompatible.headers.get('Content-Type')).toContain('text/event-stream');
    const openaiText = await openaiCompatible.text();
    // The `.response` envelope is PEELED (no nested response key in chunks).
    expect(openaiText).not.toContain('"response"');
    // Reasoning + tool call deltas survive the shared gemini parser.
    expect(openaiText).toContain('get_weather');
    expect(openaiText).toContain('Let me check.');

    // Re-encode to the anthropic wire (the client-facing direction).
    const anthropicBack = await new AnthropicTransformer().transformResponseIn(
      new Response(openaiText, { headers: { 'Content-Type': 'text/event-stream' } }),
      ctx,
    );
    const anthropicText = await anthropicBack.text();
    expect(anthropicText).toContain('tool_use');
    expect(anthropicText).toContain('get_weather');
  });
});

describe('gpt-oss family decoration (task 4.2)', () => {
  it('shares the Gemini shape: VALIDATED default, model_enum label from the wire profile, medium wire id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unified = await new AnthropicTransformer().transformRequestOut(
      anthropicBody({ model: 'gpt-oss-120b', thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }),
      ctx,
    );
    const out = await new AntigravityTransformer().transformRequestIn(
      unified,
      { ...antigravityProvider, models: ['gpt-oss-120b'] },
      ctx,
    );
    const envelope = (out as { body: Record<string, unknown> }).body;
    expect(envelope.model).toBe('gpt-oss-120b-medium');
    const inner = envelope.request as Record<string, unknown>;
    const labels = inner.labels as Record<string, string>;
    // gpt-oss has no model_enum token in the wire profiles — no label (the
    // counter-family difference lives in QUOTA, not the envelope).
    expect(labels.used_claude).toBe('false');
    const toolConfig = inner.toolConfig as { functionCallingConfig: { mode: string } } | undefined;
    expect(toolConfig?.functionCallingConfig.mode).toBe('VALIDATED');
    // The standard (non-legacy) tool schema form — parametersJsonSchema kept.
    const tools = inner.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    expect(tools[0]?.functionDeclarations[0]?.parametersJsonSchema).toBeDefined();
  });
});
