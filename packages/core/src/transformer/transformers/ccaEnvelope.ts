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
  if (parsed && typeof parsed === 'object' && 'response' in (parsed as Record<string, unknown>)) {
    return (parsed as Record<string, unknown>).response;
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
  const contentType = response.headers.get('Content-Type') ?? '';

  // Streaming: peel each `data:` line's `.response`.
  if (contentType.includes('stream') || contentType.includes('text/event-stream')) {
    const sourceBody = response.body;
    if (!sourceBody) return response;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const peeled = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = sourceBody.getReader();
        let buffer = '';
        const processLine = (line: string) => {
          if (!line.startsWith('data:')) {
            // Forward non-data lines (blank separators, comments) verbatim.
            if (line.length > 0) controller.enqueue(encoder.encode(`${line}\n`));
            return;
          }
          const payload = line.slice(line.indexOf(':') + 1).trim();
          if (!payload || payload === '[DONE]') {
            controller.enqueue(encoder.encode(`${line}\n`));
            return;
          }
          try {
            const parsed = JSON.parse(payload);
            const inner = peelCcaResponseEnvelope(parsed);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(inner)}\n`));
          } catch {
            // Unparseable chunk — forward verbatim so the downstream parser logs it.
            controller.enqueue(encoder.encode(`${line}\n`));
          }
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer) processLine(buffer);
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) processLine(line);
          }
        } catch (err) {
          controller.error(err);
        } finally {
          controller.close();
        }
      },
    });
    return new Response(peeled, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Non-stream JSON: read, peel `.response`, re-serialize.
  const raw = await response.json().catch(() => null);
  const inner = peelCcaResponseEnvelope(raw);
  return new Response(JSON.stringify(inner), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
