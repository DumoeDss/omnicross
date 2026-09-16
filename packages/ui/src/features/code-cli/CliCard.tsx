/**
 * CliCard.tsx — one launchable CLI's card: availability badge + Launch (opens an
 * external terminal on the daemon host, pointed at the daemon proxy) + the
 * running launches for this CLI with a Stop control.
 *
 * Codex and Claude Code additionally offer a ROUTING TARGET selector in the
 * launch dialog: an upstream provider speaking the client's own wire (lease
 * launch pinned to that provider), a downstream route (the terminal
 * authenticates as an eligible gateway key and is pinned to exactly that route
 * via `x-omnicross-binding-id`), or a raw gateway key (authenticate as the key;
 * routing follows the key's bindings, so concurrent terminals can use different
 * keys → different upstreams). Unpicked = the default lease launch.
 */

import { ArrowUpCircle, Download, Loader2, Play, Square, Terminal } from 'lucide-react';
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
import { Select } from '@/components/ui/select';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { CliLaunchResult, CliSession, CliStatus, CliVersionStatus, MutationResult } from '@/daemon/types';

import type { LaunchTarget } from './hooks/useLaunchTargets';

interface CliCardProps {
  cli: CliStatus;
  sessions: CliSession[];
  busy: boolean;
  onInstall: () => Promise<MutationResult>;
  /** Re-install at the latest release (shown when a version probe reported one). */
  onUpgrade?: () => Promise<MutationResult>;
  /** Version probe outcome for this CLI (undefined = not probed/installed). */
  version?: CliVersionStatus;
  onLaunch: (input?: {
    cwd?: string;
    keyId?: string;
    providerId?: string;
    bindingId?: string;
  }) => Promise<CliLaunchResult>;
  onStop: (id: string) => void;
  /** Codex/Claude only: routing targets a launch can pin (empty hides the selector). */
  targets?: LaunchTarget[];
  /** The client's wire name ('Responses' | 'Anthropic') for hint copy. */
  wire?: string;
}

/** `<kind>:<id>` select value → the launch input for that target kind. */
function targetLaunchInput(value: string): { providerId?: string; bindingId?: string; keyId?: string } {
  const separator = value.indexOf(':');
  if (separator <= 0) return {};
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (kind === 'provider') return { providerId: id };
  if (kind === 'route') return { bindingId: id };
  if (kind === 'key') return { keyId: id };
  return {};
}

export function CliCard({ cli, sessions, busy, onInstall, onUpgrade, version, onLaunch, onStop, targets, wire }: CliCardProps) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState('');
  const [target, setTarget] = useState('');
  const [launching, setLaunching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  // Install-only CLIs (no launcher builder) keep Install/Upgrade but hide Launch.
  const launchable = cli.launchable !== false;
  const upgradeAvailable = Boolean(
    cli.installed && cli.installable && version?.installed && version.latest && version.latest !== version.installed,
  );
  // "command · 1.2.3 → 1.3.0" — installed version always, latest only when it differs.
  const versionText = version?.installed
    ? version.latest && version.latest !== version.installed
      ? `${version.installed} → ${version.latest}`
      : version.installed
    : null;

  const showTargetSelector = (cli.id === 'codex' || cli.id === 'claude') && (targets?.length ?? 0) > 0;
  const targetKind = target.slice(0, target.indexOf(':'));

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await onInstall();
    } finally {
      setInstalling(false);
    }
  };

  const handleUpgrade = async () => {
    setUpgrading(true);
    try {
      await onUpgrade?.();
    } finally {
      setUpgrading(false);
    }
  };

  const handleLaunch = async () => {
    setLaunching(true);
    try {
      const result = await onLaunch({
        cwd: cwd.trim() || undefined,
        ...targetLaunchInput(target),
      });
      if (result.success) {
        setOpen(false);
        setCwd('');
        setTarget('');
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
            <p className="truncate font-mono text-xs text-muted-foreground">
              {cli.command}
              {versionText ? <span> · {versionText}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {cli.installed ? (
            <Badge variant="success">{t('codeCli.cli.installed')}</Badge>
          ) : (
            <Badge variant="secondary">{t('codeCli.cli.notFound')}</Badge>
          )}
          {cli.installed && launchable ? (
            <Button size="sm" variant="default" disabled={busy} onClick={() => setOpen(true)}>
              <Play className="h-3.5 w-3.5" />
              {t('codeCli.cli.launch')}
            </Button>
          ) : null}
          {cli.installed && cli.installable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || upgrading}
              title={upgradeAvailable
                ? t('codeCli.cli.upgradeToHint', { version: version?.latest ?? '' })
                : t('codeCli.cli.upgradeHint')}
              onClick={() => void handleUpgrade()}
            >
              {upgrading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUpCircle className={upgradeAvailable ? 'text-primary' : undefined} />
              )}
              {upgrading ? t('codeCli.cli.upgrading') : t('codeCli.cli.upgrade')}
            </Button>
          ) : null}
          {!cli.installed && cli.installable ? (
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

      {upgrading ? (
        <p className="text-xs text-muted-foreground">{t('codeCli.cli.upgradingHint')}</p>
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
                  {s.bindingName
                    ? t('codeCli.cli.runningViaRoute', { name: s.bindingName, key: s.keyName ?? '' })
                    : s.keyName
                      ? t('codeCli.cli.runningViaKey', { name: s.keyName })
                      : t('codeCli.cli.runningVia', { provider: s.providerId, model: s.model })}
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
          {showTargetSelector ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t('codeCli.cli.routeKeyLabel')}
              </label>
              <Select
                value={target}
                onChange={setTarget}
                size="sm"
                placeholder={t('codeCli.cli.routeKeyAuto')}
                options={[
                  // Empty value = the default lease launch (no scoping).
                  { value: '', label: t('codeCli.cli.routeKeyAuto') },
                  ...(targets ?? []).map((item) => ({
                    value:
                      item.kind === 'provider'
                        ? `provider:${item.providerId}`
                        : item.kind === 'route'
                          ? `route:${item.bindingId}`
                          : `key:${item.keyId}`,
                    label:
                      item.kind === 'provider'
                        ? `${t('codeCli.cli.targetGroupProvider')} · ${item.label}`
                        : item.kind === 'route'
                          ? `${t('codeCli.cli.targetGroupRoute')} · ${item.label}`
                          : `${t('codeCli.cli.targetGroupKey')} · ${item.label}`,
                  })),
                ]}
              />
              {target ? (
                <p className="text-xs text-muted-foreground/80">
                  {targetKind === 'provider'
                    ? t('codeCli.cli.targetProviderHint', { wire: wire ?? '' })
                    : targetKind === 'route'
                      ? t('codeCli.cli.targetRouteHint')
                      : t('codeCli.cli.routeKeyHint')}
                </p>
              ) : (
                // Always-on explainer: what the three target kinds mean, so the
                // difference between Route and Key is visible BEFORE choosing.
                <p className="text-xs text-muted-foreground/80">{t('codeCli.cli.targetHelp')}</p>
              )}
            </div>
          ) : null}
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
