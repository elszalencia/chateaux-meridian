// `npm run deploy:sv`: a second `payment_plan` instance on Stellar testnet for a corridor with its
// own payee (El Salvador by default), deployed from the Wasm hash that is already installed on the
// network. Nothing is uploaded: `create_contract` from an installed hash writes one new ledger
// entry (the instance), which is what keeps this possible while a Wasm upload is blocked by
// testnet rent (docs/STELLAR_NORMS.md, 2026-10-24/25). The constructor runs with
// (admin = operator, operator, usdc = the platform test USDC SAC, payee_backend = the corridor's payee).
//
// Idempotent: the corridor's payee and buyer keys are reused from `.env.testnet` when present,
// funding and trustlines are skipped when they already hold, and an existing instance that answers
// and runs the expected Wasm is kept. The fee is simulated and reported BEFORE anything is sent;
// when it does not fit in one transaction the script stops, writes the keys it created, and
// reports that exactly (the services then keep that corridor off chain).
//
// Reads `.env.testnet` (migrating VITE_-prefixed names like deploy:testnet does) and writes it back
// complete: every existing key is kept, the corridor's keys are added. No value is ever printed
// except public keys and contract ids.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Asset, Keypair } from '@stellar/stellar-sdk';
import {
  ALL_PLAN_ENV_KEYS,
  BUYER_ENV_KEYS,
  CHANNEL_COUNT,
  CORRIDORS,
  CORRIDOR_BUYERS,
  ChainClient,
  Submitter,
  TEST_USDC_CODE,
  TESTNET_HORIZON_URL,
  TESTNET_PASSPHRASE,
  TESTNET_RPC_URL,
  bytesOfHex,
  chainConfigFor,
  deployPaymentPlan,
  deployedWasmHash,
  ensureFunded,
  ensureTrustlines,
  explorerAccountUrl,
  explorerContractUrl,
  explorerTxUrl,
  mapLimit,
  parseDotenv,
  simulateDeployFee,
  stroopsToXlm,
  wasmExists,
  withoutVitePrefix,
  type CorridorId,
} from '../services/src/index.ts';
import { CIRCLE_TESTNET_USDC_ISSUER } from '../services/src/adapters/sep24OnRamp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.testnet');
/** The corridor whose instance this run deploys; the El Salvador one unless CORRIDOR says otherwise. */
const CORRIDOR = (process.env.CORRIDOR || 'sv') as CorridorId;
/**
 * Wasm hash the Colombia contract runs and the only payment_plan Wasm installed on testnet
 * (docs/RUNNING.md "Deployed contract"). The new instance must run exactly this hash; the newer
 * local build was never uploaded and must not be.
 */
const INSTALLED_WASM_HASH = 'a28d240c3728f3415b73218597bb4b9f23c77384c4d7beda77a57300e88755b1';

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const fail = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};

if (!CORRIDORS[CORRIDOR]) fail(`unknown corridor ${CORRIDOR}`);
const keys = CORRIDORS[CORRIDOR].chainEnv;
if (!existsSync(ENV_FILE)) fail('.env.testnet not found: run `npm run deploy:testnet` first (it creates the operator, the test USDC and the Colombia instance).');
const existing: Record<string, string> = Object.fromEntries(
  Object.entries(withoutVitePrefix(parseDotenv(readFileSync(ENV_FILE, 'utf8')))).filter((kv): kv is [string, string] => typeof kv[1] === 'string'),
);
const need = (k: string): string => existing[k] ?? fail(`${k} is not set in .env.testnet; run \`npm run deploy:testnet\` first`);
const rpcUrl = existing.STELLAR_RPC_URL || TESTNET_RPC_URL;
const passphrase = existing.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE;
const horizonUrl = existing.HORIZON_URL || TESTNET_HORIZON_URL;
const submitter = new Submitter({ rpcUrl, networkPassphrase: passphrase });
if (!(await submitter.health())) fail(`RPC ${rpcUrl} is not healthy; aborting.`);

const operator = Keypair.fromSecret(need('OPERATOR_SECRET'));
const issuer = Keypair.fromSecret(need('USDC_ISSUER_SECRET'));
const usdcSacId = need('USDC_SAC_ID');
const referenceContractId = need('PAYMENT_PLAN_CONTRACT_ID');

// ---------- keys of this corridor ----------
const keyOf = (envKey: string, label: string): Keypair => {
  const secret = existing[envKey];
  if (secret) return Keypair.fromSecret(secret);
  log(`${label}: generating key`);
  return Keypair.random();
};
const payee = keyOf(keys.payeeSecretKey, `payee_backend (${CORRIDOR})`);
const buyers: Record<string, Keypair> = {};
for (const buyerId of CORRIDOR_BUYERS[CORRIDOR]) buyers[buyerId] = keyOf(`BUYER_SECRET_${BUYER_ENV_KEYS[buyerId]}`, buyerId);
const accounts: [string, Keypair][] = [[`payee_backend_${CORRIDOR}`, payee], ...Object.entries(buyers)];

