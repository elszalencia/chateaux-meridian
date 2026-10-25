extern crate std;

use super::*;
use soroban_sdk::testutils::storage::Persistent;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, Events, IssuerFlags, Ledger, MockAuth, MockAuthInvoke,
};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::xdr::{ContractEventBody, ScVal};
use soroban_sdk::{map, symbol_short, Address, Env, IntoVal, Map, Symbol, TryFromVal, Val};

const DAY: u64 = 86_400;
const BASE_TS: u64 = 1_800_000_000; // 2027-01-15 00:53 UTC, rounded down below to a midnight
const COP_DUE: i128 = 4_093_125;
const PLAN: u32 = 1;
/// Quarterly locked rate from the shared vectors: 3444.4266666… × 1e7, half-up.
const RATE_Q: i128 = 34_444_266_667;

struct Fixture {
    env: Env,
    contract: Address,
    client: PaymentPlanClient<'static>,
    admin: Address,
    operator: Address,
    buyer: Address,
    payee: Address,
    usdc: Address,
}

fn midnight(ts: u64) -> u64 {
    ts - ts % DAY
}

fn due(i: u32) -> u64 {
    midnight(BASE_TS) + 30 * DAY * (i as u64 + 1)
}

fn schedule(env: &Env, n: u32) -> Vec<InstallmentInit> {
    let mut v = Vec::new(env);
    for i in 0..n {
        v.push_back(InstallmentInit {
            due_ts: due(i),
            cop_due: COP_DUE,
        });
    }
    v
}

fn setup() -> Fixture {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.timestamp = midnight(BASE_TS);
        li.sequence_number = 100_000;
        li.min_persistent_entry_ttl = 500;
        li.min_temp_entry_ttl = 100;
        li.max_entry_ttl = 6_312_000;
    });
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let buyer = Address::generate(&env);
    let payee = Address::generate(&env);
    // The test issuer carries the flags read live on Circle's USDC issuer (docs/STELLAR_NORMS.md,
    // 2026-10-22): auth_revocable set, clawback not enabled, so a balance can be frozen.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let usdc = sac.address();
    let contract = env.register(PaymentPlan, (&admin, &operator, &usdc, &payee));
    let client = PaymentPlanClient::new(&env, &contract);
    Fixture {
        env,
        contract,
        client,
        admin,
        operator,
        buyer,
        payee,
        usdc,
    }
}

fn fund(f: &Fixture, who: &Address, usd: i128) {
    f.env.mock_all_auths();
    StellarAssetClient::new(&f.env, &f.usdc).mint(who, &(usd * USD_SCALE));
}

fn balance(f: &Fixture, who: &Address) -> i128 {
    TokenClient::new(&f.env, &f.usdc).balance(who)
}

/// Topics and data of the last event this contract published.
fn last_event(f: &Fixture) -> (std::vec::Vec<Val>, Val) {
    let all = f.env.events().all();
    let mine = all.filter_by_contract(&f.contract);
    let ev = mine.events().last().expect("an event").clone();
    let ContractEventBody::V0(v0) = ev.body;
    let topics = v0
        .topics
        .iter()
        .map(|t: &ScVal| Val::try_from_val(&f.env, t).unwrap())
        .collect();
    let data = Val::try_from_val(&f.env, &v0.data).unwrap();
    (topics, data)
}

fn topic_symbol(f: &Fixture, v: &Val) -> Symbol {
    Symbol::try_from_val(&f.env, v).unwrap()
}

fn data_map(f: &Fixture, v: &Val) -> Map<Symbol, Val> {
    Map::try_from_val(&f.env, v).unwrap()
}

fn lock_id(f: &Fixture, n: u8) -> BytesN<32> {
    BytesN::from_array(&f.env, &[n; 32])
}

/// Test policy: two misses lead to default so the default path is short to reach.
fn policy() -> PolicyConfig {
    PolicyConfig {
        grace_days: 5,
        misses_before_default: 2,
        penalty_bps: 1_000,
        refund_mode: 0,
    }
}

fn evidence(f: &Fixture, n: u8) -> BytesN<32> {
    BytesN::from_array(&f.env, &[n; 32])
}

