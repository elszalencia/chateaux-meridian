// NullPolicy: the policy engine to run while the business policy is undecided. It applies only the
// mechanical rules the brief already fixes (5 business days of grace, §9) and records everything
// else for a person to decide. It takes no financial action: it never refunds, never charges a
// penalty, never declares a default and never cancels. Each rule is marked "policy pending".
//
//   R1 late-in-grace   unpaid, past due, within grace     → record a notice (buyer sees "late")
//   R2 missed          open or broken, beyond grace       → request mark_missed (reason 100)
//   R3 default-review  misses reach the plan's threshold  → record "default eligible" only
//
// A locked installment beyond grace is left alone: the break job breaks it first (the contract
// only marks open or broken installments missed), and R2 picks it up on the next run.

import type { PlanFacts, PolicyDecision, PolicyEngine, RefundSizing } from './PolicyEngine';
import { REASONS } from './reasons';
import { compareISO, diffDays } from '../domain/dates';
import { isBeyondGrace } from '../lock/engine';

export const RULES = {
  LATE_IN_GRACE: 'R1-late-in-grace',
  MISSED: 'R2-missed-past-grace',
  DEFAULT_REVIEW: 'R3-default-review',
  REFUND_MANUAL: 'R4-refund-sized-by-a-person',
} as const;

const UNPAID = new Set(['open', 'locked', 'broken']);

export class NullPolicy implements PolicyEngine {
  readonly name = 'null-policy';

  evaluate(f: PlanFacts): PolicyDecision[] {
    const out: PolicyDecision[] = [];
    let misses = f.governance.misses;
    for (const row of [...f.installments].sort((a, b) => a.idx - b.idx)) {
      if (!UNPAID.has(row.status) || compareISO(f.today, row.dueDate) <= 0) continue;
      const beyond = isBeyondGrace(f.today, row.dueDate) && diffDays(row.dueDate, f.today) >= f.governance.policy.graceDays;
      if (!beyond) {
        const recordId = `pe-${f.plan.id}-late-${row.idx}`;
        if (!f.recorded.has(recordId)) {
          out.push({
            type: 'record',
            kind: 'late_in_grace',
            recordId,
            idx: row.idx,
            reasonCode: REASONS.GRACE_EXPIRED.code,
            rule: RULES.LATE_IN_GRACE,
            policyStatus: 'pending',
            detail: `M${row.idx + 1} due ${row.dueDate}`,
          });
        }
        continue;
      }
      if (row.status === 'locked') continue;
      out.push({
        type: 'act',
        action: { kind: 'mark_missed', planId: f.plan.id, idx: row.idx, reasonCode: REASONS.GRACE_EXPIRED.code },
        rule: RULES.MISSED,
        policyStatus: 'pending',
        detail: `M${row.idx + 1} due ${row.dueDate}`,
      });
      misses += 1;
    }
    const threshold = f.governance.policy.missesBeforeDefault;
    const recordId = `pe-${f.plan.id}-default-eligible-${misses}`;
    if (misses >= threshold && !f.recorded.has(recordId)) {
      out.push({
        type: 'record',
        kind: 'default_eligible',
        recordId,
        idx: null,
        reasonCode: REASONS.REPEATED_MISSES.code,
        rule: RULES.DEFAULT_REVIEW,
        policyStatus: 'pending',
        detail: `${misses} missed, threshold ${threshold}; declaring default is a person's decision`,
      });
    }
    return out;
  }

  sizeRefund(f: PlanFacts, reasonCode: number): RefundSizing {
    return {
      amountCents: null,
      rule: RULES.REFUND_MANUAL,
      policyStatus: 'pending',
      detail: `reason ${reasonCode}: the encargo's penalty clause (${f.governance.policy.penaltyBps} bps recorded) is not applied automatically`,
    };
  }
}
