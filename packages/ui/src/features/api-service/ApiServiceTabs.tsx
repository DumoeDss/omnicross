import React, { useRef } from 'react';

import { cn } from '@/shared/utils/utils';

import { API_SERVICE_TABS, type ApiServiceTabId } from './apiServiceTabModel';

interface ApiServiceTabsProps {
  activeTab: ApiServiceTabId;
  ariaLabel: string;
  labels: Record<ApiServiceTabId, string>;
  onChange: (tab: ApiServiceTabId) => void;
}

export function ApiServiceTabs({ activeTab, ariaLabel, labels, onChange }: ApiServiceTabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveFocus = (currentIndex: number, delta: number) => {
    const nextIndex = (currentIndex + delta + API_SERVICE_TABS.length) % API_SERVICE_TABS.length;
    const nextTab = API_SERVICE_TABS[nextIndex];
    onChange(nextTab.id);
    refs.current[nextIndex]?.focus();
  };

  return (
    <div className="border-b border-border/60 px-6">
      <div
        className="mx-auto flex max-w-5xl gap-1 overflow-x-auto"
        role="tablist"
        aria-label={ariaLabel}
      >
        {API_SERVICE_TABS.map((tab, index) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`api-service-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`api-service-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={cn(
                'relative shrink-0 px-3 py-3 text-sm font-medium text-muted-foreground transition-colors',
                'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                selected && 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary',
              )}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  moveFocus(index, 1);
                } else if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  moveFocus(index, -1);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  onChange(API_SERVICE_TABS[0].id);
                  refs.current[0]?.focus();
                } else if (event.key === 'End') {
                  event.preventDefault();
                  const last = API_SERVICE_TABS.length - 1;
                  onChange(API_SERVICE_TABS[last].id);
                  refs.current[last]?.focus();
                }
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
