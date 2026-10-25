/// <reference types="node" />
// Verification criteria 1 to 5 (math) plus the fixed-point rule (checked against the vectors shared
// with the contract) and the lock rules.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  acceptanceCutoffDate,
  breakCost,
  businessDaysLate,
  decimalToFixed,
  fixedPointCopFromUsd,
  fixedPointRate,
  fixedPointUsdDue,
  graceEndDate,
  isBeforeCutoff,
  isBeyondGrace,
  lockedRate,
  ndfSettlement,
  nextLockableIdxs,
  priceLock,
  roundUsd,
  shouldOfferRenewal,
  stroopsToUsd,
  usdDue,
  usdToCoverCop,
} from './engine';

// Seed curve, 17 Jun 2026 mid (cbonds)
const SPOT = 3422.325;
const F1M = 3442.145;
const F2M = 3464.645;
const F3M = 3492.795;
const COP_DUE = 4_093_125;

describe('criterion 1: quarterly locked rate', () => {
  it('is 3,444.427 (±0.001) at pass-through 50%', () => {
    const r = lockedRate({ spot: SPOT, fwdRates: [F1M, F2M, F3M], passThrough: 0.5 });
    expect(Math.abs(r - 3444.427)).toBeLessThanOrEqual(0.001);
    expect(r).toBeCloseTo(3444.4266667, 6);
  });
});

describe('criterion 2: monthly locked rate', () => {
  it('is 3,432.235 for a 1M installment', () => {
    const r = lockedRate({ spot: SPOT, fwdRates: [F1M], passThrough: 0.5 });
    expect(Math.abs(r - 3432.235)).toBeLessThanOrEqual(0.001);
  });
});

describe('criterion 3: USD per installment', () => {
  it('quarterly lock = 1,188.33', () => {
    const p = priceLock([COP_DUE, COP_DUE, COP_DUE], { spot: SPOT, fwdRates: [F1M, F2M, F3M], passThrough: 0.5 });
    expect(p.usdPerInstallment).toBe(1188.33);
  });
  it('monthly lock = 1,192.55', () => {
    const p = priceLock([COP_DUE], { spot: SPOT, fwdRates: [F1M], passThrough: 0.5 });
    expect(p.usdPerInstallment).toBe(1192.55);
  });
  it('at spot = 1,196.01', () => {
    expect(roundUsd(usdDue(COP_DUE, SPOT))).toBe(1196.01);
  });
});

describe('criterion 4: quarter hedge delivery and margin', () => {
  it('hedge delivers COP 12,358,167 against COP 12,279,375 owed; margin COP 78,792', () => {
    const p = priceLock([COP_DUE, COP_DUE, COP_DUE], { spot: SPOT, fwdRates: [F1M, F2M, F3M], passThrough: 0.5 });
    expect(p.copTotal).toBe(12_279_375);
    expect(p.hedgeDeliversCop).toBe(12_358_167);
    expect(p.marginCop).toBe(78_792);
    expect(Math.round(p.legs.reduce((a, l) => a + l.marginCop, 0))).toBe(78_792);
  });
});

describe('criterion 5: pass-through extremes', () => {
  it('100% gives margin ≈ 0', () => {
    const p = priceLock([COP_DUE, COP_DUE, COP_DUE], { spot: SPOT, fwdRates: [F1M, F2M, F3M], passThrough: 1 });
    expect(Math.abs(p.marginCop)).toBeLessThanOrEqual(1);
    expect(p.lockedRate).toBeCloseTo(p.avgFwd, 9);
  });
  it('0% gives locked rate = spot', () => {
    const r = lockedRate({ spot: SPOT, fwdRates: [F1M, F2M, F3M], passThrough: 0 });
    expect(r).toBe(SPOT);
  });
  it('rejects pass-through outside 0..1', () => {
    expect(() => lockedRate({ spot: SPOT, fwdRates: [F1M], passThrough: 1.2 })).toThrow();
  });
});

interface LockMathVectors {
  rate_scale: number;
  usd_scale: number;
  inputs: { spot: string; fwd_1m: string; fwd_2m: string; fwd_3m: string; pass_through: string; cop_due: number };
  cases: {
    name: string;
    rate_decimal: string;
    locked_rate_fp: number;
    cop_due: number;
    usd_due_stroops: number;
    usd_due_display: string;
    cop_reconstructed: number;
  }[];
}

