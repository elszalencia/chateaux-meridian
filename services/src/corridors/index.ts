// Corridor resolution for the services: every reader of an amount, a holiday rule or a pay method
// asks `corridorOf(plan)` first and never looks at a country literal. The configuration itself is
// the repo-level config/corridors.ts, re-exported here so the web app reads it through
// @chateaux/services. `assertLocksEnabled` is the one guard every lock path runs before it
// touches a provider or the contract: a corridor without the FX leg never sees `apply_lock`.

import { CORRIDORS, CORRIDOR_IDS, corridor, majorToMinor, minorToMajor, type Corridor, type CorridorId } from '../../../config/corridors';
import type { ISODate, Plan } from '../domain/types';
import { businessDaysBetweenIn } from '../domain/dates';

export { CORRIDORS, CORRIDOR_IDS, corridor, majorToMinor, minorToMajor };
export type { Corridor, CorridorId };
export type { PayMethod, PayoutOption, PayoutProvider, ReceiptField, WhatsAppTemplate, PayStepKey, MoneyGramLimits } from '../../../config/corridors';

/** Plans written before corridors existed carry no `corridor`; they are Colombian. */
export const DEFAULT_CORRIDOR: CorridorId = 'co';

export function corridorIdOf(plan: Pick<Plan, 'corridor'> | null | undefined): CorridorId {
  return plan?.corridor ?? DEFAULT_CORRIDOR;
}

export function corridorOf(plan: Pick<Plan, 'corridor'> | null | undefined): Corridor {
  return CORRIDORS[corridorIdOf(plan)];
}

/** Amount in major units (pesos or dollars) of a minor-unit amount field of this plan. */
export function majorAmount(plan: Pick<Plan, 'corridor'> | null | undefined, minor: number): number {
  return minorToMajor(minor, corridorOf(plan));
}

/** Past the grace period on the corridor's own business-day calendar (holidays included). */
export function beyondGraceIn(today: ISODate, dueDate: ISODate, c: Corridor): boolean {
  return businessDaysBetweenIn(dueDate, today, c.holidays) > c.graceBusinessDays;
}

/** Thrown by `assertLocksEnabled`; the API layer maps it onto its `LOCKS_DISABLED` error code. */
export class LocksDisabledError extends Error {
  readonly code = 'LOCKS_DISABLED' as const;
  constructor(public readonly corridor: CorridorId) {
    super(`rate locks are not offered in corridor ${corridor}`);
    this.name = 'LocksDisabledError';
  }
}

/** Refuses any lock operation (quote, accept, apply_lock) for a corridor with `locksEnabled` false. */
export function assertLocksEnabled(plan: Pick<Plan, 'corridor'> | null | undefined): void {
  const c = corridorOf(plan);
  if (!c.locksEnabled) throw new LocksDisabledError(c.id);
}

/**
 * Stroops the contract moves for one installment of a corridor whose amount field holds cents:
 * cents × 100,000, exact (USDC has 7 decimals). Refuses non-integer amounts and corridors whose
 * field holds another unit, so a peso amount can never be sent as if it were cents.
 */
export function minorToStroops(minor: number, c: Corridor): bigint {
  if (c.decimals !== 2) throw new Error(`minorToStroops: corridor ${c.id} does not store cents`);
  if (!Number.isInteger(minor) || minor < 0) throw new Error(`minorToStroops: ${minor} is not a whole number of cents`);
  const stroops = BigInt(minor) * 100_000n;
  if (stroops !== BigInt(minor) * 100_000n || Number(stroops / 100_000n) !== minor) throw new Error('minorToStroops: inexact conversion');
  return stroops;
}
