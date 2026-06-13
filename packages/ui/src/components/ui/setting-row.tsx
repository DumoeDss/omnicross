import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/shared/utils/utils';

interface SettingRowProps {
  /** Optional icon displayed on the left */
  icon?: LucideIcon;
  /** Primary label text */
  label: string;
  /** Secondary description text below the label */
  description?: string;
  /** Control element on the right side (Switch, Select, Input, Button, etc.) */
  children?: React.ReactNode;
  /** Visual variant */
  variant?: 'default' | 'compact';
  /** Additional className for the outer container */
  className?: string;
}

const SettingRow = React.forwardRef<HTMLDivElement, SettingRowProps>(
  ({ icon: Icon, label, description, children, variant = 'default', className }, ref) => {
    const isCompact = variant === 'compact';

    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-between rounded-md border border-border/60 bg-surface-0/60',
          isCompact ? 'gap-2 p-2' : 'gap-3 px-3 py-2',
          className
        )}
      >
        <div className={cn('min-w-0', Icon && 'flex items-center gap-3')}>
          {Icon ? (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-0/70 wallpaper-blur text-text-muted">
              <Icon className="h-4 w-4" strokeWidth={1.5} />
            </span>
          ) : null}
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{label}</div>
            {description ? (
              <div className="text-xs text-text-muted">{description}</div>
            ) : null}
          </div>
        </div>
        {children ? <div className="shrink-0">{children}</div> : null}
      </div>
    );
  }
);

SettingRow.displayName = 'SettingRow';

/* ── Slider variant ─────────────────────────────────────────────────── */

interface SettingSliderRowProps {
  label: string;
  description?: string;
  /** Formatted value display (e.g. "6px", "70%") */
  valueDisplay: string;
  /** Slider or other block-level control rendered below the header */
  children: React.ReactNode;
  className?: string;
}

const SettingSliderRow = React.forwardRef<HTMLDivElement, SettingSliderRowProps>(
  ({ label, description, valueDisplay, children, className }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-md border border-border/60 bg-surface-0/60 px-3 py-2 space-y-1.5',
        className
      )}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          {description ? (
            <div className="text-xs text-text-muted">{description}</div>
          ) : null}
        </div>
        <span className="text-sm text-muted-foreground tabular-nums w-12 text-right shrink-0">
          {valueDisplay}
        </span>
      </div>
      {children}
    </div>
  )
);

SettingSliderRow.displayName = 'SettingSliderRow';

export { SettingRow, SettingSliderRow };
export type { SettingRowProps, SettingSliderRowProps };
