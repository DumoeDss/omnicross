import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminClient } from '@/daemon/adminClient';
import { cancelViewingRequest } from '@/shared/keyViewing';
import { useTranslation } from '@/shared/state/LocaleContext';

export function KeyViewingPasswordSection() {
  const t = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recover, setRecover] = useState(false);
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void adminClient.get<{ enabled: boolean }>('/key-viewing-password').then((status) => {
      if (!cancelled) setEnabled(status.enabled);
    }).catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'view-password-unavailable'); });
    return () => { cancelled = true; };
  }, []);

  async function save(disable = false) {
    if (busy || enabled === null) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      if (!disable && (password.length < 8 || password.length > 128)) throw new Error('view-password-length');
      if (!disable && password !== confirm) throw new Error('keyViewing.mismatch');
      if (recover && !clearConfirmed) throw new Error('view-password-reset-confirm');
      if (recover) {
        await adminClient.post('/key-viewing-password/reset', { newPassword: password, confirmClearCredentials: true });
      } else {
        await adminClient.put('/key-viewing-password', { currentPassword: current, newPassword: disable ? null : password });
      }
      cancelViewingRequest();
      window.dispatchEvent(new Event('key-viewing-hide'));
      setEnabled(!disable); setRecover(false); setClearConfirmed(false); setSaved(true);
      if (recover) window.location.reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'view-password-unavailable'); }
    finally { setCurrent(''); setPassword(''); setConfirm(''); setBusy(false); }
  }

  return <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
    <h3 className="text-sm font-semibold">{t('keyViewing.title')}</h3>
    <p className="text-xs text-muted-foreground">{t('keyViewing.description')}</p>
    <p className="text-sm">{enabled === null ? t('apiService.loading') : t(enabled ? 'keyViewing.enabled' : 'keyViewing.disabled')}</p>
    <form className="max-w-md space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {enabled && !recover ? <label className="block space-y-1 text-xs">{t('keyViewing.currentPassword')}
        <Input type="password" autoComplete="current-password" value={current} maxLength={128} disabled={busy}
          onChange={(event) => setCurrent(event.target.value)} />
      </label> : null}
      <label className="block space-y-1 text-xs">{t('keyViewing.newPassword')}
        <Input type="password" autoComplete="new-password" value={password} maxLength={128} disabled={busy}
          onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label className="block space-y-1 text-xs">{t('keyViewing.confirmPassword')}
        <Input type="password" autoComplete="new-password" value={confirm} maxLength={128} disabled={busy}
          onChange={(event) => setConfirm(event.target.value)} />
      </label>
      {recover ? <div className="space-y-2 rounded-md border border-destructive/50 p-3">
        <p className="text-xs text-destructive">{t('keyViewing.resetWarning')}</p>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={clearConfirmed} disabled={busy}
          onChange={(event) => setClearConfirmed(event.target.checked)} />{t('keyViewing.confirmClear')}</label>
      </div> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{t(error)}</p> : null}
      {saved ? <p role="status" className="text-xs">{t('keyViewing.saved')}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || enabled === null || password.length < 8 || password !== confirm || (enabled && !recover && !current) || (recover && !clearConfirmed)}>
          {t(recover ? 'keyViewing.reset' : enabled ? 'keyViewing.change' : 'keyViewing.setup')}
        </Button>
        {enabled && !recover ? <Button type="button" size="sm" variant="outline" disabled={busy || !current} onClick={() => void save(true)}>{t('keyViewing.disable')}</Button> : null}
        {enabled ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => {
          setRecover(!recover); setClearConfirmed(false); setCurrent(''); setPassword(''); setConfirm(''); setError('');
        }}>{t(recover ? 'common.cancel' : 'keyViewing.forgot')}</Button> : null}
      </div>
    </form>
  </section>;
}