/// Funds conservation: the vault holds exactly the sum of the plan balances, and each plan's
/// totals satisfy deposited = released + refunded + balance.
fn assert_conserved(f: &Fixture, plan_ids: &[u32]) {
    let mut total: i128 = 0;
    for id in plan_ids {
        let st = f.client.get_status(id);
        let g = st.governance;
        assert_eq!(
            g.total_deposited,
            g.total_released + g.total_refunded + st.plan.balance_usdc,
            "totals of plan {id}"
        );
        total += st.plan.balance_usdc;
    }
    assert_eq!(balance(f, &f.contract), total, "vault balance");
}

fn created(f: &Fixture, n: u32) {
    f.env.mock_all_auths();
    f.client
        .create_plan(&PLAN, &f.buyer, &schedule(&f.env, n), &policy());
}

// ---------- plans and deposits ----------

#[test]
fn create_plan_stores_installments_and_emits_plan_created() {
    let f = setup();
    created(&f, 24);
    let (topics, data) = last_event(&f);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.plan.count, 24);
    assert_eq!(st.plan.buyer, f.buyer);
    assert_eq!(st.plan.balance_usdc, 0);
    assert_eq!(st.installments.len(), 24);
    let i3 = st.installments.get(3).unwrap();
    assert_eq!(i3.idx, 3);
    assert_eq!(i3.due_ts, due(3));
    assert_eq!(i3.status, Status::Open);
    assert_eq!(i3.lock_id, None);
    assert_eq!(
        topic_symbol(&f, &topics[0]),
        Symbol::new(&f.env, "plan_created")
    );
    assert_eq!(u32::try_from_val(&f.env, &topics[1]).unwrap(), PLAN);
    let m = data_map(&f, &data);
    assert_eq!(
        u32::try_from_val(&f.env, &m.get(symbol_short!("count")).unwrap()).unwrap(),
        24
    );
    assert_eq!(f.client.version(), CONTRACT_VERSION);
    assert_eq!(f.client.get_config().payee_backend, f.payee);
}

