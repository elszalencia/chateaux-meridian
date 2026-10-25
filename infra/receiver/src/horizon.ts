// Horizon over plain fetch: the receiver needs four calls (account lookup, friendbot, submit, the
// payments page with joined transactions), and typing the few fields it reads is clearer than the
// SDK's Horizon client with its own HTTP stack. Every request has a timeout; callers treat a thrown
// error as "try again on the next tick", never as a reason to stop the process.

import { FRIENDBOT_URL } from '../../../services/src/chain/env.ts';

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

export interface HorizonSigner {
  key: string;
  weight: number;
  type: string;
}

export interface HorizonAccount {
  id: string;
  sequence: string;
  balances: HorizonBalance[];
  signers: HorizonSigner[];
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
}

/** A record of `/accounts/{id}/payments?join=transactions`; only the fields the watcher reads. */
export interface HorizonPayment {
  id: string;
  paging_token: string;
  type: string;
  transaction_successful: boolean;
  transaction_hash: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  from?: string;
  to?: string;
  amount?: string;
  transaction?: { memo?: string; memo_type?: string };
}

export interface PaymentsPage {
  records: HorizonPayment[];
  /** Paging token to continue from: the last record's, or the one Horizon resolved `now` to. */
  cursor: string;
}

interface Page<T> {
  _links?: { next?: { href?: string } };
  _embedded?: { records?: T[] };
}

const TIMEOUT_MS = 15_000;

export class HorizonClient {
  constructor(readonly url: string) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  /** The account, or null when Horizon answers 404 (not yet created). */
  async account(id: string): Promise<HorizonAccount | null> {
    const res = await this.request(`/accounts/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon GET /accounts/${id}: HTTP ${res.status}`);
    return (await res.json()) as HorizonAccount;
  }

  async payments(account: string, cursor: string, limit = 50): Promise<PaymentsPage> {
    const q = new URLSearchParams({ order: 'asc', cursor, limit: String(limit), join: 'transactions' });
    const res = await this.request(`/accounts/${account}/payments?${q}`);
    if (!res.ok) throw new Error(`Horizon GET /accounts/${account}/payments: HTTP ${res.status}`);
    const page = (await res.json()) as Page<HorizonPayment>;
    const records = page._embedded?.records ?? [];
    const last = records[records.length - 1];
    let next = last ? last.paging_token : cursor;
    if (!last && page._links?.next?.href) {
      const resolved = new URL(page._links.next.href).searchParams.get('cursor');
      if (resolved) next = resolved;
    }
    return { records, cursor: next };
  }

  /** Submits a signed envelope; the error message carries Horizon's result codes when it fails. */
  async submit(envelopeXdr: string): Promise<{ hash: string }> {
    const res = await this.request('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tx: envelopeXdr }).toString(),
    });
    const body = (await res.json()) as { hash?: string; extras?: { result_codes?: unknown }; detail?: string };
    if (!res.ok || !body.hash) throw new Error(`Horizon POST /transactions: HTTP ${res.status} ${JSON.stringify(body.extras?.result_codes ?? body.detail ?? '')}`);
    return { hash: body.hash };
  }
}

export async function friendbot(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`, { signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  if (!res.ok) throw new Error(`friendbot: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
