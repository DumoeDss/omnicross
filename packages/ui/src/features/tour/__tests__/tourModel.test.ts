import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import zh from '../../../i18n/zh.json';
import zhHant from '../../../i18n/zh-Hant.json';
import {
  buildSpotRect,
  centerBubble,
  isRouteCurrent,
  placeBubble,
  readSeenFlag,
  resolveStep,
  writeSeenFlag,
  type TourRect,
  type TourViewport,
} from '../tourModel';
import { TOUR_STEPS } from '../tourSteps';

type Json = Record<string, unknown>;

const viewport: TourViewport = { width: 1000, height: 700 };

function resolveKey(root: Json, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, segment) =>
      node != null && typeof node === 'object' ? (node as Json)[segment] : undefined,
    root,
  );
}

describe('spot geometry', () => {
  it('pads the target rect and clamps at the viewport edges', () => {
    const target: TourRect = { left: 100, top: 100, width: 200, height: 50 };
    expect(buildSpotRect(target, viewport)).toEqual({ left: 94, top: 94, width: 212, height: 62 });
  });

  it('clamps a target poking past the right/bottom edge', () => {
    const target: TourRect = { left: 990, top: 690, width: 100, height: 40 };
    expect(buildSpotRect(target, viewport)).toEqual({ left: 984, top: 684, width: 12, height: 12 });
  });

  it('never produces a negative size', () => {
    const offscreen: TourRect = { left: -500, top: -500, width: 100, height: 100 };
    const spot = buildSpotRect(offscreen, viewport);
    expect(spot.width).toBe(0);
    expect(spot.height).toBe(0);
  });
});

describe('bubble placement', () => {
  const bubble = { width: 300, height: 120 };

  it('places below when it fits', () => {
    const spot: TourRect = { left: 400, top: 100, width: 200, height: 40 };
    expect(placeBubble(spot, bubble, viewport)).toEqual({ top: 152, left: 350 });
  });

  it('flips above near the viewport bottom', () => {
    const lowSpot: TourRect = { left: 400, top: 620, width: 200, height: 40 };
    expect(placeBubble(lowSpot, bubble, viewport).top).toBe(488);
  });

  it('pins to the viewport bottom when it fits neither side', () => {
    const spot: TourRect = { left: 400, top: 100, width: 200, height: 40 };
    expect(placeBubble(spot, { width: 300, height: 600 }, viewport).top).toBe(92);
  });

  it('clamps horizontally for a left-edge target', () => {
    const edgeSpot: TourRect = { left: 0, top: 100, width: 40, height: 40 };
    expect(placeBubble(edgeSpot, bubble, viewport).left).toBe(8);
  });

  it('centers when there is no target', () => {
    expect(centerBubble(bubble, viewport)).toEqual({ top: 290, left: 350 });
  });
});

describe('step resolution and routing', () => {
  it('resolves steps and rejects out-of-bounds indices', () => {
    expect(resolveStep(TOUR_STEPS, 0)?.id).toBe('welcome');
    expect(resolveStep(TOUR_STEPS, TOUR_STEPS.length - 1)?.id).toBe('finish');
    expect(resolveStep(TOUR_STEPS, TOUR_STEPS.length)).toBeNull();
    expect(resolveStep(TOUR_STEPS, -1)).toBeNull();
  });

  it('matches the current route on page and tab, with the api-service default tab', () => {
    expect(isRouteCurrent(undefined, { page: 'settings' })).toBe(true);
    expect(isRouteCurrent({ page: 'upstreams' }, { page: 'upstreams' })).toBe(true);
    expect(isRouteCurrent({ page: 'upstreams' }, { page: 'overview' })).toBe(false);
    // an absent api-service tab reads as 'overview' (NavRail convention)
    expect(isRouteCurrent({ page: 'api-service', tab: 'overview' }, { page: 'api-service' })).toBe(true);
    expect(isRouteCurrent({ page: 'api-service', tab: 'overview' }, { page: 'api-service', tab: 'access' })).toBe(false);
  });

  it('keeps every step key resolvable in the three maintained locales', () => {
    for (const step of TOUR_STEPS) {
      expect(resolveKey(en as Json, step.titleKey), `en title ${step.titleKey}`).toBeTypeOf('string');
      expect(resolveKey(en as Json, step.bodyKey), `en body ${step.bodyKey}`).toBeTypeOf('string');
      expect(resolveKey(zh as Json, step.titleKey), `zh title ${step.titleKey}`).toBeTypeOf('string');
      expect(resolveKey(zh as Json, step.bodyKey), `zh body ${step.bodyKey}`).toBeTypeOf('string');
      expect(resolveKey(zhHant as Json, step.titleKey), `zh-Hant title ${step.titleKey}`).toBeTypeOf('string');
      expect(resolveKey(zhHant as Json, step.bodyKey), `zh-Hant body ${step.bodyKey}`).toBeTypeOf('string');
    }
  });
});

describe('seen flag', () => {
  function memoryStorage() {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
  }

  it('round-trips through the injected storage', () => {
    const storage = memoryStorage();
    expect(readSeenFlag(storage)).toBe(false);
    writeSeenFlag(storage);
    expect(readSeenFlag(storage)).toBe(true);
  });

  it('treats unreadable storage as seen and swallows write failures', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSeenFlag(throwing)).toBe(true);
    expect(() => writeSeenFlag(throwing)).not.toThrow();
  });
});
