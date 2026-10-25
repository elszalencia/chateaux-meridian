// Countdown to a reference's expiry on the demo's session clock. The services run that clock from
// the demo date (seed time of day) plus the time elapsed since the page started; the page estimates
// it the same way and clamps it between the reference's creation and expiry, so a reload or a
// slow network never shows more time than the reference had.

import { useEffect, useMemo, useState } from 'react';
import { svSeedClock, type Payment } from '@casa-puente/services';

/** The services' "now" in ms, as the page can best estimate it. */
export function estimateServiceNow(today: string, createdAt: string, expiresAt: string, elapsedMs = performance.now()): number {
  const raw = Date.parse(svSeedClock(today)) + elapsedMs;
  return Math.min(Math.max(raw, Date.parse(createdAt)), Date.parse(expiresAt));
}

/** Seconds left on a pending reference (null when it has no expiry); ticks once a second. */
export function useCountdown(payment: Pick<Payment, 'id' | 'createdAt' | 'expiresAt' | 'status'> | null, today: string): number | null {
  const anchor = useMemo(() => {
    if (!payment?.expiresAt) return null;
    return { serviceNow: estimateServiceNow(today, payment.createdAt, payment.expiresAt), at: Date.now(), expires: Date.parse(payment.expiresAt) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.id, payment?.expiresAt, today]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!anchor || payment?.status !== 'pending') return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [anchor, payment?.status]);
  if (!anchor) return null;
  const now = anchor.serviceNow + (Date.now() - anchor.at);
  return Math.max(0, Math.floor((anchor.expires - now) / 1000));
}

export function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
