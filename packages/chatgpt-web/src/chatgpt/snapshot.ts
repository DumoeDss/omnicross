/**
 * snapshot.ts — the in-page observation scripts (self-contained page JS).
 *
 * Each export compiles one JS expression string executed via
 * `CdpTarget.evaluate`. Scripts close over NOTHING from Node: every input is
 * JSON-injected, every output is JSON-serializable. The response snapshot
 * installs a per-root MutationObserver revision counter so unchanged DOM can
 * be skipped cheaply between polls.
 *
 * Port of codex-chatgpt-web's browser-worker responseDomSnapshot evaluate
 * body + submission-baseline identity capture.
 *
 * @module @omnicross/chatgpt-web/chatgpt/snapshot
 */

export interface SnapshotScriptOptions {
  assistantTurnSelector: string;
  userTurnSelector: string;
  composerSelector: string;
  stopButtonSelector: string;
  completionActionSelector: string;
  /** Skip re-extraction when this observer key is still current. */
  knownKey?: string;
}

export interface ChatGptMarkdownSegmentJson {
  key: string;
  tag?: string;
  html: string;
  text: string;
  group?: string;
  sourceStart?: number;
  sourceEnd?: number;
  streamable: boolean;
}

export interface ChatGptTraceBlockJson {
  kind: 'answer' | 'commentary' | 'status';
  text: string;
  key?: string;
  complete?: boolean;
  uiControl?: boolean;
}

export interface ChatGptResponseSnapshotJson {
  key: string | null;
  snapshot?: {
    responsePresent: boolean;
    visibleText: string;
    fullHtml: string;
    markdownSegments: ChatGptMarkdownSegmentJson[];
    completionActionVisible: boolean;
    stoppedThinkingVisible: boolean;
    traceBlocks: ChatGptTraceBlockJson[];
  };
}

export interface ChatGptTurnIdentitiesJson {
  containerIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
  generationRunning: boolean;
  composerVisibleCount: number;
}

