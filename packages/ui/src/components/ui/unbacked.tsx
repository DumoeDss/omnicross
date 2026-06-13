/**
 * unbacked.tsx (design D6) — the consistent marker for controls bound to a
 * provider field the daemon does NOT store. Per the OQ2 gate decision, such
 * controls RENDER (full visual fidelity) but are DISABLED with a tooltip
 * ("Not yet supported by the daemon") — never hidden, never fake-success.
 *
 * Two affordances:
 *  - `<Unbacked>` wraps any control in the daemon-unsupported tooltip + a dimmed,
 *    pointer-events-disabled overlay so the control reads inert.
 *  - `unbackedTitle()` returns the resolved tooltip string for inline `title=` /
 *    `disabled` use on a single element.
 */

import React from 'react';

import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import Tooltip from './tooltip';

/** Resolve the "not yet supported by the daemon" tooltip string. */
export function useUnbackedTitle(): string {
  const t = useTranslation();
  return t('appLocal.notSupportedByDaemon');
}

interface UnbackedProps {
  children: React.ReactNode;
  className?: string;
  /** Tooltip placement (defaults to top). */
  position?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Wrap a daemon-unbacked control: shows the unsupported tooltip on hover and
 * renders the wrapped control inert (dimmed + no pointer events) so it is
 * visibly present but cannot be activated.
 */
export function Unbacked({ children, className, position = 'top' }: UnbackedProps) {
  const title = useUnbackedTitle();
  return (
    <Tooltip content={title} position={position}>
      <div
        className={cn('opacity-60 pointer-events-none select-none', className)}
        aria-disabled="true"
        data-unbacked="true"
      >
        {children}
      </div>
    </Tooltip>
  );
}
