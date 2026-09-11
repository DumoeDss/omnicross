/**
 * harnessTurn.ts — full-harness browser turns with the local-tool loop.
 *
 * Phase 1 (new request): open the temporary chat, attach the connector via an
 * @-mention, select the effort, insert the prompt (which carries the broker
 * turn token), send, and stream. When ChatGPT calls a Codex Native tool, the
 * broker hands the invocation to this runner, which emits it as a
 * function_call/custom_tool_call to Codex and PARKS: the stream completes,
 * the tab stays open, ChatGPT keeps waiting for the tool result.
 *
 * Phase 2 (follow-up request carrying function_call_output): the bridge
 * resolves the parked invocation (the MCP result flows back through the
 * tunnel to ChatGPT) and the SAME turn resumes streaming — possibly parking
 * again on further tool calls until the final answer completes.
 *
 * @module @omnicross/chatgpt-web/chatgpt/harnessTurn
 */

import { CdpConnection } from '../cdp/connection';
import type { CdpTarget } from '../cdp/target';
import { sleep } from '../cdp/target';
import type { BrokerToolRequest, BrokerToolResult } from '../tunnel/broker';
import type { BridgeEvent } from '../bridge/types';
import { openChatGptEffortMenu, setChatGptEffortIndex } from './effort';
import { ChatGptMarkdownBuffer } from './markdown-buffer';
import {
  chatGptResponseSnapshotScript,
  chatGptTurnIdentitiesScript,
  insertAndVerifyComposerScript,
  type ChatGptResponseSnapshotJson,
  type ChatGptTurnIdentitiesJson,
} from './snapshot';
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_PLAIN_CHAT_URL,
  CHATGPT_STOP_BUTTON_SELECTOR,
} from './selectors';
import { traceDelta as traceDeltaOf, type TraceEmitterState } from './turn';

export interface HarnessTurnInput {
  promptText: string;
  /** Prompt-advertised broker token (minted before compiling the prompt). */
  turnToken: string;
  images: Array<{ ref: string; imageUrl: string; detail?: string }>;
  route: import('../bridge/models').ChatGptWebModelRoute;
  connectorName: string;
  abortSignal?: AbortSignal;
  onDiagnostic?: (checkpoint: string) => void;
}

export interface ParkedToolCall {
  callId: string;
  toolName: string;
  argumentsJson: string;
  freeform: boolean;
  resolve: (result: BrokerToolResult) => void;
  reject: (error: Error) => void;
}

/**
 * One live harness turn: owns the tab, the streaming buffer, and the parked
 * tool-call state across Codex requests until it completes or is abandoned.
 */
export class HarnessBrowserTurn {
  private constructor(
    readonly turnToken: string,
    private readonly tab: CdpTarget,
    private readonly input: HarnessTurnInput,
    readonly assistantTurnId: string | null,
    private readonly markdownBuffer: ChatGptMarkdownBuffer,
    private readonly traceState: TraceEmitterState,
    private readonly pending: Map<string, ParkedToolCall>,
    private readonly incoming: ParkedToolCall[],
  ) {}

  /** Parked tool calls awaiting their function_call_output. */
  get pendingCalls(): readonly ParkedToolCall[] {
    return [...this.pending.values()];
  }

