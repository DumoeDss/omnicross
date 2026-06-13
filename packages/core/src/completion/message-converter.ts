/**
 * Message Format Conversion Utilities
 *
 * Functions for converting SimpleChatMessage to different API formats.
 */

import type {
  AnthropicAudioContent,
  AnthropicImageContent,
  AnthropicMessage,
  AnthropicTextContent,
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

  if (!hasImages && !hasAudios && !hasVideos) {
    // Text-only message
    return { role, content: msg.content };
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

  return { role, content };
}

/**
 * Convert SimpleChatMessage to Anthropic format (with vision support)
 * Anthropic format:
 * - Text only: { role, content: string }
 * - With images: { role, content: [{ type: "text", text: "..." }, { type: "image", source: { type: "base64", media_type: "...", data: "..." } }] }
 */
export function convertMessageToAnthropic(msg: SimpleChatMessage): AnthropicMessage {
  const role = (msg.role === 'system' ? 'user' : msg.role) as 'user' | 'assistant';
  const hasImages = msg.images && msg.images.length > 0;
  const hasAudios = msg.audios && msg.audios.length > 0;

  if (!hasImages && !hasAudios) {
    // Text-only message
    return { role, content: msg.content };
  }

  // Multimodal message
  const content: (AnthropicTextContent | AnthropicImageContent | AnthropicAudioContent)[] = [];

  // Add text content first (if any)
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  // Add images
  if (msg.images) {
    for (const img of msg.images) {
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

  // Add audios
  if (msg.audios) {
    for (const audio of msg.audios) {
      let base64Data = audio.url;
      let mediaType = audio.mimeType || 'audio/wav';

      if (audio.url.startsWith('data:')) {
        const match = audio.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mediaType = match[1];
          base64Data = match[2];
        }
      }

      content.push({
        type: 'audio',
        source: { type: 'base64', media_type: mediaType, data: base64Data }
      });
    }
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
  const role = msg.role === 'assistant' ? 'model' : msg.role;
  const parts: SimpleChatGeminiPart[] = [];

  // Add text content first (if any)
  if (msg.content) {
    parts.push({ text: msg.content });
  }

  // Add images
  if (msg.images && msg.images.length > 0) {
    for (const img of msg.images) {
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

  return { role, parts };
}