#[test]
fn create_plan_rejects_duplicates_bad_schedules_and_non_operator() {
    let f = setup();
    created(&f, 3);
    assert_eq!(
        f.client
            .try_create_plan(&PLAN, &f.buyer, &schedule(&f.env, 3), &policy()),
        Err(Ok(Error::PlanExists))
    );
    let mut bad = schedule(&f.env, 2);
    bad.set(
        1,
        InstallmentInit {
            due_ts: due(0),
            cop_due: COP_DUE,
        },
    ); // not ascending
    assert_eq!(
        f.client.try_create_plan(&2, &f.buyer, &bad, &policy()),
        Err(Ok(Error::InvalidSchedule))
    );
    assert_eq!(
        f.client
            .try_create_plan(&3, &f.buyer, &schedule(&f.env, 0), &policy()),
        Err(Ok(Error::InvalidSchedule))
    );
    assert_eq!(
        f.client.try_create_plan(
            &4,
            &f.buyer,
            &schedule(&f.env, MAX_INSTALLMENTS + 1),
            &policy()
        ),
        Err(Ok(Error::TooManyInstallments))
    );
    // Only the operator may create plans: the buyer's signature is not enough.
    f.env.mock_auths(&[MockAuth {
        address: &f.buyer,
        invoke: &MockAuthInvoke {
            contract: &f.contract,
            fn_name: "create_plan",
            args: (5u32, f.buyer.clone(), schedule(&f.env, 3), policy()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_create_plan(&5, &f.buyer, &schedule(&f.env, 3), &policy())
        .is_err());
}

#[test]
fn deposit_requires_the_buyer_and_moves_usdc_into_the_plan() {
    let f = setup();
    created(&f, 3);
    fund(&f, &f.buyer, 5_000);
    f.env.mock_all_auths();
    let amount = 118_833 * USD_SCALE / 100; // USD 1,188.33 in stroops
    let bal = f.client.deposit(&PLAN, &amount);
    let auths = f.env.auths();
    let (topics, data) = last_event(&f);
    assert_eq!(bal, amount);
    assert_eq!(balance(&f, &f.contract), amount);
    assert_eq!(balance(&f, &f.buyer), 5_000 * USD_SCALE - amount);
    // The recorded auth tree: the buyer authorized `deposit`, which carries the token transfer.
    let (who, inv) = &auths[0];
    assert_eq!(who, &f.buyer);
    match &inv.function {
        AuthorizedFunction::Contract((addr, name, _)) => {
            assert_eq!(addr, &f.contract);
            assert_eq!(name, &symbol_short!("deposit"));
        }
        _ => panic!("unexpected auth function"),
    }
    assert_eq!(inv.sub_invocations.len(), 1);
    assert_eq!(topic_symbol(&f, &topics[0]), symbol_short!("deposited"));
    let m = data_map(&f, &data);
    assert_eq!(
        i128::try_from_val(&f.env, &m.get(symbol_short!("amount")).unwrap()).unwrap(),
        amount
    );
    assert_eq!(
        i128::try_from_val(&f.env, &m.get(symbol_short!("balance")).unwrap()).unwrap(),
        amount
    );

    // Someone else signing for the buyer's plan is rejected by require_auth.
    let other = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &other,
        invoke: &MockAuthInvoke {
            contract: &f.contract,
            fn_name: "deposit",
            args: (PLAN, amount).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_deposit(&PLAN, &amount).is_err());
    assert_eq!(f.client.get_status(&PLAN).plan.balance_usdc, amount);
}

#[test]
fn deposit_rejects_bad_amounts_and_unknown_plans() {
    let f = setup();
    created(&f, 3);
    f.env.mock_all_auths();
    assert_eq!(
        f.client.try_deposit(&PLAN, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        f.client.try_deposit(&PLAN, &-5),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        f.client.try_deposit(&99, &100),
        Err(Ok(Error::PlanNotFound))
    );
}

#[test]
fn a_failed_usdc_transfer_is_a_typed_error_and_leaves_state_unchanged() {
    let f = setup();
    created(&f, 3);
    f.env.mock_all_auths();
    // The buyer holds no USDC, so the SAC refuses the transfer.
    assert_eq!(
        f.client.try_deposit(&PLAN, &(10 * USD_SCALE)),
        Err(Ok(Error::TransferFailed))
    );
    assert_eq!(f.client.get_status(&PLAN).plan.balance_usdc, 0);
    assert_eq!(balance(&f, &f.contract), 0);
}

// ---------- criterion 6: apply_lock validation ----------

#[test]
fn apply_lock_rejects_two_installments() {
    let f = setup();
    created(&f, 6);
    f.env.mock_all_auths();
    let idxs = Vec::from_array(&f.env, [1u32, 2]);
    assert_eq!(
        f.client
            .try_apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(2) + 8 * DAY)),
        Err(Ok(Error::InvalidLockSize))
    );
    let four = Vec::from_array(&f.env, [1u32, 2, 3, 4]);
    assert_eq!(
        f.client
            .try_apply_lock(&PLAN, &four, &lock_id(&f, 1), &RATE_Q, &(due(4) + 8 * DAY)),
        Err(Ok(Error::InvalidLockSize))
    );
}

#[test]
fn apply_lock_rejects_non_consecutive_installments() {
    let f = setup();
    created(&f, 6);
    f.env.mock_all_auths();
    let idxs = Vec::from_array(&f.env, [1u32, 3, 4]);
    assert_eq!(
        f.client
            .try_apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(4) + 8 * DAY)),
        Err(Ok(Error::NotConsecutive))
    );
    let desc = Vec::from_array(&f.env, [3u32, 2, 1]);
    assert_eq!(
        f.client
            .try_apply_lock(&PLAN, &desc, &lock_id(&f, 1), &RATE_Q, &(due(3) + 8 * DAY)),
        Err(Ok(Error::NotConsecutive))
    );
}

#[test]
fn apply_lock_rejects_any_installment_that_is_not_open() {
    let f = setup();
    created(&f, 6);
    f.env.mock_all_auths();
    let q = Vec::from_array(&f.env, [0u32, 1, 2]);
    f.client
        .apply_lock(&PLAN, &q, &lock_id(&f, 1), &RATE_Q, &(due(2) + 8 * DAY));
    // [2, 3, 4] overlaps the locked installment 2.
    let overlap = Vec::from_array(&f.env, [2u32, 3, 4]);
    assert_eq!(
        f.client.try_apply_lock(
            &PLAN,
            &overlap,
            &lock_id(&f, 2),
            &RATE_Q,
            &(due(4) + 8 * DAY)
        ),
        Err(Ok(Error::NotOpen))
    );
    // Nothing of the rejected lock was written.
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.get(3).unwrap().status, Status::Open);
    assert_eq!(st.installments.get(3).unwrap().lock_id, None);
    // A released installment is not open either.
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    f.client
        .release_spot(&PLAN, &5, &(119_601 * USD_SCALE / 100));
    let single = Vec::from_array(&f.env, [5u32]);
    assert_eq!(
        f.client.try_apply_lock(
            &PLAN,
            &single,
            &lock_id(&f, 3),
            &RATE_Q,
            &(due(5) + 8 * DAY)
        ),
        Err(Ok(Error::NotOpen))
    );
    assert_eq!(
        f.client
            .try_apply_lock(&PLAN, &single, &lock_id(&f, 3), &0, &(due(5) + 8 * DAY)),
        Err(Ok(Error::InvalidRate))
    );
}

