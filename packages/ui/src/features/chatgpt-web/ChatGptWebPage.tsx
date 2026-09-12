/**
 * ChatGptWebPage.tsx — the ChatGPT Web backend page.
 *
 * Drives the chatgpt-web feature from the dashboard: a setup checklist
 * (harness config → connector → login → tunnel), the CDP-less login window,
 * and the background harness bridge (start/stop + codex wiring snippets).
 * Every status comes from `GET /admin/api/chatgpt-web`.
 */

import { Check, Copy, ExternalLink, Globe, Loader2, LogIn, RefreshCw, Rocket, ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';

import { useChatGptWeb } from './hooks/useChatGptWeb';

function CopyBlock({ label, value }: { label: string; value: string }) {
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
        </Button>
      </div>
      <pre className="overflow-auto whitespace-pre rounded-md border border-border bg-surface-0/60 px-3 py-2 font-mono text-xs text-foreground">
        {value}
      </pre>
    </div>
  );
}

function StepCard({
  index,
  title,
  done,
  children,
}: {
  index: number;
  title: string;
  done: boolean | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-surface-1/60 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            done === true ? 'bg-success/15 text-success' : done === false ? 'bg-destructive/10 text-destructive' : 'bg-surface-2 text-muted-foreground'
          }`}
        >
          {index}
        </div>
        <div className="min-w-0 space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {children}
        </div>
      </div>
      {done !== null ? (
        <Badge variant={done ? 'success' : 'secondary'} className="shrink-0">
          {done ? <ShieldCheck className="h-3 w-3" /> : null}
          {done ? 'OK' : '…'}
        </Badge>
      ) : null}
    </div>
  );
}

const MODEL_OPTIONS = ['chatgpt-web/light', 'chatgpt-web/high', 'chatgpt-web/pro'] as const;

export function ChatGptWebPage() {
  const t = useTranslation();
  const { status, loading, busy, error, notice, refresh, openLoginWindow, checkLogin, startBridge, stopBridge } = useChatGptWeb();
  const [model, setModel] = useState<string>('chatgpt-web/light');

  const config = status?.config;
  const tunnel = status?.tunnel;
  const login = status?.login;
  const bridge = status?.bridge;

  const codexCommand = bridge?.baseUrl
    ? [
        'codex',
        '-c model_provider="omnicross-chatgptweb"',
        `-c omnicross_chatgptweb_base_url="${bridge.baseUrl}"`,
        `-c omnicross_chatgptweb_api_key="${bridge.token ?? ''}"`,
      ].join(' ')
    : '';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
          {/* Header */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
                  <Globe className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-foreground">{t('chatgptWeb.title')}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t('chatgptWeb.description')}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
                aria-label={t('chatgptWeb.refresh')}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </section>

          {error ? <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}
          {notice ? <div className="rounded-md bg-success/10 px-4 py-3 text-sm text-success">{notice}</div> : null}

          {/* Setup checklist */}
          <section className="space-y-3">
            <h2 className="px-1 text-sm font-semibold text-foreground">{t('chatgptWeb.checklist.title')}</h2>

            <StepCard index={1} title={t('chatgptWeb.checklist.config.title')} done={config?.present ?? null}>
              <p className="text-xs text-muted-foreground">{t('chatgptWeb.checklist.config.description')}</p>
              {config ? (
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {config.connectorName ? <span className="rounded bg-surface-2/60 px-1.5 py-0.5 font-mono">{config.connectorName}</span> : null}
                  {config.tunnelId ? <span className="rounded bg-surface-2/60 px-1.5 py-0.5 font-mono">{config.tunnelId}</span> : null}
                </div>
              ) : null}
              {!config?.present ? (
                <CopyBlock
                  label={t('chatgptWeb.checklist.config.commandLabel')}
                  value={'omnicross chatgpt-web harness setup --tunnel-id <tunnel_id> --runtime-key <runtime_key>'}
                />
              ) : null}
              <a
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                href="https://platform.openai.com/settings/organization/tunnels"
                target="_blank"
                rel="noreferrer"
              >
                {t('chatgptWeb.checklist.config.tunnelsLink')} <ExternalLink className="h-3 w-3" />
              </a>
            </StepCard>

            <StepCard index={2} title={t('chatgptWeb.checklist.connector.title')} done={null}>
              <p className="text-xs text-muted-foreground">{t('chatgptWeb.checklist.connector.description')}</p>
              <a
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                href="https://chatgpt.com/#settings/Plugins"
                target="_blank"
                rel="noreferrer"
              >
                {t('chatgptWeb.checklist.connector.link')} <ExternalLink className="h-3 w-3" />
              </a>
            </StepCard>

            <StepCard
              index={3}
              title={t('chatgptWeb.checklist.login.title')}
              done={login ? (login.state === 'signed-in' ? true : login.state === 'signed-out' ? false : null) : null}
            >
              <p className="text-xs text-muted-foreground">{t('chatgptWeb.checklist.login.description')}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => void openLoginWindow(t('chatgptWeb.login.opened'))}>
                  {busy === 'login' ? <Loader2 className="animate-spin" /> : <LogIn className="h-4 w-4" />}
                  {t('chatgptWeb.login.open')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !status?.electronRuntimeInstalled}
                  onClick={() => void checkLogin(t('chatgptWeb.login.signedIn'), t('chatgptWeb.login.signedOut'))}
                >
                  {busy === 'login-check' ? <Loader2 className="animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  {t('chatgptWeb.login.check')}
                </Button>
              </div>
              {!status?.electronRuntimeInstalled ? (
                <p className="text-xs text-muted-foreground">{t('chatgptWeb.login.runtimeHint')}</p>
              ) : null}
            </StepCard>

            <StepCard
              index={4}
              title={t('chatgptWeb.checklist.tunnel.title')}
              done={tunnel ? (tunnel.ready ? true : tunnel.installed ? false : null) : null}
            >
              {tunnel ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={tunnel.running ? 'success' : 'secondary'}>{tunnel.running ? t('chatgptWeb.tunnel.running') : t('chatgptWeb.tunnel.stopped')}</Badge>
                  {tunnel.healthy ? <Badge variant="success">{t('chatgptWeb.tunnel.healthy')}</Badge> : null}
                  {tunnel.ready ? <Badge variant="success">ready</Badge> : null}
                  {tunnel.detail ? <span className="text-xs text-muted-foreground">{tunnel.detail}</span> : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('chatgptWeb.tunnel.notInstalled')}</p>
              )}
            </StepCard>
          </section>

          {/* Bridge */}
          <section className="space-y-4 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                  <Rocket className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-foreground">{t('chatgptWeb.bridge.title')}</h2>
                    {bridge?.running ? <Badge variant="success">{t('chatgptWeb.bridge.running')}</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t('chatgptWeb.bridge.description')}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={busy !== null || bridge?.running === true}
                  className="h-8 rounded-md border border-border bg-surface-0 px-2 text-xs text-foreground"
                  aria-label={t('chatgptWeb.bridge.model')}
                >
                  {MODEL_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                {bridge?.running ? (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void stopBridge(t('chatgptWeb.bridge.stopped'))}>
                    {busy === 'bridge-stop' ? <Loader2 className="animate-spin" /> : null}
                    {t('chatgptWeb.bridge.stop')}
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy !== null} onClick={() => void startBridge({ model, harness: true }, t('chatgptWeb.bridge.started'))}>
                    {busy === 'bridge-start' ? <Loader2 className="animate-spin" /> : <Rocket className="h-4 w-4" />}
                    {t('chatgptWeb.bridge.start')}
                  </Button>
                )}
              </div>
            </div>

            {bridge?.running && bridge.baseUrl ? (
              <div className="space-y-3 border-t border-border/40 pt-3">
                <CopyBlock label="Base URL" value={bridge.baseUrl} />
                <CopyBlock label="API Token" value={bridge.token ?? ''} />
                {codexCommand ? <CopyBlock label="codex" value={codexCommand} /> : null}
              </div>
            ) : null}
          </section>

          {/* Guide footer */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 text-xs text-muted-foreground md:p-5">
            <h3 className="mb-2 text-sm font-semibold text-foreground">{t('chatgptWeb.guide.title')}</h3>
            <p>{t('chatgptWeb.guide.cli')}</p>
            <p className="mt-2">{t('chatgptWeb.guide.experimental')}</p>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

export default ChatGptWebPage;
