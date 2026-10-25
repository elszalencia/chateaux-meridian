// `npm run smoke:testnet` (or `npx tsx scripts/testnet-smoke.mts`): drives the testnet stack from
// Node against `.env.testnet`, the way the UI does: reset (re-seeds the three plans on chain),
// quote + accept María's Q3 lock, "+1 mes", pay M4, then reads the chain to confirm M4 Released and
// M7–M9 Locked. Prints every transaction with its explorer link and the timings.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChainClient,
  PLAN_MARIA,
  TestnetBridge,
  chainConfigFromEnv,
  chainPlansFromEnv,
  createTestnetApi,
  explorerContractUrl,
  explorerTxUrl,
  parseDotenv,
  type ChainBridge,
  type Installment,
  type Plan,
  type SeedPlanState,
} from '../services/src/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.testnet');
if (!existsSync(ENV_FILE)) {
  console.error('.env.testnet not found: run `npm run deploy:testnet` first.');
  process.exit(1);
}
const env = parseDotenv(readFileSync(ENV_FILE, 'utf8'));
const config = chainConfigFromEnv(env);
const client = new ChainClient(config);
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const timed = async <T,>(label: string, run: () => Promise<T>): Promise<T> => {
  const s = Date.now();
  const out = await run();
  log(`${label}: ${((Date.now() - s) / 1000).toFixed(1)} s`);
  return out;
};

// The bridge used by the UI, with per-step logging of the seed replay.
const inner = new TestnetBridge(client);
const bridge: ChainBridge = {
  contractId: inner.contractId,
  async seedPlan(plan: Plan, installments: Installment[], seedState: SeedPlanState) {
    const r = await inner.seedPlan(plan, installments, seedState);
    for (const s of r.steps) log(`  ${plan.id} ${s.label}: ${s.ms} ms ${explorerTxUrl(s.txHash)}`);
    log(`${plan.id} → chain plan #${r.chainPlanId} in ${(r.elapsedMs / 1000).toFixed(1)} s`);
    return r;
  },
  deposit: (b, p, s) => inner.deposit(b, p, s),
  applyLock: (a) => inner.applyLock(a),
  releaseDue: (p, i) => inner.releaseDue(p, i),
  releaseSpot: (p, i, s) => inner.releaseSpot(p, i, s),
  breakLock: (p, i) => inner.breakLock(p, i),
  getStatus: (p) => inner.getStatus(p),
};

log(`contract ${config.contractId} version ${await client.version()} ${explorerContractUrl(config.contractId)}`);
const api = createTestnetApi({ chain: bridge, chainPlans: chainPlansFromEnv(env), minDelayMs: 0, maxDelayMs: 0 });

const { state, elapsedMs } = await timed('reset (3 plans re-seeded on chain)', () => api.reset());
log(`reset reported ${(elapsedMs / 1000).toFixed(1)} s; chain plans ${JSON.stringify(state.chainPlans)}`);
const mariaChainId = state.chainPlans![PLAN_MARIA]!;

const quote = await timed('quoteLock Q3', () => api.quoteLock(PLAN_MARIA, 'trimestral'));
log(`  idxs ${quote.idxs.join(',')} locked rate ${quote.lockedRate} USD ${quote.usdPerInstallment}`);
const afterLock = await timed('acceptLock (apply_lock on chain)', () => api.acceptLock(quote.lock.id));
log(`  M7–M9 now ${afterLock.installments.slice(6, 9).map((i) => i.cellState).join(', ')}`);

const s1 = await timed('advanceClock(1)', () => api.advanceClock(1));
log(`  today ${s1.today}`);

const receipt = await timed('pay M4 (mint + deposit + release_due)', () => api.pay(PLAN_MARIA, 3, (step) => log(`  step ${step}`)));
log(`  receipt USD ${receipt.usdPaid} at ${receipt.lockedRate} → COP ${receipt.copDelivered}`);
log(`  release tx ${receipt.txHash}`);
log(`  ${explorerTxUrl(receipt.txHash)}`);

const status = await timed('get_status (simulation)', () => client.getStatus(mariaChainId));
const st = (idx: number) => status.installments[idx]!.status;
log(`  chain plan #${mariaChainId}: balance ${status.plan.balanceUsdc} stroops; M4 ${st(3)}; M7–M9 ${[6, 7, 8].map(st).join(', ')}`);
const ok = st(3) === 'released' && [6, 7, 8].every((i) => st(i) === 'locked');
log(ok ? 'SMOKE OK' : 'SMOKE FAILED: unexpected chain state');
process.exit(ok ? 0 : 1);