// ---------- criterion 7: auth and release rules ----------

#[test]
fn apply_lock_needs_both_operator_and_buyer() {
    let f = setup();
    created(&f, 6);
    let idxs = Vec::from_array(&f.env, [3u32, 4, 5]);
    let lid = lock_id(&f, 7);
    let expiry = due(5) + 8 * DAY;
    let call = MockAuthInvoke {
        contract: &f.contract,
        fn_name: "apply_lock",
        args: (PLAN, idxs.clone(), lid.clone(), RATE_Q, expiry).into_val(&f.env),
        sub_invokes: &[],
    };
    let by_operator = MockAuth {
        address: &f.operator,
        invoke: &call,
    };
    let by_buyer = MockAuth {
        address: &f.buyer,
        invoke: &call,
    };
    // Operator alone: rejected when the buyer's auth is checked.
    f.env.mock_auths(core::slice::from_ref(&by_operator));
    assert!(f
        .client
        .try_apply_lock(&PLAN, &idxs, &lid, &RATE_Q, &expiry)
        .is_err());
    // Buyer alone: rejected at the operator check.
    f.env.mock_auths(core::slice::from_ref(&by_buyer));
    assert!(f
        .client
        .try_apply_lock(&PLAN, &idxs, &lid, &RATE_Q, &expiry)
        .is_err());
    // Both: accepted, three installments locked, event carries the lock id and rate.
    f.env.mock_auths(&[by_operator, by_buyer]);
    f.client.apply_lock(&PLAN, &idxs, &lid, &RATE_Q, &expiry);
    let (topics, data) = last_event(&f);
    let st = f.client.get_status(&PLAN);
    for i in 3..6 {
        let inst = st.installments.get(i).unwrap();
        assert_eq!(inst.status, Status::Locked);
        assert_eq!(inst.lock_id, Some(lid.clone()));
        assert_eq!(inst.locked_rate, Some(RATE_Q));
        assert_eq!(inst.lock_expiry_ts, Some(expiry));
        assert_eq!(inst.usd_due, Some(11_883_327_462));
    }
    assert_eq!(st.installments.get(2).unwrap().status, Status::Open);
    assert_eq!(
        topic_symbol(&f, &topics[0]),
        Symbol::new(&f.env, "lock_applied")
    );
    let m = data_map(&f, &data);
    assert_eq!(
        i128::try_from_val(&f.env, &m.get(Symbol::new(&f.env, "locked_rate")).unwrap()).unwrap(),
        RATE_Q
    );
}