// Shared with contracts/payment_plan: the same file drives the Rust tests, so both sides must agree.
const VECTORS: LockMathVectors = JSON.parse(readFileSync(new URL('../../../contracts/test-vectors/lock_math.json', import.meta.url), 'utf8'));

/** The rate each vector case describes, computed by the engine from the vector inputs (never read from the file). */
function engineRateFor(name: string): number {
  const spot = Number(VECTORS.inputs.spot);
  const passThrough = Number(VECTORS.inputs.pass_through);
  const fwds = [VECTORS.inputs.fwd_1m, VECTORS.inputs.fwd_2m, VECTORS.inputs.fwd_3m].map(Number);
  switch (name) {
    case 'quarterly':
      return lockedRate({ spot, fwdRates: fwds, passThrough });
    case 'monthly':
      return lockedRate({ spot, fwdRates: [fwds[0]!], passThrough });
    case 'spot':
      return spot;
    default:
      throw new Error(`no engine rule for vector case ${name}`);
  }
}

describe('fixed point (contract rule, shared vectors)', () => {
  it('vector file matches the engine scales and the seed curve', () => {
    expect(BigInt(VECTORS.rate_scale)).toBe(10_000_000n);
    expect(BigInt(VECTORS.usd_scale)).toBe(10_000_000n);
    expect(Number(VECTORS.inputs.spot)).toBe(SPOT);
    expect([VECTORS.inputs.fwd_1m, VECTORS.inputs.fwd_2m, VECTORS.inputs.fwd_3m].map(Number)).toEqual([F1M, F2M, F3M]);
    expect(VECTORS.inputs.cop_due).toBe(COP_DUE);
    expect(VECTORS.cases.map((c) => c.name)).toEqual(['quarterly', 'monthly', 'spot']);
  });

  for (const c of VECTORS.cases) {
    it(`${c.name}: locked_rate_fp ${c.locked_rate_fp} → usd_due ${c.usd_due_stroops} stroops (USD ${c.usd_due_display})`, () => {
      const fp = BigInt(c.locked_rate_fp);
      const rate = engineRateFor(c.name);
      expect(rate).toBeCloseTo(Number(c.rate_decimal), 6);
      // half-up to 7 decimals, from the engine's float and from the decimal literal alike
      expect(fixedPointRate(rate)).toBe(fp);
      expect(decimalToFixed(c.rate_decimal, 7)).toBe(fp);
      const stroops = fixedPointUsdDue(c.cop_due, fp);
      expect(stroops).toBe(BigInt(c.usd_due_stroops));
      expect(roundUsd(stroopsToUsd(stroops))).toBe(Number(c.usd_due_display));
      expect(fixedPointCopFromUsd(stroops, fp)).toBe(BigInt(c.cop_reconstructed));
      // floor: one more stroop would overshoot cop_due
      expect(fixedPointCopFromUsd(stroops + 1n, fp)).toBeGreaterThanOrEqual(BigInt(c.cop_due));
      // the float engine agrees to within one stroop of rounding
      expect(Math.abs(Number(stroops) - Math.floor(usdDue(c.cop_due, rate) * 1e7))).toBeLessThanOrEqual(1);
    });
  }

  it('fixedPointRate rounds half-up on the 8th decimal and rejects non-positive rates', () => {
    expect(decimalToFixed('3444.42666665', 7)).toBe(34_444_266_667n);
    expect(decimalToFixed('3444.42666664', 7)).toBe(34_444_266_666n);
    expect(decimalToFixed('3444.426666', 7)).toBe(34_444_266_660n);
    expect(decimalToFixed('3422.325', 7)).toBe(34_223_250_000n);
    expect(decimalToFixed('1e-7', 7)).toBe(1n);
    expect(decimalToFixed('4e-8', 7)).toBe(0n);
    expect(decimalToFixed('5e-8', 7)).toBe(1n);
    expect(fixedPointRate(3422.325)).toBe(34_223_250_000n);
    expect(() => fixedPointRate(0)).toThrow();
    expect(() => fixedPointRate(Number.NaN)).toThrow();
    expect(() => decimalToFixed('abc', 7)).toThrow();
  });

  it('rejects negative amounts and non-positive rates', () => {
    expect(() => fixedPointUsdDue(-1, 1n)).toThrow();
    expect(() => fixedPointUsdDue(1, 0n)).toThrow();
  });
});

