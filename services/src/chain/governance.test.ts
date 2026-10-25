import { describe, expect, it } from 'vitest';
import type { ChainClient } from './client';
import { ChainError } from './submit';
import { ChainGovernanceProvider, centsToStroops, evidenceBytes } from './governance';
import { GovernanceProviderError, type GovernanceProvider } from '../policy/GovernanceProvider';

const EVIDENCE = 'ab'.repeat(32);

function fakeClient(fail?: string) {
  const calls: unknown[][] = [];
  const tx = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    if (fail) throw new ChainError(`simulation failed: ${fail}`, { errorName: fail });
    return { txHash: `hash-${name}`, ledger: 1, result: undefined };
  };
  const client = {
    markMissed: tx('mark_missed'),
    cure: tx('cure'),
    waive: tx('waive'),
    declareDefault: tx('declare_default'),
    placeHold: tx('place_hold'),
    liftHold: tx('lift_hold'),
    holdFrozen: tx('hold_frozen'),
    cancelPlan: tx('cancel_plan'),
    refund: tx('refund'),
    completePlan: tx('complete_plan'),
  } as unknown as ChainClient;
  return { client, calls };
}

const fallback = new Proxy({} as GovernanceProvider, {
  get: (_t, prop) => (prop === 'name' ? 'fallback' : async () => ({ ref: `mock-${String(prop)}` })),
});

describe('ChainGovernanceProvider', () => {
  it('maps the app plan id to the chain plan and passes the evidence as 32 bytes', async () => {
    const { client, calls } = fakeClient();
    const p = new ChainGovernanceProvider({ client, chainPlans: async () => ({ 'plan-maria': 42 }), fallback });
    expect(await p.markMissed({ planId: 'plan-maria', idx: 3, reasonCode: 1, evidence: EVIDENCE })).toEqual({ ref: 'hash-mark_missed' });
    expect(calls[0]!.slice(0, 4)).toEqual(['mark_missed', 42, 3, 1]);
    expect(calls[0]![4]).toEqual(evidenceBytes(EVIDENCE));
    expect((calls[0]![4] as Uint8Array).length).toBe(32);
  });

  it('sends refunds in stroops and calls hold_frozen without a reason', async () => {
    const { client, calls } = fakeClient();
    const p = new ChainGovernanceProvider({ client, chainPlans: async () => ({ 'plan-x': 7 }), fallback });
    await p.refund({ planId: 'plan-x', amountCents: 118_833, reasonCode: 8, evidence: EVIDENCE });
    await p.holdFrozen({ planId: 'plan-x', evidence: EVIDENCE });
    expect(calls[0]!.slice(0, 4)).toEqual(['refund', 7, 11_883_300_000n, 8]);
    expect(calls[1]!.slice(0, 2)).toEqual(['hold_frozen', 7]);
    expect(centsToStroops(1)).toBe(100_000n);
  });

  it('routes plans that are not on chain to the fallback provider', async () => {
    const { client, calls } = fakeClient();
    const p = new ChainGovernanceProvider({ client, chainPlans: async () => ({}), fallback });
    expect(await p.placeHold({ planId: 'plan-paola', reasonCode: 5, evidence: EVIDENCE })).toEqual({ ref: 'mock-placeHold' });
    expect(calls).toHaveLength(0);
  });

  it('turns a contract error into a GovernanceProviderError with the same name', async () => {
    const { client } = fakeClient('AssetFrozen');
    const p = new ChainGovernanceProvider({ client, chainPlans: async () => ({ 'plan-maria': 42 }), fallback });
    const err = await p.liftHold({ planId: 'plan-maria', reasonCode: 6, evidence: EVIDENCE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceProviderError);
    expect((err as GovernanceProviderError).errorName).toBe('AssetFrozen');
  });

  it('rejects evidence that is not a SHA-256 hex digest', () => {
    expect(() => evidenceBytes('xyz')).toThrow(GovernanceProviderError);
  });
});
