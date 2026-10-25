// In-memory Store with an optional persistence hook (the web app passes localStorage). Rows are
// deep-copied on the way in and out so callers can never mutate state behind the store's back.

import type { Snapshot, TableName, Tables } from '../domain/types';
import { TABLE_NAMES, emptySnapshot, type Store } from './Store';

export interface Persistence {
  load(): Snapshot | null;
  save(snapshot: Snapshot): void;
  clear(): void;
}

const clone = <T>(x: T): T => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

export class MemoryStore implements Store {
  private tables: { [K in TableName]: Map<string, Tables[K]> };

  constructor(initial: Snapshot, private readonly persistence?: Persistence) {
    this.tables = MemoryStore.fromSnapshot(initial);
  }

  private static fromSnapshot(s: Snapshot): { [K in TableName]: Map<string, Tables[K]> } {
    const out = {} as { [K in TableName]: Map<string, Tables[K]> };
    for (const name of TABLE_NAMES) {
      const rows = (s[name] ?? []) as { id: string }[];
      (out as Record<string, Map<string, unknown>>)[name] = new Map(rows.map((r) => [r.id, clone(r)]));
    }
    return out;
  }

  private flush(): void {
    this.persistence?.save(this.toSnapshot());
  }

  private toSnapshot(): Snapshot {
    const s = emptySnapshot();
    for (const name of TABLE_NAMES) {
      (s as Record<string, unknown[]>)[name] = [...this.tables[name].values()].map(clone);
    }
    return s;
  }

  async all<K extends TableName>(table: K): Promise<Tables[K][]> {
    return [...this.tables[table].values()].map(clone);
  }

  async get<K extends TableName>(table: K, id: string): Promise<Tables[K] | undefined> {
    const row = this.tables[table].get(id);
    return row ? clone(row) : undefined;
  }

  async upsert<K extends TableName>(table: K, row: Tables[K]): Promise<void> {
    this.tables[table].set(row.id, clone(row));
    this.flush();
  }

  async upsertMany<K extends TableName>(table: K, rows: Tables[K][]): Promise<void> {
    for (const row of rows) this.tables[table].set(row.id, clone(row));
    this.flush();
  }

  async remove<K extends TableName>(table: K, id: string): Promise<void> {
    this.tables[table].delete(id);
    this.flush();
  }

  async replaceAll(snapshot: Snapshot): Promise<void> {
    this.tables = MemoryStore.fromSnapshot(snapshot);
    this.flush();
  }

  async snapshot(): Promise<Snapshot> {
    return this.toSnapshot();
  }
}