// ---------- funding and trustlines ----------
const funded = await mapLimit(accounts, 4, async ([label, k]) => [label, await ensureFunded(submitter, k.publicKey())] as const);
const newly = funded.filter(([, r]) => r === 'funded').map(([l]) => l);
log(newly.length ? `funded by friendbot: ${newly.join(', ')}` : `all ${accounts.length} accounts already funded`);
const asset = new Asset(TEST_USDC_CODE, issuer.publicKey());
const tl = await ensureTrustlines(submitter, operator, [payee, ...Object.values(buyers)], asset);
log(tl.created.length ? `test USDC trustlines created for ${tl.created.length} account(s): ${explorerTxUrl(tl.tx!.txHash)}` : 'test USDC trustlines already in place');
const circle = new Asset('USDC', CIRCLE_TESTNET_USDC_ISSUER);
const tlc = await ensureTrustlines(submitter, operator, Object.values(buyers), circle);
log(tlc.created.length ? `Circle testnet USDC trustlines (SEP-24 on-ramp) for ${tlc.created.length} buyer(s): ${explorerTxUrl(tlc.tx!.txHash)}` : 'Circle testnet USDC trustlines already in place');

// ---------- .env.testnet writer (complete file, nothing dropped) ----------
function writeEnv(values: Record<string, string>): void {
  const order = [
    'STELLAR_RPC_URL',
    'STELLAR_NETWORK_PASSPHRASE',
    'HORIZON_URL',
    'PAYMENT_PLAN_CONTRACT_ID',
    'INDEXER_START_LEDGER',
    'USDC_SAC_ID',
    'USDC_ISSUER',
    'USDC_ISSUER_SECRET',
    'OPERATOR_PUBLIC',
    'OPERATOR_SECRET',
    'PAYEE_BACKEND_PUBLIC',
    'PAYEE_BACKEND_SECRET',
    'RECEIVER_SECRET',
    'OFFRAMP_HOME_URL',
    'ONRAMP_HOME_DOMAIN',
    ...Object.values(BUYER_ENV_KEYS).flatMap((s) => [`BUYER_PUBLIC_${s}`, `BUYER_SECRET_${s}`]),
    ...Array.from({ length: CHANNEL_COUNT }, (_, i) => `CHANNEL_SECRET_${i + 1}`),
    ...Object.values(ALL_PLAN_ENV_KEYS).map((s) => `CHAIN_PLAN_${s}`),
    keys.contractIdKey,
    `INDEXER_START_LEDGER_${CORRIDOR.toUpperCase()}`,
    keys.payeePublicKey,
    keys.payeeSecretKey,
  ];
  const seen = new Set<string>(['VITE_DEMO_MODE']);
  const lines = [
    '# Chateaux testnet demo. Written by `npm run deploy:testnet` and `npm run deploy:sv`; gitignored (.env.*). Testnet only.',
    '# Every key below is read by the Node server and the scripts only. VITE_DEMO_MODE is the one value',
    '# Vite exposes to the browser; `npm run check:bundle` fails if a secret ever reaches the bundle.',
    'VITE_DEMO_MODE=testnet',
  ];
  for (const k of order) {
    if (seen.has(k) || values[k] === undefined) continue;
    seen.add(k);
    lines.push(`${k}=${values[k]}`);
  }
  for (const k of Object.keys(values).sort()) {
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`${k}=${values[k]}`);
  }
  lines.push('');
  writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
  log(`wrote ${ENV_FILE}`);
}
const values: Record<string, string> = { ...existing, STELLAR_RPC_URL: rpcUrl, STELLAR_NETWORK_PASSPHRASE: passphrase, HORIZON_URL: horizonUrl };
values[keys.payeePublicKey] = payee.publicKey();
values[keys.payeeSecretKey] = payee.secret();
for (const [buyerId, k] of Object.entries(buyers)) {
  values[`BUYER_PUBLIC_${BUYER_ENV_KEYS[buyerId]}`] = k.publicKey();
  values[`BUYER_SECRET_${BUYER_ENV_KEYS[buyerId]}`] = k.secret();
}
// Keys first: a failure below never loses what was generated.
writeEnv(values);

// ---------- the installed Wasm ----------
const referenceHash = await deployedWasmHash(submitter, referenceContractId);
if (referenceHash !== INSTALLED_WASM_HASH) {
  fail(`the reference instance ${referenceContractId} runs Wasm ${referenceHash ?? '(unreadable)'}, expected ${INSTALLED_WASM_HASH}; refusing to deploy from a hash this script does not know`);
}
const wasmHash = bytesOfHex(INSTALLED_WASM_HASH);
if (!(await wasmExists(submitter, wasmHash))) fail(`Wasm ${INSTALLED_WASM_HASH} is not installed on ${rpcUrl}; no upload is allowed by this script`);
log(`installed Wasm ${INSTALLED_WASM_HASH} confirmed on the ledger (the Colombia instance runs it too)`);

