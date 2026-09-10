/**
 * effort.ts — read and drive ChatGPT's model/effort slider over CDP.
 *
 * The effort control lives in the composer's form. Opening it exposes an ARIA
 * slider (`[data-model-reasoning-effort-slider] [role="slider"]`) whose range
 * encodes the account's reasoning surface: five positions means Pro. Moving it
 * uses trusted Arrow key presses on the slider's menuitem ancestor, one step
 * at a time, verifying each aria-valuenow change before the next.
 *
 * Port of codex-chatgpt-web's chatgpt-session.ts + selectModelAndEffort.
 *
 * @module @omnicross/chatgpt-web/chatgpt/effort
 */

import type { CdpTarget } from '../cdp/target';
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_SLIDER_MAX_OPTIONS,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
} from './selectors';
import { sleep } from '../cdp/target';

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  return value;
}

export function parseChatGptEffortSliderState(
  rawMin: unknown,
  rawMax: unknown,
  rawValue: unknown,
): ChatGptEffortSliderState | undefined {
  const min = safeInteger(rawMin);
  const max = safeInteger(rawMax);
  const value = safeInteger(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

interface SliderProbe {
  controlPresent: boolean;
  controlExpanded: boolean | null;
  sliderVisible: boolean;
  min: number | null;
  max: number | null;
  value: number | null;
}

const sliderProbeScript = (() => {
  const config = JSON.stringify({
    composerSelector: CHATGPT_COMPOSER_SELECTOR,
    controlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR,
    sliderSelector: CHATGPT_EFFORT_SLIDER_SELECTOR,
  });
  return `(() => {
  const options = ${config};
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const composers = [...document.querySelectorAll(options.composerSelector)].filter(visible);
  const composer = composers[composers.length - 1];
  const form = composer?.closest('form');
  const controls = form ? [...form.querySelectorAll(options.controlSelector)].filter(visible) : [];
  const control = controls[controls.length - 1];
  if (!control) return { controlPresent: false, controlExpanded: null, sliderVisible: false, min: null, max: null, value: null };
  const sliders = [...document.querySelectorAll(options.sliderSelector)];
  const slider = sliders[sliders.length - 1];
  const sliderVisible = Boolean(slider && visible(slider.closest('[data-model-reasoning-effort-slider]')));
  return {
    controlPresent: true,
    controlExpanded: control.getAttribute('aria-expanded') === 'true' || control.getAttribute('data-state') === 'open' || null,
    sliderVisible,
    min: slider ? Number(slider.getAttribute('aria-valuemin')) : null,
    max: slider ? Number(slider.getAttribute('aria-valuemax')) : null,
    value: slider ? Number(slider.getAttribute('aria-valuenow')) : null,
  };
})()`;
})();

/** Probe the effort control + slider state without mutating anything. */
export async function probeChatGptEffortSlider(target: CdpTarget): Promise<SliderProbe> {
  return (
    (await target.evaluateJson<SliderProbe>(sliderProbeScript)) ?? {
      controlPresent: false,
      controlExpanded: null,
      sliderVisible: false,
      min: null,
      max: null,
      value: null,
    }
  );
}

const effortControlClickPointScript = `(() => {
  const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
  const controlSelector = ${JSON.stringify(CHATGPT_EFFORT_CONTROL_SELECTOR)};
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
  const composer = composers[composers.length - 1];
  if (!composer) return null;
  const form = composer.closest('form') ?? document;
  const controls = [...form.querySelectorAll(controlSelector)].filter(visible);
  const control = controls[controls.length - 1];
  if (!control) return null;
  control.scrollIntoView({ block: 'center' });
  return new Promise((resolve) => {
    // Let smooth-scroll settle before reading the click point, or the
    // coordinate lands where the button was mid-scroll.
    setTimeout(() => {
      const rect = control.getBoundingClientRect();
      resolve({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
    }, 200);
  });
})()`;

/** Open the effort menu and return the live slider state. */
export async function openChatGptEffortMenu(
  target: CdpTarget,
  options: { timeoutMs?: number } = {},
): Promise<ChatGptEffortSliderState> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeChatGptEffortSlider(target);
    if (probe.controlPresent && probe.sliderVisible && probe.min !== null) {
      const state = parseChatGptEffortSliderState(probe.min, probe.max, probe.value);
      if (state) return state;
    }
    if (probe.controlPresent && !probe.sliderVisible) {
      // Radix menus only respond when the tab is foregrounded — background
      // tabs swallow synthesized clicks.
      await target.bringToFront();
      await sleep(250);
      // Trusted click on the LAST visible control inside the composer's form
      // (the first document-wide match is routinely a different button).
      await target.trustedClickScript(effortControlClickPointScript);
      for (let wait = 0; wait < 10; wait++) {
        await sleep(300);
        const reopened = await probeChatGptEffortSlider(target);
        if (reopened.sliderVisible && reopened.min !== null) {
          const state = parseChatGptEffortSliderState(reopened.min, reopened.max, reopened.value);
          if (state) return state;
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('ChatGPT effort control did not expose its slider (menu never opened)');
    }
    await sleep(200);
  }
}

const focusSliderScript = `(() => {
  const sliders = [...document.querySelectorAll(${JSON.stringify(CHATGPT_EFFORT_SLIDER_SELECTOR)})];
  const slider = sliders[sliders.length - 1];
  if (!slider) return false;
  const control = slider.closest('[role="menuitem"]') ?? slider;
  control.focus();
  return document.activeElement === control;
})()`;

const sliderValueScript = `(() => {
  const sliders = [...document.querySelectorAll(${JSON.stringify(CHATGPT_EFFORT_SLIDER_SELECTOR)})];
  const slider = sliders[sliders.length - 1];
  if (!slider) return null;
  return {
    min: Number(slider.getAttribute('aria-valuemin')),
    max: Number(slider.getAttribute('aria-valuemax')),
    value: Number(slider.getAttribute('aria-valuenow')),
  };
})()`;

/**
 * Move the effort slider to `uiEffortIndex` (0-based position from min).
 * Assumes the menu is already open (call openChatGptEffortMenu first).
 */
export async function setChatGptEffortIndex(
  target: CdpTarget,
  uiEffortIndex: number,
): Promise<ChatGptEffortSliderState> {
  let state = await readSlider(target);
  const targetValue = state.min + uiEffortIndex;
  if (targetValue > state.max) {
    const proHint =
      uiEffortIndex === 4 && state.min === 0 && state.max === 3
        ? ' If you recently made many Pro requests, ChatGPT may have temporarily hidden Pro due to its usage limit.'
        : '';
    throw new Error(
      `ChatGPT effort slider does not expose item index ${uiEffortIndex} (min=${state.min}; max=${state.max}).${proHint}`,
    );
  }
  let guard = 0;
  while (state.value !== targetValue) {
    if (guard++ > 12) throw new Error('ChatGPT effort slider made no progress toward the requested effort');
    const focused = await target.evaluateJson<boolean>(focusSliderScript);
    if (focused !== true) throw new Error('ChatGPT effort slider lost its focusable menu item');
    const direction = targetValue > state.value ? 1 : -1;
    await target.pressKey(direction > 0 ? 'ArrowRight' : 'ArrowLeft');
    const previousValue = state.value;
    const changeDeadline = Date.now() + 5_000;
    for (;;) {
      state = await readSlider(target);
      if (state.value !== previousValue) break;
      if (Date.now() >= changeDeadline) break;
      await sleep(50);
    }
    if (state.value !== previousValue + direction) {
      throw new Error(
        `ChatGPT effort slider did not move exactly one step (before=${previousValue}; after=${state.value})`,
      );
    }
  }
  await target.pressKey('Escape');
  return state;
}

async function readSlider(target: CdpTarget): Promise<ChatGptEffortSliderState> {
  const raw = await target.evaluateJson<{ min: number; max: number; value: number } | null>(sliderValueScript);
  const state = raw ? parseChatGptEffortSliderState(raw.min, raw.max, raw.value) : undefined;
  if (!state) throw new Error('ChatGPT effort slider lost its semantic ARIA state');
  return state;
}
