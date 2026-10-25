//! Tests for the pause switch (E8) and the adverse-event schema (E10): every transition reachable,
//! every unauthorized call rejected, blocked actions staying blocked, and the funds-conservation
//! invariant after each case. Shares the fixture and helpers of the parent test module.

use super::*;

// ---------- pause ----------

#[test]
fn pause_is_admin_only_and_blocks_deposits_locks_releases_and_refunds() {
    let f = setup();
    created(&f, 6);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    let idxs = Vec::from_array(&f.env, [0u32, 1, 2]);
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(2) + 8 * DAY));
    // The operator is not the admin: it cannot pause.
    f.env.mock_auths(&[MockAuth {
        address: &f.operator,
        invoke: &MockAuthInvoke {
            contract: &f.contract,
            fn_name: "pause",
            args: ().into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_pause().is_err());
    assert!(!f.client.is_paused());

    f.env.mock_all_auths();
    f.client.pause();
    let (topics, data) = last_event(&f);
    assert_eq!(
        topic_symbol(&f, &topics[0]),
        Symbol::new(&f.env, "pause_changed")
    );
    assert!(bool::try_from_val(
        &f.env,
        &data_map(&f, &data).get(symbol_short!("paused")).unwrap()
    )
    .unwrap());
    assert!(f.client.is_paused());
    f.env.ledger().with_mut(|li| li.timestamp = due(0));
    assert_eq!(
        f.client.try_deposit(&PLAN, &USD_SCALE),
        Err(Ok(Error::Paused))
    );
    let more = Vec::from_array(&f.env, [3u32, 4, 5]);
    assert_eq!(
        f.client
            .try_apply_lock(&PLAN, &more, &lock_id(&f, 2), &RATE_Q, &(due(5) + 8 * DAY)),
        Err(Ok(Error::Paused))
    );
    assert_eq!(f.client.try_release_due(&PLAN, &0), Err(Ok(Error::Paused)));
    assert_eq!(
        f.client.try_release_spot(&PLAN, &3, &USD_SCALE),
        Err(Ok(Error::Paused))
    );
    assert_eq!(
        f.client.try_refund(&PLAN, &USD_SCALE, &1, &evidence(&f, 1)),
        Err(Ok(Error::Paused))
    );
    // Recording an incident still works while paused.
    f.client.place_hold(&PLAN, &7, &evidence(&f, 7));
    f.client.lift_hold(&PLAN, &7, &evidence(&f, 7));
    assert_eq!(balance(&f, &f.contract), 5_000 * USD_SCALE);

    f.client.unpause();
    assert!(!f.client.is_paused());
    assert_eq!(f.client.release_due(&PLAN, &0), 11_883_327_462);
    assert_conserved(&f, &[PLAN]);
}

// ---------- adverse events ----------

#[test]
fn mark_missed_waits_for_the_grace_period_then_cure_and_waive_resolve_the_miss() {
    let f = setup();
    created(&f, 6);
    f.env.mock_all_auths();
    let ev = evidence(&f, 3);
    // Still inside the grace period: refused.
    f.env
        .ledger()
        .with_mut(|li| li.timestamp = due(0) + 5 * DAY - 1);
    assert_eq!(
        f.client.try_mark_missed(&PLAN, &0, &100, &ev),
        Err(Ok(Error::GraceNotOver))
    );
    f.env
        .ledger()
        .with_mut(|li| li.timestamp = due(0) + 5 * DAY);
    f.client.mark_missed(&PLAN, &0, &100, &ev);
    let (topics, data) = last_event(&f);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.get(0).unwrap().status, Status::Missed);
    assert_eq!(st.governance.misses, 1);
    assert_eq!(st.governance.state, PlanState::Delinquent);
    assert_eq!(
        topic_symbol(&f, &topics[0]),
        Symbol::new(&f.env, "plan_state_changed")
    );
    let m = data_map(&f, &data);
    assert_eq!(
        u32::try_from_val(&f.env, &m.get(symbol_short!("reason")).unwrap()).unwrap(),
        100
    );
    assert_eq!(
        BytesN::<32>::try_from_val(&f.env, &m.get(symbol_short!("evidence")).unwrap()).unwrap(),
        ev
    );
    // A missed installment cannot be locked or paid until it is cured.
    let one = Vec::from_array(&f.env, [0u32]);
    assert_eq!(
        f.client
            .try_apply_lock(&PLAN, &one, &lock_id(&f, 1), &RATE_Q, &(due(0) + 8 * DAY)),
        Err(Ok(Error::NotOpen))
    );
    assert_eq!(
        f.client.try_release_spot(&PLAN, &0, &USD_SCALE),
        Err(Ok(Error::NotReleasable))
    );
    // Cure: back to Open, plan Active again.
    f.client.cure(&PLAN, &0, &101, &ev);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.get(0).unwrap().status, Status::Open);
    assert_eq!(st.governance.misses, 0);
    assert_eq!(st.governance.state, PlanState::Active);
    assert_eq!(
        f.client.try_cure(&PLAN, &0, &101, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    // Waive an open installment, then a missed one; the second resolves the miss.
    f.client.mark_missed(&PLAN, &0, &100, &ev);
    f.client.waive(&PLAN, &1, &102, &ev);
    let (topics, data) = last_event(&f);
    assert_eq!(
        topic_symbol(&f, &topics[0]),
        Symbol::new(&f.env, "installment_marked")
    );
    assert_eq!(u32::try_from_val(&f.env, &topics[2]).unwrap(), 1);
    assert_eq!(
        Status::try_from_val(
            &f.env,
            &data_map(&f, &data).get(symbol_short!("status")).unwrap()
        )
        .unwrap(),
        Status::Waived
    );
    assert_eq!(
        f.client.get_status(&PLAN).governance.state,
        PlanState::Delinquent
    );
    f.client.waive(&PLAN, &0, &102, &ev);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.installments.get(0).unwrap().status, Status::Waived);
    assert_eq!(st.installments.get(1).unwrap().status, Status::Waived);
    assert_eq!(st.governance.misses, 0);
    assert_eq!(st.governance.state, PlanState::Active);
    // Locked installments must be broken before they can be missed; waived ones stay waived.
    let idxs = Vec::from_array(&f.env, [3u32, 4, 5]);
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(5) + 8 * DAY));
    f.env
        .ledger()
        .with_mut(|li| li.timestamp = due(5) + 9 * DAY);
    assert_eq!(
        f.client.try_mark_missed(&PLAN, &3, &100, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    f.client.break_lock(&PLAN, &3);
    f.client.mark_missed(&PLAN, &3, &100, &ev);
    assert_eq!(
        f.client.try_waive(&PLAN, &0, &102, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn declare_default_needs_the_policy_misses_then_only_refunds_to_the_buyer_move_funds() {
    let f = setup();
    created(&f, 6);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    let ev = evidence(&f, 4);
    f.env
        .ledger()
        .with_mut(|li| li.timestamp = due(1) + 5 * DAY);
    f.client.mark_missed(&PLAN, &0, &200, &ev);
    assert_eq!(
        f.client.try_declare_default(&PLAN, &201, &ev),
        Err(Ok(Error::DefaultNotReached))
    );
    f.client.mark_missed(&PLAN, &1, &200, &ev);
    // A delinquent plan still accepts money: the buyer may be catching up.
    f.client.deposit(&PLAN, &(100 * USD_SCALE));
    f.client.declare_default(&PLAN, &201, &ev);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.governance.state, PlanState::Defaulted);
    assert_eq!(st.governance.misses, 2);
    // Blocked: deposits, locks, releases, further marks.
    assert_eq!(
        f.client.try_deposit(&PLAN, &USD_SCALE),
        Err(Ok(Error::PlanBlocked))
    );
    let idxs = Vec::from_array(&f.env, [3u32, 4, 5]);
    assert_eq!(
        f.client
            .try_apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(5) + 8 * DAY)),
        Err(Ok(Error::PlanBlocked))
    );
    assert_eq!(
        f.client.try_release_spot(&PLAN, &2, &USD_SCALE),
        Err(Ok(Error::PlanBlocked))
    );
    assert_eq!(
        f.client.try_mark_missed(&PLAN, &2, &200, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    assert_eq!(
        f.client.try_cure(&PLAN, &0, &202, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    assert_eq!(
        f.client.try_declare_default(&PLAN, &201, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    // Refunds go to the buyer, bounded by the balance.
    let before = balance(&f, &f.buyer);
    assert_eq!(
        f.client.refund(&PLAN, &(1_000 * USD_SCALE), &203, &ev),
        4_100 * USD_SCALE
    );
    let (topics, data) = last_event(&f);
    assert_eq!(balance(&f, &f.buyer), before + 1_000 * USD_SCALE);
    assert_eq!(topic_symbol(&f, &topics[0]), symbol_short!("refunded"));
    assert_eq!(
        Address::try_from_val(
            &f.env,
            &data_map(&f, &data).get(symbol_short!("to")).unwrap()
        )
        .unwrap(),
        f.buyer
    );
    assert_eq!(
        f.client.try_refund(&PLAN, &(9_000 * USD_SCALE), &203, &ev),
        Err(Ok(Error::InsufficientBalance))
    );
    assert_eq!(
        f.client.try_refund(&PLAN, &0, &203, &ev),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        f.client.get_status(&PLAN).governance.total_refunded,
        1_000 * USD_SCALE
    );
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn place_hold_blocks_funds_and_lift_hold_restores_the_previous_state() {
    let f = setup();
    created(&f, 6);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    let idxs = Vec::from_array(&f.env, [0u32, 1, 2]);
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(2) + 8 * DAY));
    let ev = evidence(&f, 5);
    // From Active.
    f.client.place_hold(&PLAN, &300, &ev);
    assert_eq!(
        f.client.get_status(&PLAN).governance.state,
        PlanState::OnHold
    );
    f.env.ledger().with_mut(|li| li.timestamp = due(0));
    assert_eq!(
        f.client.try_release_due(&PLAN, &0),
        Err(Ok(Error::PlanBlocked))
    );
    assert_eq!(
        f.client.try_deposit(&PLAN, &USD_SCALE),
        Err(Ok(Error::PlanBlocked))
    );
    assert_eq!(
        f.client.try_place_hold(&PLAN, &300, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    f.client.lift_hold(&PLAN, &301, &ev);
    assert_eq!(
        f.client.get_status(&PLAN).governance.state,
        PlanState::Active
    );
    assert_eq!(
        f.client.try_lift_hold(&PLAN, &301, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    assert_eq!(f.client.release_due(&PLAN, &0), 11_883_327_462);
    // From Delinquent: the hold remembers it.
    f.env
        .ledger()
        .with_mut(|li| li.timestamp = due(5) + 5 * DAY);
    f.client.mark_missed(&PLAN, &5, &200, &ev);
    f.client.place_hold(&PLAN, &300, &ev);
    let g = f.client.get_governance(&PLAN);
    assert_eq!(g.state, PlanState::OnHold);
    assert_eq!(g.hold_prev, PlanState::Delinquent);
    f.client.lift_hold(&PLAN, &301, &ev);
    assert_eq!(f.client.get_governance(&PLAN).state, PlanState::Delinquent);
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn cancel_plan_is_admin_only_and_the_refund_can_only_reach_the_buyer() {
    let f = setup();
    created(&f, 6);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(3_000 * USD_SCALE));
    let ev = evidence(&f, 6);
    // Refunds are not possible on an active plan.
    assert_eq!(
        f.client.try_refund(&PLAN, &USD_SCALE, &400, &ev),
        Err(Ok(Error::RefundNotAllowed))
    );
    // The operator cannot cancel.
    f.env.mock_auths(&[MockAuth {
        address: &f.operator,
        invoke: &MockAuthInvoke {
            contract: &f.contract,
            fn_name: "cancel_plan",
            args: (PLAN, 400u32, ev.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_cancel_plan(&PLAN, &400, &ev).is_err());
    f.env.mock_all_auths();
    f.client.cancel_plan(&PLAN, &400, &ev);
    let g = f.client.get_governance(&PLAN);
    assert_eq!(g.state, PlanState::Cancelled);
    assert_eq!(
        f.client.try_cancel_plan(&PLAN, &400, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    assert_eq!(
        f.client.try_deposit(&PLAN, &USD_SCALE),
        Err(Ok(Error::PlanBlocked))
    );
    assert_eq!(
        f.client.try_release_spot(&PLAN, &0, &USD_SCALE),
        Err(Ok(Error::PlanBlocked))
    );
    assert_eq!(
        f.client.try_waive(&PLAN, &0, &401, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    // The whole balance goes back to the buyer; the payee receives nothing.
    let buyer_before = balance(&f, &f.buyer);
    let payee_before = balance(&f, &f.payee);
    assert_eq!(f.client.refund(&PLAN, &(3_000 * USD_SCALE), &402, &ev), 0);
    assert_eq!(balance(&f, &f.buyer), buyer_before + 3_000 * USD_SCALE);
    assert_eq!(balance(&f, &f.payee), payee_before);
    assert_eq!(balance(&f, &f.contract), 0);
    let g = f.client.get_governance(&PLAN);
    assert_eq!(g.total_deposited, 3_000 * USD_SCALE);
    assert_eq!(g.total_refunded, 3_000 * USD_SCALE);
    assert_eq!(g.total_released, 0);
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn complete_plan_requires_every_installment_released_or_waived_and_returns_leftovers() {
    let f = setup();
    created(&f, 3);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(3_000 * USD_SCALE));
    let ev = evidence(&f, 8);
    f.client.release_spot(&PLAN, &0, &(1_200 * USD_SCALE));
    f.client.release_spot(&PLAN, &1, &(1_200 * USD_SCALE));
    assert_eq!(
        f.client.try_complete_plan(&PLAN, &500, &ev),
        Err(Ok(Error::NotComplete))
    );
    f.client.waive(&PLAN, &2, &501, &ev);
    let buyer_before = balance(&f, &f.buyer);
    f.client.complete_plan(&PLAN, &500, &ev);
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.governance.state, PlanState::Completed);
    assert_eq!(st.plan.balance_usdc, 0);
    // The 600 USD left over went back to the buyer.
    assert_eq!(balance(&f, &f.buyer), buyer_before + 600 * USD_SCALE);
    assert_eq!(st.governance.total_refunded, 600 * USD_SCALE);
    assert_eq!(st.governance.total_released, 2_400 * USD_SCALE);
    assert_eq!(
        f.client.try_deposit(&PLAN, &USD_SCALE),
        Err(Ok(Error::PlanBlocked))
    );
    assert_eq!(
        f.client.try_complete_plan(&PLAN, &500, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    assert_eq!(
        f.client.try_cancel_plan(&PLAN, &400, &ev),
        Err(Ok(Error::InvalidTransition))
    );
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn every_adverse_call_is_rejected_for_a_non_operator() {
    let f = setup();
    created(&f, 3);
    let ev = evidence(&f, 9);
    let auth = |fn_name: &'static str, args: Vec<Val>| {
        f.env.mock_auths(&[MockAuth {
            address: &f.buyer,
            invoke: &MockAuthInvoke {
                contract: &f.contract,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    };
    auth(
        "mark_missed",
        (PLAN, 0u32, 1u32, ev.clone()).into_val(&f.env),
    );
    assert!(f.client.try_mark_missed(&PLAN, &0, &1, &ev).is_err());
    auth("cure", (PLAN, 0u32, 1u32, ev.clone()).into_val(&f.env));
    assert!(f.client.try_cure(&PLAN, &0, &1, &ev).is_err());
    auth("waive", (PLAN, 0u32, 1u32, ev.clone()).into_val(&f.env));
    assert!(f.client.try_waive(&PLAN, &0, &1, &ev).is_err());
    auth("declare_default", (PLAN, 1u32, ev.clone()).into_val(&f.env));
    assert!(f.client.try_declare_default(&PLAN, &1, &ev).is_err());
    auth("place_hold", (PLAN, 1u32, ev.clone()).into_val(&f.env));
    assert!(f.client.try_place_hold(&PLAN, &1, &ev).is_err());
    auth("lift_hold", (PLAN, 1u32, ev.clone()).into_val(&f.env));
    assert!(f.client.try_lift_hold(&PLAN, &1, &ev).is_err());
    auth("cancel_plan", (PLAN, 1u32, ev.clone()).into_val(&f.env));
    assert!(f.client.try_cancel_plan(&PLAN, &1, &ev).is_err());
    auth(
        "refund",
        (PLAN, USD_SCALE, 1u32, ev.clone()).into_val(&f.env),
    );
    assert!(f.client.try_refund(&PLAN, &USD_SCALE, &1, &ev).is_err());
    auth("complete_plan", (PLAN, 1u32, ev.clone()).into_val(&f.env));
    assert!(f.client.try_complete_plan(&PLAN, &1, &ev).is_err());
    auth("pause", ().into_val(&f.env));
    assert!(f.client.try_pause().is_err());
    auth("unpause", ().into_val(&f.env));
    assert!(f.client.try_unpause().is_err());
    // Nothing changed.
    let st = f.client.get_status(&PLAN);
    assert_eq!(st.governance.state, PlanState::Active);
    assert_eq!(st.installments.get(0).unwrap().status, Status::Open);
    assert!(!f.client.is_paused());
}

#[test]
fn a_schema_version_1_plan_gets_default_governance_and_migrate_bumps_the_version() {
    let f = setup();
    created(&f, 3);
    fund(&f, &f.buyer, 10_000);
    f.env.mock_all_auths();
    f.client.deposit(&PLAN, &(2_000 * USD_SCALE));
    // Simulate storage written by schema version 1: no governance record, version 1.
    f.env.as_contract(&f.contract, || {
        f.env.storage().persistent().remove(&DataKey::Gov(PLAN));
        f.env.storage().instance().set(&DataKey::Version, &1u32);
    });
    assert_eq!(f.client.version(), 1);
    let g = f.client.get_governance(&PLAN);
    assert_eq!(g.state, PlanState::Active);
    assert_eq!(g.policy, default_policy());
    assert_eq!(g.total_deposited, 2_000 * USD_SCALE);
    assert_eq!(g.total_released, 0);
    assert_eq!(f.client.migrate(), 2);
    assert_eq!(f.client.version(), 2);
    assert_eq!(f.client.migrate(), 2);
    // The first write materializes the record and the totals keep adding up.
    f.client.release_spot(&PLAN, &0, &(1_200 * USD_SCALE));
    let g = f.client.get_governance(&PLAN);
    assert_eq!(g.total_released, 1_200 * USD_SCALE);
    assert_conserved(&f, &[PLAN]);
}

#[test]
fn create_plan_validates_the_policy() {
    let f = setup();
    f.env.mock_all_auths();
    let bad = PolicyConfig {
        grace_days: 5,
        misses_before_default: 0,
        penalty_bps: 1_000,
        refund_mode: 0,
    };
    assert_eq!(
        f.client
            .try_create_plan(&PLAN, &f.buyer, &schedule(&f.env, 3), &bad),
        Err(Ok(Error::InvalidPolicy))
    );
    let bad = PolicyConfig {
        penalty_bps: 10_001,
        ..policy()
    };
    assert_eq!(
        f.client
            .try_create_plan(&PLAN, &f.buyer, &schedule(&f.env, 3), &bad),
        Err(Ok(Error::InvalidPolicy))
    );
    let bad = PolicyConfig {
        refund_mode: 2,
        ..policy()
    };
    assert_eq!(
        f.client
            .try_create_plan(&PLAN, &f.buyer, &schedule(&f.env, 3), &bad),
        Err(Ok(Error::InvalidPolicy))
    );
    created(&f, 3);
    assert_eq!(f.client.get_governance(&PLAN).policy, policy());
}

#[test]
fn funds_are_conserved_across_two_plans_through_every_adverse_case() {
    let f = setup();
    created(&f, 6);
    let other = Address::generate(&f.env);
    f.env.mock_all_auths();
    f.client
        .create_plan(&2, &other, &schedule(&f.env, 3), &policy());
    fund(&f, &f.buyer, 10_000);
    fund(&f, &other, 10_000);
    f.env.mock_all_auths();
    let ev = evidence(&f, 10);
    f.client.deposit(&PLAN, &(5_000 * USD_SCALE));
    f.client.deposit(&2, &(2_000 * USD_SCALE));
    assert_conserved(&f, &[PLAN, 2]);
    let idxs = Vec::from_array(&f.env, [0u32, 1, 2]);
    f.client
        .apply_lock(&PLAN, &idxs, &lock_id(&f, 1), &RATE_Q, &(due(2) + 8 * DAY));
    f.env.ledger().with_mut(|li| li.timestamp = due(0));
    f.client.release_due(&PLAN, &0);
    assert_conserved(&f, &[PLAN, 2]);
    f.env
        .ledger()
        .with_mut(|li| li.timestamp = due(2) + 9 * DAY);
    f.client.break_lock(&PLAN, &1);
    f.client.release_spot(&PLAN, &1, &(1_250 * USD_SCALE));
    f.client.break_lock(&PLAN, &2);
    f.client.mark_missed(&PLAN, &2, &1, &ev);
    f.env
        .ledger()
        .with_mut(|li| li.timestamp = due(3) + 5 * DAY);
    f.client.mark_missed(&PLAN, &3, &1, &ev);
    assert_conserved(&f, &[PLAN, 2]);
    f.client.declare_default(&PLAN, &2, &ev);
    f.client.refund(&PLAN, &(500 * USD_SCALE), &3, &ev);
    assert_conserved(&f, &[PLAN, 2]);
    f.client.release_spot(&2, &0, &(700 * USD_SCALE));
    f.client.cancel_plan(&2, &4, &ev);
    f.client.refund(&2, &(1_300 * USD_SCALE), &5, &ev);
    assert_conserved(&f, &[PLAN, 2]);
    assert_eq!(f.client.get_status(&2).plan.balance_usdc, 0);
    let g = f.client.get_governance(&PLAN);
    assert_eq!(
        g.total_deposited,
        g.total_released + g.total_refunded + f.client.get_status(&PLAN).plan.balance_usdc
    );
}
