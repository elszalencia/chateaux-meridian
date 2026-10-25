// What the buyer portal reads from the corridor config (config/corridors.ts). No component here
// names a country: each decision below is one config field.

import { CORRIDORS, addDays, type Corridor, type InstallmentView, type PlanView } from '@chateaux/services';

export function corridorOfView(view: PlanView): Corridor {
  return CORRIDORS[view.corridor];
}

/**
 * Corridors with rate locks keep the original buyer screens (lock flow, rate receipt, pay flow with
 * conversion); the others get the pay-sheet home with the corridor's methods and receipt fields.
 */
export function keepsLockScreens(c: Corridor): boolean {
  return c.views.lock;
}

/** First day the buyer may pay an installment (the corridor's pay window before the due date). */
export function payOpensOn(i: Pick<InstallmentView, 'dueDate'>, c: Corridor): string {
  return c.payWindowDays > 0 ? addDays(i.dueDate, -c.payWindowDays) : i.dueDate;
}

/** The installment the pay sheet opens on: the next one, or the earliest payable one. */
export function installmentToPay(view: PlanView): InstallmentView | null {
  const next = view.summary.nextInstallment;
  if (next?.payable) return next;
  return view.installments.find((i) => i.payable) ?? next ?? null;
}