/** Build the assistant-response snapshot expression. */
export function chatGptResponseSnapshotScript(options: SnapshotScriptOptions): string {
  const config = JSON.stringify(options);
  return `(() => {
  const options = ${config};
  const rootCandidates = [...document.querySelectorAll(options.assistantTurnSelector)];
  const root = rootCandidates.filter(candidate => candidate.closest('[data-turn-id-container]') === null || candidate.parentElement?.closest('[data-turn-id-container]') === null).at(-1)
    ?? rootCandidates.at(-1);
  if (!root) return { key: null, snapshot: { responsePresent: false, visibleText: '', fullHtml: '', markdownSegments: [], completionActionVisible: false, stoppedThinkingVisible: false, traceBlocks: [] } };
  const scope = globalThis;
  const registry = scope.__OMNICROSS_CHATGPT_WEB_OBSERVERS__ ??= {
    documentId: performance.timeOrigin + ':' + Math.random().toString(36).slice(2),
    nextId: 0,
    states: new WeakMap(),
  };
  let observerState = registry.states.get(root);
  if (!observerState) {
    observerState = { id: ++registry.nextId, revision: 0, observer: undefined };
    const state = observerState;
    state.observer = new MutationObserver(() => { state.revision += 1; });
    state.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    registry.states.set(root, state);
  }
  const observerKey = registry.documentId + ':' + observerState.id + ':' + observerState.revision;
  if (options.knownKey === observerKey) return { key: observerKey };
  const renderedInDom = (candidate) => {
    const style = getComputedStyle(candidate);
    return candidate.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const allMarkdownRoots = [...root.querySelectorAll('.markdown')]
    .filter(candidate => !candidate.parentElement?.closest('.markdown'))
    .filter(renderedInDom);
  const streamingStatusContainers = [...root.querySelectorAll('[data-streaming-response-status]')]
    .filter(renderedInDom);
  const firstStatusContainer = streamingStatusContainers[0];
  const commentary = allMarkdownRoots.filter(candidate => (
    candidate.closest('[data-streaming-response-status]') !== null
    || candidate.closest('[data-testid^="cot-v5"]') !== null
    || (firstStatusContainer !== undefined && Boolean(candidate.compareDocumentPosition(firstStatusContainer) & 4))
  ));
  const commentaryRoots = commentary;
  const renderedRoots = allMarkdownRoots.filter(candidate => !commentary.includes(candidate));
  const chatGptMarkdownContent = (markdownRoot) => {
    const content = markdownRoot.cloneNode(true);
    for (const widget of Array.from(content.querySelectorAll(
      '.chart-widget-container, [data-code-block-preview-pane], button, script, style, svg, img, picture, source',
    ))) widget.remove();
    return content;
  };
  const flattenedMarkdownSegments = [];
  const blockMarkdownTags = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
    'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
  ]);
  const markdownText = (element) => {
    const parts = [];
    const blockBoundary = () => { if (parts.length > 0 && !parts.at(-1).endsWith('\\n')) parts.push('\\n'); };
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
      if (!(node instanceof HTMLElement)) return;
      const tag = node.tagName.toLowerCase();
      const block = blockMarkdownTags.has(tag);
      if (block) blockBoundary();
      if (tag === 'br') parts.push('\\n');
      node.childNodes.forEach(visit);
      if (block) blockBoundary();
    };
    visit(element);
    return parts.join('').trim();
  };
  let listGroupIndex = 0;
  const sourceRange = (candidate) => {
    const startAttribute = candidate.getAttribute('data-start');
    const endAttribute = candidate.getAttribute('data-end');
    if (startAttribute === null || endAttribute === null) return undefined;
    if (!startAttribute.trim() || !endAttribute.trim()) return undefined;
    const sourceStart = Number(startAttribute);
    const sourceEnd = Number(endAttribute);
    return Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd >= sourceStart
      ? { sourceStart, sourceEnd }
      : undefined;
  };
  const appendBlockSegment = (child) => {
    const tag = child.tagName.toLowerCase();
    const childRange = sourceRange(child);
    const listItems = tag === 'ol' || tag === 'ul'
      ? [...child.children].filter(candidate => candidate.tagName === 'LI')
      : [];
    if (listItems.length === 0) {
      flattenedMarkdownSegments.push({ tag, html: child.outerHTML, text: markdownText(child), ...childRange });
      return;
    }
    const group = childRange ? 'list:' + childRange.sourceStart + ':' + tag : 'list:' + (listGroupIndex++) + ':' + tag;
    const orderedStart = tag === 'ol' ? Number(child.getAttribute('start') ?? '1') : undefined;
    listItems.forEach((item, itemIndex) => {
      const shell = child.cloneNode(false);
      shell.removeAttribute('data-is-last-node');
      if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
        shell.setAttribute('start', String(orderedStart + itemIndex));
      }
      shell.append(item.cloneNode(true));
      flattenedMarkdownSegments.push({ tag: tag + ':item', html: shell.outerHTML, text: markdownText(item), group, ...sourceRange(item) });
    });
  };
  renderedRoots.map(chatGptMarkdownContent).forEach((markdownRoot) => {
    const children = [...markdownRoot.children];
    const hasBlockChildren = children.some(child => blockMarkdownTags.has(child.tagName.toLowerCase()));
    if (!hasBlockChildren) {
      if (markdownRoot.innerHTML.trim()) flattenedMarkdownSegments.push({
        tag: 'root', html: markdownRoot.innerHTML, text: markdownText(markdownRoot), ...sourceRange(markdownRoot),
      });
      return;
    }
    let inlineRun = [];
    const flushInlineRun = () => {
      if (inlineRun.length === 0) return;
      const nodes = inlineRun;
      inlineRun = [];
      const shell = document.createElement('span');
      nodes.forEach(node => shell.append(node.cloneNode(true)));
      const text = markdownText(shell);
      if (text) {
        const rangedElements = nodes.flatMap(node => node instanceof Element
          ? [node, ...node.querySelectorAll('[data-start][data-end]')]
          : []);
        const ranges = rangedElements.map(sourceRange).filter(range => range !== undefined);
        flattenedMarkdownSegments.push({
          tag: 'inline', html: shell.outerHTML, text,
          ...(ranges.length > 0 ? {
            sourceStart: Math.min(...ranges.map(range => range.sourceStart)),
            sourceEnd: Math.max(...ranges.map(range => range.sourceEnd)),
          } : {}),
        });
      }
    };
    markdownRoot.childNodes.forEach((node) => {
      if (node instanceof HTMLElement && blockMarkdownTags.has(node.tagName.toLowerCase())) {
        flushInlineRun();
        appendBlockSegment(node);
        return;
      }
      inlineRun.push(node);
    });
    flushInlineRun();
  });
  const markdownSegments = flattenedMarkdownSegments.map((segment, index, segments) => ({
    key: segment.sourceStart !== undefined ? segment.sourceStart + ':' + segment.tag : index + ':' + segment.tag,
    tag: segment.tag,
    html: segment.html,
    text: segment.text,
    ...(segment.group ? { group: segment.group } : {}),
    ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
    ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
    streamable: index < segments.length - 1,
  }));
  const rendered = renderedRoots.at(-1);
  const completionAction = rendered
    ? [...root.querySelectorAll(options.completionActionSelector)]
      .filter(renderedInDom)
      .find(candidate => !rendered.contains(candidate)
        && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
    : undefined;
  const completionActionSet = new Set(completionAction ? [completionAction] : []);
  const candidates = new Map();
  renderedRoots.forEach(candidate => candidates.set(candidate, 'answer'));
  commentaryRoots.forEach(candidate => candidates.set(candidate, 'commentary'));
  const overlapsRenderedAnswer = (candidate) => renderedRoots.some(rendered => candidate.contains(rendered) || rendered.contains(candidate));
  const overlapsCommentary = (candidate) => commentaryRoots.some(commentary => candidate.contains(commentary) || commentary.contains(candidate));
  const statusSemantic = (candidate) => candidate.closest('button') ?? candidate.closest('[data-item-anchor]') ?? candidate;
  const traceText = (candidate) => {
    const ariaLabel = candidate.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;
    const screenReaderText = [...candidate.querySelectorAll('.sr-only')]
      .map(element => element.textContent?.replace(/\\s+/g, ' ').trim() ?? '')
      .find(Boolean);
    return screenReaderText || candidate.innerText.trim();
  };
  const traceKey = (candidate, kind) => {
    const statusContainer = candidate.closest('[data-streaming-response-status]');
    const itemAnchor = candidate.closest('[data-item-anchor]');
    if (!statusContainer || !itemAnchor) return undefined;
    const anchorIndex = [...statusContainer.querySelectorAll('[data-item-anchor]')].indexOf(itemAnchor);
    return anchorIndex >= 0 ? kind + ':anchor:' + anchorIndex : undefined;
  };
  const hasFollowingRenderedSibling = (candidate) => {
    const itemAnchor = candidate.closest('[data-item-anchor]');
    for (let sibling = itemAnchor?.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (sibling instanceof HTMLElement && renderedInDom(sibling) && sibling.innerText.trim()) return true;
    }
    return false;
  };
  root.querySelectorAll('button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]')
    .forEach(candidate => {
      if (completionActionSet.has(candidate)) return;
      if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
      const semantic = statusSemantic(candidate);
      if (!overlapsRenderedAnswer(semantic) && !overlapsCommentary(semantic) && !candidates.has(semantic)) {
        candidates.set(semantic, 'status');
      }
    });
  root.querySelectorAll('[data-streaming-response-status]').forEach(container => {
    if (!overlapsRenderedAnswer(container)
      && !overlapsCommentary(container)
      && ![...candidates.keys()].some(candidate => container.contains(candidate))) {
      candidates.set(container, 'status');
    }
  });
  const traceByKey = new Map();
  [...candidates]
    .filter(([candidate]) => renderedInDom(candidate))
    .sort(([left], [right]) => left === right ? 0 : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    .map(([candidate, kind]) => ({
      kind,
      text: traceText(candidate),
      key: traceKey(candidate, kind),
      ...(kind === 'commentary' ? { complete: hasFollowingRenderedSibling(candidate) } : {}),
      uiControl: candidate.matches('button') && candidate.closest('[data-streaming-response-status]') === null,
    }))
    .filter(block => block.text.length > 0)
    .forEach((block, index) => {
      const key = block.key ?? block.kind + ':fallback:' + index;
      const previous = traceByKey.get(key);
      if (!previous || block.text.length > previous.text.length) traceByKey.set(key, block);
    });
  const traceBlocks = [...traceByKey.values()].map((block, index, blocks) => ({
    ...block,
    ...(block.kind === 'commentary' ? { complete: block.complete === true || index < blocks.length - 1 } : {}),
  }));
  const stoppedThinkingVisible = (() => {
    const isStatus = (candidate) => {
      if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)
        || candidate.closest('pre, code, blockquote')) return false;
      for (let element = candidate; element; element = element.parentElement) {
        if (!renderedInDom(element)) return false;
      }
      return true;
    };
    const ariaMatch = [...root.querySelectorAll('[aria-label="Stopped thinking"]')].some(isStatus);
    if (ariaMatch) return true;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.replace(/\\s+/g, ' ').trim() !== 'Stopped thinking') continue;
      const parent = node.parentElement;
      if (parent && isStatus(parent)) return true;
    }
    return false;
  })();
  return {
    key: observerKey,
    snapshot: {
      responsePresent: true,
      visibleText: renderedRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join('\\n\\n'),
      fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join(''),
      markdownSegments,
      completionActionVisible: completionAction !== undefined,
      stoppedThinkingVisible,
      traceBlocks,
    },
  };
})()`;
}

