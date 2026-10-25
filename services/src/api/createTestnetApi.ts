// Factory for DEMO_MODE=testnet: the same MemoryStore and mock hedge (Davivienda NDF) as the mock
// stack, plus one ChainBridge per corridor so deposits, locks, releases and breaks are real
// `payment_plan` transactions on Stellar testnet. The on-ramp and off-ramp default to the mocks;
// the server passes the SEP-24 and SEP-31 providers through `rails`. `createTestnetStack` also
// hands back the store, the bridges and the runtime, which the server's indexers and jobs read.
//
// Instances. Colombia runs on the original contract (`chain`); El Salvador on a second instance of
// the same Wasm with its own payee (`chains.sv`). DemoApi picks the bridge of a plan's corridor
// with `chainFor(plan)`; a corridor without a bridge keeps its plans off chain. The chain plan ids
// of both instances share the `chainPlans` map of demo_state (demo plan ids are unique across
// corridors), and `chainContractIds` records which instance each corridor's ids belong to.

import { MemoryStore, type Persistence } from '../store/MemoryStore';
import { MockRuntime, type MockRuntimeOptions } from '../adapters/mockRuntime';
import { MockHedgeProvider } from '../adapters/mockHedge';
import { MockOnRampProvider } from '../adapters/mockOnRamp';
import { MockOffRampProvider } from '../adapters/mockOffRamp';
import { InternalLockProvider } from '../adapters/mockLock';
import { BASE_DATE, SEED_VERSION, buildSeed } from '../seed/fixtures';
import type { Snapshot } from '../domain/types';
import { CORRIDOR_IDS, type CorridorId } from '../corridors/index';
import { ChainClient, type ChainClientConfig } from '../chain/client';
import { TestnetBridge, type ChainBridge } from '../chain/bridge';
import { ChainLockProvider } from '../chain/ChainLockProvider';
import type { OffRampProvider, OnRampProvider } from '../adapters/interfaces';
import type { Store } from '../store/Store';
import { ApiError, DemoApi } from './DemoApi';
import { createMockApi, type CreateMockApiOptions } from './createMockApi';

export type ChainSource = ChainBridge | ChainClientConfig;

export interface CreateTestnetApiOptions extends MockRuntimeOptions {
  persistence?: Persistence;
  now?: () => number;
  /** The Colombia instance: a ready bridge (tests pass a fake) or the configuration to build one over ChainClient. Same as `chains.co`. */
  chain?: ChainSource;
  /** One instance per corridor; a corridor left out (and not given as `chain`) stays off chain. */
  chains?: Partial<Record<CorridorId, ChainSource>>;
  /** Chain plan ids seeded by the deploy scripts, so the page is usable before the first reset. */
  chainPlans?: Record<string, number>;
  /** Operator log, passed to DemoApi (reset reports plans the network refused to create). */
  log?: (msg: string) => void;
  /** Real on-ramp and off-ramp providers; each one left out stays the mock. */
  rails?: (runtime: MockRuntime) => { onRamp?: OnRampProvider; offRamp?: OffRampProvider };
}

export interface TestnetStack {
  api: DemoApi;
  store: Store;
  /** The Colombia bridge (kept for the callers that predate corridors). */
  bridge: ChainBridge;
  /** Every corridor's bridge. */
  bridges: Partial<Record<CorridorId, ChainBridge>>;
  runtime: MockRuntime;
}

function isBridge(x: ChainSource): x is ChainBridge {
  return typeof (x as ChainBridge).seedPlan === 'function';
}

/** Builds the bridges of `opts`; the Colombia one is required. */
export function bridgesFromOptions(opts: Pick<CreateTestnetApiOptions, 'chain' | 'chains' | 'now'>): Partial<Record<CorridorId, ChainBridge>> {
  const sources: Partial<Record<CorridorId, ChainSource>> = { ...(opts.chain ? { co: opts.chain } : {}), ...(opts.chains ?? {}) };
  const bridges: Partial<Record<CorridorId, ChainBridge>> = {};
  for (const id of CORRIDOR_IDS) {
    const src = sources[id];
    if (src) bridges[id] = isBridge(src) ? src : new TestnetBridge(new ChainClient(src), opts.now);
  }
  if (!bridges.co) throw new Error('createTestnetStack: the Colombia instance (`chain` or `chains.co`) is required');
  return bridges;
}

export function contractIdsOf(bridges: Partial<Record<CorridorId, ChainBridge>>): Partial<Record<CorridorId, string>> {
  return Object.fromEntries(Object.entries(bridges).map(([id, b]) => [id, b.contractId]));
}

export function createTestnetApi(opts: CreateTestnetApiOptions): DemoApi {
  return createTestnetStack(opts).api;
}

export function createTestnetStack(opts: CreateTestnetApiOptions): TestnetStack {
  const bridges = bridgesFromOptions(opts);
  const bridge = bridges.co!;
  const contractIds = contractIdsOf(bridges);
  const persisted = opts.persistence?.load() ?? null;
  const persistedState = persisted?.demo_state?.[0];
  // A persisted snapshot is only reused when it was written against these contracts: plan ids of
  // an older deployment would make every chain call fail with PlanNotFound. A snapshot written
  // before the second instance existed names only the Colombia contract and is reused as long as
  // no other instance's id differs.
  const sameInstances =
    persistedState?.chainContractId === bridge.contractId &&
    Object.entries(persistedState.chainContractIds ?? {}).every(([id, cid]) => contractIds[id as CorridorId] === cid);
  const reusable = persistedState?.seedVersion === SEED_VERSION && sameInstances;
  let initial: Snapshot;
  if (reusable && persisted) {
    initial = persisted;
  } else {
    initial = buildSeed();
    const state = initial.demo_state[0]!;
    initial.demo_state[0] = { ...state, mode: 'testnet', chainContractId: bridge.contractId, chainContractIds: contractIds, chainPlans: opts.chainPlans ?? {} };
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
    // Locks exist in Colombia only, so the lock provider is wired to that instance.
    lock: new ChainLockProvider(new InternalLockProvider(runtime, hedge, opts.now), bridge, resolve, opts.now),
  };
  const api = new DemoApi({ store, providers, runtime, now: opts.now, chain: bridge, chains: bridges, log: opts.log });
  return { api, store, bridge, bridges, runtime };
}

export type DemoMode = 'mock' | 'testnet';

export type CreateApiOptions = { mode: 'mock' } & CreateMockApiOptions | ({ mode: 'testnet' } & CreateTestnetApiOptions);

/** Picks the stack for a demo mode; the UI never changes between the two. */
export function createApi(opts: CreateApiOptions): DemoApi {
  if (opts.mode === 'testnet') return createTestnetApi(opts);
  return createMockApi(opts);
}
