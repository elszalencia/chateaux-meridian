// Indexer and receipt join against a fake RPC (no network): paging with a cursor, every contract
// event name decoded, a restart from the stored cursor, a crash between writing events and saving
// the cursor (replay without duplicates), and receipts that exist only after the release event.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Address, Keypair, nativeToScVal, xdr, type rpc } from '@stellar/stellar-sdk';
import { EventIndexer, type GetEventsFn } from './indexer';
import { IndexedReceipts } from './receipts';
import { JsonFile } from './fileStore';
import type { Receipt } from '../domain/types';

const CONTRACT = 'CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP';
const PAYEE = Keypair.random().publicKey();
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cp-indexer-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const body = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k]! })),
  );

let seq = 0;
/** RPC event ids start with a TOID (`ledger << 32 | order`), zero-padded to 19 digits. */
const toid = (ledger: number, order: number) => `${((BigInt(ledger) << 32n) + BigInt(order)).toString().padStart(19, '0')}-0000000000`;
function event(ledger: number, name: string, topics: xdr.ScVal[], value: xdr.ScVal): rpc.Api.EventResponse {
  seq += 1;
  return {
    id: toid(ledger, seq),
    type: 'contract',
    ledger,
    ledgerClosedAt: new Date(Date.UTC(2026, 9, 23, 12, 0, ledger % 60)).toISOString(),
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: `tx${ledger}`.padEnd(64, 'a'),
    contractId: { toString: () => CONTRACT } as unknown as rpc.Api.EventResponse['contractId'],
    topic: [sym(name), ...topics],
    value,
  };
}

const released = (ledger: number, plan: number, idx: number, stroops: bigint) =>
  event(ledger, 'released', [u32(plan), u32(idx)], body({ usd_amount: nativeToScVal(stroops, { type: 'i128' }), to: new Address(PAYEE).toScVal(), spot: xdr.ScVal.scvBool(false) }));

/** Every event the contract emits, one each, for plan 7. */
function allKinds(): rpc.Api.EventResponse[] {
  const ev32 = xdr.ScVal.scvBytes(Buffer.alloc(32, 1));
  return [
    event(100, 'plan_created', [u32(7)], body({ buyer: new Address(PAYEE).toScVal(), count: u32(24) })),
    event(101, 'deposited', [u32(7)], body({ buyer: new Address(PAYEE).toScVal(), amount: nativeToScVal(5n, { type: 'i128' }), balance: nativeToScVal(5n, { type: 'i128' }) })),
    event(102, 'lock_applied', [u32(7)], body({ lock_id: ev32, idxs: xdr.ScVal.scvVec([u32(0), u32(1), u32(2)]), locked_rate: nativeToScVal(34444266667n, { type: 'i128' }), expiry_ts: nativeToScVal(1n, { type: 'u64' }) })),
    released(103, 7, 0, 11_883_327_462n),
    event(104, 'lock_broken', [u32(7), u32(2)], body({ lock_id: ev32 })),
    event(105, 'installment_marked', [u32(7), u32(3)], body({ status: u32(4), reason: u32(1), evidence: ev32 })),
    event(106, 'plan_state_changed', [u32(7)], body({ from: u32(0), to: u32(1), reason: u32(1), evidence: ev32 })),
    event(107, 'refunded', [u32(7)], body({ to: new Address(PAYEE).toScVal(), amount: nativeToScVal(1n, { type: 'i128' }), balance: nativeToScVal(0n, { type: 'i128' }), reason: u32(8), evidence: ev32 })),
    event(108, 'pause_changed', [], body({ paused: xdr.ScVal.scvBool(true) })),
  ];
}

