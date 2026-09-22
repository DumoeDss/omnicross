import type { JevJsonObject, LogJevSettings } from '@omnicross/contracts/logjev';

export type {
  JevJson as Json, JevJsonObject as JsonObject, JevMessage as Message,
  JevPromptMode as PromptMode, JevAnswer as Answer,
} from '@omnicross/contracts/logjev';

export type Question =
  | { type: 'choice'; instructions: string; keys: string[]; criteria: JevJsonObject }
  | { type: 'score'; instructions: string; levels: string[] }
  | { type: 'noul'; instructions: string };

export interface LogJevProvider extends LogJevSettings {
  /** Chat base URL (ending /v1), or full native System One endpoint. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
}
export interface LogJevClientOptions {
  fetch?: typeof globalThis.fetch;
}
export class LogJevError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'upstream' | 'insufficient_evidence',
    message: string,
  ) { super(message); this.name = 'LogJevError'; }
}
