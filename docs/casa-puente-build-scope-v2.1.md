# Casa Puente: Build Scope v2.1 (Rate Lock + Treasury Hedge + Raven findings)

As of 2026-10-19 · Owner: Alejandro Valencia · Project: Constructora Bolívar cross-border payments on Stellar

Source docs this supersedes or extends:
- Casa Puente and Fiducia Abierta: Project Scope (Oct 1, 2026)
- Crebit vs Casa Puente: Transfer and Off-Ramp Analysis (Oct 19, 2026), incl. tab "Rate lock: three angles"
- White Paper Routes (Route 2: Davivienda FX rail)
- `research/raven-scope.md` (Stellar Raven research pass, 2026-10-19: 298 sources, findings tagged with catalog id, URL, version and confidence)

---

## 0. How to use this file

This is the single source of truth for the Casa Puente build. Paste it into the build chat as context. Sections 2 (locked decisions) and 13 (out of scope) are binding; everything marked **Proposed** is a default that can be changed with a reason.

Two additions are new versus the Oct 1 scope:
1. **Buyer: the lock calendar.** Monthly locks (mortgage phase) and quarterly locks (down-payment phase, 3 installments at one rate), shown per installment on one timeline.
2. **Treasury: the pooled forward strip.** Each quarter's locked installments are hedged together with USD-sell forwards (NDFs) booked by Bolívar with Davivienda. We do NOT use Crebit's lock API.

**v2.1 changes from the Raven research pass** (details in `raven-scope.md`):
- The sending-anchor backend is fully custom, and no live SEP-31 anchor paying COP is confirmed. A SEP-6/24 withdraw-exchange fallback is now required (D7, §4.5).
- Passkey wallets need a relayer and SEP-45 auth, plus a G-account fallback for anchors without SEP-45 (D8, §4.8).
- Plans of 24–36 months outlive Soroban storage TTL (~180 days) and RPC event retention (~7 days): add a TTL keeper and an off-chain indexer (D11, D12, §4.9).
- Pin soroban-sdk only after checking mainnet `getVersionInfo` (v28.0.0 / Protocol 28 has breaking macro changes).

---

## 1. Product in one paragraph

A Colombian buyer living in the US pays the down payment, then the mortgage, on a home in Colombia from one portal. They pay in dollars; the builder receives pesos. Before paying, the buyer can lock the exchange rate for the next payment (monthly) or the next three payments (quarterly), and sees every installment on a calendar marked locked, offered, or open. Behind the lock, Bolívar hedges each quarter's locked installments in one forward strip with Davivienda. Because USD/COP forward points pay the dollar seller (about +2% at 3 months, mid-2026), the lock produces margin instead of costing the buyer a deposit.

Pitch line: "One account to pay, one rate you can see coming."

---

## 2. Locked decisions

| # | Decision |
| --- | --- |
| D1 | Casa Puente is built first; Fiducia Abierta comes later on the same contracts. |
| D2 | Rail: Stellar. USDC via Stellar Asset Contract; Soroban for the schedule. Testnet + SDF test anchor for the demo. Pin soroban-sdk to the version mainnet runs (`getVersionInfo`); v28.0.0 (Protocol 28, 2026-09-18) has breaking macro changes. |
| D3 | Rate lock is ours, not Crebit's API. Hedged with our own strategy (D5). |
| D4 | Two lock tenors only: **Monthly** (1 installment) and **Quarterly** (3 consecutive installments, one rate). |
| D5 | Hedge = pooled quarterly strip of **cash-settled NDFs** (USD sell / COP buy), booked by **Bolívar** (the Colombian resident with the COP obligation) with **Davivienda** (an IMC). The IMC reports the derivatives to Banco de la República. |
| D6 | Forward points are split between buyer and Bolívar via a **pass-through %** (default 50%, configurable). |
| D7 | The Soroban vault never calls SEP-31. `release_due` sends USDC to a **custom sending-anchor backend** (Anchor Platform is SEP-31 receive-only; the only OSS sending client is archived). Primary path: SEP-31 + SEP-38 to a Colombian receiving anchor. **Required fallback:** SEP-6/24 withdraw-exchange (USDC → COP) to an anchor such as VANK, because no live SEP-31 COP receiver is confirmed. Both sit behind one `OffRampProvider` interface. |
| D8 | The buyer never sees crypto vocabulary. Passkey wallet signs under the hood: **Smart Account Kit + OpenZeppelin Smart Account** (the only passkey path with published audits). A C-address cannot sign a transaction envelope, so a **relayer (OpenZeppelin Relayer)** submits every buyer transaction; Launchtube is retired. Anchor auth for C-addresses uses **SEP-45** (Draft v0.1.1, enabled per anchor); where an anchor lacks it, a platform-managed **G-account** handles the SEP-10/24 deposit leg. |
| D9 | Framing stays "tokenized deposit / payment infrastructure", not public crypto. The risk-bearing instrument is a regulated bank forward; the chain records. |
| D10 | Lock data lives inside `payment_plan` (per installment). A separate `rate_lock` contract is deferred (see §13). |
| D11 | `payment_plan` storage is kept alive by a **TTL keeper job**: max storage TTL is about 180 days, so a 24–36 month plan needs at least 6 re-extensions. |
| D12 | Receipts and history are **indexed off-chain** from events as they happen; RPC keeps events only about 7 days. The chain is the source of truth, the index is the read model. |

