// Domain types shared by the lock engine, the adapters, the store and the web app.
// Design: statuses mirror the Soroban contract (`open | locked | released | broken`) so Stage 2 can
// map chain state 1:1; display states (Pagado, Bloqueado, Ofrecido, ...) are derived in views.ts.
// Dates are ISO strings (`YYYY-MM-DD` for calendar dates, full ISO for timestamps) so the same
// shapes serialize unchanged into localStorage today and into Supabase rows later.

import type { CorridorId, PayMethod, PayoutOption, WhatsAppTemplate } from '../../../config/corridors';

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // ISO 8601 with time

export type { CorridorId, PayMethod, PayoutOption, WhatsAppTemplate };

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
  /** Language of the buyer's messages (WhatsApp templates); Spanish when absent. */
  lang?: 'es' | 'en';
  /** Office or agency nearest to the buyer (offices.id), shown on the counter pay option. */
  officeId?: string | null;
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

/**
 * A payment plan. Amount fields keep their historical names and hold the corridor's minor unit:
 * whole pesos in Colombia, US cents in El Salvador (config/corridors.ts `decimals`).
 * `corridor` is absent on rows written before corridors existed, which means Colombia.
 */
export interface Plan {
  id: string;
  buyerId: string;
  unitId: string;
  contractId: string | null;
  /** Colombia: the buyer's encargo at the trust. El Salvador: the plan reference printed on receipts. */
  encargoRef: string;
  /** Colombia: the trust company. El Salvador: the seller's trade name (payout target label comes from config). */
  trustCompany: string;
  startDate: ISODate;
  installmentsCount: number;
  installmentCop: number;
  downPaymentCop: number;
  downPaymentPct: number;
  mortgageCop: number;
  corridor?: CorridorId;
  /** The verified seller the releases go to (sellers.id); null for Colombia, where the payee is the trust. */
  sellerId?: string | null;
  /** The seller's payout option at plan creation (A: hold USDC, B: USD to bank). */
  payoutOption?: PayoutOption | null;
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
  /**
   * El Salvador: the installment was paid (deposited) before its due date and waits for the
   * release on that date. Set with the payment id; cleared when the release runs.
   */
  fundedAt?: ISODateTime | null;
  fundedPaymentId?: string | null;
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
  /** How the buyer paid (El Salvador receipts; Colombia receipts carry `ach`, absent on older rows). */
  method?: PayMethod;
  /** El Salvador: USD delivered to the seller after the fee (usdPaid − feeUsd). */
  usdDelivered?: number;
  /** El Salvador: the payout this receipt settled through (payouts.id). */
  payoutId?: string | null;
  /** The payment row (payments.id) this receipt closes, when the buyer paid through one. */
  paymentId?: string | null;
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
  /** Testnet mode: the contract instance of each corridor (`chainContractId` is the Colombia one). */
  chainContractIds?: Partial<Record<CorridorId, string>>;
  /**
   * Testnet mode: plans the last reset could not create on chain (the network refused the fee),
   * keyed by demo plan id, with the logged reason. They run off chain, as in mock mode; office
   * screens may mark them "simulado". Absent when every plan was created.
   */
  simulatedPlans?: Record<string, string>;
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

// ---------- El Salvador corridor: payments, sellers, offices, payouts, messages ----------

export type PaymentStatus = 'pending' | 'completed' | 'quote_expired' | 'blocked' | 'error' | 'cancelled';

export type Tender = 'cash' | 'card';

export type PaymentBlockReason = 'above_limit' | 'below_limit' | 'state_excluded' | 'method_not_offered' | 'plan_blocked';

/**
 * One buyer payment attempt (`payments`). Amounts are in the plan's minor unit (US cents in El
 * Salvador). A MoneyGram reference is a `pending` row that becomes `completed` only when the
 * network reports the cash-in; the plan is credited at that moment, never before.
 */
export interface Payment {
  id: string;
  planId: string;
  idx: number;
  method: PayMethod;
  amount: number;
  fee: number;
  status: PaymentStatus;
  /** MoneyGram reference number, ACH trace, or the counter ticket. */
  externalRef: string | null;
  officeId: string | null;
  cashierId: string | null;
  tender: Tender | null;
  /** Counter: cash handed over and change returned, minor units. */
  amountReceived: number | null;
  changeDue: number | null;
  createdAt: ISODateTime;
  /** MoneyGram: when the reference stops being payable. */
  expiresAt: ISODateTime | null;
  receivedAt: ISODateTime | null;
  blockedReason: PaymentBlockReason | null;
  receiptId: string | null;
}

export type SellerTier = 1 | 2;

export type SellerVerificationStatus = 'pending' | 'verified' | 'paused' | 'rejected';

export interface PayoutAccount {
  /** `bank`: USD account at a Salvadoran bank (option B). `provider_address`: the custody provider's address (option A). */
  kind: 'bank' | 'provider_address';
  /** Institution or provider name. */
  institution: string;
  /** Account holder as the bank reports it (name match check). */
  holder: string;
  /** Masked account number or the provider reference; never a raw address on buyer screens. */
  ref: string;
}

export interface Seller {
  id: string;
  corridor: CorridorId;
  tier: SellerTier;
  legalName: string;
  tradeName: string;
  taxId: string;
  legalRepresentative: string;
  /** Bank that confirmed a Tier 1 seller, or the seller's traditional bank for Tier 2. */
  bank: string;
  verificationStatus: SellerVerificationStatus;
  verifiedAt: ISODateTime | null;
  payoutOption: PayoutOption;
  /** Null until the seller is verified: no payout address exists before that. */
  payoutAccount: PayoutAccount | null;
  /** A requested account change waits here until `payoutChangePendingUntil` and re-verification. */
  pendingPayoutAccount: PayoutAccount | null;
  payoutChangePendingUntil: ISODateTime | null;
  kybRef: string | null;
  /** Count of releases paid out so far (for "0 plans released" on pending sellers). */
  releasesCount: number;
  notes: string | null;
  simulated: true;
}

export type CnrAlertStatus = 'none' | 'lien_registered' | 'cleared';

/** Title check per unit (Centro Nacional de Registros, simulated). */
export interface SellerUnit {
  id: string;
  sellerId: string;
  unitId: string;
  cnrRegistryNo: string;
  cnrCertDate: ISODate;
  /** SHA-256 of the certificate file, hex. */
  cnrCertHash: string;
  alertStatus: CnrAlertStatus;
  alertAt: ISODateTime | null;
  alertDetail: string | null;
}

export interface Office {
  id: string;
  corridor: CorridorId;
  name: string;
  address: string;
  city: string;
  state: string;
  hours: string;
  phone: string;
  isLicensedAgency: boolean;
  simulated: boolean;
}

export type PayoutStatus = 'enviado' | 'en_transito' | 'acreditado' | 'error' | 'transferido' | 'retenido';

/** One release paid out to a seller (`payouts`). USD amounts with two decimals. */
export interface Payout {
  id: string;
  planId: string;
  idx: number;
  sellerId: string;
  option: PayoutOption;
  status: PayoutStatus;
  usdPaid: number;
  feeUsd: number;
  /** usdPaid − feeUsd: the reconciliation line. */
  usdToSeller: number;
  partnerRef: string | null;
  /** The release transaction. */
  releaseTx: string | null;
  sentAt: ISODateTime | null;
  /** Option B: business-day date the partner commits to credit the account. */
  expectedCreditDate: ISODate | null;
  creditedAt: ISODateTime | null;
  errorDetail: string | null;
  /** `retenido`: why the release did not run (seller gate). */
  holdReason: SellerGateReason | null;
  receiptId: string | null;
}

export type SellerGateReason = 'seller_unverified' | 'seller_paused' | 'seller_rejected' | 'seller_cooling_off' | 'cnr_alert';

export interface OutboxMessage {
  id: string;
  planId: string;
  buyerId: string;
  /** E.164 phone the message would go to. */
  to: string;
  template: WhatsAppTemplate;
  locale: 'es' | 'en';
  params: Record<string, string | number>;
  /** Rendered text, at most 1,024 characters. */
  body: string;
  /** The one deep link the message carries (`#/c/<planId>/pagar`, `#/c/<planId>/recibo/<idx>`). */
  link: string;
  createdAt: ISODateTime;
  channel: 'whatsapp';
  simulated: true;
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
  payments: Payment;
  sellers: Seller;
  seller_units: SellerUnit;
  offices: Office;
  payouts: Payout;
  wa_outbox: OutboxMessage;
}

export type TableName = keyof Tables;

export type Snapshot = { [K in TableName]: Tables[K][] };

// ---------- View models (derived, never stored) ----------

/** `recibido`: paid before the due date, waiting for the release on that date (El Salvador). */
export type CellState = 'pagado' | 'bloqueado' | 'ofrecido' | 'abierto' | 'roto' | 'no_pagado' | 'condonado' | 'recibido';

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
  /** Resolved corridor id (`plan.corridor` or the default). */
  corridor: CorridorId;
  /** El Salvador: the seller and its title check for this unit; null in Colombia. */
  seller: SellerSummary | null;
  /** Open payment attempts on this plan (pending MoneyGram references and the like). */
  payments: Payment[];
}

