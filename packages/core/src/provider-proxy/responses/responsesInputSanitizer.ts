/**
 * Responses input sanitation — make an OUTGOING `/responses` body acceptable to
 * strict upstreams, without changing what the conversation means.
 *
 * Some Responses-compatible upstreams validate `input` more strictly than the
 * official API. Command Code's `provider/v1/responses` is the observed one: it
 * answers every violation with a bare
 * `{"error":{"message":"{\"type\":\"invalid_request_error\",…\"invalid request
 * error trace_id: …\"}"}}` — nothing diagnosable — so the shapes it refuses had
 * to be mapped by replaying one input item at a time. It enforces
 * (2026-10-09, measured against the live upstream):
 *
 * - TOOL-BLOCK CONTAINMENT: from a tool-call item until every call opened in
 *   that run has been answered, the ONLY items allowed are the calls and their
 *   outputs. A `message` or `reasoning` anywhere inside — `[call, message,
 *   output]`, `[call, user-message, output]`, `[call, reasoning, output]` — is
 *   refused. A message BEFORE the run or AFTER it closes is fine.
 * - NO EMPTY ASSISTANT TEXT: an assistant message whose content is empty text
 *   is refused when the input continues into a tool block. A non-empty text
 *   (even one space) is always fine.
 *
 * These shapes are not exotic. Three producers create them in practice, and two
 * cannot be fixed at the source:
 *
 * - the native DSML salvage (see `nativeResponsesDsml`) can leave a message
 *   item beside a replayed call;
 * - a client FAITHFULLY records items in the order they finish streaming, so a
 *   turn written by an older build keeps its bad order in the session rollout
 *   forever — a resumed session re-sends it on every request, and no fix to a
 *   producer can reach it;
 * - the unified pivot's chat→Responses translation for a tool-only assistant
 *   turn emits a message item with no text.
 *
 * Fixing each producer leaves the next one to discover; a session already
 * carrying an old shape can never be fixed at the source at all. So the repair
 * lives here instead: ONE pass, applied to every outgoing Responses body at the
 * single choke point, that accepts anything and emits only accepted shapes.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO — drop, or never rearrange, the
 * call/output machinery:
 *
 * - It NEVER drops a call or an output, even an "orphan" one. A `function_call`
 *   with no output, or an output with no call, is refused by the strict
 *   upstream (measured), but such items are legitimate elsewhere: the
 *   hosted-image continuation deliberately injects a SYNTHETIC
 *   `function_call_output` receipt for a call the previous turn made (see
 *   `responsesHostedImageIngress`), and dropping it silently corrupts that
 *   conversation. An orphan cannot be repaired into a valid pair, so it is left
 *   exactly as the caller sent it — a strict upstream's stricter rule is not
 *   worth breaking a working route.
 * - Rearranging is bounded: an item is moved out of a tool block ONLY when one
 *   of that block's open calls is answered later in the SAME input. An
 *   unterminated block therefore passes through untouched instead of having
 *   whatever follows it hoisted in front.
 *
 * The one item that is removed is an assistant message with no text at all —
 * content-free by definition, and the trigger for the second rule above.
 *
 * @module provider-proxy/responses/responsesInputSanitizer
 */

/** Item types that pair a tool call with its result. */
const CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

/** Content-part types whose payload is plain text (and therefore perhaps empty). */
const TEXT_PART_TYPES = new Set([
  'output_text',
  'input_text',
  'text',
  'summary_text',
  'reasoning_text',
  'refusal',
]);

type Item = Record<string, unknown>;

