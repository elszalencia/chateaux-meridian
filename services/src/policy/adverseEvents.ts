// Adverse-event execution. `performAdverseAction` is the one path every transition takes: dry-run
// the contract rules, hash the record into an evidence hash, call the GovernanceProvider, and only
// then write the governance row, the installments and the `policy_events` record. The daily job
// `runAdverseEventsDaily` asks the PolicyEngine what to do for each plan and runs it through the
// same path; it is registered by the job registry under ADVERSE_EVENTS_JOB, not run from here.
// A frozen balance (provider error `AssetFrozen`) is answered with `hold_frozen`, so a plan never
// keeps failing silently; any other failure is recorded as `action_failed` and the run goes on.

import type { Installment, ISODate, PlanGovernance, PolicyEvent, PolicyEventKind } from '../domain/types';
import type { Store } from '../store/Store';
import type { PolicyEngine } from './PolicyEngine';
import { GovernanceProviderError, dispatch, type GovernanceProvider } from './GovernanceProvider';
import { applyTransition, defaultGovernance, fundsAllowed, type AdverseAction } from './transitions';
import { evidenceHash } from './evidence';
import { REASONS } from './reasons';

/** Name the job registry uses for the daily run. */
export const ADVERSE_EVENTS_JOB = 'adverse-events-daily';

export interface AdverseDeps {
  store: Store;
  policy: PolicyEngine;
  provider: GovernanceProvider;
  today: ISODate;
}

export interface AdverseRunReport {
  today: ISODate;
  plansChecked: number;
  /** Plans skipped because their state does not move (defaulted, on hold, cancelled, completed). */
  plansSkipped: number;
  executed: PolicyEvent[];
  recorded: PolicyEvent[];
  failed: PolicyEvent[];
  /** USD cents across receipts, held balances and refunds, before and after the run. */
  conservation: { beforeCents: number; afterCents: number; ok: boolean };
}

export async function governanceOf(store: Store, planId: string): Promise<PlanGovernance> {
  return (await store.get('plan_governance', planId)) ?? defaultGovernance(planId);
}

async function nextSeq(store: Store): Promise<number> {
  const events = await store.all('policy_events');
  return events.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}

async function planRows(store: Store, planId: string): Promise<Installment[]> {
  return (await store.all('installments')).filter((i) => i.planId === planId).sort((a, b) => a.idx - b.idx);
}

/**
 * Funds the platform is accountable for, in USD cents: every receipt (paid out to the trust), every
 * held balance and every refund. Adverse transitions may move money between "held" and "refunded"
 * but must never change this total.
 */
export async function fundsTotalCents(store: Store): Promise<number> {
  const receipts = await store.all('receipts');
  const govs = await store.all('plan_governance');
  const paid = receipts.reduce((a, r) => a + Math.round(r.usdPaid * 100), 0);
  return paid + govs.reduce((a, g) => a + g.balanceCents + g.refundedCents, 0);
}

function eventId(planId: string, seq: number): string {
  return `pe-${planId}-${String(seq).padStart(5, '0')}`;
}

/** Runs one transition end to end. Throws the provider's error after recording nothing. */
export async function performAdverseAction(
  deps: Omit<AdverseDeps, 'policy'>,
  action: AdverseAction,
  meta: { rule: string; detail?: string } = { rule: 'operator' },
): Promise<PolicyEvent> {
  const { store, provider, today } = deps;
  const gov = await governanceOf(store, action.planId);
  const rows = await planRows(store, action.planId);
  const result = applyTransition(gov, rows, action, today);
  const seq = await nextSeq(store);
  const record = {
    planId: action.planId,
    kind: result.kind,
    idx: result.idx,
    from: result.from,
    to: result.to,
    reasonCode: action.reasonCode,
    amountCents: result.amountCents,
    at: today,
    seq,
  };
  const evidence = evidenceHash(record);
  const { ref } = await dispatch(provider, action, evidence);
  await store.upsert('plan_governance', result.governance);
  if (result.changed.length > 0) await store.upsertMany('installments', result.changed);
  const event: PolicyEvent = {
    id: eventId(action.planId, seq),
    ...record,
    rule: meta.rule,
    policyStatus: 'pending',
    executed: true,
    evidence,
    ref,
    detail: meta.detail ?? null,
  };
  await store.upsert('policy_events', event);
  return event;
}

