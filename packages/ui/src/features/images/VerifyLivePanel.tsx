/**
 * VerifyLivePanel — the Images page's explicitly-consuming test panel
 * (images-settings-tab D3): the admin twin of `doctor images --live`. Warns
 * about quota consumption before the button fires, renders the result inline
 * (stable safe codes/metadata only), and refreshes the page's capability
 * snapshot after a successful verification. The Codex-wire-only coverage
 * boundary is stated whenever Antigravity models are routed.
 */

import { FlaskConical } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { ImagesCapabilityStatus, ImagesVerifyLiveResult } from '@/daemon/types';

interface VerifyLivePanelProps {
  antigravityRouted: boolean;
  busy: boolean;
  onVerify: () => Promise<ImagesVerifyLiveResult | null>;
  onVerified: () => Promise<void>;
}

export function VerifyLivePanel({
  antigravityRouted,
  busy,
  onVerify,
  onVerified,
}: VerifyLivePanelProps) {
  const t = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImagesVerifyLiveResult | null>(null);

  const run = async (): Promise<void> => {
    setRunning(true);
    setResult(null);
    try {
      const outcome = await onVerify();
      setResult(outcome);
      if (outcome?.ok) await onVerified();
    } finally {
      setRunning(false);
    }
  };

  const disabled = busy || running;
  return (
    <div className="rounded-lg border border-border/60 bg-surface-0/70 p-3" data-testid="image-verify-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" aria-hidden="true" />
          <h4 className="text-xs font-semibold text-foreground">{t('images.verify.title')}</h4>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void run()}
          aria-label={t('images.verify.run')}
        >
          {running ? t('images.verify.running') : t('images.verify.run')}
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-warning">{t('images.verify.warning')}</p>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {antigravityRouted
          ? t('images.verify.codexOnly')
          : t('images.verify.codexOnlyPlain')}
      </p>
      {result ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="image-verify-result">
          <Badge variant={result.ok ? 'success' : 'secondary'}>{result.code}</Badge>
          {result.ok ? (
            <span className="text-muted-foreground">
              {t('images.verify.success', {
                model: result.model ?? '',
                quality: result.quality ?? '',
                format: result.outputFormat ?? '',
                count: String(result.freshEvidenceEntries ?? 0),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
