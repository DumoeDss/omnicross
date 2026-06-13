import * as React from 'react';

import { cn } from '@/shared/utils/utils';

type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement> & {
  shadow?: boolean;
};

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, shadow = true, ...props }, ref) => (
    // `overflow: clip` (NOT `hidden`): hidden still establishes a scroll
    // container, so any tabbable / focused descendant — or a programmatic
    // `scrollIntoView` on the inner — silently scrolls THIS wrapper too,
    // even though the user can't see it. That phantom scrollTop shifts
    // the inner viewport off-screen (rect.top goes negative) and creates
    // a "dead zone" below it where content visually appears to be
    // unreachable. `clip` paints the same as `hidden` but cannot be
    // scrolled programmatically. Chromium 90+ / Safari 16+.
    //
    // `min-h-0` is required because `overflow: clip` does NOT trigger the
    // implicit `min-height: 0` override that `overflow: hidden` provides
    // for flex children. Without it, the ScrollArea's min-content height
    // bubbles up to its content's natural height (e.g. a tall form card),
    // expanding its flex parent and pushing the chat input below the
    // viewport.
    <div
      ref={ref}
      className={cn('relative h-full min-h-0', className)}
      style={{ overflow: 'clip' }}
      {...props}
    >
      <div
        data-scroll-container
        className="h-full scroll-smooth overflow-auto rounded-[inherit] pr-2"
        style={{
          WebkitOverflowScrolling: 'touch',
          touchAction: 'pan-y',
          maxHeight: 'inherit'
        }}
      >
        {children}
      </div>
      {shadow ? <>
          <div className="scroll-shadow pointer-events-none absolute inset-x-0 top-0 h-2 bg-gradient-to-b from-surface-0 via-surface-0/80 to-transparent" />
          <div className="scroll-shadow pointer-events-none absolute inset-x-0 bottom-0 h-2 bg-gradient-to-t from-surface-0 via-surface-0/80 to-transparent" />
        </> : null}
    </div>
  )
);
ScrollArea.displayName = 'ScrollArea';

export { ScrollArea };
