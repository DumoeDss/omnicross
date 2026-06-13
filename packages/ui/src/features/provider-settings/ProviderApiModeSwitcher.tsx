import React from 'react';

import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import type { ApiMode } from '@shared/llm-config';

interface ProviderApiModeSwitcherProps {
  modes: ApiMode[];
  selectedId: string | undefined;
  onChange: (modeId: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Mode switcher next to the API URL field on providers with multiple endpoint
 * variants. Renders the project's standard `Switch` component flanked by the
 * two mode labels — left = mode[0] (typically "standard"), right = mode[1]
 * (e.g. "coding-plan" / "token-plan"). Clicking either label is equivalent
 * to flipping the switch.
 *
 * All current presets (10 of them) declare exactly 2 modes. If a preset ever
 * declares 3+ modes, an explicit visual would be needed; for now we surface a
 * runtime warning and pick the first two so the UI doesn't disappear silently.
 */
export function ProviderApiModeSwitcher({
  modes,
  selectedId,
  onChange,
  disabled,
  className,
}: ProviderApiModeSwitcherProps) {
  const t = useTranslation();

  if (!modes || modes.length < 2) return null;

  // 3+ mode case — fall back to first two (with a warning to flag the design gap)
  const [leftMode, rightMode] = modes.length === 2
    ? modes
    : [modes[0], modes[1]];

  if (modes.length > 2 && import.meta.env.DEV) {
    console.warn(
      `[ProviderApiModeSwitcher] preset declares ${modes.length} modes but only 2 are surfaced. ` +
      'Add a multi-option select if more than 2 are needed.',
    );
  }

  const isRight = selectedId === rightMode.id;

  const labelClass = (active: boolean) =>
    cn(
      'text-xs font-medium select-none cursor-pointer transition-colors',
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      disabled && 'cursor-not-allowed opacity-60',
    );

  return (
    <div
      className={cn('inline-flex items-center gap-2', className)}
      data-testid="provider-api-mode-switcher"
    >
      <button
        type="button"
        onClick={() => !disabled && onChange(leftMode.id)}
        className={labelClass(!isRight)}
        data-mode-id={leftMode.id}
        aria-pressed={!isRight}
      >
        {t(leftMode.label) || leftMode.label}
      </button>
      <Switch
        checked={isRight}
        onCheckedChange={(checked) => onChange((checked ? rightMode : leftMode).id)}
        disabled={disabled}
        aria-label={t('apiMode.label')}
      />
      <button
        type="button"
        onClick={() => !disabled && onChange(rightMode.id)}
        className={labelClass(isRight)}
        data-mode-id={rightMode.id}
        aria-pressed={isRight}
      >
        {t(rightMode.label) || rightMode.label}
      </button>
    </div>
  );
}
