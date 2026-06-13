import * as React from 'react';

import { cn } from '@/shared/utils/utils';

type Density = 'default' | 'compact';
type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  density?: Density;
};

const densityClasses: Record<Density, string> = {
  default: 'h-8 py-1.5',
  compact: 'h-7 py-1'
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', density = 'default', ...props }, ref) => {
    return (
      <input
        type={type}
        data-density={density}
        className={cn(
          'flex w-full rounded-md border border-input bg-surface-1 px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          densityClasses[density],
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
