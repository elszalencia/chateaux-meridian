# Ancla receptora simulada (Colombia) · Anchor Platform

## Status: not yet run

Docker Desktop on the build machine was broken (the engine answered HTTP 500 to every call) while
this folder was written, so **nothing here has been executed**: no image was pulled, no container
was started, and no request has gone through the Anchor Platform. The only Docker command that ran
is `docker compose -f docker-compose.yml config`, which the CLI renders without the engine; it
exited 0, so the file is well-formed, nothing more. The
configuration keys, file layout and callback shapes were taken from the Anchor Platform v4
documentation and source read on 2026-10-22:

- https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/configuration
- https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/getting-started
- https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/integration
- https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep10
- https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/getting-started
- https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/events/integration
- https://developers.stellar.org/docs/platforms/anchor-platform/api-reference/callbacks (and its
  get-customer, put-customer, del-customer, get-rates, post-event pages)
- https://developers.stellar.org/docs/platforms/anchor-platform/api-reference/platform/rpc/methods/request_onchain_funds
- https://developers.stellar.org/docs/platforms/anchor-platform/api-reference/platform/rpc/methods/notify_offchain_funds_sent
- OpenAPI specs: `openapi/anchor-platform/bundled-callbacks.yaml` and `bundled-platform.yaml` in
  github.com/stellar/stellar-docs
- github.com/stellar/anchor-platform: `quick-run/dev.env`, `quick-run/docker-compose.yaml`,
  `quick-run/config/*.template`, `platform/.../anchor-config-default-values.yaml`,
  `core/.../auth/JwtService.java`, `core/.../util/KeyUtil.java`,
  `core/.../sep31/Sep31Service.java`, `platform/.../rpc/RequestOnchainFundsHandler.java`
- Releases: github.com/stellar/java-stellar-anchor-sdk/releases and Docker Hub
  (`stellar/anchor-platform:4.9.0`, published 2026-10-05, newest at the time)

What was checked locally: `npx tsc --noEmit -p infra/anchor-platform/business-server` passes, and
the business server was started once on its own with a throwaway secret to confirm that
`GET /rate` answers with a valid HS256 JWT and returns 401 without one. That is the whole extent of
the testing. Treat the first `docker compose up` as the real test (see "First-run checklist").

## What this folder is

The sending backend (`services/server`) runs the SEP-31 sending flow against a receiving anchor
that pays Colombian pesos into the buyer's encargo fiduciario at Fidudavivienda. Today that
counterparty is the small Node receiver labelled "Ancla receptora simulada (Colombia)". This
folder prepares the drop-in replacement: the Stellar Anchor Platform on its receive side, with the
same label plus "· Anchor Platform", configured for SEP-1, SEP-10, SEP-12, SEP-31 and SEP-38 on
testnet. The sender picks the receiver by URL, so switching is a config change, not a code change.

```
                     SEP-1 / SEP-10 / SEP-12 / SEP-31 / SEP-38 (port 8080)
   services/server  ───────────────────────────────────────────────►  sep-server
   (sending anchor)                                                       │
                                                                          │ shared Postgres
                                                                          ▼
   business-server (8081)  ◄── Callback API (JWT) ──────────────  platform-server (8085)
   GET/PUT/DELETE /customer                                               ▲
   GET /rate, POST /event    ── JSON-RPC (JWT) ─────────────────────────► │
   polls GET /transactions                                                │
                                                                   stellar-observer
                                                                   (watches the distribution
                                                                    account on testnet RPC)
                                 db: postgres:14 (anchor platform schema, flyway)
```

Files:

