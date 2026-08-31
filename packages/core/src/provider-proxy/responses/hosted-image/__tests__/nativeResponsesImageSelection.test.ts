import { describe, expect, it } from 'vitest';

import {
  inspectResponsesImageRequest,
  validateResponsesImageSelection,
} from '../../../../image-generation/responses';
import { ImageGenerationError } from '../../../../image-generation/errors';
import {
  hasImageOwnedResponsesInput,
  prepareNativeResponsesImageSelection,
} from '../nativeResponsesImageSelection';

describe('Native Responses image selection adapter', () => {
  it('does not infer image ownership from ordinary natural-language input', () => {
    expect(hasImageOwnedResponsesInput({ input: 'Draw a watercolor fox.' })).toBe(false);
  });

  it.each([
    { tools: [{ type: 'image_generation' }] },
    { tool_choice: { type: 'image_generation' } },
    { input: [{ type: 'image_generation_call', id: 'ig_aaaaaaaaaaaaaaaa' }] },
  ])('recognizes only explicit image-owned request shapes', (body) => {
    expect(hasImageOwnedResponsesInput(body)).toBe(true);
  });

  it('replaces only the image declaration on an upstream clone and maps forced choice', () => {
    const imageCallId = 'ig_aaaaaaaaaaaaaaaa';
    const body = {
      input: [
        { role: 'user', content: 'make it warmer' },
        { type: 'image_generation_call', id: imageCallId },
      ],
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'image_generation', size: '1024x1024', action: 'edit' },
        { type: 'custom', name: 'shell', format: { type: 'text' } },
      ],
      tool_choice: { type: 'image_generation' },
      metadata: { caller: 'kept' },
    };
    const admission = inspectResponsesImageRequest(body);

    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission,
      createSelectorName: () => '__omnicross_image_private_1',
    });

    expect(prepared.selectorName).toBe('__omnicross_image_private_1');
    expect(prepared.upstreamBody).toEqual({
      input: [{ role: 'user', content: 'make it warmer' }],
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        {
          type: 'function',
          name: '__omnicross_image_private_1',
          description: 'Select image generation or editing and provide its image prompt.',
          strict: true,
          parameters: {
            type: 'object',
            properties: { prompt: { type: 'string', minLength: 1, maxLength: 32_000 } },
            required: ['prompt'],
            additionalProperties: false,
          },
        },
        { type: 'custom', name: 'shell', format: { type: 'text' } },
      ],
      tool_choice: { type: 'function', name: '__omnicross_image_private_1' },
      metadata: { caller: 'kept' },
    });
    expect(body.tools[1]).toEqual({
      type: 'image_generation', size: '1024x1024', action: 'edit',
    });
    expect(body.input).toHaveLength(2);
  });

  it('prepends authorized completion receipts and removes local image references', () => {
    const body = {
      input: [
        { type: 'image_generation_call', id: 'ig_bbbbbbbbbbbbbbbb' },
        { role: 'user', content: 'turn this into a poster' },
      ],
    };
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      pendingReceipts: [{
        upstreamCallId: 'call_upstream_1',
        publicImageCallId: 'ig_aaaaaaaaaaaaaaaa',
      }],
    });

    expect(prepared.selectorName).toBeUndefined();
    expect(prepared.upstreamBody).not.toHaveProperty('tools');
    expect(prepared.upstreamBody.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_upstream_1',
        output: '{"status":"completed","image_generation_call_id":"ig_aaaaaaaaaaaaaaaa"}',
      },
      { role: 'user', content: 'turn this into a poster' },
    ]);
    expect(JSON.stringify(prepared.upstreamBody)).not.toContain('ig_bbbbbbbbbbbbbbbb');
  });

  it('parses only real internal function calls and maps other calls to declarations', () => {
    const body = {
      input: 'compose an illustrated answer',
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'image_generation', quality: 'high' },
        { type: 'custom', name: 'shell', format: { type: 'text' } },
      ],
      tool_choice: 'required',
    };
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => '__omnicross_image_private_2',
    });

    const result = prepared.parseOutput([
      { id: 'rs_1', type: 'reasoning', summary: [] },
      {
        id: 'fc_image_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_image_1',
        name: '__omnicross_image_private_2',
        arguments: '{"prompt":"A warm watercolor fox"}',
      },
      {
        id: 'fc_lookup_1', type: 'function_call', status: 'completed',
        call_id: 'call_lookup_1', name: 'lookup', arguments: '{"topic":"foxes"}',
      },
      {
        id: 'ct_shell_1', type: 'custom_tool_call', status: 'completed',
        call_id: 'call_shell_1', name: 'shell', input: 'echo done',
      },
    ]);

    expect(result).toEqual({
      selection: {
        imageCalls: [{ prompt: 'A warm watercolor fox' }],
        otherToolCount: 2,
        otherTools: [
          { declarationIndex: 0, type: 'function', name: 'lookup' },
          { declarationIndex: 2, type: 'custom', name: 'shell' },
        ],
      },
      imageCalls: [{
        call: { prompt: 'A warm watercolor fox' },
        presentationIndex: 1,
        upstreamCallId: 'call_image_1',
        itemIndex: 1,
      }],
      internalItemIds: ['fc_image_1'],
    });
  });

  it('retries selector names that collide with caller-declared tools', () => {
    const body = {
      input: 'draw',
      tools: [
        { type: 'function', name: '__omnicross_image_collision', parameters: {} },
        { type: 'image_generation' },
      ],
    };
    const names = ['__omnicross_image_collision', '__omnicross_image_unique'];
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => names.shift()!,
    });

    expect(prepared.selectorName).toBe('__omnicross_image_unique');
    expect((prepared.upstreamBody.tools as Array<Record<string, unknown>>)[1]?.name)
      .toBe('__omnicross_image_unique');
  });

  it('rejects duplicate selector identities without exposing private wire', () => {
    const body = { input: 'draw', tools: [{ type: 'image_generation' }] };
    const selectorName = '__omnicross_image_private_sentinel';
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => selectorName,
    });
    const parse = () => prepared.parseOutput([
      {
        id: 'fc_first', type: 'function_call', status: 'completed',
        call_id: 'call_duplicate', name: selectorName,
        arguments: '{"prompt":"PRIVATE_PROMPT_SENTINEL_ONE"}',
      },
      {
        id: 'fc_second', type: 'function_call', status: 'completed',
        call_id: 'call_duplicate', name: selectorName,
        arguments: '{"prompt":"PRIVATE_PROMPT_SENTINEL_TWO"}',
      },
    ]);

    let caught: unknown;
    try {
      parse();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImageGenerationError);
    expect((caught as ImageGenerationError).code).toBe('upstream_protocol_changed');
    expect((caught as Error).message).not.toContain('PRIVATE_PROMPT_SENTINEL');
    expect((caught as Error).message).not.toContain(selectorName);
  });

  it('fails closed on unknown selector item fields', () => {
    const body = { input: 'draw', tools: [{ type: 'image_generation' }] };
    const selectorName = '__omnicross_image_private_3';
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => selectorName,
    });

    expect(() => prepared.parseOutput([{
      id: 'fc_image_3', type: 'function_call', status: 'completed',
      call_id: 'call_image_3', name: selectorName,
      arguments: '{"prompt":"safe"}', unexpected: 'PRIVATE_FIELD_SENTINEL',
    }])).toThrowError(ImageGenerationError);
  });

  it('rejects duplicate pending receipt identities before building upstream input', () => {
    const body = { input: [{ role: 'user', content: 'continue' }] };
    expect(() => prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      pendingReceipts: [
        { upstreamCallId: 'call_same', publicImageCallId: 'ig_aaaaaaaaaaaaaaaa' },
        { upstreamCallId: 'call_same', publicImageCallId: 'ig_bbbbbbbbbbbbbbbb' },
      ],
    })).toThrowError(ImageGenerationError);
  });

  it('shares the affinity receipt bound of sixteen entries', () => {
    const body = { input: 'continue' };
    expect(() => prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      pendingReceipts: Array.from({ length: 17 }, (_, index) => ({
        upstreamCallId: `call_pending_${index}`,
        publicImageCallId: `ig_${String(index).padStart(16, '0')}`,
      })),
    })).toThrowError(ImageGenerationError);
  });

  it('preserves string input when a pending receipt requires list form', () => {
    const body = { input: 'continue from the generated image' };
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      pendingReceipts: [{
        upstreamCallId: 'call_pending_string',
        publicImageCallId: 'ig_cccccccccccccccc',
      }],
    });

    expect(prepared.upstreamBody.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_pending_string',
        output: '{"status":"completed","image_generation_call_id":"ig_cccccccccccccccc"}',
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'continue from the generated image' }],
      },
    ]);
  });

  it('redacts selector-name generator failures', () => {
    const body = { input: 'draw', tools: [{ type: 'image_generation' }] };
    let caught: unknown;
    try {
      prepareNativeResponsesImageSelection({
        body,
        admission: inspectResponsesImageRequest(body),
        createSelectorName: () => {
          throw new Error('PRIVATE_SELECTOR_GENERATOR_SENTINEL');
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ImageGenerationError);
    expect((caught as ImageGenerationError).code).toBe('image_generation_failed');
    expect((caught as Error).message).not.toContain('PRIVATE_SELECTOR_GENERATOR_SENTINEL');
  });

  it('maps a selected non-image hosted call back to its declared identity', () => {
    const body = {
      input: 'find a visual reference',
      tools: [
        { type: 'image_generation' },
        { type: 'web_search_preview' },
      ],
      tool_choice: 'required',
    };
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => '__omnicross_image_private_4',
    });

    expect(prepared.parseOutput([{
      id: 'ws_1', type: 'web_search_call', status: 'completed',
      action: { type: 'search', query: 'visual reference' },
    }]).selection).toEqual({
      imageCalls: [],
      otherToolCount: 1,
      otherTools: [{ declarationIndex: 1, type: 'web_search_preview' }],
    });
  });

  it.each([
    ['auto', 'auto'],
    ['required', 'required'],
    ['none', 'none'],
  ])('preserves primitive tool_choice %s', (toolChoice, expected) => {
    const body = {
      input: 'decide',
      tools: [{ type: 'image_generation' }],
      tool_choice: toolChoice,
    };
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => '__omnicross_image_choice',
    });
    expect(prepared.upstreamBody.tool_choice).toBe(expected);
  });

  it('preserves a forced non-image tool choice', () => {
    const body = {
      input: 'look it up',
      tools: [
        { type: 'image_generation' },
        { type: 'function', name: 'lookup', parameters: {} },
      ],
      tool_choice: { type: 'function', name: 'lookup' },
    };
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => '__omnicross_image_choice_other',
    });
    expect(prepared.upstreamBody.tool_choice).toEqual({ type: 'function', name: 'lookup' });
  });

  it.each([
    ['invalid JSON', '{'],
    ['unknown argument', '{"prompt":"safe","secret":"no"}'],
    ['empty prompt', '{"prompt":"   "}'],
    ['oversized prompt', JSON.stringify({ prompt: 'x'.repeat(32_001) })],
  ])('rejects %s in selector arguments', (_label, args) => {
    const body = { input: 'draw', tools: [{ type: 'image_generation' }] };
    const selectorName = '__omnicross_image_argument_bounds';
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => selectorName,
    });
    expect(() => prepared.parseOutput([{
      id: 'fc_bounded', type: 'function_call', status: 'completed',
      call_id: 'call_bounded', name: selectorName, arguments: args,
    }])).toThrowError(ImageGenerationError);
  });

  it('bounds the non-stream output walk', () => {
    const body = { input: 'draw', tools: [{ type: 'image_generation' }] };
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => '__omnicross_image_output_bounds',
    });
    expect(() => prepared.parseOutput(Array.from(
      { length: 1_025 },
      (_, index) => ({ id: `rs_${index}`, type: 'reasoning', summary: [] }),
    ))).toThrowError(ImageGenerationError);
  });

  it('bounds selector arguments by UTF-8 bytes rather than UTF-16 code units', () => {
    const body = { input: 'draw', tools: [{ type: 'image_generation' }] };
    const selectorName = '__omnicross_image_utf8_bounds';
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission: inspectResponsesImageRequest(body),
      createSelectorName: () => selectorName,
    });
    expect(() => prepared.parseOutput([{
      id: 'fc_utf8', type: 'function_call', status: 'completed',
      call_id: 'call_utf8', name: selectorName,
      arguments: JSON.stringify({ prompt: '图'.repeat(22_000) }),
    }])).toThrowError(ImageGenerationError);
  });

  it.each([
    ['auto', 'auto'],
    ['required', 'required'],
    ['forced', { type: 'function', name: 'lookup' }],
  ] as const)('accepts distinct repeated calls to one declaration under %s selection', (_label, toolChoice) => {
    const body = {
      input: 'lookup twice',
      tools: [
        { type: 'image_generation' },
        { type: 'function', name: 'lookup', parameters: {} },
      ],
      tool_choice: toolChoice,
    };
    const admission = inspectResponsesImageRequest(body);
    const prepared = prepareNativeResponsesImageSelection({
      body,
      admission,
      createSelectorName: () => '__omnicross_image_other_duplicate',
    });
    const result = prepared.parseOutput([
      {
        id: 'fc_lookup_a', type: 'function_call', status: 'completed',
        call_id: 'call_lookup_a', name: 'lookup', arguments: '{}',
      },
      {
        id: 'fc_lookup_b', type: 'function_call', status: 'completed',
        call_id: 'call_lookup_b', name: 'lookup', arguments: '{}',
      },
    ]);
    expect(result.selection).toEqual({
      imageCalls: [],
      otherToolCount: 2,
      otherTools: [
        { declarationIndex: 1, type: 'function', name: 'lookup' },
        { declarationIndex: 1, type: 'function', name: 'lookup' },
      ],
    });
    expect(() => validateResponsesImageSelection(admission, result.selection)).not.toThrow();
  });
});
