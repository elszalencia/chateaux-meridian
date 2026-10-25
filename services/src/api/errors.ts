// ApiError: the one typed error the web app knows how to show (`errors.<code lower-cased>` in the
// dictionaries). It lives apart from DemoApi so the corridor modules (svApi) can throw it without
// importing the façade; DemoApi re-exports it, so `import { ApiError } from './DemoApi'` still works.

export type ApiErrorCode =
  | 'NOT_FOUND'
  | 'NO_LOCKABLE'
  | 'CUTOFF'
  | 'NOT_QUOTED'
  | 'QUOTE_EXPIRED'
  | 'ALREADY_PAID'
  | 'NOTHING_TO_BOOK'
  | 'NOTHING_TO_PAY_AHEAD'
  | 'PLAN_BLOCKED'
  | 'INSTALLMENT_MISSED'
  | 'PROVIDER'
  // El Salvador corridor
  | 'LOCKS_DISABLED' // quoteLock/acceptLock on a corridor with locks_enabled = false
  | 'METHOD_NOT_OFFERED' // pay method not in the corridor's list or hidden for this buyer
  | 'ABOVE_LIMIT' // MoneyGram cash-in above the network cap
  | 'BELOW_LIMIT'
  | 'STATE_EXCLUDED' // MoneyGram not offered in the buyer's state
  | 'REFERENCE_EXPIRED' // MoneyGram reference past its expiry
  | 'REFERENCE_NOT_COMPLETED' // the network has not reported the cash-in yet
  | 'NOT_DUE_YET' // outside the pay window
  | 'INSUFFICIENT_CASH' // counter: amount received below the amount due
  | 'SELLER_UNVERIFIED'
  | 'SELLER_PAUSED'
  | 'SELLER_REJECTED'
  | 'SELLER_COOLING_OFF'
  | 'CNR_ALERT'
  | 'INVALID_TRANSITION' // adverse action refused by the contract rules
  | 'NOT_IMPLEMENTED';

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message?: string, public readonly cause?: unknown) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}