  /** Phase 1: run a fresh turn up to the first tool call or completion. */
  static async start(connection: CdpConnection, input: HarnessTurnInput): Promise<HarnessBrowserTurn> {
    input.onDiagnostic?.('turn-starting');
    const tab = await connection.openTab('about:blank');
    {
      const fresh = await tab
        .evaluateJson<string>(
          `(() => { const s = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)}; const els = s.split(', ').flatMap((x) => [...document.querySelectorAll(x)]); const c = els[els.length - 1]; return JSON.stringify({ url: location.href.slice(0, 60), text: c ? (c.innerText || '').slice(0, 60) : null }); })()`,
        )
        .catch(() => '<eval failed>');
      input.onDiagnostic?.(`tab-opened: ${fresh}`);
    }
    // Plain conversation, not temporary: temporary chat's unpersonalized mode
    // hides connectors from the attach UI, so the harness has no + entry to
    // click (the reference implementation toggles personalization for this;
    // a plain conversation needs no such dance).
    await tab.navigate(CHATGPT_PLAIN_CHAT_URL, 45_000);
    await tab.bringToFront();
    const ready = await tab.waitForExpression(composerPresentScript(), 45_000, 250);
    if (!ready) {
      const url = await tab.currentUrl();
      if (/login|auth0|auth\.openai|\/auth\//i.test(url)) {
        throw Object.assign(new Error('ChatGPT web login is expired. Sign in to chatgpt.com in your Chrome, then retry.'), { status: 401 });
      }
      throw Object.assign(new Error('ChatGPT Chat composer is unavailable.'), { status: 400 });
    }
    await tab.pressKey('Escape').catch(() => undefined);
    await sleep(300);
    if (input.route.uiEffortIndex !== null) {
      await openChatGptEffortMenu(tab);
      await setChatGptEffortIndex(tab, input.route.uiEffortIndex);
      await sleep(250);
    }
    // Attach the connector BEFORE the prompt body: the plugin pill rides at
    // the head of the message, making the Codex Native tools available.
    await attachConnectorViaPlusMenu(tab, input.connectorName, input.onDiagnostic);
    input.onDiagnostic?.('connector-attached');

    const inserted = await tab.evaluateJson<{ inserted: boolean; matches: boolean }>(
      insertAndVerifyComposerScript(input.promptText),
      { awaitPromise: true },
    );
    if (inserted?.inserted !== true || inserted.matches !== true) {
      throw Object.assign(new Error('ChatGPT composer did not accept the compiled Codex prompt (insert echo mismatch)'), { status: 400 });
    }
    input.onDiagnostic?.('prompt-inserted');
    await runTurnOnTab_Send(tab, input);

    return new HarnessBrowserTurn(
      input.turnToken,
      tab,
      input,
      null,
      new ChatGptMarkdownBuffer(),
      { emittedByKey: new Map() },
      new Map(),
      [],
    );
  }

  /**
   * Stream the turn: deltas until the final answer completes, or park on the
   * first broker tool request (emitting it as a Codex tool call first).
   */
  async *stream(): AsyncGenerator<BridgeEvent, void, void> {
    const tab = this.tab;
    const input = this.input;
    let knownKey: string | undefined;
    let sawCompletion = false;
    for (;;) {
      if (input.abortSignal?.aborted) throw abortError();
      const [raw, identities] = await Promise.all([
        tab.evaluateJson<ChatGptResponseSnapshotJson>(snapshotScript(this.assistantTurnId, knownKey)),
        tab.evaluateJson<ChatGptTurnIdentitiesJson>(identitiesScript()),
      ]);
      knownKey = raw?.key ?? undefined;
      const snapshot = raw?.snapshot ?? emptySnapshot();
      const running = identities?.generationRunning ?? false;

      if (snapshot.responsePresent) {
        if (snapshot.stoppedThinkingVisible) {
          throw Object.assign(new Error('ChatGPT stopped thinking before producing an answer (usage limit or model stop)'), { status: 502 });
        }
        const delta = this.markdownBuffer.observe(snapshot.markdownSegments);
        if (delta) yield { type: 'text_delta', text: delta };
        const thinkingDelta = traceDeltaOf(this.traceState, snapshot.traceBlocks);
        if (thinkingDelta) yield { type: 'thinking_delta', thinking: thinkingDelta };
      }

      // Broker tool request → relay to Codex and park this stream.
      const parked = this.incoming.shift();
      if (parked) {
        yield {
          type: 'tool_call_start',
          id: parked.callId,
          name: parked.toolName,
          ...(parked.freeform ? { freeform: true } : {}),
        };
        yield { type: 'tool_call_delta', arguments: parked.argumentsJson };
        yield { type: 'tool_call_end' };
        return; // Stream A ends carrying the tool call; the tab stays parked.
      }

      const completionFrame =
        snapshot.responsePresent && !running && snapshot.visibleText.length > 0 && snapshot.completionActionVisible;
      if (completionFrame) {
        sawCompletion = true;
        const finalDelta = this.markdownBuffer.finish();
        if (finalDelta.delta) yield { type: 'text_delta', text: finalDelta.delta };
        yield { type: 'done' };
        return;
      }
      if (sawCompletion) {
        const finalDelta = this.markdownBuffer.finish();
        if (finalDelta.delta) yield { type: 'text_delta', text: finalDelta.delta };
        yield { type: 'done' };
        return;
      }
      await sleep(500);
    }
  }

