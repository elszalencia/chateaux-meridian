// The testnet backend in one object: the DemoApi stack over one chain bridge per corridor with the
// real rails (SEP-24 on-ramp, SEP-31 off-ramp), one event indexer per contract instance, receipts
// built from indexed events, the job registry with the TTL keeper and the adverse-events run, and
// the step-1 check of the seeded plans at startup.
//
// Instances. Colombia runs on the original payment_plan contract, El Salvador on a second instance
// of the same Wasm with its own payee (config/corridors.ts `chainEnv`). A plan is routed to its
// corridor's instance everywhere here through `corridorOf(plan)`: `clientFor(planId)` for reads,
// TTL extensions and adverse calls, `contractIdFor(planId)` for receipts. The `chainPlans` map of
// demo_state stays keyed by demo plan id (unique across corridors); which instance an id belongs
// to follows from the plan's corridor, and `chainContractIds` records the instances themselves.
//
// Receipts: DemoApi still computes and stores the off-chain half of every payment, but what the API
// returns as a receipt comes from IndexedReceipts, keyed by (contract, chain plan, installment), so
// both instances' releases live in one receipt store. `pay` and `payAhead` answer once the indexer
// of the plan's instance has seen the release transaction (or after RECEIPT_WAIT_MS, with the
// receipt marked as pending), and `getReceipts` lists only indexed receipts.

import path from 'node:path';
import { rpc } from '@stellar/stellar-sdk';
import {
  CORRIDOR_IDS,
  ChainClient,
  DEFAULT_CORRIDOR,
  TestnetBridge,
  checkChainPlans,
  corridorIdOf,
  createTestnetStack,
  deployedWasmHash,
  type ChateauxApi,
  type ChainBridge,
  type CorridorId,
  type DemoState,
  type PayStep,
  type PristineCheck,
  type Receipt,
  type TestnetStack,
} from '../../src/index';
import { Sep24OnRampProvider } from '../../src/adapters/sep24OnRamp';
import { Sep31OffRampProvider } from '../../src/adapters/sep31OffRamp';
import { JournaledOffRamp, JournaledOnRamp } from '../../src/adapters/railsJournal';
import { EventIndexer } from '../../src/indexer/indexer';
import { IndexedReceipts } from '../../src/indexer/receipts';
import { JobRegistry, registerDefaultJobs, planLiveUntil, type JobFn } from '../../src/jobs/index';
import { ChainGovernanceProvider } from '../../src/chain/governance';
import { MockGovernanceProvider, NullPolicy, runAdverseEventsDaily, type GovernanceProvider } from '../../src/policy/index';
import type { ServerConfig } from './config';
import { FilePersistence } from './filePersistence';

/** Sender of record for SEP-31 payouts: the platform remits on behalf of the buyer. */
const SEP31_SENDER = { first_name: 'Chateaux', last_name: 'S.A.S.', email_address: 'operaciones@chateaux.example' };

export interface ServiceOptions {
  log?: (msg: string) => void;
  /** Replaces the default `adverse-events-daily` job (NullPolicy over the chain governance providers). */
  adverseEventsDaily?: JobFn;
}

export interface InstanceInfo {
  corridor: CorridorId;
  contractId: string;
  /** Hash of the Wasm the instance runs, read from its ledger entry at startup; null until read. */
  wasmHash: string | null;
  payeeBackend: string;
}

/** Data directory of a corridor's indexer: `.data/indexer` for the default corridor (Colombia, unchanged), `.data/indexer-<id>` otherwise. */
export function indexerDirFor(dataDir: string, corridor: CorridorId): string {
  return path.join(dataDir, '..', corridor === DEFAULT_CORRIDOR ? 'indexer' : `indexer-${corridor}`);
}

