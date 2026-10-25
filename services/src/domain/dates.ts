// Calendar helpers on ISO `YYYY-MM-DD` strings, evaluated in UTC so the demo clock never shifts
// with the presenter's time zone. A business day is Mon to Fri and not a Colombian public holiday
// (see holidays.ts); US holidays are not modelled, since the deadlines that matter (cutoff, grace)
// are set by the Colombian trust and banks.

import type { ISODate } from './types';
import { isColombianHoliday } from './holidays';

export function parseISO(d: ISODate): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, day ?? 1));
}

export function toISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  const x = parseISO(d);
  x.setUTCDate(x.getUTCDate() + n);
  return toISO(x);
}

/** Adds calendar months, clamping the day of month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: ISODate, n: number): ISODate {
  const x = parseISO(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, lastDay));
  return toISO(x);
}

export function diffDays(from: ISODate, to: ISODate): number {
  return Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86_400_000);
}

export function compareISO(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isWeekend(d: ISODate): boolean {
  const dow = parseISO(d).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Mon to Fri and not a Colombian festivo. */
export function isBusinessDay(d: ISODate): boolean {
  return !isWeekend(d) && !isColombianHoliday(d);
}

/** Business days strictly after `from` up to and including `to` (0 if to <= from). */
export function businessDaysBetween(from: ISODate, to: ISODate): number {
  if (compareISO(to, from) <= 0) return 0;
  let n = 0;
  let cur = from;
  while (compareISO(cur, to) < 0) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur)) n += 1;
  }
  return n;
}

/** Moves `n` business days forward (or back when negative), landing on a business day. */
export function addBusinessDays(d: ISODate, n: number): ISODate {
  let cur = d;
  let remaining = Math.abs(n);
  const step = n >= 0 ? 1 : -1;
  while (remaining > 0) {
    cur = addDays(cur, step);
    if (isBusinessDay(cur)) remaining -= 1;
  }
  return cur;
}

export function yearOf(d: ISODate): number {
  return Number(d.slice(0, 4));
}

export function monthOf(d: ISODate): number {
  return Number(d.slice(5, 7));
}

/** Calendar quarter key such as `2027-T1`. */
export function quarterKey(d: ISODate): string {
  const q = Math.floor((monthOf(d) - 1) / 3) + 1;
  return `${yearOf(d)}-T${q}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}
