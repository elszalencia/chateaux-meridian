// Counter session and the corridor session clock as the office screens see them.
// - The cashier works at one office for the shift (remembered per tab); the demo cashier id is fixed.
// - The services run the corridor on a session clock (the demo day at the seed hour plus the time
//   elapsed in the session). Payments carry that clock (`now`, `pendingMinutes`; see
//   app/serviceClock.ts); `useSessionNow` remains only for the seller's cooling-off hours.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { svSeedClock, type ISODate, type Office } from '@chateaux/services';

export const DEMO_CASHIER_ID = 'cajero-1';
const OFFICE_KEY = 'chateaux-oficina-office';

function readOffice(): string | null {
  try {
    return window.sessionStorage.getItem(OFFICE_KEY);
  } catch {
    return null;
  }
}

/** The licensed agency first (the brief's counter), then any office. */
export function defaultOffice(offices: Office[]): Office | null {
  return offices.find((o) => o.isLicensedAgency) ?? offices[0] ?? null;
}

export function useCounterOffice(offices: Office[] | null): [Office | null, (id: string) => void] {
  const [chosen, setChosen] = useState<string | null>(readOffice);
  const office = useMemo(() => (offices ? offices.find((o) => o.id === chosen) ?? defaultOffice(offices) : null), [offices, chosen]);
  const choose = useCallback((id: string) => {
    setChosen(id);
    try {
      window.sessionStorage.setItem(OFFICE_KEY, id);
    } catch {
      // ignore
    }
  }, []);
  return [office, choose];
}

/** Session clock in ms for a demo day; restarts when the day changes (clock advanced or reset). */
export function useSessionNow(today: ISODate | null | undefined, tickMs = 30_000): number | null {
  const started = useRef<{ day: string; at: number } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);
  if (!today) return null;
  if (!started.current || started.current.day !== today) started.current = { day: today, at: Date.now() };
  return Date.parse(svSeedClock(today)) + (Date.now() - started.current.at);
}
