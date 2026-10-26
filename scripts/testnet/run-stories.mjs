// Gates G2-G4 and the live-demo plan pool on the 2026-10-26 testnet instances.
// Usage (tsx, so the services' corridor guard can be imported):
//   node node_modules/tsx/dist/cli.mjs scripts/testnet/run-stories.mjs <g2|g3|g4|pool>
// Every transaction is appended to docs/demo-runs/2026-10-26-testnet/stories.json.
// Plans are created by the operator (inner tx) in fee-bumps paid by the pool account; buyer
// deposits are fee-bumped by the fee payer. Demo buyer keys are testnet-only (.env.testnet-generated).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Asset, Operation, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { loadTestnetEnv } from './preflight.mjs';
import { RUN_DIR, ensureFunded, generatedKey, horizon, json, read, server, submit } from './lib.mjs';

export const CONTRACTS = {
  co: 'CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV',
  sv: 'CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF',
};
const CO_DUE = 4_093_125n; // pesos per installment
const CO_RATE = 34_444_270_000n; // 3444.427 COP/USD x 1e7
const CO_M1_STROOPS = 11_883_326_312n; // floor(4,093,125 x 1e14 / rate) = USD 1,188.33
const SV_DUE_CENTS = 75_000n; // USD 750.00 per installment
const SV_M1_STROOPS = SV_DUE_CENTS * 100_000n;
const MAX_FEE = 1_000_000_000n; // 100 XLM per tx: far above the measured fees, far below 60% of any account

const OUT = resolve(RUN_DIR, 'stories.json');
const state = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { date: '2026-10-26', contracts: CONTRACTS, steps: [], plans: {} };
const save = () => writeFileSync(OUT, json(state) + '\n');
const keys = loadTestnetEnv();
const usdc = new Asset('USDC', keys.usdIssuer.publicKey());

const u32 = (n) => nativeToScVal(n, { type: 'u32' });
const struct = (fields) => xdr.ScVal.scvMap(
  [...fields].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })),
);
const stroopsToAmount = (s) => `${s / 10_000_000n}.${(s % 10_000_000n).toString().padStart(7, '0')}`;

async function step(corridor, args) {
  try {
    const r = await submit({ maxFeeStroops: MAX_FEE, ...args });
    Object.assign(r, { corridor, contract: args.invoke?.contract ?? null });
    state.steps.push(r); save();
    console.log(`${r.step}: ${r.hash} ledger ${r.ledger} fee ${r.feeChargedXlm} XLM${r.returnValue !== undefined ? ` -> ${json(r.returnValue)}` : ''}`);
    return r;
  } catch (e) {
    if (e.rec) { state.steps.push({ ...e.rec, corridor, failed: true }); save(); }
    throw e;
  }
}

/** A testnet demo buyer: funded, with a USDC trustline and `mint` stroops of test USDC. */
async function demoBuyer(name, mint) {
  const kp = generatedKey(`DEMO_BUYER_${name}_SECRET`, `demo buyer ${name} (Modo demo; the platform acts for the buyer)`);
  await ensureFunded(kp.publicKey());
  const acct = await horizon.loadAccount(kp.publicKey());
  const line = acct.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === keys.usdIssuer.publicKey());
  const corridor = name.startsWith('CO') ? 'colombia' : 'el_salvador';
  if (!line) {
    await step(corridor, { step: `trustline_buyer_${name}`, source: kp, signers: [kp], soroban: false, op: Operation.changeTrust({ asset: usdc }) });
  }
  const have = line ? BigInt(Math.round(Number(line.balance) * 1e7)) : 0n;
  if (have < mint) {
    await step(corridor, {
      step: `mint_usdc_${name}`, source: keys.usdIssuer, signers: [keys.usdIssuer], soroban: false,
      op: Operation.payment({ destination: kp.publicKey(), asset: usdc, amount: stroopsToAmount(mint - have) }),
    });
  }
  return kp;
}

/** Installment 1 already due (yesterday); 2 and 3 in 30 and 60 days. create_plan accepts past due_ts. */
async function createPlan(corridor, planId, buyer, amount) {
  const now = Math.floor(Date.now() / 1000);
  const dues = [now - 86_400, now + 30 * 86_400, now + 60 * 86_400];
  const installments = xdr.ScVal.scvVec(dues.map((d) => struct([
    ['cop_due', nativeToScVal(amount, { type: 'i128' })],
    ['due_ts', nativeToScVal(BigInt(d), { type: 'u64' })],
  ])));
  const policy = struct([['grace_days', u32(0)], ['misses_before_default', u32(3)], ['penalty_bps', u32(1000)], ['refund_mode', u32(0)]]);
  const r = await step(corridor === 'co' ? 'colombia' : 'el_salvador', {
    step: `create_plan_${corridor}_${planId}`, source: keys.operator, signers: [keys.operator], feeBumpBy: keys.pool[0],
    invoke: { contract: CONTRACTS[corridor], function: 'create_plan', args: [u32(planId), new Address(buyer.publicKey()).toScVal(), installments, policy] },
  });
  state.plans[planId] = { corridor, contract: CONTRACTS[corridor], buyer: buyer.publicKey(), dueTs: dues, installmentAmount: amount.toString(), createTx: r.hash };
  save();
  return r;
}

const deposit = (corridor, planId, buyer, amount) => step(corridor === 'co' ? 'colombia' : 'el_salvador', {
  step: `deposit_${corridor}_${planId}`, source: buyer, signers: [buyer], feeBumpBy: keys.feePayer,
  invoke: { contract: CONTRACTS[corridor], function: 'deposit', args: [u32(planId), nativeToScVal(amount, { type: 'i128' })] },
});

