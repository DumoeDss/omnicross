/**
 * turn.ts — run one Codex turn through a ChatGPT Temporary Chat over CDP.
 *
 * Lifecycle: open a background tab on the temporary-chat surface → verify the
 * composer (login) → select the route's effort on the slider → insert the
 * compiled prompt (execCommand insertText → Lexical live typing) → attach
 * images via DOM.setFileInputFiles → capture the submission baseline → click
 * send → wait for submission evidence → bind the new assistant turn → stream
 * markdown segments + status rows until completion. Abort clicks Stop and
 * closes the tab.
 *
 * Simplified port of codex-chatgpt-web's browser-worker turn loop (fresh
 * temporary chat per request — Codex sends full context every turn under
 * disable_response_storage).
 *
 * @module @omnicross/chatgpt-web/chatgpt/turn
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CdpConnection } from '../cdp/connection';
import type { CdpTarget } from '../cdp/target';
import { sleep } from '../cdp/target';
import type { ChatGptWebModelRoute } from '../bridge/models';
import { estimateTokens, chatGptWebImageTokenReserve } from '../bridge/tokens';
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from '../bridge/models';
import type { BridgeEvent } from '../bridge/types';
import type { CompiledChatGptWebPrompt } from '../bridge/prompt';
import { openChatGptEffortMenu, setChatGptEffortIndex } from './effort';
import { ChatGptMarkdownBuffer } from './markdown-buffer';
import {
  chatGptResponseSnapshotScript,
  chatGptTurnIdentitiesScript,
  composerTextScript,
  fileInputPresentScript,
  insertAndVerifyComposerScript,
  insertPlainTextIntoComposerScript,
  type ChatGptResponseSnapshotJson,
  type ChatGptTurnIdentitiesJson,
} from './snapshot';
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_FILE_INPUT_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
} from './selectors';

export interface ChatGptWebTurnInput {
  prompt: CompiledChatGptWebPrompt;
  route: ChatGptWebModelRoute;
  abortSignal?: AbortSignal;
  /** Diagnostic sink for stage checkpoints (optional). */
  onDiagnostic?: (checkpoint: string) => void;
  /** Diagnostic sink for every streaming observation (optional). */
  onObserve?: (observation: {
    assistantTurnId: string | null;
    responsePresent: boolean;
    running: boolean;
    textChars: number;
    completionActionVisible: boolean;
    url: string;
  }) => void;
}

export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
export const CHATGPT_SUBMISSION_TIMEOUT_MS = 60_000;
export const CHATGPT_SEND_ENABLE_GRACE_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const IMAGE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

const identitiesScript = chatGptTurnIdentitiesScript({
  containerSelector: '[data-turn-id-container]',
  userTurnSelector: [
    '[data-testid^="conversation-turn-"][data-turn="user"]',
    '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  ].join(', '),
  assistantTurnSelector: [
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  ].join(', '),
  stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
  composerSelector: CHATGPT_COMPOSER_SELECTOR,
});

function snapshotScriptFor(assistantTurnId: string | null, knownKey?: string): string {
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

interface TurnObservation {
  snapshot: NonNullable<ChatGptResponseSnapshotJson['snapshot']>;
  observerKey: string | null;
  running: boolean;
}

async function observe(
  tab: CdpTarget,
  assistantTurnId: string | null,
  knownKey: string | undefined,
): Promise<TurnObservation> {
  const [raw, identities] = await Promise.all([
    tab.evaluateJson<ChatGptResponseSnapshotJson>(snapshotScriptFor(assistantTurnId, knownKey)),
    tab.evaluateJson<ChatGptTurnIdentitiesJson>(identitiesScript),
  ]);
  const snapshot =
    raw?.snapshot ?? {
      responsePresent: false,
      visibleText: '',
      fullHtml: '',
      markdownSegments: [],
      completionActionVisible: false,
      stoppedThinkingVisible: false,
      traceBlocks: [],
    };
  return { snapshot, observerKey: raw?.key ?? null, running: identities?.generationRunning ?? false };
}

/** DOM health windows: missing response, empty completion, missing completion action. */
class DomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;
  private missingCompletionAction?: { text: string; since: number };

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionVisible: boolean;
  }, now = Date.now()): string | undefined {
    // Active generation (stop button visible) proves the turn is alive even
    // when the bound element is mid-re-render — never accrue absence then.
    if (state.running) {
      this.missingResponseSince = undefined;
    }
    if (state.responsePresent) {
      this.sawResponse = true;
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? 'ChatGPT response DOM disappeared while the browser turn was active'
          : 'ChatGPT did not create a response DOM after the message was sent';
      }
    }
    const emptyCompletion =
      state.responsePresent && !state.running && state.currentText.length === 0 && state.completionActionVisible;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return 'ChatGPT browser turn completed without a final answer';
      }
    }
    const missingCompletionAction =
      state.responsePresent && !state.running && state.currentText.length > 0 && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now };
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return 'ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed';
    }
    return undefined;
  }
}