async function recordOnly(
  store: Store,
  today: ISODate,
  r: { id?: string; planId: string; kind: PolicyEventKind; idx: number | null; reasonCode: number; rule: string; detail: string | null },
): Promise<PolicyEvent> {
  const gov = await governanceOf(store, r.planId);
  const seq = await nextSeq(store);
  const record = { planId: r.planId, kind: r.kind, idx: r.idx, from: gov.state, to: gov.state, reasonCode: r.reasonCode, amountCents: null, at: today, seq };
  const event: PolicyEvent = {
    id: r.id ?? eventId(r.planId, seq),
    ...record,
    rule: r.rule,
    policyStatus: 'pending',
    executed: false,
    evidence: evidenceHash(record),
    ref: null,
    detail: r.detail,
  };
  await store.upsert('policy_events', event);
  return event;
}

/**
 * Asks the contract to record a frozen balance. On chain `hold_frozen` succeeds only when the
 * issuer has deauthorized the vault, the payee or the buyer, so `NotFrozen` (the normal answer) and
 * any other refusal mean "nothing to record" and return null.
 */
export async function tryHoldFrozen(deps: Omit<AdverseDeps, 'policy'>, planId: string, detail: string): Promise<PolicyEvent | null> {
  try {
    return await performAdverseAction(deps, { kind: 'hold_frozen', planId, reasonCode: REASONS.FUNDS_FROZEN.code }, { rule: 'B1-frozen-balance', detail });
  } catch {
    return null;
  }
}

/**
 * The daily adverse-events run: for every plan whose funds can still move, apply the policy's grace
 * and missed rules through the GovernanceProvider and record its notices. Idempotent per day: a
 * second run finds the installments already missed and the notices already recorded.
 */
export async function runAdverseEventsDaily(deps: AdverseDeps): Promise<AdverseRunReport> {
  const { store, policy, today } = deps;
  const beforeCents = await fundsTotalCents(store);
  const report: AdverseRunReport = {
    today,
    plansChecked: 0,
    plansSkipped: 0,
    executed: [],
    recorded: [],
    failed: [],
    conservation: { beforeCents, afterCents: beforeCents, ok: true },
  };
  const plans = await store.all('plans');
  for (const plan of plans) {
    const governance = await governanceOf(store, plan.id);
    if (!fundsAllowed(governance.state)) {
      report.plansSkipped += 1;
      continue;
    }
    report.plansChecked += 1;
    const held = await tryHoldFrozen(deps, plan.id, 'daily check');
    if (held) {
      report.executed.push(held);
      continue;
    }
    const recorded = new Set((await store.all('policy_events')).filter((e) => e.planId === plan.id && !e.executed).map((e) => e.id));
    const decisions = policy.evaluate({ plan, governance, installments: await planRows(store, plan.id), today, recorded });
    for (const d of decisions) {
      if (d.type === 'record') {
        report.recorded.push(await recordOnly(store, today, { id: d.recordId, planId: plan.id, kind: d.kind, idx: d.idx, reasonCode: d.reasonCode, rule: d.rule, detail: d.detail ?? null }));
        continue;
      }
      try {
        report.executed.push(await performAdverseAction(deps, d.action, { rule: d.rule, detail: d.detail }));
      } catch (e) {
        const name = e instanceof GovernanceProviderError ? e.errorName : e instanceof Error && 'errorName' in e ? String((e as { errorName: unknown }).errorName) : 'Unknown';
        report.failed.push(
          await recordOnly(store, today, {
            planId: plan.id,
            kind: 'action_failed',
            idx: 'idx' in d.action ? d.action.idx : null,
            reasonCode: d.action.reasonCode,
            rule: d.rule,
            detail: `${d.action.kind}: ${name}`,
          }),
        );
        if (name === 'AssetFrozen') {
          const hold = await tryHoldFrozen(deps, plan.id, `after ${d.action.kind}`);
          if (hold) report.executed.push(hold);
          break;
        }
      }
    }
  }
  const afterCents = await fundsTotalCents(store);
  report.conservation = { beforeCents, afterCents, ok: beforeCents === afterCents };
  return report;
}
