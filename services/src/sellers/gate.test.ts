// Seller gate and lifecycle: every gate reason, the cooling-off boundary, no payout address before
// verification, and rejected as a final state.
import { describe, expect, it } from 'vitest';
import type { Seller, SellerUnit } from '../domain/types';
import { SellerGateError, assertSellerReleasable, sellerGate } from './gate';
import { PAYOUT_CHANGE_COOLING_OFF_HOURS, SellerTransitionError, changePayoutAccount, sellerSummary, setVerification, settlePayoutAccountChange } from './sellers';

const NOW = '2026-10-20T14:00:00.000Z';
const HOURS = 3_600_000;
const at = (h: number) => new Date(Date.parse(NOW) + h * HOURS).toISOString();

const account = { kind: 'bank' as const, institution: 'Banco (simulado)', holder: 'VENDEDOR SA', ref: 'USD ••• 1111' };
const other = { ...account, ref: 'USD ••• 2222' };

function seller(over: Partial<Seller> = {}): Seller {
  return {
    id: 'seller-x',
    corridor: 'sv',
    tier: 2,
    legalName: 'Vendedor, S.A. de C.V. (ficticio)',
    tradeName: 'Vendedor (ficticio)',
    taxId: '0000-000000-000-0',
    legalRepresentative: 'R. L.',
    bank: 'Banco (simulado)',
    verificationStatus: 'verified',
    verifiedAt: '2026-09-01T00:00:00.000Z',
    payoutOption: 'B',
    payoutAccount: account,
    pendingPayoutAccount: null,
    payoutChangePendingUntil: null,
    kybRef: null,
    releasesCount: 0,
    notes: null,
    simulated: true,
    ...over,
  };
}

function unit(alertStatus: SellerUnit['alertStatus'] = 'none'): SellerUnit {
  return { id: 'su-1', sellerId: 'seller-x', unitId: 'unit-1', cnrRegistryNo: 'CNR-1', cnrCertDate: '2026-08-01', cnrCertHash: 'ab'.repeat(32), alertStatus, alertAt: null, alertDetail: null };
}

describe('sellerGate', () => {
  it('reports every reason, in priority order, and null for a clean verified seller', () => {
    expect(sellerGate(seller(), [unit()], NOW)).toBeNull();
    expect(sellerGate(seller({ verificationStatus: 'pending' }), [], NOW)).toBe('seller_unverified');
    expect(sellerGate(seller({ verificationStatus: 'paused' }), [], NOW)).toBe('seller_paused');
    expect(sellerGate(seller({ verificationStatus: 'rejected' }), [], NOW)).toBe('seller_rejected');
    expect(sellerGate(seller({ payoutChangePendingUntil: at(1) }), [], NOW)).toBe('seller_cooling_off');
    expect(sellerGate(seller(), [unit('lien_registered')], NOW)).toBe('cnr_alert');
    expect(sellerGate(seller(), [unit('cleared')], NOW)).toBeNull();
    expect(sellerGate(seller({ payoutAccount: null }), [], NOW)).toBe('seller_unverified');
    // a unit of another seller never gates this one
    expect(sellerGate(seller(), [{ ...unit('lien_registered'), sellerId: 'seller-y' }], NOW)).toBeNull();
  });

  it('cooling-off ends exactly at payoutChangePendingUntil', () => {
    const s = seller({ payoutChangePendingUntil: at(72) });
    expect(sellerGate(s, [], at(71.99))).toBe('seller_cooling_off');
    expect(sellerGate(s, [], at(72))).toBeNull();
  });

  it('assertSellerReleasable throws a typed error with the reason', () => {
    expect(() => assertSellerReleasable(seller({ verificationStatus: 'paused' }), [], NOW)).toThrow(SellerGateError);
    try {
      assertSellerReleasable(seller(), [unit('lien_registered')], NOW);
    } catch (e) {
      expect((e as SellerGateError).reason).toBe('cnr_alert');
      expect((e as SellerGateError).sellerId).toBe('seller-x');
    }
    expect(() => assertSellerReleasable(seller(), [], NOW)).not.toThrow();
  });
});

