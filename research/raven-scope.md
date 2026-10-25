# Casa Puente — What Stellar already provides vs. what we build (Raven research pass)

Research date: 2026-10-19 · Companion to `casa-puente-build-scope.md` (Build Scope v2) · Research only — no contract or app code was written in this pass.

**Method.** Seven question areas, each researched through the `stellar-raven` MCP (`search` → exact catalog entry → `execute`/`skill.read` → note). Sources are tiered: official Stellar docs and SEP/CAP text (authority for protocol, standards and API claims) > pinned `stellar-dev` / OpenZeppelin skills (tested playbooks) > Scout / Lumenloop directory, SCF proposals and press (community-aggregated; may be wrong or stale). Every finding carries its Raven catalog id, URL, date/version and a confidence grade. All Raven queries were generic Stellar questions; the full list is in the final section so it can be checked for client data.

**One caveat that applies to every repo in this file.** Raven's repo rows expose **no license field** (confirmed via `codemode.describe("scout.searchRepos")`), and `testsPresent`/`ciPresent` came back empty on every row. The only license evidence is inside free-text notes for a handful of repos. Every repo marked *"license: not visible — verify at repo"* must be checked on GitHub before any code is copied, forked or added to `Cargo.toml`/`package.json`. **No license = do not reuse.** A 30-minute license pass over the "Build on" table is the first task before build starts.

## Executive summary — the three findings that most change the build

1. **The sending-anchor backend is 100% custom, and its counterparty is unconfirmed.** The official Anchor Platform implements SEP-31 *receive-only*; the only open-source sending-anchor client (`sep31-demo-client`) is archived; and **no Raven source confirms a live SEP-31 receiving anchor paying COP today** — Bitso covers COP but publishes no SEP list, and VANK's SCF-funded COP anchor is SEP-6/24/38 (PSE in, ACH/bank out), not SEP-31. Design the backend as a SEP-31 *client* (SEP-1 → SEP-10 → SEP-12 for sender and receiver → SEP-38 firm quote → `POST /transactions` → USDC with memo → callbacks), but keep a SEP-6/SEP-24 `withdraw-exchange` fallback, and treat "which anchor" as the #1 question for humans (§2e, §5e).
2. **D8 (passkey wallet, no crypto vocabulary) forces two infrastructure pieces the scope does not yet list.** Official docs: a contract account (C-address) *cannot sign a transaction envelope*, so fee-bumps and sponsored reserves do not help — a **relayer** (OpenZeppelin Relayer; Launchtube is retired) must be the tx source and fee payer. And anchors can only authenticate a C-address via **SEP-45**, still Draft v0.1.1; the Anchor Platform ships it but each anchor must enable it, so the deposit flow needs a **G-account fallback** (app-controlled, SEP-10 + SEP-24, forwarding to the C-address). Smart Account Kit + OpenZeppelin Smart Account is the SDF-tutorial path and the only passkey option whose account contract has published audits (§4).
3. **The 24–36 month schedule does not fit Soroban's defaults; two lifecycle jobs are mandatory.** Max storage TTL is ~3,110,400 ledgers ≈ **180 days**, so `payment_plan` data needs ≥6 re-extensions (bump-on-access + a keeper running `ExtendFootprintTTLOp`); and Stellar-RPC retains events for only ~**7 days**, so the §4.6 receipts must be ingested into our own indexer/DB or be re-derivable from persistent state. Related: soroban-sdk **v28.0.0 (2026-09-18, Protocol 28)** has breaking macro changes — check mainnet `getVersionInfo` before pinning 27 vs 28 (§1).

