// Builds evidence/testnet-2026-10-26.json from deploy.json and the two stories files. Every hash
// is re-verified with RPC getTransaction (status, ledger, close time) and Horizon (fee charged)
// before it is listed; a hash that does not verify is listed under `unverified`, not `transactions`.
// Headline: the 8d2a4402 pair (the Wasm the tagged source builds). The a28d240c pair is the
// superseded first run.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUN_DIR, horizon, json, server, txUrl, xlm } from './lib.mjs';

const EVIDENCE = resolve(import.meta.dirname, '../../evidence/testnet-2026-10-26.json');
const load = (f) => JSON.parse(readFileSync(resolve(RUN_DIR, f), 'utf8'));
const deploy = load('deploy.json');
const A28D = 'a28d240c3728f3415b73218597bb4b9f23c77384c4d7beda77a57300e88755b1';
const B8D2 = '8d2a440260ae26ad2ebe15abb91180208f631bd37d5dfe219f17c666bd3899ad';
const head = deploy.instancesByWasm[B8D2];
const old = deploy.instancesByWasm[A28D];
const runs = [
  { contractSet: 'headline', stories: load('stories-8d2a.json'), pool: load('pool-8d2a.json') },
  { contractSet: 'superseded', stories: load('stories.json'), pool: load('pool.json') },
];
// Testnet RPC/Horizon occasionally drop a request; retry before treating a hash as unverified.
async function retry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 1500 * i)); }
  }
}
const NOTES = { 1001: 'first run; lock expiry rule fixed afterwards' };

const corridorOfStep = (s) => (/colombia|_co_|_CO_/.test(s) ? 'colombia' : /el_salvador|_sv_|_SV_/.test(s) ? 'el_salvador' : 'shared');
const planOfStep = (s) => Number(/_(\d{4})(?:_|$)/.exec(s)?.[1] ?? 0) || undefined;
const contractOfStep = (step, contract) => contract
  ?? (step.startsWith('deploy_instance_') ? deploy.instancesByWasm[step.endsWith('a28d240c') ? A28D : B8D2][corridorOfStep(step)]?.id : null)
  ?? (step === 'deploy_usdc_sac' || /^(trustline|mint_usdc)_/.test(step) ? deploy.usdc.sac : null);

const rows = [
  ...deploy.txs.map((t) => ({ ...t, phase: 'setup', contractSet: 'setup' })),
  ...runs.flatMap(({ contractSet, stories }) => stories.steps.filter((t) => !t.failed).map((t) => ({
    ...t,
    contractSet,
    // Pool: steps for pool demo buyers (*_P<n>, *_Q<n>) and for plans x1xx / x2xx.
    phase: /_[PQ]\d$/.test(t.step) || (planOfStep(t.step) ?? 0) % 1000 > 100 ? 'pool' : 'story',
  }))),
];

const transactions = [];
const unverified = [];
for (const t of rows) {
  const tx = await retry(() => server.getTransaction(t.hash));
  if (tx.status !== 'SUCCESS') { unverified.push({ step: t.step, hash: t.hash, rpcStatus: tx.status }); continue; }
  const h = await retry(() => horizon.transactions().transaction(t.hash).call());
  const planId = planOfStep(t.step);
  transactions.push({
    step: t.step,
    phase: t.phase,
    contractSet: t.contractSet,
    corridor: t.corridor ?? corridorOfStep(t.step),
    contractId: contractOfStep(t.step, t.contract),
    ...(planId ? { planId } : {}),
    ...(NOTES[planId] ? { note: NOTES[planId] } : {}),
    txHash: t.hash,
    ledger: tx.ledger,
    timestamp: new Date(Number(tx.createdAt) * 1000).toISOString(),
    feePaidStroops: String(h.fee_charged),
    feePaidXlm: xlm(h.fee_charged),
    feeBump: Boolean(tx.feeBump),
    feeAccount: h.fee_account,
    explorerUrl: txUrl(t.hash),
    verifiedWith: 'rpc getTransaction SUCCESS + horizon fee_charged',
  });
}

const sum = (f) => xlm(transactions.filter(f).reduce((a, t) => a + BigInt(t.feePaidStroops), 0n));
const contractEntry = (inst, replaces) => ({ id: inst.id, wasm: B8D2, replaces, explorerUrl: `https://stellar.expert/explorer/testnet/contract/${inst.id}` });
const [h8, s0] = [runs[0], runs[1]];
const out = {
  title: 'Chateaux testnet run, 2026-10-26',
  network: { passphrase: 'Test SDF Network ; September 2015', rpc: 'https://soroban-testnet.stellar.org', protocol: 29 },
  contracts: {
    flag: 'config/** owner must replace CC5Y77X35KBPB773DE2JCYDWAXI3MHVKZ7HXF5R3QCRRSDO46PLNLEBQ (SV) and CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP (Colombia) with the headline ids below (env keys PAYMENT_PLAN_CONTRACT_ID / PAYMENT_PLAN_CONTRACT_ID_SV).',
    wasm: { sha256: B8D2, bytes: 31104, note: '`stellar contract build` at tag testnet-2026-10-26 produces this hash.' },
    colombia: contractEntry(head.colombia, 'CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP'),
    el_salvador: contractEntry(head.el_salvador, 'CC5Y77X35KBPB773DE2JCYDWAXI3MHVKZ7HXF5R3QCRRSDO46PLNLEBQ'),
    operatorAndAdmin: head.colombia.verify.getConfig.operator,
    testUsd: { asset: deploy.usdc.asset, sac: deploy.usdc.sac, note: 'Demo-issued test dollar (no auth/revocable/clawback flags), not Circle USDC.' },
    payees: { colombia: head.colombia.verify.getConfig.payee_backend, el_salvador: head.el_salvador.verify.getConfig.payee_backend },
    elSalvadorUnits: 'On the El Salvador instance the cop_due field holds USD cents (released at cents x 100,000 stroops).',
    superseded: {
      wasm: A28D,
      colombia: old.colombia.id,
      el_salvador: old.el_salvador.id,
      note: 'First run of the day (G2-G4 and a pool). Same operator, asset and payees; superseded because the tagged source builds 8d2a4402, not a28d240c.',
    },
  },
  headline: { colombia: h8.stories.headline.colombia, el_salvador: h8.stories.headline.el_salvador },
  firstRun: { g2: s0.stories.g2, g3: { ...s0.stories.g3, planId: 1001, note: NOTES[1001] }, g4: { ...s0.stories.g4, planId: 2001 } },
  pool: h8.pool.plans.map(({ planId, corridor, contract, buyer, m1DueTs, depositTx, lockTx, lockExpiryTs, liveStep }) => ({ planId, corridor, contract, buyer, m1DueTs, depositTx, lockTx, lockExpiryTs, liveStep })),
  supersededPool: s0.pool.plans.map(({ planId, corridor, contract }) => ({ planId, corridor, contract })),
  totals: {
    transactions: transactions.length,
    feesXlm: {
      setup: sum((t) => t.contractSet === 'setup'),
      headlineStories: sum((t) => t.contractSet === 'headline' && t.phase === 'story'),
      headlinePool: sum((t) => t.contractSet === 'headline' && t.phase === 'pool'),
      supersededRun: sum((t) => t.contractSet === 'superseded'),
      all: sum(() => true),
    },
  },
  transactions,
  unverified,
};
mkdirSync(resolve(EVIDENCE, '..'), { recursive: true });
writeFileSync(EVIDENCE, json(out) + '\n');
console.log(`verified ${transactions.length}, unverified ${unverified.length}`, json(out.totals.feesXlm));
