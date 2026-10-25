// `npm run deploy:testnet`: prepares Stellar testnet for the demo and writes `.env.testnet` at the
// repo root. Idempotent: an existing `.env.testnet` is read first and every step that already holds
// (funded account, trustline, SAC, uploaded Wasm, contract running that Wasm, seeded plans in their
// step-1 state) is skipped. When the contract runs an older Wasm than contracts/target holds, it is
// upgraded in place (`upgrade` + `migrate`, admin = operator) and keeps its address and plans.
// `--fresh` deploys a new contract instance and new plans while keeping the accounts.
//
// The test asset is `USDC:<usdc_issuer>` issued by a throwaway testnet account: it only shares the
// code with Circle's USDC so the contract and the UI exercise the same path as the real asset (see
// docs/RUNNING.md for why the plans do not use Circle's testnet USDC). Buyers also get a trustline
// to Circle's testnet USDC, which the SDF test anchor pays out on a SEP-24 deposit.
//
// Every value is server-side: only VITE_DEMO_MODE carries the VITE_ prefix, so no key reaches the
// browser bundle. A file written before the server existed (VITE_-prefixed names) is migrated.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Asset, Keypair, hash } from '@stellar/stellar-sdk';
import {
  ChainError,
  BUYER_ENV_KEYS,
  CHANNEL_COUNT,
  ChainClient,
  PLAN_ENV_KEYS,
  Submitter,
  TEST_USDC_CODE,
  TESTNET_HORIZON_URL,
  TESTNET_PASSPHRASE,
  TESTNET_RPC_URL,
  TestnetBridge,
  buildSeed,
  checkChainPlans,
  deployPaymentPlan,
  deployedWasmHash,
  ensureFunded,
  ensureSac,
  ensureTrustlines,
  ensureWasm,
  explorerAccountUrl,
  explorerContractUrl,
  explorerTxUrl,
  hexOf,
  mapLimit,
  parseDotenv,
  stroopsToAmountString,
  withoutVitePrefix,
  type ChainClientConfig,
} from '../services/src/index.ts';
import { CIRCLE_TESTNET_USDC_ISSUER } from '../services/src/adapters/sep24OnRamp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.testnet');
const WASM_FILE = path.join(ROOT, 'contracts', 'target', 'wasm32v1-none', 'release', 'payment_plan.wasm');
const fresh = process.argv.includes('--fresh');
/** Test USDC the payee_backend keeps as float for SEP-31 payouts (it is refilled by releases). */
const PAYEE_FLOAT_MIN = 5_000n * 10_000_000n;
const PAYEE_FLOAT_TOPUP = 25_000n * 10_000_000n;

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const existing = existsSync(ENV_FILE) ? withoutVitePrefix(parseDotenv(readFileSync(ENV_FILE, 'utf8'))) : {};
const rpcUrl = existing.STELLAR_RPC_URL || TESTNET_RPC_URL;
const passphrase = existing.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE;
const horizonUrl = existing.HORIZON_URL || TESTNET_HORIZON_URL;
const submitter = new Submitter({ rpcUrl, networkPassphrase: passphrase });

if (!(await submitter.health())) {
  console.error(`RPC ${rpcUrl} is not healthy; aborting.`);
  process.exit(1);
}

// ---------- keys ----------
const keyOf = (envKey: string, label: string): Keypair => {
  const secret = existing[envKey];
  if (secret) return Keypair.fromSecret(secret);
  log(`${label}: generating key`);
  return Keypair.random();
};
const operator = keyOf('OPERATOR_SECRET', 'operator');
const payee = keyOf('PAYEE_BACKEND_SECRET', 'payee_backend');
const issuer = keyOf('USDC_ISSUER_SECRET', 'usdc_issuer');
const receiver = keyOf('RECEIVER_SECRET', 'receiver (simulated Colombian anchor)');
const buyers: Record<string, Keypair> = {};
for (const [buyerId, suffix] of Object.entries(BUYER_ENV_KEYS)) buyers[buyerId] = keyOf(`BUYER_SECRET_${suffix}`, buyerId);
const channels: Keypair[] = [];
for (let n = 1; n <= CHANNEL_COUNT; n += 1) channels.push(keyOf(`CHANNEL_SECRET_${n}`, `channel ${n}`));
const everyone: [string, Keypair][] = [
  ['operator', operator],
  ['payee_backend', payee],
  ['usdc_issuer', issuer],
  ['receiver', receiver],
  ...Object.entries(buyers),
  ...channels.map((k, i): [string, Keypair] => [`channel_${i + 1}`, k]),
];

