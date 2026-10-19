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
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPassword('');
    setConfirmation('');
    setError('');
    setBusy(false);
  }, [request]);
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
    if (request.mode === 'set') {
      if (password.length < 4 || password.length > 8) {
        setError(t('view-password-length'));
        return;
      }
      if (password !== confirmation) {
        setError(t('keyViewing.mismatch'));
        return;
      }
    }
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
      <DialogTitle>{t(request?.mode === 'set' ? 'keyViewing.setup' : 'keyViewing.title')}</DialogTitle>
      <DialogDescription>{t('keyViewing.description')}</DialogDescription>
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <Input
          type="password"
          autoComplete={request?.mode === 'set' ? 'new-password' : 'current-password'}
          aria-label={t(request?.mode === 'set' ? 'keyViewing.newPassword' : 'keyViewing.currentPassword')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          maxLength={request?.mode === 'set' ? 8 : 128}
          disabled={busy}
          autoFocus
        />
        {request?.mode === 'set' ? (
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={t('keyViewing.confirmPassword')}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            maxLength={8}
            disabled={busy}
          />
        ) : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={cancelViewingRequest}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !password}>
            {t(request?.mode === 'set' ? 'keyViewing.setup' : 'keyViewing.verify')}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
