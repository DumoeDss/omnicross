/**
 * zaiRateLimitDetection tests — the GLM business-code dialect: window walls
 * (1316/1317/1308/1310 with `{next_flush_time}` stamps), account diagnostics
 * (1309/1113/1313/1311), both body shapes (anthropic envelope + bare OpenAI
 * wire), and the strict no-ops (1302/1305, past stamps, junk).
 */

import { describe, expect, it } from 'vitest';

import { isZaiQuotaHost, parseZaiRateLimitError } from '../zaiRateLimitDetection';

const NOW = Date.parse('2026-11-12T10:00:00.000Z');

function anthropicBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message, type: 'rate_limit_error' }, type: 'error' });
}

describe('isZaiQuotaHost', () => {
  it('accepts both GLM hosts on any scheme', () => {
    expect(isZaiQuotaHost('https://api.z.ai/api/anthropic/v1/messages')).toBe(true);
    expect(isZaiQuotaHost('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isZaiQuotaHost('https://api.deepseek.com/v1/chat/completions')).toBe(false);
    expect(isZaiQuotaHost('https://evil.api.z.ai.example.com/api/anthropic')).toBe(false);
    expect(isZaiQuotaHost('not a url')).toBe(false);
  });
});

describe('parseZaiRateLimitError — window walls', () => {
  it('maps 1316 (zh) to the 5-hour window with the stamped reset', () => {
    const observation = parseZaiRateLimitError(
      anthropicBody(
        '1316',
        '已达到 5 小时使用上限。主账号余额不足，无法使用超额按量付费。您的限额将在 2026-11-12T20:00:05+08:00 重置。',
      ),
      NOW,
    );
    expect(observation).toEqual({
      windows: [{ windowMinutes: 300, resetsAtMs: Date.parse('2026-11-12T20:00:05+08:00'), usedPercent: 100 }],
    });
  });

  it('maps 1317 (en) to the 7-day window', () => {
    const observation = parseZaiRateLimitError(
      anthropicBody(
        '1317',
        'Usage limit reached for the past 7 days. Insufficient balance for extra usage. Resets at 2026-11-15T00:00:00Z.',
      ),
      NOW,
    );
    expect(observation?.windows[0]?.windowMinutes).toBe(7 * 24 * 60);
    expect(observation?.windows[0]?.resetsAtMs).toBe(Date.parse('2026-11-15T00:00:00Z'));
  });

  it('derives 1308 length from the zh `{number} {unit}` phrase', () => {
    const observation = parseZaiRateLimitError(
      anthropicBody('1308', '已达到 1 周 的使用上限。您的限额将在 2026-11-13T00:00:00+08:00 重置'),
      NOW,
    );
    expect(observation?.windows[0]?.windowMinutes).toBe(7 * 24 * 60);
  });

  it('derives 1308 length from the en phrase with backticked placeholders', () => {
    const observation = parseZaiRateLimitError(
      anthropicBody(
        '1308',
        'Usage limit reached for `5` `hours`. Your limit will reset at 2026-11-12T20:00:00+08:00',
      ),
      NOW,
    );
    expect(observation?.windows[0]?.windowMinutes).toBe(300);
  });

  it('keeps an unknown-length 1308 window when no phrase parses', () => {
    const observation = parseZaiRateLimitError(
      anthropicBody('1308', '您已达到使用上限。您的限额将在 2026-11-13T02:00:00+08:00 重置。'),
      NOW,
    );
    expect(observation).toEqual({
      windows: [{ resetsAtMs: Date.parse('2026-11-13T02:00:00+08:00'), usedPercent: 100 }],
    });
  });

  it('classifies 1310 weekly vs monthly from the wording', () => {
    const weekly = parseZaiRateLimitError(
      anthropicBody('1310', '您已达到每周使用上限，您的限额将在 2026-11-16T00:00:00+08:00 重置'),
      NOW,
    );
    expect(weekly?.windows[0]?.windowMinutes).toBe(7 * 24 * 60);
    const monthly = parseZaiRateLimitError(
      anthropicBody('1310', 'Weekly/Monthly Limit Exhausted — monthly. Resets at 2026-11-30T00:00:00Z.'),
      NOW,
    );
    expect(monthly?.windows[0]?.windowMinutes).toBe(30 * 24 * 60);
  });

  it('parses the bare OpenAI-wire shape `{code, message}`', () => {
    const observation = parseZaiRateLimitError(
      JSON.stringify({
        code: '1113',
        message: '余额不足或无可用资源包，请充值。您的限额将在 2026-11-12T20:00:00+08:00 重置。',
      }),
      NOW,
    );
    // 1113 is diagnostic-only regardless of any stamp in the message.
    expect(observation).toEqual({ windows: [], diagnostic: 'zai_insufficient_balance' });
  });
});

describe('parseZaiRateLimitError — diagnostics', () => {
  it.each([
    ['1309', 'zai_plan_expired'],
    ['1113', 'zai_insufficient_balance'],
    ['1313', 'zai_fair_use_limited'],
    ['1311', 'zai_model_not_included'],
  ] as const)('maps %s to %s without needing a reset stamp', (code, diagnostic) => {
    expect(parseZaiRateLimitError(anthropicBody(code, '上游拒绝'), NOW)).toEqual({
      windows: [],
      diagnostic,
    });
  });
});

describe('parseZaiRateLimitError — no-ops and defenses', () => {
  it('returns null for concurrency/overload codes (no quota evidence)', () => {
    expect(parseZaiRateLimitError(anthropicBody('1302', '您的账户已达到速率限制'), NOW)).toBeNull();
    expect(parseZaiRateLimitError(anthropicBody('1305', '访问量过大，请稍后再试'), NOW)).toBeNull();
  });

  it('returns null for unknown codes, junk, and non-JSON bodies', () => {
    expect(parseZaiRateLimitError(anthropicBody('9999', 'whatever'), NOW)).toBeNull();
    expect(parseZaiRateLimitError('429 Too Many Requests', NOW)).toBeNull();
    expect(parseZaiRateLimitError(null, NOW)).toBeNull();
    expect(parseZaiRateLimitError('{"error":{"code":"not-digits"}}', NOW)).toBeNull();
  });

  it('drops a window whose stamp is already in the past', () => {
    const observation = parseZaiRateLimitError(
      anthropicBody('1316', '已达到 5 小时使用上限。您的限额将在 2026-11-12T08:00:00+00:00 重置。'),
      NOW,
    );
    expect(observation).toBeNull();
  });

  it('falls back to a bare epoch stamp for the reset instant', () => {
    const futureSeconds = Math.floor((NOW + 90 * 60_000) / 1000);
    const observation = parseZaiRateLimitError(
      anthropicBody('1316', `已达到 5 小时使用上限。您的限额将在 ${futureSeconds} 重置。`),
      NOW,
    );
    expect(observation?.windows[0]?.resetsAtMs).toBe(futureSeconds * 1000);
  });
});
