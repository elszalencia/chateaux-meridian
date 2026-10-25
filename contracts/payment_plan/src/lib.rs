#![no_std]
//! `payment_plan`: the on-chain record of a Casa Puente down-payment schedule.
//!
//! The doc comments on public items are kept to one line because they are compiled into the
//! contract spec (and so into the Wasm every upload pays for); the full description of each
//! function and type is in docs/CONTRACT.md.
//!
//! One contract instance serves every plan. A plan is a buyer, a payee (the backend that forwards
//! pesos to the trust company) and a list of installments, each with a due date and a COP amount.
//! The buyer deposits test USDC into the plan's balance; the operator applies rate locks (the
//! locked rate and the resulting USD amount are recorded here, the hedge lives off-chain), releases
//! locked installments on their due date at the locked USD amount, releases open installments at
//! a spot USD amount, and breaks locks that were not paid inside the grace period.
//!
//! Adverse events (schema version 2). Every plan carries a `Governance` record: a plan-level
//! state (`Active`, `Delinquent`, `Defaulted`, `OnHold`, `Cancelled`, `Completed`), a per-plan
//! `PolicyConfig` fixed at `create_plan` (grace days, misses before default, penalty basis points,
//! refund mode; the values are placeholders while the business policy is pending) and the running
//! totals that make the funds-conservation invariant checkable on chain:
//! `total_deposited == total_released + total_refunded + balance_usdc`. Operator-gated functions
//! (`mark_missed`, `cure`, `waive`, `declare_default`, `place_hold`, `lift_hold`, `complete_plan`,
//! `refund`) and the admin-gated `cancel_plan` move the state; each takes a reason code and an
//! evidence hash and emits an event. Deposits, locks and releases are blocked while a plan is
//! `OnHold`, `Defaulted`, `Cancelled` or `Completed`. Funds leave the vault only to the allowlisted
//! `payee_backend` (releases) or back to the plan's buyer (refunds); there is no function that
//! pays an arbitrary address. The admin can pause deposits, locks, releases and refunds.
//!
//! Frozen balance. Circle's USDC issuer is `auth_revocable` (it can freeze a trustline or a
//! contract balance) but not clawback-enabled. A transfer that fails because the vault, the payee
//! or the buyer is deauthorized returns `AssetFrozen`; because a failed call rolls back, the hold
//! is recorded by a second, permissionless call, `hold_frozen`, which verifies the freeze through
//! the asset contract and moves the plan to `OnHold` with `REASON_FUNDS_FROZEN`. `lift_hold`
//! refuses while the freeze lasts; `cancel_plan` still works, and the refund waits for the issuer.
//!
//! Precision: `locked_rate` is COP per USD scaled by 1e7 (rounded half-up off-chain), USDC amounts
//! are stroops (7 decimals), `cop_due` is whole pesos. `usd_due = floor(cop_due * 1e7 * 1e7 /
//! locked_rate)`; the floor keeps the buyer's USD at or below the exact quotient so the peso
//! reconstruction never exceeds `cop_due` by more than one peso of rounding.
//!
//! Time: due dates are midnight UTC of the due day. A locked installment can be released once the
//! ledger close time reaches `due_ts`; a lock can be broken once the ledger reaches
//! `lock_expiry_ts` (midnight UTC of the day after the grace period); an unpaid installment can be
//! marked missed once the ledger passes `due_ts + grace_days`. Ledgers close about every five
//! seconds, so nothing finer than a day is meaningful.
//!
//! Storage: config, admin, pause flag and the schema version in instance storage; each plan
//! header, each installment and each governance record under its own persistent key, bumped on
//! every access and by `extend_ttl`. A plan written by schema version 1 has no governance record;
//! it is materialized with the default policy the first time it is touched (`migrate` only bumps
//! the stored version), so the upgrade needs no per-plan rewrite.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    ContractExecutable, Env, Vec,
};

/// Schema version stored in the instance; `migrate` brings older instances up to it.
pub const CONTRACT_VERSION: u32 = 2;

/// COP per USD is stored multiplied by this.
pub const RATE_SCALE: i128 = 10_000_000;
/// USDC amounts are stroops: one USD is this many units.
pub const USD_SCALE: i128 = 10_000_000;
/// Most installments a plan may hold (two years of monthly installments plus headroom).
pub const MAX_INSTALLMENTS: u32 = 60;
/// Seconds in a day, for the policy's grace period.
pub const SECONDS_PER_DAY: u64 = 86_400;
/// Basis points in one whole (100 %).
pub const BPS_DENOMINATOR: u32 = 10_000;
/// Reason code the contract itself writes when `hold_frozen` places a plan on hold. The other
/// reason codes are chosen by the operator; the catalogue is `services/src/policy/reasons.ts`.
pub const REASON_FUNDS_FROZEN: u32 = 304;