#[test]
fn release_due_waits_for_the_due_date_pays_the_payee_once_and_only_for_the_operator() {
    let f = setup();
    created(&f, 6);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    let idxs = Vec::from_array(&f.env, [3u32, 4, 5]);
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(5) + 8 * DAY));

    // The day before the due date: nothing moves.
    f.env.ledger().with_mut(|li| li.timestamp = due(3) - DAY);
    assert_eq!(f.client.try_release_due(&PLAN, &3), Err(Ok(Error::NotDue)));
    assert_eq!(balance(&f, &f.payee), 0);

    // On the due date: usd_due goes to payee_backend and the installment is released.
    f.env.ledger().with_mut(|li| li.timestamp = due(3));
    let paid = f.client.release_due(&PLAN, &3);
    let (topics, data) = last_event(&f);
    assert_eq!(paid, 11_883_327_462);
    assert_eq!(balance(&f, &f.payee), 11_883_327_462);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.get(3).unwrap().status, Status::Released);
    assert_eq!(st.plan.balance_usdc, 5_000 * USD_SCALE - 11_883_327_462);
    assert_eq!(topic_symbol(&f, &topics[0]), symbol_short!("released"));
    assert_eq!(u32::try_from_val(&f.env, &topics[1]).unwrap(), PLAN);
    assert_eq!(u32::try_from_val(&f.env, &topics[2]).unwrap(), 3);
    let m = data_map(&f, &data);
    assert_eq!(
        Address::try_from_val(&f.env, &m.get(symbol_short!("to")).unwrap()).unwrap(),
        f.payee
    );
    assert!(!bool::try_from_val(&f.env, &m.get(symbol_short!("spot")).unwrap()).unwrap());

    // No double release.
    assert_eq!(
        f.client.try_release_due(&PLAN, &3),
        Err(Ok(Error::NotLocked))
    );
    assert_eq!(
        f.client.try_release_spot(&PLAN, &3, &1),
        Err(Ok(Error::NotReleasable))
    );
    assert_eq!(balance(&f, &f.payee), 11_883_327_462);

    // Only the operator releases: the buyer signing release_due is rejected.
    f.env.ledger().with_mut(|li| li.timestamp = due(4));
    f.env.mock_auths(&[MockAuth {
        address: &f.buyer,
        invoke: &MockAuthInvoke {
            contract: &f.contract,
            fn_name: "release_due",
            args: (PLAN, 4u32).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_release_due(&PLAN, &4).is_err());
    assert_eq!(
        f.client
            .get_status(&PLAN)
            .installments
            .get(4)
            .unwrap()
            .status,
        Status::Locked
    );
}

#[test]
fn release_spot_pays_open_installments_early_and_rejects_locked_ones() {
    let f = setup();
    created(&f, 6);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    let idxs = Vec::from_array(&f.env, [0u32]);
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(0) + 8 * DAY));
    assert_eq!(
        f.client
            .try_release_spot(&PLAN, &0, &(119_601 * USD_SCALE / 100)),
        Err(Ok(Error::NotReleasable))
    );
    // Paying ahead: installment 5 is months away and open.
    let usd = 119_601 * USD_SCALE / 100;
    assert_eq!(f.client.release_spot(&PLAN, &5, &usd), usd);
    let (_, data) = last_event(&f);
    assert_eq!(balance(&f, &f.payee), usd);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.get(5).unwrap().status, Status::Released);
    assert_eq!(st.installments.get(5).unwrap().lock_id, None);
    let m = data_map(&f, &data);
    assert!(bool::try_from_val(&f.env, &m.get(symbol_short!("spot")).unwrap()).unwrap());
    assert_eq!(
        f.client.try_release_spot(&PLAN, &4, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn release_fails_with_insufficient_balance_and_keeps_state() {
    let f = setup();
    created(&f, 3);
    fund(&f, &f.buyer, 10);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(10 * USD_SCALE));
    let idxs = Vec::from_array(&f.env, [0u32]);
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(0) + 8 * DAY));
    f.env.ledger().with_mut(|li| li.timestamp = due(0));
    assert_eq!(
        f.client.try_release_due(&PLAN, &0),
        Err(Ok(Error::InsufficientBalance))
    );
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.get(0).unwrap().status, Status::Locked);
    assert_eq!(st.plan.balance_usdc, 10 * USD_SCALE);
    assert_eq!(balance(&f, &f.payee), 0);
}