/** Build the submission-baseline / turn-identity capture expression. */
export function chatGptTurnIdentitiesScript(options: {
  containerSelector: string;
  userTurnSelector: string;
  assistantTurnSelector: string;
  stopButtonSelector: string;
  composerSelector: string;
}): string {
  const config = JSON.stringify(options);
  return `(() => {
  const options = ${config};
  const identityOf = (element, attribute) => element.getAttribute(attribute) ?? '';
  const topContainers = [...document.querySelectorAll(options.containerSelector)].filter(element =>
    !element.parentElement?.closest(options.containerSelector));
  const containerIdentities = topContainers.map(element => identityOf(element, 'data-turn-id-container')).filter(Boolean);
  const userIdentities = [...document.querySelectorAll(options.userTurnSelector)]
    .map(element => identityOf(element, 'data-turn-id')).filter(Boolean);
  const responseIdentities = [...document.querySelectorAll(options.assistantTurnSelector)]
    .map(element => identityOf(element, 'data-turn-id')).filter(Boolean);
  const generationRunning = [...document.querySelectorAll(options.stopButtonSelector)]
    .some(element => element.offsetParent !== null || element.getClientRects().length > 0);
  const composerVisibleCount = [...document.querySelectorAll(options.composerSelector)]
    .filter(element => element.offsetParent !== null || element.getClientRects().length > 0).length;
  return { containerIdentities, userIdentities, responseIdentities, generationRunning, composerVisibleCount };
})()`;
}

