# Running Casa Puente

Exact commands for Windows (PowerShell, from the repo root). The same npm scripts work in any shell on macOS or Linux.

The app runs in two modes with identical screens:

| Mode | What runs | Ports |
| --- | --- | --- |
| `mock` | Vite only; every provider is an in-browser mock with a demo clock | web 5173 |
| `testnet` | Vite, the Casa Puente server (holds every key, signs every transaction), the simulated Colombian receiving anchor | web 5174, server 8787, receiver 8788 |

## Deployed contract

contract [`CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP`](https://stellar.expert/explorer/testnet/contract/CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP) on Stellar testnet, running Wasm `a28d240c3728f3415b73218597bb4b9f23c77384c4d7beda77a57300e88755b1` (schema v2). It is **one version behind this branch**: the code here builds Wasm `8d2a440260ae26ad2ebe15abb91180208f631bd37d5dfe219f17c666bd3899ad`, which adds the typed `AssetFrozen` error and `hold_frozen`. The upgrade is blocked by testnet itself: the network's Soroban state is above its target size, so rent on a new Wasm entry is steep and the upload needs about 738 XLM in fees, more than the 429.5 XLM one transaction can carry (measured 2026-10-25). Shrinking the Wasm barely moves that fee. `npm run deploy:testnet` reports this and keeps the running contract; rerun it when the fee falls below the limit. Everything else on testnet (plans, payments, the adverse functions of schema v2) runs on the deployed version.

## Prerequisites

- Node.js 22.12 or newer (`@stellar/typescript-wallet-sdk` 5.x needs it) and npm.
- Testnet mode also needs internet access to `soroban-testnet.stellar.org`, `horizon-testnet.stellar.org`, `friendbot.stellar.org` and `testanchor.stellar.org`.
- Only to rebuild the contract: Rust (pinned by `rust-toolchain.toml`) with the `wasm32v1-none` target and the Stellar CLI 28.x. `npm run deploy:testnet` uploads `contracts/target/wasm32v1-none/release/payment_plan.wasm`, so build it once first.

```powershell
npm install
```

## Mock mode

```powershell
npm run demo:mock
```

Opens http://localhost:5173. No keys, no network, no server. "Reiniciar demo" in the demo bar restores step 1; `npm run reset` times the same reset from the command line.

## Testnet mode

### 1. Build and deploy (once, and after every contract change)

```powershell
cd contracts; stellar contract build; cd ..
npm run deploy:testnet
```

`deploy:testnet` is idempotent. It funds the accounts (operator, payee backend, USDC issuer, three buyers, eight channel accounts, the receiver) with friendbot, creates the trustlines and the test-USDC asset contract, uploads the Wasm, and deploys `payment_plan`. If a contract already exists and runs an older Wasm, it upgrades it in place with `upgrade` + `migrate`, so the address and the plans are kept. Then it seeds the three demo plans. It writes everything to `.env.testnet` at the repo root, which is gitignored and holds testnet secrets only. `npm run deploy:testnet -- --fresh` deploys a new contract instance and keeps the accounts.

### 2. Start the demo

```powershell
npm run demo:testnet
```

This one command:

1. starts the receiving anchor on :8788 unless one already answers (skip it with `OFFRAMP=mock`);
2. starts the server on :8787 (`npm run server:testnet`) unless a testnet server already answers;
3. waits for `GET http://localhost:8787/health`. If the server's startup check finds that the seeded plans were already used by an earlier run, it re-seeds them (pass `-- --no-auto-reset` to skip);
4. starts Vite in testnet mode on :5174 and opens the browser (pass `-- --no-open` to keep it closed).

Ctrl+C stops everything it started. The browser only talks to `/api`, which Vite proxies to the server. No key and no `VITE_*` key variable reaches the bundle; `npm run check:bundle` builds the web app in testnet mode and fails if the output contains a secret seed, any secret value from `.env.testnet`, or a secret variable name.

"Reiniciar demo" on testnet re-seeds the three plans on chain in parallel on the channel accounts. It was measured at 21–24 s (wall clock, three runs on 2026-10-24).

### 3. Useful endpoints and scripts

| Command | What it does |
| --- | --- |
| `curl.exe http://localhost:8787/health` | mode, contract, `needsReset`, per-plan startup check, indexer cursor, jobs, rails |
| `curl.exe http://localhost:8787/indexer` | indexer stats; `?plan=<chain plan id>` lists that plan's events |
| `npm run jobs:run` | lists the jobs and their last runs |
| `npm run jobs:run -- ttl-keeper` | manual run of the TTL keeper (it warns when a plan has under 30 days of TTL left) |
| `npm run sim:testnet` | a month of mixed plans through the real stack; writes `docs/demo-runs/<date>-sim.md` |
| `npm run smoke:testnet` | short contract smoke test |
| `npx tsx scripts/onramp-sep24-check.mts` | one SEP-24 deposit against testanchor.stellar.org |
| `npx tsx scripts/offramp-sep31-check.mts` | one SEP-31 payout against the receiver at `OFFRAMP_HOME_URL` |

Runtime data (indexer events and cursor, receipts, the server snapshot, the receiver's customers, quotes and transactions) lives under `.data/`, which is gitignored. To start the indexer from scratch, stop the server and delete `.data\indexer`; on restart it reads back from the contract's deploy ledger, or from the oldest ledger the RPC still holds. A restart without deleting it resumes from the stored cursor, and writes are keyed by event id, so no event or receipt is duplicated.

## Off-ramp counterparty: `infra:up`

```powershell
npm run infra:up
```

Starts the simulated Colombian receiving anchor ("Ancla receptora simulada (Colombia)", `infra/receiver`) on its own, in plain Node, on http://localhost:8788. `demo:testnet` starts it by itself, so you only need this to watch its logs in a separate terminal or to run `sim:testnet` or the SEP-31 check without the full demo. It serves SEP-1 (`/.well-known/stellar.toml`), SEP-10, SEP-12 (the receiver is encargo FD-OLV-0142 at Fidudavivienda), SEP-38 (exact COP quotes from the demo curve) and SEP-31. A transaction moves `pending_sender → pending_stellar → pending_receiver → completed` when the testnet USDC payment with the right memo arrives on Horizon.

```powershell
npm run infra:up -- --anchor-platform
```

Starts the Stellar Anchor Platform 4.9.0 from `infra/anchor-platform/` with Docker Compose instead. **This has not been run yet**: Docker is not available on the development machine. See `infra/anchor-platform/README.md`.

Switching receivers is one setting in `.env.testnet`, followed by a restart of the server:

```
OFFRAMP_HOME_URL=http://localhost:8788   # simulated receiver (default)
OFFRAMP_HOME_URL=http://localhost:8080   # Anchor Platform (see its README for the port)
```

Other switches: `ONRAMP=sep24|mock`, `OFFRAMP=sep31|mock`, `SERVER_PORT`, `RECEIVER_PORT`, `INDEXER_POLL_MS`, `RECEIPT_WAIT_MS`.

## Which asset the plans use, and why

The plans hold **the platform's test USDC**: asset code `USDC`, issued by a throwaway testnet account that `deploy:testnet` creates (`USDC_ISSUER`). It is not Circle's testnet USDC (`USDC:GBBD47…FLA5`). The reasons:

- The SDF test anchor caps a SEP-24 USDC deposit at **10 USDC per transaction** and keeps a 10 % reference fee, but one installment is about **1,188 USD**. Circle's testnet USDC cannot be minted by us, so it cannot fund real installment amounts.
- The contract and the UI exercise exactly the same path either way: a Stellar asset contract with 7 decimals and the code `USDC`. On mainnet the asset is Circle USDC, which is a configuration value (`USDC_SAC_ID`).

So the on-ramp runs for real: every testnet payment first completes one SEP-24 deposit against testanchor.stellar.org (SEP-10, then the interactive flow driven over HTTP, with Circle testnet USDC paid to the buyer's trustline). The installment itself is then funded with test USDC minted by our issuer. Each buyer account holds trustlines to both assets.

## Tests

```powershell
npm test                      # services and web unit tests
npx vitest run --root infra/receiver
npm run typecheck
npm run test:e2e              # Playwright, mock mode (port 5173); $env:E2E_PORT=5175 first if another checkout's Vite holds 5173
npm run test:e2e:testnet      # Playwright, testnet (ports 5174 and 8787), up to 15 minutes
cd contracts; cargo test; cd ..
```

`test:e2e:testnet` has a globalSetup (`web/e2e/testnet.global-setup.ts`). It skips when `.env.testnet` is missing or the RPC is unhealthy. It reuses a server on :8787 only when `/health` answers `mode: testnet` and fails on anything else. With no server running, it runs `deploy:testnet`, then starts the receiver and the server. It re-seeds used plans. The spec checks `http://localhost:5174/api/health` before its first step, so a Vite left running in mock mode is never reused.

## Troubleshooting

- **`.env.testnet uses the old VITE_-prefixed key names`**: run `npm run deploy:testnet` once; it migrates the file.
- **`port 8787 answers but not as the testnet server`**: something else holds the port. Stop it, or set `SERVER_PORT` for both the server and Vite.
- **`getEvents failed (fetch failed)` in the server log**: the public RPC dropped a request. The indexer retries on the next poll from the same cursor.
- **Payments answer with a receipt marked pending**: the indexer had not seen the release within `RECEIPT_WAIT_MS` (45 s). The receipt appears in the list once the next poll indexes it.
