/** @vitest-environment jsdom */

/**
 * SearchTestPanel tests (search-settings-tab, tasks 3.4/3.6c): the operator's
 * typed query reaches `onQuery(providerId, query)`, the returned results
 * render as UNTRUSTED TEXT (a `<img src=x>` sentinel appears literally, never
 * as markup; a `javascript:` URL stays inert text while http/https linkify),
 * and the empty/error/blocked states are distinct. Plus the save-first hint
 * for a typed-but-unsaved key.
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

import type { SearchQueryOutcome } from '@/daemon/types';

import { SearchTestPanel } from '../SearchTestPanel';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: {
  onQuery: (providerId: string, query: string) => Promise<SearchQueryOutcome>;
  saveFirst?: boolean;
  disabled?: boolean;
}): void {
  act(() => {
    root!.render(
      React.createElement(SearchTestPanel, {
        providerId: 'tavily',
        providerName: 'Tavily',
        onQuery: props.onQuery,
        saveFirst: props.saveFirst ?? false,
        disabled: props.disabled ?? false,
      }),
    );
  });
}

function queryInput(): HTMLInputElement {
  const input = container!.querySelector<HTMLInputElement>(
    'input[aria-label="search.test.queryPlaceholder"]',
  );
  expect(input).not.toBeNull();
  return input!;
}

function typeQuery(value: string): void {
  const input = queryInput();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Click the run button (identified by the action label text). */
function clickRun(): void {
  const button = Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes('search.test.action'),
  );
  expect(button, 'the run button must render').toBeDefined();
  act(() => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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

describe('SearchTestPanel — the interactive query', () => {
  it('sends the typed query to onQuery(providerId, query) on button click', async () => {
    const onQuery = vi.fn(async (): Promise<SearchQueryOutcome> => ({
      ok: true,
      result: {
        diagnostic: { providerId: 'tavily', status: 'healthy' },
        resultCount: 0,
        results: [],
      },
    }));
    render({ onQuery });
    typeQuery('omnicross search');
    await act(async () => {
      clickRun();
    });
    expect(onQuery).toHaveBeenCalledWith('tavily', 'omnicross search');
  });

  it('submits on Enter', async () => {
    const onQuery = vi.fn(async (): Promise<SearchQueryOutcome> => ({
      ok: true,
      result: { diagnostic: { providerId: 'tavily', status: 'healthy' }, resultCount: 0, results: [] },
    }));
    render({ onQuery });
    typeQuery('enter key submits');
    await act(async () => {
      queryInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onQuery).toHaveBeenCalledWith('tavily', 'enter key submits');
  });

  it('renders results as UNTRUSTED TEXT — the <img> sentinel appears literally, never as markup', async () => {
    render({
      onQuery: async (): Promise<SearchQueryOutcome> => ({
        ok: true,
        result: {
          diagnostic: { providerId: 'tavily', status: 'healthy' },
          resultCount: 1,
          results: [
            {
              title: '<img src=x onerror=alert(1)> Title',
              url: 'https://result.example.test/a',
              content: 'snippet <script>alert(2)</script>',
            },
          ],
        },
      }),
    });
    typeQuery('anything');
    await act(async () => {
      clickRun();
    });

    // The sentinel survives as literal text…
    expect(container!.textContent).toContain('<img src=x onerror=alert(1)> Title');
    expect(container!.textContent).toContain('<script>alert(2)</script>');
    // …and no img/script ELEMENT was ever created (React text-node escaping is
    // the mechanism; the panel never uses dangerouslySetInnerHTML).
    expect(container!.querySelector('img')).toBeNull();
    expect(container!.querySelector('script')).toBeNull();
    // The provider-used + count status is visible.
    expect(container!.textContent).toContain('search.test.providerUsed:Tavily');
    expect(container!.textContent).toContain('search.testOutcome.count:1');
    // http(s) URLs linkify.
    const anchor = container!.querySelector<HTMLAnchorElement>(
      'a[href="https://result.example.test/a"]',
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.rel).toContain('noreferrer');
  });

  it('keeps a javascript: URL as inert text — never an anchor', async () => {
    render({
      onQuery: async (): Promise<SearchQueryOutcome> => ({
        ok: true,
        result: {
          diagnostic: { providerId: 'tavily', status: 'healthy' },
          resultCount: 1,
          results: [
            { title: 'Hostile title', url: 'javascript:alert(document.domain)', content: 'x' },
          ],
        },
      }),
    });
    typeQuery('anything');
    await act(async () => {
      clickRun();
    });

    expect(container!.textContent).toContain('javascript:alert(document.domain)');
    expect(container!.querySelector('a')).toBeNull();
  });

  it('renders an explicit empty state for healthy-with-zero-results (never a fabricated list)', async () => {
    render({
      onQuery: async (): Promise<SearchQueryOutcome> => ({
        ok: true,
        result: {
          diagnostic: { providerId: 'tavily', status: 'healthy' },
          resultCount: 0,
          results: [],
        },
      }),
    });
    typeQuery('obscure query');
    await act(async () => {
      clickRun();
    });
    expect(container!.textContent).toContain('search.test.empty');
    expect(container!.textContent).not.toContain('search.testOutcome.count');
  });

  it('renders a transport error as a destructive error line (distinct from every diagnostic state)', async () => {
    render({
      onQuery: async (): Promise<SearchQueryOutcome> => ({
        ok: false,
        error: "search provider 'tavily' is not configured",
      }),
    });
    typeQuery('anything');
    await act(async () => {
      clickRun();
    });
    expect(container!.textContent).toContain('search.testOutcome.error');
    expect(container!.textContent).toContain('not configured');
    expect(container!.textContent).not.toContain('search.test.empty');
  });

  it('renders blocked as an honest observation with the doctor reason — not an error, not empty', async () => {
    render({
      onQuery: async (): Promise<SearchQueryOutcome> => ({
        ok: true,
        result: {
          diagnostic: {
            providerId: 'searxng',
            status: 'blocked',
            reason: 'the egress policy refused the request target',
          },
        },
      }),
    });
    typeQuery('internal docs');
    await act(async () => {
      clickRun();
    });
    expect(container!.textContent).toContain('search.status.blocked');
    expect(container!.textContent).toContain('the egress policy refused the request target');
    expect(container!.textContent).not.toContain('search.test.empty');
    expect(container!.textContent).not.toContain('search.testOutcome.error');
  });

  it('renders failed as a destructive diagnostic line', async () => {
    render({
      onQuery: async (): Promise<SearchQueryOutcome> => ({
        ok: true,
        result: {
          diagnostic: { providerId: 'tavily', status: 'failed', reason: 'the request failed (timeout)' },
        },
      }),
    });
    typeQuery('anything');
    await act(async () => {
      clickRun();
    });
    expect(container!.textContent).toContain('search.status.failed');
    expect(container!.textContent).toContain('timeout');
  });

  it('shows the save-first hint and disables the run action for a typed-but-unsaved key', async () => {
    const onQuery = vi.fn(async (): Promise<SearchQueryOutcome> => ({
      ok: true,
      result: { diagnostic: { providerId: 'tavily', status: 'healthy' }, resultCount: 0, results: [] },
    }));
    render({ onQuery, saveFirst: true });
    expect(container!.textContent).toContain('search.test.saveFirst');

    typeQuery('a query that must NOT run');
    const button = Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('search.test.action'),
    );
    expect(button!.disabled).toBe(true);
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onQuery).not.toHaveBeenCalled();
  });
});
