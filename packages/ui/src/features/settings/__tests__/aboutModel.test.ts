import { describe, expect, it } from 'vitest';

import { resolveAboutVersion } from '../aboutModel';

describe('resolveAboutVersion', () => {
  it('prefers the desktop bundle version over the daemon health version', () => {
    expect(resolveAboutVersion('0.4.3', '0.4.2')).toBe('0.4.3');
  });

  it('falls back to the daemon health version in the browser UI', () => {
    expect(resolveAboutVersion(undefined, '0.4.3')).toBe('0.4.3');
    expect(resolveAboutVersion(undefined, null)).toBeUndefined();
  });

  it('treats blank/whitespace versions as unknown', () => {
    expect(resolveAboutVersion('', '0.4.3')).toBe('0.4.3');
    expect(resolveAboutVersion('  ', '  ')).toBeUndefined();
    expect(resolveAboutVersion(undefined, ' ')).toBeUndefined();
  });
});
