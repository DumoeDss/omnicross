import { Check, ChevronDown, X } from 'lucide-react';
import { useLayoutEffect,useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { ApiFormat,LLMProvider, ModelConfig } from '@shared/llm-config';

import { getProviderIcon } from './utils';

export interface ProviderModelValue {
  providerId: string;
  modelId: string;
}

interface ProviderModelSelectorProps {
  /** Available providers to choose from */
  providers: LLMProvider[];
  /** Currently selected value */
  value: ProviderModelValue | null;
  /** Callback when selection changes */
  onChange: (value: ProviderModelValue | null) => void;
  /** Placeholder text when nothing selected */
  placeholder?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Whether to allow clearing the selection */
  allowClear?: boolean;
  /** Filter providers by API format */
  apiFormatFilter?: ApiFormat;
  /** Include code providers (anthropic format with claudecode apiType) */
  includeCodeProviders?: boolean;
  /** Only show models with vision capability */
  visionOnly?: boolean;
}

/**
 * A cascading dropdown selector for selecting Provider → Model.
 * First level shows providers, second level shows models from selected provider.
 */
export function ProviderModelSelector({
  providers,
  value,
  onChange,
  placeholder,
  disabled = false,
  allowClear = true,
  apiFormatFilter,
  includeCodeProviders,
  visionOnly
}: ProviderModelSelectorProps) {
  const t = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [flipUp, setFlipUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Calculate if dropdown should flip upward when it opens
  useLayoutEffect(() => {
    if (!isOpen || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const dropdownHeight = 280; // max-h-64 (256px) + some padding
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;

    // Flip up if not enough space below but enough space above
    queueMicrotask(() => {
      setFlipUp(spaceBelow < dropdownHeight && spaceAbove > spaceBelow);
    });
  }, [isOpen]);

  // Filter and process providers
  const availableProviders = useMemo(() => {
    let filtered = providers.filter(p => p.enabled);
    if (apiFormatFilter) {
      filtered = filtered.filter(p => (p.apiFormat || 'openai') === apiFormatFilter);
    }
    // Option to include only code providers (anthropic format for Agent mode)
    if (includeCodeProviders !== undefined) {
      const isCodeProvider = (p: LLMProvider) => p.apiFormat === 'anthropic' || p.apiType === 'claudecode';
      filtered = filtered.filter(p => includeCodeProviders ? isCodeProvider(p) : !isCodeProvider(p));
    }
    if (visionOnly) {
      filtered = filtered.filter(p => (p.modelConfigs || []).some(m => m.enabled !== false && m.vision));
    }
    return filtered;
  }, [providers, apiFormatFilter, includeCodeProviders, visionOnly]);

  // Resolve a provider's model list as ModelConfig[]. Regular LLM providers
  // (and the media providers mapped via toProviderModelFormat) carry rich
  // `modelConfigs`. Synthetic providers like the Code CLI one only populate the
  // flat `models: string[]` field, so fall back to materialising ModelConfig
  // rows from it — mirroring UnifiedModelSelector.buildModelOptions so both the
  // chat-input picker and this picker enumerate the same options.
  const resolveModelConfigs = (provider: LLMProvider): ModelConfig[] => {
    if (provider.modelConfigs && provider.modelConfigs.length > 0) {
      return provider.modelConfigs;
    }
    return (provider.models || []).map(modelId => ({
      id: modelId,
      name: modelId,
      enabled: true,
    }));
  };

  // Get selected provider and model info
  const selectedProvider = useMemo(() => {
    if (!value?.providerId) return null;
    return providers.find(p => p.id === value.providerId) || null;
  }, [providers, value]);

  const selectedModel = useMemo(() => {
    if (!selectedProvider || !value?.modelId) return null;
    return resolveModelConfigs(selectedProvider).find(m => m.id === value.modelId) || null;
  }, [selectedProvider, value]);

  // Get display text for the button
  const displayText = useMemo(() => {
    if (!selectedProvider || !value?.modelId) {
      return placeholder || t('providerSettings.providerModelSelector.placeholder');
    }
    const modelName = selectedModel?.name || value.modelId;
    return `${selectedProvider.name} / ${modelName}`;
  }, [selectedProvider, selectedModel, value, placeholder, t]);

  // Get models for a provider
  const getProviderModels = (provider: LLMProvider): ModelConfig[] => {
    let models = resolveModelConfigs(provider).filter(m => m.enabled !== false);
    if (visionOnly) {
      models = models.filter(m => m.vision);
    }
    return models;
  };

  const handleProviderClick = (providerId: string) => {
    if (expandedProviderId === providerId) {
      setExpandedProviderId(null);
    } else {
      setExpandedProviderId(providerId);
    }
  };

  const handleModelSelect = (providerId: string, modelId: string) => {
    onChange({ providerId, modelId });
    setIsOpen(false);
    setExpandedProviderId(null);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <Button
        type="button"
        variant="outline"
        className="w-full justify-between h-9 font-normal"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <span className="truncate text-left flex-1">
          {value ? (
            <span className="flex items-center gap-2">
              {selectedProvider ? getProviderIcon(selectedProvider.icon) : null}
              <span className="truncate">{displayText}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{displayText}</span>
          )}
        </span>
        <div className="flex items-center gap-1 ml-2 shrink-0">
          {allowClear && value ? <span
              role="button"
              tabIndex={0}
              className="p-0.5 hover:bg-muted rounded cursor-pointer"
              onClick={handleClear}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClear(e as any); }}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </span> : null}
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </Button>

      {/* Dropdown */}
      {isOpen ? <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => {
              setIsOpen(false);
              setExpandedProviderId(null);
            }}
          />

          {/* Menu */}
          <div
            ref={dropdownRef}
            className={`absolute z-50 left-0 right-0 bg-popover wallpaper-panel border rounded-md shadow-lg overflow-hidden ${
              flipUp ? 'bottom-full mb-1' : 'top-full mt-1'
            }`}
          >
            <ScrollArea className="max-h-64">
              <div className="p-1">
                {availableProviders.length === 0 ? (
                  <div className="p-3 text-center text-sm text-muted-foreground">
                    {t('providerSettings.providerModelSelector.noProviders')}
                  </div>
                ) : (
                  availableProviders.map(provider => {
                    const models = getProviderModels(provider);
                    const isExpanded = expandedProviderId === provider.id;
                    const isSelected = value?.providerId === provider.id;

                    return (
                      <div key={provider.id}>
                        {/* Provider row */}
                        <button
                          type="button"
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                            isExpanded ? 'bg-muted' : 'hover:bg-muted/60'
                          }`}
                          onClick={() => handleProviderClick(provider.id)}
                        >
                          {getProviderIcon(provider.icon)}
                          <span className="flex-1 text-left truncate font-medium">
                            {provider.name}
                          </span>
                          <Badge variant="outline" className="text-xs shrink-0">
                            {models.length}
                          </Badge>
                          <ChevronDown
                            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                              isExpanded ? 'rotate-180' : ''
                            }`}
                          />
                        </button>

                        {/* Models list (expanded) */}
                        {isExpanded ? <div className="ml-4 pl-2 border-l border-border/60 my-1">
                            {models.length === 0 ? (
                              <div className="py-2 px-2 text-xs text-muted-foreground">
                                {t('providerSettings.providerModelSelector.noModels')}
                              </div>
                            ) : (
                              models.map(model => {
                                const isModelSelected = isSelected && value?.modelId === model.id;
                                return (
                                  <button
                                    key={model.id}
                                    type="button"
                                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                                      isModelSelected
                                        ? 'bg-primary/10 text-primary'
                                        : 'hover:bg-muted/60'
                                    }`}
                                    onClick={() => handleModelSelect(provider.id, model.id)}
                                  >
                                    <span className="flex-1 text-left truncate">
                                      {model.name || model.id}
                                    </span>
                                    {isModelSelected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                                  </button>
                                );
                              })
                            )}
                          </div> : null}
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        </> : null}
    </div>
  );
}

export default ProviderModelSelector;
