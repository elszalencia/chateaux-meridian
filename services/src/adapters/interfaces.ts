// Provider interfaces. Names are fixed by the scope: LockProvider, HedgeProvider, OnRampProvider,
// OffRampProvider. Stage 1 ships mocks; Stage 2 and 3 plug in the contract, the SDF test anchor and
// a local Anchor Platform behind the same signatures, so UI code never changes.

import type { ISODate, ISODateTime, Tenor } from '../domain/types';

export interface CurveQuote {
  tenor: string;
  date: ISODate;
  rate: number;
}

export interface StripLegRequest {
  dueDate: ISODate;
  usdNotional: number;
}

export interface BookedTrade {
  tradeId: string;
  dueDate: ISODate;
  rate: number;
  banrepRef?: string;
}

export interface Settlement {
  tradeId: string;
  date: ISODate;
  copAmount: number;
  fixing: number;
}

export interface HedgeProvider {
  readonly name: string;
  getCurve(tenors: string[]): Promise<CurveQuote[]>;
  bookStrip(legs: StripLegRequest[]): Promise<BookedTrade[]>;
  getSettlements(from: ISODate, to: ISODate): Promise<Settlement[]>;
}

export type OnRampStatus = 'pending' | 'completed' | 'error';

export interface OnRampProvider {
  readonly name: string;
  /** Starts a USD deposit from the buyer's US bank account (SEP-24 interactive in Stage 3). */
  initiateDeposit(args: { buyerId: string; usdAmount: number; memo: string }): Promise<{ depositId: string; status: OnRampStatus }>;
  status(depositId: string): Promise<OnRampStatus>;
}

export type OffRampStatus = 'pending' | 'completed' | 'refunded' | 'error';

/**
 * A quote is requested either by the USDC to sell (locked installments: the USD amount is fixed by
 * the lock) or by the COP the beneficiary must receive (unlocked payments: the trust gets exactly
 * cop_due and the USD leg is sized to cover it). SEP-38 supports both (`sell_amount` / `buy_amount`).
 */
export type OffRampQuoteRequest = { usdc: string; copTarget?: undefined } | { copTarget: number; usdc?: undefined };

export interface OffRampQuote {
  quoteId: string;
  rate: number; // COP per USDC
  expiresAt: ISODateTime;
  usdc: string; // USDC to deliver, 7 decimals; for a COP target, the smallest whole-cent amount that covers it
  copDelivered: number; // whole pesos the beneficiary receives; equals copTarget when one was given
}

export interface OffRampProvider {
  readonly name: string;
  quote(req: OffRampQuoteRequest): Promise<OffRampQuote>;
  pay(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string }): Promise<{ txId: string }>;
  status(txId: string): Promise<OffRampStatus>;
}

export interface LockQuoteRequest {
  planId: string;
  tenor: Tenor;
  idxs: number[];
  copDues: number[];
  dueDates: ISODate[];
  passThrough: number;
}

export interface LockQuoteResult {
  spot: number;
  fwdRates: number[];
  avgFwd: number;
  points: number;
  lockedRate: number;
  usdPerInstallment: number[];
  curveAsOf: ISODate;
  quoteExpiresAt: ISODateTime;
}

export interface LockProvider {
  readonly name: string;
  /** Prices a lock. The internal provider uses the engine; an external one returns its own rate. */
  quote(req: LockQuoteRequest): Promise<LockQuoteResult>;
  /** Commits the lock (Stage 2: `apply_lock` on-chain). Returns an opaque reference. */
  apply(args: { lockId: string; planId: string; idxs: number[]; lockedRate: number; expiryTs: ISODate }): Promise<{ lockRef: string }>;
  /** Breaks a lock leg (Stage 2: `break_lock`). */
  break(args: { lockId: string; planId: string; idx: number }): Promise<{ ref: string }>;
}

export interface Providers {
  lock: LockProvider;
  hedge: HedgeProvider;
  onRamp: OnRampProvider;
  offRamp: OffRampProvider;
}
