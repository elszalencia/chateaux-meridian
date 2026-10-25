// The daily adverse-events run on the mock seed: NullPolicy rules, provider calls, idempotency,
// the frozen-balance path, failure recording, operator actions, the buyer and builder view models,
// and funds conservation (no transition the policy layer runs may create or lose money).
import { describe, expect, it } from 'vitest';
import type { PolicyEvent } from '../domain/types';
import { MemoryStore } from '../store/MemoryStore';
import { BASE_DATE, PLAN_ANDRES, PLAN_CAMILA, PLAN_JORGE, PLAN_LUIS, PLAN_MARIA, PLAN_NATALIA, PLAN_PAOLA, buildSeed } from '../seed/fixtures';
import { createMockApi } from '../api/createMockApi';
import { buildUnitSummaries, governanceView } from '../api/views';
import { NullPolicy, RULES } from './NullPolicy';
import { GovernanceProviderError, MockGovernanceProvider, type GovernanceProvider } from './GovernanceProvider';
import { ADVERSE_EVENTS_JOB, fundsTotalCents, governanceOf, performAdverseAction, runAdverseEventsDaily } from './adverseEvents';
import { REASONS } from './reasons';

function setup(today: string, frozen: string[] = []) {
  const store = new MemoryStore(buildSeed());
  const provider = new MockGovernanceProvider({ store, today: () => today, frozenPlans: new Set(frozen) });
  return { store, provider, deps: { store, provider, policy: new NullPolicy(), today } };
}

/** Wraps a provider and counts the calls per method. */
function counting(inner: GovernanceProvider): { provider: GovernanceProvider; calls: string[] } {
  const calls: string[] = [];
  const provider = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { provider, calls };
}

const kinds = (es: PolicyEvent[]) => es.map((e) => `${e.planId}:${e.kind}:${e.idx ?? '-'}`);

describe('NullPolicy', () => {
  it('on the seed date: no new transitions, and Andrés M5 late notice already recorded', async () => {
    const { deps } = setup(BASE_DATE);
    const plans = await deps.store.all('plans');
    const andres = plans.find((p) => p.id === PLAN_ANDRES)!;
    const recorded = new Set((await deps.store.all('policy_events')).filter((e) => !e.executed).map((e) => e.id));
    const rows = (await deps.store.all('installments')).filter((i) => i.planId === PLAN_ANDRES);
    const d = deps.policy.evaluate({ plan: andres, governance: await governanceOf(deps.store, PLAN_ANDRES), installments: rows, today: BASE_DATE, recorded });
    // M3 broke in August and is unpaid: R2 asks to mark it missed. M5 (locked, in grace) is a notice already on file.
    expect(d.map((x) => (x.type === 'act' ? `${x.action.kind}:${'idx' in x.action ? x.action.idx : '-'}` : x.kind))).toEqual(['mark_missed:2']);
    expect(d.every((x) => x.policyStatus === 'pending')).toBe(true);
  });

  it('marks missed only beyond 5 business days, leaves locked rows to the break job, flags default for review', async () => {
    const { deps } = setup('2026-11-27');
    const luis = (await deps.store.all('plans')).find((p) => p.id === PLAN_LUIS)!;
    const rows = (await deps.store.all('installments')).filter((i) => i.planId === PLAN_LUIS);
    const g = { ...(await governanceOf(deps.store, PLAN_LUIS)), policy: { ...(await governanceOf(deps.store, PLAN_LUIS)).policy, missesBeforeDefault: 2 } };
    // M5 due 2026-10-20 is beyond grace; M6 due 2026-11-20 has 5 business days late on 11-27 → still in grace.
    const d = deps.policy.evaluate({ plan: luis, governance: g, installments: rows, today: '2026-11-27', recorded: new Set() });
    expect(d.map((x) => (x.type === 'act' ? `act:${x.action.kind}:${'idx' in x.action ? x.action.idx : '-'}` : `record:${x.kind}:${x.idx ?? '-'}`))).toEqual([
      'act:mark_missed:4',
      'record:late_in_grace:5',
      'record:default_eligible:-',
    ]);
    const locked = rows.map((r) => (r.idx === 4 ? { ...r, status: 'locked' as const } : r));
    const d2 = deps.policy.evaluate({ plan: luis, governance: g, installments: locked, today: '2026-11-27', recorded: new Set() });
    expect(d2.some((x) => x.type === 'act')).toBe(false);
  });

  it('never sizes a refund by itself', async () => {
    const { deps } = setup(BASE_DATE);
    const natalia = (await deps.store.all('plans')).find((p) => p.id === PLAN_NATALIA)!;
    const s = deps.policy.sizeRefund({ plan: natalia, governance: await governanceOf(deps.store, PLAN_NATALIA), installments: [], today: BASE_DATE, recorded: new Set() }, 200);
    expect(s).toMatchObject({ amountCents: null, rule: RULES.REFUND_MANUAL, policyStatus: 'pending' });
  });
});

