import type { AppRoute } from '@/shared/state/hashRoute';

export interface TourRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TourViewport {
  width: number;
  height: number;
}

export interface BubblePosition {
  top: number;
  left: number;
}

export interface TourStepDef {
  id: string;
  /** Page to show while this step is up; omitted means "stay wherever you are". */
  route?: AppRoute;
  /** `[data-tour="…"]` selector of the element to spotlight; omitted centers the bubble. */
  targetSelector?: string;
  titleKey: string;
  bodyKey: string;
}

export const TOUR_SEEN_KEY = 'omnicross:tour-seen';
export const AUTO_SHOW_DELAY_MS = 800;
export const TARGET_POLL_INTERVAL_MS = 50;
export const TARGET_POLL_TIMEOUT_MS = 4000;

/** Edge margins, JIZURA parity: the spot stays 4px inside the viewport, the bubble 8px. */
const SPOT_EDGE = 4;
const BUBBLE_EDGE = 8;

/** Spotlight rect around the target, clamped into the viewport. */
export function buildSpotRect(target: TourRect, viewport: TourViewport, padding = 6): TourRect {
  const left = Math.max(SPOT_EDGE, target.left - padding);
  const top = Math.max(SPOT_EDGE, target.top - padding);
  const right = Math.min(viewport.width - SPOT_EDGE, target.left + target.width + padding);
  const bottom = Math.min(viewport.height - SPOT_EDGE, target.top + target.height + padding);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Bubble placement below the spot, then above, then pinned to the viewport
 * bottom — always horizontally centered on the spot and clamped inside.
 */
export function placeBubble(
  spot: TourRect,
  bubble: { width: number; height: number },
  viewport: TourViewport,
  gap = 12,
): BubblePosition {
  let top: number;
  if (spot.top + spot.height + gap + bubble.height <= viewport.height - BUBBLE_EDGE) {
    top = spot.top + spot.height + gap;
  } else if (spot.top - gap - bubble.height >= BUBBLE_EDGE) {
    top = spot.top - gap - bubble.height;
  } else {
    top = Math.max(BUBBLE_EDGE, viewport.height - bubble.height - BUBBLE_EDGE);
  }
  const maxLeft = Math.max(BUBBLE_EDGE, viewport.width - bubble.width - BUBBLE_EDGE);
  return { top, left: Math.min(maxLeft, Math.max(BUBBLE_EDGE, spot.left + spot.width / 2 - bubble.width / 2)) };
}

/** No-target fallback: dead center, clamped. */
export function centerBubble(bubble: { width: number; height: number }, viewport: TourViewport): BubblePosition {
  return {
    top: Math.max(BUBBLE_EDGE, Math.round((viewport.height - bubble.height) / 2)),
    left: Math.max(BUBBLE_EDGE, Math.round((viewport.width - bubble.width) / 2)),
  };
}

export function resolveStep(steps: TourStepDef[], index: number): TourStepDef | null {
  return steps[index] ?? null;
}

/** The tour only ever moves page + tab; api-service reads an absent tab as
 *  'overview', mirroring NavRail's itemIsActive. */
export function isRouteCurrent(stepRoute: AppRoute | undefined, current: AppRoute): boolean {
  if (!stepRoute) return true;
  if (stepRoute.page !== current.page) return false;
  const wantTab = stepRoute.page === 'api-service' ? (stepRoute.tab ?? 'overview') : stepRoute.tab;
  const haveTab = current.page === 'api-service' ? (current.tab ?? 'overview') : current.tab;
  return (wantTab ?? undefined) === (haveTab ?? undefined);
}

export function readSeenFlag(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    return (storage ?? window.localStorage).getItem(TOUR_SEEN_KEY) === '1';
  } catch {
    // Unreadable storage (private mode etc.): treat as seen so the tour does
    // not nag on every launch; the nav-rail entry still works.
    return true;
  }
}

export function writeSeenFlag(storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? window.localStorage).setItem(TOUR_SEEN_KEY, '1');
  } catch {
    // best-effort persistence; the tour still closes
  }
}

/**
 * Targets must be laid out and actually shown: ApiServicePage keeps BOTH
 * tab panels mounted and toggles the `hidden` attribute, so a bare
 * querySelector would happily resolve the switch on the inactive panel.
 */
export function isElementTargetable(el: Element): boolean {
  if (el.hasAttribute('hidden')) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
  return true;
}

export function findTourTarget(selector: string, root: Document | Element = document): Element | null {
  if (typeof document === 'undefined') return null;
  const el = root.querySelector(selector);
  return el && isElementTargetable(el) ? el : null;
}

export function elementRect(el: Element): TourRect {
  const rect = el.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function readViewport(): TourViewport {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}
