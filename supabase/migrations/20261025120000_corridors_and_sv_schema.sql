-- Chateaux: corridors, the El Salvador tables and the adverse-event schema (ES brief §6.1, §10).
-- The in-memory store (services/src/store) mirrors these tables one-to-one. Amount columns keep their
-- historical names (installment_cop, cop_due, ...) and hold the corridor's minor unit: whole pesos in
-- Colombia (decimals 0), US cents in El Salvador (decimals 2). Columns that only mean something in
-- the COP corridor become nullable. Row-level security for every table added here is in the next
-- migration (20261025120100_sv_rls.sql).

-- ---------- Corridors (config/corridors.ts is the source; this table mirrors it for SQL readers) ----------
create table corridors (
  id text primary key check (id in ('co', 'sv')),
  country char(2) not null,
  name_key text not null,
  currency char(3) not null,
  decimals smallint not null check (decimals in (0, 2)),
  locks_enabled boolean not null,
  hedge_enabled boolean not null,
  holiday_calendar char(2) not null,
  grace_business_days smallint not null check (grace_business_days >= 0),
  pay_window_days smallint not null default 0,
  pay_methods text[] not null,
  fees_usd jsonb not null,
  payout_providers text[] not null,
  payout_target_key text not null,
  receipt_fields text[] not null,
  pay_steps text[] not null,
  views jsonb not null,
  whatsapp_templates text[] not null,
  reminder_days_before smallint not null,
  moneygram jsonb,                        -- null where the corridor has no cash-in network
  payout_partner text not null,
  cash_network text,
  check (pay_methods <@ array['moneygram_cash', 'office_counter', 'ach']),
  check (payout_providers <@ array['sep31-receiver', 'usdc-hold', 'usd-bank-payout'])
);

insert into corridors values
  ('co', 'CO', 'corridors.co.name', 'COP', 0, true, true, 'CO', 5, 0,
   array['office_counter', 'ach'], '{"moneygram_cash": 0, "office_counter": 0, "ach": 0}',
   array['sep31-receiver'], 'corridors.co.payoutTarget',
   array['usdPaid', 'lockedRate', 'todayRate', 'usdAtToday', 'copDelivered', 'fee', 'fxDeclarationRef'],
   array['recibido', 'convertido', 'entregado'],
   '{"comprador": true, "oficina": true, "constructora": true, "tesoreria": true, "lock": true, "payAhead": true, "propertyVerification": false}',
   array['recordatorio', 'pago_recibido', 'pago_entregado', 'pago_atrasado', 'plan_en_pausa', 'renovacion_bloqueo'],
   5, null, 'Fidudavivienda', null),
  ('sv', 'SV', 'corridors.sv.name', 'USD', 2, false, false, 'SV', 5, 5,
   array['moneygram_cash', 'office_counter', 'ach'], '{"moneygram_cash": 4.99, "office_counter": 0, "ach": 1.5}',
   array['usdc-hold', 'usd-bank-payout'], 'corridors.sv.payoutTarget',
   array['usdPaid', 'fee', 'usdDelivered', 'payoutStatus', 'method', 'seller', 'unit'],
   array['recibido', 'entregado'],
   '{"comprador": true, "oficina": true, "constructora": false, "tesoreria": false, "lock": false, "payAhead": false, "propertyVerification": true}',
   array['recordatorio', 'referencia_moneygram', 'pago_recibido', 'pago_entregado', 'pago_atrasado', 'plan_en_pausa'],
   5, '{"minUsd": 5, "maxUsd": 950, "excludedStates": ["AK", "HI", "LA", "NY"], "referenceTtlMinutes": 60, "pendingAlertMinutes": 10}',
   'Davivienda Salvadoreño', 'MoneyGram');

-- ---------- Offices and staff ----------
create table offices (
  id text primary key,
  corridor text not null references corridors(id),
  name text not null,
  address text not null,
  city text,
  state text,
  hours text not null,
  phone text,
  is_licensed_agency boolean not null default false,
  simulated boolean not null default true
);

