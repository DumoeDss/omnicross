import { ChevronDown, ChevronUp,HelpCircle, X } from 'lucide-react';
import React, { useId, useState } from 'react';
import ReactDOM from 'react-dom';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';
import { cn } from '@/shared/utils/utils';

import type {
  OpenRouterDataCollection,
  OpenRouterProviderRouting,
  OpenRouterProviderSort,
  OpenRouterQuantization
} from '@shared/llm-config';

interface OpenRouterProviderConfigProps {
  config: OpenRouterProviderRouting;
  onChange: (config: OpenRouterProviderRouting) => void;
  defaultExpanded?: boolean;
}

const SORT_OPTIONS: { value: OpenRouterProviderSort | ''; label: string }[] = [
  { value: '', label: 'Auto (Load Balanced)' },
  { value: 'price', label: 'Price (Lowest)' },
  { value: 'throughput', label: 'Throughput (Highest)' },
  { value: 'latency', label: 'Latency (Lowest)' }
];

const DATA_COLLECTION_OPTIONS: { value: OpenRouterDataCollection; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' }
];

const QUANTIZATION_OPTIONS: { value: OpenRouterQuantization; label: string }[] = [
  { value: 'fp32', label: 'FP32 (Full precision)' },
  { value: 'bf16', label: 'BF16 (Brain float 16)' },
  { value: 'fp16', label: 'FP16 (Half precision)' },
  { value: 'fp8', label: 'FP8 (8-bit float)' },
  { value: 'int8', label: 'INT8 (8-bit integer)' },
  { value: 'int4', label: 'INT4 (4-bit integer)' }
];

function PortalTooltip({ content, children }: { content: string; children: React.ReactNode }) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setPosition({
          x: rect.left + rect.width / 2,
          y: rect.top - 8
        });
      }
      setIsVisible(true);
    }, 300);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  };

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="inline-flex"
      >
        {children}
      </span>
      {isVisible ? ReactDOM.createPortal(
        <div
          className="fixed z-[9999] px-2 py-1.5 text-xs font-medium text-popover-foreground bg-popover border border-border/70 rounded shadow-lg max-w-xs pointer-events-none animate-in fade-in-0 zoom-in-95 duration-200"
          style={{
            left: position.x,
            top: position.y,
            transform: 'translate(-50%, -100%)'
          }}
        >
          {content}
        </div>,
        document.body
      ) : null}
    </>
  );
}

function LabelWithTooltip({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <label className="text-sm font-medium flex items-center gap-1">
      {label}
      <PortalTooltip content={tooltip}>
        <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
      </PortalTooltip>
    </label>
  );
}

