// SEP-31 receive side. A transaction is created from an unexpired quote and two ACCEPTED customers,
// then advanced by the watcher: a USDC payment with the right text memo moves it to pending_stellar,
// a short pause stands in for the ACH payout (pending_receiver), and it completes with a fake ACH
// reference; one that is never paid expires after 15 minutes. The transitions are pure functions of
// a record, a payment and a clock, so the whole machine runs in a unit test without Horizon.

import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError, ok, type Res } from './http.ts';
import type { Auth } from './sep10.ts';
import { customerStatus, CUSTOMER_TYPES } from './sep12.ts';
import { COP_ASSET, usdcAsset } from './sep38.ts';
import type { Sep31Transaction, Stores } from './store.ts';

export const PENDING_STELLAR_MS = 2_000;
export const PENDING_RECEIVER_MS = 3_000;
export const SENDER_TIMEOUT_MS = 15 * 60 * 1000;
export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 100_000;
const AMOUNT_TOLERANCE = 1e-7;

export function sep31Info(): Record<string, unknown> {
  return {
    receive: {
      USDC: {
        enabled: true,
        quotes_supported: true,
        quotes_required: true,
        fee_fixed: 0,
        fee_percent: 0,
        min_amount: MIN_AMOUNT,
        max_amount: MAX_AMOUNT,
        funding_methods: ['ACH'],
        sep12: {
          sender: { types: { 'sep31-sender': { description: CUSTOMER_TYPES['sep31-sender'] } } },
          receiver: { types: { 'sep31-receiver': { description: CUSTOMER_TYPES['sep31-receiver'] } } },
        },
      },
    },
  };
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : null);

export interface CreateContext {
  stores: Stores;
  auth: Auth;
  body: Record<string, unknown>;
  receiverAccount: string;
  usdcIssuer: string;
  nowMs?: number;
}

export function createTransaction({ stores, auth, body, receiverAccount, usdcIssuer, nowMs = Date.now() }: CreateContext): Res {
  const amount = text(body.amount);
  const quoteId = text(body.quote_id);
  const senderId = text(body.sender_id);
  const receiverId = text(body.receiver_id);
  const missing = Object.entries({ amount, asset_code: text(body.asset_code), quote_id: quoteId, sender_id: senderId, receiver_id: receiverId })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) throw new HttpError(400, { error: 'transaction_info_needed', message: `missing ${missing.join(', ')}` });
  if (body.asset_code !== 'USDC') throw new HttpError(400, { error: 'asset_code must be USDC' });
  if (text(body.asset_issuer) && body.asset_issuer !== usdcIssuer) throw new HttpError(400, { error: `asset_issuer must be ${usdcIssuer}` });
  if (text(body.destination_asset) && body.destination_asset !== COP_ASSET) throw new HttpError(400, { error: `destination_asset must be ${COP_ASSET}` });
  if (text(body.funding_method) && body.funding_method !== 'ACH') throw new HttpError(400, { error: 'funding_method must be ACH' });
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum < MIN_AMOUNT || amountNum > MAX_AMOUNT) {
    throw new HttpError(400, { error: `amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} USDC` });
  }

  const quote = stores.quotes.get(quoteId!);
  if (!quote || quote.account !== auth.account) throw new HttpError(400, { error: `quote ${quoteId} not found` });
  if (Date.parse(quote.expires_at) <= nowMs) throw new HttpError(400, { error: `quote ${quoteId} has expired` });
  if (quote.sell_asset !== usdcAsset(usdcIssuer) || quote.buy_asset !== COP_ASSET) throw new HttpError(400, { error: 'quote is not USDC to COP' });
  if (Math.abs(Number(quote.sell_amount) - amountNum) > AMOUNT_TOLERANCE) throw new HttpError(400, { error: `amount ${amount} does not match the quote's sell_amount ${quote.sell_amount}` });

  for (const [id, type] of [
    [senderId!, 'sep31-sender'],
    [receiverId!, 'sep31-receiver'],
  ] as const) {
    const customer = stores.customers.get(id);
    if (!customer || customer.account !== auth.account || customer.type !== type || customerStatus(customer).status !== 'ACCEPTED') {
      throw new HttpError(400, { error: 'customer_info_needed', type });
    }
  }

  const id = randomUUID();
  let memo = id.replace(/-/g, '').slice(0, 20);
  while (stores.transactions.find((t) => t.stellar_memo === memo)) memo = randomBytes(10).toString('hex');
  const now = new Date(nowMs).toISOString();
  const tx: Sep31Transaction = {
    id,
    account: auth.account,
    status: 'pending_sender',
    status_eta: null,
    amount_in: quote.sell_amount,
    amount_in_asset: quote.sell_asset,
    amount_out: quote.buy_amount,
    amount_out_asset: COP_ASSET,
    amount_fee: '0',
    quote_id: quote.id,
    sender_id: senderId!,
    receiver_id: receiverId!,
    stellar_account_id: receiverAccount,
    stellar_memo_type: 'text',
    stellar_memo: memo,
    started_at: now,
    updated_at: now,
    completed_at: null,
    stellar_transaction_id: null,
    external_transaction_id: null,
    refunded: false,
    message: null,
    callback_url: null,
  };
  stores.transactions.put(tx);
  return ok({ id, stellar_account_id: receiverAccount, stellar_memo_type: 'text', stellar_memo: memo }, 201);
}

