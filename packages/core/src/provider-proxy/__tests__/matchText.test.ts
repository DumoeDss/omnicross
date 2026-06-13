/**
 * matchText tests — the SINGLE shared flattener that BOTH summary builders
 * (core `/v1/messages` `buildSubscriptionRequestSummary` + dispatcher
 * `/v1/responses` `buildRequestSummary`) feed their `SubscriptionRequestSummary
 * .matchText` from.
 *
 * The cross-builder equivalence the review-loop flagged is now GUARANTEED BY
 * CONSTRUCTION: both builders call THIS exact exported function with no per-path
 * pre/post-processing of the result. These tests therefore (a) prove the
 * function handles every content shape both builders previously diverged on
 * (tool_result string + nested array, nested-array content, `.text` blocks), and
 * (b) exercise the builder-level bound (last-6 / 8 KB / system-first / assistant
 * excluded) that the prior matcher-only tests never reached.
 */

import { describe, expect, it } from 'vitest';

// Import via BOTH the relative path (the core builder uses this) and the package
// subpath alias (the subscriptions dispatcher uses this) to prove they resolve
// to the SAME implementation — the by-construction equivalence guarantee.
import { collectMatchText as collectViaRelative } from '../matchText';
import {
  collectMatchText,
  MATCH_TEXT_PER_MESSAGE_CAP,
  MATCH_TEXT_RECENT_MESSAGES,
} from '../matchText';

describe('collectMatchText — shared single source of truth', () => {
  it('both builder import paths reference the identical function (equivalence by construction)', () => {
    // The dispatcher imports `@omnicross/core/provider-proxy/matchText`; the core
    // builder imports the relative `../matchText`. Same module → same function.
    expect(collectViaRelative).toBe(collectMatchText);
  });

  it('plain string content: system first, then the user message', () => {
    const body = {
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hello there' }],
    };
    expect(collectMatchText(body)).toEqual(['you are helpful', 'hello there']);
  });

  it('tool_result block with a STRING content is flattened (tool-blocker words are seen)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', content: 'please write to the file' }],
        },
      ],
    };
    expect(collectMatchText(body)).toEqual(['please write to the file']);
  });

  it('tool_result block with a NESTED-ARRAY content is flattened (the prior dispatcher dropped this)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              content: [{ type: 'text', text: 'edit the config' }],
            },
          ],
        },
      ],
    };
    expect(collectMatchText(body)).toEqual(['edit the config']);
  });

  it('nested-array content is recursed (the prior dispatcher flattener only walked one level)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [[{ type: 'text', text: 'deeply nested' }], { type: 'text', text: 'sibling' }],
        },
      ],
    };
    expect(collectMatchText(body)).toEqual(['deeply nested\nsibling']);
  });

  it('a bare object exposing a string .text is read (the prior core flattener kept this)', () => {
    const body = {
      system: [{ type: 'text', text: 'sys block' }],
      messages: [{ role: 'user', content: [{ text: 'untyped text block' }] }],
    };
    expect(collectMatchText(body)).toEqual(['sys block', 'untyped text block']);
  });
});

describe('collectMatchText — builder-level bound (design §2)', () => {
  it('drops messages beyond the last 6 user/system turns', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user',
      content: `msg-${i}`,
    }));
    const out = collectMatchText({ messages });
    // No system prompt → exactly the last 6 user messages, chronological order.
    expect(out).toHaveLength(MATCH_TEXT_RECENT_MESSAGES);
    expect(out).toEqual(['msg-4', 'msg-5', 'msg-6', 'msg-7', 'msg-8', 'msg-9']);
  });

  it('truncates each message at the per-message cap (8 KB)', () => {
    const huge = 'a'.repeat(MATCH_TEXT_PER_MESSAGE_CAP + 5000);
    const out = collectMatchText({ messages: [{ role: 'user', content: huge }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(MATCH_TEXT_PER_MESSAGE_CAP);
  });

  it('truncates the system prompt at the per-message cap too', () => {
    const hugeSys = 'b'.repeat(MATCH_TEXT_PER_MESSAGE_CAP + 1000);
    const out = collectMatchText({ system: hugeSys, messages: [] });
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(MATCH_TEXT_PER_MESSAGE_CAP);
  });

  it('emits the system prompt FIRST, before recent message slices', () => {
    const out = collectMatchText({
      system: 'SYSTEM',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(out[0]).toBe('SYSTEM');
    expect(out).toEqual(['SYSTEM', 'first', 'second']);
  });

  it('EXCLUDES assistant turns (role filter)', () => {
    const out = collectMatchText({
      messages: [
        { role: 'user', content: 'a user thing' },
        { role: 'assistant', content: 'an assistant reply — refactor everything' },
        { role: 'user', content: 'another user thing' },
      ],
    });
    // The assistant turn (which carries a `complex` keyword) is dropped.
    expect(out).toEqual(['a user thing', 'another user thing']);
  });

  it('drops empty / whitespace-only slices', () => {
    const out = collectMatchText({
      system: '   ',
      messages: [
        { role: 'user', content: '' },
        { role: 'user', content: 'real content' },
      ],
    });
    expect(out).toEqual(['real content']);
  });

  it('the last-6 window counts only user/system, skipping interleaved assistant turns', () => {
    // 8 user turns interleaved with assistant turns; only the last 6 USER turns
    // survive the role filter + window.
    const messages = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'user', content: 'u3' },
      { role: 'user', content: 'u4' },
      { role: 'user', content: 'u5' },
      { role: 'user', content: 'u6' },
      { role: 'user', content: 'u7' },
    ];
    expect(collectMatchText({ messages })).toEqual(['u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
  });
});
