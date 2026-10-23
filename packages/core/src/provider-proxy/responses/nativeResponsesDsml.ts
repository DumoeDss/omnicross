/**
 * DSML salvage for the NATIVE Responses relay.
 *
 * `runNative` relays the upstream's Responses wire byte-for-byte — by design,
 * the official codex upstream decides everything. But a THIRD-PARTY
 * native-Responses provider (Command Code's `…/provider/v1/responses`) serves
 * DeepSeek models whose tool calls can regress into DSML markup delivered as
 * ordinary `output_text` (the 2026-09-22 deepseek-v4.1-flash regression). On
 * the native path no transformer runs, so the leaked markup streams straight
 * into codex as prose and the turn ends with no tool executed — the same
 * failure the reduced-path salvage in `utils/dsmlToolCalls` already fixes for
 * chat upstreams.
 *
 * This module applies the SAME salvage to a native relay: the response stream
 * (or JSON) passes through untouched unless DSML markup is detected, in which
 * case the markup is replaced by the `function_call` / `custom_tool_call`
 * output items the model meant to produce. A healthy upstream never notices
 * this layer exists.
 *
 * One native-path subtlety: the upstream may REBUILD the tool declarations, so
 * the name the model writes (e.g. bare `exec`) can differ from the flattened
 * name codex declared (`functions__exec`). Salvaged names are resolved back to
 * the declared tool by exact match, then by unique `__`-suffix, before the
 * call is encoded.
 *
 * TWO upstream rules shape how a salvaged item is emitted (2026-10-09 field
 * report: codex against Command Code failed with 400 `invalid_request_error`
 * on every turn AFTER the first salvaged one). Both were measured against the
 * live upstream by replaying one input item at a time:
 *
 * 1. NO MESSAGE INSIDE A TOOL BLOCK — a `message` item may not sit between a
 *    tool call and the outputs that answer it (`[call, message, output]` and
 *    `[call, user-message, output]` both 400; `[call, call, output, output]`,
 *    `[message, call, output]` and `[call, output, message]` are fine). Codex
 *    records items in the order they FINISH streaming, so a call replayed
 *    before the message item's `output_item.done` came back next turn as
 *    `[… call, assistant message, call-output …]` — the rejected shape. The
 *    call is therefore replayed behind that event (`after`), which reproduces
 *    the genuine stream's order.
 * 2. NO EMPTY TEXT — an assistant message whose `output_text` part is `''` is
 *    rejected when the input continues into a tool block (alone, or followed
 *    by a user message, it passes). A turn whose entire output was markup
 *    cleans to exactly that, so empty parts are dropped instead of emitted.
 *
 * @module provider-proxy/responses/nativeResponsesDsml
 */

import {
  dsmlCallId,
  DsmlStreamSuppressor,
  isDsmlSalvageArmed,
  salvageDsmlToolCalls,
} from '../../transformer/transformers/utils/dsmlToolCalls';
import {
  collectCodexTools,
  encodeToolCallItem,
  resolveDeclaredWireName,
  type CodexToolDeclarations,
} from '../../transformer/transformers/utils/codexToolProtocol';

/**
 * Decide whether the native relay should wrap this response, and with what
 * state. Armed only for DeepSeek-family request models (the relay forwards the
 * request verbatim, so the request model IS the upstream model) and only while
 * the salvage switch allows it.
 */
export function armNativeDsmlSalvage(
  body: Record<string, unknown>,
): CodexToolDeclarations | null {
  if (!isDsmlSalvageArmed(body.model)) return null;

  // Recover codex's tool declarations from the relayed request — the same
  // `additional_tools` item the reduced path decodes, plus the plain top-level
  // `tools` array some Responses clients send. Without this, a salvaged call
  // cannot be told apart as custom vs function, nor get its namespace back.
  const declarations: CodexToolDeclarations = {
    tools: [],
    customToolNames: [],
    customToolCallIds: [],
    toolNamespaces: {},
  };
  const input = body.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (
        item &&
        typeof item === 'object' &&
        (item as Record<string, unknown>).type === 'additional_tools'
      ) {
        mergeDeclarations(declarations, collectCodexTools(item as Record<string, unknown>));
      }
    }
  }
  if (Array.isArray(body.tools)) {
    mergeDeclarations(declarations, collectCodexTools({ tools: body.tools }));
  }
  return declarations;
}

