/**
 * CliCard.tsx — one launchable CLI's card: availability badge + Launch (opens an
 * external terminal on the daemon host, pointed at the daemon proxy) + the
 * running launches for this CLI with a Stop control.
 */

import { Download, Loader2, Play, Square, Terminal } from 'lucide-react';
import React, { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { CliLaunchResult, CliSession, CliStatus, MutationResult } from '@/daemon/types';

interface CliCardProps {
  cli: CliStatus;
  sessions: CliSession[];
  busy: boolean;
  onInstall: () => Promise<MutationResult>;
  onLaunch: (input?: { cwd?: string }) => Promise<CliLaunchResult>;
  onStop: (id: string) => void;
}

export function CliCard({ cli, sessions, busy, onInstall, onLaunch, onStop }: CliCardProps) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState('');
  const [launching, setLaunching] = useState(false);
  const [installing, setInstalling] = useState(false);

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await onInstall();
    } finally {
      setInstalling(false);
    }
  };

  const handleLaunch = async () => {
    setLaunching(true);
    try {
      const result = await onLaunch({ cwd: cwd.trim() || undefined });
      if (result.success) {
        setOpen(false);
        setCwd('');
      }
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">{cli.displayName}</h3>
            <p className="truncate font-mono text-xs text-muted-foreground">{cli.command}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {cli.installed ? (
            <Badge variant="success">{t('codeCli.cli.installed')}</Badge>
          ) : (
            <Badge variant="secondary">{t('codeCli.cli.notFound')}</Badge>
          )}
          {cli.installed ? (
            <Button size="sm" variant="default" disabled={busy} onClick={() => setOpen(true)}>
              <Play className="h-3.5 w-3.5" />
              {t('codeCli.cli.launch')}
            </Button>
          ) : cli.installable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || installing}
              onClick={() => void handleInstall()}
            >
              {installing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {installing ? t('codeCli.cli.installing') : t('codeCli.cli.install')}
            </Button>
          ) : null}
        </div>
      </div>

      {!cli.installed ? (
        <p className="text-xs text-muted-foreground">
          {installing ? t('codeCli.cli.installingHint') : t('codeCli.cli.notFoundHint')}
        </p>
      ) : null}

      {sessions.length > 0 ? (
        <ul className="space-y-1.5">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-surface-0/60 px-3 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span className="truncate text-muted-foreground">
                  {t('codeCli.cli.runningVia', { provider: s.providerId, model: s.model })}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onStop(s.id)}
                className="shrink-0"
              >
                <Square className="h-3.5 w-3.5" />
                {t('codeCli.cli.stop')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('codeCli.cli.launchTitle', { name: cli.displayName })}</DialogTitle>
            <DialogDescription>{t('codeCli.cli.launchDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('codeCli.cli.cwdLabel')}{' '}
              <span className="font-normal text-muted-foreground/80">({t('common.optional')})</span>
            </label>
            <Input
              value={cwd}
              placeholder={t('codeCli.cli.cwdPlaceholder')}
              onChange={(e) => setCwd(e.target.value)}
              autoComplete="off"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={launching}>
              {t('common.cancel')}
            </Button>
            <Button variant="default" onClick={() => void handleLaunch()} disabled={launching}>
              {launching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {t('codeCli.cli.launch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
