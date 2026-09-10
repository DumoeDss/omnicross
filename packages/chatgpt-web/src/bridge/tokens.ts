/**
 * tokens.ts — token accounting for ChatGPT Web prompts.
 *
 * Counts with the o200k_base tokenizer (the GPT-5 generation encoding, via
 * js-tiktoken — pure JS, lazily loaded). Chunked so pathological multi-
 * megabyte runs never hit one encode call; chunks can only over-count
 * slightly (missed boundary merges), never under-count.
 *
 * @module @omnicross/chatgpt-web/bridge/tokens
 */

import type { Tiktoken } from 'js-tiktoken';

const TOKENIZER_CHUNK_CHARS = 4_096;

let tokenizerPromise: Promise<Tiktoken> | undefined;

async function tokenizer(): Promise<Tiktoken> {
  tokenizerPromise ??= (async () => {
    const { getEncoding } = await import('js-tiktoken');
    return getEncoding('o200k_base');
  })();
  return tokenizerPromise;
}

/** Synchronous fast path for tests and small strings (chars/4 heuristic). */
export function estimateTokensFallback(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Count ordinary text with the o200k tokenizer. */
export async function estimateTokens(text: string): Promise<number> {
  if (!text) return 0;
  let encoding: Tiktoken;
  try {
    encoding = await tokenizer();
  } catch {
    return estimateTokensFallback(text);
  }
  let count = 0;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + TOKENIZER_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      // Never split a surrogate pair across chunks.
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end -= 1;
      }
    }
    // js-tiktoken has no encode_ordinary; empty allowed+disallowed special sets
    // give identical semantics (special tokens encoded as ordinary text).
    count += encoding.encode(text.slice(start, end), [], []).length;
    start = end;
  }
  return count;
}

/** Image attachment token reserve in usage estimates. */
export function chatGptWebImageTokenReserve(detail?: string): number {
  return detail === 'original' ? 8_192 : 4_096;
}
