/**
 * Prompt compiler tests: envelope structure, image budgeting, model-switch
 * contract pruning, and compaction trimming.
 *
 * @module @omnicross/chatgpt-web/bridge/__tests__/prompt.test
 */

import { describe, expect, it } from 'vitest';

import { CHATGPT_WEB_MODEL_ROUTES } from '../bridge/models';
import { compileChatGptWebPrompt } from '../bridge/prompt';
import { parseRequest } from '../bridge/parser';
import type { CodexParsedRequest } from '../bridge/types';

const PRO_ROUTE = CHATGPT_WEB_MODEL_ROUTES.find((route) => route.slug === 'chatgpt-web/pro')!;

function requestWith(input: unknown[], extra: Record<string, unknown> = {}): CodexParsedRequest {
  return parseRequest({ model: 'chatgpt-web/pro', stream: true, input, ...extra });
}

describe('compileChatGptWebPrompt', () => {
  it('wraps the full context as one JSON envelope inside XML tags', () => {
    const parsed = requestWith([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    const compiled = compileChatGptWebPrompt(parsed, PRO_ROUTE);
    expect(compiled.text).toContain('<codex_context_json>');
    expect(compiled.text).toContain('</codex_context_json>');
    const envelope = JSON.parse(
      compiled.text.slice(compiled.text.indexOf('<codex_context_json>') + 20, compiled.text.lastIndexOf('</codex_context_json>')),
    );
    expect(envelope.version).toBe(3);
    expect(envelope.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(compiled.images).toHaveLength(0);
  });

  it('keeps images out of the JSON as attachment references', () => {
    const parsed = requestWith([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'see' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        ],
      },
    ]);
    const compiled = compileChatGptWebPrompt(parsed, PRO_ROUTE);
    expect(compiled.images).toHaveLength(1);
    expect(compiled.images[0]).toMatchObject({ ref: 'codex-input-image-1' });
    expect(compiled.text).not.toContain('iVBORw0KGgo=');
    expect(compiled.text).toContain('"attachment_ref":"codex-input-image-1"');
  });

  it('drops the oldest images beyond the ten-attachment limit', () => {
    const input = Array.from({ length: 12 }, (_, index) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: `data:image/png;base64,IMG${index}` }],
    }));
    const parsed = requestWith(input);
    const compiled = compileChatGptWebPrompt(parsed, PRO_ROUTE);
    expect(compiled.images).toHaveLength(10);
    expect(compiled.images[0]?.ref).toBe('codex-input-image-1');
    expect(compiled.text).toContain('older image not attached');
  });

  it('drops superseded model-switch contracts but keeps the newest', () => {
    const parsed = requestWith([
      { type: 'message', role: 'user', content: 'task' },
      { type: 'message', role: 'developer', content: '<model_switch>v1</model_switch>' },
      { type: 'message', role: 'developer', content: '<skills_instructions>old</skills_instructions>' },
      { type: 'message', role: 'developer', content: '<model_switch>v2</model_switch>' },
    ]);
    const compiled = compileChatGptWebPrompt(parsed, PRO_ROUTE);
    expect(compiled.text).toContain('<model_switch>v2');
    expect(compiled.text).not.toContain('<model_switch>v1');
    expect(compiled.text).not.toContain('old');
  });

  it('trims oldest history on compaction overflow and reports the count', () => {
    const bigText = 'x'.repeat(40_000);
    const input = Array.from({ length: 5 }, (_, index) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `${index}:${bigText}` }],
    }));
    input.push({ type: 'compaction_trigger' });
    const parsed = requestWith(input);
    const compiled = compileChatGptWebPrompt(parsed, PRO_ROUTE);
    expect(compiled.trimmedCompactionMessages).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(compiled.text), 'utf8')).toBeLessThanOrEqual(110_000);
  });

  it('adds the JSON-schema output contract when requested', () => {
    const parsed = parseRequest({
      model: 'chatgpt-web/pro',
      input: [{ type: 'message', role: 'user', content: 'extract' }],
      text: { format: { type: 'json_schema', name: 'result', strict: true, schema: { type: 'object' } } },
    });
    const compiled = compileChatGptWebPrompt(parsed, PRO_ROUTE);
    expect(compiled.text).toContain('<codex_output_schema_json>');
    expect(compiled.text).toContain('named "result"');
    expect(compiled.text).toContain('strict JSON-schema');
  });
});
