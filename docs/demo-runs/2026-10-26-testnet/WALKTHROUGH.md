# Testnet run, 2026-10-26

Both corridors ran end to end on Stellar testnet with real transactions. Every hash below was
re-verified with RPC `getTransaction` (status `SUCCESS`) before it was listed. The full list is
in [`evidence/testnet-2026-10-26.json`](../../../evidence/testnet-2026-10-26.json): 46
transactions with their step, corridor, contract, ledger, time, fee and explorer link.

## Contracts

| Corridor | Contract | Wasm | Replaces |
| --- | --- | --- | --- |
| Colombia | [`CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV`](https://stellar.expert/explorer/testnet/contract/CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV) | `a28d240c…755b1` | `CAVPFFH4…CTXP` |
| El Salvador | [`CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF`](https://stellar.expert/explorer/testnet/contract/CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF) | `a28d240c…755b1` | `CC5Y77X3…LEBQ` |

- Why new instances: the operator stored in the old instances (`GB73VDL7…HS7A`) is not the key in
  `.env.testnet`, and the contract cannot rotate its operator. Both new instances were deployed from
  the already-installed Wasm (no upload). Operator and admin are `GA6PFKPK…SLW6`.
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

## Colombia story: plan 1001

| Step | Tx | Ledger | Fee (XLM) |
| --- | --- | --- | --- |
| create_plan, 3 installments of COP 4,093,125 (fee-bump) | [`fdb7d7b9…ba98a`](https://stellar.expert/explorer/testnet/tx/fdb7d7b97e08b21d3bb1039020a4767ae979e892e68f4aa95966345c516ba98a) | 5,396,993 | 0.2791889 |
| deposit 11,883,326,312 (buyer-signed) | [`9da3c22c…166b6`](https://stellar.expert/explorer/testnet/tx/9da3c22c528e9081a9bd5f8dd0c6f4b194e35a6c63a57a58d6e7ad3fa83166b6) | 5,397,015 | 0.0106351 |
| apply_lock [0,1,2] at 3444.427 × 10^7 | [`d67e4461…492e4`](https://stellar.expert/explorer/testnet/tx/d67e446143f219227162f646c79b65d428206c0e6b5783dc4b7b6c67691492e4) | 5,397,017 | 0.0393002 |
| release_due M1 → **11,883,326,312** (asserted) | [`6f5726af…1ca49`](https://stellar.expert/explorer/testnet/tx/6f5726af8d87c4c0f2343b9b0d85e1d6a065143818b243296f56bff2cad1ca49) | 5,397,018 | 0.0011973 |

`node scripts/testnet/show-plan.mjs co 1001`:

| idx | due (UTC) | amount (cop_due field) | status | locked rate | usd_due | lock expiry |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 2026-10-25 | COP 4,093,125 | Released | 3444.427 | 1188.33 | 2026-11-25 |
| 1 | 2026-11-25 | COP 4,093,125 | Locked | 3444.427 | 1188.33 | 2026-11-25 |
| 2 | 2026-12-25 | COP 4,093,125 | Locked | 3444.427 | 1188.33 | 2026-11-25 |

**Known issue on 1001:** its lock expiry was set to now + 30 days (2026-11-25). That is the same
day M2 is due and a month before M3. `apply_lock` only accepts `Open` installments, so the plan
cannot be re-locked, and it stays as recorded. The script now sets expiry to the due date of the
last locked installment + 7 days. Pool plans 1101–1103 use the fix (expiry 2027-01-01).

## El Salvador story: plan 2001

| Step | Tx | Ledger | Fee (XLM) |
| --- | --- | --- | --- |
| create_plan, 3 installments of 75000 cents (fee-bump) | [`3f5d8832…bd1f2`](https://stellar.expert/explorer/testnet/tx/3f5d8832a4fbbf4a0dbb374c87b4fe1db636eaa84e090344eee0eddc5dabd1f2) | 5,397,035 | 0.2791889 |
| deposit 7,500,000,000 (buyer-signed) | [`8520af67…72b61`](https://stellar.expert/explorer/testnet/tx/8520af675abc968d5b7c404d9d38a3c516e9ea3c4a837bef0e4415de6c972b61) | 5,397,036 | 0.0106351 |
| release_spot M1 → **7,500,000,000** (asserted) | [`96ca4399…59d43`](https://stellar.expert/explorer/testnet/tx/96ca43992139cca799e827d58e99cd7b1e2e2aae8d8ec93d99665ab84bb59d43) | 5,397,037 | 0.0012025 |
| apply_lock on corridor `sv` (service layer) | refused before any tx: `LocksDisabledError`, code `LOCKS_DISABLED` | n/a | 0 |

`node scripts/testnet/show-plan.mjs sv 2001`:

| idx | due (UTC) | amount (cop_due field) | status | locked rate | usd_due | lock expiry |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 2026-10-25 | USD 750.00 (75000 cents) | Released | - | - | - |
| 1 | 2026-11-25 | USD 750.00 (75000 cents) | Open | - | - | - |
| 2 | 2026-12-25 | USD 750.00 (75000 cents) | Open | - | - | - |

## Live-demo pool

Listed in [`pool.json`](pool.json). In every plan M1 is already due and deposited. `create_plan`
accepts a past `due_ts` (`lib.rs:763-768` checks only that due dates increase), so no waiting is
needed. Colombia plans are also locked, so the live step is a single release:

| Plans | Contract | Live step |
| --- | --- | --- |
| 1101, 1102, 1103 | Colombia | `release_due(plan, 0)`: pays 11,883,326,312 stroops |
| 2101, 2102, 2103 | El Salvador | `release_spot(plan, 0, 7500000000)` |

## Costs (XLM, fees charged per Horizon)

| | XLM |
| --- | --- |
| Setup: trustlines, test-dollar SAC, Wasm upload, 4 instance deploys | 34.9477319 |
| Stories (Colombia + El Salvador) | 0.6213880 |
| Pool (6 plans, buyer funding, deposits, 3 locks) | 1.7996559 |
| **Total** | **37.3687758** |

The setup figure includes the `8d2a4402` Wasm upload (2.0304609) and its two instances
(`CA3NE2EX…6WD2` 32.6984771, `CACDLCHA…VQGA` 0.0712406). Those were deployed on an instruction
that was later superseded and are not used by the demo. One `create_plan` costs 0.2791889 XLM.
The 1,008 XLM measured on 2026-10-25 no longer applies (see the norms ledger).

## Screenshots

`screenshots/`: both contract pages and the six story transactions on stellar.expert. Each page
was checked to show its contract id or transaction hash (`screenshots/screenshots.json`).

## Re-running

```bash
node scripts/testnet/preflight.mjs                     # balances, network, wasm hashes
node scripts/testnet/show-plan.mjs co 1101             # any plan's on-chain state
node scripts/testnet/evidence.mjs                      # re-verify every hash, rewrite the evidence
```