/// Ledgers per day at the nominal five-second close time.
pub const LEDGERS_PER_DAY: u32 = 17_280;
/// Entries are extended when their remaining life drops below 30 days ...
pub const TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
/// ... to 120 days, inside the network maximum of about 180 days.
pub const TTL_EXTEND_TO: u32 = 120 * LEDGERS_PER_DAY;

/// Typed errors every entry point returns; the numeric codes are stable across upgrades.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    PlanNotFound = 1,
    PlanExists = 2,
    InstallmentNotFound = 3,
    InvalidAmount = 4,
    InvalidSchedule = 5,
    TooManyInstallments = 6,
    InvalidLockSize = 7,
    NotConsecutive = 8,
    NotOpen = 9,
    NotLocked = 10,
    NotDue = 11,
    InsufficientBalance = 12,
    LockNotExpired = 13,
    InvalidRate = 14,
    TransferFailed = 15,
    Overflow = 16,
    NotReleasable = 17,
    Paused = 18,
    PlanBlocked = 19,
    InvalidTransition = 20,
    GraceNotOver = 21,
    RefundNotAllowed = 22,
    NotComplete = 23,
    DefaultNotReached = 24,
    InvalidPolicy = 25,
    AssetFrozen = 26,
    NotFrozen = 27,
}

/// Installment status; `Missed` and `Waived` are the adverse-event states.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Open = 0,
    Locked = 1,
    Released = 2,
    Broken = 3,
    Missed = 4,
    Waived = 5,
}

/// Plan-level state. Funds move only in `Active` and `Delinquent`.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlanState {
    Active = 0,
    Delinquent = 1,
    Defaulted = 2,
    OnHold = 3,
    Cancelled = 4,
    Completed = 5,
}

/// Per-plan policy fixed at `create_plan`; values are placeholders (policy pending).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PolicyConfig {
    pub grace_days: u32,
    pub misses_before_default: u32,
    pub penalty_bps: u32,
    pub refund_mode: u32,
}

/// Plan state, policy and running totals; the totals conserve funds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Governance {
    pub state: PlanState,
    pub policy: PolicyConfig,
    pub misses: u32,
    pub hold_prev: PlanState,
    pub total_deposited: i128,
    pub total_released: i128,
    pub total_refunded: i128,
}

/// One installment of a plan, stored under `DataKey::Inst(plan_id, idx)`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Installment {
    pub idx: u32,
    pub due_ts: u64,
    pub cop_due: i128,
    pub lock_id: Option<BytesN<32>>,
    pub locked_rate: Option<i128>,
    pub usd_due: Option<i128>,
    pub lock_expiry_ts: Option<u64>,
    pub status: Status,
}

/// Input for `create_plan`: one entry per installment, in order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallmentInit {
    pub due_ts: u64,
    pub cop_due: i128,
}

/// A buyer's payment plan and the USDC balance the contract holds for it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    pub plan_id: u32,
    pub buyer: Address,
    pub count: u32,
    pub balance_usdc: i128,
    pub created_ts: u64,
}

/// Contract-wide roles and addresses, set once by the constructor.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub operator: Address,
    pub usdc: Address,
    pub payee_backend: Address,
}

/// Everything `get_status` returns for a plan.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanStatus {
    pub plan: Plan,
    pub installments: Vec<Installment>,
    pub governance: Governance,
}

/// Storage keys: instance for config, version and pause; persistent for plan rows.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    Version,
    Paused,
    Plan(u32),
    Inst(u32, u32),
    Gov(u32),
}

// ---------- events ----------

/// Emitted by `create_plan`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanCreated {
    #[topic]
    pub plan_id: u32,
    pub buyer: Address,
    pub count: u32,
}

/// Emitted by `deposit` with the plan's balance after the deposit.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub plan_id: u32,
    pub buyer: Address,
    pub amount: i128,
    pub balance: i128,
}

/// Emitted by `apply_lock` for the installments that now share one locked rate.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockApplied {
    #[topic]
    pub plan_id: u32,
    pub lock_id: BytesN<32>,
    pub idxs: Vec<u32>,
    pub locked_rate: i128,
    pub expiry_ts: u64,
}

/// Emitted by `release_due` and `release_spot` when an installment is paid to the payee.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub plan_id: u32,
    #[topic]
    pub idx: u32,
    pub usd_amount: i128,
    pub to: Address,
    pub spot: bool,
}

/// Emitted by `break_lock` when a lock expires unpaid.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockBroken {
    #[topic]
    pub plan_id: u32,
    #[topic]
    pub idx: u32,
    pub lock_id: BytesN<32>,
}

/// A plan-level state change, with the operator's reason code and evidence hash.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanStateChanged {
    #[topic]
    pub plan_id: u32,
    pub from: PlanState,
    pub to: PlanState,
    pub reason: u32,
    pub evidence: BytesN<32>,
}

/// An installment marked `Missed`, cured back to `Open`, or `Waived`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallmentMarked {
    #[topic]
    pub plan_id: u32,
    #[topic]
    pub idx: u32,
    pub status: Status,
    pub reason: u32,
    pub evidence: BytesN<32>,
}