export class TestnetService {
  readonly stack: TestnetStack;
  /** The Colombia client (same as `clients.co`). */
  readonly client: ChainClient;
  readonly clients: Partial<Record<CorridorId, ChainClient>>;
  /** The Colombia indexer (same as `indexers.co`), kept for the `/indexer` endpoint. */
  readonly indexer: EventIndexer;
  readonly indexers: Partial<Record<CorridorId, EventIndexer>>;
  readonly receipts: IndexedReceipts;
  readonly jobs: JobRegistry;
  readonly persistence: FilePersistence;
  readonly onRamp: JournaledOnRamp | null = null;
  readonly offRamp: JournaledOffRamp | null = null;
  readonly startedAt = new Date().toISOString();
  readonly instances: Partial<Record<CorridorId, InstanceInfo>> = {};
  pristine: PristineCheck[] = [];
  /** Set by the startup check when a seeded plan was already used; cleared by a reset. */
  needsReset = false;
  private readonly log: (msg: string) => void;

  constructor(
    readonly cfg: ServerConfig,
    opts: ServiceOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.clients = {};
    const bridges: Partial<Record<CorridorId, ChainBridge>> = {};
    for (const id of CORRIDOR_IDS) {
      const c = cfg.chains[id];
      if (!c) continue;
      const client = new ChainClient(c);
      this.clients[id] = client;
      bridges[id] = new TestnetBridge(client);
      this.instances[id] = { corridor: id, contractId: c.contractId, wasmHash: null, payeeBackend: c.payeeBackendPublic };
    }
    const co = this.clients[DEFAULT_CORRIDOR];
    if (!co) throw new Error('the Colombia instance is required');
    this.client = co;
    this.persistence = new FilePersistence(cfg.dataDir);
    let onRamp: JournaledOnRamp | null = null;
    let offRamp: JournaledOffRamp | null = null;
    this.stack = createTestnetStack({
      chains: bridges,
      chainPlans: cfg.chainPlans,
      persistence: this.persistence,
      log: (m) => this.log(m),
      rails: (runtime) => {
        if (cfg.onRamp === 'sep24') {
          onRamp = new JournaledOnRamp(
            new Sep24OnRampProvider({
              homeDomain: cfg.onRampHomeDomain,
              buyerSecret: (buyerId) => {
                const s = cfg.buyerSecrets[buyerId];
                if (!s) throw new Error(`no testnet account for ${buyerId}`);
                return s;
              },
              log: (m) => this.log(`[on-ramp] ${m}`),
            }),
          );
        }
        if (cfg.offRamp === 'sep31') {
          offRamp = new JournaledOffRamp(
            new Sep31OffRampProvider({
              homeUrl: cfg.offRampHomeUrl,
              senderSecret: cfg.payeeBackendSecret,
              usdc: { code: 'USDC', issuer: cfg.usdcIssuer },
              networkPassphrase: cfg.networkPassphrase,
              horizonUrl: cfg.horizonUrl,
              sender: SEP31_SENDER,
              clockOffset: () => runtime.clockOffset(),
              log: (m) => this.log(`[off-ramp] ${m}`),
            }),
          );
        }
        return { onRamp: onRamp ?? undefined, offRamp: offRamp ?? undefined };
      },
    });
    this.onRamp = onRamp;
    this.offRamp = offRamp;

    const server = this.client.submitter.server;
    this.indexers = {};
    for (const [id, client] of Object.entries(this.clients) as [CorridorId, ChainClient][]) {
      this.indexers[id] = new EventIndexer({
        contractId: client.contractId,
        dataDir: indexerDirFor(cfg.dataDir, id),
        getEvents: (req) => server.getEvents(req),
        oldestLedger: async () => (await server.getHealth()).oldestLedger ?? 0,
        // Each instance starts at its own deploy ledger (0 = as far back as the RPC retains events).
        startLedger: cfg.indexerStartLedgers[id] ?? 0,
        pollIntervalMs: cfg.indexerPollMs,
        log: (m) => this.log(id === DEFAULT_CORRIDOR ? m : `[${id}] ${m}`),
      });
    }
    this.indexer = this.indexers[DEFAULT_CORRIDOR]!;
    this.receipts = new IndexedReceipts(indexerDirFor(cfg.dataDir, DEFAULT_CORRIDOR));
    for (const ix of Object.values(this.indexers)) ix.onEvents(() => void this.joinReceipts());

    this.jobs = registerDefaultJobs(new JobRegistry(this.log), {
      ttlKeeper: {
        chainPlans: () => this.chainPlansOnChain(),
        latestLedger: async () => (await server.getLatestLedger()).sequence,
        liveUntil: async (id, planId) => {
          const client = await this.clientFor(planId);
          return client ? planLiveUntil(client.submitter.server as rpc.Server, client.contractId, id) : null;
        },
        getStatus: async (id, planId) => (await this.requireClient(planId)).getStatus(id),
        extendTtl: async (id, planId) => (await this.requireClient(planId)).extendTtl(id),
      },
      adverseEventsDaily: opts.adverseEventsDaily ?? this.adverseEventsJob(),
    });
  }

