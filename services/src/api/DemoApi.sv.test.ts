// The El Salvador corridor on the service layer, against the seed: lock refusal, pay options,
// the MoneyGram reference lifecycle (credit only after completed), the counter, the seller gate,
// funded-then-released on the demo clock, the option B status walk, reconciliation, the outbox,
// the desk, a fake chain bridge (deposit and release_spot only, never apply_lock) and the
// Colombia regression (María's view unchanged on the fields the e2e reads).
import { describe, expect, it } from 'vitest';
import { createMockApi } from './createMockApi';
import { ApiError, DemoApi } from './DemoApi';
import { MemoryStore } from '../store/MemoryStore';
import { MockRuntime, spotAtOffset } from '../adapters/mockRuntime';
import { MockHedgeProvider } from '../adapters/mockHedge';
import { MockOnRampProvider } from '../adapters/mockOnRamp';
import { MockOffRampProvider } from '../adapters/mockOffRamp';
import { InternalLockProvider } from '../adapters/mockLock';
import { MoneyGramOnRamp } from '../adapters/moneyGramOnRamp';
import { corridor } from '../corridors/index';
import { roundCop, roundUsd, usdDue } from '../lock/engine';
import {
  BASE_DATE,
  OFFICE_CHATEAUX_MIAMI,
  OFFICE_MAXI_WOODBRIDGE,
  PLAN_ANDRES,
  PLAN_DORIS,
  PLAN_MARIA,
  PLAN_MARVIN,
  PLAN_OSCAR,
  PLAN_ROXANA,
  SELLER_BRISAS,
  SELLER_CUSCATLAN,
  SELLER_LOS_ABETOS,
  buildSeed,
} from '../seed/fixtures';
import { REASONS } from '../policy/reasons';
import { deepLinkFor, MAX_BODY_CHARS } from '../channels/MessageChannel';
import type { Installment, Plan, Snapshot } from '../domain/types';
import type { ChainBridge, ChainTx, SeedPlanState } from '../chain/bridge';
import type { ChainPlanStatus } from '../chain/client';

const T0 = Date.parse('2026-10-20T15:00:00Z');
const SV = corridor('sv');
const fast = (t: { ms: number } = { ms: T0 }) => createMockApi({ minDelayMs: 0, maxDelayMs: 0, now: () => t.ms });

/** A DemoApi over a store the test can shape first (and optional corridor bridges). */
function apiOver(mutate: (seed: Snapshot) => void, opts: { chains?: Partial<Record<'co' | 'sv', ChainBridge>>; cashIn?: MoneyGramOnRamp; now?: () => number } = {}) {
  const seed = buildSeed();
  mutate(seed);
  const store = new MemoryStore(seed);
  const runtime = new MockRuntime({ minDelayMs: 0, maxDelayMs: 0 });
  const now = opts.now ?? (() => T0);
  let seq = 600;
  const hedge = new MockHedgeProvider({ runtime, baseDate: BASE_DATE, tradeSource: () => store.all('hedge_trades'), nextSeq: () => (seq += 1) });
  const providers = { hedge, onRamp: new MockOnRampProvider(runtime), offRamp: new MockOffRampProvider(runtime), lock: new InternalLockProvider(runtime, hedge, now), cashIn: opts.cashIn };
  return { api: new DemoApi({ store, providers, runtime, now, chains: opts.chains }), store };
}

class FakeBridge implements ChainBridge {
  readonly contractId = 'CFAKESV';
  readonly calls: { fn: string; args: unknown[] }[] = [];
  private seq = 0;
  private tx(fn: string, args: unknown[]): ChainTx {
    this.calls.push({ fn, args });
    this.seq += 1;
    return { txHash: `${fn}-hash-${this.seq}`.padEnd(64, '0'), ledger: 1000 + this.seq };
  }
  async seedPlan(plan: Plan, installments: Installment[], _s: SeedPlanState) {
    this.calls.push({ fn: 'seedPlan', args: [plan.id, installments.length] });
    return { chainPlanId: 7000 + this.calls.length, steps: [], elapsedMs: 1 };
  }
  async deposit(buyerId: string, chainPlanId: number, stroops: bigint) {
    return this.tx('deposit', [buyerId, chainPlanId, stroops]);
  }
  async applyLock(a: unknown) {
    return this.tx('applyLock', [a]);
  }
  async releaseDue(chainPlanId: number, idx: number) {
    return { ...this.tx('releaseDue', [chainPlanId, idx]), stroops: 0n };
  }
  async releaseSpot(chainPlanId: number, idx: number, stroops: bigint) {
    return { ...this.tx('releaseSpot', [chainPlanId, idx, stroops]), stroops };
  }
  async breakLock(chainPlanId: number, idx: number) {
    return this.tx('breakLock', [chainPlanId, idx]);
  }
  async getStatus(): Promise<ChainPlanStatus> {
    throw new Error('not used');
  }
  async adverse(a: { kind: string }) {
    return this.tx(a.kind, [a]);
  }
  async extendTtl(chainPlanId: number) {
    return this.tx('extendTtl', [chainPlanId]);
  }
}

