// Job registry (register, manual trigger, no overlapping runs, failures recorded, the schedule) and
// the TTL keeper over fakes: extends plans with installments left, skips finished ones, warns
// under 30 days and when a plan entry is missing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADVERSE_EVENTS_JOB, JobRegistry, TTL_KEEPER_JOB, ledgersToDays, planKeyScVal, registerDefaultJobs, runTtlKeeper, type TtlKeeperDeps } from './index';
import type { ChainPlanStatus } from '../chain/client';

afterEach(() => vi.useRealTimers());

describe('JobRegistry', () => {
  it('runs a job on a manual trigger, shares one run between overlapping triggers and keeps history', async () => {
    const reg = new JobRegistry();
    let calls = 0;
    let release!: () => void;
    reg.register('j', 'daily', async () => {
      calls += 1;
      await new Promise<void>((r) => (release = r));
      return { summary: 'done', warnings: ['w1'] };
    });
    const a = reg.run('j');
    const b = reg.run('j');
    await Promise.resolve();
    expect(reg.status()[0]!.running).toBe(true);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra).toBe(rb);
    expect(ra).toMatchObject({ ok: true, summary: 'done', warnings: ['w1'], trigger: 'manual' });
    expect(reg.history('j')).toHaveLength(1);
  });

  it('records a failing job without throwing, rejects unknown names and duplicate registrations', async () => {
    const reg = new JobRegistry();
    reg.register('bad', { everyMs: 1000 }, async () => {
      throw new Error('boom');
    });
    expect(await reg.run('bad')).toMatchObject({ ok: false, error: 'boom' });
    await expect(reg.run('nope')).rejects.toThrow(/unknown job nope/);
    expect(() => reg.register('bad', 'daily', async () => ({ summary: '' }))).toThrow(/already registered/);
  });

  it('fires scheduled runs once per period after start', async () => {
    vi.useFakeTimers();
    const reg = new JobRegistry();
    const seen: string[] = [];
    reg.register('tick', { everyMs: 1000 }, async (ctx) => {
      seen.push(ctx.trigger);
      return { summary: 'ok' };
    });
    reg.start();
    await vi.advanceTimersByTimeAsync(3500);
    reg.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toEqual(['schedule', 'schedule', 'schedule']);
  });

  it('registers the TTL keeper, and the adverse-events job only when its function is supplied', () => {
    const deps = {} as TtlKeeperDeps;
    expect(registerDefaultJobs(new JobRegistry(), { ttlKeeper: deps }).names()).toEqual([TTL_KEEPER_JOB]);
    const both = registerDefaultJobs(new JobRegistry(), { ttlKeeper: deps, adverseEventsDaily: async () => ({ summary: 'x' }) });
    expect(both.names()).toEqual([TTL_KEEPER_JOB, ADVERSE_EVENTS_JOB]);
  });
});

describe('TTL keeper', () => {
  const DAY = 86_400 / 5; // ledgers per day
  const status = (statuses: string[], state = 'active') =>
    ({ plan: {}, installments: statuses.map((s, idx) => ({ idx, status: s })), governance: { state } }) as unknown as ChainPlanStatus;

  function deps(over: Partial<TtlKeeperDeps> = {}) {
    const live: Record<number, number | null> = { 1: 1000 + 100 * DAY, 2: 1000 + 10 * DAY, 3: 1000 + 50 * DAY, 4: null };
    const extended: number[] = [];
    const d: TtlKeeperDeps = {
      chainPlans: async () => ({ 'plan-a': 1, 'plan-b': 2, 'plan-done': 3, 'plan-gone': 4 }),
      latestLedger: async () => 1000,
      liveUntil: async (id) => live[id] ?? null,
      getStatus: async (id) => {
        if (id === 4) throw new Error('PlanNotFound');
        return id === 3 ? status(['released', 'waived']) : status(['released', 'open', 'locked']);
      },
      extendTtl: async (id) => {
        extended.push(id);
        live[id] = 1000 + 120 * DAY;
        return { txHash: `ttl-${id}` };
      },
      ...over,
    };
    return { d, extended };
  }

  it('extends plans with installments left, skips finished ones and warns under 30 days or when missing', async () => {
    const { d, extended } = deps();
    const r = await runTtlKeeper(d);
    expect(extended).toEqual([1, 2]);
    expect(r.summary).toBe('2/4 plan(s) extended, shortest TTL now 50 days');
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings![0]).toMatch(/plan-b \(#2\): only 10 days of TTL left/);
    expect(r.warnings![1]).toMatch(/plan-gone \(#4\): plan entry not found/);
    const reports = r.details as { planId: string; daysBefore: number | null; daysAfter: number | null; extended: boolean; note: string }[];
    expect(reports.find((x) => x.planId === 'plan-b')).toMatchObject({ daysBefore: 10, daysAfter: 120, extended: true });
    expect(reports.find((x) => x.planId === 'plan-done')).toMatchObject({ extended: false, note: 'nothing left to pay' });
  });

  it('does not extend cancelled or completed plans', async () => {
    const { d, extended } = deps({ chainPlans: async () => ({ x: 1 }), getStatus: async () => status(['open'], 'cancelled') });
    await runTtlKeeper(d);
    expect(extended).toEqual([]);
  });

  it('plan key and ledger arithmetic', () => {
    expect(ledgersToDays(17_280)).toBe(1);
    const key = planKeyScVal(7);
    expect(key.type).toBe('scvVec');
  });
});
