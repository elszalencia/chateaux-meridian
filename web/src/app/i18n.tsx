// Minimal i18n: dictionaries in web/src/i18n/{es,en}.json, dot-path keys, `{name}` interpolation.
// Spanish is the default; the language is remembered per browser. Number and date formatting take
// their locale from the dictionary's `_meta.locale`, so switching language also switches
// thousands separators (es-CO: 1.188,33 · en-US: 1,188.33).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import es from '../i18n/es.json';
import en from '../i18n/en.json';

export type Lang = 'es' | 'en';
type Dict = Record<string, unknown>;

// Namespace files web/src/i18n/{es,en}/<namespace>.json are merged into the base dictionary, so
// parallel workstreams add keys without touching es.json / en.json. The base file wins on a clash,
// at every depth; tests/i18n.test.ts fails on any clash, so this rule never decides what users see.
const NAMESPACES = import.meta.glob<Dict>('../i18n/*/*.json', { eager: true, import: 'default' });

function isDict(v: unknown): v is Dict {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function mergeDict(base: Dict, extra: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k];
    if (isDict(cur) && isDict(v)) out[k] = mergeDict(cur, v);
    else if (!(k in out)) out[k] = v;
  }
  return out;
}

function withNamespaces(lang: Lang, base: Dict): Dict {
  const files = Object.keys(NAMESPACES).filter((f) => f.startsWith(`../i18n/${lang}/`)).sort();
  return files.reduce((acc, f) => mergeDict(acc, NAMESPACES[f]!), base);
}

export const DICTS: Record<Lang, Dict> = {
  es: withNamespaces('es', es as Dict),
  en: withNamespaces('en', en as Dict),
};

export function lookup(dict: Dict, key: string): string | undefined {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Dict)) cur = (cur as Dict)[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

export type TFn = (key: string, params?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  locale: string;
  setLang: (l: Lang) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);
const LANG_KEY = 'chateaux-lang';

function readLang(): Lang {
  try {
    const v = window.localStorage.getItem(LANG_KEY);
    return v === 'en' ? 'en' : 'es';
  } catch {
    return 'es';
  }
}

export function I18nProvider({ children, initialLang }: { children: ReactNode; initialLang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initialLang ?? readLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(LANG_KEY, l);
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo<I18nValue>(() => {
    const dict = DICTS[lang];
    const locale = lookup(dict, '_meta.locale') ?? (lang === 'es' ? 'es-CO' : 'en-US');
    const t: TFn = (key, params) => {
      const s = lookup(dict, key) ?? lookup(DICTS.es, key);
      if (s === undefined) {
        if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`);
        return key;
      }
      return interpolate(s, params);
    };
    return { lang, locale, setLang, t };
  }, [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export function useT(): TFn {
  return useI18n().t;
}
