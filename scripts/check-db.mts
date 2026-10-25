// Migration check without Docker: applies every file in supabase/migrations, in name order, to an
// in-process Postgres (PGlite, Apache-2.0) with a minimal stub of Supabase's auth schema
// (auth.uid() and auth.role() read the JWT claims from `request.jwt.claims`, as Supabase does),
// then signs in as fixture users under the `authenticated` role and checks one allow and one deny
// case for every row-level security policy added after the initial migration. A policy without
// both cases fails the check, so a new policy cannot slip in untested.
//
//   npm run check:db
//
// Exit code 0 when every migration applies and every case holds; 1 otherwise.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CORRIDORS } from '../config/corridors';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

const AUTH_STUB = `
create schema if not exists auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'anon')
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid(), auth.role() to anon, authenticated;
`;

// Fixture users (auth.uid values).
const U = {
  roxana: '00000000-0000-4000-8000-000000000001', // buyer, office Woodbridge, seller Cuscatlán
  marvin: '00000000-0000-4000-8000-000000000002', // buyer, office Silver Spring, seller Los Abetos
  cajero1: '00000000-0000-4000-8000-000000000011', // cashier at Woodbridge
  cajero2: '00000000-0000-4000-8000-000000000012', // cashier at Silver Spring
  bo1: '00000000-0000-4000-8000-000000000021', // back office of Cuscatlán
  bo2: '00000000-0000-4000-8000-000000000022', // back office of Los Abetos
  stranger: '00000000-0000-4000-8000-000000000099', // signed in, no buyer or staff row
} as const;
type User = keyof typeof U | 'anon';

