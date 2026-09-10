import { Database, FolderSearch, Loader2, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

import type {
  CodexSessionListResponse,
  CodexSessionProviderPreview,
  CodexSessionSummary,
} from '@/daemon/types';

function inputKey(input: {
  projectPath: string;
  sessionIds: string[];
  fromProvider?: string;
  toProvider: string;
}): string {
  return JSON.stringify({
    ...input,
    sessionIds: [...input.sessionIds].sort(),
  });
}
function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function rowProvider(session: CodexSessionSummary): string {
  return session.provider || session.jsonlProvider || 'unknown';
}

export function CodexSessionManager() {
  const t = useTranslation();
  const [projectPath, setProjectPath] = useState('');
  const [snapshot, setSnapshot] = useState<CodexSessionListResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [fromProvider, setFromProvider] = useState('');
  const [toProvider, setToProvider] = useState('');
  const [preview, setPreview] = useState<CodexSessionProviderPreview | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [busy, setBusy] = useState<'scan' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const previewRef = useRef<CodexSessionProviderPreview | null>(null);
  const previewKeyRef = useRef('');

  const sessions = snapshot?.sessions ?? [];
  const readySessions = useMemo(() => sessions.filter((session) => session.status === 'ready'), [sessions]);
  const providers = useMemo(
    () => [...new Set(sessions.map(rowProvider).filter((provider) => provider !== 'unknown'))].sort(),
    [sessions],
  );
  const allReadySelected = readySessions.length > 0 && readySessions.every((session) => selectedIds.has(session.id));
  const currentInput = useMemo(() => ({
    projectPath: projectPath.trim(),
    sessionIds: [...selectedIds],
    ...(fromProvider.trim() ? { fromProvider: fromProvider.trim() } : {}),
    toProvider: toProvider.trim(),
  }), [fromProvider, projectPath, selectedIds, toProvider]);
  const currentInputKey = inputKey(currentInput);
  const previewIsCurrent = previewKey === currentInputKey && preview !== null;
  const actionablePreviewCount = preview?.sessions.filter((session) => session.action === 'update').length ?? 0;

  const clearPlan = () => {
    setPreview(null);
    setPreviewKey('');
    previewRef.current = null;
    previewKeyRef.current = '';
  };

  const scan = async () => {
    setBusy('scan');
    setError(null);
    setNotice(null);
    clearPlan();
    try {
      const result = await agent.cli.listCodexSessions(projectPath.trim());
      if (!result.success) {
        setError(result.message);
        setSnapshot(null);
        setSelectedIds(new Set());
        return;
      }
      setSnapshot(result.result);
      setSelectedIds(new Set());
    } finally {
      setBusy(null);
    }
  };

  const loadPreview = async (): Promise<CodexSessionProviderPreview | null> => {
    if (previewRef.current && previewKeyRef.current === currentInputKey) return previewRef.current;
    setBusy('preview');
    setError(null);
    setNotice(null);
    try {
      const result = await agent.cli.previewCodexSessionProviderSwitch(currentInput);
      if (!result.success) {
        setError(result.message);
        return null;
      }
      setPreview(result.result);
      setPreviewKey(currentInputKey);
      previewRef.current = result.result;
      previewKeyRef.current = currentInputKey;
      return result.result;
    } finally {
      setBusy(null);
    }
  };

  const handlePreview = () => {
    if (!currentInput.projectPath || currentInput.sessionIds.length === 0 || !currentInput.toProvider) {
      setError(t('codeCli.sessions.validation'));
      return;
    }
    void loadPreview();
  };

  const handleApply = async () => {
    if (!currentInput.projectPath || currentInput.sessionIds.length === 0 || !currentInput.toProvider) {
      setError(t('codeCli.sessions.validation'));
      return;
    }
    const plan = await loadPreview();
    if (!plan || plan.sessions.some((session) => session.action === 'blocked')) return;
    const updates = plan.sessions.filter((session) => session.action === 'update').length;
    if (updates === 0) {
      setNotice(t('codeCli.sessions.noChanges'));
      return;
    }
    if (!window.confirm(t('codeCli.sessions.confirm', { count: updates, provider: currentInput.toProvider }))) return;

    setBusy('apply');
    setError(null);
    setNotice(null);
    try {
      const result = await agent.cli.applyCodexSessionProviderSwitch(currentInput);
      if (!result.success) {
        setError(result.message);
        return;
      }
      setNotice(t('codeCli.sessions.applied', {
        sessions: result.result.updatedSessions,
        files: result.result.jsonlFiles,
        rows: result.result.sqliteRows,
      }));
      clearPlan();
      const refreshed = await agent.cli.listCodexSessions(projectPath.trim());
      if (refreshed.success) setSnapshot(refreshed.result);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    clearPlan();
  };

  const toggleAll = () => {
    setSelectedIds(allReadySelected ? new Set() : new Set(readySessions.map((session) => session.id)));
    clearPlan();
  };

  return (
    <section className="space-y-4 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft/30">
          <Database className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('codeCli.sessions.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('codeCli.sessions.description')}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2 md:flex-row md:items-end">
        <label className="min-w-0 flex-1 space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('codeCli.sessions.projectPath')}</span>
          <Input
            value={projectPath}
            placeholder={t('codeCli.sessions.projectPlaceholder')}
            onChange={(event) => {
              setProjectPath(event.target.value);
              clearPlan();
            }}
            autoComplete="off"
          />
        </label>
        <Button variant="outline" disabled={busy !== null} onClick={() => void scan()}>
          {busy === 'scan' ? <Loader2 className="animate-spin" /> : <FolderSearch />}
          {t('codeCli.sessions.scan')}
        </Button>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-surface-0/40 p-3 md:flex-row md:items-end">
        <label className="min-w-0 flex-1 space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('codeCli.sessions.fromProvider')}</span>
          <Input
            list="codex-session-providers"
            value={fromProvider}
            placeholder={t('codeCli.sessions.anyProvider')}
            onChange={(event) => {
              setFromProvider(event.target.value);
              clearPlan();
            }}
            autoComplete="off"
          />
        </label>
        <label className="min-w-0 flex-1 space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('codeCli.sessions.toProvider')}</span>
          <Input
            value={toProvider}
            placeholder="omnicross"
            onChange={(event) => {
              setToProvider(event.target.value);
              clearPlan();
            }}
            autoComplete="off"
          />
        </label>
        <datalist id="codex-session-providers">
          {providers.map((provider) => <option key={provider} value={provider} />)}
        </datalist>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy !== null || selectedIds.size === 0} onClick={handlePreview}>
            {busy === 'preview' ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            {t('codeCli.sessions.preview')}
          </Button>
          <Button disabled={busy !== null || selectedIds.size === 0 || !toProvider.trim()} onClick={() => void handleApply()}>
            {busy === 'apply' ? <Loader2 className="animate-spin" /> : <Save />}
            {t('codeCli.sessions.apply')}
          </Button>
        </div>
      </div>

      {error ? <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
      {notice ? <div className="rounded-md bg-success/10 px-3 py-2 text-xs text-success">{notice}</div> : null}

      {snapshot ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t('codeCli.sessions.found', { count: sessions.length })}
              {selectedIds.size > 0 ? ` · ${t('codeCli.sessions.selected', { count: selectedIds.size })}` : ''}
            </span>
            <span className="flex items-center gap-1.5">
              <span className={`inline-flex h-2 w-2 rounded-full ${snapshot.stateDatabase.available ? 'bg-success' : 'bg-destructive'}`} />
              {snapshot.stateDatabase.available ? t('codeCli.sessions.sqliteReady') : t('codeCli.sessions.sqliteUnavailable')}
            </span>
          </div>

          {snapshot.stateDatabase.available ? null : (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {snapshot.stateDatabase.reason}
            </p>
          )}

          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-border/50 bg-surface-0/60 text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={t('codeCli.sessions.selectAll')}
                      checked={allReadySelected}
                      onChange={toggleAll}
                      disabled={readySessions.length === 0}
                    />
                  </th>
                  <th className="px-3 py-2">{t('codeCli.sessions.session')}</th>
                  <th className="px-3 py-2">{t('codeCli.sessions.provider')}</th>
                  <th className="px-3 py-2">{t('codeCli.sessions.model')}</th>
                  <th className="px-3 py-2">{t('codeCli.sessions.updated')}</th>
                  <th className="px-3 py-2">{t('codeCli.sessions.size')}</th>
                  <th className="px-3 py-2">{t('codeCli.sessions.state')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className="border-b border-border/30 last:border-b-0">
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(session.id)}
                        onChange={() => toggle(session.id)}
                        disabled={session.status !== 'ready' || busy !== null}
                        aria-label={session.id}
                      />
                    </td>
                    <td className="max-w-[270px] px-3 py-2 align-top">
                      <div className="truncate font-mono text-foreground" title={session.id}>{session.id}</div>
                      <div className="truncate text-muted-foreground" title={session.cwd}>{session.cwd}</div>
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-foreground">{rowProvider(session)}</td>
                    <td className="px-3 py-2 align-top font-mono text-muted-foreground">{session.model || '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">{formatDate(session.updatedAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">{formatBytes(session.fileSize)}</td>
                    <td className="px-3 py-2 align-top">
                      <Badge variant={session.status === 'ready' && session.inStateDatabase ? 'success' : 'secondary'}>
                        {session.status === 'ready' && session.inStateDatabase
                          ? t('codeCli.sessions.ready')
                          : session.status === 'ready'
                            ? t('codeCli.sessions.noStateRow')
                            : t('codeCli.sessions.unavailable')}
                      </Badge>
                    </td>
                  </tr>
                ))}
                {sessions.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">{t('codeCli.sessions.empty')}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {previewIsCurrent && preview ? (
            <div className="rounded-lg border border-primary/30 bg-primary-soft/10 px-3 py-2 text-xs text-muted-foreground">
              {t('codeCli.sessions.previewSummary', {
                updates: actionablePreviewCount,
                fields: preview.sessions.reduce((total, session) => total + session.changedFields, 0),
                rows: preview.sessions.filter((session) => session.sqliteWillUpdate).length,
              })}
            </div>
          ) : null}

          <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
            <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('codeCli.sessions.backupHint')}</span>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t('codeCli.sessions.scanHint')}</p>
      )}
    </section>
  );
}
