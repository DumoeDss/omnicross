/**
 * formatResetCountdown tests — the compact locale-free countdown rendered on
 * every allowance/quota window card.
 */

import { describe, expect, it } from 'vitest';

import { formatResetCountdown } from '../AllowanceWindowBar';

describe('formatResetCountdown', () => {
  it('formats sub-minute remains', () => {
    expect(formatResetCountdown(0)).toBe('<1m');
    expect(formatResetCountdown(59_000)).toBe('<1m');
  });

  it('formats minutes', () => {
    expect(formatResetCountdown(60_000)).toBe('1m');
    expect(formatResetCountdown(45 * 60_000)).toBe('45m');
  });

  it('formats hours with minute remainder', () => {
    expect(formatResetCountdown(83 * 60_000)).toBe('1h 23m');
    expect(formatResetCountdown(2 * 60 * 60_000)).toBe('2h');
  });

  it('formats days with hour remainder', () => {
    expect(formatResetCountdown((24 + 4) * 60 * 60_000)).toBe('1d 4h');
    expect(formatResetCountdown(3 * 24 * 60 * 60_000)).toBe('3d');
  });

  it('renders zero-length remains without going negative', () => {
    expect(formatResetCountdown(-5_000)).toBe('<1m');
  });
});