/** What the buyer and the counter see about the seller: never the payout account. */
export interface SellerSummary {
  id: string;
  tradeName: string;
  tier: SellerTier;
  verificationStatus: SellerVerificationStatus;
  payoutOption: PayoutOption;
  /** The unit's title check, when one exists. */
  cnr: { registryNo: string; certDate: ISODate; alertStatus: CnrAlertStatus } | null;
  /** Releases to this seller are blocked for this reason, or null when they flow. */
  gate: SellerGateReason | null;
}

/** One pay method as offered to the buyer for one installment. */
export interface PayOptionView {
  method: PayMethod;
  /** Offered at all (hidden methods are not listed), and enabled for this amount and buyer. */
  enabled: boolean;
  disabledReason: PaymentBlockReason | null;
  feeUsd: number;
  /** USD the buyer hands over: the installment plus the fee. */
  totalUsd: number;
  /** Counter method: the buyer's nearest office. */
  office: Office | null;
  /** MoneyGram: the open reference for this installment, if one exists. */
  payment: Payment | null;
  /** MoneyGram: limits that apply (from config), echoed so the sheet can explain a block. */
  limits: { minUsd: number; maxUsd: number } | null;
}

export interface PayOptionsView {
  planId: string;
  idx: number;
  number: number;
  dueDate: ISODate;
  usdDue: number;
  options: PayOptionView[];
}