| File | Role |
| --- | --- |
| `docker-compose.yml` | `sep-server`, `platform-server`, `stellar-observer` from `stellar/anchor-platform:4.9.0`, `business-server` built from `./business-server`, `db` (`postgres:14`). |
| `dev.stellar.toml` | SEP-1 info file served at `/.well-known/stellar.toml` (testnet passphrase, service URLs, USDC and COP currencies). |
| `dev.assets.yaml` | Asset configuration: `stellar:USDC:<issuer>` with SEP-31 receive limits, `ACH` method, quotes required, SEP-12 types `sep31-sender` / `sep31-receiver`, SEP-38 pairing with `iso4217:COP`. |
| `dev.env.example` | Every variable the platform and the business server read. Copy to `dev.env` (gitignored by `./.gitignore`). |
| `business-server/` | Node 22 + TypeScript, `node:http` only. Implements the Callback API and the Platform API calls. |

## Running it (Docker)

```sh
cd infra/anchor-platform
cp dev.env.example dev.env
# fill the four secrets and the public keys in dev.env, then the same public keys in
# dev.stellar.toml and dev.assets.yaml (see the checklist below)
docker compose up --build
```

The four secrets in `dev.env`:

1. `SECRET_SEP10_SIGNING_SEED`: a throwaway testnet seed (`S...`). Its public key goes into
   `SIGNING_KEY` in `dev.stellar.toml`.
2. `SECRET_SEP10_JWT_SECRET`: any random string of 32+ characters.
3. `SECRET_CALLBACK_API_AUTH_SECRET`: 32+ characters; the platform signs callback requests with it
   and the business server verifies them (HS256 over the raw UTF-8 bytes, `aud: callback_api`).
4. `SECRET_PLATFORM_API_AUTH_SECRET`: 32+ characters; the business server signs its JSON-RPC calls
   with it (`aud: platform_api`). Also change `SECRET_DATA_PASSWORD` / `POSTGRES_PASSWORD`.

The platform refuses HS256 keys shorter than 256 bits, hence the 32-character minimum.

## Pointing the sender at it later

Set `OFFRAMP_HOME_URL=http://localhost:8080` in `.env.testnet`; the sender's SEP-31 client is
unchanged. The platform exposes the same discovery path (`/.well-known/stellar.toml`) and the
same SEP endpoints (`/auth`, `/sep12`, `/sep31`, `/sep38`) the current simulated receiver does.

Two behaviours of the v4 platform the sender must tolerate (read in `Sep31Service.java`):

- `POST /sep31/transactions` returns only `{ "id" }`. The transaction starts in
  `pending_receiver`; `stellar_account_id`, `stellar_memo` and `stellar_memo_type` appear on
  `GET /sep31/transactions/:id` once the business server has called `request_onchain_funds` and
  the status is `pending_sender`. With `AUTO_COMPLETE=true` and the 5 s poll that takes a few
  seconds. If the sender reads the destination from the `POST` response it has to poll first.
- The request body must include a `fields` object (an empty `{ "transaction": {} }` is accepted;
  a missing `fields` is rejected with `'fields' field cannot be empty`), a `quote_id` (quotes are
  required), and a `funding_method` listed in `dev.assets.yaml` (`ACH`).

## First-run checklist

1. `SIGNING_KEY` in `dev.stellar.toml` is the public key of `SECRET_SEP10_SIGNING_SEED`.
2. The distribution account (`G...DISTRIBUTION` in `dev.assets.yaml`, `ACCOUNTS` in
   `dev.stellar.toml`, `DISTRIBUTION_ACCOUNT` in `dev.env`) exists on testnet, is funded, and holds
   a trustline to `USDC:<issuer>`. The issuer is `VITE_USDC_ISSUER` from `.env.testnet`; replace
   `G...USDC_ISSUER` in `dev.stellar.toml`, `dev.assets.yaml` and `USDC_ASSET` in `dev.env`.
3. `docker compose up --build` starts all five services and the two platform containers finish
   their flyway migrations without conflicting (first thing to watch once the engine works).
4. `curl http://localhost:8080/.well-known/stellar.toml` shows the ORG_NAME above.
5. `curl http://localhost:8080/sep31/info` lists `USDC` with `quotes_required: true`.
6. `curl http://localhost:8080/sep38/info` lists both assets; `curl http://localhost:8081/health`
   answers from the business server.
