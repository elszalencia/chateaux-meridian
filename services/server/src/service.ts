// The testnet backend in one object: the DemoApi stack over the chain bridge with the real rails
// (SEP-24 on-ramp, SEP-31 off-ramp), the event indexer, receipts built from indexed events, the job
// registry with the TTL keeper, and the step-1 check of the seeded plans at startup.
//
// Receipts: DemoApi still computes and stores the off-chain half of every payment, but what the API
// returns as a receipt comes from IndexedReceipts. `pay` and `payAhead` answer once the indexer has
// seen the release transaction (or after RECEIPT_WAIT_MS, with the receipt marked as pending), and
// `getReceipts` lists only indexed receipts.

import path from 'node:path';
import { rpc } from '@stellar/stellar-sdk';
import {
  ChainClient,
  TestnetBridge,
  checkChainPlans,
  createTestnetStack,
  type CasaPuenteApi,
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
import { MockGovernanceProvider, NullPolicy, runAdverseEventsDaily } from '../../src/policy/index';
import type { ServerConfig } from './config';
import { FilePersistence } from './filePersistence';

/** Sender of record for SEP-31 payouts: Casa Puente remits on behalf of the buyer. */
const SEP31_SENDER = { first_name: 'Casa Puente', last_name: 'S.A.S.', email_address: 'operaciones@casapuente.example' };

export interface ServiceOptions {
  log?: (msg: string) => void;
  /** Replaces the default `adverse-events-daily` job (NullPolicy over the chain governance provider). */
  adverseEventsDaily?: JobFn;
}

export class TestnetService {
  readonly stack: TestnetStack;
  readonly client: ChainClient;
  readonly indexer: EventIndexer;
  readonly receipts: IndexedReceipts;
  readonly jobs: JobRegistry;
  readonly persistence: FilePersistence;
  readonly onRamp: JournaledOnRamp | null = null;
  readonly offRamp: JournaledOffRamp | null = null;
  readonly startedAt = new Date().toISOString();
  pristine: PristineCheck[] = [];
  /** Set by the startup check when a seeded plan was already used; cleared by a reset. */
  needsReset = false;
  private readonly log: (msg: string) => void;

  constructor(
    readonly cfg: ServerConfig,
    opts: ServiceOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.client = new ChainClient(cfg.chain);
    this.persistence = new FilePersistence(cfg.dataDir);
    let onRamp: JournaledOnRamp | null = null;
    let offRamp: JournaledOffRamp | null = null;
    this.stack = createTestnetStack({
      chain: new TestnetBridge(this.client),
      chainPlans: cfg.chainPlans,
      persistence: this.persistence,
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
    this.indexer = new EventIndexer({
      contractId: cfg.chain.contractId,
      dataDir: path.join(cfg.dataDir, '..', 'indexer'),
      getEvents: (req) => server.getEvents(req),
      oldestLedger: async () => (await server.getHealth()).oldestLedger ?? 0,
      startLedger: cfg.indexerStartLedger,
      pollIntervalMs: cfg.indexerPollMs,
      log: this.log,
    });
    this.receipts = new IndexedReceipts(path.join(cfg.dataDir, '..', 'indexer'));
    this.indexer.onEvents(() => void this.joinReceipts());

    this.jobs = registerDefaultJobs(new JobRegistry(this.log), {
      ttlKeeper: {
        chainPlans: async () => (await this.stack.api.getDemoState()).chainPlans ?? {},
        latestLedger: async () => (await server.getLatestLedger()).sequence,
        liveUntil: (id) => planLiveUntil(server as rpc.Server, cfg.chain.contractId, id),
        getStatus: (id) => this.client.getStatus(id),
        extendTtl: (id) => this.client.extendTtl(id),
      },
      adverseEventsDaily: opts.adverseEventsDaily ?? this.adverseEventsJob(),
    });
  }

  /**
   * The daily adverse-events run of the policy layer: NullPolicy decides, ChainGovernanceProvider
   * executes on chain for the plans that live there (the off-chain adverse demo plans go to the
   * mock provider), and the run's own funds-conservation check becomes a warning when it fails.
   */
  private adverseEventsJob(): JobFn {
    return async () => {
      const store = this.stack.store;
      const today = (await this.stack.api.getDemoState()).today;
      const provider = new ChainGovernanceProvider({
        client: this.client,
        chainPlans: async () => (await this.stack.api.getDemoState()).chainPlans ?? {},
        fallback: new MockGovernanceProvider({ store, today: () => today }),
      });
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

  get api(): CasaPuenteApi {
    return this.stack.api;
  }

  get contractId(): string {
    return this.cfg.chain.contractId;
  }

  async start(): Promise<void> {
    await this.checkPlans();
    this.indexer.start();
    this.jobs.start();
  }

  stop(): void {
    this.indexer.stop();
    this.jobs.stop();
    this.persistence.flush();
  }

  /** Compares every mapped chain plan with the seed; any used plan sets `needsReset`. */
  async checkPlans(): Promise<PristineCheck[]> {
    const state = await this.stack.api.getDemoState();
    this.pristine = await checkChainPlans(state.chainPlans ?? {}, (id) => this.client.getStatus(id));
    this.needsReset = this.pristine.length === 0 || this.pristine.some((p) => !p.pristine);
    for (const p of this.pristine) this.log(`startup check: ${p.planId} #${p.chainPlanId} ${p.pristine ? 'in the step-1 state' : `NOT pristine (${p.reason})`}`);
    if (this.needsReset) this.log('startup check: the seeded plans were used by an earlier run; click "Reiniciar demo" (or POST /api/reset) before presenting');
    return this.pristine;
  }

  // ---------- receipts from the indexer ----------

  private async chainMaps(): Promise<{ state: DemoState; byChain: Map<number, string> }> {
    const state = await this.stack.api.getDemoState();
    const byChain = new Map(Object.entries(state.chainPlans ?? {}).map(([planId, chainId]) => [chainId, planId] as const));
    return { state, byChain };
  }

  /** Writes a receipt for every indexed release of a current plan whose settlement is recorded. */
  async joinReceipts(): Promise<number> {
    const { byChain } = await this.chainMaps();
    const settlements = await this.stack.store.all('receipts');
    const plans = await this.stack.store.all('plans');
    const written = this.receipts.join(
      this.indexer.events.all(),
      new Set(byChain.keys()),
      (chainId, idx) => {
        const planId = byChain.get(chainId);
        return settlements.find((r) => r.planId === planId && r.installmentIdx === idx);
      },
      (chainId, idx) => {
        const plan = plans.find((p) => p.id === byChain.get(chainId));
        return plan ? this.offRamp?.latest(plan.encargoRef, `M${idx + 1}`)?.txId : undefined;
      },
    );
    return written.length;
  }

  async getReceipts(planId: string): Promise<Receipt[]> {
    await this.joinReceipts();
    const { state } = await this.chainMaps();
    const chainId = state.chainPlans?.[planId];
    return chainId == null ? [] : this.receipts.forPlan(this.contractId, chainId);
  }

  /** Waits until the indexer holds the release transaction of `receipt`, then returns the indexed receipt. */
  private async indexed(planId: string, receipt: Receipt): Promise<Receipt> {
    const { state } = await this.chainMaps();
    const chainId = state.chainPlans?.[planId];
    if (chainId == null) return receipt;
    const deadline = Date.now() + this.cfg.receiptWaitMs;
    for (;;) {
      await this.indexer.pollOnce();
      await this.joinReceipts();
      const r = this.receipts.find(this.contractId, chainId, receipt.installmentIdx);
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

  async reset(): Promise<{ state: DemoState; elapsedMs: number }> {
    const r = await this.stack.api.reset();
    this.needsReset = false;
    this.pristine = Object.entries(r.state.chainPlans ?? {}).map(([planId, chainPlanId]) => ({ planId, chainPlanId, pristine: true, reason: '' }));
    this.log(`reset: plans re-seeded in ${(r.elapsedMs / 1000).toFixed(1)} s → ${JSON.stringify(r.state.chainPlans)}`);
    return r;
  }

  health(): Record<string, unknown> {
    return {
      status: 'ok',
      mode: 'testnet',
      contractId: this.contractId,
      startedAt: this.startedAt,
      needsReset: this.needsReset,
      plans: this.pristine,
      indexer: this.indexer.stats(),
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
