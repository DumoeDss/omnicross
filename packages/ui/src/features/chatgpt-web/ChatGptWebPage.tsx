/**
 * ChatGptWebPage.tsx — the ChatGPT Web backend page.
 *
 * A step-by-step setup wizard (not a wall of text): one action per step,
 * external steps open the right page in the browser, local steps are one
 * click (config form, login window, bridge). Status comes from
 * `GET /admin/api/chatgpt-web`.
 */

import { Check, Copy, ExternalLink, Globe, Loader2, LogIn, RefreshCw, Rocket, ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';
import { openExternal } from '@/shared/tauri/openExternal';

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

function LinkButton({ label, url }: { label: string; url: string }) {
  return (
    <Button size="sm" variant="outline" onClick={() => void openExternal(url)}>
      <ExternalLink className="h-3.5 w-3.5" />
      {label}
    </Button>
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
    <div className="rounded-xl border border-border/70 bg-surface-1/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
              done === true ? 'bg-success/15 text-success' : done === false ? 'bg-surface-2 text-muted-foreground' : 'bg-surface-2 text-muted-foreground'
            }`}
          >
            {done === true ? <Check className="h-4 w-4" /> : index}
          </div>
          <h3 className="pt-1 text-sm font-semibold text-foreground">{title}</h3>
        </div>
        {done === true ? <Badge variant="success" className="shrink-0">OK</Badge> : null}
      </div>
      {children ? <div className="mt-3 space-y-3 pl-10">{children}</div> : null}
    </div>
  );
}

function SubStep({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm text-foreground/90">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

const MODEL_OPTIONS = ['chatgpt-web/light', 'chatgpt-web/high', 'chatgpt-web/pro'] as const;

const TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const API_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';
const CONNECTORS_URL = 'https://chatgpt.com/#settings/Plugins';

export function ChatGptWebPage() {
  const t = useTranslation();
  const {
    status,
    loading,
    busy,
    error,
    notice,
    refresh,
    saveConfig,
    openLoginWindow,
    checkLogin,
    startBridge,
    stopBridge,
  } = useChatGptWeb();
  const [model, setModel] = useState<string>('chatgpt-web/light');
  const [tunnelId, setTunnelId] = useState('');
  const [runtimeKey, setRuntimeKey] = useState('');
  const [reconfigure, setReconfigure] = useState(false);

  const config = status?.config;
  const tunnel = status?.tunnel;
  const login = status?.login;
  const bridge = status?.bridge;
  const configDone = config?.present === true && !reconfigure;

  const codexCommand = bridge?.baseUrl
    ? [
        'codex',
        '-c model_provider="omnicross-chatgptweb"',
        `-c omnicross_chatgptweb_base_url="${bridge.baseUrl}"`,
        `-c omnicross_chatgptweb_api_key="${bridge.token ?? ''}"`,
      ].join(' ')
    : '';

  const handleSaveConfig = async () => {
    const result = await saveConfig({ tunnelId, runtimeKey }, t('chatgptWeb.config.saved'));
    if (result.success) {
      setReconfigure(false);
      setTunnelId('');
      setRuntimeKey('');
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
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

          {/* Step 1: create tunnel + key on platform.openai.com */}
          <StepCard index={1} title={t('chatgptWeb.steps.platform.title')} done={null}>
            <SubStep>{t('chatgptWeb.steps.platform.tunnel')}</SubStep>
            <SubStep>{t('chatgptWeb.steps.platform.key')}</SubStep>
            <div className="flex flex-wrap gap-2 pt-1">
              <LinkButton label={t('chatgptWeb.steps.platform.tunnelsLink')} url={TUNNELS_URL} />
              <LinkButton label={t('chatgptWeb.steps.platform.keysLink')} url={API_KEYS_URL} />
            </div>
          </StepCard>

          {/* Step 2: paste the two values */}
          <StepCard index={2} title={t('chatgptWeb.steps.config.title')} done={configDone}>
            {configDone ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="rounded bg-surface-2/60 px-1.5 py-0.5 font-mono">{config?.tunnelId}</span>
                  <span className="rounded bg-surface-2/60 px-1.5 py-0.5 font-mono">{config?.connectorName}</span>
                </div>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setReconfigure(true)}>
                  {t('chatgptWeb.config.reconfigure')}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="cgw-tunnel-id">Tunnel ID</label>
                  <Input
                    id="cgw-tunnel-id"
                    value={tunnelId}
                    onChange={(event) => setTunnelId(event.target.value)}
                    placeholder="tunnel_…"
                    className="font-mono"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="cgw-runtime-key">
                    {t('chatgptWeb.config.runtimeKey')}
                  </label>
                  <RevealableInput
                    id="cgw-runtime-key"
                    value={runtimeKey}
                    onChange={(event) => setRuntimeKey(event.target.value)}
                    placeholder="sk-…"
                    className="font-mono"
                    autoComplete="off"
                  />
                </div>
                <Button size="sm" disabled={busy !== null || !tunnelId.trim() || !runtimeKey.trim()} onClick={() => void handleSaveConfig()}>
                  {busy === 'config-save' ? <Loader2 className="animate-spin" /> : <Check className="h-4 w-4" />}
                  {t('chatgptWeb.config.save')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('chatgptWeb.config.saveHint')}</p>
              </div>
            )}
          </StepCard>

          {/* Step 3: the ChatGPT connector */}
          <StepCard index={3} title={t('chatgptWeb.steps.connector.title')} done={null}>
            <SubStep>{t('chatgptWeb.steps.connector.open')}</SubStep>
            <SubStep>{t('chatgptWeb.steps.connector.devMode')}</SubStep>
            <SubStep>{t('chatgptWeb.steps.connector.create')}</SubStep>
            <SubStep>{t('chatgptWeb.steps.connector.name')}</SubStep>
            <SubStep>{t('chatgptWeb.steps.connector.permissions')}</SubStep>
            <div className="pt-1">
              <LinkButton label={t('chatgptWeb.steps.connector.link')} url={CONNECTORS_URL} />
            </div>
          </StepCard>

          {/* Step 4: sign in inside the dedicated browser */}
          <StepCard
            index={4}
            title={t('chatgptWeb.steps.login.title')}
            done={login ? (login.state === 'signed-in' ? true : login.state === 'signed-out' ? false : null) : null}
          >
            <SubStep>{t('chatgptWeb.steps.login.click')}</SubStep>
            <SubStep>{t('chatgptWeb.steps.login.thenCheck')}</SubStep>
            <div className="flex flex-wrap gap-2 pt-1">
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

          {/* Step 5: start the bridge (tunnel-client installs automatically) */}
          <StepCard index={5} title={t('chatgptWeb.steps.start.title')} done={bridge?.running === true}>
            <SubStep>{t('chatgptWeb.steps.start.pick')}</SubStep>
            <SubStep>{t('chatgptWeb.steps.start.note')}</SubStep>
            <div className="flex flex-wrap items-center gap-2 pt-1">
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
                <Button
                  size="sm"
                  disabled={busy !== null || !configDone}
                  title={!configDone ? t('chatgptWeb.bridge.needConfig') : undefined}
                  onClick={() => void startBridge({ model, harness: true }, t('chatgptWeb.bridge.started'))}
                >
                  {busy === 'bridge-start' ? <Loader2 className="animate-spin" /> : <Rocket className="h-4 w-4" />}
                  {t('chatgptWeb.bridge.start')}
                </Button>
              )}
            </div>
            {tunnel ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {tunnel.installing ? <Badge variant="secondary">{t('chatgptWeb.tunnel.installing')}</Badge> : null}
                {!tunnel.installed && !tunnel.installing ? <Badge variant="secondary">{t('chatgptWeb.tunnel.willInstall')}</Badge> : null}
                {tunnel.installed ? (
                  <Badge variant={tunnel.running ? 'success' : 'secondary'}>
                    {tunnel.running ? t('chatgptWeb.tunnel.running') : t('chatgptWeb.tunnel.stopped')}
                  </Badge>
                ) : null}
                {tunnel.healthy ? <Badge variant="success">{t('chatgptWeb.tunnel.healthy')}</Badge> : null}
                {tunnel.ready ? <Badge variant="success">ready</Badge> : null}
                {tunnel.detail && tunnel.installed ? <span className="text-xs text-muted-foreground">{tunnel.detail}</span> : null}
              </div>
            ) : null}

            {bridge?.running && bridge.baseUrl ? (
              <div className="space-y-3 border-t border-border/40 pt-3">
                <CopyBlock label="Base URL" value={bridge.baseUrl} />
                <CopyBlock label="API Token" value={bridge.token ?? ''} />
                {codexCommand ? <CopyBlock label="codex" value={codexCommand} /> : null}
              </div>
            ) : null}
          </StepCard>

          {/* Footer note */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 text-xs text-muted-foreground md:p-5">
            <p>{t('chatgptWeb.guide.cli')}</p>
            <p className="mt-2">{t('chatgptWeb.guide.experimental')}</p>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

export default ChatGptWebPage;
