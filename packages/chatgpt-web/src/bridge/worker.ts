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

import { randomBytes } from 'node:crypto';
import { CdpConnection } from '../cdp/connection';
import { runChatGptWebTurn } from '../chatgpt/turn';
import { HarnessBrowserTurn } from '../chatgpt/harnessTurn';
import { inspectChatGptSession } from '../chatgpt/session';
import { TurnBroker } from '../tunnel/broker';
import type { HarnessConfig } from '../tunnel/harnessConfig';
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
  /** Full-harness configuration; absent ⇒ browser-only turns. */
  harness?: HarnessConfig;
}

export class ChatGptWebBridgeWorker {
  readonly connection: CdpConnection;
  private capabilities: ChatGptWebAccountCapabilities | null = null;
  private capabilitiesProbing: Promise<ChatGptWebAccountCapabilities> | null = null;
  private readonly activeRuns = new Set<Promise<unknown>>();
  /** Full-harness state: the broker and the single live parked turn. */
  readonly broker = new TurnBroker();
  private liveHarnessTurn: HarnessBrowserTurn | null = null;
  private harnessBusy = false;

  constructor(private readonly options: ChatGptWebWorkerOptions = {}) {
    this.connection = new CdpConnection({ explicitPort: options.cdpPort });
  }

  get harnessEnabled(): boolean {
    return this.options.harness !== undefined;
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
    if (this.options.harness) {
      yield* this.runHarnessRequest(parsed, abortSignal);
      return;
    }
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

  /**
   * Full-harness request flow.
   *
   * Continuation detection: a follow-up Codex request whose history carries
   * function_call_output items matching this turn's parked call ids resolves
   * those calls (unblocking the MCP response to ChatGPT) and resumes
   * streaming the SAME browser turn. Any other request with a live parked
   * turn is rejected explicitly (one harness turn at a time).
   */
  private async *runHarnessRequest(
    parsed: CodexParsedRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<BridgeEvent> {
    const live = this.liveHarnessTurn;
    if (live) {
      const outputs = parsed.context.messages.filter(
        (message) => message.role === 'toolResult' && live.pendingCalls.some((call) => call.callId === message.toolCallId),
      );
      if (outputs.length > 0) {
        for (const output of outputs) {
          if (output.role !== 'toolResult') continue;
          live.resolveToolCall(output.toolCallId, typeof output.content === 'string' ? output.content : '', output.isError);
        }
        this.harnessBusy = false;
        yield* live.stream();
        if (!live.pendingCalls.length) {
          await live.dispose();
          this.liveHarnessTurn = null;
          this.broker.unregisterTurn(live.turnToken);
        }
        return;
      }
      if (this.harnessBusy) {
        throw Object.assign(
          new Error(
            'A full-harness ChatGPT turn is still waiting for its tool results; finish or interrupt it before starting another task.',
          ),
          { status: 429 },
        );
      }
      // Stale live turn without pending calls — retire it.
      await live.dispose();
      this.broker.unregisterTurn(live.turnToken);
      this.liveHarnessTurn = null;
    }

    const route = await this.resolveRoute(parsed.modelId);
    const harness = this.options.harness!;
    // The token MUST exist before the prompt is compiled — the model copies
    // it into every Codex Native call and the broker routes on it.
    const turnToken = `turn_${randomBytes(16).toString('hex')}`;
    const prompt = compileChatGptWebPrompt(parsed, route, {
      localTools: { turnToken, connectorName: harness.connectorName },
    });
    this.harnessBusy = true;
    try {
      const turn = await HarnessBrowserTurn.start(this.connection, {
        promptText: prompt.text,
        images: prompt.images,
        route,
        turnToken,
        connectorName: harness.connectorName,
        onDiagnostic: this.options.onDiagnostic,
      });
      this.liveHarnessTurn = turn;
      this.broker.registerTurn(turnToken, {
        onToolRequest: (request) => turn.enqueueToolRequest(request),
      });
      yield* turn.stream();
      if (!turn.pendingCalls.length) {
        await turn.dispose();
        this.liveHarnessTurn = null;
      } else {
        this.harnessBusy = false;
      }
    } catch (error) {
      this.harnessBusy = false;
      if (this.liveHarnessTurn) {
        await this.liveHarnessTurn.dispose().catch(() => undefined);
        this.liveHarnessTurn = null;
      }
      throw error;
    }
  }
}
