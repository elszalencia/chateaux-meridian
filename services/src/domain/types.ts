// Domain types shared by the lock engine, the adapters, the store and the web app.
// Design: statuses mirror the Soroban contract (`open | locked | released | broken`) so Stage 2 can
// map chain state 1:1; display states (Pagado, Bloqueado, Ofrecido, ...) are derived in views.ts.
// Dates are ISO strings (`YYYY-MM-DD` for calendar dates, full ISO for timestamps) so the same
// shapes serialize unchanged into localStorage today and into Supabase rows later.

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // ISO 8601 with time

export type Tenor = 'mensual' | 'trimestral';

/**
 * Contract-level installment status (contract spec). `missed` (unpaid past the grace period) and
 * `waived` (will never be collected) are the adverse-event states of schema version 2.
 */
export type InstallmentStatus = 'open' | 'locked' | 'released' | 'broken' | 'missed' | 'waived';

/** Plan-level state, mirroring the contract's `PlanState`. Funds move only in active and delinquent. */
export type PlanState = 'active' | 'delinquent' | 'defaulted' | 'on_hold' | 'cancelled' | 'completed';

/** Lock lifecycle. */
export type LockState = 'cotizado' | 'activo' | 'consumido' | 'cerrado' | 'vencido' | 'roto';

export type ReconStatus = 'conciliado' | 'pendiente' | 'diferencia';

export type HedgeLegState = 'pendiente' | 'reservada' | 'liquidada' | 'rota';

export type AnchorAuthMode = 'g_account' | 'sep45';

export interface Buyer {
  id: string;
  name: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  stellarAccount: string;
  anchorAuthMode: AnchorAuthMode;
}

export interface Unit {
  id: string;
  project: string;
  unitName: string;
  unitCode: string;
  address: string;
  city: string;
  department: string;
  housingType: 'VIS' | 'VIP/VIS' | 'No VIS';
  areaM2: number;
  bedrooms: number;
  priceCop: number;
  priceBasis: 'SMMLV' | 'fixed';
}

export interface Plan {
  id: string;
  buyerId: string;
  unitId: string;
  contractId: string | null;
  encargoRef: string;
  trustCompany: string;
  startDate: ISODate;
  installmentsCount: number;
  installmentCop: number;
  downPaymentCop: number;
  downPaymentPct: number;
  mortgageCop: number;
}

export interface Installment {
  id: string; // `${planId}:${idx}`
  planId: string;
  idx: number; // 0-based, as in the contract
  dueDate: ISODate;
  copDue: number;
  status: InstallmentStatus;
  lockId: string | null;
  lockedRate: number | null;
  usdDue: number | null; // USD, 2 decimals: set at lock, and at payment to the amount paid
  lockExpiry: ISODate | null; // due date + grace; after this an unpaid locked installment breaks
  releasedTx: string | null;
  releasedAt: ISODateTime | null;
  receiptId: string | null;
  breakCostCop: number | null; // set when the installment's lock broke
}

export interface Lock {
  id: string;
  planId: string;
  tenor: Tenor;
  idxs: number[];
  spot: number;
  fwdRates: number[];
  avgFwd: number;
  points: number;
  passThrough: number;
  lockedRate: number;
  usdPerInstallment: number[];
  quoteExpiresAt: ISODateTime | null;
  createdAt: ISODateTime;
  acceptedAt: ISODateTime | null;
  state: LockState;
  brokenIdx: number | null;
  breakCostCop: number | null;
  curveAsOf: ISODate;
}

export interface RenewalOffer {
  id: string;
  planId: string;
  tenor: Tenor;
  idxs: number[];
  offeredAt: ISODate;
  state: 'ofrecido' | 'aceptado' | 'descartado';
}

export interface HedgeLeg {
  id: string;
  lockId: string;
  planId: string;
  installmentIdx: number;
  dueDate: ISODate;
  usdNotional: number;
  lockedRate: number;
  fwdRate: number;
  tradeId: string | null;
  bookedAt: ISODateTime | null;
  settledCop: number | null;
  fixing: number | null;
  settledAt: ISODateTime | null;
  state: HedgeLegState;
}

export interface HedgeTrade {
  id: string; // = tradeId
  provider: string;
  dueDate: ISODate;
  usdNotional: number;
  rate: number;
  banrepRef: string;
  bookedAt: ISODateTime;
  settledCop: number | null;
  fixing: number | null;
}

export interface Receipt {
  id: string;
  planId: string;
  buyerId: string;
  installmentIdx: number;
  paidAt: ISODateTime;
  usdPaid: number;
  rateKind: 'locked' | 'spot';
  lockedRate: number | null;
  spotAtPayment: number;
  anchorRate: number;
  copDelivered: number; // COP credited to the encargo
  feeUsd: number;
  fxDeclarationRef: string;
  txHash: string;
  lockId: string | null;
  hedgeTradeId: string | null;
  anchorCop: number;
  ndfSettlementCop: number | null;
  basisCop: number;
  marginCop: number;
  copCredited: number;
  breakCostCop: number;
}

