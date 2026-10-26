// Deploys the payment_plan Wasm as two NEW instances (Colombia, El Salvador) whose operator and
// admin are TESTNET_OPERATOR_SECRET (approved 2026-10-26: the old instances' operator key is not
// available). Also creates the testnet-only USDC issuer + SAC and the two payees those instances
// need, because the old issuer and payee secrets are gone. Idempotent: reruns reuse what exists.
// `--installed <sha256>` deploys from a Wasm already installed on testnet (no upload) instead of
// the local build; instances are kept per Wasm hash.
// Results (hashes, ledgers, fees) go to docs/demo-runs/2026-10-26-testnet/deploy.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Asset, Operation, StrKey, xdr, rpc } from '@stellar/stellar-sdk';
import { loadTestnetEnv } from './preflight.mjs';
import {
  PASSPHRASE, RUN_DIR, ensureFunded, generatedKey, horizon, json, read, server, submit, xlmBalance,
} from './lib.mjs';

const WASM = resolve(import.meta.dirname, '../../contracts/target/wasm32v1-none/release/payment_plan.wasm');
const EXPECTED_WASM = '8d2a440260ae26ad2ebe15abb91180208f631bd37d5dfe219f17c666bd3899ad';
const OUT = resolve(RUN_DIR, 'deploy.json');
const keys = loadTestnetEnv();
const installedArg = process.argv.indexOf('--installed');
const INSTALLED = installedArg > 0 ? process.argv[installedArg + 1] : undefined;
const fp = keys.feePayer;
const state = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { date: '2026-10-26', txs: [], accounts: {} };
const save = () => { if (!existsSync(RUN_DIR)) mkdirSync(RUN_DIR, { recursive: true }); writeFileSync(OUT, json(state) + '\n'); };
const record = (r) => { state.txs.push(r); save(); console.log(`${r.step}: ${r.hash} ledger ${r.ledger} fee ${r.feeChargedXlm} XLM`); return r; };

async function contractExists(id) {
  return server.getContractData(id, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent)
    .then(() => true, () => false);
}

async function main() {
  state.feePayerStartXlm ??= await xlmBalance(fp.publicKey());

  // 1. Testnet-only accounts: USDC issuer and the two payees.
  const issuer = keys.usdIssuer;
  if (!issuer) throw new Error('TESTNET_USD_ISSUER_SECRET missing in .env.testnet');
  const payees = { colombia: generatedKey('DEMO_PAYEE_CO_SECRET', 'Colombia payee'), el_salvador: generatedKey('DEMO_PAYEE_SV_SECRET', 'El Salvador payee') };
  for (const [label, kp] of [['usdc_issuer', issuer], ['payee_colombia', payees.colombia], ['payee_el_salvador', payees.el_salvador]]) {
    state.accounts[label] = { public: kp.publicKey(), funded: await ensureFunded(kp.publicKey()) };
  }
  const usdc = new Asset('USDC', issuer.publicKey());
  const usdcSac = usdc.contractId(PASSPHRASE);
  state.usdc = { asset: `USDC:${issuer.publicKey()}`, sac: usdcSac };
  save();

  // 2. Payee trustlines (classic, paid by each payee).
  for (const [corridor, kp] of Object.entries(payees)) {
    const acct = await horizon.loadAccount(kp.publicKey());
    if (acct.balances.some((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer.publicKey())) continue;
    record(await submit({ step: `trustline_payee_${corridor}`, source: kp, signers: [kp], soroban: false, op: Operation.changeTrust({ asset: usdc }) }));
  }

  // 3. SAC for the test USDC.
  if (!(await contractExists(usdcSac))) {
    record(await submit({ step: 'deploy_usdc_sac', source: fp, signers: [fp], op: Operation.createStellarAssetContract({ asset: usdc }) }));
  }

  // 4. Upload the Wasm (once), unless deploying from an installed hash.
  let hash = INSTALLED;
  if (!hash) {
    const wasm = readFileSync(WASM);
    hash = createHash('sha256').update(wasm).digest('hex');
    if (hash !== EXPECTED_WASM) throw new Error(`wasm hash ${hash} is not the reviewed build ${EXPECTED_WASM}`);
    state.wasm = { sha256: hash, bytes: wasm.length };
  }
  const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hash, 'hex') }));
  const code = await server.getLedgerEntries(codeKey);
  if (!code.entries.length) {
    if (INSTALLED) throw new Error(`wasm ${hash} is not installed on testnet`);
    record(await submit({ step: 'upload_wasm', source: fp, signers: [fp], op: Operation.uploadContractWasm({ wasm: readFileSync(WASM) }) }));
  }
  save();

  // 5. Two instances: admin = operator = TESTNET_OPERATOR (as the existing deploy scripts do).
  state.instancesByWasm ??= {};
  if (state.instances && !state.instancesByWasm[EXPECTED_WASM]) { state.instancesByWasm[EXPECTED_WASM] = state.instances; delete state.instances; }
  const instances = (state.instancesByWasm[hash] ??= {});
  for (const corridor of ['colombia', 'el_salvador']) {
    if (instances[corridor]?.id && (await contractExists(instances[corridor].id))) continue;
    const saltTag = hash === EXPECTED_WASM ? corridor : `${corridor}-${hash.slice(0, 8)}`;
    const salt = createHash('sha256').update(`chateaux-testnet-2026-10-26-${saltTag}`).digest();
    const op = Operation.createCustomContract({
      address: new Address(fp.publicKey()),
      wasmHash: Buffer.from(hash, 'hex'),
      salt,
      constructorArgs: [keys.operator.publicKey(), keys.operator.publicKey(), usdcSac, payees[corridor].publicKey()]
        .map((a) => new Address(a).toScVal()),
    });
    const r = record(await submit({ step: `deploy_instance_${corridor}_${hash.slice(0, 8)}`, source: fp, signers: [fp], op }));
    const id = r.returnValue;
    if (!StrKey.isValidContract(id)) throw new Error(`deploy returned ${id}`);
    instances[corridor] = { id, deployTx: r.hash, wasm: hash };
    save();
  }

  // 6. Verify with a read call on each instance.
  for (const corridor of ['colombia', 'el_salvador']) {
    const inst = instances[corridor];
    const cfg = await read(inst.id, 'get_config', [], fp.publicKey());
    const ver = await read(inst.id, 'version', [], fp.publicKey());
    inst.verify = {
      getConfig: cfg.value, version: ver.value,
      ok: cfg.value?.operator === keys.operator.publicKey() && cfg.value?.admin === keys.operator.publicKey()
        && cfg.value?.usdc === usdcSac && cfg.value?.payee_backend === payees[corridor].publicKey(),
    };
    console.log(`${corridor} ${inst.id} get_config ok=${inst.verify.ok} version=${ver.value}`);
  }
  state.feePayerEndXlm = await xlmBalance(fp.publicKey());
  save();
}

main().catch((e) => { if (e.rec) { state.failed = e.rec; save(); } console.error('FAILED', e.message); process.exit(1); });