  /**
   * Enqueue a broker tool request: parks it with real resolvers and hands it
   * to the streaming loop, which relays it to Codex as a tool call event and
   * ends this phase's stream (the MCP promise settles when the follow-up
   * Codex request delivers the function_call_output).
   */
  enqueueToolRequest(request: BrokerToolRequest): Promise<BrokerToolResult> {
    return new Promise<BrokerToolResult>((resolve, reject) => {
      const parked = mapToolRequest(request, resolve, reject);
      this.pending.set(parked.callId, parked);
      this.incoming.push(parked);
    });
  }

  /** Resolve a parked call with Codex's function_call_output. */
  resolveToolCall(callId: string, output: string, isError: boolean): boolean {
    const parked = this.pending.get(callId);
    if (!parked) return false;
    this.pending.delete(callId);
    parked.resolve({
      content: [{ type: 'text', text: output }],
      ...(isError ? { isError: true } : {}),
    });
    return true;
  }

  /** Tear down: stop generation and close the tab. */
  async dispose(): Promise<void> {
    await this.tab.trustedClick(CHATGPT_STOP_BUTTON_SELECTOR).catch(() => undefined);
    for (const parked of this.pending.values()) {
      parked.reject(new Error('Codex turn ended before the tool result arrived'));
    }
    this.pending.clear();
    await this.tab.close();
  }
}

// --- helpers ----------------------------------------------------------------

function composerPresentScript(): string {
  return `(() => { const els = document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)}); `
    + 'return [...els].some(el => el.offsetParent !== null || el.getClientRects().length > 0); })()';
}

function identitiesScript(): string {
  return chatGptTurnIdentitiesScript({
    containerSelector: '[data-turn-id-container]',
    userTurnSelector: '[data-testid^="conversation-turn-"][data-turn="user"]',
    assistantTurnSelector: '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
    composerSelector: CHATGPT_COMPOSER_SELECTOR,
  });
}

function snapshotScript(assistantTurnId: string | null, knownKey: string | undefined): string {
  return chatGptResponseSnapshotScript({
    assistantTurnSelector: assistantTurnId
      ? `[data-turn-id=${JSON.stringify(assistantTurnId)}]`
      : '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    userTurnSelector: '[data-testid^="conversation-turn-"][data-turn="user"]',
    composerSelector: CHATGPT_COMPOSER_SELECTOR,
    stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
    completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
    ...(knownKey ? { knownKey } : {}),
  });
}

function emptySnapshot(): NonNullable<ChatGptResponseSnapshotJson['snapshot']> {
  return {
    responsePresent: false,
    visibleText: '',
    fullHtml: '',
    markdownSegments: [],
    completionActionVisible: false,
    stoppedThinkingVisible: false,
    traceBlocks: [],
  };
}

function abortError(): Error {
  return Object.assign(new DOMException('ChatGPT web turn aborted', 'AbortError'), { status: 499 });
}

/** Map an MCP tool invocation onto the Codex tool surface. */
function mapToolRequest(
  request: BrokerToolRequest,
  resolve: (result: BrokerToolResult) => void,
  reject: (error: Error) => void,
): ParkedToolCall {
  if (request.tool === 'codex_apply_patch') {
    return {
      callId: request.callId,
      toolName: 'apply_patch',
      argumentsJson: JSON.stringify({ input: String(request.arguments['input'] ?? '') }),
      freeform: true,
      resolve,
      reject,
    };
  }
  return {
    callId: request.callId,
    toolName: 'shell',
    argumentsJson: JSON.stringify({
      command: Array.isArray(request.arguments['command']) ? request.arguments['command'] : [],
      ...(typeof request.arguments['timeout_ms'] === 'number' ? { timeout_ms: request.arguments['timeout_ms'] } : {}),
    }),
    freeform: false,
    resolve,
    reject,
  };
}

/**
 * Attach the connector through the composer's "+" menu — clicks only.
 *
 * The @-mention typing path no longer works: ChatGPT's @-apps popup does not
 * open for synthesized input (verified against Playwright's own keyboard in
 * both the Electron host and the user's Chrome; human typing still works).
 * The "+" menu, by contrast, lists connectors (in a plain conversation —
 * temporary chat hides them) and responds to trusted clicks reliably.
 */
