/** @vitest-environment jsdom */
import React, { useEffect } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppRoute } from '@/shared/state/hashRoute';

vi.mock('@/shared/state/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));

import { findTourTarget, TOUR_SEEN_KEY } from '../tourModel';
import { TOUR_STEPS } from '../tourSteps';
import { TourOverlay } from '../TourOverlay';
import { useTour } from '../useTour';

const navigate = vi.fn();
const route: AppRoute = { page: 'overview' };

function Harness({ startIndex }: { startIndex: number }) {
  const tour = useTour({ route, navigate });
  const start = tour.start;
  useEffect(() => {
    if (startIndex >= 0) start(startIndex);
  }, [startIndex, start]);
  return <TourOverlay tour={tour} />;
}

let container: HTMLDivElement;
let root: Root;
function renderTour(startIndex: number) {
  act(() => root.render(<Harness startIndex={startIndex} />));
}
function overlay() {
  return container.querySelector('[data-testid="tour-overlay"]');
}
function bubble() {
  return container.querySelector('[data-testid="tour-bubble"]');
}
function buttonWithText(text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;
}
function click(button: HTMLButtonElement | null) {
  act(() => {
    button?.click();
  });
}
function pressKey(key: string) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeEach(() => {
  // Suppress the first-run auto-start unless a test is explicitly exercising it.
  window.localStorage.setItem(TOUR_SEEN_KEY, '1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('TourOverlay', () => {
  it('renders the requested step and navigates to its page', () => {
    renderTour(1);
    expect(overlay()).not.toBeNull();
    expect(bubble()?.textContent).toContain('tour.steps.addProvider.title');
    expect(bubble()?.textContent).toContain('tour.steps.addProvider.body');
    expect(navigate).toHaveBeenCalledWith({ page: 'upstreams' }, { replace: true });
  });

  it('walks forward and back through the steps', () => {
    renderTour(0);
    click(buttonWithText('tour.next'));
    expect(bubble()?.textContent).toContain('tour.steps.addProvider.title');
    click(buttonWithText('tour.next'));
    expect(bubble()?.textContent).toContain('tour.steps.addAccount.title');
    click(buttonWithText('tour.prev'));
    expect(bubble()?.textContent).toContain('tour.steps.addProvider.title');
  });

  it('disables prev on the first step and finishes into the seen flag', () => {
    renderTour(0);
    expect(buttonWithText('tour.prev')?.disabled).toBe(true);
    renderTour(TOUR_STEPS.length - 1);
    expect(buttonWithText('tour.finish')).not.toBeNull();
    click(buttonWithText('tour.finish'));
    expect(overlay()).toBeNull();
    expect(window.localStorage.getItem(TOUR_SEEN_KEY)).toBe('1');
  });

  it('navigates by keyboard and ends on Escape', () => {
    renderTour(0);
    pressKey('ArrowRight');
    expect(bubble()?.textContent).toContain('tour.steps.addProvider.title');
    pressKey('ArrowLeft');
    expect(bubble()?.textContent).toContain('tour.steps.welcome.title');
    pressKey('Escape');
    expect(overlay()).toBeNull();
    expect(window.localStorage.getItem(TOUR_SEEN_KEY)).toBe('1');
  });

  it('swallows unrelated keys without closing', () => {
    renderTour(0);
    pressKey('x');
    expect(overlay()).not.toBeNull();
  });

  it('ends on a backdrop click', () => {
    renderTour(0);
    const el = overlay();
    expect(el).not.toBeNull();
    act(() => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(overlay()).toBeNull();
  });

  it('auto-starts once for first-time visitors', () => {
    vi.useFakeTimers();
    window.localStorage.removeItem(TOUR_SEEN_KEY);
    renderTour(-1);
    expect(overlay()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(overlay()).not.toBeNull();
    // seen only becomes true once the visitor finishes or skips
    expect(window.localStorage.getItem(TOUR_SEEN_KEY)).toBeNull();
  });

  it('skips the auto-start for returning visitors', () => {
    vi.useFakeTimers();
    renderTour(-1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(overlay()).toBeNull();
  });
});

describe('target resolution', () => {
  it('ignores hidden and zero-size elements when resolving a selector', () => {
    const el = document.createElement('button');
    el.setAttribute('data-tour', 'gateway-enable');
    document.body.appendChild(el);
    // jsdom has no layout: zero rect reads as not-yet-rendered
    expect(findTourTarget('[data-tour="gateway-enable"]')).toBeNull();

    el.getBoundingClientRect = (() => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30, x: 10, y: 10, toJSON: () => ({}) })) as typeof el.getBoundingClientRect;
    expect(findTourTarget('[data-tour="gateway-enable"]')).toBe(el);

    // ApiServicePage keeps both tab panels mounted and toggles `hidden`
    el.setAttribute('hidden', '');
    expect(findTourTarget('[data-tour="gateway-enable"]')).toBeNull();
    el.remove();
  });
});
