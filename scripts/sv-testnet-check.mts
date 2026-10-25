// `npm run check:sv-testnet`: one throwaway USD plan on the live El Salvador instance, driven the
// way the services drive it. Creates a plan (random id, 3 installments of 45,000 cents in the
// `cop_due` field, DEMO_POLICY, compressed due dates like the bridge), mints and deposits
// 135,000 cents × 100,000 stroops, releases M1 with `release_spot` at exactly 4,500,000,000
// stroops, then reads the chain and checks: M1 Released, `usd_due` empty (the scope report's
// finding: a spot release records the amount only in the event), the payee balance moved by the
// exact amount, and the plan's events are `plan_created`, `deposited` and `released` only (no
// `lock_applied`). Prints every transaction with its hash, ledger, fee and explorer link.
//
// Reads `.env.testnet` only; prints public keys and contract ids, never a secret.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORRIDORS,
  CORRIDOR_BUYERS,
  ChainClient,
  DEMO_POLICY,
  TEST_USDC_CODE,
  TESTNET_HORIZON_URL,
  chainConfigFor,
  deployedWasmHash,
  explorerContractUrl,
  explorerTxUrl,
  parseDotenv,
  randomPlanId,
  seedBaseTs,
  stroopsToXlm,
  withoutVitePrefix,
  type CorridorId,
  type TxResult,
} from '../services/src/index.ts';
import { decodeEvent } from '../services/src/indexer/events.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.testnet');
const CORRIDOR = (process.env.CORRIDOR || 'sv') as CorridorId;
const CENTS_PER_INSTALLMENT = 45_000n;
const STROOPS_PER_CENT = 100_000n;
const INSTALLMENTS = 3;

if (!existsSync(ENV_FILE)) {
  console.error('.env.testnet not found: run `npm run deploy:testnet` and `npm run deploy:sv` first.');
  process.exit(1);
}
const env = withoutVitePrefix(parseDotenv(readFileSync(ENV_FILE, 'utf8')));
const corridor = CORRIDORS[CORRIDOR];
if (!env[corridor.chainEnv.contractIdKey]) {
  console.error(`${corridor.chainEnv.contractIdKey} is not set: run \`npm run deploy:sv\` first.`);
  process.exit(1);
}
const config = chainConfigFor(CORRIDOR, env);
const client = new ChainClient(config);
const horizonUrl = env.HORIZON_URL || TESTNET_HORIZON_URL;
const buyerId = CORRIDOR_BUYERS[CORRIDOR][0]!;

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const txLine = (label: string, r: TxResult<unknown>) =>
  log(`${label}: tx ${r.txHash} ledger ${r.ledger} fee ${r.feeCharged ?? '?'} stroops (${r.feeCharged != null ? stroopsToXlm(r.feeCharged) : '?'} XLM) ${explorerTxUrl(r.txHash)}`);
let failures = 0;
const check = (ok: boolean, what: string) => {
  log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
};

