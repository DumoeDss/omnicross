import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Settings2} from 'lucide-react';
import React, { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import {
  type ApiFormat,
  BUILTIN_TRANSFORMERS,
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
  type TransformerEntry,
} from '@shared/llm-config';

import type { ProviderFormData } from './types';

/** The transform-rule NAME of a `use[]` entry (bare string or `[name, opts]` tuple). */
function transformerEntryName(entry: TransformerEntry): string {
  return Array.isArray(entry) ? entry[0] : entry;
}

// Provider type options for the dropdown
const PROVIDER_TYPE_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
  { value: 'openai-response', label: 'OpenAI (Responses API)' }
];

// Get template by apiFormat
const getTemplateByApiFormat = (apiFormat: ApiFormat): ProviderTemplate | undefined => {
  const templateMap: Record<ApiFormat, string> = {
    'openai': 'openai',
    'google': 'gemini',
    'anthropic': 'anthropic',
    'azure-openai': 'azure-openai',
    'openai-response': 'openai-response'
  };
  return PROVIDER_TEMPLATES.find(t => t.id === templateMap[apiFormat]);
};

interface ProviderFormProps {
  isEditing: boolean;
  isAddingNew: boolean;
  formData: ProviderFormData;
  setFormData: React.Dispatch<React.SetStateAction<ProviderFormData>>;
  formError: string | null;
  showApiKey: boolean;
  setShowApiKey: React.Dispatch<React.SetStateAction<boolean>>;
  /**
   * provider-storage-secrets: whether the provider being edited already has a
   * stored (encrypted) key. The renderer never receives the key itself, so when
   * true we render a masked "key is set" placeholder and an empty field means
   * "leave it unchanged".
   */
  hasKey?: boolean;
  /** Same, for the coding-plan key. */
  hasCodingPlanKey?: boolean;
  onCancel: () => void;
  onSave: () => void;
}