/// USDC returned from the plan balance to the plan's buyer.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refunded {
    #[topic]
    pub plan_id: u32,
    pub to: Address,
    pub amount: i128,
    pub balance: i128,
    pub reason: u32,
    pub evidence: BytesN<32>,
}

/// Emitted by `pause` and `unpause`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseChanged {
    pub paused: bool,
}

// ---------- pure helpers ----------

/// `floor(cop_due * 1e14 / locked_rate)`, checked. Public so the test suite and off-chain tooling
/// can diff it against the TypeScript engine on the shared vectors.
pub fn usd_due_for(cop_due: i128, locked_rate: i128) -> Result<i128, Error> {
    if locked_rate <= 0 {
        return Err(Error::InvalidRate);
    }
    if cop_due <= 0 {
        return Err(Error::InvalidAmount);
    }
    let scaled = cop_due
        .checked_mul(RATE_SCALE)
        .and_then(|v| v.checked_mul(USD_SCALE))
        .ok_or(Error::Overflow)?;
    Ok(scaled / locked_rate)
}

/// Placeholder policy for plans written before schema version 2 (policy pending).
pub fn default_policy() -> PolicyConfig {
    PolicyConfig {
        grace_days: 5,
        misses_before_default: 3,
        penalty_bps: 1_000,
        refund_mode: 0,
    }
}

fn validate_policy(p: &PolicyConfig) -> Result<(), Error> {
    if p.misses_before_default == 0 || p.penalty_bps > BPS_DENOMINATOR || p.refund_mode > 1 {
        return Err(Error::InvalidPolicy);
    }
    Ok(())
}

/// Whether deposits, locks and releases may run in this plan state.
fn funds_allowed(state: PlanState) -> bool {
    matches!(state, PlanState::Active | PlanState::Delinquent)
}

/// The payment-plan contract: USDC custody per plan, rate locks, releases and adverse-event governance.
#[contract]
pub struct PaymentPlan;

