// Persistence: one JSON file per collection under the data dir, rewritten whole on every change.
// The receiver holds a few dozen records at most, so the simplest durable thing wins over a
// database; a restart reloads the files and the watcher resumes from the saved paging token. Record
// shapes mirror the SEP responses so a GET is a projection, not a translation.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Customer {
  id: string;
  /** Stellar account of the SEP-10 token that registered the customer, plus the memo used, if any. */
  account: string;
  memo: string | null;
  type: string;
  fields: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface Quote {
  id: string;
  account: string;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  price: string;
  total_price: string;
  expires_at: string;
  created_at: string;
}

export type Sep31Status = 'pending_sender' | 'pending_stellar' | 'pending_receiver' | 'completed' | 'expired';

export interface Sep31Transaction {
  id: string;
  account: string;
  status: Sep31Status;
  status_eta: number | null;
  amount_in: string;
  amount_in_asset: string;
  amount_out: string;
  amount_out_asset: string;
  amount_fee: string;
  quote_id: string;
  sender_id: string;
  receiver_id: string;
  stellar_account_id: string;
  stellar_memo_type: 'text';
  stellar_memo: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  stellar_transaction_id: string | null;
  external_transaction_id: string | null;
  refunded: boolean;
  message: string | null;
  callback_url: string | null;
}

export class JsonFile<T> {
  constructor(
    private readonly path: string,
    private readonly fallback: T,
  ) {}

  read(): T {
    if (!existsSync(this.path)) return this.fallback;
    return JSON.parse(readFileSync(this.path, 'utf8')) as T;
  }

  /** Written to a sibling temp file and renamed over, so a crash mid-write never leaves half a file. */
  write(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, this.path);
  }
}

export class Collection<T extends { id: string }> {
  private readonly file: JsonFile<T[]>;
  private readonly items = new Map<string, T>();

  constructor(path: string) {
    this.file = new JsonFile<T[]>(path, []);
    for (const item of this.file.read()) this.items.set(item.id, item);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  put(item: T): T {
    this.items.set(item.id, item);
    this.file.write(this.values());
    return item;
  }

  delete(id: string): boolean {
    const had = this.items.delete(id);
    if (had) this.file.write(this.values());
    return had;
  }

  values(): T[] {
    return [...this.items.values()];
  }

  find(pred: (item: T) => boolean): T | undefined {
    return this.values().find(pred);
  }

  get size(): number {
    return this.items.size;
  }
}

export interface Stores {
  customers: Collection<Customer>;
  quotes: Collection<Quote>;
  transactions: Collection<Sep31Transaction>;
  /** Horizon paging token of the last payment seen; `now` until the first poll resolves it. */
  cursor: JsonFile<{ paging_token: string }>;
}

export function openStores(dataDir: string): Stores {
  mkdirSync(dataDir, { recursive: true });
  return {
    customers: new Collection<Customer>(join(dataDir, 'customers.json')),
    quotes: new Collection<Quote>(join(dataDir, 'quotes.json')),
    transactions: new Collection<Sep31Transaction>(join(dataDir, 'transactions.json')),
    cursor: new JsonFile<{ paging_token: string }>(join(dataDir, 'cursor.json'), { paging_token: 'now' }),
  };
}
