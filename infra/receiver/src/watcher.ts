// Horizon watcher and clock sweep. Polling the receiver's payments page with `join=transactions`
// gives each payment's memo without a second request; the paging token is saved after every page so
// a restart resumes where it stopped, and the first start resolves Horizon's `now` cursor from the
// page's next link so nothing that lands between two ticks is missed. A failed poll is logged and
// retried on the next tick. The sweep applies the time-driven transitions once a second, which also
// finishes transactions that were mid-flight when the process last stopped.

import { explorerTxUrl } from '../../../services/src/chain/env.ts';
import type { HorizonClient, HorizonPayment } from './horizon.ts';
import { messageOf } from './log.ts';
import { advance, applyPayment, paymentMatches, type IncomingPayment } from './sep31.ts';
import type { Sep31Transaction, Stores } from './store.ts';

export const POLL_INTERVAL_MS = 4_000;
export const SWEEP_INTERVAL_MS = 1_000;
const PAGE_LIMIT = 50;

export interface WatcherDeps {
  horizon: HorizonClient;
  stores: Stores;
  receiverAccount: string;
  usdcIssuer: string;
  log: (message: string) => void;
}

export class Watcher {
  private pollTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly deps: WatcherDeps) {}

  start(): void {
    this.pollTimer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    void this.pollOnce();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = this.sweepTimer = null;
  }

  /** One pass over every new payment since the saved cursor; never throws. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let cursor = this.deps.stores.cursor.read().paging_token;
      for (;;) {
        const page = await this.deps.horizon.payments(this.deps.receiverAccount, cursor, PAGE_LIMIT);
        for (const record of page.records) this.handlePayment(record);
        if (page.cursor !== cursor) {
          cursor = page.cursor;
          this.deps.stores.cursor.write({ paging_token: cursor });
        }
        if (page.records.length < PAGE_LIMIT) break;
      }
    } catch (e) {
      this.deps.log(`horizon poll failed, retrying next tick: ${messageOf(e)}`);
    } finally {
      this.polling = false;
    }
  }

  handlePayment(record: HorizonPayment): void {
    if (record.to !== this.deps.receiverAccount) return; // outgoing (the trustline funding and the like)
    const payment: IncomingPayment = { ...record, memo: record.transaction?.memo, memo_type: record.transaction?.memo_type };
    const match = this.deps.stores.transactions.find((tx) => paymentMatches(tx, payment, this.deps.receiverAccount, this.deps.usdcIssuer));
    if (!match) {
      const memo = payment.memo_type === 'none' || !payment.memo_type ? 'without memo' : `memo ${payment.memo_type}:${payment.memo ?? ''}`;
      this.deps.log(`ignoring ${record.amount ?? '?'} ${record.asset_code ?? record.asset_type ?? '?'} from ${record.from ?? '?'} ${memo}: no pending transaction matches ${explorerTxUrl(record.transaction_hash)}`);
      return;
    }
    this.transition(match, applyPayment(match, payment));
  }

  /** Applies every time-driven transition that is due. */
  sweep(nowMs = Date.now()): void {
    for (const tx of this.deps.stores.transactions.values()) {
      const next = advance(tx, nowMs);
      if (next) this.transition(tx, next);
    }
  }

  private transition(from: Sep31Transaction, to: Sep31Transaction): void {
    this.deps.stores.transactions.put(to);
    const link = to.stellar_transaction_id ? ` ${explorerTxUrl(to.stellar_transaction_id)}` : '';
    const ref = to.external_transaction_id ? ` ref ${to.external_transaction_id}` : '';
    this.deps.log(`transaction ${to.id}: ${from.status} -> ${to.status}${ref}${link}`);
  }
}