async function attachConnectorViaPlusMenu(
  tab: CdpTarget,
  connectorName: string,
  onDiagnostic?: (checkpoint: string) => void,
): Promise<void> {
  const needle = connectorName.toLowerCase();
  const plusPointScript = `(() => {
    const selectors = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
    const elements = selectors.split(', ').flatMap((selector) => [...document.querySelectorAll(selector)]);
    const composer = elements[elements.length - 1];
    if (!composer) return null;
    const scope = composer.closest('form') ?? composer.parentElement ?? document.body;
    const plus = [...scope.querySelectorAll('button')].find((button) =>
      /添加|^add|attach|plus/i.test(button.getAttribute('aria-label') ?? ''));
    if (!plus) return null;
    const rect = plus.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`;
  // The + menu loads its app list asynchronously — poll for the row instead
  // of sleeping a fixed gap. Scope the search to the composer's form and
  // require the text to START with the connector name: whole-document
  // "contains" matches also hit sidebar previews of past harness turns whose
  // compiled prompt quotes the connector name.
  const rowPointScript = `(() => {
    const selectors = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
    const els = selectors.split(', ').flatMap((selector) => [...document.querySelectorAll(selector)]);
    const composer = els[els.length - 1];
    const scope = composer?.closest('form') ?? composer?.parentElement ?? document.body;
    const visible = (el) => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const candidates = [...scope.querySelectorAll('button, [role="menuitem"], [role="option"], li, div')]
      .filter((el) => visible(el)
        && !el.closest('aside, nav')
        && (el.innerText || '').replace(/^\\s+/, '').toLowerCase().startsWith(${JSON.stringify(needle)})
        && (el.innerText || '').length < 300);
    candidates.sort((a, b) => a.innerText.length - b.innerText.length);
    const target = candidates[0];
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 20) };
  })()`;
  const pillScript = `(() => {
    const selectors = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
    const elements = selectors.split(', ').flatMap((selector) => [...document.querySelectorAll(selector)]);
    const composer = elements[elements.length - 1];
    const pills = composer
      ? [...composer.querySelectorAll('[data-id^="plugin:"]')].map((pill) => pill.getAttribute('data-keyword') ?? '')
      : [];
    return pills;
  })()`;

  const deadline = Date.now() + 20_000;
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
    if (attempt === 0) {
      const entry = await tab.evaluateJson<string>(`(() => {
        const s = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
        const els = s.split(', ').flatMap((x) => [...document.querySelectorAll(x)]);
        const composer = els[els.length - 1];
        return JSON.stringify({ url: location.href.slice(0, 60), composerText: composer ? (composer.innerText || '').slice(0, 80) : null });
      })()`);
      onDiagnostic?.(`attach-entry: ${entry ?? '<eval failed>'}`);
    }
    await tab.trustedClickScript(plusPointScript);
    await sleep(600);
    // Poll for the connector row in the opened menu and click it as soon as
    // it appears.
    const rowDeadline = Date.now() + 5_000;
    let clicked = false;
    while (Date.now() < rowDeadline && !clicked) {
      clicked = await tab.trustedClickScript(rowPointScript);
      if (!clicked) await sleep(250);
    }
    if (clicked) {
      // Verify the plugin pill landed with the connector's keyword.
      const pillDeadline = Date.now() + 5_000;
      for (;;) {
        const pills = (await tab.evaluateJson<string[]>(pillScript)) ?? [];
        if (pills.some((keyword) => keyword.toLowerCase() === needle)) {
          await tab.pressKey('Escape').catch(() => undefined);
          return;
        }
        if (Date.now() >= pillDeadline) break;
        await sleep(200);
      }
    }
    await tab.pressKey('Escape').catch(() => undefined);
    await sleep(400);
  }
  // Screenshot the failure scene — the + menu's DOM shape varies and text
  // dumps keep matching sidebar previews instead of the menu.
  let screenshotNote = '';
  const shot = await tab.screenshotBase64().catch(() => undefined);
  if (shot) {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(process.cwd(), 'tmp-attach-fail.png'), Buffer.from(shot, 'base64'));
    screenshotNote = ' Scene saved to tmp-attach-fail.png.';
  }
  throw Object.assign(
    new Error(
      `The ChatGPT composer "+" menu did not attach "${connectorName}".${screenshotNote} ` +
        'Check that the connector exists with this exact name in ChatGPT Settings → Connectors (developer mode), and that this is a plain (non-temporary) conversation.',
    ),
    { status: 400 },
  );
}