export function ProviderForm({
  isEditing,
  isAddingNew,
  formData,
  setFormData,
  formError,
  showApiKey,
  setShowApiKey,
  hasKey,
  hasCodingPlanKey,
  onCancel,
  onSave
}: ProviderFormProps) {
  const t = useTranslation();
  const [showTransformerConfig, setShowTransformerConfig] = useState(false);

  // Provider-level transform chain `use[]` (app-parity child 5). The minimal
  // checklist edits the chain by NAME; the count badge reads its length.
  const transformerUse = formData.transformer?.use ?? [];
  const transformerCount = transformerUse.length;
  const selectedTransformerNames = new Set(transformerUse.map(transformerEntryName));

  /**
   * Toggle a transformer NAME in `formData.transformer.use` (app-parity child 5).
   * Adding inserts a BARE name (option-carrying transformers keep their options
   * editor out of scope in v1); removing drops every entry with that name. Any
   * per-model transformer keys on the config object are PRESERVED verbatim (only
   * `use` is rewritten) so a round-trip is non-lossy.
   */
  const handleToggleTransformer = (name: string, checked: boolean) => {
    setFormData((prev) => {
      const current = prev.transformer?.use ?? [];
      const next = checked
        ? current.some((e) => transformerEntryName(e) === name)
          ? current
          : [...current, name]
        : current.filter((e) => transformerEntryName(e) !== name);
      return { ...prev, transformer: { ...prev.transformer, use: next } };
    });
  };

  // Handle provider type change
  const handleProviderTypeChange = (apiFormat: string) => {
    const template = getTemplateByApiFormat(apiFormat as ApiFormat);
    if (template) {
      setFormData(prev => ({
        ...prev,
        apiFormat: template.apiFormat || 'openai',
        chatApiFormat: template.chatApiFormat || template.apiFormat || 'openai',
        apiType: template.apiType,
        api_base_url: template.api_base_url,
        models: [...template.models],
        modelConfigs: template.modelConfigs ? [...template.modelConfigs] : [],
        modelGroups: template.modelGroups ? [...template.modelGroups] : [],
        modelsEndpoint: template.modelsEndpoint,
        icon: template.icon,
        transformer: template.transformer,
        apiVersion: template.apiVersion
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        apiFormat: apiFormat as ApiFormat,
        apiVersion: undefined
      }));
    }
  };

  return (
    <div className="space-y-4 p-4">
      {formError ? <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-red-500 text-sm">
          {formError}
        </div> : null}

      {/* Provider Name (app-parity-2 child 1). The daemon now stores a mutable
          display `name` SEPARATE from the immutable id, so the field is live on
          both add AND edit. The id is still derived from the name on create and
          remains the identity key (it cannot change); editing the name only
          updates the display label. */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('providerSettings.form.name')}</label>
        <Input
          placeholder={t('providerSettings.form.name')}
          value={formData.name}
          onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
        />
      </div>

      {/* Provider Type (only for new providers) */}
      {isAddingNew ? <div className="space-y-2">
          <label className="text-sm font-medium">{t('providerSettings.form.providerType')}</label>
          <Select
            value={formData.apiFormat || 'openai'}
            onChange={handleProviderTypeChange}
            options={PROVIDER_TYPE_OPTIONS}
          />
        </div> : null}

      {/* API Key */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('providerSettings.form.apiKey')}</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type={showApiKey ? 'text' : 'password'}
              placeholder={hasKey
                ? t('providerSettings.form.apiKeySetPlaceholder')
                : t('providerSettings.form.apiKeyPlaceholder')}
              value={formData.api_key}
              onChange={(e) => setFormData(prev => ({ ...prev, api_key: e.target.value }))}
              className="pr-10"
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground"
              onClick={() => setShowApiKey(!showApiKey)}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {hasKey
            ? t('providerSettings.form.apiKeyReplaceHelper')
            : t('providerSettings.form.apiKeyHelper')}
        </p>
      </div>

      {/* API Base URL */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('providerSettings.form.apiUrl')}</label>
        <Input
          placeholder={t('providerSettings.form.apiUrlPlaceholder')}
          value={formData.api_base_url}
          onChange={(e) => setFormData(prev => ({ ...prev, api_base_url: e.target.value }))}
        />
        {formData.api_base_url ? <p className="text-xs text-muted-foreground flex items-center gap-1">
            {t('providerSettings.form.apiUrlPreview')} {formData.api_base_url}
            <ExternalLink className="h-3 w-3" />
          </p> : null}
      </div>

      {/* Coding Plan (app-parity-2 child 3) — daemon-backed. The daemon stores the
          coding-plan endpoint (baseUrl + secret key) and core's
          `resolveProviderEndpoint` routes through it when enabled. The key is
          write-only (blank-on-edit keeps the stored key; never returned). */}
      <div className="border rounded-lg p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium">{t('providerSettings.form.codingPlan.label')}</label>
            <p className="text-xs text-muted-foreground">
              {t('providerSettings.form.codingPlan.description')}
            </p>
          </div>
          <Switch
            checked={formData.codingPlan?.enabled ?? false}
            onCheckedChange={(checked) =>
              setFormData(prev => ({ ...prev, codingPlan: { ...(prev.codingPlan ?? { enabled: false }), enabled: checked } }))
            }
          />
        </div>
        {formData.codingPlan?.enabled ? (
          <div className="space-y-3 pt-1">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t('providerSettings.form.codingPlan.baseUrl')}
              </label>
              <Input
                placeholder={t('providerSettings.form.codingPlan.baseUrlPlaceholder')}
                value={formData.codingPlan?.baseUrl || ''}
                onChange={(e) =>
                  setFormData(prev => ({ ...prev, codingPlan: { ...(prev.codingPlan ?? { enabled: false }), baseUrl: e.target.value } }))
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t('providerSettings.form.codingPlan.apiKey')}
              </label>
              <Input
                type="password"
                placeholder={hasCodingPlanKey
                  ? t('providerSettings.form.apiKeySetPlaceholder')
                  : t('providerSettings.form.codingPlan.apiKeyPlaceholder')}
                value={formData.codingPlan?.apiKey || ''}
                onChange={(e) =>
                  setFormData(prev => ({ ...prev, codingPlan: { ...(prev.codingPlan ?? { enabled: false }), apiKey: e.target.value } }))
                }
              />
              <p className="text-xs text-muted-foreground">
                {t('providerSettings.form.codingPlan.apiKeyHelper')}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/* API Version (Azure OpenAI only) — daemon-backed (app-parity child 1):
          persisted as the provider row's `apiVersion`. */}
      {formData.apiFormat === 'azure-openai' ? <div className="space-y-2">
          <label className="text-sm font-medium">{t('providerSettings.form.apiVersion')}</label>
          <Input
            placeholder={t('providerSettings.form.apiVersionPlaceholder')}
            value={formData.apiVersion || ''}
            onChange={(e) => setFormData(prev => ({ ...prev, apiVersion: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">
            {t('providerSettings.form.apiVersionHelper')}
          </p>
        </div> : null}

      {/* Official Anthropic API (Anthropic format only) — daemon-backed
          (app-parity child 1): persisted as the provider row's `isOfficial`. */}
      {formData.apiFormat === 'anthropic' ? <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium">{t('providerSettings.form.official')}</label>
            <p className="text-xs text-muted-foreground">
              {t('providerSettings.form.officialHelper')}
            </p>
          </div>
          <Switch
            checked={formData.isOfficial ?? false}
            onCheckedChange={(checked) => setFormData(prev => ({ ...prev, isOfficial: checked }))}
          />
        </div> : null}

      {/* Max Concurrency — daemon-backed (app-parity child 1): persisted as the
          provider row's `maxConcurrency` (empty/invalid → undefined = keep). */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('providerSettings.form.maxConcurrency')}</label>
        <Input
          type="number"
          min={1}
          max={100}
          placeholder="5"
          value={formData.maxConcurrency ?? ''}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10);
            setFormData(prev => ({
              ...prev,
              maxConcurrency: Number.isFinite(parsed) ? parsed : undefined,
            }));
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t('providerSettings.form.maxConcurrencyHelper')}
        </p>
      </div>

      {/* Transformer Configuration — daemon-backed (app-parity child 5): the
          provider-level `transformer.use[]` chain persists to the daemon row. A
          MINIMAL checklist over BUILTIN_TRANSFORMERS toggles bare names; the
          daemon now ENFORCES the list — it applies these transformers in the
          request chain after the format transformer (app-parity-2 child 2;
          surfaced by the note below). */}
      {!isAddingNew && (
        <div className="border rounded-lg">
          <button
            type="button"
            className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
            onClick={() => setShowTransformerConfig(!showTransformerConfig)}
          >
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{t('providerSettings.form.transformerConfig')}</span>
              {transformerCount > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                  {transformerCount}
                </span>
              )}
            </div>
            {showTransformerConfig ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {showTransformerConfig ? (
            <div className="p-3 border-t space-y-3">
              <p className="text-xs text-muted-foreground">
                {t('providerSettings.form.transformerConfigDescription')}
              </p>
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {BUILTIN_TRANSFORMERS.map((transformer) => {
                  const checked = selectedTransformerNames.has(transformer.name);
                  return (
                    <label
                      key={transformer.name}
                      className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        onChange={(e) => handleToggleTransformer(transformer.name, e.target.checked)}
                      />
                      <span className="flex-1">
                        <span className="text-sm font-medium">{transformer.name}</span>
                        {transformer.description ? (
                          <span className="block text-xs text-muted-foreground">
                            {transformer.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground italic">
                {t('providerSettings.form.transformerConfigNote')}
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* Enabled — daemon-backed (D8); stays LIVE. */}
      <div className="flex items-center gap-2">
        <Switch
          checked={formData.enabled}
          onCheckedChange={(checked) => setFormData(prev => ({ ...prev, enabled: checked }))}
        />
        <label className="text-sm">{t('providerSettings.form.enabled')}</label>
      </div>

      {/* Actions */}
      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onClick={onCancel}>
          {t('providerSettings.form.buttons.cancel')}
        </Button>
        <Button onClick={onSave}>
          {isEditing
            ? t('providerSettings.form.buttons.submitUpdate')
            : t('providerSettings.form.buttons.submitAdd')}
        </Button>
      </div>
    </div>
  );
}