-- Office and back-office users. A cashier belongs to one office; a back-office user works for the
-- sellers listed in staff_sellers. `id` is what payments.cashier_id records.
create type staff_role as enum ('cashier', 'back_office');

create table staff (
  id text primary key,
  auth_user_id uuid unique,
  role staff_role not null,
  office_id text references offices(id),
  display_name text not null,
  check (role <> 'cashier' or office_id is not null)
);

-- ---------- Sellers ----------
create type seller_verification as enum ('pending', 'verified', 'paused', 'rejected');
create type payout_option as enum ('A', 'B');
create type cnr_alert_status as enum ('none', 'lien_registered', 'cleared');

create table sellers (
  id text primary key,
  corridor text not null references corridors(id),
  tier smallint not null check (tier in (1, 2)),
  legal_name text not null,
  trade_name text not null,
  tax_id text not null,
  legal_representative text not null,
  bank text not null,
  verification_status seller_verification not null default 'pending',
  verified_at timestamptz,
  payout_option payout_option not null,
  payout_account jsonb,                   -- {kind, institution, holder, ref}; null until verified
  pending_payout_account jsonb,
  payout_change_pending_until timestamptz, -- 72 h cooling-off after an account change
  kyb_ref text,
  releases_count int not null default 0,
  notes text,
  simulated boolean not null default true,
  check (verification_status <> 'verified' or payout_account is not null),
  check ((pending_payout_account is null) = (payout_change_pending_until is null))
);

create table staff_sellers (
  staff_id text not null references staff(id) on delete cascade,
  seller_id text not null references sellers(id) on delete cascade,
  primary key (staff_id, seller_id)
);

create table seller_units (
  id text primary key,
  seller_id text not null references sellers(id),
  unit_id text not null references units(id),
  cnr_registry_no text not null,
  cnr_cert_date date not null,
  cnr_cert_hash char(64) not null check (cnr_cert_hash ~ '^[0-9a-f]{64}$'),
  alert_status cnr_alert_status not null default 'none',
  alert_at timestamptz,
  alert_detail text,
  unique (seller_id, unit_id)
);

-- ---------- Buyers, units and plans gain the corridor ----------
alter table buyers
  add column lang text not null default 'es' check (lang in ('es', 'en')),
  add column office_id text references offices(id);

alter table units
  add column corridor text not null default 'co' references corridors(id),
  alter column price_basis drop not null;
-- price_cop holds the corridor's minor unit (cents in El Salvador); it stays required.

alter table plans
  add column corridor text not null default 'co' references corridors(id),
  add column seller_id text references sellers(id),
  add column payout_option payout_option,
  alter column installment_cop drop not null,
  alter column down_payment_cop drop not null,
  alter column mortgage_cop drop not null,
  alter column trust_company drop not null,
  alter column trust_company drop default;
create index plans_corridor on plans (corridor);
create index plans_seller on plans (seller_id);

-- ---------- Installments: adverse-event states and early funding ----------
alter type installment_status add value if not exists 'missed';
alter type installment_status add value if not exists 'waived';

alter table installments
  add column funded_at timestamptz,
  add column funded_payment_id text;
-- cop_due keeps its name and holds cents in El Salvador (ES brief §8: do not rename it).

-- Receipts: the conversion columns exist only where there is a conversion (Colombia).
alter table receipts
  alter column spot_at_payment drop not null,
  alter column anchor_rate drop not null,
  alter column anchor_cop drop not null,
  alter column cop_credited drop not null;

-- ---------- Plan governance and policy events (contract schema version 2) ----------
create type plan_state as enum ('active', 'delinquent', 'defaulted', 'on_hold', 'cancelled', 'completed');
create type policy_event_kind as enum (
  'late_in_grace', 'mark_missed', 'cure', 'waive', 'default_eligible', 'declare_default',
  'place_hold', 'lift_hold', 'hold_frozen', 'cancel_plan', 'refund', 'complete_plan', 'action_failed'
);

