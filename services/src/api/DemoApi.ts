// DemoApi: the single façade the web app talks to. It owns the orchestration (quote → accept → hedge
// legs; pay → on-ramp → off-ramp → settlement → receipt; clock jobs; reset) on top of a Store and the
// four providers. Stage 2 and 3 keep this class and swap the providers; the Supabase layer swaps the
// Store. Nothing here imports a UI framework.
// Corridors: the lock, pay-ahead and FX paths below are the Colombia flow and stay as they were;
// a corridor whose pay steps have no conversion leg (El Salvador) pays through svApi.ts, which also
// holds the office portals. Lock paths refuse a corridor with locks disabled before any provider
// call. Messages (WhatsApp outbox) go through one MessageChannel for both corridors.

import type {
  Buyer,
  CounterSearchResult,
  DemoState,
  HedgeBookView,
  HedgeLeg,
  HedgeTrade,
  Installment,
  ISODate,
  Lock,
  LockQuote,
  Office,
  OutboxMessage,
  PayOptionsView,
  Payment,
  PaymentView,
  PayoutAccount,
  PayoutView,
  PayStep,
  Plan,
  PlanRow,
  PlanView,
  Receipt,
  ReconRow,
  RenewalOffer,
  SellerView,
  ShiftTotal,
  Tender,
  Tenor,
  Unit,
  UnitSummary,
} from '../domain/types';
import type { AdverseAction } from '../policy/transitions';
import { CORRIDORS, LocksDisabledError, assertLocksEnabled, corridorIdOf, corridorOf, type CorridorId, type PayoutOption } from '../corridors/index';
import { addMonths, compareISO, nowISO } from '../domain/dates';
import {
  GRACE_BUSINESS_DAYS,
  acceptanceCutoffDate,
  breakCost,
  fixedPointRate,
  graceEndDate,
  isBeforeCutoff,
  isBeyondGrace,
  isQuoteExpired,
  nextLockableIdxs,
  roundCop,
  roundUsd,
  shouldOfferRenewal,
  usdDue,
  usdToCoverCop,
} from '../lock/engine';
import type { CashInProvider, OffRampQuote, OffRampQuoteRequest, Providers, SellerPayoutProvider } from '../adapters/interfaces';
import { MockRuntime, curveAtOffset, spotAtOffset } from '../adapters/mockRuntime';
import { MoneyGramOnRamp } from '../adapters/moneyGramOnRamp';
import { UsdBankPayout } from '../adapters/usdBankPayout';
import { UsdcHold } from '../adapters/usdcHold';
import type { Store } from '../store/Store';
import { ADVERSE_DEMO_PLANS, buildSeed, makeReceipt, svSeedClock } from '../seed/fixtures';
import { fundsAllowed } from '../policy/transitions';
import { MockGovernanceProvider, type GovernanceProvider } from '../policy/GovernanceProvider';
import { buildHedgeBook, buildPlanView, buildReconRows, buildUnitSummaries } from './views';
import { demoLockExpiryTs, lockIdBytes, lockedStroops, usdToStroops, type ChainBridge } from '../chain/bridge';
import { ChainError } from '../chain/submit';
import { OutboxChannel, type MessageChannel, type TemplateRenderer } from '../channels/MessageChannel';
import { sellerSummary } from '../sellers/sellers';
import { ApiError } from './errors';
import * as sv from './svApi';

export { ApiError, type ApiErrorCode } from './errors';

export type ProgressFn = (completedStep: PayStep) => void;

/** What the buyer owes for one installment of a corridor with an FX leg, and how it was priced. */
interface FxCharge {
  locked: boolean;
  breakCostCop: number;
  usdPaid: number;
  spotQuote: OffRampQuote | null;
}

export interface CasaPuenteApi {
  getDemoState(): Promise<DemoState>;
  listBuyers(): Promise<Buyer[]>;
  listPlans(): Promise<{ plan: Plan; buyer: Buyer; unit: Unit }[]>;
  getPlan(planId: string): Promise<PlanView>;
  getReceipts(planId: string): Promise<Receipt[]>;
  getSpot(): Promise<{ rate: number; asOf: ISODate }>;
  quoteLock(planId: string, tenor: Tenor): Promise<LockQuote>;
  acceptLock(lockId: string): Promise<PlanView>;
  pay(planId: string, idx: number, onProgress?: ProgressFn): Promise<Receipt>;
  payAhead(planId: string, onProgress?: ProgressFn): Promise<Receipt[]>;
  getUnitSummaries(): Promise<UnitSummary[]>;
  getReconciliation(filter?: { project?: string }): Promise<ReconRow[]>;
  getHedgeBook(): Promise<HedgeBookView>;
  bookStrip(): Promise<HedgeTrade[]>;
  setPassThrough(passThrough: number): Promise<DemoState>;
  advanceClock(months?: number): Promise<DemoState>;
  reset(): Promise<{ state: DemoState; elapsedMs: number }>;
  setErrorMode(on: boolean): Promise<DemoState>;

  // ---------- El Salvador corridor and the office portals ----------
  // Every method below reads the plan's corridor through corridorOf(plan) and refuses what that
  // corridor does not offer with a typed ApiError (never a country literal in the UI).

  /** Offices and licensed agencies (the counter picks one; the buyer sees the nearest). */
  listOffices(): Promise<Office[]>;
  /** The pay methods offered to this buyer for one installment, with fees, limits and any open reference. */
  getPayOptions(planId: string, idx: number): Promise<PayOptionsView>;
  /** Issues a MoneyGram cash-in reference (status `pending`); the plan is not credited yet. */
  requestCashReference(planId: string, idx: number): Promise<PaymentView>;
  /** Replaces an expired reference with a new one. */
  renewCashReference(paymentId: string): Promise<PaymentView>;
  /** Demo control (simulado): the network reports the cash-in as completed, which credits the plan. */
  completeCashReference(paymentId: string, onProgress?: ProgressFn): Promise<Receipt>;
  getPayment(paymentId: string): Promise<PaymentView>;
  listPayments(filter?: { planId?: string; officeId?: string; cashierId?: string; date?: ISODate; status?: Payment['status'] }): Promise<PaymentView[]>;

  /** Counter: finds buyers by phone digits or name. Empty query → empty list. */
  searchBuyers(query: string): Promise<CounterSearchResult[]>;
  /** Counter: takes cash or card for one installment, credits the plan and writes the receipt. */
  takeCounterPayment(args: { planId: string; idx: number; tender: Tender; amountReceived: number; officeId: string; cashierId: string }, onProgress?: ProgressFn): Promise<{ payment: PaymentView; receipt: Receipt }>;
  /** Counter: today's takings by tender for one cashier at one office. */
  getShiftTotal(args: { officeId: string; cashierId: string }): Promise<ShiftTotal>;
  /** Sends the receipt link through the message channel (mock outbox). */
  sendReceiptMessage(planId: string, idx: number): Promise<OutboxMessage>;

