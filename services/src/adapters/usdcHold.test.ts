// UsdcHold (option A): the released USDC stays at the seller's provider address; the hand-off is
// recorded and reported `transferido` at once, with no fee.
import { describe, expect, it } from 'vitest';
import { MockRuntime } from './mockRuntime';
import { UsdcHold } from './usdcHold';

const T0 = Date.parse('2026-10-20T14:00:00Z');
const hold = (onChain = false) => new UsdcHold({ runtime: new MockRuntime({ minDelayMs: 0, maxDelayMs: 0 }), now: () => T0, onChain });

describe('UsdcHold', () => {
  it('quotes at rate 1 with no fee and refuses a COP target', async () => {
    const p = hold();
    expect(p.name).toContain('(simulado)');
    expect(hold(true).name).toContain('testnet');
    const q = await p.quote({ usdTarget: 500 });
    expect(q).toMatchObject({ rate: 1, usdc: '500.0000000', feeUsd: 0, usdDelivered: 500, copDelivered: 50000 });
    await expect(p.quote({ copTarget: 1 })).rejects.toThrow(/COP/);
  });

  it('records the transfer to the provider address and reports transferido', async () => {
    const p = hold();
    const q = await p.quote({ usdTarget: 500 });
    const t = await p.transfer({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'CUST-LA-7F2A', memo: 'CH-SV-0014-M4', today: '2026-10-20' });
    expect(t.partnerRef).toMatch(/^USDC-HOLD-[0-9A-F]{10}$/);
    expect(t.status).toBe('transferido');
    expect(t.expectedCreditDate).toBeNull();
    expect(p.record(t.partnerRef)).toMatchObject({ providerAddress: 'CUST-LA-7F2A', usdc: '500.0000000', memo: 'CH-SV-0014-M4', status: 'transferido' });
    expect((await p.partnerStatus(t.partnerRef)).status).toBe('transferido');
    expect(await p.status(t.partnerRef)).toBe('completed');
    expect(await p.status('nope')).toBe('error');
    expect((await p.partnerStatus('nope')).status).toBe('error');
  });

  it('tracks seeded hand-offs and refuses an unknown quote', async () => {
    const p = hold();
    p.track({ partnerRef: 'CUST-TX-2026-1180', status: 'transferido', expectedCreditDate: null, errorDetail: null });
    expect((await p.partnerStatus('CUST-TX-2026-1180')).status).toBe('transferido');
    await expect(p.pay({ quoteId: 'nope', usdc: '1.0000000', beneficiaryRef: 'x', memo: 'm' })).rejects.toThrow(/unknown quote/);
  });
});
