import { describe, it } from 'vitest';
import { MATRIX_FORMATS, runConversionMatrixCase } from './conversionMatrixFixtures';

describe('ProviderProxy protocol conversion round trips', () => {
  for (const ingress of MATRIX_FORMATS) {
    for (const target of MATRIX_FORMATS) {
      for (const stream of [false, true]) {
        it(`${ingress} → ${target}, ${stream ? 'SSE' : 'JSON'}: thinking and two same-name tool calls survive the next turn`, async () => {
          await runConversionMatrixCase(ingress, target, stream);
        });
      }
    }
  }
});

describe('retired DeepSeek wire redirects', () => {
  for (const [ingress, model] of [
    ['chat', 'deepseek-chat'],
    ['anthropic', 'deepseek-reasoner'],
    ['responses', 'deepseek-chat'],
    ['gemini', 'deepseek-reasoner'],
  ] as const) {
    it(`${ingress} sends flash and replays reasoning plus both tool calls`, async () => {
      await runConversionMatrixCase(ingress, 'chat', true, { model, wireModel: 'deepseek-flash' });
    });
  }
  for (const [target, model] of [
    ['anthropic', 'deepseek-chat'],
    ['responses', 'deepseek-reasoner'],
    ['gemini', 'deepseek-chat'],
  ] as const) {
    it(`${target} same-format path redirects the model without losing tool replay`, async () => {
      await runConversionMatrixCase(target, target, false, { model, wireModel: 'deepseek-flash' });
    });
  }
  for (const model of ['deepseek-flash', 'publisher/deepseek-chat', 'deepseek-reasoner:custom', 'gpt-5.6']) {
    it(`keeps the configured wire ID ${model}`, async () => {
      await runConversionMatrixCase('chat', 'chat', false, { model, wireModel: model });
    });
  }
});
