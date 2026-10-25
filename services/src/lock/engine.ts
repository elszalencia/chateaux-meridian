// Lock engine: pure pricing and rule functions, no I/O.
// Design decisions:
// - Float math mirrors the scope formulas exactly (avg_fwd, points, locked_rate, usd_due) and keeps
//   full precision until display; the published figures (3,444.427 / USD 1,188.33 / COP 12,358,167)
//   come out of the unrounded locked rate, so nothing is rounded mid-way.
// - The same quantities are also computed in fixed point (`fixedPoint*`), the way the Soroban
//   contract does: the locked rate rounded half-up to 7 decimals (× 1e7), USDC in stroops (1e7),
//   floor division. Both sides are checked against contracts/test-vectors/lock_math.json.
// - Each leg of a lock maps to curve tenor k (1M, 2M, 3M) in order, not to an interpolated forward at
//   the exact due date. That is how the demo numbers were defined; a pilot swaps the mapping.
// - Business-day rules (cutoff, grace) skip weekends and Colombian festivos (domain/holidays.ts).
// - Unlocked (spot) payments target an exact COP amount: the USD leg is the smallest whole-cent
//   amount that converts to at least that COP (`usdToCoverCop`), so the trust receives cop_due.

import type { ISODate, Tenor } from '../domain/types';
import { addBusinessDays, addDays, businessDaysBetween, compareISO } from '../domain/dates';

export const RATE_SCALE = 10_000_000n; // COP per USD × 1e7, as stored on-chain
export const STROOP = 10_000_000n; // USDC has 7 decimals
export const QUOTE_TTL_MS = 10 * 60 * 1000;
export const GRACE_BUSINESS_DAYS = 5;
export const RENEWAL_DAYS_AHEAD = 10;
export const CUTOFF_BUSINESS_DAYS = 3;
export const TENOR_LEGS: Record<Tenor, number> = { mensual: 1, trimestral: 3 };
export const DEFAULT_PASS_THROUGH = 0.5;

export interface PricingInput {
  spot: number;
  fwdRates: number[]; // one per installment in the lock, in due-date order
  passThrough: number; // 0..1
  bankSpread?: number; // demo: 0
}

export interface PricedLeg {
  copDue: number;
  fwdRate: number;
  usdDue: number; // full precision
  usdDueRounded: number; // 2 decimals, what the buyer is shown and pays
  marginCop: number; // (fwd − locked) × usd
}

export interface LockPricing {
  avgFwd: number;
  points: number;
  lockedRate: number;
  legs: PricedLeg[];
  usdPerInstallment: number; // 2 decimals; identical for equal copDue
  usdTotal: number;
  copTotal: number;
  hedgeDeliversCop: number; // Σ usd × fwd (rounded to whole pesos)
  marginCop: number; // hedgeDeliversCop − copTotal (whole pesos)
}

export function mean(xs: number[]): number {
  if (xs.length === 0) throw new Error('mean of empty list');
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** locked_rate = spot + pass_through × (avg_fwd − spot) − bank_spread */
export function lockedRate({ spot, fwdRates, passThrough, bankSpread = 0 }: PricingInput): number {
  assertPassThrough(passThrough);
  const avgFwd = mean(fwdRates);
  const points = avgFwd - spot;
  return spot + passThrough * points - bankSpread;
}

export function usdDue(copDue: number, rate: number): number {
  if (rate <= 0) throw new Error('rate must be positive');
  return copDue / rate;
}

export function roundUsd(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function roundCop(x: number): number {
  return Math.round(x);
}

export function assertPassThrough(p: number): void {
  if (!(p >= 0 && p <= 1)) throw new Error(`pass-through out of range: ${p}`);
}

/** Prices one lock: 1 or 3 legs. `copDues[i]` pairs with `fwdRates[i]`. */
export function priceLock(copDues: number[], input: PricingInput): LockPricing {
  if (copDues.length !== input.fwdRates.length) throw new Error('copDues and fwdRates must align');
  if (copDues.length !== 1 && copDues.length !== 3) throw new Error('a lock has 1 or 3 legs');
  const avgFwd = mean(input.fwdRates);
  const points = avgFwd - input.spot;
  const rate = lockedRate(input);
  const legs: PricedLeg[] = copDues.map((copDue, i) => {
    const fwd = input.fwdRates[i]!;
    const usd = usdDue(copDue, rate);
    return { copDue, fwdRate: fwd, usdDue: usd, usdDueRounded: roundUsd(usd), marginCop: usd * (fwd - rate) };
  });
  const copTotal = copDues.reduce((a, b) => a + b, 0);
  const hedgeDelivers = legs.reduce((a, l) => a + l.usdDue * l.fwdRate, 0);
  return {
    avgFwd,
    points,
    lockedRate: rate,
    legs,
    usdPerInstallment: legs[0]!.usdDueRounded,
    usdTotal: roundUsd(legs.reduce((a, l) => a + l.usdDueRounded, 0)),
    copTotal,
    hedgeDeliversCop: roundCop(hedgeDelivers),
    marginCop: roundCop(hedgeDelivers - copTotal),
  };
}

/** Break cost = negative mark-to-market of the hedge leg; positive MTM is kept by treasury. */
export function breakCost(spotNow: number, fwdRate: number, usdNotional: number): number {
  return roundCop(Math.max(0, (spotNow - fwdRate) * usdNotional));
}

/** NDF cash settlement (USD sold forward): (fwd − fixing) × notional, in COP. */
export function ndfSettlement(fwdRate: number, fixing: number, usdNotional: number): number {
  return roundCop((fwdRate - fixing) * usdNotional);
}

// ---------- Fixed point (what the Soroban contract computes) ----------

export const RATE_DECIMALS = 7;

/**
 * COP per USD scaled by 1e7, rounded half-up to 7 decimals: the `locked_rate` stored on-chain.
 * Works on the rate's shortest decimal representation with integer arithmetic, so the cut is made
 * on the decimal digits the engine prints (3444.4266666666665 → 34444266667) and never on a float
 * product, where `rate * 1e7` could land a hair below a half and round the wrong way.
 */
export function fixedPointRate(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`rate must be positive: ${rate}`);
  return decimalToFixed(String(rate), RATE_DECIMALS);
}

/**
 * Parses a decimal literal (`1234.5678`, `1e-7`, `-0.5`) into an integer scaled by 10^decimals,
 * rounding half-up (away from zero on an exact half) on the dropped digits.
 */
export function decimalToFixed(text: string, decimals: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text.trim());
  if (!m) throw new Error(`not a decimal literal: ${text}`);
  const negative = m[1] === '-';
  const fraction = m[3] ?? '';
  const digits = `${m[2]}${fraction}`;
  // value × 10^decimals = digits × 10^shift
  const shift = Number(m[4] ?? '0') - fraction.length + decimals;
  let n: bigint;
  if (shift >= 0) {
    n = BigInt(digits) * 10n ** BigInt(shift);
  } else {
    const keep = digits.length + shift;
    const kept = keep > 0 ? digits.slice(0, keep) : '0';
    const dropped = keep > 0 ? digits.slice(keep) : `${'0'.repeat(-keep)}${digits}`;
    n = BigInt(kept) + (dropped.charCodeAt(0) >= 53 /* '5' */ ? 1n : 0n);
  }
  return negative ? -n : n;
}

