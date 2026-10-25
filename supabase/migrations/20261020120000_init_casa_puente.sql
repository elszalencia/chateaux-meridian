-- Casa Puente: initial schema (scope §10 data shape).
-- Stage 1 does not run against Supabase; the in-memory store mirrors these tables one-to-one so the
-- Supabase-backed Store can be dropped in without changing the API. Row-level security policies use
-- a `role` claim in the JWT (`buyer`, `builder`, `treasury`); a buyer's `auth.uid()` maps to buyers.auth_user_id.

create extension if not exists "pgcrypto";

create type anchor_auth_mode as enum ('g_account', 'sep45');
create type price_basis as enum ('SMMLV', 'fixed');
create type installment_status as enum ('open', 'locked', 'released', 'broken');
create type lock_tenor as enum ('mensual', 'trimestral');
create type lock_state as enum ('cotizado', 'activo', 'consumido', 'cerrado', 'vencido', 'roto');
create type hedge_leg_state as enum ('pendiente', 'reservada', 'liquidada', 'rota');
create type renewal_offer_state as enum ('ofrecido', 'aceptado', 'descartado');
create type rate_kind as enum ('locked', 'spot');

create table buyers (
  id text primary key,
  auth_user_id uuid unique,
  name text not null,
  email text not null unique,
  phone text,
  city text,
  state text,
  stellar_account text not null,
  anchor_auth_mode anchor_auth_mode not null default 'g_account',
  created_at timestamptz not null default now()
);

create table units (
  id text primary key,
  project text not null,
  unit_name text not null,
  unit_code text not null,
  address text,
  city text not null,
  department text,
  housing_type text not null,
  area_m2 numeric(8,2),
  bedrooms int,
  price_cop bigint not null,
  price_basis price_basis not null default 'SMMLV',
  unique (project, unit_code)
);

create table plans (
  id text primary key,
  buyer_id text not null references buyers(id),
  unit_id text not null references units(id),
  contract_id text,                      -- Soroban contract id, Stage 2
  encargo_ref text not null,
  trust_company text not null default 'Fidudavivienda',
  start_date date not null,
  installments_count int not null default 24,
  installment_cop bigint not null,
  down_payment_cop bigint not null,
  down_payment_pct numeric(5,2) not null default 30,
  mortgage_cop bigint not null,
  created_at timestamptz not null default now()
);

create table locks (
  id text primary key,
  plan_id text not null references plans(id),
  tenor lock_tenor not null,
  idxs int[] not null,
  spot numeric(12,4) not null,
  fwd_rates numeric(12,4)[] not null,
  avg_fwd numeric(12,4) not null,
  points numeric(12,4) not null,
  pass_through numeric(5,4) not null,
  locked_rate numeric(14,7) not null,
  usd_per_installment numeric(14,2)[] not null,
  quote_expires_at timestamptz,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  state lock_state not null default 'cotizado',
  broken_idx int,
  break_cost_cop bigint,
  curve_as_of date not null,
  check (array_length(idxs, 1) in (1, 3))
);

create table installments (
  plan_id text not null references plans(id),
  idx int not null,
  due_date date not null,
  cop_due bigint not null,
  status installment_status not null default 'open',
  lock_id text references locks(id),
  locked_rate numeric(14,7),
  usd_due numeric(14,2),
  lock_expiry date,
  released_tx text,
  released_at timestamptz,
  receipt_id text,
  break_cost_cop bigint,
  primary key (plan_id, idx)
);

create table renewal_offers (
  id text primary key,
  plan_id text not null references plans(id),
  tenor lock_tenor not null,
  idxs int[] not null,
  offered_at date not null,
  state renewal_offer_state not null default 'ofrecido'
);

create table hedge_trades (
  trade_id text primary key,
  provider text not null,
  due_date date not null,
  usd_notional numeric(16,7) not null,
  rate numeric(14,7) not null,
  banrep_ref text,
  booked_at timestamptz not null,
  settled_cop bigint,
  fixing numeric(12,4)
);

create table hedge_legs (
  id text primary key,
  lock_id text not null references locks(id),
  plan_id text not null references plans(id),
  installment_idx int not null,
  due_date date not null,
  usd_notional numeric(16,7) not null,
  locked_rate numeric(14,7) not null,
  fwd_rate numeric(14,7) not null,
  trade_id text references hedge_trades(trade_id),
  booked_at timestamptz,
  settled_cop bigint,
  fixing numeric(12,4),
  settled_at timestamptz,
  state hedge_leg_state not null default 'pendiente',
  foreign key (plan_id, installment_idx) references installments(plan_id, idx)
);