const HASH = 'a'.repeat(64);
const FIXTURES = `
insert into offices (id, corridor, name, address, city, state, hours, phone, is_licensed_agency) values
  ('of-wdb', 'sv', 'Agencia Woodbridge', '1 Main St', 'Woodbridge', 'VA', 'L-V 9-18', '+17035550100', true),
  ('of-ssp', 'sv', 'Agencia Silver Spring', '2 Main St', 'Silver Spring', 'MD', 'L-V 9-18', '+13015550100', true);
insert into staff (id, auth_user_id, role, office_id, display_name) values
  ('cajero-1', '${U.cajero1}', 'cashier', 'of-wdb', 'Cajero 1'),
  ('cajero-2', '${U.cajero2}', 'cashier', 'of-ssp', 'Cajero 2'),
  ('bo-1', '${U.bo1}', 'back_office', null, 'Escritorio 1'),
  ('bo-2', '${U.bo2}', 'back_office', null, 'Escritorio 2');
insert into sellers (id, corridor, tier, legal_name, trade_name, tax_id, legal_representative, bank, verification_status, verified_at, payout_option, payout_account) values
  ('seller-cus', 'sv', 1, 'Desarrollos Cuscatlán', 'Cuscatlán', '0614-1', 'Rep 1', 'Davivienda Salvadoreño', 'verified', now(), 'B', '{"kind":"bank","institution":"B","holder":"H","ref":"***1"}'),
  ('seller-lab', 'sv', 2, 'Inversiones Los Abetos', 'Los Abetos', '0614-2', 'Rep 2', 'Banco X', 'verified', now(), 'A', '{"kind":"provider_address","institution":"P","holder":"H","ref":"CUST-1"}');
insert into staff_sellers values ('bo-1', 'seller-cus'), ('bo-2', 'seller-lab');
insert into buyers (id, auth_user_id, name, email, phone, city, state, stellar_account, office_id) values
  ('buyer-roxana', '${U.roxana}', 'Roxana', 'r@example.test', '+17035550187', 'Woodbridge', 'VA', 'G1', 'of-wdb'),
  ('buyer-marvin', '${U.marvin}', 'Marvin', 'm@example.test', '+13015550129', 'Silver Spring', 'MD', 'G2', 'of-ssp');
insert into units (id, project, unit_name, unit_code, city, housing_type, price_cop, corridor) values
  ('unit-7b', 'Torre Cedros', '7B', '7B', 'San Salvador', 'No VIS', 9000000, 'sv'),
  ('unit-14', 'Los Abetos', 'Casa 14', 'C14', 'Santa Tecla', 'No VIS', 6500000, 'sv');
insert into seller_units (id, seller_id, unit_id, cnr_registry_no, cnr_cert_date, cnr_cert_hash) values
  ('su-7b', 'seller-cus', 'unit-7b', 'CNR-1', '2026-10-01', '${HASH}'),
  ('su-14', 'seller-lab', 'unit-14', 'CNR-2', '2026-10-01', '${HASH}');
insert into plans (id, buyer_id, unit_id, encargo_ref, start_date, installments_count, installment_cop, corridor, seller_id, payout_option) values
  ('plan-roxana', 'buyer-roxana', 'unit-7b', 'SV-1', '2026-05-24', 24, 75000, 'sv', 'seller-cus', 'B'),
  ('plan-marvin', 'buyer-marvin', 'unit-14', 'SV-2', '2026-07-15', 26, 50000, 'sv', 'seller-lab', 'A');
insert into installments (plan_id, idx, due_date, cop_due, status) values
  ('plan-roxana', 0, '2026-05-24', 75000, 'released'),
  ('plan-roxana', 1, '2026-06-24', 75000, 'missed'),
  ('plan-marvin', 0, '2026-07-15', 50000, 'released'),
  ('plan-marvin', 1, '2026-08-15', 50000, 'waived');
insert into receipts (id, plan_id, buyer_id, installment_idx, paid_at, usd_paid, rate_kind, cop_delivered) values
  ('rcpt-roxana-0', 'plan-roxana', 'buyer-roxana', 0, now(), 750, 'spot', 75000),
  ('rcpt-marvin-0', 'plan-marvin', 'buyer-marvin', 0, now(), 500, 'spot', 50000);
insert into payments (id, plan_id, idx, method, amount, fee, status, office_id, cashier_id, tender, received_at, receipt_id) values
  ('pay-roxana-0', 'plan-roxana', 0, 'office_counter', 75000, 0, 'completed', 'of-wdb', 'cajero-1', 'cash', now(), 'rcpt-roxana-0'),
  ('pay-marvin-0', 'plan-marvin', 0, 'office_counter', 50000, 0, 'completed', 'of-ssp', 'cajero-2', 'cash', now(), 'rcpt-marvin-0');
insert into payouts (id, plan_id, idx, receipt_id, seller_id, option, status, usd_paid, fee_usd, usd_to_seller) values
  ('po-roxana-0', 'plan-roxana', 0, 'rcpt-roxana-0', 'seller-cus', 'B', 'acreditado', 750, 0, 750),
  ('po-marvin-0', 'plan-marvin', 0, 'rcpt-marvin-0', 'seller-lab', 'A', 'transferido', 500, 0, 500);
insert into wa_outbox (id, plan_id, buyer_id, to_phone, template, locale, body, link) values
  ('wa-roxana', 'plan-roxana', 'buyer-roxana', '+17035550187', 'recordatorio', 'es', 'Hola', '#/c/plan-roxana/pagar'),
  ('wa-marvin', 'plan-marvin', 'buyer-marvin', '+13015550129', 'recordatorio', 'es', 'Hola', '#/c/plan-marvin/pagar');
insert into plan_governance (id, plan_id, state) values ('plan-roxana', 'plan-roxana', 'active'), ('plan-marvin', 'plan-marvin', 'on_hold');
insert into policy_events (id, seq, plan_id, at, kind, idx, from_state, to_state, reason_code, rule, executed, evidence) values
  ('pe-roxana', 1, 'plan-roxana', '2026-07-02', 'mark_missed', 1, 'active', 'delinquent', 100, 'R2', true, '${HASH}'),
  ('pe-marvin', 2, 'plan-marvin', '2026-10-17', 'place_hold', null, 'active', 'on_hold', 300, 'operator', true, '${HASH}');
`;