// ---------- funding ----------
const funded = await mapLimit(everyone, 4, async ([label, k]) => [label, await ensureFunded(submitter, k.publicKey())] as const);
const newly = funded.filter(([, r]) => r === 'funded').map(([l]) => l);
log(newly.length ? `funded by friendbot: ${newly.join(', ')}` : `all ${everyone.length} accounts already funded`);

// ---------- test asset, trustlines, SAC ----------
const asset = new Asset(TEST_USDC_CODE, issuer.publicKey());
const holders = [operator, payee, receiver, ...Object.values(buyers)];
const tl = await ensureTrustlines(submitter, operator, holders, asset);
log(tl.created.length ? `test USDC trustlines created for ${tl.created.length} account(s): ${explorerTxUrl(tl.tx!.txHash)}` : 'test USDC trustlines already in place');
const circle = new Asset('USDC', CIRCLE_TESTNET_USDC_ISSUER);
const tlc = await ensureTrustlines(submitter, operator, Object.values(buyers), circle);
log(tlc.created.length ? `Circle testnet USDC trustlines (SEP-24 on-ramp) for ${tlc.created.length} buyer(s): ${explorerTxUrl(tlc.tx!.txHash)}` : 'Circle testnet USDC trustlines already in place');
const sac = await ensureSac(submitter, operator, asset);
log(`USDC SAC ${sac.sacId}: ${sac.deployed ? `deployed ${explorerTxUrl(sac.tx!.txHash)}` : 'already deployed'}`);

// ---------- wasm + contract ----------
if (!existsSync(WASM_FILE)) {
  console.error(`missing ${WASM_FILE}; run \`cd contracts && stellar contract build\``);
  process.exit(1);
}
const wasm = new Uint8Array(readFileSync(WASM_FILE));
const localHash = hexOf(hash(Buffer.from(wasm)));
// The upload can be refused when testnet rent makes it cost more than one transaction can carry
// (FeeTooHigh). A running contract then keeps its current Wasm and the upgrade is deferred to a
// later run; a new deployment cannot proceed without the upload.
let up: Awaited<ReturnType<typeof ensureWasm>> | null = null;
let uploadBlocked = '';
try {
  up = await ensureWasm(submitter, operator, wasm);
  log(`payment_plan wasm ${localHash}: ${up.uploaded ? `uploaded ${explorerTxUrl(up.tx!.txHash)}` : 'already on ledger'}`);
} catch (e) {
  if (!(e instanceof ChainError) || e.errorName !== 'FeeTooHigh') throw e;
  uploadBlocked = e.message;
  log(`payment_plan wasm ${localHash}: upload refused, ${e.message}`);
}

const baseConfig = (contractId: string): ChainClientConfig => ({
  rpcUrl,
  networkPassphrase: passphrase,
  contractId,
  usdcSacId: sac.sacId,
  usdcIssuerSecret: issuer.secret(),
  operatorSecret: operator.secret(),
  buyers: Object.fromEntries(Object.entries(buyers).map(([id, k]) => [id, k.secret()])),
  payeeBackendPublic: payee.publicKey(),
  channelSecrets: channels.map((k) => k.secret()),
});