create table plan_governance (
  id text primary key,                    -- = plan_id
  plan_id text not null unique references plans(id),
  state plan_state not null default 'active',
  hold_prev plan_state not null default 'active',
  misses int not null default 0 check (misses >= 0),
  grace_days int not null default 5,
  misses_before_default int not null default 3,
  penalty_bps int not null default 1000 check (penalty_bps between 0 and 10000),
  refund_mode text not null default 'full' check (refund_mode in ('full', 'net_of_penalty')),
  reason_code int,
  since date,
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  check (id = plan_id)
);

create table policy_events (
  id text primary key,
  seq bigint not null,
  plan_id text not null references plans(id),
  at date not null,
  kind policy_event_kind not null,
  idx int,
  from_state plan_state not null,
  to_state plan_state not null,
  reason_code int not null,
  rule text not null,
  policy_status text not null default 'pending' check (policy_status = 'pending'),
  executed boolean not null,
  evidence char(64) not null check (evidence ~ '^[0-9a-f]{64}$'),
  amount_cents bigint,
  ref text,
  detail text
);
create index policy_events_plan on policy_events (plan_id, seq);

-- ---------- Payments, payouts and the message outbox ----------
create type pay_method as enum ('moneygram_cash', 'office_counter', 'ach');
create type payment_status as enum ('pending', 'completed', 'quote_expired', 'blocked', 'error', 'cancelled');
create type payout_status as enum ('enviado', 'en_transito', 'acreditado', 'error', 'transferido', 'retenido');

create table payments (
  id text primary key,
  plan_id text not null references plans(id),
  idx int not null,
  method pay_method not null,
  amount bigint not null check (amount >= 0),
  fee bigint not null default 0 check (fee >= 0),
  status payment_status not null,
  external_ref text,
  office_id text references offices(id),
  cashier_id text references staff(id),
  tender text check (tender in ('cash', 'card')),
  amount_received bigint,
  change_due bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  received_at timestamptz,
  blocked_reason text check (blocked_reason in ('above_limit', 'below_limit', 'state_excluded', 'method_not_offered', 'plan_blocked')),
  receipt_id text references receipts(id),
  foreign key (plan_id, idx) references installments(plan_id, idx),
  check (status <> 'completed' or received_at is not null),
  check (method <> 'office_counter' or office_id is not null)
);
create index payments_plan on payments (plan_id, idx);
create index payments_cashier on payments (cashier_id, received_at);

create table payouts (
  id text primary key,
  plan_id text not null references plans(id),
  idx int not null,
  receipt_id text references receipts(id),  -- the release this payout pays out
  seller_id text not null references sellers(id),
  option payout_option not null,
  status payout_status not null,
  usd_paid numeric(14,2) not null,
  fee_usd numeric(10,2) not null default 0,
  usd_to_seller numeric(14,2) not null,
  partner_ref text,
  release_tx text,
  sent_at timestamptz,
  expected_credit_date date,
  credited_at timestamptz,
  error_detail text,
  hold_reason text check (hold_reason in ('seller_unverified', 'seller_paused', 'seller_rejected', 'seller_cooling_off', 'cnr_alert')),
  foreign key (plan_id, idx) references installments(plan_id, idx),
  check (usd_to_seller = usd_paid - fee_usd),  -- the reconciliation line
  check (option <> 'A' or status in ('transferido', 'retenido', 'error')),
  check (option <> 'B' or status in ('enviado', 'en_transito', 'acreditado', 'error', 'retenido'))
);
create index payouts_seller on payouts (seller_id);

create table wa_outbox (
  id text primary key,
  plan_id text not null references plans(id),
  buyer_id text not null references buyers(id),
  to_phone text not null check (to_phone ~ '^\+[0-9]{8,15}$'),
  template text not null,
  locale text not null check (locale in ('es', 'en')),
  params jsonb not null default '{}',
  body text not null check (char_length(body) <= 1024),
  link text not null,
  created_at timestamptz not null default now(),
  channel text not null default 'whatsapp' check (channel = 'whatsapp'),
  simulated boolean not null default true
);
create index wa_outbox_plan on wa_outbox (plan_id, created_at);

-- ---------- Demo state: the second instance and simulated plans ----------
alter table demo_state
  add column chain_plans jsonb,
  add column chain_contract_id text,
  add column chain_contract_ids jsonb,
  add column simulated_plans jsonb;
