/**
 * ProxyEditor.tsx — a reusable upstream-proxy editor (upstream-proxy).
 *
 * Edits ONE structured proxy (`type`/`host`/`port`/`username`/`password`) behind
 * an enable Switch, shared by the API-service server card (global + per-provider)
 * and the per-account override in the Accounts page. The password is a masked,
 * WRITE-ONLY field: it is NEVER seeded from a payload (the GET already strips it),
 * shows a "leave blank to keep" placeholder when one is stored, and is omitted
 * from the emitted config when blank so the daemon preserves the stored secret.
 * Toggling the switch off calls `onClear`.
 */

import React, { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { ProxyConfig } from '@/daemon/types';
import type { SanitizedProxyConfig } from '@/daemon/types-accounts';

/** Normalized seed the editor renders from (secret-free). */
export interface ProxyEditorSeed {
  configured: boolean;
  type: 'http' | 'https' | 'socks5';
  host: string;
  port: string;
  username: string;
  hasPassword: boolean;
}

const EMPTY_SEED: ProxyEditorSeed = {
  configured: false,
  type: 'http',
  host: '',
  port: '',
  username: '',
  hasPassword: false,
};

/** Split a display `host:port` endpoint into its parts (last colon wins). */
function splitEndpoint(endpoint: string | undefined): { host: string; port: string } {
  if (!endpoint) return { host: '', port: '' };
  const idx = endpoint.lastIndexOf(':');
  if (idx < 0) return { host: endpoint, port: '' };
  return { host: endpoint.slice(0, idx), port: endpoint.slice(idx + 1) };
}

/** Seed the editor from a masked `SanitizedProxyConfig` (accounts view). */
export function seedFromSanitized(proxy: SanitizedProxyConfig | undefined): ProxyEditorSeed {
  if (!proxy) return EMPTY_SEED;
  const { host, port } = splitEndpoint(proxy.endpoint);
  return {
    configured: true,
    type: proxy.kind === 'url' ? 'http' : proxy.kind,
    host,
    port,
    username: proxy.username ?? '',
    hasPassword: proxy.hasPassword,
  };
}

/** Seed the editor from a redacted `ProxyConfig` (server-config view). */
export function seedFromProxyConfig(proxy: ProxyConfig | undefined): ProxyEditorSeed {
  if (!proxy) return EMPTY_SEED;
  if ('url' in proxy) {
    try {
      const u = new URL(proxy.url);
      const kind = u.protocol.replace(/:$/, '').toLowerCase();
      return {
        configured: true,
        type: kind === 'https' ? 'https' : kind === 'socks5' || kind === 'socks' ? 'socks5' : 'http',
        host: u.hostname,
        port: u.port,
        username: u.username ? decodeURIComponent(u.username) : '',
        hasPassword: u.password.length > 0,
      };
    } catch {
      return { ...EMPTY_SEED, configured: true };
    }
  }
  return {
    configured: true,
    type: proxy.type,
    host: proxy.host,
    port: String(proxy.port),
    username: proxy.username ?? '',
    hasPassword: typeof proxy.password === 'string' && proxy.password.length > 0,
  };
}

export interface ProxyEditorProps {
  label: string;
  description?: string;
  seed: ProxyEditorSeed;
  busy: boolean;
  onSave: (proxy: ProxyConfig) => void | Promise<void>;
  onClear: () => void | Promise<void>;
}

export function ProxyEditor({ label, description, seed, busy, onSave, onClear }: ProxyEditorProps) {
  const t = useTranslation();
  const [enabled, setEnabled] = useState(seed.configured);
  const [type, setType] = useState(seed.type);
  const [host, setHost] = useState(seed.host);
  const [port, setPort] = useState(seed.port);
  const [username, setUsername] = useState(seed.username);
  const [password, setPassword] = useState('');

  // Re-seed when the persisted value changes (a fresh GET after a save).
  useEffect(() => {
    setEnabled(seed.configured);
    setType(seed.type);
    setHost(seed.host);
    setPort(seed.port);
    setUsername(seed.username);
    setPassword('');
  }, [seed]);

  const toggle = (next: boolean) => {
    setEnabled(next);
    // Turning it OFF clears a previously-configured proxy immediately.
    if (!next && seed.configured) void onClear();
  };

  const portNum = parseInt(port.trim(), 10);
  const canSave = host.trim().length > 0 && Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535;

  const save = () => {
    if (!canSave) return;
    const proxy: ProxyConfig = { type, host: host.trim(), port: portNum };
    if (username.trim()) proxy.username = username.trim();
    if (password) proxy.password = password;
    void onSave(proxy);
  };

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-surface-0/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{label}</h4>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        <Switch
          checked={enabled}
          disabled={busy}
          onCheckedChange={toggle}
          aria-label={label}
        />
      </div>

      {enabled ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t('proxy.field.type')}
              </label>
              <Select
                value={type}
                onChange={(v) => setType(v as 'http' | 'https' | 'socks5')}
                disabled={busy}
                options={[
                  { value: 'http', label: 'HTTP' },
                  { value: 'https', label: 'HTTPS' },
                  { value: 'socks5', label: 'SOCKS5' },
                ]}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('proxy.field.host')}
              </label>
              <Input
                density="compact"
                value={host}
                disabled={busy}
                placeholder="127.0.0.1"
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t('proxy.field.port')}
              </label>
              <Input
                type="number"
                density="compact"
                value={port}
                disabled={busy}
                placeholder="1080"
                min={1}
                max={65535}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t('proxy.field.username')}
              </label>
              <Input
                density="compact"
                value={username}
                disabled={busy}
                autoComplete="off"
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t('proxy.field.password')}
              </label>
              <RevealableInput
                value={password}
                disabled={busy}
                autoComplete="new-password"
                placeholder={seed.hasPassword ? t('proxy.field.passwordKeep') : ''}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-2 disabled:opacity-50"
              disabled={busy || !canSave}
              onClick={save}
            >
              {t('proxy.save')}
            </button>
            <p className="text-xs text-muted-foreground">{t('proxy.saveHint')}</p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('proxy.disabledHint')}</p>
      )}
    </div>
  );
}

export default ProxyEditor;
