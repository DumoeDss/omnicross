/**
 * auditSseCompact — optional streaming-body compaction for captured audit
 * responses (audit-store-sharding, design D3).
 *
 * A streamed response is dominated by per-token `*_delta` envelopes: hundreds of
 * frames whose JSON scaffolding dwarfs the few characters of text each carries.
 * When `compactStreamingBodies` is on, each RUN of same-channel delta frames is
 * merged into ONE synthetic frame carrying the concatenated text plus a count of
 * the frames it replaced.
 *
 * WHAT IS NEVER TOUCHED: every non-delta frame is emitted VERBATIM — `error`,
 * `response.failed`, `message_stop`, `message_delta` (which carries usage), and
 * anything unrecognized. Compaction must not cost failure visibility: an
 * "at capacity" overload arrives as a 200 + `response.failed` frame, and losing
 * that would make a real outage unreadable in the audit log.
 *
 * Non-SSE payloads (a plain JSON error body) are returned UNCHANGED. Gemini
 * chunks are left alone too — they stream whole candidate objects rather than
 * token deltas, so merging them would drop `finishReason` / `usageMetadata`.
 *
 * Pure module — no I/O, never throws (any parse failure degrades to verbatim).
 *
 * @module @omnicross/core/outbound-api/auditSseCompact
 */

/** Marker field on a synthetic frame recording how many frames it replaced. */
export const MERGED_FRAMES_FIELD = '_omnicrossMergedFrames';

