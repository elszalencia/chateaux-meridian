// Is a seeded chain plan still in the demo's step-1 state? A walk-through consumes the seeded plans
// (locks get applied, installments released), and a consumed plan cannot be walked through again:
// `apply_lock` answers NotOpen. The deploy script re-seeds such plans; the server checks the same
// thing at startup and reports it in /health (`needsReset`).

import { buildSeed } from '../seed/fixtures';
import type { ChainPlanStatus } from './client';

export interface PristineCheck {
  planId: string;
  chainPlanId: number;
  pristine: boolean;
  /** Why the plan is not pristine (or could not be read); empty when pristine. */
  reason: string;
}

/** Compares a chain plan with the seed: same installment count and statuses, plan state active. */
export function comparePlanWithSeed(planId: string, status: ChainPlanStatus): { pristine: boolean; reason: string } {
  const expected = buildSeed()
    .installments.filter((i) => i.planId === planId)
    .sort((a, b) => a.idx - b.idx)
    .map((i) => i.status);
  const actual = status.installments.map((i) => i.status);
  if (expected.length !== actual.length) return { pristine: false, reason: `${actual.length} installments on chain, ${expected.length} in the seed` };
  const diff = expected.findIndex((e, k) => e !== actual[k]);
  if (diff >= 0) return { pristine: false, reason: `M${diff + 1} is ${actual[diff]} on chain, ${expected[diff]} in the seed` };
  if (status.governance.state !== 'active') return { pristine: false, reason: `plan state is ${status.governance.state}` };
  return { pristine: true, reason: '' };
}

/**
 * Reads every mapped chain plan and compares it with the seed; unreadable plans count as used.
 * `getStatus` also receives the demo plan id, so a caller with one contract instance per corridor
 * can read each plan from the instance its corridor runs on.
 */
export async function checkChainPlans(
  chainPlans: Record<string, number>,
  getStatus: (chainPlanId: number, planId: string) => Promise<ChainPlanStatus>,
): Promise<PristineCheck[]> {
  return Promise.all(
    Object.entries(chainPlans).map(async ([planId, chainPlanId]) => {
      try {
        const r = comparePlanWithSeed(planId, await getStatus(chainPlanId, planId));
        return { planId, chainPlanId, ...r };
      } catch (e) {
        return { planId, chainPlanId, pristine: false, reason: `not readable: ${e instanceof Error ? e.message : String(e)}` };
      }
    }),
  );
}
