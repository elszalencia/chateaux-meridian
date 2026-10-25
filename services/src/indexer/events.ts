// Decoding of payment_plan contract events into JSON-safe rows. `#[contractevent]` publishes the
// struct name in snake_case as the first topic, then the fields marked `#[topic]` (plan_id, and idx
// where present), and the remaining fields as a map in the event body. Every event the contract
// emits is kept, including the adverse-event ones (plan_state_changed, installment_marked,
// refunded) and pause_changed; unknown names are stored as they come so a newer contract never
// stops the indexer.

import { scValToNative, type rpc } from '@stellar/stellar-sdk';

export const CONTRACT_EVENT_NAMES = [
  'plan_created',
  'deposited',
  'lock_applied',
  'released',
  'lock_broken',
  'plan_state_changed',
  'installment_marked',
  'refunded',
  'pause_changed',
] as const;

export type ContractEventName = (typeof CONTRACT_EVENT_NAMES)[number];

export interface IndexedEvent {
  /** RPC event id (ledger, transaction, operation and event order): unique and sortable. */
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  name: ContractEventName | string;
  planId: number | null;
  idx: number | null;
  /** Event body with bigints as decimal strings and bytes as hex. */
  data: Record<string, unknown>;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Makes a `scValToNative` result JSON-safe: bigint → string, bytes → hex, maps → objects. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return hex(v);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), jsonSafe(x)]));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export function decodeEvent(ev: rpc.Api.EventResponse): IndexedEvent {
  const topics = ev.topic.map((t) => scValToNative(t));
  const name = String(topics[0] ?? 'unknown');
  const body = jsonSafe(scValToNative(ev.value));
  const data = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : { value: body };
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: ev.id,
    contractId: ev.contractId?.toString() ?? '',
    ledger: ev.ledger,
    ledgerClosedAt: ev.ledgerClosedAt,
    txHash: ev.txHash,
    name,
    planId: num(topics[1]),
    idx: num(topics[2]),
    data,
  };
}
