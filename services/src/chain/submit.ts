// Low-level Stellar submission on @stellar/stellar-sdk 17: one place that knows how to simulate a
// Soroban operation, sign the authorization entries that belong to accounts other than the source,
// assemble, sign the envelope, send and poll. Works in Node (tsx) and in the browser (Vite): the SDK
// is pure Uint8Array/fetch code, so no polyfills are needed.
//
// Why a second simulation after signing auth entries: the first simulation runs in "record" mode and
// returns the auth tree without signatures; once the buyer has signed its entry the footprint and the
// instruction count change (signature verification), so the transaction is simulated again in
// "enforce" mode and assembled from that result. This is what the stellar CLI does.

import {
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

/** Names of the `payment_plan` contract error enum, by code (contracts/payment_plan/src/lib.rs). */
export const CONTRACT_ERROR_NAMES: Record<number, string> = {
  1: 'PlanNotFound',
  2: 'PlanExists',
  3: 'InstallmentNotFound',
  4: 'InvalidAmount',
  5: 'InvalidSchedule',
  6: 'TooManyInstallments',
  7: 'InvalidLockSize',
  8: 'NotConsecutive',
  9: 'NotOpen',
  10: 'NotLocked',
  11: 'NotDue',
  12: 'InsufficientBalance',
  13: 'LockNotExpired',
  14: 'InvalidRate',
  15: 'TransferFailed',
  16: 'Overflow',
  17: 'NotReleasable',
  18: 'Paused',
  19: 'PlanBlocked',
  20: 'InvalidTransition',
  21: 'GraceNotOver',
  22: 'RefundNotAllowed',
  23: 'NotComplete',
  24: 'DefaultNotReached',
  25: 'InvalidPolicy',
  26: 'AssetFrozen',
  27: 'NotFrozen',
};

/** Largest fee a transaction can declare: the fee field is a uint32 of stroops. */
export const MAX_TX_FEE = 4_294_967_295n;

export class ChainError extends Error {
  /** Contract error code when the failure was `Error(Contract, #n)`, otherwise null. */
  readonly code: number | null;
  /** Enum name for `code` (for example `NotDue`), or a short classification of the failure. */
  readonly errorName: string;
  readonly txHash: string | null;

  constructor(message: string, opts: { code?: number | null; errorName?: string; txHash?: string | null; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ChainError';
    this.code = opts.code ?? null;
    this.errorName = opts.errorName ?? (this.code != null ? CONTRACT_ERROR_NAMES[this.code] ?? `Contract#${this.code}` : 'ChainFailure');
    this.txHash = opts.txHash ?? null;
  }

  static fromSimulation(fn: string, error: string): ChainError {
    const m = /Error\(Contract, #(\d+)\)/.exec(error);
    if (m) {
      const code = Number(m[1]);
      const name = CONTRACT_ERROR_NAMES[code] ?? `Contract#${code}`;
      return new ChainError(`${fn}: contract error ${name} (#${code})`, { code, errorName: name });
    }
    const short = error.length > 600 ? `${error.slice(0, 600)}…` : error;
    return new ChainError(`${fn}: simulation failed: ${short}`, { errorName: 'SimulationFailed' });
  }
}

export interface TxResult<T = unknown> {
  txHash: string;
  ledger: number;
  /** Return value decoded with `scValToNative` (void → undefined). */
  result: T;
}

export interface SubmitterOptions {
  rpcUrl: string;
  networkPassphrase: string;
  /** Transaction time bound, seconds. */
  timeoutSeconds?: number;
  /** Per-request HTTP timeout for the RPC client, in milliseconds (default 30 s). */
  requestTimeoutMs?: number;
  /** How long to poll `getTransaction` before giving up, ms. */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Submitter {
  readonly server: rpc.Server;
  readonly networkPassphrase: string;
  private readonly timeoutSeconds: number;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  /** Tail of the queue of transactions per source account (see `serial`). */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: SubmitterOptions) {
    // Every RPC request gets a hard timeout: a stalled HTTP connection must surface as an error
    // (and a retry) instead of hanging a deploy or a payment forever.
    this.server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith('http://'), timeout: opts.requestTimeoutMs ?? 30_000 });
    this.networkPassphrase = opts.networkPassphrase;
    this.timeoutSeconds = opts.timeoutSeconds ?? 60;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 90_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  }

  /**
   * Runs `fn` after every earlier transaction of the same source account has finished. Two
   * transactions built from one account in parallel would take the same sequence number and one
   * would fail, so callers that want parallelism use different sources (channel accounts) and
   * calls that share a source queue up here.
   */
  private serial<T>(sourcePublic: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sourcePublic) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.queues.set(sourcePublic, tail);
    void tail.then(() => {
      if (this.queues.get(sourcePublic) === tail) this.queues.delete(sourcePublic);
    });
    return run;
  }

  private async build(sourcePublic: string, ops: xdr.Operation[]): Promise<Transaction> {
    const account = await this.server.getAccount(sourcePublic);
    const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase });
    for (const op of ops) b.addOperation(op);
    return b.setTimeout(this.timeoutSeconds).build();
  }

  /** Simulates a Soroban operation and returns the decoded return value. Nothing is sent. */
  async simulate<T = unknown>(label: string, sourcePublic: string, op: xdr.Operation): Promise<T> {
    const tx = await this.build(sourcePublic, [op]);
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw ChainError.fromSimulation(label, sim.error);
    const retval = sim.result?.retval;
    return (retval ? scValToNative(retval) : undefined) as T;
  }

  /**
   * Submits one Soroban operation. `source` pays the fee and signs the envelope; every auth entry
   * addressed to another account is signed with the matching keypair from `signers`.
   */
  soroban<T = unknown>(label: string, source: Keypair, op: xdr.Operation, signers: Keypair[] = []): Promise<TxResult<T>> {
    return this.serial(source.publicKey(), () => this.sorobanNow<T>(label, source, op, signers));
  }

  private async sorobanNow<T>(label: string, source: Keypair, op: xdr.Operation, signers: Keypair[]): Promise<TxResult<T>> {
    const raw = await this.build(source.publicKey(), [op]);
    let sim = await this.server.simulateTransaction(raw);
    if (rpc.Api.isSimulationError(sim)) throw ChainError.fromSimulation(label, sim.error);
    let tx = raw;
    const auth = sim.result?.auth ?? [];
    const foreign = auth.filter((e) => e.credentials.type !== 'sorobanCredentialsSourceAccount');
    if (foreign.length > 0) {
      // Signatures stay valid for about five minutes of ledgers; the demo submits right away.
      const validUntil = sim.latestLedger + 60;
      const byAddress = new Map(signers.map((k) => [k.publicKey(), k] as const));
      const signed: xdr.SorobanAuthorizationEntry[] = [];
      for (const entry of auth) {
        const credentials = entry.credentials;
        if (credentials.type === 'sorobanCredentialsSourceAccount') {
          signed.push(entry);
          continue;
        }
        if (credentials.type === 'sorobanCredentialsAddressWithDelegates') {
          throw new ChainError(`${label}: delegated auth entries are not used by this demo`, { errorName: 'UnsupportedAuth' });
        }
        const address = Address.fromScAddress(credentials.value.address).toString();
        const signer = byAddress.get(address);
        if (!signer) throw new ChainError(`${label}: no keypair for auth entry of ${address}`, { errorName: 'MissingSigner' });
        signed.push(await authorizeEntry(entry, signer, validUntil, this.networkPassphrase));
      }
      const hostOp = raw.operations[0] as Operation.InvokeHostFunction;
      tx = TransactionBuilder.cloneFrom(raw)
        .clearOperations()
        .addOperation(Operation.invokeHostFunction({ func: hostOp.func, auth: signed }))
        .build();
      sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) throw ChainError.fromSimulation(label, sim.error);
    }
    // A transaction's fee is a uint32 of stroops (about 429.5 XLM). Rent on new ledger entries
    // grows steeply once the network's Soroban state passes its target size, so a large write (a
    // Wasm upload) can need more than one transaction can carry: report it as a typed error.
    const minFee = BigInt(sim.minResourceFee ?? '0') + BigInt(raw.fee);
    if (minFee > MAX_TX_FEE) {
      throw new ChainError(`${label}: needs ${(Number(minFee) / 1e7).toFixed(1)} XLM in fees, more than one transaction can carry (${(Number(MAX_TX_FEE) / 1e7).toFixed(1)} XLM)`, { errorName: 'FeeTooHigh' });
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(source);
    return this.send<T>(label, prepared);
  }

  /** Submits classic operations (payments, trustlines) signed by `source` and every extra signer. */
  classic(label: string, source: Keypair, ops: xdr.Operation[], extraSigners: Keypair[] = []): Promise<TxResult<void>> {
    return this.serial(source.publicKey(), () => this.classicNow(label, source, ops, extraSigners));
  }

  private async classicNow(label: string, source: Keypair, ops: xdr.Operation[], extraSigners: Keypair[]): Promise<TxResult<void>> {
    const tx = await this.build(source.publicKey(), ops);
    const seen = new Set<string>();
    for (const k of [source, ...extraSigners]) {
      if (seen.has(k.publicKey())) continue;
      seen.add(k.publicKey());
      tx.sign(k);
    }
    return this.send<void>(label, tx);
  }

  private async send<T>(label: string, tx: Transaction): Promise<TxResult<T>> {
    // Transient RPC/network errors (a dropped fetch) are retried: the send is resent only after a
    // poll shows the hash is still unknown, so a transaction is never applied twice.
    const txHash = hexOf(tx.hash());
    let sent: Awaited<ReturnType<rpc.Server['sendTransaction']>> | null = null;
    for (let attempt = 1; sent === null; attempt += 1) {
      try {
        sent = await this.server.sendTransaction(tx);
      } catch (e) {
        if (attempt >= 3) throw new ChainError(`${label}: send failed after ${attempt} attempts (${messageOf(e)})`, { errorName: 'NetworkError', cause: e });
        await sleep(this.pollIntervalMs * 2);
        const known = await this.lookup(txHash);
        if (known && known.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return this.finish<T>(label, txHash, known);
      }
    }
    if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
      const code = sent.errorResult ? sent.errorResult.result.type : sent.status;
      throw new ChainError(`${label}: send rejected (${code})`, { errorName: 'SendRejected', txHash: sent.hash });
    }
    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      const got = await this.lookup(sent.hash);
      if (!got || got.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
      return this.finish<T>(label, sent.hash, got);
    }
    throw new ChainError(`${label}: transaction ${sent.hash} not found after ${this.pollTimeoutMs} ms`, { errorName: 'Timeout', txHash: sent.hash });
  }

  /** `getTransaction` that returns null instead of throwing on a network error, so polling continues. */
  private async lookup(hash: string): Promise<rpc.Api.GetTransactionResponse | null> {
    try {
      return await this.server.getTransaction(hash);
    } catch {
      return null;
    }
  }

  private finish<T>(label: string, hash: string, got: rpc.Api.GetTransactionResponse): TxResult<T> {
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const retval = got.returnValue;
      return { txHash: hash, ledger: got.ledger, result: (retval ? scValToNative(retval) : undefined) as T };
    }
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
      const code = got.resultXdr.result.type;
      throw new ChainError(`${label}: transaction failed on ledger ${got.ledger} (${code})`, { errorName: 'TransactionFailed', txHash: hash });
    }
    throw new ChainError(`${label}: transaction ${hash} not found`, { errorName: 'Timeout', txHash: hash });
  }

  async health(): Promise<boolean> {
    try {
      const h = await this.server.getHealth();
      return h.status === 'healthy';
    } catch {
      return false;
    }
  }
}