create table receipts (
  id text primary key,
  plan_id text not null references plans(id),
  buyer_id text not null references buyers(id),
  installment_idx int not null,
  paid_at timestamptz not null,
  usd_paid numeric(14,2) not null,
  rate_kind rate_kind not null,
  locked_rate numeric(14,7),
  spot_at_payment numeric(12,4) not null,
  anchor_rate numeric(12,4) not null,
  cop_delivered bigint not null,
  fee_usd numeric(10,2) not null default 0,
  fx_declaration_ref text,
  tx_hash text,
  lock_id text references locks(id),
  hedge_trade_id text references hedge_trades(trade_id),
  anchor_cop bigint not null,
  ndf_settlement_cop bigint,
  basis_cop bigint not null default 0,
  margin_cop bigint not null default 0,
  cop_credited bigint not null,
  break_cost_cop bigint not null default 0,
  foreign key (plan_id, installment_idx) references installments(plan_id, idx)
);

create table curves (
  id text primary key,
  as_of date not null,
  tenor text not null,
  date date not null,
  rate numeric(12,4) not null,
  source text,
  unique (as_of, tenor)
);

-- Indexer cursor and event log (Stage 3)
create table chain_events (
  id bigserial primary key,
  contract_id text not null,
  ledger bigint not null,
  tx_hash text not null,
  event_id text not null unique,
  type text not null,
  payload jsonb not null,
  indexed_at timestamptz not null default now()
);
create index chain_events_contract_ledger on chain_events (contract_id, ledger);

-- TTL keeper (Stage 3)
create table plan_ttl (
  plan_id text primary key references plans(id),
  live_until_ledger bigint not null,
  last_extended_at timestamptz
);

-- Demo clock and presentation settings (single row)
create table demo_state (
  id text primary key default 'singleton',
  base_date date not null,
  clock_offset_months int not null default 0,
  today date not null,
  pass_through numeric(5,4) not null default 0.5,
  error_mode boolean not null default false,
  mode text not null default 'mock',
  curve_as_of date not null,
  last_reset_ms numeric(10,1),
  seed_version text not null
);

-- ---------- Row-level security ----------
alter table buyers enable row level security;
alter table units enable row level security;
alter table plans enable row level security;
alter table installments enable row level security;
alter table locks enable row level security;
alter table renewal_offers enable row level security;
alter table hedge_legs enable row level security;
alter table hedge_trades enable row level security;
alter table receipts enable row level security;
alter table curves enable row level security;
alter table chain_events enable row level security;
alter table plan_ttl enable row level security;
alter table demo_state enable row level security;

create or replace function app_role() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
$$;

-- Buyers see only their own plans and everything hanging off them.
create policy buyer_self on buyers for select using (auth_user_id = auth.uid());
create policy buyer_plans on plans for select using (buyer_id in (select id from buyers where auth_user_id = auth.uid()));
create policy buyer_installments on installments for select using (plan_id in (select id from plans where buyer_id in (select id from buyers where auth_user_id = auth.uid())));
create policy buyer_locks on locks for select using (plan_id in (select id from plans where buyer_id in (select id from buyers where auth_user_id = auth.uid())));
create policy buyer_offers on renewal_offers for select using (plan_id in (select id from plans where buyer_id in (select id from buyers where auth_user_id = auth.uid())));
create policy buyer_receipts on receipts for select using (buyer_id in (select id from buyers where auth_user_id = auth.uid()));
create policy buyer_units on units for select using (id in (select unit_id from plans where buyer_id in (select id from buyers where auth_user_id = auth.uid())));

-- Builder role sees units, plans, installments and receipts of its projects (all projects in the demo).
create policy builder_units on units for select using (app_role() = 'builder');
create policy builder_plans on plans for select using (app_role() = 'builder');
create policy builder_buyers on buyers for select using (app_role() = 'builder');
create policy builder_installments on installments for select using (app_role() = 'builder');
create policy builder_receipts on receipts for select using (app_role() = 'builder');
create policy builder_locks on locks for select using (app_role() = 'builder');

-- Treasury role sees the hedge tables, curves and locks.
create policy treasury_legs on hedge_legs for select using (app_role() = 'treasury');
create policy treasury_trades on hedge_trades for select using (app_role() = 'treasury');
create policy treasury_curves on curves for select using (app_role() = 'treasury');
create policy treasury_locks on locks for select using (app_role() = 'treasury');
create policy treasury_plans on plans for select using (app_role() = 'treasury');
create policy treasury_buyers on buyers for select using (app_role() = 'treasury');

-- Everyone authenticated can read the curve in use and the demo clock.
create policy curves_read on curves for select using (auth.role() = 'authenticated');
create policy demo_state_read on demo_state for select using (auth.role() = 'authenticated');

-- Writes happen through the backend service role only (no insert/update policies for end users).
