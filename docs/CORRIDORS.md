# Corridors

A **corridor** is the route a buyer's money takes: the country where the property is, the currency
the installments are owed in, how the buyer can pay, who receives the money at the other end, and
which business-day calendar sets grace and credit dates. Every plan belongs to one corridor
(`plans.corridor`). Today there are two:

| | Colombia (`co`) | El Salvador (`sv`) |
| --- | --- | --- |
| Installment currency | COP | USD |
| Conversion leg | USD → COP through the off-ramp | none (USD end to end) |
| Rate lock | yes | no |
| Payee | the buyer's encargo at Fidudavivienda | the seller's account (option A or B) |
| Contract instance | `PAYMENT_PLAN_CONTRACT_ID` | `PAYMENT_PLAN_CONTRACT_ID_SV` (`CC5Y77X35KBPB773DE2JCYDWAXI3MHVKZ7HXF5R3QCRRSDO46PLNLEBQ`) |

Both instances run the same Wasm. Everything that differs between corridors comes from one file,
`config/corridors.ts`, which the services read through `corridorOf(plan)` and the web app reads
through `@casa-puente/services`. No component or service branches on a country literal. The
`corridors` table (migration `20261025120000_corridors_and_sv_schema.sql`) mirrors the same values
for SQL readers; when the two disagree, `config/corridors.ts` is the source.

## Config fields

