/**
 * NavRail.tsx — the app's left nav rail, extracted from `App.tsx` (design D4).
 *
 * Renders the logo, the four nav items (Providers / API Service / Accounts /
 * Code CLI) with lucide icons + active state, the EN/中文 language switch, and
 * the daemon base-URL footer. Pure presentation: navigation state lives in
 * `App.tsx` and flows in via props.
 */

import { BarChart3, CircleDollarSign, type LucideIcon, ServerCog, Settings, Sliders, Terminal, Users } from 'lucide-react';
import React from 'react';

import { DAEMON_BASE_URL } from '@/daemon/adminClient';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

/** The page ids — the nav + `App.tsx` page switch share this union. */
export type PageId =
  | 'providers'
  | 'api-service'
  | 'accounts'
  | 'code-cli'
  | 'usage-stats'
  | 'pricing'
  | 'settings';

interface NavItemDef {
  id: PageId;
  icon: LucideIcon;
  labelKey: string;
}

const NAV_ITEMS: NavItemDef[] = [
  { id: 'providers', icon: Sliders, labelKey: 'nav.providers' },
  { id: 'api-service', icon: ServerCog, labelKey: 'nav.apiService' },
  { id: 'accounts', icon: Users, labelKey: 'nav.accounts' },
  { id: 'code-cli', icon: Terminal, labelKey: 'nav.codeCli' },
  { id: 'usage-stats', icon: BarChart3, labelKey: 'nav.dashboard' },
  { id: 'pricing', icon: CircleDollarSign, labelKey: 'nav.pricing' },
  { id: 'settings', icon: Settings, labelKey: 'nav.settings' },
];

interface NavRailProps {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
}

export function NavRail({ activePage, onNavigate }: NavRailProps) {
  const t = useTranslation();

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface-1">
      <div className="border-b border-border/60 px-4 py-4">
        <div className="flex items-center gap-2">
          <ServerCog className="h-5 w-5 text-primary" aria-hidden="true" />
          <span className="font-display text-base font-semibold">Omnicross</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('nav.subtitle')}</p>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.id === activePage;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-surface-2/60 text-foreground'
                  : 'text-muted-foreground hover:bg-surface-2/40 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-border/60 p-3">
        <p className="truncate text-[10px] text-muted-foreground/70" title={DAEMON_BASE_URL}>
          {DAEMON_BASE_URL}
        </p>
      </div>
    </aside>
  );
}