// ---------- .env.testnet ----------
// Written as soon as the contract exists (so a crash while seeding never loses the generated keys)
// and again once the plans are seeded. INDEXER_START_LEDGER is the deploy ledger of a fresh
// contract; empty for a reused one, so the indexer reads back as far as the RPC retains events.
let indexerStartLedger = fresh ? '' : existing.INDEXER_START_LEDGER || '';
function writeEnv(contractId: string, chainPlans: Record<string, number>): void {
  const lines = [
    '# Casa Puente testnet demo. Written by `npm run deploy:testnet`; gitignored (.env.*). Testnet only.',
    '# Every key below is read by the Node server and the scripts only. VITE_DEMO_MODE is the one value',
    '# Vite exposes to the browser; `npm run check:bundle` fails if a secret ever reaches the bundle.',
    'VITE_DEMO_MODE=testnet',
    `STELLAR_RPC_URL=${rpcUrl}`,
    `STELLAR_NETWORK_PASSPHRASE=${passphrase}`,
    `HORIZON_URL=${horizonUrl}`,
    `PAYMENT_PLAN_CONTRACT_ID=${contractId}`,
    `INDEXER_START_LEDGER=${indexerStartLedger}`,
    `USDC_SAC_ID=${sac.sacId}`,
    `USDC_ISSUER=${issuer.publicKey()}`,
    `USDC_ISSUER_SECRET=${issuer.secret()}`,
    `OPERATOR_PUBLIC=${operator.publicKey()}`,
    `OPERATOR_SECRET=${operator.secret()}`,
    `PAYEE_BACKEND_PUBLIC=${payee.publicKey()}`,
    `PAYEE_BACKEND_SECRET=${payee.secret()}`,
    `RECEIVER_SECRET=${receiver.secret()}`,
    `OFFRAMP_HOME_URL=${existing.OFFRAMP_HOME_URL || 'http://localhost:8788'}`,
    `ONRAMP_HOME_DOMAIN=${existing.ONRAMP_HOME_DOMAIN || 'testanchor.stellar.org'}`,
    ...Object.entries(BUYER_ENV_KEYS).flatMap(([buyerId, suffix]) => [
      `BUYER_PUBLIC_${suffix}=${buyers[buyerId]!.publicKey()}`,
      `BUYER_SECRET_${suffix}=${buyers[buyerId]!.secret()}`,
    ]),
    ...channels.map((k, i) => `CHANNEL_SECRET_${i + 1}=${k.secret()}`),
    ...Object.entries(PLAN_ENV_KEYS)
      .filter(([planId]) => chainPlans[planId] != null)
      .map(([planId, suffix]) => `CHAIN_PLAN_${suffix}=${chainPlans[planId]}`),
    '',
  ];
  writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
  log(`wrote ${ENV_FILE}`);
}

let contractId = fresh ? '' : existing.PAYMENT_PLAN_CONTRACT_ID || '';
let contractReused = false;
if (contractId) {
  try {
    const v = await new ChainClient(baseConfig(contractId)).version();
    log(`contract ${contractId} answers version ${v}: reusing`);
    contractReused = true;
  } catch (e) {
    log(`contract ${contractId} did not answer version (${e instanceof Error ? e.message : e}); deploying a new one`);
    contractId = '';
  }
}
if (!contractId) {
  if (!up) {
    console.error(`cannot deploy a new contract: ${uploadBlocked}`);
    process.exit(1);
  }
  const d = await deployPaymentPlan(submitter, operator, up.wasmHash, {
    admin: operator.publicKey(),
    operator: operator.publicKey(),
    usdc: sac.sacId,
    payeeBackend: payee.publicKey(),
  });
  contractId = d.contractId;
  indexerStartLedger = String(d.tx.ledger);
  log(`payment_plan deployed at ${contractId}: ${explorerTxUrl(d.tx.txHash)}`);
}
const client = new ChainClient(baseConfig(contractId));

// A reused contract running an older Wasm is upgraded in place, then migrated.
if (contractReused) {
  const running = await deployedWasmHash(submitter, contractId);
  if (!running) throw new Error(`could not read the Wasm hash of ${contractId}; refusing to guess whether it needs an upgrade`);
  if (running !== localHash && !up) {
    log(`upgrade deferred: the contract keeps Wasm ${running.slice(0, 12)}… (local ${localHash.slice(0, 12)}…); rerun deploy:testnet when testnet rent allows the upload`);
  } else if (running !== localHash && up) {
    const before = await client.version();
    const u = await client.upgrade(up.wasmHash);
    log(`upgrade ${running.slice(0, 12)}… → ${localHash.slice(0, 12)}…: ${explorerTxUrl(u.txHash)}`);
    const m = await client.migrate();
    log(`migrate: schema version ${before} → ${m.result}: ${explorerTxUrl(m.txHash)}`);
  } else {
    log(`contract runs the local Wasm (${localHash.slice(0, 12)}…): no upgrade needed`);
  }
}

const previousPlans: Record<string, number> = {};
for (const [planId, suffix] of Object.entries(PLAN_ENV_KEYS)) {
  const v = existing[`CHAIN_PLAN_${suffix}`];
  if (contractReused && v && /^\d+$/.test(v)) previousPlans[planId] = Number(v);
}
writeEnv(contractId, previousPlans);