async function testUsdcBalance(publicKey: string): Promise<bigint> {
  const res = await fetch(`${horizonUrl}/accounts/${publicKey}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return 0n;
  const acct = (await res.json()) as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
  const b = acct.balances.find((x) => x.asset_code === TEST_USDC_CODE && x.asset_issuer === client.issuer.publicKey());
  if (!b) return 0n;
  const [whole, frac = ''] = b.balance.split('.');
  return BigInt(whole!) * 10_000_000n + BigInt(frac.padEnd(7, '0').slice(0, 7));
}

const wasm = await deployedWasmHash(client.submitter, config.contractId);
log(`${CORRIDOR} instance ${config.contractId} version ${await client.version()} wasm ${wasm} ${explorerContractUrl(config.contractId)}`);
log(`payee_backend ${config.payeeBackendPublic}; buyer ${buyerId} ${client.buyerPublic(buyerId)}`);

const planId = randomPlanId();
const base = seedBaseTs();
const inits = Array.from({ length: INSTALLMENTS }, (_, idx) => ({ dueTs: base + idx, copDue: CENTS_PER_INSTALLMENT }));
const total = CENTS_PER_INSTALLMENT * BigInt(INSTALLMENTS) * STROOPS_PER_CENT;
const m1 = CENTS_PER_INSTALLMENT * STROOPS_PER_CENT;
check(m1 === 4_500_000_000n, `M1 amount is exactly 4,500,000,000 stroops (45,000 cents × 100,000)`);

const payeeBefore = await testUsdcBalance(config.payeeBackendPublic);
const created = await client.createPlan(planId, buyerId, inits, DEMO_POLICY);
txLine(`create_plan #${planId} (${INSTALLMENTS} × ${CENTS_PER_INSTALLMENT} cents, DEMO_POLICY)`, created);
const minted = await client.mintTestUsdc(client.buyerPublic(buyerId), total);
txLine(`mint ${total} stroops of test USDC to the buyer`, minted);
const deposited = await client.deposit(buyerId, planId, total);
txLine(`deposit ${total} stroops`, deposited);
const released = await client.releaseSpot(planId, 0, m1);
txLine(`release_spot M1 ${m1} stroops`, released);
check(released.result === m1, `release_spot returned ${released.result} stroops`);

const status = await client.getStatus(planId);
const row = status.installments[0]!;
check(row.status === 'released', `M1 status on chain is ${row.status}`);
check(row.usdDue == null, `M1 usd_due is ${row.usdDue == null ? 'empty' : String(row.usdDue)} (a spot release records the amount only in the event)`);
check(row.copDue === CENTS_PER_INSTALLMENT, `M1 cop_due holds ${row.copDue} cents`);
check(row.lockId == null && row.lockedRate == null, 'M1 has no lock id and no locked rate');
check(status.installments.slice(1).every((i) => i.status === 'open'), 'M2 and M3 are open');
check(status.plan.balanceUsdc === total - m1, `plan balance is ${status.plan.balanceUsdc} stroops (deposit minus M1)`);
check(status.governance.totalReleased === m1 && status.governance.totalDeposited === total, `governance totals: deposited ${status.governance.totalDeposited}, released ${status.governance.totalReleased}`);

const payeeAfter = await testUsdcBalance(config.payeeBackendPublic);
check(payeeAfter - payeeBefore === m1, `payee balance moved by ${payeeAfter - payeeBefore} stroops (${stroopsToXlm(payeeAfter - payeeBefore)} USDC)`);

// Events of this plan, read from the RPC between the create ledger and the release ledger.
const events = await client.submitter.server.getEvents({
  startLedger: created.ledger,
  filters: [{ type: 'contract', contractIds: [config.contractId] }],
  limit: 200,
});
const mine = events.events.map(decodeEvent).filter((e) => e.planId === planId);
const names = mine.map((e) => e.name);
log(`events of plan #${planId}: ${names.join(', ')}`);
check(names.length === 3 && names[0] === 'plan_created' && names[1] === 'deposited' && names[2] === 'released', 'events are plan_created, deposited, released only');
check(!names.some((n) => n === 'lock_applied' || n === 'lock_broken'), 'no lock event was emitted');
const rel = mine.find((e) => e.name === 'released');
check(rel?.data.usd_amount === String(m1) && Boolean(rel?.data.spot), `released event carries usd_amount ${String(rel?.data.usd_amount)} and spot=${String(rel?.data.spot)}`);

const fees = [created, minted, deposited, released].reduce((a, r) => a + (r.feeCharged ?? 0n), 0n);
log(`fees charged for the four transactions: ${fees} stroops (${stroopsToXlm(fees)} XLM)`);
log(failures === 0 ? `SV TESTNET CHECK OK (plan #${planId} left on the instance; complete_plan not needed)` : `SV TESTNET CHECK FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
