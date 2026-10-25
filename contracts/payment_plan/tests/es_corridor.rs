//! El Salvador corridor probes, ported from the read-only scoping pass of 2026-10-25
//! (_reference/casa-puente/session-reports/es-scope-probe.rs). The scope ran them against the Wasm
//! fetched from testnet (`CAVPFFH4…CCTXP`, sha256 `a28d240c…`) through `contractimport!`; here they
//! run against the crate as built from source, so they do not touch the Wasm and need no upload.
//!
//! What they prove: a USD plan (cents stored in the field still named `cop_due`, released only
//! with `release_spot` at cents × 100,000 stroops) runs end to end on the deployed contract
//! surface; `release_spot` does not check the amount against the stored due; `usd_due` stays empty
//! after a spot release; the adverse paths are currency-agnostic; `apply_lock` is not blocked and
//! its rate scale is COP-specific; and nothing on chain names the corridor. The services enforce
//! what the contract does not (config/corridors.ts, `assertLocksEnabled`, exact cents → stroops).
//!
//! One test differs from the deployed Wasm on purpose: the local source answers a frozen vault
//! with the typed `AssetFrozen` and offers `hold_frozen`, while the deployed `a28d240c…` answers
//! `TransferFailed` and needs a manual `place_hold` (see that test's doc comment).

use payment_plan::{
    Error, InstallmentInit, PaymentPlan, PaymentPlanClient, PlanState, PolicyConfig, Status,
    REASON_FUNDS_FROZEN,
};
use soroban_sdk::testutils::{Address as _, Events, IssuerFlags, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::xdr::{ContractEventBody, ScSymbol, ScVal};
use soroban_sdk::{vec, Address, BytesN, Env, Vec};

const DAY: u64 = 86_400;
/// USD cents → USDC stroops (7 decimals): exact, no rounding.
const STROOPS_PER_CENT: i128 = 100_000;
const PLAN: u32 = 9_001;
const T0: u64 = 1_793_491_200; // 2026-10-31 00:00 UTC

struct F {
    env: Env,
    c: PaymentPlanClient<'static>,
    id: Address,
    usdc: Address,
    buyer: Address,
    payee: Address,
}

fn setup() -> F {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = T0);
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let payee = Address::generate(&env);
    let buyer = Address::generate(&env);
    // The test issuer carries the flags read live on Circle's USDC issuer: auth_revocable set.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let usdc = sac.address();
    let id = env.register(PaymentPlan, (&admin, &operator, &usdc, &payee));
    let c = PaymentPlanClient::new(&env, &id);
    F {
        env,
        c,
        id,
        usdc,
        buyer,
        payee,
    }
}

fn policy() -> PolicyConfig {
    PolicyConfig {
        grace_days: 5,
        misses_before_default: 3,
        penalty_bps: 0,
        refund_mode: 0,
    }
}

/// Three monthly installments of USD 450.00, stored as cents in the `cop_due` field.
fn es_plan(f: &F) -> Vec<i128> {
    let cents: Vec<i128> = vec![&f.env, 45_000, 45_000, 45_000];
    let mut inits = Vec::new(&f.env);
    for (i, c) in cents.iter().enumerate() {
        inits.push_back(InstallmentInit {
            cop_due: c,
            due_ts: T0 + (i as u64 + 1) * 30 * DAY,
        });
    }
    f.env.mock_all_auths();
    f.c.create_plan(&PLAN, &f.buyer, &inits, &policy());
    StellarAssetClient::new(&f.env, &f.usdc).mint(&f.buyer, &(200_000 * STROOPS_PER_CENT));
    cents
}

fn ev(f: &F, n: u8) -> BytesN<32> {
    BytesN::from_array(&f.env, &[n; 32])
}

fn bal(f: &F, a: &Address) -> i128 {
    TokenClient::new(&f.env, &f.usdc).balance(a)
}

