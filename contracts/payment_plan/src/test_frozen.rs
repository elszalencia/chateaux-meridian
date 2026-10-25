//! Frozen balance (B1): Circle's USDC issuer is `auth_revocable` and not clawback-enabled, so the
//! realistic failure is a deauthorized vault, payee or buyer. These tests freeze them through the
//! test SAC's `set_authorized` and check that every transfer surfaces `AssetFrozen` with nothing
//! written, that `hold_frozen` records the hold (reason `REASON_FUNDS_FROZEN`) without operator
//! auth, that the hold cannot be lifted while the freeze lasts, and that funds are conserved.

use super::*;

fn set_authorized(f: &Fixture, who: &Address, authorized: bool) {
    f.env.mock_all_auths();
    StellarAssetClient::new(&f.env, &f.usdc).set_authorized(who, &authorized);
}

/// A plan with USD 5,000 deposited and Q1 locked, ledger at M1's due date.
fn funded_and_locked(f: &Fixture) {
    created(f, 6);
    fund(f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    let idxs = Vec::from_array(&f.env, [0u32, 1, 2]);
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(f, 1), &RATE_Q, &(due(2) + 8 * DAY));
    f.env.ledger().with_mut(|li| li.timestamp = due(0));
}

#[test]
fn a_frozen_vault_makes_releases_fail_with_asset_frozen_and_writes_nothing() {
    let f = setup();
    funded_and_locked(&f);
    set_authorized(&f, &f.contract, false);
    assert_eq!(
        f.client.try_release_due(&PLAN, &0),
        Err(Ok(Error::AssetFrozen))
    );
    assert_eq!(
        f.client.try_release_spot(&PLAN, &3, &USD_SCALE),
        Err(Ok(Error::AssetFrozen))
    );
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.get(0).unwrap().status, Status::Locked);
    assert_eq!(st.plan.balance_usdc, 5_000 * USD_SCALE);
    assert_eq!(st.governance.total_released, 0);
    assert_eq!(st.governance.state, PlanState::Active);
    assert_eq!(balance(&f, &f.payee), 0);
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn hold_frozen_needs_no_auth_records_reason_304_and_blocks_lift_until_reauthorized() {
    let f = setup();
    funded_and_locked(&f);
    let ev = evidence(&f, 9);
    // Nothing frozen: refused.
    assert_eq!(
        f.client.try_hold_frozen(&PLAN, &ev),
        Err(Ok(Error::NotFrozen))
    );
    set_authorized(&f, &f.contract, false);
    // No signature at all: the contract verifies the freeze itself.
    f.env.mock_auths(&[]);
    assert_eq!(f.client.hold_frozen(&PLAN, &ev), PlanState::OnHold);
    assert!(f.env.auths().is_empty());
    let (topics, data) = last_event(&f);
    assert_eq!(
        topic_symbol(&f, &topics[0]),
        Symbol::new(&f.env, "plan_state_changed")
    );
    let m = data_map(&f, &data);
    assert_eq!(
        u32::try_from_val(&f.env, &m.get(symbol_short!("reason")).unwrap()).unwrap(),
        REASON_FUNDS_FROZEN
    );
    assert_eq!(
        BytesN::<32>::try_from_val(&f.env, &m.get(symbol_short!("evidence")).unwrap()).unwrap(),
        ev
    );
    let g = f.client.get_governance(&PLAN);
    assert_eq!(g.state, PlanState::OnHold);
    assert_eq!(g.hold_prev, PlanState::Active);
    // Already on hold: a second call is an invalid transition, not a second event.
    assert_eq!(
        f.client.try_hold_frozen(&PLAN, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    // Funds stay blocked by the plan state, and the hold cannot be lifted while frozen.
    f.env.mock_all_auths();
    assert_eq!(
        f.client.try_release_due(&PLAN, &0),
        Err(Ok(Error::PlanBlocked))
    );
    assert_eq!(
        f.client.try_lift_hold(&PLAN, &310, &ev),
        Err(Ok(Error::AssetFrozen))
    );
    // The issuer lifts the freeze: the operator lifts the hold and the release goes through.
    set_authorized(&f, &f.contract, true);
    f.client.lift_hold(&PLAN, &310, &ev);
    assert_eq!(f.client.get_governance(&PLAN).state, PlanState::Active);
    assert_eq!(f.client.release_due(&PLAN, &0), 11_883_327_462);
    assert_eq!(balance(&f, &f.payee), 11_883_327_462);
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn a_frozen_payee_or_buyer_is_also_a_freeze() {
    let f = setup();
    funded_and_locked(&f);
    // Payee frozen: the release cannot land.
    set_authorized(&f, &f.payee, false);
    assert_eq!(
        f.client.try_release_due(&PLAN, &0),
        Err(Ok(Error::AssetFrozen))
    );
    f.env.mock_auths(&[]);
    assert_eq!(
        f.client.hold_frozen(&PLAN, &evidence(&f, 1)),
        PlanState::OnHold
    );
    set_authorized(&f, &f.payee, true);
    f.client.lift_hold(&PLAN, &310, &evidence(&f, 1));
    // Buyer frozen (for example a sanctions match at the bank): deposits fail typed.
    set_authorized(&f, &f.buyer, false);
    assert_eq!(
        f.client.try_deposit(&PLAN, &USD_SCALE),
        Err(Ok(Error::AssetFrozen))
    );
    f.env.mock_auths(&[]);
    assert_eq!(
        f.client.hold_frozen(&PLAN, &evidence(&f, 2)),
        PlanState::OnHold
    );
    f.env.mock_all_auths();
    assert_eq!(
        f.client.try_lift_hold(&PLAN, &310, &evidence(&f, 2)),
        Err(Ok(Error::AssetFrozen))
    );
    assert_eq!(
        f.client.get_status(&PLAN).plan.balance_usdc,
        5_000 * USD_SCALE
    );
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn a_cancelled_plan_with_a_frozen_vault_keeps_its_balance_until_the_refund_can_land() {
    let f = setup();
    funded_and_locked(&f);
    set_authorized(&f, &f.contract, false);
    f.env.mock_auths(&[]);
    f.client.hold_frozen(&PLAN, &evidence(&f, 3));
    // Cancelling stays possible from OnHold; the refund is refused typed while frozen.
    f.env.mock_all_auths();
    f.client.cancel_plan(&PLAN, &200, &evidence(&f, 4));
    assert_eq!(f.client.get_governance(&PLAN).state, PlanState::Cancelled);
    assert_eq!(
        f.client
            .try_refund(&PLAN, &(5_000 * USD_SCALE), &400, &evidence(&f, 4)),
        Err(Ok(Error::AssetFrozen))
    );
    assert_eq!(
        f.client.get_status(&PLAN).plan.balance_usdc,
        5_000 * USD_SCALE
    );
    // hold_frozen does not apply to a cancelled plan.
    assert_eq!(
        f.client.try_hold_frozen(&PLAN, &evidence(&f, 3)),
        Err(Ok(Error::InvalidTransition))
    );
    set_authorized(&f, &f.contract, true);
    let buyer_before = balance(&f, &f.buyer);
    assert_eq!(
        f.client
            .refund(&PLAN, &(5_000 * USD_SCALE), &400, &evidence(&f, 4)),
        0
    );
    assert_eq!(balance(&f, &f.buyer), buyer_before + 5_000 * USD_SCALE);
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn a_transfer_failure_without_a_freeze_stays_transfer_failed() {
    let f = setup();
    created(&f, 3);
    set_authorized(&f, &f.contract, true);
    f.env.mock_all_auths();
    // The buyer holds no USDC: not a freeze.
    assert_eq!(
        f.client.try_deposit(&PLAN, &(10 * USD_SCALE)),
        Err(Ok(Error::TransferFailed))
    );
    f.env.mock_auths(&[]);
    assert_eq!(
        f.client.try_hold_frozen(&PLAN, &evidence(&f, 1)),
        Err(Ok(Error::NotFrozen))
    );
}