---

## 3. Architecture

```
 BUYER (US)                    PLATFORM                                   COLOMBIA
 ─────────                     ────────                                   ────────
 Bank (ACH) ──USD──► US Anchor (SEP-24) ──USDC──► payment_plan vault (Soroban)
                                                     │  release_due(installment)
                                                     ▼
                                          Sending-anchor backend ──SEP-31/38──► CO receiving anchor
                                                     │                                 │ COP at spot
                                                     │                                 ▼
 Web app ◄──── Rate service ◄── forward curve        │                     Bolívar fiduciary account
   │  lock calendar   │                              │                                 ▲
   │                  ▼                              │                                 │ NDF settlement (COP)
   └── accept lock ─► Lock engine ──► Treasury / hedge book ──► HedgeProvider ──► Davivienda (IMC)
                                         (pooled quarterly strip)                 reports to BanRep
```

Money flow on a locked installment:
1. Buyer pays USD by ACH; US anchor mints USDC into the vault.
2. On the due date `release_due` sends the installment's USDC to the sending backend.
3. Receiving anchor pays COP **at spot** into Bolívar's fiduciary account.
4. On the same date the NDF for that installment settles in COP between Davivienda and Bolívar: (forward rate − fixing) × USD notional.
5. Ledger credits the buyer the **locked COP amount**. Builder view shows: COP from anchor + NDF settlement ± basis = COP credited.

Basis note: the NDF fixes on TRM; the anchor converts at its own rate. The difference is a reconciliation line, absorbed from Bolívar's margin (see §7).

Also on the path (not drawn): every buyer transaction goes buyer passkey → Smart Account → **relayer** → network; an **indexer** consumes contract events into Supabase; a **TTL keeper** extends `payment_plan` storage.

---

## 4. Components

### 4.1 Soroban contract: `payment_plan`

**Storage (per plan)**
- `plan_id`, `buyer` (Address), `payee_backend` (Address, the sending backend), `operator` (Address, platform signer), `usdc` (SAC address)
- `installments: Vec<Installment>`
- `balance_usdc: i128`

**`Installment`**
| Field | Type | Notes |
| --- | --- | --- |
| `idx` | u32 | 0-based |
| `due_ts` | u64 | unix seconds |
| `cop_due` | i128 | COP owed to the builder, fixed by the sale contract |
| `phase` | enum | `DownPayment` \| `Mortgage` |
| `lock_id` | Option<BytesN<32>> | set when locked |
| `locked_rate` | Option<i128> | COP per USD, scaled 1e7 |
| `usd_due` | Option<i128> | USDC (7 decimals) = cop_due / locked_rate; set at lock |
| `lock_expiry_ts` | Option<u64> | after this, an unpaid locked installment is `Broken` |
| `status` | enum | `Open` \| `Locked` \| `Released` \| `Broken` |

