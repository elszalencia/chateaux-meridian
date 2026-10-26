// Builds evidence/testnet-2026-10-26.json from deploy.json + stories.json. Every hash is
// re-verified with RPC getTransaction (status, ledger, close time) and Horizon (fee charged)
// before it is listed; a hash that does not verify is listed under `unverified`, not `transactions`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUN_DIR, horizon, json, server, txUrl, xlm } from './lib.mjs';

const EVIDENCE = resolve(import.meta.dirname, '../../evidence/testnet-2026-10-26.json');
const deploy = JSON.parse(readFileSync(resolve(RUN_DIR, 'deploy.json'), 'utf8'));
const stories = JSON.parse(readFileSync(resolve(RUN_DIR, 'stories.json'), 'utf8'));
const pool = JSON.parse(readFileSync(resolve(RUN_DIR, 'pool.json'), 'utf8'));
const A28D = 'a28d240c3728f3415b73218597bb4b9f23c77384c4d7beda77a57300e88755b1';
const B8D2 = '8d2a440260ae26ad2ebe15abb91180208f631bd37d5dfe219f17c666bd3899ad';
const demo = deploy.instancesByWasm[A28D];
const unused = deploy.instancesByWasm[B8D2];

const corridorOfStep = (s) => (/colombia|_co_|_CO_/.test(s) ? 'colombia' : /el_salvador|_sv_|_SV_/.test(s) ? 'el_salvador' : 'shared');
const contractOfStep = (step, contract) => contract
  ?? (step.startsWith('deploy_instance_') ? deploy.instancesByWasm[step.endsWith('a28d240c') ? A28D : B8D2][corridorOfStep(step)]?.id : null)
  ?? (step === 'deploy_usdc_sac' || /^(trustline|mint_usdc)_/.test(step) ? deploy.usdc.sac : null);

const rows = [
  ...deploy.txs.map((t) => ({ ...t, phase: 'setup' })),
  ...stories.steps.filter((t) => !t.failed).map((t) => ({
    ...t,
    // Pool: steps for demo buyers *_P<n> and for plans 1101-1103 / 2101-2103.
    phase: /_P\d$/.test(t.step) || Number(/_(\d{4})(?:_|$)/.exec(t.step)?.[1] ?? 0) % 1000 > 100 ? 'pool' : 'story',
  })),
];

const transactions = [];
const unverified = [];
for (const t of rows) {
  const tx = await server.getTransaction(t.hash);
  if (tx.status !== 'SUCCESS') { unverified.push({ step: t.step, hash: t.hash, rpcStatus: tx.status }); continue; }
  const h = await horizon.transactions().transaction(t.hash).call();
  transactions.push({
    step: t.step,
    phase: t.phase,
    corridor: t.corridor ?? corridorOfStep(t.step),
    contractId: contractOfStep(t.step, t.contract),
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
const out = {
  title: 'Chateaux testnet run, 2026-10-26',
  network: { passphrase: 'Test SDF Network ; September 2015', rpc: 'https://soroban-testnet.stellar.org', protocol: 29 },
  contracts: {
    flag: 'config/** owner must replace CC5Y77X35KBPB773DE2JCYDWAXI3MHVKZ7HXF5R3QCRRSDO46PLNLEBQ (SV) and CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP (Colombia) with the ids below (env keys PAYMENT_PLAN_CONTRACT_ID / PAYMENT_PLAN_CONTRACT_ID_SV).',
    colombia: { id: demo.colombia.id, wasm: A28D, replaces: 'CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP', explorerUrl: `https://stellar.expert/explorer/testnet/contract/${demo.colombia.id}` },
    el_salvador: { id: demo.el_salvador.id, wasm: A28D, replaces: 'CC5Y77X35KBPB773DE2JCYDWAXI3MHVKZ7HXF5R3QCRRSDO46PLNLEBQ', explorerUrl: `https://stellar.expert/explorer/testnet/contract/${demo.el_salvador.id}` },
    operatorAndAdmin: demo.colombia.verify.getConfig.operator,
    testUsd: { asset: deploy.usdc.asset, sac: deploy.usdc.sac, note: 'Demo-issued test dollar (no auth/revocable/clawback flags), not Circle USDC.' },
    payees: { colombia: demo.colombia.verify.getConfig.payee_backend, el_salvador: demo.el_salvador.verify.getConfig.payee_backend },
    deployedNotUsed: { wasm: B8D2, colombia: unused.colombia.id, el_salvador: unused.el_salvador.id, note: 'Uploaded and deployed earlier in the session on a superseded instruction; not used by the demo.' },
  },
  results: { g2: stories.g2, g3: stories.g3, g4: stories.g4 },
  pool: pool.plans.map(({ planId, corridor, contract, buyer, m1DueTs, m1Due }) => ({ planId, corridor, contract, buyer, m1DueTs, m1Due })),
  totals: {
    transactions: transactions.length,
    feesXlm: { setup: sum((t) => t.phase === 'setup'), story: sum((t) => t.phase === 'story'), pool: sum((t) => t.phase === 'pool'), all: sum(() => true) },
  },
  transactions,
  unverified,
};
mkdirSync(resolve(EVIDENCE, '..'), { recursive: true });
writeFileSync(EVIDENCE, json(out) + '\n');
console.log(`verified ${transactions.length}, unverified ${unverified.length}`, json(out.totals.feesXlm));
