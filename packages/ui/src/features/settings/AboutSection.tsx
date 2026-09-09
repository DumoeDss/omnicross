/**
 * AboutSection.tsx — the Settings → About panel: product identity, version,
 * and the project's GitHub presence.
 */

import { Bug, ExternalLink, Github, Rocket, ServerCog, Tag } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SettingRow } from '@/components/ui/setting-row';
import { DAEMON_BASE_URL } from '@/daemon/adminClient';
import { daemonFetch } from '@/daemon/httpFetch';
import { useTranslation } from '@/shared/state/LocaleContext';
import { openExternal } from '@/shared/tauri/openExternal';

import {
  APP_AUTHOR,
  APP_LICENSE,
  APP_NAME,
  GITHUB_ISSUES_URL,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
  resolveAboutVersion,
} from './aboutModel';

interface AboutSectionProps {
  /** Desktop bundle version from the updater bridge (undefined in the browser). */
  appVersion?: string;
}

/** Read the daemon's coarse, unauthenticated `/health` version (browser fallback). */
function useDaemonHealthVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    daemonFetch(`${DAEMON_BASE_URL}/health`, { method: 'GET' })
      .then(async (res) => {
        if (!res.ok) return;
        const body: unknown = await res.json().catch(() => null);
        const version = (body as { version?: unknown } | null)?.version;
        if (!cancelled && typeof version === 'string' && version.trim()) setVersion(version);
      })
      .catch(() => {
        // Daemon unreachable — the panel falls back to the "unknown" placeholder.
      });
    return () => { cancelled = true; };
  }, []);

  return version;
}

function LinkRow(props: {
  icon: typeof Github;
  label: string;
  description?: string;
  url: string;
  openLabel: string;
}) {
  const { icon: Icon, label, description, url, openLabel } = props;
  return (
    <SettingRow icon={Icon} label={label} description={description}>
      <Button size="sm" variant="outline" onClick={() => void openExternal(url)}>
        <ExternalLink aria-hidden="true" />
        {openLabel}
      </Button>
    </SettingRow>
  );
}

export function AboutSection({ appVersion }: AboutSectionProps) {
  const t = useTranslation();
  const daemonVersion = useDaemonHealthVersion();
  const version = resolveAboutVersion(appVersion, daemonVersion);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-5 px-4 py-5 md:px-6">
        <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
              <ServerCog className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 className="font-display text-base font-semibold text-foreground">{APP_NAME}</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">{t('settings.about.tagline')}</p>
            </div>
          </div>
          <div className="mt-4">
            <SettingRow icon={Tag} label={t('settings.about.version')}>
              <span className="font-mono text-sm tabular-nums text-muted-foreground">
                {version ?? t('settings.about.versionUnavailable')}
              </span>
            </SettingRow>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('settings.about.links.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.about.links.description')}</p>
          </div>
          <LinkRow
            icon={Github}
            label={t('settings.about.links.repository')}
            description="github.com/DumoeDss/omnicross"
            url={GITHUB_REPO_URL}
            openLabel={t('settings.about.links.open')}
          />
          <LinkRow
            icon={Rocket}
            label={t('settings.about.links.releases')}
            description={t('settings.about.links.releasesHint')}
            url={GITHUB_RELEASES_URL}
            openLabel={t('settings.about.links.open')}
          />
          <LinkRow
            icon={Bug}
            label={t('settings.about.links.issues')}
            description={t('settings.about.links.issuesHint')}
            url={GITHUB_ISSUES_URL}
            openLabel={t('settings.about.links.open')}
          />
        </section>

        <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
          <h3 className="text-sm font-semibold text-foreground">{t('settings.about.project.title')}</h3>
          <SettingRow label={t('settings.about.license')} description={t('settings.about.licenseHint')}>
            <span className="text-sm text-muted-foreground">{APP_LICENSE}</span>
          </SettingRow>
          <SettingRow label={t('settings.about.author')}>
            <span className="text-sm text-muted-foreground">{APP_AUTHOR}</span>
          </SettingRow>
        </section>
      </div>
    </ScrollArea>
  );
}
