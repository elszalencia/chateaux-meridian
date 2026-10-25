// The El Salvador seed: every edge case of the corridor brief is present, every SV receipt and
// payout reconciles to the cent (usdPaid − feeUsd = usdDelivered = copCredited / 100), no SV plan
// carries a lock, a hedge leg or a renewal offer, and the Colombia rows are untouched.

import { describe, expect, it } from 'vitest';
import { CORRIDORS } from '../../../config/corridors';
import { businessDaysBetweenIn } from '../domain/dates';
import type { Receipt } from '../domain/types';
import { REASONS } from '../policy/reasons';
import { deepLinkFor } from '../channels/MessageChannel';
import {
  BASE_DATE,
  OFFICE_CHATEAUX_MIAMI,
  OFFICE_CHATEAUX_SILVER_SPRING,
  OFFICE_MAXI_WOODBRIDGE,
  PLAN_DORIS,
  PLAN_MARIA,
  PLAN_MARVIN,
  PLAN_OSCAR,
  PLAN_ROXANA,
  SEED_VERSION,
  SELLER_ALTAVISTA,
  SELLER_BRISAS,
  SELLER_CUSCATLAN,
  SELLER_LOS_ABETOS,
  SV_DEMO_PLANS,
  buildSeed,
  svSeedClock,
} from './fixtures';

const seed = buildSeed();
const SV = CORRIDORS.sv;
const clock = Date.parse(svSeedClock(BASE_DATE));
const svPlans = seed.plans.filter((p) => p.corridor === 'sv');
const svPlanIds = new Set(svPlans.map((p) => p.id));
const rows = (planId: string) => seed.installments.filter((i) => i.planId === planId).sort((a, b) => a.idx - b.idx);
const plan = (id: string) => seed.plans.find((p) => p.id === id)!;
const round2 = (n: number) => Math.round(n * 100) / 100;

describe('El Salvador seed: plans and dates', () => {
  it('bumps the seed version and lists the four SV plans', () => {
    expect(SEED_VERSION).toBe('2026-10-25.1');
    expect(SV_DEMO_PLANS).toEqual([PLAN_ROXANA, PLAN_MARVIN, PLAN_DORIS, PLAN_OSCAR]);
    expect([...svPlanIds].sort()).toEqual([...SV_DEMO_PLANS].sort());
    for (const p of svPlans) {
      expect(p.sellerId).toBeTruthy();
      expect(p.payoutOption).toBe(seed.sellers.find((s) => s.id === p.sellerId)!.payoutOption);
      expect(p.trustCompany).toBe(seed.sellers.find((s) => s.id === p.sellerId)!.tradeName);
    }
  });

  it('stores cents: installment amounts, prices and down payments', () => {
    expect(plan(PLAN_ROXANA)).toMatchObject({ installmentCop: 75000, installmentsCount: 24, downPaymentCop: 1_800_000, downPaymentPct: 20, mortgageCop: 7_200_000, encargoRef: 'CH-SV-0007B' });
    expect(seed.units.find((u) => u.id === plan(PLAN_ROXANA).unitId)).toMatchObject({ priceCop: 9_000_000, priceBasis: 'fixed', housingType: 'No VIS', department: 'San Salvador' });
    expect(plan(PLAN_MARVIN)).toMatchObject({ installmentCop: 50000, installmentsCount: 26, downPaymentCop: 1_300_000, downPaymentPct: 20, mortgageCop: 5_200_000 });
    expect(plan(PLAN_DORIS)).toMatchObject({ installmentCop: 65000, installmentsCount: 24, downPaymentCop: 1_560_000, mortgageCop: 6_240_000 });
    expect(plan(PLAN_OSCAR)).toMatchObject({ installmentCop: 45000, installmentsCount: 24, downPaymentCop: 1_080_000, mortgageCop: 4_320_000 });
    for (const p of svPlans) {
      const inst = rows(p.id);
      expect(inst).toHaveLength(p.installmentsCount);
      expect(inst.every((i) => i.copDue === p.installmentCop)).toBe(true);
      expect(p.installmentCop * p.installmentsCount).toBe(p.downPaymentCop);
    }
  });

  it('places the dates relative to the demo clock', () => {
    expect(BASE_DATE).toBe('2026-10-20');
    expect(plan(PLAN_ROXANA).startDate).toBe('2026-05-24');
    expect(rows(PLAN_ROXANA)[5]!.dueDate).toBe('2026-10-24'); // M6: BASE_DATE + 4
    expect(rows(PLAN_ROXANA).slice(0, 5).map((i) => i.status)).toEqual(['released', 'released', 'released', 'released', 'released']);
    expect(rows(PLAN_ROXANA)[5]!.status).toBe('open');
    expect(plan(PLAN_MARVIN).startDate).toBe('2026-07-15');
    expect(rows(PLAN_MARVIN)[3]!.dueDate).toBe('2026-10-15');
    expect(plan(PLAN_DORIS).startDate).toBe('2026-10-28'); // BASE_DATE + 8
    expect(rows(PLAN_OSCAR).slice(0, 3).map((i) => `${i.dueDate}:${i.status}`)).toEqual(['2026-08-27:released', '2026-09-27:released', '2026-10-27:open']);
  });

  it('has no locks, hedge legs or renewal offers on any SV plan', () => {
    expect(seed.locks.some((l) => svPlanIds.has(l.planId))).toBe(false);
    expect(seed.hedge_legs.some((l) => svPlanIds.has(l.planId))).toBe(false);
    expect(seed.renewal_offers.some((o) => svPlanIds.has(o.planId))).toBe(false);
    for (const i of seed.installments.filter((i) => svPlanIds.has(i.planId))) {
      expect(i.lockId).toBeNull();
      expect(i.lockedRate).toBeNull();
      expect(i.lockExpiry).toBeNull();
    }
  });
});