impl PaymentPlan {
    fn config(env: &Env) -> Config {
        // The instance always has a config: the constructor writes it and nothing removes it.
        env.storage().instance().get(&DataKey::Config).unwrap()
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn require_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn load_plan(env: &Env, plan_id: u32) -> Result<Plan, Error> {
        let key = DataKey::Plan(plan_id);
        let plan: Plan = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PlanNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(plan)
    }

    fn save_plan(env: &Env, plan: &Plan) {
        let key = DataKey::Plan(plan.plan_id);
        env.storage().persistent().set(&key, plan);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn load_inst(env: &Env, plan_id: u32, idx: u32) -> Result<Installment, Error> {
        let key = DataKey::Inst(plan_id, idx);
        let inst: Installment = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::InstallmentNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(inst)
    }

    fn save_inst(env: &Env, plan_id: u32, inst: &Installment) {
        let key = DataKey::Inst(plan_id, inst.idx);
        env.storage().persistent().set(&key, inst);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    /// The governance record, materialized with the default policy for a plan written by schema
    /// version 1 (its current balance counts as deposited, so the totals invariant holds).
    fn load_gov(env: &Env, plan: &Plan) -> Governance {
        let key = DataKey::Gov(plan.plan_id);
        match env.storage().persistent().get::<DataKey, Governance>(&key) {
            Some(gov) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
                gov
            }
            None => Governance {
                state: PlanState::Active,
                policy: default_policy(),
                misses: 0,
                hold_prev: PlanState::Active,
                total_deposited: plan.balance_usdc,
                total_released: 0,
                total_refunded: 0,
            },
        }
    }

    fn save_gov(env: &Env, plan_id: u32, gov: &Governance) {
        let key = DataKey::Gov(plan_id);
        env.storage().persistent().set(&key, gov);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    /// Loads a plan with its governance and refuses to move funds unless the state allows it.
    fn load_plan_for_funds(env: &Env, plan_id: u32) -> Result<(Plan, Governance), Error> {
        let plan = Self::load_plan(env, plan_id)?;
        let gov = Self::load_gov(env, &plan);
        if !funds_allowed(gov.state) {
            return Err(Error::PlanBlocked);
        }
        Ok((plan, gov))
    }

    fn set_state(
        env: &Env,
        plan_id: u32,
        gov: &mut Governance,
        to: PlanState,
        reason: u32,
        evidence: &BytesN<32>,
    ) {
        let from = gov.state;
        if from == to {
            return;
        }
        gov.state = to;
        PlanStateChanged {
            plan_id,
            from,
            to,
            reason,
            evidence: evidence.clone(),
        }
        .publish(env);
    }

    /// Whether the asset issuer still authorizes `id` to hold and move the asset. Reads the SAC's
    /// `authorized`; an address the SAC cannot answer for (no trustline yet) counts as authorized,
    /// so only a positive "deauthorized" answer is treated as a freeze.
    fn is_authorized(env: &Env, cfg: &Config, id: &Address) -> bool {
        let sac = token::StellarAssetClient::new(env, &cfg.usdc);
        !matches!(sac.try_authorized(id), Ok(Ok(false)))
    }

    /// Token transfer with typed failures: `AssetFrozen` when either side is deauthorized by the
    /// issuer (USDC is `auth_revocable`), `TransferFailed` for anything else (no balance, no
    /// trustline). The caller's state is untouched on failure.
    fn transfer(
        env: &Env,
        cfg: &Config,
        from: &Address,
        to: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        let usdc = token::Client::new(env, &cfg.usdc);
        match usdc.try_transfer(from, to, &amount) {
            Ok(Ok(())) => Ok(()),
            _ if !Self::is_authorized(env, cfg, from) || !Self::is_authorized(env, cfg, to) => {
                Err(Error::AssetFrozen)
            }
            _ => Err(Error::TransferFailed),
        }
    }

    /// Whether the vault, the payee or the plan's buyer is currently frozen by the issuer.
    fn any_frozen(env: &Env, cfg: &Config, plan: &Plan) -> bool {
        !Self::is_authorized(env, cfg, &env.current_contract_address())
            || !Self::is_authorized(env, cfg, &cfg.payee_backend)
            || !Self::is_authorized(env, cfg, &plan.buyer)
    }

    /// Moves `amount` stroops from the plan balance to `payee_backend`, then records the release.
    /// The transfer runs first so a failed transfer returns a typed error with nothing written.
    fn pay_out(
        env: &Env,
        cfg: &Config,
        plan: &mut Plan,
        gov: &mut Governance,
        inst: &mut Installment,
        amount: i128,
        spot: bool,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if plan.balance_usdc < amount {
            return Err(Error::InsufficientBalance);
        }
        Self::transfer(
            env,
            cfg,
            &env.current_contract_address(),
            &cfg.payee_backend,
            amount,
        )?;
        plan.balance_usdc = plan
            .balance_usdc
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;
        gov.total_released = gov
            .total_released
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        inst.status = Status::Released;
        Self::save_inst(env, plan.plan_id, inst);
        Self::save_plan(env, plan);
        Self::save_gov(env, plan.plan_id, gov);
        Released {
            plan_id: plan.plan_id,
            idx: inst.idx,
            usd_amount: amount,
            to: cfg.payee_backend.clone(),
            spot,
        }
        .publish(env);
        Ok(())
    }

    /// Returns `amount` stroops of the plan balance to the plan's buyer and records it.
    fn pay_back(
        env: &Env,
        cfg: &Config,
        plan: &mut Plan,
        gov: &mut Governance,
        amount: i128,
        reason: u32,
        evidence: &BytesN<32>,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if plan.balance_usdc < amount {
            return Err(Error::InsufficientBalance);
        }
        Self::transfer(
            env,
            cfg,
            &env.current_contract_address(),
            &plan.buyer,
            amount,
        )?;
        plan.balance_usdc = plan
            .balance_usdc
            .checked_sub(amount)
            .ok_or(Error::Overflow)?;
        gov.total_refunded = gov
            .total_refunded
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        Self::save_plan(env, plan);
        Self::save_gov(env, plan.plan_id, gov);
        Refunded {
            plan_id: plan.plan_id,
            to: plan.buyer.clone(),
            amount,
            balance: plan.balance_usdc,
            reason,
            evidence: evidence.clone(),
        }
        .publish(env);
        Ok(())
    }

    /// Operator-gated entry for the adverse-event functions: auth, TTL bump, plan + governance.
    fn operator_plan(env: &Env, plan_id: u32) -> Result<(Config, Plan, Governance), Error> {
        let cfg = Self::config(env);
        cfg.operator.require_auth();
        Self::bump_instance(env);
        let plan = Self::load_plan(env, plan_id)?;
        let gov = Self::load_gov(env, &plan);
        Ok((cfg, plan, gov))
    }

    /// Writes an installment's new adverse status and emits `InstallmentMarked`.
    fn mark(
        env: &Env,
        plan_id: u32,
        inst: &mut Installment,
        status: Status,
        reason: u32,
        evidence: &BytesN<32>,
    ) {
        inst.status = status;
        Self::save_inst(env, plan_id, inst);
        InstallmentMarked {
            plan_id,
            idx: inst.idx,
            status,
            reason,
            evidence: evidence.clone(),
        }
        .publish(env);
    }

    /// One miss fewer; a delinquent plan with no outstanding misses is active again.
    fn miss_resolved(
        env: &Env,
        plan_id: u32,
        gov: &mut Governance,
        reason: u32,
        evidence: &BytesN<32>,
    ) {
        gov.misses = gov.misses.saturating_sub(1);
        if gov.misses == 0 && gov.state == PlanState::Delinquent {
            Self::set_state(env, plan_id, gov, PlanState::Active, reason, evidence);
        }
    }
}

#[contractimpl]
impl PaymentPlan {
    /// Deployed once: `admin` upgrades, migrates, pauses and cancels; `operator` runs the rest.
    pub fn __constructor(
        env: Env,
        admin: Address,
        operator: Address,
        usdc: Address,
        payee_backend: Address,
    ) {
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                operator,
                usdc,
                payee_backend,
            },
        );
        env.storage()
            .instance()
            .set(&DataKey::Version, &CONTRACT_VERSION);
        Self::bump_instance(&env);
    }

    /// The admin, operator, settlement asset and payee recorded by the constructor.
    pub fn get_config(env: Env) -> Config {
        Self::config(&env)
    }

    /// The schema version stored in the instance (`CONTRACT_VERSION` after `migrate`).
    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(CONTRACT_VERSION)
    }

