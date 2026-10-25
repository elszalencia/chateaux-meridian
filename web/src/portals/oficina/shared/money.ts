// Money on office screens: always the currency, two decimals for USD (whole pesos for COP). The
// currency and minor-unit digits come from the plan's corridor config, never from a country check.

import { useMemo } from 'react';
import { CORRIDORS, minorToMajor, type CorridorId } from '@casa-puente/services';
import { useFormat } from '../../../app/format';

export interface Money {
  /** USD amount in dollars. */
  usd: (n: number) => string;
  /** USD amount in cents. */
  cents: (c: number) => string;
  /** An amount field of a plan (its corridor's minor unit) in that corridor's currency. */
  planMinor: (minor: number, corridor: CorridorId) => string;
}

export function useMoney(): Money {
  const f = useFormat();
  return useMemo<Money>(
    () => ({
      usd: (n) => f.usd(n),
      cents: (c) => f.usd(c / 100),
      planMinor: (minor, id) => {
        const c = CORRIDORS[id];
        return c.currency === 'USD' ? f.usd(minorToMajor(minor, c)) : f.cop(minorToMajor(minor, c));
      },
    }),
    [f],
  );
}

/** Parses what a cashier types ("800", "800.5", "1,000.00", "800,50") into cents, or null. */
export function parseUsdToCents(text: string): number | null {
  const s = text.trim().replace(/\s/g, '');
  if (!s) return null;
  // A comma followed by one or two digits at the end is a decimal comma; other commas group thousands.
  const normalized = /,\d{1,2}$/.test(s) && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

/** Bills a cashier is likely to be handed for an amount: exact, then the next 10, 50 and 100. */
export function quickAmounts(dueCents: number): number[] {
  const up = (step: number) => Math.ceil(dueCents / step) * step;
  return [...new Set([dueCents, up(1_000), up(5_000), up(10_000)])].filter((c) => c >= dueCents).slice(0, 4);
}