describe('El Salvador seed: edge cases', () => {
  const roxanaM6 = seed.payments.filter((p) => p.planId === PLAN_ROXANA && p.idx === 5);

  it('MoneyGram reference quote_expired (Roxana M6)', () => {
    const expired = roxanaM6.find((p) => p.status === 'quote_expired')!;
    expect(expired).toMatchObject({ method: 'moneygram_cash', amount: 75000, fee: 499, receivedAt: null, receiptId: null });
    expect(expired.externalRef).toMatch(/^\d{10}$/);
    expect(Date.parse(expired.expiresAt!) - Date.parse(expired.createdAt)).toBe(SV.moneyGram!.referenceTtlMinutes * 60_000);
    expect(Date.parse(expired.expiresAt!)).toBeLessThan(clock);
  });

  it('MoneyGram cash-in pending for more than 10 minutes (Roxana M6)', () => {
    const pending = roxanaM6.find((p) => p.status === 'pending')!;
    expect(pending).toMatchObject({ method: 'moneygram_cash', amount: 75000, fee: 499, receivedAt: null });
    expect(pending.externalRef).toMatch(/^\d{10}$/);
    const ageMinutes = (clock - Date.parse(pending.createdAt)) / 60_000;
    expect(ageMinutes).toBeGreaterThan(SV.moneyGram!.pendingAlertMinutes);
    expect(Date.parse(pending.expiresAt!)).toBeGreaterThan(clock); // still payable
    expect(rows(PLAN_ROXANA)[5]!.status).toBe('open'); // not credited before `completed`
    expect(seed.receipts.some((r) => r.planId === PLAN_ROXANA && r.installmentIdx === 5)).toBe(false);
  });

  it('MoneyGram attempt above USD 950, blocked (Marvin)', () => {
    const blocked = seed.payments.find((p) => p.planId === PLAN_MARVIN && p.status === 'blocked')!;
    expect(blocked).toMatchObject({ method: 'moneygram_cash', blockedReason: 'above_limit', amount: 100000, idx: 3, receiptId: null, externalRef: null });
    expect(blocked.amount / 100).toBeGreaterThan(SV.moneyGram!.maxUsd);
    expect(blocked.createdAt.slice(0, 10)).toBe('2026-10-19');
  });

  it('Tier 2 seller with a CNR alert, its plan on hold (Altavista / Óscar)', () => {
    const seller = seed.sellers.find((s) => s.id === SELLER_ALTAVISTA)!;
    expect(seller).toMatchObject({ tier: 2, verificationStatus: 'verified', payoutOption: 'B' });
    const unit = seed.seller_units.find((u) => u.sellerId === SELLER_ALTAVISTA)!;
    expect(unit).toMatchObject({ alertStatus: 'lien_registered', unitId: plan(PLAN_OSCAR).unitId });
    expect(unit.alertAt!.slice(0, 10)).toBe('2026-10-17');
    expect(unit.alertDetail).toContain('simulado');
    expect(REASONS.CNR_LIEN).toEqual({ code: 306, key: 'cnrLien' });
    const gov = seed.plan_governance.find((g) => g.planId === PLAN_OSCAR)!;
    expect(gov).toMatchObject({ state: 'on_hold', holdPrev: 'active', reasonCode: 306, since: '2026-10-17' });
    const hold = seed.policy_events.find((e) => e.planId === PLAN_OSCAR && e.kind === 'place_hold')!;
    expect(hold).toMatchObject({ from: 'active', to: 'on_hold', reasonCode: 306, rule: 'operator', executed: true });
    expect(hold.detail).toContain('CNR');
    expect(rows(PLAN_OSCAR).filter((i) => i.status === 'released')).toHaveLength(2);
    expect(seed.payouts.filter((p) => p.planId === PLAN_OSCAR).every((p) => p.status === 'acreditado')).toBe(true);
  });

  it('payout-account change in cooling-off (Los Abetos)', () => {
    const seller = seed.sellers.find((s) => s.id === SELLER_LOS_ABETOS)!;
    expect(seller).toMatchObject({ tier: 2, payoutOption: 'A', verificationStatus: 'verified' });
    expect(seller.payoutAccount).toMatchObject({ kind: 'provider_address', ref: 'CUST-LA-7F2A' });
    expect(seller.pendingPayoutAccount).toMatchObject({ kind: 'provider_address', ref: 'CUST-LA-9C41' });
    expect(Date.parse(seller.payoutChangePendingUntil!) - clock).toBe(52 * 3_600_000);
  });

  it('installment late inside grace (Marvin M4, SV calendar)', () => {
    const m4 = rows(PLAN_MARVIN)[3]!;
    expect(m4.status).toBe('open');
    const late = businessDaysBetweenIn(m4.dueDate, BASE_DATE, SV.holidays);
    expect(late).toBe(3);
    expect(late).toBeLessThanOrEqual(SV.graceBusinessDays);
    const notice = seed.policy_events.find((e) => e.planId === PLAN_MARVIN && e.kind === 'late_in_grace')!;
    expect(notice).toMatchObject({ idx: 3, executed: false, from: 'active', to: 'active', at: BASE_DATE });
    expect(seed.plan_governance.find((g) => g.planId === PLAN_MARVIN)!.state).toBe('active');
  });

  it('option B payout in transit (Roxana M5) and in error (Roxana M4)', () => {
    const payout = (idx: number) => seed.payouts.find((p) => p.planId === PLAN_ROXANA && p.idx === idx)!;
    expect(payout(4)).toMatchObject({ option: 'B', status: 'en_transito', creditedAt: null, errorDetail: null });
    expect(payout(4).sentAt).toBeTruthy();
    expect(payout(4).expectedCreditDate).toBe(BASE_DATE); // sent the day before, one business day later
    expect(payout(3)).toMatchObject({ option: 'B', status: 'error', creditedAt: null });
    expect(payout(3).errorDetail).toContain('simulado');
    for (const idx of [0, 1, 2]) {
      expect(payout(idx)).toMatchObject({ option: 'B', status: 'acreditado' });
      expect(payout(idx).creditedAt).toBeTruthy();
      expect(payout(idx).partnerRef).toMatch(/^DSV-TRF-2026-\d{4}$/);
    }
    expect(seed.payouts.filter((p) => p.planId === PLAN_MARVIN).every((p) => p.option === 'A' && p.status === 'transferido')).toBe(true);
  });

  it('empty office search: no buyer phone contains 5550000', () => {
    expect(seed.buyers.length).toBeGreaterThan(0);
    expect(seed.buyers.some((b) => b.phone.replace(/\D/g, '').includes('5550000'))).toBe(false);
  });

  it('buyer with no payments yet (Doris, MoneyGram hidden by her state)', () => {
    const doris = seed.buyers.find((b) => b.id === plan(PLAN_DORIS).buyerId)!;
    expect(doris.state).toBe('LA');
    expect(SV.moneyGram!.excludedStates).toContain(doris.state);
    expect(doris.officeId).toBeNull();
    expect(seed.payments.some((p) => p.planId === PLAN_DORIS)).toBe(false);
    expect(seed.receipts.some((r) => r.planId === PLAN_DORIS)).toBe(false);
    expect(seed.payouts.some((r) => r.planId === PLAN_DORIS)).toBe(false);
    expect(rows(PLAN_DORIS).every((i) => i.status === 'open')).toBe(true);
    expect(rows(PLAN_DORIS)[0]!.dueDate > BASE_DATE).toBe(true);
  });
});

