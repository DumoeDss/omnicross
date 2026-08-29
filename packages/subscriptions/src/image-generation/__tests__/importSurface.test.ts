import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ImageProvider } from '@omnicross/core/image-generation';
import * as subscriptions from '../../index';

describe('subscription image import surface', () => {
  it('exports the provider factory but no private wire names or adapter class', () => {
    expect(subscriptions.createCodexSubscriptionImageProvider).toEqual(expect.any(Function));
    const keys = Object.keys(subscriptions);
    expect(keys.join(' ')).not.toMatch(/privateWire|CANDIDATE_CODEX_IMAGE_URL/);
    expect(keys).not.toContain('CodexSubscriptionImageProvider');
    const barrel = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    expect(barrel).not.toMatch(/privateWire/);
  });

  it('returns only the core-facing ImageProvider contract', () => {
    expectTypeOf(subscriptions.createCodexSubscriptionImageProvider).returns.toMatchTypeOf<ImageProvider>();
  });

  it('records the unverified production capability matrix', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('Unverified / unavailable');
    expect(readme).toContain('Partial image stream');
    expect(readme).toContain('Usage and revised prompt');
    expect(readme).toContain('does not upgrade any row');
  });
});
