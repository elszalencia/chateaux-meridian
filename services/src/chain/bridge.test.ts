// Wiring of DemoApi onto the ChainBridge seam, with a fake bridge that records calls (no network),
// and the seed replay order of TestnetBridge over a fake ChainClient.
import { describe, expect, it } from 'vitest';
import { createTestnetApi } from '../api/createTestnetApi';
import { ApiError } from '../api/DemoApi';
import { PLAN_ANDRES, PLAN_CAMILA, PLAN_MARIA, buildSeed } from '../seed/fixtures';
import { fixedPointRate } from '../lock/engine';
import {
  LOCK_EXPIRY_SECONDS,
  TestnetBridge,
  lockIdBytes,
  lockedStroops,
  seedBaseTs,
  usdToStroops,
  type AdverseAction,
  type ChainBridge,
  type ChainTx,
  type SeedPlanState,
} from './bridge';
import type { ChainClient, ChainPlanStatus } from './client';
import { ChainError } from './submit';
import type { Installment, Plan } from '../domain/types';

interface Call {
  fn: string;
  args: unknown[];
}

class FakeBridge implements ChainBridge {
  readonly contractId = 'CFAKECONTRACT';
  readonly calls: Call[] = [];
  private seq = 0;
  failWith: ChainError | null = null;
  seedCount = 0;

  private tx(fn: string, args: unknown[]): ChainTx {
    this.calls.push({ fn, args });
    if (this.failWith) throw this.failWith;
    this.seq += 1;
    return { txHash: `${fn}-hash-${this.seq}`.padEnd(64, '0'), ledger: 1000 + this.seq };
  }

  async seedPlan(plan: Plan, installments: Installment[], seedState: SeedPlanState) {
    this.calls.push({ fn: 'seedPlan', args: [plan.id, installments.length, seedState.locks.length] });
    this.seedCount += 1;
    return { chainPlanId: 9000 + this.seedCount, steps: [], elapsedMs: 1 };
  }
  async deposit(buyerId: string, chainPlanId: number, stroops: bigint) {
    return this.tx('deposit', [buyerId, chainPlanId, stroops]);
  }
  async applyLock(a: { chainPlanId: number; buyerId: string; idxs: number[]; lockId: Uint8Array; lockedRate: bigint; expiryTs: number }) {
    return this.tx('applyLock', [a]);
  }
  async releaseDue(chainPlanId: number, idx: number) {
    return { ...this.tx('releaseDue', [chainPlanId, idx]), stroops: 0n };
  }
  async releaseSpot(chainPlanId: number, idx: number, stroops: bigint) {
    return { ...this.tx('releaseSpot', [chainPlanId, idx, stroops]), stroops };
  }
  async breakLock(chainPlanId: number, idx: number) {
    return this.tx('breakLock', [chainPlanId, idx]);
  }
  async getStatus(): Promise<ChainPlanStatus> {
    throw new Error('not used');
  }
  async adverse(a: AdverseAction) {
    return this.tx(a.kind, [a]);
  }
  async extendTtl(chainPlanId: number) {
    return this.tx('extendTtl', [chainPlanId]);
  }
}

const CHAIN_PLANS = { [PLAN_MARIA]: 101, [PLAN_ANDRES]: 102, [PLAN_CAMILA]: 103 };

function fastApi(bridge: FakeBridge, now?: () => number) {
  return createTestnetApi({ chain: bridge, chainPlans: CHAIN_PLANS, minDelayMs: 0, maxDelayMs: 0, now });
}

describe('helpers', () => {
  it('lock ids hash to 32 bytes; USD cents convert exactly to stroops; the seed base is the previous minute', () => {
    expect(lockIdBytes('lock-maria-q2')).toHaveLength(32);
    expect(lockIdBytes('a')).not.toEqual(lockIdBytes('b'));
    expect(usdToStroops(1188.33)).toBe(11_883_300_000n);
    expect(usdToStroops(0.01)).toBe(100_000n);
    expect(lockedStroops(4_093_125, 3444.4266666666665)).toBe(11_883_327_462n);
    const now = Date.parse('2026-10-21T15:30:45Z');
    expect(seedBaseTs(now)).toBe(Math.floor(now / 1000 / 60) * 60 - 60);
  });
});

