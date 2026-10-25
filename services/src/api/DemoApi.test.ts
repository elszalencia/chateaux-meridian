// End-to-end of the service layer on the seed: the frozen demo script's states, the edge cases,
// the error mode and the reset timing, all without a browser.
import { describe, expect, it } from 'vitest';
import { createMockApi } from './createMockApi';
import { PLAN_ANDRES, PLAN_CAMILA, PLAN_MARIA } from '../seed/fixtures';
import { ApiError } from './DemoApi';
import { MockProviderError } from '../adapters/mockRuntime';

const fast = (now?: () => number) => createMockApi({ minDelayMs: 0, maxDelayMs: 0, now });

describe('seed: step 1 state', () => {
  it('María: M1–M3 paid, M4–M6 locked at 3,444.427 / USD 1,188.33, M7–M9 offered, M10+ open', async () => {
    const api = fast();
    const v = await api.getPlan(PLAN_MARIA);
    expect(v.buyer.name).toBe('María Fernanda Rojas');
    expect(v.unit.unitName).toBe('Oliva');
    expect(v.plan.encargoRef).toBe('FD-OLV-0142');
    expect(v.plan.installmentCop).toBe(4_093_125);
    expect(v.plan.downPaymentCop).toBe(98_235_000);
    expect(v.installments.map((i) => i.cellState).slice(0, 10)).toEqual([
      'pagado', 'pagado', 'pagado', 'bloqueado', 'bloqueado', 'bloqueado', 'ofrecido', 'ofrecido', 'ofrecido', 'abierto',
    ]);
    const m4 = v.installments[3]!;
    expect(m4.usdDue).toBe(1188.33);
    expect(Math.abs(m4.lockedRate! - 3444.427)).toBeLessThanOrEqual(0.001);
    expect(m4.dueDate).toBe('2026-11-20');
    expect(m4.payable).toBe(false);
    expect(v.activeOffer?.idxs).toEqual([6, 7, 8]);
    expect(v.summary.nextUsd).toBe(1188.33);
    expect(v.summary.nextDueDate).toBe('2026-11-20');
    expect(v.today).toBe('2026-10-20');
  });

  it('edge cases are present', async () => {
    const api = fast();
    const andres = await api.getPlan(PLAN_ANDRES);
    const m3 = andres.installments[2]!;
    expect(m3.cellState).toBe('roto');
    expect(m3.breakCostCop).toBeGreaterThan(0);
    const roto = andres.locks.find((l) => l.state === 'roto');
    expect(roto?.breakCostCop).toBe(m3.breakCostCop);
    const m5 = andres.installments[4]!;
    expect(m5.cellState).toBe('bloqueado');
    expect(m5.isLate).toBe(true);
    expect(m5.inGrace).toBe(true);
    expect(m5.businessDaysLate).toBe(3);

    const maria = await api.getPlan(PLAN_MARIA);
    expect(maria.locks.some((l) => l.state === 'vencido')).toBe(true);

    const camila = await api.getPlan(PLAN_CAMILA);
    expect(camila.locks).toHaveLength(0);
    expect(camila.summary.paidCount).toBe(2);

    const recon = await api.getReconciliation();
    expect(recon.some((r) => r.status === 'diferencia')).toBe(true);
    expect(recon.some((r) => r.status === 'pendiente')).toBe(true);
    expect(recon.some((r) => r.status === 'conciliado')).toBe(true);
  });

  it('treasury: Q1 hedge delivered COP 12,358,167 for COP 12,279,375 owed, margin 78,792', async () => {
    const api = fast();
    const book = await api.getHedgeBook();
    const mariaQ1 = book.quarters.flatMap((q) => q.legs).filter((l) => l.lockId === 'lock-maria-q1');
    expect(mariaQ1).toHaveLength(3);
    const delivered = Math.round(mariaQ1.reduce((a, l) => a + l.usdNotional * l.fwdRate, 0));
    expect(delivered).toBe(12_358_167);
    expect(Math.round(mariaQ1.reduce((a, l) => a + l.usdNotional * (l.fwdRate - l.lockedRate), 0))).toBe(78_792);
    expect(book.pendingLegCount).toBe(0);
    expect(book.totals.breakCostCop).toBeGreaterThan(0);
  });
});

