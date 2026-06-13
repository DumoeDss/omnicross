import * as React from 'react';

import { cn } from '@/shared/utils/utils';

interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type' | 'role'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, defaultChecked, onCheckedChange, disabled, className, id, name, ...props }, ref) => {
    const [internalChecked, setInternalChecked] = React.useState(defaultChecked ?? false);

    const isControlled = checked !== undefined;
    const isChecked = isControlled ? checked : internalChecked;

    const handleClick = () => {
      if (disabled) return;

      const newValue = !isChecked;

      if (!isControlled) {
        setInternalChecked(newValue);
      }

      onCheckedChange?.(newValue);
    };

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={isChecked}
        data-state={isChecked ? 'checked' : 'unchecked'}
        disabled={disabled}
        id={id}
        name={name}
        onClick={handleClick}
        className={cn(
          'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-50',
          isChecked ? 'bg-primary' : 'bg-input',
          className
        )}
        {...props}
      >
        <span
          data-state={isChecked ? 'checked' : 'unchecked'}
          className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
            isChecked ? 'translate-x-4' : 'translate-x-0'
          )}
        />
      </button>
    );
  }
);

Switch.displayName = 'Switch';

export { Switch };
