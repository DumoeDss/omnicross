import { afterEach, describe, expect, it } from 'vitest';

import {
  downgradeJsonSchemaBody,
  isJsonObjectOnlyProvider,
  isJsonSchemaUnsupported,
  isResponseFormatRejection,
  markJsonSchemaUnsupported,
  resetStructuredOutputStateForTests,
} from '../structuredOutput';

afterEach(() => resetStructuredOutputStateForTests());

const schema = { type: 'object', properties: { step: { type: 'string' } }, required: ['step'] };

describe('downgradeJsonSchemaBody', () => {
  it('rewrites json_schema to json_object and prepends the schema instruction', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content: 'base prompt' }, { role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'codex_output_schema', strict: true, schema },
      },
    };

    expect(downgradeJsonSchemaBody(body)).toBe(true);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('system');
    expect(String(messages[0]?.content)).toContain('JSON Schema');
    expect(String(messages[0]?.content)).toContain('codex_output_schema');
    expect(String(messages[0]?.content)).toContain('"step"');
    expect(messages[1]).toEqual({ role: 'system', content: 'base prompt' });
  });

  it('is idempotent — a json_object format is never rewritten or re-instructed', () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    };
    expect(downgradeJsonSchemaBody(body)).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('handles a schema-less json_schema and an instructions-only body', () => {
    const instructionsBody: Record<string, unknown> = {
      instructions: 'base',
      response_format: { type: 'json_schema', json_schema: {} },
    };
    expect(downgradeJsonSchemaBody(instructionsBody)).toBe(true);
    expect(String(instructionsBody.instructions)).toContain('JSON');
  });
});

describe('isJsonObjectOnlyProvider', () => {
  it('detects DeepSeek by name or base URL', () => {
    expect(isJsonObjectOnlyProvider({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(isJsonObjectOnlyProvider({ name: 'My relay', baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(isJsonObjectOnlyProvider({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(isJsonObjectOnlyProvider(undefined)).toBe(false);
  });
});

describe('isResponseFormatRejection', () => {
  it("matches DeepSeek's measured 400 body", () => {
    const body = JSON.stringify({
      error: {
        message: 'This response_format type is unavailable now (request_id: x)',
        type: 'invalid_request_error',
      },
    });
    expect(isResponseFormatRejection(400, body)).toBe(true);
  });

  it('does not fire on unrelated 400s or other statuses', () => {
    expect(isResponseFormatRejection(400, '{"error":{"message":"invalid api key"}}')).toBe(false);
    expect(isResponseFormatRejection(422, 'response_format unsupported')).toBe(false);
    expect(isResponseFormatRejection(429, 'rate limit')).toBe(false);
  });
});

describe('unsupported registry', () => {
  it('remembers a provider+model key', () => {
    expect(isJsonSchemaUnsupported('byo:deepseek|deepseek-flash')).toBe(false);
    markJsonSchemaUnsupported('byo:deepseek|deepseek-flash');
    expect(isJsonSchemaUnsupported('byo:deepseek|deepseek-flash')).toBe(true);
  });
});
