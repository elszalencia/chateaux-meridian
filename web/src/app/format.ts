// Formatting helpers bound to the active locale. COP is always whole pesos; USD two decimals;
// rates three decimals (3.444,427). Dates render as "20 nov 2026" / "Nov 20, 2026": the month is
// always a 3-letter abbreviation from a fixed table (Intl gives "20 de nov de 2026" and "sept" in
// Spanish, which is longer than the calendar cells can hold), the rest follows the locale.

import { useMemo } from 'react';
import { parseISO } from '@chateaux/services';
import { useI18n } from './i18n';

export interface Formatters {
  cop: (n: number) => string;
  copSigned: (n: number) => string;
  usd: (n: number) => string;
  rate: (n: number) => string;
  pct: (fraction: number) => string;
  date: (iso: string) => string;
  dateTime: (iso: string) => string;
  monthYear: (iso: string) => string;
  number: (n: number, digits?: number) => string;
}

const MONTHS: Record<string, readonly string[]> = {
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

function toDate(iso: string): Date {
  return iso.length === 10 ? parseISO(iso) : new Date(iso);
}

/** Short month name: fixed 3-letter table for es/en; any other language falls back to Intl, trimmed to 3 letters. */
function monthName(locale: string, lang: string, d: Date): string {
  const table = MONTHS[lang];
  if (table) return table[d.getUTCMonth()]!;
  const raw = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(d);
  return raw.replace(/\./g, '').slice(0, 3);
}

export function makeFormatters(locale: string): Formatters {
  const lang = locale.split('-')[0]!.toLowerCase();
  const copFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const usdFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rateFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const pctFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  // Day first and 24-hour clock for every language except English ("20 nov 2026, 14:05" / "Nov 20, 2026, 2:05 PM").
  const dayFirst = lang !== 'en';
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: dayFirst ? '2-digit' : 'numeric', minute: '2-digit', hourCycle: dayFirst ? 'h23' : 'h12', timeZone: 'UTC' });
  const date = (d: Date) => {
    const day = d.getUTCDate();
    const mon = monthName(locale, lang, d);
    const year = d.getUTCFullYear();
    return dayFirst ? `${day} ${mon} ${year}` : `${mon} ${day}, ${year}`;
  };
  const monthYear = (d: Date) => `${monthName(locale, lang, d)} ${d.getUTCFullYear()}`;
  return {
    cop: (n) => `COP ${copFmt.format(Math.round(n))}`,
    copSigned: (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}COP ${copFmt.format(Math.abs(Math.round(n)))}`,
    usd: (n) => `USD ${usdFmt.format(n)}`,
    rate: (n) => rateFmt.format(n),
    pct: (f) => `${pctFmt.format(f * 100)} %`,
    date: (iso) => date(toDate(iso)),
    dateTime: (iso) => {
      const d = new Date(iso);
      return `${date(d)}, ${timeFmt.format(d).replace(/ /g, ' ')}`;
    },
    monthYear: (iso) => monthYear(toDate(iso)),
    number: (n, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n),
  };
}

export function useFormat(): Formatters {
  const { locale } = useI18n();
  return useMemo(() => makeFormatters(locale), [locale]);
}