/** A counter search hit: the buyer, the plan and what is payable now. */
export interface CounterSearchResult {
  buyer: Buyer;
  plan: Plan;
  unitLabel: string;
  corridor: CorridorId;
  /** Installments payable at the counter now, earliest first. */
  due: { idx: number; number: number; dueDate: ISODate; usdDue: number; isLate: boolean; lateInGrace: boolean }[];
  fundsBlocked: boolean;
}

export interface ShiftTotal {
  officeId: string;
  cashierId: string;
  date: ISODate;
  byTender: Record<Tender, { count: number; usd: number }>;
  totalUsd: number;
  payments: Payment[];
}

/** A plan as the desk lists it. */
export interface PlanRow {
  plan: Plan;
  buyer: Buyer;
  unit: Unit;
  corridor: CorridorId;
  sellerName: string | null;
  /** Desk status: `activo`, `atrasado` (late inside grace), `en_mora`, `en_pausa`, `cancelado`, `completado`. */
  status: PlanDeskStatus;
  governance: GovernanceView;
  paidCount: number;
  nextDueDate: ISODate | null;
  nextUsd: number | null;
  lateCount: number;
}

export type PlanDeskStatus = 'activo' | 'atrasado' | 'en_mora' | 'en_pausa' | 'cancelado' | 'completado';

export interface SellerView extends Seller {
  units: (SellerUnit & { unitLabel: string; project: string })[];
  planCount: number;
  gate: SellerGateReason | null;
}

export interface PayoutView extends Payout {
  buyerName: string;
  sellerName: string;
  unitLabel: string;
  number: number;
  corridor: CorridorId;
  /** usdPaid − feeUsd === usdToSeller, to the cent. */
  reconciles: boolean;
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
