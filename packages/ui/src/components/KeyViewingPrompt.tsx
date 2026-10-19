import React, { useEffect, useState, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cancelViewingRequest, completeViewingRequest, viewingRequests } from '@/shared/keyViewing';
import { useTranslation } from '@/shared/state/LocaleContext';

export function KeyViewingPrompt() {
  const request = useSyncExternalStore(viewingRequests.subscribe, viewingRequests.get);
  const t = useTranslation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPassword(''); setError(''); setBusy(false); }, [request]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancelViewingRequest(); };
    window.addEventListener('blur', cancelViewingRequest);
    window.addEventListener('key-viewing-hide', cancelViewingRequest);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', cancelViewingRequest);
      window.removeEventListener('key-viewing-hide', cancelViewingRequest);
      document.removeEventListener('visibilitychange', hidden);
      cancelViewingRequest();
    };
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!request || busy) return;
    const current = request;
    setBusy(true); setError('');
    const value = password;
    setPassword('');
    try { completeViewingRequest(current, await current.run(value)); }
    catch (err) {
      if (viewingRequests.get() === current) setError(t(err instanceof Error ? err.message : 'view-password-unavailable'));
    } finally { if (viewingRequests.get() === current) setBusy(false); }
  }
  return <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) cancelViewingRequest(); }}>
    <DialogContent>
      <DialogTitle>{t('keyViewing.title')}</DialogTitle>
      <DialogDescription>{t('keyViewing.description')}</DialogDescription>
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <Input type="password" autoComplete="current-password" aria-label={t('keyViewing.currentPassword')}
          value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} disabled={busy} autoFocus />
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={cancelViewingRequest}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !password}>{t('keyViewing.verify')}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