describe('steps 2 to 5 on the service layer', () => {
  it('quote → accept Q3 → M7–M9 locked; legs unhedged; book strip → hedged; clock +1 → pay M4 → receipt and reconciliation', async () => {
    let t = Date.parse('2026-10-20T15:00:00Z');
    const api = fast(() => t);

    // step 2
    const q = await api.quoteLock(PLAN_MARIA, 'trimestral');
    expect(q.idxs).toEqual([6, 7, 8]);
    expect(q.usdPerInstallment).toBe(1188.33);
    expect(Math.abs(q.lockedRate - 3444.427)).toBeLessThanOrEqual(0.001);
    expect(Date.parse(q.quoteExpiresAt) - t).toBe(10 * 60 * 1000);
    const after = await api.acceptLock(q.lock.id);
    expect(after.installments.slice(6, 9).map((i) => i.cellState)).toEqual(['bloqueado', 'bloqueado', 'bloqueado']);
    expect(after.activeOffer).toBeNull();

    // step 4 (treasury): new legs are unhedged until booked
    let book = await api.getHedgeBook();
    expect(book.pendingLegCount).toBe(3);
    expect(book.totals.unhedgedUsd).toBeCloseTo(3 * 1188.3327, 2);
    const trades = await api.bookStrip();
    expect(trades).toHaveLength(3);
    expect(trades[0]!.banrepRef).toMatch(/^BR-DER-/);
    book = await api.getHedgeBook();
    expect(book.pendingLegCount).toBe(0);
    expect(book.totals.unhedgedUsd).toBe(0);
    await expect(api.bookStrip()).rejects.toMatchObject({ code: 'NOTHING_TO_BOOK' });

    // step 3: advance the clock one month so M4 is due, then pay it
    const s = await api.advanceClock(1);
    expect(s.today).toBe('2026-11-20');
    const plan = await api.getPlan(PLAN_MARIA);
    expect(plan.installments[3]!.payable).toBe(true);
    expect(plan.installments[3]!.cellState).toBe('bloqueado'); // not broken: due today, zero days late
    const steps: string[] = [];
    const receipt = await api.pay(PLAN_MARIA, 3, (st) => steps.push(st));
    expect(steps).toEqual(['recibido', 'convertido', 'entregado']);
    expect(receipt.usdPaid).toBe(1188.33);
    expect(receipt.rateKind).toBe('locked');
    expect(receipt.spotAtPayment).toBe(3398.61);
    expect(receipt.copDelivered).toBe(4_093_125);
    expect(receipt.ndfSettlementCop).toBe(Math.round((3442.145 - 3398.61) * 1188.33));
    expect(receipt.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.lockId).toBe('lock-maria-q2');
    expect(receipt.paidAt.slice(0, 10)).toBe('2026-11-20'); // demo date, not the wall clock

    // step 5 (builder): M4 reconciled
    const recon = await api.getReconciliation({ project: 'Parque Natura' });
    const m4 = recon.find((r) => r.planId === PLAN_MARIA && r.number === 4)!;
    expect(m4.status).toBe('conciliado');
    expect(m4.anchorCop + m4.ndfSettlementCop! - m4.basisCop - m4.marginCop - m4.copCredited).toBeLessThanOrEqual(50);
    await expect(api.pay(PLAN_MARIA, 3)).rejects.toMatchObject({ code: 'ALREADY_PAID' });
  });

  it('an expired quote cannot be accepted and is marked vencido', async () => {
    let t = Date.parse('2026-10-20T15:00:00Z');
    const api = fast(() => t);
    const q = await api.quoteLock(PLAN_MARIA, 'mensual');
    expect(q.usdPerInstallment).toBe(1192.55);
    t += 10 * 60 * 1000 + 1;
    await expect(api.acceptLock(q.lock.id)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
    const v = await api.getPlan(PLAN_MARIA);
    expect(v.locks.find((l) => l.id === q.lock.id)?.state).toBe('vencido');
  });

  it('pay ahead converts the next open quarter at today\'s rate, delivering exactly the COP due', async () => {
    const api = fast();
    const receipts = await api.payAhead(PLAN_MARIA);
    expect(receipts.map((r) => r.installmentIdx)).toEqual([6, 7, 8]);
    expect(receipts[0]!.rateKind).toBe('spot');
    expect(receipts[0]!.usdPaid).toBe(1196.01); // ceil to the cent of 4,093,125 / 3,422.325
    for (const r of receipts) {
      expect(r.copDelivered).toBe(4_093_125);
      expect(r.anchorCop).toBe(4_093_125);
      expect(r.copCredited).toBe(4_093_125);
      expect(r.basisCop).toBe(0);
      expect(r.marginCop).toBe(0);
      expect(r.usdPaid * r.anchorRate).toBeGreaterThanOrEqual(4_093_125);
    }
    const v = await api.getPlan(PLAN_MARIA);
    expect(v.installments.slice(6, 9).every((i) => i.cellState === 'pagado')).toBe(true);
    const recon = await api.getReconciliation({ project: 'Parque Natura' });
    for (const n of [7, 8, 9]) {
      const row = recon.find((r) => r.planId === PLAN_MARIA && r.number === n)!;
      expect(row.status).toBe('conciliado');
      expect(row.anchorCop - row.copCredited).toBe(0);
    }
  });

  it('seeded spot receipts (Camila) deliver exactly the COP due', async () => {
    const api = fast();
    const receipts = await api.getReceipts(PLAN_CAMILA);
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r.rateKind).toBe('spot');
      expect(r.copDelivered).toBe(2_562_500);
      expect(r.anchorCop).toBe(2_562_500);
      expect(r.copCredited).toBe(2_562_500);
      expect(Math.round(r.usdPaid * 100) / 100).toBe(r.usdPaid);
      expect(r.usdPaid * r.anchorRate).toBeGreaterThanOrEqual(2_562_500);
    }
  });

  it('a locked installment left unpaid beyond grace breaks with a break cost on the next clock tick', async () => {
    const api = fast();
    await api.advanceClock(2); // 2026-12-20: M4 (due 20 nov) is 19 business days late (8 dec is a festivo)
    const v = await api.getPlan(PLAN_MARIA);
    expect(v.installments[3]!.cellState).toBe('roto');
    expect(v.installments[4]!.cellState).toBe('bloqueado'); // due today: not late
    const lock = v.locks.find((l) => l.id === 'lock-maria-q2')!;
    expect(lock.state).toBe('roto');
    expect(lock.breakCostCop).toBe(Math.round(Math.max(0, 3455.23 - 3442.145) * 1188.3327462335292));
  });

  it('renewal offer appears 10 days before the last locked installment', async () => {
    const api = fast();
    // Andrés Q2 ends 2026-11-15; offer window opens 2026-11-05. Base date + 1 month = 2026-11-20 (past the last due date) so
    // check with María's Q2 instead: last due 2027-01-20, window from 2027-01-10; +3 months = 2027-01-20.
    await api.payAhead(PLAN_MARIA); // clears the seeded Q3 offer path by paying M7–M9 at spot
    await api.advanceClock(1);
    await api.pay(PLAN_MARIA, 3);
    await api.advanceClock(1);
    await api.pay(PLAN_MARIA, 4);
    await api.advanceClock(1); // 2027-01-20
    const v = await api.getPlan(PLAN_MARIA);
    expect(v.today).toBe('2027-01-20');
    expect(v.activeOffer?.idxs).toEqual([9, 10, 11]);
  });

  it('pass-through re-prices new quotes only', async () => {
    const api = fast();
    await api.setPassThrough(1);
    const q = await api.quoteLock(PLAN_MARIA, 'trimestral');
    expect(q.lockedRate).toBeCloseTo(3466.5283, 3);
    const v = await api.getPlan(PLAN_MARIA);
    expect(Math.abs(v.installments[3]!.lockedRate! - 3444.427)).toBeLessThanOrEqual(0.001);
  });
});

describe('error mode and reset', () => {
  it('error mode makes provider-backed actions fail with a typed error; reset restores step 1 in well under 10 s', async () => {
    const api = fast();
    await api.setErrorMode(true);
    await expect(api.getPlan(PLAN_MARIA)).rejects.toBeInstanceOf(MockProviderError);
    await expect(api.quoteLock(PLAN_MARIA, 'trimestral')).rejects.toBeInstanceOf(MockProviderError);
    await api.setErrorMode(false);
    await api.quoteLock(PLAN_MARIA, 'trimestral');
    await api.advanceClock(1);
    const { state, elapsedMs } = await api.reset();
    expect(state.today).toBe('2026-10-20');
    expect(state.clockOffsetMonths).toBe(0);
    expect(state.errorMode).toBe(false);
    expect(elapsedMs).toBeLessThan(10_000);
    const v = await api.getPlan(PLAN_MARIA);
    expect(v.installments.slice(6, 9).every((i) => i.cellState === 'ofrecido')).toBe(true);
    expect(v.locks.filter((l) => l.state === 'cotizado')).toHaveLength(0);
  });

  it('ApiError carries a code', () => {
    expect(new ApiError('CUTOFF').code).toBe('CUTOFF');
  });
});
