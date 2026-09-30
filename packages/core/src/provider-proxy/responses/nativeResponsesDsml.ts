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
  type CodexToolDeclarations,
} from '../../transformer/transformers/OpenAIResponseTransformer';

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

/** All declared flattened names — for `__`-suffix name resolution. */
function declaredNames(declarations: CodexToolDeclarations): string[] {
  return [
    ...new Set([...declarations.customToolNames, ...Object.keys(declarations.toolNamespaces)]),
  ];
}

/**
 * Resolve a name the model wrote to the declared flattened name it means.
 *
 * The upstream may have rebuilt declarations (dropping our `functions__`
 * prefix), so `exec` must find `functions__exec`. A bare inner name mapping to
 * MORE than one declaration is ambiguous and stays unresolved — encoding it
 * as-is at least fails loudly instead of dispatching the wrong tool.
 */
export function resolveDeclaredName(name: string, declarations: CodexToolDeclarations): string {
  const declared = declaredNames(declarations);
  if (declared.includes(name)) return name;
  const suffixMatches = declared.filter((entry) => entry.endsWith(`__${name}`));
  return suffixMatches.length === 1 ? suffixMatches[0] : name;
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

/** Set every `output_text` part of a message item to one text. */
function withMessageText(
  item: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  const content = Array.isArray(item.content) ? item.content : [];
  const rewritten = content.map((part) => {
    if (
      part &&
      typeof part === 'object' &&
      (part as Record<string, unknown>).type === 'output_text'
    ) {
      return { ...(part as Record<string, unknown>), text };
    }
    return part;
  });
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
    for (const part of record.content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.type !== 'output_text' || typeof p.text !== 'string') continue;
      const salvaged = salvageDsmlToolCalls(p.text);
      if (!salvaged.sawMarkup) continue;
      calls.push(...salvagedCallItems(p.text, declarations));
      p.text = salvaged.cleaned;
      changed = true;
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
 * - `emit` — send these NEW events before the original (synthesized tool-call
 *   lifecycle events ahead of a finalized message/turn item).
 */
type EventDisposition =
  | { action: 'forward' }
  | { action: 'drop' }
  | { action: 'rewrite'; json: string }
  | { action: 'emit'; before: Array<Record<string, unknown>>; then: 'forward' | { json: string } };

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
      before.push(...replayCalls());
      const rewrittenItem = withMessageText(item, forwardedText);
      if (JSON.stringify(rewrittenItem) === JSON.stringify(item) && before.length === 0) {
        return { action: 'forward' };
      }
      return {
        action: 'emit',
        before,
        then: { json: JSON.stringify({ ...event, item: rewrittenItem }) },
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