describe('DemoApi over a fake ChainBridge', () => {
  it('acceptLock on María Q3 calls apply_lock with locked_rate 34444266667n, idxs 6..8 and a one-minute expiry', async () => {
    const t = Date.parse('2026-10-20T15:00:00Z');
    const bridge = new FakeBridge();
    const api = fastApi(bridge, () => t);
    const q = await api.quoteLock(PLAN_MARIA, 'trimestral');
    const view = await api.acceptLock(q.lock.id);
    expect(view.installments.slice(6, 9).map((i) => i.cellState)).toEqual(['bloqueado', 'bloqueado', 'bloqueado']);
    const call = bridge.calls.find((c) => c.fn === 'applyLock')!;
    const a = call.args[0] as { chainPlanId: number; buyerId: string; idxs: number[]; lockId: Uint8Array; lockedRate: bigint; expiryTs: number };
    expect(a.chainPlanId).toBe(101);
    expect(a.buyerId).toBe('buyer-maria');
    expect(a.idxs).toEqual([6, 7, 8]);
    expect(a.lockedRate).toBe(34_444_266_667n);
    expect(a.lockedRate).toBe(fixedPointRate(q.lockedRate));
    expect(a.lockId).toEqual(lockIdBytes(q.lock.id));
    expect(a.expiryTs).toBe(Math.floor(t / 1000) + LOCK_EXPIRY_SECONDS);
  });

  it('pay M4 deposits 11883327462 stroops, then release_due, and the receipt carries the release tx hash', async () => {
    const bridge = new FakeBridge();
    const api = fastApi(bridge);
    await api.advanceClock(1); // also breaks Andrés M5 (beyond grace) through the job: not part of this check
    bridge.calls.length = 0;
    const steps: string[] = [];
    const receipt = await api.pay(PLAN_MARIA, 3, (s) => steps.push(s));
    expect(steps).toEqual(['recibido', 'convertido', 'entregado']);
    expect(bridge.calls.map((c) => c.fn)).toEqual(['deposit', 'releaseDue']);
    expect(bridge.calls[0]!.args).toEqual(['buyer-maria', 101, 11_883_327_462n]);
    expect(bridge.calls[1]!.args).toEqual([101, 3]);
    expect(receipt.txHash).toMatch(/^releaseDue-hash-\d/);
    expect(receipt.usdPaid).toBe(1188.33);
    const view = await api.getPlan(PLAN_MARIA);
    expect(view.installments[3]!.releasedTx).toBe(receipt.txHash);
    expect(view.installments[3]!.cellState).toBe('pagado');
  });

  it('payAhead deposits the quarter total once, then release_spot per installment', async () => {
    const bridge = new FakeBridge();
    const api = fastApi(bridge);
    const receipts = await api.payAhead(PLAN_MARIA);
    const fns = bridge.calls.map((c) => c.fn);
    expect(fns).toEqual(['deposit', 'releaseSpot', 'releaseSpot', 'releaseSpot']);
    const each = usdToStroops(1196.01);
    expect(bridge.calls[0]!.args).toEqual(['buyer-maria', 101, each * 3n]);
    expect(bridge.calls[1]!.args).toEqual([101, 6, each]);
    expect(receipts.map((r) => r.txHash)).toEqual(bridge.calls.slice(1).map((c, k) => `releaseSpot-hash-${k + 2}`.padEnd(64, '0')));
  });

  it('the break job calls break_lock, and a broken installment paid at spot retries the break first', async () => {
    const bridge = new FakeBridge();
    const api = fastApi(bridge);
    await api.advanceClock(2); // María M4 beyond grace → broken
    expect(bridge.calls.some((c) => c.fn === 'breakLock' && c.args[0] === 101 && c.args[1] === 3)).toBe(true);
    bridge.calls.length = 0;
    await api.pay(PLAN_MARIA, 3);
    expect(bridge.calls.map((c) => c.fn)).toEqual(['deposit', 'breakLock', 'releaseSpot']);
  });

  it('reset re-seeds every plan on chain and stores the new chain plan ids with the reset time', async () => {
    const bridge = new FakeBridge();
    const api = fastApi(bridge);
    await api.advanceClock(1);
    await api.pay(PLAN_MARIA, 3);
    const { state, elapsedMs } = await api.reset();
    // The Colombia plans are seeded on this (Colombia) bridge, in seed order; the El Salvador plans
    // belong to the `chains.sv` bridge (see bridge.sv.test.ts) and are not asserted here.
    const co = [PLAN_MARIA, PLAN_ANDRES, PLAN_CAMILA];
    const seeded = bridge.calls.filter((c) => c.fn === 'seedPlan').map((c) => c.args[0] as string);
    expect(seeded.filter((id) => co.includes(id))).toEqual(co);
    for (const id of co) expect(state.chainPlans![id]).toBe(9000 + seeded.indexOf(id) + 1);
    expect(state.chainContractId).toBe('CFAKECONTRACT');
    expect(state.mode).toBe('testnet');
    expect(state.lastResetMs).toBe(elapsedMs);
    expect(state.today).toBe('2026-10-20');
    const view = await api.getPlan(PLAN_MARIA);
    expect(view.installments[3]!.cellState).toBe('bloqueado');
    // the next payment uses the new plan id
    await api.advanceClock(1);
    bridge.calls.length = 0;
    await api.pay(PLAN_MARIA, 3);
    expect(bridge.calls[0]!.args).toEqual(['buyer-maria', state.chainPlans![PLAN_MARIA], 11_883_327_462n]);
  });

  it('a chain failure surfaces as ApiError PROVIDER carrying the contract error name', async () => {
    const bridge = new FakeBridge();
    const api = fastApi(bridge);
    await api.advanceClock(1);
    bridge.failWith = new ChainError('release_due: contract error NotDue (#11)', { code: 11 });
    const err = await api.pay(PLAN_MARIA, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('PROVIDER');
    expect((err as ApiError).message).toContain('NotDue');
    const view = await api.getPlan(PLAN_MARIA);
    expect(view.installments[3]!.cellState).toBe('bloqueado'); // nothing recorded
  });

  it('a persisted snapshot from another contract is discarded, one from this contract is reused', async () => {
    const bridge = new FakeBridge();
    const other = buildSeed();
    other.demo_state[0] = { ...other.demo_state[0]!, mode: 'testnet', chainContractId: 'COTHER', chainPlans: { [PLAN_MARIA]: 1 }, clockOffsetMonths: 3, today: '2027-01-20' };
    const persistence = { load: () => other, save: () => undefined, clear: () => undefined };
    const api = createTestnetApi({ chain: bridge, chainPlans: CHAIN_PLANS, persistence, minDelayMs: 0, maxDelayMs: 0 });
    const s = await api.getDemoState();
    expect(s.today).toBe('2026-10-20');
    expect(s.chainPlans).toEqual(CHAIN_PLANS);

    const same = buildSeed();
    same.demo_state[0] = { ...same.demo_state[0]!, mode: 'testnet', chainContractId: 'CFAKECONTRACT', chainPlans: { [PLAN_MARIA]: 7 }, clockOffsetMonths: 1, today: '2026-11-20' };
    const api2 = createTestnetApi({ chain: bridge, chainPlans: CHAIN_PLANS, persistence: { ...persistence, load: () => same }, minDelayMs: 0, maxDelayMs: 0 });
    expect((await api2.getDemoState()).today).toBe('2026-11-20');
  });
});

describe('TestnetBridge seed replay over a fake ChainClient', () => {
  function fakeClient() {
    const calls: Call[] = [];
    let n = 0;
    const tx = (fn: string, args: unknown[], result: unknown = undefined) => {
      calls.push({ fn, args });
      n += 1;
      return Promise.resolve({ txHash: `h${n}`, ledger: n, result });
    };
    const client = {
      contractId: 'CFAKE',
      buyerPublic: (id: string) => `G${id}`,
      createPlan: (planId: number, buyerId: string, inits: { dueTs: number; copDue: bigint }[]) => tx('create_plan', [planId, buyerId, inits]),
      mintTestUsdc: (pub: string, stroops: bigint) => tx('mint', [pub, stroops]),
      deposit: (buyerId: string, planId: number, stroops: bigint) => tx('deposit', [buyerId, planId, stroops], stroops),
      applyLock: (buyerId: string, planId: number, idxs: number[], lockId: Uint8Array, rate: bigint, expiry: number) => tx('apply_lock', [buyerId, planId, idxs, lockId, rate, expiry]),
      releaseDue: (planId: number, idx: number) => tx('release_due', [planId, idx], 1n),
      releaseSpot: (planId: number, idx: number, s: bigint) => tx('release_spot', [planId, idx, s], s),
      breakLock: (planId: number, idx: number) => tx('break_lock', [planId, idx]),
    };
    return { calls, client: client as unknown as ChainClient };
  }

  const seed = buildSeed();
  const stateOf = (planId: string): SeedPlanState => ({ locks: seed.locks.filter((l) => l.planId === planId), receipts: seed.receipts.filter((r) => r.planId === planId) });
  const rowsOf = (planId: string) => seed.installments.filter((i) => i.planId === planId);
  const now = Date.parse('2026-10-21T15:30:45Z');

  it('María: create (24, compressed due dates) → mint → deposit → lock Q1 → 3 × release_due → lock Q2', async () => {
    const { calls, client } = fakeClient();
    const r = await new TestnetBridge(client, () => now).seedPlan(seed.plans[0]!, rowsOf(PLAN_MARIA), stateOf(PLAN_MARIA));
    expect(calls.map((c) => c.fn)).toEqual(['create_plan', 'mint', 'deposit', 'apply_lock', 'apply_lock', 'release_due', 'release_due', 'release_due']);
    const inits = calls[0]!.args[2] as { dueTs: number; copDue: bigint }[];
    expect(inits).toHaveLength(24);
    expect(inits[0]!.dueTs).toBe(seedBaseTs(now));
    expect(inits[23]!.dueTs).toBe(seedBaseTs(now) + 23);
    expect(inits[0]!.copDue).toBe(4_093_125n);
    expect(calls[2]!.args[2]).toBe(3n * 11_883_327_462n);
    expect(calls[3]!.args[2]).toEqual([0, 1, 2]);
    expect(calls[3]!.args[5]).toBe(Math.floor(now / 1000) + LOCK_EXPIRY_SECONDS);
    expect(calls[4]!.args[2]).toEqual([3, 4, 5]);
    expect(calls.slice(5).map((c) => c.args[1])).toEqual([0, 1, 2]);
    expect(r.steps).toHaveLength(8);
    expect(r.chainPlanId).toBeGreaterThan(0);
  });

  it('Andrés: locks Q1 (already-passed expiry) and Q2 → release M1, M2, break M3, release M4', async () => {
    const { calls, client } = fakeClient();
    await new TestnetBridge(client, () => now).seedPlan(seed.plans[1]!, rowsOf(PLAN_ANDRES), stateOf(PLAN_ANDRES));
    expect(calls.map((c) => c.fn)).toEqual(['create_plan', 'mint', 'deposit', 'apply_lock', 'apply_lock', 'release_due', 'release_due', 'break_lock', 'release_due']);
    expect(calls[3]!.args[5]).toBe(seedBaseTs(now)); // breakable right away
    expect(calls[7]!.args).toEqual([calls[0]!.args[0], 2]);
    expect(calls[4]!.args[5]).toBe(Math.floor(now / 1000) + LOCK_EXPIRY_SECONDS);
  });

  it('seeding runs in four rounds: every call of a round starts before any of the next', async () => {
    const order: string[] = [];
    const pending: (() => void)[] = [];
    const tx = (fn: string) =>
      new Promise<{ txHash: string; ledger: number; result: bigint }>((resolve) => {
        order.push(`start ${fn}`);
        pending.push(() => {
          order.push(`end ${fn}`);
          resolve({ txHash: fn, ledger: 1, result: 1n });
        });
      });
    const client = {
      contractId: 'CFAKE',
      buyerPublic: (id: string) => `G${id}`,
      createPlan: () => tx('create_plan'),
      mintTestUsdc: () => tx('mint'),
      deposit: () => tx('deposit'),
      applyLock: () => tx('apply_lock'),
      releaseDue: () => tx('release_due'),
      releaseSpot: () => tx('release_spot'),
      breakLock: () => tx('break_lock'),
    } as unknown as ChainClient;
    const run = new TestnetBridge(client, () => now).seedPlan(seed.plans[0]!, rowsOf(PLAN_MARIA), stateOf(PLAN_MARIA));
    const flush = async () => {
      for (let k = 0; k < 20; k += 1) await Promise.resolve();
      while (pending.length) pending.shift()!();
      for (let k = 0; k < 20; k += 1) await Promise.resolve();
    };
    for (let round = 0; round < 4; round += 1) await flush();
    await run;
    expect(order).toEqual([
      'start create_plan', 'start mint', 'end create_plan', 'end mint',
      'start deposit', 'end deposit',
      'start apply_lock', 'start apply_lock', 'end apply_lock', 'end apply_lock',
      'start release_due', 'start release_due', 'start release_due', 'end release_due', 'end release_due', 'end release_due',
    ]);
  });

  it('Camila: create → mint → deposit → 2 × release_spot at the receipts\' USD', async () => {
    const { calls, client } = fakeClient();
    await new TestnetBridge(client, () => now).seedPlan(seed.plans[2]!, rowsOf(PLAN_CAMILA), stateOf(PLAN_CAMILA));
    expect(calls.map((c) => c.fn)).toEqual(['create_plan', 'mint', 'deposit', 'release_spot', 'release_spot']);
    const camila = rowsOf(PLAN_CAMILA);
    expect(calls[3]!.args[2]).toBe(usdToStroops(camila[0]!.usdDue!));
    expect(calls[2]!.args[2]).toBe(usdToStroops(camila[0]!.usdDue!) + usdToStroops(camila[1]!.usdDue!));
  });
});
