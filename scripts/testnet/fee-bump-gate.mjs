// Phase 1 gate: can a create_plan whose resource fee exceeds the uint32 inner fee
// field (2^32 - 1 stroops ~ 429.5 XLM) land as a fee-bump (int64 outer fee)?
// Simulates by default; pass --submit to send. Every attempt is logged to
// docs/demo-runs/2026-10-26-testnet/fee-bump-gate.json. Prints public keys only.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Account, Keypair, Horizon, Networks, Operation, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr, Address,
} from '@stellar/stellar-sdk';
import { loadTestnetEnv } from './preflight.mjs';

const RPC_URL = 'https://soroban-testnet.stellar.org';
const CONTRACT = 'CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP'; // Colombia
const UINT32_MAX = 4_294_967_295n;
const INCLUSION = 100n;
const SUBMIT = process.argv.includes('--submit');
const OUT_DIR = resolve(import.meta.dirname, '../../docs/demo-runs/2026-10-26-testnet');
const BUYERS_FILE = resolve(import.meta.dirname, '../../../../.env.testnet-demo-buyers');
const xlm = (stroops) => (Number(stroops) / 1e7).toFixed(7);

const server = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const keys = loadTestnetEnv();
const log = { phase: 'fee-bump-gate', date: '2026-10-26', contract: CONTRACT, submit: SUBMIT, attempts: [] };

const u32 = (n) => nativeToScVal(n, { type: 'u32' });
const struct = (fields) => xdr.ScVal.scvMap(
  [...fields].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })),
);

async function readOnly(fn, args = []) {
  const src = new Account(keys.feePayer.publicKey(), '0');
  const tx = new TransactionBuilder(src, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT, function: fn, args }))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
  return { value: scValToNative(sim.result.retval) };
}