describe('lock refusal and pay ahead', () => {
  it('quoteLock and acceptLock refuse an SV plan before any provider call; payAhead is not offered', async () => {
    const api = fast();
    await expect(api.quoteLock(PLAN_ROXANA, 'trimestral')).rejects.toMatchObject({ code: 'LOCKS_DISABLED' });
    await expect(api.quoteLock(PLAN_MARVIN, 'mensual')).rejects.toMatchObject({ code: 'LOCKS_DISABLED' });
    await expect(api.payAhead(PLAN_ROXANA)).rejects.toMatchObject({ code: 'NOTHING_TO_PAY_AHEAD' });
    const v = await api.getPlan(PLAN_ROXANA);
    expect(v.locks).toHaveLength(0);
    expect(v.corridor).toBe('sv');
    expect(v.installments.every((i) => i.lockedRate == null && i.diffCop === 0)).toBe(true);
  });
});

describe('pay options', () => {
  it('Roxana sees MoneyGram (enabled, limits echoed, the open reference), the counter at her agency and ACH, with fees from config', async () => {
    const api = fast();
    const o = await api.getPayOptions(PLAN_ROXANA, 5);
    expect(o).toMatchObject({ planId: PLAN_ROXANA, idx: 5, number: 6, dueDate: '2026-10-24', usdDue: 750 });
    expect(o.options.map((x) => x.method)).toEqual(['moneygram_cash', 'office_counter', 'ach']);
    const mg = o.options[0]!;
    expect(mg).toMatchObject({ enabled: true, disabledReason: null, feeUsd: 4.99, totalUsd: 754.99, limits: { minUsd: 5, maxUsd: 950 } });
    expect(mg.payment?.id).toBe('pay-plan-roxana-5-pending');
    expect(mg.payment?.status).toBe('pending');
    expect(o.options[1]).toMatchObject({ enabled: true, feeUsd: 0, totalUsd: 750 });
    expect(o.options[1]!.office?.id).toBe(OFFICE_MAXI_WOODBRIDGE);
    expect(o.options[2]).toMatchObject({ enabled: true, feeUsd: 1.5, totalUsd: 751.5 });
  });

  it('MoneyGram is hidden for Doris (LA) and the counter falls back to the nearest licensed agency', async () => {
    const api = fast();
    await expect(api.getPayOptions(PLAN_DORIS, 0)).rejects.toMatchObject({ code: 'NOT_DUE_YET' }); // M1 due 2026-10-28, window opens 5 days before
    await api.advanceClock(1);
    const o = await api.getPayOptions(PLAN_DORIS, 0);
    expect(o.options.map((x) => x.method)).toEqual(['office_counter', 'ach']);
    expect(o.options[0]!.office?.isLicensedAgency).toBe(true);
    await expect(api.requestCashReference(PLAN_DORIS, 0)).rejects.toMatchObject({ code: 'STATE_EXCLUDED' });
  });

  it('MoneyGram is listed but disabled above USD 950 and a reference request is blocked (and recorded as blocked)', async () => {
    const { api } = apiOver((seed) => {
      const row = seed.installments.find((i) => i.planId === PLAN_MARVIN && i.idx === 3)!;
      row.copDue = 100_000; // USD 1,000.00
    });
    const o = await api.getPayOptions(PLAN_MARVIN, 3);
    expect(o.usdDue).toBe(1000);
    expect(o.options[0]).toMatchObject({ method: 'moneygram_cash', enabled: false, disabledReason: 'above_limit' });
    expect(o.options[1]).toMatchObject({ method: 'office_counter', enabled: true });
    await expect(api.requestCashReference(PLAN_MARVIN, 3)).rejects.toMatchObject({ code: 'ABOVE_LIMIT' });
    const blocked = (await api.listPayments({ planId: PLAN_MARVIN, status: 'blocked' })).filter((p) => p.idx === 3);
    expect(blocked.some((p) => p.blockedReason === 'above_limit' && p.amount === 100_000)).toBe(true);
  });

  it('a paid or missed installment has no pay options', async () => {
    const api = fast();
    await expect(api.getPayOptions(PLAN_ROXANA, 0)).rejects.toMatchObject({ code: 'ALREADY_PAID' });
    await expect(api.getPayOptions(PLAN_OSCAR, 2)).rejects.toMatchObject({ code: 'PLAN_BLOCKED' });
  });
});

