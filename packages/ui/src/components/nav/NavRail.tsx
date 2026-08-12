import { Activity, BarChart3, Boxes, Cable, KeyRound, Menu, Route, ServerCog, Settings } from 'lucide-react';
import React, { useState } from 'react';

import { DAEMON_BASE_URL } from '@/daemon/adminClient';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { AppRoute, PageId } from '@/shared/state/hashRoute';
import { cn } from '@/shared/utils/utils';

import { MOBILE_MORE_LABEL_KEY, MOBILE_PRIMARY_KEYS, NAV_GROUPS, type NavItemDef } from './navModel';

const NAV_ICONS = {
  overview: Activity,
  gateway: ServerCog,
  'access-keys': KeyRound,
  'route-activity': Route,
  usage: BarChart3,
  upstreams: Boxes,
  integrations: Cable,
  settings: Settings,
} as const;

/** An item is active when its page matches and (for tabbed pages) its tab matches. */
function itemIsActive(item: NavItemDef, route: AppRoute): boolean {
  if (item.page !== route.page) return false;
  if (!item.tab) return true;
  // api-service: an absent tab reads as the default 'overview' tab.
  const activeTab = item.page === 'api-service' ? (route.tab ?? 'overview') : route.tab;
  return activeTab === item.tab;
}

interface NavRailProps { route: AppRoute; onNavigate: (route: AppRoute) => void }

const allNavItems = NAV_GROUPS.flatMap((group) => group.items);
const mobilePrimaryItems = allNavItems.filter((item) => MOBILE_PRIMARY_KEYS.includes(item.key));

export function NavRail({ route, onNavigate }: NavRailProps) {
  const t = useTranslation();
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const mobileMoreActive = !mobilePrimaryItems.some((item) => itemIsActive(item, route));
  const mobileMoreLabel = t(MOBILE_MORE_LABEL_KEY);

  const go = (item: NavItemDef) => {
    const next = { page: item.page } as AppRoute;
    if (item.tab) next.tab = item.tab as AppRoute['tab'];
    onNavigate(next);
  };
  const navigateFromMobile = (item: NavItemDef) => {
    go(item);
    setMobileMoreOpen(false);
  };

  return (
    <>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface-1 md:flex md:h-full">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3 md:block md:py-4">
          <div className="flex items-center gap-2">
            <ServerCog className="h-5 w-5 text-primary" aria-hidden="true" />
            <span className="font-display text-base font-semibold">Omnicross</span>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground md:mt-1 md:normal-case md:tracking-normal">{t('nav.subtitle')}</p>
        </div>

        <nav className="min-w-0 flex-1 overflow-y-auto px-2 py-4" aria-label={t('nav.primary')}>
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="mt-5 space-y-1 first:mt-0">
              <p className="px-3 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">{t(`nav.group.${group.id}`)}</p>
              {group.items.map((item) => {
                const Icon = NAV_ICONS[item.icon];
                const active = itemIsActive(item, route);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => go(item)}
                    aria-current={active ? 'page' : undefined}
                    aria-label={t(item.labelKey)}
                    className={cn(
                      'flex min-h-10 w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-surface-2/80 text-foreground' : 'text-muted-foreground hover:bg-surface-2/40 hover:text-foreground',
                    )}
                    title={t(item.labelKey)}
                  >
                    <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                    <span className="truncate">{t(item.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="border-t border-border/60 p-3">
          <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={DAEMON_BASE_URL}>{DAEMON_BASE_URL}</p>
        </div>
      </aside>

      <aside
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface-1/95 shadow-[0_-8px_24px_hsl(var(--text-strong)/0.08)] backdrop-blur md:hidden"
        style={{ paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))' }}
      >
        <nav className="mx-auto grid max-w-xl grid-cols-5 gap-1 px-2 pt-1" aria-label={t('nav.primary')}>
          {mobilePrimaryItems.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            const active = itemIsActive(item, route);
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => navigateFromMobile(item)}
                aria-current={active ? 'page' : undefined}
                aria-label={t(item.labelKey)}
                className={cn(
                  'flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[10px] font-medium',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'bg-surface-2/80 text-foreground' : 'text-muted-foreground hover:bg-surface-2/40 hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
                <span className="max-w-full truncate">{t(item.labelKey)}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMobileMoreOpen(true)}
            aria-expanded={mobileMoreOpen}
            aria-haspopup="dialog"
            aria-label={mobileMoreLabel}
            className={cn(
              'flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[10px] font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              mobileMoreActive ? 'bg-surface-2/80 text-foreground' : 'text-muted-foreground hover:bg-surface-2/40 hover:text-foreground',
            )}
          >
            <Menu className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
            <span>{mobileMoreLabel}</span>
          </button>
        </nav>
      </aside>

      <Dialog open={mobileMoreOpen} onOpenChange={setMobileMoreOpen}>
        <DialogContent
          className="md:hidden w-auto max-w-[28rem] rounded-xl p-2"
          style={{
            left: '0.5rem',
            right: '0.5rem',
            top: 'auto',
            bottom: 'calc(max(0.25rem, env(safe-area-inset-bottom)) + 4.25rem)',
            width: 'auto',
            maxWidth: 'calc(100vw - 1rem)',
            maxHeight: 'calc(100dvh - (max(0.25rem, env(safe-area-inset-bottom)) + 5.25rem))',
            overflowY: 'auto',
            transform: 'none',
          }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t('nav.primary')}</DialogTitle>
            <DialogDescription>{t('nav.subtitle')}</DialogDescription>
          </DialogHeader>
          <nav aria-label={t('nav.primary')} className="space-y-4 p-2">
            {NAV_GROUPS.map((group) => (
              <div key={group.id} className="space-y-1">
                <p className="px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">{t(`nav.group.${group.id}`)}</p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {group.items.map((item) => {
                    const Icon = NAV_ICONS[item.icon];
                    const active = itemIsActive(item, route);
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => navigateFromMobile(item)}
                        aria-current={active ? 'page' : undefined}
                        aria-label={t(item.labelKey)}
                        className={cn(
                          'flex min-w-0 min-h-10 items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active ? 'bg-surface-2/80 text-foreground' : 'text-muted-foreground hover:bg-surface-2/40 hover:text-foreground',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                        <span className="min-w-0 truncate">{t(item.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type { PageId } from '@/shared/state/hashRoute';
export { MOBILE_MORE_LABEL_KEY, MOBILE_PRIMARY_KEYS, NAV_GROUPS } from './navModel';
