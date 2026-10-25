// ChainClient: typed wrappers over the `payment_plan` contract (schema version 2) and the test USDC
// asset on Stellar testnet. Reads are simulations only. Writes are signed by the operator (and the
// buyer where the contract asks for it) and paid by a channel account from a small pool, so calls
// for different plans can be in flight at the same time; without channels the operator is the
// source and the submitter queues its transactions one after another.
// Amounts are bigint stroops (7 decimals), rates are bigint COP-per-USD × 1e7, timestamps are unix
// seconds, exactly as the contract stores them.

import { Address, Asset, Contract, Keypair, Operation, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { ChainError, Submitter, type SubmitterOptions, type TxResult } from './submit';

export const TEST_USDC_CODE = 'USDC';

export interface ChainClientConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  usdcSacId: string;
  /** Issuer of the platform test asset `USDC:<issuer>`; its secret mints test USDC to buyers. */
  usdcIssuerSecret: string;
  operatorSecret: string;
  /** Demo buyer id (`buyer-maria`, ...) → secret of its platform-managed testnet account. */
  buyers: Record<string, string>;
  payeeBackendPublic: string;
  /** Fee-paying channel accounts; transactions with different channels can run in parallel. */
  channelSecrets?: string[];
}

export type ChainInstallmentStatus = 'open' | 'locked' | 'released' | 'broken' | 'missed' | 'waived';
const STATUS_NAMES: ChainInstallmentStatus[] = ['open', 'locked', 'released', 'broken', 'missed', 'waived'];

export type ChainPlanState = 'active' | 'delinquent' | 'defaulted' | 'on_hold' | 'cancelled' | 'completed';
const PLAN_STATE_NAMES: ChainPlanState[] = ['active', 'delinquent', 'defaulted', 'on_hold', 'cancelled', 'completed'];

export interface ChainInstallment {
  idx: number;
  dueTs: bigint;
  copDue: bigint;
  lockId: Uint8Array | null;
  lockedRate: bigint | null;
  usdDue: bigint | null;
  lockExpiryTs: bigint | null;
  status: ChainInstallmentStatus;
}

export interface ChainPlan {
  planId: number;
  buyer: string;
  count: number;
  balanceUsdc: bigint;
  createdTs: bigint;
}

/** `PolicyConfig` of the contract, fixed per plan at `create_plan`. */
export interface ChainPolicy {
  graceDays: number;
  missesBeforeDefault: number;
  penaltyBps: number;
  /** 0 = refund the whole balance, 1 = refund net of the penalty (applied off-chain). */
  refundMode: number;
}

export interface ChainGovernance {
  state: ChainPlanState;
  policy: ChainPolicy;
  misses: number;
  holdPrev: ChainPlanState;
  totalDeposited: bigint;
  totalReleased: bigint;
  totalRefunded: bigint;
}

export interface ChainPlanStatus {
  plan: ChainPlan;
  installments: ChainInstallment[];
  governance: ChainGovernance;
}

export interface InstallmentInit {
  dueTs: number;
  copDue: bigint;
}

/**
 * Policy of the testnet demo plans. The contract's own default grace is 5 days, but demo plans
 * live on compressed time (every installment is due within a minute of seeding, see bridge.ts), so
 * on chain the grace is 0 days and the demo clock enforces the 5 business days off-chain. The other
 * values are the contract's placeholders (policy pending).
 */
export const DEMO_POLICY: ChainPolicy = { graceDays: 0, missesBeforeDefault: 3, penaltyBps: 1_000, refundMode: 0 };

/** Reason codes the operator attaches to adverse-event calls (recorded in the events). */
export const REASON = {
  missedPayment: 1,
  paymentReceived: 2,
  waivedByBuilder: 3,
  defaultDeclared: 4,
  complianceHold: 5,
  holdCleared: 6,
  buyerWithdrawal: 7,
  refund: 8,
  planCompleted: 9,
} as const;

