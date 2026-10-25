-- Chateaux: row-level security for the corridor tables (ES brief §10).
--   Buyers see their own plans and what hangs off them (payments, payouts, messages, governance).
--   Cashiers see the buyers of their office (and those buyers' plans) and the payments they took.
--   Back office sees the plans of its sellers (staff_sellers) and everything about those plans.
--   Treasury (Colombia only) is unchanged: its policies are in the initial migration.
-- Every scope lookup goes through a security-definer function: the initial migration's buyer
-- policies on plans read buyers, so a policy on buyers that read plans directly would recurse. Writes stay with the backend service role (no insert/update policies).

-- ---------- Scope helpers ----------
create or replace function current_staff_id() returns text
  language sql stable security definer set search_path = public as $$
  select id from staff where auth_user_id = auth.uid()
$$;

create or replace function current_office_id() returns text
  language sql stable security definer set search_path = public as $$
  select office_id from staff where auth_user_id = auth.uid() and role = 'cashier'
$$;

create or replace function my_buyer_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select id from buyers where auth_user_id = auth.uid()
$$;

create or replace function my_plan_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select p.id from plans p join buyers b on b.id = p.buyer_id where b.auth_user_id = auth.uid()
$$;

create or replace function office_buyer_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select b.id from buyers b
  join staff s on s.office_id = b.office_id
  where s.auth_user_id = auth.uid() and s.role = 'cashier'
$$;

create or replace function office_plan_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select p.id from plans p where p.buyer_id in (select office_buyer_ids())
$$;

create or replace function my_seller_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select ss.seller_id from staff_sellers ss
  join staff s on s.id = ss.staff_id
  where s.auth_user_id = auth.uid() and s.role = 'back_office'
$$;

create or replace function seller_plan_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select p.id from plans p where p.seller_id in (select my_seller_ids())
$$;

create or replace function my_plan_seller_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select p.seller_id from plans p where p.id in (select my_plan_ids()) and p.seller_id is not null
$$;

create or replace function seller_buyer_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select p.buyer_id from plans p where p.id in (select seller_plan_ids())
$$;

create or replace function seller_unit_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select su.unit_id from seller_units su where su.seller_id in (select my_seller_ids())
$$;

create or replace function cashier_receipt_ids() returns setof text
  language sql stable security definer set search_path = public as $$
  select pm.receipt_id from payments pm where pm.cashier_id = current_staff_id() and pm.receipt_id is not null
$$;

revoke all on function current_staff_id(), current_office_id(), my_buyer_ids(), my_plan_ids(),
  office_buyer_ids(), office_plan_ids(), my_seller_ids(), seller_plan_ids(), my_plan_seller_ids(),
  seller_buyer_ids(), seller_unit_ids(), cashier_receipt_ids() from public;
grant execute on function current_staff_id(), current_office_id(), my_buyer_ids(), my_plan_ids(),
  office_buyer_ids(), office_plan_ids(), my_seller_ids(), seller_plan_ids(), my_plan_seller_ids(),
  seller_buyer_ids(), seller_unit_ids(), cashier_receipt_ids() to authenticated;

-- ---------- Enable RLS on every new table ----------
alter table corridors enable row level security;
alter table offices enable row level security;
alter table staff enable row level security;
alter table staff_sellers enable row level security;
alter table sellers enable row level security;
alter table seller_units enable row level security;
alter table plan_governance enable row level security;
alter table policy_events enable row level security;
alter table payments enable row level security;
alter table payouts enable row level security;
alter table wa_outbox enable row level security;

-- ---------- Reference data every signed-in user reads ----------
create policy corridors_read on corridors for select using (auth.uid() is not null);
create policy offices_read on offices for select using (auth.uid() is not null);
create policy staff_self on staff for select using (auth_user_id = auth.uid());
create policy staff_sellers_self on staff_sellers for select using (staff_id = current_staff_id());

-- ---------- Buyers ----------
create policy buyer_payments on payments for select using (plan_id in (select my_plan_ids()));
create policy buyer_payouts on payouts for select using (plan_id in (select my_plan_ids()));
create policy buyer_outbox on wa_outbox for select using (buyer_id in (select my_buyer_ids()));
create policy buyer_governance on plan_governance for select using (plan_id in (select my_plan_ids()));
create policy buyer_sellers on sellers for select using (id in (select my_plan_seller_ids()));

-- ---------- Cashiers: their office's buyers, and the payments they took ----------
create policy cashier_buyers on buyers for select using (office_id is not null and office_id = current_office_id());
create policy cashier_plans on plans for select using (id in (select office_plan_ids()));
create policy cashier_installments on installments for select using (plan_id in (select office_plan_ids()));
create policy cashier_governance on plan_governance for select using (plan_id in (select office_plan_ids()));
create policy cashier_payments on payments for select using (cashier_id = current_staff_id());
create policy cashier_receipts on receipts for select using (id in (select cashier_receipt_ids()));

-- ---------- Back office: its sellers and their plans ----------
create policy back_office_sellers on sellers for select using (id in (select my_seller_ids()));
create policy back_office_seller_units on seller_units for select using (seller_id in (select my_seller_ids()));
create policy back_office_units on units for select using (id in (select seller_unit_ids()));
create policy back_office_plans on plans for select using (id in (select seller_plan_ids()));
create policy back_office_buyers on buyers for select using (id in (select seller_buyer_ids()));
create policy back_office_installments on installments for select using (plan_id in (select seller_plan_ids()));
create policy back_office_receipts on receipts for select using (plan_id in (select seller_plan_ids()));
create policy back_office_payments on payments for select using (plan_id in (select seller_plan_ids()));
create policy back_office_payouts on payouts for select using (seller_id in (select my_seller_ids()));
create policy back_office_outbox on wa_outbox for select using (plan_id in (select seller_plan_ids()));
create policy back_office_governance on plan_governance for select using (plan_id in (select seller_plan_ids()));
create policy back_office_policy_events on policy_events for select using (plan_id in (select seller_plan_ids()));
