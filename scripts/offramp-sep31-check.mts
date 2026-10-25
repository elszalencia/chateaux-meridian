// `npx tsx scripts/offramp-sep31-check.mts`: one live SEP-31 payout on testnet through
// Sep31OffRampProvider. Expects a receiving anchor at OFFRAMP_HOME_URL (default the simulated
// receiver, http://localhost:8788; start it with `npx tsx infra/receiver/src/index.ts`). Tops up
// the payee_backend account with test USDC from the issuer when it runs low, quotes 4,093,125 COP,
// pays the encargo FD-OLV-0142 and waits for `completed`. Reads `.env.testnet` with either the
// VITE_-prefixed names or the plain ones. Never prints secrets.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { explorerTxUrl, parseDotenv, TESTNET_PASSPHRASE } from '../services/src/chain/env.ts';
import { Sep31OffRampProvider, TESTNET_HORIZON_URL } from '../services/src/adapters/sep31OffRamp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.testnet');
if (!existsSync(ENV_FILE)) {
  console.error('.env.testnet not found: run `npm run deploy:testnet` first.');
  process.exit(1);
}
const env: Record<string, string | undefined> = { ...parseDotenv(readFileSync(ENV_FILE, 'utf8')), ...process.env };
const pick = (name: string): string | undefined => env[name] || env[`VITE_${name}`];
const need = (name: string): string => {
  const v = pick(name);
  if (!v) throw new Error(`${name} (or VITE_${name}) is not set in .env.testnet`);
  return v;
};

const COP_TARGET = 4_093_125;
const BENEFICIARY = 'FD-OLV-0142';
const MIN_FLOAT = 1_500;
const TOP_UP = '3000';

const homeUrl = env.OFFRAMP_HOME_URL || 'http://localhost:8788';
const horizonUrl = env.HORIZON_URL || TESTNET_HORIZON_URL;
const networkPassphrase = pick('STELLAR_NETWORK_PASSPHRASE') || TESTNET_PASSPHRASE;
const issuer = need('USDC_ISSUER');
const issuerKp = Keypair.fromSecret(need('USDC_ISSUER_SECRET'));
const payeeKp = Keypair.fromSecret(need('PAYEE_BACKEND_SECRET'));
const usdc = new Asset('USDC', issuer);
const horizon = new Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith('http://') });

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

async function usdcBalance(account: string): Promise<number> {
  const a = await horizon.loadAccount(account);
  const line = a.balances.find((b) => 'asset_code' in b && b.asset_code === 'USDC' && 'asset_issuer' in b && b.asset_issuer === issuer);
  if (!line) throw new Error(`${account} has no USDC:${issuer} trustline`);
  return Number(line.balance);
}

async function topUp(): Promise<void> {
  const balance = await usdcBalance(payeeKp.publicKey());
  log(`payee_backend ${payeeKp.publicKey()} holds ${balance} USDC`);
  if (balance >= MIN_FLOAT) return;
  const account = await horizon.loadAccount(issuerKp.publicKey());
  const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase })
    .addOperation(Operation.payment({ destination: payeeKp.publicKey(), asset: usdc, amount: TOP_UP }))
    .setTimeout(60)
    .build();
  tx.sign(issuerKp);
  const res = await horizon.submitTransaction(tx);
  log(`minted ${TOP_UP} USDC to payee_backend: ${explorerTxUrl(res.hash)}`);
}

async function main(): Promise<void> {
  log(`anchor ${homeUrl}`);
  await topUp();
  const provider = new Sep31OffRampProvider({
    homeUrl,
    senderSecret: payeeKp.secret(),
    usdc: { code: 'USDC', issuer },
    networkPassphrase,
    horizonUrl,
    sender: { first_name: 'Casa Puente', last_name: 'Pagos', email_address: 'pagos@casapuente.test' },
    clockOffset: () => 0,
    pollIntervalMs: 2_000,
    log: (m) => log(`  ${m}`),
  });

  const q = await provider.quote({ copTarget: COP_TARGET });
  log(`quote ${q.quoteId}: ${q.usdc} USDC → ${q.copDelivered.toLocaleString('es-CO')} COP at ${q.rate.toFixed(4)} COP/USDC, expires ${q.expiresAt}`);

  const paid = await provider.pay({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: BENEFICIARY, memo: 'offramp-sep31-check' });
  log(`SEP-31 ${paid.txId}: ${paid.sep31Status} (${paid.status}) after paying ${explorerTxUrl(paid.stellarTxHash)}`);

  const final = await provider.waitFor(paid.txId, 180_000);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log(`SEP-31 transaction  ${final.id}`);
  console.log(`statuses seen       ${provider.statusesSeen(paid.txId).join(' → ')}`);
  console.log(`final status        ${final.status} (${await provider.status(paid.txId)})`);
  console.log(`amount_in           ${final.amount_in} USDC`);
  console.log(`amount_out          ${final.amount_out} COP`);
  console.log(`external ref        ${final.external_transaction_id ?? '-'}`);
  console.log(`completed_at        ${final.completed_at ?? '-'}`);
  console.log(`payment             ${explorerTxUrl(paid.stellarTxHash)}`);
  console.log(`elapsed             ${elapsed} s`);
  if (final.status !== 'completed') process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
