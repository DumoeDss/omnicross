/**
 * LocaleContext shim (design D7) — provides a `useTranslation()` that returns
 * the `t(key, opts)` function DIRECTLY (matching the upstream `LocaleContext`
 * call shape, NOT react-i18next's `{ t }` object). The ported page calls
 * `const t = useTranslation(); t('providerSettings.x')`.
 *
 * `t` returns the key string itself when no translation is found (upstream
 * semantics — `getProviderDisplayName` relies on `t(key) === key` to detect a
 * missing translation).
 */

import { useTranslation as useReactI18nextTranslation } from 'react-i18next';

/**
 * The `t` shape the ported page uses. Matches the upstream's two call forms:
 *   - `t('key')` / `t('key', { count })` — interpolation options
 *   - `t('key', 'Fallback')` — a literal default-value string (used by the
 *     OpenRouter config and a few others). i18next accepts a string as the
 *     `defaultValue`, so we forward it as `{ defaultValue }`.
 */
export type TFunction = (key: string, opts?: Record<string, unknown> | string) => string;

export function useTranslation(): TFunction {
  const { t } = useReactI18nextTranslation();
  return (key: string, opts?: Record<string, unknown> | string): string => {
    const options = typeof opts === 'string' ? { defaultValue: opts } : opts;
    const result = t(key, options as never);
    return typeof result === 'string' ? result : key;
  };
}