describe('runAdverseEventsDaily', () => {
  it('is registered under adverse-events-daily', () => {
    expect(ADVERSE_EVENTS_JOB).toBe('adverse-events-daily');
  });

  it('applies the grace and missed rules through the provider and conserves funds', async () => {
    const { deps, provider } = setup('2026-11-27');
    const c = counting(provider);
    const report = await runAdverseEventsDaily({ ...deps, provider: c.provider });
    // Blocked plans (Paola on hold, Jorge defaulted, Natalia cancelled) are skipped.
    expect(report.plansSkipped).toBe(3);
    expect(report.plansChecked).toBe(4);
    // Andrés M3 (broke in August), Camila M3 (due 11-10) and Luis M5 (due 10-20) are beyond grace.
    expect(kinds(report.executed)).toEqual([`${PLAN_ANDRES}:mark_missed:2`, `${PLAN_CAMILA}:mark_missed:2`, `${PLAN_LUIS}:mark_missed:4`]);
    expect(report.executed.every((e) => e.executed && e.ref && /^[0-9a-f]{64}$/.test(e.evidence))).toBe(true);
    expect(c.calls.filter((m) => m === 'markMissed')).toHaveLength(3);
    // One frozen-balance check per checked plan, all answered NotFrozen.
    expect(c.calls.filter((m) => m === 'holdFrozen')).toHaveLength(4);
    expect(kinds(report.recorded)).toEqual(expect.arrayContaining([`${PLAN_MARIA}:late_in_grace:3`, `${PLAN_LUIS}:late_in_grace:5`]));
    expect(report.failed).toEqual([]);
    expect(report.conservation.ok).toBe(true);

    const luis = await governanceOf(deps.store, PLAN_LUIS);
    expect(luis).toMatchObject({ state: 'delinquent', misses: 2 });
    const andres = await governanceOf(deps.store, PLAN_ANDRES);
    expect(andres).toMatchObject({ state: 'delinquent', misses: 1, reasonCode: REASONS.GRACE_EXPIRED.code, since: '2026-11-27' });
    expect((await deps.store.get('installments', `${PLAN_ANDRES}:2`))!.status).toBe('missed');
  });

  it('is idempotent: a second run the same day changes nothing', async () => {
    const { deps } = setup('2026-11-27');
    await runAdverseEventsDaily(deps);
    const before = await deps.store.snapshot();
    const again = await runAdverseEventsDaily(deps);
    expect(again.executed).toEqual([]);
    expect(again.recorded).toEqual([]);
    expect(await deps.store.snapshot()).toEqual(before);
  });

  it('a frozen plan is put on hold (reason 304) instead of being worked on', async () => {
    const { deps } = setup('2026-11-27', [PLAN_LUIS]);
    const report = await runAdverseEventsDaily(deps);
    const hold = report.executed.find((e) => e.planId === PLAN_LUIS)!;
    expect(hold).toMatchObject({ kind: 'hold_frozen', from: 'delinquent', to: 'on_hold', reasonCode: 304, rule: 'B1-frozen-balance' });
    expect(report.executed.filter((e) => e.planId === PLAN_LUIS)).toHaveLength(1);
    expect((await governanceOf(deps.store, PLAN_LUIS)).holdPrev).toBe('delinquent');
    expect(report.conservation.ok).toBe(true);
  });

  it('records a refused action as action_failed and keeps going', async () => {
    const { deps, provider } = setup('2026-11-27');
    const failing: GovernanceProvider = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      markMissed: async () => {
        throw new GovernanceProviderError('TxFailed', 'rpc timeout');
      },
    });
    const report = await runAdverseEventsDaily({ ...deps, provider: failing });
    expect(report.executed).toEqual([]);
    expect(report.failed.map((e) => `${e.planId}:${e.detail}`)).toEqual([
      `${PLAN_ANDRES}:mark_missed: TxFailed`,
      `${PLAN_CAMILA}:mark_missed: TxFailed`,
      `${PLAN_LUIS}:mark_missed: TxFailed`,
    ]);
    expect(report.failed.every((e) => !e.executed && e.kind === 'action_failed')).toBe(true);
    expect((await governanceOf(deps.store, PLAN_LUIS)).state).toBe('delinquent');
    expect((await governanceOf(deps.store, PLAN_LUIS)).misses).toBe(1);
  });
});

