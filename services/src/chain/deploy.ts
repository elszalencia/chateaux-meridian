// Deployment helpers for the testnet demo: account funding, the platform test asset and its SAC,
// the payment_plan Wasm and the contract instance. Each "ensure" step checks the ledger first so
// the deploy script can be run again without redoing what already exists. No file or environment
// access here; scripts/deploy-testnet.mts owns those.

import { Address, Asset, Keypair, Operation, hash, rpc, xdr } from '@stellar/stellar-sdk';
import { FRIENDBOT_URL } from './env';
import type { SimulatedFee, Submitter, TxResult } from './submit';

export async function accountExists(submitter: Submitter, publicKey: string): Promise<boolean> {
  try {
    await submitter.server.getAccount(publicKey);
    return true;
  } catch {
    return false;
  }
}

/** Funds a testnet account through friendbot; a no-op when the account already exists. */
export async function ensureFunded(submitter: Submitter, publicKey: string, friendbotUrl = FRIENDBOT_URL): Promise<'existing' | 'funded'> {
  if (await accountExists(submitter, publicKey)) return 'existing';
  const res = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok && res.status !== 400) throw new Error(`friendbot ${res.status} for ${publicKey}`);
  // 400 means "already funded" (a race with a previous run); confirm either way.
  if (!(await accountExists(submitter, publicKey))) throw new Error(`friendbot did not create ${publicKey}`);
  return 'funded';
}

export async function hasTrustline(submitter: Submitter, publicKey: string, asset: Asset): Promise<boolean> {
  try {
    await submitter.server.getTrustline(publicKey, asset);
    return true;
  } catch {
    return false;
  }
}

/** One transaction creating the missing trustlines; `source` pays, every holder signs its own op. */
export async function ensureTrustlines(submitter: Submitter, source: Keypair, holders: Keypair[], asset: Asset): Promise<{ created: string[]; tx: TxResult<void> | null }> {
  const missing: Keypair[] = [];
  for (const k of holders) if (!(await hasTrustline(submitter, k.publicKey(), asset))) missing.push(k);
  if (missing.length === 0) return { created: [], tx: null };
  const ops = missing.map((k) => Operation.changeTrust({ asset, source: k.publicKey() }));
  const tx = await submitter.classic('change_trust', source, ops, missing);
  return { created: missing.map((k) => k.publicKey()), tx };
}

export async function contractInstanceExists(submitter: Submitter, contractId: string): Promise<boolean> {
  try {
    await submitter.server.getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
    return true;
  } catch {
    return false;
  }
}

/** Deploys the asset's Stellar Asset Contract unless it already exists; returns the SAC id. */
export async function ensureSac(submitter: Submitter, source: Keypair, asset: Asset): Promise<{ sacId: string; deployed: boolean; tx: TxResult<unknown> | null }> {
  const sacId = asset.contractId(submitter.networkPassphrase);
  if (await contractInstanceExists(submitter, sacId)) return { sacId, deployed: false, tx: null };
  const tx = await submitter.soroban('create_stellar_asset_contract', source, Operation.createStellarAssetContract({ asset }));
  return { sacId, deployed: true, tx };
}

export async function wasmExists(submitter: Submitter, wasmHash: Uint8Array): Promise<boolean> {
  try {
    await submitter.server.getContractWasmByHash(wasmHash);
    return true;
  } catch {
    return false;
  }
}

/** Uploads the Wasm unless its hash is already on the ledger; returns the hash either way. */
export async function ensureWasm(submitter: Submitter, source: Keypair, wasm: Uint8Array): Promise<{ wasmHash: Uint8Array; uploaded: boolean; tx: TxResult<unknown> | null }> {
  const wasmHash = hash(wasm);
  if (await wasmExists(submitter, wasmHash)) return { wasmHash, uploaded: false, tx: null };
  const tx = await submitter.soroban('upload_contract_wasm', source, Operation.uploadContractWasm({ wasm }));
  return { wasmHash, uploaded: true, tx };
}

export interface PaymentPlanConstructorArgs {
  admin: string;
  operator: string;
  usdc: string;
  payeeBackend: string;
}

export function randomSalt(): Uint8Array {
  const salt = new Uint8Array(32);
  globalThis.crypto.getRandomValues(salt);
  return salt;
}

/**
 * The `create_contract` host function for a new payment_plan instance from an already installed
 * Wasm hash, with the constructor arguments `(admin, operator, usdc, payee_backend)` in the order
 * `__constructor` declares them. Deploying from a hash never uploads code: the instance entry is
 * the only new ledger entry, so this is what a second corridor instance costs.
 */
export function createPaymentPlanOp(deployer: string, wasmHash: Uint8Array, args: PaymentPlanConstructorArgs, salt: Uint8Array = randomSalt()): xdr.Operation {
  return Operation.createCustomContract({
    address: new Address(deployer),
    wasmHash: Buffer.from(wasmHash),
    salt: Buffer.from(salt),
    constructorArgs: [
      new Address(args.admin).toScVal(),
      new Address(args.operator).toScVal(),
      new Address(args.usdc).toScVal(),
      new Address(args.payeeBackend).toScVal(),
    ],
  });
}

/** Simulates the deployment and reports its fee; nothing is sent. */
export function simulateDeployFee(submitter: Submitter, deployer: string, wasmHash: Uint8Array, args: PaymentPlanConstructorArgs): Promise<SimulatedFee> {
  return submitter.simulateFee('create_contract', deployer, createPaymentPlanOp(deployer, wasmHash, args));
}

/** Deploys a new payment_plan instance (random salt) and runs its constructor. */
export async function deployPaymentPlan(submitter: Submitter, source: Keypair, wasmHash: Uint8Array, args: PaymentPlanConstructorArgs): Promise<{ contractId: string; tx: TxResult<string> }> {
  const op = createPaymentPlanOp(source.publicKey(), wasmHash, args);
  const tx = await submitter.soroban<string>('create_contract', source, op);
  return { contractId: tx.result, tx };
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Inverse of `hexOf`: 64 hex characters → the 32 bytes of a Wasm hash. */
export function bytesOfHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`expected 64 hex characters, got ${hex.length}`);
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** Stroops → XLM with seven decimals, for fee reports. */
export function stroopsToXlm(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  return `${neg ? '-' : ''}${abs / 10_000_000n}.${(abs % 10_000_000n).toString().padStart(7, '0')}`;
}

/** Hash of the Wasm a contract instance currently runs, or null when the instance is not found. */
export async function deployedWasmHash(submitter: Submitter, contractId: string): Promise<string | null> {
  try {
    const entry = await submitter.server.getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
    const data = entry.val;
    if (data.type !== 'contractData') return null;
    const val = data.contractData.val;
    if (val.type !== 'scvContractInstance') return null;
    const executable = val.instance.executable;
    return executable.type === 'contractExecutableWasm' ? hexOf(executable.wasmHash.toXdrObject()) : null;
  } catch {
    return null;
  }
}

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
