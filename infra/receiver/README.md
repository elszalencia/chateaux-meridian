# Ancla receptora simulada (Colombia)

A minimal SEP-31 **receiving anchor** that runs as one Node process against Stellar **testnet**. Our sending backend uses it as the SEP-31 counterparty for COP payouts into a buyer's encargo fiduciario at Fidudavivienda: it serves `stellar.toml`, authenticates the sender with SEP-10, registers the two customers with SEP-12, prices USDC → COP with SEP-38 on the demo curve, accepts SEP-31 transactions, watches Horizon for the USDC payment and walks the transaction to `completed` with a fake ACH reference.

It is a **simulated counterparty**, not production code: nobody reviews KYC, no pesos move, and the exchange rate is the demo's scripted spot path. `infra/anchor-platform/` holds the Anchor Platform configuration that replaces it by a config change: the sender picks the receiver by URL, so pointing it at the Anchor Platform instead of `http://localhost:8788` is the whole migration.

## Run

```sh
npx tsx infra/receiver/src/index.ts
```

On start the receiver reads the repo-root `.env.testnet` (gitignored), makes sure its account exists on testnet (friendbot when Horizon answers 404) and holds a trustline to our test `USDC`, logs the public key with its stellar.expert link, starts the HTTP server and begins polling Horizon. Typecheck and tests:

```sh
npx tsc --noEmit -p infra/receiver
npx vitest run --root infra/receiver
```

## Environment

Read from `.env.testnet` at the repo root, with `process.env` overriding key by key.