describe('El Salvador seed: reconciliation and consistency', () => {
  const svReceipts: Receipt[] = seed.receipts.filter((r) => svPlanIds.has(r.planId));

  it('usdPaid − feeUsd = usdDelivered = copCredited / 100 on every SV receipt and payout', () => {
    expect(svReceipts.length).toBe(5 + 3 + 2);
    for (const r of svReceipts) {
      expect(round2(r.usdPaid - r.feeUsd)).toBe(r.usdDelivered);
      expect(r.usdDelivered).toBe(r.copCredited / 100);
      expect(r.copDelivered).toBe(r.copCredited);
      expect(r.anchorCop).toBe(r.copCredited);
      expect(r.copCredited).toBe(seed.installments.find((i) => i.planId === r.planId && i.idx === r.installmentIdx)!.copDue);
      expect(r).toMatchObject({ rateKind: 'spot', lockedRate: null, spotAtPayment: 1, anchorRate: 1, basisCop: 0, marginCop: 0, ndfSettlementCop: null, breakCostCop: 0, fxDeclarationRef: '', lockId: null, hedgeTradeId: null });
      expect(r.feeUsd).toBe(SV.feesUsd[r.method!]);
      expect(r.txHash).toMatch(/^[0-9a-f]{64}$/);
      const payout = seed.payouts.find((p) => p.id === r.payoutId)!;
      expect(payout).toMatchObject({ planId: r.planId, idx: r.installmentIdx, usdPaid: r.usdPaid, feeUsd: r.feeUsd, usdToSeller: r.usdDelivered, receiptId: r.id, releaseTx: r.txHash });
      expect(round2(payout.usdPaid - payout.feeUsd)).toBe(payout.usdToSeller);
      expect(payout.sellerId).toBe(plan(r.planId).sellerId);
      const payment = seed.payments.find((p) => p.id === r.paymentId)!;
      expect(payment).toMatchObject({ status: 'completed', method: r.method, amount: r.copCredited, fee: Math.round(r.feeUsd * 100), receiptId: r.id, planId: r.planId, idx: r.installmentIdx });
      expect(payment.receivedAt).toBe(r.paidAt);
    }
    expect(seed.payouts.filter((p) => svPlanIds.has(p.planId))).toHaveLength(svReceipts.length);
  });

  it('method mix and the fee convention per method', () => {
    const roxana = svReceipts.filter((r) => r.planId === PLAN_ROXANA).sort((a, b) => a.installmentIdx - b.installmentIdx);
    expect(roxana.map((r) => r.method)).toEqual(['moneygram_cash', 'moneygram_cash', 'office_counter', 'moneygram_cash', 'office_counter']);
    expect(roxana[0]).toMatchObject({ usdPaid: 754.99, feeUsd: 4.99, usdDelivered: 750, copCredited: 75000 });
    expect(roxana[2]).toMatchObject({ usdPaid: 750, feeUsd: 0, usdDelivered: 750, copCredited: 75000 });
    const counter = seed.payments.filter((p) => p.planId === PLAN_ROXANA && p.method === 'office_counter');
    expect(counter.every((p) => p.officeId === OFFICE_MAXI_WOODBRIDGE && p.cashierId === 'cajero-1' && p.tender === 'cash' && p.changeDue === p.amountReceived! - p.amount)).toBe(true);
    const marvin = svReceipts.filter((r) => r.planId === PLAN_MARVIN);
    expect(marvin.every((r) => r.method === 'ach' && r.usdPaid === 501.5 && r.feeUsd === 1.5 && r.usdDelivered === 500)).toBe(true);
    for (const i of seed.installments.filter((i) => svPlanIds.has(i.planId) && i.status === 'released')) {
      const r = seed.receipts.find((x) => x.id === i.receiptId)!;
      expect(i.usdDue).toBe(r.usdDelivered);
      expect(i.releasedTx).toBe(r.txHash);
    }
  });

  it('sellers, offices and the title checks', () => {
    expect(seed.sellers.map((s) => s.id).sort()).toEqual([SELLER_ALTAVISTA, SELLER_BRISAS, SELLER_CUSCATLAN, SELLER_LOS_ABETOS].sort());
    expect(seed.sellers.every((s) => s.simulated && s.corridor === 'sv')).toBe(true);
    expect(seed.sellers.find((s) => s.id === SELLER_CUSCATLAN)).toMatchObject({ tier: 1, verificationStatus: 'verified', payoutOption: 'B', releasesCount: 5, kybRef: 'KYB-SV-2026-0012' });
    expect(seed.sellers.find((s) => s.id === SELLER_BRISAS)).toMatchObject({ tier: 2, verificationStatus: 'pending', payoutAccount: null, pendingPayoutAccount: null, releasesCount: 0, verifiedAt: null });
    expect(seed.plans.some((p) => p.sellerId === SELLER_BRISAS)).toBe(false);
    // The unverified seller has no payout address yet.
    for (const s of seed.sellers) expect(s.verificationStatus === 'verified' ? s.payoutAccount !== null : s.payoutAccount === null).toBe(true);
    // One title check per SV unit, 64-hex certificate hashes.
    const svUnitIds = new Set(svPlans.map((p) => p.unitId));
    expect(seed.seller_units.map((u) => u.unitId).sort()).toEqual([...svUnitIds].sort());
    expect(seed.seller_units.every((u) => /^[0-9a-f]{64}$/.test(u.cnrCertHash) && /^CNR-[A-Z]{2}-2026-\d{6}$/.test(u.cnrRegistryNo))).toBe(true);
    expect(seed.seller_units.filter((u) => u.alertStatus !== 'none').map((u) => u.sellerId)).toEqual([SELLER_ALTAVISTA]);
    expect(seed.offices.map((o) => `${o.id}:${o.corridor}:${o.isLicensedAgency}`).sort()).toEqual(
      [`${OFFICE_MAXI_WOODBRIDGE}:sv:true`, `${OFFICE_CHATEAUX_SILVER_SPRING}:sv:false`, `${OFFICE_CHATEAUX_MIAMI}:co:false`].sort(),
    );
    expect(seed.offices.every((o) => o.simulated && o.hours.length > 0 && o.phone.length > 0 && o.address.length > 0)).toBe(true);
    for (const b of seed.buyers.filter((b) => b.officeId)) expect(seed.offices.some((o) => o.id === b.officeId)).toBe(true);
  });

  it('the WhatsApp outbox is not empty and every message is well formed', () => {
    expect(seed.wa_outbox.length).toBeGreaterThanOrEqual(5);
    const templates = new Set(seed.wa_outbox.map((m) => m.template));
    for (const t of ['recordatorio', 'referencia_moneygram', 'pago_entregado', 'pago_atrasado', 'plan_en_pausa']) expect(templates.has(t as never)).toBe(true);
    for (const m of seed.wa_outbox) {
      expect(m.body.length).toBeLessThanOrEqual(1024);
      expect(m.to).toMatch(/^\+1\d{10}$/);
      expect(m.link).toMatch(/^#\/(c\/plan-[a-z]+\/(pagar|recibo\/\d+)|comprador\/plan-[a-z]+)$/);
      expect(m.body).toContain(m.link);
      expect(m).toMatchObject({ channel: 'whatsapp', simulated: true, locale: 'es' });
      expect(SV.whatsappTemplates).toContain(m.template);
      expect(seed.buyers.find((b) => b.id === m.buyerId)!.phone.replace(/\D/g, '')).toBe(m.to.slice(1));
      expect(Object.keys(m.params).length).toBeGreaterThan(0);
    }
    expect(seed.wa_outbox.find((m) => m.id === 'wa-roxana-pago-entregado-4')!.link).toBe(`#/c/${PLAN_ROXANA}/recibo/4`);
  });

  it('every seeded outbox link is exactly what deepLinkFor(template, plan) produces', () => {
    // The receipt templates carry the installment number n; their link names index n - 1.
    const receiptTemplates = new Set(['pago_recibido', 'pago_entregado']);
    for (const m of seed.wa_outbox) {
      const idx = receiptTemplates.has(m.template) ? Number(m.params.n) - 1 : null;
      expect(m.link, m.id).toBe(deepLinkFor(m.template, m.planId, idx));
      expect(m.params.link, m.id).toBe(m.link);
    }
    expect(seed.wa_outbox.find((m) => m.id === 'wa-oscar-plan-en-pausa')!.link).toBe(`#/comprador/${PLAN_OSCAR}`);
  });

  it('every SV plan has a governance row and the Colombia rows are untouched', () => {
    for (const p of svPlans) expect(seed.plan_governance.some((g) => g.planId === p.id)).toBe(true);
    expect(seed.plans.slice(0, 7).map((p) => p.id)).toEqual(['plan-maria', 'plan-andres', 'plan-camila', 'plan-luis', 'plan-paola', 'plan-jorge', 'plan-natalia']);
    expect(seed.plans.slice(0, 7).every((p) => p.corridor === undefined && p.sellerId === undefined)).toBe(true);
    expect(plan(PLAN_MARIA)).toMatchObject({ startDate: '2026-08-20', installmentCop: 4_093_125, trustCompany: 'Fidudavivienda' });
    expect(seed.installments.find((i) => i.id === `${PLAN_MARIA}:3`)!.dueDate).toBe('2026-11-20');
    expect(seed.receipts.filter((r) => !svPlanIds.has(r.planId)).every((r) => r.method === undefined && r.payoutId === undefined)).toBe(true);
    expect(seed.payments.every((p) => svPlanIds.has(p.planId))).toBe(true);
  });
});
