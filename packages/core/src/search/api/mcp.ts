import { SearchProviderError } from '@omnicross/contracts/search-types';

import { invalidSearchPayload, recordOf } from './keylessSupport';
import { sanitizeUpstreamText } from './transport';
import type { SearchApiRequest, SearchApiTransport } from './types';

let nextRequestId = 0;

/** Stateless hosted search MCP tools accept direct tools/call over Streamable HTTP. */
export async function callSearchMcp(
  transport: SearchApiTransport,
  request: Omit<SearchApiRequest, 'method' | 'jsonBody' | 'responseMode'>,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `search-${++nextRequestId}`;
  const raw = await transport({
    ...request,
    method: 'POST',
    headers: { ...request.headers, Accept: 'application/json, text/event-stream' },
    responseMode: 'text',
    jsonBody: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } },
  });
  const messages: unknown[] = [];
  if (typeof raw === 'string') {
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    try {
      messages.push(JSON.parse(text));
    } catch {
      for (const frame of text.split(/\n\n+/)) {
        const data = frame.split('\n').filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          messages.push(JSON.parse(data));
        } catch {
          throw invalidSearchPayload(request.providerId, request.label);
        }
      }
    }
  } else {
    // Supports injected transports returning already-decoded JSON, too.
    messages.push(raw);
  }
  for (const message of messages) {
    const envelope = recordOf(message);
    if (envelope?.jsonrpc !== '2.0' || envelope.id !== id) continue;
    const error = recordOf(envelope.error);
    if (error) {
      throw mcpFailure(request, error.message, 'MCP request failed');
    }
    const result = recordOf(envelope.result);
    if (!result) throw invalidSearchPayload(request.providerId, request.label);
    if (result.isError === true) {
      const text = mcpTextBlocks(result)[0];
      throw mcpFailure(request, text, 'MCP tool failed');
    }
    return result;
  }
  throw invalidSearchPayload(request.providerId, request.label);
}

function mcpFailure(
  request: Pick<SearchApiRequest, 'providerId' | 'label' | 'secrets'>,
  message: unknown,
  fallback: string,
): SearchProviderError {
  const detail = typeof message === 'string' ? sanitizeUpstreamText(message, request.secrets) : '';
  return new SearchProviderError('upstream_unavailable', `${request.label}: ${detail || fallback}`, {
    providerId: request.providerId,
    retryable: false,
    details: { transport: 'undici', stage: 'parse' },
  });
}

export function mcpTextBlocks(result: Record<string, unknown>): string[] {
  if (!Array.isArray(result.content)) return [];
  return result.content.flatMap((value) => {
    const part = recordOf(value);
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
  });
}

/** Structured content and JSON text blocks are both legal MCP tool results. */
export function mcpPayloads(result: Record<string, unknown>): unknown[] {
  const candidates = [result.structuredContent, result.data, result];
  for (const text of mcpTextBlocks(result)) {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      // Exa additionally has a documented human-readable source format.
    }
  }
  return candidates;
}