7. Walk one transaction: SEP-10 → SEP-12 (sender + receiver, `bank_name: Fidudavivienda`,
   `bank_account_number: FD-OLV-0142`) → SEP-38 firm quote → `POST /sep31/transactions` → wait for
   `pending_sender` → pay the account and id memo → the observer records the payment → the
   business server completes it with an `ACH-CO-<8 hex>` external id.

## How the business server behaves

- Every route except `GET /health` requires `Authorization: Bearer <HS256 JWT>` signed with
  `SECRET_CALLBACK_API_AUTH_SECRET`; anything else is 401.
- `GET /customer`, `PUT /customer`, `DELETE /customer/:id`: SEP-12 semantics, in memory. Senders
  need `first_name`, `last_name`, `email_address`; receivers need `first_name`, `last_name`,
  `bank_account_number` (encargo reference `FD-XXX-0000`) and `bank_name` (`Fidudavivienda`).
  Responses carry `status` (`ACCEPTED` or `NEEDS_INFO`), `fields` and `provided_fields`.
- `GET /rate`: indicative and firm quotes between `USDC` and `iso4217:COP` from a flat demo spot of
  3422.325 COP per USDC, zero fee. Firm quotes get an `id` and `expires_at` (15 minutes or the
  requested `expire_after`, whichever is later) and can be fetched again by `id`.
- `POST /event`: logged. Only reaches the business server when events are enabled, which in v4
  needs Kafka (`EVENTS_ENABLED=false` by default).
- `AUTO_COMPLETE=true`: polls `GET /transactions?sep=31&statuses=pending_receiver` on the
  Platform API every `AUTO_COMPLETE_POLL_MS`. Before the payment it calls `request_onchain_funds`
  (with `DISTRIBUTION_ACCOUNT` and an id memo derived from the transaction id when
  `SEP31_DEPOSIT_INFO_GENERATOR_TYPE=none`); after `transfer_received_at` is set it calls
  `notify_offchain_funds_sent` with `external_transaction_id: ACH-CO-<8 hex>`.

## Where the docs differ from the original brief

- The v4 Callback API has no `GET /fee` and no `PUT /unique_address`; the fee comes from the
  `GET /rate` response and the destination account and memo are set through
  `request_onchain_funds` (or generated by the platform with `deposit_info_generator_type: self`).
- The Platform API has no `PATCH /transactions`; status changes are JSON-RPC methods posted to the
  platform server's base URL as an array. The memo for a `none` generator must be an `id` memo, so
  the business server derives a numeric memo rather than a text one.
- The SEP-10 key is `SEP10_HOME_DOMAINS` (plural). `GET /rate` in the callback OpenAPI has no
  `context` parameter and the rate object has no `total_price` (the platform computes it).
- A `stellar-observer` service is required for payments to be detected; it was added.

## Open items for the first session with a working Docker engine

1. Run `docker compose up --build` and fix whatever the platform rejects at startup (asset ids,
   SEP-10 keys, DB schema creation by three containers at once).
2. Confirm the JSON-RPC base path (`POST http://platform-server:8085/`) and the `statuses` query
   form on `GET /transactions`; adjust `business-server/src/index.ts` if the platform expects
   otherwise.
3. Confirm the platform stores `amount_in` and the fee from the quote at creation, so
   `request_onchain_funds` can omit the amounts; otherwise pass `amount_in` and `fee_details`.
4. Decide between `SEP31_DEPOSIT_INFO_GENERATOR_TYPE=none` (business supplies the memo, current
   default) and `self` (platform generates it; then clear `DISTRIBUTION_ACCOUNT` in `dev.env`).
5. Add a Kafka service and set `EVENTS_ENABLED=true` if webhooks are preferred over polling.
6. Teach the sender to poll for `pending_sender` before paying, and to send `fields`.
