# `payment_plan` contract reference

The full description of the public functions and types of the Soroban contract in `contracts/payment_plan/src/lib.rs`. The doc comments in the source are kept to one line on purpose: they are compiled into the contract spec, so every byte is part of the Wasm that each upload pays for (see the 2026-10-24 rent entries in `docs/STELLAR_NORMS.md`). The crate-level comment at the top of `lib.rs` describes the model as a whole (plans, adverse-event states, frozen balances, precision, time and storage); `docs/ARCHITECTURE.md` and `docs/ADVERSE_EVENTS.md` place it in the system.

## Functions

### `__constructor`

Deployed once per environment. `admin` may upgrade, migrate, pause and cancel plans; `operator` runs every other privileged call; `usdc` is the settlement asset's SAC address; `payee_backend` is the only address releases are paid to.

### `pause`

Admin only. Pauses `deposit`, `apply_lock`, `release_due`, `release_spot`, `refund` and `complete_plan` (which may refund). Reads, `break_lock` and the state-marking functions keep working so an incident can still be recorded while funds stand still.

### `create_plan`

Operator only. Installments must be in ascending due order with positive peso amounts; `policy` is validated (`misses_before_default ≥ 1`, `penalty_bps ≤ 10_000`, `refund_mode ∈ {0, 1}`) and stored with the plan's governance record.

### `deposit`

Buyer only: the plan's buyer authorizes this call and the USDC transfer it makes. Requiring the buyer's auth here (not only inside the token) stops a pre-signed transfer from being replayed through this entrypoint by someone else. Blocked while paused or while the plan is on hold, defaulted, cancelled or completed. Returns the new balance.

### `apply_lock`

Operator and buyer. `idxs` is one installment or three consecutive ones, all `Open`. Records the locked rate (COP per USD × 1e7) and the resulting USD amount per installment. Blocked while paused or while the plan state forbids funds movements.

### `release_due`

Operator only. Pays a locked installment's `usd_due` to `payee_backend` once the ledger has reached the due date. Returns the stroops released.

### `release_spot`

Operator only. Pays `usd_amount` for an `Open` or `Broken` installment at the spot rate the operator quoted off-chain. Early payment is allowed: this is how a buyer pays ahead. A `Missed` installment must be cured first.

### `break_lock`

Operator only. Marks a locked installment `Broken` once the ledger has passed its lock expiry (the day after the grace period). The lock fields stay for the audit trail; the installment can then be paid at spot with `release_spot` or marked missed.

### `mark_missed`

Operator only. Marks an unpaid `Open` or `Broken` installment `Missed` once the ledger has passed `due_ts + grace_days`; a locked installment must be broken first. Counts the miss and moves an `Active` plan to `Delinquent`. Allowed in `Active` and `Delinquent` only.

### `cure`

Operator only. The buyer caught up: a `Missed` installment goes back to `Open` (so it can be paid at spot) and a `Delinquent` plan with no other misses becomes `Active` again. Not allowed on a defaulted, on-hold, cancelled or completed plan; reinstating a defaulted plan is an open policy decision.

### `waive`

Operator only. An `Open`, `Broken` or `Missed` installment will never be collected (`Waived`). Resolves the miss if there was one. Not allowed on cancelled or completed plans.

### `declare_default`

Operator only. Declares the plan `Defaulted` once at least `misses_before_default` installments are missed. From then on no funds move except refunds to the buyer.

### `place_hold`

Operator only. Freezes an `Active` or `Delinquent` plan (`OnHold`): KYC or sanctions review, a disputed payment, a frozen balance. Deposits, locks and releases are refused until `lift_hold`, which returns the plan to the state it had.

### `lift_hold`

Operator only. Ends a hold; the plan returns to the state it had when the hold was placed. Refused with `AssetFrozen` while the issuer still freezes the vault, the payee or the buyer, so a plan never resumes into transfers that are bound to fail.

### `hold_frozen`

Anyone. Records a frozen balance: when the asset issuer has deauthorized the vault, the payee or the plan's buyer (Circle's USDC is `auth_revocable`, not clawback-enabled), an `Active` or `Delinquent` plan goes `OnHold` with reason `REASON_FUNDS_FROZEN` and the caller's evidence hash. A transfer that hits the freeze returns `AssetFrozen` and rolls back, so this is the second step that leaves the plan in a recorded state instead of failing every day. Permissionless because it only acts on a fact the contract verifies itself; returns `NotFrozen` otherwise. `lift_hold` refuses until the freeze is gone.

### `cancel_plan`

