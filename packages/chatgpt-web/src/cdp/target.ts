/**
 * target.ts — page-level helpers over one attached CDP session.
 *
 * `evaluate` is the workhorse (Runtime.evaluate with awaitPromise +
 * returnByValue). Input helpers dispatch TRUSTED browser events through the
 * Input domain (real mouse clicks at element centers, real key presses), which
 * survives React apps that ignore untrusted `el.click()` dispatches.
 *
 * @module @omnicross/chatgpt-web/cdp/target
 */

import type { CdpConnection } from './connection';

export interface EvaluateResult<T = unknown> {
  value?: T;
  exceptionText?: string;
}

const KEY_CODES: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
};

/** One attached page target with convenience helpers. */
export class CdpTarget {
  constructor(
    private readonly connection: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  /** Evaluate a JS expression in the page; returns by value. */
  async evaluate(expression: string, options: { awaitPromise?: boolean } = {}): Promise<EvaluateResult> {
    const result = await this.connection.sendOk(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise ?? false,
      },
      this.sessionId,
    );
    const exception = result['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
    if (exception) {
      return { exceptionText: exception.exception?.description ?? exception.text ?? 'evaluation threw' };
    }
    const remote = result['result'] as { value?: unknown } | undefined;
    return { value: remote?.value };
  }

  /** Evaluate an expression expected to produce a JSON value. */
  async evaluateJson<T>(expression: string, options: { awaitPromise?: boolean } = {}): Promise<T | undefined> {
    const result = await this.evaluate(expression, options);
    if (result.exceptionText) throw new Error(`Page evaluation failed: ${result.exceptionText}`);
    return result.value as T | undefined;
  }

  /** Current page URL. */
  async currentUrl(): Promise<string> {
    return (await this.evaluateJson<string>('location.href')) ?? '';
  }

  /** Navigate and wait for document readiness (bounded). */
  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    await this.connection.sendOk('Page.enable', {}, this.sessionId);
    await this.connection.sendOk('Page.navigate', { url }, this.sessionId);
    await this.waitForExpression('document.readyState === "complete" || document.readyState === "interactive"', timeoutMs, 250);
  }

  /** Poll an expression until truthy or timeout. */
  async waitForExpression(expression: string, timeoutMs: number, intervalMs = 200): Promise<boolean> {
    const wrapped = `(() => { try { return !!(${expression}); } catch { return false; } })()`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.evaluate(wrapped);
      if (!result.exceptionText && result.value === true) return true;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }

  /**
   * Compute an element's in-viewport click point (scrolling it into view), then
   * dispatch a trusted mouse click there. Returns false when no element matched.
   */
  async trustedClick(selector: string, options: { nth?: number; visibleOnly?: boolean; textContains?: string } = {}): Promise<boolean> {
    return this.trustedClickScript(clickPointScript(selector, options));
  }

  /**
   * Dispatch a trusted mouse click at the point a page script computes.
   * The script must return `{x, y}` viewport coordinates or null.
   */
  async trustedClickScript(pointScript: string): Promise<boolean> {
    // awaitPromise: point scripts may defer coordinate resolution while
    // smooth-scroll settles.
    const point = await this.evaluateJson<{ x: number; y: number } | null>(pointScript, { awaitPromise: true });
    if (!point) return false;
    await this.connection.sendOk(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      this.sessionId,
    );
    await this.connection.sendOk(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      this.sessionId,
    );
    return true;
  }

  /** Dispatch a trusted key press to the focused element. */
  async pressKey(key: keyof typeof KEY_CODES): Promise<void> {
    const descriptor = KEY_CODES[key];
    if (!descriptor) throw new Error(`Unsupported key: ${String(key)}`);
    const base = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
    };
    if (descriptor.text !== undefined) {
      await this.connection.sendOk(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', ...base, text: descriptor.text },
        this.sessionId,
      );
    } else {
      await this.connection.sendOk('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, this.sessionId);
    }
    await this.connection.sendOk('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId);
  }

  /**
   * Set local files on the first matching `input[type=file]`, bypassing the
   * file dialog. The browser fires the native change event, so React upload
   * handlers observe the files normally.
   */
  async setInputFiles(selector: string, files: string[]): Promise<boolean> {
    await this.connection.sendOk('DOM.enable', {}, this.sessionId);
    const document = await this.connection.sendOk('DOM.getDocument', {}, this.sessionId);
    const root = (document['root'] as { nodeId?: number } | undefined)?.nodeId;
    if (typeof root !== 'number') return false;
    const found = await this.connection.sendOk('DOM.querySelector', { nodeId: root, selector }, this.sessionId);
    const nodeId = found['nodeId'] as number | undefined;
    if (!nodeId || nodeId === 0) return false;
    await this.connection.sendOk('DOM.setFileInputFiles', { nodeId, files }, this.sessionId);
    return true;
  }

  /** Capture a PNG screenshot (base64). */
  async screenshotBase64(): Promise<string | undefined> {
    const result = await this.connection
      .send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
      .catch(() => null);
    return (result?.result?.['data'] as string | undefined) ?? undefined;
  }

  /**
   * Bring this tab to the front of its window.
   *
   * ChatGPT's composer controls (Radix menus, focus-dependent listeners) only
   * react to CDP Input events when the tab is foregrounded; background tabs
   * swallow the synthesized clicks.
   */
  async bringToFront(): Promise<void> {
    await this.connection.sendOk('Page.bringToFront', {}, this.sessionId);
  }

  /** Close this tab (best-effort). */
  async close(): Promise<void> {
    await this.connection.closeTab(this.targetId);
  }
}

function clickPointScript(
  selector: string,
  options: { nth?: number; visibleOnly?: boolean; textContains?: string },
): string {
  const selectorJson = JSON.stringify(selector);
  const nth = options.nth ?? 0;
  const visibleOnly = options.visibleOnly !== false;
  const textFilter = options.textContains ? JSON.stringify(options.textContains) : 'null';
  return `(() => {
    const all = Array.from(document.querySelectorAll(${selectorJson}));
    const filtered = all.filter(el => {
      if (${visibleOnly}) {
        if (el.offsetParent === null && el.getClientRects().length === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      }
      if (${textFilter}) {
        const text = el.innerText || el.textContent || '';
        if (!text.includes(${textFilter})) return false;
      }
      return true;
    });
    const el = filtered[${nth}] || filtered[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
