// The services' session clock as a page sees it: the `now` the services stamped on what the page
// last read, plus the time elapsed in the page since that read. Pages never derive the clock from
// the demo date themselves, so a countdown or a "pending for N minutes" flag says what the
// services would say.

import { useEffect, useMemo, useState } from 'react';
import type { PaymentView } from '@chateaux/services';

/** The services' clock in ms, ticking every `tickMs` while `live`; null until something was read. */
export function useServiceClock(now: string | null | undefined, { tickMs = 1000, live = true }: { tickMs?: number; live?: boolean } = {}): number | null {
  const anchor = useMemo(() => (now ? { service: Date.parse(now), local: Date.now() } : null), [now]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!anchor || !live) return;
    const id = window.setInterval(() => setTick((n) => n + 1), tickMs);
    return () => window.clearInterval(id);
  }, [anchor, live, tickMs]);
  return anchor ? anchor.service + (Date.now() - anchor.local) : null;
}

/** Minutes a cash reference has been pending: the services' count when read, plus whole minutes since. */
export function pendingMinutesAt(p: Pick<PaymentView, 'pendingMinutes' | 'now'>, clockMs: number | null): number | null {
  if (p.pendingMinutes == null) return null;
  const since = clockMs == null ? 0 : Math.max(0, clockMs - Date.parse(p.now));
  return p.pendingMinutes + Math.floor(since / 60_000);
}