function mergeDeclarations(target: CodexToolDeclarations, extra: CodexToolDeclarations): void {
  const names = new Set(target.tools.map((tool) => tool.function.name));
  for (const tool of extra.tools) {
    if (!names.has(tool.function.name)) target.tools.push(tool);
  }
  target.customToolNames = [...new Set([...target.customToolNames, ...extra.customToolNames])];
  target.customToolCallIds = [
    ...new Set([...target.customToolCallIds, ...extra.customToolCallIds]),
  ];
  Object.assign(target.toolNamespaces, extra.toolNamespaces);
}

/**
 * Resolve a name the model wrote to the declared flattened name it means.
 *
 * The upstream may have rebuilt declarations (dropping our `functions__`
 * prefix), so `exec` must find `functions__exec`. A bare inner name mapping to
 * MORE than one declaration is ambiguous and stays unresolved — encoding it
 * as-is at least fails loudly instead of dispatching the wrong tool. The
 * resolution itself lives in the transformer (shared with the reduced
 * encoder, which faces the same model behaviour).
 */
export function resolveDeclaredName(name: string, declarations: CodexToolDeclarations): string {
  return resolveDeclaredWireName(name, declarations);
}

/** Salvage the calls a DSML block encodes, as completed output items. */
function salvagedCallItems(
  markup: string,
  declarations: CodexToolDeclarations,
): Array<Record<string, unknown>> {
  const { calls } = salvageDsmlToolCalls(markup);
  return calls.map((call, index) =>
    encodeToolCallItem(
      dsmlCallId(call, index),
      resolveDeclaredName(call.name, declarations),
      call.arguments,
      'completed',
      declarations,
    ),
  );
}

/**
 * Set every `output_text` part of a message item to one text.
 *
 * An EMPTY `output_text` part is not merely useless: a strict third-party
 * Responses upstream (Command Code) rejects the request that echoes it back
 * with `invalid_request_error`, and a salvaged turn whose whole prose was
 * markup leaves exactly that behind — the suppressor forwarded no text at all,
 * so the cleaned text is `''`. Dropping the part (an empty `content` array is
 * accepted) keeps the message item in place without carrying the empty text.
 */
function withMessageText(
  item: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  const content = Array.isArray(item.content) ? item.content : [];
  const rewritten: unknown[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      (part as Record<string, unknown>).type === 'output_text'
    ) {
      if (text !== '') rewritten.push({ ...(part as Record<string, unknown>), text });
      continue;
    }
    rewritten.push(part);
  }
  return { ...item, content: rewritten };
}

// ============================================================================
// Non-streaming JSON
// ============================================================================

/**
 * Rewrite a non-streaming native Responses JSON body in place: message text is
 * cleaned of markup and the salvaged calls are appended as output items.
 * Returns true when anything changed.
 */
export function salvageNativeResponsesJson(
  data: Record<string, unknown>,
  declarations: CodexToolDeclarations,
): boolean {
  const output = data.output;
  if (!Array.isArray(output)) return false;

  let changed = false;
  const calls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'message' || !Array.isArray(record.content)) continue;
    let itemSalvaged = false;
    for (const part of record.content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.type !== 'output_text' || typeof p.text !== 'string') continue;
      const salvaged = salvageDsmlToolCalls(p.text);
      if (!salvaged.sawMarkup) continue;
      calls.push(...salvagedCallItems(p.text, declarations));
      p.text = salvaged.cleaned;
      itemSalvaged = true;
      changed = true;
    }
    // Same rule as `withMessageText`: a part cleaning to '' must not survive.
    if (itemSalvaged) {
      record.content = (record.content as Array<Record<string, unknown>>).filter(
        (part) => !(part?.type === 'output_text' && part.text === ''),
      );
    }
  }

  if (calls.length > 0) data.output = [...output, ...calls];
  return changed || calls.length > 0;
}

// ============================================================================
// Streaming SSE
// ============================================================================

/**
 * What to do with one upstream SSE event.
 *
 * - `forward` — relay the original line untouched (the common case; healthy
 *   streams are byte-identical through this wrapper).
 * - `drop` — swallow the event (a suppressed text delta).
 * - `rewrite` — replace the event with this serialized JSON.
 * - `emit` — send these NEW events around the original: `before` ahead of it,
 *   `after` behind it (synthesized tool-call lifecycle events placed where the
 *   genuine stream would have carried them).
 */