  // ---------- instances ----------

  /** The chain client of a plan's corridor, or null when that corridor has no instance (plan off chain). */
  async clientFor(planId: string): Promise<ChainClient | null> {
    const plan = await this.stack.store.get('plans', planId);
    return this.clients[corridorIdOf(plan)] ?? null;
  }

  private async requireClient(planId: string): Promise<ChainClient> {
    const client = await this.clientFor(planId);
    if (!client) throw new Error(`${planId}: its corridor has no contract instance configured`);
    return client;
  }

  async contractIdFor(planId: string): Promise<string | null> {
    return (await this.clientFor(planId))?.contractId ?? null;
  }

  /** `chainPlans` of demo_state restricted to the plans whose corridor has an instance here. */
  private async chainPlansOnChain(corridor?: CorridorId): Promise<Record<string, number>> {
    const state = await this.stack.api.getDemoState();
    const plans = await this.stack.store.all('plans');
    const out: Record<string, number> = {};
    for (const [planId, chainId] of Object.entries(state.chainPlans ?? {})) {
      const id = corridorIdOf(plans.find((p) => p.id === planId));
      if (!this.clients[id]) continue;
      if (corridor && id !== corridor) continue;
      out[planId] = chainId;
    }
    return out;
  }

  /** Reads the Wasm hash each instance runs (for /health and the startup log). */
  async readInstances(): Promise<InstanceInfo[]> {
    for (const info of Object.values(this.instances)) {
      info.wasmHash = await deployedWasmHash(this.client.submitter, info.contractId);
    }
    return Object.values(this.instances);
  }

  /**
   * The daily adverse-events run of the policy layer: NullPolicy decides, one ChainGovernanceProvider
   * per instance executes on chain for the plans that live there (each provider falls through to
   * the next; the off-chain adverse demo plans end at the mock provider), and the run's own
   * funds-conservation check becomes a warning when it fails.
   */
  private adverseEventsJob(): JobFn {
    return async () => {
      const store = this.stack.store;
      const today = (await this.stack.api.getDemoState()).today;
      let provider: GovernanceProvider = new MockGovernanceProvider({ store, today: () => today });
      for (const [id, client] of Object.entries(this.clients) as [CorridorId, ChainClient][]) {
        provider = new ChainGovernanceProvider({ client, chainPlans: () => this.chainPlansOnChain(id), fallback: provider });
      }
      const r = await runAdverseEventsDaily({ store, policy: new NullPolicy(), provider, today });
      const warnings = [
        ...r.failed.map((e) => `${e.planId}: ${e.detail ?? e.kind}`),
        ...(r.conservation.ok ? [] : [`funds not conserved: ${r.conservation.beforeCents} → ${r.conservation.afterCents} cents`]),
      ];
      return {
        summary: `${today}: ${r.plansChecked} plan(s) checked, ${r.plansSkipped} skipped, ${r.executed.length} executed, ${r.recorded.length} recorded, ${r.failed.length} failed`,
        warnings,
        details: r,
      };
    };
  }

  get api(): ChateauxApi {
    return this.stack.api;
  }