const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const u64 = (n: number | bigint) => nativeToScVal(n, { type: 'u64' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
const bytes32 = (b: Uint8Array) => {
  if (b.length !== 32) throw new ChainError('expected 32 bytes', { errorName: 'InvalidArgument' });
  return xdr.ScVal.scvBytes(b as Buffer);
};

// Struct fields are maps keyed by symbol, sorted by key.
function structScVal(fields: [string, xdr.ScVal][]): xdr.ScVal {
  const sorted = [...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(sorted.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })));
}

function installmentInitScVal(i: InstallmentInit): xdr.ScVal {
  return structScVal([
    ['cop_due', i128(i.copDue)],
    ['due_ts', u64(i.dueTs)],
  ]);
}

export function policyScVal(p: ChainPolicy): xdr.ScVal {
  return structScVal([
    ['grace_days', u32(p.graceDays)],
    ['misses_before_default', u32(p.missesBeforeDefault)],
    ['penalty_bps', u32(p.penaltyBps)],
    ['refund_mode', u32(p.refundMode)],
  ]);
}

const big = (v: unknown): bigint => BigInt(v as bigint);
const planState = (v: unknown): ChainPlanState => PLAN_STATE_NAMES[Number(v)] ?? 'active';

function toGovernance(g: Record<string, unknown>): ChainGovernance {
  const p = g.policy as Record<string, unknown>;
  return {
    state: planState(g.state),
    policy: {
      graceDays: Number(p.grace_days),
      missesBeforeDefault: Number(p.misses_before_default),
      penaltyBps: Number(p.penalty_bps),
      refundMode: Number(p.refund_mode),
    },
    misses: Number(g.misses),
    holdPrev: planState(g.hold_prev),
    totalDeposited: big(g.total_deposited),
    totalReleased: big(g.total_released),
    totalRefunded: big(g.total_refunded),
  };
}

function toStatus(raw: unknown): ChainPlanStatus {
  const r = raw as { plan: Record<string, unknown>; installments: Record<string, unknown>[]; governance: Record<string, unknown> };
  const p = r.plan;
  return {
    plan: {
      planId: Number(p.plan_id),
      buyer: String(p.buyer),
      count: Number(p.count),
      balanceUsdc: big(p.balance_usdc),
      createdTs: big(p.created_ts),
    },
    installments: r.installments.map((i) => ({
      idx: Number(i.idx),
      dueTs: big(i.due_ts),
      copDue: big(i.cop_due),
      lockId: i.lock_id == null ? null : (i.lock_id as Uint8Array),
      lockedRate: i.locked_rate == null ? null : big(i.locked_rate),
      usdDue: i.usd_due == null ? null : big(i.usd_due),
      lockExpiryTs: i.lock_expiry_ts == null ? null : big(i.lock_expiry_ts),
      status: STATUS_NAMES[Number(i.status)] ?? 'open',
    })),
    governance: toGovernance(r.governance),
  };
}

