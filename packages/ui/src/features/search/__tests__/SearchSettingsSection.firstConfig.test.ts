/** @vitest-environment jsdom */

/**
 * THE OWNER-REPRO REGRESSION PIN (search-settings-tab, task 3.6a — design D3).
 *
 * The shipped section rendered the entry fields ONLY after a provider was
 * already configured, so a FRESH install (empty config) had no reachable
 * inputs anywhere and no key could ever be typed — the owner could not
 * configure a key. This suite renders with an EMPTY config and NEVER seeds a
 * configured provider: the inputs must exist, be focusable, and a typed key
 * must reach the PUT payload. Do not "fix" a failure here by seeding a
 * pre-configured provider — that is exactly how the bug shipped.
 */
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/state/LocaleContext', () => ({
  useTranslation: () => (key: string, opts?: Record<string, unknown>) =>
    opts && Object.keys(opts).length > 0
      ? `${key}:${Object.values(opts).map(String).join(',')}`
      : key,
}));

import type { SearchQueryOutcome, SearchServerConfig } from '@/daemon/types';

import { SearchSettingsSection } from '../SearchSettingsSection';

/** A FRESH INSTALL: nothing configured, no secrets, no entries. */
const EMPTY_CONFIG: SearchServerConfig = {
  modes: { codex: 'off', responses: 'native', anthropic: 'native' },
  providers: {},
  egress: { allowedPrivateHosts: [] },
  policy: { fallbackEnabled: true },
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let savedPayload: SearchServerConfig | null = null;

beforeEach(() => {
  savedPayload = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      React.createElement(SearchSettingsSection, {
        config: EMPTY_CONFIG,
        diagnostics: null,
        busy: false,
        onUpdate: async (search) => {
          savedPayload = search;
        },
        onQuery: async (): Promise<SearchQueryOutcome> => ({ ok: false, error: 'unused' }),
      }),
    );
  });
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  container = null;
  root = null;
});

/** The card DOM node for one provider (cards carry their brand name as text). */
function cardFor(name: string): HTMLElement {
  const card = Array.from(container!.querySelectorAll<HTMLElement>('div.rounded-lg')).find(
    (el) => el.textContent?.includes(name),
  );
  expect(card, `card for ${name} must render`).toBeDefined();
  return card!;
}

