/**
 * Egress-funnel guard (upstream-proxy, task 3.5) — every upstream egress site in
 * the ingress layer + the Gemini Code Assist handshake MUST route through
 * `fetchUpstream`, never a bare `fetch(`. A missed site silently bypasses the
 * proxy; this source-scan catches a regression that reintroduces a bare `fetch(`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ingressDir = join(here, '..');
const coreSrc = join(ingressDir, '..', '..');

/** Files that perform upstream egress and MUST funnel through `fetchUpstream`. */
const EGRESS_FILES = [
  join(ingressDir, 'anthropicMessagesByo.ts'),
  join(ingressDir, 'anthropicSubscriptionPlan.ts'),
  join(ingressDir, 'openaiChatIngress.ts'),
  join(ingressDir, 'openaiResponsesIngress.ts'),
  join(ingressDir, 'geminiGenerateContentIngress.ts'),
  join(coreSrc, 'auth', 'GeminiCodeAssistProjectResolver.ts'),
];

/** Strip `fetchUpstream(` so only a BARE `fetch(` would remain to match. */
function bareFetchCount(source: string): number {
  const withoutHelper = source.replace(/fetchUpstream\(/g, '');
  return (withoutHelper.match(/\bfetch\(/g) ?? []).length;
}

describe('upstream egress funnels through fetchUpstream', () => {
  for (const file of EGRESS_FILES) {
    it(`${file.split(/[/\\]/).pop()} has no bare fetch( egress`, () => {
      const source = readFileSync(file, 'utf8');
      expect(bareFetchCount(source)).toBe(0);
      expect(source).toContain('fetchUpstream');
    });
  }
});