/** One recognized delta frame: which run it belongs to and what text it adds. */
interface DeltaFrame {
  /** Run identity — two frames merge only when their channels are equal. */
  channel: string;
  /** The text this frame contributes. */
  text: string;
  /** The parsed payload, reused as the template for the merged frame. */
  payload: Record<string, unknown>;
  /** Path of the field the merged text is written back to. */
  textPath: readonly string[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/**
 * Classify one parsed SSE payload as a mergeable delta, or `null` when it must be
 * kept verbatim. Covers the Anthropic `messages` and both OpenAI shapes; anything
 * else (Gemini, unknown vendors) deliberately falls through to verbatim.
 */
function classify(payload: Record<string, unknown>): DeltaFrame | null {
  const type = scalar(payload['type']);

  // Anthropic messages: content_block_delta carries text / thinking / tool json.
  if (type === 'content_block_delta') {
    const delta = asObject(payload['delta']);
    const deltaType = scalar(delta?.['type']);
    const field = deltaType === 'text_delta'
      ? 'text'
      : deltaType === 'thinking_delta'
        ? 'thinking'
        : deltaType === 'input_json_delta'
          ? 'partial_json'
          : null;
    if (!delta || !field || typeof delta[field] !== 'string') return null;
    return {
      channel: 'anthropic:' + scalar(payload['index']) + ':' + deltaType,
      text: delta[field] as string,
      payload,
      textPath: ['delta', field],
    };
  }

  // OpenAI Responses: a family of `*.delta` events whose `delta` is a string.
  if (type.endsWith('.delta') && typeof payload['delta'] === 'string') {
    const channel = [
      'responses',
      type,
      scalar(payload['item_id']),
      scalar(payload['output_index']),
      scalar(payload['content_index']),
    ].join(':');
    return { channel, text: payload['delta'], payload, textPath: ['delta'] };
  }

  // OpenAI chat completions: choices[0].delta.content.
  const choices = payload['choices'];
  if (Array.isArray(choices) && choices.length === 1) {
    const choice = asObject(choices[0]);
    const delta = asObject(choice?.['delta']);
    // A frame that also closes the choice carries `finish_reason` — keep it
    // whole. Merging a content run must never swallow a tool-call run either.
    if (
      choice &&
      delta &&
      typeof delta['content'] === 'string' &&
      choice['finish_reason'] == null &&
      delta['tool_calls'] === undefined &&
      delta['function_call'] === undefined
    ) {
      return {
        channel: 'chat:' + scalar(choice['index']),
        text: delta['content'],
        payload,
        textPath: ['choices', '0', 'delta', 'content'],
      };
    }
  }

  return null;
}

/** Write `text` back into a structural clone of the run's first payload. */
function withMergedText(
  frame: DeltaFrame,
  text: string,
  mergedCount: number,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(frame.payload)) as Record<string, unknown>;
  let cursor: unknown = clone;
  for (let i = 0; i < frame.textPath.length - 1; i += 1) {
    const step = frame.textPath[i] as string;
    const next = Array.isArray(cursor)
      ? (cursor as unknown[])[Number(step)]
      : (cursor as Record<string, unknown>)[step];
    if (next === null || typeof next !== 'object') return clone;
    cursor = next;
  }
  const leaf = frame.textPath[frame.textPath.length - 1] as string;
  if (Array.isArray(cursor)) (cursor as unknown[])[Number(leaf)] = text;
  else (cursor as Record<string, unknown>)[leaf] = text;
  clone[MERGED_FRAMES_FIELD] = mergedCount;
  return clone;
}

/** One physical SSE block: its `event:`/comment lines plus a single `data:` payload. */
interface Block {
  /** Everything before the `data:` line (event name, comments, ids). */
  head: string[];
  /** The joined `data:` payload text, or `null` for a block without one. */
  data: string | null;
  /** The block re-rendered exactly as it arrived. */
  raw: string;
}

/** Split an SSE stream into blocks on blank-line boundaries. */
function splitBlocks(text: string, nl: string): Block[] {
  const blocks: Block[] = [];
  let head: string[] = [];
  let data: string | null = null;
  let raw: string[] = [];

  const flush = (): void => {
    if (raw.length === 0) return;
    blocks.push({ head, data, raw: raw.join(nl) });
    head = [];
    data = null;
    raw = [];
  };

  for (const line of text.split(nl)) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    raw.push(line);
    if (line.startsWith('data:')) {
      const payload = line.slice('data:'.length).trimStart();
      data = data === null ? payload : data + nl + payload;
    } else {
      head.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * Merge runs of same-channel streaming text deltas. Returns `text` UNCHANGED when
 * it is not an SSE stream or when nothing was mergeable, so the caller can apply
 * it unconditionally.
 */
export function compactSseBody(text: string): string {
  if (!text || !text.includes('data:')) return text;
  const nl = '\n';

  const blocks = splitBlocks(text, nl);
  if (blocks.length === 0) return text;

  const out: string[] = [];
  let runFrame: DeltaFrame | null = null;
  let runBlock: Block | null = null;
  let runText = '';
  let runCount = 0;
  let merged = 0;

  const flushRun = (): void => {
    if (runFrame === null || runBlock === null) return;
    if (runCount === 1) {
      out.push(runBlock.raw);
    } else {
      const payload = withMergedText(runFrame, runText, runCount);
      out.push([...runBlock.head, 'data: ' + JSON.stringify(payload)].join(nl));
      merged += runCount;
    }
    runFrame = null;
    runBlock = null;
    runText = '';
    runCount = 0;
  };

  for (const block of blocks) {
    let frame: DeltaFrame | null = null;
    if (block.data !== null && block.data !== '[DONE]') {
      try {
        const parsed = asObject(JSON.parse(block.data));
        if (parsed) frame = classify(parsed);
      } catch {
        frame = null; // Unparseable payload — keep it verbatim.
      }
    }

    if (frame === null) {
      flushRun();
      out.push(block.raw);
      continue;
    }
    const open: DeltaFrame | null = runFrame;
    if (open !== null && open.channel === frame.channel) {
      runText += frame.text;
      runCount += 1;
      continue;
    }
    flushRun();
    runFrame = frame;
    runBlock = block;
    runText = frame.text;
    runCount = 1;
  }
  flushRun();

  if (merged === 0) return text;
  // Preserve the trailing blank-line terminator the original stream ended with.
  const trailer = /\s$/.test(text) ? nl + nl : '';
  return out.join(nl + nl) + trailer;
}