/// First topic (the event name) of every event this contract emitted in the last call.
fn event_names(f: &F) -> std::vec::Vec<String> {
    f.env
        .events()
        .all()
        .filter_by_contract(&f.id)
        .events()
        .iter()
        .map(|e| match &e.body {
            ContractEventBody::V0(b) => match b.topics.first() {
                Some(ScVal::Symbol(ScSymbol(s))) => s.to_utf8_string_lossy(),
                _ => String::new(),
            },
        })
        .collect()
}

#[test]
fn es_plan_runs_end_to_end_on_release_spot_only() {
    let f = setup();
    let cents = es_plan(&f);
    let total: i128 = cents.iter().map(|c| c * STROOPS_PER_CENT).sum();
    f.c.deposit(&PLAN, &total);
    assert_eq!(event_names(&f), ["deposited"]);
    for (idx, c) in cents.iter().enumerate() {
        f.env
            .ledger()
            .with_mut(|l| l.timestamp = T0 + (idx as u64 + 1) * 30 * DAY);
        f.c.release_spot(&PLAN, &(idx as u32), &(c * STROOPS_PER_CENT));
        assert_eq!(event_names(&f), ["released"]);
    }
    let st = f.c.get_status(&PLAN);
    for i in st.installments.iter() {
        assert_eq!(i.status, Status::Released);
        assert_eq!(i.cop_due, 45_000); // cents, under a field named cop_due
        assert_eq!(i.locked_rate, None);
        assert_eq!(i.usd_due, None); // a spot release records the amount only in the event
    }
    assert_eq!(st.governance.total_released, total);
    assert_eq!(bal(&f, &f.payee), total);
    f.c.complete_plan(&PLAN, &500, &ev(&f, 1));
    assert_eq!(f.c.get_governance(&PLAN).state, PlanState::Completed);
}

#[test]
fn release_spot_does_not_check_the_amount_against_the_stored_due() {
    let f = setup();
    es_plan(&f);
    f.c.deposit(&PLAN, &(100_000 * STROOPS_PER_CENT));
    // USD 450.00 due; the contract accepts USD 1.00 or USD 900.00 alike.
    f.c.release_spot(&PLAN, &0, &STROOPS_PER_CENT);
    f.c.release_spot(&PLAN, &1, &(90_000 * STROOPS_PER_CENT));
    assert_eq!(f.c.get_installment(&PLAN, &0).status, Status::Released);
    assert_eq!(f.c.get_installment(&PLAN, &1).status, Status::Released);
}

#[test]
fn adverse_paths_are_currency_agnostic() {
    let f = setup();
    let cents = es_plan(&f);
    f.c.deposit(&PLAN, &(45_000 * STROOPS_PER_CENT));
    // M1 unpaid 5 calendar days after due → missed, plan delinquent; cure → open → spot release.
    f.env
        .ledger()
        .with_mut(|l| l.timestamp = T0 + 30 * DAY + 5 * DAY);
    f.c.mark_missed(&PLAN, &0, &100, &ev(&f, 2));
    assert_eq!(f.c.get_governance(&PLAN).state, PlanState::Delinquent);
    f.c.cure(&PLAN, &0, &101, &ev(&f, 3));
    assert_eq!(f.c.get_governance(&PLAN).state, PlanState::Active);
    f.c.release_spot(&PLAN, &0, &(cents.get(0).unwrap() * STROOPS_PER_CENT));
    // Withdrawal: cancel and refund the held balance to the buyer only.
    f.c.deposit(&PLAN, &(20_000 * STROOPS_PER_CENT));
    f.c.cancel_plan(&PLAN, &200, &ev(&f, 4));
    let before = bal(&f, &f.buyer);
    f.c.refund(&PLAN, &(20_000 * STROOPS_PER_CENT), &400, &ev(&f, 5));
    assert_eq!(bal(&f, &f.buyer) - before, 20_000 * STROOPS_PER_CENT);
    assert_eq!(f.c.get_governance(&PLAN).state, PlanState::Cancelled);
}

