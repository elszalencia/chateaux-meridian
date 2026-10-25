// TestnetBridge seeding rules for a corridor without the FX leg (El Salvador): a seeded plan never
// calls apply_lock, every released installment is replayed with release_spot at exactly
// cents × 100,000 stroops, and a seed that carries a lock for a locks-disabled corridor is refused
// before any transaction is built. Fake ChainClient, no network.
import { describe, expect, it } from 'vitest';
import { CORRIDORS } from '../corridors/index';
import { PLAN_MARIA, PLAN_ROXANA, SV_DEMO_PLANS, buildSeed } from '../seed/fixtures';
import type { Installment, Lock, Plan } from '../domain/types';
import { TestnetBridge, assertSeedHasNoLocks, type SeedPlanState } from './bridge';
import type { ChainClient } from './client';
import { ChainError } from './submit';

interface Call {
  fn: string;
  args: unknown[];
}

function fakeClient() {
  const calls: Call[] = [];
  let n = 0;
  const tx = (fn: string, args: unknown[], result: unknown = undefined) => {
    calls.push({ fn, args });
    n += 1;
    return Promise.resolve({ txHash: `h${n}`, ledger: n, result });
  };
  const client = {
    contractId: 'CFAKESV',
    buyerPublic: (id: string) => `G${id}`,
    createPlan: (planId: number, buyerId: string, inits: { dueTs: number; copDue: bigint }[]) => tx('create_plan', [planId, buyerId, inits]),
    mintTestUsdc: (pub: string, stroops: bigint) => tx('mint', [pub, stroops]),
    deposit: (buyerId: string, planId: number, stroops: bigint) => tx('deposit', [buyerId, planId, stroops], stroops),
    applyLock: (...args: unknown[]) => tx('apply_lock', args),
    releaseDue: (planId: number, idx: number) => tx('release_due', [planId, idx], 1n),
    releaseSpot: (planId: number, idx: number, s: bigint) => tx('release_spot', [planId, idx, s], s),
    breakLock: (planId: number, idx: number) => tx('break_lock', [planId, idx]),
  };
  return { calls, client: client as unknown as ChainClient };
}

const seed = buildSeed();
const planOf = (id: string): Plan => seed.plans.find((p) => p.id === id)!;
const rowsOf = (id: string): Installment[] => seed.installments.filter((i) => i.planId === id);
const stateOf = (id: string): SeedPlanState => ({ locks: seed.locks.filter((l) => l.planId === id), receipts: seed.receipts.filter((r) => r.planId === id) });
const now = Date.parse('2026-10-25T15:30:45Z');

describe('TestnetBridge seeds an El Salvador plan', () => {
  it('the seed corridor is the one without locks and holds cents', () => {
    const c = CORRIDORS[planOf(PLAN_ROXANA).corridor!];
    expect(c.locksEnabled).toBe(false);
    expect(c.decimals).toBe(2);
  });

  it('Roxana: create → mint → deposit → release_spot per released row at exactly cents × 100,000; never apply_lock', async () => {
    const { calls, client } = fakeClient();
    const rows = rowsOf(PLAN_ROXANA);
    const released = rows.filter((r) => r.status === 'released');
    expect(released.length).toBeGreaterThan(0);
    const r = await new TestnetBridge(client, () => now).seedPlan(planOf(PLAN_ROXANA), rows, stateOf(PLAN_ROXANA));
    const fns = calls.map((c) => c.fn);
    expect(fns.filter((f) => f === 'apply_lock' || f === 'release_due' || f === 'break_lock')).toEqual([]);
    expect(fns.slice(0, 3)).toEqual(['create_plan', 'mint', 'deposit']);
    expect(fns.slice(3)).toEqual(released.map(() => 'release_spot'));
    // cop_due goes on chain as cents, unchanged.
    const inits = calls[0]!.args[2] as { dueTs: number; copDue: bigint }[];
    expect(inits).toHaveLength(rows.length);
    expect(inits[0]!.copDue).toBe(BigInt(rows[0]!.copDue));
    // Each release moves cents × 100,000 stroops: exact integer arithmetic, no float on the way.
    const spots = calls.filter((c) => c.fn === 'release_spot');
    for (const [k, row] of released.entries()) {
      expect(spots[k]!.args[1]).toBe(row.idx);
      expect(spots[k]!.args[2]).toBe(BigInt(row.copDue) * 100_000n);
    }
    expect(spots[0]!.args[2]).toBe(7_500_000_000n); // USD 750.00
    const total = released.reduce((a, row) => a + BigInt(row.copDue) * 100_000n, 0n);
    expect(calls[1]!.args[1]).toBe(total);
    expect(calls[2]!.args[2]).toBe(total);
    expect(r.steps.map((s) => s.label.split(' ')[0])).toEqual(['create_plan', 'mint', 'deposit', ...released.map(() => 'release_spot')]);
  });

  it('every El Salvador seed plan replays without a single lock call', async () => {
    for (const id of SV_DEMO_PLANS) {
      const { calls, client } = fakeClient();
      await new TestnetBridge(client, () => now).seedPlan(planOf(id), rowsOf(id), stateOf(id));
      expect(calls.some((c) => c.fn === 'apply_lock'), id).toBe(false);
      expect(calls[0]!.fn).toBe('create_plan');
    }
  });

  it('a lock in the seed of a locks-disabled corridor is refused before anything is sent', async () => {
    const { calls, client } = fakeClient();
    const plan = planOf(PLAN_ROXANA);
    const rows = rowsOf(PLAN_ROXANA).map((r) => ({ ...r }));
    const lock: Lock = { ...seed.locks.find((l) => l.planId === PLAN_MARIA)!, id: 'lock-roxana-bogus', planId: PLAN_ROXANA, idxs: [6, 7, 8] };
    for (const idx of lock.idxs) Object.assign(rows[idx]!, { status: 'locked', lockId: lock.id, lockedRate: lock.lockedRate });
    const err = await new TestnetBridge(client, () => now)
      .seedPlan(plan, rows, { locks: [lock], receipts: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainError);
    expect((err as ChainError).errorName).toBe('LOCKS_DISABLED');
    expect((err as ChainError).message).toContain(PLAN_ROXANA);
    expect(calls).toEqual([]);
  });

  it('a locked row alone (no lock record) is refused too; the Colombia seed passes the guard', () => {
    const rows = rowsOf(PLAN_ROXANA).map((r) => ({ ...r }));
    Object.assign(rows[7]!, { lockedRate: 1 });
    expect(() => assertSeedHasNoLocks(planOf(PLAN_ROXANA), rows, { locks: [], receipts: [] })).toThrow(ChainError);
    expect(() => assertSeedHasNoLocks(planOf(PLAN_MARIA), rowsOf(PLAN_MARIA), stateOf(PLAN_MARIA))).not.toThrow();
    expect(() => assertSeedHasNoLocks(planOf(PLAN_ROXANA), rowsOf(PLAN_ROXANA), stateOf(PLAN_ROXANA))).not.toThrow();
  });
});
