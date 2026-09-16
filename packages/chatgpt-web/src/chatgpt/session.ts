/**
 * session.ts — verify the user's ChatGPT login and probe account capabilities.
 *
 * Opens one background tab on the Temporary Chat surface, asserts a visible
 * composer (login proof — an expired session redirects away from the
 * composer), then probes the effort control: a stably-absent control means a
 * Luna-only account; a present control opens the picker and reads the slider
 * range (five positions ⇒ Pro).
 *
 * @module @omnicross/chatgpt-web/chatgpt/session
 */

import { CdpConnection } from '../cdp/connection';
import type { CdpTarget } from '../cdp/target';
import { sleep } from '../cdp/target';
import { openChatGptEffortMenu, probeChatGptEffortSlider } from './effort';
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
} from './selectors';
import type { ChatGptWebAccountCapabilities } from '../bridge/models';

export interface ChatGptSessionInspection {
  authenticated: boolean;
  url: string;
  capabilities?: ChatGptWebAccountCapabilities;
  detail?: string;
}

const composerWaitScript = `(() => {
  const selectors = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)}.split(', ');
  const elements = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
  const visible = elements.filter(element => element.offsetParent !== null || element.getClientRects().length > 0);
  return { visibleCount: visible.length, readyState: document.readyState, url: location.href };
})()`;

/**
 * Inspect the ChatGPT session. `detectCapabilities` additionally opens the
 * effort picker (one menu open + Escape; no message is sent).
 */
export async function inspectChatGptSession(
  connection: CdpConnection,
  options: { detectCapabilities?: boolean; timeoutMs?: number } = {},
): Promise<ChatGptSessionInspection> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const tab = await connection.openTab('about:blank');
  try {
    await tab.navigate(CHATGPT_TEMPORARY_CHAT_URL, timeoutMs);
    // Wait for either a visible composer (logged in) or a login redirect.
    const deadline = Date.now() + timeoutMs;
    let lastUrl = '';
    for (;;) {
      const state = (await tab.evaluateJson<{ visibleCount: number; readyState: string; url: string }>(
        composerWaitScript,
      )) ?? { visibleCount: 0, readyState: '', url: '' };
      lastUrl = state.url;
      if (state.visibleCount >= 1) break;
      if (/login|auth0|auth\.openai|\/auth\//i.test(state.url)) {
        return {
          authenticated: false,
          url: state.url,
          detail: 'ChatGPT redirected to a sign-in page. Sign in to chatgpt.com in your Chrome, then retry.',
        };
      }
      if (Date.now() >= deadline) {
        return {
          authenticated: false,
          url: state.url,
          detail: 'No visible ChatGPT composer appeared. Sign in to chatgpt.com in your Chrome, then retry.',
        };
      }
      await sleep(250);
    }
    if (!options.detectCapabilities) {
      return { authenticated: true, url: lastUrl };
    }
    const capabilities = await detectCapabilities(tab);
    return { authenticated: true, url: lastUrl, capabilities };
  } finally {
    await tab.close();
  }
}

async function detectCapabilities(tab: CdpTarget): Promise<ChatGptWebAccountCapabilities> {
  // The effort control hydrates LATE — often seconds after the composer and
  // long after readyState 'complete'. Wait for presence FIRST (bounded), and
  // only then fall back to the stable-absence window that proves Luna-only.
  const presenceDeadline = Date.now() + 12_000;
  let presenceObservations = 0;
  while (Date.now() < presenceDeadline) {
    const probe = await probeChatGptEffortSlider(tab);
    if (probe.controlPresent) {
      presenceObservations += 1;
      if (presenceObservations >= 2) break;
    } else {
      presenceObservations = 0;
    }
    await sleep(150);
  }
  if (presenceObservations >= 2) {
    const state = await openChatGptEffortMenu(tab);
    await tab.pressKey('Escape').catch(() => undefined);
    return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 };
  }

  // Stable absence: composer + complete document with no control for 3s.
  const deadline = Date.now() + 30_000;
  let absenceSince: number | undefined;
  for (;;) {
    const probe = await probeChatGptEffortSlider(tab);
    if (probe.controlPresent) {
      // Hydration finished mid-absence-window — the control exists after all.
      presenceObservations += 1;
      if (presenceObservations >= 2) {
        const state = await openChatGptEffortMenu(tab);
        await tab.pressKey('Escape').catch(() => undefined);
        return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 };
      }
      absenceSince = undefined;
      await sleep(150);
      continue;
    }
    presenceObservations = 0;
    const ready = (await tab.evaluateJson<{ readyState: string; composerCount: number }>(
      `(() => ({ readyState: document.readyState, composerCount: document.querySelectorAll(${JSON.stringify(
        CHATGPT_COMPOSER_SELECTOR,
      )}).length }))()`,
    )) ?? { readyState: '', composerCount: 0 };
    if (ready.readyState === 'complete' && ready.composerCount === 1) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= 3_000) {
        return { solAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error('ChatGPT account capability probe did not reach a stable composer state');
    }
    await sleep(100);
  }
}
