// Testnet preflight: account balances, network, contract wasm hashes.
// Reads .env.testnet in-process and prints PUBLIC keys only. Never prints secrets.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, Horizon, rpc, xdr } from '@stellar/stellar-sdk';

const RPC_URL = 'https://soroban-testnet.stellar.org';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const CONTRACTS = {
  colombia: 'CAVPFFH4WFPHI3525RFM7AOGUXOP3USLCN6IPOF7AK5PMNAGQAJCCTXP',
  el_salvador: 'CC5Y77X35KBPB773DE2JCYDWAXI3MHVKZ7HXF5R3QCRRSDO46PLNLEBQ',
};

export function loadTestnetEnv(path = process.env.ENV_FILE ?? resolve(import.meta.dirname, '../../../../.env.testnet')) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const need = ['TESTNET_FEE_PAYER_SECRET', 'TESTNET_OPERATOR_SECRET', 'TESTNET_POOL_SECRETS'];
  for (const k of need) if (!env[k]) throw new Error(`${k} missing or empty`);
  return {
    feePayer: Keypair.fromSecret(env.TESTNET_FEE_PAYER_SECRET),
    operator: Keypair.fromSecret(env.TESTNET_OPERATOR_SECRET),
    pool: env.TESTNET_POOL_SECRETS.split(',').map((s) => Keypair.fromSecret(s.trim())),
  };
}

async function main() {
  const keys = loadTestnetEnv();
  const horizon = new Horizon.Server(HORIZON_URL);
  const server = new rpc.Server(RPC_URL);
  const out = { checkedAt: new Date().toISOString(), rpc: RPC_URL, accounts: [], contracts: {} };

  const net = await server.getNetwork();
  const latest = await server.getLatestLedger();
  Object.assign(out, { passphrase: net.passphrase, protocol: net.protocolVersion, ledger: latest.sequence });

  const labeled = [['fee_payer', keys.feePayer], ['operator', keys.operator], ...keys.pool.map((k, i) => [`pool_${i}`, k])];
  for (const [label, kp] of labeled) {
    try {
      const acct = await horizon.loadAccount(kp.publicKey());
      const xlm = acct.balances.find((b) => b.asset_type === 'native')?.balance;
      out.accounts.push({ label, public: kp.publicKey(), xlm, subentries: acct.subentry_count });
    } catch (e) {
      out.accounts.push({ label, public: kp.publicKey(), error: e?.response?.status === 404 ? 'not funded (404)' : String(e.message) });
    }
  }

  for (const [name, id] of Object.entries(CONTRACTS)) {
    const entry = await server
      .getContractData(id, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent)
      .catch(() => null);
    // stellar-sdk 17 decodes XDR to plain objects (no accessor methods).
    const exec = entry?.val.contractData.val.instance?.executable;
    out.contracts[name] = {
      id,
      responds: Boolean(entry),
      wasmHash: exec?.type === 'contractExecutableWasm' ? Buffer.from(exec.wasmHash.value).toString('hex') : null,
      liveUntilLedger: entry?.liveUntilLedgerSeq ?? null,
    };
  }

  console.log(JSON.stringify(out, null, 2));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) main().catch((e) => { console.error(e.message); process.exit(1); });
