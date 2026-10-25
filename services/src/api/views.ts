// Pure view builders: turn stored rows plus "today" into what each screen renders. Keeping them
// outside the API class makes them unit-testable and reusable by the Supabase-backed API later.
// Adverse events: `governanceView` folds the plan's governance row and policy events into what the
// builder sees (state, reason, history) and what the buyer is told (`notices`, plain language, no
// blame). A plan whose funds are blocked shows nothing payable.

import type {
  Buyer,
  BuyerNotice,
  GovernanceView,
  HedgeBookView,
  HedgeLeg,
  HedgeLegView,
  HedgeQuarterView,
  HedgeTrade,
  Installment,
  InstallmentView,
  ISODate,
  Lock,
  Plan,
  PlanGovernance,
  PlanSummary,
  PlanView,
  PolicyEvent,
  PolicyEventView,
  Receipt,
  ReconRow,
  ReconStatus,
  RenewalOffer,
  Unit,
  UnitSummary,
  CurvePoint,
} from '../domain/types';
import { compareISO, diffDays, quarterKey, yearOf } from '../domain/dates';
import { GRACE_BUSINESS_DAYS, businessDaysLate, graceEndDate, isBeyondGrace, roundCop, roundUsd, usdDue } from '../lock/engine';
import { defaultGovernance, fundsAllowed } from '../policy/transitions';
import { reasonInfo } from '../policy/reasons';

/** Statuses that still owe money: everything except paid and waived. */
function owes(i: Installment): boolean {
  return i.status !== 'released' && i.status !== 'waived';
}

export const RECON_ROUNDING_TOLERANCE_COP = 50;
export const RECON_BASIS_TOLERANCE_COP = 1000;

export function installmentView(
  i: Installment,
  today: ISODate,
  spot: number,
  offers: RenewalOffer[],
): InstallmentView {
  const unpaid = owes(i);
  const isDue = unpaid && compareISO(today, i.dueDate) >= 0;
  const isLate = unpaid && compareISO(today, i.dueDate) > 0;
  const daysLate = isLate ? diffDays(i.dueDate, today) : 0;
  const bizLate = isLate ? businessDaysLate(today, i.dueDate) : 0;
  const offer = i.status === 'open' ? offers.find((o) => o.state === 'ofrecido' && o.planId === i.planId && o.idxs.includes(i.idx)) ?? null : null;
  const cellState: InstallmentView['cellState'] =
    i.status === 'released'
      ? 'pagado'
      : i.status === 'locked'
        ? 'bloqueado'
        : i.status === 'broken'
          ? 'roto'
          : i.status === 'missed'
            ? 'no_pagado'
            : i.status === 'waived'
              ? 'condonado'
              : offer
                ? 'ofrecido'
                : 'abierto';
  const usdAtToday = roundUsd(usdDue(i.copDue, spot));
  // Locked cells show the guaranteed amount, paid cells the amount actually paid, open cells today's rate.
  const usdShown = (i.status === 'locked' || i.status === 'released') && i.usdDue != null ? i.usdDue : usdAtToday;
  const diffCop = i.status === 'locked' && i.lockedRate != null ? roundCop(usdShown * (i.lockedRate - spot)) : 0;
  return {
    ...i,
    number: i.idx + 1,
    quarter: Math.floor(i.idx / 3) + 1,
    cellState,
    isDue,
    isLate,
    daysLate,
    businessDaysLate: bizLate,
    inGrace: i.status === 'locked' && isLate && bizLate <= GRACE_BUSINESS_DAYS,
    todayRate: spot,
    usdAtToday,
    usdShown,
    diffCop,
    // A missed installment is paid once it is cured (contract rule), so it is not payable here.
    payable: unpaid && isDue && i.status !== 'missed',
    offerId: offer?.id ?? null,
    lateInGrace: isLate && i.status !== 'missed' && !isBeyondGrace(today, i.dueDate),
  };
}

