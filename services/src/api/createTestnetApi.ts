// Factory for DEMO_MODE=testnet: the same MemoryStore and mock hedge (Davivienda NDF) as the mock
// stack, plus a ChainBridge so deposits, locks, releases and breaks are real `payment_plan`
// transactions on Stellar testnet. The on-ramp and off-ramp default to the mocks; the server passes
// the SEP-24 and SEP-31 providers through `rails`. `createTestnetStack` also hands back the store
// and runtime, which the server's indexer and jobs read.

import { MemoryStore, type Persistence } from '../store/MemoryStore';
import { MockRuntime, type MockRuntimeOptions } from '../adapters/mockRuntime';
import { MockHedgeProvider } from '../adapters/mockHedge';
import { MockOnRampProvider } from '../adapters/mockOnRamp';
import { MockOffRampProvider } from '../adapters/mockOffRamp';
import { InternalLockProvider } from '../adapters/mockLock';
import { BASE_DATE, SEED_VERSION, buildSeed } from '../seed/fixtures';
import type { Snapshot } from '../domain/types';
import { ChainClient, type ChainClientConfig } from '../chain/client';
import { TestnetBridge, type ChainBridge } from '../chain/bridge';
import { ChainLockProvider } from '../chain/ChainLockProvider';
import type { OffRampProvider, OnRampProvider } from '../adapters/interfaces';
import type { Store } from '../store/Store';
import { ApiError, DemoApi } from './DemoApi';
import { createMockApi, type CreateMockApiOptions } from './createMockApi';

export interface CreateTestnetApiOptions extends MockRuntimeOptions {
  persistence?: Persistence;
  now?: () => number;
  /** Either a ready bridge (tests pass a fake) or the configuration to build one over ChainClient. */
  chain: ChainBridge | ChainClientConfig;
  /** Chain plan ids seeded by the deploy script, so the page is usable before the first reset. */
  chainPlans?: Record<string, number>;
  /** Real on-ramp and off-ramp providers; each one left out stays the mock. */
  rails?: (runtime: MockRuntime) => { onRamp?: OnRampProvider; offRamp?: OffRampProvider };
}

export interface TestnetStack {
  api: DemoApi;
  store: Store;
  bridge: ChainBridge;
  runtime: MockRuntime;
}

function isBridge(x: ChainBridge | ChainClientConfig): x is ChainBridge {
  return typeof (x as ChainBridge).seedPlan === 'function';
}

export function createTestnetApi(opts: CreateTestnetApiOptions): DemoApi {
  return createTestnetStack(opts).api;
}

export function createTestnetStack(opts: CreateTestnetApiOptions): TestnetStack {
  const bridge: ChainBridge = isBridge(opts.chain) ? opts.chain : new TestnetBridge(new ChainClient(opts.chain), opts.now);
  const persisted = opts.persistence?.load() ?? null;
  const persistedState = persisted?.demo_state?.[0];
  // A persisted snapshot is only reused when it was written against this contract: plan ids of an
  // older deployment would make every chain call fail with PlanNotFound.
  const reusable = persistedState?.seedVersion === SEED_VERSION && persistedState.chainContractId === bridge.contractId;
  let initial: Snapshot;
  if (reusable && persisted) {
    initial = persisted;
  } else {
    initial = buildSeed();
    const state = initial.demo_state[0]!;
    initial.demo_state[0] = { ...state, mode: 'testnet', chainContractId: bridge.contractId, chainPlans: opts.chainPlans ?? {} };
  }
  const store = new MemoryStore(initial, opts.persistence);
  const runtime = new MockRuntime(opts);
  let seq = 600;
  const hedge = new MockHedgeProvider({
    runtime,
    baseDate: BASE_DATE,
    tradeSource: () => store.all('hedge_trades'),
    nextSeq: () => {
      seq += 1;
      return seq;
    },
  });
  const resolve = async (planId: string) => {
    const state = await store.get('demo_state', 'singleton');
    const chainPlanId = state?.chainPlans?.[planId];
    const plan = await store.get('plans', planId);
    if (chainPlanId == null || !plan) throw new ApiError('PROVIDER', `plan ${planId} is not seeded on chain; run "Reiniciar demo"`);
    return { chainPlanId, buyerId: plan.buyerId };
  };
  const rails = opts.rails?.(runtime) ?? {};
  const providers = {
    hedge,
    onRamp: rails.onRamp ?? new MockOnRampProvider(runtime),
    offRamp: rails.offRamp ?? new MockOffRampProvider(runtime),
    lock: new ChainLockProvider(new InternalLockProvider(runtime, hedge, opts.now), bridge, resolve, opts.now),
  };
  const api = new DemoApi({ store, providers, runtime, now: opts.now, chain: bridge });
  return { api, store, bridge, runtime };
}

export type DemoMode = 'mock' | 'testnet';

export type CreateApiOptions = { mode: 'mock' } & CreateMockApiOptions | ({ mode: 'testnet' } & CreateTestnetApiOptions);

/** Picks the stack for a demo mode; the UI never changes between the two. */
export function createApi(opts: CreateApiOptions): DemoApi {
  if (opts.mode === 'testnet') return createTestnetApi(opts);
  return createMockApi(opts);
}
