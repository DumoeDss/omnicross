/**
 * compaction.ts — remote-compaction envelopes for the ChatGPT Web bridge.
 *
 * Codex decides "this provider supports remote compaction" by provider name
 * (built-in `OpenAI`) pointed at this bridge, so it sends compaction v2
 * requests (input ending with `{"type":"compaction_trigger"}`) and expects
 * EXACTLY ONE `{type:"compaction", encrypted_content:...}` output item.
 * A browser backend cannot produce OpenAI's encrypted blob, so the summary is
 * wrapped in the transparent `ocx1:` envelope (base64 of the UTF-8 text) and
 * decoded back to plain text when replayed in later input.
 *
 * Port of codex-chatgpt-web's responses/compaction.ts (v1 output builder
 * included for POST /responses/compact parity).
 *
 * @module @omnicross/chatgpt-web/bridge/compaction
 */

export const BRIDGE_COMPACTION_PREFIX = 'ocx1:';

/** Mirrors codex-rs core/templates/compact/prompt.md. */
export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/** Mirrors codex-rs core/templates/compact/summary_prefix.md. */
export const SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

export const OPAQUE_COMPACTION_NOTE =
  '[earlier conversation was compacted; the summary is stored in a format this model cannot read]';

export function isReadableCompactionSummaryText(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${SUMMARY_PREFIX}\n`);
}

export function encodeCompactionSummary(summary: string): string {
  return BRIDGE_COMPACTION_PREFIX + Buffer.from(summary, 'utf-8').toString('base64');
}

/** Decode an `ocx1:` envelope; null for real (OpenAI-encrypted) blobs or garbage. */
export function decodeCompactionSummary(encryptedContent: string): string | null {
  if (!encryptedContent.startsWith(BRIDGE_COMPACTION_PREFIX)) return null;
  try {
    return Buffer.from(encryptedContent.slice(BRIDGE_COMPACTION_PREFIX.length), 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/** Render a replayed compaction item as plain user-visible text. */
export function compactionItemToText(encryptedContent: string | undefined): string {
  const decoded = typeof encryptedContent === 'string' ? decodeCompactionSummary(encryptedContent) : null;
  return decoded ? `${SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_COMPACTION_NOTE;
}

/** Codex can persist unavailable historical images as a 1x1 PNG sentinel. */
export function isOnePixelPngDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) return false;
  try {
    const png = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
    return (
      png.length >= 24 &&
      png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      png.readUInt32BE(16) === 1 &&
      png.readUInt32BE(20) === 1
    );
  } catch {
    return false;
  }
}

/** codex-rs compact.rs COMPACT_USER_MESSAGE_MAX_TOKENS = 20k tokens (~4 chars/token). */
const COMPACT_V1_RETAINED_CHAR_BUDGET = 20_000 * 4;

type CompactMessageItem = Record<string, unknown>;

interface CompactContentBlock {
  type?: string;
  text?: string;
  image_url?: string;
}

/** Extract original user message items from a Responses `input` array. */
export function extractCompactUserMessages(input: unknown): CompactMessageItem[] {
  if (!Array.isArray(input)) return [];
  const out: CompactMessageItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as CompactMessageItem & { type?: string; role?: string; content?: unknown };
    if (rec['type'] !== undefined && rec['type'] !== 'message') continue;
    if (rec['role'] !== 'user') continue;
    if (
      compactContentBlocks(rec).some((block) => textBlock(block) && block['text'] && (
        /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/.test(block['text'].trim()) ||
        /^<goal_context>[\s\S]*<\/goal_context>$/.test(block['text'].trim())
      ))
    ) {
      continue;
    }
    if (isReadableCompactionSummaryText(compactContentBlocks(rec).filter(textBlock).map((b) => b['text'] ?? '').join(''))) {
      continue;
    }
    out.push(structuredClone(rec));
  }
  return out;
}

function compactUserMessageItem(text: string): CompactMessageItem {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

function compactContentBlocks(item: CompactMessageItem): CompactContentBlock[] {
  if (typeof item['content'] === 'string') {
    return [{ type: 'input_text', text: item['content'] }];
  }
  if (!Array.isArray(item['content'])) return [];
  return (item['content'] as unknown[])
    .filter((block): block is CompactContentBlock => Boolean(block && typeof block === 'object' && !Array.isArray(block)))
    .map((block) => structuredClone(block));
}

function textBlock(block: CompactContentBlock): boolean {
  return (block['type'] === 'input_text' || block['type'] === 'text') && typeof block['text'] === 'string';
}

function imageBlock(block: CompactContentBlock): boolean {
  return block['type'] === 'input_image' && typeof block['image_url'] === 'string' && !isOnePixelPngDataUrl(block['image_url']);
}

/** Build the v1 compact replacement history (`POST /responses/compact`). */
export function buildCompactV1Output(
  userMessages: CompactMessageItem[],
  summary: string,
  maxImages = 10,
): CompactMessageItem[] {
  const selected: CompactMessageItem[] = [];
  let remaining = COMPACT_V1_RETAINED_CHAR_BUDGET;
  let retainedImages = 0;
  for (let i = userMessages.length - 1; i >= 0 && (remaining > 0 || retainedImages < maxImages); i--) {
    const message = structuredClone(userMessages[i]);
    const blocks = compactContentBlocks(message);
    const retainedReversed: CompactContentBlock[] = [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (imageBlock(block)) {
        if (retainedImages < maxImages) {
          retainedImages += 1;
          retainedReversed.push(block);
        }
        continue;
      }
      if (!textBlock(block) || remaining === 0) continue;
      const text: string = typeof block['text'] === 'string' ? block['text'] : '';
      if (text.length <= remaining) {
        remaining -= text.length;
        retainedReversed.push({ ...block, type: 'input_text', text });
      } else {
        retainedReversed.push({ ...block, type: 'input_text', text: text.slice(text.length - remaining) });
        remaining = 0;
      }
    }
    const content = retainedReversed.reverse();
    if (content.length > 0) {
      message['type'] = 'message';
      message['role'] = 'user';
      message['content'] = content;
      selected.push(message);
    }
  }
  selected.reverse();
  const summaryText = summary.trim().length > 0 ? `${SUMMARY_PREFIX}\n${summary}` : '(no summary available)';
  return [...selected, compactUserMessageItem(summaryText)];
}
