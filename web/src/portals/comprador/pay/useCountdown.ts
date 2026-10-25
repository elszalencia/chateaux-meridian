// Countdown to a reference's expiry on the services' session clock: the payment carries the
// services' `now` from when it was read, and the page only adds the time elapsed since then.

import type { PaymentView } from '@casa-puente/services';
import { useServiceClock } from '../../../app/serviceClock';

/** Seconds left on a pending reference (null when it has no expiry); ticks once a second. */
export function useCountdown(payment: Pick<PaymentView, 'expiresAt' | 'status' | 'now'> | null): number | null {
  const clock = useServiceClock(payment?.expiresAt ? payment.now : null, { live: payment?.status === 'pending' });
  if (!payment?.expiresAt || clock == null) return null;
  return Math.max(0, Math.floor((Date.parse(payment.expiresAt) - clock) / 1000));
}

export function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
