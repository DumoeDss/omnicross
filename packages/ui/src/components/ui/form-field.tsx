import * as React from 'react';

import { cn } from '@/shared/utils/utils';

interface FormFieldProps {
  /** Label text for the field */
  label: string;
  /** Optional description below the input */
  description?: string;
  /** Optional error message */
  error?: string;
  /** HTML id for the input (used to associate label) */
  htmlFor?: string;
  /** Optional right-aligned element in the label row (e.g. external link icon) */
  labelAction?: React.ReactNode;
  /** The input / control element */
  children: React.ReactNode;
  /** Additional className for the outer container */
  className?: string;
}

const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(
  ({ label, description, error, htmlFor, labelAction, children, className }, ref) => (
    <div ref={ref} className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {labelAction ? (
          <>
            <div className="flex-1" />
            {labelAction}
          </>
        ) : null}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
);

FormField.displayName = 'FormField';

export { FormField };
export type { FormFieldProps };