describe('spot payment sizing (exact COP)', () => {
  it('usdToCoverCop is the smallest whole-cent USD that converts to at least the COP due', () => {
    const usd = usdToCoverCop(COP_DUE, SPOT);
    expect(usd).toBe(1196.01);
    expect(usd * SPOT).toBeGreaterThanOrEqual(COP_DUE);
    expect((usd - 0.01) * SPOT).toBeLessThan(COP_DUE);
    // an exact multiple is not bumped to the next cent
    expect(usdToCoverCop(3500 * 12, 3500)).toBe(12);
    expect(usdToCoverCop(0, SPOT)).toBe(0);
  });
});

describe('hedge settlement and break cost', () => {
  it('ndf settlement is (fwd − fixing) × notional', () => {
    expect(ndfSettlement(3442.145, 3398.61, 1188.33)).toBe(Math.round(43.535 * 1188.33));
  });
  it('break cost is the negative MTM only; positive MTM is kept by treasury', () => {
    expect(breakCost(3478.9, 3464.645, 741.65)).toBe(Math.round(14.255 * 741.65));
    expect(breakCost(3400, 3464.645, 741.65)).toBe(0);
  });
});

describe('rules', () => {
  it('acceptance cutoff is 3 business days before the first installment', () => {
    // 2027-02-20 is a Saturday; 3 business days back = Wed 2027-02-17 (no festivo in between)
    expect(acceptanceCutoffDate('2027-02-20')).toBe('2027-02-17');
    expect(isBeforeCutoff('2026-10-20', '2027-02-20')).toBe(true);
    expect(isBeforeCutoff('2027-02-18', '2027-02-20')).toBe(false);
  });
  it('acceptance cutoff skips a festivo: due Wed 2026-11-18 → cutoff Thu 2026-11-12 (Mon 16 nov is a holiday)', () => {
    expect(acceptanceCutoffDate('2026-11-18')).toBe('2026-11-12');
    expect(isBeforeCutoff('2026-11-12', '2026-11-18')).toBe(true);
    expect(isBeforeCutoff('2026-11-13', '2026-11-18')).toBe(false);
  });
  it('grace is 5 business days after the due date', () => {
    // 2026-10-15 Thursday → 5 business days → Thursday 2026-10-22 (no festivo in between)
    expect(graceEndDate('2026-10-15')).toBe('2026-10-22');
    expect(isBeyondGrace('2026-10-20', '2026-10-15')).toBe(false);
    expect(isBeyondGrace('2026-10-23', '2026-10-15')).toBe(true);
  });
  it('grace skips a festivo: due Fri 2026-10-09 → ends Mon 2026-10-19 (Mon 12 oct is a holiday)', () => {
    // business days after 9 oct: 13, 14, 15, 16, 19
    expect(graceEndDate('2026-10-09')).toBe('2026-10-19');
    expect(businessDaysLate('2026-10-13', '2026-10-09')).toBe(1);
    expect(businessDaysLate('2026-10-19', '2026-10-09')).toBe(5);
    expect(isBeyondGrace('2026-10-19', '2026-10-09')).toBe(false);
    expect(isBeyondGrace('2026-10-20', '2026-10-09')).toBe(true);
  });
  it('renewal is offered 10 days before the last installment of the lock, never after it', () => {
    expect(shouldOfferRenewal('2027-01-09', '2027-01-20')).toBe(false);
    expect(shouldOfferRenewal('2027-01-10', '2027-01-20')).toBe(true);
    expect(shouldOfferRenewal('2027-01-21', '2027-01-20')).toBe(false);
  });
  it('a quarterly lock needs three consecutive open installments', () => {
    const inst = [
      { idx: 0, status: 'released' },
      { idx: 1, status: 'locked' },
      { idx: 2, status: 'open' },
      { idx: 3, status: 'open' },
      { idx: 4, status: 'broken' },
      { idx: 5, status: 'open' },
    ];
    expect(nextLockableIdxs(inst, 'mensual')).toEqual([2]);
    expect(nextLockableIdxs(inst, 'trimestral')).toBeNull();
    expect(nextLockableIdxs([...inst.slice(0, 4), { idx: 4, status: 'open' }], 'trimestral')).toEqual([2, 3, 4]);
    expect(nextLockableIdxs([{ idx: 0, status: 'released' }], 'mensual')).toBeNull();
  });
});