describe('operator actions and funds conservation', () => {
  it('cancellation, refund in two parts and the frozen refund keep the totals', async () => {
    const { deps, provider } = setup(BASE_DATE);
    const total0 = await fundsTotalCents(deps.store);
    const held = (await governanceOf(deps.store, PLAN_NATALIA)).balanceCents;
    expect(held).toBeGreaterThan(0);
    // Frozen: the refund is refused with AssetFrozen and nothing is written.
    provider.frozenPlans.add(PLAN_NATALIA);
    await expect(performAdverseAction(deps, { kind: 'refund', planId: PLAN_NATALIA, amountCents: 100, reasonCode: 400 })).rejects.toMatchObject({ errorName: 'AssetFrozen' });
    expect((await governanceOf(deps.store, PLAN_NATALIA)).balanceCents).toBe(held);
    provider.frozenPlans.delete(PLAN_NATALIA);
    const first = await performAdverseAction(deps, { kind: 'refund', planId: PLAN_NATALIA, amountCents: 10_000, reasonCode: 400 }, { rule: 'operator', detail: 'first part' });
    expect(first).toMatchObject({ kind: 'refund', amountCents: 10_000, executed: true });
    await performAdverseAction(deps, { kind: 'refund', planId: PLAN_NATALIA, amountCents: held - 10_000, reasonCode: 400 });
    await expect(performAdverseAction(deps, { kind: 'refund', planId: PLAN_NATALIA, amountCents: 1, reasonCode: 400 })).rejects.toMatchObject({ errorName: 'InsufficientBalance' });
    expect(await governanceOf(deps.store, PLAN_NATALIA)).toMatchObject({ balanceCents: 0, refundedCents: held });
    expect(await fundsTotalCents(deps.store)).toBe(total0);
  });

  it('every operator transition runs through the provider, writes one event and conserves funds', async () => {
    const { deps } = setup('2026-11-27');
    const total0 = await fundsTotalCents(deps.store);
    const run = (a: Parameters<typeof performAdverseAction>[1]) => performAdverseAction(deps, a);
    await run({ kind: 'cure', planId: PLAN_LUIS, idx: 3, reasonCode: REASONS.PAID_LATE.code });
    expect((await governanceOf(deps.store, PLAN_LUIS)).state).toBe('active');
    await run({ kind: 'mark_missed', planId: PLAN_LUIS, idx: 3, reasonCode: 100 });
    await run({ kind: 'mark_missed', planId: PLAN_LUIS, idx: 4, reasonCode: 100 });
    await expect(run({ kind: 'declare_default', planId: PLAN_LUIS, reasonCode: 110 })).rejects.toMatchObject({ errorName: 'DefaultNotReached' });
    await run({ kind: 'waive', planId: PLAN_LUIS, idx: 4, reasonCode: 102 });
    await run({ kind: 'place_hold', planId: PLAN_LUIS, reasonCode: REASONS.DISPUTED_PAYMENT.code });
    await run({ kind: 'lift_hold', planId: PLAN_LUIS, reasonCode: REASONS.HOLD_CLEARED.code });
    await run({ kind: 'lift_hold', planId: PLAN_PAOLA, reasonCode: REASONS.HOLD_CLEARED.code });
    await run({ kind: 'cancel_plan', planId: PLAN_JORGE, reasonCode: REASONS.PROJECT_CANCELLED.code });
    const g = await governanceOf(deps.store, PLAN_LUIS);
    expect(g).toMatchObject({ state: 'delinquent', misses: 1 });
    expect((await governanceOf(deps.store, PLAN_PAOLA)).state).toBe('active');
    expect((await governanceOf(deps.store, PLAN_JORGE)).state).toBe('cancelled');
    const events = (await deps.store.all('policy_events')).filter((e) => e.executed && e.at === '2026-11-27');
    expect(events.map((e) => e.kind)).toEqual(['cure', 'mark_missed', 'mark_missed', 'waive', 'place_hold', 'lift_hold', 'lift_hold', 'cancel_plan']);
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
    expect(await fundsTotalCents(deps.store)).toBe(total0);
  });
});

