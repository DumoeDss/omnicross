/**
 * Message Format Conversion Utilities
 *
 * Functions for converting SimpleChatMessage to different API formats.
 */

import type {
  AnthropicMessage,
  OpenAIContentPart,
  OpenAIMessage,
  SimpleChatMessage
} from '@omnicross/contracts/completion-types';

/**
 * OpenRouter-supported audio input formats (mapped from common mime types).
 * Source: https://openrouter.ai/docs/guides/overview/multimodal/audio
 */
const OPENROUTER_AUDIO_FORMAT_MAP: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/L16': 'pcm16',
  'audio/L24': 'pcm24',
};

/** Cap inline base64 video uploads at 25 MB to avoid runaway request bodies. */
const MAX_INLINE_VIDEO_BYTES = 25 * 1024 * 1024;

function decodeDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function looksLikeRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function resolveAudioFormat(mimeType: string | undefined, sourceUrl: string): string {
  const candidate = (mimeType || '').toLowerCase();
  const mapped = OPENROUTER_AUDIO_FORMAT_MAP[candidate];
  if (mapped) return mapped;
  // Fallback: try data URL prefix
  const decoded = decodeDataUrl(sourceUrl);
  if (decoded) {
    const mappedFromUrl = OPENROUTER_AUDIO_FORMAT_MAP[decoded.mimeType.toLowerCase()];
    if (mappedFromUrl) return mappedFromUrl;
  }
  throw new Error(
    `Unsupported audio format for OpenAI/OpenRouter chat input: ${mimeType || 'unknown'}. ` +
    `Supported: wav, mp3, aiff, aac, ogg, flac, m4a, pcm16, pcm24.`
  );
}

/**
 * Convert SimpleChatMessage to OpenAI-compatible format (covers OpenAI, OpenRouter,
 * and other OpenAI-compatible providers — DO NOT call from Anthropic / Gemini paths,
 * which have their own converters above).
 *
 * - Text only: { role, content: string }
 * - With media: { role, content: [{ type: "text" | "image_url" | "input_audio" | "video_url", ... }] }
 *
 * Audio is emitted as `input_audio` with base64 + format (the standard OpenAI / OpenRouter
 * shape). Video is emitted as `video_url`: HTTPS URLs pass through; local data is sent as a
 * `data:<mime>;base64,...` URL with a 25 MB cap before the request is even built.
 */
export function convertMessageToOpenAI(msg: SimpleChatMessage): OpenAIMessage {
  const role = msg.role as 'system' | 'user' | 'assistant' | 'tool';
  const hasImages = msg.images && msg.images.length > 0;
  const hasAudios = msg.audios && msg.audios.length > 0;
  const hasVideos = msg.videos && msg.videos.length > 0;
  const metadata = {
    ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
    ...(msg.name ? { name: msg.name } : {}),
    ...(msg.thinking?.content ? { reasoning_content: msg.thinking.content } : {}),
    ...(msg.toolCalls?.length ? { tool_calls: msg.toolCalls.map(tc => ({
      id: tc.id, type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    })) } : {}),
  };

  if (!hasImages && !hasAudios && !hasVideos) {
    // Text-only message
    return { role, content: msg.content, ...metadata };
  }

  // Multimodal message
  const content: OpenAIContentPart[] = [];

  // Add text content first (if any)
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  // Add images
  if (msg.images) {
    for (const img of msg.images) {
      content.push({
        type: 'image_url',
        image_url: { url: img.url }
      });
    }
  }

  // Add audios as OpenAI-standard input_audio blocks (base64 + format).
  if (msg.audios) {
    for (const audio of msg.audios) {
      const decoded = decodeDataUrl(audio.url);
      if (decoded) {
        const format = resolveAudioFormat(decoded.mimeType, audio.url);
        content.push({ type: 'input_audio', input_audio: { data: decoded.data, format } });
      } else if (audio.mimeType) {
        // Non-data URL with a known mime type — emit as input_audio with raw URL is
        // not supported by the spec, so fall back to audio_url for legacy compatibility.
        content.push({ type: 'audio_url', audio_url: { url: audio.url, format: audio.mimeType } });
      } else {
        content.push({ type: 'audio_url', audio_url: { url: audio.url } });
      }
    }
  }

  // Add videos as video_url blocks. HTTPS URLs (including YouTube) pass through verbatim.
  // Local/base64 sources stay as data URLs but enforce the 25 MB cap before send.
  if (msg.videos) {
    for (const video of msg.videos) {
      if (looksLikeRemoteUrl(video.url)) {
        content.push({ type: 'video_url', video_url: { url: video.url } });
        continue;
      }
      const decoded = decodeDataUrl(video.url);
      if (decoded) {
        const sizeBytes = Math.floor((decoded.data.length * 3) / 4);
        if (sizeBytes > MAX_INLINE_VIDEO_BYTES) {
          const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
          throw new Error(
            `Video too large for inline upload: ${sizeMb} MB exceeds the 25 MB cap. ` +
            `Use a publicly accessible HTTPS URL instead.`
          );
        }
        content.push({ type: 'video_url', video_url: { url: video.url } });
      } else {
        // Unrecognized URL form — pass through as-is and let the upstream reject.
        content.push({ type: 'video_url', video_url: { url: video.url } });
      }
    }
  }

  return { role, content, ...metadata };
}