| Field | Meaning |
| --- | --- |
| `id`, `country` | Corridor key (`co`, `sv`) and ISO 3166-1 country code. Data, not a branch key. |
| `nameKey` | i18n key of the corridor's display name. |
| `currency`, `decimals` | Installment currency and its minor-unit digits. Amount fields keep their historical names (`copDue`, `installmentCop`, `priceCop`, the contract's `cop_due`) and hold the corridor's minor unit: whole pesos (0) or US cents (2). |
| `locksEnabled` | Rate lock offered. When false the services refuse `quoteLock`, `acceptLock` and `apply_lock` with `LOCKS_DISABLED` before any provider or chain call (`assertLocksEnabled`). |
| `hedgeEnabled` | Treasury hedge legs and NDF settlement follow the lock. |
| `holidays` | Business-day calendar (`CO`, `SV`) for grace, cutoffs and payout credit dates (`services/src/domain/holidays.ts`). |
| `graceBusinessDays` | Business days of grace after a due date, counted on `holidays`. The daily adverse-events job uses the same count (`beyondGraceIn`). |
| `payWindowDays` | Days before the due date from which the buyer may pay. |
| `payMethods` | Pay methods offered, in pay-sheet order: `moneygram_cash`, `office_counter`, `ach`. |
| `feesUsd` | Flat buyer-side fee per method, USD. |
| `payoutProviders` | Payout rails: `sep31-receiver` (CO), `usdc-hold` (option A), `usd-bank-payout` (option B). |
| `payoutTargetKey` | i18n key of the payout target label ("Encargo Fidudavivienda" / "Cuenta del vendedor"). |
| `receiptFields` | Receipt rows, in order. |
| `paySteps` | Progress steps of a payment (`recibido`, `convertido`, `entregado`). |
| `views` | Which office views and buyer features exist (Constructora, Tesorería, lock, pay ahead, the CNR badge). |
| `whatsappTemplates` | Message templates the corridor sends (mock WhatsApp channel). |
| `reminderDaysBefore` | Days before the due date the reminder goes out. |
| `moneyGram` | Cash-in limits, excluded states, reference lifetime and the pending alert; null without a cash network. |
| `chainEnv` | Names of the environment variables holding the instance's contract id and payee keys (server only; never values). |
| `partners` | Seller-side partner and cash network shown on office screens, always marked "simulado". |

## Values

| Field | `co` | `sv` |
| --- | --- | --- |
| currency / decimals | COP / 0 | USD / 2 |
| locksEnabled / hedgeEnabled | true / true | false / false |
| holidays | CO | SV |
| graceBusinessDays | 5 | 5 |
| payWindowDays | 0 | 5 |
| payMethods | office_counter, ach | moneygram_cash, office_counter, ach |
| feesUsd | 0, 0, 0 | moneygram_cash 4.99, office_counter 0, ach 1.50 |
| payoutProviders | sep31-receiver | usdc-hold, usd-bank-payout |
| payoutTargetKey | corridors.co.payoutTarget | corridors.sv.payoutTarget |
| receiptFields | usdPaid, lockedRate, todayRate, usdAtToday, copDelivered, fee, fxDeclarationRef | usdPaid, fee, usdDelivered, payoutStatus, method, seller, unit |
| paySteps | recibido, convertido, entregado | recibido, entregado |
| views | constructora, tesorería, lock, payAhead | propertyVerification (CNR badge) |
| whatsappTemplates | recordatorio, pago_recibido, pago_entregado, pago_atrasado, plan_en_pausa, renovacion_bloqueo | recordatorio, referencia_moneygram, pago_recibido, pago_entregado, pago_atrasado, plan_en_pausa |
| reminderDaysBefore | 5 | 5 |
| moneyGram | null | min 5, max 950 USD; excluded AK, HI, LA, NY; reference 60 min; pending alert 10 min |
| chainEnv | PAYMENT_PLAN_CONTRACT_ID, PAYEE_BACKEND_SECRET, PAYEE_BACKEND_PUBLIC | PAYMENT_PLAN_CONTRACT_ID_SV, PAYEE_BACKEND_SV_SECRET, PAYEE_BACKEND_SV_PUBLIC |
| partners | Fidudavivienda | Davivienda Salvadoreño; cash network MoneyGram |

## El Salvador holidays 2026–2028

Días de asueto remunerado, nationwide. Nothing moves to a Monday: a holiday on a weekend is absorbed
by the weekend. Semana Santa is Thursday, Friday and Saturday before Easter Sunday (Easter 2026-04-05,
2027-03-28, 2028-04-16). The 3 and 5 of August are asuetos only inside the city of San Salvador
(art. 190, second paragraph) and are not national bank holidays, so they are not in the calendar.

| | 2026 | 2027 | 2028 |
| --- | --- | --- | --- |
| Año Nuevo | Thu 01-01 | Fri 01-01 | Sat 01-01 |
| Jueves Santo | Thu 04-02 | Thu 03-25 | Thu 04-13 |
| Viernes Santo | Fri 04-03 | Fri 03-26 | Fri 04-14 |
| Sábado Santo | Sat 04-04 | Sat 03-27 | Sat 04-15 |
| Día del Trabajo | Fri 05-01 | Sat 05-01 | Mon 05-01 |
| Día de la Madre | Sun 05-10 | Mon 05-10 | Wed 05-10 |
| Día del Padre | Wed 06-17 | Thu 06-17 | Sat 06-17 |
| Divino Salvador del Mundo | Thu 08-06 | Fri 08-06 | Sun 08-06 |
| Independencia | Tue 09-15 | Wed 09-15 | Fri 09-15 |
| Fieles Difuntos | Mon 11-02 | Tue 11-02 | Thu 11-02 |
| Navidad | Fri 12-25 | Sat 12-25 | Mon 12-25 |

The same dates are in `EL_SALVADOR_HOLIDAYS` (`services/src/domain/holidays.ts`), tested in
`holidays.test.ts`. Sources, read 2026-10-25:

- Código de Trabajo, art. 190 (Decreto Legislativo 15 of 1972, consolidated text): 1 January;
  Thursday, Friday and Saturday of Semana Santa; 1 May; 6 August; 15 September; 2 November;
  25 December; and 3 and 5 August in the city of San Salvador. Corte Suprema de Justicia,
  <https://www.csj.gob.sv/wp-content/uploads/2021/06/11-Código-de-Trabajo-de-El-Salvador-Días-de-asueto.pdf>
  (the PDF returned HTTP 404 on 2026-10-25; the list was confirmed through its indexed text and
  <https://diario.elmundo.sv/economia/que-dias-son-los-asuetos-remunerados-en-2025>).
- Día de la Madre, 10 May: Decreto Legislativo 339 of 2016 extends the asueto beyond public
  employees, <https://www.jurisprudencia.gob.sv/DocumentosBoveda/D/2/2010-2019/2016/04/B815C.PDF>
  (operative article not read in full; confidence medium), and El Mundo's 2025 list includes it.
- Día del Padre, 17 June: Decreto Legislativo 208 of 2012, public and private sector,
  <https://diario.elmundo.sv/nacionales/el-74-de-los-salvadorenos-considera-la-celebracion-del-dia-del-padre-como-una-fecha-importante>.
- One-off asuetos decreed for a single year (for example a presidential inauguration) are not in
  the calendar; add them as they are decreed.

Business-day math outside 2026–2028 ignores holidays (`holidayYearsCoveredFor('SV')`). Extend the
table before 2029.

## MoneyGram cash-in

- Limits: USD 5 minimum and USD 950 maximum per reference; not offered to buyers in Alaska, Hawaii,
  Louisiana or New York; a reference stays payable 60 minutes; a cash-in still pending after
  10 minutes is flagged on the office screens.
- Source: the scope report of 2026-10-25 (not committed to this repo). On 2026-10-25 the public
  pages did not publish the numbers: <https://developers.stellar.org/docs/tools/ramps/moneygram>
  and <https://developer.moneygram.com/moneygram-developer/docs/integrate-moneygram-ramps> point to
  the partner portal, which needs a partner account. The state exclusion matches a secondary report
  of the Ramps product page (<https://capwolf.com/moneygram-solana-cash-ramps-reach-170-markets/>).
  **TO VERIFY** with MoneyGram sandbox keys; the values live only in config, so a change is one edit.
- Fee: USD 4.99 per reference (config, demo figure).
- The mock (`MoneyGramOnRamp`, driver `mock`) is shaped like the Widget SDK (session,
  `customerIdentifier`, postMessage events, status webhooks). It credits the plan only on
  `completed`, never on `pending`; an expired reference becomes `quote_expired` and the buyer is
  offered a new one. On testnet the SDF test anchor stands in for the cash network.
- A cash payment above USD 950 is allowed at the office counter (`office_counter`), which is not
  bound by the MoneyGram limit.

## Seller payouts: options A and B

A release (`release_spot` on the corridor's instance, at exactly cents × 100,000 stroops) moves the
installment to the corridor's payee. The seller's payout option decides what happens next:

| | Option A: USDC hold | Option B: USD to bank |
| --- | --- | --- |
| Provider | `UsdcHold` | `UsdBankPayout` |
| Where the money goes | stays as USDC at the seller's custody-provider address | USD transfer to the seller's account at a Salvadoran bank through the redemption partner (Davivienda Salvadoreño, simulated) |
| Statuses | `transferido` | `enviado` → `en_transito` → `acreditado`, or `error` |
| Credit date | immediate | 0–3 business days on the SV calendar |
| Fees | none | partner fee 0 (the buyer-side method fee is charged before the payout) |

Every payout keeps the reconciliation line `usd_to_seller = usd_paid − fee_usd`; the `payouts`
table enforces it with a check constraint. Office screens may say USDC only in Vendedores and
Pagos al vendedor; buyer screens never do.

## Seller gate

`sellerGate` (`services/src/sellers/gate.ts`) runs at the service layer before every release and
again when a held payout is retried. A release is held (payout status `retenido`, with a typed
reason the UI explains) when the seller is:

| Reason | When |
| --- | --- |
| `seller_unverified` | verification `pending`, or no payout account yet |
| `seller_paused` | verification `paused` |
| `seller_rejected` | verification `rejected` (final) |
| `seller_cooling_off` | a payout-account change is inside its 72-hour cooling-off |
| `cnr_alert` | a unit of the seller has a lien registered at the CNR ("Nuevo gravamen inscrito"); the seller's plans go on hold |

Tests: `services/src/sellers/gate.test.ts` and the gate cases in `DemoApi.sv.test.ts`.

## Testnet behaviour

Each corridor runs on its own contract instance; a plan's chain calls always go to the instance of
its corridor (`services/src/chain/routing.test.ts`). Creating a plan on testnet currently costs more
than one transaction can carry (see the norms ledger, 2026-10-25): a reset keeps a plan's existing
chain plan when the instance still holds it, and otherwise runs the plan off chain, recorded in
`demo_state.simulatedPlans` with the reason and shown as "simulado". Nothing is retried.

## Adding a corridor

1. `config/corridors.ts`: add the id to `CorridorId` and `CORRIDOR_IDS`, and a full `Corridor`
   entry. TypeScript refuses a missing field.
2. Holidays: add the calendar code to `HolidayCalendar` and its dates (with sources) to
   `services/src/domain/holidays.ts`; add a test like `holidays.test.ts`; list the dates and sources
   here.
3. Database: a new migration that inserts the `corridors` row and widens the `corridors.id` check
   constraint. Never edit an existing migration. Run `npm run check:db`.
4. Chain: name the instance's variables in `chainEnv`, deploy an instance from the installed Wasm
   hash (no new upload; see `scripts/deploy-sv-instance.mts` for the pattern) and list the new
   variable names (never values) in docs/RUNNING.md. Add the corridor's demo buyers to
   `CORRIDOR_BUYERS` and plan keys to the env maps in `services/src/chain/env.ts`.
5. Rails: if the corridor pays out differently, add a `SellerPayoutProvider` or `OffRampProvider`
   behind the existing interfaces; if it has a cash network, fill `moneyGram` (or a sibling field).
6. Web: i18n keys for `nameKey`, `payoutTargetKey` and every template in `whatsappTemplates`, in
   both `es` and `en`.
7. Seed: fixtures for the new corridor in `services/src/seed/`, with a test that every seeded
   outbox link equals `deepLinkFor(template, plan)`.
8. Tests: services, `check:db`, and a grep that no component branches on the new country code.
