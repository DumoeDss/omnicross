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
