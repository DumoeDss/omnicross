/**
 * CodeCliPage.tsx — the Code CLI page: launch a coding CLI in a terminal on the
 * daemon host, pointed at the daemon proxy (dashboard parity with the desktop
 * app's Code CLI tab). Each CLI is a card with an availability badge + Launch;
 * running launches are listed with a Stop control. A compact "manual setup"
 * reference at the bottom keeps the copy-paste env path for users who prefer it.
 *
 * SECRET DISCIPLINE: the launch route token rides only the spawned terminal's
 * environment — it never crosses back to the dashboard. The admin token is never
 * printed (the manual section shows only the public base URL + a location hint).
 */

import { Check, Copy, KeyRound, Link2, Loader2, RefreshCw, Rocket, Terminal } from 'lucide-react';
import React, { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DAEMON_BASE_URL } from '@/daemon/adminClient';
import { useTranslation } from '@/shared/state/LocaleContext';

import { CliCard } from './CliCard';
import { useCli } from './hooks/useCli';
import { useCliIntegrations } from './hooks/useCliIntegrations';
import { hasInstalledIntegration, hasRotationConflict } from './integrationStatusModel';
import { PersistentIntegrationCard } from './PersistentIntegrationCard';

/** A copy-able code block (browser-only affordance — no daemon write). */
function CopyBlock({ label, value }: { label: string; value: string }) {
  const t = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button variant="ghost" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t('codeCli.copied') : t('codeCli.copy')}
        </Button>
      </div>
      <pre className="overflow-auto whitespace-pre rounded-md border border-border bg-surface-0/60 px-3 py-2 font-mono text-xs text-foreground">
        {value}
      </pre>
    </div>
  );
}

export function CodeCliPage() {
  const t = useTranslation();
  const { loading, clis, sessions, busy, error, refresh, install, launch, stop } = useCli();
  const integrations = useCliIntegrations();
  const [manualOpen, setManualOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);

  const handleRefresh = useCallback(() => {
    void Promise.all([refresh(), integrations.refresh()]);
  }, [integrations.refresh, refresh]);

  const integrationRows = integrations.overview?.integrations ?? [];
  const integrationMutationBusy = integrations.busyTarget !== null;
  const canRotate = hasInstalledIntegration(integrationRows) && !hasRotationConflict(integrationRows);

  const handleRotate = useCallback(async () => {
    const result = await integrations.rotate();
    if (result.success) setRotateOpen(false);
  }, [integrations.rotate]);

  const anthropicEnv = [
    `ANTHROPIC_BASE_URL=${DAEMON_BASE_URL}`,
    'ANTHROPIC_API_KEY=<your-outbound-key>',
  ].join('\n');
  const openaiEnv = [`OPENAI_BASE_URL=${DAEMON_BASE_URL}`, 'OPENAI_API_KEY=<your-outbound-key>'].join('\n');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
          {/* Header card */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
                  <Terminal className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-foreground">{t('codeCli.title')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t('codeCli.description')}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                aria-label={t('codeCli.refresh')}
              >
                <RefreshCw className={`h-4 w-4 ${loading || integrations.loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </section>

          {error ? (
            <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
          ) : null}

          {/* Persistent native config — normal `codex` / `claude` commands keep using Omnicross. */}
          <section className="space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:flex-row md:items-center md:justify-between md:p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft/30">
                  <Link2 className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-foreground">{t('codeCli.persistent.title')}</h2>
                    {integrations.overview ? (
                      <Badge variant={integrations.overview.gateway.running ? 'success' : 'destructive'}>
                        {integrations.overview.gateway.running
                          ? t('codeCli.persistent.gatewayRunning')
                          : t('codeCli.persistent.gatewayStopped')}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t('codeCli.persistent.description')}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!canRotate || integrationMutationBusy}
                title={hasRotationConflict(integrationRows) ? t('codeCli.persistent.rotateLocked') : undefined}
                onClick={() => setRotateOpen(true)}
              >
                {integrations.busyTarget === 'rotate' ? <Loader2 className="animate-spin" /> : <KeyRound />}
                {t('codeCli.persistent.rotate')}
              </Button>
            </div>

            {integrations.error ? (
              <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {integrations.error}
              </div>
            ) : null}

            {integrations.overview && !integrations.overview.gateway.running ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
                {t('codeCli.persistent.gatewayStoppedHint')}
              </div>
            ) : null}

            {integrations.loading && integrationRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('codeCli.persistent.loading')}</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {integrationRows.map((integration) => (
                  <PersistentIntegrationCard
                    key={integration.client}
                    integration={integration}
                    busy={integrations.busyTarget === integration.client}
                    disabled={integrationMutationBusy}
                    onPlan={(configPath) => integrations.plan(integration.client, configPath)}
                    onInstall={(configPath) => integrations.install(integration.client, configPath)}
                    onRepair={() => integrations.repair(integration.client)}
                    onRemove={() => integrations.remove(integration.client)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* One-off terminal launch. It does not change the native CLI's persistent config. */}
          <section className="space-y-3">
            <div className="flex items-start gap-3 px-1">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                <Rocket className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('codeCli.temporary.title')}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t('codeCli.temporary.description')}</p>
              </div>
            </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('codeCli.loading')}</p>
          ) : (
            <div className="space-y-3">
              {clis.map((cli) => (
                <CliCard
                  key={cli.id}
                  cli={cli}
                  sessions={sessions.filter((s) => s.cli === cli.id)}
                  busy={busy}
                  onInstall={() => install(cli.id)}
                  onLaunch={(input) => launch(cli.id, input)}
                  onStop={(id) => void stop(id)}
                />
              ))}
            </div>
          )}
          </section>

          {/* Manual setup (collapsible) — for users who prefer to run the CLI themselves */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left"
              onClick={() => setManualOpen((v) => !v)}
              aria-expanded={manualOpen}
            >
              <div>
                <h3 className="text-sm font-semibold text-foreground">{t('codeCli.manual.title')}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{t('codeCli.manual.description')}</p>
              </div>
              <span className="text-xs text-muted-foreground">
                {manualOpen ? t('codeCli.manual.hide') : t('codeCli.manual.show')}
              </span>
            </button>
            {manualOpen ? (
              <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
                <CopyBlock label={t('codeCli.baseUrl.label')} value={DAEMON_BASE_URL} />
                <p className="text-xs text-muted-foreground">{t('codeCli.token.hint')}</p>
                <p className="text-xs text-muted-foreground">{t('codeCli.examples.keyNote')}</p>
                <CopyBlock label={t('codeCli.examples.anthropic')} value={anthropicEnv} />
                <CopyBlock label={t('codeCli.examples.openai')} value={openaiEnv} />
              </div>
            ) : null}
          </section>

          <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{t('codeCli.persistent.rotateTitle')}</DialogTitle>
                <DialogDescription>{t('codeCli.persistent.rotateDescription')}</DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="secondary" disabled={integrationMutationBusy} onClick={() => setRotateOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button disabled={integrationMutationBusy} onClick={() => void handleRotate()}>
                  {integrations.busyTarget === 'rotate' ? <Loader2 className="animate-spin" /> : <KeyRound />}
                  {t('codeCli.persistent.rotate')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </ScrollArea>
    </div>
  );
}

export default CodeCliPage;
