/**
 * CodexInlineSignIn.tsx — the codex LOOPBACK sign-in step, shown inline in the
 * Codex card (app-parity-2 child 5).
 *
 * Codex differs from claude/gemini (code-paste): its redirect is a loopback the
 * DAEMON captures directly, so there is no code to paste. The parent already
 * called `startOAuth('codex')` (the daemon minted the authorize URL + armed its
 * loopback listener + returned an opaque sessionId). This panel opens that URL in
 * the browser via a plain `target="_blank"` anchor (no native-shell call), then
 * POLLS the token-free status (`onPoll(sessionId)`) until `done`/`error`. The
 * token is captured + persisted entirely daemon-side — it NEVER crosses to the
 * client; this panel only ever sees `{ state, message? }`.
 */

import { ExternalLink, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { CodexOAuthStatus } from '@/daemon/types';

interface CodexInlineSignInProps {
  authUrl: string;
  sessionId: string;
  onPoll: (sessionId: string) => Promise<CodexOAuthStatus>;
  onDone: () => void;
  onCancel: () => void;
}

const POLL_INTERVAL_MS = 2000;

export function CodexInlineSignIn({
  authUrl,
  sessionId,
  onPoll,
  onDone,
  onCancel,
}: CodexInlineSignInProps) {
  const t = useTranslation();
  const [phase, setPhase] = useState<'pending' | 'error'>('pending');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Poll the token-free status while mounted. The browser completes the redirect
  // to the daemon's loopback; we just wait for `done`/`error`.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setPhase('pending');
    setErrMsg(null);

    const tick = async () => {
      if (cancelled) return;
      let status: CodexOAuthStatus;
      try {
        status = await onPoll(sessionId);
      } catch {
        status = { state: 'error', message: t('accounts.codexOauth.failed') };
      }
      if (cancelled) return;
      if (status.state === 'done') {
        onDone();
        return;
      }
      if (status.state === 'error') {
        setPhase('error');
        setErrMsg(status.message ?? t('accounts.codexOauth.failed'));
        return;
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    // First poll after a short delay (give the user time to open the page).
    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, onPoll, onDone, t]);

  return (
    <div className="space-y-3 rounded-md bg-surface-2 p-4">
      <p className="text-sm text-muted-foreground">{t('accounts.codexOauth.description')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={authUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <ExternalLink className="h-4 w-4" />
          {t('accounts.oauth.openPage')}
        </a>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>

      {phase === 'pending' ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('accounts.codexOauth.waiting')}
        </p>
      ) : null}

      {phase === 'error' && errMsg ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errMsg}
        </p>
      ) : null}
    </div>
  );
}