describe('MoneyGram reference: request → pending → completed credits, never before', () => {
  it('the seeded pending reference is reused, nothing is credited while pending, and completing it credits (recibido) without releasing before the due date', async () => {
    const api = fast();
    const p = await api.requestCashReference(PLAN_ROXANA, 5);
    expect(p.id).toBe('pay-plan-roxana-5-pending');
    expect(p.status).toBe('pending');
    let v = await api.getPlan(PLAN_ROXANA);
    expect(v.installments[5]!.cellState).toBe('abierto');
    expect(v.installments[5]!.fundedAt ?? null).toBeNull();
    expect((await api.getReceipts(PLAN_ROXANA)).some((r) => r.installmentIdx === 5)).toBe(false);
    expect(v.payments.map((x) => x.id)).toContain('pay-plan-roxana-5-pending');

    const steps: string[] = [];
    const receipt = await api.completeCashReference(p.id, (s) => steps.push(s));
    expect(steps).toEqual(['recibido']); // due 2026-10-24: funded, not released
    expect(receipt).toMatchObject({ planId: PLAN_ROXANA, installmentIdx: 5, usdPaid: 754.99, feeUsd: 4.99, usdDelivered: 750, method: 'moneygram_cash', paymentId: p.id, rateKind: 'spot', spotAtPayment: 1, anchorRate: 1, copDelivered: 75000, copCredited: 75000, anchorCop: 75000, basisCop: 0, marginCop: 0, fxDeclarationRef: '', payoutId: null });
    expect(receipt.lockedRate).toBeNull();
    expect(receipt.ndfSettlementCop).toBeNull();
    v = await api.getPlan(PLAN_ROXANA);
    const m6 = v.installments[5]!;
    expect(m6.cellState).toBe('recibido');
    expect(m6.status).toBe('open');
    expect(m6.fundedPaymentId).toBe(p.id);
    expect(m6.payable).toBe(false);
    expect((await api.getPayment(p.id)).status).toBe('completed');
    await expect(api.completeCashReference(p.id)).rejects.toMatchObject({ code: 'ALREADY_PAID' });
    expect((await api.listPayouts({ planId: PLAN_ROXANA })).some((x) => x.idx === 5)).toBe(false);
    const msgs = await api.listOutbox(PLAN_ROXANA);
    const recibido = msgs.find((m) => m.template === 'pago_recibido' && m.params.n === 6)!;
    expect(recibido.link).toBe(`#/c/${PLAN_ROXANA}/recibo/5`);
    expect(recibido.simulated).toBe(true);
  });

  it('when the network does not report completed, nothing is credited', async () => {
    class SilentNetwork extends MoneyGramOnRamp {
      override async simulateCompleted(): Promise<void> {
        /* the cash never arrives at the counter */
      }
    }
    // the network runs on the corridor's session clock (the seed clock of the demo day)
    const silent = new SilentNetwork({ driver: 'mock', runtime: new MockRuntime({ minDelayMs: 0, maxDelayMs: 0 }), limits: SV.moneyGram!, now: () => Date.parse(`${BASE_DATE}T14:00:00.000Z`) });
    const { api } = apiOver(() => undefined, { cashIn: silent });
    await expect(api.completeCashReference('pay-plan-roxana-5-pending')).rejects.toMatchObject({ code: 'REFERENCE_NOT_COMPLETED' });
    const v = await api.getPlan(PLAN_ROXANA);
    expect(v.installments[5]!.cellState).toBe('abierto');
    expect((await api.getReceipts(PLAN_ROXANA)).some((r) => r.installmentIdx === 5)).toBe(false);
    expect((await api.getPayment('pay-plan-roxana-5-pending')).status).toBe('pending');
  });

  it('the seeded expired reference reports quote_expired; a pending one expires after its TTL on the demo clock and can be renewed', async () => {
    const t = { ms: T0 };
    const api = fast(t);
    expect((await api.getPayment('pay-plan-roxana-5-expired')).status).toBe('quote_expired');
    await expect(api.completeCashReference('pay-plan-roxana-5-expired')).rejects.toMatchObject({ code: 'REFERENCE_EXPIRED' });
    // the 12-minute-old reference stays pending while the session is young
    expect((await api.getPayment('pay-plan-roxana-5-pending')).status).toBe('pending');
    t.ms = T0 + 61 * 60_000;
    expect((await api.getPayment('pay-plan-roxana-5-pending')).status).toBe('quote_expired');
    await expect(api.completeCashReference('pay-plan-roxana-5-pending')).rejects.toMatchObject({ code: 'REFERENCE_EXPIRED' });
    const renewed = await api.renewCashReference('pay-plan-roxana-5-pending');
    expect(renewed.id).not.toBe('pay-plan-roxana-5-pending');
    expect(renewed.status).toBe('pending');
    expect(renewed.externalRef).toMatch(/^\d{8}$/);
    expect(renewed.externalRef).not.toBe('9062817345');
    expect(renewed.amount).toBe(75000);
    expect(renewed.fee).toBe(499);
    const sessionNow = Date.parse(`${BASE_DATE}T14:00:00.000Z`) + 61 * 60_000;
    expect(Date.parse(renewed.expiresAt!) - sessionNow).toBe(SV.moneyGram!.referenceTtlMinutes * 60_000);
    const ref = (await api.listOutbox(PLAN_ROXANA)).find((m) => m.template === 'referencia_moneygram' && m.params.ref === renewed.externalRef)!;
    expect(ref.link).toBe(`#/c/${PLAN_ROXANA}/pagar`);
    expect(ref.params.usd).toBe('754.99');
    // a completed reference is not renewable
    const receipt = await api.completeCashReference(renewed.id);
    expect(receipt.usdPaid).toBe(754.99);
    await expect(api.renewCashReference(renewed.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('session clock on payments', () => {
  const seedClock = Date.parse(`${BASE_DATE}T14:00:00.000Z`);

  it('pay options and every payment read carry the services\' now; a pending cash reference carries its minutes pending', async () => {
    const t = { ms: T0 };
    const api = fast(t);
    const o = await api.getPayOptions(PLAN_ROXANA, 5);
    expect(o.now).toBe(new Date(seedClock).toISOString());
    const mg = o.options[0]!.payment!;
    expect(mg.now).toBe(o.now);
    // seeded 12 minutes before the seed clock: past the corridor's alert threshold
    expect(mg.pendingMinutes).toBe(12);
    expect(mg.pendingMinutes).toBeGreaterThan(SV.moneyGram!.pendingAlertMinutes);

    t.ms = T0 + 5 * 60_000 + 30_000;
    const later = new Date(seedClock + 5 * 60_000 + 30_000).toISOString();
    const p = await api.getPayment('pay-plan-roxana-5-pending');
    expect(p).toMatchObject({ now: later, pendingMinutes: 17 });
    expect((await api.getPlan(PLAN_ROXANA)).payments.find((x) => x.id === p.id)).toMatchObject({ now: later, pendingMinutes: 17 });
    expect((await api.listPayments({ planId: PLAN_ROXANA })).find((x) => x.id === p.id)).toMatchObject({ now: later, pendingMinutes: 17 });
    // anything that is not a pending cash reference has no minutes pending
    expect(await api.getPayment('pay-plan-roxana-5-expired')).toMatchObject({ now: later, pendingMinutes: null });
    expect((await api.listPayments({ planId: PLAN_ROXANA, status: 'completed' })).every((x) => x.pendingMinutes === null && x.now === later)).toBe(true);
  });

  it('a new reference starts at 0 minutes pending, and the clock fields are never stored', async () => {
    const t = { ms: T0 };
    const { api, store } = apiOver(() => undefined, { now: () => t.ms });
    t.ms = T0 + 61 * 60_000; // the seeded reference has expired
    const renewed = await api.renewCashReference('pay-plan-roxana-5-pending');
    expect(renewed).toMatchObject({ status: 'pending', pendingMinutes: 0, now: new Date(seedClock + 61 * 60_000).toISOString() });
    const row = (await store.get('payments', renewed.id))!;
    expect('now' in row || 'pendingMinutes' in row).toBe(false);
    // a counter payment is completed on the spot: stamped, nothing pending
    const counter = await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 80_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    expect(counter.payment).toMatchObject({ status: 'completed', pendingMinutes: null, now: renewed.now });
    expect('now' in (await store.get('payments', counter.payment.id))!).toBe(false);
  });
});

describe('counter', () => {
  it('finds buyers by phone digits or by name without accents; an unknown number is an empty list', async () => {
    const api = fast();
    const byPhone = await api.searchBuyers('703');
    expect(byPhone.map((r) => r.buyer.id)).toEqual(['buyer-roxana']);
    expect(byPhone[0]!.due).toEqual([{ idx: 5, number: 6, dueDate: '2026-10-24', usdDue: 750, isLate: false, lateInGrace: false }]);
    expect(byPhone[0]!.corridor).toBe('sv');
    expect(byPhone[0]!.fundsBlocked).toBe(false);
    expect((await api.searchBuyers('hernandez')).map((r) => r.buyer.id)).toEqual(['buyer-roxana']);
    expect((await api.searchBuyers('Portillo'))[0]!.due[0]).toMatchObject({ number: 4, usdDue: 500, isLate: true, lateInGrace: true });
    expect(await api.searchBuyers('5550000')).toEqual([]);
    expect(await api.searchBuyers('   ')).toEqual([]);
    expect((await api.searchBuyers('(713) 555-0163'))[0]!.fundsBlocked).toBe(true); // Óscar, on hold
  });

  it('takes cash with change due, credits the plan (recibido before the due date) and totals the shift', async () => {
    const api = fast();
    await expect(api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 70_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' })).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH' });
    await expect(api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 80_000, officeId: OFFICE_CHATEAUX_MIAMI, cashierId: 'cajero-1' })).rejects.toMatchObject({ code: 'METHOD_NOT_OFFERED' });
    const steps: string[] = [];
    const { payment, receipt } = await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 80_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' }, (s) => steps.push(s));
    expect(steps).toEqual(['recibido']);
    expect(payment).toMatchObject({ method: 'office_counter', status: 'completed', tender: 'cash', amount: 75000, fee: 0, amountReceived: 80_000, changeDue: 5000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1', receiptId: receipt.id });
    expect(payment.receivedAt?.slice(0, 10)).toBe(BASE_DATE);
    expect(receipt).toMatchObject({ usdPaid: 750, feeUsd: 0, usdDelivered: 750, method: 'office_counter', payoutId: null });
    const v = await api.getPlan(PLAN_ROXANA);
    expect(v.installments[5]!.cellState).toBe('recibido');
    await expect(api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 80_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' })).rejects.toMatchObject({ code: 'ALREADY_PAID' });
    const shift = await api.getShiftTotal({ officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    expect(shift).toMatchObject({ date: BASE_DATE, totalUsd: 750, byTender: { cash: { count: 1, usd: 750 }, card: { count: 0, usd: 0 } } });
    expect(shift.payments.map((p) => p.id)).toEqual([payment.id]);
    expect((await api.getShiftTotal({ officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-2' })).totalUsd).toBe(0);
    // cash above USD 950 is fine at the counter
    const { api: big } = apiOver((seed) => {
      seed.installments.find((i) => i.planId === PLAN_ROXANA && i.idx === 5)!.copDue = 120_000;
    });
    const r = await big.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'card', amountReceived: 120_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    expect(r.receipt.usdPaid).toBe(1200);
    expect(r.payment.changeDue).toBe(0);
  });

  it('a funded installment is released on its due date by the daily jobs (Roxana M6: recibido today, pagado after +1 mes) and the receipt message follows', async () => {
    const api = fast();
    await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 75_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    let msg = await api.sendReceiptMessage(PLAN_ROXANA, 5);
    expect(msg.template).toBe('pago_recibido');
    expect(msg.link).toBe(`#/c/${PLAN_ROXANA}/recibo/5`);
    await api.advanceClock(1);
    const v = await api.getPlan(PLAN_ROXANA);
    const m6 = v.installments[5]!;
    expect(m6.cellState).toBe('pagado');
    expect(m6.status).toBe('released');
    expect(m6.usdDue).toBe(750);
    expect(m6.releasedTx).toMatch(/^[0-9a-f]{64}$/);
    expect(m6.fundedAt ?? null).toBeNull();
    const payout = (await api.listPayouts({ planId: PLAN_ROXANA })).find((p) => p.idx === 5)!;
    expect(payout).toMatchObject({ option: 'B', status: 'enviado', usdPaid: 750, feeUsd: 0, usdToSeller: 750, reconciles: true, holdReason: null, releaseTx: m6.releasedTx });
    expect(payout.partnerRef).toMatch(/^DSV-TRF-/);
    expect(payout.expectedCreditDate).not.toBeNull();
    const receipt = (await api.getReceipts(PLAN_ROXANA)).find((r) => r.installmentIdx === 5)!;
    expect(receipt.payoutId).toBe(payout.id);
    expect(receipt.txHash).toBe(m6.releasedTx);
    msg = await api.sendReceiptMessage(PLAN_ROXANA, 5);
    expect(msg.template).toBe('pago_entregado');
    const entregado = (await api.listOutbox(PLAN_ROXANA)).filter((m) => m.template === 'pago_entregado' && m.params.n === 6);
    expect(entregado.length).toBeGreaterThanOrEqual(2); // the job's notice and the explicit resend
  });
});

describe('seller gate', () => {
  it("Marvin's M4 ACH payment is credited but its payout is held (seller_cooling_off); the cooling-off ends on the next clock tick and the hold is released (option A → transferido)", async () => {
    const api = fast();
    const steps: string[] = [];
    const receipt = await api.pay(PLAN_MARVIN, 3, (s) => steps.push(s));
    expect(steps).toEqual(['recibido']);
    expect(receipt).toMatchObject({ usdPaid: 501.5, feeUsd: 1.5, usdDelivered: 500, method: 'ach', copCredited: 50000 });
    expect(receipt.payoutId).toBe(`payout-${PLAN_MARVIN}-3`);
    let v = await api.getPlan(PLAN_MARVIN);
    expect(v.installments[3]!.cellState).toBe('recibido');
    expect(v.installments[3]!.status).toBe('open');
    expect(v.seller?.gate).toBe('seller_cooling_off');
    let payout = (await api.listPayouts({ planId: PLAN_MARVIN })).find((p) => p.idx === 3)!;
    expect(payout).toMatchObject({ status: 'retenido', holdReason: 'seller_cooling_off', option: 'A', usdPaid: 501.5, feeUsd: 1.5, usdToSeller: 500, reconciles: true, partnerRef: null });
    const payment = (await api.listPayments({ planId: PLAN_MARVIN })).find((p) => p.idx === 3 && p.method === 'ach')!;
    expect(payment.status).toBe('completed');
    await expect(api.retryPayout(payout.id)).rejects.toMatchObject({ code: 'SELLER_COOLING_OFF' });

    await api.advanceClock(1); // 52 h cooling-off is long over: the pending account is promoted and the hold released
    const seller = await api.getSeller(SELLER_LOS_ABETOS);
    expect(seller.payoutAccount?.ref).toBe('CUST-LA-9C41');
    expect(seller.pendingPayoutAccount).toBeNull();
    expect(seller.gate).toBeNull();
    v = await api.getPlan(PLAN_MARVIN);
    expect(v.installments[3]!.cellState).toBe('pagado');
    payout = (await api.listPayouts({ planId: PLAN_MARVIN })).find((p) => p.idx === 3)!;
    expect(payout).toMatchObject({ status: 'transferido', holdReason: null, reconciles: true });
    expect(payout.partnerRef).toMatch(/^USDC-HOLD-/);
    expect(seller.releasesCount).toBe(4);
  });

  it('an unverified seller blocks the release until it is verified and has a payout account; retry then releases', async () => {
    const { api } = apiOver((seed) => {
      const doris = seed.plans.find((p) => p.id === PLAN_DORIS)!;
      const plan: Plan = { ...doris, id: 'plan-test-brisas', encargoRef: 'CH-SV-TEST', sellerId: SELLER_BRISAS, payoutOption: 'B', startDate: BASE_DATE, trustCompany: 'Constructora Brisas del Pacífico (ficticio)' };
      seed.plans.push(plan);
      seed.installments.push(...seed.installments.filter((i) => i.planId === PLAN_DORIS).map((i, k) => ({ ...i, id: `${plan.id}:${k}`, planId: plan.id, dueDate: k === 0 ? BASE_DATE : i.dueDate })));
      seed.seller_units.push({ id: 'su-test', sellerId: SELLER_BRISAS, unitId: plan.unitId, cnrRegistryNo: 'CNR-TEST', cnrCertDate: BASE_DATE, cnrCertHash: 'cd'.repeat(32), alertStatus: 'none', alertAt: null, alertDetail: null });
    });
    const receipt = await api.pay('plan-test-brisas', 0);
    expect(receipt.usdDelivered).toBe(650);
    let payout = (await api.listPayouts({ sellerId: SELLER_BRISAS }))[0]!;
    expect(payout).toMatchObject({ status: 'retenido', holdReason: 'seller_unverified', reconciles: true });
    expect((await api.getPlan('plan-test-brisas')).installments[0]!.cellState).toBe('recibido');
    await expect(api.retryPayout(payout.id)).rejects.toMatchObject({ code: 'SELLER_UNVERIFIED' });
    let seller = await api.setSellerVerification(SELLER_BRISAS, 'verified', 'KYB aprobado (simulado)');
    expect(seller.verificationStatus).toBe('verified');
    expect(seller.payoutAccount).toBeNull();
    expect(seller.gate).toBe('seller_unverified'); // no payout address yet
    seller = await api.changeSellerPayoutAccount(SELLER_BRISAS, { kind: 'bank', institution: 'Banco Hipotecario', holder: 'CONSTRUCTORA BRISAS DEL PACIFICO SA DE CV', ref: 'USD ••• 9001' });
    expect(seller.payoutAccount?.ref).toBe('USD ••• 9001');
    expect(seller.gate).toBeNull();
    payout = await api.retryPayout(payout.id);
    expect(payout.status).toBe('enviado');
    expect(payout.reconciles).toBe(true);
    expect((await api.getPlan('plan-test-brisas')).installments[0]!.cellState).toBe('pagado');
    // a later account change on a verified seller starts the 72 h cooling-off
    seller = await api.changeSellerPayoutAccount(SELLER_BRISAS, { kind: 'bank', institution: 'Banco Hipotecario', holder: 'X', ref: 'USD ••• 9002' });
    expect(seller.payoutAccount?.ref).toBe('USD ••• 9001');
    expect(seller.pendingPayoutAccount?.ref).toBe('USD ••• 9002');
    expect(seller.gate).toBe('seller_cooling_off');
  });

  it('rejected is irreversible', async () => {
    const api = fast();
    const rejected = await api.setSellerVerification(SELLER_BRISAS, 'rejected');
    expect(rejected.gate).toBe('seller_rejected');
    await expect(api.setSellerVerification(SELLER_BRISAS, 'verified')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('a CNR alert puts every active plan of the seller on hold (reason 306) and sends plan_en_pausa', async () => {
    const api = fast();
    const seller = await api.raiseCnrAlert(SELLER_CUSCATLAN, 'unit-cedros-07b', 'Nuevo gravamen inscrito (simulado)');
    expect(seller.gate).toBe('cnr_alert');
    expect(seller.units.find((u) => u.unitId === 'unit-cedros-07b')).toMatchObject({ alertStatus: 'lien_registered', alertDetail: 'Nuevo gravamen inscrito (simulado)' });
    for (const planId of [PLAN_ROXANA, PLAN_DORIS]) {
      const v = await api.getPlan(planId);
      expect(v.governance.state).toBe('on_hold');
      expect(v.governance.reasonCode).toBe(REASONS.CNR_LIEN.code);
      expect(v.governance.reasonKey).toBe('cnrLien');
      expect(v.installments.every((i) => !i.payable)).toBe(true);
      const pausa = (await api.listOutbox(planId)).find((m) => m.template === 'plan_en_pausa' && m.createdAt.startsWith(BASE_DATE))!;
      expect(pausa.link).toBe(`#/comprador/${planId}`);
      expect(pausa.params.reason).toBe('cnrLien');
    }
    await expect(api.pay(PLAN_ROXANA, 5)).rejects.toMatchObject({ code: 'PLAN_BLOCKED' });
    // lifting the hold through the desk action re-opens the plan
    const back = await api.runAdverseAction({ kind: 'lift_hold', planId: PLAN_ROXANA, reasonCode: REASONS.HOLD_CLEARED.code }, 'gravamen cancelado');
    expect(back.governance.state).toBe('active');
    await expect(api.runAdverseAction({ kind: 'lift_hold', planId: PLAN_ROXANA, reasonCode: REASONS.HOLD_CLEARED.code })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('payouts and reconciliation', () => {
  it('every SV payout in the seed reconciles (paid − fee = to seller) and the option B statuses walk to acreditado as the clock advances', async () => {
    const api = fast();
    const seeded = await api.listPayouts();
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((p) => p.corridor === 'sv' && p.reconciles)).toBe(true);
    expect(seeded.find((p) => p.planId === PLAN_ROXANA && p.idx === 4)?.status).toBe('en_transito');
    expect(seeded.find((p) => p.planId === PLAN_ROXANA && p.idx === 3)?.status).toBe('error');
    expect(seeded.filter((p) => p.option === 'A').every((p) => p.status === 'transferido')).toBe(true);

    await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 75_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    await api.advanceClock(1);
    let roxana = await api.listPayouts({ planId: PLAN_ROXANA });
    expect(roxana.find((p) => p.idx === 4)?.status).toBe('acreditado'); // the seeded in-transit transfer credited
    expect(roxana.find((p) => p.idx === 4)?.creditedAt).not.toBeNull();
    expect(roxana.find((p) => p.idx === 5)?.status).toBe('enviado'); // released today: visible as sent
    await api.advanceClock(1);
    roxana = await api.listPayouts({ planId: PLAN_ROXANA });
    expect(roxana.find((p) => p.idx === 5)?.status).toBe('acreditado');
    expect(roxana.find((p) => p.idx === 3)?.status).toBe('error'); // errors never walk by themselves
    expect(roxana.every((p) => p.reconciles)).toBe(true);
  });

  it('retrying an errored option B payout re-sends it through the partner', async () => {
    const api = fast();
    const before = (await api.listPayouts({ planId: PLAN_ROXANA })).find((p) => p.idx === 3)!;
    expect(before.status).toBe('error');
    const after = await api.retryPayout(before.id);
    expect(after.status).toBe('enviado');
    expect(after.partnerRef).toMatch(/^DSV-TRF-/);
    expect(after.partnerRef).not.toBe(before.partnerRef);
    expect(after.errorDetail).toBeNull();
    expect(after.reconciles).toBe(true);
    await expect(api.retryPayout(before.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('outbox', () => {
  it('every message the system sends is ≤ 1,024 characters, names its template deep link once, and is marked simulated', async () => {
    const api = fast();
    const before = new Set((await api.listOutbox()).map((m) => m.id));
    await api.requestCashReference(PLAN_DORIS, 0).catch(() => undefined);
    await api.pay(PLAN_MARVIN, 3);
    await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 75_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    await api.runAdverseAction({ kind: 'place_hold', planId: PLAN_DORIS, reasonCode: REASONS.KYC_REVIEW.code });
    await api.advanceClock(1);
    const sent = (await api.listOutbox()).filter((m) => !before.has(m.id));
    const templates = new Set(sent.map((m) => m.template));
    expect(templates.has('pago_recibido')).toBe(true);
    expect(templates.has('pago_entregado')).toBe(true);
    expect(templates.has('plan_en_pausa')).toBe(true);
    for (const m of sent) {
      expect(m.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      expect(m.body.match(/#\//g)).toHaveLength(1);
      expect(m.channel).toBe('whatsapp');
      expect(m.simulated).toBe(true);
      const idx = m.params.n != null && !String(m.params.n).includes('–') ? Number(m.params.n) - 1 : null;
      expect(m.link).toBe(deepLinkFor(m.template, m.planId, idx));
      expect(m.body).toContain(m.link);
      const plan = (await api.listPlans()).find((p) => p.plan.id === m.planId)!;
      expect(corridor(plan.plan.corridor ?? 'co').whatsappTemplates).toContain(m.template);
    }
    // newest first, and a plan filter
    const all = await api.listOutbox();
    expect([...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect((await api.listOutbox(PLAN_MARVIN)).every((m) => m.planId === PLAN_MARVIN)).toBe(true);
  });

  it('the late notice inside grace is sent once per installment and the reminder inside the window too', async () => {
    const { api } = apiOver((seed) => {
      // Doris M1 due 2026-10-28: make a reminder due today (window 5 days) by moving it to the 24th; Marvin M4 already has a seeded late notice.
      seed.installments.find((i) => i.planId === PLAN_DORIS && i.idx === 0)!.dueDate = '2026-10-24';
    });
    const first = await api.runDailyJobsNow();
    expect(first.reminders).toHaveLength(1);
    // Marvin M4's notice is seeded already; Andrés M5 (Colombia lists the template too) gets its first one.
    expect(first.lateNotices).toEqual([`wa-${PLAN_ANDRES}-pago_atrasado-1`]);
    const again = await api.runDailyJobsNow();
    expect(again.reminders).toEqual([]);
    expect(again.lateNotices).toEqual([]);
    const doris = (await api.listOutbox(PLAN_DORIS)).filter((m) => m.template === 'recordatorio');
    expect(doris).toHaveLength(1);
    expect(doris[0]).toMatchObject({ link: `#/c/${PLAN_DORIS}/pagar`, params: { n: 1, usd: '650.00', date: '2026-10-24' } });
  });
});

describe('desk', () => {
  it('plan rows carry the desk status per corridor; sellers and offices list', async () => {
    const api = fast();
    const rows = await api.listPlanRows();
    const status = (id: string) => rows.find((r) => r.plan.id === id)!.status;
    expect(status(PLAN_ROXANA)).toBe('activo');
    expect(status(PLAN_MARVIN)).toBe('atrasado');
    expect(status(PLAN_OSCAR)).toBe('en_pausa');
    expect(status(PLAN_DORIS)).toBe('activo');
    expect(status(PLAN_MARIA)).toBe('activo');
    expect(status(PLAN_ANDRES)).toBe('en_mora'); // M3 broken and unpaid since August
    const roxana = rows.find((r) => r.plan.id === PLAN_ROXANA)!;
    expect(roxana).toMatchObject({ corridor: 'sv', sellerName: 'Desarrollos Cuscatlán (ficticio)', paidCount: 5, nextDueDate: '2026-10-24', nextUsd: 750, lateCount: 0 });
    expect(rows.find((r) => r.plan.id === PLAN_MARIA)!.sellerName).toBeNull();
    const sellers = await api.listSellers();
    expect(sellers.map((s) => s.id)).toContain(SELLER_BRISAS);
    expect(sellers.find((s) => s.id === SELLER_LOS_ABETOS)!.gate).toBe('seller_cooling_off');
    expect(sellers.find((s) => s.id === 'seller-altavista')!.gate).toBe('cnr_alert');
    expect(sellers.find((s) => s.id === SELLER_CUSCATLAN)!.planCount).toBe(2);
    expect((await api.listOffices()).map((o) => o.id)).toContain(OFFICE_MAXI_WOODBRIDGE);
    expect((await api.getPlan(PLAN_ROXANA)).seller).toMatchObject({ id: SELLER_CUSCATLAN, tier: 1, payoutOption: 'B', gate: null, cnr: { registryNo: 'CNR-SS-2026-118342', alertStatus: 'none' } });
  });

  it('reset restores the corridor seed in well under 10 s', async () => {
    const api = fast();
    await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 75_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    const { elapsedMs } = await api.reset();
    expect(elapsedMs).toBeLessThan(10_000);
    expect((await api.getPlan(PLAN_ROXANA)).installments[5]!.cellState).toBe('abierto');
    expect((await api.getPayment('pay-plan-roxana-5-pending')).status).toBe('pending');
  });
});

describe('fake chain bridge for the corridor', () => {
  it('an SV payment deposits cents × 100,000 stroops and releases with release_spot on the due date; apply_lock is never called', async () => {
    const bridge = new FakeBridge();
    const { api } = apiOver(
      (seed) => {
        seed.demo_state[0] = { ...seed.demo_state[0]!, chainPlans: { [PLAN_ROXANA]: 501, [PLAN_MARVIN]: 502 } };
      },
      { chains: { sv: bridge } },
    );
    await expect(api.quoteLock(PLAN_ROXANA, 'trimestral')).rejects.toMatchObject({ code: 'LOCKS_DISABLED' });
    await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 75_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    expect(bridge.calls.map((c) => c.fn)).toEqual(['deposit']);
    expect(bridge.calls[0]!.args).toEqual(['buyer-roxana', 501, 7_500_000_000n]);
    const receipt = (await api.getReceipts(PLAN_ROXANA)).find((r) => r.installmentIdx === 5)!;
    expect(receipt.txHash).toMatch(/^deposit-hash-1/);
    await api.advanceClock(1);
    expect(bridge.calls.map((c) => c.fn)).toEqual(['deposit', 'releaseSpot']);
    expect(bridge.calls[1]!.args).toEqual([501, 5, 7_500_000_000n]);
    const v = await api.getPlan(PLAN_ROXANA);
    expect(v.installments[5]!.releasedTx).toMatch(/^releaseSpot-hash-2/);
    // Marvin by ACH: deposit, then the gate holds the release (no release_spot until it clears)
    await api.pay(PLAN_MARVIN, 4);
    expect(bridge.calls.filter((c) => c.fn === 'deposit').map((c) => c.args)).toContainEqual(['buyer-marvin', 502, 5_000_000_000n]);
    expect(bridge.calls.some((c) => c.fn === 'applyLock' || c.fn === 'releaseDue')).toBe(false);
    // reset seeds only this corridor's plans on this bridge
    const { state } = await api.reset();
    expect(bridge.calls.filter((c) => c.fn === 'seedPlan').map((c) => c.args[0]).sort()).toEqual([PLAN_DORIS, PLAN_MARVIN, PLAN_OSCAR, PLAN_ROXANA].sort());
    expect(state.chainContractIds).toEqual({ sv: 'CFAKESV' });
    expect(Object.keys(state.chainPlans ?? {}).sort()).toEqual([PLAN_DORIS, PLAN_MARVIN, PLAN_OSCAR, PLAN_ROXANA].sort());
  });
});

describe('Colombia regression', () => {
  it("María's view is unchanged on the fields the e2e reads, and the pay flow now also writes the paid notices", async () => {
    const api = fast();
    const v = await api.getPlan(PLAN_MARIA);
    const spot = spotAtOffset(0);
    expect(v.installments.map((i) => i.cellState).slice(0, 10)).toEqual(['pagado', 'pagado', 'pagado', 'bloqueado', 'bloqueado', 'bloqueado', 'ofrecido', 'ofrecido', 'ofrecido', 'abierto']);
    for (const i of v.installments) {
      // the pre-corridor formulas, inline
      const usdAtToday = roundUsd(usdDue(i.copDue, spot));
      const usdShown = (i.status === 'locked' || i.status === 'released') && i.usdDue != null ? i.usdDue : usdAtToday;
      expect(i.usdAtToday).toBe(usdAtToday);
      expect(i.usdShown).toBe(usdShown);
      expect(i.diffCop).toBe(i.status === 'locked' && i.lockedRate != null ? roundCop(usdShown * (i.lockedRate - spot)) : 0);
      expect(i.todayRate).toBe(spot);
      expect(i.payable).toBe(i.status !== 'released' && i.status !== 'waived' && i.status !== 'missed' && i.dueDate <= v.today);
    }
    expect(v.installments[3]!.usdDue).toBe(1188.33);
    expect(v.summary.nextUsd).toBe(1188.33);
    expect(v.summary.nextDueDate).toBe('2026-11-20');
    expect(v.seller).toBeNull();
    expect(v.payments).toEqual([]);
    expect(v.corridor).toBe('co');
    const andres = await api.getPlan(PLAN_ANDRES);
    expect(andres.installments[4]).toMatchObject({ cellState: 'bloqueado', isLate: true, inGrace: true, businessDaysLate: 3, lateInGrace: true });
    await expect(api.getPayOptions(PLAN_MARIA, 3)).rejects.toMatchObject({ code: 'NOT_DUE_YET' });
    await api.advanceClock(1);
    const steps: string[] = [];
    const receipt = await api.pay(PLAN_MARIA, 3, (s) => steps.push(s));
    expect(steps).toEqual(['recibido', 'convertido', 'entregado']);
    expect(receipt.copDelivered).toBe(4_093_125);
    const msgs = (await api.listOutbox(PLAN_MARIA)).filter((m) => m.params.n === 4).map((m) => m.template).sort();
    expect(msgs).toEqual(['pago_entregado', 'pago_recibido']);
    expect((await api.listPayouts()).every((p) => p.corridor === 'sv')).toBe(true);
  });

  it('ApiError keeps its import path and code', () => {
    expect(new ApiError('LOCKS_DISABLED').code).toBe('LOCKS_DISABLED');
  });
});
