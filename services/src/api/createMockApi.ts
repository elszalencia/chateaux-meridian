// Factory wiring the mock stack: MemoryStore (seeded, optionally persisted) + the mock providers
// (the four Colombia rails plus the cash-in network and the two seller payout rails) + DemoApi.
// `DEMO_MODE=testnet` has its sibling factory in createTestnetApi.ts.

import { MemoryStore, type Persistence } from '../store/MemoryStore';
import { MockRuntime, type MockRuntimeOptions } from '../adapters/mockRuntime';
import { MockHedgeProvider } from '../adapters/mockHedge';
import { MockOnRampProvider } from '../adapters/mockOnRamp';
import { MockOffRampProvider } from '../adapters/mockOffRamp';
import { InternalLockProvider } from '../adapters/mockLock';
import type { CashInProvider, SellerPayoutProvider } from '../adapters/interfaces';
import type { MessageChannel, TemplateRenderer } from '../channels/MessageChannel';
import { BASE_DATE, SEED_VERSION, buildSeed } from '../seed/fixtures';
import { DemoApi } from './DemoApi';

export interface CreateMockApiOptions extends MockRuntimeOptions {
  persistence?: Persistence;
  now?: () => number;
  /** Where WhatsApp messages go; default: the `wa_outbox` table. */
  messages?: MessageChannel;
  /** Template body renderer; the web app passes `dictionaryRenderer` over its dictionaries. */
  renderTemplate?: TemplateRenderer;
  /** Test seams for the corridor rails (default: the mocks built here). */
  cashIn?: CashInProvider;
  sellerPayouts?: Partial<Record<'A' | 'B', SellerPayoutProvider>>;
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
  // The corridor rails (MoneyGramOnRamp mock, UsdcHold, UsdBankPayout) are built by DemoApi itself
  // on its session clock unless a test passes its own through `cashIn` / `sellerPayouts`.
  const providers = {
    hedge,
    onRamp: new MockOnRampProvider(runtime),
    offRamp: new MockOffRampProvider(runtime),
    lock: new InternalLockProvider(runtime, hedge, opts.now),
    cashIn: opts.cashIn,
    sellerPayouts: opts.sellerPayouts,
  };
  return new DemoApi({ store, providers, runtime, now: opts.now, messages: opts.messages, renderTemplate: opts.renderTemplate });
}
