// Gates G2-G4 and the live-demo plan pool on the 2026-10-26 testnet instances.
// Usage (tsx, so the services' corridor guard can be imported):
//   node node_modules/tsx/dist/cli.mjs scripts/testnet/run-stories.mjs <g2|g3|g4|headline|pool|pool-prep> [--set a28d|8d2a]
// `--set` picks the instance pair (default a28d, the first run; 8d2a is the headline pair).
// Every transaction is appended to the set's state file in docs/demo-runs/2026-10-26-testnet/.
// Plans are created by the operator (inner tx) in fee-bumps paid by the pool account; buyer
// deposits are fee-bumped by the fee payer. Demo buyer keys are testnet-only (.env.testnet-generated).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Asset, Operation, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { loadTestnetEnv } from './preflight.mjs';
import { RUN_DIR, ensureFunded, generatedKey, horizon, json, read, server, submit } from './lib.mjs';

const SETS = {
  a28d: {
    contracts: { co: 'CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV', sv: 'CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF' },
    stateFile: 'stories.json', poolFile: 'pool.json', poolBase: { co: 1100, sv: 2100 }, poolBuyer: 'P', headline: { co: 1001, sv: 2001 },
  },
  '8d2a': {
    contracts: { co: 'CA3NE2EXQLDDDXUZCAEWX2UFUMCWI4CYS32YGXQHLTJE7KTRW35D6WD2', sv: 'CACDLCHAKPJDVYRKJKK3KKMEBLBKLTYISYX6EQO54VQIZJX3CTUTVQGA' },
    stateFile: 'stories-8d2a.json', poolFile: 'pool-8d2a.json', poolBase: { co: 1200, sv: 2200 }, poolBuyer: 'Q', headline: { co: 1004, sv: 2004 },
  },
};
const setArg = process.argv.indexOf('--set');
const SET_NAME = setArg > 0 ? process.argv[setArg + 1] : 'a28d';
const SET = SETS[SET_NAME];
if (!SET) { console.error(`unknown --set ${SET_NAME}`); process.exit(2); }
export const CONTRACTS = SET.contracts;
const CO_DUE = 4_093_125n; // pesos per installment
const CO_RATE = 34_444_270_000n; // 3444.427 COP/USD x 1e7
const CO_M1_STROOPS = 11_883_326_312n; // floor(4,093,125 x 1e14 / rate) = USD 1,188.33
const SV_DUE_CENTS = 75_000n; // USD 750.00 per installment
const SV_M1_STROOPS = SV_DUE_CENTS * 100_000n;
const MAX_FEE = 1_000_000_000n; // 100 XLM per tx: far above the measured fees, far below 60% of any account

const OUT = resolve(RUN_DIR, SET.stateFile);
const state = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { date: '2026-10-26', set: SET_NAME, contracts: CONTRACTS, steps: [], plans: {} };
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

/** Lock expiry: the due date of the last locked installment + 7 days. */
async function lockExpiry(planId, idxs) {
  const st = await read(CONTRACTS.co, 'get_status', [u32(planId)], keys.feePayer.publicKey());
  const last = st.value.installments[idxs[idxs.length - 1]];
  return BigInt(last.due_ts) + 7n * 86_400n;
}

