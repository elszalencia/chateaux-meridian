# Architecture

Casa Puente has four layers: a React app with three views, a framework-free TypeScript service layer, the `payment_plan` Soroban contract on Stellar, and the anchors that turn dollars into USDC in the US and USDC into pesos in Colombia. Every external dependency sits behind an interface, so the same UI and service code run on mocks (`DEMO_MODE=mock`) or against testnet (`DEMO_MODE=testnet`).

```mermaid
flowchart LR
  subgraph Browser
    C[Comprador view]
    B[Constructora / Fiducia view]
    T[Tesorería view]
  end
  subgraph Services["services/ (TypeScript)"]
    API[DemoApi façade]
    LE[Lock engine]
    POL[Policy layer<br/>PolicyEngine · NullPolicy<br/>runAdverseEventsDaily]
    ST[(Store)]
    AD[Provider interfaces<br/>Lock · Hedge · OnRamp · OffRamp · Governance]
  end
  subgraph Stellar
    PP[payment_plan contract]
    SAC[USDC asset contract]
  end
  subgraph Anchors
    ON[US on-ramp<br/>SEP-24]
    OFF[Colombian receiving anchor<br/>SEP-31]
  end
  HB[Hedge bank<br/>NDF strip]
  FID[Fidudavivienda<br/>encargo fiduciario]

  C & B & T --> API
  API --> LE & POL & ST & AD
  POL --> AD
  AD -->|mock or chain bridge| PP
  PP <--> SAC
  AD --> ON & OFF & HB
  OFF -->|COP| FID
```

## Layers

| Layer | Path | Responsibility |
| --- | --- | --- |
| Web | `web/src/views/{comprador,constructora,tesoreria}` | The three views of brief §7. Every string comes from `web/src/i18n/{es,en}.json` (Spanish default, key parity tested). Buyer screens never show crypto vocabulary (`web/src/tests/vocabulary.test.ts`). |
| Façade | `services/src/api/DemoApi.ts`, `views.ts` | One object the web app calls: quotes, locks, payments, pay-ahead, the clock, reset and the read models for each view, including governance state and buyer notices. |
| Lock engine | `services/src/lock/engine.ts` | All money math: forward-points pricing, pass-through, USD per installment, break cost, business-day rules with Colombian festivos. Float form for display, fixed-point form identical to the contract (checked against `contracts/test-vectors/lock_math.json`). |
| Providers | `services/src/adapters/interfaces.ts`, `services/src/policy/GovernanceProvider.ts` | `LockProvider`, `HedgeProvider`, `OnRampProvider`, `OffRampProvider`, `GovernanceProvider`. Mock implementations add latency and share one error switch; testnet implementations call the chain or the anchors. |
| Chain | `services/src/chain/` | Soroban RPC client and the bridge that turns façade calls into `payment_plan` transactions. |
| Policy | `services/src/policy/` | Adverse events: reason codes, the TypeScript mirror of the contract's transition rules, evidence hashes, the `PolicyEngine` seam with `NullPolicy`, and the daily run. See [ADVERSE_EVENTS.md](ADVERSE_EVENTS.md). |
| Store | `services/src/store/` | `Store` interface with an in-memory implementation (persisted to `localStorage` in the browser). The Supabase schema in `supabase/migrations/` has the same tables. |
| Contract | `contracts/payment_plan/src/lib.rs` | USDC custody per plan, rate locks, releases to the payee backend, adverse-event governance, admin pause, upgrade and schema migration. |
| Anchors | `infra/` | A simulated Colombian receiving anchor (SEP-31) in Node and the Anchor Platform configuration. |

## Contract

`payment_plan` (soroban-sdk `=29.0.1`, protocol 29, schema version 2).