  /** The Colombia contract id. */
  get contractId(): string {
    return this.cfg.chain.contractId;
  }

  async start(): Promise<void> {
    await this.readInstances();
    await this.checkPlans();
    for (const ix of Object.values(this.indexers)) ix.start();
    this.jobs.start();
  }

  stop(): void {
    for (const ix of Object.values(this.indexers)) ix.stop();
    this.jobs.stop();
    this.persistence.flush();
  }

  /** Compares every mapped chain plan with the seed (each on its own instance); any used plan sets `needsReset`. */
  async checkPlans(): Promise<PristineCheck[]> {
    const chainPlans = await this.chainPlansOnChain();
    this.pristine = await checkChainPlans(chainPlans, async (id, planId) => (await this.requireClient(planId)).getStatus(id));
    this.needsReset = this.pristine.length === 0 || this.pristine.some((p) => !p.pristine);
    for (const p of this.pristine) this.log(`startup check: ${p.planId} #${p.chainPlanId} ${p.pristine ? 'in the step-1 state' : `NOT pristine (${p.reason})`}`);
    if (this.needsReset) this.log('startup check: the seeded plans were used by an earlier run; click "Reiniciar demo" (or POST /api/reset) before presenting');
    return this.pristine;
  }

  // ---------- receipts from the indexers ----------

  private async chainMaps(): Promise<{ state: DemoState; byChain: Map<string, Map<number, string>> }> {
    const state = await this.stack.api.getDemoState();
    const plans = await this.stack.store.all('plans');
    // chain plan id → demo plan id, per contract instance (ids are random per instance).
    const byChain = new Map<string, Map<number, string>>();
    for (const [planId, chainId] of Object.entries(state.chainPlans ?? {})) {
      const client = this.clients[corridorIdOf(plans.find((p) => p.id === planId))];
      if (!client) continue;
      let m = byChain.get(client.contractId);
      if (!m) byChain.set(client.contractId, (m = new Map()));
      m.set(chainId, planId);
    }
    return { state, byChain };
  }

  /** Writes a receipt for every indexed release of a current plan (either instance) whose settlement is recorded. */
  async joinReceipts(): Promise<number> {
    const { byChain } = await this.chainMaps();
    const settlements = await this.stack.store.all('receipts');
    const plans = await this.stack.store.all('plans');
    let written = 0;
    for (const ix of Object.values(this.indexers)) {
      const ids = byChain.get(ix.stats().contractId) ?? new Map<number, string>();
      written += this.receipts.join(
        ix.events.all(),
        new Set(ids.keys()),
        (chainId, idx) => {
          const planId = ids.get(chainId);
          return settlements.find((r) => r.planId === planId && r.installmentIdx === idx);
        },
        (chainId, idx) => {
          const plan = plans.find((p) => p.id === ids.get(chainId));
          return plan ? this.offRamp?.latest(plan.encargoRef, `M${idx + 1}`)?.txId : undefined;
        },
      ).length;
    }
    return written;
  }

  async getReceipts(planId: string): Promise<Receipt[]> {
    await this.joinReceipts();
    const { state } = await this.chainMaps();
    const chainId = state.chainPlans?.[planId];
    const contractId = await this.contractIdFor(planId);
    return chainId == null || !contractId ? [] : this.receipts.forPlan(contractId, chainId);
  }

  /** Waits until the plan's indexer holds the release transaction of `receipt`, then returns the indexed receipt. */
  private async indexed(planId: string, receipt: Receipt): Promise<Receipt> {
    const { state } = await this.chainMaps();
    const chainId = state.chainPlans?.[planId];
    const plan = await this.stack.store.get('plans', planId);
    const corridor = corridorIdOf(plan);
    const indexer = this.indexers[corridor];
    const contractId = this.clients[corridor]?.contractId;
    if (chainId == null || !indexer || !contractId) return receipt;
    const deadline = Date.now() + this.cfg.receiptWaitMs;
    for (;;) {
      await indexer.pollOnce();
      await this.joinReceipts();
      const r = this.receipts.find(contractId, chainId, receipt.installmentIdx);
      if (r && r.txHash === receipt.txHash) return { ...r, id: r.receiptId };
      if (Date.now() >= deadline) {
        this.log(`receipt ${receipt.id}: release ${receipt.txHash} not indexed after ${this.cfg.receiptWaitMs} ms; answering with the pending settlement`);
        return { ...receipt, indexed: false } as Receipt;
      }
      await new Promise((r2) => setTimeout(r2, 1_500));
    }
  }

