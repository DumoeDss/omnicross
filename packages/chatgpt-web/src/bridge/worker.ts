/**
 * worker.ts — orchestrate ChatGPT Web turns behind the Responses bridge.
 *
 * Owns the single CDP connection, a cached account-capability probe, and the
 * five-tab concurrency cap. Each request compiles its prompt, validates the
 * route against the probed capabilities, and runs one fresh temporary-chat
 * turn whose events stream back to the SSE encoder. A route rejection
 * refreshes the capability cache once before failing explicitly.
 *
 * @module @omnicross/chatgpt-web/bridge/worker
 */

import { CdpConnection } from '../cdp/connection';
import { runChatGptWebTurn } from '../chatgpt/turn';
import { inspectChatGptSession } from '../chatgpt/session';
import {
  availableChatGptWebModelRoutes,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebAccountCapabilities,
  type ChatGptWebModelRoute,
} from './models';
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from './prompt';
import type { BridgeEvent, CodexParsedRequest } from './types';

export const MAX_CHATGPT_BROWSER_TABS = 5;

export class ChatGptWebCapacityError extends Error {
  constructor() {
    super(
      `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; wait for a running turn to finish`,
    );
    this.name = 'ChatGptWebCapacityError';
  }
}

export interface ChatGptWebWorkerOptions {
  cdpPort?: number;
  onDiagnostic?: (checkpoint: string) => void;
}

export class ChatGptWebBridgeWorker {
  readonly connection: CdpConnection;
  private capabilities: ChatGptWebAccountCapabilities | null = null;
  private capabilitiesProbing: Promise<ChatGptWebAccountCapabilities> | null = null;
  private readonly activeRuns = new Set<Promise<unknown>>();

  constructor(private readonly options: ChatGptWebWorkerOptions = {}) {
    this.connection = new CdpConnection({ explicitPort: options.cdpPort });
  }

  /** Probed capabilities (cached; re-probes when `force`). */
  async getCapabilities(force = false): Promise<ChatGptWebAccountCapabilities> {
    if (!force && this.capabilities) return this.capabilities;
    this.capabilitiesProbing ??= inspectChatGptSession(this.connection, { detectCapabilities: true })
      .then((inspection) => {
        if (!inspection.authenticated || !inspection.capabilities) {
          throw Object.assign(
            new Error(inspection.detail ?? 'ChatGPT session is not authenticated'),
            { status: 401 },
          );
        }
        this.capabilities = inspection.capabilities;
        return inspection.capabilities;
      })
      .finally(() => {
        this.capabilitiesProbing = null;
      });
    return this.capabilitiesProbing;
  }

  /** Routes visible under the (cached) account capabilities. */
  async listRoutes(): Promise<readonly ChatGptWebModelRoute[]> {
    return availableChatGptWebModelRoutes(await this.getCapabilities());
  }

  /** Resolve a model id to its route, refreshing capabilities once on rejection. */
  async resolveRoute(modelId: string): Promise<ChatGptWebModelRoute> {
    if (!isChatGptWebModelSlug(modelId)) {
      throw Object.assign(
        new Error(
          `This bridge serves only chatgpt-web/* models (got "${modelId}"). Point the provider's other models at their own upstream.`,
        ),
        { status: 400 },
      );
    }
    const attempt = (capabilities: ChatGptWebAccountCapabilities) => requireChatGptWebModelRoute(modelId, capabilities);
    const capabilities = await this.getCapabilities();
    try {
      return attempt(capabilities);
    } catch (error) {
      if (capabilities) {
        // The probe may be stale (plan change, Pro temporarily hidden) — refresh once.
        const refreshed = await this.getCapabilities(true);
        return attempt(refreshed);
      }
      throw error;
    }
  }

  /**
   * Run one request's browser turn as an event stream. The read-only
   * capability warning leads as a reasoning summary so it renders in Codex
   * without polluting the assistant answer.
   */
  async *runRequest(
    parsed: CodexParsedRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<BridgeEvent> {
    if (this.activeRuns.size >= MAX_CHATGPT_BROWSER_TABS) {
      throw new ChatGptWebCapacityError();
    }
    const route = await this.resolveRoute(parsed.modelId);
    const prompt = compileChatGptWebPrompt(parsed, route);
    yield { type: 'thinking_delta', thinking: chatGptReadOnlyContextWarning(route) };
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.activeRuns.add(completion);
    try {
      for await (const event of runChatGptWebTurn(this.connection, {
        prompt,
        route,
        abortSignal,
        onDiagnostic: this.options.onDiagnostic,
      })) {
        yield event;
      }
    } finally {
      release();
      this.activeRuns.delete(completion);
    }
  }
}
