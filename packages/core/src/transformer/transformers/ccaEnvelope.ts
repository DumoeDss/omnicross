/**
 * ccaEnvelope — the SHARED Cloud Code Assist wire components used by BOTH the
 * gemini-cli subscription transformer (`cloudcode-pa`, `GeminiCodeAssistTransformer`)
 * and the antigravity subscription transformer (`daily-cloudcode-pa`,
 * `AntigravityTransformer`).
 *
 * The two upstreams share one wire: a colon-method URL
 * (`${base}/${version}:${method}`, NO `/models/<model>` segment — the model
 * rides the body), and a response envelope that nests the standard
 * `GenerateContentResponse` under a top-level `response` key (both the
 * non-stream JSON body and every SSE `data:` chunk). Extracted from
 * `GeminiCodeAssistTransformer` verbatim (antigravity-subscription-provider
 * design D2) so the gemini path stays byte-equivalent while the antigravity
 * transformer consumes the same peeling/URL logic.
 *
 * @module transformer/transformers/ccaEnvelope
 */

/**
 * Peel the Code Assist top-level `response` envelope. Used for both the
 * non-stream JSON body and each SSE `data:` chunk. A chunk that is already
 * unwrapped (no `.response`) is passed through unchanged so the parser stays
 * robust to either shape.
 */
export function peelCcaResponseEnvelope(parsed: unknown): unknown {
  if (parsed && typeof parsed === 'object' && 'response' in parsed && !('error' in parsed)) {
    const inner = (parsed as Record<string, unknown>).response;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
      throw new Error('Invalid Code Assist response envelope');
    }
    return inner;
  }
  return parsed;
}

/**
 * Wrap a Code Assist Response so the body/each-SSE-chunk is unwrapped from
 * `.response` BEFORE the shared gemini parser sees it. Returns a fresh
 * Response with the same content-type so `transformResponseOut` dispatches to
 * the right (json vs stream) handler.
 */
export async function unwrapCcaResponse(response: Response): Promise<Response> {
  return mapCcaResponse(response, peelCcaResponseEnvelope);
}

/** Encode the same envelope for JSON responses and complete SSE events. */
export async function wrapCcaResponse(response: Response): Promise<Response> {
  return mapCcaResponse(response, (parsed) =>
    parsed && typeof parsed === 'object' && 'error' in parsed ? parsed : { response: parsed });
}

async function mapCcaResponse(
  response: Response,
  mapPayload: (parsed: unknown) => unknown,
): Promise<Response> {
  const contentType = response.headers.get('Content-Type') ?? '';
  const headers = new Headers(response.headers);
  // The re-encoded bytes no longer have the upstream length or compression.
  headers.delete('content-length');
  headers.delete('content-encoding');
  const init = { status: response.status, statusText: response.statusText, headers };

  if (contentType.includes('stream')) {
    if (!response.body) return response;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let lines: string[] = [];
    const emitEvent = (controller: TransformStreamDefaultController<Uint8Array>) => {
      const data = lines.filter((line) => line.startsWith('data:'));
      if (data.length > 0) {
        const payload = data.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (payload.trim() && payload.trim() !== '[DONE]') {
          const mapped = `data: ${JSON.stringify(mapPayload(JSON.parse(payload)))}`;
          let emitted = false;
          lines = lines.flatMap((line) => {
            if (!line.startsWith('data:')) return [line];
            if (emitted) return [];
            emitted = true;
            return [mapped];
          });
        }
      }
      controller.enqueue(encoder.encode(`${lines.join('\n')}\n\n`));
      lines = [];
    };
    const drain = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
      let start = 0;
      for (let index = 0; index < buffer.length; index++) {
        const char = buffer[index];
        if (char !== '\r' && char !== '\n') continue;
        if (char === '\r' && index === buffer.length - 1 && !final) break;
        const line = buffer.slice(start, index);
        if (char === '\r' && buffer[index + 1] === '\n') index++;
        start = index + 1;
        if (line === '') emitEvent(controller);
        else lines.push(line);
      }
      buffer = buffer.slice(start);
      if (final) {
        if (buffer) lines.push(buffer);
        if (lines.length > 0) emitEvent(controller);
      }
    };
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        drain(controller, false);
      },
      flush(controller) {
        buffer += decoder.decode();
        drain(controller, true);
      },
    }));
    return new Response(body, init);
  }

  // Preserve non-JSON HTTP failures verbatim rather than replacing them with null.
  if (!response.ok && !contentType.includes('json')) return response;
  return new Response(JSON.stringify(mapPayload(await response.json())), init);
}

/**
 * Build a Code Assist method URL: `${base}/${version}:${method}`.
 * NOTE: no `/models/<model>` segment — the model goes in the body. `stream`
 * selects `streamGenerateContent?alt=sse` vs `generateContent`.
 */
export function buildCcaMethodUrl(base: string, version: string, stream: boolean): string {
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${base}/${version}:${method}`;
}