/// Adapted to the LOCAL source. The deployed Wasm `a28d240c…` (the one the scope report probed,
/// and the one both testnet instances run) has no `AssetFrozen` and no `hold_frozen`: there a
/// revoked vault surfaces as `TransferFailed` and the operator places hold 304 by hand with
/// `place_hold`. This crate, one version ahead (never uploaded), answers the typed `AssetFrozen`
/// and lets anyone record the hold with `hold_frozen`. The policy layer handles both.
#[test]
fn a_frozen_vault_is_asset_frozen_on_this_source_and_only_transfer_failed_on_the_deployed_wasm() {
    let f = setup();
    es_plan(&f);
    f.c.deposit(&PLAN, &(45_000 * STROOPS_PER_CENT));
    f.env.mock_all_auths();
    StellarAssetClient::new(&f.env, &f.usdc).set_authorized(&f.id, &false);
    assert_eq!(
        f.c.try_release_spot(&PLAN, &0, &(45_000 * STROOPS_PER_CENT)),
        Err(Ok(Error::AssetFrozen))
    );
    // Local source: the permissionless hold_frozen records reason 304 (REASON_FUNDS_FROZEN).
    assert_eq!(f.c.hold_frozen(&PLAN, &ev(&f, 6)), PlanState::OnHold);
    assert_eq!(REASON_FUNDS_FROZEN, 304);
    assert_eq!(f.c.get_governance(&PLAN).state, PlanState::OnHold);
    // The manual path of the deployed Wasm still exists here too: after the freeze is lifted and
    // the hold too, place_hold works the same way on both versions.
    StellarAssetClient::new(&f.env, &f.usdc).set_authorized(&f.id, &true);
    f.c.lift_hold(&PLAN, &305, &ev(&f, 7));
    f.c.place_hold(&PLAN, &304, &ev(&f, 8));
    assert_eq!(f.c.get_governance(&PLAN).state, PlanState::OnHold);
}

#[test]
fn apply_lock_is_not_blocked_and_its_rate_scale_is_cop_specific() {
    let f = setup();
    es_plan(&f);
    f.c.deposit(&PLAN, &(135_000 * STROOPS_PER_CENT));
    let lock = BytesN::from_array(&f.env, &[7; 32]);
    // A "rate" of 1.0 (1e7) reads cents as dollars: USD 45,000 due instead of USD 450.
    f.c.apply_lock(
        &PLAN,
        &vec![&f.env, 0u32],
        &lock,
        &10_000_000,
        &(T0 + 40 * DAY),
    );
    assert_eq!(
        f.c.get_installment(&PLAN, &0).usd_due,
        Some(45_000 * 10_000_000)
    );
    // A "rate" of 100 cents per dollar (1e9) gives the exact stroops: release_due would work.
    let lock2 = BytesN::from_array(&f.env, &[8; 32]);
    f.c.apply_lock(
        &PLAN,
        &vec![&f.env, 1u32],
        &lock2,
        &1_000_000_000,
        &(T0 + 70 * DAY),
    );
    assert_eq!(
        f.c.get_installment(&PLAN, &1).usd_due,
        Some(45_000 * STROOPS_PER_CENT)
    );
    f.env.ledger().with_mut(|l| l.timestamp = T0 + 60 * DAY);
    assert_eq!(f.c.release_due(&PLAN, &1), 45_000 * STROOPS_PER_CENT);
}

#[test]
fn nothing_on_chain_marks_the_corridor() {
    let f = setup();
    es_plan(&f);
    let st = f.c.get_status(&PLAN);
    // Plan: plan_id, buyer, count, balance, created_ts. No currency, corridor or payee per plan.
    assert_eq!(st.plan.count, 3);
    assert_eq!(f.c.get_config().payee_backend, f.payee);
}
