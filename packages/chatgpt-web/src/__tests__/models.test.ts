/**
 * Model-route tests: capability gating and measured context limits.
 *
 * @module @omnicross/chatgpt-web/bridge/__tests__/models.test
 */

import { describe, expect, it } from 'vitest';

import {
  availableChatGptWebModelRoutes,
  buildChatGptWebModelsDocument,
  CHATGPT_WEB_MODEL_ROUTES,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
} from '../bridge/models';

const PRO_ROUTE = CHATGPT_WEB_MODEL_ROUTES.find((route) => route.slug === 'chatgpt-web/pro')!;
const HIGH_ROUTE = CHATGPT_WEB_MODEL_ROUTES.find((route) => route.slug === 'chatgpt-web/high')!;

describe('chatgpt-web model routes', () => {
  it('gates Pro rows behind proAvailable', () => {
    const plus = availableChatGptWebModelRoutes({ solAvailable: true, proAvailable: false });
    expect(plus.map((r) => r.slug)).not.toContain('chatgpt-web/pro');
    const pro = availableChatGptWebModelRoutes({ solAvailable: true, proAvailable: true });
    expect(pro.map((r) => r.slug)).toContain('chatgpt-web/pro');
    expect(() => requireChatGptWebModelRoute('chatgpt-web/pro', { solAvailable: true, proAvailable: false })).toThrow(
      /not available for this account/,
    );
  });

  it('serves Luna routes only for Luna-only accounts', () => {
    const luna = availableChatGptWebModelRoutes({ solAvailable: false, proAvailable: false });
    expect(luna.map((r) => r.slug)).toEqual(['chatgpt-web/luna', 'chatgpt-web/think']);
    expect(() =>
      requireChatGptWebModelRoute('chatgpt-web/luna', { solAvailable: true, proAvailable: true }),
    ).toThrow(/Luna-only/);
  });

  it('maps Pro to Codex ultra effort at slider position 4', () => {
    expect(PRO_ROUTE.codexEffort).toBe('ultra');
    expect(PRO_ROUTE.adapterEffort).toBe('max');
    expect(PRO_ROUTE.uiEffortIndex).toBe(4);
  });

  it('resolves Plus vs Pro context limits per effort', () => {
    const plusHigh = resolveChatGptWebContextLimits(HIGH_ROUTE, { solAvailable: true, proAvailable: false });
    expect(plusHigh.contextWindow).toBe(90_000);
    const proHigh = resolveChatGptWebContextLimits(HIGH_ROUTE, { solAvailable: true, proAvailable: true });
    expect(proHigh.contextWindow).toBeGreaterThan(plusHigh.contextWindow);
    const proMax = resolveChatGptWebContextLimits(PRO_ROUTE, { solAvailable: true, proAvailable: true });
    expect(proMax.contextWindow).toBeGreaterThan(proHigh.contextWindow);
    expect(proMax.effectiveContextWindowPercent).toBeLessThanOrEqual(100);
  });

  it('builds a /v1/models document in the native codex catalog shape', () => {
    const document = buildChatGptWebModelsDocument({ solAvailable: true, proAvailable: true });
    // codex's models manager decodes {"models":[…]}, not the public OpenAI list envelope.
    expect(Array.isArray(document['models'])).toBe(true);
    const rows = document['models'] as Array<Record<string, unknown>>;
    const slugs = rows.map((entry) => entry['slug']);
    expect(slugs).toContain('chatgpt-web/pro');
    expect(slugs).not.toContain('chatgpt-web/luna');
    const pro = rows.find((entry) => entry['slug'] === 'chatgpt-web/pro')!;
    expect(pro['default_reasoning_level']).toBe('ultra');
    expect(pro['visibility']).toBe('list');
    expect(typeof pro['context_window']).toBe('number');
  });

  it('rejects unknown models explicitly', () => {
    expect(() => requireChatGptWebModelRoute('chatgpt-web/what', { solAvailable: true, proAvailable: true })).toThrow(
      /Unknown ChatGPT Web model/,
    );
  });
});
