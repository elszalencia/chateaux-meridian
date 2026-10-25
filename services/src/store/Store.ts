// Persistence API. Stage 1 implements it in memory (seeded from fixtures, optionally mirrored to
// localStorage); the Supabase layer implements the same table-shaped interface later. Every row has
// a string `id`, so one generic contract covers all tables.

import type { Snapshot, TableName, Tables } from '../domain/types';

export interface Store {
  all<K extends TableName>(table: K): Promise<Tables[K][]>;
  get<K extends TableName>(table: K, id: string): Promise<Tables[K] | undefined>;
  upsert<K extends TableName>(table: K, row: Tables[K]): Promise<void>;
  upsertMany<K extends TableName>(table: K, rows: Tables[K][]): Promise<void>;
  remove<K extends TableName>(table: K, id: string): Promise<void>;
  replaceAll(snapshot: Snapshot): Promise<void>;
  snapshot(): Promise<Snapshot>;
}

export const TABLE_NAMES: TableName[] = [
  'buyers',
  'units',
  'plans',
  'installments',
  'locks',
  'renewal_offers',
  'hedge_legs',
  'hedge_trades',
  'receipts',
  'curves',
  'demo_state',
  'plan_governance',
  'policy_events',
];

export function emptySnapshot(): Snapshot {
  return {
    buyers: [],
    units: [],
    plans: [],
    installments: [],
    locks: [],
    renewal_offers: [],
    hedge_legs: [],
    hedge_trades: [],
    receipts: [],
    curves: [],
    demo_state: [],
    plan_governance: [],
    policy_events: [],
  };
}
