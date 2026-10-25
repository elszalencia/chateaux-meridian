// Reason codes for adverse events. The contract stores and emits a bare `u32 reason`; this table is
// the single catalogue that gives each code a meaning. The web app turns `key` into plain language
// (`reasons.<key>` in web/src/i18n). Codes are grouped by hundreds: 1xx installment and default,
// 2xx cancellation, 3xx holds, 4xx refunds, 5xx closing. `REASON_FUNDS_FROZEN` (304) is also a
// constant in the contract, which writes it itself from `hold_frozen`.

export interface ReasonInfo {
  code: number;
  key: string;
}

export const REASONS = {
  GRACE_EXPIRED: { code: 100, key: 'graceExpired' },
  PAID_LATE: { code: 101, key: 'paidLate' },
  WAIVED_BY_BUILDER: { code: 102, key: 'waivedByBuilder' },
  REPEATED_MISSES: { code: 110, key: 'repeatedMisses' },
  BUYER_WITHDRAWAL: { code: 200, key: 'buyerWithdrawal' },
  PROJECT_CANCELLED: { code: 201, key: 'projectCancelled' },
  KYC_REVIEW: { code: 300, key: 'kycReview' },
  SANCTIONS_REVIEW: { code: 301, key: 'sanctionsReview' },
  DISPUTED_PAYMENT: { code: 302, key: 'disputedPayment' },
  ACH_RETURN: { code: 303, key: 'achReturn' },
  FUNDS_FROZEN: { code: 304, key: 'fundsFrozen' },
  PAYOUT_RETURNED: { code: 305, key: 'payoutReturned' },
  CNR_LIEN: { code: 306, key: 'cnrLien' },
  HOLD_CLEARED: { code: 310, key: 'holdCleared' },
  REFUND: { code: 400, key: 'refund' },
  PLAN_COMPLETED: { code: 500, key: 'planCompleted' },
} as const satisfies Record<string, ReasonInfo>;

export type ReasonName = keyof typeof REASONS;

const BY_CODE = new Map<number, ReasonInfo>(Object.values(REASONS).map((r) => [r.code, r]));

/** The catalogue entry for a code; unknown codes map to `unknown` so the UI still renders. */
export function reasonInfo(code: number | null | undefined): ReasonInfo {
  if (code == null) return { code: 0, key: 'none' };
  return BY_CODE.get(code) ?? { code, key: 'unknown' };
}
