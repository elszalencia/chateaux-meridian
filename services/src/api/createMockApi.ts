// Factory wiring the mock stack: MemoryStore (seeded, optionally persisted) + the four mock
// providers + DemoApi. `DEMO_MODE=testnet` will get a sibling factory in Stage 3.

import { MemoryStore, type Persistence } from '../store/MemoryStore';
import { MockRuntime, type MockRuntimeOptions } from '../adapters/mockRuntime';
import { MockHedgeProvider } from '../adapters/mockHedge';
import { MockOnRampProvider } from '../adapters/mockOnRamp';
import { MockOffRampProvider } from '../adapters/mockOffRamp';
import { InternalLockProvider } from '../adapters/mockLock';
import { BASE_DATE, SEED_VERSION, buildSeed } from '../seed/fixtures';
import { DemoApi } from './DemoApi';

export interface CreateMockApiOptions extends MockRuntimeOptions {
  persistence?: Persistence;
  now?: () => number;
}

export function createMockApi(opts: CreateMockApiOptions = {}): DemoApi {
  const persisted = opts.persistence?.load() ?? null;
  const seedIsCurrent = persisted?.demo_state?.[0]?.seedVersion === SEED_VERSION;
  const store = new MemoryStore(seedIsCurrent && persisted ? persisted : buildSeed(), opts.persistence);
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
  const providers = {
    hedge,
    onRamp: new MockOnRampProvider(runtime),
    offRamp: new MockOffRampProvider(runtime),
    lock: new InternalLockProvider(runtime, hedge, opts.now),
  };
  return new DemoApi({ store, providers, runtime, now: opts.now });
}
