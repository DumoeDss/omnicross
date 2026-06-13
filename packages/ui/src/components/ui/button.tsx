import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/shared/utils/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[3px] border text-sm font-medium tracking-[0.01em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground border-transparent hover:bg-primary/90 active:bg-primary/80",
        destructive: "bg-destructive text-destructive-foreground border-transparent hover:bg-destructive/90",
        outline: "border-border bg-surface-1 text-foreground hover:border-primary hover:text-foreground",
        secondary: "bg-transparent text-foreground border-border hover:bg-surface-2/80 hover:border-text-subtle/40",
        ghost: "border-transparent bg-transparent text-text-muted hover:text-foreground hover:bg-primary-soft/30",
        subtle: "border-transparent bg-primary-soft/20 text-foreground hover:bg-primary-soft/30",
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3.5",
        xs: "h-6 px-2 text-xs",
        sm: "h-7 px-3 text-xs",
        lg: "h-9 px-4",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
