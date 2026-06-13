/**
 * @module completion-types/simple-chat
 *
 * Provider-neutral SimpleChat types used by simple UI chat flows (single
 * provider, single model) — image / audio / video attachments + message
 * + session shapes.
 */

import type { MessageBlock } from '../message-blocks';

import type { ThinkingContent } from './thinking';

/** Image attachment for multimodal messages */
export interface SimpleChatImage {
  /** Base64 data URL (e.g., data:image/png;base64,...) or HTTP URL */
  url: string;
  /** MIME type (e.g., image/png, image/jpeg) */
  mimeType?: string;
}

/** Audio attachment for multimodal messages */
export interface SimpleChatAudio {
  /** Base64 data URL (e.g., data:audio/wav;base64,...) or file path */
  url: string;
  /** MIME type (e.g., audio/wav, audio/mp3) */
  mimeType: string;
  /** Audio duration in seconds */
  duration?: number;
  /** File size in bytes */
  size?: number;
}

/** Video attachment for multimodal messages */
export interface SimpleChatVideo {
  /** Base64 data URL (e.g., data:video/mp4;base64,...) or HTTP URL */
  url: string;
  /** MIME type (e.g., video/mp4, video/webm) */
  mimeType: string;
  /** Video duration in seconds */
  duration?: number;
  /** File size in bytes */
  size?: number;
  /** Thumbnail image URL */
  thumbnail?: string;
}

export interface SimpleChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  /** Thinking/reasoning content with optional cryptographic signature */
  thinking?: ThinkingContent;
  /** Image attachments for vision/multimodal messages */
  images?: SimpleChatImage[];
  /** Audio attachments for multimodal messages */
  audios?: SimpleChatAudio[];
  /** Video attachments for multimodal messages */
  videos?: SimpleChatVideo[];
  /** Structured content blocks for multi-turn tool calls */
  blocks?: MessageBlock[];
  /** Tool call ID — present when role is 'tool' (result of a tool invocation) */
  toolCallId?: string;
  /** Tool or function name */
  name?: string;
  /** Tool calls requested by the assistant */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

export interface SimpleChatSession {
  id: string;
  title: string;
  messages: SimpleChatMessage[];
  providerId: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}
