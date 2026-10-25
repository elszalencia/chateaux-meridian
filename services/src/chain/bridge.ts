// ChainBridge: the narrow seam DemoApi uses to mirror the demo on the `payment_plan` contract.
// The mock stack never sees it (DemoApi's `chain` is undefined); the testnet stack passes a
// TestnetBridge over ChainClient; unit tests pass a fake that records calls.
//
// Time model (also in contracts/README.md). The demo clock is virtual ("+1 mes" moves `today` in
// the store), but the contract compares the real ledger close time with `due_ts` and `expiry_ts`.
// For the testnet demo the seeded plans therefore get compressed dates:
//   due_ts(idx)  = (seed time rounded down to the minute, minus one minute) + idx seconds
//                  → strictly ascending, and every installment is already due when the demo pays it;
//   expiry_ts    = now + LOCK_EXPIRY_SECONDS for a live lock → `break_lock` is possible one minute
//                  after locking, which is what the break job needs after "+1 mes";
//   expiry_ts    = the seed minute for a lock seeded as already broken (Andrés Q1) → breakable now.
// The contract's real-calendar rule (midnight UTC due dates, grace end) is unchanged and covered by
// the Rust tests; a per-plan time offset for demos is a Stage 4 design decision. Demo plans are
// created with DEMO_POLICY (grace 0 days on chain) for the same reason.
//
// Seeding runs in four rounds; the calls inside a round are independent and go out in parallel on
// different channel accounts: (1) create_plan and the test-USDC mint, (2) deposit, (3) every
// apply_lock, (4) every release and break. Plans are seeded in parallel with each other too.
//
// Corridors. The bridge serves one contract instance; a plan's corridor (config/corridors.ts,
// through corridorOf) decides how its rows are replayed. A corridor whose amount field holds cents
// (decimals 2) releases every seeded installment with release_spot at exactly cents × 100,000
// stroops, and a corridor with locks disabled never sees apply_lock: a seed that carries a lock for
// such a plan is refused before anything is sent.

import { hash } from '@stellar/stellar-sdk';
import { LocksDisabledError, corridorOf, minorToStroops } from '../corridors/index';
import type { Installment, Lock, Plan, Receipt } from '../domain/types';
import { fixedPointRate, fixedPointUsdDue } from '../lock/engine';
import type { ChainClient, ChainGovernance, ChainPlanStatus } from './client';
import { ChainError } from './submit';

export const LOCK_EXPIRY_SECONDS = 60;

export interface ChainTx {
  txHash: string;
  ledger: number;
}

export interface SeedStep {
  label: string;
  txHash: string;
  ms: number;
}

export interface SeedResult {
  chainPlanId: number;
  steps: SeedStep[];
  elapsedMs: number;
}

export interface SeedPlanState {
  locks: Lock[];
  receipts: Receipt[];
}

export interface ChainBridge {
  readonly contractId: string;
  /** Creates the plan on chain and replays its seeded history (locks, releases, breaks). */
  seedPlan(plan: Plan, installments: Installment[], seedState: SeedPlanState): Promise<SeedResult>;
  /** Mints `stroops` of test USDC to the buyer and deposits them into the plan. Returns the deposit tx. */
  deposit(buyerId: string, chainPlanId: number, stroops: bigint): Promise<ChainTx>;
  applyLock(args: { chainPlanId: number; buyerId: string; idxs: number[]; lockId: Uint8Array; lockedRate: bigint; expiryTs: number }): Promise<ChainTx>;
  releaseDue(chainPlanId: number, idx: number): Promise<ChainTx & { stroops: bigint }>;
  releaseSpot(chainPlanId: number, idx: number, stroops: bigint): Promise<ChainTx & { stroops: bigint }>;
  breakLock(chainPlanId: number, idx: number): Promise<ChainTx>;
  getStatus(chainPlanId: number): Promise<ChainPlanStatus>;
  /** Adverse-event and lifecycle calls (operator; `cancel` needs the admin, which is the operator in the demo). */
  adverse(action: AdverseAction): Promise<ChainTx & { result?: bigint }>;
  extendTtl(chainPlanId: number): Promise<ChainTx>;
}

/** One adverse-event call on a plan; `reason` is a REASON code, `evidence` any text (hashed). */
export type AdverseAction =
  | { kind: 'mark_missed' | 'cure' | 'waive'; chainPlanId: number; idx: number; reason: number; evidence: string }
  | { kind: 'declare_default' | 'place_hold' | 'lift_hold' | 'cancel_plan' | 'complete_plan'; chainPlanId: number; reason: number; evidence: string }
  | { kind: 'refund'; chainPlanId: number; stroops: bigint; reason: number; evidence: string };

/** Evidence hashes on chain are the SHA-256 of the evidence text kept off-chain. */
export function evidenceHash(text: string): Uint8Array {
  return hash(new TextEncoder().encode(text));
}

export type { ChainGovernance };

/** `lock_id` on chain is the SHA-256 of the lock id string, so the UI's ids stay readable. */
export function lockIdBytes(lockId: string): Uint8Array {
  return hash(new TextEncoder().encode(lockId));
}

