/**
 * DataMigrationSection.tsx — the app's "Data Migration" UI (app-parity child 6).
 *
 * Two flows over the daemon's encrypted-pack endpoints (`agent.migration`):
 *  - EXPORT: enter a passphrase (+ confirm, with a strength hint) → receive the
 *    OPAQUE pack in a copyable textarea + a "download to file" (Blob anchor). The
 *    pack is passphrase-encrypted ciphertext, so it is safe to display/copy.
 *  - IMPORT: enter the passphrase + paste (or choose a file with) the pack →
 *    restore → show the STATUS-ONLY counts. A wrong passphrase surfaces a clean
 *    error; no secret is ever displayed.
 *
 * SECRET SPINE: the passphrase inputs are masked and held only in local state for
 * the duration of the flow (cleared on close); they are never persisted. The
 * displayed pack is opaque ciphertext. React UI-only — no host bridge, no
 * platform-native modules (the download uses a Blob + anchor, portable in both
 * the browser-dev shell and the Tauri webview).
 */

import { Download, FileUp } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { ImportPackResponse } from '@/daemon/types-migration';

const MIN_PASSPHRASE_LENGTH = 8;
const STRONG_PASSPHRASE_LENGTH = 12;

type Strength = 'weak' | 'fair' | 'strong';

/** Classify a passphrase by length (mirrors the daemon's min + the i18n hints). */
function strengthOf(passphrase: string): Strength {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return 'weak';
  if (passphrase.length < STRONG_PASSPHRASE_LENGTH) return 'fair';
  return 'strong';
}

// ── Export dialog ─────────────────────────────────────────────────────────────

function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pack, setPack] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = useMemo(() => strengthOf(passphrase), [passphrase]);
  const mismatch = confirm.length > 0 && passphrase !== confirm;
  const canSubmit =
    passphrase.length >= MIN_PASSPHRASE_LENGTH && passphrase === confirm && !busy;

  // Reset all transient secret state whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setPassphrase('');
      setConfirm('');
      setPack(null);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    const result = await agent.migration.exportPack(passphrase);
    setBusy(false);
    if (result.success && result.pack) {
      setPack(result.pack);
    } else {
      setError(result.message || t('providerSettings.migrationPack.export.error'));
    }
  };

  const handleDownload = () => {
    if (!pack) return;
    const blob = new Blob([pack], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'omnicross-migration-pack.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = () => {
    if (pack) void navigator.clipboard?.writeText(pack);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('providerSettings.migrationPack.export.title')}</DialogTitle>
          <DialogDescription>
            {t('providerSettings.migrationPack.export.subtitle')}
          </DialogDescription>
        </DialogHeader>

        {pack === null ? (
          <div className="space-y-4">
            <p className="text-xs text-amber-500">
              {t('providerSettings.migrationPack.export.warning')}
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('providerSettings.migrationPack.passphrase')}
              </label>
              <Input
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t('providerSettings.migrationPack.passphrasePlaceholder')}
              />
              <p className="text-xs text-muted-foreground">
                {t('providerSettings.migrationPack.passphraseHint')}
              </p>
              {passphrase.length > 0 ? (
                <p
                  className={
                    strength === 'weak'
                      ? 'text-xs text-destructive'
                      : strength === 'fair'
                        ? 'text-xs text-amber-500'
                        : 'text-xs text-emerald-500'
                  }
                >
                  {t(`providerSettings.migrationPack.strength.${strength}`)}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('providerSettings.migrationPack.confirm')}
              </label>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t('providerSettings.migrationPack.confirmPlaceholder')}
              />
              {mismatch ? (
                <p className="text-xs text-destructive">
                  {t('providerSettings.migrationPack.mismatch')}
                </p>
              ) : null}
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-emerald-500">
              {t('providerSettings.migrationPack.export.success')}
            </p>
            <textarea
              readOnly
              value={pack}
              className="w-full h-40 resize-none rounded-md border border-border bg-surface-1 p-2 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {t('common.copy')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4" />
                {t('providerSettings.migrationPack.export.button')}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          {pack === null ? (
            <Button onClick={() => void handleExport()} disabled={!canSubmit}>
              {t('providerSettings.migrationPack.export.submit')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Import dialog ─────────────────────────────────────────────────────────────

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [blob, setBlob] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<ImportPackResponse | null>(null);

  const canSubmit = passphrase.length > 0 && blob.trim().length > 0 && !busy;

  useEffect(() => {
    if (!open) {
      setPassphrase('');
      setBlob('');
      setError(null);
      setCounts(null);
      setBusy(false);
    }
  }, [open]);

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBlob((await file.text()).trim());
    event.target.value = '';
  };

  const handleImport = async () => {
    setBusy(true);
    setError(null);
    const result = await agent.migration.importPack({ blob: blob.trim(), passphrase });
    setBusy(false);
    if (result.success && result.counts) {
      setCounts(result.counts);
    } else {
      setError(result.message || t('providerSettings.migrationPack.import.error'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('providerSettings.migrationPack.import.title')}</DialogTitle>
          <DialogDescription>
            {t('providerSettings.migrationPack.import.subtitle')}
          </DialogDescription>
        </DialogHeader>

        {counts === null ? (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {t('providerSettings.migrationPack.import.hint')}
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('providerSettings.migrationPack.passphrase')}
              </label>
              <Input
                type="password"
                autoComplete="off"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t('providerSettings.migrationPack.passphrasePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  {t('providerSettings.migrationPack.import.title')}
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline">
                  <FileUp className="h-3.5 w-3.5" />
                  <span>{t('providerSettings.migrationPack.import.button')}</span>
                  <input
                    type="file"
                    accept=".txt,.json,text/plain"
                    className="hidden"
                    onChange={(e) => void handleFile(e)}
                  />
                </label>
              </div>
              <textarea
                value={blob}
                onChange={(e) => setBlob(e.target.value)}
                className="w-full h-32 resize-none rounded-md border border-border bg-surface-1 p-2 font-mono text-xs"
                placeholder="OMCXPACK1...."
              />
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium text-emerald-500">
              {t('providerSettings.migrationPack.import.successTitle')}
            </p>
            <p className="text-sm text-foreground">
              {t('providerSettings.migrationPack.import.summary', {
                providerKeys: counts.providerKeys,
                poolKeys: counts.poolKeys,
                tokenSets: counts.tokenSets,
              })}
            </p>
            {counts.duplicates > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('providerSettings.migrationPack.import.duplicates', { count: counts.duplicates })}
              </p>
            ) : null}
            {counts.skipped.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('providerSettings.migrationPack.import.skipped', {
                  names: counts.skipped.join(', '),
                })}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          {counts === null ? (
            <Button onClick={() => void handleImport()} disabled={!canSubmit}>
              {t('providerSettings.migrationPack.import.submit')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Section (trigger) ─────────────────────────────────────────────────────────

export function DataMigrationSection() {
  const t = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="flex items-center gap-3 border-t border-border/50 px-4 py-3">
      <span className="flex-1 min-w-0 text-xs text-muted-foreground">
        {t('providerSettings.migrationPack.barHint')}
      </span>
      <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
        <Download className="h-4 w-4" />
        {t('providerSettings.migrationPack.export.button')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
        <FileUp className="h-4 w-4" />
        {t('providerSettings.migrationPack.import.button')}
      </Button>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
