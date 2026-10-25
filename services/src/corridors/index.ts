// Corridor resolution for the services: every reader of an amount, a holiday rule or a pay method
// asks `corridorOf(plan)` first and never looks at a country literal. The configuration itself is
// the repo-level config/corridors.ts, re-exported here so the web app reads it through
// @casa-puente/services.

import { CORRIDORS, CORRIDOR_IDS, corridor, majorToMinor, minorToMajor, type Corridor, type CorridorId } from '../../../config/corridors';
import type { Plan } from '../domain/types';

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
