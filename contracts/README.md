# contracts/

Soroban contracts for Chateaux. Read `docs/STELLAR_NORMS.md` before changing versions: as of
2026-10-21 testnet and mainnet both run **protocol 29**, `soroban-sdk` is pinned at `=29.0.1`, the
stellar CLI is 28.1.0 and the build target is `wasm32v1-none`.

```
contracts/
  payment_plan/        # Rust, #![no_std], soroban-sdk pinned exactly
    Cargo.toml
    src/lib.rs         # the contract (constructor, plans, deposits, locks, releases, adverse events, pause, upgrade)
    src/test.rs        # unit tests, including the shared lock-math vectors, TTL and upgrade
    src/test_adverse.rs  # governance states, pause, refunds to the buyer only, funds conservation
    src/test_frozen.rs   # issuer freeze: AssetFrozen and hold_frozen
  test-vectors/        # lock_math.json: the same vectors services/src/lock/engine.test.ts checks
  rust-toolchain.toml
```

Build: `cd contracts && stellar contract build` → `target/wasm32v1-none/release/payment_plan.wasm`.
Tests: `cargo test` inside `contracts/`. The lock math the contract computes in fixed point
(`locked_rate` = COP per USD × 1e7, USDC in stroops, floor division) is mirrored in TypeScript by
`fixedPointRate` / `fixedPointUsdDue` in `services/src/lock/engine.ts`; both sides are checked
against `test-vectors/lock_math.json`.

## Testnet demo (DEMO_MODE=testnet)

The Stage 1 demo runs entirely on mocks. In testnet mode the same UI drives the same
`DemoApi`, but locks, deposits, releases and breaks are transactions on the `payment_plan`
contract on Stellar testnet. The hedge (NDF), the COP delivery and the US on-ramp stay mocked;
the on-ramp's USD becomes test USDC that is minted to the buyer and deposited on chain.

```
npm run deploy:testnet      # once: accounts, test asset, SAC, contract, seeded plans → .env.testnet
npm run demo:testnet        # UI on http://localhost:5174 in testnet mode
npm run smoke:testnet       # Node walk-through: reset, lock Q3, +1 mes, pay M4, read the chain
npm run test:e2e:testnet    # Playwright, skipped when .env.testnet or the RPC is missing
```

`deploy:testnet` is idempotent: it reads an existing `.env.testnet`, reuses the keys, skips
funding, trustlines, SAC, Wasm upload and the contract when they already exist and still answer,
and re-seeds only missing plans. `--fresh` deploys a new contract instance and new plans with the
same accounts. Explorer links: `https://stellar.expert/explorer/testnet/contract/<C...>`,
`.../account/<G...>`, `.../tx/<hash>`.

### What is on chain

| Piece | Testnet demo |
| --- | --- |
| Settlement asset | A platform **test asset** `USDC:<usdc_issuer>` issued by a throwaway testnet account. It only shares the code with Circle's USDC; the contract talks to its Stellar Asset Contract (SAC) through the standard token interface, exactly as it will with the real asset. |
| Accounts | `operator` (also contract `admin` for the demo), `payee_backend` (receives every release), `usdc_issuer`, and one platform-managed G-account per demo buyer (María, Andrés, Camila; "Modo demo"). All funded by friendbot; buyers, operator and payee hold a trustline to the test asset. |
| Contract | One `payment_plan` instance deployed with constructor args `(admin = operator, operator, usdc = SAC id, payee_backend)`. |
| Plans | Three `create_plan` calls (24 installments each) replaying the seed: María Q1 locked and released ×3, Q2 locked; Andrés Q1 locked, M1–M2 released, M3 broken, Q2 locked, M4 released; Camila two spot releases. "Reiniciar demo" repeats this with new plan ids (about twenty sequential transactions, 2 to 4 minutes on testnet). |
| Receipts | The receipt's transaction hash is the `release_due` / `release_spot` transaction, taken from the transaction result (hash, ledger). No indexer in this stage. |

Every write goes through one path (`services/src/chain/submit.ts`): build with the operator as
source, simulate, sign the buyer's authorization entries with `authorizeEntry` (for `deposit` and
`apply_lock`), simulate again in enforce mode, assemble, sign the envelope, send, poll
`getTransaction`. Contract errors (`Error(Contract, #n)`) become a `ChainError` with the enum name
(`NotDue`, `LockNotExpired`, ...), which `DemoApi` surfaces as `ApiError('PROVIDER')` so the UI
shows its error state.

### Time model

The demo clock is virtual ("+1 mes" moves `today` in the store), but the contract checks the
**real ledger close time** against `due_ts` (release of a locked installment) and `expiry_ts`
(break of a lock). For the testnet demo the seeded plans therefore get compressed dates:

- `due_ts(idx)` = the minute before the seed time + `idx` seconds: strictly ascending, as
  `create_plan` requires, and already in the past when the demo pays;
- `expiry_ts` of a lock applied during the demo (or seeded as live) = now + 60 s, so `break_lock`
  becomes possible one minute after locking, which is what the break job needs after "+1 mes";
- `expiry_ts` of a lock seeded as already broken (Andrés Q1) = the seed minute, so the seed can
  break it right away.

The contract's real-calendar rule (midnight UTC due dates, lock expiry the day after the grace
period) is unchanged and covered by the Rust tests. If the break job runs inside the one-minute
window the chain call fails and the store still records the break; the break is retried before
that installment is paid at spot. A per-plan time offset for demos is a Stage 4 design decision.

### Secrets

`.env.testnet` (gitignored by `.env.*`; `.env.example` is the tracked template) holds the secret
keys of the operator, the issuer, the payee and the three buyers under `VITE_`-prefixed names, so
Vite ships them to the browser: in this stage the demo "backend" runs in the page. This is
acceptable for throwaway testnet accounts only. A pilot moves signing behind a server (operator,
issuer) and a wallet or passkey (buyer), and the variable names change so no mainnet key can ever
take this route.