/**
 * Convert SimpleChatMessage to Anthropic format (with vision support)
 * Anthropic format:
 * - Text only: { role, content: string }
 * - With images: { role, content: [{ type: "text", text: "..." }, { type: "image", source: { type: "base64", media_type: "...", data: "..." } }] }
 */
export function convertMessageToAnthropic(msg: SimpleChatMessage): AnthropicMessage {
  if (msg.providerMetadata?.apiFormat === 'anthropic' && (msg.role === 'assistant' || msg.role === 'tool')) {
    return { role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.providerMetadata.content as unknown as AnthropicMessage['content'] };
  }
  if (msg.role === 'tool') {
    if (!msg.toolCallId) throw new Error('Tool result requires toolCallId');
    return { role: 'user', content: [{
      type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content,
      ...(msg.isError !== undefined ? { is_error: msg.isError } : {}),
    }] };
  }
  if (msg.audios?.length || msg.videos?.length) {
    throw new Error('Anthropic Messages does not support audio or video input');
  }
  const role = (msg.role === 'system' ? 'user' : msg.role) as 'user' | 'assistant';
  const hasImages = msg.images && msg.images.length > 0;
  const hasAudios = msg.audios && msg.audios.length > 0;

  if (!hasImages && !hasAudios && !msg.toolCalls?.length && !msg.thinking?.content && !msg.thinking?.blocks?.length) {
    return { role, content: msg.content };
  }

  // Multimodal message
  const content: Exclude<AnthropicMessage['content'], string> = [];
  if (msg.thinking?.blocks?.length) {
    content.push(...msg.thinking.blocks);
  } else if (msg.thinking?.content) {
    content.push({ type: 'thinking', thinking: msg.thinking.content, signature: msg.thinking.signature });
  }

  // Add text content first (if any)
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  // Add images
  if (msg.images) {
    for (const img of msg.images) {
      if (looksLikeRemoteUrl(img.url)) {
        content.push({ type: 'image', source: { type: 'url', url: img.url } });
        continue;
      }
      let base64Data = img.url;
      let mediaType = img.mimeType || 'image/jpeg';

      if (img.url.startsWith('data:')) {
        const match = img.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mediaType = match[1];
          base64Data = match[2];
        }
      }

      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64Data }
      });
    }
  }

  for (const call of msg.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
  }

  return { role, content };
}

/**
 * Minimal Gemini part shape for the simple-chat DIRECT path (text + inline
 * media only), serialized with the official REST JSON casing
 * (`inlineData` / `mimeType`).
 *
 * NOT the same wire model as the transformer pipeline's full `GeminiPart`
 * union in `transformer/transformers/utils/gemini.util.ts` (function calls /
 * file data, snake_case alias keys). The two paths intentionally serialize
 * differently — do not merge them blindly.
 */