function isRecord(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(item: Item): string {
  return typeof item.type === 'string' ? item.type : '';
}

function isCall(item: Item): boolean {
  return CALL_TYPES.has(typeOf(item));
}

function isOutput(item: Item): boolean {
  return OUTPUT_TYPES.has(typeOf(item));
}

/**
 * The id linking a call to its output. A call also carries `id` (the ITEM id,
 * prefixed `fc_`/`ctc_`/…); only `call_id` is the pairing handle.
 */
function callIdOf(item: Item): string {
  const callId = item.call_id;
  return typeof callId === 'string' ? callId : '';
}

/**
 * An assistant message carrying no text anywhere in its content.
 *
 * `content` may be a bare string or an array of parts. A part of a TEXT type
 * contributes its `text`/`refusal` (so an empty `output_text` contributes
 * nothing); any other part type counts as content, because a payload this
 * module does not recognize — an image, an opaque blob — must never be mistaken
 * for empty text and removed. A user message is never "empty" here either: only
 * an assistant's own text is the trigger.
 */
function isEmptyAssistantMessage(item: Item): boolean {
  if (typeOf(item) !== 'message' || item.role !== 'assistant') return false;
  const content = item.content;
  if (typeof content === 'string') return content === '';
  if (!Array.isArray(content)) return true;
  for (const part of content) {
    if (typeof part === 'string') {
      if (part !== '') return false;
      continue;
    }
    if (!isRecord(part)) continue;
    if (!TEXT_PART_TYPES.has(typeOf(part))) return false;
    for (const key of ['text', 'refusal'] as const) {
      const value = part[key];
      if (typeof value === 'string' && value !== '') return false;
    }
  }
  return true;
}

/** One tool block, buffered until it closes. */
interface OpenBlock {
  /** Calls and outputs, in the order they arrived. */
  readonly sequence: Item[];
  /** The `call_id`s opened by this block's calls (non-empty ids only). */
  readonly opened: Set<string>;
  /** The subset of `opened` whose output has arrived. */
  readonly answered: Set<string>;
  /** Prose pulled out of the block, emitted BEFORE it. */
  readonly escaped: Item[];
}

function blockSettled(block: OpenBlock): boolean {
  for (const id of block.opened) if (!block.answered.has(id)) return false;
  return true;
}

/** Emit a closed block: escaped prose first, then the calls and their outputs. */
function flushBlock(out: unknown[], block: OpenBlock): void {
  out.push(...block.escaped, ...block.sequence);
}

/**
 * Is one of `pending` answered by an output appearing at or after `from`?
 *
 * The lookahead that keeps the reordering honest: an item interrupting a tool
 * block is only moved when the block actually closes afterwards. When it does
 * not (a call the client never got an answer for), the item stays where the
 * caller put it.
 */
function answeredLater(input: readonly unknown[], from: number, pending: Set<string>): boolean {
  for (let index = from; index < input.length; index++) {
    const item = input[index];
    if (!isRecord(item) || !isOutput(item)) continue;
    if (pending.has(callIdOf(item))) return true;
  }
  return false;
}

/**
 * Rewrite one Responses `input` array into a shape a strict upstream accepts.
 *
 * Returns a NEW array; the caller's items are not mutated.
 */
export function sanitizeResponsesInput(input: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  let block: OpenBlock | null = null;

  const closeBlock = (): void => {
    if (block) flushBlock(out, block);
    block = null;
  };

  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    if (!isRecord(raw)) {
      // A non-object item cannot be classified; it is never tool machinery, so
      // it escapes an open block like any other prose.
      if (block && !blockSettled(block) && answeredLater(input, index + 1, block.opened)) {
        block.escaped.push(raw as Item);
      } else {
        closeBlock();
        out.push(raw);
      }
      continue;
    }
    const item = raw;

    if (isCall(item)) {
      if (!block) block = { sequence: [], opened: new Set(), answered: new Set(), escaped: [] };
      block.sequence.push(item);
      const id = callIdOf(item);
      // A call with no id can never be answered; it simply never settles.
      if (id !== '') block.opened.add(id);
      continue;
    }

    if (isOutput(item)) {
      if (!block) {
        // An output with no call open answers nothing — but it is NOT dropped:
        // hosted-image continuations send exactly this as a synthetic receipt
        // for the previous turn. It passes through untouched.
        out.push(item);
        continue;
      }
      block.sequence.push(item);
      const id = callIdOf(item);
      if (id !== '' && block.opened.has(id)) block.answered.add(id);
      if (blockSettled(block)) closeBlock();
      continue;
    }

    // Any other item — a user/assistant message, reasoning, an unknown type.
    if (block && !blockSettled(block) && answeredLater(input, index + 1, block.opened)) {
      // This item interrupts a tool block that closes later: it belongs BEFORE
      // the block, which is also the order a genuine stream produces
      // (`[… assistant message, function_call, function_call_output]`).
      if (!isEmptyAssistantMessage(item)) block.escaped.push(item);
      continue;
    }
    closeBlock();
    if (isEmptyAssistantMessage(item)) continue;
    out.push(item);
  }

  closeBlock();
  return out;
}

/**
 * Apply {@link sanitizeResponsesInput} to a Responses request body in place.
 *
 * Only `input` is touched; every other field (model, tools, reasoning, stream…)
 * is left exactly as the caller sent it. Returns the same object for chaining.
 */
export function sanitizeResponsesRequest(body: Item): Item {
  const input = body.input;
  if (!Array.isArray(input)) return body;
  body.input = sanitizeResponsesInput(input);
  return body;
}