/** Phase-1 send step (form-scoped click + submission evidence), shared shape. */
async function runTurnOnTab_Send(tab: CdpTarget, input: HarnessTurnInput): Promise<void> {
  const baseline = await tab.evaluateJson<ChatGptTurnIdentitiesJson>(identitiesScript());
  const baselineUser = new Set(baseline?.userIdentities ?? []);
  const baselineResponse = new Set(baseline?.responseIdentities ?? []);
  const enabled = await waitForSendEnabled(tab, input.abortSignal);
  if (!enabled) {
    throw Object.assign(new Error('ChatGPT send button remained disabled after the prompt was attached'), { status: 400 });
  }
  const sendScript = `(() => {
    const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
    const sendSelector = '[data-testid="send-button"]';
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    // The active composer is the one holding our prompt; stale layout copies
    // stay empty. Picking an empty copy's send button silently no-ops.
    const composers = [...document.querySelectorAll(composerSelector)]
      .filter((el) => visible(el) && (el.innerText || el.textContent || '').trim().length > 0);
    const composer = composers[composers.length - 1];
    const scope = composer?.closest('form') ?? document;
    const buttons = [...scope.querySelectorAll(sendSelector)].filter(visible);
    const button = buttons[0];
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    return new Promise((resolve) => setTimeout(() => {
      const rect = button.getBoundingClientRect();
      resolve({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
    }, 200));
  })()`;
  const clicked = await tab.trustedClickScript(sendScript);
  if (!clicked) throw Object.assign(new Error('ChatGPT send button was not clickable'), { status: 400 });
  input.onDiagnostic?.('send-clicked');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (input.abortSignal?.aborted) throw abortError();
    const identities = await tab.evaluateJson<ChatGptTurnIdentitiesJson>(identitiesScript());
    const accepted = (identities?.userIdentities ?? []).some((id) => !baselineUser.has(id))
      || (identities?.responseIdentities ?? []).some((id) => !baselineResponse.has(id))
      || identities?.generationRunning === true;
    if (accepted) {
      input.onDiagnostic?.('submission-accepted');
      return;
    }
    await sleep(250);
  }
  // Carry the page state at failure — "silently not submitted" has too many
  // possible causes to debug blind.
  const failureState = await tab.evaluateJson<string>(`(() => {
    const s = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
    const els = s.split(', ').flatMap((x) => [...document.querySelectorAll(x)]);
    const composer = els[els.length - 1];
    const alerts = [...document.querySelectorAll('[role="alert"], [role="status"]')]
      .map((el) => (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 120)).filter(Boolean);
    const userTurns = document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn="user"]').length;
    return JSON.stringify({
      url: location.href.slice(0, 70),
      userTurns,
      composerText: composer ? (composer.innerText || '').slice(0, 120) : null,
      alerts: alerts.slice(0, 3),
      bodyHead: document.body.innerText.replace(/\\s+/g, ' ').slice(-400),
    });
  })()`);
  throw Object.assign(
    new Error(`ChatGPT did not accept the submitted message (no new user turn appeared). State: ${failureState ?? '<eval failed>'}`),
    { status: 400 },
  );
}

async function waitForSendEnabled(tab: CdpTarget, signal: AbortSignal | undefined): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  const script = `(() => {
    const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
    const sendSelector = '[data-testid="send-button"]';
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    const composers = [...document.querySelectorAll(composerSelector)]
      .filter((el) => visible(el) && (el.innerText || el.textContent || '').trim().length > 0);
    const composer = composers[composers.length - 1];
    const scope = composer?.closest('form') ?? document;
    const buttons = [...scope.querySelectorAll(sendSelector)].filter(visible);
    const button = buttons[0];
    if (!button) return { present: false, enabled: false };
    return { present: true, enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true' };
  })()`;
  for (;;) {
    if (signal?.aborted) throw abortError();
    const state = await tab.evaluateJson<{ present: boolean; enabled: boolean }>(script);
    if (state?.present === true && state.enabled === true) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}
