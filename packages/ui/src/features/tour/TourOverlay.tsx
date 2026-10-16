import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

import { buildSpotRect, centerBubble, placeBubble, type BubblePosition } from './tourModel';
import { TOUR_STEPS } from './tourSteps';
import type { UseTourResult } from './useTour';

const SPOT_PADDING = 6;
const BUBBLE_GAP = 12;

/**
 * JIZURA-style tour layer: spotlight rect punched out of a dim backdrop via a
 * huge box-shadow, plus a speech bubble. Read-only — clicking anywhere outside
 * the bubble ends the tour. Sits above Radix dialogs (z-50) and the mobile
 * bottom bar (z-40).
 */
export function TourOverlay({ tour }: { tour: UseTourResult }) {
  const t = useTranslation();
  const step = tour.step;
  const bubbleRef = useRef<HTMLDivElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const [bubbleSize, setBubbleSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (!tour.active) return;
    const el = bubbleRef.current;
    if (!el) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    setBubbleSize((prev) => (prev && prev.width === size.width && prev.height === size.height ? prev : size));
  });

  useEffect(() => {
    if (tour.active) nextButtonRef.current?.focus();
  }, [tour.active, tour.stepIndex]);

  // JIZURA keyboard parity: ←/→ navigate, Enter advances, Esc ends, Tab keeps
  // focus order, everything else is swallowed so app shortcuts can't fire
  // underneath the overlay.
  useEffect(() => {
    if (!tour.active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        tour.end();
      } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        tour.next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopImmediatePropagation();
        tour.prev();
      } else if (event.key !== 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [tour.active, tour.next, tour.prev, tour.end]);

  if (!tour.active || !step) return null;

  const spot = tour.targetRect ? buildSpotRect(tour.targetRect, tour.viewport, SPOT_PADDING) : null;
  const position: BubblePosition | null = bubbleSize
    ? (spot ? placeBubble(spot, bubbleSize, tour.viewport, BUBBLE_GAP) : centerBubble(bubbleSize, tour.viewport))
    : null;

  const total = TOUR_STEPS.length;
  const first = tour.stepIndex === 0;
  const last = tour.stepIndex === total - 1;

  return (
    <div className="fixed inset-0 z-[60]" data-testid="tour-overlay" onClick={tour.end}>
      {spot ? (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: spot.left,
            top: spot.top,
            width: spot.width,
            height: spot.height,
            borderRadius: 12,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-black/50" />
      )}
      <div
        ref={bubbleRef}
        role="dialog"
        aria-modal="true"
        aria-label={t(step.titleKey)}
        data-testid="tour-bubble"
        onClick={(event) => event.stopPropagation()}
        style={{
          position: 'absolute',
          top: position?.top ?? 0,
          left: position?.left ?? 0,
          visibility: position ? 'visible' : 'hidden',
        }}
        className="w-[min(24rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface-0 p-4 shadow-xl"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
          {t('tour.counter', { current: (tour.stepIndex ?? 0) + 1, total })}
        </p>
        <h2 className="mt-1 text-sm font-semibold text-foreground">{t(step.titleKey)}</h2>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{t(step.bodyKey)}</p>
        <footer className="mt-3 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={tour.end}>
            {t('tour.skip')}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={first} onClick={tour.prev}>
              {t('tour.prev')}
            </Button>
            <Button ref={nextButtonRef} variant="default" size="sm" onClick={tour.next}>
              {last ? t('tour.finish') : t('tour.next')}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