/** One allow and one deny case: `allow` sees the row, `deny` does not. */
interface Case {
  policy: string;
  table: string;
  where: string;
  allow: User;
  deny: User;
}
const row = (col: string, v: string) => `${col} = '${v}'`;
const CASES: Case[] = [
  { policy: 'corridors_read', table: 'corridors', where: row('id', 'sv'), allow: 'stranger', deny: 'anon' },
  { policy: 'offices_read', table: 'offices', where: row('id', 'of-wdb'), allow: 'roxana', deny: 'anon' },
  { policy: 'staff_self', table: 'staff', where: row('id', 'cajero-1'), allow: 'cajero1', deny: 'cajero2' },
  { policy: 'staff_sellers_self', table: 'staff_sellers', where: row('staff_id', 'bo-1'), allow: 'bo1', deny: 'bo2' },
  { policy: 'buyer_payments', table: 'payments', where: row('id', 'pay-roxana-0'), allow: 'roxana', deny: 'marvin' },
  { policy: 'buyer_payouts', table: 'payouts', where: row('id', 'po-roxana-0'), allow: 'roxana', deny: 'marvin' },
  { policy: 'buyer_outbox', table: 'wa_outbox', where: row('id', 'wa-roxana'), allow: 'roxana', deny: 'marvin' },
  { policy: 'buyer_governance', table: 'plan_governance', where: row('id', 'plan-roxana'), allow: 'roxana', deny: 'marvin' },
  { policy: 'buyer_sellers', table: 'sellers', where: row('id', 'seller-cus'), allow: 'roxana', deny: 'marvin' },
  { policy: 'cashier_buyers', table: 'buyers', where: row('id', 'buyer-roxana'), allow: 'cajero1', deny: 'cajero2' },
  { policy: 'cashier_plans', table: 'plans', where: row('id', 'plan-roxana'), allow: 'cajero1', deny: 'cajero2' },
  { policy: 'cashier_installments', table: 'installments', where: row('plan_id', 'plan-roxana'), allow: 'cajero1', deny: 'cajero2' },
  { policy: 'cashier_governance', table: 'plan_governance', where: row('id', 'plan-roxana'), allow: 'cajero1', deny: 'cajero2' },
  { policy: 'cashier_payments', table: 'payments', where: row('id', 'pay-roxana-0'), allow: 'cajero1', deny: 'cajero2' },
  { policy: 'cashier_receipts', table: 'receipts', where: row('id', 'rcpt-roxana-0'), allow: 'cajero1', deny: 'cajero2' },
  { policy: 'back_office_sellers', table: 'sellers', where: row('id', 'seller-cus'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_seller_units', table: 'seller_units', where: row('id', 'su-7b'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_units', table: 'units', where: row('id', 'unit-7b'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_plans', table: 'plans', where: row('id', 'plan-roxana'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_buyers', table: 'buyers', where: row('id', 'buyer-roxana'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_installments', table: 'installments', where: row('plan_id', 'plan-roxana'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_receipts', table: 'receipts', where: row('id', 'rcpt-roxana-0'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_payments', table: 'payments', where: row('id', 'pay-roxana-0'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_payouts', table: 'payouts', where: row('id', 'po-roxana-0'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_outbox', table: 'wa_outbox', where: row('id', 'wa-roxana'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_governance', table: 'plan_governance', where: row('id', 'plan-roxana'), allow: 'bo1', deny: 'bo2' },
  { policy: 'back_office_policy_events', table: 'policy_events', where: row('id', 'pe-roxana'), allow: 'bo1', deny: 'bo2' },
];

/** Checks that hold across roles: no cross-corridor leak and no write path for end users. */
const EXTRA: { name: string; as: User; sql: string; expect: number | 'error' }[] = [
  { name: 'a cashier does not see payments another cashier took for a buyer of a different office', as: 'cajero1', sql: `select count(*)::int as n from payments where id = 'pay-marvin-0'`, expect: 0 },
  { name: 'a back-office user sees no plan of another seller', as: 'bo1', sql: `select count(*)::int as n from plans where seller_id = 'seller-lab'`, expect: 0 },
  { name: 'a signed-in stranger sees no plan, payment or payout', as: 'stranger', sql: `select ((select count(*) from plans) + (select count(*) from payments) + (select count(*) from payouts))::int as n`, expect: 0 },
  { name: 'the initial buyer policy still works next to the new ones: Roxana sees her plan and not Marvin\x27s', as: 'roxana', sql: `select count(*)::int as n from plans where id in ('plan-roxana', 'plan-marvin')`, expect: 1 },
  { name: 'end users cannot write payments (backend only)', as: 'cajero1', sql: `insert into payments (id, plan_id, idx, method, amount, status) values ('x', 'plan-roxana', 1, 'ach', 1, 'pending')`, expect: 'error' },
];

let lastError = '';

async function asUser(db: PGlite, user: User, sql: string): Promise<{ n: number } | 'error'> {
  const claims = user === 'anon' ? '{"role":"anon"}' : JSON.stringify({ sub: U[user], role: 'authenticated' });
  try {
    return await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
      await tx.exec(`set local role ${user === 'anon' ? 'anon' : 'authenticated'}`);
      const r = await tx.query<{ n: number }>(sql);
      return { n: r.rows[0]?.n ?? 0 };
    });
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return 'error';
  }
}

async function policyNames(db: PGlite): Promise<Set<string>> {
  const r = await db.query<{ policyname: string }>(`select policyname from pg_policies where schemaname = 'public'`);
  return new Set(r.rows.map((x) => x.policyname));
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(AUTH_STUB);

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let baseline: Set<string> | null = null;
  for (const f of files) {
    try {
      await db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    } catch (e) {
      console.error(`FAIL apply ${f}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    console.log(`applied ${f}`);
    baseline ??= await policyNames(db);
  }
  const added = [...(await policyNames(db))].filter((p) => !baseline!.has(p)).sort();

  await db.exec(`grant usage on schema public to anon, authenticated; grant select on all tables in schema public to anon, authenticated;`);
  await db.exec(FIXTURES);

  let failures = 0;
  const fail = (msg: string) => {
    failures += 1;
    console.error(`FAIL ${msg}`);
  };

  const covered = new Set(CASES.map((c) => c.policy));
  for (const p of added) if (!covered.has(p)) fail(`policy ${p} has no allow/deny case`);
  for (const c of CASES) if (!added.includes(c.policy)) fail(`case for ${c.policy}, which no migration after the first creates`);

  for (const c of CASES) {
    const sql = `select count(*)::int as n from ${c.table} where ${c.where}`;
    const allow = await asUser(db, c.allow, sql);
    const deny = await asUser(db, c.deny, sql);
    const okAllow = allow !== 'error' && allow.n > 0;
    const okDeny = deny !== 'error' && deny.n === 0;
    if (okAllow && okDeny) console.log(`ok   ${c.policy}: ${c.allow} sees, ${c.deny} does not`);
    if (!okAllow) fail(`${c.policy} allow: ${c.allow} should see ${c.table} where ${c.where} (got ${JSON.stringify(allow)}${allow === 'error' ? `: ${lastError}` : ''})`);
    if (!okDeny) fail(`${c.policy} deny: ${c.deny} should not see ${c.table} where ${c.where} (got ${JSON.stringify(deny)})`);
  }
  for (const x of EXTRA) {
    const r = await asUser(db, x.as, x.sql);
    const ok = x.expect === 'error' ? r === 'error' : r !== 'error' && r.n === x.expect;
    if (ok) console.log(`ok   ${x.name}`);
    else fail(`${x.name} (got ${JSON.stringify(r)})`);
  }

  // The schema accepts the adverse-event states and refuses a payout that breaks the reconciliation line.
  const missed = await db.query<{ n: number }>(`select count(*)::int as n from installments where status in ('missed', 'waived')`);
  if (missed.rows[0]!.n !== 2) fail('installment_status does not hold missed and waived');
  else console.log('ok   installment_status holds missed and waived');
  const badPayout = await db
    .exec(`insert into payouts (id, plan_id, idx, seller_id, option, status, usd_paid, fee_usd, usd_to_seller) values ('bad', 'plan-roxana', 0, 'seller-cus', 'B', 'enviado', 750, 4.99, 750)`)
    .then(() => 'accepted', () => 'refused');
  if (badPayout !== 'refused') fail('a payout with usd_to_seller != usd_paid - fee_usd was accepted');
  else console.log('ok   payouts refuse a broken reconciliation line');

  // The corridors table mirrors config/corridors.ts for its cash-in settings.
  const mirrored = await db.query<{ id: keyof typeof CORRIDORS; moneygram: unknown }>(`select id, moneygram from corridors order by id`);
  // jsonb stores keys in its own order: compare with sorted keys.
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
  const drift = mirrored.rows.filter((r) => canon(r.moneygram) !== canon(CORRIDORS[r.id].moneyGram));
  if (mirrored.rows.length !== Object.keys(CORRIDORS).length || drift.length > 0) fail(`corridors.moneygram differs from config/corridors.ts for ${drift.map((r) => r.id).join(', ') || 'the row count'}`);
  else console.log('ok   corridors.moneygram matches config/corridors.ts');

  await db.close();
  const summary = `${files.length} migrations applied, ${added.length} new policies, ${CASES.length * 2 + EXTRA.length + 3} checks, ${failures} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
  if (failures > 0) {
    console.error(`check:db FAILED · ${summary}`);
    process.exit(1);
  }
  console.log(`check:db passed · ${summary}`);
}

main().catch((e: unknown) => {
  console.error(`check:db crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
