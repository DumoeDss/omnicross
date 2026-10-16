import type { TourStepDef } from './tourModel';

/**
 * The newcomer path: add an upstream (provider or subscription) → enable the
 * gateway → one-click CLI integration → access keys. Mirrors the README
 * quickstart; the daemon's zero-config onboarding means step 2 already yields
 * a working `omnicross` key, which step 6 explains.
 */
export const TOUR_STEPS: TourStepDef[] = [
  {
    id: 'welcome',
    route: { page: 'overview' },
    // Centered welcome bubble — the overview container is the whole page, so
    // a spotlight there reads as a plain dim backdrop.
    titleKey: 'tour.steps.welcome.title',
    bodyKey: 'tour.steps.welcome.body',
  },
  {
    id: 'add-provider',
    route: { page: 'upstreams' },
    targetSelector: '[data-tour="add-provider"]',
    titleKey: 'tour.steps.addProvider.title',
    bodyKey: 'tour.steps.addProvider.body',
  },
  {
    id: 'add-account',
    route: { page: 'upstreams' },
    targetSelector: '[data-tour="add-account"]',
    titleKey: 'tour.steps.addAccount.title',
    bodyKey: 'tour.steps.addAccount.body',
  },
  {
    id: 'gateway',
    route: { page: 'api-service', tab: 'overview' },
    targetSelector: '[data-tour="gateway-enable"]',
    titleKey: 'tour.steps.gateway.title',
    bodyKey: 'tour.steps.gateway.body',
  },
  {
    id: 'integrate',
    route: { page: 'integrations' },
    targetSelector: '[data-tour="persistent-integrations"]',
    titleKey: 'tour.steps.integrate.title',
    bodyKey: 'tour.steps.integrate.body',
  },
  {
    id: 'access-keys',
    route: { page: 'api-service', tab: 'access' },
    targetSelector: '[data-tour="key-create"]',
    titleKey: 'tour.steps.accessKeys.title',
    bodyKey: 'tour.steps.accessKeys.body',
  },
  {
    id: 'finish',
    titleKey: 'tour.steps.finish.title',
    bodyKey: 'tour.steps.finish.body',
  },
];