  /** Desk: every plan with its desk status, filterable client-side. */
  listPlanRows(): Promise<PlanRow[]>;
  listSellers(): Promise<SellerView[]>;
  getSeller(sellerId: string): Promise<SellerView>;
  /** Desk: verify, pause or reject a seller (reject is irreversible and confirmed by the UI). */
  setSellerVerification(sellerId: string, status: 'verified' | 'paused' | 'rejected', note?: string): Promise<SellerView>;
  /** Desk: requests a payout-account change; starts the 72 h cooling-off and re-verification. */
  changeSellerPayoutAccount(sellerId: string, account: PayoutAccount): Promise<SellerView>;
  /** Desk (simulado CNR feed): a new lien on a unit puts the seller's plans on hold. */
  raiseCnrAlert(sellerId: string, unitId: string, detail: string): Promise<SellerView>;
  listPayouts(filter?: { planId?: string; sellerId?: string }): Promise<PayoutView[]>;
  /** Desk: retries an option B payout in `error`, or a `retenido` release whose gate has cleared. */
  retryPayout(payoutId: string): Promise<PayoutView>;
  /** Every message the system would have sent, newest first; optionally one plan's. */
  listOutbox(planId?: string): Promise<OutboxMessage[]>;
  /** Desk: one adverse-event action on a plan through the policy layer (dry run, evidence, provider, store). */
  runAdverseAction(action: AdverseAction, detail?: string): Promise<PlanView>;
}

export interface DemoApiOptions {
  store: Store;
  providers: Providers;
  runtime: MockRuntime;
  now?: () => number;
  /**
   * Testnet mode only: mirrors locks, deposits, releases and breaks on the payment_plan contract.
   * Undefined in mock mode, where every path below behaves exactly as in Stage 1. `chain` is the
   * Colombia instance; `chains` adds one bridge per corridor (El Salvador runs on a second instance
   * of the same Wasm with its own payee). A plan uses `chains[corridor]`, falling back to `chain`
   * for Colombia only.
   */
  chain?: ChainBridge;
  chains?: Partial<Record<CorridorId, ChainBridge>>;
  /** Where messages go; default: the `wa_outbox` table (mock WhatsApp channel). */
  messages?: MessageChannel;
  /** Renders a template body; default: `plainRenderer`. The web app passes `dictionaryRenderer` over its dictionaries. */
  renderTemplate?: TemplateRenderer;
  /** Adverse-event seam; default: MockGovernanceProvider over the store (testnet passes one over the bridge). */
  governance?: GovernanceProvider;
  /** Operator log (the testnet server passes its own); default: silent. */
  log?: (msg: string) => void;
}

export class DemoApi implements CasaPuenteApi {
  private readonly store: Store;
  private readonly providers: Providers;
  private readonly runtime: MockRuntime;
  private readonly now: () => number;
  private readonly chain: ChainBridge | undefined;
  private readonly chains: Partial<Record<CorridorId, ChainBridge>>;
  private readonly messages: MessageChannel;
  private readonly governance: GovernanceProvider;
  private readonly log: (msg: string) => void;
  private readonly cashIn: CashInProvider;
  private readonly sellerPayouts: Record<PayoutOption, SellerPayoutProvider>;
  private offset = 0;
  private todayCache: ISODate | null = null;
  private sessionStartMs: number;

  constructor(opts: DemoApiOptions) {
    this.store = opts.store;
    this.providers = opts.providers;
    this.runtime = opts.runtime;
    this.now = opts.now ?? (() => Date.now());
    this.chain = opts.chain;
    this.log = opts.log ?? (() => {});
    this.chains = { ...(opts.chain ? { co: opts.chain } : {}), ...(opts.chains ?? {}) };
    this.runtime.clockOffset = () => this.offset;
    this.sessionStartMs = this.now();
    this.messages = opts.messages ?? new OutboxChannel({ store: this.store, render: opts.renderTemplate, timestamp: () => new Date(this.sessionClockMs()).toISOString() });
    this.governance = opts.governance ?? new MockGovernanceProvider({ store: this.store, today: async () => (await this.state()).today });
    // The corridor rails default to the mocks so the testnet factory needs no change; the limits of
    // the first corridor that offers a cash-in network are the provider's own default (requests
    // carry the plan's corridor limits anyway).
    const cashCorridor = Object.values(CORRIDORS).find((c) => c.moneyGram);
    this.cashIn =
      opts.providers.cashIn ??
      new MoneyGramOnRamp({
        driver: 'mock',
        runtime: this.runtime,
        limits: cashCorridor?.moneyGram ?? { minUsd: 0, maxUsd: Number.POSITIVE_INFINITY, excludedStates: [], referenceTtlMinutes: 60 },
        feeUsd: cashCorridor?.feesUsd.moneygram_cash ?? 0,
        now: () => this.sessionClockMs(),
      });
    const payoutCorridor = Object.values(CORRIDORS).find((c) => c.payoutProviders.includes('usd-bank-payout')) ?? CORRIDORS[corridorIdOf(null)];
    // Option A records a hand-off only (no transfer) when a corridor that offers it runs on chain.
    const holdOnChain = Object.values(CORRIDORS).some((c) => c.payoutProviders.includes('usdc-hold') && this.chains[c.id] != null);
    this.sellerPayouts = {
      A: opts.providers.sellerPayouts?.A ?? new UsdcHold({ runtime: this.runtime, now: () => this.sessionClockMs(), onChain: holdOnChain }),
      B: opts.providers.sellerPayouts?.B ?? new UsdBankPayout({ runtime: this.runtime, corridor: payoutCorridor, now: () => this.sessionClockMs() }),
    };
  }

  /** The chain bridge a plan's corridor runs on (undefined in mock mode or for an unmapped corridor). */
  protected chainFor(plan: Pick<Plan, 'corridor'>): ChainBridge | undefined {
    return this.chains[corridorIdOf(plan)];
  }

  /** The adverse-event provider the desk actions run through (mock by default; testnet passes its own). */
  protected governanceProvider(): GovernanceProvider {
    return this.governance;
  }

  /**
   * The session clock of the corridor rows (payments, payouts, messages): the demo date at the seed
   * clock plus the time elapsed in this session, so a reference issued 12 minutes before the seed
   * clock is still payable when the page opens, and "+1 mes" expires it. Colombia receipts keep
   * their wall-clock time of day (`demoTimestamp`).
   */
  private sessionClockMs(): number {
    const today = this.todayCache ?? new Date(this.now()).toISOString().slice(0, 10);
    return Date.parse(svSeedClock(today)) + Math.max(0, this.now() - this.sessionStartMs);
  }

  private svContext(): sv.SvContext {
    return {
      store: this.store,
      providers: this.providers,
      cashIn: this.cashIn,
      payoutRail: (option) => this.sellerPayouts[option],
      runtime: this.runtime,
      nowMs: () => this.sessionClockMs(),
      today: async () => (await this.state()).today,
      fx: {
        charge: async (plan, row) => {
          const s = await this.state();
          const charge = await this.fxCharge(row);
          return { usdPaid: charge.usdPaid, settle: (onProgress) => this.fxSettle(plan, row, charge, s, onProgress) };
        },
      },
      spot: () => this.spot(),
      chainPlanOf: (plan) => this.chainPlanOf(plan),
      onChain: (what, run) => this.onChain(what, run),
      messages: this.messages,
      governance: () => this.governanceProvider(),
      viewOf: async (planId) => this.viewOf(planId, await this.state()),
      planBundle: (planId) => this.planBundle(planId),
      assertFundsAllowed: (planId) => this.assertFundsAllowed(planId),
    };
  }

