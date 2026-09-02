/** @vitest-environment jsdom */

/**
 * SearchSection stale-refresh guard (review round 1, M1): the API Service page
 * re-fetches the whole server config after ANY section's write, so this
 * section must NOT re-seed its local draft from a config whose search segment
 * is unchanged — a sibling save would otherwise silently discard unsaved
 * search edits. A changed segment (our own save, or an external edit) still
 * re-seeds.
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

import type { SearchDiagnosticsSnapshot, SearchServerConfig, SearchTestOutcome } from '@/daemon/types';

import { SearchSection } from '../SearchSection';

// A configured tavily (marker view) so the key input actually renders — the
// typed value simulates rotating the stored key.
const SEARCH_A: SearchServerConfig = {
  modes: { codex: 'off', responses: 'native', anthropic: 'native' },
  providers: { tavily: { apiKeyConfigured: true } },
  egress: { allowedPrivateHosts: [] },
  policy: { fallbackEnabled: true },
};

/** The post-save shape: the save ALSO enabled jina — a genuinely new segment. */
const SEARCH_AFTER_SAVE: SearchServerConfig = {
  modes: { codex: 'off', responses: 'native', anthropic: 'native' },
  providers: { tavily: { apiKeyConfigured: true }, jina: {} },
  egress: { allowedPrivateHosts: [] },
  policy: { fallbackEnabled: true },
};

const NO_DIAGNOSTICS: SearchDiagnosticsSnapshot | null = null;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: {
  config: SearchServerConfig | undefined;
  onUpdate?: () => Promise<void>;
}): void {
  act(() => {
    root!.render(
      React.createElement(SearchSection, {
        config: props.config,
        diagnostics: NO_DIAGNOSTICS,
        busy: false,
        onUpdate: props.onUpdate ?? (async () => undefined),
        onTest: async (): Promise<SearchTestOutcome> => ({ ok: false, error: 'unused' }),
      }),
    );
  });
}

/** Type into the (write-only) tavily key input, React-compatible. */
function typeIntoTavilyKey(value: string): void {
  const input = container!.querySelector<HTMLInputElement>(
    'input[aria-label="apiService.search.field.apiKey"]',
  );
  expect(input).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input!, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function tavilyKeyValue(): string {
  const input = container!.querySelector<HTMLInputElement>(
    'input[aria-label="apiService.search.field.apiKey"]',
  );
  return input?.value ?? '';
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  container = null;
  root = null;
});

describe('SearchSection stale-refresh guard (review M1)', () => {
  it('preserves a dirty draft when a sibling save refreshes the config with an UNCHANGED search segment', () => {
    render({ config: SEARCH_A });
    typeIntoTavilyKey('TYPED_BUT_UNSAVED_KEY');

    // A sibling section's save: refreshAll produced a NEW config object whose
    // search segment is content-identical.
    render({ config: { ...SEARCH_A } });

    expect(tavilyKeyValue()).toBe('TYPED_BUT_UNSAVED_KEY');
  });

  it('re-seeds the draft when the search segment itself changed (our own save)', () => {
    render({ config: SEARCH_A });
    typeIntoTavilyKey('TYPED_BUT_UNSAVED_KEY');

    // Our save succeeded: the daemon normalized the PUT into a NEW segment
    // (tavily now carries a stored key) and the re-fetch shows it.
    render({ config: SEARCH_AFTER_SAVE });

    // The write-only input is cleared by the re-seed (blank-keeps semantics
    // for the now-stored key), and the card reflects the configured state.
    expect(tavilyKeyValue()).toBe('');
    expect(container!.textContent).toContain('Tavily');
  });

  it('still re-seeds on an external search edit (segment changed without a local save)', () => {
    render({ config: SEARCH_A });
    typeIntoTavilyKey('TYPED_BUT_UNSAVED_KEY');

    render({ config: SEARCH_AFTER_SAVE });
    expect(tavilyKeyValue()).toBe('');
  });
});
