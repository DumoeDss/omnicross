import React, { useRef } from 'react';

import { cn } from '@/shared/utils/utils';

import { SETTINGS_TABS, type SettingsTabId } from './settingsTabModel';

interface SettingsTabsProps {
  activeTab: SettingsTabId;
  labels: Record<SettingsTabId, string>;
  onChange: (tab: SettingsTabId) => void;
  ariaLabel: string;
}

export function SettingsTabs({ activeTab, labels, onChange, ariaLabel }: SettingsTabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const normalized = (index + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    onChange(SETTINGS_TABS[normalized].id);
    refs.current[normalized]?.focus();
  };

  return (
    <div className="border-b border-border/60 px-4 md:px-6">
      <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto" role="tablist" aria-label={ariaLabel}>
        {SETTINGS_TABS.map((tab, index) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => { refs.current[index] = node; }}
              id={`settings-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`settings-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={cn(
                'relative shrink-0 px-3 py-3 text-sm font-medium text-muted-foreground transition-colors',
                'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                selected && 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary',
              )}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') { event.preventDefault(); select(index + 1); }
                else if (event.key === 'ArrowLeft') { event.preventDefault(); select(index - 1); }
                else if (event.key === 'Home') { event.preventDefault(); select(0); }
                else if (event.key === 'End') { event.preventDefault(); select(SETTINGS_TABS.length - 1); }
              }}
            >
              {labels[tab.id]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