/**
 * usd_due = cop_due × 10^7 × 10^7 / locked_rate_fp, integer division (floor).
 * Result is in stroops (USDC 7 decimals). Rounding: floor, so the buyer never pays more than
 * cop_due / locked_rate; the residual is below one stroop (1e-7 USD).
 */
export function fixedPointUsdDue(copDue: number | bigint, lockedRateFp: bigint): bigint {
  const cop = typeof copDue === 'bigint' ? copDue : BigInt(copDue);
  if (cop < 0n) throw new Error('negative cop_due');
  if (lockedRateFp <= 0n) throw new Error('locked_rate must be positive');
  return (cop * STROOP * RATE_SCALE) / lockedRateFp;
}

export function stroopsToUsd(stroops: bigint): number {
  return Number(stroops) / 1e7;
}

/** Reconstructs cop_due from stroops and the fixed-point rate (floor); differs from cop_due by at most the rounding residual. */
export function fixedPointCopFromUsd(usdStroops: bigint, lockedRateFp: bigint): bigint {
  return (usdStroops * lockedRateFp) / (STROOP * RATE_SCALE);
}

/**
 * Smallest USD amount in whole cents that converts to at least `cop` at `rate` (ceil to the cent).
 * Used for unlocked payments so the trust receives exactly the pesos due; the buyer overpays by
 * less than one cent, which the anchor keeps. Fixed-point division so a float residue never
 * decides the last cent.
 */
export function usdToCoverCop(cop: number, rate: number): number {
  const pesos = BigInt(roundCop(cop));
  if (pesos < 0n) throw new Error('negative cop');
  const fp = fixedPointRate(rate);
  const cents = (pesos * RATE_SCALE * 100n + fp - 1n) / fp;
  return Number(cents) / 100;
}

// ---------- Rules ----------

export function acceptanceCutoffDate(firstDueDate: ISODate): ISODate {
  return addBusinessDays(firstDueDate, -CUTOFF_BUSINESS_DAYS);
}

export function isBeforeCutoff(today: ISODate, firstDueDate: ISODate): boolean {
  return compareISO(today, acceptanceCutoffDate(firstDueDate)) <= 0;
}

export function graceEndDate(dueDate: ISODate): ISODate {
  return addBusinessDays(dueDate, GRACE_BUSINESS_DAYS);
}

export function businessDaysLate(today: ISODate, dueDate: ISODate): number {
  return businessDaysBetween(dueDate, today);
}

export function isBeyondGrace(today: ISODate, dueDate: ISODate): boolean {
  return businessDaysLate(today, dueDate) > GRACE_BUSINESS_DAYS;
}

export function renewalOfferDate(lastDueDate: ISODate): ISODate {
  return addDays(lastDueDate, -RENEWAL_DAYS_AHEAD);
}

export function shouldOfferRenewal(today: ISODate, lastDueDate: ISODate): boolean {
  return compareISO(today, renewalOfferDate(lastDueDate)) >= 0 && compareISO(today, lastDueDate) <= 0;
}

export function quoteExpiresAt(nowMs: number): string {
  return new Date(nowMs + QUOTE_TTL_MS).toISOString();
}

export function isQuoteExpired(quoteExpiresAt: string | null, nowMs: number): boolean {
  if (!quoteExpiresAt) return true;
  return Date.parse(quoteExpiresAt) <= nowMs;
}

/**
 * The installments a new lock would cover: the first unpaid open installment and, for a quarterly
 * lock, the two that follow, all of which must be `open` and consecutive. Returns null when no such
 * run exists (for example when only two open installments remain).
 */
export function nextLockableIdxs(
  installments: { idx: number; status: string }[],
  tenor: Tenor,
): number[] | null {
  const sorted = [...installments].sort((a, b) => a.idx - b.idx);
  const first = sorted.find((i) => i.status === 'open');
  if (!first) return null;
  const n = TENOR_LEGS[tenor];
  const run: number[] = [];
  for (let k = 0; k < n; k += 1) {
    const inst = sorted.find((i) => i.idx === first.idx + k);
    if (!inst || inst.status !== 'open') return null;
    run.push(inst.idx);
  }
  return run;
}