    /// Whether the admin has paused deposits, locks, releases and refunds.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Admin only. Pauses deposits, locks, releases, refunds and plan completion.
    pub fn pause(env: Env) {
        let cfg = Self::config(&env);
        cfg.admin.require_auth();
        Self::bump_instance(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
        PauseChanged { paused: true }.publish(&env);
    }

    /// Admin only. Lifts the pause.
    pub fn unpause(env: Env) {
        let cfg = Self::config(&env);
        cfg.admin.require_auth();
        Self::bump_instance(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
        PauseChanged { paused: false }.publish(&env);
    }

    /// Operator only. Creates a plan with ascending installments and a validated policy.
    pub fn create_plan(
        env: Env,
        plan_id: u32,
        buyer: Address,
        installments: Vec<InstallmentInit>,
        policy: PolicyConfig,
    ) -> Result<(), Error> {
        let cfg = Self::config(&env);
        cfg.operator.require_auth();
        Self::bump_instance(&env);
        if env.storage().persistent().has(&DataKey::Plan(plan_id)) {
            return Err(Error::PlanExists);
        }
        validate_policy(&policy)?;
        let count = installments.len();
        if count == 0 {
            return Err(Error::InvalidSchedule);
        }
        if count > MAX_INSTALLMENTS {
            return Err(Error::TooManyInstallments);
        }
        let mut prev_due: u64 = 0;
        for (i, init) in installments.iter().enumerate() {
            if init.cop_due <= 0 || init.due_ts <= prev_due {
                return Err(Error::InvalidSchedule);
            }
            prev_due = init.due_ts;
            let inst = Installment {
                idx: i as u32,
                due_ts: init.due_ts,
                cop_due: init.cop_due,
                lock_id: None,
                locked_rate: None,
                usd_due: None,
                lock_expiry_ts: None,
                status: Status::Open,
            };
            Self::save_inst(&env, plan_id, &inst);
        }
        let plan = Plan {
            plan_id,
            buyer: buyer.clone(),
            count,
            balance_usdc: 0,
            created_ts: env.ledger().timestamp(),
        };
        Self::save_plan(&env, &plan);
        Self::save_gov(
            &env,
            plan_id,
            &Governance {
                state: PlanState::Active,
                policy,
                misses: 0,
                hold_prev: PlanState::Active,
                total_deposited: 0,
                total_released: 0,
                total_refunded: 0,
            },
        );
        PlanCreated {
            plan_id,
            buyer,
            count,
        }
        .publish(&env);
        Ok(())
    }

    /// Buyer only. Moves USDC into the plan's balance and returns it.
    pub fn deposit(env: Env, plan_id: u32, amount: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let cfg = Self::config(&env);
        Self::bump_instance(&env);
        Self::require_not_paused(&env)?;
        let (mut plan, mut gov) = Self::load_plan_for_funds(&env, plan_id)?;
        plan.buyer.require_auth();
        Self::transfer(
            &env,
            &cfg,
            &plan.buyer,
            &env.current_contract_address(),
            amount,
        )?;
        plan.balance_usdc = plan
            .balance_usdc
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        gov.total_deposited = gov
            .total_deposited
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        Self::save_plan(&env, &plan);
        Self::save_gov(&env, plan_id, &gov);
        Deposited {
            plan_id,
            buyer: plan.buyer.clone(),
            amount,
            balance: plan.balance_usdc,
        }
        .publish(&env);
        Ok(plan.balance_usdc)
    }

    /// Operator and buyer. Locks one or three consecutive `Open` installments.
    pub fn apply_lock(
        env: Env,
        plan_id: u32,
        idxs: Vec<u32>,
        lock_id: BytesN<32>,
        locked_rate: i128,
        expiry_ts: u64,
    ) -> Result<(), Error> {
        let cfg = Self::config(&env);
        cfg.operator.require_auth();
        Self::bump_instance(&env);
        Self::require_not_paused(&env)?;
        let (plan, _gov) = Self::load_plan_for_funds(&env, plan_id)?;
        plan.buyer.require_auth();
        if locked_rate <= 0 {
            return Err(Error::InvalidRate);
        }
        let n = idxs.len();
        if n != 1 && n != 3 {
            return Err(Error::InvalidLockSize);
        }
        let first = idxs.get(0).ok_or(Error::InvalidLockSize)?;
        for (k, idx) in idxs.iter().enumerate() {
            if idx != first + k as u32 {
                return Err(Error::NotConsecutive);
            }
        }
        // Validate every installment before writing any of them.
        let mut insts: Vec<Installment> = Vec::new(&env);
        for idx in idxs.iter() {
            let inst = Self::load_inst(&env, plan_id, idx)?;
            if inst.status != Status::Open {
                return Err(Error::NotOpen);
            }
            insts.push_back(inst);
        }
        for mut inst in insts.iter() {
            inst.usd_due = Some(usd_due_for(inst.cop_due, locked_rate)?);
            inst.lock_id = Some(lock_id.clone());
            inst.locked_rate = Some(locked_rate);
            inst.lock_expiry_ts = Some(expiry_ts);
            inst.status = Status::Locked;
            Self::save_inst(&env, plan_id, &inst);
        }
        LockApplied {
            plan_id,
            lock_id,
            idxs,
            locked_rate,
            expiry_ts,
        }
        .publish(&env);
        Ok(())
    }

    /// Operator only. Pays a locked installment's `usd_due` once it is due.
    pub fn release_due(env: Env, plan_id: u32, idx: u32) -> Result<i128, Error> {
        let cfg = Self::config(&env);
        cfg.operator.require_auth();
        Self::bump_instance(&env);
        Self::require_not_paused(&env)?;
        let (mut plan, mut gov) = Self::load_plan_for_funds(&env, plan_id)?;
        let mut inst = Self::load_inst(&env, plan_id, idx)?;
        if inst.status != Status::Locked {
            return Err(Error::NotLocked);
        }
        if env.ledger().timestamp() < inst.due_ts {
            return Err(Error::NotDue);
        }
        let amount = inst.usd_due.ok_or(Error::NotLocked)?;
        Self::pay_out(&env, &cfg, &mut plan, &mut gov, &mut inst, amount, false)?;
        Ok(amount)
    }

    /// Operator only. Pays an `Open` or `Broken` installment at spot, early or late.
    pub fn release_spot(env: Env, plan_id: u32, idx: u32, usd_amount: i128) -> Result<i128, Error> {
        let cfg = Self::config(&env);
        cfg.operator.require_auth();
        Self::bump_instance(&env);
        Self::require_not_paused(&env)?;
        let (mut plan, mut gov) = Self::load_plan_for_funds(&env, plan_id)?;
        let mut inst = Self::load_inst(&env, plan_id, idx)?;
        if inst.status != Status::Open && inst.status != Status::Broken {
            return Err(Error::NotReleasable);
        }
        Self::pay_out(&env, &cfg, &mut plan, &mut gov, &mut inst, usd_amount, true)?;
        Ok(usd_amount)
    }

    /// Operator only. Marks a locked installment `Broken` after its lock expiry.
    pub fn break_lock(env: Env, plan_id: u32, idx: u32) -> Result<(), Error> {
        let cfg = Self::config(&env);
        cfg.operator.require_auth();
        Self::bump_instance(&env);
        let _plan = Self::load_plan(&env, plan_id)?;
        let mut inst = Self::load_inst(&env, plan_id, idx)?;
        if inst.status != Status::Locked {
            return Err(Error::NotLocked);
        }
        let expiry = inst.lock_expiry_ts.ok_or(Error::NotLocked)?;
        if env.ledger().timestamp() < expiry {
            return Err(Error::LockNotExpired);
        }
        let lock_id = inst.lock_id.clone().ok_or(Error::NotLocked)?;
        inst.status = Status::Broken;
        Self::save_inst(&env, plan_id, &inst);
        LockBroken {
            plan_id,
            idx,
            lock_id,
        }
        .publish(&env);
        Ok(())
    }

    // ---------- adverse events ----------

    /// Operator only. Marks an unpaid installment `Missed` after the grace period.
    pub fn mark_missed(
        env: Env,
        plan_id: u32,
        idx: u32,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<(), Error> {
        let (_cfg, _plan, mut gov) = Self::operator_plan(&env, plan_id)?;
        if !funds_allowed(gov.state) {
            return Err(Error::InvalidTransition);
        }
        let mut inst = Self::load_inst(&env, plan_id, idx)?;
        if inst.status != Status::Open && inst.status != Status::Broken {
            return Err(Error::InvalidTransition);
        }
        let grace = u64::from(gov.policy.grace_days)
            .checked_mul(SECONDS_PER_DAY)
            .ok_or(Error::Overflow)?;
        let missed_from = inst.due_ts.checked_add(grace).ok_or(Error::Overflow)?;
        if env.ledger().timestamp() < missed_from {
            return Err(Error::GraceNotOver);
        }
        Self::mark(&env, plan_id, &mut inst, Status::Missed, reason, &evidence);
        gov.misses = gov.misses.checked_add(1).ok_or(Error::Overflow)?;
        Self::set_state(
            &env,
            plan_id,
            &mut gov,
            PlanState::Delinquent,
            reason,
            &evidence,
        );
        Self::save_gov(&env, plan_id, &gov);
        Ok(())
    }

    /// Operator only. Reopens a `Missed` installment and resolves the miss.
    pub fn cure(
        env: Env,
        plan_id: u32,
        idx: u32,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<(), Error> {
        let (_cfg, _plan, mut gov) = Self::operator_plan(&env, plan_id)?;
        if !funds_allowed(gov.state) {
            return Err(Error::InvalidTransition);
        }
        let mut inst = Self::load_inst(&env, plan_id, idx)?;
        if inst.status != Status::Missed {
            return Err(Error::InvalidTransition);
        }
        Self::mark(&env, plan_id, &mut inst, Status::Open, reason, &evidence);
        Self::miss_resolved(&env, plan_id, &mut gov, reason, &evidence);
        Self::save_gov(&env, plan_id, &gov);
        Ok(())
    }

    /// Operator only. Waives an `Open`, `Broken` or `Missed` installment.
    pub fn waive(
        env: Env,
        plan_id: u32,
        idx: u32,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<(), Error> {
        let (_cfg, _plan, mut gov) = Self::operator_plan(&env, plan_id)?;
        if matches!(gov.state, PlanState::Cancelled | PlanState::Completed) {
            return Err(Error::InvalidTransition);
        }
        let mut inst = Self::load_inst(&env, plan_id, idx)?;
        let was_missed = inst.status == Status::Missed;
        if !matches!(inst.status, Status::Open | Status::Broken | Status::Missed) {
            return Err(Error::InvalidTransition);
        }
        Self::mark(&env, plan_id, &mut inst, Status::Waived, reason, &evidence);
        if was_missed {
            Self::miss_resolved(&env, plan_id, &mut gov, reason, &evidence);
        }
        Self::save_gov(&env, plan_id, &gov);
        Ok(())
    }

    /// Operator only. Declares the plan `Defaulted` after `misses_before_default` misses.
    pub fn declare_default(
        env: Env,
        plan_id: u32,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<(), Error> {
        let (_cfg, _plan, mut gov) = Self::operator_plan(&env, plan_id)?;
        if !funds_allowed(gov.state) {
            return Err(Error::InvalidTransition);
        }
        if gov.misses < gov.policy.misses_before_default {
            return Err(Error::DefaultNotReached);
        }
        Self::set_state(
            &env,
            plan_id,
            &mut gov,
            PlanState::Defaulted,
            reason,
            &evidence,
        );
        Self::save_gov(&env, plan_id, &gov);
        Ok(())
    }

    /// Operator only. Puts an `Active` or `Delinquent` plan `OnHold`.
    pub fn place_hold(
        env: Env,
        plan_id: u32,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<(), Error> {
        let (_cfg, _plan, mut gov) = Self::operator_plan(&env, plan_id)?;
        if !funds_allowed(gov.state) {
            return Err(Error::InvalidTransition);
        }
        gov.hold_prev = gov.state;
        Self::set_state(
            &env,
            plan_id,
            &mut gov,
            PlanState::OnHold,
            reason,
            &evidence,
        );
        Self::save_gov(&env, plan_id, &gov);
        Ok(())
    }

    /// Operator only. Ends a hold and restores the previous state; refused while frozen.
    pub fn lift_hold(
        env: Env,
        plan_id: u32,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<(), Error> {
        let (cfg, plan, mut gov) = Self::operator_plan(&env, plan_id)?;
        if gov.state != PlanState::OnHold {
            return Err(Error::InvalidTransition);
        }
        if Self::any_frozen(&env, &cfg, &plan) {
            return Err(Error::AssetFrozen);
        }
        let back = gov.hold_prev;
        Self::set_state(&env, plan_id, &mut gov, back, reason, &evidence);
        Self::save_gov(&env, plan_id, &gov);
        Ok(())
    }

    /// Anyone. Puts the plan `OnHold` when the issuer froze a party; else `NotFrozen`.
    pub fn hold_frozen(env: Env, plan_id: u32, evidence: BytesN<32>) -> Result<PlanState, Error> {
        let cfg = Self::config(&env);
        Self::bump_instance(&env);
        let plan = Self::load_plan(&env, plan_id)?;
        let mut gov = Self::load_gov(&env, &plan);
        if !funds_allowed(gov.state) {
            return Err(Error::InvalidTransition);
        }
        if !Self::any_frozen(&env, &cfg, &plan) {
            return Err(Error::NotFrozen);
        }
        gov.hold_prev = gov.state;
        Self::set_state(
            &env,
            plan_id,
            &mut gov,
            PlanState::OnHold,
            REASON_FUNDS_FROZEN,
            &evidence,
        );
        Self::save_gov(&env, plan_id, &gov);
        Ok(gov.state)
    }

    /// Admin only. Cancels the plan; afterwards only refunds move funds.
    pub fn cancel_plan(
        env: Env,
        plan_id: u32,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<(), Error> {
        let cfg = Self::config(&env);
        cfg.admin.require_auth();
        Self::bump_instance(&env);
        let plan = Self::load_plan(&env, plan_id)?;
        let mut gov = Self::load_gov(&env, &plan);
        if matches!(gov.state, PlanState::Cancelled | PlanState::Completed) {
            return Err(Error::InvalidTransition);
        }
        Self::set_state(
            &env,
            plan_id,
            &mut gov,
            PlanState::Cancelled,
            reason,
            &evidence,
        );
        Self::save_gov(&env, plan_id, &gov);
        Ok(())
    }

    /// Operator only. Refunds a cancelled or defaulted plan to its buyer; returns the rest.
    pub fn refund(
        env: Env,
        plan_id: u32,
        amount: i128,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<i128, Error> {
        let (cfg, mut plan, mut gov) = Self::operator_plan(&env, plan_id)?;
        Self::require_not_paused(&env)?;
        if !matches!(gov.state, PlanState::Cancelled | PlanState::Defaulted) {
            return Err(Error::RefundNotAllowed);
        }
        Self::pay_back(&env, &cfg, &mut plan, &mut gov, amount, reason, &evidence)?;
        Ok(plan.balance_usdc)
    }

    /// Operator only. Completes a fully paid or waived plan, refunding any leftover.
    pub fn complete_plan(
        env: Env,
        plan_id: u32,
        reason: u32,
        evidence: BytesN<32>,
    ) -> Result<(), Error> {
        let (cfg, mut plan, mut gov) = Self::operator_plan(&env, plan_id)?;
        Self::require_not_paused(&env)?;
        if gov.state != PlanState::Active {
            return Err(Error::InvalidTransition);
        }
        for idx in 0..plan.count {
            let inst = Self::load_inst(&env, plan_id, idx)?;
            if !matches!(inst.status, Status::Released | Status::Waived) {
                return Err(Error::NotComplete);
            }
        }
        if plan.balance_usdc > 0 {
            let leftover = plan.balance_usdc;
            Self::pay_back(&env, &cfg, &mut plan, &mut gov, leftover, reason, &evidence)?;
        }
        Self::set_state(
            &env,
            plan_id,
            &mut gov,
            PlanState::Completed,
            reason,
            &evidence,
        );
        Self::save_gov(&env, plan_id, &gov);
        Ok(())
    }

    // ---------- reads and maintenance ----------

    /// Anyone. Extends the TTL of the plan and its entries; returns the installment count.
    pub fn extend_ttl(env: Env, plan_id: u32) -> Result<u32, Error> {
        Self::bump_instance(&env);
        let plan = Self::load_plan(&env, plan_id)?;
        Self::load_gov(&env, &plan);
        for idx in 0..plan.count {
            Self::load_inst(&env, plan_id, idx)?;
        }
        Ok(plan.count)
    }

    /// The plan header, every installment and the governance record.
    pub fn get_status(env: Env, plan_id: u32) -> Result<PlanStatus, Error> {
        Self::bump_instance(&env);
        let plan = Self::load_plan(&env, plan_id)?;
        let governance = Self::load_gov(&env, &plan);
        let mut installments: Vec<Installment> = Vec::new(&env);
        for idx in 0..plan.count {
            installments.push_back(Self::load_inst(&env, plan_id, idx)?);
        }
        Ok(PlanStatus {
            plan,
            installments,
            governance,
        })
    }

    /// One installment of a plan.
    pub fn get_installment(env: Env, plan_id: u32, idx: u32) -> Result<Installment, Error> {
        Self::bump_instance(&env);
        Self::load_plan(&env, plan_id)?;
        Self::load_inst(&env, plan_id, idx)
    }

    /// The plan's state, policy, miss count and running totals.
    pub fn get_governance(env: Env, plan_id: u32) -> Result<Governance, Error> {
        Self::bump_instance(&env);
        let plan = Self::load_plan(&env, plan_id)?;
        Ok(Self::load_gov(&env, &plan))
    }

    /// Admin only. Replaces the executable with an uploaded Wasm; run `migrate` next.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let cfg = Self::config(&env);
        cfg.admin.require_auth();
        Self::bump_instance(&env);
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(new_wasm_hash));
    }

    /// Admin only. Idempotent schema migration; returns the stored version.
    pub fn migrate(env: Env) -> u32 {
        let cfg = Self::config(&env);
        cfg.admin.require_auth();
        Self::bump_instance(&env);
        let stored: u32 = env.storage().instance().get(&DataKey::Version).unwrap_or(0);
        if stored < CONTRACT_VERSION {
            env.storage()
                .instance()
                .set(&DataKey::Version, &CONTRACT_VERSION);
        }
        CONTRACT_VERSION
    }
}

#[cfg(test)]
mod test;