#[test]
fn break_lock_only_after_expiry_then_spot_release_is_possible() {
    let f = setup();
    created(&f, 6);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    let idxs = Vec::from_array(&f.env, [3u32, 4, 5]);
    let expiry = due(3) + 8 * DAY; // grace ends a week after the due date; expiry is the next day
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(&f, 9), &RATE_Q, &expiry);
    f.env.ledger().with_mut(|li| li.timestamp = expiry - 1);
    assert_eq!(
        f.client.try_break_lock(&PLAN, &3),
        Err(Ok(Error::LockNotExpired))
    );
    assert_eq!(
        f.client.try_break_lock(&PLAN, &0),
        Err(Ok(Error::NotLocked))
    );
    f.env.ledger().with_mut(|li| li.timestamp = expiry);
    f.client.break_lock(&PLAN, &3);
    let (topics, data) = last_event(&f);
    let st = f.client.get_status(&PLAN);
    let i3 = st.installments.get(3).unwrap();
    assert_eq!(i3.status, Status::Broken);
    assert_eq!(i3.lock_id, Some(lock_id(&f, 9))); // audit trail kept
    assert_eq!(st.installments.get(4).unwrap().status, Status::Locked);
    assert_eq!(
        topic_symbol(&f, &topics[0]),
        Symbol::new(&f.env, "lock_broken")
    );
    assert_eq!(u32::try_from_val(&f.env, &topics[2]).unwrap(), 3);
    let m = data_map(&f, &data);
    assert_eq!(
        BytesN::<32>::try_from_val(&f.env, &m.get(symbol_short!("lock_id")).unwrap()).unwrap(),
        lock_id(&f, 9)
    );
    // A broken installment is no longer releasable at the locked amount, only at spot.
    assert_eq!(
        f.client.try_release_due(&PLAN, &3),
        Err(Ok(Error::NotLocked))
    );
    let usd = 1_200 * USD_SCALE;
    f.client.release_spot(&PLAN, &3, &usd);
    assert_eq!(
        f.client
            .get_status(&PLAN)
            .installments
            .get(3)
            .unwrap()
            .status,
        Status::Released
    );
    // Only the operator breaks locks.
    f.env.mock_auths(&[MockAuth {
        address: &f.buyer,
        invoke: &MockAuthInvoke {
            contract: &f.contract,
            fn_name: "break_lock",
            args: (PLAN, 4u32).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_break_lock(&PLAN, &4).is_err());
}

// ---------- criterion 8: fixed-point math on the shared vectors ----------

#[derive(serde::Deserialize)]
struct Vectors {
    cases: std::vec::Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: std::string::String,
    locked_rate_fp: i64,
    cop_due: i64,
    usd_due_stroops: i64,
    cop_reconstructed: i64,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("../../test-vectors/lock_math.json")).expect("vectors parse")
}

#[test]
fn usd_due_matches_the_shared_lock_math_vectors() {
    let v = vectors();
    assert!(v.cases.len() >= 3);
    for c in &v.cases {
        let rate = c.locked_rate_fp as i128;
        let cop = c.cop_due as i128;
        let usd = usd_due_for(cop, rate).unwrap();
        assert_eq!(usd, c.usd_due_stroops as i128, "case {}", c.name);
        // usd_due × locked_rate reconstructs cop_due within one peso of floor rounding, and one
        // more stroop would overshoot: usd_due is the exact floor.
        let back = usd * rate / (RATE_SCALE * USD_SCALE);
        assert_eq!(back, c.cop_reconstructed as i128, "case {}", c.name);
        assert!(cop - back <= 1 && cop - back >= 0, "case {}", c.name);
        assert!(
            (usd + 1) * rate > cop * RATE_SCALE * USD_SCALE,
            "case {}",
            c.name
        );
    }
}

#[test]
fn usd_due_on_chain_equals_the_vector_through_apply_lock() {
    let v = vectors();
    let f = setup();
    created(&f, 6);
    f.env.mock_all_auths();
    for (k, c) in v.cases.iter().enumerate() {
        let idxs = Vec::from_array(&f.env, [k as u32]);
        f.client.apply_lock(
            &PLAN,
            &idxs,
            &lock_id(&f, k as u8 + 1),
            &(c.locked_rate_fp as i128),
            &(due(k as u32) + 8 * DAY),
        );
        let inst = f.client.get_installment(&PLAN, &(k as u32));
        assert_eq!(
            inst.usd_due,
            Some(c.usd_due_stroops as i128),
            "case {}",
            c.name
        );
        assert_eq!(inst.cop_due, c.cop_due as i128);
    }
}

#[test]
fn usd_due_rejects_bad_inputs_and_overflow() {
    assert_eq!(usd_due_for(COP_DUE, 0), Err(Error::InvalidRate));
    assert_eq!(usd_due_for(COP_DUE, -1), Err(Error::InvalidRate));
    assert_eq!(usd_due_for(0, RATE_Q), Err(Error::InvalidAmount));
    assert_eq!(usd_due_for(i128::MAX / 2, RATE_Q), Err(Error::Overflow));
}

// ---------- criterion 9: TTL ----------

fn plan_ttl(f: &Fixture, plan_id: u32) -> u32 {
    f.env.as_contract(&f.contract, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Plan(plan_id))
    })
}