/** Completion requires the response present, not running, text, action, and stability. */
class CompletionTracker {
  private candidate?: { signature: string; since: number };

  constructor(private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS) {}

  isComplete(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    currentHtml?: string;
    completionActionVisible: boolean;
  }): boolean {
    return (
      state.responsePresent && !state.running && state.currentText.length > 0 && state.completionActionVisible
    );
  }

  update(state: Parameters<this['isComplete']>[0], now = Date.now()): boolean {
    if (!this.isComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    const signature = `${state.currentText}\0${state.currentHtml ?? state.currentText}`;
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

/** Shared trace-emitter state shape (also used by the harness turn). */
export interface TraceEmitterState {
  emittedByKey: Map<string, string>;
}

/** Emit incremental status/commentary deltas (shared with the harness turn). */
export function traceDelta(
  state: TraceEmitterState,
  blocks: Array<{ key?: string; kind: string; text: string; uiControl?: boolean }>,
): string {
  let delta = '';
  let index = 0;
  for (const block of blocks) {
    // Footer controls (rate response / switch model / more actions) are turn
    // UI, not model trace.
    if (block.uiControl === true) {
      index++;
      continue;
    }
    if (block.kind === 'answer') {
      index++;
      continue;
    }
    const key = block.key ?? `${block.kind}:fallback:${index++}`;
    const emitted = state.emittedByKey.get(key) ?? '';
    if (block.text.length > emitted.length && block.text.startsWith(emitted)) {
      delta += block.text.slice(emitted.length);
      state.emittedByKey.set(key, block.text);
    } else if (block.text !== emitted && block.text.length > 0) {
      delta += `\n${block.text}`;
      state.emittedByKey.set(key, block.text);
    }
  }
  return delta;
}

/** Insert + verify the prompt echo, with a chunked fallback for large bodies. */
async function insertAndVerifyPrompt(tab: CdpTarget, value: string): Promise<boolean> {
  const single = await tab.evaluateJson<{ inserted: boolean; matches: boolean; length: number }>(
    insertAndVerifyComposerScript(value),
    { awaitPromise: true },
  );
  if (single?.inserted === true && single.matches === true) return true;

  // Chunked fallback: Lexical reconciles moderate blocks more reliably than
  // one giant execCommand; split on line boundaries, never mid-line.
  const chunks: string[] = [];
  const maxChunk = 6_000;
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(offset + maxChunk, value.length);
    if (end < value.length) {
      const newline = value.lastIndexOf('\n', end);
      if (newline > offset) end = newline + 1;
    }
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  // Clear whatever the failed single-shot attempt left behind.
  await tab.evaluate(`(() => {
    const selectors = ['[data-testid="prompt-textarea"]', '#prompt-textarea', '[contenteditable="true"][data-lexical-editor="true"]'];
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    const elements = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).filter(visible);
    const element = elements[elements.length - 1];
    if (!element) return false;
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand('delete');
  })()`);
  for (const chunk of chunks) {
    const applied = await tab.evaluateJson<boolean>(insertPlainTextIntoComposerScript(chunk));
    if (applied !== true) return false;
    await sleep(60);
  }
  const readback = await tab.evaluateJson<string | null>(composerTextScript());
  return (
    typeof readback === 'string' && readback.replace(/ /g, ' ') === value.replace(/ /g, ' ')
  );
}

async function writeImageTempFiles(prompt: CompiledChatGptWebPrompt): Promise<{
  files: string[];
  cleanup: () => void;
}> {
  const files: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'omnicross-chatgpt-web-'));
  let totalBytes = 0;
  for (const image of prompt.images) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(image.imageUrl);
    if (!match) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const [, mediaType, base64] = match;
    const extension = IMAGE_EXTENSIONS.get(mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${mediaType}`);
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error('ChatGPT web input images exceed the 50 MB per-turn limit');
    const file = join(dir, `${image.ref}.${extension}`);
    writeFileSync(file, buffer);
    files.push(file);
  }
  return {
    files,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

async function clickStop(tab: CdpTarget): Promise<void> {
  await tab.trustedClick(CHATGPT_STOP_BUTTON_SELECTOR).catch(() => undefined);
}

/** Run one full browser turn; yields BridgeEvents. */
export async function* runChatGptWebTurn(
  connection: CdpConnection,
  input: ChatGptWebTurnInput,
): AsyncGenerator<BridgeEvent> {
  const signal = input.abortSignal;
  const route = input.route;
  const prompt = input.prompt;
  const tab = await connection.openTab('about:blank');
  let tempCleanup: (() => void) | undefined;
  let finished = false;
  try {
    yield* runTurnOnTab(connection, tab, input, (cleanup) => {
      tempCleanup = cleanup;
    });
    finished = true;
  } finally {
    if (!finished && signal?.aborted !== true) {
      await clickStop(tab);
    }
    tempCleanup?.();
    // Debug escape hatch: keep the failed turn's tab open for inspection.
    if (!finished && process.env['OMNICROSS_CHATGPT_WEB_DEBUG'] === '1') {
      input.onDiagnostic?.(`tab-kept-open target=${tab.targetId}`);
      return;
    }
    await tab.close();
  }
}

async function* runTurnOnTab(
  _connection: CdpConnection,
  tab: CdpTarget,
  input: ChatGptWebTurnInput,
  registerCleanup: (cleanup: () => void) => void,
): AsyncGenerator<BridgeEvent> {
  const signal = input.abortSignal;
  const route = input.route;
  const prompt = input.prompt;
  input.onDiagnostic?.('tab-opened');

  // 1. Temporary chat surface + login. The tab must be foregrounded for the
  // whole turn: ChatGPT's composer controls swallow synthesized input while
  // backgrounded, and generation itself renders more reliably foregrounded.
  await tab.navigate(CHATGPT_TEMPORARY_CHAT_URL, 45_000);
  await tab.bringToFront();
  const composerReady = await tab.waitForExpression(
    `(() => { const els = document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)}); ` +
      'return [...els].some(el => el.offsetParent !== null || el.getClientRects().length > 0); })()',
    45_000,
    250,
  );
  if (!composerReady) {
    const url = await tab.currentUrl();
    if (/login|auth0|auth\.openai|\/auth\//i.test(url)) {
      throw Object.assign(new Error('ChatGPT web login is expired. Sign in to chatgpt.com in your Chrome, then retry.'), {
        status: 401,
      });
    }
    throw Object.assign(new Error('ChatGPT Temporary Chat composer is unavailable.'), { status: 400 });
  }
  // Dismiss any temporary-chat onboarding modal (Escape only — no text guessing).
  await tab.pressKey('Escape').catch(() => undefined);
  await sleep(300);
  input.onDiagnostic?.('composer-ready');

  // 2. Effort selection (Sol accounts only).
  if (route.uiEffortIndex !== null) {
    await openChatGptEffortMenu(tab);
    await setChatGptEffortIndex(tab, route.uiEffortIndex);
    input.onDiagnostic?.('effort-selected');
    await sleep(250);
  }

  // 3. Insert the prompt (single shot, then chunked fallback).
  const inserted = await insertAndVerifyPrompt(tab, prompt.text);
  if (!inserted) {
    throw Object.assign(
      new Error('ChatGPT composer did not accept the compiled Codex prompt (insert echo mismatch)'),
      { status: 400 },
    );
  }
  input.onDiagnostic?.('prompt-inserted');

  // 4. Attach images.
  if (prompt.images.length > 0) {
    const inputPresent = await tab.evaluateJson<boolean>(fileInputPresentScript());
    if (inputPresent !== true) {
      throw Object.assign(
        new Error('ChatGPT composer exposes no file input for image attachments'),
        { status: 502 },
      );
    }
    const { files, cleanup } = await writeImageTempFiles(prompt);
    registerCleanup(cleanup);
    const applied = await tab.setInputFiles(CHATGPT_FILE_INPUT_SELECTOR, files);
    if (!applied) {
      cleanup();
      throw Object.assign(new Error('ChatGPT file input rejected the image attachments'), { status: 502 });
    }
  }

  // 5. Send (form-scoped click: the send-button testid exists in multiple
  // layout copies; a document-wide pick can address the wrong one).
  const baseline = await tab.evaluateJson<ChatGptTurnIdentitiesJson>(identitiesScript);
  const baselineUserIdentities = new Set(baseline?.userIdentities ?? []);
  const baselineResponseIdentities = new Set(baseline?.responseIdentities ?? []);
  const sendEnabled = await waitForSendEnabled(tab, signal);
  if (!sendEnabled) {
    throw Object.assign(new Error('ChatGPT send button remained disabled after the prompt was attached'), {
      status: 502,
    });
  }
  const sendClickPointScript = `(() => {
    const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
    const sendSelector = ${JSON.stringify(CHATGPT_SEND_BUTTON_SELECTOR)};
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
    const composer = composers[composers.length - 1];
    const scope = composer?.closest('form') ?? document;
    const buttons = [...scope.querySelectorAll(sendSelector)].filter(visible);
    const button = buttons[buttons.length - 1];
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    return new Promise((resolve) => setTimeout(() => {
      const rect = button.getBoundingClientRect();
      resolve({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
    }, 200));
  })()`;
  const clicked = await tab.trustedClickScript(sendClickPointScript);
  if (!clicked) {
    throw Object.assign(new Error('ChatGPT send button was not clickable'), { status: 400 });
  }
  input.onDiagnostic?.('send-clicked');

  // 6. Submission evidence + assistant turn binding. If ChatGPT shows no new
  // user turn shortly after the click, the click likely landed on a stale
  // button copy — re-click the form-scoped button ONCE before failing.
  let assistantTurnId: string | null = null;
  let newUserTurnId: string | null = null;
  const submissionDeadline = Date.now() + CHATGPT_SUBMISSION_TIMEOUT_MS;
  const reClickAt = Date.now() + 15_000;
  let reClicked = false;
  while (Date.now() < submissionDeadline) {
    if (signal?.aborted) throw abortError();
    const identities = await tab.evaluateJson<ChatGptTurnIdentitiesJson>(identitiesScript);
    const userIdentities = identities?.userIdentities ?? [];
    const responseIdentities = identities?.responseIdentities ?? [];
    newUserTurnId = userIdentities.find((id) => !baselineUserIdentities.has(id)) ?? null;
    if (!newUserTurnId) {
      newUserTurnId =
        (identities?.containerIdentities ?? []).find(
          (id) => !baselineUserIdentities.has(id) && !baselineResponseIdentities.has(id),
        ) ?? null;
    }
    if (newUserTurnId) {
      assistantTurnId =
        responseIdentities.find(
          (id) => !baselineResponseIdentities.has(id) && id !== newUserTurnId,
        ) ?? null;
      if (assistantTurnId) break;
    }
    if (!reClicked && Date.now() >= reClickAt) {
      reClicked = true;
      input.onDiagnostic?.('send-reclicked');
      await tab.trustedClickScript(sendClickPointScript).catch(() => undefined);
    }
    await sleep(250);
  }
  if (!newUserTurnId) {
    throw Object.assign(
      new Error('ChatGPT did not accept the submitted message (no new user turn appeared)'),
      { status: 400 },
    );
  }
  input.onDiagnostic?.('submission-accepted');

  // 7. Streaming loop.
  const markdownBuffer = new ChatGptMarkdownBuffer();
  const health = new DomHealthTracker();
  const completion = new CompletionTracker();
  const traceState: TraceEmitterState = { emittedByKey: new Map() };
  let knownKey: string | undefined;
  let assistantDeadline = Date.now() + CHATGPT_RESPONSE_DOM_GRACE_MS;
  let thinkingEmittedTotal = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    const observation = await observe(tab, assistantTurnId, knownKey);
    knownKey = observation.observerKey ?? undefined;
    const snapshot = observation.snapshot;
    input.onObserve?.({
      assistantTurnId,
      responsePresent: snapshot.responsePresent,
      running: observation.running,
      textChars: snapshot.visibleText.length,
      completionActionVisible: snapshot.completionActionVisible,
      url: await tab.currentUrl().catch(() => ''),
    });
    if (snapshot.responsePresent) {
      if (snapshot.stoppedThinkingVisible) {
        throw Object.assign(
          new Error('ChatGPT stopped thinking before producing an answer (usage limit or model stop)'),
          { status: 502 },
        );
      }
      const delta = markdownBuffer.observe(snapshot.markdownSegments);
      if (delta) yield { type: 'text_delta', text: delta };
      const thinkingDelta = traceDelta(traceState, snapshot.traceBlocks);
      if (thinkingDelta) {
        thinkingEmittedTotal += thinkingDelta.length;
        yield { type: 'thinking_delta', thinking: thinkingDelta };
      }
    }
    if (signal?.aborted) throw abortError();
    if (!snapshot.responsePresent && !assistantTurnId) {
      // The bound turn may not exist yet — bounded by the grace window.
      if (Date.now() < assistantDeadline) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
    }
    const domError = health.update({
      responsePresent: snapshot.responsePresent,
      running: observation.running,
      currentText: snapshot.visibleText,
      completionActionVisible: snapshot.completionActionVisible,
    });
    // A fully-rendered completion frame (text + copy action + not running) is
    // terminal evidence on its own: ChatGPT re-renders completed turns and can
    // replace the bound element right after, which must not be read as loss.
    const completionFrame =
      snapshot.responsePresent &&
      !observation.running &&
      snapshot.visibleText.length > 0 &&
      snapshot.completionActionVisible;
    if (completionFrame) {
      break;
    }
    if (domError) throw Object.assign(new Error(domError), { status: 502 });
    if (completion.update({
      responsePresent: snapshot.responsePresent,
      running: observation.running,
      currentText: snapshot.visibleText,
      currentHtml: snapshot.fullHtml,
      completionActionVisible: snapshot.completionActionVisible,
    })) {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const finalDelta = markdownBuffer.finish();
  if (finalDelta.delta) yield { type: 'text_delta', text: finalDelta.delta };

  // 8. Usage (estimated).
  const imageTokens = prompt.images.reduce((sum, image) => sum + chatGptWebImageTokenReserve(image.detail), 0);
  const inputTokens =
    (await estimateTokens(prompt.text)) + imageTokens + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS;
  const outputTokens = (await estimateTokens(finalDelta.markdown)) + Math.ceil(thinkingEmittedTotal / 4);
  yield {
    type: 'done',
    usage: { inputTokens, outputTokens, estimated: true },
  };
}

async function waitForSendEnabled(tab: CdpTarget, signal: AbortSignal | undefined): Promise<boolean> {
  const deadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
  // Scope to the composer's form: the same send-button testid exists in
  // multiple layout copies and a document-wide pick can address the wrong one.
  const script = `(() => {
    const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
    const sendSelector = ${JSON.stringify(CHATGPT_SEND_BUTTON_SELECTOR)};
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
    const composer = composers[composers.length - 1];
    const scope = composer?.closest('form') ?? document;
    const buttons = [...scope.querySelectorAll(sendSelector)].filter(visible);
    const button = buttons[buttons.length - 1];
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

function abortError(): Error {
  return Object.assign(new DOMException('ChatGPT web turn aborted', 'AbortError'), { status: 499 });
}

/** One cheap smoke turn: fixed prompt, expects the fixed marker back. */
export async function* runChatGptWebSmokeTurn(
  connection: CdpConnection,
  route: ChatGptWebModelRoute,
  abortSignal?: AbortSignal,
): AsyncGenerator<BridgeEvent> {
  yield* runChatGptWebTurn(connection, {
    prompt: { text: 'Reply with exactly: OMNICROSS WEB READY', images: [] },
    route,
    abortSignal,
  });
}
