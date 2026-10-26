# Running Chateaux

Exact commands for Windows (PowerShell, from the repo root). The same npm scripts work in any shell on macOS or Linux.

The app runs in two modes with identical screens:

| Mode | What runs | Ports |
| --- | --- | --- |
| `mock` | Vite only; every provider is an in-browser mock with a demo clock | web 5173 |
| `testnet` | Vite, the Chateaux server (holds every key, signs every transaction), the simulated Colombian receiving anchor | web 5174, server 8787, receiver 8788 |

## Deployed contract

contract [`CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV`](https://stellar.expert/explorer/testnet/contract/CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV) (Colombia) and [`CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF`](https://stellar.expert/explorer/testnet/contract/CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF) (El Salvador) on Stellar testnet, both running Wasm `a28d240c3728f3415b73218597bb4b9f23c77384c4d7beda77a57300e88755b1` (schema v2), deployed 2026-10-26 with a new operator and a demo-issued test dollar (not Circle USDC); they replace `CAVPFFH4…CTXP` and `CC5Y77X3…LEBQ`, whose operator key is no longer available. The code here builds Wasm `8d2a440260ae26ad2ebe15abb91180208f631bd37d5dfe219f17c666bd3899ad` (adds the typed `AssetFrozen` error and `hold_frozen`). Its upload is no longer blocked: testnet's Soroban state target rose to 7 GB and the upload cost 2.03 XLM on 2026-10-26 (it was ~738 XLM on 2026-10-25). Evidence of the 2026-10-26 run: [evidence/testnet-2026-10-26.json](../evidence/testnet-2026-10-26.json).

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

## El Salvador corridor

El Salvador plans are in USD, have no rate lock and pay out to the seller (option A or B). They run on
a **second instance** of the same Wasm, with its own payee:

| Corridor | Contract | Wasm |
| --- | --- | --- |
| Colombia | [`CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV`](https://stellar.expert/explorer/testnet/contract/CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV) | `a28d240c…755b1` (2026-10-26; replaces `CAVPFFH4…CTXP`) |
| El Salvador | [`CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF`](https://stellar.expert/explorer/testnet/contract/CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF) | `a28d240c…755b1` (2026-10-26, from the installed hash, no upload; replaces `CC5Y77X3…LEBQ`). On this instance the `cop_due` field holds USD cents. |

Corridor details (holidays, MoneyGram limits, payout options, the seller gate) are in
[CORRIDORS.md](CORRIDORS.md).

### Mock

```powershell
npm run demo:mock
```

Then open, on http://localhost:5173:

| URL | Surface |
| --- | --- |
| `/#/comprador/plan-roxana` | buyer phone view, Roxana (pays cash; MoneyGram reference pending) |
| `/#/comprador/plan-doris` | buyer in Louisiana: MoneyGram hidden |
| `/#/c/plan-roxana/pagar` | WhatsApp deep link: opens the pay sheet |
| `/#/oficina/mostrador` | office counter (touch) |
| `/#/oficina/escritorio` | office desk: Planes, Vendedores, Pagos al vendedor, outbox |

To run beside another checkout, move the port first: `$env:PORT=5176; npm run demo:mock`.

### Reset

```powershell
npm run reset
```

Rebuilds both corridors' seed in a fresh in-memory store and prints the time (limit 10 s) with
María's and Roxana's step-1 state. In the browser, click "Reiniciar demo" or open
`http://localhost:5173/?reset=1`.

### Testnet

```powershell
npm run deploy:testnet    # once: accounts, test USDC and the Colombia instance
npm run deploy:sv         # once: the El Salvador buyers, payee and instance (reuses what exists)
npm run demo:testnet
```

The server logs one line per instance at startup (`instance sv: contract CC5Y77…`). Without
`PAYMENT_PLAN_CONTRACT_ID_SV` in `.env.testnet` the server still starts and the El Salvador plans
stay off chain. "Reiniciar demo" (or `curl.exe -X POST http://localhost:8787/api/reset -H "Content-Type: application/json" -d '{\"args\":[]}'`) seeds each
plan on the instance of its own corridor.

**Testnet rent limitation (2026-10-25).** Testnet's Soroban state is above its target size, so rent
on new ledger entries is steep. Creating a plan simulates at about **1,008 XLM for 3 installments and
4,929 XLM for 24** on both instances, above the **429.5 XLM** one transaction can carry (the fee field
is a uint32 of stroops). The services do not retry and do not spend: when `create_plan` is refused,
a reset keeps the plan's existing chain plan if the instance still holds it (and shows it as it
stands on chain), and otherwise runs the plan off chain, recorded in `demo_state.simulatedPlans` with
the reason and logged by the server (`reset: plan-roxana: create_plan refused (...); the plan runs off
chain, marked simulado`). Expected today: the Colombia plans seeded in earlier stages are kept, and every El Salvador plan
runs off chain (none was ever created on the El Salvador instance). `POST /api/getDemoState` shows
which (`chainPlans`, `simulatedPlans`). Do not run
`npm run check:sv-testnet` expecting a plan: its `create_plan` is refused by simulation for the same
reason (nothing is sent, nothing is spent).

### `.env.testnet` keys added for El Salvador

Names only; `deploy:sv` writes the values. Never commit or print the file.

| Key | What |
| --- | --- |
| `PAYMENT_PLAN_CONTRACT_ID_SV` | El Salvador instance |
| `PAYEE_BACKEND_SV_PUBLIC`, `PAYEE_BACKEND_SV_SECRET` | El Salvador payee (the release target) |
| `INDEXER_START_LEDGER_SV` | first ledger the El Salvador indexer reads |
| `BUYER_PUBLIC_ROXANA`, `BUYER_SECRET_ROXANA`, and the same for `MARVIN`, `DORIS`, `OSCAR` | demo buyer accounts |
| `CHAIN_PLAN_ROXANA`, `CHAIN_PLAN_MARVIN`, `CHAIN_PLAN_DORIS`, `CHAIN_PLAN_OSCAR` | optional: chain plan ids, written only once a plan exists on chain (none today) |

The indexer of the El Salvador instance keeps its data under `.data\indexer-sv`.

## Tests

```powershell
npm test                      # services and web unit tests, then npm run check:db and npm run check:names
npm run check:db              # applies every migration to PGlite (no Docker) and runs the RLS allow/deny cases
npm run check:names           # fails on the previous product name outside its allowlist (scripts/check-names.mts)
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
