// Seller gate: the one rule set that decides whether a release may reach a seller. It runs at the
// service layer before every payout (and again when a held payout is retried), so no release
// reaches a seller who is unverified, paused, rejected, inside a payout-account cooling-off, or has
// a lien alert on one of its units. The reason is typed so the UI can explain it.

import type { ISODateTime, Seller, SellerGateReason, SellerUnit } from '../domain/types';

export class SellerGateError extends Error {
  constructor(public readonly reason: SellerGateReason, public readonly sellerId: string) {
    super(`release to seller ${sellerId} blocked: ${reason}`);
    this.name = 'SellerGateError';
  }
}

/** Why releases to this seller are blocked right now, or null when they flow. */
export function sellerGate(seller: Seller, units: SellerUnit[], nowIso: ISODateTime): SellerGateReason | null {
  if (seller.verificationStatus === 'rejected') return 'seller_rejected';
  if (seller.verificationStatus === 'paused') return 'seller_paused';
  if (seller.verificationStatus === 'pending') return 'seller_unverified';
  if (seller.payoutChangePendingUntil && Date.parse(seller.payoutChangePendingUntil) > Date.parse(nowIso)) return 'seller_cooling_off';
  if (units.some((u) => u.sellerId === seller.id && u.alertStatus === 'lien_registered')) return 'cnr_alert';
  if (!seller.payoutAccount) return 'seller_unverified';
  return null;
}

export function assertSellerReleasable(seller: Seller, units: SellerUnit[], nowIso: ISODateTime): void {
  const reason = sellerGate(seller, units, nowIso);
  if (reason) throw new SellerGateError(reason, seller.id);
}
