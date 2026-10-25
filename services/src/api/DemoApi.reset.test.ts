// DemoApi.reset in testnet mode, with one fake bridge per corridor: every seed plan goes to the
// bridge of its own corridor and to no other (no El Salvador plan through the Colombia bridge),
// without the server re-seeding anything afterwards. When the network refuses create_plan because
// its fee is above what one transaction can carry, the reset neither retries nor fails: a chain
// plan the instance already holds is kept, otherwise the plan runs off chain marked "simulado"
// and every later call for it stays off chain.
import { describe, expect, it } from 'vitest';
import { ApiError, DemoApi } from './DemoApi';
import { MemoryStore } from '../store/MemoryStore';
import { MockRuntime } from '../adapters/mockRuntime';
import { MockHedgeProvider } from '../adapters/mockHedge';
import { MockOnRampProvider } from '../adapters/mockOnRamp';
import { MockOffRampProvider } from '../adapters/mockOffRamp';
import { InternalLockProvider } from '../adapters/mockLock';
import { corridorIdOf, type CorridorId } from '../corridors/index';
import { ADVERSE_DEMO_PLANS, BASE_DATE, PLAN_MARVIN, PLAN_ROXANA, buildSeed } from '../seed/fixtures';
import { ChainError } from '../chain/submit';
import type { Installment, Plan, Snapshot } from '../domain/types';
import type { ChainBridge, ChainTx, SeedPlanState } from '../chain/bridge';
import type { ChainPlanStatus } from '../chain/client';

const T0 = Date.parse('2026-10-20T15:00:00Z');

