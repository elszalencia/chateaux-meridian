// Seller lifecycle as pure functions over the stored rows: verification transitions (rejected is
// final), the 72-hour payout-account cooling-off, and the view models the desk, the buyer and the
// counter read. No payout address exists before verification: an account given to a pending seller
// waits in `pendingPayoutAccount` and becomes active at verification, without a cooling-off (there
// was no previous account to protect).

import type { ISODateTime, PayoutAccount, Plan, Seller, SellerSummary, SellerUnit, SellerVerificationStatus, SellerView, Unit } from '../domain/types';
import { sellerGate } from './gate';

export const PAYOUT_CHANGE_COOLING_OFF_HOURS = 72;

export class SellerTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SellerTransitionError';
  }
}

export function sellerSummary(seller: Seller, units: SellerUnit[], unitId: string, nowIso: ISODateTime): SellerSummary {
  const unit = units.find((u) => u.sellerId === seller.id && u.unitId === unitId) ?? null;
  return {
    id: seller.id,
    tradeName: seller.tradeName,
    tier: seller.tier,
    verificationStatus: seller.verificationStatus,
    payoutOption: seller.payoutOption,
    cnr: unit ? { registryNo: unit.cnrRegistryNo, certDate: unit.cnrCertDate, alertStatus: unit.alertStatus } : null,
    gate: sellerGate(seller, units, nowIso),
  };
}

export function sellerView(seller: Seller, sellerUnits: SellerUnit[], units: Unit[], plans: Plan[], nowIso: ISODateTime): SellerView {
  const own = sellerUnits.filter((u) => u.sellerId === seller.id);
  return {
    ...seller,
    units: own.map((su) => {
      const unit = units.find((u) => u.id === su.unitId);
      return { ...su, unitLabel: unit ? `${unit.unitName} ${unit.unitCode}` : su.unitId, project: unit?.project ?? '' };
    }),
    planCount: plans.filter((p) => p.sellerId === seller.id).length,
    gate: sellerGate(seller, own, nowIso),
  };
}

/**
 * Requests a payout-account change. A verified seller enters the 72 h cooling-off: the current
 * account stays in place, the new one waits, and `sellerGate` reports `seller_cooling_off` until
 * `settlePayoutAccountChange` promotes it. An unverified seller just records the account to use
 * once verified.
 */
export function changePayoutAccount(seller: Seller, account: PayoutAccount, nowIso: ISODateTime): Seller {
  if (seller.verificationStatus === 'rejected') throw new SellerTransitionError('a rejected seller cannot change its payout account');
  if (seller.verificationStatus !== 'verified') return { ...seller, pendingPayoutAccount: account, payoutChangePendingUntil: null };
  // A verified seller's first account has nothing to protect: it is active at once.
  if (!seller.payoutAccount) return { ...seller, payoutAccount: account, pendingPayoutAccount: null, payoutChangePendingUntil: null };
  const until = new Date(Date.parse(nowIso) + PAYOUT_CHANGE_COOLING_OFF_HOURS * 3_600_000).toISOString();
  return { ...seller, pendingPayoutAccount: account, payoutChangePendingUntil: until };
}

/** After the cooling-off window the pending account becomes the payout account. No-op before it. */
export function settlePayoutAccountChange(seller: Seller, nowIso: ISODateTime): Seller {
  if (!seller.pendingPayoutAccount || !seller.payoutChangePendingUntil) return seller;
  if (Date.parse(seller.payoutChangePendingUntil) > Date.parse(nowIso)) return seller;
  return { ...seller, payoutAccount: seller.pendingPayoutAccount, pendingPayoutAccount: null, payoutChangePendingUntil: null };
}

/**
 * Verification transitions. `rejected` is final. Verifying a seller activates the account it has
 * waiting (or the one given here); without any account the seller stays verified but gated.
 */
export function setVerification(
  seller: Seller,
  status: Exclude<SellerVerificationStatus, 'pending'>,
  nowIso: ISODateTime,
  opts: { payoutAccount?: PayoutAccount; note?: string } = {},
): Seller {
  if (seller.verificationStatus === 'rejected') throw new SellerTransitionError(`seller ${seller.id} is rejected; no transition out of rejected`);
  const notes = opts.note ? (seller.notes ? `${seller.notes}\n${opts.note}` : opts.note) : seller.notes;
  if (status === 'verified') {
    // A seller with an account keeps it (a new one goes through `changePayoutAccount`); a seller
    // without one gets the account given here or the one waiting since onboarding.
    if (seller.payoutAccount) return { ...seller, verificationStatus: 'verified', verifiedAt: seller.verifiedAt ?? nowIso, notes };
    const account = opts.payoutAccount ?? seller.pendingPayoutAccount ?? null;
    return {
      ...seller,
      verificationStatus: 'verified',
      verifiedAt: seller.verifiedAt ?? nowIso,
      payoutAccount: account,
      pendingPayoutAccount: null,
      payoutChangePendingUntil: null,
      notes,
    };
  }
  return { ...seller, verificationStatus: status, notes };
}
