import { CheckCircle, Loader2, Play, XCircle } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

interface ModelTestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

interface TestResult {
  success: boolean;
  message: string;
  response?: string;
  durationMs?: number;
}

export function ModelTestDialog({
  open,
  onOpenChange,
  providerId,
  providerName,
  modelId,
  modelName,
}: ModelTestDialogProps) {
  const t = useTranslation();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  // Real test: the daemon issues ONE minimal upstream completion for this model
  // using the provider's stored key (`POST /admin/api/providers/:id/test`) and
  // returns ok/latency/sample or the upstream failure message — never the key.
  const runTest = useCallback(async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await agent.llmConfig.testModel(providerId, modelId);
      if (r.unsupportedFormat) {
        setResult({
          success: false,
          message: t('providerSettings.modelsManager.testDialog.unsupportedFormat'),
        });
      } else {
        setResult({
          success: r.ok,
          message: r.message ?? '',
          response: r.sample,
          durationMs: r.latencyMs,
        });
      }
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : 'test failed' });
    } finally {
      setTesting(false);
    }
  }, [providerId, modelId, t]);

  // Auto-run on open ("click test → see the result"); reset when closed.
  useEffect(() => {
    if (open) {
      void runTest();
    } else {
      setResult(null);
    }
  }, [open, runTest]);

  const durationStr = result?.durationMs != null ? (result.durationMs / 1000).toFixed(2) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {testing ? (
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            ) : result?.success ? (
              <CheckCircle className="h-5 w-5 text-success" />
            ) : result ? (
              <XCircle className="h-5 w-5 text-destructive" />
            ) : null}
            {t('providerSettings.modelsManager.testDialog.title')}
          </DialogTitle>
          <DialogDescription>{modelId}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Provider & Model info */}
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              {t('providerSettings.modelsManager.testDialog.provider')}
            </span>
            <span className="font-medium truncate">{providerName}</span>
            <span className="text-muted-foreground">
              {t('providerSettings.modelsManager.testDialog.model')}
            </span>
            <span className="font-medium truncate">{modelName || modelId}</span>
          </div>

          {/* Testing state */}
          {testing ? <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('providerSettings.modelsManager.testDialog.testing')}
            </div> : null}

          {/* Result */}
          {result && !testing ? <div className="space-y-3">
              {/* Success / Failure banner */}
              <div
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  result.success
                    ? 'bg-success/10 text-success'
                    : 'bg-destructive/10 text-destructive'
                }`}
              >
                {result.success ? (
                  <CheckCircle className="h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0" />
                )}
                <div>
                  <div className="font-medium">
                    {result.success
                      ? t('providerSettings.modelsManager.testDialog.success')
                      : t('providerSettings.modelsManager.testDialog.failure')}
                  </div>
                  {result.success ? (
                    <div className="text-xs opacity-80">
                      {t('providerSettings.modelsManager.testDialog.successMessage')}
                    </div>
                  ) : (
                    <div className="text-xs opacity-80">{result.message}</div>
                  )}
                </div>
              </div>

              {/* AI response — shown on success when the upstream returned text */}
              {result.success && result.response ? <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t('providerSettings.modelsManager.testDialog.aiResponse')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('providerSettings.modelsManager.testDialog.charCount', {
                        count: result.response.length,
                      })}
                    </span>
                  </div>
                  <div className="p-3 rounded-lg bg-surface-1 text-sm max-h-32 overflow-y-auto">
                    {result.response}
                  </div>
                </div> : null}

              {/* Duration */}
              {durationStr ? <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>
                    {t('providerSettings.modelsManager.testDialog.duration', {
                      time: durationStr,
                    })}
                  </span>
                </div> : null}
            </div> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('providerSettings.modelsManager.testDialog.close')}
          </Button>
          <Button onClick={() => void runTest()} disabled={testing}>
            <Play className="h-4 w-4 mr-1" />
            {t('providerSettings.modelsManager.testDialog.retest')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