export interface CurvePoint {
  id: string;
  asOf: ISODate;
  tenor: 'spot' | '1M' | '2M' | '3M';
  date: ISODate;
  rate: number;
  source: string;
}

export interface DemoState {
  id: 'singleton';
  baseDate: ISODate;
  clockOffsetMonths: number;
  today: ISODate;
  passThrough: number; // 0..1
  errorMode: boolean;
  mode: 'mock' | 'testnet';
  curveAsOf: ISODate;
  lastResetMs: number | null;
  seedVersion: string;
  /** Testnet mode: demo plan id → `plan_id` on the payment_plan contract (set by the deploy script and by reset). */
  chainPlans?: Record<string, number>;
  /** Testnet mode: the contract these chain plan ids belong to; a persisted snapshot for another contract is discarded. */
  chainContractId?: string;
}

/**
 * Per-plan policy, mirroring the contract's `PolicyConfig`. Every value is a placeholder while the
 * business policy is pending (docs/ADVERSE_EVENTS.md). `graceDays` is the calendar-day floor the
 * contract enforces; the off-chain rule is the brief's 5 business days, which always meets it.
 */
export interface PolicyConfig {
  graceDays: number;
  missesBeforeDefault: number;
  penaltyBps: number;
  refundMode: 'full' | 'net_of_penalty';
}

/**
 * The plan's adverse-event record (`plan_governance`, one row per plan, id = plan id). Mirrors the
 * contract's `Governance`; `balanceCents` is USD held for the plan pending a decision (for example
 * a cancelled plan's deposits) and `refundedCents` what went back to the buyer. Payments are not
 * counted here: they are the receipts.
 */
export interface PlanGovernance {
  id: string;
  planId: string;
  state: PlanState;
  holdPrev: PlanState;
  misses: number;
  policy: PolicyConfig;
  /** Reason code of the last state change (services/src/policy/reasons.ts), null while untouched. */
  reasonCode: number | null;
  since: ISODate | null;
  balanceCents: number;
  refundedCents: number;
}

export type PolicyEventKind =
  | 'late_in_grace'
  | 'mark_missed'
  | 'cure'
  | 'waive'
  | 'default_eligible'
  | 'declare_default'
  | 'place_hold'
  | 'lift_hold'
  | 'hold_frozen'
  | 'cancel_plan'
  | 'refund'
  | 'complete_plan'
  | 'action_failed';

/**
 * One adverse-event record (`policy_events`), written for every transition and every notice.
 * `executed` is false for record-only events (notices, eligibility flags, failed actions);
 * `policyStatus` stays 'pending' until the business decides the rule that produced it.
 */
export interface PolicyEvent {
  id: string;
  /** Write order across all plans (the store has no insertion order). */
  seq: number;
  planId: string;
  at: ISODate;
  kind: PolicyEventKind;
  idx: number | null;
  from: PlanState;
  to: PlanState;
  reasonCode: number;
  rule: string;
  policyStatus: 'pending';
  executed: boolean;
  /** 64 hex characters: SHA-256 of the canonical record, sent on chain as the evidence hash. */
  evidence: string;
  amountCents: number | null;
  ref: string | null;
  detail: string | null;
}

export interface Tables {
  buyers: Buyer;
  units: Unit;
  plans: Plan;
  installments: Installment;
  locks: Lock;
  renewal_offers: RenewalOffer;
  hedge_legs: HedgeLeg;
  hedge_trades: HedgeTrade;
  receipts: Receipt;
  curves: CurvePoint;
  demo_state: DemoState;
  plan_governance: PlanGovernance;
  policy_events: PolicyEvent;
}

export type TableName = keyof Tables;

export type Snapshot = { [K in TableName]: Tables[K][] };

// ---------- View models (derived, never stored) ----------

export type CellState = 'pagado' | 'bloqueado' | 'ofrecido' | 'abierto' | 'roto' | 'no_pagado' | 'condonado';

/** What the buyer is told about an adverse state, in plain language (`comprador.notices.<kind>`). */
export type BuyerNoticeKind = 'late_in_grace' | 'missed' | 'on_hold' | 'defaulted' | 'cancelled';

export interface BuyerNotice {
  kind: BuyerNoticeKind;
  installmentNumber: number | null;
  dueDate: ISODate | null;
  /** Last day of the grace period, for `late_in_grace`. */
  graceEnds: ISODate | null;
  /** `reasons.<key>` in the dictionaries. */
  reasonKey: string;
  since: ISODate | null;
  /** USD held for the buyer (cancelled plans), for the refund notice. */
  heldUsd: number | null;
}