  // ---------- chain helpers (testnet mode) ----------

  /**
   * The bridge of the plan's own corridor and its chain plan id, or null when the plan stays off
   * chain: mock mode, a corridor without an instance, or a plan the last reset marked simulated
   * because the network refused to create it (`demo_state.simulatedPlans`).
   */
  private async chainPlanOf(plan: Pick<Plan, 'id' | 'corridor'>): Promise<{ chain: ChainBridge; chainPlanId: number } | null> {
    const chain = this.chainFor(plan);
    if (!chain) return null;
    const s = await this.state();
    if (s.simulatedPlans?.[plan.id]) return null;
    return { chain, chainPlanId: await this.chainPlanId(plan.id) };
  }

  private async chainPlanId(planId: string): Promise<number> {
    const s = await this.state();
    const id = s.chainPlans?.[planId];
    if (id == null) throw new ApiError('PROVIDER', `plan ${planId} is not seeded on chain; run "Reiniciar demo"`);
    return id;
  }

  /** Runs a chain call and turns any failure into the PROVIDER error the UI knows how to show. */
  private async onChain<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const detail = e instanceof ChainError ? e.message : e instanceof Error ? e.message : String(e);
      throw new ApiError('PROVIDER', `${what}: ${detail}`, e);
    }
  }

  /** Stroops a payment moves on chain: the contract's own amount for a locked row, the paid USD otherwise. */
  private static stroopsFor(row: Installment, locked: boolean, usdPaid: number): bigint {
    return locked && row.lockedRate != null ? lockedStroops(row.copDue, row.lockedRate) : usdToStroops(usdPaid);
  }

  // ---------- state helpers ----------

  private async state(): Promise<DemoState> {
    const s = await this.store.get('demo_state', 'singleton');
    if (!s) throw new ApiError('NOT_FOUND', 'demo_state missing; run reset');
    this.offset = s.clockOffsetMonths;
    this.todayCache = s.today;
    this.runtime.errorMode = s.errorMode;
    return s;
  }

  private async saveState(patch: Partial<DemoState>): Promise<DemoState> {
    const s = { ...(await this.state()), ...patch };
    await this.store.upsert('demo_state', s);
    this.offset = s.clockOffsetMonths;
    this.todayCache = s.today;
    this.runtime.errorMode = s.errorMode;
    return s;
  }

  private spot(): number {
    return spotAtOffset(this.offset);
  }

  // Timestamps written by the demo carry the demo date (which "+1 mes" moves) and the wall-clock
  // time of day, so receipts and settlements line up with the calendar the user is looking at.
  private async demoTimestamp(): Promise<string> {
    const s = await this.state();
    const wall = new Date(this.now()).toISOString();
    return `${s.today}T${wall.slice(11)}`;
  }

  private async guardedRead(op: string): Promise<DemoState> {
    const s = await this.state();
    this.runtime.guard(op);
    await this.runtime.delay(0.4);
    return s;
  }

  private async planBundle(planId: string): Promise<{ plan: Plan; buyer: Buyer; unit: Unit; installments: Installment[] }> {
    const plan = await this.store.get('plans', planId);
    if (!plan) throw new ApiError('NOT_FOUND', `plan ${planId}`);
    const buyer = await this.store.get('buyers', plan.buyerId);
    const unit = await this.store.get('units', plan.unitId);
    if (!buyer || !unit) throw new ApiError('NOT_FOUND', `buyer/unit for ${planId}`);
    const installments = (await this.store.all('installments')).filter((i) => i.planId === planId).sort((a, b) => a.idx - b.idx);
    return { plan, buyer, unit, installments };
  }

  private async viewOf(planId: string, s: DemoState): Promise<PlanView> {
    await sv.refreshReferences(this.svContext());
    const b = await this.planBundle(planId);
    const seller = b.plan.sellerId ? await this.store.get('sellers', b.plan.sellerId) : undefined;
    const units = seller ? (await this.store.all('seller_units')).filter((u) => u.sellerId === seller.id) : [];
    const nowMs = this.sessionClockMs();
    const payments = (await this.store.all('payments'))
      .filter((p) => p.planId === planId && (p.status === 'pending' || p.status === 'quote_expired'))
      .sort((a, c) => c.createdAt.localeCompare(a.createdAt))
      .map((p) => sv.paymentView(p, nowMs));
    return buildPlanView({
      ...b,
      locks: await this.store.all('locks'),
      offers: await this.store.all('renewal_offers'),
      today: s.today,
      spot: this.spot(),
      passThrough: s.passThrough,
      governance: await this.store.get('plan_governance', planId),
      events: await this.store.all('policy_events'),
      seller: seller ? sellerSummary(seller, units, b.plan.unitId, new Date(this.sessionClockMs()).toISOString()) : null,
      payments,
    });
  }

  /** Lock paths refuse a corridor without locks before any provider or chain call. */
  private assertLocks(plan: Plan): void {
    try {
      assertLocksEnabled(plan);
    } catch (e) {
      if (e instanceof LocksDisabledError) throw new ApiError('LOCKS_DISABLED', e.message, e);
      throw e;
    }
  }

  /** The Colombia pay flow sends the same paid notices the corridor lists (received, delivered). */
  private async notifyPaid(plan: Plan, row: Installment, receipt: Receipt): Promise<void> {
    const buyer = await this.store.get('buyers', plan.buyerId);
    if (!buyer) return;
    const ctx = this.svContext();
    const params = { usd: receipt.usdPaid.toFixed(2), seller: plan.trustCompany, date: receipt.paidAt.slice(0, 10) };
    await sv.notify(ctx, { plan, buyer, template: 'pago_recibido', idx: row.idx, params, once: 'installment' });
    await sv.notify(ctx, { plan, buyer, template: 'pago_entregado', idx: row.idx, params, once: 'installment' });
  }

  /** Deposits, locks and payments are refused while the plan is on hold, defaulted, cancelled or completed. */
  private async assertFundsAllowed(planId: string): Promise<void> {
    const gov = await this.store.get('plan_governance', planId);
    if (gov && !fundsAllowed(gov.state)) throw new ApiError('PLAN_BLOCKED', `plan is ${gov.state}`);
  }

  // ---------- reads ----------

  async getDemoState(): Promise<DemoState> {
    return this.state();
  }

  async listBuyers(): Promise<Buyer[]> {
    await this.guardedRead('listBuyers');
    return this.store.all('buyers');
  }

  async listPlans(): Promise<{ plan: Plan; buyer: Buyer; unit: Unit }[]> {
    await this.guardedRead('listPlans');
    const [plans, buyers, units] = await Promise.all([this.store.all('plans'), this.store.all('buyers'), this.store.all('units')]);
    return plans.map((plan) => ({ plan, buyer: buyers.find((b) => b.id === plan.buyerId)!, unit: units.find((u) => u.id === plan.unitId)! }));
  }

  async getPlan(planId: string): Promise<PlanView> {
    const s = await this.guardedRead('getPlan');
    return this.viewOf(planId, s);
  }

  async getReceipts(planId: string): Promise<Receipt[]> {
    await this.guardedRead('getReceipts');
    return (await this.store.all('receipts')).filter((r) => r.planId === planId).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  }

  async getSpot(): Promise<{ rate: number; asOf: ISODate }> {
    const s = await this.guardedRead('getSpot');
    return { rate: this.spot(), asOf: s.today };
  }

  async getUnitSummaries(): Promise<UnitSummary[]> {
    const s = await this.guardedRead('getUnitSummaries');
    return buildUnitSummaries({
      plans: await this.store.all('plans'),
      buyers: await this.store.all('buyers'),
      units: await this.store.all('units'),
      installments: await this.store.all('installments'),
      today: s.today,
      governance: await this.store.all('plan_governance'),
      events: await this.store.all('policy_events'),
    });
  }

  async getReconciliation(filter?: { project?: string }): Promise<ReconRow[]> {
    await this.guardedRead('getReconciliation');
    const rows = buildReconRows({
      receipts: await this.store.all('receipts'),
      plans: await this.store.all('plans'),
      buyers: await this.store.all('buyers'),
      units: await this.store.all('units'),
      installments: await this.store.all('installments'),
    });
    return filter?.project ? rows.filter((r) => r.project === filter.project) : rows;
  }

  async getHedgeBook(): Promise<HedgeBookView> {
    const s = await this.guardedRead('getHedgeBook');
    return buildHedgeBook({
      legs: await this.store.all('hedge_legs'),
      trades: await this.store.all('hedge_trades'),
      locks: await this.store.all('locks'),
      plans: await this.store.all('plans'),
      buyers: await this.store.all('buyers'),
      curve: curveAtOffset(this.offset, s.baseDate),
      passThrough: s.passThrough,
      today: s.today,
    });
  }

  // ---------- lock flow ----------

  async quoteLock(planId: string, tenor: Tenor): Promise<LockQuote> {
    const s = await this.state();
    this.runtime.guard('quoteLock');
    const { plan, installments } = await this.planBundle(planId);
    this.assertLocks(plan);
    await this.assertFundsAllowed(planId);
    const idxs = nextLockableIdxs(installments, tenor);
    if (!idxs) throw new ApiError('NO_LOCKABLE', 'no consecutive open installments for this tenor');
    const rows = idxs.map((i) => installments[i]!);
    const firstDue = rows[0]!.dueDate;
    if (!isBeforeCutoff(s.today, firstDue)) throw new ApiError('CUTOFF', `cutoff ${acceptanceCutoffDate(firstDue)} passed`);

    // Any earlier unaccepted quote for this plan expires now.
    const previous = (await this.store.all('locks')).filter((l) => l.planId === planId && l.state === 'cotizado');
    for (const l of previous) await this.store.upsert('locks', { ...l, state: 'vencido' });

    let q;
    try {
      q = await this.providers.lock.quote({
        planId,
        tenor,
        idxs,
        copDues: rows.map((r) => r.copDue),
        dueDates: rows.map((r) => r.dueDate),
        passThrough: s.passThrough,
      });
    } catch (e) {
      throw new ApiError('PROVIDER', 'lock provider failed', e);
    }
    const lock: Lock = {
      id: `lock-${planId}-${idxs[0]}-${this.now().toString(36)}`,
      planId,
      tenor,
      idxs,
      spot: q.spot,
      fwdRates: q.fwdRates,
      avgFwd: q.avgFwd,
      points: q.points,
      passThrough: s.passThrough,
      lockedRate: q.lockedRate,
      usdPerInstallment: q.usdPerInstallment,
      quoteExpiresAt: q.quoteExpiresAt,
      createdAt: new Date(this.now()).toISOString(),
      acceptedAt: null,
      state: 'cotizado',
      brokenIdx: null,
      breakCostCop: null,
      curveAsOf: q.curveAsOf,
    };
    await this.store.upsert('locks', lock);
    const usdAtSpot = rows.map((r) => roundUsd(usdDue(r.copDue, q.spot)));
    void plan;
    return {
      lock,
      idxs,
      installments: rows.map((r, k) => ({ idx: r.idx, number: r.idx + 1, dueDate: r.dueDate, copDue: r.copDue, usdDue: q.usdPerInstallment[k]!, usdAtSpot: usdAtSpot[k]! })),
      usdPerInstallment: q.usdPerInstallment[0]!,
      usdTotal: roundUsd(q.usdPerInstallment.reduce((a, b) => a + b, 0)),
      copTotal: rows.reduce((a, r) => a + r.copDue, 0),
      usdAtSpotTotal: roundUsd(usdAtSpot.reduce((a, b) => a + b, 0)),
      spot: q.spot,
      lockedRate: q.lockedRate,
      quoteExpiresAt: q.quoteExpiresAt,
      cutoffDate: acceptanceCutoffDate(firstDue),
      graceBusinessDays: GRACE_BUSINESS_DAYS,
    };
  }

  async acceptLock(lockId: string): Promise<PlanView> {
    const s = await this.state();
    this.runtime.guard('acceptLock');
    const lock = await this.store.get('locks', lockId);
    if (!lock) throw new ApiError('NOT_FOUND', `lock ${lockId}`);
    if (lock.state !== 'cotizado') throw new ApiError('NOT_QUOTED', `lock is ${lock.state}`);
    if (isQuoteExpired(lock.quoteExpiresAt, this.now())) {
      await this.store.upsert('locks', { ...lock, state: 'vencido' });
      throw new ApiError('QUOTE_EXPIRED');
    }
    const { plan: lockPlan, installments } = await this.planBundle(lock.planId);
    this.assertLocks(lockPlan);
    await this.assertFundsAllowed(lock.planId);
    const rows = lock.idxs.map((i) => installments[i]!);
    if (rows.some((r) => r.status !== 'open')) throw new ApiError('NO_LOCKABLE', 'an installment is no longer open');

    if (this.chain) {
      // Testnet: apply_lock with the fixed-point rate the contract stores and the compressed
      // expiry of the demo time model (services/src/chain/bridge.ts).
      const chain = this.chain;
      const { plan } = await this.planBundle(lock.planId);
      const chainPlanId = await this.chainPlanId(lock.planId);
      await this.onChain('apply_lock', () =>
        chain.applyLock({
          chainPlanId,
          buyerId: plan.buyerId,
          idxs: lock.idxs,
          lockId: lockIdBytes(lockId),
          lockedRate: fixedPointRate(lock.lockedRate),
          expiryTs: demoLockExpiryTs(this.now()),
        }),
      );
    } else {
      try {
        await this.providers.lock.apply({
          lockId,
          planId: lock.planId,
          idxs: lock.idxs,
          lockedRate: lock.lockedRate,
          expiryTs: graceEndDate(rows[rows.length - 1]!.dueDate),
        });
      } catch (e) {
        throw new ApiError('PROVIDER', 'lock provider failed', e);
      }
    }

    const acceptedAt = new Date(this.now()).toISOString();
    await this.store.upsertMany(
      'installments',
      rows.map((r, k) => ({
        ...r,
        status: 'locked' as const,
        lockId,
        lockedRate: lock.lockedRate,
        usdDue: lock.usdPerInstallment[k]!,
        lockExpiry: graceEndDate(r.dueDate),
      })),
    );
    await this.store.upsert('locks', { ...lock, state: 'activo', acceptedAt });
    await this.store.upsertMany(
      'hedge_legs',
      rows.map(
        (r, k): HedgeLeg => ({
          id: `leg-${lockId}-${r.idx}`,
          lockId,
          planId: lock.planId,
          installmentIdx: r.idx,
          dueDate: r.dueDate,
          usdNotional: usdDue(r.copDue, lock.lockedRate),
          lockedRate: lock.lockedRate,
          fwdRate: lock.fwdRates[k]!,
          tradeId: null,
          bookedAt: null,
          settledCop: null,
          fixing: null,
          settledAt: null,
          state: 'pendiente',
        }),
      ),
    );
    const offers = (await this.store.all('renewal_offers')).filter((o) => o.planId === lock.planId && o.state === 'ofrecido' && o.idxs.some((i) => lock.idxs.includes(i)));
    for (const o of offers) await this.store.upsert('renewal_offers', { ...o, state: 'aceptado' });
    return this.viewOf(lock.planId, s);
  }

  // ---------- pay flow ----------

  async pay(planId: string, idx: number, onProgress?: ProgressFn): Promise<Receipt> {
    const s = await this.state();
    this.runtime.guard('pay');
    const { plan, installments } = await this.planBundle(planId);
    // A corridor without a conversion step pays in the installment's own currency (svApi).
    if (!corridorOf(plan).paySteps.includes('convertido')) return sv.payDirect(this.svContext(), planId, idx, onProgress);
    const row = installments[idx];
    if (!row) throw new ApiError('NOT_FOUND', `installment ${idx}`);
    if (row.status === 'released') throw new ApiError('ALREADY_PAID');
    await this.assertFundsAllowed(planId);
    if (row.status === 'missed' || row.status === 'waived') throw new ApiError('INSTALLMENT_MISSED', `installment is ${row.status}`);

    const charge = await this.fxCharge(row);
    await this.onRampDeposit(plan.buyerId, charge.usdPaid, `${plan.encargoRef}-M${idx + 1}`);
    return this.fxSettle(plan, row, charge, s, onProgress);
  }

  /**
   * What the buyer owes in USD for one installment of a corridor with an FX leg. A locked
   * installment pays the guaranteed USD; an unlocked one is quoted by the exact COP due (plus any
   * break cost) so the trust receives that amount to the peso and the USD leg is the smallest
   * whole-cent amount covering it.
   */
  private async fxCharge(row: Installment): Promise<FxCharge> {
    const locked = row.status === 'locked' && row.usdDue != null && row.lockedRate != null;
    const breakCostCop = row.status === 'broken' ? row.breakCostCop ?? 0 : 0;
    if (locked) return { locked, breakCostCop, usdPaid: row.usdDue!, spotQuote: null };
    const spotQuote = await this.offRampQuote({ copTarget: row.copDue + breakCostCop });
    return { locked, breakCostCop, usdPaid: Number(spotQuote.usdc), spotQuote };
  }

  /** Once the buyer's USD is in (on-ramp or office counter): deposit, convert, release, receipt. */
  private async fxSettle(plan: Plan, row: Installment, charge: FxCharge, s: DemoState, onProgress?: ProgressFn): Promise<Receipt> {
    const { locked, usdPaid, breakCostCop } = charge;
    const idx = row.idx;
    // 1. Recibido. Testnet: the buyer's USD is test USDC in the buyer's account and is deposited
    //    into the plan's balance on chain before anything is converted.
    const stroops = DemoApi.stroopsFor(row, locked, usdPaid);
    const on = await this.chainPlanOf(plan);
    if (on) await this.onChain('deposit', () => on.chain.deposit(plan.buyerId, on.chainPlanId, stroops));
    onProgress?.('recibido');

    // 2. Convertido: USDC → COP through the off-ramp.
    const spotQuote = charge.spotQuote ?? (await this.offRampQuote({ usdc: usdPaid.toFixed(7) }));
    let { txId } = await this.offRampPay(spotQuote.quoteId, usdPaid, plan.encargoRef, `M${idx + 1}`);
    onProgress?.('convertido');

    // 3. Entregado: the contract releases the installment (release_due at the locked amount, or
    //    release_spot for an open/broken one), the NDF settles, the receipt is written. The
    //    receipt's transaction hash is the release transaction.
    if (on) {
      const { chain, chainPlanId } = on;
      if (row.status === 'broken') await this.retryBreakOnChain(chain, chainPlanId, row.idx);
      const rel = await this.onChain(locked ? 'release_due' : 'release_spot', () =>
        locked ? chain.releaseDue(chainPlanId, row.idx) : chain.releaseSpot(chainPlanId, row.idx, stroops),
      );
      txId = rel.txHash;
    }
    const receipt = await this.settleAndRecord({ plan, row, usdPaid, locked, anchorRate: spotQuote.rate, txId, breakCostCop, state: s });
    await this.notifyPaid(plan, row, receipt);
    onProgress?.('entregado');
    return receipt;
  }

  /**
   * The break job records a broken installment even when `break_lock` could not be sent (for
   * example inside the one-minute expiry of the demo time model); before paying it at spot the
   * break is retried, and "already broken" (NotLocked) is fine.
   */
  private async retryBreakOnChain(chain: ChainBridge, chainPlanId: number, idx: number): Promise<void> {
    try {
      await chain.breakLock(chainPlanId, idx);
    } catch (e) {
      if (e instanceof ChainError && e.errorName === 'NotLocked') return;
      throw new ApiError('PROVIDER', `break_lock: ${e instanceof Error ? e.message : String(e)}`, e);
    }
  }

  async payAhead(planId: string, onProgress?: ProgressFn): Promise<Receipt[]> {
    const s = await this.state();
    this.runtime.guard('payAhead');
    const { plan, installments } = await this.planBundle(planId);
    if (!corridorOf(plan).views.payAhead) throw new ApiError('NOTHING_TO_PAY_AHEAD', 'this corridor does not offer paying a quarter ahead');
    await this.assertFundsAllowed(planId);
    const idxs = nextLockableIdxs(installments, 'trimestral');
    if (!idxs) throw new ApiError('NOTHING_TO_PAY_AHEAD', 'no open quarter to pay ahead');
    const rows = idxs.map((i) => installments[i]!);
    // One quote for the quarter's COP; each installment's USD leg is sized to cover its own cop_due
    // at the quoted rate, so every receipt delivers exactly what that installment owes.
    const quote = await this.offRampQuote({ copTarget: rows.reduce((a, r) => a + r.copDue, 0) });
    const usdEach = rows.map((r) => usdToCoverCop(r.copDue, quote.rate));
    await this.onRampDeposit(plan.buyerId, roundUsd(usdEach.reduce((a, b) => a + b, 0)), `${plan.encargoRef}-ADELANTO`);
    const stroopsEach = usdEach.map((u) => usdToStroops(u));
    const on = await this.chainPlanOf(plan);
    if (on) {
      const total = stroopsEach.reduce((a, b) => a + b, 0n);
      await this.onChain('deposit', () => on.chain.deposit(plan.buyerId, on.chainPlanId, total));
    }
    onProgress?.('recibido');
    const txIds: string[] = [];
    for (let k = 0; k < rows.length; k += 1) {
      const { txId } = await this.offRampPay(quote.quoteId, usdEach[k]!, plan.encargoRef, `M${rows[k]!.idx + 1}`);
      txIds.push(txId);
    }
    onProgress?.('convertido');
    if (on) {
      for (let k = 0; k < rows.length; k += 1) {
        const row = rows[k]!;
        const rel = await this.onChain('release_spot', () => on.chain.releaseSpot(on.chainPlanId, row.idx, stroopsEach[k]!));
        txIds[k] = rel.txHash;
      }
    }
    const receipts: Receipt[] = [];
    for (let k = 0; k < rows.length; k += 1) {
      receipts.push(await this.settleAndRecord({ plan, row: rows[k]!, usdPaid: usdEach[k]!, locked: false, anchorRate: quote.rate, txId: txIds[k]!, breakCostCop: 0, state: s }));
      await this.notifyPaid(plan, rows[k]!, receipts[k]!);
    }
    onProgress?.('entregado');
    return receipts;
  }

  private async onRampDeposit(buyerId: string, usdAmount: number, memo: string): Promise<void> {
    try {
      const d = await this.providers.onRamp.initiateDeposit({ buyerId, usdAmount, memo });
      if (d.status === 'error') throw new Error('deposit failed');
    } catch (e) {
      throw new ApiError('PROVIDER', 'on-ramp failed', e);
    }
  }

  private async offRampQuote(req: OffRampQuoteRequest): Promise<OffRampQuote> {
    try {
      return await this.providers.offRamp.quote(req);
    } catch (e) {
      throw new ApiError('PROVIDER', 'off-ramp quote failed', e);
    }
  }

  private async offRampPay(quoteId: string, usd: number, beneficiaryRef: string, memo: string): Promise<{ txId: string }> {
    try {
      return await this.providers.offRamp.pay({ quoteId, usdc: usd.toFixed(7), beneficiaryRef, memo });
    } catch (e) {
      throw new ApiError('PROVIDER', 'off-ramp payment failed', e);
    }
  }

  private async settleAndRecord(a: {
    plan: Plan;
    row: Installment;
    usdPaid: number;
    locked: boolean;
    anchorRate: number;
    txId: string;
    breakCostCop: number;
    state: DemoState;
  }): Promise<Receipt> {
    const fixing = this.spot();
    let leg: HedgeLeg | undefined;
    let settlementCop: number | null = null;
    if (a.locked && a.row.lockId) {
      leg = await this.store.get('hedge_legs', `leg-${a.row.lockId}-${a.row.idx}`);
      if (leg?.tradeId) {
        try {
          const settlements = await this.providers.hedge.getSettlements(leg.dueDate, leg.dueDate);
          const st = settlements.find((x) => x.tradeId === leg!.tradeId);
          if (st) {
            settlementCop = st.copAmount;
            const settledAt = await this.demoTimestamp();
            await this.store.upsert('hedge_legs', { ...leg, settledCop: st.copAmount, fixing: st.fixing, settledAt, state: 'liquidada' });
            const trade = await this.store.get('hedge_trades', leg.tradeId);
            if (trade) await this.store.upsert('hedge_trades', { ...trade, settledCop: st.copAmount, fixing: st.fixing });
          }
        } catch (e) {
          throw new ApiError('PROVIDER', 'hedge settlement failed', e);
        }
      }
    }
    const receipt = makeReceipt({
      plan: a.plan,
      installment: a.row,
      paidAt: await this.demoTimestamp(),
      usdPaid: a.usdPaid,
      rateKind: a.locked ? 'locked' : 'spot',
      lockedRate: a.locked ? a.row.lockedRate : null,
      fixing,
      anchorRate: a.anchorRate,
      lockId: a.row.lockId,
      hedgeTradeId: leg?.tradeId ?? null,
      ndfSettlementCop: settlementCop,
      fwdRate: leg?.fwdRate ?? null,
      breakCostCop: a.breakCostCop,
    });
    receipt.txHash = a.txId;
    receipt.id = `rcpt-${a.plan.id}-${a.row.idx}`;
    await this.store.upsert('receipts', receipt);
    await this.store.upsert('installments', { ...a.row, status: 'released', usdDue: a.usdPaid, releasedTx: a.txId, releasedAt: receipt.paidAt, receiptId: receipt.id });
    const staleOffers = (await this.store.all('renewal_offers')).filter((o) => o.planId === a.plan.id && o.state === 'ofrecido' && o.idxs.includes(a.row.idx));
    for (const o of staleOffers) await this.store.upsert('renewal_offers', { ...o, state: 'descartado' });
    if (a.row.lockId) await this.refreshLockState(a.row.lockId);
    return receipt;
  }

  private async refreshLockState(lockId: string): Promise<void> {
    const lock = await this.store.get('locks', lockId);
    if (!lock || lock.state === 'roto' || lock.state === 'vencido') return;
    const installments = (await this.store.all('installments')).filter((i) => i.planId === lock.planId);
    const legs = (await this.store.all('hedge_legs')).filter((l) => l.lockId === lockId);
    const allReleased = lock.idxs.every((i) => installments.find((x) => x.idx === i)?.status === 'released');
    const allSettled = legs.length > 0 && legs.every((l) => l.state === 'liquidada');
    const state: Lock['state'] = allReleased && allSettled ? 'cerrado' : allReleased ? 'consumido' : 'activo';
    if (state !== lock.state) await this.store.upsert('locks', { ...lock, state });
  }

  // ---------- treasury ----------

  async bookStrip(): Promise<HedgeTrade[]> {
    await this.state();
    this.runtime.guard('bookStrip');
    const pending = (await this.store.all('hedge_legs')).filter((l) => l.state === 'pendiente').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    if (pending.length === 0) throw new ApiError('NOTHING_TO_BOOK');
    let booked;
    try {
      booked = await this.providers.hedge.bookStrip(pending.map((l) => ({ dueDate: l.dueDate, usdNotional: l.usdNotional, fwdRate: l.fwdRate })));
    } catch (e) {
      throw new ApiError('PROVIDER', 'hedge provider failed', e);
    }
    const bookedAt = new Date(this.now()).toISOString();
    const trades: HedgeTrade[] = booked.map((b, k) => ({
      id: b.tradeId,
      provider: this.providers.hedge.name,
      dueDate: b.dueDate,
      usdNotional: pending[k]!.usdNotional,
      rate: b.rate,
      banrepRef: b.banrepRef ?? '',
      bookedAt,
      settledCop: null,
      fixing: null,
    }));
    await this.store.upsertMany('hedge_trades', trades);
    await this.store.upsertMany(
      'hedge_legs',
      pending.map((l, k) => ({ ...l, tradeId: trades[k]!.id, bookedAt, state: 'reservada' as const })),
    );
    return trades;
  }

  async setPassThrough(passThrough: number): Promise<DemoState> {
    if (!(passThrough >= 0 && passThrough <= 1)) throw new ApiError('NOT_FOUND', 'pass-through must be 0..1');
    await this.runtime.delay(0.3);
    return this.saveState({ passThrough });
  }

  // ---------- demo controls ----------

  async advanceClock(months = 1): Promise<DemoState> {
    const s = await this.state();
    const offset = s.clockOffsetMonths + months;
    const next = await this.saveState({ clockOffsetMonths: offset, today: addMonths(s.baseDate, offset) });
    await this.runDailyJobs(next);
    await sv.runSvDailyJobs(this.svContext());
    return next;
  }

  /** Jobs the backend runs daily: break-check (grace exceeded) and renewal offers. */
  private async runDailyJobs(s: DemoState): Promise<void> {
    const spot = this.spot();
    const installments = await this.store.all('installments');
    const locks = await this.store.all('locks');
    const legs = await this.store.all('hedge_legs');

    for (const row of installments) {
      if (row.status !== 'locked' || !row.lockId) continue;
      if (!isBeyondGrace(s.today, row.dueDate)) continue;
      const leg = legs.find((l) => l.id === `leg-${row.lockId}-${row.idx}`);
      const cost = breakCost(spot, leg?.fwdRate ?? row.lockedRate ?? spot, leg?.usdNotional ?? usdDue(row.copDue, row.lockedRate ?? spot));
      try {
        if (this.chain) {
          const chainPlanId = s.chainPlans?.[row.planId];
          if (chainPlanId != null) await this.chain.breakLock(chainPlanId, row.idx);
        } else {
          await this.providers.lock.break({ lockId: row.lockId, planId: row.planId, idx: row.idx });
        }
      } catch {
        // The break is recorded anyway; on chain it is retried before the installment is paid at
        // spot (see `retryBreakOnChain`), which covers a lock still inside its demo expiry.
      }
      await this.store.upsert('installments', { ...row, status: 'broken', lockedRate: null, usdDue: null, breakCostCop: cost });
      if (leg) await this.store.upsert('hedge_legs', { ...leg, state: 'rota', settledCop: leg.settledCop ?? roundCop((leg.fwdRate - spot) * leg.usdNotional), fixing: leg.fixing ?? spot });
      const lock = locks.find((l) => l.id === row.lockId);
      if (lock) await this.store.upsert('locks', { ...lock, state: 'roto', brokenIdx: lock.brokenIdx ?? row.idx, breakCostCop: (lock.breakCostCop ?? 0) + cost });
    }

    const offers = await this.store.all('renewal_offers');
    const freshInstallments = await this.store.all('installments');
    for (const lock of locks.filter((l) => l.state === 'activo')) {
      const last = lock.idxs[lock.idxs.length - 1]!;
      const lastRow = freshInstallments.find((i) => i.planId === lock.planId && i.idx === last);
      if (!lastRow || !shouldOfferRenewal(s.today, lastRow.dueDate)) continue;
      const nextIdxs = nextLockableIdxs(freshInstallments.filter((x) => x.planId === lock.planId && x.idx > last), 'trimestral');
      if (!nextIdxs) continue;
      if (offers.some((o) => o.planId === lock.planId && o.state === 'ofrecido' && o.idxs[0] === nextIdxs[0])) continue;
      const offer: RenewalOffer = { id: `offer-${lock.planId}-${nextIdxs[0]}`, planId: lock.planId, tenor: 'trimestral', idxs: nextIdxs, offeredAt: s.today, state: 'ofrecido' };
      await this.store.upsert('renewal_offers', offer);
      const plan = await this.store.get('plans', lock.planId);
      const buyer = plan ? await this.store.get('buyers', plan.buyerId) : undefined;
      if (plan && buyer) {
        await sv.notify(this.svContext(), { plan, buyer, template: 'renovacion_bloqueo', idx: nextIdxs[0]!, params: { date: lastRow.dueDate, n: `${nextIdxs[0]! + 1}–${nextIdxs[nextIdxs.length - 1]! + 1}` }, once: 'installment' });
      }
    }

    for (const lock of locks.filter((l) => l.state === 'cotizado' && isQuoteExpired(l.quoteExpiresAt, this.now()))) {
      await this.store.upsert('locks', { ...lock, state: 'vencido' });
    }
    void compareISO;
  }

  async reset(): Promise<{ state: DemoState; elapsedMs: number }> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const seed = buildSeed();
    if (this.chain || Object.keys(this.chains).length > 0) {
      // Testnet: fresh plans on chain (new plan ids), seeded in parallel (each on its own channel
      // accounts); the mapping lives in demo_state so every later call finds its chain plan. The
      // adverse-event demo plans stay off chain (mock-seed only). Each plan goes to the bridge of
      // its own corridor and to no other; a corridor without a bridge stays off chain.
      const before = await this.store.get('demo_state', 'singleton');
      const chainPlans: Record<string, number> = {};
      const simulatedPlans: Record<string, string> = {};
      const chainContractIds: Partial<Record<CorridorId, string>> = {};
      for (const [id, bridge] of Object.entries(this.chains) as [CorridorId, ChainBridge][]) chainContractIds[id] = bridge.contractId;
      await Promise.all(
        seed.plans
          .filter((p) => !ADVERSE_DEMO_PLANS.includes(p.id))
          .map(async (plan) => {
            const chain = this.chainFor(plan);
            if (!chain) return;
            const installments = seed.installments.filter((i) => i.planId === plan.id);
            const seedState = { locks: seed.locks.filter((l) => l.planId === plan.id), receipts: seed.receipts.filter((r) => r.planId === plan.id) };
            try {
              chainPlans[plan.id] = (await chain.seedPlan(plan, installments, seedState)).chainPlanId;
            } catch (e) {
              if (!(e instanceof ChainError && e.errorName === 'FeeTooHigh')) return this.onChain(`seed ${plan.id}`, () => Promise.reject(e));
              // The network refused create_plan: its fee is above what one transaction can carry
              // (rent on new entries while testnet state is above its target). Nothing is retried
              // and nothing is spent. A chain plan this instance already holds for the plan is
              // kept and shown as it stands on chain; otherwise the plan runs off chain, marked.
              const kept = before?.chainContractIds?.[corridorIdOf(plan)] === chain.contractId ? before.chainPlans?.[plan.id] : undefined;
              if (kept != null && (await chain.getStatus(kept).then(() => true, () => false))) {
                chainPlans[plan.id] = kept;
                this.log(`reset: ${plan.id}: create_plan refused (${e.message}); kept existing chain plan #${kept} as it stands on chain`);
                return;
              }
              simulatedPlans[plan.id] = `simulado: ${e.message}`;
              this.log(`reset: ${plan.id}: create_plan refused (${e.message}); the plan runs off chain, marked simulado`);
            }
          }),
      );
      seed.demo_state[0] = {
        ...seed.demo_state[0]!,
        mode: 'testnet',
        chainContractId: (this.chain ?? Object.values(this.chains)[0])?.contractId,
        chainContractIds,
        chainPlans,
        ...(Object.keys(simulatedPlans).length > 0 ? { simulatedPlans } : {}),
      };
    }
    await this.store.replaceAll(seed);
    this.sessionStartMs = this.now();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsedMs = Math.round((t1 - t0) * 10) / 10;
    const state = await this.saveState({ errorMode: false, lastResetMs: elapsedMs });
    return { state, elapsedMs };
  }

  async setErrorMode(on: boolean): Promise<DemoState> {
    return this.saveState({ errorMode: on });
  }

  // ---------- El Salvador corridor and the office portals (services/src/api/svApi.ts) ----------

  /** Reads go through the runtime guard (error mode, latency) like every other read. */
  private async svRead<T>(op: string, run: (ctx: sv.SvContext) => Promise<T>): Promise<T> {
    await this.guardedRead(op);
    return run(this.svContext());
  }

  /** Writes check the state and the error switch first, then run with the corridor context. */
  private async svWrite<T>(op: string, run: (ctx: sv.SvContext) => Promise<T>): Promise<T> {
    await this.state();
    this.runtime.guard(op);
    return run(this.svContext());
  }

  async listOffices(): Promise<Office[]> {
    return this.svRead('listOffices', (ctx) => sv.listOffices(ctx));
  }
  async getPayOptions(planId: string, idx: number): Promise<PayOptionsView> {
    return this.svRead('getPayOptions', (ctx) => sv.getPayOptions(ctx, planId, idx));
  }
  async requestCashReference(planId: string, idx: number): Promise<PaymentView> {
    return this.svWrite('requestCashReference', async (ctx) => sv.paymentView(await sv.requestCashReference(ctx, planId, idx), ctx.nowMs()));
  }
  async renewCashReference(paymentId: string): Promise<PaymentView> {
    return this.svWrite('renewCashReference', async (ctx) => sv.paymentView(await sv.renewCashReference(ctx, paymentId), ctx.nowMs()));
  }
  async completeCashReference(paymentId: string, onProgress?: ProgressFn): Promise<Receipt> {
    return this.svWrite('completeCashReference', (ctx) => sv.completeCashReference(ctx, paymentId, onProgress));
  }
  async getPayment(paymentId: string): Promise<PaymentView> {
    return this.svRead('getPayment', async (ctx) => sv.paymentView(await sv.getPayment(ctx, paymentId), ctx.nowMs()));
  }
  async listPayments(filter?: { planId?: string; officeId?: string; cashierId?: string; date?: ISODate; status?: Payment['status'] }): Promise<PaymentView[]> {
    return this.svRead('listPayments', async (ctx) => {
      const nowMs = ctx.nowMs();
      return (await sv.listPayments(ctx, filter)).map((p) => sv.paymentView(p, nowMs));
    });
  }
  async searchBuyers(query: string): Promise<CounterSearchResult[]> {
    return this.svRead('searchBuyers', (ctx) => sv.searchBuyers(ctx, query));
  }
  async takeCounterPayment(
    args: { planId: string; idx: number; tender: Tender; amountReceived: number; officeId: string; cashierId: string },
    onProgress?: ProgressFn,
  ): Promise<{ payment: PaymentView; receipt: Receipt }> {
    return this.svWrite('takeCounterPayment', async (ctx) => {
      const r = await sv.takeCounterPayment(ctx, args, onProgress);
      return { ...r, payment: sv.paymentView(r.payment, ctx.nowMs()) };
    });
  }
  async getShiftTotal(args: { officeId: string; cashierId: string }): Promise<ShiftTotal> {
    return this.svRead('getShiftTotal', (ctx) => sv.getShiftTotal(ctx, args));
  }
  async sendReceiptMessage(planId: string, idx: number): Promise<OutboxMessage> {
    return this.svWrite('sendReceiptMessage', (ctx) => sv.sendReceiptMessage(ctx, planId, idx));
  }
  async listPlanRows(): Promise<PlanRow[]> {
    return this.svRead('listPlanRows', (ctx) => sv.listPlanRows(ctx));
  }
  async listSellers(): Promise<SellerView[]> {
    return this.svRead('listSellers', (ctx) => sv.listSellers(ctx));
  }
  async getSeller(sellerId: string): Promise<SellerView> {
    return this.svRead('getSeller', (ctx) => sv.getSeller(ctx, sellerId));
  }
  async setSellerVerification(sellerId: string, status: 'verified' | 'paused' | 'rejected', note?: string): Promise<SellerView> {
    return this.svWrite('setSellerVerification', (ctx) => sv.setSellerVerification(ctx, sellerId, status, note));
  }
  async changeSellerPayoutAccount(sellerId: string, account: PayoutAccount): Promise<SellerView> {
    return this.svWrite('changeSellerPayoutAccount', (ctx) => sv.changeSellerPayoutAccount(ctx, sellerId, account));
  }
  async raiseCnrAlert(sellerId: string, unitId: string, detail: string): Promise<SellerView> {
    return this.svWrite('raiseCnrAlert', (ctx) => sv.raiseCnrAlert(ctx, sellerId, unitId, detail));
  }
  async listPayouts(filter?: { planId?: string; sellerId?: string }): Promise<PayoutView[]> {
    return this.svRead('listPayouts', (ctx) => sv.listPayouts(ctx, filter));
  }
  async retryPayout(payoutId: string): Promise<PayoutView> {
    return this.svWrite('retryPayout', (ctx) => sv.retryPayout(ctx, payoutId));
  }
  async listOutbox(planId?: string): Promise<OutboxMessage[]> {
    return this.svRead('listOutbox', (ctx) => sv.listOutbox(ctx, planId));
  }
  async runAdverseAction(action: AdverseAction, detail?: string): Promise<PlanView> {
    return this.svWrite('runAdverseAction', (ctx) => sv.runAdverseAction(ctx, action, detail));
  }

  /** Runs the corridor's daily jobs on the current demo day (what `advanceClock` runs after moving the clock). */
  async runDailyJobsNow(): Promise<sv.SvJobsReport> {
    await this.state();
    return sv.runSvDailyJobs(this.svContext());
  }

  /** Current wall-clock time in ms (injected for tests). */
  nowMs(): number {
    return this.now();
  }

  /** Expose the demo clock offset without a read delay (used by UI chrome). */
  clockOffsetMonths(): number {
    return this.offset;
  }

  /** Quote-independent helper for UI copy: the spot rate right now. */
  spotNow(): number {
    return this.spot();
  }

  static nextMonthOf(today: ISODate): ISODate {
    return addMonths(today, 1);
  }

  static isoNow(): string {
    return nowISO();
  }
}