// ---------- the instance ----------
const constructorArgs = { admin: operator.publicKey(), operator: operator.publicKey(), usdc: usdcSacId, payeeBackend: payee.publicKey() };
let contractId = existing[keys.contractIdKey] || '';
let deployed: { txHash: string; ledger: number; feeCharged: bigint | null; simulated: bigint; simulatedTotal: bigint } | null = null;
if (contractId) {
  const running = await deployedWasmHash(submitter, contractId);
  if (running === INSTALLED_WASM_HASH) {
    const cfg = chainConfigFor(CORRIDOR, { ...values, [keys.contractIdKey]: contractId });
    const config = await new ChainClient(cfg).read<{ payee_backend: string; operator: string }>('get_config');
    if (String(config.payee_backend) !== payee.publicKey()) {
      log(`WARNING: instance ${contractId} pays ${String(config.payee_backend)}, not the configured payee ${payee.publicKey()}; keeping it (delete ${keys.contractIdKey} from .env.testnet to deploy a new one)`);
    }
    log(`instance ${contractId} exists and runs the installed Wasm: reusing`);
  } else {
    log(`instance ${contractId} ${running ? `runs Wasm ${running.slice(0, 12)}…` : 'is not readable'}; deploying a new one`);
    contractId = '';
  }
}
if (!contractId) {
  const fee = await simulateDeployFee(submitter, operator.publicKey(), wasmHash, constructorArgs);
  log(`simulated create_contract from the installed hash: minResourceFee ${fee.minResourceFee} stroops (${stroopsToXlm(fee.minResourceFee)} XLM), total with base fee ${fee.totalFee} stroops (${stroopsToXlm(fee.totalFee)} XLM), ledger ${fee.latestLedger}`);
  if (!fee.fits) {
    fail(
      `STOP: the instance deploy needs ${stroopsToXlm(fee.totalFee)} XLM, more than one transaction can carry (429.4967295 XLM). ` +
        `No instance was deployed; keys were written to .env.testnet. Keep one instance and map the ${CORRIDOR} payee off-chain.`,
      2,
    );
  }
  const d = await deployPaymentPlan(submitter, operator, wasmHash, constructorArgs);
  contractId = d.contractId;
  deployed = { txHash: d.tx.txHash, ledger: d.tx.ledger, feeCharged: d.tx.feeCharged ?? null, simulated: fee.minResourceFee, simulatedTotal: fee.totalFee };
  values[`INDEXER_START_LEDGER_${CORRIDOR.toUpperCase()}`] = String(d.tx.ledger);
  log(`payment_plan (${CORRIDOR}) deployed at ${contractId} on ledger ${d.tx.ledger}: ${explorerTxUrl(d.tx.txHash)}`);
  log(`fee charged ${deployed.feeCharged ?? '?'} stroops (${deployed.feeCharged != null ? stroopsToXlm(deployed.feeCharged) : '?'} XLM)`);
}
values[keys.contractIdKey] = contractId;
writeEnv(values);

const runningHash = await deployedWasmHash(submitter, contractId);
if (runningHash !== INSTALLED_WASM_HASH) fail(`instance ${contractId} runs Wasm ${runningHash ?? '(unreadable)'}, not ${INSTALLED_WASM_HASH}`);
const client = new ChainClient(chainConfigFor(CORRIDOR, values));
const version = await client.version();
const config = await client.read<{ payee_backend: string; operator: string; usdc: string; admin: string }>('get_config');

// ---------- summary ----------
console.log('');
console.log(`Chateaux on Stellar testnet: ${CORRIDOR} instance`);
console.log(`  payment_plan (${CORRIDOR})      ${contractId} (schema ${version}, wasm ${runningHash})`);
console.log(`                         ${explorerContractUrl(contractId)}`);
console.log(`  payment_plan (reference) ${referenceContractId} (same wasm)`);
console.log(`  payee_backend (${CORRIDOR})     ${String(config.payee_backend)}`);
console.log(`                         ${explorerAccountUrl(String(config.payee_backend))}`);
console.log(`  operator / admin       ${String(config.operator)}`);
console.log(`  USDC (test) SAC        ${String(config.usdc)}`);
for (const [buyerId, k] of Object.entries(buyers)) {
  console.log(`  ${buyerId.padEnd(22)} ${k.publicKey()}`);
  console.log(`                         ${explorerAccountUrl(k.publicKey())}`);
}
if (deployed) {
  console.log(`  deploy tx              ${deployed.txHash} (ledger ${deployed.ledger})`);
  console.log(`                         ${explorerTxUrl(deployed.txHash)}`);
  console.log(`  fee simulated          ${deployed.simulated} stroops resource (${stroopsToXlm(deployed.simulated)} XLM); ${deployed.simulatedTotal} stroops total (${stroopsToXlm(deployed.simulatedTotal)} XLM)`);
  console.log(`  fee charged            ${deployed.feeCharged ?? '?'} stroops (${deployed.feeCharged != null ? stroopsToXlm(deployed.feeCharged) : '?'} XLM)`);
} else {
  console.log('  deploy tx              none (instance reused)');
}
console.log(`  elapsed                ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('Next: `npm run check:sv-testnet` (one throwaway plan on this instance), then `npm run demo:testnet`.');