async function g2() {
  const buyer = generatedKey('DEMO_BUYER_CO_1_SECRET', 'demo buyer CO_1 (Modo demo; the platform acts for the buyer)');
  await ensureFunded(buyer.publicKey());
  const r = await createPlan('co', 1001, buyer, CO_DUE);
  const tx = await server.getTransaction(r.hash);
  state.g2 = { hash: r.hash, getTransaction: { status: tx.status, ledger: tx.ledger, createdAt: tx.createdAt, feeBump: tx.feeBump }, feeChargedXlm: r.feeChargedXlm };
  const plan = await read(CONTRACTS.co, 'get_status', [u32(1001)], keys.feePayer.publicKey());
  state.g2.installmentsOnChain = plan.value?.installments?.length;
  save();
  console.log('G2 getTransaction', json(state.g2));
  if (tx.status !== 'SUCCESS' || state.g2.installmentsOnChain !== 3) throw new Error('G2 failed');
}

async function g3() {
  const buyer = await demoBuyer('CO_1', CO_M1_STROOPS);
  await deposit('co', 1001, buyer, CO_M1_STROOPS);
  const lockId = createHash('sha256').update('chateaux-testnet-2026-10-26-lock-1001').digest();
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  await step('colombia', {
    step: 'apply_lock_co_1001_quarterly', source: keys.operator, signers: [keys.operator], authSigners: [buyer],
    invoke: {
      contract: CONTRACTS.co, function: 'apply_lock',
      args: [u32(1001), xdr.ScVal.scvVec([0, 1, 2].map(u32)), nativeToScVal(lockId), nativeToScVal(CO_RATE, { type: 'i128' }), nativeToScVal(expiry, { type: 'u64' })],
    },
  });
  const r = await step('colombia', {
    step: 'release_due_co_1001_M1', source: keys.operator, signers: [keys.operator],
    invoke: { contract: CONTRACTS.co, function: 'release_due', args: [u32(1001), u32(0)] },
  });
  state.g3 = { released: String(r.returnValue), expected: CO_M1_STROOPS.toString(), ok: BigInt(r.returnValue) === CO_M1_STROOPS };
  save();
  console.log('G3', json(state.g3));
  if (!state.g3.ok) throw new Error('G3 released amount mismatch');
}

async function g4() {
  const buyer = await demoBuyer('SV_1', SV_M1_STROOPS);
  if (!state.plans[2001]) await createPlan('sv', 2001, buyer, SV_DUE_CENTS);
  await deposit('sv', 2001, buyer, SV_M1_STROOPS);
  const r = await step('el_salvador', {
    step: 'release_spot_sv_2001_M1', source: keys.operator, signers: [keys.operator],
    invoke: { contract: CONTRACTS.sv, function: 'release_spot', args: [u32(2001), u32(0), nativeToScVal(SV_M1_STROOPS, { type: 'i128' })] },
  });
  // Service-layer guard: apply_lock is refused for the SV corridor before any transaction is built.
  const { assertLocksEnabled } = await import('../../services/src/corridors/index.ts');
  let refusal = null;
  try { assertLocksEnabled({ corridor: 'sv' }); } catch (e) { refusal = { name: e.name, code: e.code, corridor: e.corridor, message: e.message }; }
  state.g4 = { released: String(r.returnValue), expected: SV_M1_STROOPS.toString(), ok: BigInt(r.returnValue) === SV_M1_STROOPS, applyLockRefusal: refusal, transactionsBuiltForLock: 0 };
  save();
  console.log('G4', json(state.g4));
  if (!state.g4.ok || refusal?.code !== 'LOCKS_DISABLED') throw new Error('G4 failed');
}

async function pool() {
  state.pool ??= [];
  for (const [corridor, base, amount, mint] of [['co', 1100, CO_DUE, 12_500_000_000n], ['sv', 2100, SV_DUE_CENTS, SV_M1_STROOPS]]) {
    for (let i = 1; i <= 3; i++) {
      const planId = base + i;
      if (state.pool.some((p) => p.planId === planId)) continue;
      const buyer = await demoBuyer(`${corridor.toUpperCase()}_P${i}`, mint);
      const r = await createPlan(corridor, planId, buyer, amount);
      const st = await read(CONTRACTS[corridor], 'get_status', [u32(planId)], keys.feePayer.publicKey());
      const due0 = Number(st.value.installments[0].due_ts);
      state.pool.push({
        planId, corridor: corridor === 'co' ? 'colombia' : 'el_salvador', contract: CONTRACTS[corridor], buyer: buyer.publicKey(),
        buyerUsdcStroops: mint.toString(), installmentAmount: amount.toString(), amountUnit: corridor === 'co' ? 'COP' : 'USD cents',
        m1DueTs: due0, m1Due: due0 <= Math.floor(Date.now() / 1000), createTx: r.hash, createLedger: r.ledger, createFeeXlm: r.feeChargedXlm,
      });
      save();
    }
  }
  writeFileSync(resolve(RUN_DIR, 'pool.json'), json({
    date: '2026-10-26',
    note: 'Live-demo plan pool. Each buyer is a testnet-only demo account (Modo demo: the platform acts for the buyer) holding the test USDC for M1; M1 is already due. Deposit, lock (Colombia) and release run live in the tour.',
    plans: state.pool,
  }) + '\n');
  console.log(json(state.pool.map((p) => [p.planId, p.corridor, p.m1Due, p.createFeeXlm])));
}

const cmd = process.argv[2];
const run = { g2, g3, g4, pool }[cmd];
if (!run) { console.error('usage: run-stories.mjs <g2|g3|g4|pool>'); process.exit(2); }
run().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