/** USD with two decimals → stroops, exact in integer arithmetic. */
export function usdToStroops(usd: number): bigint {
  return BigInt(Math.round(usd * 100)) * 100_000n;
}

/** Stroops a locked installment releases: the same floor division the contract performs. */
export function lockedStroops(copDue: number, lockedRate: number): bigint {
  return fixedPointUsdDue(copDue, fixedPointRate(lockedRate));
}

export function nowSeconds(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000);
}

/** Expiry for a lock accepted during the demo (see the time model above). */
export function demoLockExpiryTs(nowMs: number = Date.now()): number {
  return nowSeconds(nowMs) + LOCK_EXPIRY_SECONDS;
}

/** The minute before the seed time: base for compressed due dates and for already-broken locks. */
export function seedBaseTs(nowMs: number = Date.now()): number {
  return Math.floor(nowSeconds(nowMs) / 60) * 60 - 60;
}

export function randomPlanId(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  // Keep clear of zero and of the u32 top bit so ids print as plain positive integers everywhere.
  return (buf[0]! % 0x7ffffffe) + 1;
}

export class TestnetBridge implements ChainBridge {
  constructor(
    private readonly client: ChainClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get contractId(): string {
    return this.client.contractId;
  }

  async seedPlan(plan: Plan, installments: Installment[], seedState: SeedPlanState): Promise<SeedResult> {
    const t0 = Date.now();
    const steps: SeedStep[] = [];
    const timed = async <T extends { txHash: string }>(label: string, run: () => Promise<T>): Promise<T> => {
      const s = Date.now();
      const out = await run();
      steps.push({ label, txHash: out.txHash, ms: Date.now() - s });
      return out;
    };
    const rows = [...installments].sort((a, b) => a.idx - b.idx);
    const base = seedBaseTs(this.now());
    const chainPlanId = randomPlanId();
    const buyerId = plan.buyerId;
    const corridor = corridorOf(plan);
    assertSeedHasNoLocks(plan, rows, seedState);

    // Stroops each seeded release needs: locked ones at the contract's floor division, spot ones
    // at the receipt's two-decimal USD; a cents corridor releases exactly cents × 100,000.
    const need = new Map<number, bigint>();
    const lockOf = (row: Installment): Lock | undefined => seedState.locks.find((l) => l.id === row.lockId);
    for (const row of rows) {
      if (row.status !== 'released') continue;
      const lock = lockOf(row);
      if (corridor.decimals === 2) need.set(row.idx, minorToStroops(row.copDue, corridor));
      else if (lock && row.lockedRate != null) need.set(row.idx, lockedStroops(row.copDue, lock.lockedRate));
      else need.set(row.idx, usdToStroops(row.usdDue ?? 0));
    }
    const total = [...need.values()].reduce((a, b) => a + b, 0n);

    // Round 1: the plan and the buyer's test USDC.
    await Promise.all([
      timed(`create_plan ${plan.id} → #${chainPlanId}`, () =>
        this.client.createPlan(
          chainPlanId,
          buyerId,
          rows.map((r) => ({ dueTs: base + r.idx, copDue: BigInt(Math.round(r.copDue)) })),
        ),
      ),
      ...(total > 0n ? [timed(`mint ${total} stroops to ${buyerId}`, () => this.client.mintTestUsdc(this.client.buyerPublic(buyerId), total))] : []),
    ]);
    // Round 2: the deposit that funds every seeded release.
    if (total > 0n) await timed(`deposit ${total}`, () => this.client.deposit(buyerId, chainPlanId, total));

    // Round 3: every seeded lock.
    const locks = seedState.locks
      .filter((l) => l.planId === plan.id && rows.some((r) => r.lockId === l.id && r.status !== 'open'))
      .sort((a, b) => a.idxs[0]! - b.idxs[0]!);
    await Promise.all(
      locks.map((lock) => {
        const broken = rows.some((r) => r.lockId === lock.id && r.status === 'broken');
        const expiryTs = broken ? base : nowSeconds(this.now()) + LOCK_EXPIRY_SECONDS;
        return timed(`apply_lock ${lock.id} [${lock.idxs.join(',')}]`, () =>
          this.client.applyLock(buyerId, chainPlanId, lock.idxs, lockIdBytes(lock.id), fixedPointRate(lock.lockedRate), expiryTs),
        );
      }),
    );

    // Round 4: releases (locked and spot) and breaks.
    const lockIds = new Set(locks.map((l) => l.id));
    await Promise.all(
      rows.flatMap((row): Promise<unknown>[] => {
        const locked = row.lockId != null && lockIds.has(row.lockId);
        if (row.status === 'released' && locked) return [timed(`release_due M${row.idx + 1}`, () => this.client.releaseDue(chainPlanId, row.idx))];
        if (row.status === 'released') return [timed(`release_spot M${row.idx + 1}`, () => this.client.releaseSpot(chainPlanId, row.idx, need.get(row.idx)!))];
        if (row.status === 'broken' && locked) return [timed(`break_lock M${row.idx + 1}`, () => this.client.breakLock(chainPlanId, row.idx))];
        return [];
      }),
    );
    steps.sort((a, b) => stepOrder(a.label) - stepOrder(b.label));
    return { chainPlanId, steps, elapsedMs: Date.now() - t0 };
  }

  async deposit(buyerId: string, chainPlanId: number, stroops: bigint): Promise<ChainTx> {
    await this.client.mintTestUsdc(this.client.buyerPublic(buyerId), stroops);
    const r = await this.client.deposit(buyerId, chainPlanId, stroops);
    return { txHash: r.txHash, ledger: r.ledger };
  }

  async applyLock(a: { chainPlanId: number; buyerId: string; idxs: number[]; lockId: Uint8Array; lockedRate: bigint; expiryTs: number }): Promise<ChainTx> {
    const r = await this.client.applyLock(a.buyerId, a.chainPlanId, a.idxs, a.lockId, a.lockedRate, a.expiryTs);
    return { txHash: r.txHash, ledger: r.ledger };
  }

  async releaseDue(chainPlanId: number, idx: number): Promise<ChainTx & { stroops: bigint }> {
    const r = await this.client.releaseDue(chainPlanId, idx);
    return { txHash: r.txHash, ledger: r.ledger, stroops: BigInt(r.result) };
  }

  async releaseSpot(chainPlanId: number, idx: number, stroops: bigint): Promise<ChainTx & { stroops: bigint }> {
    const r = await this.client.releaseSpot(chainPlanId, idx, stroops);
    return { txHash: r.txHash, ledger: r.ledger, stroops: BigInt(r.result) };
  }

  async breakLock(chainPlanId: number, idx: number): Promise<ChainTx> {
    const r = await this.client.breakLock(chainPlanId, idx);
    return { txHash: r.txHash, ledger: r.ledger };
  }

  getStatus(chainPlanId: number): Promise<ChainPlanStatus> {
    return this.client.getStatus(chainPlanId);
  }

  async adverse(a: AdverseAction): Promise<ChainTx & { result?: bigint }> {
    const ev = evidenceHash(a.evidence);
    const c = this.client;
    let r: { txHash: string; ledger: number; result: unknown };
    switch (a.kind) {
      case 'mark_missed':
        r = await c.markMissed(a.chainPlanId, a.idx, a.reason, ev);
        break;
      case 'cure':
        r = await c.cure(a.chainPlanId, a.idx, a.reason, ev);
        break;
      case 'waive':
        r = await c.waive(a.chainPlanId, a.idx, a.reason, ev);
        break;
      case 'declare_default':
        r = await c.declareDefault(a.chainPlanId, a.reason, ev);
        break;
      case 'place_hold':
        r = await c.placeHold(a.chainPlanId, a.reason, ev);
        break;
      case 'lift_hold':
        r = await c.liftHold(a.chainPlanId, a.reason, ev);
        break;
      case 'cancel_plan':
        r = await c.cancelPlan(a.chainPlanId, a.reason, ev);
        break;
      case 'complete_plan':
        r = await c.completePlan(a.chainPlanId, a.reason, ev);
        break;
      case 'refund':
        r = await c.refund(a.chainPlanId, a.stroops, a.reason, ev);
        break;
    }
    return { txHash: r.txHash, ledger: r.ledger, ...(typeof r.result === 'bigint' ? { result: r.result } : {}) };
  }

  async extendTtl(chainPlanId: number): Promise<ChainTx> {
    const r = await this.client.extendTtl(chainPlanId);
    return { txHash: r.txHash, ledger: r.ledger };
  }
}

/**
 * A corridor with `locksEnabled` false must never reach `apply_lock`: a seed that carries a lock,
 * a locked or broken row, or a locked rate for such a plan is a data error and is refused here,
 * before any transaction is built (the services refuse the live paths the same way).
 */
export function assertSeedHasNoLocks(plan: Plan, rows: Installment[], seedState: SeedPlanState): void {
  const corridor = corridorOf(plan);
  if (corridor.locksEnabled) return;
  const lockRows = rows.filter((r) => r.lockId != null || r.lockedRate != null || r.status === 'locked' || r.status === 'broken');
  const locks = seedState.locks.filter((l) => l.planId === plan.id);
  if (lockRows.length === 0 && locks.length === 0) return;
  const err = new LocksDisabledError(corridor.id);
  throw new ChainError(
    `seed ${plan.id}: ${err.message}; ${locks.length} lock(s) and ${lockRows.length} locked row(s) in the seed would call apply_lock`,
    { errorName: err.code, cause: err },
  );
}

/** Seed step labels sorted the way the rounds run, so logs read in a stable order. */
function stepOrder(label: string): number {
  const rank = ['create_plan', 'mint', 'deposit', 'apply_lock', 'release_due', 'release_spot', 'break_lock'].findIndex((p) => label.startsWith(p));
  const m = /M(\d+)/.exec(label);
  return rank * 100 + (m ? Number(m[1]) : 0);
}

export { ChainError };
