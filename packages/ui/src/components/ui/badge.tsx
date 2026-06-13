import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/shared/utils/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted transition-colors select-none',
  {
    variants: {
      variant: {
        default: 'border-primary/50 bg-primary-soft/35 text-primary',
        secondary: 'border-border bg-surface-2 text-text-muted',
        destructive: 'border-destructive/60 bg-destructive/15 text-destructive',
        outline: 'border-border bg-surface-1/60 text-text-muted',
        success: 'border-success/60 bg-success/15 text-success',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type BadgeProps = React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