/** A policy event as the builder and the trust see it. */
export interface PolicyEventView extends PolicyEvent {
  reasonKey: string;
  installmentNumber: number | null;
}

/** The plan's adverse-event state for every view. */
export interface GovernanceView {
  state: PlanState;
  reasonCode: number | null;
  reasonKey: string;
  since: ISODate | null;
  misses: number;
  missedCount: number;
  waivedCount: number;
  policy: PolicyConfig;
  /** No deposits, locks or payments in this state (on hold, defaulted, cancelled, completed). */
  fundsBlocked: boolean;
  heldUsd: number;
  refundedUsd: number;
  notices: BuyerNotice[];
  /** Newest first. */
  events: PolicyEventView[];
}

export interface InstallmentView extends Installment {
  number: number; // 1-based (M1..M24)
  quarter: number; // 1-based (Q1..Q8)
  cellState: CellState;
  isDue: boolean; // today >= dueDate and unpaid
  isLate: boolean; // today > dueDate and unpaid
  daysLate: number;
  businessDaysLate: number;
  inGrace: boolean; // locked, late, within the grace window
  todayRate: number;
  usdAtToday: number; // copDue / todayRate
  usdShown: number; // usdDue if locked or paid, else usdAtToday
  diffCop: number; // usdShown * (lockedRate - todayRate); positive = lock in the buyer's favor
  payable: boolean; // the "Pagar" button applies
  offerId: string | null;
  lateInGrace: boolean; // unpaid, past due, still inside the 5-business-day grace period
}

export interface PlanSummary {
  nextInstallment: InstallmentView | null;
  nextUsd: number | null;
  nextCop: number | null;
  nextDueDate: ISODate | null;
  nextIsLocked: boolean;
  protectedCopThisYear: number;
  paidCount: number;
  lockedCount: number;
  remainingCop: number;
}

export interface PlanView {
  plan: Plan;
  buyer: Buyer;
  unit: Unit;
  installments: InstallmentView[];
  locks: Lock[];
  offers: RenewalOffer[];
  activeOffer: RenewalOffer | null;
  summary: PlanSummary;
  today: ISODate;
  spot: number;
  passThrough: number;
  governance: GovernanceView;
}

export interface LockQuote {
  lock: Lock;
  idxs: number[];
  installments: { idx: number; number: number; dueDate: ISODate; copDue: number; usdDue: number; usdAtSpot: number }[];
  usdPerInstallment: number;
  usdTotal: number;
  copTotal: number;
  usdAtSpotTotal: number;
  spot: number;
  lockedRate: number;
  quoteExpiresAt: ISODateTime;
  cutoffDate: ISODate;
  graceBusinessDays: number;
}

export type PayStep = 'recibido' | 'convertido' | 'entregado';

export interface ReconRow {
  id: string;
  planId: string;
  buyerName: string;
  project: string;
  unitLabel: string;
  encargoRef: string;
  trustCompany: string;
  installmentIdx: number;
  number: number;
  dueDate: ISODate;
  paidAt: ISODateTime;
  usdPaid: number;
  rateKind: 'locked' | 'spot';
  lockedRate: number | null;
  anchorRate: number;
  anchorCop: number;
  ndfSettlementCop: number | null;
  basisCop: number;
  marginCop: number;
  copCredited: number;
  status: ReconStatus;
  receiptId: string;
  txHash: string;
}

export interface UnitSummary {
  unit: Unit;
  plan: Plan;
  buyer: Buyer;
  paidCount: number;
  dueCount: number; // installments with dueDate <= today
  lockedCount: number;
  openCount: number;
  brokenCount: number;
  lateCount: number;
  paidCop: number;
  dueCop: number;
  nextDueDate: ISODate | null;
  missedCount: number;
  waivedCount: number;
  governance: GovernanceView;
}

export interface HedgeLegView extends HedgeLeg {
  buyerName: string;
  lockLabel: string;
  marginCop: number;
  breakCostCop: number;
}

export interface HedgeQuarterView {
  key: string; // e.g. 2027-T1
  label: string;
  legs: HedgeLegView[];
  lockedUsd: number;
  hedgedUsd: number;
  unhedgedUsd: number;
  trades: HedgeTrade[];
  marginSettledCop: number;
  marginBookedCop: number;
  breakCostCop: number;
}

export interface HedgeBookView {
  quarters: HedgeQuarterView[];
  curve: CurvePoint[];
  passThrough: number;
  today: ISODate;
  totals: {
    lockedUsd: number;
    hedgedUsd: number;
    unhedgedUsd: number;
    marginSettledCop: number;
    marginBookedCop: number;
    breakCostCop: number;
  };
  pendingLegCount: number;
}