export function planSummary(installments: InstallmentView[], today: ISODate): PlanSummary {
  const unpaid = installments.filter(owes).sort((a, b) => a.idx - b.idx);
  const next = unpaid[0] ?? null;
  const year = yearOf(today);
  const protectedCopThisYear = installments
    .filter((i) => yearOf(i.dueDate) === year && (i.status === 'locked' || (i.status === 'released' && i.lockId && i.lockedRate != null)))
    .reduce((a, i) => a + i.copDue, 0);
  return {
    nextInstallment: next,
    nextUsd: next ? next.usdShown : null,
    nextCop: next ? next.copDue : null,
    nextDueDate: next ? next.dueDate : null,
    nextIsLocked: next?.status === 'locked',
    protectedCopThisYear,
    paidCount: installments.filter((i) => i.status === 'released').length,
    lockedCount: installments.filter((i) => i.status === 'locked').length,
    remainingCop: unpaid.reduce((a, i) => a + i.copDue, 0),
  };
}

export function policyEventView(e: PolicyEvent): PolicyEventView {
  return { ...e, reasonKey: reasonInfo(e.reasonCode).key, installmentNumber: e.idx == null ? null : e.idx + 1 };
}

/**
 * The plan's adverse-event state. `gov` may be missing (plans written before schema version 2, or a
 * store seeded before governance existed): the plan is then active under the default policy.
 */
export function governanceView(args: { planId: string; gov?: PlanGovernance; installments: Installment[]; events?: PolicyEvent[]; today: ISODate }): GovernanceView {
  const gov = args.gov ?? defaultGovernance(args.planId);
  const rows = args.installments.filter((i) => i.planId === args.planId).sort((a, b) => a.idx - b.idx);
  const reasonKey = reasonInfo(gov.reasonCode).key;
  const heldUsd = gov.balanceCents / 100;
  const notices: BuyerNotice[] = [];
  const planNotice = (kind: BuyerNotice['kind']) =>
    notices.push({ kind, installmentNumber: null, dueDate: null, graceEnds: null, reasonKey, since: gov.since, heldUsd: kind === 'cancelled' && heldUsd > 0 ? heldUsd : null });
  if (gov.state === 'on_hold') planNotice('on_hold');
  if (gov.state === 'defaulted') planNotice('defaulted');
  if (gov.state === 'cancelled') planNotice('cancelled');
  if (gov.state === 'active' || gov.state === 'delinquent' || gov.state === 'on_hold') {
    for (const i of rows) {
      if (i.status === 'missed') {
        notices.push({ kind: 'missed', installmentNumber: i.idx + 1, dueDate: i.dueDate, graceEnds: null, reasonKey: reasonInfo(100).key, since: null, heldUsd: null });
      } else if (owes(i) && compareISO(args.today, i.dueDate) > 0 && !isBeyondGrace(args.today, i.dueDate)) {
        notices.push({ kind: 'late_in_grace', installmentNumber: i.idx + 1, dueDate: i.dueDate, graceEnds: graceEndDate(i.dueDate), reasonKey: 'none', since: null, heldUsd: null });
      }
    }
  }
  const events = (args.events ?? [])
    .filter((e) => e.planId === args.planId)
    .sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq)
    .map(policyEventView);
  return {
    state: gov.state,
    reasonCode: gov.reasonCode,
    reasonKey,
    since: gov.since,
    misses: gov.misses,
    missedCount: rows.filter((i) => i.status === 'missed').length,
    waivedCount: rows.filter((i) => i.status === 'waived').length,
    policy: gov.policy,
    fundsBlocked: !fundsAllowed(gov.state),
    heldUsd,
    refundedUsd: gov.refundedCents / 100,
    notices,
    events,
  };
}

