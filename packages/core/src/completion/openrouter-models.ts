/**
 * OpenRouter `/api/v1/models` discovery helper.
 *
 * Used by the multimodal subsystems (image / music / asr / tts) to refresh their
 * model lists from the OpenRouter catalog, filtered by `output_modalities`.
 * Video uses a dedicated `/api/v1/videos/models` endpoint (see video/adapters/openrouter.ts).
 */

import {
  buildOpenRouterHeaders,
  buildOpenRouterUrl,
  type OpenRouterCredentialFields,
} from './openrouter-headers';

export interface OpenRouterRawModel {
  id: string;
  name?: string;
  description?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  context_length?: number;
  pricing?: Record<string, unknown>;
}

/**
 * Fetch the OpenRouter model catalog filtered by output modality.
 *
 * @param outputModality — `image` | `audio` | `transcription` | `speech` (per OpenRouter docs)
 */
export async function fetchOpenRouterModels(
  credentials: OpenRouterCredentialFields,
  outputModality: string,
): Promise<OpenRouterRawModel[]> {
  const headers = buildOpenRouterHeaders(credentials);
  const url = buildOpenRouterUrl(
    credentials.endpoint,
    `/models?output_modalities=${encodeURIComponent(outputModality)}`,
  );

  const response = await fetch(url, { method: 'GET', headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message || parsed?.message || message;
    } catch {
      // ignore
    }
    throw new Error(`OpenRouter /models failed (${response.status}): ${message}`);
  }

  const data = (await response.json()) as { data?: OpenRouterRawModel[] };
  return data?.data ?? [];
}
