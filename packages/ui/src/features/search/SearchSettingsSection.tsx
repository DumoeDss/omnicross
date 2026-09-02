/**
 * SearchSettingsSection — the standalone Search page's settings body
 * (search-settings-tab, design D2/D3; moved from api-service/SearchSection).
 *
 * Edits the masked `server.search` segment end-to-end: the three per-frontend
 * modes, the five keyed provider cards (write-only secrets — blank keeps the
 * stored value, `null` clears the optional ones, entry removal clears required
 * ones), the default policy, and the egress allowlist. Save PUTs the WHOLE
 * segment (layer-replaced; the adapter rebuilds from the last loaded masked
 * config and the daemon preserves omitted/blanked stored secrets).
 *
 * THE KEY FIX (owner feedback 2026-09-02, design D3): the per-provider entry
 * fields (key, host, Basic-auth pair) render in EVERY state — `configured`
 * drives only the badge, the missing-field hint, and the test panel's
 * availability, NEVER input visibility. The shipped section rendered the
 * fields only after a provider was already configured, so a fresh install had
 * no reachable inputs at all (chicken-and-egg — the owner could not configure
 * a key). The empty-config typing test is the regression pin.
 *
 * Honesty rules baked into the layout:
 * - unconfigured is an EMPTY STATE naming the missing field, never an error;
 * - the keyless HTTP pair is always-available — no config fields, no fake
 *   enable toggle (configure-state IS enablement);
 * - the codex mode applies immediately, everything else needs a daemon restart
 *   — labeled statically, plus a pending-restart banner when the persisted
 *   provider set diverges from the running runtime;
 * - the per-provider test panel runs the OPERATOR's query through the daemon's
 *   interactive endpoint and renders the results as untrusted text — a
 *   blocked/degraded outcome is an honest observation about the network, not
 *   a malfunction.
 */