  async pay(planId: string, idx: number, onProgress?: (s: PayStep) => void): Promise<Receipt> {
    const r = await this.stack.api.pay(planId, idx, onProgress);
    return this.indexed(planId, r);
  }

  async payAhead(planId: string, onProgress?: (s: PayStep) => void): Promise<Receipt[]> {
    const rs = await this.stack.api.payAhead(planId, onProgress);
    const out: Receipt[] = [];
    for (const r of rs) out.push(await this.indexed(planId, r));
    return out;
  }

  /**
   * Re-seeds the demo. DemoApi.reset seeds every plan through the bridge of its own corridor and
   * records, in demo_state, the plans the network refused to create (kept on their existing chain
   * plan, or run off chain as "simulado"). A kept chain plan is read back here, so /health shows
   * whether it still matches the seed.
   */
  async reset(): Promise<{ state: DemoState; elapsedMs: number }> {
    const before = (await this.stack.store.get('demo_state', 'singleton'))?.chainPlans ?? {};
    const { state, elapsedMs } = await this.stack.api.reset();
    const mapped = state.chainPlans ?? {};
    const kept = Object.fromEntries(Object.entries(mapped).filter(([planId, id]) => before[planId] === id));
    const checked = await checkChainPlans(kept, async (id, planId) => (await this.requireClient(planId)).getStatus(id));
    this.pristine = Object.entries(mapped).map(([planId, chainPlanId]) => checked.find((c) => c.planId === planId) ?? { planId, chainPlanId, pristine: true, reason: '' });
    // A reset cannot do more than this: a kept plan that no longer matches the seed is reported, not re-seeded.
    this.needsReset = false;
    for (const c of checked) this.log(`reset: ${c.planId} kept on chain as #${c.chainPlanId}, ${c.pristine ? 'in the step-1 state' : `NOT in the seed state (${c.reason})`}`);
    for (const [planId, why] of Object.entries(state.simulatedPlans ?? {})) this.log(`reset: ${planId} runs off chain (${why})`);
    this.log(`reset: done in ${(elapsedMs / 1000).toFixed(1)} s → ${JSON.stringify(mapped)}`);
    return { state, elapsedMs };
  }

  health(): Record<string, unknown> {
    return {
      status: 'ok',
      mode: 'testnet',
      contractId: this.contractId,
      contracts: Object.fromEntries(Object.values(this.instances).map((i) => [i.corridor, { contractId: i.contractId, wasmHash: i.wasmHash, payeeBackend: i.payeeBackend }])),
      offChainCorridors: CORRIDOR_IDS.filter((id) => !this.clients[id]),
      startedAt: this.startedAt,
      needsReset: this.needsReset,
      plans: this.pristine,
      indexer: this.indexer.stats(),
      indexers: Object.fromEntries(Object.entries(this.indexers).map(([id, ix]) => [id, ix.stats()])),
      receipts: this.receipts.store.size,
      jobs: this.jobs.status().map((j) => ({ name: j.name, schedule: j.schedule, running: j.running, lastRun: j.lastRun && { at: j.lastRun.startedAt, ok: j.lastRun.ok, summary: j.lastRun.summary, warnings: j.lastRun.warnings } })),
      rails: {
        onRamp: this.onRamp?.name ?? 'mock',
        offRamp: this.offRamp?.name ?? 'mock',
        offRampHomeUrl: this.offRamp ? this.cfg.offRampHomeUrl : null,
      },
    };
  }
}
