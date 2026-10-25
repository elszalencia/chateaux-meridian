// SEP-12 customer registration for the two SEP-31 roles. The receiver accepts any SEP-9 text field
// and decides status from a short required list per type: a customer with the required fields is
// ACCEPTED on the spot (nobody reviews anything here), otherwise NEEDS_INFO names the gaps.
// Customers belong to the SEP-10 account (and memo) that registered them; one account registers
// several customers of the same type by passing distinct memos, or updates one by its id.

import { randomUUID } from 'node:crypto';
import { HttpError, ok, type Res } from './http.ts';
import type { Auth } from './sep10.ts';
import type { Collection, Customer } from './store.ts';

export const CUSTOMER_TYPES: Record<string, string> = {
  'sep31-sender': 'Comprador en EE. UU.',
  'sep31-receiver': 'Encargo fiduciario del comprador en Fidudavivienda',
};

const REQUIRED: Record<string, string[]> = {
  'sep31-sender': ['first_name', 'last_name', 'email_address'],
  'sep31-receiver': ['first_name', 'last_name', 'bank_account_number', 'bank_name'],
};

const FIELD_META: Record<string, { type: string; description: string }> = {
  first_name: { type: 'string', description: 'Nombres' },
  last_name: { type: 'string', description: 'Apellidos' },
  email_address: { type: 'string', description: 'Correo electrónico' },
  bank_account_number: { type: 'string', description: 'Número del encargo fiduciario (por ejemplo FD-OLV-0142)' },
  bank_name: { type: 'string', description: 'Entidad fiduciaria (Fidudavivienda)' },
};

/** Request keys that address the customer rather than describe it. */
const CONTROL_KEYS = new Set(['id', 'account', 'memo', 'memo_type', 'type', 'transaction_id', 'lang']);

const meta = (field: string) => FIELD_META[field] ?? { type: 'string', description: field };

export function customerStatus(customer: Customer): { status: 'ACCEPTED' | 'NEEDS_INFO'; missing: string[] } {
  const missing = (REQUIRED[customer.type] ?? []).filter((f) => !customer.fields[f]);
  return { status: missing.length === 0 ? 'ACCEPTED' : 'NEEDS_INFO', missing };
}

function project(customer: Customer): Record<string, unknown> {
  const { status, missing } = customerStatus(customer);
  const provided_fields = Object.fromEntries(Object.keys(customer.fields).map((f) => [f, { ...meta(f), status: 'ACCEPTED' }]));
  const out: Record<string, unknown> = { id: customer.id, status, provided_fields };
  if (missing.length > 0) out.fields = Object.fromEntries(missing.map((f) => [f, meta(f)]));
  return out;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

export function putCustomer(customers: Collection<Customer>, auth: Auth, body: Record<string, unknown>, now = new Date().toISOString()): Res {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    const s = text(v);
    if (!CONTROL_KEYS.has(k) && s !== null && s !== '') fields[k] = s;
  }
  const id = text(body.id);
  const account = text(body.account) ?? auth.account;
  if (account !== auth.account) throw new HttpError(403, { error: 'account does not match the SEP-10 token' });
  const memo = text(body.memo) ?? auth.memo;
  const type = text(body.type) ?? '';
  let existing: Customer | undefined;
  if (id) {
    existing = customers.get(id);
    if (!existing || existing.account !== auth.account) throw new HttpError(404, { error: `customer ${id} not found` });
  } else {
    existing = customers.find((c) => c.account === account && c.memo === memo && c.type === type);
  }
  const customer: Customer = existing
    ? { ...existing, type: text(body.type) ?? existing.type, fields: { ...existing.fields, ...fields }, updated_at: now }
    : { id: randomUUID(), account, memo, type, fields, created_at: now, updated_at: now };
  customers.put(customer);
  return ok({ id: customer.id }, 202);
}

export function getCustomer(customers: Collection<Customer>, auth: Auth, query: URLSearchParams): Res {
  const id = query.get('id');
  let customer: Customer | undefined;
  if (id) {
    customer = customers.get(id);
  } else {
    const account = query.get('account') ?? auth.account;
    const memo = query.get('memo') ?? auth.memo;
    const type = query.get('type');
    customer = customers.find((c) => c.account === account && c.memo === memo && (type === null || c.type === type));
  }
  if (!customer || customer.account !== auth.account) throw new HttpError(404, { error: 'customer not found' });
  return ok(project(customer));
}

export function deleteCustomer(customers: Collection<Customer>, auth: Auth, account: string, memo: string | null): Res {
  if (account !== auth.account) throw new HttpError(404, { error: 'customer not found' });
  const victims = customers.values().filter((c) => c.account === account && (memo === null || c.memo === memo));
  if (victims.length === 0) throw new HttpError(404, { error: 'customer not found' });
  for (const c of victims) customers.delete(c.id);
  return ok({});
}
