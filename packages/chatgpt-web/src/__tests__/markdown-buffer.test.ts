/**
 * Markdown buffer tests: append-only commits, stability window, virtualized
 * prefix reconciliation, and committed-text change detection.
 *
 * @module @omnicross/chatgpt-web/chatgpt/__tests__/markdown-buffer.test
 */

import { describe, expect, it } from 'vitest';

import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from '../chatgpt/markdown-buffer';

function segment(key: string, text: string, extra: Partial<ChatGptMarkdownSegment> = {}): ChatGptMarkdownSegment {
  return { key, tag: 'p', html: `<p>${text}</p>`, text, streamable: true, ...extra };
}

describe('ChatGptMarkdownBuffer', () => {
  it('commits stable segments in order and joins them', () => {
    const buffer = new ChatGptMarkdownBuffer(0);
    const t0 = 1_000;
    const delta = buffer.observe([segment('a', 'first'), segment('b', 'second')], t0);
    expect(delta).toContain('first');
    expect(delta).toContain('second');
    const finished = buffer.finish();
    expect(finished.delta).toBe('');
    expect(finished.markdown).toContain('first');
    expect(finished.markdown).toContain('second');
  });

  it('holds the last segment until finish (never streamable mid-turn)', () => {
    const buffer = new ChatGptMarkdownBuffer(0);
    const delta = buffer.observe([segment('a', 'only', { streamable: false })], 1_000);
    expect(delta).toBe('');
    const finished = buffer.finish();
    expect(finished.delta).toContain('only');
  });

  it('respects the stability window before committing', () => {
    const buffer = new ChatGptMarkdownBuffer(750);
    expect(buffer.observe([segment('a', 'x'), segment('b', '')], 1_000)).toBe('');
    expect(buffer.observe([segment('a', 'x'), segment('b', 'y')], 1_700)).toBe('');
    const delta = buffer.observe([segment('a', 'x'), segment('b', 'y')], 1_800);
    expect(delta).toContain('x');
  });

  it('accepts a virtualized (missing) committed prefix on later observations', () => {
    const buffer = new ChatGptMarkdownBuffer(0);
    buffer.observe([segment('a', 'old'), segment('b', 'new')], 1_000);
    // Virtualization drops the committed prefix from the DOM; only the tail remains.
    const delta = buffer.observe([segment('b', 'new')], 2_000);
    expect(delta).toBe('');
    const finished = buffer.finish();
    expect(finished.markdown).toContain('old');
    expect(finished.markdown).toContain('new');
  });

  it('fails explicitly when committed text changes', () => {
    const buffer = new ChatGptMarkdownBuffer(0);
    buffer.observe([segment('a', 'immutable', { sourceStart: 0, sourceEnd: 9 }), segment('b', 'tail')], 1_000);
    const delta = buffer.observe(
      [segment('a', 'MUTATED', { sourceStart: 0, sourceEnd: 9 }), segment('b', 'tail')],
      2_000,
    );
    expect(delta).toBe('');
    expect(buffer.currentSnapshotIsConsistent()).toBe(false);
    expect(() => buffer.finish()).toThrow(/changed a completed text block/);
  });

  it('uses source ranges as identity across reparented roots', () => {
    const buffer = new ChatGptMarkdownBuffer(0);
    buffer.observe(
      [segment('ignored', 'one', { sourceStart: 10, sourceEnd: 12 }), segment('x', 'two', { sourceStart: 20, sourceEnd: 22 })],
      1_000,
    );
    // Same source ranges with different synthetic keys still reconcile.
    const delta = buffer.observe(
      [segment('different-key', 'one', { sourceStart: 10, sourceEnd: 12 })],
      2_000,
    );
    expect(delta).toBe('');
  });
});