describe('view models', () => {
  it('buyer notices: late in grace, missed, on hold, defaulted, cancelled with held money', async () => {
    const s = buildSeed();
    const view = (planId: string) =>
      governanceView({ planId, gov: s.plan_governance.find((g) => g.planId === planId), installments: s.installments, events: s.policy_events, today: BASE_DATE });
    expect(view(PLAN_ANDRES).notices.map((n) => `${n.kind}:${n.installmentNumber}`)).toEqual(['late_in_grace:5']);
    expect(view(PLAN_ANDRES).notices[0]!.graceEnds).toBe('2026-10-22');
    expect(view(PLAN_LUIS)).toMatchObject({ state: 'delinquent', reasonKey: 'graceExpired', missedCount: 1, waivedCount: 1, fundsBlocked: false });
    expect(view(PLAN_LUIS).notices.map((n) => n.kind)).toEqual(['missed']);
    expect(view(PLAN_PAOLA)).toMatchObject({ state: 'on_hold', reasonKey: 'kycReview', fundsBlocked: true });
    expect(view(PLAN_PAOLA).notices.map((n) => n.kind)).toEqual(['on_hold']);
    expect(view(PLAN_JORGE).notices.map((n) => n.kind)).toEqual(['defaulted']);
    const nat = view(PLAN_NATALIA);
    expect(nat.notices[0]).toMatchObject({ kind: 'cancelled', reasonKey: 'buyerWithdrawal' });
    // M6 of a Trifonte plan (COP 2,562,500) deposited at 3,431.2 and held since the withdrawal.
    expect(nat.notices[0]!.heldUsd).toBe(746.83);
    expect(view(PLAN_MARIA)).toMatchObject({ state: 'active', notices: [], fundsBlocked: false });
    expect(view(PLAN_JORGE).events[0]).toMatchObject({ kind: 'declare_default', reasonKey: 'repeatedMisses' });
  });

  it('builder summaries carry state, reasons, missed and waived counts', () => {
    const s = buildSeed();
    const units = buildUnitSummaries({ ...s, today: BASE_DATE, governance: s.plan_governance, events: s.policy_events });
    const by = (id: string) => units.find((u) => u.plan.id === id)!;
    expect(units).toHaveLength(7);
    expect(by(PLAN_LUIS)).toMatchObject({ missedCount: 1, waivedCount: 1 });
    expect(by(PLAN_LUIS).governance.state).toBe('delinquent');
    expect(by(PLAN_JORGE).governance.state).toBe('defaulted');
    expect(by(PLAN_NATALIA).governance.state).toBe('cancelled');
    expect(by(PLAN_PAOLA).governance.state).toBe('on_hold');
  });

  it('the API blocks payments and locks on blocked plans and missed installments', async () => {
    const api = createMockApi({ minDelayMs: 0, maxDelayMs: 0 });
    const paola = await api.getPlan(PLAN_PAOLA);
    expect(paola.governance.state).toBe('on_hold');
    expect(paola.installments.some((i) => i.payable)).toBe(false);
    await expect(api.pay(PLAN_PAOLA, 3)).rejects.toMatchObject({ code: 'PLAN_BLOCKED' });
    await expect(api.quoteLock(PLAN_NATALIA, 'trimestral')).rejects.toMatchObject({ code: 'PLAN_BLOCKED' });
    await expect(api.pay(PLAN_LUIS, 3)).rejects.toMatchObject({ code: 'INSTALLMENT_MISSED' });
    const luis = await api.getPlan(PLAN_LUIS);
    expect(luis.installments[3]).toMatchObject({ cellState: 'no_pagado', payable: false });
    expect(luis.installments[2]).toMatchObject({ cellState: 'condonado', payable: false });
    expect(luis.summary.nextInstallment!.number).toBe(4);
  });
});