/** Formats stroops as the 7-decimal string a classic payment operation takes. */
export function stroopsToAmountString(stroops: bigint): string {
  if (stroops < 0n) throw new Error('negative amount');
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

/** Hands out channel keypairs one caller at a time; waits when every channel is busy. */
export class ChannelPool {
  private readonly free: Keypair[];
  private readonly waiting: ((k: Keypair) => void)[] = [];

  constructor(readonly channels: Keypair[]) {
    this.free = [...channels];
  }

  get size(): number {
    return this.channels.length;
  }

  async use<T>(fn: (channel: Keypair) => Promise<T>): Promise<T> {
    const channel = this.free.shift() ?? (await new Promise<Keypair>((resolve) => this.waiting.push(resolve)));
    try {
      return await fn(channel);
    } finally {
      const next = this.waiting.shift();
      if (next) next(channel);
      else this.free.push(channel);
    }
  }
}

export class ChainClient {
  readonly submitter: Submitter;
  readonly config: ChainClientConfig;
  readonly operator: Keypair;
  readonly issuer: Keypair;
  readonly contract: Contract;
  readonly asset: Asset;
  readonly channels: ChannelPool;
  private readonly buyerKeys = new Map<string, Keypair>();

  constructor(config: ChainClientConfig, submitterOpts: Partial<SubmitterOptions> = {}) {
    this.config = config;
    this.submitter = new Submitter({ rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase, ...submitterOpts });
    this.operator = Keypair.fromSecret(config.operatorSecret);
    this.issuer = Keypair.fromSecret(config.usdcIssuerSecret);
    this.contract = new Contract(config.contractId);
    this.asset = new Asset(TEST_USDC_CODE, this.issuer.publicKey());
    this.channels = new ChannelPool((config.channelSecrets ?? []).map((s) => Keypair.fromSecret(s)));
    for (const [id, secret] of Object.entries(config.buyers)) this.buyerKeys.set(id, Keypair.fromSecret(secret));
  }

  get contractId(): string {
    return this.config.contractId;
  }

  buyer(buyerId: string): Keypair {
    const k = this.buyerKeys.get(buyerId);
    if (!k) throw new ChainError(`no testnet account configured for ${buyerId}`, { errorName: 'UnknownBuyer' });
    return k;
  }

  buyerPublic(buyerId: string): string {
    return this.buyer(buyerId).publicKey();
  }

  /** Runs `fn` with a fee source: a free channel account, or the operator when there are none. */
  private withSource<T>(fn: (source: Keypair) => Promise<T>): Promise<T> {
    return this.channels.size > 0 ? this.channels.use(fn) : fn(this.operator);
  }

  /**
   * Generic contract call: builds, simulates, signs auth entries, sends, polls. The operator always
   * signs its own auth entry (the contract loads it from storage); `signers` adds the buyer.
   */
  invoke<T = unknown>(fn: string, args: xdr.ScVal[], opts: { signers?: Keypair[] } = {}): Promise<TxResult<T>> {
    return this.withSource((source) => this.submitter.soroban<T>(fn, source, this.contract.call(fn, ...args), [this.operator, ...(opts.signers ?? [])]));
  }

  /** Read-only contract call through simulation; nothing is sent. */
  read<T = unknown>(fn: string, args: xdr.ScVal[] = []): Promise<T> {
    return this.submitter.simulate<T>(fn, this.operator.publicKey(), this.contract.call(fn, ...args));
  }

  // ---------- typed wrappers: plan lifecycle ----------

  createPlan(planId: number, buyerId: string, installments: InstallmentInit[], policy: ChainPolicy = DEMO_POLICY): Promise<TxResult<void>> {
    const buyer = new Address(this.buyerPublic(buyerId)).toScVal();
    return this.invoke<void>('create_plan', [u32(planId), buyer, xdr.ScVal.scvVec(installments.map(installmentInitScVal)), policyScVal(policy)]);
  }

  deposit(buyerId: string, planId: number, stroops: bigint): Promise<TxResult<bigint>> {
    return this.invoke<bigint>('deposit', [u32(planId), i128(stroops)], { signers: [this.buyer(buyerId)] });
  }

  applyLock(buyerId: string, planId: number, idxs: number[], lockId: Uint8Array, lockedRate: bigint, expiryTs: number): Promise<TxResult<void>> {
    return this.invoke<void>(
      'apply_lock',
      [u32(planId), xdr.ScVal.scvVec(idxs.map(u32)), bytes32(lockId), i128(lockedRate), u64(expiryTs)],
      { signers: [this.buyer(buyerId)] },
    );
  }

  releaseDue(planId: number, idx: number): Promise<TxResult<bigint>> {
    return this.invoke<bigint>('release_due', [u32(planId), u32(idx)]);
  }

  releaseSpot(planId: number, idx: number, usdStroops: bigint): Promise<TxResult<bigint>> {
    return this.invoke<bigint>('release_spot', [u32(planId), u32(idx), i128(usdStroops)]);
  }

  breakLock(planId: number, idx: number): Promise<TxResult<void>> {
    return this.invoke<void>('break_lock', [u32(planId), u32(idx)]);
  }

  extendTtl(planId: number): Promise<TxResult<number>> {
    return this.invoke<number>('extend_ttl', [u32(planId)]);
  }

  // ---------- typed wrappers: adverse events (operator; cancel is admin = operator in the demo) ----------

  markMissed(planId: number, idx: number, reason: number, evidence: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('mark_missed', [u32(planId), u32(idx), u32(reason), bytes32(evidence)]);
  }

  cure(planId: number, idx: number, reason: number, evidence: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('cure', [u32(planId), u32(idx), u32(reason), bytes32(evidence)]);
  }

  waive(planId: number, idx: number, reason: number, evidence: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('waive', [u32(planId), u32(idx), u32(reason), bytes32(evidence)]);
  }

  declareDefault(planId: number, reason: number, evidence: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('declare_default', [u32(planId), u32(reason), bytes32(evidence)]);
  }

  placeHold(planId: number, reason: number, evidence: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('place_hold', [u32(planId), u32(reason), bytes32(evidence)]);
  }

  liftHold(planId: number, reason: number, evidence: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('lift_hold', [u32(planId), u32(reason), bytes32(evidence)]);
  }

  cancelPlan(planId: number, reason: number, evidence: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('cancel_plan', [u32(planId), u32(reason), bytes32(evidence)]);
  }

  refund(planId: number, stroops: bigint, reason: number, evidence: Uint8Array): Promise<TxResult<bigint>> {
    return this.invoke<bigint>('refund', [u32(planId), i128(stroops), u32(reason), bytes32(evidence)]);
  }

  completePlan(planId: number, reason: number, evidence: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('complete_plan', [u32(planId), u32(reason), bytes32(evidence)]);
  }

  /**
   * Permissionless on chain: puts the plan on hold (reason 304) when the issuer has deauthorized
   * the vault, the payee or the buyer; `NotFrozen` otherwise. The operator only pays the fee.
   * Returns the new plan state.
   */
  async holdFrozen(planId: number, evidence: Uint8Array): Promise<TxResult<ChainPlanState>> {
    const r = await this.invoke<number>('hold_frozen', [u32(planId), bytes32(evidence)]);
    return { ...r, result: planState(r.result) };
  }

  // ---------- admin ----------

  pause(): Promise<TxResult<void>> {
    return this.invoke<void>('pause', []);
  }

  unpause(): Promise<TxResult<void>> {
    return this.invoke<void>('unpause', []);
  }

  upgrade(wasmHash: Uint8Array): Promise<TxResult<void>> {
    return this.invoke<void>('upgrade', [bytes32(wasmHash)]);
  }

  migrate(): Promise<TxResult<number>> {
    return this.invoke<number>('migrate', []);
  }

  // ---------- reads ----------

  async getStatus(planId: number): Promise<ChainPlanStatus> {
    return toStatus(await this.read('get_status', [u32(planId)]));
  }

  async getGovernance(planId: number): Promise<ChainGovernance> {
    return toGovernance(await this.read<Record<string, unknown>>('get_governance', [u32(planId)]));
  }

  isPaused(): Promise<boolean> {
    return this.read<boolean>('is_paused');
  }

  version(): Promise<number> {
    return this.read<number>('version');
  }

  /**
   * Mints test USDC to an account: a classic payment from the asset issuer, which for a Stellar
   * asset is issuance. A channel pays the fee and the issuer signs its operation, so mints for
   * different buyers do not queue behind each other. Trustlines come from the deploy script.
   */
  mintTestUsdc(toPublic: string, stroops: bigint): Promise<TxResult<void>> {
    const op = Operation.payment({ destination: toPublic, asset: this.asset, amount: stroopsToAmountString(stroops), source: this.issuer.publicKey() });
    return this.withSource((source) => this.submitter.classic('mint_test_usdc', source, [op], [this.issuer]));
  }

  health(): Promise<boolean> {
    return this.submitter.health();
  }
}