export function buildPlanView(args: {
  plan: Plan;
  buyer: Buyer;
  unit: Unit;
  installments: Installment[];
  locks: Lock[];
  offers: RenewalOffer[];
  today: ISODate;
  spot: number;
  passThrough: number;
  governance?: PlanGovernance;
  events?: PolicyEvent[];
}): PlanView {
  const governance = governanceView({ planId: args.plan.id, gov: args.governance, installments: args.installments, events: args.events, today: args.today });
  const rows = args.installments
    .filter((i) => i.planId === args.plan.id)
    .sort((a, b) => a.idx - b.idx)
    .map((i) => installmentView(i, args.today, args.spot, args.offers))
    .map((i) => (governance.fundsBlocked ? { ...i, payable: false } : i));
  const offers = args.offers.filter((o) => o.planId === args.plan.id);
  return {
    plan: args.plan,
    buyer: args.buyer,
    unit: args.unit,
    installments: rows,
    locks: args.locks.filter((l) => l.planId === args.plan.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    offers,
    activeOffer: offers.find((o) => o.state === 'ofrecido' && o.idxs.every((i) => rows.find((r) => r.idx === i)?.status === 'open')) ?? null,
    summary: planSummary(rows, args.today),
    today: args.today,
    spot: args.spot,
    passThrough: args.passThrough,
    governance,
  };
}

export function reconStatus(r: Receipt): ReconStatus {
  if (r.rateKind === 'spot') return 'conciliado';
  if (r.ndfSettlementCop == null) return 'pendiente';
  if (Math.abs(r.basisCop) > RECON_BASIS_TOLERANCE_COP) return 'diferencia';
  const rounding = r.anchorCop + r.ndfSettlementCop - r.basisCop - r.marginCop - r.copCredited;
  return Math.abs(rounding) <= RECON_ROUNDING_TOLERANCE_COP ? 'conciliado' : 'diferencia';
}

export function buildReconRows(args: {
  receipts: Receipt[];
  plans: Plan[];
  buyers: Buyer[];
  units: Unit[];
  installments: Installment[];
}): ReconRow[] {
  const plan = (id: string) => args.plans.find((p) => p.id === id)!;
  return args.receipts
    .map((r) => {
      const p = plan(r.planId);
      const buyer = args.buyers.find((b) => b.id === p.buyerId)!;
      const unit = args.units.find((u) => u.id === p.unitId)!;
      const inst = args.installments.find((i) => i.planId === r.planId && i.idx === r.installmentIdx)!;
      return {
        id: r.id,
        planId: r.planId,
        buyerName: buyer.name,
        project: unit.project,
        unitLabel: `${unit.unitName} ${unit.unitCode}`,
        encargoRef: p.encargoRef,
        trustCompany: p.trustCompany,
        installmentIdx: r.installmentIdx,
        number: r.installmentIdx + 1,
        dueDate: inst.dueDate,
        paidAt: r.paidAt,
        usdPaid: r.usdPaid,
        rateKind: r.rateKind,
        lockedRate: r.lockedRate,
        anchorRate: r.anchorRate,
        anchorCop: r.anchorCop,
        ndfSettlementCop: r.ndfSettlementCop,
        basisCop: r.basisCop,
        marginCop: r.marginCop,
        copCredited: r.copCredited,
        status: reconStatus(r),
        receiptId: r.id,
        txHash: r.txHash,
      } satisfies ReconRow;
    })
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
}

export function buildUnitSummaries(args: {
  plans: Plan[];
  buyers: Buyer[];
  units: Unit[];
  installments: Installment[];
  today: ISODate;
  governance?: PlanGovernance[];
  events?: PolicyEvent[];
}): UnitSummary[] {
  return args.plans.map((plan) => {
    const rows = args.installments.filter((i) => i.planId === plan.id);
    const unpaidLate = rows.filter((i) => owes(i) && compareISO(args.today, i.dueDate) > 0);
    const due = rows.filter((i) => compareISO(i.dueDate, args.today) <= 0);
    const nextUnpaid = rows.filter(owes).sort((a, b) => a.idx - b.idx)[0];
    return {
      unit: args.units.find((u) => u.id === plan.unitId)!,
      plan,
      buyer: args.buyers.find((b) => b.id === plan.buyerId)!,
      paidCount: rows.filter((i) => i.status === 'released').length,
      dueCount: due.length,
      lockedCount: rows.filter((i) => i.status === 'locked').length,
      openCount: rows.filter((i) => i.status === 'open').length,
      brokenCount: rows.filter((i) => i.status === 'broken').length,
      lateCount: unpaidLate.length,
      paidCop: rows.filter((i) => i.status === 'released').reduce((a, i) => a + i.copDue, 0),
      dueCop: due.reduce((a, i) => a + i.copDue, 0),
      nextDueDate: nextUnpaid?.dueDate ?? null,
      missedCount: rows.filter((i) => i.status === 'missed').length,
      waivedCount: rows.filter((i) => i.status === 'waived').length,
      governance: governanceView({
        planId: plan.id,
        gov: args.governance?.find((g) => g.planId === plan.id),
        installments: rows,
        events: args.events,
        today: args.today,
      }),
    };
  });
}

const QUARTER_MONTHS = ['ene–mar', 'abr–jun', 'jul–sep', 'oct–dic'];

export function buildHedgeBook(args: {
  legs: HedgeLeg[];
  trades: HedgeTrade[];
  locks: Lock[];
  plans: Plan[];
  buyers: Buyer[];
  curve: CurvePoint[];
  passThrough: number;
  today: ISODate;
}): HedgeBookView {
  const byQuarter = new Map<string, HedgeLegView[]>();
  for (const leg of args.legs) {
    const lock = args.locks.find((l) => l.id === leg.lockId);
    const plan = args.plans.find((p) => p.id === leg.planId);
    const buyer = plan ? args.buyers.find((b) => b.id === plan.buyerId) : undefined;
    const first = lock ? Math.floor(lock.idxs[0]! / 3) + 1 : 0;
    const lockLabel = lock ? (lock.tenor === 'trimestral' ? `Q${first} (M${lock.idxs[0]! + 1}–M${lock.idxs[lock.idxs.length - 1]! + 1})` : `M${lock.idxs[0]! + 1}`) : leg.lockId;
    const view: HedgeLegView = {
      ...leg,
      buyerName: buyer?.name ?? leg.planId,
      lockLabel,
      marginCop: leg.state === 'rota' ? 0 : roundCop(leg.usdNotional * (leg.fwdRate - leg.lockedRate)),
      breakCostCop: leg.state === 'rota' ? lock?.breakCostCop ?? 0 : 0,
    };
    const key = quarterKey(leg.dueDate);
    if (!byQuarter.has(key)) byQuarter.set(key, []);
    byQuarter.get(key)!.push(view);
  }
  const quarters: HedgeQuarterView[] = [...byQuarter.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, legs]) => {
      legs.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.buyerName.localeCompare(b.buyerName));
      const q = Number(key.slice(-1));
      const label = `${key.slice(0, 4)} · T${q} (${QUARTER_MONTHS[q - 1]})`;
      const tradeIds = new Set(legs.map((l) => l.tradeId).filter(Boolean));
      const hedged = legs.filter((l) => l.tradeId && l.state !== 'rota');
      const unhedged = legs.filter((l) => !l.tradeId);
      const lockedUsd = legs.filter((l) => l.state !== 'rota').reduce((a, l) => a + l.usdNotional, 0);
      return {
        key,
        label,
        legs,
        lockedUsd,
        hedgedUsd: hedged.reduce((a, l) => a + l.usdNotional, 0),
        unhedgedUsd: unhedged.reduce((a, l) => a + l.usdNotional, 0),
        trades: args.trades.filter((t) => tradeIds.has(t.id)),
        marginSettledCop: roundCop(legs.filter((l) => l.state === 'liquidada').reduce((a, l) => a + l.usdNotional * (l.fwdRate - l.lockedRate), 0)),
        marginBookedCop: roundCop(legs.filter((l) => l.state === 'reservada').reduce((a, l) => a + l.usdNotional * (l.fwdRate - l.lockedRate), 0)),
        breakCostCop: legs.reduce((a, l) => a + l.breakCostCop, 0),
      };
    });
  const totals = quarters.reduce(
    (t, q) => ({
      lockedUsd: t.lockedUsd + q.lockedUsd,
      hedgedUsd: t.hedgedUsd + q.hedgedUsd,
      unhedgedUsd: t.unhedgedUsd + q.unhedgedUsd,
      marginSettledCop: t.marginSettledCop + q.marginSettledCop,
      marginBookedCop: t.marginBookedCop + q.marginBookedCop,
      breakCostCop: t.breakCostCop + q.breakCostCop,
    }),
    { lockedUsd: 0, hedgedUsd: 0, unhedgedUsd: 0, marginSettledCop: 0, marginBookedCop: 0, breakCostCop: 0 },
  );
  return {
    quarters,
    curve: args.curve,
    passThrough: args.passThrough,
    today: args.today,
    totals,
    pendingLegCount: args.legs.filter((l) => l.state === 'pendiente').length,
  };
}
