// Routing of a plan to the contract instance of its corridor, end to end on the service side:
// the environment names one contract id and one payee per corridor (config/corridors.ts
// `chainEnv`), the testnet stack builds one bridge per instance, and every chain call for a plan
// (deposit, release, lock, TTL bookkeeping) reaches the instance of that plan's corridor and never
// the other one. Fake bridges, no network.
import { describe, expect, it } from 'vitest';
import { createTestnetStack } from '../api/createTestnetApi';
import { CORRIDORS, corridorIdOf, type CorridorId } from '../corridors/index';
import { OFFICE_MAXI_WOODBRIDGE, PLAN_ANDRES, PLAN_MARIA, PLAN_MARVIN, PLAN_ROXANA } from '../seed/fixtures';
import { chainConfigFor, chainPlansFromEnv, optionalChainConfigFor, type EnvVars } from './env';
import type { ChainBridge, ChainTx, SeedPlanState } from './bridge';
import type { ChainPlanStatus } from './client';
import type { Installment, Plan } from '../domain/types';

const T0 = Date.parse('2026-10-20T15:00:00Z');

/** Placeholder values only: chainConfigFor reads names, it does not validate keys. */
function env(withSv: boolean): EnvVars {
  const e: EnvVars = {
    PAYMENT_PLAN_CONTRACT_ID: 'C-CO-INSTANCE',
    PAYEE_BACKEND_PUBLIC: 'G-CO-PAYEE',
    USDC_SAC_ID: 'C-USDC',
    USDC_ISSUER_SECRET: 'S-ISSUER',
    OPERATOR_SECRET: 'S-OPERATOR',
    CHAIN_PLAN_MARIA: '11',
    CHAIN_PLAN_ROXANA: '21',
    CHAIN_PLAN_MARVIN: 'not-a-number',
  };
  for (const b of ['MARIA', 'ANDRES', 'CAMILA', 'ROXANA', 'MARVIN', 'DORIS', 'OSCAR']) e[`BUYER_SECRET_${b}`] = `S-${b}`;
  if (withSv) Object.assign(e, { PAYMENT_PLAN_CONTRACT_ID_SV: 'C-SV-INSTANCE', PAYEE_BACKEND_SV_PUBLIC: 'G-SV-PAYEE' });
  return e;
}

class InstanceBridge implements ChainBridge {
  readonly calls: { fn: string; chainPlanId: number }[] = [];
  constructor(readonly contractId: string) {}
  private tx(fn: string, chainPlanId: number): ChainTx {
    this.calls.push({ fn, chainPlanId });
    return { txHash: `${this.contractId}-${fn}-${this.calls.length}`.padEnd(64, '0'), ledger: 1 };
  }
  async seedPlan(_p: Plan, _i: Installment[], _s: SeedPlanState) {
    return { chainPlanId: 1, steps: [], elapsedMs: 0 };
  }
  async deposit(_b: string, chainPlanId: number, _s: bigint) {
    return this.tx('deposit', chainPlanId);
  }
  async applyLock(a: { chainPlanId: number }) {
    return this.tx('applyLock', a.chainPlanId);
  }
  async releaseDue(chainPlanId: number, _idx: number) {
    return { ...this.tx('releaseDue', chainPlanId), stroops: 0n };
  }
  async releaseSpot(chainPlanId: number, _idx: number, stroops: bigint) {
    return { ...this.tx('releaseSpot', chainPlanId), stroops };
  }
  async breakLock(chainPlanId: number, _idx: number) {
    return this.tx('breakLock', chainPlanId);
  }
  async getStatus(): Promise<ChainPlanStatus> {
    throw new Error('not used');
  }
  async adverse(a: { kind: string; chainPlanId?: number }) {
    return this.tx(a.kind, a.chainPlanId ?? -1);
  }
  async extendTtl(chainPlanId: number) {
    return this.tx('extendTtl', chainPlanId);
  }
}

