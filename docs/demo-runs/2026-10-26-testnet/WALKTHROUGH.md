# Testnet run, 2026-10-26

Both corridors ran end to end on Stellar testnet with real transactions. Every hash below was
re-verified with RPC `getTransaction` (status `SUCCESS`) before it was listed. The full list is
in [`evidence/testnet-2026-10-26.json`](../../../evidence/testnet-2026-10-26.json): 84
transactions with their step, contract set, corridor, contract, ledger, time, fee and explorer link.

## Contracts (headline)

`stellar contract build` at tag `testnet-2026-10-26` produces Wasm
`8d2a440260ae26ad2ebe15abb91180208f631bd37d5dfe219f17c666bd3899ad` (31,104 bytes). The headline
instances run exactly that Wasm:

| Corridor | Contract | Replaces |
| --- | --- | --- |
| Colombia | [`CA3NE2EXQLDDDXUZCAEWX2UFUMCWI4CYS32YGXQHLTJE7KTRW35D6WD2`](https://stellar.expert/explorer/testnet/contract/CA3NE2EXQLDDDXUZCAEWX2UFUMCWI4CYS32YGXQHLTJE7KTRW35D6WD2) | `CAVPFFH4…CTXP` |
| El Salvador | [`CACDLCHAKPJDVYRKJKK3KKMEBLBKLTYISYX6EQO54VQIZJX3CTUTVQGA`](https://stellar.expert/explorer/testnet/contract/CACDLCHAKPJDVYRKJKK3KKMEBLBKLTYISYX6EQO54VQIZJX3CTUTVQGA) | `CC5Y77X3…LEBQ` |

- Why new instances: the operator stored in the old instances (`GB73VDL7…HS7A`) is not the key in
  `.env.testnet`, and the contract cannot rotate its operator. Operator and admin of the new
  instances are `GA6PFKPK…SLW6`.
- **Config still points to the old ids.** The owner of `config/**` and the env must set
  `PAYMENT_PLAN_CONTRACT_ID` and `PAYMENT_PLAN_CONTRACT_ID_SV` to the ids above.
- Settlement asset: a **demo-issued test dollar**, `USDC:GDOLIJWX…MXHE`, SAC
  `CCZ5L37ETD5D4KDSDN24PHMO6WPMH3MJTXFGMAANSTR5DCDZIW6P6S35`. Its issuer has no auth, revocable or
  clawback flag. It is not Circle USDC.
- Payees: Colombia `GBGWHCPA…6SW4`, El Salvador `GBGOMSVG…SHUT`. Both are testnet-only accounts.
- **On the El Salvador instance the `cop_due` field holds USD cents.** For example, `75000` means
  USD 750.00, and the contract releases it at cents × 100,000 = 7,500,000,000 stroops. The field
  name comes from the Colombian design; the corridor config (`decimals: 2`) decides the unit.

## Who signs what

| Step | Signer (auth) | Who pays the fee |
| --- | --- | --- |
| `create_plan` | operator (inner tx source) | pool account, as a fee-bump |
| `deposit` | **buyer** (`lib.rs:820` requires it; USDC moves from the buyer) | fee payer, as a fee-bump |
| `apply_lock` | operator + buyer (signed auth entry) | operator |
| `release_due`, `release_spot` | operator | operator |

The buyers are testnet demo accounts. In the demo the platform holds their keys: "cuenta de
demostración: la plataforma actúa por el comprador". Their secrets are in the gitignored
`.env.testnet-generated` and are never printed or committed.

## Colombia story: plan 1004

| Step | Tx | Ledger | Fee (XLM) |
| --- | --- | --- | --- |
| create_plan, 3 × COP 4,093,125, M1 due yesterday (fee-bump) | [`604dc03c…400c8`](https://stellar.expert/explorer/testnet/tx/604dc03c6a8752e0474ff769ce93162177e459956559d613dc007b5ac60400c8) | 5,397,945 | 0.2791889 |
| deposit 11,883,326,312 (buyer-signed) | [`7b655243…286d9`](https://stellar.expert/explorer/testnet/tx/7b65524307a07a3ba2bc4d2fa371c1b8f85cf1ac4dd56dccdf60a0e833f286d9) | 5,397,947 | 0.0106351 |
| apply_lock [0,1,2] at 34444270000, expiry = M3 due + 7 days | [`45c5f39a…322b6`](https://stellar.expert/explorer/testnet/tx/45c5f39a7a46eced3c69b018e19b2e07953f75e19a9dabf73e8d901aca3322b6) | 5,397,949 | 0.0393005 |
| release_due M1 → **11,883,326,312** (asserted) | [`3b191798…bb84c`](https://stellar.expert/explorer/testnet/tx/3b1917981c6cd9a79c91d1a935f9cd8f3c8e9f11b6b899a991ee88dd8b0bb84c) | 5,397,951 | 0.0011973 |

`node scripts/testnet/show-plan.mjs co 1004`:

| idx | due (UTC) | amount (cop_due field) | status | locked rate | usd_due | lock expiry |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 2026-10-25 | COP 4,093,125 | Released | 3444.427 | 1188.33 | 2027-01-01 |
| 1 | 2026-11-25 | COP 4,093,125 | Locked | 3444.427 | 1188.33 | 2027-01-01 |
| 2 | 2026-12-25 | COP 4,093,125 | Locked | 3444.427 | 1188.33 | 2027-01-01 |

## El Salvador story: plan 2004

| Step | Tx | Ledger | Fee (XLM) |
| --- | --- | --- | --- |
| create_plan, 3 × 75000 cents, M1 due yesterday (fee-bump) | [`96c78785…8a396`](https://stellar.expert/explorer/testnet/tx/96c787856c023a14982a7ce00ea00bace40f341a1bc8096dd9b8051d5c48a396) | 5,397,957 | 0.2791889 |
| deposit 7,500,000,000 (buyer-signed) | [`a451f54f…202dd0`](https://stellar.expert/explorer/testnet/tx/a451f54f60cd36680b68b943502ace0a9abb5621a35547097c5940a937202dd0) | 5,397,959 | 0.0106351 |
| release_spot M1 → **7,500,000,000** (asserted) | [`87483b6c…a8849`](https://stellar.expert/explorer/testnet/tx/87483b6c7aee9461d28c6859711656988b0a5a25bdc986f09d1df621503a8849) | 5,397,961 | 0.0012025 |
| apply_lock on corridor `sv` (service layer) | refused before any tx: `LocksDisabledError`, code `LOCKS_DISABLED` | n/a | 0 |

`node scripts/testnet/show-plan.mjs sv 2004`:

| idx | due (UTC) | amount (cop_due field) | status | locked rate | usd_due | lock expiry |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 2026-10-25 | USD 750.00 (75000 cents) | Released | - | - | - |
| 1 | 2026-11-25 | USD 750.00 (75000 cents) | Open | - | - | - |
| 2 | 2026-12-25 | USD 750.00 (75000 cents) | Open | - | - | - |

## Live-demo pool

Listed in [`pool-8d2a.json`](pool-8d2a.json). In every plan M1 is already due and deposited.
`create_plan` accepts a past `due_ts` (`lib.rs:763-768` checks only that due dates increase), so
no waiting is needed. Colombia plans are also locked (expiry = M3 due + 7 days), so the live step
is a single release:

| Plans | Contract | Live step |
| --- | --- | --- |
| 1201, 1202, 1203 | Colombia `CA3NE2EX…6WD2` | `release_due(plan, 0)`: pays 11,883,326,312 stroops |
| 2201, 2202, 2203 | El Salvador `CACDLCHA…VQGA` | `release_spot(plan, 0, 7500000000)` |

## First run (superseded)

The first run of the day used instances deployed from the already-installed Wasm `a28d240c…755b1`
(Colombia `CDSXCY3K…TFZV`, El Salvador `CCNWBC5N…22MF`), with the same operator, asset and payees.
It passed the same gates: plan 1001 released 11,883,326,312, plan 2001 released 7,500,000,000, and
the SV lock refusal was captured. It also has a pool (1101–1103, 2101–2103; [`pool.json`](pool.json)).
It is superseded because the tagged source builds `8d2a4402`, not `a28d240c`. Its transactions stay
in the evidence with `contractSet: "superseded"`, and its screenshots are in `screenshots/first-run/`.

**Plan 1001: first run; lock expiry rule fixed afterwards.** Its lock expiry was set to now + 30
days (2026-11-25). That is M2's due date and a month before M3's (2026-12-25). `apply_lock` only
accepts `Open` installments, so the plan cannot be re-locked and stays as recorded. Every later lock
uses expiry = the last locked installment's due date + 7 days.

## Costs (XLM, fees charged per Horizon)

| | XLM |
| --- | --- |
| Setup: trustlines, test-dollar SAC, Wasm upload, 4 instance deploys | 34.9477319 |
| Headline stories (1004, 2004) | 0.6213883 |
| Headline pool (6 plans, buyer funding, deposits, 3 locks) | 1.7996619 |
| Superseded first run (stories and pool on the a28d pair) | 2.4210439 |
| **Total** | **39.7898260** |

Inside setup: the `8d2a` Wasm upload cost 2.0304609, the first `8d2a` instance (Colombia)
32.6984771, and each later instance 0.0712406. The 32.7 XLM is **rent**: 32.6980303 XLM of
`rent_fee_charged`. The constructor's `instance().extend_ttl` also extends the contract **code**
entry. The just-uploaded code had the minimum TTL (until ledger 5,517,693), and the first
instantiation extended it to 7,470,335 (120 days) for 31 KB of code. Later instances found the code
already extended. One `create_plan` costs 0.2791889 XLM. The 1,008 XLM measured on 2026-10-25 no
longer applies (see the norms ledger).

## Screenshots

`screenshots/`: both headline contract pages and the seven headline story transactions on
stellar.expert. Each page was checked to show its contract id or transaction hash
(`screenshots/screenshots.json`).

## Re-running

```bash
node scripts/testnet/preflight.mjs                     # balances, network, wasm hashes
node scripts/testnet/show-plan.mjs co 1201             # any plan's on-chain state (--set a28d for the first run)
node scripts/testnet/evidence.mjs                      # re-verify every hash, rewrite the evidence
```