class CorridorBridge implements ChainBridge {
  readonly seeded: { planId: string; corridor: CorridorId }[] = [];
  readonly calls: { fn: string; args: unknown[] }[] = [];
  /** Chain plan ids this instance holds (getStatus answers for these only). */
  readonly known = new Set<number>();
  /** Plans whose create_plan the network refuses, and how. */
  refuse = new Map<string, Error>();
  private next: number;
  constructor(
    readonly contractId: string,
    firstId: number,
  ) {
    this.next = firstId;
  }
  async seedPlan(plan: Plan, _installments: Installment[], _s: SeedPlanState) {
    const err = this.refuse.get(plan.id);
    if (err) throw err;
    this.seeded.push({ planId: plan.id, corridor: corridorIdOf(plan) });
    const chainPlanId = (this.next += 1);
    this.known.add(chainPlanId);
    return { chainPlanId, steps: [], elapsedMs: 1 };
  }
  private tx(fn: string, args: unknown[]): ChainTx {
    this.calls.push({ fn, args });
    return { txHash: `${fn}-${this.calls.length}`.padEnd(64, '0'), ledger: 1 };
  }
  async deposit(buyerId: string, chainPlanId: number, stroops: bigint) {
    return this.tx('deposit', [buyerId, chainPlanId, stroops]);
  }
  async applyLock(a: unknown) {
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
  async getStatus(chainPlanId: number): Promise<ChainPlanStatus> {
    if (!this.known.has(chainPlanId)) throw new ChainError('get_status: contract error PlanNotFound (#2)', { code: 2 });
    return {} as ChainPlanStatus;
  }
  async adverse(a: { kind: string }) {
    return this.tx(a.kind, [a]);
  }
  async extendTtl(chainPlanId: number) {
    return this.tx('extendTtl', [chainPlanId]);
  }
}

function apiWith(chains: Partial<Record<CorridorId, ChainBridge>>, mutate: (seed: Snapshot) => void = () => {}) {
  const seed = buildSeed();
  mutate(seed);
  const store = new MemoryStore(seed);
  const runtime = new MockRuntime({ minDelayMs: 0, maxDelayMs: 0 });
  const now = () => T0;
  let seq = 600;
  const hedge = new MockHedgeProvider({ runtime, baseDate: BASE_DATE, tradeSource: () => store.all('hedge_trades'), nextSeq: () => (seq += 1) });
  const providers = { hedge, onRamp: new MockOnRampProvider(runtime), offRamp: new MockOffRampProvider(runtime), lock: new InternalLockProvider(runtime, hedge, now) };
  const logs: string[] = [];
  const api = new DemoApi({ store, providers, runtime, now, chains, log: (m) => logs.push(m) });
  return { api, store, logs };
}

/** Seed plans that go on chain, per corridor. */
function chainSeedPlans(): Record<CorridorId, string[]> {
  const out: Record<CorridorId, string[]> = { co: [], sv: [] };
  for (const p of buildSeed().plans) if (!ADVERSE_DEMO_PLANS.includes(p.id)) out[corridorIdOf(p)].push(p.id);
  return out;
}

const feeTooHigh = () =>
  new ChainError('create_plan: needs 4929.0 XLM in fees, more than one transaction can carry (429.5 XLM)', { errorName: 'FeeTooHigh' });

describe('DemoApi.reset in testnet mode', () => {
  it('seeds each plan through the bridge of its own corridor only', async () => {
    const co = new CorridorBridge('CFAKECO', 100);
    const sv = new CorridorBridge('CFAKESV', 500);
    const { api } = apiWith({ co, sv });
    const expected = chainSeedPlans();
    expect(expected.co.length).toBeGreaterThan(0);
    expect(expected.sv.length).toBeGreaterThan(0);

    const { state } = await api.reset();

    expect(co.seeded.map((s) => s.planId).sort()).toEqual([...expected.co].sort());
    expect(sv.seeded.map((s) => s.planId).sort()).toEqual([...expected.sv].sort());
    expect(co.seeded.every((s) => s.corridor === 'co')).toBe(true);
    expect(sv.seeded.every((s) => s.corridor === 'sv')).toBe(true);
    expect(state.chainContractIds).toEqual({ co: 'CFAKECO', sv: 'CFAKESV' });
    expect(state.chainContractId).toBe('CFAKECO');
    // every mapped id belongs to the instance of the plan's corridor
    for (const id of expected.co) expect(co.known.has(state.chainPlans![id]!)).toBe(true);
    for (const id of expected.sv) expect(sv.known.has(state.chainPlans![id]!)).toBe(true);
    expect(state.simulatedPlans).toBeUndefined();
  });

  it('with only the Colombia bridge, no El Salvador plan is sent to it', async () => {
    const co = new CorridorBridge('CFAKECO', 100);
    const { api } = apiWith({ co });
    const { state } = await api.reset();
    expect(co.seeded.map((s) => s.planId).sort()).toEqual([...chainSeedPlans().co].sort());
    for (const id of chainSeedPlans().sv) expect(state.chainPlans?.[id]).toBeUndefined();
  });

  it('a refused create_plan keeps the existing chain plan or runs the plan off chain, marked simulado, without retrying', async () => {
    const co = new CorridorBridge('CFAKECO', 100);
    const sv = new CorridorBridge('CFAKESV', 500);
    sv.known.add(77); // Roxana's plan from an earlier reset is still on the SV instance
    sv.refuse.set(PLAN_ROXANA, feeTooHigh());
    sv.refuse.set(PLAN_MARVIN, feeTooHigh());
    const { api, logs } = apiWith({ co, sv }, (seed) => {
      seed.demo_state[0] = { ...seed.demo_state[0]!, mode: 'testnet', chainContractIds: { co: 'CFAKECO', sv: 'CFAKESV' }, chainPlans: { [PLAN_ROXANA]: 77, [PLAN_MARVIN]: 78 } };
    });

    const { state } = await api.reset();

    expect(state.chainPlans?.[PLAN_ROXANA]).toBe(77);
    expect(state.chainPlans?.[PLAN_MARVIN]).toBeUndefined();
    expect(state.simulatedPlans).toEqual({ [PLAN_MARVIN]: expect.stringMatching(/^simulado: create_plan: needs 4929\.0 XLM/) });
    expect(sv.seeded.map((s) => s.planId)).not.toContain(PLAN_MARVIN);
    expect(logs.some((l) => l.includes(PLAN_ROXANA) && l.includes('kept existing chain plan #77'))).toBe(true);
    expect(logs.some((l) => l.includes(PLAN_MARVIN) && l.includes('marked simulado'))).toBe(true);
    // the other corridor is unaffected
    expect(co.seeded.map((s) => s.planId).sort()).toEqual([...chainSeedPlans().co].sort());

    // Marvin pays by ACH: the payment is recorded off chain, nothing reaches the bridge.
    const before = sv.calls.length;
    await api.pay(PLAN_MARVIN, 3);
    expect(sv.calls.slice(before)).toEqual([]);
    expect((await api.getPlan(PLAN_MARVIN)).installments[3]!.cellState).not.toBe('abierto');
  });

  it('a refused create_plan on a chain plan id of another instance is not kept', async () => {
    const co = new CorridorBridge('CFAKECO', 100);
    const sv = new CorridorBridge('CFAKESV', 500);
    sv.known.add(77);
    sv.refuse.set(PLAN_ROXANA, feeTooHigh());
    const { api } = apiWith({ co, sv }, (seed) => {
      seed.demo_state[0] = { ...seed.demo_state[0]!, mode: 'testnet', chainContractIds: { co: 'CFAKECO', sv: 'COLDSV' }, chainPlans: { [PLAN_ROXANA]: 77 } };
    });
    const { state } = await api.reset();
    expect(state.chainPlans?.[PLAN_ROXANA]).toBeUndefined();
    expect(Object.keys(state.simulatedPlans ?? {})).toEqual([PLAN_ROXANA]);
  });

  it('any other chain failure still fails the reset with the PROVIDER error', async () => {
    const sv = new CorridorBridge('CFAKESV', 500);
    sv.refuse.set(PLAN_ROXANA, new ChainError('create_plan: simulation failed: boom', { errorName: 'SimulationFailed' }));
    const { api } = apiWith({ co: new CorridorBridge('CFAKECO', 100), sv });
    const err = await api.reset().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'PROVIDER' });
  });
});