async function main() {
  const cfg = await readOnly('get_config');
  const operatorOk = cfg.value?.operator === keys.operator.publicKey();
  log.config = { operator: cfg.value?.operator, operatorMatchesEnv: operatorOk, usdc: cfg.value?.usdc, payee: cfg.value?.payee_backend };
  if (!operatorOk && SUBMIT) throw new Error('contract operator does not match TESTNET_OPERATOR_SECRET');
  // Simulation does not check signatures, so a dry run can measure fees as the real operator.
  const operatorPub = cfg.value.operator;

  let planId = 26102600;
  while (!(await readOnly('get_status', [u32(planId)])).error) planId += 1;

  const buyer = Keypair.random();
  const now = Math.floor(Date.now() / 1000);
  const installments = xdr.ScVal.scvVec([1, 2, 3].map((m) => struct([
    ['cop_due', nativeToScVal(4_093_125n, { type: 'i128' })],
    ['due_ts', nativeToScVal(BigInt(now + m * 30 * 86_400), { type: 'u64' })],
  ])));
  const policy = struct([['grace_days', u32(0)], ['misses_before_default', u32(3)], ['penalty_bps', u32(1000)], ['refund_mode', u32(0)]]);
  const args = [u32(planId), new Address(buyer.publicKey()).toScVal(), installments, policy];
  Object.assign(log, { planId, installments: 3, buyer: buyer.publicKey() });

  const opAcct = await server.getAccount(operatorPub);
  const draft = new TransactionBuilder(opAcct, { fee: INCLUSION.toString(), networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT, function: 'create_plan', args }))
    .setTimeout(300).build();
  const sim = await server.simulateTransaction(draft);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  const resourceFee = BigInt(sim.minResourceFee);
  const sorobanData = sim.transactionData.build();
  log.simulation = {
    latestLedger: sim.latestLedger,
    resourceFeeStroops: resourceFee.toString(), resourceFeeXlm: xlm(resourceFee),
    totalFeeStroops: (resourceFee + INCLUSION).toString(), totalFeeXlm: xlm(resourceFee + INCLUSION),
    exceedsUint32: resourceFee + INCLUSION > UINT32_MAX,
    resources: sim.transactionData.build().resources,
  };

  // Attempt A: the normal path, which puts the whole fee in the uint32 inner field.
  try {
    rpc.assembleTransaction(draft, sim).build();
    log.attempts.push({ name: 'A: plain tx, assembleTransaction', outcome: 'built (fee fits uint32)' });
  } catch (e) {
    log.attempts.push({ name: 'A: plain tx, assembleTransaction', outcome: 'rejected at build', error: e.message });
  }

  // Attempt B: inner tx carries sorobanData (int64 resourceFee) with a minimal inner fee;
  // the fee-bump outer fee (int64) pays resource fee + inclusion for both envelopes.
  const fpBalance = (await horizon.loadAccount(keys.feePayer.publicKey())).balances.find((b) => b.asset_type === 'native').balance;
  const cap = BigInt(Math.floor(Number(fpBalance) * 1e7 * 0.6));
  const opAcct2 = await server.getAccount(operatorPub);
  const inner = new TransactionBuilder(opAcct2, { fee: INCLUSION.toString(), networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT, function: 'create_plan', args, auth: sim.result.auth }))
    .setSorobanData(sorobanData).setTimeout(300).build();
  if (SUBMIT) inner.sign(keys.operator);
  const outerTotal = resourceFee + INCLUSION * 4n; // generous inclusion; fee charged is what core computes
  const outerBase = (outerTotal + 1n) / 2n; // outer fee = base * (ops + 1)
  const attemptB = { name: 'B: fee-bump, inner fee 100 + sorobanData, outer int64 fee', innerFee: '100', outerFeeStroops: (outerBase * 2n).toString(), outerFeeXlm: xlm(outerBase * 2n), capStroops: cap.toString() };
  log.attempts.push(attemptB);
  if (outerBase * 2n > cap) { attemptB.outcome = 'not sent: above 60% of fee payer balance'; return; }
  let bump;
  try {
    bump = TransactionBuilder.buildFeeBumpTransaction(keys.feePayer, outerBase.toString(), inner, Networks.TESTNET);
    bump.sign(keys.feePayer);
  } catch (e) { attemptB.outcome = 'rejected at build'; attemptB.error = e.message; return; }
  if (!SUBMIT) { attemptB.outcome = 'built; not sent (simulate-only run)'; return; }

  appendFileSync(BUYERS_FILE, `# DEMO ONLY, testnet, plan ${planId} (Colombia gate) 2026-10-26\nDEMO_BUYER_${planId}_SECRET=${buyer.secret()}\n`);
  const sent = await server.sendTransaction(bump);
  attemptB.send = { status: sent.status, hash: sent.hash, errorResult: sent.errorResult ? sent.errorResult.toXDR('base64') : undefined };
  if (sent.status !== 'PENDING') { attemptB.outcome = `send ${sent.status}`; return; }
  const res = await server.pollTransaction(sent.hash, { attempts: 30 });
  attemptB.result = { status: res.status, ledger: res.ledger, createdAt: res.createdAt };
  if (res.status === 'SUCCESS') {
    const feeCharged = BigInt(res.resultXdr.feeCharged ?? res.resultXdr.feeCharged?.());
    Object.assign(attemptB.result, { feeChargedStroops: feeCharged.toString(), feeChargedXlm: xlm(feeCharged) });
    attemptB.outcome = 'SUCCESS';
  } else {
    attemptB.outcome = `on-chain ${res.status}`;
    attemptB.result.resultXdr = res.resultXdr ? res.resultXdr.toXDR?.('base64') ?? String(res.resultXdr) : undefined;
  }
}

try { await main(); } catch (e) { log.fatal = e.message; }
finally {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `fee-bump-gate${SUBMIT ? '' : '-dryrun'}.json`), JSON.stringify(log, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  console.log(JSON.stringify(log, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}