// ---------- payee float for SEP-31 payouts ----------
async function testUsdcBalance(publicKey: string): Promise<bigint> {
  const res = await fetch(`${horizonUrl}/accounts/${publicKey}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return 0n;
  const acct = (await res.json()) as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
  const b = acct.balances.find((x) => x.asset_code === TEST_USDC_CODE && x.asset_issuer === issuer.publicKey());
  if (!b) return 0n;
  const [whole, frac = ''] = b.balance.split('.');
  return BigInt(whole!) * 10_000_000n + BigInt(frac.padEnd(7, '0').slice(0, 7));
}
const float = await testUsdcBalance(payee.publicKey());
if (float < PAYEE_FLOAT_MIN) {
  const m = await client.mintTestUsdc(payee.publicKey(), PAYEE_FLOAT_TOPUP);
  log(`payee_backend float ${stroopsToAmountString(float)} → +${stroopsToAmountString(PAYEE_FLOAT_TOPUP)} test USDC: ${explorerTxUrl(m.txHash)}`);
} else {
  log(`payee_backend float ${stroopsToAmountString(float)} test USDC: enough`);
}

// ---------- seed plans ----------
const chainPlans: Record<string, number> = {};
if (Object.keys(previousPlans).length > 0) {
  const checks = await checkChainPlans(previousPlans, (id) => client.getStatus(id));
  for (const c of checks) {
    if (c.pristine) {
      chainPlans[c.planId] = c.chainPlanId;
      log(`${c.planId}: chain plan #${c.chainPlanId} is in the step-1 state: reusing`);
    } else {
      log(`${c.planId}: chain plan #${c.chainPlanId} cannot be reused (${c.reason}): re-seeding`);
    }
  }
}
const seedStart = Date.now();
const seed = buildSeed();
// Only the plans with a chain mapping go on chain; the adverse-event demo plans stay mock-seed only.
const toSeed = seed.plans.filter((pl) => pl.id in PLAN_ENV_KEYS && chainPlans[pl.id] == null);
if (toSeed.length > 0) {
  const bridge = new TestnetBridge(client);
  const results = await Promise.all(
    toSeed.map(async (plan) => {
      const installments = seed.installments.filter((i) => i.planId === plan.id);
      const seedState = { locks: seed.locks.filter((l) => l.planId === plan.id), receipts: seed.receipts.filter((r) => r.planId === plan.id) };
      return [plan.id, await bridge.seedPlan(plan, installments, seedState)] as const;
    }),
  );
  for (const [planId, r] of results) {
    chainPlans[planId] = r.chainPlanId;
    for (const s of r.steps) log(`  ${planId} ${s.label}: ${s.ms} ms ${explorerTxUrl(s.txHash)}`);
    log(`${planId} seeded as chain plan #${r.chainPlanId} in ${(r.elapsedMs / 1000).toFixed(1)} s (${r.steps.length} transactions)`);
  }
  log(`${toSeed.length} plan(s) seeded in parallel in ${((Date.now() - seedStart) / 1000).toFixed(1)} s`);
}

writeEnv(contractId, chainPlans);

// ---------- summary ----------
console.log('');
console.log('Casa Puente on Stellar testnet');
const runningHash = (await deployedWasmHash(submitter, contractId)) ?? localHash;
console.log(`  payment_plan contract  ${contractId} (schema ${await client.version()}, wasm ${runningHash.slice(0, 16)}…${runningHash !== localHash ? ', upgrade deferred' : ''})`);
console.log(`                         ${explorerContractUrl(contractId)}`);
console.log(`  USDC (test) SAC        ${sac.sacId}`);
console.log(`                         ${explorerContractUrl(sac.sacId)}`);
for (const [label, k] of everyone.filter(([l]) => !l.startsWith('channel_'))) {
  console.log(`  ${label.padEnd(22)} ${k.publicKey()}`);
  console.log(`                         ${explorerAccountUrl(k.publicKey())}`);
}
console.log(`  channel accounts       ${channels.length}`);
for (const [planId, id] of Object.entries(chainPlans)) console.log(`  ${planId.padEnd(22)} chain plan #${id}`);
console.log(`  elapsed                ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('Next: `npm run demo:testnet` (server on :8787, UI on http://localhost:5174).');