/** Insert plain text at the caret of the composer (execCommand → Lexical live typing). */
export function insertPlainTextIntoComposerScript(value: string): string {
  const encoded = JSON.stringify(value);
  return `(() => {
  const value = ${encoded};
  const selectors = ['[data-testid="prompt-textarea"]', '#prompt-textarea', '[contenteditable="true"][data-lexical-editor="true"]'];
  const elements = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
    .filter(element => element.offsetParent !== null || element.getClientRects().length > 0);
  const element = elements[elements.length - 1];
  if (!element) return false;
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced = selection.isCollapsed && selection.anchorNode !== null && element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) return false;
  return document.execCommand('insertText', false, value);
})()`;
}

/**
 * Insert the full prompt, then poll the composer readback IN PAGE until it
 * matches. Lexical reconciles large insertions asynchronously — the Node-side
 * caller must not read the echo once and give up.
 */
export function insertAndVerifyComposerScript(value: string, options: { pollTimeoutMs?: number } = {}): string {
  const encoded = JSON.stringify(value);
  const timeout = options.pollTimeoutMs ?? 10_000;
  return `(async () => {
  const value = ${encoded};
  const timeoutMs = ${JSON.stringify(timeout)};
  const selectors = ['[data-testid="prompt-textarea"]', '#prompt-textarea', '[contenteditable="true"][data-lexical-editor="true"]'];
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  // Same block-aware readback as composerTextScript: join top-level Lexical
  // nodes with a newline separator (plain textContent loses those separators).
  const read = () => {
    const elements = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).filter(visible);
    const element = elements[elements.length - 1];
    if (!element) return null;
    const clone = element.cloneNode(true);
    clone.querySelectorAll('[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]')
      .forEach((part) => part.remove());
    return [...clone.childNodes]
      .map((child) => child.textContent ?? '')
      .join('\\n')
      .trimStart();
  };
  const insert = () => {
    const elements = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).filter(visible);
    const element = elements[elements.length - 1];
    if (!element) return false;
    if (document.activeElement !== element) element.focus();
    if (document.activeElement !== element) return false;
    const selection = window.getSelection();
    if (!selection) return false;
    const alreadyPlaced = selection.isCollapsed && selection.anchorNode !== null && element.contains(selection.anchorNode);
    if (!alreadyPlaced) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) return false;
    return document.execCommand('insertText', false, value);
  };
  const normalize = (text) => text.replace(/\\u00A0/g, ' ');
  const target = normalize(value);
  const inserted = insert();
  if (!inserted) return { inserted: false, matches: false, length: 0 };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = read();
    if (text !== null && normalize(text) === target) {
      return { inserted: true, matches: true, length: text.length };
    }
    if (Date.now() >= deadline) {
      return { inserted: true, matches: false, length: text === null ? -1 : text.length };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
})()`;
}

/**
 * Read back the composer's current text (prompt echo verification).
 *
 * NOT plain textContent: Lexical renders multi-line text as block-level child
 * nodes whose textContent concatenation loses the separating newlines. Join
 * top-level children with '\n' and strip connector-pill internals, mirroring
 * codex-chatgpt-web's attachedPromptText.
 */
export function composerTextScript(): string {
  return `(() => {
  const selectors = ['[data-testid="prompt-textarea"]', '#prompt-textarea', '[contenteditable="true"][data-lexical-editor="true"]'];
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const elements = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).filter(visible);
  const element = elements[elements.length - 1];
  if (!element) return null;
  const clone = element.cloneNode(true);
  clone.querySelectorAll('[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]')
    .forEach((part) => part.remove());
  return [...clone.childNodes]
    .map((child) => child.textContent ?? '')
    .join('\\n')
    .trimStart();
})()`;
}

/** Locate the composer's file input for DOM.setFileInputFiles. */
export function fileInputPresentScript(): string {
  return `(() => {
  const input = document.querySelector('input[data-testid="upload-photos-input"]')
    ?? document.querySelector('form input[type="file"]');
  return Boolean(input);
})()`;
}