| Key | Default | Meaning |
| --- | --- | --- |
| `RECEIVER_SECRET` | generated per run | The receiver's Stellar account secret. When missing, a keypair is generated for this run and the log tells you which `RECEIVER_SECRET=...` line to add to `.env.testnet`; the file is never written by the receiver. |
| `RECEIVER_PORT` | `8788` | HTTP port. |
| `RECEIVER_HOST` | `localhost` | Host name used in the advertised URLs and as the SEP-10 home domain (`host:port`). |
| `RECEIVER_JWT_SECRET` | sha256 of the account secret | HS256 key for the SEP-10 tokens; the default keeps tokens valid across restarts. |
| `RECEIVER_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon used for the account bootstrap, SEP-10 signer lookup and the payment watcher. |
| `STELLAR_NETWORK_PASSPHRASE` | testnet passphrase | Network of the challenges and the trustline transaction. |
| `USDC_ISSUER` | falls back to `VITE_USDC_ISSUER` | Public key of the platform test asset `USDC`. |
| `RECEIVER_DATA_DIR` | `.data/receiver` | Where customers, quotes, transactions and the Horizon cursor are persisted as JSON files (relative to the repo root). |

## Endpoints

All responses are JSON unless noted, CORS is `*`, and `OPTIONS` is answered. Every SEP-12, SEP-38 quote and SEP-31 transaction endpoint requires `Authorization: Bearer <SEP-10 JWT>` and answers `401 {error}` otherwise. Malformed JSON bodies get `400`.

| Method and path | Purpose |
| --- | --- |
| `GET /.well-known/stellar.toml` | SEP-1 (`text/plain`): signing key, the four endpoints below, `ORG_NAME`, the `USDC` and `COP` currencies. |
| `GET /auth?account=G...[&memo=..][&home_domain=..]` | SEP-10 challenge `{transaction, network_passphrase}`, valid 300 s. |
| `POST /auth {transaction}` | SEP-10 verification (JSON or urlencoded) → `{token}`. Signers and medium threshold come from Horizon; an account not on the ledger is verified against its master key. Token: `iss` = web auth endpoint, `sub` = account (`account:memo` when a memo was used), `exp` = 24 h, `jti` = challenge hash. `client_domain` is accepted and ignored. |
| `PUT /sep12/customer` | SEP-12 registration (JSON, `application/x-www-form-urlencoded` or `multipart/form-data`, text fields only) → `202 {id}`. `type` is `sep31-sender` or `sep31-receiver`; pass `memo` (or `id`) to keep several customers of the same type apart. |
| `GET /sep12/customer?id=..` or `?account=..&type=..[&memo=..]` | `{id, status, provided_fields, fields?}`. `ACCEPTED` when the required fields are present, otherwise `NEEDS_INFO` with the missing `fields`. Sender needs `first_name`, `last_name`, `email_address`; receiver needs `first_name`, `last_name`, `bank_account_number` (the encargo, e.g. `FD-OLV-0142`), `bank_name` (Fidudavivienda). |
| `DELETE /sep12/customer/:account[?memo=..]` | Removes that account's customers → `200`. |
| `GET /sep38/info` | The two assets: `stellar:USDC:<issuer>` and `iso4217:COP` (country `CO`, delivery method `ACH`). |
| `GET /sep38/prices?sell_asset=..&sell_amount=..` | Indicative price for COP. |
| `GET /sep38/price?sell_asset=..&buy_asset=..&(sell_amount\|buy_amount)=..&context=sep31` | Indicative price with amounts. |
| `POST /sep38/quote` | Firm quote (10 min): `{id, expires_at, total_price, price, sell_asset, sell_amount, buy_asset, buy_amount, fee}`. Only USDC → COP is quoted. |
| `GET /sep38/quote/:id` | The quote, visible to the account that created it. |
| `GET /sep31/info` | `receive.USDC` with `quotes_required: true`, limits 1 to 100 000, `funding_methods: ["ACH"]`, the two SEP-12 types. |
| `POST /sep31/transactions` | `{amount, asset_code: "USDC", asset_issuer?, destination_asset: "iso4217:COP", quote_id, sender_id, receiver_id, funding_method: "ACH"}` → `201 {id, stellar_account_id, stellar_memo_type: "text", stellar_memo}`. Errors are the SEP-31 shapes: `{error: "customer_info_needed", type}`, `{error: "transaction_info_needed"}`, `{error}`. |
| `GET /sep31/transactions/:id` | `{transaction: {...}}` with the SEP-31 fields. |
| `PUT /sep31/transactions/:id/callback {url}` | Stores the URL → `204`. The receiver does not call it. |
| `GET /health` | `{status, name, account, network, transactions}`. |

### Quote math and the demo clock

The rate is COP per USDC from the demo curve, `spotAtOffset(offset)` in `services/src/adapters/mockRuntime.ts`, so the receiver and the sending demo agree on "today's rate". `offset` is the integer in the optional request header **`X-Demo-Clock-Offset`** (months, default 0), a convenience of this simulated receiver only so the sender's virtual clock and the receiver's curve line up; the Anchor Platform has no such header.

With a `buy_amount` (COP target) the quote sells `usdToCoverCop(buy_amount, rate)` USDC, the smallest whole-cent amount that converts to at least those pesos, and echoes `buy_amount` as whole pesos. With a `sell_amount` the quote buys `round(sell_amount × rate)` pesos. `price` and `total_price` are, as SEP-38 defines them, units of the sell asset per unit of the buy asset (USDC per peso, ten decimals); the fee is zero so they are equal.

## Status machine

```
pending_sender ──(USDC payment with the memo, amount ≥ amount_in)──▶ pending_stellar ──(2 s)──▶ pending_receiver ──(3 s)──▶ completed
      │
      └──(15 min without payment)──▶ expired
```

The watcher polls `GET /accounts/<receiver>/payments?order=asc&cursor=<saved>&limit=50&join=transactions` every 4 s. The cursor starts at `now`, is resolved to a concrete paging token on the first poll and persisted after every page, so a restart resumes where it stopped. A payment whose memo matches no pending transaction is logged and ignored. `pending_stellar` records `stellar_transaction_id`; `completed` records `completed_at` and an `external_transaction_id` like `ACH-CO-1A2B3C4D`. Every transition is logged with the transaction id and the stellar.expert link of the payment. Horizon errors are logged and retried on the next tick; they never stop the process.

## Files

- `src/index.ts` entry: configuration, account bootstrap, routes, watcher.
- `src/config.ts`, `src/log.ts`, `src/http.ts`, `src/store.ts`, `src/horizon.ts` plumbing.
- `src/toml.ts`, `src/sep10.ts`, `src/jwt.ts`, `src/sep12.ts`, `src/sep38.ts`, `src/sep31.ts`, `src/watcher.ts` one module per protocol piece.
- `src/receiver.test.ts` unit tests without network (JWT, SEP-10 with random keypairs, SEP-38 math, the SEP-31 machine with a fake payment).
