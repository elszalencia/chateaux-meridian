// El Salvador corridor orchestration and the office portals, as functions over a small context
// the DemoApi hands in (store, providers, clocks, chain seam, message channel, governance seam).
// DemoApi delegates to these so the façade stays readable. Nothing here names a country: every
// rule reads `corridorOf(plan)` (pay methods, fees, limits, window, templates, calendar).
//
// Money model (decided for the corridor): the amount fields hold cents (`copDue` 75000 = USD
// 750.00). Payment.amount = installment cents, Payment.fee = method fee cents. On a receipt
// usdPaid = installment + fee, feeUsd = fee, usdDelivered = usdPaid − feeUsd = installment, and
// copCredited = copDelivered = anchorCop = the cents delivered to the seller. Payout.usdPaid −
// feeUsd = usdToSeller to the cent, asserted before any payout row is written.
//
// Credit and release are two steps. `creditInstallment` runs when money arrives (ACH, counter, or
// a MoneyGram reference the network reports completed): deposit on chain, the Receipt (always
// written at credit time), `fundedAt` on the installment, and `pago_recibido`. `releaseInstallment`
// runs when the due date has arrived: the seller gate first (a blocked gate writes the Payout as
// `retenido` with the reason and leaves the installment funded), then `release_spot` with exactly
// cents × 100,000 stroops, the payout through the seller's option (A: UsdcHold → `transferido`;
// B: UsdBankPayout → `enviado` and later `en_transito` → `acreditado`), and `pago_entregado`.
// The daily jobs release funded installments that fell due, retry held payouts whose gate cleared,
// walk the option B statuses, settle payout-account cooling-offs, expire stale references and send
// the reminder and late notices the corridor lists.

import type {
  Buyer,
  CounterSearchResult,
  Installment,
  ISODate,
  ISODateTime,
  Office,
  OutboxMessage,
  PayOptionsView,
  PayOptionView,
  Payment,
  PaymentView,
  Payout,
  PayoutAccount,
  PayoutView,
  PayStep,
  Plan,
  PlanRow,
  PlanView,
  Receipt,
  Seller,
  SellerGateReason,
  SellerView,
  ShiftTotal,
  Tender,
  Unit,
  WhatsAppTemplate,
} from '../domain/types';
import type { Store } from '../store/Store';
import type { CashInProvider, Providers, SellerPayoutProvider, SellerPayoutTransfer } from '../adapters/interfaces';
import { MoneyGramError, MoneyGramOnRamp } from '../adapters/moneyGramOnRamp';
import { MockRuntime, mockTxHash } from '../adapters/mockRuntime';
import type { ChainBridge } from '../chain/bridge';
import type { MessageChannel } from '../channels/MessageChannel';
import { deepLinkFor } from '../channels/MessageChannel';
import { corridorOf, minorToMajor, minorToStroops, type Corridor, type PayoutOption } from '../corridors/index';
import { addBusinessDaysIn, addDays, compareISO } from '../domain/dates';
import type { GovernanceProvider } from '../policy/GovernanceProvider';
import { GovernanceProviderError } from '../policy/GovernanceProvider';
import { performAdverseAction } from '../policy/adverseEvents';
import { REASONS, reasonInfo } from '../policy/reasons';
import { TransitionError, fundsAllowed, type AdverseAction } from '../policy/transitions';
import { assertSellerReleasable, SellerGateError, sellerGate } from '../sellers/gate';
import { SellerTransitionError, changePayoutAccount, sellerView, setVerification, settlePayoutAccountChange } from '../sellers/sellers';
import { ApiError } from './errors';
import { beyondGraceIn, buildPayoutViews, buildPlanRows, counterSearch, installmentView, payoutReconciles, shiftTotal } from './views';

export type ProgressFn = (completedStep: PayStep) => void;

export interface PlanBundle {
  plan: Plan;
  buyer: Buyer;
  unit: Unit;
  installments: Installment[];
}

/** What the DemoApi lends the corridor functions. */
export interface SvContext {
  store: Store;
  providers: Providers;
  cashIn: CashInProvider;
  payoutRail: (option: PayoutOption) => SellerPayoutProvider;
  runtime: MockRuntime;
  /** The corridor's session clock in ms (the demo date plus the time elapsed in the session). */
  nowMs: () => number;
  /** Corridors with an FX leg ('convertido' pay step): pricing in USD and the conversion that follows. */
  fx: FxRail;
  today: () => Promise<ISODate>;
  spot: () => number;
  /** The plan's own corridor bridge and chain plan id, or null when the plan stays off chain. */
  chainPlanOf: (plan: Plan) => Promise<{ chain: ChainBridge; chainPlanId: number } | null>;
  onChain: <T>(what: string, run: () => Promise<T>) => Promise<T>;
  messages: MessageChannel;
  governance: () => GovernanceProvider;
  viewOf: (planId: string) => Promise<PlanView>;
  planBundle: (planId: string) => Promise<PlanBundle>;
  assertFundsAllowed: (planId: string) => Promise<void>;
}

/**
 * The FX leg of a corridor that converts (Colombia), as the counter uses it: what the buyer owes in
 * USD now (the locked amount, or the off-ramp quote for the exact pesos due) and, once the cash is
 * in, the conversion, release and receipt the buyer's own payment would run.
 */
