import { KeyRound, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

import { EditModelDialog } from './EditModelDialog';
import { useProviderSettings } from './hooks/useProviderSettings';
import { ManageModelsDialog } from './ManageModelsDialog';
import { ManualModelDialog } from './ManualModelDialog';
import { ProviderDetails } from './ProviderDetails';
import { ProviderForm } from './ProviderForm';
import { ProviderList } from './ProviderList';
import { ProviderTemplatePicker } from './ProviderTemplatePicker';

export interface ProviderSettingsProps {
  /** Hide the provider list so an owning workbench can supply resource navigation. */
  embedded?: boolean;
  selectedProviderId?: string | null;
  onSelectedProviderChange?: (providerId: string | null) => void;
  /** Open directly in the provider creation form. */
  mode?: 'manage' | 'create';
  /** Fires after a provider is CREATED (not edited) and the list has refreshed —
      a modal create flow closes itself here instead of dropping into the new
      provider's config page. */
  onProviderCreated?: (providerId: string) => void;
  /** Ask the owner to tear this view down (e.g. close the hosting dialog) when
      the user cancels OUT of the create flow at the template picker. */
  onRequestClose?: () => void;
  /**
   * Restrict the view to one catalog category — `'other'` backs the dedicated
   * 其他/Other page (list, selection, and the add flow all filter together;
   * see useProviderSettings).
   */
  categoryFilter?: 'other';
}

export function ProviderSettings({
  embedded = false,
  selectedProviderId: controlledProviderId,
  onSelectedProviderChange,
  mode = 'manage',
  onProviderCreated,
  onRequestClose,
  categoryFilter,
}: ProviderSettingsProps = {}) {
  const t = useTranslation();
  // Re-entry banner dismiss state (per-view, resets on remount) — non-blocking.
  const [reentryDismissed, setReentryDismissed] = useState(false);
  const {
    providers,
    providersLoading,
    presets,
    presetsLoading,
    addedPresetIds,
    searchTerm,
    setSearchTerm,
    selectedProviderId,
    selectedProvider,
    isEditing,
    isAddingNew,
    formData,
    setFormData,
    formError,
    showTemplates,
    showApiKey,
    setShowApiKey,
    modelSearch,
    setModelSearch,
    collapsedGroups,
    toggleGroupCollapse,
    showManageModels,
    setShowManageModels,
    showAddModelDialog,
    setShowAddModelDialog,
    modelDiscoveryLoading,
    modelDiscoveryError,
    catalogSearchTerm,
    setCatalogSearchTerm,
    catalogFilter,
    setCatalogFilter,
    catalogCollapsedGroups,
    toggleCatalogGroup,
    newModelEntry,
    setNewModelEntry,
    modelStatus,
    editingModel,
    setEditingModel,
    showEditModelDialog,
    setShowEditModelDialog,
    editModelEntry,
    setEditModelEntry,
    inlineName,
    setInlineName,
    inlineModelsEndpoint,
    setInlineModelsEndpoint,
    inlineApiKey,
    setInlineApiKey,
    inlineApiUrl,
    setInlineApiUrl,
    inlineMaxConcurrency,
    setInlineMaxConcurrency,
    visibleModelGroups,
    normalizedModelGroups,
    defaultGroupId,
    discoveryResult,
    filteredDiscoveryModels,
    catalogGroups,
    existingModelIds,
    handleSelectProvider,
    handleAddProvider,
    handleReorderProviders,
    handleSelectApiMode,
    handleUseTemplate: _handleUseTemplate,
    handleUsePresetTemplate,
    handleStartCustomProvider,
    handleBackToTemplates,
    handleSaveProvider,
    handleCancelEdit,
    handleInlineUpdate,
    handleToggleProvider,
    handleToggleOfficial,
    handleDeleteProvider,
    handleResetProvider,
    revealApiKey,
    missingKeyCount,
    handleRemoveModel,
    handleAddModelEntry,
    handleAddDiscoveredModel,
    handleApplyModelEdit,
    handleApplyEditModelDialog,
    handleToggleModelEnabled,
    handleSetModelsEnabled,
    loadModelDiscovery,
    onShowEditModelDialog
  } = useProviderSettings({
    selectedProviderId: controlledProviderId,
    onSelectedProviderChange,
    onProviderCreated,
    categoryFilter,
  });

  const initializedMode = useRef(false);
  useEffect(() => {
    if (mode !== 'create' || initializedMode.current) return;
    initializedMode.current = true;
    handleAddProvider();
  }, [handleAddProvider, mode]);

  const showReentryBanner =
    missingKeyCount > 0 && !reentryDismissed && !categoryFilter;
  // In a category-filtered view the add flow must only offer that category's
  // presets — a bare chat API type is never what the 其他 page is for. The
  // REVERSE also holds: category-'other' presets (Jev / LogJev — decision
  // engines, not chat backends) are ONLY addable from the 其他 page, so the
  // unfiltered chat add flow (模型服务 / provider settings) never offers them.
  const pickerPresets = categoryFilter === 'other'
    ? presets.filter((preset) => preset.category === 'other')
    : presets.filter((preset) => preset.category !== 'other');

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Secret re-entry banner (provider-storage-overlay): non-blocking,
            dismissible — shown when ≥1 enabled provider has no stored key
            (e.g. a new machine / restored profile where machine-local secrets
            did not travel). Affected rows are identifiable via `hasKey`. */}
        {showReentryBanner && !embedded ? (
          <div
            className="flex items-center gap-3 px-4 py-2.5 border-b border-border/50 bg-surface-2/60 text-sm"
            role="status"
          >
            <KeyRound className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="flex-1 min-w-0 text-foreground">
              {t('providerSettings.reentryBanner.message', { count: missingKeyCount })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => setReentryDismissed(true)}
              title={t('common.dismiss')}
              aria-label={t('common.dismiss')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : null}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Panel - Provider List */}
        {!embedded ? (
          <ProviderList
            providers={providers}
            loading={providersLoading}
            selectedProviderId={selectedProviderId}
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            onSelectProvider={handleSelectProvider}
            onAddProvider={handleAddProvider}
            onReorderProviders={handleReorderProviders}
            isAddingNew={isAddingNew}
          />
        ) : null}

        {/* Right Panel - Details/Form */}
        <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface-1/60 wallpaper-blur">
          {/* Content - Scrollable */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {isAddingNew && showTemplates ? (
              /* Step 1 of ADD: pick a built-in template, or start from a bare
                 API type. Nothing is written until the form is saved. */
              <ProviderTemplatePicker
                presets={pickerPresets}
                loading={presetsLoading}
                addedPresetIds={addedPresetIds}
                otherOnly={categoryFilter === 'other'}
                onUseTemplate={handleUsePresetTemplate}
                onStartCustom={handleStartCustomProvider}
                /* The picker's cancel LEAVES the add flow entirely. In a hosting
                   dialog that means closing it — staying open would drop the
                   user onto an auto-selected existing provider's config page
                   inside an "add provider" modal. */
                onCancel={onRequestClose ?? handleCancelEdit}
              />
            ) : isAddingNew ? (
              /* Cancel INSIDE the add flow (step 2 form) steps back to the
                 template picker — abruptly dropping out to a random existing
                 provider read as losing the form. The PICKER's cancel is the
                 one that leaves the flow entirely. */
              <ProviderForm
                isEditing={false}
                isAddingNew
                formData={formData}
                setFormData={setFormData}
                formError={formError}
                showApiKey={showApiKey}
                setShowApiKey={setShowApiKey}
                onBackToTemplates={handleBackToTemplates}
                onCancel={handleBackToTemplates}
                onSave={handleSaveProvider}
              />
            ) : isEditing ? (
              <ProviderForm
                isEditing={isEditing}
                isAddingNew={isAddingNew}
                formData={formData}
                setFormData={setFormData}
                formError={formError}
                showApiKey={showApiKey}
                setShowApiKey={setShowApiKey}
                hasKey={selectedProvider?.hasKey}
                hasCodingPlanKey={Boolean(selectedProvider?.codingPlan?.hasApiKey)}
                onCancel={handleCancelEdit}
                onSave={handleSaveProvider}
              />
            ) : (
              <ProviderDetails
                selectedProvider={selectedProvider}
                visibleModelGroups={visibleModelGroups}
                inlineName={inlineName}
                setInlineName={setInlineName}
                inlineApiKey={inlineApiKey}
                setInlineApiKey={setInlineApiKey}
                inlineApiUrl={inlineApiUrl}
                setInlineApiUrl={setInlineApiUrl}
                inlineModelsEndpoint={inlineModelsEndpoint}
                setInlineModelsEndpoint={setInlineModelsEndpoint}
                inlineMaxConcurrency={inlineMaxConcurrency}
                setInlineMaxConcurrency={setInlineMaxConcurrency}
                showApiKey={showApiKey}
                setShowApiKey={setShowApiKey}
                modelStatus={modelStatus}
                modelSearch={modelSearch}
                setModelSearch={setModelSearch}
                collapsedGroups={collapsedGroups}
                toggleGroupCollapse={toggleGroupCollapse}
                editingModel={editingModel}
                setEditingModel={setEditingModel}
                onInlineUpdate={handleInlineUpdate}
                onRevealApiKey={revealApiKey}
                // Embedded workbench (upstreams provider detail) renders its own
                // UpstreamMappingSection above this view — skip the duplicate.
                hideMappingSection={embedded}
                onSelectApiMode={handleSelectApiMode}
                onToggleProvider={handleToggleProvider}
                onToggleOfficial={handleToggleOfficial}
                onDeleteProvider={handleDeleteProvider}
                onResetProvider={handleResetProvider}
                onShowManageModels={() => setShowManageModels(true)}
                onShowAddModelDialog={() => setShowAddModelDialog(true)}
                onApplyModelEdit={handleApplyModelEdit}
                onToggleModelEnabled={handleToggleModelEnabled}
                onSetModelsEnabled={handleSetModelsEnabled}
                onRemoveModel={handleRemoveModel}
                onShowEditModelDialog={onShowEditModelDialog}
              />
            )}
          </div>
        </div>
      </div>

      </div>

      <ManageModelsDialog
        selectedProvider={selectedProvider}
        showManageModels={showManageModels}
        setShowManageModels={setShowManageModels}
        discoveryResult={discoveryResult}
        filteredDiscoveryModels={filteredDiscoveryModels}
        catalogGroups={catalogGroups}
        catalogSearchTerm={catalogSearchTerm}
        setCatalogSearchTerm={setCatalogSearchTerm}
        catalogFilter={catalogFilter}
        setCatalogFilter={setCatalogFilter}
        catalogCollapsedGroups={catalogCollapsedGroups}
        toggleCatalogGroup={toggleCatalogGroup}
        modelDiscoveryLoading={modelDiscoveryLoading}
        modelDiscoveryError={modelDiscoveryError}
        existingModelIds={existingModelIds}
        onLoadModelDiscovery={loadModelDiscovery}
        onAddDiscoveredModel={handleAddDiscoveredModel}
      />

      <ManualModelDialog
        selectedProvider={selectedProvider}
        showAddModelDialog={showAddModelDialog}
        setShowAddModelDialog={setShowAddModelDialog}
        newModelEntry={newModelEntry}
        setNewModelEntry={setNewModelEntry}
        normalizedModelGroups={normalizedModelGroups}
        defaultGroupId={defaultGroupId}
        onAddModelEntry={handleAddModelEntry}
      />

      <EditModelDialog
        selectedProvider={selectedProvider}
        showEditModelDialog={showEditModelDialog}
        setShowEditModelDialog={setShowEditModelDialog}
        editModelEntry={editModelEntry}
        setEditModelEntry={setEditModelEntry}
        normalizedModelGroups={normalizedModelGroups}
        onApplyEditModelDialog={handleApplyEditModelDialog}
        setEditingModel={setEditingModel}
      />
    </>
  );
}

export default ProviderSettings;

