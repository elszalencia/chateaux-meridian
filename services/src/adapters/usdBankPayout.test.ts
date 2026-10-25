// UsdBankPayout (option B, simulado): rate 1 and a zero partner fee, the DSV-TRF reference, the
// expected credit date 0 to 3 business days ahead on the corridor's calendar, the status walk,
// the error switch and the tracking of seeded transfers.
import { describe, expect, it } from 'vitest';
import { corridor } from '../corridors/index';
import { businessDaysBetweenIn, isBusinessDayIn } from '../domain/dates';
import { MockRuntime } from './mockRuntime';
import { UsdBankPayout } from './usdBankPayout';

const SV = corridor('sv');
const T0 = Date.parse('2026-10-20T14:00:00Z');
const TODAY = '2026-10-20';

const rail = () => new UsdBankPayout({ runtime: new MockRuntime({ minDelayMs: 0, maxDelayMs: 0 }), corridor: SV, now: () => T0 });

describe('UsdBankPayout', () => {
  it('quotes a USD target at rate 1 with a zero partner fee, and refuses a COP target', async () => {
    const p = rail();
    expect(p.name).toContain('(simulado)');
    const q = await p.quote({ usdTarget: 750 });
    expect(q).toMatchObject({ rate: 1, usdc: '750.0000000', feeUsd: 0, usdDelivered: 750, copDelivered: 75000 });
    const bySell = await p.quote({ usdc: '500.0000000' });
    expect(bySell.usdDelivered).toBe(500);
    await expect(p.quote({ copTarget: 4_093_125 })).rejects.toThrow(/COP/);
  });

  it('sends a transfer: enviado, a DSV-TRF reference and a credit date 0–3 business days ahead on the corridor calendar', async () => {
    const p = rail();
    const q = await p.quote({ usdTarget: 750 });
    const t = await p.transfer({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'USD ••• 4471', memo: 'CH-SV-0007B-M6', today: TODAY });
    expect(t.partnerRef).toMatch(/^DSV-TRF-[0-9A-F]{10}$/);
    expect(t.status).toBe('enviado');
    expect(t.errorDetail).toBeNull();
    expect(t.expectedCreditDate).not.toBeNull();
    expect(isBusinessDayIn(t.expectedCreditDate!, SV.holidays) || t.expectedCreditDate === TODAY).toBe(true);
    expect(businessDaysBetweenIn(TODAY, t.expectedCreditDate!, SV.holidays)).toBeLessThanOrEqual(3);
    expect(await p.status(t.partnerRef)).toBe('pending');
  });

  it('walks enviado → en_transito → acreditado on successive reads, or jumps to acreditado when the demo clock reaches the credit date', async () => {
    const p = rail();
    const q = await p.quote({ usdTarget: 750 });
    const t = await p.transfer({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'x', memo: 'm', today: TODAY });
    const s1 = await p.partnerStatus(t.partnerRef, TODAY);
    const s2 = await p.partnerStatus(t.partnerRef, TODAY);
    const s3 = await p.partnerStatus(t.partnerRef, TODAY);
    expect([s1.status, s2.status, s3.status].filter((s) => s === 'acreditado').length).toBeGreaterThanOrEqual(1);
    expect(s3.status).toBe('acreditado');
    expect(await p.status(t.partnerRef)).toBe('completed');

    const q2 = await p.quote({ usdTarget: 500 });
    const t2 = await p.transfer({ quoteId: q2.quoteId, usdc: q2.usdc, beneficiaryRef: 'y', memo: 'n', today: TODAY });
    const later = await p.partnerStatus(t2.partnerRef, '2026-11-20');
    expect(later.status).toBe('acreditado');
  });

  it('failNext makes the next transfer land in error with a partner detail; the following one is fine', async () => {
    const p = rail();
    p.failNext();
    const q = await p.quote({ usdTarget: 750 });
    const bad = await p.transfer({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'x', memo: 'm', today: TODAY });
    expect(bad.status).toBe('error');
    expect(bad.errorDetail).toContain('simulado');
    expect(bad.expectedCreditDate).toBeNull();
    expect(await p.status(bad.partnerRef)).toBe('error');
    expect((await p.partnerStatus(bad.partnerRef, '2027-01-01')).status).toBe('error');
    const q2 = await p.quote({ usdTarget: 750 });
    const ok = await p.transfer({ quoteId: q2.quoteId, usdc: q2.usdc, beneficiaryRef: 'x', memo: 'm2', today: TODAY });
    expect(ok.status).toBe('enviado');
  });

  it('tracks a transfer it did not create (a seeded payout) and walks it too; unknown references are errors', async () => {
    const p = rail();
    expect((await p.partnerStatus('DSV-TRF-2026-0005', TODAY)).status).toBe('error');
    p.track({ partnerRef: 'DSV-TRF-2026-0005', status: 'en_transito', expectedCreditDate: '2026-10-21', errorDetail: null });
    expect((await p.partnerStatus('DSV-TRF-2026-0005', TODAY)).status).toBe('acreditado');
    p.track({ partnerRef: 'DSV-TRF-2026-0006', status: 'enviado', expectedCreditDate: '2026-10-23', errorDetail: null });
    expect((await p.partnerStatus('DSV-TRF-2026-0006', TODAY)).status).toBe('en_transito');
    expect((await p.partnerStatus('DSV-TRF-2026-0006', '2026-10-23')).status).toBe('acreditado');
  });

  it('pay/status implement OffRampProvider over the same transfers', async () => {
    const p = rail();
    const q = await p.quote({ usdTarget: 750 });
    const { txId } = await p.pay({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'x', memo: 'm' });
    expect(txId).toMatch(/^DSV-TRF-/);
    expect(await p.status(txId)).toBe('pending');
    await expect(p.pay({ quoteId: 'nope', usdc: '1.0000000', beneficiaryRef: 'x', memo: 'm' })).rejects.toThrow(/unknown quote/);
  });
});