/** A fake RPC over a growing list of events: startLedger or cursor (= last event id) paging. */
function fakeRpc(events: rpc.Api.EventResponse[]) {
  const calls: rpc.Api.GetEventsRequest[] = [];
  const getEvents: GetEventsFn = async (req) => {
    calls.push(req);
    const limit = req.limit ?? 100;
    const after = 'cursor' in req && req.cursor ? events.filter((e) => BigInt(e.id.split('-')[0]!) > BigInt(req.cursor!.split('-')[0]!)) : events.filter((e) => e.ledger >= (req as { startLedger: number }).startLedger);
    const page = after.slice(0, limit);
    const latestLedger = Math.max(...events.map((e) => e.ledger));
    // Like the real RPC, a page that ends early carries a cursor at the end of the scanned window.
    const cursor = page.length === limit ? page[page.length - 1]!.id : toid(latestLedger, 0xffffffff);
    return { events: page, cursor, latestLedger, oldestLedger: 1, latestLedgerCloseTime: '', oldestLedgerCloseTime: '' };
  };
  return { getEvents, calls };
}

describe('EventIndexer', () => {
  it('pages with the stored cursor and decodes every contract event, adverse ones included', async () => {
    const dir = tmp();
    const { getEvents, calls } = fakeRpc(allKinds());
    const ix = new EventIndexer({ contractId: CONTRACT, dataDir: dir, getEvents, startLedger: 50, pageSize: 4 });
    expect(await ix.pollOnce()).toBe(9);
    expect(calls[0]).toMatchObject({ startLedger: 50, limit: 4 });
    expect(calls.slice(1).every((c) => 'cursor' in c)).toBe(true);
    const names = ix.events.all().map((e) => e.name);
    expect(names).toEqual(['plan_created', 'deposited', 'lock_applied', 'released', 'lock_broken', 'installment_marked', 'plan_state_changed', 'refunded', 'pause_changed']);
    const rel = ix.events.all().find((e) => e.name === 'released')!;
    expect(rel).toMatchObject({ planId: 7, idx: 0, data: { usd_amount: '11883327462', to: PAYEE, spot: false } });
    expect(ix.events.all().find((e) => e.name === 'installment_marked')).toMatchObject({ planId: 7, idx: 3, data: { status: 4, reason: 1 } });
    expect(ix.events.all().find((e) => e.name === 'pause_changed')).toMatchObject({ planId: null, data: { paused: true } });
    expect(await ix.pollOnce()).toBe(0);
  });

  it('a restart resumes from the cursor file and reads only what is new', async () => {
    const dir = tmp();
    const list = allKinds().slice(0, 4);
    const rpc1 = fakeRpc(list);
    await new EventIndexer({ contractId: CONTRACT, dataDir: dir, getEvents: rpc1.getEvents, startLedger: 50 }).pollOnce();
    list.push(released(150, 7, 1, 1n));
    const rpc2 = fakeRpc(list);
    const again = new EventIndexer({ contractId: CONTRACT, dataDir: dir, getEvents: rpc2.getEvents, startLedger: 50 });
    expect(again.events.size).toBe(4);
    expect(await again.pollOnce()).toBe(1);
    expect('cursor' in rpc2.calls[0]!).toBe(true);
    expect(again.stats()).toMatchObject({ events: 5, fileLines: 5 });
  });

  it('a crash after writing events but before saving the cursor replays the page without duplicates', async () => {
    const dir = tmp();
    const list = allKinds();
    const write = JsonFile.prototype.write;
    let crashes = 1;
    JsonFile.prototype.write = function (this: JsonFile<unknown>, v: unknown) {
      if (crashes > 0) {
        crashes -= 1;
        throw new Error('process killed');
      }
      return write.call(this, v);
    };
    try {
      const first = new EventIndexer({ contractId: CONTRACT, dataDir: dir, getEvents: fakeRpc(list).getEvents, startLedger: 50, pageSize: 5 });
      await first.pollOnce(); // writes 5 events, then "dies" while saving the cursor
      expect(first.events.size).toBe(5);
      expect(first.cursor.cursor).toBeNull();
    } finally {
      JsonFile.prototype.write = write;
    }
    const restarted = new EventIndexer({ contractId: CONTRACT, dataDir: dir, getEvents: fakeRpc(list).getEvents, startLedger: 50, pageSize: 5 });
    expect(await restarted.pollOnce()).toBe(4); // the 5 replayed events are dropped, 4 are new
    expect(restarted.stats()).toMatchObject({ events: 9, fileLines: 9 });
    const ids = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a torn last line is skipped on load and the event comes back on replay', async () => {
    const dir = tmp();
    const list = allKinds().slice(0, 3);
    await new EventIndexer({ contractId: CONTRACT, dataDir: dir, getEvents: fakeRpc(list).getEvents, startLedger: 50 }).pollOnce();
    const { appendFileSync } = await import('node:fs');
    appendFileSync(path.join(dir, 'events.jsonl'), '\n{"id":"0000004290672328704-0000000001","contr');
    const ix = new EventIndexer({ contractId: CONTRACT, dataDir: dir, getEvents: fakeRpc(list).getEvents, startLedger: 50 });
    expect(ix.events.skipped).toBe(1);
    expect(ix.events.size).toBe(3);
  });
});