**Functions**
| Function | Auth | Effect |
| --- | --- | --- |
| `create_plan(operator, buyer, payee_backend, installments)` | operator | creates plan, all `Open` |
| `deposit(buyer, amount)` | buyer | USDC transfer in; `balance_usdc += amount` |
| `apply_lock(operator, buyer, idxs, lock_id, locked_rate, expiry_ts)` | operator **and** buyer | sets lock fields on 1 (monthly) or 3 consecutive (quarterly) `Open` installments; computes `usd_due` |
| `release_due(idx)` | operator | requires `now >= due_ts`, balance ≥ amount; transfers USDC to `payee_backend`; amount = `usd_due` if `Locked`, else amount provided by operator from a fresh spot quote (`release_spot(idx, usd_amount)`) |
| `break_lock(operator, idx)` | operator | `Locked` → `Broken`; clears lock; installment pays at spot later |
| `get_status(plan_id)` | none | plan + installments + balance |
| `extend_ttl()` | anyone | extends instance and persistent storage TTL; called by the keeper job (§4.9) |

**Events**: `PlanCreated`, `Deposited`, `LockApplied{idxs, lock_id, rate}`, `Released{idx, usdc, rate, lock_id?}`, `LockBroken{idx}`.

**Invariants (test these)**
- Quarterly lock = exactly 3 consecutive `Open` installments in the same phase.
- `usd_due * locked_rate == cop_due` within 1 stroop rounding.
- No release before `due_ts`; no double release.
- Only `operator` can release; only buyer + operator together can lock.
- Plan storage never archives while any installment is unreleased (keeper test with a simulated ledger advance past TTL).
- `buyer` is a C-address (Smart Account); `require_auth` must pass through the relayer path.

### 4.2 Rate service

- **Spot quote**: SEP-38 `POST /quote` (firm) on the receiving anchor for USDC→COP, compared with a Horizon strict-send path query; best wins. Returns rate + expiry countdown (as in v1).
- **Forward curve**: `HedgeProvider.getCurve(tenors=[1M,2M,3M])`. Demo uses a static curve (§7); pilot pulls from Davivienda treasury.
- **Lock quote**: computed by the lock engine (§4.3) from spot + curve + pass-through.

### 4.3 Lock engine

**Tenors**
- Monthly: next single installment (mortgage phase default). Hedge tenor = that installment's due date (~1M).
- Quarterly: next 3 consecutive installments (down-payment phase default). One rate for all three; each leg hedged at its own date (1M, 2M, 3M).

**Pricing (Proposed)**
```
fwd_i        = forward rate for installment i's due date
avg_fwd      = mean(fwd_i) over the installments in the lock
points       = avg_fwd − spot
locked_rate  = spot + pass_through × points − bank_spread_buffer
```
- `pass_through` default 0.50; `bank_spread_buffer` default = 0 in demo, set from Davivienda pricing in pilot.
- Lock quote valid 10 minutes (Proposed); accepting it calls `apply_lock` and books legs into the hedge book.

**States**: `Quoted → Active → (Consumed per installment) → Closed`, or `Expired` (quote not accepted), or `Broken`.

**Rules (Proposed)**
| Rule | Default |
| --- | --- |
| Renewal offer | 10 days before the current lock's last due date; push + email + banner |
| No silent auto-renew | If not accepted, next installment is `Open` and pays at spot |
| Acceptance cutoff | 3 business days before the first installment in the lock (time to book the NDF) |
| Late payment grace | 5 business days at the locked rate |
| Missed beyond grace | Lock `Broken`; break cost = negative mark-to-market of that leg, charged to buyer; positive MTM kept as buffer |
| Max notional per lock | Configurable cap (set with Davivienda) |
| Disclosure | Break rule shown on the lock screen before the buyer confirms |

### 4.4 Treasury / hedge book (Bolívar-side)

- **Pooling**: every accepted lock adds legs `{due_date, usd_notional, locked_rate, fwd_rate}` to the book for its quarter.
- **Booking**: once per window (Proposed: weekly, plus at each quarter roll), net new legs by due date and book one NDF per due date via `HedgeProvider.bookStrip(legs)`.
- **Unhedged gap**: locks accepted after the last booking are exposure until the next booking. Show it.
- **Settlement**: on each due date, record NDF settlement (COP) from `HedgeProvider.getSettlements()`, match to released installments.
- **Margin**: `(fwd_rate − locked_rate) × usd_notional` per leg, accrued; net of basis and break costs.