export interface SimpleChatGeminiPart {
  text?: string;
  fileData?: { mimeType: string; fileUri: string };
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

/** Gemini message for the simple-chat direct path. */
export interface SimpleChatGeminiMessage {
  role: string;
  parts: SimpleChatGeminiPart[];
}

/**
 * Convert SimpleChatMessage to Gemini format (with vision support)
 * Gemini format:
 * - { role: "user"|"model", parts: [{ text: "..." }, { inlineData: { mimeType: "...", data: "..." } }] }
 */
export function convertMessageToGemini(msg: SimpleChatMessage): SimpleChatGeminiMessage {
  if (msg.providerMetadata?.apiFormat === 'google' && (msg.role === 'assistant' || msg.role === 'tool')) {
    return { role: msg.role === 'assistant' ? 'model' : 'user', parts: msg.providerMetadata.content as SimpleChatGeminiPart[] };
  }
  if (msg.role === 'tool') {
    if (!msg.name) throw new Error('Gemini tool result requires the function name');
    return { role: 'user', parts: [{ functionResponse: {
      ...(msg.toolCallId ? { id: msg.toolCallId } : {}), name: msg.name, response: { result: msg.content },
    } }] };
  }
  const role = msg.role === 'assistant' ? 'model' : msg.role;
  const parts: SimpleChatGeminiPart[] = [];

  // Add text content first (if any)
  if (msg.content) {
    parts.push({ text: msg.content });
  }

  // Add images
  if (msg.images && msg.images.length > 0) {
    for (const img of msg.images) {
      if (looksLikeRemoteUrl(img.url)) {
        parts.push({ fileData: { mimeType: img.mimeType || 'image/jpeg', fileUri: img.url } });
        continue;
      }
      let base64Data = img.url;
      let mimeType = img.mimeType || 'image/jpeg';

      if (img.url.startsWith('data:')) {
        const match = img.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64Data = match[2];
        }
      }

      parts.push({ inlineData: { mimeType, data: base64Data } });
    }
  }

  // Add audios
  if (msg.audios && msg.audios.length > 0) {
    for (const audio of msg.audios) {
      if (looksLikeRemoteUrl(audio.url)) {
        parts.push({ fileData: { mimeType: audio.mimeType, fileUri: audio.url } });
        continue;
      }
      let base64Data = audio.url;
      let mimeType = audio.mimeType || 'audio/wav';

      if (audio.url.startsWith('data:')) {
        const match = audio.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64Data = match[2];
        }
      }

      parts.push({ inlineData: { mimeType, data: base64Data } });
    }
  }
  for (const video of msg.videos ?? []) {
    const decoded = decodeDataUrl(video.url);
    parts.push(decoded ? { inlineData: decoded } : { fileData: { mimeType: video.mimeType, fileUri: video.url } });
  }
  for (const call of msg.toolCalls ?? []) {
    parts.push({ functionCall: { id: call.id, name: call.name, args: call.args } });
  }

  return { role, parts };
}

/** Encode Responses history including function results and native reasoning replay. */
export function convertMessagesToResponses(messages: SimpleChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const native = msg.role === 'assistant' && msg.providerMetadata?.apiFormat === 'openai-response'
      ? msg.providerMetadata.content : undefined;
    if (native) input.push(...native);
    if (msg.role === 'tool') {
      if (!msg.toolCallId) throw new Error('Responses tool result requires toolCallId');
      input.push({ type: 'function_call_output', call_id: msg.toolCallId, output: msg.content });
      continue;
    }
    if (msg.audios?.length || msg.videos?.length) {
      throw new Error('Responses input cannot encode these audio/video attachments');
    }
    const content: Array<Record<string, unknown>> = [];
    if (msg.content) content.push({ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: msg.content });
    for (const image of msg.images ?? []) content.push({ type: 'input_image', image_url: image.url });
    if (content.length && !native?.some(item => item.type === 'message')) {
      input.push({ role: msg.role === 'system' ? 'developer' : msg.role, content });
    }
    for (const call of native?.some(item => item.type === 'function_call') ? [] : msg.toolCalls ?? []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
    }
  }
  return input;
}

/** Keep all parallel function responses in the same Gemini user turn. */
export function convertMessagesToGemini(messages: SimpleChatMessage[]): {
  contents: SimpleChatGeminiMessage[];
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const contents: SimpleChatGeminiMessage[] = [];
  const systemParts: Array<{ text: string }> = [];
  let previousWasTool = false;
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push({ text: message.content });
      continue;
    }
    const converted = convertMessageToGemini(message);
    if (message.role === 'tool' && previousWasTool) contents[contents.length - 1].parts.push(...converted.parts);
    else contents.push(converted);
    previousWasTool = message.role === 'tool';
  }
  return { contents, ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}) };
}