type EventDisposition =
  | { action: 'forward' }
  | { action: 'drop' }
  | { action: 'rewrite'; json: string }
  | {
      action: 'emit';
      before: Array<Record<string, unknown>>;
      then: 'forward' | { json: string };
      /**
       * New events emitted AFTER the original — the order the client must see
       * them in when a synthesized item belongs BEHIND the original one. See
       * the message-finalization branch for why the salvaged call rides here.
       */
      after?: Array<Record<string, unknown>>;
    };

/**
 * Wrap a native Responses SSE stream with DSML salvage.
 *
 * Line-oriented: each source line is forwarded with its own bytes unless the
 * event needs rewriting. Once an opener is seen, all further text deltas are
 * swallowed, and at finalization the captured markup is replayed as
 * `output_item.added` → argument-delta → `output_item.done` events — the same
 * sequence the reduced-path converter emits and codex already consumes.
 * `response.completed`'s `output` array is rewritten to agree.
 */
export function wrapNativeResponsesSse(
  stream: ReadableStream<Uint8Array>,
  declarations: CodexToolDeclarations,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const suppressor = new DsmlStreamSuppressor();

  // Prose already forwarded to the client — message items are finalized with
  // exactly this text, so what codex records matches what it displayed.
  let forwardedText = '';
  let callsReplayed = false;
  // The items the replay produced — `response.completed` needs them for its
  // `output` array even though the events themselves are only emitted once.
  let replayedItems: Array<Record<string, unknown>> = [];
  let nextOutputIndex = 0;

  const replayCalls = (): Array<Record<string, unknown>> => {
    // Read the suppressor's CURRENT capture — it keeps growing until the turn
    // ends, so snapshotting it at opener time would replay one line only.
    const markup = suppressor.capturedText;
    if (callsReplayed || !markup) return [];
    callsReplayed = true;
    const items = salvagedCallItems(markup, declarations);
    replayedItems = items;
    const events: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const outputIndex = nextOutputIndex++;
      events.push(
        {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { ...item, status: 'in_progress' },
        },
        ...(item.type === 'custom_tool_call'
          ? [
              {
                type: 'response.custom_tool_call_input.delta',
                output_index: outputIndex,
                delta: item.input,
              },
              {
                type: 'response.custom_tool_call_input.done',
                output_index: outputIndex,
                input: item.input,
              },
            ]
          : [
              {
                type: 'response.function_call_arguments.delta',
                output_index: outputIndex,
                delta: item.arguments,
              },
            ]),
        { type: 'response.output_item.done', output_index: outputIndex, item },
      );
    }
    return events;
  };

  const handleEvent = (event: Record<string, unknown>): EventDisposition => {
    const type = event.type;

    if (type === 'response.output_text.delta') {
      if (typeof event.output_index === 'number') {
        nextOutputIndex = Math.max(nextOutputIndex, event.output_index + 1);
      }
      const delta = event.delta;
      if (typeof delta !== 'string' || delta === '') return { action: 'forward' };

      if (suppressor.capturing) {
        suppressor.push(delta);
        return { action: 'drop' };
      }
      const release = suppressor.push(delta);
      if (release === '') return { action: 'drop' };
      // The forwarded text is accumulated on BOTH branches — the final message
      // item must carry everything the client saw, whether the delta passed
      // through untouched or was re-shaped by the suppressor.
      forwardedText += release;
      if (release === delta) return { action: 'forward' };
      return { action: 'rewrite', json: JSON.stringify({ ...event, delta: release }) };
    }

    if (type === 'response.output_item.added' && typeof event.output_index === 'number') {
      nextOutputIndex = Math.max(nextOutputIndex, event.output_index + 1);
      return { action: 'forward' };
    }

    // Final text of one content part — must not carry markup.
    if (type === 'response.output_text.done') {
      const before: Array<Record<string, unknown>> = [];
      if (!suppressor.capturing) {
        const rest = suppressor.flush();
        if (rest) {
          forwardedText += rest;
          before.push({
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            delta: rest,
          });
        }
      }
      if (event.text === forwardedText) {
        return before.length ? { action: 'emit', before, then: 'forward' } : { action: 'forward' };
      }
      return {
        action: 'emit',
        before,
        then: { json: JSON.stringify({ ...event, text: forwardedText }) },
      };
    }

    // Final message item — its content is the authoritative text codex records
    // for the turn, so it must match what was actually streamed.
    //
    // The salvaged call rides AFTER this event, never before it. Client item
    // order follows the order the items FINISH on the wire, and a client that
    // records the call first re-sends it as `[… tool-call, assistant message,
    // tool-output …]` next turn. A strict third-party Responses upstream
    // (Command Code: `provider/v1/responses`) rejects any `message` item wedged
    // inside a tool block with 400 `invalid_request_error` — exactly the
    // "every codex turn after a salvaged turn fails" field report. Letting the
    // message finalize first reproduces the genuine stream's item order
    // (`[… assistant message, tool-call, tool-output …]`).
    if (type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type !== 'message') return { action: 'forward' };
      const before: Array<Record<string, unknown>> = [];
      if (!suppressor.capturing) {
        const rest = suppressor.flush();
        if (rest) {
          forwardedText += rest;
          before.push({
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            delta: rest,
          });
        }
      }
      const after = replayCalls();
      const rewrittenItem = withMessageText(item, forwardedText);
      if (JSON.stringify(rewrittenItem) === JSON.stringify(item) && before.length === 0 && after.length === 0) {
        return { action: 'forward' };
      }
      return {
        action: 'emit',
        before,
        then: { json: JSON.stringify({ ...event, item: rewrittenItem }) },
        after,
      };
    }

    if (type === 'response.completed') {
      const before: Array<Record<string, unknown>> = replayCalls();
      const response = event.response as Record<string, unknown> | undefined;
      const output = response?.output;
      if (!response || !Array.isArray(output)) {
        return before.length
          ? { action: 'emit', before, then: 'forward' }
          : { action: 'forward' };
      }
      const callItems = replayedItems;
      const rewrittenOutput = output.map((item) =>
        item && typeof item === 'object' && (item as Record<string, unknown>).type === 'message'
          ? withMessageText(item as Record<string, unknown>, forwardedText)
          : item,
      );
      const newOutput = [...rewrittenOutput, ...callItems];
      if (JSON.stringify(newOutput) === JSON.stringify(output) && before.length === 0) {
        return { action: 'forward' };
      }
      return {
        action: 'emit',
        before,
        then: {
          json: JSON.stringify({ ...event, response: { ...response, output: newOutput } }),
        },
      };
    }

    if (type === 'response.failed' || type === 'response.incomplete') {
      // No point replaying calls on a failed turn; just stop holding prose.
      if (!suppressor.capturing) suppressor.flush();
    }
    return { action: 'forward' };
  };

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      let closed = false;
      const enqueue = (chunk: string) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        }
      };
      const enqueueEvent = (event: Record<string, unknown>) => {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      };

      const reader = stream.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (closed) break;
            const carriage = line.endsWith('\r') ? '\r' : '';
            const body = carriage ? line.slice(0, -1) : line;

            if (!body.startsWith('data:')) {
              enqueue(`${line}\n`);
              continue;
            }
            const payload = body.slice(5).trim();
            if (!payload || payload === '[DONE]') {
              enqueue(`${line}\n`);
              continue;
            }

            let disposition: EventDisposition = { action: 'forward' };
            try {
              disposition = handleEvent(JSON.parse(payload) as Record<string, unknown>);
            } catch {
              disposition = { action: 'forward' };
            }

            if (disposition.action === 'drop') continue;
            if (disposition.action === 'emit') {
              for (const event of disposition.before) enqueueEvent(event);
              if (disposition.then === 'forward') enqueue(`${line}\n`);
              else enqueue(`data: ${disposition.then.json}${carriage}\n`);
              if (disposition.after?.length) {
                // CLOSE THE CURRENT SSE FRAME FIRST. `enqueueEvent` writes a
                // self-contained `data: …\n\n`, but the rewritten/forwarded
                // line above ends with a single `\n` and relies on the
                // upstream's own blank separator (the next source line) to
                // finish its frame. Emitting an `after` event in between put
                // two `data:` lines in ONE frame — which the SSE spec joins
                // with a newline, so the client tried to parse
                // `{…}\n{…}` and aborted the turn on a syntax error at
                // "line 2, column 1" (codex `Failed to parse SSE event`).
                enqueue('\n');
                for (const event of disposition.after) enqueueEvent(event);
                continue;
              }
            } else if (disposition.action === 'rewrite') {
              enqueue(`data: ${disposition.json}${carriage}\n`);
            } else {
              enqueue(`${line}\n`);
            }
          }
        }
        // Truncated stream: still owe the client any held-back prose.
        if (!suppressor.capturing) {
          const rest = suppressor.flush();
          if (rest) {
            forwardedText += rest;
            enqueueEvent({
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: rest,
            });
          }
        }
      } catch (e) {
        if (!closed) controller.error(e);
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
        reader.releaseLock();
      }
    },
  });
}
