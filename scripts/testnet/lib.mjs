// Shared testnet helpers for scripts/testnet/*. Prints public keys only, never secrets.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Account, Horizon, Keypair, Networks, Operation, TransactionBuilder, rpc, scValToNative,
} from '@stellar/stellar-sdk';

export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const PASSPHRASE = Networks.TESTNET;
export const UINT32_MAX = 4_294_967_295n;
export const INCLUSION = 100n;
export const server = new rpc.Server(RPC_URL);
export const horizon = new Horizon.Server(HORIZON_URL);
export const RUN_DIR = resolve(import.meta.dirname, '../../docs/demo-runs/2026-10-26-testnet');
// Gitignored (.env.*), next to .env.testnet in the main checkout.
export const GENERATED_FILE = resolve(import.meta.dirname, '../../../../.env.testnet-generated');

export const xlm = (stroops) => (Number(stroops) / 1e7).toFixed(7);
export const txUrl = (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const json = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

/** Testnet-only generated keys (issuer, payees, demo buyers), created once and reused. */
export function generatedKey(name, label) {
  const existing = existsSync(GENERATED_FILE)
    ? readFileSync(GENERATED_FILE, 'utf8').match(new RegExp(`^${name}=(S[A-Z2-7]{55})\\s*$`, 'm'))
    : null;
  if (existing) return Keypair.fromSecret(existing[1]);
  const kp = Keypair.random();
  appendFileSync(GENERATED_FILE, `# DEMO ONLY · testnet · ${label} · 2026-10-26\n${name}=${kp.secret()}\n`);
  return kp;
}

export async function xlmBalance(pub) {
  const a = await horizon.loadAccount(pub);
  return a.balances.find((b) => b.asset_type === 'native').balance;
}

export async function ensureFunded(pub) {
  try { await horizon.loadAccount(pub); return 'existing'; } catch (e) {
    if (e?.response?.status !== 404) throw e;
  }
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`);
  if (!r.ok) throw new Error(`friendbot ${r.status} for ${pub}`);
  return 'friendbot';
}

/** Read-only contract call by simulation. */
export async function read(contract, fn, args = [], source) {
  const src = new Account(source, '0');
  const tx = new TransactionBuilder(src, { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
  return { value: scValToNative(sim.result.retval) };
}

/**
 * Builds, simulates (Soroban ops), signs and submits one operation from `source`.
 * When `feeBumpBy` is given, the inner tx carries a minimal fee and the fee-bump
 * (int64 outer fee) pays resource fee + inclusion. `signers` sign the inner tx.
 * Returns a record with hash, ledger, timestamp and fees, or throws with the record attached.
 */
export async function submit({ step, source, signers, op, soroban = true, feeBumpBy, maxFeeStroops }) {
  const rec = { step, source: source.publicKey(), feeBumpBy: feeBumpBy?.publicKey() };
  const acct = await server.getAccount(source.publicKey());
  let tx = new TransactionBuilder(acct, { fee: INCLUSION.toString(), networkPassphrase: PASSPHRASE })
    .addOperation(op).setTimeout(300).build();
  if (soroban) {
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) { rec.error = `simulation: ${sim.error}`; throw Object.assign(new Error(rec.error), { rec }); }
    rec.resourceFeeStroops = sim.minResourceFee;
    rec.simulatedTotalXlm = xlm(BigInt(sim.minResourceFee) + INCLUSION);
    if (maxFeeStroops && BigInt(sim.minResourceFee) > maxFeeStroops) {
      rec.error = `simulated fee ${xlm(sim.minResourceFee)} XLM above cap ${xlm(maxFeeStroops)}`;
      throw Object.assign(new Error(rec.error), { rec });
    }
    tx = rpc.assembleTransaction(tx, sim).build();
    if (feeBumpBy) {
      // Rebuild the inner tx with the minimal fee so only the int64 outer fee carries the resource fee.
      tx = TransactionBuilder.cloneFrom(tx, { fee: INCLUSION.toString(), sorobanData: sim.transactionData.build() })
        .build();
    }
  }
  for (const s of signers) tx.sign(s);
  let envelope = tx;
  if (feeBumpBy) {
    const total = BigInt(rec.resourceFeeStroops ?? 0) + INCLUSION * 4n;
    envelope = TransactionBuilder.buildFeeBumpTransaction(feeBumpBy, ((total + 1n) / 2n).toString(), tx, PASSPHRASE);
    envelope.sign(feeBumpBy);
  }
  const sent = await server.sendTransaction(envelope);
  rec.hash = sent.hash;
  if (sent.status !== 'PENDING') {
    rec.error = `send ${sent.status}${sent.errorResult ? `: ${sent.errorResult.toXDR('base64')}` : ''}`;
    throw Object.assign(new Error(rec.error), { rec });
  }
  const res = await server.pollTransaction(sent.hash, { attempts: 40 });
  rec.status = res.status;
  rec.ledger = res.ledger;
  rec.timestamp = res.createdAt ? new Date(Number(res.createdAt) * 1000).toISOString() : undefined;
  rec.explorer = txUrl(sent.hash);
  if (res.status !== 'SUCCESS') { rec.error = `on-chain ${res.status}`; throw Object.assign(new Error(rec.error), { rec }); }
  // Fee charged from Horizon (authoritative, works for fee-bumps too).
  const h = await horizon.transactions().transaction(sent.hash).call();
  rec.feeChargedStroops = h.fee_charged;
  rec.feeChargedXlm = xlm(h.fee_charged);
  rec.returnValue = res.returnValue ? scValToNative(res.returnValue) : undefined;
  return rec;
}
