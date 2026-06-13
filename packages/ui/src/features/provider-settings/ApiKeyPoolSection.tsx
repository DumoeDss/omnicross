import {
  ChevronDown,
  ChevronRight,
  Key,
  Plus,
  Trash2
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { Switch } from '@/components/ui/switch';
import { useUnbackedTitle } from '@/components/ui/unbacked';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { ApiKeyEntry, ApiKeyEntryInput, KeyHealthMap } from '@shared/llm-config';

import { KeyStatusBadge } from './KeyStatusBadge';

/**
 * Key-pool MUTATIONS (add / delete / toggle / weight) are now daemon-backed
 * (app-parity child 3): the daemon exposes provider-scoped pool-key write
 * endpoints (`POST/PUT/DELETE /providers/:id/keys[/:keyId]` + `…/enabled`), and
 * the adapter's mutation methods issue the real calls. The pool VIEW (masked keys
 * + live health) was already daemon-backed. The submitted plaintext key is never
 * returned to the renderer (the adapter maps only the masked `ApiKeyEntry`).
 */
const POOL_EDIT_UNBACKED = false;

/** Health re-fetch cadence (cheap in-memory read on the backend). */
const HEALTH_POLL_MS = 3000;
/** Countdown tick cadence for smooth mm:ss between health fetches. */
const TICK_MS = 1000;

interface ApiKeyPoolSectionProps {
  providerId: string;
}

export function ApiKeyPoolSection({ providerId }: ApiKeyPoolSectionProps) {
  const t = useTranslation();
  const unbackedTitle = useUnbackedTitle();
  const [expanded, setExpanded] = useState(false);
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  // Live cooldown health (separate from the key LIST — refreshed on a poll).
  const [health, setHealth] = useState<KeyHealthMap>({});
  // 1s tick to drive a smooth mm:ss countdown between health fetches.
  const [now, setNow] = useState(() => Date.now());

  // New key form state
  const [newLabel, setNewLabel] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newWeight, setNewWeight] = useState(1);

  const loadKeys = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    try {
      const result = await agent.llmConfig.getApiKeys(providerId);
      setKeys(result);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    if (expanded) {
      void loadKeys();
    }
  }, [expanded, loadKeys]);

  // Poll live cooldown health while the section is expanded. The key LIST is
  // NOT re-fetched here — only the (cheap, in-memory) health map. Guards against
  // state updates after collapse/unmount via the `cancelled` flag.
  useEffect(() => {
    if (!expanded || !providerId) {
      setHealth({});
      return;
    }
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const result = await agent.llmConfig.getKeyHealth(providerId);
        if (!cancelled) setHealth(result);
      } catch {
        if (!cancelled) setHealth({});
      }
    };
    void fetchHealth();
    const healthTimer = window.setInterval(() => void fetchHealth(), HEALTH_POLL_MS);
    // Separate 1s tick keeps the mm:ss countdown smooth between health fetches.
    const tickTimer = window.setInterval(() => {
      if (!cancelled) setNow(Date.now());
    }, TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(healthTimer);
      window.clearInterval(tickTimer);
    };
  }, [expanded, providerId]);

  const handleAdd = async () => {
    if (!newApiKey.trim()) return;
    const input: ApiKeyEntryInput = {
      providerId,
      label: newLabel.trim() || `Key #${keys.length + 1}`,
      apiKey: newApiKey.trim(),
      weight: newWeight,
    };
    const result = await agent.llmConfig.addApiKey(input);
    if (result.success) {
      setShowAddForm(false);
      setNewLabel('');
      setNewApiKey('');
      setNewWeight(1);
      void loadKeys();
    }
  };

  const handleDelete = async (id: string) => {
    const result = await agent.llmConfig.deleteApiKey(providerId, id);
    if (result.success) {
      void loadKeys();
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await agent.llmConfig.toggleApiKey(providerId, id, enabled);
    void loadKeys();
  };

  const handleWeightChange = async (id: string, weight: number) => {
    const clamped = Math.max(1, Math.min(100, weight));
    await agent.llmConfig.updateApiKey(providerId, id, { weight: clamped });
    void loadKeys();
  };

  /**
   * provider-storage-secrets: the full key is NEVER returned to the renderer.
   * Render an env `$VAR` reference verbatim (not a secret), otherwise the
   * non-reversible `keyHint` (e.g. `••••ab12`) when present, else a generic
   * masked/"key is set" marker.
   */
  const renderKeyDisplay = (entry: ApiKeyEntry): string => {
    if (entry.apiKey && entry.apiKey.startsWith('$')) return entry.apiKey;
    if (entry.keyHint) return entry.keyHint;
    return entry.hasKey ? '••••••••' : t('providerSettings.apiKeyPool.noKey');
  };

  return (
    <div className="border rounded-lg">
      <button
        type="button"
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('providerSettings.apiKeyPool.title')}</span>
          {keys.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
              {keys.length}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {expanded ? <div className="border-t p-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('providerSettings.apiKeyPool.description')}
          </p>

          {loading ? (
            <div className="text-xs text-muted-foreground">
              {t('providerSettings.loading')}
            </div>
          ) : (
            <>
              {/* Key list */}
              {keys.length > 0 && (
                <div className="space-y-2">
                  {keys.map(entry => (
                    <div
                      key={entry.id}
                      className="flex items-center gap-2 p-2 rounded border bg-surface-1/70 wallpaper-blur"
                    >
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">
                            {entry.label || t('providerSettings.apiKeyPool.defaultLabel')}
                          </span>
                          <KeyStatusBadge
                            entry={entry}
                            health={health[entry.id]}
                            now={now}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <code className="text-xs text-muted-foreground">
                            {renderKeyDisplay(entry)}
                          </code>
                        </div>
                      </div>

                      {/* Weight control */}
                      <div className="flex items-center gap-1 shrink-0">
                        <label className="text-[10px] text-muted-foreground">
                          {t('providerSettings.apiKeyPool.weight')}
                        </label>
                        <Input
                          type="number"
                          min={1}
                          max={100}
                          value={entry.weight}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            if (!isNaN(val)) {
                              void handleWeightChange(entry.id, val);
                            }
                          }}
                          disabled={POOL_EDIT_UNBACKED}
                          title={POOL_EDIT_UNBACKED ? unbackedTitle : undefined}
                          className="w-14 h-7 text-xs text-center"
                        />
                      </div>

                      {/* Toggle — backed by POST /providers/:id/keys/:keyId/enabled */}
                      <Switch
                        checked={entry.enabled}
                        onCheckedChange={(checked) => void handleToggle(entry.id, checked)}
                        disabled={POOL_EDIT_UNBACKED}
                        title={POOL_EDIT_UNBACKED ? unbackedTitle : undefined}
                      />

                      {/* Delete — backed by DELETE /providers/:id/keys/:keyId */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => void handleDelete(entry.id)}
                        disabled={POOL_EDIT_UNBACKED}
                        title={POOL_EDIT_UNBACKED ? unbackedTitle : undefined}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add key form */}
              {showAddForm ? (
                <div className="space-y-2 p-2 rounded border bg-surface-1/30 wallpaper-blur">
                  <Input
                    placeholder={t('providerSettings.apiKeyPool.labelPlaceholder')}
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                  />
                  <RevealableInput
                    placeholder={t('providerSettings.form.apiKeyPlaceholder')}
                    value={newApiKey}
                    onChange={(e) => setNewApiKey(e.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground">
                      {t('providerSettings.apiKeyPool.weight')}
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={newWeight}
                      onChange={(e) => setNewWeight(parseInt(e.target.value, 10) || 1)}
                      className="w-20"
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setShowAddForm(false);
                        setNewLabel('');
                        setNewApiKey('');
                        setNewWeight(1);
                      }}
                    >
                      {t('providerSettings.form.buttons.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void handleAdd()}
                      disabled={!newApiKey.trim()}
                    >
                      {t('providerSettings.apiKeyPool.add')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setShowAddForm(true)}
                  disabled={POOL_EDIT_UNBACKED}
                  title={POOL_EDIT_UNBACKED ? unbackedTitle : undefined}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('providerSettings.apiKeyPool.addKey')}
                </Button>
              )}
            </>
          )}
        </div> : null}
    </div>
  );
}