describe('payout-account change (72 h cooling-off)', () => {
  it('a verified seller keeps the current account while the new one waits; the gate reports cooling-off until the window ends', () => {
    const s = changePayoutAccount(seller(), other, NOW);
    expect(s.payoutAccount).toEqual(account);
    expect(s.pendingPayoutAccount).toEqual(other);
    expect(s.payoutChangePendingUntil).toBe(at(PAYOUT_CHANGE_COOLING_OFF_HOURS));
    expect(s.verificationStatus).toBe('verified');
    expect(sellerGate(s, [], at(71))).toBe('seller_cooling_off');
    expect(settlePayoutAccountChange(s, at(71))).toBe(s); // untouched before the window ends
    const settled = settlePayoutAccountChange(s, at(72));
    expect(settled.payoutAccount).toEqual(other);
    expect(settled.pendingPayoutAccount).toBeNull();
    expect(settled.payoutChangePendingUntil).toBeNull();
    expect(sellerGate(settled, [], at(72))).toBeNull();
  });

  it('no payout address exists before verification: the account waits and becomes active at verification', () => {
    const pending = changePayoutAccount(seller({ verificationStatus: 'pending', verifiedAt: null, payoutAccount: null }), account, NOW);
    expect(pending.payoutAccount).toBeNull();
    expect(pending.pendingPayoutAccount).toEqual(account);
    expect(pending.payoutChangePendingUntil).toBeNull();
    expect(sellerGate(pending, [], NOW)).toBe('seller_unverified');
    const verified = setVerification(pending, 'verified', NOW);
    expect(verified.payoutAccount).toEqual(account);
    expect(verified.pendingPayoutAccount).toBeNull();
    expect(verified.verifiedAt).toBe(NOW);
    expect(sellerGate(verified, [], NOW)).toBeNull();
    // a verified seller with no account yet: the first account is active at once
    const first = changePayoutAccount(seller({ payoutAccount: null }), account, NOW);
    expect(first.payoutAccount).toEqual(account);
    expect(first.payoutChangePendingUntil).toBeNull();
  });

  it('verification transitions: pause and resume keep the account; rejected is final', () => {
    const paused = setVerification(seller(), 'paused', NOW, { note: 'revisión' });
    expect(paused.verificationStatus).toBe('paused');
    expect(paused.payoutAccount).toEqual(account);
    expect(paused.notes).toBe('revisión');
    const back = setVerification(paused, 'verified', at(1));
    expect(back.verificationStatus).toBe('verified');
    expect(back.verifiedAt).toBe(seller().verifiedAt);
    const rejected = setVerification(seller(), 'rejected', NOW);
    expect(() => setVerification(rejected, 'verified', at(1))).toThrow(SellerTransitionError);
    expect(() => setVerification(rejected, 'paused', at(1))).toThrow(/rejected/);
    expect(() => changePayoutAccount(rejected, other, NOW)).toThrow(SellerTransitionError);
  });

  it('sellerSummary never carries the payout account and reports the unit title check and the gate', () => {
    const s = sellerSummary(seller({ payoutChangePendingUntil: at(5) }), [unit('lien_registered')], 'unit-1', NOW);
    expect(s).toEqual({
      id: 'seller-x',
      tradeName: 'Vendedor (ficticio)',
      tier: 2,
      verificationStatus: 'verified',
      payoutOption: 'B',
      cnr: { registryNo: 'CNR-1', certDate: '2026-08-01', alertStatus: 'lien_registered' },
      gate: 'seller_cooling_off',
    });
    expect('payoutAccount' in s).toBe(false);
    expect(sellerSummary(seller(), [], 'unit-9', NOW).cnr).toBeNull();
  });
});
