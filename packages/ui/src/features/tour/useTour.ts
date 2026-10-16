import { useCallback, useEffect, useState } from 'react';

import type { AppRoute, RouteNavigate } from '@/shared/state/hashRoute';

import {
  AUTO_SHOW_DELAY_MS,
  TARGET_POLL_INTERVAL_MS,
  TARGET_POLL_TIMEOUT_MS,
  elementRect,
  findTourTarget,
  isRouteCurrent,
  readSeenFlag,
  readViewport,
  writeSeenFlag,
  type TourRect,
  type TourStepDef,
  type TourViewport,
} from './tourModel';
import { TOUR_STEPS } from './tourSteps';

export interface UseTourOptions {
  route: AppRoute;
  navigate: RouteNavigate;
}

export interface UseTourResult {
  active: boolean;
  stepIndex: number | null;
  step: TourStepDef | null;
  /** Viewport-space rect of the spotlight target; null centers the bubble. */
  targetRect: TourRect | null;
  viewport: TourViewport;
  start(index?: number): void;
  next(): void;
  prev(): void;
  end(): void;
}

export function useTour({ route, navigate }: UseTourOptions): UseTourResult {
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [targetRect, setTargetRect] = useState<TourRect | null>(null);
  const [viewport, setViewport] = useState<TourViewport>(readViewport);

  // First visit: open the tour once, shortly after the shell settles, unless
  // some dialog beat us to the screen (e.g. the mobile "more" sheet).
  useEffect(() => {
    if (readSeenFlag()) return undefined;
    const timer = setTimeout(() => {
      if (typeof document !== 'undefined' && document.querySelector('[role="dialog"][data-state="open"]')) return;
      setStepIndex(0);
    }, AUTO_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Per-step: navigate to the step's page, then poll for the spotlight target —
  // data-gated pages (gateway, access keys) render their targets only after the
  // daemon answers, and a dead daemon means the target never shows (→ centered
  // fallback bubble after the timeout, so the tour still finishes).
  useEffect(() => {
    if (stepIndex === null) return undefined;
    setTargetRect(null);
    const stepDef = TOUR_STEPS[stepIndex];
    if (!stepDef) return undefined;

    if (!isRouteCurrent(stepDef.route, route)) {
      navigate(stepDef.route as AppRoute, { replace: true });
    }

    let cancelled = false;
    const measure = (): TourRect | null => {
      if (!stepDef.targetSelector || typeof document === 'undefined') return null;
      const el = findTourTarget(stepDef.targetSelector);
      if (!el) return null;
      el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      return elementRect(el);
    };

    const immediate = measure();
    if (immediate) {
      setTargetRect(immediate);
      return () => {
        cancelled = true;
      };
    }
    let elapsed = 0;
    const timer = setInterval(() => {
      if (cancelled) return;
      elapsed += TARGET_POLL_INTERVAL_MS;
      const rect = measure();
      if (rect) {
        clearInterval(timer);
        setTargetRect(rect);
      } else if (elapsed >= TARGET_POLL_TIMEOUT_MS) {
        clearInterval(timer);
        setTargetRect(null);
      }
    }, TARGET_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // route/navigate are deliberately not deps: one navigation per step entry.
  }, [stepIndex]);

  // Reposition on window resize, any scroll (capture — the pages scroll in
  // nested containers), and element resizes (DaemonStatusBanner mounting or
  // clearing shifts everything with no scroll/resize event at all).
  useEffect(() => {
    if (stepIndex === null) return undefined;
    const selector = TOUR_STEPS[stepIndex]?.targetSelector;
    const refresh = () => {
      setViewport(readViewport());
      if (!selector || typeof document === 'undefined') return;
      const el = findTourTarget(selector);
      // A transient miss keeps the last rect; a permanent one (step change) is
      // reset by the effect above.
      if (el) setTargetRect(elementRect(el));
    };
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && typeof document !== 'undefined') {
      observer = new ResizeObserver(refresh);
      observer.observe(document.body);
    }
    return () => {
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      observer?.disconnect();
    };
  }, [stepIndex]);

  const start = useCallback((index = 0) => {
    setStepIndex(Math.min(Math.max(index, 0), TOUR_STEPS.length - 1));
  }, []);

  const next = useCallback(() => {
    setStepIndex((current) => {
      if (current === null) return null;
      if (current >= TOUR_STEPS.length - 1) {
        writeSeenFlag();
        return null;
      }
      return current + 1;
    });
  }, []);

  const prev = useCallback(() => {
    setStepIndex((current) => (current === null ? null : Math.max(0, current - 1)));
  }, []);

  const end = useCallback(() => {
    setStepIndex(null);
    writeSeenFlag();
  }, []);

  return {
    active: stepIndex !== null,
    stepIndex,
    step: stepIndex === null ? null : (TOUR_STEPS[stepIndex] ?? null),
    targetRect,
    viewport,
    start,
    next,
    prev,
    end,
  };
}