/** The spec's transaction object: internal bookkeeping (owner account, callback, ids) left out. */
export function projectTransaction(tx: Sep31Transaction): Record<string, unknown> {
  const { account: _account, callback_url: _callback, sender_id: _sender, receiver_id: _receiver, ...rest } = tx;
  return rest;
}

function owned(stores: Stores, auth: Auth, id: string): Sep31Transaction {
  const tx = stores.transactions.get(id);
  if (!tx || tx.account !== auth.account) throw new HttpError(404, { error: 'transaction not found' });
  return tx;
}

export function getTransaction(stores: Stores, auth: Auth, id: string): Res {
  return ok({ transaction: projectTransaction(owned(stores, auth, id)) });
}

export function putCallback(stores: Stores, auth: Auth, id: string, body: Record<string, unknown>): Res {
  const url = text(body.url);
  if (!url) throw new HttpError(400, { error: 'url is required' });
  stores.transactions.put({ ...owned(stores, auth, id), callback_url: url });
  return { status: 204 };
}

// ---------- Status machine ----------

export interface IncomingPayment {
  type: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  to?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  memo?: string;
  memo_type?: string;
}

/** True when `payment` is our USDC, to the receiver, carries the transaction's memo and covers amount_in. */
export function paymentMatches(tx: Sep31Transaction, payment: IncomingPayment, receiverAccount: string, usdcIssuer: string): boolean {
  if (tx.status !== 'pending_sender') return false;
  if (payment.transaction_successful === false) return false;
  if (payment.type !== 'payment' && !payment.type.startsWith('path_payment')) return false;
  if (payment.to !== receiverAccount || payment.asset_code !== 'USDC' || payment.asset_issuer !== usdcIssuer) return false;
  if (payment.memo_type !== 'text' || payment.memo !== tx.stellar_memo) return false;
  return Number(payment.amount ?? '0') + AMOUNT_TOLERANCE >= Number(tx.amount_in);
}

export function applyPayment(tx: Sep31Transaction, payment: IncomingPayment, nowMs = Date.now()): Sep31Transaction {
  const now = new Date(nowMs).toISOString();
  return { ...tx, status: 'pending_stellar', stellar_transaction_id: payment.transaction_hash, updated_at: now, status_eta: Math.ceil((PENDING_STELLAR_MS + PENDING_RECEIVER_MS) / 1000) };
}

/** The time-driven transition due at `nowMs`, or null when the record stays as it is. */
export function advance(tx: Sep31Transaction, nowMs = Date.now()): Sep31Transaction | null {
  const now = new Date(nowMs).toISOString();
  const since = (iso: string) => nowMs - Date.parse(iso);
  switch (tx.status) {
    case 'pending_sender':
      return since(tx.started_at) >= SENDER_TIMEOUT_MS ? { ...tx, status: 'expired', updated_at: now, message: 'No se recibió el pago en 15 minutos' } : null;
    case 'pending_stellar':
      return since(tx.updated_at) >= PENDING_STELLAR_MS ? { ...tx, status: 'pending_receiver', updated_at: now, status_eta: Math.ceil(PENDING_RECEIVER_MS / 1000) } : null;
    case 'pending_receiver':
      return since(tx.updated_at) >= PENDING_RECEIVER_MS
        ? {
            ...tx,
            status: 'completed',
            updated_at: now,
            completed_at: now,
            status_eta: null,
            external_transaction_id: `ACH-CO-${randomBytes(4).toString('hex').toUpperCase()}`,
            message: 'Pesos abonados al encargo fiduciario',
          }
        : null;
    default:
      return null;
  }
}
