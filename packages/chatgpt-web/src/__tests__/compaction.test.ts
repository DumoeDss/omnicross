/**
 * Compaction envelope + v1 output builder tests.
 *
 * @module @omnicross/chatgpt-web/bridge/__tests__/compaction.test
 */

import { describe, expect, it } from 'vitest';

import {
  buildCompactV1Output,
  compactionItemToText,
  decodeCompactionSummary,
  encodeCompactionSummary,
  extractCompactUserMessages,
  isOnePixelPngDataUrl,
  isReadableCompactionSummaryText,
  SUMMARY_PREFIX,
} from '../bridge/compaction';

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('compaction envelope', () => {
  it('round-trips ocx1 summaries', () => {
    const encoded = encodeCompactionSummary('交接内容');
    expect(encoded.startsWith('ocx1:')).toBe(true);
    expect(decodeCompactionSummary(encoded)).toBe('交接内容');
    expect(decodeCompactionSummary('gAAAAA...')).toBeNull();
  });

  it('renders replayed summaries with the codex prefix', () => {
    const text = compactionItemToText(encodeCompactionSummary('summary body'));
    expect(text.startsWith(`${SUMMARY_PREFIX}\n\n`)).toBe(true);
    // The prefix + newline check matches the two-newline v2 replay too (same as
    // codex-chatgpt-web: readable detection is prefix-based, not separator-based).
    expect(isReadableCompactionSummaryText(text)).toBe(true);
    expect(compactionItemToText(undefined)).toContain('cannot read');
  });

  it('detects the 1x1 PNG sentinel', () => {
    expect(isOnePixelPngDataUrl(ONE_PIXEL_PNG)).toBe(true);
    expect(isOnePixelPngDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(isOnePixelPngDataUrl('https://example.com/a.png')).toBe(false);
  });
});

describe('extractCompactUserMessages + buildCompactV1Output', () => {
  it('keeps only real user messages and drops runtime wrappers', () => {
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real request' }] },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<codex_internal_context source="goal">steering</codex_internal_context>' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\nold summary` }],
      },
    ];
    const extracted = extractCompactUserMessages(input);
    expect(extracted).toHaveLength(1);
  });

  it('builds replacement history: retained recent messages + one summary tail', () => {
    const userMessages = extractCompactUserMessages([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] },
    ]);
    const output = buildCompactV1Output(userMessages, 'the summary');
    const summary = output.at(-1) as { role: string; content: Array<{ text: string }> };
    expect(summary.role).toBe('user');
    expect(summary.content[0].text).toBe(`${SUMMARY_PREFIX}\nthe summary`);
    expect(output).toHaveLength(3);
  });

  it('retains images newest-first within the attachment cap', () => {
    const input = Array.from({ length: 12 }, (_, index) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: `data:image/png;base64,IMG${index}` }],
    }));
    const output = buildCompactV1Output(extractCompactUserMessages(input), 's', 3);
    const images = output.flatMap((item) =>
      (item['content'] as Array<{ type?: string }>).filter((block) => block['type'] === 'input_image'),
    );
    expect(images).toHaveLength(3);
  });
});