import { Globe, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { Select, type SelectOption } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';
import type {
  SearchDiagnosticsSnapshot,
  SearchFrontendMode,
  SearchFrontendModes,
  SearchFrontendName,
  SearchQueryOutcome,
  SearchServerConfig,
} from '@/daemon/types';

import { SearchTestPanel } from './SearchTestPanel';
import {
  createSearchSettingsDraft,
  draftProviderConfigured,
  isUsableHostString,
  pendingRestartProviderIds,
  SEARCH_PROVIDER_CATALOG,
  searchDraftToPayload,
  type SearchProviderCatalogEntry,
  type SearchProviderDraft,
  type SearchSettingsDraft,
} from './searchSettingsModel';

const MODE_VALUES: SearchFrontendMode[] = ['native', 'managed', 'off'];
const FRONTENDS: SearchFrontendName[] = ['codex', 'responses', 'anthropic'];

interface SearchSettingsSectionProps {
  /** The masked admin read; undefined only on a pre-Phase-1 daemon. */
  config: SearchServerConfig | undefined;
  /** Diagnostics snapshot; null when the daemon predates the endpoint. */
  diagnostics: SearchDiagnosticsSnapshot | null;
  busy: boolean;
  onUpdate: (search: SearchServerConfig) => Promise<void>;
  onQuery: (providerId: string, query: string) => Promise<SearchQueryOutcome>;
}

function statusVariant(status: string): 'success' | 'destructive' | 'secondary' | 'outline' {
  switch (status) {
    case 'healthy':
    case 'ready':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'degraded':
    case 'blocked':
      return 'outline';
    default:
      return 'secondary';
  }
}

export function SearchSettingsSection({ config, diagnostics, busy, onUpdate, onQuery }: SearchSettingsSectionProps) {
  const t = useTranslation();
  const [draft, setDraft] = React.useState<SearchSettingsDraft>(() => createSearchSettingsDraft(config));
  const [egressInput, setEgressInput] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  // The search segment the current draft was seeded from (review round 1, M1:
  // the stale-refresh guard's base identity).
  const seedBaseRef = React.useRef<SearchServerConfig | undefined>(config);

  // Re-seed the draft only when the SEARCH SEGMENT itself changed. A sibling
  // save re-fetches the whole server config after any write, producing a new
  // `config` object with an unchanged search segment — re-seeding then would
  // silently discard unsaved edits. A change that DOES reach the segment
  // re-seeds: our own save (the daemon normalizes the PUT into a new segment)
  // and any external search edit alike. Content comparison is stable because
  // the daemon rebuilds the segment in a fixed shape on every read.
  React.useEffect(() => {
    if (JSON.stringify(config) === JSON.stringify(seedBaseRef.current)) return;
    seedBaseRef.current = config;
    setDraft(createSearchSettingsDraft(config));
  }, [config]);

  const patchProvider = (id: string, patch: Partial<SearchProviderDraft>): void => {
    setDraft((d) => ({ ...d, providers: { ...d.providers, [id]: { ...d.providers[id]!, ...patch } } }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onUpdate(searchDraftToPayload(draft));
    } finally {
      setSaving(false);
    }
  };

  const rowFor = (providerId: string) => diagnostics?.rows.find((row) => row.providerId === providerId);
  const pendingRestart = pendingRestartProviderIds(config, diagnostics);
  const disabled = busy || saving;

  if (!config) {
    return (
      <section className="rounded-xl border border-dashed border-border/70 p-4">
        <p className="text-xs text-muted-foreground">{t('search.unsupportedDaemon')}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/50 p-4 space-y-4">
      {/* The page header carries the section's title/description — no double
          heading on the standalone page. */}
      {pendingRestart.length > 0 ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
          <RefreshCw className="mr-1.5 inline h-3.5 w-3.5" aria-hidden="true" />
          {t('search.restartBanner', {
            providers: pendingRestart.map((id) => SEARCH_PROVIDER_CATALOG.find((e) => e.id === id)?.name ?? id).join(', '),
          })}
        </p>
      ) : null}

      <ModesEditor draft={draft} setDraft={setDraft} disabled={disabled} />

      <div className="space-y-3">
        <div className="flex items-center gap-2 pt-1">
          <Globe className="h-4 w-4 text-primary" aria-hidden="true" />
          <h4 className="text-sm font-semibold text-foreground">{t('search.providers.title')}</h4>
          <span className="text-[11px] text-muted-foreground">{t('search.restartHint')}</span>
        </div>
        {diagnostics === null ? (
          <p className="rounded-md border border-border/60 bg-surface-0/60 px-3 py-2 text-xs text-muted-foreground">
            {t('search.diagnosticsUnsupported')}
          </p>
        ) : null}
        {SEARCH_PROVIDER_CATALOG.map((entry) => (
          <ProviderCard
            key={entry.id}
            entry={entry}
            draft={draft.providers[entry.id]}
            diagnosticsStatus={rowFor(entry.id)?.status}
            disabled={disabled}
            onPatch={(patch) => patchProvider(entry.id, patch)}
            onQuery={onQuery}
          />
        ))}
      </div>

      <PolicyEditor
        draft={draft}
        setDraft={setDraft}
        disabled={disabled}
      />

      <EgressEditor
        draft={draft}
        setDraft={setDraft}
        egressInput={egressInput}
        setEgressInput={setEgressInput}
        disabled={disabled}
      />

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" disabled={disabled} onClick={() => void save()}>
          {t('search.action.save')}
        </Button>
      </div>
    </section>
  );
}

// ── Modes ─────────────────────────────────────────────────────────────────────

function ModesEditor({
  draft,
  setDraft,
  disabled,
}: {
  draft: SearchSettingsDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchSettingsDraft>>;
  disabled: boolean;
}) {
  const t = useTranslation();
  const setMode = (frontend: SearchFrontendName, mode: SearchFrontendMode): void => {
    setDraft((d) => ({ ...d, modes: { ...d.modes, [frontend]: mode } as SearchFrontendModes }));
  };
  const options: SelectOption[] = MODE_VALUES.map((mode) => ({
    value: mode,
    label: t(`search.mode.${mode}`),
  }));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-foreground">{t('search.modes.title')}</h4>
        <span className="text-[11px] text-muted-foreground">{t('search.modes.description')}</span>
      </div>
      {FRONTENDS.map((frontend) => (
        <SettingRow
          key={frontend}
          label={t(`search.modes.${frontend}`)}
          description={t(
            frontend === 'codex'
              ? 'search.immediateHint'
              : 'search.restartHint',
          )}
        >
          <Select
            value={draft.modes[frontend]}
            onChange={(mode) => setMode(frontend, mode as SearchFrontendMode)}
            options={options}
            disabled={disabled}
            size="sm"
            className="w-32"
          />
        </SettingRow>
      ))}
    </div>
  );
}

// ── Provider card ─────────────────────────────────────────────────────────────

function ProviderCard({
  entry,
  draft,
  diagnosticsStatus,
  disabled,
  onPatch,
  onQuery,
}: {
  entry: SearchProviderCatalogEntry;
  draft: SearchProviderDraft | undefined;
  diagnosticsStatus: string | undefined;
  disabled: boolean;
  onPatch: (patch: Partial<SearchProviderDraft>) => void;
  onQuery: (providerId: string, query: string) => Promise<SearchQueryOutcome>;
}) {
  const t = useTranslation();

  // The static keyless pair: always available, nothing to edit, panel always
  // live.
  if (entry.kind === 'http') {
    return (
      <div className="rounded-lg border border-border/60 bg-surface-0/60 p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{entry.name}</span>
            <Badge variant="outline">{entry.kind}</Badge>
            <Badge variant="success">{t('search.status.ready')}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={entry.website}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              {entry.website.replace(/^https?:\/\//, '')}
            </a>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('search.keyless.description')}</p>
        <SearchTestPanel
          providerId={entry.id}
          providerName={entry.name}
          onQuery={onQuery}
          saveFirst={false}
          disabled={disabled}
        />
      </div>
    );
  }

  const provider = draft!;
  const configured = draftProviderConfigured(entry, provider);
  const status = configured ? (diagnosticsStatus ?? 'ready') : 'unconfigured';
  const statusKey = `search.status.${status}`;
  // The unconfigured state names the missing FIELD (the doctor's reason carries
  // it when diagnostics exist; the catalog knows it otherwise).
  const missingReason = !configured
    ? t(`search.unconfiguredReason.${entry.i18nSlug}`)
    : undefined;

  // THE KEY FIX (D3): the entry fields render in EVERY state (removed swaps to
  // the removal-pending note). `configured` drives the badge and the hint
  // above the fields — never their existence.
  return (
    <div className="rounded-lg border border-border/60 bg-surface-0/60 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{entry.name}</span>
          <Badge variant="outline">{entry.kind}</Badge>
          <Badge variant={statusVariant(status)} title={missingReason}>
            {t(statusKey)}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={entry.website}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {entry.website.replace(/^https?:\/\//, '')}
          </a>
          {provider.persistedConfigured ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onPatch({ removed: !provider.removed })}
              aria-label={t('search.action.remove')}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>

      {provider.removed ? (
        <p className="text-xs text-warning">
          {t('search.removedPending')}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t(`search.providers.${entry.i18nSlug}.description`)}
            {!configured && missingReason ? (
              <>
                {' '}
                <span className="text-warning">{missingReason}</span>
              </>
            ) : null}
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            {entry.requiresApiKey || entry.keyOptional ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  <KeyRound className="mr-1 inline h-3 w-3" aria-hidden="true" />
                  {t('search.field.apiKey')}
                  {provider.persistedConfigured ? (
                    provider.clearApiKey
                      ? <span className="ml-1 text-warning">{t('search.action.clearKeyPending')}</span>
                      : provider.apiKeyInput.length === 0
                        ? <span className="ml-1 font-normal">{t('search.field.apiKeyConfigured')}</span>
                        : null
                  ) : null}
                </p>
                <RevealableInput
                  value={provider.apiKeyInput}
                  disabled={disabled}
                  placeholder={
                    provider.persistedConfigured
                      ? t('search.field.apiKeyPlaceholder')
                      : t('search.field.apiKeyNew')
                  }
                  onChange={(e) => onPatch({ apiKeyInput: e.target.value, clearApiKey: false })}
                  aria-label={t('search.field.apiKey')}
                />
                {entry.keyOptional && provider.persistedConfigured && provider.apiKeyInput.length === 0 ? (
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                    disabled={disabled}
                    onClick={() => onPatch({ clearApiKey: !provider.clearApiKey })}
                  >
                    {provider.clearApiKey ? t('search.action.undoClear') : t('search.action.clearKey')}
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('search.field.apiHost')}</p>
              <Input
                value={provider.apiHost}
                disabled={disabled}
                placeholder={
                  entry.requiresHost
                    ? t('search.field.apiHostRequired')
                    : t('search.field.apiHostPlaceholder')
                }
                onChange={(e) => onPatch({ apiHost: e.target.value })}
                aria-label={t('search.field.apiHost')}
              />
            </div>

            {entry.usesBasicAuth ? (
              <>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t('search.field.basicAuthUsername')}</p>
                  <Input
                    value={provider.basicAuthUsername}
                    disabled={disabled}
                    placeholder="user"
                    onChange={(e) => onPatch({ basicAuthUsername: e.target.value })}
                    aria-label={t('search.field.basicAuthUsername')}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('search.field.basicAuthPassword')}
                    {provider.persistedConfigured && !provider.clearBasicAuthPassword && provider.basicAuthPasswordInput.length === 0 ? (
                      <span className="ml-1 font-normal">{t('search.field.basicAuthPasswordConfigured')}</span>
                    ) : null}
                  </p>
                  <RevealableInput
                    value={provider.basicAuthPasswordInput}
                    disabled={disabled}
                    placeholder={t('search.field.basicAuthPasswordPlaceholder')}
                    onChange={(e) => onPatch({ basicAuthPasswordInput: e.target.value, clearBasicAuthPassword: false })}
                    aria-label={t('search.field.basicAuthPassword')}
                  />
                  {provider.persistedConfigured && provider.basicAuthPasswordInput.length === 0 ? (
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                      disabled={disabled}
                      onClick={() => onPatch({ clearBasicAuthPassword: !provider.clearBasicAuthPassword })}
                    >
                      {provider.clearBasicAuthPassword
                        ? t('search.action.undoClear')
                        : t('search.action.clearPassword')}
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>

          {testPanelFor({ entry, provider, configured, onQuery, disabled })}
        </>
      )}
    </div>
  );
}

/**
 * Test-panel availability (D3): keyless pair → always (rendered by the http
 * branch); keyed providers → the panel exists when the PERSISTED config names
 * the provider (the daemon probes persisted config). A typed-but-unsaved draft
 * shows the panel with a "save first" hint instead of a silently-failing
 * probe; a provider with neither persisted entry nor draft input shows no
 * affordance that cannot run (the unconfigured badge + hint already say why).
 */
function testPanelFor({
  entry,
  provider,
  configured,
  onQuery,
  disabled,
}: {
  entry: SearchProviderCatalogEntry;
  provider: SearchProviderDraft;
  configured: boolean;
  onQuery: (providerId: string, query: string) => Promise<SearchQueryOutcome>;
  disabled: boolean;
}): React.ReactNode {
  if (provider.persistedConfigured) {
    return (
      <SearchTestPanel
        providerId={entry.id}
        providerName={entry.name}
        onQuery={onQuery}
        saveFirst={false}
        disabled={disabled}
      />
    );
  }
  if (configured) {
    // Draft key/host typed but not saved: the probe would read the OLD (absent)
    // persisted config — say so instead of failing silently.
    return (
      <SearchTestPanel
        providerId={entry.id}
        providerName={entry.name}
        onQuery={onQuery}
        saveFirst
        disabled={disabled}
      />
    );
  }
  return null;
}

// ── Policy ────────────────────────────────────────────────────────────────────

function PolicyEditor({
  draft,
  setDraft,
  disabled,
}: {
  draft: SearchSettingsDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchSettingsDraft>>;
  disabled: boolean;
}) {
  const t = useTranslation();
  const preferredOptions: SelectOption[] = [
    { value: '', label: t('search.policy.preferredNone') },
    ...SEARCH_PROVIDER_CATALOG.filter((entry) => entry.kind === 'api').map((entry) => ({
      value: entry.id,
      label: entry.name,
    })),
  ];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pt-1">
        <h4 className="text-sm font-semibold text-foreground">{t('search.policy.title')}</h4>
        <span className="text-[11px] text-muted-foreground">{t('search.restartHint')}</span>
      </div>
      <SettingRow label={t('search.policy.preferred')} description={t('search.policy.preferredDescription')}>
        <Select
          value={draft.policy.preferred}
          onChange={(preferred) => setDraft((d) => ({ ...d, policy: { ...d.policy, preferred } }))}
          options={preferredOptions}
          disabled={disabled}
          size="sm"
          className="w-40"
        />
      </SettingRow>
      <SettingRow label={t('search.policy.allowed')} description={t('search.policy.allowedDescription')}>
        <div className="flex max-w-md flex-wrap justify-end gap-1.5">
          {SEARCH_PROVIDER_CATALOG.filter((entry) => entry.kind === 'api').map((entry) => {
            const on = draft.policy.allowed.includes(entry.id);
            return (
              <button
                key={entry.id}
                type="button"
                disabled={disabled}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    policy: {
                      ...d.policy,
                      allowed: on
                        ? d.policy.allowed.filter((id) => id !== entry.id)
                        : [...d.policy.allowed, entry.id],
                    },
                  }))
                }
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  on ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border/60 text-muted-foreground'
                }`}
              >
                {entry.name}
              </button>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow
        label={t('search.policy.fallbackEnabled')}
        description={t('search.policy.fallbackDescription')}
      >
        <Switch
          checked={draft.policy.fallbackEnabled}
          disabled={disabled}
          onCheckedChange={(fallbackEnabled) =>
            setDraft((d) => ({ ...d, policy: { ...d.policy, fallbackEnabled } }))
          }
          aria-label={t('search.policy.fallbackEnabled')}
        />
      </SettingRow>
      <SettingRow
        label={t('search.policy.maxAttempts')}
        description={t('search.policy.maxAttemptsDescription')}
      >
        <Input
          value={draft.policy.maxAttempts}
          disabled={disabled}
          inputMode="numeric"
          className="w-20 text-right"
          placeholder="—"
          onChange={(e) => {
            const sanitized = e.target.value.replace(/[^0-9]/g, '');
            setDraft((d) => ({ ...d, policy: { ...d.policy, maxAttempts: sanitized } }));
          }}
          aria-label={t('search.policy.maxAttempts')}
        />
      </SettingRow>
    </div>
  );
}

// ── Egress allowlist ──────────────────────────────────────────────────────────

function EgressEditor({
  draft,
  setDraft,
  egressInput,
  setEgressInput,
  disabled,
}: {
  draft: SearchSettingsDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchSettingsDraft>>;
  egressInput: string;
  setEgressInput: React.Dispatch<React.SetStateAction<string>>;
  disabled: boolean;
}) {
  const t = useTranslation();
  const canAdd = isUsableHostString(egressInput) && !draft.allowedPrivateHosts.includes(egressInput.trim());
  const add = (): void => {
    if (!canAdd) return;
    setDraft((d) => ({ ...d, allowedPrivateHosts: [...d.allowedPrivateHosts, egressInput.trim()] }));
    setEgressInput('');
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pt-1">
        <h4 className="text-sm font-semibold text-foreground">{t('search.egress.title')}</h4>
        <span className="text-[11px] text-muted-foreground">{t('search.restartHint')}</span>
      </div>
      <p className="text-xs text-muted-foreground">{t('search.egress.description')}</p>
      {draft.allowedPrivateHosts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('search.egress.empty')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {draft.allowedPrivateHosts.map((host) => (
            <span
              key={host}
              className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs text-foreground"
            >
              {host}
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                disabled={disabled}
                aria-label={t('search.egress.remove')}
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    allowedPrivateHosts: d.allowedPrivateHosts.filter((h) => h !== host),
                  }))
                }
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={egressInput}
          disabled={disabled}
          placeholder={t('search.egress.hostPlaceholder')}
          onChange={(e) => setEgressInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          aria-label={t('search.egress.hostPlaceholder')}
          className="max-w-sm"
        />
        <Button variant="outline" size="sm" disabled={disabled || !canAdd} onClick={add}>
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t('search.egress.add')}
        </Button>
      </div>
    </div>
  );
}

export default SearchSettingsSection;
