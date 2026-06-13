import { Eye, EyeOff } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/shared/utils/utils';

import { Input } from './input';

type RevealableInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Controlled visibility state. If omitted, component manages its own state. */
  revealed?: boolean;
  /** Callback when visibility toggles. Required if `revealed` is controlled. */
  onRevealedChange?: (revealed: boolean) => void;
};

const RevealableInput = React.forwardRef<HTMLInputElement, RevealableInputProps>(
  ({ revealed, onRevealedChange, className, ...props }, ref) => {
    const [internalRevealed, setInternalRevealed] = React.useState(false);

    const isControlled = revealed !== undefined;
    const isRevealed = isControlled ? revealed : internalRevealed;

    const toggle = () => {
      const next = !isRevealed;
      if (!isControlled) setInternalRevealed(next);
      onRevealedChange?.(next);
    };

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={isRevealed ? 'text' : 'password'}
          className={cn('pr-10', className)}
          {...props}
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground transition-colors"
          onClick={toggle}
          tabIndex={-1}
          aria-label={isRevealed ? 'Hide' : 'Show'}
        >
          {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  }
);

RevealableInput.displayName = 'RevealableInput';

export { RevealableInput };
export type { RevealableInputProps };
