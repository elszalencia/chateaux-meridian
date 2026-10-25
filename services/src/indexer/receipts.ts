// Receipts in testnet mode come from the indexer. DemoApi writes the off-chain half of a payment
// (USD paid, rates, COP delivered, hedge settlement): the pending settlement. A receipt exists only
// once the indexer has seen the contract's `released` event for that installment; its transaction
// hash, ledger and on-chain amount are taken from the event, never from an RPC call made on demand.
// Receipts are keyed by (contract, chain plan, installment): an installment is released once, so a
// replayed event or a second join never writes a second receipt.

import type { Receipt } from '../domain/types';
import type { IndexedEvent } from './events';
import { JsonlStore } from './fileStore';

export interface IndexedReceipt extends Receipt {
  /** Store key `<contract>:<chain plan>:<idx>`; the UI receipt id is `receiptId`. */
  id: string;
  receiptId: string;
  contractId: string;
  chainPlanId: number;
  chainLedger: number;
  chainClosedAt: string;
  chainEventId: string;
  /** Stroops the contract released to payee_backend (decimal string). */
  releasedStroops: string;
  spotRelease: boolean;
  /** SEP-31 payout of this installment, when the off-ramp reported one. */
  offRampId?: string;
}

/** Off-chain half of a payment, looked up by chain plan and installment index. */
export type SettlementLookup = (chainPlanId: number, idx: number) => Receipt | undefined;

export const receiptKey = (contractId: string, chainPlanId: number, idx: number) => `${contractId}:${chainPlanId}:${idx}`;

export class IndexedReceipts {
  readonly store: JsonlStore<IndexedReceipt>;

  constructor(dataDir: string) {
    this.store = new JsonlStore<IndexedReceipt>(dataDir, 'receipts');
  }

  /**
   * Joins every indexed `released` event of the given chain plans that has no receipt yet with its
   * settlement. Events without a settlement (older demo runs, or a payment still being recorded)
   * are left for a later join. Returns the receipts written.
   */
  join(events: IndexedEvent[], chainPlanIds: Set<number>, settlementOf: SettlementLookup, offRampOf?: (chainPlanId: number, idx: number) => string | undefined): IndexedReceipt[] {
    const written: IndexedReceipt[] = [];
    for (const ev of events) {
      if (ev.name !== 'released' || ev.planId == null || ev.idx == null || !chainPlanIds.has(ev.planId)) continue;
      const key = receiptKey(ev.contractId, ev.planId, ev.idx);
      if (this.store.has(key)) continue;
      const settlement = settlementOf(ev.planId, ev.idx);
      if (!settlement) continue;
      const offRampId = offRampOf?.(ev.planId, ev.idx);
      const row: IndexedReceipt = {
        ...settlement,
        id: key,
        receiptId: settlement.id,
        txHash: ev.txHash,
        contractId: ev.contractId,
        chainPlanId: ev.planId,
        chainLedger: ev.ledger,
        chainClosedAt: ev.ledgerClosedAt,
        chainEventId: ev.id,
        releasedStroops: String(ev.data.usd_amount ?? ''),
        spotRelease: Boolean(ev.data.spot),
        ...(offRampId ? { offRampId } : {}),
      };
      if (this.store.put(row)) written.push(row);
    }
    return written;
  }

  /** Receipts of one chain plan as the UI expects them (UI id, newest first). */
  forPlan(contractId: string, chainPlanId: number): Receipt[] {
    return this.store
      .all()
      .filter((r) => r.contractId === contractId && r.chainPlanId === chainPlanId)
      .map((r) => ({ ...r, id: r.receiptId }))
      .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  }

  find(contractId: string, chainPlanId: number, idx: number): IndexedReceipt | undefined {
    return this.store.get(receiptKey(contractId, chainPlanId, idx));
  }
}