Admin only. Cancels the plan (buyer withdrawal, project cancelled). Allowed from any state except `Cancelled` and `Completed`; afterwards only `refund` can move the balance, and only to the buyer. The penalty clause of the encargo (`penalty_bps`) is applied off-chain by the policy engine when it sizes the refund (policy pending).

### `refund`

Operator only. Returns `amount` stroops of a `Cancelled` or `Defaulted` plan's balance to the plan's buyer, the only address a refund can go to. Blocked while paused. Returns the balance left.

### `complete_plan`

Operator only. Closes an `Active` plan whose installments are all `Released` or `Waived` (`Completed`); any balance left is returned to the buyer first. Blocked while paused.

### `extend_ttl`

Anyone. Extends the instance, the plan header, its governance record and every installment of the plan, so a keeper can keep dormant plans alive without authorization. Returns the installment count.

### `upgrade`

Admin only. Replaces this contract's executable with an uploaded Wasm; storage and the address survive. Run `migrate` afterwards.

### `migrate`

Admin only. Brings the stored schema version up to `CONTRACT_VERSION`; a no-op when already current, so it is safe to run after every upgrade. Version 2 adds the governance record, which is materialized lazily per plan (see the crate docs), so no data is rewritten here. Returns the version now stored.

## Types

### `Error::AssetFrozen`

A transfer failed because the asset issuer deauthorized (froze) the vault, the payee or the buyer. Nothing was written; call `hold_frozen` to record the hold on the plan.

### `Status`

Installment status. `Missed` and `Waived` are the adverse-event states: a missed installment is unpaid past the policy's grace period; a waived one will never be collected.

### `PolicyConfig`

Per-plan policy fixed at `create_plan`. Every value is a placeholder until the business policy is decided ("policy pending"): the contract enforces `grace_days` (when an installment can be marked missed) and `misses_before_default` (when a default can be declared); `penalty_bps` and `refund_mode` are recorded for the off-chain policy engine and not applied by the contract, which only bounds a refund by the plan balance.

### `Governance`

The plan's state, policy and running totals. `hold_prev` remembers the state to return to when a hold is lifted. The totals satisfy `total_deposited == total_released + total_refunded + plan.balance_usdc` after every call.

### `DataKey`

Storage keys: `Config`, `Version` and `Paused` are instance entries; plans, installments and governance rows are persistent entries.

## Fields and variants

### `Error`

| Field or variant | Meaning |
| --- | --- |
| `Paused` | The admin paused deposits, locks, releases and refunds. |
| `PlanBlocked` | The plan is `OnHold`, `Defaulted`, `Cancelled` or `Completed`: no funds move. |
| `InvalidTransition` | The requested state change is not allowed from the current state or status. |
| `GraceNotOver` | The grace period after the due date has not elapsed yet. |
| `RefundNotAllowed` | Refunds are only possible on cancelled or defaulted plans. |
| `NotComplete` | Not every installment is released or waived yet. |
| `DefaultNotReached` | Fewer misses than the policy requires before a default can be declared. |
| `AssetFrozen` | The issuer froze the vault, the payee or the buyer; call `hold_frozen`. |
| `NotFrozen` | `hold_frozen` found every party of the plan still authorized by the issuer. |

### `PolicyConfig`

| Field or variant | Meaning |
| --- | --- |
| `grace_days` | Days after `due_ts` before an unpaid installment may be marked `Missed`. |
| `misses_before_default` | Misses (currently outstanding) required before `declare_default` is accepted; at least 1. |
| `penalty_bps` | Penalty on withdrawal, in basis points of the deposits (0..=10_000). Not applied on chain. |
| `refund_mode` | 0 = refund the whole balance, 1 = refund net of the penalty. Not applied on chain. |

### `Governance`

| Field or variant | Meaning |
| --- | --- |
| `misses` | Installments currently in `Missed`. |

### `Installment`

| Field or variant | Meaning |
| --- | --- |
| `due_ts` | Midnight UTC of the due day, in seconds. |
| `cop_due` | Whole pesos. |
| `locked_rate` | COP per USD × 1e7. |
| `usd_due` | Stroops. |
| `lock_expiry_ts` | Midnight UTC of the day after the grace period, in seconds. |

### `Plan`

| Field or variant | Meaning |
| --- | --- |
| `balance_usdc` | Stroops held by this contract on behalf of the plan. |

### `Config`

| Field or variant | Meaning |
| --- | --- |
| `usdc` | Stellar Asset Contract of the settlement asset. |
| `payee_backend` | The only address releases may be paid to. |

### `Released`

| Field or variant | Meaning |
| --- | --- |
| `spot` | `true` for a spot release of an open or broken installment, `false` for a locked one. |