- **Storage.** Instance: `Config` (admin, operator, USDC asset contract, payee backend), `Version`, `Paused`. Persistent, per plan: `Plan` (buyer, count, balance), `Inst(plan, idx)` per installment, `Gov(plan)` (state, misses, hold, policy, totals). `extend_ttl` (anyone) keeps all of a plan's entries alive.
- **Roles.** Admin: `upgrade`, `migrate`, `pause`, `unpause`, `cancel_plan`. Operator: `create_plan`, `apply_lock` (with the buyer), `release_due`, `release_spot`, `break_lock`, and the adverse-event functions. Buyer: `deposit`. Anyone: `extend_ttl`, `hold_frozen` and the getters.
- **Where USDC can go.** A release pays `payee_backend` only. A refund, or the leftover at completion, pays the plan's buyer only. Nothing else transfers.
- **Errors.** Typed (`Error`, codes 1–27). A transfer refused because the issuer froze a party returns `AssetFrozen` (26), distinct from any other `TransferFailed` (15).
- **Events.** `PlanCreated`, `Deposited`, `LockApplied`, `Released`, `LockBroken`, `PauseChanged`, and one event per adverse transition carrying the reason code and evidence hash.

## Money flow

```mermaid
sequenceDiagram
  autonumber
  participant Buyer as Buyer (US bank)
  participant On as US on-ramp (SEP-24)
  participant PP as payment_plan
  participant Payee as Payee backend
  participant Off as CO anchor (SEP-31)
  participant Fid as Fidudavivienda
  Buyer->>On: ACH debit, USD
  On->>Buyer: USDC to the buyer's account
  Buyer->>PP: deposit(plan, amount)
  Note over PP: balance held per plan
  PP->>Payee: release_due(idx) at the locked usd_due<br/>or release_spot(idx, amount)
  Payee->>Off: SEP-31 send, USDC
  Off->>Fid: COP to the encargo
  Fid-->>Payee: reconciliation (encargo, COP credited)
```

The hedge runs beside this flow: when a lock is accepted, treasury books the matching NDF legs (`HedgeProvider.bookStrip`); at each due date the NDF settles in COP, and the difference between the hedge's COP and the COP owed is treasury's margin (brief §9).

## Lock flow

```mermaid
sequenceDiagram
  autonumber
  participant UI as Comprador view
  participant API as DemoApi
  participant LE as Lock engine
  participant PP as payment_plan
  UI->>API: quote(plan, Mensual or Trimestral)
  API->>API: refuse past the cutoff (3 business days before the first due date)
  API->>LE: spot, forwards, pass-through → locked_rate, usd_due
  API-->>UI: quote, valid 10 minutes, disclosures
  UI->>API: acceptLock(quoteId)
  API->>API: refuse if expired, already used, an installment is no longer open, or the plan is blocked
  API->>PP: apply_lock(idxs, lock_id, locked_rate × 1e7, expiry) signed by operator and buyer
  PP-->>API: LockApplied
  Note over PP: unpaid after grace → break_lock → Broken, payable at spot
```

## Adverse-event flow

```mermaid
flowchart TD
  J[adverse-events-daily<br/>runAdverseEventsDaily] --> F{funds allowed?<br/>Active or Delinquent}
  F -- no --> S[skip]
  F -- yes --> H[hold_frozen check]
  H -- issuer froze a party --> OH[OnHold, reason 304]
  H -- not frozen --> P[PolicyEngine.evaluate<br/>NullPolicy]
  P -->|record| R[policy_events: late_in_grace,<br/>default_eligible]
  P -->|act| X[performAdverseAction]
  X --> D[dry-run applyTransition] --> E[evidence hash] --> G[GovernanceProvider → contract]
  G -- ok --> W[write governance, installments,<br/>policy_events]
  G -- AssetFrozen --> OH
  G -- other error --> AF[policy_events: action_failed]
  O[Operator: cure, waive, declare_default,<br/>place_hold, lift_hold, cancel_plan, refund,<br/>complete_plan] --> X
```

The job is registered by the job registry under `adverse-events-daily`. Its report includes a funds-conservation check: receipts plus held balances plus refunds must be equal before and after the run.

## Modes

| | Mock (`DEMO_MODE=mock`) | Testnet (`DEMO_MODE=testnet`) |
| --- | --- | --- |
| Contract | `MockGovernanceProvider` and mock lock provider mirror the contract rules | `payment_plan` on Stellar testnet |
| USDC | Simulated | A platform-issued test asset (not Circle's) |
| On-ramp, off-ramp, hedge | Mocks with latency and an error switch | Anchors as listed in [RUNNING.md](RUNNING.md); the hedge stays simulated |

How to run each mode: [RUNNING.md](RUNNING.md).
