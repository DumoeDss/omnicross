/**
 * SettingsPage.tsx — desktop preferences: startup (auto-launch + launch
 * minimized), tray (minimize on close), and interface language.
 *
 * The startup/tray toggles are enforced natively and only apply inside the Tauri
 * shell — outside it (browser dev) they render disabled with a hint. Language
 * works everywhere (it drives the renderer i18n; in Tauri it is also mirrored to
 * the native layer so the tray menu localizes).
 */

import { MinusSquare, Power, Settings as SettingsIcon } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Select } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import i18n, { isLanguage, setLanguage, SUPPORTED_LANGUAGES, type Language } from '@/i18n';
import { useTranslation } from '@/shared/state/LocaleContext';
import {
  getUiSettings,
  isDesktop,
  setUiSettings,
  type UiSettings,
} from '@/shared/tauri/uiSettings';

function currentLang(): Language {
  const lang = i18n.language ?? 'en';
  if (isLanguage(lang)) return lang;
  const base = lang.split('-')[0];
  return isLanguage(base) ? base : 'en';
}

export function SettingsPage() {
  const t = useTranslation();
  const desktop = isDesktop();
  const [lang, setLang] = useState<Language>(currentLang());
  const [settings, setSettings] = useState<UiSettings>({
    closeToTray: false,
    startMinimized: false,
    autoStart: false,
    language: currentLang(),
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fresh = await getUiSettings();
      if (fresh && !cancelled) setSettings(fresh);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (patch: Partial<UiSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    await setUiSettings(patch);
    // Re-read so OS-owned state (autostart can refuse) reconciles with reality.
    const fresh = await getUiSettings();
    if (fresh) setSettings(fresh);
  };

  const handleLanguage = (value: string) => {
    const next: Language = isLanguage(value) ? value : 'en';
    setLanguage(next);
    setLang(next);
    void setUiSettings({ language: next });
  };

  const languageOptions = SUPPORTED_LANGUAGES.map(({ code, nativeName }) => ({
    value: code,
    label: nativeName,
  }));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {/* Header card */}
          <section className="rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2">
                <SettingsIcon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">{t('settings.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.description')}</p>
              </div>
            </div>
          </section>

          {!desktop ? (
            <div className="rounded-md border border-border/60 bg-surface-2/40 px-4 py-3 text-sm text-muted-foreground">
              {t('settings.desktopOnly')}
            </div>
          ) : null}

          {/* Language */}
          <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <h3 className="text-sm font-semibold text-foreground">{t('settings.language.title')}</h3>
            <SettingRow label={t('settings.language.label')}>
              <Select
                value={lang}
                options={languageOptions}
                onChange={handleLanguage}
                size="sm"
                className="w-32"
              />
            </SettingRow>
          </section>

          {/* Startup (incl. close-to-tray behavior) */}
          <section className="space-y-3 rounded-xl border border-border/70 bg-surface-1/60 p-4 md:p-5">
            <h3 className="text-sm font-semibold text-foreground">{t('settings.startup.title')}</h3>
            <SettingRow
              icon={Power}
              label={t('settings.startup.autoLaunch')}
              description={t('settings.startup.autoLaunchHint')}
            >
              <Switch
                checked={settings.autoStart}
                disabled={!desktop}
                onCheckedChange={(v) => void update({ autoStart: v })}
              />
            </SettingRow>
            <SettingRow
              label={t('settings.startup.startMinimized')}
              description={t('settings.startup.startMinimizedHint')}
            >
              <Switch
                checked={settings.startMinimized}
                disabled={!desktop}
                onCheckedChange={(v) => void update({ startMinimized: v })}
              />
            </SettingRow>
            <SettingRow
              icon={MinusSquare}
              label={t('settings.tray.minimizeOnClose')}
              description={t('settings.tray.minimizeOnCloseHint')}
            >
              <Switch
                checked={settings.closeToTray}
                disabled={!desktop}
                onCheckedChange={(v) => void update({ closeToTray: v })}
              />
            </SettingRow>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

export default SettingsPage;
