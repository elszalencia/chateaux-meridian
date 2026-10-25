// PolicyEngine: the seam where Casa Puente's business policy for adverse events will live. It looks
// at one plan's facts and answers two questions: which transitions to request today (or merely to
// record), and how much of a held balance a refund should return. It never moves funds or writes
// state itself; `runAdverseEventsDaily` executes its decisions through the GovernanceProvider.
// Every decision carries `policyStatus: 'pending'` until the business signs off the rule that made
// it (docs/ADVERSE_EVENTS.md lists the open decisions).

import type { Installment, ISODate, Plan, PlanGovernance } from '../domain/types';
import type { AdverseAction } from './transitions';

export interface PlanFacts {
  plan: Plan;
  governance: PlanGovernance;
  /** This plan's installments, by idx. */
  installments: Installment[];
  today: ISODate;
  /** Ids of the plan's record-only events already written, so notices are not repeated. */
  recorded: ReadonlySet<string>;
}

/** A transition to request from the contract (through the GovernanceProvider). */
export interface ActDecision {
  type: 'act';
  action: AdverseAction;
  rule: string;
  policyStatus: 'pending';
  detail?: string;
}

/** Something to write down without any on-chain or financial effect. */
export interface RecordDecision {
  type: 'record';
  kind: 'late_in_grace' | 'default_eligible';
  /** Stable id of the record; the job skips it when `recorded` already holds it. */
  recordId: string;
  idx: number | null;
  reasonCode: number;
  rule: string;
  policyStatus: 'pending';
  detail?: string;
}

export type PolicyDecision = ActDecision | RecordDecision;

export interface RefundSizing {
  /** USD cents to return, or null when the policy cannot size it and a person must. */
  amountCents: number | null;
  rule: string;
  policyStatus: 'pending';
  detail: string;
}

export interface PolicyEngine {
  readonly name: string;
  /** Today's decisions for one plan, in the order they should run. */
  evaluate(facts: PlanFacts): PolicyDecision[];
  /** How much of the held balance a refund returns for this reason (withdrawal penalty, etc.). */
  sizeRefund(facts: PlanFacts, reasonCode: number): RefundSizing;
}