export interface FxRail {
  charge(plan: Plan, row: Installment): Promise<{ usdPaid: number; settle: (onProgress?: ProgressFn) => Promise<Receipt> }>;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const cents = (usd: number): number => Math.round(usd * 100);
const usdText = (usd: number): string => usd.toFixed(2);
const e164 = (phone: string): string => `+${phone.replace(/\D/g, '')}`;
const firstName = (name: string): string => name.split(' ')[0] ?? name;

export function nowIso(ctx: SvContext): ISODateTime {
  return new Date(ctx.nowMs()).toISOString();
}

/**
 * A payment as the API hands it out, stamped with the session clock. `pendingMinutes` counts whole
 * minutes since a pending cash reference was issued (null for anything else), so the counter's
 * "pending for more than N minutes" flag and the buyer's countdown read the services' clock.
 */
export function paymentView(p: Payment, nowMs: number): PaymentView {
  const pending = p.method === 'moneygram_cash' && p.status === 'pending';
  return {
    ...p,
    now: new Date(nowMs).toISOString(),
    pendingMinutes: pending ? Math.max(0, Math.floor((nowMs - Date.parse(p.createdAt)) / 60_000)) : null,
  };
}

/** The ApiError code for a seller gate reason (`seller_cooling_off` → `SELLER_COOLING_OFF`). */
export function gateErrorCode(reason: SellerGateReason): 'SELLER_UNVERIFIED' | 'SELLER_PAUSED' | 'SELLER_REJECTED' | 'SELLER_COOLING_OFF' | 'CNR_ALERT' {
  return reason.toUpperCase() as ReturnType<typeof gateErrorCode>;
}

// ---------- Messages ----------

type Once = 'installment' | 'day' | null;

/**
 * Sends a template through the channel when the plan's corridor lists it. `once` makes the send
 * idempotent: per installment (reminders, late and paid notices) or per demo day (plan paused).
 * Returns null when the corridor does not list the template or the message was already sent.
 */
export async function notify(
  ctx: SvContext,
  a: { plan: Plan; buyer: Buyer; template: WhatsAppTemplate; idx: number | null; params: Record<string, string | number>; once: Once },
): Promise<OutboxMessage | null> {
  const c = corridorOf(a.plan);
  if (!c.whatsappTemplates.includes(a.template)) return null;
  if (a.once) {
    const today = await ctx.today();
    const sent = (await ctx.store.all('wa_outbox')).some(
      (m) => m.planId === a.plan.id && m.template === a.template && (a.idx == null || Number(m.params.n) === a.idx + 1) && (a.once === 'installment' || m.createdAt.slice(0, 10) === today),
    );
    if (sent) return null;
  }
  const params = a.idx == null ? a.params : { n: a.idx + 1, ...a.params };
  return ctx.messages.send({
    planId: a.plan.id,
    buyerId: a.buyer.id,
    to: e164(a.buyer.phone),
    template: a.template,
    locale: a.buyer.lang ?? 'es',
    params: { name: firstName(a.buyer.name), ...params },
    link: deepLinkFor(a.template, a.plan.id, a.idx),
  });
}

// ---------- Lazy expiry ----------

/** Pending references past `expiresAt` become `quote_expired` on every read, so nothing credits late. */
export async function refreshReferences(ctx: SvContext): Promise<void> {
  const now = ctx.nowMs();
  const pending = (await ctx.store.all('payments')).filter((p) => p.status === 'pending' && p.expiresAt && Date.parse(p.expiresAt) <= now);
  if (pending.length === 0) return;
  await ctx.store.upsertMany('payments', pending.map((p) => ({ ...p, status: 'quote_expired' as const })));
  for (const p of pending) if (p.externalRef) await ctx.cashIn.simulateExpired(p.externalRef).catch(() => undefined);
}

// ---------- Pay options ----------

async function payableRow(ctx: SvContext, b: PlanBundle, idx: number): Promise<Installment> {
  const row = b.installments[idx];
  if (!row) throw new ApiError('NOT_FOUND', `installment ${idx}`);
  if (row.status === 'released' || row.fundedAt) throw new ApiError('ALREADY_PAID');
  if (row.status === 'missed' || row.status === 'waived') throw new ApiError('INSTALLMENT_MISSED', `installment is ${row.status}`);
  await ctx.assertFundsAllowed(b.plan.id);
  const view = installmentView(row, await ctx.today(), ctx.spot(), [], corridorOf(b.plan));
  if (!view.payable) throw new ApiError('NOT_DUE_YET', `M${idx + 1} is due ${row.dueDate}; the pay window opens ${corridorOf(b.plan).payWindowDays} days before`);
  return row;
}

/** The buyer's office, or the corridor's first licensed agency, or any office of the corridor. */
export async function officeFor(ctx: SvContext, plan: Plan, buyer: Buyer): Promise<Office | null> {
  const offices = (await ctx.store.all('offices')).filter((o) => o.corridor === corridorOf(plan).id);
  return (buyer.officeId ? offices.find((o) => o.id === buyer.officeId) : undefined) ?? offices.find((o) => o.isLicensedAgency) ?? offices[0] ?? null;
}

export async function getPayOptions(ctx: SvContext, planId: string, idx: number): Promise<PayOptionsView> {
  await refreshReferences(ctx);
  const b = await ctx.planBundle(planId);
  const row = await payableRow(ctx, b, idx);
  const c = corridorOf(b.plan);
  const view = installmentView(row, await ctx.today(), ctx.spot(), [], c);
  const usdDue = view.usdShown;
  const payments = (await ctx.store.all('payments')).filter((p) => p.planId === planId && p.idx === idx);
  const now = ctx.nowMs();
  const options: PayOptionView[] = [];
  for (const method of c.payMethods) {
    const feeUsd = c.feesUsd[method];
    const base = { method, enabled: true, disabledReason: null, feeUsd, totalUsd: round2(usdDue + feeUsd), office: null, payment: null, limits: null } satisfies PayOptionView;
    if (method === 'moneygram_cash') {
      if (!c.moneyGram) continue;
      const code = MoneyGramOnRamp.check({ amountUsd: usdDue, buyerState: b.buyer.state }, c.moneyGram);
      if (code === 'STATE_EXCLUDED') continue; // hidden, not listed
      const open = payments
        .filter((p) => p.method === 'moneygram_cash' && (p.status === 'pending' || p.status === 'quote_expired'))
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
      options.push({
        ...base,
        enabled: code == null,
        disabledReason: code === 'ABOVE_LIMIT' ? 'above_limit' : code === 'BELOW_LIMIT' ? 'below_limit' : null,
        payment: open ? paymentView(open, now) : null,
        limits: { minUsd: c.moneyGram.minUsd, maxUsd: c.moneyGram.maxUsd },
      });
    } else if (method === 'office_counter') {
      options.push({ ...base, office: await officeFor(ctx, b.plan, b.buyer) });
    } else {
      options.push(base);
    }
  }
  return { planId, idx, number: idx + 1, dueDate: row.dueDate, usdDue, options, now: new Date(now).toISOString() };
}

// ---------- Payments ----------

async function nextPaymentId(ctx: SvContext, planId: string, idx: number): Promise<string> {
  const n = (await ctx.store.all('payments')).filter((p) => p.planId === planId && p.idx === idx).length;
  return n === 0 ? `pay-${planId}-${idx}` : `pay-${planId}-${idx}-${n + 1}`;
}

function newPayment(a: { id: string; plan: Plan; idx: number; method: Payment['method']; amount: number; fee: number; createdAt: ISODateTime }): Payment {
  return {
    id: a.id,
    planId: a.plan.id,
    idx: a.idx,
    method: a.method,
    amount: a.amount,
    fee: a.fee,
    status: 'pending',
    externalRef: null,
    officeId: null,
    cashierId: null,
    tender: null,
    amountReceived: null,
    changeDue: null,
    createdAt: a.createdAt,
    expiresAt: null,
    receivedAt: null,
    blockedReason: null,
    receiptId: null,
  };
}

function assertMethodOffered(c: Corridor, method: Payment['method']): void {
  if (!c.payMethods.includes(method)) throw new ApiError('METHOD_NOT_OFFERED', `${method} is not offered in corridor ${c.id}`);
}

export async function requestCashReference(ctx: SvContext, planId: string, idx: number): Promise<Payment> {
  await refreshReferences(ctx);
  const b = await ctx.planBundle(planId);
  const c = corridorOf(b.plan);
  assertMethodOffered(c, 'moneygram_cash');
  if (!c.moneyGram) throw new ApiError('METHOD_NOT_OFFERED', 'no cash-in network in this corridor');
  const row = await payableRow(ctx, b, idx);
  const usdDue = minorToMajor(row.copDue, c);
  const code = MoneyGramOnRamp.check({ amountUsd: usdDue, buyerState: b.buyer.state }, c.moneyGram);
  const existing = (await ctx.store.all('payments')).find((p) => p.planId === planId && p.idx === idx && p.method === 'moneygram_cash' && p.status === 'pending');
  if (code) {
    const createdAt = nowIso(ctx);
    const blocked: Payment = {
      ...newPayment({ id: await nextPaymentId(ctx, planId, idx), plan: b.plan, idx, method: 'moneygram_cash', amount: row.copDue, fee: cents(c.feesUsd.moneygram_cash), createdAt }),
      status: 'blocked',
      blockedReason: code === 'ABOVE_LIMIT' ? 'above_limit' : code === 'BELOW_LIMIT' ? 'below_limit' : 'state_excluded',
    };
    await ctx.store.upsert('payments', blocked);
    throw new ApiError(code, `${usdDue} USD for a buyer in ${b.buyer.state}`);
  }
  if (existing) return existing;
  const feeUsd = c.feesUsd.moneygram_cash;
  let session;
  try {
    session = await ctx.cashIn.createSession({
      customerIdentifier: b.buyer.id,
      buyerState: b.buyer.state,
      amountUsd: usdDue,
      memo: `${b.plan.encargoRef}-M${idx + 1}`,
      locale: b.buyer.lang ?? 'es',
      limits: c.moneyGram,
      feeUsd,
    });
  } catch (e) {
    if (e instanceof MoneyGramError) throw new ApiError(e.code, e.message, e);
    throw new ApiError('PROVIDER', 'cash-in network failed', e);
  }
  const payment: Payment = {
    ...newPayment({ id: await nextPaymentId(ctx, planId, idx), plan: b.plan, idx, method: 'moneygram_cash', amount: row.copDue, fee: cents(feeUsd), createdAt: nowIso(ctx) }),
    externalRef: session.referenceNumber,
    expiresAt: session.expiresAt,
  };
  await ctx.store.upsert('payments', payment);
  await notify(ctx, {
    plan: b.plan,
    buyer: b.buyer,
    template: 'referencia_moneygram',
    idx,
    params: { usd: usdText(round2(usdDue + feeUsd)), ref: session.referenceNumber, expiresAt: session.expiresAt, date: row.dueDate },
    once: null,
  });
  return payment;
}

export async function renewCashReference(ctx: SvContext, paymentId: string): Promise<Payment> {
  await refreshReferences(ctx);
  const old = await ctx.store.get('payments', paymentId);
  if (!old) throw new ApiError('NOT_FOUND', `payment ${paymentId}`);
  if (old.method !== 'moneygram_cash') throw new ApiError('METHOD_NOT_OFFERED', 'only a cash-in reference can be renewed');
  if (old.status === 'pending') {
    // Still payable: the buyer keeps it (a renewal only replaces an expired reference).
    if (!old.expiresAt || Date.parse(old.expiresAt) > ctx.nowMs()) return old;
    await ctx.store.upsert('payments', { ...old, status: 'quote_expired' });
  } else if (old.status !== 'quote_expired') {
    throw new ApiError('INVALID_TRANSITION', `a ${old.status} reference cannot be renewed`);
  }
  return requestCashReference(ctx, old.planId, old.idx);
}

export async function getPayment(ctx: SvContext, paymentId: string): Promise<Payment> {
  await refreshReferences(ctx);
  const p = await ctx.store.get('payments', paymentId);
  if (!p) throw new ApiError('NOT_FOUND', `payment ${paymentId}`);
  return p;
}

export async function listPayments(ctx: SvContext, f: { planId?: string; officeId?: string; cashierId?: string; date?: ISODate; status?: Payment['status'] } = {}): Promise<Payment[]> {
  await refreshReferences(ctx);
  return (await ctx.store.all('payments'))
    .filter((p) => (!f.planId || p.planId === f.planId) && (!f.officeId || p.officeId === f.officeId) && (!f.cashierId || p.cashierId === f.cashierId) && (!f.status || p.status === f.status))
    .filter((p) => !f.date || (p.receivedAt ?? p.createdAt).slice(0, 10) === f.date)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The seeded pending reference is not known to the fresh in-memory network; adopt it before asking about it. */
function adoptIfNeeded(ctx: SvContext, b: PlanBundle, p: Payment): void {
  const net = ctx.cashIn as Partial<MoneyGramOnRamp>;
  if (!p.externalRef || typeof net.adopt !== 'function' || typeof net.session !== 'function' || net.session(p.externalRef)) return;
  const c = corridorOf(b.plan);
  net.adopt({ referenceNumber: p.externalRef, customerIdentifier: b.buyer.id, memo: `${b.plan.encargoRef}-M${p.idx + 1}`, amountUsd: minorToMajor(p.amount, c), feeUsd: minorToMajor(p.fee, c), expiresAt: p.expiresAt ?? nowIso(ctx), createdAt: p.createdAt });
}

export async function completeCashReference(ctx: SvContext, paymentId: string, onProgress?: ProgressFn): Promise<Receipt> {
  await refreshReferences(ctx);
  const p = await ctx.store.get('payments', paymentId);
  if (!p) throw new ApiError('NOT_FOUND', `payment ${paymentId}`);
  if (p.method !== 'moneygram_cash' || !p.externalRef) throw new ApiError('METHOD_NOT_OFFERED', 'not a cash-in reference');
  if (p.status === 'quote_expired') throw new ApiError('REFERENCE_EXPIRED', `reference ${p.externalRef} expired ${p.expiresAt ?? ''}`);
  if (p.status === 'completed') throw new ApiError('ALREADY_PAID');
  if (p.status !== 'pending') throw new ApiError('REFERENCE_NOT_COMPLETED', `reference is ${p.status}`);
  const b = await ctx.planBundle(p.planId);
  const row = b.installments[p.idx];
  if (!row) throw new ApiError('NOT_FOUND', `installment ${p.idx}`);
  if (row.status === 'released' || row.fundedAt) throw new ApiError('ALREADY_PAID');
  await ctx.assertFundsAllowed(p.planId);
  adoptIfNeeded(ctx, b, p);
  // Demo control: the network reports the cash-in (mock), or the stand-in anchor runs the deposit.
  try {
    await ctx.cashIn.simulateCompleted(p.externalRef);
  } catch (e) {
    throw new ApiError('PROVIDER', 'cash-in network failed', e);
  }
  const status = await ctx.cashIn.referenceStatus(p.externalRef);
  if (status === 'quote_expired') {
    await ctx.store.upsert('payments', { ...p, status: 'quote_expired' });
    throw new ApiError('REFERENCE_EXPIRED', `reference ${p.externalRef} expired before the cash-in`);
  }
  if (status !== 'completed') throw new ApiError('REFERENCE_NOT_COMPLETED', `the network reports ${status} for ${p.externalRef}`);
  const received: Payment = { ...p, status: 'completed', receivedAt: nowIso(ctx) };
  await ctx.store.upsert('payments', received);
  return (await creditInstallment(ctx, { plan: b.plan, buyer: b.buyer, row, payment: received, onProgress })).receipt;
}

/** ACH for a corridor without an FX leg: the on-ramp debits installment + fee, then the plan is credited. */
export async function payDirect(ctx: SvContext, planId: string, idx: number, onProgress?: ProgressFn): Promise<Receipt> {
  await refreshReferences(ctx);
  const b = await ctx.planBundle(planId);
  const c = corridorOf(b.plan);
  assertMethodOffered(c, 'ach');
  const row = await payableRow(ctx, b, idx);
  const feeUsd = c.feesUsd.ach;
  const usdPaid = round2(minorToMajor(row.copDue, c) + feeUsd);
  let depositId: string;
  try {
    const d = await ctx.providers.onRamp.initiateDeposit({ buyerId: b.buyer.id, usdAmount: usdPaid, memo: `${b.plan.encargoRef}-M${idx + 1}` });
    if (d.status === 'error') throw new Error('deposit failed');
    depositId = d.depositId;
  } catch (e) {
    throw new ApiError('PROVIDER', 'on-ramp failed', e);
  }
  const at = nowIso(ctx);
  const payment: Payment = { ...newPayment({ id: await nextPaymentId(ctx, planId, idx), plan: b.plan, idx, method: 'ach', amount: row.copDue, fee: cents(feeUsd), createdAt: at }), status: 'completed', externalRef: depositId, receivedAt: at };
  await ctx.store.upsert('payments', payment);
  return (await creditInstallment(ctx, { plan: b.plan, buyer: b.buyer, row, payment, onProgress })).receipt;
}

// ---------- Counter ----------

export async function searchBuyers(ctx: SvContext, query: string): Promise<CounterSearchResult[]> {
  await refreshReferences(ctx);
  const [buyers, plans, units, installments, governance] = await Promise.all([
    ctx.store.all('buyers'),
    ctx.store.all('plans'),
    ctx.store.all('units'),
    ctx.store.all('installments'),
    ctx.store.all('plan_governance'),
  ]);
  return counterSearch(query, { buyers, plans, units, installments, today: await ctx.today(), spot: ctx.spot(), governance });
}

export async function takeCounterPayment(
  ctx: SvContext,
  a: { planId: string; idx: number; tender: Tender; amountReceived: number; officeId: string; cashierId: string },
  onProgress?: ProgressFn,
): Promise<{ payment: Payment; receipt: Receipt }> {
  await refreshReferences(ctx);
  const office = await ctx.store.get('offices', a.officeId);
  if (!office) throw new ApiError('NOT_FOUND', `office ${a.officeId}`);
  if (!a.cashierId.trim()) throw new ApiError('NOT_FOUND', 'cashier id required');
  const b = await ctx.planBundle(a.planId);
  const c = corridorOf(b.plan);
  assertMethodOffered(c, 'office_counter');
  if (office.corridor !== c.id) throw new ApiError('METHOD_NOT_OFFERED', `office ${office.id} serves corridor ${office.corridor}`);
  const row = await payableRow(ctx, b, a.idx);
  // The counter takes dollars in every corridor: `amountReceived`, the amount due and the change
  // are US cents. A corridor with an FX leg prices the installment in USD first (locked amount or
  // the quote for the exact pesos); the others hold USD cents in the installment already.
  const fx = c.paySteps.includes('convertido') ? await ctx.fx.charge(b.plan, row) : null;
  const usdOwed = fx ? fx.usdPaid : minorToMajor(row.copDue, c);
  const fee = cents(c.feesUsd.office_counter);
  const due = cents(usdOwed) + fee;
  // A card is charged exactly the amount due; cash must cover it.
  if (a.tender === 'cash' && (!Number.isInteger(a.amountReceived) || a.amountReceived < due)) throw new ApiError('INSUFFICIENT_CASH', `received ${a.amountReceived}, due ${due} (US cents)`);
  const at = nowIso(ctx);
  const ticket = `${office.id.slice(0, 2).toUpperCase()}-${mockTxHash(`${a.planId}:${a.idx}:${at}`).slice(0, 8).toUpperCase()}`;
  const payment: Payment = {
    ...newPayment({ id: await nextPaymentId(ctx, a.planId, a.idx), plan: b.plan, idx: a.idx, method: 'office_counter', amount: row.copDue, fee, createdAt: at }),
    status: 'completed',
    externalRef: ticket,
    officeId: office.id,
    cashierId: a.cashierId,
    tender: a.tender,
    amountReceived: a.tender === 'card' ? due : a.amountReceived,
    changeDue: a.tender === 'card' ? 0 : a.amountReceived - due,
    receivedAt: at,
  };
  await ctx.store.upsert('payments', payment);
  if (fx) {
    const receipt = await fx.settle(onProgress);
    const recorded: Payment = { ...payment, receiptId: receipt.id };
    await ctx.store.upsert('payments', recorded);
    return { payment: recorded, receipt };
  }
  const { receipt } = await creditInstallment(ctx, { plan: b.plan, buyer: b.buyer, row, payment, onProgress });
  return { payment: (await ctx.store.get('payments', payment.id)) ?? payment, receipt };
}

export async function getShiftTotal(ctx: SvContext, a: { officeId: string; cashierId: string }): Promise<ShiftTotal> {
  return shiftTotal({ payments: await ctx.store.all('payments'), plans: await ctx.store.all('plans'), officeId: a.officeId, cashierId: a.cashierId, date: await ctx.today() });
}

export async function sendReceiptMessage(ctx: SvContext, planId: string, idx: number): Promise<OutboxMessage> {
  const b = await ctx.planBundle(planId);
  const row = b.installments[idx];
  if (!row) throw new ApiError('NOT_FOUND', `installment ${idx}`);
  const receipt = row.receiptId ? await ctx.store.get('receipts', row.receiptId) : undefined;
  if (!receipt) throw new ApiError('NOT_FOUND', `no receipt for M${idx + 1}`);
  const seller = b.plan.sellerId ? await ctx.store.get('sellers', b.plan.sellerId) : undefined;
  const template: WhatsAppTemplate = row.status === 'released' ? 'pago_entregado' : 'pago_recibido';
  const msg = await notify(ctx, {
    plan: b.plan,
    buyer: b.buyer,
    template,
    idx,
    params: { usd: usdText(receipt.usdDelivered ?? receipt.usdPaid), seller: seller?.tradeName ?? b.plan.trustCompany, date: receipt.paidAt.slice(0, 10) },
    once: null,
  });
  if (!msg) throw new ApiError('METHOD_NOT_OFFERED', `the corridor does not send ${template}`);
  return msg;
}

// ---------- Credit and release ----------

export interface CreditResult {
  receipt: Receipt;
  released: boolean;
  payout: Payout | null;
}

export async function creditInstallment(ctx: SvContext, a: { plan: Plan; buyer: Buyer; row: Installment; payment: Payment; onProgress?: ProgressFn }): Promise<CreditResult> {
  const c = corridorOf(a.plan);
  await ctx.assertFundsAllowed(a.plan.id);
  const usdDelivered = minorToMajor(a.row.copDue, c);
  const feeUsd = minorToMajor(a.payment.fee, c);
  const usdPaid = round2(usdDelivered + feeUsd);
  const paidAt = nowIso(ctx);
  let txHash = mockTxHash(`${a.plan.id}:${a.row.idx}:${paidAt}`);
  const on = await ctx.chainPlanOf(a.plan);
  if (on) {
    const { chain, chainPlanId } = on;
    const stroops = minorToStroops(a.row.copDue, c);
    txHash = (await ctx.onChain('deposit', () => chain.deposit(a.plan.buyerId, chainPlanId, stroops))).txHash;
  }
  const receipt: Receipt = {
    id: `rcpt-${a.plan.id}-${a.row.idx}`,
    planId: a.plan.id,
    buyerId: a.plan.buyerId,
    installmentIdx: a.row.idx,
    paidAt,
    usdPaid,
    rateKind: 'spot',
    lockedRate: null,
    spotAtPayment: 1,
    anchorRate: 1,
    copDelivered: a.row.copDue,
    feeUsd,
    fxDeclarationRef: '',
    txHash,
    lockId: null,
    hedgeTradeId: null,
    anchorCop: a.row.copDue,
    ndfSettlementCop: null,
    basisCop: 0,
    marginCop: 0,
    copCredited: a.row.copDue,
    breakCostCop: 0,
    method: a.payment.method,
    usdDelivered,
    payoutId: null,
    paymentId: a.payment.id,
  };
  await ctx.store.upsert('receipts', receipt);
  const funded: Installment = { ...a.row, fundedAt: paidAt, fundedPaymentId: a.payment.id, receiptId: receipt.id };
  await ctx.store.upsert('installments', funded);
  await ctx.store.upsert('payments', { ...a.payment, status: 'completed', receivedAt: a.payment.receivedAt ?? paidAt, receiptId: receipt.id });
  a.onProgress?.('recibido');
  const seller = a.plan.sellerId ? await ctx.store.get('sellers', a.plan.sellerId) : undefined;
  await notify(ctx, { plan: a.plan, buyer: a.buyer, template: 'pago_recibido', idx: a.row.idx, params: { usd: usdText(usdDelivered), seller: seller?.tradeName ?? a.plan.trustCompany, date: paidAt.slice(0, 10) }, once: 'installment' });
  if (compareISO(await ctx.today(), a.row.dueDate) < 0) return { receipt, released: false, payout: null };
  const r = await releaseInstallment(ctx, { plan: a.plan, buyer: a.buyer, row: funded, receipt });
  if (r.released) a.onProgress?.('entregado');
  return r;
}

export interface ReleaseResult extends CreditResult {
  gate: SellerGateReason | null;
}

function payoutStatusOf(t: SellerPayoutTransfer): Payout['status'] {
  return t.status;
}

export async function releaseInstallment(ctx: SvContext, a: { plan: Plan; buyer: Buyer; row: Installment; receipt: Receipt }): Promise<ReleaseResult> {
  const c = corridorOf(a.plan);
  const seller = a.plan.sellerId ? await ctx.store.get('sellers', a.plan.sellerId) : undefined;
  if (!seller) throw new ApiError('NOT_FOUND', `seller for plan ${a.plan.id}`);
  const units = (await ctx.store.all('seller_units')).filter((u) => u.sellerId === seller.id);
  const option: PayoutOption = a.plan.payoutOption ?? seller.payoutOption;
  const usdToSeller = a.receipt.usdDelivered ?? round2(a.receipt.usdPaid - a.receipt.feeUsd);
  if (cents(a.receipt.usdPaid) - cents(a.receipt.feeUsd) !== cents(usdToSeller)) {
    throw new Error(`reconciliation: ${a.receipt.usdPaid} − ${a.receipt.feeUsd} ≠ ${usdToSeller} for ${a.receipt.id}`);
  }
  const payoutId = `payout-${a.plan.id}-${a.row.idx}`;
  const base: Payout = (await ctx.store.get('payouts', payoutId)) ?? {
    id: payoutId,
    planId: a.plan.id,
    idx: a.row.idx,
    sellerId: seller.id,
    option,
    status: 'retenido',
    usdPaid: a.receipt.usdPaid,
    feeUsd: a.receipt.feeUsd,
    usdToSeller,
    partnerRef: null,
    releaseTx: null,
    sentAt: null,
    expectedCreditDate: null,
    creditedAt: null,
    errorDetail: null,
    holdReason: null,
    receiptId: a.receipt.id,
  };
  const gate = sellerGate(seller, units, nowIso(ctx));
  if (gate) {
    const held: Payout = { ...base, status: 'retenido', holdReason: gate };
    await ctx.store.upsert('payouts', held);
    const receipt: Receipt = { ...a.receipt, payoutId };
    await ctx.store.upsert('receipts', receipt);
    return { receipt, released: false, payout: held, gate };
  }
  assertSellerReleasable(seller, units, nowIso(ctx));

  // release_spot with exactly the installment's cents as stroops; never apply_lock or release_due here.
  const releasedAt = nowIso(ctx);
  let releaseTx = mockTxHash(`${a.plan.id}:${a.row.idx}:release:${releasedAt}`);
  const on = await ctx.chainPlanOf(a.plan);
  if (on) {
    const { chain, chainPlanId } = on;
    const stroops = minorToStroops(a.row.copDue, c);
    if (stroops !== BigInt(a.row.copDue) * 100_000n) throw new Error(`release_spot: ${stroops} stroops is not ${a.row.copDue} cents × 100,000`);
    const rel = await ctx.onChain('release_spot', () => chain.releaseSpot(chainPlanId, a.row.idx, stroops));
    releaseTx = rel.txHash;
  }
  await ctx.store.upsert('installments', { ...a.row, status: 'released', usdDue: usdToSeller, releasedTx: releaseTx, releasedAt, receiptId: a.receipt.id, fundedAt: null, fundedPaymentId: null });

  const today = await ctx.today();
  const transfer = await sendPayout(ctx, { option, seller, usdToSeller, memo: `${a.plan.encargoRef}-M${a.row.idx + 1}`, today });
  const payout: Payout = {
    ...base,
    option,
    status: payoutStatusOf(transfer),
    partnerRef: transfer.partnerRef,
    releaseTx,
    sentAt: releasedAt,
    expectedCreditDate: transfer.expectedCreditDate,
    creditedAt: transfer.status === 'acreditado' || transfer.status === 'transferido' ? releasedAt : null,
    errorDetail: transfer.errorDetail,
    holdReason: null,
    receiptId: a.receipt.id,
  };
  if (!payoutReconciles(payout)) throw new Error(`reconciliation: payout ${payout.id} does not reconcile`);
  await ctx.store.upsert('payouts', payout);
  const receipt: Receipt = { ...a.receipt, payoutId, txHash: releaseTx };
  await ctx.store.upsert('receipts', receipt);
  await ctx.store.upsert('sellers', { ...seller, releasesCount: seller.releasesCount + 1 });
  await notify(ctx, { plan: a.plan, buyer: a.buyer, template: 'pago_entregado', idx: a.row.idx, params: { usd: usdText(usdToSeller), seller: seller.tradeName, date: today }, once: 'installment' });
  return { receipt, released: true, payout, gate: null };
}

/** The payout through the seller's option. A rail failure is a Payout in `error`, never a lost release. */
async function sendPayout(ctx: SvContext, a: { option: PayoutOption; seller: Seller; usdToSeller: number; memo: string; today: ISODate }): Promise<SellerPayoutTransfer> {
  const rail = ctx.payoutRail(a.option);
  const beneficiaryRef = a.seller.payoutAccount?.ref ?? '';
  try {
    const q = await rail.quote({ usdTarget: a.usdToSeller });
    if (q.usdDelivered != null && cents(q.usdDelivered) !== cents(a.usdToSeller)) throw new Error(`rail quotes ${q.usdDelivered}, expected ${a.usdToSeller}`);
    return await rail.transfer({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef, memo: a.memo, today: a.today });
  } catch (e) {
    return { partnerRef: `ERR-${mockTxHash(`${a.memo}:${a.today}`).slice(0, 8).toUpperCase()}`, status: 'error', expectedCreditDate: null, errorDetail: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- Desk ----------

export async function listOffices(ctx: SvContext): Promise<Office[]> {
  return (await ctx.store.all('offices')).sort((a, b) => a.corridor.localeCompare(b.corridor) || a.name.localeCompare(b.name));
}

export async function listPlanRows(ctx: SvContext): Promise<PlanRow[]> {
  await refreshReferences(ctx);
  const [plans, buyers, units, installments, sellers, governance, events] = await Promise.all([
    ctx.store.all('plans'),
    ctx.store.all('buyers'),
    ctx.store.all('units'),
    ctx.store.all('installments'),
    ctx.store.all('sellers'),
    ctx.store.all('plan_governance'),
    ctx.store.all('policy_events'),
  ]);
  return buildPlanRows({ plans, buyers, units, installments, sellers, today: await ctx.today(), spot: ctx.spot(), governance, events });
}

async function viewSeller(ctx: SvContext, seller: Seller): Promise<SellerView> {
  return sellerView(seller, await ctx.store.all('seller_units'), await ctx.store.all('units'), await ctx.store.all('plans'), nowIso(ctx));
}

export async function listSellers(ctx: SvContext): Promise<SellerView[]> {
  const sellers = (await ctx.store.all('sellers')).sort((a, b) => a.tier - b.tier || a.tradeName.localeCompare(b.tradeName));
  const out: SellerView[] = [];
  for (const s of sellers) out.push(await viewSeller(ctx, s));
  return out;
}

async function sellerOrThrow(ctx: SvContext, sellerId: string): Promise<Seller> {
  const s = await ctx.store.get('sellers', sellerId);
  if (!s) throw new ApiError('NOT_FOUND', `seller ${sellerId}`);
  return s;
}

export async function getSeller(ctx: SvContext, sellerId: string): Promise<SellerView> {
  return viewSeller(ctx, await sellerOrThrow(ctx, sellerId));
}

function sellerTransition<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof SellerTransitionError) throw new ApiError('INVALID_TRANSITION', e.message, e);
    throw e;
  }
}

export async function setSellerVerification(ctx: SvContext, sellerId: string, status: 'verified' | 'paused' | 'rejected', note?: string): Promise<SellerView> {
  const seller = await sellerOrThrow(ctx, sellerId);
  const next = sellerTransition(() => setVerification(seller, status, nowIso(ctx), { note }));
  await ctx.store.upsert('sellers', next);
  return viewSeller(ctx, next);
}

export async function changeSellerPayoutAccount(ctx: SvContext, sellerId: string, account: PayoutAccount): Promise<SellerView> {
  const seller = await sellerOrThrow(ctx, sellerId);
  const next = sellerTransition(() => changePayoutAccount(seller, account, nowIso(ctx)));
  await ctx.store.upsert('sellers', next);
  return viewSeller(ctx, next);
}

/** Runs one adverse action through the policy layer; a refusal is `INVALID_TRANSITION`. */
export async function adverse(ctx: SvContext, action: AdverseAction, detail?: string): Promise<void> {
  try {
    await performAdverseAction({ store: ctx.store, provider: ctx.governance(), today: await ctx.today() }, action, { rule: 'operator', detail });
  } catch (e) {
    if (e instanceof GovernanceProviderError || e instanceof TransitionError) throw new ApiError('INVALID_TRANSITION', e.message, e);
    throw new ApiError('PROVIDER', 'governance provider failed', e);
  }
  if (action.kind === 'place_hold') {
    const b = await ctx.planBundle(action.planId);
    await notify(ctx, { plan: b.plan, buyer: b.buyer, template: 'plan_en_pausa', idx: null, params: { since: await ctx.today(), reason: reasonInfo(action.reasonCode).key }, once: 'day' });
  }
}

export async function runAdverseAction(ctx: SvContext, action: AdverseAction, detail?: string): Promise<PlanView> {
  await adverse(ctx, action, detail);
  return ctx.viewOf(action.planId);
}

export async function raiseCnrAlert(ctx: SvContext, sellerId: string, unitId: string, detail: string): Promise<SellerView> {
  const seller = await sellerOrThrow(ctx, sellerId);
  const unit = (await ctx.store.all('seller_units')).find((u) => u.sellerId === sellerId && u.unitId === unitId);
  if (!unit) throw new ApiError('NOT_FOUND', `unit ${unitId} of seller ${sellerId}`);
  await ctx.store.upsert('seller_units', { ...unit, alertStatus: 'lien_registered', alertAt: nowIso(ctx), alertDetail: detail });
  const plans = (await ctx.store.all('plans')).filter((p) => p.sellerId === sellerId);
  const governance = await ctx.store.all('plan_governance');
  for (const plan of plans) {
    const gov = governance.find((g) => g.planId === plan.id);
    if (gov && !fundsAllowed(gov.state)) continue;
    await adverse(ctx, { kind: 'place_hold', planId: plan.id, reasonCode: REASONS.CNR_LIEN.code }, detail);
  }
  return viewSeller(ctx, seller);
}

export async function listPayouts(ctx: SvContext, f: { planId?: string; sellerId?: string } = {}): Promise<PayoutView[]> {
  const payouts = (await ctx.store.all('payouts')).filter((p) => (!f.planId || p.planId === f.planId) && (!f.sellerId || p.sellerId === f.sellerId));
  return buildPayoutViews({ payouts, plans: await ctx.store.all('plans'), buyers: await ctx.store.all('buyers'), units: await ctx.store.all('units'), sellers: await ctx.store.all('sellers') });
}

export async function retryPayout(ctx: SvContext, payoutId: string): Promise<PayoutView> {
  const payout = await ctx.store.get('payouts', payoutId);
  if (!payout) throw new ApiError('NOT_FOUND', `payout ${payoutId}`);
  const b = await ctx.planBundle(payout.planId);
  const row = b.installments[payout.idx];
  if (!row) throw new ApiError('NOT_FOUND', `installment ${payout.idx}`);
  if (payout.status === 'retenido') {
    const receipt = await ctx.store.get('receipts', payout.receiptId ?? `rcpt-${payout.planId}-${payout.idx}`);
    if (!receipt || row.status === 'released' || !row.fundedAt) throw new ApiError('INVALID_TRANSITION', 'nothing to release for this payout');
    await ctx.assertFundsAllowed(payout.planId);
    const r = await releaseInstallment(ctx, { plan: b.plan, buyer: b.buyer, row, receipt });
    if (!r.released && r.gate) throw new ApiError(gateErrorCode(r.gate), `release still blocked: ${r.gate}`);
  } else if (payout.status === 'error') {
    const seller = await sellerOrThrow(ctx, payout.sellerId);
    const gate = sellerGate(seller, (await ctx.store.all('seller_units')).filter((u) => u.sellerId === seller.id), nowIso(ctx));
    if (gate) throw new ApiError(gateErrorCode(gate), `payout blocked: ${gate}`);
    const today = await ctx.today();
    const t = await sendPayout(ctx, { option: payout.option, seller, usdToSeller: payout.usdToSeller, memo: `${b.plan.encargoRef}-M${payout.idx + 1}-R`, today });
    await ctx.store.upsert('payouts', {
      ...payout,
      status: payoutStatusOf(t),
      partnerRef: t.partnerRef,
      sentAt: nowIso(ctx),
      expectedCreditDate: t.expectedCreditDate,
      creditedAt: t.status === 'acreditado' || t.status === 'transferido' ? nowIso(ctx) : null,
      errorDetail: t.errorDetail,
    });
  } else {
    throw new ApiError('INVALID_TRANSITION', `a payout in ${payout.status} is not retried`);
  }
  const views = await listPayouts(ctx, { planId: payout.planId });
  return views.find((v) => v.id === payoutId)!;
}

export async function listOutbox(ctx: SvContext, planId?: string): Promise<OutboxMessage[]> {
  return (await ctx.store.all('wa_outbox')).filter((m) => !planId || m.planId === planId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

// ---------- Daily jobs ----------

export interface SvJobsReport {
  released: string[];
  retried: string[];
  walked: string[];
  settledSellers: string[];
  reminders: string[];
  lateNotices: string[];
}

export async function runSvDailyJobs(ctx: SvContext): Promise<SvJobsReport> {
  const report: SvJobsReport = { released: [], retried: [], walked: [], settledSellers: [], reminders: [], lateNotices: [] };
  const today = await ctx.today();
  const now = nowIso(ctx);
  await refreshReferences(ctx);

  // 1. Payout-account cooling-offs that ended promote the pending account.
  for (const seller of await ctx.store.all('sellers')) {
    const settled = settlePayoutAccountChange(seller, now);
    if (settled !== seller) {
      await ctx.store.upsert('sellers', settled);
      report.settledSellers.push(seller.id);
    }
  }

  // 2. Funded installments whose due date arrived are released (the gate may hold the payout).
  const governance = await ctx.store.all('plan_governance');
  const blocked = (planId: string) => {
    const g = governance.find((x) => x.planId === planId);
    return g != null && !fundsAllowed(g.state);
  };
  for (const row of await ctx.store.all('installments')) {
    if (row.status !== 'open' || !row.fundedAt || compareISO(today, row.dueDate) < 0 || blocked(row.planId)) continue;
    const b = await ctx.planBundle(row.planId);
    const receipt = row.receiptId ? await ctx.store.get('receipts', row.receiptId) : undefined;
    if (!receipt) continue;
    const r = await releaseInstallment(ctx, { plan: b.plan, buyer: b.buyer, row, receipt });
    if (r.released) report.released.push(row.id);
  }

  // 3. Held payouts whose gate cleared, and option B transfers in flight.
  for (const payout of await ctx.store.all('payouts')) {
    if (payout.status === 'retenido') {
      const row = await ctx.store.get('installments', `${payout.planId}:${payout.idx}`);
      const receipt = payout.receiptId ? await ctx.store.get('receipts', payout.receiptId) : undefined;
      if (!row || !receipt || row.status !== 'open' || !row.fundedAt || blocked(payout.planId)) continue;
      const b = await ctx.planBundle(payout.planId);
      const r = await releaseInstallment(ctx, { plan: b.plan, buyer: b.buyer, row, receipt });
      if (r.released) report.retried.push(payout.id);
    } else if ((payout.status === 'enviado' || payout.status === 'en_transito') && payout.partnerRef && (payout.sentAt ?? '').slice(0, 10) < today) {
      // Transfers sent before today walk one step (or straight to credited on the expected date).
      const rail = ctx.payoutRail(payout.option);
      rail.track({ partnerRef: payout.partnerRef, status: payout.status, expectedCreditDate: payout.expectedCreditDate, errorDetail: payout.errorDetail });
      const t = await rail.partnerStatus(payout.partnerRef, today);
      if (t.status !== payout.status) {
        await ctx.store.upsert('payouts', { ...payout, status: t.status, creditedAt: t.status === 'acreditado' ? now : payout.creditedAt, errorDetail: t.errorDetail ?? payout.errorDetail });
        report.walked.push(payout.id);
      }
    }
  }

  // 4. Reminders inside the window before a due date, and late notices inside grace (corridor templates).
  const installments = await ctx.store.all('installments');
  for (const plan of await ctx.store.all('plans')) {
    const c = corridorOf(plan);
    const wantsReminder = c.whatsappTemplates.includes('recordatorio');
    const wantsLate = c.whatsappTemplates.includes('pago_atrasado');
    if ((!wantsReminder && !wantsLate) || blocked(plan.id)) continue;
    const buyer = await ctx.store.get('buyers', plan.buyerId);
    if (!buyer) continue;
    for (const row of installments.filter((i) => i.planId === plan.id)) {
      const unpaid = row.status !== 'released' && row.status !== 'waived' && row.status !== 'missed' && !row.fundedAt;
      if (!unpaid) continue;
      const usd = usdText(installmentView(row, today, ctx.spot(), [], c).usdShown);
      if (wantsReminder && compareISO(today, addDays(row.dueDate, -c.reminderDaysBefore)) >= 0 && compareISO(today, row.dueDate) < 0) {
        const m = await notify(ctx, { plan, buyer, template: 'recordatorio', idx: row.idx, params: { usd, date: row.dueDate }, once: 'installment' });
        if (m) report.reminders.push(m.id);
      }
      if (wantsLate && compareISO(today, row.dueDate) > 0 && !beyondGraceIn(today, row.dueDate, c)) {
        const graceEnds = graceEndIn(row.dueDate, c);
        const m = await notify(ctx, { plan, buyer, template: 'pago_atrasado', idx: row.idx, params: { usd, date: row.dueDate, graceEnds }, once: 'installment' });
        if (m) report.lateNotices.push(m.id);
      }
    }
  }
  return report;
}

/** Last day of the grace period on the corridor's calendar. */
export function graceEndIn(dueDate: ISODate, c: Corridor): ISODate {
  return addBusinessDaysIn(dueDate, c.graceBusinessDays, c.holidays);
}

export { SellerGateError };