**`HedgeProvider` interface (TypeScript, Proposed)**
```ts
interface HedgeProvider {
  getCurve(tenors: string[]): Promise<{ tenor: string; date: string; rate: number }[]>;
  bookStrip(legs: { dueDate: string; usdNotional: number }[]): Promise<{ tradeId: string; dueDate: string; rate: number; banrepRef?: string }[]>;
  getSettlements(from: string, to: string): Promise<{ tradeId: string; date: string; copAmount: number; fixing: number }[]>;
}
```
- `MockHedgeProvider` (demo): static curve from §7, books instantly, settles at a scripted fixing.
- `DaviviendaProvider` (pilot): starts as a manual/CSV upload by treasury, API later.

### 4.5 Sending-anchor backend

- **Fully custom.** Anchor Platform implements SEP-31 receive-only, and the only OSS sending client is archived, so we write the sending side ourselves.
- Holds the address `payee_backend`. Consumes `Released` events from the indexer (§4.9), not from RPC directly.
- Behind one interface:
```ts
interface OffRampProvider {
  quote(usdc: string, copTarget?: string): Promise<{ quoteId: string; rate: number; expiresAt: string }>;
  pay(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string }): Promise<{ txId: string }>;
  status(txId: string): Promise<'pending' | 'completed' | 'refunded' | 'error'>;
}
```
- `Sep31OffRamp` (primary): SEP-10 → SEP-38 firm quote → SEP-31 `POST /transactions` with sender (buyer) and receiver (Bolívar fiduciary) KYC refs → send USDC with memo → poll.
- `Sep6Sep24OffRamp` (**required fallback**): SEP-10 → SEP-38 → SEP-6 (or SEP-24) withdraw-exchange USDC → COP to the fiduciary account → poll.
- Counterparty is **unconfirmed** (open question #1): no source confirms a live SEP-31 anchor paying COP. Bitso publishes no SEP list; VANK's SCF-funded COP anchor is SEP-6/24/38 (PSE in, ACH out), not SEP-31.
- Testnet: SDF test anchor for both paths. Must be operated by, or on behalf of, a licensed sending business (US anchor partner or a licensed MSB operator).
- Writes the receipt (§4.6).

### 4.6 Receipt (one per installment)

USD paid · USDC released · locked rate (or "spot") · spot at release · COP from anchor · NDF settlement COP · basis · COP credited to buyer · fee · Stellar tx hash · lock id · hedge trade id · BanRep/FX declaration reference.

### 4.7 Web app (React)

**Buyer dashboard**
- Header: next payment (USD, COP, due date), balance, "pesos protected this year" total.
- **Lock calendar** (centerpiece): 12-month row of installments. Down-payment phase shown as quarter bands (3 dots each); mortgage phase as monthly cells. States: Locked (accent, solid), Offered (dashed), Open (plain), Paid (check), Broken (warning).
- Installment card: locked rate vs today's rate, COP delivered, difference in COP.
- Lock flow: choose Monthly or Quarterly → quote with 10-minute countdown → break rule disclosure → passkey confirm.
- Pay flow: ACH via anchor (SEP-24 interactive, embedded/hidden).
- Receipts list.

**Builder view (Bolívar Miami sales + finance)**
- Per unit: schedule, paid vs due, locked vs open.
- Reconciliation per installment: COP from anchor + NDF settlement ± basis = COP credited. Flags any mismatch.

**Treasury view (Bolívar treasury)**
- Hedge book by quarter: locked USD by due date, hedged, unhedged gap, booked trades.
- Curve in use, pass-through %, margin accrued, break costs.
- "Book strip" action (mock in demo).

### 4.8 Wallet, auth and relayer

- **Wallet:** Smart Account Kit + OpenZeppelin Smart Account, passkey signer (WebAuthn). One Smart Account (C-address) per buyer.
- **Relayer:** OpenZeppelin Relayer submits and pays fees for every buyer transaction (`deposit`, `apply_lock`). Fee-bumps and sponsored reserves do not apply, because a C-address cannot sign an envelope.
- **Anchor auth:** SEP-45 for C-addresses where the anchor enables it (Draft v0.1.1). Otherwise a platform-managed **G-account per buyer** authenticates with SEP-10, completes the SEP-24 deposit, and forwards USDC to the plan. Decide per anchor; record which mode in `buyers.anchor_auth_mode`.
- **Custody note:** the G-account fallback means the platform briefly controls buyer funds; confirm with the licensed US partner that this sits under its license.

### 4.9 Indexer and TTL keeper

- **Indexer:** polls RPC `getEvents` for the `payment_plan` contract well inside the ~7-day retention window (Proposed: every minute), writes events to Supabase, and drives receipts, the calendar and the sending backend. Keeps a cursor; alerts if it falls more than 24 h behind.
- **TTL keeper:** daily job calls `extend_ttl()` on every plan with unreleased installments, extending to the maximum; alerts when any plan's remaining TTL falls under 30 days. A 24–36 month plan needs at least 6 extensions over its life.

---

## 5. Data model (off-chain, Supabase, Proposed)

| Table | Key columns |
| --- | --- |
| `buyers` | id, name, email, smart_account (C-address), fallback_g_account, anchor_auth_mode (sep45 / g_account), kyc_ref, anchor_customer_id |
| `units` | id, project, unit_code, price_cop, builder_account_ref |
| `plans` | id, buyer_id, unit_id, contract_id (Soroban), created_at |
| `installments` | plan_id, idx, due_date, cop_due, phase, status, lock_id, usd_due, released_tx |
| `locks` | id, plan_id, tenor (monthly/quarterly), idxs[], spot, avg_fwd, pass_through, locked_rate, quote_expires_at, accepted_at, state |
| `hedge_legs` | id, lock_id, installment_idx, due_date, usd_notional, fwd_rate, trade_id, booked_at |
| `hedge_trades` | trade_id, provider, due_date, usd_notional, rate, banrep_ref, settled_cop, fixing |
| `receipts` | installment fk, all §4.6 fields |
| `curves` | as_of, tenor, date, rate, source |
| `chain_events` | contract_id, ledger, tx_hash, type, payload, indexed_at (indexer cursor table) |
| `plan_ttl` | plan_id, live_until_ledger, last_extended_at |

RLS: buyers see only their plans; builder role sees all units of its projects; treasury role sees hedge tables.

---

## 6. API (backend, Proposed)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/plans/:id` | plan + installments + lock states (calendar data) |
| POST | `/locks/quote` | `{planId, tenor}` → lock quote with expiry |
| POST | `/locks/:id/accept` | builds `apply_lock` tx for buyer passkey signature; on success books legs |
| POST | `/installments/:idx/release` | operator job; calls `release_due` / `release_spot` |
| GET | `/receipts/:planId` | receipts |
| GET | `/treasury/book?quarter=` | hedge book |
| POST | `/treasury/book-strip` | books pending legs via HedgeProvider |
| GET | `/rates/spot` | SEP-38 + path comparison |
| GET | `/rates/curve` | forward curve in use |

Jobs: `indexer` (every minute), `ttl-keeper` (daily), `release-due` (daily), `renewal-offers` (daily), `book-strip` (weekly), `settlements-sync` (daily), `break-check` (daily).

---

## 7. Worked example (demo numbers)

Curve: USD/COP mid-market on 17 Jun 2026 (cbonds). Spot 3,422.325 · 1M 3,442.145 · 2M 3,464.645 · 3M 3,492.795. Illustrative installment: USD 2,000 equivalent. Mid rates, before bank spread.

Quarterly lock, pass-through 50%:
- avg_fwd = (3,442.145 + 3,464.645 + 3,492.795) / 3 = **3,466.528**
- points = 3,466.528 − 3,422.325 = **44.203**
- locked_rate = 3,422.325 + 0.5 × 44.203 = **3,444.427**
- Buyer gets per installment: 2,000 × 3,444.427 = **COP 6,888,853** (vs COP 6,844,650 at today's spot)
- Hedge delivers for the quarter: 2,000 × (3,442.145 + 3,464.645 + 3,492.795) = **COP 20,799,170**
- Buyer credited for the quarter: 3 × 6,888,853 = **COP 20,666,559**
- Bolívar margin for the quarter: **COP 132,611** (≈ USD 38.75, ≈ 0.65% of USD 6,000)

Monthly lock (mortgage), pass-through 50%: points = 19.82; locked_rate = **3,432.235**.

Note: in the demo the "cop_due" is fixed by the sale contract and the buyer's USD varies; the same math gives `usd_due = cop_due / locked_rate`. Replace the curve with Davivienda pricing before any real quote.

---

## 8. Demo plan (48 hours)

**Seed data**: 1 buyer (María, Miami), 1 unit in Bogotá, 24-month down payment (monthly) then mortgage; Q1 and Q2 locked, Q3 offered, Q4 open; 2 installments already paid.

**Mocks**: SDF test anchor (SEP-24, SEP-31, SEP-38), MockHedgeProvider with the §7 curve, scripted NDF fixing.

**Build order**
0. Check mainnet `getVersionInfo`; pin soroban-sdk and the Smart Account / Relayer versions.
1. `payment_plan` contract (incl. `extend_ttl`) + unit tests for §4.1 invariants.
2. Smart Account + passkey signup + relayer, with the G-account fallback against the test anchor.
3. Indexer + TTL keeper.
4. Rate service (SEP-38 + path) and lock engine pricing (§4.3) with the static curve.
5. Sending backend: `Sep31OffRamp` and `Sep6Sep24OffRamp` against the test anchor; receipts from the indexer.
6. Buyer dashboard with lock calendar + lock flow + pay flow.
7. Builder reconciliation view; treasury hedge-book view.
8. Demo script dry-run.

Time note: items 2, 3 and 5 are new work versus v2 and do not fit the original 48-hour estimate. For a time-boxed demo, the G-account path alone (no passkey) and a single off-ramp path are acceptable shortcuts, flagged on screen.

**Demo script (maps to the 7-beat pitch, live demo ≈ 75 s)**
1. Open María's calendar: two quarters locked, Q3 offered.
2. Accept the Q3 quarterly lock: quote, countdown, break rule, passkey.
3. Pay one installment: release, COP lands, receipt shows locked vs spot.
4. Switch to treasury: the new legs appear in the Q3 strip; "book strip"; margin accrued.
5. Builder view: reconciliation line = COP from anchor + NDF settlement.

Business slide: "The lock pays for itself: forward points split between the buyer and Bolívar."

---

## 9. Phases

| Phase | Scope | Gate to next |
| --- | --- | --- |
| Demo | Testnet, mocks, seed data | Bolívar Miami sales and treasury see it |
| Pilot | 1 real US anchor, 1 Colombian receiving anchor, Davivienda as manual HedgeProvider, 5–10 buyers, USD–El Salvador corridor first if Colombia FX setup lags | Real locks hedged and reconciled for one full quarter |
| Production | DaviviendaProvider API, automated booking, Route 2 (Davivienda-run rail) evaluated | Margin and reconciliation proven at volume |

---

## 10. Compliance and regulatory notes

- Money into Colombian property must be channeled through a licensed FX intermediary and registered with Banco de la República; each installment carries an FX declaration reference.
- Residents may hedge FX only with IMCs or authorized foreign agents; IMC-booked derivatives are reported to BanRep by the IMC. Bolívar books; Davivienda reports.
- The platform does not hold FX risk or sell derivatives to buyers. The buyer gets a locked conversion price for a scheduled payment; confirm with counsel this is not itself a derivative offered to a US consumer.
- US side: the US anchor (or licensed MSB operator) is the money transmitter; KYC once via SEP-12.
- Buyer disclosures: lock terms, break cost rule, renewal not automatic.

---

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Forward points shrink (rate gap narrows) | Pass-through % is a parameter; lock still works at zero margin |
| Missed installment leaves over-hedge | Grace window, break cost, cap per lock |
| Unhedged gap between acceptance and booking | Booking cadence + acceptance cutoff; show gap in treasury view |
| Basis: TRM fixing vs anchor rate | Reconciliation line; absorb from margin; pick anchor with tight spread |
| Colombian PSE payout completion (79% in a recent report) | Prefer anchors paying over Bre-B or direct bank credit; track completion |
| Peso liquidity at the off-ramp for large deposits | Anchor selection; split large payments |
| Davivienda does not agree | Fallback: offshore NDF by a non-resident entity, or Crebit-style deposit lock |
| No live SEP-31 COP receiving anchor | `Sep6Sep24OffRamp` fallback behind `OffRampProvider` |
| Anchor lacks SEP-45 (Draft) | Platform G-account for SEP-10/24, custody covered by the licensed partner |
| Relayer outage blocks every buyer transaction | Run relayer with health checks; queue and retry; operator-paid release path is unaffected |
| Plan storage archives (TTL lapse) | TTL keeper with 30-day alert; restore path documented |
| Events lost past ~7-day RPC retention | Indexer cursor with lag alert; replay from a history archive if needed |
| soroban-sdk v28 breaking macros | Pin to mainnet version; upgrade as a separate task |

---

## 12. Open questions

1. **Which anchor pays COP into a fiduciary account, and over which SEP?** No live SEP-31 COP receiver is confirmed. Ask Bitso for its SEP list and VANK whether it will add SEP-31; confirm the rail (PSE or Bre-B).
2. Which anchors enable SEP-45, or will we run the G-account fallback for all of them?
3. Davivienda: minimum NDF size, pricing spread, booking cadence, settlement mechanics (COP to Bolívar fiduciary?).
4. Counsel: is the buyer-facing lock a derivative under US or Colombian rules? Does the G-account fallback make the platform a custodian?
5. Sale contracts: is the price fixed in COP (assumed) or in USD for diaspora buyers?
6. Pass-through % that sales wants to advertise.
7. Who operates the sending-anchor backend and relayer in pilot: US anchor partner or Maxi Envíos (MSB)?

---

## 13. Out of scope for this build

- Separate `rate_lock` Soroban contract (Angle 3); lock fields stay inside `payment_plan`.
- Crebit lock API integration.
- Fiducia Abierta (milestone escrow); keep the vault general enough to add it.
- Locks longer than one quarter.
- Tokenized promesas (Route 3).

---

## 14. Acceptance checklist

- [ ] `payment_plan` deployed on testnet; invariant tests pass.
- [ ] Quarterly and monthly lock quotes match §7 numbers to 3 decimals with the static curve.
- [ ] Accepting a lock writes `LockApplied` on-chain and creates hedge legs off-chain.
- [ ] `release_due` on a locked installment releases exactly `usd_due`; receipt shows locked vs spot.
- [ ] Calendar renders Locked / Offered / Open / Paid / Broken correctly from `/plans/:id`.
- [ ] Renewal offer appears 10 days before a lock's last due date.
- [ ] Missed-payment path: after grace, lock goes `Broken` and break cost is computed.
- [ ] Treasury view shows hedged, unhedged and margin per quarter; "book strip" books via MockHedgeProvider.
- [ ] Builder reconciliation: anchor COP + NDF settlement ± basis = COP credited, per installment.
- [ ] Buyer signs `deposit` and `apply_lock` with a passkey; the relayer submits; no buyer-held G-key exists unless `anchor_auth_mode = g_account`.
- [ ] Both `OffRampProvider` paths complete a COP payout against the test anchor.
- [ ] Indexer reproduces every receipt after an RPC restart; lag alert fires when stopped for 24 h.
- [ ] TTL keeper extends a plan in a test that advances ledgers past the default TTL.
- [ ] Full demo script runs end to end in under 2 minutes.

---

## 15. References

- USD/COP forward rates (mid), 17 Jun 2026, cbonds: https://cbonds.com.tr/indexes/215893/
- Banco de la República, JDS-CA-11046 (NDFs, hedging): https://banrep.gov.co/es/banco/junta-directiva/conceptos/jds-ca-11046
- Banco de la República, JDS-20095 (derivatives reporting): https://banrep.gov.co/es/banco/junta-directiva/conceptos/jds-20095
- Bitso Stellar receiving anchor: https://docs.bitso.com/mm-xb/docs/bitsos-stellar-receiving-anchor-services
- VANK Anchor (USDC-COP, SCF #43): https://communityfund.stellar.org/project/vank-anchor-usdc-cop-onoff-ramp-for-the-stellar-ecosystem-xeq
- Crebit (comparison baseline): https://www.crebitpay.com/
- Analysis doc: internal (Crebit comparison and rate-lock analysis)