fn inst_ttl(f: &Fixture, plan_id: u32, idx: u32) -> u32 {
    f.env.as_contract(&f.contract, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Inst(plan_id, idx))
    })
}

#[test]
fn extend_ttl_keeps_the_plan_readable_past_the_default_ttl() {
    let f = setup();
    created(&f, 24);
    // Written entries are bumped straight to TTL_EXTEND_TO (bump-on-access).
    assert_eq!(plan_ttl(&f, PLAN), TTL_EXTEND_TO);
    assert_eq!(inst_ttl(&f, PLAN, 23), TTL_EXTEND_TO);

    // Let most of that life elapse: below the threshold, but still alive.
    let elapsed = TTL_EXTEND_TO - 1_000;
    f.env.ledger().with_mut(|li| li.sequence_number += elapsed);
    assert_eq!(plan_ttl(&f, PLAN), 1_000);

    // The keeper (anyone) extends everything back to the full window.
    assert_eq!(f.client.extend_ttl(&PLAN), 24);
    assert_eq!(plan_ttl(&f, PLAN), TTL_EXTEND_TO);
    assert_eq!(inst_ttl(&f, PLAN, 0), TTL_EXTEND_TO);
    assert_eq!(inst_ttl(&f, PLAN, 23), TTL_EXTEND_TO);

    // Well past the point where the original TTL (and the network's default) would have expired,
    // the plan is still readable.
    f.env
        .ledger()
        .with_mut(|li| li.sequence_number += TTL_EXTEND_TO - 10);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.len(), 24);
    // Reading bumps again.
    assert_eq!(plan_ttl(&f, PLAN), TTL_EXTEND_TO);
}

#[test]
fn without_extension_the_ttl_runs_down_to_the_archive_point() {
    let f = setup();
    created(&f, 3);
    assert_eq!(plan_ttl(&f, PLAN), TTL_EXTEND_TO);
    assert_eq!(inst_ttl(&f, PLAN, 2), TTL_EXTEND_TO);
    // Nobody touches the plan: one ledger before archival the entries have a single ledger left.
    // (Since protocol 23 an archived persistent entry is restored automatically when a
    // transaction's footprint includes it, at the restorer's cost; the keeper exists to avoid
    // paying that on every dormant plan.)
    f.env
        .ledger()
        .with_mut(|li| li.sequence_number += TTL_EXTEND_TO - 1);
    assert_eq!(plan_ttl(&f, PLAN), 1);
    assert_eq!(inst_ttl(&f, PLAN, 2), 1);
    // Any read bumps it back to the full window.
    f.client.extend_ttl(&PLAN);
    assert_eq!(plan_ttl(&f, PLAN), TTL_EXTEND_TO);
}

// ---------- upgrade and migrate ----------

#[test]
fn upgrade_and_migrate_are_admin_only_and_migrate_is_idempotent() {
    let f = setup();
    f.env.mock_all_auths();
    assert_eq!(f.client.migrate(), CONTRACT_VERSION);
    assert_eq!(f.client.migrate(), CONTRACT_VERSION);
    assert_eq!(f.client.version(), CONTRACT_VERSION);
    let hash = BytesN::from_array(&f.env, &[0xABu8; 32]);
    // The operator is not the admin.
    f.env.mock_auths(&[MockAuth {
        address: &f.operator,
        invoke: &MockAuthInvoke {
            contract: &f.contract,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_upgrade(&hash).is_err());
    f.env.mock_auths(&[MockAuth {
        address: &f.operator,
        invoke: &MockAuthInvoke {
            contract: &f.contract,
            fn_name: "migrate",
            args: ().into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_migrate().is_err());
    // Sanity: the admin recorded by the constructor is the one that was passed.
    assert_eq!(f.client.get_config().admin, f.admin);
    let _unused: Map<Symbol, Val> = map![&f.env];
}

#[path = "test_adverse.rs"]
mod adverse;

#[path = "test_frozen.rs"]
mod frozen;