/** React-compatible typing into an input inside `scope`. */
function typeInto(scope: HTMLElement, ariaLabel: string, value: string): void {
  const input = scope.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
  expect(input, `input ${ariaLabel} must exist inside the card`).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input!, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickSave(): void {
  const buttons = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'));
  const save = buttons.find((b) => b.textContent?.includes('search.action.save'));
  expect(save, 'the save button must render').toBeDefined();
  act(() => {
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function openMode(frontend: string): HTMLButtonElement {
  const trigger = container!.querySelector<HTMLButtonElement>(`#search-mode-${frontend}`)!;
  expect(trigger).not.toBeNull();
  act(() => trigger.click());
  return trigger;
}

function modeOption(mode: string): HTMLButtonElement {
  const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => !container!.contains(button) && button.textContent === `search.mode.${mode}`,
  );
  expect(option).toBeDefined();
  return option!;
}

describe('search mode editing', () => {
  it('offers both native and managed Codex search', () => {
    openMode('codex');
    expect(modeOption('native').disabled).toBe(false);
    expect(modeOption('managed').disabled).toBe(false);
    expect(modeOption('off').disabled).toBe(false);

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    openMode('responses');
    expect(modeOption('native').disabled).toBe(false);
  });

  it('saves the selected mode from the visible top action and restores it on remount', async () => {
    const trigger = openMode('codex');
    const topSave = container!.querySelector<HTMLButtonElement>('.sticky button')!;
    expect(topSave).not.toBeNull();
    expect(topSave.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => modeOption('native').click());
    expect(savedPayload).toBeNull();
    await act(async () => topSave.click());
    expect(savedPayload!.modes).toEqual({ codex: 'native', responses: 'native', anthropic: 'native' });

    const persisted = savedPayload!;
    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => root!.render(React.createElement(SearchSettingsSection, {
      config: persisted,
      diagnostics: null,
      busy: false,
      onUpdate: async () => undefined,
      onQuery: async (): Promise<SearchQueryOutcome> => ({ ok: false, error: 'unused' }),
    })));
    expect(container!.querySelector('#search-mode-codex')!.textContent).toBe('search.mode.native');
  });
});

describe('first-time key configuration from an EMPTY config (the owner repro)', () => {
  it('renders the tavily key input on an unconfigured card — present, focusable, next to the missing-field hint', () => {
    const card = cardFor('Tavily');
    // The unconfigured empty state: badge + hint…
    expect(card.textContent).toContain('search.unconfiguredReason.tavily');
    // …COEXISTING with the entry field (D3: configured drives the badge only,
    // never input visibility). Focusability is the point: the input must be
    // reachable by keyboard, not merely present in the DOM.
    const input = card.querySelector<HTMLInputElement>('input[aria-label="search.field.apiKey"]');
    expect(input).not.toBeNull();
    expect(input!.disabled).toBe(false);
    act(() => {
      input!.focus();
    });
    expect(document.activeElement).toBe(input);
  });

  it('types a tavily key and SAVES — the PUT payload carries providers.tavily.apiKey (the exact repro)', async () => {
    const card = cardFor('Tavily');
    typeInto(card, 'search.field.apiKey', 'FIRST_TIME_KEY_SENTINEL');
    await act(async () => {
      clickSave();
    });

    expect(savedPayload, 'Save must call onUpdate with the payload').not.toBeNull();
    const tavily = savedPayload!.providers.tavily as { apiKey?: string } | undefined;
    expect(tavily?.apiKey).toBe('FIRST_TIME_KEY_SENTINEL');
  });

  it('configures searxng by host from unconfigured — the host input is reachable and saveable', async () => {
    const card = cardFor('SearXNG');
    expect(card.textContent).toContain('search.unconfiguredReason.searxng');
    typeInto(card, 'search.field.apiHost', 'https://searx.internal.example.test');
    await act(async () => {
      clickSave();
    });

    const searxng = savedPayload!.providers.searxng as { apiHost?: string } | undefined;
    expect(searxng?.apiHost).toBe('https://searx.internal.example.test');
  });

  it('enables keyless jina by naming a host (the host-only enable path)', async () => {
    const card = cardFor('Jina');
    typeInto(card, 'search.field.apiHost', 'https://s.jina.example.test');
    await act(async () => {
      clickSave();
    });

    expect(savedPayload!.providers.jina).toEqual({ apiHost: 'https://s.jina.example.test' });
  });

  it('shows NO test-panel affordance for unconfigured providers (the badge + hint already say why)', () => {
    const card = cardFor('Z.AI');
    expect(card.querySelector('input[aria-label="search.test.queryPlaceholder"]')).toBeNull();
    expect(card.textContent).toContain('search.unconfiguredReason.zai');
  });

  it('keeps an untouched empty save a NO-OP (no implicit entries, never a 400)', async () => {
    await act(async () => {
      clickSave();
    });
    expect(savedPayload!.providers).toEqual({});
  });
});

describe('expanded provider settings through visible controls', () => {
  it.each(['Exa', 'Parallel', 'Firecrawl'])('saves and restores public access for %s with no secret', async (name) => {
    const id = name.toLowerCase();
    const card = cardFor(name);
    const toggle = card.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => toggle.click());
    await act(async () => clickSave());
    expect(savedPayload!.providers[id as 'exa']).toEqual({ authMode: 'public' });
    const restored: SearchServerConfig = {
      ...EMPTY_CONFIG, providers: { [id]: { authMode: 'public', apiKeyConfigured: false } },
    };
    act(() => root!.render(React.createElement(SearchSettingsSection, {
      config: restored, diagnostics: null, busy: false,
      onUpdate: async (search) => { savedPayload = search; },
      onQuery: async (): Promise<SearchQueryOutcome> => ({ ok: false, error: 'unused' }),
    })));
    expect(cardFor(name).querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    expect(cardFor(name).querySelector(`#search-auth-mode-${id}`)!.textContent).toBe('search.authMode.public');
    await act(async () => clickSave());
    expect(savedPayload!.providers[id as 'exa']).toEqual({ authMode: 'public' });
  });

  it.each(['Bing (HTTP)', 'DuckDuckGo (HTTP)'])('can explicitly disable the default %s engine', async (name) => {
    const id = name === 'Bing (HTTP)' ? 'http-bing' : 'http-duckduckgo';
    const toggle = cardFor(name).querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    act(() => toggle.click());
    await act(async () => clickSave());
    expect(savedPayload!.providers[id]).toEqual({ enabled: false });
  });

  it.each(['Exa', 'Parallel', 'Firecrawl'])('rejects keyless API mode for %s instead of downgrading', async (name) => {
    const card = cardFor(name);
    const id = name.toLowerCase();
    act(() => card.querySelector<HTMLButtonElement>(`#search-auth-mode-${id}`)!.click());
    const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'search.authMode.api')!;
    act(() => option.click());
    const save = container!.querySelector<HTMLButtonElement>('.sticky button')!;
    expect(save.disabled).toBe(true);
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(id);
    await act(async () => save.click());
    expect(savedPayload).toBeNull();
    typeInto(card, 'search.field.apiKey', 'key-for-api-mode');
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(savedPayload!.providers[id as 'exa']).toEqual({ authMode: 'api', apiKey: 'key-for-api-mode' });
  });

  it.each(['Startpage (HTTP)', 'Ecosia (HTTP)', 'Mojeek (HTTP)', 'Public (HTTP aggregate)'])(
    'opts in %s only through explicit enablement', async (name) => {
      const ids: Record<string, 'http-startpage' | 'http-ecosia' | 'http-mojeek' | 'public'> = {
        'Startpage (HTTP)': 'http-startpage', 'Ecosia (HTTP)': 'http-ecosia',
        'Mojeek (HTTP)': 'http-mojeek', 'Public (HTTP aggregate)': 'public',
      };
      const card = cardFor(name);
      const toggle = card.querySelector<HTMLButtonElement>('[role="switch"]')!;
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      act(() => toggle.click());
      await act(async () => clickSave());
      expect(savedPayload!.providers[ids[name]!]).toEqual({ enabled: true });
      act(() => toggle.click());
      await act(async () => clickSave());
      expect(savedPayload!.providers[ids[name]!]).toBeUndefined();
    },
  );

  it('offers a model override for Claude, not Perplexity, and preserves a saved secret', async () => {
    expect(cardFor('Perplexity').querySelector('input[aria-label="search.field.model"]')).toBeNull();
    const card = cardFor('Claude');
    typeInto(card, 'search.field.apiKey', 'claude-secret');
    typeInto(card, 'search.field.model', 'claude-custom-model');
    await act(async () => clickSave());
    expect(savedPayload!.providers.claude).toEqual({ apiKey: 'claude-secret', model: 'claude-custom-model' });
    const masked: SearchServerConfig = {
      ...EMPTY_CONFIG, providers: { claude: { apiKeyConfigured: true, model: 'claude-custom-model' } },
    };
    act(() => root!.render(React.createElement(SearchSettingsSection, {
      config: masked, diagnostics: null, busy: false,
      onUpdate: async (search) => { savedPayload = search; },
      onQuery: async (): Promise<SearchQueryOutcome> => ({ ok: false, error: 'unused' }),
    })));
    const restored = cardFor('Claude');
    expect(restored.querySelector<HTMLInputElement>('input[aria-label="search.field.apiKey"]')!.value).toBe('');
    expect(restored.querySelector<HTMLInputElement>('input[aria-label="search.field.model"]')!.value).toBe('claude-custom-model');
    await act(async () => clickSave());
    expect(savedPayload!.providers.claude).toEqual({ model: 'claude-custom-model' });
  });
});