Also material: Reflector appears to publish a USD-based FX feed that **includes COP** (SEP-40, ~5-min ticks) — usable as an on-chain *sanity band* for `apply_lock`, never as the contractual rate; **no oracle exposes the TRM** (§3a). Crebit (SCF #45) is the only Stellar project selling FX rate locks, and it is off-chain with on-chain USDC settlement, which validates D3/D5's shape (§3b). No COP-pegged asset exists on Stellar's DEX, so Horizon path-finding cannot price USDC→COP; the SEP-38 firm quote is the on-chain leg's price source (§3c). USDC is an "Open" asset (no `AUTH_REQUIRED`), but whether Circle set `AUTH_REVOCABLE`/`AUTH_CLAWBACK_ENABLED` was not found in any source — check on-chain; the vault must tolerate a frozen balance (§6b).

---

Scope note: every claim below comes from Raven results (official Stellar docs, Scout release/CAP corpus, or the pinned `skills.stellar-dev.smart-contracts` skill). Scout `searchResearch` rows are community-aggregated/vector-matched ("unverified-match" caveat) even when they point at GitHub release pages; treat exact version numbers as leads to re-verify at crates.io / GitHub. Network limits (TTLs, fees, sizes) are validator-voted and change — the skill and docs both say to read live values from Stellar Lab's Network Limits page or `stellar network settings --network mainnet`.

## 1. Soroban core

### (a) Current soroban-sdk version and recent breaking changes

The rule that outlives any release: the `soroban-sdk` major version tracks the protocol version (SDK 27 <-> protocol 27), and pre-releases exist only during a protocol rollout. In the Scout release corpus the newest SDK tag is **rs-soroban-sdk v28.0.0 (2026-09-18)**, "a release supporting Protocol 28. Upgrading requires changes to some contracts" with a migration guide at `docs.rs/soroban-sdk/28.0.0/soroban_sdk/_migrating`; stellar-core v28.0.1 shipped 2026-09-01 and stellar-cli v28.1.0 on 2026-09-26 (adds `stellar skill`). The v27 line (27.0.0 on 2026-07-08 through 27.0.6 on 2026-08-13) is what the skill was written against. v28.0.0 breaking changes visible in results: (1) build with stellar-cli >= v25.2.0 because spec shaking v2 is always on — remove the `experimental_spec_shaking_v2` feature and any `export = ...` argument on `contracttype`/`contracterror`/`contractevent` (now a compile error); (2) remove any `lib = ...` argument on those macros, and `contractimport!` now always generates full type definitions rather than aliasing another crate; (3) a `contracttype` struct can be read from stored data with extra or missing fields (CAP-86) — a missing field reads as `None` if it is an `Option`, otherwise errors. Earlier notable changes surfaced: protocol 26 added `extend_ttl_with_limits`, protocol 27 (CAP-71) added auth delegation for custom accounts, and `env.events().publish` is deprecated in favour of `#[contractevent]`. Which protocol mainnet is actually on was not resolved in these results — check RPC `getVersionInfo` before pinning (the skill's instruction).

- Source: `scout.searchResearch` (source=release) — https://github.com/stellar/rs-soroban-sdk/releases/tag/v28.0.0 ; https://github.com/stellar/rs-soroban-sdk/releases/tag/v27.0.0 ; https://github.com/stellar/stellar-cli/releases/tag/v28.1.0 ; https://github.com/stellar/stellar-core/releases/tag/v28.0.1 ; date/version: SDK v28.0.0 published 2026-09-18, CLI v28.1.0 2026-09-26; confidence: medium (community-aggregated index, "unverified-match" caveat; version list may lag).
- Source: `skills.stellar-dev.smart-contracts` section `versions` — https://raw.githubusercontent.com/stellar/stellar-dev-skill/e9ab7dbb662dc2efc9b0ebb4ed86c417d16dd29f/skills/smart-contracts/SKILL.md ; date/version: written against protocol 27; confidence: high for the "major tracks protocol" rule, medium for specific numbers.

### (b) Transferring a SAC token (USDC) from a contract

The Rust SDK's `token` module ships `TokenClient` (SEP-41 basic subset: `transfer`, `balance`, `approve`, `transfer_from`, `burn`) and `StellarAssetClient` (admin surface: `mint`, `clawback`, `set_admin`, `set_authorized`) for any SAC; no `contractimport!` is needed. Pattern 1 — moving the user's funds into the contract: `user.require_auth();` then `token::Client::new(&env, &usdc).transfer(&user, &env.current_contract_address(), &amount)`. The SAC's own `transfer` calls `from.require_auth()`, so the user's signed auth tree must include the inner `transfer` invocation (SDKs build this from simulation); the skill flags the top real-world bug — if your entry point never calls `user.require_auth()` itself, anyone can replay a pre-signed inner auth by calling `deposit(victim, ...)`. Pattern 2 — paying out from the contract's own balance: `token_client.transfer(&env.current_contract_address(), &recipient, &amount)`; when a contract directly calls the SAC, the direct call *is* the authorization for the contract address, so no extra auth entry is needed (the fee-optimization guide shows exactly this: one `transfer(from -> contract)` then a loop of `transfer(contract -> recipient)`). Pattern 3 — pull later without the user online: `approve(from, spender, amount, expiration_ledger)` + `transfer_from` (auths the spender, allowances expire at `expiration_ledger`). Caveats: amounts are `i128` (reject negatives), `transfer`'s destination is a `MuxedAddress` (pass `&to`, not `&to.into()`), and SAC carries classic semantics — a G-account recipient needs an authorized USDC trustline or the transfer fails; C-address balances live in contract storage.

- Source: `stellarDocs.search_asset_token_docs` — https://developers.stellar.org/docs/tokens/stellar-asset-contract#contract-interface ; `stellarDocs.search_soroban_contract_docs` — https://developers.stellar.org/docs/build/guides/fees/analyzing-smart-contract-cost#optimal-contract--1 and https://developers.stellar.org/docs/build/smart-contracts/example-contracts/liquidity-pool#token-transfers-tofrom-the-lp-contract ; date/version: current docs (observed 2026-10-19); confidence: high.
- Source: `skills.stellar-dev.smart-contracts` file `development.md` sections "Tokens from the contract side", "Auth trees and cross-contract propagation" — https://raw.githubusercontent.com/stellar/stellar-dev-skill/e9ab7dbb662dc2efc9b0ebb4ed86c417d16dd29f/skills/smart-contracts/development.md ; protocol 27; confidence: high.

### (c) Authorization for smart-wallet / passkey accounts

A contract address becomes an account by implementing `CustomAccountInterface` with `__check_auth(env, signature_payload: Hash<32>, signature: Self::Signature, auth_contexts: Vec<Context>) -> Result<(), Self::Error>`; whenever that C-address is `require_auth`'d anywhere, the host invokes `__check_auth`. Rules from the skill: always verify `signature_payload` (verifying anything else authorizes arbitrary calls), enforce policy from `auth_contexts` (each `Context::Contract` carries contract, fn_name, args), never `require_auth` the account's own address inside `__check_auth`, and keep it lean because its cost lands on every transaction the account signs. Passkeys: WebAuthn authenticators use secp256r1 (P-256); CAP-0051 (status Final, protocol 21) added host function `verify_sig_ecdsa_secp256r1(public_key: 65-byte SEC-1, msg_digest, signature)` which traps on failure, so a passkey wallet verifies the WebAuthn assertion in `__check_auth` and stores the credential's public key in contract state. Protocol 27 (CAP-71) adds auth delegation (`env.custom_account().get_delegated_signers()` / `delegate_auth(&addr)`), and js-stellar-sdk v16.2.0 exposes a transitional `useUpgradedAuth` flag for v2 credentials, becoming default at protocol 28. For our contract this is transparent: calling `payer.require_auth()` works identically whether `payer` is a G-account (medium threshold) or a passkey C-account. Fee note: contract accounts cannot sign transaction envelopes, so a separate G-account must be the tx source (fee-sponsorship guide); the docs point to OpenZeppelin Smart Account + Relayer, or Passkey Kit, with Launchtube retired.

- Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets (sections secp256r1-on-stellar, passkeys-in-practice, client-sdks, retired-tooling) ; `stellarDocs.search_soroban_contract_docs` — https://developers.stellar.org/docs/build/smart-contracts/example-contracts/complex-account#policy-modification ; https://developers.stellar.org/docs/build/guides/transactions/fee-sponsorship ; date: current docs; confidence: high.
- Source: `scout.searchResearch` (source=cap) — https://github.com/stellar/stellar-protocol/blob/master/core/cap-0051.md ; capStatus Final, protocol 21; confidence: high (CAP text is primary).
- Source: `skills.stellar-dev.smart-contracts` `development.md` "Custom accounts (`__check_auth`)"; confidence: high.

### (d) One contract calling another

Two ways: (1) typed client via `mod other { soroban_sdk::contractimport!(file = "../other/target/wasm32v1-none/release/other.wasm"); }` then `other::Client::new(&env, &addr).fn(&args)` — the macro generates a `Client` type plus every `#[contracttype]` of the callee, so wrap it in its own `mod` to avoid name collisions; (2) untyped `env.invoke_contract::<T>(&addr, &symbol_short!("fn"), vec![&env, x.to_val(), ...])` when the interface is not known at compile time. Callee errors abort the caller unless you use `try_` client methods. There is no `msg.sender`: pass the acting `Address` explicitly and `require_auth` it. Cross-contract reentrancy is blocked by the host; there is no `delegatecall`. Dependency warning from the docs: the callee can be upgraded without changing address, so pin/verify wasm hashes (`stellar contract fetch`, `stellar contract info hash`) in CI. For SAC/SEP-41 tokens use the built-in `token::Client` (see (b)) instead of importing.

- Source: `stellarDocs.search_soroban_contract_docs` — https://developers.stellar.org/docs/build/smart-contracts/example-contracts/cross-contract-call#how-it-works ; https://developers.stellar.org/docs/build/guides/conventions/cross-contract#making-a-cross-contract-call ; example pinned to soroban-examples v23.0.0 tag; confidence: high.
- Source: `skills.stellar-dev.smart-contracts` `development.md` "Cross-contract calls" and section `platform-constraints`; confidence: high.

### (e) Storage TTL, state archival, max TTL, 12–36 month data, rent

Three storage classes: `temporary()` (cheapest, per-key TTL, **permanently deleted** at expiry, unlimited count), `persistent()` (per-key TTL, archived at expiry and restorable, unlimited count, "most expensive, same as instance"), `instance()` (one ledger entry shared with the contract instance and its code, one TTL, capped by the max ledger-entry size ~64KB — never per-user data). `extend_ttl(threshold, extend_to)` is a floor-only no-op unless current TTL < threshold; `extend_ttl_with_limits` (protocol 26) bounds caller-forced rent. Numbers (mainnet, network-configured, verify on Stellar Lab): ~5 s ledgers, 17,280 ledgers/day; new persistent entries start at ~120 days TTL, temporary ~1 day; **maximum TTL is 3,110,400 ledgers ≈ 180 days**, measured from the *current* ledger at each extension (docs: entry created Jan 1 can be extended to Jan 1 next year; re-extended Jan 10 reaches Jan 10 next year — illustrative, the live max is the 180-day figure). So no single extension covers 12–36 months: the schedule data must be re-bumped at least every ~6 months, either by the contract on access (bump-on-access pattern) or by anyone via `ExtendFootprintTTLOp` (no contract auth needed, e.g. a keeper cron / `stellar contract extend`, which the CLI caps at 535,679 ledgers ≈ 30 days per call for the instance). If a persistent entry does archive, it is not lost: since protocol 23 (CAP-66) simulation adds archived entries to the restore list and `InvokeHostFunctionOp` auto-restores them (you pay restoration rent); a manually built tx without the restore list fails before contract code runs, and archived entries can never be re-created under the same key. Rent is charged at invocation time proportional to entry size × ledgers added; rent is refundable if unused in the fee declaration; TTL expiry is **not** a security mechanism — store deadlines in the value and check them.

- Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival (sections persistent, instance, temporary, maximum-ttl, minimum-ttl, contract-data-automatic-restoration, behavior-of-transactions-that-try-to-access-an-archived-persistent-entry) ; page dated 2026-08-13 in Scout; confidence: high.
- Source: `scout.searchResearch` (source=dev-docs) — https://developers.stellar.org/docs/build/guides/storage/storage-strategies "Strategy 5: TTL management — bump-on-access" (3,110,400 ledgers ≈ 180 days; dated 2026-07-27) ; `stellarDocs.search_docs` — https://developers.stellar.org/docs/tools/cli/cookbook/extend-contract-instance ; https://developers.stellar.org/docs/build/guides/storage/choosing-the-right-storage#temporary-storage ; confidence: high for mechanics, medium for the exact ledger count (voted parameter).
- Source: `skills.stellar-dev.smart-contracts` `development.md` "Storage", "TTL management", "Choosing storage — decision tree"; confidence: high.

### (f) Events for receipts

Define events with `#[contractevent]` (the old `env.events().publish(topics, data)` is deprecated since protocol 23 "Whisk"): `#[topic]` fields become topics after the snake-cased struct name, non-topic fields form the data payload; `#[contractevent(topics = ["custom", "prefix"], data_format = "map" | "vec" | "single-value")]` customizes it. CAP-67's unified transfer model uses four topics (`transfer`, from, to, asset id) — a good template for receipt events (`payment_made`, schedule_id, payer, installment_no). Limits: the per-transaction ceiling for contract events + return value is 16 KB (mainnet, voted); topics are `SCVal`s of any type. Events are emitted in `TransactionMeta` only when the transaction succeeds; the host emits a SYSTEM event `executable_update` on wasm upgrade; diagnostic events are off by default and not consensus. Off-chain reading: RPC `getEvents` with `startLedger`, cursor pagination, and server-side topic filters (`["*", scvSymbol("transfer")]` style wildcards). **Retention**: Stellar-RPC keeps a `history-retention-window` of ledgers, stock default 120,960 ledgers ≈ 7 days (inspect via `getHealth`: `ledgerRetentionWindow`, `oldestLedger`); the events guide says "7 days at most", so receipts that must be auditable for 24–36 months must be ingested into our own DB/indexer (cron on `getEvents`, Mercury, or Hubble BigQuery `history_contract_events` for full history), or be derivable from on-chain state.

- Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/events ; `stellarDocs.search_docs` — https://developers.stellar.org/docs/build/guides/events/publish ; https://developers.stellar.org/docs/build/guides/events/ingest ; https://developers.stellar.org/docs/build/guides/transactions/send-and-receive-payments#summary ; confidence: high.
- Source: `scout.searchResearch` (sources=dev-docs,release) — https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents (dated 2026-09-08; 120960-ledger default) ; https://developers.stellar.org/docs/data/analytics/hubble/analyst-guide/queries-for-horizon-like-data ; confidence: high.
- Source: `skills.stellar-dev.smart-contracts` `development.md` "Events", "Fees and resource limits" (16 KB); `skills.stellar-dev.data` section `stellar-rpc` ("7-day history for most methods"); confidence: high.

### (g) Ledger timestamp semantics and precision

`env.ledger().timestamp()` "returns a unix timestamp for when the most recent ledger was closed" (seconds, `u64`), and `env.ledger().sequence()` the ledger sequence; it is the only clock a contract has ("no clock beyond the ledger timestamp"). Ledgers close roughly every 5 seconds, so precision is one ledger (~5 s) and the value is the close time of the ledger the transaction executes in, set by validator consensus rather than by the submitter — transaction `timeBounds` use the same ledger time in UNIX seconds. Implication: due dates to the second are meaningless; model installments at day granularity and treat "on time" as `timestamp <= due_ts` with tolerance. The max-TTL docs reason about calendar dates via ledgers, so convert with the live ledger cadence, not a hard-coded 5 s, when you turn months into ledgers for TTLs.

- Source: `stellarDocs.search_docs` — https://developers.stellar.org/docs/learn/migrate/evm/solidity-and-rust-advanced-concepts#soroban-4 ; https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions#time-bounds ; confidence: high for semantics, medium for cadence (docs say "averaging 5 second ledger close times").
- Source: `skills.stellar-dev.smart-contracts` section `platform-constraints`, `development.md` "TTL management" (~5 s, 17,280/day); confidence: high.

### (h) Contract upgradeability

Pattern: upload the new wasm first (`stellar contract upload`), then an admin-gated entrypoint `upgrade(env, new_wasm_hash: BytesN<32>) { admin.require_auth(); env.deployer().update_current_contract(ContractExecutable::Wasm(new_wasm_hash)); }`. The address and all storage survive; only the executable changes; `__constructor` does not re-run; the host emits a SYSTEM `executable_update` event. **Naming conflict in sources**: the current docs guide (dated 2026-09-24) and example use `env.deployer().update_current_contract(ContractExecutable::Wasm(hash))`, whereas the skill (protocol 27) shows `env.deployer().update_current_contract_wasm(new_wasm_hash)`; protocol 28 / CAP-85 introduced `ContractExecutableExternalRef` as a second `ContractExecutable` arm, which explains the newer generalized API — confirm which method exists in the SDK version you pin. Storage schema is your responsibility: store a schema version, add enum variants rather than reshaping existing ones (CAP-86 in SDK 28 now tolerates extra/missing struct fields with `Option`), and ship an idempotent admin-gated `migrate` enforcing `new_version > current_version`. SEP-0049 standardizes upgradeable interfaces; OpenZeppelin `stellar-contracts` ships `Upgradeable` / `UpgradeableMigratable` derive macros (skill `skills.openzeppelin-stellar.upgrade-stellar-contracts` exists; license not visible in Raven results — verify at repo). Because the contract holds user funds for years, decide up front whether upgrade authority is a single admin, a multisig/timelock, or renounced.

- Source: `stellarDocs.search_soroban_contract_docs` — https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts#how-it-works and #code (source https://github.com/stellar/soroban-examples/blob/main/upgradeable_contract/old_contract/src/lib.rs) ; `scout.searchResearch` dated 2026-09-24; confidence: high.
- Source: `skills.stellar-dev.smart-contracts` `development.md` "Upgradeability"; `scout.searchResearch` (release) — https://github.com/stellar/js-stellar-sdk/releases/tag/v17.0.0 (CAP-85 external executable refs); confidence: medium on the exact method name.

### (i) testutils for auth and time

Auth: `env.mock_all_auths()` makes every `require_auth` pass and records the auth tree, which you assert with `env.auths()` against `(address, AuthorizedInvocation { function: AuthorizedFunction::Contract((contract_id, symbol, args)), sub_invocations })`; `mock_all_auths_allowing_non_root_auth()` is needed when a contract authorizes sub-calls via `authorize_as_current_contract`; `env.mock_auths(&[MockAuth { address, invoke: &MockAuthInvoke { contract, fn_name, args, sub_invokes } }])` scopes auth to specific invocations so you can test that an un-authorized caller fails. `mock_all_auths` skips `__check_auth`, so custom-account logic needs `env.try_invoke_contract_check_auth::<AccError>(&account, &payload, sig_val, &auth_contexts)`. Time: `env.ledger().set_timestamp(1000)` / `env.ledger().set_sequence_number(n)` (or `env.ledger().set(LedgerInfo { timestamp, sequence_number, protocol_version, network_id, base_reserve, min_temp_entry_ttl, min_persistent_entry_ttl, max_entry_ttl })`) to advance time between calls for vesting/timelock logic; for TTL tests bump the sequence past the TTL and use `testutils::storage::Persistent as _` to read `get_ttl`; accessing an archived entry in a test panics in the host. `Env::default()` enforces mainnet CPU/memory limits in tests since SDK 25. Events: `env.events().all()` returns the last invocation's events; compare against `MyEvent{..}.to_xdr(&env, &contract_id)`. SAC in tests: `env.register_stellar_asset_contract_v2(admin)` then `token::Client` / `token::StellarAssetClient` to mint test USDC.

- Source: `stellarDocs.search_docs` — https://developers.stellar.org/docs/build/guides/testing/test-contract-auth ; https://developers.stellar.org/docs/build/guides/auth/contract-authorization#how-to-test ; https://developers.stellar.org/docs/build/smart-contracts/example-contracts/fuzzing#a-simple-fuzz-test (LedgerInfo fields) ; https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension#example ; https://developers.stellar.org/docs/build/smart-contracts/example-contracts/liquidity-pool#tests ; confidence: high.
- Source: `skills.stellar-dev.smart-contracts` file `testing.md` sections "Time and ledger state", "Events", "Storage TTL", auth setup — https://raw.githubusercontent.com/stellar/stellar-dev-skill/e9ab7dbb662dc2efc9b0ebb4ed86c417d16dd29f/skills/smart-contracts/testing.md ; confidence: high.

### Implications for a 24–36 month installment-schedule contract

- Storage: put each schedule in `persistent()` under a fine-grained `#[contracttype]` key (e.g. `Schedule(id)`, `Installment(id, n)`), config/admin in `instance()`; never put per-schedule data in instance storage (64 KB cap). Max TTL ≈ 180 days means a 36-month schedule needs at least 6 re-extensions: bump-on-access in every `pay`/`read` entrypoint (threshold ~30 days, extend to ~120–180 days) plus an off-chain keeper that runs `ExtendFootprintTTLOp` for dormant schedules; budget rent for ~size × 3,110,400 ledgers per bump and remember auto-restore (protocol 23) is a cost fallback, not a design.
- Encode due dates and status inside the stored value and check `env.ledger().timestamp()` (seconds, ~5 s granularity) against them; do not rely on TTL expiry for "overdue" semantics, and model deadlines at day granularity with a grace window.
- Payments: the `pay(schedule_id, payer, amount)` entrypoint must call `payer.require_auth()` *and* invoke `token::Client::transfer(&payer, &env.current_contract_address() or &merchant, &amount)`; the client's signed auth tree then covers both. Payouts from escrow use `transfer(&env.current_contract_address(), ...)` with no extra auth. Recipient G-accounts need a USDC trustline; prefer `transfer_from` with expiring allowances only if you need auto-debit without the payer online.
- Passkey smart wallets work unchanged through `require_auth` (CAP-0051 secp256r1 since protocol 21; CAP-71 delegation in 27), but a G-account relayer must be the tx source and fee payer (OpenZeppelin Relayer; Launchtube retired).
- Receipts: emit one `#[contractevent]` per installment (topics: event name, schedule id, payer; data: installment number, amount, timestamp) and ingest them continuously — RPC retains only ~7 days (120,960 ledgers), so the 36-month audit trail must live in our indexer/DB or be re-derivable from persistent state; keep events + return value under 16 KB per tx.
- Versioning: pin `soroban-sdk` major to the live network protocol (27 vs 28 — check `getVersionInfo`), build with stellar-cli >= 25.2 if on SDK 28, ship an admin-gated `upgrade` + versioned `migrate` from day one, and decide now whether upgrade authority is a multisig/timelock given funds are held for years.

---

## 2. Anchors

Research date: 2026-10-19. All findings via Raven MCP (stellarDocs / scout / lumenloop / skills). Spec text = stellar-protocol SEP chunks via `scout.searchResearch(source:"sep")`; docs = developers.stellar.org via `stellarDocs.*`; "who supports what" = Scout/Lumenloop community-aggregated rows. Third-party rows may be stale or wrong; dates are as reported by the source.

### (a) SEP-6 / SEP-24 / SEP-31 / SEP-38: status, version, purpose, and what the docs recommend

| SEP | Title | Status | Version / Updated | One-line purpose |
|---|---|---|---|---|
| SEP-6 | Deposit and Withdrawal API | **Active** ("Interactive components are deprecated in favor of SEP-24") | v4.3.0, updated 2025-09-10 | Programmatic (API-first) deposit/withdrawal between a wallet and an anchor; client collects KYC and sends it via SEP-12. |
| SEP-24 | Hosted Deposit and Withdrawal | **Active** | v3.8.0, updated 2025-09-10 (v3.8.0 adds Soroban contract accounts / SEP-45) | Interactive deposit/withdrawal: wallet opens an anchor-hosted webview; the anchor collects KYC itself; no SEP-12 needed. |
| SEP-31 | Cross-Border Payments API | **Active** | v3.1.0, updated 2024-11-05 | Business-to-business payment protocol between a Sending Anchor and a Receiving Anchor for two off-Stellar financial accounts (remittance / payout corridor). |
| SEP-38 | Anchor RFQ API | **Draft** (authors Jake Urban, Leigh McCulloch; discussion issue #901) | v2.5.0, updated 2025-02-26 | Request-for-quote API: indicative prices (`GET /prices`, `GET /price`) and firm quotes (`POST /quote`, `GET /quote/:id`) used by SEP-6, SEP-24 and SEP-31. |

What the docs recommend today: the official anchors page lists SEP-6, SEP-24 and SEP-31 as "the most important SEPs" for anchors and frames SEP-6 vs SEP-24 as a choice (programmatic vs hosted/interactive, who collects KYC). SEP-31 is positioned separately as the corridor protocol: the Anchor Platform SEP-31 guide says it is for "building a cross-border payments receive-side service compatible with SEP-31 ... businesses make their service compatible with Stellar's existing set of send-side services." The stellar-dev standards skill maps it the same way: "SEP-0006 for API-first flows. SEP-0024 for hosted interactive rails. SEP-0031 when supporting payment corridors. SEP-0012 for KYC data requirements." So: programmatic business payout into another anchor = SEP-31 (+SEP-10, SEP-12, SEP-38); an end user depositing fiat interactively into their own wallet = SEP-24. Note SEP-38 is still formally Draft although the Anchor Platform ships it and SEP-6/24/31 all depend on it (the SEP-24 `/fee` endpoint is deprecated in favour of SEP-38 `GET /price`).

- Source: `scout.searchResearch` (source `sep`) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md (publishedAt 2025-09-10), sep-0024.md (2025-09-10), sep-0031.md (2024-11-05), sep-0038.md (2025-02-26); confidence: high (preamble text quoted verbatim).
- Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/learn/fundamentals/anchors#sep-6-vs-sep-24-programmatic-vs-hosted-transfers ; `stellarDocs.search_anchor_sep_docs` — https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/getting-started ; `codemode.skill.read("skills.stellar-dev.standards")` section quick-mapping-by-use-case; date: docs page indexed 2026-10-12; confidence: high.

### (b) SEP-31: who calls whom, the flow, and the KYC fields

Parties (SEP-31 Abstract, verbatim): "A **Sending Client**: The owner of the origin financial account. A **Sending Anchor**: The business receiving funds from the Sending Client and delivering them to the Receiving Anchor for the Receiving Client. Must have a business relationship with the Receiving Anchor. A **Receiving Anchor**: The business receiving funds from the Sending Anchor and delivering them to the Receiving Client. A **Receiving Client**: The owner of the destination financial account." The spec adds that clients "typically ... reside in different regulatory jurisdictions and therefore a payment between their financial accounts must be facilitated by two businesses." So the **Sending Anchor is a business with a pre-existing relationship with the receiver, not an end user**; the Sending Anchor is the only party that calls the Receiving Anchor's `DIRECT_PAYMENT_SERVER`.

Flow (spec + Anchor Platform docs):
1. Discovery: Sending Anchor reads the receiver's `stellar.toml` (SEP-1) for `DIRECT_PAYMENT_SERVER`, `KYC_SERVER`, `ANCHOR_QUOTE_SERVER`, `SIGNING_KEY`.
2. Auth: SEP-10 (or SEP-45 for contract accounts) JWT; the Anchor Platform expects the sending organization to be registered as a custodial client with `signing_keys` ("Stellar public keys used for client SEP-10 authentication").
3. `GET /info`: per-asset `funding_methods` ("the methods the receiving anchor uses to deliver the asset to the receiving client"), `min_amount`, `max_amount`, `fee_fixed`/`fee_percent`, and the SEP-12 customer `types` the receiver requires for sender and receiver.
4. KYC via SEP-12 for **both** customers: `PUT /customer` with `type` = the receiver-defined label (e.g. a sender type and a receiver type); SEP-12 says "if a customer is being KYC'd as a SEP-31 sender, they may only require full name and email, but a SEP-31 receiver would require banking information in order to receive a direct deposit." `PUT /customer` returns the customer `id`. Fields are SEP-9 standard KYC fields (name, email, address, ID, bank account fields etc.); the exact set is dictated by the receiving anchor's `GET /customer?type=...` response, not fixed by SEP-31.
5. Optional SEP-38 quote (see (c)).
6. `POST /transactions` (example body from the spec): `{"amount": 100, "asset_code": "USDC", "asset_issuer": "G...", "sender_id": "<SEP-12 customer id>", "receiver_id": "<SEP-12 customer id>"}`; other variants add `destination_asset` (indicative) or `quote_id` (firm quote), and since v3.1.0 `funding_method` replaces the deprecated `fields` object ("v3.1.0: Deprecate `fields` in favor of `funding_method`"; "v2.5.0: Deprecate and make optional the use of per-transaction `fields` objects"). The Anchor Platform config note says "`sep31.fields.transaction` should be left empty and will be removed in a future release." Caveat: the full request parameter table was not returned verbatim by Raven chunking; field names above come from the spec example, changelog and docs.
7. Response (201): Sending Anchor "must check for whether `stellar_account_id`, `stellar_memo`, & `stellar_memo_type` values are present"; if absent the status is `pending_receiver` and the sender waits until `pending_sender`, at which point "the Stellar account & memo fields should be populated." The sender then pays on-chain to that account **with that memo** (memo is how the receiver matches the payment).
8. Status tracking: poll `GET /transactions/:id` or register `PUT /transactions/:id/callback`; callbacks are signed with the Receiving Anchor's `SIGNING_KEY` and carry a timestamp the sender must verify (reject if older than "1 or 2 minute(s) maximum"). Statuses: `pending_sender`, `pending_stellar`, `pending_customer_info_update`, `pending_transaction_info_update` (deprecated), `pending_receiver`, `pending_external`, `completed`, `refunded`, `expired` ("If a SEP-38 quote was specified ... the transaction should expire when the quote expires"), `error`.
9. Async KYC repair (v3.0.0): on `pending_customer_info_update` the sender does SEP-12 `GET /customer` (recommended with `transaction_id` + `type`), collects, `PUT /customer`, repeats until `ACCEPTED`, then the tx moves back to `pending_receiver`.

- Source: `scout.searchResearch` (source `sep`) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md (v3.1.0, 2024-11-05), sep-0012.md (2024-07-23), sep-0009.md (2024-04-22); confidence: high for parties/statuses/response/memo/callback; medium for the complete `POST /transactions` field list (table not retrieved verbatim).
- Source: `stellarDocs.search_anchor_sep_docs` — https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/integration (customer types, verifying customer info, ready-to-receive-funds), https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/configuration#enable-cross-border-payments, https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/assets-and-client-wallets#field-explanations-1 ; confidence: high.

### (c) SEP-38 quotes

Endpoints (SEP-38 v2.5.0): `GET /prices` (indicative prices for one `sell_asset` or one `buy_asset` against all counter assets; request takes `sell_asset`/`buy_asset`, `sell_amount`/`buy_amount`, optional `sell_delivery_method`, `buy_delivery_method`, `country_code`), `GET /price` (indicative price for a specific pair; "The client must provide either `sell_amount` or `buy_amount`, but not both. These prices are indicative. The actual price will be calculated at conversion time once the Anchor receives the funds"), `POST /quote` (firm quote) and `GET /quote/:id` (fetch a previously issued quote). Authentication: SEP-10/SEP-45 JWT "is mandatory for `POST /quote` and `GET /quote/:id`, but optional for the remaining endpoints." Location is advertised as `ANCHOR_QUOTE_SERVER` in stellar.toml.

Firm vs indicative: `POST /quote` "can be used to request a firm quote ... In contrast with the `GET /price` and `GET /prices` endpoints, the amount requested must be held in reserve and not used in calculations of subsequent quotes until the expiration." Request fields: `sell_asset`, `buy_asset`, `sell_amount` or `buy_amount`, optional `expire_after` ("The client's desired `expires_at` date and time for the quote. Anchors may choose an `expires_at` that occurs after the `expire_after`. Anchors should return `400 Bad Request` if an expiration on or after the requested value cannot be provided"), optional `sell_delivery_method`/`buy_delivery_method`, `country_code`, and `context` (sep6/sep24/sep31). Response: `id` ("The unique identifier for the quote to be used in other Stellar Ecosystem Proposals"), `expires_at` ("The date and time by which the anchor must receive funds from the client"), `total_price`, `price`, `sell_amount`, `buy_amount`, `fee {total, asset, details[]}`. Price formulas: `sell_amount = total_price * buy_amount`; `sell_amount - fee = price * buy_amount` when fee is in sell asset. Changelog: v2.4.1 "`sell_delivery_methods` and `buy_delivery_methods` should match corresponding `funding_methods` options specified in the SEP-6 or SEP-31 protocol."

Passing the quote on: the `id` goes into SEP-31 `POST /transactions` as `quote_id` (the spec's third example body is "if the Sending Anchor requested a firm quote"); the SEP-31 transaction then expires when the quote expires. For SEP-6 the `quote_id` goes into `GET /deposit-exchange` / `GET /withdraw-exchange`; SEP-24 passes it in the interactive `POST /transactions/deposit-interactive` / `withdraw-interactive` request (SEP-24 "has been updated to make exchanges between ... non-equivalent assets like `BRL <> USDC`"). In the Anchor Platform, SEP-38 is served by the platform but priced by your business server's Rate callback; for SEP-31 the docs note the rate endpoint "is currently only used paying out remittances in off-chain assets, [so] the `buy_delivery_method` will be used."

- Source: `scout.searchResearch` (source `sep`) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md (v2.5.0, 2025-02-26), sep-0031.md (2024-11-05), sep-0006.md and sep-0024.md (2025-09-10); confidence: high.
- Source: `stellarDocs.search_anchor_sep_docs` — https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/integration#delivery-methods , https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep24/integration#quotes-and-fees ; confidence: high.

### (d) The Anchor Platform (stellar/anchor-platform)

What it is: "a set of tools and APIs for building on and off-ramp services on the Stellar network. With standardized interfaces and full implementations of key Stellar Ecosystem Proposals (SEPs)". Supported SEPs (official list): SEP-1, SEP-6, SEP-10, SEP-12, SEP-24, **SEP-31 "Cross-border payment processing (receive only)"**, SEP-38, SEP-45. Architecture: a client-facing **SEP server** (stateless w.r.t. PII, proxies KYC to you), an internal **Platform server** (JSON-RPC API to update transaction status; "should be hosted in a private network"), a **Payment Observer** (watches Stellar RPC/Horizon for incoming payments and matches them to transactions by memo), an **event service** (Kafka `TRANSACTION` topic to HTTP webhooks), a **PostgreSQL** database, and a **business server you must implement** (answers rate/KYC callbacks, receives events, pushes off-chain status). Deployment: `git clone https://github.com/stellar/anchor-platform` then `quick-run/ap_start.sh` (Docker Compose, TESTNET only) for local; the getting-started/admin pages describe it as containerised (Docker) — Helm/Kubernetes guidance surfaced only for the sibling SDP in this corpus. Announced at Meridian 2022 (SDF blog 2022-11-02), SEP-31 receive + on/off-ramps added by Meridian 2023.

License: **not verifiable via Raven** (no license text indexed for stellar/anchor-platform; the only "Apache-2.0" hit was lightsail-network/java-stellar-sdk, a different project). Confirm on the repo's LICENSE file before relying on it.

Sending side: the docs are explicit that the Anchor Platform's SEP-31 implementation is **receive-only**; the SEP-31 guide builds "a cross-border payments receive-side service" that is "compatible with Stellar's existing set of send-side services." Nothing in the Anchor Platform exposes a sending-anchor client (SEP-10 client auth, SEP-12 PUT, SEP-38 POST /quote, SEP-31 POST /transactions, memo payment, status polling) as a product; the docs test the receive side by driving it from the Stellar Demo Wallet's "SEP-31 Send" screen. So for a sending-anchor backend the Anchor Platform is a reference for what the counterparty will expose, not something to deploy; the send side must be your own service (or SDK code), optionally alongside the Stellar Disbursement Platform if you need bulk payouts to wallets rather than to another anchor.

- Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/platforms/anchor-platform#supported-seps , https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/architecture ; `scout.searchResearch` (dev-docs) — https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/getting-started (publishedAt 2025-12-09); `stellarDocs.search_docs` — https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/getting-started ; SDF blog https://stellar.org/blog/developers/the-stellar-anchor-platform-connecting-to-stellar-made-simple (2022-11-02), https://stellar.org/blog/developers/the-anchor-platform-creating-access-through-on-and-off-ramps (2023-09-25); date: platform page indexed 2026-10-12; confidence: high for SEPs/architecture/receive-only, low (unverified) for license.

### (e) Anchors: USD on-ramp (US bank ACH) and COP payout in Colombia

| Anchor | Role (on-ramp USD / off-ramp COP) | SEPs (per source) | Rails (per source) | Status / date | Source | Confidence |
|---|---|---|---|---|---|---|
| **Bitso** | Off-ramp COP (coverage: Mexico, Brazil, Argentina, Colombia; currencies MXN, BRL, ARS, COP, USD); on/off-ramp USDC "connected to local banking rails" | Scout anchor profile `seps: []` (not listed); the caller's "SEP-31/38 receiving anchor" claim was **not confirmed** by any Raven row | Local banking rails (unspecified); no PSE/Bre-B mention | Live, statusAsOf 2026-09-02; coverage asOf 2026-07-09; Bitso blog "Bitso Adds Stellar USDC Support" 2026-06-11 | `scout.searchProjects` https://stellarlight.xyz/project/bitso ; `scout.getPartners` https://stellarlight.xyz/partners/anchor-bitso ; `lumenloop.get_project(bitso)`; `lumenloop.search_content_semantic` https://blog.bitso.com/blog/usdc-stellar | medium (coverage), low (SEPs/rails) |
| **VANK** (VANK Anchor: Colombia) | On-ramp COP→USDC via **PSE**; off-ramp USDC→COP via **ACH/bank transfer** with OFAC/UN/PEP/local-list screening; based in Colombia, operates CO/US | SEP-24, SEP-6, SEP-38, SEP-10, SEP-1 (per Lumenloop description and SCF application); no SEP-31 mentioned | PSE (deposit), ACH/bank transfer (payout); Bre-B not mentioned | Company "Live" (Scout 2026-09-01); anchor is **being built** under SCF #43 Build award ($96.8K); types Anchor, Payments | `lumenloop.get_project(vank)`, `lumenloop.get_scf_submissions(vank)` https://communityfund.stellar.org/submissions/recZv0mHzFOod8c4t ; `scout.searchProjects` https://stellarlight.xyz/project/vank | medium-high (self-described in SCF proposal; delivery status unverified) |
| **FinClusive** | US-based anchor, on-ramp + off-ramp, USDC & XLM; the only US anchor row with on-ramp capability. ACH not stated explicitly | sep-6, sep-24, sep-31 | not listed | toml fetched 2026-09-29 | `scout.getPartners` slug finclusive, https://finclusive.com | medium |
| **MoneyGram Access / Ramps** | USD cash on/off-ramp to USDC at ~500K retail locations, 170+ countries, "no bank account required"; **not a bank-ACH on-ramp**; launched MGUSD June 2026 | sep-24 | Cash in/out | Live, statusAsOf 2026-09-02; coverage asOf 2026-07-07 | `scout.searchProjects` https://stellarlight.xyz/project/moneygram ; docs "Integrate with MoneyGram Ramps" referenced at https://developers.stellar.org/docs/build/apps/overview#anchors | high |
| **Anclap** | On/off-ramp ARS and PEN (Argentina/Peru); no COP, no USD-ACH | sep-6, sep-24 | not listed | Live, 2026-10-13; toml 2026-09-29 | `scout.getPartners` anchor-anclap; `scout.searchProjects` anclap | high for scope, n/a for COP |
| **Mykobo** | EUR↔EURC (Euro) ramp; no COP, no USD | sep-6, sep-24, sep-31 | not listed | Live, 2026-10-13 | `scout.searchProjects` mykobo | high (irrelevant to USD/COP) |
| **Alfred (Alfred Pay)** | Stablecoin cross-border payments platform for businesses; no anchor profile, rails/SEPs/countries not in any Raven row | unknown | unknown | Live, 2026-08-17 | `scout.searchProjects` https://stellarlight.xyz/project/alfred ; `scout.getPartners` anchor-alfred-pay (placeholder) | low |
| Others seen (LatAm) | nTokens (BRL off-ramp, sep-6/24/31), CLPX (CLP, sep-6/24/31), VERSO (Peru PEN/USD, SEP-1/10/24/38, Anchor Platform), Etherfuse (MX), Felix Pago (US→MX/GT/HN remittance app, not an anchor) | as listed | n/a | toml 2026-09-29 | `scout.getPartners` (type anchor, region latam) | medium |
| **SDF test anchor** (testanchor.stellar.org) | Testnet demo anchor; docs call it "a reference anchor implementation" used in Wallet SDK tutorials | Confirmed in docs: SEP-1, SEP-10, SEP-24 (Wallet SDK), SEP-6/SEP-24 + SEP-12 (BasicPay tutorial). SEP-31/SEP-38 support **not confirmed** via Raven; the Anchor Platform SEP-31 guide tests "SEP-31 Send" with the Stellar Demo Wallet against a local Anchor Platform, not testanchor | n/a (testnet) | Current docs (SEP-10 page, BasicPay tutorial) | `stellarDocs.search_docs` https://developers.stellar.org/docs/build/apps/wallet/sep10#basic-authentication , https://developers.stellar.org/docs/build/apps/example-application-tutorial/anchor-integration/sep1 , https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/integration#test-with-the-demo-wallet | medium (SEP-1/10/6/24/12), low (31/38) |

Net: no Raven source lists an anchor with an explicit **US bank ACH deposit** rail; FinClusive is the only US-domiciled on-ramp anchor row (SEP-6/24/31) and its rails are unspecified. For **COP payout**, Bitso (coverage includes Colombia/COP, SEP list unknown) and VANK (PSE in / ACH out, SEP-6/24/38, under SCF build) are the only Colombia rows; a Scout partner query for "colombia" returned only Bitso, and semantic search surfaced an older SCF submission "Payment interoperability for wallets" (Colombian QR payments) and "On-ramp thru US bank account" (US accounts for LatAm freelancers settling in USDC) as adjacent candidates only.

- Source: `scout.searchProjects` (type Anchor, 44 total), `scout.getPartners` (type anchor / region latam / q colombia / q "united states"), `lumenloop.search_directory`, `lumenloop.get_project`, `lumenloop.get_scf_submissions`, `lumenloop.search_content_semantic`; dates as in table (Scout statusAsOf Aug–Oct 2026, toml 2026-09-29); confidence: medium overall (community-aggregated; SEP lists often empty).

### (f) Guidance on the sending anchor being a licensed money transmitter / MSB

The SEPs themselves do not impose a licensing requirement; SEP-31 only says the Sending Anchor is "the business receiving funds from the Sending Client" that "must have a business relationship with the Receiving Anchor", and that cross-jurisdiction payments "must be facilitated by two businesses". Official docs describe anchors as "typically operated by financial institutions or fintech companies" and say "Most anchors need to collect Know Your Customer information to comply with local regulations before honoring deposits and withdrawals ... How you handle KYC is up to you." SDF blog guidance is more direct: the USDC FAQ (2020-12-07) states "Licensed entities can offer on/off-ramp solutions for USDC ... Deposits and withdrawals must be processed through local domestic payment rails (ACH, SEPA, SPEI, etc.), not via wire transfer"; the Anchor Basics webinar recap (2020-06-23) frames the path to becoming an anchor for "financial institutions - both banks and non-bank fintech companies"; the 2024 anchor-map post says anchors "handle regulatory processes such as KYC/AML"; a 2016 roadmap post calls anchors "usually financial institutions licensed as money services providers." SEP-3 (Compliance protocol, 2019) notes "In some jurisdictions banks are able to trust the AML procedures of other licensed banks. In other jurisdictions each bank must do its own sanction checking of both the sender and the receiver." Nothing in the corpus says a sending anchor must specifically hold a US MSB/MTL registration; the consistent expectation is that whoever takes customer fiat and sends value cross-border is a regulated/licensed entity doing its own KYC/AML and sanctions screening (VANK's SCF proposal, for example, screens beneficiaries against OFAC/UN/PEP lists). Treat licensing as a jurisdictional legal question, not a protocol one.

- Source: `scout.searchResearch` (sep) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md (2024-11-05), sep-0003.md (2019-10-04); `scout.searchResearch` (sdf-blog/dev-docs) — https://stellar.org/blog/ecosystem/usdc-stellar-faq (2020-12-07), https://stellar.org/blog/ecosystem/stellar-anchor-basics-webinar-recap (2020-06-23), https://stellar.org/blog/developers/introducing-anchor-network-interactive-map (2024-08-05), https://stellar.org/blog/ecosystem/roadmap (2016-05-16); `stellarDocs` — https://developers.stellar.org/docs/learn/fundamentals/anchors (indexed 2026-10-12), https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep24/setting-up-production-server#connecting-to-real-kyc (2026-07-21); confidence: high that no protocol-level rule exists; medium on the SDF "licensed entities" expectation (older blog posts).

### Implications for a sending-anchor backend that releases USDC to a Colombian receiving anchor

- You are the SEP-31 **Sending Anchor**: a business with a bilateral agreement with the receiver. The backend must implement the *client* side of SEP-1 discovery, SEP-10 auth (register your signing key with the receiver as a custodial client), SEP-12 `PUT/GET /customer` for both sender and receiver customer types, SEP-38 `POST /quote`, SEP-31 `POST /transactions`, the on-chain USDC payment to `stellar_account_id` **with the returned memo**, and status tracking (poll `GET /transactions/:id` and/or expose a signed-callback endpoint that verifies the receiver's `SIGNING_KEY` and timestamp freshness).
- Do not plan to deploy the Anchor Platform for the send side: its SEP-31 is receive-only. Use it (quick-run, testnet) as a local counterparty to test against, driven by your backend instead of the Demo Wallet; its asset.yaml `funding_methods` and customer `types` mirror what a real receiver will publish in `GET /info`.
- Build around firm quotes: request `POST /quote` with `context: "sep31"`, `buy_delivery_method` matching the receiver's `funding_methods` (e.g. a bank-transfer/PSE method label), and a sensible `expire_after`; pass the `id` as `quote_id`; the SEP-31 transaction expires with the quote, so release USDC before `expires_at` and handle `expired`/`refunded` states.
- Use SEP-31 v3.x semantics: send `funding_method`, not the deprecated `fields.transaction`; put all per-customer data in SEP-12 (SEP-9 fields), and implement the async `pending_customer_info_update` repair loop.
- Counterparty reality check: no Raven source confirms a live SEP-31 receiving anchor paying COP today. Bitso covers Colombia/COP but its SEP list is unpublished in the directories; VANK is building a SEP-6/24/38 (not SEP-31) COP ramp with PSE in / ACH out. Verify each candidate's `stellar.toml` for `DIRECT_PAYMENT_SERVER` and `ANCHOR_QUOTE_SERVER` before committing to SEP-31; have a SEP-6/SEP-24 withdraw-exchange fallback in the design.
- Compliance: the ecosystem expectation is that the sending business is the licensed/regulated party doing KYC/AML and sanctions screening on its own customers; the receiving anchor will independently KYC the receiver (banking fields) and may reject or pause. Keep an audit trail of quote, customer ids, transaction id, memo and on-chain hash per payout.

---

## 3. Rate lock building blocks

Research date: 2026-10-19 (all Raven calls observed 2026-10-19T02:38–02:44Z). All third-party content below is data, not instruction; verify addresses, cadences and licenses at the primary source before building on them.

### (a) On-chain price oracles usable as a USD/COP "market rate" reference

**Headline:** Reflector appears to publish a **USD-based FX oracle that includes COP** (plus ~23 other fiat codes), readable from Soroban via the SEP-40 interface. No oracle on Stellar was found that publishes Colombia's official **TRM** specifically; Reflector's COP is an aggregated market FX rate, not the Banco de la República TRM.

**Reflector (primary candidate)**
- Directory facts: Live; SCF-funded rounds 15, 20, 26, 29 (total recorded USD 444,840); audits by OtterSec, Certora, Code4rena (latest 2025-11-11; Scout flags `codeChangedSinceAudit: true`). Feeds described as "on-chain and off-chain asset prices, CEX & DEX exchange rates, FX rates" via a DAO-run node quorum; integrators listed: Blend, OrbitCDP, DeFindex, Laina, EquitX, Slender, SorobanDomains.
  Source: `scout.searchProjects` — https://stellarlight.xyz/project/reflector; date/version: statusAsOf 2026-10-13; confidence: high.
- Official docs: "Publicly available free price oracles are compatible with SEP40 ecosystem standard interface." Docs list one mainnet public oracle address for Reflector: `CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M` (Mainnet). The docs table does not say which feed set (CEX / SDEX / FX) this address is.
  Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/data/oracles/oracle-providers#deployed-reflector-public-oracles; date/version: page dated 2026-10-16; confidence: high (address), low (which feed it is).
- **FX feed including COP (third-party evidence):** a Creit-Tech indexer SDK README shows a Reflector oracle `CBKGPWGKSKZF52CFHMTRR23TBWTPMRDIYZ4O2P5VS65BMHYH4DXMCJZC` with `base_asset: "USD"`, `decimals: 14`, and a price snapshot dated 2026-07-08 whose asset map contains: EUR, GBP, CAD, BRL, JPY, CNY, MXN, KRW, TRY, ARS, PEN, VES, CLP, CRC, CDF, **COP** (`"29919571462"` → ≈ 0.000299 USD per COP, i.e. ≈ 3,342 COP/USD at that time), HKD, INR, NGN, PHP, RUB, ZAR, XAU, KES. This address is **not** on the official docs page; treat as unverified until checked against Reflector's own docs / on-chain `assets()` call.
  Source: `scout.searchResearch` (source=repo-docs) — https://github.com/Creit-Tech/Stellar-Indexer-SDK/blob/main/src/protocols/reflector/README.md; date/version: snapshot timestamp 2026-07-08T03:05Z, README undated; confidence: medium.
- Cadence / retention: same README shows a Reflector oracle record (CEX oracle `CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN`) with `resolution: 300000` (ms → 5 min) and `period: 86400000` (ms → 24 h history retention), `protocol: 2`. DeepWiki read of the contract repo says `resolution()` is "the default tick period timeframe in seconds (e.g., 5 minutes by default for ReflectorPulse)". FX-feed cadence was not independently confirmed; assume 5-minute ticks pending verification.
  Source: `scout.searchResearch` (repo-docs) same README; `scout.explainRepo` repo=reflector-network/reflector-contract — https://deepwiki.com/reflector-network/reflector-contract; date/version: repo last commit 2026-07-23, scan ref 42f3116; confidence: medium.
- How a Soroban contract reads it (contract interface, from the repo scan): `base() -> Asset`, `assets() -> Vec<Asset>`, `decimals() -> u32`, `resolution() -> u32`, `last_timestamp() -> u64`, `lastprice(asset) -> Option<PriceData>`, `price(asset, timestamp) -> Option<PriceData>`, `prices(asset, records) -> Option<Vec<PriceData>>`, `history_retention_period() -> Option<u64>`, `expires(asset)`, `extend_asset_ttl(sponsor, asset, amount)`, `fee_config()`. Two variants exist: `PulseOracleContract` (free public, `lastprice(asset)`) and `BeamOracleContract` (fee-bearing, `lastprice(caller, asset)` with `estimate_cost(periods)`). Staleness: "consumer contracts should verify the `timestamp` field of the returned price data against the current ledger timestamp." On-chain usage signal: 1 contract, 44,447 events, 183,156 sub-invocations (as of 2026-08-13).
  Source: `scout.explainRepo` — https://github.com/reflector-network/reflector-contract; confidence: medium (DeepWiki-derived; verify in source).
- License: **not visible in Raven results — verify at repo** (DeepWiki explicitly said the context contains no license statement). Repo: https://github.com/reflector-network/reflector-contract (Rust, 12 stars, repoScore 87). JS client: https://github.com/reflector-network/contract-client-js (license: not visible in Raven results — verify at repo).
- Testnet addresses: not present in the docs page or Raven results; check Reflector's own docs.

**SEP-40 (Oracle Consumer Interface)** — the standard both Reflector and Lightecho claim.
```rust
pub struct PriceData { price: i128, timestamp: u64 }
enum Asset { Stellar(Address), Other(Symbol) }
pub trait PriceFeedTrait {
  fn base(env) -> Asset;            // base asset prices are quoted in
  fn assets(env) -> Vec<Asset>;     // all quoted assets
  fn decimals(env) -> u32;          // price = raw / 10^decimals
  fn resolution(env) -> u32;        // default tick period (seconds)
  fn price(env, asset, timestamp) -> Option<PriceData>;
  fn prices(env, asset, records) -> Option<Vec<PriceData>>;
  fn lastprice(env, asset) -> Option<PriceData>;
}
```
Fiat currencies are `Asset::Other(Symbol)` and "each Oracle can define its own format for representing off-chain assets" — so COP would be `Asset::Other(symbol_short!("COP"))` in Reflector's convention (verify). The spec also requires a **stable, upgradeable contract address**. Design note from the SEP: `price/10^decimals` in Soroban is integer division; keep math in raw i128 with explicit scaling.
Source: `scout.searchResearch` (source=sep) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0040.md; date/version: created 2023-05-13; confidence: high.

**Other oracles on Stellar (official docs list six providers; none shown with COP):**
| Oracle | Fiat FX? | Mainnet contract (from docs) | Notes | Source | Confidence |
|---|---|---|---|---|---|
| Reflector | Yes (FX oracle incl. COP per third-party README) | `CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M` (docs); FX: `CBKGP…MCJZC` (third-party) | SEP-40, 5-min resolution, 24 h retention (CEX feed record) | docs page + Creit-Tech README | high / medium |
| Lightecho (BP Ventures) | Emerging-market FX **vs XLM**: USD, EUR, NGN, KES, INR, ARS, BRL; no COP listed | not in docs page | Open-source SEP-40 Soroban oracle, updates every 10 min, 50+ sources; SCF #16 $93,110 Legacy v4.0; repo last commit 2025-09-08; license: not visible in Raven results — verify at repo | `scout.searchProjects` https://stellarlight.xyz/project/lightecho; repo https://github.com/bp-ventures/lightecho-stellar-oracle | medium |
| Band | Unknown for Stellar; symbol-based `relay(symbol_rates)` std-reference contract | `CCQXWMZVM3KRTXTUPTN53YHL272QGKF32L7XEDNZ2S6OSUFK3NFBGG5M` (Mainnet), `CBRV5ZEQSSCQ4FFO64OF46I3UASBVEJNE5C2MCFWVIXL4Z7DMD7PJJMF` (Testnet) | Repo dormant (last commit 2024-02-29); audited by Runtime Verification 2024 | docs page; `scout.searchProjects` | high (addr) / low (fiat coverage) |
| DIA | Not shown; feeds "e.g. BTC/USD, USDC", custom feeds on request | `CAEDPEZDRCEJCF73ASC5JGNKCIJDV2QJQSW6DJ6B74MYALBNKCJ5IFP4` (**Testnet** only in docs) | SCF #20 $38,000 | docs page | high |
| RedStone | No (XLM, BTC, ETH, USDC, EURC, PYUSD, USDT0, USDe, sUSDe, BENJI…) | `CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF` | Live on Stellar since March 2026 | docs page | high |
| Pyth | Not shown; "3,500+ feeds" | verifier `CACZ3GBAKUPIAFRILUFO27J5RUH5GJ2VSJ46LP6GJYSKGDRTQ5MS3HCH` | pull-model (verifier contract) | docs page; SDF blog 2026-09-14 | high |
| Chainlink | Not shown | proxy `CDQBHEUGLDHMSUHG4IH33RJBUTMNCZOT4JIAQR4WZFRDZW6DR6S32ZLZ` | single proxy, feed selected by 32-byte `data_id` | docs page | high |

Source for table: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/data/oracles/oracle-providers; date/version: 2026-10-16; confidence: high for addresses, medium for fiat coverage (tables flattened in index).
Also tracked but not in docs: Orally (SCF $48,000, repos dormant), Quasar/Nebula (Eiger; Nebula Inactive), Soroban Optimistic Oracle (Inactive). Source: `scout.searchProjects` type=Oracle; confidence: medium.

**TRM / USD-COP specifically:** Searches for "Colombian peso COP TRM oracle" across dev-docs, sdf-blog, repo-docs and lumenloop returned only the Reflector FX README hit above; no oracle exposing Colombia's TRM was found. This is an open-world negative (soft evidence), not proof of absence.
Source: `scout.searchResearch` (multi-source), `lumenloop.search_content_semantic`; confidence: medium (negative).

Skill guidance consulted: `skills.lumenloop.stellar-integration-finder` worked example "What oracle should I use to read prices on Stellar?" — recommends seeding with `search_directory("oracle")`, deep-diving Reflector, and deciding on "SEP-40 support, update cadence, supported assets". Source: `codemode.skill.read`; confidence: high (as guidance).

### (b) Stellar projects offering FX rate locks, forwards, or hedged remittance pricing

**SCF #45 "rate locks" award = Crebit Rate Locks (Build award).** Identified via `scout.searchResearch source=scf-proposal` and `lumenloop.find_similar_scf_submissions round="SCF #45"` (top similarity 0.487 for "rate lock locked exchange rate remittance").

| Project | What it does | Round / status / award | Code open? License | Source | Confidence |
|---|---|---|---|---|---|
| **Crebit Rate Locks** (Crebit / Crebit Pay) | "Programmable rate-lock layer for stablecoin FX": short-duration (1 h–24 h+) **USDC-settled non-deliverable forwards** between fiat (e.g. BRL, NGN) and US stablecoins. Client posts a deposit + premium (% of notional, duration-dependent), locks today's rate, receives USDC payout if market moves against them. Reference oracle selectable: "RedStone, Binance, or a custom Crebit oracle". Claimed $18.26M notional locked in the prior month; previously USDT-only settlement. Milestones: M1 Stellar settlement rail (Horizon client, tx builder, isolated ed25519 remote signer with kill-switch, idempotent replay, "signed envelopes persisted before broadcast, timebounds-based safe retry"); M2 **treasury auto-rebalancing** between Etherfuse TESOURO (BRL tokenized treasuries) and USDC based on net BRL/USD exposure of the open book, with a USDC settlement buffer "sized to worst-case near-term payouts"; M3 rate-lock API + dashboard; M4 CCTP V2 funding; M5 BlindPay deliverable forwards (PIX/ACH); M6 anchor ramp aggregation; M7–M9 mainnet hardening, launch, corridors. | SCF #45, **Awarded**, Build, requested $100,000 (resubmission — SCF #44 same title was **Not Awarded**). Scout: Live (statusAsOf 2026-08-31), scfTotalAwardedUSD 100,000. LumenLoop: `scf.awarded_total: 10000` — **source conflict** (likely LumenLoop tranche/first-disbursement vs Scout full award); verify at communityfund.stellar.org. | GitHub org listed: https://github.com/crebitpay — but Scout indexes **no repos** for either `crebit` or `crebit-pay`; no contract code found. Open-source status unknown; license: not visible in Raven results — verify at repo. Proposal describes an **off-chain engine** (Horizon client, signer, treasury) with on-chain USDC settlement, not a Soroban forward contract. | `scout.searchResearch` scf-proposal https://communityfund.stellar.org/submissions/rec11acDNjhqKRI82 ; #44: https://communityfund.stellar.org/submissions/recU1uYfKSZk9IFuQ ; `lumenloop.get_scf_submissions slug=crebit-pay`; `scout.searchProjects` https://stellarlight.xyz/project/crebit , https://stellarlight.xyz/project/crebit-pay | high (identity/status), medium (award amount), low (code) |
| FX Swap by Hedgehog | FX swaps on Soroban "to hedge the value of an existing investment against exchange-rate fluctuations"; includes "creation of an Oracle to keep track of the forward rates of various currencies". | SCF #21, Awarded, Legacy v5.0 Activation Award, $42,450 | No GitHub URL in submission; no linked directory project; license: not visible in Raven results — verify at repo | `lumenloop.get_scf_submissions name=Hedgehog` https://communityfund.stellar.org/submissions/rec5LpAd2YYGkMTnZ | medium (likely stale/inactive — no project record) |
| VANK Anchor: Colombia | Not a rate lock; **USDC–COP on/off ramp** anchor for Colombia (COP via PSE in, USDC out; USDC in, COP via ACH/bank out) via SEP-24/6/38/10/1 with OFAC/PEP screening. B2B platform claims $115M TPV 2025, fiat rails live in Colombia and USA. Relevant as the only COP-specific anchor build found. | SCF #43, Awarded, Build, $96,800; Scout status Live | No repos indexed; license: not visible in Raven results — verify at repo | https://communityfund.stellar.org/submissions/recZv0mHzFOod8c4t ; https://stellarlight.xyz/project/vank | high |
| OrbitCDP (Zenith) | CDP minting over-collateralized stable assets "for any fiat currency" (Reflector-fed) — a synthetic-FX, not a lock. | SCF 21, 25, 29 + Liquidity Award '25 Q2; Scout status **Inactive** | https://github.com/zenith-protocols (relayer-plugin-zenex active 2026-10-02); license: not visible in Raven results — verify at repo | https://stellarlight.xyz/project/orbitcdp | medium |
| FxDAO | XLM-backed multi-denomination stablecoins; "transparent backed stablecoins for more denominations". Not a lock. | SCF #13 Legacy v4.0 $74,800; Liquidity Awards '24 Q1 (Pending), '25 Q3 (Supplemental, $50,000) | license: not visible in Raven results — verify at repo | https://communityfund.stellar.org/submissions/recAC4HtF0qVZ5yww | medium |
| Upesa [Onchain FX] | Stablecoin currency-swap feature (USD–GHS/EUR/KES/NGN) inside a remittance app; spot, not lock. | SCF #38 | unknown | https://communityfund.stellar.org/submissions/recNYANviBH34BvEI | medium |
| Lucent "Fixed-Rate Stablecoin Credit" | Fixed-rate credit (interest-rate lock, not FX). | SCF #43 Not Awarded → SCF #44 Awarded, Build, $135,000 | unknown | https://communityfund.stellar.org/submissions/recZeITw6WJDXb0u8 | medium |

Other SCF #45 awardees surfaced by the FX/remittance query but not rate-lock products: "USDC on Stellar: LatAm Payout Corridors", "SFx remittances on Stellar via CCTP", "Bridge+Anchor XOF/USDC for lomi.", "Soroban lending facility & member ramps". Source: `lumenloop.find_similar_scf_submissions`; confidence: medium.

No Soroban **forward-contract** repo was found: `scout.searchRepos q="forward contract FX hedge soroban"` returned only adjacent DeFi repos (Fundable, Axis Markets, Rozo Intents, Zenex utils, Lobster, TrustLine) — none implementing FX forwards. Confidence: medium (negative).

### (c) DEX liquidity for USDC vs a COP-denominated asset on Stellar

| Asset / pool | Issuer / anchor | Liquidity signal | Source | Confidence |
|---|---|---|---|---|
| **COP stablecoin — none tracked** | — | Scout's curated stablecoin registry (41 tracked assets, measured every 6 h from Horizon/Stellar Expert) has pegs USD, EUR, AUD, SGD, AED, GBP, CAD, CHF, ZAR, JPY, ARS, NGN, BRL, MXN, CLP, PEN — **no COP peg** (`peg=COP` → 0 rows). Registry note: "Absence from this list means the asset is not tracked here: NOT proof it is not issued on Stellar; verify against Horizon." | `scout.getStablecoins` — https://stellarlight.xyz/api/stablecoins; dataAsOf 2026-10-18T20:55Z | high (for the registry), low as proof of absence |
| USDC (Circle) ↔ COP via anchor, not DEX | **VANK Anchor** (building, SCF #43 awarded): COP in via PSE / out via ACH, priced via SEP-38 quotes | Off-chain FX at anchor; no on-chain COP asset implied | https://stellarlight.xyz/project/vank | high |
| USDC ↔ COP via exchange anchor | **Bitso** — anchor profile: country Mexico, regions latam, assets [USDC], on-ramp/off-ramp; description says local currency in "Mexico and Colombia" | Off-chain; exchange-internal FX | https://stellarlight.xyz/project/bitso ; https://stellarlight.xyz/partners/anchor-bitso | medium (Colombia coverage from description only) |
| Nearest LatAm on-chain fiat assets (for comparison) | ARST (Settle Network, ARS; mcap ≈ $160k, 328,639 holders), ARS (Anclap; ≈ $27.7k), PEN (Anclap; supply 48,311, 41,417 holders, mcap null), CLPX (clpx.finance; supply 14.46M CLP, 5,780 holders), BRLT (Settle; ≈ $545), MXNe (Brale; ≈ $8) | All thin; even the largest LatAm fiat stablecoin is ~$160k mcap — a USDC/COP pool, if one existed, would likely be thinner | `scout.getStablecoins` dataAsOf 2026-10-18 | high |
| USDC/COP liquidity pool or order book | — | **Not found.** No COP asset in registry → no pool/orderbook row to inspect. `lumenloop.search_directory("COP")` returned only substring noise (Copperx, Soroban Copilot…); `"Colombia"` returned Bitso, Providencia Onchain, VANK. | `scout.getStablecoins`, `lumenloop.search_directory` | medium (negative) |

**What the docs say about path payments and Horizon path finding (for quoting):**
- `PathPaymentStrictSend`: fixes `sendAmount`; parameters `sendAsset, sendAmount, destination, destAsset, destMin, path[]`; result `PathPaymentStrictSendResult`; threshold Medium. `PathPaymentStrictReceive`: fixes destination amount, sender specifies `sendMax`. The liquidity doc says path payments execute across **both SDEX order books and AMM liquidity pools**: "just use PathPaymentStrictReceive or PathPaymentStrictSend."
  Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations#path-payment-strict-send ; https://developers.stellar.org/docs/learn/fundamentals/liquidity-on-stellar-sdex-liquidity-pools#operations ; date/version: 2026-08-24; confidence: high.
- Horizon `GET /paths/strict-send`: "lists the paths a payment can take based on the amount of an asset you want to send. The source asset amount stays constant, and the type and amount of an asset received varies based on offers in the order books… Horizon loads a list of assets that the recipient can receive (based on `destination_account` or `destination_assets`)… Only paths that satisfy the `source_amount` are returned." `GET /paths/strict-receive` is the mirror (fixed `destination_amount`, `source_account` or `source_assets`). Note: the Stellar docs search index itself returned soft-empty for the per-endpoint page; the text came from Scout's dev-docs mirror.
  Source: `scout.searchResearch` (source=dev-docs) — https://developers.stellar.org/docs/data/apis/horizon/api-reference/list-strict-send-payment-paths ; https://developers.stellar.org/docs/data/apis/horizon/api-reference/list-strict-receive-payment-paths ; date/version: 2026-07-14; confidence: high.
- JS SDK usage: `server.strictSendPaths(asset, sourceAmount, destinationPublicKey)` / `server.strictReceivePaths(...)` returning `PaymentPathRecord[]` (tutorial `findStrictSendPaths` / `findStrictReceivePaths`); then `Operation.pathPaymentStrictSend({ sendAsset, sendAmount, destination, destAsset, destMin, path })`. The agent-CLI cookbook shows the same pattern: "set the bound below the quote" (`destMin` as slippage floor).
  Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/apps/example-application-tutorial/querying-data#findstrictsendpaths ; https://developers.stellar.org/docs/build/apps/example-application-tutorial/path-payment ; https://developers.stellar.org/docs/tools/cli/agent-cli/guides/usdt0-on-mainnet#acquire-usdt0 ; confidence: high.
- Implication: `/paths/strict-send` only quotes what on-chain order books/pools can fill **right now**; with no COP asset it cannot quote USDC→COP at all. For a USD/COP rate it is not a usable price source; the anchor's SEP-38 quote or an oracle is.

### (d) Docs / research on a quote-and-lock pattern on Soroban

- **SEP-38 firm vs indicative quotes (closest existing standard for a time-bounded locked rate):** Anchor Platform `GET /rate` callback: "If `type=firm`, your response must include the `id` & `expires_at` date-time field and **reserve the liquidity needed to fulfil this quote until the quote expires**. If `type=indicative`, do not return `id` or `expires_at`… the client may request that the quote expires after a specific date-time using the `expires_after` parameter. Your business must honor this request by returning an `expires_at` value that is at or after the requested date." Wallet docs: a POST quote "is stored by the anchor for a certain period of time… The `expires_at` field tells us how long the anchor will wait to receive funds for this quote." SEP-6/24 note the anchor must say whether a displayed exchange rate "is binding or an estimate". Assets use `iso4217:COP` / `stellar:USDC:G…` identifiers.
  Source: `scout.searchResearch` (sep, dev-docs) — https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/integration#rate-callback-endpoint (2026-07-06); https://developers.stellar.org/docs/build/apps/wallet/sep38 (2026-04-28); https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md (2025-02-26); confidence: high.
- **Signed message verification on-chain:** `env.crypto().ed25519_verify(&public_key, &payload, &signature)` is the host function used throughout the official custom-account examples (simple-account, complex-account, `__check_auth` tutorials). SEP-53 "Sign and Verify Messages" (Final, v1.0.0, updated 2026-06-18) standardizes off-chain message signing with Stellar keys — relevant if the lock engine signs quotes that a contract later verifies.
  Source: `stellarDocs.search_soroban_contract_docs` — https://developers.stellar.org/docs/build/smart-contracts/example-contracts/simple-account#implement-__check_auth ; https://developers.stellar.org/docs/build/guides/auth/contract-authorization#how-it-works ; `scout.searchResearch` (sep) https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md ; confidence: high.
- **Time/expiry rules in contracts:** read `env.ledger().timestamp()` / `env.ledger().sequence()`; the contract-accounts guide's "Time rules" pattern: "Store the earliest allowed timestamp in instance storage; compare it against the current ledger timestamp in `__check_auth`." The `__check_auth` tutorial shows time-based restrictions and tests via `env.ledger().set(LedgerInfo { timestamp, sequence, … })`.
  Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/guides/contract-accounts/advanced-patterns#time-rules (2026-10-12); https://developers.stellar.org/docs/build/guides/auth/check-auth-tutorials (2026-09-24); confidence: high.
- **Storage for quotes with a deadline:** "Strategy 4: Temporary storage for data with a deadline — state that is only meaningful until some ledger: allowances with expiry, live auctions, oracle prices… Use `temporary()` storage and align the TTL with the business deadline — then enforce that deadline in the value": reject `live_until_ledger < e.ledger().sequence()`, store `{amount, live_until_ledger}`, `extend_ttl(key, live_for, live_for)`. Directly applicable to storing a locked-rate record that expires.
  Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/guides/storage/storage-strategies#strategy-4-temporary-storage-for-data-with-a-deadline (2026-07-27); confidence: high.
- **Audit-derived pitfalls for signed quotes and oracle staleness:**
  - Moonlight (Runtime Verification, 2026-07-24), finding B6: the contract rejected entries whose `valid_until_ledger` was past, "but that field is not covered by any provider signature… attached by the transaction submitter, who can set any value. So this check constrains only a submitter acting against its own interest: it cannot enforce a deadline the provider chose." → **The expiry must be inside the signed payload.** Source: `scout.searchResearch` (audit) — https://stellarsecurityportal.com/report/78; confidence: high.
  - OctoLend (Runtime Verification, 2026-03-20), A3: `MAX_STALENESS` (3600 s) check against oracle `timestamp` was commented out → stale prices accepted. Peridot (Halborn, 2026-03-09): admin fallback price with no `set_at` timestamp stays valid indefinitely; 3× staleness-window asymmetry. → Enforce `now - price.timestamp <= MAX_STALENESS` and never store a reference rate without its timestamp. Source: https://stellarsecurityportal.com/report/75 ; https://stellarsecurityportal.com/report/83; confidence: high.
  - Reflector's own guidance (DeepWiki): consumers "should verify the `timestamp` field of the returned price data against the current ledger timestamp." Confidence: medium.
- **Prior art repos for "signed quote verified on-chain":** `scout.searchRepos q="signed quote ed25519 verify expiry soroban"` returned no dedicated implementation (hits: walleterm, soroban-budget-assert, SocketFi smart account, axelar deployments, rs-stellar-strkey, uvd-x402-sdk). The x402-on-Stellar docs describe the nearest analogous pattern: the client signs a Soroban **authorization entry** (contract ID, function, args, nonce, expiration ledger) rather than a pre-signed transaction. Source: https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar#understanding-soroban-authorization (2026-07-21); confidence: medium.
- Crebit's own proposal (above) is the only Stellar-specific description found of an off-chain lock engine with treasury hedge: deposit + duration-priced premium, selectable reference oracle, USDC settlement, treasury rebalanced against net exposure, "signed envelopes persisted before broadcast, timebounds-based safe retry" for double-pay protection. Confidence: high (as described by applicant; unverified build).

### Implications for an off-chain lock engine with a treasury hedge, where the chain only records the locked rate

- **Reference rate source:** Reflector's USD-based FX oracle appears to include COP at 14 decimals with ~5-minute ticks, so a Soroban contract *can* read a USD/COP market rate via SEP-40 `lastprice(Asset::Other("COP"))`. But it is an aggregated market rate, not the TRM; if the product promises "TRM-based" pricing, the TRM must come off-chain, and the on-chain oracle can only serve as a **sanity band** (e.g., reject a lock whose rate deviates >X% from `lastprice`) — verify the `CBKGP…` address and asset symbol format against Reflector's docs first, since it is not on the official SDF page.
- **Put the expiry and rate inside the signed payload.** The Moonlight audit shows the exact failure mode: an expiry carried outside the signature is attacker-controlled. A quote record should be `{quote_id, pair, rate (i128, decimals), amount, expires_at_ledger_or_ts, nonce}` signed by the engine key; the contract verifies with `ed25519_verify`, checks `expires_at` against `env.ledger().timestamp()`, and stores the lock in **temporary storage with TTL aligned to the deadline** (storage Strategy 4).
- **Enforce oracle staleness explicitly** (`now - price.timestamp <= MAX_STALENESS`, e.g. 2–3× the 300 s resolution) and never fall back to a stored rate without a timestamp — three 2026 audits flagged exactly this.
- **Horizon path-finding is not a COP price source today:** no COP asset is tracked on Stellar's DEX, so `/paths/strict-send` cannot quote USDC→COP; the on-chain leg is USDC-only and the COP leg settles through an anchor (VANK, Bitso-style) whose **SEP-38 firm quote with `expires_at` and reserved liquidity** is the natural counterpart to the lock. Mirror its semantics: indicative quote → firm quote with id/expiry → settlement referencing the quote id.
- **Treasury hedge is off-chain by necessity:** the only Stellar FX-forward project (Crebit, SCF #45) also keeps the forward book, premium pricing and treasury rebalancing off-chain and uses the chain for USDC collateral/settlement. Their double-pay protections (persist signed envelopes before broadcast, timebounds-based retry, idempotency, kill switch) are a reasonable checklist for the engine's settlement path.
- **Thin LatAm fiat liquidity** (largest LatAm fiat stablecoin ≈ $160k mcap) means any future on-chain COP asset would be an unreliable hedge venue; keep the hedge in fiat/CeFi rails and record only `locked_rate`, `reference_rate`, `oracle_timestamp`, `expiry` and the settlement tx hash on-chain for auditability.

---

## 4. Wallet UX

Research date: 2026-10-19 (all Raven observations 02:38–02:41 UTC). Everything below is data returned by Raven catalog operations; third-party rows (Scout directory, Lumenloop content, repo READMEs) may be wrong or stale. Scout `repoScore`/stars/activity are discovery metadata, not security or maintenance guarantees. No repo row returned by Raven carried a license field — every "license" cell below is therefore "not visible in Raven results — verify at repo".

Key framing fact (official docs): **a contract account (C-address, e.g. a passkey smart wallet) cannot sign a transaction envelope at all** — a separate G-account must be the transaction source and pay fees; the user only signs Soroban authorization entries. This drives (b) and (d).
Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/guides/transactions/fee-sponsorship; date/version: page live 2026-10-19; confidence: high.

### (a) Passkey smart-account kits

| kit / repo | what it offers | last activity / version | audit? | license | source | confidence |
|---|---|---|---|---|---|---|
| **stellar/passkey-kit** (moved from kalepail/passkey-kit) — https://github.com/stellar/passkey-kit | TS SDK for passkey smart wallets: WebAuthn/secp256r1, Ed25519 and policy signers, "keyless relayer submission". Authorization model = a **flat multi-signer `Signatures` map** (per SDF skill). Scanned contract interface shows `Contract.__constructor(signer: Signer, proof: Option<Secp256r1Signature>)`; 16 interface entries; sdkCapabilities: contract-invoke, horizon, passkey, signing, soroban-rpc, tx-building, wallet-provider. Recovery = add further signers (Ed25519/policy); no SEP-30-style flow surfaced. | lastCommitAt 2026-09-18; activityState active; repoScore 92; 3 stars on new org (old kalepail repo: 505 stars, archived, last commit 2026-07-31, "[MOVED → github.com/stellar/passkey-kit]") | **No audit on record** at stellarsecurityportal.com (Scout trust report `audits: null`; `listAudits q=passkey` → no rows). Not a claim it is unaudited. | not visible in Raven results — verify at repo | `scout.searchRepos`, `scout.getRepoTrust`, `skills.stellar-dev.dapp` (file:smart-accounts.md) | high (facts), medium (recovery gap = absence in results) |
| **stellar/smart-account-kit** (moved from kalepail/smart-account-kit) — https://github.com/stellar/smart-account-kit ; npm `smart-account-kit` | TS SDK that deploys/drives **OpenZeppelin Smart Account** contracts. Features per SDF skill: session management (IndexedDB, silent reconnect), signer types passkey (secp256r1) / Ed25519 / policies, **context rules**, **policies: threshold multisig, spending limits, custom**, external-wallet adapters (Freighter, LOBSTR), optional **gasless via OpenZeppelin Relayer**. API: `createWallet`, `connectWallet`, `signAndSubmit`, `transfer`. Used by the official guestbook tutorial. | lastCommitAt 2026-09-18; active; repoScore 85; 5 stars (old repo archived 2026-07-31) | Kit itself: `audits: null`. The **account contract it deploys is in OpenZeppelin/stellar-contracts, which is audited** (see next row). | not visible in Raven results — verify at repo | `scout.searchRepos`, `scout.getRepoTrust`, `skills.stellar-dev.dapp`, `stellarDocs.search_wallet_dapp_docs` (https://developers.stellar.org/docs/build/apps/guestbook) | high |
| **OpenZeppelin/stellar-contracts** (accounts module: Smart Account) — https://github.com/OpenZeppelin/stellar-contracts ; docs docs.openzeppelin.com/stellar-contracts/accounts/smart-account | Rust/Soroban library. Smart Account = "modular smart account framework… separates **signers, context rules, and policies (multisig, spending limits)**". Scanned interface (42 entries) includes `TimelockController.__check_auth(...)`, `TimelockController.__constructor…`. Also has Upgradeable module (skill `skills.openzeppelin-stellar.upgrade-stellar-contracts`). | lastCommitAt 2026-10-12; active; repoScore 69; 97 stars | **Audited, 2 reports** (auditor OpenZeppelin): v0.1.0 — 2025-02-20 https://stellarsecurityportal.com/report/2 ; v0.3.0-rc.2 — 2025-07-09 https://stellarsecurityportal.com/report/35. Trust signals: `audited`, **`code-changed-since-audit`**, auditDrift 460 days (latest audit 2025-07-09 vs last commit 2026-10-12). Whether the Smart Account module was in the audited scope is not stated in Raven rows. | not visible in Raven results — verify at repo | `scout.getRepoTrust`, `scout.listAudits q=openzeppelin`, `stellarDocs.get_doc_page_sections` (smart-wallets guide) | high (audit rows), medium (scope) |
| **SDF "Smart wallets" guide + Contract Accounts section** — https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets ; https://developers.stellar.org/docs/build/guides/contract-accounts/advanced-patterns ; tutorial https://developers.stellar.org/docs/build/apps/guestbook | Official position: two TS SDKs are **siblings, not versions** — "different on-chain authorization model, so they aren't drop-in compatible". Smart Account Kit "when you want thresholds, spending limits, or other policy-driven rules"; passkey-kit when a flat signer model suffices. secp256r1 native since **Protocol 21 (CAP-0051)**, mainnet 2024-06-18. Advanced-patterns page lists OZ Smart Account, Smart Account Kit, and "Crossmint smart account" as reference implementations. Retired tooling: Launchtube. Tracks "evolving contract account interface in the SEP discussion". | Docs chunks dated 2026-10-12 (Scout research index) | n/a | n/a | `stellarDocs.get_doc_page_sections`, `stellarDocs.search_docs` (software-versions page), `scout.searchResearch` | high |
| **stellar/sep45-reference** — https://github.com/stellar/sep45-reference | SEP-45 reference implementation; includes a minimal account contract (`Account.__constructor(admin: Address, signer: BytesN<3…)`, `Account.upgrade(new_wasm_hash)`); sdkCapabilities incl. sep10-auth. Useful as the C-account ↔ anchor test fixture, not as a production wallet. | lastCommitAt 2026-10-06; active; repoScore 85 | `audits: null` | not visible in Raven results — verify at repo | `scout.searchRepos`, `scout.getRepoTrust` | high |
| Other community kits (prior art only): **Socket-Fi/socketfi-smart-account** https://github.com/Socket-Fi/socketfi-smart-account (Rust; "passkeys, guardian emergency controls, passkey rotation, and BLS-based recovery"; 2026-09-14; score 52); **justmert/soropass** https://github.com/justmert/soropass (minimal passkey SDK + UI; 2026-10-12; score 48); **nidohq/nido** https://github.com/nidohq/nido (passkey smart wallet; 2026-10-14; score 48); **untangledfinance/oz-policy-builder** https://github.com/untangledfinance/oz-policy-builder (records a Soroban tx and synthesises the minimal OZ policy for it; 2026-10-11; score 60) | see descriptions | as listed | none on record | not visible in Raven results — verify at repo | `scout.searchRepos` | medium (descriptions are self-reported) |

Also surfaced: kalepail/superpeach (multisig smart-wallet demo, dormant 2025-05-15); SDF blog "Introducing the New Stellar Passkey Feature… on Mainnet" 2024-06-27 and "Building Meridian Pay: A Scalable Smart Wallet on Stellar" 2026-02-05 (production passkey wallet by SDF).
Source: `scout.searchRepos`; `lumenloop.search_content_semantic` — https://stellar.org/blog/foundation-news/introducing-the-new-stellar-passkey-feature-seamless-web3-smart-wallet-functionality-on-mainnet ; https://stellar.org/blog/ecosystem/building-meridian-pay-smart-wallet-on-stellar ; date/version: as listed; confidence: medium (semantic rows, unverified-match caveat).

### (b) Fee sponsorship options

| option / repo | what it offers (per docs) | last activity / version | audit? | license | source | confidence |
|---|---|---|---|---|---|---|
| **Fee-bump transactions** (protocol, CAP-15) — https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions | Outer envelope signed by a *fee account* pays for an already-signed inner tx; inner source still spends its sequence number; fee ≥ network min for (inner ops + 1) and ≥ inner fee; replace-by-fee needs 10× bid. **Limitation for us: "A contract account can't sign the inner transaction, so a fee-bump on its own doesn't cover a contract account's fees."** Use case "service where you want to cover user fees" for G-account users. | Protocol feature; docs current 2026-10-19 | n/a | n/a | `stellarDocs.get_doc_page_sections`, `stellarDocs.search_protocol_concepts_docs` | high |
| **Sponsored reserves** (CAP-33) — https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves | Sandwich Begin/End Sponsoring Future Reserves (both parties sign); covers anything that raises min balance: account creation (start balance 0), trustlines, signers, offers, data, claimable balances; min balance = (2 + numSubEntries + numSponsoring − numSponsored) × baseReserve; revocation/transfer supported. **Limitation: "Smart contract data doesn't require base reserves; it pays rent instead… sponsored reserves don't cover [a contract account's] storage."** Useful only if we also give the buyer a G-account/trustline. | Protocol feature; docs current | n/a | n/a | `stellarDocs.get_doc_page_sections` | high |
| **Relayer pattern** (SDF guidance) — https://developers.stellar.org/docs/build/guides/transactions/fee-sponsorship | "Use a relayer when the user has a contract account." User signs only auth entries; relayer rebuilds tx with its own G-account as source, pays inclusion + resource fee (incl. rent), submits; can wrap in fee-bump and use channel accounts for parallelism; self-host (you control signer and fund fee accounts) or managed. Docs note the managed recommendation "changes over time". | Docs current | n/a | n/a | `stellarDocs.get_doc_page_sections` | high |
| **OpenZeppelin Relayer + "Stellar Channels"** — repo https://github.com/OpenZeppelin/openzeppelin-relayer ; docs https://developers.stellar.org/docs/tools/openzeppelin-relayer ; OZ guide docs.openzeppelin.com/relayer/guides/stellar-channels-guide | SDF-pointed replacement for Launchtube: "SDF has discontinued the Launchtube service and points developers to OpenZeppelin's managed Stellar Channels service". Client SDK `@openzeppelin/relayer-plugin-channels` (`ChannelsClient`, `submitSorobanTransaction({func, auth})`); hosted testnet `https://channels.openzeppelin.com/testnet` with API keys at `/gen`; **production = self-host via Docker** (docs/skill) — managed mainnet terms not visible in Raven; status page exists. Must be called server-side (CORS; keep API key off the browser — the guestbook uses a `/api/send` proxy). Manages fees, channel accounts, sequence numbers. Also used by the x402 facilitator guide. | Relayer lastCommitAt 2026-10-09; active; repoScore 65; 154 stars. IaC repo OpenZeppelin/relayer-channels-infra 2026-09-30. Docs page indexed 2026-09-08. | Trust report attaches the **OpenZeppelin stellar-contracts audits (2025-02-20, 2025-07-09)** at project level — i.e. the relayer binary itself has **no relayer-specific audit visible**; signal `code-changed-since-audit`. | not visible in Raven results — verify at repo | `stellarDocs.get_doc_page_sections`, `scout.getRepoTrust`, `skills.stellar-dev.dapp`, `skills.stellar-dev.agentic-payments` (description) | high (status), medium (audit scope) |
| **Launchtube (kalepail / stellar)** — https://github.com/stellar/launchtube | Former SDF-hosted relay for passkey txs ("Simulate and sign your Soroban ops, submit them to Launchtube…"). **Retired**: docs "Retired tooling — the stellar/launchtube repository is archived and the hosted service has been retired; use OpenZeppelin Relayer instead." | archived; lastCommitAt 2026-01-14; repoScore 33 | none | not visible in Raven results — verify at repo | `stellarDocs.get_doc_page_sections` (smart-wallets guide), `scout.getRepoTrust` | high |
| **Channel accounts** (classic pattern) — listed in How-To Guides > Transactions ("Channel accounts") | Pool of G-accounts supplying sequence numbers so a relayer can submit in parallel; OZ Relayer runs such a pool ("OpenZeppelin runs the pool of channel accounts and covers…"). | docs current | n/a | n/a | `stellarDocs.search_docs`, `stellarDocs.search_sdk_cli_tools_docs` | high |
| Other relayers / paymasters (prior art, unvetted): **Stellar-Paymaster/xlm-paymaster** https://github.com/Stellar-Paymaster/xlm-paymaster ("self hostable… users pay with their preferred token while handling XLM fees"; 2026-06-29; maintained; score 39); **zenith-protocols/relayer-plugin-zenex** https://github.com/zenith-protocols/relayer-plugin-zenex (OZ Relayer plugin; 2026-10-02; score 76); SODAX "sponsored account activation" SDK (x.com article 2026-09-04, G-account activation, unverified) | as described | as listed | none on record | not visible in Raven results — verify at repo | `scout.searchRepos`, `lumenloop.search_content_semantic` | low–medium |

Tooling note: the docs reference a "Stellar Wallet Sponsorship Calculator" for estimating XLM needed for sponsored reserves + fee-bumps (G-account onboarding only).
Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions ; confidence: high.

### (c) SEP-7 payment URIs / QR codes

- **Spec status**: SEP-0007 "URI Scheme to facilitate delegated signing" — **Status: Active, Version 2.1.0, Created 2018-05-07, Updated 2020-07-29**, author Nikhil Saraf. References BIP-21, EIP-681, SEP-0011 (Txrep).
  Source: `scout.searchResearch` (source=sep) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md ; date/version: 2020-07-29 / 2.1.0; confidence: high.
- **Shape**: `web+stellar:<operation>?<param>=<value>&…`. Two operations: `tx` (a full transaction envelope `xdr=`, plus `callback`, `pubkey`, `msg`, field `replace` via Txrep) and `pay`. Example `pay` URI from the Wallet SDK docs carries: `destination` (G…), `amount`, `memo`, `msg`, `origin_domain`, `asset_issuer`, `asset_code`; "regardless of the source asset used by the payer" (i.e. the wallet may path-pay). Optional signature: payload signed with the origin domain's signing key; verifier fetches `stellar.toml` from `origin_domain` to check it.
  Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/apps/wallet/sep7 ; `scout.searchResearch` — sep-0007.md Specification chunk; date/version: Wallet SDK page indexed 2025-12-19; confidence: high.
- **Soroban contract invocations**: Nothing in the returned SEP-7 chunks or Wallet SDK page mentions Soroban, contract IDs or InvokeHostFunction; `pay` is a classic payment to a G… destination. A `tx` URI carries arbitrary envelope XDR, so a Soroban InvokeHostFunction tx could technically be embedded, but the spec predates Soroban (2020) and Raven surfaced no wallet or doc stating support — treat as **not supported / unverified**. Also, a C-address recipient cannot be expressed in `pay`.
  Source: same as above (absence in returned chunks); confidence: medium-low — verify against the current sep-0007.md.
- **Wallet SDK support**: official Wallet SDK implements `Sep7Tx`/`Sep7Pay` builders + URI signing in TypeScript, Kotlin, Flutter (Dart) and Swift.
  Source: `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/apps/wallet/sep7 ; confidence: high.
- **Wallet support**: Raven did not return a per-wallet SEP-7 support matrix. Adjacent signals only: Albedo is a "delegated signer" (SEP-7's target role) — https://github.com/stellar-expert/albedo (maintained, 2026-08-31); Beans wallet markets "QR payments" (directory, 2026-09-02). Confidence: low — check each wallet.
  Source: `scout.searchProjects`, `scout.searchRepos` — https://stellarlight.xyz/project/albedo ; https://stellarlight.xyz/project/beans.

### (d) Contract account (C-address) ↔ anchor authentication

- **SEP-45 "Stellar Web Authentication for Contract Accounts"**: **Status: Draft, Version 0.1.1, Created 2024-10-08, Updated 2025-12-16**; authors Philip Liu, Marcelo Salloum, Leigh McCulloch; discussion stellar-protocol #1620.
  Source: `scout.searchResearch` (source=sep) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0045.md ; confidence: high.
- **Anchor Platform supports it** (despite Draft status). Docs: "The Anchor Platform implements SEP-45 with support for: Challenge/Response Flow: GET /sep45/auth … POST /sep45/auth to validate and receive a JWT; Contract Account Authentication (C…) using Soroban authorization entries; Transaction Simulation; Multiple Home Domains". Requires `STELLAR_NETWORK_TYPE=rpc` (RPC mode) and a Stellar RPC endpoint; `stellar.toml` must advertise `WEB_AUTH_FOR_CONTRACTS_ENDPOINT` and `WEB_AUTH_CONTRACT_ID`; a SEP-45 contract is in the Anchor Platform repo, testnet instance `CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX`. Key-features page: "SEP-10 and SEP-45 support for both traditional and smart contract accounts… Native support for Stellar contract accounts (C-accounts) via SEP-45". SEP-6/24/31 getting-started pages list SEP-45 as a prerequisite config alongside SEP-1 and SEP-10. Explicit: **"SEP-45 does not replace SEP-10. SEP-45 supports contract accounts (C...), while SEP-10 supports cl[assic]"**.
  Source: `stellarDocs.get_doc_page_sections` / `stellarDocs.search_anchor_sep_docs` — https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep45 ; https://developers.stellar.org/docs/platforms/anchor-platform#key-features ; https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep24/getting-started ; date: page indexed 2026-10-12; Anchor Platform repo https://github.com/stellar/anchor-platform lastCommitAt 2026-10-09 (repoScore 94); confidence: high.
- **Reference client**: https://github.com/stellar/sep45-reference (active, 2026-10-06). Predecessor experiment https://github.com/stellar/sep-smart-wallet ("Passkey-based smart wallet… SEPs 10c and 24") is **archived** (last commit 2024-10-08) — "SEP-10c" naming is obsolete; SEP-45 is the successor.
  Source: `scout.searchRepos` / `scout.getRepoTrust`; confidence: high.
- **Production use in SDF products**: Stellar Disbursement Platform "Embedded Wallets" are passkey-controlled contract accounts; "The SDP uses SEP-45 during SEP-24 flows to verify that receivers control their embedded wallets"; receiver gets a SEP-24 JWT generated during passkey auth; HTTPS required for WebAuthn.
  Source: `stellarDocs.search_docs` — https://developers.stellar.org/docs/platforms/stellar-disbursement-platform/admin-guide/embedded-wallets ; confidence: high.
- **Third-party anchors**: Raven gave no evidence on which live anchors have enabled SEP-45; Anchor Platform ships it, but each anchor must configure RPC mode and the toml fields — check the target anchor's `stellar.toml` for `WEB_AUTH_FOR_CONTRACTS_ENDPOINT`. Confidence: medium (inference from config docs).
- **Related drafts / discussion**: SEP-0059 "External Account API" (Draft, v0.4.0, created 2026-03-19, updated 2026-05-15) has an explicit branch "Contract account (C...)" alongside SEP-10 for G/M accounts — emerging, not implemented in Anchor Platform per Raven. Protocol meetings 2026-07-09 and 2026-07-16 discussed CAP-84 "Muxed Contract Addresses" and "how a custodial contract account would work with SEP-24 without the CAP" — i.e. pooled/custodial C-accounts with anchors is an open design topic.
  Source: `scout.searchResearch` — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0059.md ; `stellarDocs.search_meeting_notes` — https://developers.stellar.org/meetings/2026/07/09#is-there-demand ; https://developers.stellar.org/meetings/2026/07/16/protocol#cap-84-follow-up-why-muxed-contract-addresses ; confidence: medium.
- **Fallback if the anchor lacks SEP-45**: SEP-10 authenticates only G/M accounts, so the app must hold a classic keypair for the buyer: either an app-custodied/embedded G-account (custody model "Custodial service" or "Mixture of both — with the use of multisig" per Application Design Considerations) that performs SEP-10 + SEP-24/6 and then forwards funds to the C-address, or an anchor-created account during first deposit ("Account creation strategies": wallet-created vs anchor-created). The G-account itself needs reserves → sponsored reserves apply here.
  Source: `stellarDocs.search_docs` — https://developers.stellar.org/docs/build/apps/application-design-considerations#custody-models ; #account-creation-strategies ; confidence: high (docs), medium (that this is the practical fallback — inference).

### (e) SEP-30 recovery and embedded / custodial-key patterns

- **SEP-30 "Account Recovery: multi-party recovery of Stellar accounts"**: **Status: Draft, Version 0.8.1, Created 2019-12-20, Updated 2021-05-04** (Leigh McCulloch, Lindsay Lin). Model: wallet registers the account with ≥2 independent recovery-signer servers, identities = phone/email (auth via SEP-10 token or e.g. Firebase token), servers are added as account **signers** (classic G-account multisig); recovery = servers co-sign a tx that locks the lost device key and adds a new one. Official Wallet SDK implements it (TS, Kotlin, Flutter, Swift): account key + device key + recovery key, `recoverableWallet.signers`.
  Source: `scout.searchResearch` — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0030.md ; `stellarDocs.get_doc_page_sections` — https://developers.stellar.org/docs/build/apps/wallet/sep30 ; SDF blog 2020-08-27 https://stellar.org/blog/developers/sep-30-recoverysigner-user-friendly-key-management ; confidence: high.
- **Applicability to a passkey C-account**: SEP-30 is defined over classic account signers; nothing returned applies it to contract accounts. For smart wallets the equivalent is adding backup/guardian signers in the account contract (smart-account-kit/OZ policies & multiple signer types; SocketFi advertises "guardian emergency controls, passkey rotation, BLS-based recovery"). Confidence: medium (inference + repo self-description).
- **Recovery-signer server code**: stellar/recoverysigner-demo-client archived (2023-04-06); community sunshipinc/recoverysigner-firebase-auth active (2026-09-25, score 28). BP Ventures blog describes a SEP-30 2-of-3 wallet recovery with 60+ identity providers (undated, semantic row).
  Source: `scout.searchRepos` — https://github.com/stellar/recoverysigner-demo-client ; https://github.com/sunshipinc/recoverysigner-firebase-auth ; `lumenloop.search_content_semantic` — https://bpventures.us/blog/the-future-of-ui-key-management-for-blockchain-wallets-in-2024 ; confidence: medium.
- **Embedded-wallet / custodial-key patterns in the ecosystem (directory rows, self-described):**
  - **SDP Embedded Wallets** (SDF): invitation link → passkey → contract wallet deployed → SEP-45 → SEP-24 verification; first-party reference for "user never sees crypto". https://developers.stellar.org/docs/platforms/stellar-disbursement-platform/admin-guide/embedded-wallets — `stellarDocs.search_docs`; confidence: high.
  - **Privy** — "embedded wallets and multi-chain support — including Stellar Tier 2"; https://stellarlight.xyz/project/privy — `scout.searchProjects`; status Live; confidence: low-medium (directory claim, no activity date).
  - **Blux** (bluxcc/core) — connect kit for Stellar dApps with wallet, email, phone and OAuth auth; https://github.com/bluxcc/core (2026-10-01, score 77); https://stellarlight.xyz/project/blux (2026-10-07) — `scout.searchRepos`/`searchProjects`; confidence: medium.
  - **Chainless** — Google/Apple sign-in, MPC wallet via **Web3Auth**, Pix on/off-ramp (Brazil); https://stellarlight.xyz/project/chainless — `scout.searchProjects`; confidence: low-medium.
  - **Stellar Passport** — "single QR scan creates a passkey-backed embedded wallet"; https://stellarlight.xyz/project/stellar-passport (2026-09-12) — `scout.searchProjects`; confidence: medium.
  - **Albedo** (stellar-expert) — "delegated signer and keystore", web app + extension; https://github.com/stellar-expert/albedo (maintained, 2026-08-31, 71 stars) — `scout.searchRepos`; confidence: high (existence), license not visible.
  - **Freighter** (SDF) — extension + iOS/Android, non-custodial; https://github.com/stellar/freighter (2026-10-12, score 87); embedding is via `@stellar/freighter-api` / Wallet Standard, not an embedded-key SDK — `scout.searchRepos`, `stellarDocs.search_docs` (frontend guide); confidence: high.
  - **Stellar Wallets Kit** (Creit-Tech) — one TS API over all Stellar wallets (Freighter, xBull, Albedo, LOBSTR…), 2026-10-07, score 87; https://github.com/Creit-Tech/Stellar-Wallets-Kit — `scout.searchRepos`; confidence: high. smart-account-kit also exposes Freighter/LOBSTR adapters.
  - **Turnkey**: no Stellar directory entry returned (Wellspring row was adjacent, discarded). **Dynamic**: no hit. Confidence: n/a (absence in Scout directory only).
  - **Meridian Pay** (SDF, passkey smart wallet in production at Meridian 2025) — https://stellar.org/blog/ecosystem/building-meridian-pay-smart-wallet-on-stellar (2026-02-05) — `lumenloop.search_content_semantic`; confidence: medium.
- **Official custody framing**: four custody options — non-custodial, custodial, "mixture of both with the use of multisig", plus third-party wallet services; wallet basic functions = key storage, account creation, signing, queries.
  Source: `stellarDocs.search_docs` — https://developers.stellar.org/docs/build/apps/application-design-considerations#custody-models ; confidence: high.

### Implications for a passkey wallet that signs an installment lock and a deposit under the hood

- **Pick Smart Account Kit + OpenZeppelin Smart Account** as the default: it is the SDF-tutorial path, the only option whose account contract has published audits (2025-02-20, 2025-07-09 — with 460 days of unaudited drift, so pin an audited release), and its context rules/policies let the "installment lock" be expressed as an authorization rule (e.g. a policy signer that may only call the lock contract's pay function up to a limit) rather than custom contract code. passkey-kit remains viable if a flat signer set is enough, but it has no audit on record.
- **Fees must come from a relayer, not fee-bumps or sponsored reserves**: official docs state a C-account cannot sign an envelope, fee-bump alone does not cover it, and sponsored reserves do not cover contract rent. Plan a server-side relayer (OpenZeppelin Relayer self-hosted via Docker for production, or the managed Stellar Channels service; Launchtube is dead) that wraps the user's auth entries, pays inclusion + rent, and keeps the API key off the browser.
- **Budget a channel/fee G-account pool and signer policy on the relayer**: the relayer's G-accounts spend sequence numbers and XLM; combine with fee-bumps so the fee payer and sequence source differ, and run a channel pool for parallel installment submissions.
- **Anchor on/off-ramp with a C-address is possible only via SEP-45**: the Anchor Platform ships it (RPC mode + toml `WEB_AUTH_FOR_CONTRACTS_ENDPOINT`/`WEB_AUTH_CONTRACT_ID`), but the SEP is still Draft v0.1.1 and each anchor must enable it. Check the target anchor's `stellar.toml`; if absent, the fallback is an app-controlled G-account (custodial or 2-of-N multisig with the user's passkey wallet) that does SEP-10 + SEP-24 and forwards funds to the C-address — which then needs sponsored reserves for its own base reserve/trustline.
- **SEP-7/QR is for classic payments**: `web+stellar:pay` carries destination/amount/asset/memo for a G… account and is widely implemented in the Wallet SDK, but nothing shows Soroban invocation or C-address destinations. For "scan to pay an installment" generate an app deep link that triggers the passkey + relayer flow instead; use SEP-7 only if a classic G-address collector is in the design.
- **Recovery is a signer-management problem, not SEP-30**: SEP-30 (Draft since 2019, classic signers only) does not cover contract accounts. Design recovery as an extra signer on the smart account (second passkey, Ed25519 backup held by the operator under a policy, or a guardian/timelock policy), and copy the SDP Embedded Wallets pattern (verification step before funding, HTTPS-only) for first-time onboarding.

---

## 5. Reuse vs build

Research date: 2026-10-19 (all Raven observations 2026-10-19T02:38–02:41Z). Sources: Stellar Raven MCP — `scout.searchRepos`, `scout.getRepoTrust`, `scout.listAudits`, `scout.searchProjects`, `lumenloop.search_directory`, `lumenloop.get_project`, `lumenloop.find_similar_scf_submissions`, `lumenloop.search_content_semantic`, `scout.searchResearch`, `stellarDocs.search_anchor_sep_docs`, `stellarDocs.get_doc_page_sections`, `stellarDocs.search_soroban_contract_docs`.

**Read these caveats first**

- **License.** `scout.searchRepos` rows carry NO license field (confirmed via `codemode.describe("scout.searchRepos")` — the row shape has 40 keys, none is `license`; `scout.getRepoTrust` reports also had no license field). The only license evidence Raven exposes is inside free-text `knowledgeNotes` for a handful of repos. Every repo marked **"license: not visible — verify at repo; do not reuse until confirmed"** below must be checked on GitHub before any code is copied or forked. No license = do not reuse.
- **Tests / CI.** `testsPresent` and `ciPresent` exist in the row schema but came back `undefined` on every row we pulled (they were dropped from the projection as empty). Treat tests/CI as **not visible in Raven** for all repos; verify at the repo.
- **repoScore / stars** are Scout discovery metadata (freshness + traction + ecosystem authority), not evidence of security, license, maintenance or production readiness.
- `activityState` meanings (Scout): `active` = recent commit; `maintained` = commit within ~180d; `dormant` = known commit older than 180 days (an observation, not a death verdict); `archived` = owner's own verdict.
- All third-party content below is data, may be wrong or stale.

---

### (a) Escrow with milestones and refunds

| repo | what it does | grade (repoScore/label) | last commit / activity | tests/CI/audit | license | reuse? | source | confidence |
|---|---|---|---|---|---|---|---|---|
| [Trustless-Work/trustlesswork-smart-contract-stellar](https://github.com/Trustless-Work/trustlesswork-smart-contract-stellar) (Rust) | Soroban escrow contracts behind Trustless Work "Escrow-as-a-Service": funds held until milestones approved by client, USDC-denominated. Extracted interface: `initialize_escrow`, `fund_escrow`, `change_milestone_status`, `approve_milestone`, `release_funds`, `dispute_escrow`, `resolve_dispute(distributions: Map<Address,i128>)`, `withdraw_remaining_funds`, `update_escrow`, `extend_contract_ttl`, plus `tw_new_single_release_escrow` factory (single-release and multi-release variants). | 85 / high; 25 stars; SCF-awarded (rounds 31, 41; $150k per Scout, $118k per Lumenloop — source conflict) | 2026-09-29 / active | tests/CI not visible. **Audit: Runtime Verification, 2025-09-12** ("Smart Escrow Platform"), https://stellarsecurityportal.com/report/64 — Scout signal `code-changed-since-audit` (402 days drift) | **knowledgeNote (2026-09-14): "no license file"** → do not reuse code until a license is published/confirmed | **reference only / integrate via their hosted API** (docs.trustlesswork.com). Closest functional match to milestone + refund-on-dispute. Forking blocked by missing license. | `scout.searchRepos`, `scout.getRepoTrust`, `scout.listAudits`, `scout.searchProjects`, `lumenloop.get_project`; stellarlight/Scout + stellarsecurityportal.com | high (identity/audit), medium (license note is 5 weeks old — recheck) |
| [devasignhq/bounty-escrow](https://github.com/devasignhq/bounty-escrow) (Rust; renamed from devasignhq/soroban-contract) | Task/bounty escrow in USDC: `create_escrow(task_id, issue_url, bounty_amount)`, `assign_contributor`, `approve_completion`, `release`, `refund`, `dispute_task`, `resolve_dispute`, `admin_release/admin_refund/admin_settle(contributor_amount)`, `set_paused`. Single-task, single payout (no milestones), explicit refund + partial settle paths. | 78 / high; 4 stars; SCF-awarded (project devasign); release v1.0.0 2026-06-05 | 2026-08-01 / maintained | tests/CI not visible; no audit on record | **not visible — verify at repo; do not reuse until confirmed** (README has a license badge per knowledgeNote, so one probably exists — confirm) | **fork candidate** for a simple fund → approve → release/refund/partial-settle flow; would need a milestone array added. | `scout.searchRepos`, `scout.getRepoTrust` | medium |
| [laugh-tales/soroban-escrow](https://github.com/laugh-tales/soroban-escrow) (Rust) | "Lock funds, set conditions, release payments" generic Soroban escrow. | 45 / medium; 0 stars | 2026-07-30 / maintained | not visible; no audit | not visible — verify; do not reuse until confirmed | reference only | `scout.searchRepos` | low |
| [Kings9595/WaveMilestone](https://github.com/Kings9595/WaveMilestone) (Rust) | Lock an asset budget per GitHub milestone; automated release on milestone close. | 40 / medium; 1 star | 2026-06-30 / maintained | not visible; no audit | not visible — verify; do not reuse until confirmed | reference only (pattern: milestone → release trigger) | `scout.searchRepos` | low |
| [MillestoneX/MilestoneX-Contracts](https://github.com/MillestoneX/MilestoneX-Contracts) (Rust) | Milestone-based crowdfunding + multi-asset donation contracts. | 40 / medium; 0 stars | 2026-07-28 / maintained | not visible; no audit | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [Goldii-locks/escrow-backend](https://github.com/Goldii-locks/escrow-backend) (TypeScript) | Node/Express/TS backend for a Soroban milestone escrow (off-chain side). | 43 / medium; 5 stars | 2026-09-29 / active | not visible; no audit | not visible — verify; do not reuse | reference only (backend shape) | `scout.searchRepos` | low |
| [Secureflow-protocol/secureflow](https://github.com/Secureflow-protocol/secureflow) (TypeScript) | Freelancer escrow: milestone payments, multi-arbiter dispute resolution. | 36 / low; 0 stars | 2026-06-21 / maintained | not visible; no audit | not visible — verify; do not reuse | no (below threshold) | `scout.searchRepos` | low |
| [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) (Rust) | Not an escrow. Library crates (`stellar-tokens`, `stellar-access`, `stellar-accounts`, `stellar-contract-utils`, `stellar-fee-abstraction`, `stellar-governance`, `stellar-macros`, all 0.7.2 on crates.io 2026-06-09): fungible/NFT tokens, access control, pausable, upgradeable, `TimelockController`, fee forwarder. README warns "experimental software… as is". soroban-sdk 27.0.2 at HEAD. | 69 / medium; 97 stars | 2026-10-12 / active | tests/CI not visible (crates published). **Audits: OpenZeppelin 2025-07-09 (v0.3.0-rc.2)** https://stellarsecurityportal.com/report/35 and 2025-02-20 (0.1.0) https://stellarsecurityportal.com/report/2; `code-changed-since-audit` (466 days) | **not visible in Raven — verify at repo** (OZ libraries are normally MIT, but confirm the LICENSE file before depending) | **as-is dependency** (crates) for access control / pausable / upgradeable / token building blocks inside our own escrow — not an escrow itself | `scout.searchRepos`, `scout.getRepoTrust`, `scout.listAudits` | high (identity/audit), medium (license) |
| SRust escrow (ScaffoldRust) | Only [ScaffoldRust/SRust-Marketplace](https://github.com/ScaffoldRust/SRust-Marketplace) (35/low, dormant 2025-08-21, TS) and SRust-Basic-Stellar-nextjs-yarn (19/low, dormant) surfaced; no dedicated SRust escrow contract indexed. | 35 / low | 2025-08-21 / dormant | not visible | not visible — do not reuse | **no** | `scout.searchRepos` q="srust escrow" | medium (closed-world on Scout index only) |

Other escrow rows seen but below the bar (score < 40 or dormant, all license-not-visible): StellarCheckMate/Checkmate-Escrow (46, chess wagers), Cylo-Traders/Agrocylo-Global (47, TS agri P2P), ognla-payeasy/payeasy (51, TS rent split), Grainlify/Stellar-Contracts (51, Merkle pull-claims escrow), Padi-Pay/padipay-contract (49), fanilabs/fanilab-smartcontract (42, logistics escrow), Shelterflex/shelterflex-contracts (42, escrow + rent payments), TrusTrove/TrusTrove-contract (58, trade finance), lumenbro/escrow-satellite (46, ZK escrow, dormant, "no license file").

SCF context (`lumenloop.find_similar_scf_submissions`, semantic — candidates only): "Escrow Infrastructure & Indexer" (SCF #41, Build), "Insurance Embedded Escrow for B2B Trade" (SCF #45, kutana), "After Activation, lets Build Eascrow!" (SCF #32), "Prepaid Accounts & Billing for Stellar" (SCF #45). Scout audit registry search q="escrow" returns exactly one audit: Trustless Work.

---

### (b) Scheduled / recurring / streamed payments and vesting

| repo | what it does | grade | last commit / activity | tests/CI/audit | license | reuse? | source | confidence |
|---|---|---|---|---|---|---|---|---|
| [LabsCrypt/flowfi](https://github.com/LabsCrypt/flowfi) (TS repo, Rust contract inside) | Payment streaming + recurring subscriptions. Extracted `StreamContract` interface: `create_stream(sender, recipient, token, amount, duration)`, `batch_create_streams`, `create_stream_with_cliff`, `create_step_vesting_stream(steps: Vec<VestingStep>)`, `create_hybrid_cliff_stream`, **`create_conditional_stream(milestones: Vec<ConditionalMilestone>)` + `verify_and_unlock_milestone`**, `top_up_stream`, `withdraw`, `transfer_recipient`, protocol fee config, emergency pause/guardian. | 53 / medium; 18 stars | 2026-10-18 / active | not visible; no audit | **not visible — verify; do not reuse until confirmed** | **fork candidate / strong reference** — step-vesting + milestone-conditioned streams is almost exactly an "installment schedule with milestone gates". | `scout.searchRepos`, `scout.getRepoTrust` | medium |
| [SoroStream/sorostream-contracts](https://github.com/SoroStream/sorostream-contracts) (Rust) | Payment-streaming protocol with role model (`initialize_roles`, fee manager, emergency pause, analytics, token admin roles). Stream functions beyond the first 25 interface entries not captured. | 47 / medium; 5 stars | 2026-10-03 / active | not visible; no audit | not visible — verify; do not reuse | reference only (role/pausable pattern) | `scout.searchRepos`, `scout.getRepoTrust` | low-medium |
| [conduit-protocol/streamFi-contracts](https://github.com/conduit-protocol/streamFi-contracts) (Rust) + streamFi-sdk (TS) + streamFi-app | Conduit streaming payments protocol: contracts, TS SDK, Next.js app. | 42 / medium (contracts); 30 (sdk); 32 (app) | 2026-10-01 / active | not visible; no audit | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [vestflow-labs/vestflow](https://github.com/vestflow-labs/vestflow) (TS) | Linear & cliff token vesting, revocable schedules. | 44 / medium; 1 star | 2026-09-28 / active | not visible (no deep-code scan); no audit | not visible — verify; do not reuse | reference only | `scout.searchRepos`, `scout.getRepoTrust` | low |
| [AlienScroll78/vesting-cliff-drip-stream](https://github.com/AlienScroll78/vesting-cliff-drip-stream) (TS) | Cliff + linear drip streaming Soroban contract. | 49 / medium; 1 star | 2026-10-04 / active | not visible; no audit | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [luanlabs/fluxity-v1-core](https://github.com/luanlabs/fluxity-v1-core) (Rust) / [luanlabs/fluxity-interface](https://github.com/luanlabs/fluxity-interface) (TS) | Fluxity token streaming (SCF-awarded). Core contract dormant since 2025-01-14; interface active (79/high). Trust scan extracted no interface for core. | core 52 / medium; interface 79 / high; SCF | core 2025-01-14 dormant; UI 2026-10-11 active | not visible; no audit | not visible — verify; do not reuse | reference only (dormant core) | `scout.searchRepos`, `scout.getRepoTrust` | medium |
| [rahimklaber/SStream](https://github.com/rahimklaber/SStream) (Rust) | Early Soroban streaming protocol (SCF): create stream with recipient, amount/sec, total, end. | 38 / low; 3 stars; SCF | 2024-07-24 / dormant | not visible | not visible — do not reuse | no (dormant, pre-SDK-21) | `scout.searchRepos` | medium |
| [Stellopay/stellopay-core](https://github.com/Stellopay/stellopay-core) (Rust) | Decentralized payroll on Soroban. | 48 / medium; 7 stars | 2026-10-01 / active | not visible; no audit | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [zkpayroll/zk-payroll-contracts](https://github.com/zkpayroll/zk-payroll-contracts) (Rust) + sdk + dashboard | ZK payroll (private salaries). Over-engineered for our need. | 45 / medium; 8 stars | 2026-10-04 / active | not visible | not visible — verify; do not reuse | no | `scout.searchRepos` | low |
| [vowena/sdk](https://github.com/vowena/sdk) (TS) | TS SDK for Vowena subscription billing protocol. | 63 / medium; 1 star | 2026-04-22 / maintained | not visible | not visible — verify; do not reuse | reference only (recurring billing API shape) | `scout.searchRepos` | low |
| [payrouteshq/stellartools](https://github.com/payrouteshq/stellartools) (TS) | "OSS payment infrastructure built on Stellar" (stellartools.dev), SCF-awarded; recurring-payments hit. | 69 / medium; 11 stars; SCF | 2026-09-24 / active | not visible | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low-medium |
| [Dobprotocol/stellar-distribution-contracts](https://github.com/Dobprotocol/stellar-distribution-contracts) (Rust) | Participation token + project whitelist/approval registry; distribution contracts. README claims "Audited – Safe for Production" but knowledgeNote: audits are **internal review only** (docs/SECURITY_REVIEW*.md, Jan 2026), no third-party auditor. | 52 / medium; 1 star; SCF | 2026-08-07 / maintained | not visible; **no third-party audit** | not visible — verify; do not reuse | reference only; do not cite as audited | `scout.searchRepos`, `scout.getRepoTrust` | medium |
| TokenOps vesting (audit only) | `scout.listAudits` q="vesting" returns "Token Vesting Factory and Token Vesting Manager — Runtime Verification (TokenOps)", published 2025-03-24, https://stellarsecurityportal.com/report/30, projectSlug null. No matching repo indexed in Scout (q="tokenops vesting" returned only unrelated low-score vesting repos). | n/a | n/a | audited (RV) | unknown — repo not located | reference (audit report readable for vesting design pitfalls) | `scout.listAudits`, `scout.searchRepos` | medium |
| Official docs: [Timelock example](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/timelock) in [stellar/soroban-examples](https://github.com/stellar/soroban-examples) | Simplified claimable-balance / time-lock contract (deposit, claim after/before time bound); fuzzing example builds on it. soroban-examples: 63/medium, 148 stars, active 2026-10-06, tags track SDK majors (v23.0.0 latest tag as of 2026-09-01). | 63 / medium | 2026-10-06 / active | official SDF examples; not audited | **not visible in Raven — verify at repo** (SDF examples are typically Apache-2.0; confirm) | **as-is starting point** for time-gated release logic | `stellarDocs.search_soroban_contract_docs`, `scout.searchRepos` | high (identity), medium (license) |

---

### (c) RWA / real-estate tokenization on Stellar

| repo | what it does | grade | last commit / activity | tests/CI/audit | license | reuse? | source | confidence |
|---|---|---|---|---|---|---|---|---|
| [SimplyTokenized/soroban-smart-contracts](https://github.com/SimplyTokenized/soroban-smart-contracts) (Rust) | RWA tokenization contracts. Extracted `PayoutContract`: snapshot-based investor distributions — `create_distribution(snapshot_ledger, payout_token)`, `set_investor_balances`, `take_onchain_snapshot`, `fund_payout_token`, `compute_payout_amounts`, `set_manual_payout_amounts`, `claim_payout`, `batch_distribute_automatic`, `batch_mark_payout_as_paid`, `withdraw_unclaimed`, whitelist flag. | 64 / medium; 0 stars | 2026-09-02 / maintained | not visible; no audit | not visible — verify; do not reuse until confirmed | **reference / fork candidate** for investor payout distribution (dividend/rent payout to token holders) | `scout.searchRepos`, `scout.getRepoTrust` | medium |
| [RWA-ToolKit/stellar-rwa-contracts](https://github.com/RWA-ToolKit/stellar-rwa-contracts) (Rust) | Soroban contracts for tokenizing RWAs with built-in compliance. | 45 / medium; 2 stars | 2026-10-02 / active | not visible; no audit | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [akkuea/akkuea](https://github.com/akkuea/akkuea) (TS) | "Real Estate (RWA) + DeFi" platform. | 57 / medium; 47 stars | 2026-10-02 / active | not visible; no audit | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [Shamba-Records-Limited/microvault](https://github.com/Shamba-Records-Limited/microvault) (Go) | Headless **SEP-0056 tokenized-vault** engine for microlending; testnet vault + governance contracts published; v1.1.2 (2026-08-31). SCF-awarded. | 92 / high; 1 star; SCF | 2026-10-09 / active | not visible; no audit | not visible — verify; do not reuse | reference only (SEP-56 vault pattern, not real estate) | `scout.searchRepos` | medium |
| [perspectivefi/spectra-core-stellar-public](https://github.com/perspectivefi/spectra-core-stellar-public) (Rust) | Yield-tokenization core (public clone); **Certora audit 2026-05-01** in repo. Not real estate. | 54 / medium | 2026-08-10 / maintained | audited (Certora) | not visible — verify; do not reuse | reference only (audited token-vault code quality) | `scout.searchRepos` | medium |
| [script3/sep-41-token](https://github.com/script3/sep-41-token) (Rust) | SEP-41 trait, client and mock contract; crates.io `sep-41-token` 1.4.0 (2026-01-26). | 37 / low; 1 star | 2026-01-26 / dormant | not visible | not visible — verify; do not reuse until confirmed | **as-is dependency candidate** (small, stable trait crate) if license confirmed; OZ `stellar-tokens` is the better-maintained alternative | `scout.searchRepos`, `scout.getRepoTrust` | medium |
| OpenZeppelin/stellar-contracts `stellar-tokens` crate | Fungible (SEP-41-compatible) and NFT implementations, allowlist/blocklist, capped, burnable, pausable; `ExampleContract` (mint/pause) in interface; also `ConfidentialFactoryContract`, `SacAdminExampleContract`. See (a) row for grade/audit. | 69 / medium | 2026-10-12 / active | audited (OZ, 2025-07-09; drift) | not visible — verify | **as-is dependency** for any SEP-41 property token | `scout.getRepoTrust` | high |
| Shelterflex ([shelterflex-contracts](https://github.com/Shelterflex/shelterflex-contracts) Rust 42; [shelterflex-api](https://github.com/Shelterflex/shelterflex-api) TS 39) | Escrow + staking + **rent payments** contracts; API handles "deals, installments, risk, Soroban RPC". | 42 / 39 | 2026-09-20 / 2026-09-19 active | not visible | not visible — verify; do not reuse | reference only (installments vocabulary in a property context) | `scout.searchRepos` | low |
| [LeaseFlow-Protocol/LeaseFlow-Protocol-Contracts](https://github.com/LeaseFlow-Protocol/LeaseFlow-Protocol-Contracts) (Rust) | Real-time asset leasing contracts. | 40 / medium | 2026-06-10 / maintained | not visible | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [Kevin737866/stellar-asset-tokenization-suite](https://github.com/Kevin737866/stellar-asset-tokenization-suite) (TS) | End-to-end RWA tokenization incl. real estate. | 30 / low | 2026-10-16 / active | not visible | not visible — do not reuse | no (low grade) | `scout.searchRepos` | low |

RWA real-estate **projects** in Scout (`scout.searchProjects` type=RWA q="real estate", 101 total): Lend (SCF $213,460, Live, no repo), Liqvid (SCF $235k, repo Asterizm-Protocol/asterizm-contracts-stellar), Minah (SCF $97.5k, repo gakpe/minah_blockchain_v0.2, last 2025-11-18), Nauta Land ($122,867), Tauvlo ($145k), Verseprop ($112,020; repos The-Brookes-Project/soroban-sc, real-estate-sc, SmartContract; last 2026-01-06), BWB ($150k, Development, repo BWB-Labs/bwb-stellar, last 2026-10-01), UrbanFlip ($120k), RedSwan (FINRA-regulated, no repo), Benji (Franklin Templeton). None of these project repos surfaced in the graded repo search at score ≥ 40, so they are "look at, don't fork" references. Confidence: medium.

---

### (d) Stellar Disbursement Platform (SDP)

| repo | what it does | grade | last commit / activity | tests/CI/audit | license | reuse? | source | confidence |
|---|---|---|---|---|---|---|---|---|
| [stellar/stellar-disbursement-platform-backend](https://github.com/stellar/stellar-disbursement-platform-backend) (Go) | Official SDF tool "for organizations to make bulk payments to a group of recipients over the Stellar network" (docs intro). Three services: **Dashboard**, **SDP Core Service** (Dashboard API, Admin API for multi-tenant provisioning, Messaging Service that SMS/emails recipients, Wallet Registration web app that registers a recipient by collecting + verifying OTP and identity via **SEP-24 hosted deposit**), plus a Transaction Submission Service (TSS) and an embedded Anchor Platform. Disbursements are uploaded as CSV (phone/email + amount); receivers claim via a wallet that has allowlisted the SDP domain and supports the registration deep link `https://<host>?asset=&domain=&name=&signature=` and deferred deep linking. Release line 7.x since 7.0.0 (2026-08-19); 6.6.1 (2026-06-24), 6.5.0 (2026-05-05). Docker Hub image ~34.6k pulls. Scan extracted only a passkey `AccountContract` (smart-wallet account) as on-chain code. | 76 / high; 62 stars | 2026-10-05 / active | tests/CI not visible in Raven (SDF repo; CI likely — verify). No security audit in Scout registry. | **not visible in Raven — verify at repo.** Docs call it "open-source" (developers.stellar.org/docs/platforms: "SDF has open-sourced some platforms"); 2023 SDF blog "Explore the open-source solution for bulk payments" — license identifier itself not surfaced. Do not reuse until confirmed. | **reference / run-as-a-service only.** Mature (v7, active, official), but built for one-to-many bulk payouts with phone/email receiver registration, not a 1-recipient contract-governed schedule. | `scout.searchRepos`, `scout.getRepoTrust`, `stellarDocs.get_doc_page_sections` (/docs/platforms/stellar-disbursement-platform, …/making-your-wallet-sdp-ready), `stellarDocs.search_anchor_sep_docs`, `lumenloop.search_content_semantic` | high (what it does, maturity); medium (license) |
| [stellar/stellar-disbursement-platform-frontend](https://github.com/stellar/stellar-disbursement-platform-frontend) (TS) | Companion dashboard UI; versions track backend (7.0.0 2026-08-19). Docker image ~16.2k pulls. | 68 / medium; 31 stars | 2026-10-12 / active | not visible; no audit | not visible — verify | reference only | `scout.searchRepos` | high / medium |
| Forks: marwen-abid/stellar-disbursement-platform-backend (61), stellar-experimental/meridian-pay-sdp-backend (50) / -frontend (19, dormant) | Unchanged-README forks; nothing documents divergence. | ≤61 | 2026-05 / 2026-08 | n/a | n/a | no | `scout.searchRepos` | high |

**Does any SDP part fit "installment payouts to one builder"?**
- Fit is **poor as a whole**: SDP's value is CSV bulk disbursement + receiver onboarding (SMS/OTP, wallet deep link, SEP-24 registration) + multi-tenant admin. For one known builder wallet, the registration flow is overhead and there is no on-chain schedule/milestone gating — timing lives in the operator's dashboard.
- **Reusable ideas / parts:** (1) its **Transaction Submission Service** pattern (channel accounts, retries, idempotent payment submission) is the right design for an off-chain scheduler firing each installment; (2) the "Create Disbursement" / "Download Disbursement Instructions" API shape (docs api-reference, 2026-08-31) is a sensible model for an installment-batch admin API; (3) its **SEP-24-based receiver verification** is only useful if the builder must be onboarded through a third-party wallet.
- Verdict: **reference architecture only; do not fork.** If the client wants an operator-driven (not contract-driven) schedule, running stock SDP with one receiver and N dated disbursements is possible but heavyweight. Confidence: medium-high.

---

### (e) Anchor Platform and sending-anchor / SEP-31 client references

| repo | what it does | grade | last commit / activity | tests/CI/audit | license | reuse? | source | confidence |
|---|---|---|---|---|---|---|---|---|
| [stellar/anchor-platform](https://github.com/stellar/anchor-platform) (Kotlin/Java; formerly java-stellar-anchor-sdk) | Official anchor server. Supported SEPs per docs: SEP-1, 6, 10, 12, 24, **SEP-31 "Cross-border payment processing (receive only)"**, 38, 45. Releases every 1–3 weeks: 4.7.1 (2026-08-26), 4.7.0, 4.6.2, 4.6.1. Docker Hub `stellar/anchor-platform`. | 94 / high; 60 stars | 2026-10-09 / active | not visible; no audit in registry | **not visible in Raven — verify at repo** | **as-is (run), only if we are the RECEIVING anchor.** It does not implement the sending side of SEP-31. | `scout.searchRepos`, `scout.getRepoTrust`, `stellarDocs.search_anchor_sep_docs` (…/anchor-platform#supported-seps, …/sep31/getting-started) | high |
| SEP-31 sending-anchor reference | `stellar-deprecated/sep31-demo-client` — **archived 2023-11-07**, README: "now Deprecated… integrated into stellar/stellar-demo-wallet". Docs describe sending-anchor behaviour only from the receiver's side (pending_receiver, funds received, refund sent, transaction recovery). **No maintained open-source sending-anchor server surfaced.** | 10 / low | 2021-06-28 / archived | n/a | n/a | **no** (archived); build sending-side client on stellar-sdk + wallet-sdk | `scout.searchRepos` q="SEP-31 sending anchor", `stellarDocs.search_anchor_sep_docs` | high (closed-world on Scout index) |
| [stellar/stellar-demo-wallet](https://github.com/stellar/stellar-demo-wallet) (TS) | SDF front end to interactively test SEP interoperability (SEP-6/24/31 client flows incl. the absorbed SEP-31 demo client); hosted demo-wallet.stellar.org; defaults testnet, mainnet via env; latest release v3.0.0. | 65 / medium; 67 stars | 2026-09-09 / active | not visible; no audit | not visible — verify | **reference only** for SEP-31 sender-side client sequence (SEP-10 auth → SEP-12 KYC → POST /transactions → payment) | `scout.searchRepos`, `scout.getRepoTrust` | high |
| [stellar/typescript-wallet-sdk](https://github.com/stellar/typescript-wallet-sdk) (TS) | Official wallet SDK: `@stellar/typescript-wallet-sdk`, `-km`, `-soroban` all 4.0.1 (2026-08-21); v4.0.0 breaking (stellar-sdk 16.2.0, Node ≥22); <4.0.0 deprecated on npm. Implements SEP-10/12/24/38 client flows (SEP-24 deposit per docs "Build a Wallet" series). | 86 / high; 34 stars | 2026-10-07 / active | not visible | not visible — verify (SDF SDKs normally Apache-2.0; confirm) | **as-is dependency** for any anchor-client code we write | `scout.searchRepos` | high / medium (license) |
| [stellar/stellar-anchor-tests](https://github.com/stellar/stellar-anchor-tests) (TS) | Library + CLI for testing anchors; npm `@stellar/anchor-tests` 0.6.22 (2026-06-05). Hosted UI anchor-tests.stellar.org did not resolve on 2026-09-01. | 63 / medium; 17 stars | 2026-09-03 / maintained | not visible | not visible — verify | as-is tool (test any anchor we integrate) | `scout.searchRepos` | high |
| [stellar/django-polaris](https://github.com/stellar/django-polaris) (Python) | SDF's extendable Django anchor app — **ARCHIVED 2025-05-23**; PyPI frozen at 2.6.0 (2025-02-13). | 29 / low; 97 stars | 2025-02-13 / archived | n/a | not visible | **no** | `scout.searchRepos` | high |
| [stellar/sep24-reference-ui](https://github.com/stellar/sep24-reference-ui) (TS) | SDF SEP-24 interactive flow reference UI. | 36 / low; 6 stars | 2026-10-05 / active | not visible | **Apache-2.0** (knowledgeNote 2026-09-14) | reference only | `scout.searchRepos` | high |
| [Argo-Navis-Dev/php-anchor-sdk](https://github.com/Argo-Navis-Dev/php-anchor-sdk) (PHP) | PHP anchor SDK (SCF); Packagist 0.10.0 (2025-11-09). | 55 / medium; SCF | 2026-03-29 / dormant | not visible | **Apache-2.0** (knowledgeNote) | no (PHP, dormant) | `scout.searchRepos` | high |
| [0xNgoo/anchor-kit](https://github.com/0xNgoo/anchor-kit) (TS) | "Developer-friendly SDK for implementing Stellar anchor services". | 50 / medium; 19 stars | 2026-09-30 / active | not visible | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [ACTA-Team/brazil-regional-kit](https://github.com/ACTA-Team/brazil-regional-kit) (TS) | Fiat on/off-ramps for Brazil/LATAM: PIX ramps, multi-anchor quote router (SCF). | 47 / medium; SCF | 2026-08-05 / maintained | not visible | not visible — verify; do not reuse | reference only (multi-anchor quote routing) | `scout.searchRepos` | low |

---

### (f) Open-source Soroban "payment plan" / "installment" / "BNPL" / "mortgage"

| repo | what it does | grade | last commit / activity | tests/CI/audit | license | reuse? | source | confidence |
|---|---|---|---|---|---|---|---|---|
| [lumenlater/lumen-later](https://github.com/lumenlater/lumen-later) (TS repo, Rust contracts) | "LumenLater BNPL Protocol — decentralized Buy-Now-Pay-Later on Soroban" (README 2026-09-07). Extracted `LpToken` interface: `deposit/withdraw`, `borrow/repay`, `repay_with_burn(fee)`, `set_bnpl_core`, `get_locked_balance`, `utilization_ratio`, `exchange_rate` — a lender-pool side; BNPL core/installment schedule not in captured interface. SCF-awarded. | 49 / medium; 1 star; SCF | 2026-02-13 / dormant | not visible; no audit | **not visible — verify; do not reuse until confirmed** | reference only (dormant; pool-side only) | `scout.searchRepos` q="BNPL buy now pay later", `scout.getRepoTrust` | medium |
| [AstronLabs/remitMortage](https://github.com/AstronLabs/remitMortage) (TS) | "Remittance-backed mortgage protocol on Stellar" for diaspora communities. | 31 / low; 1 star | 2026-10-03 / active | not visible | not visible — do not reuse | no (low grade); only 2 repos in index match "mortgage" | `scout.searchRepos` q="mortgage" | medium (closed-world: 2 hits) |
| [sumisu-max/mortgage](https://github.com/sumisu-max/mortgage) (TS) | No description. | 20 / low | 2025-10-18 / dormant | not visible | not visible | no | `scout.searchRepos` | high (irrelevant) |
| [Shelterflex/shelterflex-api](https://github.com/Shelterflex/shelterflex-api) (TS) | Back-end API with "deals, installments, risk, Soroban RPC". | 39 / low | 2026-09-19 / active | not visible | not visible — do not reuse | reference only | `scout.searchRepos` | low |
| [XOXNO/rs-lending-xlm](https://github.com/XOXNO/rs-lending-xlm) (Rust) | Over-collateralized money market (SCF). Surfaced on "installment" search; not a payment plan. | 63 / medium; SCF | 2026-10-10 / active | not visible | **PolyForm Noncommercial 1.0.0** — "Commercial use requires a written agreement" (knowledgeNote) → **not reusable commercially** | no | `scout.searchRepos` | high |
| [escala-dev/collective-investment-contracts](https://github.com/escala-dev/collective-investment-contracts) (Rust) | Collective investment contracts (SCF). | 53 / medium; SCF | 2026-09-29 / active | not visible | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [stellar-sharpy/sharpy-contracts](https://github.com/stellar-sharpy/sharpy-contracts) (Rust) | Split payments: recurring invoices + escrow. | 45 / medium | 2026-09-15 / active | not visible | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| [Stellar-split/split-contracts](https://github.com/Stellar-split/split-contracts) (Rust) | On-chain invoice & payment splitting. | 48 / medium; 2 stars | 2026-10-07 / active | not visible | not visible — verify; do not reuse | reference only | `scout.searchRepos` | low |
| LabsCrypt/flowfi `create_step_vesting_stream` / `create_conditional_stream` | See (b). The closest thing in the index to an on-chain installment plan with milestone gates. | 53 / medium | 2026-10-18 / active | not visible | not visible — verify | fork candidate | `scout.getRepoTrust` | medium |

**Conclusion for (f):** No graded (≥40), licensed, maintained, purpose-built "installment / payment-plan" Soroban contract exists in the Scout index as of 2026-10-19. "installment payment plan" (584 partial matches) and "scheduled payments time-locked release" (520) returned only adjacent projects (streams, dead-man switches, agent treasuries). **Build**, composing: OZ `stellar-contracts` (access/pausable/upgradeable + SEP-41 token), the official timelock example pattern, and the escrow/milestone semantics from Trustless Work (as design reference) and devasign bounty-escrow (fork if licensed).

---

### Shortlist (≤6 repos we would actually reuse or fork, with why and license)

| # | repo | mode | why | license status |
|---|---|---|---|---|
| 1 | OpenZeppelin/stellar-contracts (crates `stellar-access`, `stellar-contract-utils`, `stellar-tokens`, `stellar-macros` 0.7.2) | **as-is dependency** | Only audited (OZ 2025-07-09, with drift) building-block library on Soroban; active (2026-10-12); gives us ownable/role access control, pausable, upgradeable, TimelockController, SEP-41 fungible/NFT — exactly the primitives an installment-escrow + property-token needs. README: "experimental… as is". | not visible in Raven — **verify LICENSE file** (expected MIT) before adding to Cargo.toml |
| 2 | stellar/typescript-wallet-sdk 4.0.1 | **as-is dependency** | Official, active (2026-10-07), SEP-10/12/24/38 client flows for any anchor on/off-ramp leg; pre-4.0 deprecated so pin ≥4.0.1, Node ≥22. | not visible — **verify** (expected Apache-2.0) |
| 3 | stellar/soroban-examples — `timelock` example | **as-is starting point** | Official, minimal time-bound claimable-balance contract; ideal seed for "installment N claimable after date D"; has companion fuzzing example. | not visible — **verify** (expected Apache-2.0) |
| 4 | devasignhq/bounty-escrow (Rust, 78/high, SCF) | **fork (if licensed)** | Clean single-escrow lifecycle with explicit `refund`, `release`, `admin_settle(partial)` and dispute path; USDC-SAC wired; v1.0.0 released. Needs milestone/installment array added. | not visible — README shows a license badge per Scout note; **confirm file**. No audit. |
| 5 | LabsCrypt/flowfi contract (53/medium, active 2026-10-18) | **fork / design reference** | `create_step_vesting_stream(Vec<VestingStep>)` + `create_conditional_stream(Vec<ConditionalMilestone>)` + `verify_and_unlock_milestone` is the nearest existing model of a milestone-gated installment schedule; batch creation, top-up, recipient transfer, emergency pause. | not visible — **verify**; unaudited; small team (18 stars) |
| 6 | Trustless-Work/trustlesswork-smart-contract-stellar (85/high, SCF, RV-audited 2025-09) | **reference only / integrate via hosted API** | Best-graded, audited milestone escrow on Stellar; interface (`approve_milestone`, `release_funds`, `resolve_dispute(distributions)`) is the design we should mirror. Scout note (2026-09-14): **no license file** → cannot fork. Audit is 400+ days old with code changed since. | **no license file** (as of 2026-09-14) — do not copy code; recheck repo |

Explicitly **not** shortlisted: SDP (reference architecture only; bulk/receiver-onboarding oriented), Anchor Platform (receive-only SEP-31; run only if we become a receiving anchor), django-polaris and sep31-demo-client (archived), XOXNO/rs-lending-xlm (PolyForm Noncommercial), lumen-later (dormant), Dobprotocol distribution contracts (self-"audited" only).

---

---

## 6. Compliance tooling

Research date: 2026-10-19 (Raven observedAt 02:38–02:42Z). Authority order: official developers.stellar.org pages and SEP/CAP text (highest) > stellar-dev / OpenZeppelin skills (tested playbooks) > Scout / Lumenloop (community-aggregated; labelled). Scout `searchResearch` returns verbatim chunks of SEP/CAP/docs text via vector ranking, so chunk *content* is official wording but *coverage* is not exhaustive — absence of a chunk is never evidence of absence in the spec.

### (a) SEP-8 Regulated Assets

**Status and version.** SEP-0008 "Regulated Assets" — `Status: Active`, `Version 1.7.4`, Created 2018-08-22, Updated 2022-02-21. Authors: Tomer Weller, Howard Chen, Christian Peters (DSTOQ), Leigh McCulloch.
Source: scout.searchResearch (source=sep) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md ; date/version: v1.7.4, 2022-02-21; confidence: high (verbatim preamble chunk).

**Definition.** "Regulated Assets are assets that require an issuer's approval (or a delegated third party's approval, such as a licensed securities exchange) on a per-transaction basis. It standardizes the identification of such assets as well as defines the protocol for performing compliance checks and requesting issuer approval."
Source: scout.searchResearch — sep-0008.md "Simple Summary"; v1.7.4 (2022-02-21); confidence: high.

**Prerequisite flags.** "Regulated asset issuers must have both `Authorization Required` and `Authorization Revocable` flags set on their account. This allows the issuer to grant and revoke authorization to transact the asset at will."
Source: scout.searchResearch — sep-0008.md "Authorization Flags"; v1.7.4; confidence: high.

**Discovery via stellar.toml.** In `[[CURRENCIES]]`: `regulated` (boolean, default false), `approval_server` (URL of a service that signs validated transactions), `approval_criteria` (human-readable requirements). Example: `regulated=true`, `approval_server="https://goat.io/tx_approve"`.
Source: scout.searchResearch — sep-0008.md "SEP-1 stellar.toml"; v1.7.4; confidence: high.

**How the approval server works.** "Approval server is a single endpoint that receives a signed transaction, checks for compliance, and signs it on success." It is an HTTP POST endpoint accepting a single `tx` parameter (`application/x-www-form-urlencoded` or `application/json`), responding `application/json`, with permissive CORS (`Access-Control-Allow-Origin: *`). Response `status` values, per the "Regulated Assets Transaction Flow":
- `success` — approved and signed by the issuer.
- `revised` — "Transaction has been revised to be made compliant, and signed by the issuer. Wallet will show the changes to the user and ask them to sign the new transaction. It is important to understand that an approval service could respond with a different transaction."
- `pending` — issuer could not decide now; response carries `timeout` (ms to wait before re-submitting; `0` if unknown) and optional `message`; wallet re-sends later.
- `action_required` — "the user must complete an action before this transaction can be approved. The approval service will provide a URL that facilitates the action. Upon completion, the user will resubmit the transaction."
- `rejected` — (listed in the flow; the chunk with the rejected-body schema was not returned, so field names for that response are unverified here).
Wallet flow: 1) wallet builds and signs tx; 2) detects the asset requires authorization by checking the issuer account's authorization flags; 3) detects it is regulated via stellar.toml approval server; 4) POSTs to approval server; 5) server decides; 6) wallet handles response as above.
Source: scout.searchResearch — sep-0008.md "Approval Server" and "Regulated Assets Transaction Flow"; v1.7.4; confidence: high for listed statuses, medium for `rejected` body shape.

**Underlying ledger mechanism (official docs).** The issuer "sandwiches" the user's operation between `SetTrustLineFlags` operations: Op1 fully authorize account A for asset X; Op2 fully authorize B; Op3 payment A→B; Op4 set B back to `AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG` (and similarly A). An account left in `AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG` "can own offers but cannot do anything else with the asset."
Source: stellarDocs.get_doc_page_sections / search_asset_token_docs — https://developers.stellar.org/docs/tokens/control-asset-access#example-flow ; page dated 2026-07-21 (per Scout research index publishedAt); confidence: high.

**Does SEP-8 apply to Soroban / SAC transfers?** Every SEP-8 chunk retrieved is framed around a classic *transaction envelope* the wallet signs and the approval server co-signs, with the enforcement primitive being `SetTrustLineFlags` on classic trustlines. No retrieved SEP-8 text mentions Soroban, `InvokeHostFunction`, contract addresses or the SAC; a meeting-notes search for "SEP-8 regulated assets Soroban" returned only unrelated confidential-token notes (2026-09-03). The Soroban-side equivalent of per-transaction authorization is the SAC admin's `set_authorized` (see (b)), and the newer draft SEP-61 "Trustline Onboarder" (2026-09-30) describes, for `AUTH_REQUIRED` assets, an "Authorizer contract … required, set as SAC admin" that performs "authorize-on-behalf (third party, no user/issuer signature)". Conclusion: SEP-8 as written targets classic payments; there is no official evidence it governs SAC `transfer` calls. Treat as inference.
Source: scout.searchResearch — sep-0008.md (all chunks) and sep-0061.md "Specification" (publishedAt 2026-09-30, Draft status implied by SEP number/date — status line not retrieved); stellarDocs.search_meeting_notes (no relevant hit); confidence: medium (absence-based).

**Real-world usage.** The SEP lists one reference implementation: "A reference implementation of the SEP-8 Approval Server for Go can be found in https://github.com/stellar/go/tree/master/services/regulated-assets-approval-server". Official docs: the Demo Wallet lets you "test Regulated Assets (SEP-8)". The docs' Assets Overview "Compliance" section points to SEP-8 for per-transaction approval. SEP-61 names EURCV as an example of a "Regulated (`AUTH_REQUIRED`)" asset. No project in Scout/Lumenloop was found advertising SEP-8 support (searches for "regulated asset allowlist travel rule" returned stablecoin rows with no SEP-8 field) — adoption breadth is unverified.
Sources: scout.searchResearch — sep-0008.md "Implementations" (v1.7.4); stellarDocs.search_docs — https://developers.stellar.org/docs/tools/developer-tools/anchor-tools#demo-wallet and https://developers.stellar.org/docs/tokens/anatomy-of-an-asset#compliance ; scout.searchResearch — sep-0061.md (2026-09-30, community-indexed SEP text); confidence: high for reference impl / demo wallet, low for ecosystem adoption.

### (b) Asset authorization flags and the Stellar Asset Contract

**Flag definitions (official, bit values as documented).** Flags are set on the *issuing account* with `set_options` and "can be set at any time in the life cycle of an asset".
- `AUTH_REQUIRED_FLAG` (0x1): "an issuer must approve an account before that account can hold its asset." User creates trustline; issuer approves with `Set_Trust_Line_Flag`. Two grant levels: `AUTHORIZED_FLAG` (full: payments, orders, liquidity-pool deposit) and `AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG` (maintain/cancel orders, withdraw from LP, nothing else).
- `AUTH_REVOCABLE_FLAG` (0x2): issuer "can revoke an existing trustline's authorization, thereby freezing the asset held by an account … prevents that account from transferring or trading the asset and cancels the account's open orders." Can also reduce full→limited (keeps offers). "Useful for issuers of regulated assets who need to authorize transactions on a case-by-case basis."
- `AUTH_IMMUTABLE_FLAG` (0x4): "none of the other authorization flags (AUTH_REQUIRED_FLAG, AUTH_REVOCABLE_FLAG) can be set, and the issuing account can't be merged" — a signal that the asset "will persist on the ledger in an open and accessible state." (Also surfaces as result code `ACCOUNT_MERGE_IMMUTABLE_SET`.)
- `AUTH_CLAWBACK_ENABLED_FLAG` (0x8): "any subsequent trustlines established with this account will have clawbacks enabled … Note that this flag requires that revocable is also set."
Source: stellarDocs.get_doc_page_sections — https://developers.stellar.org/docs/tokens/control-asset-access (anchors #authorization-required-0x1, #authorization-revocable-0x2, #authorization-immutable-0x4, #clawback-enabled-0x8); page dated 2026-07-21; confidence: high. Also https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations#account-merge (ACCOUNT_MERGE_IMMUTABLE_SET).

**Protocol rule (CAP-35).** Setting `AUTH_CLAWBACK_ENABLED_FLAG` without `AUTH_REVOCABLE_FLAG` fails with `SET_OPTIONS_AUTH_REVOCABLE_REQUIRED`; clearing revocable while clawback-enabled is set also fails. `AllowTrustOp` with `TRUSTLINE_CLAWBACK_ENABLED_FLAG` fails `ALLOW_TRUST_MALFORMED`.
Source: scout.searchResearch — https://github.com/stellar/stellar-protocol/blob/master/core/cap-0035.md "Specification" (publishedAt 2020-12-14); confidence: high (verbatim CAP text).

**Skill summary (concise table, with SDK constants `AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag`, `setTrustLineFlags({authorized:true})`, `Operation.clawback({asset, from, amount})`).**
Source: skills.stellar-dev.assets §asset-flags — https://raw.githubusercontent.com/stellar/stellar-dev-skill/e9ab7dbb662dc2efc9b0ebb4ed86c417d16dd29f/skills/assets/SKILL.md ; commit e9ab7db; confidence: high (consistent with docs).

**Do SAC `transfer` calls respect trustline authorization? Yes.**
- "When the SAC transfers assets between accounts, the same debit and credits occur as they do when a Stellar payment operation is used, because the SAC interacts directly with Stellar account trust lines. When the SAC transfers assets between contracts, it uses Contract Data ledger entries to store the balances for contracts."
- `Address::Account`: "The balance must exist in a trustline (or an account for the native balance)". After CAP-67 muxed addresses: "The trustline rules for Address::Account are unchanged: the underlying G... account still needs an authorized trustline".
- `Address::Contract` + `AUTH_REQUIRED_FLAG`: "the specified Address::Contract will need to be explicitly authorized with set_auth before it can receive a balance. This logic lines up with how trustlines interact with the AUTH_REQUIRED_FLAG issuer flag, allowing asset issuers to have the same control in Soroban as they do in Stellar classic." (Docs say `set_auth`; the interface function is `set_authorized`.)
- Revocation: "The admin can only revoke authorization from an Address, if the issuer of the asset has AUTH_REVOCABLE_FLAG set. The deauthorization will fail if the issuer is missing. This requirement is true for both the trustline balances of Address::Account and contract balances of Address:Contract. Note that when a trustline is deauthorized from Soroban, AUTHORIZED_FLAG is cleared and AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG is set to avoid having to pull offers and redeeming pool shares."
- Empirical note in official CLI guide: for an issuer with required+revocable+clawback set, "a frozen agent's next payment failed with `Payment(SrcNotAuthorized)`", and a clawback of part of the balance succeeded (measured on testnet).
Source: stellarDocs.get_doc_page_sections — https://developers.stellar.org/docs/tokens/stellar-asset-contract (#overview, #interacting-with-classic-stellar-assets, #balance-authorization-required, #revoking-authorization, #sending-to-a-muxed-address); page dated 2026-09-08; https://developers.stellar.org/docs/tools/cli/agent-cli/guides/delegate-spending (2026-09-30); confidence: high.

**SAC admin functions.** `StellarAssetInterface` extends SEP-41 `TokenInterface` with: `set_admin(new_admin)`, `admin()`, `set_authorized(id: Address, authorize: bool)` ("Sets whether the account is authorized to use its balance"), `mint`, `clawback`, and (Protocol 26 / CAP-73) `trust(addr)` to create a G-account trustline from a contract. Getter `authorized(id)` returns whether an address is authorized (used in the "Verify Trustlines" guide against testnet USDC). "The issuer of the asset will be the initial administrator of the deployed contract (administrative authority can later be moved with set_admin)." Authorization semantics: getters need no auth; unprivileged mutators need the spender's auth; "privileged mutators, such as clawback and set_admin … require special privileges" (admin). Error `OperationNotSupportedError = 2` is returned for "an impossible function … such as clawback for an asset that does not have clawback enabled. Or, an operation has been called affecting the issuer's trustline."
Source: stellarDocs.get_doc_page_sections — https://developers.stellar.org/docs/tokens/stellar-asset-contract#contract-interface , #authorization-semantics, #contract-errors, #creating-trustlines-from-a-contract (2026-09-08); https://developers.stellar.org/docs/build/guides/basics/verify-trustlines (2026-09-08); confidence: high.

**Skill caution on admin vs issuer.** "When `AUTH_REVOCABLE` and `AUTH_CLAWBACK_ENABLED` are both set, check the issuer lock *and* the admin roles before listing the asset … A contract SAC admin does not contain that power on its own: an issuer whose master key still signs can mint, freeze and claw back directly, whatever the admin contract allows. So confirm the master key weight is `0`, then identify who holds the admin contract's roles."
Source: skills.stellar-dev.assets §best-practices (commit e9ab7db); confidence: high (playbook).

**USDC (Circle) on Stellar — flags.**
- Identity (community-aggregated registry): `USDC`, issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`, issuerDomain circle.com, company Circle, `verified: true`, supply ≈486.0M, holders ≈2.49M, 24h payments ≈90k (dataAsOf 2026-10-18T20:55Z). The registry exposes no issuer-flag fields.
  Source: scout.getStablecoins (peg=USD) — https://stellarlight.xyz/api (Scout stablecoin registry); 2026-10-18; confidence: medium (community-aggregated; issuer matches the one used in official docs/skill examples).
- `AUTH_REQUIRED`: draft SEP-61 classifies "**Open** (USDC, EURC — majority) | `auth_required` false | sponsored `ChangeTrust` … | Authorizer contract not used" versus "**Regulated** (`AUTH_REQUIRED`, e.g. EURCV) | true".
  Source: scout.searchResearch — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0061.md "Specification" (2026-09-30, draft); confidence: medium.
- `AUTH_REVOCABLE` / `AUTH_CLAWBACK_ENABLED` on Circle's issuer: **no source retrieved states either way** (docs search "USDC Circle issuer clawback authorization" and two research/semantic passes returned nothing on Circle's flag configuration). Must be verified directly on-chain (issuer account `flags` via Horizon/RPC) before relying on it.
  Confidence: unknown / low.

### (c) Clawback

**Operations (official guide).**
- `Set Options`: issuer enables `AUTH_CLAWBACK_ENABLED` → "every subsequent trustline established to any assets issued by that account [has] the `TRUSTLINE_CLAWBACK_ENABLED_FLAG` set automatically." Requires `AUTH_REVOCABLE_FLAG`: "This allows an asset issuer to claw back balances locked up in offers by first revoking authorization from a trustline, which pulls all offers that involve that trustline. The issuer can then perform the clawback." Cannot be enabled retroactively: "you cannot retroactively enable clawback on existing trustlines."
- `Clawback`: "claw back some or all of an asset … burning it. You need to provide the asset, a quantity, and the account from which you're clawing back."
- `Clawback Claimable Balance`: "You must claw back the entire claimable balance, not just part of it."
- `Set Trustline Flags` can selectively clear `TRUSTLINE_CLAWBACK_ENABLED_FLAG` per trustline (Example 3: issuer "removes the clawback enabled flag from the trustline and can no longer clawback the asset").
Source: stellarDocs.get_doc_page_sections — https://developers.stellar.org/docs/build/guides/transactions/clawbacks (#set-options, #clawback, #clawback-claimable-balance, #examples, preamble); page dated 2026-08-13; confidence: high.

**SAC `clawback`.** Admin-only privileged mutator on the SAC (`StellarAssetInterface::clawback`); fails with `OperationNotSupportedError` if the asset lacks clawback. Since Protocol 23 (CAP-67) classic and contract paths emit byte-identical `clawback` events under the asset's SAC address; `transfer, mint, burn, clawback, set_authorized` can come from either path, while `approve`/`set_admin` only from contracts.
Source: stellarDocs.get_doc_page_sections — https://developers.stellar.org/docs/tokens/stellar-asset-contract#contract-interface , #contract-errors; https://developers.stellar.org/docs/tokens/token-interface#telling-a-classic-operation-from-a-contract-invocation ; confidence: high.

**Regulatory-recovery rationale (CAP-35).** "In the event of regulatory action, erroneous transaction, or loss of custody, the issuer may conduct a clawback transaction if the appropriate flags are set. In the event of loss of custody, the affected party would need to demonstrate they are the rightful owner of the account (usually through reproofing KYC credentials or otherwise authenticating). On obtaining this proof, the issuer could execute a clawback from the lost account followed by a subsequent payment…"
Source: scout.searchResearch — https://github.com/stellar/stellar-protocol/blob/master/core/cap-0035.md "Design Rationale" (2020-12-14); confidence: high (verbatim CAP text).

**Skill guidance.** "Be cautious of assets with clawback enabled"; monitor for frozen/deauthorized status; validate by issuer, not code.
Source: skills.stellar-dev.assets §best-practices (commit e9ab7db); confidence: high.

### (d) How anchors expose KYC and sanctions screening

| SEP | Status value | Meaning (official wording where retrieved) | Who acts |
|---|---|---|---|
| SEP-12 (customer) | `ACCEPTED` | "All required KYC fields have been accepted and the customer has been validated for the `type` passed. It is possible for an accepted customer to move back to another status if the KYC provider determines it needs more info at a later date, or if the customer shows up on a sanctions list." | Anchor (KYC provider) |
| SEP-12 (customer) | `PROCESSING` | "KYC process is in flight and client can check again in the future to see if any further info is needed." | Anchor processing; client polls / receives event |
| SEP-12 (customer) | `NEEDS_INFO` | Anchor needs more fields; response lists `fields` required / `provided_fields` with per-field status (example: `mobile_number` → `VERIFICATION_REQUIRED`). | Client / sending anchor must `PUT /customer` |
| SEP-12 (customer) | `REJECTED` | Customer "has been rejected and cannot be KYC'd"; spec example `"message": "This person is on a sanctions list"`. | Anchor (terminal) |
| SEP-12 (per-field) | `ACCEPTED` / `PROCESSING` / `REJECTED` / `VERIFICATION_REQUIRED` | Field-level statuses; "If the client may resubmit this field, the Customer Status should be `NEEDS_INFO`, otherwise it should be `REJECTED`." | Anchor |
| SEP-31 | `pending_sender` | "awaiting payment to be sent by Sending Anchor." (Anchor Platform: receiving anchor moves tx here with an RPC to request funds.) | Sending anchor sends on-chain |
| SEP-31 | `pending_stellar` | "transaction has been submitted to Stellar network, but is not yet confirmed." | Network |
| SEP-31 | `pending_customer_info_update` | "certain pieces of information need to be updated by the Sending Anchor" via SEP-12 `PUT /customer`; receiving anchor responds `NEEDS_INFO` listing fields; after update, business calls `notify_customer_info_updated`. | Sending anchor |
| SEP-31 | `pending_transaction_info_update` | Deprecated; per-tx `fields` were invalid. | Sending anchor |
| SEP-31 | `pending_receiver` | "payment is being processed by the Receiving Anchor." (initial status per Anchor Platform guide; also after funds received) | Receiving anchor |
| SEP-31 | `pending_external` | "payment has been submitted to external network, but is not yet confirmed." | Receiving anchor / bank rails |
| SEP-31 | `completed` | "funds have been delivered to the Receiving Client." | Receiving anchor |
| SEP-31 | `refunded` | "funds have been refunded to the Sending Anchor." | Receiving anchor |
| SEP-31 | `expired` | "funds were never received by the anchor and the transaction is considered abandoned by the Sending Client." | Receiving anchor |
| SEP-24 | `incomplete` / `pending_user` / `pending_anchor` / `pending_trust` / `pending_stellar` / `pending_external` / `completed` | Standard list (definitions retrieved from the mirrored SEP-26 list: `pending_anchor` "being processed internally by anchor"; `pending_trust` "user must add a trust-line"; `pending_user` "user must take additional action"). | Anchor / user |
| SEP-24 | `pending_user_transfer_start` | "the user has given all necessary info to the anchor, and it is up to the wallet to send the actual stellar assets." | Wallet / user |
| SEP-24 | `pending_user_transfer_complete` | "the Stellar payment has been successfully received by the anchor and the off-chain funds are available for the customer to pick up." | Anchor → user |
| SEP-6 | `pending_customer_info_update` | Same semantics as SEP-31 (bank says name/address mismatch) → SEP-12 `GET`/`PUT /customer` with `transaction_id`. | User / client |

Sources: scout.searchResearch (source=sep) — https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md "Customer GET / Customer Statuses" (2024-07-23); sep-0031.md "API Endpoints" (2024-11-05); sep-0024.md "Deposit and Withdraw shared responses" (2025-09-10); sep-0006.md "Pending Customer Info Update" (2025-09-10); sep-0026.md "Transaction History" (2021-02-23, abandoned SEP but mirrors the SEP-24 status list); stellarDocs.search_anchor_sep_docs — https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/integration (#verifying-customer-information, #ready-to-receive-funds, #funds-received, #offchain-funds-pending). Confidence: high for SEP-12/SEP-31 rows (verbatim); medium for the SEP-24 generic list (full SEP-24 status table chunk not retrieved; `error`, `no_market`, `too_small`, `too_large` unverified here).

**Anchor Platform KYC / customer API.** "Clients ask your business what KYC information needs to be collected and sends that information via the SEP-12 KYC API hosted by the Anchor Platform, but the Anchor Platform never stores personally-identifiable information (PII). Instead, it forwards requests from clients to the business server, and returns the business' responses back to the client, acting as a proxy server." Customers are identified by Stellar account + memo (sending org authenticates via SEP-10; memo per customer) or by business-generated customer IDs; the business receives `PUT /customer` callbacks. Event service: webhooks to business servers for "Transaction status changes, Quote updates, Customer KYC status changes" and to client applications per SEP-6/12/24/31 event schemas. Business must call `notify_customer_info_updated` "whenever the SEP-12 status for a customer changes".
Source: stellarDocs.search_anchor_sep_docs — https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep6/configuration#enable-callbacks-to-the-business-server ; https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31/integration#identifying-customers ; https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/events/getting-started ; https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep6/integration#verifying-kyc-information ; confidence: high.

**Custody integration.** Anchor Platform supports configuring wallet clients as `type: custodial` (with `signing_keys` and per-SEP `callback_urls`) or `noncustodial`; custodial users are identified by JWT `sub` = `account:memo`. For withdrawals, "If integration with a third-party custodian is enabled, the Anchor Platform can generate memo, memo_type, and destination_address if a corresponding `deposit_info_generator_type` is chosen." No vendor is named: searches for "Fireblocks" returned soft-empty in the docs index, and "Sumsub Notabene Sygna" matched only unrelated pages. The production guide says "there are many services that provide KYC solutions through APIs and iFrames … find a country-specific KYC provider" and that SEP-9 fields passed by wallets pre-fill the KYC form.
Source: stellarDocs.search_docs_in_category(platforms) / search_anchor_sep_docs — https://developers.stellar.org/docs/platforms/anchor-platform/admin-guide/assets-and-client-wallets#field-explanations-1 ; https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep24/integration#ready-to-receive-funds-1 ; https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep24/faq#how-to-identify-the-user-account ; https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep24/setting-up-production-server#connecting-to-real-kyc ; confidence: high for what is present; high that Fireblocks/Sumsub/Notabene/Sygna are *not* named in the indexed docs (closed-world index negative).

**Travel rule.** No hit for `"travel rule"` in the official docs index (soft-empty), and no SEP/CAP chunk containing "travel rule" surfaced in the research corpus. SEP-31's compliance model is contractual + SEP-12: "The Sending and Receiving Anchors must create bi-lateral agreements to interoperate with each other. If the Receiving Anchor requires KYC information for the Sending or Receiving Clients, the Receiving Anchor must implement SEP-12 and define a `KYC_SERVER`." Historical note: SEP-3 "Compliance protocol" (2019-10-04) defined `info_status` ∈ {`ok`,`denied`,`pending`} for AML info sharing and SEP-4 `/tx_status`; these are legacy and were not corroborated as current.
Source: stellarDocs.search_docs ("\"travel rule\"", soft-empty); scout.searchResearch — sep-0031.md "Prerequisites" (2024-11-05), sep-0003.md (2019-10-04), sep-0004.md (2017-10-30); confidence: high that docs do not mention travel-rule tooling; medium on SEP-3/4 being legacy (status lines not retrieved).

### (e) Ecosystem projects for on-chain / anchor compliance — all **community-aggregated**

- **Scorechain** (Scout + Lumenloop): "KYT (Know-Your-Transaction), AML, risk scoring, and sanctions screening integrated with the Stellar blockchain … FATF/OFAC/EU AMLD-aligned … 15+ chains". Status Live (statusAsOf 2026-08-27); SCF round 36, US$85,000 awarded; based in Luxembourg.
  Source: scout.searchProjects — https://stellarlight.xyz/project/scorechain ; lumenloop.get_project — https://scorechain.com ; 2026-08-27; confidence: medium (community-aggregated).
- **Brale**: "regulated stablecoin issuance and orchestration platform supporting Stellar, providing the compliance (KYC/KYB, sanctions screening), minting and redemption, and reserve-management infrastructure". Live.
  Source: scout.searchProjects — https://stellarlight.xyz/project/brale ; confidence: medium.
- **Webacy / DD**: "Decisioning and risk data scoring for digital assets and wallets" (Webacy SCF-awarded). Source: scout.searchProjects — https://stellarlight.xyz/project/webacy-inc , https://stellarlight.xyz/project/dd ; confidence: low-medium (adjacent — wallet risk scoring, not sanctions oracle).
- **MyDataCoin**: "privacy-preserving DeFi lending and KYC compliance on Stellar using zero-knowledge proofs and self-sovereign identity". Status Development. Source: scout.searchProjects — https://stellarlight.xyz/project/mydatacoin ; confidence: low.
- **FinClusive** (partner directory, type anchor): "To Be Inclusive, You Must Know Your Customers!"; SEP-6/24/31, on/off-ramp, XLM/USDC. 2020 SDF webinar "Driving Inclusion Through Compliance" on helping anchors meet compliance while keeping US banking access. Source: scout.getPartners — https://stellarlight.xyz/partners/finclusive ; lumenloop.search_content_semantic — https://stellar.org/events/community/driving-inclusion-through-compliance (2020-09-09); confidence: medium.
- **Arcane** ("compliance-ready privacy infrastructure"), **Bitbond** (tokenized securities with "regulatory and compliance features"), **BlindPay**, **Bitwave** — directory rows only. Source: lumenloop.search_directory("compliance"); confidence: low (descriptions only).
- **Repos (Soroban compliance primitives):**
  - `stellar-compliance-kit/compliance-primitives` — "On-chain compliance primitives for Stellar — allowlist/denylist token gating and jurisdiction checks for RWA and stablecoin issuers, built on Soroban." 0 stars, repoScore 44, last commit 2026-10-04, stellarEvidence code-verified. Companion `compliance-adapters` — "connecting Stellar compliance primitives to SEP-10 auth, sanctions oracles, and Horizon event streams" (repoScore 38, 2026-10-02).
  - `RWA-ToolKit/stellar-rwa-contracts` — "built-in compliance (KYC allowlists, transfer restrictions, dividends)" (repoScore 45, 2026-10-02).
  Source: scout.searchRepos — https://github.com/stellar-compliance-kit/compliance-primitives , https://github.com/stellar-compliance-kit/compliance-adapters , https://github.com/RWA-ToolKit/stellar-rwa-contracts ; confidence: low (early, unaudited, zero-star; license/audit unknown).
- **Audited precedent for blocklist pattern:** Matrixdock XAUm RWA audit (Runtime Verification) documents operator functions `add_to_blocked_list(user)` / `remove_from_blocked_list` — "while blocked, the address cannot transfer or act as spender/from in transfer_from". Source: scout.searchResearch (source=audit) — https://stellarsecurityportal.com/report/80 ; confidence: medium.
- **Travel-rule vendors (Notabene, Sygna) and address-screening oracles:** none found in Scout projects/partners or Lumenloop (searchProjects "travel rule" returned travel-wallet apps — adjacent, discarded). Confidence: low (open-world negative).

### (f) Soroban-level patterns

**OpenZeppelin Stellar Contracts (official docs page).** "a collection of audited contracts and utilities for Stellar … developed by OpenZeppelin in collaboration with the Stellar community and the Stellar Development Foundation". Audited modules include Fungible Token extensions: Burnable, Capped, **Allowlist: "Restrict transfers to approved addresses"**, **Blocklist: "Prevent transfers from/to blocked addresses"**. Tooling: Contract Wizard (Rust/Soroban templates), **Role Manager** ("Access control management interface for smart contracts. Visualize roles, permissions, and execute administrative actions"), Relayer, Monitor, Soroban Security Detector SDK.
Source: stellarDocs.get_doc_page_sections — https://developers.stellar.org/docs/tools/openzeppelin-contracts (#audited-modules-available, #openzeppelin-open-source-tools); page dated 2026-07-21; confidence: high.

**Access control / pausable crates and macros (OZ skills).** Crates: `stellar-tokens`, `stellar-access`, `stellar-contract-utils`, `stellar-macros` (plus `stellar-accounts`, `stellar-fee-abstraction`, `stellar-governance`). Imports: `stellar_access::ownable::Ownable`, `stellar_contract_utils::pausable::Pausable`, `stellar_macros::when_not_paused`; guard macros `#[when_not_paused]`, `#[only_owner]`, `#[derive(Upgradeable)]`. Access options: "Ownable — single owner … AccessControl / RBAC — role-based, finer granularity (available in the `access` package) … Multisig or governance — for production contracts managing significant value." Pin exact versions (`=`) — "the library is under active development". Audits: v0.1.0 (2025-02-20) and differential v0.3.0-rc.2 (2025-07-09) covering `access/access-control`, `access/ownable`, `access/role-transfer`.
Source: skills.openzeppelin-stellar.setup-stellar-contracts §code-patterns, §openzeppelin-dependencies and skills.openzeppelin-stellar.upgrade-stellar-contracts §access-control — https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-skills/6f215af60eb60017ab1a933ce9d22a479cd42b26/skills/... (commit 6f215af); scout.searchResearch (source=audit) — https://stellarsecurityportal.com/report/2 , https://stellarsecurityportal.com/report/35 ; official example https://developers.stellar.org/docs/build/smart-contracts/example-contracts/fungible-token ("Ownable pattern … Pausable Functionality: Allows the owner to pause/unpause token operations in emergency situations"); confidence: high.

**Security checklist items relevant to a custody/vault contract (stellar-dev skill).**
- Missing authorization: every privileged path needs `require_auth()` on an address *loaded from storage* (admin), never a caller-supplied parameter.
- Auth replay through middleware: "If `user` has pre-signed an auth tree that includes the inner `token.transfer`, *anyone* can call `settle(user, ...)` and consume it. Re-authorize at **every** layer that exercises an address's authority."
- Design rules: "**Vaults**: track `total_assets`/`total_shares`, round conservatively on mint/redeem, include pause controls." "**Regulated tokens**: isolate allowlist/denylist and freeze/force…" (chunk truncated). Timelock/multisig pattern: `propose_*` / `execute_*` / `cancel_*` with separate proposer/approver/executor roles.
Source: skills.stellar-dev.smart-contracts file:security.md and file:development.md — https://raw.githubusercontent.com/stellar/stellar-dev-skill/e9ab7dbb662dc2efc9b0ebb4ed86c417d16dd29f/skills/smart-contracts/ (commit e9ab7db); confidence: high (playbook).

**SEP-41 token interface and "hooks".** SEP-41 (`TokenInterface`: `allowance, approve, balance, transfer(from, to: MuxedAddress, amount), transfer_from, burn, burn_from, decimals, name, symbol`) defines function signatures, authorization requirements and event shapes; it has **no transfer-hook/callback mechanism** — compliance must be implemented *inside* a custom token's `transfer` (OZ Allowlist/Blocklist extensions, or SEP-57/T-REX) or in the calling contract. Compatibility requirements: function interface (hard), authorization ("the users have to authorize the token function calls with all the arguments of the invocation"), events. "the contract token may not implement the administrative interface compatible with the Stellar Asset Contract - it won't stop it from being usable". SAC events carry an extra last topic (SEP-11 asset id). Since Protocol 23, classic operations emit the same events under the SAC address (CAP-67).
Source: stellarDocs.get_doc_page_sections — https://developers.stellar.org/docs/tokens/token-interface (#compatibility-requirements, #code, #events-sep-41-tokens-vs-stellar-asset-contracts, #telling-a-classic-operation-from-a-contract-invocation); confidence: high (absence of hooks is read from the interface text).

**SEP-57 / ERC-3643 (T-REX) permissioned tokens.** "A permissioned token standard for regulated, compliance-aware assets that extends SEP-41 with identity and rules enforcement. T-REX tokens are issued by a deployed Wasm contract (C... addresses) and implement compliance logic directly in the contract suite." Strengths: "On-chain compliance. On-chain identity. Role/agent-based structure tailored for institutions." Tradeoffs: higher complexity/cost; "Transfers and control functions not yet supported in wallets. Indexer support is not provided out of the box." Decision guide: G-account assets + SAC → "Regulatory controls through protocol flags"; SEP-41 contract tokens → "Custom token logic (transfer fees, vesting, hooks)".
Source: stellarDocs.search_asset_token_docs — https://developers.stellar.org/docs/tokens/anatomy-of-an-asset (#what-these-are-1, #strengths-2, #tradeoffs-2, #decision-guide); confidence: high.

### Implications for a vault that holds a buyer's USDC until due dates and releases it to a licensed sending anchor

- **USDC is a classic asset reached through its SAC; the vault's balance is a Contract Data entry, not a trustline.** USDC is "Open" (`auth_required=false`, per draft SEP-61), so the vault contract needs no `set_authorized` from Circle to receive. Whether Circle has `AUTH_REVOCABLE`/`AUTH_CLAWBACK_ENABLED` set was *not* established by any source here — read the issuer account flags on-chain before finalizing; if set, the SAC admin can `set_authorized(vault, false)` or `clawback` the vault balance (CAP-35 rationale explicitly covers "regulatory action"), so the design must tolerate a frozen balance (expect `Payment(SrcNotAuthorized)`-style failures / SAC balance-deauthorized errors) rather than assume finality.
- **Compliance gating has to live in the vault contract and off-chain, not in the token.** SEP-41/SAC has no transfer hooks and SEP-8 is a classic-transaction approval protocol with no evidenced Soroban coverage; so: keep an admin-managed **allowlist of release destinations** (the licensed anchor's G-/C-address), gate `release` behind `#[only_owner]`/AccessControl roles plus a due-date check, add `Pausable` (`#[when_not_paused]`) and a timelocked admin, using the audited OpenZeppelin `stellar-access`/`stellar-contract-utils` crates rather than hand-rolled roles.
- **Re-authorize at every layer.** The buyer's `require_auth()` must be consumed by the vault's own `deposit` entrypoint (not only by the inner SAC `transfer`), and `release` must authorize the admin/keeper address loaded from storage — the "auth replay through middleware" bug in the skill checklist is exactly the shape of a vault that forwards tokens.
- **Tie release to the anchor's SEP-31/SEP-12 state machine.** The sending anchor's customer must be `ACCEPTED` under SEP-12 (an accepted customer "can move back to another status … if the customer shows up on a sanctions list", so re-check at release time, not only at onboarding), and the receive-side transaction should be in `pending_sender` ("awaiting payment to be sent by Sending Anchor") before funds leave the vault; then track `pending_stellar → pending_receiver → pending_external → completed`, and handle `refunded`/`expired` by routing returned USDC back to the vault/buyer. Use Anchor Platform webhooks (transaction + "Customer KYC status changes") instead of polling.
- **Sanctions / travel-rule screening is off-chain and contractual.** The official docs and SEPs retrieved contain no travel-rule tooling; SEP-31 relies on bilateral anchor agreements plus SEP-12 `KYC_SERVER`. Screen buyer and anchor addresses with a KYT provider (e.g. Scorechain-class tooling, community-aggregated) before `deposit` and before `release`, and record the screening decision hash in an event for auditability (CAP-67 events make SAC transfers indexable alongside classic payments).
- **Do not architect around SEP-8 or on-chain compliance oracles.** SEP-8 does not apply (USDC is not a regulated asset) and the Soroban compliance repos found are zero-star, unaudited early work; the audited building blocks available today are OpenZeppelin Allowlist/Blocklist/Ownable/AccessControl/Pausable and the SAC's `authorized(id)` getter (useful as a pre-flight check that the anchor's trustline is authorized before release).

---

## 7. Landscape

Research date: 2026-10-19 (all `asOf`/observedAt timestamps 2026-10-19T02:38–02:41Z unless a row states a publishedAt). All sources are **community-aggregated** (Lumenloop directory/SCF index, Stellar Light/Scout directory, SCF proposals in the applicants' own words, press articles). Nothing below is verified against primary filings; treat statuses, award amounts and traction claims as self-reported or indexer-derived.

Source id key: `LL-dir` = `lumenloop.search_directory` / `lumenloop.get_project`; `LL-scf` = `lumenloop.find_similar_scf_submissions` / `lumenloop.get_scf_submissions`; `LL-sem` = `lumenloop.search_content_semantic`; `SC-proj` = `scout.searchProjects`; `SC-part` = `scout.getPartners`; `SC-res` = `scout.searchResearch` (source `scf-proposal` unless noted); `SC-stable` = `scout.getStablecoins`.

Known source conflict: Scout `scfTotalAwardedUSD` and Lumenloop `scf.awarded_total` disagree for several projects (e.g. Lend 213,460 vs 149,636; BWB 150,000 vs 15,000; Crebit 100,000 vs 10,000; Verso 110,000 vs 66,000). Where both exist I show both as `SC/LL`. Lumenloop appears to under-count (possibly only tranche paid to date); Scout appears to mirror the requested budget. Not resolved.

### (a) LatAm real estate (tokenized property, fractional, mortgage/down-payment, escrow, diaspora home-buying)

| project | corridor/country | what it does | status / date | label + why | source | confidence |
|---|---|---|---|---|---|---|
| **Nauta Land** — nauta.land — https://stellarlight.xyz/project/nauta-land | Colombia (based_in Colombia; region LatAm & Caribbean) | Real-estate tokenization / fractional ownership platform; SCF #27 funded a P2P secondary market. SCF #18 text names the Colombian market explicitly (inflation, property-cost pressure); founder is an architect/real-estate developer. | Scout status Live; SCF #21 + #27 (Legacy v5.0 Community Awards), total ~122,867 USD (both sources agree); Scout lastActivityAt null (no indexed repo activity) | **Potential partner / closest competitor** — the only Colombian-domiciled real-estate tokenizer indexed; a down-payment or diaspora-buyer product would either plug into their inventory or compete for the same buyer | LL-dir (slug nauta-land); SC-proj; SC-res https://communityfund.stellar.org/submissions/rectnpnWufE42Gm1r , …/recClpF9C92a0bLMd , …/recmTHji8ZdovZPdH | high (identity), medium (current activity) |
| **BWB Digital Assets** — bwbi.com.br — https://stellarlight.xyz/project/bwb | Brazil | CVM-regulated investment platform tokenizing Brazilian real estate (fractional, audited yields); SCF #45 "Property Finance & Investment on Stellar". GitHub github.com/techlibs/bwb-stellar. | Scout status Development; SCF #45 Build, 150,000 (SC) / 15,000 (LL); lastActivityAt 2026-10-01 | **Reference** — regulated-issuer model for property tokens in LatAm (Brazil, not Colombia); shows what a CVM-style structure looks like on Stellar | LL-dir (bwb); SC-proj; https://communityfund.stellar.org/submissions/rec8bhUAafIcSJUzA | high |
| **Tokeshare** — tokeshare.co | LatAm (country not stated in index; multi-chain: Polygon/Ethereum/Base + Stellar PoC) | Tokenizes revenue-generating real-economy assets incl. **rental properties**, businesses, vehicles; USDC rent/revenue distribution; Soroban sale contract live; Privy embedded wallets for non-crypto LatAm investors; fiat on/off-ramp chapter in the SCF plan. Traction claim: ~43.9k USD tokenized, 722 shares sold. | SCF #44 Build "LATAM Real-World Investing on Stellar", requested 133,000 (LL awarded_total 39,900); no Scout record | **Competitor / reference** — rental-property fractional investing aimed at LatAm retail; overlaps with any "own a share of a home" angle | LL-dir (tokeshare); LL-scf https://communityfund.stellar.org/submissions/recFXz7DtcwZ9JzFJ | medium (self-reported traction) |
| **Urbanflip** — https://stellarlight.xyz/project/urbanflip | Not stated (claims >90M USD co-invested in 12 months via existing off-chain platform) | Live real-estate co-investment platform moving to compliant on-chain co-investment on Stellar | SCF #45 Build, requested 120,000, **Status: Information Collection** (not yet awarded per proposal page); Scout status Development; not in Lumenloop directory | **Reference / watch** — large off-chain base; if LatAm-facing it becomes a competitor | SC-proj; SC-res https://communityfund.stellar.org/submissions/recoH6oUW1TIa9562 | medium |
| **Mica** — mica.rent — https://stellarlight.xyz/project/mica | Mexico | Real-estate transaction escrow + rental underwriting (tenant risk, financial tools); github.com/micatechnology/escrow_api | SCF #16 Legacy v4.0, 138,700; Scout Live but lastActivityAt 2023-04-29 → **likely dormant** | **Reference** — escrow-for-property pattern in Mexico; stale | LL-dir (mica); SC-proj; https://communityfund.stellar.org/submissions/recdcC4akBWPOdMsS | medium |
| **Lend (lend.xyz)** — app.lend.xyz — https://stellarlight.xyz/project/lend | France / Global | Compliant tokenized real-estate infrastructure; stablecoin investment into asset-backed property tokens | Live; SCF #43 + #45 Build, 213,460 (SC) / 149,636 (LL) | **Reference** — not LatAm; useful as the best-funded Stellar real-estate rail | LL-dir; SC-proj; …/rec2QeA1y7ln6D3Ii , …/reciJ66GV514CRUi4 | high |
| **Tauvlo** — tauvlo.com | Czech Republic / Global | Tokenized real-estate marketplace | Live; SCF #23 + #26, 145,000; no activity date | Reference (non-LatAm) | LL-dir; SC-proj | medium |
| **RedSwan** — redswan.io | USA | FINRA-regulated CRE tokenization; 100M USD of commercial RE brought to Stellar (press 2025-09-18) | Live; no SCF | Reference — institutional CRE template, not residential/LatAm | LL-sem https://stellar.org/press/redswan-digital-real-estate-brings-usd100m-of-tokenized-real-estate-to-the-stellar-network (2025-09-18) | high |
| **Verseprop** — verseprop.com | UK | FCA-regulated CRE tokenization | Live; SCF #33 Build 112,020; activity 2026-01-06 | Reference (non-LatAm) | LL-dir; SC-proj | medium |
| **Minah** — minah.io | France → Sub-Saharan Africa | Fractional real-estate tokenization | Live; SCF #38, 97,500 | Reference only (Africa) | LL-dir | medium |
| **Plutus** — plutus.rentals | n/a | Conditional-NFT ownership infra for rental/**mortgage**/lending use cases | SCF #17, 98,600; no recent signal | Reference — only indexed "mortgage" primitive; likely dormant | LL-dir (plutus) | low |
| **Trustless Work** — trustlesswork.com — https://stellarlight.xyz/partners/trustless-work | LatAm-region partner (Costa Rica-rooted team, per directory region tag) | Escrow-as-a-service on Soroban (milestone escrows) | Partner listed, acceptingClients true, freshness "aging" | **Potential partner** — ready-made escrow for down-payment / construction-milestone release | SC-part (region latam); LL-dir (trustless-work) | medium |
| **Eascrow** — eascrow.xyz | n/a | Web3 escrow platform on Stellar | directory only | Reference — alt escrow | LL-dir | low |
| **Bando** — bando.cool | Mexico | B2B treasury into tokenized CETES via Etherfuse | SCF #42, 75,000 (SC) / 45,000 (LL) | Reference — shows LatAm fintech consuming Etherfuse yield rails (relevant to parking down-payment savings) | LL-dir; SC-proj | medium |
| **Dobprotocol** — https://stellarlight.xyz/project/dobprotocol | not stated | RWA revenue-distribution automation | Live; SCF #37, 143,330; activity 2026-08-07 | Reference — rent/revenue distribution primitive | SC-proj | low |

Not found in the indexed data (soft-empty or off-target after 6 directory + 2 SCF + 1 semantic pass, including Spanish terms "inmobiliario vivienda tokenizacion", "cuota inicial vivienda credito hipotecario remesas"): no Stellar project doing **mortgage origination, down-payment financing/savings for home purchase, or diaspora home-buying** in LatAm. The Spanish down-payment query returned only remittance apps (Puenta, Unalivio, Felix Pago, DomiPago). Absence in the index is not proof of absence in the market.

### (b) Remittances to/within LatAm (US→CO / US→MX / US→Central America; anchors, wallets, payout networks)

| project | corridor/country | what it does | status / date | label + why | source | confidence |
|---|---|---|---|---|---|---|
| **MoneyGram Access (MoneyGram Ramps)** — moneygram.com — https://stellarlight.xyz/project/moneygram | Global cash network; Colombia named as first stablecoin-app market (2025-09-17), extension to El Salvador (2026-04-22) | SEP-24 cash on/off-ramp anchor; MoneyGram stablecoin app (USDC stored value, Crossmint, Circle) launched in Colombia; MGUSD stablecoin on Stellar (explainer 2026-06-30) | Live; Scout coverage lists SEP-24 only; lastActivityAt 2022-06-24 (repo signal only) | **Potential partner** — cash payout + Colombian consumer app already live; the de-facto last-mile for US→CO cash | SC-proj; LL-sem: https://www.pymnts.com/cryptocurrency/2025/moneygram-to-launch-stablecoin-based-solution-for-cross-border-finance/ (2025-09-17); https://www.prnewswire.com/news-releases/moneygram-and-stellar-extend-partnership-to-scale-real-world-stablecoin-utility-globally-302749574.html (2026-04-22); https://thedefiant.io/education/explainers/mgusd-moneygram-stablecoin-stellar-distribution-explainer (2026-06-30); https://www.youtube.com/watch?v=0efjGN9Zowk (integration deep-dive, 2026-04-29) | high |
| **Bitso** — bitso.com — https://stellarlight.xyz/project/bitso ; partner https://stellarlight.xyz/partners/anchor-bitso | MX, BR, AR, **CO**; currencies MXN/BRL/ARS/**COP**/USD (coverage asOf 2026-07-09) | LatAm exchange operating as Stellar anchor (on/off-ramp); powers Félix Pago US→MX | Live; partner listed on-ramp + off-ramp, acceptingClients true | **Potential partner** — only indexed anchor with COP coverage besides VANK; the Félix/Bitso case study is the template | SC-proj (coverage); SC-part; LL-sem https://stellar.org/case-studies/felix-bitso (2023-08-02) | high |
| **Félix Pago** — felixpago.com — https://stellarlight.xyz/project/felix-pago | US → Mexico, Guatemala, Honduras | WhatsApp-based remittance app, USDC on Stellar via Bitso rails | Live; no SCF; no COP corridor indexed | **Competitor (benchmark)** for US→MX/CA consumer remittance; not in Colombia per index | LL-dir; SC-proj | high |
| **VANK** — thisisvank.com — https://stellarlight.xyz/project/vank | **Colombia** ↔ US (based_in Colombia) | B2B multicurrency payments (claims 115M USD TPV, 40 enterprise clients); building **VANK Anchor: USDC-COP on/off ramp — COP deposits via PSE, USDC to partner Stellar accounts** | Live; SCF #43 Build, 96,800 (both sources) | **Potential partner (call first)** — the only SCF-funded COP anchor with PSE collection in the index | LL-dir (vank); SC-proj; SC-res https://communityfund.stellar.org/submissions/recZv0mHzFOod8c4t | high |
| **Abroad** — abroad.finance — https://stellarlight.xyz/project/abroad | **Colombia** (Movii BaaS, Persona KYC, local QR) → LatAm | Open-source crypto↔fiat instant payment layer: USDC↔COP instant on/off ramp, wallet interoperability, fiat QR payments; partnership with Lobstr for LatAm stablecoin payments (2025-11-09) | Live; SCF #32 + #35 Build, 149,820 total (SC); lastActivityAt 2026-08-13 | **Potential partner** — COP payout rail with QR; already integrated with a top wallet | SC-proj; SC-res https://communityfund.stellar.org/submissions/recy3we2U8HQUaOR6 ; LL-sem https://abroad.finance/blog/abroad-and-lobstr-team-up-to-bring-stablecoins-into-everyday-life (2025-11-09) | high |
| **Meru** — getmeru.com — https://stellarlight.xyz/project/meru | **Colombia**-based; LatAm freelancers | USD account / financial services for LatAm freelancers; US bank account settling in USDC (SCF #22); embedded API (SCF #31 proposal) | Live; SCF #14/#22/#25, 225,360 | **Potential partner / adjacent competitor** — Colombian team with KYC'd USD-holding user base (potential down-payment savers) | LL-dir (meru, based_in Colombia); SC-proj | high |
| **Loto Punto** — lotopunto.co | **Colombia** (kiosks in drugstores; Venezuelan migrants) | Self-service kiosk network for cross-border transactions and stablecoin purchase | Live; SCF #34, 75,975; activity 2025-02-03 | **Potential partner** — physical cash-in points in Colombia | LL-dir (based_in Colombia); SC-proj; https://communityfund.stellar.org/submissions/recDxUmYAHp872SMJ | medium |
| **Enable (Humanity Link)** — humanity.link — https://stellarlight.xyz/project/enable | Venezuela → **Colombia** corridor (DRC, GOAL pilots; MoneyGram cash-out) | Aid/remittance disbursement infra with USDC and MoneyGram last mile | Scout Development; SCF #43 "Stellar Off-Ramps for Communities" + SCF #45 "Humanitarian Aid Payments" (proposals; award status not shown in chunk) | Reference — proves MoneyGram cash-out works inside Colombia | SC-res https://communityfund.stellar.org/submissions/recbyuKM3UBIMEWYp , …/recZeBSnr1JqjPt4C | medium |
| **Anclap** — anclap.com — https://stellarlight.xyz/project/anclap ; partner https://stellarlight.xyz/partners/anchor-anclap | Argentina, Peru (ARS, PEN issuer); SEP-6/24; earlier US→Colombia pilot with FinClusive (2023) | Anchor / fiat↔crypto infra | Live; SCF #7/#17/#26, 572,162 (largest LatAm anchor award) | **Potential partner** — multi-country anchor; the 2023 FinClusive–Anclap US→CO pilot is a direct precedent | SC-proj; SC-part; LL-sem https://stellar.org/blog/ecosystem/blockchain-remittances-a-game-changer-for-cross-border-transfers (2023-04-10); AV https://www.youtube.com/watch?v=mwOUX-_V-Fw "Innovating Colombia's Financial System" (2026-04-28) | high |
| **Alfred Pay** — alfredpay.io — https://stellarlight.xyz/project/alfred ; partner https://stellarlight.xyz/partners/anchor-alfred-pay | LatAm stablecoin→local rails (B2B) | Cross-border payments platform on stablecoins | Live; SCF #9/#19, 335,000; partner acceptingClients true | Potential partner (B2B payout) | SC-proj; SC-part | medium |
| **Cash Abroad** — cashabroad.one — https://stellarlight.xyz/project/cash-abroad | Mexico (USA⇄MX, MX→CL corridors) | B2B stablecoin payments anchor; MXN–USDC | Live; SCF #11/#14/#21/#41, 255,025 | Reference — B2B, Mexico | SC-proj; LL-dir (cashabroad); …/recB335vaGPt0v4xY | high |
| **Puenta (KometPay)** — kometpay.com | US → LatAm (Latino migrants; vouchers to family) | Mobile remittance + voucher app | Live; SCF #14/#18, 171,294; no activity date | Competitor (consumer remittance) | LL-dir; SC-proj | medium |
| **Unalivio** — unalivio.com | Venezuela-based, operating Mexico; migrants pay family bills | Stablecoin bill-pay for families abroad | Live; SCF #16/#29/#32, 150,165 | Competitor/adjacent (bill-pay rather than cash) | LL-dir | medium |
| **DomiPago** — domipago.com | US → Dominican Republic (WhatsApp) | Chat-based remittance, cash-out | Live; SCF #37, 110,000; activity 2024-10-05 | Reference — WhatsApp UX; Caribbean | LL-dir; SC-proj | medium |
| **TuCambio** — tucambio.app | Chile-based; LatAm on/off-ramp API (CLP on-ramp, VES off-ramp in SCF #37 plan; "Seasonal Workers Payroll") | API on/off-ramp via local payment methods | Live; SCF #37/#43, 175,000 (SC) / 135,000 (LL) | Potential partner (ramp API) | LL-dir; SC-proj; …/recFH2PYipPQHaeDN | medium |
| **Basilic** — getbasilic.com | LatAm B2B | Routing layer between bank rails and stablecoin settlement (hybrid PSP) | Live; SCF #44, 100,000 (SC) / 30,000 (LL) | Reference | SC-proj; LL-dir | medium |
| **Onboard** | LatAm payout corridors (countries not visible in chunk) | "USDC on Stellar: LatAm Payout Corridors" | SCF #45 Build awarded, requested 89,000 | Watch | SC-res https://communityfund.stellar.org/submissions/recYkVbw1IA77YLkt | low |
| **Muney** — muney.app | Emerging markets B2B | Stablecoin-to-cash infra for fintechs/remitters (claims ~3.5M USD volume) | SCF #44, 28,500 (LL) | Reference | LL-dir; …/recnd9hYmEgcp2vB2 | low |
| **Beans** — beansapp.com — https://stellarlight.xyz/project/beans | Global consumer wallet | Non-custodial wallet + money transfer for non-crypto users | Live; SCF #10/#15/#21/#29, 490,160; activity 2026-09-02 | Potential distribution partner | SC-proj | high |
| **Lobstr** — lobstr.co — https://stellarlight.xyz/project/lobstr | Global wallet (Abroad LatAm integration) | Leading non-custodial Stellar wallet | Live; SCF 232,000; activity 2026-10-02 | Potential distribution partner | SC-proj | high |
| **Decaf** — decaf.so | ~200 countries, Solana+Stellar | Non-custodial wallet, on/off-ramp | Live; SCF #17, 150,000; activity 2024-07-02 | Reference | SC-proj | medium |
| **Airtm** — airtm.com | Global P2P / LatAm-heavy | P2P exchange wallet; enterprise payouts | Live; no SCF | Potential payout partner | SC-proj | medium |
| **Vibrant** | — | Not found under its own name in Scout; Lumenloop has a stale record under slug `vesseo` ("Vibrant is a digital wallet… USDC", website vesseoapp.com) | unresolved | — | LL-dir (vesseo) | low |
| **Kado**, **Littio**, **Minteo**, **Nummus**, **Lumx** (project), **Settle Network** (project) | — | Not indexed as projects (Kado/Littio/Minteo/Nummus: no match; Lumx appears only as an article: BRL–USDC institutional corridor 2026-08-04; Settle Network appears only as ARST/BRLT issuer in stablecoin index) | — | — | SC-proj soft/empty; LL-sem https://lumx.io/blog-posts/lumx-launches-brl-usdc-corridor-on-stellar-for-institutional-payment-settlement-in-brazil | n/a |
| **Mykobo** — mykobo.co | EUR (EURC) SEP-6/24/31 | Euro anchor | Live; SCF 269,896 | Not LatAm; reference for SEP-31 | SC-proj | high |
| **Zebec** — zebec.io | Global payroll → MoneyGram cash-out | Enterprise payroll with MoneyGram Ramps off-ramp (2026-09-09) | Live | Reference — recent MoneyGram Ramps integration | LL-sem https://zebec.io/blog/zebec-and-moneygram-expand-enterprise-payroll-with-global-fiat-off-ramp-access-on-the-stellar-network (2026-09-09) | medium |
| Inactive per Scout: **AuraPay** (EU→LatAm remittance), **Ping** (AR neobank), **SGF Solutions** (USDC→ARS), **Pactta** (LatAm anchor-interop API, SCF #16 120,700) | — | — | Inactive | Reference only — graveyard of LatAm remittance/interop attempts | SC-proj (status Inactive); LL-dir | medium |

Scout `type=Anchor` roster total: 44 anchors indexed; 12 LatAm-related (listed above). Scout LatAm partner directory (`region=latam`, all=1): 13 partners — Etherfuse (MX), CLPX (CL), Alfred Pay, Boss Pay, Ping, Trace Finance (BR), Anclap (AR), Cash Abroad (MX), Bitso (MX), nTokens (BR, archived), Trustless Work, DeFindex, Soroswap. **No partner row is tagged country=Colombia**; the `q=colombia` partner search returned only Bitso.

### (c) FX locks / hedged remittance pricing / forward-like products

| project | corridor/country | what it does | status / date | label + why | source | confidence |
|---|---|---|---|---|---|---|
| **Crebit (Crebit Pay / Crebit Rate Locks)** — crebitpay.com — https://stellarlight.xyz/project/crebit , https://stellarlight.xyz/project/crebit-pay | US-based; pairs cited BRL, NGN vs USD stablecoins (no COP/MXN named) | "Programmable rate-lock layer for stablecoin FX": short-duration (intraday to multi-day) **USDC-settled non-deliverable forwards** via API/dashboard for payment companies, FX providers, market makers. Worked example in proposal: a Brazilian remittance provider guarantees a rate to the customer, then hedges the BRL/USD gap with Crebit until the offsetting flow arrives. "Backed by a16z speedrun" (self-claim). | Live; SCF #44 submission (status not shown) and SCF #45 Build **Awarded**, requested 100,000 (LL awarded_total 10,000) | **Potential partner (call first for FX lock)** — exactly the hedging leg a locked-rate remittance needs; does not yet list COP | LL-dir (crebit-pay); LL-scf https://communityfund.stellar.org/submissions/rec11acDNjhqKRI82 ; SC-res https://communityfund.stellar.org/submissions/recU1uYfKSZk9IFuQ | high |
| **XCCY** — xccy.finance | Netherlands / Global | On-chain interest-rate swaps for fixed-rate lending/borrowing on Soroban + EVM (locks deposit yield / loan cost) | SCF #43 Build, 141,125; SCF #44 follow-up submission | Reference — rate hedging, not FX; relevant if a down-payment savings product wants fixed yield | LL-dir (xccy); SC-res https://communityfund.stellar.org/submissions/recYG4H2aBA5lJSnG , …/recXJTlDlzDDqSLB7 | medium |
| **FX Swap (Hedgehog / Hedge Effective)** — hedgeeffective.com | Australia / Global | "Alternative way of foreign currency borrowing or investing" (FX swap product) | SCF #21 Legacy v5.0 Activation, 42,450; no activity signal | Reference — early FX-swap attempt; likely dormant | LL-dir (fx-swap); LL-scf rec5LpAd2YYGkMTnZ | low |
| **FxDAO** — fxdao.io | Global | XLM-collateralized decentralized stablecoins in multiple denominations; repeated Liquidity Awards (SCF #13, LA '24 Q1, LA '25 Q3) | Live | Reference — a route to non-USD on-chain units (no COP indexed) | SC-res https://communityfund.stellar.org/submissions/rec95qhUPvuRiCCFQ | medium |
| **Bondhive** — bondhive.xyz | Global | Fixed-return savings by tokenizing funding fees / carry trade | SCF #29 | Reference — fixed-yield primitive | LL-dir; LL-scf recFFYDdyYhSVQ9np | low |
| **Borderless / Borderless Payments** | remittance-receiving institutions | Embedded remittance APIs for FIs (SCF #20, #22) | Legacy awards; status unknown | Reference | LL-scf rec32utFP3jR18fr7 , recWsJsebcTT9zF3Q | low |
| **Seasonal Workers Payroll / TuCambio** | LatAm (CLP, VES) | SCF #37 "Remittances with USDC in LATAM": wallet to "beat inflation using USDC and instant conversion to local currency" | Awarded, 75,000 requested | Reference — inflation-protection framing, not a true FX lock | SC-res recFH2PYipPQHaeDN | medium |
| **Upesa [Onchain FX]** | Africa (GHS, KES, NGN) | Stablecoin currency-swap feature | SCF #38 | Off-region reference | SC-res recNYANviBH34BvEI | low |

Finding: across 3 `scout.searchResearch` scf-proposal queries, 2 `find_similar_scf_submissions`, 2 semantic passes and 1 directory pass on "locked rate / hedge / forward / guaranteed FX", **Crebit is the only Stellar project offering FX forwards/rate locks**, and no proposal describes a **consumer-facing locked-rate or forward-priced remittance** for any LatAm corridor. No COP hedging instrument of any kind is indexed.

### (d) Colombia-specific: COP assets, Colombian anchors, PSE/Bre-B, Colombian fintechs on Stellar

| project | corridor/country | what it does | status / date | label + why | source | confidence |
|---|---|---|---|---|---|---|
| **COP stablecoin on Stellar** | Colombia | `scout.getStablecoins({peg:"COP"})` → **0 rows** (dataAsOf 2026-10-18T20:55Z; 41 stablecoins tracked). LatAm pegs present: ARST (Settle Network, mcap ~160k USD, 328,639 holders), ARS (Anclap, ~27.7k USD), PEN (Anclap, 41,417 holders), BRLT (Settle, ~545 USD), MXNe (Brale, ~8 USD), CLPX (CLPX, 5,780 holders) | closed-world empty at this source | **Gap** — nobody has a live COP-pegged asset on Stellar in the tracked index | SC-stable | high (for this index) |
| **VANK Anchor** — see (b) | Colombia | USDC↔COP on/off ramp; **COP collection via PSE**; USDC delivered to partner wallets; B2B parent processes US–LatAm trade payments | SCF #43 Build awarded, 96,800 | **Potential partner (call first)** | SC-res https://communityfund.stellar.org/submissions/recZv0mHzFOod8c4t ; LL-dir vank | high |
| **Abroad** — see (b) | Colombia (Movii BaaS, Persona KYC, local QR) | USDC↔COP instant ramp + QR fiat payments for wallets; open source; Lobstr integration | SCF #32 + #35 awarded; activity 2026-08-13 | **Potential partner** | SC-res recy3we2U8HQUaOR6 ; LL-sem abroad.finance blog 2025-11-09 | high |
| **MoneyGram stablecoin app** | Colombia (launch market 2025-09), El Salvador (2026-04) | USDC stored-value account app with cash in/out at MoneyGram locations | Live per press | **Potential partner / competitor** for consumer last-mile | LL-sem pymnts 2025-09-17; finextra 2025-09-17; prnewswire 2026-04-22; x.com article 2026-04-24 | high (press), medium (current scope) |
| **Bitso** | COP in coverage list | Anchor with COP among MXN/BRL/ARS/USD (coverage asOf 2026-07-09) | Live | Potential partner | SC-proj coverage | medium (coverage field is indexer-derived) |
| **Meru** | Colombia-based | USD accounts for LatAm freelancers | Live; SCF 225,360 | Potential partner / adjacent | LL-dir based_in Colombia | high |
| **Loto Punto** | Colombia | Kiosk cash-in network | Live; SCF #34 | Potential partner | LL-dir based_in Colombia | medium |
| **Nauta Land** | Colombia | Real-estate tokenization (see (a)) | Live; SCF #21/#27 | Potential partner / competitor | LL-dir | high |
| **Providencia Onchain / Providencia Payment Rails** — viio.me — https://stellarlight.xyz/project/providencia-onchain | Providencia Island, Colombia | Transparency platform via Stellar Disbursement Platform; SCF #45/#46 "Payment Rails" proposals evaluate SDP embedded wallets and **COP off-ramp candidates** for resident/merchant payments | SCF #42 awarded 37,500; #45/#46 payment-rails submissions in progress; activity 2026-02-22 | Reference — a second Colombian team actively surveying COP off-ramp providers | SC-proj; SC-res https://communityfund.stellar.org/submissions/reckpaNIGOchULawj , …/rec2wEbian585bI9n | medium |
| **Enable (Humanity Link)** | Venezuela→Colombia | USDC aid/remittance with MoneyGram cash-out in Colombia (DRC, GOAL) | SCF #43/#45 proposals | Reference | SC-res | medium |
| **Anclap × FinClusive US→Colombia pilot** | US→Colombia | 2023 pilot: blockchain remittance US→CO at roughly half the cost (per SDF blog) | historical (2023-04-10) | Reference / precedent | LL-sem https://stellar.org/blog/ecosystem/blockchain-remittances-a-game-changer-for-cross-border-transfers | high (dated) |
| **"Innovating Colombia's Financial System"** (panel: SDF, Anclap, FinClusive, CAF) | Colombia | Panel on stablecoins for cross-border payments in Colombia | AV indexed 2026-04-28 | Reference — names the institutions already in the room | LL-sem https://www.youtube.com/watch?v=mwOUX-_V-Fw | medium |
| **PSE / Bre-B** | Colombia | PSE appears only inside VANK's proposal (COP deposits via PSE). **Bre-B** appears in **no** indexed project, proposal, article or video (directory + semantic + research passes) | — | **Gap** — no indexed Stellar project mentions Bre-B | LL-dir, LL-sem, SC-res (all off-target for Bre-B) | high (for this index) |

### Takeaways

- **Call first (Colombia rails):** VANK (SCF #43 COP anchor, PSE collection, B2B parent with real volume) and Abroad (USDC↔COP instant ramp + QR, Lobstr integration, open source, active Aug 2026). Both are Colombian-rooted and SCF-funded; neither has a consumer remittance product, so they are complements, not competitors.
- **Call first (FX lock):** Crebit is the only indexed Stellar project selling USDC-settled short-dated FX forwards (SCF #45 awarded). It cites BRL/NGN, not COP — a COP pair would be a new ask. No one has shipped a consumer locked-rate remittance on Stellar.
- **Cash last mile:** MoneyGram Access is already live in Colombia with a consumer USDC app (Sept 2025) and extended to El Salvador (Apr 2026); Bitso lists COP coverage. Anclap+FinClusive proved US→CO on Stellar in 2023 but Anclap's live assets are ARS/PEN.
- **Watch:** Nauta Land (Colombian property tokenizer, two SCF awards, low recent signal — partner or competitor depending on their inventory), Tokeshare (LatAm rental-property fractions, Soroban live), Urbanflip (SCF #45 in information-collection, large off-chain base), Providencia (second Colombian team scouting COP off-ramps in SCF #45/#46).
- **What nobody has built (per this index):** (1) a COP-pegged asset on Stellar (0 of 41 tracked stablecoins); (2) any Bre-B integration; (3) a down-payment / mortgage / diaspora home-purchase product for any LatAm country; (4) a hedged or locked-rate remittance for US→CO/MX/CA. The real-estate side of Stellar LatAm is investor-facing fractional tokens (Nauta, BWB, Tokeshare), not buyer financing.
- **Caveat:** SCF award totals disagree between Scout and Lumenloop for ~5 projects (likely requested-vs-paid); several "Live" rows have stale or null activity dates (Mica 2023, Nauta null, Félix null). Verify directly before relying on status.

---

## Build on — what we reuse as-is

| What | Role in Casa Puente | Source (Raven id → URL) | Version / date | License | Confidence |
|---|---|---|---|---|---|
| **soroban-sdk + stellar-cli** | `payment_plan` contract; `token::Client` for USDC SAC (no `contractimport!` needed) | `scout.searchResearch` (release) → https://github.com/stellar/rs-soroban-sdk/releases/tag/v28.0.0 ; https://github.com/stellar/stellar-cli/releases/tag/v28.1.0 | SDK v28.0.0 (2026-09-18, Protocol 28) / v27.0.6; CLI v28.1.0 (2026-09-26). Pin to live mainnet protocol — check `getVersionInfo` | not visible in Raven — verify at repo (SDF repos expected Apache-2.0) | medium (version), high (rule: SDK major = protocol) |
| **Stellar Asset Contract (USDC)** | The vault's token; `transfer` from buyer with `require_auth`, payout from contract balance with no extra auth | `stellarDocs` → https://developers.stellar.org/docs/tokens/stellar-asset-contract#contract-interface | docs 2026-09-08 | protocol feature | high |
| **OpenZeppelin `stellar-contracts`** crates (`stellar-access`, `stellar-contract-utils`, `stellar-macros`, `stellar-tokens`) | Ownable/AccessControl, `#[when_not_paused]`, `Upgradeable`/`UpgradeableMigratable`, TimelockController for admin; SEP-41 if a property token is ever needed | `scout.getRepoTrust`, `scout.listAudits` → https://github.com/OpenZeppelin/stellar-contracts ; audits https://stellarsecurityportal.com/report/2 , /report/35 | crates 0.7.2 (2026-06-09); last commit 2026-10-12; audits 2025-02-20 and 2025-07-09 (~460 days drift — pin an audited release) | not visible in Raven — verify LICENSE (expected MIT) | high (identity/audit), medium (license) |
| **Smart Account Kit + OpenZeppelin Smart Account** (fallback: `stellar/passkey-kit`) | D8 passkey wallet; policies/spending limits can express "may only call `apply_lock`/`deposit`" | `scout.searchRepos`, `skills.stellar-dev.dapp` → https://github.com/stellar/smart-account-kit ; https://github.com/stellar/passkey-kit ; https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets | both active 2026-09-18; secp256r1 since Protocol 21 (CAP-0051) | not visible in Raven — verify at repo | high |
| **OpenZeppelin Relayer / Stellar Channels** | Mandatory fee payer + tx source for C-account users (Launchtube retired) | `stellarDocs` → https://developers.stellar.org/docs/tools/openzeppelin-relayer ; https://github.com/OpenZeppelin/openzeppelin-relayer | last commit 2026-10-09; hosted testnet; prod = self-host (Docker) | not visible in Raven — verify at repo | high (status), medium (audit scope: none relayer-specific) |
| **`stellar/typescript-wallet-sdk`** | SEP-10/12/24/38 client code in the sending-anchor backend and deposit flow | `scout.searchRepos` → https://github.com/stellar/typescript-wallet-sdk | 4.0.1 (2026-08-21); <4.0 deprecated; Node ≥22 | not visible — verify (expected Apache-2.0) | high |
| **Anchor Platform** (run locally, testnet) | Receive-side **test counterparty** for our SEP-31 client; mirrors what a real receiving anchor publishes in `GET /info`. Not deployed for the send side. | `stellarDocs` → https://developers.stellar.org/docs/platforms/anchor-platform#supported-seps ; https://github.com/stellar/anchor-platform | 4.7.1 (2026-08-26); SEP-31 "receive only" | not visible — verify at repo | high |
| **`stellar/stellar-anchor-tests`** | Conformance-test any anchor we integrate | `scout.searchRepos` → https://github.com/stellar/stellar-anchor-tests | 0.6.22 (2026-06-05) | not visible — verify | high |
| **SDF test anchor** (testanchor.stellar.org) | Demo: SEP-1/10/6/24/12 confirmed in docs. **SEP-31/38 not confirmed** — demo the SEP-31 leg against a local Anchor Platform instead | `stellarDocs` → https://developers.stellar.org/docs/build/apps/wallet/sep10#basic-authentication | docs current | n/a (hosted) | medium / low (31/38) |
| **`soroban-examples` `timelock`** | Seed pattern for time-gated release (`release_due` requires `now >= due_ts`) | `stellarDocs` → https://developers.stellar.org/docs/build/smart-contracts/example-contracts/timelock | tag v23.0.0; repo active 2026-10-06 | not visible — verify (expected Apache-2.0) | high |
| **SEP-38 firm-quote semantics** (spec) | Price source for the on-chain leg; `POST /quote` with `expire_after`, `context: sep31`, `id` → `quote_id` | `scout.searchResearch` (sep) → https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md | v2.5.0 (2025-02-26), **still Draft** | spec | high |
| **Reflector FX oracle (SEP-40)** | Optional on-chain sanity band for `apply_lock` (reject rate >X% from `lastprice(Asset::Other("COP"))`); never the contractual rate | `stellarDocs` → https://developers.stellar.org/docs/data/oracles/oracle-providers ; `scout.searchResearch` (repo-docs) → https://github.com/Creit-Tech/Stellar-Indexer-SDK/blob/main/src/protocols/reflector/README.md | docs page 2026-10-16; FX address `CBKGP…MCJZC` is third-party evidence (snapshot 2026-07-08) — verify at Reflector | contract license not visible — verify | medium |
| **Stellar-RPC `getEvents` + own indexer** (or Hubble `history_contract_events`) | Receipt ingestion; RPC keeps ~7 days | `stellarDocs` → https://developers.stellar.org/docs/build/guides/events/ingest | retention 120,960 ledgers default | n/a | high |
| **KYT/sanctions screening service** (e.g. Scorechain-class) | Off-chain screening before `deposit` and `release`; no on-chain compliance oracle is production-grade | `scout.searchProjects` → https://stellarlight.xyz/project/scorechain | Live 2026-08-27 (community-aggregated) | commercial service | medium |

**Reference only (do not fork):** Trustless Work escrow (85/high, RV-audited 2025-09, **no license file** as of 2026-09-14), `LabsCrypt/flowfi` (milestone-gated streams, unaudited, license unverified), `devasignhq/bounty-escrow` (fork candidate only if its license checks out), Stellar Disbursement Platform (bulk payouts; its Transaction Submission Service is a good model for the `release-due` job), `stellar-demo-wallet` (SEP-31 sender-side sequence), Crebit (off-chain lock engine + treasury rebalancing checklist). **Do not reuse:** `XOXNO/rs-lending-xlm` (PolyForm Noncommercial), `django-polaris` and `sep31-demo-client` (archived), `lumen-later` (dormant).

## Build ourselves

| Component | Stellar features it depends on | Reuse inside it | Riskiest unknown |
|---|---|---|---|
| **`payment_plan`** (Soroban; lock fields inside per D10) | `token::Client` transfer with `payer.require_auth()` consumed by *our* entrypoint (replay guard); `persistent()` per-installment keys + `instance()` config; `extend_ttl` bump-on-access + keeper (`ExtendFootprintTTLOp`, max TTL ≈180 days); `#[contractevent]` (publish deprecated; 16 KB/tx cap); `env.ledger().timestamp()` (~5 s, day-granularity due dates); `update_current_contract` upgrade + versioned `migrate`; testutils `mock_auths`, `set_timestamp`, `register_stellar_asset_contract_v2` | OZ access/pausable/upgradeable/Timelock; timelock example | **Who holds upgrade/admin authority over a contract that custodies buyer funds for 24–36 months** (single operator vs multisig/timelock vs renounced) and the TTL-keeper funding; secondary: SDK 27 vs 28 pin, `update_current_contract` vs `_wasm` naming conflict between docs and skill |
| **`deposit_order`** (buyer USD → USDC into vault; SEP-24 interactive hidden) | US anchor SEP-24 deposit; SEP-45 (Draft) for C-address auth *or* app-controlled G-account fallback doing SEP-10 + SEP-24 then forwarding to the C-address (needs sponsored reserves + USDC trustline); relayer for fees | `typescript-wallet-sdk`, Smart Account Kit, OZ Relayer | **No Raven row shows a US anchor with an explicit bank-ACH on-ramp** (FinClusive is the only US on-ramp row, rails unspecified; MoneyGram is cash-only) — and whether that anchor enables SEP-45 |
| **`rate_lock`** (engine off-chain; `apply_lock` on-chain; separate contract deferred per §13) | Operator + buyer dual `require_auth`; signed quote with **expiry and nonce inside the signed payload** (Moonlight audit B6), verified with `ed25519_verify`; staleness check on any oracle read (≤2–3× 300 s); `temporary()` storage with TTL aligned to quote expiry for pending quotes; SEP-38 firm quote for the anchor leg | Reflector SEP-40 COP feed (sanity band only); SEP-53 message signing; Crebit's settlement safety checklist | **No oracle exposes the TRM**, so the NDF fixing basis vs. the anchor's rate is purely off-chain reconciliation; Reflector's COP address is unverified third-party evidence; legal status of the buyer-facing lock (§12 Q2) |
| **`project_escrow`** (Fiducia Abierta, later; vault kept general) | Milestone/refund state machine; `resolve_dispute(distributions)`-style settlement; TimelockController for arbiter actions | Trustless Work interface as *design* reference only (no license); OZ Timelock; `bounty-escrow` if licensed | **No licensed, audited, maintained milestone-escrow code exists to fork** — Trustless Work is audited but unlicensed; everything else is unaudited and license-unverified |
| **Sending-anchor backend** | SEP-1 discovery → SEP-10 (register our signing key as custodial client) → SEP-12 `PUT /customer` for sender *and* receiver (receiver needs banking fields) → SEP-38 `POST /quote` (`context: sep31`, `buy_delivery_method` = receiver's `funding_methods`) → SEP-31 `POST /transactions` (`funding_method`, not deprecated `fields`) → pay `stellar_account_id` **with `stellar_memo`** once `pending_sender` → signed-callback verification (SIGNING_KEY + timestamp) + polling; `pending_customer_info_update` repair loop; `expired`/`refunded` handling | `typescript-wallet-sdk`; Anchor Platform as local counterparty; `stellar-demo-wallet` as sequence reference; SDP TSS pattern for retries/idempotency | **No confirmed live SEP-31 receiving anchor paying COP** (Bitso SEP list unpublished; VANK is SEP-6/24/38 with PSE in / ACH out) — plus who is the licensed sending business (§12 Q6); design a SEP-6/24 `withdraw-exchange` fallback |
| **Lock calendar UI** (React) + receipts | `/plans/:id` from our indexer, not RPC (events retained ~7 days); passkey + relayer flow for "accept lock"; SEP-24 webview embedding | Smart Account Kit session/connect; SDP Embedded Wallets as onboarding reference | **SEP-7 `web+stellar:pay` cannot target a C-address or a Soroban call** — "scan to pay" must be an app deep link; receipts need the indexer live before the first `release_due` |

## Top 5 open questions for humans

1. **Receiving anchor (Colombia):** Which anchor will accept our SEP-31 (or SEP-6/24 withdraw-exchange) and pay COP into a fiduciary account, over which rail (PSE, Bre-B, bank credit)? Does its `stellar.toml` advertise `DIRECT_PAYMENT_SERVER`, `ANCHOR_QUOTE_SERVER` and `WEB_AUTH_FOR_CONTRACTS_ENDPOINT` (SEP-45)? Candidates to call: VANK, Abroad, Bitso. (Raven: no COP SEP-31 anchor confirmed; no Bre-B integration indexed anywhere.)
2. **US on-ramp + licensed sender:** Which US anchor offers a bank-ACH SEP-24 deposit for US-resident buyers (FinClusive is the only US on-ramp row; MoneyGram is cash-only), and who is the licensed MSB/sending business in pilot — the US anchor partner or the MSB named in §12 Q6? The ecosystem expectation is that the sender is the regulated party doing its own KYC/AML/sanctions screening.
3. **Davivienda treasury (D5):** Minimum NDF size, spread, booking cadence and COP settlement to the fiduciary account — and is a TRM fixing against an anchor converting at its own SEP-38 rate an acceptable basis for them, given no on-chain TRM exists and Reflector's COP is a market aggregate?
4. **Counsel + Circle:** Is the buyer-facing locked rate a derivative under US or Colombian rules (§12 Q2)? Separately, read Circle's USDC issuer flags on-chain (`AUTH_REVOCABLE` / `AUTH_CLAWBACK_ENABLED` not found in any source) — if set, the SAC admin can freeze or claw back the vault balance, which must be disclosed and handled.
5. **Custody governance:** Who holds the `payment_plan` admin/upgrade keys and the TTL-keeper/relayer fee accounts for a contract that custodies buyer USDC for 24–36 months — single operator, multisig, or timelocked multisig — and does that choice change the "tokenized deposit infrastructure" framing in D9?

## Query log — every Raven query run in this pass

Grouped by section. `search` = `mcp__stellar-raven__search` catalog discovery; `execute` = operations and inputs run inside `mcp__stellar-raven__execute` scripts (verbatim query strings / arguments). None contain client, person, counterparty, amount, contract or key identifiers; the only named entities are public Stellar-ecosystem projects, anchors and standards.

### Section 1. Soroban core

Raven `search` calls (query strings, verbatim):
- `soroban contract docs search` (service=stellarDocs, limit=12)
- `research release notes sdk` (service=scout, limit=10)
- `smart contracts development` (kind=skill, limit=10)
- `repos search` (service=scout, limit=6)

Raven `execute` scripts — operations and their query strings / inputs, verbatim:
- `codemode.skill.read("skills.stellar-dev.smart-contracts", { sections: ["versions", "platform-constraints"] })`
- `scout.searchResearch({ q: "soroban-sdk release notes breaking changes", source: "release", limit: 8 })`
- `scout.searchResearch({ q: "stellar-cli release notes latest version", source: "release", limit: 6 })`
- `stellarDocs.search_soroban_contract_docs({ query: "token client transfer require_auth Stellar Asset Contract from contract", hitsPerPage: 4, includeContent: true })`
- `stellarDocs.search_asset_token_docs({ query: "Stellar Asset Contract transfer require_auth contract invoke token::Client", hitsPerPage: 4, includeContent: true })`
- `stellarDocs.search_soroban_contract_docs({ query: "custom account __check_auth signature verification", hitsPerPage: 4 })`
- `stellarDocs.search_soroban_contract_docs({ query: "secp256r1 passkey smart wallet verify_sig_ecdsa_secp256r1", hitsPerPage: 3 })`
- `stellarDocs.search_soroban_contract_docs({ query: "cross contract call contractimport client", hitsPerPage: 4 })`
- `stellarDocs.search_soroban_contract_docs({ query: "persistent instance temporary storage TTL extend_ttl", hitsPerPage: 4 })`
- `stellarDocs.search_soroban_contract_docs({ query: "state archival archived entries restore persistent", hitsPerPage: 3 })`
- `stellarDocs.search_docs({ query: "maximum TTL max_entry_ttl ledgers rent fee", hitsPerPage: 4 })`
- `stellarDocs.search_soroban_contract_docs({ query: "events publish topics data limits", hitsPerPage: 4 })`
- `stellarDocs.search_rpc_horizon_data_docs({ query: "getEvents retention window ledgers events", hitsPerPage: 4 })`
- `stellarDocs.search_docs({ query: "RPC event retention 7 days ledgers history", hitsPerPage: 4 })`
- `stellarDocs.search_soroban_contract_docs({ query: "env.ledger().timestamp() ledger close time seconds", hitsPerPage: 4 })`
- `stellarDocs.search_soroban_contract_docs({ query: "update_current_contract_wasm upgrade contract", hitsPerPage: 4 })`
- `stellarDocs.search_soroban_contract_docs({ query: "mock_all_auths mock_auths testutils", hitsPerPage: 4 })`
- `stellarDocs.search_soroban_contract_docs({ query: "ledger().set timestamp sequence_number testutils LedgerInfo", hitsPerPage: 4 })`
- `codemode.skill.read("skills.stellar-dev.smart-contracts", { sections: ["file:development.md"] })`
- `scout.searchResearch({ q: "soroban-sdk v27 breaking changes migration guide protocol 27", sources: ["release", "dev-docs"], perSource: 6 })`
- `scout.searchResearch({ q: "stellar-cli v28 release notes breaking changes", source: "release", limit: 6 })`
- `scout.searchResearch({ q: "secp256r1 signature verification host function passkeys WebAuthn", source: "cap", limit: 4 })`
- `scout.searchResearch({ q: "contract events retention window RPC getEvents how long", sources: ["dev-docs", "release"], perSource: 5 })`
- `scout.searchResearch({ q: "maximum entry TTL ledgers persistent storage rent fee per ledger", source: "dev-docs", limit: 6 })`
- `stellarDocs.get_doc_page_sections({ path: "/docs/learn/fundamentals/contract-development/storage/state-archival" })`
- `stellarDocs.get_doc_page_sections({ path: "/docs/learn/fundamentals/contract-development/events" })` (soft-empty — wrong path)
- `stellarDocs.search_soroban_contract_docs({ query: "ledger timestamp sequence close time env.ledger()", hitsPerPage: 5 })`
- `stellarDocs.search_soroban_contract_docs({ query: "timelock deposit token transfer current_contract_address claim", hitsPerPage: 4 })`
- `stellarDocs.search_docs({ query: "token::Client transfer from require_auth contract address spender allowance transfer_from", hitsPerPage: 5 })`
- `stellarDocs.get_doc_page_sections({ path: "/docs/build/guides/contract-accounts/smart-wallets" })`
- `stellarDocs.search_docs({ query: "getEvents startLedger retention \"7 days\"", hitsPerPage: 5 })`
- `stellarDocs.search_docs({ query: "testutils Ledger set LedgerInfo timestamp sequence_number", hitsPerPage: 5 })`
- `stellarDocs.search_docs({ query: "mock_auths MockAuth MockAuthInvoke", hitsPerPage: 4 })`
- `codemode.skill.read("skills.stellar-dev.data", { sections: ["stellar-rpc"] })`
- `scout.searchResearch({ q: "rs-soroban-sdk 28.0.0 breaking changes contracttype contractimport spec shaking migration", source: "release", limit: 8 })`
- `scout.searchResearch({ q: "rs-soroban-sdk v28.1 v28.0.1 release", source: "release", limit: 8 })`
- `scout.searchResearch({ q: "update_current_contract_wasm deprecated update_current_contract ContractExecutable", sources: ["release", "dev-docs"], perSource: 4 })`
- `stellarDocs.search_doc_titles({ query: "events", hitsPerPage: 8 })`
- `stellarDocs.search_docs({ query: "ledger timestamp \"unix\" seconds close contract env.ledger", hitsPerPage: 5 })`
- `stellarDocs.search_protocol_concepts_docs({ query: "ledger close time timestamp 5 seconds ledgers", hitsPerPage: 4 })` (soft-empty)
- `stellarDocs.search_docs({ query: "event topics maximum four topics data size limit", hitsPerPage: 5 })`
- `stellarDocs.search_docs({ query: "with_mut timestamp ledger test set_timestamp testutils", hitsPerPage: 5 })`
- `codemode.skill.read("skills.stellar-dev.smart-contracts", { sections: ["file:testing.md"] })`
- `scout.searchResearch({ q: "rs-soroban-sdk v28.0.0 Breaking changes spec shaking CAP-86 contracttype extra missing fields", source: "release", limit: 10 })`
- `stellarDocs.get_doc_page_sections({ path: "/docs/learn/fundamentals/stellar-data-structures/events" })`

### Section 2. Anchors

`search` calls (Raven catalog discovery):
- SEP-31 cross-border payments receiving anchor
- anchor directory project details  (service: lumenloop)
- search projects anchors stablecoins research  (service: scout)
- anchor platform SEP-24 SEP-38 quotes docs  (service: stellarDocs)
- anchor integration SEP standards playbook  (kind: skill)

`execute` script inputs (operation → query / input), in run order:
- scout.searchResearch(source:"sep") → "SEP-0006 deposit withdrawal API status version"
- scout.searchResearch(source:"sep") → "SEP-0024 hosted deposit withdrawal status version"
- scout.searchResearch(source:"sep") → "SEP-0031 cross-border payments status version"
- scout.searchResearch(source:"sep") → "SEP-0038 anchor RFQ API status version"
- stellarDocs.search_anchor_sep_docs → "SEP-31 cross-border payments vs SEP-24 hosted deposit which to use"
- codemode.skill.read("skills.stellar-dev.standards", sections: ["high-value-seps-for-app-developers","quick-mapping-by-use-case"])
- scout.searchResearch(source:"sep") → "SEP-31 sending anchor calls receiving anchor POST /transactions request fields sender_id receiver_id quote_id"
- scout.searchResearch(source:"sep") → "SEP-31 KYC SEP-12 customer types sender receiver fields transaction required info"
- scout.searchResearch(source:"sep") → "SEP-31 transaction status pending_sender pending_receiver completed callback status polling memo"
- scout.searchResearch(source:"sep") → "SEP-31 sending anchor is a business or financial institution not an end user"
- stellarDocs.search_anchor_sep_docs → "SEP-31 receiving anchor flow sending anchor SEP-12 KYC"
- scout.searchResearch(source:"sep") → "SEP-38 GET /prices GET /price indicative quotes endpoints"
- scout.searchResearch(source:"sep") → "SEP-38 POST /quote firm quote expire_after expires_at GET /quote/:id"
- scout.searchResearch(source:"sep") → "SEP-38 quote_id used in SEP-31 POST /transactions and SEP-24 and SEP-6 requests"
- stellarDocs.search_anchor_sep_docs → "SEP-38 quotes firm indicative expires_at Anchor Platform"
- stellarDocs.search_anchor_sep_docs → "Anchor Platform what is it supported SEPs"
- stellarDocs.search_anchor_sep_docs → "Anchor Platform deploy docker kubernetes helm getting started"
- stellarDocs.search_anchor_sep_docs → "Anchor Platform sending anchor SEP-31 send receive role"
- scout.searchProjects → q:"anchor platform"
- scout.searchResearch(source:"repo-docs") → "Anchor Platform java-stellar-anchor-sdk license Apache open source"
- lumenloop.search_directory → "Bitso"
- lumenloop.search_directory → "VANK"
- lumenloop.search_directory → "Colombia"
- scout.searchProjects → q:"Bitso"
- scout.searchProjects → q:"VANK"
- scout.getPartners → q:"colombia", all:"1"
- scout.getPartners → q:"united states ACH", ramps:"on-ramp", all:"1"
- stellarDocs.search_anchor_sep_docs → "anchor licensed money transmitter regulated financial institution compliance"
- scout.searchResearch(source:"sep") → "SEP-31 sending anchor must be regulated licensed money services business compliance obligations"
- scout.searchResearch(sources:["dev-docs","sdf-blog"]) → "anchors are regulated entities money transmitter license AML KYC obligations"
- stellarDocs.search_docs → "testanchor.stellar.org"
- stellarDocs.search_docs → "test anchor testnet SEP-24 SEP-6 demo wallet"
- scout.searchResearch(source:"sep") → "SEP-31 Abstract: payments between two financial accounts at different anchors; Sending Anchor and Receiving Anchor are businesses"
- scout.searchResearch(source:"sep") → "SEP-31 POST /transactions request parameters amount asset_code asset_issuer destination_asset quote_id sender_id receiver_id funding_method refund_memo"
- scout.searchResearch(source:"sep") → "SEP-31 GET /info receive asset fields transaction sep12 sender receiver types"
- scout.searchResearch(source:"sep") → "SEP-31 Changelog v3.1.0 v3.0.0 v2 removed fields transaction added funding_methods"
- scout.searchResearch(source:"sep") → "SEP-31 transaction status pending_external completed refunded error expired status callback"
- scout.searchResearch(source:"sep") → "SEP-38 POST /quote request body sell_asset buy_asset sell_amount expire_after context sep6 sep24 sep31"
- scout.searchResearch(source:"sep") → "SEP-38 firm quote the anchor commits to the price until expires_at indicative price GET /prices"
- scout.searchResearch(source:"sep") → "SEP-38 GET /prices request sell_asset sell_amount sell_delivery_method buy_delivery_method country_code"
- scout.searchResearch(source:"sep") → "SEP-38 Changelog v2.5.0 v2.4.0"
- codemode.search → query:"search repositories github", service:"scout"
- stellarDocs.get_doc_page_sections → path:"/docs/platforms/anchor-platform"
- stellarDocs.get_doc_page_sections → path:"/docs/platforms/anchor-platform/admin-guide/getting-started"
- stellarDocs.search_docs → "\"send-side\" OR \"sending anchor\" Anchor Platform"
- scout.searchResearch(sources:["repo-docs","dev-docs","sdf-blog"]) → "stellar anchor platform repository license Apache 2.0 java spring docker image"
- lumenloop.get_project → slug:"bitso"
- lumenloop.get_project → slug:"vank"
- lumenloop.get_scf_submissions → slug:"vank"
- scout.getPartners → type:"anchor", region:"latam", all:"1"
- scout.getPartners → region:"north-america", ramps:"on-ramp", all:"1"
- scout.searchProjects → type:"Anchor", limit:40
- lumenloop.search_content_semantic → "Colombia COP USDC anchor off-ramp PSE Bre-B bank transfer Stellar"
- stellarDocs.get_doc_page_sections → path:"/docs/learn/fundamentals/anchors"
- stellarDocs.search_docs → "testanchor SEP-6 SEP-24 SEP-31 SEP-38 SRT reference server"
- stellarDocs.search_docs → "MoneyGram Ramps integrate SEP-24 SEP-38 US cash"
- scout.searchProjects → q:"Alfred"
- stellarDocs.search_docs → "Stellar Disbursement Platform send payments anchor SEP-31 vs SDP"
- scout.searchResearch(source:"sep") → "SEP-31 Abstract Sending Anchor Receiving Anchor Sending Client Receiving Client definitions business entity"
- scout.searchResearch(source:"sep") → "SEP-31 POST /transactions request table sender_id receiver_id quote_id destination_asset funding_method refund_memo lang required"
- scout.searchResearch(source:"sep") → "SEP-31 POST /transactions response stellar_account_id stellar_memo stellar_memo_type Sending Anchor must include memo payment"
- scout.searchResearch(source:"sep") → "SEP-31 callback URL Sending Anchor notified status change Signature header"
- scout.searchResearch(source:"sep") → "SEP-31 Sending Anchor Asset Conversion Stellar Network Asset Conversion Receiving Anchor Asset Conversion quote_id"
- scout.searchResearch(source:"sep") → "SEP-38 POST /quote request table context sep6 sep24 sep31 expire_after The client's desired expires_at value"
- scout.searchResearch(source:"sep") → "SEP-38 GET /quote/:id fetch previously provided firm quote expired"
- scout.searchResearch(source:"sep") → "SEP-38 Motivation firm quote anchor commits to exchange rate for period; wallets request quotes before SEP-6 SEP-24 SEP-31 transactions"
- scout.searchResearch(source:"sep") → "SEP-38 GET /prices request sell_asset sell_amount buy_delivery_method country_code response buy_assets"
- stellarDocs.get_doc_page_sections → path:"/docs/platforms/anchor-platform/admin-guide/architecture"
- stellarDocs.search_anchor_sep_docs → "Anchor Platform docker image kubernetes helm production deployment database postgres kafka"
- scout.searchResearch(sources:["repo-docs","dev-docs","sdf-blog","release"]) → "anchor platform repository README license Apache License 2.0 stellar/anchor-platform java-stellar-anchor-sdk"
- stellarDocs.search_docs → "\"testanchor.stellar.org\""
- lumenloop.search_content_semantic → "SDF test anchor testanchor.stellar.org reference anchor SRT asset SEP-6 SEP-24 SEP-31 demo wallet"
- scout.getPartners → q:"united states", all:"1"
- scout.getPartners → q:"ACH", all:"1"
- scout.searchProjects → q:"MoneyGram"
- scout.searchProjects → q:"ACH bank account USD on-ramp"
- scout.searchResearch(sources:["sdf-blog","dev-docs","scf-handbook"]) → "anchor must be a licensed money services business money transmitter license regulatory compliance before operating"
- stellarDocs.search_docs → "anchor regulatory license compliance legal requirements jurisdiction"
- stellarDocs.search_docs → "Integrate with MoneyGram Ramps"
- scout.searchResearch(source:"sep") → "SEP-31 POST transactions `quote_id` (optional) The id returned from a SEP-38 POST /quote response `destination_asset` `funding_method`"
- scout.searchResearch(source:"sep") → "SEP-31 `sender_id` (optional) The ID included in the SEP-12 PUT /customer response for the Sending Client `receiver_id` `refund_memo` `lang`"
- scout.searchResearch(source:"sep") → "SEP-38 POST quote `context` string The context for what this quote will be used for. Must be one of sep6 sep24 sep31"
- stellarDocs.search_docs → "testanchor SRT USDC testnet anchor supports SEP-6 SEP-24 SEP-31 SEP-38 sandbox"
- stellarDocs.get_doc_page_sections → path:"/docs/platforms/anchor-platform/admin-guide/getting-started"

### Section 3. Rate lock building blocks

Raven `search` queries (verbatim):
- reflector oracle skill
- SCF submissions proposals search
- stablecoins listing  [service=scout]
- path payment strict send receive docs  [service=stellarDocs]
- price oracle SEP-40
- oracle price feed Soroban  [kind=skill]
- search repos GitHub  [service=scout]
- project details get project  [service=scout]

Raven `execute` call inputs (verbatim query strings / inputs):
- codemode.skill.read("skills.lumenloop.stellar-integration-finder", {sections:["worked-example-what-oracle-should-i-use-to-read-prices-on-stellar"]})
- scout.searchProjects({type:"Oracle", limit:20, fields:"name,slug,shortDescription,status,scfAwarded,scfTotalAwardedUSD,links,repos,supportedNetworks,url"})
- scout.searchProjects({q:"Reflector oracle", limit:3})
- scout.searchResearch({q:"SEP-40 price oracle interface lastprice", sources:["sep","dev-docs","repo-docs"], perSource:4})
- stellarDocs.search_rpc_horizon_data_docs({query:"oracles price feed", hitsPerPage:6})
- scout.searchResearch({q:"Reflector oracle fiat currency feeds update frequency Soroban contract read price", limit:8})
- scout.searchResearch({q:"oracle fiat exchange rates COP Colombian peso TRM Stellar", limit:8})
- lumenloop.search_directory({query:"oracle", limit:15})
- stellarDocs.get_doc_page_sections({path:"/docs/data/oracles/oracle-providers", includeContent:true})  (x3)
- scout.searchProjects({q:"Lightecho", limit:2})
- scout.searchResearch({q:"SEP-40 PriceFeedTrait lastprice price resolution decimals base asset", source:"sep", limit:4})
- scout.searchResearch({q:"oracle feed Colombian peso COP exchange rate on Stellar", sources:["repo-docs","dev-docs","sdf-blog","lumenloop"], perSource:4})
- scout.searchResearch({q:"Lightecho oracle supported FX currencies emerging markets", sources:["repo-docs","scf-proposal"], perSource:4})
- scout.searchResearch({q:"Reflector oracle contract public feeds fx rates retention period resolution update every 5 minutes", sources:["repo-docs","scf-proposal","lumenloop"], perSource:4})
- codemode.artifact.read("e2c115fd-670b-4c33-b1d3-e5626250251e"); codemode.artifact.read("39132462-d0a3-4fd0-9430-fb7fa32198a2")
- scout.searchResearch({q:"Reflector FX oracle base asset USD fiat currencies list EUR GBP MXN BRL COP ARS", source:"repo-docs", limit:6})
- scout.searchResearch({q:"Reflector oracle contract interface lastprice twap resolution retention period timeframe update frequency", sources:["repo-docs","dev-docs"], perSource:5})
- scout.searchResearch({q:"rate lock remittance locked exchange rate", source:"scf-proposal", limit:10})
- scout.searchResearch({q:"FX lock forward contract hedge remittance", source:"scf-proposal", limit:10})
- scout.searchResearch({q:"lock the exchange rate for a cross-border payment hedged pricing", source:"scf-proposal", limit:8})
- scout.searchResearch({q:"FX forward hedging treasury stablecoin corridor", source:"scf-proposal", limit:8})
- lumenloop.find_similar_scf_submissions({query:"rate lock locked exchange rate remittance", round:"SCF #45", limit:10})
- lumenloop.find_similar_scf_submissions({query:"FX hedge forward remittance", round:"SCF #45", limit:10})
- lumenloop.find_similar_scf_submissions({query:"rate lock FX hedge remittance locked exchange rate", limit:12})
- scout.searchProjects({q:"rate lock FX hedge", limit:8, fields:"name,slug,shortDescription,status,scfAwarded,scfAwardedRounds,scfTotalAwardedUSD,links,repos,url"})
- lumenloop.search_content_semantic({query:"FX rate lock remittance Stellar", types:["scf_submissions","articles"], limit:6, response_format:"concise"})
- scout.getStablecoins({peg:"COP", limit:20}); scout.getStablecoins({limit:100})
- scout.searchProjects({q:"Colombia", limit:15, fields:"name,slug,shortDescription,status,types,category,scfAwarded,links,url,supportedNetworks"})
- scout.searchProjects({q:"COP peso", limit:10, fields:"name,slug,shortDescription,status,types,category,links,url"})
- lumenloop.search_directory({query:"Colombia", limit:15})
- stellarDocs.search_protocol_concepts_docs({query:"path payment strict send strict receive", hitsPerPage:6})
- stellarDocs.search_docs({query:"pathPaymentStrictSend destMin sendAmount", hitsPerPage:6})
- stellarDocs.search_protocol_concepts_docs({query:"liquidity pools order book SDEX AMM", hitsPerPage:5})
- stellarDocs.search_docs({query:"\"strict-send\" paths Horizon", hitsPerPage:6})
- scout.searchResearch({q:"time-bounded signed quote verified on-chain Soroban ed25519 verify expiry ledger timestamp", sources:["dev-docs","repo-docs","sep","audit"], perSource:5})
- stellarDocs.search_soroban_contract_docs({query:"ledger timestamp sequence env.ledger() expiration", hitsPerPage:5})
- stellarDocs.search_soroban_contract_docs({query:"ed25519_verify signature verification crypto", hitsPerPage:5})
- scout.searchResearch({q:"SEP-38 firm quote expires_at anchor RFQ locked price", source:"sep", limit:4})
- scout.searchResearch({q:"Reflector FX oracle base asset USD fiat currencies EUR GBP MXN BRL ARS PEN CLP CRC COP", source:"repo-docs", limit:3})
- scout.searchResearch({q:"Reflector fetchOraclesData assets base_asset decimals resolution period timing parameters protocol version", source:"repo-docs", limit:4})
- scout.searchResearch({q:"Lightecho oracle contract mainnet address supported currencies update interval SEP-40 lastprice", sources:["repo-docs","scf-proposal"], perSource:3})
- scout.searchResearch({q:"DIA oracle Stellar supported assets Band standard reference Soroban get_reference_data symbols fiat", source:"dev-docs", limit:5})
- scout.searchResearch({q:"Crebit Rate Locks SCF #45 programmable rate-lock layer stablecoin FX forwards", source:"scf-proposal", limit:8})
- scout.searchResearch({q:"Crebit Rate Locks award round status award type requested budget", source:"scf-proposal", limit:6})
- lumenloop.get_scf_submissions({slug:"crebit-pay"})  (x3)
- lumenloop.get_project({slug:"crebit-pay", compact:true})
- scout.searchProjects({q:"Crebit", limit:3})
- scout.searchRepos({q:"crebit rate lock", limit:8})
- lumenloop.find_similar_scf_submissions({slug:"rec5LpAd2YYGkMTnZ", limit:5})
- scout.searchProjects({q:"VANK", limit:2, fields:"name,slug,shortDescription,status,scfAwardedRounds,scfTotalAwardedUSD,links,repos,url,types"})
- scout.searchResearch({q:"Upesa onchain FX stablecoin currency swap", source:"scf-proposal", limit:3})
- scout.searchProjects({q:"OrbitCDP", limit:2, fields:"name,slug,shortDescription,status,scfAwardedRounds,links,repos,url"})
- lumenloop.search_content_semantic({query:"Colombian peso COP stablecoin or anchor on Stellar", types:["articles","scf_submissions","research"], limit:6, response_format:"concise"})
- scout.searchProjects({type:"Anchor", q:"Colombia COP", limit:10, fields:"name,slug,shortDescription,status,anchorProfile,links,url"})
- scout.searchProjects({q:"Bitso", limit:1, fields:"name,slug,shortDescription,status,anchorProfile,links,url,statusAsOf"})
- stellarDocs.get_doc_page_sections({path:"/docs/learn/fundamentals/transactions/list-of-operations", includeContent:true})
- stellarDocs.get_doc_page_sections({path:"/docs/build/apps/example-application-tutorial/querying-data", includeContent:true})
- stellarDocs.search_soroban_contract_docs({query:"ledger timestamp sequence env.ledger()", hitsPerPage:5})
- stellarDocs.search_soroban_contract_docs({query:"ed25519_verify signature", hitsPerPage:5})
- stellarDocs.get_doc_page_sections({path:"/docs/build/guides/storage/storage-strategies", includeContent:true})
- scout.searchResearch({q:"SEP-38 firm quote expires_at POST quote stored by anchor price locked", sources:["sep","dev-docs"], perSource:3})
- scout.searchResearch({q:"valid_until_ledger not covered by signature provider quote deadline", source:"audit", limit:3})
- scout.searchRepos({q:"signed quote ed25519 verify expiry soroban", limit:8}); same with limit:6, fields:"fullName,url,primaryLanguage,description,lastCommitAt,repoScore"  (x2)
- scout.searchRepos({q:"forward contract FX hedge soroban", limit:8}); same with limit:6, fields:"…"  (x2)
- scout.searchResearch({q:"Crebit rate-lock USDC-settled forwards premium collateral settlement Soroban contract architecture", source:"scf-proposal", limit:10})
- scout.searchResearch({q:"VANK Anchor Colombia USDC COP on/off ramp PSE SEP-24 SEP-38", source:"scf-proposal", limit:6})
- scout.searchResearch({q:"FX Swap by Hedgehog foreign currency borrowing", source:"scf-proposal", limit:3})
- lumenloop.search_directory({query:"COP", limit:10}); lumenloop.search_directory({query:"peso", limit:10})
- scout.searchResearch({q:"PriceFeedTrait interface lastprice price prices resolution decimals base assets", source:"sep", limit:3})  (x2)
- scout.explainRepo({q:"What public functions does the price oracle contract expose (e.g. lastprice, price, prices, twap, resolution, decimals, base, assets, period), how is price staleness handled, and what license does the repository use?", repo:"reflector-network/reflector-contract"})  (x2)
- stellarDocs.search_docs({query:"\"/paths/strict-send\"", hitsPerPage:5})  (x2)
- scout.searchResearch({q:"valid_until_ledger not covered by provider signature deadline replay", source:"audit", limit:2})  (x2)
- scout.searchResearch({q:"maximum allowed staleness caller-supplied timestamp oracle price delay", source:"audit", limit:3})  (x2)
- stellarDocs.get_doc_page_sections({path:"/docs/build/guides/contract-accounts/advanced-patterns", includeContent:true})  (x2)
- stellarDocs.get_doc_page_sections({path:"/docs/data/analytics/hubble/data-catalog/data-dictionary/silver/reflector-prices-data-fex-snapshot", includeContent:true})
- scout.searchResearch({q:"Horizon strict send payment paths endpoint source_asset_type source_amount destination_assets destination_account", source:"dev-docs", limit:5})
- scout.searchResearch({q:"Band standard reference contract Soroban get_reference_data symbols fiat currencies supported", sources:["repo-docs","dev-docs"], perSource:3})
- lumenloop.get_scf_submissions({name:"Hedgehog"})
- scout.searchResearch({q:"Lightecho oracle fiat currency list Colombian peso", sources:["repo-docs","scf-proposal"], perSource:3})

### Section 4. Wallet UX

Raven `search` queries (verbatim):
- passkey smart wallet secp256r1 WebAuthn contract account
- fee bump transaction sponsored reserves relayer
- SEP-7 payment URI web+stellar QR code
- SEP-45 web authentication contract accounts anchor platform SEP-10
- wallet passkey skill  (kind=skill)
- repositories audits projects search  (service=scout)

Raven `execute` scripts — operation inputs (verbatim):
- scout.searchRepos {q:"passkey-kit", limit:8}
- scout.searchRepos {q:"smart wallet passkey secp256r1 webauthn", limit:10}
- scout.searchRepos {q:"openzeppelin stellar contracts", limit:8}
- scout.searchRepos {q:"passkey smart account", language:"TypeScript", limit:8}
- codemode.skill.read("skills.stellar-dev.dapp", {sections:["file:smart-accounts.md"]})  (run twice)
- stellarDocs.search_wallet_dapp_docs {query:"smart wallet passkey", hitsPerPage:10}
- stellarDocs.search_wallet_dapp_docs {query:"passkey-kit launchtube guestbook", hitsPerPage:10}
- stellarDocs.search_docs {query:"secp256r1 CAP-0051 protocol 21", hitsPerPage:8}
- stellarDocs.search_soroban_contract_docs {query:"custom account contract __check_auth", hitsPerPage:8}
- stellarDocs.search_protocol_concepts_docs {query:"fee-bump transaction", hitsPerPage:8}
- stellarDocs.search_protocol_concepts_docs {query:"sponsored reserves begin sponsoring future reserves", hitsPerPage:8}
- stellarDocs.search_sdk_cli_tools_docs {query:"OpenZeppelin relayer channel accounts", hitsPerPage:8}
- stellarDocs.search_docs {query:"launchtube", hitsPerPage:6}
- scout.searchRepos {q:"relayer fee sponsorship paymaster", limit:8}
- scout.searchRepos {q:"launchtube", limit:6}
- stellarDocs.search_docs {query:"SEP-7 web+stellar pay URI", hitsPerPage:10}
- stellarDocs.search_docs {query:"\"SEP-0007\" OR \"SEP-7\" deep link QR", hitsPerPage:8}
- codemode.skill.read("skills.stellar-dev.standards", {sections:["high-value-seps-for-app-developers","quick-mapping-by-use-case"]})
- stellarDocs.search_anchor_sep_docs {query:"SEP-45 contract account authentication", hitsPerPage:10}
- stellarDocs.search_docs {query:"SEP-45", hitsPerPage:10, includeMeetings:true}
- stellarDocs.search_anchor_sep_docs {query:"SEP-10 web authentication client domain memo", hitsPerPage:8}  (soft-empty)
- stellarDocs.search_docs {query:"SEP-30 account recovery", hitsPerPage:8}
- stellarDocs.search_wallet_dapp_docs {query:"recovery signer recoverysigner", hitsPerPage:8}
- scout.searchRepos {q:"recoverysigner SEP-30 recovery", limit:8}
- scout.searchProjects {q:"embedded wallet", limit:10}
- scout.searchProjects {q:"albedo", limit:5}
- lumenloop.search_content_semantic {query:"embedded wallet passkey smart account onboarding Stellar non-custodial", types:["articles","research"], limit:6, response_format:"concise"}
- codemode.search {query:"doc page sections", service:"stellarDocs", limit:5}
- codemode.search {query:"repo detail license", service:"scout", limit:6}
- stellarDocs.search_docs {query:"smart wallets contract accounts guide", hitsPerPage:12, includeContent:true}
- stellarDocs.search_docs {query:"\"smart wallets\" tooling retired launchtube", hitsPerPage:8, includeContent:true}
- stellarDocs.search_docs {query:"sponsored reserves sponsorship", hitsPerPage:6, includeContent:true}
- stellarDocs.search_docs {query:"\"fee-bump transactions\"", hitsPerPage:5, includeContent:true}
- stellarDocs.search_docs {query:"web+stellar pay destination amount asset_code", hitsPerPage:8, includeContent:true}
- stellarDocs.search_docs {query:"SEP-45 contract account web authentication", hitsPerPage:8, includeContent:true}
- stellarDocs.search_docs {query:"embedded wallets passkey disbursement platform", hitsPerPage:8, includeContent:true}
- stellarDocs.search_anchor_sep_docs {query:"SEP-45 configuration anchor platform", hitsPerPage:8, includeContent:true}
- stellarDocs.search_docs {query:"SEP-45", hitsPerPage:8, includeMeetings:true}
- scout.listAudits {q:"openzeppelin", limit:20}
- scout.listAudits {q:"passkey", limit:20}
- scout.listAudits {q:"smart account", limit:20}
- scout.listAudits {q:"wallet", limit:30}
- codemode.search {query:"research cited audit", service:"scout", limit:4}
- stellarDocs.search_doc_titles {query:"sponsored reserves", hitsPerPage:5}
- stellarDocs.search_doc_titles {query:"fee-bump transactions", hitsPerPage:5}
- stellarDocs.search_doc_titles {query:"choose a fee sponsorship approach", hitsPerPage:5}
- stellarDocs.get_doc_page_sections {path:"/docs/build/guides/contract-accounts/smart-wallets"}
- stellarDocs.get_doc_page_sections {path:"/docs/build/guides/transactions/sponsored-reserves"}
- stellarDocs.get_doc_page_sections {path:"/docs/build/guides/transactions/fee-bump-transactions"}
- stellarDocs.get_doc_page_sections {path:"/docs/build/guides/transactions/fee-sponsorship"}
- stellarDocs.get_doc_page_sections {path:"/docs/build/apps/wallet/sep7"}
- stellarDocs.get_doc_page_sections {path:"/docs/build/apps/wallet/sep30"}
- stellarDocs.get_doc_page_sections {path:"/docs/platforms/anchor-platform/sep-guide/sep45"}
- stellarDocs.get_doc_page_sections {path:"/docs/tools/openzeppelin-relayer"}
- codemode.describe("scout.getRepoTrust")  (twice; one script errored on shape)
- codemode.describe("scout.searchResearch")  (script errored on shape)
- scout.getRepoTrust {repo:"stellar/passkey-kit"}, {repo:"stellar/smart-account-kit"}, {repo:"OpenZeppelin/stellar-contracts"}, {repo:"OpenZeppelin/openzeppelin-relayer"}, {repo:"stellar/sep45-reference"}, {repo:"stellar/launchtube"}  (run in two passes)
- scout.searchResearch {q:"SEP-45 contract account authentication status", limit:6}
- scout.searchResearch {q:"passkey kit smart wallet audit security review", limit:6}
- scout.searchResearch {q:"Launchtube retired OpenZeppelin relayer channels", limit:6}
- lumenloop.search_content_semantic {query:"Launchtube sunset replaced by OpenZeppelin Relayer Stellar Channels fee sponsorship", types:["articles","tweets"], limit:5, response_format:"concise"}
- lumenloop.search_content_semantic {query:"SEP-45 web authentication for contract accounts smart wallet anchor", types:["articles","research","proposals"], limit:5, response_format:"concise"}
- codemode.search {query:"meeting notes", service:"stellarDocs", limit:3}
- scout.searchResearch {q:"SEP-45 Web Authentication for Contract Accounts status draft", limit:5}  (errored script) / {q:"SEP-45 Web Authentication for Contract Accounts status", limit:4}
- scout.searchResearch {q:"SEP-0007 URI scheme pay operation parameters destination amount asset_code msg", limit:5}  (errored script) / {q:"SEP-0007 URI scheme pay operation destination amount asset_code memo Soroban", limit:5}
- scout.searchResearch {q:"SEP-0030 account recovery recoverysigner status", limit:5} / {…, limit:4}
- scout.searchResearch {q:"passkey-kit README license audit", limit:5} / {…, limit:4}
- scout.searchResearch {q:"smart-account-kit README OpenZeppelin smart account audit license", limit:5}  (errored script) / {q:"smart-account-kit README OpenZeppelin smart account", limit:4}
- stellarDocs.search_meeting_notes {query:"SEP-45 contract account authentication", hitsPerPage:6}
- stellarDocs.search_docs {query:"custodial wallet embedded key application design considerations", hitsPerPage:6, includeContent:true}
- scout.searchProjects {q:"privy", limit:4}; {q:"blux", limit:4}; {q:"turnkey", limit:4}; {q:"web3auth", limit:4}; {q:"dynamic wallet", limit:4}
- scout.searchRepos {q:"recoverysigner", limit:6}; {q:"albedo", limit:4}
- scout.searchResearch {q:"SEP-0007 preamble status URI scheme delegated signing", limit:4}
- scout.searchResearch {q:"SEP-0007 tx operation xdr transaction envelope Soroban invoke host function contract", limit:4}
- scout.searchResearch {q:"SEP-0059 External Account API preamble status", limit:3}

### Section 5. Reuse vs build

`search` tool calls (query strings verbatim):
- `search repos escrow soroban` (service: scout, limit 15)
- `search projects directory` (service: lumenloop, limit 10)
- `anchor platform SEP-31 disbursement platform docs` (service: stellarDocs, limit 10)
- `audits SCF awarded repo detail` (service: scout, limit 15)

`execute` scripts — operations and inputs verbatim:
- `codemode.describe("scout.searchRepos")`
- `scout.searchRepos({q:"escrow milestone", minScore:30, limit:15})`
- `scout.searchRepos({q:"escrow", language:"Rust", minScore:20, limit:20})`
- `scout.searchRepos({q:"trustless work escrow", limit:10})`
- `scout.searchRepos({q:"escrow refund soroban", language:"TypeScript", minScore:20, limit:10})`
- `scout.searchRepos({q:"openzeppelin stellar contracts", limit:8})`
- `scout.searchRepos({q:"srust escrow", limit:8})`
- `scout.searchRepos({q:"escrow", language:"Rust", minScore:20, limit:20, offset:20})`
- `scout.searchRepos({q:"vesting", minScore:30, limit:12})`
- `scout.searchRepos({q:"payment stream streaming payments", minScore:30, limit:12})`
- `scout.searchRepos({q:"recurring payments subscription", minScore:30, limit:12})`
- `scout.searchRepos({q:"payroll", minScore:30, limit:10})`
- `scout.searchRepos({q:"real estate tokenization", minScore:30, limit:12})`
- `scout.searchRepos({q:"RWA tokenized property fractional", minScore:30, limit:12})`
- `scout.searchRepos({q:"SEP-41 token", minScore:30, limit:10})`
- `scout.searchProjects({q:"real estate", type:"RWA", limit:10, fields:"name,slug,shortDescription,status,scfAwarded,scfTotalAwardedUSD,repos,audits,url,lastActivityAt"})`
- `scout.searchRepos({q:"stellar disbursement platform", limit:8})`
- `scout.searchRepos({q:"disbursement bulk payouts", minScore:30, limit:8})`
- `scout.searchRepos({q:"anchor platform", limit:8})`
- `scout.searchRepos({q:"SEP-31 sending anchor", limit:8})`
- `scout.searchRepos({q:"demo wallet polaris anchor tests", limit:10})`
- `scout.searchRepos({q:"installment payment plan", minScore:25, limit:12})`
- `scout.searchRepos({q:"BNPL buy now pay later", minScore:20, limit:10})`
- `scout.searchRepos({q:"mortgage", minScore:20, limit:10})`
- `scout.searchRepos({q:"scheduled payments time-locked release", minScore:30, limit:12})`
- `scout.getRepoTrust({repo:"Trustless-Work/trustlesswork-smart-contract-stellar"})`
- `scout.getRepoTrust({repo:"OpenZeppelin/stellar-contracts"})`
- `scout.getRepoTrust({repo:"stellar/stellar-disbursement-platform-backend"})`
- `scout.getRepoTrust({repo:"stellar/anchor-platform"})`
- `scout.getRepoTrust({repo:"devasignhq/bounty-escrow"})`
- `scout.getRepoTrust({repo:"luanlabs/fluxity-v1-core"})`
- `scout.getRepoTrust({repo:"SoroStream/sorostream-contracts"})`
- `scout.getRepoTrust({repo:"vestflow-labs/vestflow"})`
- `scout.getRepoTrust({repo:"Dobprotocol/stellar-distribution-contracts"})`
- `scout.getRepoTrust({repo:"lumenlater/lumen-later"})`
- `scout.getRepoTrust({repo:"SimplyTokenized/soroban-smart-contracts"})`
- `scout.getRepoTrust({repo:"stellar/stellar-demo-wallet"})`
- `scout.getRepoTrust({repo:"script3/sep-41-token"})`
- `scout.getRepoTrust({repo:"LabsCrypt/flowfi"})`
- `scout.listAudits({q:"trustless", limit:10})`
- `scout.listAudits({q:"openzeppelin", limit:10})`
- `scout.listAudits({q:"escrow", limit:10})`
- `scout.listAudits({q:"vesting", limit:10})`
- `stellarDocs.search_anchor_sep_docs({query:"Stellar Disbursement Platform overview receiver wallet", hitsPerPage:6})`
- `stellarDocs.search_anchor_sep_docs({query:"SEP-31 cross-border payments sending anchor", hitsPerPage:6})`
- `stellarDocs.search_anchor_sep_docs({query:"disbursement platform SEP-24 deposit wallet registration", hitsPerPage:6})`
- `stellarDocs.search_doc_titles({query:"Stellar Disbursement Platform", hitsPerPage:8})`
- `stellarDocs.search_docs({query:"disbursement platform license Apache open source", hitsPerPage:5})`
- `scout.searchRepos({q:"timelock token vesting", language:"Rust", minScore:25, limit:12})`
- `scout.searchRepos({q:"wallet sdk SEP-24 deposit", limit:8})`
- `scout.searchRepos({q:"polaris django anchor", limit:6})`
- `scout.searchRepos({q:"fungible token template soroban", language:"Rust", minScore:35, limit:10})`
- `scout.searchRepos({q:"tokenized real estate", language:"Rust", minScore:20, limit:10})`
- `scout.searchRepos({q:"rent installments property", minScore:25, limit:10})`
- `scout.searchProjects({q:"trustless work", limit:3})` (run twice; first script errored on a projection bug before returning)
- `lumenloop.search_directory({query:"Trustless Work", limit:3})`
- `lumenloop.find_similar_scf_submissions({query:"milestone escrow installment payouts to a builder", limit:8})`
- `lumenloop.get_project({slug:"trustless-work", compact:true})`
- `stellarDocs.search_anchor_sep_docs({query:"Stellar Disbursement Platform", hitsPerPage:3, includeContent:true})`
- `stellarDocs.search_anchor_sep_docs({query:"SDP architecture receiver wallet registration OTP disbursement CSV", hitsPerPage:4, includeContent:true})`
- `stellarDocs.search_anchor_sep_docs({query:"Anchor Platform SEP-31 receive only sending anchor not supported", hitsPerPage:3, includeContent:true})`
- `scout.searchRepos({q:"typescript wallet sdk", limit:6})`
- `scout.searchRepos({q:"tokenops vesting", limit:6})`
- `scout.searchRepos({q:"soroban examples timelock", limit:6})`
- `scout.searchRepos({q:"stellar demo wallet", limit:4})`
- `scout.searchRepos({q:"non-fungible token NFT soroban", language:"Rust", minScore:40, limit:8})`
- `lumenloop.search_content_semantic({query:"Stellar Disbursement Platform bulk payouts license maturity production use", types:["articles","research","knowledge"], limit:4, response_format:"concise"})`
- `scout.searchResearch({q:"Stellar Disbursement Platform", limit:5})`
- `codemode.search({query:"doc page sections", service:"stellarDocs", limit:3})`
- `stellarDocs.get_doc_page_sections({url:"https://developers.stellar.org/docs/platforms/stellar-disbursement-platform"})` — rejected (invalid arg `url`; no call made)
- `stellarDocs.get_doc_page_sections({url:"https://developers.stellar.org/docs/platforms/stellar-disbursement-platform/admin-guide/making-your-wallet-sdp-ready"})` — rejected (invalid arg; no call made)
- `stellarDocs.search_soroban_contract_docs({query:"timelock example contract claimable balance", hitsPerPage:4})`
- `stellarDocs.get_doc_page_sections({path:"/docs/platforms/stellar-disbursement-platform", includeContent:true})`
- `stellarDocs.get_doc_page_sections({path:"/docs/platforms/stellar-disbursement-platform/admin-guide/making-your-wallet-sdp-ready", includeContent:true})`

### Section 6. Compliance tooling

Raven `search` queries (verbatim):
- regulated assets SEP-8 approval server
- asset authorization flags clawback trustline
- anchor platform KYC customer SEP-12 SEP-31
- compliance screening allowlist project directory
- regulated asset clawback skill  (kind=skill)
- soroban token access control pausable security skill  (kind=skill)

Raven `execute` script inputs (operation → query/args, verbatim):
- stellarDocs.search_asset_token_docs: regulated assets SEP-8 approval server
- stellarDocs.search_docs: SEP-8 regulated
- stellarDocs.search_docs: approval server transaction revise
- stellarDocs.search_asset_token_docs: authorization required revocable clawback enabled immutable flags  (soft-empty)
- stellarDocs.search_asset_token_docs: Stellar Asset Contract authorized set_authorized clawback admin trustline
- stellarDocs.search_docs: clawback operation claimable balance regulatory
- stellarDocs.search_soroban_contract_docs: SAC transfer trustline authorization not authorized
- stellarDocs.search_docs: "AUTH_IMMUTABLE"
- stellarDocs.search_anchor_sep_docs: SEP-12 customer status ACCEPTED NEEDS_INFO REJECTED PROCESSING
- stellarDocs.search_anchor_sep_docs: SEP-31 pending_customer_info_update pending_sender pending_receiver status
- stellarDocs.search_anchor_sep_docs: SEP-24 pending_user_transfer_start pending_anchor pending_external statuses
- stellarDocs.search_anchor_sep_docs: Anchor Platform customer callback KYC PUT customer business server
- stellarDocs.search_anchor_sep_docs: custody Fireblocks integration Anchor Platform
- stellarDocs.search_docs: travel rule sanctions screening
- stellarDocs.search_anchor_sep_docs: transaction status pending_external completed error expired refunded
- codemode.skill.read("skills.stellar-dev.assets", sections: asset-flags, stellar-asset-contract-sac, sep-standards-for-assets, best-practices)
- codemode.skill.read("skills.openzeppelin-stellar.develop-secure-contracts", sections: pattern-discovery-and-integration)
- codemode.skill.read("skills.stellar-dev.smart-contracts", sections: file:security.md)
- codemode.search: research stablecoins directory  (service=scout)
- scout.searchResearch: SEP-8 regulated assets approval server
- scout.searchResearch: compliance sanctions screening on-chain allowlist
- scout.getStablecoins: q=USDC  (rejected: unknown param)
- scout.searchProjects: compliance KYC screening
- scout.searchProjects: regulated asset allowlist travel rule
- lumenloop.search_directory: compliance
- scout.getPartners: KYC compliance
- scout.searchRepos: allowlist compliance soroban token
- scout.searchResearch (source=sep): SEP-8 approval server tx_approve response status revised action_required rejected pending
- scout.searchResearch (source=sep): SEP-8 regulated assets status abstract flags authorization required revocable
- scout.searchResearch (source=sep): SEP-12 customer status ACCEPTED PROCESSING NEEDS_INFO REJECTED
- scout.searchResearch (source=sep): SEP-31 transaction statuses pending_sender pending_receiver pending_customer_info_update pending_transaction_info_update
- scout.searchResearch (source=sep): SEP-24 transaction status pending_user_transfer_start pending_anchor incomplete
- codemode.search: get doc page sections  (service=stellarDocs)
- stellarDocs.get_doc_page_sections: url=https://developers.stellar.org/docs/tokens/control-asset-access | .../stellar-asset-contract | .../build/guides/transactions/clawbacks  (invalid-args, retried with path)
- stellarDocs.search_docs: Fireblocks  (soft-empty)
- stellarDocs.search_docs: Sumsub Notabene Sygna
- stellarDocs.search_docs: "travel rule"  (soft-empty)
- stellarDocs.search_asset_token_docs: token interface SEP-41 CAP-46-6 functions
- stellarDocs.search_docs: OpenZeppelin stellar-contracts access control pausable
- stellarDocs.search_sdk_cli_tools_docs: OpenZeppelin contracts wizard pausable ownable
- stellarDocs.search_asset_token_docs: SEP-57 T-REX ERC-3643 compliance identity
- stellarDocs.search_meeting_notes: SEP-8 regulated assets Soroban
- stellarDocs.search_docs: USDC Circle issuer clawback authorization
- stellarDocs.search_anchor_sep_docs: custody server custodial wallet configuration
- scout.getStablecoins: peg=USD, limit=15
- scout.searchResearch: USDC Stellar issuer account flags clawback authorization revocable
- scout.searchResearch: travel rule SEP-31 sending anchor receiving anchor compliance
- scout.searchResearch: Stellar Asset Contract trustline authorization set_authorized clawback admin functions
- scout.searchProjects: travel rule
- scout.searchProjects: address screening oracle AML sanctions
- lumenloop.search_directory: sanctions screening AML
- scout.searchRepos: openzeppelin stellar-contracts pausable access control
- stellarDocs.get_doc_page_sections: path=/docs/tokens/control-asset-access ; /docs/tokens/stellar-asset-contract ; /docs/build/guides/transactions/clawbacks ; /docs/tools/openzeppelin-contracts ; /docs/tokens/token-interface ; /docs/tokens/anatomy-of-an-asset
- scout.searchResearch (source=sep): SEP-0008 Regulated Assets Preamble Status Version Created Updated
- scout.searchResearch (source=sep): POST tx_approve approval server responses success revised action_required rejected
- scout.searchResearch (source=sep): regulated assets Soroban smart contract invoke host function approval
- scout.searchResearch (source=sep): Customer Statuses table ACCEPTED PROCESSING NEEDS_INFO REJECTED description KYC API
- scout.searchResearch (source=sep): Cross-Border Payments transaction status values pending_sender pending_receiver pending_stellar pending_external completed error refunded expired
- scout.searchResearch (source=sep): Hosted Deposit Withdrawal transaction status incomplete pending_user_transfer_start pending_user_transfer_complete pending_anchor
- scout.searchResearch (source=sep): Trustline Onboarder Specification asset class auth_required authorizer contract regulated
- scout.searchResearch: Stellar Asset Contract transfer authorized trustline AUTH_REQUIRED contract address balance authorization
- codemode.search: project detail scout  (service=scout)
- stellarDocs.search_anchor_sep_docs: third-party custodian deposit_info_generator_type custody
- stellarDocs.search_anchor_sep_docs: custody integration custodial wallet service
- lumenloop.search_content_semantic: travel rule compliance for Stellar anchors SEP-31 sanctions screening
- lumenloop.get_project: slug=scorechain, compact=true
- scout.searchProjects: Scorechain
- scout.searchRepos: stellar-compliance-kit compliance-primitives
- scout.searchResearch: USDC Circle Stellar issuer flags clawback authorization revocable set
- scout.searchResearch (source=sep): approval server response success tx signed transaction revised tx message
- scout.searchResearch (source=sep): action_required action_url action_method action_fields rejected error
- scout.searchResearch (source=sep): stellar.toml regulated approval_server approval_criteria CURRENCIES
- scout.searchResearch (source=sep): ACCEPTED PROCESSING NEEDS_INFO REJECTED customer KYC data accepted still being processed
- scout.searchResearch (source=sep): incomplete pending_anchor pending_trust pending_user no_market too_small too_large error status deposit withdrawal
- scout.searchResearch: travel rule originator beneficiary information VASP
- stellarDocs.get_doc_page_sections: path=/docs/tokens/stellar-asset-contract
- codemode.skill.read("skills.openzeppelin-stellar.upgrade-stellar-contracts", sections: access-control)
- codemode.skill.read("skills.stellar-dev.smart-contracts", sections: file:development.md)
- codemode.skill.read("skills.openzeppelin-stellar.setup-stellar-contracts", sections: code-patterns, openzeppelin-dependencies)
- scout.searchResearch: OpenZeppelin Stellar contracts access control Ownable pausable macros
- lumenloop.search_content_semantic: Circle USDC on Stellar issuer account flags freeze clawback authorization
- stellarDocs.search_docs_in_category (platforms): custody
- stellarDocs.search_docs_in_category (platforms): Fireblocks custody_server
- stellarDocs.search_docs: SEP-9 KYC fields financial account
- scout.searchResearch (source=sep): Regulated Assets approval server Success response status success tx signed Revised response status revised
- scout.searchResearch (source=sep): Regulated Assets Rejected response status rejected error wallet should display
- scout.searchResearch (source=sep): KYC API customer status NEEDS_INFO more information needed REJECTED anchor rejected customer
- scout.searchResearch (source=sep): Hosted Deposit and Withdrawal GET transaction status incomplete pending_user_transfer_start pending_anchor pending_stellar pending_external completed refunded expired no_market too_small too_large error
- stellarDocs.get_doc_page_sections: path=/docs/platforms/anchor-platform/sep-guide/sep24/setting-up-production-server

### Section 7. Landscape

`search` calls (mcp__stellar-raven__search):
- "project directory search" (service lumenloop, limit 20)
- "search projects ecosystem" (service scout, limit 30)
- "SCF proposal research" (limit 15)
- "stablecoins partners anchors" (service scout, limit 15)

`execute` script inputs (mcp__stellar-raven__execute), one per line:
- lumenloop.search_directory query "real estate tokenization Latin America" (limit 8)
- lumenloop.search_directory query "tokenized property fractional ownership" (limit 8)
- lumenloop.search_directory query "mortgage financing housing" (limit 8)
- lumenloop.search_directory query "inmobiliario vivienda tokenizacion" (limit 8)
- lumenloop.search_directory query "construction escrow real estate" (limit 8)
- lumenloop.search_directory query "diaspora home buying remittance housing" (limit 8)
- scout.searchProjects q "real estate" (limit 25)
- scout.searchProjects type "RWA" (limit 60)
- lumenloop.find_similar_scf_submissions query "real estate tokenization Latin America fractional property mortgage" (limit 15)
- lumenloop.find_similar_scf_submissions query "down payment housing financing remittances home purchase" (limit 10) [run twice]
- lumenloop.get_project slug: bwb, tokeshare, urbanflip, nauta-land, minah, lend, tauvlo, mica, bando, etherfuse, neovestor, plutus
- lumenloop.get_scf_submissions slug "tokeshare"; name "urbanflip"; slug "bwb"; slug "crebit-pay" [twice]; slug "tokeshare" [second time reading application text]
- lumenloop.search_directory query "remittances Latin America" (limit 12)
- lumenloop.search_directory query "remesas" (limit 12)
- lumenloop.search_directory query "Colombia" (limit 12)
- lumenloop.search_directory query "Mexico remittance" (limit 12)
- lumenloop.search_directory query "Central America remittances Guatemala Honduras El Salvador" (limit 12)
- lumenloop.search_directory query "Argentina peso stablecoin" (limit 12)
- scout.searchProjects q "remittance Latin America" (limit 40)
- scout.searchProjects type "Anchor" (limit 100)
- scout.getPartners region "latam", all "1" (limit 100)
- scout.getPartners q "colombia", all "1" (limit 50)
- scout.searchResearch q "locked exchange rate remittance FX hedging forward contract" source scf-proposal (limit 12)
- scout.searchResearch q "FX risk currency volatility protection stablecoin remittance Latin America" source scf-proposal (limit 12)
- scout.searchResearch q "remittances Colombia Mexico Central America corridor USDC payout" source scf-proposal (limit 12)
- lumenloop.find_similar_scf_submissions query "lock exchange rate hedge FX risk remittance forward" (limit 12)
- lumenloop.find_similar_scf_submissions query "remittances USDC Colombia Mexico Central America corridor cash payout" (limit 15)
- lumenloop.search_content_semantic query "FX hedging forward contract locked rate remittance Stellar" (types articles, research, scf_submissions; limit 6)
- lumenloop.search_directory query "foreign exchange hedging FX forward" (limit 8) [run twice]
- scout.getStablecoins (limit 100)
- scout.getStablecoins peg "COP" (limit 20)
- lumenloop.search_directory query "Colombian peso COP stablecoin anchor" (limit 10)
- lumenloop.search_directory query "PSE Bre-B Colombia bank transfer integration" (limit 8)
- scout.searchProjects q "Colombia" (limit 40)
- scout.searchResearch q "Colombia Colombian peso COP anchor PSE Bre-B fintech Stellar" (limit 12)
- scout.searchResearch q "Colombia Colombian fintech remittances peso" source scf-proposal (limit 12)
- lumenloop.search_content_semantic query "Colombia Stellar anchor Colombian peso stablecoin PSE" (types articles, events, scf_submissions, research; limit 8)
- lumenloop.search_content_semantic query "Colombian fintech building on Stellar remittances Bre-B" (types articles, av, tweets; limit 6)
- scout.searchProjects q (limit 3) for each of: "MoneyGram Access", "MoneyGram", "Bitso", "Felix Pago", "Beans", "Lobstr", "Vibrant", "Decaf", "Meru", "Airtm", "Anclap", "Alfred Pay", "Kado", "Mykobo", "Crebit", "Lumx", "Enable", "Onboard", "Zebec", "Settle Network", "Brale", "Trace Finance", "Littio", "Minteo", "Nummus"
- lumenloop.get_project slug "crebit-pay"; "vank"; "fx-swap"; "xccy"; "cashabroad"; "pactta"
- scout.searchResearch q "XCCY fixed-rate layer cross currency" source scf-proposal (limit 4)
- scout.searchResearch q "Hedgehog FX swap foreign currency borrowing" source scf-proposal (limit 3)
- scout.searchResearch q "VANK anchor USDC COP on off ramp Colombia" source scf-proposal (limit 5)
- scout.searchResearch q "payment interoperability wallets Colombian banking system PSE" source scf-proposal (limit 5)
- scout.searchResearch q "Enable off-ramps communities Venezuela Colombia corridor Danish Refugee Council" source scf-proposal (limit 4)
- scout.searchResearch q "Onboard LatAm payout corridors USDC" source scf-proposal (limit 3)
- scout.searchResearch q "Seasonal Workers Payroll remittances USDC LATAM beat inflation" source scf-proposal (limit 3)
- scout.searchResearch q "Tokeshare LATAM real-world investing" source scf-proposal (limit 3)
- scout.searchResearch q "Urbanflip real estate co-investment platform" source scf-proposal (limit 3)
- scout.searchResearch q "Nauta Land real estate Colombia secondary market" source scf-proposal (limit 3)
- lumenloop.get_project slug: puenta, loto-punto, basilic, tucambio, cash-abroad, conomy, amulets, bexo, muney, pigfi, providencia-onchain, felix-pago, bitso, meru, anclap, verso, unalivio, domipago, remi, ibis, yolat, nemorixpay
- lumenloop.search_directory query "cuota inicial vivienda credito hipotecario remesas" (limit 8)
- lumenloop.search_content_semantic query "remittances to Colombia US corridor Stellar USDC payout bank account" (types articles, av, events; date_start 2025-01-01; limit 8)
- lumenloop.search_content_semantic query "tokenized real estate Latin America Stellar housing mortgage" (types articles, av, research; limit 8)
- lumenloop.search_content_semantic query "MoneyGram Access cash pickup Stellar USDC Latin America Colombia Mexico Guatemala" (types articles, av; date_start 2025-01-01; limit 8)
- scout.matchPartners need "USDC to Colombian peso off-ramp with bank payout in Colombia, SEP-24 or SEP-31, for a remittance product" → HTTP 502 (failed, inconclusive)
- scout.searchResearch q "Payment interoperability for wallets Colombia Movii Persona KYC smart routing USDC Stellar" source scf-proposal (limit 6)
- scout.searchResearch q "Urbanflip compliant on-chain real estate co-investment country investors" source scf-proposal (limit 4)
- scout.searchResearch q "Onboard LatAm payout corridors countries Mexico Colombia Argentina USDC off-ramp" source scf-proposal (limit 4)
- scout.searchResearch q "Providencia payment rails COP off-ramp resident merchant wallet" source scf-proposal (limit 3)
- lumenloop.search_directory query "Vibrant" (limit 3); "Kado" (limit 3); "Littio" (limit 3); "Movii" (limit 3); "Abroad" (limit 5)
- lumenloop.search_content_semantic query "Bre-B Colombia instant payments system stablecoin integration" (types articles, av, scf_submissions; limit 5)
- lumenloop.search_content_semantic query "locked exchange rate guaranteed FX rate remittance recipient protection" (types articles, av, scf_submissions; limit 6)
- scout.searchResearch q "Payment interoperability for wallets SCF #32 Award round Status Requested budget Colombian banking USDC QR" source scf-proposal (limit 8)
- scout.searchProjects q "Abroad" (limit 4)
- lumenloop.find_similar_scf_submissions slug "recy3we2U8HQUaOR6" (limit 3)
