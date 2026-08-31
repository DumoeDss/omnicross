import { describe, expect, it, vi } from 'vitest';

import { ImageGenerationError } from '../../errors';
import {
  inspectResponsesImageRequest,
  validateResponsesImageSelection,
} from '../normalizeResponsesImageTool';

const callA = 'ig_aaaaaaaaaaaaaaaa' as const;
const callB = 'ig_bbbbbbbbbbbbbbbb' as const;

describe('Responses image tool inspection', () => {
  it('inspects only image-owned fields and preserves mixed-tool indexes and reference order', () => {
    const functionTool = { type: 'function', name: 'lookup', secret: 'untouched' };
    const customTool = { type: 'custom', name: 'other' };
    const input = {
      tools: [functionTool, {
        type: 'image_generation',
        action: 'edit',
        quality: 'high',
        size: '1024x1024',
        output_format: 'webp',
        output_compression: 80,
        background: 'transparent',
        partial_images: 2,
      }, customTool],
      tool_choice: 'auto',
      stream: true,
      previous_response_id: 'resp_previous',
      input: [
        { type: 'message', role: 'user', content: 'untouched' },
        { type: 'image_generation_call', id: callB },
        { type: 'image_generation_call', id: callA },
      ],
    };
    const admission = inspectResponsesImageRequest(input);
    expect(admission).toMatchObject({
      declared: true,
      imageToolIndex: 1,
      otherToolCount: 2,
      otherTools: [
        { declarationIndex: 0, type: 'function', name: 'lookup' },
        { declarationIndex: 2, type: 'custom', name: 'other' },
      ],
      stream: true,
      previousResponseId: 'resp_previous',
      explicitCallIds: [callB, callA],
      selectionPolicy: { kind: 'auto' },
      options: {
        action: 'edit',
        quality: 'high',
        size: { kind: 'pixels', width: 1024, height: 1024 },
        outputFormat: 'webp',
        outputCompression: 80,
        background: 'transparent',
        partialImages: 2,
      },
    });
    expect(input.tools[0]).toBe(functionTool);
    expect(input.tools[2]).toBe(customTool);
  });

  it.each([
    [{ tools: [{ type: 'image_generation' }, { type: 'image_generation' }] }, 'tools'],
    [{ tools: [{ type: 'image_generation', unknown: true }] }, 'tools.unknown'],
    [{ tools: [{ type: 'image_generation', action: 'transform' }] }, 'tools.action'],
    [{ tools: [{ type: 'image_generation', background: 'transparent', output_format: 'jpeg' }] }, 'background'],
    [{ tools: [{ type: 'image_generation', output_format: 'png', output_compression: 70 }] }, 'output_compression'],
    [{ tools: [{ type: 'image_generation', partial_images: 1 }], stream: false }, 'partial_images'],
    [{ tools: [], tool_choice: { type: 'image_generation' } }, 'tool_choice'],
    [{ tools: [{ type: 'image_generation' }], tool_choice: { type: 'function', name: 'missing' } }, 'tool_choice'],
    [{ tools: [], previous_response_id: 'bad-response-id' }, 'previous_response_id'],
    [{ tools: [], input: [{ type: 'image_generation_call', id: 'ig_short' }] }, 'input'],
  ])('rejects invalid declaration/input before any provider can be acquired', (value, param) => {
    const acquire = vi.fn();
    expect(() => inspectResponsesImageRequest(value)).toThrowError(
      expect.objectContaining({ code: 'invalid_image_request', param }),
    );
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('Responses image selection policy', () => {
  const image = () => inspectResponsesImageRequest({ tools: [{ type: 'image_generation' }] });
  const noneSelected = { imageCalls: [], otherToolCount: 0, otherTools: [] } as const;

  it('allows auto no-selection and generic required satisfied by another tool', () => {
    expect(() => validateResponsesImageSelection(image(), noneSelected))
      .not.toThrow();
    const required = inspectResponsesImageRequest({
      tools: [{ type: 'image_generation' }, { type: 'function', name: 'lookup' }],
      tool_choice: 'required',
    });
    expect(() => validateResponsesImageSelection(required, {
      imageCalls: [],
      otherToolCount: 1,
      otherTools: [{ declarationIndex: 1, type: 'function', name: 'lookup' }],
    }))
      .not.toThrow();
  });

  it('accepts a valid mixed auto plan using exact declared identities', () => {
    const mixed = inspectResponsesImageRequest({
      tools: [
        { type: 'function', name: 'lookup' },
        { type: 'image_generation' },
        { type: 'custom', name: 'render' },
      ],
    });
    expect(() => validateResponsesImageSelection(mixed, {
      imageCalls: [{ prompt: 'draw it' }],
      otherToolCount: 2,
      otherTools: [
        { declarationIndex: 0, type: 'function', name: 'lookup' },
        { declarationIndex: 2, type: 'custom', name: 'render' },
      ],
    })).not.toThrow();
  });

  it('accepts one or many forced image calls with bounded prompts', () => {
    const forced = inspectResponsesImageRequest({
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
    });
    expect(() => validateResponsesImageSelection(forced, {
      imageCalls: [{ prompt: 'one' }, { prompt: 'two' }],
      otherToolCount: 0,
      otherTools: [],
    })).not.toThrow();
  });

  it('requires every forced non-image call to match the declared index, type, and name exactly', () => {
    const forced = inspectResponsesImageRequest({
      tools: [
        { type: 'image_generation' },
        { type: 'function', name: 'lookup' },
        { type: 'function', name: 'other' },
      ],
      tool_choice: { type: 'function', name: 'lookup' },
    });
    expect(() => validateResponsesImageSelection(forced, {
      imageCalls: [],
      otherToolCount: 2,
      otherTools: [
        { declarationIndex: 1, type: 'function', name: 'lookup' },
        { declarationIndex: 1, type: 'function', name: 'lookup' },
      ],
    })).not.toThrow();
    for (const identity of [
      { declarationIndex: 2, type: 'function', name: 'other' },
      { declarationIndex: 1, type: 'custom', name: 'lookup' },
      { declarationIndex: 1, type: 'function', name: 'wrong' },
    ]) {
      expect(() => validateResponsesImageSelection(forced, {
        imageCalls: [],
        otherToolCount: 2,
        otherTools: [
          { declarationIndex: 1, type: 'function', name: 'lookup' },
          identity,
        ],
      })).toThrowError(expect.objectContaining({ code: 'upstream_protocol_changed' }));
    }
    expect(() => validateResponsesImageSelection(forced, {
      imageCalls: [],
      otherToolCount: 0,
      otherTools: [],
    })).toThrowError(expect.objectContaining({ code: 'upstream_protocol_changed' }));
  });

  it.each(['auto', 'required'] as const)(
    'accepts repeated calls to one declared non-image tool under %s selection',
    (toolChoice) => {
      const admission = inspectResponsesImageRequest({
        tools: [{ type: 'image_generation' }, { type: 'function', name: 'lookup' }],
        tool_choice: toolChoice,
      });
      expect(() => validateResponsesImageSelection(admission, {
        imageCalls: [],
        otherToolCount: 2,
        otherTools: [
          { declarationIndex: 1, type: 'function', name: 'lookup' },
          { declarationIndex: 1, type: 'function', name: 'lookup' },
        ],
      })).not.toThrow();
    },
  );

  it('rejects undeclared, count-mismatched, and independently over-bounded selections', () => {
    const required = inspectResponsesImageRequest({
      tools: [{ type: 'image_generation' }, { type: 'function', name: 'lookup' }],
      tool_choice: 'required',
    });
    const declared = { declarationIndex: 1, type: 'function', name: 'lookup' } as const;
    const invalidPlans = [
      { imageCalls: [], otherToolCount: 1, otherTools: [{ declarationIndex: 9, type: 'function', name: 'lookup' }] },
      { imageCalls: [], otherToolCount: 2, otherTools: [declared] },
      { imageCalls: [], otherToolCount: 1, otherTools: [
        { declarationIndex: 1, type: 'function', name: 'lookup' },
        { declarationIndex: 1, type: 'function', name: 'lookup' },
      ] },
    ];
    for (const plan of invalidPlans) {
      expect(() => validateResponsesImageSelection(required, plan))
        .toThrowError(expect.objectContaining({ code: 'upstream_protocol_changed' }));
    }
    expect(() => validateResponsesImageSelection(required, {
      imageCalls: [],
      otherToolCount: 1_025,
      otherTools: Array.from({ length: 1_025 }, () => declared),
    })).toThrowError(expect.objectContaining({ code: 'upstream_protocol_changed' }));
  });

  it.each([
    [
      inspectResponsesImageRequest({ tools: [{ type: 'image_generation' }], tool_choice: 'required' }),
      noneSelected,
    ],
    [
      inspectResponsesImageRequest({
        tools: [{ type: 'image_generation' }],
        tool_choice: { type: 'image_generation' },
      }),
      noneSelected,
    ],
    [
      inspectResponsesImageRequest({
        tools: [{ type: 'image_generation' }, { type: 'function', name: 'lookup' }],
        tool_choice: { type: 'function', name: 'lookup' },
      }),
      {
        imageCalls: [{ prompt: 'not allowed' }],
        otherToolCount: 1,
        otherTools: [{ declarationIndex: 1, type: 'function', name: 'lookup' }],
      },
    ],
    [inspectResponsesImageRequest({ tools: [] }), {
      imageCalls: [{ prompt: 'undeclared' }], otherToolCount: 0, otherTools: [],
    }],
    [image(), { imageCalls: [{ prompt: '' }], otherToolCount: 0, otherTools: [] }],
  ])('turns a selected-plan contract violation into a stable protocol failure', (admission, selection) => {
    expect(() => validateResponsesImageSelection(admission, selection)).toThrowError(
      expect.objectContaining({ code: 'upstream_protocol_changed' }),
    );
  });

  it('uses ImageGenerationError rather than raw model-plan causes', () => {
    try {
      validateResponsesImageSelection(image(), null as never);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ImageGenerationError);
      expect(JSON.stringify(error)).not.toContain('expected failure');
    }
  });
});