describe('corridor → instance routing', () => {
  it('the environment names a separate contract and payee per corridor', () => {
    const co = chainConfigFor('co', env(true));
    const sv = chainConfigFor('sv', env(true));
    expect(co).toMatchObject({ contractId: 'C-CO-INSTANCE', payeeBackendPublic: 'G-CO-PAYEE' });
    expect(sv).toMatchObject({ contractId: 'C-SV-INSTANCE', payeeBackendPublic: 'G-SV-PAYEE' });
    // the keys come from the corridor config, not from literals in the env reader
    expect(CORRIDORS.sv.chainEnv.contractIdKey).toBe('PAYMENT_PLAN_CONTRACT_ID_SV');
    // shared operator and test USDC
    expect(sv.operatorSecret).toBe(co.operatorSecret);
    expect(sv.usdcSacId).toBe(co.usdcSacId);
  });

  it('an undeployed corridor is off chain; a half-configured one is an error, not a silent downgrade', () => {
    expect(optionalChainConfigFor('sv', env(false))).toBeNull();
    expect(optionalChainConfigFor('co', env(false))?.contractId).toBe('C-CO-INSTANCE');
    const half = { ...env(false), PAYMENT_PLAN_CONTRACT_ID_SV: 'C-SV-INSTANCE' };
    expect(() => optionalChainConfigFor('sv', half)).toThrow(/PAYEE_BACKEND_SV_PUBLIC/);
  });

  it('chain plan ids from the environment cover both corridors and skip malformed values', () => {
    expect(chainPlansFromEnv(env(true))).toEqual({ [PLAN_MARIA]: 11, [PLAN_ROXANA]: 21 });
  });

  it('every chain call for a plan reaches the instance of its corridor and never the other one', async () => {
    const bridges: Record<CorridorId, InstanceBridge> = { co: new InstanceBridge('C-CO-INSTANCE'), sv: new InstanceBridge('C-SV-INSTANCE') };
    const t = { ms: T0 };
    const chainPlans = { [PLAN_MARIA]: 11, [PLAN_ANDRES]: 12, [PLAN_ROXANA]: 21, [PLAN_MARVIN]: 22 };
    const { api, store } = createTestnetStack({ chains: bridges, chainPlans, minDelayMs: 0, maxDelayMs: 0, now: () => t.ms });
    const ownIds: Record<CorridorId, Set<number>> = { co: new Set([11, 12]), sv: new Set([21, 22]) };

    // El Salvador: counter payment (deposit), then release_spot on the due date
    await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 75_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    await api.pay(PLAN_MARVIN, 3);
    // Colombia: a locked installment paid through the full pay flow
    await api.advanceClock(1);
    await api.pay(PLAN_MARIA, 3);

    for (const id of ['co', 'sv'] as const) {
      expect(bridges[id].calls.length, id).toBeGreaterThan(0);
      for (const c of bridges[id].calls) expect(ownIds[id].has(c.chainPlanId), `${id} ${c.fn} #${c.chainPlanId}`).toBe(true);
    }
    expect(bridges.sv.calls.some((c) => c.fn === 'applyLock' || c.fn === 'releaseDue')).toBe(false);
    expect(bridges.co.calls.map((c) => c.fn)).toEqual(expect.arrayContaining(['deposit', 'releaseDue']));
    expect(bridges.sv.calls.map((c) => c.fn)).toEqual(expect.arrayContaining(['deposit', 'releaseSpot']));

    // the demo state records which instance each corridor's ids belong to
    const state = await api.getDemoState();
    expect(state.chainContractIds).toEqual({ co: 'C-CO-INSTANCE', sv: 'C-SV-INSTANCE' });
    const plans = await store.all('plans');
    for (const [planId, chainId] of Object.entries(state.chainPlans ?? {})) {
      expect(ownIds[corridorIdOf(plans.find((p) => p.id === planId))].has(chainId), planId).toBe(true);
    }
  });
});
