import { describe, expect, it } from 'vitest';

import { injectMappingEffortDefault } from '../mappingEffortInjection';

describe('injectMappingEffortDefault', () => {
  it('stamps the chat wire effort only when the request carries no reasoning intent', () => {
    const body: Record<string, unknown> = { model: 'gpt-5.6-sol-xhigh', messages: [] };
    expect(injectMappingEffortDefault('chat', 'xhigh', body)).toBe(true);
    expect(body['reasoning_effort']).toBe('xhigh');

    const nativeClient: Record<string, unknown> = { reasoning_effort: 'low' };
    expect(injectMappingEffortDefault('chat', 'xhigh', nativeClient)).toBe(false);
    expect(nativeClient['reasoning_effort']).toBe('low');

    const unifiedClient: Record<string, unknown> = { reasoning: { effort: 'medium' } };
    expect(injectMappingEffortDefault('chat', 'xhigh', unifiedClient)).toBe(false);
  });

  it('adds the responses wire effort beside sibling reasoning keys', () => {
    const body: Record<string, unknown> = { reasoning: { summary: 'auto' } };
    expect(injectMappingEffortDefault('responses', 'high', body)).toBe(true);
    expect(body['reasoning']).toEqual({ summary: 'auto', effort: 'high' });

    const bare: Record<string, unknown> = {};
    expect(injectMappingEffortDefault('responses', 'high', bare)).toBe(true);
    expect(bare['reasoning']).toEqual({ effort: 'high' });

    const clientWins: Record<string, unknown> = { reasoning: { effort: 'minimal' } };
    expect(injectMappingEffortDefault('responses', 'high', clientWins)).toBe(false);
  });

  it('encodes the anthropic wire as adaptive thinking plus output_config effort', () => {
    const body: Record<string, unknown> = { model: 'claude-xhigh', max_tokens: 8192 };
    expect(injectMappingEffortDefault('messages', 'xhigh', body)).toBe(true);
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['output_config']).toEqual({ effort: 'xhigh' });
    expect(body['max_tokens']).toBe(8192);

    const clientBudget: Record<string, unknown> = { thinking: { type: 'enabled', budget_tokens: 2048 } };
    expect(injectMappingEffortDefault('messages', 'xhigh', clientBudget)).toBe(false);
    expect(clientBudget['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });

    // 'none' on the Anthropic wire is an absent `thinking` — nothing to write.
    const noneBody: Record<string, unknown> = {};
    expect(injectMappingEffortDefault('messages', 'none', noneBody)).toBe(false);
    expect(noneBody).toEqual({});
  });

  it('nests the gemini wire thinking level under generationConfig', () => {
    const body: Record<string, unknown> = { generationConfig: { temperature: 0.2 } };
    expect(injectMappingEffortDefault('gemini', 'high', body)).toBe(true);
    expect(body['generationConfig']).toEqual({
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: 'high' },
    });

    const fresh: Record<string, unknown> = {};
    expect(injectMappingEffortDefault('gemini', 'none', fresh)).toBe(true);
    expect(fresh['generationConfig']).toEqual({ thinkingConfig: { thinkingLevel: 'none' } });

    const clientBudget: Record<string, unknown> = {
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    };
    expect(injectMappingEffortDefault('gemini', 'high', clientBudget)).toBe(false);
  });

  it('never touches the body without a configured effort', () => {
    for (const endpoint of ['chat', 'responses', 'messages', 'gemini'] as const) {
      const body: Record<string, unknown> = { model: 'm' };
      expect(injectMappingEffortDefault(endpoint, undefined, body)).toBe(false);
      expect(body).toEqual({ model: 'm' });
    }
  });
});
