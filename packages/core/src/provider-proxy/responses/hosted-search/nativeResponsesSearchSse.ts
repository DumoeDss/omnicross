/**
 * SSE synthesis for the managed Responses search lane.
 *
 * **Everything this module emits is OMNICROSS's own shape.** The live upstream
 * `response.web_search_call.*` sequence is UNVERIFIED — a structural scan of
 * all 444 audit body shards found zero `web_search_call` payloads (wire
 * baseline §2.2) — so there is nothing to copy and nothing here may be
 * described as upstream-compatible. The golden fixtures pin these events so
 * they cannot change unnoticed; they are not evidence about OpenAI.
 *
 * What IS carried over is the ENVELOPE discipline the hosted-image SSE module
 * established: one monotonically increasing `sequence_number` across the whole
 * stream, `output_index` matching the item's position in `response.output`, and
 * a terminal `response.completed` whose `response.output` equals the items that
 * were announced.
 *
 * @module provider-proxy/responses/hosted-search/nativeResponsesSearchSse
 */

/** A synthesized SSE stream over an already-final Responses payload. */
export interface NativeResponsesSearchSseInput {
  /** The final response object, with managed search items already spliced in. */
  readonly response: Record<string, unknown>;
  /** Headers to carry onto the synthesized SSE response. */
  readonly upstream: Response;
}

function frame(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Render a completed Responses payload as an event stream.
 *
 * The managed lane always has the whole answer before it emits anything (the
 * upstream turn is not streamed — see the mediator), so this is a projection,
 * not a transform: `created` -> `in_progress` -> per-item added/done ->
 * `completed`. Search items additionally get the `response.web_search_call.*`
 * lifecycle a hosted search would be expected to report.
 */
export function renderNativeResponsesSearchSse(input: NativeResponsesSearchSseInput): string {
  const response = input.response;
  const output = Array.isArray(response.output) ? response.output : [];
  let sequence = 0;
  const next = (): number => sequence++;
  const chunks: string[] = [];
  const emit = (event: Record<string, unknown>): void => {
    chunks.push(frame({ ...event, sequence_number: next() }));
  };

  const skeleton = { ...response, output: [], status: 'in_progress' };
  emit({ type: 'response.created', response: skeleton });
  emit({ type: 'response.in_progress', response: skeleton });

  for (let index = 0; index < output.length; index += 1) {
    const item = output[index] as Record<string, unknown> | undefined;
    if (!item) continue;
    emit({ type: 'response.output_item.added', output_index: index, item });
    if (item.type === 'web_search_call') {
      const itemId = typeof item.id === 'string' ? item.id : '';
      emit({ type: 'response.web_search_call.in_progress', output_index: index, item_id: itemId });
      emit({ type: 'response.web_search_call.searching', output_index: index, item_id: itemId });
      // The terminal event follows the ITEM's status. Reporting `.completed`
      // over an item that says `status: 'failed'` would make the stream
      // disagree with the payload it is streaming — and since the whole
      // sequence is ours, there is no vendor shape forcing that inconsistency.
      emit({
        type: item.status === 'failed'
          ? 'response.web_search_call.failed'
          : 'response.web_search_call.completed',
        output_index: index,
        item_id: itemId,
      });
    }
    emit({ type: 'response.output_item.done', output_index: index, item });
  }

  emit({ type: 'response.completed', response });
  return chunks.join('');
}

/** Wrap a rendered stream as a `Response` the shared relay will treat as SSE. */
export function nativeResponsesSearchSseResponse(
  input: NativeResponsesSearchSseInput,
): Response {
  const headers = new Headers(input.upstream.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  return new Response(renderNativeResponsesSearchSse(input), {
    status: input.upstream.status,
    statusText: input.upstream.statusText,
    headers,
  });
}