async function applyQuarterlyLock(planId, buyer, expiry) {
  const idxs = [0, 1, 2];
  expiry ??= await lockExpiry(planId, idxs);
  const lockId = createHash('sha256').update(`chateaux-testnet-2026-10-26-lock-${planId}`).digest();
  const r = await step('colombia', {
    step: `apply_lock_co_${planId}_quarterly`, source: keys.operator, signers: [keys.operator], authSigners: [buyer],
    invoke: {
      contract: CONTRACTS.co, function: 'apply_lock',
      args: [u32(planId), xdr.ScVal.scvVec(idxs.map(u32)), nativeToScVal(lockId), nativeToScVal(CO_RATE, { type: 'i128' }), nativeToScVal(expiry, { type: 'u64' })],
    },
  });
  r.lockExpiryTs = Number(expiry);
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
  // Recorded 2026-10-26 with expiry = now + 30 d, which is before M3's due date (now + 60 d).
  // The plan cannot be re-locked (apply_lock needs Open installments), so 1001 stays as recorded.
  await applyQuarterlyLock(1001, buyer, BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400));
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
  for (const [corridor, base, amount, mint] of [['co', SET.poolBase.co, CO_DUE, 12_500_000_000n], ['sv', SET.poolBase.sv, SV_DUE_CENTS, SV_M1_STROOPS]]) {
    for (let i = 1; i <= 3; i++) {
      const planId = base + i;
      if (state.pool.some((p) => p.planId === planId)) continue;
      const buyer = await demoBuyer(`${corridor.toUpperCase()}_${SET.poolBuyer}${i}`, mint);
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
  writeFileSync(resolve(RUN_DIR, SET.poolFile), json({
    date: '2026-10-26',
    note: 'Live-demo plan pool. Each buyer is a testnet-only demo account (Modo demo: the platform acts for the buyer) holding the test USDC for M1; M1 is already due. Deposit, lock (Colombia) and release run live in the tour.',
    plans: state.pool,
  }) + '\n');
  console.log(json(state.pool.map((p) => [p.planId, p.corridor, p.m1Due, p.createFeeXlm])));
}

/** Pool prep: Colombia plans deposited for M1 and locked (expiry = last locked due + 7 d), so the
 *  live step is one release_due(idx 0); El Salvador plans deposited for M1 (live: release_spot). */
async function poolPrep() {
  for (const p of state.pool) {
    const co = p.corridor === 'colombia';
    const name = `${co ? 'CO' : 'SV'}_${SET.poolBuyer}${p.planId % 10}`;
    const buyer = generatedKey(`DEMO_BUYER_${name}_SECRET`, `demo buyer ${name}`);
    if (buyer.publicKey() !== p.buyer) throw new Error(`buyer key mismatch for plan ${p.planId}`);
    const st = await read(p.contract, 'get_status', [u32(p.planId)], keys.feePayer.publicKey());
    const amount = co ? CO_M1_STROOPS : SV_M1_STROOPS;
    if (BigInt(st.value.plan.balance_usdc) < amount) {
      const r = await deposit(co ? 'co' : 'sv', p.planId, buyer, amount);
      p.depositTx = r.hash;
    }
    if (co && st.value.installments[0].status !== 1 && !p.lockTx) {
      const r = await applyQuarterlyLock(p.planId, buyer);
      Object.assign(p, { lockTx: r.hash, lockExpiryTs: r.lockExpiryTs, lockedUsdM1Stroops: CO_M1_STROOPS.toString() });
    }
    p.liveStep = co ? 'release_due(idx 0)' : `release_spot(idx 0, ${SV_M1_STROOPS})`;
    save();
  }
  writeFileSync(resolve(RUN_DIR, SET.poolFile), json({
    date: '2026-10-26',
    note: 'Live-demo plan pool. Each buyer is a testnet-only demo account (Modo demo: the platform acts for the buyer). M1 is already due and deposited; Colombia plans are locked at 3444.427 with expiry = last locked due + 7 days. The live step is one release per plan.',
    plans: state.pool,
  }) + '\n');
  console.log(json(state.pool.map((p) => [p.planId, p.depositTx, p.lockTx ?? '-', p.liveStep])));
}

/** Headline stories on the set's pair: Colombia (create, deposit, lock with the fixed expiry,
 *  release_due M1) and El Salvador (create, deposit, release_spot M1, service lock refusal). */
async function headline() {
  const { co: coId, sv: svId } = SET.headline;
  state.headline ??= {};
  const coBuyer = await demoBuyer(`CO_${coId % 1000}`, CO_M1_STROOPS);
  if (!state.plans[coId]) await createPlan('co', coId, coBuyer, CO_DUE);
  const created = await server.getTransaction(state.plans[coId].createTx);
  if (created.status !== 'SUCCESS') throw new Error(`create_plan ${coId} not SUCCESS`);
  await deposit('co', coId, coBuyer, CO_M1_STROOPS);
  const lock = await applyQuarterlyLock(coId, coBuyer);
  const rel = await step('colombia', {
    step: `release_due_co_${coId}_M1`, source: keys.operator, signers: [keys.operator],
    invoke: { contract: CONTRACTS.co, function: 'release_due', args: [u32(coId), u32(0)] },
  });
  state.headline.colombia = {
    planId: coId, contract: CONTRACTS.co, createTx: state.plans[coId].createTx, createGetTransaction: created.status, feeBump: created.feeBump,
    lockExpiryTs: lock.lockExpiryTs, lockExpiryRule: 'M3 due + 7 days', released: String(rel.returnValue), expected: CO_M1_STROOPS.toString(),
    ok: BigInt(rel.returnValue) === CO_M1_STROOPS,
  };
  save();
  console.log('headline colombia', json(state.headline.colombia));
  if (!state.headline.colombia.ok) throw new Error('Colombia release mismatch');

  const svBuyer = await demoBuyer(`SV_${svId % 1000}`, SV_M1_STROOPS);
  if (!state.plans[svId]) await createPlan('sv', svId, svBuyer, SV_DUE_CENTS);
  await deposit('sv', svId, svBuyer, SV_M1_STROOPS);
  const spot = await step('el_salvador', {
    step: `release_spot_sv_${svId}_M1`, source: keys.operator, signers: [keys.operator],
    invoke: { contract: CONTRACTS.sv, function: 'release_spot', args: [u32(svId), u32(0), nativeToScVal(SV_M1_STROOPS, { type: 'i128' })] },
  });
  const { assertLocksEnabled } = await import('../../services/src/corridors/index.ts');
  let refusal = null;
  try { assertLocksEnabled({ corridor: 'sv' }); } catch (e) { refusal = { name: e.name, code: e.code, corridor: e.corridor, message: e.message }; }
  state.headline.el_salvador = {
    planId: svId, contract: CONTRACTS.sv, released: String(spot.returnValue), expected: SV_M1_STROOPS.toString(),
    ok: BigInt(spot.returnValue) === SV_M1_STROOPS, applyLockRefusal: refusal, transactionsBuiltForLock: 0,
  };
  save();
  console.log('headline el_salvador', json(state.headline.el_salvador));
  if (!state.headline.el_salvador.ok || refusal?.code !== 'LOCKS_DISABLED') throw new Error('El Salvador headline failed');
}

const cmd = process.argv[2];
const run = { g2, g3, g4, headline, pool, 'pool-prep': poolPrep }[cmd];
if (!run) { console.error('usage: run-stories.mjs <g2|g3|g4|headline|pool|pool-prep> [--set a28d|8d2a]'); process.exit(2); }
run().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
