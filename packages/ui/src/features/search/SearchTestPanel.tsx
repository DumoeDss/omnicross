/**
 * SearchTestPanel — the Elftia-style per-provider INTERACTIVE test panel
 * (search-settings-tab, design D6).
 *
 * The owner-typed query goes to `POST /admin/api/search/query` (the daemon
 * probes the PERSISTED config — one provider, no fallback walk), and the
 * returned results render inline. Untrusted-input discipline (plan §11.1) is
 * the SECOND layer here on top of the daemon's per-field sanitization:
 *
 * - title/content render as plain React text nodes (no markup can execute —
 *   `dangerouslySetInnerHTML` is banned by the spec);
 * - a result URL becomes an anchor ONLY when `new URL()` parses it AND the
 *   scheme is http/https — a `javascript:` URL stays inert text;
 * - display is length-bounded (clamps); the daemon's caps are the data bound.
 *
 * States, all honest: testing spinner, transport-error line (destructive),
 * blocked/degraded diagnostic line with the doctor's reason (an observation
 * about the network, not a malfunction), explicit empty notice (an empty
 * result list is a SUCCESS — never a fabricated list), provider-used + count.
 * No attempts trail: this panel probes ONE provider, there is no walk.
 */

import { Loader2, Search } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { SearchQueryOutcome } from '@/daemon/types';

interface SearchTestPanelProps {
  providerId: string;
  providerName: string;
  onQuery: (providerId: string, query: string) => Promise<SearchQueryOutcome>;
  /**
   * A draft key/host exists but is NOT persisted yet — the probe reads the
   * PERSISTED config, so the honest affordance is a "save first" hint rather
   * than a silently-failing test.
   */
  saveFirst: boolean;
  disabled: boolean;
}

/** An anchor href only for parsed http/https URLs; anything else stays text. */
export function safeResultUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function SearchTestPanel({
  providerId,
  providerName,
  onQuery,
  saveFirst,
  disabled,
}: SearchTestPanelProps) {
  const t = useTranslation();
  const [query, setQuery] = React.useState('');
  const [testing, setTesting] = React.useState(false);
  const [outcome, setOutcome] = React.useState<SearchQueryOutcome | null>(null);

  const run = React.useCallback(async (): Promise<void> => {
    const trimmed = query.trim();
    if (!trimmed || saveFirst || disabled || testing) return;
    setTesting(true);
    try {
      setOutcome(await onQuery(providerId, trimmed));
    } finally {
      setTesting(false);
    }
  }, [query, saveFirst, disabled, testing, onQuery, providerId]);

  const runDisabled = disabled || testing || saveFirst || query.trim().length === 0;

  return (
    <div className="rounded-lg border border-border/50 bg-surface-1/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          disabled={disabled}
          placeholder={t('search.test.queryPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void run();
            }
          }}
          aria-label={t('search.test.queryPlaceholder')}
          className="flex-1"
        />
        <Button variant="outline" size="sm" disabled={runDisabled} onClick={() => void run()}>
          {testing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Search className="h-4 w-4" aria-hidden="true" />
          )}
          {testing ? t('search.test.testing') : t('search.test.action')}
        </Button>
      </div>

      {saveFirst ? (
        <p className="text-xs text-warning" role="status">
          {t('search.test.saveFirst')}
        </p>
      ) : null}

      {outcome && !outcome.ok ? (
        <p className="text-xs text-destructive" role="status">
          {t('search.testOutcome.error', { error: outcome.error })}
        </p>
      ) : null}

      {outcome && outcome.ok ? (
        <QueryOutcomeView outcome={outcome} providerName={providerName} />
      ) : null}
    </div>
  );
}

/** The success/failure diagnostic + results of one interactive query. */
function QueryOutcomeView({
  outcome,
  providerName,
}: {
  outcome: Extract<SearchQueryOutcome, { ok: true }>;
  providerName: string;
}) {
  const t = useTranslation();
  const { result } = outcome;
  const { diagnostic, resultCount, results } = result;

  // A failed upstream is a diagnostic line (the taxonomy label + reason), not
  // a fabricated empty list.
  if (diagnostic.status === 'failed') {
    return (
      <p className="text-xs text-destructive" role="status">
        {t('search.status.failed')}
        {diagnostic.reason || diagnostic.error?.message ? ` — ${diagnostic.reason ?? diagnostic.error?.message}` : ''}
      </p>
    );
  }
  if (diagnostic.status === 'blocked' || diagnostic.status === 'degraded') {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        <span className="text-primary">{t(`search.status.${diagnostic.status}`)}</span>
        {diagnostic.reason ? ` — ${diagnostic.reason}` : ''}
      </p>
    );
  }

  // healthy: an authoritative empty list is a SUCCESS — the honest empty
  // notice, never a fabricated result list.
  if (!results || results.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {t('search.test.empty')}
      </p>
    );
  }

  return (
    <div className="space-y-2" role="status">
      <p className="text-xs text-muted-foreground">
        <span className="text-primary">{t('search.test.providerUsed', { provider: providerName })}</span>
        {resultCount !== undefined
          ? ` · ${t('search.testOutcome.count', { count: String(resultCount) })}`
          : ''}
      </p>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {results.map((r, i) => {
          // UNTRUSTED TEXT: title/content are plain nodes; the URL is a link
          // only when it parses to http/https.
          const href = safeResultUrl(r.url);
          return (
            <div key={i} className="rounded-md border border-border/30 bg-surface-2/50 p-2 text-sm">
              <p className="truncate font-medium text-foreground">{r.title}</p>
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate text-xs text-primary"
                >
                  {r.url}
                </a>
              ) : (
                <p className="block truncate text-xs text-muted-foreground">{r.url}</p>
              )}
              {r.content ? (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.content}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SearchTestPanel;
