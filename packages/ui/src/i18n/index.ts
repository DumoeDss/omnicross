/**
 * i18n init (design D7) — minimal react-i18next, all supported languages.
 *
 * Resources are the ported `providerSettings` / `apiMode` / `presetName` trees
 * plus the `common` / `mediaSettings` subsets the page uses, and two app-local
 * keys (`appLocal.notSupportedByDaemon`, `appLocal.discoveryUnsupportedFormat`).
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ar from './ar.json';
import bg from './bg.json';
import cs from './cs.json';
import da from './da.json';
import de from './de.json';
import el from './el.json';
import en from './en.json';
import es419 from './es-419.json';
import esES from './es-ES.json';
import fi from './fi.json';
import fr from './fr.json';
import hu from './hu.json';
import id from './id.json';
import it from './it.json';
import ja from './ja.json';
import ko from './ko.json';
import ms from './ms.json';
import nb from './nb.json';
import nl from './nl.json';
import pl from './pl.json';
import ptBR from './pt-BR.json';
import ptPT from './pt-PT.json';
import ro from './ro.json';
import ru from './ru.json';
import sv from './sv.json';
import th from './th.json';
import tr from './tr.json';
import uk from './uk.json';
import vi from './vi.json';
import zh from './zh.json';
import zhHant from './zh-Hant.json';

const STORAGE_KEY = 'omnicross.lang';

const RESOURCES = {
  ar: { translation: ar },
  bg: { translation: bg },
  cs: { translation: cs },
  da: { translation: da },
  de: { translation: de },
  el: { translation: el },
  en: { translation: en },
  'es-419': { translation: es419 },
  'es-ES': { translation: esES },
  fi: { translation: fi },
  fr: { translation: fr },
  hu: { translation: hu },
  id: { translation: id },
  it: { translation: it },
  ja: { translation: ja },
  ko: { translation: ko },
  ms: { translation: ms },
  nb: { translation: nb },
  nl: { translation: nl },
  pl: { translation: pl },
  'pt-BR': { translation: ptBR },
  'pt-PT': { translation: ptPT },
  ro: { translation: ro },
  ru: { translation: ru },
  sv: { translation: sv },
  th: { translation: th },
  tr: { translation: tr },
  uk: { translation: uk },
  vi: { translation: vi },
  zh: { translation: zh },
  'zh-Hant': { translation: zhHant },
} as const;

export type Language = keyof typeof RESOURCES;

export const SUPPORTED_LANGUAGES: ReadonlyArray<{ code: Language; nativeName: string }> = [
  { code: 'en', nativeName: 'English' },
  { code: 'zh', nativeName: '简体中文' },
  { code: 'zh-Hant', nativeName: '繁體中文' },
  { code: 'ja', nativeName: '日本語' },
  { code: 'ko', nativeName: '한국어' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'it', nativeName: 'Italiano' },
  { code: 'es-ES', nativeName: 'Español (España)' },
  { code: 'es-419', nativeName: 'Español (Latinoamérica)' },
  { code: 'pt-BR', nativeName: 'Português (Brasil)' },
  { code: 'pt-PT', nativeName: 'Português (Portugal)' },
  { code: 'nl', nativeName: 'Nederlands' },
  { code: 'da', nativeName: 'Dansk' },
  { code: 'sv', nativeName: 'Svenska' },
  { code: 'nb', nativeName: 'Norsk bokmål' },
  { code: 'fi', nativeName: 'Suomi' },
  { code: 'pl', nativeName: 'Polski' },
  { code: 'cs', nativeName: 'Čeština' },
  { code: 'hu', nativeName: 'Magyar' },
  { code: 'ro', nativeName: 'Română' },
  { code: 'bg', nativeName: 'Български' },
  { code: 'ru', nativeName: 'Русский' },
  { code: 'uk', nativeName: 'Українська' },
  { code: 'el', nativeName: 'Ελληνικά' },
  { code: 'tr', nativeName: 'Türkçe' },
  { code: 'ar', nativeName: 'العربية' },
  { code: 'th', nativeName: 'ไทย' },
  { code: 'vi', nativeName: 'Tiếng Việt' },
  { code: 'id', nativeName: 'Bahasa Indonesia' },
  { code: 'ms', nativeName: 'Bahasa Melayu' },
];

export function isLanguage(value: string): value is Language {
  return Object.prototype.hasOwnProperty.call(RESOURCES, value);
}

/** Map a BCP 47 tag (e.g. navigator.language) onto a supported language code. */
function matchLanguage(tag: string): Language | null {
  const lower = tag.toLowerCase();

  // Regional variants that don't fall back to a bare base code we ship.
  if (lower.startsWith('zh')) {
    return lower.includes('tw') || lower.includes('hk') || lower.includes('mo') || lower.includes('hant')
      ? 'zh-Hant'
      : 'zh';
  }
  if (lower.startsWith('pt')) {
    return lower.startsWith('pt-pt') ? 'pt-PT' : 'pt-BR';
  }
  if (lower.startsWith('es')) {
    return lower === 'es' || lower.startsWith('es-es') ? 'es-ES' : 'es-419';
  }
  if (lower.startsWith('no') || lower.startsWith('nn')) return 'nb';

  const base = lower.split('-')[0];
  return isLanguage(base) ? base : null;
}

function detectInitialLang(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && isLanguage(saved)) return saved;
  } catch {
    // ignore (no localStorage)
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return matchLanguage(nav) ?? 'en';
}

export function initI18n(): typeof i18n {
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources: RESOURCES,
      lng: detectInitialLang(),
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  }
  return i18n;
}

export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

export default i18n;