describe('IndexedReceipts', () => {
  const settlement = (idx: number): Receipt => ({
    id: `rcpt-plan-maria-${idx}`,
    planId: 'plan-maria',
    buyerId: 'buyer-maria',
    installmentIdx: idx,
    paidAt: `2026-11-20T10:00:0${idx}.000Z`,
    usdPaid: 1188.33,
    rateKind: 'locked',
    lockedRate: 3444.4266666666665,
    spotAtPayment: 3422.325,
    anchorRate: 3422.325,
    copDelivered: 4_093_125,
    feeUsd: 0,
    fxDeclarationRef: 'DCI-1',
    txHash: 'set-by-demo-api',
    lockId: 'lock-1',
    hedgeTradeId: null,
    anchorCop: 4_093_125,
    ndfSettlementCop: null,
    basisCop: 0,
    marginCop: 0,
    copCredited: 4_093_125,
    breakCostCop: 0,
  });

  it('a receipt exists only once the release event is indexed, takes the event hash, and is written once', async () => {
    const dir = tmp();
    const list = [released(103, 7, 3, 11_883_327_462n)];
    const ix = new EventIndexer({ contractId: CONTRACT, dataDir: dir, getEvents: fakeRpc(list).getEvents, startLedger: 50 });
    const receipts = new IndexedReceipts(dir);
    const plans = new Set([7]);
    const lookup = (plan: number, idx: number) => (plan === 7 && idx === 3 ? settlement(3) : undefined);

    expect(receipts.join(ix.events.all(), plans, lookup)).toHaveLength(0); // nothing indexed yet
    await ix.pollOnce();
    const [r] = receipts.join(ix.events.all(), plans, lookup, () => 'sep31-abc');
    expect(r).toMatchObject({ receiptId: 'rcpt-plan-maria-3', txHash: list[0]!.txHash, chainLedger: 103, releasedStroops: '11883327462', offRampId: 'sep31-abc' });
    expect(receipts.join(ix.events.all(), plans, lookup)).toHaveLength(0);
    // a restart (new instances over the same files) neither loses nor duplicates it
    const again = new IndexedReceipts(dir);
    expect(again.join(ix.events.all(), plans, lookup)).toHaveLength(0);
    expect(again.forPlan(CONTRACT, 7).map((x) => x.id)).toEqual(['rcpt-plan-maria-3']);
    expect(again.store.lineCount()).toBe(1);
  });

  it('release events of plans that are not current, or without a settlement yet, are left alone', () => {
    const dir = tmp();
    const receipts = new IndexedReceipts(dir);
    const events = [released(1, 99, 0, 1n), released(2, 7, 5, 1n)].map((e) => ({
      id: e.id, contractId: CONTRACT, ledger: e.ledger, ledgerClosedAt: e.ledgerClosedAt, txHash: e.txHash, name: 'released', planId: e.ledger === 1 ? 99 : 7, idx: e.ledger === 1 ? 0 : 5, data: {},
    }));
    expect(receipts.join(events, new Set([7]), () => undefined)).toHaveLength(0);
    expect(receipts.join(events, new Set([7]), (p, i) => (p === 7 && i === 5 ? settlement(5) : undefined))).toHaveLength(1);
  });
});
