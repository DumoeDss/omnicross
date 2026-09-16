/**
 * types.ts — the parsed Codex Responses-request model this bridge operates on.
 *
 * Trimmed port of codex-chatgpt-web's request types: the shapes Codex actually
 * sends on /v1/responses (message items, reasoning, function calls, tool
 * results, agent messages, compaction markers) normalized into a small
 * in-process model the prompt compiler consumes.
 *
 * @module @omnicross/chatgpt-web/bridge/types
 */

export interface CodexParsedRequest {
  modelId: string;
  context: CodexContext;
  stream: boolean;
  options: CodexRequestOptions;
  _rawBody?: unknown;
  /** True when the input carried `{type:"compaction_trigger"}` (remote compaction v2). */
  _compactionRequest?: boolean;
}

export interface CodexContext {
  systemPrompt?: string[];
  messages: CodexMessage[];
  tools?: CodexTool[];
}

export type CodexMessage =
  | CodexUserMessage
  | CodexAgentMessage
  | CodexAssistantMessage
  | CodexDeveloperMessage
  | CodexToolResultMessage;

export interface CodexUserMessage {
  role: 'user';
  content: string | CodexContentPart[];
  timestamp: number;
}

export interface CodexAgentMessage {
  role: 'agentMessage';
  author?: string;
  recipient?: string;
  content: string | CodexContentPart[];
  timestamp: number;
}

export interface CodexAssistantMessage {
  role: 'assistant';
  content: CodexAssistantContentPart[];
  phase?: CodexMessagePhase;
  model?: string;
  timestamp: number;
}

export interface CodexDeveloperMessage {
  role: 'developer';
  content: string | CodexContentPart[];
  timestamp: number;
}

export interface CodexToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  toolNamespace?: string;
  content: string | CodexContentPart[];
  isError: boolean;
  timestamp: number;
}

export interface CodexTextContent {
  type: 'text';
  text: string;
}

export interface CodexImageContent {
  type: 'image';
  /** data: URL (base64) or remote https URL — passed through verbatim, never inlined as text. */
  imageUrl: string;
  detail?: string;
}

export type CodexContentPart = CodexTextContent | CodexImageContent;

export interface CodexThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface CodexToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  namespace?: string;
}

export type CodexAssistantContentPart = CodexTextContent | CodexThinkingContent | CodexToolCall;

export interface CodexTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  namespace?: string;
  freeform?: boolean;
  toolSearch?: boolean;
}

export type CodexVerbosity = 'low' | 'medium' | 'high';

export interface CodexJsonSchemaOutputFormat {
  type: 'json_schema';
  name: string;
  strict: boolean;
  schema: unknown;
}

export interface CodexRequestOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoning?: string;
  hideThinkingSummary?: boolean;
  verbosity?: CodexVerbosity;
  outputFormat?: CodexJsonSchemaOutputFormat;
}

export type CodexMessagePhase = 'commentary' | 'final_answer';

/** The adapter-side event stream consumed by the Responses SSE encoder. */
export type BridgeEvent =
  | { type: 'heartbeat' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string; freeform?: boolean }
  | { type: 'tool_call_delta'; arguments: string }
  | { type: 'tool_call_end' }
  | { type: 'done'; usage?: BridgeUsage }
  | { type: 'incomplete'; reason: string; message?: string }
  | {
      type: 'error';
      message: string;
      status?: number;
      errorType?: string;
      code?: string;
      retryable?: boolean;
    };

export interface BridgeUsage {
  inputTokens: number;
  outputTokens: number;
  estimated?: boolean;
}