function TagInput({
  value,
  onChange,
  placeholder
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
}) {
  const [inputValue, setInputValue] = React.useState('');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      if (!value.includes(inputValue.trim())) {
        onChange([...value, inputValue.trim()]);
      }
      setInputValue('');
    }
  };

  const removeTag = (tag: string) => {
    onChange(value.filter(t => t !== tag));
  };

  return (
    <div className="space-y-2">
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="text-sm"
      />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-xs"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function OpenRouterProviderConfig({ config, onChange, defaultExpanded = false }: OpenRouterProviderConfigProps) {
  const t = useTranslation();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const promptPriceId = useId();
  const completionPriceId = useId();

  const updateConfig = <K extends keyof OpenRouterProviderRouting>(
    key: K,
    value: OpenRouterProviderRouting[K]
  ) => {
    onChange({ ...config, [key]: value });
  };

  // Check if any config is set (to show indicator)
  const hasConfig = Object.values(config).some(v =>
    v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : true)
  );

  return (
    <div className="border-t pt-4 mt-4">
      <button
        type="button"
        className="w-full flex items-center justify-between text-left"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-foreground">
            {t('providerSettings.openRouter.title', 'OpenRouter Provider Routing')}
          </h4>
          {hasConfig && !isExpanded ? <span className="text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded">
              {t('providerSettings.openRouter.configured', 'Configured')}
            </span> : null}
        </div>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!isExpanded && (
        <p className="text-xs text-muted-foreground mt-1">
          {t('providerSettings.openRouter.description', 'Configure how requests are routed to different providers on OpenRouter.')}
        </p>
      )}

      <div className={cn('space-y-4 mt-4', !isExpanded && 'hidden')}>

      {/* Sort Strategy */}
      <div className="space-y-1.5">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.sort', 'Routing Strategy')}
          tooltip={t('providerSettings.openRouter.sortTooltip', 'Choose how to prioritize providers. Auto uses intelligent load balancing.')}
        />
        <Select
          value={config.sort || ''}
          onChange={(value) => updateConfig('sort', value as OpenRouterProviderSort || undefined)}
          options={SORT_OPTIONS.map(opt => ({ value: opt.value, label: opt.label }))}
        />
      </div>

      {/* Provider Order */}
      <div className="space-y-1.5">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.order', 'Provider Priority Order')}
          tooltip={t('providerSettings.openRouter.orderTooltip', 'Specify providers to try in order (e.g., anthropic, openai, together). Press Enter to add.')}
        />
        <TagInput
          value={config.order || []}
          onChange={(value) => updateConfig('order', value.length > 0 ? value : undefined)}
          placeholder={t('providerSettings.openRouter.orderPlaceholder', 'Type provider slug and press Enter...')}
        />
      </div>

      {/* Allow Fallbacks */}
      <div className="flex items-center justify-between">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.allowFallbacks', 'Allow Fallbacks')}
          tooltip={t('providerSettings.openRouter.allowFallbacksTooltip', 'When enabled, OpenRouter will try backup providers if the primary is unavailable.')}
        />
        <Switch
          checked={config.allow_fallbacks !== false}
          onCheckedChange={(checked) => updateConfig('allow_fallbacks', checked ? undefined : false)}
        />
      </div>

      {/* Require Parameters */}
      <div className="flex items-center justify-between">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.requireParameters', 'Require All Parameters')}
          tooltip={t('providerSettings.openRouter.requireParametersTooltip', 'Only route to providers that support all parameters in your request.')}
        />
        <Switch
          checked={config.require_parameters === true}
          onCheckedChange={(checked) => updateConfig('require_parameters', checked || undefined)}
        />
      </div>

      {/* Data Collection */}
      <div className="space-y-1.5">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.dataCollection', 'Data Collection Policy')}
          tooltip={t('providerSettings.openRouter.dataCollectionTooltip', 'Control whether to use providers that may store or train on your data.')}
        />
        <Select
          value={config.data_collection || 'allow'}
          onChange={(value) => updateConfig('data_collection', value === 'allow' ? undefined : value as OpenRouterDataCollection)}
          options={DATA_COLLECTION_OPTIONS.map(opt => ({ value: opt.value, label: opt.label }))}
        />
      </div>

      {/* ZDR (Zero Data Retention) */}
      <div className="flex items-center justify-between">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.zdr', 'Zero Data Retention')}
          tooltip={t('providerSettings.openRouter.zdrTooltip', 'Only route to endpoints with Zero Data Retention policy.')}
        />
        <Switch
          checked={config.zdr === true}
          onCheckedChange={(checked) => updateConfig('zdr', checked || undefined)}
        />
      </div>

      {/* Only Providers */}
      <div className="space-y-1.5">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.only', 'Only Allow Providers')}
          tooltip={t('providerSettings.openRouter.onlyTooltip', 'Only use these specific providers. Leave empty to allow all providers.')}
        />
        <TagInput
          value={config.only || []}
          onChange={(value) => updateConfig('only', value.length > 0 ? value : undefined)}
          placeholder={t('providerSettings.openRouter.onlyPlaceholder', 'Type provider slug and press Enter...')}
        />
      </div>

      {/* Ignore Providers */}
      <div className="space-y-1.5">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.ignore', 'Ignore Providers')}
          tooltip={t('providerSettings.openRouter.ignoreTooltip', 'Skip these providers when routing requests.')}
        />
        <TagInput
          value={config.ignore || []}
          onChange={(value) => updateConfig('ignore', value.length > 0 ? value : undefined)}
          placeholder={t('providerSettings.openRouter.ignorePlaceholder', 'Type provider slug and press Enter...')}
        />
      </div>

      {/* Quantizations */}
      <div className="space-y-1.5">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.quantizations', 'Quantization Filter')}
          tooltip={t('providerSettings.openRouter.quantizationsTooltip', 'Only use providers with specific quantization levels. Lower precision may reduce quality but improve speed.')}
        />
        <div className="flex flex-wrap gap-2">
          {QUANTIZATION_OPTIONS.map(opt => (
            <label key={opt.value} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={config.quantizations?.includes(opt.value) || false}
                onChange={(e) => {
                  const current = config.quantizations || [];
                  if (e.target.checked) {
                    updateConfig('quantizations', [...current, opt.value]);
                  } else {
                    const filtered = current.filter(q => q !== opt.value);
                    updateConfig('quantizations', filtered.length > 0 ? filtered : undefined);
                  }
                }}
                className="rounded border-border"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      {/* Max Price */}
      <div className="space-y-2">
        <LabelWithTooltip
          label={t('providerSettings.openRouter.maxPrice', 'Maximum Price')}
          tooltip={t('providerSettings.openRouter.maxPriceTooltip', 'Set maximum price limits per million tokens. Leave empty for no limit.')}
        />
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label htmlFor={promptPriceId} className="text-xs text-muted-foreground">Prompt ($/M tokens)</label>
            <Input
              id={promptPriceId}
              type="number"
              step="0.01"
              min="0"
              value={config.max_price?.prompt ?? ''}
              onChange={(e) => {
                const value = e.target.value ? parseFloat(e.target.value) : undefined;
                updateConfig('max_price', {
                  ...config.max_price,
                  prompt: value
                });
              }}
              placeholder="No limit"
              className="text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={completionPriceId} className="text-xs text-muted-foreground">Completion ($/M tokens)</label>
            <Input
              id={completionPriceId}
              type="number"
              step="0.01"
              min="0"
              value={config.max_price?.completion ?? ''}
              onChange={(e) => {
                const value = e.target.value ? parseFloat(e.target.value) : undefined;
                updateConfig('max_price', {
                  ...config.max_price,
                  completion: value
                });
              }}
              placeholder="No limit"
              className="text-sm"
            />
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
